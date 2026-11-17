/**
 * Geometrihjälp: GeoJSON-typer, omräkning av hela geometrier, avstånd från en
 * punkt till närmaste punkt på en geometri (i SWEREF 99 TM), väderstreck,
 * förenkling och tolkning av GML-koordinater från K-samsök.
 */
import { type LatLon, type Planar, toLatLon, toPlanar } from "./sweref";

export type Position = number[]; // [x, y] – [lon, lat] i WGS 84, [E, N] i SWEREF 99 TM

export type Geometry =
	| { type: "Point"; coordinates: Position }
	| { type: "MultiPoint"; coordinates: Position[] }
	| { type: "LineString"; coordinates: Position[] }
	| { type: "MultiLineString"; coordinates: Position[][] }
	| { type: "Polygon"; coordinates: Position[][] }
	| { type: "MultiPolygon"; coordinates: Position[][][] }
	| { type: "GeometryCollection"; geometries: Geometry[] };

/** Tillämpa `fn` på varje koordinat. */
export function mapPositions(g: Geometry, fn: (p: Position) => Position): Geometry {
	switch (g.type) {
		case "Point":
			return { type: g.type, coordinates: fn(g.coordinates) };
		case "MultiPoint":
		case "LineString":
			return { type: g.type, coordinates: g.coordinates.map(fn) };
		case "MultiLineString":
		case "Polygon":
			return { type: g.type, coordinates: g.coordinates.map((r) => r.map(fn)) };
		case "MultiPolygon":
			return { type: g.type, coordinates: g.coordinates.map((p) => p.map((r) => r.map(fn))) };
		case "GeometryCollection":
			return { type: g.type, geometries: g.geometries.map((x) => mapPositions(x, fn)) };
	}
}

export function wgsToSweref(g: Geometry): Geometry {
	return mapPositions(g, ([lon, lat]) => {
		const p = toPlanar({ lat, lon });
		return [p.e, p.n];
	});
}

export function swerefToWgs(g: Geometry, decimals = 7): Geometry {
	const f = 10 ** decimals;
	return mapPositions(g, ([e, n]) => {
		const p = toLatLon({ e, n });
		return [Math.round(p.lon * f) / f, Math.round(p.lat * f) / f];
	});
}

export function countPositions(g: Geometry): number {
	switch (g.type) {
		case "Point":
			return 1;
		case "MultiPoint":
		case "LineString":
			return g.coordinates.length;
		case "MultiLineString":
		case "Polygon":
			return g.coordinates.reduce((s, r) => s + r.length, 0);
		case "MultiPolygon":
			return g.coordinates.reduce((s, p) => s + p.reduce((t, r) => t + r.length, 0), 0);
		case "GeometryCollection":
			return g.geometries.reduce((s, x) => s + countPositions(x), 0);
	}
}

// ---------------------------------------------------------------- avstånd

export interface NearestResult {
	/** Avstånd i meter (0 om punkten ligger inom en yta). */
	distance: number;
	/** Närmaste punkt på geometrin (plan). */
	point: Planar;
}

function nearestOnSegment(p: Planar, a: Position, b: Position): NearestResult {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len2 = dx * dx + dy * dy;
	let t = len2 === 0 ? 0 : ((p.e - a[0]) * dx + (p.n - a[1]) * dy) / len2;
	t = Math.max(0, Math.min(1, t));
	const q = { e: a[0] + t * dx, n: a[1] + t * dy };
	return { distance: Math.hypot(p.e - q.e, p.n - q.n), point: q };
}

function nearestOnPath(p: Planar, path: Position[]): NearestResult {
	if (path.length === 1) {
		const q = { e: path[0][0], n: path[0][1] };
		return { distance: Math.hypot(p.e - q.e, p.n - q.n), point: q };
	}
	let best: NearestResult = { distance: Number.POSITIVE_INFINITY, point: p };
	for (let i = 0; i + 1 < path.length; i++) {
		const r = nearestOnSegment(p, path[i], path[i + 1]);
		if (r.distance < best.distance) best = r;
	}
	return best;
}

/** Jämn-udda-regeln: ligger punkten inom ringen? */
function inRing(p: Planar, ring: Position[]): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];
		if (yi > p.n !== yj > p.n && p.e < ((xj - xi) * (p.n - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

function nearestOnPolygon(p: Planar, rings: Position[][]): NearestResult {
	if (rings.length > 0 && inRing(p, rings[0]) && !rings.slice(1).some((h) => inRing(p, h))) {
		return { distance: 0, point: p };
	}
	let best: NearestResult = { distance: Number.POSITIVE_INFINITY, point: p };
	for (const r of rings) {
		const x = nearestOnPath(p, r);
		if (x.distance < best.distance) best = x;
	}
	return best;
}

/** Avstånd från `p` till närmaste punkt på `g`. Båda i samma plana system (SWEREF 99 TM). */
export function nearestPoint(p: Planar, g: Geometry): NearestResult {
	const pick = (rs: NearestResult[]) =>
		rs.reduce((a, b) => (b.distance < a.distance ? b : a), { distance: Number.POSITIVE_INFINITY, point: p });
	switch (g.type) {
		case "Point":
			return nearestOnPath(p, [g.coordinates]);
		case "MultiPoint":
			return pick(g.coordinates.map((c) => nearestOnPath(p, [c])));
		case "LineString":
			return nearestOnPath(p, g.coordinates);
		case "MultiLineString":
			return pick(g.coordinates.map((l) => nearestOnPath(p, l)));
		case "Polygon":
			return nearestOnPolygon(p, g.coordinates);
		case "MultiPolygon":
			return pick(g.coordinates.map((poly) => nearestOnPolygon(p, poly)));
		case "GeometryCollection":
			return pick(g.geometries.map((x) => nearestPoint(p, x)));
	}
}

const COMPASS = ["N", "NO", "O", "SO", "S", "SV", "V", "NV"] as const;

/**
 * Väderstreck (åtta) från `from` till `to` i planet. Gradnät-nord i SWEREF 99 TM
 * avviker från sann nord med högst några grader (meridiankonvergens), vilket
 * inte påverkar ett åttadelat väderstreck nämnvärt.
 */
export function compassDirection(from: Planar, to: Planar): string | null {
	const de = to.e - from.e;
	const dn = to.n - from.n;
	if (Math.hypot(de, dn) < 0.5) return null;
	const deg = ((Math.atan2(de, dn) * 180) / Math.PI + 360) % 360;
	return COMPASS[Math.round(deg / 45) % 8];
}

// ---------------------------------------------------------------- förenkling

/** Douglas–Peucker på en linje (plana koordinater). */
function simplifyPath(path: Position[], tolerance: number): Position[] {
	if (path.length <= 2) return path;
	const keep = new Uint8Array(path.length);
	keep[0] = 1;
	keep[path.length - 1] = 1;
	const stack: Array<[number, number]> = [[0, path.length - 1]];
	while (stack.length) {
		const [s, e] = stack.pop() as [number, number];
		let maxD = 0;
		let idx = -1;
		for (let i = s + 1; i < e; i++) {
			const d = nearestOnSegment({ e: path[i][0], n: path[i][1] }, path[s], path[e]).distance;
			if (d > maxD) {
				maxD = d;
				idx = i;
			}
		}
		if (idx >= 0 && maxD > tolerance) {
			keep[idx] = 1;
			stack.push([s, idx], [idx, e]);
		}
	}
	return path.filter((_, i) => keep[i] === 1);
}

function simplifyRing(ring: Position[], tolerance: number): Position[] {
	const s = simplifyPath(ring, tolerance);
	return s.length >= 4 ? s : ring;
}

function simplifyWith(g: Geometry, tol: number): Geometry {
	switch (g.type) {
		case "Point":
		case "MultiPoint":
			return g;
		case "LineString":
			return { type: g.type, coordinates: simplifyPath(g.coordinates, tol) };
		case "MultiLineString":
			return { type: g.type, coordinates: g.coordinates.map((l) => simplifyPath(l, tol)) };
		case "Polygon":
			return { type: g.type, coordinates: g.coordinates.map((r) => simplifyRing(r, tol)) };
		case "MultiPolygon":
			return { type: g.type, coordinates: g.coordinates.map((p) => p.map((r) => simplifyRing(r, tol))) };
		case "GeometryCollection":
			return { type: g.type, geometries: g.geometries.map((x) => simplifyWith(x, tol)) };
	}
}

/**
 * Förenkla en plan geometri till högst `maxPositions` brytpunkter genom att öka
 * toleransen stegvis. Returnerar geometrin och använd tolerans (0 = oförändrad).
 */
export function simplifyToLimit(g: Geometry, maxPositions: number): { geometry: Geometry; tolerance: number } {
	if (countPositions(g) <= maxPositions) return { geometry: g, tolerance: 0 };
	let tol = 0.5;
	let out = g;
	for (let i = 0; i < 20; i++) {
		out = simplifyWith(g, tol);
		if (countPositions(out) <= maxPositions) break;
		tol *= 2;
	}
	return { geometry: out, tolerance: tol };
}

// ---------------------------------------------------------------- GML

function parseCoordString(s: string): Position[] {
	return s
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((pair) => pair.split(",").map(Number))
		.filter((p) => p.length >= 2 && p.every(Number.isFinite))
		.map((p) => [p[0], p[1]]);
}

/**
 * Tolka GML 2-koordinater ur K-samsök (`gml:Point`, `gml:LineString`,
 * `gml:Polygon`, och Multi-/GeometryCollection-varianter med `cs=","`, `ts=" "`).
 * Koordinaterna är lon,lat (EPSG:4326 i K-samsöks tappning). Returnerar null om
 * inget gick att tolka.
 */
export function parseGml(xml: string): Geometry | null {
	const parts: Geometry[] = [];
	// Polygoner först, så att deras ringar inte räknas som linjer.
	const polyRe = /<gml:Polygon\b[^>]*>([\s\S]*?)<\/gml:Polygon>/g;
	let rest = xml;
	for (const m of xml.matchAll(polyRe)) {
		const rings: Position[][] = [];
		for (const c of m[1].matchAll(/<gml:coordinates\b[^>]*>([\s\S]*?)<\/gml:coordinates>/g)) {
			const ring = parseCoordString(c[1]);
			if (ring.length >= 4) rings.push(ring);
		}
		if (rings.length) parts.push({ type: "Polygon", coordinates: rings });
		rest = rest.replace(m[0], "");
	}
	for (const m of rest.matchAll(/<gml:LineString\b[^>]*>([\s\S]*?)<\/gml:LineString>/g)) {
		const c = /<gml:coordinates\b[^>]*>([\s\S]*?)<\/gml:coordinates>/.exec(m[1]);
		const line = c ? parseCoordString(c[1]) : [];
		if (line.length >= 2) parts.push({ type: "LineString", coordinates: line });
	}
	for (const m of rest.matchAll(/<gml:Point\b[^>]*>([\s\S]*?)<\/gml:Point>/g)) {
		const c = /<gml:coordinates\b[^>]*>([\s\S]*?)<\/gml:coordinates>/.exec(m[1]);
		const pt = c ? parseCoordString(c[1]) : [];
		if (pt.length === 1) parts.push({ type: "Point", coordinates: pt[0] });
	}
	if (parts.length === 0) return null;
	if (parts.length === 1) return parts[0];
	return { type: "GeometryCollection", geometries: parts };
}

/** Ungefärlig ruta (WGS 84) som täcker en cirkel med radien `radiusM` runt `p`. */
export function bboxAround(p: LatLon, radiusM: number): [number, number, number, number] {
	const dLat = radiusM / 111_000 + 1e-5;
	const dLon = radiusM / (111_000 * Math.cos((p.lat * Math.PI) / 180)) + 1e-5;
	return [p.lon - dLon, p.lat - dLat, p.lon + dLon, p.lat + dLat];
}
