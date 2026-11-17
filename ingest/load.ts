/**
 * Inläsningsflödet: GeoPackage → indexposter → SQL-satser → mottagare
 * (filer eller lokal SQLite). Även avstämning mot en befintlig laddning.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { avstamning, GpkgReader, newStats, type ReadStats } from "./read.ts";
import type { Referens } from "./referens.ts";
import { FileSink } from "./sink.ts";
import { batchStatements, deleteLamningar, kategoriStatements, type SqlSink, synkStatements } from "./sql.ts";
import { contentHash, type IndexPost, Indelning, toIndexPost } from "./transform.ts";

export const DEFAULT_REFERENS = join(dirname(fileURLToPath(import.meta.url)), "data", "referens.json");
export const BATCH_SIZE = 200;

export function loadReferens(path: string | null = DEFAULT_REFERENS): Referens | null {
	if (!path || !existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf8")) as Referens;
}

export interface LoadResult {
	stats: ReadStats;
	uttagsdatum: string | null;
	utanLandskap: number;
	sekunder: number;
}

function header(sink: SqlSink, ref: Referens | null) {
	if (sink instanceof FileSink) sink.open("huvud");
	if (ref) for (const s of kategoriStatements(ref.lamningstyper)) sink.emit(s);
}

function footer(sink: SqlSink, info: Parameters<typeof synkStatements>[0]) {
	if (sink instanceof FileSink) sink.open("synk");
	for (const s of synkStatements(info)) sink.emit(s);
}

/** Fel när källans antal inte stämmer med det som lästes (se avstamning i read.ts). */
export class AvstamningError extends Error {
	readonly avvikelser: string[];
	constructor(avvikelser: string[]) {
		super(`Avstämningen mot källan misslyckades:\n- ${avvikelser.join("\n- ")}`);
		this.name = "AvstamningError";
		this.avvikelser = avvikelser;
	}
}

function checkCounts(stats: ReadStats) {
	const avvikelser = avstamning(stats);
	if (avvikelser.length) throw new AvstamningError(avvikelser);
}

/** Läs hela filen till mottagaren (grundladdning). Avbryter med AvstamningError om antalen inte stämmer. */
export function load(gpkgPath: string, sink: SqlSink, opts: { referens?: Referens | null; log?: (s: string) => void } = {}): LoadResult {
	const t0 = Date.now();
	const startad = new Date().toISOString();
	const ref = opts.referens === undefined ? loadReferens() : opts.referens;
	const indelning = new Indelning(ref);
	const reader = new GpkgReader(gpkgPath);
	const stats = newStats();
	try {
		header(sink, ref);
		let batch: IndexPost[] = [];
		for (const p of reader.posts(stats)) {
			batch.push(toIndexPost(p, indelning));
			if (batch.length >= BATCH_SIZE) {
				batchStatements(batch, sink);
				batch = [];
				if (opts.log && stats.lamningar % 20000 === 0) opts.log(`${stats.lamningar} lämningar …`);
			}
		}
		batchStatements(batch, sink);
		// Avstämning före synkraden: avviker antalen skrivs ingen synk_status, och laddningen räknas som misslyckad.
		checkCounts(stats);
		footer(sink, {
			typ: "grundladdning",
			startad,
			klar: new Date().toISOString(),
			kalla: `GeoPackage ${basename(gpkgPath)}`,
			uttagsdatum: reader.uttagsdatum,
			nya: stats.lamningar,
			andrade: 0,
			borttagna: 0,
		});
	} finally {
		sink.close();
		reader.close();
	}
	return { stats, uttagsdatum: reader.uttagsdatum, utanLandskap: indelning.utanLandskap, sekunder: (Date.now() - t0) / 1000 };
}

// ---------------------------------------------------------------- avstämning

export interface DiffResult {
	nya: string[];
	andrade: string[];
	borttagna: string[];
	oforandrade: number;
	stats: ReadStats;
}

/** Läs uuid → hash ur en lokal laddning. */
export function hashesFromSqlite(path: string): Map<string, string> {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const out = new Map<string, string>();
		for (const r of db.prepare("SELECT uuid, hash FROM lamning").iterate() as Iterable<{ uuid: string; hash: string }>)
			out.set(r.uuid, r.hash);
		return out;
	} finally {
		db.close();
	}
}

/**
 * Läs uuid → hash ur utdata från `wrangler d1 execute --json` (en eller flera
 * filer; se `hashfragor`). Formatet är en lista av { results: [...] }.
 */
export function hashesFromWranglerJson(paths: string[]): Map<string, string> {
	const out = new Map<string, string>();
	const visit = (x: unknown) => {
		if (Array.isArray(x)) for (const y of x) visit(y);
		else if (x && typeof x === "object") {
			const o = x as Record<string, unknown>;
			if (typeof o.uuid === "string" && typeof o.hash === "string") out.set(o.uuid, o.hash);
			else if (Array.isArray(o.results)) visit(o.results);
		}
	};
	for (const p of paths) visit(JSON.parse(readFileSync(p, "utf8")));
	return out;
}

/** wrangler-kommandon som hämtar hasharna i delar under D1:s gräns på 50 MB per svar. */
export function hashQueries(database: string): string[] {
	const hex = "0123456789abcdef";
	return [...hex].map((c, i) => {
		const cond = i < 15 ? `uuid >= '${c}' AND uuid < '${hex[i + 1]}'` : `uuid >= '${c}'`;
		return `npx wrangler d1 execute ${database} --remote --json --command "SELECT uuid, hash FROM lamning WHERE ${cond}" > hash_${c}.json`;
	});
}

/**
 * Jämför filen mot en befintlig laddning. Med `sink` skrivs SQL som rättar
 * avvikelserna: nya och ändrade skrivs om, borttagna raderas.
 */
export function diff(
	gpkgPath: string,
	existing: Map<string, string>,
	opts: { sink?: SqlSink; referens?: Referens | null } = {},
): DiffResult {
	const startad = new Date().toISOString();
	const ref = opts.referens === undefined ? loadReferens() : opts.referens;
	const indelning = new Indelning(ref);
	const reader = new GpkgReader(gpkgPath);
	const stats = newStats();
	const res: DiffResult = { nya: [], andrade: [], borttagna: [], oforandrade: 0, stats };
	const seen = new Set<string>();
	const sink = opts.sink;
	try {
		if (sink) header(sink, ref);
		let batch: IndexPost[] = [];
		for (const p of reader.posts(stats)) {
			seen.add(p.uuid);
			const old = existing.get(p.uuid);
			const h = contentHash(p);
			if (old === h) {
				res.oforandrade++;
				continue;
			}
			(old === undefined ? res.nya : res.andrade).push(p.uuid);
			if (sink) {
				batch.push(toIndexPost(p, indelning));
				if (batch.length >= BATCH_SIZE) {
					batchStatements(batch, sink);
					batch = [];
				}
			}
		}
		// En lämning som tappats vid läsningen får aldrig tolkas som borttagen.
		checkCounts(stats);
		for (const u of existing.keys()) if (!seen.has(u)) res.borttagna.push(u);
		res.borttagna.sort();
		if (sink) {
			batchStatements(batch, sink);
			if (res.borttagna.length) {
				sink.beginBatch();
				for (const s of deleteLamningar(res.borttagna)) sink.emit(s);
			}
			footer(sink, {
				typ: "avstamning",
				startad,
				klar: new Date().toISOString(),
				kalla: `GeoPackage ${basename(gpkgPath)}`,
				uttagsdatum: reader.uttagsdatum,
				nya: res.nya.length,
				andrade: res.andrade.length,
				borttagna: res.borttagna.length,
			});
		}
	} finally {
		sink?.close();
		reader.close();
	}
	return res;
}
