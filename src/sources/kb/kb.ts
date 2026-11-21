/**
 * KB Digitalt (Kungliga biblioteket), öppna data på https://data.kb.se.
 *
 * Inget API-nyckelkrav. Det som används (prövat mot tjänsten 2026-11-21):
 *
 * - `GET /search?q=…` – sökning, JSON-LD-liknande JSON med `total`, `hits`,
 *   `aggs` och `did_u_mean`. `searchGranularity=part` söker i OCR-texten och
 *   ger en träff per sida (med `snippets`, där sökordet står inom <em>), annars
 *   en träff per objekt (sökning i metadata: titel, ämne, upphov, genre/form,
 *   id). Filter: `from`/`to` (ÅÅÅÅ-MM-DD), `genreForm`, `isPartOf` (tidningens
 *   eller seriens titel), `inDataset` (samlingens URI). Sortering `_sort`.
 *   Frågan får använda AND, OR, NOT, parenteser, "fras", * och ? (KB:s
 *   söktips). `q` krävs (`*` = allt).
 * - `GET /{paket}.jsonld` – ett filpaket (dark-NNN): namn, rättigheter, länk
 *   till Libris och alla filer (bilder JP2, ALTO-XML, METS, ibland PDF).
 * - `GET /{paket}/{fil}` – en fil i paketet; här bara ALTO-XML (OCR-texten).
 * - IIIF Image API 3: `GET /iiif/3/{paket}%2F{fil}/full/{storlek}/0/default.jpg`.
 *
 * Sidnumret i en sidträff (`/part/P/page/N`) räknas per del (t.ex. bilaga);
 * filerna i paketet är numrerade löpande över alla delar. Därför används
 * bildnumret (siffrorna sist i bildfilens namn, `…_0005.jp2`) som sidans
 * nummer i det här projektet: det står i träffens `imageServiceId` och går
 * att slå upp i paketet.
 */
import { ToolInputError, UpstreamError } from "../../errors";
import type { UpstreamClient } from "../../upstream/client";

export const KB_DATA = "https://data.kb.se";
export const KB_DIGITALT = "https://digitalt.kb.se";
export const KB_KALLA = "Kungliga biblioteket, KB Digitalt (data.kb.se)";

/** Paket-id: `dark-` och siffror. */
export const KB_PAKET_RE = /^dark-\d{1,12}$/;

export const KB_SORTERING = ["relevans", "aldst", "nyast", "titel"] as const;
export type KbSortering = (typeof KB_SORTERING)[number];
const SORT_PARAM: Record<KbSortering, string | null> = { relevans: null, aldst: "datePublished", nyast: "-datePublished", titel: "title" };

export interface KbSokFraga {
	q: string;
	/** "sida": sök i OCR-texten (en träff per sida); "objekt": sök i metadata. */
	niva: "objekt" | "sida";
	fran?: string | null;
	till?: string | null;
	kategori?: string | null;
	titel?: string | null;
	samling?: string | null;
	sortering?: KbSortering;
	antal: number;
	start: number;
}

export function sokUrl(f: KbSokFraga): string {
	const u = new URL(`${KB_DATA}/search`);
	u.searchParams.set("q", f.q);
	if (f.niva === "sida") u.searchParams.set("searchGranularity", "part");
	if (f.fran) u.searchParams.set("from", f.fran);
	if (f.till) u.searchParams.set("to", f.till);
	if (f.kategori) u.searchParams.set("genreForm", f.kategori);
	if (f.titel) u.searchParams.set("isPartOf", f.titel);
	if (f.samling) u.searchParams.set("inDataset", f.samling);
	const sort = SORT_PARAM[f.sortering ?? "relevans"];
	if (sort) u.searchParams.set("_sort", sort);
	u.searchParams.set("limit", String(f.antal));
	if (f.start > 0) u.searchParams.set("offset", String(f.start));
	return u.href;
}

export function paketUrl(paket: string): string {
	return `${KB_DATA}/${paket}.jsonld`;
}

/** Adressen till en fil i ett paket; filnamnets snedstreck och kommatecken kodas. */
export function filUrl(paket: string, filnamn: string): string {
	return `${KB_DATA}/${paket}/${encodeURIComponent(filnamn)}`;
}

/** IIIF-bild av en bildfil i ett paket, högst `max` bildpunkter på längsta ledden. */
export function iiifUrl(paket: string, bildfil: string, max: number): string {
	return `${KB_DATA}/iiif/3/${encodeURIComponent(`${paket}/${bildfil}`)}/full/!${max},${max}/0/default.jpg`;
}

/** Sidan i KB Digitalts visare. */
export function visarUrl(paket: string, del = 1, sida = 1): string {
	return `${KB_DIGITALT}/${paket}/part/${del}/page/${sida}`;
}

/** Paket-id ur `dark-123`, `https://data.kb.se/dark-123…` eller `https://digitalt.kb.se/dark-123…`. */
export function parsePaketId(s: string): string {
	return parseKbLank(s).paket;
}

/** Paket-id, och del och sida när länken pekar på en sida (`…/dark-123/part/2/page/1`). */
export function parseKbLank(s: string): { paket: string; del: number | null; sida: number | null } {
	const t = s.trim();
	if (KB_PAKET_RE.test(t)) return { paket: t, del: null, sida: null };
	const m = /^https?:\/\/(?:data|digitalt)\.kb\.se\/(dark-\d{1,12})(?:\/part\/(\d{1,4})\/page\/(\d{1,5}))?(?:[/?#.]|$)/.exec(t);
	if (m) return { paket: m[1], del: m[2] ? Number(m[2]) : null, sida: m[3] ? Number(m[3]) : null };
	throw new ToolInputError(`Ogiltigt KB-id "${t.slice(0, 80)}": ange paketets id (t.ex. dark-13003706) eller en länk till data.kb.se/digitalt.kb.se.`);
}

// ------------------------------------------------------------------ rättigheter

export type KbAtkomst = "fritt" | "begransad" | "upphovsskyddat" | "okand";

export interface KbRattighet {
	atkomst: KbAtkomst;
	/** KB:s etikett, som i KB Digitalt. */
	etikett: string;
	/** Licensens eller märkets namn ordagrant, t.ex. "Public Domain Mark 1.0". */
	licens: string | null;
	licens_url: string | null;
}

interface RawPolicy {
	"@id"?: string | null;
	value?: string | null;
	prefLabelByLang?: { sv?: string | null; en?: string | null } | null;
}

/** Samma tolkning som KB Digitalt: första policyns `value` (Free, Restricted, annat). */
export function tolkaRattighet(p: RawPolicy[] | null | undefined): KbRattighet {
	const f = Array.isArray(p) ? p[0] : undefined;
	const licens = str(f?.prefLabelByLang?.en) ?? str(f?.prefLabelByLang?.sv);
	const licens_url = str(f?.["@id"]);
	switch (f?.value) {
		case "Free":
			return { atkomst: "fritt", etikett: "Fritt (upphovsrättsfritt, får användas fritt)", licens, licens_url };
		case "Restricted":
			return { atkomst: "begransad", etikett: "Begränsad åtkomst (får visas men inte vidareanvändas utan tillstånd)", licens, licens_url };
		case undefined:
		case null:
			return { atkomst: "okand", etikett: "Anges inte här (KB:s filpaket saknar ofta uppgiften; se märkningen i sökträffen från kb_sok eller i KB Digitalt)", licens, licens_url };
		default:
			return { atkomst: "upphovsskyddat", etikett: "Upphovsskyddat", licens, licens_url };
	}
}

// ------------------------------------------------------------------ sökning

export interface KbTraff {
	paket: string;
	/** Delnummer (sidträffar). */
	del: number | null;
	/** Sidnummer inom delen enligt KB (sidträffar). */
	sida_i_del: number | null;
	/** Bildnummer i paketet (löpande; används av kb_sida). */
	bild: number | null;
	titel: string | null;
	datum: string | null;
	ar: string | null;
	verkstyp: string | null;
	ingar_i: string | null;
	kategorier: string[];
	upphov: string[];
	amnen: string[];
	samlingar: string[];
	rattighet: KbRattighet;
	libris: string | null;
	regina_id: string | null;
	miniatyr: string | null;
	/** Utdrag ur OCR-texten med sökorden inom <em> (sidträffar), rå text. */
	utdrag: string[];
	traffar_i_dokument: number | null;
	url: string;
}

export interface KbFasett {
	varde: string;
	antal: number;
}

export interface KbSokSvar {
	totalt: number;
	traffar: KbTraff[];
	fasetter: { kategori: KbFasett[]; titel: KbFasett[]; samling: Array<KbFasett & { id: string }>; ar: KbFasett[] };
	menade_du: string | null;
}

const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x : null);
const arr = <T>(x: T | T[] | null | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);

/** Bildnumret ur en bildfils namn eller en IIIF-adress: siffrorna före `.jp2` (`…_0005.jp2`). */
export function bildnummer(s: string | null | undefined): number | null {
	if (!s) return null;
	let t: string;
	try {
		t = decodeURIComponent(s);
	} catch {
		return null;
	}
	const m = /[_,](\d{1,5})\.jp2$/i.exec(t);
	return m ? Number(m[1]) : null;
}

/** Bara en välformad Libris-adress godtas; annat blir null. */
export function librisUrl(s: string | null | undefined): string | null {
	return s && /^https:\/\/libris\.kb\.se\/[A-Za-z0-9#/._-]{1,200}$/.test(s) ? s : null;
}

// oxlint-disable-next-line typescript/no-explicit-any -- KB:s svar tolkas fält för fält
type Any = any;

export function tolkaTraff(h: Any): KbTraff | null {
	const id = str(h?.["@id"]);
	const m = id ? /^https:\/\/data\.kb\.se\/(dark-\d{1,12})(?:\/part\/(\d+)\/page\/(\d+))?$/.exec(id) : null;
	if (!m) return null;
	const paket = m[1];
	const del = m[2] ? Number(m[2]) : null;
	const sida_i_del = m[3] ? Number(m[3]) : null;
	const ids = arr<Any>(h.identifiedBy);
	const kategorier = arr<Any>(h.genreForm)
		.map((g) => str(g?.prefLabel?.sv) ?? str(g?.prefLabel?.en))
		.filter((x): x is string => !!x);
	// Huvudupphovet först, som i KB Digitalt.
	const bidrag = arr<Any>(h.contribution).sort((a, b) => (a?.["@type"] === "PrimaryContribution" ? -1 : b?.["@type"] === "PrimaryContribution" ? 1 : 0));
	const upphov: string[] = [];
	for (const c of bidrag) {
		const roll = arr<Any>(c?.role)
			.map((r) => str(r?.prefLabelByLang?.sv))
			.filter(Boolean)
			.join(", ");
		for (const a of arr<Any>(c?.agent)) {
			const namn = str(a?.displayName) ?? str(a?.name);
			if (namn) upphov.push(roll ? `${namn} (${roll})` : namn);
		}
	}
	const amnen = arr<Any>(h.subject)
		.map((s) => str(s?.displayPrefLabel) ?? str(s?.prefLabel))
		.filter((x): x is string => !!x);
	const samlingar = [...arr<Any>(h.inDataset), ...arr<Any>(h.bibliography)].map((d) => str(d?.title)).filter((x): x is string => !!x);
	const datum = str(h.datePublished);
	const ar = datum ? (/\b([12]\d{3})\b/.exec(datum)?.[1] ?? null) : null;
	const verkstyp = str(h.instanceOf?.["@type"]);
	const libris = str(h.hasIntellectualEntity?.["@id"]);
	return {
		paket,
		del,
		sida_i_del,
		// Bara sidträffar har ett bildnummer; en objektträff gäller hela objektet.
		bild: del !== null ? bildnummer(str(h.imageServiceId)) : null,
		titel: str(h.title),
		datum,
		ar,
		verkstyp: verkstyp === "Monograph" ? "monografi" : verkstyp === "Serial" ? "seriell" : verkstyp,
		ingar_i: str(h.isPartOf?.title),
		kategorier,
		upphov: [...new Set(upphov)],
		amnen,
		samlingar: [...new Set(samlingar)],
		rattighet: tolkaRattighet(h.usageAndAccessPolicy),
		libris: librisUrl(libris),
		regina_id: str(ids.find((i) => i?.typeNote === "Regina-ID")?.value),
		miniatyr: str(h.thumbnail)?.startsWith(`${KB_DATA}/iiif/`) ? str(h.thumbnail) : null,
		utdrag: arr<Any>(h.snippets).filter((s): s is string => typeof s === "string"),
		traffar_i_dokument: typeof h.hits_within_doc === "number" ? h.hits_within_doc : null,
		url: del !== null && sida_i_del !== null ? visarUrl(paket, del, sida_i_del) : visarUrl(paket),
	};
}

function fasett(a: Any): KbFasett[] {
	return arr<Any>(a?.values)
		.filter((v) => typeof v?.value === "string" && typeof v?.count === "number" && v.count > 0)
		.map((v) => ({ varde: v.value as string, antal: v.count as number }));
}

export function tolkaSok(data: Any): KbSokSvar {
	if (!data || typeof data !== "object" || typeof data.total !== "number" || !Array.isArray(data.hits)) {
		throw new Error("väntade total (tal) och hits (lista)");
	}
	const a = data.aggs ?? {};
	return {
		totalt: data.total,
		traffar: data.hits.map(tolkaTraff).filter((t: KbTraff | null): t is KbTraff => t !== null),
		fasetter: {
			kategori: fasett(a.genreForm),
			titel: fasett(a.isPartOf),
			// KB:s fält heter `_id` (samlingens URI).
			samling: arr<Any>(a.inDataset?.values)
				// oxlint-disable-next-line no-underscore-dangle
				.filter((v) => typeof v?.value === "string" && typeof v?._id === "string" && v.count > 0)
				// oxlint-disable-next-line no-underscore-dangle
				.map((v) => ({ varde: v.value as string, antal: v.count as number, id: v._id as string })),
			ar: fasett(a.datePublished),
		},
		menade_du: str(data.did_u_mean),
	};
}

// ------------------------------------------------------------------ paket

export interface KbFil {
	namn: string;
	typ: string | null;
	storlek: number | null;
}

export interface KbSidfil {
	/** Bildnummer (löpande i paketet). */
	bild: number;
	bildfil: string | null;
	alto: string | null;
}

export interface KbPaket {
	paket: string;
	namn: string | null;
	rattighet: KbRattighet;
	libris: string | null;
	skapad: string | null;
	sidor: KbSidfil[];
	pdf: string | null;
	antal_filer: number;
	url: string;
}

const ALTO_RE = /^(?:ALTO\/)?[^/]*?[_,](\d{1,5})(?:_alto)?\.xml$/i;
const BILD_RE = /^(?:(?:PROD_)?JP2000\/)?[^/]*?[_,](\d{1,5})\.jp2$/i;

export function tolkaPaket(data: Any, paket: string): KbPaket {
	if (!data || typeof data !== "object" || data["@type"] !== "FilePackage" || !Array.isArray(data.includes)) {
		throw new Error("väntade @type FilePackage och includes (lista)");
	}
	const sidor = new Map<number, KbSidfil>();
	const sida = (n: number) => {
		let s = sidor.get(n);
		if (!s) sidor.set(n, (s = { bild: n, bildfil: null, alto: null }));
		return s;
	};
	let pdf: string | null = null;
	for (const f of data.includes as Any[]) {
		const namn = str(f?.fileName);
		if (!namn) continue;
		const a = ALTO_RE.exec(namn);
		if (a) {
			sida(Number(a[1])).alto ??= namn;
			continue;
		}
		// Arkivkopior (ARCHIVE_JP2000) hoppas över; visningskopian räcker.
		const b = BILD_RE.exec(namn);
		if (b) {
			sida(Number(b[1])).bildfil ??= namn;
			continue;
		}
		if (/\.pdf$/i.test(namn)) pdf ??= namn;
	}
	return {
		paket,
		namn: str(data.name),
		rattighet: tolkaRattighet(data.usageAndAccessPolicy),
		libris: librisUrl(str(data.relatedTo?.["@id"])),
		skapad: str(data.created),
		sidor: [...sidor.values()].sort((x, y) => x.bild - y.bild),
		pdf,
		antal_filer: data.includes.length,
		url: visarUrl(paket),
	};
}

// ------------------------------------------------------------------ ALTO

export interface KbSidtext {
	/** Raderna, med tom rad mellan textblock. */
	rader: string[];
	ord: number;
	/** Medelvärdet av ordens OCR-säkerhet (WC, 0–1), om angivet. */
	sakerhet: number | null;
	/** Andel ord med säkerhet under 0,5. */
	osakra: number | null;
}

const ENTITETER: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function avkodaXml(s: string): string {
	return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-z]+);/g, (hel, e: string) => {
		if (e[0] === "#") {
			const n = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
		}
		return ENTITETER[e] ?? hel;
	});
}

function attr(tagg: string, namn: string): string | null {
	const m = new RegExp(`\\s${namn}="([^"]*)"`).exec(tagg);
	return m ? avkodaXml(m[1]) : null;
}

/**
 * OCR-texten ur en ALTO-fil (v2–v4), diplomatiskt: orden som de står, en rad
 * per TextLine, tom rad mellan TextBlock. Avstavade ord behåller sitt
 * bindestreck (HYP) i radslutet. Ingen XML-tolkare finns i Workers; filen
 * läses tagg för tagg.
 */
export function altoTillText(xml: string): KbSidtext {
	if (!/<alto[\s>]/.test(xml)) throw new Error("väntade ett ALTO-dokument (<alto>)");
	const rader: string[] = [];
	let rad: string[] = [];
	let ord = 0;
	let summa = 0;
	let medWc = 0;
	let osakra = 0;
	const taggar = /<(\/?)(TextBlock|TextLine|String|SP|HYP)\b([^>]*)>/g;
	let m: RegExpExecArray | null;
	const avslutaRad = () => {
		const t = rad.join("").replace(/\s+/g, " ").trim();
		if (t) rader.push(t);
		rad = [];
	};
	while ((m = taggar.exec(xml))) {
		const [, slut, namn, resten] = m;
		if (namn === "TextLine" && slut) avslutaRad();
		else if (namn === "TextBlock" && !slut) {
			avslutaRad();
			if (rader.length && rader[rader.length - 1] !== "") rader.push("");
		} else if (namn === "String" && !slut) {
			const c = attr(resten, "CONTENT");
			if (c?.trim()) {
				rad.push(c);
				ord++;
				const wc = Number(attr(resten, "WC"));
				if (attr(resten, "WC") !== null && Number.isFinite(wc)) {
					medWc++;
					summa += wc;
					if (wc < 0.5) osakra++;
				}
			}
		} else if (namn === "SP" && !slut) rad.push(" ");
		else if (namn === "HYP" && !slut) rad.push(attr(resten, "CONTENT") ?? "-");
	}
	avslutaRad();
	while (rader.length && rader[rader.length - 1] === "") rader.pop();
	return {
		rader,
		ord,
		sakerhet: medWc ? Math.round((summa / medWc) * 100) / 100 : null,
		osakra: medWc ? Math.round((osakra / medWc) * 100) / 100 : null,
	};
}

// ------------------------------------------------------------------ källan

export interface KbBildSvar {
	status: number;
	bytes: Uint8Array | null;
	mimeType: string;
	tooLarge: boolean;
}

/** Läsning mot data.kb.se genom projektets klient (lista över tillåtna anrop, tidsgräns, kö). */
export class KbSource {
	constructor(private readonly client: UpstreamClient) {}

	async sok(f: KbSokFraga): Promise<KbSokSvar> {
		const { status, data, raw } = await this.client.getJson<Any>(sokUrl(f));
		if (status === 400) {
			throw new ToolInputError(
				"KB kunde inte tolka sökfrågan (felaktig syntax). Kontrollera att parenteser och citattecken är parade, att AND/OR/NOT står mellan två sökord och att * inte står först i ett ord.",
			);
		}
		if (status === 422) {
			throw new ToolInputError("KB godtog inte sökfrågan (ogiltigt värde i ett filter, t.ex. datum). Kontrollera årtalen och filtren.");
		}
		if (status !== 200) throw new UpstreamError("kb", `KB svarade ${status} på sökningen`, status);
		try {
			return tolkaSok(data);
		} catch (e) {
			throw new UpstreamError("kb", `KB:s söksvar gick inte att tolka (${e instanceof Error ? e.message : String(e)}; ${raw.contentType})`, status);
		}
	}

	async paket(paket: string): Promise<KbPaket> {
		const { status, data } = await this.client.getJson<Any>(paketUrl(paket)).catch((e) => {
			// HTML-sida i stället för JSON (borttaget paket) behandlas som saknat nedan.
			if (e instanceof UpstreamError && (e.status === 404 || e.status === 410)) return { status: e.status, data: null };
			throw e;
		});
		if (status === 404 || status === 410) {
			throw new ToolInputError(`KB har inget objekt med id ${paket} (svar ${status}). Sök med kb_sok.`);
		}
		if (status !== 200) throw new UpstreamError("kb", `KB svarade ${status} på objektet ${paket}`, status);
		try {
			return tolkaPaket(data, paket);
		} catch (e) {
			throw new UpstreamError("kb", `KB:s objekt ${paket} gick inte att tolka (${e instanceof Error ? e.message : String(e)})`, status);
		}
	}

	/** ALTO-filens text; null om KB nekar (401/403), kastar vid andra fel. */
	async sidtext(paket: string, alto: string): Promise<{ status: number; text: KbSidtext | null }> {
		const res = await this.client.get(filUrl(paket, alto), "application/xml, text/xml");
		if (res.status === 401 || res.status === 403) return { status: res.status, text: null };
		if (res.status === 404 || res.status === 410) throw new ToolInputError(`OCR-filen för sidan finns inte längre hos KB (svar ${res.status}).`);
		if (res.status !== 200) throw new UpstreamError("kb", `KB svarade ${res.status} när OCR-texten hämtades`, res.status);
		try {
			return { status: res.status, text: altoTillText(res.body) };
		} catch (e) {
			throw new UpstreamError("kb", `KB:s OCR-fil gick inte att tolka (${e instanceof Error ? e.message : String(e)})`, res.status);
		}
	}

	async sidbild(paket: string, bildfil: string, max: number, maxBytes: number): Promise<KbBildSvar> {
		const r = await this.client.getBytes(iiifUrl(paket, bildfil, max), "image/jpeg", maxBytes);
		return { status: r.status, bytes: r.bytes, mimeType: r.contentType.split(";")[0].trim().toLowerCase(), tooLarge: r.tooLarge };
	}
}
