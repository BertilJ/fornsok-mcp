/**
 * Laddar Falu kommuns GeoPackage (ingest/.cache/falun.gpkg) till en temporär
 * SQLite-fil via migreringen och inläsningsflödet. Filen laddas ned separat
 * (se ingest/cli.ts); saknas den hoppar testerna över sig själva.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { load, type LoadResult } from "../../ingest/load.ts";
import { DbSink } from "../../ingest/sink.ts";

export const FALUN_GPKG = resolve(__dirname, "../../ingest/.cache/falun.gpkg");
export const HAS_FALUN = existsSync(FALUN_GPKG);
export const SKIP_MESSAGE = `Hoppar över: ${FALUN_GPKG} saknas. Ladda ned Falu kommuns GeoPackage dit (se ingest/cli.ts).`;

if (!HAS_FALUN) console.warn(SKIP_MESSAGE);

export interface LoadedFalun {
	dir: string;
	path: string;
	result: LoadResult;
	open(): DatabaseSync;
	cleanup(): void;
}

/** Migreringarna efter 0001 (0001 körs av inläsningen), i ordning – samma schema som i drift. */
export const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
export function laterMigrations(): string[] {
	return readdirSync(MIGRATIONS_DIR)
		.filter((f) => /^\d{4}_.*\.sql$/.test(f) && !f.startsWith("0001_"))
		.sort()
		.map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
}

export function loadFalun(): LoadedFalun {
	const dir = mkdtempSync(join(tmpdir(), "fornsok-falun-"));
	const path = join(dir, "falun.sqlite");
	const result = load(FALUN_GPKG, new DbSink(path, { recreate: true }));
	const db = new DatabaseSync(path);
	for (const sql of laterMigrations()) db.exec(sql);
	db.close();
	return {
		dir,
		path,
		result,
		open: () => new DatabaseSync(path),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}
