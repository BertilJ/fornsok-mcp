/**
 * Namnuppslag: normalisering, närmaste förslag och den fasta länstabellen.
 */

export function normalizeName(s: string): string {
	return s.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("sv");
}

/** Levenshtein-avstånd (ord för ord är onödigt; namnen är korta). */
export function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		for (let j = 1; j <= b.length; j++) {
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		prev = cur;
	}
	return prev[b.length];
}

/**
 * Närmaste namn till `input` bland `names`: först namn som börjar med eller
 * innehåller indata, sedan efter redigeringsavstånd. Högst `max` förslag.
 */
export function suggest(input: string, names: readonly string[], max = 3): string[] {
	const q = normalizeName(input);
	if (!q) return [];
	const scored = names.map((name) => {
		const n = normalizeName(name);
		let score = levenshtein(q, n);
		if (n.startsWith(q) || q.startsWith(n)) score = Math.min(score, 1);
		else if (n.includes(q) || q.includes(n)) score = Math.min(score, 2);
		return { name, score };
	});
	const limit = Math.max(2, Math.ceil(q.length / 3));
	return [...new Set(scored.filter((s) => s.score <= limit).sort((a, b) => a.score - b.score || a.name.localeCompare(b.name, "sv")).map((s) => s.name))].slice(0, max);
}

export function didYouMean(suggestions: readonly string[]): string {
	if (suggestions.length === 0) return "";
	return ` Menade du: ${suggestions.map((s) => `"${s}"`).join(", ")}?`;
}

// ---------------------------------------------------------------- län

export interface LanInfo {
	kod: string;
	/** Namnet i K-samsök och Fornsök (t.ex. "Dalarna"). */
	namn: string;
	bokstav: string;
	/** Fullständigt namn ("Dalarnas län"). */
	fullt: string;
	alias?: string[];
}

/** Fast tabell: K-samsök och Fornsök använder kortformen ("Dalarna", inte "Dalarnas län"). */
export const LAN: readonly LanInfo[] = [
	{ kod: "01", namn: "Stockholm", bokstav: "AB", fullt: "Stockholms län" },
	{ kod: "03", namn: "Uppsala", bokstav: "C", fullt: "Uppsala län" },
	{ kod: "04", namn: "Södermanland", bokstav: "D", fullt: "Södermanlands län" },
	{ kod: "05", namn: "Östergötland", bokstav: "E", fullt: "Östergötlands län" },
	{ kod: "06", namn: "Jönköping", bokstav: "F", fullt: "Jönköpings län" },
	{ kod: "07", namn: "Kronoberg", bokstav: "G", fullt: "Kronobergs län" },
	{ kod: "08", namn: "Kalmar", bokstav: "H", fullt: "Kalmar län" },
	{ kod: "09", namn: "Gotland", bokstav: "I", fullt: "Gotlands län" },
	{ kod: "10", namn: "Blekinge", bokstav: "K", fullt: "Blekinge län" },
	{ kod: "12", namn: "Skåne", bokstav: "M", fullt: "Skåne län" },
	{ kod: "13", namn: "Halland", bokstav: "N", fullt: "Hallands län" },
	{ kod: "14", namn: "Västra Götaland", bokstav: "O", fullt: "Västra Götalands län" },
	{ kod: "17", namn: "Värmland", bokstav: "S", fullt: "Värmlands län" },
	{ kod: "18", namn: "Örebro", bokstav: "T", fullt: "Örebro län" },
	{ kod: "19", namn: "Västmanland", bokstav: "U", fullt: "Västmanlands län" },
	{ kod: "20", namn: "Dalarna", bokstav: "W", fullt: "Dalarnas län", alias: ["Kopparbergs län"] },
	{ kod: "21", namn: "Gävleborg", bokstav: "X", fullt: "Gävleborgs län" },
	{ kod: "22", namn: "Västernorrland", bokstav: "Y", fullt: "Västernorrlands län" },
	{ kod: "23", namn: "Jämtland", bokstav: "Z", fullt: "Jämtlands län" },
	{ kod: "24", namn: "Västerbotten", bokstav: "AC", fullt: "Västerbottens län" },
	{ kod: "25", namn: "Norrbotten", bokstav: "BD", fullt: "Norrbottens län" },
];

const LAN_INDEX: Map<string, LanInfo> = (() => {
	const m = new Map<string, LanInfo>();
	for (const l of LAN) {
		const keys = [l.namn, l.fullt, l.fullt.replace(/ län$/, ""), l.kod, String(Number(l.kod)), `${l.bokstav} län`, ...(l.alias ?? [])];
		for (const k of keys) m.set(normalizeName(k), l);
	}
	return m;
})();

/** "Dalarnas län", "dalarna", "20", "W län" → Dalarna. Ensam bokstavskod godtas också. */
export function findLan(input: string): LanInfo | null {
	const q = normalizeName(input);
	const hit = LAN_INDEX.get(q);
	if (hit) return hit;
	const byLetter = LAN.find((l) => l.bokstav.toLowerCase() === q);
	return byLetter ?? null;
}

export function lanByKod(kod: string): LanInfo | null {
	return LAN.find((l) => l.kod === kod) ?? null;
}

export function suggestLan(input: string): string[] {
	return suggest(input, [...LAN.map((l) => l.namn), ...LAN.map((l) => l.fullt)]).map((s) => findLan(s)?.namn ?? s).filter((v, i, a) => a.indexOf(v) === i);
}
