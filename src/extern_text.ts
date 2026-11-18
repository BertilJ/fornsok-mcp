/**
 * Rensning av text från externa källor (registret, Fornsök-appen, K-samsök,
 * OpenStreetMap) innan den skrivs i ett svar (SPEC 9.3: registertext är data,
 * inte instruktioner, och märks som källtext). Används av verktygen
 * (tools/common.ts) och av indexets utdrag (store/index.ts).
 *
 * - Styrtecken (Unicode Cc utom tab och radbrytning, samt radavgränsarna
 *   U+2028/U+2029) blir blanksteg.
 * - Osynliga format- och riktningstecken (Unicode Cf: mjukt bindestreck,
 *   nollbreddstecken U+200B–U+200F, U+2060, U+FEFF, riktningsstyrning
 *   U+202A–U+202E och U+2066–U+2069, taggtecken U+E0000–U+E007F m.fl.) tas bort.
 * - Dessutom tecken som syns som tomrum eller inget alls men inte är Cf:
 *   variationsväljare (U+FE00–FE0F, U+E0100–E01EF), hangulfyllare (U+115F,
 *   U+1160, U+3164, U+FFA0), punktskriftens tomma cell (U+2800) och CGJ (U+034F).
 * - Kombinerande tecken (Unicode M) i följd begränsas till MAX_KOMBINERANDE
 *   (svensk text har efter NFC inga alls, men vokaliserad hebreiska med
 *   kantillationstecken, vietnamesiska och fonetisk transkription har 2–5 i
 *   följd; tusentals i rad kan dölja eller förvränga omgivande text).
 * - Efter att osynliga tecken tagits bort normaliseras texten till NFC igen,
 *   så att t.ex. a + U+200B + U+0308 blir ä och inte a + lös diakrit.
 * - Varje fält har en längdgräns (MAX_RAD_TECKEN för en rad, MAX_STYCKEN_TECKEN
 *   för flerradig text); längre text avkortas med en tydlig markering.
 * - Tecknen som svaren använder som avgränsning byts mot närliggande tecken:
 *   «» (citat) mot ‹›, och ⟦⟧ (sökträffar i utdrag) mot [], så att källtexten
 *   inte kan stänga ett citat eller förfalska en träffmarkering.
 */

// Cc utom \t \n \r (som hanteras för sig), och Zl/Zp.
// oxlint-disable-next-line no-control-regex -- styrtecken tas bort avsiktligt
const STYR = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g;
// oxlint-disable-next-line no-misleading-character-class -- variationsväljare och CGJ ska bort var för sig, inte som del av ett tecken
const OSYNLIGA = /[\p{Cf}\u{E0000}-\u{E007F}\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u115F\u1160\u3164\uFFA0\u2800\u034F]/gu;
/** Högst så många kombinerande tecken i följd behålls. */
export const MAX_KOMBINERANDE = 8;
const KOMBINERANDE = new RegExp(`(\\p{M}{${MAX_KOMBINERANDE}})\\p{M}+`, "gu");
/** Längsta fält på en rad (namn, titlar, motiveringar) efter rensning. */
export const MAX_RAD_TECKEN = 4000;
/** Längsta flerradiga fält (beskrivning, tradition …) efter rensning, alla stycken sammanlagt. */
export const MAX_STYCKEN_TECKEN = 20_000;

/** Markeringen när servern har avkortat ett fält. */
export function avkortning(kvar: number): string {
	return ` […avkortat av servern: ${kvar} tecken till]`;
}

/** Avkorta `s` till högst `max` UTF-16-enheter utan att dela ett surrogatpar. */
function klipp(s: string, max: number): string {
	let n = Math.max(0, max);
	const c = s.charCodeAt(n - 1);
	if (n > 0 && c >= 0xd800 && c <= 0xdbff) n--;
	return s.slice(0, n);
}
const RADBRYT = /\r\n?|\n|\u2028|\u2029/;

/** Början och slut på en sökträff i ett utdrag (aldrig kvar i rensad källtext). */
export const TRAFF_START = "⟦";
export const TRAFF_SLUT = "⟧";

/** Rensa utan att röra radbrytningar och blanksteg (för delar som sätts ihop). */
export function rensaTecken(s: string): string {
	return s
		.normalize("NFC")
		.replace(OSYNLIGA, "")
		.normalize("NFC")
		.replace(KOMBINERANDE, "$1")
		.replace(STYR, " ")
		.replace(/\t/g, " ")
		.replace(/«/g, "‹")
		.replace(/»/g, "›")
		.replace(/⟦/g, "[")
		.replace(/⟧/g, "]");
}

/** En rad: radbrytningar blir " / ", blanksteg slås ihop, högst `max` tecken (sedan avkortningsmarkering). */
export function rensaRad(s: string | null | undefined, max = MAX_RAD_TECKEN): string {
	if (!s) return "";
	const t = s
		.split(RADBRYT)
		.map((r) => rensaTecken(r).replace(/ {2,}/g, " ").trim())
		.filter((r) => r.length > 0)
		.join(" / ");
	if (t.length <= max) return t;
	const del = klipp(t, max).trimEnd();
	return `${del}${avkortning(t.length - del.length)}`;
}

/** Flera rader (stycken): varje icke-tom rad rensad för sig; högst `max` tecken sammanlagt. */
export function rensaStycken(s: string | null | undefined, max = MAX_STYCKEN_TECKEN): string[] {
	if (!s) return [];
	const rader = s
		.split(RADBRYT)
		.map((r) => rensaRad(r, Number.MAX_SAFE_INTEGER))
		.filter((r) => r.length > 0);
	const out: string[] = [];
	let kvar = max;
	for (let i = 0; i < rader.length; i++) {
		const r = rader[i];
		if (r.length <= kvar) {
			out.push(r);
			kvar -= r.length;
			continue;
		}
		const del = klipp(r, kvar).trimEnd();
		const resten = r.length - del.length + rader.slice(i + 1).reduce((a, x) => a + x.length, 0);
		out.push(`${del}${avkortning(resten)}`.trimStart());
		break;
	}
	return out;
}

/** Radbrytningar (efter rensaTecken) som " / ", tomma rader bort. */
export function radbrytningarTillSnedstreck(s: string): string {
	return s
		.split(RADBRYT)
		.map((r) => r.replace(/\s+/g, " ").trim())
		.filter((r) => r.length > 0)
		.join(" / ");
}
