/**
 * Det semantiska omfånget (SPEC 5.2): en lista av län, inställningen
 * `SEMANTIC_LAN` (kommaseparerad, t.ex. "Dalarna" eller "Dalarna,Gävleborg").
 * Län anges med kortnamn, fullt namn eller länskod ("Dalarnas län", "20").
 */
import { findLan, LAN } from "../lookup/names";

export const DEFAULT_SEMANTIC_LAN = ["Dalarna"] as const;

export interface Scope {
	/** Län i omfånget, med indexets kortnamn ("Dalarna"), sorterade. */
	lan: string[];
	/** Län som inte gick att tolka (ignoreras; rapporteras i loggen). */
	okanda: string[];
}

export function parseScope(value?: string | null): Scope {
	if (value === undefined || value === null || !value.trim())
		return { lan: [...DEFAULT_SEMANTIC_LAN], okanda: [] };
	const lan: string[] = [];
	const okanda: string[] = [];
	for (const part of value.split(",")) {
		const t = part.trim();
		if (!t) continue;
		const hit = findLan(t);
		if (hit) {
			if (!lan.includes(hit.namn)) lan.push(hit.namn);
		} else okanda.push(t);
	}
	lan.sort((a, b) => a.localeCompare(b, "sv"));
	return { lan, okanda };
}

/** "Dalarnas län", "Dalarnas och Gävleborgs län". */
export function scopeText(scope: Scope): string {
	const full = scope.lan.map((n) => LAN.find((l) => l.namn === n)?.fullt ?? n);
	if (full.length === 0) return "inget län";
	if (full.length === 1) return full[0];
	const stems = full.map((f) => f.replace(/ län$/, ""));
	return `${stems.slice(0, -1).join(", ")} och ${stems[stems.length - 1]} län`;
}

/** Ligger en lämning (med län-listan `lan`) inom omfånget? */
export function inScope(scope: Scope, lan: readonly string[]): boolean {
	return lan.some((l) => scope.lan.includes(l));
}

/** Omfånget går inte att använda (tomt eller med län som inte gick att tolka). */
export class OmfangError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OmfangError";
	}
}

/**
 * Som parseScope, men kastar OmfangError om omfånget är tomt eller innehåller
 * okända län. Används av allt som skriver eller tar bort vektorer: ett
 * felstavat `SEMANTIC_LAN` ("Dalarn") gav annars ett tomt omfång, och
 * inbäddningen tog då bort alla vektorer som "utanför omfånget".
 */
export function checkedScope(value?: string | null): Scope {
	const s = parseScope(value);
	if (s.okanda.length)
		throw new OmfangError(
			`SEMANTIC_LAN innehåller län som inte gick att tolka: ${s.okanda.map((x) => `"${x}"`).join(", ")} (värde ${JSON.stringify(value ?? "")}). Inget görs förrän inställningen är rättad.`,
		);
	if (!s.lan.length) throw new OmfangError(`SEMANTIC_LAN ger ett tomt omfång (värde ${JSON.stringify(value ?? "")}). Inget görs förrän inställningen är rättad.`);
	return s;
}
