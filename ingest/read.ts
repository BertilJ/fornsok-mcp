/**
 * Läser en GeoPackage-fil från RAÄ (lamningar_v1) som data, utan att köra något
 * ur filen: bara SELECT mot kända tabeller, skrivskyddat. Posterna strömmas i
 * uuid-ordning; barntabellerna läses som sorterade strömmar och kopplas ihop
 * (sammanfogning), så att minnet inte växer med filens storlek.
 *
 * Tabeller (SPEC 4): lamning, egenskap, ingaendelamning, point, linestring,
 * polygon (EPSG:3006) och "<område>_lägesosäkerhet".
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { GpkgError, parseGpkgGeometry } from "./gpkg.ts";
import { type KallEgenskap, type KallGeometri, type KallIngaende, type KallPost, text } from "./transform.ts";

/** Källans uuid kan i princip ha versaler; de skrivs med gemener (som i övriga källor). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SWEREF_SRS = 3006;

type Row = Record<string, unknown>;

export interface ReadStats {
	lamningar: number;
	geometrier: number;
	egenskaper: number;
	ingaende: number;
	/** Rader som inte gick att använda, med orsak. */
	varningar: Map<string, number>;
	/** Barnrader utan motsvarande lämning (eller i fel ordning). */
	foraldralosa: number;
	/** Rader i källan (för avstämningen), satt när läsningen är klar. */
	kalla?: { lamningar: number; geometrier: number; egenskaper: number; ingaende: number };
	/** Rader som hoppades över med känd orsak (räknas också i varningar). */
	skippade: { lamningar: number; geometrier: number; egenskaper: number; ingaende: number };
	/** Föräldralösa per slag. */
	foraldralosaPer: { geometrier: number; egenskaper: number; ingaende: number };
}

/**
 * Avstämning efter läsningen: varje rad i källan ska vara skriven, överhoppad
 * med orsak eller föräldralös. Lämningar får inte tappas alls. Returnerar
 * avvikelserna (tom lista = allt stämmer).
 */
export function avstamning(st: ReadStats): string[] {
	const k = st.kalla;
	if (!k) return ["källans antal saknas (läsningen avbröts?)"];
	const out: string[] = [];
	if (st.lamningar !== k.lamningar)
		out.push(`lämningar: källan har ${k.lamningar}, skrivna ${st.lamningar} (överhoppade ${st.skippade.lamningar}; se varningarna)`);
	for (const slag of ["geometrier", "egenskaper", "ingaende"] as const) {
		const forklarat = st[slag] + st.skippade[slag] + st.foraldralosaPer[slag];
		if (forklarat !== k[slag])
			out.push(`${slag}: källan har ${k[slag]}, skrivna ${st[slag]}, överhoppade ${st.skippade[slag]}, föräldralösa ${st.foraldralosaPer[slag]} – ${k[slag] - forklarat} rader oförklarade`);
	}
	return out;
}

/** En sorterad ström av rader som grupperas på nyckeln `u`. */
class Group {
	private it: Iterator<Row>;
	private head: Row | null = null;
	private done = false;
	orphans = 0;
	constructor(stmt: StatementSync) {
		this.it = stmt.iterate() as Iterator<Row>;
		this.advance();
	}
	private advance() {
		const r = this.it.next();
		if (r.done) {
			this.done = true;
			this.head = null;
		} else this.head = r.value;
	}
	/** Alla rader med nyckeln `key`; rader med mindre nyckel räknas som föräldralösa. */
	take(key: string): Row[] {
		const out: Row[] = [];
		while (!this.done && this.head) {
			const u = String(this.head.u ?? "");
			if (u < key) {
				this.orphans++;
				this.advance();
			} else if (u === key) {
				out.push(this.head);
				this.advance();
			} else break;
		}
		return out;
	}
	/** Räkna kvarvarande rader som föräldralösa. */
	drain() {
		while (!this.done) {
			this.orphans++;
			this.advance();
		}
	}
}

function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

export class GpkgReader {
	readonly db: DatabaseSync;
	readonly osakerhetTabell: string | null;
	readonly uttagsdatum: string | null;

	constructor(path: string) {
		this.db = new DatabaseSync(path, { readOnly: true });
		const tables = new Set(
			(this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((r) => String(r.name)),
		);
		for (const t of ["lamning", "egenskap", "ingaendelamning", "point", "linestring", "polygon", "gpkg_geometry_columns"]) {
			if (!tables.has(t)) throw new Error(`GeoPackage-filen saknar tabellen ${t}`);
		}
		const geomCols = this.db
			.prepare("SELECT table_name, column_name, srs_id FROM gpkg_geometry_columns WHERE table_name IN ('point','linestring','polygon')")
			.all() as Row[];
		for (const t of ["point", "linestring", "polygon"]) {
			const c = geomCols.find((r) => r.table_name === t);
			if (!c) throw new Error(`gpkg_geometry_columns saknar ${t}`);
			if (c.column_name !== "geometri") throw new Error(`oväntad geometrikolumn ${String(c.column_name)} i ${t}`);
			if (Number(c.srs_id) !== SWEREF_SRS) throw new Error(`${t} har srs_id ${String(c.srs_id)}, väntade ${SWEREF_SRS}`);
		}
		// Lägesosäkerheten ligger i en tabell vars namn börjar med områdets namn
		// ("falun_lägesosäkerhet"). Kräv exakt en sådan tabell med rätt kolumner.
		const ost = [...tables].filter((t) => t.normalize("NFC").endsWith("_lägesosäkerhet"));
		if (ost.length !== 1) throw new Error(`väntade exakt en tabell "<område>_lägesosäkerhet", hittade ${ost.length}: ${ost.join(", ") || "ingen"}`);
		const cols = new Set((this.db.prepare(`PRAGMA table_info(${quoteIdent(ost[0])})`).all() as Row[]).map((r) => String(r.name)));
		for (const c of ["lamning_uuid", "lagesosakerhet_i_meter"])
			if (!cols.has(c)) throw new Error(`tabellen ${ost[0]} saknar kolumnen ${c}`);
		this.osakerhetTabell = ost[0];
		const u = this.db.prepare("SELECT max(uttagsdatum) AS d FROM lamning").get() as Row | undefined;
		this.uttagsdatum = text(u?.d);
	}

	count(): number {
		return Number((this.db.prepare("SELECT count(*) AS c FROM lamning").get() as Row).c);
	}

	close() {
		this.db.close();
	}

	/** Strömma alla lämningar i uuid-ordning. */
	*posts(stats?: ReadStats): Generator<KallPost> {
		const st: ReadStats = stats ?? newStats();
		const warn = (k: string) => st.varningar.set(k, (st.varningar.get(k) ?? 0) + 1);
		const q = (sql: string) => this.db.prepare(sql);
		const lam = q(
			`SELECT uuid, lamningsnummer, raa_nummer, lamningstyp, beskrivning, publicerad_av, publiceringsdatum, uttagsdatum,
			        antikvariskbedomning, antikvariskbedomning_motivering, aktualitetstatus, skadestatus, undersokningsstatus,
			        placering, terrang, orientering, tradition, lamningsnamn, lan, kommun, socken
			   FROM lamning ORDER BY uuid`,
		);
		const geomGroups = ["point", "linestring", "polygon"].map(
			(t) => new Group(q(`SELECT lamning_uuid AS u, geometrinummer AS nr, geometri AS g FROM ${t} ORDER BY lamning_uuid`)),
		);
		const egenL = new Group(
			q("SELECT lamning_uuid AS u, typ, varde FROM egenskap WHERE lamning_uuid IS NOT NULL ORDER BY lamning_uuid"),
		);
		const egenI = new Group(
			q(
				`SELECT i.lamning_uuid AS u, e.ingaendelamning_id AS nr, e.typ, e.varde
				   FROM ingaendelamning i JOIN egenskap e ON e.ingaendelamning_id = i.id
				  ORDER BY i.lamning_uuid`,
			),
		);
		const ing = new Group(q("SELECT lamning_uuid AS u, id AS nr, lamningstyp, antal FROM ingaendelamning ORDER BY lamning_uuid"));
		const ost = this.osakerhetTabell
			? new Group(
					q(`SELECT lamning_uuid AS u, lagesosakerhet_i_meter AS m FROM ${quoteIdent(this.osakerhetTabell)} ORDER BY lamning_uuid`),
				)
			: null;

		const one = (sql: string) => Number((this.db.prepare(sql).get() as Row).c);
		const kalla = {
			lamningar: one("SELECT count(*) AS c FROM lamning"),
			geometrier: ["point", "linestring", "polygon"].reduce((a, t) => a + one(`SELECT count(*) AS c FROM ${t}`), 0),
			egenskaper:
				one("SELECT count(*) AS c FROM egenskap WHERE lamning_uuid IS NOT NULL") +
				one("SELECT count(*) AS c FROM ingaendelamning i JOIN egenskap e ON e.ingaendelamning_id = i.id"),
			ingaende: one("SELECT count(*) AS c FROM ingaendelamning"),
		};

		let prev = "";
		for (const r of lam.iterate() as Iterable<Row>) {
			const uuidRaw = typeof r.uuid === "string" ? r.uuid : "";
			if (!UUID_RE.test(uuidRaw)) {
				warn("lämning med ogiltigt uuid");
				st.skippade.lamningar++;
				continue;
			}
			if (uuidRaw === prev) {
				warn("dubblerat uuid");
				st.skippade.lamningar++;
				continue;
			}
			prev = uuidRaw;
			// Barntabellerna kopplas på källans stavning (samma sortering); utdata får gemener.
			const key = uuidRaw;
			const uuid = uuidRaw.toLowerCase();

			const geometrier: KallGeometri[] = [];
			for (const g of geomGroups) {
				for (const row of g.take(key)) {
					if (!(row.g instanceof Uint8Array)) {
						warn("geometri saknas");
						st.skippade.geometrier++;
						continue;
					}
					try {
						const parsed = parseGpkgGeometry(row.g);
						if (parsed.srsId !== SWEREF_SRS) {
							warn("geometri med annat koordinatsystem");
							st.skippade.geometrier++;
							continue;
						}
						if (!parsed.geometry) {
							warn("tom geometri");
							st.skippade.geometrier++;
							continue;
						}
						geometrier.push({ nr: text(row.nr), geometry: parsed.geometry });
					} catch (e) {
						warn(e instanceof GpkgError ? `trasig geometri: ${e.message}` : "trasig geometri");
						st.skippade.geometrier++;
					}
				}
			}
			const egenskaper: KallEgenskap[] = [];
			for (const row of egenL.take(key)) {
				const typ = text(row.typ);
				const varde = text(row.varde);
				if (typ && varde) egenskaper.push({ ingaende_nr: null, typ, varde });
				else {
					warn("egenskap utan typ eller värde");
					st.skippade.egenskaper++;
				}
			}
			for (const row of egenI.take(key)) {
				const typ = text(row.typ);
				const varde = text(row.varde);
				const nr = Number(row.nr);
				if (typ && varde && Number.isSafeInteger(nr)) egenskaper.push({ ingaende_nr: nr, typ, varde });
				else {
					warn("egenskap på ingående lämning utan typ, värde eller id");
					st.skippade.egenskaper++;
				}
			}
			const ingaende: KallIngaende[] = [];
			for (const row of ing.take(key)) {
				const nr = Number(row.nr);
				const typ = text(row.lamningstyp);
				const antal = typeof row.antal === "number" && Number.isFinite(row.antal) ? Math.trunc(row.antal) : null;
				if (typ && Number.isSafeInteger(nr)) ingaende.push({ nr, lamningstyp: typ, antal });
				else {
					warn("ingående lämning utan typ eller id");
					st.skippade.ingaende++;
				}
			}
			let osakerhet: number | null = null;
			if (ost) {
				const rows = ost.take(key);
				const m = rows.map((x) => Number(x.m)).filter((x) => Number.isFinite(x));
				if (m.length) osakerhet = Math.round(Math.max(...m));
			}

			st.lamningar++;
			st.geometrier += geometrier.length;
			st.egenskaper += egenskaper.length;
			st.ingaende += ingaende.length;
			if (geometrier.length === 0) warn("lämning utan geometri");

			yield {
				uuid,
				lamningsnummer: text(r.lamningsnummer),
				raa_nummer: text(r.raa_nummer),
				lamningstyp: text(r.lamningstyp),
				beskrivning: text(r.beskrivning),
				publicerad_av: text(r.publicerad_av),
				publiceringsdatum: text(r.publiceringsdatum),
				uttagsdatum: text(r.uttagsdatum),
				bedomning: text(r.antikvariskbedomning),
				bedomning_motivering: text(r.antikvariskbedomning_motivering),
				aktualitet: text(r.aktualitetstatus),
				skada: text(r.skadestatus),
				undersokning: text(r.undersokningsstatus),
				placering: text(r.placering),
				terrang: text(r.terrang),
				orientering: text(r.orientering),
				tradition: text(r.tradition),
				namn: text(r.lamningsnamn),
				lan: text(r.lan),
				kommun: text(r.kommun),
				socken: text(r.socken),
				osakerhet_m: osakerhet,
				geometrier,
				egenskaper,
				ingaende,
			};
		}
		for (const g of [...geomGroups, egenL, egenI, ing, ...(ost ? [ost] : [])]) {
			g.drain();
			st.foraldralosa += g.orphans;
		}
		st.foraldralosaPer.geometrier += geomGroups.reduce((a, g) => a + g.orphans, 0);
		st.foraldralosaPer.egenskaper += egenL.orphans + egenI.orphans;
		st.foraldralosaPer.ingaende += ing.orphans;
		st.kalla = kalla;
	}
}

export function newStats(): ReadStats {
	return {
		lamningar: 0,
		geometrier: 0,
		egenskaper: 0,
		ingaende: 0,
		varningar: new Map(),
		foraldralosa: 0,
		skippade: { lamningar: 0, geometrier: 0, egenskaper: 0, ingaende: 0 },
		foraldralosaPer: { geometrier: 0, egenskaper: 0, ingaende: 0 },
	};
}
