import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLiveDeps } from "../src/deps";
import type { ToolDeps } from "../src/tools/common";
import type { FetchLike } from "../src/upstream/client";

export const FIXTURES = join(__dirname, "fixtures");

export function fixtureText(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf8");
}

export function fixture<T = unknown>(name: string): T {
	return JSON.parse(fixtureText(name)) as T;
}

export interface Route {
	/** Matchas mot hela den avkodade adressen. */
	match: (url: URL) => boolean;
	respond: (url: URL) => Response | Promise<Response>;
}

export function json(body: unknown, status = 200, contentType = "application/json;charset=UTF-8"): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status,
		headers: { "content-type": contentType },
	});
}

export function fixtureResponse(name: string, status = 200, contentType = "application/json;charset=UTF-8"): Response {
	return new Response(fixtureText(name), { status, headers: { "content-type": contentType } });
}

/** Falsk fetch som svarar från inspelade svar och loggar anropen. */
export function fakeFetch(routes: Route[]): { fetch: FetchLike; calls: Array<{ url: URL; headers: Headers }> } {
	const calls: Array<{ url: URL; headers: Headers }> = [];
	const fetch: FetchLike = async (input, init) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		calls.push({ url, headers: new Headers(init?.headers) });
		const route = routes.find((r) => r.match(url));
		if (!route) return new Response(`ingen fixtur för ${url.href}`, { status: 599 });
		return route.respond(url);
	};
	return { fetch, calls };
}

const q = (url: URL) => url.searchParams.get("query") ?? "";
const schema = (url: URL) => url.searchParams.get("recordSchema");

/** Rutter för de tre fasta testposterna och övriga inspelade svar. */
export function standardRoutes(): Route[] {
	const isKsSearch = (u: URL) => u.hostname === "kulturarvsdata.se" && u.pathname === "/ksamsok/api";
	return [
		{
			match: (u) => isKsSearch(u) && /text="slagg"/.test(q(u)),
			respond: (u) =>
				fixtureResponse(
					schema(u) === "xml" ? "ksamsok-search-slagg-hytta-falun-fields.json" : "ksamsok-search-slagg-hytta-falun-presentation.json",
				),
		},
		{
			// Nummeruppslag (lamning): alltid fältschema.
			match: (u) => isKsSearch(u) && /itemNumber=/.test(q(u)) && schema(u) === "xml" && !/text=/.test(q(u)),
			respond: () => fixtureResponse("ksamsok-search-testposter-fields.json"),
		},
		{
			match: (u) => isKsSearch(u) && /itemNumber=/.test(q(u)) && schema(u) === "presentation",
			respond: () => fixtureResponse("ksamsok-search-testposter-presentation.json"),
		},
		{
			match: (u) => isKsSearch(u) && /boundingBox=/.test(q(u)),
			respond: (u) =>
				schema(u) === "presentation"
					? fixtureResponse("ksamsok-search-bbox-presentation.json")
					: json({ result: { totalHits: 0, records: {}, version: 1 } }),
		},
		...(["L2001-646:adc490ba-871a-45bd-8e3d-0a27761b3b6c", "L2000-8802:6d1cf7b6-f5bd-4066-aba6-fb1ea3ce8c75", "L1946-7415:bfe10d94-5d11-4943-8085-4b1bfcaacf64"].flatMap(
			(pair) => {
				const [nr, uuid] = pair.split(":");
				return [
					{
						match: (u: URL) => u.hostname === "app.raa.se" && u.pathname === `/open/fornsok/api/lamning/lamning/${uuid}`,
						respond: () => fixtureResponse(`app-lamning-${nr}.json`),
					},
					{
						match: (u: URL) => u.hostname === "kulturarvsdata.se" && u.pathname === `/raa/lamning/${uuid}`,
						respond: () => fixtureResponse(`ksamsok-jsonld-${nr}.json`),
					},
				];
			},
		) as Route[]),
		{
			match: (u) => u.hostname === "app.raa.se" && u.pathname === "/open/fornsok/api/lamning/domaner",
			respond: () => fixtureResponse("app-lamning-domaner.json"),
		},
		{
			match: (u) => u.hostname === "app.raa.se" && u.pathname === "/open/fornsok/api/uppdrag/domaner",
			respond: () => fixtureResponse("app-uppdrag-domaner.json"),
		},
		{
			match: (u) => u.hostname === "inspire-raa.metria.se" && (u.searchParams.get("filter") ?? "").includes("Hyttområde"),
			respond: () => fixtureResponse("ogc-items-nara-L2000-8802-cql.json", 200, "application/geo+json"),
		},
		{
			match: (u) => u.hostname === "inspire-raa.metria.se" && near(u, 15.554, 60.6616),
			respond: () => fixtureResponse("ogc-items-nara-L2000-8802.json", 200, "application/geo+json"),
		},
		{
			match: (u) => u.hostname === "inspire-raa.metria.se" && near(u, 15.6658, 63.2018),
			respond: () => fixtureResponse("ogc-items-nara-L1946-7415.json", 200, "application/geo+json"),
		},
		{
			match: (u) => u.hostname === "inspire-raa.metria.se" && near(u, 15.4564, 60.7337),
			respond: () => fixtureResponse("ogc-items-nara-L2001-646.json", 200, "application/geo+json"),
		},
	];
}

function near(u: URL, lon: number, lat: number): boolean {
	const b = (u.searchParams.get("bbox") ?? "").split(",").map(Number);
	return b.length === 4 && b[0] <= lon && lon <= b[2] && b[1] <= lat && lat <= b[3];
}

export function fixtureDeps(routes: Route[] = standardRoutes()): { deps: ToolDeps; calls: Array<{ url: URL; headers: Headers }> } {
	const { fetch, calls } = fakeFetch(routes);
	return { deps: createLiveDeps({ fetch, retryDelayMs: 0 }), calls };
}
