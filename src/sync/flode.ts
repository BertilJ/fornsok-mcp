/**
 * RAÄ:s ändringsflöde för lämningar (SPEC 4, 5.3):
 *   GET https://pub.raa.se/datauttag/lamningar?from=ÅÅÅÅ-MM-DD&to=ÅÅÅÅ-MM-DD&page=N&size=M
 *
 * Enligt OpenAPI-beskrivningen (pub.raa.se/datauttag/swagger/swagger.yaml,
 * läst 2026-11-17): from/to är datum, båda inklusive, och "endast förflutna
 * datum är tillåtna"; page är nollbaserad; size högst 10 000. Svaret är
 * sidindelat (content, totalPages, last, …) och varje post har id (UUID),
 * lamningsnummer och uppdateringstyp – en LISTA med NY, UTGAR,
 * UPPDATERAD_ANTIKVARISK_BEDOMNING, UPPDATERAD_GEOMETRI,
 * UPPDATERAD_LAMNINGSTYP, UPPDATERAD_LAGE, UPPDATERAD_PLACERING eller
 * OVRIG_UPPDATERING. Posten har också geometri och några attribut men ingen
 * beskrivningstext, därför hämtas hela posten från Fornsök-appen.
 */
import { UpstreamError } from "../errors";
import { checkAllowed } from "../upstream/allowlist";
import type { UpstreamClient } from "../upstream/client";

export const FLODE_URL = "https://pub.raa.se/datauttag/lamningar";
/** Sidstorlek: en sida ≈ 1,8 kB per post, 500 poster ≈ 1 MB. */
export const FLODE_SIDSTORLEK = 500;
/** Högst så många sidor per intervall (skydd mot ett trasigt `totalPages`). */
export const FLODE_MAX_SIDOR = 200;
/** Största sidstorlek som flödet tillåter (OpenAPI-beskrivningen). */
export const FLODE_MAX_STORLEK = 10_000;

/**
 * Intervallet har fler sidor än FLODE_MAX_SIDOR med den sidstorleken. Ingen
 * post har lästs ut (trunkeras aldrig); anroparen delar intervallet eller
 * höjer sidstorleken (src/sync/run.ts).
 */
export class ForMangaSidorError extends UpstreamError {
	constructor(
		message: string,
		readonly totalPages: number,
		readonly totalElements: number | null,
	) {
		super("raa_datauttag", message);
		this.name = "ForMangaSidorError";
	}
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface FlodePost {
	uuid: string;
	lamningsnummer: string | null;
	typer: string[];
	utgar: boolean;
}

export interface FlodeSida {
	poster: FlodePost[];
	totalPages: number;
	totalElements: number | null;
	last: boolean;
}

type Obj = Record<string, unknown>;

/** Tolka en sida. Poster utan giltigt UUID hoppas över. */
export function parseFlodeSida(data: unknown): FlodeSida {
	if (!data || typeof data !== "object" || Array.isArray(data))
		throw new Error("ändringsflödet svarade med oväntad form");
	const d = data as Obj;
	if (!Array.isArray(d.content)) throw new Error("ändringsflödet saknar content");
	const poster: FlodePost[] = [];
	for (const c of d.content as Obj[]) {
		if (!c || typeof c !== "object") continue;
		const id = typeof c.id === "string" ? c.id.trim() : "";
		if (!UUID_RE.test(id)) continue;
		const raw = Array.isArray(c.uppdateringstyp)
			? c.uppdateringstyp
			: typeof c.uppdateringstyp === "string"
				? [c.uppdateringstyp]
				: [];
		const typer = [
			...new Set(
				raw.filter((t): t is string => typeof t === "string" && /^[A-Z_]{1,60}$/.test(t)),
			),
		];
		poster.push({
			uuid: id.toLowerCase(),
			lamningsnummer: typeof c.lamningsnummer === "string" ? c.lamningsnummer : null,
			typer,
			utgar: typer.includes("UTGAR"),
		});
	}
	const totalPages =
		typeof d.totalPages === "number" && Number.isFinite(d.totalPages)
			? Math.max(0, Math.trunc(d.totalPages))
			: 1;
	return {
		poster,
		totalPages,
		totalElements: typeof d.totalElements === "number" ? d.totalElements : null,
		last: typeof d.last === "boolean" ? d.last : true,
	};
}

export function flodeUrl(fran: string, till: string, sida: number, storlek: number): string {
	if (!DATUM_RE.test(fran) || !DATUM_RE.test(till))
		throw new Error("ogiltigt datum till ändringsflödet");
	return `${FLODE_URL}?from=${fran}&to=${till}&page=${Math.trunc(sida)}&size=${Math.trunc(storlek)}`;
}

/**
 * Hämta alla sidor för [fran, till]. Poster som förekommer flera gånger slås
 * ihop (typerna förenas). `paus` väntar mellan sidorna.
 */
export async function hamtaFlode(
	client: UpstreamClient,
	fran: string,
	till: string,
	opts: { storlek?: number; paus?: () => Promise<void> } = {},
): Promise<{ poster: FlodePost[]; sidor: number }> {
	const storlek = opts.storlek ?? FLODE_SIDSTORLEK;
	const byUuid = new Map<string, FlodePost>();
	let sida = 0;
	let totalPages = 1;
	while (sida < totalPages && sida < FLODE_MAX_SIDOR) {
		if (sida > 0) await opts.paus?.();
		const url = flodeUrl(fran, till, sida, storlek);
		const source = checkAllowed("GET", url).source;
		const r = await client.get(url);
		if (r.status >= 400) {
			throw new UpstreamError(
				source,
				`Ändringsflödet svarade ${r.status} för ${fran}–${till}`,
				r.status,
			);
		}
		let data: unknown;
		try {
			data = JSON.parse(r.body);
		} catch {
			throw new UpstreamError(source, "Ändringsflödet svarade inte med JSON", r.status);
		}
		const s = parseFlodeSida(data);
		for (const p of s.poster) {
			const prev = byUuid.get(p.uuid);
			if (!prev) byUuid.set(p.uuid, p);
			else {
				prev.typer = [...new Set([...prev.typer, ...p.typer])];
				prev.utgar = prev.typer.includes("UTGAR");
				prev.lamningsnummer ??= p.lamningsnummer;
			}
		}
		totalPages = s.totalPages;
		sida++;
		// Trunkera aldrig tyst: då skulle markören flyttas förbi ändringar som inte lästs.
		// Syns det redan på första sidan avbryts det direkt, utan att resten läses.
		if (!s.last && s.poster.length > 0 && totalPages > FLODE_MAX_SIDOR) {
			throw new ForMangaSidorError(
				`Ändringsflödet för ${fran}–${till} har ${totalPages} sidor, fler än ${FLODE_MAX_SIDOR} som läses per intervall; kortare intervall eller större sidor behövs`,
				totalPages,
				s.totalElements,
			);
		}
		if (s.last || s.poster.length === 0) break;
	}
	return { poster: [...byUuid.values()], sidor: sida };
}
