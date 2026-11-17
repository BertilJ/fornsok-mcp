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
import type { KvLike } from "../cache/kv";
import { publicUrl, userAgent } from "../config";
import { ToolInputError, UpstreamError } from "../errors";
import { isInSweden, round, toPlanar } from "../geo/sweref";
import { findLan } from "../lookup/names";
import type { D1Like } from "../store/d1";
import { buildFtsQuery } from "../store/fts";
import { checkAllowed } from "../upstream/allowlist";
import { type FetchLike, UpstreamClient } from "../upstream/client";
import { READ_ONLY, ok, runTool } from "./common";

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
}): HittaPlatsDeps {
	return {
		db: opts.db,
		kv: opts.kv,
		client: new UpstreamClient({
			userAgent: userAgent(opts.contactUrl),
			maxConcurrent: 1,
			...(opts.fetch ? { fetch: opts.fetch } : {}),
		}),
		nominatim: (opts.nominatim ?? "").trim().toLowerCase() !== "av",
	};
}

// ---------------------------------------------------------------- schema

export const hittaPlatsInput = z.object({
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

const kandidat = z.object({
	namn: z.string(),
	typ: z.string(),
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
	kalla: z.enum(["index", "nominatim", "ingen"]),
	kandidater: z.array(kandidat),
	anmarkningar: z.array(z.string()),
});

export type HittaPlatsArgs = z.infer<typeof hittaPlatsInput>;
export type Kandidat = z.infer<typeof kandidat>;

// ---------------------------------------------------------------- registrering

export const HITTA_PLATS_BESKRIVNING =
	"Ortnamn till koordinat (WGS 84, med SWEREF 99 TM i den strukturerade delen). Söker först i serverns index bland socknar, kommuner och namngivna lämningar " +
	"(t.ex. källor och stenar med namn), och frågar OpenStreetMap Nominatim (bara Sverige) först om indexet inte ger något. " +
	"Svaret är kandidater med koordinat, typ och källa; för socknar och kommuner är koordinaten mittpunkten av områdets lämningar. " +
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

/** Villkor: lämningen ligger i kommunen/länet (om angivet). */
function areaFilter(
	kommun: string[] | null,
	lan: string[] | null,
): { sql: string; params: unknown[] } {
	const parts: string[] = [];
	const params: unknown[] = [];
	for (const [niva, namn] of [
		["kommun", kommun],
		["lan", lan],
	] as const) {
		if (!namn) continue;
		parts.push(
			"l.id IN (SELECT lo2.lamning_id FROM lamning_omrade lo2 JOIN omrade o2 ON o2.id = lo2.omrade_id WHERE o2.niva = ? AND o2.namn IN (SELECT value FROM json_each(?)))",
		);
		params.push(niva, JSON.stringify(namn));
	}
	return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", params };
}

// ---------------------------------------------------------------- indexet

export async function sokIndex(
	db: D1Like,
	namn: string,
	kommun: string | null,
	lan: string | null,
): Promise<Kandidat[]> {
	const varianter = JSON.stringify(namnvarianter(namn));
	const kommunV = kommun ? namnvarianter(kommun) : null;
	const lanV = lan ? [lan] : null;
	const af = areaFilter(kommunV, lanV);

	// Socknar och kommuner: mittpunkt och utbredning av områdets lämningar.
	const omr = await rows(
		db,
		`SELECT o.id, o.niva, o.namn, o.lan, count(*) AS n, avg(l.lat) AS lat, avg(l.lon) AS lon,
		        min(l.lat) AS min_lat, max(l.lat) AS max_lat, min(l.lon) AS min_lon, max(l.lon) AS max_lon
		   FROM omrade o JOIN lamning_omrade lo ON lo.omrade_id = o.id JOIN lamning l ON l.id = lo.lamning_id
		  WHERE o.niva IN ('socken', 'kommun') AND o.namn IN (SELECT value FROM json_each(?)) AND l.lat IS NOT NULL${af.sql}
		  GROUP BY o.id ORDER BY CASE o.niva WHEN 'kommun' THEN 0 ELSE 1 END, n DESC LIMIT ?`,
		varianter,
		...af.params,
		MAX_KANDIDATER,
	);
	// Kommun och län där områdets lämningar oftast ligger.
	const ctx = new Map<number, { kommun: string | null; lan: string | null }>();
	if (omr.length) {
		const ids = JSON.stringify(omr.map((o) => o.id));
		const c = await rows(
			db,
			`SELECT lo.omrade_id AS oid, o2.niva, o2.namn, count(*) AS n
			   FROM lamning_omrade lo JOIN lamning_omrade lo2 ON lo2.lamning_id = lo.lamning_id JOIN omrade o2 ON o2.id = lo2.omrade_id
			  WHERE lo.omrade_id IN (SELECT value FROM json_each(?)) AND o2.niva IN ('kommun', 'lan')
			  GROUP BY lo.omrade_id, o2.id ORDER BY n DESC`,
			ids,
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
			kalla: "Lämningsindex (D1)",
			...geo(lat, lon),
			kommun: niva === "kommun" ? String(o.namn) : c.kommun,
			lan: str(o.lan) || c.lan,
			beskrivning: `${niva === "kommun" ? "Kommun" : "Socken"}; koordinaten är mittpunkten av ${n} lämningar i registret, inte en officiell ortspunkt.`,
			antal_lamningar: n,
			lamningsnummer: null,
			url: null,
			utbredning: [num(o.min_lon), num(o.min_lat), num(o.max_lon), num(o.max_lat)].every(
				(x) => x !== null,
			)
				? [
						round(o.min_lon as number, 5),
						round(o.min_lat as number, 5),
						round(o.max_lon as number, 5),
						round(o.max_lat as number, 5),
					]
				: null,
		});
	}

	// Namngivna lämningar: exakt namn först, sedan ordträff i namnet.
	if (out.length < MAX_KANDIDATER) {
		const fts = buildFtsQuery(namn);
		const lamningar = await rows(
			db,
			`SELECT l.id, l.uuid, l.lamningsnummer, l.lamningstyp, l.namn, l.lat, l.lon,
			        CASE WHEN l.namn IN (SELECT value FROM json_each(?)) THEN 0 ELSE 1 END AS exakt,
			        (SELECT o.namn FROM lamning_omrade lo JOIN omrade o ON o.id = lo.omrade_id WHERE lo.lamning_id = l.id AND o.niva = 'kommun' LIMIT 1) AS kommun,
			        (SELECT o.namn FROM lamning_omrade lo JOIN omrade o ON o.id = lo.omrade_id WHERE lo.lamning_id = l.id AND o.niva = 'lan' LIMIT 1) AS lan
			   FROM lamning l
			  WHERE l.lat IS NOT NULL AND l.namn IS NOT NULL
			    AND (l.namn IN (SELECT value FROM json_each(?))${fts ? " OR l.id IN (SELECT rowid FROM lamning_fts WHERE lamning_fts MATCH ?)" : ""})${af.sql}
			  ORDER BY exakt, l.id LIMIT ?`,
			varianter,
			varianter,
			...(fts ? [`namn : (${fts.match})`] : []),
			...af.params,
			MAX_KANDIDATER - out.length,
		);
		for (const l of lamningar) {
			const lat = num(l.lat);
			const lon = num(l.lon);
			const uuid = str(l.uuid);
			if (lat === null || lon === null || !uuid) continue;
			out.push({
				namn: String(l.namn),
				typ: `lämning (${str(l.lamningstyp) ?? "okänd typ"})`,
				kalla: "Lämningsindex (D1)",
				...geo(lat, lon),
				kommun: str(l.kommun),
				lan: str(l.lan),
				beskrivning:
					Number(l.exakt) === 0
						? "Lämning med namnet i registret."
						: "Lämning vars namn innehåller sökorden.",
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

let koSlut: Promise<void> = Promise.resolve();
let senasteAnrop = 0;

/** Kör `fn` tidigast 1,1 s efter föregående Nominatim-anrop i isolatet (anropen köas). */
async function iTur<T>(deps: HittaPlatsDeps, fn: () => Promise<T>): Promise<T> {
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = deps.now ?? Date.now;
	const fore = koSlut;
	let klar: () => void = () => {};
	koSlut = new Promise<void>((r) => {
		klar = r;
	});
	try {
		await fore;
		const vanta = senasteAnrop + NOMINATIM_MIN_MELLANRUM_MS - now();
		if (vanta > 0) await sleep(vanta);
		senasteAnrop = now();
		return await fn();
	} finally {
		klar();
	}
}

/** Bara för test: nollställ kön. */
export function aterstallNominatimKo(): void {
	koSlut = Promise.resolve();
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

export function nominatimKandidater(traffar: NominatimTraff[]): Kandidat[] {
	const out: Kandidat[] = [];
	for (const t of traffar) {
		const lat = Number(t.lat);
		const lon = Number(t.lon);
		if (!Number.isFinite(lat) || !Number.isFinite(lon) || !isInSweden({ lat, lon })) continue;
		const a = t.address ?? {};
		const bb = (t.boundingbox ?? []).map(Number);
		out.push({
			namn: t.name || t.display_name || "(namnlös)",
			typ: [t.category, t.type].filter(Boolean).join("/") || t.addresstype || "plats",
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
	let kandidater: Kandidat[] = [];
	let kalla: "index" | "nominatim" | "ingen" = "ingen";

	if (deps.db) {
		try {
			kandidater = await sokIndex(deps.db, namn, kommun, lan);
			if (kandidater.length) kalla = "index";
		} catch (e) {
			console.warn(
				"hitta_plats: indexet svarade inte:",
				e instanceof Error ? e.message : String(e),
			);
			anmarkningar.push("Indexet svarade inte; sökte i OpenStreetMap i stället.");
		}
	} else anmarkningar.push("Indexet är inte inkopplat; sökte i OpenStreetMap.");

	if (!kandidater.length) {
		if (!deps.nominatim) {
			anmarkningar.push("Uppslag i OpenStreetMap Nominatim är avstängt på den här servern.");
		} else {
			try {
				const { traffar, cachad } = await nominatim(
					deps,
					nominatimFraga(namn, kommun, lan),
				);
				kandidater = nominatimKandidater(traffar).slice(0, MAX_KANDIDATER);
				if (kandidater.length) {
					kalla = "nominatim";
					anmarkningar.push(
						`Källa: OpenStreetMap Nominatim${cachad ? " (sparat svar)" : ""}. ${NOMINATIM_ATTRIBUTION}.`,
					);
				}
			} catch (e) {
				if (!(e instanceof UpstreamError)) throw e;
				anmarkningar.push(`OpenStreetMap Nominatim gick inte att nå (${e.message}).`);
			}
		}
	}
	if (!kandidater.length) {
		anmarkningar.push(
			"Ingen träff. För äldre platser (torp, fäbodar, gruvor, försvunna gårdar): pröva TORA i Riksarkivets koppling och skicka koordinaten till lamningar_nara. Pröva också annan stavning.",
		);
	}

	const structured = { namn, kommun, lan, kalla, kandidater, anmarkningar };
	const lines: string[] = [];
	const avgr = [kommun ? `kommun ${kommun}` : null, lan ? `län ${lan}` : null]
		.filter(Boolean)
		.join(", ");
	if (kandidater.length) {
		lines.push(
			`${kandidater.length} kandidat${kandidater.length === 1 ? "" : "er"} för "${namn}"${avgr ? ` (${avgr})` : ""}, källa: ${kalla === "index" ? "serverns lämningsindex" : "OpenStreetMap Nominatim"}.`,
		);
		kandidater.forEach((k, i) => {
			const omradeText = [
				k.kommun ? (/kommun$/.test(k.kommun) ? k.kommun : `${k.kommun} kommun`) : null,
				k.lan ? (findLan(k.lan)?.fullt ?? k.lan) : null,
			]
				.filter(Boolean)
				.join(", ");
			const extra = k.lamningsnummer
				? ` ${k.lamningsnummer} ${k.url ?? ""}`
				: k.antal_lamningar
					? ` (${k.antal_lamningar} lämningar)`
					: "";
			lines.push(
				`${i + 1}. ${k.namn} – ${k.typ}${omradeText ? `, ${omradeText}` : ""}: ${k.lat.toFixed(5)}, ${k.lon.toFixed(5)}.${extra}`.trim(),
			);
		});
		lines.push("Koordinaten kan skickas direkt till lamningar_nara (lat, lon).");
	} else lines.push(`Ingen plats hittades för "${namn}"${avgr ? ` (${avgr})` : ""}.`);
	for (const a of anmarkningar) lines.push(`Obs: ${a}`);
	return ok(lines.join("\n"), structured);
}
