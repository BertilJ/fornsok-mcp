/**
 * Facit för de omskrivna indexfrågorna (`+f.rowid IN`, CROSS JOIN, låst
 * kopplingsordning, materialiserad mängd i statistik): samma filter räknas
 * naivt i JS ur hela testurvalet (300 lämningar, test/fixtures/falun-urval.sql)
 * och jämförs med IndexStore – antal, sidornas innehåll och ordning, och
 * statistikens grupper. FTS5 används bara för det uppenbara: vilka rader en
 * MATCH träffar och deras bm25 (som inte beror på filtret).
 */
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nearestPoint, wgsToSweref, type Geometry } from "../../src/geo/geometry";
import { buildFtsQuery, IndexStore, type IndexSearchFilter, type StatistikDimension } from "../../src/store/index";
import { checkedPlanar } from "../../src/store/spatial";
import { d1FromSqlite } from "./d1-adapter";
import { loadUrval } from "./urval-fixture";

interface L {
	id: number;
	uuid: string;
	lamningsnummer: string | null;
	raa_sok: string | null;
	lamningstyp: string | null;
	bedomning: string | null;
	geometri: string | null;
	omr: Array<{ niva: string; namn: string; lan: string }>;
	kategorier: string[];
	egenskaper: Array<{ typ: string; varde: string }>;
}

let raw: DatabaseSync;
let store: IndexStore;
let alla: L[];

function las(): L[] {
	const lam = raw.prepare("SELECT id, uuid, lamningsnummer, raa_sok, lamningstyp, bedomning, geometri FROM lamning").all() as unknown as L[];
	const omr = raw.prepare("SELECT lo.lamning_id AS id, o.niva, o.namn, o.lan FROM lamning_omrade lo JOIN omrade o ON o.id = lo.omrade_id").all() as Array<{ id: number; niva: string; namn: string; lan: string }>;
	const kat = raw.prepare("SELECT lamningstyp, kategori FROM lamningstyp_kategori").all() as Array<{ lamningstyp: string; kategori: string }>;
	const eg = raw.prepare("SELECT lamning_id AS id, typ, varde FROM egenskap").all() as Array<{ id: number; typ: string; varde: string }>;
	for (const l of lam) {
		l.omr = omr.filter((o) => o.id === l.id).map(({ niva, namn, lan }) => ({ niva, namn, lan }));
		l.kategorier = kat.filter((k) => k.lamningstyp === l.lamningstyp).map((k) => k.kategori);
		l.egenskaper = eg.filter((e) => e.id === l.id).map(({ typ, varde }) => ({ typ, varde }));
	}
	return lam;
}

/** Lämningsnummerordning: år, sedan löpnummer som tal; id sist. */
function nummerOrdning(a: L, b: L): number {
	const pa = /^L(\d{4}):(\d+)$/.exec(a.lamningsnummer ?? "");
	const pb = /^L(\d{4}):(\d+)$/.exec(b.lamningsnummer ?? "");
	if (pa && pb) return Number(pa[1]) - Number(pb[1]) || Number(pa[2]) - Number(pb[2]) || a.id - b.id;
	return a.id - b.id;
}

function avstand(l: L, lat: number, lon: number): number {
	const g = JSON.parse(l.geometri ?? "null") as Geometry | null;
	if (!g) return Number.POSITIVE_INFINITY;
	return nearestPoint(checkedPlanar(lat, lon), wgsToSweref(g)).distance;
}

/** Naiv tolkning av filtret: en lämning i taget. */
function naiv(f: IndexSearchFilter): { ids: number[]; dist: Map<number, number> } {
	const fts = buildFtsQuery(f.fraga ?? null, f.ord ?? null);
	const rank = new Map<number, number>();
	if (fts) for (const r of raw.prepare("SELECT rowid AS id, bm25(lamning_fts, 4.0, 4.0, 1.0, 2.0, 0.5) AS r FROM lamning_fts WHERE lamning_fts MATCH ?").all(fts.match) as Array<{ id: number; r: number }>) rank.set(r.id, r.r);
	const har = (l: L, niva: string, namn: string[]) => l.omr.some((o) => o.niva === niva && namn.includes(o.namn));
	const dist = new Map<number, number>();
	const ut = alla.filter((l) => {
		if (fts && !rank.has(l.id)) return false;
		if (f.lamningstyp && !f.lamningstyp.includes(l.lamningstyp ?? "")) return false;
		if (f.kategori && !l.kategorier.some((k) => f.kategori?.includes(k))) return false;
		if (f.antikvarisk_bedomning && !f.antikvarisk_bedomning.includes(l.bedomning as never)) return false;
		if (f.lan && !har(l, "lan", f.lan)) return false;
		if (f.kommun && !har(l, "kommun", f.kommun)) return false;
		if (f.landskap && !har(l, "landskap", f.landskap)) return false;
		if (f.socken && !f.socken.some((s) => l.omr.some((o) => o.niva === "socken" && o.namn === s.namn && (!s.lan?.length || o.lan === "" || s.lan.includes(o.lan))))) return false;
		if (f.nummer && !f.nummer.some((n) => n === l.lamningsnummer || n.toLowerCase() === l.raa_sok)) return false;
		if (f.egenskap) {
			const typer = new Set(f.egenskap.map((e) => e.typ));
			for (const t of typer) if (!l.egenskaper.some((e) => e.typ === t && f.egenskap?.some((x) => x.typ === t && x.varde === e.varde))) return false;
		}
		if (f.nara) {
			const d = avstand(l, f.nara.lat, f.nara.lon);
			if (!(d <= f.nara.radie_m)) return false;
			dist.set(l.id, d);
		}
		return true;
	});
	if (fts) ut.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0) || a.id - b.id);
	else if (f.nara) ut.sort((a, b) => (dist.get(a.id) ?? 0) - (dist.get(b.id) ?? 0) || a.id - b.id);
	else ut.sort(nummerOrdning);
	return { ids: ut.map((l) => l.id), dist };
}

const HYTTAN = { lat: 60.66159242831314, lon: 15.554018818384327 };

const FALL: Array<[string, IndexSearchFilter]> = [
	["inget filter", {}],
	["kommun", { kommun: ["Falun"] }],
	["kommun Leksand", { kommun: ["Leksand"] }],
	["socken", { socken: [{ namn: "Bjursås" }] }],
	["två socknar, en med län", { socken: [{ namn: "Leksand" }, { namn: "Ål", lan: ["Dalarna"] }] }],
	["län och landskap", { lan: ["Dalarna"], landskap: ["Dalarna"] }],
	["typ", { lamningstyp: ["Fäbod", "Gruvområde"] }],
	["kategori och bedömning", { kategori: ["Metallframställning och bergsbruk"], antikvarisk_bedomning: ["Fornlämning", "Övrig kulturhistorisk lämning"] }],
	["kategori, socken", { kategori: ["Bebyggelselämningar"], socken: [{ namn: "Stora Kopparberg" }] }],
	["egenskap, en typ två värden", { egenskap: [{ typ: "Form", varde: "Rund" }, { typ: "Form", varde: "Oregelbunden" }] }],
	["egenskap, två typer", { egenskap: [{ typ: "Typ", varde: "Gruvhål" }, { typ: "Form", varde: "Oregelbunden" }] }],
	["nummer", { nummer: ["L2001:646", "Stora Kopparberg 172:1"] }],
	["ord", { ord: ["och"] }],
	["ord, prefix", { ord: ["käll*"] }],
	["två ord", { ord: ["sten", "och"] }],
	["ord och kommun", { ord: ["och"], kommun: ["Falun"] }],
	["ord, socken och bedömning", { ord: ["och"], socken: [{ namn: "Bjursås" }], antikvarisk_bedomning: ["Fornlämning"] }],
	["ord och egenskap", { ord: ["och"], egenskap: [{ typ: "Typ", varde: "Gruvhål" }] }],
	["ord och kategori", { ord: ["väg*"], kategori: ["Kommunikations-/maritima lämningar"] }],
	["nara", { nara: { ...HYTTAN, radie_m: 3000 } }],
	["nara och typ", { nara: { ...HYTTAN, radie_m: 5000 }, kategori: ["Metallframställning och bergsbruk"] }],
	["nara och ord", { nara: { ...HYTTAN, radie_m: 5000 }, ord: ["och"] }],
	["inget träffar", { ord: ["och"], lamningstyp: ["Fäbod"], socken: [{ namn: "Ål" }] }],
];

describe("indexfrågorna mot ett naivt facit (testurvalet, alltid)", () => {
	beforeAll(() => {
		raw = loadUrval();
		store = new IndexStore(d1FromSqlite(raw));
		alla = las();
	});
	afterAll(() => raw.close());

	it("urvalet räcker för att pröva något", () => {
		expect(alla).toHaveLength(300);
		expect(naiv({ ord: ["och"] }).ids.length).toBeGreaterThan(20);
		expect(naiv({ nara: { ...HYTTAN, radie_m: 3000 } }).ids.length).toBeGreaterThan(5);
	});

	it.each(FALL)("searchIndex: %s – antal, varje sida och ordningen", async (_namn, f) => {
		const facit = naiv(f);
		const uuidFor = new Map(alla.map((l) => [l.id, l.uuid]));
		const antal = 7;
		const sidor = Math.ceil(facit.ids.length / antal) + 1;
		for (let sida = 1; sida <= Math.max(2, sidor); sida++) {
			const r = await store.searchIndex(f, { antal, sida });
			expect(r.totalt).toBe(facit.ids.length);
			const vantat = facit.ids.slice((sida - 1) * antal, sida * antal);
			expect(r.traffar.map((t) => t.uuid)).toEqual(vantat.map((id) => uuidFor.get(id)));
			if (f.nara) for (const t of r.traffar) expect(t.avstand_m).toBe(Math.round(facit.dist.get(alla.find((l) => l.uuid === t.uuid)!.id)!));
		}
	});

	it.each(FALL)("searchRanked: %s – samma ordning som facit", async (_namn, f) => {
		const facit = naiv(f);
		const r = await store.searchRanked(f, 40);
		expect(r.totalt).toBe(facit.ids.length);
		expect(r.ids.map((x) => x.uuid)).toEqual(facit.ids.slice(0, 40).map((id) => alla.find((l) => l.id === id)!.uuid));
	});

	const NIVAER: StatistikDimension[][] = [["typ"], ["kategori"], ["bedomning"], ["socken"], ["kommun"], ["lan"], ["landskap"], ["socken", "typ"], ["kategori", "kommun"], ["bedomning", "socken"]];
	it.each(FALL)("statistik: %s – alla grupperingar", async (_namn, f) => {
		const facit = naiv(f);
		const valda = facit.ids.map((id) => alla.find((l) => l.id === id)!);
		for (const dims of NIVAER) {
			const varden = (l: L, d: StatistikDimension): string[] => {
				if (d === "typ") return [l.lamningstyp ?? "(saknas)"];
				if (d === "bedomning") return [l.bedomning ?? "(saknas)"];
				if (d === "kategori") return l.kategorier.length ? l.kategorier : ["(saknas)"];
				const o = l.omr.filter((x) => x.niva === d).map((x) => (x.lan ? `${x.namn} (${x.lan})` : x.namn));
				return o.length ? [...new Set(o)] : ["(saknas)"];
			};
			const grupper = new Map<string, number>();
			for (const l of valda) {
				const kombinationer = dims.length === 1 ? varden(l, dims[0]).map((v) => [v]) : varden(l, dims[0]).flatMap((a) => varden(l, dims[1]).map((b) => [a, b]));
				for (const k of kombinationer) grupper.set(JSON.stringify(k), (grupper.get(JSON.stringify(k)) ?? 0) + 1);
			}
			const vantat = [...grupper].map(([k, antal]) => ({ varden: JSON.parse(k) as string[], antal }));
			vantat.sort((x, y) => y.antal - x.antal || x.varden.join("\u0001").localeCompare(y.varden.join("\u0001")));
			const s = await store.statistik(dims, f);
			expect(s.totalt, dims.join("×")).toBe(facit.ids.length);
			expect(s.grupper, dims.join("×")).toEqual(vantat.slice(0, 200));
		}
	});
});
