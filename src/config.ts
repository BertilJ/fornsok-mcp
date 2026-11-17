/** Fasta inställningar för servern. Inga hemligheter här. */

export const SERVER_NAME = "fornsok-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * Kontaktväg i User-Agent (SPEC 9.1, 13). Är en inställning: `CONTACT_URL` i
 * `vars` i wrangler.jsonc. Standardvärdet pekar på projektets förvar.
 */
export const DEFAULT_CONTACT_URL = "https://github.com/BertilJ/fornsok-mcp";

/** Identifierande User-Agent mot RAÄ m.fl. Ogiltig kontaktväg ger standardvärdet. */
export function userAgent(contactUrl?: string | null): string {
	let contact = DEFAULT_CONTACT_URL;
	if (contactUrl) {
		try {
			const u = new URL(contactUrl.trim());
			if ((u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:") && !/[\s()]/.test(u.href)) contact = u.href;
		} catch {
			// behåll standardvärdet
		}
	}
	return `fornsok-mcp/0.1 (+${contact})`;
}

export const USER_AGENT = userAgent();

/** Tidsgräns per uppströmsanrop (SPEC 8). */
export const UPSTREAM_TIMEOUT_MS = 10_000;

/** Högst så många samtidiga anrop per källa (SPEC 9.1). */
export const MAX_CONCURRENT_PER_SOURCE = 4;

export const KSAMSOK_API = "https://kulturarvsdata.se/ksamsok/api";
export const KSAMSOK_LAMNING_URI = "http://kulturarvsdata.se/raa/lamning/";
export const KSAMSOK_LAMNING_HTTPS = "https://kulturarvsdata.se/raa/lamning/";

export const OGC_ITEMS =
	"https://inspire-raa.metria.se/geoserver/Kulturhistoriska_lamningar/ogc/features/v1/collections/kulturhistoriska_fornlamningar/items";

export const FORNSOK_APP_API = "https://app.raa.se/open/fornsok/api";

/** Publik länk till en lämning (SPEC 4). */
export function publicUrl(uuid: string): string {
	return `https://pub.raa.se/visa/objekt/lamning/${uuid}`;
}

export const KALLA = "Riksantikvarieämbetet, Kulturmiljöregistret (CC0)";

/**
 * Hur länge värdelistorna cachas i minnet (per isolat). Framför KV-cachen
 * (24 h, se cache/kv.ts); utan KV hämtas listorna från appen så här ofta.
 */
export const DOMAIN_CACHE_TTL_MS = 60 * 60 * 1000;

/** Bilder upp till så här stora returneras som bildinnehåll i MCP-svaret (SPEC 6). */
export const MAX_BILD_BYTES = 2 * 1024 * 1024;

/**
 * Begränsning per användare (SPEC 9.2). Själva gränsen sätts i bindningen
 * `RATE_LIMITER` (`simple.limit`/`simple.period`) i den lokala
 * wrangler-konfigurationen; värdet här används bara i felmeddelandet och ska
 * hållas i takt med den.
 */
export const RATE_LIMIT_PER_MINUTE = 120;
