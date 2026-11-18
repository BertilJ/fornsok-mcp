/**
 * Kontrakt: K-samsök (officiellt, CC0). Frågeformerna är servernas egna
 * (src/sources/ksamsok/query.ts): `serviceName=kmr_lamningar`, `itemNumber`,
 * `boundingBox`, fältsvar (`recordSchema=xml` + `fields`) och presentationssvar,
 * samt en post som JSON-LD, och relaterat material (getRelations, relUri och
 * itemId). Svaren tolkas med projektets egna tolkare.
 */
import { describe, it } from "vitest";
import { KSAMSOK_LAMNING_HTTPS } from "../../src/config";
import { asArray, mergeHit, parseFieldsRecord, parseJsonLd, parsePresentationRecord, parseSearchResponse, uuidFromUri } from "../../src/sources/ksamsok/parse";
import { buildQuery, buildSearchUrl, SEARCH_FIELDS } from "../../src/sources/ksamsok/query";
import { FMI_URI_RE, KSAMSOK_OBJEKT_URI_RE, lankVard, objektUrl, parsePresObjekt, parseRelations, relationsUrl, relUriUrl } from "../../src/sources/ksamsok/relations";
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

// ------------------------------------------------------------------ relaterat material (verktyget relaterat)

/**
 * getRelations, relUri-sökningen och objektuppslaget (itemId) som
 * src/sources/ksamsok/relations.ts gör, med serverns egna adresser och tolkare.
 * Tre anrop. L2000:8802 ersätter sex äldre FMI-poster och har inventeringsboks-
 * uppslag (isDescribedBy); Rökstenen (Rök 1:1) har foton med medielicens.
 */
const REL = "getRelations (relation=all, raa/lamning/{uuid})";
const RELURI = "search relUri=lämning OR relUri=FMI-poster (recordSchema=presentation)";
const ITEMID = "search itemId=… OR itemId=… (recordSchema=presentation)";
const ROK_FOTO = "http://kulturarvsdata.se/raa/dokumentation/d86763c2-e93a-4d70-b8ff-a239fdc1fe01";
const ROK_DOK = "http://kulturarvsdata.se/raa/dokumentation/b10bef50-ef93-4078-a507-2234926693a6";

const relationer = en(async () => {
	const res = await hamta(KALLA, REL, () => klient.get(relationsUrl(TESTPOSTER["L2000:8802"].uuid)));
	return tolka(KALLA, REL, "result.relations.relation", () => parseRelations(res));
});

describe("K-samsök: relaterat material", () => {
	it("getRelations: äldre FMI-poster (replaces) och härledda relationer (isDescribedBy, source=deduced)", async () => {
		const rel = await relationer();
		const k = new Kontroll(KALLA, REL);
		k.krav(rel.length >= 2, "result.relations.relation", `väntade minst 2 relationer, fick ${rel.length}`);
		const fmi = rel.filter((r) => r.typ === "replaces");
		k.krav(fmi.length >= 1, "relation[type=replaces]", "ingen relation till en äldre FMI-post");
		k.krav(fmi.every((r) => FMI_URI_RE.test(r.uri)), "relation[type=replaces].content", `väntade http://kulturarvsdata.se/raa/fmi/{id}, fick ${JSON.stringify(fmi.map((r) => r.uri).slice(0, 3))}`);
		const besk = rel.filter((r) => r.typ === "isDescribedBy");
		k.krav(besk.length >= 1, "relation[type=isDescribedBy]", "ingen isDescribedBy (inventeringsboksuppslag)");
		k.krav(besk.every((r) => r.harledd), "relation[type=isDescribedBy].source", 'väntade source="deduced" (relationen står hos dokumentet)');
		k.krav(besk.every((r) => KSAMSOK_OBJEKT_URI_RE.test(r.uri)), "relation.content", "objektets URI har oväntad form");
		k.klar();
	});

	it("relUri-sökning: objekten med de presentationsfält koden läser", async () => {
		const rel = await relationer();
		const fmi = rel.filter((r) => r.typ === "replaces").map((r) => r.uri);
		const egen = `http://kulturarvsdata.se/raa/lamning/${TESTPOSTER["L2000:8802"].uuid}`;
		const res = await hamta(KALLA, RELURI, () => klient.get(relUriUrl([egen, ...fmi])));
		const parsad = tolka(KALLA, RELURI, "svarsform (result.totalHits, result.records.record)", () => parseSearchResponse(res));
		const objekt = parsad.records.map((r) => parsePresObjekt(r)).filter((o) => o !== null);
		const k = new Kontroll(KALLA, RELURI);
		k.krav(objekt.length === parsad.records.length, "pres:item.pres:entityUri", "poster utan pres:entityUri");
		const dok = objekt.filter((o) => o.uri !== egen);
		k.krav(dok.length >= 1, "result.records.record", "inga objekt med relation till lämningen eller FMI-posterna");
		for (const o of dok) {
			k.krav(!!o.typ, `${o.uri}.pres:type`, "saknas");
			k.krav(!!o.tjanst, `${o.uri}.pres:service`, "saknas");
			k.krav(!!o.titel, `${o.uri}.pres:itemLabel`, "saknas");
			k.krav(!!o.institution, `${o.uri}.pres:organization`, "saknas");
			k.krav(!!o.url, `${o.uri}.pres:representations[format=HTML]`, "ingen HTML-representation (länken till objektets sida)");
		}
		k.krav(dok.some((o) => o.tjanst === "arkiv-dokument"), "pres:service", `väntade minst ett inventeringsboksuppslag (arkiv-dokument), fick ${JSON.stringify([...new Set(dok.map((o) => o.tjanst))])}`);
		// Objekt som inte har en relation till lämningen är funna via en FMI-post: koden läser
		// vilken ur pres:references (annars "koppling okänd"). Andra lämningar som ersätter samma
		// FMI-post har inga referenser och räknas inte här.
		const direkt = new Set(rel.map((r) => r.uri));
		const viaFmi = dok.filter((o) => !direkt.has(o.uri) && !/\/raa\/lamning\//.test(o.uri));
		const utanRef = viaFmi.filter((o) => !o.referenser.some((r) => fmi.includes(r)));
		k.krav(utanRef.length === 0, "pres:references.pres:reference", `${utanRef.length} av ${viaFmi.length} objekt funna via en FMI-post saknar referens till FMI-posten, t.ex. ${utanRef[0]?.uri}`);
		// Länkarna för testposten går till kända värdar (andra står som "extern länk, värd: …" i svaret).
		const vardar = [...new Set(dok.flatMap((o) => [o.url, ...o.bilder.flatMap((b) => [b.miniatyr, b.stor, b.licens_url])]).filter((u): u is string => !!u).map((u) => lankVard(u)).filter((v) => !v.kand).map((v) => v.vard))];
		k.krav(vardar.length === 0, "pres:representations / pres:image", `länkar till värdar utanför listan över kända värdar: ${JSON.stringify(vardar)}`);
		k.klar();
	});

	it("objektuppslag med itemId: foto med bildlänkar och medielicens, dokument utan", async () => {
		const res = await hamta(KALLA, ITEMID, () => klient.get(objektUrl([ROK_FOTO, ROK_DOK])));
		const parsad = tolka(KALLA, ITEMID, "svarsform (result.totalHits, result.records.record)", () => parseSearchResponse(res));
		const objekt = new Map(parsad.records.map((r) => parsePresObjekt(r)).filter((o) => o !== null).map((o) => [o.uri, o]));
		const k = new Kontroll(KALLA, ITEMID);
		k.krav(objekt.size === 2, "result.records.record", `väntade 2 objekt, fick ${objekt.size}`);
		const foto = objekt.get(ROK_FOTO);
		k.krav(foto?.typ === "Foto" && foto?.tjanst === "arkiv-bilder", `${ROK_FOTO}.pres:type/pres:service`, `väntade Foto/arkiv-bilder, fick ${foto?.typ}/${foto?.tjanst}`);
		const b = foto?.bilder[0];
		k.krav(!!b, `${ROK_FOTO}.pres:image`, "saknas");
		k.krav(!!b?.miniatyr && !!b?.stor, `${ROK_FOTO}.pres:image.pres:src[type=thumbnail|highres]`, "bildlänkar saknas");
		k.krav(!!b?.licens && /^http:\/\/kulturarvsdata\.se\/resurser\/license#/.test(b.licens), `${ROK_FOTO}.pres:image.pres:mediaLicense`, `väntade en licens-URI, fick ${JSON.stringify(b?.licens)}`);
		k.krav(!!b?.licens_url, `${ROK_FOTO}.pres:image.pres:mediaLicenseUrl`, "saknas");
		k.krav(b?.upphovsratt !== null && b?.upphovsratt !== undefined, `${ROK_FOTO}.pres:image.pres:copyright`, "saknas");
		const dok = objekt.get(ROK_DOK);
		k.krav(dok?.tjanst === "arkiv-dokument", `${ROK_DOK}.pres:service`, `väntade arkiv-dokument, fick ${dok?.tjanst}`);
		k.klar();
	});
});
