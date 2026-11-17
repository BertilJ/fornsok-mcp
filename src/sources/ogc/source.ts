/**
 * RAÄ:s OGC API Features (GeoServer, samlingen `kulturhistoriska_fornlamningar`).
 * Ett objekt per geometri; deduplicering sker i verktyget.
 */
import { OGC_ITEMS } from "../../config";
import { UpstreamError } from "../../errors";
import type { Geometry } from "../../geo/geometry";
import type { UpstreamClient } from "../../upstream/client";
import type { NearbyFeature, NearbyPage, NearbyQuery, NearbySource } from "../types";
import { buildCql2 } from "./cql2";

const UUID_AT_END = /\/lamning\/([0-9a-fA-F-]{36})$/;

export function buildItemsUrl(q: NearbyQuery): string {
	const u = new URL(OGC_ITEMS);
	u.searchParams.set("f", "application/geo+json");
	u.searchParams.set("bbox", q.bbox.map((n) => (Math.round(n * 1e6) / 1e6).toString()).join(","));
	u.searchParams.set("limit", String(q.limit));
	const filter = buildCql2({ lamningstyp: q.lamningstyp, antikvariskbedomning: q.antikvarisk_bedomning });
	if (filter) {
		u.searchParams.set("filter-lang", "cql2-text");
		u.searchParams.set("filter", filter);
	}
	return u.href;
}

function str(x: unknown): string | null {
	return typeof x === "string" && x.length > 0 ? x : null;
}

export function parseFeatureCollection(data: unknown): NearbyPage {
	const fc = data as { numberMatched?: unknown; numberReturned?: unknown; features?: unknown };
	if (!fc || !Array.isArray(fc.features)) {
		throw new UpstreamError("ogc", "Oväntat svar från OGC API Features");
	}
	const features: NearbyFeature[] = [];
	for (const f of fc.features as Array<{ properties?: Record<string, unknown>; geometry?: Geometry | null }>) {
		const p = f.properties ?? {};
		const nr = str(p.lamningsnummer);
		if (!nr || !f.geometry) continue;
		const url = str(p.url);
		const m = url ? UUID_AT_END.exec(url) : null;
		features.push({
			lamningsnummer: nr,
			uuid: m ? m[1].toLowerCase() : null,
			raa_nummer: str(p.raa_nummer),
			lamningstyp: str(p.lamningstyp),
			antikvarisk_bedomning: str(p.antikvariskbedomning),
			lamningsnamn: str(p.lamningsnamn),
			kommun: str(p.kommun),
			lan: str(p.lan),
			url,
			geometry: f.geometry,
		});
	}
	const nm = fc.numberMatched === undefined ? Number.NaN : Number(fc.numberMatched);
	const nr = fc.numberReturned === undefined ? (fc.features as unknown[]).length : Number(fc.numberReturned);
	return { numberMatched: Number.isFinite(nm) ? nm : null, numberReturned: Number.isFinite(nr) ? nr : null, features };
}

export class OgcSource implements NearbySource {
	constructor(private readonly client: UpstreamClient) {}

	async featuresInBbox(q: NearbyQuery): Promise<NearbyPage> {
		const raw = await this.client.get(buildItemsUrl(q), "application/geo+json");
		if (raw.status >= 400) {
			throw new UpstreamError("ogc", `OGC API Features svarade ${raw.status}`, raw.status);
		}
		let data: unknown;
		try {
			data = JSON.parse(raw.body);
		} catch {
			throw new UpstreamError("ogc", "OGC API Features svarade inte med JSON", raw.status);
		}
		return parseFeatureCollection(data);
	}
}
