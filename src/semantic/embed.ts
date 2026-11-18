/**
 * Grundinbäddning och ombäddning (SPEC 5.2, 5.3). Återupptagbar: varje körning
 * tar högst `max` lämningar och gör i tur och ordning
 *
 * 1. kön `inbaddning_ko` (lämningar som nattsynken ändrat eller tagit bort),
 * 2. lämningar inom omfånget som saknar inbäddning eller vars rad ändrats
 *    sedan dess (`inbaddning.rad_hash` ≠ `lamning.hash`, t.ex. efter
 *    avstämningen i ingest/) eller som bäddats in med en annan modell,
 * 3. inbäddningar för lämningar som utgått eller lämnat omfånget (vektorerna
 *    tas bort).
 *
 * Fel i Workers AI: se beslutsregeln överst i runEmbedBatch. Kort: ett fel
 * bokförs som textens (i inbaddning_fel, med belägget i senaste_fel) bara när
 * texten fallerat ensam två gånger och en verklig text ur omfånget lyckats
 * efter det i samma körning, eller när felet entydigt gäller indata
 * (arIndatafel). Kontrolltexten (KONTROLLTEXT) räknas aldrig som belägg. Utan
 * belägg är det ett avbrott: inget bokförs, inget försök förbrukas och
 * omfånget räknas inte som klart. Efter MAX_FEL_PER_POST försök med samma
 * radhash hoppas lämningen över i OMPROVNING_DYGN dygn och prövas sedan igen
 * (ett försök i taget).
 *
 * För varje lämning byggs texten (text.ts) och metadata (filter.ts); är de
 * oförändrade (`innehall_hash`) bäddas inget in, bara `rad_hash` uppdateras.
 * Vektorerna skrivs till Vectorize före bokföringen i D1, så ett avbrott ger
 * på sin höjd en onödig ombäddning nästa gång (upsert är idempotent).
 */
import type { D1Like, D1LikeStatement } from "../store/d1";
import {
	type AiLike,
	MODELL,
	type SemanticEnv,
	type VectorizeLike,
	vektorerUrSvar,
} from "./bindings";
import { type LamningsMeta, varianter, vektorId } from "./filter";
import { checkedScope, parseScope, type Scope } from "./scope";
import { inbaddningstext } from "./text";

/** Texter per anrop till Workers AI. 50 × högst 512 token ryms med god marginal i modellens 60 000. */
export const AI_BATCH = 50;
/** Vektorer per upsert (Workers-gränsen är 1 000). */
export const UPSERT_BATCH = 500;
export const STANDARD_MAX = 1000;
/** Så många försök med samma radhash innan en lämning hoppas över. */
export const MAX_FEL_PER_POST = 3;
/**
 * Så många misslyckade anrop till Workers AI i följd, utan att någon verklig
 * text lyckats emellan, innan körningen ger upp (delvis avbrott, eller avbrott
 * mitt i körningen). Räcker för att halveringen ska nå en frisk halva i en del
 * med en eller några få texter som modellen avvisar.
 */
export const MAX_AI_FEL_I_FOLJD = 8;
/** Övre gräns för misslyckade anrop i en körning även när andra anrop lyckats (skyddar kvoten). */
export const MAX_AI_FEL_TOTALT = 48;
/** Så många obekräftade fel i andra försöket innan referenstexten prövas (och bekräftar dem). */
const BEKRAFTA_EFTER = 4;
/** En överhoppad lämning prövas igen efter så många dygn, även om raden inte ändrats. */
export const OMPROVNING_DYGN = 7;
/**
 * Prefix i inbaddning_fel.senaste_fel som anger varför felet räknades som
 * textens. Formuleringen för okända fel ändrades när kontrolltexten slutade
 * räknas som belägg; rader med den gamla formuleringen ("annan text i
 * körningen lyckades") rensas därför en gång (RENSNING_VERSION 2).
 */
export const BELAGG_ANNAN_LYCKADES = "belägg: fallerade ensam två gånger, och en annan verklig text lyckades efter det; ";
export const BELAGG_TILLFALLIGT = "belägg: tillfälligt fel för texten ensam två gånger, och en annan verklig text lyckades efter det (prövas en gång per dygn); ";
export const BELAGG_INDATAFEL = "belägg: indatafel; ";
/**
 * Kontrolltext som prövas när ett anrop fallerar innan något lyckats i
 * körningen och ingen inbäddad lämning finns att pröva i stället. Fallerar den
 * är tjänsten nere; går den igenom säger det bara att korta anrop fungerar –
 * det är aldrig belägg för att felet ligger i en text.
 */
export const KONTROLLTEXT = "Fornlämning. Röse av sten.";
/** Engångsrensningen av överhoppningar utan giltigt belägg (bokförda före BELAGG_* eller med den gamla formuleringen). */
const RENSNING_NYCKEL = "inbaddning_fel_rensad";
const RENSNING_VERSION = "2";
/** Höjs när logiken för vad som räknas som klart ändras, så att omfånget gås igenom igen. */
const KLAR_VERSION = 2;

/**
 * Felkoder i Workers AI som betyder att tjänsten (inte texten) är problemet
 * (developers.cloudflare.com/workers-ai/platform/errors/, läst 2026-11-18):
 * 3007 Timeout (408), 3008 Aborted (408), 3036 dagskvoten slut (429),
 * 3040 Out of capacity (429). Övriga koder (t.ex. 3006 Request too large,
 * 5004 Invalid data) gäller anropet eller texten.
 */
export const TILLFALLIGA_AI_KODER = new Set(["3007", "3008", "3036", "3040"]);
/** HTTP-statusar med standardfras, så som de står i felmeddelanden ("502 Bad Gateway"). */
const HTTP_FRAS = /(?:^|[\s:(])(429 Too Many Requests|500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out)(?:$|[\s.,;)])/i;
/** Workers AI:s felkod först i meddelandet eller efter feltypen: "3040: …", "AiError: 3040: …". */
const AI_KOD = /(?:^|:\s*)(\d{4})\s*:/;

/**
 * Tillfälligt fel i Workers AI – troligen inte fel på texten. En ensam text
 * som ger ett sådant fel medan andra texter går igenom prövas därför bara en
 * gång per dygn och hoppas över först efter MAX_FEL_PER_POST försök på olika
 * dygn (se beslutsregeln i runEmbedBatch). Avgörs bara på HTTP-status (fältet `status`, eller status med
 * standardfras i meddelandet), kända felkoder (TILLFALLIGA_AI_KODER) och kända
 * feltyper (TimeoutError, AbortError, Workers "Network connection lost.").
 * Allt annat – även okända fel – räknas som fel på texten, så att halveringen
 * kan isolera en text som modellen avvisar (granskningen av b327106, punkt 2:
 * "Input text exceeds 512 tokens" och "got 500 characters" matchade tidigare
 * det breda mönstret och blev aldrig isolerade).
 */
export function arTillfalligtAiFel(e: unknown): boolean {
	const st = (e as { status?: unknown } | null)?.status;
	if (typeof st === "number") return st === 429 || st === 408 || st >= 500;
	if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return true;
	const msg = e instanceof Error ? e.message : String(e);
	const kod = AI_KOD.exec(msg)?.[1];
	if (kod) return TILLFALLIGA_AI_KODER.has(kod);
	if (/^Network connection lost\.?$/i.test(msg.trim())) return true;
	return HTTP_FRAS.test(msg);
}

/**
 * Workers AI:s felkoder och HTTP-statusar som entydigt gäller indata, oavsett
 * om andra texter lyckats: 3006 Request too large (413). Ett anrop med en enda
 * text som är för stort beror bara på texten. 5004 Invalid data och 400 räknas
 * inte hit: de kan lika gärna gälla anropets form (t.ex. en ändrad modell) och
 * skulle då förbruka försök för alla texter.
 */
export const INDATA_AI_KODER = new Set(["3006"]);

/** Fel som entydigt gäller texten i anropet (se INDATA_AI_KODER). */
export function arIndatafel(e: unknown): boolean {
	const st = (e as { status?: unknown } | null)?.status;
	if (typeof st === "number") return st === 413;
	const msg = e instanceof Error ? e.message : String(e);
	const kod = AI_KOD.exec(msg)?.[1];
	if (kod) return INDATA_AI_KODER.has(kod);
	return /(?:^|[\s:(])413 (?:Payload|Request Entity) Too Large\b/i.test(msg);
}

export interface EmbedResult {
	/** Lämningar som bäddades in (nya eller ändrade). */
	inbaddade: number;
	/** Vektorer som skrevs. */
	vektorer: number;
	/** Oförändrad text och metadata: bara bokföringen uppdaterades. */
	oforandrade: number;
	/** Utan meningsfull text (ingen vektor). */
	tomma: number;
	/** Lämningar vars vektorer togs bort (utgått eller utanför omfånget). */
	borttagna: number;
	/** true när inget återstod efter körningen (inom `max`). */
	klar: boolean;
	/** Lämningar vars inbäddning fallerade i körningen (bokförda i inbaddning_fel). */
	fel?: number;
	/**
	 * Texter som fallerade men inte bokfördes, eftersom felet inte kunde knytas
	 * till texten (tjänsten slutade svara för verkliga texter i slutet av
	 * körningen); prövas nästa körning utan att något försök förbrukats.
	 */
	tillfalliga_fel?: number;
	omfang: string[];
}

type Row = Record<string, unknown>;

async function rows<T = Row>(db: D1Like, sql: string, ...params: unknown[]): Promise<T[]> {
	const s = db.prepare(sql);
	return ((await (params.length ? s.bind(...params) : s).all<T>()).results ?? []) as T[];
}

const SCOPE_IDS =
	"SELECT lo.lamning_id FROM lamning_omrade lo JOIN omrade o ON o.id = lo.omrade_id WHERE o.niva = 'lan' AND o.namn IN (SELECT value FROM json_each(?))";

async function sha(s: string): Promise<string> {
	const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(b)]
		.map((x) => x.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 32);
}

interface LamningData {
	uuid: string;
	lamningsnummer: string | null;
	lamningstyp: string | null;
	bedomning: string | null;
	namn: string | null;
	beskrivning: string | null;
	tradition: string | null;
	terrang: string | null;
	hash: string;
	omr: string | null;
	i_omfang: number;
}

interface Bokford {
	uuid: string;
	innehall_hash: string;
	vektorer: number;
	status: string;
	modell: string;
}

function areas(omr: string | null): Record<"lan" | "kommun" | "socken" | "landskap", string[]> {
	const out = {
		lan: [] as string[],
		kommun: [] as string[],
		socken: [] as string[],
		landskap: [] as string[],
	};
	let list: unknown = [];
	try {
		list = omr ? JSON.parse(omr) : [];
	} catch {
		list = [];
	}
	for (const x of Array.isArray(list) ? list : []) {
		if (typeof x !== "string") continue;
		const i = x.indexOf("|");
		const niva = x.slice(0, i) as keyof typeof out;
		const namn = x.slice(i + 1);
		if (niva in out && namn && !out[niva].includes(namn)) out[niva].push(namn);
	}
	for (const k of Object.keys(out) as Array<keyof typeof out>)
		out[k].sort((a, b) => a.localeCompare(b, "sv"));
	return out;
}

/** Ta bort vektorer uuid, uuid#1 … uuid#(n−1). */
function idsFor(uuid: string, from: number, to: number): string[] {
	const out: string[] = [];
	for (let i = from; i < to; i++) out.push(vektorId(uuid, i));
	return out;
}

/**
 * Beslutsregel för fel i Workers AI (en körning). "Verklig text" är en
 * lämnings text ur omfånget – en i körningen, eller referenstexten: en redan
 * inbäddad lämning. Kontrolltexten är aldrig belägg.
 *
 * 1. Fallerar ett anrop med flera texter delas det i två halvor, som läggs
 *    sist i kön, oavsett feltyp. Andra delar prövas först, friska texter
 *    kommer igenom, och en text som fallerar isoleras.
 * 2. En ensam text med ett entydigt indatafel (arIndatafel) bokförs direkt.
 * 3. En ensam text som fallerar av annat skäl prövas en gång till när kön är
 *    tom. Fallerar den igen bokförs felet först när en verklig text lyckas
 *    efter det (en annan text i andra försöket, eller referenstexten).
 *    Okänt fel: BELAGG_ANNAN_LYCKADES. "Tillfälligt" fel (arTillfalligtAiFel):
 *    BELAGG_TILLFALLIGT, och texten prövas sedan inte igen samma dygn – den
 *    hoppas alltså över först efter MAX_FEL_PER_POST försök på olika dygn.
 *    Efter MAX_FEL_PER_POST försök hoppas lämningen över i OMPROVNING_DYGN dygn.
 * 4. Avbrott – det som saknar belägg bokförs inte, inget försök förbrukas,
 *    omfånget blir inte klart:
 *    a. första felet innan någon verklig text lyckats: referenstexten prövas
 *       (finns ingen: kontrolltexten); fallerar den avbryts körningen direkt;
 *    b. MAX_AI_FEL_I_FOLJD fel i följd utan att en verklig text lyckats
 *       (bara kontrolltexten går igenom, eller tjänsten går ned mitt i
 *       körningen): körningen avbryts;
 *    c. ingen verklig text lyckades i hela körningen: körningen avbryts;
 *    d. referenstexten fallerar i andra försöket: felen därifrån bokförs inte
 *       (tillfalliga_fel), resten av körningen står sig;
 *    e. MAX_AI_FEL_TOTALT fel i körningen: avbryts (skyddar kvoten).
 *    Avbrott kastar ett fel med "avbrott" i meddelandet (utom d).
 */
export async function runEmbedBatch(
	env: SemanticEnv,
	opts: { max?: number; now?: Date } = {},
): Promise<EmbedResult> {
	const db = env.DB;
	const ai = env.AI;
	const vec = env.VECTORIZE;
	if (!db || !ai || !vec)
		throw new Error("runEmbedBatch: bindningarna DB, AI och VECTORIZE behövs");
	let scope: Scope;
	try {
		scope = checkedScope(env.SEMANTIC_LAN);
	} catch (e) {
		// Tomt eller felstavat omfång: rör ingenting (annars räknas allt som utanför och tas bort).
		console.error(`inbäddning: ${e instanceof Error ? e.message : String(e)}`);
		throw e;
	}
	const max = Math.max(1, Math.min(10_000, opts.max ?? STANDARD_MAX));
	const nu = opts.now ?? new Date();
	const tid = nu.toISOString();
	/** Överhoppningar bokförda före denna tid prövas igen. */
	const omprovas = new Date(nu.getTime() - OMPROVNING_DYGN * 86_400_000).toISOString();
	/** Dygnets början (UTC): en text med BELAGG_TILLFALLIGT bokförd efter detta vilar till nästa dygn. */
	const dygnet = `${tid.slice(0, 10)}T00:00:00.000Z`;
	const tillfalligtPrefix = `${BELAGG_TILLFALLIGT}%`;
	const scopeJson = JSON.stringify(scope.lan);
	const res: EmbedResult = {
		inbaddade: 0,
		vektorer: 0,
		oforandrade: 0,
		tomma: 0,
		borttagna: 0,
		klar: false,
		omfang: scope.lan,
	};

	// ------------------------------------------------ klart sedan sist?
	// När omfånget är färdiginbäddat och inget har ändrats (ingen ny grundladdning
	// eller avstämning, samma omfång och modell, tom kö) behövs inga genomsökningar
	// av hela omfånget; nattsynkens ändringar kommer via inbaddning_ko.
	const st = await rows<{ nyckel: string; varde: string | null }>(
		db,
		`SELECT nyckel, varde FROM synk_status WHERE nyckel IN ('senaste_grundladdning', 'senaste_avstamning', 'inbaddning_klar', '${RENSNING_NYCKEL}')`,
	);
	const stv = new Map(st.map((r) => [r.nyckel, r.varde]));
	if (stv.get(RENSNING_NYCKEL) !== RENSNING_VERSION) {
		await rensaOverhoppningarUtanBelagg(db, tid);
		stv.delete("inbaddning_klar");
	}
	const signatur = JSON.stringify({ v: KLAR_VERSION, g: stv.get("senaste_grundladdning") ?? null, a: stv.get("senaste_avstamning") ?? null, omfang: scope.lan, modell: MODELL });
	const [ko0] = await rows<{ n: number }>(db, "SELECT count(*) AS n FROM inbaddning_ko");
	if (Number(ko0?.n ?? 0) === 0 && stv.get("inbaddning_klar") === signatur) {
		// Klart, utom överhoppade lämningar vars väntetid gått ut, och texter med tillfälligt
		// fel som vilat sedan ett tidigare dygn: de söks fram nedan.
		const [due] = await rows<{ n: number }>(
			db,
			`SELECT count(*) AS n FROM (SELECT 1 FROM inbaddning_fel f JOIN lamning l ON l.uuid = f.uuid AND l.hash = f.rad_hash
			  WHERE ((f.forsok >= ? AND f.andrad <= ?) OR (f.forsok < ? AND f.senaste_fel LIKE ? AND f.andrad < ?)) AND l.id IN (${SCOPE_IDS})
			    AND NOT EXISTS (SELECT 1 FROM inbaddning i WHERE i.uuid = f.uuid AND i.rad_hash = f.rad_hash AND i.modell = ?) LIMIT 1)`,
			MAX_FEL_PER_POST,
			omprovas,
			MAX_FEL_PER_POST,
			tillfalligtPrefix,
			dygnet,
			scopeJson,
			MODELL,
		);
		if (Number(due?.n ?? 0) === 0) {
			res.klar = true;
			return res;
		}
	}

	// ------------------------------------------------ arbetslista
	const arbete = new Set<string>();
	for (const r of await rows<{ uuid: string }>(
		db,
		"SELECT uuid FROM inbaddning_ko ORDER BY lagd, uuid LIMIT ?",
		max,
	))
		arbete.add(r.uuid);
	let nyaKvar = false;
	if (arbete.size < max) {
		const limit = max - arbete.size;
		const nya = await rows<{ uuid: string }>(
			db,
			`SELECT l.uuid FROM lamning l
			  WHERE l.id IN (${SCOPE_IDS})
			    AND NOT EXISTS (SELECT 1 FROM inbaddning i WHERE i.uuid = l.uuid AND i.rad_hash = l.hash AND i.modell = ?)
			    AND NOT EXISTS (SELECT 1 FROM inbaddning_fel f WHERE f.uuid = l.uuid AND f.rad_hash = l.hash
			                    AND ((f.forsok >= ? AND f.andrad > ?) OR (f.senaste_fel LIKE ? AND f.andrad >= ?)))
			  ORDER BY l.id LIMIT ?`,
			scopeJson,
			MODELL,
			MAX_FEL_PER_POST,
			omprovas,
			tillfalligtPrefix,
			dygnet,
			limit + 1,
		);
		nyaKvar = nya.length > limit;
		for (const r of nya.slice(0, limit)) arbete.add(r.uuid);
	}
	let gamlaKvar = false;
	if (arbete.size < max) {
		const limit = max - arbete.size;
		const gamla = await rows<{ uuid: string }>(
			db,
			`SELECT i.uuid FROM inbaddning i LEFT JOIN lamning l ON l.uuid = i.uuid
			  WHERE l.id IS NULL OR l.id NOT IN (${SCOPE_IDS})
			  ORDER BY i.uuid LIMIT ?`,
			scopeJson,
			limit + 1,
		);
		gamlaKvar = gamla.length > limit;
		for (const r of gamla.slice(0, limit)) arbete.add(r.uuid);
	}
	if (arbete.size === 0) {
		res.klar = true;
		await markeraKlar(db, signatur, tid);
		return res;
	}

	// ------------------------------------------------ läs data
	const lista = JSON.stringify([...arbete]);
	const data = new Map<string, LamningData>();
	for (const r of await rows<LamningData>(
		db,
		`SELECT l.uuid, l.lamningsnummer, l.lamningstyp, l.bedomning, l.namn, l.beskrivning, l.tradition, l.terrang, l.hash,
		        (SELECT json_group_array(o.niva || '|' || o.namn) FROM lamning_omrade lo JOIN omrade o ON o.id = lo.omrade_id WHERE lo.lamning_id = l.id) AS omr,
		        CASE WHEN l.id IN (${SCOPE_IDS}) THEN 1 ELSE 0 END AS i_omfang
		   FROM lamning l WHERE l.uuid IN (SELECT value FROM json_each(?))`,
		scopeJson,
		lista,
	))
		data.set(r.uuid, r);
	const felade = new Map<string, { rad_hash: string; forsok: number; senaste_fel: string | null; andrad: string }>();
	for (const r of await rows<{ uuid: string; rad_hash: string; forsok: number; senaste_fel: string | null; andrad: string }>(
		db,
		"SELECT uuid, rad_hash, forsok, senaste_fel, andrad FROM inbaddning_fel WHERE uuid IN (SELECT value FROM json_each(?))",
		lista,
	))
		felade.set(r.uuid, r);
	const bokford = new Map<string, Bokford>();
	for (const r of await rows<Bokford>(
		db,
		"SELECT uuid, innehall_hash, vektorer, status, modell FROM inbaddning WHERE uuid IN (SELECT value FROM json_each(?))",
		lista,
	))
		bokford.set(r.uuid, r);

	// ------------------------------------------------ klassificera
	const taBortIds: string[] = [];
	const bokforing: D1LikeStatement[] = [];
	const ur = (uuid: string) => db.prepare("DELETE FROM inbaddning_ko WHERE uuid = ?").bind(uuid);
	const spara = (
		uuid: string,
		radHash: string,
		innehall: string,
		vektorer: number,
		status: "ok" | "tom",
	) =>
		db
			.prepare(
				`INSERT INTO inbaddning (uuid, rad_hash, innehall_hash, vektorer, status, modell, andrad) VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(uuid) DO UPDATE SET rad_hash = excluded.rad_hash, innehall_hash = excluded.innehall_hash,
				 vektorer = excluded.vektorer, status = excluded.status, modell = excluded.modell, andrad = excluded.andrad`,
			)
			.bind(uuid, radHash, innehall, vektorer, status, MODELL, tid);

	interface Jobb {
		uuid: string;
		text: string;
		meta: ReturnType<typeof varianter>;
		radHash: string;
		innehall: string;
		tidigare: number;
	}
	const jobb: Jobb[] = [];

	for (const uuid of arbete) {
		const d = data.get(uuid);
		const b = bokford.get(uuid);
		if (!d || !d.i_omfang) {
			if (b && b.vektorer > 0) taBortIds.push(...idsFor(uuid, 0, b.vektorer));
			if (b) bokforing.push(db.prepare("DELETE FROM inbaddning WHERE uuid = ?").bind(uuid));
			bokforing.push(ur(uuid));
			if (b) res.borttagna++;
			continue;
		}
		const text = inbaddningstext(d);
		if (!text) {
			if (b && b.vektorer > 0) taBortIds.push(...idsFor(uuid, 0, b.vektorer));
			bokforing.push(spara(uuid, d.hash, "tom", 0, "tom"), ur(uuid));
			res.tomma++;
			continue;
		}
		const a = areas(d.omr);
		const lm: LamningsMeta = {
			uuid,
			lamningsnummer: d.lamningsnummer,
			typ: d.lamningstyp,
			bedomning: d.bedomning,
			...a,
		};
		const meta = varianter(lm);
		const innehall = await sha(JSON.stringify({ m: MODELL, text, meta }));
		if (
			b &&
			b.status === "ok" &&
			b.modell === MODELL &&
			b.innehall_hash === innehall &&
			b.vektorer === meta.length
		) {
			bokforing.push(spara(uuid, d.hash, innehall, b.vektorer, "ok"), ur(uuid));
			res.oforandrade++;
			continue;
		}
		const f = felade.get(uuid);
		if (f && f.rad_hash === d.hash && f.forsok >= MAX_FEL_PER_POST && f.andrad > omprovas) {
			// Har fallerat för många gånger med samma text: hoppa över (och ta ur kön) tills raden
			// ändras eller OMPROVNING_DYGN dygn gått sedan senaste försöket.
			console.warn(`inbäddning: ${uuid} hoppas över efter ${f.forsok} misslyckade försök (${f.senaste_fel ?? "okänt fel"})`);
			bokforing.push(ur(uuid));
			continue;
		}
		if (f && f.rad_hash === d.hash && f.senaste_fel?.startsWith(BELAGG_TILLFALLIGT) && f.andrad >= dygnet) {
			// Tillfälligt fel för texten ensam i dag: prövas igen nästa dygn (genomsökningen hittar den).
			bokforing.push(ur(uuid));
			continue;
		}
		jobb.push({ uuid, text, meta, radHash: d.hash, innehall, tidigare: b?.vektorer ?? 0 });
	}

	// ------------------------------------------------ borttagningar och bokföring utan inbäddning
	for (let i = 0; i < taBortIds.length; i += 1000)
		await vec.deleteByIds(taBortIds.slice(i, i + 1000));
	for (let i = 0; i < bokforing.length; i += 50) await db.batch(bokforing.slice(i, i + 50));

	// ------------------------------------------------ inbäddning (beslutsregeln: se överst i funktionen)
	let aiFel = 0;
	/** Misslyckade anrop sedan en verklig text senast lyckades (kontrolltexten räknas inte). */
	let iFoljd = 0;
	/** Lyckade anrop med verkliga texter ur omfånget (körningens texter eller referenstexten). */
	let verkligaLyckade = 0;
	let kontrollGickIgenom = false;
	let provat = false;
	/** En verklig text som gått igenom: i körningen, eller ur inbaddning (undefined = inte sökt än). */
	let referens: string | null | undefined;
	const felSatser: D1LikeStatement[] = [];
	const bokforFel = (j: Jobb, belagg: string, msg: string) => {
		felSatser.push(
			db
				.prepare(
					"INSERT INTO inbaddning_fel (uuid, rad_hash, forsok, senaste_fel, andrad) VALUES (?, ?, 1, ?, ?) ON CONFLICT(uuid) DO UPDATE SET forsok = CASE WHEN inbaddning_fel.rad_hash = excluded.rad_hash THEN inbaddning_fel.forsok + 1 ELSE 1 END, rad_hash = excluded.rad_hash, senaste_fel = excluded.senaste_fel, andrad = excluded.andrad",
				)
				.bind(j.uuid, j.radHash, (belagg + msg).slice(0, 500), tid),
		);
		res.fel = (res.fel ?? 0) + 1;
	};
	const kort = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
	const avbrott = (orsak: string, e: unknown) => {
		const fel = new Error(`${orsak}; inget bokfört, inget försök förbrukat (senaste: ${kort(e)})`);
		(fel as { cause?: unknown }).cause = e;
		return fel;
	};
	const anropa = async (texter: string[]) => vektorerUrSvar(await ai.run(MODELL, { text: texter, truncate_inputs: true }), texter.length);
	/** Ett misslyckat anrop: räkna, logga, och avbryt vid kvotgränsen. */
	const fallerade = (antal: number, forsta: string, e: unknown) => {
		aiFel++;
		iFoljd++;
		console.error(`inbäddning: Workers AI fallerade för ${antal} texter (${forsta} …): ${(e instanceof Error ? e.message : String(e)).slice(0, 500)}`);
		if (aiFel >= MAX_AI_FEL_TOTALT) {
			const fel = new Error(`Workers AI fallerade ${aiFel} gånger i körningen; avbryter (senaste: ${kort(e)})`);
			(fel as { cause?: unknown }).cause = e;
			throw fel;
		}
	};
	const verkligLyckades = (text: string) => {
		verkligaLyckade++;
		iFoljd = 0;
		referens ??= text;
	};
	const hamtaReferens = async (): Promise<string | null> => {
		if (referens !== undefined) return referens;
		const [r] = await rows<LamningData>(
			db,
			`SELECT l.uuid, l.lamningsnummer, l.lamningstyp, l.bedomning, l.namn, l.beskrivning, l.tradition, l.terrang, l.hash, NULL AS omr, 1 AS i_omfang
			   FROM inbaddning i JOIN lamning l ON l.uuid = i.uuid AND l.hash = i.rad_hash
			  WHERE i.status = 'ok' AND i.modell = ? AND l.id IN (${SCOPE_IDS}) LIMIT 1`,
			MODELL,
			scopeJson,
		);
		referens = (r && inbaddningstext(r)) || null;
		return referens;
	};
	/** Referenstexten: true om den gick igenom (en verklig text lyckades), false om den fallerade, null om ingen finns. */
	const provaReferens = async (): Promise<boolean | null> => {
		const ref = await hamtaReferens();
		if (!ref) return null;
		try {
			await anropa([ref]);
		} catch (e) {
			aiFel++;
			iFoljd++;
			console.error(`inbäddning: referenstexten (en redan inbäddad lämning) fallerade också (${kort(e)})`);
			return false;
		}
		verkligLyckades(ref);
		return true;
	};
	/** Regel 4a: första felet innan någon verklig text lyckats. Kastar vid avbrott. */
	const provaTjansten = async (e: unknown) => {
		provat = true;
		const ref = await provaReferens();
		if (ref === true) return;
		if (ref === false) throw avbrott("Workers AI svarar inte för verkliga texter (avbrott): referenstexten, en redan inbäddad lämning, fallerade också", e);
		try {
			await anropa([KONTROLLTEXT]);
		} catch (k) {
			console.error(`inbäddning: kontrolltexten fallerade också (${kort(k)})`);
			throw avbrott("Workers AI svarar inte (avbrott): både texterna och kontrolltexten fallerade", e);
		}
		kontrollGickIgenom = true;
		console.warn("inbäddning: kontrolltexten gick igenom men verkliga texter fallerar; kontrolltexten räknas inte som belägg för att felet ligger i texterna");
	};
	const lagra = async (del: Jobb[], vektorer: number[][]) => {
		const upserts: VectorizeVector[] = [];
		const overskott: string[] = [];
		del.forEach((j, k) => {
			j.meta.forEach((m, v) => upserts.push({ id: vektorId(j.uuid, v), values: vektorer[k], metadata: m }));
			if (j.tidigare > j.meta.length) overskott.push(...idsFor(j.uuid, j.meta.length, j.tidigare));
		});
		for (let u = 0; u < upserts.length; u += UPSERT_BATCH) await vec.upsert(upserts.slice(u, u + UPSERT_BATCH));
		if (overskott.length) await vec.deleteByIds(overskott);
		const satser = del.flatMap((j) => [
			spara(j.uuid, j.radHash, j.innehall, j.meta.length, "ok"),
			ur(j.uuid),
			db.prepare("DELETE FROM inbaddning_fel WHERE uuid = ?").bind(j.uuid),
		]);
		for (let s = 0; s < satser.length; s += 60) await db.batch(satser.slice(s, s + 60));
		res.inbaddade += del.length;
		res.vektorer += upserts.length;
	};
	interface Misstankt {
		j: Jobb;
		msg: string;
		tillfalligt: boolean;
	}
	const bekrafta = (lista: Misstankt[]) => {
		for (const m of lista.splice(0)) bokforFel(m.j, m.tillfalligt ? BELAGG_TILLFALLIGT : BELAGG_ANNAN_LYCKADES, m.msg);
	};

	const ko: Jobb[][] = [];
	for (let i = 0; i < jobb.length; i += AI_BATCH) ko.push(jobb.slice(i, i + AI_BATCH));
	const misstankta: Misstankt[] = [];
	try {
		// Regel 1–2 och 4a–b, e: delarna i tur och ordning, halvor sist i kön.
		while (ko.length) {
			const del = ko.shift() as Jobb[];
			let v: number[][];
			try {
				v = await anropa(del.map((j) => j.text));
			} catch (e) {
				fallerade(del.length, del[0].uuid, e);
				const msg = e instanceof Error ? e.message : String(e);
				if (del.length === 1 && arIndatafel(e)) {
					bokforFel(del[0], BELAGG_INDATAFEL, msg);
					continue;
				}
				if (verkligaLyckade === 0 && !provat) await provaTjansten(e);
				if (iFoljd >= MAX_AI_FEL_I_FOLJD)
					throw avbrott(`Workers AI (avbrott): ${iFoljd} anrop i följd fallerade utan att någon verklig text lyckades emellan${kontrollGickIgenom ? " (kontrolltexten gick igenom, men den räknas inte som belägg)" : ""}`, e);
				if (del.length > 1) {
					const mitt = Math.ceil(del.length / 2);
					ko.push(del.slice(0, mitt), del.slice(mitt));
				} else misstankta.push({ j: del[0], msg, tillfalligt: arTillfalligtAiFel(e) });
				continue;
			}
			verkligLyckades(del[0].text);
			await lagra(del, v);
			if (felSatser.length) await db.batch(felSatser.splice(0));
		}
		// Regel 4c: ingen verklig text gick igenom, bara (möjligen) kontrolltexten.
		if (misstankta.length && verkligaLyckade === 0)
			throw avbrott(`Workers AI (delvis avbrott): ingen verklig text lyckades i körningen${kontrollGickIgenom ? "; kontrolltexten gick igenom, men den räknas inte som belägg" : ""}`, new Error(misstankta[0].msg));
		// Regel 3 och 4d: andra försöket för texter som fallerat ensamma.
		const obekraftade: Misstankt[] = [];
		let kvar = misstankta.length;
		for (const m of misstankta) {
			kvar--;
			try {
				const v = await anropa([m.j.text]);
				verkligLyckades(m.j.text);
				bekrafta(obekraftade);
				await lagra([m.j], v);
			} catch (e) {
				fallerade(1, m.j.uuid, e);
				const msg = e instanceof Error ? e.message : String(e);
				if (arIndatafel(e)) bokforFel(m.j, BELAGG_INDATAFEL, msg);
				else obekraftade.push({ j: m.j, msg, tillfalligt: arTillfalligtAiFel(e) });
				if (obekraftade.length >= BEKRAFTA_EFTER || (kvar === 0 && obekraftade.length)) {
					if (await provaReferens()) bekrafta(obekraftade);
					else break;
				}
			}
		}
		const obokforda = obekraftade.length + kvar;
		if (obokforda) {
			res.tillfalliga_fel = obokforda;
			console.warn(`inbäddning: ${obokforda} texter fallerade men bokfördes inte: referenstexten fallerade också (troligen avbrott i slutet av körningen); prövas nästa körning`);
		}
	} finally {
		// Även när körningen avbryts bokförs det som redan har belägg.
		if (felSatser.length) await db.batch(felSatser.splice(0));
	}

	const koKvar = await rows<{ n: number }>(db, "SELECT count(*) AS n FROM inbaddning_ko");
	res.klar = !nyaKvar && !gamlaKvar && Number(koKvar[0]?.n ?? 0) === 0 && !res.fel && !res.tillfalliga_fel;
	if (res.klar) await markeraKlar(db, signatur, tid);
	return res;
}

/**
 * Engångsrensning (idempotent): tar bort bokförda fel som saknar giltigt belägg
 * för att felet gällde texten. Före BELAGG_* räknades okända fel som textens
 * även när Workers AI var nere för alla, så lämningar kunde hoppas över för
 * gott; version 1 av belägget ("annan text i körningen lyckades") räknade
 * kontrolltexten som belägg, så rader med den formuleringen rensas också
 * (RENSNING_VERSION 2). Rader med ett entydigt indatafel i meddelandet behålls. Markören i
 * synk_status gör att rensningen bara körs en gång; körs den igen gör den
 * ingenting, eftersom alla nya rader har ett belägg.
 */
async function rensaOverhoppningarUtanBelagg(db: D1Like, tid: string): Promise<void> {
	const kandidater = await rows<{ uuid: string; senaste_fel: string | null }>(
		db,
		"SELECT uuid, senaste_fel FROM inbaddning_fel WHERE senaste_fel IS NULL OR (senaste_fel NOT LIKE ? AND senaste_fel NOT LIKE ? AND senaste_fel NOT LIKE ?)",
		`${BELAGG_ANNAN_LYCKADES}%`,
		`${BELAGG_TILLFALLIGT}%`,
		`${BELAGG_INDATAFEL}%`,
	);
	const bort = kandidater.filter((r) => !arIndatafel(new Error(r.senaste_fel ?? ""))).map((r) => r.uuid);
	const satser: D1LikeStatement[] = [];
	for (let i = 0; i < bort.length; i += 500)
		satser.push(db.prepare("DELETE FROM inbaddning_fel WHERE uuid IN (SELECT value FROM json_each(?))").bind(JSON.stringify(bort.slice(i, i + 500))));
	if (bort.length) {
		satser.push(db.prepare("DELETE FROM synk_status WHERE nyckel = 'inbaddning_klar'"));
		console.warn(`inbäddning: ${bort.length} överhoppningar utan belägg rensade (prövas igen)`);
	}
	satser.push(
		db
			.prepare(`INSERT INTO synk_status (nyckel, varde, andrad) VALUES ('${RENSNING_NYCKEL}', ?, ?) ON CONFLICT(nyckel) DO UPDATE SET varde = excluded.varde, andrad = excluded.andrad`)
			.bind(RENSNING_VERSION, tid),
	);
	await db.batch(satser);
}

async function markeraKlar(db: D1Like, signatur: string, tid: string): Promise<void> {
	await db.batch([
		db
			.prepare("INSERT INTO synk_status (nyckel, varde, andrad) VALUES ('inbaddning_klar', ?, ?) ON CONFLICT(nyckel) DO UPDATE SET varde = excluded.varde, andrad = excluded.andrad")
			.bind(signatur, tid),
	]);
}

/** Hur mycket som återstår inom omfånget (för loggning och uppföljning). */
export async function embedStatus(
	env: SemanticEnv,
): Promise<{ iOmfang: number; bokforda: number; aterstar: number; ko: number }> {
	const db = env.DB;
	if (!db) throw new Error("embedStatus: bindningen DB saknas");
	const scopeJson = JSON.stringify(parseScope(env.SEMANTIC_LAN).lan);
	const [a] = await rows<{ n: number }>(
		db,
		`SELECT count(*) AS n FROM lamning WHERE id IN (${SCOPE_IDS})`,
		scopeJson,
	);
	const [b] = await rows<{ n: number }>(db, "SELECT count(*) AS n FROM inbaddning");
	const [c] = await rows<{ n: number }>(
		db,
		`SELECT count(*) AS n FROM lamning l WHERE l.id IN (${SCOPE_IDS})
		   AND NOT EXISTS (SELECT 1 FROM inbaddning i WHERE i.uuid = l.uuid AND i.rad_hash = l.hash AND i.modell = ?)`,
		scopeJson,
		MODELL,
	);
	const [d] = await rows<{ n: number }>(db, "SELECT count(*) AS n FROM inbaddning_ko");
	return {
		iOmfang: Number(a?.n ?? 0),
		bokforda: Number(b?.n ?? 0),
		aterstar: Number(c?.n ?? 0),
		ko: Number(d?.n ?? 0),
	};
}

export type { AiLike, VectorizeLike };
