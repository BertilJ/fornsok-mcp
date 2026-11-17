/** Datum i svensk tid för nattsynken. */

/** Datum (ÅÅÅÅ-MM-DD) och minuter efter midnatt i svensk tid. */
export function stockholmNu(now: Date): { datum: string; minuter: number } {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Europe/Stockholm",
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).formatToParts(now);
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
	return {
		datum: `${get("year")}-${get("month")}-${get("day")}`,
		minuter: Number(get("hour")) * 60 + Number(get("minute")),
	};
}

export function laggTillDagar(datum: string, n: number): string {
	const [y, m, d] = datum.split("-").map(Number);
	const t = new Date(Date.UTC(y, m - 1, d + n));
	return t.toISOString().slice(0, 10);
}

/** Ändringsflödet uppdateras nattligen 00–04 (SPEC 5.3); efter 04:30 räknas gårdagen som klar. */
export const FLODE_KLART_MINUTER = 4 * 60 + 30;

/** Senaste dag vars ändringar är kompletta i flödet. */
export function senasteKlaraDag(now: Date): string {
	const { datum, minuter } = stockholmNu(now);
	return laggTillDagar(datum, minuter >= FLODE_KLART_MINUTER ? -1 : -2);
}

export function arDatum(s: unknown): s is string {
	return (
		typeof s === "string" &&
		/^\d{4}-\d{2}-\d{2}$/.test(s) &&
		!Number.isNaN(Date.parse(`${s}T00:00:00Z`))
	);
}

/** Antal dagar från a till b (b − a). */
export function dagarMellan(a: string, b: string): number {
	return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
