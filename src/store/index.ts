/**
 * Lämningsindexet i D1 (SPEC 5.2, 6): fulltextsök med filter och utdrag,
 * närhetssök med exakt avstånd till geometrin, grundpost, statistik och
 * uppslag på nummer. Implementerar källgränssnitten i src/sources/types.ts så
 * att verktygen kan byta källa utan att skrivas om.
 *
 * Alla frågor är parametriserade. FTS5-uttryck byggs i fts.ts av validerade ord.
 */
import { KALLA, publicUrl } from "../config";
import { compassDirection, type Geometry, nearestPoint, wgsToSweref } from "../geo/geometry";
import { round, type Planar } from "../geo/sweref";
import type {
	IdResolver,
	LamningPost,
	NearbyFeature,
	NearbyPage,
	NearbyQuery,
	NearbySource,
	RecordFetchResult,
	RecordSource,
	SearchHit,
	SearchPage,
	SearchSource,
	Sweref,
} from "../sources/types";
import { type D1Like, type D1LikeStatement, IndexError, IndexInputError } from "./d1";
import { buildFilter, type IndexSearchFilter, normLamningsnummer, normRaa, where } from "./filter";
import type { FtsQuery } from "./fts";
import { boxAround, checkedPlanar, spatialCondition, type SqlPart, type SwerefBox, wgsBoxToSweref } from "./spatial";

export type { IndexSearchFilter } from "./filter";
export { buildFtsQuery, tokenize } from "./fts";
export { IndexError, IndexInputError } from "./d1";
export type { D1Like } from "./d1";

export const KALLA_INDEX = "Lämningsindex (D1)";
/** Utdragets ungefärliga längd i tecken (SPEC 6: cirka 200). */
export const UTDRAG_TECKEN = 200;
/** Högst så många kandidater hämtas för exakt avståndsberäkning. */
export const MAX_KANDIDATER = 5000;
export const MAX_ANTAL = 100;
export const MAX_OFFSET = 10_000;
export const MAX_STATISTIK_RADER = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------- typer

export interface IndexHit extends SearchHit {
	url: string;
	/** Cirka 200 tecken runt träffen, med träffade ord inom «». Utan sökord: beskrivningens början. */
	utdrag: string | null;
	sweref99tm: Sweref | null;
	geometrityp: string | null;
	osakerhet_m: number | null;
	lamningsnamn: string | null;
	/** Avstånd i meter till närmaste punkt på geometrin, när `nara` angavs. */
	avstand_m?: number;
	vaderstreck?: string | null;
}

export interface IndexSearchPage extends SearchPage {
	traffar: IndexHit[];
	/** Så många träffar går att bläddra till (högst MAX_OFFSET); sidor bortom ger tom lista. */
	nabara: number;
	/** Sökorden som användes (efter uppdelning), med * för prefix. */
	sokord: string[];
	/** true om `totalt` är en undre gräns (fler kandidater än MAX_KANDIDATER med `nara`). */
	totalt_ungefar?: boolean;
}

export interface NearbyIndexQuery {
	lat?: number;
	lon?: number;
	/** Radie i meter (standard 500, högst 10 000). */
	radie_m?: number;
	/** Alternativ till punkt + radie: [minLon, minLat, maxLon, maxLat]. Avstånd räknas då från rutans mitt. */
	bbox?: [number, number, number, number];
	lamningstyp?: string[];
	antikvarisk_bedomning?: string[];
	/** Standard 25, högst 100. */
	antal?: number;
}

export interface NearbyIndexHit extends IndexHit {
	avstand_m: number;
	vaderstreck: string | null;
	/** Närmaste punkt på geometrin, i SWEREF 99 TM (meter). */
	narmaste_punkt_sweref: Planar;
	/** Geometritypen för den del av geometrin som ligger närmast (i en GeometryCollection: delens typ). */
	narmaste_typ: string;
	/** Antal delgeometrier (1 utom för GeometryCollection). */
	geometrier: number;
	/** Delgeometriernas typer. */
	geometrityper: string[];
}

export interface NearbyIndexPage {
	/** Antal lämningar inom radien (eller rutan). */
	totalt: number;
	traffar: NearbyIndexHit[];
	kalla: string;
	byggdatum: string | null;
	totalt_ungefar?: boolean;
	/** I mycket täta områden: radien inom vilken svaret garanterat är fullständigt. */
	fullstandig_inom_m?: number;
}

/** Indexets läge ur synk_status (SPEC 5.2, 7): finns data, och hur färskt är det. */
export interface IndexStatus {
	/** true om minst en lämning finns. */
	laddad: boolean;
	/** GeoPackage-filens uttagsdatum vid senaste grundladdning/avstämning (ÅÅÅÅ-MM-DD). */
	uttagsdatum: string | null;
	/** Senaste lyckade nattsynk (nyckeln `senast_synkat`, ISO-tid eller datum), om nattsynken skrivit den. */
	senast_synkat: string | null;
	senaste_grundladdning: string | null;
	senaste_avstamning: string | null;
}

/** En rangordnad träff ur searchRanked: bara UUID (och avstånd med `nara`). */
export interface RankedId {
	uuid: string;
	avstand_m?: number;
	vaderstreck?: string | null;
}

export interface RankedPage {
	totalt: number;
	ids: RankedId[];
	sokord: string[];
	totalt_ungefar?: boolean;
}

export const STATISTIK_DIMENSIONER = ["typ", "kategori", "bedomning", "lan", "kommun", "socken", "landskap"] as const;
export type StatistikDimension = (typeof STATISTIK_DIMENSIONER)[number];

export interface StatistikResult {
	gruppera_pa: StatistikDimension[];
	/** Antal lämningar som matchar filtret. */
	totalt: number;
	/**
	 * En rad per grupp. En lämning räknas i varje grupp den tillhör (flera
	 * kommuner eller socknar, eller en typ med flera kategorier). Socken anges
	 * som "Namn (Län)".
	 */
	grupper: Array<{ varden: string[]; antal: number }>;
	/** true om fler än MAX_STATISTIK_RADER grupper fanns. */
	avkortad: boolean;
	kalla: string;
	byggdatum: string | null;
	/** true om `nara` gav fler kandidater än MAX_KANDIDATER (räkningen är då en undre gräns). */
	totalt_ungefar?: boolean;
}

// ---------------------------------------------------------------- hjälp

type Row = Record<string, unknown>;

const HIT_COLUMNS =
	"l.id, l.uuid, l.lamningsnummer, l.raa_nummer, l.lamningstyp, l.bedomning, l.beskrivning, l.namn, l.lat, l.lon, l.e, l.n, l.geometrityp, l.osakerhet_m";

const str = (x: unknown): string | null => (typeof x === "string" && x.length > 0 ? x : null);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

function clampInt(x: unknown, def: number, min: number, max: number): number {
	const n = typeof x === "number" && Number.isFinite(x) ? Math.trunc(x) : def;
	return Math.min(max, Math.max(min, n));
}

/**
 * Jämför lämningsnummer numeriskt ("L2000:999" före "L2000:1000"). null sist.
 */
export function compareLamningsnummer(a: string | null, b: string | null): number {
	if (a === b) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	const pa = /^L(\d{4}):(\d+)$/.exec(a);
	const pb = /^L(\d{4}):(\d+)$/.exec(b);
	if (!pa || !pb) return a.localeCompare(b);
	return Number(pa[1]) - Number(pb[1]) || Number(pa[2]) - Number(pb[2]);
}

const RANK = "bm25(lamning_fts, 4.0, 4.0, 1.0, 2.0, 0.5)";
const SNIPPETS = [2, 3, 4].map((c, i) => `, snippet(lamning_fts, ${c}, '«', '»', ' … ', 32) AS ${["s_besk", "s_trad", "s_terr"][i]}`).join("");
/** Geometrier läses i omgångar om så många id. */
const GEOMETRI_OMGANG = 1000;
const AREA_DIMS = new Set<string>(["lan", "kommun", "socken", "landskap"]);

/** Gruppnamn för en områdesnivå; socken med län när namnet finns i flera län. */
function areaLabel(alias: string, d: string): string {
	return d === "socken" ? `${alias}.namn || CASE WHEN ${alias}.lan <> '' THEN ' (' || ${alias}.lan || ')' ELSE '' END` : `${alias}.namn`;
}

/** SQL-ordning för lämningsnummer: år, sedan löpnummer som tal (formatet är L####:n). */
const ORDER_LAMNINGSNUMMER = "substr(l.lamningsnummer, 1, 6), length(l.lamningsnummer), l.lamningsnummer, l.id";

/** Kort början av en text, avkortad vid ordgräns. */
export function lead(text: string | null, max = UTDRAG_TECKEN): string | null {
	if (!text) return null;
	const t = text.replace(/\s+/g, " ").trim();
	if (t.length <= max) return t;
	const cut = t.slice(0, max);
	const sp = cut.lastIndexOf(" ");
	return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()} …`;
}

/**
 * Utdrag: första långa textkolumn (beskrivning, tradition, terräng) med träff;
 * träff bara i typ eller namn ger beskrivningens början.
 */
function chooseUtdrag(r: Row): string | null {
	for (const k of ["s_besk", "s_trad", "s_terr"]) {
		const v = str(r[k])?.replace(/\s+/g, " ").trim();
		if (v?.includes("«")) return v;
	}
	return lead(str(r.beskrivning));
}

function sweref(r: Row): Sweref | null {
	const e = num(r.e);
	const n = num(r.n);
	return e !== null && n !== null ? { e, n } : null;
}

function parseGeometry(x: unknown): Geometry | null {
	if (typeof x !== "string" || !x) return null;
	try {
		const g = JSON.parse(x) as Geometry;
		return g && typeof g === "object" && typeof g.type === "string" ? g : null;
	} catch {
		return null;
	}
}

interface Areas {
	lan: string[];
	kommun: string[];
	socken: string[];
	landskap: string[];
}

function emptyAreas(): Areas {
	return { lan: [], kommun: [], socken: [], landskap: [] };
}

// ---------------------------------------------------------------- klassen

export class IndexStore implements SearchSource, IdResolver, RecordSource, NearbySource {
	private readonly db: D1Like;
	private byggdatumCache: { value: string | null; at: number } | null = null;
	/** Högst så många kandidater prövas med exakt avstånd (inställbart för test). */
	private readonly maxKandidater: number;

	constructor(db: D1Like, options: { maxKandidater?: number } = {}) {
		this.db = db;
		this.maxKandidater = Math.max(1, Math.trunc(options.maxKandidater ?? MAX_KANDIDATER));
	}

	private stmt(part: SqlPart | string, extra: unknown[] = []): D1LikeStatement {
		const p = typeof part === "string" ? { sql: part, params: [] } : part;
		const s = this.db.prepare(p.sql);
		const params = [...p.params, ...extra];
		return params.length ? s.bind(...params) : s;
	}

	private async all<T = Row>(part: SqlPart | string, extra: unknown[] = []): Promise<T[]> {
		try {
			const r = await this.stmt(part, extra).all<T>();
			return r.results ?? [];
		} catch (e) {
			throw new IndexError(`Indexfrågan misslyckades: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
		}
	}

	private async batch(stmts: D1LikeStatement[]): Promise<Row[][]> {
		try {
			const r = await this.db.batch<Row>(stmts);
			return r.map((x) => x.results ?? []);
		} catch (e) {
			throw new IndexError(`Indexfrågan misslyckades: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
		}
	}

	/** Datum då indexets data togs ut ur källan (GeoPackage-filens uttagsdatum). Cachas en minut. */
	async byggdatum(): Promise<string | null> {
		if (this.byggdatumCache && Date.now() - this.byggdatumCache.at < 60_000) return this.byggdatumCache.value;
		const rows = await this.all("SELECT varde FROM synk_status WHERE nyckel = 'uttagsdatum'");
		const value = str(rows[0]?.varde);
		this.byggdatumCache = { value, at: Date.now() };
		return value;
	}

	/**
	 * Indexets läge: finns lämningar (billig kontroll, läser en rad) och
	 * nycklarna i synk_status. Kastar IndexError om D1 inte svarar.
	 */
	async status(): Promise<IndexStatus> {
		const [ex, st] = await this.batch([
			this.stmt("SELECT EXISTS (SELECT 1 FROM lamning) AS laddad"),
			this.stmt("SELECT nyckel, varde FROM synk_status"),
		]);
		const kv = new Map(st.map((r) => [String(r.nyckel), str(r.varde)]));
		return {
			laddad: Number(ex[0]?.laddad) === 1,
			uttagsdatum: kv.get("uttagsdatum") ?? null,
			senast_synkat: kv.get("senast_synkat") ?? null,
			senaste_grundladdning: kv.get("senaste_grundladdning") ?? null,
			senaste_avstamning: kv.get("senaste_avstamning") ?? null,
		};
	}

	/** Antal lämningar i indexet (för hälsokontroll: 0 betyder att indexet inte är laddat). */
	async antal(): Promise<number> {
		const rows = await this.all("SELECT count(*) AS c FROM lamning");
		return num(rows[0]?.c) ?? 0;
	}

	private async areasFor(ids: number[]): Promise<Map<number, Areas>> {
		const out = new Map<number, Areas>();
		if (!ids.length) return out;
		const rows = await this.all(
			"SELECT lo.lamning_id AS id, o.niva, o.namn FROM lamning_omrade lo JOIN omrade o ON o.id = lo.omrade_id WHERE lo.lamning_id IN (SELECT value FROM json_each(?)) ORDER BY o.namn",
			[JSON.stringify(ids)],
		);
		for (const r of rows) {
			const id = Number(r.id);
			const a = out.get(id) ?? emptyAreas();
			const niva = r.niva as keyof Areas;
			const namn = str(r.namn);
			if (namn && a[niva] && !a[niva].includes(namn)) a[niva].push(namn);
			out.set(id, a);
		}
		return out;
	}

	private toHit(r: Row, areas: Areas | undefined, utdrag: string | null): IndexHit {
		const uuid = String(r.uuid);
		const lat = num(r.lat);
		const lon = num(r.lon);
		const a = areas ?? emptyAreas();
		return {
			uuid,
			lamningsnummer: str(r.lamningsnummer),
			raa_nummer: str(r.raa_nummer),
			lamningstyp: str(r.lamningstyp),
			antikvarisk_bedomning: str(r.bedomning),
			kommun: a.kommun,
			socken: a.socken,
			lan: a.lan,
			landskap: a.landskap,
			koordinat: lat !== null && lon !== null ? { lat, lon } : null,
			beskrivning: str(r.beskrivning),
			url: publicUrl(uuid),
			utdrag,
			sweref99tm: sweref(r),
			geometrityp: str(r.geometrityp),
			osakerhet_m: num(r.osakerhet_m),
			lamningsnamn: str(r.namn),
		};
	}

	// ------------------------------------------------------------ sök

	/** SearchSource: samma som searchIndex, med källgränssnittets filter. */
	async search(filter: IndexSearchFilter, page: { antal: number; sida: number }): Promise<IndexSearchPage> {
		return this.searchIndex(filter, page);
	}

	/**
	 * Kandidater nära `p`: lämningar som uppfyller villkoren och vars ruta skär
	 * sökrutan, ordnade efter rutans avstånd till punkten (som aldrig är större
	 * än det exakta avståndet), högst MAX_KANDIDATER. Sedan exakt avstånd till
	 * geometrin.
	 *
	 * Fanns fler kandidater sätts `cutoff` till rutavståndet för den första som
	 * inte hämtades: alla lämningar med exakt avstånd ≤ cutoff är då med, men
	 * bortom cutoff kan några saknas. Därför stryks träffar bortom cutoff, och
	 * svaret är fullständigt inom min(radie, cutoff).
	 *
	 * Med sökord är lämning yttre loop (MATCH prövas per kandidat), så att ett
	 * vanligt ord inte läser hela sin träfflista (granskningen, punkt 5).
	 */
	private async nearCandidates(
		conditions: SqlPart[],
		fts: FtsQuery | null,
		p: Planar,
		radius: number | null,
	): Promise<{ hits: Array<{ id: number; uuid: string; m: Measured; rank: number | null }>; cutoff: number | null }> {
		const from = fts ? "FROM lamning l CROSS JOIN lamning_fts f ON f.rowid = l.id" : "FROM lamning l";
		const w = where(conditions, fts ? [{ sql: "f.lamning_fts MATCH ?", params: [fts.match] }] : []);
		const rows = await this.all(
			{
				sql: `SELECT l.id, max(l.min_e - ?, 0, ? - l.max_e) AS dx, max(l.min_n - ?, 0, ? - l.max_n) AS dy${fts ? `, ${RANK} AS rk` : ""} ${from} ${w.sql} ORDER BY dx * dx + dy * dy, l.id LIMIT ?`,
				params: [p.e, p.e, p.n, p.n, ...w.params],
			},
			[this.maxKandidater + 1],
		);
		let cutoff: number | null = null;
		if (rows.length > this.maxKandidater) {
			const r = rows[this.maxKandidater];
			cutoff = Math.hypot(Number(r.dx) || 0, Number(r.dy) || 0);
			rows.length = this.maxKandidater;
		}
		const rank = new Map(rows.map((r) => [Number(r.id), num(r.rk)]));
		const limit = Math.min(radius ?? Number.POSITIVE_INFINITY, cutoff ?? Number.POSITIVE_INFINITY);
		const hits: Array<{ id: number; uuid: string; m: Measured; rank: number | null }> = [];
		const ids = rows.map((r) => Number(r.id));
		for (let i = 0; i < ids.length; i += GEOMETRI_OMGANG) {
			const chunk = ids.slice(i, i + GEOMETRI_OMGANG);
			const geo = await this.all("SELECT l.id, l.uuid, l.geometri FROM lamning l WHERE l.id IN (SELECT value FROM json_each(?))", [
				JSON.stringify(chunk),
			]);
			for (const g of geo) {
				const m = measure(p, g.geometri);
				if (!m || m.distance > limit) continue;
				const id = Number(g.id);
				hits.push({ id, uuid: String(g.uuid), m, rank: rank.get(id) ?? null });
			}
		}
		return { hits, cutoff };
	}

	/** Träffrader (med utdrag runt sökorden när `fts` finns) för givna id, i godtycklig ordning. */
	private async hitRows(ids: number[], fts: FtsQuery | null): Promise<Map<number, Row>> {
		if (!ids.length) return new Map();
		const rows = fts
			? await this.all(
					{
						sql: `SELECT ${HIT_COLUMNS}${SNIPPETS} FROM lamning l CROSS JOIN lamning_fts f ON f.rowid = l.id WHERE l.id IN (SELECT value FROM json_each(?)) AND f.lamning_fts MATCH ?`,
						params: [JSON.stringify(ids), fts.match],
					},
				)
			: await this.all(`SELECT ${HIT_COLUMNS} FROM lamning l WHERE l.id IN (SELECT value FROM json_each(?))`, [JSON.stringify(ids)]);
		return new Map(rows.map((r) => [Number(r.id), r]));
	}

	/**
	 * Fulltextsök med filter. Med sökord rangordnas träffarna med bm25 (typ och
	 * namn väger tyngst, sedan tradition, beskrivning och terräng); utan sökord
	 * i lämningsnummerordning. Med `nara` filtreras på exakt avstånd till
	 * geometrin, och utan sökord sorteras närmast först.
	 *
	 * Högst MAX_OFFSET träffar går att bläddra till (`nabara`); en sida bortom
	 * det ger en tom träfflista (granskningen, punkt 6). Utdrag räknas bara för
	 * den sida som returneras (punkt 9).
	 */
	async searchIndex(filter: IndexSearchFilter, page: { antal?: number; sida?: number } = {}): Promise<IndexSearchPage> {
		const antal = clampInt(page.antal, 15, 1, MAX_ANTAL);
		const sida = clampInt(page.sida, 1, 1, Number.MAX_SAFE_INTEGER);
		const offset = (sida - 1) * antal;
		const b = buildFilter(filter);
		const sokord = b.fts ? b.fts.terms.map((t) => `${t.term}${t.prefix ? "*" : ""}`) : [];
		const byggdatum = await this.byggdatum();
		const beyond = offset >= MAX_OFFSET;

		let totalt: number;
		let ungefar = false;
		let pageIds: Array<{ id: number; d?: number; dir?: string | null }>;
		if (!b.nara) {
			// CROSS JOIN tvingar FTS-tabellen att vara yttre loop. Annars kan planeraren
			// låta ett selektivt filter driva och utvärdera MATCH en gång per rad (FTS5-fälla).
			const from = b.fts ? "FROM lamning_fts f CROSS JOIN lamning l ON l.id = f.rowid" : "FROM lamning l";
			const w = where(b.conditions, b.fts ? [{ sql: "f.lamning_fts MATCH ?", params: [b.fts.match] }] : []);
			const order = b.fts ? `ORDER BY ${RANK}, l.id` : `ORDER BY ${ORDER_LAMNINGSNUMMER}`;
			const stmts = [this.stmt({ sql: `SELECT count(*) AS c ${from} ${w.sql}`, params: w.params })];
			if (!beyond) stmts.push(this.stmt({ sql: `SELECT l.id ${from} ${w.sql} ${order} LIMIT ? OFFSET ?`, params: w.params }, [antal, offset]));
			const [countRows, idRows = []] = await this.batch(stmts);
			totalt = num(countRows[0]?.c) ?? 0;
			pageIds = idRows.map((r) => ({ id: Number(r.id) }));
		} else {
			const { hits, cutoff } = await this.nearCandidates(b.conditions, b.fts, b.nara.p, b.nara.radie_m);
			ungefar = cutoff !== null;
			if (b.fts) hits.sort((x, y) => (x.rank ?? 0) - (y.rank ?? 0) || x.id - y.id);
			else hits.sort((x, y) => x.m.distance - y.m.distance || x.id - y.id);
			totalt = hits.length;
			pageIds = beyond ? [] : hits.slice(offset, offset + antal).map((h) => ({ id: h.id, d: h.m.distance, dir: h.m.dir }));
		}
		const ids = pageIds.map((x) => x.id);
		const [rows, areas] = await Promise.all([this.hitRows(ids, b.fts), this.areasFor(ids)]);
		const traffar: IndexHit[] = [];
		for (const x of pageIds) {
			const r = rows.get(x.id);
			if (!r) continue;
			const hit = this.toHit(r, areas.get(x.id), chooseUtdrag(r));
			traffar.push(x.d !== undefined ? { ...hit, avstand_m: Math.round(x.d), vaderstreck: x.dir ?? null } : hit);
		}
		return {
			totalt,
			nabara: Math.min(totalt, MAX_OFFSET),
			traffar,
			kalla: KALLA_INDEX,
			byggdatum,
			sokord,
			...(ungefar ? { totalt_ungefar: true } : {}),
		};
	}

	/**
	 * Rangordnade UUID för hela filtret (högst `limit`), utan radinnehåll. Samma
	 * ordning som searchIndex: bm25 med sökord, annars närmast först med `nara`,
	 * annars lämningsnummer. Används för sammanslagning med den semantiska kanalen.
	 */
	async searchRanked(filter: IndexSearchFilter, limit: number): Promise<RankedPage> {
		const lim = clampInt(limit, 100, 1, MAX_KANDIDATER);
		const b = buildFilter(filter);
		const sokord = b.fts ? b.fts.terms.map((t) => `${t.term}${t.prefix ? "*" : ""}`) : [];
		if (!b.nara) {
			const from = b.fts ? "FROM lamning_fts f CROSS JOIN lamning l ON l.id = f.rowid" : "FROM lamning l";
			const w = where(b.conditions, b.fts ? [{ sql: "f.lamning_fts MATCH ?", params: [b.fts.match] }] : []);
			const order = b.fts ? `ORDER BY ${RANK}, l.id` : `ORDER BY ${ORDER_LAMNINGSNUMMER}`;
			const [countRows, rows] = await this.batch([
				this.stmt({ sql: `SELECT count(*) AS c ${from} ${w.sql}`, params: w.params }),
				this.stmt({ sql: `SELECT l.uuid ${from} ${w.sql} ${order} LIMIT ?`, params: w.params }, [lim]),
			]);
			return { totalt: num(countRows[0]?.c) ?? 0, ids: rows.map((r) => ({ uuid: String(r.uuid) })), sokord };
		}
		const { hits, cutoff } = await this.nearCandidates(b.conditions, b.fts, b.nara.p, b.nara.radie_m);
		if (b.fts) hits.sort((x, y) => (x.rank ?? 0) - (y.rank ?? 0) || x.id - y.id);
		else hits.sort((x, y) => x.m.distance - y.m.distance || x.id - y.id);
		return {
			totalt: hits.length,
			ids: hits.slice(0, lim).map((h) => ({ uuid: h.uuid, avstand_m: Math.round(h.m.distance), vaderstreck: h.m.dir })),
			sokord,
			...(cutoff !== null ? { totalt_ungefar: true } : {}),
		};
	}

	/**
	 * Träffar för givna UUID som uppfyller filtret (utom sökorden, som här bara
	 * används för utdrag). UUID som inte finns eller inte uppfyller filtret
	 * saknas i svaret. Med `nara` räknas exakt avstånd och lämningar utanför
	 * radien stryks. Högst MAX_ANTAL åt gången.
	 */
	async hitsByUuids(uuids: string[], filter: IndexSearchFilter = {}): Promise<Map<string, IndexHit>> {
		const out = new Map<string, IndexHit>();
		const list = [...new Set(uuids.filter((u) => typeof u === "string" && UUID_RE.test(u)).map((u) => u.toLowerCase()))];
		if (!list.length) return out;
		if (list.length > MAX_ANTAL) throw new IndexInputError(`Högst ${MAX_ANTAL} poster åt gången.`);
		const b = buildFilter({ ...filter, fraga: undefined, ord: undefined });
		const fts = buildFilter({ fraga: filter.fraga, ord: filter.ord }).fts;
		const idCond: SqlPart = { sql: "l.uuid IN (SELECT value FROM json_each(?))", params: [JSON.stringify(list)] };
		const w = where(b.conditions, [idCond]);
		const rows = await this.all({ sql: `SELECT ${HIT_COLUMNS}, l.geometri FROM lamning l ${w.sql}`, params: w.params });
		const dist = new Map<number, { d: number; dir: string | null }>();
		const kept: Row[] = [];
		for (const r of rows) {
			if (b.nara) {
				const d = distanceTo(b.nara.p, r.geometri);
				if (!d || d.distance > b.nara.radie_m) continue;
				dist.set(Number(r.id), { d: d.distance, dir: d.dir });
			}
			kept.push(r);
		}
		if (!kept.length) return out;
		const ids = kept.map((r) => Number(r.id));
		// Utdrag runt sökorden för de träffar som innehåller dem; övriga får beskrivningens början.
		const [snippets, areas] = await Promise.all([fts ? this.hitRows(ids, fts) : new Map<number, Row>(), this.areasFor(ids)]);
		for (const r of kept) {
			const id = Number(r.id);
			const sn = snippets.get(id);
			const hit = this.toHit(r, areas.get(id), sn ? chooseUtdrag(sn) : lead(str(r.beskrivning)));
			const d = dist.get(id);
			out.set(hit.uuid, d ? { ...hit, avstand_m: Math.round(d.d), vaderstreck: d.dir } : hit);
		}
		return out;
	}

	// ------------------------------------------------------------ närhet

	/**
	 * Lämningar nära en punkt (radie) eller i en ruta, sorterade efter exakt
	 * avstånd i SWEREF 99 TM till närmaste punkt på geometrin (0 inom en yta).
	 * I mycket täta områden (fler än MAX_KANDIDATER kandidater) är svaret
	 * fullständigt inom `fullstandig_inom_m` och `totalt_ungefar` sätts.
	 */
	async nearby(q: NearbyIndexQuery): Promise<NearbyIndexPage> {
		const antal = clampInt(q.antal, 25, 1, MAX_ANTAL);
		let center: Planar;
		let radius: number | null = null;
		let box: SwerefBox;
		if (q.bbox) {
			box = wgsBoxToSweref(q.bbox);
			center = { e: (box[0] + box[2]) / 2, n: (box[1] + box[3]) / 2 };
		} else {
			if (typeof q.lat !== "number" || typeof q.lon !== "number") throw new IndexInputError("Ange lat och lon, eller bbox.");
			center = checkedPlanar(q.lat, q.lon);
			radius = clampInt(q.radie_m, 500, 1, 10_000);
			box = boxAround(center, radius);
		}
		const f = buildFilter({
			lamningstyp: q.lamningstyp,
			antikvarisk_bedomning: q.antikvarisk_bedomning as IndexSearchFilter["antikvarisk_bedomning"],
		});
		const { hits, cutoff } = await this.nearCandidates([...f.conditions, spatialCondition(box)], null, center, radius);
		hits.sort((a, b) => a.m.distance - b.m.distance || a.id - b.id);
		const top = hits.slice(0, antal);
		const ids = top.map((x) => x.id);
		const [rows, areas, byggdatum] = await Promise.all([this.hitRows(ids, null), this.areasFor(ids), this.byggdatum()]);
		const traffar: NearbyIndexPage["traffar"] = [];
		for (const x of top) {
			const r = rows.get(x.id);
			if (!r) continue;
			traffar.push({
				...this.toHit(r, areas.get(x.id), lead(str(r.beskrivning))),
				avstand_m: Math.round(x.m.distance),
				vaderstreck: x.m.dir,
				narmaste_punkt_sweref: x.m.point,
				narmaste_typ: x.m.typ,
				geometrier: x.m.geometrier,
				geometrityper: x.m.geometrityper,
			});
		}
		return {
			totalt: hits.length,
			traffar,
			kalla: KALLA_INDEX,
			byggdatum,
			...(cutoff !== null ? { totalt_ungefar: true, fullstandig_inom_m: Math.floor(Math.min(cutoff, radius ?? cutoff)) } : {}),
		};
	}

	/** NearbySource: lämningar vars ruta skär `bbox`, med geometri i WGS 84. */
	async featuresInBbox(q: NearbyQuery): Promise<NearbyPage> {
		const box = wgsBoxToSweref(q.bbox);
		const f = buildFilter({
			lamningstyp: q.lamningstyp,
			antikvarisk_bedomning: q.antikvarisk_bedomning as IndexSearchFilter["antikvarisk_bedomning"],
		});
		const w = where([...f.conditions, spatialCondition(box)]);
		const limit = clampInt(q.limit, 100, 1, 1000);
		const [countRows, rows] = await this.batch([
			this.stmt({ sql: `SELECT count(*) AS c FROM lamning l ${w.sql}`, params: w.params }),
			this.stmt(
				{ sql: `SELECT ${HIT_COLUMNS}, l.geometri FROM lamning l ${w.sql} ORDER BY l.id LIMIT ?`, params: w.params },
				[limit],
			),
		]);
		const areas = await this.areasFor(rows.map((r) => Number(r.id)));
		const features: NearbyFeature[] = [];
		for (const r of rows) {
			const g = parseGeometry(r.geometri);
			const nr = str(r.lamningsnummer);
			if (!g || !nr) continue;
			const a = areas.get(Number(r.id)) ?? emptyAreas();
			const uuid = String(r.uuid);
			features.push({
				lamningsnummer: nr,
				uuid,
				raa_nummer: str(r.raa_nummer),
				lamningstyp: str(r.lamningstyp),
				antikvarisk_bedomning: str(r.bedomning),
				lamningsnamn: str(r.namn),
				kommun: a.kommun.length ? a.kommun.join(", ") : null,
				lan: a.lan.length ? a.lan.join(", ") : null,
				url: publicUrl(uuid),
				geometry: g,
			});
		}
		// Antalet avser lämningar (inte geometrier, som i OGC-källan).
		return { numberMatched: num(countRows[0]?.c), numberReturned: rows.length, features };
	}

	// ------------------------------------------------------------ statistik

	/** Antal lämningar per grupp, en eller två nivåer, högst 200 rader. */
	async statistik(gruppera_pa: StatistikDimension[], filter: IndexSearchFilter = {}): Promise<StatistikResult> {
		if (!Array.isArray(gruppera_pa) || gruppera_pa.length < 1 || gruppera_pa.length > 2)
			throw new IndexInputError("gruppera_pa: ange en eller två nivåer.");
		for (const d of gruppera_pa)
			if (!STATISTIK_DIMENSIONER.includes(d)) throw new IndexInputError(`gruppera_pa: okänd nivå ${String(d)}.`);
		if (gruppera_pa.length === 2 && gruppera_pa[0] === gruppera_pa[1]) throw new IndexInputError("gruppera_pa: två olika nivåer.");
		const b = buildFilter(filter);
		const byggdatum = await this.byggdatum();

		// Snabbväg: en områdesnivå utan filter räknas direkt ur lamning_omrade, utan att läsa lamning (punkt 9).
		const d0 = gruppera_pa[0];
		if (gruppera_pa.length === 1 && !b.conditions.length && !b.fts && !b.nara && AREA_DIMS.has(d0)) {
			const [rows, tot] = await this.batch([
				this.stmt(
					`SELECT ${areaLabel("o", d0)} AS v0, count(*) AS antal FROM lamning_omrade lo JOIN omrade o ON o.id = lo.omrade_id WHERE o.niva = ? GROUP BY o.id ORDER BY antal DESC, v0`,
					[d0],
				),
				this.stmt(
					"SELECT (SELECT count(*) FROM lamning) AS c, (SELECT count(DISTINCT lo.lamning_id) FROM lamning_omrade lo JOIN omrade o ON o.id = lo.omrade_id WHERE o.niva = ?) AS med",
					[d0],
				),
			]);
			const totalt = num(tot[0]?.c) ?? 0;
			const saknas = totalt - (num(tot[0]?.med) ?? 0);
			const grupper = rows.map((r) => ({ varden: [String(r.v0)], antal: num(r.antal) ?? 0 }));
			if (saknas > 0) grupper.push({ varden: ["(saknas)"], antal: saknas });
			grupper.sort((a, b) => b.antal - a.antal || a.varden[0].localeCompare(b.varden[0]));
			return {
				gruppera_pa,
				totalt,
				grupper: grupper.slice(0, MAX_STATISTIK_RADER),
				avkortad: grupper.length > MAX_STATISTIK_RADER,
				kalla: KALLA_INDEX,
				byggdatum,
			};
		}

		const extra: SqlPart[] = b.fts ? [{ sql: "l.id IN (SELECT rowid FROM lamning_fts WHERE lamning_fts MATCH ?)", params: [b.fts.match] }] : [];
		const joins: SqlPart[] = [];
		const values: string[] = [];
		gruppera_pa.forEach((d, i) => {
			const a = `g${i}`;
			switch (d) {
				case "typ":
					values.push("coalesce(l.lamningstyp, '(saknas)')");
					break;
				case "bedomning":
					values.push("coalesce(l.bedomning, '(saknas)')");
					break;
				case "kategori":
					joins.push({ sql: `LEFT JOIN lamningstyp_kategori ${a} ON ${a}.lamningstyp = l.lamningstyp`, params: [] });
					values.push(`coalesce(${a}.kategori, '(saknas)')`);
					break;
				default:
					joins.push({
						sql: `LEFT JOIN (SELECT lo.lamning_id, o.namn, o.lan FROM lamning_omrade lo JOIN omrade o ON o.id = lo.omrade_id WHERE o.niva = ?) ${a} ON ${a}.lamning_id = l.id`,
						params: [d],
					});
					values.push(`coalesce(${areaLabel(a, d)}, '(saknas)')`);
			}
		});
		let w = where(b.conditions, extra);
		let ungefar = false;
		if (b.nara) {
			// Exakt avstånd till geometrin, som i sökningen.
			const { hits, cutoff } = await this.nearCandidates(b.conditions, b.fts, b.nara.p, b.nara.radie_m);
			ungefar = cutoff !== null;
			w = { sql: "WHERE l.id IN (SELECT value FROM json_each(?))", params: [JSON.stringify(hits.map((h) => h.id))] };
		}
		const cols = values.map((v, i) => `${v} AS v${i}`).join(", ");
		const groupBy = values.map((_, i) => `v${i}`).join(", ");
		const sql = `SELECT ${cols}, count(*) AS antal FROM lamning l ${joins.map((j) => j.sql).join(" ")} ${w.sql} GROUP BY ${groupBy} ORDER BY antal DESC, ${groupBy} LIMIT ?`;
		const [rows, countRows] = await this.batch([
			this.stmt({ sql, params: [...joins.flatMap((j) => j.params), ...w.params] }, [MAX_STATISTIK_RADER + 1]),
			this.stmt({ sql: `SELECT count(*) AS c FROM lamning l ${w.sql}`, params: w.params }),
		]);
		return {
			gruppera_pa,
			totalt: num(countRows[0]?.c) ?? 0,
			grupper: rows.slice(0, MAX_STATISTIK_RADER).map((r) => ({
				varden: gruppera_pa.map((_, i) => String(r[`v${i}`] ?? "(saknas)")),
				antal: num(r.antal) ?? 0,
			})),
			avkortad: rows.length > MAX_STATISTIK_RADER,
			kalla: KALLA_INDEX,
			byggdatum,
			...(ungefar ? { totalt_ungefar: true } : {}),
		};
	}

	// ------------------------------------------------------------ uppslag

	/**
	 * Slå upp lämningsnummer, RAÄ-nummer, UUID, K-samsök-URI eller publik länk
	 * → UUID. Nycklarna i svaret är indata som de gavs; okända saknas. Ett
	 * RAÄ-nummer kan delas av flera lämningar (t.ex. "Leksand 963:1"); då ges
	 * alla, i lämningsnummerordning.
	 */
	async resolveIdsAll(ids: string[]): Promise<Map<string, string[]>> {
		const out = new Map<string, string[]>();
		if (!Array.isArray(ids) || !ids.length) return out;
		if (ids.length > MAX_ANTAL) throw new IndexInputError(`Högst ${MAX_ANTAL} id åt gången.`);
		const uuids = new Map<string, string>();
		const ln = new Map<string, string[]>();
		const raa = new Map<string, string[]>();
		const add = (m: Map<string, string[]>, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v]);
		for (const input of ids) {
			if (typeof input !== "string" || input.length > 300) continue;
			const s = input.trim();
			const u = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(s);
			if (u && (UUID_RE.test(s) || /^https?:\/\//i.test(s))) {
				uuids.set(input, u[1].toLowerCase());
				continue;
			}
			const n = normLamningsnummer(s);
			if (n) add(ln, n, input);
			else if (s) add(raa, normRaa(s), input);
		}
		const rows = await this.all(
			`SELECT uuid, lamningsnummer, raa_sok FROM lamning
			  WHERE uuid IN (SELECT value FROM json_each(?))
			     OR lamningsnummer IN (SELECT value FROM json_each(?))
			     OR raa_sok IN (SELECT value FROM json_each(?))`,
			[JSON.stringify([...new Set(uuids.values())]), JSON.stringify([...ln.keys()]), JSON.stringify([...raa.keys()])],
		);
		rows.sort((a, b) => compareLamningsnummer(str(a.lamningsnummer), str(b.lamningsnummer)) || String(a.uuid).localeCompare(String(b.uuid)));
		const known = new Set(rows.map((r) => String(r.uuid)));
		for (const [input, u] of uuids) if (known.has(u)) out.set(input, [u]);
		const push = (input: string, uuid: string) => {
			const l = out.get(input) ?? [];
			if (!l.includes(uuid)) l.push(uuid);
			out.set(input, l);
		};
		for (const r of rows) for (const input of ln.get(String(r.lamningsnummer)) ?? []) push(input, String(r.uuid));
		for (const r of rows) for (const input of raa.get(String(r.raa_sok)) ?? []) push(input, String(r.uuid));
		return out;
	}

	/**
	 * Som resolveIdsAll, men ett UUID per indata. Ett RAÄ-nummer som delas av
	 * flera lämningar ger den med lägst lämningsnummer; använd resolveIdsAll när
	 * flertydigheten ska visas.
	 */
	async resolveIds(ids: string[]): Promise<Map<string, string>> {
		const all = await this.resolveIdsAll(ids);
		return new Map([...all].map(([k, v]) => [k, v[0]]));
	}

	/** IdResolver: lämningsnummer/RAÄ-nummer → UUID. */
	async resolveNumbers(numbers: string[]): Promise<Map<string, string>> {
		return this.resolveIds(numbers);
	}

	// ------------------------------------------------------------ post

	/** RecordSource: grundposten ur indexet, med geometri i WGS 84. */
	async getByUuid(uuid: string): Promise<RecordFetchResult | null> {
		const m = await this.getByUuids([uuid]);
		return m.get(uuid.toLowerCase()) ?? null;
	}

	/** Flera grundposter i ett anrop (högst 100). */
	async getByUuids(uuids: string[]): Promise<Map<string, RecordFetchResult>> {
		const out = new Map<string, RecordFetchResult>();
		const list = [...new Set(uuids.filter((u) => typeof u === "string" && UUID_RE.test(u)).map((u) => u.toLowerCase()))];
		if (!list.length) return out;
		if (list.length > MAX_ANTAL) throw new IndexInputError(`Högst ${MAX_ANTAL} poster åt gången.`);
		const p = JSON.stringify(list);
		const sub = "(SELECT id FROM lamning WHERE uuid IN (SELECT value FROM json_each(?)))";
		const [lam, om, eg, ing, kat, status] = await this.batch([
			this.stmt(`SELECT * FROM lamning WHERE uuid IN (SELECT value FROM json_each(?))`, [p]),
			this.stmt(
				`SELECT lo.lamning_id AS id, o.niva, o.namn FROM lamning_omrade lo JOIN omrade o ON o.id = lo.omrade_id WHERE lo.lamning_id IN ${sub} ORDER BY o.namn`,
				[p],
			),
			this.stmt(`SELECT lamning_id AS id, ingaende_nr, typ, varde FROM egenskap WHERE lamning_id IN ${sub} ORDER BY rowid`, [p]),
			this.stmt(`SELECT lamning_id AS id, nr, lamningstyp, antal FROM ingaende WHERE lamning_id IN ${sub} ORDER BY nr`, [p]),
			this.stmt(
				`SELECT k.lamningstyp, k.kategori FROM lamningstyp_kategori k WHERE k.lamningstyp IN (SELECT lamningstyp FROM lamning WHERE uuid IN (SELECT value FROM json_each(?))) ORDER BY k.kategori`,
				[p],
			),
			this.stmt("SELECT varde FROM synk_status WHERE nyckel = 'uttagsdatum'"),
		]);
		const byggdatum = str(status[0]?.varde);
		for (const r of lam) {
			const id = Number(r.id);
			const uuid = String(r.uuid);
			const areas = emptyAreas();
			for (const o of om) {
				if (Number(o.id) !== id) continue;
				const niva = o.niva as keyof Areas;
				const namn = str(o.namn);
				if (namn && areas[niva] && !areas[niva].includes(namn)) areas[niva].push(namn);
			}
			const egenskaper = eg.filter((e) => Number(e.id) === id);
			const typ = str(r.lamningstyp);
			const geometri = parseGeometry(r.geometri);
			const lat = num(r.lat);
			const lon = num(r.lon);
			const post: LamningPost = {
				lamningsnummer: str(r.lamningsnummer),
				raa_nummer: str(r.raa_nummer),
				uuid,
				lamningstyp: typ,
				kategori: kat.filter((k) => k.lamningstyp === typ).map((k) => String(k.kategori)),
				antikvarisk_bedomning: { varde: str(r.bedomning), motivering: str(r.bedomning_motivering) },
				beskrivning: str(r.beskrivning),
				tradition: str(r.tradition),
				terrang: str(r.terrang),
				orientering: str(r.orientering),
				namn: str(r.namn) ? [String(r.namn)] : [],
				egenskaper: egenskaper
					.filter((e) => e.ingaende_nr === null || e.ingaende_nr === undefined)
					.map((e) => ({ typ: String(e.typ), varde: String(e.varde) })),
				ingaende_lamningar: ing
					.filter((i) => Number(i.id) === id)
					.map((i) => ({
						lamningstyp: String(i.lamningstyp),
						antal: num(i.antal),
						egenskaper: egenskaper
							.filter((e) => e.ingaende_nr !== null && Number(e.ingaende_nr) === Number(i.nr))
							.map((e) => ({ typ: String(e.typ), varde: String(e.varde) })),
					})),
				statusar: {
					aktualitet: str(r.aktualitet),
					undersokning: str(r.undersokning),
					skada: str(r.skada),
					placering: str(r.placering),
				},
				lage: {
					lat: lat !== null ? round(lat, 7) : null,
					lon: lon !== null ? round(lon, 7) : null,
					sweref99tm: sweref(r),
					osakerhet_m: num(r.osakerhet_m),
					geometrityp: str(r.geometrityp),
				},
				indelning: areas,
				url: publicUrl(uuid),
				kalla: KALLA,
				hamtad_fran: `index${str(r.uttagsdatum) ? ` ${String(r.uttagsdatum)}` : byggdatum ? ` ${byggdatum}` : ""}`,
				...(r.geometri_forenklad ? { geometri_forenklad: true } : {}),
			};
			out.set(uuid, {
				post,
				geometriWgs: geometri,
				// Referenser finns inte i GeoPackage-filen; hämtas från Fornsök-appen vid behov.
				referenser: { skriftliga_kallor: [], kartmaterial: [], uppgiftslamnare: [] },
			});
		}
		return out;
	}

	/** Egenskapstyper och värden i indexet, med antal lämningar (för uppslag). */
	async egenskaper(typ?: string): Promise<Array<{ typ: string; varde: string; antal: number }>> {
		const rows = typ
			? await this.all(
					"SELECT typ, varde, count(DISTINCT lamning_id) AS antal FROM egenskap WHERE typ = ? GROUP BY typ, varde ORDER BY antal DESC LIMIT 1000",
					[typ],
				)
			: await this.all("SELECT typ, varde, count(DISTINCT lamning_id) AS antal FROM egenskap GROUP BY typ, varde ORDER BY typ, antal DESC LIMIT 5000");
		return rows.map((r) => ({ typ: String(r.typ), varde: String(r.varde), antal: num(r.antal) ?? 0 }));
	}
}

interface Measured {
	distance: number;
	dir: string | null;
	point: Planar;
	typ: string;
	geometrier: number;
	geometrityper: string[];
}

/** Som distanceTo, men med närmaste punkt och vilken delgeometri den ligger på. */
function measure(p: Planar, geometri: unknown): Measured | null {
	const g = parseGeometry(geometri);
	if (!g) return null;
	const parts = g.type === "GeometryCollection" ? g.geometries : [g];
	let best: { distance: number; point: Planar; typ: string } | null = null;
	for (const part of parts) {
		const r = nearestPoint(p, wgsToSweref(part));
		if (Number.isFinite(r.distance) && (!best || r.distance < best.distance)) best = { distance: r.distance, point: r.point, typ: part.type };
	}
	if (!best) return null;
	return {
		distance: best.distance,
		dir: compassDirection(p, best.point),
		point: best.point,
		typ: best.typ,
		geometrier: parts.length,
		geometrityper: [...new Set(parts.map((x) => x.type))],
	};
}

/** Avstånd och väderstreck från `p` (SWEREF) till geometrin (GeoJSON i WGS 84). */
function distanceTo(p: Planar, geometri: unknown): { distance: number; dir: string | null } | null {
	const g = parseGeometry(geometri);
	if (!g) return null;
	const r = nearestPoint(p, wgsToSweref(g));
	if (!Number.isFinite(r.distance)) return null;
	return { distance: r.distance, dir: compassDirection(p, r.point) };
}
