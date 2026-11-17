/**
 * Den enda vägen ut mot uppströmskällorna.
 *
 * - Varje anrop (och varje omdirigering) prövas mot listan över tillåtna anrop.
 * - Tidsgräns 10 s per försök.
 * - Ett omförsök vid 5xx, 429, tidsgräns eller nätverksfel.
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
}

export interface UpstreamClientOptions {
	fetch?: FetchLike;
	timeoutMs?: number;
	maxConcurrent?: number;
	/** Väntetid före omförsök (ms). */
	retryDelayMs?: number;
	/** Största tillåtna svar i byte. */
	maxBodyBytes?: number;
	/** User-Agent (se `userAgent()` i config.ts). */
	userAgent?: string;
}

/** Enkel semafor: högst `max` samtidiga. */
export class Semaphore {
	private active = 0;
	private readonly queue: Array<() => void> = [];
	constructor(private readonly max: number) {}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.max) {
			// Platsen lämnas över direkt av den som släpper (active räknas inte ned),
			// så att ingen ny anropare hinner emellan.
			await new Promise<void>((resolve) => this.queue.push(resolve));
		} else {
			this.active++;
		}
		try {
			return await fn();
		} finally {
			const next = this.queue.shift();
			if (next) next();
			else this.active--;
		}
	}

	get inFlight(): number {
		return this.active;
	}
}

const MAX_REDIRECTS = 2;

export class UpstreamClient {
	private readonly fetchImpl: FetchLike;
	private readonly timeoutMs: number;
	private readonly retryDelayMs: number;
	private readonly maxBodyBytes: number;
	private readonly semaphores = new Map<SourceId, Semaphore>();
	private readonly maxConcurrent: number;
	private readonly userAgent: string;

	constructor(options: UpstreamClientOptions = {}) {
		this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
		this.timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
		this.retryDelayMs = options.retryDelayMs ?? 300;
		this.maxBodyBytes = options.maxBodyBytes ?? 20 * 1024 * 1024;
		this.maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_PER_SOURCE;
		this.userAgent = options.userAgent ?? USER_AGENT;
	}

	private semaphore(source: SourceId): Semaphore {
		let s = this.semaphores.get(source);
		if (!s) {
			s = new Semaphore(this.maxConcurrent);
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
		const call = checkAllowed("GET", url);
		const source = call.source;
		return this.semaphore(source).run(async () => {
			let lastError: unknown;
			for (let attempt = 0; attempt < 2; attempt++) {
				if (attempt > 0) await sleep(this.retryDelayMs);
				try {
					const res = await this.fetchFollowingAllowedRedirects(String(url), accept);
					if ((res.status >= 500 || res.status === 429) && attempt === 0) {
						lastError = new UpstreamError(source, `${SOURCE_NAMES[source]} svarade ${res.status}`, res.status);
						if (res.status === 429) await sleep(retryAfterMs(res.headers.get("retry-after")));
						continue;
					}
					const body = await this.readBody(res, source);
					return {
						status: res.status,
						contentType: res.headers.get("content-type") ?? "",
						body,
						url: res.url || String(url),
					};
				} catch (err) {
					// Otillåtna anrop och för stora svar prövas inte igen.
					if (err instanceof DisallowedCallError || err instanceof UpstreamError) throw err;
					lastError = err;
				}
			}
			if (lastError instanceof UpstreamError) throw lastError;
			const msg = isTimeout(lastError)
				? `${SOURCE_NAMES[source]} svarade inte inom ${Math.round(this.timeoutMs / 1000)} s`
				: `${SOURCE_NAMES[source]} gick inte att nå (${errorMessage(lastError)})`;
			throw new UpstreamError(source, msg);
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

	private async readBody(res: Response, source: SourceId): Promise<string> {
		const len = Number(res.headers.get("content-length") ?? "0");
		if (len > this.maxBodyBytes) {
			await res.body?.cancel();
			throw new UpstreamError(source, `${SOURCE_NAMES[source]}: svaret är för stort (${len} byte)`);
		}
		const text = await res.text();
		if (text.length > this.maxBodyBytes) {
			throw new UpstreamError(source, `${SOURCE_NAMES[source]}: svaret är för stort`);
		}
		return text;
	}
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
