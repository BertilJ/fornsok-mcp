import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { GpkgError, parseGpkgGeometry } from "../../ingest/gpkg.ts";
import { MIGRATION } from "../../ingest/sink.ts";
import { avstamning, newStats } from "../../ingest/read.ts";
import { batchStatements, kategoriStatements, lit, MAX_STATEMENT_BYTES, multiRow, type SqlSink, synkStatements } from "../../ingest/sql.ts";
import {
	centroid,
	combine,
	contentHash,
	Indelning,
	type KallPost,
	raaSok,
	rumsklass,
	splitList,
	text,
	toIndexPost,
} from "../../ingest/transform.ts";

// ---------------------------------------------------------------- WKB-byggare

function wkbPoint(x: number, y: number, le = true): number[] {
	const b = Buffer.alloc(21);
	b.writeUInt8(le ? 1 : 0, 0);
	if (le) {
		b.writeUInt32LE(1, 1);
		b.writeDoubleLE(x, 5);
		b.writeDoubleLE(y, 13);
	} else {
		b.writeUInt32BE(1, 1);
		b.writeDoubleBE(x, 5);
		b.writeDoubleBE(y, 13);
	}
	return [...b];
}

function wkbPolygon(rings: number[][][]): number[] {
	const parts: number[] = [1];
	const u32 = (n: number) => {
		const b = Buffer.alloc(4);
		b.writeUInt32LE(n);
		parts.push(...b);
	};
	const f64 = (n: number) => {
		const b = Buffer.alloc(8);
		b.writeDoubleLE(n);
		parts.push(...b);
	};
	u32(3);
	u32(rings.length);
	for (const r of rings) {
		u32(r.length);
		for (const [x, y] of r) {
			f64(x);
			f64(y);
		}
	}
	return parts;
}

function gpkg(wkb: number[], opts: { srs?: number; envelope?: number; empty?: boolean } = {}): Uint8Array {
	const env = opts.envelope ?? 0;
	const envBytes = [0, 32, 48, 48, 64][env];
	const head = Buffer.alloc(8 + envBytes);
	head.write("GP", 0, "ascii");
	head.writeUInt8(0, 2);
	head.writeUInt8(1 | (env << 1) | (opts.empty ? 0x10 : 0), 3);
	head.writeInt32LE(opts.srs ?? 3006, 4);
	return new Uint8Array([...head, ...wkb]);
}

describe("GeoPackage-geometri", () => {
	it("punkt utan och med envelope, båda byteordningarna", () => {
		expect(parseGpkgGeometry(gpkg(wkbPoint(524892.601, 6733210.685)))).toEqual({
			srsId: 3006,
			geometry: { type: "Point", coordinates: [524892.601, 6733210.685] },
		});
		expect(parseGpkgGeometry(gpkg(wkbPoint(1, 2, false), { envelope: 1 })).geometry).toEqual({ type: "Point", coordinates: [1, 2] });
	});

	it("polygon med hål", () => {
		const outer = [
			[0, 0],
			[10, 0],
			[10, 10],
			[0, 10],
			[0, 0],
		];
		const hole = [
			[2, 2],
			[4, 2],
			[4, 4],
			[2, 2],
		];
		const g = parseGpkgGeometry(gpkg(wkbPolygon([outer, hole]), { envelope: 1 })).geometry;
		expect(g).toEqual({ type: "Polygon", coordinates: [outer, hole] });
	});

	it("tom geometri och NaN-punkt ger null", () => {
		expect(parseGpkgGeometry(gpkg(wkbPoint(0, 0), { empty: true })).geometry).toBeNull();
		expect(parseGpkgGeometry(gpkg(wkbPoint(Number.NaN, Number.NaN))).geometry).toBeNull();
	});

	it("avvisar trasiga och fientliga blobbar utan att krascha", () => {
		const bad: Uint8Array[] = [
			new Uint8Array([]),
			new Uint8Array([0x47, 0x50]),
			new Uint8Array([0x58, 0x58, 0, 1, 0, 0, 0, 0, 1]),
			gpkg(wkbPoint(1, 2)).slice(0, 20), // avkortad
			gpkg([1, 99, 0, 0, 0]), // okänd typ
			gpkg([1, 2, 0, 0, 0, 0xff, 0xff, 0xff, 0x7f]), // linje med orimligt antal punkter
			gpkg([7, 1, 0, 0, 0]), // ogiltig byteordning
		];
		for (const b of bad) expect(() => parseGpkgGeometry(b)).toThrow(GpkgError);
	});

	it("avvisar för djupt nästlade samlingar", () => {
		let wkb = wkbPoint(1, 2);
		for (let i = 0; i < 10; i++) wkb = [1, 7, 0, 0, 0, 1, 0, 0, 0, ...wkb];
		expect(() => parseGpkgGeometry(gpkg(wkb))).toThrow(/djupt/);
	});
});

// ---------------------------------------------------------------- omvandling

function post(over: Partial<KallPost> = {}): KallPost {
	return {
		uuid: "00000000-0000-4000-8000-000000000001",
		lamningsnummer: "L2001:1",
		raa_nummer: "Bjursås  27:1",
		lamningstyp: "Källa med tradition",
		beskrivning: "Källa.",
		publicerad_av: null,
		publiceringsdatum: null,
		uttagsdatum: "2026-11-17",
		bedomning: "Övrig kulturhistorisk lämning",
		bedomning_motivering: null,
		aktualitet: null,
		skada: null,
		undersokning: null,
		placering: null,
		terrang: null,
		orientering: null,
		tradition: null,
		namn: null,
		lan: "Dalarna",
		kommun: "Falun",
		socken: "Bjursås,Leksand",
		osakerhet_m: 10,
		geometrier: [{ nr: "L2001:1-1", geometry: { type: "Point", coordinates: [524892.601, 6733210.685] } }],
		egenskaper: [],
		ingaende: [],
		...over,
	};
}

describe("omvandling", () => {
	it("text och flerledade fält", () => {
		expect(text("  a\u0000b \n")).toBe("ab");
		expect(text("   ")).toBeNull();
		expect(splitList("Bjursås, Leksand,Bjursås,")).toEqual(["Bjursås", "Leksand"]);
		expect(raaSok("Stora  Kopparberg 172:1")).toBe("stora kopparberg 172:1");
	});

	it("mittpunkt: yta före linje före punkt; hål dras av", () => {
		const sq = [
			[0, 0],
			[10, 0],
			[10, 10],
			[0, 10],
			[0, 0],
		];
		expect(centroid({ type: "Polygon", coordinates: [sq] })).toEqual([5, 5]);
		const c = centroid({ type: "Polygon", coordinates: [sq, [[0, 0], [5, 0], [5, 10], [0, 10], [0, 0]].reverse()] });
		expect(c?.[0]).toBeCloseTo(7.5);
		expect(
			centroid({
				type: "GeometryCollection",
				geometries: [
					{ type: "Point", coordinates: [100, 100] },
					{ type: "Polygon", coordinates: [sq] },
				],
			}),
		).toEqual([5, 5]);
		expect(centroid({ type: "LineString", coordinates: [[0, 0], [10, 0]] })).toEqual([5, 0]);
		expect(centroid({ type: "MultiPoint", coordinates: [[0, 0], [2, 2]] })).toEqual([1, 1]);
	});

	it("sammanslagning och rumsklass", () => {
		expect(combine([{ type: "Point", coordinates: [1, 2] }, { type: "Point", coordinates: [3, 4] }])?.type).toBe("MultiPoint");
		expect(combine([{ type: "Point", coordinates: [1, 2] }, { type: "LineString", coordinates: [[0, 0], [1, 1]] }])?.type).toBe(
			"GeometryCollection",
		);
		expect(rumsklass(0, 1000)).toBe(0);
		expect(rumsklass(0, 1001)).toBe(1);
		expect(rumsklass(0, 64001)).toBe(3);
	});

	it("hash är stabil mot ordning och uttagsdatum men känslig för innehåll", () => {
		const a = post({ egenskaper: [{ ingaende_nr: null, typ: "Typ", varde: "A" }, { ingaende_nr: null, typ: "Typ", varde: "B" }] });
		const b = post({
			uttagsdatum: "2026-12-01",
			egenskaper: [{ ingaende_nr: null, typ: "Typ", varde: "B" }, { ingaende_nr: null, typ: "Typ", varde: "A" }],
		});
		expect(contentHash(a)).toBe(contentHash(b));
		expect(contentHash(a)).not.toBe(contentHash(post({ beskrivning: "Källa!" })));
		expect(contentHash(a)).toMatch(/^[0-9a-f]{32}$/);
	});

	it("indexrad: WGS 84, ruta, indelning med koder (utan referens: inga koder)", () => {
		const p = toIndexPost(post(), new Indelning(null));
		expect(p.rad.lat).toBeCloseTo(60.7336816, 6);
		expect(p.rad.lon).toBeCloseTo(15.4564288, 6);
		expect(p.rad.min_e).toBe(524892);
		expect(p.rad.max_e).toBe(524893);
		expect(p.rad.raa_sok).toBe("bjursås 27:1");
		expect(p.omraden.map((o) => `${o.niva}:${o.namn}`)).toEqual(["lan:Dalarna", "kommun:Falun", "socken:Bjursås", "socken:Leksand"]);
	});
});

// ---------------------------------------------------------------- SQL

class MemSink implements SqlSink {
	statements: string[] = [];
	private seen = new Set<string>();
	beginBatch() {}
	omradeSeen(k: string) {
		if (this.seen.has(k)) return true;
		this.seen.add(k);
		return false;
	}
	emit(s: string) {
		this.statements.push(s);
	}
	close() {}
}

function freshDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(readFileSync(MIGRATION, "utf8"));
	return db;
}

describe("SQL", () => {
	it("literaler citeras", () => {
		expect(lit("O'Brien")).toBe("'O''Brien'");
		expect(lit(null)).toBe("NULL");
		expect(lit(Number.NaN)).toBe("NULL");
		expect(lit(1.5)).toBe("1.5");
		expect(lit("a\u0000b")).toBe("'ab'");
	});

	it("multiRow håller satserna under gränsen", () => {
		const rows = Array.from({ length: 1000 }, (_, i) => `('${"x".repeat(500)}', ${i})`);
		const st = multiRow("INSERT INTO t VALUES\n", rows, "", 20_000);
		expect(st.length).toBeGreaterThan(20);
		for (const s of st) expect(Buffer.byteLength(s)).toBeLessThanOrEqual(20_000);
	});

	it("satserna ger rätt innehåll, är idempotenta och klarar för stora rader", () => {
		const big = "Lång beskrivning med 'citat' och åäö. ".repeat(6000); // ~230 kB
		const ring: number[][] = [];
		for (let i = 0; i < 6000; i++) {
			const a = (i / 6000) * 2 * Math.PI;
			ring.push([530000 + 500 * Math.cos(a), 6725000 + 500 * Math.sin(a)]);
		}
		ring.push(ring[0]);
		const posts = [
			post(),
			post({
				uuid: "00000000-0000-4000-8000-000000000002",
				lamningsnummer: "L2001:2",
				beskrivning: big,
				geometrier: [{ nr: "x", geometry: { type: "Polygon", coordinates: [ring] } }],
				egenskaper: [
					{ ingaende_nr: null, typ: "Typ", varde: "Övrig" },
					{ ingaende_nr: 7, typ: "Material", varde: "Koppar" },
				],
				ingaende: [{ nr: 7, lamningstyp: "Slagg", antal: 2 }],
			}),
		].map((p) => toIndexPost(p, new Indelning(null)));
		const sink = new MemSink();
		batchStatements(posts, sink);
		for (const s of sink.statements) expect(Buffer.byteLength(s)).toBeLessThanOrEqual(MAX_STATEMENT_BYTES);
		expect(sink.statements.some((s) => s.startsWith("UPDATE lamning SET beskrivning = beskrivning ||"))).toBe(true);

		const db = freshDb();
		const run = () => {
			for (const s of sink.statements) db.exec(s);
		};
		run();
		run(); // idempotent
		const q = (sql: string) => db.prepare(sql).get() as Record<string, unknown>;
		expect(q("SELECT count(*) AS c FROM lamning").c).toBe(2);
		const stored = String(q("SELECT beskrivning AS b FROM lamning WHERE lamningsnummer = 'L2001:2'").b);
		expect(stored.length).toBe(big.length);
		expect(stored === big).toBe(true);
		const g = JSON.parse(String(q("SELECT geometri AS g FROM lamning WHERE lamningsnummer = 'L2001:2'").g));
		expect(g.coordinates[0].length).toBe(6001);
		expect(q("SELECT count(*) AS c FROM egenskap").c).toBe(2);
		expect(q("SELECT count(*) AS c FROM ingaende").c).toBe(1);
		expect(q("SELECT count(*) AS c FROM lamning_omrade").c).toBe(8);
		expect(q("SELECT count(*) AS c FROM omrade").c).toBe(4);
		// FTS följer med, även för texten som fylldes på i delar.
		expect(q("SELECT count(*) AS c FROM lamning_fts WHERE lamning_fts MATCH '\"citat\"'").c).toBe(1);
		db.exec("INSERT INTO lamning_fts(lamning_fts, rank) VALUES('integrity-check', 1)");
	});
});

// ---------------------------------------------------------------- granskningens fynd (etapp 4)

describe("granskning: FTS-kontroll, synkrad, kategorier, avstämning", () => {
	it("integrity-check med rank 1 upptäcker att FTS-tabellen inte stämmer med lamning", () => {
		const db = freshDb();
		const posts = [toIndexPost(post({ uuid: "11111111-2222-4333-8444-555555555555", lamningsnummer: "L2001:9", beskrivning: "en hytta" }), new Indelning(null))];
		const sink = new MemSink();
		batchStatements(posts, sink);
		for (const s of sink.statements) db.exec(s);
		db.exec("INSERT INTO lamning_fts(lamning_fts, rank) VALUES('integrity-check', 1)");
		// Ändra texten förbi triggrarna: utan rank märks det inte, med rank 1 ger kontrollen fel.
		db.exec("DROP TRIGGER lamning_fts_au");
		db.exec("UPDATE lamning SET beskrivning = 'något helt annat'");
		expect(() => db.exec("INSERT INTO lamning_fts(lamning_fts) VALUES('integrity-check')")).not.toThrow();
		expect(() => db.exec("INSERT INTO lamning_fts(lamning_fts, rank) VALUES('integrity-check', 1)")).toThrow();
	});

	it("synkStatements är idempotent: en omkörning ger ingen ny synkrad", () => {
		const db = freshDb();
		const info = { typ: "grundladdning" as const, startad: "2026-11-17T10:00:00Z", klar: "2026-11-17T10:05:00Z", kalla: "x", uttagsdatum: "2026-11-17", nya: 1, andrade: 0, borttagna: 0 };
		for (let i = 0; i < 3; i++) for (const s of synkStatements(info)) db.exec(s);
		expect((db.prepare("SELECT count(*) AS c FROM synk").get() as { c: number }).c).toBe(1);
		expect((db.prepare("SELECT varde FROM synk_status WHERE nyckel = 'uttagsdatum'").get() as { varde: string }).varde).toBe("2026-11-17");
	});

	it("kategoriStatements: lägger till före borttagning, så att tabellen aldrig blir tom", () => {
		const db = freshDb();
		const gammal = kategoriStatements([{ namn: "Hyttområde", kategorier: ["Metallframställning och bergsbruk"] }, { namn: "Röse", kategorier: ["Gravar"] }]);
		for (const s of gammal) db.exec(s);
		const ny = kategoriStatements([{ namn: "Hyttområde", kategorier: ["Metallframställning och bergsbruk", "Industri"] }]);
		expect(ny[ny.length - 1]).toMatch(/^DELETE FROM lamningstyp_kategori WHERE NOT EXISTS/);
		expect(ny.some((s) => /^DELETE FROM lamningstyp_kategori;/.test(s))).toBe(false);
		// Avbrott efter första satsen: alla gamla par finns kvar, de nya har lagts till.
		db.exec(ny[0]);
		expect((db.prepare("SELECT count(*) AS c FROM lamningstyp_kategori").get() as { c: number }).c).toBe(3);
		for (const s of ny) db.exec(s);
		const rows = db.prepare("SELECT lamningstyp, kategori FROM lamningstyp_kategori ORDER BY kategori").all();
		expect(rows.map((r) => `${r.lamningstyp}/${r.kategori}`)).toEqual(["Hyttområde/Industri", "Hyttområde/Metallframställning och bergsbruk"]);
	});

	it("avstamning: tappade lämningar och oförklarade barnrader ger avvikelse", () => {
		const st = newStats();
		st.kalla = { lamningar: 3, geometrier: 4, egenskaper: 2, ingaende: 1 };
		st.lamningar = 3;
		st.geometrier = 3;
		st.skippade.geometrier = 1;
		st.egenskaper = 1;
		st.foraldralosaPer.egenskaper = 1;
		st.ingaende = 1;
		expect(avstamning(st)).toEqual([]);
		st.lamningar = 2;
		st.skippade.lamningar = 1;
		st.egenskaper = 0;
		const a = avstamning(st);
		expect(a.join("\n")).toMatch(/lämningar: källan har 3, skrivna 2/);
		expect(a.join("\n")).toMatch(/egenskaper: .* 1 rader oförklarade/);
		expect(avstamning(newStats())).toEqual(["källans antal saknas (läsningen avbröts?)"]);
	});
});
