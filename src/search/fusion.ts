/**
 * Sammanslagning av rangordningar med reciprocal rank fusion (SPEC 5.2):
 *
 *   poäng(d) = Σ_listor 1 / (k + rang_lista(d))
 *
 * med rang från 1. Bara rangen räknas, inte kanalernas egna poäng, så ordsökens
 * bm25 och den semantiska likheten behöver inte vara jämförbara. k = 60 är
 * standardvärdet från Cormack, Clarke & Büttcher (2009); ett större k jämnar ut
 * skillnaden mellan topp och svans.
 */

export const RRF_K = 60;

export interface FusedItem {
	id: string;
	/** Summerad RRF-poäng. */
	score: number;
	/** Rang (från 1) i varje lista där id:t fanns, i samma ordning som listorna. null = saknas i listan. */
	ranks: Array<number | null>;
}

/**
 * Slå ihop rangordnade listor av id. Dubbletter inom en lista räknas vid sin
 * första förekomst. Lika poäng avgörs av bästa rang i någon lista, sedan av
 * ordningen i den första listan där id:t förekommer (stabilt och
 * deterministiskt).
 */
export function reciprocalRankFusion(lists: ReadonlyArray<ReadonlyArray<string>>, k: number = RRF_K): FusedItem[] {
	if (!Number.isFinite(k) || k < 0) throw new RangeError("k ska vara ett icke-negativt tal.");
	const items = new Map<string, FusedItem & { firstSeen: number }>();
	let seq = 0;
	lists.forEach((list, li) => {
		const seen = new Set<string>();
		let rank = 0;
		for (const id of list) {
			if (seen.has(id)) continue;
			seen.add(id);
			rank++;
			let it = items.get(id);
			if (!it) {
				it = { id, score: 0, ranks: lists.map(() => null), firstSeen: seq++ };
				items.set(id, it);
			}
			it.ranks[li] = rank;
			it.score += 1 / (k + rank);
		}
	});
	const bestRank = (x: FusedItem) => Math.min(...x.ranks.map((r) => r ?? Number.POSITIVE_INFINITY));
	return [...items.values()]
		.sort((a, b) => b.score - a.score || bestRank(a) - bestRank(b) || a.firstSeen - b.firstSeen)
		.map(({ id, score, ranks }) => ({ id, score, ranks }));
}
