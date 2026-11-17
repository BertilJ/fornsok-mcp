/**
 * Inläsning av Falu kommun (SPEC 10: 3 908 lämningar ska ge 3 908 rader),
 * SQL-filerna mot den direkta laddningen, idempotens och avstämning.
 */
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AvstamningError, diff, hashesFromSqlite, hashesFromWranglerJson, hashQueries, load } from "../../ingest/load.ts";
import { DbSink, FileSink, MIGRATION } from "../../ingest/sink.ts";
import { MAX_STATEMENT_BYTES, type SqlSink } from "../../ingest/sql.ts";
import { FALUN_GPKG, HAS_FALUN, type LoadedFalun, loadFalun, SKIP_MESSAGE } from "../store/falun-fixture";

type Row = Record<string, unknown>;

/** Dela en SQL-fil i satser (bara för kontroll av satsstorlek; strängar kan innehålla ;). */
function statements(sql: string): string[] {
	const out: string[] = [];
	let cur = "";
	let inStr = false;
	for (const line of sql.split("\n")) {
		if (!inStr && line.startsWith("--")) continue;
		cur += `${line}\n`;
		for (const ch of line) if (ch === "'") inStr = !inStr;
		if (!inStr && line.endsWith(";")) {
			out.push(cur);
			cur = "";
		}
	}
	return out;
}

const tableCounts = (db: DatabaseSync) =>
	Object.fromEntries(
		["lamning", "omrade", "lamning_omrade", "egenskap", "ingaende", "lamningstyp_kategori"].map((t) => [
			t,
			Number((db.prepare(`SELECT count(*) AS c FROM ${t}`).get() as Row).c),
		]),
	);

describe.skipIf(!HAS_FALUN)(`Falu kommun ${HAS_FALUN ? "" : `(${SKIP_MESSAGE})`}`, () => {
	let f: LoadedFalun;
	let db: DatabaseSync;
	let sqlDir: string;
	let files: string[];

	beforeAll(() => {
		f = loadFalun();
		db = f.open();
		sqlDir = join(f.dir, "sql");
		const sink = new FileSink(sqlDir, 2 * 1024 * 1024);
		load(FALUN_GPKG, sink);
		files = readdirSync(sqlDir)
			.filter((x) => x.endsWith(".sql"))
			.sort();
	});
	afterAll(() => {
		db?.close();
		f?.cleanup();
	});

	it("3 908 lämningar ger 3 908 rader", () => {
		expect(f.result.stats.lamningar).toBe(3908);
		expect(tableCounts(db).lamning).toBe(3908);
		expect(f.result.stats.geometrier).toBe(4604);
		expect(f.result.stats.foraldralosa).toBe(0);
		expect([...f.result.stats.varningar.keys()]).toEqual([]);
		expect(f.result.utanLandskap).toBe(0);
		expect(tableCounts(db).egenskap).toBe(3135);
		expect(tableCounts(db).ingaende).toBe(1387);
	});

	it("L2000:8802 Stora Kopparberg 172:1, hyttområde", () => {
		const r = db.prepare("SELECT * FROM lamning WHERE lamningsnummer = 'L2000:8802'").get() as Row;
		expect(r).toMatchObject({
			uuid: "6d1cf7b6-f5bd-4066-aba6-fb1ea3ce8c75",
			raa_nummer: "Stora Kopparberg 172:1",
			lamningstyp: "Hyttområde",
			bedomning: "Fornlämning",
			undersokning: "Delundersökt",
			skada: "Åverkan",
			geometrityp: "GeometryCollection",
		});
		expect(String(r.beskrivning)).toMatch(/^Hyttområde, delundersökt/);
		// Mittpunkten är ytans tyngdpunkt; Fornsök-appens centrum (530298.9, 6725275.9) ligger 26 m bort.
		expect(Math.hypot(Number(r.e) - 530298.886, Number(r.n) - 6725275.866)).toBeLessThan(50);
		// K-samsöks punkt för posten (första geometrin) finns i geometrin.
		const g = JSON.parse(String(r.geometri));
		const pts = g.geometries.filter((x: { type: string }) => x.type === "Point").map((x: { coordinates: number[] }) => x.coordinates);
		expect(pts.some(([lon, lat]: number[]) => Math.abs(lon - 15.554018818384327) < 1e-6 && Math.abs(lat - 60.66159242831314) < 1e-6)).toBe(
			true,
		);
		const kommun = db
			.prepare(
				"SELECT o.niva, o.namn FROM lamning_omrade lo JOIN omrade o ON o.id = lo.omrade_id WHERE lo.lamning_id = ? ORDER BY o.niva",
			)
			.all(r.id as number) as Row[];
		expect(kommun.map((x) => `${x.niva}:${x.namn}`)).toEqual(["kommun:Falun", "lan:Dalarna", "landskap:Dalarna", "socken:Stora Kopparberg"]);
	});

	it("L2001:646 Bjursås 27:1, källa med tradition, koordinat som K-samsök", () => {
		const r = db.prepare("SELECT * FROM lamning WHERE lamningsnummer = 'L2001:646'").get() as Row;
		expect(r).toMatchObject({
			uuid: "adc490ba-871a-45bd-8e3d-0a27761b3b6c",
			raa_nummer: "Bjursås 27:1",
			raa_sok: "bjursås 27:1",
			lamningstyp: "Källa med tradition",
			bedomning: "Övrig kulturhistorisk lämning",
			tradition: "Fru Lax Greta Holm har använt källan som önskekälla.",
			terrang: "Måttlig NÖ-sluttning. Moränmark. Skogsmark (blandskog).",
			geometrityp: "Point",
		});
		// K-samsök: lat 60.73368161435678, lon 15.456428761252013 – inom en meter.
		const dLat = (Number(r.lat) - 60.73368161435678) * 111_320;
		const dLon = (Number(r.lon) - 15.456428761252013) * 111_320 * Math.cos((60.7337 * Math.PI) / 180);
		expect(Math.hypot(dLat, dLon)).toBeLessThan(1);
		const eg = db.prepare("SELECT typ, varde FROM egenskap WHERE lamning_id = ?").all(r.id as number);
		expect(eg).toEqual([expect.objectContaining({ typ: "Typ", varde: "Midsommar/trefaldighet" })]);
	});

	it("flerledade socknar delas upp (66 lämningar i flera socknar)", () => {
		const n = db
			.prepare(
				"SELECT count(*) AS c FROM (SELECT lo.lamning_id FROM lamning_omrade lo JOIN omrade o ON o.id = lo.omrade_id WHERE o.niva = 'socken' GROUP BY lo.lamning_id HAVING count(*) > 1)",
			)
			.get() as Row;
		expect(n.c).toBe(66);
	});

	it("FTS-index är konsistent med tabellen", () => {
		expect(() => db.exec("INSERT INTO lamning_fts(lamning_fts, rank) VALUES('integrity-check', 1)")).not.toThrow();
	});

	it("SQL-filerna ryms i D1:s gränser och saknar transaktioner", () => {
		expect(files[0]).toBe("0000_huvud.sql");
		expect(files[files.length - 1]).toMatch(/_synk\.sql$/);
		for (const name of files) {
			const text = readFileSync(join(sqlDir, name), "utf8");
			expect(text).not.toMatch(/^\s*(BEGIN|COMMIT)\b/im);
			for (const s of statements(text)) expect(Buffer.byteLength(s)).toBeLessThanOrEqual(MAX_STATEMENT_BYTES + 1); // + radslut
			expect(statSync(join(sqlDir, name)).size).toBeLessThan(5 * 1024 ** 3);
		}
	});

	it("SQL-filerna ger samma databas som den direkta laddningen, även när de körs två gånger", () => {
		const fromFiles = new DatabaseSync(":memory:");
		fromFiles.exec("PRAGMA foreign_keys = ON");
		fromFiles.exec(readFileSync(MIGRATION, "utf8"));
		for (const name of files) fromFiles.exec(readFileSync(join(sqlDir, name), "utf8"));
		const once = tableCounts(fromFiles);
		for (const name of files) fromFiles.exec(readFileSync(join(sqlDir, name), "utf8"));
		expect(tableCounts(fromFiles)).toEqual(once);
		expect(once).toEqual(tableCounts(db));
		const h = (d: DatabaseSync) => (d.prepare("SELECT group_concat(hash, '') AS h FROM (SELECT hash FROM lamning ORDER BY uuid)").get() as Row).h;
		expect(h(fromFiles)).toBe(h(db));
		expect(() => fromFiles.exec("INSERT INTO lamning_fts(lamning_fts, rank) VALUES('integrity-check', 1)")).not.toThrow();
		fromFiles.close();
	});

	it("avstämning: oförändrat ger inga avvikelser; ändrad, ny och borttagen upptäcks och rättas", () => {
		const same = diff(FALUN_GPKG, hashesFromSqlite(f.path), { referens: undefined });
		expect({ nya: same.nya.length, andrade: same.andrade.length, borttagna: same.borttagna.length, oforandrade: same.oforandrade }).toEqual({
			nya: 0,
			andrade: 0,
			borttagna: 0,
			oforandrade: 3908,
		});

		// Ändra en hash, ta bort en rad, lägg till en okänd lämning.
		const work = new DatabaseSync(":memory:");
		work.exec("PRAGMA foreign_keys = ON");
		work.exec(readFileSync(MIGRATION, "utf8"));
		for (const name of files) work.exec(readFileSync(join(sqlDir, name), "utf8"));
		work.exec("UPDATE lamning SET hash = 'x', beskrivning = 'fel' WHERE lamningsnummer = 'L2001:646'");
		work.exec("DELETE FROM lamning WHERE lamningsnummer = 'L2000:8802'");
		work.exec(
			"INSERT INTO lamning (uuid, lamningsnummer, hash) VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'L1900:1', 'y')",
		);
		const hashes = new Map(
			(work.prepare("SELECT uuid, hash FROM lamning").all() as Row[]).map((r) => [String(r.uuid), String(r.hash)]),
		);
		const fixDir = join(f.dir, "fix");
		const d = diff(FALUN_GPKG, hashes, { sink: new FileSink(fixDir, 20 * 1024 * 1024) });
		expect(d.andrade).toEqual(["adc490ba-871a-45bd-8e3d-0a27761b3b6c"]);
		expect(d.nya).toEqual(["6d1cf7b6-f5bd-4066-aba6-fb1ea3ce8c75"]);
		expect(d.borttagna).toEqual(["ffffffff-ffff-4fff-8fff-ffffffffffff"]);
		for (const name of readdirSync(fixDir).filter((x) => x.endsWith(".sql")).sort())
			work.exec(readFileSync(join(fixDir, name), "utf8"));
		expect(tableCounts(work)).toEqual(tableCounts(db));
		const after = diff(FALUN_GPKG, new Map((work.prepare("SELECT uuid, hash FROM lamning").all() as Row[]).map((r) => [String(r.uuid), String(r.hash)])));
		expect(after.nya.length + after.andrade.length + after.borttagna.length).toBe(0);
		expect((work.prepare("SELECT typ, nya, andrade, borttagna FROM synk ORDER BY id DESC LIMIT 1").get() as Row)).toMatchObject({
			typ: "avstamning",
			nya: 1,
			andrade: 1,
			borttagna: 1,
		});
		work.close();
	});

	it("hashfrågorna täcker alla uuid och tolkas från wrangler-JSON", () => {
		const qs = hashQueries("fornsok");
		expect(qs).toHaveLength(16);
		const all = db.prepare("SELECT uuid, hash FROM lamning").all() as Row[];
		// Simulera wrangler --json per fråga.
		const conds = qs.map((q) => /WHERE (.*)"/.exec(q)?.[1] as string);
		let total = 0;
		const jsonFiles: string[] = [];
		conds.forEach((c, i) => {
			const rows = db.prepare(`SELECT uuid, hash FROM lamning WHERE ${c}`).all();
			total += rows.length;
			const p = join(f.dir, `hash_${i}.json`);
			writeFileSync(p, JSON.stringify([{ results: rows, success: true, meta: {} }]));
			jsonFiles.push(p);
		});
		expect(total).toBe(all.length);
		expect(hashesFromWranglerJson(jsonFiles).size).toBe(3908);
	});
});

// ---------------------------------------------------------------- avstämning mot källan (granskningen, punkt 8)

describe.skipIf(!HAS_FALUN)("avstämning mot källan vid inläsning", () => {
	/** En ändrad kopia av Falu-filen (gpkg-triggrarna tas bort i kopian; de kräver SpatiaLite-funktioner). */
	function variant(edit: (db: DatabaseSync) => void): { path: string; cleanup: () => void } {
		const dir = mkdtempSync(join(tmpdir(), "fornsok-variant-"));
		const path = join(dir, "variant.gpkg");
		copyFileSync(FALUN_GPKG, path);
		const db = new DatabaseSync(path);
		for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Row[]) db.exec(`DROP TRIGGER "${String(t.name)}"`);
		edit(db);
		db.close();
		return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
	}

	it("en lämning med ogiltigt uuid avbryter laddningen före synkraden", () => {
		const v = variant((db) => db.exec("UPDATE lamning SET uuid = 'inte-ett-uuid' WHERE lamningsnummer = 'L2001:646'"));
		try {
			const sink = new MemorySink();
			let err: unknown;
			try {
				load(v.path, sink);
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(AvstamningError);
			expect(() => load(v.path, new MemorySink())).toThrow(/lämningar: källan har 3908, skrivna 3907/);
			expect(sink.statements.some((s) => s.includes("INSERT INTO synk_status"))).toBe(false);
		} finally {
			v.cleanup();
		}
	});

	it("uuid med versaler läses (med barnrader) och skrivs med gemener", () => {
		const v = variant((db) => {
			const u = "adc490ba-871a-45bd-8e3d-0a27761b3b6c";
			db.exec(`UPDATE lamning SET uuid = upper(uuid) WHERE uuid = '${u}'`);
			for (const t of ["point", "linestring", "polygon", "egenskap", "ingaendelamning", "lämningar_kommun_falun_lägesosäkerhet"])
				db.exec(`UPDATE "${t}" SET lamning_uuid = upper(lamning_uuid) WHERE lamning_uuid = '${u}'`);
		});
		const dir = mkdtempSync(join(tmpdir(), "fornsok-upper-"));
		try {
			const r = load(v.path, new DbSink(join(dir, "x.sqlite"), { recreate: true }));
			expect(r.stats.lamningar).toBe(3908);
			const db = new DatabaseSync(join(dir, "x.sqlite"));
			const row = db.prepare("SELECT uuid, osakerhet_m, geometrityp FROM lamning WHERE lamningsnummer = 'L2001:646'").get() as Row;
			expect(row).toMatchObject({ uuid: "adc490ba-871a-45bd-8e3d-0a27761b3b6c", osakerhet_m: 15, geometrityp: "Point" });
			expect((db.prepare("SELECT count(*) AS c FROM egenskap e JOIN lamning l ON l.id = e.lamning_id WHERE l.lamningsnummer = 'L2001:646'").get() as Row).c).toBe(1);
			db.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
			v.cleanup();
		}
	});
});

class MemorySink implements SqlSink {
	statements: string[] = [];
	private seen = new Set<string>();
	emit(s: string) {
		this.statements.push(s);
	}
	beginBatch() {
		this.seen.clear();
	}
	omradeSeen(key: string) {
		const had = this.seen.has(key);
		this.seen.add(key);
		return had;
	}
	close() {}
}
