/**
 * Tolkning av K-samsöks svar. Normaliserar fällorna i SPEC 3:
 * - `record` och `field` kan vara objekt (en träff/ett fält) eller lista,
 * - fel kan komma som JSON (`result.error`) eller som XML trots `Accept: application/json`,
 * - `itemNumber` innehåller både lämningsnummer och RAÄ-nummer,
 * - `itemSpecification` innehåller både bedömning och aktualitetsstatus,
 * - JSON-LD-posten har typade noder (`ksam:ItemDescription` med `ksam:type`).
 */
import { KALLA, publicUrl } from "../../config";
import { UpstreamError } from "../../errors";
import { type Geometry, parseGml } from "../../geo/geometry";
import { round, toPlanar } from "../../geo/sweref";
import type { UpstreamResponse } from "../../upstream/client";
import { BEDOMNINGAR, type Egenskap, type LamningPost, type RecordFetchResult, type Referenser, type SearchHit } from "../types";

export function asArray<T>(x: T | T[] | null | undefined): T[] {
	if (x === undefined || x === null) return [];
	return Array.isArray(x) ? x : [x];
}

const LAMNINGSNUMMER_RE = /^L\d{4}:\d+$/;
const UUID_IN_URI_RE = /\/raa\/lamning\/([0-9a-fA-F-]{36})$/;

/** Plocka ut felmeddelandet ur ett XML-svar (`<error>…</error>` eller liknande). */
export function extractXmlError(body: string): string {
	const m = /<(?:error|message|diagnostic|errorMessage)[^>]*>([\s\S]*?)<\/(?:error|message|diagnostic|errorMessage)>/i.exec(body);
	const text = (m ? m[1] : body.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
	return decodeXmlEntities(text).slice(0, 300) || "okänt fel";
}

function decodeXmlEntities(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&amp;/g, "&");
}

export interface KsamsokSearchResult {
	totalHits: number;
	records: unknown[];
}

/** Tolka ett sökssvar. Kastar `UpstreamError` med K-samsöks eget felmeddelande. */
export function parseSearchResponse(raw: UpstreamResponse): KsamsokSearchResult {
	const body = raw.body.trimStart();
	if (body.startsWith("<") || /xml/i.test(raw.contentType)) {
		throw new UpstreamError("ksamsok", `K-samsök svarade med fel (${raw.status}): ${extractXmlError(body)}`, raw.status);
	}
	let data: unknown;
	try {
		data = JSON.parse(body);
	} catch {
		throw new UpstreamError("ksamsok", `K-samsök svarade inte med JSON (status ${raw.status})`, raw.status);
	}
	const result = (data as { result?: Record<string, unknown> })?.result;
	if (!result || typeof result !== "object") {
		throw new UpstreamError("ksamsok", `Oväntat svar från K-samsök (status ${raw.status})`, raw.status);
	}
	if (typeof result.error === "string" || raw.status >= 400) {
		const msg = typeof result.error === "string" ? result.error : `status ${raw.status}`;
		throw new UpstreamError("ksamsok", `K-samsök svarade med fel (${raw.status}): ${msg}`, raw.status);
	}
	const records = (result.records as { record?: unknown } | undefined)?.record;
	return { totalHits: Number(result.totalHits ?? 0), records: asArray(records) };
}

// ---------------------------------------------------------------- presentation

export interface PresentationItem {
	uuid: string;
	idLabel: string | null;
	itemLabel: string | null;
	description: string | null;
	placeLabel: string | null;
	lon: number | null;
	lat: number | null;
	buildDate: string | null;
}

function text(x: unknown): string | null {
	if (typeof x === "string") return x;
	if (typeof x === "number") return String(x);
	if (x && typeof x === "object" && "content" in x) return text((x as { content: unknown }).content);
	return null;
}

export function parsePresentationRecord(rec: unknown): PresentationItem | null {
	const item = (rec as Record<string, unknown>)?.["pres:item"] as Record<string, unknown> | undefined;
	if (!item) return null;
	const uuid = text(item["pres:id"]);
	if (!uuid) return null;
	let lon: number | null = null;
	let lat: number | null = null;
	const where = item["georss:where"] as Record<string, unknown> | undefined;
	const point = where?.["gml:Point"] as Record<string, unknown> | undefined;
	const coords = text(point?.["gml:coordinates"]);
	if (coords) {
		const [x, y] = coords.trim().split(/\s+/)[0].split(",").map(Number);
		if (Number.isFinite(x) && Number.isFinite(y)) {
			lon = x;
			lat = y;
		}
	}
	const ctx = asArray(item["pres:context"] as unknown)[0] as Record<string, unknown> | undefined;
	return {
		uuid,
		idLabel: text(item["pres:idLabel"]),
		itemLabel: text(item["pres:itemLabel"]),
		description: text(item["pres:description"]),
		placeLabel: text(ctx?.["pres:placeLabel"]),
		lon,
		lat,
		buildDate: text(item["pres:buildDate"]),
	};
}

// ---------------------------------------------------------------- xml + fields

export type FieldMap = Map<string, string[]>;

export function parseFieldsRecord(rec: unknown): FieldMap {
	const map: FieldMap = new Map();
	for (const f of asArray((rec as { field?: unknown })?.field)) {
		const name = (f as { name?: unknown })?.name;
		const content = text(f);
		if (typeof name !== "string" || content === null) continue;
		const list = map.get(name) ?? [];
		list.push(content);
		map.set(name, list);
	}
	return map;
}

export function uuidFromUri(uri: string | null | undefined): string | null {
	if (!uri) return null;
	const m = UUID_IN_URI_RE.exec(uri);
	return m ? m[1].toLowerCase() : null;
}

export function splitNumbers(numbers: readonly string[]): { lamningsnummer: string | null; raa_nummer: string | null } {
	const l = numbers.find((n) => LAMNINGSNUMMER_RE.test(n)) ?? null;
	const r = numbers.find((n) => !LAMNINGSNUMMER_RE.test(n)) ?? null;
	return { lamningsnummer: l, raa_nummer: r };
}

export function pickBedomning(specs: readonly string[]): string | null {
	return specs.find((s) => (BEDOMNINGAR as readonly string[]).includes(s)) ?? null;
}

/** Slå ihop presentationsdata (koordinat, beskrivning) med fältdata (bedömning, indelning). */
export function mergeHit(fields: FieldMap | undefined, pres: PresentationItem | undefined): SearchHit | null {
	const uuid = uuidFromUri(fields?.get("itemId")?.[0]) ?? pres?.uuid?.toLowerCase() ?? null;
	if (!uuid) return null;
	const nums = splitNumbers(fields?.get("itemNumber") ?? []);
	return {
		uuid,
		lamningsnummer: nums.lamningsnummer ?? pres?.idLabel ?? null,
		raa_nummer: nums.raa_nummer,
		lamningstyp: fields?.get("itemName")?.[0] ?? pres?.itemLabel ?? null,
		antikvarisk_bedomning: pickBedomning(fields?.get("itemSpecification") ?? []),
		kommun: unique(fields?.get("municipalityName") ?? []),
		socken: unique(fields?.get("parishName") ?? []),
		lan: unique(fields?.get("countyName") ?? []),
		landskap: unique(fields?.get("provinceName") ?? []),
		koordinat: pres && pres.lat !== null && pres.lon !== null ? { lat: pres.lat, lon: pres.lon } : null,
		beskrivning: pres?.description ?? null,
	};
}

function unique(xs: string[]): string[] {
	return [...new Set(xs)];
}

// ---------------------------------------------------------------- JSON-LD

type LdNode = Record<string, unknown> & { "@id"?: string; "@type"?: string | string[] };

function ldValue(x: unknown): string | null {
	if (typeof x === "string") return x;
	if (x && typeof x === "object" && "@value" in x) {
		const v = (x as { "@value": unknown })["@value"];
		return typeof v === "string" ? v : v === null || v === undefined ? null : String(v);
	}
	return null;
}

function ldValues(x: unknown): string[] {
	return asArray(x)
		.map(ldValue)
		.filter((v): v is string => v !== null);
}

function hasType(n: LdNode, t: string): boolean {
	return asArray(n["@type"]).includes(t);
}

const INGAENDE_RE = /^(.*?)(?: - (.*))?, antal (\d+)$/;

/** "Hyttlämning - Material: Koppar, Typ: Hytta/ugn, antal 2.Husgrund, historisk tid, antal 5" */
export function parseIngaendeText(s: string): Array<{ lamningstyp: string; antal: number | null; egenskaper: Egenskap[] }> {
	return s
		.split(/(?<=antal \d+)\.\s*/)
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => {
			const m = INGAENDE_RE.exec(p);
			if (!m) return { lamningstyp: p, antal: null, egenskaper: [] };
			const egenskaper: Egenskap[] = (m[2] ?? "")
				.split(/,\s*(?=[^,:]+:)/)
				.map((kv) => kv.split(/:\s*/))
				.filter((kv) => kv.length >= 2 && kv[0])
				.map(([typ, ...rest]) => ({ typ: typ.trim(), varde: rest.join(": ").trim() }));
			return { lamningstyp: m[1].trim(), antal: Number(m[3]), egenskaper };
		});
}

/**
 * Tolka en lämning ur K-samsöks JSON-LD (typade noder). Returnerar null om
 * dokumentet inte innehåller en lämning.
 */
export function parseJsonLd(doc: unknown): RecordFetchResult | null {
	const graph = asArray((doc as { "@graph"?: unknown })?.["@graph"]) as LdNode[];
	if (graph.length === 0) return null;
	const byId = new Map<string, LdNode>();
	for (const n of graph) if (typeof n["@id"] === "string") byId.set(n["@id"], n);
	const entity = graph.find((n) => hasType(n, "ksam:Entity") && typeof n["@id"] === "string" && uuidFromUri(n["@id"]));
	if (!entity) return null;
	const uuid = uuidFromUri(entity["@id"] as string) as string;
	const deref = (ref: unknown): LdNode[] =>
		asArray(ref)
			.map((r) => (r && typeof r === "object" && "@id" in r ? byId.get((r as { "@id": string })["@id"]) : undefined))
			.filter((n): n is LdNode => !!n);

	const typed = (prop: string, valueProp: string) =>
		deref(entity[prop]).map((n) => ({ type: ldValue(n["ksam:type"]) ?? "", value: ldValue(n[valueProp]) ?? "" }));

	const descriptions = typed("ksam:itemDescription", "ksam:desc");
	const specs = typed("ksam:itemSpecification", "ksam:spec");
	const numbers = typed("ksam:itemNumber", "ksam:number");
	const names = typed("ksam:itemName", "ksam:name");
	const desc = (t: string) => descriptions.find((d) => d.type === t)?.value || null;
	const descAll = (pred: (t: string) => boolean) => descriptions.filter((d) => pred(d.type)).map((d) => d.value);

	const contexts = deref(entity["ksam:context"]);
	const collect = (prop: string) => [...new Set(contexts.flatMap((c) => ldValues(c[prop])))];
	let geometry: Geometry | null = null;
	for (const c of contexts) {
		const gml = ldValue(c["ksam:coordinates"]);
		if (gml) {
			geometry = parseGml(gml);
			if (geometry) break;
		}
	}

	// Mittpunkten står i presentationsblocket (georss:where).
	let lat: number | null = null;
	let lon: number | null = null;
	const pres = ldValue(entity["ksam:presentation"]);
	const where = pres ? /<georss:where[\s\S]*?<gml:coordinates[^>]*>([^<]+)<\/gml:coordinates>/.exec(pres) : null;
	if (where) {
		const [x, y] = where[1].trim().split(/\s+/)[0].split(",").map(Number);
		if (Number.isFinite(x) && Number.isFinite(y)) {
			lon = x;
			lat = y;
		}
	} else if (geometry?.type === "Point") {
		[lon, lat] = geometry.coordinates;
	}
	const sweref = lat !== null && lon !== null ? toPlanar({ lat, lon }) : null;

	const referenser: Referenser = {
		skriftliga_kallor: descAll((t) => /^Referens:.*skriftlig/i.test(t)),
		kartmaterial: descAll((t) => /^Referens:.*kart/i.test(t)),
		uppgiftslamnare: descAll((t) => /^Referens:.*uppgift/i.test(t)),
	};
	const ingaendeText = desc("Ingående lämningar");
	const buildDate = typeof entity["ksam:buildDate"] === "string" ? (entity["ksam:buildDate"] as string) : ldValue(entity["ksam:buildDate"]);

	const post: LamningPost = {
		lamningsnummer: numbers.find((n) => n.type === "Lämningsnummer")?.value ?? null,
		raa_nummer: numbers.find((n) => n.type === "RAÄ-nummer")?.value ?? null,
		uuid,
		lamningstyp: names.find((n) => n.type === "Lämningstyp")?.value ?? ldValue(entity["ksam:itemLabel"]),
		antikvarisk_bedomning: {
			varde: specs.find((s) => s.type === "Antikvarisk bedömning")?.value ?? null,
			motivering: null,
		},
		beskrivning: desc("Beskrivning"),
		tradition: desc("Tradition"),
		terrang: desc("Terräng"),
		orientering: desc("Orientering"),
		namn: ldValues(entity["ksam:itemKeyword"]),
		egenskaper: [],
		ingaende_lamningar: ingaendeText ? parseIngaendeText(ingaendeText) : [],
		statusar: {
			aktualitet: specs.find((s) => s.type === "Aktualitetsstatus")?.value ?? null,
			undersokning: desc("Undersökningsstatus"),
			skada: desc("Skadestatus"),
			placering: desc("Placering"),
		},
		lage: {
			lat,
			lon,
			sweref99tm: sweref ? { e: round(sweref.e, 1), n: round(sweref.n, 1) } : null,
			osakerhet_m: null,
			geometrityp: geometry ? geometryTypeLabel(geometry) : null,
		},
		indelning: {
			lan: collect("ksam:countyName"),
			kommun: collect("ksam:municipalityName"),
			socken: collect("ksam:parishName"),
			landskap: collect("ksam:provinceName"),
		},
		url: publicUrl(uuid),
		kalla: KALLA,
		hamtad_fran: `K-samsök (reserv)${buildDate ? `, data byggd ${buildDate}` : ""}`,
	};
	return { post, geometriWgs: geometry, referenser };
}

export function geometryTypeLabel(g: Geometry): string {
	if (g.type !== "GeometryCollection") return g.type;
	const types = [...new Set(g.geometries.map(geometryTypeLabel))];
	return types.length === 1 ? `Multi${types[0]}` : types.join("+");
}
