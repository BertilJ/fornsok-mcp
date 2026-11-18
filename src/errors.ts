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

export type SourceId = "ksamsok" | "ogc" | "fornsokapp" | "raa_datauttag" | "nominatim";

export const SOURCE_NAMES: Record<SourceId, string> = {
	ksamsok: "K-samsök",
	ogc: "RAÄ:s OGC API Features",
	fornsokapp: "Fornsök-appens läs-API",
	raa_datauttag: "RAÄ:s ändringsflöde (datauttag)",
	nominatim: "OpenStreetMap Nominatim",
};

/**
 * Vad som hände när ingen HTTP-status finns: tidsgräns eller nätverksfel (källan
 * svarade inte), ett för stort svar, eller klientens egen gräns för samtidiga
 * anrop (källan tillfrågades inte).
 */
export type UpstreamFelArt = "tidsgrans" | "natverk" | "for_stort" | "upptaget";

/** Uppströmskällan svarade fel, svarade inte i tid, eller gick inte att tolka. */
export class UpstreamError extends Error {
	constructor(
		readonly source: SourceId,
		message: string,
		readonly status?: number,
		readonly art?: UpstreamFelArt,
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
