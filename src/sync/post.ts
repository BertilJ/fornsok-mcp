/**
 * Källpost för nattsynken: samma form som `KallPost` i ingest/transform.ts (en
 * lämning som den står i GeoPackage-filen), men byggd ur Fornsök-appens
 * läs-API eller, som reserv, K-samsök.
 *
 * Varför en kopia och inte en import: ingest/ körs i Node med `.ts`-ändelser i
 * importerna och `node:crypto`, vilket rotens tsconfig och Workers inte tar.
 * Formen och innehållshashen hålls lika med transform.ts; test/sync/hash.test.ts
 * jämför dem (samma hash för samma post, samma TRANSFORM_VERSION).
 *
 * Fältmappning app → GeoPackage, kontrollerad mot ingest/.cache/falun.gpkg för
 * L2001:646 och L2000:8802 (test/sync/mapping.test.ts):
 * - publicerad_av ← registrerare_organisationsnamn (inte publicerad_av_organisation)
 * - publiceringsdatum ← appens lokala tid → ISO med svensk tidszon, millisekunder
 *   avrundade ("2022-07-18T14:28:18.298635" → "2022-07-18T14:28:18.299+02:00")
 * - osakerhet_m ← inmatningsosakerhet_meter + utbredningsosakerhet_meter
 *   (10 + 20 = 30 resp. 10 + 5 = 15, som GeoPackage-filens lägesosäkerhet)
 * - lan/kommun/socken ← nuvarande_lage.geografisk_indelning, kommaseparerat
 *
 * Kända skillnader mot GeoPackage (ger annan hash, se README-avsnittet i
 * src/sync/index.ts): ingående lämningars id finns inte i appen (numreras 1, 2,
 * …), och `namn` tas ur appens `alternativnamn` – GeoPackage-filens
 * `lamningsnamn` har inte alltid samma innehåll (L2001:646: appen
 * "Mas-källa", filen tom).
 */
import type { Geometry, Position } from "../geo/geometry";
import type { LamningPost } from "../sources/types";

/** Måste vara lika med TRANSFORM_VERSION i ingest/transform.ts (kontrolleras i test). */
export const TRANSFORM_VERSION = "1";

export interface SynkGeometri {
	nr: string | null;
	geometry: Geometry;
}
export interface SynkEgenskap {
	ingaende_nr: number | null;
	typ: string;
	varde: string;
}
export interface SynkIngaende {
	nr: number;
	lamningstyp: string;
	antal: number | null;
}

/** Samma fält och ordning som KallPost i ingest/transform.ts. */
export interface SynkPost {
	uuid: string;
	lamningsnummer: string | null;
	raa_nummer: string | null;
	lamningstyp: string | null;
	beskrivning: string | null;
	publicerad_av: string | null;
	publiceringsdatum: string | null;
	uttagsdatum: string | null;
	bedomning: string | null;
	bedomning_motivering: string | null;
	aktualitet: string | null;
	skada: string | null;
	undersokning: string | null;
	placering: string | null;
	terrang: string | null;
	orientering: string | null;
	tradition: string | null;
	namn: string | null;
	lan: string | null;
	kommun: string | null;
	socken: string | null;
	osakerhet_m: number | null;
	geometrier: SynkGeometri[];
	egenskaper: SynkEgenskap[];
	ingaende: SynkIngaende[];
}

/** Indelning med koder, direkt ur appens post (bättre än GeoPackage-filens namnlistor). */
export interface AppIndelning {
	kommuner: Array<{
		namn: string;
		kod: string | null;
		lan: string | null;
		lan_kod: string | null;
	}>;
	socknar: Array<{ namn: string; id: string | null }>;
	landskap: Array<{ namn: string; kod: string | null }>;
}

export interface ByggdPost {
	post: SynkPost;
	indelning: AppIndelning;
	/** Varifrån posten kom. Reservposter (K-samsök) saknar egenskaper och ingående lämningar. */
	kalla: "fornsokapp" | "ksamsok";
}

type Obj = Record<string, unknown>;

// ---------------------------------------------------------------- text (som transform.ts)

/** NFC, trimmat, styrtecken bort, tomt → null. Samma som text() i ingest/transform.ts. */
export function text(x: unknown): string | null {
	if (typeof x !== "string") return null;
	// oxlint-disable-next-line no-control-regex -- styrtecken tas bort avsiktligt
	const styrtecken = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
	const s = x.normalize("NFC").replace(styrtecken, "").trim();
	return s.length ? s : null;
}

/** Samma som raaSok() i ingest/transform.ts. */
export function raaSok(s: string | null): string | null {
	if (!s) return null;
	const t = s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
	return t || null;
}

/** Dela flerledat fält ("Bjursås,Leksand"). Samma som splitList() i ingest/transform.ts. */
export function splitList(s: string | null): string[] {
	if (!s) return [];
	const out: string[] = [];
	for (const part of s.split(",")) {
		const t = part.trim();
		if (t && !out.includes(t)) out.push(t);
	}
	return out;
}

const arr = (x: unknown): Obj[] =>
	Array.isArray(x) ? (x as Obj[]).filter((y) => y !== null && typeof y === "object") : [];
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const joined = (xs: string[]): string | null => (xs.length ? xs.join(",") : null);

function unique(xs: Array<string | null>): string[] {
	const out: string[] = [];
	for (const x of xs) if (x && !out.includes(x)) out.push(x);
	return out;
}

// ---------------------------------------------------------------- tid

/** Förskjutning (minuter) mellan UTC och svensk tid vid tidpunkten `ms`. */
export function stockholmOffsetMinutes(ms: number): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "Europe/Stockholm",
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(new Date(ms));
	const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
	const asUtc = Date.UTC(
		get("year"),
		get("month") - 1,
		get("day"),
		get("hour"),
		get("minute"),
		get("second"),
	);
	return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/**
 * Appens tidsstämpel (lokal svensk tid utan zon, upp till mikrosekunder) →
 * samma form som GeoPackage-filen: "ÅÅÅÅ-MM-DDTtt:mm:ss[.mmm]+hh:mm".
 * Millisekunder avrundas; noll millisekunder skrivs inte. Har stämpeln redan en
 * zon används den.
 */
export function appTidTillIso(s: string | null): string | null {
	if (!s) return null;
	const m =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/.exec(
			s.trim(),
		);
	if (!m) return s;
	const [, y, mo, d, h, mi, se, frac, zone] = m;
	const fracMs = frac ? Number(`0.${frac}`) * 1000 : 0;
	const localAsUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) + Math.round(fracMs);
	let utc: number;
	if (zone) {
		const off =
			zone === "Z"
				? 0
				: (zone[0] === "-" ? -1 : 1) *
					(Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2)));
		utc = localAsUtc - off * 60000;
	} else {
		// Lokal tid → UTC: två varv räcker även kring sommartidsskiftet.
		utc = localAsUtc - stockholmOffsetMinutes(localAsUtc) * 60000;
		utc = localAsUtc - stockholmOffsetMinutes(utc) * 60000;
	}
	const off = stockholmOffsetMinutes(utc);
	const local = new Date(utc + off * 60000);
	const ms = local.getUTCMilliseconds();
	const sign = off < 0 ? "-" : "+";
	const a = Math.abs(off);
	return (
		`${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
		`T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
		`${ms ? `.${pad(ms, 3)}` : ""}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
	);
}

// ---------------------------------------------------------------- geometri

function strip2d(g: Geometry): Geometry {
	const p = (x: Position): Position => [x[0], x[1]];
	switch (g.type) {
		case "Point":
			return { type: "Point", coordinates: p(g.coordinates) };
		case "MultiPoint":
		case "LineString":
			return { type: g.type, coordinates: g.coordinates.map(p) } as Geometry;
		case "MultiLineString":
		case "Polygon":
			return { type: g.type, coordinates: g.coordinates.map((r) => r.map(p)) } as Geometry;
		case "MultiPolygon":
			return {
				type: "MultiPolygon",
				coordinates: g.coordinates.map((poly) => poly.map((r) => r.map(p))),
			};
		case "GeometryCollection":
			return { type: "GeometryCollection", geometries: g.geometries.map(strip2d) };
	}
}

function validGeometry(g: unknown): g is Geometry {
	if (!g || typeof g !== "object") return false;
	const t = (g as Obj).type;
	if (t === "GeometryCollection") return Array.isArray((g as Obj).geometries);
	return (
		typeof t === "string" &&
		Array.isArray((g as Obj).coordinates) &&
		((g as Obj).coordinates as unknown[]).length > 0
	);
}

// ---------------------------------------------------------------- app → post

/**
 * Bygg källposten ur Fornsök-appens `GET api/lamning/lamning/{uuid}`.
 * Returnerar null om svaret inte är en lämning.
 */
export function appTillPost(d: Obj, uttagsdatum: string): ByggdPost | null {
	const uuidRaw = text(d.lamning_id);
	if (!uuidRaw || !/^[0-9a-f-]{36}$/i.test(uuidRaw)) return null;
	const uuid = uuidRaw.toLowerCase();
	const lage = (d.nuvarande_lage ?? null) as Obj | null;
	const indel = (lage?.geografisk_indelning ?? {}) as Obj;
	const legacy = (d.legacy ?? {}) as Obj;
	const status = (x: unknown, k: string) => text((x as Obj | null)?.[k]);

	const kommuner = arr(indel.kommun)
		.map((k) => ({
			namn: text(k.kommun_namn) ?? "",
			kod: text(k.kommun_kod),
			lan: text(k.lan_namn),
			lan_kod: text(k.lan_kod),
		}))
		.filter((k) => k.namn);
	const socknar = arr(indel.socken)
		.map((s) => ({ namn: text(s.socken_namn) ?? "", id: text(s.socken_id) }))
		.filter((s) => s.namn);
	const landskap = arr(indel.landskap)
		.map((l) => ({ namn: text(l.landskap_namn) ?? "", kod: text(l.landskap_kod) }))
		.filter((l) => l.namn);

	const geometrier: SynkGeometri[] = [];
	for (const f of arr((lage?.geometri as Obj | null)?.features)) {
		if (!validGeometry(f.geometry)) continue;
		const props = (f.properties ?? {}) as Obj;
		geometrier.push({
			nr: text(props.geometrinummer) ?? text(f.id),
			geometry: strip2d(f.geometry),
		});
	}

	const egenskaper: SynkEgenskap[] = [];
	const pushEgenskaper = (x: unknown, nr: number | null) => {
		for (const e of arr(x)) {
			const typ = text(e.egenskapstyp_namn);
			for (const v of arr(e.egenskapsvarden)) {
				const varde = text(v.egenskapsvarde_namn);
				if (typ && varde) egenskaper.push({ ingaende_nr: nr, typ, varde });
			}
		}
	};
	pushEgenskaper(d.egenskaper, null);
	const ingaende: SynkIngaende[] = [];
	arr(d.ingaendelamningar).forEach((i, idx) => {
		const typ = text(i.lamningstyp_namn);
		if (!typ) return;
		// Appen saknar GeoPackage-filens id för ingående lämningar; löpnummer räcker
		// för att koppla egenskaperna till rätt ingående lämning inom posten.
		const nr = idx + 1;
		const antal = num(i.antal);
		ingaende.push({ nr, lamningstyp: typ, antal: antal === null ? null : Math.trunc(antal) });
		pushEgenskaper(i.egenskaper, nr);
	});

	const inm = num(lage?.inmatningsosakerhet_meter);
	const utb = num(lage?.utbredningsosakerhet_meter);
	const osakerhet = inm !== null || utb !== null ? Math.round((inm ?? 0) + (utb ?? 0)) : null;

	const namn = Array.isArray(d.alternativnamn)
		? unique((d.alternativnamn as unknown[]).map(text))
		: [];

	const post: SynkPost = {
		uuid,
		lamningsnummer: text(d.lamningsnummer),
		raa_nummer: text(legacy.raa_nummer),
		lamningstyp: text(d.lamningstyp_namn),
		beskrivning: text(d.beskrivning),
		publicerad_av: text(d.registrerare_organisationsnamn),
		publiceringsdatum: appTidTillIso(text(d.publiceringsdatum)),
		uttagsdatum,
		bedomning: text(d.antikvariskbedomningtyp_namn),
		bedomning_motivering: text(d.antikvariskbedomning_motivering),
		aktualitet: status(d.aktualitetstatus, "aktualitetstatustyp_namn"),
		skada: status(d.skadestatus, "skadestatustyp_namn"),
		undersokning: status(d.undersokningsstatus, "undersokningsstatustyp_namn"),
		placering: text(d.placeringtyp_namn),
		terrang: text(d.terrang),
		orientering: text(d.orientering),
		tradition: text(d.tradition),
		namn: namn.length ? namn.join(", ") : null,
		lan: joined(unique(kommuner.map((k) => k.lan))),
		kommun: joined(unique(kommuner.map((k) => k.namn))),
		socken: joined(unique(socknar.map((s) => s.namn))),
		osakerhet_m: osakerhet,
		geometrier,
		egenskaper,
		ingaende,
	};
	return { post, indelning: { kommuner, socknar, landskap }, kalla: "fornsokapp" };
}

/**
 * Reserv: bygg källposten ur K-samsöks post (SPEC 8). K-samsök saknar
 * egenskaper, ingående lämningar och lägesosäkerhet, och ligger några dagar
 * efter; skrivaren behåller därför befintliga barnrader och osäkerhet (se
 * skriv.ts) och posten prövas mot appen igen vid nästa körning.
 */
export function ksamsokTillPost(
	p: LamningPost,
	geometriWgs: Geometry | null,
	uttagsdatum: string,
	wgsToSweref: (g: Geometry) => Geometry,
): ByggdPost {
	const geometrier: SynkGeometri[] = geometriWgs
		? [{ nr: null, geometry: strip2d(wgsToSweref(geometriWgs)) }]
		: [];
	const post: SynkPost = {
		uuid: p.uuid.toLowerCase(),
		lamningsnummer: text(p.lamningsnummer),
		raa_nummer: text(p.raa_nummer),
		lamningstyp: text(p.lamningstyp),
		beskrivning: text(p.beskrivning),
		publicerad_av: null,
		publiceringsdatum: null,
		uttagsdatum,
		bedomning: text(p.antikvarisk_bedomning.varde),
		bedomning_motivering: text(p.antikvarisk_bedomning.motivering),
		aktualitet: text(p.statusar.aktualitet),
		skada: text(p.statusar.skada),
		undersokning: text(p.statusar.undersokning),
		placering: text(p.statusar.placering),
		terrang: text(p.terrang),
		orientering: text(p.orientering),
		tradition: text(p.tradition),
		namn: p.namn?.length ? unique(p.namn.map(text)).join(", ") || null : null,
		lan: joined(unique(p.indelning.lan.map(text))),
		kommun: joined(unique(p.indelning.kommun.map(text))),
		socken: joined(unique(p.indelning.socken.map(text))),
		osakerhet_m: p.lage.osakerhet_m,
		geometrier,
		egenskaper: [],
		ingaende: [],
	};
	return {
		post,
		indelning: {
			kommuner: unique(p.indelning.kommun.map(text)).map((namn) => ({
				namn,
				kod: null,
				lan: null,
				lan_kod: null,
			})),
			socknar: unique(p.indelning.socken.map(text)).map((namn) => ({ namn, id: null })),
			landskap: unique(p.indelning.landskap.map(text)).map((namn) => ({ namn, kod: null })),
		},
		kalla: "ksamsok",
	};
}

// ---------------------------------------------------------------- hash (som transform.ts)

function canonical(x: unknown): string {
	return JSON.stringify(x, (_k, v) => {
		if (v && typeof v === "object" && !Array.isArray(v)) {
			const o: Record<string, unknown> = {};
			for (const k of Object.keys(v).sort()) o[k] = (v as Record<string, unknown>)[k];
			return o;
		}
		if (typeof v === "number") return Math.round(v * 1000) / 1000;
		return v;
	});
}

async function sha256Hex(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Innehållshash över posten utom uttagsdatum, geometrin i millimeter, barnrader
 * sorterade. Samma algoritm och samma värde som contentHash() i
 * ingest/transform.ts för samma post (32 hex-tecken).
 */
export async function contentHash(p: SynkPost): Promise<string> {
	const { uttagsdatum: _u, ...rest } = p;
	const sortKey = (x: unknown) => canonical(x);
	const norm = {
		v: TRANSFORM_VERSION,
		...rest,
		geometrier: [...p.geometrier]
			.map((g) => ({ nr: g.nr, g: g.geometry }))
			.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1)),
		egenskaper: [...p.egenskaper].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1)),
		ingaende: [...p.ingaende].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1)),
	};
	return (await sha256Hex(canonical(norm))).slice(0, 32);
}

/** Prefix på hashen för rader skrivna från K-samsök (reserv): avstämningen skriver alltid om dem. */
export const RESERV_HASH_PREFIX = "ksamsok:";
