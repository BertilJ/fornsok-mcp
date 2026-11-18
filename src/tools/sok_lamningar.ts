import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { strikt } from "./schema";
import { publicUrl } from "../config";
import { ToolInputError } from "../errors";
import { round, toPlanar } from "../geo/sweref";
import { reciprocalRankFusion } from "../search/fusion";
import { tillVectorizeFilter } from "../semantic/filter";
import type { ResolvedSearchFilter, SearchHit, SemanticHit } from "../sources/types";
import { reservHamtadFran } from "../store/access";
import { type IndexHit, MAX_RANKAD } from "../store/index";
import { MAX_TERMS, tokenize } from "../store/fts";
import { BOILERPLATE_RE, READ_ONLY, type ToolDeps, citat, fmtCoord, list, ok, runTool, EXTERN_TEXT } from "./common";
import { type ResolvedFilter, describeFilter, filterShape, hasCriteria, resolveEgenskaper, resolveFilter, toKsamsokFilter } from "./filter";
import { makeUtdrag } from "./utdrag";
import { type OpenIndex, viaIndex } from "./via_index";

export { splitFraga } from "./filter";

/** Högsta sidnummer. */
export const MAX_SIDA = 200;
/** Så många träffar begärs från den semantiska kanalen (Vectorize: högst 100 per fråga). */
export const SEMANTIC_TOP_K = 100;
/** Ordsökens rangordning hämtas minst så djupt vid sammanslagning. */
export const HYBRID_MIN_DEPTH = 100;
/** Sammanslagen rangordning räcker till hit; sidor bortom den ges av ordsök ensam. */
export const HYBRID_MAX_DEPTH = 1000;

export const sokInput = strikt("sok_lamningar", {
	fraga: filterShape.fraga,
	lage: z
		.enum(["auto", "ord", "betydelse"])
		.default("auto")
		.describe(
			'Sökläge. "ord": bara ordsök. "betydelse": bara semantisk sökning på frågans innebörd; gäller bara inom det semantiska omfånget (Dalarnas län som standard) och kräver ett geografiskt filter där (lan, kommun, socken, landskap eller nara). "auto": ordsök, plus semantisk sökning när frågans geografiska filter ligger inom omfånget; rangordningarna slås ihop.',
		),
	nummer: filterShape.nummer,
	lamningstyp: filterShape.lamningstyp,
	kategori: filterShape.kategori,
	antikvarisk_bedomning: filterShape.antikvarisk_bedomning,
	kommun: filterShape.kommun,
	socken: filterShape.socken,
	landskap: filterShape.landskap,
	lan: filterShape.lan,
	egenskap: filterShape.egenskap,
	nara: filterShape.nara,
	antal: z.number().int().min(1).max(50).default(15).describe("Träffar per sida (högst 50)."),
	sida: z.number().int().min(1).max(MAX_SIDA).default(1).describe("Sidnummer, från 1."),
});

const koordinat = z.object({ lat: z.number(), lon: z.number() });
const kanal = z.enum(["ord", "betydelse"]);

export const sokOutput = z.object({
	totalt: z.number().int(),
	totalt_ungefar: z.boolean().optional(),
	/** Så många träffar går att bläddra till; fler än så kräver snävare villkor. */
	nabara: z.number().int(),
	sida: z.number().int(),
	antal: z.number().int(),
	sokkanaler: z.array(kanal),
	/** När den semantiska kanalen användes: hur stor del av omfånget som är inbäddat. */
	semantisk_tackning: z.object({ inbaddade: z.number().int(), i_omfang: z.number().int(), fullstandig: z.boolean() }).optional(),
	/** Ord som söktes (efter uppdelning; `*` = prefix). */
	sokord: z.array(z.string()).optional(),
	kalla: z.string(),
	/** Varifrån svaret kom och hur färskt det är (SPEC 7). */
	hamtad_fran: z.string(),
	/** true när indexet inte kunde användas och svaret kommer från K-samsök (SPEC 8). */
	reservlage: z.boolean(),
	data_byggd: z.string().nullable(),
	filter: z.record(z.string(), z.unknown()),
	traffar: z.array(
		z.object({
			lamningsnummer: z.string().nullable(),
			raa_nummer: z.string().nullable(),
			uuid: z.string(),
			lamningstyp: z.string().nullable(),
			antikvarisk_bedomning: z.string().nullable(),
			namn: z.string().nullable().optional(),
			kommun: z.array(z.string()),
			socken: z.array(z.string()),
			lan: z.array(z.string()),
			landskap: z.array(z.string()),
			koordinat: koordinat.nullable(),
			sweref99tm: z.object({ e: z.number(), n: z.number() }).nullable(),
			osakerhet_m: z.number().nullable().optional(),
			geometrityp: z.string().nullable().optional(),
			/** Cirka 200 tecken ur registrets text; i indexet med sökträffarna inom «». */
			utdrag: z.string().optional(),
			avstand_m: z.number().optional(),
			vaderstreck: z.string().nullable().optional(),
			/** Vilka sökkanaler som hittade lämningen (vid sammanslagen sökning). */
			kanaler: z.array(kanal).optional(),
			url: z.string(),
		}),
	),
	anmarkningar: z.array(z.string()),
	forslag: z.array(z.string()).optional(),
});

type SokArgs = z.infer<typeof sokInput>;
type Traff = z.infer<typeof sokOutput>["traffar"][number];
type Kanal = z.infer<typeof kanal>;

export function registerSokLamningar(server: McpServer, deps: ToolDeps): void {
	server.registerTool(
		"sok_lamningar",
		{
			title: "Sök lämningar",
			description:
				"Sök i Kulturmiljöregistret (fornlämningar och andra kulturhistoriska lämningar). " +
				"Kombinera fritext med filter på nummer, lämningstyp, kategori, antikvarisk bedömning, kommun, socken, landskap, län, egenskap och område (nara, med avstånd till geometrin). " +
				"Alla ord i `fraga` måste finnas (OCH); ingen stamning, men `*` sist i ett ord ger prefixsökning. Ger nummer, typ, bedömning, indelning, koordinat, utdrag runt träffen och länk. " +
				"Söker i serverns eget index (uppdateras nattligen); inom det semantiska omfånget (Dalarnas län) också på frågans innebörd (se lage). Om indexet inte är tillgängligt går sökningen mot K-samsök och svaret märks som reservläge. " +
				"För närmaste lämningar runt en punkt, använd lamningar_nara; för antal per grupp, statistik; för hela posten, lamning." + EXTERN_TEXT,
			inputSchema: sokInput,
			outputSchema: sokOutput,
			annotations: { ...READ_ONLY, title: "Sök lämningar" },
		},
		async (args) => runTool(() => sokLamningar(args, deps)),
	);
}

export async function sokLamningar(args: SokArgs, deps: ToolDeps) {
	// Utan index: reservvägen förklarar att indexet saknas (semantiken kräver det).
	if (args.lage === "betydelse" && !deps.semantic && deps.index) {
		throw new ToolInputError(
			'Semantisk sökning (lage: "betydelse") är inte tillgänglig i den här driftsättningen (bindningarna för Workers AI och Vectorize saknas). Använd lage "ord" och pröva flera ordformer, synonymer och prefix med *.',
		);
	}
	const r = await resolveFilter(args, deps);
	if (!hasCriteria(r.filter)) {
		throw new ToolInputError(
			"Ange minst ett sökvillkor: fraga, nummer, lamningstyp, kategori, antikvarisk_bedomning, kommun, socken, landskap, lan, egenskap eller nara.",
		);
	}
	return viaIndex(
		deps,
		(ix) => sokIndex(args, r, ix, deps),
		(orsak) => sokReserv(args, r, deps, orsak),
	);
}

// ---------------------------------------------------------------- indexet

interface IndexResult {
	totalt: number;
	/** false: fler träffar än som rangordnas; ordningen är indexets. */
	rangordnad?: boolean;
	nabara?: number;
	totalt_ungefar: boolean;
	traffar: Array<IndexHit & { kanaler?: Kanal[] }>;
	sokkanaler: Kanal[];
	sokord: string[];
}

async function sokIndex(args: SokArgs, r: ResolvedFilter, ix: OpenIndex, deps: ToolDeps) {
	const anmarkningar = [...r.anmarkningar];
	const filter: ResolvedSearchFilter = { ...r.filter };
	const antalOrd = tokenize(r.ord.join(" ")).length;
	if (r.ord.length > MAX_TERMS && antalOrd >= MAX_TERMS)
		anmarkningar.push(`fraga hade ${r.ord.length} ord; bara de ${MAX_TERMS} första användes i ordsökningen. Alla ord måste finnas i posten, så färre ord ger oftast fler träffar.`);
	if (filter.egenskap?.length) filter.egenskap = resolveEgenskaper(filter.egenskap, await deps.index!.egenskaper());
	const store = ix.store;
	const offset = (args.sida - 1) * args.antal;
	const semantic = deps.semantic;
	const text = r.text ? r.text.replace(/\*/g, "").trim() : null;

	let res: IndexResult | null = null;
	if (args.lage === "betydelse") {
		if (!semantic) throw new Error("ingen semantisk kanal"); // kontrollerat ovan
		if (!text) throw new ToolInputError('lage "betydelse" kräver en fråga i fraga.');
		if (!semantic.scopeCovers(filter)) {
			throw new ToolInputError(
				`Semantisk sökning gäller bara ${semantic.omfang ?? "det semantiska omfånget"}. Ange ett geografiskt filter inom det (lan, kommun, socken, landskap eller nara), eller använd lage "ord" eller "auto".`,
			);
		}
		let hits: SemanticHit[];
		const semFilter = await semantisktFilter(filter, deps, store, anmarkningar);
		try {
			hits = await semantic.search(text, semFilter, SEMANTIC_TOP_K);
		} catch (err) {
			console.error("semantisk sökning:", err);
			throw new ToolInputError('Den semantiska sökningen svarade inte. Försök igen om en stund, eller använd lage "ord".');
		}
		const passing = await filterSemantic(store, hits, filter, new Set());
		if (offset + args.antal > SEMANTIC_TOP_K) anmarkningar.push(`Semantisk sökning ger högst ${SEMANTIC_TOP_K} träffar.`);
		anmarkningar.push(
			`Läge "betydelse": totalen är antalet av de ${SEMANTIC_TOP_K} semantiskt närmaste lämningarna som uppfyller filtret, inte alla relevanta. Orden i fraga används som fråga, inte som krav på att orden ska finnas.`,
		);
		const page = passing.slice(offset, offset + args.antal);
		const byUuid = await store.hitsByUuids(page, filter);
		res = {
			totalt: passing.length,
			totalt_ungefar: false,
			traffar: page.flatMap((u) => (byUuid.has(u) ? [{ ...byUuid.get(u)!, kanaler: ["betydelse" as const] }] : [])),
			sokkanaler: ["betydelse"],
			sokord: [],
		};
	} else if (args.lage === "auto" && semantic && text && semantic.scopeCovers(filter)) {
		const need = offset + args.antal;
		if (need > HYBRID_MAX_DEPTH) {
			anmarkningar.push(`Sidor bortom träff ${HYBRID_MAX_DEPTH} rangordnas bara med ordsök.`);
		} else {
			res = await hybrid(store, semantic, text, filter, await semantisktFilter(filter, deps, store, anmarkningar), offset, args.antal, anmarkningar);
		}
	}
	if (!res) {
		const page = await store.searchIndex(filter, { antal: args.antal, sida: args.sida });
		res = {
			totalt: page.totalt,
			rangordnad: page.rangordnad !== false,
			nabara: page.nabara,
			totalt_ungefar: !!page.totalt_ungefar,
			traffar: page.traffar,
			sokkanaler: ["ord"],
			sokord: page.sokord,
		};
	}
	// Den semantiska kanalen användes: säg om omfånget inte är färdiginbäddat.
	let semantisk_tackning: { inbaddade: number; i_omfang: number; fullstandig: boolean } | undefined;
	if (semantic?.lan?.length && res.sokkanaler.includes("betydelse")) {
		try {
			semantisk_tackning = await deps.index!.inbaddning(semantic.lan);
			if (!semantisk_tackning.fullstandig) {
				const pct = semantisk_tackning.i_omfang ? Math.floor((100 * semantisk_tackning.inbaddade) / semantisk_tackning.i_omfang) : 0;
				anmarkningar.push(
					`Den semantiska kanalen är ansluten, men ${semantic.omfang ?? "omfånget"} är ännu bara inbäddat till ${pct} % (${semantisk_tackning.inbaddade} av ${semantisk_tackning.i_omfang} lämningar); semantiska träffar kan saknas tills inbäddningen är klar.`,
				);
			}
		} catch (err) {
			console.warn("semantik: inbäddningsläget gick inte att läsa:", err instanceof Error ? err.message : String(err));
		}
	}
	if (res.totalt_ungefar) anmarkningar.push("Totalen är ungefärlig (många kandidater i området, eller sammanslagen rangordning).");
	if (res.rangordnad === false)
		anmarkningar.push(
			`Frågan ger ${res.totalt} träffar, fler än ${MAX_RANKAD} som går att ${filter.ord?.length ? "rangordna efter relevans" : "sortera på lämningsnummer"} i rimlig tid; träffarna visas i indexets ordning. Lägg till fler ord eller filter (t.ex. kommun, typ) för en rangordnad lista.`,
		);

	const traffar: Traff[] = res.traffar.map((h) => ({
		lamningsnummer: h.lamningsnummer,
		raa_nummer: h.raa_nummer,
		uuid: h.uuid,
		lamningstyp: h.lamningstyp,
		antikvarisk_bedomning: h.antikvarisk_bedomning,
		namn: h.lamningsnamn,
		kommun: h.kommun,
		socken: h.socken,
		lan: h.lan,
		landskap: h.landskap,
		koordinat: h.koordinat ? { lat: round(h.koordinat.lat, 7), lon: round(h.koordinat.lon, 7) } : null,
		sweref99tm: h.sweref99tm,
		osakerhet_m: h.osakerhet_m,
		geometrityp: h.geometrityp,
		...(cleanUtdrag(h.utdrag) ? { utdrag: cleanUtdrag(h.utdrag)! } : {}),
		...(h.avstand_m !== undefined ? { avstand_m: h.avstand_m, vaderstreck: h.vaderstreck ?? null } : {}),
		...(h.kanaler ? { kanaler: h.kanaler } : {}),
		url: h.url,
	}));

	return respond(args, {
		...(semantisk_tackning ? { semantisk_tackning } : {}),
		totalt: res.totalt,
		nabara: res.nabara ?? (res.sokkanaler.includes("betydelse") ? Math.min(res.totalt, res.sokkanaler.length > 1 ? HYBRID_MAX_DEPTH : SEMANTIC_TOP_K) : res.totalt),
		totalt_ungefar: res.totalt_ungefar,
		sokkanaler: res.sokkanaler,
		sokord: res.sokord,
		kalla: "Lämningsindex (D1)",
		hamtad_fran: ix.hamtad_fran,
		reservlage: false,
		data_byggd: ix.status.uttagsdatum,
		// I läge betydelse filtrerar orden inte (de är frågan): visa dem inte som tillämpat villkor.
		filter: args.lage === "betydelse" ? (({ ord: _o, ...rest }) => rest)(filter) : filter,
		kategorier: r.kategorier,
		traffar,
		anmarkningar,
	});
}

/**
 * Ordsök och semantisk sökning parallellt, sammanslagna med reciprocal rank
 * fusion. Faller tillbaka på enbart ordsök om den semantiska kanalen fallerar.
 */
async function hybrid(
	store: OpenIndex["store"],
	semantic: NonNullable<ToolDeps["semantic"]>,
	text: string,
	filter: ResolvedSearchFilter,
	semFilter: ResolvedSearchFilter,
	offset: number,
	antal: number,
	anmarkningar: string[],
): Promise<IndexResult | null> {
	// Fast djup: samma ordlista för alla sidor, så att sammanslagningen ger samma
	// ordning från sida till sida (med djup efter sidan kunde träffar hoppa eller
	// upprepas kring träff 100).
	const depth = HYBRID_MAX_DEPTH;
	const [ord, sem] = await Promise.all([
		store.searchRanked(filter, depth),
		semantic.search(text, semFilter, SEMANTIC_TOP_K).then(
			(h) => h,
			(err: unknown) => {
				console.error("semantisk sökning:", err);
				return null;
			},
		),
	]);
	if (!sem) {
		anmarkningar.push("Den semantiska kanalen svarade inte; bara ordsök användes.");
		return null;
	}
	const ordIds = ord.ids.map((x) => x.uuid);
	const semIds = await filterSemantic(store, sem, filter, new Set(ordIds));
	const fused = reciprocalRankFusion([ordIds, semIds]);
	const semOnly = semIds.filter((u) => !ordIds.includes(u)).length;
	const page = fused.slice(offset, offset + antal);
	const byUuid = await store.hitsByUuids(
		page.map((p) => p.id),
		filter,
	);
	const traffar = page.flatMap((p) => {
		const h = byUuid.get(p.id);
		if (!h) return [];
		const kanaler: Kanal[] = [];
		if (p.ranks[0] !== null) kanaler.push("ord");
		if (p.ranks[1] !== null) kanaler.push("betydelse");
		return [{ ...h, kanaler }];
	});
	return {
		rangordnad: ord.rangordnad !== false,
		totalt: ord.totalt + semOnly,
		totalt_ungefar: !!ord.totalt_ungefar || (semOnly > 0 && ord.totalt > ordIds.length),
		traffar,
		sokkanaler: ["ord", "betydelse"],
		sokord: ord.sokord,
	};
}

/**
 * Filtret för den semantiska kanalen. Vectorize kan bara filtrera på typ,
 * bedömning och område; övrigt prövas i D1 på de högst 100 semantiska
 * träffarna, som då kan bli få eller inga. Därför översätts det som går:
 * - kategori → kategorins lämningstyper (om ingen lämningstyp angavs),
 * - nara → socknarna (eller kommunerna) som har lämningar inom radien.
 * Det som ändå inte kan tillämpas före likhetssökningen sägs i anmärkningarna.
 */
async function semantisktFilter(
	filter: ResolvedSearchFilter,
	deps: ToolDeps,
	store: OpenIndex["store"],
	anmarkningar: string[],
): Promise<ResolvedSearchFilter> {
	const f: ResolvedSearchFilter = { ...filter };
	if (f.kategori?.length && !f.lamningstyp?.length) {
		try {
			const typer = await deps.domains.lamningstyperIKategorier(f.kategori);
			if (typer.length) f.lamningstyp = typer;
		} catch {
			// utan översättning: kategorin prövas i D1
		}
	}
	if (f.nara && !f.socken?.length && !f.kommun?.length) {
		const o = await store.omradenInomRadie(f.nara, 50);
		if (o.socken.length) f.socken = o.socken;
		else if (o.kommun.length) f.kommun = o.kommun;
	}
	const ej = tillVectorizeFilter(f).ejTillampat.filter((x) => x !== "ord");
	const namn: Record<string, string> = { nara: "nara (radien)", bbox: "ruta", kategori: "kategori", egenskap: "egenskap", nummer: "nummer", "socken.kommun": "sockens kommun" };
	const ejText = ej.map((x) => namn[x] ?? x);
	if (ejText.length)
		anmarkningar.push(
			`Den semantiska kanalen kan inte tillämpa ${ejText.join(", ")} före likhetssökningen; de prövas på de ${SEMANTIC_TOP_K} semantiskt närmaste lämningarna${f.socken !== filter.socken || f.kommun !== filter.kommun ? " inom de berörda socknarna/kommunerna" : " i omfånget"}, så få eller inga semantiska träffar kan bli kvar. Ordsök (lage "ord" eller "auto") tillämpar alla filter.`,
		);
	return f;
}

/**
 * Semantiska träffar som uppfyller hela filtret (utom sökorden), i den
 * semantiska kanalens ordning. UUID i `known` har redan prövats.
 */
async function filterSemantic(
	store: OpenIndex["store"],
	hits: readonly SemanticHit[],
	filter: ResolvedSearchFilter,
	known: Set<string>,
): Promise<string[]> {
	const uuids = [...new Set(hits.map((h) => (typeof h?.uuid === "string" ? h.uuid.toLowerCase() : "")).filter(Boolean))];
	const check = uuids.filter((u) => !known.has(u));
	const ok = new Set<string>();
	for (let i = 0; i < check.length; i += 100) {
		const m = await store.hitsByUuids(check.slice(i, i + 100), { ...filter, fraga: undefined, ord: undefined });
		for (const u of m.keys()) ok.add(u);
	}
	return uuids.filter((u) => known.has(u) || ok.has(u));
}

function cleanUtdrag(s: string | null | undefined): string | null {
	if (!s) return null;
	const t = s.replace(BOILERPLATE_RE, "").trim();
	return t || null;
}

// ---------------------------------------------------------------- reserv: K-samsök

async function sokReserv(args: SokArgs, r: ResolvedFilter, deps: ToolDeps, orsak: string) {
	if (args.lage === "betydelse") {
		throw new ToolInputError(
			`Semantisk sökning kräver serverns eget lämningsindex, som inte är tillgängligt just nu (${orsak}). Använd lage "ord" (sökningen går då mot K-samsök).`,
		);
	}
	const { filter, anmarkningar: extra } = await toKsamsokFilter(r, deps, orsak);
	const anmarkningar = [...r.anmarkningar, ...extra];
	anmarkningar.push(`Reservläge: ${orsak}. Sökningen gick mot K-samsök, som ligger några dagar efter registret.`);
	const page = await deps.search.search(filter, { antal: args.antal, sida: args.sida });
	const center = r.filter.nara ? toPlanar(r.filter.nara) : null;
	const ord = filter.ord ?? [];
	const traffar: Traff[] = page.traffar.map((h: SearchHit) => {
		const sw = h.koordinat ? toPlanar(h.koordinat) : null;
		const utdrag = makeUtdrag(h.beskrivning, ord);
		return {
			lamningsnummer: h.lamningsnummer,
			raa_nummer: h.raa_nummer,
			uuid: h.uuid,
			lamningstyp: h.lamningstyp,
			antikvarisk_bedomning: h.antikvarisk_bedomning,
			kommun: h.kommun,
			socken: h.socken,
			lan: h.lan,
			landskap: h.landskap,
			koordinat: h.koordinat ? { lat: round(h.koordinat.lat, 7), lon: round(h.koordinat.lon, 7) } : null,
			sweref99tm: sw ? { e: round(sw.e, 1), n: round(sw.n, 1) } : null,
			...(utdrag ? { utdrag } : {}),
			...(center && sw ? { avstand_m: Math.round(Math.hypot(sw.e - center.e, sw.n - center.n)) } : {}),
			url: publicUrl(h.uuid),
		};
	});
	return respond(args, {
		totalt: page.totalt,
		nabara: page.totalt,
		totalt_ungefar: false,
		sokkanaler: ["ord"],
		kalla: `${page.kalla} (levande källa)`,
		hamtad_fran: reservHamtadFran(page.kalla, orsak, page.byggdatum),
		reservlage: true,
		data_byggd: page.byggdatum ?? null,
		filter: { ...filter, ...(r.kategorier.length ? { kategori: r.kategorier } : {}) },
		kategorier: r.kategorier,
		traffar,
		anmarkningar,
	});
}

// ---------------------------------------------------------------- svar

interface Svar {
	semantisk_tackning?: { inbaddade: number; i_omfang: number; fullstandig: boolean };
	totalt: number;
	nabara: number;
	totalt_ungefar: boolean;
	sokkanaler: Kanal[];
	sokord?: string[];
	kalla: string;
	hamtad_fran: string;
	reservlage: boolean;
	data_byggd: string | null;
	filter: ResolvedSearchFilter;
	kategorier: string[];
	traffar: Traff[];
	anmarkningar: string[];
}

function respond(args: SokArgs, s: Svar) {
	const { filter, traffar, anmarkningar } = s;
	const forslag: string[] = [];
	const ord = filter.ord ?? [];
	if (s.totalt === 0) {
		if (ord.length > 1) forslag.push("Färre ord – alla ord måste finnas i posten.");
		if (ord.length)
			forslag.push(
				`Andra böjningsformer, synonymer eller äldre stavning (t.ex. hytta/hyttan, kolbotten/kolbottnar, hv/v)${s.reservlage ? "" : ", eller prefix med * (hytt*)"}.`,
			);
		if (filter.socken || filter.kommun) forslag.push("Bredare område (län eller landskap i stället för socken/kommun).");
		if (s.kategorier.length) forslag.push("Annan eller ingen kategori.");
		else if (filter.lamningstyp) forslag.push("Utan lämningstyp, eller med närliggande typer (se uppslag).");
		if (filter.antikvarisk_bedomning) forslag.push("Utan filter på antikvarisk bedömning.");
		if (filter.egenskap) forslag.push("Färre eller andra egenskaper (se uppslag lista=egenskapstyper).");
		if (filter.nara || filter.bbox) forslag.push("Större radie, eller lamningar_nara.");
	}
	const sidStart = (args.sida - 1) * args.antal + 1;
	// Sidparametern tillåter högst 200 sidor; indexet högst MAX_OFFSET träffar.
	const nabara = Math.min(s.nabara, MAX_SIDA * args.antal);
	if (s.totalt > nabara) {
		anmarkningar.push(`Bara de första ${nabara} av ${s.totalt} träffarna går att bläddra till (sida ${Math.ceil(nabara / args.antal)} med antal ${args.antal}). Avgränsa sökningen för att nå resten.`);
	}
	if (s.totalt > 0 && traffar.length === 0)
		anmarkningar.push(sidStart > nabara ? `Sidan ${args.sida} ligger bortom de träffar som går att bläddra till.` : `Sidan ${args.sida} ligger efter sista träffen.`);

	const appliedFilter: Record<string, unknown> = { ...filter };
	const structured = {
		totalt: s.totalt,
		...(s.totalt_ungefar ? { totalt_ungefar: true } : {}),
		nabara,
		sida: args.sida,
		antal: args.antal,
		sokkanaler: s.sokkanaler,
		...(s.semantisk_tackning ? { semantisk_tackning: s.semantisk_tackning } : {}),
		...(s.sokord?.length ? { sokord: s.sokord } : {}),
		kalla: s.kalla,
		hamtad_fran: s.hamtad_fran,
		reservlage: s.reservlage,
		data_byggd: s.data_byggd,
		filter: appliedFilter,
		traffar,
		anmarkningar,
		...(forslag.length ? { forslag } : {}),
	};

	const lines: string[] = [];
	const kanaler = s.sokkanaler.map((k) => (k === "ord" ? "ordsök" : "semantisk")).join(" + ");
	if (s.totalt === 0) {
		lines.push("Inga träffar i registret med de här villkoren.");
		lines.push(`Villkor: ${describeFilter(filter)}`);
		if (forslag.length) lines.push(`Pröva: ${forslag.join(" ")}`);
		lines.push(`Källa: ${s.kalla}; ${s.hamtad_fran}.`);
	} else {
		lines.push(
			`${s.totalt_ungefar ? "Cirka " : ""}${s.totalt} träffar${traffar.length ? `, visar ${sidStart}–${sidStart + traffar.length - 1}` : ""} (sida ${args.sida}, ${kanaler}). Källa: ${s.kalla}; ${s.hamtad_fran}.`,
		);
		traffar.forEach((t, i) => {
			const id = [t.lamningsnummer, t.raa_nummer ? `(${t.raa_nummer})` : null].filter(Boolean).join(" ");
			const plats = list([list(t.kommun), list(t.socken)]);
			const dist = t.avstand_m !== undefined ? `, ${t.avstand_m} m bort${t.vaderstreck ? ` åt ${t.vaderstreck}` : ""}` : "";
			const namn = t.namn ? ` ${citat(t.namn)}` : "";
			const via = t.kanaler && s.sokkanaler.length > 1 ? ` [${t.kanaler.join("+")}]` : "";
			lines.push(
				`${sidStart + i}. ${id}${namn} – ${t.lamningstyp ?? "okänd typ"}, ${t.antikvarisk_bedomning ?? "bedömning saknas"}. ${plats}. ${fmtCoord(t.koordinat?.lat, t.koordinat?.lon)}${dist}. ${t.url}${via}`,
			);
			// Utdraget är redan rensat (rad i common.ts / chooseUtdrag i store): «» i registertexten
			// är utbytta mot ‹›, så de enda «» är sökträffarnas markeringar.
			if (t.utdrag) lines.push(t.utdrag.includes("«") ? `   Källtext (registret; sökträffar inom «»): ${t.utdrag}` : `   Källtext (registret): «${t.utdrag}»`);
		});
	}
	for (const a of anmarkningar) lines.push(`Obs: ${a}`);
	return ok(lines.join("\n"), structured);
}
