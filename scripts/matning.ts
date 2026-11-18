/**
 * Mätning av indexets frågor mot en lokal laddning av hela landet (problem i
 * full skala syns inte mot Falun eller Dalarna).
 *
 *   node ingest/cli.ts lokal <lamningar_sverige.gpkg> --db ingest/.cache/sverige.sqlite --ny
 *   node scripts/matning.ts [--db ingest/.cache/sverige.sqlite] [--src <rot>] [--bara <delsträng>] [--utom <a,b>] [--plan]
 *
 * Varje fall körs en gång kallt och sedan tre gånger; bästa och kalla tiden
 * skrivs ut i millisekunder, med antal frågor och träffar. `--src` pekar på en
 * annan kodrot (t.ex. en utpackad äldre version) för före/efter-jämförelse.
 * `--plan` skriver EXPLAIN QUERY PLAN för varje fråga som körs.
 *
 * Lokal SQLite är snabbare än D1; tiderna är en undre gräns.
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (e) {
			if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]s$/.test(specifier)) {
				return nextResolve(`${specifier}.ts`, context);
			}
			throw e;
		}
	},
});

const argv = process.argv.slice(2);
const opt = (k: string) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
const ROOT = resolve(import.meta.dirname, "..");
const dbPath = resolve(opt("db") ?? resolve(ROOT, "ingest/.cache/sverige.sqlite"));
const srcRoot = resolve(opt("src") ?? ROOT);
const bara = opt("bara");
const utom = opt("utom");
const plan = argv.includes("--plan");
if (!existsSync(dbPath)) {
	console.error(`${dbPath} saknas. Bygg den med: node ingest/cli.ts lokal <lamningar_sverige.gpkg> --db ${dbPath} --ny`);
	process.exit(2);
}

const sqlite = new DatabaseSync(dbPath, { readOnly: true });
let frågor = 0;
type Stmt = { bind(...v: unknown[]): Stmt; all<T>(): Promise<{ results: T[] }>; run(): unknown[] };
const make = (sql: string, params: unknown[]): Stmt => {
	const exec = () => {
		frågor++;
		if (plan) {
			const p = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as SQLInputValue[])) as Array<{ detail: string }>;
			console.log(`    SQL: ${sql.replace(/\s+/g, " ").slice(0, 160)}\n${p.map((r) => `      ${r.detail}`).join("\n")}`);
		}
		return sqlite.prepare(sql).all(...(params as SQLInputValue[]));
	};
	return {
		bind: (...v: unknown[]) => make(sql, v),
		all: async <T>() => ({ results: exec() as T[] }),
		run: exec,
	};
};
const db = {
	prepare: (sql: string) => make(sql, []),
	batch: async (stmts: Stmt[]) => stmts.map((s) => ({ results: s.run() })),
};

const imp = (p: string) => import(pathToFileURL(resolve(srcRoot, p)).href);
const { IndexStore } = await imp("src/store/index.ts");
const hp = await imp("src/tools/hitta_plats.ts");
const store = new IndexStore(db);

const VISBY = { lat: 57.64, lon: 18.29 };
const GUPPSALA = { lat: 59.9, lon: 17.63 };
const STHLM = { lat: 59.33, lon: 18.07 };

type Fall = [string, () => Promise<unknown>];
const fall: Fall[] = [
	["sok fraga=sten", () => store.searchIndex({ ord: ["sten"] }, { antal: 15 })],
	["sok fraga=och", () => store.searchIndex({ ord: ["och"] }, { antal: 15 })],
	["sok fraga=s*", () => store.searchIndex({ ord: ["s*"] }, { antal: 15 })],
	["sok fraga=sten sida=200 (antal 50)", () => store.searchIndex({ ord: ["sten"] }, { antal: 50, sida: 200 })],
	["sok utan fraga, typ=Fornlämning-bedömning, sida=200", () => store.searchIndex({ antikvarisk_bedomning: ["Fornlämning"] }, { antal: 50, sida: 200 })],
	["sok kommun=Gotland", () => store.searchIndex({ kommun: ["Gotland"] }, { antal: 15 })],
	["sok kommun=Kiruna", () => store.searchIndex({ kommun: ["Kiruna"] }, { antal: 15 })],
	["sok kommun=Uppsala sida=200", () => store.searchIndex({ kommun: ["Uppsala"] }, { antal: 50, sida: 200 })],
	["sok fraga=sten kommun=Gotland", () => store.searchIndex({ ord: ["sten"], kommun: ["Gotland"] }, { antal: 15 })],
	["sok fraga=och lan=Uppsala", () => store.searchIndex({ ord: ["och"], lan: ["Uppsala"] }, { antal: 15 })],
	["sok fraga=hög socken=Bjursås", () => store.searchIndex({ ord: ["hög"], socken: [{ namn: "Bjursås" }] }, { antal: 15 })],
	["sok kategori=Gravar kommun=Uppsala", () => store.searchIndex({ kategori: ["Gravar"], kommun: ["Uppsala"] }, { antal: 15 })],
	["sok egenskap Material=Koppar", () => store.searchIndex({ egenskap: [{ typ: "Material", varde: "Koppar" }] }, { antal: 15 })],
	["sok egenskap Material=Sten lan=Uppsala", () => store.searchIndex({ egenskap: [{ typ: "Material", varde: "Sten" }], lan: ["Uppsala"] }, { antal: 15 })],
	["sok nummer L1946:7415", () => store.searchIndex({ nummer: ["L1946:7415"] }, { antal: 15 })],
	["sok nara Visby 500 m", () => store.searchIndex({ nara: { ...VISBY, radie_m: 500 } }, { antal: 15 })],
	["sok nara Visby 10 km", () => store.searchIndex({ nara: { ...VISBY, radie_m: 10_000 } }, { antal: 15 })],
	["sok nara Visby 20 km", () => store.searchIndex({ nara: { ...VISBY, radie_m: 20_000 } }, { antal: 15 })],
	["sok nara G:a Uppsala 10 km", () => store.searchIndex({ nara: { ...GUPPSALA, radie_m: 10_000 } }, { antal: 15 })],
	["sok nara G:a Uppsala 20 km", () => store.searchIndex({ nara: { ...GUPPSALA, radie_m: 20_000 } }, { antal: 15 })],
	["sok nara Stockholm 20 km", () => store.searchIndex({ nara: { ...STHLM, radie_m: 20_000 } }, { antal: 15 })],
	["sok fraga=och nara Visby 20 km", () => store.searchIndex({ ord: ["och"], nara: { ...VISBY, radie_m: 20_000 } }, { antal: 15 })],
	["sok fraga=sten nara G:a Uppsala 10 km", () => store.searchIndex({ ord: ["sten"], nara: { ...GUPPSALA, radie_m: 10_000 } }, { antal: 15 })],
	["searchRanked fraga=sten kommun=Falun (hybrid)", () => store.searchRanked({ ord: ["sten"], kommun: ["Falun"] }, 100)],
	["nearby Visby 500 m", () => store.nearby({ ...VISBY, radie_m: 500 })],
	["nearby Visby 10 km", () => store.nearby({ ...VISBY, radie_m: 10_000 })],
	["nearby G:a Uppsala 10 km", () => store.nearby({ ...GUPPSALA, radie_m: 10_000 })],
	["nearby Stockholm 10 km", () => store.nearby({ ...STHLM, radie_m: 10_000 })],
	["statistik typ", () => store.statistik(["typ"], {})],
	["statistik kategori", () => store.statistik(["kategori"], {})],
	["statistik bedomning", () => store.statistik(["bedomning"], {})],
	["statistik lan", () => store.statistik(["lan"], {})],
	["statistik kommun", () => store.statistik(["kommun"], {})],
	["statistik socken", () => store.statistik(["socken"], {})],
	["statistik kommun×socken", () => store.statistik(["kommun", "socken"], {})],
	["statistik lan×typ", () => store.statistik(["lan", "typ"], {})],
	["statistik kommun×typ lan=Västra Götaland", () => store.statistik(["kommun", "typ"], { lan: ["Västra Götaland"] })],
	["statistik socken×typ kommun=Gotland", () => store.statistik(["socken", "typ"], { kommun: ["Gotland"] })],
	["statistik typ kommun=Gotland", () => store.statistik(["typ"], { kommun: ["Gotland"] })],
	["statistik socken fraga=sten", () => store.statistik(["socken"], { ord: ["sten"] })],
	["statistik kommun nara Stockholm 20 km", () => store.statistik(["kommun"], { nara: { ...STHLM, radie_m: 20_000 } })],
	["statistik typ egenskap Material=Sten", () => store.statistik(["typ"], { egenskap: [{ typ: "Material", varde: "Sten" }] })],
	["egenskaper()", () => store.egenskaper()],
	[
		"lamning: resolveIdsAll + getByUuids (3 id)",
		async () => {
			const m = await store.resolveIdsAll(["L1946:7415", "Stora Kopparberg 172:1", "Bjursås 27:1"]);
			return store.getByUuids([...m.values()].flat());
		},
	],
	["hitta_plats Bjursås", () => hp.sokIndex(db, "Bjursås", null, null)],
	["hitta_plats Stora Kopparberg", () => hp.sokIndex(db, "Stora Kopparberg", null, null)],
	["hitta_plats Uppsala", () => hp.sokIndex(db, "Uppsala", null, null)],
	["hitta_plats Sten", () => hp.sokIndex(db, "Sten", null, null)],
	["hitta_plats Trollkällan", () => hp.sokIndex(db, "Trollkällan", null, null)],
	["hitta_plats Näs lan=Jämtland", () => hp.sokIndex(db, "Näs", null, "Jämtland")],
	["hitta_plats Finns-inte-alls", () => hp.sokIndex(db, "Finnsintealls", null, null)],
];

const size = (r: unknown): string => {
	if (Array.isArray(r)) return String(r.length);
	if (r instanceof Map) return String(r.size);
	if (r && typeof r === "object") {
		const o = r as Record<string, unknown>;
		if (typeof o.totalt === "number") return `${o.totalt}${o.totalt_ungefar ? "~" : ""}`;
	}
	return "";
};

console.log(`| Fall | kall ms | bästa ms | frågor | träffar |\n|---|---:|---:|---:|---:|`);
for (const [namn, f] of fall) {
	if (bara && !namn.includes(bara)) continue;
	if (utom && utom.split(",").some((u) => namn.includes(u))) continue;
	frågor = 0;
	let t = performance.now();
	let r: unknown;
	try {
		r = await f();
	} catch (e) {
		console.log(`| ${namn} | FEL: ${e instanceof Error ? e.message : String(e)} | | | |`);
		continue;
	}
	const kall = performance.now() - t;
	const q = frågor;
	let best = Number.POSITIVE_INFINITY;
	if (!plan) {
		for (let i = 0; i < 3; i++) {
			t = performance.now();
			await f();
			best = Math.min(best, performance.now() - t);
		}
	}
	console.log(`| ${namn} | ${kall.toFixed(0)} | ${Number.isFinite(best) ? best.toFixed(0) : "–"} | ${q} | ${size(r)} |`);
}
