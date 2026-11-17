import { describe, expect, it } from "vitest";
import { compassDirection, nearestPoint, parseGml, simplifyToLimit, countPositions, type Geometry } from "../src/geo/geometry";
import { isInSweden, type Projection, SWEREF99TM, toLatLon, toPlanar } from "../src/geo/sweref";
import { buildCql2, cqlString } from "../src/sources/ogc/cql2";
import { buildItemsUrl, parseFeatureCollection } from "../src/sources/ogc/source";
import { dedupeAndMeasure } from "../src/tools/lamningar_nara";
import { fixture } from "./helpers";

/** Lokal SWEREF 99-zon: skala 1, falsk östlig 150 000 m. */
const zone = (cm: number): Projection => ({ centralMeridian: cm, scale: 1, falseNorthing: 0, falseEasting: 150_000 });

describe("SWEREF 99 TM ⇄ WGS 84", () => {
	it("L2001:646: K-samsöks WGS 84-punkt mot Fornsök-appens SWEREF 99 TM-koordinat", () => {
		// K-samsök: lat 60.73368161435678, lon 15.456428761252013.
		// Fornsök-appen (test/fixtures/app-lamning-L2001-646.json): E 524892.601, N 6733210.685.
		const p = toPlanar({ lat: 60.73368161435678, lon: 15.456428761252013 });
		expect(p.e).toBeCloseTo(524892.601, 2);
		expect(p.n).toBeCloseTo(6733210.685, 2);
		const ll = toLatLon({ e: 524892.601, n: 6733210.685 });
		expect(ll.lat).toBeCloseTo(60.73368161435678, 8);
		expect(ll.lon).toBeCloseTo(15.456428761252013, 8);
	});

	// Lantmäteriet, "Kontrollpunkter för de lokala SWEREF 99-zonerna" (2007-11-20).
	// Samma Gauss-Krüger-formler som SWEREF 99 TM, med andra parametrar.
	const kontrollpunkter: Array<[string, Projection, number, number, number, number]> = [
		["SWEREF 99 12 00", zone(12), 57, 11.25, 6320164.077, 104421.39],
		["SWEREF 99 13 30", zone(13.5), 63, 12.75, 6988606.198, 111996.02],
		["SWEREF 99 15 00", zone(15), 59, 14.25, 6542910.921, 106894.103],
		["SWEREF 99 15 00", zone(15), 61, 15.75, 6765725.847, 190579.995],
		["SWEREF 99 20 15", zone(20.25), 69, 19.5, 7657608.465, 119992.964],
		["SWEREF 99 21 45", zone(21.75), 67, 22.5, 7434550.943, 182714.261],
	];
	for (const [namn, proj, lat, lon, n, e] of kontrollpunkter) {
		it(`Lantmäteriets kontrollpunkt ${namn} ${lat}°N ${lon}°E`, () => {
			const p = toPlanar({ lat, lon }, proj);
			expect(Math.abs(p.n - n)).toBeLessThan(0.001);
			expect(Math.abs(p.e - e)).toBeLessThan(0.001);
			const back = toLatLon({ n, e }, proj);
			// 1e-7 grader ≈ 1 cm
			expect(Math.abs(back.lat - lat)).toBeLessThan(1e-7);
			expect(Math.abs(back.lon - lon)).toBeLessThan(1e-7);
		});
	}

	it("går fram och tillbaka över hela landet", () => {
		for (const [lat, lon] of [[55.3, 13.0], [59.33, 18.07], [63.2, 15.66], [68.4, 22.5], [65.8, 11.2]]) {
			const back = toLatLon(toPlanar({ lat, lon }));
			expect(back.lat).toBeCloseTo(lat, 9);
			expect(back.lon).toBeCloseTo(lon, 9);
		}
	});

	it("medelmeridianen ger E = 500 000", () => {
		expect(toPlanar({ lat: 62, lon: 15 }, SWEREF99TM).e).toBeCloseTo(500000, 6);
	});

	it("känner igen punkter utanför Sverige", () => {
		expect(isInSweden({ lat: 60.6, lon: 15.6 })).toBe(true);
		expect(isInSweden({ lat: 15.6, lon: 60.6 })).toBe(false); // omkastade
		expect(isInSweden({ lat: 52.5, lon: 13.4 })).toBe(false); // Berlin
	});
});

describe("avstånd till geometri", () => {
	const p = { e: 0, n: 0 };
	it("punkt, linje och yta", () => {
		expect(nearestPoint(p, { type: "Point", coordinates: [3, 4] }).distance).toBe(5);
		expect(nearestPoint(p, { type: "LineString", coordinates: [[-10, 5], [10, 5]] }).distance).toBe(5);
		const square: Geometry = { type: "Polygon", coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]] };
		expect(nearestPoint(p, square).distance).toBe(0);
		const far: Geometry = { type: "Polygon", coordinates: [[[10, -1], [12, -1], [12, 1], [10, 1], [10, -1]]] };
		const r = nearestPoint(p, far);
		expect(r.distance).toBe(10);
		expect(r.point).toEqual({ e: 10, n: 0 });
	});

	it("hål i yta räknas inte som inom", () => {
		const donut: Geometry = {
			type: "Polygon",
			coordinates: [
				[[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]],
				[[-2, -2], [2, -2], [2, 2], [-2, 2], [-2, -2]],
			],
		};
		expect(nearestPoint(p, donut).distance).toBe(2);
	});

	it("väderstreck", () => {
		expect(compassDirection(p, { e: 0, n: 100 })).toBe("N");
		expect(compassDirection(p, { e: 100, n: 100 })).toBe("NO");
		expect(compassDirection(p, { e: 100, n: 0 })).toBe("O");
		expect(compassDirection(p, { e: 0, n: -100 })).toBe("S");
		expect(compassDirection(p, { e: -100, n: -100 })).toBe("SV");
		expect(compassDirection(p, { e: -100, n: 10 })).toBe("V");
		expect(compassDirection(p, { e: 0, n: 0 })).toBeNull();
	});

	it("förenklar till högst ett antal brytpunkter", () => {
		const line: Geometry = { type: "LineString", coordinates: Array.from({ length: 2000 }, (_, i) => [i, Math.sin(i / 10) * 50]) };
		const s = simplifyToLimit(line, 500);
		expect(countPositions(s.geometry)).toBeLessThanOrEqual(500);
		expect(s.tolerance).toBeGreaterThan(0);
		const small: Geometry = { type: "Point", coordinates: [1, 2] };
		expect(simplifyToLimit(small, 500)).toEqual({ geometry: small, tolerance: 0 });
	});

	it("tolkar GML ur K-samsök", () => {
		expect(parseGml('<gml:Point><gml:coordinates cs="," ts=" ">15.4,60.7</gml:coordinates></gml:Point>')).toEqual({ type: "Point", coordinates: [15.4, 60.7] });
		const g = parseGml(
			'<gml:MultiGeometry><gml:geometryMember><gml:Point><gml:coordinates>1,2</gml:coordinates></gml:Point></gml:geometryMember><gml:geometryMember><gml:Polygon><gml:outerBoundaryIs><gml:LinearRing><gml:coordinates>0,0 1,0 1,1 0,0</gml:coordinates></gml:LinearRing></gml:outerBoundaryIs></gml:Polygon></gml:geometryMember></gml:MultiGeometry>',
		);
		expect(g?.type).toBe("GeometryCollection");
		expect(parseGml("<x/>")).toBeNull();
	});
});

describe("närhetssök: deduplicering och avstånd (inspelat svar runt L2000:8802)", () => {
	const page = parseFeatureCollection(fixture("ogc-items-nara-L2000-8802.json"));

	it("samlingen har ett objekt per geometri", () => {
		expect(page.numberMatched).toBe(7);
		expect(page.features).toHaveLength(7);
		expect(page.features.filter((f) => f.lamningsnummer === "L2000:8802")).toHaveLength(3);
	});

	it("deduplicerar på lämningsnummer och sorterar närmast först", () => {
		const center = toPlanar({ lat: 60.66159242831314, lon: 15.554018818384327 });
		const res = dedupeAndMeasure(center, page.features);
		expect(res).toHaveLength(4);
		expect(res[0].feature.lamningsnummer).toBe("L2000:8802");
		expect(res[0].distance).toBeLessThan(1);
		expect(res[0].geometrier).toBe(3);
		expect(res[0].geometrityper.sort()).toEqual(["Point", "Polygon"]);
		for (let i = 1; i < res.length; i++) expect(res[i].distance).toBeGreaterThanOrEqual(res[i - 1].distance);
		expect(new Set(res.map((r) => r.feature.lamningsnummer)).size).toBe(res.length);
		// UUID kommer ur url-fältet, inte pk_id (som är geometrins id).
		expect(res[0].feature.uuid).toBe("6d1cf7b6-f5bd-4066-aba6-fb1ea3ce8c75");
	});

	it("avstånd räknas till närmaste punkt på ytan, inte mittpunkten", () => {
		// En punkt strax utanför hyttområdets yta, långt från dess mittpunkt.
		const poly = page.features.find((f) => f.lamningsnummer === "L2000:8802" && f.geometry.type === "Polygon");
		expect(poly).toBeDefined();
		const ring = (poly!.geometry as { coordinates: number[][][] }).coordinates[0];
		const corner = ring[0];
		const q = toPlanar({ lat: corner[1] + 0.0005, lon: corner[0] });
		const res = dedupeAndMeasure(q, [poly!]);
		expect(res[0].distance).toBeLessThan(60);
	});
});

describe("CQL2 och OGC-adress", () => {
	it("citerar och dubblerar apostrofer", () => {
		expect(cqlString("Hyttområde")).toBe("'Hyttområde'");
		expect(cqlString("a'b")).toBe("'a''b'");
		expect(cqlString("x' OR 1=1 OR lamningstyp='y")).toBe("'x'' OR 1=1 OR lamningstyp=''y'");
	});

	it("bygger samma filter som verifierades mot GeoServer", () => {
		expect(buildCql2({ lamningstyp: ["Hyttområde", "Gruvområde"], antikvariskbedomning: ["Fornlämning"] })).toBe(
			"(lamningstyp = 'Hyttområde' OR lamningstyp = 'Gruvområde') AND (antikvariskbedomning = 'Fornlämning')",
		);
		expect(buildCql2({})).toBeNull();
		expect(buildCql2({ lamningstyp: [] })).toBeNull();
	});

	it("lägger filter och bbox i adressen", () => {
		const u = new URL(buildItemsUrl({ bbox: [15.5449, 60.6571, 15.5631, 60.6661], limit: 1000, antikvarisk_bedomning: ["Fornlämning"] }));
		expect(u.searchParams.get("bbox")).toBe("15.5449,60.6571,15.5631,60.6661");
		expect(u.searchParams.get("filter-lang")).toBe("cql2-text");
		expect(u.searchParams.get("filter")).toBe("(antikvariskbedomning = 'Fornlämning')");
		const u2 = new URL(buildItemsUrl({ bbox: [15, 60, 15.1, 60.1], limit: 10 }));
		expect(u2.searchParams.has("filter")).toBe(false);
	});
});
