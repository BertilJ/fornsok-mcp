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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
		// Lägesosäkerheten ligger i en tabell vars namn börjar med områdets namn.
		const ost = [...tables].filter((t) => t.endsWith("_lägesosäkerhet"));
		this.osakerhetTabell = ost.length === 1 ? ost[0] : null;
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
		if (!ost) warn("lägesosäkerhetstabell saknas");

		let prev = "";
		for (const r of lam.iterate() as Iterable<Row>) {
			const uuidRaw = typeof r.uuid === "string" ? r.uuid : "";
			if (!UUID_RE.test(uuidRaw)) {
				warn("lämning med ogiltigt uuid");
				continue;
			}
			if (uuidRaw === prev) {
				warn("dubblerat uuid");
				continue;
			}
			prev = uuidRaw;
			const uuid = uuidRaw;

			const geometrier: KallGeometri[] = [];
			for (const g of geomGroups) {
				for (const row of g.take(uuid)) {
					if (!(row.g instanceof Uint8Array)) {
						warn("geometri saknas");
						continue;
					}
					try {
						const parsed = parseGpkgGeometry(row.g);
						if (parsed.srsId !== SWEREF_SRS) {
							warn("geometri med annat koordinatsystem");
							continue;
						}
						if (!parsed.geometry) {
							warn("tom geometri");
							continue;
						}
						geometrier.push({ nr: text(row.nr), geometry: parsed.geometry });
					} catch (e) {
						warn(e instanceof GpkgError ? `trasig geometri: ${e.message}` : "trasig geometri");
					}
				}
			}
			const egenskaper: KallEgenskap[] = [];
			for (const row of egenL.take(uuid)) {
				const typ = text(row.typ);
				const varde = text(row.varde);
				if (typ && varde) egenskaper.push({ ingaende_nr: null, typ, varde });
			}
			for (const row of egenI.take(uuid)) {
				const typ = text(row.typ);
				const varde = text(row.varde);
				const nr = Number(row.nr);
				if (typ && varde && Number.isSafeInteger(nr)) egenskaper.push({ ingaende_nr: nr, typ, varde });
			}
			const ingaende: KallIngaende[] = [];
			for (const row of ing.take(uuid)) {
				const nr = Number(row.nr);
				const typ = text(row.lamningstyp);
				const antal = typeof row.antal === "number" && Number.isFinite(row.antal) ? Math.trunc(row.antal) : null;
				if (typ && Number.isSafeInteger(nr)) ingaende.push({ nr, lamningstyp: typ, antal });
			}
			let osakerhet: number | null = null;
			if (ost) {
				const rows = ost.take(uuid);
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
	}
}

export function newStats(): ReadStats {
	return { lamningar: 0, geometrier: 0, egenskaper: 0, ingaende: 0, varningar: new Map(), foraldralosa: 0 };
}
