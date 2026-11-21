/**
 * Kontrakt: KB Digitalt (Kungliga biblioteket, data.kb.se). Frågorna byggs av
 * projektets egna `sokUrl`, `paketUrl` och `filUrl`, och svaren tolkas med
 * `tolkaSok`, `tolkaPaket` och `altoTillText` (src/sources/kb/kb.ts). Fyra anrop.
 *
 * Testobjektet är Västerviks Veckoblad 1869-07-17 (dark-13003706): sex sidor i
 * två delar, med ALTO-text, och bilden 5 är del 2 sida 1.
 */
import { describe, it } from "vitest";
import { altoTillText, bildnummer, filUrl, paketUrl, sokUrl, tolkaPaket, tolkaSok } from "../../src/sources/kb/kb";
import { en, hamta, jsonSvar, Kontroll, skapaKlient, tolka } from "./stod";

const KALLA = "kb" as const;
const klient = skapaKlient();
const PAKET = "dark-13003706";

const ANROP_OBJEKT = "search (metadata, q=falun)";
const ANROP_SIDA = "search (searchGranularity=part, Dagstidningar 1869)";
const ANROP_PAKET = "GET /{paket}.jsonld";
const ANROP_ALTO = "GET /{paket}/{alto} (ALTO-XML)";

const objekt = en(async () => {
	const res = await hamta(KALLA, ANROP_OBJEKT, () => klient.get(sokUrl({ q: "falun", niva: "objekt", antal: 5, start: 0 })));
	return tolka(KALLA, ANROP_OBJEKT, "total, hits", () => tolkaSok(jsonSvar(KALLA, ANROP_OBJEKT, res)));
});

const sidor = en(async () => {
	const url = sokUrl({ q: "eldsvådan Gefle", niva: "sida", fran: "1869-07-17", till: "1869-07-17", kategori: "Dagstidningar", antal: 20, start: 0 });
	const res = await hamta(KALLA, ANROP_SIDA, () => klient.get(url));
	return tolka(KALLA, ANROP_SIDA, "total, hits", () => tolkaSok(jsonSvar(KALLA, ANROP_SIDA, res)));
});

const paket = en(async () => {
	const res = await hamta(KALLA, ANROP_PAKET, () => klient.get(paketUrl(PAKET)));
	return tolka(KALLA, ANROP_PAKET, "@type, includes", () => tolkaPaket(jsonSvar(KALLA, ANROP_PAKET, res), PAKET));
});

describe("KB Digitalt", () => {
	it("sökning i metadata: träffar med id, titel, år och rättighetsmärkning", async () => {
		const s = await objekt();
		const k = new Kontroll(KALLA, ANROP_OBJEKT);
		k.krav(s.totalt >= 10, "total", `väntade minst 10 träffar på "falun", fick ${s.totalt}`);
		k.krav(s.traffar.length >= 3, "hits", `väntade minst 3 tolkade träffar, fick ${s.traffar.length} (@id ska vara https://data.kb.se/dark-NNN)`);
		k.krav(
			s.traffar.every((t) => !!t.titel),
			"hits[].title",
			"en träff saknar titel",
		);
		k.krav(
			s.traffar.some((t) => t.rattighet.atkomst !== "okand"),
			"hits[].usageAndAccessPolicy",
			"ingen träff har en känd rättighetsmärkning (value Free/Restricted)",
		);
		k.krav(
			s.traffar.some((t) => t.ar !== null),
			"hits[].datePublished",
			"ingen träff har ett utgivningsår",
		);
		k.krav(s.fasetter.kategori.length > 0, "aggs.genreForm", "inga kategorifasetter");
		k.klar();
	});

	it("fulltextsökning: sidträffar med del, sida, bildnummer och utdrag med <em>", async () => {
		const s = await sidor();
		const k = new Kontroll(KALLA, ANROP_SIDA);
		const t = s.traffar.find((x) => x.paket === PAKET);
		k.krav(!!t, `${PAKET}`, "testobjektet finns inte bland sidträffarna (@id https://data.kb.se/dark-NNN/part/P/page/N)");
		if (t) {
			k.krav(t.del !== null && t.sida_i_del !== null, "hits[].@id", "del och sida saknas i träffens id");
			k.krav(t.bild !== null, "hits[].imageServiceId", "bildnumret kunde inte läsas ur imageServiceId (…_NNNN.jp2)");
			k.krav(
				t.utdrag.some((u) => /<em>.+<\/em>/i.test(u)),
				"hits[].snippets",
				`väntade utdrag med sökorden inom <em>, fick ${JSON.stringify(t.utdrag.slice(0, 2))}`,
			);
		}
		k.klar();
	});

	it("filpaket: sex sidor med bild och ALTO, och sidträffens bildnummer finns i paketet", async () => {
		const p = await paket();
		const k = new Kontroll(KALLA, ANROP_PAKET);
		k.krav(p.sidor.length === 6, "includes", `väntade 6 sidor, fick ${p.sidor.length}`);
		k.krav(
			p.sidor.every((s) => s.bildfil && s.alto),
			"includes[].fileName",
			"en sida saknar bildfil (…_NNNN.jp2) eller ALTO-fil (…_NNNN_alto.xml)",
		);
		k.krav(!!p.namn, "name", "namn saknas");
		const s = await sidor().catch(() => null);
		const t = s?.traffar.find((x) => x.paket === PAKET);
		if (t?.bild != null) k.krav(p.sidor.some((x) => x.bild === t.bild), "imageServiceId ↔ includes", `sidträffens bild ${t.bild} finns inte i paketet`);
		k.krav(bildnummer(p.sidor[4]?.bildfil) === 5, "includes[4].fileName", "femte sidans bildfil har inte nummer 5");
		k.klar();
	});

	it("ALTO-text: rader och ord med OCR-säkerhet", async () => {
		const p = await paket();
		const alto = p.sidor.find((s) => s.bild === 5)?.alto;
		const k = new Kontroll(KALLA, ANROP_ALTO);
		k.krav(!!alto, "alto", "ingen ALTO-fil för bild 5");
		if (alto) {
			const res = await hamta(KALLA, ANROP_ALTO, () => klient.get(filUrl(PAKET, alto), "application/xml, text/xml"));
			const t = tolka(KALLA, ANROP_ALTO, "<alto>", () => altoTillText(res.body));
			k.krav(t.ord > 200, "String@CONTENT", `väntade över 200 ord, fick ${t.ord}`);
			k.krav(t.sakerhet !== null, "String@WC", "ordens OCR-säkerhet (WC) saknas");
			k.krav(
				t.rader.some((r) => /Gefle/.test(r)),
				"TextLine",
				"texten nämner inte Gefle (sidan om eldsvådan i Gävle 1869)",
			);
		}
		k.klar();
	});
});
