/**
 * KB Digitalt (data.kb.se): tolkarna, listan över tillåtna anrop och verktygen
 * kb_sok, kb_objekt och kb_sida över MCP, mot inspelade svar
 * (test/fixtures/kb-*, inspelade 2026-11-21).
 */
import { describe, expect, it } from "vitest";
import { DisallowedCallError } from "../src/errors";
import {
	altoTillText,
	bildnummer,
	librisUrl,
	parseKbLank,
	filUrl,
	iiifUrl,
	paketUrl,
	parsePaketId,
	sokUrl,
	tolkaPaket,
	tolkaRattighet,
	tolkaSok,
} from "../src/sources/kb/kb";
import { kortaUtdrag, markeringsRe, utdragText } from "../src/tools/kb";
import { checkAllowed } from "../src/upstream/allowlist";
import { connectMcp, fixture, fixtureBytes, fixtureResponse, fixtureText, json, type Route, standardRoutes } from "./helpers";

const NP = "dark-13003706";
const NP_BILD5 = "bib3dd79vzx1bnbqstf_18690717_159397_29_0005.jp2";
const NP_ALTO5 = "bib3dd79vzx1bnbqstf_18690717_159397_29_0005_alto.xml";
const GRAVYR = "dark-27607850";

type S = Record<string, any>;
const text = (r: { content?: unknown }) => (r.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text).join("\n");

function kbRoutes(): Route[] {
	const isKb = (u: URL) => u.hostname === "data.kb.se";
	return [
		{
			match: (u) => isKb(u) && u.pathname === "/search" && u.searchParams.get("searchGranularity") === "part",
			respond: () => fixtureResponse("kb-sok-hytta-sida.json", 200, "application/json"),
		},
		{
			match: (u) => isKb(u) && u.pathname === "/search" && u.searchParams.get("q") === "(hytta",
			respond: () => json({ detail: "Malformed query" }, 400, "application/json"),
		},
		{
			match: (u) => isKb(u) && u.pathname === "/search" && u.searchParams.get("q") === "zzzqqq",
			respond: () => json({ "@id": "x", total: 0, hits: [], aggs: {}, search: {}, did_u_mean: "zzzq" }, 200, "application/json"),
		},
		{
			match: (u) => isKb(u) && u.pathname === "/search" && u.searchParams.has("from") && !/^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get("from") ?? ""),
			respond: () => json({ detail: [{ type: "date_from_datetime_inexact" }] }, 422, "application/json"),
		},
		{ match: (u) => isKb(u) && u.pathname === "/search", respond: () => fixtureResponse("kb-sok-falun.json", 200, "application/json") },
		{ match: (u) => isKb(u) && u.pathname === `/${NP}.jsonld`, respond: () => fixtureResponse("kb-paket-dark-13003706.json", 200, "application/json") },
		{ match: (u) => isKb(u) && u.pathname === `/${GRAVYR}.jsonld`, respond: () => fixtureResponse("kb-paket-dark-27607850.json", 200, "application/json") },
		{ match: (u) => isKb(u) && u.pathname === "/dark-404.jsonld", respond: () => fixtureResponse("kb-paket-saknas.json", 404, "application/json") },
		{
			match: (u) => isKb(u) && u.pathname === "/dark-410.jsonld",
			respond: () => new Response("<!DOCTYPE html><html><title>Gone</title></html>", { status: 410, headers: { "content-type": "text/html" } }),
		},
		{ match: (u) => isKb(u) && u.pathname === `/${NP}/${NP_ALTO5}`, respond: () => fixtureResponse("kb-alto-dark-13003706-0005.xml", 200, "application/xml") },
		{ match: (u) => isKb(u) && u.pathname.startsWith(`/${NP}/`) && u.pathname.endsWith(".xml"), respond: () => new Response("forbidden", { status: 403 }) },
		{
			match: (u) => isKb(u) && u.pathname.startsWith("/iiif/3/"),
			respond: () => new Response(fixtureBytes("kb-iiif-dark-13003706-0005.jpg"), { status: 200, headers: { "content-type": "image/jpeg" } }),
		},
	];
}

describe("KB: adresser och listan över tillåtna anrop", () => {
	it("serverns egna adresser är tillåtna", () => {
		const urls = [
			sokUrl({ q: "hytta OR hyttan", niva: "sida", fran: "1850-01-01", till: "1859-12-31", kategori: "Dagstidningar", titel: "Aftonbladet", samling: "https://data.kb.se/dataset/7mf87n2g5xzjf8r4", sortering: "nyast", antal: 50, start: 9950 }),
			sokUrl({ q: "*", niva: "objekt", antal: 10, start: 0 }),
			paketUrl(NP),
			filUrl(NP, NP_ALTO5),
			filUrl("dark-29584449", "ALTO/001358759_0003.xml"),
			iiifUrl(NP, NP_BILD5, 1600),
			iiifUrl(GRAVYR, "PROD_JP2000/001929659,5200001_0001.jp2", 1600),
		];
		for (const u of urls) expect(checkAllowed("GET", u).source, u).toBe("kb");
		expect(filUrl("dark-29584449", "ALTO/001358759_0003.xml")).toBe("https://data.kb.se/dark-29584449/ALTO%2F001358759_0003.xml");
		expect(iiifUrl(GRAVYR, "PROD_JP2000/001929659,5200001_0001.jp2", 1600)).toBe(
			"https://data.kb.se/iiif/3/dark-27607850%2FPROD_JP2000%2F001929659%2C5200001_0001.jp2/full/!1600,1600/0/default.jpg",
		);
	});

	it("allt annat nekas: andra filer, kodade snedstreck och punkter, andra parametrar och värdar", () => {
		const nekas = [
			"https://data.kb.se/dark-1/mets.xml.gz",
			"https://data.kb.se/dark-1/%2E%2E%2Fsecret.xml",
			"https://data.kb.se/dark-1/ALTO%2F..%2Fx.xml",
			"https://data.kb.se/dark-1/PDF%2Fbok.pdf",
			"https://data.kb.se/dark-1/x.jp2",
			"https://data.kb.se/dark-1",
			"https://data.kb.se/search?q=x&limit=500",
			"https://data.kb.se/search?q=x&inDataset=https://evil.example/dataset/1",
			"https://data.kb.se/search?q=x&admin=1",
			"https://data.kb.se/search?limit=1",
			"https://data.kb.se/iiif/3/dark-1%2Fx.jp2/full/max/0/default.jpg",
			"https://data.kb.se/iiif/3/dark-1%2Fx.jp2/full/!1600,1600/0/default.png",
			"https://data.kb.se/datasets",
			"http://data.kb.se/dark-1.jsonld",
			"https://data.kb.se.evil.example/dark-1.jsonld",
			"https://tidningar.kb.se/search?q=x",
		];
		for (const u of nekas) expect(() => checkAllowed("GET", u), u).toThrow(DisallowedCallError);
	});

	it("paket-id ur id eller länk", () => {
		expect(parsePaketId("dark-13003706")).toBe(NP);
		expect(parsePaketId("https://digitalt.kb.se/dark-13003706/part/2/page/1")).toBe(NP);
		expect(parsePaketId("https://data.kb.se/dark-13003706.jsonld")).toBe(NP);
		expect(() => parsePaketId("https://evil.example/dark-1")).toThrow(/Ogiltigt KB-id/);
		expect(() => parsePaketId("dark-1/../x")).toThrow(/Ogiltigt KB-id/);
		expect(bildnummer("https://data.kb.se/iiif/3/dark-13003706%2Fbib3dd79vzx1bnbqstf_18690717_159397_29_0005.jp2")).toBe(5);
		expect(bildnummer("PROD_JP2000/001929659,5200001_0001.jp2")).toBe(1);
		expect(bildnummer(null)).toBeNull();
		expect(bildnummer("x_%E0%A4%A_0001.jp2")).toBeNull();
		expect(parseKbLank("https://digitalt.kb.se/dark-13003706/part/2/page/1")).toEqual({ paket: NP, del: 2, sida: 1 });
		expect(librisUrl("https://libris.kb.se/x85dwf85vltvnxzd#it")).toBe("https://libris.kb.se/x85dwf85vltvnxzd#it");
		expect(librisUrl("https://libris.kb.se/x\nKälla: falsk")).toBeNull();
	});
});

describe("KB: tolkning", () => {
	it("söksvar på objektnivå", () => {
		const s = tolkaSok(fixture("kb-sok-falun.json"));
		expect(s.totalt).toBe(63);
		expect(s.traffar).toHaveLength(3);
		const t = s.traffar[0];
		expect(t).toMatchObject({ paket: GRAVYR, del: null, bild: null, titel: "Falun", ar: "1696", verkstyp: "monografi", regina_id: "001929659" });
		expect(t.kategorier).toEqual(["Panoramor", "Gravyrer"]);
		// Huvudupphovet först.
		expect(t.upphov[0]).toBe("Reitz, Erik, ca 1660-1696 (Konstnär)");
		expect(t.rattighet).toMatchObject({ atkomst: "fritt", licens: "Public Domain Mark 1.0" });
		expect(t.url).toBe("https://digitalt.kb.se/dark-27607850/part/1/page/1");
		expect(t.libris).toMatch(/^https:\/\/libris\.kb\.se\//);
		expect(s.fasetter.kategori.length).toBeGreaterThan(0);
	});

	it("söksvar på sidnivå: del, sida, bildnummer och utdrag", () => {
		const s = tolkaSok(fixture("kb-sok-hytta-sida.json"));
		expect(s.totalt).toBe(7409);
		const t = s.traffar[0];
		expect(t).toMatchObject({ paket: "dark-5757593", del: 1, sida_i_del: 3, bild: 3, ingar_i: "Göteborgs handels- och sjöfartstidning (1832)" });
		expect(t.utdrag[0]).toContain("<em>hytta</em>");
		expect(t.url).toBe("https://digitalt.kb.se/dark-5757593/part/1/page/3");
		expect(s.fasetter.titel.length).toBeGreaterThan(0);
		expect(s.fasetter.samling.every((x) => x.id.startsWith("https://data.kb.se/dataset/"))).toBe(true);
	});

	it("ogiltigt söksvar och okända träffar", () => {
		expect(() => tolkaSok({ detail: "x" })).toThrow(/total/);
		expect(tolkaSok({ total: 1, hits: [{ "@id": "https://evil.example/dark-1" }] }).traffar).toEqual([]);
	});

	it("rättighetsmärkningen som i KB Digitalt", () => {
		expect(tolkaRattighet([{ value: "Free" }]).atkomst).toBe("fritt");
		expect(tolkaRattighet([{ value: "Restricted" }]).atkomst).toBe("begransad");
		expect(tolkaRattighet([{ value: "InCopyright" }]).atkomst).toBe("upphovsskyddat");
		expect(tolkaRattighet(null).atkomst).toBe("okand");
	});

	it("filpaket: tidning (sidor löpande över delarna) och gravyr (visningskopian, inte arkivkopian)", () => {
		const np = tolkaPaket(fixture("kb-paket-dark-13003706.json"), NP);
		expect(np.sidor.map((s) => s.bild)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(np.sidor[4]).toEqual({ bild: 5, bildfil: NP_BILD5, alto: NP_ALTO5 });
		expect(np.namn).toBe("VÄSTERVIKS VECKOBLAD 1869-07-17");
		expect(np.rattighet.atkomst).toBe("okand");
		const g = tolkaPaket(fixture("kb-paket-dark-27607850.json"), GRAVYR);
		expect(g.sidor).toEqual([{ bild: 1, bildfil: "PROD_JP2000/001929659,5200001_0001.jp2", alto: null }]);
		expect(() => tolkaPaket({ detail: "Not found." }, "dark-1")).toThrow(/FilePackage/);
	});

	it("ALTO: rader, block, avstavning och OCR-säkerhet", () => {
		const t = altoTillText(fixtureText("kb-alto-dark-13003706-0005.xml"));
		expect(t.rader[0]).toBe("Om eldsvådan i Gede");
		expect(t.rader[1]).toBe("");
		expect(t.rader).toContain("Gefle, Söndagen den 11 Juli kl. 11 t. 5 m. Elden uppkom i går mid-");
		expect(t.ord).toBe(519);
		expect(t.sakerhet).toBeGreaterThan(0);
		expect(t.sakerhet).toBeLessThan(1);
		expect(() => altoTillText("<html></html>")).toThrow(/ALTO/);
		const liten = altoTillText('<alto><Layout><TextBlock><TextLine><String CONTENT="A&amp;B" WC="0.4"/><SP/><String CONTENT="&#228;r"/></TextLine></TextBlock></Layout></alto>');
		expect(liten.rader).toEqual(["A&B är"]);
		expect(liten).toMatchObject({ ord: 2, sakerhet: 0.4, osakra: 1 });
		// Ord som bara är blanksteg räknas inte (finns i KB:s bok-ALTO).
		const blank = altoTillText('<alto><TextLine><String CONTENT="a" WC="0.2"/><String CONTENT=" " WC="0.95"/></TextLine></alto>');
		expect(blank).toMatchObject({ ord: 1, sakerhet: 0.2 });
	});

	it("utdrag: <em> blir ⟦⟧; källtextens egna ⟦⟧ och «» byts ut", () => {
		expect(utdragText("en <em>hytta</em> i Falun")).toBe("en ⟦hytta⟧ i Falun");
		expect(utdragText("⟦falsk⟧ «citat» <em>x")).toBe("[falsk] ‹citat› ⟦x⟧");
		expect(utdragText("a</em>b <b>c</b>\u202Ed")).toBe("ab cd");
		// En kodad tagg i OCR-texten blir text, inte en markering.
		expect(utdragText("&lt;em&gt;falsk&lt;/em&gt; <em>äkta</em>")).toBe("<em>falsk</em> ⟦äkta⟧");
		const lang = `${"a".repeat(995)} ⟦hytta⟧ b`;
		expect(kortaUtdrag(lang, 1000)).toBe(`${"a".repeat(995)} ⟦hyt⟧…`);
		expect(kortaUtdrag(`${"a".repeat(999)}😀`, 1000)).toBe(`${"a".repeat(999)}…`);
	});

	it("markering i sidtexten: hela ord, prefix med *", () => {
		const re = markeringsRe(["eld*", "Gefle"]) as RegExp;
		expect("Elden och eldsvådan i Gefle, Geflebo".replace(re, "[$&]")).toBe("[Elden] och [eldsvådan] i [Gefle], Geflebo");
		expect(markeringsRe(["a*"])).toBeNull();
		expect("a.b (x)".replace(markeringsRe(["a.b"]) as RegExp, "[$&]")).toBe("[a.b] (x)");
	});
});

describe("KB: verktygen över MCP", () => {
	const routes = () => [...kbRoutes(), ...standardRoutes()];

	it("kb_sok på objektnivå med filter, fasetter och källrad", async () => {
		const { client, calls } = await connectMcp(routes());
		try {
			const r = await client.callTool({ name: "kb_sok", arguments: { fraga: "falun", fran_ar: 1600, till_ar: 1999, kategori: "Gravyrer", sortering: "aldst", antal: 3, sida: 2 } });
			expect(r.isError).toBeFalsy();
			const s = r.structuredContent as S;
			expect(s.totalt).toBe(63);
			expect(s.traffar[0]).toMatchObject({ id: GRAVYR, titel: "Falun", ar: "1696" });
			const u = calls.find((c) => c.url.hostname === "data.kb.se")!.url;
			expect(Object.fromEntries(u.searchParams)).toEqual({ q: "falun", from: "1600-01-01", to: "1999-12-31", genreForm: "Gravyrer", _sort: "datePublished", limit: "3", offset: "3" });
			const t = text(r);
			expect(t).toMatch(/63 träffar för «falun»/);
			expect(t).toMatch(/^4\. «Falun» \(1696/m);
			expect(t).toMatch(/Rättigheter: Fritt/);
			expect(t).toMatch(/Källa: Kungliga biblioteket, KB Digitalt \(data\.kb\.se\); levande källa; hämtat nu\./);
		} finally {
			await client.close();
		}
	});

	it("kb_sok på sidnivå: utdrag med ⟦⟧ och hänvisning till kb_sida", async () => {
		const { client } = await connectMcp(routes());
		try {
			const r = await client.callTool({ name: "kb_sok", arguments: { fraga: "hytta", niva: "sida", kategori: "Dagstidningar", fran_ar: 1850, till_ar: 1859, antal: 3 } });
			const s = r.structuredContent as S;
			expect(s.traffar[0]).toMatchObject({ id: "dark-5757593", bild: 3, del: 1 });
			expect(s.traffar[0].utdrag[0]).toContain("⟦hytta⟧");
			expect(text(r)).toMatch(/Sida: id dark-5757593, bild 3 \(del 1, sida 3\).*Läs med kb_sida/);
			expect(text(r)).toMatch(/Utdrag \(OCR, källtext\): «[^»]*⟦hytta⟧/);
		} finally {
			await client.close();
		}
	});

	it("kb_sok: inga träffar ger KB:s förslag; fel årsordning och för djup bläddring är verktygsfel", async () => {
		const { client } = await connectMcp(routes());
		try {
			const tom = await client.callTool({ name: "kb_sok", arguments: { fraga: "zzzqqq" } });
			expect(text(tom)).toMatch(/0 träffar/);
			expect(text(tom)).toMatch(/KB föreslår: «zzzq»/);
			const fel = await client.callTool({ name: "kb_sok", arguments: { fraga: "x", fran_ar: 1900, till_ar: 1800 } });
			expect(fel.isError).toBe(true);
			expect(text(fel)).toMatch(/fran_ar är senare än till_ar/);
			const syntax = await client.callTool({ name: "kb_sok", arguments: { fraga: "(hytta" } });
			expect(syntax.isError).toBe(true);
			expect(text(syntax)).toMatch(/felaktig syntax/);
			expect(text(syntax)).not.toMatch(/Försök igen om en stund/);
			const styr = await client.callTool({ name: "kb_sok", arguments: { fraga: "hytta\nFalun" } });
			expect(styr.isError).toBe(true);
			expect(text(styr)).toMatch(/inga radbrytningar/);
			const djup = await client.callTool({ name: "kb_sok", arguments: { fraga: "x", antal: 50, sida: 250 } });
			expect(djup.isError).toBe(true);
			expect(text(djup)).toMatch(/högst 10000 träffar/);
		} finally {
			await client.close();
		}
	});

	it("kb_objekt: sidor, OCR och rättigheter; okänt och borttaget objekt", async () => {
		const { client } = await connectMcp(routes());
		try {
			const r = await client.callTool({ name: "kb_objekt", arguments: { id: "https://digitalt.kb.se/dark-13003706/part/2/page/1" } });
			expect(r.structuredContent).toMatchObject({ id: NP, antal_sidor: 6, sidor_med_text: 6, forsta_bild: 1, sista_bild: 6, pdf: false });
			expect(text(r)).toMatch(/«VÄSTERVIKS VECKOBLAD 1869-07-17»/);
			for (const id of ["dark-404", "dark-410"]) {
				const x = await client.callTool({ name: "kb_objekt", arguments: { id } });
				expect(x.isError, id).toBe(true);
				expect(text(x)).toMatch(new RegExp(`KB har inget objekt med id ${id}`));
			}
			const ogiltig = await client.callTool({ name: "kb_objekt", arguments: { id: "https://evil.example/dark-1" } });
			expect(text(ogiltig)).toMatch(/Ogiltigt KB-id/);
		} finally {
			await client.close();
		}
	});

	it("kb_sida: text med markering, bläddring och bild", async () => {
		const { client } = await connectMcp(routes());
		try {
			const r = await client.callTool({ name: "kb_sida", arguments: { id: NP, bild: 5, markera: ["eld*"], visa_bild: true } });
			expect(r.isError).toBeFalsy();
			const s = r.structuredContent as S;
			expect(s).toMatchObject({ id: NP, bild: 5, antal_sidor: 6, bild_levererad: true });
			expect(s.text.markeringar).toBeGreaterThan(0);
			expect(s.text.rader[0]).toBe("Om ⟦eldsvådan⟧ i Gede");
			const t = text(r);
			expect(t).toMatch(/Källtext: «Om ⟦eldsvådan⟧ i Gede\n {2}│ /);
			expect(t).toMatch(/OCR-säkerhet i snitt 0,\d\d/);
			expect(t).toMatch(/föregående bild 4, nästa bild 6/);
			const bild = (r.content as Array<{ type: string; mimeType?: string }>).find((c) => c.type === "image");
			expect(bild?.mimeType).toBe("image/jpeg");

			const sist = await client.callTool({ name: "kb_sida", arguments: { id: NP, bild: 5, fran_rad: 70 } });
			expect((sist.structuredContent as S).text).toMatchObject({ fran_rad: 70, till_rad: 76, totalt_rader: 76 });
		} finally {
			await client.close();
		}
	});

	it("kb_sida: nekad OCR-fil, sida utan text, okänt bildnummer", async () => {
		const { client } = await connectMcp(routes());
		try {
			const nekad = await client.callTool({ name: "kb_sida", arguments: { id: NP, bild: 2 } });
			expect(nekad.isError).toBeFalsy();
			expect((nekad.structuredContent as S).text_saknas).toMatch(/403/);
			const gravyr = await client.callTool({ name: "kb_sida", arguments: { id: GRAVYR } });
			expect(text(gravyr)).toMatch(/Ingen text: sidan har ingen OCR-text hos KB/);
			expect(text(gravyr)).toMatch(/Sidbild \(IIIF\): https:\/\/data\.kb\.se\/iiif\/3\/dark-27607850%2FPROD_JP2000%2F001929659%2C5200001_0001\.jp2/);
			const del2 = await client.callTool({ name: "kb_sida", arguments: { id: "https://digitalt.kb.se/dark-13003706/part/2/page/1" } });
			expect(del2.isError).toBe(true);
			expect(text(del2)).toMatch(/del 2, sida 1.*ange bild/);
			const del1 = await client.callTool({ name: "kb_sida", arguments: { id: "https://digitalt.kb.se/dark-13003706/part/1/page/5", text: false } });
			expect((del1.structuredContent as S).bild).toBe(5);
			expect(text(del1)).toMatch(/bildnumret 5 är taget ur länken/);
			const fel = await client.callTool({ name: "kb_sida", arguments: { id: NP, bild: 99 } });
			expect(fel.isError).toBe(true);
			expect(text(fel)).toMatch(/ingen sida med bildnummer 99; sidorna har bildnummer 1–6/);
		} finally {
			await client.close();
		}
	});
});
