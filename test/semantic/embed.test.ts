/**
 * Inbäddning och semantisk sökning med falska AI- och Vectorize-bindningar och
 * D1 ersatt av node:sqlite (migreringarna 0001 + 0002).
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODELL } from "../../src/semantic/bindings";
import { AI_BATCH, arTillfalligtAiFel, embedStatus, runEmbedBatch } from "../../src/semantic/embed";
import { createSemanticSearch, semanticSearch } from "../../src/semantic/search";
import { runSync } from "../../src/sync/run";
import { appFixture, emptyDb, fakeRaa, flodePost, openD1, UUID } from "../sync/helpers";
import { FakeAi, FakeVectorize } from "./fakes";

const STANDARDFRAS =
	"Beskrivningen är inte kvalitetssäkrad. Information kan saknas, vara felaktig eller inaktuell. Se även Inventeringsbok.";

let seq = 0;
let avstamningar = 0;
/** Som en avstämning med inläsningen: raderna ändras direkt och markören senaste_avstamning flyttas. */
function avstam(db: DatabaseSync): void {
	db.prepare("INSERT INTO synk_status (nyckel, varde, andrad) VALUES ('senaste_avstamning', ?, 't') ON CONFLICT(nyckel) DO UPDATE SET varde = excluded.varde").run(`2026-11-18T00:00:${String(++avstamningar).padStart(2, "0")}Z`);
}
function uuidN(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function insertLamning(
	db: DatabaseSync,
	o: {
		uuid: string;
		typ?: string;
		beskrivning?: string | null;
		tradition?: string | null;
		namn?: string | null;
		lan?: string[];
		kommun?: string[];
		socken?: string[];
		bedomning?: string;
	},
): void {
	seq++;
	db.prepare(
		"INSERT INTO lamning (uuid, lamningsnummer, lamningstyp, bedomning, beskrivning, tradition, namn, lat, lon, hash) VALUES (?, ?, ?, ?, ?, ?, ?, 60.6, 15.6, ?)",
	).run(
		o.uuid,
		`L2099:${seq}`,
		o.typ ?? "Fångstgrop",
		o.bedomning ?? "Fornlämning",
		o.beskrivning ?? null,
		o.tradition ?? null,
		o.namn ?? null,
		`h${seq}`,
	);
	const omr: Array<[string, string]> = [
		...(o.lan ?? ["Dalarna"]).map((n) => ["lan", n] as [string, string]),
		...(o.kommun ?? []).map((n) => ["kommun", n] as [string, string]),
		...(o.socken ?? []).map((n) => ["socken", n] as [string, string]),
	];
	for (const [niva, namn] of omr) {
		db.prepare("INSERT OR IGNORE INTO omrade (niva, namn, lan) VALUES (?, ?, '')").run(
			niva,
			namn,
		);
		db.prepare(
			"INSERT INTO lamning_omrade (omrade_id, lamning_id) SELECT o.id, l.id FROM omrade o, lamning l WHERE o.niva = ? AND o.namn = ? AND o.lan = '' AND l.uuid = ?",
		).run(niva, namn, o.uuid);
	}
}

describe("runEmbedBatch", () => {
	let db: DatabaseSync;
	let ai: FakeAi;
	let vec: FakeVectorize;
	const env = (lan = "Dalarna") => ({
		DB: openD1(db),
		AI: ai,
		VECTORIZE: vec,
		SEMANTIC_LAN: lan,
	});

	beforeEach(() => {
		db = emptyDb();
		ai = new FakeAi();
		vec = new FakeVectorize();
		seq = 0;
	});
	afterEach(() => db.close());

	it("felstavat eller tomt SEMANTIC_LAN: inbäddningen kastar och tar inte bort någon vektor", async () => {
		insertLamning(db, { uuid: uuidN(1), beskrivning: "Fångstgrop, 3 m i diameter." });
		await runEmbedBatch(env());
		const fore = vec.store.size;
		expect(fore).toBeGreaterThan(0);
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			for (const lan of ["Dalarn", " , ", "Dalarna,Atlantis"]) {
				await expect(runEmbedBatch(env(lan))).rejects.toThrow(/SEMANTIC_LAN/);
				expect(vec.store.size).toBe(fore);
			}
			expect(String(err.mock.calls[0][0])).toMatch(/Dalarn/);
		} finally {
			err.mockRestore();
		}
		expect((db.prepare("SELECT count(*) AS c FROM inbaddning").get() as { c: number }).c).toBe(1);
	});

	it("felstavat SEMANTIC_LAN i nattsynken: lämningarna skrivs men inget markeras, och felet syns", async () => {
		const raa = fakeRaa();
		raa.flode.set("2026-11-11", [flodePost(UUID.L2001_646, "L2001:646", ["NY"])]);
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const r = await runSync(
				{ DB: openD1(db), SEMANTIC_LAN: "Dalarn" },
				{ now: new Date("2026-11-12T04:00:00Z"), fetch: raa.fetch, sleep: async () => {}, pausMs: 0 },
			);
			expect(r.nya).toBe(1);
			expect(r.markerade).toBe(0);
			expect(r.fel.join(" ")).toMatch(/SEMANTIC_LAN innehåller län som inte gick att tolka: "Dalarn"/);
		} finally {
			err.mockRestore();
		}
		expect((db.prepare("SELECT count(*) AS c FROM inbaddning_ko").get() as { c: number }).c).toBe(0);
	});

	it("felstavat SEMANTIC_LAN under en period: ändringar och borttagningar då bäddas in när inställningen rättas", async () => {
		const raa = fakeRaa();
		raa.flode.set("2026-11-11", [flodePost(UUID.L2001_646, "L2001:646", ["NY"]), flodePost(UUID.L2000_8802, "L2000:8802", ["NY"])]);
		const o = (iso: string) => ({ now: new Date(iso), fetch: raa.fetch, sleep: async () => {}, pausMs: 0 });
		await runSync({ DB: openD1(db), SEMANTIC_LAN: "Dalarna" }, o("2026-11-12T04:00:00Z"));
		expect(await runEmbedBatch(env())).toMatchObject({ inbaddade: 2, klar: true });
		// Felperioden: en post ändras och en tas bort medan SEMANTIC_LAN är felstavat.
		const ny = appFixture(UUID.L2001_646);
		ny.beskrivning = "Offerkälla där man lagt mynt och nålar.";
		raa.app.set(UUID.L2001_646, ny);
		raa.flode.set("2026-11-12", [flodePost(UUID.L2001_646, "L2001:646", ["OVRIG_UPPDATERING"]), flodePost(UUID.L2000_8802, "L2000:8802", ["UTGAR"])]);
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const r = await runSync({ DB: openD1(db), SEMANTIC_LAN: "Dalarn" }, o("2026-11-13T04:00:00Z"));
			expect(r).toMatchObject({ andrade: 1, borttagna: 1, markerade: 0 });
		} finally {
			err.mockRestore();
		}
		// Rättat till samma värde som förut: inbäddningen får inte säga "klar" utan att söka.
		const e = await runEmbedBatch(env());
		expect(e).toMatchObject({ inbaddade: 1, borttagna: 1, klar: true });
		expect(vec.store.has(UUID.L2000_8802)).toBe(false);
		const hits = await semanticSearch(env(), "mynt nålar offerkälla", { kommun: ["Falun"] }, 5);
		expect(hits[0].uuid).toBe(UUID.L2001_646);
	});

	it("tillfälliga fel i Workers AI (5xx, tidsgräns, kvot) förbrukar inga försök och gör inte omfånget klart", async () => {
		insertLamning(db, { uuid: uuidN(1), beskrivning: "Kolbotten, rund, 12 m diam." });
		insertLamning(db, { uuid: uuidN(2), beskrivning: "Fångstgrop, rund, 3 m i diameter." });
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
			for (const msg of ["AiError: 3040: Capacity temporarily exceeded, please try again.", "InferenceUpstreamError: 502 Bad Gateway", "3007: Request timeout", timeout, "AiError: 3036: You have used up your daily free allocation of 10,000 neurons."]) {
				ai.run = async () => {
					throw typeof msg === "string" ? new Error(msg) : msg;
				};
				for (let k = 0; k < 4; k++) expect(await runEmbedBatch(env())).toMatchObject({ inbaddade: 0, klar: false });
			}
		} finally {
			err.mockRestore();
		}
		expect(db.prepare("SELECT count(*) AS n FROM inbaddning_fel").get()).toEqual({ n: 0 });
		ai = new FakeAi();
		expect(await runEmbedBatch(env())).toMatchObject({ inbaddade: 2, klar: true });
	});

	it("klassningen av fel: bara HTTP-status, kända felkoder och feltyper är tillfälliga; okända fel är textens", () => {
		const tillf = (x: unknown) => arTillfalligtAiFel(x);
		// Granskningens fall: tidigare tillfälliga (\b5\d\d\b, "upstream"), nu fel på texten.
		expect(tillf(new Error("Input text exceeds 512 tokens"))).toBe(false);
		expect(tillf(new Error("InferenceUpstreamError: bad input"))).toBe(false);
		expect(tillf(new Error("got 500 characters, expected at most 400"))).toBe(false);
		expect(tillf(new Error("AiError: 3006: Request is too large"))).toBe(false);
		expect(tillf(new Error("5004: Invalid data"))).toBe(false);
		expect(tillf(new Error("något helt okänt"))).toBe(false);
		// Tillfälliga.
		expect(tillf(new Error("3040: Capacity temporarily exceeded, please try again."))).toBe(true);
		expect(tillf(new Error("InferenceUpstreamError: 3008: Request was aborted"))).toBe(true);
		expect(tillf(new Error("InferenceUpstreamError: 503 Service Unavailable"))).toBe(true);
		expect(tillf(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
		expect(tillf(Object.assign(new Error("x"), { status: 400 }))).toBe(false);
		expect(tillf(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
		expect(tillf(new Error("Network connection lost."))).toBe(true);
	});

	it("en text som modellen avvisar med ett okänt fel isoleras genom halvering och bokförs", async () => {
		insertLamning(db, { uuid: uuidN(1), beskrivning: "Kolbotten, rund, 12 m diam." });
		insertLamning(db, { uuid: uuidN(2), beskrivning: "Fångstgrop, rund, 3 m i diameter. TRASIG" });
		insertLamning(db, { uuid: uuidN(3), beskrivning: "Röjningsröse, 2 m diam." });
		const inner = new FakeAi();
		ai.run = async (model: "@cf/baai/bge-m3", input: { text: string[] }) => {
			if (input.text.some((t) => t.includes("TRASIG"))) throw new Error("Input text exceeds 512 tokens");
			return inner.run(model, input as never);
		};
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const r = await runEmbedBatch(env());
			expect(r).toMatchObject({ inbaddade: 2, fel: 1 });
			expect(r.tillfalliga_fel ?? 0).toBe(0);
		} finally {
			err.mockRestore();
		}
		expect(db.prepare("SELECT uuid, forsok FROM inbaddning_fel").all()).toEqual([{ uuid: uuidN(2), forsok: 1 }]);
	});

	it("bäddar in lämningar inom omfånget efter nattsynken, i delar som kan återupptas", async () => {
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

		const a = await runEmbedBatch(env(), { max: 1 });
		expect(a).toMatchObject({ inbaddade: 1, klar: false });
		const b = await runEmbedBatch(env(), { max: 1 });
		expect(b).toMatchObject({ inbaddade: 1 });
		const c = await runEmbedBatch(env(), { max: 10 });
		expect(c).toMatchObject({ inbaddade: 0, klar: true });
		// Bara Dalarna: Stugun (Jämtland) bäddas inte in.
		expect([...vec.store.keys()].sort()).toEqual([UUID.L2000_8802, UUID.L2001_646].sort());
		expect(vec.store.get(UUID.L2001_646)?.metadata).toMatchObject({
			uuid: UUID.L2001_646,
			lamningsnummer: "L2001:646",
			typ: "Källa med tradition",
			bedomning: "Övrig kulturhistorisk lämning",
			lan: "Dalarna",
			kommun: "Falun",
			socken: "Bjursås",
			landskap: "Dalarna",
		});
		expect(db.prepare("SELECT count(*) AS n FROM inbaddning_ko").get()).toEqual({ n: 0 });
		expect(await embedStatus(env())).toEqual({ iOmfang: 2, bokforda: 2, aterstar: 0, ko: 0 });

		// Semantisk sökning hittar källan med traditionstext.
		const hits = await semanticSearch(env(), "önskekälla", { kommun: ["Falun"] }, 5);
		expect(hits[0].uuid).toBe(UUID.L2001_646);
	});

	it("batchar anropen till Workers AI", async () => {
		for (let i = 1; i <= 120; i++)
			insertLamning(db, {
				uuid: uuidN(i),
				beskrivning: `Fångstgrop nummer ${i}, rund, 3 m diameter och 1 m djup.`,
			});
		const r = await runEmbedBatch(env(), { max: 1000 });
		expect(r).toMatchObject({ inbaddade: 120, vektorer: 120, klar: true });
		expect(ai.calls.map((c) => c.length)).toEqual([AI_BATCH, AI_BATCH, 20]);
		// En körning till gör ingenting.
		ai.calls = [];
		expect(await runEmbedBatch(env(), { max: 1000 })).toMatchObject({
			inbaddade: 0,
			oforandrade: 0,
			klar: true,
		});
		expect(ai.calls).toEqual([]);
	});

	it("tar bort standardfrasen och hoppar över lämningar utan meningsfull text", async () => {
		insertLamning(db, { uuid: uuidN(1), beskrivning: STANDARDFRAS });
		insertLamning(db, {
			uuid: uuidN(2),
			beskrivning: `Kolbotten, rund, 12 m diam. ${STANDARDFRAS}`,
		});
		const r = await runEmbedBatch(env());
		expect(r).toMatchObject({ inbaddade: 1, tomma: 1 });
		expect(ai.calls.flat()).toEqual(["Fångstgrop. Kolbotten, rund, 12 m diam."]);
		expect(
			db.prepare("SELECT uuid, status, vektorer FROM inbaddning ORDER BY uuid").all(),
		).toEqual([
			{ uuid: uuidN(1), status: "tom", vektorer: 0 },
			{ uuid: uuidN(2), status: "ok", vektorer: 1 },
		]);
	});

	it("en vektor per kombination när lämningen ligger i flera socknar; träffarna slås ihop", async () => {
		insertLamning(db, {
			uuid: uuidN(1),
			beskrivning: "Gränsröse mellan två socknar, kallat Trehörningen.",
			kommun: ["Falun"],
			socken: ["Bjursås", "Sundborn"],
		});
		insertLamning(db, {
			uuid: uuidN(2),
			beskrivning: "Gränsröse vid vägen.",
			kommun: ["Falun"],
			socken: ["Bjursås"],
		});
		await runEmbedBatch(env());
		expect(vec.store.has(uuidN(1))).toBe(true);
		expect(vec.store.get(`${uuidN(1)}#1`)?.metadata.socken).toBe("Sundborn");
		expect(db.prepare("SELECT vektorer FROM inbaddning WHERE uuid = ?").get(uuidN(1))).toEqual({
			vektorer: 2,
		});

		const s = await semanticSearch(env(), "gränsröse", { socken: [{ namn: "Sundborn" }] }, 10);
		expect(s.map((h) => h.uuid)).toEqual([uuidN(1)]);
		const all = await semanticSearch(
			env(),
			"gränsröse Trehörningen",
			{ kommun: ["Falun"] },
			10,
		);
		expect(all.map((h) => h.uuid)).toEqual([uuidN(1), uuidN(2)]); // en gång var, trots två vektorer
		expect(vec.queries.at(-1)?.filter).toEqual({ kommun: "Falun" });

		// Lämnar ena socknen: överskottsvektorn tas bort.
		db.exec(
			`DELETE FROM lamning_omrade WHERE lamning_id = (SELECT id FROM lamning WHERE uuid = '${uuidN(1)}') AND omrade_id = (SELECT id FROM omrade WHERE niva = 'socken' AND namn = 'Sundborn')`,
		);
		db.exec(`UPDATE lamning SET hash = 'ny' WHERE uuid = '${uuidN(1)}'`);
		avstam(db);
		const r = await runEmbedBatch(env());
		expect(r.inbaddade).toBe(1);
		expect(vec.store.has(`${uuidN(1)}#1`)).toBe(false);
	});

	it("ändrad rad bäddas om bara när text eller metadata ändrats", async () => {
		insertLamning(db, { uuid: uuidN(1), beskrivning: "Kolbotten, rund, 12 m diam." });
		await runEmbedBatch(env());
		ai.calls = [];
		// Ny radhash (t.ex. efter avstämningen) men samma text: ingen ny inbäddning.
		db.exec(`UPDATE lamning SET hash = 'avstamd', lat = 61 WHERE uuid = '${uuidN(1)}'`);
		avstam(db);
		expect(await runEmbedBatch(env())).toMatchObject({ inbaddade: 0, oforandrade: 1 });
		expect(ai.calls).toEqual([]);
		// Ändrad text: ny inbäddning.
		db.exec(
			`UPDATE lamning SET hash = 'ny', beskrivning = 'Kolbotten, oval, 14 m lång.' WHERE uuid = '${uuidN(1)}'`,
		);
		avstam(db);
		expect(await runEmbedBatch(env())).toMatchObject({ inbaddade: 1 });
		// Ändrad bedömning (metadata): ny inbäddning.
		db.exec(
			`UPDATE lamning SET hash = 'ny2', bedomning = 'Övrig kulturhistorisk lämning' WHERE uuid = '${uuidN(1)}'`,
		);
		avstam(db);
		expect(await runEmbedBatch(env())).toMatchObject({ inbaddade: 1 });
		expect(vec.store.get(uuidN(1))?.metadata.bedomning).toBe("Övrig kulturhistorisk lämning");
		// Annan modell i bokföringen: allt bäddas om.
		db.exec("UPDATE inbaddning SET modell = '@cf/annan/modell'");
		avstam(db);
		expect(await runEmbedBatch(env())).toMatchObject({ inbaddade: 1 });
		expect(db.prepare("SELECT modell FROM inbaddning").get()).toEqual({ modell: MODELL });
	});

	it("tar bort vektorer för utgångna lämningar och lämningar utanför omfånget", async () => {
		insertLamning(db, { uuid: uuidN(1), beskrivning: "Kolbotten, rund, 12 m diam." });
		insertLamning(db, {
			uuid: uuidN(2),
			beskrivning: "Fäbodlämning med fem husgrunder.",
			socken: ["Bjursås", "Sundborn"],
		});
		insertLamning(db, { uuid: uuidN(3), beskrivning: "Tjärdal, 10 m lång." });
		await runEmbedBatch(env());
		expect(vec.store.size).toBe(4);

		// Utgången (som nattsynken gör: raden bort + markering i kön).
		db.exec(`DELETE FROM lamning WHERE uuid = '${uuidN(2)}'`);
		db.exec(
			`INSERT INTO inbaddning_ko (uuid, orsak, lagd) VALUES ('${uuidN(2)}', 'utgar', 't')`,
		);
		// Utanför omfånget utan markering (t.ex. avstämningen): hittas av genomsökningen.
		db.exec(`UPDATE omrade SET namn = 'Gävleborg' WHERE niva = 'lan'`);
		insertLamning(db, {
			uuid: uuidN(4),
			beskrivning: "Kolbotten i Dalarna.",
			lan: ["Dalarna"],
		});

		const r = await runEmbedBatch(env());
		expect(r).toMatchObject({ borttagna: 3, inbaddade: 1 });
		expect([...vec.store.keys()]).toEqual([uuidN(4)]);
		expect(vec.deletes.sort()).toEqual([uuidN(1), uuidN(2), `${uuidN(2)}#1`, uuidN(3)].sort());
		expect(db.prepare("SELECT uuid FROM inbaddning").all()).toEqual([{ uuid: uuidN(4) }]);
	});

	it("Workers AI fallerar för en lämning: felet bokförs, inget bäddas in, nästa körning försöker igen", async () => {
		insertLamning(db, { uuid: uuidN(1), beskrivning: "Kolbotten, rund, 12 m diam." });
		ai.fail = true;
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(await runEmbedBatch(env())).toMatchObject({ inbaddade: 0, fel: 1 });
		} finally {
			err.mockRestore();
		}
		expect(db.prepare("SELECT count(*) AS n FROM inbaddning").get()).toEqual({ n: 0 });
		expect(db.prepare("SELECT forsok FROM inbaddning_fel").get()).toEqual({ forsok: 1 });
		ai.fail = false;
		expect(await runEmbedBatch(env())).toMatchObject({ inbaddade: 1, klar: true });
	});

	it("en text som modellen avvisar blockerar inte resten: delen halveras, posten hoppas över efter tre försök", async () => {
		for (let i = 1; i <= 60; i++) insertLamning(db, { uuid: uuidN(i), beskrivning: i === 7 ? "TRASIG beskrivning av en fångstgrop, rund, 3 m i diameter." : `Fångstgrop nummer ${i}, rund, 3 m i diameter.` });
		ai.failIf = (t) => t.includes("TRASIG");
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const a = await runEmbedBatch(env());
			expect(a).toMatchObject({ inbaddade: 59, fel: 1, klar: false });
			await runEmbedBatch(env());
			await runEmbedBatch(env());
			expect(db.prepare("SELECT forsok FROM inbaddning_fel WHERE uuid = ?").get(uuidN(7))).toEqual({ forsok: 3 });
			// Fjärde körningen: hoppas över, inget AI-anrop, och omfånget räknas som klart.
			const anrop = ai.calls.length;
			expect(await runEmbedBatch(env())).toMatchObject({ inbaddade: 0, klar: true });
			expect(ai.calls.length).toBe(anrop);
			expect(String(err.mock.calls[0][0])).toMatch(/Workers AI fallerade för 50 texter/);
		} finally {
			err.mockRestore();
			warn.mockRestore();
		}
		expect(vec.store.size).toBeGreaterThanOrEqual(59);
	});

	it("Workers AI helt nere: körningen ger upp efter ett begränsat antal anrop", async () => {
		for (let i = 1; i <= 120; i++) insertLamning(db, { uuid: uuidN(i), beskrivning: `Fångstgrop nummer ${i}, rund, 3 m i diameter.` });
		ai.fail = true;
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(runEmbedBatch(env())).rejects.toThrow(/fallerade 12 gånger i körningen/);
		} finally {
			err.mockRestore();
		}
		expect(db.prepare("SELECT count(*) AS n FROM inbaddning").get()).toEqual({ n: 0 });
	});

	it("oväntad svarsform från Workers AI: felet beskriver formen, inte innehållet", async () => {
		const { vektorerUrSvar, svaretsForm } = await import("../../src/semantic/bindings");
		expect(svaretsForm({ shape: [2, 1024], data: [[0.1, 0.2]] })).toBe("{shape: array(2)<number>, data: array(1)<array(2)>}");
		expect(() => vektorerUrSvar({ response: [[1, 2]] }, 1)).toThrow(/svarets form: \{response: array\(1\)<array\(2\)>\}/);
		expect(() => vektorerUrSvar({ data: "hemligt innehåll" }, 1)).toThrow(/svarets form: \{data: string\}/);
	});

	it("färdiginbäddat och oförändrat: nästa körning gör inga genomsökningar av omfånget", async () => {
		insertLamning(db, { uuid: uuidN(1), beskrivning: "Kolbotten, rund, 12 m diam." });
		expect(await runEmbedBatch(env())).toMatchObject({ klar: true });
		const { d1FromSqlite } = await import("../store/d1-adapter");
		const sql: string[] = [];
		const logged = { DB: d1FromSqlite(db, (q) => sql.push(q)), AI: ai, VECTORIZE: vec, SEMANTIC_LAN: "Dalarna" };
		expect(await runEmbedBatch(logged)).toMatchObject({ klar: true, inbaddade: 0 });
		expect(sql.some((q) => q.includes("FROM lamning l"))).toBe(false);
		// En ny avstämning gör att omfånget gås igenom igen.
		avstam(db);
		sql.length = 0;
		await runEmbedBatch(logged);
		expect(sql.some((q) => q.includes("FROM lamning l"))).toBe(true);
	});

	it("kräver bindningarna", async () => {
		await expect(runEmbedBatch({ DB: openD1(db) })).rejects.toThrow(/AI och VECTORIZE/);
	});
});

describe("semanticSearch och createSemanticSearch", () => {
	it("topK begränsas till 100 och frågan skickas till samma modell", async () => {
		const ai = new FakeAi();
		const vec = new FakeVectorize();
		await semanticSearch({ AI: ai, VECTORIZE: vec }, "  offerkälla  ", {}, 500);
		expect(ai.calls).toEqual([["offerkälla"]]);
		expect(vec.queries[0].topK).toBe(100);
	});

	it("utan bindningar ingen semantisk kanal", () => {
		expect(createSemanticSearch({})).toBeNull();
		const s = createSemanticSearch({
			AI: new FakeAi(),
			VECTORIZE: new FakeVectorize(),
			SEMANTIC_LAN: "Dalarna, Gävleborg",
		});
		expect(s?.omfang).toBe("Dalarnas och Gävleborgs län");
		expect(s?.scopeCovers({ lan: ["Gävleborg"] })).toBe(true);
		expect(s?.scopeCovers({})).toBe(false);
	});
});
