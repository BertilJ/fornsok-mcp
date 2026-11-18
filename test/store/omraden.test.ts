/**
 * Förberäknade områden (migrations/0003_omraden.sql, src/store/omraden.ts),
 * hitta_plats ur dem och namnuppslaget ur indexet (src/lookup/index_domaner.ts),
 * mot Falu kommun. Hoppar över sig självt om ingest/.cache/falun.gpkg saknas.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DomainService } from "../../src/lookup/domains";
import { FallbackDomainSource, IndexDomainSource, KOPIA_NYCKEL, sparaKopiaSats } from "../../src/lookup/index_domaner";
import type { Domaner } from "../../src/sources/types";
import { fullRecomputeSql, markeraOmradenSats, refreshInaktuella } from "../../src/store/omraden";
import { createHittaPlatsDeps, hittaPlats, PlatsIndexError, sokIndex } from "../../src/tools/hitta_plats";
import { d1FromSqlite } from "./d1-adapter";
import { HAS_FALUN, type LoadedFalun, loadFalun, MIGRATIONS_DIR, SKIP_MESSAGE } from "./falun-fixture";

const MIGRATION_0003 = readFileSync(join(MIGRATIONS_DIR, "0003_omraden.sql"), "utf8");

describe("migrering 0003 och fullRecomputeSql", () => {
	it("migreringens omräkning är exakt satserna ur fullRecomputeSql({ baraSaknade: true })", () => {
		const body = MIGRATION_0003.slice(MIGRATION_0003.indexOf("-- Omräkning (genererad"));
		for (const s of fullRecomputeSql({ baraSaknade: true })) expect(body).toContain(s);
		const antal = (body.match(/^INSERT INTO /gm) ?? []).length;
		expect(antal).toBe(fullRecomputeSql({ baraSaknade: true }).length);
	});

	it("varje sats läser en fjärdedel av en nivå (D1:s tidsgräns), och ändrar inte 0001/0002", () => {
		for (const s of fullRecomputeSql()) expect(s).toMatch(/o\.niva = '(socken|kommun|lan|landskap)' AND o\.id % 4 = [0-3]|niva_sammanfattning/);
		expect(MIGRATION_0003).not.toMatch(/ALTER TABLE|DROP |DELETE FROM lamning\b|CREATE TABLE (?!IF NOT EXISTS)/);
	});
});

describe.skipIf(!HAS_FALUN)("områden mot Falu kommun", () => {
	let f: LoadedFalun;
	let raw: DatabaseSync;
	const queries: Array<{ sql: string; params: unknown[] }> = [];
	let db: ReturnType<typeof d1FromSqlite>;

	beforeAll(() => {
		if (!HAS_FALUN) console.warn(SKIP_MESSAGE);
		f = loadFalun();
		raw = f.open();
		db = d1FromSqlite(raw, (sql, params) => queries.push({ sql, params }));
	});
	afterAll(() => {
		raw?.close();
		f?.cleanup();
	});

	it("sammanfattningen stämmer med en direkt beräkning", () => {
		const direkt = raw
			.prepare(
				"SELECT o.id, count(*) AS n, avg(l.lat) AS lat, min(l.lon) AS min_lon FROM omrade o JOIN lamning_omrade lo ON lo.omrade_id = o.id JOIN lamning l ON l.id = lo.lamning_id WHERE o.niva = 'socken' AND o.namn = 'Bjursås' GROUP BY o.id",
			)
			.get() as { id: number; n: number; lat: number; min_lon: number };
		const s = raw.prepare("SELECT * FROM omrade_sammanfattning WHERE omrade_id = ?").get(direkt.id) as Record<string, number>;
		expect(s.antal).toBe(direkt.n);
		expect(s.lat).toBeCloseTo(direkt.lat, 9);
		expect(s.min_lon).toBeCloseTo(direkt.min_lon, 9);
		const rel = raw
			.prepare("SELECT o2.niva, o2.namn, r.antal FROM omrade_relation r JOIN omrade o2 ON o2.id = r.overordnad_id WHERE r.omrade_id = ? ORDER BY r.antal DESC")
			.all(direkt.id) as Array<{ niva: string; namn: string; antal: number }>;
		expect(rel.find((r) => r.niva === "kommun")?.namn).toBe("Falun");
		expect(rel.find((r) => r.niva === "lan")?.namn).toBe("Dalarna");
		const niva = raw.prepare("SELECT med_omrade FROM niva_sammanfattning WHERE niva = 'socken'").get() as { med_omrade: number };
		expect(niva.med_omrade).toBe(3908);
	});

	it("migreringen är idempotent: en omkörning ändrar ingenting", () => {
		const fore = JSON.stringify([
			raw.prepare("SELECT * FROM omrade_sammanfattning ORDER BY omrade_id").all(),
			raw.prepare("SELECT * FROM omrade_relation ORDER BY omrade_id, overordnad_id").all(),
			raw.prepare("SELECT * FROM niva_sammanfattning ORDER BY niva").all(),
		]);
		raw.exec(MIGRATION_0003);
		raw.exec(MIGRATION_0003);
		const efter = JSON.stringify([
			raw.prepare("SELECT * FROM omrade_sammanfattning ORDER BY omrade_id").all(),
			raw.prepare("SELECT * FROM omrade_relation ORDER BY omrade_id, overordnad_id").all(),
			raw.prepare("SELECT * FROM niva_sammanfattning ORDER BY niva").all(),
		]);
		expect(efter).toBe(fore);
	});

	it("en avbruten migrering fortsätter: saknade områden fylls i, befintliga lämnas", () => {
		const fore = raw.prepare("SELECT count(*) AS c FROM omrade_sammanfattning").get() as { c: number };
		raw.exec("DELETE FROM omrade_sammanfattning WHERE omrade_id IN (SELECT id FROM omrade WHERE niva = 'socken')");
		raw.exec("DELETE FROM omrade_relation");
		raw.exec(MIGRATION_0003);
		expect((raw.prepare("SELECT count(*) AS c FROM omrade_sammanfattning").get() as { c: number }).c).toBe(fore.c);
		expect((raw.prepare("SELECT count(*) AS c FROM omrade_relation").get() as { c: number }).c).toBeGreaterThan(0);
	});

	it("nattsynkens markering och omräkning: en flyttad lämning ändrar båda områdena", async () => {
		const uuid = (raw.prepare("SELECT l.uuid FROM lamning l JOIN lamning_omrade lo ON lo.lamning_id = l.id JOIN omrade o ON o.id = lo.omrade_id WHERE o.niva = 'socken' AND o.namn = 'Bjursås' LIMIT 1").get() as { uuid: string }).uuid;
		const id = (sock: string) => (raw.prepare("SELECT id FROM omrade WHERE niva = 'socken' AND namn = ?").get(sock) as { id: number }).id;
		const antal = (sock: string) => (raw.prepare("SELECT antal FROM omrade_sammanfattning WHERE omrade_id = ?").get(id(sock)) as { antal: number }).antal;
		const bj = antal("Bjursås");
		const sv = antal("Svärdsjö");
		// Som skrivSatser: markera, flytta, markera.
		await db.batch([markeraOmradenSats(db, uuid)]);
		raw.prepare("UPDATE lamning_omrade SET omrade_id = ? WHERE omrade_id = ? AND lamning_id = (SELECT id FROM lamning WHERE uuid = ?)").run(id("Svärdsjö"), id("Bjursås"), uuid);
		await db.batch([markeraOmradenSats(db, uuid)]);
		expect((raw.prepare("SELECT count(*) AS c FROM omrade_sammanfattning WHERE inaktuell = 1").get() as { c: number }).c).toBeGreaterThanOrEqual(2);
		const r = await refreshInaktuella(db);
		expect(r.omraknade).toBeGreaterThanOrEqual(2);
		expect(r.kvar).toBe(0);
		expect(antal("Bjursås")).toBe(bj - 1);
		expect(antal("Svärdsjö")).toBe(sv + 1);
		expect((raw.prepare("SELECT count(*) AS c FROM omrade_sammanfattning WHERE inaktuell = 1").get() as { c: number }).c).toBe(0);
		// Tillbaka.
		raw.prepare("UPDATE lamning_omrade SET omrade_id = ? WHERE omrade_id = ? AND lamning_id = (SELECT id FROM lamning WHERE uuid = ?)").run(id("Bjursås"), id("Svärdsjö"), uuid);
		await db.batch([markeraOmradenSats(db, uuid)]);
		await refreshInaktuella(db);
		expect(antal("Bjursås")).toBe(bj);
	});

	it("hitta_plats: socken, kommun och namngiven lämning, utan att lamning läses i sin helhet", async () => {
		queries.length = 0;
		const k = await sokIndex(db, "Bjursås", null, null);
		expect(k[0]).toMatchObject({ namn: "Bjursås", typ: "socken", kommun: "Falun", lan: "Dalarna" });
		expect(k[0].antal_lamningar).toBeGreaterThan(100);
		expect(k[0].utbredning).toHaveLength(4);
		const kom = await sokIndex(db, "falun", null, "Dalarna");
		expect(kom[0]).toMatchObject({ namn: "Falun", typ: "kommun", lan: "Dalarna" });
		expect(kom[0].antal_lamningar).toBe(3908);
		for (const q of queries) {
			const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...(q.params as SQLInputValue[])) as Array<{ detail: string }>).map((x) => x.detail);
			for (const p of plan) expect(p).not.toMatch(/^SCAN (l|lamning|lo|lamning_omrade)\b/);
		}
		// Namngiven lämning via FTS (kolumnfiltret namn), exakt namn först.
		const namn = (raw.prepare("SELECT namn FROM lamning WHERE namn IS NOT NULL AND lat IS NOT NULL AND namn NOT LIKE '% %' LIMIT 1").get() as { namn: string }).namn;
		queries.length = 0;
		const l = await sokIndex(db, namn.toLocaleUpperCase("sv"), null, null);
		const lam = l.find((x) => x.lamningsnummer);
		expect(lam?.namn).toBe(namn);
		expect(lam?.beskrivning).toMatch(/med namnet/);
		const fq = queries.find((q) => q.sql.includes("lamning_fts"));
		expect(fq?.sql).toContain("FROM lamning_fts f CROSS JOIN lamning l");
		expect(String(fq?.params[1])).toMatch(/^namn : \(/);
		// Avgränsning till ett annat län: inga lämningskandidater.
		expect((await sokIndex(db, namn, null, "Skåne")).filter((x) => x.lamningsnummer)).toHaveLength(0);
	});

	it("hitta_plats: fel i indexet loggas med steg och tid (console.error), och Nominatim tar över", async () => {
		const broken = d1FromSqlite(raw);
		const failing = {
			prepare: (sql: string) => (sql.includes("omrade_sammanfattning") ? broken.prepare(sql.replace("omrade_sammanfattning", "omrade_sammanfattning_saknas")) : broken.prepare(sql)),
			batch: broken.batch,
		};
		await expect(sokIndex(failing, "Bjursås", null, null)).rejects.toMatchObject({ name: "PlatsIndexError", steg: "socknar och kommuner" });
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const deps = createHittaPlatsDeps({ db: failing, nominatim: "av" });
			const r = await hittaPlats({ namn: "Bjursås" }, deps);
			expect((r.structuredContent as { anmarkningar: string[] }).anmarkningar.join(" ")).toMatch(/Indexet svarade inte/);
			expect(err).toHaveBeenCalled();
			const logged = String(err.mock.calls[0][0]);
			expect(logged).toMatch(/"steg":"socknar och kommuner"/);
			expect(logged).toMatch(/"ms":\d+/);
		} finally {
			err.mockRestore();
		}
		const e = new PlatsIndexError("x", "steg", 3);
		expect(e).toBeInstanceOf(Error);
	});

	it("hitta_plats: saknad migrering ger ett begripligt fel", async () => {
		const failing = {
			prepare: (sql: string) => db.prepare(sql.replace(/omrade_sammanfattning/g, "omrade_sammanfattning_x")),
			batch: db.batch,
		};
		await expect(sokIndex(failing, "Bjursås", null, null)).rejects.toThrow(/no such table/);
		const fake = { prepare: () => ({ bind: () => fake.prepare(), all: async () => { throw new Error("no such table: omrade_sammanfattning"); } }), batch: async () => [] };
		await expect(sokIndex(fake as never, "Bjursås", null, null)).rejects.toThrow(/0003_omraden\.sql är inte körd/);
	});

	it("sok_lamningar: fler än 16 ord ger en anmärkning; vanliga ord rangordnas inte men sägs", async () => {
		const { connectMcp, standardRoutes } = await import("../helpers");
		const c = await connectMcp(standardRoutes(), { db });
		try {
			const ord = Array.from({ length: 18 }, (_, i) => `ord${i}`).join(" ");
			const r = (await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: ord, kommun: ["Falun"] } })).structuredContent as { anmarkningar: string[] };
			expect(r.anmarkningar.join(" ")).toMatch(/fraga hade 18 ord; bara de 16 första användes/);
			// Första namnuppslaget utan kopia hämtade appens listor och sparade dem i D1.
			expect(raw.prepare("SELECT count(*) AS c FROM vardelista_kopia WHERE nyckel = ?").get(KOPIA_NYCKEL)).toEqual({ c: 1 });
		} finally {
			await c.client.close();
			raw.prepare("DELETE FROM vardelista_kopia WHERE nyckel = ?").run(KOPIA_NYCKEL);
		}
	});

	// ------------------------------------------------------------ namnuppslag

	it("namnuppslag ur indexet: kommun, socken, landskap, typ och kategori utan Fornsök-appen", async () => {
		const appSource = { loadDomaner: vi.fn(async (): Promise<Domaner> => { throw new Error("appen är nere"); }) };
		const svc = new DomainService(new FallbackDomainSource(new IndexDomainSource(db), appSource));
		expect((await svc.resolveKommuner(["falun"]))[0]).toMatchObject({ namn: "Falun", kod: "2080", lan_namn: "Dalarna" });
		expect((await svc.resolveSocknar(["bjursås socken"]))[0].namn).toBe("Bjursås");
		expect(await svc.resolveLandskap(["dalarna"])).toEqual(["Dalarna"]);
		expect(await svc.resolveLamningstyper(["hyttområde"])).toEqual(["Hyttområde"]);
		expect(await svc.resolveKategorier(["gravar"])).toEqual(["Gravar"]);
		expect(appSource.loadDomaner).not.toHaveBeenCalled();
		// Felstavning: förslag ur indexets namn.
		await expect(svc.resolveSocknar(["Bjursaas"])).rejects.toThrow(/Menade du: "Bjursås"/);
		// Kvalificerare som motsäger socknen.
		await expect(svc.resolveSocknar(["Bjursås (Skåne)"])).rejects.toThrow(/finns bara i Bjursås \(Dalarna/);
		expect((await svc.resolveSocknar(["Bjursås (Dalarna)"]))[0].namn).toBe("Bjursås");
		expect((await svc.get()).kalla).toBe("index");
	});

	it("tomt index eller fel i indexet: appens listor som reserv (loggat)", async () => {
		const app = { loadDomaner: vi.fn(async (): Promise<Domaner> => appDomaner()) };
		const broken = { prepare: db.prepare, batch: async () => { throw new Error("D1_ERROR: nere"); } };
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const d = await new FallbackDomainSource(new IndexDomainSource(broken as never), app).loadDomaner();
			expect(d.kalla).toBeUndefined();
			expect(app.loadDomaner).toHaveBeenCalledOnce();
			expect(err).toHaveBeenCalled();
		} finally {
			err.mockRestore();
		}
	});

	it("namn som saknas i indexet prövas mot reservlistan; flertydighet går inte vidare", async () => {
		const svc = new DomainService(new IndexDomainSource(db));
		await expect(svc.resolveKommuner(["Kiruna"])).rejects.toThrow(/Okänd kommun "Kiruna"/);
		svc.reserv = new DomainService({ loadDomaner: async () => appDomaner() });
		expect((await svc.resolveKommuner(["Kiruna"]))[0].namn).toBe("Kiruna");
		// Reserven nere: det ursprungliga felet (med förslag) gäller.
		svc.reserv = new DomainService({ loadDomaner: async () => { throw new Error("nere"); } }, 1000, Date.now, 0);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(svc.resolveKommuner(["Kirunaa"])).rejects.toThrow(/Okänd kommun "Kirunaa"/);
		} finally {
			warn.mockRestore();
		}
	});

	it("sparad kopia av appens listor i D1: samma beteende som appen, kompletterad med indexets namn", async () => {
		const app = appDomaner();
		await db.batch([sparaKopiaSats(db, app)]);
		try {
			const d = await new IndexDomainSource(db).loadDomaner();
			expect(d.kalla).toBe("index");
			// Appens två Råda i Västra Götaland finns kvar (indexet slår ihop dem).
			expect(d.socknar.filter((s) => s.namn === "Råda")).toHaveLength(2);
			const svc = new DomainService({ loadDomaner: async () => d });
			await expect(svc.resolveSocknar(["Råda"])).rejects.toThrow(/flertydig/);
			// Namn som bara finns i indexet läggs till.
			expect(d.kommuner.some((k) => k.namn === "Falun")).toBe(true);
		} finally {
			raw.prepare("DELETE FROM vardelista_kopia WHERE nyckel = ?").run(KOPIA_NYCKEL);
		}
	});
});

/** Appens värdelistor i den form DomainService använder (ur ingest/data/referens.json). */
function appDomaner(): Domaner {
	const ref = JSON.parse(readFileSync(join(__dirname, "../../ingest/data/referens.json"), "utf8")) as {
		lamningstyper: Array<{ namn: string; kategorier: string[] }>;
		kommuner: Domaner["kommuner"];
		socknar: Domaner["socknar"];
		landskap: Array<{ kod: string; namn: string }>;
		lan: Domaner["lan"];
	};
	return {
		lamningstyper: ref.lamningstyper.map((t, i) => ({ id: i + 1, namn: t.namn, aktiv: true, kategorier: t.kategorier })),
		kategorier: [...new Set(ref.lamningstyper.flatMap((t) => t.kategorier))],
		bedomningar: [],
		kommuner: ref.kommuner,
		socknar: ref.socknar,
		landskap: ref.landskap.map((l) => ({ kod: l.kod, namn: l.namn })),
		lan: ref.lan,
		hamtad: "2026-11-17",
	};
}
