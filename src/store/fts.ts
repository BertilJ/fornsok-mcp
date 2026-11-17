/**
 * FTS5-uttryck byggs här, aldrig av rå indata (SPEC 9.3).
 *
 * Beteende:
 * - Indata delas i ord (bokstäver, siffror, kombinerande tecken). Allt annat –
 *   citattecken, parenteser, kolon, minus, `^`, `+` – är skiljetecken. Ord som
 *   AND, OR, NOT och NEAR blir vanliga sökord, eftersom varje ord sätts inom
 *   citattecken.
 * - Orden OCH-kopplas (alla måste finnas, i valfri kolumn och ordning).
 * - `*` direkt efter ett ord gör det till prefixsökning ("hytt*" hittar hytta,
 *   hyttan, hyttområde). Prefix kortare än två tecken ignoreras (ordet söks då
 *   som helt ord).
 * - Ingen svensk stamning: "källa" hittar inte "källan" utan prefix. Gemener och
 *   versaler är lika; å, ä och ö skiljs från a och o (remove_diacritics 0).
 * - Högst MAX_TERMS ord; resten ignoreras.
 */

export const MAX_TERMS = 16;
export const MAX_TERM_LENGTH = 64;
export const MIN_PREFIX_LENGTH = 2;

export interface FtsTerm {
	term: string;
	prefix: boolean;
}

export interface FtsQuery {
	/** Uttrycket som binds till MATCH. */
	match: string;
	terms: FtsTerm[];
}

const WORD = /([\p{L}\p{N}\p{M}]+)(\*?)/gu;

/** Dela indata i sökord. */
export function tokenize(input: string): FtsTerm[] {
	const out: FtsTerm[] = [];
	const seen = new Set<string>();
	const s = input.normalize("NFC");
	for (const m of s.matchAll(WORD)) {
		let term = m[1].toLocaleLowerCase("sv");
		if (term.length > MAX_TERM_LENGTH) term = term.slice(0, MAX_TERM_LENGTH);
		const prefix = m[2] === "*" && term.length >= MIN_PREFIX_LENGTH;
		const key = `${term}${prefix ? "*" : ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ term, prefix });
		if (out.length >= MAX_TERMS) break;
	}
	return out;
}

/** FTS5-sträng: inom citattecken är allt bokstavligt utom `"`, som dubbleras. */
function quote(term: string): string {
	return `"${term.replace(/"/g, '""')}"`;
}

/**
 * Bygg ett FTS5-uttryck av fritext och/eller färdiga ord. Returnerar null om
 * inget sökbart ord finns.
 */
export function buildFtsQuery(fraga?: string | null, ord?: string[] | null): FtsQuery | null {
	const parts: string[] = [];
	if (fraga) parts.push(fraga);
	if (ord) parts.push(...ord.filter((o) => typeof o === "string"));
	const terms = tokenize(parts.join(" "));
	if (terms.length === 0) return null;
	const match = terms.map((t) => `${quote(t.term)}${t.prefix ? "*" : ""}`).join(" ");
	return { match, terms };
}
