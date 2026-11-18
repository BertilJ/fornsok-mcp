/**
 * Global uppsättning för kontrakttesterna: nollställer anropsloggen före körningen
 * och redovisar efteråt hur många anrop som gjordes (SPEC 9.1: högst ett trettiotal).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loggSokvag, MAX_ANROP } from "./stod";

export function setup(): void {
	writeFileSync(loggSokvag(), "");
}

export function teardown(): void {
	const p = loggSokvag();
	if (!existsSync(p)) return;
	const rader = readFileSync(p, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((r) => JSON.parse(r) as { metod: string; url: string; status: number | string; ms: number });
	const perVard = new Map<string, number>();
	for (const r of rader) {
		const v = new URL(r.url).host;
		perVard.set(v, (perVard.get(v) ?? 0) + 1);
	}
	const total = rader.reduce((a, r) => a + r.ms, 0);
	console.log(
		`\nKontrakttester: ${rader.length} anrop (tak ${MAX_ANROP}), sammanlagd svarstid ${(total / 1000).toFixed(1)} s. ` +
			`Per värd: ${[...perVard].map(([h, n]) => `${h} ${n}`).join(", ")}`,
	);
}
