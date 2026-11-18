/**
 * Kontrakt: RAÄ:s GeoPackage-uttag (`pub.raa.se/nedladdning/datauttag/lamningar_v1/`),
 * grunden för indexet (SPEC 4, 5.3).
 *
 * - Sverige-filen finns, har rimlig storlek och är nygenererad (HEAD, inget innehåll hämtas).
 * - En LITEN kommunfil (några hundra kB) laddas ned till en tillfällig katalog och
 *   prövas mot det `ingest/` läser: tabeller, kolumner, geometrikolumner och
 *   avstämningen i ingest/read.ts. Filen behandlas som opålitliga data: den öppnas
 *   skrivskyddat av ingest/read.ts, som bara kör SELECT, och inget i den körs.
 *
 * Filnedladdningen står inte på listan över tillåtna anrop (den listan gäller
 * serverns egna anrop i drift), så här används kön, pausen och User-Agent från
 * ./stod direkt. Totalt tre anrop.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, it } from "vitest";
import { USER_AGENT } from "../../src/config";
import { avstamning, GpkgReader, newStats } from "../../ingest/read.ts";
import { artigFetch, en, formatFel, klassa, Kontroll, KontraktFel, kontrolleraStatus, otillganglig } from "./stod";

const KALLA = "raa_datauttag" as const;
const BAS = "https://pub.raa.se/nedladdning/datauttag/lamningar_v1";
const SVERIGE = `${BAS}/l%c3%a4mningar_sverige.gpkg`;
/** En av de minsta kommunfilerna (cirka 0,8 MB, nov 2026). Byts mot en annan liten om filen försvinner. */
const KOMMUN = `${BAS}/kommun/l%c3%a4mningar_kommun_danderyd.gpkg`;
const KOMMUN_MAX_BYTE = 16 * 1024 * 1024;

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Tabeller och kolumner som ingest/read.ts läser (SELECT-satserna där). */
const KOLUMNER: Record<string, string[]> = {
	lamning: [
		"uuid", "lamningsnummer", "raa_nummer", "lamningstyp", "beskrivning", "publicerad_av", "publiceringsdatum", "uttagsdatum",
		"antikvariskbedomning", "antikvariskbedomning_motivering", "aktualitetstatus", "skadestatus", "undersokningsstatus",
		"placering", "terrang", "orientering", "tradition", "lamningsnamn", "lan", "kommun", "socken",
	],
	point: ["lamning_uuid", "geometrinummer", "geometri"],
	linestring: ["lamning_uuid", "geometrinummer", "geometri"],
	polygon: ["lamning_uuid", "geometrinummer", "geometri"],
	egenskap: ["lamning_uuid", "ingaendelamning_id", "typ", "varde"],
	ingaendelamning: ["id", "lamning_uuid", "lamningstyp", "antal"],
	gpkg_geometry_columns: ["table_name", "column_name", "srs_id"],
};

describe("GeoPackage: Sverige-filen", () => {
	it("finns (HEAD), har rimlig storlek och är nygenererad", async () => {
		const anrop = "HEAD lamningar_v1/lämningar_sverige.gpkg";
		let res: Response;
		try {
			res = await artigFetch(SVERIGE, { method: "HEAD", headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
		} catch (e) {
			throw klassa(KALLA, anrop, e);
		}
		kontrolleraStatus(KALLA, anrop, res.status, 200);
		const k = new Kontroll(KALLA, anrop);
		const storlek = Number(res.headers.get("content-length"));
		k.krav(Number.isFinite(storlek) && storlek > 1 * GB && storlek < 6 * GB, "content-length", `väntade 1–6 GB (SPEC: cirka 2,3 GB), fick ${res.headers.get("content-length") ?? "saknas"}`);
		const modifierad = Date.parse(res.headers.get("last-modified") ?? "");
		k.krav(Number.isFinite(modifierad), "last-modified", "rubriken saknas eller går inte att tolka");
		if (Number.isFinite(modifierad)) {
			const dagar = (Date.now() - modifierad) / 86_400_000;
			k.krav(dagar < 4, "last-modified", `filen är ${dagar.toFixed(1)} dygn gammal; RAÄ ska nygenerera den varje natt`);
		}
		k.klar();
	});
});

// ------------------------------------------------------------------ liten kommunfil

const tmp = mkdtempSync(join(tmpdir(), "fornsok-kontrakt-gpkg-"));
const arbetskatalog = join(tmp, "ned");
mkdirSync(arbetskatalog);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Ladda ned kommunfilen (högst 16 MB) till den tillfälliga katalogen och returnera sökvägen. */
const kommunfil = en(async () => {
	const anrop = "GET lamningar_v1/kommun/lämningar_kommun_danderyd.gpkg";
	let res: Response;
	try {
		res = await artigFetch(KOMMUN, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(60_000) });
	} catch (e) {
		throw klassa(KALLA, anrop, e);
	}
	kontrolleraStatus(KALLA, anrop, res.status, 200);
	const len = Number(res.headers.get("content-length"));
	if (Number.isFinite(len) && len > KOMMUN_MAX_BYTE) {
		await res.body?.cancel();
		throw formatFel(KALLA, anrop, "content-length", `kommunfilen är ${len} byte, över taket ${KOMMUN_MAX_BYTE}; välj en mindre kommun i geopackage.kontrakt.ts`);
	}
	const delar: Uint8Array[] = [];
	let total = 0;
	try {
		const reader = res.body?.getReader();
		for (;;) {
			const r = await reader?.read();
			if (!r || r.done) break;
			total += r.value.byteLength;
			if (total > KOMMUN_MAX_BYTE) {
				await reader?.cancel();
				throw formatFel(KALLA, anrop, "innehåll", `kommunfilen överskrider ${KOMMUN_MAX_BYTE} byte; nedladdningen avbröts`);
			}
			delar.push(r.value);
		}
	} catch (e) {
		throw e instanceof KontraktFel ? e : otillganglig(KALLA, anrop, e instanceof Error ? e.message : String(e));
	}
	const sokvag = join(arbetskatalog, "kommun.gpkg");
	writeFileSync(sokvag, Buffer.concat(delar));
	return sokvag;
});

const ANROP_FIL = "kommunfil (SQLite/GeoPackage)";

describe("GeoPackage: liten kommunfil (Danderyd)", () => {
	it("är en SQLite-fil med GeoPackage-huvud", async () => {
		const sokvag = await kommunfil();
		const huvud = readFileSync(sokvag).subarray(0, 100);
		const k = new Kontroll(KALLA, ANROP_FIL);
		k.krav(huvud.subarray(0, 15).toString("latin1") === "SQLite format 3", "filhuvud", "filen börjar inte med \"SQLite format 3\" (HTML-felsida eller annat format?)");
		// application_id 'GPKG' (0x47504B47) står på byte 68–71.
		k.krav(huvud.readUInt32BE(68) === 0x47504b47 || huvud.readUInt32BE(68) === 0x47503130, "application_id", `väntade GPKG, fick 0x${huvud.readUInt32BE(68).toString(16)}`);
		k.klar();
	});

	it("har de tabeller och kolumner som ingest/ läser", async () => {
		const sokvag = await kommunfil();
		const db = new DatabaseSync(sokvag, { readOnly: true });
		try {
			const k = new Kontroll(KALLA, ANROP_FIL);
			const tabeller = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
			for (const [tabell, kolumner] of Object.entries(KOLUMNER)) {
				if (!tabeller.has(tabell)) {
					k.krav(false, tabell, "tabellen saknas");
					continue;
				}
				const finns = new Set((db.prepare(`PRAGMA table_info("${tabell}")`).all() as Array<{ name: string }>).map((r) => r.name));
				for (const kolumn of kolumner) k.krav(finns.has(kolumn), `${tabell}.${kolumn}`, "kolumnen saknas");
			}
			const ost = [...tabeller].filter((t) => t.normalize("NFC").endsWith("_lägesosäkerhet"));
			k.krav(ost.length === 1, "<område>_lägesosäkerhet", `väntade exakt en sådan tabell, hittade ${ost.length}: ${ost.join(", ") || "ingen"}`);
			if (ost.length === 1) {
				const kol = new Set((db.prepare(`PRAGMA table_info("${ost[0].replace(/"/g, '""')}")`).all() as Array<{ name: string }>).map((r) => r.name));
				for (const c of ["lamning_uuid", "lagesosakerhet_i_meter"]) k.krav(kol.has(c), `${ost[0]}.${c}`, "kolumnen saknas");
			}
			k.klar();
		} finally {
			db.close();
		}
	});

	it("läses av projektets egen läsare (GpkgReader): geometrikolumner, SWEREF 99 TM, avstämning", async () => {
		const sokvag = await kommunfil();
		const k = new Kontroll(KALLA, ANROP_FIL);
		let reader: GpkgReader;
		try {
			reader = new GpkgReader(sokvag);
		} catch (e) {
			throw formatFel(KALLA, ANROP_FIL, "GpkgReader", e instanceof Error ? e.message : String(e));
		}
		try {
			const stats = newStats();
			const poster = [...reader.posts(stats)];
			k.krav(poster.length >= 10, "lamning", `väntade minst 10 lämningar i en kommunfil, fick ${poster.length}`);
			const avvikelser = avstamning(stats);
			k.krav(avvikelser.length === 0, "avstämning", avvikelser.join("; "));
			const utanGeometri = poster.filter((p) => p.geometrier.length === 0).length;
			k.krav(utanGeometri <= poster.length * 0.02, "point/linestring/polygon", `${utanGeometri} av ${poster.length} lämningar saknar geometri efter läsning (geometriblobbarna går inte att tolka?)`);
			const skippade = stats.skippade.geometrier;
			k.krav(skippade <= Math.max(2, stats.geometrier * 0.02), "geometri", `${skippade} geometrier hoppades över vid läsning: ${[...stats.varningar].map(([v, n]) => `${v} (${n})`).join(", ")}`);
			k.krav(poster.every((p) => /^[0-9a-f]{8}-/.test(p.uuid)), "lamning.uuid", "uuid har ändrat form");
			const medNummer = poster.filter((p) => /^L\d{4}:\d+$/.test(p.lamningsnummer ?? "")).length;
			k.krav(medNummer >= poster.length * 0.98, "lamning.lamningsnummer", `bara ${medNummer} av ${poster.length} har lämningsnummer på formen L####:#`);
			const medTyp = poster.filter((p) => !!p.lamningstyp && !!p.bedomning && !!p.kommun).length;
			k.krav(medTyp >= poster.length * 0.98, "lamning.lamningstyp/antikvariskbedomning/kommun", `bara ${medTyp} av ${poster.length} har typ, bedömning och kommun`);
			k.krav(!!reader.uttagsdatum && Date.now() - Date.parse(reader.uttagsdatum) < 4 * 86_400_000, "lamning.uttagsdatum", `uttagsdatum ${JSON.stringify(reader.uttagsdatum)} är inte från de senaste dygnen`);
			k.klar();
		} finally {
			reader.close();
		}
	});
});
