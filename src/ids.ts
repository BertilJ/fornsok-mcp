/**
 * Identiteter för en lämning (SPEC 4): lämningsnummer `L1946:7415`,
 * RAÄ-nummer `Stugun 114:1`, UUID, K-samsök-URI och publika länkar.
 * Indata valideras mot mönster innan de används i sökvägar (SPEC 9.3).
 */
import { ToolInputError } from "./errors";

export type ParsedId =
	| { kind: "uuid"; uuid: string; input: string }
	| { kind: "lamningsnummer"; value: string; input: string }
	| { kind: "raa_nummer"; value: string; input: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LAMNINGSNUMMER = /^L\d{4}:\d{1,6}$/i;
/** Socken/stad följt av nummer, t.ex. "Stora Kopparberg 172:1", "Stugun 114:1", "Bjursås 27:1". */
const RAA_NUMMER = /^[\p{L}][\p{L}\p{M} .'-]{0,60}? \d{1,5}(:\d{1,4})?$/u;
const URI_PATTERNS = [
	/^https?:\/\/kulturarvsdata\.se\/raa\/lamning\/(?:(?:html|xml|rdf|jsonld)\/)?([0-9a-f-]{36})$/i,
	/^https?:\/\/pub\.raa\.se\/(?:visa\/)?objekt\/lamning\/([0-9a-f-]{36})$/i,
	/^https?:\/\/app\.raa\.se\/open\/fornsok\/lamning\/([0-9a-f-]{36})$/i,
];

export function parseId(input: string): ParsedId {
	const s = input.normalize("NFC").trim().replace(/\s+/g, " ");
	if (UUID.test(s)) return { kind: "uuid", uuid: s.toLowerCase(), input };
	for (const re of URI_PATTERNS) {
		const m = re.exec(s);
		if (m && UUID.test(m[1])) return { kind: "uuid", uuid: m[1].toLowerCase(), input };
	}
	if (LAMNINGSNUMMER.test(s)) return { kind: "lamningsnummer", value: `L${s.slice(1)}`, input };
	if (RAA_NUMMER.test(s)) return { kind: "raa_nummer", value: s, input };
	throw new ToolInputError(
		`Kan inte tolka "${input}" som lämningsnummer (t.ex. L2001:646), RAÄ-nummer (t.ex. Bjursås 27:1), UUID eller K-samsök-URI.`,
	);
}
