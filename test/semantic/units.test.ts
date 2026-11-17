/**
 * Textbyggaren, filteröversättningen, metadata-varianterna och scopeCovers.
 */
import { describe, expect, it } from "vitest";
import { scopeCovers } from "../../src/semantic/coverage";
import {
	kort64,
	MAX_FILTER_BYTE,
	MAX_VARIANTER,
	tillVectorizeFilter,
	varianter,
} from "../../src/semantic/filter";
import { OMFANG_DATA } from "../../src/semantic/omfang-data";
import { cellsForBox, decodeMask, encodeMask, GRID } from "../../src/semantic/omfang-mask";
import { parseScope } from "../../src/semantic/scope";
import { inbaddningstext, MAX_TEXT_TECKEN, rensa } from "../../src/semantic/text";

const DAL = parseScope("Dalarna");

describe("textbyggaren", () => {
	it("tar bort standardfrasen i alla varianter", () => {
		const varianter = [
			"Beskrivningen är inte kvalitetssäkrad. Information kan saknas, vara felaktig eller inaktuell. Se även Inventeringsbok.",
			"Beskrivningen är delvis kvalitetssäkrad. Information kan saknas, vara felaktig eller inaktuell. Se även Inventeringsbok.",
			"Beskrivningen är inte helt kvalitetssäkrad. Information kan saknas, vara felaktig eller inaktuell. Se även Inventeringsbok samt kommentar till inmätning.",
			"Beskrivningen är delvis kvalitetssäkrad. Information kan saknas, vara felaktig eller inaktuell. Se även Inventeringsbok samt utredning under referenser.",
			"Beskrivningen är inte kvalitetssäkrad. Se även Inventeringsbok.",
			"Beskrivningen är inte kvalitetssäkrad. Information kan saknas, vara felaktig eller inaktuell.",
		];
		for (const v of varianter) {
			expect(rensa(v)).toBeNull();
			expect(rensa(`Kolbotten, rund. ${v}`)).toBe("Kolbotten, rund.");
			expect(rensa(`${v}\n\nKolbotten, rund.`)).toBe("Kolbotten, rund.");
		}
		// Rubriken om äldre beskrivning är text, inte standardfrasen.
		expect(rensa("Äldre ej kvalitetssäkrad beskrivning följer nedan: Hålväg.")).toBe(
			"Äldre ej kvalitetssäkrad beskrivning följer nedan: Hålväg.",
		);
	});

	it("bygger texten av typ, namn, beskrivning, tradition och terräng", () => {
		expect(
			inbaddningstext({
				lamningstyp: "Källa med tradition",
				namn: "Mas-källa",
				beskrivning:
					"Trefaldighetskälla, oval. Beskrivningen är inte kvalitetssäkrad. Se även Inventeringsbok.",
				tradition: "Använd som önskekälla.",
				terrang: "Måttlig NÖ-sluttning.",
			}),
		).toBe(
			"Källa med tradition. Namn: Mas-källa. Trefaldighetskälla, oval. Tradition: Använd som önskekälla. Terräng: Måttlig NÖ-sluttning.",
		);
	});

	it("lämningar utan meningsfull text hoppas över; långa texter kortas", () => {
		const tom = { lamningstyp: "Fångstgrop", namn: null, tradition: null, terrang: null };
		expect(inbaddningstext({ ...tom, beskrivning: null })).toBeNull();
		expect(
			inbaddningstext({
				...tom,
				beskrivning: "Beskrivningen är inte kvalitetssäkrad. Se även Inventeringsbok.",
			}),
		).toBeNull();
		expect(inbaddningstext({ ...tom, beskrivning: "Se ovan." })).toBeNull();
		const lang = inbaddningstext({ ...tom, beskrivning: "ord ".repeat(2000) });
		expect(lang?.length).toBeLessThanOrEqual(MAX_TEXT_TECKEN);
	});
});

describe("metadata och filter", () => {
	it("kortar indexerade värden till 64 byte vid teckengräns", () => {
		const s = "Naturföremål/-bildning med bruk, tradition eller namn, ÅÄÖ åäö extra";
		const k = kort64(s);
		expect(new TextEncoder().encode(k).length).toBeLessThanOrEqual(64);
		expect(s.startsWith(k)).toBe(true);
		expect(kort64("Fångstgrop")).toBe("Fångstgrop");
	});

	it("en variant per kombination; vid för många minst en per värde", () => {
		const v = varianter({
			uuid: "u",
			lamningsnummer: "L1:1",
			typ: "T",
			bedomning: "B",
			lan: ["Dalarna"],
			kommun: ["Falun"],
			socken: ["A", "B"],
			landskap: ["Dalarna"],
		});
		expect(v.map((x) => x.socken)).toEqual(["A", "B"]);
		expect(v.every((x) => x.kommun === "Falun" && x.uuid === "u")).toBe(true);
		const many = varianter({
			uuid: "u",
			lamningsnummer: null,
			typ: null,
			bedomning: null,
			lan: ["A", "B"],
			kommun: ["K1", "K2", "K3"],
			socken: ["S1", "S2", "S3"],
			landskap: [],
		});
		expect(many.length).toBe(3);
		for (const k of ["K1", "K2", "K3"]) expect(many.some((x) => x.kommun === k)).toBe(true);
		for (const s of ["S1", "S2", "S3"]) expect(many.some((x) => x.socken === s)).toBe(true);
		expect(many.length).toBeLessThanOrEqual(MAX_VARIANTER);
		expect(
			varianter({
				uuid: "u",
				lamningsnummer: null,
				typ: null,
				bedomning: null,
				lan: [],
				kommun: [],
				socken: [],
				landskap: [],
			}),
		).toEqual([{ uuid: "u" }]);
	});

	it("översätter sökfiltret till metadatafilter och listar det som inte går", () => {
		const r = tillVectorizeFilter({
			lamningstyp: ["Fångstgrop", "Kolbotten"],
			antikvarisk_bedomning: ["Fornlämning"],
			kommun: ["Falun"],
			socken: [{ namn: "Bjursås", lan: ["Dalarna"] }],
			landskap: ["Dalarna"],
			kategori: ["Boplatser"],
			egenskap: [{ typ: "Material", varde: "Koppar" }],
			nara: { lat: 60.6, lon: 15.6, radie_m: 500 },
			nummer: ["L2001:646"],
		});
		expect(r.filter).toEqual({
			typ: { $in: ["Fångstgrop", "Kolbotten"] },
			bedomning: "Fornlämning",
			kommun: "Falun",
			landskap: "Dalarna",
			socken: "Bjursås",
			lan: "Dalarna",
		});
		expect(r.ejTillampat.sort()).toEqual(["egenskap", "kategori", "nara", "nummer"]);
		expect(tillVectorizeFilter({}).filter).toBeUndefined();
	});

	it("ett för stort filter krymps under 2 048 byte", () => {
		const typer = Array.from(
			{ length: 60 },
			(_, i) => `Lämningstyp med ett ganska långt namn nummer ${i}`,
		);
		const r = tillVectorizeFilter({ lamningstyp: typer, kommun: ["Falun"] });
		expect(new TextEncoder().encode(JSON.stringify(r.filter)).length).toBeLessThan(
			MAX_FILTER_BYTE,
		);
		expect(r.filter).toEqual({ kommun: "Falun" });
		expect(r.ejTillampat).toContain("typ");
	});
});

describe("scopeCovers (omfång Dalarna)", () => {
	it("utan geografiskt filter: nej", () => {
		expect(scopeCovers({}, DAL)).toBe(false);
		expect(scopeCovers({ lamningstyp: ["Fångstgrop"] }, DAL)).toBe(false);
	});

	it("län", () => {
		expect(scopeCovers({ lan: ["Dalarna"] }, DAL)).toBe(true);
		expect(scopeCovers({ lan: ["Dalarna", "Uppsala"] }, DAL)).toBe(false);
		expect(scopeCovers({ lan: ["Uppsala"] }, DAL)).toBe(false);
	});

	it("kommun: alla Dalarnas 15 kommuner, inga andra", () => {
		for (const k of ["Falun", "Mora", "Malung-Sälen", "Avesta", "Älvdalen"])
			expect(scopeCovers({ kommun: [k] }, DAL)).toBe(true);
		expect(scopeCovers({ kommun: ["Falun", "Uppsala"] }, DAL)).toBe(false);
		expect(scopeCovers({ kommun: ["Okänd kommun"] }, DAL)).toBe(false);
		const dal = Object.keys(OMFANG_DATA.kommun).filter((k) =>
			scopeCovers({ kommun: [k] }, DAL),
		);
		expect(dal).toHaveLength(15);
	});

	it("socken, med och utan länsavgränsning", () => {
		expect(scopeCovers({ socken: [{ namn: "Bjursås" }] }, DAL)).toBe(true);
		expect(scopeCovers({ socken: [{ namn: "Stora Kopparberg" }] }, DAL)).toBe(true);
		// Berg finns i flera län, inget i Dalarna.
		expect(scopeCovers({ socken: [{ namn: "Berg" }] }, DAL)).toBe(false);
		expect(
			scopeCovers({ socken: [{ namn: "Berg", lan: ["Jämtland"] }] }, parseScope("Jämtland")),
		).toBe(true);
	});

	it("landskap Dalarna sträcker sig utanför länet: nej", () => {
		expect(scopeCovers({ landskap: ["Dalarna"] }, DAL)).toBe(false);
	});

	it("räcker att ett av de OCH-kopplade filtren ligger inom omfånget", () => {
		expect(scopeCovers({ landskap: ["Dalarna"], kommun: ["Falun"] }, DAL)).toBe(true);
	});

	it("nära en punkt: Falu gruva ja, Gävle nej, vid länsgränsen nej", () => {
		expect(scopeCovers({ nara: { lat: 60.6036, lon: 15.6302, radie_m: 1000 } }, DAL)).toBe(
			true,
		);
		expect(scopeCovers({ nara: { lat: 61.0, lon: 14.55, radie_m: 5000 } }, DAL)).toBe(true); // Mora
		expect(scopeCovers({ nara: { lat: 60.6749, lon: 17.1413, radie_m: 1000 } }, DAL)).toBe(
			false,
		); // Gävle
		expect(scopeCovers({ nara: { lat: 60.6036, lon: 15.6302, radie_m: 300_000 } }, DAL)).toBe(
			false,
		);
		expect(scopeCovers({ bbox: [15.6, 60.59, 15.65, 60.62] }, DAL)).toBe(true);
	});

	it("flera län i omfånget", () => {
		const two = parseScope("Dalarna,Gävleborg");
		expect(scopeCovers({ lan: ["Gävleborg"] }, two)).toBe(true);
		expect(scopeCovers({ nara: { lat: 60.6749, lon: 17.1413, radie_m: 1000 } }, two)).toBe(
			true,
		);
	});

	it("omfånget tolkas från inställningen", () => {
		expect(parseScope(undefined).lan).toEqual(["Dalarna"]);
		expect(parseScope("Dalarnas län, 21, Okänt").lan).toEqual(["Dalarna", "Gävleborg"]);
		expect(parseScope("Dalarnas län, 21, Okänt").okanda).toEqual(["Okänt"]);
	});
});

describe("maskkodning", () => {
	it("kodar och avkodar", () => {
		const m = new Uint8Array(GRID.cols * GRID.rows);
		for (const i of [0, 1, 2, 401, 5000, GRID.cols * GRID.rows - 1]) m[i] = 1;
		expect(decodeMask(encodeMask(m))).toEqual(m);
		expect(cellsForBox([GRID.e0 + 10, GRID.n0 + 10, GRID.e0 + 2010, GRID.n0 + 10])).toEqual([
			0, 1,
		]);
		expect(cellsForBox([0, 0, 10, 10])).toBeNull();
	});
});
