/**
 * Texten som bäddas in (SPEC 5.2): typ, namn, beskrivning, tradition, terräng,
 * med RAÄ:s standardfras om kvalitetssäkring borttagen. Lämningar utan
 * meningsfull text (bara typ, eller bara standardfrasen) bäddas inte in.
 *
 * Varianter av standardfrasen i Dalarnas län (GeoPackage 2026-11-17, 17 228 av
 * 32 743 beskrivningar har någon av dem):
 *   "Beskrivningen är inte kvalitetssäkrad. Information kan saknas, vara
 *    felaktig eller inaktuell. Se även Inventeringsbok."           (17 191)
 *   "Beskrivningen är delvis kvalitetssäkrad. … Se även Inventeringsbok."
 *   "Beskrivningen är inte helt kvalitetssäkrad. … Se även Inventeringsbok
 *    samt kommentar till inmätning."
 *   "Beskrivningen är inte kvalitetssäkrad. Se även Inventeringsbok."
 * Frasen står först eller sist (någon gång mitt i). "Äldre ej kvalitetssäkrad
 * beskrivning följer nedan" är en rubrik i texten och lämnas kvar.
 */

export const STANDARDFRAS_RE =
	/Beskrivningen är (?:inte helt|inte|delvis) kvalitetssäkrad\.(?:\s*Information kan saknas, vara felaktig eller inaktuell\.?)?(?:\s*Se även Inventeringsbok[^.\n]*\.?)?/g;

/** Högsta textlängd i tecken. bge-m3 läser 512 token per text (resten kortas av modellen med truncate_inputs). */
export const MAX_TEXT_TECKEN = 1800;
/** Minst så många bokstäver utöver typen för att texten ska räknas som meningsfull. */
export const MIN_BOKSTAVER = 12;

export function rensa(s: string | null | undefined): string | null {
	if (!s) return null;
	const t = s.replace(STANDARDFRAS_RE, " ").replace(/\s+/g, " ").trim();
	return t.length ? t : null;
}

export interface TextKalla {
	lamningstyp: string | null;
	namn: string | null;
	beskrivning: string | null;
	tradition: string | null;
	terrang: string | null;
}

/** Texten att bädda in, eller null om lämningen saknar meningsfull text. */
export function inbaddningstext(r: TextKalla): string | null {
	const namn = rensa(r.namn);
	const besk = rensa(r.beskrivning);
	const trad = rensa(r.tradition);
	const terr = rensa(r.terrang);
	const innehall = [namn, besk, trad, terr].filter(Boolean).join(" ");
	if ((innehall.match(/\p{L}/gu)?.length ?? 0) < MIN_BOKSTAVER) return null;
	const delar = [
		r.lamningstyp ? `${r.lamningstyp.trim()}.` : null,
		namn ? `Namn: ${namn}.` : null,
		besk,
		trad ? `Tradition: ${trad}` : null,
		terr ? `Terräng: ${terr}` : null,
	].filter((x): x is string => !!x);
	let t = delar.join(" ").replace(/\.\./g, ".");
	if (t.length > MAX_TEXT_TECKEN) {
		const cut = t.slice(0, MAX_TEXT_TECKEN);
		const sp = cut.lastIndexOf(" ");
		t = sp > MAX_TEXT_TECKEN * 0.8 ? cut.slice(0, sp) : cut;
	}
	return t;
}
