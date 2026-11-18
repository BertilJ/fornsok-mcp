/**
 * Nattsynken mot inspelade svar: ändringsflödet (2026-11-10, se fixtures/),
 * Fornsök-appens poster och K-samsök (test/fixtures), med D1 ersatt av
 * node:sqlite och migreringarna 0001 + 0002.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLODE_MAX_SIDOR, hamtaFlode, parseFlodeSida } from "../../src/sync/flode";
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

	it("fler sidor än FLODE_MAX_SIDOR ger fel i stället för tyst trunkering", async () => {
		const raa = fakeRaa();
		raa.flode.set("2026-11-10", Array.from({ length: FLODE_MAX_SIDOR + 5 }, (_, i) => flodePost(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, `L2099:${i}`, ["NY"])));
		const client = new UpstreamClient({ userAgent: "fornsok-mcp/0.1 (+https://example.org/kontakt)", fetch: raa.fetch });
		await expect(hamtaFlode(client, "2026-11-10", "2026-11-10", { storlek: 1 })).rejects.toThrow(/fler än 200 som läses per intervall/);
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

	// ------------------------------------------------ granskningen av synken, punkt 2 och 3

	it("infrastrukturfel (5xx, båda källorna) förbrukar inga försök; strömbrytaren avbryter efter de första", async () => {
		const extra = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-0000000000${String(i + 10)}`);
		raa.flode.set("2026-11-11", extra.map((u, i) => flodePost(u, `L2099:${i}`, ["NY"])));
		for (const u of extra) raa.app.set(u, 503);
		raa.ksamsokStatus = 503;
		const r = await runSync(env(), opts());
		expect(r.fel.join(" ")).toMatch(/strömbrytare: de 5 första posterna/);
		const ko = db.prepare("SELECT forsok FROM synk_ko").all() as Array<{ forsok: number }>;
		expect(ko).toHaveLength(8);
		expect(ko.every((k) => k.forsok === 0)).toBe(true);
		// Bara fem poster prövades mot appen (varje med ett omförsök i klienten).
		expect(new Set(raa.calls.filter((u) => u.hostname === "app.raa.se" && /\/lamning\/lamning\//.test(u.pathname)).map((u) => u.pathname)).size).toBe(5);
	});

	it("fel på posten räknas en gång per kalenderdag, inte per körning", async () => {
		raa.app.set(UUID.L1946_7415, 400);
		raa.ksamsokStatus = 400;
		const forsok = () => (db.prepare("SELECT forsok FROM synk_ko WHERE uuid = ?").get(UUID.L1946_7415) as { forsok: number }).forsok;
		await runSync(env(), opts());
		expect(forsok()).toBe(1);
		await runSync(env(), opts({ now: new Date(NU.getTime() + 60 * 60 * 1000) }));
		await runSync(env(), opts({ now: new Date(NU.getTime() + 2 * 60 * 60 * 1000) }));
		expect(forsok()).toBe(1);
		await runSync(env(), opts({ now: dagEfter(NU, 1) }));
		expect(forsok()).toBe(2);
	});

	it("404 i appen utan UTGAR: efter maxForsok dagar tas posten bort om K-samsök inte heller har den", async () => {
		await runSync(env(), opts());
		expect(count(db, "SELECT count(*) AS n FROM lamning WHERE uuid = ?", UUID.L1946_7415)).toBe(1);
		raa.flode.set("2026-11-12", [flodePost(UUID.L1946_7415, "L1946:7415", ["OVRIG_UPPDATERING"])]);
		raa.app.set(UUID.L1946_7415, 404);
		raa.ksamsokStatus = 404;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const r = await runSync(env(), opts({ now: dagEfter(NU, 1), maxForsok: 1 }));
			expect(r.fel.join(" ")).toMatch(/finns varken i Fornsök-appen \(404\) eller K-samsök/);
			expect(r.borttagna).toBe(1);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
		expect(count(db, "SELECT count(*) AS n FROM lamning WHERE uuid = ?", UUID.L1946_7415)).toBe(0);
		expect(count(db, "SELECT count(*) AS n FROM synk_ko")).toBe(0);
	});

	it("404 i appen men posten finns i K-samsök: lämnas i indexet åt avstämningen, med logg", async () => {
		await runSync(env(), opts());
		raa.flode.set("2026-11-12", [flodePost(UUID.L1946_7415, "L1946:7415", ["OVRIG_UPPDATERING"])]);
		raa.app.set(UUID.L1946_7415, 404);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const r = await runSync(env(), opts({ now: dagEfter(NU, 1), maxForsok: 1 }));
			expect(r.fel.join(" ")).toMatch(/finns i K-samsök; lämnas åt avstämningen/);
		} finally {
			warn.mockRestore();
		}
		expect(count(db, "SELECT count(*) AS n FROM lamning WHERE uuid = ?", UUID.L1946_7415)).toBe(1);
	});
});

/**
 * Områdestabellerna räknade direkt i JS ur lamning, lamning_omrade och omrade
 * (oberoende av SQL:en i src/store/omraden.ts), jämförda med tabellerna.
 */
function kontrolleraOmraden(db: DatabaseSync): void {
	const lam = new Map((db.prepare("SELECT id, lat, lon FROM lamning").all() as Array<{ id: number; lat: number | null; lon: number | null }>).map((r) => [r.id, r]));
	const omr = new Map((db.prepare("SELECT id, niva FROM omrade").all() as Array<{ id: number; niva: string }>).map((r) => [r.id, r.niva]));
	const lo = db.prepare("SELECT omrade_id, lamning_id FROM lamning_omrade").all() as Array<{ omrade_id: number; lamning_id: number }>;
	const perOmrade = new Map<number, number[]>();
	const perLamning = new Map<number, number[]>();
	for (const r of lo) {
		perOmrade.set(r.omrade_id, [...(perOmrade.get(r.omrade_id) ?? []), r.lamning_id]);
		perLamning.set(r.lamning_id, [...(perLamning.get(r.lamning_id) ?? []), r.omrade_id]);
	}
	const sam = new Map((db.prepare("SELECT * FROM omrade_sammanfattning").all() as Array<Record<string, number | null>>).map((r) => [Number(r.omrade_id), r]));
	for (const [id] of omr) {
		const ids = perOmrade.get(id) ?? [];
		const lagen = ids.map((i) => lam.get(i)).filter((l) => l && l.lat !== null && l.lon !== null) as Array<{ lat: number; lon: number }>;
		const r = sam.get(id);
		expect(r?.inaktuell ?? 0, `omrade ${id} inaktuell`).toBe(0);
		expect(Number(r?.antal ?? 0), `omrade ${id} antal`).toBe(ids.length);
		expect(Number(r?.med_lage ?? 0), `omrade ${id} med_lage`).toBe(lagen.length);
		if (lagen.length) {
			expect(r?.lat).toBeCloseTo(lagen.reduce((a, l) => a + l.lat, 0) / lagen.length, 9);
			expect(r?.lon).toBeCloseTo(lagen.reduce((a, l) => a + l.lon, 0) / lagen.length, 9);
			expect(r?.min_lat).toBe(Math.min(...lagen.map((l) => l.lat)));
			expect(r?.max_lon).toBe(Math.max(...lagen.map((l) => l.lon)));
		}
	}
	const over: Record<string, string[]> = { socken: ["kommun", "lan"], kommun: ["lan"] };
	const forvantad = new Map<string, number>();
	for (const [, omraden] of perLamning)
		for (const a of omraden)
			for (const b of omraden)
				if (over[omr.get(a) ?? ""]?.includes(omr.get(b) ?? "")) forvantad.set(`${a}>${b}`, (forvantad.get(`${a}>${b}`) ?? 0) + 1);
	const rel = new Map((db.prepare("SELECT omrade_id, overordnad_id, antal FROM omrade_relation").all() as Array<{ omrade_id: number; overordnad_id: number; antal: number }>).map((r) => [`${r.omrade_id}>${r.overordnad_id}`, r.antal]));
	expect(Object.fromEntries(rel)).toEqual(Object.fromEntries(forvantad));
	const niva = Object.fromEntries((db.prepare("SELECT niva, med_omrade FROM niva_sammanfattning").all() as Array<{ niva: string; med_omrade: number }>).map((r) => [r.niva, r.med_omrade]));
	for (const n of ["lan", "kommun", "socken", "landskap"]) {
		const med = [...perLamning.values()].filter((omraden) => omraden.some((a) => omr.get(a) === n)).length;
		expect(niva[n] ?? 0, `niva ${n}`).toBe(med);
	}
}

describe("områdestabellerna efter nattsynken (facit: direkt räkning)", () => {
	it("ny, flyttad (annan socken och kommun) och borttagen lämning: sammanfattning, relationer och nivåer stämmer", async () => {
		const db = emptyDb();
		try {
			const raa = fakeRaa();
			const env = { DB: openD1(db), SEMANTIC_LAN: "Dalarna" };
			const o = (now: Date) => ({ now, fetch: raa.fetch, sleep: noSleep, pausMs: 0 });
			raa.flode.set("2026-11-11", [flodePost(UUID.L2001_646, "L2001:646", ["NY"]), flodePost(UUID.L2000_8802, "L2000:8802", ["NY"]), flodePost(UUID.L1946_7415, "L1946:7415", ["NY"])]);
			expect(await runSync(env, o(NU))).toMatchObject({ nya: 3, status: "klar" });
			kontrolleraOmraden(db);
			const fore = db.prepare("SELECT o.niva, o.namn FROM omrade o JOIN lamning_omrade lo ON lo.omrade_id = o.id JOIN lamning l ON l.id = lo.lamning_id WHERE l.uuid = ? ORDER BY o.niva").all(UUID.L2001_646);
			expect(fore).toContainEqual({ niva: "socken", namn: "Bjursås" });

			// Dag 2: L2001:646 flyttas till Leksands socken och kommun, L2000:8802 utgår, en ny lämning tillkommer.
			const flyttad = appFixture(UUID.L2001_646);
			const lage = flyttad.nuvarande_lage as { geografisk_indelning: Record<string, unknown> };
			lage.geografisk_indelning = {
				kommun: [{ kommun_kod: "2029", kommun_namn: "Leksand", lan_kod: "20", lan_namn: "Dalarna" }],
				socken: [{ socken_id: "ef54bb9b-2060-49f5-9dc2-2a718cea368d", socken_namn: "Leksand" }],
				landskap: [{ landskap_kod: "Dr", landskap_namn: "Dalarna" }],
			};
			raa.app.set(UUID.L2001_646, flyttad);
			const NY = "11111111-2222-4333-8444-555555555555";
			const ny = appFixture(UUID.L1946_7415);
			ny.lamning_id = NY;
			ny.lamningsnummer = "L2099:1";
			raa.app.set(NY, ny);
			raa.flode.set("2026-11-12", [flodePost(UUID.L2001_646, "L2001:646", ["UPPDATERAD_LAGE"]), flodePost(UUID.L2000_8802, "L2000:8802", ["UTGAR"]), flodePost(NY, "L2099:1", ["NY"])]);
			expect(await runSync(env, o(dagEfter(NU, 1)))).toMatchObject({ nya: 1, andrade: 1, borttagna: 1, status: "klar" });
			const efter = db.prepare("SELECT o.niva, o.namn FROM omrade o JOIN lamning_omrade lo ON lo.omrade_id = o.id JOIN lamning l ON l.id = lo.lamning_id WHERE l.uuid = ? ORDER BY o.niva").all(UUID.L2001_646);
			expect(efter).toContainEqual({ niva: "socken", namn: "Leksand" });
			expect(efter).toContainEqual({ niva: "kommun", namn: "Leksand" });
			expect(efter).not.toContainEqual({ niva: "socken", namn: "Bjursås" });
			expect(count(db, "SELECT count(*) AS n FROM lamning")).toBe(3);
			kontrolleraOmraden(db);
			// Bjursås och Falun (där lämningarna låg) har nu inga lämningar alls.
			expect(db.prepare("SELECT s.antal FROM omrade_sammanfattning s JOIN omrade o ON o.id = s.omrade_id WHERE o.niva = 'socken' AND o.namn = 'Bjursås'").get()).toEqual({ antal: 0 });
		} finally {
			db.close();
		}
	});
});

describe("mycket stora ändringsdagar", () => {
	it("fler sidor än FLODE_MAX_SIDOR: intervallet delas per dag och sidstorleken höjs, i stället för att synken kör fast", async () => {
		const db = emptyDb();
		try {
			const raa = fakeRaa();
			const mangd = (dag: string, n: number) => Array.from({ length: n }, (_, i) => flodePost(`00000000-0000-4000-8${dag.slice(-1)}00-${String(i).padStart(12, "0")}`, `L2099:${dag.slice(-2)}${i}`, ["UTGAR"]));
			raa.flode.set("2026-11-09", mangd("2026-11-09", 150));
			raa.flode.set("2026-11-10", mangd("2026-11-10", 150));
			raa.flode.set("2026-11-11", [flodePost(UUID.L2001_646, "L2001:646", ["NY"])]);
			db.prepare("INSERT INTO synk_status (nyckel, varde, andrad) VALUES ('senast_synkat', '2026-11-08', 't')").run();
			const env = { DB: openD1(db), SEMANTIC_LAN: "Dalarna" };
			// Sidstorlek 1: tre dagar ger 301 sidor, en dag 150 (inom gränsen).
			const o = { now: NU, fetch: raa.fetch, sleep: noSleep, pausMs: 0, sidstorlek: 1, maxPoster: 1000 };
			const r1 = await runSync(env, o);
			expect(r1.status).not.toBe("fel");
			expect(r1).toMatchObject({ fran: "2026-11-09", till: "2026-11-09", senast_synkat: "2026-11-09" });
			// En enda dag med fler sidor än gränsen: större sidor.
			raa.flode.set("2026-11-10", mangd("2026-11-10", 450));
			const r2 = await runSync(env, o);
			expect(r2.status).not.toBe("fel");
			expect(r2).toMatchObject({ fran: "2026-11-10", till: "2026-11-10", senast_synkat: "2026-11-10" });
			const storlekar = raa.calls.filter((u) => u.searchParams.get("from") === "2026-11-10" && u.searchParams.get("to") === "2026-11-10").map((u) => Number(u.searchParams.get("size")));
			expect(Math.max(...storlekar)).toBeGreaterThan(1);
			const r3 = await runSync(env, o);
			expect(r3).toMatchObject({ status: "klar", senast_synkat: "2026-11-11", nya: 1 });
		} finally {
			db.close();
		}
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
