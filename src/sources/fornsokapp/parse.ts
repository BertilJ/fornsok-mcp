/**
 * Tolkning av Fornsök-appens läs-API (odokumenterat, SPEC 4). Fältnamnen är
 * verifierade mot de inspelade svaren i test/fixtures.
 */
import { KALLA, publicUrl } from "../../config";
import type { Geometry } from "../../geo/geometry";
import { round, toLatLon } from "../../geo/sweref";
import type { Domaner, Egenskap, LamningPost, RecordFetchResult, Referenser } from "../types";

type Obj = Record<string, unknown>;

function s(x: unknown): string | null {
	return typeof x === "string" && x.trim().length > 0 ? x : null;
}
function n(x: unknown): number | null {
	return typeof x === "number" && Number.isFinite(x) ? x : null;
}
function arr(x: unknown): Obj[] {
	return Array.isArray(x) ? (x as Obj[]) : [];
}

function egenskaper(x: unknown): Egenskap[] {
	const out: Egenskap[] = [];
	for (const e of arr(x)) {
		const typ = s(e.egenskapstyp_namn) ?? "";
		for (const v of arr(e.egenskapsvarden)) {
			const varde = s(v.egenskapsvarde_namn);
			if (varde) out.push({ typ, varde });
		}
	}
	return out;
}

/** Slå ihop appens geometrier (en FeatureCollection i EPSG:3006) till en geometri. */
export function appGeometry(fc: unknown): Geometry | null {
	const features = arr((fc as Obj | null)?.features);
	const geoms = features.map((f) => f.geometry as Geometry | null).filter((g): g is Geometry => !!g && typeof g === "object");
	if (geoms.length === 0) return null;
	if (geoms.length === 1) return geoms[0];
	return { type: "GeometryCollection", geometries: geoms };
}

function geometryLabel(fc: unknown): string | null {
	const types = [...new Set(arr((fc as Obj | null)?.features).map((f) => (f.geometry as Obj | null)?.type).filter(Boolean))];
	if (types.length === 0) return null;
	const count = arr((fc as Obj | null)?.features).length;
	return types.length === 1 ? (count > 1 ? `Multi${types[0]}` : String(types[0])) : types.join("+");
}

export function parseAppLamning(d: Obj, domaner?: Domaner | null): RecordFetchResult | null {
	const uuid = s(d.lamning_id);
	if (!uuid) return null;
	const lage = (d.nuvarande_lage ?? null) as Obj | null;
	const indel = (lage?.geografisk_indelning ?? {}) as Obj;
	const centrum = (lage?.centrum ?? null) as Obj | null;
	const e = n(centrum?.ost);
	const nn = n(centrum?.nord);
	const ll = e !== null && nn !== null ? toLatLon({ e, n: nn }) : null;
	const legacy = (d.legacy ?? {}) as Obj;
	const typ = s(d.lamningstyp_namn);
	const kategori = typ && domaner ? (domaner.lamningstyper.find((t) => t.namn === typ)?.kategorier ?? []) : undefined;

	const referenser: Referenser = {
		skriftliga_kallor: arr(d.skriftlig_kalla_referenser).map((r) => s(r.referens)).filter((x): x is string => !!x),
		kartmaterial: arr(d.kartmaterial_referenser).map(formatRef).filter((x): x is string => !!x),
		uppgiftslamnare: arr(d.uppgiftslamnare_referenser).map(formatRef).filter((x): x is string => !!x),
	};

	const lan = [...new Set(arr(indel.kommun).map((k) => s(k.lan_namn)).filter((x): x is string => !!x))];
	const post: LamningPost = {
		lamningsnummer: s(d.lamningsnummer),
		raa_nummer: s(legacy.raa_nummer),
		uuid: uuid.toLowerCase(),
		lamningstyp: typ,
		...(kategori ? { kategori } : {}),
		antikvarisk_bedomning: {
			varde: s(d.antikvariskbedomningtyp_namn),
			motivering: s(d.antikvariskbedomning_motivering),
		},
		antikvarisk_kommentar: s(d.antikvarisk_kommentar),
		beskrivning: s(d.beskrivning),
		tradition: s(d.tradition),
		terrang: s(d.terrang),
		orientering: s(d.orientering),
		vegetation: s(d.vegetation),
		namn: Array.isArray(d.alternativnamn) ? (d.alternativnamn as unknown[]).filter((x): x is string => typeof x === "string") : [],
		egenskaper: egenskaper(d.egenskaper),
		ingaende_lamningar: arr(d.ingaendelamningar).map((i) => ({
			lamningstyp: s(i.lamningstyp_namn) ?? "",
			antal: n(i.antal),
			egenskaper: egenskaper(i.egenskaper),
		})),
		statusar: {
			aktualitet: s((d.aktualitetstatus as Obj | null)?.aktualitetstatustyp_namn),
			undersokning: s((d.undersokningsstatus as Obj | null)?.undersokningsstatustyp_namn),
			skada: s((d.skadestatus as Obj | null)?.skadestatustyp_namn),
			placering: s(d.placeringtyp_namn),
		},
		lage: {
			lat: ll ? round(ll.lat, 7) : null,
			lon: ll ? round(ll.lon, 7) : null,
			sweref99tm: e !== null && nn !== null ? { e: round(e, 1), n: round(nn, 1) } : null,
			// Lägesosäkerhet: inmatningsosäkerheten, annars mätmetodens felmarginal.
			osakerhet_m: n(lage?.inmatningsosakerhet_meter) ?? n(lage?.felmarginal_meter),
			geometrityp: geometryLabel(lage?.geometri),
			hojd_over_havet_m:
				n(lage?.min_meter_over_havet) !== null || n(lage?.max_meter_over_havet) !== null
					? { min: n(lage?.min_meter_over_havet), max: n(lage?.max_meter_over_havet) }
					: null,
		},
		indelning: {
			lan,
			kommun: arr(indel.kommun).map((k) => s(k.kommun_namn)).filter((x): x is string => !!x),
			socken: arr(indel.socken).map((k) => s(k.socken_namn)).filter((x): x is string => !!x),
			landskap: arr(indel.landskap).map((k) => s(k.landskap_namn)).filter((x): x is string => !!x),
		},
		url: publicUrl(uuid.toLowerCase()),
		kalla: KALLA,
		hamtad_fran: `Fornsök-appen (levande)${s(d.senast_andrad) ? `, senast ändrad ${String(d.senast_andrad).slice(0, 10)}` : ""}`,
	};
	return { post, geometriSweref: appGeometry(lage?.geometri), referenser };
}

/** Kart- och uppgiftslämnarreferenser har okänd form i de inspelade posterna; ta det som går. */
function formatRef(r: Obj): string | null {
	if (typeof r === "string") return r;
	const direct = s(r.referens) ?? s(r.beskrivning) ?? s(r.namn);
	if (direct) return direct;
	const parts = Object.entries(r)
		.filter(([k, v]) => !/_id$/.test(k) && (typeof v === "string" || typeof v === "number"))
		.map(([k, v]) => `${k}: ${v}`);
	return parts.length ? parts.join(", ") : null;
}

// ---------------------------------------------------------------- domäner

export function parseDomaner(lamning: Obj, uppdrag: Obj): Domaner {
	const lamningstyper = arr(lamning.lamningstyp).map((t) => ({
		id: n(t.lamningstyp_id) ?? 0,
		namn: s(t.namn) ?? "",
		aktiv: t.aktiv !== false,
		kategorier: arr(t.kategorier).map((k) => s(k.namn)).filter((x): x is string => !!x),
	}));
	return {
		lamningstyper: lamningstyper.filter((t) => t.namn),
		kategorier: arr(lamning.kategorityp).map((k) => s(k.namn)).filter((x): x is string => !!x),
		bedomningar: arr(lamning.antikvarisk_bedomning_typ).map((b) => ({ namn: s(b.namn) ?? "", beskrivning: s(b.beskrivning) })),
		kommuner: arr(uppdrag.kommun).map((k) => ({
			kod: s(k.kommun_kod) ?? "",
			namn: s(k.kommun_namn) ?? "",
			lan_kod: s(k.lan_kod) ?? "",
			lan_namn: s(k.lan_namn) ?? "",
		})),
		socknar: arr(uppdrag.socken).map((k) => ({
			id: s(k.socken_id) ?? "",
			namn: s(k.socken_namn) ?? "",
			kommunkoder: Array.isArray(k.kommunkoder) ? (k.kommunkoder as unknown[]).filter((x): x is string => typeof x === "string") : [],
		})),
		landskap: arr(uppdrag.landskap).map((k) => ({ kod: s(k.landskap_kod) ?? "", namn: s(k.landskap_namn) ?? "" })),
		lan: arr(uppdrag.lan).map((k) => ({ kod: s(k.lan_kod) ?? "", namn: s(k.lan_namn) ?? "" })),
		hamtad: new Date().toISOString(),
	};
}
