/**
 * Bygger K-samsöks CQL-frågor och sökadresser. Fällorna i SPEC 3 är inbyggda:
 * - organisation `raä` (inte `raa`) och tjänst `kmr_lamningar`,
 * - ord OCH-kopplas (ett citerat flerordsvärde matchar som ELLER),
 * - nummer via `itemNumber`, typ via `itemName`, bedömning via `itemSpecification`,
 * - `boundingBox=/WGS84 "minLon minLat maxLon maxLat"`,
 * - värden citeras med `"` och `\` undantagna.
 */
import { KSAMSOK_API } from "../../config";
import type { ResolvedSearchFilter } from "../types";

export const BASE_QUERY = 'serviceOrganization="raä" AND serviceName="kmr_lamningar"';

/** Fält som hämtas i `recordSchema=xml`. Okänt fältnamn ger HTTP 400 – ändra med försiktighet. */
export const SEARCH_FIELDS = [
	"itemId",
	"itemNumber",
	"itemName",
	"itemSpecification",
	"municipalityName",
	"parishName",
	"countyName",
	"provinceName",
] as const;

/** Citera ett värde för CQL: `"…"` med `\` och `"` undantagna. */
export function quote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function clause(index: string, value: string): string {
	return `${index}=${quote(value)}`;
}

function anyOf(index: string, values: readonly string[]): string {
	const parts = values.map((v) => clause(index, v));
	return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
}

/**
 * Dela en fritextfråga i ord. Skiljetecken i ordens kanter tas bort; ord som
 * bara består av skiljetecken stryks. Varje ord blir ett eget `text="…"`.
 */
export function splitWords(fraga: string): string[] {
	return fraga
		.normalize("NFC")
		.split(/\s+/)
		.map((w) => w.replace(/^[^\p{L}\p{N}*]+|[^\p{L}\p{N}*]+$/gu, ""))
		.filter((w) => w.length > 0)
		.slice(0, 12);
}

function num(n: number): string {
	return (Math.round(n * 1e6) / 1e6).toString();
}

export function bboxClause(b: readonly [number, number, number, number]): string {
	return `boundingBox=/WGS84 "${num(b[0])} ${num(b[1])} ${num(b[2])} ${num(b[3])}"`;
}

/** Hela CQL-frågan för ett upplöst filter. */
export function buildQuery(f: ResolvedSearchFilter): string {
	const parts: string[] = [BASE_QUERY];
	for (const w of f.ord ?? []) parts.push(clause("text", w));
	if (f.nummer?.length) parts.push(anyOf("itemNumber", f.nummer));
	if (f.lamningstyp?.length) parts.push(anyOf("itemName", f.lamningstyp));
	if (f.antikvarisk_bedomning?.length) parts.push(anyOf("itemSpecification", f.antikvarisk_bedomning));
	if (f.kommun?.length) parts.push(anyOf("municipalityName", f.kommun));
	if (f.socken?.length) {
		const s = f.socken.map((x) =>
			x.lan?.length ? `(${clause("parishName", x.namn)} AND ${anyOf("countyName", x.lan)})` : clause("parishName", x.namn),
		);
		parts.push(s.length === 1 ? s[0] : `(${s.join(" OR ")})`);
	}
	if (f.landskap?.length) parts.push(anyOf("provinceName", f.landskap));
	if (f.lan?.length) parts.push(anyOf("countyName", f.lan));
	if (f.bbox) parts.push(bboxClause(f.bbox));
	return parts.join(" AND ");
}

export interface SearchUrlOptions {
	hitsPerPage: number;
	startRecord: number;
	recordSchema: "presentation" | "xml";
}

export function buildSearchUrl(query: string, o: SearchUrlOptions): string {
	const u = new URL(KSAMSOK_API);
	u.searchParams.set("method", "search");
	u.searchParams.set("query", query);
	u.searchParams.set("hitsPerPage", String(Math.max(1, Math.min(1000, o.hitsPerPage))));
	u.searchParams.set("startRecord", String(Math.max(1, o.startRecord)));
	u.searchParams.set("recordSchema", o.recordSchema);
	if (o.recordSchema === "xml") u.searchParams.set("fields", SEARCH_FIELDS.join(","));
	return u.href;
}
