/**
 * Metadata i Vectorize och översättning av sökfilter till metadatafilter.
 *
 * Vectorize (developers.cloudflare.com/vectorize/reference/metadata-filtering,
 * läst 2026-11-17):
 * - Metadataindex av typen string indexerar de första 64 byten (avkortat vid
 *   teckengräns). Värdena kortas därför här på samma sätt både när de skrivs
 *   och när de filtreras.
 * - Listor i metadata indexeras inte. En lämning i flera socknar/kommuner/län/
 *   landskap får därför en vektor per kombination (id uuid, uuid#1, …), och
 *   träffarna slås ihop per uuid.
 * - Filter: $eq, $ne, $in, $nin, $lt, $lte, $gt, $gte; flera nycklar
 *   OCH-kopplas; filtrets kompakta JSON måste vara under 2 048 byte.
 */
import type { ResolvedSearchFilter } from "../sources/types";

export const INDEXERADE = ["typ", "bedomning", "lan", "kommun", "socken", "landskap"] as const;
export type IndexeradNyckel = (typeof INDEXERADE)[number];

export const MAX_INDEXERAD_BYTE = 64;
export const MAX_FILTER_BYTE = 2048;
/** Högst så många vektorer per lämning. Fler kombinationer → varje värde minst en gång (se varianter). */
export const MAX_VARIANTER = 16;

const enc = new TextEncoder();

/** Korta till högst 64 byte UTF-8 vid teckengräns (som Vectorize gör vid indexering). */
export function kort64(s: string): string {
	if (enc.encode(s).length <= MAX_INDEXERAD_BYTE) return s;
	let out = "";
	let n = 0;
	for (const ch of s) {
		const b = enc.encode(ch).length;
		if (n + b > MAX_INDEXERAD_BYTE) break;
		out += ch;
		n += b;
	}
	return out;
}

export interface LamningsMeta {
	uuid: string;
	lamningsnummer: string | null;
	typ: string | null;
	bedomning: string | null;
	lan: string[];
	kommun: string[];
	socken: string[];
	landskap: string[];
}

export type VektorMetadata = Record<string, string>;

/**
 * Metadata per vektor. En kombination per vektor när lämningen ligger i flera
 * områden: hela korsprodukten om den ryms i MAX_VARIANTER, annars så många
 * vektorer som den längsta listan, där varje värde förekommer minst en gång.
 */
export function varianter(m: LamningsMeta): VektorMetadata[] {
	const listor: Array<[IndexeradNyckel, string[]]> = [
		["lan", m.lan],
		["kommun", m.kommun],
		["socken", m.socken],
		["landskap", m.landskap],
	];
	const bas: VektorMetadata = { uuid: m.uuid };
	if (m.lamningsnummer) bas.lamningsnummer = m.lamningsnummer;
	if (m.typ) bas.typ = kort64(m.typ);
	if (m.bedomning) bas.bedomning = kort64(m.bedomning);
	const vals = listor.map(
		([k, v]) => [k, [...new Set(v.map(kort64))]] as [IndexeradNyckel, string[]],
	);
	const produkt = vals.reduce((n, [, v]) => n * Math.max(1, v.length), 1);
	const out: VektorMetadata[] = [];
	if (produkt <= MAX_VARIANTER) {
		let acc: VektorMetadata[] = [{ ...bas }];
		for (const [k, v] of vals) {
			if (!v.length) continue;
			acc = acc.flatMap((a) => v.map((x) => ({ ...a, [k]: x })));
		}
		out.push(...acc);
	} else {
		const n = Math.min(MAX_VARIANTER, Math.max(...vals.map(([, v]) => v.length)));
		for (let i = 0; i < n; i++) {
			const a: VektorMetadata = { ...bas };
			for (const [k, v] of vals) if (v.length) a[k] = v[i % v.length];
			out.push(a);
		}
	}
	return out;
}

export function vektorId(uuid: string, i: number): string {
	return i === 0 ? uuid : `${uuid}#${i}`;
}

export function uuidUrId(id: string): string {
	const i = id.indexOf("#");
	return i < 0 ? id : id.slice(0, i);
}

export interface OversattFilter {
	filter: VectorizeVectorMetadataFilter | undefined;
	/** Delar av sökfiltret som inte tillämpas i Vectorize; verktyget kontrollerar träffarna mot dem i D1. */
	ejTillampat: string[];
}

function inLista(v: readonly string[]): { $in: string[] } | string {
	const u = [...new Set(v.map(kort64))];
	return u.length === 1 ? u[0] : { $in: u };
}

/**
 * Sökfilter → metadatafilter. Det som går att uttrycka (typ, bedömning, län,
 * kommun, socken, landskap) läggs i filtret; resten listas i `ejTillampat`.
 * Blir filtret för stort tas den största delen bort tills det ryms.
 */
export function tillVectorizeFilter(f: ResolvedSearchFilter): OversattFilter {
	const ej: string[] = [];
	const parts: Array<[IndexeradNyckel, string[]]> = [];
	if (f.lamningstyp?.length) parts.push(["typ", f.lamningstyp]);
	if (f.antikvarisk_bedomning?.length) parts.push(["bedomning", [...f.antikvarisk_bedomning]]);
	if (f.kommun?.length) parts.push(["kommun", f.kommun]);
	if (f.landskap?.length) parts.push(["landskap", f.landskap]);
	if (f.socken?.length) {
		parts.push(["socken", f.socken.map((s) => s.namn)]);
		// Socknens länsavgränsning: bara om inget länfilter finns och alla socknar har en.
		const sockenLan = f.socken.every((s) => s.lan?.length)
			? [...new Set(f.socken.flatMap((s) => s.lan ?? []))]
			: null;
		if (!f.lan?.length && sockenLan) parts.push(["lan", sockenLan]);
		if (f.socken.some((s) => s.kommun?.length)) ej.push("socken.kommun");
	}
	if (f.lan?.length) parts.push(["lan", f.lan]);
	if (f.nummer?.length) ej.push("nummer");
	if (f.kategori?.length) ej.push("kategori");
	if (f.egenskap?.length) ej.push("egenskap");
	if (f.nara) ej.push("nara");
	if (f.bbox) ej.push("bbox");
	if (f.ord?.length) ej.push("ord");

	const filter: Record<string, { $in: string[] } | string> = {};
	for (const [k, v] of parts) filter[k] = inLista(v);
	const size = () => enc.encode(JSON.stringify(filter)).length;
	while (Object.keys(filter).length && size() >= MAX_FILTER_BYTE) {
		const largest = Object.keys(filter).sort(
			(a, b) => JSON.stringify(filter[b]).length - JSON.stringify(filter[a]).length,
		)[0];
		delete filter[largest];
		ej.push(largest);
	}
	return {
		filter: Object.keys(filter).length ? (filter as VectorizeVectorMetadataFilter) : undefined,
		ejTillampat: ej,
	};
}
