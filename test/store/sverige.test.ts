/**
 * Prestanda och namnuppslag mot en lokal laddning av HELA landet
 * (ingest/.cache/sverige.sqlite, cirka 1,7 GB, inte i git). Hoppar över sig
 * självt om filen saknas eller migreringarna 0002–0003 inte är körda.
 *
 *   node ingest/cli.ts lokal <lamningar_sverige.gpkg> --db ingest/.cache/sverige.sqlite --ny
 *
 * Gränserna är generösa (lokal SQLite är snabbare än D1, men datorer skiljer
 * sig); scripts/matning.ts ger tiderna i detalj.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainService } from "../../src/lookup/domains";
import { IndexDomainSource } from "../../src/lookup/index_domaner";
import { IndexStore } from "../../src/store/index";
import { sokIndex } from "../../src/tools/hitta_plats";
import { d1FromSqlite } from "./d1-adapter";

const PATH = resolve(__dirname, "../../ingest/.cache/sverige.sqlite");
function redo(): boolean {
	if (!existsSync(PATH)) return false;
	const db = new DatabaseSync(PATH, { readOnly: true });
	try {
		return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'omrade_sammanfattning'").get() && (db.prepare("SELECT count(*) AS c FROM lamning").get() as { c: number }).c > 500_000;
	} finally {
		db.close();
	}
}
const HAS = redo();
if (!HAS) console.warn(`Hoppar över hela landet: ${PATH} saknas eller saknar migrering 0003.`);

const GRANS_MS = 400;

async function tid<T>(fn: () => Promise<T>): Promise<{ ms: number; r: T }> {
	await fn();
	const t = performance.now();
	const r = await fn();
	return { ms: performance.now() - t, r };
}

describe.skipIf(!HAS)("hela landet (lokal SQLite)", () => {
	let raw: DatabaseSync;
	let db: ReturnType<typeof d1FromSqlite>;
	let store: IndexStore;
	beforeAll(() => {
		raw = new DatabaseSync(PATH, { readOnly: true });
		db = d1FromSqlite(raw);
		store = new IndexStore(db);
	});
	afterAll(() => raw?.close());

	it("hitta_plats under 300 ms (mål), socknar och kommuner med rätt kommun och län", async () => {
		for (const [namn, typ, kommun, lan] of [
			["Bjursås", "socken", "Falun", "Dalarna"],
			["Stora Kopparberg", "socken", "Falun", "Dalarna"],
			["Uppsala", "kommun", "Uppsala", "Uppsala"],
		] as const) {
			const { ms, r } = await tid(() => sokIndex(db, namn, null, null));
			expect(ms, namn).toBeLessThan(300);
			expect(r.find((k) => k.typ === typ)).toMatchObject({ namn, kommun, lan });
		}
		const { ms } = await tid(() => sokIndex(db, "Sten", null, null));
		expect(ms).toBeLessThan(300);
	});

	it("elaka indata håller sig inom gränsen", async () => {
		const fall: Array<[string, () => Promise<unknown>]> = [
			["och", () => store.searchIndex({ ord: ["och"] })],
			["och + län", () => store.searchIndex({ ord: ["och"], lan: ["Uppsala"] })],
			["hög + socken", () => store.searchIndex({ ord: ["hög"], socken: [{ namn: "Bjursås" }] })],
			["sten sida 200", () => store.searchIndex({ ord: ["sten"] }, { antal: 50, sida: 200 })],
			["bedömning sida 200", () => store.searchIndex({ antikvarisk_bedomning: ["Fornlämning"] }, { antal: 50, sida: 200 })],
			["och nära Visby 20 km", () => store.searchIndex({ ord: ["och"], nara: { lat: 57.64, lon: 18.29, radie_m: 20_000 } })],
			["statistik socken", () => store.statistik(["socken"])],
			["statistik socken + sten", () => store.statistik(["socken"], { ord: ["sten"] })],
			["statistik kommun nära Stockholm", () => store.statistik(["kommun"], { nara: { lat: 59.33, lon: 18.07, radie_m: 20_000 } })],
		];
		for (const [namn, f] of fall) {
			const { ms } = await tid(f);
			expect(ms, namn).toBeLessThan(GRANS_MS);
		}
	});

	it("vanliga ord: inte rangordnade men sagt; två nivåer över hela landet: tydligt fel", async () => {
		const r = await store.searchIndex({ ord: ["och"] });
		expect(r.rangordnad).toBe(false);
		expect(r.totalt).toBeGreaterThan(150_000);
		await expect(store.statistik(["kommun", "socken"])).rejects.toThrow(/Avgränsa med län/);
	});

	it("namnuppslag ur indexet: socknar, kommuner och typer för hela landet", async () => {
		const svc = new DomainService(new IndexDomainSource(db));
		const d = await svc.get();
		expect(d.socknar.length).toBeGreaterThan(2400);
		expect(d.kommuner).toHaveLength(290);
		expect((await svc.resolveKommuner(["Gotland", "kiruna"])).map((k) => k.namn)).toEqual(["Gotland", "Kiruna"]);
		await expect(svc.resolveSocknar(["Näs"])).rejects.toThrow(/flertydig/);
		expect((await svc.resolveSocknar(["Näs (Jämtland)"]))[0]).toMatchObject({ namn: "Näs", lan: ["Jämtland"] });
		await expect(svc.resolveSocknar(["Bjursaas"])).rejects.toThrow(/Menade du: "Bjursås"/);
	});
});
