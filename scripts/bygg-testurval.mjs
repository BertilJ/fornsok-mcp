#!/usr/bin/env node
/**
 * Bygger test/fixtures/falun-urval.sql: ett litet, incheckat urval verkliga
 * lämningar ur Falu kommuns GeoPackage (CC0), så att sök via indexet,
 * sammanslagen sökning, sidindelning och filtrering av semantiska träffar
 * alltid testas – även i en ren kopia utan ingest/.cache/falun.gpkg.
 *
 *   node ingest/cli.ts lokal ingest/.cache/falun.gpkg --db /tmp/falun.sqlite --ny
 *   node scripts/bygg-testurval.mjs /tmp/falun.sqlite
 *
 * Urvalet: socknen Bjursås (med L2001:646) och lämningarna närmast
 * L2000:8802 (hyttområdet i Falun), högst 300 sammanlagt.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const src = process.argv[2];
if (!src) {
	console.error("Användning: node scripts/bygg-testurval.mjs <falun.sqlite>");
	process.exit(2);
}
const db = new DatabaseSync(src, { readOnly: true });
const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);

const bjursas = all(
	"SELECT l.id FROM lamning l JOIN lamning_omrade lo ON lo.lamning_id = l.id JOIN omrade o ON o.id = lo.omrade_id WHERE o.niva = 'socken' AND o.namn = 'Bjursås' ORDER BY (l.lamningsnummer = 'L2001:646') DESC, l.id LIMIT 200",
).map((r) => r.id);
const h = one("SELECT e, n FROM lamning WHERE lamningsnummer = 'L2000:8802'");
const nara = all("SELECT id FROM lamning ORDER BY (e - ?) * (e - ?) + (n - ?) * (n - ?) LIMIT 100", h.e, h.e, h.n, h.n).map((r) => r.id);
const ids = [...new Set([...bjursas, ...nara])];
const idList = ids.join(",");

const lit = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const out = ["-- Testurval ur Falu kommuns GeoPackage (RAÄ, Kulturmiljöregistret, CC0). Genererad av scripts/bygg-testurval.mjs; ändra inte för hand."];
const dump = (table, rows) => {
	for (const r of rows) out.push(`INSERT INTO ${table} (${Object.keys(r).join(", ")}) VALUES (${Object.values(r).map(lit).join(", ")});`);
};
const omraden = all(`SELECT DISTINCT o.* FROM omrade o JOIN lamning_omrade lo ON lo.omrade_id = o.id WHERE lo.lamning_id IN (${idList}) ORDER BY o.id`);
dump("omrade", omraden);
dump("lamning", all(`SELECT * FROM lamning WHERE id IN (${idList}) ORDER BY id`));
dump("lamning_omrade", all(`SELECT * FROM lamning_omrade WHERE lamning_id IN (${idList}) ORDER BY lamning_id, omrade_id`));
dump("egenskap", all(`SELECT * FROM egenskap WHERE lamning_id IN (${idList}) ORDER BY rowid`));
dump("ingaende", all(`SELECT * FROM ingaende WHERE lamning_id IN (${idList}) ORDER BY rowid`));
dump("lamningstyp_kategori", all("SELECT * FROM lamningstyp_kategori ORDER BY lamningstyp, kategori"));
dump("synk_status", all("SELECT * FROM synk_status WHERE nyckel IN ('uttagsdatum', 'senaste_grundladdning') ORDER BY nyckel"));
const path = join(import.meta.dirname, "..", "test", "fixtures", "falun-urval.sql");
writeFileSync(path, `${out.join("\n")}\n`);
console.error(`${ids.length} lämningar, ${out.length} satser → ${path}`);
