/**
 * Indexvägarna mot det incheckade testurvalet (granskningen av verktygsskiktet,
 * punkt 8a): körs alltid, även utan ingest/.cache/falun.gpkg. De fullstora
 * testerna mot hela Falu kommun (och hela landet) finns kvar som valfria.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SemanticSearch } from "../../src/sources/types";
import { IndexStore } from "../../src/store/index";
import { sokIndex } from "../../src/tools/hitta_plats";
import { connectMcp, standardRoutes } from "../helpers";
import { d1FromSqlite } from "./d1-adapter";
import { loadUrval } from "./urval-fixture";

type S = Record<string, any>;
const U646 = "adc490ba-871a-45bd-8e3d-0a27761b3b6c";
const U8802 = "6d1cf7b6-f5bd-4066-aba6-fb1ea3ce8c75";

describe("indexet mot testurvalet (300 lämningar, alltid)", () => {
	let raw: DatabaseSync;
	let store: IndexStore;
	beforeAll(() => {
		raw = loadUrval();
		store = new IndexStore(d1FromSqlite(raw));
	});
	afterAll(() => raw.close());

	it("urvalet har testposterna och är laddat (slutmarkören finns)", async () => {
		expect((raw.prepare("SELECT count(*) AS c FROM lamning").get() as { c: number }).c).toBe(300);
		expect(await store.status()).toMatchObject({ laddad: true });
		const m = await store.resolveIdsAll(["L2001:646", "L2000:8802", "Bjursås 27:1"]);
		expect(m.get("L2001:646")).toEqual([U646]);
		expect(m.get("L2000:8802")).toEqual([U8802]);
	});

	it("ordsök med filter: utdrag med markerad träff, prefix, socken, kategori", async () => {
		const r = await store.searchIndex({ ord: ["trefaldighetskälla"], socken: [{ namn: "Bjursås" }] });
		const t646 = r.traffar.find((t) => t.uuid === U646);
		expect(t646).toBeTruthy();
		expect(t646?.utdrag).toMatch(/⟦[^⟧]+⟧/);
		const p = await store.searchIndex({ ord: ["önskekäll*"] });
		expect(p.traffar.map((t) => t.uuid)).toContain(U646);
		const k = await store.searchIndex({ kategori: ["Kult, offer och folktro"], socken: [{ namn: "Bjursås" }] }, { antal: 50 });
		expect(k.traffar.map((t) => t.uuid)).toContain(U646);
	});

	it("sidindelning: nabara, sista sidan och sida bortom", async () => {
		const alla = await store.searchIndex({ kommun: ["Falun"] }, { antal: 100 });
		expect(alla.totalt).toBe(300);
		expect(alla.nabara).toBe(300);
		const p3 = await store.searchIndex({ kommun: ["Falun"] }, { antal: 100, sida: 3 });
		const p4 = await store.searchIndex({ kommun: ["Falun"] }, { antal: 100, sida: 4 });
		expect(p3.traffar).toHaveLength(100);
		expect(p4.traffar).toHaveLength(0);
		const ids = new Set([...alla.traffar, ...p3.traffar].map((t) => t.uuid));
		expect(ids.size).toBe(200);
	});

	it("nara: hyttområdet L2000:8802 närmast sin egen mittpunkt", async () => {
		const r = await store.nearby({ lat: 60.66159242831314, lon: 15.554018818384327, radie_m: 500 });
		expect(r.traffar[0]?.uuid).toBe(U8802);
		expect(r.traffar[0]?.avstand_m).toBe(0);
	});

	it("statistik: en nivå ur sammanfattningen och två nivåer med filter", async () => {
		const s = await store.statistik(["socken"]);
		expect(s.totalt).toBe(300);
		expect(s.grupper.find((g) => g.varden[0] === "Bjursås")?.antal).toBeGreaterThanOrEqual(200);
		const t = await store.statistik(["socken", "typ"], { kommun: ["Falun"] });
		expect(t.grupper.reduce((n, g) => n + g.antal, 0)).toBeGreaterThanOrEqual(300);
	});

	it("statistik: gränserna för två nivåer (lägre med filter på område eller egenskap), en nivå med filter utan gräns", async () => {
		const liten = new IndexStore(d1FromSqlite(raw), { statistikTvaNivaer: 100, statistikTvaNivaerOmrade: 20 });
		const forn = { antikvarisk_bedomning: ["Fornlämning" as const] };
		await expect(liten.statistik(["socken", "typ"], forn)).rejects.toThrow(/105 lämningar; gruppering på två nivåer \(socken och typ\) görs för högst 100 lämningar \(.*Gruppera på en nivå/);
		await expect(liten.statistik(["socken", "typ"], { kommun: ["Leksand"] })).resolves.toMatchObject({ totalt: 19 });
		await expect(liten.statistik(["socken", "typ"], { kommun: ["Falun"] })).rejects.toThrow(/högst 20 lämningar med filter på område eller egenskap/);
		await expect(liten.statistik(["socken", "typ"], { egenskap: [{ typ: "Typ", varde: "Gruvhål" }] })).resolves.toMatchObject({ totalt: 20 });
		// En nivå: standardgränsen ligger över registrets storlek.
		await expect(liten.statistik(["socken"], forn)).resolves.toMatchObject({ totalt: 105 });
		await expect(liten.statistik(["kategori"], { kommun: ["Falun"] })).resolves.toMatchObject({ totalt: 300 });
	});

	it("hitta_plats: socknen ur den förberäknade sammanfattningen", async () => {
		const k = await sokIndex(d1FromSqlite(raw), "bjursås", null, null);
		expect(k[0]).toMatchObject({ namn: "Bjursås", typ: "socken", kommun: "Falun", lan: "Dalarna" });
	});

	it("sammanslagen sökning: semantiska träffar utanför filtret stryks (filterSemantic), stabil sidindelning", async () => {
		const utanfor = raw.prepare("SELECT l.uuid FROM lamning l WHERE l.id NOT IN (SELECT lo.lamning_id FROM lamning_omrade lo JOIN omrade o ON o.id = lo.omrade_id WHERE o.niva = 'socken' AND o.namn = 'Bjursås') LIMIT 5").all() as Array<{ uuid: string }>;
		const inom = raw.prepare("SELECT l.uuid FROM lamning l JOIN lamning_omrade lo ON lo.lamning_id = l.id JOIN omrade o ON o.id = lo.omrade_id WHERE o.niva = 'socken' AND o.namn = 'Bjursås' ORDER BY l.id DESC LIMIT 30").all() as Array<{ uuid: string }>;
		const semantic: SemanticSearch = {
			omfang: "Dalarnas län",
			lan: ["Dalarna"],
			scopeCovers: () => true,
			search: async () => [...utanfor, ...inom].map((x, i) => ({ uuid: x.uuid, score: 1 - i / 100 })),
		};
		const c = await connectMcp(standardRoutes(), { db: d1FromSqlite(raw), semantic });
		try {
			const sida = async (n: number) => (await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "röjningsröse", socken: ["Bjursås"], antal: 10, sida: n } })).structuredContent as S;
			const s1 = await sida(1);
			expect(s1.sokkanaler).toEqual(["ord", "betydelse"]);
			const alla: string[] = [];
			for (let n = 1; n <= 6; n++) alla.push(...(await sida(n)).traffar.map((t: S) => t.uuid as string));
			for (const u of utanfor) expect(alla).not.toContain(u.uuid);
			expect(new Set(alla).size).toBe(alla.length);
			expect(alla.some((u) => inom.some((x) => x.uuid === u))).toBe(true);
			const stor = ((await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "röjningsröse", socken: ["Bjursås"], antal: 50, sida: 1 } })).structuredContent as S).traffar.map((t: S) => t.uuid);
			expect(alla.slice(0, 50)).toEqual(stor.slice(0, Math.min(50, alla.length)));
		} finally {
			await c.client.close();
		}
	});
});
