import { describe, expect, it } from "vitest";
import { DisallowedCallError } from "../src/errors";
import { checkAllowed } from "../src/upstream/allowlist";

const APP = "https://app.raa.se/open/fornsok/api";
const UUID = "adc490ba-871a-45bd-8e3d-0a27761b3b6c";

describe("listan över tillåtna anrop", () => {
	it("släpper igenom de läsanrop som används", () => {
		expect(checkAllowed("GET", `${APP}/lamning/lamning/${UUID}`).id).toBe("fornsokapp.lamning");
		expect(checkAllowed("GET", `${APP}/lamning/lamning/${UUID}/version`).id).toBe("fornsokapp.lamning.version");
		expect(checkAllowed("GET", `${APP}/lamning/dokument?lamning_id=${UUID}`).id).toBe("fornsokapp.dokument");
		expect(checkAllowed("GET", `${APP}/lamning/dokument/fil/123/inventeringsbok%20s%C3%A4tt.jpg`).id).toBe("fornsokapp.dokument.fil");
		expect(checkAllowed("GET", `${APP}/lamning/domaner`).id).toBe("fornsokapp.lamning.domaner");
		expect(checkAllowed("GET", `${APP}/uppdrag/domaner`).id).toBe("fornsokapp.uppdrag.domaner");
		expect(checkAllowed("GET", `https://kulturarvsdata.se/raa/lamning/${UUID}`).id).toBe("ksamsok.lamning");
		const ks = new URL("https://kulturarvsdata.se/ksamsok/api");
		ks.searchParams.set("method", "search");
		ks.searchParams.set("query", 'serviceOrganization="raä"');
		ks.searchParams.set("recordSchema", "xml");
		ks.searchParams.set("fields", "itemId,itemNumber");
		expect(checkAllowed("GET", ks).id).toBe("ksamsok.search");
		const ogc = new URL("https://inspire-raa.metria.se/geoserver/Kulturhistoriska_lamningar/ogc/features/v1/collections/kulturhistoriska_fornlamningar/items");
		ogc.searchParams.set("f", "application/geo+json");
		ogc.searchParams.set("bbox", "15.5,60.6,15.6,60.7");
		ogc.searchParams.set("limit", "1000");
		ogc.searchParams.set("filter-lang", "cql2-text");
		ogc.searchParams.set("filter", "(lamningstyp = 'Hyttområde')");
		expect(checkAllowed("GET", ogc).id).toBe("ogc.items");
	});

	it("avvisar skrivande metoder mot Fornsök-appen, även på läsande sökvägar", () => {
		for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
			expect(() => checkAllowed(m, `${APP}/lamning/lamning/${UUID}`)).toThrow(DisallowedCallError);
		}
	});

	it("avvisar sökvägar som inte står på listan", () => {
		const bad = [
			`${APP}/lamning/lamning`, // lista/skapa
			`${APP}/lamning/lamning/${UUID}/publicera`,
			`${APP}/lamning/lamning/${UUID}/version/1`,
			`${APP}/lamning/lamning/inte-en-uuid`,
			`https://app.raa.se/open/fornsok/proxy/api/lamning/search/lamning`, // POST-sökningen används inte
			`${APP}/lamning/atgard`,
			`${APP}/uppdrag/uppdrag`,
			`${APP}/admin/anything`,
			`${APP}/lamning/lamning/${UUID}/../../uppdrag/uppdrag`,
			`${APP}/lamning/lamning/${UUID}%2F..%2F..%2Fx`,
			`${APP}/lamning/dokument/fil/1/..%2F..%2Fadmin`,
			`${APP}/lamning/dokument/fil/1/a/b`,
			`https://kulturarvsdata.se/ksamsok/admin`,
			`https://kulturarvsdata.se/raa/lamning/${UUID}/extra`,
		];
		for (const u of bad) expect(() => checkAllowed("GET", u), u).toThrow(DisallowedCallError);
	});

	it("avvisar POST mot sökvägen för appens sökning", () => {
		expect(() => checkAllowed("POST", "https://app.raa.se/open/fornsok/proxy/api/lamning/search/lamning")).toThrow(DisallowedCallError);
	});

	it("avvisar fel schema, värd, port, inloggning och fragment", () => {
		expect(() => checkAllowed("GET", `http://app.raa.se/open/fornsok/api/lamning/domaner`)).toThrow(/https/);
		expect(() => checkAllowed("GET", `https://evil.example/open/fornsok/api/lamning/domaner`)).toThrow(DisallowedCallError);
		expect(() => checkAllowed("GET", `https://app.raa.se.evil.example/open/fornsok/api/lamning/domaner`)).toThrow(DisallowedCallError);
		expect(() => checkAllowed("GET", `https://app.raa.se:8443/open/fornsok/api/lamning/domaner`)).toThrow(DisallowedCallError);
		expect(() => checkAllowed("GET", `https://u:p@app.raa.se/open/fornsok/api/lamning/domaner`)).toThrow(DisallowedCallError);
		expect(() => checkAllowed("GET", `https://app.raa.se/open/fornsok/api/lamning/domaner#x`)).toThrow(DisallowedCallError);
		expect(() => checkAllowed("GET", "inte en adress")).toThrow(DisallowedCallError);
	});

	it("avvisar okända eller ogiltiga frågeparametrar", () => {
		expect(() => checkAllowed("GET", `${APP}/lamning/domaner?x=1`)).toThrow(/x/);
		expect(() => checkAllowed("GET", `${APP}/lamning/dokument?lamning_id=1 OR 1=1`)).toThrow(DisallowedCallError);
		expect(() => checkAllowed("GET", `${APP}/lamning/dokument`)).toThrow(/saknas/);
		expect(() => checkAllowed("GET", "https://kulturarvsdata.se/ksamsok/api?method=getRelations&relation=all")).toThrow(DisallowedCallError);
		expect(() => checkAllowed("GET", "https://kulturarvsdata.se/ksamsok/api?method=search&method=search&query=x")).toThrow(/flera/);
	});
});
