import { ToolInputError } from "../errors";
import { parseId } from "../ids";
import type { ToolDeps } from "./common";

/** En identitet (lämningsnummer, RAÄ-nummer, UUID, URI) → UUID. Okänd ger verktygsfel. */
export async function resolveOneUuid(input: string, deps: ToolDeps): Promise<string> {
	const p = parseId(input);
	if (p.kind === "uuid") return p.uuid;
	const found = await deps.ids.resolveNumbers([p.value]);
	const uuid = found.get(p.value);
	if (!uuid) {
		throw new ToolInputError(
			`Inget ${p.kind === "lamningsnummer" ? "lämningsnummer" : "RAÄ-nummer"} "${p.value}" hittades i K-samsök (som ligger några dagar efter registret). Pröva med UUID eller sök med sok_lamningar.`,
		);
	}
	return uuid;
}
