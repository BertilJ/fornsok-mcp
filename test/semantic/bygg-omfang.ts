/**
 * Bygger src/semantic/omfang-data.ts: underlaget för scopeCovers() (SPEC 5.2),
 * som ska kunna avgöra synkront och utan I/O om ett geografiskt filter ligger
 * helt inom det semantiska omfånget.
 *
 * Läser RAÄ:s GeoPackage för hela Sverige (CC0) med inläsningens egen läsare
 * och indelning (ingest/read.ts, ingest/transform.ts), så att namnen och
 * sockenlänen blir exakt de som indexet har. För varje kommun, socken (namn +
 * indexets länsavgränsning) och landskap sparas de olika län-mängder som dess
 * lämningar har; ett område ligger inom omfånget om varje sådan mängd har
 * minst ett län i omfånget. För närhetssök sparas per län en mask över rutor
 * om 2 × 2 km i SWEREF 99 TM där varje lämning vars omslutande ruta når rutan
 * ligger i länet; tomma rutor räknas till länet bara om de är helt omslutna av
 * länets rutor (fyllning utifrån).
 *
 * Användning, från projektroten (tar ungefär en minut). Node kan inte köra
 * filen direkt (src/ importerar utan filändelse), så den paketeras först:
 *   npx esbuild test/semantic/bygg-omfang.ts --bundle --platform=node --format=esm --outfile=/tmp/bygg-omfang.mjs
 *   node /tmp/bygg-omfang.mjs <lamningar_sverige.gpkg> src/semantic/omfang-data.ts
 * Körs om när indelningen ändras (sällan) eller när ingest/data/referens.json byggs om.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GpkgReader } from "../../ingest/read.ts";
import type { Referens } from "../../ingest/referens.ts";
import { bboxOf, combine, Indelning } from "../../ingest/transform.ts";
import { encodeMask, GRID } from "../../src/semantic/omfang-mask.ts";

const [gpkg, ut = "src/semantic/omfang-data.ts"] = process.argv.slice(2);
if (!gpkg) {
	console.error(
		"Användning: node bygg-omfang.mjs <sverige.gpkg> [ut.ts] (se kommentaren överst i test/semantic/bygg-omfang.ts)",
	);
	process.exit(2);
}

// Direkt ur filen (ingest/load.ts använder syntax som Node inte kan strippa).
const ref = JSON.parse(
	readFileSync(join(process.cwd(), "ingest", "data", "referens.json"), "utf8"),
) as Referens;
const indelning = new Indelning(ref);
const LAN_NAMN = ref.lan.map((l) => l.namn).sort((a, b) => a.localeCompare(b, "sv"));
const lanBit = new Map(LAN_NAMN.map((n, i) => [n, i]));

const kommun = new Map<string, Set<string>>();
const socken = new Map<string, Map<string, Set<string>>>();
const landskap = new Map<string, Set<string>>();
const add = (m: Map<string, Set<string>>, k: string, v: string) => {
	let s = m.get(k);
	if (!s) m.set(k, (s = new Set()));
	s.add(v);
};

// Rutnät: per ruta OR resp. AND av lämningarnas län-bitmasker.
const cells = GRID.cols * GRID.rows;
const anyLan = new Uint32Array(cells); // union av län som förekommer
const allLan = new Uint32Array(cells).fill(0xffffffff); // snitt: län som alla lämningar i rutan har
const occupied = new Uint8Array(cells);

const reader = new GpkgReader(gpkg);
let n = 0;
for (const p of reader.posts()) {
	n++;
	if (n % 100_000 === 0) console.error(`${n} …`);
	const omr = indelning.omraden(p);
	const lan = omr
		.filter((o) => o.niva === "lan")
		.map((o) => o.namn)
		.sort((a, b) => a.localeCompare(b, "sv"));
	const key = lan.join("+");
	for (const o of omr) {
		if (o.niva === "kommun") add(kommun, o.namn, key);
		else if (o.niva === "landskap") add(landskap, o.namn, key);
		else if (o.niva === "socken") {
			let m = socken.get(o.namn);
			if (!m) socken.set(o.namn, (m = new Map()));
			add(m, o.lan, key);
		}
	}
	let mask = 0;
	for (const l of lan) {
		const b = lanBit.get(l);
		if (b !== undefined) mask |= 1 << b;
	}
	const g = combine(p.geometrier.map((x) => x.geometry));
	const box = g ? bboxOf(g) : null;
	if (!box) continue;
	const c0 = Math.max(0, Math.floor((box[0] - GRID.e0) / GRID.cell));
	const c1 = Math.min(GRID.cols - 1, Math.floor((box[2] - GRID.e0) / GRID.cell));
	const r0 = Math.max(0, Math.floor((box[1] - GRID.n0) / GRID.cell));
	const r1 = Math.min(GRID.rows - 1, Math.floor((box[3] - GRID.n0) / GRID.cell));
	for (let r = r0; r <= r1; r++)
		for (let c = c0; c <= c1; c++) {
			const i = r * GRID.cols + c;
			anyLan[i] |= mask;
			allLan[i] &= mask;
			occupied[i] = 1;
		}
}
reader.close();
console.error(`${n} lämningar lästa`);

function fillMask(bit: number): Uint8Array {
	const inside = new Uint8Array(cells);
	const outside = new Uint8Array(cells);
	const queue: number[] = [];
	const push = (i: number) => {
		if (!outside[i] && !occupied[i]) {
			outside[i] = 1;
			queue.push(i);
		}
	};
	for (let i = 0; i < cells; i++) {
		if (occupied[i] && allLan[i] & (1 << bit)) inside[i] = 1;
	}
	// Fyll tomma rutor från kanten och från rutor med lämningar utanför länet.
	for (let c = 0; c < GRID.cols; c++) {
		push(c);
		push((GRID.rows - 1) * GRID.cols + c);
	}
	for (let r = 0; r < GRID.rows; r++) {
		push(r * GRID.cols);
		push(r * GRID.cols + GRID.cols - 1);
	}
	const seeds: number[] = [];
	for (let i = 0; i < cells; i++) if (occupied[i] && !inside[i]) seeds.push(i);
	const neighbours = (i: number) => {
		const r = Math.floor(i / GRID.cols);
		const c = i % GRID.cols;
		const out: number[] = [];
		if (r > 0) out.push(i - GRID.cols);
		if (r < GRID.rows - 1) out.push(i + GRID.cols);
		if (c > 0) out.push(i - 1);
		if (c < GRID.cols - 1) out.push(i + 1);
		return out;
	};
	for (const s of seeds) for (const j of neighbours(s)) push(j);
	while (queue.length) {
		const i = queue.pop() as number;
		for (const j of neighbours(i)) push(j);
	}
	for (let i = 0; i < cells; i++) if (!occupied[i] && !outside[i]) inside[i] = 1;
	return inside;
}

const masks: Record<string, string> = {};
LAN_NAMN.forEach((namn, bit) => {
	masks[namn] = encodeMask(fillMask(bit));
});

const obj = (m: Map<string, Set<string>>) =>
	Object.fromEntries(
		[...m.entries()]
			.sort((a, b) => a[0].localeCompare(b[0], "sv"))
			.map(([k, v]) => [k, [...v].sort()]),
	);
const data = {
	byggd: reader.uttagsdatum,
	lamningar: n,
	kommun: obj(kommun),
	socken: Object.fromEntries(
		[...socken.entries()]
			.sort((a, b) => a[0].localeCompare(b[0], "sv"))
			.map(([k, m]) => [k, obj(m)]),
	),
	landskap: obj(landskap),
	rutor: masks,
};

writeFileSync(
	ut,
	`/**
 * GENERERAD av test/semantic/bygg-omfang.ts ur RAÄ:s GeoPackage för hela
 * Sverige (CC0), uttagsdatum ${data.byggd}, ${n} lämningar. Ändra inte för hand.
 *
 * kommun/landskap: namn → de län-mängder ("Dalarna+Gävleborg") som områdets
 * lämningar har. socken: namn → indexets länsavgränsning ('' = unikt namn) →
 * län-mängder. rutor: per län en mask över ${GRID.cell / 1000} × ${GRID.cell / 1000} km-rutor (se omfang-mask.ts).
 */
export const OMFANG_DATA: {
	byggd: string | null;
	lamningar: number;
	kommun: Record<string, string[]>;
	socken: Record<string, Record<string, string[]>>;
	landskap: Record<string, string[]>;
	rutor: Record<string, string>;
} = ${JSON.stringify(data)};
`,
);
console.error(`Skrev ${ut}`);
