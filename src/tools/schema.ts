/**
 * Strikta indataschemor: okända parametrar ska ge ett verktygsfel, inte tas
 * bort tyst (med `z.object` försvann t.ex. `radie` i lamningar_nara, och
 * sökningen gick med standardradien utan att någon märkte det). Felet namnger
 * nyckeln och föreslår närmaste giltiga parameter. JSON-schemat som klienten
 * ser får `additionalProperties: false`.
 */
import { z } from "zod";
import { levenshtein } from "../lookup/names";

/** Närmaste giltiga namn (redigeringsavstånd, eller samma början), om något är rimligt nära. */
export function narmasteParameter(okand: string, giltiga: readonly string[]): string | null {
	const q = okand.toLowerCase();
	let best: { namn: string; d: number } | null = null;
	for (const g of giltiga) {
		const n = g.toLowerCase();
		let d = levenshtein(q, n);
		if (n.startsWith(q) || q.startsWith(n)) d = Math.min(d, 1);
		if (!best || d < best.d) best = { namn: g, d };
	}
	return best && best.d <= Math.max(2, Math.ceil(q.length / 3)) ? best.namn : null;
}

export function okandaParametrar(var_: string, okanda: readonly string[], giltiga: readonly string[]): string {
	const delar = okanda.map((k) => {
		const n = narmasteParameter(k, giltiga);
		return `"${k}"${n ? ` (menade du "${n}"?)` : ""}`;
	});
	return `Okänd parameter ${delar.join(", ")} i ${var_}. Giltiga parametrar: ${giltiga.join(", ")}.`;
}

/** `z.strictObject` med svenskt fel för okända nycklar. */
export function strikt<T extends z.ZodRawShape>(var_: string, shape: T) {
	const giltiga = Object.keys(shape);
	return z.strictObject(shape, {
		error: (iss) => (iss.code === "unrecognized_keys" ? okandaParametrar(var_, iss.keys, giltiga) : undefined),
	});
}
