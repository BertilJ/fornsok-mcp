/**
 * Gemensam filterhantering för sok_lamningar och statistik: scheman, uppslag
 * av namn (kommun, socken, typ, kategori …) och översättning till respektive
 * källa. Indexet tar filtret som det är; K-samsök (reservläget) får `kategori`
 * översatt till lämningstyper och `nara` till en ruta, och klarar inte
 * `egenskap`.
 */
import { z } from "zod";
import { ToolInputError } from "../errors";
import { bboxAround } from "../geo/geometry";
import { isInSweden } from "../geo/sweref";
import { didYouMean, normalizeName, suggest } from "../lookup/names";
import { MAX_ORD, splitWords } from "../sources/ksamsok/query";
import { BEDOMNINGAR, type Egenskap, type ResolvedSearchFilter } from "../sources/types";
import type { EgenskapRad } from "../store/access";
import type { ToolDeps } from "./common";

/** Högst så många lämningstyper i en K-samsök-fråga (adresslängd). Den största kategorin har 32. */
export const MAX_TYPER_I_FRAGA = 60;
/** Största radie för `nara` i sok_lamningar och statistik. */
export const MAX_NARA_RADIE_M = 20_000;

const namnLista = (beskrivning: string) => z.array(z.string().min(1).max(100)).min(1).max(20).optional().describe(beskrivning);

/** Filterparametrarna som sok_lamningar och statistik har gemensamt (SPEC 6). */
export const filterShape = {
	fraga: z
		.string()
		.min(1)
		.max(500)
		.optional()
		.describe(
			"Sökord. Alla ord måste finnas i posten (OCH). Ingen stamning: pröva flera böjningsformer, synonymer och äldre stavningar. `*` sist i ett ord ger prefixsökning (hytt* hittar hytta, hyttan, hyttområde).",
		),
	nummer: z
		.array(z.string().min(1).max(60))
		.min(1)
		.max(20)
		.optional()
		.describe("Lämningsnummer (L2001:646) eller RAÄ-nummer (Bjursås 27:1)."),
	lamningstyp: namnLista('Lämningstyper, t.ex. "Hyttområde". Se uppslag lista=lamningstyper.'),
	kategori: namnLista(
		'Kategorier av lämningstyper, t.ex. "Gravar" eller "Metallframställning och bergsbruk" (se uppslag lista=kategorier). Tillsammans med lamningstyp gäller typer som finns i båda.',
	),
	antikvarisk_bedomning: z.array(z.enum(BEDOMNINGAR)).min(1).max(5).optional().describe("Antikvarisk bedömning."),
	kommun: namnLista('Kommunnamn, t.ex. "Falun".'),
	socken: namnLista('Socknar. Flertydiga namn anges med län, t.ex. "Näs (Jämtland)".'),
	landskap: namnLista('Landskap, t.ex. "Dalarna".'),
	lan: namnLista('Län, t.ex. "Dalarna" eller "Dalarnas län".'),
	egenskap: z
		.array(z.object({ typ: z.string().min(1).max(100), varde: z.string().min(1).max(200) }))
		.min(1)
		.max(20)
		.optional()
		.describe(
			'Egenskaper, t.ex. {typ: "Material", varde: "Koppar"} eller {typ: "Verksamhet", varde: "Bergsbruk"}. Samma typ: något av värdena; olika typer: alla måste gälla. Gäller även ingående lämningar. Se uppslag lista=egenskapstyper. Kräver indexet.',
		),
	nara: z
		.object({
			lat: z.number().min(-90).max(90),
			lon: z.number().min(-180).max(180),
			radie_m: z.number().positive().max(MAX_NARA_RADIE_M).default(1000),
		})
		.optional()
		.describe("Begränsa till ett område runt en punkt (WGS 84). Avståndet räknas till närmaste punkt på lämningens geometri."),
};

export type FilterArgs = {
	fraga?: string;
	nummer?: string[];
	lamningstyp?: string[];
	kategori?: string[];
	antikvarisk_bedomning?: Array<(typeof BEDOMNINGAR)[number]>;
	kommun?: string[];
	socken?: string[];
	landskap?: string[];
	lan?: string[];
	egenskap?: Array<{ typ: string; varde: string }>;
	nara?: { lat: number; lon: number; radie_m: number };
};

export interface ResolvedFilter {
	/** Filtret med upplösta namn, i indexets form (kategori och nara kvar, egenskap ej upplöst). */
	filter: ResolvedSearchFilter;
	/** Alla ord ur fritexten (utan nummer), i ordning. */
	ord: string[];
	/** Fritexten utan de delar som tolkats som nummer, för den semantiska kanalen. */
	text: string | null;
	kategorier: string[];
	anmarkningar: string[];
}

const LAMNINGSNUMMER_RE = /^L\d{4}:\d{1,6}$/i;
/** RAÄ-nummer med kolon, t.ex. "Stugun 114:1", "Stora Kopparberg 172:1". Utan kolon är det för likt vanlig text. */
const RAA_NUMMER_RE = /^[\p{L}][\p{L}\p{M} .'-]{0,60}? \d{1,5}:\d{1,4}$/u;

/**
 * Dela fritexten i ord och nummer. Är hela frågan ett lämnings- eller
 * RAÄ-nummer blir den ett nummer; annars plockas ord som är lämningsnummer ut.
 */
export function splitFraga(fraga: string, isSocken: (prefix: string) => boolean = () => false): { ord: string[]; nummer: string[] } {
	const whole = fraga.normalize("NFC").trim().replace(/\s+/g, " ");
	if (LAMNINGSNUMMER_RE.test(whole)) return { ord: [], nummer: [`L${whole.slice(1)}`] };
	if (RAA_NUMMER_RE.test(whole) && isSocken(whole.replace(/ \d{1,5}:\d{1,4}$/, ""))) return { ord: [], nummer: [whole] };
	const ord: string[] = [];
	const nummer: string[] = [];
	for (const w of splitWords(fraga)) {
		if (LAMNINGSNUMMER_RE.test(w)) nummer.push(`L${w.slice(1)}`);
		else ord.push(w);
	}
	return { ord, nummer };
}

/** Slå upp alla namn i filtret. Okända namn ger verktygsfel med förslag. */
export async function resolveFilter(args: FilterArgs, deps: ToolDeps): Promise<ResolvedFilter> {
	const anmarkningar: string[] = [];

	// Nummer i fritexten söks som nummer: varken K-samsök eller indexets ordsök hittar dem i texten (SPEC 3 #9).
	// Ett RAÄ-nummer börjar med socknens (eller stadens) namn; kontrollera mot värdelistorna.
	let sockenNamn: Set<string> | null = null;
	if (args.fraga && RAA_NUMMER_RE.test(args.fraga.normalize("NFC").trim().replace(/\s+/g, " "))) {
		const d = await deps.domains.get();
		sockenNamn = new Set(d.socknar.map((s) => normalizeName(s.namn)));
	}
	const { ord, nummer: nummerIFraga } = args.fraga
		? splitFraga(args.fraga, (prefix) => sockenNamn?.has(normalizeName(prefix)) ?? false)
		: { ord: [], nummer: [] };
	if (nummerIFraga.length) {
		anmarkningar.push(
			`${nummerIFraga.map((n) => `"${n}"`).join(", ")} i fraga ser ut som lämnings- eller RAÄ-nummer och söktes via nummer (ordsökningen hittar inte nummer i fritext).`,
		);
	}
	if (args.fraga && ord.length === 0 && nummerIFraga.length === 0) throw new ToolInputError("Frågan innehåller inga sökbara ord.");
	if (ord.some((w) => /^\d{1,5}:\d{1,4}$/.test(w))) {
		anmarkningar.push('fraga innehåller något som liknar ett RAÄ-nummer; ange hela numret (t.ex. "Bjursås 27:1") i nummer – ordsökningen söker inte nummer i fritext.');
	}

	const filter: ResolvedSearchFilter = {};
	if (ord.length) filter.ord = ord;
	const nummer = [...(args.nummer ?? []).map((n) => n.trim().replace(/\s+/g, " ")), ...nummerIFraga];
	if (nummer.length) filter.nummer = [...new Set(nummer)];
	if (args.antikvarisk_bedomning?.length) filter.antikvarisk_bedomning = [...new Set(args.antikvarisk_bedomning)];
	if (args.lan?.length) filter.lan = [...new Set(deps.domains.resolveLan(args.lan))];
	if (args.lamningstyp?.length) filter.lamningstyp = [...new Set(await deps.domains.resolveLamningstyper(args.lamningstyp))];
	let kategorier: string[] = [];
	if (args.kategori?.length) {
		kategorier = [...new Set(await deps.domains.resolveKategorier(args.kategori))];
		filter.kategori = kategorier;
		if (filter.lamningstyp) {
			const typer = await deps.domains.lamningstyperIKategorier(kategorier);
			if (!filter.lamningstyp.some((t) => typer.includes(t))) {
				throw new ToolInputError(
					`Ingen av lämningstyperna ${filter.lamningstyp.map((t) => `"${t}"`).join(", ")} hör till kategorin ${kategorier.map((k) => `"${k}"`).join(", ")}. Ta bort ett av filtren, eller se uppslag lista=lamningstyper för typernas kategorier.`,
				);
			}
		}
	}
	const kommuner = args.kommun?.length ? await deps.domains.resolveKommuner(args.kommun) : [];
	if (kommuner.length) filter.kommun = [...new Set(kommuner.map((k) => k.namn))];
	if (args.landskap?.length) filter.landskap = [...new Set(await deps.domains.resolveLandskap(args.landskap))];
	if (args.socken?.length) {
		const socknar = await deps.domains.resolveSocknar(args.socken, {
			kommunkoder: kommuner.map((k) => k.kod),
			lan: filter.lan,
		});
		filter.socken = socknar.map((s) => ({ namn: s.namn, ...(s.lan ? { lan: s.lan } : {}), ...(s.kommun ? { kommun: s.kommun } : {}) }));
		for (const s of socknar) if (s.anmarkning) anmarkningar.push(s.anmarkning);
	}
	if (args.egenskap?.length) filter.egenskap = args.egenskap.map((e) => ({ typ: e.typ, varde: e.varde }));
	if (args.nara) {
		const center = { lat: args.nara.lat, lon: args.nara.lon };
		if (!isInSweden(center)) throw new ToolInputError("Punkten i nara ligger utanför Sverige. Ange lat/lon i WGS 84 (t.ex. lat 60.6, lon 15.6).");
		filter.nara = { ...center, radie_m: args.nara.radie_m };
	}

	const text = args.fraga && ord.length ? ord.join(" ") : null;
	return { filter, ord, text, kategorier, anmarkningar };
}

/** Har filtret något villkor alls? */
export function hasCriteria(f: ResolvedSearchFilter): boolean {
	return !!(
		f.ord?.length ||
		f.nummer?.length ||
		f.lamningstyp?.length ||
		f.kategori?.length ||
		f.antikvarisk_bedomning?.length ||
		f.kommun?.length ||
		f.socken?.length ||
		f.landskap?.length ||
		f.lan?.length ||
		f.egenskap?.length ||
		f.nara ||
		f.bbox
	);
}

/**
 * Egenskaper → indexets exakta typ och värde (skiftlägesokänsligt). Okänd typ
 * eller okänt värde ger verktygsfel med närmaste förslag.
 */
export function resolveEgenskaper(input: readonly Egenskap[], rader: readonly EgenskapRad[]): Egenskap[] {
	const typer = [...new Set(rader.map((r) => r.typ))];
	const out: Egenskap[] = [];
	for (const e of input) {
		const typ = typer.find((t) => normalizeName(t) === normalizeName(e.typ));
		if (!typ) {
			throw new ToolInputError(
				`Okänd egenskapstyp "${e.typ}".${didYouMean(suggest(e.typ, typer))} Egenskapstyper i registret: ${typer.sort((a, b) => a.localeCompare(b, "sv")).join(", ")}. Se uppslag lista=egenskapstyper.`,
			);
		}
		const varden = rader.filter((r) => r.typ === typ).map((r) => r.varde);
		const varde = varden.find((v) => normalizeName(v) === normalizeName(e.varde));
		if (!varde) {
			throw new ToolInputError(
				`Okänt värde "${e.varde}" för egenskapstypen "${typ}".${didYouMean(suggest(e.varde, varden))} Se uppslag lista=egenskapstyper sok="${typ}".`,
			);
		}
		if (!out.some((x) => x.typ === typ && x.varde === varde)) out.push({ typ, varde });
	}
	return out;
}

/**
 * Filtret i K-samsöks form (reservläget): högst MAX_ORD ord, kategori →
 * lämningstyper, nara → ruta (mittpunkten matchas). Egenskaper går inte.
 */
export async function toKsamsokFilter(
	r: ResolvedFilter,
	deps: ToolDeps,
	orsak: string,
): Promise<{ filter: ResolvedSearchFilter; anmarkningar: string[] }> {
	const { fraga: _f, kategori: _k, egenskap, nara, ...rest } = r.filter;
	const anmarkningar: string[] = [];
	if (egenskap?.length) {
		throw new ToolInputError(
			`Filter på egenskaper kräver serverns eget lämningsindex, som inte är tillgängligt just nu (${orsak}). Sök i stället på egenskapsordet i fraga, t.ex. "koppar", eller försök igen om en stund.`,
		);
	}
	const filter: ResolvedSearchFilter = { ...rest };
	if (r.ord.length > MAX_ORD) {
		filter.ord = r.ord.slice(0, MAX_ORD);
		anmarkningar.push(
			`fraga hade ${r.ord.length} ord; bara de ${MAX_ORD} första användes (${r.ord.slice(MAX_ORD).join(", ")} ströks). Alla ord måste finnas i posten, så färre ord ger oftast fler träffar.`,
		);
	}
	if (r.kategorier.length) {
		const typer = await deps.domains.lamningstyperIKategorier(r.kategorier);
		const valda = filter.lamningstyp ? typer.filter((t) => filter.lamningstyp?.includes(t)) : typer;
		if (valda.length === 0) throw new ToolInputError(`Kategorin ${r.kategorier.map((k) => `"${k}"`).join(", ")} har inga lämningstyper i värdelistorna.`);
		if (valda.length > MAX_TYPER_I_FRAGA) {
			throw new ToolInputError(
				`Kategorierna motsvarar ${valda.length} lämningstyper, fler än ${MAX_TYPER_I_FRAGA} som går att skicka i en fråga till K-samsök (reservläget). Välj färre kategorier.`,
			);
		}
		filter.lamningstyp = valda;
		anmarkningar.push(`kategori ${r.kategorier.join(", ")} har översatts till ${valda.length} lämningstyper (se filter.lamningstyp).`);
	}
	if (nara) {
		filter.bbox = bboxAround({ lat: nara.lat, lon: nara.lon }, nara.radie_m);
		anmarkningar.push(
			`nara söker i reservläget i en kvadrat på ±${nara.radie_m} m och matchar lämningens mittpunkt; stora ytor kan missas. lamningar_nara räknar avstånd till närmaste punkt på geometrin.`,
		);
	}
	return { filter, anmarkningar };
}

/** Kort beskrivning av filtret, för svar utan träffar. */
export function describeFilter(f: ResolvedSearchFilter): string {
	const parts: string[] = [];
	if (f.ord) parts.push(`ord: ${f.ord.join(" OCH ")}`);
	if (f.nummer) parts.push(`nummer: ${f.nummer.join(", ")}`);
	if (f.lamningstyp) parts.push(`typ: ${f.lamningstyp.join(", ")}`);
	if (f.kategori) parts.push(`kategori: ${f.kategori.join(", ")}`);
	if (f.antikvarisk_bedomning) parts.push(`bedömning: ${f.antikvarisk_bedomning.join(", ")}`);
	if (f.kommun) parts.push(`kommun: ${f.kommun.join(", ")}`);
	if (f.socken) {
		const q = (s: NonNullable<ResolvedSearchFilter["socken"]>[number]) => [s.lan?.join("/"), s.kommun?.join("/")].filter(Boolean).join(", ");
		parts.push(`socken: ${f.socken.map((s) => (q(s) ? `${s.namn} (${q(s)})` : s.namn)).join(", ")}`);
	}
	if (f.landskap) parts.push(`landskap: ${f.landskap.join(", ")}`);
	if (f.lan) parts.push(`län: ${f.lan.join(", ")}`);
	if (f.egenskap) parts.push(`egenskap: ${f.egenskap.map((e) => `${e.typ}=${e.varde}`).join(", ")}`);
	if (f.nara) parts.push(`inom ${f.nara.radie_m} m från ${f.nara.lat.toFixed(5)}, ${f.nara.lon.toFixed(5)}`);
	if (f.bbox) parts.push(`område: ${f.bbox.map((n) => n.toFixed(4)).join(", ")}`);
	return parts.join("; ");
}
