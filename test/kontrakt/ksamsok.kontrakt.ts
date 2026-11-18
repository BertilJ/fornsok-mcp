/**
 * Kontrakt: K-samsök (officiellt, CC0). Frågeformerna är servernas egna
 * (src/sources/ksamsok/query.ts): `serviceName=kmr_lamningar`, `itemNumber`,
 * `boundingBox`, fältsvar (`recordSchema=xml` + `fields`) och presentationssvar,
 * samt en post som JSON-LD. Svaren tolkas med projektets egna tolkare.
 */
import { describe, it } from "vitest";
import { KSAMSOK_LAMNING_HTTPS } from "../../src/config";
import { asArray, mergeHit, parseFieldsRecord, parseJsonLd, parsePresentationRecord, parseSearchResponse, uuidFromUri } from "../../src/sources/ksamsok/parse";
import { buildQuery, buildSearchUrl, SEARCH_FIELDS } from "../../src/sources/ksamsok/query";
import { en, hamta, jsonSvar, Kontroll, skapaKlient, TESTNUMMER, TESTPOSTER, tolka } from "./stod";

const KALLA = "ksamsok" as const;
const klient = skapaKlient();
/** Ruta runt L2000:8802 (Hyttområde i Falun), samma som i servernas egna tester. */
const BBOX: [number, number, number, number] = [15.5449, 60.6571, 15.5631, 60.6661];

const nummerFraga = buildQuery({ nummer: [...TESTNUMMER] });
const bboxFraga = buildQuery({ bbox: BBOX });

const NR_FALT = "search itemNumber (recordSchema=xml, fields)";
const NR_PRES = "search itemNumber (recordSchema=presentation)";
const BB_FALT = "search boundingBox (recordSchema=xml, fields)";
const BB_PRES = "search boundingBox (recordSchema=presentation)";

const sok = (anrop: string, query: string, recordSchema: "xml" | "presentation", hitsPerPage: number) =>
	en(async () => {
		const url = buildSearchUrl(query, { hitsPerPage, startRecord: 1, recordSchema });
		const res = await hamta(KALLA, anrop, () => klient.get(url));
		const parsad = tolka(KALLA, anrop, "svarsform (result.totalHits, result.records.record)", () => parseSearchResponse(res));
		return { res, parsad };
	});

const nummerFalt = sok(NR_FALT, nummerFraga, "xml", 10);
const nummerPres = sok(NR_PRES, nummerFraga, "presentation", 10);
const bboxFalt = sok(BB_FALT, bboxFraga, "xml", 50);
const bboxPres = sok(BB_PRES, bboxFraga, "presentation", 50);

describe("K-samsök: sökning", () => {
	it("itemNumber, fältsvar: de tre testposterna med de fält koden läser", async () => {
		const { res, parsad } = await nummerFalt();
		const k = new Kontroll(KALLA, NR_FALT);
		k.krav(res.contentType.includes("json"), "content-type", `väntade JSON, fick ${res.contentType || "saknas"}`);
		k.krav(parsad.totalHits >= 3, "result.totalHits", `väntade minst 3 (en per testpost), fick ${parsad.totalHits}`);
		k.krav(parsad.records.length >= 3, "result.records.record", `väntade minst 3 poster, fick ${parsad.records.length}`);
		const perUuid = new Map(parsad.records.map((r) => parseFieldsRecord(r)).map((f) => [uuidFromUri(f.get("itemId")?.[0]), f]));
		for (const [nr, p] of Object.entries(TESTPOSTER)) {
			const f = perUuid.get(p.uuid);
			if (!f) {
				k.krav(false, `${nr}.itemId`, `posten med UUID ${p.uuid} finns inte i svaret (itemId ska vara http://kulturarvsdata.se/raa/lamning/{uuid})`);
				continue;
			}
			const nummer = f.get("itemNumber") ?? [];
			k.krav(nummer.includes(nr), `${nr}.itemNumber`, `lämningsnumret saknas bland ${JSON.stringify(nummer)}`);
			k.krav(nummer.includes(p.raa), `${nr}.itemNumber`, `RAÄ-numret ${p.raa} saknas bland ${JSON.stringify(nummer)}`);
			for (const falt of SEARCH_FIELDS) {
				if (falt === "itemId" || falt === "itemNumber") continue;
				const v = f.get(falt);
				k.krav(!!v && v.length > 0 && v.every((x) => x.length > 0), `${nr}.${falt}`, `väntade minst ett icke-tomt värde, fick ${JSON.stringify(v)}`);
			}
		}
		// Samma tolkning som servern: bedömningen ska gå att plocka ur itemSpecification.
		for (const [nr, p] of Object.entries(TESTPOSTER)) {
			const f = perUuid.get(p.uuid);
			if (!f) continue;
			const hit = mergeHit(f, undefined);
			k.krav(hit?.antikvarisk_bedomning != null, `${nr}.itemSpecification`, `ingen känd antikvarisk bedömning bland ${JSON.stringify(f.get("itemSpecification"))}`);
			k.krav(hit?.lamningsnummer === nr, `${nr}.itemNumber`, `lämningsnumret kunde inte urskiljas (L####:#)`);
		}
		k.klar();
	});

	it("itemNumber, presentationssvar: id, etikett, beskrivning och koordinat", async () => {
		const { parsad } = await nummerPres();
		const k = new Kontroll(KALLA, NR_PRES);
		k.krav(parsad.records.length >= 3, "result.records.record", `väntade minst 3 poster, fick ${parsad.records.length}`);
		const perUuid = new Map(parsad.records.map((r) => parsePresentationRecord(r)).map((p) => [p?.uuid.toLowerCase(), p]));
		for (const [nr, p] of Object.entries(TESTPOSTER)) {
			const rec = perUuid.get(p.uuid);
			if (!rec) {
				k.krav(false, `${nr}.pres:item.pres:id`, `posten med UUID ${p.uuid} finns inte i svaret`);
				continue;
			}
			k.krav(rec.idLabel === nr, `${nr}.pres:item.pres:idLabel`, `väntade ${nr}, fick ${JSON.stringify(rec.idLabel)}`);
			k.krav(!!rec.itemLabel, `${nr}.pres:item.pres:itemLabel`, "saknas eller tom");
			k.krav(!!rec.description, `${nr}.pres:item.pres:description`, "saknas eller tom");
			k.krav(!!rec.placeLabel, `${nr}.pres:item.pres:context.pres:placeLabel`, "saknas eller tom");
			k.krav(!!rec.buildDate, `${nr}.pres:item.pres:buildDate`, "saknas eller tom");
			const inSverige = rec.lon !== null && rec.lat !== null && rec.lon > 10 && rec.lon < 25 && rec.lat > 55 && rec.lat < 70;
			k.krav(inSverige, `${nr}.pres:item.georss:where.gml:Point.gml:coordinates`, `väntade lon,lat i Sverige (WGS 84), fick lon=${rec.lon} lat=${rec.lat}`);
		}
		k.klar();
	});

	it("boundingBox (fältsvar + presentationssvar): L2000:8802 ingår, och svaren går att slå ihop på UUID", async () => {
		const f = await bboxFalt();
		const p = await bboxPres();
		const k = new Kontroll(KALLA, `${BB_FALT} + ${BB_PRES}`);
		k.krav(f.parsad.totalHits >= 1, "result.totalHits", `väntade minst 1 träff i rutan, fick ${f.parsad.totalHits}`);
		const fält = f.parsad.records.map((r) => parseFieldsRecord(r));
		const pres = p.parsad.records.map((r) => parsePresentationRecord(r)).filter((x) => x !== null);
		const id = TESTPOSTER["L2000:8802"].uuid;
		const fHit = fält.find((x) => uuidFromUri(x.get("itemId")?.[0]) === id);
		const pHit = pres.find((x) => x.uuid.toLowerCase() === id);
		k.krav(!!fHit, "L2000:8802.itemId", "boundingBox=/WGS84 gav inte testposten i fältsvaret (fråga: boundingBox=/WGS84 \"minLon minLat maxLon maxLat\")");
		k.krav(!!pHit, "L2000:8802.pres:id", "boundingBox=/WGS84 gav inte testposten i presentationssvaret");
		const hit = mergeHit(fHit, pHit);
		k.krav(hit?.koordinat != null, "L2000:8802.koordinat", "ingen koordinat efter sammanslagning");
		k.krav(!!hit?.beskrivning, "L2000:8802.beskrivning", "ingen beskrivning efter sammanslagning");
		k.krav(!!hit?.lamningstyp, "L2000:8802.lamningstyp", "ingen lämningstyp efter sammanslagning");
		k.krav(hit?.lamningsnummer === "L2000:8802", "L2000:8802.lamningsnummer", `fick ${JSON.stringify(hit?.lamningsnummer)}`);
		k.klar();
	});
});

describe("K-samsök: post som JSON-LD", () => {
	// L2001:646 har traditionstext och skriftlig källa; L2000:8802 har ingående lämningar.
	for (const nr of ["L2001:646", "L2000:8802"] as const) {
		const anrop = `GET /raa/lamning/{uuid} (JSON-LD, ${nr})`;
		const hamtaPost = en(async () => {
			const res = await hamta(KALLA, anrop, () => klient.get(`${KSAMSOK_LAMNING_HTTPS}${TESTPOSTER[nr].uuid}`, "application/ld+json"));
			return { res, doc: jsonSvar(KALLA, anrop, res) };
		});

		it(`${nr}: grafen och de fält koden läser`, async () => {
			const { doc } = await hamtaPost();
			const k = new Kontroll(KALLA, anrop);
			k.typ(doc, "@graph", "array");
			const graph = asArray((doc as { "@graph"?: unknown })["@graph"]) as Array<Record<string, unknown>>;
			const typer = (t: string) => graph.filter((n) => asArray(n["@type"] as string | string[]).includes(t));
			const entity = typer("ksam:Entity")[0];
			k.krav(!!entity, "@graph[ksam:Entity]", "ingen nod av typen ksam:Entity");
			k.krav(uuidFromUri(entity?.["@id"] as string | undefined) === TESTPOSTER[nr].uuid, "ksam:Entity.@id", `väntade .../raa/lamning/${TESTPOSTER[nr].uuid}, fick ${JSON.stringify(entity?.["@id"])}`);
			for (const falt of ["ksam:itemDescription", "ksam:itemSpecification", "ksam:itemNumber", "ksam:itemName", "ksam:context", "ksam:presentation", "ksam:buildDate"]) {
				k.krav(entity?.[falt] !== undefined, `ksam:Entity.${falt}`, "fältet saknas");
			}
			for (const t of ["ksam:ItemDescription", "ksam:ItemSpecification", "ksam:ItemNumber", "ksam:ItemName", "ksam:Context"]) {
				k.krav(typer(t).length > 0, `@graph[${t}]`, "ingen nod av typen");
			}
			k.klar();
		});

		it(`${nr}: projektets JSON-LD-tolkare ger en komplett post`, async () => {
			const { doc } = await hamtaPost();
			const r = tolka(KALLA, anrop, "JSON-LD-tolkning", () => parseJsonLd(doc));
			const k = new Kontroll(KALLA, anrop);
			k.krav(r !== null, "parseJsonLd", "ingen lämning hittades i dokumentet");
			const p = r?.post;
			k.lika(p, "uuid", TESTPOSTER[nr].uuid);
			k.lika(p, "lamningsnummer", nr);
			k.lika(p, "raa_nummer", TESTPOSTER[nr].raa);
			k.typ(p, "lamningstyp", "nonEmptyString");
			k.typ(p, "antikvarisk_bedomning.varde", "nonEmptyString");
			k.typ(p, "beskrivning", "nonEmptyString");
			k.typ(p, "terrang", "nonEmptyString");
			k.typ(p, "orientering", "nonEmptyString");
			if (nr === "L2001:646") k.typ(p, "tradition", "nonEmptyString");
			for (const s of ["aktualitet", "undersokning", "skada", "placering"]) k.typ(p, `statusar.${s}`, "nonEmptyString");
			k.typ(p, "lage.lat", "number");
			k.typ(p, "lage.lon", "number");
			k.typ(p, "lage.sweref99tm.e", "number");
			k.typ(p, "lage.geometrityp", "nonEmptyString");
			for (const i of ["lan", "kommun", "socken", "landskap"]) {
				k.krav(((p?.indelning as Record<string, string[]> | undefined)?.[i]?.length ?? 0) > 0, `indelning.${i}`, "tom lista (ksam:Context saknar fältet)");
			}
			k.krav((r?.referenser?.skriftliga_kallor.length ?? 0) > 0, "referenser.skriftliga_kallor", "ingen \"Referens: …skriftlig…\" bland ksam:ItemDescription");
			k.krav(r?.geometriWgs != null, "geometriWgs", "ksam:coordinates (GML) gick inte att tolka till geometri");
			if (nr === "L2000:8802") k.krav((p?.ingaende_lamningar.length ?? 0) > 0, "ingaende_lamningar", "ingen \"Ingående lämningar\" bland ksam:ItemDescription");
			k.klar();
		});
	}
});
