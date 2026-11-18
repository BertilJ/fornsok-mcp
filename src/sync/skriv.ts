/**
 * D1-satser för nattsynken. Allt är parametriserat och hålls under D1:s gräns
 * på 100 parametrar per sats.
 *
 * Lämningen skrivs med `INSERT … ON CONFLICT(uuid) DO UPDATE` – samma som
 * ingest/sql.ts – och ALDRIG med `INSERT OR REPLACE`: REPLACE raderar den
 * gamla raden utan att köra delete-triggern (SQLites standard
 * recursive_triggers=0), så FTS-indexet (extern innehållstabell) får kvar det
 * gamla innehållet och går sönder. Med DO UPDATE behåller raden sitt id och
 * triggern lamning_fts_au tar bort den gamla texten och lägger in den nya.
 * Barnraderna raderas och skrivs om. test/sync/run.test.ts kör FTS5:s
 * integrity-check med rank 1 efter ny, ändrad och borttagen post.
 *
 * Satserna för en lämning körs i en `batch` (en transaktion i D1), tillsammans
 * med borttagningen ur synk_ko och markeringen för ny inbäddning, så att en
 * avbruten körning antingen har skrivit allt för lämningen eller inget.
 */
import type { D1Like, D1LikeStatement } from "../store/d1";
import { markeraOmradenSats, nivaDeltaSats } from "../store/omraden";
import type { Omrade } from "./omraden";
import { LAMNING_KOLUMNER, type Rad } from "./rad";

const MAX_PARAMS = 99;

/** Kolumner som behåller befintligt värde när en reservpost (K-samsök) saknar det. */
const RESERV_BEHALL = new Set([
	"raa_nummer",
	"raa_sok",
	"namn",
	"osakerhet_m",
	"publicerad",
	"publicerad_av",
	"bedomning_motivering",
]);

function upsertSql(reserv: boolean): string {
	const set = LAMNING_KOLUMNER.filter((c) => c !== "uuid")
		.map((c) =>
			reserv && RESERV_BEHALL.has(c)
				? `${c} = COALESCE(excluded.${c}, lamning.${c})`
				: `${c} = excluded.${c}`,
		)
		.join(", ");
	return `INSERT INTO lamning (${LAMNING_KOLUMNER.join(", ")}) VALUES (${LAMNING_KOLUMNER.map(() => "?").join(", ")}) ON CONFLICT(uuid) DO UPDATE SET ${set}`;
}

const UPSERT = upsertSql(false);
const UPSERT_RESERV = upsertSql(true);

function chunks<T>(xs: T[], per: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < xs.length; i += per) out.push(xs.slice(i, i + per));
	return out;
}

const LAMNING_ID = "(SELECT id FROM lamning WHERE uuid = ?)";

/** Radera barnraderna för en lämning. `allt` = även egenskaper och ingående. */
export function raderaBarn(db: D1Like, uuid: string, allt = true): D1LikeStatement[] {
	const tabeller = allt ? ["lamning_omrade", "egenskap", "ingaende"] : ["lamning_omrade"];
	return tabeller.map((t) =>
		db.prepare(`DELETE FROM ${t} WHERE lamning_id = ${LAMNING_ID}`).bind(uuid),
	);
}

/**
 * Satser som skriver lämningen med barnrader. För reservposter (`reserv`)
 * behålls befintliga egenskaper, ingående lämningar och värden som K-samsök
 * saknar.
 */
export function skrivSatser(
	db: D1Like,
	r: Rad,
	omraden: Omrade[],
	kategorier: string[],
	opts: { reserv?: boolean } = {},
): D1LikeStatement[] {
	const reserv = opts.reserv === true;
	const uuid = r.rad.uuid;
	const out: D1LikeStatement[] = [];

	// 1. Områden (dimension). Befintlig kod behålls om den nya saknas.
	for (const part of chunks(omraden, Math.floor(MAX_PARAMS / 4))) {
		out.push(
			db
				.prepare(
					`INSERT INTO omrade (niva, namn, lan, kod) VALUES ${part.map(() => "(?, ?, ?, ?)").join(", ")} ON CONFLICT(niva, namn, lan) DO UPDATE SET kod = excluded.kod WHERE excluded.kod IS NOT NULL`,
				)
				.bind(...part.flatMap((o) => [o.niva, o.namn, o.lan, o.kod])),
		);
	}

	// 2. Lämningen.
	out.push(
		db
			.prepare(reserv ? UPSERT_RESERV : UPSERT)
			.bind(...LAMNING_KOLUMNER.map((c) => r.rad[c] ?? null)),
	);

	// 3. Barnrader raderas … (områdena lämningen låg i markeras först för omräkning, se src/store/omraden.ts)
	out.push(markeraOmradenSats(db, uuid), nivaDeltaSats(db, uuid, -1));
	out.push(...raderaBarn(db, uuid, !reserv));

	// 4. … och skrivs om.
	for (const part of chunks(omraden, Math.floor((MAX_PARAMS - 1) / 3))) {
		out.push(
			db
				.prepare(
					`INSERT OR IGNORE INTO lamning_omrade (omrade_id, lamning_id) SELECT o.id, l.id FROM (VALUES ${part.map(() => "(?, ?, ?)").join(", ")}) AS v JOIN lamning l ON l.uuid = ? JOIN omrade o ON o.niva = v.column1 AND o.namn = v.column2 AND o.lan = v.column3`,
				)
				.bind(...part.flatMap((o) => [o.niva, o.namn, o.lan]), uuid),
		);
	}
	// … och de områden den ligger i nu markeras.
	out.push(markeraOmradenSats(db, uuid), nivaDeltaSats(db, uuid, 1));
	if (!reserv) {
		for (const part of chunks(r.egenskaper, Math.floor((MAX_PARAMS - 1) / 3))) {
			out.push(
				db
					.prepare(
						`INSERT INTO egenskap (lamning_id, ingaende_nr, typ, varde) SELECT l.id, v.column1, v.column2, v.column3 FROM (VALUES ${part.map(() => "(?, ?, ?)").join(", ")}) AS v JOIN lamning l ON l.uuid = ?`,
					)
					.bind(...part.flatMap((e) => [e.ingaende_nr, e.typ, e.varde]), uuid),
			);
		}
		for (const part of chunks(r.ingaende, Math.floor((MAX_PARAMS - 1) / 3))) {
			out.push(
				db
					.prepare(
						`INSERT INTO ingaende (lamning_id, nr, lamningstyp, antal) SELECT l.id, v.column1, v.column2, v.column3 FROM (VALUES ${part.map(() => "(?, ?, ?)").join(", ")}) AS v JOIN lamning l ON l.uuid = ?`,
					)
					.bind(...part.flatMap((i) => [i.nr, i.lamningstyp, i.antal]), uuid),
			);
		}
	}

	// 5. Kategori för lämningstypen, om typen är ny för indexet.
	if (r.rad.lamningstyp) {
		for (const k of kategorier) {
			out.push(
				db
					.prepare(
						"INSERT OR IGNORE INTO lamningstyp_kategori (lamningstyp, kategori) VALUES (?, ?)",
					)
					.bind(r.rad.lamningstyp, k),
			);
		}
	}
	return out;
}

/** Ta bort lämningen helt (UTGAR). Delete-triggern tar bort texten ur FTS-indexet. */
export function taBortSatser(db: D1Like, uuid: string): D1LikeStatement[] {
	return [
		markeraOmradenSats(db, uuid),
		nivaDeltaSats(db, uuid, -1),
		...raderaBarn(db, uuid, true),
		db.prepare("DELETE FROM lamning WHERE uuid = ?").bind(uuid),
	];
}
