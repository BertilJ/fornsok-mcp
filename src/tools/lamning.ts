import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { strikt } from "./schema";
import { SOURCE_NAMES, ToolInputError, UpstreamError } from "../errors";
import { type Geometry, simplifyToLimit, swerefToWgs, wgsToSweref, countPositions } from "../geo/geometry";
import { type ParsedId, parseId } from "../ids";
import type { LamningPost, RecordFetchResult, Referenser, Version } from "../sources/types";
import { IndexInputError } from "../store/d1";
import { BOILERPLATE_RE, READ_ONLY, type ToolDeps, citat, fmtCoord, list, ok, rad, runTool, EXTERN_TEXT } from "./common";
import { type DokumentPost, dokumentPost, formatDokumentRad, toDokumentPost } from "./dokument";
import type { OpenIndex } from "./via_index";

export const MAX_GEOMETRY_POSITIONS = 500;
/** Högst så många lämningar per anrop (även när ett RAÄ-nummer delas av flera). */
export const MAX_IDS = 10;

const INKLUDERA = ["geometri", "referenser", "dokument", "historik", "relaterat"] as const;
const SENARE: Record<string, string> = {
	relaterat: "Relaterat material (foton, arkivhandlingar, föremål) finns inte än – kommer senare.",
};

export const lamningInput = strikt("lamning", {
	id: z
		.array(z.string().min(1).max(200))
		.min(1)
		.max(10)
		.describe("1–10 identiteter: lämningsnummer (L2001:646), RAÄ-nummer (Bjursås 27:1), UUID eller K-samsök-URI."),
	inkludera: z
		.array(z.enum(INKLUDERA))
		.optional()
		.describe(
			"Extra delar: geometri (GeoJSON i WGS 84, förenklad över 500 brytpunkter), referenser (skriftliga källor, kartor, uppgiftslämnare), dokument (med dokument_ref till hamta_dokument) och historik (versioner). Referenser, dokument och historik hämtas från Fornsök-appen. relaterat kommer senare.",
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
	dokument: z.array(dokumentPost).optional(),
	historik: z
		.array(
			z.object({
				version_id: z.number().nullable(),
				publicerad: z.string().nullable(),
				registrerare: z.string().nullable(),
				aktivitet: z
					.object({
						typ: z.string().nullable(),
						nummer: z.string().nullable(),
						atgardstyp: z.string().nullable(),
						beskrivning: z.string().nullable(),
						registrerad: z.string().nullable(),
					})
					.nullable(),
			}),
		)
		.optional(),
});

export const lamningOutput = z.object({
	lamningar: z.array(lamningSchema),
	ej_hittade: z.array(z.object({ id: z.string(), orsak: z.string() })),
	anmarkningar: z.array(z.string()),
	/** true när indexet inte kunde användas och alla poster kommer från levande källor (SPEC 8). */
	reservlage: z.boolean(),
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
				"Tar lämningsnummer, RAÄ-nummer (äldre litteratur; ett nummer som delas av flera lämningar ger alla), UUID eller K-samsök-URI. Grundposten kommer ur serverns eget index; saknas den där, eller är indexet otillgängligt, hämtas den från Fornsök-appen med K-samsök som reserv. " +
				"`inkludera` lägger till geometri, referenser, dokument (med dokument_ref till hamta_dokument) och versionshistorik." + EXTERN_TEXT,
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
	for (const key of ["relaterat"]) if (inkludera.has(key as (typeof INKLUDERA)[number])) anmarkningar.push(SENARE[key]);

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

	// Indexet först (SPEC 6: grundposten ur D1); levande källor för det som saknas där, och som reserv.
	let ix: OpenIndex | null = null;
	let reservOrsak: string | null = null;
	if (deps.index) {
		const o = await deps.index.open();
		if (o.ok) ix = o;
		else reservOrsak = o.orsak;
	} else reservOrsak = "indexet är inte inkopplat";
	const indexFel = (err: unknown) => {
		if (err instanceof IndexInputError) throw new ToolInputError(err.message);
		deps.index?.reportFailure(err);
		ix = null;
		reservOrsak = "indexanropet misslyckades";
	};

	// Nummer → UUID. Ett RAÄ-nummer kan delas av flera lämningar.
	const numbers = [...new Set(parsed.filter((p) => p.kind !== "uuid").map((p) => (p as { value: string }).value))];
	const resolved = new Map<string, string[]>();
	if (numbers.length && ix) {
		try {
			for (const [k, v] of await (ix as OpenIndex).store.resolveIdsAll(numbers)) resolved.set(k, v);
		} catch (err) {
			indexFel(err);
		}
	}
	const viaLive = numbers.filter((n) => !resolved.has(n));
	if (viaLive.length) for (const [k, v] of await deps.ids.resolveNumbers(viaLive)) resolved.set(k, [v]);

	const wanted: Array<{ id: string; uuid: string }> = [];
	for (const p of parsed) {
		if (p.kind === "uuid") {
			wanted.push({ id: p.input, uuid: p.uuid });
			continue;
		}
		const uuids = resolved.get(p.value) ?? [];
		if (!uuids.length) {
			ej_hittade.push({
				id: p.input,
				orsak: `Inget ${p.kind === "lamningsnummer" ? "lämningsnummer" : "RAÄ-nummer"} "${p.value}" hittades ${ix ? "i indexet eller i K-samsök" : "i K-samsök (som ligger några dagar efter registret)"}.`,
			});
			continue;
		}
		if (uuids.length > 1) {
			anmarkningar.push(
				`RAÄ-numret "${p.value}" är flertydigt: det delas av ${uuids.length} lämningar. ${uuids.length > MAX_IDS ? `De ${MAX_IDS} första visas.` : "Alla visas."} Ange lämningsnummer för att välja en.`,
			);
		}
		for (const uuid of uuids) wanted.push({ id: p.input, uuid });
	}
	const firstIdFor = new Map<string, string>();
	const unique: Array<{ id: string; uuid: string }> = [];
	for (const w of wanted) {
		const first = firstIdFor.get(w.uuid);
		if (first === undefined) {
			firstIdFor.set(w.uuid, w.id);
			unique.push(w);
		} else if (first !== w.id) {
			anmarkningar.push(`"${w.id}" och "${first}" avser samma lämning; den visas en gång.`);
		}
	}
	if (unique.length > MAX_IDS) {
		anmarkningar.push(`Högst ${MAX_IDS} lämningar per anrop; ${unique.length - MAX_IDS} till ströks (${unique.slice(MAX_IDS).map((u) => u.id).join(", ")}).`);
		unique.length = MAX_IDS;
	}

	// Grundposter ur indexet i ett anrop.
	let fromIndex = new Map<string, RecordFetchResult>();
	if (ix && unique.length) {
		try {
			fromIndex = await (ix as OpenIndex).store.getByUuids(unique.map((u) => u.uuid));
		} catch (err) {
			indexFel(err);
		}
	}
	const openIx = ix as OpenIndex | null;
	if (!openIx) anmarkningar.push(`Reservläge: ${reservOrsak}. Posterna hämtades från RAÄ:s levande källor.`);

	const results = await Promise.all(
		unique.map(async (w) => {
			const hit = fromIndex.get(w.uuid);
			if (hit && openIx) {
				hit.post.hamtad_fran = openIx.hamtad_fran;
				const extra = await fetchExtras(w.uuid, inkludera, deps, true);
				return { r: { result: hit, notes: [] as string[] }, extra, index: true };
			}
			const r = await fetchWithFallback(w.uuid, deps);
			if (r.result) {
				if (openIx) r.notes.push(`${r.result.post.lamningsnummer ?? w.uuid}: finns inte i indexet; hämtad från levande källa.`);
				else r.result.post.hamtad_fran = `${r.result.post.hamtad_fran} – reservläge`;
			}
			const extra = r.result ? await fetchExtras(w.uuid, inkludera, deps, false) : null;
			return { r, extra, index: false };
		}),
	);
	const lamningar: LamningPost[] = [];
	results.forEach(({ r, extra, index }, i) => {
		if (r.notes.length) anmarkningar.push(...r.notes);
		if (!r.result) {
			ej_hittade.push({ id: unique[i].id, orsak: r.error ?? "Lämningen hittades inte." });
			return;
		}
		const post = withIncludes(r.result, inkludera);
		// Indexposter har inga referenser; utan lyckad hämtning ska delen saknas, inte se tom ut.
		if (index) {
			if (extra?.referenser) post.referenser = extra.referenser;
			else delete post.referenser;
		}
		if (extra?.dokument) post.dokument = extra.dokument;
		if (extra?.historik) post.historik = extra.historik;
		for (const n of extra?.notes ?? []) anmarkningar.push(`${post.lamningsnummer ?? post.uuid}: ${n}`);
		lamningar.push(post);
	});

	if (lamningar.length === 0 && ej_hittade.length > 0 && parsed.length === 0) {
		throw new ToolInputError(ej_hittade.map((e) => e.orsak).join(" "));
	}

	const structured = { lamningar, ej_hittade, anmarkningar, reservlage: !openIx };
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
			if (err instanceof UpstreamError) errors.push(`${SOURCE_NAMES[err.source]}: ${err.message}`);
			else {
				// Detaljen (t.ex. en adress som stoppats av listan över tillåtna anrop) loggas, men visas inte.
				console.error(`lamning: oväntat fel från ${name}:`, err);
				errors.push(`${name}: internt fel`);
			}
		}
	}
	return { result: null, notes, error: `Lämningen ${uuid} kunde inte hämtas (${errors.join("; ")}).` };
}

/**
 * Dokument och historik från Fornsök-appen. Om appen inte svarar levereras
 * posten ändå och delen rapporteras som ej hämtad (SPEC 8).
 */
async function fetchExtras(
	uuid: string,
	inkludera: Set<string>,
	deps: ToolDeps,
	referenserLive: boolean,
): Promise<{ referenser?: Referenser; dokument?: DokumentPost[]; historik?: Version[]; notes: string[] }> {
	const notes: string[] = [];
	const out: { referenser?: Referenser; dokument?: DokumentPost[]; historik?: Version[]; notes: string[] } = { notes };
	const why = (err: unknown) => (err instanceof UpstreamError ? err.message : "oväntat fel");
	await Promise.all([
		// Referenser finns inte i indexet (GeoPackage-filen saknar dem): hämtas från de levande postkällorna.
		referenserLive && inkludera.has("referenser")
			? fetchWithFallback(uuid, deps).then((r) => {
					if (r.result) out.referenser = r.result.referenser;
					else notes.push(`referenser kunde inte hämtas (${r.error ?? "okänt fel"}).`);
				})
			: null,
		inkludera.has("dokument")
			? deps.documents
					.listDokument(uuid)
					.then((l) => {
						out.dokument = l.dokument.map((d) => toDokumentPost(uuid, d));
					})
					.catch((err) => {
						if (!(err instanceof UpstreamError)) console.error("dokument:", err);
						notes.push(`dokument kunde inte hämtas (${why(err)}).`);
					})
			: null,
		inkludera.has("historik")
			? deps.history
					.getVersioner(uuid)
					.then((v) => {
						if (v) out.historik = v;
						else notes.push("versionshistorik saknas i Fornsök-appen.");
					})
					.catch((err) => {
						if (!(err instanceof UpstreamError)) console.error("historik:", err);
						notes.push(`historik kunde inte hämtas (${why(err)}).`);
					})
			: null,
	]);
	return out;
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
			// Indexets geometri kan redan vara förenklad vid inläsningen (geometri_forenklad i posten).
			post.geometri_forenklad = !!r.post.geometri_forenklad || (s.tolerance > 0 && countPositions(planar) < before);
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
		`Antikvarisk bedömning (registrets): ${rad(l.antikvarisk_bedomning.varde) || "saknas"}${l.antikvarisk_bedomning.motivering ? ` – motivering (källtext): ${citat(l.antikvarisk_bedomning.motivering)}` : ""}`,
	);
	lines.push(`Indelning: ${list([list(l.indelning.lan), list(l.indelning.kommun), list(l.indelning.socken)])}${l.indelning.landskap.length ? `; landskap ${list(l.indelning.landskap)}` : ""}`);
	const osak = l.lage.osakerhet_m !== null ? `, lägesosäkerhet ${l.lage.osakerhet_m} m` : "";
	const sw = l.lage.sweref99tm ? ` (SWEREF 99 TM N ${l.lage.sweref99tm.n}, E ${l.lage.sweref99tm.e})` : "";
	lines.push(`Läge: ${fmtCoord(l.lage.lat, l.lage.lon)}${sw}${osak}${l.lage.geometrityp ? `, geometri ${l.lage.geometrityp}` : ""}`);
	if (l.namn?.length) lines.push(`Namn (källtext): ${l.namn.map(citat).join(", ")}`);
	const statusar = list([l.statusar.aktualitet, l.statusar.placering, l.statusar.skada ? `skada: ${l.statusar.skada}` : null, l.statusar.undersokning ? `undersökning: ${l.statusar.undersokning}` : null]);
	if (statusar) lines.push(`Status: ${statusar}`);
	const kt = (label: string, v: string | null | undefined) => {
		const t = stripBoilerplate(v ?? null);
		if (t) lines.push(`${label} (källtext): ${citat(t)}`);
	};
	kt("Beskrivning", l.beskrivning);
	kt("Tradition", l.tradition);
	kt("Terräng", l.terrang);
	kt("Orientering", l.orientering);
	kt("Antikvarisk kommentar", l.antikvarisk_kommentar);
	if (l.egenskaper.length) lines.push(`Egenskaper (källtext): ${l.egenskaper.map((e) => `${rad(e.typ)}: ${citat(e.varde)}`).join("; ")}`);
	if (l.ingaende_lamningar.length) {
		lines.push(
			`Ingående lämningar (källtext): ${l.ingaende_lamningar
				.map((i) => `${rad(i.lamningstyp)}${i.antal !== null ? ` ×${i.antal}` : ""}${i.egenskaper.length ? ` (${i.egenskaper.map((e) => `${rad(e.typ)}: ${citat(e.varde)}`).join(", ")})` : ""}`)
				.join("; ")}`,
		);
	}
	if (l.referenser) {
		const r = l.referenser;
		if (r.skriftliga_kallor.length) lines.push(`Skriftliga källor (källtext): ${r.skriftliga_kallor.map(citat).join(" | ")}`);
		if (r.kartmaterial.length) lines.push(`Kartmaterial (källtext): ${r.kartmaterial.map(citat).join(" | ")}`);
		if (r.uppgiftslamnare.length) lines.push(`Uppgiftslämnare (källtext): ${r.uppgiftslamnare.map(citat).join(" | ")}`);
		if (!r.skriftliga_kallor.length && !r.kartmaterial.length && !r.uppgiftslamnare.length) lines.push("Referenser: inga i registret.");
	}
	if (l.geometri !== undefined) {
		lines.push(
			l.geometri
				? `Geometri: GeoJSON i structuredContent (WGS 84)${l.geometri_forenklad ? ", förenklad till högst 500 brytpunkter" : ""}.`
				: "Geometri: saknas.",
		);
	}
	if (l.dokument) {
		if (l.dokument.length === 0) lines.push("Dokument: inga registrerade.");
		else {
			lines.push(`Dokument (${l.dokument.length}; hämta med hamta_dokument):`);
			for (const d of l.dokument) lines.push(formatDokumentRad(d));
		}
	}
	if (l.historik) {
		lines.push(`Versionshistorik (${l.historik.length === 1 ? "1 publicerad version" : `${l.historik.length} publicerade versioner, nyast först`}):`);
		for (const v of l.historik) lines.push(formatVersion(v));
	}
	lines.push(`Källa: ${l.kalla}; hämtad från ${l.hamtad_fran}.`);
	return lines.join("\n");
}

function formatVersion(v: Version): string {
	const a = v.aktivitet;
	const akt = a
		? [rad(a.typ), rad(a.nummer), a.atgardstyp ? `(${rad(a.atgardstyp)})` : null, a.beskrivning && a.beskrivning !== a.atgardstyp ? `– ${citat(a.beskrivning)}` : null]
				.filter(Boolean)
				.join(" ")
		: "aktivitet okänd";
	return `- ${v.publicerad ? rad(v.publicerad.slice(0, 10)) : "okänt datum"}: ${rad(v.registrerare) || "okänd registrerare"}; ${akt}${a?.registrerad ? `, registrerad ${a.registrerad.slice(0, 10)}` : ""}`;
}
