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
	// Kanterna är krökta i SWEREF; ta med hörn och mittpunkter på kanterna.
	const pts: Planar[] = [];
	for (const lat of [minLat, (minLat + maxLat) / 2, maxLat])
		for (const lon of [minLon, (minLon + maxLon) / 2, maxLon]) pts.push(toPlanar({ lat, lon }));
	return [
		Math.floor(Math.min(...pts.map((p) => p.e))),
		Math.floor(Math.min(...pts.map((p) => p.n))),
		Math.ceil(Math.max(...pts.map((p) => p.e))),
		Math.ceil(Math.max(...pts.map((p) => p.n))),
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
	RUMSKLASS_HOJD.forEach((h, k) => {
		parts.push(
			"SELECT id FROM lamning WHERE rumsklass = ? AND min_n BETWEEN ? AND ? AND max_n >= ? AND min_e <= ? AND max_e >= ?",
		);
		params.push(k, minN - h, maxN, minN, maxE, minE);
	});
	parts.push("SELECT id FROM lamning WHERE rumsklass = ? AND min_n <= ? AND max_n >= ? AND min_e <= ? AND max_e >= ?");
	params.push(RUMSKLASS_HOJD.length, maxN, minN, maxE, minE);
	return { sql: `${alias}.id IN (${parts.join(" UNION ALL ")})`, params };
}
