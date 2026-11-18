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
 * - Tecknen som svaren använder som avgränsning byts mot närliggande tecken:
 *   «» (citat) mot ‹›, och ⟦⟧ (sökträffar i utdrag) mot [], så att källtexten
 *   inte kan stänga ett citat eller förfalska en träffmarkering.
 */

// Cc utom \t \n \r (som hanteras för sig), och Zl/Zp.
// oxlint-disable-next-line no-control-regex -- styrtecken tas bort avsiktligt
const STYR = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g;
const OSYNLIGA = /[\p{Cf}\u{E0000}-\u{E007F}]/gu;
const RADBRYT = /\r\n?|\n|\u2028|\u2029/;

/** Början och slut på en sökträff i ett utdrag (aldrig kvar i rensad källtext). */
export const TRAFF_START = "⟦";
export const TRAFF_SLUT = "⟧";

/** Rensa utan att röra radbrytningar och blanksteg (för delar som sätts ihop). */
export function rensaTecken(s: string): string {
	return s
		.normalize("NFC")
		.replace(OSYNLIGA, "")
		.replace(STYR, " ")
		.replace(/\t/g, " ")
		.replace(/«/g, "‹")
		.replace(/»/g, "›")
		.replace(/⟦/g, "[")
		.replace(/⟧/g, "]");
}

/** En rad: radbrytningar blir " / ", blanksteg slås ihop. */
export function rensaRad(s: string | null | undefined): string {
	if (!s) return "";
	return s
		.split(RADBRYT)
		.map((r) => rensaTecken(r).replace(/ {2,}/g, " ").trim())
		.filter((r) => r.length > 0)
		.join(" / ");
}

/** Flera rader (stycken): varje icke-tom rad rensad för sig. */
export function rensaStycken(s: string | null | undefined): string[] {
	if (!s) return [];
	return s
		.split(RADBRYT)
		.map((r) => rensaRad(r))
		.filter((r) => r.length > 0);
}

/** Radbrytningar (efter rensaTecken) som " / ", tomma rader bort. */
export function radbrytningarTillSnedstreck(s: string): string {
	return s
		.split(RADBRYT)
		.map((r) => r.replace(/\s+/g, " ").trim())
		.filter((r) => r.length > 0)
		.join(" / ");
}
