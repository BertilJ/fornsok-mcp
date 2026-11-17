import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { SOURCE_NAMES, ToolInputError, UpstreamError } from "../errors";
import { type Geometry, simplifyToLimit, swerefToWgs, wgsToSweref, countPositions } from "../geo/geometry";
import { type ParsedId, parseId } from "../ids";
import type { LamningPost, RecordFetchResult } from "../sources/types";
import { BOILERPLATE_RE, READ_ONLY, type ToolDeps, fmtCoord, list, ok, runTool } from "./common";

export const MAX_GEOMETRY_POSITIONS = 500;

const INKLUDERA = ["geometri", "referenser", "dokument", "historik", "relaterat"] as const;
const SENARE: Record<string, string> = {
	dokument: "Dokument (inventeringsböcker, bilder, händelseloggar) finns inte än – kommer i etapp 2.",
	historik: "Versionshistorik finns inte än – kommer senare.",
	relaterat: "Relaterat material (foton, arkivhandlingar, föremål) finns inte än – kommer senare.",
};

export const lamningInput = z.object({
	id: z
		.array(z.string().min(1).max(200))
		.min(1)
		.max(10)
		.describe("1–10 identiteter: lämningsnummer (L2001:646), RAÄ-nummer (Bjursås 27:1), UUID eller K-samsök-URI."),
	inkludera: z
		.array(z.enum(INKLUDERA))
		.optional()
		.describe(
			"Extra delar: geometri (GeoJSON i WGS 84, förenklad över 500 brytpunkter) och referenser (skriftliga källor, kartor, uppgiftslämnare). dokument, historik och relaterat kommer senare.",
		),
});

const egenskap = z.object({ typ: z.string(), varde: z.string() });
const lamningSchema = z.object({
	lamningsnummer: z.string().nullable(),
	raa_nummer: z.string().nullable(),
	uuid: z.string(),
	lamningstyp: z.string().nullable(),
	kategori: z.array(z.string()).optional(),
	antikvarisk_bedomning: z.object({ varde: z.string().nullable(), motivering: z.string().nullable() }),
	antikvarisk_kommentar: z.string().nullable().optional(),
	beskrivning: z.string().nullable(),
	tradition: z.string().nullable(),
	terrang: z.string().nullable(),
	orientering: z.string().nullable(),
	vegetation: z.string().nullable().optional(),
	namn: z.array(z.string()).optional(),
	egenskaper: z.array(egenskap),
	ingaende_lamningar: z.array(z.object({ lamningstyp: z.string(), antal: z.number().nullable(), egenskaper: z.array(egenskap) })),
	statusar: z.object({
		aktualitet: z.string().nullable(),
		undersokning: z.string().nullable(),
		skada: z.string().nullable(),
		placering: z.string().nullable(),
	}),
	lage: z.object({
		lat: z.number().nullable(),
		lon: z.number().nullable(),
		sweref99tm: z.object({ e: z.number(), n: z.number() }).nullable(),
		osakerhet_m: z.number().nullable(),
		geometrityp: z.string().nullable(),
		hojd_over_havet_m: z.object({ min: z.number().nullable(), max: z.number().nullable() }).nullable().optional(),
	}),
	indelning: z.object({
		lan: z.array(z.string()),
		kommun: z.array(z.string()),
		socken: z.array(z.string()),
		landskap: z.array(z.string()),
	}),
	url: z.string(),
	kalla: z.string(),
	hamtad_fran: z.string(),
	geometri: z.unknown().optional(),
	geometri_forenklad: z.boolean().optional(),
	referenser: z
		.object({
			skriftliga_kallor: z.array(z.string()),
			kartmaterial: z.array(z.string()),
			uppgiftslamnare: z.array(z.string()),
		})
		.optional(),
});

export const lamningOutput = z.object({
	lamningar: z.array(lamningSchema),
	ej_hittade: z.array(z.object({ id: z.string(), orsak: z.string() })),
	anmarkningar: z.array(z.string()),
});

type LamningArgs = z.infer<typeof lamningInput>;

export function registerLamning(server: McpServer, deps: ToolDeps): void {
	server.registerTool(
		"lamning",
		{
			title: "Hämta lämning",
			description:
				"Hela posten för 1–10 lämningar ur Kulturmiljöregistret: identiteter, typ, antikvarisk bedömning med motivering, beskrivning, " +
				"tradition, terräng, orientering, egenskaper, ingående lämningar, statusar, indelning, mittpunkt och lägesosäkerhet. " +
				"Tar lämningsnummer, RAÄ-nummer (äldre litteratur), UUID eller K-samsök-URI. Hämtas från Fornsök-appen, med K-samsök som reserv. " +
				"`inkludera` lägger till geometri och referenser.",
			inputSchema: lamningInput,
			outputSchema: lamningOutput,
			annotations: { ...READ_ONLY, title: "Hämta lämning" },
		},
		async (args) => runTool(() => hamtaLamningar(args, deps)),
	);
}

export async function hamtaLamningar(args: LamningArgs, deps: ToolDeps) {
	const inkludera = new Set(args.inkludera ?? []);
	const anmarkningar: string[] = [];
	for (const key of ["dokument", "historik", "relaterat"]) if (inkludera.has(key as (typeof INKLUDERA)[number])) anmarkningar.push(SENARE[key]);

	const ej_hittade: Array<{ id: string; orsak: string }> = [];
	const parsed: ParsedId[] = [];
	for (const raw of args.id) {
		try {
			parsed.push(parseId(raw));
		} catch (err) {
			if (err instanceof ToolInputError) ej_hittade.push({ id: raw, orsak: err.message });
			else throw err;
		}
	}

	// Nummer → UUID med ett anrop.
	const numbers = parsed.filter((p) => p.kind !== "uuid").map((p) => (p as { value: string }).value);
	let resolved = new Map<string, string>();
	if (numbers.length) resolved = await deps.ids.resolveNumbers([...new Set(numbers)]);

	const wanted: Array<{ id: string; uuid: string }> = [];
	for (const p of parsed) {
		if (p.kind === "uuid") wanted.push({ id: p.input, uuid: p.uuid });
		else {
			const uuid = resolved.get(p.value);
			if (uuid) wanted.push({ id: p.input, uuid });
			else
				ej_hittade.push({
					id: p.input,
					orsak: `Inget ${p.kind === "lamningsnummer" ? "lämningsnummer" : "RAÄ-nummer"} "${p.value}" hittades i K-samsök (som ligger några dagar efter registret).`,
				});
		}
	}
	const seen = new Set<string>();
	const unique = wanted.filter((w) => (seen.has(w.uuid) ? false : (seen.add(w.uuid), true)));

	const results = await Promise.all(unique.map((w) => fetchWithFallback(w.uuid, deps)));
	const lamningar: LamningPost[] = [];
	results.forEach((r, i) => {
		if (r.notes.length) anmarkningar.push(...r.notes);
		if (!r.result) {
			ej_hittade.push({ id: unique[i].id, orsak: r.error ?? "Lämningen hittades inte." });
			return;
		}
		lamningar.push(withIncludes(r.result, inkludera));
	});

	if (lamningar.length === 0 && ej_hittade.length > 0 && parsed.length === 0) {
		throw new ToolInputError(ej_hittade.map((e) => e.orsak).join(" "));
	}

	const structured = { lamningar, ej_hittade, anmarkningar };
	const lines: string[] = [];
	for (const l of lamningar) lines.push(formatPost(l));
	for (const e of ej_hittade) lines.push(`Ej hittad: ${e.id} – ${e.orsak}`);
	for (const a of anmarkningar) lines.push(`Obs: ${a}`);
	return ok(lines.join("\n\n"), structured);
}

async function fetchWithFallback(
	uuid: string,
	deps: ToolDeps,
): Promise<{ result: RecordFetchResult | null; notes: string[]; error?: string }> {
	const notes: string[] = [];
	const errors: string[] = [];
	for (let i = 0; i < deps.records.length; i++) {
		const { name, source } = deps.records[i];
		try {
			const r = await source.getByUuid(uuid);
			if (r) {
				if (i > 0) {
					notes.push(
						`${r.post.lamningsnummer ?? uuid}: hämtad från reservkällan ${name} (${errors.join("; ") || "saknades i primärkällan"}). Egenskaper, motivering och lägesosäkerhet saknas där.`,
					);
				}
				return { result: r, notes };
			}
			errors.push(`${name}: hittades inte`);
		} catch (err) {
			errors.push(err instanceof UpstreamError ? `${SOURCE_NAMES[err.source]}: ${err.message}` : `${name}: ${String(err)}`);
		}
	}
	return { result: null, notes, error: `Lämningen ${uuid} kunde inte hämtas (${errors.join("; ")}).` };
}

function withIncludes(r: RecordFetchResult, inkludera: Set<string>): LamningPost {
	const post: LamningPost = { ...r.post };
	if (inkludera.has("geometri")) {
		let planar: Geometry | null = r.geometriSweref ?? (r.geometriWgs ? wgsToSweref(r.geometriWgs) : null);
		if (planar) {
			const before = countPositions(planar);
			const s = simplifyToLimit(planar, MAX_GEOMETRY_POSITIONS);
			planar = s.geometry;
			post.geometri = swerefToWgs(planar);
			post.geometri_forenklad = s.tolerance > 0 && countPositions(planar) < before;
		} else {
			post.geometri = null;
		}
	}
	if (inkludera.has("referenser")) post.referenser = r.referenser;
	return post;
}

function stripBoilerplate(s: string | null): string | null {
	return s ? s.replace(BOILERPLATE_RE, "").trim() : s;
}

export function formatPost(l: LamningPost): string {
	const lines: string[] = [];
	const id = [l.lamningsnummer, l.raa_nummer ? `(${l.raa_nummer})` : null].filter(Boolean).join(" ");
	lines.push(`${id} – ${l.lamningstyp ?? "okänd typ"}${l.kategori?.length ? ` [${l.kategori.join(", ")}]` : ""}`);
	lines.push(`Länk: ${l.url}`);
	lines.push(
		`Antikvarisk bedömning (registrets): ${l.antikvarisk_bedomning.varde ?? "saknas"}${l.antikvarisk_bedomning.motivering ? ` – ${l.antikvarisk_bedomning.motivering}` : ""}`,
	);
	lines.push(`Indelning: ${list([list(l.indelning.lan), list(l.indelning.kommun), list(l.indelning.socken)])}${l.indelning.landskap.length ? `; landskap ${list(l.indelning.landskap)}` : ""}`);
	const osak = l.lage.osakerhet_m !== null ? `, lägesosäkerhet ${l.lage.osakerhet_m} m` : "";
	const sw = l.lage.sweref99tm ? ` (SWEREF 99 TM N ${l.lage.sweref99tm.n}, E ${l.lage.sweref99tm.e})` : "";
	lines.push(`Läge: ${fmtCoord(l.lage.lat, l.lage.lon)}${sw}${osak}${l.lage.geometrityp ? `, geometri ${l.lage.geometrityp}` : ""}`);
	if (l.namn?.length) lines.push(`Namn: ${l.namn.join(", ")}`);
	const statusar = list([l.statusar.aktualitet, l.statusar.placering, l.statusar.skada ? `skada: ${l.statusar.skada}` : null, l.statusar.undersokning ? `undersökning: ${l.statusar.undersokning}` : null]);
	if (statusar) lines.push(`Status: ${statusar}`);
	const kt = (label: string, v: string | null | undefined) => {
		const t = stripBoilerplate(v ?? null);
		if (t) lines.push(`${label} (källtext): «${t}»`);
	};
	kt("Beskrivning", l.beskrivning);
	kt("Tradition", l.tradition);
	kt("Terräng", l.terrang);
	kt("Orientering", l.orientering);
	kt("Antikvarisk kommentar", l.antikvarisk_kommentar);
	if (l.egenskaper.length) lines.push(`Egenskaper: ${l.egenskaper.map((e) => `${e.typ}: ${e.varde}`).join("; ")}`);
	if (l.ingaende_lamningar.length) {
		lines.push(
			`Ingående lämningar: ${l.ingaende_lamningar
				.map((i) => `${i.lamningstyp}${i.antal !== null ? ` ×${i.antal}` : ""}${i.egenskaper.length ? ` (${i.egenskaper.map((e) => `${e.typ}: ${e.varde}`).join(", ")})` : ""}`)
				.join("; ")}`,
		);
	}
	if (l.referenser) {
		const r = l.referenser;
		if (r.skriftliga_kallor.length) lines.push(`Skriftliga källor: ${r.skriftliga_kallor.join(" | ")}`);
		if (r.kartmaterial.length) lines.push(`Kartmaterial: ${r.kartmaterial.join(" | ")}`);
		if (r.uppgiftslamnare.length) lines.push(`Uppgiftslämnare: ${r.uppgiftslamnare.join(" | ")}`);
		if (!r.skriftliga_kallor.length && !r.kartmaterial.length && !r.uppgiftslamnare.length) lines.push("Referenser: inga i registret.");
	}
	if (l.geometri !== undefined) {
		lines.push(
			l.geometri
				? `Geometri: GeoJSON i structuredContent (WGS 84)${l.geometri_forenklad ? ", förenklad till högst 500 brytpunkter" : ""}.`
				: "Geometri: saknas.",
		);
	}
	lines.push(`Källa: ${l.kalla}; hämtad från ${l.hamtad_fran}.`);
	return lines.join("\n");
}
