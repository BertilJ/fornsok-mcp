/**
 * Tolkning av GeoPackage-geometriblobbar: GPKG-huvud (OGC 12-128r18, 2.1.3)
 * följt av WKB (ISO 13249 / OGC Simple Features). Indata behandlas som
 * opålitliga: varje läsning kontrolleras mot buffertens längd, och djup och
 * antal är begränsade.
 *
 * Returnerar GeoJSON-liknande geometri i filens koordinatsystem (här
 * SWEREF 99 TM). Z- och M-värden tas bort.
 */
import type { Geometry, Position } from "../src/geo/geometry.ts";

export class GpkgError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GpkgError";
	}
}

export interface GpkgGeometry {
	srsId: number;
	/** null för tom geometri. */
	geometry: Geometry | null;
}

const MAX_DEPTH = 4;
const MAX_COUNT = 10_000_000;

class Reader {
	private view: DataView;
	pos: number;
	private buf: Uint8Array;
	constructor(buf: Uint8Array, start: number) {
		this.buf = buf;
		this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
		this.pos = start;
	}
	need(n: number) {
		if (n < 0 || this.pos + n > this.buf.byteLength) throw new GpkgError("geometriblobben är avkortad");
	}
	u8(): number {
		this.need(1);
		return this.view.getUint8(this.pos++);
	}
	u32(le: boolean): number {
		this.need(4);
		const v = this.view.getUint32(this.pos, le);
		this.pos += 4;
		return v;
	}
	i32(le: boolean): number {
		this.need(4);
		const v = this.view.getInt32(this.pos, le);
		this.pos += 4;
		return v;
	}
	f64(le: boolean): number {
		this.need(8);
		const v = this.view.getFloat64(this.pos, le);
		this.pos += 8;
		return v;
	}
	count(le: boolean, bytesPerItem: number): number {
		const n = this.u32(le);
		if (n > MAX_COUNT) throw new GpkgError("orimligt antal element i WKB");
		// Varje element tar minst bytesPerItem byte; kontrollera innan något allokeras.
		this.need(n * bytesPerItem);
		return n;
	}
}

/** Läs GPKG-huvudet och WKB-geometrin. */
export function parseGpkgGeometry(blob: Uint8Array): GpkgGeometry {
	if (!(blob instanceof Uint8Array) || blob.byteLength < 8) throw new GpkgError("geometriblobben är för kort");
	if (blob[0] !== 0x47 || blob[1] !== 0x50) throw new GpkgError("saknar GPKG-huvud (GP)");
	const version = blob[2];
	if (version !== 0) throw new GpkgError(`okänd GPKG-version ${version}`);
	const flags = blob[3];
	if (flags & 0b0010_0000) throw new GpkgError("utökad GPKG-geometri stöds inte");
	const empty = (flags & 0b0001_0000) !== 0;
	const envelope = (flags >> 1) & 0b111;
	const headerLE = (flags & 1) === 1;
	const envBytes = [0, 32, 48, 48, 64][envelope];
	if (envBytes === undefined) throw new GpkgError(`ogiltig envelope-kod ${envelope}`);
	const r = new Reader(blob, 4);
	const srsId = r.i32(headerLE);
	r.need(envBytes);
	r.pos += envBytes;
	if (empty) return { srsId, geometry: null };
	const geometry = readWkb(r, 0);
	return { srsId, geometry: isEmpty(geometry) ? null : geometry };
}

function isEmpty(g: Geometry): boolean {
	switch (g.type) {
		case "Point":
			return g.coordinates.length < 2 || g.coordinates.some((c) => Number.isNaN(c));
		case "GeometryCollection":
			return g.geometries.length === 0;
		default:
			return g.coordinates.length === 0;
	}
}

function readWkb(r: Reader, depth: number): Geometry {
	if (depth > MAX_DEPTH) throw new GpkgError("för djupt nästlad WKB");
	const order = r.u8();
	if (order !== 0 && order !== 1) throw new GpkgError(`ogiltig byteordning ${order}`);
	const le = order === 1;
	let type = r.u32(le);
	// EWKB-flaggor (Z 0x80000000, M 0x40000000, SRID 0x20000000).
	let hasZ = false;
	let hasM = false;
	if (type & 0x20000000) throw new GpkgError("EWKB med SRID stöds inte");
	if (type & 0x80000000) hasZ = true;
	if (type & 0x40000000) hasM = true;
	type &= 0x0fffffff;
	// ISO: 1000 Z, 2000 M, 3000 ZM.
	const iso = Math.floor(type / 1000);
	if (iso === 1 || iso === 3) hasZ = true;
	if (iso === 2 || iso === 3) hasM = true;
	type %= 1000;
	const dims = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);

	const point = (): Position => {
		const x = r.f64(le);
		const y = r.f64(le);
		for (let i = 2; i < dims; i++) r.f64(le);
		return [x, y];
	};
	const path = (): Position[] => {
		const n = r.count(le, dims * 8);
		const out: Position[] = new Array(n);
		for (let i = 0; i < n; i++) out[i] = point();
		return out;
	};
	const rings = (): Position[][] => {
		const n = r.count(le, 4);
		const out: Position[][] = new Array(n);
		for (let i = 0; i < n; i++) out[i] = path();
		return out;
	};
	const parts = <T extends Geometry["type"]>(expect: T): Array<Extract<Geometry, { type: T }>> => {
		const n = r.count(le, 5);
		const out: Array<Extract<Geometry, { type: T }>> = [];
		for (let i = 0; i < n; i++) {
			const g = readWkb(r, depth + 1);
			if (g.type !== expect) throw new GpkgError(`förväntade ${expect} i multigeometri, fick ${g.type}`);
			out.push(g as Extract<Geometry, { type: T }>);
		}
		return out;
	};

	switch (type) {
		case 1:
			return { type: "Point", coordinates: point() };
		case 2:
			return { type: "LineString", coordinates: path() };
		case 3:
			return { type: "Polygon", coordinates: rings() };
		case 4:
			return { type: "MultiPoint", coordinates: parts("Point").map((p) => p.coordinates) };
		case 5:
			return { type: "MultiLineString", coordinates: parts("LineString").map((p) => p.coordinates) };
		case 6:
			return { type: "MultiPolygon", coordinates: parts("Polygon").map((p) => p.coordinates) };
		case 7: {
			const n = r.count(le, 5);
			const geometries: Geometry[] = [];
			for (let i = 0; i < n; i++) geometries.push(readWkb(r, depth + 1));
			return { type: "GeometryCollection", geometries };
		}
		default:
			throw new GpkgError(`WKB-typ ${type} stöds inte`);
	}
}
