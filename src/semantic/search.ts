/**
 * Semantisk sökning (SPEC 5.2): frågan bäddas in med samma modell som
 * lämningarna, Vectorize söker bland vektorerna med metadatafilter, och
 * träffarna slås ihop per lämning (en lämning i flera områden har flera
 * vektorer, se filter.ts).
 *
 * Vectorize (developers.cloudflare.com/vectorize/reference/client-api, läst
 * 2026-11-17): topK högst 100 utan värden/metadata (50 med); standard 5.
 * Här hämtas bara id och poäng (returnMetadata "none").
 */
import type { ResolvedSearchFilter, SemanticHit, SemanticSearch } from "../sources/types";
import { MODELL, type SemanticEnv, vektorerUrSvar } from "./bindings";
import { scopeCovers as covers } from "./coverage";
import { tillVectorizeFilter, uuidUrId } from "./filter";
import { parseScope, type Scope, scopeText } from "./scope";

export const MAX_TOPK = 100;
export const MAX_FRAGA_TECKEN = 1000;

/**
 * Sök. Returnerar högst `topK` lämningar, bäst först, med likheten (cosinus,
 * högre är bättre). Filtrets geografiska och typ-/bedömningsdelar tillämpas
 * före likhetssökningen; övrigt (kategori, egenskap, nummer, nara/bbox) måste
 * anroparen kontrollera i indexet. Kastar vid fel i AI eller Vectorize.
 */
export async function semanticSearch(
	env: SemanticEnv,
	fraga: string,
	filter: ResolvedSearchFilter,
	topK: number,
): Promise<SemanticHit[]> {
	if (!env.AI || !env.VECTORIZE)
		throw new Error("semantisk sökning: bindningarna AI och VECTORIZE saknas");
	const q = fraga.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, MAX_FRAGA_TECKEN);
	if (!q) return [];
	const k = Math.max(1, Math.min(MAX_TOPK, Math.trunc(topK)));
	const svar = await env.AI.run(MODELL, { text: [q], truncate_inputs: true });
	const [vektor] = vektorerUrSvar(svar, 1);
	const { filter: vf } = tillVectorizeFilter(filter);
	// Hämta lite fler än topK: en lämning kan ha flera vektorer.
	const matches = await env.VECTORIZE.query(vektor, {
		topK: Math.min(MAX_TOPK, k + Math.ceil(k / 4)),
		returnValues: false,
		returnMetadata: "none",
		...(vf ? { filter: vf } : {}),
	});
	const best = new Map<string, number>();
	for (const m of matches.matches ?? []) {
		if (typeof m.id !== "string" || typeof m.score !== "number") continue;
		const uuid = uuidUrId(m.id);
		const prev = best.get(uuid);
		if (prev === undefined || m.score > prev) best.set(uuid, m.score);
	}
	return [...best.entries()]
		.map(([uuid, score]) => ({ uuid, score }))
		.sort((a, b) => b.score - a.score || a.uuid.localeCompare(b.uuid))
		.slice(0, k);
}

/** Om frågans geografiska filter ligger helt inom omfånget i `env.SEMANTIC_LAN`. */
export function scopeCovers(
	filter: ResolvedSearchFilter,
	scope: Scope | string | undefined = undefined,
): boolean {
	const s = typeof scope === "object" ? scope : parseScope(scope);
	return covers(filter, s);
}

/**
 * `SemanticSearch` för verktygen (src/sources/types.ts). Returnerar null om
 * AI eller VECTORIZE saknas – då används bara ordsök.
 */
export function createSemanticSearch(env: SemanticEnv): SemanticSearch | null {
	if (!env.AI || !env.VECTORIZE) return null;
	const scope = parseScope(env.SEMANTIC_LAN);
	if (scope.okanda.length)
		console.warn(`semantik: okända län i SEMANTIC_LAN ignoreras: ${scope.okanda.join(", ")}`);
	return {
		omfang: scopeText(scope),
		lan: scope.lan,
		scopeCovers: (filter) => covers(filter, scope),
		search: (fraga, filter, topK) => semanticSearch(env, fraga, filter, topK),
	};
}
