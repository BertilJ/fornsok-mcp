/**
 * Schemalagda körningar (SPEC 5.3): nattsynk via ändringsflödet och
 * inbäddning för den semantiska sökningen.
 *
 * - Utan indexet (`DB`) görs ingenting.
 * - Cron SYNC_CRON ("40 3-6 * * *", efter att flödet uppdaterats 00–04):
 *   runSync. Flera tillfällen per natt, så att en avbruten eller lång körning
 *   fortsätter där den slutade (kön ligger i D1).
 * - Varje schemalagd körning där AI och VECTORIZE finns: runEmbedBatch med
 *   högst EMBED_MAX lämningar (grundinbäddningen tas i delar, sedan bara
 *   ändrade poster). Efter synken i samma körning, så att nyss ändrade poster
 *   kommer med.
 *
 * Synk-cronen känns igen på att timfältet är avgränsat (t.ex. "3-6"); cron med
 * timfältet "*" (var femte eller femtonde minut) är inbäddning. Tidigare krävdes
 * exakt strängen SYNC_CRON, och en avvikande sträng gjorde att synken aldrig kördes.
 *
 * Lås med utgångstid i D1 (synk_status, nycklarna las_synk och las_inbaddning):
 * två körningar som överlappar (synken följs av inbäddning och kan sammanfalla
 * med nästa inbäddningskörning) gör inte samma arbete; den andra hoppar över.
 *
 * Ett fel i den ena hindrar inte den andra. En loggrad per körning.
 * Den schemalagda vägen har ingen HTTP-förfrågan och går därför inte genom
 * Access-kontrollen; fetch-vägen i index.ts är oförändrat skyddad.
 */
import { runEmbedBatch } from "./semantic";
import { runSync } from "./sync";
import type { WorkerEnv } from "./env";

export const SYNC_CRON = "40 3-6 * * *";
export const EMBED_MAX = 1500;
/** Låsens utgångstid: längre än en Cron-körning får ta (15 min). */
export const LAS_MS = 16 * 60 * 1000;

/** Är detta synk-cronen? Timfältet avgränsat (inte "*"). Loggar om strängen inte går att tolka. */
export function arSynkCron(cron: string, log: (l: string) => void = () => {}): boolean {
	const f = cron.trim().split(/\s+/);
	if (f.length < 5) {
		log(`schemalagd körning: kan inte tolka cron "${cron}"; behandlas som inbäddning`);
		return false;
	}
	return f[1] !== "*";
}

type LasDb = NonNullable<WorkerEnv["DB"]>;

/** Ta ett lås med utgångstid. true om låset togs (ingen annan höll ett giltigt). */
export async function taLas(db: LasDb, namn: string, token: string, nu = Date.now(), ms = LAS_MS): Promise<boolean> {
	const r = await db
		.prepare(
			"INSERT INTO synk_status (nyckel, varde, andrad) VALUES (?, ?, ?) ON CONFLICT(nyckel) DO UPDATE SET varde = excluded.varde, andrad = excluded.andrad WHERE synk_status.varde IS NULL OR synk_status.varde < ? RETURNING nyckel",
		)
		.bind(namn, new Date(nu + ms).toISOString(), token, new Date(nu).toISOString())
		.all();
	return (r.results ?? []).length > 0;
}

export async function slappLas(db: LasDb, namn: string, token: string): Promise<void> {
	await db.prepare("DELETE FROM synk_status WHERE nyckel = ? AND andrad = ?").bind(namn, token).all();
}

export interface ScheduledDeps {
	runSync: typeof runSync;
	runEmbedBatch: typeof runEmbedBatch;
	log: (line: string) => void;
}

export interface ScheduledOutcome {
	cron: string;
	synk: "hoppad" | "ej_schemalagd" | { status: string; nya: number; andrade: number; borttagna: number; kvar: number; fel: number } | { fel: string };
	inbaddning: "hoppad" | { inbaddade: number; vektorer: number; borttagna: number; klar: boolean; fel_texter?: number } | { fel: string };
}

const kort = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

export async function runScheduled(
	cron: string,
	env: WorkerEnv,
	deps: ScheduledDeps = { runSync, runEmbedBatch, log: (l) => console.log(l) },
): Promise<ScheduledOutcome> {
	const out: ScheduledOutcome = { cron, synk: "hoppad", inbaddning: "hoppad" };
	if (!env.DB) {
		deps.log(`schemalagd körning ${cron}: hoppar över (ingen D1-bindning DB)`);
		return out;
	}
	const db = env.DB;
	const notes: string[] = [];
	const token = `${cron}|${Date.now()}|${Math.random().toString(36).slice(2)}`;
	const medLas = async <T>(namn: string, fn: () => Promise<T>): Promise<T | "upptagen"> => {
		let tagit = false;
		try {
			tagit = await taLas(db, namn, token);
		} catch (err) {
			// Utan lås (t.ex. D1-fel) körs ändå: kön och bokföringen gör arbetet idempotent.
			notes.push(`låset ${namn} gick inte att ta (${kort(err)}); kördes ändå`);
			return fn();
		}
		if (!tagit) return "upptagen";
		try {
			return await fn();
		} finally {
			await slappLas(db, namn, token).catch(() => {});
		}
	};
	if (arSynkCron(cron, (l) => notes.push(l))) {
		try {
			const r = await medLas("las_synk", () => deps.runSync({ DB: db, CACHE: env.CACHE, CONTACT_URL: env.CONTACT_URL, SEMANTIC_LAN: env.SEMANTIC_LAN }));
			out.synk = r === "upptagen" ? { fel: "en annan synkkörning pågår" } : { status: r.status, nya: r.nya, andrade: r.andrade, borttagna: r.borttagna, kvar: r.kvar, fel: r.fel.length };
		} catch (err) {
			out.synk = { fel: kort(err) };
		}
	} else out.synk = "ej_schemalagd";
	if (env.AI && env.VECTORIZE) {
		const ai = env.AI;
		const vec = env.VECTORIZE;
		try {
			const r = await medLas("las_inbaddning", () => deps.runEmbedBatch({ DB: db, AI: ai, VECTORIZE: vec, SEMANTIC_LAN: env.SEMANTIC_LAN }, { max: EMBED_MAX }));
			out.inbaddning = r === "upptagen" ? { fel: "en annan inbäddningskörning pågår" } : { inbaddade: r.inbaddade, vektorer: r.vektorer, borttagna: r.borttagna, klar: r.klar, ...(r.fel ? { fel_texter: r.fel } : {}) };
		} catch (err) {
			out.inbaddning = { fel: kort(err) };
		}
	}
	deps.log(`schemalagd körning ${cron}: ${JSON.stringify({ synk: out.synk, inbaddning: out.inbaddning, ...(notes.length ? { obs: notes } : {}) })}`);
	return out;
}
