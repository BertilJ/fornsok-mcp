/**
 * K-samsök som källa: ordsök (SearchSource), nummer → UUID (IdResolver) och
 * reservpost via JSON-LD (RecordSource).
 */
import { KSAMSOK_LAMNING_HTTPS } from "../../config";
import { UpstreamError } from "../../errors";
import type { UpstreamClient } from "../../upstream/client";
import type { IdResolver, RecordFetchResult, RecordSource, ResolvedSearchFilter, SearchPage, SearchSource } from "../types";
import {
	mergeHit,
	parseFieldsRecord,
	parseJsonLd,
	parsePresentationRecord,
	parseSearchResponse,
	splitNumbers,
	uuidFromUri,
	type FieldMap,
	type PresentationItem,
} from "./parse";
import { BASE_QUERY, buildQuery, buildSearchUrl, quote } from "./query";

export class KsamsokSource implements SearchSource, IdResolver, RecordSource {
	constructor(private readonly client: UpstreamClient) {}

	/**
	 * En sökning görs som två parallella anrop med samma fråga och sida:
	 * `recordSchema=presentation` (koordinat, beskrivning för utdrag) och
	 * `recordSchema=xml` + `fields` (bedömning, nummer, indelning). Ingen av
	 * dem har allt. Träffarna slås ihop på UUID.
	 */
	async search(filter: ResolvedSearchFilter, page: { antal: number; sida: number }): Promise<SearchPage> {
		const query = buildQuery(filter);
		const startRecord = (page.sida - 1) * page.antal + 1;
		const [presRaw, fieldsRaw] = await Promise.all([
			this.client.get(buildSearchUrl(query, { hitsPerPage: page.antal, startRecord, recordSchema: "presentation" })),
			this.client.get(buildSearchUrl(query, { hitsPerPage: page.antal, startRecord, recordSchema: "xml" })),
		]);
		const pres = parseSearchResponse(presRaw);
		const fields = parseSearchResponse(fieldsRaw);

		const presById = new Map<string, PresentationItem>();
		let byggdatum: string | null = null;
		for (const r of pres.records) {
			const p = parsePresentationRecord(r);
			if (p) {
				presById.set(p.uuid.toLowerCase(), p);
				if (p.buildDate && (!byggdatum || p.buildDate > byggdatum)) byggdatum = p.buildDate;
			}
		}
		const fieldMaps: FieldMap[] = fields.records.map(parseFieldsRecord);
		const order: string[] = [];
		const fieldsById = new Map<string, FieldMap>();
		for (const f of fieldMaps) {
			const id = uuidFromUri(f.get("itemId")?.[0]);
			if (id) {
				fieldsById.set(id, f);
				order.push(id);
			}
		}
		// Ordningen från fältsvaret gäller; presentationsträffar som saknas där läggs sist.
		for (const id of presById.keys()) if (!fieldsById.has(id)) order.push(id);
		const traffar = order
			.map((id) => mergeHit(fieldsById.get(id), presById.get(id)))
			.filter((h): h is NonNullable<typeof h> => h !== null);
		return { totalt: fields.totalHits || pres.totalHits, traffar, kalla: "K-samsök", byggdatum };
	}

	/** Lämningsnummer/RAÄ-nummer → UUID med ett anrop (OR-kopplat på `itemNumber`). */
	async resolveNumbers(numbers: string[]): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		if (numbers.length === 0) return out;
		const clauses = numbers.map((n) => `itemNumber=${quote(n)}`);
		const query = `${BASE_QUERY} AND (${clauses.join(" OR ")})`;
		const raw = await this.client.get(
			buildSearchUrl(query, { hitsPerPage: Math.min(100, numbers.length * 5), startRecord: 1, recordSchema: "xml" }),
		);
		const res = parseSearchResponse(raw);
		const wanted = new Map(numbers.map((n) => [normalizeNumber(n), n]));
		for (const rec of res.records) {
			const f = parseFieldsRecord(rec);
			const uuid = uuidFromUri(f.get("itemId")?.[0]);
			if (!uuid) continue;
			// Bara exakta träffar räknas (K-samsök kan matcha delar av nummer).
			for (const n of f.get("itemNumber") ?? []) {
				const orig = wanted.get(normalizeNumber(n));
				if (orig && !out.has(orig)) out.set(orig, uuid);
			}
		}
		return out;
	}

	async getByUuid(uuid: string): Promise<RecordFetchResult | null> {
		const raw = await this.client.get(`${KSAMSOK_LAMNING_HTTPS}${uuid.toLowerCase()}`, "application/ld+json");
		if (raw.status === 404) return null;
		if (raw.status >= 400) {
			throw new UpstreamError("ksamsok", `K-samsök svarade ${raw.status} för ${uuid}`, raw.status);
		}
		let doc: unknown;
		try {
			doc = JSON.parse(raw.body);
		} catch {
			throw new UpstreamError("ksamsok", "K-samsök svarade inte med JSON-LD", raw.status);
		}
		return parseJsonLd(doc);
	}
}

export function normalizeNumber(n: string): string {
	return n.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("sv");
}

export { splitNumbers };
