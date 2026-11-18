/**
 * Grundinbäddning och ombäddning (SPEC 5.2, 5.3). Återupptagbar: varje körning
 * tar högst `max` lämningar och gör i tur och ordning
 *
 * 1. kön `inbaddning_ko` (lämningar som nattsynken ändrat eller tagit bort, och
 *    lämningar vars inbäddning påbörjats men inte bokförts),
 * 2. lämningar inom omfånget som saknar inbäddning eller vars rad ändrats
 *    sedan dess (`inbaddning.rad_hash` ≠ `lamning.hash`, t.ex. efter
 *    avstämningen i ingest/) eller som bäddats in med en annan modell,
 * 3. inbäddningar för lämningar som utgått eller lämnat omfånget (vektorerna
 *    tas bort).
 *
 * För varje lämning byggs texten (text.ts) och metadata (filter.ts); är de
 * oförändrade (`innehall_hash`) bäddas inget in, bara `rad_hash` uppdateras.
 * Fel i Workers AI, Vectorize och D1: se beslutsregeln överst i runEmbedBatch.
 */
import type { D1Like, D1LikeStatement } from "../store/d1";
import {
	type AiLike,
	MODELL,
	type SemanticEnv,
	type VectorizeLike,
	vektorerUrSvar,
} from "./bindings";
import { type LamningsMeta, MAX_VARIANTER, varianter, vektorId } from "./filter";
import { checkedScope, parseScope, type Scope } from "./scope";
import { inbaddningstext } from "./text";

/** Texter per anrop till Workers AI. 50 × högst 512 token ryms med god marginal i modellens 60 000. */
export const AI_BATCH = 50;
/** Vektorer per upsert (Workers-gränsen är 1 000). */
export const UPSERT_BATCH = 500;
export const STANDARD_MAX = 1000;
/** Bokförda försök (ett per dygn) innan en lämning vilar i OMPROVNING_DYGN dygn. */
export const MAX_FEL_PER_POST = 3;
export const OMPROVNING_DYGN = 7;
/** Högst så många anrop till Workers AI per körning, utöver kontrollerna (regel 5). */
export const MAX_ANROP = 100;
/** Kontroll efter så många misslyckade anrop i följd (regel 3). */
export const KONTROLL_EFTER = 8;
/** Batchstorleken dubblas efter så många lyckade anrop i följd (regel 4). */
const VAXT_EFTER = 4;
/** Inga nya anrop efter så lång tid (en Cron-körning får ta 15 minuter). */
const TIDSBUDGET_MS = 10 * 60_000;
/** Tidsgräns per anrop till Workers AI och Vectorize. */
export const TIDSGRANS_MS = 30_000;
/** Orsak i inbaddning_ko för en påbörjad inbäddning (regel 7). */
export const PABORJAD = "påbörjad";
/**
 * Prefix i inbaddning_fel.senaste_fel: varför felet räknades som textens.
 * BELAGG_ANNAN_LYCKADES skrivs av regel 2; de två andra är äldre format som
 * engångsrensningen godtar. Rader med formuleringen före BELAGG_* eller med
 * "annan text i körningen lyckades" (där kontrolltexten räknades) rensas en
 * gång (RENSNING_VERSION 2).
 */
export const BELAGG_ANNAN_LYCKADES = "belägg: fallerade ensam två gånger, och en annan verklig text lyckades efter det; ";
export const BELAGG_TILLFALLIGT = "belägg: tillfälligt fel för texten ensam två gånger, och en annan verklig text lyckades efter det (prövas en gång per dygn); ";
export const BELAGG_INDATAFEL = "belägg: indatafel; ";
const RENSNING_NYCKEL = "inbaddning_fel_rensad";
const RENSNING_VERSION = "2";
/** Höjs när logiken för vad som räknas som klart ändras, så att omfånget gås igenom igen. */
const KLAR_VERSION = 2;

/** Workers AI:s felkod först i meddelandet eller efter feltypen: "3006: …", "AiError: 3006: …". */
const AI_KOD = /(?:^|:\s*)(\d{4})\s*:/;
/** 3006 Request too large (413): entydigt fel på indata (används bara av engångsrensningen). */
export const INDATA_AI_KODER = new Set(["3006"]);

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
	/** Lämningar vars inbäddning fallerade med belägg (bokförda i inbaddning_fel). */
	fel?: number;
	omfang: string[];
}

type Row = Record<string, unknown>;

async function rows<T = Row>(db: D1Like, sql: string, ...params: unknown[]): Promise<T[]> {
	const s = db.prepare(sql);
	return ((await (params.length ? s.bind(...params) : s).all<T>()).results ?? []) as T[];
}

const SCOPE_IDS =
	"SELECT lo.lamning_id FROM lamning_omrade lo JOIN omrade o ON o.id = lo.omrade_id WHERE o.niva = 'lan' AND o.namn IN (SELECT value FROM json_each(?))";
/** Lämningen l är inbäddad med sin nuvarande rad och modell (parameter: modellen). */
const INBADDAD = "SELECT 1 FROM inbaddning i WHERE i.uuid = l.uuid AND i.rad_hash = l.hash AND i.modell = ?";
/**
 * Felraden f för lämningen l vilar (regel 6). Parametrar: dygnets början och
 * gränsen för omprövning. Samma villkor väljer arbete och avgör om omfånget är
 * klart, så att en förfallen rad aldrig blir liggande medan körningen säger klar.
 */
const VILAR = `(f.rad_hash = l.hash AND ((f.forsok < ${MAX_FEL_PER_POST} AND f.andrad >= ?) OR (f.forsok >= ${MAX_FEL_PER_POST} AND f.andrad > ?)))`;

async function sha(s: string): Promise<string> {
	const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(b)]
		.map((x) => x.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 32);
}

const kort = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Avvisa om löftet inte avgjorts inom `ms` (felet heter TimeoutError). */
function tidsgrans<T>(p: Promise<T>, ms: number, vad: string): Promise<T> {
	let t: ReturnType<typeof setTimeout> | null = null;
	const grans = new Promise<never>((_, nej) => {
		t = setTimeout(() => nej(Object.assign(new Error(`${vad}: inget svar inom ${ms} ms`), { name: "TimeoutError" })), ms);
	});
	return Promise.race([p, grans]).finally(() => t !== null && clearTimeout(t));
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

/** Vektor-id uuid#from … uuid#(to−1) (#0 = uuid). */
function idsFor(uuid: string, from: number, to: number): string[] {
	const out: string[] = [];
	for (let i = from; i < to; i++) out.push(vektorId(uuid, i));
	return out;
}

export async function runEmbedBatch(
	env: SemanticEnv,
	opts: { max?: number; now?: Date; tidsgransMs?: number } = {},
): Promise<EmbedResult> {
	/*
	 * Beslutsregel. "Verklig text" = en lämnings text ur omfånget (aldrig en
	 * konstruerad kontrolltext).
	 * 1. Delar om högst `storlek` texter bäddas in djupet först: en del som
	 *    fallerar delas direkt i två halvor, som avgörs innan nästa del prövas.
	 *    En ensam text som fallerar prövas en gång till; fallerar den igen är den
	 *    misstänkt.
	 * 2. En misstänkt text bokförs (inbaddning_fel) när en verklig text lyckas
	 *    efter den i samma körning. Bokförda fel skrivs till D1 vid nästa
	 *    skrivning, även om körningen sedan avbryts. Fel i Vectorize och D1 är
	 *    aldrig textens: de avbryter körningen (kastar).
	 * 3. Kontroll vid första felet innan något lyckats och efter vart
	 *    KONTROLL_EFTER:e fel i följd: referenstexten (senast lyckade verkliga
	 *    text, annars en redan inbäddad lämning), och fallerar den, upp till tre
	 *    återstående texter ensamma (sista, mittersta, första). Lyckas ingen är
	 *    det avbrott: körningen kastar och misstänkta bokförs inte.
	 * 4. Fallerar en del men lyckas alla dess delar var den för stor: `storlek`
	 *    sätts till halvans storlek. Efter VAXT_EFTER lyckade anrop i följd
	 *    dubblas den (högst AI_BATCH).
	 * 5. Högst MAX_ANROP anrop eller TIDSBUDGET_MS per körning; sedan kontrolleras
	 *    kvarvarande misstänkta (ett anrop) och resten tas nästa körning. Varje
	 *    anrop till Workers AI och Vectorize har en tidsgräns.
	 * 6. En bokförd text vilar till nästa dygn (UTC), oavsett fel; efter
	 *    MAX_FEL_PER_POST försök i OMPROVNING_DYGN dygn. Ändras raden prövas den direkt.
	 * 7. Före upsert läggs lämningen i inbaddning_ko (PABORJAD) och dess
	 *    innehallshash töms; efter bokföringen tas den ur kön. En avbruten körning
	 *    lämnar den alltså i kön, och för lämningar ur kön tas alla vektor-id upp
	 *    till MAX_VARIANTER bort utöver de som skrivs.
	 */
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
		console.error(`inbäddning: ${kort(e)}`);
		throw e;
	}
	const max = Math.max(1, Math.min(10_000, opts.max ?? STANDARD_MAX));
	const nu = opts.now ?? new Date();
	const tid = nu.toISOString();
	const dygnet = `${tid.slice(0, 10)}T00:00:00.000Z`;
	const omprovas = new Date(nu.getTime() - OMPROVNING_DYGN * 86_400_000).toISOString();
	const ms = opts.tidsgransMs ?? TIDSGRANS_MS;
	const scopeJson = JSON.stringify(scope.lan);
	const res: EmbedResult = { inbaddade: 0, vektorer: 0, oforandrade: 0, tomma: 0, borttagna: 0, klar: false, omfang: scope.lan };
	const skriv = async (s: D1LikeStatement[]) => {
		for (let i = 0; i < s.length; i += 50) await db.batch(s.slice(i, i + 50));
	};
	const taBort = async (ids: string[]) => {
		for (let i = 0; i < ids.length; i += 1000) await tidsgrans(vec.deleteByIds(ids.slice(i, i + 1000)), ms, "Vectorize");
	};

	// ------------------------------------------------ klart sedan sist?
	// Färdiginbäddat och inget ändrat (samma grundladdning, avstämning, omfång och modell,
	// tom kö): bara felrader som förfallit söks fram; nattsynkens ändringar kommer via kön.
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
		const [due] = await rows<{ n: number }>(
			db,
			`SELECT count(*) AS n FROM inbaddning_fel f JOIN lamning l ON l.uuid = f.uuid
			  WHERE NOT ${VILAR} AND l.id IN (${SCOPE_IDS}) AND NOT EXISTS (${INBADDAD})`,
			dygnet,
			omprovas,
			scopeJson,
			MODELL,
		);
		if (Number(due?.n ?? 0) === 0) {
			res.klar = true;
			return res;
		}
	}

	// ------------------------------------------------ arbetslista
	const franKo = new Set(
		(await rows<{ uuid: string }>(db, "SELECT uuid FROM inbaddning_ko ORDER BY lagd, uuid LIMIT ?", max)).map((r) => r.uuid),
	);
	const arbete = new Set(franKo);
	let nyaKvar = false;
	if (arbete.size < max) {
		const limit = max - arbete.size;
		const nya = await rows<{ uuid: string }>(
			db,
			`SELECT l.uuid FROM lamning l
			  WHERE l.id IN (${SCOPE_IDS}) AND NOT EXISTS (${INBADDAD})
			    AND NOT EXISTS (SELECT 1 FROM inbaddning_fel f WHERE f.uuid = l.uuid AND ${VILAR})
			  ORDER BY l.id LIMIT ?`,
			scopeJson,
			MODELL,
			dygnet,
			omprovas,
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
	const bokford = new Map<string, Bokford>();
	for (const r of await rows<Bokford>(db, "SELECT uuid, innehall_hash, vektorer, status, modell FROM inbaddning WHERE uuid IN (SELECT value FROM json_each(?))", lista))
		bokford.set(r.uuid, r);
	const vilar = new Set(
		(await rows<{ uuid: string }>(db, `SELECT f.uuid FROM inbaddning_fel f JOIN lamning l ON l.uuid = f.uuid WHERE f.uuid IN (SELECT value FROM json_each(?)) AND ${VILAR}`, lista, dygnet, omprovas)).map((r) => r.uuid),
	);

	// ------------------------------------------------ klassificera
	const spara = (uuid: string, radHash: string, innehall: string, vektorer: number, status: "ok" | "tom") =>
		db
			.prepare(
				`INSERT INTO inbaddning (uuid, rad_hash, innehall_hash, vektorer, status, modell, andrad) VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(uuid) DO UPDATE SET rad_hash = excluded.rad_hash, innehall_hash = excluded.innehall_hash,
				 vektorer = excluded.vektorer, status = excluded.status, modell = excluded.modell, andrad = excluded.andrad`,
			)
			.bind(uuid, radHash, innehall, vektorer, status, MODELL, tid);
	const iLista = (sql: string, uuids: string[]) => db.prepare(`${sql} WHERE uuid IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(uuids));
	/** Avgjord lämning: ur kön och utan felrad. */
	const avsluta = (uuids: string[]) => [iLista("DELETE FROM inbaddning_fel", uuids), iLista("DELETE FROM inbaddning_ko", uuids)];

	interface Jobb {
		uuid: string;
		text: string;
		meta: ReturnType<typeof varianter>;
		radHash: string;
		innehall: string;
		/** Vektor-id som kan finnas: bokförda, eller MAX_VARIANTER för lämningar ur kön (regel 7). */
		tidigare: number;
	}
	const jobb: Jobb[] = [];
	const taBortIds: string[] = [];
	const bokforing: D1LikeStatement[] = [];
	const klara: string[] = [];
	const urKo: string[] = [];
	for (const uuid of arbete) {
		const d = data.get(uuid);
		const b = bokford.get(uuid);
		const tidigare = franKo.has(uuid) ? MAX_VARIANTER : (b?.vektorer ?? 0);
		if (!d || !d.i_omfang) {
			taBortIds.push(...idsFor(uuid, 0, tidigare));
			if (b) {
				bokforing.push(db.prepare("DELETE FROM inbaddning WHERE uuid = ?").bind(uuid));
				res.borttagna++;
			}
			klara.push(uuid);
			continue;
		}
		const text = inbaddningstext(d);
		if (!text) {
			taBortIds.push(...idsFor(uuid, 0, tidigare));
			bokforing.push(spara(uuid, d.hash, "tom", 0, "tom"));
			klara.push(uuid);
			res.tomma++;
			continue;
		}
		const lm: LamningsMeta = { uuid, lamningsnummer: d.lamningsnummer, typ: d.lamningstyp, bedomning: d.bedomning, ...areas(d.omr) };
		const meta = varianter(lm);
		const innehall = await sha(JSON.stringify({ m: MODELL, text, meta }));
		if (b && b.status === "ok" && b.modell === MODELL && b.innehall_hash === innehall && b.vektorer === meta.length) {
			bokforing.push(spara(uuid, d.hash, innehall, b.vektorer, "ok"));
			klara.push(uuid);
			res.oforandrade++;
			continue;
		}
		if (vilar.has(uuid)) {
			urKo.push(uuid); // bokfört fel som vilar (regel 6); hittas av genomsökningen när det förfallit
			continue;
		}
		jobb.push({ uuid, text, meta, radHash: d.hash, innehall, tidigare });
	}
	if (vilar.size) console.warn(`inbäddning: ${vilar.size} lämningar med bokfört fel vilar`);
	await taBort(taBortIds);
	await skriv([...bokforing, ...avsluta(klara), iLista("DELETE FROM inbaddning_ko", urKo)]);

	// ------------------------------------------------ inbäddning (beslutsregeln överst)
	const start = Date.now();
	const STOPP = new Error("stopp");
	const avgjord = new Set<Jobb>();
	const misstankta: Array<{ j: Jobb; msg: string }> = [];
	const felSatser: D1LikeStatement[] = [];
	let storlek = AI_BATCH;
	let anrop = 0;
	let iFoljd = 0;
	let iRad = 0;
	let isolerade = 0;
	let belagg = false;
	let senaste = "";
	/** Senast lyckade verkliga text; undefined = ingen i körningen och inte sökt i D1. */
	let referens: string | null | undefined;

	/** Ett anrop till Workers AI. null om det fallerade, av vilket skäl som helst (även svarets form). */
	const run = async (texter: string[], kontroll = false): Promise<number[][] | null> => {
		if (!kontroll && (anrop >= MAX_ANROP || Date.now() - start > TIDSBUDGET_MS)) throw STOPP;
		anrop++;
		try {
			const v = vektorerUrSvar(await tidsgrans(ai.run(MODELL, { text: texter, truncate_inputs: true }), ms, "Workers AI"), texter.length);
			if (++iRad >= VAXT_EFTER) {
				storlek = Math.min(AI_BATCH, storlek * 2);
				iRad = 0;
			}
			return v;
		} catch (e) {
			iRad = 0;
			if (!kontroll) senaste = kort(e);
			console.error(`inbäddning: Workers AI fallerade för ${texter.length} texter${kontroll ? " (kontroll)" : ""}: ${kort(e)}`);
			return null;
		}
	};
	const verklig = (text: string) => {
		belagg = true;
		iFoljd = 0;
		referens = text;
		for (const m of misstankta.splice(0)) {
			felSatser.push(
				db
					.prepare(
						"INSERT INTO inbaddning_fel (uuid, rad_hash, forsok, senaste_fel, andrad) VALUES (?, ?, 1, ?, ?) ON CONFLICT(uuid) DO UPDATE SET forsok = CASE WHEN inbaddning_fel.rad_hash = excluded.rad_hash THEN inbaddning_fel.forsok + 1 ELSE 1 END, rad_hash = excluded.rad_hash, senaste_fel = excluded.senaste_fel, andrad = excluded.andrad",
					)
					.bind(m.j.uuid, m.j.radHash, (BELAGG_ANNAN_LYCKADES + m.msg).slice(0, 500), tid),
			);
			res.fel = (res.fel ?? 0) + 1;
		}
	};
	const lagra = async (del: Jobb[], v: number[][]) => {
		verklig(del[0].text);
		const uuids = del.map((j) => j.uuid);
		// Regel 7: avsikten (och bokförda fel) i D1 före upsert.
		await skriv([
			...felSatser.splice(0),
			db.prepare("INSERT INTO inbaddning_ko (uuid, orsak, lagd) SELECT value, ?, ? FROM json_each(?) WHERE true ON CONFLICT(uuid) DO NOTHING").bind(PABORJAD, tid, JSON.stringify(uuids)),
			iLista("UPDATE inbaddning SET innehall_hash = ''", uuids),
		]);
		const upserts = del.flatMap((j, k) => j.meta.map((m, i) => ({ id: vektorId(j.uuid, i), values: v[k], metadata: m })));
		for (let u = 0; u < upserts.length; u += UPSERT_BATCH) await tidsgrans(vec.upsert(upserts.slice(u, u + UPSERT_BATCH)), ms, "Vectorize");
		await taBort(del.flatMap((j) => idsFor(j.uuid, j.meta.length, j.tidigare)));
		await skriv([...del.map((j) => spara(j.uuid, j.radHash, j.innehall, j.meta.length, "ok")), ...avsluta(uuids)]);
		for (const j of del) avgjord.add(j);
		res.inbaddade += del.length;
		res.vektorer += upserts.length;
	};
	/** Regel 3. Kastar avbrott om ingen verklig text går igenom. */
	const kontrollera = async () => {
		if (referens === undefined) {
			const [r] = await rows<LamningData>(
				db,
				`SELECT l.uuid, l.lamningsnummer, l.lamningstyp, l.bedomning, l.namn, l.beskrivning, l.tradition, l.terrang, l.hash, NULL AS omr, 1 AS i_omfang
				   FROM inbaddning i JOIN lamning l ON l.uuid = i.uuid AND l.hash = i.rad_hash
				  WHERE i.status = 'ok' AND i.modell = ? AND l.id IN (${SCOPE_IDS}) LIMIT 1`,
				MODELL,
				scopeJson,
			);
			referens = (r && inbaddningstext(r)) || null;
		}
		if (referens && (await run([referens], true))) return verklig(referens);
		const kvar = jobb.filter((j) => !avgjord.has(j));
		for (const j of new Set([kvar[kvar.length - 1], kvar[kvar.length >> 1], kvar[0]])) {
			if (!j) continue;
			const v = await run([j.text], true);
			if (v) return lagra([j], v);
		}
		throw new Error(`Workers AI svarar inte för verkliga texter (avbrott): ${referens ? "referenstexten och " : ""}återstående texter fallerade ensamma; ${misstankta.length} misstänkta fel bokförs inte (senaste: ${senaste})`);
	};
	/** Ett försök med delen; true om den bäddades in. */
	const forsok = async (del: Jobb[]): Promise<boolean> => {
		const v = await run(del.map((j) => j.text));
		if (v) {
			await lagra(del, v);
			return true;
		}
		iFoljd++;
		if ((!belagg && iFoljd === 1) || iFoljd % KONTROLL_EFTER === 0) await kontrollera();
		return false;
	};
	const badda = async (alla: Jobb[]): Promise<void> => {
		const del = alla.filter((j) => !avgjord.has(j)); // kontrollen kan ha bäddat in en text
		if (!del.length) return;
		if (del.length > storlek) {
			for (let i = 0; i < del.length; ) {
				const n = storlek;
				await badda(del.slice(i, i + n));
				i += n;
			}
			return;
		}
		if (await forsok(del)) return;
		if (del.length > 1) {
			const fore = isolerade;
			const mitt = Math.ceil(del.length / 2);
			await badda(del.slice(0, mitt));
			await badda(del.slice(mitt));
			if (isolerade === fore) storlek = Math.min(storlek, mitt); // regel 4
			return;
		}
		const [j] = del;
		if (avgjord.has(j) || (await forsok(del)) || avgjord.has(j)) return;
		isolerade++;
		avgjord.add(j);
		misstankta.push({ j, msg: senaste });
	};

	let stoppad = false;
	try {
		try {
			await badda(jobb);
		} catch (e) {
			if (e !== STOPP) throw e;
			stoppad = true;
			console.warn(`inbäddning: körningens gräns nådd efter ${anrop} anrop; resten tas nästa körning`);
		}
		if (misstankta.length) await kontrollera(); // bekräftar dem, eller avbrott
	} finally {
		if (felSatser.length) await skriv(felSatser.splice(0));
	}

	const [ko] = await rows<{ n: number }>(db, "SELECT count(*) AS n FROM inbaddning_ko");
	res.klar = !stoppad && !nyaKvar && !gamlaKvar && Number(ko?.n ?? 0) === 0 && !res.fel;
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
		`SELECT count(*) AS n FROM lamning l WHERE l.id IN (${SCOPE_IDS}) AND NOT EXISTS (${INBADDAD})`,
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
