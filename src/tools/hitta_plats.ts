/**
 * `hitta_plats` (SPEC 6): ortnamn → koordinat.
 *
 * 1. Indexet (D1): socknar och kommuner (mittpunkt av områdets lämningar) och
 *    namngivna lämningar (lämningens mittpunkt).
 * 2. Bara om indexet inte ger något: OpenStreetMap Nominatim, begränsat till
 *    Sverige. Användningsvillkoren (operations.osmfoundation.org/policies/
 *    nominatim, läst 2026-11-17) följs så här:
 *    - högst ett anrop per sekund: anropen köas per isolat med minst 1,1 s
 *      mellanrum (servern har få användare; flera isolat samtidigt är ovanligt),
 *    - identifierande User-Agent: projektets userAgent(CONTACT_URL),
 *    - svaren (även tomma) sparas 30 dygn i KV (`CACHE`), så samma fråga inte
 *      skickas igen,
 *    - inget autocomplete, inga systematiska frågor: verktyget gör ett anrop
 *      per fråga, och bara när indexet saknar svar,
 *    - tjänsten kan stängas av utan kodändring: `NOMINATIM="av"`,
 *    - attribution (© OpenStreetMap-bidragsgivare, ODbL) i svaret.
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
import { findLan } from "../lookup/names";
import type { D1Like } from "../store/d1";
import { buildFtsQuery } from "../store/fts";
import { checkAllowed } from "../upstream/allowlist";
import { type FetchLike, Semaphore, SemaphoreTimeoutError, UpstreamClient } from "../upstream/client";
import { READ_ONLY, citat, kallrad, ok, rad, runTool } from "./common";

export const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
export const NOMINATIM_TTL_S = 30 * 24 * 60 * 60;
export const NOMINATIM_MIN_MELLANRUM_MS = 1100;
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
	"(t.ex. källor och stenar med namn), och i OpenStreetMap Nominatim (bara Sverige) när indexet inte ger något, när träffen är en socken eller kommun, " +
	"eller när namnet inte är en namngiven lämning – så att orten själv (byn, tätorten) kommer med som egen kandidat. " +
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

/** Kör `fn` tidigast 1,1 s efter föregående Nominatim-anrop i isolatet. */
async function iTur<T>(deps: HittaPlatsDeps, fn: () => Promise<T>): Promise<T> {
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = deps.now ?? Date.now;
	try {
		return await ko.run(async () => {
			const vanta = senasteAnrop + NOMINATIM_MIN_MELLANRUM_MS - now();
			if (vanta > 0) await sleep(Math.min(vanta, NOMINATIM_MIN_MELLANRUM_MS));
			senasteAnrop = now();
			return fn();
		});
	} catch (e) {
		if (e instanceof SemaphoreTimeoutError) throw new UpstreamError("nominatim", "OpenStreetMap Nominatim är upptaget av andra frågor just nu");
		throw e;
	}
}

/** Bara för test: nollställ kön. */
export function aterstallNominatimKo(): void {
	ko = new Semaphore(1, { maxHoldMs: 20_000, maxWaitMs: 15_000, pollMs: 50 });
	senasteAnrop = 0;
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

export function nominatimUrl(q: string): string {
	const u = new URL(NOMINATIM_URL);
	u.searchParams.set("q", q);
	u.searchParams.set("countrycodes", "se");
	u.searchParams.set("format", "jsonv2");
	u.searchParams.set("limit", "5");
	u.searchParams.set("addressdetails", "1");
	u.searchParams.set("accept-language", "sv");
	return u.href;
}

async function cacheKey(q: string): Promise<string> {
	const b = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(q.toLocaleLowerCase("sv")),
	);
	return `nominatim:v1:${[...new Uint8Array(b)]
		.map((x) => x.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 40)}`;
}

/** Hämta (eller läs ur KV) Nominatims svar. Returnerar { traffar, cachad }. */
export async function nominatim(
	deps: HittaPlatsDeps,
	q: string,
): Promise<{ traffar: NominatimTraff[]; cachad: boolean }> {
	const key = await cacheKey(q);
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
	const url = nominatimUrl(q);
	const source = checkAllowed("GET", url).source;
	const r = await iTur(deps, () => deps.client.get(url));
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
	let osm: "ej" | "nu" | "sparat" | "fel" = "ej";

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

	const omrade = franIndex.find((k) => k.punkttyp === "omradets_lamningar") ?? null;
	if (behoverOrt(namn, franIndex)) {
		if (!deps.nominatim) {
			anmarkningar.push(
				omrade
					? `Uppslag i OpenStreetMap Nominatim är avstängt på den här servern, så orten ${namn} finns inte med som egen punkt. ${omrade.typ === "kommun" ? "Kommunens" : "Socknens"} punkt är mittpunkten för dess registrerade lämningar, inte orten.`
					: "Uppslag i OpenStreetMap Nominatim är avstängt på den här servern.",
			);
		} else {
			try {
				const { traffar, cachad } = await nominatim(deps, nominatimFraga(namn, kommun, lan));
				osm = cachad ? "sparat" : "nu";
				franOsm = nominatimKandidater(traffar);
				if (franOsm.length) anmarkningar.push(`OpenStreetMap Nominatim${cachad ? " (sparat svar)" : ""}: ${NOMINATIM_ATTRIBUTION}.`);
			} catch (e) {
				if (!(e instanceof UpstreamError)) throw e;
				osm = "fel";
				anmarkningar.push(
					`OpenStreetMap Nominatim gick inte att nå (${e.message}).${omrade ? ` Orten finns därför inte med som egen punkt; ${omrade.typ === "kommun" ? "kommunens" : "socknens"} punkt är mittpunkten för dess registrerade lämningar, inte orten.` : ""}`,
				);
			}
		}
	}

	// Ordning: orter (OpenStreetMap) först när de finns, sedan indexets träffar, sist övriga platser i OpenStreetMap.
	const orter = franOsm.filter((k) => k.punkttyp === "ort");
	const ovriga = franOsm.filter((k) => k.punkttyp !== "ort");
	const kandidater = [...orter, ...franIndex, ...ovriga].slice(0, MAX_KANDIDATER);
	const harIndex = kandidater.some((k) => k.kalla !== "OpenStreetMap Nominatim");
	const harOsm = kandidater.some((k) => k.kalla === "OpenStreetMap Nominatim");
	const kalla: "index" | "nominatim" | "index+nominatim" | "ingen" = harIndex && harOsm ? "index+nominatim" : harIndex ? "index" : harOsm ? "nominatim" : "ingen";

	const ort = kandidater.find((k) => k.punkttyp === "ort") ?? null;
	if (ort && omrade) {
		anmarkningar.unshift(
			`Orten ${ort.namn} enligt OpenStreetMap ligger ${fmtKm(km(ort, omrade))} km från mittpunkten för ${omrade.typ === "kommun" ? "kommunens" : "socknens"} registrerade lämningar. Använd ortspunkten för "nära ${namn}"; områdets mittpunkt bara för området som helhet (radien behöver då täcka utbredningen).`,
		);
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
	if (osm !== "ej") delar.push(osm === "sparat" ? "OpenStreetMap sparat svar (högst 30 dygn)" : osm === "nu" ? "OpenStreetMap hämtat nu" : "OpenStreetMap svarade inte");
	const hamtad_fran = delar.join("; ") || "inget uppslag gjordes";
	const kallaText =
		kalla === "index+nominatim"
			? "serverns lämningsindex och OpenStreetMap Nominatim"
			: kalla === "index"
				? "serverns lämningsindex"
				: kalla === "nominatim"
					? "OpenStreetMap Nominatim"
					: [indexSvarade ? "serverns lämningsindex" : null, osm !== "ej" ? "OpenStreetMap Nominatim" : null].filter(Boolean).join(" och ") || "ingen källa kunde frågas";

	const structured = { namn, kommun, lan, kalla, hamtad_fran, kandidater, anmarkningar };
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
