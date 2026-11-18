/**
 * Incheckat testurval (test/fixtures/falun-urval.sql, 300 verkliga lämningar ur
 * Falu kommun, CC0) i en minnesdatabas med alla migreringar. Kräver ingen
 * nedladdning: testerna som använder det körs alltid.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "../../ingest/sink.ts";
import { fullRecomputeSql } from "../../src/store/omraden";

export const URVAL_SQL = join(__dirname, "../fixtures/falun-urval.sql");

export function loadUrval(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	applyMigrations(db);
	db.exec(readFileSync(URVAL_SQL, "utf8"));
	for (const s of fullRecomputeSql()) db.exec(s);
	return db;
}
