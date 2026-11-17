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

export interface NearbyIndexPage {
	/** Antal lämningar inom radien (eller rutan). */
	totalt: number;
	traffar: Array<IndexHit & { avstand_m: number; vaderstreck: string | null }>;
	kalla: string;
	byggdatum: string | null;
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

	constructor(db: D1Like) {
		this.db = db;
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
	 * Fulltextsök med filter. Med sökord rangordnas träffarna med bm25 (typ och
	 * namn väger tyngst, sedan tradition, beskrivning och terräng); utan sökord
	 * i lämningsnummerordning. Med `nara` filtreras på exakt avstånd till
	 * geometrin, och utan sökord sorteras närmast först.
	 */
	async searchIndex(filter: IndexSearchFilter, page: { antal?: number; sida?: number } = {}): Promise<IndexSearchPage> {
		const antal = clampInt(page.antal, 15, 1, MAX_ANTAL);
		const sida = clampInt(page.sida, 1, 1, 1 + Math.floor(MAX_OFFSET / antal));
		const offset = (sida - 1) * antal;
		const b = buildFilter(filter);
		const sokord = b.fts ? b.fts.terms.map((t) => `${t.term}${t.prefix ? "*" : ""}`) : [];
		const byggdatum = await this.byggdatum();

		// CROSS JOIN tvingar FTS-tabellen att vara yttre loop. Annars kan planeraren
		// låta ett selektivt filter driva och utvärdera MATCH en gång per rad (FTS5-fälla).
		const ftsFrom = "FROM lamning_fts f CROSS JOIN lamning l ON l.id = f.rowid";
		const ftsCond: SqlPart[] = b.fts ? [{ sql: "f.lamning_fts MATCH ?", params: [b.fts.match] }] : [];
		const w = where(b.conditions, ftsCond);
		const from = b.fts ? ftsFrom : "FROM lamning l";
		const rank = "bm25(lamning_fts, 4.0, 4.0, 1.0, 2.0, 0.5)";
		const snippets = b.fts
			? [2, 3, 4]
					.map((c, i) => `, snippet(lamning_fts, ${c}, '«', '»', ' … ', 32) AS ${["s_besk", "s_trad", "s_terr"][i]}`)
					.join("")
			: "";

		if (!b.nara) {
			const order = b.fts ? `ORDER BY ${rank}` : "ORDER BY l.lamningsnummer, l.id";
			const [countRows, rows] = await this.batch([
				this.stmt({ sql: `SELECT count(*) AS c ${from} ${w.sql}`, params: w.params }),
				this.stmt({ sql: `SELECT ${HIT_COLUMNS}${snippets} ${from} ${w.sql} ${order} LIMIT ? OFFSET ?`, params: w.params }, [antal, offset]),
			]);
			const areas = await this.areasFor(rows.map((r) => Number(r.id)));
			return {
				totalt: num(countRows[0]?.c) ?? 0,
				traffar: rows.map((r) => this.toHit(r, areas.get(Number(r.id)), chooseUtdrag(r))),
				kalla: KALLA_INDEX,
				byggdatum,
				sokord,
			};
		}

		// Med `nara`: hämta kandidater i rutan, räkna exakt avstånd, filtrera och sortera.
		const order = b.fts ? `ORDER BY ${rank}` : "";
		const cand = await this.all(
			{ sql: `SELECT l.id, l.geometri ${from} ${w.sql} ${order} LIMIT ?`, params: w.params },
			[MAX_KANDIDATER + 1],
		);
		const ungefar = cand.length > MAX_KANDIDATER;
		const nara = b.nara;
		const within: Array<{ id: number; d: number; dir: string | null }> = [];
		for (const r of cand.slice(0, MAX_KANDIDATER)) {
			const d = distanceTo(nara.p, r.geometri);
			if (d && d.distance <= nara.radie_m) within.push({ id: Number(r.id), d: d.distance, dir: d.dir });
		}
		if (!b.fts) within.sort((x, y) => x.d - y.d || x.id - y.id);
		const pageIds = within.slice(offset, offset + antal);
		const ids = pageIds.map((x) => x.id);
		const rows = ids.length
			? await this.all(
					{
						sql: `SELECT ${HIT_COLUMNS}${snippets} ${from} WHERE l.id IN (SELECT value FROM json_each(?))${b.fts ? " AND f.lamning_fts MATCH ?" : ""}`,
						params: b.fts ? [JSON.stringify(ids), b.fts.match] : [JSON.stringify(ids)],
					},
				)
			: [];
		const byId = new Map(rows.map((r) => [Number(r.id), r]));
		const areas = await this.areasFor(ids);
		const traffar: IndexHit[] = [];
		for (const x of pageIds) {
			const r = byId.get(x.id);
			if (!r) continue;
			traffar.push({
				...this.toHit(r, areas.get(x.id), chooseUtdrag(r)),
				avstand_m: Math.round(x.d),
				vaderstreck: x.dir,
			});
		}
		return {
			totalt: within.length,
			traffar,
			kalla: KALLA_INDEX,
			byggdatum,
			sokord,
			...(ungefar ? { totalt_ungefar: true } : {}),
		};
	}

	// ------------------------------------------------------------ närhet

	/**
	 * Lämningar nära en punkt (radie) eller i en ruta, sorterade efter exakt
	 * avstånd i SWEREF 99 TM till närmaste punkt på geometrin (0 inom en yta).
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
		const w = where([...f.conditions, spatialCondition(box)]);
		const cand = await this.all({ sql: `SELECT l.id, l.geometri FROM lamning l ${w.sql} LIMIT ?`, params: w.params }, [MAX_KANDIDATER + 1]);
		const ungefar = cand.length > MAX_KANDIDATER;
		const scored: Array<{ id: number; d: number; dir: string | null }> = [];
		for (const r of cand.slice(0, MAX_KANDIDATER)) {
			const d = distanceTo(center, r.geometri);
			if (!d) continue;
			if (radius !== null && d.distance > radius) continue;
			scored.push({ id: Number(r.id), d: d.distance, dir: d.dir });
		}
		scored.sort((a, b) => a.d - b.d || a.id - b.id);
		const top = scored.slice(0, antal);
		const ids = top.map((x) => x.id);
		const [rows, byggdatum] = await Promise.all([
			ids.length ? this.all(`SELECT ${HIT_COLUMNS} FROM lamning l WHERE l.id IN (SELECT value FROM json_each(?))`, [JSON.stringify(ids)]) : [],
			this.byggdatum(),
		]);
		const byId = new Map(rows.map((r) => [Number(r.id), r]));
		const areas = await this.areasFor(ids);
		const traffar: NearbyIndexPage["traffar"] = [];
		for (const x of top) {
			const r = byId.get(x.id);
			if (!r) continue;
			traffar.push({ ...this.toHit(r, areas.get(x.id), lead(str(r.beskrivning))), avstand_m: Math.round(x.d), vaderstreck: x.dir });
		}
		return { totalt: scored.length, traffar, kalla: KALLA_INDEX, byggdatum, ...(ungefar ? { totalt_ungefar: true } : {}) };
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
					values.push(
						d === "socken"
							? `coalesce(${a}.namn || CASE WHEN ${a}.lan <> '' THEN ' (' || ${a}.lan || ')' ELSE '' END, '(saknas)')`
							: `coalesce(${a}.namn, '(saknas)')`,
					);
			}
		});
		const w = where(b.conditions, extra);
		// Exakt avstånd tillämpas inte i statistiken; med `nara` räknas lämningar vars ruta skär cirkelns ruta.
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
			byggdatum: await this.byggdatum(),
		};
	}

	// ------------------------------------------------------------ uppslag

	/**
	 * Slå upp lämningsnummer, RAÄ-nummer, UUID, K-samsök-URI eller publik länk
	 * → UUID. Nycklarna i svaret är indata som de gavs; okända saknas.
	 */
	async resolveIds(ids: string[]): Promise<Map<string, string>> {
		const out = new Map<string, string>();
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
		const known = new Set(rows.map((r) => String(r.uuid)));
		for (const [input, u] of uuids) if (known.has(u)) out.set(input, u);
		for (const r of rows) {
			for (const input of ln.get(String(r.lamningsnummer)) ?? []) out.set(input, String(r.uuid));
			for (const input of raa.get(String(r.raa_sok)) ?? []) if (!out.has(input)) out.set(input, String(r.uuid));
		}
		return out;
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

/** Avstånd och väderstreck från `p` (SWEREF) till geometrin (GeoJSON i WGS 84). */
function distanceTo(p: Planar, geometri: unknown): { distance: number; dir: string | null } | null {
	const g = parseGeometry(geometri);
	if (!g) return null;
	const r = nearestPoint(p, wgsToSweref(g));
	if (!Number.isFinite(r.distance)) return null;
	return { distance: r.distance, dir: compassDirection(p, r.point) };
}
