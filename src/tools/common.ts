import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/server";
import { DisallowedCallError, SOURCE_NAMES, ToolInputError, UpstreamError } from "../errors";
import type { DomainService } from "../lookup/domains";
import type { DocumentSource, HistorySource, IdResolver, NearbySource, RecordSource, SearchSource, SemanticSearch } from "../sources/types";
import type { IndexAccess } from "../store/access";
import type { HittaPlatsDeps } from "./hitta_plats";

/**
 * Beroenden som verktygen får. `index` används först när det finns och är
 * laddat; `search`, `ids`, `records` och `nearby` är de levande källorna, som
 * också är reserv när indexet saknas eller fallerar (SPEC 8).
 */
export interface ToolDeps {
	/** Ordsök via K-samsök (reserv för sok_lamningar). */
	search: SearchSource;
	/** Nummer → UUID via K-samsök (reserv, och för nummer som saknas i indexet). */
	ids: IdResolver;
	/** Levande postkällor i prioritetsordning: första som svarar vinner, nästa är reserv. */
	records: Array<{ name: string; source: RecordSource }>;
	/** Närhetssök via OGC API Features (reserv för lamningar_nara). */
	nearby: NearbySource;
	/** Indexet i D1, om bindningen `DB` finns. */
	index?: IndexAccess;
	/** Den semantiska kanalen (SPEC 5.2), om AI och VECTORIZE finns. */
	semantic?: SemanticSearch;
	/** hitta_plats: indexets namn och Nominatim. */
	plats?: HittaPlatsDeps;
	domains: DomainService;
	/** Dokumentlistor och filer (Fornsök-appen). */
	documents: DocumentSource;
	/** Versionshistorik (Fornsök-appen). */
	history: HistorySource;
}

export const READ_ONLY: ToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};

export function ok<T extends Record<string, unknown>>(text: string, structured: T): CallToolResult {
	return { content: [{ type: "text", text }], structuredContent: structured };
}

export function fail(message: string, details?: Record<string, unknown>): CallToolResult {
	const text = details && Object.keys(details).length ? `${message}\n\n${JSON.stringify(details, null, 2)}` : message;
	return { content: [{ type: "text", text }], isError: true };
}

/** Kör ett verktyg och gör om kända fel till svenska verktygsfel. */
export async function runTool(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await fn();
	} catch (err) {
		return errorToResult(err);
	}
}

export function errorToResult(err: unknown): CallToolResult {
	if (err instanceof ToolInputError) return fail(err.message, err.details);
	if (err instanceof UpstreamError) {
		return fail(`${err.message}. Försök igen om en stund.`, { kalla: SOURCE_NAMES[err.source], status: err.status ?? null });
	}
	if (err instanceof DisallowedCallError) {
		// Ska inte kunna hända med giltiga indata; avslöja inte detaljer.
		return fail("Internt fel: anropet stoppades av serverns lista över tillåtna anrop.");
	}
	console.error("Oväntat fel i verktyg:", err);
	return fail("Internt fel i servern.");
}

/** Standardfrasen som står sist i många beskrivningar. */
export const BOILERPLATE_RE = /\s*Beskrivningen är inte kvalitetssäkrad\.\s*Information kan saknas, vara felaktig eller inaktuell\.?/g;

export function fmtCoord(lat: number | null | undefined, lon: number | null | undefined): string {
	if (lat == null || lon == null) return "koordinat saknas";
	return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

export function list(xs: readonly (string | null | undefined)[]): string {
	return xs.filter(Boolean).join(", ");
}
