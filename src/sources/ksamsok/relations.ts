/**
 * Relaterat material via K-samsök (SPEC 6 "Senare": `relaterat`).
 *
 * Vad K-samsök faktiskt ger (undersökt 2026-11-18 för de tre testposterna,
 * Rök 1:1 och Falu gruva):
 * - `getRelations` för `raa/lamning/{uuid}` ger lämningens egna relationer
 *   (`replaces` → äldre FMI-poster `raa/fmi/{id}`) och härledda relationer
 *   (`source="deduced"`) som andra objekt har till lämningen: `isVisualizedBy`
 *   (bilder i `raa/dokumentation`, tjänsten arkiv-bilder), `isDescribedBy`
 *   (inventeringsboksuppslag m.m., tjänsten arkiv-dokument) och `sameAs`
 *   (t.ex. Samnordisk runtextdatabas). Bara relationstyp och URI – inga titlar.
 *   `relation` är ett objekt vid en relation och en lista vid flera.
 * - Många bilder pekar fortfarande på den äldre FMI-posten, inte på lämningen:
 *   Rök 1:1 har 47 objekt kopplade till lämningen och 168 till FMI-posten.
 * - Sökindexet `relUri` ger objekten som har en relation till en URI, med
 *   titel, beskrivning, typ, institution, tid, bildlänkar och medielicens
 *   (presentationsformatet). Ett anrop med `relUri=lämning OR relUri=FMI-post…`
 *   ger allt på en gång; lämningen själv kommer med (den ersätter FMI-posten)
 *   och sorteras bort.
 * - `itemId="uri" OR …` ger enskilda objekt; används bara för relationer som
 *   `relUri` inte täcker (relationer som står hos lämningen själv).
 *
 * Alltså högst tre anrop per lämning: getRelations, relUri-sökningen och
 * (sällan) ett objektuppslag. Resultatet cachas i KV (cache/kv.ts).
 */
import { KSAMSOK_API, KSAMSOK_LAMNING_URI } from "../../config";
import { UpstreamError } from "../../errors";
import type { UpstreamClient, UpstreamResponse } from "../../upstream/client";
import type { RelateratBild, RelateratLista, RelateratObjekt, RelateratSlag, RelationSource } from "../types";
import { asArray, extractXmlError, parseSearchResponse } from "./parse";
import { quote } from "./query";

/** Högst så många relationer begärs från getRelations. */
export const RELATIONER_MAX = 2000;
/** Högst så många objekt hämtas i relUri-sökningen (K-samsök tillåter 1–1 000 per sida). */
export const RELURI_MAX = 500;
/** Högst så många äldre FMI-poster tas med i relUri-sökningen. */
export const MAX_FMI = 10;
/** Högst så många objekt slås upp med itemId i ett anrop. */
export const MAX_OBJEKTUPPSLAG = 40;

export const FMI_URI_RE = /^http:\/\/kulturarvsdata\.se\/raa\/fmi\/\d{1,20}$/;
/** Objekt-URI i K-samsök: http://kulturarvsdata.se/{organisation}/{tjänst}/{id}. */
export const KSAMSOK_OBJEKT_URI_RE = /^http:\/\/kulturarvsdata\.se\/[A-Za-z0-9_-]{1,40}\/[A-Za-z0-9_-]{1,60}\/[A-Za-z0-9._:-]{1,120}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Relation {
	typ: string;
	uri: string;
	/** source="deduced": relationen står hos det andra objektet. */
	harledd: boolean;
}

export function relationsUrl(uuid: string): string {
	const u = new URL(KSAMSOK_API);
	u.searchParams.set("method", "getRelations");
	u.searchParams.set("relation", "all");
	u.searchParams.set("objectId", `raa/lamning/${uuid.toLowerCase()}`);
	u.searchParams.set("maxCount", String(RELATIONER_MAX));
	return u.href;
}

function sokUrl(query: string, hitsPerPage: number): string {
	const u = new URL(KSAMSOK_API);
	u.searchParams.set("method", "search");
	u.searchParams.set("query", query);
	u.searchParams.set("hitsPerPage", String(Math.max(1, Math.min(1000, hitsPerPage))));
	u.searchParams.set("startRecord", "1");
	u.searchParams.set("recordSchema", "presentation");
	return u.href;
}

/** `relUri="lämning" OR relUri="fmi"…` – objekt som har en relation till lämningen eller FMI-posterna. */
export function relUriUrl(uris: readonly string[]): string {
	return sokUrl(uris.map((u) => `relUri=${quote(u)}`).join(" OR "), RELURI_MAX);
}

/** `itemId="uri" OR …` – enskilda objekt. */
export function objektUrl(uris: readonly string[]): string {
	return sokUrl(uris.map((u) => `itemId=${quote(u)}`).join(" OR "), uris.length);
}

/** Tolka getRelations. Kastar UpstreamError med K-samsöks felmeddelande (JSON eller XML). */
export function parseRelations(raw: UpstreamResponse): Relation[] {
	const body = raw.body.trimStart();
	if (body.startsWith("<") || /xml/i.test(raw.contentType)) {
		throw new UpstreamError("ksamsok", `K-samsök svarade med fel (${raw.status}): ${extractXmlError(body)}`, raw.status);
	}
	let data: unknown;
	try {
		data = JSON.parse(body);
	} catch {
		if (raw.status >= 400) throw new UpstreamError("ksamsok", `K-samsök svarade ${raw.status}`, raw.status);
		throw new UpstreamError("ksamsok", `K-samsök svarade inte med JSON (status ${raw.status})`, raw.status);
	}
	const result = (data as { result?: Record<string, unknown> })?.result;
	if (!result || typeof result !== "object") throw new UpstreamError("ksamsok", `Oväntat svar från K-samsök (status ${raw.status})`, raw.status);
	if (typeof result.error === "string" || raw.status >= 400) {
		throw new UpstreamError("ksamsok", `K-samsök svarade med fel (${raw.status}): ${typeof result.error === "string" ? result.error : `status ${raw.status}`}`, raw.status);
	}
	const rel = (result.relations as { relation?: unknown } | undefined)?.relation;
	const out: Relation[] = [];
	for (const r of asArray(rel)) {
		const typ = (r as { type?: unknown })?.type;
		const uri = (r as { content?: unknown })?.content;
		if (typeof typ !== "string" || typeof uri !== "string" || !typ || !uri) continue;
		out.push({ typ, uri: uri.trim(), harledd: (r as { source?: unknown }).source === "deduced" });
	}
	return out;
}

// ---------------------------------------------------------------- presentationsposter

function text(x: unknown): string | null {
	if (typeof x === "string") return x.trim() || null;
	if (typeof x === "number") return String(x);
	if (x && typeof x === "object" && "content" in x) return text((x as { content: unknown }).content);
	return null;
}

/** En adress som får skrivas i ett svar: bara http(s), utan blanksteg, högst 500 tecken. */
export function sakerUrl(x: unknown): string | null {
	const s = text(x);
	if (!s || s.length > 500 || /[\s<>"]/.test(s)) return null;
	try {
		const u = new URL(s);
		return u.protocol === "https:" || u.protocol === "http:" ? s : null;
	} catch {
		return null;
	}
}

/** Årtal ur pres:timeLabel ("1933-01-01 00:00:00 - 1933-12-31 00:00:00" → "1933"). */
export function artal(tid: string | null): string | null {
	if (!tid) return null;
	const ar = [...tid.matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map((m) => m[1]);
	if (!ar.length) return null;
	const forsta = ar[0];
	const sista = ar[ar.length - 1];
	return forsta === sista ? forsta : `${forsta}–${sista}`;
}

function bilder(item: Record<string, unknown>): RelateratBild[] {
	const out: RelateratBild[] = [];
	for (const im of asArray(item["pres:image"] as unknown)) {
		if (!im || typeof im !== "object") continue;
		const i = im as Record<string, unknown>;
		let miniatyr: string | null = null;
		let stor: string | null = null;
		for (const s of asArray(i["pres:src"] as unknown)) {
			const typ = (s as { type?: unknown })?.type;
			const url = sakerUrl(s);
			if (!url) continue;
			if (typ === "thumbnail") miniatyr ??= url;
			else if (typ === "highres" || typ === "lowres") stor ??= url;
		}
		out.push({
			miniatyr,
			stor,
			licens: text(i["pres:mediaLicense"]),
			licens_url: sakerUrl(i["pres:mediaLicenseUrl"]),
			upphovsratt: text(i["pres:copyright"]),
			byline: text(i["pres:byline"]),
			motiv: text(i["pres:motive"]),
		});
		if (out.length >= 3) break;
	}
	return out;
}

/** Det av en presentationspost som används, före klassning. */
export interface PresObjekt {
	uri: string;
	typ: string | null;
	titel: string | null;
	beskrivning: string | null;
	institution: string | null;
	tjanst: string | null;
	tid: string | null;
	person: string | null;
	url: string | null;
	bilder: RelateratBild[];
	referenser: string[];
	idLabel: string | null;
}

const MAX_BESKRIVNING = 2000;

export function parsePresObjekt(rec: unknown): PresObjekt | null {
	const item = (rec as Record<string, unknown>)?.["pres:item"] as Record<string, unknown> | undefined;
	if (!item || typeof item !== "object") return null;
	const uri = text(item["pres:entityUri"]);
	if (!uri) return null;
	const ctx = asArray(item["pres:context"] as unknown).filter((c): c is Record<string, unknown> => !!c && typeof c === "object");
	const forsta = (k: string) => ctx.map((c) => text(c[k])).find((v) => v) ?? null;
	const reps = asArray(((item["pres:representations"] as Record<string, unknown> | undefined)?.["pres:representation"]) as unknown);
	const html = reps.find((r) => /^html$/i.test(String((r as { format?: unknown })?.format ?? "")));
	const refsRaw = item["pres:references"];
	const refs = refsRaw && typeof refsRaw === "object" ? asArray((refsRaw as Record<string, unknown>)["pres:reference"] as unknown) : [];
	const beskrivning = text(item["pres:description"]);
	return {
		uri,
		typ: text(item["pres:type"]),
		titel: text(item["pres:itemLabel"]),
		beskrivning: beskrivning && beskrivning.length > MAX_BESKRIVNING ? `${beskrivning.slice(0, MAX_BESKRIVNING)}…` : beskrivning,
		institution: text(item["pres:organization"]),
		tjanst: text(item["pres:service"]),
		tid: forsta("pres:timeLabel"),
		person: forsta("pres:nameLabel"),
		url: sakerUrl(html),
		bilder: bilder(item),
		referenser: refs.map(text).filter((r): r is string => !!r),
		idLabel: text(item["pres:idLabel"]),
	};
}

// ---------------------------------------------------------------- klassning

/**
 * Slag ur relationstyp, tjänst och typ. Bildtjänsten (arkiv-bilder,
 * Kulturmiljöbild) räknas som foto även för ritningar och teckningar; typen
 * står kvar i `typ`. Föremål: typen säger "föremål", eller museitjänsten
 * "object" (Historiska museet m.fl.) – inget sådant objekt hittades vid
 * undersökningen, så klassningen är oprövad mot riktiga relationer.
 */
export function klassa(o: { relationstyp: string | null; uri: string; typ: string | null; tjanst: string | null }): RelateratSlag {
	const typ = (o.typ ?? "").toLocaleLowerCase("sv");
	const tjanst = (o.tjanst ?? "").toLocaleLowerCase("sv");
	if (o.relationstyp === "replaces" || o.relationstyp === "isReplacedBy" || FMI_URI_RE.test(o.uri)) return "äldre post";
	if (o.relationstyp === "sameAs") return "övrigt";
	if (tjanst === "arkiv-bilder" || tjanst === "kmb" || /\/raa\/kmb\//.test(o.uri) || /^(foto|fotografi|bild|ritning|teckning)$/.test(typ)) return "foto";
	if (tjanst === "arkiv-dokument") return "arkivhandling";
	if (/föremål/.test(typ) || tjanst === "object") return "föremål";
	if (/\/raa\/dokumentation\//.test(o.uri) || o.relationstyp === "isDescribedBy") return "dokumentation";
	return "övrigt";
}

// ---------------------------------------------------------------- källan

export class KsamsokRelationSource implements RelationSource {
	constructor(
		private readonly client: UpstreamClient,
		private readonly now: () => Date = () => new Date(),
	) {}

	async hamtaRelaterat(uuidIn: string): Promise<RelateratLista> {
		const uuid = uuidIn.toLowerCase();
		if (!UUID_RE.test(uuid)) throw new UpstreamError("ksamsok", "ogiltigt UUID för relationsuppslag");
		const egen = `${KSAMSOK_LAMNING_URI}${uuid}`;
		const anmarkningar: string[] = [];
		let delvis_fel = false;

		const relationer = parseRelations(await this.client.get(relationsUrl(uuid)));
		const relPerUri = new Map<string, Relation>();
		for (const r of relationer) if (r.uri !== egen && !relPerUri.has(r.uri)) relPerUri.set(r.uri, r);
		const fmiAlla = [...new Set(relationer.filter((r) => r.typ === "replaces" && FMI_URI_RE.test(r.uri)).map((r) => r.uri))];
		const fmi = fmiAlla.slice(0, MAX_FMI);
		if (fmiAlla.length > fmi.length) anmarkningar.push(`Lämningen ersätter ${fmiAlla.length} äldre FMI-poster; material kopplat till de ${MAX_FMI} första togs med.`);

		// Objekten som pekar på lämningen eller på FMI-posterna, med uppgifter, i ett anrop.
		const sok = parseSearchResponse(await this.client.get(relUriUrl([egen, ...fmi])));
		let ofullstandig = sok.totalHits > sok.records.length;
		const objekt: RelateratObjekt[] = [];
		const sedda = new Set<string>([egen]);
		let lamningsnummer: string | null = null;
		const lagg = (p: PresObjekt) => {
			if (p.uri === egen) {
				if (p.idLabel && /^L\d{4}:\d+$/.test(p.idLabel)) lamningsnummer = p.idLabel;
				return;
			}
			if (sedda.has(p.uri)) return;
			sedda.add(p.uri);
			const rel = relPerUri.get(p.uri);
			// Utan relation till lämningen är objektet funnet via en FMI-post (referensen säger vilken).
			const kopplad = rel ? egen : (fmi.find((f) => p.referenser.includes(f)) ?? egen);
			objekt.push(tillObjekt(p, rel ?? null, kopplad));
		};
		for (const rec of sok.records) {
			const p = parsePresObjekt(rec);
			if (p) lagg(p);
		}

		// Relationer som relUri inte täckte (de som står hos lämningen själv), utom FMI-posterna.
		const kvar = [...relPerUri.values()].filter((r) => !sedda.has(r.uri) && !FMI_URI_RE.test(r.uri) && KSAMSOK_OBJEKT_URI_RE.test(r.uri));
		if (kvar.length) {
			const uppslag = kvar.slice(0, MAX_OBJEKTUPPSLAG);
			if (kvar.length > uppslag.length) {
				ofullstandig = true;
				anmarkningar.push(`${kvar.length - uppslag.length} relationer slogs inte upp (högst ${MAX_OBJEKTUPPSLAG} per anrop).`);
			}
			try {
				const svar = parseSearchResponse(await this.client.get(objektUrl(uppslag.map((r) => r.uri))));
				for (const rec of svar.records) {
					const p = parsePresObjekt(rec);
					if (p && relPerUri.has(p.uri)) lagg(p);
				}
			} catch (err) {
				if (!(err instanceof UpstreamError)) throw err;
				delvis_fel = true;
				anmarkningar.push(`Uppgifter om ${uppslag.length} objekt kunde inte hämtas (${err.message}); bara relationen visas.`);
			}
		}
		// Relationer utan uppgifter i K-samsök (bl.a. FMI-posterna) visas med bara relation och URI.
		for (const r of relPerUri.values()) {
			if (sedda.has(r.uri)) continue;
			sedda.add(r.uri);
			objekt.push(bartObjekt(r, egen));
		}
		if (ofullstandig) anmarkningar.push(`K-samsök har ${sok.totalHits} objekt kopplade till lämningen; de ${sok.records.length} första hämtades.`);

		return { uuid, lamningsnummer, objekt: sortera(objekt), relationer: relationer.length, ofullstandig, hamtad: this.now().toISOString(), delvis_fel, anmarkningar };
	}
}

function tillObjekt(p: PresObjekt, rel: Relation | null, kopplad: string): RelateratObjekt {
	const relationstyp = rel?.typ ?? null;
	return {
		slag: klassa({ relationstyp, uri: p.uri, typ: p.typ, tjanst: p.tjanst }),
		relationstyp,
		harledd: rel ? rel.harledd : null,
		kopplad_till: kopplad,
		uri: p.uri,
		typ: p.typ,
		titel: p.titel,
		beskrivning: p.beskrivning,
		institution: p.institution,
		tjanst: p.tjanst,
		tid: p.tid,
		artal: artal(p.tid),
		person: p.person,
		url: p.url,
		bilder: p.bilder,
		uppgifter: true,
	};
}

function bartObjekt(r: Relation, egen: string): RelateratObjekt {
	return {
		slag: klassa({ relationstyp: r.typ, uri: r.uri, typ: null, tjanst: null }),
		relationstyp: r.typ,
		harledd: r.harledd,
		kopplad_till: egen,
		uri: r.uri,
		typ: null,
		titel: null,
		beskrivning: null,
		institution: null,
		tjanst: null,
		tid: null,
		artal: null,
		person: null,
		url: null,
		bilder: [],
		uppgifter: false,
	};
}

/** Slag i fast ordning; inom slaget objekt kopplade till lämningen före dem via FMI-poster, annars K-samsöks ordning. */
function sortera(objekt: RelateratObjekt[]): RelateratObjekt[] {
	const ordning = ["foto", "arkivhandling", "föremål", "dokumentation", "äldre post", "övrigt"];
	const egen = (o: RelateratObjekt) => (o.kopplad_till.includes("/raa/lamning/") ? 0 : 1);
	return objekt
		.map((o, i) => ({ o, i }))
		.sort((a, b) => ordning.indexOf(a.o.slag) - ordning.indexOf(b.o.slag) || egen(a.o) - egen(b.o) || a.i - b.i)
		.map((x) => x.o);
}
