/**
 * WHERE-villkor för indexfrågor. Allt binds som parametrar; listor skickas som
 * en JSON-parameter och packas upp med json_each, så att antalet parametrar
 * håller sig långt under D1:s gräns på 100 per fråga.
 */
import type { Bedomning, Egenskap, ResolvedSearchFilter } from "../sources/types";
import { IndexInputError } from "./d1";
import { buildFtsQuery, type FtsQuery } from "./fts";
import { checkedPlanar, boxAround, spatialCondition, type SqlPart, type SwerefBox, wgsBoxToSweref } from "./spatial";
import type { Planar } from "../geo/sweref";

/** Filter för indexet: källgränssnittets filter plus det indexet tillför (SPEC 6). */
export interface IndexSearchFilter extends ResolvedSearchFilter {
	/** Fritext; delas i ord och OCH-kopplas med `ord` (se fts.ts). */
	fraga?: string;
	kategori?: string[];
	/** Samma typ: något av värdena. Olika typer: alla måste finnas. Gäller även ingående lämningars egenskaper. */
	egenskap?: Egenskap[];
	/** Exakt avstånd till geometrin räknas i koden; SQL väljer kandidater med rutan. */
	nara?: { lat: number; lon: number; radie_m: number };
}

export const MAX_LIST = 50;
export const MAX_VALUE_LENGTH = 300;
export const MAX_RADIUS_M = 50_000;

export interface BuiltFilter {
	conditions: SqlPart[];
	fts: FtsQuery | null;
	/** Mittpunkt och radie för exakt avståndsfilter. */
	nara: { p: Planar; radie_m: number } | null;
	box: SwerefBox | null;
}

function list(name: string, x: unknown): string[] | null {
	if (x === undefined || x === null) return null;
	if (!Array.isArray(x)) throw new IndexInputError(`${name} ska vara en lista.`);
	const out = x
		.filter((v): v is string => typeof v === "string")
		.map((v) => v.normalize("NFC").trim())
		.filter((v) => v.length > 0);
	if (out.length > MAX_LIST) throw new IndexInputError(`${name}: högst ${MAX_LIST} värden.`);
	if (out.some((v) => v.length > MAX_VALUE_LENGTH)) throw new IndexInputError(`${name}: för långt värde.`);
	return out.length ? [...new Set(out)] : null;
}

const json = (v: unknown) => JSON.stringify(v);

function areaCondition(niva: "lan" | "kommun" | "landskap", namn: string[]): SqlPart {
	return {
		sql: "l.id IN (SELECT lo.lamning_id FROM lamning_omrade lo JOIN omrade o ON o.id = lo.omrade_id WHERE o.niva = ? AND o.namn IN (SELECT value FROM json_each(?)))",
		params: [niva, json(namn)],
	};
}

/** Normalisera lämningsnummer: "l2001:646" → "L2001:646". */
export function normLamningsnummer(s: string): string | null {
	const m = /^\s*l\s*(\d{4})\s*:\s*(\d+)\s*$/i.exec(s);
	return m ? `L${m[1]}:${m[2]}` : null;
}

/** Samma normalisering som ingest/transform.ts raaSok(). */
export function normRaa(s: string): string {
	return s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function buildFilter(f: IndexSearchFilter): BuiltFilter {
	const c: SqlPart[] = [];

	const nummer = list("nummer", f.nummer);
	if (nummer) {
		const ln = nummer.map(normLamningsnummer).filter((x): x is string => !!x);
		const raa = nummer.map(normRaa);
		const uuids = nummer.map((x) => x.toLowerCase()).filter((x) => /^[0-9a-f-]{36}$/.test(x));
		c.push({
			sql: "(l.lamningsnummer IN (SELECT value FROM json_each(?)) OR l.raa_sok IN (SELECT value FROM json_each(?)) OR l.uuid IN (SELECT value FROM json_each(?)))",
			params: [json(ln), json(raa), json(uuids)],
		});
	}
	const typ = list("lamningstyp", f.lamningstyp);
	if (typ) c.push({ sql: "l.lamningstyp IN (SELECT value FROM json_each(?))", params: [json(typ)] });
	const kat = list("kategori", f.kategori);
	if (kat)
		c.push({
			sql: "l.lamningstyp IN (SELECT lamningstyp FROM lamningstyp_kategori WHERE kategori IN (SELECT value FROM json_each(?)))",
			params: [json(kat)],
		});
	const bed = list("antikvarisk_bedomning", f.antikvarisk_bedomning as Bedomning[] | undefined);
	if (bed) c.push({ sql: "l.bedomning IN (SELECT value FROM json_each(?))", params: [json(bed)] });
	const lan = list("lan", f.lan);
	if (lan) c.push(areaCondition("lan", lan));
	const kommun = list("kommun", f.kommun);
	if (kommun) c.push(areaCondition("kommun", kommun));
	const landskap = list("landskap", f.landskap);
	if (landskap) c.push(areaCondition("landskap", landskap));

	if (f.socken !== undefined && f.socken !== null) {
		if (!Array.isArray(f.socken) || f.socken.length > MAX_LIST) throw new IndexInputError(`socken: högst ${MAX_LIST} värden.`);
		const s = f.socken
			.filter((x) => x && typeof x.namn === "string" && x.namn.trim())
			.map((x) => ({ namn: x.namn.normalize("NFC").trim(), lan: list("socken.lan", x.lan) ?? [] }));
		if (s.some((x) => x.namn.length > MAX_VALUE_LENGTH)) throw new IndexInputError("socken: för långt värde.");
		if (s.length) {
			// En socken utan län matchar alla socknar med namnet; med län bara socknar i de
			// länen. Socknar med unikt namn har tomt län i indexet och matchar alltid.
			c.push({
				sql: `l.id IN (SELECT lo.lamning_id FROM json_each(?) j
					JOIN omrade o ON o.niva = 'socken' AND o.namn = json_extract(j.value, '$.namn')
						AND (json_array_length(j.value, '$.lan') = 0 OR o.lan = '' OR o.lan IN (SELECT value FROM json_each(j.value, '$.lan')))
					JOIN lamning_omrade lo ON lo.omrade_id = o.id)`,
				params: [json(s)],
			});
		}
	}

	if (f.egenskap !== undefined && f.egenskap !== null) {
		if (!Array.isArray(f.egenskap) || f.egenskap.length > MAX_LIST) throw new IndexInputError(`egenskap: högst ${MAX_LIST} värden.`);
		const byTyp = new Map<string, string[]>();
		for (const e of f.egenskap) {
			if (!e || typeof e.typ !== "string" || typeof e.varde !== "string") continue;
			const t = e.typ.normalize("NFC").trim();
			const v = e.varde.normalize("NFC").trim();
			if (!t || !v || t.length > MAX_VALUE_LENGTH || v.length > MAX_VALUE_LENGTH) continue;
			byTyp.set(t, [...(byTyp.get(t) ?? []), v]);
		}
		for (const [t, v] of byTyp)
			c.push({
				sql: "l.id IN (SELECT lamning_id FROM egenskap WHERE typ = ? AND varde IN (SELECT value FROM json_each(?)))",
				params: [t, json(v)],
			});
	}

	let box: SwerefBox | null = null;
	if (f.bbox) box = wgsBoxToSweref(f.bbox);
	let nara: BuiltFilter["nara"] = null;
	if (f.nara) {
		const r = Number(f.nara.radie_m);
		if (!Number.isFinite(r) || r <= 0 || r > MAX_RADIUS_M) throw new IndexInputError(`nara.radie_m ska vara 1–${MAX_RADIUS_M}.`);
		const p = checkedPlanar(f.nara.lat, f.nara.lon);
		nara = { p, radie_m: r };
		const nb = boxAround(p, r);
		box = box ? intersect(box, nb) : nb;
	}
	if (box) c.push(spatialCondition(box));

	const fts = buildFtsQuery(f.fraga ?? null, f.ord ?? null);
	return { conditions: c, fts, nara, box };
}

function intersect(a: SwerefBox, b: SwerefBox): SwerefBox {
	const r: SwerefBox = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
	// Tom skärning: en ruta som inte matchar något.
	if (r[0] > r[2] || r[1] > r[3]) return [0, 0, -1, -1];
	return r;
}

/** Slå ihop villkor till "WHERE …" (eller tom sträng). */
export function where(parts: SqlPart[], extra: SqlPart[] = []): SqlPart {
	const all = [...extra, ...parts];
	if (!all.length) return { sql: "", params: [] };
	return { sql: `WHERE ${all.map((p) => p.sql).join(" AND ")}`, params: all.flatMap((p) => p.params) };
}
