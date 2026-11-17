/**
 * Laddar Falu kommuns GeoPackage (ingest/.cache/falun.gpkg) till en temporär
 * SQLite-fil via migreringen och inläsningsflödet. Filen laddas ned separat
 * (se ingest/cli.ts); saknas den hoppar testerna över sig själva.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

export function loadFalun(): LoadedFalun {
	const dir = mkdtempSync(join(tmpdir(), "fornsok-falun-"));
	const path = join(dir, "falun.sqlite");
	const result = load(FALUN_GPKG, new DbSink(path, { recreate: true }));
	return {
		dir,
		path,
		result,
		open: () => new DatabaseSync(path),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}
