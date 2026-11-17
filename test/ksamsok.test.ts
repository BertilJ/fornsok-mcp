import { describe, expect, it } from "vitest";
import { UpstreamError } from "../src/errors";
import {
	asArray,
	extractXmlError,
	mergeHit,
	parseFieldsRecord,
	parseIngaendeText,
	parseJsonLd,
	parsePresentationRecord,
	parseSearchResponse,
} from "../src/sources/ksamsok/parse";
import { BASE_QUERY, bboxClause, buildQuery, buildSearchUrl, quote, splitWords } from "../src/sources/ksamsok/query";
import { KsamsokSource } from "../src/sources/ksamsok/source";
import { UpstreamClient, type UpstreamResponse } from "../src/upstream/client";
import { fakeFetch, fixture, fixtureText, json, standardRoutes } from "./helpers";

const raw = (body: string, status = 200, contentType = "application/json;charset=UTF-8"): UpstreamResponse => ({
	body,
	status,
	contentType,
	url: "https://kulturarvsdata.se/ksamsok/api",
});

describe("K-samsök: frågebyggaren", () => {
	it("använder raä och kmr_lamningar", () => {
		expect(BASE_QUERY).toBe('serviceOrganization="raä" AND serviceName="kmr_lamningar"');
		expect(buildQuery({})).toBe(BASE_QUERY);
	});

	it("citerar värden och undantar \" och \\", () => {
		expect(quote("Falun")).toBe('"Falun"');
		expect(quote('a"b')).toBe('"a\\"b"');
		expect(quote("a\\b")).toBe('"a\\\\b"');
		expect(quote('x" OR serviceOrganization="y')).toBe('"x\\" OR serviceOrganization=\\"y"');
	});

	it("OCH-kopplar ord i stället för att citera flera ord tillsammans", () => {
		expect(splitWords("  slagg, hytta!  ")).toEqual(["slagg", "hytta"]);
		const q = buildQuery({ ord: ["slagg", "hytta"] });
		expect(q).toBe(`${BASE_QUERY} AND text="slagg" AND text="hytta"`);
		expect(q).not.toContain('text="slagg hytta"');
	});

	it("söker nummer via itemNumber, typ via itemName, bedömning via itemSpecification", () => {
		const q = buildQuery({
			nummer: ["L2001:646", "Stugun 114:1"],
			lamningstyp: ["Hyttområde"],
			antikvarisk_bedomning: ["Fornlämning", "Möjlig fornlämning"],
		});
		expect(q).toContain('(itemNumber="L2001:646" OR itemNumber="Stugun 114:1")');
		expect(q).toContain('itemName="Hyttområde"');
		expect(q).toContain('(itemSpecification="Fornlämning" OR itemSpecification="Möjlig fornlämning")');
		expect(q).not.toContain("itemLabel");
		expect(q).not.toMatch(/\btext="L2001/);
	});

	it("använder indexnamnen för indelning och länets kortnamn", () => {
		const q = buildQuery({ kommun: ["Falun"], socken: [{ namn: "Näs", lan: ["Jämtland"] }, { namn: "Bjursås" }], landskap: ["Dalarna"], lan: ["Dalarna"] });
		expect(q).toContain('municipalityName="Falun"');
		expect(q).toContain('((parishName="Näs" AND countyName="Jämtland") OR parishName="Bjursås")');
		expect(q).toContain('provinceName="Dalarna"');
		expect(q).toContain('countyName="Dalarna"');
		expect(q).not.toContain("Dalarnas län");
	});

	it("skriver boundingBox som /WGS84 \"minLon minLat maxLon maxLat\"", () => {
		expect(bboxClause([15.5449, 60.6571, 15.5631, 60.6661])).toBe('boundingBox=/WGS84 "15.5449 60.6571 15.5631 60.6661"');
	});

	it("bygger sökadressen med fields bara i xml-schemat", () => {
		const p = new URL(buildSearchUrl("x", { hitsPerPage: 15, startRecord: 16, recordSchema: "presentation" }));
		expect(p.searchParams.get("method")).toBe("search");
		expect(p.searchParams.get("startRecord")).toBe("16");
		expect(p.searchParams.get("fields")).toBeNull();
		const x = new URL(buildSearchUrl("x", { hitsPerPage: 5000, startRecord: 1, recordSchema: "xml" }));
		expect(x.searchParams.get("fields")).toContain("itemSpecification");
		expect(x.searchParams.get("hitsPerPage")).toBe("1000");
	});
});

describe("K-samsök: tolkning", () => {
	it("normaliserar objekt eller lista", () => {
		expect(asArray(undefined)).toEqual([]);
		expect(asArray({ a: 1 })).toEqual([{ a: 1 }]);
		expect(asArray([1, 2])).toEqual([1, 2]);
	});

	it("tolkar en träff där record är ett objekt", () => {
		const r = parseSearchResponse(raw(fixtureText("ksamsok-search-646-fields-single.json")));
		expect(r.totalHits).toBe(1);
		expect(r.records).toHaveLength(1);
		const f = parseFieldsRecord(r.records[0]);
		expect(f.get("itemNumber")).toEqual(["L2001:646", "Bjursås 27:1"]);
	});

	it("tolkar flera träffar där record är en lista", () => {
		const r = parseSearchResponse(raw(fixtureText("ksamsok-search-testposter-fields.json")));
		expect(r.totalHits).toBe(3);
		expect(r.records).toHaveLength(3);
	});

	it("tolkar field som objekt (ett fält)", () => {
		const f = parseFieldsRecord({ field: { name: "itemId", content: "http://kulturarvsdata.se/raa/lamning/adc490ba-871a-45bd-8e3d-0a27761b3b6c" } });
		expect(f.get("itemId")).toHaveLength(1);
		const hit = mergeHit(f, undefined);
		expect(hit?.uuid).toBe("adc490ba-871a-45bd-8e3d-0a27761b3b6c");
	});

	it("tolkar noll träffar utan records", () => {
		const r = parseSearchResponse(raw(JSON.stringify({ result: { totalHits: 0, version: 1 } })));
		expect(r).toEqual({ totalHits: 0, records: [] });
	});

	it("skiljer lämningsnummer från RAÄ-nummer och bedömning från aktualitetsstatus", () => {
		const r = parseSearchResponse(raw(fixtureText("ksamsok-search-testposter-fields.json")));
		const hits = r.records.map((x) => mergeHit(parseFieldsRecord(x), undefined));
		const h646 = hits.find((h) => h?.lamningsnummer === "L2001:646");
		// I K-samsöks svar kommer RAÄ-numret först för just den här posten.
		expect(h646?.raa_nummer).toBe("Bjursås 27:1");
		expect(h646?.antikvarisk_bedomning).toBe("Övrig kulturhistorisk lämning");
		expect(h646?.lamningstyp).toBe("Källa med tradition");
		expect(h646?.lan).toEqual(["Dalarna"]);
		const h8802 = hits.find((h) => h?.lamningsnummer === "L2000:8802");
		expect(h8802?.antikvarisk_bedomning).toBe("Fornlämning");
		expect(h8802?.raa_nummer).toBe("Stora Kopparberg 172:1");
	});

	it("tolkar presentationsposten (mittpunkt, beskrivning)", () => {
		const r = parseSearchResponse(raw(fixtureText("ksamsok-search-646-presentation-single.json")));
		const p = parsePresentationRecord(r.records[0]);
		expect(p).toMatchObject({
			uuid: "adc490ba-871a-45bd-8e3d-0a27761b3b6c",
			idLabel: "L2001:646",
			itemLabel: "Källa med tradition",
			lat: 60.73368161435678,
			lon: 15.456428761252013,
			buildDate: "2026-11-14",
		});
		expect(p?.description).toMatch(/^Trefaldighetskälla/);
	});

	it("tolkar JSON-fel (okänt fältnamn ger 400)", () => {
		const body = JSON.stringify({ result: { error: "Det efterfrågade fältet/indexet thumbnail finns inte eller stöds inte.", version: 1 } });
		expect(() => parseSearchResponse(raw(body, 400))).toThrow(/thumbnail finns inte/);
		expect(() => parseSearchResponse(raw(body, 400))).toThrow(UpstreamError);
	});

	it("tolkar inspelat parserfel (500)", () => {
		expect(() => parseSearchResponse(raw(fixtureText("ksamsok-error-syntax-500.json"), 500))).toThrow(/CQL/);
	});

	it("tolkar fel som kommer som XML trots Accept: application/json", () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?><result><version>1.0</version><error>ogiltligt format på boundingBox</error></result>`;
		expect(() => parseSearchResponse(raw(xml, 400, "text/xml;charset=UTF-8"))).toThrow(/ogiltligt format på boundingBox/);
		// Även om innehållstypen påstår JSON.
		expect(() => parseSearchResponse(raw(xml, 200))).toThrow(/ogiltligt format/);
		expect(extractXmlError("<a><error>x &amp; y</error></a>")).toBe("x & y");
	});

	it("tolkar JSON-LD med typade noder", () => {
		const r = parseJsonLd(fixture("ksamsok-jsonld-L2001-646.json"));
		expect(r).not.toBeNull();
		const p = r!.post;
		expect(p.lamningsnummer).toBe("L2001:646");
		expect(p.raa_nummer).toBe("Bjursås 27:1");
		expect(p.uuid).toBe("adc490ba-871a-45bd-8e3d-0a27761b3b6c");
		expect(p.lamningstyp).toBe("Källa med tradition");
		expect(p.antikvarisk_bedomning.varde).toBe("Övrig kulturhistorisk lämning");
		expect(p.beskrivning).toMatch(/^Trefaldighetskälla/);
		expect(p.tradition).toBe("Fru Lax Greta Holm har använt källan som önskekälla.");
		expect(p.terrang).toBe("Måttlig NÖ-sluttning. Moränmark. Skogsmark (blandskog).");
		expect(p.orientering).toMatch(/^Omedelbart Ö om stig/);
		expect(p.statusar).toEqual({ aktualitet: "Bekräftad i fält", undersokning: "Okänd", skada: "Okänd", placering: "Synlig ovan mark" });
		expect(p.indelning).toEqual({ lan: ["Dalarna"], kommun: ["Falun"], socken: ["Bjursås"], landskap: ["Dalarna"] });
		expect(p.lage.lat).toBeCloseTo(60.73368161435678, 10);
		expect(p.lage.sweref99tm?.e).toBeCloseTo(524892.6, 0);
		expect(p.hamtad_fran).toContain("K-samsök");
		expect(r!.referenser.skriftliga_kallor).toEqual(["Forsslund, K-E.: Med Dalälven från källorna till havet, Bjursås och Ål, 1923."]);
		expect(r!.geometriWgs?.type).toBe("Point");
	});

	it("tolkar JSON-LD med flera geometrier och ingående lämningar", () => {
		const r = parseJsonLd(fixture("ksamsok-jsonld-L2000-8802.json"))!;
		expect(r.geometriWgs?.type).toBe("GeometryCollection");
		expect(r.post.ingaende_lamningar.length).toBe(5);
		expect(r.post.ingaende_lamningar[2]).toEqual({
			lamningstyp: "Hyttlämning",
			antal: 2,
			egenskaper: [
				{ typ: "Material", varde: "Koppar" },
				{ typ: "Typ", varde: "Hytta/ugn" },
			],
		});
		const l = parseJsonLd(fixture("ksamsok-jsonld-L1946-7415.json"))!;
		expect(l.geometriWgs?.type).toBe("LineString");
	});

	it("delar texten för ingående lämningar", () => {
		expect(parseIngaendeText("Husgrund, historisk tid - Verksamhet: Bergsbruk, antal 5.Kolbotten, antal 2")).toEqual([
			{ lamningstyp: "Husgrund, historisk tid", antal: 5, egenskaper: [{ typ: "Verksamhet", varde: "Bergsbruk" }] },
			{ lamningstyp: "Kolbotten", antal: 2, egenskaper: [] },
		]);
	});
});

describe("K-samsök: källan", () => {
	it("slår ihop presentation och fält till träffar", async () => {
		const { fetch, calls } = fakeFetch(standardRoutes());
		const src = new KsamsokSource(new UpstreamClient({ fetch }));
		const page = await src.search({ ord: ["slagg", "hytta"], kommun: ["Falun"], antikvarisk_bedomning: ["Fornlämning"] }, { antal: 5, sida: 1 });
		expect(calls).toHaveLength(2);
		expect(page.totalt).toBe(39);
		expect(page.traffar).toHaveLength(5);
		const first = page.traffar[0];
		expect(first.lamningsnummer).toBe("L1999:1393");
		expect(first.raa_nummer).toBe("Sundborn 18:1");
		expect(first.antikvarisk_bedomning).toBe("Fornlämning");
		expect(first.koordinat).not.toBeNull();
		expect(first.beskrivning).toBeTruthy();
		expect(page.byggdatum).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("slår upp nummer exakt", async () => {
		const { fetch } = fakeFetch(standardRoutes());
		const src = new KsamsokSource(new UpstreamClient({ fetch }));
		const m = await src.resolveNumbers(["L2001:646", "Stugun 114:1", "stora kopparberg 172:1", "L9999:1"]);
		expect(m.get("L2001:646")).toBe("adc490ba-871a-45bd-8e3d-0a27761b3b6c");
		expect(m.get("Stugun 114:1")).toBe("bfe10d94-5d11-4943-8085-4b1bfcaacf64");
		expect(m.get("stora kopparberg 172:1")).toBe("6d1cf7b6-f5bd-4066-aba6-fb1ea3ce8c75");
		expect(m.has("L9999:1")).toBe(false);
	});

	it("rapporterar K-samsöks felmeddelande", async () => {
		const { fetch } = fakeFetch([{ match: () => true, respond: () => json({ result: { error: "Parametern fields saknas eller är tom", version: 1 } }, 400) }]);
		const src = new KsamsokSource(new UpstreamClient({ fetch }));
		await expect(src.search({ ord: ["x"] }, { antal: 1, sida: 1 })).rejects.toThrow(/fields saknas/);
	});
});
