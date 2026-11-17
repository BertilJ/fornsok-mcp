/**
 * Gauss-Krüger-projektion enligt Lantmäteriets formler (GRS 80, fyra termer),
 * utan externa beroenden. SWEREF 99 TM (EPSG:3006) är en instans; de lokala
 * SWEREF 99-zonerna kan räknas med samma kod (används i testerna mot
 * Lantmäteriets kontrollpunkter).
 *
 * WGS 84 och SWEREF 99 skiljer sig på decimeternivå, vilket saknar betydelse
 * här; de behandlas som samma geografiska system (praxis i Sverige).
 */

export interface Projection {
	/** Medelmeridian i grader. */
	centralMeridian: number;
	scale: number;
	falseNorthing: number;
	falseEasting: number;
}

export const SWEREF99TM: Projection = {
	centralMeridian: 15,
	scale: 0.9996,
	falseNorthing: 0,
	falseEasting: 500_000,
};

/** Plan koordinat: E (öst) och N (nord) i meter. */
export interface Planar {
	e: number;
	n: number;
}

export interface LatLon {
	lat: number;
	lon: number;
}

// GRS 80
const A = 6378137.0;
const F = 1 / 298.257222101;
const E2 = F * (2 - F);
const N = F / (2 - F);
const A_ROOF = (A / (1 + N)) * (1 + (N * N) / 4 + (N ** 4) / 64);

const DEG = Math.PI / 180;

// Framåt
const FA = E2;
const FB = (5 * E2 ** 2 - E2 ** 3) / 6;
const FC = (104 * E2 ** 3 - 45 * E2 ** 4) / 120;
const FD = (1237 * E2 ** 4) / 1260;
const BETA = [
	N / 2 - (2 * N ** 2) / 3 + (5 * N ** 3) / 16 + (41 * N ** 4) / 180,
	(13 * N ** 2) / 48 - (3 * N ** 3) / 5 + (557 * N ** 4) / 1440,
	(61 * N ** 3) / 240 - (103 * N ** 4) / 140,
	(49561 * N ** 4) / 161280,
];

// Bakåt
const DELTA = [
	N / 2 - (2 * N ** 2) / 3 + (37 * N ** 3) / 96 - N ** 4 / 360,
	N ** 2 / 48 + N ** 3 / 15 - (437 * N ** 4) / 1440,
	(17 * N ** 3) / 480 - (37 * N ** 4) / 840,
	(4397 * N ** 4) / 161280,
];
const IA = E2 + E2 ** 2 + E2 ** 3 + E2 ** 4;
const IB = -(7 * E2 ** 2 + 17 * E2 ** 3 + 30 * E2 ** 4) / 6;
const IC = (224 * E2 ** 3 + 889 * E2 ** 4) / 120;
const ID = -(4279 * E2 ** 4) / 1260;

/** Geografisk (grader) → plan (meter). */
export function toPlanar(p: LatLon, proj: Projection = SWEREF99TM): Planar {
	const phi = p.lat * DEG;
	const dLambda = (p.lon - proj.centralMeridian) * DEG;
	const s = Math.sin(phi);
	const s2 = s * s;
	const phiStar = phi - s * Math.cos(phi) * (FA + FB * s2 + FC * s2 * s2 + FD * s2 * s2 * s2);
	const xiP = Math.atan(Math.tan(phiStar) / Math.cos(dLambda));
	const etaP = Math.atanh(Math.cos(phiStar) * Math.sin(dLambda));
	let x = xiP;
	let y = etaP;
	for (let i = 0; i < 4; i++) {
		const k = 2 * (i + 1);
		x += BETA[i] * Math.sin(k * xiP) * Math.cosh(k * etaP);
		y += BETA[i] * Math.cos(k * xiP) * Math.sinh(k * etaP);
	}
	return {
		n: proj.scale * A_ROOF * x + proj.falseNorthing,
		e: proj.scale * A_ROOF * y + proj.falseEasting,
	};
}

/** Plan (meter) → geografisk (grader). */
export function toLatLon(p: Planar, proj: Projection = SWEREF99TM): LatLon {
	const xi = (p.n - proj.falseNorthing) / (proj.scale * A_ROOF);
	const eta = (p.e - proj.falseEasting) / (proj.scale * A_ROOF);
	let xiP = xi;
	let etaP = eta;
	for (let i = 0; i < 4; i++) {
		const k = 2 * (i + 1);
		xiP -= DELTA[i] * Math.sin(k * xi) * Math.cosh(k * eta);
		etaP -= DELTA[i] * Math.cos(k * xi) * Math.sinh(k * eta);
	}
	const phiStar = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
	const dLambda = Math.atan(Math.sinh(etaP) / Math.cos(xiP));
	const s = Math.sin(phiStar);
	const s2 = s * s;
	const phi = phiStar + s * Math.cos(phiStar) * (IA + IB * s2 + IC * s2 * s2 + ID * s2 * s2 * s2);
	return { lat: phi / DEG, lon: proj.centralMeridian + dLambda / DEG };
}

/** Grov ruta runt Sverige (med marginal), i WGS 84. */
export const SWEDEN_BBOX = { minLon: 10.0, minLat: 55.0, maxLon: 24.5, maxLat: 69.2 } as const;

export function isInSweden(p: LatLon): boolean {
	return (
		p.lat >= SWEDEN_BBOX.minLat &&
		p.lat <= SWEDEN_BBOX.maxLat &&
		p.lon >= SWEDEN_BBOX.minLon &&
		p.lon <= SWEDEN_BBOX.maxLon
	);
}

export function round(value: number, decimals: number): number {
	const f = 10 ** decimals;
	return Math.round(value * f) / f;
}
