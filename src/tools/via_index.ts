/**
 * Indexet först, levande källor som reserv (SPEC 8).
 *
 * - Saknas indexet (ingen D1-bindning), är det tomt, eller har det nyss
 *   fallerat: reserv direkt.
 * - Kastar indexvägen: ogiltiga indata (IndexInputError) blir ett verktygsfel,
 *   verktygsfel och fel från levande källor släpps igenom, allt annat stänger
 *   av indexet en stund och ger reserv.
 */
import { ToolInputError, UpstreamError } from "../errors";
import type { IndexOpen } from "../store/access";
import { IndexInputError } from "../store/d1";
import type { ToolDeps } from "./common";

export type OpenIndex = Extract<IndexOpen, { ok: true }>;

export async function viaIndex<T>(
	deps: ToolDeps,
	useIndex: (ix: OpenIndex) => Promise<T>,
	fallback: (orsak: string) => Promise<T>,
): Promise<T> {
	if (!deps.index) return fallback("indexet är inte inkopplat");
	const ix = await deps.index.open();
	if (!ix.ok) return fallback(ix.orsak);
	try {
		return await useIndex(ix);
	} catch (err) {
		if (err instanceof IndexInputError) throw new ToolInputError(err.message);
		if (err instanceof ToolInputError || err instanceof UpstreamError) throw err;
		deps.index.reportFailure(err);
		return fallback("indexanropet misslyckades");
	}
}

/** Öppna indexet utan reserv (för verktyg som kräver det, t.ex. statistik). */
export async function requireIndex(deps: ToolDeps, vad: string): Promise<OpenIndex> {
	const orsak = deps.index ? await deps.index.open() : { ok: false as const, orsak: "indexet är inte inkopplat" };
	if (orsak.ok) return orsak;
	throw new ToolInputError(
		`${vad} kräver serverns eget lämningsindex, som inte är tillgängligt just nu (${orsak.orsak}). Försök igen om en stund; sok_lamningar och lamningar_nara fungerar under tiden mot RAÄ:s levande källor.`,
	);
}

/** Kör en indexfråga i ett verktyg som kräver indexet: IndexInputError → verktygsfel, övriga fel → tydligt fel. */
export async function indexOnly<T>(deps: ToolDeps, vad: string, fn: (ix: OpenIndex) => Promise<T>): Promise<T> {
	const ix = await requireIndex(deps, vad);
	try {
		return await fn(ix);
	} catch (err) {
		if (err instanceof IndexInputError) throw new ToolInputError(err.message);
		if (err instanceof ToolInputError || err instanceof UpstreamError) throw err;
		deps.index?.reportFailure(err);
		throw new ToolInputError(`${vad}: indexanropet misslyckades. Försök igen om en stund.`);
	}
}
