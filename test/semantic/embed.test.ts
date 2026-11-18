/**
 * Inbäddning och semantisk sökning med falska AI- och Vectorize-bindningar och
 * D1 ersatt av node:sqlite (migreringarna 0001 + 0002).
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODELL } from "../../src/semantic/bindings";
import { AI_BATCH, arIndatafel, arTillfalligtAiFel, BELAGG_ANNAN_LYCKADES, BELAGG_INDATAFEL, BELAGG_TILLFALLIGT, embedStatus, KONTROLLTEXT, runEmbedBatch } from "../../src/semantic/embed";
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

	it("tillfälliga fel i Workers AI (5xx, tidsgräns, kvot) för allt: avbrott, inga försök förbrukas, omfånget blir inte klart", async () => {
		insertLamning(db, { uuid: uuidN(1), beskrivning: "Kolbotten, rund, 12 m diam." });
		insertLamning(db, { uuid: uuidN(2), beskrivning: "Fångstgrop, rund, 3 m i diameter." });
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
			for (const msg of ["AiError: 3040: Capacity temporarily exceeded, please try again.", "InferenceUpstreamError: 502 Bad Gateway", "3007: Request timeout", timeout, "AiError: 3036: You have used up your daily free allocation of 10,000 neurons."]) {
				ai.run = async () => {
					throw typeof msg === "string" ? new Error(msg) : msg;
				};
				for (let k = 0; k < 4; k++) await expect(runEmbedBatch(env())).rejects.toThrow(/avbrott/);
			}
		} finally {
			err.mockRestore();
		}
		expect(db.prepare("SELECT count(*) AS n FROM inbaddning_fel").get()).toEqual({ n: 0 });
		expect(db.prepare("SELECT count(*) AS n FROM synk_status WHERE nyckel = 'inbaddning_klar'").get()).toEqual({ n: 0 });
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

	it("en ensam lämning vars text fallerar när bara kontrolltexten går igenom: avbrott, inget bokförs (kontrolltexten är inget belägg)", async () => {
		insertLamning(db, { uuid: uuidN(1), beskrivning: "Kolbotten, rund, 12 m diam." });
		ai.failIf = (t) => t.includes("Kolbotten");
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			for (let k = 0; k < 4; k++) await expect(runEmbedBatch(env())).rejects.toThrow(/delvis avbrott.*kontrolltexten gick igenom, men den räknas inte som belägg/);
			expect(String(warn.mock.calls[0][0])).toMatch(/kontrolltexten gick igenom men verkliga texter fallerar/);
		} finally {
			err.mockRestore();
			warn.mockRestore();
		}
		expect(ai.calls).toEqual([[KONTROLLTEXT], [KONTROLLTEXT], [KONTROLLTEXT], [KONTROLLTEXT]]);
		expect(db.prepare("SELECT count(*) AS n FROM inbaddning_fel").get()).toEqual({ n: 0 });
		ai.failIf = undefined;
		expect(await runEmbedBatch(env())).toMatchObject({ inbaddade: 1, klar: true });
	});

	it("en ensam lämning vars text fallerar medan en verklig text (referenstexten) går igenom: bokförs med belägg efter två försök, nästa körning försöker igen", async () => {
		insertLamning(db, { uuid: uuidN(1), beskrivning: "Fångstgrop, rund, 3 m i diameter." });
		expect(await runEmbedBatch(env())).toMatchObject({ inbaddade: 1, klar: true });
		insertLamning(db, { uuid: uuidN(2), beskrivning: "Kolbotten, rund, 12 m diam." });
		avstam(db);
		const anrop: string[][] = [];
		const inner = new FakeAi();
		ai.run = async (model: "@cf/baai/bge-m3", input: { text: string[] }) => {
			anrop.push(input.text);
			if (input.text.some((t) => t.includes("Kolbotten"))) throw new Error("InferenceUpstreamError: Unknown internal error");
			return inner.run(model, input as never);
		};
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(await runEmbedBatch(env())).toMatchObject({ inbaddade: 0, fel: 1, klar: false });
		} finally {
			err.mockRestore();
		}
		const ref = "Fångstgrop. Fångstgrop, rund, 3 m i diameter.";
		const kol = "Fångstgrop. Kolbotten, rund, 12 m diam.";
		// Texten, referenstexten (en verklig text: tjänsten fungerar), texten igen, referenstexten efter det.
		expect(anrop).toEqual([[kol], [ref], [kol], [ref]]);
		const rad = db.prepare("SELECT forsok, senaste_fel FROM inbaddning_fel").get() as { forsok: number; senaste_fel: string };
		expect(rad.forsok).toBe(1);
		expect(rad.senaste_fel).toBe(`${BELAGG_ANNAN_LYCKADES}InferenceUpstreamError: Unknown internal error`);
		ai = new FakeAi();
		expect(await runEmbedBatch(env())).toMatchObject({ inbaddade: 1, klar: true });
		// Lyckad inbäddning tar bort felraden.
		expect(db.prepare("SELECT count(*) AS n FROM inbaddning_fel").get()).toEqual({ n: 0 });
	});

	it("avbrott med okänt felmeddelande (granskningens fall, högst 6 texter): inget bokförs, inget försök förbrukas, inte klart; allt bäddas in när AI fungerar igen", async () => {
		for (let i = 1; i <= 6; i++) insertLamning(db, { uuid: uuidN(i), beskrivning: `Fångstgrop nummer ${i}, rund, 3 m i diameter.` });
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			ai.run = async () => {
				throw new Error("InferenceUpstreamError: backend returned an unexpected response");
			};
			for (let k = 0; k < 5; k++) await expect(runEmbedBatch(env())).rejects.toThrow(/avbrott/);
			expect(db.prepare("SELECT count(*) AS n FROM inbaddning_fel").get()).toEqual({ n: 0 });
			expect(db.prepare("SELECT count(*) AS n FROM synk_status WHERE nyckel = 'inbaddning_klar'").get()).toEqual({ n: 0 });
		} finally {
			err.mockRestore();
			warn.mockRestore();
		}
		ai = new FakeAi();
		expect(await runEmbedBatch(env())).toMatchObject({ inbaddade: 6, klar: true });
		expect(vec.store.size).toBe(6);
	});

	it("avbrott med okänt felmeddelande och fler än 6 texter: få anrop, inget bokförs", async () => {
		for (let i = 1; i <= 30; i++) insertLamning(db, { uuid: uuidN(i), beskrivning: `Fångstgrop nummer ${i}, rund, 3 m i diameter.` });
		let anrop = 0;
		ai.run = async () => {
			anrop++;
			throw new Error("InferenceUpstreamError: backend returned an unexpected response");
		};
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			for (let k = 0; k < 3; k++) await expect(runEmbedBatch(env())).rejects.toThrow(/avbrott/);
		} finally {
			err.mockRestore();
		}
		// Ett anrop med delen och ett med kontrolltexten per körning.
		expect(anrop).toBe(6);
		expect(db.prepare("SELECT count(*) AS n FROM inbaddning_fel").get()).toEqual({ n: 0 });
	});

	it("ett entydigt indatafel (3006, för stor) bokförs även när inget annat lyckas", async () => {
		insertLamning(db, { uuid: uuidN(1), beskrivning: "Kolbotten, rund, 12 m diam." });
		ai.run = async () => {
			throw new Error("AiError: 3006: Request is too large");
		};
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(await runEmbedBatch(env())).toMatchObject({ fel: 1, klar: false });
		} finally {
			err.mockRestore();
		}
		const rad = db.prepare("SELECT forsok, senaste_fel FROM inbaddning_fel").get() as { forsok: number; senaste_fel: string };
		expect(rad.forsok).toBe(1);
		expect(rad.senaste_fel.startsWith(BELAGG_INDATAFEL)).toBe(true);
		expect(arIndatafel(new Error("AiError: 3006: Request is too large"))).toBe(true);
		expect(arIndatafel(Object.assign(new Error("x"), { status: 413 }))).toBe(true);
		expect(arIndatafel(new Error("5004: Invalid data"))).toBe(false);
		expect(arIndatafel(new Error("InferenceUpstreamError: backend returned an unexpected response"))).toBe(false);
	});

	it("överhoppad lämning prövas igen efter sju dygn, även om raden inte ändrats och omfånget är klart", async () => {
		insertLamning(db, { uuid: uuidN(1), beskrivning: "TRASIG kolbotten." });
		insertLamning(db, { uuid: uuidN(2), beskrivning: "Fångstgrop, rund." });
		ai.failIf = (t) => t.includes("TRASIG");
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const dag = (d: number) => ({ now: new Date(Date.UTC(2026, 10, 1 + d, 4)) });
		try {
			for (let k = 0; k < 3; k++) await runEmbedBatch(env(), dag(0));
			expect(db.prepare("SELECT forsok FROM inbaddning_fel").get()).toEqual({ forsok: 3 });
			expect(await runEmbedBatch(env(), dag(1))).toMatchObject({ klar: true, inbaddade: 0 });
			expect(await runEmbedBatch(env(), dag(6))).toMatchObject({ klar: true, inbaddade: 0 });
			ai.failIf = undefined;
			expect(await runEmbedBatch(env(), dag(6))).toMatchObject({ klar: true, inbaddade: 0 });
			// Sju dygn efter senaste försöket: prövas igen och lyckas.
			expect(await runEmbedBatch(env(), dag(7))).toMatchObject({ inbaddade: 1, klar: true });
		} finally {
			err.mockRestore();
			warn.mockRestore();
		}
		expect(vec.store.has(uuidN(1))).toBe(true);
	});

	it("engångsrensning: överhoppningar utan belägg (från före rättningen) tas bort och prövas igen; indatafel och nya rader står kvar", async () => {
		insertLamning(db, { uuid: uuidN(1), beskrivning: "Kolbotten, rund, 12 m diam." });
		insertLamning(db, { uuid: uuidN(2), beskrivning: "Fångstgrop, rund." });
		insertLamning(db, { uuid: uuidN(3), beskrivning: "Röjningsröse." });
		insertLamning(db, { uuid: uuidN(4), beskrivning: "Tjärdal, 10 m lång och 3 m bred." });
		const h = (u: string) => (db.prepare("SELECT hash FROM lamning WHERE uuid = ?").get(u) as { hash: string }).hash;
		const ins = db.prepare("INSERT INTO inbaddning_fel (uuid, rad_hash, forsok, senaste_fel, andrad) VALUES (?, ?, 3, ?, ?)");
		const nu = new Date().toISOString();
		ins.run(uuidN(1), h(uuidN(1)), "InferenceUpstreamError: backend returned an unexpected response", nu);
		ins.run(uuidN(2), h(uuidN(2)), "AiError: 3006: Request is too large", nu);
		ins.run(uuidN(3), h(uuidN(3)), `${BELAGG_ANNAN_LYCKADES}AiError: 3010: Invalid input`, nu);
		// Omfånget markerat klart av den gamla logiken.
		db.prepare("INSERT INTO synk_status (nyckel, varde, andrad) VALUES ('inbaddning_klar', 'gammal', 't')").run();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const r = await runEmbedBatch(env());
			expect(r).toMatchObject({ inbaddade: 2, klar: true });
			expect(vec.store.has(uuidN(1))).toBe(true);
			expect(db.prepare("SELECT uuid FROM inbaddning_fel ORDER BY uuid").all()).toEqual([{ uuid: uuidN(2) }, { uuid: uuidN(3) }]);
			// Idempotent: en ny rad utan belägg rensas inte en gång till.
			ins.run(uuidN(4), "annan", "okänt", nu);
			await runEmbedBatch(env());
			expect((db.prepare("SELECT count(*) AS n FROM inbaddning_fel").get() as { n: number }).n).toBe(3);
		} finally {
			warn.mockRestore();
		}
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

	it("Workers AI helt nere: körningen ger upp efter två anrop (delen och kontrolltexten) utan att bokföra något", async () => {
		for (let i = 1; i <= 120; i++) insertLamning(db, { uuid: uuidN(i), beskrivning: `Fångstgrop nummer ${i}, rund, 3 m i diameter.` });
		ai.fail = true;
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(runEmbedBatch(env())).rejects.toThrow(/avbrott/);
			expect(err.mock.calls.length).toBe(2);
		} finally {
			err.mockRestore();
		}
		expect(db.prepare("SELECT count(*) AS n FROM inbaddning").get()).toEqual({ n: 0 });
		expect(db.prepare("SELECT count(*) AS n FROM inbaddning_fel").get()).toEqual({ n: 0 });
	});

	it("tillfälliga fel i många delar: körningen ger upp efter två anrop (delen och kontrolltexten)", async () => {
		for (let i = 1; i <= 700; i++) insertLamning(db, { uuid: uuidN(i), beskrivning: `Fångstgrop nummer ${i}, rund, 3 m i diameter.` });
		let anrop = 0;
		ai.run = async () => {
			anrop++;
			throw new Error("InferenceUpstreamError: 503 Service Unavailable");
		};
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(runEmbedBatch(env())).rejects.toThrow(/både texterna och kontrolltexten fallerade/);
		} finally {
			err.mockRestore();
		}
		expect(anrop).toBe(2);
		expect(db.prepare("SELECT count(*) AS n FROM inbaddning_fel").get()).toEqual({ n: 0 });
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

	// ------------------------------------------------ beslutsregeln för fel i Workers AI (en gren per test)

	/** Styrd AI: `fel(texter, n)` ger ett fel att kasta för anrop nummer n (alla anrop räknas), annars null. */
	function styrdAi(fel: (texter: string[], n: number) => Error | null): string[][] {
		const anrop: string[][] = [];
		const inner = new FakeAi();
		ai.run = async (model: "@cf/baai/bge-m3", input: { text: string[] }) => {
			anrop.push(input.text);
			const f = fel(input.text, anrop.length);
			if (f) throw f;
			return inner.run(model, input as never);
		};
		return anrop;
	}
	const tyst = () => {
		const e = vi.spyOn(console, "error").mockImplementation(() => {});
		const w = vi.spyOn(console, "warn").mockImplementation(() => {});
		return () => {
			e.mockRestore();
			w.mockRestore();
		};
	};
	const felrader = () => db.prepare("SELECT uuid, forsok, senaste_fel FROM inbaddning_fel ORDER BY uuid").all() as Array<{ uuid: string; forsok: number; senaste_fel: string }>;
	const lamningar = (n: number, text = (i: number) => `Fångstgrop nummer ${i}, rund, 3 m i diameter.`) => {
		for (let i = 1; i <= n; i++) insertLamning(db, { uuid: uuidN(i), beskrivning: text(i) });
	};

	it("regeln, allt lyckas: inga felrader, ingen kontrolltext", async () => {
		lamningar(120);
		const anrop = styrdAi(() => null);
		expect(await runEmbedBatch(env())).toMatchObject({ inbaddade: 120, klar: true });
		expect(anrop.map((a) => a.length)).toEqual([50, 50, 20]);
		expect(felrader()).toEqual([]);
	});

	it("regeln, en text ger okänt fel: friska texter bäddas in, texten prövas ensam två gånger och bokförs med belägg", async () => {
		lamningar(120, (i) => (i === 64 ? "TRASIG fångstgrop." : `Fångstgrop nummer ${i}, rund, 3 m i diameter.`));
		const anrop = styrdAi((t) => (t.some((x) => x.includes("TRASIG")) ? new Error("InferenceUpstreamError: Unknown internal error") : null));
		const atersta = tyst();
		try {
			expect(await runEmbedBatch(env())).toMatchObject({ inbaddade: 119, fel: 1, klar: false });
		} finally {
			atersta();
		}
		expect(anrop.filter((a) => a.length === 1 && a[0].includes("TRASIG"))).toHaveLength(2);
		expect(anrop.flat()).not.toContain(KONTROLLTEXT);
		expect(felrader()).toEqual([{ uuid: uuidN(64), forsok: 1, senaste_fel: `${BELAGG_ANNAN_LYCKADES}InferenceUpstreamError: Unknown internal error` }]);
	});

	it("regeln, en text ger \"tillfälligt\" fel varje gång (granskningens 503-fall): friska texter kommer igenom, texten prövas en gång per dygn och hoppas över efter tre dygn", async () => {
		lamningar(120, (i) => (i === 7 ? "SJUK fångstgrop." : `Fångstgrop nummer ${i}, rund, 3 m i diameter.`));
		let sjuk = true;
		const anrop = styrdAi((t) => (sjuk && t.some((x) => x.includes("SJUK")) ? new Error("InferenceUpstreamError: 503 Service Unavailable") : null));
		const tidpunkt = (d: number, h = 4, m = 0) => ({ now: new Date(Date.UTC(2026, 10, 1 + d, h, m)) });
		const atersta = tyst();
		try {
			// Dygn 0: alla friska bäddas in i första körningen (tidigare: 70, sedan 0 i varje körning).
			expect(await runEmbedBatch(env(), tidpunkt(0))).toMatchObject({ inbaddade: 119, fel: 1, klar: false });
			expect(felrader()).toEqual([{ uuid: uuidN(7), forsok: 1, senaste_fel: `${BELAGG_TILLFALLIGT}InferenceUpstreamError: 503 Service Unavailable` }]);
			// Samma dygn: texten vilar; inga anrop, och omfånget är klart.
			let n = anrop.length;
			expect(await runEmbedBatch(env(), tidpunkt(0, 4, 15))).toMatchObject({ inbaddade: 0, klar: true });
			expect(await runEmbedBatch(env(), tidpunkt(0, 23, 45))).toMatchObject({ inbaddade: 0, klar: true });
			expect(anrop.length).toBe(n);
			// Dygn 1 och 2: ett nytt försök per dygn (texten, referenstexten, texten, referenstexten).
			for (const [d, forsok] of [[1, 2], [2, 3]] as const) {
				n = anrop.length;
				expect(await runEmbedBatch(env(), tidpunkt(d))).toMatchObject({ inbaddade: 0, fel: 1, klar: false });
				expect(anrop.length - n).toBe(4);
				expect(await runEmbedBatch(env(), tidpunkt(d, 4, 15))).toMatchObject({ klar: true });
				expect(felrader()[0].forsok).toBe(forsok);
			}
			// Dygn 3–8: överhoppad (tre försök på olika dygn), inga anrop.
			n = anrop.length;
			for (const d of [3, 5, 8]) expect(await runEmbedBatch(env(), tidpunkt(d))).toMatchObject({ inbaddade: 0, klar: true });
			expect(anrop.length).toBe(n);
			// Sju dygn efter senaste försöket prövas den igen; nu fungerar den.
			sjuk = false;
			expect(await runEmbedBatch(env(), tidpunkt(9))).toMatchObject({ inbaddade: 1, klar: true });
		} finally {
			atersta();
		}
		expect(vec.store.size).toBe(120);
		expect(felrader()).toEqual([]);
	});

	it("regeln, allt fallerar med okänt fel (även kontrolltexten): avbrott efter två anrop, inget bokförs", async () => {
		lamningar(120);
		const anrop = styrdAi(() => new Error("InferenceUpstreamError: Unknown internal error"));
		const atersta = tyst();
		try {
			for (let k = 0; k < 3; k++) await expect(runEmbedBatch(env())).rejects.toThrow(/avbrott/);
		} finally {
			atersta();
		}
		expect(anrop.length).toBe(6);
		expect(felrader()).toEqual([]);
	});

	it("regeln, kontrolltexten lyckas men alla verkliga texter fallerar (granskningens fall, 1 500 lämningar): delvis avbrott efter nio anrop, inget bokförs, inget hoppas över", async () => {
		lamningar(1500);
		const anrop = styrdAi((t) => (t.length === 1 && t[0] === KONTROLLTEXT ? null : new Error("InferenceUpstreamError: Unknown internal error")));
		const atersta = tyst();
		try {
			for (let k = 0; k < 4; k++) {
				const n = anrop.length;
				await expect(runEmbedBatch(env())).rejects.toThrow(/8 anrop i följd fallerade utan att någon verklig text lyckades emellan \(kontrolltexten gick igenom, men den räknas inte som belägg\); inget bokfört/);
				// Åtta delar och kontrolltexten (tidigare 49 anrop och 22 bokförda per körning).
				expect(anrop.length - n).toBe(9);
				expect(felrader()).toEqual([]);
			}
		} finally {
			atersta();
		}
		ai = new FakeAi();
		expect(await runEmbedBatch(env(), { max: 1500 })).toMatchObject({ inbaddade: 1500, klar: true });
	});

	it("regeln, verkliga texter fallerar och en redan inbäddad lämning finns: referenstexten fallerar också, avbrott efter två anrop", async () => {
		lamningar(1);
		await runEmbedBatch(env());
		for (let i = 2; i <= 31; i++) insertLamning(db, { uuid: uuidN(i), beskrivning: `Kolbotten nummer ${i}.` });
		avstam(db);
		const anrop = styrdAi((t) => (t.length === 1 && t[0] === KONTROLLTEXT ? null : new Error("InferenceUpstreamError: Unknown internal error")));
		const atersta = tyst();
		try {
			await expect(runEmbedBatch(env())).rejects.toThrow(/referenstexten, en redan inbäddad lämning, fallerade också; inget bokfört/);
		} finally {
			atersta();
		}
		expect(anrop.map((a) => a.length)).toEqual([30, 1]);
		expect(anrop[1][0]).toMatch(/Fångstgrop nummer 1/);
		expect(felrader()).toEqual([]);
	});

	it("regeln, tjänsten återhämtar sig mitt i en körning: texter som fallerade under avbrottet bäddas in i andra försöket, inget bokförs", async () => {
		lamningar(3);
		let verkliga = 0;
		const anrop = styrdAi((t) => (t[0] !== KONTROLLTEXT && ++verkliga <= 4 ? new Error("InferenceUpstreamError: Unknown internal error") : null));
		const atersta = tyst();
		try {
			const r = await runEmbedBatch(env());
			expect(r).toMatchObject({ inbaddade: 3, klar: true });
			expect(r.fel ?? 0).toBe(0);
		} finally {
			atersta();
		}
		expect(anrop.flat()).toContain(KONTROLLTEXT);
		expect(felrader()).toEqual([]);
		expect(vec.store.size).toBe(3);
	});

	it("regeln, tjänsten går ned mitt i körningen: avbrott efter åtta fel i följd, det som redan bäddats in står sig, inget bokförs", async () => {
		lamningar(120);
		const anrop = styrdAi((_t, n) => (n > 2 ? new Error("InferenceUpstreamError: Unknown internal error") : null));
		const atersta = tyst();
		try {
			await expect(runEmbedBatch(env())).rejects.toThrow(/8 anrop i följd fallerade/);
		} finally {
			atersta();
		}
		expect(anrop.length).toBe(10);
		expect(vec.store.size).toBe(100);
		expect(felrader()).toEqual([]);
	});

	it("engångsrensning v2: bokförda fel med det gamla belägget (där kontrolltexten räknades) tas bort och prövas igen", async () => {
		lamningar(3);
		const h = (u: string) => (db.prepare("SELECT hash FROM lamning WHERE uuid = ?").get(u) as { hash: string }).hash;
		const ins = db.prepare("INSERT INTO inbaddning_fel (uuid, rad_hash, forsok, senaste_fel, andrad) VALUES (?, ?, 3, ?, ?)");
		const nu = new Date().toISOString();
		ins.run(uuidN(1), h(uuidN(1)), "belägg: annan text i körningen lyckades; InferenceUpstreamError: Unknown internal error", nu);
		ins.run(uuidN(2), h(uuidN(2)), `${BELAGG_TILLFALLIGT}503 Service Unavailable`, nu);
		ins.run(uuidN(3), h(uuidN(3)), `${BELAGG_ANNAN_LYCKADES}AiError: 3010: Invalid input`, nu);
		const atersta = tyst();
		try {
			expect(await runEmbedBatch(env())).toMatchObject({ inbaddade: 1, klar: true });
		} finally {
			atersta();
		}
		expect(vec.store.has(uuidN(1))).toBe(true);
		expect(felrader().map((r) => r.uuid)).toEqual([uuidN(2), uuidN(3)]);
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
