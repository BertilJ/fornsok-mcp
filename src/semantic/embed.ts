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
import { parseScope, type Scope } from "./scope";
import { inbaddningstext } from "./text";

/** Texter per anrop till Workers AI. 50 × högst 512 token ryms med god marginal i modellens 60 000. */
export const AI_BATCH = 50;
/** Vektorer per upsert (Workers-gränsen är 1 000). */
export const UPSERT_BATCH = 500;
export const STANDARD_MAX = 1000;

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
	const scope: Scope = parseScope(env.SEMANTIC_LAN);
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
			  ORDER BY l.id LIMIT ?`,
			scopeJson,
			MODELL,
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
		jobb.push({ uuid, text, meta, radHash: d.hash, innehall, tidigare: b?.vektorer ?? 0 });
	}

	// ------------------------------------------------ borttagningar och bokföring utan inbäddning
	for (let i = 0; i < taBortIds.length; i += 1000)
		await vec.deleteByIds(taBortIds.slice(i, i + 1000));
	for (let i = 0; i < bokforing.length; i += 50) await db.batch(bokforing.slice(i, i + 50));

	// ------------------------------------------------ inbäddning
	for (let i = 0; i < jobb.length; i += AI_BATCH) {
		const del = jobb.slice(i, i + AI_BATCH);
		const svar = await ai.run(MODELL, { text: del.map((j) => j.text), truncate_inputs: true });
		const vektorer = vektorerUrSvar(svar, del.length);
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
	res.klar = !nyaKvar && !gamlaKvar && Number(koKvar[0]?.n ?? 0) === 0;
	return res;
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
