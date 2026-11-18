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
 * Fel i Workers AI: tillfälliga fel (arTillfalligtAiFel) prövas nästa körning
 * utan att räknas; fel på en enskild text bokförs i inbaddning_fel, och efter
 * MAX_FEL_PER_POST försök med samma radhash hoppas lämningen över.
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
/** Så många misslyckade anrop till Workers AI per körning innan körningen ger upp (tjänsten är nere). */
export const MAX_AI_FEL_PER_KORNING = 12;

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
 * Tillfälligt fel i Workers AI – inte fel på texten. Förbrukar inga försök i
 * inbaddning_fel, och delen halveras inte (alla texter skulle falla av samma
 * skäl). Avgörs bara på HTTP-status (fältet `status`, eller status med
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
	/** Texter som inte bäddades in på grund av tillfälliga fel i Workers AI (prövas nästa körning). */
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
	const tid = (opts.now ?? new Date()).toISOString();
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
		"SELECT nyckel, varde FROM synk_status WHERE nyckel IN ('senaste_grundladdning', 'senaste_avstamning', 'inbaddning_klar')",
	);
	const stv = new Map(st.map((r) => [r.nyckel, r.varde]));
	const signatur = JSON.stringify({ g: stv.get("senaste_grundladdning") ?? null, a: stv.get("senaste_avstamning") ?? null, omfang: scope.lan, modell: MODELL });
	const [ko0] = await rows<{ n: number }>(db, "SELECT count(*) AS n FROM inbaddning_ko");
	if (Number(ko0?.n ?? 0) === 0 && stv.get("inbaddning_klar") === signatur) {
		res.klar = true;
		return res;
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
			    AND NOT EXISTS (SELECT 1 FROM inbaddning_fel f WHERE f.uuid = l.uuid AND f.rad_hash = l.hash AND f.forsok >= ?)
			  ORDER BY l.id LIMIT ?`,
			scopeJson,
			MODELL,
			MAX_FEL_PER_POST,
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
	const felade = new Map<string, { rad_hash: string; forsok: number; senaste_fel: string | null }>();
	for (const r of await rows<{ uuid: string; rad_hash: string; forsok: number; senaste_fel: string | null }>(
		db,
		"SELECT uuid, rad_hash, forsok, senaste_fel FROM inbaddning_fel WHERE uuid IN (SELECT value FROM json_each(?))",
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
		if (f && f.rad_hash === d.hash && f.forsok >= MAX_FEL_PER_POST) {
			// Har fallerat för många gånger med samma text: hoppa över (och ta ur kön) tills raden ändras.
			console.warn(`inbäddning: ${uuid} hoppas över efter ${f.forsok} misslyckade försök (${f.senaste_fel ?? "okänt fel"})`);
			bokforing.push(ur(uuid));
			continue;
		}
		jobb.push({ uuid, text, meta, radHash: d.hash, innehall, tidigare: b?.vektorer ?? 0 });
	}

	// ------------------------------------------------ borttagningar och bokföring utan inbäddning
	for (let i = 0; i < taBortIds.length; i += 1000)
		await vec.deleteByIds(taBortIds.slice(i, i + 1000));
	for (let i = 0; i < bokforing.length; i += 50) await db.batch(bokforing.slice(i, i + 50));

	// ------------------------------------------------ inbäddning
	// En del som fallerar halveras ned till enskilda lämningar, så att en text som
	// modellen avvisar inte blockerar resten. Enskilda fel bokförs i inbaddning_fel;
	// efter MAX_FEL_PER_POST försök hoppas lämningen över tills raden ändras.
	let aiFel = 0;
	const felSatser: D1LikeStatement[] = [];
	const baddaIn = async (del: Jobb[]): Promise<Array<{ j: Jobb; v: number[] }>> => {
		try {
			const svar = await ai.run(MODELL, { text: del.map((j) => j.text), truncate_inputs: true });
			const v = vektorerUrSvar(svar, del.length);
			return del.map((j, k) => ({ j, v: v[k] }));
		} catch (e) {
			aiFel++;
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`inbäddning: Workers AI fallerade för ${del.length} texter (${del[0].uuid} …): ${msg.slice(0, 500)}`);
			if (aiFel >= MAX_AI_FEL_PER_KORNING) {
				const fel = new Error(`Workers AI fallerade ${aiFel} gånger i körningen; avbryter (senaste: ${msg.slice(0, 300)})`);
				(fel as { cause?: unknown }).cause = e;
				throw fel;
			}
			if (arTillfalligtAiFel(e)) {
				// Inte textens fel: ingen bokföring i inbaddning_fel, ingen halvering. Lämningarna
				// ligger kvar (i kön, eller utan inbäddning) och prövas nästa körning.
				res.tillfalliga_fel = (res.tillfalliga_fel ?? 0) + del.length;
				return [];
			}
			if (del.length === 1) {
				felSatser.push(
					db
						.prepare(
							"INSERT INTO inbaddning_fel (uuid, rad_hash, forsok, senaste_fel, andrad) VALUES (?, ?, 1, ?, ?) ON CONFLICT(uuid) DO UPDATE SET forsok = CASE WHEN inbaddning_fel.rad_hash = excluded.rad_hash THEN inbaddning_fel.forsok + 1 ELSE 1 END, rad_hash = excluded.rad_hash, senaste_fel = excluded.senaste_fel, andrad = excluded.andrad",
						)
						.bind(del[0].uuid, del[0].radHash, msg.slice(0, 500), tid),
				);
				res.fel = (res.fel ?? 0) + 1;
				return [];
			}
			const mitt = Math.ceil(del.length / 2);
			return [...(await baddaIn(del.slice(0, mitt))), ...(await baddaIn(del.slice(mitt)))];
		}
	};
	for (let i = 0; i < jobb.length; i += AI_BATCH) {
		const ok = await baddaIn(jobb.slice(i, i + AI_BATCH));
		if (felSatser.length) await db.batch(felSatser.splice(0));
		const del = ok.map((x) => x.j);
		const vektorer = ok.map((x) => x.v);
		if (!del.length) continue;
		const upserts: VectorizeVector[] = [];
		const overskott: string[] = [];
		del.forEach((j, k) => {
			j.meta.forEach((m, v) =>
				upserts.push({ id: vektorId(j.uuid, v), values: vektorer[k], metadata: m }),
			);
			if (j.tidigare > j.meta.length)
				overskott.push(...idsFor(j.uuid, j.meta.length, j.tidigare));
		});
		for (let u = 0; u < upserts.length; u += UPSERT_BATCH)
			await vec.upsert(upserts.slice(u, u + UPSERT_BATCH));
		if (overskott.length) await vec.deleteByIds(overskott);
		const satser = del.flatMap((j) => [
			spara(j.uuid, j.radHash, j.innehall, j.meta.length, "ok"),
			ur(j.uuid),
		]);
		for (let s = 0; s < satser.length; s += 50) await db.batch(satser.slice(s, s + 50));
		res.inbaddade += del.length;
		res.vektorer += upserts.length;
	}

	const koKvar = await rows<{ n: number }>(db, "SELECT count(*) AS n FROM inbaddning_ko");
	res.klar = !nyaKvar && !gamlaKvar && Number(koKvar[0]?.n ?? 0) === 0 && !res.fel && !res.tillfalliga_fel;
	if (res.klar) await markeraKlar(db, signatur, tid);
	return res;
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
