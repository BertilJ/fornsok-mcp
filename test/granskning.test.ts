/**
 * Rättelser efter granskningen av etapp 1 (punkt 1–10) och de testluckor som
 * påpekades: förminskning i lamningar_nara, bbox-läget, sida > 1, 12-ordsgränsen
 * och kodade sökvägsförsök mot listan över tillåtna anrop.
 */
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KvDomainSource } from "../src/cache/kv";
import { DisallowedCallError, UpstreamError } from "../src/errors";
import { DomainService } from "../src/lookup/domains";
import { extractXmlError, parseSearchResponse } from "../src/sources/ksamsok/parse";
import type { DomainSource, Domaner, NearbyFeature, NearbyQuery } from "../src/sources/types";
import { hamtaLamningar } from "../src/tools/lamning";
import { lamningarNara } from "../src/tools/lamningar_nara";
import { sokLamningar } from "../src/tools/sok_lamningar";
import { checkAllowed } from "../src/upstream/allowlist";
import { type FetchLike, Semaphore, UpstreamClient } from "../src/upstream/client";
import { type Route, connectMcp, fixtureDeps, json, memoryKv, standardRoutes } from "./helpers";

type Structured = Record<string, any>;
const DOMANER = "https://app.raa.se/open/fornsok/api/lamning/domaner";

/** Fångar K-samsök-frågor som inte har en egen fixtur och svarar med noll träffar. */
const emptyKsamsok: Route = {
	match: (u) => u.hostname === "kulturarvsdata.se" && u.pathname === "/ksamsok/api",
	respond: () => json({ result: { totalHits: 0, records: {}, version: 1 } }),
};
const routesWithEmpty = () => [...standardRoutes(), emptyKsamsok];
const ksQueries = (calls: Array<{ url: URL }>) =>
	calls.filter((c) => c.url.pathname === "/ksamsok/api").map((c) => c.url.searchParams.get("query") ?? "");

// ------------------------------------------------------------------ 1. socken
describe("1. socken med samma namn i samma län", () => {
	it("avgränsas också på kommun", async () => {
		const { deps, calls } = fixtureDeps(routesWithEmpty());
		const r = await sokLamningar({ socken: ["Mo (Tanum)"], lage: "auto", antal: 5, sida: 1 }, deps);
		const s = r.structuredContent as Structured;
		expect(s.filter.socken).toEqual([{ namn: "Mo", lan: ["Västra Götaland"], kommun: ["Tanum", "Munkedal"] }]);
		expect(ksQueries(calls)[0]).toContain('(parishName="Mo" AND countyName="Västra Götaland" AND (municipalityName="Tanum" OR municipalityName="Munkedal"))');
		expect(s.anmarkningar.join(" ")).toMatch(/flera socknar som heter Mo i Västra Götaland; avgränsat till kommun Tanum, Munkedal \(lämningar i socknen som saknar kommun i registret kommer inte med\)\./);
	});

	it("säger till när en kommun har båda socknarna", async () => {
		const { deps } = fixtureDeps(routesWithEmpty());
		const r = await sokLamningar({ socken: ["Torp (Orust)"], lage: "auto", antal: 5, sida: 1 }, deps);
		const s = r.structuredContent as Structured;
		expect(s.filter.socken[0].kommun).toEqual(["Uddevalla", "Orust"]);
		expect(s.anmarkningar.join(" ")).toMatch(/Uddevalla har också en annan socken Torp/);
	});

	it("en kvalificerare som motsäger en entydig socken ger fel", async () => {
		const { deps, calls } = fixtureDeps(routesWithEmpty());
		await expect(sokLamningar({ socken: ["Bjursås (Jämtland)"], lage: "auto", antal: 5, sida: 1 }, deps)).rejects.toThrow(/finns bara i Bjursås \(Dalarna/);
		await expect(sokLamningar({ socken: ["Bjursås, Falun"], lage: "auto", antal: 5, sida: 1 }, deps)).resolves.toBeTruthy();
		await expect(sokLamningar({ socken: ["Bjursås (Dalarnas län)"], lage: "auto", antal: 5, sida: 1 }, deps)).resolves.toBeTruthy();
		expect(ksQueries(calls).every((q) => q.includes('parishName="Bjursås"'))).toBe(true);
	});
});

// ------------------------------------------------------------------ 2 och 7. klienten
describe("2. svarskroppen stängs före omförsök", () => {
	it("5xx och 429", async () => {
		for (const status of [503, 429]) {
			let cancelled = 0;
			let n = 0;
			const fetch: FetchLike = async () => {
				if (n++ === 0) {
					const body = new ReadableStream({
						cancel() {
							cancelled++;
						},
					});
					return new Response(body, { status, headers: { "retry-after": "0" } });
				}
				return new Response("{}");
			};
			const r = await new UpstreamClient({ fetch, retryDelayMs: 0 }).get(DOMANER);
			expect(r.status).toBe(200);
			expect(cancelled, String(status)).toBe(1);
		}
	});
});

describe("7. storleksgränsen gäller även utan Content-Length", () => {
	it("läser strömmande och avbryter vid gränsen", async () => {
		let pulled = 0;
		let cancelled = false;
		const fetch: FetchLike = async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull(c) {
						pulled++;
						c.enqueue(new Uint8Array(64));
					},
					cancel() {
						cancelled = true;
					},
				}),
			);
		await expect(new UpstreamClient({ fetch, maxBodyBytes: 1000 }).get(DOMANER)).rejects.toThrow(/för stort/);
		expect(cancelled).toBe(true);
		expect(pulled).toBeLessThan(20);
	});

	it("text under gränsen avkodas som UTF-8", async () => {
		const fetch: FetchLike = async () => new Response(new TextEncoder().encode('{"namn":"Bjursås"}'));
		const r = await new UpstreamClient({ fetch, maxBodyBytes: 1000 }).getJson<{ namn: string }>(DOMANER);
		expect(r.data.namn).toBe("Bjursås");
	});
});

// ------------------------------------------------------------------ 3. delat tillstånd
function domaner(overrides: Partial<Domaner> = {}): Domaner {
	return {
		lamningstyper: [{ id: 1, namn: "Hyttområde", aktiv: true, kategorier: ["Metallframställning och bergsbruk"] }],
		kategorier: ["Metallframställning och bergsbruk"],
		bedomningar: [{ namn: "Fornlämning", beskrivning: null }],
		kommuner: [{ kod: "2080", namn: "Falun", lan_kod: "20", lan_namn: "Dalarna" }],
		socknar: [{ id: "1", namn: "Bjursås", kommunkoder: ["2080"] }],
		landskap: [{ kod: "W", namn: "Dalarna" }],
		lan: [{ kod: "20", namn: "Dalarna" }],
		hamtad: "2026-11-17T00:00:00Z",
		...overrides,
	};
}

describe("3. värdelistor: validering, kort felcache, delad hämtning", () => {
	it("tomma värdelistor cachas inte (varken i minnet eller i KV)", async () => {
		let t = 0;
		const load = vi.fn(async () => domaner({ socknar: [] }));
		const kv = memoryKv();
		const svc = new DomainService(new KvDomainSource({ loadDomaner: load }, kv), 3_600_000, () => t, 15_000);
		await expect(svc.get()).rejects.toThrow(/ofullständiga \(tomma listor: socknar\)/);
		expect(kv.puts).toBe(0);
		// Felet cachas kort: inget nytt försök inom 15 s …
		await expect(svc.get()).rejects.toBeInstanceOf(UpstreamError);
		expect(load).toHaveBeenCalledTimes(1);
		// … men väl efter.
		t += 15_001;
		load.mockImplementation(async () => domaner());
		await expect(svc.get()).resolves.toMatchObject({ kommuner: [{ namn: "Falun" }] });
		expect(load).toHaveBeenCalledTimes(2);
		expect(kv.puts).toBe(1);
	});

	it("ogiltigt värde i KV används inte", async () => {
		const kv = memoryKv();
		await kv.put("domaner:v1", JSON.stringify(domaner({ lamningstyper: [] })));
		const load = vi.fn(async () => domaner());
		const d = await new KvDomainSource({ loadDomaner: load }, kv).loadDomaner();
		expect(load).toHaveBeenCalledTimes(1);
		expect(d.lamningstyper).toHaveLength(1);
	});

	it("den som väntar på en annans hämtning som misslyckas försöker själv", async () => {
		let n = 0;
		let rejectFirst!: (e: unknown) => void;
		const source: DomainSource = {
			loadDomaner: () => {
				n++;
				if (n === 1) return new Promise((_, reject) => (rejectFirst = reject));
				return Promise.resolve(domaner());
			},
		};
		const svc = new DomainService(source, 3_600_000, Date.now, 15_000);
		const first = svc.get();
		const second = svc.get();
		rejectFirst(new Error("förfrågan avbröts"));
		await expect(first).rejects.toThrow(/avbröts/);
		await expect(second).resolves.toMatchObject({ socknar: [{ namn: "Bjursås" }] });
		expect(n).toBe(2);
	});

	it("den som väntar på en hämtning som hänger ger upp efter en tid och försöker själv", async () => {
		let n = 0;
		const source: DomainSource = {
			loadDomaner: () => (++n === 1 ? new Promise<Domaner>(() => {}) : Promise.resolve(domaner())),
		};
		const svc = new DomainService(source, 3_600_000, Date.now, 15_000, 20);
		void svc.get();
		await expect(svc.get()).resolves.toMatchObject({ kommuner: [{ namn: "Falun" }] });
		expect(n).toBe(2);
	});

	it("semaforen: en övergiven plats återtas, och väntan har en gräns", async () => {
		let t = 0;
		const s = new Semaphore(1, { maxHoldMs: 1000, maxWaitMs: 50, pollMs: 1, now: () => t });
		// En förfrågan som aldrig blir klar (t.ex. avbruten) håller platsen.
		void s.run(() => new Promise(() => {}));
		await Promise.resolve();
		expect(s.inFlight).toBe(1);
		t = 2000;
		await expect(s.run(async () => "ok")).resolves.toBe("ok");
		const s2 = new Semaphore(1, { maxHoldMs: 60_000, maxWaitMs: 5, pollMs: 1 });
		void s2.run(() => new Promise(() => {}));
		await expect(s2.run(async () => "x")).rejects.toThrow(/timeout/);
	});
});

// ------------------------------------------------------------------ 4 och 5. fritext
describe("4. nummer i fraga söks via nummer", () => {
	it("hela frågan som lämningsnummer eller RAÄ-nummer", async () => {
		for (const fraga of ["L2001:646", "l2001:646", "Bjursås 27:1"]) {
			const { deps, calls } = fixtureDeps(routesWithEmpty());
			const r = await sokLamningar({ fraga, lage: "auto", antal: 5, sida: 1 }, deps);
			const q = ksQueries(calls)[0];
			expect(q, fraga).toMatch(/itemNumber="(L2001:646|Bjursås 27:1)"/);
			expect(q).not.toContain("text=");
			expect((r.structuredContent as Structured).anmarkningar.join(" ")).toMatch(/söktes via nummer/);
		}
	});

	it("lämningsnummer bland andra ord plockas ut; liknande RAÄ-nummer ger en hänvisning", async () => {
		const { deps, calls } = fixtureDeps(routesWithEmpty());
		await sokLamningar({ fraga: "källa L2001:646", lage: "auto", antal: 5, sida: 1 }, deps);
		expect(ksQueries(calls)[0]).toContain('text="källa" AND itemNumber="L2001:646"');
		const r = await sokLamningar({ fraga: "hytta 172:1", lage: "auto", antal: 5, sida: 1 }, deps);
		expect((r.structuredContent as Structured).anmarkningar.join(" ")).toMatch(/liknar ett RAÄ-nummer/);
	});
});

describe("5. högst 12 ord, med anmärkning", () => {
	it("det trettonde ordet stryks och det sägs", async () => {
		const { deps, calls } = fixtureDeps(routesWithEmpty());
		const ord = Array.from({ length: 13 }, (_, i) => `ord${i + 1}`);
		const r = await sokLamningar({ fraga: ord.join(" "), lage: "auto", antal: 5, sida: 1 }, deps);
		const q = ksQueries(calls)[0];
		expect(q.match(/text=/g)).toHaveLength(12);
		expect(q).not.toContain("ord13");
		expect((r.structuredContent as Structured).anmarkningar.join(" ")).toMatch(/13 ord; bara de 12 första användes \(ord13 ströks\)/);
	});
});

// ------------------------------------------------------------------ 6. XML-entiteter
describe("6. ogiltig numerisk entitet i ett XML-fel", () => {
	it("blir uppströmsfel, inte RangeError", () => {
		expect(extractXmlError("<error>fel &#99999999; och &#xD800; och &#65;</error>")).toBe("fel � och � och A");
		expect(() => parseSearchResponse({ status: 500, contentType: "text/xml", body: "<error>&#9999999;</error>", url: "" })).toThrow(UpstreamError);
	});
});

// ------------------------------------------------------------------ 8. lamningar_nara
function feature(nr: string, geometry: NearbyFeature["geometry"]): NearbyFeature {
	return { lamningsnummer: nr, uuid: null, raa_nummer: null, lamningstyp: "Gruvhål", antikvarisk_bedomning: null, lamningsnamn: null, kommun: "Falun", lan: "Dalarna", url: null, geometry };
}
const C = { lat: 60.6, lon: 15.63 };
const d = 0.0005;

describe("8. inom_lamningen bara för ytor", () => {
	it("punkt och linje genom punkten är 0 m bort, inte inom; ytan runt punkten är inom", async () => {
		const { deps } = fixtureDeps();
		deps.nearby = {
			featuresInBbox: async () => ({
				numberMatched: 3,
				numberReturned: 3,
				features: [
					feature("L1:1", { type: "Point", coordinates: [C.lon, C.lat] }),
					feature("L1:2", { type: "LineString", coordinates: [[C.lon - d, C.lat], [C.lon + d, C.lat]] }),
					feature("L1:3", { type: "Polygon", coordinates: [[[C.lon - d, C.lat - d], [C.lon + d, C.lat - d], [C.lon + d, C.lat + d], [C.lon - d, C.lat + d], [C.lon - d, C.lat - d]]] }),
				],
			}),
		};
		const r = await lamningarNara({ ...C, radie_m: 100, antal: 10 }, deps);
		const by = Object.fromEntries((r.structuredContent as Structured).lamningar.map((l: Structured) => [l.lamningsnummer, l]));
		expect(by["L1:1"]).toMatchObject({ avstand_m: 0, inom_lamningen: false, vaderstreck: null });
		expect(by["L1:2"]).toMatchObject({ avstand_m: 0, inom_lamningen: false });
		expect(by["L1:3"]).toMatchObject({ avstand_m: 0, inom_lamningen: true });
		const text = (r.content as Array<{ text: string }>)[0].text;
		expect(text).toMatch(/L1:1 – Gruvhål.*0 m \(punkten ligger på lämningen\)/);
		expect(text).toMatch(/L1:3 – Gruvhål.*punkten ligger inom lämningen/);
	});
});

describe("testluckor: lamningar_nara", () => {
	it("förminskning: 1837 geometrier inom 10 km (över gränsen 1000) ger mindre radie och anmärkning", async () => {
		const { deps } = fixtureDeps();
		const queries: NearbyQuery[] = [];
		deps.nearby = {
			featuresInBbox: async (q) => {
				queries.push(q);
				// Första rutan (10 km) har 1837 geometrier; mindre rutor ryms.
				if (queries.length === 1) {
					return { numberMatched: 1837, numberReturned: 1000, features: Array.from({ length: 5 }, (_, i) => feature(`L9:${i}`, { type: "Point", coordinates: [C.lon + i * 0.01, C.lat] })) };
				}
				return { numberMatched: 400, numberReturned: 400, features: [feature("L9:0", { type: "Point", coordinates: [C.lon, C.lat] })] };
			},
		};
		const r = await lamningarNara({ ...C, radie_m: 10_000, antal: 25 }, deps);
		const s = r.structuredContent as Structured;
		expect(queries).toHaveLength(2);
		const side = (q: NearbyQuery) => q.bbox[2] - q.bbox[0];
		expect(side(queries[1])).toBeLessThan(side(queries[0]));
		// radie = 10000 · √(1000/1837) · 0,8 ≈ 5902
		expect(s.sokt_radie_m).toBe(Math.floor(10_000 * Math.sqrt(1000 / 1837) * 0.8));
		expect(s.fullstandig).toBe(true);
		expect(s.geometrier_i_omradet).toBe(1837);
		expect(s.anmarkningar.join(" ")).toMatch(/Tätt område: sökningen begränsades till 5902 m .*1837 geometrier inom 10000 m/);
	});

	it("bbox-läget: rutan skickas oförändrad, krymps aldrig, och ofullständigt svar sägs", async () => {
		const { deps } = fixtureDeps();
		const queries: NearbyQuery[] = [];
		deps.nearby = {
			featuresInBbox: async (q) => {
				queries.push(q);
				return { numberMatched: 1500, numberReturned: 1000, features: [feature("L8:1", { type: "Point", coordinates: [15.62, 60.6] })] };
			},
		};
		const bbox: [number, number, number, number] = [15.6, 60.59, 15.65, 60.61];
		const r = await lamningarNara({ bbox, radie_m: 500, antal: 25 }, deps);
		const s = r.structuredContent as Structured;
		expect(queries).toHaveLength(1);
		expect(queries[0].bbox).toEqual(bbox);
		expect(s).toMatchObject({ bbox, radie_m: null, sokt_radie_m: null, fullstandig: false, totalt: 1 });
		expect(s.mittpunkt).toEqual({ lat: 60.6, lon: 15.625 });
		expect(s.anmarkningar.join(" ")).toMatch(/fler geometrier än som kunde hämtas/);
	});

	it("bbox-läget: fel ordning eller för stor ruta avvisas utan anrop", async () => {
		const { deps, calls } = fixtureDeps();
		await expect(lamningarNara({ bbox: [15.65, 60.59, 15.6, 60.61], radie_m: 500, antal: 25 }, deps)).rejects.toThrow(/min < max/);
		await expect(lamningarNara({ bbox: [15.0, 60.0, 16.0, 61.0], radie_m: 500, antal: 25 }, deps)).rejects.toThrow(/för stor/);
		expect(calls).toHaveLength(0);
	});
});

describe("testluckor: sok_lamningar sida > 1", () => {
	it("startRecord räknas från sida och antal", async () => {
		const { deps, calls } = fixtureDeps(routesWithEmpty());
		const r = await sokLamningar({ fraga: "slagg hytta", kommun: ["Falun"], lage: "auto", antal: 5, sida: 3 }, deps);
		const ks = calls.filter((c) => c.url.pathname === "/ksamsok/api");
		expect(ks).toHaveLength(2);
		for (const c of ks) {
			expect(c.url.searchParams.get("startRecord")).toBe("11");
			expect(c.url.searchParams.get("hitsPerPage")).toBe("5");
		}
		const s = r.structuredContent as Structured;
		expect(s.sida).toBe(3);
		expect((r.content as Array<{ text: string }>)[0].text).toMatch(/visar 11–15 \(sida 3,/);
	});
});

// ------------------------------------------------------------------ 9 och 10. lamning
describe("9. två identiteter för samma lämning", () => {
	it("visas en gång, med anmärkning", async () => {
		const { deps } = fixtureDeps();
		const r = await hamtaLamningar({ id: ["L2001:646", "adc490ba-871a-45bd-8e3d-0a27761b3b6c"] }, deps);
		const s = r.structuredContent as Structured;
		expect(s.lamningar).toHaveLength(1);
		expect(s.anmarkningar.join(" ")).toMatch(/"adc490ba-871a-45bd-8e3d-0a27761b3b6c" och "L2001:646" avser samma lämning/);
	});
});

describe("10. oväntade fel läcker inte detaljer", () => {
	it("en otillåten adress i felet visas inte i svaret", async () => {
		const { deps } = fixtureDeps();
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		deps.records = [
			{
				name: "Fornsök-appen",
				source: {
					getByUuid: async () => {
						throw new DisallowedCallError("Anropet finns inte på listan: GET https://app.raa.se/hemlig/sokvag");
					},
				},
			},
		];
		const r = await hamtaLamningar({ id: ["adc490ba-871a-45bd-8e3d-0a27761b3b6c"] }, deps);
		const text = JSON.stringify(r);
		expect(text).not.toContain("hemlig");
		expect(text).toMatch(/Fornsök-appen: internt fel/);
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});

	it("nätverksfel: generiskt meddelande, detaljen loggas", async () => {
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetch: FetchLike = async () => {
			throw new TypeError("connect ECONNREFUSED 10.0.0.1:443 intern-detalj");
		};
		const err = await new UpstreamClient({ fetch, retryDelayMs: 0 }).get(DOMANER).catch((e) => e);
		expect(err).toBeInstanceOf(UpstreamError);
		expect(err.message).toBe("Fornsök-appens läs-API gick inte att nå");
		expect(spy.mock.calls.flat().join(" ")).toMatch(/intern-detalj/);
		spy.mockRestore();
	});
});

// ------------------------------------------------------------------ allowlistan
describe("testluckor: kodade sökvägsförsök mot listan över tillåtna anrop", () => {
	const APP = "https://app.raa.se/open/fornsok/api";
	const UUID = "adc490ba-871a-45bd-8e3d-0a27761b3b6c";
	it("avvisas", () => {
		const bad = [
			`${APP}/lamning/lamning/${UUID}/%2e%2e/%2e%2e/uppdrag/uppdrag`,
			`${APP}/lamning/lamning/%2E%2E/admin`,
			`${APP}/lamning/lamning/${UUID}/..%2f..%2fadmin`,
			`${APP}/lamning/lamning/${UUID}%2f..%2fversion`,
			`${APP}/lamning/lamning/${UUID}%252f..%252fadmin`,
			`${APP}/lamning/lamning/%252e%252e/admin`,
			`${APP}/lamning/dokument/fil/1/%252e%252e%252fadmin.jpg`,
			`${APP}/lamning/dokument/fil/%2e%2e/x.jpg`,
			`${APP}/lamning/dokument/fil/1/%2e%2e`,
			`${APP}/lamning/dokument/fil/1/x%5c..%5cadmin.jpg`,
			`${APP}/lamning/domaner/%2e%2e/%2e%2e/admin`,
			`${APP}/lamning/domaner;jsessionid=x`,
			`${APP}/lamning/lamning/${UUID}%00`,
		];
		for (const u of bad) expect(() => checkAllowed("GET", u), u).toThrow(DisallowedCallError);
	});
});

describe("MCP: kategori i sok_lamningar", () => {
	let client: Client | undefined;
	afterEach(async () => {
		await client?.close();
	});

	it("översätts till kategorins lämningstyper", async () => {
		const c = await connectMcp(routesWithEmpty());
		client = c.client;
		const r = await c.client.callTool({ name: "sok_lamningar", arguments: { kategori: ["kult, offer och folktro"], kommun: ["Falun"] } });
		expect(r.isError).toBeFalsy();
		const s = r.structuredContent as Structured;
		expect(s.filter.kategori).toEqual(["Kult, offer och folktro"]);
		expect(s.filter.lamningstyp).toHaveLength(10);
		expect(s.filter.lamningstyp).toContain("Källa med tradition");
		const q = ksQueries(c.calls)[0];
		expect(q).toContain('itemName="Källa med tradition"');
		expect(q.match(/itemName=/g)).toHaveLength(10);
		expect(s.anmarkningar.join(" ")).toMatch(/översatts till 10 lämningstyper/);
	});

	it("med lamningstyp: snittet; tomt snitt och okänd kategori ger fel utan sökning", async () => {
		const c = await connectMcp(routesWithEmpty());
		client = c.client;
		const r = await c.client.callTool({ name: "sok_lamningar", arguments: { kategori: ["Kult, offer och folktro"], lamningstyp: ["Källa med tradition", "Hyttområde"] } });
		expect((r.structuredContent as Structured).filter.lamningstyp).toEqual(["Källa med tradition"]);
		const tom = await c.client.callTool({ name: "sok_lamningar", arguments: { kategori: ["Gravar"], lamningstyp: ["Hyttområde"] } });
		expect(tom.isError).toBe(true);
		expect((tom.content as Array<{ text: string }>)[0].text).toMatch(/hör till kategorin "Gravar"/);
		const okand = await c.client.callTool({ name: "sok_lamningar", arguments: { kategori: ["Grav"] } });
		expect(okand.isError).toBe(true);
		expect((okand.content as Array<{ text: string }>)[0].text).toMatch(/Okänd kategori "Grav". Menade du: "Gravar"/);
		expect(ksQueries(c.calls)).toHaveLength(2);
	});
});

describe("svarskroppens gräns (granskningen av verktygsskiktet, punkt 7)", () => {
	it("standardgränsen är 8 MB", async () => {
		const { MAX_BODY_BYTES } = await import("../src/upstream/client");
		expect(MAX_BODY_BYTES).toBe(8 * 1024 * 1024);
	});
});

// ---------------------------------------------------------------- granskningen av f4d4244, punkt 8d, 8f och 9

describe("granskningen av f4d4244: övrigt", () => {
	it("8d: uppslag i indexreserven säger att listorna är byggda ur indexet och anger indexets datum, inte dagens", async () => {
		const { uppslag } = await import("../src/tools/uppslag");
		const d: Domaner = { lamningstyper: [], kategorier: [], bedomningar: [], kommuner: [{ kod: "2080", namn: "Falun", lan_kod: "20", lan_namn: "Dalarna" }] as Domaner["kommuner"], socknar: [], landskap: [], lan: [], hamtad: new Date().toISOString(), kalla: "index" };
		const deps = { domains: { get: async () => d }, index: { open: async () => ({ ok: true, hamtad_fran: "index 2026-11-17" }) } } as unknown as Parameters<typeof uppslag>[1];
		const r = await uppslag({ lista: "kommuner" } as Parameters<typeof uppslag>[0], deps);
		const t = (r.content[0] as { text: string }).text;
		expect(t).toMatch(/listorna byggda ur indexet \(index 2026-11-17\)\.$/m);
		expect(t).not.toMatch(/listorna hämtade/);
		const utan = await uppslag({ lista: "kommuner" } as Parameters<typeof uppslag>[0], { domains: deps.domains } as unknown as Parameters<typeof uppslag>[1]);
		expect((utan.content[0] as { text: string }).text).toMatch(/listorna byggda ur indexet \(indexets datum okänt\)/);
	});

	it("8f: vokaliserad hebreiska (fem kombinerande tecken i följd) klipps inte; NFC igen efter att osynliga tecken tagits bort", async () => {
		const { rensaRad, MAX_KOMBINERANDE } = await import("../src/extern_text");
		// Bokstaven shin med shin-punkt, dagesh, qamats, meteg och kantillationstecken: fem i följd.
		const hebreiska = "שָּֽׁ֑ל";
		expect(rensaRad(hebreiska)).toBe(hebreiska.normalize("NFC"));
		expect(MAX_KOMBINERANDE).toBeGreaterThanOrEqual(5);
		// a + nollbreddsblanksteg + trema: blir ä, inte a + lös diakrit.
		expect(rensaRad("a​̈")).toBe("ä");
		expect(rensaRad("Bjursa​̊s")).toBe("Bjursås");
	});

	it("9: bakgrundskontexten blandas inte ihop mellan två samtidiga förfrågningar", async () => {
		const { iBakgrunden, medBakgrund } = await import("../src/bakgrund");
		const a: Array<Promise<unknown>> = [];
		const b: Array<Promise<unknown>> = [];
		const vanta = (ms: number) => new Promise((r) => setTimeout(r, ms));
		await Promise.all([
			medBakgrund({ waitUntil: (p) => a.push(p) }, async () => {
				await vanta(10);
				iBakgrunden(Promise.resolve("a1"));
				await vanta(10);
				iBakgrunden(Promise.resolve("a2"));
			}),
			medBakgrund({ waitUntil: (p) => b.push(p) }, async () => {
				await vanta(5);
				iBakgrunden(Promise.resolve("b1"));
				await vanta(20);
				iBakgrunden(Promise.resolve("b2"));
				iBakgrunden(Promise.resolve("b3"));
			}),
		]);
		expect(a).toHaveLength(2);
		expect(b).toHaveLength(3);
		expect(iBakgrunden(Promise.resolve())).toBe(false);
	});
});
