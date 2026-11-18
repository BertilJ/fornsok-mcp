/**
 * hitta_plats: indexet först (D1 i node:sqlite, fyllt av nattsynken från
 * inspelade poster), Nominatim bara när indexet saknar svar (inspelat svar
 * nedan), KV-cache, hastighetsgräns och avstängning.
 */
import type { DatabaseSync } from "node:sqlite";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KvLike } from "../src/cache/kv";
import { runSync } from "../src/sync/run";
import {
	aterstallNominatimKo,
	sattNominatimKo,
	createHittaPlatsDeps,
	HITTA_PLATS_BESKRIVNING,
	type HittaPlatsDeps,
	hittaPlats,
	hittaPlatsOutput,
	NOMINATIM_TTL_S,
	registerHittaPlats,
} from "../src/tools/hitta_plats";
import { checkAllowed } from "../src/upstream/allowlist";
import type { FetchLike } from "../src/upstream/client";
import { json } from "./helpers";
import { emptyDb, fakeRaa, flodePost, openD1, UUID } from "./sync/helpers";

/**
 * Inspelat 2026-11-17: GET https://nominatim.openstreetmap.org/search?q=Falu%20gruva
 * &countrycodes=se&format=jsonv2&limit=5&addressdetails=1&accept-language=sv
 */
const NOMINATIM_FALU_GRUVA = [
	{
		place_id: 161844726,
		licence: "Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright",
		osm_type: "way",
		osm_id: 87819714,
		lat: "60.5987854",
		lon: "15.6110496",
		category: "place",
		type: "locality",
		place_rank: 25,
		importance: 0.40308494416412793,
		addresstype: "locality",
		name: "Falu Gruva",
		display_name: "Falu Gruva, Krondiket, Falun, Falu kommun, Dalarnas län, Sverige",
		address: {
			locality: "Falu Gruva",
			neighbourhood: "Krondiket",
			city: "Falun",
			municipality: "Falu kommun",
			county: "Dalarnas län",
			"ISO3166-2-lvl4": "SE-W",
			country: "Sverige",
			country_code: "se",
		},
		boundingbox: ["60.5967765", "60.6007602", "15.6054812", "15.6166792"],
	},
	{
		place_id: 159735077,
		licence: "Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright",
		osm_type: "node",
		osm_id: 583003121,
		lat: "60.5993088",
		lon: "15.6124066",
		category: "place",
		type: "locality",
		place_rank: 25,
		importance: 0.07194870560319186,
		addresstype: "locality",
		name: "Stora Stöten",
		display_name: "Stora Stöten, Falun, Falu kommun, Dalarnas län, 791 61, Sverige",
		address: {
			locality: "Stora Stöten",
			city: "Falun",
			municipality: "Falu kommun",
			county: "Dalarnas län",
			"ISO3166-2-lvl4": "SE-W",
			postcode: "791 61",
			country: "Sverige",
			country_code: "se",
		},
		boundingbox: ["60.5893088", "60.6093088", "15.6024066", "15.6224066"],
	},
];

class FakeKv implements KvLike {
	data = new Map<string, { value: string; ttl?: number }>();
	async get(key: string) {
		const v = this.data.get(key);
		return v ? JSON.parse(v.value) : null;
	}
	async put(key: string, value: string, options?: { expirationTtl?: number }) {
		this.data.set(key, { value, ttl: options?.expirationTtl });
	}
}

function nominatimFetch(status = 200, body: unknown = NOMINATIM_FALU_GRUVA) {
	const calls: Array<{ url: URL; ua: string | null }> = [];
	const fetch: FetchLike = async (input, init) => {
		const url = new URL(
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
		);
		calls.push({ url, ua: new Headers(init?.headers).get("user-agent") });
		if (url.hostname !== "nominatim.openstreetmap.org")
			return new Response("oväntat", { status: 599 });
		return status === 200
			? json(body, 200, "application/json; charset=utf-8")
			: json({ error: "fel" }, status);
	};
	return { fetch, calls };
}

type S = Record<string, any>;
const structured = (r: { structuredContent?: unknown }) => r.structuredContent as S;

describe("hitta_plats", () => {
	let db: DatabaseSync;
	let kv: FakeKv;
	let nom: ReturnType<typeof nominatimFetch>;
	let deps: HittaPlatsDeps;
	let sleeps: number[];
	let clock: number;

	beforeEach(async () => {
		aterstallNominatimKo();
		db = emptyDb();
		const raa = fakeRaa();
		raa.flode.set("2026-11-11", [
			flodePost(UUID.L2001_646, "L2001:646", ["NY"]),
			flodePost(UUID.L2000_8802, "L2000:8802", ["NY"]),
			flodePost(UUID.L1946_7415, "L1946:7415", ["NY"]),
		]);
		await runSync(
			{ DB: openD1(db) },
			{
				now: new Date("2026-11-12T04:00:00Z"),
				fetch: raa.fetch,
				sleep: async () => {},
				pausMs: 0,
			},
		);
		kv = new FakeKv();
		nom = nominatimFetch();
		sleeps = [];
		clock = 1_000_000;
		deps = {
			...createHittaPlatsDeps({
				db: openD1(db),
				kv,
				contactUrl: "https://example.org/kontakt",
				fetch: nom.fetch,
			}),
			sleep: async (ms) => {
				sleeps.push(ms);
				clock += ms;
			},
			now: () => clock,
		};
	});
	afterEach(() => db.close());

	it("socken ur indexet, utan anrop till Nominatim", async () => {
		const r = structured(await hittaPlats({ namn: "bjursås" }, deps));
		expect(hittaPlatsOutput.parse(r)).toBeTruthy();
		expect(r.kalla).toBe("index");
		expect(r.kandidater[0]).toMatchObject({
			namn: "Bjursås",
			typ: "socken",
			kommun: "Falun",
			lan: "Dalarna",
			antal_lamningar: 1,
			kalla: "Lämningsindex (D1)",
		});
		expect(r.kandidater[0].lat).toBeCloseTo(60.73368, 4);
		expect(r.kandidater[0].sweref99tm.e).toBeCloseTo(524893, -1);
		expect(nom.calls).toHaveLength(0);
	});

	it("kommun ur indexet: mittpunkt av kommunens lämningar", async () => {
		const r = structured(await hittaPlats({ namn: "Falun" }, deps));
		expect(r.kandidater[0]).toMatchObject({
			namn: "Falun",
			typ: "kommun",
			antal_lamningar: 2,
			lan: "Dalarna",
		});
		expect(r.kandidater[0].utbredning).toHaveLength(4);
	});

	it("namngiven lämning, exakt och skiftlägesokänsligt", async () => {
		const r = structured(await hittaPlats({ namn: "mas-källa" }, deps));
		expect(r.kandidater).toHaveLength(1);
		expect(r.kandidater[0]).toMatchObject({
			namn: "Mas-källa",
			typ: "lämning (Källa med tradition)",
			lamningsnummer: "L2001:646",
			url: `https://pub.raa.se/visa/objekt/lamning/${UUID.L2001_646}`,
		});
	});

	it("kommun- och länsfilter", async () => {
		expect(
			structured(await hittaPlats({ namn: "Bjursås", lan: "Dalarnas län" }, deps)).kalla,
		).toBe("index");
		// Bjursås ligger inte i Jämtland: inget i indexet → Nominatim.
		const r = structured(await hittaPlats({ namn: "Bjursås", lan: "Jämtland" }, deps));
		expect(r.kalla).toBe("nominatim");
		expect(nom.calls[0].url.searchParams.get("q")).toBe("Bjursås, Jämtlands län");
		await expect(hittaPlats({ namn: "Bjursås", lan: "Atlantis" }, deps)).rejects.toThrow(
			/Okänt län/,
		);
	});

	it("Nominatim när indexet saknar svar: Sverige, User-Agent, cache 30 dygn", async () => {
		const res = await hittaPlats({ namn: "Falu gruva" }, deps);
		const r = structured(res);
		expect(hittaPlatsOutput.parse(r)).toBeTruthy();
		expect(r.kalla).toBe("nominatim");
		expect(r.kandidater.map((k: S) => k.namn)).toEqual(["Falu Gruva", "Stora Stöten"]);
		expect(r.kandidater[0]).toMatchObject({
			typ: "place/locality",
			kommun: "Falu kommun",
			lan: "Dalarna",
			kalla: "OpenStreetMap Nominatim",
			lat: 60.598785,
			lon: 15.61105,
		});
		expect(r.kandidater[0].utbredning).toEqual([15.60548, 60.59678, 15.61668, 60.60076]);
		expect(r.anmarkningar.join(" ")).toMatch(/OpenStreetMap-bidragsgivare, ODbL/);
		expect(nom.calls).toHaveLength(1);
		const u = nom.calls[0].url;
		expect(u.origin + u.pathname).toBe("https://nominatim.openstreetmap.org/search");
		expect(Object.fromEntries(u.searchParams)).toEqual({
			q: "Falu gruva",
			countrycodes: "se",
			format: "jsonv2",
			limit: "5",
			addressdetails: "1",
			"accept-language": "sv",
		});
		expect(nom.calls[0].ua).toBe("fornsok-mcp/0.1 (+https://example.org/kontakt)");
		expect([...kv.data.values()][0].ttl).toBe(NOMINATIM_TTL_S);
		expect(res.content[0]).toMatchObject({ type: "text" });
		expect((res.content[0] as { text: string }).text).toMatch(/lamningar_nara/);

		// Samma fråga igen: ur KV, inget nytt anrop.
		const r2 = structured(await hittaPlats({ namn: "falu gruva" }, deps));
		expect(r2.kandidater).toHaveLength(2);
		expect(r2.anmarkningar.join(" ")).toMatch(/sparat svar/);
		expect(nom.calls).toHaveLength(1);
	});

	it("högst ett anrop per sekund", async () => {
		await hittaPlats({ namn: "Falu gruva" }, deps);
		await hittaPlats({ namn: "Kopparvågen" }, deps);
		await hittaPlats({ namn: "Stora Stöten" }, deps);
		expect(nom.calls).toHaveLength(3);
		expect(sleeps).toEqual([1100, 1100]);
	});

	it("ett anrop som aldrig blir klart (avbruten förfrågan) blockerar inte senare anrop för alltid", async () => {
		sattNominatimKo({ maxHoldMs: 100, maxWaitMs: 2000, pollMs: 5 });
		const hang = { ...deps, client: { get: () => new Promise<never>(() => {}) } as unknown as HittaPlatsDeps["client"] };
		void hittaPlats({ namn: "Hänger" }, hang);
		await new Promise((r) => setTimeout(r, 20));
		const r = await hittaPlats({ namn: "Falu gruva" }, deps);
		expect(structured(r).kalla).toBe("nominatim");
		// Väntan har en gräns: upptaget ger ett svar med anmärkning, inte en hängning.
		sattNominatimKo({ maxHoldMs: 60_000, maxWaitMs: 30, pollMs: 5 });
		void hittaPlats({ namn: "Hänger igen" }, hang);
		await new Promise((r) => setTimeout(r, 10));
		const r2 = await hittaPlats({ namn: "Kopparvågen" }, deps);
		expect(structured(r2).anmarkningar.join(" ")).toMatch(/Nominatim gick inte att nå \(OpenStreetMap Nominatim är upptaget/);
		aterstallNominatimKo();
	});

	it("tomma svar sparas också; utan träff tips om TORA", async () => {
		const tomt = nominatimFetch(200, []);
		const d = {
			...deps,
			...createHittaPlatsDeps({ db: openD1(db), kv, fetch: tomt.fetch }),
			sleep: deps.sleep,
			now: deps.now,
		};
		const r = structured(await hittaPlats({ namn: "Knutsbo fäbod" }, d));
		expect(r.kalla).toBe("ingen");
		expect(r.anmarkningar.join(" ")).toMatch(/TORA/);
		await hittaPlats({ namn: "Knutsbo fäbod" }, d);
		expect(tomt.calls).toHaveLength(1);
	});

	it("avstängd Nominatim (NOMINATIM=av) och fel hos Nominatim ger svar, inte fel", async () => {
		const av = {
			...createHittaPlatsDeps({ db: openD1(db), kv, fetch: nom.fetch, nominatim: "av" }),
		};
		const r = structured(await hittaPlats({ namn: "Falu gruva" }, av));
		expect(r.kalla).toBe("ingen");
		expect(r.anmarkningar.join(" ")).toMatch(/avstängt/);
		expect(nom.calls).toHaveLength(0);

		const nere = nominatimFetch(503);
		const d = {
			...createHittaPlatsDeps({ db: openD1(db), fetch: nere.fetch }),
			sleep: async () => {},
		};
		const res = await hittaPlats({ namn: "Falu gruva" }, d);
		expect(res.isError).toBeFalsy();
		expect(structured(res).anmarkningar.join(" ")).toMatch(/gick inte att nå/);
	});

	it("utan index går frågan direkt till Nominatim", async () => {
		const d = { ...createHittaPlatsDeps({ kv, fetch: nom.fetch }), sleep: async () => {} };
		const r = structured(await hittaPlats({ namn: "Bjursås" }, d));
		expect(r.kalla).toBe("nominatim");
		expect(r.anmarkningar[0]).toMatch(/inte inkopplat/);
	});

	it("registreras med schema, annotationer och beskrivning som nämner TORA", async () => {
		expect(HITTA_PLATS_BESKRIVNING).toMatch(/TORA i Riksarkivets koppling/);
		expect(HITTA_PLATS_BESKRIVNING).toMatch(/lamningar_nara/);
		const handler = createMcpHandler(() => {
			const s = new McpServer({ name: "t", version: "0" });
			registerHittaPlats(s, deps);
			return s;
		});
		const ctx = {
			waitUntil() {},
			passThroughOnException() {},
			props: {},
		} as unknown as ExecutionContext;
		const client = new Client({ name: "test", version: "0.0.0" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp"), {
				fetch: async (input, init) => {
					const req = new Request(input, init);
					req.headers.set("host", new URL(req.url).host);
					return handler(req, {}, ctx);
				},
			}),
		);
		try {
			const { tools } = await client.listTools();
			expect(tools.map((t) => t.name)).toEqual(["hitta_plats"]);
			expect(tools[0].annotations).toMatchObject({
				readOnlyHint: true,
				idempotentHint: true,
				openWorldHint: true,
				destructiveHint: false,
			});
			expect(tools[0].outputSchema).toBeTruthy();
			const res = await client.callTool({
				name: "hitta_plats",
				arguments: { namn: "Bjursås" },
			});
			expect((res.structuredContent as S).kandidater[0].namn).toBe("Bjursås");
		} finally {
			await client.close();
		}
	});

	it("listan över tillåtna anrop: bara sökning i Sverige med kända parametrar", () => {
		const ok =
			"https://nominatim.openstreetmap.org/search?q=Falu+gruva&countrycodes=se&format=jsonv2&limit=5&addressdetails=1&accept-language=sv";
		expect(checkAllowed("GET", ok).id).toBe("nominatim.search");
		for (const bad of [
			"https://nominatim.openstreetmap.org/search?q=x&countrycodes=no&format=jsonv2",
			"https://nominatim.openstreetmap.org/search?q=x&format=jsonv2",
			"https://nominatim.openstreetmap.org/reverse?lat=60&lon=15&countrycodes=se&format=jsonv2",
			"https://nominatim.openstreetmap.org/search?q=x&countrycodes=se&format=jsonv2&limit=50",
			"https://nominatim.openstreetmap.org/search?q=x&countrycodes=se&format=jsonv2&polygon_geojson=1",
		])
			expect(() => checkAllowed("GET", bad)).toThrow();
		expect(() => checkAllowed("POST", ok)).toThrow();
	});
});
