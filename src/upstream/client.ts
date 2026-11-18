/**
 * Den enda vägen ut mot uppströmskällorna.
 *
 * - Varje anrop (och varje omdirigering) prövas mot listan över tillåtna anrop.
 * - Tidsgräns 10 s per försök.
 * - Ett omförsök vid 5xx, 429, tidsgräns eller nätverksfel (`retries: 0` stänger
 *   av omförsöket, t.ex. för Nominatim, vars villkor inte tillåter tätare anrop).
 * - Högst 4 samtidiga anrop per källa.
 * - Identifierande User-Agent.
 */
import { MAX_CONCURRENT_PER_SOURCE, UPSTREAM_TIMEOUT_MS, USER_AGENT } from "../config";
import { DisallowedCallError, SOURCE_NAMES, type SourceId, UpstreamError } from "../errors";
import { checkAllowed } from "./allowlist";

export type FetchLike = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

export interface UpstreamResponse {
	status: number;
	contentType: string;
	body: string;
	url: string;
	/** Rubriken `Retry-After`, om den finns (används för Nominatims spärr). */
	retryAfter?: string | null;
}

export interface UpstreamBinaryResponse {
	status: number;
	contentType: string;
	/** `Content-Length` enligt svaret, om angiven. */
	contentLength: number | null;
	/** Innehållet, eller null om status ≥ 400 eller svaret var för stort. */
	bytes: Uint8Array | null;
	tooLarge: boolean;
	url: string;
}

export interface UpstreamClientOptions {
	fetch?: FetchLike;
	timeoutMs?: number;
	maxConcurrent?: number;
	/** Väntetid före omförsök (ms). */
	retryDelayMs?: number;
	/** Antal omförsök (0 eller 1; standard 1). */
	retries?: number;
	/** Största tillåtna svar i byte. */
	maxBodyBytes?: number;
	/** User-Agent (se `userAgent()` i config.ts). */
	userAgent?: string;
}

/** Väntan på en plats i semaforen tog för lång tid. */
export class SemaphoreTimeoutError extends Error {
	constructor() {
		super("semaphore wait timeout");
		this.name = "SemaphoreTimeoutError";
	}
}

export interface SemaphoreOptions {
	/** En plats som hållits längre än så räknas som övergiven och återtas. */
	maxHoldMs?: number;
	/** Längsta väntan på en plats. */
	maxWaitMs?: number;
	/** Hur ofta en väntande försöker igen. */
	pollMs?: number;
	now?: () => number;
}

/**
 * Semafor: högst `max` samtidiga. Delas mellan förfrågningar i ett isolat,
 * därför utan överlämning mellan anropare: i Workers kan en förfrågan avbrytas
 * mitt i, och ett löfte som en annan förfrågan väntar på ska aldrig behöva
 * lösas från den avbrutnas sammanhang. En väntande provar i stället själv
 * igen med korta pauser (egna timers), och en plats som hållits orimligt länge
 * (förfrågan avbröts innan `finally` hann köras) återtas.
 */
export class Semaphore {
	private readonly leases = new Map<number, number>();
	private nextId = 1;
	private readonly maxHoldMs: number;
	private readonly maxWaitMs: number;
	private readonly pollMs: number;
	private readonly now: () => number;

	constructor(
		private readonly max: number,
		options: SemaphoreOptions = {},
	) {
		this.maxHoldMs = options.maxHoldMs ?? 60_000;
		this.maxWaitMs = options.maxWaitMs ?? 30_000;
		this.pollMs = options.pollMs ?? 10;
		this.now = options.now ?? Date.now;
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		const id = await this.acquire();
		try {
			return await fn();
		} finally {
			this.leases.delete(id);
		}
	}

	private tryAcquire(): number | null {
		const t = this.now();
		for (const [id, at] of this.leases) if (t - at > this.maxHoldMs || t < at) this.leases.delete(id);
		if (this.leases.size >= this.max) return null;
		const id = this.nextId++;
		this.leases.set(id, t);
		return id;
	}

	private async acquire(): Promise<number> {
		const start = this.now();
		for (;;) {
			const id = this.tryAcquire();
			if (id !== null) return id;
			if (this.now() - start >= this.maxWaitMs) throw new SemaphoreTimeoutError();
			await sleep(this.pollMs);
		}
	}

	get inFlight(): number {
		return this.leases.size;
	}
}

const MAX_REDIRECTS = 2;

/**
 * Största svarskropp som läses (utom bildfiler, som har egen gräns). Källornas
 * svar är långt mindre: värdelistorna 0,3 MB, en flödessida cirka 1 MB, en
 * OGC-sida med geometrier några MB. Med fyra samtidiga anrop per källa och
 * JSON-tolkning (som ungefär fördubblar) håller 8 MB minnet långt under
 * Workers gräns på 128 MB; 20 MB kunde närma sig den.
 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class UpstreamClient {
	private readonly fetchImpl: FetchLike;
	private readonly timeoutMs: number;
	private readonly retryDelayMs: number;
	private readonly attempts: number;
	private readonly maxBodyBytes: number;
	private readonly semaphores = new Map<SourceId, Semaphore>();
	private readonly maxConcurrent: number;
	private readonly userAgent: string;

	constructor(options: UpstreamClientOptions = {}) {
		this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
		this.timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
		this.retryDelayMs = options.retryDelayMs ?? 300;
		this.attempts = 1 + Math.max(0, Math.min(1, options.retries ?? 1));
		this.maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
		this.maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_PER_SOURCE;
		this.userAgent = options.userAgent ?? USER_AGENT;
	}

	private semaphore(source: SourceId): Semaphore {
		let s = this.semaphores.get(source);
		if (!s) {
			// Ett anrop håller platsen högst två försök + paus; marginal för långsam läsning.
			s = new Semaphore(this.maxConcurrent, { maxHoldMs: this.timeoutMs * 3 + 10_000, maxWaitMs: this.timeoutMs * 2 + 5_000 });
			this.semaphores.set(source, s);
		}
		return s;
	}

	/**
	 * GET mot en tillåten adress. Returnerar svaret oavsett status (efter ev.
	 * omförsök) så att källan kan tolka egna felmeddelanden; kastar
	 * `UpstreamError` vid tidsgräns/nätverksfel och `DisallowedCallError`
	 * om anropet inte är tillåtet.
	 */
	async get(url: string | URL, accept = "application/json"): Promise<UpstreamResponse> {
		const source = checkAllowed("GET", url).source;
		return this.request(url, accept, async (res) => ({
			status: res.status,
			contentType: res.headers.get("content-type") ?? "",
			body: await this.readBody(res, source),
			url: res.url || String(url),
			retryAfter: res.headers.get("retry-after"),
		}));
	}

	/**
	 * GET av en binär fil med en hård storleksgräns. Läser aldrig mer än
	 * `maxBytes`: anges en större `Content-Length`, eller blir strömmen längre,
	 * avbryts läsningen och `tooLarge` sätts (utan innehåll). Svar med status
	 * ≥ 400 läses inte.
	 */
	async getBytes(url: string | URL, accept: string, maxBytes: number): Promise<UpstreamBinaryResponse> {
		return this.request(url, accept, async (res) => {
			const base = {
				status: res.status,
				contentType: res.headers.get("content-type") ?? "",
				contentLength: parseContentLength(res.headers.get("content-length")),
				url: res.url || String(url),
			};
			if (res.status >= 400) {
				await res.body?.cancel();
				return { ...base, bytes: null, tooLarge: false };
			}
			if (base.contentLength !== null && base.contentLength > maxBytes) {
				await res.body?.cancel();
				return { ...base, bytes: null, tooLarge: true };
			}
			const bytes = await readLimited(res, maxBytes);
			return bytes ? { ...base, bytes, tooLarge: false } : { ...base, bytes: null, tooLarge: true };
		});
	}

	private async runLimited<T>(source: SourceId, fn: () => Promise<T>): Promise<T> {
		try {
			return await this.semaphore(source).run(fn);
		} catch (err) {
			if (err instanceof SemaphoreTimeoutError) throw new UpstreamError(source, `${SOURCE_NAMES[source]}: för många samtidiga anrop, försök igen`, undefined, "upptaget");
			throw err;
		}
	}

	/** Gemensam väg: lista, semafor, omdirigeringar, tidsgräns och ett omförsök. */
	private async request<T>(url: string | URL, accept: string, read: (res: Response) => Promise<T>): Promise<T> {
		const call = checkAllowed("GET", url);
		const source = call.source;
		return this.runLimited(source, async () => {
			let lastError: unknown;
			for (let attempt = 0; attempt < this.attempts; attempt++) {
				if (attempt > 0) await sleep(this.retryDelayMs);
				try {
					const res = await this.fetchFollowingAllowedRedirects(String(url), accept);
					if ((res.status >= 500 || res.status === 429) && attempt < this.attempts - 1) {
						lastError = new UpstreamError(source, `${SOURCE_NAMES[source]} svarade ${res.status}`, res.status);
						await res.body?.cancel();
						if (res.status === 429) await sleep(retryAfterMs(res.headers.get("retry-after")));
						continue;
					}
					return await read(res);
				} catch (err) {
					// Otillåtna anrop och för stora svar prövas inte igen.
					if (err instanceof DisallowedCallError || err instanceof UpstreamError) throw err;
					lastError = err;
				}
			}
			if (lastError instanceof UpstreamError) throw lastError;
			if (!isTimeout(lastError)) console.warn(`upstream: ${call.id} gick inte att nå:`, errorMessage(lastError));
			const msg = isTimeout(lastError)
				? `${SOURCE_NAMES[source]} svarade inte inom ${Math.round(this.timeoutMs / 1000)} s`
				: `${SOURCE_NAMES[source]} gick inte att nå`;
			throw new UpstreamError(source, msg, undefined, isTimeout(lastError) ? "tidsgrans" : "natverk");
		});
	}

	/** GET + JSON-tolkning. Kastar `UpstreamError` vid ogiltig JSON. */
	async getJson<T = unknown>(url: string | URL, accept = "application/json"): Promise<{ status: number; data: T; raw: UpstreamResponse }> {
		const raw = await this.get(url, accept);
		try {
			return { status: raw.status, data: JSON.parse(raw.body) as T, raw };
		} catch {
			const source = checkAllowed("GET", url).source;
			throw new UpstreamError(source, `${SOURCE_NAMES[source]} svarade inte med JSON (status ${raw.status})`, raw.status);
		}
	}

	private async fetchFollowingAllowedRedirects(url: string, accept: string): Promise<Response> {
		let current = url;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			checkAllowed("GET", current);
			const res = await this.fetchImpl(current, {
				method: "GET",
				headers: { "User-Agent": this.userAgent, Accept: accept },
				redirect: "manual",
				signal: AbortSignal.timeout(this.timeoutMs),
			});
			if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
				// Omdirigeringar följs bara om målet också står på listan.
				current = new URL(res.headers.get("location") as string, current).href;
				await res.body?.cancel();
				continue;
			}
			return res;
		}
		throw new DisallowedCallError(`För många omdirigeringar från ${url}`);
	}

	/** Läser texten strömmande och avbryter vid storleksgränsen (även utan Content-Length). */
	private async readBody(res: Response, source: SourceId): Promise<string> {
		const len = parseContentLength(res.headers.get("content-length"));
		if (len !== null && len > this.maxBodyBytes) {
			await res.body?.cancel();
			throw new UpstreamError(source, `${SOURCE_NAMES[source]}: svaret är för stort (${len} byte)`, undefined, "for_stort");
		}
		const bytes = await readLimited(res, this.maxBodyBytes);
		if (!bytes) throw new UpstreamError(source, `${SOURCE_NAMES[source]}: svaret är för stort`, undefined, "for_stort");
		return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
	}
}

function parseContentLength(h: string | null): number | null {
	if (h === null || !/^\d{1,15}$/.test(h.trim())) return null;
	return Number(h.trim());
}

/** Läs högst `max` byte; null om strömmen är längre. */
async function readLimited(res: Response, max: number): Promise<Uint8Array | null> {
	if (!res.body) return new Uint8Array(0);
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

function sleep(ms: number): Promise<void> {
	return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

function retryAfterMs(header: string | null): number {
	const s = Number(header);
	if (Number.isFinite(s) && s > 0) return Math.min(s * 1000, 2000);
	return 500;
}

function isTimeout(err: unknown): boolean {
	return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
