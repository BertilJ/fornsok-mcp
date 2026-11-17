/**
 * Från källpost till indexrad: mittpunkt, omslutande ruta, höjdklass, GeoJSON i
 * WGS 84 (förenklad om raden annars blir för stor för D1) och innehållshash.
 *
 * Samma beräkningar som toIndexPost() i ingest/transform.ts, som inte kan
 * importeras härifrån (se post.ts). test/sync/rad.test.ts jämför resultatet
 * med transform.ts för samma post. Ändras omvandlingen i transform.ts ska den
 * ändras här också (och TRANSFORM_VERSION i båda).
 */
import {
	countPositions,
	type Geometry,
	type Position,
	simplifyToLimit,
	swerefToWgs,
} from "../geo/geometry";
import { round, toLatLon } from "../geo/sweref";
import { RUMSKLASS_HOJD } from "../store/spatial";
import { contentHash, raaSok, type SynkEgenskap, type SynkIngaende, type SynkPost } from "./post";

/** Största GeoJSON-text som lagras oförenklad (som MAX_GEOJSON_BYTES i transform.ts). */
export const MAX_GEOJSON_BYTES = 1_000_000;

/** Kolumnerna i tabellen lamning (samma som LamningRad i ingest/transform.ts). */
export interface LamningRad {
	uuid: string;
	lamningsnummer: string | null;
	raa_nummer: string | null;
	raa_sok: string | null;
	lamningstyp: string | null;
	bedomning: string | null;
	bedomning_motivering: string | null;
	beskrivning: string | null;
	terrang: string | null;
	orientering: string | null;
	tradition: string | null;
	namn: string | null;
	aktualitet: string | null;
	skada: string | null;
	undersokning: string | null;
	placering: string | null;
	lat: number | null;
	lon: number | null;
	e: number | null;
	n: number | null;
	min_e: number | null;
	min_n: number | null;
	max_e: number | null;
	max_n: number | null;
	rumsklass: number | null;
	geometrityp: string | null;
	geometri: string | null;
	geometri_forenklad: number;
	osakerhet_m: number | null;
	publicerad: string | null;
	publicerad_av: string | null;
	uttagsdatum: string | null;
	hash: string;
}

export const LAMNING_KOLUMNER: Array<keyof LamningRad> = [
	"uuid",
	"lamningsnummer",
	"raa_nummer",
	"raa_sok",
	"lamningstyp",
	"bedomning",
	"bedomning_motivering",
	"beskrivning",
	"terrang",
	"orientering",
	"tradition",
	"namn",
	"aktualitet",
	"skada",
	"undersokning",
	"placering",
	"lat",
	"lon",
	"e",
	"n",
	"min_e",
	"min_n",
	"max_e",
	"max_n",
	"rumsklass",
	"geometrityp",
	"geometri",
	"geometri_forenklad",
	"osakerhet_m",
	"publicerad",
	"publicerad_av",
	"uttagsdatum",
	"hash",
];

function forEachPosition(g: Geometry, fn: (p: Position) => void): void {
	switch (g.type) {
		case "Point":
			fn(g.coordinates);
			return;
		case "MultiPoint":
		case "LineString":
			for (const p of g.coordinates) fn(p);
			return;
		case "MultiLineString":
		case "Polygon":
			for (const r of g.coordinates) for (const p of r) fn(p);
			return;
		case "MultiPolygon":
			for (const poly of g.coordinates) for (const r of poly) for (const p of r) fn(p);
			return;
		case "GeometryCollection":
			for (const x of g.geometries) forEachPosition(x, fn);
	}
}

export function bboxOf(g: Geometry): [number, number, number, number] | null {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	forEachPosition(g, (p) => {
		if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
		if (p[0] < minX) minX = p[0];
		if (p[1] < minY) minY = p[1];
		if (p[0] > maxX) maxX = p[0];
		if (p[1] > maxY) maxY = p[1];
	});
	return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

/** En → oförändrad, samma typ → Multi*, blandat → samling. */
export function combine(geoms: Geometry[]): Geometry | null {
	if (geoms.length === 0) return null;
	if (geoms.length === 1) return geoms[0];
	const types = new Set(geoms.map((g) => g.type));
	if (types.size === 1) {
		const t = geoms[0].type;
		if (t === "Point")
			return {
				type: "MultiPoint",
				coordinates: geoms.map((g) => (g as { coordinates: Position }).coordinates),
			};
		if (t === "LineString")
			return {
				type: "MultiLineString",
				coordinates: geoms.map((g) => (g as { coordinates: Position[] }).coordinates),
			};
		if (t === "Polygon")
			return {
				type: "MultiPolygon",
				coordinates: geoms.map((g) => (g as { coordinates: Position[][] }).coordinates),
			};
	}
	return { type: "GeometryCollection", geometries: geoms };
}

interface Acc {
	area: number;
	ax: number;
	ay: number;
	len: number;
	lx: number;
	ly: number;
	pts: number;
	px: number;
	py: number;
}

function ringArea(ring: Position[], acc: { a: number; x: number; y: number }) {
	if (ring.length < 3) return;
	const [x0, y0] = ring[0];
	let a = 0;
	let cx = 0;
	let cy = 0;
	for (let i = 0; i + 1 < ring.length; i++) {
		const xi = ring[i][0] - x0;
		const yi = ring[i][1] - y0;
		const xj = ring[i + 1][0] - x0;
		const yj = ring[i + 1][1] - y0;
		const c = xi * yj - xj * yi;
		a += c;
		cx += (xi + xj) * c;
		cy += (yi + yj) * c;
	}
	a /= 2;
	if (a === 0) return;
	acc.a = a;
	acc.x = cx / (6 * a) + x0;
	acc.y = cy / (6 * a) + y0;
}

function accumulate(g: Geometry, acc: Acc) {
	const path = (p: Position[]) => {
		for (let i = 0; i + 1 < p.length; i++) {
			const l = Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
			acc.len += l;
			acc.lx += ((p[i][0] + p[i + 1][0]) / 2) * l;
			acc.ly += ((p[i][1] + p[i + 1][1]) / 2) * l;
		}
		for (const q of p) {
			acc.pts++;
			acc.px += q[0];
			acc.py += q[1];
		}
	};
	const polygon = (rings: Position[][]) => {
		rings.forEach((ring, i) => {
			const r = { a: 0, x: 0, y: 0 };
			ringArea(ring, r);
			const w = (i === 0 ? 1 : -1) * Math.abs(r.a);
			acc.area += w;
			acc.ax += r.x * w;
			acc.ay += r.y * w;
			path(ring);
		});
	};
	switch (g.type) {
		case "Point":
			acc.pts++;
			acc.px += g.coordinates[0];
			acc.py += g.coordinates[1];
			return;
		case "MultiPoint":
			for (const p of g.coordinates) {
				acc.pts++;
				acc.px += p[0];
				acc.py += p[1];
			}
			return;
		case "LineString":
			path(g.coordinates);
			return;
		case "MultiLineString":
			for (const l of g.coordinates) path(l);
			return;
		case "Polygon":
			polygon(g.coordinates);
			return;
		case "MultiPolygon":
			for (const p of g.coordinates) polygon(p);
			return;
		case "GeometryCollection":
			for (const x of g.geometries) accumulate(x, acc);
	}
}

/** Ytviktad, annars längdviktad, annars medelvärdet av punkterna (som transform.ts). */
export function centroid(g: Geometry): [number, number] | null {
	const acc: Acc = { area: 0, ax: 0, ay: 0, len: 0, lx: 0, ly: 0, pts: 0, px: 0, py: 0 };
	accumulate(g, acc);
	if (acc.area > 1e-6) return [acc.ax / acc.area, acc.ay / acc.area];
	if (acc.len > 1e-6) return [acc.lx / acc.len, acc.ly / acc.len];
	if (acc.pts > 0) return [acc.px / acc.pts, acc.py / acc.pts];
	return null;
}

export function rumsklass(minN: number, maxN: number): number {
	const h = maxN - minN;
	for (let i = 0; i < RUMSKLASS_HOJD.length; i++) if (h <= RUMSKLASS_HOJD[i]) return i;
	return RUMSKLASS_HOJD.length;
}

export interface Rad {
	rad: LamningRad;
	egenskaper: SynkEgenskap[];
	ingaende: SynkIngaende[];
}

/** Bygg raden. `hashPrefix` sätts för reservposter (se RESERV_HASH_PREFIX). */
export async function tillRad(p: SynkPost, hashPrefix = ""): Promise<Rad> {
	const geoms = [...p.geometrier].sort((a, b) =>
		(a.nr ?? "").localeCompare(b.nr ?? "", "sv", { numeric: true }),
	);
	const combined = combine(geoms.map((g) => g.geometry));
	let wgsJson: string | null = null;
	let forenklad = 0;
	let lat: number | null = null;
	let lon: number | null = null;
	let e: number | null = null;
	let n: number | null = null;
	let box: [number, number, number, number] | null = null;
	if (combined) {
		box = bboxOf(combined);
		const c = centroid(combined);
		if (c) {
			e = round(c[0], 1);
			n = round(c[1], 1);
			const ll = toLatLon({ e: c[0], n: c[1] });
			lat = round(ll.lat, 7);
			lon = round(ll.lon, 7);
		}
		let g = combined;
		wgsJson = JSON.stringify(swerefToWgs(g));
		let limit = countPositions(g);
		while (wgsJson.length > MAX_GEOJSON_BYTES && limit > 10) {
			limit = Math.floor(limit / 2);
			g = simplifyToLimit(combined, limit).geometry;
			wgsJson = JSON.stringify(swerefToWgs(g));
			forenklad = 1;
		}
	}
	const minE = box ? Math.floor(box[0]) : null;
	const minN = box ? Math.floor(box[1]) : null;
	const maxE = box ? Math.ceil(box[2]) : null;
	const maxN = box ? Math.ceil(box[3]) : null;
	const rad: LamningRad = {
		uuid: p.uuid,
		lamningsnummer: p.lamningsnummer,
		raa_nummer: p.raa_nummer,
		raa_sok: raaSok(p.raa_nummer),
		lamningstyp: p.lamningstyp,
		bedomning: p.bedomning,
		bedomning_motivering: p.bedomning_motivering,
		beskrivning: p.beskrivning,
		terrang: p.terrang,
		orientering: p.orientering,
		tradition: p.tradition,
		namn: p.namn,
		aktualitet: p.aktualitet,
		skada: p.skada,
		undersokning: p.undersokning,
		placering: p.placering,
		lat,
		lon,
		e,
		n,
		min_e: minE,
		min_n: minN,
		max_e: maxE,
		max_n: maxN,
		rumsklass: minN !== null && maxN !== null ? rumsklass(minN, maxN) : null,
		geometrityp: combined?.type ?? null,
		geometri: wgsJson,
		geometri_forenklad: forenklad,
		osakerhet_m: p.osakerhet_m,
		publicerad: p.publiceringsdatum,
		publicerad_av: p.publicerad_av,
		uttagsdatum: p.uttagsdatum,
		hash: `${hashPrefix}${await contentHash(p)}`,
	};
	const egenskaper = [...p.egenskaper].sort(
		(a, b) =>
			(a.ingaende_nr ?? -1) - (b.ingaende_nr ?? -1) ||
			a.typ.localeCompare(b.typ, "sv") ||
			a.varde.localeCompare(b.varde, "sv"),
	);
	const ingaende = [...p.ingaende].sort((a, b) => a.nr - b.nr);
	return { rad, egenskaper, ingaende };
}
