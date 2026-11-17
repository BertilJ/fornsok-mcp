/**
 * CQL2-text för OGC API Features (GeoServer). Bara likhet och OR/AND över
 * kända egenskaper; värden citeras med `'` och inre `'` dubbleras.
 * Egenskapsnamn tas aldrig från indata.
 */

export const OGC_PROPERTIES = ["lamningstyp", "antikvariskbedomning", "lamningsnummer", "kommun", "lan"] as const;
export type OgcProperty = (typeof OGC_PROPERTIES)[number];

export function cqlString(value: string): string {
	// Styrtecken tas bort; `'` dubbleras enligt CQL2.
	// oxlint-disable-next-line no-control-regex
	const clean = value.replace(/[\u0000-\u001f\u007f]/g, "");
	return `'${clean.replace(/'/g, "''")}'`;
}

export function eqAny(property: OgcProperty, values: readonly string[]): string {
	if (!(OGC_PROPERTIES as readonly string[]).includes(property)) throw new Error(`Okänd egenskap: ${property}`);
	const parts = values.map((v) => `${property} = ${cqlString(v)}`);
	return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
}

/** Bygg ett filter av villkor; tomma listor hoppas över. Returnerar null om inget filter behövs. */
export function buildCql2(conditions: Partial<Record<OgcProperty, readonly string[]>>): string | null {
	const parts: string[] = [];
	for (const p of OGC_PROPERTIES) {
		const vals = conditions[p];
		if (vals && vals.length > 0) {
			const c = eqAny(p, vals);
			parts.push(vals.length > 1 ? c : `(${c})`);
		}
	}
	if (parts.length === 0) return null;
	return parts.join(" AND ");
}
