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

/**
 * Inspelat 2026-11-18: GET https://nominatim.openstreetmap.org/search?q=Bjurs%C3%A5s
 * &countrycodes=se&format=jsonv2&limit=5&addressdetails=1&accept-language=sv
 */
const NOMINATIM_BJURSAS = [
	{
		place_id: 161726177,
		licence: "Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright",
		osm_type: "node",
		osm_id: 320526605,
		lat: "60.7377645",
		lon: "15.4511052",
		category: "place",
		type: "village",
		place_rank: 19,
		importance: 0.3544115905399448,
		addresstype: "village",
		name: "Bjursås",
		display_name: "Bjursås, Falu kommun, Dalarnas län, 790 21, Sverige",
		address: {
			village: "Bjursås",
			municipality: "Falu kommun",
			county: "Dalarnas län",
			"ISO3166-2-lvl4": "SE-W",
			postcode: "790 21",
			country: "Sverige",
			country_code: "se",
		},
		boundingbox: ["60.7177645", "60.7577645", "15.4311052", "15.4711052"],
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
		// Bjursås och Falun har egna svar (inspelat respektive tomt); övriga frågor får `body`.
		const q = url.searchParams.get("q") ?? "";
		const svar = q === "Bjursås" ? NOMINATIM_BJURSAS : q === "Falun" ? [] : body;
		return status === 200
			? json(svar, 200, "application/json; charset=utf-8")
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

	it("socken ur indexet, och orten ur OpenStreetMap som egen kandidat (först), med punktens sort", async () => {
		const res = await hittaPlats({ namn: "Bjursås" }, deps);
		const r = structured(res);
		expect(hittaPlatsOutput.parse(r)).toBeTruthy();
		expect(r.kalla).toBe("index+nominatim");
		expect(nom.calls).toHaveLength(1);
		expect(nom.calls[0].url.searchParams.get("q")).toBe("Bjursås");
		expect(r.kandidater[0]).toMatchObject({
			namn: "Bjursås",
			typ: "place/village",
			punkttyp: "ort",
			punkt: "ort enligt OpenStreetMap",
			kalla: "OpenStreetMap Nominatim",
			lat: 60.737765,
			lon: 15.451105,
		});
		expect(r.kandidater[1]).toMatchObject({
			namn: "Bjursås",
			typ: "socken",
			punkttyp: "omradets_lamningar",
			punkt: "mittpunkt för socknens registrerade lämningar",
			kommun: "Falun",
			lan: "Dalarna",
			antal_lamningar: 1,
			kalla: "Lämningsindex (D1)",
		});
		expect(r.kandidater[1].lat).toBeCloseTo(60.73368, 4);
		expect(r.kandidater[1].sweref99tm.e).toBeCloseTo(524893, -1);
		const t = (res.content[0] as { text: string }).text;
		expect(t).toContain("1. «Bjursås» – ort enligt OpenStreetMap (place/village), Falu kommun, Dalarnas län: 60.73777, 15.45111.");
		expect(t).toContain("2. «Bjursås» – mittpunkt för socknens registrerade lämningar (1 lämning) – inte orten, Falun kommun, Dalarnas län: 60.73368");
		expect(t).toMatch(/Orten Bjursås enligt OpenStreetMap ligger [\d,]+ km från mittpunkten för socknens registrerade lämningar \(samma kommun och län\)\. Använd ortspunkten för "nära Bjursås"/);
		expect(t).toMatch(/^Källa: serverns lämningsindex och OpenStreetMap Nominatim; index \(datum okänt\); OpenStreetMap hämtat nu\.$/m);
		expect(r.hamtad_fran).toBe("index (datum okänt); OpenStreetMap hämtat nu");
	});

	it("exakt namngiven lämning: bara indexet, inget anrop till Nominatim", async () => {
		const r = structured(await hittaPlats({ namn: "Mas-källa" }, deps));
		expect(r.kalla).toBe("index");
		expect(r.kandidater[0]).toMatchObject({ punkttyp: "namngiven_lamning", punkt: "namngiven lämning (lämningens mittpunkt)" });
		expect(nom.calls).toHaveLength(0);
	});

	it("socken med Nominatim avstängt eller nere: anmärkningen säger att punkten inte är orten", async () => {
		const av = createHittaPlatsDeps({ db: openD1(db), kv, fetch: nom.fetch, nominatim: "av" });
		const r = structured(await hittaPlats({ namn: "Bjursås" }, av));
		expect(r.kalla).toBe("index");
		expect(r.kandidater).toHaveLength(1);
		expect(r.anmarkningar.join(" ")).toMatch(/avstängt.*Socknens punkt är mittpunkten för dess registrerade lämningar, inte orten/);
		const nere = nominatimFetch(503);
		const d = { ...createHittaPlatsDeps({ db: openD1(db), fetch: nere.fetch }), sleep: async () => {} };
		const r2 = structured(await hittaPlats({ namn: "Bjursås" }, d));
		expect(r2.kandidater.map((k: S) => k.punkttyp)).toEqual(["omradets_lamningar"]);
		expect(r2.anmarkningar.join(" ")).toMatch(/gick inte att nå.*inte orten/);
	});

	it("kommun ur indexet: mittpunkt av kommunens lämningar", async () => {
		const r = structured(await hittaPlats({ namn: "Falun" }, deps));
		// OpenStreetMap frågas (kommunen är ett område) men har inget här (tomt svar).
		expect(nom.calls).toHaveLength(1);
		expect(r.kalla).toBe("index");
		expect(r.kandidater[0]).toMatchObject({
			punkttyp: "omradets_lamningar",
			punkt: "mittpunkt för kommunens registrerade lämningar",
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
		).toBe("index+nominatim");
		// Bjursås ligger inte i Jämtland: inget i indexet → Nominatim, vars träffar (i Dalarna) tas bort.
		const r = structured(await hittaPlats({ namn: "Bjursås", lan: "Jämtland" }, deps));
		expect(r.kalla).toBe("ingen");
		expect(r.anmarkningar.join(" ")).toMatch(/2 träffar i OpenStreetMap utanför Jämtlands län .*togs bort/);
		expect(nom.calls[1].url.searchParams.get("q")).toBe("Bjursås, Jämtlands län");
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
		expect([...kv.data.entries()].find(([k]) => k.startsWith("nominatim:v2:"))?.[1].ttl).toBe(NOMINATIM_TTL_S);
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
			expect((res.structuredContent as S).kandidater.map((k: S) => k.namn)).toEqual(["Bjursås", "Bjursås"]);
		} finally {
			await client.close();
		}
	});

	// ------------------------------------------------ Nominatims villkor: inga omförsök, spärr efter fel

	function statusFetch(svar: () => Response) {
		const calls: number[] = [];
		const fetch: FetchLike = async () => {
			calls.push(clock);
			return svar();
		};
		return { fetch, calls };
	}
	const medFetch = (f: FetchLike): HittaPlatsDeps => ({ ...createHittaPlatsDeps({ db: openD1(db), kv, fetch: f }), sleep: deps.sleep, now: deps.now });

	it("429 från Nominatim: inget omförsök, spärr i 10 minuter (även i ett annat isolat via KV), svaret säger att OpenStreetMap inte frågades", async () => {
		const f = statusFetch(() => json({ error: "för många" }, 429));
		const d = medFetch(f.fetch);
		const r1 = structured(await hittaPlats({ namn: "Kopparvågen" }, d));
		expect(f.calls).toHaveLength(1);
		expect(r1.openstreetmap).toBe("fel");
		expect(r1.anmarkningar.join(" ")).toMatch(/svarade 429; nästa fråga dit tidigast/);
		// Andra namn, samma isolat: inget anrop.
		clock += 60_000;
		const r2 = await hittaPlats({ namn: "Bjursås" }, d);
		expect(f.calls).toHaveLength(1);
		expect(structured(r2).openstreetmap).toBe("sparrad");
		expect(structured(r2).anmarkningar.join(" ")).toMatch(/OpenStreetMap Nominatim frågades inte: efter ett fel \(svarade 429\)/);
		expect((r2.content[0] as { text: string }).text).toMatch(/OpenStreetMap frågades inte \(spärrad efter fel\)/);
		// Ett nytt isolat (isolatets minne nollställt) läser spärren ur KV.
		aterstallNominatimKo();
		await hittaPlats({ namn: "Stora Stöten" }, d);
		expect(f.calls).toHaveLength(1);
		expect(kv.data.get("nominatim:sparr:v1")?.ttl).toBe(600);
		// Efter tio minuter: frågas igen.
		clock += 10 * 60_000;
		const ok = medFetch(nom.fetch);
		expect(structured(await hittaPlats({ namn: "Falu gruva" }, ok)).openstreetmap).toBe("fragad");
	});

	it("Retry-After längre än 10 minuter förlänger spärren; 5xx, 403 och tidsgräns spärrar också, utan omförsök", async () => {
		const f = statusFetch(() => new Response("", { status: 429, headers: { "retry-after": "1800" } }));
		await hittaPlats({ namn: "Kopparvågen" }, medFetch(f.fetch));
		expect(kv.data.get("nominatim:sparr:v1")?.ttl).toBe(1800);
		for (const svar of [() => json({}, 503), () => json({}, 403), () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }]) {
			aterstallNominatimKo();
			kv.data.clear();
			const g = statusFetch(svar as () => Response);
			const r = structured(await hittaPlats({ namn: "Kopparvågen" }, medFetch(g.fetch)));
			expect(g.calls).toHaveLength(1);
			expect(r.openstreetmap).toBe("fel");
			expect(kv.data.has("nominatim:sparr:v1")).toBe(true);
		}
	});

	it("klienten för Nominatim gör inga omförsök (två anrop med 821 ms mellanrum vid 429 i granskningen)", async () => {
		const tider: number[] = [];
		const f: FetchLike = async () => {
			tider.push(Date.now());
			return json({}, 429);
		};
		const d = createHittaPlatsDeps({ fetch: f });
		const r = await d.client.get("https://nominatim.openstreetmap.org/search?q=x&countrycodes=se&format=jsonv2");
		expect(r.status).toBe(429);
		expect(tider).toHaveLength(1);
	});

	it("mellanrummet på 1,1 s hålls mot ett anrop från ett annat isolat (tidpunkt i KV)", async () => {
		await kv.put("nominatim:senaste:v1", JSON.stringify(clock - 300));
		await hittaPlats({ namn: "Falu gruva" }, deps);
		expect(sleeps).toEqual([800]);
		expect(await kv.get("nominatim:senaste:v1")).toBe(clock);
	});

	// ------------------------------------------------ samma namn på flera platser (granskningens Mo-fall)

	const MO_MUNKEDAL = { lat: "58.4700", lon: "11.6800", category: "place", type: "village", name: "Mo", display_name: "Mo, Munkedals kommun, Västra Götalands län, Sverige", address: { village: "Mo", municipality: "Munkedals kommun", county: "Västra Götalands län" } };
	const MO_LJUSDAL = { lat: "61.8600", lon: "16.1200", category: "place", type: "village", name: "Mo", display_name: "Mo, Ljusdals kommun, Gävleborgs län, Sverige", address: { village: "Mo", municipality: "Ljusdals kommun", county: "Gävleborgs län" } };
	function moSocken(): void {
		const ins = (niva: string, namn: string) => {
			db.prepare("INSERT OR IGNORE INTO omrade (niva, namn, lan) VALUES (?, ?, '')").run(niva, namn);
			return (db.prepare("SELECT id FROM omrade WHERE niva = ? AND namn = ? AND lan = ''").get(niva, namn) as { id: number }).id;
		};
		const mo = ins("socken", "Mo");
		const lj = ins("kommun", "Ljusdal");
		const gv = ins("lan", "Gävleborg");
		db.prepare("INSERT INTO omrade_sammanfattning (omrade_id, antal, med_lage, lat, lon, min_lat, min_lon, max_lat, max_lon) VALUES (?, 120, 120, 61.85, 16.10, 61.75, 15.95, 61.95, 16.25)").run(mo);
		db.prepare("INSERT INTO omrade_relation (omrade_id, overordnad_id, antal) VALUES (?, ?, 120), (?, ?, 120)").run(mo, lj, mo, gv);
	}
	function moFetch(traffar: unknown[]) {
		const calls: URL[] = [];
		const fetch: FetchLike = async (input) => {
			calls.push(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url));
			return json(traffar, 200, "application/json; charset=utf-8");
		};
		return { fetch, calls };
	}

	it("Mo i Gävleborg: indexet ger socknen i Ljusdal, OpenStreetMap Mo i Munkedal – Munkedal tas bort, ingen rekommendation mot fel ort", async () => {
		moSocken();
		const f = moFetch([MO_MUNKEDAL]);
		const res = await hittaPlats({ namn: "Mo", lan: "Gävleborg" }, medFetch(f.fetch));
		const r = structured(res);
		expect(r.kandidater.map((k: S) => [k.namn, k.punkttyp, k.lan])).toEqual([["Mo", "omradets_lamningar", "Gävleborg"]]);
		const t = (res.content[0] as { text: string }).text;
		expect(t).not.toMatch(/Munkedal.*Använd ortspunkten|Använd ortspunkten/);
		expect(t).toMatch(/1 träff i OpenStreetMap utanför Gävleborgs län .*togs bort/);
		// Socknens utbredning skickas som föredraget område.
		expect(f.calls[0].searchParams.get("viewbox")).toBe("15.9000,61.7000,16.3000,62.0000");
		expect(f.calls[0].searchParams.get("q")).toBe("Mo, Gävleborgs län");
	});

	it("Mo utan län: orten i Munkedal och socknen i Ljusdal visas som skilda kandidater med kommun och län, utan rekommendation", async () => {
		moSocken();
		const res = await hittaPlats({ namn: "Mo" }, medFetch(moFetch([MO_MUNKEDAL]).fetch));
		const r = structured(res);
		expect(r.kandidater.map((k: S) => [k.punkttyp, k.kommun, k.lan])).toEqual([
			["omradets_lamningar", "Ljusdal", "Gävleborg"],
			["ort", "Munkedals kommun", "Västra Götaland"],
		]);
		const t = (res.content[0] as { text: string }).text;
		expect(t).not.toMatch(/Använd ortspunkten/);
		expect(t).toMatch(/Mo \(Munkedals kommun, Västra Götalands län\) enligt OpenStreetMap är inte samma plats som socknen Mo \(Ljusdal kommun, Gävleborgs län\)/);
		expect(t).toMatch(/Flera platser heter Mo: .*Fråga användaren vilken som avses/);
	});

	it("Mo i Gävleborg när OpenStreetMap har båda: orten i Ljusdal paras med socknen och rekommenderas, Munkedal tas bort", async () => {
		moSocken();
		const res = await hittaPlats({ namn: "Mo", lan: "Gävleborg" }, medFetch(moFetch([MO_MUNKEDAL, MO_LJUSDAL]).fetch));
		const r = structured(res);
		expect(r.kandidater.map((k: S) => [k.punkttyp, k.lan])).toEqual([["ort", "Gävleborg"], ["omradets_lamningar", "Gävleborg"]]);
		const t = (res.content[0] as { text: string }).text;
		expect(t).toMatch(/Orten Mo enligt OpenStreetMap ligger [\d,]+ km från mittpunkten för socknens registrerade lämningar \(samma kommun och län\)/);
		expect(t).not.toMatch(/Flera platser heter/);
	});

	it("samma kommun men för långt bort: ingen ihopparning", async () => {
		moSocken();
		const langt = { ...MO_LJUSDAL, lat: "62.3000", lon: "15.2000" };
		const t = ((await hittaPlats({ namn: "Mo" }, medFetch(moFetch([langt]).fetch))).content[0] as { text: string }).text;
		expect(t).not.toMatch(/Använd ortspunkten/);
		expect(t).toMatch(/är inte samma plats/);
	});

	it("kommunLika: Nominatims kommunform mot indexets", async () => {
		const { kommunLika } = await import("../src/tools/hitta_plats");
		expect(kommunLika("Falu kommun", "Falun")).toBe(true);
		expect(kommunLika("Munkedals kommun", "Munkedal")).toBe(true);
		expect(kommunLika("Göteborgs Stad", "Göteborg")).toBe(true);
		expect(kommunLika("Mora kommun", "Mora")).toBe(true);
		expect(kommunLika("Munkedals kommun", "Ljusdal")).toBe(false);
		expect(kommunLika(null, "Ljusdal")).toBe(false);
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
