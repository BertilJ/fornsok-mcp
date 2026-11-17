/**
 * Ligger frågans geografiska filter helt inom det semantiska omfånget?
 * (SPEC 5.2: den semantiska kanalen används bara då, annars får rikstäckande
 * frågor slagsida mot omfånget.)
 *
 * Synkron och utan I/O (kontraktet för `SemanticSearch.scopeCovers` i
 * src/sources/types.ts). Underlaget är omfang-data.ts, genererat ur hela
 * landets GeoPackage med inläsningens egen indelning.
 *
 * Filtren OCH-kopplas, så träffmängden ligger inom varje enskilt geografiskt
 * filter. Det räcker därför att ETT av dem ligger helt inom omfånget:
 * - lan: alla angivna län i omfånget.
 * - kommun, landskap: varje angivet område har bara lämningar med minst ett
 *   län i omfånget.
 * - socken: samma, för de socknar namnet (och ev. länsavgränsning) avser – på
 *   samma sätt som indexets filter (src/store/filter.ts).
 * - nara, bbox: varje 2 × 2 km-ruta som sökrutan når ligger i ett läns mask
 *   (alla lämningar som når rutan ligger i länet, eller rutan är tom och
 *   omsluten av länet).
 * Okända namn ger false (försiktigt). Utan geografiskt filter: false.
 */
import { boxAround, type SwerefBox, wgsBoxToSweref } from "../store/spatial";
import { isInSweden, toPlanar } from "../geo/sweref";
import type { ResolvedSearchFilter } from "../sources/types";
import { OMFANG_DATA } from "./omfang-data";
import { cellsForBox, decodeMask } from "./omfang-mask";
import type { Scope } from "./scope";

export interface CoverageData {
	kommun: Record<string, string[]>;
	socken: Record<string, Record<string, string[]>>;
	landskap: Record<string, string[]>;
	rutor: Record<string, string>;
}

const maskCache = new Map<string, Uint8Array>();

function mask(data: CoverageData, lan: string): Uint8Array | null {
	const key = `${data === OMFANG_DATA ? "std" : "x"}:${lan}`;
	let m = maskCache.get(key);
	if (!m) {
		const s = data.rutor[lan];
		if (s === undefined) return null;
		m = decodeMask(s);
		if (data === OMFANG_DATA) maskCache.set(key, m);
	}
	return m;
}

/** Varje län-mängd har minst ett län i omfånget (tom mängd = lämning utan län: utanför). */
function setsCovered(sets: readonly string[] | undefined, scope: Scope): boolean {
	if (!sets || sets.length === 0) return false;
	return sets.every((s) => s !== "" && s.split("+").some((l) => scope.lan.includes(l)));
}

function boxCovered(box: SwerefBox, scope: Scope, data: CoverageData): boolean {
	const cells = cellsForBox(box);
	if (!cells || cells.length === 0 || cells.length > 20_000) return false;
	const masks = scope.lan.map((l) => mask(data, l)).filter((m): m is Uint8Array => !!m);
	if (!masks.length) return false;
	return cells.every((i) => masks.some((m) => m[i] === 1));
}

/** Har filtret någon geografisk avgränsning? */
export function hasGeoFilter(f: ResolvedSearchFilter): boolean {
	return !!(
		f.lan?.length ||
		f.kommun?.length ||
		f.socken?.length ||
		f.landskap?.length ||
		f.nara ||
		f.bbox
	);
}

export function scopeCovers(
	filter: ResolvedSearchFilter,
	scope: Scope,
	data: CoverageData = OMFANG_DATA,
): boolean {
	if (!scope.lan.length || !hasGeoFilter(filter)) return false;

	if (filter.lan?.length && filter.lan.every((l) => scope.lan.includes(l))) return true;

	if (filter.kommun?.length && filter.kommun.every((k) => setsCovered(data.kommun[k], scope)))
		return true;

	if (
		filter.landskap?.length &&
		filter.landskap.every((l) => setsCovered(data.landskap[l], scope))
	)
		return true;

	if (filter.socken?.length) {
		const ok = filter.socken.every((s) => {
			const byLan = data.socken[s.namn];
			if (!byLan) return false;
			const restrict = s.lan?.length ? s.lan : null;
			const keys = Object.keys(byLan).filter(
				(k) => !restrict || k === "" || restrict.includes(k),
			);
			return keys.length > 0 && keys.every((k) => setsCovered(byLan[k], scope));
		});
		if (ok) return true;
	}

	if (filter.nara) {
		const { lat, lon, radie_m } = filter.nara;
		if (
			Number.isFinite(lat) &&
			Number.isFinite(lon) &&
			Number.isFinite(radie_m) &&
			radie_m > 0 &&
			isInSweden({ lat, lon })
		) {
			if (boxCovered(boxAround(toPlanar({ lat, lon }), radie_m), scope, data)) return true;
		}
	}

	if (filter.bbox) {
		try {
			if (boxCovered(wgsBoxToSweref(filter.bbox), scope, data)) return true;
		} catch {
			// ogiltig ruta: inte täckt
		}
	}
	return false;
}
