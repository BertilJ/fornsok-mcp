/**
 * Granskningens fynd i indexdelen (etapp 4), ett test per punkt, mot Falu
 * kommun i lokal SQLite. Hoppar över sig självt om ingest/.cache/falun.gpkg saknas.
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nearestPoint, wgsToSweref, type Geometry } from "../../src/geo/geometry";
import { toPlanar } from "../../src/geo/sweref";
import { compareLamningsnummer, IndexStore, MAX_OFFSET } from "../../src/store";
import { wgsBoxToSweref } from "../../src/store/spatial";
import { d1FromSqlite } from "./d1-adapter";
import { HAS_FALUN, type LoadedFalun, loadFalun, SKIP_MESSAGE } from "./falun-fixture";

const FALU_GRUVA = { lat: 60.6036, lon: 15.6302 };

describe("punkt 4: wgsBoxToSweref täcker hela WGS 84-rutan", () => {
	for (const box of [
		[14, 60, 17, 61],
		[10.5, 57, 24, 68],
		[15.62, 60.6, 15.64, 60.61],
		[16, 58, 18, 59],
	] as Array<[number, number, number, number]>) {
		it(`[${box.join(", ")}]`, () => {
			const [minE, minN, maxE, maxN] = wgsBoxToSweref(box);
			const [minLon, minLat, maxLon, maxLat] = box;
			// Tätt rutnät över hela rutan (kanterna är där extremvärdena ligger).
			for (let i = 0; i <= 200; i++) {
				for (const [lat, lon] of [
					[minLat, minLon + ((maxLon - minLon) * i) / 200],
					[maxLat, minLon + ((maxLon - minLon) * i) / 200],
					[minLat + ((maxLat - minLat) * i) / 200, minLon],
					[minLat + ((maxLat - minLat) * i) / 200, maxLon],
				]) {
					const p = toPlanar({ lat, lon });
					expect(p.e).toBeGreaterThanOrEqual(minE);
					expect(p.e).toBeLessThanOrEqual(maxE);
					expect(p.n).toBeGreaterThanOrEqual(minN);
					expect(p.n).toBeLessThanOrEqual(maxN);
				}
			}
		});
	}
});

describe("punkt 8: lämningsnummer jämförs som tal", () => {
	it("L2000:999 före L2000:1000, år först, null sist", () => {
		const xs = ["L2000:1000", null, "L2001:2", "L2000:999", "L1999:5000", "L2000:99"];
		expect([...xs].sort(compareLamningsnummer)).toEqual(["L1999:5000", "L2000:99", "L2000:999", "L2000:1000", "L2001:2", null]);
	});
});

describe.skipIf(!HAS_FALUN)(`Granskningens fynd mot Falu kommun ${HAS_FALUN ? "" : `(${SKIP_MESSAGE})`}`, () => {
	let f: LoadedFalun;
	let db: DatabaseSync;
	let store: IndexStore;
	const queries: Array<{ sql: string; params: unknown[] }> = [];
	let all: Array<{ uuid: string; lamningsnummer: string; g: Geometry }>;

	beforeAll(() => {
		f = loadFalun();
		db = f.open();
		store = new IndexStore(d1FromSqlite(db, (sql, params) => queries.push({ sql, params })));
		all = (db.prepare("SELECT uuid, lamningsnummer, geometri FROM lamning").all() as Array<{ uuid: string; lamningsnummer: string; geometri: string }>).map(
			(r) => ({ uuid: r.uuid, lamningsnummer: r.lamningsnummer, g: JSON.parse(r.geometri) as Geometry }),
		);
	});
	afterAll(() => {
		db?.close();
		f?.cleanup();
	});

	const exhaustive = (p: { lat: number; lon: number }, r: number) => {
		const pl = toPlanar(p);
		return all
			.map((x) => ({ uuid: x.uuid, d: nearestPoint(pl, wgsToSweref(x.g)).distance }))
			.filter((x) => x.d <= r)
			.sort((a, b) => a.d - b.d);
	};

	// ---------------------------------------------------------------- 1

	it("punkt 1: täta områden – de närmaste kommer alltid med, och svaret är fullständigt inom fullstandig_inom_m", async () => {
		// Ett lågt kandidattak gör att Falun beter sig som en tät trakt i full skala.
		const tight = new IndexStore(d1FromSqlite(db), { maxKandidater: 300 });
		const r = await tight.nearby({ ...FALU_GRUVA, radie_m: 10_000, antal: 50 });
		const ex = exhaustive(FALU_GRUVA, 10_000);
		expect(ex.length).toBeGreaterThan(300);
		expect(r.totalt_ungefar).toBe(true);
		expect(r.fullstandig_inom_m).toBeGreaterThan(0);
		// De 50 närmaste är exakt de verkligt närmaste.
		expect(r.traffar.map((h) => h.uuid)).toEqual(ex.slice(0, 50).map((x) => x.uuid));
		// Totalen är exakt inom gränsen där svaret är fullständigt.
		const inom = ex.filter((x) => x.d <= (r.fullstandig_inom_m as number) + 1).length;
		expect(Math.abs(r.totalt - inom)).toBeLessThanOrEqual(1);

		// Samma i sökningen med nara (utan sökord: närmast först).
		const s = await tight.searchIndex({ nara: { ...FALU_GRUVA, radie_m: 10_000 } }, { antal: 15 });
		expect(s.totalt_ungefar).toBe(true);
		expect(s.traffar.map((h) => h.uuid)).toEqual(ex.slice(0, 15).map((x) => x.uuid));
		// Och utan tak blir svaret fullständigt.
		const full = await store.nearby({ ...FALU_GRUVA, radie_m: 10_000, antal: 15 });
		expect(full.totalt).toBe(ex.length);
		expect(full.totalt_ungefar).toBeUndefined();
	});

	// ---------------------------------------------------------------- 2

	it("punkt 2: ett RAÄ-nummer som delas av flera lämningar ger alla, i nummerordning", async () => {
		const m = await store.resolveIdsAll(["Stora Kopparberg 70:1", "Enviken 190:1", "L2001:646"]);
		const nr = (uuids: string[] | undefined) => (uuids ?? []).map((u) => all.find((x) => x.uuid === u)?.lamningsnummer);
		expect(nr(m.get("Stora Kopparberg 70:1"))).toEqual(["L2000:8956", "L2000:8957", "L2000:8958"]);
		expect(nr(m.get("Enviken 190:1"))).toEqual(["L2001:851", "L2001:852"]);
		expect(nr(m.get("L2001:646"))).toEqual(["L2001:646"]);
		// resolveIds ger ett deterministiskt val (lägst nummer), inte ett godtyckligt.
		expect(nr([(await store.resolveIds(["Stora Kopparberg 70:1"])).get("Stora Kopparberg 70:1") as string])).toEqual(["L2000:8956"]);
	});

	// ---------------------------------------------------------------- 3

	it("punkt 3: många egenskapstyper med nara och alla listfilter håller sig under 100 parametrar", async () => {
		queries.length = 0;
		const egenskap = Array.from({ length: 50 }, (_, i) => ({ typ: `Typ${i}`, varde: `V${i}` }));
		const filter = {
			fraga: "hytta",
			nummer: ["L2001:646"],
			lamningstyp: ["Hyttområde"],
			kategori: ["Metallframställning och bergsbruk"],
			antikvarisk_bedomning: ["Fornlämning" as const],
			kommun: ["Falun"],
			socken: [{ namn: "Bjursås", lan: ["Dalarna"] }],
			landskap: ["Dalarna"],
			lan: ["Dalarna"],
			egenskap,
			nara: { ...FALU_GRUVA, radie_m: 5000 },
		};
		await expect(store.searchIndex(filter)).resolves.toMatchObject({ totalt: 0 });
		await expect(store.statistik(["typ"], filter)).resolves.toBeTruthy();
		await expect(store.searchRanked(filter, 100)).resolves.toBeTruthy();
		expect(queries.length).toBeGreaterThan(0);
		for (const q of queries) expect(q.params.length).toBeLessThanOrEqual(60);
		// Egenskaperna tar två parametrar oavsett antal typer.
		const eq = queries.find((q) => q.sql.includes("FROM json_each(?) j\n\t\t\t\t\tJOIN egenskap"));
		expect(eq).toBeTruthy();
		// Semantiken är kvar: samma typ ELLER, olika typer OCH.
		const mid = await store.searchIndex({ egenskap: [{ typ: "Typ", varde: "Midsommar/trefaldighet" }] }, { antal: 100 });
		const either = await store.searchIndex({ egenskap: [{ typ: "Typ", varde: "Midsommar/trefaldighet" }, { typ: "Typ", varde: "Gruvhål" }] });
		const gruvhal = await store.searchIndex({ egenskap: [{ typ: "Typ", varde: "Gruvhål" }] });
		expect(either.totalt).toBeGreaterThanOrEqual(Math.max(mid.totalt, gruvhal.totalt));
		expect(either.totalt).toBeLessThanOrEqual(mid.totalt + gruvhal.totalt);
		const both = await store.searchIndex({ egenskap: [{ typ: "Form", varde: "Rund" }, { typ: "Typ", varde: "Kolbotten resmila" }] });
		const direct = db
			.prepare(
				"SELECT count(*) AS c FROM lamning WHERE id IN (SELECT lamning_id FROM egenskap WHERE typ = 'Form' AND varde = 'Rund') AND id IN (SELECT lamning_id FROM egenskap WHERE typ = 'Typ' AND varde = 'Kolbotten resmila')",
			)
			.get() as { c: number };
		expect(direct.c).toBeGreaterThan(0);
		expect(both.totalt).toBe(direct.c);
		// Tre typer, varav en med två värden.
		const tre = await store.searchIndex({
			egenskap: [
				{ typ: "Form", varde: "Rund" },
				{ typ: "Typ", varde: "Kolbotten resmila" },
				{ typ: "Verksamhet", varde: "Kolning" },
				{ typ: "Verksamhet", varde: "Finns inte" },
			],
		});
		expect(tre.totalt).toBeLessThanOrEqual(both.totalt);
		expect(tre.totalt).toBeGreaterThan(0);
	});

	// ---------------------------------------------------------------- 5

	it("punkt 5: sökord + nara – lämning är yttre loop, inte FTS-tabellen", async () => {
		queries.length = 0;
		const r = await store.searchIndex({ fraga: "och", nara: { ...FALU_GRUVA, radie_m: 3000 } }, { antal: 10 });
		expect(r.totalt).toBeGreaterThan(0);
		const cand = queries.find((q) => /ORDER BY dx \* dx \+ dy \* dy/.test(q.sql));
		expect(cand?.sql).toContain("FROM lamning l CROSS JOIN lamning_fts f ON f.rowid = l.id");
		const plan = (db.prepare(`EXPLAIN QUERY PLAN ${cand!.sql}`).all(...(cand!.params as SQLInputValue[])) as Array<{ detail: string }>).map((x) => x.detail);
		expect(plan[0]).toMatch(/^SEARCH l /);
		expect(plan.join(" | ")).not.toMatch(/^SCAN f/);
		// Rangordningen gäller fortfarande: samma som utan radie, begränsat till radien.
		for (const h of r.traffar) expect(h.avstand_m).toBeLessThanOrEqual(3000);
		expect(r.traffar.some((h) => h.utdrag?.includes("«och»"))).toBe(true);
	});

	// ---------------------------------------------------------------- 6

	it("punkt 6: sidor klipps inte tyst; nabara anger hur långt det går att bläddra", async () => {
		const p40 = await store.searchIndex({ kommun: ["Falun"] }, { antal: 100, sida: 40 });
		expect(p40.totalt).toBe(3908);
		expect(p40.nabara).toBe(3908);
		expect(p40.traffar).toHaveLength(8);
		const p41 = await store.searchIndex({ kommun: ["Falun"] }, { antal: 100, sida: 41 });
		expect(p41.traffar).toHaveLength(0);
		// Bortom MAX_OFFSET: tom sida, inte en upprepning av sista sidan.
		const far = await store.searchIndex({ kommun: ["Falun"] }, { antal: 100, sida: MAX_OFFSET / 100 + 2 });
		expect(far.traffar).toHaveLength(0);
		expect(far.nabara).toBe(Math.min(far.totalt, MAX_OFFSET));
	});

	// ---------------------------------------------------------------- 8

	it("punkt 8: listning utan sökord sorteras på lämningsnummer som tal", async () => {
		const r = await store.searchIndex({ kommun: ["Falun"] }, { antal: 100, sida: 3 });
		const nr = r.traffar.map((h) => h.lamningsnummer);
		expect([...nr].sort(compareLamningsnummer)).toEqual(nr);
		const ranked = await store.searchRanked({ kommun: ["Falun"] }, 500);
		const all500 = await store.hitsByUuids(ranked.ids.slice(0, 100).map((x) => x.uuid));
		const order = ranked.ids.slice(0, 100).map((x) => all500.get(x.uuid)?.lamningsnummer ?? null);
		expect([...order].sort(compareLamningsnummer)).toEqual(order);
	});

	// ---------------------------------------------------------------- 9

	it("punkt 9: utdrag räknas bara för den sida som returneras", async () => {
		queries.length = 0;
		const r = await store.searchIndex({ fraga: "och" }, { antal: 5, sida: 20 });
		expect(r.traffar).toHaveLength(5);
		const withSnippet = queries.filter((q) => q.sql.includes("snippet("));
		expect(withSnippet).toHaveLength(1);
		expect(withSnippet[0].sql).toContain("l.id IN (SELECT value FROM json_each(?))");
		expect(JSON.parse(String(withSnippet[0].params[0]))).toHaveLength(5);
		const ranked = queries.find((q) => /ORDER BY bm25/.test(q.sql) && /OFFSET/.test(q.sql));
		expect(ranked?.sql).not.toContain("snippet(");
		// Sidan är densamma som med den gamla metoden (rang, sedan id).
		const p19 = await store.searchIndex({ fraga: "och" }, { antal: 5, sida: 19 });
		expect(new Set([...p19.traffar, ...r.traffar].map((h) => h.uuid)).size).toBe(10);
	});

	it("punkt 9: statistik per område utan filter (snabbväg) ger samma som den allmänna vägen", async () => {
		for (const d of ["socken", "kommun", "landskap", "lan"] as const) {
			const fast = await store.statistik([d]);
			// Ett filter som matchar allt tvingar den allmänna vägen.
			const general = await store.statistik([d], { kommun: ["Falun", "Leksand", "Rättvik", "Borlänge", "Gagnef", "Ockelbo", "Hofors", "Säter", "Ludvika", "Smedjebacken", "Sandviken", "Ovanåker", "Bollnäs", "Mora", "Orsa", "Vansbro", "Malung-Sälen", "Älvdalen", "Hedemora", "Avesta"] });
			expect(general.totalt).toBe(3908);
			expect(fast.totalt).toBe(3908);
			expect(fast.grupper).toEqual(general.grupper);
		}
	});

	it("statistik med nara räknar exakt avstånd", async () => {
		const s = await store.statistik(["typ"], { nara: { ...FALU_GRUVA, radie_m: 1000 } });
		expect(s.totalt).toBe(exhaustive(FALU_GRUVA, 1000).length);
	});
});
