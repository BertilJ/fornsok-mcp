/**
 * Nattsynken mot inspelade svar: ändringsflödet (2026-11-10, se fixtures/),
 * Fornsök-appens poster och K-samsök (test/fixtures), med D1 ersatt av
 * node:sqlite och migreringarna 0001 + 0002.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hamtaFlode, parseFlodeSida } from "../../src/sync/flode";
import { runSync, STATUS_SENAST } from "../../src/sync/run";
import { senasteKlaraDag } from "../../src/sync/datum";
import { UpstreamClient } from "../../src/upstream/client";
import {
	appFixture,
	emptyDb,
	fakeRaa,
	type FakeRaa,
	flodePost,
	ftsIntegrity,
	ftsUuids,
	openD1,
	syncFixture,
	UUID,
} from "./helpers";

/** 05:00 svensk tid 12 nov: senaste kompletta dag i flödet är 11 nov. */
const NU = new Date("2026-11-12T04:00:00Z");
const dagEfter = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const noSleep = async () => {};

function status(db: DatabaseSync, nyckel: string): string | null {
	return (
		(
			db.prepare("SELECT varde FROM synk_status WHERE nyckel = ?").get(nyckel) as
				| { varde: string }
				| undefined
		)?.varde ?? null
	);
}
function count(db: DatabaseSync, sql: string, ...p: Array<string | number>): number {
	return Number((db.prepare(sql).get(...p) as { n: number }).n);
}

describe("ändringsflödet (inspelat 2026-11-10)", () => {
	it("tolkar en riktig sida", () => {
		const s = parseFlodeSida(syncFixture("flode-2026-11-10-sida0-storlek5.json"));
		expect(s.poster).toHaveLength(5);
		expect(s.totalPages).toBe(9);
		expect(s.totalElements).toBe(45);
		expect(s.last).toBe(false);
		expect(s.poster[0]).toEqual({
			uuid: "001db954-ddfd-4cd4-8b2e-74016d2d4852",
			lamningsnummer: "L2026:6486",
			typer: ["NY"],
			utgar: false,
		});
	});

	it("tolkar en hel dag: 45 poster, 32 nya", () => {
		const s = parseFlodeSida(syncFixture("flode-2026-11-10.json"));
		expect(s.poster).toHaveLength(45);
		expect(s.poster.filter((p) => p.typer.includes("NY"))).toHaveLength(32);
		expect(s.poster.some((p) => p.typer.length > 1)).toBe(true);
	});

	it("hämtar alla sidor med hövliga anrop och identifierande User-Agent", async () => {
		const day = syncFixture<{ content: Array<Record<string, unknown>> }>(
			"flode-2026-11-10.json",
		);
		const raa = fakeRaa();
		raa.flode.set("2026-11-10", day.content);
		const seen: string[] = [];
		const client = new UpstreamClient({
			userAgent: "fornsok-mcp/0.1 (+https://example.org/kontakt)",
			fetch: async (input, init) => {
				seen.push(new Headers(init?.headers).get("user-agent") ?? "");
				return raa.fetch(input, init);
			},
		});
		let pauser = 0;
		const r = await hamtaFlode(client, "2026-11-10", "2026-11-10", {
			storlek: 5,
			paus: async () => void pauser++,
		});
		expect(r.poster).toHaveLength(45);
		expect(r.sidor).toBe(9);
		expect(pauser).toBe(8);
		expect(raa.calls.map((u) => u.searchParams.get("page"))).toEqual([
			"0",
			"1",
			"2",
			"3",
			"4",
			"5",
			"6",
			"7",
			"8",
		]);
		expect(seen.every((ua) => ua.startsWith("fornsok-mcp/0.1 (+"))).toBe(true);
	});
});

describe("runSync", () => {
	let db: DatabaseSync;
	let raa: FakeRaa;
	const env = () => ({ DB: openD1(db), SEMANTIC_LAN: "Dalarna" });
	const opts = (o: Record<string, unknown> = {}) => ({
		now: NU,
		fetch: raa.fetch,
		sleep: noSleep,
		pausMs: 0,
		...o,
	});

	beforeEach(() => {
		db = emptyDb();
		raa = fakeRaa();
		raa.flode.set("2026-11-11", [
			flodePost(UUID.L2001_646, "L2001:646", ["NY"]),
			flodePost(UUID.L2000_8802, "L2000:8802", ["NY"]),
			flodePost(UUID.L1946_7415, "L1946:7415", ["NY"]),
		]);
	});
	afterEach(() => db.close());

	it("ny post: rader, områden, egenskaper, ingående, FTS, logg och inbäddningskö", async () => {
		const r = await runSync(env(), opts());
		expect(r).toMatchObject({
			status: "klar",
			fran: "2026-11-11",
			till: "2026-11-11",
			senast_synkat: "2026-11-11",
			nya: 3,
			andrade: 0,
			kvar: 0,
		});
		expect(r.fel).toEqual([]);
		expect(count(db, "SELECT count(*) AS n FROM lamning")).toBe(3);
		const l = db.prepare("SELECT * FROM lamning WHERE uuid = ?").get(UUID.L2001_646) as Record<
			string,
			unknown
		>;
		expect(l).toMatchObject({
			lamningsnummer: "L2001:646",
			raa_nummer: "Bjursås 27:1",
			raa_sok: "bjursås 27:1",
			lamningstyp: "Källa med tradition",
			bedomning: "Övrig kulturhistorisk lämning",
			osakerhet_m: 15,
			publicerad: "2018-10-01T09:34:41+02:00",
			publicerad_av: "Riksantikvarieämbetet",
			geometrityp: "Point",
			uttagsdatum: "2026-11-12",
		});
		expect(l.lat as number).toBeCloseTo(60.73368161435678, 6);
		expect(l.lon as number).toBeCloseTo(15.456428761252013, 6);
		const omr = db
			.prepare(
				"SELECT o.niva, o.namn, o.lan, o.kod FROM lamning_omrade lo JOIN omrade o ON o.id = lo.omrade_id JOIN lamning l ON l.id = lo.lamning_id WHERE l.uuid = ? ORDER BY o.niva",
			)
			.all(UUID.L2001_646);
		expect(omr).toEqual([
			{ niva: "kommun", namn: "Falun", lan: "", kod: "2080" },
			{ niva: "lan", namn: "Dalarna", lan: "", kod: "20" },
			{ niva: "landskap", namn: "Dalarna", lan: "", kod: "Dr" },
			{
				niva: "socken",
				namn: "Bjursås",
				lan: "",
				kod: "d8d7a241-2b23-4a6a-809d-9a5610ebd864",
			},
		]);
		expect(
			db
				.prepare(
					"SELECT typ, varde, ingaende_nr FROM egenskap e JOIN lamning l ON l.id = e.lamning_id WHERE l.uuid = ?",
				)
				.all(UUID.L2001_646),
		).toEqual([{ typ: "Typ", varde: "Midsommar/trefaldighet", ingaende_nr: null }]);
		expect(
			count(
				db,
				"SELECT count(*) AS n FROM ingaende i JOIN lamning l ON l.id = i.lamning_id WHERE l.uuid = ?",
				UUID.L2000_8802,
			),
		).toBe(5);
		expect(
			count(
				db,
				"SELECT count(*) AS n FROM egenskap e JOIN lamning l ON l.id = e.lamning_id WHERE l.uuid = ? AND e.ingaende_nr IS NOT NULL",
				UUID.L2000_8802,
			),
		).toBe(8);
		expect(
			count(
				db,
				"SELECT count(*) AS n FROM lamningstyp_kategori WHERE lamningstyp = 'Hyttområde'",
			),
		).toBeGreaterThan(0);
		expect(ftsUuids(db, "önskekälla")).toEqual([UUID.L2001_646]);
		ftsIntegrity(db);
		expect(status(db, STATUS_SENAST)).toBe("2026-11-11");
		expect(count(db, "SELECT count(*) AS n FROM synk_ko")).toBe(0);
		const logg = db
			.prepare("SELECT typ, fran, till, nya, andrade, borttagna, fel FROM synk")
			.all();
		expect(logg).toEqual([
			{
				typ: "nattsynk",
				fran: "2026-11-11",
				till: "2026-11-11",
				nya: 3,
				andrade: 0,
				borttagna: 0,
				fel: null,
			},
		]);
		// Inbäddningskön: bara lämningarna i Dalarna (omfånget), inte Stugun i Jämtland.
		expect(
			(
				db.prepare("SELECT uuid, orsak FROM inbaddning_ko ORDER BY uuid").all() as Array<{
					uuid: string;
				}>
			).map((x) => x.uuid),
		).toEqual([UUID.L2000_8802, UUID.L2001_646].sort());
		// Hövligt: ett anrop till flödet, två till värdelistorna, ett per lämning.
		const appCalls = raa.calls.filter((u) =>
			u.pathname.startsWith("/open/fornsok/api/lamning/lamning/"),
		);
		expect(appCalls).toHaveLength(3);
	});

	it("uppdaterad post: FTS hittar den nya texten och inte den gamla; raden behåller sitt id", async () => {
		await runSync(env(), opts());
		const idFore = (
			db.prepare("SELECT id FROM lamning WHERE uuid = ?").get(UUID.L2001_646) as {
				id: number;
			}
		).id;
		db.exec("DELETE FROM inbaddning_ko");
		const ny = appFixture(UUID.L2001_646);
		ny.tradition = "Källan har använts som offerkälla vid midsommar.";
		ny.beskrivning = `${String(ny.beskrivning)} Kompletterad 2026.`;
		raa.app.set(UUID.L2001_646, ny);
		raa.flode.set("2026-11-12", [
			flodePost(UUID.L2001_646, "L2001:646", ["OVRIG_UPPDATERING"]),
		]);

		const r = await runSync(env(), opts({ now: dagEfter(NU, 1) }));
		expect(r).toMatchObject({
			status: "klar",
			fran: "2026-11-12",
			till: "2026-11-12",
			nya: 0,
			andrade: 1,
		});
		expect(ftsUuids(db, "offerkälla")).toEqual([UUID.L2001_646]);
		expect(ftsUuids(db, "önskekälla")).toEqual([]);
		expect(ftsUuids(db, "kompletterad")).toEqual([UUID.L2001_646]);
		ftsIntegrity(db);
		expect(
			(
				db.prepare("SELECT id FROM lamning WHERE uuid = ?").get(UUID.L2001_646) as {
					id: number;
				}
			).id,
		).toBe(idFore);
		expect(
			count(
				db,
				"SELECT count(*) AS n FROM egenskap e JOIN lamning l ON l.id = e.lamning_id WHERE l.uuid = ?",
				UUID.L2001_646,
			),
		).toBe(1);
		expect(db.prepare("SELECT uuid, orsak FROM inbaddning_ko").all()).toEqual([
			{ uuid: UUID.L2001_646, orsak: "andrad" },
		]);
	});

	it("utgången post tas bort överallt (rader, barnrader, FTS) och markeras för borttagning av vektorer", async () => {
		await runSync(env(), opts());
		db.exec(
			"INSERT INTO inbaddning (uuid, rad_hash, innehall_hash, vektorer, status, modell, andrad) VALUES ('6d1cf7b6-f5bd-4066-aba6-fb1ea3ce8c75', 'x', 'y', 1, 'ok', 'm', 't')",
		);
		db.exec("DELETE FROM inbaddning_ko");
		expect(ftsUuids(db, "hyttområde")).toContain(UUID.L2000_8802);
		raa.flode.set("2026-11-12", [flodePost(UUID.L2000_8802, "L2000:8802", ["UTGAR"])]);
		const r = await runSync(env(), opts({ now: dagEfter(NU, 1) }));
		expect(r).toMatchObject({ status: "klar", borttagna: 1 });
		expect(count(db, "SELECT count(*) AS n FROM lamning WHERE uuid = ?", UUID.L2000_8802)).toBe(
			0,
		);
		expect(count(db, "SELECT count(*) AS n FROM ingaende")).toBe(0);
		expect(count(db, "SELECT count(*) AS n FROM egenskap WHERE ingaende_nr IS NOT NULL")).toBe(
			0,
		);
		expect(
			count(
				db,
				"SELECT count(*) AS n FROM lamning_omrade lo LEFT JOIN lamning l ON l.id = lo.lamning_id WHERE l.id IS NULL",
			),
		).toBe(0);
		expect(ftsUuids(db, "hyttområde")).toEqual([]);
		ftsIntegrity(db);
		expect(db.prepare("SELECT uuid, orsak FROM inbaddning_ko").all()).toEqual([
			{ uuid: UUID.L2000_8802, orsak: "utgar" },
		]);
		// Ingen app-hämtning för en utgången post.
		expect(raa.calls.filter((u) => u.pathname.endsWith(UUID.L2000_8802))).toHaveLength(1);
	});

	it("återupptas efter avbrott och blir inte dubbel", async () => {
		const a = await runSync(env(), opts({ avbrytEfter: 1 }));
		expect(a).toMatchObject({ status: "pagaende", nya: 1, kvar: 2, senast_synkat: null });
		expect(status(db, STATUS_SENAST)).toBeNull();
		expect(status(db, "synk_intervall")).toContain("2026-11-11");
		const flodeAnrop = raa.calls.filter((u) => u.hostname === "pub.raa.se").length;

		const b = await runSync(env(), opts());
		expect(b).toMatchObject({ status: "klar", nya: 2, kvar: 0, senast_synkat: "2026-11-11" });
		// Flödet hämtades inte igen: intervallet låg kvar i kön.
		expect(raa.calls.filter((u) => u.hostname === "pub.raa.se").length).toBe(flodeAnrop);
		expect(count(db, "SELECT count(*) AS n FROM lamning")).toBe(3);
		expect(count(db, "SELECT count(*) AS n FROM synk")).toBe(2);
		ftsIntegrity(db);

		// Samma dag igen: inget nytt att hämta.
		const c = await runSync(env(), opts());
		expect(c.status).toBe("inget_nytt");
	});

	it("idempotent: samma poster en gång till skrivs inte om", async () => {
		await runSync(env(), opts());
		const hash = db.prepare("SELECT uuid, hash FROM lamning ORDER BY uuid").all();
		raa.flode.set("2026-11-12", [
			flodePost(UUID.L2001_646, "L2001:646", ["OVRIG_UPPDATERING"]),
			flodePost(UUID.L2000_8802, "L2000:8802", ["UPPDATERAD_GEOMETRI"]),
		]);
		const r = await runSync(env(), opts({ now: dagEfter(NU, 1) }));
		expect(r).toMatchObject({ status: "klar", nya: 0, andrade: 0, oforandrade: 2 });
		expect(db.prepare("SELECT uuid, hash FROM lamning ORDER BY uuid").all()).toEqual(hash);
		ftsIntegrity(db);
	});

	it("Fornsök-appen svarar 500: posten hämtas från K-samsök och prövas igen nästa dag", async () => {
		await runSync(env(), opts());
		raa.app.set(UUID.L2001_646, 500);
		raa.flode.set("2026-11-12", [
			flodePost(UUID.L2001_646, "L2001:646", ["OVRIG_UPPDATERING"]),
		]);
		const r = await runSync(env(), opts({ now: dagEfter(NU, 1) }));
		expect(r).toMatchObject({ status: "klar", reserv: 1, andrade: 1, kvar: 1 });
		const l = db
			.prepare("SELECT hash, osakerhet_m, publicerad_av FROM lamning WHERE uuid = ?")
			.get(UUID.L2001_646) as Record<string, unknown>;
		expect(String(l.hash)).toMatch(/^ksamsok:/);
		// Det K-samsök saknar behålls.
		expect(l).toMatchObject({ osakerhet_m: 15, publicerad_av: "Riksantikvarieämbetet" });
		expect(
			count(
				db,
				"SELECT count(*) AS n FROM egenskap e JOIN lamning l ON l.id = e.lamning_id WHERE l.uuid = ?",
				UUID.L2001_646,
			),
		).toBe(1);
		expect(db.prepare("SELECT status, forsok FROM synk_ko").all()).toEqual([
			{ status: "reserv", forsok: 1 },
		]);
		ftsIntegrity(db);

		// Nästa dag svarar appen igen: posten skrivs från appen och lämnar kön.
		raa.app.delete(UUID.L2001_646);
		const r2 = await runSync(env(), opts({ now: dagEfter(NU, 2) }));
		expect(r2).toMatchObject({ andrade: 1, reserv: 0, kvar: 0 });
		expect(
			String(
				(
					db.prepare("SELECT hash FROM lamning WHERE uuid = ?").get(UUID.L2001_646) as {
						hash: string;
					}
				).hash,
			),
		).not.toMatch(/^ksamsok:/);
		ftsIntegrity(db);
	});

	it("appen svarar 404: posten ligger kvar som 'saknas' och skrivs inte", async () => {
		raa.app.set(UUID.L1946_7415, 404);
		const r = await runSync(env(), opts());
		expect(r).toMatchObject({ nya: 2, kvar: 1, status: "klar" });
		expect(db.prepare("SELECT uuid, status, forsok FROM synk_ko").all()).toEqual([
			{ uuid: UUID.L1946_7415, status: "saknas", forsok: 1 },
		]);
		expect(count(db, "SELECT count(*) AS n FROM lamning WHERE uuid = ?", UUID.L1946_7415)).toBe(
			0,
		);
	});

	it("begränsar antalet lämningar per körning och fortsätter nästa gång", async () => {
		const r = await runSync(env(), opts({ maxPoster: 2 }));
		expect(r).toMatchObject({ status: "pagaende", nya: 2, kvar: 1 });
		const r2 = await runSync(env(), opts({ maxPoster: 2 }));
		expect(r2).toMatchObject({ status: "klar", nya: 1, kvar: 0 });
	});

	it("ny GeoPackage-laddning flyttar markören till dagen före uttagsdatum", async () => {
		await runSync(env(), opts());
		db.exec(
			"INSERT INTO synk_status (nyckel, varde, andrad) VALUES ('uttagsdatum', '2026-11-11', 't')",
		);
		raa.flode.set("2026-11-10", [
			flodePost(UUID.L2001_646, "L2001:646", ["OVRIG_UPPDATERING"]),
		]);
		const r = await runSync(env(), opts({ now: dagEfter(NU, 1) }));
		expect(r).toMatchObject({
			fran: "2026-11-10",
			till: "2026-11-12",
			status: "klar",
			senast_synkat: "2026-11-12",
		});
		expect(status(db, "synk_uttagsdatum_sett")).toBe("2026-11-11");
		// Därefter normalt igen.
		const r2 = await runSync(env(), opts({ now: dagEfter(NU, 2) }));
		expect(r2).toMatchObject({ fran: "2026-11-13", till: "2026-11-13" });
	});

	it("larmar när synken ligger efter och hämtar högst maxDagar åt gången", async () => {
		db.exec(
			"INSERT INTO synk_status (nyckel, varde, andrad) VALUES ('senast_synkat', '2026-10-01', 't')",
		);
		const r = await runSync(env(), opts({ maxDagar: 10 }));
		expect(r).toMatchObject({
			fran: "2026-10-02",
			till: "2026-10-11",
			status: "pagaende",
			senast_synkat: "2026-10-11",
		});
		expect(r.fel.some((f) => f.startsWith("LARM"))).toBe(true);
	});

	it("fel i flödet loggas och lämnar markören orörd", async () => {
		const bad = fakeRaa();
		const failing = async (input: Request | string | URL, init?: RequestInit) => {
			const u = new URL(
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
			);
			if (u.hostname === "pub.raa.se") return new Response("fel", { status: 503 });
			return bad.fetch(input, init);
		};
		const r = await runSync(env(), opts({ fetch: failing }));
		expect(r.status).toBe("fel");
		expect(status(db, STATUS_SENAST)).toBeNull();
		expect((db.prepare("SELECT fel FROM synk").get() as { fel: string }).fel).toMatch(/503/);
	});
});

describe("senasteKlaraDag", () => {
	it("gårdagen räknas som klar först efter 04:30 svensk tid", () => {
		expect(senasteKlaraDag(new Date("2026-11-12T03:29:00Z"))).toBe("2026-11-10"); // 04:29 CET
		expect(senasteKlaraDag(new Date("2026-11-12T03:30:00Z"))).toBe("2026-11-11"); // 04:30 CET
		expect(senasteKlaraDag(new Date("2026-07-12T02:29:00Z"))).toBe("2026-07-10"); // 04:29 CEST
		expect(senasteKlaraDag(new Date("2026-07-12T02:31:00Z"))).toBe("2026-07-11");
	});
});

describe("listan över tillåtna anrop: ändringsflödet", () => {
	it("bara listningen med datum och sidindelning", async () => {
		const { checkAllowed } = await import("../../src/upstream/allowlist");
		expect(
			checkAllowed(
				"GET",
				"https://pub.raa.se/datauttag/lamningar?from=2026-11-10&to=2026-11-10&page=0&size=500",
			).id,
		).toBe("raa.datauttag.lamningar");
		for (const bad of [
			"https://pub.raa.se/datauttag/lamningar?from=2026-11-10",
			"https://pub.raa.se/datauttag/lamningar?from=2026-11-10&to=x&page=0",
			"https://pub.raa.se/datauttag/lamningar/legacy?page=0",
			"https://pub.raa.se/datauttag/lamningar/001db954-ddfd-4cd4-8b2e-74016d2d4852",
			"https://pub.raa.se/datauttag/lamningar?from=2026-11-10&to=2026-11-10&sort=id",
			"https://pub.raa.se/nedladdning/datauttag/lamningar_v1/",
		])
			expect(() => checkAllowed("GET", bad)).toThrow();
	});
});
