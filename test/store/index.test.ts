/**
 * Frågemodulen (src/store) mot Falu kommun laddad i lokal SQLite via
 * migreringen, genom en adapter med D1-bindningens yta.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nearestPoint, wgsToSweref, type Geometry } from "../../src/geo/geometry";
import { toPlanar } from "../../src/geo/sweref";
import { IndexInputError, IndexStore } from "../../src/store";
import { d1FromSqlite } from "./d1-adapter";
import { HAS_FALUN, type LoadedFalun, loadFalun, SKIP_MESSAGE } from "./falun-fixture";

/** Stora stöten, Falu gruva. */
const FALU_GRUVA = { lat: 60.6036, lon: 15.6302 };

describe.skipIf(!HAS_FALUN)(`IndexStore mot Falu kommun ${HAS_FALUN ? "" : `(${SKIP_MESSAGE})`}`, () => {
	let f: LoadedFalun;
	let db: DatabaseSync;
	let store: IndexStore;
	const queries: Array<{ sql: string; params: unknown[] }> = [];

	beforeAll(() => {
		f = loadFalun();
		db = f.open();
		store = new IndexStore(d1FromSqlite(db, (sql, params) => queries.push({ sql, params })));
	});
	afterAll(() => {
		db?.close();
		f?.cleanup();
	});

	it("antal och byggdatum", async () => {
		expect(await store.antal()).toBe(3908);
		expect(await store.byggdatum()).toBe("2026-11-17");
	});

	// ------------------------------------------------------------ fulltext

	it("önskekälla hittar L2001:646 med utdrag runt träffen", async () => {
		const r = await store.searchIndex({ fraga: "önskekälla" });
		expect(r.totalt).toBe(1);
		expect(r.sokord).toEqual(["önskekälla"]);
		const h = r.traffar[0];
		expect(h).toMatchObject({
			lamningsnummer: "L2001:646",
			raa_nummer: "Bjursås 27:1",
			lamningstyp: "Källa med tradition",
			antikvarisk_bedomning: "Övrig kulturhistorisk lämning",
			kommun: ["Falun"],
			socken: ["Bjursås"],
			lan: ["Dalarna"],
			landskap: ["Dalarna"],
			url: "https://pub.raa.se/visa/objekt/lamning/adc490ba-871a-45bd-8e3d-0a27761b3b6c",
			geometrityp: "Point",
		});
		expect(h.utdrag).toContain("«önskekälla»");
		expect(h.koordinat?.lat).toBeCloseTo(60.73368161435678, 6);
		expect(h.koordinat?.lon).toBeCloseTo(15.456428761252013, 6);
	});

	it("hytta, prefix hytt* och rangordning", async () => {
		const hytta = await store.searchIndex({ fraga: "hytta" }, { antal: 50 });
		const prefix = await store.searchIndex({ fraga: "hytt*" }, { antal: 50 });
		expect(hytta.totalt).toBe(37);
		expect(prefix.totalt).toBeGreaterThan(hytta.totalt);
		expect(prefix.sokord).toEqual(["hytt*"]);
		// Typen väger tyngst: hyttområden först vid prefixsök.
		expect(prefix.traffar[0].lamningstyp).toBe("Hyttområde");
		for (const h of hytta.traffar) expect(h.utdrag).toMatch(/«[Hh]ytta»/);
		// Utan stamning: "kalla" (utan ä) ger inget, "källa" något.
		expect((await store.searchIndex({ fraga: "kalla" })).totalt).toBe(0);
		expect((await store.searchIndex({ fraga: "källa" })).totalt).toBeGreaterThan(0);
	});

	it("flera ord OCH-kopplas; ord ur ordlistan räknas", async () => {
		const a = await store.searchIndex({ fraga: "hytta slagg" });
		const b = await store.searchIndex({ ord: ["hytta", "slagg"] });
		expect(a.totalt).toBe(b.totalt);
		expect(a.totalt).toBeLessThan((await store.searchIndex({ fraga: "hytta" })).totalt);
	});

	it("sidor och antal", async () => {
		const p1 = await store.searchIndex({ fraga: "hytt*" }, { antal: 5, sida: 1 });
		const p2 = await store.searchIndex({ fraga: "hytt*" }, { antal: 5, sida: 2 });
		expect(p1.traffar).toHaveLength(5);
		expect(p2.traffar).toHaveLength(5);
		expect(new Set([...p1.traffar, ...p2.traffar].map((h) => h.uuid)).size).toBe(10);
	});

	// ------------------------------------------------------------ filter

	it("filter: typ, bedömning, kategori, socken, kommun, landskap, län", async () => {
		const typ = await store.searchIndex({ lamningstyp: ["Hyttområde"] });
		expect(typ.totalt).toBe(Number((db.prepare("SELECT count(*) AS c FROM lamning WHERE lamningstyp = 'Hyttområde'").get() as { c: number }).c));
		const fl = await store.searchIndex({ fraga: "hytt*", antikvarisk_bedomning: ["Fornlämning"] }, { antal: 50 });
		expect(fl.totalt).toBeGreaterThan(0);
		for (const h of fl.traffar) expect(h.antikvarisk_bedomning).toBe("Fornlämning");
		const kult = await store.searchIndex({ kategori: ["Kult, offer och folktro"] }, { antal: 100 });
		expect(kult.totalt).toBe(197);
		expect(kult.traffar.some((h) => h.lamningstyp === "Källa med tradition")).toBe(true);
		const bjursas = await store.searchIndex({ socken: [{ namn: "Bjursås" }] });
		expect(bjursas.totalt).toBe(352);
		const bjursasLan = await store.searchIndex({ socken: [{ namn: "Bjursås", lan: ["Dalarna"] }] });
		expect(bjursasLan.totalt).toBe(352);
		expect((await store.searchIndex({ kommun: ["Leksand"] })).totalt).toBe(31);
		expect((await store.searchIndex({ kommun: ["Falun"] })).totalt).toBe(3908);
		expect((await store.searchIndex({ landskap: ["Gästrikland"] })).totalt).toBe(2);
		expect((await store.searchIndex({ lan: ["Gävleborg"] })).totalt).toBe(2);
		expect((await store.searchIndex({ kommun: ["Okänd"] })).totalt).toBe(0);
		const combo = await store.searchIndex({ fraga: "källa", socken: [{ namn: "Bjursås" }], lamningstyp: ["Källa med tradition"] });
		expect(combo.traffar.map((h) => h.lamningsnummer)).toContain("L2001:646");
	});

	it("egenskapsfilter: samma typ ELLER, olika typer OCH; även ingående lämningar", async () => {
		const mid = await store.searchIndex({ egenskap: [{ typ: "Typ", varde: "Midsommar/trefaldighet" }] }, { antal: 100 });
		expect(mid.traffar.map((h) => h.lamningsnummer)).toContain("L2001:646");
		const either = await store.searchIndex({
			egenskap: [
				{ typ: "Typ", varde: "Midsommar/trefaldighet" },
				{ typ: "Typ", varde: "Gruvhål" },
			],
		});
		expect(either.totalt).toBeGreaterThan(mid.totalt);
		const both = await store.searchIndex({
			egenskap: [
				{ typ: "Typ", varde: "Gruvhål" },
				{ typ: "Form", varde: "Rund" },
			],
		});
		expect(both.totalt).toBeLessThan(either.totalt);
		// Koppar finns som egenskap på ingående slagg i hyttområden.
		const koppar = await store.searchIndex({ egenskap: [{ typ: "Material", varde: "Koppar" }], lamningstyp: ["Hyttområde"] });
		expect(koppar.totalt).toBeGreaterThan(0);
		const list = await store.egenskaper("Material");
		expect(list.find((e) => e.varde === "Koppar")?.antal).toBeGreaterThan(0);
	});

	it("nummersökning och uppslag: lämningsnummer, RAÄ-nummer, UUID, K-samsök-URI", async () => {
		const r = await store.searchIndex({ nummer: ["l2001:646", "stora kopparberg 172:1"] });
		expect(r.traffar.map((h) => h.lamningsnummer).sort()).toEqual(["L2000:8802", "L2001:646"]);
		const m = await store.resolveIds([
			"L2001:646",
			"Stora  Kopparberg 172:1",
			"6D1CF7B6-F5BD-4066-ABA6-FB1EA3CE8C75",
			"http://kulturarvsdata.se/raa/lamning/adc490ba-871a-45bd-8e3d-0a27761b3b6c",
			"https://pub.raa.se/visa/objekt/lamning/6d1cf7b6-f5bd-4066-aba6-fb1ea3ce8c75",
			"L9999:1",
			"00000000-0000-4000-8000-000000000000",
		]);
		expect(Object.fromEntries(m)).toEqual({
			"L2001:646": "adc490ba-871a-45bd-8e3d-0a27761b3b6c",
			"Stora  Kopparberg 172:1": "6d1cf7b6-f5bd-4066-aba6-fb1ea3ce8c75",
			"6D1CF7B6-F5BD-4066-ABA6-FB1EA3CE8C75": "6d1cf7b6-f5bd-4066-aba6-fb1ea3ce8c75",
			"http://kulturarvsdata.se/raa/lamning/adc490ba-871a-45bd-8e3d-0a27761b3b6c": "adc490ba-871a-45bd-8e3d-0a27761b3b6c",
			"https://pub.raa.se/visa/objekt/lamning/6d1cf7b6-f5bd-4066-aba6-fb1ea3ce8c75": "6d1cf7b6-f5bd-4066-aba6-fb1ea3ce8c75",
		});
		expect(await store.resolveNumbers(["Bjursås 27:1"])).toEqual(new Map([["Bjursås 27:1", "adc490ba-871a-45bd-8e3d-0a27761b3b6c"]]));
	});

	// ------------------------------------------------------------ grundpost

	it("grundpost för L2000:8802 och L2001:646", async () => {
		const m = await store.getByUuids(["6d1cf7b6-f5bd-4066-aba6-fb1ea3ce8c75", "adc490ba-871a-45bd-8e3d-0a27761b3b6c"]);
		const hytt = m.get("6d1cf7b6-f5bd-4066-aba6-fb1ea3ce8c75");
		expect(hytt?.post).toMatchObject({
			lamningsnummer: "L2000:8802",
			raa_nummer: "Stora Kopparberg 172:1",
			lamningstyp: "Hyttområde",
			kategori: ["Metallframställning och bergsbruk"],
			antikvarisk_bedomning: { varde: "Fornlämning", motivering: null },
			statusar: { aktualitet: "Bekräftad i fält", undersokning: "Delundersökt", skada: "Åverkan", placering: "Synlig ovan mark" },
			indelning: { lan: ["Dalarna"], kommun: ["Falun"], socken: ["Stora Kopparberg"], landskap: ["Dalarna"] },
			url: "https://pub.raa.se/visa/objekt/lamning/6d1cf7b6-f5bd-4066-aba6-fb1ea3ce8c75",
			kalla: "Riksantikvarieämbetet, Kulturmiljöregistret (CC0)",
			hamtad_fran: "index 2026-11-17",
		});
		expect(hytt?.post.lage.geometrityp).toBe("GeometryCollection");
		expect(hytt?.geometriWgs?.type).toBe("GeometryCollection");
		expect(hytt?.post.ingaende_lamningar.length).toBeGreaterThan(0);
		expect(hytt?.post.ingaende_lamningar.some((i) => i.egenskaper.length > 0)).toBe(true);

		const kalla = (await store.getByUuid("adc490ba-871a-45bd-8e3d-0a27761b3b6c"))?.post;
		expect(kalla).toMatchObject({
			lamningsnummer: "L2001:646",
			raa_nummer: "Bjursås 27:1",
			lamningstyp: "Källa med tradition",
			tradition: "Fru Lax Greta Holm har använt källan som önskekälla.",
			terrang: "Måttlig NÖ-sluttning. Moränmark. Skogsmark (blandskog).",
			orientering: "Omedelbart Ö om stig (N-S) och 28 m 30 gon om N hörnet av uthus.",
			egenskaper: [{ typ: "Typ", varde: "Midsommar/trefaldighet" }],
			indelning: { lan: ["Dalarna"], kommun: ["Falun"], socken: ["Bjursås"], landskap: ["Dalarna"] },
		});
		expect(kalla?.lage.lat).toBeCloseTo(60.73368161435678, 6);
		expect(kalla?.lage.lon).toBeCloseTo(15.456428761252013, 6);
		expect(kalla?.lage.osakerhet_m).toBe(15);
		expect(kalla?.lage.sweref99tm).toEqual({ e: 524892.6, n: 6733210.7 });
		expect(await store.getByUuid("00000000-0000-4000-8000-000000000000")).toBeNull();
		expect(await store.getByUuid("inte-ett-uuid")).toBeNull();
	});

	// ------------------------------------------------------------ närhet

	it("närhetssök runt Falu gruva: exakt avstånd, närmast först, inget missas", async () => {
		const r = await store.nearby({ ...FALU_GRUVA, radie_m: 1000, antal: 100 });
		expect(r.totalt).toBeGreaterThan(5);
		// Stora stöten ligger inom stadslagret (yta): avstånd 0. Hytt- och gruvområden ligger inom några hundra meter.
		expect(r.traffar[0]).toMatchObject({ lamningsnummer: "L2001:4288", lamningstyp: "Stadslager", avstand_m: 0 });
		expect(r.traffar.filter((h) => /^(Gruvområde|Hyttområde)$/.test(h.lamningstyp ?? "") && h.avstand_m < 600).length).toBeGreaterThanOrEqual(3);
		for (let i = 1; i < r.traffar.length; i++) expect(r.traffar[i].avstand_m).toBeGreaterThanOrEqual(r.traffar[i - 1].avstand_m);
		for (const h of r.traffar) expect(h.avstand_m).toBeLessThanOrEqual(1000);

		// Kontroll mot uttömmande beräkning över alla lämningar.
		const p = toPlanar(FALU_GRUVA);
		const all = db.prepare("SELECT uuid, geometri FROM lamning").all() as Array<{ uuid: string; geometri: string }>;
		const expected = all
			.map((x) => ({ uuid: x.uuid, d: nearestPoint(p, wgsToSweref(JSON.parse(x.geometri) as Geometry)).distance }))
			.filter((x) => x.d <= 1000);
		expect(r.totalt).toBe(expected.length);
		expect(new Set(r.traffar.map((h) => h.uuid))).toEqual(new Set(expected.sort((a, b) => a.d - b.d).slice(0, 100).map((x) => x.uuid)));
	});

	it("närhetssök med filter och ruta; väderstreck", async () => {
		const r = await store.nearby({ ...FALU_GRUVA, radie_m: 3000, lamningstyp: ["Gruvområde"], antal: 10 });
		for (const h of r.traffar) expect(h.lamningstyp).toBe("Gruvområde");
		expect(r.traffar.some((h) => h.vaderstreck && /^(N|NO|O|SO|S|SV|V|NV)$/.test(h.vaderstreck))).toBe(true);
		const b = await store.nearby({ bbox: [15.62, 60.6, 15.64, 60.61], antal: 100 });
		expect(b.totalt).toBeGreaterThan(0);
		const page = await store.featuresInBbox({ bbox: [15.62, 60.6, 15.64, 60.61], limit: 20 });
		expect(page.features.length).toBeGreaterThan(0);
		expect(page.numberMatched).toBeGreaterThanOrEqual(page.features.length);
		expect(page.features[0].url).toMatch(/^https:\/\/pub\.raa\.se\/visa\/objekt\/lamning\//);
	});

	it("fulltext med nära: avstånd och filtrering på radien", async () => {
		const r = await store.searchIndex({ fraga: "gruv*", nara: { ...FALU_GRUVA, radie_m: 2000 } }, { antal: 50 });
		expect(r.totalt).toBeGreaterThan(0);
		for (const h of r.traffar) {
			expect(h.avstand_m).toBeLessThanOrEqual(2000);
			expect(h.utdrag).toBeTruthy();
		}
		// Träff i beskrivningen ger utdrag runt träffen.
		expect(r.traffar.some((h) => /«[Gg]ruv/.test(h.utdrag ?? ""))).toBe(true);
		const utanOrd = await store.searchIndex({ nara: { ...FALU_GRUVA, radie_m: 500 } }, { antal: 50 });
		for (let i = 1; i < utanOrd.traffar.length; i++)
			expect(utanOrd.traffar[i].avstand_m ?? 0).toBeGreaterThanOrEqual(utanOrd.traffar[i - 1].avstand_m ?? 0);
	});

	it("koordinater utanför Sverige avvisas", async () => {
		await expect(store.nearby({ lat: 48.85, lon: 2.35 })).rejects.toBeInstanceOf(IndexInputError);
		await expect(store.searchIndex({ nara: { lat: 0, lon: 0, radie_m: 100 } })).rejects.toBeInstanceOf(IndexInputError);
		await expect(store.nearby({ bbox: [2, 48, 3, 49] })).rejects.toBeInstanceOf(IndexInputError);
	});

	// ------------------------------------------------------------ statistik

	it("statistik per typ", async () => {
		const s = await store.statistik(["typ"]);
		expect(s.totalt).toBe(3908);
		expect(s.grupper[0]).toEqual({ varden: ["Bytomt/gårdstomt"], antal: 681 });
		expect(s.grupper.reduce((a, g) => a + g.antal, 0)).toBe(3908);
		expect(s.avkortad).toBe(false);
	});

	it("statistik i två nivåer, med filter, och högst 200 rader", async () => {
		const s = await store.statistik(["socken", "bedomning"], { lamningstyp: ["Hyttområde"] });
		expect(s.totalt).toBe(Number((db.prepare("SELECT count(*) AS c FROM lamning WHERE lamningstyp = 'Hyttområde'").get() as { c: number }).c));
		expect(s.grupper.every((g) => g.varden.length === 2)).toBe(true);
		const k = await store.statistik(["kategori"]);
		expect(k.grupper.find((g) => g.varden[0] === "Kult, offer och folktro")?.antal).toBe(197);
		const l = await store.statistik(["landskap"]);
		expect(l.grupper.map((g) => g.varden[0])).toEqual(["Dalarna", "Gästrikland", "Hälsingland"]);
		const many = await store.statistik(["socken", "typ"]);
		expect(many.grupper.length).toBe(200);
		expect(many.avkortad).toBe(true);
		const fts = await store.statistik(["bedomning"], { fraga: "hytt*" });
		expect(fts.totalt).toBe((await store.searchIndex({ fraga: "hytt*" })).totalt);
		await expect(store.statistik([])).rejects.toBeInstanceOf(IndexInputError);
		await expect(store.statistik(["typ", "typ"])).rejects.toBeInstanceOf(IndexInputError);
		await expect(store.statistik(["x" as never])).rejects.toBeInstanceOf(IndexInputError);
	});

	// ------------------------------------------------------------ säkerhet

	it("elaka söksträngar ger varken SQL- eller FTS-fel", async () => {
		const evil = [
			'"',
			"'",
			"'; DROP TABLE lamning; --",
			'" OR 1=1 --',
			"*",
			"**",
			"hytt**",
			"NEAR",
			"NEAR(hytta slagg, 2)",
			"OR",
			"hytta OR slagg",
			"AND NOT",
			":",
			"beskrivning:hytta",
			"lamning_fts:*",
			"{beskrivning}: hytta",
			"^hytta",
			"(",
			")",
			"\\",
			"%_",
			"\u0000",
			"x".repeat(300),
			"🙂",
		];
		// Lång fritext kortas av; långa filtervärden ger ett tydligt fel.
		await expect(store.searchIndex({ fraga: "x".repeat(5000) })).resolves.toMatchObject({ totalt: 0 });
		await expect(store.searchIndex({ kommun: ["x".repeat(5000)] })).rejects.toBeInstanceOf(IndexInputError);
		for (const s of evil) {
			const r = await store.searchIndex({ fraga: s, kommun: [s], socken: [{ namn: s, lan: [s] }], nummer: [s] });
			expect(r.totalt).toBe(0);
			await expect(store.searchIndex({ fraga: s })).resolves.toBeTruthy();
			await expect(store.statistik(["typ"], { fraga: s, egenskap: [{ typ: s, varde: s }] })).resolves.toBeTruthy();
			await expect(store.resolveIds([s])).resolves.toBeInstanceOf(Map);
		}
		expect(await store.antal()).toBe(3908);
	});

	it("alla frågor är parametriserade: inga indatavärden i SQL-texten", () => {
		const marker = "hyttZQX";
		queries.length = 0;
		return store
			.searchIndex({ fraga: marker, kommun: [marker], socken: [{ namn: marker }], egenskap: [{ typ: marker, varde: marker }], nummer: [marker] })
			.then(() => {
				expect(queries.length).toBeGreaterThan(0);
				for (const q of queries) expect(q.sql.toLowerCase()).not.toContain(marker.toLowerCase());
				for (const q of queries) expect(q.params.length).toBeLessThanOrEqual(100);
			});
	});

	it("ogiltiga indata ger tydliga fel", async () => {
		await expect(store.searchIndex({ kommun: Array.from({ length: 51 }, (_, i) => `k${i}`) })).rejects.toBeInstanceOf(IndexInputError);
		await expect(store.searchIndex({ nara: { ...FALU_GRUVA, radie_m: 0 } })).rejects.toBeInstanceOf(IndexInputError);
		await expect(store.searchIndex({ nara: { ...FALU_GRUVA, radie_m: 1e9 } })).rejects.toBeInstanceOf(IndexInputError);
	});
});
