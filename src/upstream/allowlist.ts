/**
 * Fast lista över tillåtna uppströmsanrop (SPEC 9.3).
 *
 * Varje anrop prövas mot listan: metod, schema (https), värd, sökväg (förankrat
 * mönster) och frågeparametrar (bara namngivna, med värdemönster där det behövs).
 * Fornsök-appens bas-URL har skrivande ändpunkter – de ska aldrig kunna nås,
 * därför är bara GET mot uttryckligen listade läsanrop tillåtna.
 */
import { DisallowedCallError, type SourceId } from "../errors";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export interface AllowedCall {
	/** Kort namn, används i loggar och tester. */
	id: string;
	source: SourceId;
	method: "GET";
	origin: string;
	/** Förankrat mönster mot `URL.pathname` (efter tolkning). */
	path: RegExp;
	/** Tillåtna frågeparametrar och mönster för deras värden. Saknas = inga parametrar tillåtna. */
	query?: Record<string, RegExp>;
	/** Parametrar som måste finnas. */
	requiredQuery?: string[];
}

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
export const UUID_RE = new RegExp(`^${UUID}$`);
/**
 * Fil-id i dokumentändpunkten: base64 (som appen ger det), där `+` och `=`
 * är procentkodade. `/` (%2F) godtas aldrig.
 */
const FILE_ID_SEGMENT = "(?:[A-Za-z0-9]|%2[bB]|%3[dD]){1,200}";
/**
 * Filnamn: inga snedstreck, inga kodade snedstreck/bakstreck/nolltecken/procenttecken
 * (dubbelkodning), och
 * bara bildfiler (JPEG/PNG) – servern hämtar aldrig andra filtyper, de ges som länk.
 */
const IMAGE_FILE_SEGMENT = "(?:[A-Za-z0-9._~\\-]|%(?!2[fF]|5[cC]|00|25)[0-9A-Fa-f]{2}){1,300}\\.(?:[jJ][pP][eE]?[gG]|[pP][nN][gG])";
const ANY = /^[\s\S]{0,4000}$/;
const INT = /^\d{1,6}$/;

export const ALLOWED_CALLS: readonly AllowedCall[] = [
	// K-samsök: sökning (SPEC 3, 4)
	{
		id: "ksamsok.search",
		source: "ksamsok",
		method: "GET",
		origin: "https://kulturarvsdata.se",
		path: /^\/ksamsok\/api$/,
		query: {
			method: /^search$/,
			query: ANY,
			hitsPerPage: INT,
			startRecord: INT,
			recordSchema: /^(presentation|xml)$/,
			fields: /^[A-Za-z,]{1,500}$/,
		},
		requiredQuery: ["method", "query"],
	},
	// K-samsök: en post som JSON-LD (reserv för `lamning`)
	{
		id: "ksamsok.lamning",
		source: "ksamsok",
		method: "GET",
		origin: "https://kulturarvsdata.se",
		path: new RegExp(`^/raa/lamning/${UUID}$`),
	},
	// OGC API Features: närhetssök (bbox + CQL2)
	{
		id: "ogc.items",
		source: "ogc",
		method: "GET",
		origin: "https://inspire-raa.metria.se",
		path: /^\/geoserver\/Kulturhistoriska_lamningar\/ogc\/features\/v1\/collections\/kulturhistoriska_fornlamningar\/items$/,
		query: {
			f: /^application\/geo\+json$/,
			bbox: /^-?\d{1,3}(\.\d+)?(,-?\d{1,3}(\.\d+)?){3}$/,
			limit: INT,
			"filter-lang": /^cql2-text$/,
			filter: ANY,
		},
	},
	// Fornsök-appens läs-API (SPEC 4). Bara GET. POST-sökningen används inte och är inte tillåten.
	{
		id: "fornsokapp.lamning",
		source: "fornsokapp",
		method: "GET",
		origin: "https://app.raa.se",
		path: new RegExp(`^/open/fornsok/api/lamning/lamning/${UUID}$`),
	},
	{
		id: "fornsokapp.lamning.version",
		source: "fornsokapp",
		method: "GET",
		origin: "https://app.raa.se",
		path: new RegExp(`^/open/fornsok/api/lamning/lamning/${UUID}/version$`),
	},
	{
		id: "fornsokapp.dokument",
		source: "fornsokapp",
		method: "GET",
		origin: "https://app.raa.se",
		path: /^\/open\/fornsok\/api\/lamning\/dokument$/,
		query: { lamning_id: UUID_RE },
		requiredQuery: ["lamning_id"],
	},
	{
		id: "fornsokapp.dokument.fil",
		source: "fornsokapp",
		method: "GET",
		origin: "https://app.raa.se",
		path: new RegExp(`^/open/fornsok/api/lamning/dokument/fil/${FILE_ID_SEGMENT}/${IMAGE_FILE_SEGMENT}$`),
	},
	{
		id: "fornsokapp.lamning.domaner",
		source: "fornsokapp",
		method: "GET",
		origin: "https://app.raa.se",
		path: /^\/open\/fornsok\/api\/lamning\/domaner$/,
	},
	{
		id: "fornsokapp.uppdrag.domaner",
		source: "fornsokapp",
		method: "GET",
		origin: "https://app.raa.se",
		path: /^\/open\/fornsok\/api\/uppdrag\/domaner$/,
	},
];

/**
 * Pröva ett anrop mot listan. Returnerar matchande post eller kastar
 * `DisallowedCallError`. Anropas av uppströmsklienten före varje anrop,
 * även vid omdirigering.
 */
export function checkAllowed(method: string, rawUrl: string | URL): AllowedCall {
	let url: URL;
	try {
		url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
	} catch {
		throw new DisallowedCallError(`Ogiltig adress: ${String(rawUrl)}`);
	}
	if (url.protocol !== "https:") throw new DisallowedCallError(`Bara https är tillåtet: ${url.href}`);
	if (url.username || url.password) throw new DisallowedCallError("Inloggningsuppgifter i adressen är inte tillåtna");
	if (url.port) throw new DisallowedCallError("Annan port än standard är inte tillåten");
	if (url.hash) throw new DisallowedCallError("Fragment i adressen är inte tillåtet");

	const m = method.toUpperCase();
	const candidates = ALLOWED_CALLS.filter(
		(c) => c.origin === url.origin && c.path.test(url.pathname),
	);
	if (candidates.length === 0) {
		throw new DisallowedCallError(`Anropet finns inte på listan över tillåtna anrop: ${m} ${url.origin}${url.pathname}`);
	}
	const call = candidates.find((c) => c.method === m);
	if (!call) {
		throw new DisallowedCallError(`Metoden ${m} är inte tillåten för ${url.origin}${url.pathname}`);
	}

	const seen = new Set<string>();
	for (const [key, value] of url.searchParams) {
		if (seen.has(key)) throw new DisallowedCallError(`Frågeparametern ${key} förekommer flera gånger`);
		seen.add(key);
		const pattern = call.query?.[key];
		if (!pattern) throw new DisallowedCallError(`Frågeparametern ${key} är inte tillåten för ${call.id}`);
		if (!pattern.test(value)) throw new DisallowedCallError(`Ogiltigt värde för ${key} i ${call.id}`);
	}
	for (const key of call.requiredQuery ?? []) {
		if (!seen.has(key)) throw new DisallowedCallError(`Frågeparametern ${key} saknas för ${call.id}`);
	}
	return call;
}
