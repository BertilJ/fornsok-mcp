/**
 * Fel som visas för modellen som verktygsfel (isError: true) med svensk text.
 * Används för ogiltiga indata, okända namn, ej implementerade parametrar.
 */
export class ToolInputError extends Error {
	constructor(
		message: string,
		readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "ToolInputError";
	}
}

export type SourceId = "ksamsok" | "ogc" | "fornsokapp";

export const SOURCE_NAMES: Record<SourceId, string> = {
	ksamsok: "K-samsök",
	ogc: "RAÄ:s OGC API Features",
	fornsokapp: "Fornsök-appens läs-API",
};

/** Uppströmskällan svarade fel, svarade inte i tid, eller gick inte att tolka. */
export class UpstreamError extends Error {
	constructor(
		readonly source: SourceId,
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "UpstreamError";
	}
}

/** Ett anrop som inte står på listan över tillåtna anrop (SPEC 9.3). */
export class DisallowedCallError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DisallowedCallError";
	}
}
