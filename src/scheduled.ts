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
 * Ett fel i den ena hindrar inte den andra. En loggrad per körning.
 * Den schemalagda vägen har ingen HTTP-förfrågan och går därför inte genom
 * Access-kontrollen; fetch-vägen i index.ts är oförändrat skyddad.
 */
import { runEmbedBatch } from "./semantic";
import { runSync } from "./sync";
import type { WorkerEnv } from "./env";

export const SYNC_CRON = "40 3-6 * * *";
export const EMBED_MAX = 1500;

export interface ScheduledDeps {
	runSync: typeof runSync;
	runEmbedBatch: typeof runEmbedBatch;
	log: (line: string) => void;
}

export interface ScheduledOutcome {
	cron: string;
	synk: "hoppad" | "ej_schemalagd" | { status: string; nya: number; andrade: number; borttagna: number; kvar: number; fel: number } | { fel: string };
	inbaddning: "hoppad" | { inbaddade: number; vektorer: number; borttagna: number; klar: boolean } | { fel: string };
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
	if (cron === SYNC_CRON) {
		try {
			const r = await deps.runSync({ DB: env.DB, CACHE: env.CACHE, CONTACT_URL: env.CONTACT_URL, SEMANTIC_LAN: env.SEMANTIC_LAN });
			out.synk = { status: r.status, nya: r.nya, andrade: r.andrade, borttagna: r.borttagna, kvar: r.kvar, fel: r.fel.length };
		} catch (err) {
			out.synk = { fel: kort(err) };
		}
	} else out.synk = "ej_schemalagd";
	if (env.AI && env.VECTORIZE) {
		try {
			const r = await deps.runEmbedBatch({ DB: env.DB, AI: env.AI, VECTORIZE: env.VECTORIZE, SEMANTIC_LAN: env.SEMANTIC_LAN }, { max: EMBED_MAX });
			out.inbaddning = { inbaddade: r.inbaddade, vektorer: r.vektorer, borttagna: r.borttagna, klar: r.klar };
		} catch (err) {
			out.inbaddning = { fel: kort(err) };
		}
	}
	deps.log(`schemalagd körning ${cron}: ${JSON.stringify({ synk: out.synk, inbaddning: out.inbaddning })}`);
	return out;
}
