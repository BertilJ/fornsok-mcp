/**
 * Schemalagda körningar (src/scheduled.ts, scheduled-hanteraren i
 * src/index.ts) och den semantiska vägen genom hela kedjan: riktig
 * runEmbedBatch, createSemanticSearch och sok_lamningar mot Falu kommun –
 * men med FALSKA bindningar för Workers AI och Vectorize (test/semantic/fakes.ts).
 */
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { WorkerEnv } from "../src/env";
import worker from "../src/index";
import { EMBED_MAX, runScheduled, SYNC_CRON, type ScheduledDeps } from "../src/scheduled";
import { createSemanticSearch, runEmbedBatch } from "../src/semantic";
import { runSync, type SyncResult } from "../src/sync";
import { connectMcp, standardRoutes } from "./helpers";
import { FakeAi, FakeVectorize } from "./semantic/fakes";
import { d1FromSqlite } from "./store/d1-adapter";
import { HAS_FALUN, type LoadedFalun, loadFalun, SKIP_MESSAGE } from "./store/falun-fixture";
import { emptyDb, fakeRaa } from "./sync/helpers";

type S = Record<string, any>;

const syncResult = (over: Partial<SyncResult> = {}): SyncResult => ({
	status: "klar",
	fran: "2026-11-17",
	till: "2026-11-17",
	senast_synkat: "2026-11-17",
	nya: 1,
	andrade: 2,
	oforandrade: 0,
	borttagna: 0,
	reserv: 0,
	kvar: 0,
	markerade: 0,
	fel: [],
	...over,
});

function fakes(over: Partial<ScheduledDeps> = {}) {
	const lines: string[] = [];
	const deps: ScheduledDeps = {
		runSync: vi.fn(async () => syncResult()),
		runEmbedBatch: vi.fn(async () => ({ inbaddade: 5, vektorer: 6, oforandrade: 0, tomma: 0, borttagna: 0, klar: true, omfang: ["Dalarna"] })),
		log: (l) => lines.push(l),
		...over,
	};
	return { deps, lines };
}

const DB = {} as unknown as D1Database;
const AI = {} as unknown as Ai;
const VEC = {} as unknown as Vectorize;

describe("runScheduled", () => {
	it("utan DB görs ingenting", async () => {
		const { deps, lines } = fakes();
		const r = await runScheduled(SYNC_CRON, { AI, VECTORIZE: VEC }, deps);
		expect(r).toMatchObject({ synk: "hoppad", inbaddning: "hoppad" });
		expect(deps.runSync).not.toHaveBeenCalled();
		expect(deps.runEmbedBatch).not.toHaveBeenCalled();
		expect(lines).toEqual([`schemalagd körning ${SYNC_CRON}: hoppar över (ingen D1-bindning DB)`]);
	});

	it("synk-cron: nattsynk med rätt miljö, sedan inbäddning; en loggrad", async () => {
		const { deps, lines } = fakes();
		const env: WorkerEnv = { DB, AI, VECTORIZE: VEC, CONTACT_URL: "https://example.org/k", SEMANTIC_LAN: "Dalarna,Gävleborg" };
		const r = await runScheduled(SYNC_CRON, env, deps);
		expect(deps.runSync).toHaveBeenCalledWith({ DB, CACHE: undefined, CONTACT_URL: "https://example.org/k", SEMANTIC_LAN: "Dalarna,Gävleborg" });
		expect(deps.runEmbedBatch).toHaveBeenCalledWith({ DB, AI, VECTORIZE: VEC, SEMANTIC_LAN: "Dalarna,Gävleborg" }, { max: EMBED_MAX });
		expect(r.synk).toMatchObject({ status: "klar", nya: 1, andrade: 2 });
		expect(r.inbaddning).toMatchObject({ inbaddade: 5, klar: true });
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^schemalagd körning 40 3-6 \* \* \*: \{"synk":\{"status":"klar"/);
	});

	it("annan cron: bara inbäddning; utan AI/VECTORIZE ingen inbäddning", async () => {
		const a = fakes();
		const r = await runScheduled("*/15 * * * *", { DB, AI, VECTORIZE: VEC }, a.deps);
		expect(a.deps.runSync).not.toHaveBeenCalled();
		expect(a.deps.runEmbedBatch).toHaveBeenCalledTimes(1);
		expect(r.synk).toBe("ej_schemalagd");
		const b = fakes();
		const r2 = await runScheduled(SYNC_CRON, { DB, AI }, b.deps);
		expect(b.deps.runSync).toHaveBeenCalledTimes(1);
		expect(b.deps.runEmbedBatch).not.toHaveBeenCalled();
		expect(r2.inbaddning).toBe("hoppad");
	});

	it("fel i synken hindrar inte inbäddningen, och tvärtom", async () => {
		const a = fakes({
			runSync: vi.fn(async () => {
				throw new Error("flödet svarade 503");
			}),
		});
		const r = await runScheduled(SYNC_CRON, { DB, AI, VECTORIZE: VEC }, a.deps);
		expect(r.synk).toEqual({ fel: "flödet svarade 503" });
		expect(a.deps.runEmbedBatch).toHaveBeenCalledTimes(1);
		expect(a.lines[0]).toMatch(/"fel":"flödet svarade 503"/);
		const b = fakes({
			runEmbedBatch: vi.fn(async () => {
				throw new Error("AI nere");
			}),
		});
		const r2 = await runScheduled(SYNC_CRON, { DB, AI, VECTORIZE: VEC }, b.deps);
		expect(r2.synk).toMatchObject({ status: "klar" });
		expect(r2.inbaddning).toEqual({ fel: "AI nere" });
		expect(b.lines).toHaveLength(1);
	});
});

describe("Workerns scheduled-hanterare", () => {
	it("finns, går inte genom Access och gör ingenting utan DB", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const waits: Promise<unknown>[] = [];
		const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
		expect(typeof worker.scheduled).toBe("function");
		await worker.scheduled!({ cron: SYNC_CRON, scheduledTime: Date.now(), noRetry() {} } as ScheduledController, {}, ctx);
		await Promise.all(waits);
		expect(log).toHaveBeenCalledWith(`schemalagd körning ${SYNC_CRON}: hoppar över (ingen D1-bindning DB)`);
		log.mockRestore();
	});

	it("fetch-vägen är oförändrat skyddad (401 utan Access-JWT, även med DB)", async () => {
		const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const res = await worker.fetch(
			new Request("https://fornsok.example.se/mcp", { method: "POST", body: "{}" }),
			{ DB: d1FromSqlite(emptyDb()) as unknown as D1Database },
			ctx,
		);
		expect(res.status).toBe(401);
	});
});

describe("runScheduled med den riktiga nattsynken (falsk RAÄ)", () => {
	it("miljön når runSync, som skriver synk_status.senast_synkat", async () => {
		const db = emptyDb();
		const raa = fakeRaa();
		const { lines } = fakes();
		const r = await runScheduled(
			SYNC_CRON,
			{ DB: d1FromSqlite(db) as unknown as D1Database },
			{
				runSync: (env) => runSync(env, { fetch: raa.fetch, now: new Date("2026-11-18T03:40:00Z"), pausMs: 0, sleep: async () => {} }),
				runEmbedBatch,
				log: (l) => lines.push(l),
			},
		);
		expect(r.synk).toMatchObject({ status: expect.stringMatching(/^(klar|inget_nytt)$/) });
		expect(raa.calls.some((u) => u.hostname === "pub.raa.se" && u.pathname === "/datauttag/lamningar")).toBe(true);
		const st = db.prepare("SELECT varde FROM synk_status WHERE nyckel = 'senast_synkat'").get() as { varde?: string } | undefined;
		expect(st?.varde).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		db.close();
	});
});

describe.skipIf(!HAS_FALUN)(`Semantisk väg genom hela kedjan med falska AI/Vectorize ${HAS_FALUN ? "" : `(${SKIP_MESSAGE})`}`, () => {
	let f: LoadedFalun;
	let db: DatabaseSync;
	let client: Client | undefined;
	const ai = new FakeAi();
	const vec = new FakeVectorize();

	beforeAll(async () => {
		f = loadFalun();
		db = f.open();
		// Inbäddning via de schemalagda körningarna, tills omfånget (Falun ⊂ Dalarna) är klart.
		const env = { DB: d1FromSqlite(db) as unknown as D1Database, AI: ai as unknown as Ai, VECTORIZE: vec as unknown as Vectorize };
		for (let i = 0; i < 10; i++) {
			const r = await runScheduled("*/15 * * * *", env, { runSync, runEmbedBatch, log: () => {} });
			if (typeof r.inbaddning === "object" && "klar" in r.inbaddning && r.inbaddning.klar) break;
		}
	}, 120_000);
	afterAll(() => {
		db?.close();
		f?.cleanup();
	});
	afterEach(async () => {
		await client?.close();
		client = undefined;
	});

	it("inbäddningen är klar och vektorerna finns", () => {
		expect(vec.store.size).toBeGreaterThan(3000);
		expect((db.prepare("SELECT count(*) AS c FROM inbaddning").get() as { c: number }).c).toBeGreaterThan(3000);
	});

	it("sok_lamningar använder kanalen inom omfånget: ord + betydelse, RRF, sokkanaler", async () => {
		const semantic = createSemanticSearch({ DB: d1FromSqlite(db), AI: ai, VECTORIZE: vec });
		expect(semantic).not.toBeNull();
		const c = await connectMcp(standardRoutes(), { db: d1FromSqlite(db), semantic: semantic ?? undefined });
		client = c.client;
		expect(c.client.getInstructions()).toMatch(/Semantisk sökning .* finns bara för Dalarnas län/);
		const r = (await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "önskekälla", kommun: ["Falun"], antal: 5 } })).structuredContent as S;
		expect(r.sokkanaler).toEqual(["ord", "betydelse"]);
		expect(r.traffar[0]).toMatchObject({ lamningsnummer: "L2001:646", kanaler: ["ord", "betydelse"] });
		const b = (await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "trefaldighetskälla offer", socken: ["Bjursås"], lage: "betydelse", antal: 5 } })).structuredContent as S;
		expect(b.sokkanaler).toEqual(["betydelse"]);
		expect(b.traffar.length).toBeGreaterThan(0);
		for (const t of b.traffar) expect(t.socken).toContain("Bjursås");
		// Utan geografiskt filter: bara ordsök (ingen slagsida mot omfånget).
		const riks = (await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "önskekälla" } })).structuredContent as S;
		expect(riks.sokkanaler).toEqual(["ord"]);
		// Utanför omfånget: betydelse ger fel som förklarar var den gäller.
		const ut = await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "önskekälla", kommun: ["Uppsala"], lage: "betydelse" } });
		expect(ut.isError).toBe(true);
		expect((ut.content as Array<{ text: string }>)[0].text).toMatch(/Semantisk sökning gäller bara Dalarnas län/);
	});

	it("sok_lamningar säger när omfånget inte är färdiginbäddat (semantisk_tackning)", async () => {
		const semantic = createSemanticSearch({ DB: d1FromSqlite(db), AI: ai, VECTORIZE: vec }) ?? undefined;
		const args = { fraga: "önskekälla", kommun: ["Falun"], antal: 5 };
		let c = await connectMcp(standardRoutes(), { db: d1FromSqlite(db), semantic });
		client = c.client;
		const full = (await c.client.callTool({ name: "sok_lamningar", arguments: args })).structuredContent as S;
		expect(full.semantisk_tackning).toMatchObject({ fullstandig: true, i_omfang: 3908 });
		expect(full.anmarkningar.join(" ")).not.toMatch(/inbäddat till/);
		await c.client.close();
		const sparade = db.prepare("SELECT * FROM inbaddning ORDER BY uuid LIMIT 1000").all();
		db.exec("DELETE FROM inbaddning WHERE uuid IN (SELECT uuid FROM inbaddning ORDER BY uuid LIMIT 1000)");
		try {
			c = await connectMcp(standardRoutes(), { db: d1FromSqlite(db), semantic });
			client = c.client;
			const del = (await c.client.callTool({ name: "sok_lamningar", arguments: args })).structuredContent as S;
			expect(del.semantisk_tackning).toMatchObject({ fullstandig: false, i_omfang: 3908, inbaddade: 2908 });
			expect(del.anmarkningar.join(" ")).toMatch(/ansluten, men Dalarnas län är ännu bara inbäddat till 74 % \(2908 av 3908 lämningar\)/);
			// Bara ordsök: ingen uppgift om täckning.
			const ord = (await c.client.callTool({ name: "sok_lamningar", arguments: { ...args, lage: "ord" } })).structuredContent as S;
			expect(ord.semantisk_tackning).toBeUndefined();
		} finally {
			const ins = db.prepare("INSERT INTO inbaddning (uuid, rad_hash, innehall_hash, vektorer, status, modell, andrad) VALUES (?, ?, ?, ?, ?, ?, ?)");
			for (const r of sparade as Array<Record<string, string | number>>) ins.run(r.uuid, r.rad_hash, r.innehall_hash, r.vektorer, r.status, r.modell, r.andrad);
		}
	});

	it("sammanslagen sökning: stabil ordning över sidgränser (fast djup), inga dubbletter", async () => {
		const semantic = createSemanticSearch({ DB: d1FromSqlite(db), AI: ai, VECTORIZE: vec }) ?? undefined;
		const c = await connectMcp(standardRoutes(), { db: d1FromSqlite(db), semantic });
		client = c.client;
		const sida = async (antal: number, n: number) =>
			((await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "kolbotten", kommun: ["Falun"], antal, sida: n } })).structuredContent as S).traffar.map((t: S) => t.uuid as string);
		const sma: string[] = [];
		for (let n = 8; n <= 13; n++) sma.push(...(await sida(10, n)));
		const stor = [...(await sida(35, 3)), ...(await sida(35, 4))]; // träff 71–140
		expect(new Set(sma).size).toBe(sma.length);
		// Träff 71–130 i den små sidindelningen = samma träffar i den stora.
		const fran71 = stor.slice(0, 60);
		expect(sma).toEqual(fran71);
	});

	it("semantiska filter: kategori och nara översätts för Vectorize, och det som inte går sägs", async () => {
		const semantic = createSemanticSearch({ DB: d1FromSqlite(db), AI: ai, VECTORIZE: vec }) ?? undefined;
		const c = await connectMcp(standardRoutes(), { db: d1FromSqlite(db), semantic });
		client = c.client;
		const r = (await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "offerkälla", lage: "betydelse", nara: { lat: 60.7337, lon: 15.4564, radie_m: 2000 } } })).structuredContent as S;
		expect(r.sokkanaler).toEqual(["betydelse"]);
		const q = vec.queries.at(-1)?.filter as Record<string, unknown>;
		expect(q.socken ?? q.kommun).toBeTruthy();
		expect(r.anmarkningar.join(" ")).toMatch(/kan inte tillämpa nara \(radien\) före likhetssökningen; de prövas på de 100 semantiskt närmaste lämningarna inom de berörda socknarna/);
		expect(r.anmarkningar.join(" ")).toMatch(/totalen är antalet av de 100 semantiskt närmaste/);
		expect(r.filter.ord).toBeUndefined();
		await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "offerkälla", lage: "betydelse", kommun: ["Falun"], kategori: ["Kult, offer och folktro"] } });
		const q2 = vec.queries.at(-1)?.filter as Record<string, { $in?: string[] }>;
		expect(q2.typ?.$in?.length ?? 0).toBeGreaterThan(1);
	});

	it("hitta_plats är registrerad sist och svarar ur indexet", async () => {
		const c = await connectMcp(standardRoutes(), { db: d1FromSqlite(db), nominatim: "av" });
		client = c.client;
		const { tools } = await c.client.listTools();
		expect(tools.map((t) => t.name).at(-1)).toBe("hitta_plats");
		expect(tools).toHaveLength(12);
		const res = await c.client.callTool({ name: "hitta_plats", arguments: { namn: "Bjursås" } });
		const r = res.structuredContent as S;
		expect(r.kalla).toBe("index");
		// Källraden har indexets datum (samma hamtad_fran som övriga verktyg).
		expect((res.content as Array<{ text: string }>)[0].text).toMatch(/^Källa: serverns lämningsindex; index \d{4}-\d{2}-\d{2}/m);
		expect(r.kandidater.length).toBeGreaterThan(0);
		expect(c.calls.filter((x) => x.url.hostname === "nominatim.openstreetmap.org")).toHaveLength(0);
	});
});

describe("cron och lås (granskningen av synken, punkt 6)", () => {
	it("synk-cronen känns igen på avgränsat timfält, inte exakt sträng", async () => {
		const { arSynkCron } = await import("../src/scheduled");
		expect(arSynkCron("40 3-6 * * *")).toBe(true);
		expect(arSynkCron("  40  3-6 * * * ")).toBe(true);
		expect(arSynkCron("45 3,4,5,6 * * *")).toBe(true);
		expect(arSynkCron("*/5 * * * *")).toBe(false);
		expect(arSynkCron("*/15 * * * *")).toBe(false);
		const log: string[] = [];
		expect(arSynkCron("trasig", (l) => log.push(l))).toBe(false);
		expect(log[0]).toMatch(/kan inte tolka/);
	});

	it("låset med utgångstid: en andra körning hoppar över, och ett utgånget lås kan tas", async () => {
		const { taLas, slappLas, LAS_MS } = await import("../src/scheduled");
		const { emptyDb, openD1 } = await import("./sync/helpers");
		const raw = emptyDb();
		const db = openD1(raw) as unknown as D1Database;
		const t = Date.parse("2026-11-18T03:40:00Z");
		expect(await taLas(db, "las_inbaddning", "a", t)).toBe(true);
		expect(await taLas(db, "las_inbaddning", "b", t + 60_000)).toBe(false);
		expect(await taLas(db, "las_inbaddning", "b", t + LAS_MS + 1)).toBe(true);
		await slappLas(db, "las_inbaddning", "a"); // fel token: släpper inte b:s lås
		expect(await taLas(db, "las_inbaddning", "c", t + LAS_MS + 2)).toBe(false);
		await slappLas(db, "las_inbaddning", "b");
		expect(await taLas(db, "las_inbaddning", "c", t + LAS_MS + 3)).toBe(true);
		raw.close();
	});

	it("två överlappande körningar: bara en bäddar in", async () => {
		const { runScheduled } = await import("../src/scheduled");
		const { emptyDb, openD1 } = await import("./sync/helpers");
		const raw = emptyDb();
		const db = openD1(raw) as unknown as D1Database;
		let pagaende = 0;
		let max = 0;
		let korda = 0;
		const runEmbedBatch = async () => {
			pagaende++;
			korda++;
			max = Math.max(max, pagaende);
			await new Promise((r) => setTimeout(r, 20));
			pagaende--;
			return { inbaddade: 0, vektorer: 0, oforandrade: 0, tomma: 0, borttagna: 0, klar: true, omfang: ["Dalarna"] };
		};
		const env = { DB: db, AI: {} as Ai, VECTORIZE: {} as Vectorize } as unknown as WorkerEnv;
		const deps = { runSync: (async () => { throw new Error("ej här"); }) as never, runEmbedBatch: runEmbedBatch as never, log: () => {} };
		const [a, b] = await Promise.all([runScheduled("*/5 * * * *", env, deps), runScheduled("*/5 * * * *", env, deps)]);
		expect(korda).toBe(1);
		expect(max).toBe(1);
		expect([a.inbaddning, b.inbaddning]).toContainEqual({ fel: "en annan inbäddningskörning pågår" });
		raw.close();
	});
});
