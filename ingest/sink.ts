/**
 * Mottagare för SQL-satser: filer för `wrangler d1 execute --remote --file`,
 * eller direkt mot en lokal SQLite-fil (samma satser, så att den lokala
 * databasen blir likadan som D1).
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { SqlSink } from "./sql.ts";

export const MIGRATION = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "0001_init.sql");

export interface FileInfo {
	namn: string;
	byte: number;
	satser: number;
}

/** Skriver satserna till numrerade filer och byter fil mellan omgångar när storleken nåtts. */
export class FileSink implements SqlSink {
	files: FileInfo[] = [];
	private fd: number | null = null;
	private cur: FileInfo | null = null;
	private seen = new Set<string>();
	private n = 0;
	readonly dir: string;
	readonly maxFileBytes: number;

	constructor(dir: string, maxFileBytes: number) {
		this.dir = dir;
		this.maxFileBytes = maxFileBytes;
		mkdirSync(dir, { recursive: true });
		// Ta bort gamla filer från en tidigare körning (bara våra egna namn).
		for (const f of readdirSync(dir)) if (/^\d{4}_[a-z]+\.sql$/.test(f) || f === "manifest.json") rmSync(join(dir, f));
	}

	/** Börja en ny fil med ett namn (t.ex. "huvud", "data", "synk"). */
	open(kind: string) {
		this.closeFile();
		const namn = `${String(this.n++).padStart(4, "0")}_${kind}.sql`;
		this.fd = openSync(join(this.dir, namn), "w");
		this.cur = { namn, byte: 0, satser: 0 };
		this.files.push(this.cur);
		this.seen.clear();
		this.write(`-- Fornsök MCP, inläsning: ${namn}. Idempotent; kan köras om.\n`);
	}

	private write(s: string) {
		if (this.fd === null || !this.cur) throw new Error("ingen öppen fil");
		const b = Buffer.from(s, "utf8");
		writeSync(this.fd, b);
		this.cur.byte += b.byteLength;
	}

	beginBatch() {
		if (!this.cur || !this.cur.namn.endsWith("_data.sql") || this.cur.byte >= this.maxFileBytes) this.open("data");
	}

	omradeSeen(key: string): boolean {
		if (this.seen.has(key)) return true;
		this.seen.add(key);
		return false;
	}

	emit(statement: string) {
		if (!this.cur) this.open("data");
		this.write(`${statement}\n`);
		(this.cur as FileInfo).satser++;
	}

	private closeFile() {
		if (this.fd !== null) closeSync(this.fd);
		this.fd = null;
		this.cur = null;
	}

	close() {
		this.closeFile();
	}
}

/** Kör satserna direkt mot en lokal SQLite-fil, i transaktioner. */
export class DbSink implements SqlSink {
	readonly db: DatabaseSync;
	private seen = new Set<string>();
	private batches = 0;
	private inTx = false;
	statements = 0;
	readonly batchesPerTx: number;

	constructor(path: string, opts: { recreate?: boolean } = {}, batchesPerTx = 50) {
		this.batchesPerTx = batchesPerTx;
		if (opts.recreate) for (const suffix of ["", "-wal", "-shm", "-journal"]) if (existsSync(path + suffix)) rmSync(path + suffix);
		mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		// D1 har främmande nycklar påslagna som standard (workerd SQLITE_DEFAULT_FOREIGN_KEYS=1).
		this.db.exec("PRAGMA foreign_keys = ON");
		this.db.exec(readFileSync(MIGRATION, "utf8"));
	}

	beginBatch() {
		if (!this.inTx) {
			this.db.exec("BEGIN");
			this.inTx = true;
		}
		if (++this.batches % this.batchesPerTx === 0) {
			this.db.exec("COMMIT");
			this.db.exec("BEGIN");
		}
	}

	omradeSeen(key: string): boolean {
		if (this.seen.has(key)) return true;
		this.seen.add(key);
		return false;
	}

	emit(statement: string) {
		this.db.exec(statement);
		this.statements++;
	}

	close() {
		if (this.inTx) this.db.exec("COMMIT");
		this.inTx = false;
		this.db.close();
	}
}

/** Kör en SQL-fil (som `wrangler d1 execute --file` gör) mot en lokal databas; för test. */
export function execSqlFile(db: DatabaseSync, path: string) {
	db.exec(readFileSync(path, "utf8"));
}
