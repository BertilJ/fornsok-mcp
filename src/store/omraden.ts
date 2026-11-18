/**
 * Förberäknad sammanfattning per område (migrations/0003_omraden.sql):
 *
 * - `omrade_sammanfattning`: antal lämningar, antal med läge, mittpunkt
 *   (medelvärdet av lämningarnas mittpunkter) och omslutande ruta i WGS 84.
 *   För alla fyra nivåerna (län, kommun, socken, landskap).
 * - `niva_sammanfattning`: per nivå antalet lämningar med minst ett område på
 *   nivån (resten är "(saknas)" i statistik).
 * - `omrade_relation`: socken → kommun/län och kommun → län, med antal
 *   lämningar som ligger i båda. Ger "socknen ligger i Falu kommun, Dalarnas
 *   län" utan att lamning_omrade (3 miljoner rader i hela landet) självkopplas
 *   vid varje anrop.
 *
 * Används av hitta_plats (snabbt uppslag av socknar och kommuner), av
 * namnuppslaget ur indexet (src/lookup/index_domaner.ts: socknens kommuner)
 * och av statistik (antal per område utan filter).
 *
 * Hålls aktuell så här:
 * - Migreringen 0003 räknar de områden som saknar rader (satserna nedan,
 *   uppdelade så att varje sats läser en fjärdedel av en nivå).
 * - Inläsningen (ingest/) räknar om allt sist i varje SQL-körning.
 * - Nattsynken markerar de områden en skriven eller borttagen lämning ligger i
 *   (före och efter) med `inaktuell = 1`, och räknar om de markerade efter
 *   körningen (refreshInaktuella).
 *
 * Är en rad inaktuell eller saknas den, är uppgiften i värsta fall ett dygn
 * gammal; antal och mittpunkt flyttar sig sällan märkbart av en natts ändringar.
 */
import type { D1Like, D1LikeStatement } from "./d1";

/** Antal delar varje nivå räknas i (efter `omrade.id % DELAR`) i den fullständiga omräkningen. */
export const DELAR = 4;
export const NIVAER = ["socken", "kommun", "lan", "landskap"] as const;
/** Nivåer som har överordnade områden i omrade_relation, och vilka. */
export const RELATIONER: Record<string, readonly string[]> = { socken: ["kommun", "lan"], kommun: ["lan"] };

const SAMMANFATTNING_UPSERT = `INSERT INTO omrade_sammanfattning (omrade_id, antal, med_lage, lat, lon, min_lat, min_lon, max_lat, max_lon, inaktuell)
SELECT o.id, count(lo.lamning_id), count(l.lat), avg(l.lat), avg(l.lon), min(l.lat), min(l.lon), max(l.lat), max(l.lon), 0
FROM omrade o LEFT JOIN lamning_omrade lo ON lo.omrade_id = o.id LEFT JOIN lamning l ON l.id = lo.lamning_id
WHERE {VILLKOR}
GROUP BY o.id
ON CONFLICT(omrade_id) DO UPDATE SET antal = excluded.antal, med_lage = excluded.med_lage, lat = excluded.lat, lon = excluded.lon,
min_lat = excluded.min_lat, min_lon = excluded.min_lon, max_lat = excluded.max_lat, max_lon = excluded.max_lon, inaktuell = 0`;

const RELATION_DELETE = "DELETE FROM omrade_relation WHERE omrade_id IN (SELECT o.id FROM omrade o WHERE {VILLKOR})";

const RELATION_INSERT = `INSERT INTO omrade_relation (omrade_id, overordnad_id, antal)
SELECT lo.omrade_id, lo2.omrade_id, count(*)
FROM omrade o JOIN lamning_omrade lo ON lo.omrade_id = o.id
JOIN lamning_omrade lo2 ON lo2.lamning_id = lo.lamning_id
JOIN omrade o2 ON o2.id = lo2.omrade_id
WHERE {VILLKOR} AND o2.niva IN ({OVER})
GROUP BY lo.omrade_id, lo2.omrade_id`;

/** Antal lämningar med minst ett område på nivån (för "(saknas)" i statistik). */
// Villkoret står utanför aggregatet: ett aggregat utan GROUP BY ger alltid en rad (0), även när WHERE är falskt.
const NIVA_UPSERT = `INSERT INTO niva_sammanfattning (niva, med_omrade, inaktuell)
SELECT niva, n, 0 FROM (SELECT '{NIVA}' AS niva, count(*) AS n FROM (SELECT lamning_id FROM lamning_omrade INDEXED BY idx_lamning_omrade_lamning
WHERE omrade_id IN (SELECT id FROM omrade WHERE niva = '{NIVA}') GROUP BY lamning_id)) WHERE {VILLKOR}
ON CONFLICT(niva) DO UPDATE SET med_omrade = excluded.med_omrade, inaktuell = 0`;

const fill = (tpl: string, villkor: string, over = "") => tpl.replace("{VILLKOR}", villkor).replace("{OVER}", over);
const overList = (niva: string) => (RELATIONER[niva] ?? []).map((n) => `'${n}'`).join(", ");

/**
 * Hela omräkningen som literal-SQL (för migreringen och inläsningsfilerna).
 * Varje sats läser en fjärdedel av en nivå: för hela landet högst cirka
 * 200 000 rader i lamning_omrade och lika många uppslag i lamning, så att
 * ingen enskild sats närmar sig D1:s tidsgräns.
 */
export function fullRecomputeSql(opts: { baraSaknade?: boolean } = {}): string[] {
	const out: string[] = [];
	for (const niva of NIVAER) {
		const nv = opts.baraSaknade ? `NOT EXISTS (SELECT 1 FROM niva_sammanfattning WHERE niva = '${niva}')` : "true";
		out.push(`${NIVA_UPSERT.replaceAll("{NIVA}", niva).replace("{VILLKOR}", nv)};`);
		for (let k = 0; k < DELAR; k++) {
			const villkor = `o.niva = '${niva}' AND o.id % ${DELAR} = ${k}`;
			if (opts.baraSaknade) {
				// Migreringen: bara områden som saknar rader. En avbruten körning fortsätter
				// där den slutade, och en omkörning efter fullbordad körning läser nästan inget.
				out.push(`${fill(SAMMANFATTNING_UPSERT, `${villkor} AND NOT EXISTS (SELECT 1 FROM omrade_sammanfattning s0 WHERE s0.omrade_id = o.id)`)};`);
				if (RELATIONER[niva])
					out.push(`${fill(RELATION_INSERT, `${villkor} AND NOT EXISTS (SELECT 1 FROM omrade_relation r0 WHERE r0.omrade_id = o.id)`, overList(niva))};`);
				continue;
			}
			out.push(`${fill(SAMMANFATTNING_UPSERT, villkor)};`);
			if (RELATIONER[niva]) {
				out.push(`${fill(RELATION_DELETE, villkor)};`);
				out.push(`${fill(RELATION_INSERT, villkor, overList(niva))};`);
			}
		}
	}
	return out;
}

/** Satser som markerar en lämnings nuvarande områden som inaktuella (körs före och efter att den skrivs). */
export function markeraOmradenSats(db: D1Like, uuid: string): D1LikeStatement {
	return db
		.prepare(
			"INSERT INTO omrade_sammanfattning (omrade_id, inaktuell) SELECT lo.omrade_id, 1 FROM lamning_omrade lo WHERE lo.lamning_id = (SELECT id FROM lamning WHERE uuid = ?) ON CONFLICT(omrade_id) DO UPDATE SET inaktuell = 1",
		)
		.bind(uuid);
}

/** Satser som räknar om givna områden (alla på samma nivå). */
export function recomputeSatser(db: D1Like, niva: string, ids: number[]): D1LikeStatement[] {
	if (!ids.length) return [];
	const villkor = "o.id IN (SELECT value FROM json_each(?))";
	const p = JSON.stringify(ids);
	const out = [db.prepare(fill(SAMMANFATTNING_UPSERT, villkor)).bind(p)];
	if (RELATIONER[niva]) {
		out.push(db.prepare(fill(RELATION_DELETE, villkor)).bind(p));
		out.push(db.prepare(fill(RELATION_INSERT, villkor, overList(niva))).bind(p));
	}
	return out;
}

export interface RefreshResult {
	omraknade: number;
	kvar: number;
}

/**
 * Räkna om de områden som nattsynken markerat som inaktuella. Socknar och
 * kommuner i grupper om 20, län och landskap (upp till 150 000 lämningar)
 * ett i taget. Högst `max` områden per körning; resten tas nästa gång.
 */
export async function refreshInaktuella(db: D1Like, opts: { max?: number } = {}): Promise<RefreshResult> {
	const max = Math.max(1, opts.max ?? 400);
	const rader = (
		await db
			.prepare(
				"SELECT s.omrade_id AS id, o.niva FROM omrade_sammanfattning s JOIN omrade o ON o.id = s.omrade_id WHERE s.inaktuell = 1 ORDER BY s.omrade_id LIMIT ?",
			)
			.bind(max + 1)
			.all<{ id: number; niva: string }>()
	).results;
	const kvar = Math.max(0, rader.length - max);
	const valda = rader.slice(0, max);
	for (const niva of NIVAER) {
		const ids = valda.filter((r) => r.niva === niva).map((r) => Number(r.id));
		const per = niva === "socken" || niva === "kommun" ? 20 : 1;
		for (let i = 0; i < ids.length; i += per) await db.batch(recomputeSatser(db, niva, ids.slice(i, i + per)));
		// Antalet lämningar med område på nivån (läser nivåns index en gång).
		if (ids.length) await db.batch([db.prepare(NIVA_UPSERT.replaceAll("{NIVA}", niva).replace("{VILLKOR}", "true"))]);
	}
	return { omraknade: valda.length, kvar };
}
