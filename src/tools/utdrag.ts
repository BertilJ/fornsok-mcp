import { BOILERPLATE_RE, rad } from "./common";

/**
 * Ett utdrag på cirka `len` tecken runt första träffen på något av orden,
 * annars början av texten. Standardfrasen om kvalitetssäkring tas bort.
 */
export function makeUtdrag(text: string | null | undefined, words: readonly string[] = [], len = 200): string | null {
	if (!text) return null;
	// rad(): styrtecken och radbrytningar bort, «» → ‹› (extern text, se common.ts).
	const clean = rad(text.replace(BOILERPLATE_RE, "")).replace(/\s+/g, " ").trim();
	if (!clean) return null;
	if (clean.length <= len) return clean;
	const lower = clean.toLocaleLowerCase("sv");
	let pos = -1;
	for (const w of words) {
		const i = lower.indexOf(w.replace(/\*/g, "").toLocaleLowerCase("sv"));
		if (i >= 0 && (pos < 0 || i < pos)) pos = i;
	}
	let start = pos < 0 ? 0 : Math.max(0, pos - Math.floor(len / 3));
	let end = Math.min(clean.length, start + len);
	start = Math.max(0, end - len);
	// Justera till ordgränser.
	if (start > 0) {
		const sp = clean.indexOf(" ", start);
		if (sp > 0 && sp - start < 20) start = sp + 1;
	}
	if (end < clean.length) {
		const sp = clean.lastIndexOf(" ", end);
		if (sp > start && end - sp < 20) end = sp;
	}
	return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
}
