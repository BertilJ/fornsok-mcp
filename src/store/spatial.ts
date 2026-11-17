/**
 * Rumsligt urval utan R*Tree. Varje lämning har en omslutande ruta i
 * SWEREF 99 TM (hela meter) och en höjdklass efter rutans höjd (se
 * migrations/0001_init.sql). För en sökruta [minE, minN, maxE, maxN] skär en
 * lämning i klass k sökrutan om
 *
 *   min_n ∈ [minN − H_k, maxN]  och  max_n ≥ minN  och  min_e ≤ maxE  och  max_e ≥ minE
 *
 * där H_k är klassens största höjd. Intervallet på min_n använder indexet
 * idx_lamning_ruta(rumsklass, min_n, min_e, max_e, max_n); övriga villkor prövas
 * i indexet utan att tabellen läses. För en sökning med radien 10 km läses
 * ungefär de indexposter som ligger i ett 21–30 km högt band över landet.
 */
import { isInSweden, type Planar, toPlanar } from "../geo/sweref";
import { IndexInputError } from "./d1";

/** Höjdgränser (meter) för rumsklasserna 0–2; större i klass 3. Används även av ingest/transform.ts. */
export const RUMSKLASS_HOJD = [1000, 8000, 64000] as const;

/** SWEREF 99 TM:s medelmeridian (grader östlig längd). */
const MEDELMERIDIAN = 15;
/** Så många delar per kant när en WGS 84-ruta räknas om. */
const KANTPUNKTER = 16;

/** Ruta i SWEREF 99 TM: [minE, minN, maxE, maxN]. */
export type SwerefBox = [number, number, number, number];

export interface SqlPart {
	sql: string;
	params: unknown[];
}

/** Ruta runt en punkt med radien `r` meter, i SWEREF 99 TM. */
export function boxAround(p: Planar, r: number): SwerefBox {
	return [Math.floor(p.e - r), Math.floor(p.n - r), Math.ceil(p.e + r), Math.ceil(p.n + r)];
}

/** WGS 84-ruta [minLon, minLat, maxLon, maxLat] → omslutande SWEREF-ruta. */
export function wgsBoxToSweref(b: [number, number, number, number]): SwerefBox {
	const [minLon, minLat, maxLon, maxLat] = b;
	if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite) || minLon > maxLon || minLat > maxLat) {
		throw new IndexInputError("Ogiltig ruta: ange [minLon, minLat, maxLon, maxLat].");
	}
	if (!isInSweden({ lat: minLat, lon: minLon }) || !isInSweden({ lat: maxLat, lon: maxLon })) {
		throw new IndexInputError("Rutan ligger utanför Sverige.");
	}
	// Kanterna är krökta i SWEREF 99 TM: en breddgrad har lägst N vid
	// medelmeridianen (15° O) och böjer sig söderut mot den, så sydkanten måste
	// provas där (granskningen, punkt 4). Kanterna provas därför tätt, med 15° O
	// när den ligger i rutan, och rutan vidgas med en meters marginal.
	const lons = [...Array.from({ length: KANTPUNKTER + 1 }, (_, i) => minLon + ((maxLon - minLon) * i) / KANTPUNKTER)];
	if (minLon < MEDELMERIDIAN && MEDELMERIDIAN < maxLon) lons.push(MEDELMERIDIAN);
	const lats = Array.from({ length: KANTPUNKTER + 1 }, (_, i) => minLat + ((maxLat - minLat) * i) / KANTPUNKTER);
	const pts: Planar[] = [];
	for (const lon of lons) for (const lat of [minLat, maxLat]) pts.push(toPlanar({ lat, lon }));
	for (const lat of lats) for (const lon of [minLon, maxLon]) pts.push(toPlanar({ lat, lon }));
	return [
		Math.floor(Math.min(...pts.map((p) => p.e)) - 1),
		Math.floor(Math.min(...pts.map((p) => p.n)) - 1),
		Math.ceil(Math.max(...pts.map((p) => p.e)) + 1),
		Math.ceil(Math.max(...pts.map((p) => p.n)) + 1),
	];
}

/** Kontrollera en punkt och räkna om den till SWEREF 99 TM. */
export function checkedPlanar(lat: number, lon: number): Planar {
	if (!Number.isFinite(lat) || !Number.isFinite(lon) || !isInSweden({ lat, lon })) {
		throw new IndexInputError("Koordinaten ligger utanför Sverige (WGS 84, lat/lon).");
	}
	return toPlanar({ lat, lon });
}

/**
 * Villkor `<alias>.id IN (…)` för lämningar vars ruta skär `box`. Delfrågan
 * läser bara indexet.
 */
export function spatialCondition(box: SwerefBox, alias = "l"): SqlPart {
	const [minE, minN, maxE, maxN] = box;
	const parts: string[] = [];
	const params: unknown[] = [];
	// Klassnumret är en konstant i koden (inte indata) och skrivs i SQL-texten, så
	// att villkoret tar 19 parametrar i stället för 23 (D1 tillåter 100 per fråga).
	RUMSKLASS_HOJD.forEach((h, k) => {
		parts.push(
			`SELECT id FROM lamning WHERE rumsklass = ${k} AND min_n BETWEEN ? AND ? AND max_n >= ? AND min_e <= ? AND max_e >= ?`,
		);
		params.push(minN - h, maxN, minN, maxE, minE);
	});
	parts.push(`SELECT id FROM lamning WHERE rumsklass = ${RUMSKLASS_HOJD.length} AND min_n <= ? AND max_n >= ? AND min_e <= ? AND max_e >= ?`);
	params.push(maxN, minN, maxE, minE);
	return { sql: `${alias}.id IN (${parts.join(" UNION ALL ")})`, params };
}
