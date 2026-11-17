/**
 * `dokument_ref` (SPEC 6, 9.3): en ogenomskinlig referens som servern skapar i
 * `lamning_dokument`/`lamning` och tar emot i `hamta_dokument`.
 *
 * Innehåll: lämningens UUID och appens fil-id, base64url-kodat med ett
 * versionsprefix. Referensen är ingen adress och ingen behörighet: vid
 * hämtning valideras den strikt mot mönster, och filen slås sedan upp på nytt
 * i lämningens dokumentlista. Bara en fil som står i den listan kan hämtas,
 * och adressen byggs av servern mot dokumentändpunkten – som dessutom är
 * begränsad till bildfiler i listan över tillåtna anrop.
 */
import { ToolInputError } from "../errors";
import { FIL_ID_RE } from "../sources/fornsokapp/dokument";
import { UUID_RE } from "../upstream/allowlist";

const PREFIX = "dok1_";
const REF_RE = /^dok1_[A-Za-z0-9_-]{40,400}$/;

function b64urlEncode(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string | null {
	if (s.length % 4 === 1) return null;
	try {
		const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
		const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		return null;
	}
}

export function makeDokumentRef(uuid: string, filId: string): string {
	return PREFIX + b64urlEncode(`${uuid.toLowerCase()}|${filId}`);
}

export interface ParsedDokumentRef {
	uuid: string;
	filId: string;
}

const INVALID = "Ogiltig dokument_ref. Använd en referens exakt som den kom från lamning_dokument (eller lamning med inkludera dokument).";

export function parseDokumentRef(ref: string): ParsedDokumentRef {
	const r = typeof ref === "string" ? ref.trim() : "";
	if (!REF_RE.test(r)) throw new ToolInputError(INVALID);
	const text = b64urlDecode(r.slice(PREFIX.length));
	if (text === null) throw new ToolInputError(INVALID);
	const parts = text.split("|");
	if (parts.length !== 2) throw new ToolInputError(INVALID);
	const [uuid, filId] = parts;
	if (!UUID_RE.test(uuid) || uuid !== uuid.toLowerCase() || !FIL_ID_RE.test(filId)) throw new ToolInputError(INVALID);
	return { uuid, filId };
}
