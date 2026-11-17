/**
 * SQL för D1: idempotenta satser (upsert av lämningen, barnrader raderas och
 * skrivs om) som ryms inom D1:s gränser.
 *
 * D1-gränser (developers.cloudflare.com/d1/platform/limits, 2026-11-17):
 * - SQL-sats högst 100 000 byte → satserna hålls under MAX_STATEMENT_BYTES.
 * - Sträng/rad högst 2 MB → stora geometrier förenklas i transform.ts.
 * - Import med `wrangler d1 execute --file` högst 5 GB per fil; filerna här är
 *   mycket mindre så att en misslyckad fil kan köras om för sig.
 * - BEGIN/COMMIT får inte stå i importfiler.
 *
 * Satserna är literal-SQL (filerna kan inte bära parametrar). Alla värden går
 * genom lit(), som citerar strängar och bara släpper igenom ändliga tal.
 */
import type { IndexOmrade, IndexPost, KallEgenskap, KallIngaende, LamningRad } from "./transform.ts";
import { LAMNING_KOLUMNER } from "./transform.ts";

export const MAX_STATEMENT_BYTES = 90_000;
/** Högst så många rader i en VALUES-lista (SQLite-praxis; D1 har ingen dokumenterad gräns). */
export const MAX_ROWS_PER_STATEMENT = 400;

export type SqlValue = string | number | null;

export function lit(v: SqlValue): string {
	if (v === null || v === undefined) return "NULL";
	if (typeof v === "number") {
		if (!Number.isFinite(v)) return "NULL";
		return String(v);
	}
	// NUL kan inte stå i en SQL-sträng; text() har redan tagit bort dem, men var säker.
	// oxlint-disable-next-line no-control-regex -- NUL tas bort avsiktligt
	return `'${String(v).replace(/\u0000/g, "").replace(/'/g, "''")}'`;
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Dela upp rader (redan formaterade som "(…)") i satser under gränsen. */
export function multiRow(prefix: string, rows: string[], suffix: string, maxBytes = MAX_STATEMENT_BYTES): string[] {
	const out: string[] = [];
	let cur: string[] = [];
	let size = bytes(prefix) + bytes(suffix) + 1; // ";"
	for (const r of rows) {
		const b = bytes(r) + 2; // ",\n"
		if (cur.length && (size + b > maxBytes || cur.length >= MAX_ROWS_PER_STATEMENT)) {
			out.push(`${prefix}${cur.join(",\n")}${suffix};`);
			cur = [];
			size = bytes(prefix) + bytes(suffix) + 1;
		}
		cur.push(r);
		size += b;
	}
	if (cur.length) out.push(`${prefix}${cur.join(",\n")}${suffix};`);
	return out;
}

const UPDATE_SET = LAMNING_KOLUMNER.filter((c) => c !== "uuid")
	.map((c) => `${c} = excluded.${c}`)
	.join(", ");
const INSERT_PREFIX = `INSERT INTO lamning (${LAMNING_KOLUMNER.join(", ")}) VALUES\n`;
const INSERT_SUFFIX = `\nON CONFLICT(uuid) DO UPDATE SET ${UPDATE_SET}`;

/** Textkolumner som kan delas upp i flera UPDATE om en rad är för stor. */
const CHUNKABLE: Array<keyof LamningRad> = ["geometri", "beskrivning", "bedomning_motivering", "terrang", "orientering", "tradition"];

function rowLiteral(r: LamningRad): string {
	return `(${LAMNING_KOLUMNER.map((c) => lit(r[c] as SqlValue)).join(", ")})`;
}

/**
 * Satser för en rad som inte ryms i en sats: raden skrivs med de största
 * textkolumnerna tomma, och de fylls sedan på med `col = col || '…'`.
 */
function oversizeRow(r: LamningRad, maxBytes: number): string[] {
	const copy: LamningRad = { ...r };
	const pending: Array<[keyof LamningRad, string]> = [];
	const cols = [...CHUNKABLE].sort((a, b) => bytes(String(r[b] ?? "")) - bytes(String(r[a] ?? "")));
	for (const c of cols) {
		if (bytes(`${INSERT_PREFIX}${rowLiteral(copy)}${INSERT_SUFFIX};`) <= maxBytes) break;
		const v = r[c];
		if (typeof v === "string" && v.length) {
			pending.push([c, v]);
			(copy as unknown as Record<string, unknown>)[c] = "";
		}
	}
	const first = `${INSERT_PREFIX}${rowLiteral(copy)}${INSERT_SUFFIX};`;
	if (bytes(first) > maxBytes) throw new Error(`raden ${r.uuid} ryms inte i en sats`);
	const out = [first];
	const where = ` WHERE uuid = ${lit(r.uuid)};`;
	for (const [c, v] of pending) {
		const budget = maxBytes - 200;
		let i = 0;
		while (i < v.length) {
			// Dela på tecken (inte mitt i ett surrogatpar) inom bytebudgeten.
			let j = Math.min(v.length, i + Math.floor(budget / 4));
			while (j < v.length && bytes(lit(v.slice(i, j))) < budget - 4096) j = Math.min(v.length, j + 4096);
			while (bytes(lit(v.slice(i, j))) > budget) j = i + Math.floor((j - i) * 0.9);
			if (j < v.length && /[\ud800-\udbff]/.test(v[j - 1])) j--;
			out.push(`UPDATE lamning SET ${c} = ${c} || ${lit(v.slice(i, j))}${where}`);
			i = j;
		}
	}
	return out;
}

export interface SqlSink {
	/** Ny omgång (en grupp lämningar vars satser ska hamna i samma fil). */
	beginBatch(): void;
	/** Har omgången redan skrivit området i den aktuella filen? Markerar det. */
	omradeSeen(key: string): boolean;
	emit(statement: string): void;
	close(): void;
}

function omradeKey(o: IndexOmrade & { lan: string }) {
	return `${o.niva}\u0001${o.namn}\u0001${o.lan}`;
}

/** Barnrader och områden raderas och skrivs om för alla lämningar i omgången. */
export function batchStatements(posts: IndexPost[], sink: SqlSink, maxBytes = MAX_STATEMENT_BYTES) {
	if (!posts.length) return;
	sink.beginBatch();

	// 1. Områden (dimension) som inte redan skrivits i filen.
	const om: string[] = [];
	for (const p of posts)
		for (const o of p.omraden)
			if (!sink.omradeSeen(omradeKey(o))) om.push(`(${lit(o.niva)}, ${lit(o.namn)}, ${lit(o.lan)}, ${lit(o.kod)})`);
	for (const s of multiRow(
		"INSERT INTO omrade (niva, namn, lan, kod) VALUES\n",
		om,
		"\nON CONFLICT(niva, namn, lan) DO UPDATE SET kod = excluded.kod WHERE excluded.kod IS NOT NULL",
		maxBytes,
	))
		sink.emit(s);

	// 2. Lämningarna.
	const normal: string[] = [];
	for (const p of posts) {
		const r = rowLiteral(p.rad);
		if (bytes(INSERT_PREFIX) + bytes(r) + bytes(INSERT_SUFFIX) + 4 > maxBytes) {
			for (const s of oversizeRow(p.rad, maxBytes)) sink.emit(s);
		} else normal.push(r);
	}
	for (const s of multiRow(INSERT_PREFIX, normal, INSERT_SUFFIX, maxBytes)) sink.emit(s);

	// 3. Radera barnrader för omgångens lämningar.
	for (const s of deleteChildren(posts.map((p) => p.rad.uuid), maxBytes)) sink.emit(s);

	// 4. Skriv barnrader.
	const lo: string[] = [];
	const eg: string[] = [];
	const ing: string[] = [];
	for (const p of posts) {
		const u = lit(p.rad.uuid);
		for (const o of p.omraden) lo.push(`(${u}, ${lit(o.niva)}, ${lit(o.namn)}, ${lit(o.lan)})`);
		for (const e of p.egenskaper as KallEgenskap[]) eg.push(`(${u}, ${lit(e.ingaende_nr)}, ${lit(e.typ)}, ${lit(e.varde)})`);
		for (const i of p.ingaende as KallIngaende[]) ing.push(`(${u}, ${lit(i.nr)}, ${lit(i.lamningstyp)}, ${lit(i.antal)})`);
	}
	for (const s of multiRow(
		"INSERT OR IGNORE INTO lamning_omrade (omrade_id, lamning_id)\nSELECT o.id, l.id FROM (VALUES\n",
		lo,
		"\n) AS v JOIN lamning l ON l.uuid = v.column1 JOIN omrade o ON o.niva = v.column2 AND o.namn = v.column3 AND o.lan = v.column4",
		maxBytes,
	))
		sink.emit(s);
	for (const s of multiRow(
		"INSERT INTO egenskap (lamning_id, ingaende_nr, typ, varde)\nSELECT l.id, v.column2, v.column3, v.column4 FROM (VALUES\n",
		eg,
		"\n) AS v JOIN lamning l ON l.uuid = v.column1",
		maxBytes,
	))
		sink.emit(s);
	for (const s of multiRow(
		"INSERT INTO ingaende (lamning_id, nr, lamningstyp, antal)\nSELECT l.id, v.column2, v.column3, v.column4 FROM (VALUES\n",
		ing,
		"\n) AS v JOIN lamning l ON l.uuid = v.column1",
		maxBytes,
	))
		sink.emit(s);
}

function uuidLists(uuids: string[], maxBytes: number): string[] {
	// Varje lista hålls kort (uuid är 38 byte som literal).
	const per = Math.max(1, Math.min(1000, Math.floor((maxBytes - 400) / 40)));
	const out: string[] = [];
	for (let i = 0; i < uuids.length; i += per) out.push(uuids.slice(i, i + per).map(lit).join(", "));
	return out;
}

export function deleteChildren(uuids: string[], maxBytes = MAX_STATEMENT_BYTES): string[] {
	const out: string[] = [];
	for (const list of uuidLists(uuids, maxBytes)) {
		for (const t of ["lamning_omrade", "egenskap", "ingaende"])
			out.push(`DELETE FROM ${t} WHERE lamning_id IN (SELECT id FROM lamning WHERE uuid IN (${list}));`);
	}
	return out;
}

/** Ta bort lämningar helt (avstämning: utgångna poster). */
export function deleteLamningar(uuids: string[], maxBytes = MAX_STATEMENT_BYTES): string[] {
	const out = deleteChildren(uuids, maxBytes);
	for (const list of uuidLists(uuids, maxBytes)) out.push(`DELETE FROM lamning WHERE uuid IN (${list});`);
	return out;
}

/** Lämningstyp → kategori ersätts helt. */
export function kategoriStatements(typer: Array<{ namn: string; kategorier: string[] }>): string[] {
	const rows: string[] = [];
	for (const t of typer) for (const k of t.kategorier) rows.push(`(${lit(t.namn)}, ${lit(k)})`);
	return [
		"DELETE FROM lamningstyp_kategori;",
		...multiRow("INSERT OR IGNORE INTO lamningstyp_kategori (lamningstyp, kategori) VALUES\n", rows, ""),
	];
}

export interface SynkInfo {
	typ: "grundladdning" | "avstamning";
	startad: string;
	klar: string;
	kalla: string;
	uttagsdatum: string | null;
	nya: number;
	andrade: number;
	borttagna: number;
}

export function synkStatements(s: SynkInfo): string[] {
	const out = [
		`INSERT INTO synk (typ, startad, klar, kalla, nya, andrade, borttagna) VALUES (${lit(s.typ)}, ${lit(s.startad)}, ${lit(s.klar)}, ${lit(s.kalla)}, ${lit(s.nya)}, ${lit(s.andrade)}, ${lit(s.borttagna)});`,
	];
	const status = (k: string, v: string | null) =>
		`INSERT INTO synk_status (nyckel, varde, andrad) VALUES (${lit(k)}, ${lit(v)}, ${lit(s.klar)}) ON CONFLICT(nyckel) DO UPDATE SET varde = excluded.varde, andrad = excluded.andrad;`;
	if (s.uttagsdatum) out.push(status("uttagsdatum", s.uttagsdatum));
	out.push(status(s.typ === "grundladdning" ? "senaste_grundladdning" : "senaste_avstamning", s.klar));
	return out;
}
