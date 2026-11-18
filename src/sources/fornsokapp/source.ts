/**
 * Fornsök-appens läs-API: fullständig post (RecordSource), värdelistor
 * (DomainSource), dokument (DocumentSource) och versionshistorik
 * (HistorySource). Bara GET mot listade läsanrop – se upstream/allowlist.ts.
 */
import { FORNSOK_APP_API } from "../../config";
import { UpstreamError } from "../../errors";
import type { UpstreamClient } from "../../upstream/client";
import type {
	DocumentSource,
	DokumentFil,
	DokumentFilSvar,
	DokumentLista,
	DomainSource,
	Domaner,
	HistorySource,
	RecordFetchResult,
	RecordSource,
	Version,
} from "../types";
import { FIL_ID_RE, parseDokumentLista, parseVersioner } from "./dokument";
import { parseAppLamning, parseDomaner } from "./parse";

/** Filändelser som får hämtas som bild (samma som i listan över tillåtna anrop). */
const BILD_RE = /\.(jpe?g|png)$/i;

export class FornsokAppSource implements RecordSource, DomainSource, DocumentSource, HistorySource {
	constructor(
		private readonly client: UpstreamClient,
		/** Värdelistor för att lägga till kategori på posten (valfritt). */
		private readonly domaner?: () => Promise<Domaner | null>,
	) {}

	async getByUuid(uuid: string): Promise<RecordFetchResult | null> {
		const raw = await this.client.get(`${FORNSOK_APP_API}/lamning/lamning/${uuid.toLowerCase()}`);
		if (raw.status === 404) return null;
		if (raw.status >= 400) throw new UpstreamError("fornsokapp", `Fornsök-appen svarade ${raw.status}`, raw.status);
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(raw.body) as Record<string, unknown>;
		} catch {
			throw new UpstreamError("fornsokapp", "Fornsök-appen svarade inte med JSON", raw.status);
		}
		const dom = this.domaner ? await this.domaner().catch(() => null) : null;
		return parseAppLamning(data, dom);
	}

	async loadDomaner(): Promise<Domaner> {
		const [l, u] = await Promise.all([
			this.client.getJson<Record<string, unknown>>(`${FORNSOK_APP_API}/lamning/domaner`),
			this.client.getJson<Record<string, unknown>>(`${FORNSOK_APP_API}/uppdrag/domaner`),
		]);
		if (l.status >= 400 || u.status >= 400) {
			throw new UpstreamError("fornsokapp", `Fornsök-appen svarade ${l.status}/${u.status} för värdelistorna`);
		}
		return parseDomaner(l.data, u.data);
	}

	async listDokument(uuid: string): Promise<DokumentLista> {
		const id = uuid.toLowerCase();
		const raw = await this.client.get(`${FORNSOK_APP_API}/lamning/dokument?lamning_id=${id}`);
		// 404 betyder "Inga dokument finns för lämning med id …" (inspelat 2026-11-17).
		if (raw.status === 404) return { uuid: id, lamningsnummer: null, dokument: [] };
		if (raw.status >= 400) throw new UpstreamError("fornsokapp", `Fornsök-appen svarade ${raw.status} för dokumentlistan`, raw.status);
		let data: unknown;
		try {
			data = JSON.parse(raw.body);
		} catch {
			throw new UpstreamError("fornsokapp", "Fornsök-appen svarade inte med JSON för dokumentlistan", raw.status);
		}
		if (data === null || typeof data !== "object" || Array.isArray(data)) {
			throw new UpstreamError("fornsokapp", "Fornsök-appens dokumentlista hade oväntad form", raw.status);
		}
		return parseDokumentLista(id, data as Record<string, unknown>);
	}

	filUrl(fil: DokumentFil): string | null {
		if (!FIL_ID_RE.test(fil.id) || /[/\\]/.test(fil.namn)) return null;
		return `${FORNSOK_APP_API}/lamning/dokument/fil/${kodaStrikt(fil.id)}/${kodaStrikt(fil.namn)}`;
	}

	async hamtaBild(fil: DokumentFil, maxBytes: number): Promise<DokumentFilSvar> {
		const url = this.filUrl(fil);
		if (!url || !BILD_RE.test(fil.namn)) throw new UpstreamError("fornsokapp", "Filen är ingen bildfil som kan hämtas");
		const r = await this.client.getBytes(url, "image/jpeg, image/png", maxBytes);
		return {
			status: r.status,
			mimeType: r.contentType.split(";")[0].trim().toLowerCase(),
			contentLength: r.contentLength,
			bytes: r.bytes,
			tooLarge: r.tooLarge,
		};
	}

	async getVersioner(uuid: string): Promise<Version[] | null> {
		const raw = await this.client.get(`${FORNSOK_APP_API}/lamning/lamning/${uuid.toLowerCase()}/version`);
		if (raw.status === 404) return null;
		if (raw.status >= 400) throw new UpstreamError("fornsokapp", `Fornsök-appen svarade ${raw.status} för versionshistoriken`, raw.status);
		let data: unknown;
		try {
			data = JSON.parse(raw.body);
		} catch {
			throw new UpstreamError("fornsokapp", "Fornsök-appen svarade inte med JSON för versionshistoriken", raw.status);
		}
		if (!Array.isArray(data)) throw new UpstreamError("fornsokapp", "Fornsök-appens versionshistorik hade oväntad form", raw.status);
		return parseVersioner(data);
	}
}

/** encodeURIComponent och dessutom ! ' ( ) * (RFC 3986), som listan över tillåtna anrop kräver kodade. */
export function kodaStrikt(x: string): string {
	return encodeURIComponent(x).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
