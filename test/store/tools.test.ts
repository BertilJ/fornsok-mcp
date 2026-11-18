/**
 * Verktygen över MCP med indexet inkopplat (Falu kommun i lokal SQLite via
 * D1-adaptern), reservläget när indexet saknas, är tomt eller fallerar, och
 * anslutningspunkten för den semantiska kanalen (med en låtsaskanal).
 * Hoppar över sig självt om ingest/.cache/falun.gpkg saknas.
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MIGRATION } from "../../ingest/sink.ts";
import type { ResolvedSearchFilter, SemanticSearch } from "../../src/sources/types";
import type { D1Like, D1LikeStatement } from "../../src/store/d1";
import { connectMcp, standardRoutes } from "../helpers";
import { d1FromSqlite } from "./d1-adapter";
import { HAS_FALUN, type LoadedFalun, loadFalun, SKIP_MESSAGE } from "./falun-fixture";

type S = Record<string, any>;
const text = (r: { content?: unknown }) => ((r.content as Array<{ text?: string }>) ?? []).map((c) => c.text ?? "").join("\n");

const UUID_646 = "adc490ba-871a-45bd-8e3d-0a27761b3b6c";
const UUID_8802 = "6d1cf7b6-f5bd-4066-aba6-fb1ea3ce8c75";
const UUID_7415 = "bfe10d94-5d11-4943-8085-4b1bfcaacf64";

/** D1-yta som kastar för frågor där `fail(sql)` är sant (simulerat D1-fel). */
function failingD1(inner: D1Like, fail: (sql: string) => boolean): D1Like {
	type St = D1LikeStatement & { run(): unknown[] };
	const wrap = (st: St, sql: string): St => ({
		bind: (...v: unknown[]) => wrap(st.bind(...v) as St, sql),
		all: async <T>() => {
			if (fail(sql)) throw new Error("D1_ERROR: simulerat fel");
			return st.all<T>();
		},
		run: () => {
			if (fail(sql)) throw new Error("D1_ERROR: simulerat fel");
			return st.run();
		},
	});
	return {
		prepare: (sql: string) => wrap(inner.prepare(sql) as St, sql),
		batch: (stmts) => inner.batch(stmts),
	};
}

describe.skipIf(!HAS_FALUN)(`Verktygen med indexet ${HAS_FALUN ? "" : `(${SKIP_MESSAGE})`}`, () => {
	let f: LoadedFalun;
	let db: DatabaseSync;
	let client: Client | undefined;
	beforeAll(() => {
		f = loadFalun();
		db = f.open();
	});
	afterAll(() => {
		db?.close();
		f?.cleanup();
	});
	afterEach(async () => {
		await client?.close();
		client = undefined;
		vi.restoreAllMocks();
	});

	async function connect(options: Parameters<typeof connectMcp>[1] = {}) {
		const c = await connectMcp(standardRoutes(), { db: d1FromSqlite(db), ...options });
		client = c.client;
		return c;
	}

	// ---------------------------------------------------------------- sok_lamningar

	it("sok_lamningar söker i indexet: utdrag runt träffen, hamtad_fran, inga anrop mot K-samsök", async () => {
		const c = await connect();
		const r = await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "önskekälla" } });
		expect(r.isError).toBeFalsy();
		const s = r.structuredContent as S;
		expect(s).toMatchObject({ totalt: 1, sokkanaler: ["ord"], reservlage: false, hamtad_fran: "index 2026-11-17", kalla: "Lämningsindex (D1)", nabara: 1 });
		expect(s.traffar[0]).toMatchObject({ lamningsnummer: "L2001:646", raa_nummer: "Bjursås 27:1", kommun: ["Falun"], socken: ["Bjursås"], osakerhet_m: 15 });
		expect(s.traffar[0].utdrag).toContain("⟦önskekälla⟧");
		expect(c.calls.filter((x) => x.url.hostname === "kulturarvsdata.se")).toHaveLength(0);
		expect(text(r)).toMatch(/sökträffar inom ⟦⟧\): «[^«»]*⟦önskekälla⟧[^«»]*»/);
	});

	it("sok_lamningar: prefix, kategori, egenskap (skiftlägesokänsligt) och nara med exakt avstånd", async () => {
		const c = await connect();
		const pre = (await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "hytt*", antal: 5 } })).structuredContent as S;
		expect(pre.sokord).toEqual(["hytt*"]);
		expect(pre.totalt).toBeGreaterThan(37);
		const kat = (await c.client.callTool({ name: "sok_lamningar", arguments: { kategori: ["kult, offer och folktro"], kommun: ["Falun"] } })).structuredContent as S;
		expect(kat.totalt).toBe(197);
		expect(kat.filter.kategori).toEqual(["Kult, offer och folktro"]);
		expect(kat.filter.lamningstyp).toBeUndefined();
		const eg = await c.client.callTool({ name: "sok_lamningar", arguments: { egenskap: [{ typ: "material", varde: "KOPPAR" }], lamningstyp: ["Hyttområde"] } });
		expect(eg.isError).toBeFalsy();
		expect((eg.structuredContent as S).filter.egenskap).toEqual([{ typ: "Material", varde: "Koppar" }]);
		expect((eg.structuredContent as S).totalt).toBeGreaterThan(0);
		const okand = await c.client.callTool({ name: "sok_lamningar", arguments: { egenskap: [{ typ: "Materiel", varde: "Koppar" }] } });
		expect(okand.isError).toBe(true);
		expect(text(okand)).toMatch(/Okänd egenskapstyp "Materiel". Menade du: "Material"/);
		const okv = await c.client.callTool({ name: "sok_lamningar", arguments: { egenskap: [{ typ: "Material", varde: "Kopar" }] } });
		expect(text(okv)).toMatch(/Okänt värde "Kopar" för egenskapstypen "Material". Menade du: "Koppar"/);
		const nara = (await c.client.callTool({ name: "sok_lamningar", arguments: { nara: { lat: 60.6616, lon: 15.554, radie_m: 500 } } })).structuredContent as S;
		expect(nara.traffar[0]).toMatchObject({ lamningsnummer: "L2000:8802" });
		expect(nara.traffar[0].avstand_m).toBeLessThan(10);
		for (let i = 1; i < nara.traffar.length; i++) expect(nara.traffar[i].avstand_m).toBeGreaterThanOrEqual(nara.traffar[i - 1].avstand_m);
		expect(nara.anmarkningar.join(" ")).not.toMatch(/mittpunkt/);
	});

	it("sok_lamningar: många träffar – nabara och anmärkning när inte alla går att bläddra till", async () => {
		const c = await connect();
		const s = (await c.client.callTool({ name: "sok_lamningar", arguments: { kommun: ["Falun"], antal: 10, sida: 200 } })).structuredContent as S;
		expect(s.totalt).toBe(3908);
		expect(s.nabara).toBe(2000);
		expect(s.anmarkningar.join(" ")).toMatch(/Bara de första 2000 av 3908 träffarna går att bläddra till/);
		expect(s.traffar).toHaveLength(10);
	});

	// ---------------------------------------------------------------- lamningar_nara

	it("lamningar_nara räknar mot indexet", async () => {
		const c = await connect();
		const r = await c.client.callTool({ name: "lamningar_nara", arguments: { lat: 60.66159242831314, lon: 15.554018818384327, radie_m: 500, antal: 10 } });
		const s = r.structuredContent as S;
		expect(s).toMatchObject({ reservlage: false, hamtad_fran: "index 2026-11-17", fullstandig: true, kalla: "Lämningsindex (D1)" });
		expect(s.lamningar[0]).toMatchObject({ lamningsnummer: "L2000:8802", lamningstyp: "Hyttområde", geometrityper: expect.any(Array) });
		expect(s.lamningar[0].geometrier).toBeGreaterThan(1);
		expect(new Set(s.lamningar.map((x: S) => x.lamningsnummer)).size).toBe(s.lamningar.length);
		expect(c.calls.filter((x) => x.url.hostname === "inspire-raa.metria.se")).toHaveLength(0);
		// Inom en yta: Stora stöten ligger i stadslagret.
		const g = (await c.client.callTool({ name: "lamningar_nara", arguments: { lat: 60.6036, lon: 15.6302, radie_m: 300, antal: 3 } })).structuredContent as S;
		expect(g.lamningar[0]).toMatchObject({ avstand_m: 0, inom_lamningen: true, vaderstreck: null });
	});

	// ---------------------------------------------------------------- lamning

	it("lamning: grundposten ur indexet, inkludera-delarna från Fornsök-appen", async () => {
		const c = await connect();
		const r = await c.client.callTool({ name: "lamning", arguments: { id: ["L2001:646"], inkludera: ["referenser", "dokument", "geometri"] } });
		expect(r.isError).toBeFalsy();
		const s = r.structuredContent as S;
		expect(s.reservlage).toBe(false);
		const p = s.lamningar[0];
		expect(p).toMatchObject({ lamningsnummer: "L2001:646", hamtad_fran: "index 2026-11-17", kategori: ["Kult, offer och folktro"] });
		expect(p.lage.osakerhet_m).toBe(15);
		expect(p.geometri.type).toBe("Point");
		expect(p.referenser).toBeTruthy();
		expect(p.dokument.length).toBeGreaterThan(0);
		// Inget nummeruppslag mot K-samsök; posten hämtades ur appen bara för referenserna.
		expect(c.calls.filter((x) => x.url.hostname === "kulturarvsdata.se")).toHaveLength(0);
		expect(c.calls.filter((x) => x.url.pathname === `/open/fornsok/api/lamning/lamning/${UUID_646}`)).toHaveLength(1);
		const bare = (await c.client.callTool({ name: "lamning", arguments: { id: [UUID_8802] } })).structuredContent as S;
		expect(bare.lamningar[0].referenser).toBeUndefined();
	});

	it("lamning: ett delat RAÄ-nummer ger alla lämningar och en anmärkning", async () => {
		const c = await connect();
		const s = (await c.client.callTool({ name: "lamning", arguments: { id: ["Stora Kopparberg 70:1"] } })).structuredContent as S;
		expect(s.lamningar.map((l: S) => l.lamningsnummer)).toEqual(["L2000:8956", "L2000:8957", "L2000:8958"]);
		expect(s.anmarkningar.join(" ")).toMatch(/"Stora Kopparberg 70:1" är flertydigt: det delas av 3 lämningar/);
		// lamning_dokument kräver en entydig lämning.
		const d = await c.client.callTool({ name: "lamning_dokument", arguments: { id: "Stora Kopparberg 70:1" } });
		expect(d.isError).toBe(true);
		expect(text(d)).toMatch(/delas av 3 lämningar: L2000:8956, L2000:8957, L2000:8958/);
	});

	it("lamning: post som saknas i indexet hämtas från levande källa, med anmärkning", async () => {
		const c = await connect();
		const s = (await c.client.callTool({ name: "lamning", arguments: { id: ["L1946:7415", "L2001:646"] } })).structuredContent as S;
		expect(s.lamningar.map((l: S) => l.lamningsnummer).sort()).toEqual(["L1946:7415", "L2001:646"]);
		const stugun = s.lamningar.find((l: S) => l.lamningsnummer === "L1946:7415");
		expect(stugun.hamtad_fran).toMatch(/Fornsök-appen/);
		expect(s.anmarkningar.join(" ")).toMatch(/L1946:7415: finns inte i indexet; hämtad från levande källa/);
		expect(s.reservlage).toBe(false);
		expect(c.calls.some((x) => x.url.pathname === `/open/fornsok/api/lamning/lamning/${UUID_7415}`)).toBe(true);
	});

	// ---------------------------------------------------------------- statistik, uppslag

	it("statistik: en och två nivåer, med filter", async () => {
		const c = await connect();
		const r = await c.client.callTool({ name: "statistik", arguments: { gruppera_pa: ["kategori"], kommun: ["Falun"] } });
		expect(r.isError).toBeFalsy();
		const s = r.structuredContent as S;
		expect(s).toMatchObject({ totalt: 3908, hamtad_fran: "index 2026-11-17", avkortad: false });
		expect(s.grupper.find((g: S) => g.varden[0] === "Kult, offer och folktro").antal).toBe(197);
		const t = (await c.client.callTool({ name: "statistik", arguments: { gruppera_pa: ["socken", "bedomning"], lamningstyp: ["Hyttområde"] } })).structuredContent as S;
		expect(t.grupper.every((g: S) => g.varden.length === 2)).toBe(true);
		const many = (await c.client.callTool({ name: "statistik", arguments: { gruppera_pa: ["socken", "typ"] } })).structuredContent as S;
		expect(many.avkortad).toBe(true);
		expect(many.grupper).toHaveLength(200);
		expect(many.anmarkningar.join(" ")).toMatch(/Fler än 200 grupper/);
		const eg = (await c.client.callTool({ name: "statistik", arguments: { gruppera_pa: ["typ"], egenskap: [{ typ: "Material", varde: "Koppar" }] } })).structuredContent as S;
		expect(eg.totalt).toBeGreaterThan(0);
		const bad = await c.client.callTool({ name: "statistik", arguments: { gruppera_pa: ["typ", "typ"] } });
		expect(bad.isError).toBe(true);
		expect(text(bad)).toMatch(/två olika nivåer/);
	});

	it("uppslag egenskapstyper ur indexet", async () => {
		const c = await connect();
		const s = (await c.client.callTool({ name: "uppslag", arguments: { lista: "egenskapstyper", sok: "material" } })).structuredContent as S;
		expect(s.totalt).toBeGreaterThan(0);
		const koppar = s.varden.find((v: S) => v.typ === "Material" && v.namn === "Koppar");
		expect(koppar.antal).toBeGreaterThan(0);
		expect(s.kalla).toMatch(/Lämningsindex \(D1\); index 2026-11-17/);
	});

	// ---------------------------------------------------------------- reservläge

	it("reservläge: tomt index → K-samsök och OGC, märkt", async () => {
		const empty = new DatabaseSync(":memory:");
		empty.exec(readFileSync(MIGRATION, "utf8"));
		const c = await connect({ db: d1FromSqlite(empty) });
		const s = (await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "slagg hytta", kommun: ["falun"], antal: 5 } })).structuredContent as S;
		expect(s).toMatchObject({ reservlage: true, totalt: 39, kalla: "K-samsök (levande källa)" });
		expect(s.hamtad_fran).toMatch(/^K-samsök \(reservläge: indexet är tomt \(inte laddat\)\)/);
		expect(s.anmarkningar.join(" ")).toMatch(/Reservläge: indexet är tomt/);
		const n = (await c.client.callTool({ name: "lamningar_nara", arguments: { lat: 60.66159242831314, lon: 15.554018818384327, radie_m: 500 } })).structuredContent as S;
		expect(n).toMatchObject({ reservlage: true, kalla: "RAÄ:s OGC API Features (levande källa)" });
		expect(n.lamningar[0].lamningsnummer).toBe("L2000:8802");
		const st = await c.client.callTool({ name: "statistik", arguments: { gruppera_pa: ["typ"] } });
		expect(st.isError).toBe(true);
		expect(text(st)).toMatch(/statistik kräver serverns eget lämningsindex, som inte är tillgängligt just nu \(indexet är tomt \(inte laddat\)\)/);
		empty.close();
	});

	it("reservläge: ett indexanrop som fallerar ger levande källa för sök, närhet och post", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		// Lägeskontrollen fungerar, men alla andra frågor fallerar.
		const broken = failingD1(d1FromSqlite(db), (sql) => !/synk_status|EXISTS \(SELECT 1 FROM lamning\)/.test(sql));
		const c = await connect({ db: broken });
		const s = (await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "slagg hytta", kommun: ["Falun"], antal: 5 } })).structuredContent as S;
		expect(s.reservlage).toBe(true);
		expect(s.hamtad_fran).toMatch(/reservläge: indexanropet misslyckades/);
		expect(s.totalt).toBe(39);
		// Därefter används reserven direkt en stund, utan nytt försök mot indexet.
		const n = (await c.client.callTool({ name: "lamningar_nara", arguments: { lat: 60.66159242831314, lon: 15.554018818384327, radie_m: 500 } })).structuredContent as S;
		expect(n.reservlage).toBe(true);
		const l = (await c.client.callTool({ name: "lamning", arguments: { id: ["L2001:646"] } })).structuredContent as S;
		expect(l.reservlage).toBe(true);
		expect(l.lamningar[0].hamtad_fran).toMatch(/Fornsök-appen.*reservläge/);
		expect(l.anmarkningar.join(" ")).toMatch(/Reservläge: indexanropet misslyckades/);
	});

	it("reservläge: lamning när indexet fallerar mitt i anropet", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const broken = failingD1(d1FromSqlite(db), (sql) => /SELECT \* FROM lamning WHERE uuid IN/.test(sql));
		const c = await connect({ db: broken });
		const l = (await c.client.callTool({ name: "lamning", arguments: { id: ["L2001:646"] } })).structuredContent as S;
		expect(l.lamningar).toHaveLength(1);
		expect(l.reservlage).toBe(true);
		expect(l.lamningar[0].hamtad_fran).toMatch(/Fornsök-appen/);
	});

	it("reservläge: utan D1-bindning finns inget index, och egenskapsfilter ger tydligt fel", async () => {
		const c = await connectMcp(standardRoutes());
		client = c.client;
		const eg = await c.client.callTool({ name: "sok_lamningar", arguments: { egenskap: [{ typ: "Material", varde: "Koppar" }] } });
		expect(eg.isError).toBe(true);
		expect(text(eg)).toMatch(/indexet är inte inkopplat/);
	});

	// ---------------------------------------------------------------- semantisk kanal

	function fakeSemantic(over: Partial<SemanticSearch> = {}) {
		const calls: Array<{ fraga: string; filter: ResolvedSearchFilter; topK: number }> = [];
		const sem: SemanticSearch = {
			omfang: "Dalarnas län",
			scopeCovers: (fl) => !!fl.kommun?.includes("Falun"),
			search: async (fraga, filter, topK) => {
				calls.push({ fraga, filter, topK });
				// 8802 hittas bara semantiskt; 646 av båda; 7415 ligger utanför filtret (och indexet) och ska strykas.
				return [
					{ uuid: UUID_8802, score: 0.9 },
					{ uuid: UUID_646, score: 0.8 },
					{ uuid: UUID_7415, score: 0.7 },
					{ uuid: "inte-ett-uuid", score: 0.1 },
				];
			},
			...over,
		};
		return { sem, calls };
	}

	it("semantisk kanal, auto: ordsök och semantisk sökning slås ihop (RRF), träffar utanför filtret stryks", async () => {
		const { sem, calls } = fakeSemantic();
		const c = await connect({ semantic: sem });
		expect(c.client.getInstructions()).toMatch(/Semantisk sökning .* finns bara för Dalarnas län/);
		const s = (await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "önskekälla", kommun: ["Falun"] } })).structuredContent as S;
		expect(s.sokkanaler).toEqual(["ord", "betydelse"]);
		expect(s.traffar.map((t: S) => t.lamningsnummer)).toEqual(["L2001:646", "L2000:8802"]);
		expect(s.traffar[0].kanaler).toEqual(["ord", "betydelse"]);
		expect(s.traffar[1].kanaler).toEqual(["betydelse"]);
		expect(s.totalt).toBe(2);
		expect(calls[0]).toMatchObject({ fraga: "önskekälla", topK: 100 });
		expect(calls[0].filter.kommun).toEqual(["Falun"]);
	});

	it("semantisk kanal: utanför omfånget bara ordsök; betydelse ger fel som förklarar omfånget", async () => {
		const { sem, calls } = fakeSemantic();
		const c = await connect({ semantic: sem });
		const s = (await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "önskekälla" } })).structuredContent as S;
		expect(s.sokkanaler).toEqual(["ord"]);
		expect(calls).toHaveLength(0);
		const b = await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "önskekälla", lage: "betydelse" } });
		expect(b.isError).toBe(true);
		expect(text(b)).toMatch(/Semantisk sökning gäller bara Dalarnas län/);
		const ord = (await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "önskekälla", kommun: ["Falun"], lage: "ord" } })).structuredContent as S;
		expect(ord.sokkanaler).toEqual(["ord"]);
		expect(calls).toHaveLength(0);
	});

	it("semantisk kanal, betydelse: bara semantiska träffar, kontrollerade mot filtret", async () => {
		const { sem } = fakeSemantic();
		const c = await connect({ semantic: sem });
		const s = (await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "platser där man offrat", kommun: ["Falun"], lage: "betydelse" } })).structuredContent as S;
		expect(s.sokkanaler).toEqual(["betydelse"]);
		expect(s.traffar.map((t: S) => t.lamningsnummer)).toEqual(["L2000:8802", "L2001:646"]);
		expect(s.totalt).toBe(2);
		// Med ett filter som stryker 8802 (typ) blir bara 646 kvar.
		const t = (await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "offer", kommun: ["Falun"], lamningstyp: ["Källa med tradition"], lage: "betydelse" } })).structuredContent as S;
		expect(t.traffar.map((x: S) => x.lamningsnummer)).toEqual(["L2001:646"]);
	});

	it("semantisk kanal som fallerar: auto faller tillbaka på ordsök, betydelse ger fel", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { sem } = fakeSemantic({
			search: async () => {
				throw new Error("Vectorize nere");
			},
		});
		const c = await connect({ semantic: sem });
		const s = (await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "önskekälla", kommun: ["Falun"] } })).structuredContent as S;
		expect(s.sokkanaler).toEqual(["ord"]);
		expect(s.totalt).toBe(1);
		expect(s.anmarkningar.join(" ")).toMatch(/semantiska kanalen svarade inte/);
		const b = await c.client.callTool({ name: "sok_lamningar", arguments: { fraga: "önskekälla", kommun: ["Falun"], lage: "betydelse" } });
		expect(b.isError).toBe(true);
		expect(text(b)).toMatch(/semantiska sökningen svarade inte/);
	});
});
