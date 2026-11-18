/**
 * `hitta_plats` (SPEC 6): ortnamn → koordinat.
 *
 * 1. Indexet (D1): socknar och kommuner (mittpunkt av områdets lämningar) och
 *    namngivna lämningar (lämningens mittpunkt).
 * 2. OpenStreetMap Nominatim, begränsat till Sverige, när indexet inte ger
 *    något, när en träff är en socken eller kommun (dess punkt är en
 *    tyngdpunkt, inte orten) eller när namnet inte är exakt en namngiven
 *    lämning (behoverOrt). Det är alltså de flesta frågor som inte gäller en
 *    namngiven lämning. Användningsvillkoren (operations.osmfoundation.org/
 *    policies/nominatim, läst 2026-11-18: högst 1 anrop/s summerat över alla
 *    användare av tjänsten, cache, identifierande User-Agent, inget
 *    autocomplete; klienter som upprepar samma fråga kan spärras) följs så här:
 *    - högst ett anrop per sekund: anropen köas per isolat med minst 1,1 s
 *      mellanrum, och tidpunkten för senaste anropet läses och skrivs i KV
 *      (`CACHE`) så att mellanrummet hålls även mellan isolat, så långt KV:s
 *      fördröjning medger,
 *    - inga omförsök: klienten har `retries: 0`,
 *    - vid 429, 403, 5xx, tidsgräns eller nätverksfel spärras tjänsten i minst
 *      10 minuter (längre om `Retry-After` säger det, högst ett dygn). Spärren
 *      ligger i KV och i isolatet, och under den frågas Nominatim inte alls;
 *      svaret säger då att OpenStreetMap inte frågades,
 *    - identifierande User-Agent: projektets userAgent(CONTACT_URL),
 *    - svaren (även tomma) sparas 30 dygn i KV, så samma fråga inte skickas igen,
 *    - inget autocomplete, inga systematiska frågor: högst ett anrop per fråga,
 *    - tjänsten kan stängas av utan kodändring: `NOMINATIM="av"`,
 *    - attribution (© OpenStreetMap-bidragsgivare, ODbL) i svaret.
 *
 * Ort och område (socken/kommun) med samma namn paras bara ihop när de
 * rimligen är samma plats (sammaPlats); annars visas de som skilda kandidater
 * utan rekommendation. OpenStreetMap-träffar utanför angivet län eller kommun
 * tas bort.
 *
 * Registreras inte här; se registerHittaPlats och createHittaPlatsDeps.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { strikt } from "./schema";
import type { KvLike } from "../cache/kv";
import { publicUrl, userAgent } from "../config";
import { ToolInputError, UpstreamError } from "../errors";
import { isInSweden, round, toPlanar } from "../geo/sweref";
import { findLan, normalizeName } from "../lookup/names";
import type { D1Like } from "../store/d1";
import { buildFtsQuery } from "../store/fts";
import { checkAllowed } from "../upstream/allowlist";
import { type FetchLike, Semaphore, SemaphoreTimeoutError, UpstreamClient } from "../upstream/client";
import { READ_ONLY, citat, kallrad, ok, rad, runTool } from "./common";

export const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
export const NOMINATIM_TTL_S = 30 * 24 * 60 * 60;
export const NOMINATIM_MIN_MELLANRUM_MS = 1100;
/** Spärr efter fel hos Nominatim (429, 403, 5xx, tidsgräns, nätverksfel). */
export const NOMINATIM_SPARR_MS = 10 * 60_000;
/** Längsta spärr, även om `Retry-After` begär mer. */
export const NOMINATIM_SPARR_MAX_MS = 24 * 60 * 60_000;
export const NOMINATIM_SPARR_KEY = "nominatim:sparr:v1";
export const NOMINATIM_SENASTE_KEY = "nominatim:senaste:v1";
/**
 * Ort och socken räknas som samma plats när orten ligger inom områdets
 * utbredning (de registrerade lämningarnas ytterpunkter) med denna marginal.
 * En socken i södra och mellersta Sverige är 5–20 km över, kyrkbyn ligger inne
 * i socknen och lämningarnas utbredning täcker oftast nästan hela socknen; 5 km
 * räcker för en by i kanten av den. Stora norrlandssocknar har stor utbredning
 * och ryms därför av samma regel.
 */
export const SAMMA_PLATS_MARGINAL_KM = 5;
/** Utan känd utbredning: största avstånd mellan ort och områdets mittpunkt. */
export const SAMMA_PLATS_MAX_KM = 15;
export const NOMINATIM_ATTRIBUTION =
	"© OpenStreetMap-bidragsgivare, ODbL 1.0 (https://osm.org/copyright)";
const MAX_KANDIDATER = 10;

export interface HittaPlatsDeps {
	/** Indexet. Saknas det går frågan direkt till Nominatim. */
	db?: D1Like;
	/** KV för Nominatim-svar (30 dygn). */
	kv?: KvLike;
	/** Klient för Nominatim (allowlist, tidsgräns, User-Agent). */
	client: UpstreamClient;
	/** false = Nominatim avstängt (inställningen NOMINATIM="av"). */
	nominatim: boolean;
	/** Hur färskt indexet är (samma text som `hamtad_fran` i övriga verktyg), om det går att avgöra. */
	indexHamtadFran?: () => Promise<string | null>;
	/** Väntan (för test). */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

export function createHittaPlatsDeps(opts: {
	db?: D1Like;
	kv?: KvLike;
	contactUrl?: string | null;
	/** Värdet av inställningen `NOMINATIM`; "av" stänger av tjänsten. */
	nominatim?: string | null;
	fetch?: FetchLike;
	indexHamtadFran?: () => Promise<string | null>;
}): HittaPlatsDeps {
	return {
		db: opts.db,
		kv: opts.kv,
		...(opts.indexHamtadFran ? { indexHamtadFran: opts.indexHamtadFran } : {}),
		client: new UpstreamClient({
			userAgent: userAgent(opts.contactUrl),
			maxConcurrent: 1,
			// Inga omförsök mot Nominatim: fel leder i stället till en spärr (se överst).
			retries: 0,
			...(opts.fetch ? { fetch: opts.fetch } : {}),
		}),
		nominatim: (opts.nominatim ?? "").trim().toLowerCase() !== "av",
	};
}

// ---------------------------------------------------------------- schema

export const hittaPlatsInput = strikt("hitta_plats", {
	namn: z
		.string()
		.min(1)
		.max(100)
		.describe(
			'Ortnamn, sockennamn, kommun eller lämningens namn, t.ex. "Bjursås", "Falu gruva", "Trollkällan".',
		),
	kommun: z.string().min(1).max(100).optional().describe("Begränsa till en kommun."),
	lan: z
		.string()
		.min(1)
		.max(100)
		.optional()
		.describe('Begränsa till ett län, t.ex. "Dalarna" eller "Dalarnas län".'),
});

/**
 * Vilken sorts punkt koordinaten är. Ägarens test i claude.ai: "Bjursås" gav
 * mittpunkten av socknens 375 lämningar, flera kilometer från kyrkbyn, och
 * nästa steg mätte avstånd från den. Därför står punktens sort i varje kandidat.
 */
export const PUNKTTYPER = ["omradets_lamningar", "ort", "namngiven_lamning", "plats"] as const;

const kandidat = z.object({
	namn: z.string(),
	typ: z.string(),
	/** omradets_lamningar: mittpunkt för områdets registrerade lämningar; ort: ort enligt OpenStreetMap; namngiven_lamning; plats: annan plats i OpenStreetMap. */
	punkttyp: z.enum(PUNKTTYPER),
	/** Punktens sort i klartext, t.ex. "mittpunkt för socknens registrerade lämningar". */
	punkt: z.string(),
	kalla: z.string(),
	lat: z.number(),
	lon: z.number(),
	sweref99tm: z.object({ e: z.number(), n: z.number() }),
	kommun: z.string().nullable(),
	lan: z.string().nullable(),
	beskrivning: z.string().nullable(),
	antal_lamningar: z.number().int().nullable(),
	lamningsnummer: z.string().nullable(),
	url: z.string().nullable(),
	/** Ungefärlig utbredning i WGS 84: [minLon, minLat, maxLon, maxLat]. */
	utbredning: z.array(z.number()).nullable(),
});

export const hittaPlatsOutput = z.object({
	namn: z.string(),
	kommun: z.string().nullable(),
	lan: z.string().nullable(),
	kalla: z.enum(["index", "nominatim", "index+nominatim", "ingen"]),
	/** Frågades OpenStreetMap: ja (nu eller sparat svar), nej (behövdes inte, avstängt eller spärrat efter fel), fel. */
	openstreetmap: z.enum(["fragad", "sparat_svar", "behovdes_inte", "avstangt", "sparrad", "fel"]),
	/** Hur färskt svaret är (indexets datum, och om OpenStreetMap-svaret var sparat). */
	hamtad_fran: z.string(),
	kandidater: z.array(kandidat),
	anmarkningar: z.array(z.string()),
});

export type HittaPlatsArgs = z.infer<typeof hittaPlatsInput>;
export type Kandidat = z.infer<typeof kandidat>;

// ---------------------------------------------------------------- registrering

export const HITTA_PLATS_BESKRIVNING =
	"Ortnamn till koordinat (WGS 84, med SWEREF 99 TM i den strukturerade delen). Söker i serverns index bland socknar, kommuner och namngivna lämningar " +
	"(t.ex. källor och stenar med namn), och i OpenStreetMap Nominatim (bara Sverige) för de flesta namn: när indexet inte ger något, när träffen är en socken eller kommun, " +
	"eller när namnet inte är exakt en namngiven lämning – så att orten själv (byn, tätorten) kommer med som egen kandidat. " +
	"OpenStreetMap-träffar utanför angivet län eller kommun tas bort. En ort och en socken med samma namn paras bara ihop när de ligger i samma kommun och län och nära varandra; " +
	"annars visas de som skilda kandidater, var och en med kommun och län – fråga användaren vilken som avses när flera platser har namnet. " +
	"Efter fel hos OpenStreetMap frågas tjänsten inte på en stund; svaret säger det. " +
	"Varje kandidat säger vilken sorts punkt den är: \"mittpunkt för socknens/kommunens registrerade lämningar\" (en tyngdpunkt, ofta kilometer från kyrkbyn eller tätorten), " +
	"\"ort enligt OpenStreetMap\" eller \"namngiven lämning\". Välj ortspunkten för \"nära orten\", områdets mittpunkt bara för området som helhet. " +
	"Koordinaten kan skickas direkt till lamningar_nara. " +
	"OpenStreetMap är ojämnt för äldre platser – torp, fäbodar, gruvor och försvunna gårdar hittas bättre via TORA i Riksarkivets koppling " +
	"(om den finns); en koordinat därifrån kan skickas direkt till lamningar_nara.";

export function registerHittaPlats(server: McpServer, deps: HittaPlatsDeps): void {
	server.registerTool(
		"hitta_plats",
		{
			title: "Hitta plats",
			description: HITTA_PLATS_BESKRIVNING,
			inputSchema: hittaPlatsInput,
			outputSchema: hittaPlatsOutput,
			annotations: { ...READ_ONLY, title: "Hitta plats" },
		},
		async (args) => runTool(() => hittaPlats(args, deps)),
	);
}

// ---------------------------------------------------------------- hjälp

type Row = Record<string, unknown>;
const str = (x: unknown): string | null => (typeof x === "string" && x.length ? x : null);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

function norm(s: string): string {
	return s.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Stavningsvarianter för exakt jämförelse (SQLite:s lower() viker bara ASCII). */
export function namnvarianter(s: string): string[] {
	const t = norm(s);
	const lower = t.toLocaleLowerCase("sv");
	const cap = (w: string) => (w ? w[0].toLocaleUpperCase("sv") + w.slice(1) : w);
	const out = new Set<string>([
		t,
		lower,
		cap(lower),
		lower
			.split(/([ -])/)
			.map(cap)
			.join(""),
		cap(t),
	]);
	return [...out].filter(Boolean);
}

function geo(lat: number, lon: number) {
	const p = toPlanar({ lat, lon });
	return {
		lat: round(lat, 6),
		lon: round(lon, 6),
		sweref99tm: { e: round(p.e, 0), n: round(p.n, 0) },
	};
}

async function rows<T = Row>(db: D1Like, sql: string, ...params: unknown[]): Promise<T[]> {
	const s = db.prepare(sql);
	return ((await (params.length ? s.bind(...params) : s).all<T>()).results ?? []) as T[];
}

// ---------------------------------------------------------------- indexet

/** Fel i indexdelen av hitta_plats, med vilken fråga som fallerade och hur lång tid den tog. */
export class PlatsIndexError extends Error {
	readonly steg: string;
	readonly ms: number;
	constructor(message: string, steg: string, ms: number, options?: { cause?: unknown }) {
		super(message);
		this.name = "PlatsIndexError";
		this.steg = steg;
		this.ms = ms;
		if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
	}
}

async function steg<T>(namn: string, fn: () => Promise<T>): Promise<T> {
	const t0 = Date.now();
	try {
		return await fn();
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		const hint = /no such table: omrade_(sammanfattning|relation)/.test(msg) ? " (migreringen 0003_omraden.sql är inte körd)" : "";
		throw new PlatsIndexError(`${namn}: ${msg}${hint}`, namn, Date.now() - t0, { cause: e });
	}
}

/**
 * Kandidater ur indexet. Tre små frågor, alla indexdrivna:
 * 1. Socknar och kommuner med namnet: omrade (unikt index på niva, namn) och
 *    den förberäknade sammanfattningen (migrations/0003_omraden.sql).
 * 2. Kommun och län för dem: omrade_relation.
 * 3. Namngivna lämningar: FTS5 med kolumnfiltret namn som yttre loop; exakt
 *    namn först. Avgränsning till kommun/län prövas per kandidat (EXISTS).
 */
export async function sokIndex(
	db: D1Like,
	namn: string,
	kommun: string | null,
	lan: string | null,
): Promise<Kandidat[]> {
	const varianter = JSON.stringify(namnvarianter(namn));
	const kommunV = kommun ? JSON.stringify(namnvarianter(kommun)) : null;
	const lanV = lan ? JSON.stringify([lan]) : null;

	// 1. Socknar och kommuner. Avgränsning: kommunen själv, eller ett överordnat område med namnet.
	const avgr: string[] = [];
	const avgrParams: unknown[] = [];
	for (const [niva, v] of [
		["kommun", kommunV],
		["lan", lanV],
	] as const) {
		if (!v) continue;
		avgr.push(
			`(${niva === "kommun" ? "(o.niva = 'kommun' AND o.namn IN (SELECT value FROM json_each(?))) OR " : ""}EXISTS (SELECT 1 FROM omrade_relation r JOIN omrade o2 ON o2.id = r.overordnad_id WHERE r.omrade_id = o.id AND o2.niva = '${niva}' AND o2.namn IN (SELECT value FROM json_each(?))))`,
		);
		if (niva === "kommun") avgrParams.push(v);
		avgrParams.push(v);
	}
	const omr = await steg("socknar och kommuner", () =>
		rows(
			db,
			`SELECT o.id, o.niva, o.namn, o.lan, s.med_lage AS n, s.lat, s.lon, s.min_lat, s.max_lat, s.min_lon, s.max_lon
			   FROM omrade o JOIN omrade_sammanfattning s ON s.omrade_id = o.id
			  WHERE o.niva IN ('socken', 'kommun') AND o.namn IN (SELECT value FROM json_each(?)) AND s.med_lage > 0${avgr.length ? ` AND ${avgr.join(" AND ")}` : ""}
			  ORDER BY CASE o.niva WHEN 'kommun' THEN 0 ELSE 1 END, s.med_lage DESC LIMIT ?`,
			varianter,
			...avgrParams,
			MAX_KANDIDATER,
		),
	);

	// 2. Kommun och län där områdets lämningar oftast ligger.
	const ctx = new Map<number, { kommun: string | null; lan: string | null }>();
	if (omr.length) {
		const c = await steg("överordnade områden", () =>
			rows(
				db,
				`SELECT r.omrade_id AS oid, o2.niva, o2.namn FROM omrade_relation r JOIN omrade o2 ON o2.id = r.overordnad_id
				  WHERE r.omrade_id IN (SELECT value FROM json_each(?)) ORDER BY r.antal DESC, o2.namn`,
				JSON.stringify(omr.map((o) => o.id)),
			),
		);
		for (const r of c) {
			const oid = Number(r.oid);
			const e = ctx.get(oid) ?? { kommun: null, lan: null };
			if (r.niva === "kommun" && !e.kommun) e.kommun = str(r.namn);
			if (r.niva === "lan" && !e.lan) e.lan = str(r.namn);
			ctx.set(oid, e);
		}
	}
	const out: Kandidat[] = [];
	for (const o of omr) {
		const lat = num(o.lat);
		const lon = num(o.lon);
		if (lat === null || lon === null) continue;
		const c = ctx.get(Number(o.id)) ?? { kommun: null, lan: null };
		const niva = o.niva === "kommun" ? "kommun" : "socken";
		const n = Number(o.n);
		out.push({
			namn: String(o.namn),
			typ: niva,
			punkttyp: "omradets_lamningar",
			punkt: `mittpunkt för ${niva === "kommun" ? "kommunens" : "socknens"} registrerade lämningar`,
			kalla: "Lämningsindex (D1)",
			...geo(lat, lon),
			kommun: niva === "kommun" ? String(o.namn) : c.kommun,
			lan: str(o.lan) || c.lan,
			beskrivning: `${niva === "kommun" ? "Kommun" : "Socken"}; koordinaten är mittpunkten av ${n} lämningar i registret, inte en officiell ortspunkt.`,
			antal_lamningar: n,
			lamningsnummer: null,
			url: null,
			utbredning: [num(o.min_lon), num(o.min_lat), num(o.max_lon), num(o.max_lat)].every((x) => x !== null)
				? [round(o.min_lon as number, 5), round(o.min_lat as number, 5), round(o.max_lon as number, 5), round(o.max_lat as number, 5)]
				: null,
		});
	}

	// 3. Namngivna lämningar: exakt namn först, sedan ordträff i namnet.
	const fts = buildFtsQuery(namn);
	if (out.length < MAX_KANDIDATER && fts) {
		const lamAvgr: string[] = [];
		const lamParams: unknown[] = [];
		for (const [niva, v] of [
			["kommun", kommunV],
			["lan", lanV],
		] as const) {
			if (!v) continue;
			lamAvgr.push(
				`EXISTS (SELECT 1 FROM lamning_omrade lo2 JOIN omrade o2 ON o2.id = lo2.omrade_id WHERE lo2.lamning_id = l.id AND o2.niva = '${niva}' AND o2.namn IN (SELECT value FROM json_each(?)))`,
			);
			lamParams.push(v);
		}
		// CROSS JOIN: FTS-tabellen är yttre loop (bara lämningar med orden i namnet prövas).
		const lamningar = await steg("namngivna lämningar", () =>
			rows(
				db,
				`SELECT l.id, l.uuid, l.lamningsnummer, l.lamningstyp, l.namn, l.lat, l.lon,
				        CASE WHEN l.namn IN (SELECT value FROM json_each(?)) THEN 0 ELSE 1 END AS exakt,
				        (SELECT o.namn FROM lamning_omrade lo JOIN omrade o ON o.id = lo.omrade_id WHERE lo.lamning_id = l.id AND o.niva = 'kommun' LIMIT 1) AS kommun,
				        (SELECT o.namn FROM lamning_omrade lo JOIN omrade o ON o.id = lo.omrade_id WHERE lo.lamning_id = l.id AND o.niva = 'lan' LIMIT 1) AS lan
				   FROM lamning_fts f CROSS JOIN lamning l ON l.id = f.rowid
				  WHERE f.lamning_fts MATCH ? AND l.lat IS NOT NULL AND l.namn IS NOT NULL${lamAvgr.length ? ` AND ${lamAvgr.join(" AND ")}` : ""}
				  ORDER BY exakt, l.id LIMIT ?`,
				varianter,
				`namn : (${fts.match})`,
				...lamParams,
				MAX_KANDIDATER - out.length,
			),
		);
		for (const l of lamningar) {
			const lat = num(l.lat);
			const lon = num(l.lon);
			const uuid = str(l.uuid);
			if (lat === null || lon === null || !uuid) continue;
			out.push({
				namn: String(l.namn),
				typ: `lämning (${str(l.lamningstyp) ?? "okänd typ"})`,
				punkttyp: "namngiven_lamning",
				punkt: Number(l.exakt) === 0 ? "namngiven lämning (lämningens mittpunkt)" : "lämning vars namn innehåller sökorden (lämningens mittpunkt)",
				kalla: "Lämningsindex (D1)",
				...geo(lat, lon),
				kommun: str(l.kommun),
				lan: str(l.lan),
				beskrivning: Number(l.exakt) === 0 ? "Lämning med namnet i registret." : "Lämning vars namn innehåller sökorden.",
				antal_lamningar: null,
				lamningsnummer: str(l.lamningsnummer),
				url: publicUrl(uuid),
				utbredning: null,
			});
		}
	}
	return out;
}

// ---------------------------------------------------------------- Nominatim

/**
 * Nominatim-anropen i isolatet: högst ett åt gången (Semaphore, samma mönster
 * som uppströmsklienten: ingen överlämning mellan förfrågningar, tidsgräns på
 * väntan, en plats som hållits för länge återtas), och minst 1,1 s mellan
 * anropen. Tidigare väntade varje anrop på ett löfte som föregående förfrågan
 * löste i sin `finally`; avbröts den kunde alla senare anrop vänta för alltid.
 */
let ko = new Semaphore(1, { maxHoldMs: 20_000, maxWaitMs: 15_000, pollMs: 50 });
let senasteAnrop = 0;

/** Senaste Nominatim-anropet enligt KV (från vilket isolat som helst), eller 0. */
async function senasteIKv(deps: HittaPlatsDeps): Promise<number> {
	if (!deps.kv) return 0;
	try {
		const v = await deps.kv.get(NOMINATIM_SENASTE_KEY, "json");
		return typeof v === "number" && Number.isFinite(v) ? v : 0;
	} catch {
		return 0;
	}
}

/**
 * Kör `fn` tidigast 1,1 s efter föregående Nominatim-anrop, i isolatet och
 * (via KV) i andra isolat. Tidpunkten skrivs till KV före anropet.
 */
async function iTur<T>(deps: HittaPlatsDeps, fn: () => Promise<T>): Promise<T> {
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = deps.now ?? Date.now;
	try {
		return await ko.run(async () => {
			const senast = Math.max(senasteAnrop, await senasteIKv(deps));
			const vanta = senast + NOMINATIM_MIN_MELLANRUM_MS - now();
			if (vanta > 0) await sleep(Math.min(vanta, NOMINATIM_MIN_MELLANRUM_MS));
			senasteAnrop = now();
			if (deps.kv) {
				try {
					await deps.kv.put(NOMINATIM_SENASTE_KEY, JSON.stringify(senasteAnrop), { expirationTtl: 60 });
				} catch {
					// KV tillåter en skrivning per sekund och nyckel; isolatets egen kö gäller ändå.
				}
			}
			return fn();
		});
	} catch (e) {
		if (e instanceof SemaphoreTimeoutError) throw new UpstreamError("nominatim", "OpenStreetMap Nominatim är upptaget av andra frågor just nu");
		throw e;
	}
}

/** Bara för test: nollställ kön och spärren i isolatet. */
export function aterstallNominatimKo(): void {
	ko = new Semaphore(1, { maxHoldMs: 20_000, maxWaitMs: 15_000, pollMs: 50 });
	senasteAnrop = 0;
	sparrLokal = null;
}

// ---------------------------------------------------------------- spärr efter fel

export interface NominatimSparr {
	/** Epoch-ms då spärren sattes och då den upphör. */
	fran: number;
	till: number;
	orsak: string;
}

let sparrLokal: NominatimSparr | null = null;

/** Nominatim frågades inte: tjänsten är spärrad efter ett fel. */
export class NominatimSparrError extends UpstreamError {
	constructor(readonly sparr: NominatimSparr) {
		super("nominatim", `OpenStreetMap Nominatim frågades inte: spärrad till ${klockslag(sparr.till)} efter fel (${sparr.orsak})`);
		this.name = "NominatimSparrError";
	}
}

function klockslag(ms: number): string {
	return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function arSparr(v: unknown): v is NominatimSparr {
	const x = v as NominatimSparr | null;
	return !!x && typeof x.fran === "number" && typeof x.till === "number" && typeof x.orsak === "string";
}

/** Gällande spärr (isolatets egen eller ur KV), eller null. */
export async function lasNominatimSparr(deps: HittaPlatsDeps): Promise<NominatimSparr | null> {
	const nu = (deps.now ?? Date.now)();
	if (sparrLokal && sparrLokal.till > nu) return sparrLokal;
	if (deps.kv) {
		try {
			const v = await deps.kv.get(NOMINATIM_SPARR_KEY, "json");
			if (arSparr(v) && v.till > nu) {
				sparrLokal = v;
				return v;
			}
		} catch {
			// Utan KV gäller isolatets spärr.
		}
	}
	return null;
}

/** `Retry-After` i ms (sekunder eller HTTP-datum), eller 0. */
export function retryAfterMs(h: string | null | undefined, nu: number): number {
	if (!h) return 0;
	const t = h.trim();
	if (/^\d{1,9}$/.test(t)) return Number(t) * 1000;
	const d = Date.parse(t);
	return Number.isFinite(d) ? Math.max(0, d - nu) : 0;
}

async function sattNominatimSparr(deps: HittaPlatsDeps, orsak: string, retryAfter: string | null | undefined): Promise<NominatimSparr> {
	const nu = (deps.now ?? Date.now)();
	const ms = Math.min(NOMINATIM_SPARR_MAX_MS, Math.max(NOMINATIM_SPARR_MS, retryAfterMs(retryAfter, nu)));
	const sp: NominatimSparr = { fran: nu, till: nu + ms, orsak };
	sparrLokal = sp;
	console.warn(`hitta_plats: OpenStreetMap Nominatim spärras till ${klockslag(sp.till)} (${orsak})`);
	if (deps.kv) {
		try {
			await deps.kv.put(NOMINATIM_SPARR_KEY, JSON.stringify(sp), { expirationTtl: Math.max(60, Math.ceil(ms / 1000)) });
		} catch (e) {
			console.warn("hitta_plats: spärren kunde inte skrivas till KV:", e instanceof Error ? e.message : String(e));
		}
	}
	return sp;
}

/** Bara för test: kön med egna gränser. */
export function sattNominatimKo(opts: { maxHoldMs?: number; maxWaitMs?: number; pollMs?: number }): void {
	ko = new Semaphore(1, opts);
	senasteAnrop = 0;
}

interface NominatimTraff {
	name?: string;
	display_name?: string;
	lat?: string;
	lon?: string;
	category?: string;
	type?: string;
	addresstype?: string;
	address?: Record<string, string>;
	boundingbox?: string[];
}

export function nominatimFraga(namn: string, kommun: string | null, lan: string | null): string {
	const parts = [norm(namn)];
	if (kommun) parts.push(norm(kommun));
	if (lan) parts.push(findLan(lan)?.fullt ?? norm(lan));
	return parts.join(", ").slice(0, 200);
}

/** [minLon, minLat, maxLon, maxLat] → Nominatims viewbox ("x1,y1,x2,y2"). */
export function viewbox(bb: readonly number[] | null | undefined): string | null {
	if (!bb || bb.length !== 4 || !bb.every(Number.isFinite)) return null;
	const m = 0.05;
	return [bb[0] - m, bb[1] - m, bb[2] + m, bb[3] + m].map((x) => x.toFixed(4)).join(",");
}

export function nominatimUrl(q: string, vb?: string | null): string {
	const u = new URL(NOMINATIM_URL);
	u.searchParams.set("q", q);
	u.searchParams.set("countrycodes", "se");
	u.searchParams.set("format", "jsonv2");
	u.searchParams.set("limit", "5");
	u.searchParams.set("addressdetails", "1");
	u.searchParams.set("accept-language", "sv");
	if (vb) u.searchParams.set("viewbox", vb);
	return u.href;
}

async function cacheKey(q: string, vb: string | null): Promise<string> {
	const b = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`${q.toLocaleLowerCase("sv")}|${vb ?? ""}`),
	);
	return `nominatim:v2:${[...new Uint8Array(b)]
		.map((x) => x.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 40)}`;
}

/** Hämta (eller läs ur KV) Nominatims svar. Returnerar { traffar, cachad }. */
export async function nominatim(
	deps: HittaPlatsDeps,
	q: string,
	vb: string | null = null,
): Promise<{ traffar: NominatimTraff[]; cachad: boolean }> {
	const key = await cacheKey(q, vb);
	if (deps.kv) {
		try {
			const hit = await deps.kv.get(key, "json");
			if (Array.isArray(hit)) return { traffar: hit as NominatimTraff[], cachad: true };
		} catch (e) {
			console.warn(
				"hitta_plats: KV-läsning misslyckades:",
				e instanceof Error ? e.message : String(e),
			);
		}
	}
	const sparr = await lasNominatimSparr(deps);
	if (sparr) throw new NominatimSparrError(sparr);
	const url = nominatimUrl(q, vb);
	const source = checkAllowed("GET", url).source;
	const r = await iTur(deps, async () => {
		try {
			return await deps.client.get(url);
		} catch (e) {
			// Tidsgräns eller nätverksfel (klienten gör inget omförsök): spärra.
			if (e instanceof UpstreamError) {
				const sp = await sattNominatimSparr(deps, e.message, null);
				throw new UpstreamError(source, `${e.message}; nästa fråga dit tidigast ${klockslag(sp.till)}`, e.status);
			}
			throw e;
		}
	});
	if (r.status === 429 || r.status === 403 || r.status >= 500) {
		const sp = await sattNominatimSparr(deps, `svarade ${r.status}`, r.retryAfter);
		throw new UpstreamError(source, `OpenStreetMap Nominatim svarade ${r.status}; nästa fråga dit tidigast ${klockslag(sp.till)}`, r.status);
	}
	if (r.status >= 400)
		throw new UpstreamError(source, `OpenStreetMap Nominatim svarade ${r.status}`, r.status);
	let data: unknown;
	try {
		data = JSON.parse(r.body);
	} catch {
		throw new UpstreamError(source, "OpenStreetMap Nominatim svarade inte med JSON", r.status);
	}
	if (!Array.isArray(data))
		throw new UpstreamError(
			source,
			"OpenStreetMap Nominatim svarade med oväntad form",
			r.status,
		);
	// Spara bara de fält som används.
	const traffar: NominatimTraff[] = (data as NominatimTraff[]).slice(0, 10).map((t) => ({
		name: t.name,
		display_name: t.display_name,
		lat: t.lat,
		lon: t.lon,
		category: t.category,
		type: t.type,
		addresstype: t.addresstype,
		address: t.address,
		boundingbox: t.boundingbox,
	}));
	if (deps.kv) {
		try {
			await deps.kv.put(key, JSON.stringify(traffar), { expirationTtl: NOMINATIM_TTL_S });
		} catch (e) {
			console.warn(
				"hitta_plats: KV-skrivning misslyckades:",
				e instanceof Error ? e.message : String(e),
			);
		}
	}
	return { traffar, cachad: false };
}

/** Bebyggelse i OpenStreetMap (place=city/town/village/hamlet …): "orten". */
const ORTSTYPER = new Set(["city", "town", "village", "hamlet", "isolated_dwelling", "farm", "locality", "suburb", "quarter", "neighbourhood", "borough"]);
function arOrt(t: NominatimTraff): boolean {
	return t.category === "place" && ORTSTYPER.has(t.type ?? "");
}

export function nominatimKandidater(traffar: NominatimTraff[]): Kandidat[] {
	const out: Kandidat[] = [];
	for (const t of traffar) {
		const lat = Number(t.lat);
		const lon = Number(t.lon);
		if (!Number.isFinite(lat) || !Number.isFinite(lon) || !isInSweden({ lat, lon })) continue;
		const a = t.address ?? {};
		const bb = (t.boundingbox ?? []).map(Number);
		const ort = arOrt(t);
		out.push({
			namn: t.name || t.display_name || "(namnlös)",
			typ: [t.category, t.type].filter(Boolean).join("/") || t.addresstype || "plats",
			punkttyp: ort ? "ort" : "plats",
			punkt: ort ? "ort enligt OpenStreetMap" : "plats enligt OpenStreetMap",
			kalla: "OpenStreetMap Nominatim",
			...geo(lat, lon),
			// Nominatim ger kommunen i genitiv ("Falu kommun"); den lämnas som den är.
			kommun: a.municipality ?? null,
			lan: a.county ? (findLan(a.county)?.namn ?? a.county) : null,
			beskrivning: t.display_name ?? null,
			antal_lamningar: null,
			lamningsnummer: null,
			url: null,
			// Nominatim: [minLat, maxLat, minLon, maxLon] → [minLon, minLat, maxLon, maxLat].
			utbredning:
				bb.length === 4 && bb.every(Number.isFinite)
					? [bb[2], bb[0], bb[3], bb[1]].map((x) => round(x, 5))
					: null,
		});
	}
	return out;
}

// ---------------------------------------------------------------- verktyget

/**
 * Ska OpenStreetMap också frågas? Ja när indexet inte gav något, när någon
 * träff är ett område (socken eller kommun: dess punkt är en tyngdpunkt, inte
 * orten), och när ingen träff är en lämning med exakt det namnet (då kan
 * frågan avse en ort). Bara när namnet är exakt en namngiven lämning räcker indexet.
 */
export function behoverOrt(namn: string, kandidater: readonly Kandidat[]): boolean {
	if (kandidater.length === 0) return true;
	if (kandidater.some((k) => k.punkttyp === "omradets_lamningar")) return true;
	const v = new Set(namnvarianter(namn));
	return !kandidater.some((k) => k.punkttyp === "namngiven_lamning" && v.has(k.namn));
}

/**
 * Samma kommun? Nominatim ger kommunen som "Falu kommun", "Munkedals kommun",
 * "Göteborgs Stad"; indexet som "Falun", "Munkedal", "Göteborg". Jämför utan
 * "kommun"/"stad" och med genitiv-s eller Falu/Falun-formen.
 */
export function kommunLika(a: string | null, b: string | null): boolean {
	if (!a || !b) return false;
	const f = (x: string) => normalizeName(x).replace(/\s+(kommun|stad)$/, "");
	const x = f(a);
	const y = f(b);
	return x === y || x === `${y}s` || y === `${x}s` || x === `${y}n` || y === `${x}n`;
}

/**
 * Är orten (OpenStreetMap) rimligen samma plats som området (socken eller
 * kommun ur indexet)? Kräver samma län och kommun när båda är kända, och att
 * orten ligger inom områdets utbredning med SAMMA_PLATS_MARGINAL_KM marginal
 * (utan utbredning: högst SAMMA_PLATS_MAX_KM från mittpunkten).
 */
export function sammaPlats(ort: Kandidat, omr: Kandidat): boolean {
	if (ort.lan && omr.lan && ort.lan !== omr.lan) return false;
	if (ort.kommun && omr.kommun && !kommunLika(ort.kommun, omr.kommun)) return false;
	const bb = omr.utbredning;
	if (bb && bb.length === 4) {
		const dLat = SAMMA_PLATS_MARGINAL_KM / 111.2;
		const dLon = SAMMA_PLATS_MARGINAL_KM / (111.2 * Math.cos((ort.lat * Math.PI) / 180));
		return ort.lon >= bb[0] - dLon && ort.lon <= bb[2] + dLon && ort.lat >= bb[1] - dLat && ort.lat <= bb[3] + dLat;
	}
	return km(ort, omr) <= SAMMA_PLATS_MAX_KM;
}

/** "Mo (Munkedals kommun, Västra Götalands län)". */
function medOmrade(k: Kandidat): string {
	const delar = [
		k.kommun ? (/(kommun|stad)$/i.test(k.kommun) ? k.kommun : `${k.kommun} kommun`) : null,
		k.lan ? (findLan(k.lan)?.fullt ?? k.lan) : null,
	].filter(Boolean);
	return delar.length ? `${k.namn} (${delar.join(", ")})` : `${k.namn} (kommun och län okända)`;
}

function km(a: Kandidat, b: Kandidat): number {
	return Math.hypot(a.sweref99tm.e - b.sweref99tm.e, a.sweref99tm.n - b.sweref99tm.n) / 1000;
}

function fmtKm(x: number): string {
	return x < 10 ? x.toFixed(1).replace(".", ",") : String(Math.round(x));
}

export async function hittaPlats(args: HittaPlatsArgs, deps: HittaPlatsDeps) {
	const namn = norm(args.namn);
	if (!namn) throw new ToolInputError("Ange ett namn.");
	const kommun = args.kommun ? norm(args.kommun).replace(/\s+kommun$/i, "") || null : null;
	let lan: string | null = null;
	if (args.lan) {
		const hit = findLan(args.lan);
		if (!hit)
			throw new ToolInputError(
				`Okänt län: "${args.lan}". Ange t.ex. "Dalarna" eller "Dalarnas län".`,
			);
		lan = hit.namn;
	}
	const anmarkningar: string[] = [];
	let franIndex: Kandidat[] = [];
	let franOsm: Kandidat[] = [];
	let indexSvarade = false;
	let osm: "ej" | "nu" | "sparat" | "fel" | "sparr" = "ej";

	if (deps.db) {
		try {
			franIndex = await sokIndex(deps.db, namn, kommun, lan);
			indexSvarade = true;
		} catch (e) {
			// Loggas som fel (syns i wrangler tail och Workers-loggarna), med steg och tid.
			console.error(
				JSON.stringify({
					hitta_plats: "indexfrågan misslyckades",
					namn,
					steg: e instanceof PlatsIndexError ? e.steg : null,
					ms: e instanceof PlatsIndexError ? e.ms : null,
					fel: e instanceof Error ? e.message : String(e),
				}),
			);
			anmarkningar.push("Indexet svarade inte; sökte i OpenStreetMap i stället.");
		}
	} else anmarkningar.push("Indexet är inte inkopplat; sökte i OpenStreetMap.");

	const omraden = franIndex.filter((k) => k.punkttyp === "omradets_lamningar");
	const omrade = omraden[0] ?? null;
	let osmLage: "fragad" | "sparat_svar" | "behovdes_inte" | "avstangt" | "sparrad" | "fel" = "behovdes_inte";
	if (behoverOrt(namn, franIndex)) {
		if (!deps.nominatim) {
			osmLage = "avstangt";
			anmarkningar.push(
				omrade
					? `Uppslag i OpenStreetMap Nominatim är avstängt på den här servern, så orten ${namn} finns inte med som egen punkt. ${omrade.typ === "kommun" ? "Kommunens" : "Socknens"} punkt är mittpunkten för dess registrerade lämningar, inte orten.`
					: "Uppslag i OpenStreetMap Nominatim är avstängt på den här servern.",
			);
		} else {
			try {
				// Ett enda område i indexet: dess utbredning skickas som föredraget område (viewbox,
				// utan bounded), så att orten där får företräde utan att andra orter utesluts.
				const vb = omraden.length === 1 ? viewbox(omraden[0].utbredning) : null;
				const { traffar, cachad } = await nominatim(deps, nominatimFraga(namn, kommun, lan), vb);
				osm = cachad ? "sparat" : "nu";
				osmLage = cachad ? "sparat_svar" : "fragad";
				const alla = nominatimKandidater(traffar);
				// Bara träffar i angivet län och kommun (Nominatims fritext begränsar inte strikt).
				franOsm = alla.filter((k) => (!lan || k.lan === lan) && (!kommun || kommunLika(k.kommun, kommun)));
				const bort = alla.length - franOsm.length;
				if (bort)
					anmarkningar.push(`${bort} ${bort === 1 ? "träff" : "träffar"} i OpenStreetMap utanför ${[kommun ? `${kommun} kommun` : null, lan ? (findLan(lan)?.fullt ?? lan) : null].filter(Boolean).join(", ")} (eller utan känd kommun/län) togs bort.`);
				if (franOsm.length) anmarkningar.push(`OpenStreetMap Nominatim${cachad ? " (sparat svar)" : ""}: ${NOMINATIM_ATTRIBUTION}.`);
			} catch (e) {
				if (!(e instanceof UpstreamError)) throw e;
				const inteOrten = omrade ? ` Orten finns därför inte med som egen punkt; ${omrade.typ === "kommun" ? "kommunens" : "socknens"} punkt är mittpunkten för dess registrerade lämningar, inte orten.` : "";
				if (e instanceof NominatimSparrError) {
					osm = "sparr";
					osmLage = "sparrad";
					anmarkningar.push(`OpenStreetMap Nominatim frågades inte: efter ett fel (${e.sparr.orsak}) ${klockslag(e.sparr.fran)} görs inga frågor dit förrän ${klockslag(e.sparr.till)}.${inteOrten}`);
				} else {
					osm = "fel";
					osmLage = "fel";
					anmarkningar.push(`OpenStreetMap Nominatim gick inte att nå (${e.message}).${inteOrten}`);
				}
			}
		}
	}

	// Ort och område paras bara ihop när de rimligen är samma plats.
	const orter = franOsm.filter((k) => k.punkttyp === "ort");
	const ovriga = franOsm.filter((k) => k.punkttyp !== "ort");
	const par = orter.map((o) => ({ o, omr: omraden.find((a) => sammaPlats(o, a)) ?? null }));
	const parade = par.filter((p) => p.omr).map((p) => p.o);
	const oparade = par.filter((p) => !p.omr).map((p) => p.o);
	// Ordning: orter som hör till ett område (eller alla orter när indexet inte har något
	// område) först, sedan indexets träffar, sedan orter som inte hör till något område, sist
	// övriga platser i OpenStreetMap.
	const kandidater = (omraden.length ? [...parade, ...franIndex, ...oparade, ...ovriga] : [...orter, ...franIndex, ...ovriga]).slice(0, MAX_KANDIDATER);
	const harIndex = kandidater.some((k) => k.kalla !== "OpenStreetMap Nominatim");
	const harOsm = kandidater.some((k) => k.kalla === "OpenStreetMap Nominatim");
	const kalla: "index" | "nominatim" | "index+nominatim" | "ingen" = harIndex && harOsm ? "index+nominatim" : harIndex ? "index" : harOsm ? "nominatim" : "ingen";

	const forsta = par.find((p) => p.omr && kandidater.includes(p.o));
	if (forsta?.omr) {
		const o = forsta.omr;
		anmarkningar.unshift(
			`Orten ${forsta.o.namn} enligt OpenStreetMap ligger ${fmtKm(km(forsta.o, o))} km från mittpunkten för ${o.typ === "kommun" ? "kommunens" : "socknens"} registrerade lämningar (samma kommun och län). Använd ortspunkten för "nära ${namn}"; områdets mittpunkt bara för området som helhet (radien behöver då täcka utbredningen).`,
		);
	}
	const visadeOparade = oparade.filter((k) => kandidater.includes(k));
	if (omraden.length && visadeOparade.length) {
		anmarkningar.push(
			`${visadeOparade.map(medOmrade).join("; ")} enligt OpenStreetMap är inte samma plats som ${omraden.map((a) => `${a.typ === "kommun" ? "kommunen" : "socknen"} ${medOmrade(a)}`).join(" eller ")} i indexet (annan kommun eller annat län, eller för långt bort). De visas som skilda kandidater; ingen av dem rekommenderas.`,
		);
	}
	// Flera platser med samma namn: modellen ska fråga användaren. En ort som hör till
	// ett område räknas som samma plats som området.
	const varianter = new Set(namnvarianter(namn));
	const platser = kandidater.filter(
		(k) => varianter.has(k.namn) && (k.punkttyp === "omradets_lamningar" || (k.punkttyp === "ort" && !parade.includes(k))),
	);
	if (platser.length > 1) {
		anmarkningar.push(`Flera platser heter ${namn}: ${platser.map((k) => `${medOmrade(k)}, ${k.punkttyp === "ort" ? "ort" : k.typ}`).join("; ")}. Fråga användaren vilken som avses om sammanhanget inte avgör det.`);
	}
	if (!kandidater.length) {
		anmarkningar.push(
			"Ingen träff. För äldre platser (torp, fäbodar, gruvor, försvunna gårdar): pröva TORA i Riksarkivets koppling och skicka koordinaten till lamningar_nara. Pröva också annan stavning.",
		);
	}

	// Källrad: varifrån och hur färskt.
	const delar: string[] = [];
	if (harIndex || indexSvarade) {
		let ixDatum: string | null = null;
		try {
			ixDatum = deps.indexHamtadFran ? await deps.indexHamtadFran() : null;
		} catch {
			ixDatum = null;
		}
		delar.push(ixDatum ?? "index (datum okänt)");
	}
	if (osm !== "ej") delar.push(osm === "sparat" ? "OpenStreetMap sparat svar (högst 30 dygn)" : osm === "nu" ? "OpenStreetMap hämtat nu" : osm === "sparr" ? "OpenStreetMap frågades inte (spärrad efter fel)" : "OpenStreetMap svarade inte");
	const hamtad_fran = delar.join("; ") || "inget uppslag gjordes";
	const kallaText =
		kalla === "index+nominatim"
			? "serverns lämningsindex och OpenStreetMap Nominatim"
			: kalla === "index"
				? "serverns lämningsindex"
				: kalla === "nominatim"
					? "OpenStreetMap Nominatim"
					: [indexSvarade ? "serverns lämningsindex" : null, osm !== "ej" && osm !== "sparr" ? "OpenStreetMap Nominatim" : null].filter(Boolean).join(" och ") || "ingen källa kunde frågas";

	const structured = { namn, kommun, lan, kalla, openstreetmap: osmLage, hamtad_fran, kandidater, anmarkningar };
	const lines: string[] = [];
	const avgr = [kommun ? `kommun ${kommun}` : null, lan ? `län ${lan}` : null]
		.filter(Boolean)
		.join(", ");
	if (kandidater.length) {
		lines.push(`${kandidater.length} kandidat${kandidater.length === 1 ? "" : "er"} för "${namn}"${avgr ? ` (${avgr})` : ""}. Varje rad säger vilken sorts punkt koordinaten är.`);
		kandidater.forEach((k, i) => {
			const omradeText = [
				k.kommun ? (/kommun$/.test(k.kommun) ? k.kommun : `${k.kommun} kommun`) : null,
				k.lan ? (findLan(k.lan)?.fullt ?? k.lan) : null,
			]
				.filter(Boolean)
				.join(", ");
			const punkt =
				k.punkttyp === "omradets_lamningar"
					? `${k.punkt}${k.antal_lamningar ? ` (${k.antal_lamningar} ${k.antal_lamningar === 1 ? "lämning" : "lämningar"})` : ""} – inte orten`
					: k.punkttyp === "ort" || k.punkttyp === "plats"
						? `${k.punkt} (${rad(k.typ)})`
						: `${k.punkt}, ${rad(k.typ)}`;
			const extra = k.lamningsnummer ? ` ${rad(k.lamningsnummer)} ${k.url ?? ""}` : "";
			lines.push(
				`${i + 1}. ${citat(k.namn)} – ${punkt}${omradeText ? `, ${rad(omradeText)}` : ""}: ${k.lat.toFixed(5)}, ${k.lon.toFixed(5)}.${extra}`.trim(),
			);
		});
		lines.push("Koordinaten kan skickas direkt till lamningar_nara (lat, lon).");
	} else lines.push(`Ingen plats hittades för "${namn}"${avgr ? ` (${avgr})` : ""}.`);
	lines.push(kallrad(kallaText, hamtad_fran));
	for (const a of anmarkningar) lines.push(`Obs: ${rad(a)}`);
	return ok(lines.join("\n"), structured);
}
