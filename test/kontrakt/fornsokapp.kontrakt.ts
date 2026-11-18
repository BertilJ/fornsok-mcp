/**
 * Kontrakt: Fornsök-appens läs-API (`app.raa.se/open/fornsok/api/…`). Det här är
 * den odokumenterade källan som kan ändras utan förvarning, så den bevakas
 * fält för fält: varje fält som src/sources/fornsokapp/ och src/sync/post.ts
 * läser kontrolleras, dels i den råa JSON:en, dels genom projektets egna
 * tolkare (så att tyst nollställning av ett fält också upptäcks).
 *
 * Anrop: fullständig post (3), versionshistorik (2), dokumentlista (2, plus ett
 * för en lämning utan dokument), de två värdelistorna (2) och en bildfil
 * (bara rubrikerna och de första byten).
 */
import { describe, it } from "vitest";
import { FORNSOK_APP_API } from "../../src/config";
import { FIL_ID_RE, parseDokumentLista, parseVersioner } from "../../src/sources/fornsokapp/dokument";
import { parseAppLamning, parseDomaner } from "../../src/sources/fornsokapp/parse";
import { FornsokAppSource } from "../../src/sources/fornsokapp/source";
import { BEDOMNINGAR } from "../../src/sources/types";
import { appTillPost } from "../../src/sync/post";
import { en, hamta, jsonSvar, klassa, Kontroll, kontrolleraStatus, skapaKlient, sokvag, TESTPOSTER, type Testpost, tolka } from "./stod";

const KALLA = "fornsokapp" as const;
const klient = skapaKlient();
const kalla = new FornsokAppSource(klient);

type Obj = Record<string, unknown>;
const arr = (x: unknown): Obj[] => (Array.isArray(x) ? (x as Obj[]) : []);
const NUMMER = Object.keys(TESTPOSTER) as Testpost[];

// ------------------------------------------------------------------ fullständig post

const anropPost = (nr: Testpost) => `GET lamning/lamning/{uuid} (${nr})`;
const hamtaPost = (nr: Testpost) =>
	en(async () => {
		const res = await hamta(KALLA, anropPost(nr), () => klient.get(`${FORNSOK_APP_API}/lamning/lamning/${TESTPOSTER[nr].uuid}`));
		return jsonSvar(KALLA, anropPost(nr), res) as Obj;
	});
const poster: Record<Testpost, () => Promise<Obj>> = {
	"L1946:7415": hamtaPost("L1946:7415"),
	"L2000:8802": hamtaPost("L2000:8802"),
	"L2001:646": hamtaPost("L2001:646"),
};

/** Textfält som koden läser: nyckeln ska finnas, värdet text eller null. */
const TEXTFALT = ["antikvarisk_kommentar", "antikvariskbedomning_motivering", "tradition", "terrang", "orientering", "vegetation"] as const;
const LOKAL_TID = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?$/;

describe("Fornsök-appen: fullständig post", () => {
	for (const nr of NUMMER) {
		const anrop = anropPost(nr);

		it(`${nr}: identitet, text, statusar och referenser`, async () => {
			const d = await poster[nr]();
			const k = new Kontroll(KALLA, anrop);
			k.lika(d, "lamning_id", TESTPOSTER[nr].uuid);
			k.lika(d, "lamningsnummer", nr);
			k.lika(d, "legacy.raa_nummer", TESTPOSTER[nr].raa);
			k.typ(d, "lamningstyp_namn", "nonEmptyString");
			k.typ(d, "antikvariskbedomningtyp_namn", "nonEmptyString");
			k.krav(
				(BEDOMNINGAR as readonly string[]).includes(String(d.antikvariskbedomningtyp_namn)),
				"antikvariskbedomningtyp_namn",
				`okänt värde ${JSON.stringify(d.antikvariskbedomningtyp_namn)}; servern känner ${BEDOMNINGAR.join(", ")}`,
			);
			k.typ(d, "beskrivning", "nonEmptyString");
			for (const f of TEXTFALT) k.finns(d, f).typ(d, f, "nullableString");
			for (const f of ["alternativnamn", "egenskaper", "ingaendelamningar", "skriftlig_kalla_referenser", "kartmaterial_referenser", "uppgiftslamnare_referenser"]) {
				k.typ(d, f, "array");
			}
			for (const [obj, namn] of [
				["aktualitetstatus", "aktualitetstatustyp_namn"],
				["undersokningsstatus", "undersokningsstatustyp_namn"],
				["skadestatus", "skadestatustyp_namn"],
			] as const) {
				k.typ(d, `${obj}.${namn}`, "nonEmptyString");
			}
			k.typ(d, "placeringtyp_namn", "nonEmptyString");
			k.typ(d, "registrerare_organisationsnamn", "nonEmptyString");
			k.typ(d, "senast_andrad", "nonEmptyString");
			k.typ(d, "publiceringsdatum", "nonEmptyString");
			k.krav(LOKAL_TID.test(String(d.publiceringsdatum)), "publiceringsdatum", `väntade lokal tid utan zon (ÅÅÅÅ-MM-DDTtt:mm:ss[.ffffff]), fick ${JSON.stringify(d.publiceringsdatum)}`);
			k.klar();
		});

		it(`${nr}: läget (nuvarande_lage) med geometri, osäkerhet och indelning`, async () => {
			const d = await poster[nr]();
			const k = new Kontroll(KALLA, anrop);
			const lage = "nuvarande_lage";
			k.typ(d, `${lage}.centrum.ost`, "number");
			k.typ(d, `${lage}.centrum.nord`, "number");
			k.typ(d, `${lage}.inmatningsosakerhet_meter`, "number");
			k.typ(d, `${lage}.utbredningsosakerhet_meter`, "number");
			k.typ(d, `${lage}.felmarginal_meter`, "number");
			for (const f of ["min_meter_over_havet", "max_meter_over_havet"]) k.finns(d, `${lage}.${f}`).typ(d, `${lage}.${f}`, "nullableNumber");
			// Geometrin: en FeatureCollection i EPSG:3006.
			k.lika(d, `${lage}.geometri.type`, "FeatureCollection");
			k.typ(d, `${lage}.geometri.features`, "array");
			k.typ(d, `${lage}.geometri.features[0].geometry.type`, "nonEmptyString");
			k.typ(d, `${lage}.geometri.features[0].geometry.coordinates`, "array");
			k.typ(d, `${lage}.geometri.features[0].properties.geometrinummer`, "nonEmptyString");
			k.typ(d, `${lage}.geometri.features[0].id`, "nonEmptyString");
			// Geografisk indelning med koder.
			const gi = `${lage}.geografisk_indelning`;
			for (const f of ["kommun_kod", "kommun_namn", "lan_kod", "lan_namn"]) k.typ(d, `${gi}.kommun[0].${f}`, "nonEmptyString");
			for (const f of ["socken_id", "socken_namn"]) k.typ(d, `${gi}.socken[0].${f}`, "nonEmptyString");
			for (const f of ["landskap_kod", "landskap_namn"]) k.typ(d, `${gi}.landskap[0].${f}`, "nonEmptyString");
			k.klar();
		});

		it(`${nr}: projektets tolkare (parseAppLamning och appTillPost) ger en komplett post`, async () => {
			const d = await poster[nr]();
			const a = `${anrop} → tolkning`;
			const r = tolka(KALLA, a, "parseAppLamning", () => parseAppLamning(d));
			const sync = tolka(KALLA, a, "appTillPost", () => appTillPost(d, "2000-01-01"));
			const k = new Kontroll(KALLA, a);
			k.krav(r !== null, "parseAppLamning", "gav ingen post (lamning_id saknas?)");
			k.krav(sync !== null, "appTillPost", "gav ingen post (lamning_id saknas eller har fel form?)");
			const p = r?.post;
			k.lika(p, "uuid", TESTPOSTER[nr].uuid);
			k.lika(p, "lamningsnummer", nr);
			k.lika(p, "raa_nummer", TESTPOSTER[nr].raa);
			k.typ(p, "lamningstyp", "nonEmptyString");
			k.typ(p, "antikvarisk_bedomning.varde", "nonEmptyString");
			k.typ(p, "beskrivning", "nonEmptyString");
			for (const s of ["aktualitet", "undersokning", "skada", "placering"]) k.typ(p, `statusar.${s}`, "nonEmptyString");
			for (const f of ["lage.lat", "lage.lon", "lage.sweref99tm.e", "lage.sweref99tm.n", "lage.osakerhet_m"]) k.typ(p, f, "number");
			k.typ(p, "lage.geometrityp", "nonEmptyString");
			for (const i of ["lan", "kommun", "socken", "landskap"]) {
				k.krav(((p?.indelning as Record<string, string[]> | undefined)?.[i]?.length ?? 0) > 0, `indelning.${i}`, "tom lista efter tolkning");
			}
			k.krav(r?.geometriSweref != null, "geometriSweref", "ingen geometri efter tolkning av nuvarande_lage.geometri");
			const s = sync?.post;
			k.lika(s, "uuid", TESTPOSTER[nr].uuid);
			k.lika(s, "lamningsnummer", nr);
			for (const f of ["lamningstyp", "bedomning", "publicerad_av", "publiceringsdatum", "aktualitet", "skada", "undersokning", "placering", "lan", "kommun", "socken"]) {
				k.typ(s, f, "nonEmptyString");
			}
			k.typ(s, "osakerhet_m", "number");
			k.krav((s?.geometrier.length ?? 0) > 0, "geometrier", "inga geometrier efter tolkning");
			k.krav(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?[+-]\d{2}:\d{2}$/.test(String(s?.publiceringsdatum)),
				"publiceringsdatum",
				`väntade ISO med svensk tidszon efter omräkning, fick ${JSON.stringify(s?.publiceringsdatum)}`,
			);
			k.klar();
		});
	}

	it("L2000:8802: ingående lämningar med egenskaper, och skriftliga källor", async () => {
		const d = await poster["L2000:8802"]();
		const k = new Kontroll(KALLA, anropPost("L2000:8802"));
		k.krav(arr(d.ingaendelamningar).length >= 1, "ingaendelamningar", "väntade minst en ingående lämning");
		k.typ(d, "ingaendelamningar[0].lamningstyp_namn", "nonEmptyString");
		k.typ(d, "ingaendelamningar[0].antal", "number");
		k.typ(d, "ingaendelamningar[0].egenskaper[0].egenskapstyp_namn", "nonEmptyString");
		k.typ(d, "ingaendelamningar[0].egenskaper[0].egenskapsvarden[0].egenskapsvarde_namn", "nonEmptyString");
		k.krav(arr(d.skriftlig_kalla_referenser).length >= 1, "skriftlig_kalla_referenser", "väntade minst en källa");
		k.typ(d, "skriftlig_kalla_referenser[0].referens", "nonEmptyString");
		k.typ(d, "orientering", "nonEmptyString");
		k.typ(d, "terrang", "nonEmptyString");
		const sync = appTillPost(d, "2000-01-01");
		k.krav((sync?.post.ingaende.length ?? 0) > 0 && (sync?.post.egenskaper.length ?? 0) > 0, "ingaende/egenskaper", "inga ingående lämningar eller egenskaper efter tolkning (appTillPost)");
		k.klar();
	});

	it("L2001:646: egenskaper, alternativt namn och traditionstext", async () => {
		const d = await poster["L2001:646"]();
		const k = new Kontroll(KALLA, anropPost("L2001:646"));
		k.typ(d, "egenskaper[0].egenskapstyp_namn", "nonEmptyString");
		k.typ(d, "egenskaper[0].egenskapsvarden[0].egenskapsvarde_namn", "nonEmptyString");
		k.typ(d, "alternativnamn[0]", "nonEmptyString");
		k.typ(d, "tradition", "nonEmptyString");
		const sync = appTillPost(d, "2000-01-01");
		k.krav((sync?.post.egenskaper.length ?? 0) > 0, "egenskaper", "inga egenskaper efter tolkning (appTillPost)");
		k.krav(!!sync?.post.namn, "namn", "alternativnamn gav inget namn efter tolkning (appTillPost)");
		k.klar();
	});
});

// ------------------------------------------------------------------ versionshistorik

describe("Fornsök-appen: versionshistorik", () => {
	for (const nr of ["L1946:7415", "L2000:8802"] as const) {
		const anrop = `GET lamning/lamning/{uuid}/version (${nr})`;
		const hamtaVersioner = en(async () => {
			const res = await hamta(KALLA, anrop, () => klient.get(`${FORNSOK_APP_API}/lamning/lamning/${TESTPOSTER[nr].uuid}/version`));
			return jsonSvar(KALLA, anrop, res);
		});

		it(`${nr}: lista med versioner och de fält koden läser`, async () => {
			const data = await hamtaVersioner();
			const k = new Kontroll(KALLA, anrop);
			k.krav(Array.isArray(data) && data.length >= 1, "svaret", "väntade en icke-tom lista");
			arr(data).forEach((rad, i) => {
				const p = `[${i}]`;
				k.typ(data, `${p}.version_id`, "number");
				k.typ(data, `${p}.publiceringsdatum`, "nonEmptyString");
				k.typ(data, `${p}.registrerare_organisationsnamn`, "nonEmptyString");
				k.typ(data, `${p}.aktivitetsref.aktivitetstyp`, "nonEmptyString");
				k.typ(data, `${p}.aktivitetsref.registreringstid`, "nonEmptyString");
				const typ = sokvag(rad, "aktivitetsref.aktivitetstyp");
				k.krav(typ === "Atgard" || typ === "Uppdrag", `${p}.aktivitetsref.aktivitetstyp`, `okänd typ ${JSON.stringify(typ)}; koden känner Atgard och Uppdrag`);
				if (typ === "Atgard") {
					k.typ(data, `${p}.aktivitetsref.atgardsnummer`, "nonEmptyString");
					k.typ(data, `${p}.aktivitetsref.atgardtyp_namn`, "nonEmptyString");
					k.finns(data, `${p}.aktivitetsref.beskrivning`);
				} else if (typ === "Uppdrag") {
					k.typ(data, `${p}.aktivitetsref.uppdragsnummer`, "nonEmptyString");
				}
			});
			k.klar();
		});

		it(`${nr}: projektets tolkare (parseVersioner)`, async () => {
			const data = await hamtaVersioner();
			const v = tolka(KALLA, anrop, "parseVersioner", () => parseVersioner(data));
			const k = new Kontroll(KALLA, anrop);
			k.krav(v.length >= 1, "parseVersioner", "inga versioner efter tolkning");
			k.typ(v, "[0].version_id", "number");
			k.typ(v, "[0].publicerad", "nonEmptyString");
			k.typ(v, "[0].registrerare", "nonEmptyString");
			k.typ(v, "[0].aktivitet.typ", "nonEmptyString");
			k.typ(v, "[0].aktivitet.nummer", "nonEmptyString");
			k.klar();
		});
	}
});

// ------------------------------------------------------------------ dokument och bildfil

const dokumentAnrop = (nr: Testpost) => `GET lamning/dokument?lamning_id={uuid} (${nr})`;
const hamtaDokument = (nr: Testpost) =>
	en(async () => {
		const res = await hamta(KALLA, dokumentAnrop(nr), () => klient.get(`${FORNSOK_APP_API}/lamning/dokument?lamning_id=${TESTPOSTER[nr].uuid}`));
		return jsonSvar(KALLA, dokumentAnrop(nr), res) as Obj;
	});
const dokument: Partial<Record<Testpost, () => Promise<Obj>>> = {
	"L1946:7415": hamtaDokument("L1946:7415"),
	"L2000:8802": hamtaDokument("L2000:8802"),
};

describe("Fornsök-appen: dokument", () => {
	for (const nr of ["L1946:7415", "L2000:8802"] as const) {
		const anrop = dokumentAnrop(nr);

		it(`${nr}: dokumentlistans grupper och filuppgifterna koden läser`, async () => {
			const d = await (dokument[nr] as () => Promise<Obj>)();
			const k = new Kontroll(KALLA, anrop);
			k.lika(d, "lamningsnummer", nr);
			for (const g of ["inventeringsbocker", "handelseloggar", "bilder", "maritim_dokumentation"]) k.typ(d, g, "array");
			k.krav(arr(d.inventeringsbocker).length >= 1, "inventeringsbocker", "väntade minst ett inventeringsbokuppslag");
			for (const g of ["inventeringsbocker", "handelseloggar"] as const) {
				arr(d[g]).forEach((_, i) => {
					const p = `${g}[${i}]`;
					for (const f of ["titel", "lamningsinformationstyp", "skapad_datum", "uri", "fil.id", "fil.namn", "fil.typ", "fil.skapad_datum"]) k.typ(d, `${p}.${f}`, "nonEmptyString");
					k.typ(d, `${p}.fil.storlek`, "number");
					const uri = String(sokvag(d, `${p}.uri`));
					k.krav(/^https:\/\/pub\.raa\.se\/dokumentation\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uri), `${p}.uri`, `väntade https://pub.raa.se/dokumentation/{uuid}, fick ${JSON.stringify(uri)}`);
					k.krav(FIL_ID_RE.test(String(sokvag(d, `${p}.fil.id`))), `${p}.fil.id`, "väntade base64 (A-Za-z0-9+/=)");
				});
			}
			k.klar();
		});

		it(`${nr}: projektets tolkare (parseDokumentLista)`, async () => {
			const d = await (dokument[nr] as () => Promise<Obj>)();
			const lista = tolka(KALLA, anrop, "parseDokumentLista", () => parseDokumentLista(TESTPOSTER[nr].uuid, d));
			const k = new Kontroll(KALLA, anrop);
			k.lika(lista, "lamningsnummer", nr);
			const bok = lista.dokument.find((x) => x.grupp === "inventeringsbok");
			k.krav(!!bok, "dokument[inventeringsbok]", "ingen inventeringsbok efter tolkning");
			k.typ(bok, "titel", "nonEmptyString");
			k.typ(bok, "url", "nonEmptyString");
			k.typ(bok, "fil.id", "nonEmptyString");
			k.typ(bok, "fil.namn", "nonEmptyString");
			k.typ(bok, "fil.storlek_byte", "number");
			k.klar();
		});
	}

	it("lämning utan dokument: 404 med meddelande (eller 200 med tomma grupper)", async () => {
		const anrop = "GET lamning/dokument?lamning_id={uuid} (okänd lämning)";
		const res = await hamta(KALLA, anrop, () => klient.get(`${FORNSOK_APP_API}/lamning/dokument?lamning_id=00000000-0000-4000-8000-000000000000`), 404).catch(
			(e: unknown) => {
				// 200 är också godtagbart så länge grupperna är tomma (koden hanterar båda).
				if (e instanceof Error && /HTTP-status: väntade 404, fick 200/.test(e.message)) return null;
				throw e;
			},
		);
		const k = new Kontroll(KALLA, anrop);
		if (res) {
			const data = jsonSvar(KALLA, anrop, res);
			k.typ(data, "message", "nonEmptyString");
			k.lika(data, "status", 404);
		}
		k.klar();
	});

	it("bildfil: går att hämta (status, bildtyp och första byten; hela filen hämtas inte)", async () => {
		const anrop = "GET lamning/dokument/fil/{id}/{namn} (inventeringsbok L1946:7415, Range 0-63)";
		const d = await (dokument["L1946:7415"] as () => Promise<Obj>)();
		const lista = tolka(KALLA, anrop, "parseDokumentLista", () => parseDokumentLista(TESTPOSTER["L1946:7415"].uuid, d));
		const fil = lista.dokument.find((x) => x.fil && /\.(jpe?g|png)$/i.test(x.fil.namn))?.fil;
		const k = new Kontroll(KALLA, anrop);
		k.krav(!!fil, "dokument[].fil.namn", "ingen JPEG- eller PNG-fil bland dokumenten (servern hämtar bara bilder)");
		if (!fil) return k.klar();
		let r;
		try {
			r = await kalla.hamtaBild(fil, 64);
		} catch (e) {
			throw klassa(KALLA, anrop, e);
		}
		kontrolleraStatus(KALLA, anrop, r.status, [200, 206]);
		k.krav(/^image\/(jpeg|png)$/.test(r.mimeType), "content-type", `väntade image/jpeg eller image/png, fick ${JSON.stringify(r.mimeType)}`);
		if (r.bytes) {
			const jpeg = r.bytes[0] === 0xff && r.bytes[1] === 0xd8 && r.bytes[2] === 0xff;
			const png = r.bytes[0] === 0x89 && r.bytes[1] === 0x50 && r.bytes[2] === 0x4e && r.bytes[3] === 0x47;
			k.krav(jpeg || png, "innehåll", `de första byten är varken JPEG (FF D8 FF) eller PNG (89 50 4E 47): ${[...r.bytes.slice(0, 4)].map((b) => b.toString(16)).join(" ")}`);
		} else {
			// Servern struntade i Range och gav hela filen; klienten avbröt läsningen. Rubrikerna räcker.
			k.krav(r.tooLarge && (r.contentLength ?? 0) > 0, "content-length", "varken byten eller en filstorlek i rubrikerna");
		}
		k.klar();
	});
});

// ------------------------------------------------------------------ värdelistor

const ANROP_LD = "GET lamning/domaner";
const ANROP_UD = "GET uppdrag/domaner";
let lamningCache: Obj | null = null;
let uppdragCache: Obj | null = null;
const lamningDomanerCache = () => lamningCache as Obj;
const uppdragDomanerCache = () => uppdragCache as Obj;
const lamningDomaner = en(async () => {
	lamningCache = jsonSvar(KALLA, ANROP_LD, await hamta(KALLA, ANROP_LD, () => klient.get(`${FORNSOK_APP_API}/lamning/domaner`))) as Obj;
	return lamningCache;
});
const uppdragDomaner = en(async () => {
	uppdragCache = jsonSvar(KALLA, ANROP_UD, await hamta(KALLA, ANROP_UD, () => klient.get(`${FORNSOK_APP_API}/uppdrag/domaner`))) as Obj;
	return uppdragCache;
});

describe("Fornsök-appen: värdelistor", () => {
	it("lamning/domaner: lämningstyper, kategorier och bedömningar", async () => {
		const d = await lamningDomaner();
		const k = new Kontroll(KALLA, ANROP_LD);
		for (const [lista, min] of [
			["lamningstyp", 100],
			["kategorityp", 8],
			["antikvarisk_bedomning_typ", 4],
		] as const) {
			k.typ(d, lista, "array");
			k.krav(arr(d[lista]).length >= min, lista, `väntade minst ${min} poster (SPEC: 169 / 12 / 5), fick ${arr(d[lista]).length}`);
		}
		arr(d.lamningstyp).forEach((_, i) => {
			k.typ(d, `lamningstyp[${i}].lamningstyp_id`, "number");
			k.typ(d, `lamningstyp[${i}].namn`, "nonEmptyString");
			k.typ(d, `lamningstyp[${i}].aktiv`, "boolean");
			k.typ(d, `lamningstyp[${i}].kategorier`, "array");
		});
		arr(d.kategorityp).forEach((_, i) => k.typ(d, `kategorityp[${i}].namn`, "nonEmptyString"));
		arr(d.antikvarisk_bedomning_typ).forEach((_, i) => {
			k.typ(d, `antikvarisk_bedomning_typ[${i}].namn`, "nonEmptyString");
			k.typ(d, `antikvarisk_bedomning_typ[${i}].beskrivning`, "nullableString");
		});
		const namn = arr(d.antikvarisk_bedomning_typ).map((b) => b.namn);
		for (const b of BEDOMNINGAR) k.krav(namn.includes(b), "antikvarisk_bedomning_typ[].namn", `bedömningen ${JSON.stringify(b)} (som servern validerar mot) finns inte i värdelistan`);
		k.krav(arr(d.lamningstyp).some((t) => arr(t.kategorier).length > 0 && typeof arr(t.kategorier)[0].namn === "string"), "lamningstyp[].kategorier[].namn", "ingen lämningstyp har kategorier med namn");
		k.klar();
	});

	it("uppdrag/domaner: kommuner, socknar, landskap och län", async () => {
		const d = await uppdragDomaner();
		const k = new Kontroll(KALLA, ANROP_UD);
		for (const [lista, min] of [
			["kommun", 250],
			["socken", 2000],
			["landskap", 20],
			["lan", 20],
		] as const) {
			k.typ(d, lista, "array");
			k.krav(arr(d[lista]).length >= min, lista, `väntade minst ${min} poster (SPEC: 290 / 2 434 / 25 / 21), fick ${arr(d[lista]).length}`);
		}
		arr(d.kommun).forEach((_, i) => {
			for (const f of ["kommun_kod", "kommun_namn", "lan_kod", "lan_namn"]) k.typ(d, `kommun[${i}].${f}`, "nonEmptyString");
		});
		arr(d.socken).forEach((_, i) => {
			k.typ(d, `socken[${i}].socken_id`, "nonEmptyString");
			k.typ(d, `socken[${i}].socken_namn`, "nonEmptyString");
			k.typ(d, `socken[${i}].kommunkoder`, "array");
		});
		arr(d.landskap).forEach((_, i) => {
			k.typ(d, `landskap[${i}].landskap_kod`, "nonEmptyString");
			k.typ(d, `landskap[${i}].landskap_namn`, "nonEmptyString");
		});
		arr(d.lan).forEach((_, i) => {
			k.typ(d, `lan[${i}].lan_kod`, "nonEmptyString");
			k.typ(d, `lan[${i}].lan_namn`, "nonEmptyString");
		});
		k.klar();
	});

	it("projektets tolkare (parseDomaner) ger fyllda listor", async () => {
		const a = `${ANROP_LD} + ${ANROP_UD} → tolkning`;
		await lamningDomaner();
		await uppdragDomaner();
		const dom = tolka(KALLA, a, "parseDomaner", () => parseDomaner(lamningDomanerCache(), uppdragDomanerCache()));
		const k = new Kontroll(KALLA, a);
		for (const f of ["lamningstyper", "kategorier", "bedomningar", "kommuner", "socknar", "landskap", "lan"] as const) {
			k.krav(dom[f].length > 0, f, "tom lista efter tolkning");
		}
		k.krav(dom.lamningstyper.every((t) => t.namn.length > 0 && t.id > 0), "lamningstyper[]", "lamningstyp utan namn eller id efter tolkning");
		k.krav(dom.kommuner.every((t) => t.kod && t.namn && t.lan_kod && t.lan_namn), "kommuner[]", "kommun med tomt fält efter tolkning");
		k.krav(dom.socknar.every((t) => t.id && t.namn), "socknar[]", "socken med tomt fält efter tolkning");
		k.klar();
	});
});
