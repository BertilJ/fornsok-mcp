/**
 * Neutralisering av text i kontrakttesternas sammanfattning (sammanfatta.mjs),
 * som skrivs till $GITHUB_STEP_SUMMARY och visas som Markdown med HTML.
 * Felraderna kan innehålla text ur RAÄ:s svar (t.ex. början av en HTML-sida
 * när en ändpunkt flyttats); den ska visas som text, aldrig tolkas som
 * Markdown, HTML, länkar eller omnämnanden.
 */

// oxlint-disable-next-line no-control-regex -- styrtecken tas bort avsiktligt
const STYR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
// Tecken med betydelse i Markdown (GFM): bakstreck-undantas.
const MARKDOWN = /[\\`*_{}[\]()#+\-.!|~>]/g;

/** HTML-tecken som entiteter (gäller även inuti <code>). */
export function html(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * En tabellcell eller listpunkt: en rad, högst 300 tecken, styrtecken bort,
 * HTML som entiteter, Markdown-tecken undantagna, @ och :// brutna så att
 * inga omnämnanden eller automatiska länkar uppstår.
 */
export function cell(s) {
	// \uE000 används nedan som tillfällig markör och får inte finnas i texten.
	let t = String(s).replace(STYR, " ").replace(/\uE000/g, "").replace(/\s+/g, " ").trim();
	if (t.length > 300) t = `${t.slice(0, 300)}…`;
	return html(t)
		.replace(/&(amp|lt|gt|quot);/g, "\uE000$1;")
		.replace(MARKDOWN, (c) => `\\${c}`)
		.replace(/\uE000(amp|lt|gt|quot);/g, "&$1;")
		.replace(/@/g, "&#64;")
		.replace(/:\/\//g, "&#58;//");
}

/** Ett fältnamn som kod: <code> med HTML-entiteter (Markdown tolkas inte där). */
export function kod(s) {
	let t = String(s).replace(STYR, " ").replace(/\s+/g, " ").trim();
	if (t.length > 200) t = `${t.slice(0, 200)}…`;
	return `<code>${html(t).replace(/\|/g, "&#124;").replace(/@/g, "&#64;")}</code>`;
}
