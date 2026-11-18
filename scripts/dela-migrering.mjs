#!/usr/bin/env node
/**
 * Delar en migrering i en fil per sats, för `wrangler d1 execute --file` en i
 * taget när `wrangler d1 migrations apply` stryps av D1 (tidsgräns 30 s per
 * fråga, strypning vid för mycket arbete inom 10 s).
 *
 *   node scripts/dela-migrering.mjs migrations/0003_omraden.sql <utkatalog>
 *   for f in <utkatalog>/*.sql; do npx wrangler d1 execute <databas> --remote -c <konfig> --file "$f" -y || break; sleep 5; done
 *   npx wrangler d1 migrations apply <databas> --remote -c <konfig>   # bokför migreringen; satserna hoppar över det som redan är gjort
 *
 * Satserna i 0003 är idempotenta och räknar bara det som saknas, så en körning
 * som avbryts kan fortsätta från den fil som fallerade.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [src, ut] = process.argv.slice(2);
if (!src || !ut) {
	console.error("Användning: node scripts/dela-migrering.mjs <migrering.sql> <utkatalog>");
	process.exit(2);
}
const sql = readFileSync(src, "utf8")
	.split("\n")
	.filter((l) => !l.trimStart().startsWith("--"))
	.join("\n");
const satser = sql
	.split(/;\s*\n/)
	.map((s) => s.trim())
	.filter(Boolean);
mkdirSync(ut, { recursive: true });
for (const f of readdirSync(ut)) if (/^\d{3}\.sql$/.test(f)) rmSync(join(ut, f));
satser.forEach((s, i) => writeFileSync(join(ut, `${String(i).padStart(3, "0")}.sql`), `${s.replace(/;$/, "")};\n`));
console.error(`${satser.length} satser → ${ut}`);
