/**
 * Fornsök-appens läs-API: fullständig post (RecordSource) och värdelistor
 * (DomainSource). Bara GET mot listade läsanrop – se upstream/allowlist.ts.
 */
import { FORNSOK_APP_API } from "../../config";
import { UpstreamError } from "../../errors";
import type { UpstreamClient } from "../../upstream/client";
import type { DomainSource, Domaner, RecordFetchResult, RecordSource } from "../types";
import { parseAppLamning, parseDomaner } from "./parse";

export class FornsokAppSource implements RecordSource, DomainSource {
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
}
