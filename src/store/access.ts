/**
 * Tillgång till indexet för verktygen (SPEC 5, 8): är det inkopplat och laddat,
 * hur färskt är det, och kort avstängning efter fel så att varje förfrågan inte
 * först väntar på ett D1 som inte svarar.
 *
 * Läget cachas per isolat: ett lyckat svar i STATUS_TTL_MS, ett fel eller ett
 * tomt index i FAIL_TTL_MS. Ett fel i en indexfråga (reportFailure) stänger av
 * indexet i FAIL_TTL_MS; därefter prövas det igen.
 */
import type { KvLike } from "../cache/kv";
import { kvCached } from "../cache/kv";
import { IndexError } from "./d1";
import type { IndexStatus, IndexStore } from "./index";

export const STATUS_TTL_MS = 60_000;
export const FAIL_TTL_MS = 15_000;
/** Egenskapslistan: en timme i minnet, ett dygn i KV. */
export const EGENSKAPER_TTL_MS = 60 * 60 * 1000;
export const EGENSKAPER_KV_TTL_S = 24 * 60 * 60;
export const EGENSKAPER_KEY = "egenskaper:v1";

export type IndexOpen =
	| { ok: true; store: IndexStore; status: IndexStatus; hamtad_fran: string }
	| { ok: false; orsak: string };

export interface EgenskapRad {
	typ: string;
	varde: string;
	antal: number;
}

/** Datumdelen (ÅÅÅÅ-MM-DD) av ett ISO-datum eller en ISO-tid, annars null. */
function datum(s: string | null): string | null {
	const m = s ? /^(\d{4}-\d{2}-\d{2})/.exec(s) : null;
	return m ? m[1] : null;
}

/**
 * Hur färskt indexet är, som text till `hamtad_fran` (SPEC 7): "index
 * ÅÅÅÅ-MM-DD" med det senaste av uttagsdatum och senaste nattsynk.
 */
export function indexHamtadFran(s: IndexStatus): string {
	const uttag = datum(s.uttagsdatum);
	const synk = datum(s.senast_synkat);
	const d = [uttag, synk].filter((x): x is string => !!x).sort().pop();
	if (!d) return "index (datum okänt)";
	return synk && synk === d && synk !== uttag ? `index ${d} (nattsynk; uttag ${uttag ?? "okänt"})` : `index ${d}`;
}

/** Text till `hamtad_fran` i reservläget. */
export function reservHamtadFran(kalla: string, orsak: string, byggdatum?: string | null): string {
	return `${kalla} (reservläge: ${orsak})${byggdatum ? `, data byggd ${byggdatum}` : ""}`;
}

export class IndexAccess {
	private cached: { value: IndexOpen; at: number } | null = null;
	private inflight: Promise<IndexOpen> | null = null;
	private egenskapCache: { value: EgenskapRad[]; at: number } | null = null;

	constructor(
		readonly store: IndexStore,
		private readonly options: { kv?: KvLike; now?: () => number; statusTtlMs?: number; failTtlMs?: number } = {},
	) {}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	/** Läget, cachat. Kastar aldrig: fel ger `{ ok: false, orsak }`. */
	async open(): Promise<IndexOpen> {
		const t = this.now();
		if (this.cached) {
			const ttl = this.cached.value.ok ? (this.options.statusTtlMs ?? STATUS_TTL_MS) : (this.options.failTtlMs ?? FAIL_TTL_MS);
			if (t - this.cached.at < ttl && t >= this.cached.at) return this.cached.value;
		}
		if (this.inflight) return this.inflight;
		const p = this.load().then((value) => {
			this.cached = { value, at: this.now() };
			return value;
		});
		this.inflight = p;
		try {
			return await p;
		} finally {
			if (this.inflight === p) this.inflight = null;
		}
	}

	private async load(): Promise<IndexOpen> {
		try {
			const status = await this.store.status();
			if (!status.laddad) return { ok: false, orsak: "indexet är tomt (inte laddat)" };
			return { ok: true, store: this.store, status, hamtad_fran: indexHamtadFran(status) };
		} catch (err) {
			console.error("index: lägeskontrollen misslyckades:", err instanceof Error ? err.message : String(err));
			return { ok: false, orsak: "indexet svarade inte" };
		}
	}

	/** En indexfråga misslyckades: använd reservkällorna en stund. */
	reportFailure(err: unknown): void {
		console.error("index: frågan misslyckades, reservläge en stund:", err instanceof Error ? err.message : String(err));
		this.cached = { value: { ok: false, orsak: "indexanropet misslyckades" }, at: this.now() };
	}

	/**
	 * Egenskapstyper och värden med antal lämningar. Kräver en hel genomläsning
	 * av egenskapstabellen, därför cachat (minne 1 h, KV 24 h).
	 */
	async egenskaper(): Promise<EgenskapRad[]> {
		const t = this.now();
		if (this.egenskapCache && t - this.egenskapCache.at < EGENSKAPER_TTL_MS && t >= this.egenskapCache.at) return this.egenskapCache.value;
		const value = await kvCached(this.options.kv, EGENSKAPER_KEY, EGENSKAPER_KV_TTL_S, () => this.store.egenskaper(), isEgenskaper);
		if (!isEgenskaper(value)) throw new IndexError("Egenskapslistan i indexet är tom.");
		this.egenskapCache = { value, at: t };
		return value;
	}
}

function isEgenskaper(v: unknown): v is EgenskapRad[] {
	return (
		Array.isArray(v) &&
		v.length > 0 &&
		v.every((x) => x && typeof x.typ === "string" && typeof x.varde === "string" && typeof x.antal === "number")
	);
}
