import { ToolInputError } from "../errors";
import { parseId } from "../ids";
import { IndexInputError } from "../store/d1";
import type { ToolDeps } from "./common";

/**
 * En identitet (lämningsnummer, RAÄ-nummer, UUID, URI) → UUID. Indexet först
 * (när det är laddat), sedan K-samsök. Okänd ger verktygsfel; ett RAÄ-nummer
 * som delas av flera lämningar ger fel med lämningsnumren att välja bland.
 */
export async function resolveOneUuid(input: string, deps: ToolDeps): Promise<string> {
	const p = parseId(input);
	if (p.kind === "uuid") return p.uuid;
	const vad = p.kind === "lamningsnummer" ? "lämningsnummer" : "RAÄ-nummer";
	if (deps.index) {
		const ix = await deps.index.open();
		if (ix.ok) {
			try {
				const uuids = (await ix.store.resolveIdsAll([p.value])).get(p.value) ?? [];
				if (uuids.length === 1) return uuids[0];
				if (uuids.length > 1) {
					const hits = await ix.store.hitsByUuids(uuids.slice(0, 100));
					const nr = uuids.map((u) => hits.get(u)?.lamningsnummer ?? u);
					throw new ToolInputError(
						`${vad} "${p.value}" delas av ${uuids.length} lämningar: ${nr.join(", ")}. Ange lämningsnummer för att välja en.`,
					);
				}
			} catch (err) {
				if (err instanceof ToolInputError) throw err;
				if (err instanceof IndexInputError) throw new ToolInputError(err.message);
				deps.index.reportFailure(err);
			}
		}
	}
	const found = await deps.ids.resolveNumbers([p.value]);
	const uuid = found.get(p.value);
	if (!uuid) {
		throw new ToolInputError(
			`Inget ${vad} "${p.value}" hittades (K-samsök ligger några dagar efter registret). Pröva med UUID eller sök med sok_lamningar.`,
		);
	}
	return uuid;
}
