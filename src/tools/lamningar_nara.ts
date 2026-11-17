import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { publicUrl } from "../config";
import { ToolInputError } from "../errors";
import { bboxAround, compassDirection, type Geometry, nearestPoint, wgsToSweref } from "../geo/geometry";
import { isInSweden, type Planar, round, toLatLon, toPlanar } from "../geo/sweref";
import { BEDOMNINGAR, type NearbyFeature, type NearbyPage } from "../sources/types";
import { reservHamtadFran } from "../store/access";
import { READ_ONLY, type ToolDeps, ok, runTool } from "./common";
import { type OpenIndex, viaIndex } from "./via_index";

/** Högst så många geometrier hämtas per anrop till OGC API. */
export const NEARBY_FETCH_LIMIT = 1000;
const MAX_SHRINK_STEPS = 3;
const MAX_BBOX_SIDE_M = 20_000;

export const naraInput = z.object({
	lat: z.number().min(-90).max(90).optional().describe("Latitud i WGS 84 (decimalgrader)."),
	lon: z.number().min(-180).max(180).optional().describe("Longitud i WGS 84 (decimalgrader)."),
	radie_m: z.number().positive().max(10_000).default(500).describe("Sökradie i meter (högst 10 000)."),
	bbox: z
		.tuple([z.number(), z.number(), z.number(), z.number()])
		.optional()
		.describe("I stället för lat/lon: ruta [minLon, minLat, maxLon, maxLat] i WGS 84. Avstånd räknas från rutans mitt."),
	lamningstyp: z.array(z.string().min(1).max(100)).min(1).max(20).optional().describe("Lämningstyper, t.ex. \"Hyttområde\"."),
	antikvarisk_bedomning: z.array(z.enum(BEDOMNINGAR)).min(1).max(5).optional().describe("Antikvarisk bedömning."),
	antal: z.number().int().min(1).max(100).default(25).describe("Högst så många lämningar (högst 100)."),
});

export const naraOutput = z.object({
	mittpunkt: z.object({ lat: z.number(), lon: z.number() }),
	radie_m: z.number().nullable(),
	bbox: z.array(z.number()).nullable(),
	sokt_radie_m: z.number().nullable(),
	fullstandig: z.boolean(),
	totalt: z.number().int(),
	geometrier_i_omradet: z.number().int().nullable(),
	kalla: z.string(),
	/** Varifrån svaret kom och hur färskt det är (SPEC 7). */
	hamtad_fran: z.string(),
	/** true när indexet inte kunde användas och svaret kommer från OGC API (SPEC 8). */
	reservlage: z.boolean(),
	lamningar: z.array(
		z.object({
			lamningsnummer: z.string(),
			raa_nummer: z.string().nullable(),
			uuid: z.string().nullable(),
			lamningstyp: z.string().nullable(),
			antikvarisk_bedomning: z.string().nullable(),
			namn: z.string().nullable(),
			kommun: z.string().nullable(),
			lan: z.string().nullable(),
			avstand_m: z.number(),
			vaderstreck: z.string().nullable(),
			inom_lamningen: z.boolean(),
			geometrier: z.number().int(),
			geometrityper: z.array(z.string()),
			osakerhet_m: z.number().nullable().optional(),
			narmaste_punkt: z.object({ lat: z.number(), lon: z.number() }),
			narmaste_punkt_sweref99tm: z.object({ e: z.number(), n: z.number() }),
			url: z.string().nullable(),
		}),
	),
	anmarkningar: z.array(z.string()),
});

type NaraArgs = z.infer<typeof naraInput>;

export interface NearbyLamning {
	feature: NearbyFeature;
	distance: number;
	point: Planar;
	geometrier: number;
	geometrityper: string[];
	/** Geometritypen för den geometri som ligger närmast. */
	narmasteTyp: string;
}

/**
 * Deduplicera på lämningsnummer (samlingen har ett objekt per geometri) och
 * räkna avstånd från `center` till närmaste punkt på någon av lämningens
 * geometrier, i SWEREF 99 TM. Sorterat närmast först.
 */
export function dedupeAndMeasure(center: Planar, features: readonly NearbyFeature[]): NearbyLamning[] {
	const byNr = new Map<string, NearbyLamning>();
	for (const f of features) {
		const planar: Geometry = wgsToSweref(f.geometry);
		const near = nearestPoint(center, planar);
		const prev = byNr.get(f.lamningsnummer);
		if (!prev) {
			byNr.set(f.lamningsnummer, {
				feature: f,
				distance: near.distance,
				point: near.point,
				geometrier: 1,
				geometrityper: [f.geometry.type],
				narmasteTyp: f.geometry.type,
			});
		} else {
			prev.geometrier++;
			if (!prev.geometrityper.includes(f.geometry.type)) prev.geometrityper.push(f.geometry.type);
			if (near.distance < prev.distance) {
				prev.distance = near.distance;
				prev.point = near.point;
				prev.narmasteTyp = f.geometry.type;
			}
		}
	}
	return [...byNr.values()].sort(
		(a, b) => a.distance - b.distance || a.feature.lamningsnummer.localeCompare(b.feature.lamningsnummer),
	);
}

export function registerLamningarNara(server: McpServer, deps: ToolDeps): void {
	server.registerTool(
		"lamningar_nara",
		{
			title: "Lämningar nära en plats",
			description:
				"Lämningar närmast en punkt (lat/lon i WGS 84) inom en radie, eller inom en ruta. Räknas mot serverns eget index; om det inte är tillgängligt mot RAÄ:s OGC API Features (svaret märks som reservläge). " +
				"Avståndet räknas i SWEREF 99 TM till närmaste punkt på lämningens geometri (punkt, linje eller yta; 0 m = punkten ligger inom ytan). " +
				"Sorterat närmast först, med väderstreck från punkten. Filter på lämningstyp och antikvarisk bedömning. " +
				"En koordinat från t.ex. ortnamnsuppslag (TORA i Riksarkivets koppling) kan skickas direkt hit.",
			inputSchema: naraInput,
			outputSchema: naraOutput,
			annotations: { ...READ_ONLY, title: "Lämningar nära en plats" },
		},
		async (args) => runTool(() => lamningarNara(args, deps)),
	);
}

export async function lamningarNara(args: NaraArgs, deps: ToolDeps) {
	const hasPoint = args.lat !== undefined || args.lon !== undefined;
	if (hasPoint && args.bbox) throw new ToolInputError("Ange antingen lat/lon (med radie_m) eller bbox, inte båda.");
	if (!hasPoint && !args.bbox) throw new ToolInputError("Ange lat och lon (WGS 84), eller bbox [minLon, minLat, maxLon, maxLat].");
	if (hasPoint && (args.lat === undefined || args.lon === undefined)) throw new ToolInputError("Ange både lat och lon.");

	let center: { lat: number; lon: number };
	let bbox: [number, number, number, number] | null = null;
	if (args.bbox) {
		const [minLon, minLat, maxLon, maxLat] = args.bbox;
		if (!(minLon < maxLon && minLat < maxLat)) throw new ToolInputError("bbox ska vara [minLon, minLat, maxLon, maxLat] med min < max.");
		if (!isInSweden({ lat: minLat, lon: minLon }) || !isInSweden({ lat: maxLat, lon: maxLon })) {
			throw new ToolInputError("Rutan ligger (delvis) utanför Sverige. Ange koordinater i WGS 84.");
		}
		const sw = toPlanar({ lat: minLat, lon: minLon });
		const ne = toPlanar({ lat: maxLat, lon: maxLon });
		if (ne.e - sw.e > MAX_BBOX_SIDE_M || ne.n - sw.n > MAX_BBOX_SIDE_M) {
			throw new ToolInputError(`Rutan är för stor; högst ${MAX_BBOX_SIDE_M / 1000} km i varje led.`);
		}
		bbox = [minLon, minLat, maxLon, maxLat];
		center = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
	} else {
		center = { lat: args.lat as number, lon: args.lon as number };
		if (!isInSweden(center)) {
			throw new ToolInputError(
				`Punkten (${center.lat}, ${center.lon}) ligger utanför Sverige. Ange lat/lon i WGS 84 – kontrollera att de inte är omkastade.`,
			);
		}
	}

	const lamningstyp = args.lamningstyp?.length ? await deps.domains.resolveLamningstyper(args.lamningstyp) : undefined;
	const q: NaraQuery = { args, center, bbox, lamningstyp };
	return viaIndex(
		deps,
		(ix) => naraIndex(q, ix),
		(orsak) => naraReserv(q, deps, orsak),
	);
}

interface NaraQuery {
	args: NaraArgs;
	center: { lat: number; lon: number };
	bbox: [number, number, number, number] | null;
	lamningstyp: string[] | undefined;
}

type NaraItem = z.infer<typeof naraOutput>["lamningar"][number];

/** Exakt avstånd mot indexets geometrier (SPEC 6): ett anrop, inget tak på geometrier per svar. */
async function naraIndex(q: NaraQuery, ix: OpenIndex) {
	const { args, center, bbox, lamningstyp } = q;
	const centerPlanar = toPlanar(center);
	const page = await ix.store.nearby({
		...(bbox ? { bbox } : { lat: center.lat, lon: center.lon, radie_m: args.radie_m }),
		lamningstyp,
		antikvarisk_bedomning: args.antikvarisk_bedomning,
		antal: args.antal,
	});
	const anmarkningar: string[] = [];
	if (page.totalt_ungefar) {
		anmarkningar.push(
			`Mycket tätt område: fler kandidater än som kunde prövas. De närmaste lämningarna är med, och svaret är fullständigt inom ${page.fullstandig_inom_m ?? "?"} m; totalt avser bara den radien. Minska radien eller rutan för ett fullständigt svar.`,
		);
	}
	const items: NaraItem[] = page.traffar.map((h) => {
		const ll = toLatLon(h.narmaste_punkt_sweref);
		return {
			lamningsnummer: h.lamningsnummer ?? h.uuid,
			raa_nummer: h.raa_nummer,
			uuid: h.uuid,
			lamningstyp: h.lamningstyp,
			antikvarisk_bedomning: h.antikvarisk_bedomning,
			namn: h.lamningsnamn,
			kommun: h.kommun.length ? h.kommun.join(", ") : null,
			lan: h.lan.length ? h.lan.join(", ") : null,
			avstand_m: h.avstand_m,
			vaderstreck: h.avstand_m < 0.5 ? null : compassDirection(centerPlanar, h.narmaste_punkt_sweref),
			inom_lamningen: h.avstand_m < 0.5 && isAreal(h.narmaste_typ),
			geometrier: h.geometrier,
			geometrityper: h.geometrityper,
			osakerhet_m: h.osakerhet_m,
			narmaste_punkt: { lat: round(ll.lat, 7), lon: round(ll.lon, 7) },
			narmaste_punkt_sweref99tm: { e: round(h.narmaste_punkt_sweref.e, 1), n: round(h.narmaste_punkt_sweref.n, 1) },
			url: h.url,
		};
	});
	return respondNara(q, {
		sokt_radie_m: bbox ? null : page.fullstandig_inom_m !== undefined ? Math.min(args.radie_m, page.fullstandig_inom_m) : args.radie_m,
		fullstandig: !page.totalt_ungefar,
		totalt: page.totalt,
		geometrier_i_omradet: null,
		kalla: "Lämningsindex (D1)",
		hamtad_fran: ix.hamtad_fran,
		reservlage: false,
		items,
		anmarkningar,
	});
}

/** Reserv: OGC API Features (samma beräkning som före indexet). */
async function naraReserv(qn: NaraQuery, deps: ToolDeps, orsak: string) {
	const { args, center, bbox, lamningstyp } = qn;
	const anmarkningar: string[] = [];
	const centerPlanar = toPlanar(center);

	let radius = bbox ? null : args.radie_m;
	let page: NearbyPage | null = null;
	let firstMatched: number | null = null;
	let complete = false;
	for (let step = 0; step <= MAX_SHRINK_STEPS; step++) {
		const q = {
			bbox: bbox ?? bboxAround(center, radius as number),
			lamningstyp,
			antikvarisk_bedomning: args.antikvarisk_bedomning,
			limit: NEARBY_FETCH_LIMIT,
		};
		page = await deps.nearby.featuresInBbox(q);
		if (firstMatched === null) firstMatched = page.numberMatched;
		const returned = page.numberReturned ?? page.features.length;
		complete = page.numberMatched !== null ? returned >= page.numberMatched : returned < NEARBY_FETCH_LIMIT;
		if (complete || bbox || step === MAX_SHRINK_STEPS) break;
		// Tätt område: krymp radien så att alla geometrier inom den ryms i ett svar.
		const ratio = page.numberMatched ? returned / page.numberMatched : 0.5;
		radius = Math.max(50, Math.floor((radius as number) * Math.sqrt(ratio) * 0.8));
	}
	if (!page) throw new Error("ingen sida");

	let lamningar = dedupeAndMeasure(centerPlanar, page.features);
	if (radius !== null) lamningar = lamningar.filter((l) => l.distance <= (radius as number));
	const totalt = lamningar.length;
	const shown = lamningar.slice(0, args.antal);

	if (radius !== null && radius < args.radie_m) {
		anmarkningar.push(
			`Tätt område: sökningen begränsades till ${radius} m för att alla geometrier skulle rymmas (${firstMatched ?? "okänt antal"} geometrier inom ${args.radie_m} m). Alla lämningar inom ${radius} m är med.`,
		);
	}
	if (!complete) {
		anmarkningar.push("Området innehåller fler geometrier än som kunde hämtas; närmare lämningar kan saknas. Minska radien eller rutan.");
	}

	anmarkningar.push(`Reservläge: ${orsak}. Avstånden räknades mot RAÄ:s OGC API Features.`);
	const items: NaraItem[] = shown.map((l) => {
		const f = l.feature;
		const ll = toLatLon(l.point);
		// "Inom" har bara mening för ytor; en punkt eller linje man står på är 0 m bort, inte "inom".
		const inside = l.distance < 0.5 && isAreal(l.narmasteTyp);
		return {
			lamningsnummer: f.lamningsnummer,
			raa_nummer: f.raa_nummer,
			uuid: f.uuid,
			lamningstyp: f.lamningstyp,
			antikvarisk_bedomning: f.antikvarisk_bedomning,
			namn: f.lamningsnamn,
			kommun: f.kommun,
			lan: f.lan,
			avstand_m: Math.round(l.distance),
			vaderstreck: l.distance < 0.5 ? null : compassDirection(centerPlanar, l.point),
			inom_lamningen: inside,
			geometrier: l.geometrier,
			geometrityper: l.geometrityper,
			narmaste_punkt: { lat: round(ll.lat, 7), lon: round(ll.lon, 7) },
			narmaste_punkt_sweref99tm: { e: round(l.point.e, 1), n: round(l.point.n, 1) },
			url: f.uuid ? publicUrl(f.uuid) : f.url,
		};
	});

	return respondNara(qn, {
		sokt_radie_m: radius,
		fullstandig: complete,
		totalt,
		geometrier_i_omradet: firstMatched,
		kalla: "RAÄ:s OGC API Features (levande källa)",
		hamtad_fran: reservHamtadFran("RAÄ:s OGC API Features", orsak),
		reservlage: true,
		items,
		anmarkningar,
	});
}

interface NaraSvar {
	sokt_radie_m: number | null;
	fullstandig: boolean;
	totalt: number;
	geometrier_i_omradet: number | null;
	kalla: string;
	hamtad_fran: string;
	reservlage: boolean;
	items: NaraItem[];
	anmarkningar: string[];
}

function respondNara(q: NaraQuery, s: NaraSvar) {
	const { args, center, bbox, lamningstyp } = q;
	const { items, anmarkningar, totalt } = s;
	const structured = {
		mittpunkt: { lat: round(center.lat, 7), lon: round(center.lon, 7) },
		radie_m: bbox ? null : args.radie_m,
		bbox,
		sokt_radie_m: s.sokt_radie_m,
		fullstandig: s.fullstandig,
		totalt,
		geometrier_i_omradet: s.geometrier_i_omradet,
		kalla: s.kalla,
		hamtad_fran: s.hamtad_fran,
		reservlage: s.reservlage,
		lamningar: items,
		anmarkningar,
	};

	const lines: string[] = [];
	const omrade = bbox ? "i rutan" : `inom ${s.sokt_radie_m} m`;
	if (totalt === 0) {
		lines.push(`Inga lämningar ${omrade} från ${center.lat.toFixed(5)}, ${center.lon.toFixed(5)}${filterText(args, lamningstyp)}.`);
		lines.push("Pröva större radie eller färre filter.");
		lines.push(`Källa: ${s.kalla}; ${s.hamtad_fran}.`);
	} else {
		lines.push(
			`${totalt} lämningar ${omrade} från ${center.lat.toFixed(5)}, ${center.lon.toFixed(5)}${filterText(args, lamningstyp)}; visar ${items.length}, närmast först. Källa: ${s.kalla}; ${s.hamtad_fran}.`,
		);
		items.forEach((it, i) => {
			const lage = it.inom_lamningen
				? "punkten ligger inom lämningen"
				: it.vaderstreck === null
					? "0 m (punkten ligger på lämningen)"
					: `${it.avstand_m} m ${it.vaderstreck}`;
			const nr = [it.lamningsnummer, it.raa_nummer ? `(${it.raa_nummer})` : null].filter(Boolean).join(" ");
			const namn = it.namn ? ` "${it.namn}"` : "";
			const osak = it.osakerhet_m ? `, lägesosäkerhet ${it.osakerhet_m} m` : "";
			lines.push(
				`${i + 1}. ${nr}${namn} – ${it.lamningstyp ?? "okänd typ"}, ${it.antikvarisk_bedomning ?? "bedömning saknas"}. ${lage}${osak}. ${it.url ?? ""}`.trim(),
			);
		});
	}
	for (const a of anmarkningar) lines.push(`Obs: ${a}`);
	return ok(lines.join("\n"), structured);
}

function filterText(args: NaraArgs, typer?: string[]): string {
	const parts: string[] = [];
	if (typer?.length) parts.push(`typ ${typer.join("/")}`);
	if (args.antikvarisk_bedomning?.length) parts.push(args.antikvarisk_bedomning.join("/"));
	return parts.length ? ` (${parts.join(", ")})` : "";
}

function isAreal(type: string): boolean {
	return type === "Polygon" || type === "MultiPolygon";
}
