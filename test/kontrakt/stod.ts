/**
 * Gemensamt stöd för kontrakttesterna (SPEC 10: "Kontrakt – nattlig kontroll mot
 * riktiga källor"). Filerna `*.kontrakt.ts` körs inte av den vanliga sviten; de
 * körs med `npx vitest run --config vitest.kontrakt.config.mts`.
 *
 * Två slags fel hålls strikt isär, eftersom de betyder olika saker:
 *
 *   [OTILLGÄNGLIG]  Tjänsten svarade inte (tidsgräns, nätverksfel, 5xx, 429).
 *                   Oftast tillfälligt. Säger inget om svarsformatet.
 *   [FORMAT]        Tjänsten svarade, men svaret avviker från det koden
 *                   förutsätter (fält saknas, fel typ, ändpunkten finns inte
 *                   längre, HTML i stället för JSON). Det verkliga larmet.
 *
 * Varje felrad har formen `[KLASS] källa | anrop | fält: avvikelse` så att
 * sammanfattningen (sammanfatta.mjs) kan läsa den.
 *
 * Hövlighet mot RAÄ: alla anrop går genom en enda kö med paus mellan anropen,
 * projektets egen User-Agent och ett hårt tak på antalet anrop per körning.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DisallowedCallError, SOURCE_NAMES, type SourceId, UpstreamError } from "../../src/errors";
import { type UpstreamResponse, UpstreamClient } from "../../src/upstream/client";
import { USER_AGENT } from "../../src/config";

/** Högst så många anrop per körning, alla källor och alla testfiler sammanlagt. */
export const MAX_ANROP = 32;
/** Paus mellan två anrop (ms). */
export const PAUS_MS = 600;

export type Klass = "FORMAT" | "OTILLGÄNGLIG";

export class KontraktFel extends Error {
	constructor(
		readonly klass: Klass,
		message: string,
	) {
		super(message);
		this.name = "KontraktFel";
	}
}

/** Anropslogg som delas mellan testfilerna (en rad JSON per anrop). */
export function loggSokvag(): string {
	return process.env.KONTRAKT_LOGG || join(tmpdir(), "fornsok-kontrakt-anrop.jsonl");
}

export function raknaAnrop(): number {
	const p = loggSokvag();
	if (!existsSync(p)) return 0;
	return readFileSync(p, "utf8").split("\n").filter(Boolean).length;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// Alla anrop går en i taget genom den här kön (även om testerna skulle köras parallellt).
let kon: Promise<unknown> = Promise.resolve();
let senaste = 0;

/**
 * `fetch` med kö, paus, anropstak och logg. Bildfiler hämtas med `Range` så att
 * bara de första byten behöver föras över (servern får gärna strunta i det;
 * klientens storleksgräns stoppar då läsningen).
 */
export const artigFetch: typeof fetch = (input, init) => {
	const run = async () => {
		const gjorda = raknaAnrop();
		if (gjorda >= MAX_ANROP) {
			throw new Error(`Kontrakttesterna har nått taket på ${MAX_ANROP} anrop per körning (SPEC 9.1); fler anrop görs inte.`);
		}
		const vänta = senaste + PAUS_MS - Date.now();
		if (vänta > 0) await sleep(vänta);
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const headers = new Headers(init?.headers);
		if (/\/lamning\/dokument\/fil\//.test(url)) headers.set("Range", "bytes=0-63");
		const t0 = Date.now();
		let status: number | string = "fel";
		try {
			const res = await fetch(input, { ...init, headers });
			status = res.status;
			return res;
		} finally {
			senaste = Date.now();
			appendFileSync(loggSokvag(), `${JSON.stringify({ metod: init?.method ?? "GET", url, status, ms: senaste - t0 })}\n`);
		}
	};
	const next = kon.then(run, run);
	kon = next.catch(() => undefined);
	return next;
};

/** Uppströmsklient som i servern (samma lista över tillåtna anrop, samma User-Agent), men artig. */
export function skapaKlient(): UpstreamClient {
	return new UpstreamClient({ fetch: artigFetch, userAgent: USER_AGENT, retryDelayMs: 1500 });
}

// ------------------------------------------------------------------ anrop

/** Status som betyder "tjänsten mår dåligt", inte "formatet ändrades". */
function arOtillganglig(status: number): boolean {
	return status >= 500 || status === 429 || status === 408;
}

export function otillganglig(kalla: SourceId, anrop: string, orsak: string): KontraktFel {
	return new KontraktFel("OTILLGÄNGLIG", `[OTILLGÄNGLIG] ${SOURCE_NAMES[kalla]} | ${anrop} | tjänsten svarar inte: ${orsak}`);
}

export function formatFel(kalla: SourceId, anrop: string, falt: string, avvikelse: string): KontraktFel {
	return new KontraktFel("FORMAT", `[FORMAT] ${SOURCE_NAMES[kalla]} | ${anrop} | ${falt}: ${avvikelse}`);
}

/**
 * Kör ett anrop genom klienten och sortera felen: nätverksfel och 5xx/429 blir
 * `OTILLGÄNGLIG`; 4xx och förbjudna anrop blir `FORMAT`. Returnerar svaret när
 * statusen är den förväntade (standard 200).
 */
export async function hamta(
	kalla: SourceId,
	anrop: string,
	fn: () => Promise<UpstreamResponse>,
	forvantadStatus = 200,
): Promise<UpstreamResponse> {
	let res: UpstreamResponse;
	try {
		res = await fn();
	} catch (e) {
		throw klassa(kalla, anrop, e);
	}
	kontrolleraStatus(kalla, anrop, res.status, forvantadStatus, res.body);
	return res;
}

export function klassa(kalla: SourceId, anrop: string, e: unknown): Error {
	if (e instanceof KontraktFel) return e;
	if (e instanceof UpstreamError) {
		if (/för stort/.test(e.message)) return formatFel(kalla, anrop, "svarsstorlek", e.message);
		if (e.status !== undefined && !arOtillganglig(e.status)) {
			return formatFel(kalla, anrop, "svar", e.message);
		}
		return otillganglig(kalla, anrop, e.message);
	}
	if (e instanceof DisallowedCallError) {
		return formatFel(kalla, anrop, "lista över tillåtna anrop", `anropet nekas av projektets egen lista: ${e.message}`);
	}
	if (e instanceof Error && /taket på \d+ anrop/.test(e.message)) return e;
	// Okänt fel i själva anropet (DNS, TLS, avbrott): behandla som otillgänglighet.
	return otillganglig(kalla, anrop, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
}

export function kontrolleraStatus(kalla: SourceId, anrop: string, status: number, forvantad: number | number[], body?: string): void {
	const ok = Array.isArray(forvantad) ? forvantad : [forvantad];
	if (ok.includes(status)) return;
	if (arOtillganglig(status)) throw otillganglig(kalla, anrop, `HTTP ${status}`);
	const utdrag = body ? ` (svar: ${body.replace(/\s+/g, " ").slice(0, 160)})` : "";
	throw formatFel(kalla, anrop, "HTTP-status", `väntade ${ok.join(" eller ")}, fick ${status}; ändpunkten kan ha flyttats eller tagits bort${utdrag}`);
}

/** JSON-tolka ett svar. HTML eller annat blir ett formatfel, inte ett undantag från JSON.parse. */
export function jsonSvar(kalla: SourceId, anrop: string, res: UpstreamResponse): unknown {
	try {
		return JSON.parse(res.body);
	} catch {
		const bb = res.body.trimStart().slice(0, 80).replace(/\s+/g, " ");
		throw formatFel(kalla, anrop, "svarskropp", `väntade JSON (content-type ${res.contentType || "saknas"}), fick: ${bb}`);
	}
}

// ------------------------------------------------------------------ kontroller av fält

type Typ = "string" | "nonEmptyString" | "number" | "boolean" | "array" | "object" | "uuid" | "nullableString" | "nullableNumber";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function beskriv(v: unknown): string {
	if (v === undefined) return "inget värde (fältet saknas)";
	if (v === null) return "null";
	if (Array.isArray(v)) return `lista med ${v.length} element`;
	if (typeof v === "string") return `text ${JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v)}`;
	if (typeof v === "object") return "objekt";
	return `${typeof v} ${String(v)}`;
}

/** Hämta ett värde ur ett objekt med punktad sökväg; `[0]` väljer första elementet i en lista. */
export function sokvag(obj: unknown, path: string): unknown {
	let cur: unknown = obj;
	for (const part of path.split(".")) {
		if (cur === null || cur === undefined) return undefined;
		const m = /^([^[\]]*)\[(\d+)\]$/.exec(part);
		const key = m ? m[1] : part;
		if (key) {
			if (typeof cur !== "object" || Array.isArray(cur)) return undefined;
			cur = (cur as Record<string, unknown>)[key];
		}
		if (m) {
			if (!Array.isArray(cur)) return undefined;
			cur = cur[Number(m[2])];
		}
	}
	return cur;
}

/**
 * Samlar alla avvikelser i ett svar och kastar dem tillsammans, så att ett fel
 * i larmet visar samtliga fält som avviker och inte bara det första.
 */
export class Kontroll {
	private readonly avvikelser: Array<{ falt: string; text: string }> = [];
	constructor(
		private readonly kalla: SourceId,
		private readonly anrop: string,
	) {}

	/** Kontrollera typen på ett fält. `nullable*` tillåter null men kräver att fältet finns. */
	typ(obj: unknown, path: string, typ: Typ): this {
		const v = sokvag(obj, path);
		const ok =
			typ === "string"
				? typeof v === "string"
				: typ === "nonEmptyString"
					? typeof v === "string" && v.trim().length > 0
					: typ === "number"
						? typeof v === "number" && Number.isFinite(v)
						: typ === "boolean"
							? typeof v === "boolean"
							: typ === "array"
								? Array.isArray(v)
								: typ === "object"
									? v !== null && typeof v === "object" && !Array.isArray(v)
									: typ === "uuid"
										? typeof v === "string" && UUID_RE.test(v)
										: typ === "nullableString"
											? typeof v === "string" || v === null
											: typeof v === "number" || v === null;
		if (!ok) this.avvikelser.push({ falt: path, text: `väntade ${TYP_TEXT[typ]}, fick ${beskriv(v)}` });
		return this;
	}

	/** Fältet ska finnas som nyckel (värdet får vara null). */
	finns(obj: unknown, path: string): this {
		if (sokvag(obj, path) === undefined) this.avvikelser.push({ falt: path, text: "fältet saknas" });
		return this;
	}

	lika(obj: unknown, path: string, forvantat: unknown): this {
		const v = sokvag(obj, path);
		if (v !== forvantat) this.avvikelser.push({ falt: path, text: `väntade ${JSON.stringify(forvantat)}, fick ${beskriv(v)}` });
		return this;
	}

	/** Villkor som inte är en ren typkontroll. */
	krav(villkor: boolean, falt: string, text: string): this {
		if (!villkor) this.avvikelser.push({ falt, text });
		return this;
	}

	get antal(): number {
		return this.avvikelser.length;
	}

	/** Kasta ett samlat `FORMAT`-fel om något avvek. */
	klar(): void {
		if (this.avvikelser.length === 0) return;
		const rader = this.avvikelser.map((a) => `[FORMAT] ${SOURCE_NAMES[this.kalla]} | ${this.anrop} | ${a.falt}: ${a.text}`);
		throw new KontraktFel("FORMAT", rader.join("\n"));
	}
}

const TYP_TEXT: Record<Typ, string> = {
	string: "text",
	nonEmptyString: "icke-tom text",
	number: "tal",
	boolean: "sant/falskt",
	array: "lista",
	object: "objekt",
	uuid: "UUID",
	nullableString: "text eller null",
	nullableNumber: "tal eller null",
};

/** Kör `fn` och gör om undantag från projektets tolkare (som kastar vanliga fel) till formatfel med fältet utpekat. */
export function tolka<T>(kalla: SourceId, anrop: string, falt: string, fn: () => T): T {
	try {
		return fn();
	} catch (e) {
		if (e instanceof KontraktFel) throw e;
		throw formatFel(kalla, anrop, falt, `projektets tolkare avvisade svaret: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Beräkna en gång och dela mellan testerna i en fil (felet delas också, anropet görs inte om). */
export function en<T>(fn: () => Promise<T>): () => Promise<T> {
	let p: Promise<T> | null = null;
	return () => {
		p ??= fn();
		return p;
	};
}

/** De tre fasta testposterna (SPEC 10). Identiteter jämförs exakt, allt annat efter form. */
export const TESTPOSTER = {
	"L1946:7415": { uuid: "bfe10d94-5d11-4943-8085-4b1bfcaacf64", raa: "Stugun 114:1" },
	"L2000:8802": { uuid: "6d1cf7b6-f5bd-4066-aba6-fb1ea3ce8c75", raa: "Stora Kopparberg 172:1" },
	"L2001:646": { uuid: "adc490ba-871a-45bd-8e3d-0a27761b3b6c", raa: "Bjursås 27:1" },
} as const;
export type Testpost = keyof typeof TESTPOSTER;
export const TESTNUMMER = Object.keys(TESTPOSTER) as Testpost[];
