/**
 * Från källpost (en lämning ur GeoPackage-filen, geometri i SWEREF 99 TM) till
 * indexrad: mittpunkt, omslutande ruta, höjdklass, GeoJSON i WGS 84, uppdelad
 * indelning med koder, och innehållshash.
 */
import { createHash } from "node:crypto";
import { countPositions, type Geometry, type Position, simplifyToLimit, swerefToWgs } from "../src/geo/geometry.ts";
import { round, toLatLon } from "../src/geo/sweref.ts";
import { RUMSKLASS_HOJD } from "../src/store/spatial.ts";
import type { Referens } from "./referens.ts";

/** Ändras när omvandlingen ändras, så att avstämningen ser alla rader som ändrade. */
export const TRANSFORM_VERSION = "1";

export interface KallGeometri {
	nr: string | null;
	geometry: Geometry;
}

export interface KallEgenskap {
	ingaende_nr: number | null;
	typ: string;
	varde: string;
}

export interface KallIngaende {
	nr: number;
	lamningstyp: string;
	antal: number | null;
}

/** En lämning som den står i GeoPackage-filen (text normaliserad, inget härlett). */
export interface KallPost {
	uuid: string;
	lamningsnummer: string | null;
	raa_nummer: string | null;
	lamningstyp: string | null;
	beskrivning: string | null;
	publicerad_av: string | null;
	publiceringsdatum: string | null;
	uttagsdatum: string | null;
	bedomning: string | null;
	bedomning_motivering: string | null;
	aktualitet: string | null;
	skada: string | null;
	undersokning: string | null;
	placering: string | null;
	terrang: string | null;
	orientering: string | null;
	tradition: string | null;
	namn: string | null;
	lan: string | null;
	kommun: string | null;
	socken: string | null;
	osakerhet_m: number | null;
	geometrier: KallGeometri[];
	egenskaper: KallEgenskap[];
	ingaende: KallIngaende[];
}

export type Niva = "lan" | "kommun" | "socken" | "landskap";

export interface IndexOmrade {
	niva: Niva;
	namn: string;
	kod: string | null;
}

/** Kolumnerna i tabellen lamning, i den ordning SQL-skrivaren använder. */
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

export interface IndexPost {
	rad: LamningRad;
	/** Socken har länsnamn i `lan` för att skilja socknar med samma namn åt. */
	omraden: Array<IndexOmrade & { lan: string }>;
	egenskaper: KallEgenskap[];
	ingaende: KallIngaende[];
}

/** Höjdgränser (meter) för rumsklasserna 0–2; större hamnar i klass 3. Delas med frågemodulen. */
export { RUMSKLASS_HOJD };

/** Största GeoJSON-text som lagras oförenklad (D1: högst 2 MB per rad). */
export const MAX_GEOJSON_BYTES = 1_000_000;

// ---------------------------------------------------------------- text

/** NFC, trimmat, tomt → null. */
export function text(x: unknown): string | null {
	if (typeof x !== "string") return null;
	// NUL kan inte stå i en SQL-sträng; övriga styrtecken utom radbrytning/tabb tas bort.
	// oxlint-disable-next-line no-control-regex -- styrtecken tas bort avsiktligt
	const s = x.normalize("NFC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
	return s.length ? s : null;
}

/** Dela flerledat fält ("Bjursås,Leksand"). */
export function splitList(s: string | null): string[] {
	if (!s) return [];
	const out: string[] = [];
	for (const part of s.split(",")) {
		const t = part.trim();
		if (t && !out.includes(t)) out.push(t);
	}
	return out;
}

/** Normalisering av RAÄ-nummer för uppslag: gemener, enkla mellanslag, NFC. */
export function raaSok(s: string | null): string | null {
	if (!s) return null;
	const t = s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
	return t || null;
}

// ---------------------------------------------------------------- geometri

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

/** Slå ihop flera geometrier: en → oförändrad, samma typ → Multi*, blandat → samling. */
export function combine(geoms: Geometry[]): Geometry | null {
	if (geoms.length === 0) return null;
	if (geoms.length === 1) return geoms[0];
	const types = new Set(geoms.map((g) => g.type));
	if (types.size === 1) {
		const t = geoms[0].type;
		if (t === "Point") return { type: "MultiPoint", coordinates: geoms.map((g) => (g as { coordinates: Position }).coordinates) };
		if (t === "LineString")
			return { type: "MultiLineString", coordinates: geoms.map((g) => (g as { coordinates: Position[] }).coordinates) };
		if (t === "Polygon")
			return { type: "MultiPolygon", coordinates: geoms.map((g) => (g as { coordinates: Position[][] }).coordinates) };
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
	// Skosnöresformeln, relativt första punkten för numerisk stabilitet.
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
			// Yttre ring adderas, hål subtraheras, oavsett ringarnas riktning.
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

/**
 * Mittpunkt: ytviktad tyngdpunkt om geometrin har ytor, annars längdviktad för
 * linjer, annars medelvärdet av punkterna. Kan hamna utanför en krökt yta.
 */
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

// ---------------------------------------------------------------- indelning

export class Indelning {
	private lanKod = new Map<string, string>();
	private kommunKod = new Map<string, string>();
	private kommunLan = new Map<string, string>();
	private socknar = new Map<string, Array<{ id: string; lan: Set<string> }>>();
	private landskap: Referens["landskap"];
	private landskapKod = new Map<string, string>();
	/** Lämningar vars socken inte gick att knyta till ett landskap. */
	utanLandskap = 0;

	constructor(ref: Referens | null) {
		this.landskap = ref?.landskap ?? [];
		if (!ref) return;
		const lanByKod = new Map<string, string>();
		for (const l of ref.lan) {
			this.lanKod.set(l.namn, l.kod);
			lanByKod.set(l.kod, l.namn);
		}
		const kommunByKod = new Map<string, string>();
		for (const k of ref.kommuner) {
			this.kommunKod.set(k.namn, k.kod);
			this.kommunLan.set(k.namn, k.lan_namn);
			kommunByKod.set(k.kod, k.lan_namn);
		}
		for (const s of ref.socknar) {
			const lan = new Set(s.kommunkoder.map((k) => kommunByKod.get(k)).filter((x): x is string => !!x));
			const list = this.socknar.get(s.namn) ?? [];
			list.push({ id: s.id, lan });
			this.socknar.set(s.namn, list);
		}
		for (const l of ref.landskap) this.landskapKod.set(l.namn, l.kod);
	}

	/**
	 * Län för en socken i en lämning. Lämningens län- och sockenlistor är inte
	 * parade, så länet väljs bland socknens möjliga län (ur värdelistan) som
	 * också finns hos lämningen; finns inget sådant men socknen bara i ett län,
	 * används det.
	 */
	private sockenLan(socken: string, lan: string[], kommuner: string[]): string {
		const cand = this.socknar.get(socken) ?? [];
		const candLan = new Set<string>();
		for (const c of cand) for (const l of c.lan) candLan.add(l);
		const both = lan.filter((l) => candLan.has(l));
		if (both.length === 1) return both[0];
		if (both.length > 1) {
			const kommunLan = new Set(kommuner.map((k) => this.kommunLan.get(k)).filter((x): x is string => !!x));
			return both.find((l) => kommunLan.has(l)) ?? both[0];
		}
		if (candLan.size === 1) return [...candLan][0];
		return lan[0] ?? "";
	}

	private sockenKod(socken: string, lan: string): string | null {
		const cand = (this.socknar.get(socken) ?? []).filter((c) => c.lan.has(lan));
		return cand.length === 1 ? cand[0].id : null;
	}

	/**
	 * Landskap per socken: det landskap där socknen har flest lämningar enligt
	 * K-samsök, bland landskap som delar län med lämningen (socknamn som Bro och
	 * Ekeby finns i flera landskap; gränsöverskridande lämningar ger dessutom
	 * enstaka träffar i grannlandskap).
	 */
	private landskapFor(socknar: string[], lan: string[]): string[] {
		const out: string[] = [];
		const lanLower = lan.map((l) => l.toLowerCase());
		for (const s of socknar) {
			const sl = s.toLowerCase();
			let cand = this.landskap.filter((l) => (l.socknar[sl] ?? 0) > 0);
			if (cand.length > 1) {
				const narrowed = cand.filter((l) => l.lan.some((x) => lanLower.includes(x)));
				if (narrowed.length) cand = narrowed;
			}
			let best: (typeof cand)[number] | null = null;
			for (const c of cand) if (!best || c.socknar[sl] > best.socknar[sl]) best = c;
			if (best && !out.includes(best.namn)) out.push(best.namn);
		}
		return out;
	}

	omraden(p: KallPost): Array<IndexOmrade & { lan: string }> {
		const lan = splitList(p.lan);
		const kommun = splitList(p.kommun);
		const socken = splitList(p.socken);
		const landskap = this.landskapFor(socken, lan);
		if (socken.length && !landskap.length) this.utanLandskap++;
		return [
			...lan.map((namn) => ({ niva: "lan" as const, namn, kod: this.lanKod.get(namn) ?? null, lan: "" })),
			...kommun.map((namn) => ({ niva: "kommun" as const, namn, kod: this.kommunKod.get(namn) ?? null, lan: "" })),
			...socken.map((namn) => {
				// Länet behövs bara för att skilja socknar med samma namn åt (Berg, Bro, Ekeby …).
				// Värdelistans kommunkoder är för breda för att ge länet för alla socknar.
				const cand = this.socknar.get(namn) ?? [];
				if (cand.length <= 1) return { niva: "socken" as const, namn, kod: cand[0]?.id ?? null, lan: "" };
				const l = this.sockenLan(namn, lan, kommun);
				return { niva: "socken" as const, namn, kod: this.sockenKod(namn, l), lan: l };
			}),
			...landskap.map((namn) => ({ niva: "landskap" as const, namn, kod: this.landskapKod.get(namn) ?? null, lan: "" })),
		];
	}
}

// ---------------------------------------------------------------- hash

function canonical(x: unknown): string {
	return JSON.stringify(x, (_k, v) => {
		if (v && typeof v === "object" && !Array.isArray(v)) {
			const o: Record<string, unknown> = {};
			for (const k of Object.keys(v).sort()) o[k] = (v as Record<string, unknown>)[k];
			return o;
		}
		if (typeof v === "number") return Math.round(v * 1000) / 1000;
		return v;
	});
}

/**
 * Innehållshash över källposten utom uttagsdatum, med geometrin i millimeter.
 * Barnrader sorteras så att ordningen i filen inte spelar roll. 32 hex-tecken.
 */
export function contentHash(p: KallPost): string {
	const { uttagsdatum: _u, ...rest } = p;
	const sortKey = (x: unknown) => canonical(x);
	const norm = {
		v: TRANSFORM_VERSION,
		...rest,
		geometrier: [...p.geometrier].map((g) => ({ nr: g.nr, g: g.geometry })).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1)),
		egenskaper: [...p.egenskaper].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1)),
		ingaende: [...p.ingaende].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1)),
	};
	return createHash("sha256").update(canonical(norm)).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------- post → rad

export function toIndexPost(p: KallPost, indelning: Indelning): IndexPost {
	const geoms = [...p.geometrier].sort((a, b) => (a.nr ?? "").localeCompare(b.nr ?? "", "sv", { numeric: true }));
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
		// Mycket stora geometrier förenklas så att raden ryms i D1 (2 MB per rad).
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
		hash: contentHash(p),
	};
	const egenskaper = [...p.egenskaper].sort(
		(a, b) => (a.ingaende_nr ?? -1) - (b.ingaende_nr ?? -1) || a.typ.localeCompare(b.typ, "sv") || a.varde.localeCompare(b.varde, "sv"),
	);
	const ingaende = [...p.ingaende].sort((a, b) => a.nr - b.nr);
	return { rad, omraden: indelning.omraden(p), egenskaper, ingaende };
}
