/**
 * Kontrakt: RAÄ:s OGC API Features (GeoServer, samlingen
 * `kulturhistoriska_fornlamningar`). Frågorna byggs av projektets egen
 * `buildItemsUrl` (bbox, och bbox + CQL2-filter) och svaren tolkas med
 * `parseFeatureCollection`.
 */
import { describe, it } from "vitest";
import { buildItemsUrl, parseFeatureCollection } from "../../src/sources/ogc/source";
import { en, hamta, jsonSvar, Kontroll, skapaKlient, TESTPOSTER, tolka } from "./stod";

const KALLA = "ogc" as const;
const klient = skapaKlient();
/** Ruta runt L2000:8802 (Hyttområde i Falun). */
const BBOX: [number, number, number, number] = [15.5449, 60.6571, 15.5631, 60.6661];
const NR = "L2000:8802";

const ANROP_BBOX = "items?bbox";
const ANROP_CQL = "items?bbox&filter-lang=cql2-text&filter (lamningstyp)";

const hamtaItems = (anrop: string, url: string) =>
	en(async () => {
		const res = await hamta(KALLA, anrop, () => klient.get(url, "application/geo+json"));
		return { res, data: jsonSvar(KALLA, anrop, res) };
	});

const bbox = hamtaItems(ANROP_BBOX, buildItemsUrl({ bbox: BBOX, limit: 50 }));
// Hyttområde är en lämningstyp i testposten; filtret ska ge färre eller lika många träffar och bara den typen.
const cql = hamtaItems(ANROP_CQL, buildItemsUrl({ bbox: BBOX, limit: 50, lamningstyp: ["Hyttområde"] }));

/** Egenskaper som src/sources/ogc/source.ts läser (parseFeatureCollection) och cql2.ts filtrerar på. */
const TEXTEGENSKAPER = ["lamningsnummer", "lamningstyp", "antikvariskbedomning", "kommun", "lan", "url"];

function kontrolleraSamling(anrop: string, data: unknown): Kontroll {
	const k = new Kontroll(KALLA, anrop);
	k.lika(data, "type", "FeatureCollection");
	k.typ(data, "features", "array");
	k.typ(data, "numberMatched", "number");
	k.typ(data, "numberReturned", "number");
	return k;
}

describe("OGC API Features", () => {
	it("items med bbox: samlingens form och egenskaperna koden läser", async () => {
		const { res, data } = await bbox();
		const k = kontrolleraSamling(ANROP_BBOX, data);
		k.krav(res.contentType.includes("json"), "content-type", `väntade geo+json, fick ${res.contentType || "saknas"}`);
		const features = ((data as { features?: unknown[] }).features ?? []) as Array<Record<string, unknown>>;
		k.krav(features.length >= 1, "features", "väntade minst en lämning i rutan runt L2000:8802");
		const f = features.find((x) => (x.properties as Record<string, unknown> | undefined)?.lamningsnummer === NR);
		k.krav(!!f, `${NR}.properties.lamningsnummer`, "testposten finns inte bland objekten i rutan");
		if (f) {
			k.lika(f, "type", "Feature");
			k.typ(f, "id", "nonEmptyString");
			k.typ(f, "geometry.type", "nonEmptyString");
			k.typ(f, "geometry.coordinates", "array");
			for (const e of TEXTEGENSKAPER) k.typ(f, `properties.${e}`, "nonEmptyString");
			k.typ(f, "properties.raa_nummer", "nonEmptyString");
			k.finns(f, "properties.lamningsnamn");
			k.lika(f, "properties.raa_nummer", TESTPOSTER[NR].raa);
			k.krav(
				new RegExp(`/lamning/${TESTPOSTER[NR].uuid}$`).test(String((f.properties as Record<string, unknown>).url)),
				"properties.url",
				`väntade en länk som slutar på /lamning/${TESTPOSTER[NR].uuid}, fick ${JSON.stringify((f.properties as Record<string, unknown>).url)}`,
			);
		}
		k.klar();
	});

	it("items med bbox: projektets tolkare ger lämningar med UUID och geometri", async () => {
		const { data } = await bbox();
		const sida = tolka(KALLA, ANROP_BBOX, "parseFeatureCollection", () => parseFeatureCollection(data));
		const k = new Kontroll(KALLA, ANROP_BBOX);
		k.krav(sida.features.length >= 1, "features", "tolkaren gav inga lämningar (egenskapen lamningsnummer eller geometri saknas?)");
		const f = sida.features.find((x) => x.lamningsnummer === NR);
		k.krav(!!f, `${NR}.lamningsnummer`, "testposten finns inte efter tolkning");
		k.lika(f, "uuid", TESTPOSTER[NR].uuid);
		k.typ(f, "lamningstyp", "nonEmptyString");
		k.typ(f, "antikvarisk_bedomning", "nonEmptyString");
		k.typ(f, "kommun", "nonEmptyString");
		k.typ(f, "lan", "nonEmptyString");
		k.klar();
	});

	it("items med bbox och CQL2-filter (lamningstyp): filtret verkar", async () => {
		const { data } = await cql();
		const k = kontrolleraSamling(ANROP_CQL, data);
		const features = ((data as { features?: unknown[] }).features ?? []) as Array<Record<string, unknown>>;
		const alla = ((await bbox()).data as { features?: unknown[] }).features ?? [];
		k.krav(features.length >= 1, "features", "filtret lamningstyp = 'Hyttområde' gav inga objekt (CQL2 avvisas eller tolkas om?)");
		k.krav(features.length <= alla.length, "features", `filtrerat svar (${features.length}) större än ofiltrerat (${alla.length})`);
		const fel = features.filter((x) => (x.properties as Record<string, unknown> | undefined)?.lamningstyp !== "Hyttområde");
		k.krav(fel.length === 0, "properties.lamningstyp", `${fel.length} objekt har annan lämningstyp än filtret begärde`);
		k.krav(
			features.some((x) => (x.properties as Record<string, unknown> | undefined)?.lamningsnummer === NR),
			`${NR}.properties.lamningsnummer`,
			"testposten (Hyttområde) saknas i det filtrerade svaret",
		);
		k.klar();
	});
});
