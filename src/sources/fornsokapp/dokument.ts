/**
 * Tolkning av Fornsök-appens dokumentlista och versionshistorik (odokumenterat,
 * SPEC 4). Fältnamnen är verifierade mot inspelade svar i test/fixtures
 * (`app-dokument-*.json`, `app-version-*.json`).
 *
 * Dokumentsvaret har fyra grupper med samma postform: `inventeringsbocker`,
 * `handelseloggar`, `bilder`, `maritim_dokumentation`. De två sista var tomma i
 * alla inspelade svar; formen antas vara densamma.
 */
import type { Dokument, DokumentFil, DokumentGrupp, DokumentLista, Version } from "../types";

type Obj = Record<string, unknown>;

const GRUPPER: Array<[string, DokumentGrupp]> = [
	["inventeringsbocker", "inventeringsbok"],
	["handelseloggar", "handelselogg"],
	["bilder", "bild"],
	["maritim_dokumentation", "maritim_dokumentation"],
];

/** Appens fil-id är base64. Annat godtas inte (och kan då inte hämtas). */
export const FIL_ID_RE = /^[A-Za-z0-9+/]{1,200}={0,2}$/;
const DOKUMENTSIDA_RE = /^https:\/\/pub\.raa\.se\/dokumentation\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Högst så många dokument per lämning tas med (skydd mot orimliga svar). */
export const MAX_DOKUMENT = 200;

function s(x: unknown, max = 500): string | null {
	return typeof x === "string" && x.trim().length > 0 ? x.trim().slice(0, max) : null;
}
function n(x: unknown): number | null {
	return typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null;
}
function arr(x: unknown): Obj[] {
	return Array.isArray(x) ? (x.filter((v) => v !== null && typeof v === "object") as Obj[]) : [];
}

function hasControlChar(t: string): boolean {
	for (let i = 0; i < t.length; i++) {
		const c = t.charCodeAt(i);
		if (c < 0x20 || c === 0x7f) return true;
	}
	return false;
}

function parseFil(x: unknown): DokumentFil | null {
	if (x === null || typeof x !== "object") return null;
	const f = x as Obj;
	const id = s(f.id, 300);
	const namn = s(f.namn, 300);
	if (!id || !namn || !FIL_ID_RE.test(id)) return null;
	// Filnamnet hamnar i en sökväg: inga snedstreck, bakstreck eller styrtecken.
	if (/[/\\]/.test(namn) || hasControlChar(namn) || namn === "." || namn === "..") return null;
	return { id, namn, typ: s(f.typ, 20)?.toLowerCase() ?? null, storlek_byte: n(f.storlek), skapad: s(f.skapad_datum, 30) };
}

export function parseDokumentLista(uuid: string, d: Obj): DokumentLista {
	const dokument: Dokument[] = [];
	for (const [key, grupp] of GRUPPER) {
		for (const item of arr(d[key])) {
			if (dokument.length >= MAX_DOKUMENT) break;
			const uri = s(item.uri);
			dokument.push({
				grupp,
				titel: s(item.titel),
				typ: s(item.lamningsinformationstyp, 100),
				skapad: s(item.skapad_datum, 30),
				url: uri && DOKUMENTSIDA_RE.test(uri) ? uri : null,
				fil: parseFil(item.fil),
			});
		}
	}
	return { uuid, lamningsnummer: s(d.lamningsnummer, 30), dokument };
}

/** Versionshistorik, nyast först. */
export function parseVersioner(data: unknown): Version[] {
	const out: Version[] = arr(data).map((v) => {
		const a = (v.aktivitetsref ?? null) as Obj | null;
		const typ = s(a?.aktivitetstyp, 50);
		return {
			version_id: n(v.version_id),
			publicerad: s(v.publiceringsdatum, 40),
			registrerare: s(v.registrerare_organisationsnamn, 200),
			aktivitet: a
				? {
						typ: typ === "Atgard" ? "Åtgärd" : typ,
						nummer: s(a.atgardsnummer, 50) ?? s(a.uppdragsnummer, 50),
						atgardstyp: s(a.atgardtyp_namn, 200),
						beskrivning: s(a.beskrivning, 1000),
						registrerad: s(a.registreringstid, 40),
					}
				: null,
		};
	});
	return out.sort((x, y) => (y.publicerad ?? "").localeCompare(x.publicerad ?? ""));
}
