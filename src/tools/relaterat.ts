/**
 * `relaterat` (SPEC 6 "Senare"): foton, arkivhandlingar, föremål och annat som
 * K-samsök knyter till en lämning, med länkar och rättighetsuppgifter ordagrant
 * ur K-samsök. Servern hämtar inga bilder – bara länkar. Källan och vad den
 * faktiskt ger står i src/sources/ksamsok/relations.ts.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { publicUrl } from "../config";
import { ToolInputError } from "../errors";
import { parseId } from "../ids";
import { RELATERAT_SLAG, type RelateratLista, type RelateratObjekt, type RelateratSammanfattning, type RelateratSlag } from "../sources/types";
import { READ_ONLY, type ToolDeps, citat, citatStycken, EXTERN_TEXT, kallrad, ok, rad, runTool } from "./common";
import { FMI_URI_RE, KSAMSOK_OBJEKT_URI_RE, lankVard } from "../sources/ksamsok/relations";
import { relationstypSv } from "../sources/ksamsok/relationstyper";
import { finnsLamning } from "./dokument";
import { resolveOneUuid } from "./resolve";
import { strikt } from "./schema";

export const RELATERAT_KALLA = "K-samsök (Riksantikvarieämbetet och anslutna institutioner)";
const MAX_SIDA = 100;
/** Längsta beskrivning i den läsbara texten (hela finns i structuredContent). */
const TEXT_BESKRIVNING = 300;

export const relateratInput = strikt("relaterat", {
	id: z.string().min(1).max(200).describe("En lämning: lämningsnummer (L2001:646), RAÄ-nummer (Bjursås 27:1), UUID eller K-samsök-URI."),
	slag: z
		.array(z.enum(RELATERAT_SLAG))
		.min(1)
		.max(RELATERAT_SLAG.length)
		.optional()
		.describe(
			"Bara dessa slag: foto (bilder i RAÄ:s arkiv, även ritningar och teckningar), arkivhandling (t.ex. inventeringsboksuppslag), föremål (museiföremål), dokumentation, äldre post (FMI-poster som lämningen ersätter), övrigt (t.ex. samma objekt i en annan databas).",
		),
	antal: z.number().int().min(1).max(50).default(20).describe("Objekt per sida (högst 50)."),
	sida: z.number().int().min(1).max(MAX_SIDA).default(1).describe("Sidnummer, från 1."),
});

const bild = z.object({
	miniatyr: z.string().nullable(),
	stor: z.string().nullable(),
	licens: z.string().nullable(),
	licens_url: z.string().nullable(),
	upphovsratt: z.string().nullable(),
	byline: z.string().nullable(),
	motiv: z.string().nullable(),
});

export const relateratObjekt = z.object({
	slag: z.enum(RELATERAT_SLAG),
	relationstyp: z.string().nullable(),
	relationstyp_okand: z.boolean().optional(),
	harledd: z.boolean().nullable(),
	/** Lämningens eller FMI-postens URI; null när kopplingen inte framgår av K-samsöks svar. */
	kopplad_till: z.string().nullable(),
	uri: z.string(),
	typ: z.string().nullable(),
	titel: z.string().nullable(),
	beskrivning: z.string().nullable(),
	institution: z.string().nullable(),
	tjanst: z.string().nullable(),
	tid: z.string().nullable(),
	artal: z.string().nullable(),
	person: z.string().nullable(),
	url: z.string().nullable(),
	bilder: z.array(bild),
	uppgifter: z.boolean(),
	/** false: objektet slogs inte upp i K-samsök; bara relation och adress, slaget ur relationstypen. */
	uppslagen: z.boolean(),
});

export const relateratOutput = z.object({
	lamning: z.object({ uuid: z.string(), lamningsnummer: z.string().nullable(), url: z.string() }),
	/** Antal objekt som matchar filtret. */
	totalt: z.number().int(),
	/** Antal objekt utan filter. */
	totalt_alla: z.number().int(),
	antal_per_slag: z.record(z.string(), z.number().int()),
	slag: z.array(z.enum(RELATERAT_SLAG)).nullable(),
	sida: z.number().int(),
	antal: z.number().int(),
	objekt: z.array(relateratObjekt),
	/** true när K-samsök hade fler objekt än som hämtades. */
	ofullstandig: z.boolean(),
	/** Objekt utan uppgifter ur K-samsök (bara relation och adress), av alla. */
	utan_uppgifter: z.number().int(),
	/** Varav objekt som inte slogs upp alls (slaget härlett ur relationstypen). */
	ej_uppslagna: z.number().int(),
	/** true när en del av hämtningen från K-samsök misslyckades. */
	delvis_fel: z.boolean(),
	kalla: z.string(),
	hamtad_fran: z.string(),
	anmarkningar: z.array(z.string()),
});

/** Sammanfattningen i `lamning` med `inkludera: ["relaterat"]`. */
export const relateratSammanfattning: z.ZodType<RelateratSammanfattning> = z.object({
	totalt: z.number().int(),
	antal_per_slag: z.record(z.string(), z.number().int()),
	forsta: z.array(relateratObjekt),
	ofullstandig: z.boolean(),
	utan_uppgifter: z.number().int(),
	ej_uppslagna: z.number().int(),
	delvis_fel: z.boolean(),
	anmarkningar: z.array(z.string()),
	kalla: z.string(),
	hamtad_fran: z.string(),
});

type RelateratArgs = z.infer<typeof relateratInput>;

export const RELATERAT_BESKRIVNING =
	"Relaterat material för en lämning ur K-samsök: foton, ritningar och teckningar i RAÄ:s arkiv, arkivhandlingar (t.ex. inventeringsboksuppslag), " +
	"museiföremål, dokumentation, äldre FMI-poster som lämningen ersätter, och övrigt (t.ex. samma runsten i Samnordisk runtextdatabas). " +
	"Material som är kopplat till en äldre FMI-post kommer också med, och svaret säger vilken. " +
	"Varje objekt har slag, relationstyp, titel, beskrivning, institution, årtal när det finns, länk till objektets sida, bildlänk när det finns, " +
	"och rättighetsuppgiften ordagrant ur K-samsök – medierna har egna rättigheter, som kan skilja sig från registrets CC0; anta ingen licens som inte står. " +
	"Servern hämtar inga bilder, bara länkar; varje länk står med sin värd. Tar lämningsnummer, RAÄ-nummer, UUID eller K-samsök-URI; filtrera med slag, bläddra med antal och sida." +
	EXTERN_TEXT;

export function registerRelaterat(server: McpServer, deps: ToolDeps): void {
	server.registerTool(
		"relaterat",
		{
			title: "Relaterat material",
			description: RELATERAT_BESKRIVNING,
			inputSchema: relateratInput,
			outputSchema: relateratOutput,
			annotations: { ...READ_ONLY, title: "Relaterat material" },
		},
		async (args) => runTool(() => relaterat(args, deps)),
	);
}

// ---------------------------------------------------------------- gemensamt

export function antalPerSlag(objekt: readonly RelateratObjekt[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const s of RELATERAT_SLAG) {
		const n = objekt.filter((o) => o.slag === s).length;
		if (n) out[s] = n;
	}
	return out;
}

export function fmtAntalPerSlag(a: Record<string, number>): string {
	return RELATERAT_SLAG.filter((s) => a[s])
		.map((s) => `${s} ${a[s]}`)
		.join(", ");
}

function datum(iso: string): string {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : rad(iso);
}

export function relateratHamtadFran(l: RelateratLista): string {
	return `${l.sparad ? "sparat svar, hämtat" : "hämtat"} ${datum(l.hamtad)} (${l.objekt.length ? "sparas upp till 7 dygn" : "tomt svar sparas upp till 1 dygn"}; K-samsök ligger några dagar efter registret)`;
}

function kortad(s: string | null, max: number): string | null {
	if (!s) return s;
	return s.length > max ? `${s.slice(0, max).replace(/\s+\S*$/, "")} …` : s;
}

/**
 * En länk ur K-samsök med värden utskriven. Bara adresser som klarat sakerUrl
 * (normaliserade, utan användaruppgifter) når hit. Länkar till andra värdar än
 * KANDA_VARDAR märks; servern påstår inget om vart en länk går utöver värden.
 */
export function lank(url: string): string {
	const { vard, kand } = lankVard(url);
	return kand ? `${rad(url)} (${rad(vard)})` : `extern länk enligt K-samsök (okänd värd ${rad(vard)}): ${rad(url)}`;
}

function relationText(o: RelateratObjekt): string | null {
	const sv = relationstypSv(o.relationstyp);
	if (o.relationstyp && sv) return `${o.relationstyp} (${sv})`;
	if (o.relationstyp_okand) return "okänd relation";
	return null;
}

function kopplingText(o: RelateratObjekt): string {
	if (o.kopplad_till === null) return "koppling okänd (objektet kom med i sökningen på lämningen och dess äldre FMI-poster, men K-samsök anger inte till vilken)";
	if (o.kopplad_till.includes("/raa/fmi/")) return `kopplad till den äldre FMI-posten ${rad(o.kopplad_till)}, som lämningen ersätter; relationstypen anges där, inte här`;
	return "kopplad till lämningen";
}

function titelText(o: RelateratObjekt): string {
	if (o.titel) return citat(o.titel);
	return o.slag === "äldre post" && FMI_URI_RE.test(o.uri) ? `FMI-post ${rad(o.uri.split("/").pop())}` : "titel saknas";
}

/** Ett objekt som läsbar text. All fri text från K-samsök är extern text: rensad och inom «». */
export function formatObjekt(o: RelateratObjekt, nr: number | null, indrag = ""): string[] {
	const lines: string[] = [];
	const omrade = [
		o.typ ? `typ ${citat(o.typ)}` : null,
		o.institution ? `institution ${citat(o.institution)}` : null,
		o.tjanst ? `tjänst ${citat(o.tjanst)}` : null,
		o.artal && /^\d{4}(–\d{4})?$/.test(o.artal) ? o.artal : null,
	]
		.filter(Boolean)
		.join("; ");
	lines.push(`${indrag}${nr !== null ? `${nr}. ` : "- "}${o.slag[0].toLocaleUpperCase("sv")}${o.slag.slice(1)}: ${titelText(o)}${omrade ? ` (${omrade})` : ""}`);
	const sub = `${indrag}   `;
	const rel = relationText(o);
	lines.push(`${sub}Relation: ${rel ? `${rel}; ` : ""}${kopplingText(o)}. URI: ${KSAMSOK_OBJEKT_URI_RE.test(o.uri) ? rad(o.uri) : "(ogiltig adress utelämnad)"}`);
	if (!o.uppslagen) lines.push(`${sub}Ej uppslagen: K-samsök tillfrågades inte om objektet; slaget är härlett ur relationstypen.`);
	if (o.person && o.person !== o.bilder[0]?.byline) lines.push(`${sub}Person (källtext): ${citat(o.person)}`);
	const b = citatStycken(kortad(o.beskrivning, TEXT_BESKRIVNING));
	if (b) lines.push(`${sub}Beskrivning (källtext${o.beskrivning && o.beskrivning.length > TEXT_BESKRIVNING ? ", kortad" : ""}): ${b.replace(/\n/g, `\n${sub}`)}`);
	if (o.url) lines.push(`${sub}Sida: ${lank(o.url)}`);
	const flera = o.bilder.length > 1;
	o.bilder.forEach((bild, i) => {
		const n = flera ? ` ${i + 1}` : "";
		const lankar = [bild.miniatyr ? `miniatyr ${lank(bild.miniatyr)}` : null, bild.stor ? `större ${lank(bild.stor)}` : null].filter(Boolean).join(", ");
		lines.push(`${sub}Bild${n}: ${lankar || "ingen bildlänk i K-samsök"}`);
		const r = [
			bild.licens ? `licens ${citat(bild.licens)}` : "licens anges inte",
			bild.licens_url ? `licenstext ${lank(bild.licens_url)}` : null,
			bild.upphovsratt ? `upphovsrätt ${citat(bild.upphovsratt)}` : null,
			bild.byline ? `byline ${citat(bild.byline)}` : null,
		]
			.filter(Boolean)
			.join("; ");
		lines.push(`${sub}Rättigheter${flera ? ` för bild${n}` : ""} (ordagrant ur K-samsök): ${r}.`);
	});
	if (!o.bilder.length) {
		if (o.uppgifter) lines.push(`${sub}Ingen bildlänk och ingen rättighetsuppgift i K-samsök.`);
		else if (o.uppslagen) lines.push(`${sub}K-samsök har inga uppgifter om objektet utöver relationen.`);
	}
	return lines;
}

/** En rad per objekt (sammanfattningen i lamning). */
export function formatObjektKort(o: RelateratObjekt): string {
	const extra = [
		o.typ ? `typ ${citat(o.typ)}` : null,
		o.artal && /^\d{4}(–\d{4})?$/.test(o.artal) ? o.artal : null,
		o.kopplad_till === null ? "koppling okänd" : o.kopplad_till.includes("/raa/fmi/") ? "via äldre FMI-post" : null,
		o.uppslagen ? null : "ej uppslagen",
	]
		.filter(Boolean)
		.join("; ");
	const lic = o.bilder.length ? `; ${o.bilder.length === 1 ? "bild" : `${o.bilder.length} bilder`} ${o.bilder.map((b) => (b.licens ? `med licens ${citat(b.licens)}` : "utan licensuppgift")).join(", ")}` : "";
	return `- ${o.slag[0].toLocaleUpperCase("sv")}${o.slag.slice(1)}: ${titelText(o)}${extra ? ` (${extra})` : ""}${lic}. ${o.url ? lank(o.url) : KSAMSOK_OBJEKT_URI_RE.test(o.uri) ? rad(o.uri) : "(ogiltig adress utelämnad)"}`;
}

/**
 * Antal objekt utan uppgifter, och hur många av dem som inte slogs upp. Äldre
 * FMI-poster räknas inte: de är bara identifierare och har aldrig uppgifter.
 */
export function uppgiftsLage(objekt: readonly RelateratObjekt[]): { utan_uppgifter: number; ej_uppslagna: number } {
	const m = objekt.filter((o) => o.slag !== "äldre post");
	return { utan_uppgifter: m.filter((o) => !o.uppgifter).length, ej_uppslagna: m.filter((o) => !o.uppslagen).length };
}

function uppgiftsText(u: { utan_uppgifter: number; ej_uppslagna: number }): string {
	if (!u.utan_uppgifter) return "";
	return ` Varav ${u.utan_uppgifter} utan uppgifter ur K-samsök (bara relation och adress)${u.ej_uppslagna ? `, ${u.ej_uppslagna} av dem ej uppslagna (slaget härlett ur relationstypen)` : ""}.`;
}

/** Sammanfattning för `lamning`: antal per slag och de första (högst två per slag, högst fem). */
export function sammanfatta(l: RelateratLista): RelateratSammanfattning {
	const forsta: RelateratObjekt[] = [];
	const perSlag = new Map<RelateratSlag, number>();
	for (const o of l.objekt) {
		if (forsta.length >= 5) break;
		const n = perSlag.get(o.slag) ?? 0;
		if (n >= 2) continue;
		perSlag.set(o.slag, n + 1);
		forsta.push(o);
	}
	return {
		totalt: l.objekt.length,
		antal_per_slag: antalPerSlag(l.objekt),
		forsta,
		ofullstandig: l.ofullstandig,
		...uppgiftsLage(l.objekt),
		delvis_fel: l.delvis_fel,
		anmarkningar: [...l.anmarkningar],
		kalla: RELATERAT_KALLA,
		hamtad_fran: relateratHamtadFran(l),
	};
}

export function formatSammanfattning(s: RelateratSammanfattning, id: string): string[] {
	const obs = s.anmarkningar.map((a) => `  Obs (relaterat): ${rad(a)}`);
	if (s.totalt === 0) return [`Relaterat material: inget i K-samsök. ${kallrad(s.kalla, s.hamtad_fran)}`, ...obs];
	const lines = [
		`Relaterat material i K-samsök: ${s.totalt}${s.ofullstandig ? "+" : ""} objekt (${fmtAntalPerSlag(s.antal_per_slag)}).${uppgiftsText(s)}${s.delvis_fel ? " En del kunde inte hämtas." : ""} De första ${s.forsta.length}; resten med verktyget relaterat (id "${rad(id)}", filter slag):`,
	];
	for (const o of s.forsta) lines.push(`  ${formatObjektKort(o)}`);
	lines.push(`  ${kallrad(s.kalla, s.hamtad_fran)}`);
	lines.push(...obs);
	return lines;
}

// ---------------------------------------------------------------- verktyget

export async function relaterat(args: RelateratArgs, deps: ToolDeps) {
	const uuid = await resolveOneUuid(args.id, deps);
	const p = parseId(args.id);
	// Ett UUID godtas av resolveOneUuid utan uppslag: kontrollera att lämningen finns innan
	// K-samsök frågas och något sparas i KV. (Nummer är redan uppslagna i indexet eller K-samsök.)
	if (p.kind === "uuid" && !(await finnsLamning(uuid, deps))) {
		throw new ToolInputError(`Ingen lämning med UUID ${uuid} hittades i registret. Kontrollera id:t, eller sök med sok_lamningar.`);
	}
	const lista = await deps.relations.hamtaRelaterat(uuid);
	const anmarkningar = [...lista.anmarkningar];

	let lamningsnummer = lista.lamningsnummer;
	if (p.kind === "lamningsnummer") lamningsnummer = p.value;
	else if (!lamningsnummer && deps.index) {
		try {
			const ix = await deps.index.open();
			if (ix.ok) lamningsnummer = (await ix.store.hitsByUuids([uuid])).get(uuid)?.lamningsnummer ?? null;
		} catch {
			// bara för rubriken
		}
	}

	const filtrerade = args.slag ? lista.objekt.filter((o) => args.slag!.includes(o.slag)) : lista.objekt;
	const start = (args.sida - 1) * args.antal;
	const sida = filtrerade.slice(start, start + args.antal);
	const antal_per_slag = antalPerSlag(lista.objekt);
	const url = publicUrl(uuid);
	const hamtad_fran = relateratHamtadFran(lista);
	if (filtrerade.length > 0 && sida.length === 0) anmarkningar.push(`Sidan ${args.sida} ligger efter sista objektet (${filtrerade.length} objekt, ${args.antal} per sida).`);

	const structured = {
		lamning: { uuid, lamningsnummer, url },
		totalt: filtrerade.length,
		totalt_alla: lista.objekt.length,
		antal_per_slag,
		slag: args.slag ?? null,
		sida: args.sida,
		antal: args.antal,
		objekt: sida,
		ofullstandig: lista.ofullstandig,
		...uppgiftsLage(lista.objekt),
		delvis_fel: lista.delvis_fel,
		kalla: RELATERAT_KALLA,
		hamtad_fran,
		anmarkningar,
	};

	const vem = `${lamningsnummer ?? uuid} (${url})`;
	const lines: string[] = [];
	if (lista.objekt.length === 0) {
		lines.push(`Inget relaterat material i K-samsök för ${vem}.`);
	} else {
		const filter = args.slag ? ` Filter: ${args.slag.join(", ")}: ${filtrerade.length} objekt.` : "";
		lines.push(
			`Relaterat material i K-samsök för ${vem}: ${lista.objekt.length}${lista.ofullstandig ? "+" : ""} objekt (${fmtAntalPerSlag(antal_per_slag)}).${uppgiftsText(structured)}${filter}${sida.length ? ` Visar ${start + 1}–${start + sida.length} (sida ${args.sida}).` : ""}`,
		);
		sida.forEach((o, i) => lines.push(...formatObjekt(o, start + i + 1)));
		if (sida.some((o) => o.bilder.length || o.url)) {
			lines.push("Servern hämtar inga bilder, bara länkar; värden står vid varje länk, och länkar till andra värdar än K-samsök, RAÄ och licenssidorna är märkta som okänd värd. Rättigheterna gäller medierna och står per bild – anta ingen licens som inte står där.");
		}
		if (start + sida.length < filtrerade.length) lines.push(`Fler: sida ${args.sida + 1}.`);
	}
	lines.push(kallrad(RELATERAT_KALLA, hamtad_fran));
	for (const a of anmarkningar) lines.push(`Obs: ${rad(a)}`);
	return ok(lines.join("\n"), structured);
}
