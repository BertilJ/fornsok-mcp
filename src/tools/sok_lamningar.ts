import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { publicUrl } from "../config";
import { ToolInputError } from "../errors";
import { bboxAround } from "../geo/geometry";
import { isInSweden, round, toPlanar } from "../geo/sweref";
import { normalizeName } from "../lookup/names";
import { MAX_ORD, splitWords } from "../sources/ksamsok/query";
import { BEDOMNINGAR, type ResolvedSearchFilter } from "../sources/types";
import { READ_ONLY, type ToolDeps, fmtCoord, list, ok, runTool } from "./common";
import { makeUtdrag } from "./utdrag";

/** Högst så många lämningstyper i en K-samsök-fråga (adresslängd). Den största kategorin har 32. */
const MAX_TYPER_I_FRAGA = 60;

const namnLista = (beskrivning: string) => z.array(z.string().min(1).max(100)).min(1).max(20).optional().describe(beskrivning);

export const sokInput = z.object({
	fraga: z
		.string()
		.min(1)
		.max(500)
		.optional()
		.describe(
			"Sökord. Alla ord måste finnas i posten (OCH). Ingen stamning: pröva flera böjningsformer, synonymer och äldre stavningar.",
		),
	lage: z
		.enum(["auto", "ord", "betydelse"])
		.default("auto")
		.describe("Sökläge. Just nu finns bara ordsök; \"auto\" och \"ord\" ger samma resultat. \"betydelse\" (semantisk sökning) kommer senare."),
	nummer: z
		.array(z.string().min(1).max(60))
		.min(1)
		.max(20)
		.optional()
		.describe("Lämningsnummer (L2001:646) eller RAÄ-nummer (Bjursås 27:1)."),
	lamningstyp: namnLista("Lämningstyper, t.ex. \"Hyttområde\". Se uppslag lista=lamningstyper."),
	kategori: namnLista(
		"Kategorier av lämningstyper, t.ex. \"Gravar\" eller \"Metallframställning och bergsbruk\". Översätts till kategorins lämningstyper (se uppslag lista=kategorier). Tillsammans med lamningstyp gäller typer som finns i båda.",
	),
	antikvarisk_bedomning: z.array(z.enum(BEDOMNINGAR)).min(1).max(5).optional().describe("Antikvarisk bedömning."),
	kommun: namnLista("Kommunnamn, t.ex. \"Falun\"."),
	socken: namnLista("Socknar. Flertydiga namn anges med län, t.ex. \"Näs (Jämtland)\"."),
	landskap: namnLista("Landskap, t.ex. \"Dalarna\"."),
	lan: namnLista("Län, t.ex. \"Dalarna\" eller \"Dalarnas län\"."),
	egenskap: z
		.array(z.object({ typ: z.string(), varde: z.string() }))
		.optional()
		.describe("Filter på egenskaper (Verksamhet, Material, Form …). Kommer senare (kräver indexet)."),
	nara: z
		.object({
			lat: z.number().min(-90).max(90),
			lon: z.number().min(-180).max(180),
			radie_m: z.number().positive().max(20_000).default(1000),
		})
		.optional()
		.describe("Begränsa till ett område runt en punkt (WGS 84). Matchar lämningens mittpunkt."),
	antal: z.number().int().min(1).max(50).default(15).describe("Träffar per sida (högst 50)."),
	sida: z.number().int().min(1).max(200).default(1).describe("Sidnummer, från 1."),
});

const koordinat = z.object({ lat: z.number(), lon: z.number() });

export const sokOutput = z.object({
	totalt: z.number().int(),
	sida: z.number().int(),
	antal: z.number().int(),
	sokkanaler: z.array(z.enum(["ord", "betydelse"])),
	kalla: z.string(),
	data_byggd: z.string().nullable(),
	filter: z.record(z.string(), z.unknown()),
	traffar: z.array(
		z.object({
			lamningsnummer: z.string().nullable(),
			raa_nummer: z.string().nullable(),
			uuid: z.string(),
			lamningstyp: z.string().nullable(),
			antikvarisk_bedomning: z.string().nullable(),
			kommun: z.array(z.string()),
			socken: z.array(z.string()),
			lan: z.array(z.string()),
			landskap: z.array(z.string()),
			koordinat: koordinat.nullable(),
			sweref99tm: z.object({ e: z.number(), n: z.number() }).nullable(),
			utdrag: z.string().optional(),
			avstand_m: z.number().optional(),
			url: z.string(),
		}),
	),
	anmarkningar: z.array(z.string()),
	forslag: z.array(z.string()).optional(),
});

type SokArgs = z.infer<typeof sokInput>;

export function registerSokLamningar(server: McpServer, deps: ToolDeps): void {
	server.registerTool(
		"sok_lamningar",
		{
			title: "Sök lämningar",
			description:
				"Ordsök i Kulturmiljöregistret (fornlämningar och andra kulturhistoriska lämningar) via K-samsök. " +
				"Kombinera fritext med filter på nummer, lämningstyp, antikvarisk bedömning, kommun, socken, landskap, län och område. " +
				"Alla ord i `fraga` måste finnas (OCH); ingen stamning. Ger nummer, typ, bedömning, indelning, koordinat, utdrag och länk. " +
				"K-samsök ligger några dagar efter registret. För närmaste lämningar runt en punkt, använd lamningar_nara; för hela posten, lamning.",
			inputSchema: sokInput,
			outputSchema: sokOutput,
			annotations: { ...READ_ONLY, title: "Sök lämningar" },
		},
		async (args) => runTool(() => sokLamningar(args, deps)),
	);
}

export async function sokLamningar(args: SokArgs, deps: ToolDeps) {
	if (args.lage === "betydelse") {
		throw new ToolInputError(
			'Semantisk sökning (lage: "betydelse") finns inte än – den kommer när det egna indexet är byggt (Dalarnas län). Använd lage "ord" och pröva flera ordformer och synonymer.',
		);
	}
	if (args.egenskap?.length) {
		throw new ToolInputError(
			"Filter på egenskaper (typ/värde) finns inte än – det kräver det egna indexet och kommer senare. Sök i stället på egenskapsordet i fraga, t.ex. \"koppar\".",
		);
	}

	const anmarkningar: string[] = [];

	// K-samsök söker inte lämnings- eller RAÄ-nummer i fritext (SPEC 3 #9): flytta dem till nummer.
	// Ett RAÄ-nummer börjar med socknens (eller stadens) namn; kontrollera mot värdelistorna.
	let sockenNamn: Set<string> | null = null;
	if (args.fraga && RAA_NUMMER_RE.test(args.fraga.normalize("NFC").trim().replace(/\s+/g, " "))) {
		const d = await deps.domains.get();
		sockenNamn = new Set(d.socknar.map((s) => normalizeName(s.namn)));
	}
	const { ord: allaOrd, nummer: nummerIFraga } = args.fraga
		? splitFraga(args.fraga, (prefix) => sockenNamn?.has(normalizeName(prefix)) ?? false)
		: { ord: [], nummer: [] };
	if (nummerIFraga.length) {
		anmarkningar.push(
			`${nummerIFraga.map((n) => `"${n}"`).join(", ")} i fraga ser ut som lämnings- eller RAÄ-nummer och söktes via nummer (K-samsök hittar inte nummer i fritext).`,
		);
	}
	if (args.fraga && allaOrd.length === 0 && nummerIFraga.length === 0) throw new ToolInputError("Frågan innehåller inga sökbara ord.");
	const ord = allaOrd.slice(0, MAX_ORD);
	if (allaOrd.length > MAX_ORD) {
		anmarkningar.push(`fraga hade ${allaOrd.length} ord; bara de ${MAX_ORD} första användes (${allaOrd.slice(MAX_ORD).join(", ")} ströks). Alla ord måste finnas i posten, så färre ord ger oftast fler träffar.`);
	}
	if (ord.some((w) => /^\d{1,5}:\d{1,4}$/.test(w))) {
		anmarkningar.push("fraga innehåller något som liknar ett RAÄ-nummer; ange hela numret (t.ex. \"Bjursås 27:1\") i nummer – K-samsök söker inte nummer i fritext.");
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
		const typer = await deps.domains.lamningstyperIKategorier(kategorier);
		const valda = filter.lamningstyp ? typer.filter((t) => filter.lamningstyp?.includes(t)) : typer;
		if (valda.length === 0) {
			throw new ToolInputError(
				filter.lamningstyp
					? `Ingen av lämningstyperna ${filter.lamningstyp.map((t) => `"${t}"`).join(", ")} hör till kategorin ${kategorier.map((k) => `"${k}"`).join(", ")}. Ta bort ett av filtren, eller se uppslag lista=lamningstyper för typernas kategorier.`
					: `Kategorin ${kategorier.map((k) => `"${k}"`).join(", ")} har inga lämningstyper i värdelistorna.`,
			);
		}
		if (valda.length > MAX_TYPER_I_FRAGA) {
			throw new ToolInputError(
				`Kategorierna motsvarar ${valda.length} lämningstyper, fler än ${MAX_TYPER_I_FRAGA} som går att skicka i en fråga till K-samsök. Välj färre kategorier.`,
			);
		}
		filter.lamningstyp = valda;
		anmarkningar.push(`kategori ${kategorier.join(", ")} har översatts till ${valda.length} lämningstyper (se filter.lamningstyp).`);
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
	let center: { lat: number; lon: number } | null = null;
	if (args.nara) {
		center = { lat: args.nara.lat, lon: args.nara.lon };
		if (!isInSweden(center)) throw new ToolInputError("Punkten i nara ligger utanför Sverige. Ange lat/lon i WGS 84 (t.ex. lat 60.6, lon 15.6).");
		filter.bbox = bboxAround(center, args.nara.radie_m);
		anmarkningar.push(
			`nara söker i en kvadrat på ±${args.nara.radie_m} m och matchar lämningens mittpunkt; stora ytor kan missas. Använd lamningar_nara för avstånd till närmaste punkt på geometrin.`,
		);
	}

	const hasCriteria =
		ord.length || filter.nummer || filter.lamningstyp || filter.antikvarisk_bedomning || filter.kommun || filter.socken || filter.landskap || filter.lan || filter.bbox;
	if (!hasCriteria) throw new ToolInputError("Ange minst ett sökvillkor: fraga, nummer, lamningstyp, antikvarisk_bedomning, kommun, socken, landskap, lan eller nara.");

	const page = await deps.search.search(filter, { antal: args.antal, sida: args.sida });
	const centerPlanar = center ? toPlanar(center) : null;
	const traffar = page.traffar.map((h) => {
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
			...(centerPlanar && sw ? { avstand_m: Math.round(Math.hypot(sw.e - centerPlanar.e, sw.n - centerPlanar.n)) } : {}),
			url: publicUrl(h.uuid),
		};
	});

	const forslag: string[] = [];
	if (page.totalt === 0) {
		if (ord.length > 1) forslag.push("Färre ord – alla ord måste finnas i posten.");
		if (ord.length) forslag.push("Andra böjningsformer, synonymer eller äldre stavning (t.ex. hytta/hyttan, kolbotten/kolbottnar, hv/v).");
		if (filter.socken || filter.kommun) forslag.push("Bredare område (län eller landskap i stället för socken/kommun).");
		if (kategorier.length) forslag.push("Annan eller ingen kategori.");
		else if (filter.lamningstyp) forslag.push("Utan lämningstyp, eller med närliggande typer (se uppslag).");
		if (filter.antikvarisk_bedomning) forslag.push("Utan filter på antikvarisk bedömning.");
		if (filter.bbox) forslag.push("Större radie, eller lamningar_nara som räknar avstånd till hela geometrin.");
	}
	const sidStart = (args.sida - 1) * args.antal + 1;
	if (page.totalt > 0 && traffar.length === 0) anmarkningar.push(`Sidan ${args.sida} ligger efter sista träffen.`);

	const appliedFilter: Record<string, unknown> = { ...filter, ...(kategorier.length ? { kategori: kategorier } : {}) };
	const structured = {
		totalt: page.totalt,
		sida: args.sida,
		antal: args.antal,
		sokkanaler: ["ord" as const],
		kalla: `${page.kalla} (levande källa)`,
		data_byggd: page.byggdatum ?? null,
		filter: appliedFilter,
		traffar,
		anmarkningar,
		...(forslag.length ? { forslag } : {}),
	};

	const lines: string[] = [];
	if (page.totalt === 0) {
		lines.push("Inga träffar i registret med de här villkoren.");
		lines.push(`Villkor: ${describeFilter(filter)}`);
		if (forslag.length) lines.push(`Pröva: ${forslag.join(" ")}`);
	} else {
		lines.push(
			`${page.totalt} träffar${traffar.length ? `, visar ${sidStart}–${sidStart + traffar.length - 1}` : ""} (sida ${args.sida}). Källa: ${page.kalla}${page.byggdatum ? `, data byggd ${page.byggdatum}` : ""}.`,
		);
		traffar.forEach((t, i) => {
			const id = [t.lamningsnummer, t.raa_nummer ? `(${t.raa_nummer})` : null].filter(Boolean).join(" ");
			const plats = list([list(t.kommun), list(t.socken)]);
			const dist = t.avstand_m !== undefined ? `, ${t.avstand_m} m bort` : "";
			lines.push(
				`${sidStart + i}. ${id} – ${t.lamningstyp ?? "okänd typ"}, ${t.antikvarisk_bedomning ?? "bedömning saknas"}. ${plats}. ${fmtCoord(t.koordinat?.lat, t.koordinat?.lon)}${dist}. ${t.url}`,
			);
			if (t.utdrag) lines.push(`   Källtext (registret): «${t.utdrag}»`);
		});
	}
	for (const a of anmarkningar) lines.push(`Obs: ${a}`);
	return ok(lines.join("\n"), structured);
}

function describeFilter(f: ResolvedSearchFilter): string {
	const parts: string[] = [];
	if (f.ord) parts.push(`ord: ${f.ord.join(" OCH ")}`);
	if (f.nummer) parts.push(`nummer: ${f.nummer.join(", ")}`);
	if (f.lamningstyp) parts.push(`typ: ${f.lamningstyp.join(", ")}`);
	if (f.antikvarisk_bedomning) parts.push(`bedömning: ${f.antikvarisk_bedomning.join(", ")}`);
	if (f.kommun) parts.push(`kommun: ${f.kommun.join(", ")}`);
	if (f.socken) {
		const q = (s: NonNullable<ResolvedSearchFilter["socken"]>[number]) => [s.lan?.join("/"), s.kommun?.join("/")].filter(Boolean).join(", ");
		parts.push(`socken: ${f.socken.map((s) => (q(s) ? `${s.namn} (${q(s)})` : s.namn)).join(", ")}`);
	}
	if (f.landskap) parts.push(`landskap: ${f.landskap.join(", ")}`);
	if (f.lan) parts.push(`län: ${f.lan.join(", ")}`);
	if (f.bbox) parts.push(`område: ${f.bbox.map((n) => n.toFixed(4)).join(", ")}`);
	return parts.join("; ");
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
