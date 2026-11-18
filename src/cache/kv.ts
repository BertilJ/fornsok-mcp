/**
 * Cache i Workers KV (bindningen `CACHE`), för värdelistor och dokumentlistor
 * (SPEC 5.4). Valfri: utan bindning går allt direkt mot källan. Fel i KV får
 * aldrig fälla ett anrop – då hämtas från källan som vanligt.
 */
import { domanerProblem } from "../lookup/domains";
import { KSAMSOK_OBJEKT_URI_RE } from "../sources/ksamsok/relations";
import { type DocumentSource, type DokumentFil, type DokumentFilSvar, type DokumentLista, type DomainSource, type Domaner, RELATERAT_SLAG, type RelateratLista, type RelateratObjekt, type RelationSource } from "../sources/types";

/** Det lilla av KVNamespace som används (gör det lätt att testa). */
export interface KvLike {
	get(key: string, type: "json"): Promise<unknown>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** Värdelistor: 24 timmar i KV (med minnescache framför, se DomainService). */
export const DOMANER_KV_TTL_S = 24 * 60 * 60;
/** Dokumentlistor: 1 timme. */
export const DOKUMENT_KV_TTL_S = 60 * 60;

/** Relaterat material från K-samsök: 7 dygn (relationerna ändras sällan; K-samsök ligger ändå några dagar efter). */
export const RELATERAT_KV_TTL_S = 7 * 24 * 60 * 60;
/** Tom lista: bara ett dygn (K-samsök kan sakna en ny lämning några dagar). */
export const RELATERAT_TOM_KV_TTL_S = 24 * 60 * 60;

/** Nycklarna har version så att ändrad form kan rullas ut utan att läsa gammalt. */
export const DOMANER_KEY = "domaner:v1";
export const dokumentKey = (uuid: string) => `dokument:v1:${uuid.toLowerCase()}`;
/**
 * Höjs när hämtningen eller klassningen ändras (v2: klassning av ej uppslagna
 * objekt, länkkontroll, okänd koppling; v3: sidindelningen i relUri kliver efter
 * de poster som kom, så sparade listor kan sakna objekt, och FMI-poster märks
 * som ej uppslagna).
 */
export const RELATERAT_VERSION = 3;
export const relateratKey = (uuid: string) => `relaterat:v${RELATERAT_VERSION}:${uuid.toLowerCase()}`;

export async function kvCached<T>(
	kv: KvLike | undefined,
	key: string,
	ttlS: number,
	load: () => Promise<T>,
	isValid: (v: unknown) => v is T,
): Promise<T> {
	if (!kv) return load();
	try {
		const hit = await kv.get(key, "json");
		if (hit !== null && isValid(hit)) return hit;
	} catch (err) {
		console.warn(`cache: KV-läsning misslyckades för ${key}:`, err instanceof Error ? err.message : String(err));
	}
	const value = await load();
	// Bara giltiga värden cachas (t.ex. aldrig tomma värdelistor).
	if (!isValid(value)) return value;
	try {
		await kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttlS) });
	} catch (err) {
		console.warn(`cache: KV-skrivning misslyckades för ${key}:`, err instanceof Error ? err.message : String(err));
	}
	return value;
}

function isDomaner(v: unknown): v is Domaner {
	return domanerProblem(v as Domaner | null) === null && typeof (v as Domaner).hamtad === "string";
}

function isDokumentLista(v: unknown): v is DokumentLista {
	const d = v as DokumentLista | null;
	return !!d && typeof d.uuid === "string" && Array.isArray(d.dokument);
}

/** Värdelistor via KV. */
export class KvDomainSource implements DomainSource {
	constructor(
		private readonly inner: DomainSource,
		private readonly kv: KvLike | undefined,
	) {}

	loadDomaner(): Promise<Domaner> {
		return kvCached(this.kv, DOMANER_KEY, DOMANER_KV_TTL_S, () => this.inner.loadDomaner(), isDomaner);
	}
}

/** Dokumentlistor via KV. Filerna själva cachas inte. */
export class KvDocumentSource implements DocumentSource {
	constructor(
		private readonly inner: DocumentSource,
		private readonly kv: KvLike | undefined,
	) {}

	listDokument(uuid: string): Promise<DokumentLista> {
		return kvCached(this.kv, dokumentKey(uuid), DOKUMENT_KV_TTL_S, () => this.inner.listDokument(uuid), isDokumentLista);
	}

	hamtaBild(fil: DokumentFil, maxBytes: number): Promise<DokumentFilSvar> {
		return this.inner.hamtaBild(fil, maxBytes);
	}

	filUrl(fil: DokumentFil): string | null {
		return this.inner.filUrl(fil);
	}
}

const strEllerNull = (x: unknown) => x === null || typeof x === "string";

function isRelateratObjekt(v: unknown): v is RelateratObjekt {
	const o = v as RelateratObjekt | null;
	return (
		!!o &&
		typeof o === "object" &&
		(RELATERAT_SLAG as readonly string[]).includes(o.slag) &&
		typeof o.uri === "string" &&
		KSAMSOK_OBJEKT_URI_RE.test(o.uri) &&
		(o.kopplad_till === null || (typeof o.kopplad_till === "string" && KSAMSOK_OBJEKT_URI_RE.test(o.kopplad_till))) &&
		strEllerNull(o.relationstyp) &&
		strEllerNull(o.titel) &&
		strEllerNull(o.url) &&
		Array.isArray(o.bilder) &&
		typeof o.uppgifter === "boolean" &&
		typeof o.uppslagen === "boolean"
	);
}

/** En sparad lista: rätt form, rätt lämning, inget delvis fel. */
export function isRelateratLista(v: unknown, uuid?: string): v is RelateratLista {
	const r = v as RelateratLista | null;
	return (
		!!r &&
		typeof r.uuid === "string" &&
		(uuid === undefined || r.uuid === uuid.toLowerCase()) &&
		strEllerNull(r.lamningsnummer) &&
		Array.isArray(r.objekt) &&
		r.objekt.every(isRelateratObjekt) &&
		typeof r.relationer === "number" &&
		typeof r.ofullstandig === "boolean" &&
		typeof r.hamtad === "string" &&
		Array.isArray(r.anmarkningar) &&
		r.anmarkningar.every((a) => typeof a === "string") &&
		r.delvis_fel === false
	);
}

/**
 * Relaterat material via KV: 7 dygn, tomma listor 1 dygn. Fel från K-samsök,
 * och listor där en del inte kunde hämtas, cachas inte. Ett svar ur KV märks
 * `sparad: true`, så att källraden kan säga att det är sparat och när det hämtades.
 */
export class KvRelationSource implements RelationSource {
	constructor(
		private readonly inner: RelationSource,
		private readonly kv: KvLike | undefined,
	) {}

	async hamtaRelaterat(uuid: string): Promise<RelateratLista> {
		const key = relateratKey(uuid);
		if (this.kv) {
			try {
				const hit = await this.kv.get(key, "json");
				if (hit !== null && isRelateratLista(hit, uuid)) return { ...hit, sparad: true };
			} catch (err) {
				console.warn(`cache: KV-läsning misslyckades för ${key}:`, err instanceof Error ? err.message : String(err));
			}
		}
		const value = await this.inner.hamtaRelaterat(uuid);
		if (!this.kv || !isRelateratLista(value, uuid)) return value;
		const { sparad: _, ...lagra } = value;
		try {
			await this.kv.put(key, JSON.stringify(lagra), { expirationTtl: value.objekt.length ? RELATERAT_KV_TTL_S : RELATERAT_TOM_KV_TTL_S });
		} catch (err) {
			console.warn(`cache: KV-skrivning misslyckades för ${key}:`, err instanceof Error ? err.message : String(err));
		}
		return value;
	}
}
