/**
 * Rutnät och maskkodning för det semantiska omfånget vid närhetssök (se
 * omfang-data.ts och test/semantic/bygg-omfang.ts). Utan beroenden, så att
 * genereringsskriptet kan importera filen direkt i Node.
 *
 * Rutnätet täcker Sverige i SWEREF 99 TM med rutor om 2 × 2 km. En mask
 * kodas rad för rad: rader skiljs med ";", inom en rad körningar "start.längd"
 * (base36) skilda med ",".
 */
export const GRID = { e0: 200_000, n0: 6_100_000, cell: 2000, cols: 400, rows: 800 } as const;

export function encodeMask(mask: Uint8Array): string {
	const rows: string[] = [];
	for (let r = 0; r < GRID.rows; r++) {
		const runs: string[] = [];
		let c = 0;
		while (c < GRID.cols) {
			if (!mask[r * GRID.cols + c]) {
				c++;
				continue;
			}
			const start = c;
			while (c < GRID.cols && mask[r * GRID.cols + c]) c++;
			runs.push(`${start.toString(36)}.${(c - start).toString(36)}`);
		}
		rows.push(runs.join(","));
	}
	// Tomma rader i slutet tas bort.
	while (rows.length && rows[rows.length - 1] === "") rows.pop();
	return rows.join(";");
}

export function decodeMask(s: string): Uint8Array {
	const mask = new Uint8Array(GRID.cols * GRID.rows);
	const rows = s ? s.split(";") : [];
	rows.forEach((row, r) => {
		if (!row || r >= GRID.rows) return;
		for (const run of row.split(",")) {
			const [a, b] = run.split(".");
			const start = Number.parseInt(a, 36);
			const len = Number.parseInt(b, 36);
			for (let c = start; c < Math.min(GRID.cols, start + len); c++)
				mask[r * GRID.cols + c] = 1;
		}
	});
	return mask;
}

/** Rutorna som en SWEREF-ruta [minE, minN, maxE, maxN] når; null om den går utanför rutnätet. */
export function cellsForBox(box: readonly [number, number, number, number]): number[] | null {
	const c0 = Math.floor((box[0] - GRID.e0) / GRID.cell);
	const c1 = Math.floor((box[2] - GRID.e0) / GRID.cell);
	const r0 = Math.floor((box[1] - GRID.n0) / GRID.cell);
	const r1 = Math.floor((box[3] - GRID.n0) / GRID.cell);
	if (c0 < 0 || r0 < 0 || c1 >= GRID.cols || r1 >= GRID.rows || c1 < c0 || r1 < r0) return null;
	const out: number[] = [];
	for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(r * GRID.cols + c);
	return out;
}
