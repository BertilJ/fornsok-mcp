/**
 * Cache i Workers KV (bindningen `CACHE`), för värdelistor och dokumentlistor
 * (SPEC 5.4). Valfri: utan bindning går allt direkt mot källan. Fel i KV får
 * aldrig fälla ett anrop – då hämtas från källan som vanligt.
 */
import { domanerProblem } from "../lookup/domains";
import type { DocumentSource, DokumentFil, DokumentFilSvar, DokumentLista, DomainSource, Domaner } from "../sources/types";

/** Det lilla av KVNamespace som används (gör det lätt att testa). */
export interface KvLike {
	get(key: string, type: "json"): Promise<unknown>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** Värdelistor: 24 timmar i KV (med minnescache framför, se DomainService). */
export const DOMANER_KV_TTL_S = 24 * 60 * 60;
/** Dokumentlistor: 1 timme. */
export const DOKUMENT_KV_TTL_S = 60 * 60;

/** Nycklarna har version så att ändrad form kan rullas ut utan att läsa gammalt. */
export const DOMANER_KEY = "domaner:v1";
export const dokumentKey = (uuid: string) => `dokument:v1:${uuid.toLowerCase()}`;

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
