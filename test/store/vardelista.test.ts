/**
 * Namnuppslaget ur indexet och kopian av Fornsök-appens värdelistor
 * (src/lookup/index_domaner.ts), mot testurvalet med några lämningar flyttade
 * till socknar som finns flera gånger i samma län (Mo och Råda i Västra
 * Götaland, som indexet slår ihop till en rad med län men utan socken-id).
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainService } from "../../src/lookup/domains";
import { iBakgrunden, medBakgrund } from "../../src/bakgrund";
import { FallbackDomainSource, HAMTNING_MAX_MS, IndexDomainSource, KOPIA_LAS, KOPIA_NYCKEL, sparaKopiaSats } from "../../src/lookup/index_domaner";
import type { DomainSource, Domaner } from "../../src/sources/types";
import { fullRecomputeSql } from "../../src/store/omraden";
import { runSync } from "../../src/sync/run";
import { connectMcp, fakeFetch, standardRoutes, type Route } from "../helpers";
import { emptyDb, fakeRaa, openD1 } from "../sync/helpers";
import { d1FromSqlite } from "./d1-adapter";
import { loadUrval } from "./urval-fixture";

type S = Record<string, any>;
const text = (r: { content?: unknown }) => ((r.content as Array<{ text?: string }>) ?? []).map((c) => c.text ?? "").join("\n");
const APP_DOMANER = /\/open\/fornsok\/api\/(lamning|uppdrag)\/domaner$/;
const utanAppensListor = (): Route[] => standardRoutes().filter((r) => !r.match(new URL("https://app.raa.se/open/fornsok/api/lamning/domaner")));

/** Flytta lämningar till Mo och Råda i Västra Götaland (hopslagna) och Mo i Gävleborg (entydig i länet). */
function flertydigaSocknar(raw: DatabaseSync): Record<string, string[]> {
	const omr: Array<[string, string, string, string | null]> = [
		["lan", "Västra Götaland", "", "14"],
		["lan", "Gävleborg", "", "21"],
		["kommun", "Tanum", "", "1435"],
		["kommun", "Åmål", "", "1492"],
		["kommun", "Härryda", "", "1401"],
		["kommun", "Lidköping", "", "1494"],
		["kommun", "Söderhamn", "", "2182"],
		["socken", "Mo", "Västra Götaland", null],
		["socken", "Råda", "Västra Götaland", null],
		["socken", "Mo", "Gävleborg", "c0e16ce1-a20b-40d3-853d-b784212f55ce"],
	];
	for (const o of omr) raw.prepare("INSERT INTO omrade (niva, namn, lan, kod) VALUES (?, ?, ?, ?)").run(...o);
	const plats: Array<[string, string, string, string]> = [
		["Mo", "Västra Götaland", "Tanum", "Västra Götaland"],
		["Mo", "Västra Götaland", "Tanum", "Västra Götaland"],
		["Mo", "Västra Götaland", "Åmål", "Västra Götaland"],
		["Mo", "Västra Götaland", "Åmål", "Västra Götaland"],
		["Råda", "Västra Götaland", "Härryda", "Västra Götaland"],
		["Råda", "Västra Götaland", "Lidköping", "Västra Götaland"],
		["Mo", "Gävleborg", "Söderhamn", "Gävleborg"],
	];
	const ids = (raw.prepare("SELECT id, uuid FROM lamning ORDER BY id LIMIT ?").all(plats.length) as Array<{ id: number; uuid: string }>);
	const ut: Record<string, string[]> = {};
	plats.forEach(([socken, sockenLan, kommun, lan], i) => {
		const { id, uuid } = ids[i];
		raw.prepare("DELETE FROM lamning_omrade WHERE lamning_id = ?").run(id);
		const add = (niva: string, namn: string, l: string) =>
			raw.prepare("INSERT INTO lamning_omrade (omrade_id, lamning_id) SELECT id, ? FROM omrade WHERE niva = ? AND namn = ? AND lan = ?").run(id, niva, namn, l);
		add("socken", socken, sockenLan);
		add("kommun", kommun, "");
		add("lan", lan, "");
		const k = `${socken} (${kommun})`;
		ut[k] = [...(ut[k] ?? []), uuid];
	});
	raw.exec("DELETE FROM omrade_sammanfattning; DELETE FROM omrade_relation; DELETE FROM niva_sammanfattning;");
	for (const s of fullRecomputeSql()) raw.exec(s);
	return ut;
}

const nere: DomainSource = {
	loadDomaner: async () => {
		throw new Error("Fornsök-appen svarar inte");
	},
};

describe("namnuppslag: socknar med samma namn i samma län (testurvalet, alltid)", () => {
	let raw: DatabaseSync;
	let platser: Record<string, string[]>;
	beforeEach(() => {
		raw = loadUrval();
		platser = flertydigaSocknar(raw);
	});
	afterEach(() => raw.close());

	it("utan kopia och utan appen: aldrig ett tyst hopslaget svar; med kommun avgränsat och sagt", async () => {
		const db = d1FromSqlite(raw);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const svc = new DomainService(new FallbackDomainSource(new IndexDomainSource(db, { app: nere }), nere));
			const [mo] = await svc.resolveSocknar(["Mo (Tanum)"]);
			expect(mo).toMatchObject({ namn: "Mo", lan: ["Västra Götaland"], kommun: ["Tanum"] });
			expect(mo.anmarkning).toMatch(/flera socknar som heter Mo i Västra Götaland.*skiljer inte på dem.*Tanum/);
			await expect(svc.resolveSocknar(["Mo (Västra Götaland)"])).rejects.toThrow(/flertydig.*Ange kommun, t\.ex\. "Mo \((Tanum|Åmål)\)"/);
			// Råda finns bara i ett län, men två gånger där: tidigare gav det tyst alla Råda.
			await expect(svc.resolveSocknar(["Råda"])).rejects.toThrow(/flertydig/);
			expect((await svc.resolveSocknar(["Råda (Härryda)"]))[0]).toMatchObject({ namn: "Råda", kommun: ["Härryda"] });
			expect((await svc.resolveSocknar(["Råda"], { kommunkoder: ["1494"] }))[0]).toMatchObject({ namn: "Råda", kommun: ["Lidköping"] });
			// Mo i Gävleborg är entydig i sitt län: vanlig länsavgränsning, ingen anmärkning.
			const [moG] = await svc.resolveSocknar(["Mo (Gävleborg)"]);
			expect(moG).toMatchObject({ namn: "Mo", lan: ["Gävleborg"] });
			expect(moG.kommun).toBeUndefined();
			// Listorna är byggda ur indexet i väntan på kopian: cachas bara kort.
			expect((await svc.get()).kortlivad).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it("utan kopia och utan appen, genom sok_lamningar: bara socknens lämningar i kommunen, med anmärkning", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const c = await connectMcp(utanAppensListor(), { db: d1FromSqlite(raw) });
		try {
			const r = await c.client.callTool({ name: "sok_lamningar", arguments: { socken: ["Mo (Tanum)"], antal: 50 } });
			const s = r.structuredContent as S;
			expect(s.totalt).toBe(2);
			expect(s.traffar.map((t: S) => t.uuid).sort()).toEqual([...platser["Mo (Tanum)"]].sort());
			expect(text(r)).toMatch(/Obs: Det finns flera socknar som heter Mo i Västra Götaland/);
			const fel = await c.client.callTool({ name: "sok_lamningar", arguments: { socken: ["Råda"] } });
			expect(fel.isError).toBe(true);
			expect(text(fel)).toMatch(/flertydig.*Ange kommun/);
			expect(raw.prepare("SELECT count(*) AS c FROM vardelista_kopia").get()).toEqual({ c: 0 });
		} finally {
			await c.client.close();
			warn.mockRestore();
		}
	});

	it("kommunavgränsad socken: lämningar i socknen utan kommun i registret utesluts avsiktligt, och svaret säger det (granskningen, punkt 5)", async () => {
		// En lämning i Mo (Västra Götaland) med län men utan kommun (som 30 lämningar i hela landet).
		const { id, uuid } = raw.prepare("SELECT id, uuid FROM lamning ORDER BY id LIMIT 1 OFFSET 20").get() as { id: number; uuid: string };
		raw.prepare("DELETE FROM lamning_omrade WHERE lamning_id = ?").run(id);
		raw.prepare("INSERT INTO lamning_omrade (omrade_id, lamning_id) SELECT id, ? FROM omrade WHERE niva = 'socken' AND namn = 'Mo' AND lan = 'Västra Götaland'").run(id);
		raw.prepare("INSERT INTO lamning_omrade (omrade_id, lamning_id) SELECT id, ? FROM omrade WHERE niva = 'lan' AND namn = 'Västra Götaland' AND lan = ''").run(id);
		raw.exec("DELETE FROM omrade_sammanfattning; DELETE FROM omrade_relation; DELETE FROM niva_sammanfattning;");
		for (const sql of fullRecomputeSql()) raw.exec(sql);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const c = await connectMcp(utanAppensListor(), { db: d1FromSqlite(raw) });
		try {
			const r = await c.client.callTool({ name: "sok_lamningar", arguments: { socken: ["Mo (Tanum)"], antal: 50 } });
			const s = r.structuredContent as S;
			expect(s.traffar.map((t: S) => t.uuid).sort()).toEqual([...platser["Mo (Tanum)"]].sort());
			expect(s.traffar.some((t: S) => t.uuid === uuid)).toBe(false);
			expect(text(r)).toMatch(/lämningar i socknen som saknar kommun i registret kommer inte med/);
			// Lämningen finns i indexet, med socknen Mo men utan kommun.
			const l = await c.client.callTool({ name: "lamning", arguments: { id: [uuid] } });
			const post = (l.structuredContent as S).lamningar[0];
			expect(post.indelning).toMatchObject({ socken: ["Mo"], kommun: [] });
		} finally {
			await c.client.close();
			warn.mockRestore();
		}
	});

	it("utan kopia men appen svarar: listorna hämtas och sparas vid första uppslaget, och Mo (Tanum) avgränsas", async () => {
		const c = await connectMcp(standardRoutes(), { db: d1FromSqlite(raw) });
		try {
			const r = await c.client.callTool({ name: "sok_lamningar", arguments: { socken: ["Mo (Tanum)"], antal: 50 } });
			const s = r.structuredContent as S;
			expect(s.traffar.map((t: S) => t.uuid).sort()).toEqual([...platser["Mo (Tanum)"]].sort());
			expect(s.anmarkningar.join(" ")).toMatch(/flera socknar som heter Mo i Västra Götaland; avgränsat till kommun Tanum, Munkedal/);
			const k = raw.prepare("SELECT nyckel, hamtad FROM vardelista_kopia").all() as Array<{ nyckel: string; hamtad: string }>;
			expect(k.map((x) => x.nyckel)).toEqual([KOPIA_NYCKEL]);
			expect(c.calls.filter((x) => APP_DOMANER.test(x.url.pathname))).toHaveLength(2);
			// Råda med appens lista: två socknar, kandidater med kommun.
			const fel = await c.client.callTool({ name: "sok_lamningar", arguments: { socken: ["Råda"] } });
			expect(text(fel)).toMatch(/flertydig – 2 socknar/);
		} finally {
			await c.client.close();
		}
	});

	it("samtidiga uppslag gör en hämtning; ett annat isolats lås gör att ingen hämtning görs", async () => {
		const appDomaner = await new (await import("../../src/sources/fornsokapp/source")).FornsokAppSource(
			new (await import("../../src/upstream/client")).UpstreamClient({ userAgent: "test", fetch: fakeFetch(standardRoutes()).fetch }),
		).loadDomaner();
		let anrop = 0;
		const app: DomainSource = {
			loadDomaner: async () => {
				anrop++;
				await new Promise((r) => setTimeout(r, 20));
				return appDomaner;
			},
		};
		const src = new IndexDomainSource(d1FromSqlite(raw), { app });
		const svar = await Promise.all([src.loadDomaner(), src.loadDomaner(), src.loadDomaner()]);
		expect(anrop).toBe(1);
		for (const d of svar) expect(d.socknar.filter((x) => x.namn === "Mo").length).toBeGreaterThanOrEqual(5);
		// Låset släpps efteråt.
		expect(raw.prepare("SELECT count(*) AS c FROM synk_status WHERE nyckel = ?").get(KOPIA_LAS)).toEqual({ c: 0 });

		raw.exec("DELETE FROM vardelista_kopia");
		raw.prepare("INSERT INTO synk_status (nyckel, varde, andrad) VALUES (?, ?, 'annat-isolat')").run(KOPIA_LAS, new Date(Date.now() + 60_000).toISOString());
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const d = await new IndexDomainSource(d1FromSqlite(raw), { app }).loadDomaner();
			expect(anrop).toBe(1);
			expect(d.kortlivad).toBe(true);
			expect(d.socknar.find((x) => x.namn === "Råda")?.sammanslagen).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it("en hämtning som aldrig avgörs (avbruten förfrågan) anmäls till waitUntil och delas högst HAMTNING_MAX_MS", async () => {
		let t = Date.parse("2026-11-18T10:00:00Z");
		let anrop = 0;
		const app: DomainSource = {
			loadDomaner: () => {
				anrop++;
				return new Promise<never>(() => {});
			},
		};
		const src = new IndexDomainSource(d1FromSqlite(raw), { app, vantaMs: 300, now: () => t });
		const anmalda: Array<Promise<unknown>> = [];
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const d1 = await medBakgrund({ waitUntil: (p) => anmalda.push(p) }, () => src.loadDomaner());
			expect(anrop).toBe(1);
			expect(d1.kortlivad).toBe(true);
			// Hämtningen är anmäld till förfrågans waitUntil, så att Workers låter den löpa klart.
			expect(anmalda).toHaveLength(1);
			// Inom tidsgränsen delas den (inget nytt anrop; uppslaget väntar högst vantaMs).
			t += 1000;
			await src.loadDomaner();
			expect(anrop).toBe(1);
			// Efter tidsgränsen hänger uppslaget inte längre på det gamla löftet: en ny hämtning
			// prövas (låset från den övergivna gäller ännu, så ingen väntan alls).
			t += HAMTNING_MAX_MS;
			const t0 = Date.now();
			const d3 = await src.loadDomaner();
			expect(Date.now() - t0).toBeLessThan(250);
			expect(d3.kortlivad).toBe(true);
			// När låset har gått ut hämtas listorna på nytt.
			t += 3 * 60 * 1000;
			await src.loadDomaner();
			expect(anrop).toBe(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("bakgrundskontexten följer med över await och timers, och saknas utanför en förfrågan", async () => {
		const anmalda: Array<Promise<unknown>> = [];
		expect(iBakgrunden(Promise.resolve())).toBe(false);
		await medBakgrund({ waitUntil: (p) => anmalda.push(p) }, async () => {
			await new Promise((r) => setTimeout(r, 5));
			expect(iBakgrunden(Promise.reject(new Error("sväljs")))).toBe(true);
		});
		expect(anmalda).toHaveLength(1);
		await expect(anmalda[0]).resolves.toBeUndefined();
	});

	it("gammal kopia: används direkt, och en ny hämtas i bakgrunden", async () => {
		const db = d1FromSqlite(raw);
		const nu = Date.parse("2026-11-18T12:00:00Z");
		const gammal: Domaner = { ...(await standardDomaner()), hamtad: "2026-10-01T00:00:00Z" };
		await db.batch([sparaKopiaSats(db, gammal)]);
		let losning: (d: Domaner) => void = () => {};
		const app: DomainSource = { loadDomaner: () => new Promise<Domaner>((r) => (losning = r)) };
		const src = new IndexDomainSource(db, { app, now: () => nu });
		const d = await src.loadDomaner();
		expect(d.kortlivad).toBeUndefined();
		expect(d.socknar.filter((x) => x.namn === "Råda")).toHaveLength(2);
		losning({ ...gammal, hamtad: new Date(nu).toISOString() });
		await src.uppdateraKopia();
		expect(raw.prepare("SELECT hamtad FROM vardelista_kopia").get()).toEqual({ hamtad: new Date(nu).toISOString() });
	});
});

async function standardDomaner(): Promise<Domaner> {
	const { FornsokAppSource } = await import("../../src/sources/fornsokapp/source");
	const { UpstreamClient } = await import("../../src/upstream/client");
	return new FornsokAppSource(new UpstreamClient({ userAgent: "test", fetch: fakeFetch(standardRoutes()).fetch })).loadDomaner();
}

describe("nattsynken sparar kopian även utan ändringar", () => {
	it("tomt flöde: kopian sparas; en färsk kopia hämtas inte igen samma natt", async () => {
		const db = emptyDb();
		try {
			const raa = fakeRaa();
			const o = { now: new Date("2026-11-12T04:00:00Z"), fetch: raa.fetch, sleep: async () => {}, pausMs: 0 };
			const r = await runSync({ DB: openD1(db) }, o);
			expect(r.status).not.toBe("fel");
			expect(r.nya + r.andrade).toBe(0);
			expect(db.prepare("SELECT nyckel FROM vardelista_kopia").all()).toEqual([{ nyckel: KOPIA_NYCKEL }]);
			const fore = raa.calls.filter((u) => APP_DOMANER.test(u.pathname)).length;
			expect(fore).toBe(2);
			await runSync({ DB: openD1(db) }, { ...o, now: new Date("2026-11-12T05:00:00Z") });
			expect(raa.calls.filter((u) => APP_DOMANER.test(u.pathname)).length).toBe(fore);
		} finally {
			db.close();
		}
	});
});
