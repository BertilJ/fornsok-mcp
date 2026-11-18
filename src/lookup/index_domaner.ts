/**
 * Värdelistor ur indexet (SPEC 5.1: sök ska fungera när RAÄ:s tjänster är
 * nere). Namnuppslaget (kommun, socken, län, landskap, lämningstyp, kategori)
 * använder i första hand de här listorna när `DB` finns, och Fornsök-appens
 * värdelistor som reserv (se FallbackDomainSource).
 *
 * Listorna byggs så att DomainService beter sig som med appens listor:
 * - kommuner: omrade (niva kommun) med kommunkod; länet ur kodens två första
 *   siffror.
 * - socknar: omrade (niva socken) med socken-id (omrade.kod) och kommunkoder
 *   ur omrade_relation (kommuner där socknens lämningar ligger). Socknar med
 *   samma namn i flera län har en rad per län i indexet och blir därför flera
 *   kandidater, som i appens lista; ett län som indexet angett för socknen
 *   (omrade.lan) avgör socknens län.
 * - lämningstyper: lamningstyp_kategori och de typer som finns i lamning.
 * - landskap och län: omrade.
 * Bedömningarna är en fast lista (BEDOMNINGAR).
 *
 * Har nattsynken sparat Fornsök-appens listor i D1 (tabellen
 * vardelista_kopia, migrations/0003_omraden.sql) används de, kompletterade med
 * indexets namn: då blir beteendet exakt som med appens listor (appen anger
 * fler kommuner per socken än där det finns lämningar, och skiljer på socknar
 * med samma namn i samma län, t.ex. Råda och Mo i Västra Götaland, som
 * indexet slår ihop). Utan kopia byggs listorna ur indexet enligt ovan.
 */
import { BEDOMNINGAR, type DomainSource, type Domaner, type Kommun, type Socken } from "../sources/types";
import type { D1Like, D1LikeStatement } from "../store/d1";
import { domanerProblem } from "./domains";
import { lanByKod, LAN } from "./names";

type Row = Record<string, unknown>;
const str = (x: unknown): string | null => (typeof x === "string" && x.length > 0 ? x : null);

/**
 * En relation socken → kommun räknas bara om minst så stor andel av socknens
 * lämningar ligger i kommunen, eller om den är socknens största kommun. Annars
 * skulle en enstaka lämning som korsar en kommun- eller länsgräns ge socknen en
 * kommun (och ett län) den inte hör till.
 */
export const RELATION_MIN_ANDEL = 0.05;

export class IndexDomainSource implements DomainSource {
	constructor(private readonly db: D1Like) {}

	async loadDomaner(): Promise<Domaner> {
		const q = (sql: string) => this.db.prepare(sql);
		const [kopia, typer, kat, omr, rel] = (
			await this.db.batch<Row>([
				q(`SELECT data FROM vardelista_kopia WHERE nyckel = '${KOPIA_NYCKEL}'`),
				q("SELECT DISTINCT lamningstyp AS t FROM lamning WHERE lamningstyp IS NOT NULL"),
				q("SELECT lamningstyp, kategori FROM lamningstyp_kategori ORDER BY lamningstyp, kategori"),
				q("SELECT id, niva, namn, lan, kod FROM omrade ORDER BY niva, namn, lan"),
				q(
					"SELECT r.omrade_id AS sid, o2.kod, r.antal, s.antal AS totalt FROM omrade_relation r JOIN omrade o ON o.id = r.omrade_id AND o.niva = 'socken' JOIN omrade o2 ON o2.id = r.overordnad_id AND o2.niva = 'kommun' JOIN omrade_sammanfattning s ON s.omrade_id = r.omrade_id ORDER BY r.omrade_id, r.antal DESC",
				),
			])
		).map((r) => r.results ?? []);

		const katPerTyp = new Map<string, string[]>();
		for (const r of kat) {
			const t = String(r.lamningstyp);
			katPerTyp.set(t, [...(katPerTyp.get(t) ?? []), String(r.kategori)]);
		}
		const typnamn = [...new Set([...katPerTyp.keys(), ...typer.map((r) => String(r.t))])].sort((a, b) => a.localeCompare(b, "sv"));
		const kategorier = [...new Set(kat.map((r) => String(r.kategori)))].sort((a, b) => a.localeCompare(b, "sv"));

		const kommunPerSocken = new Map<number, string[]>();
		for (const r of rel) {
			const sid = Number(r.sid);
			const kod = str(r.kod);
			if (!kod) continue;
			const list = kommunPerSocken.get(sid) ?? [];
			const andel = Number(r.antal) / Math.max(1, Number(r.totalt));
			if (list.length === 0 || andel >= RELATION_MIN_ANDEL) list.push(kod);
			kommunPerSocken.set(sid, list);
		}

		const kommuner: Kommun[] = [];
		const socknar: Socken[] = [];
		const landskap: Domaner["landskap"] = [];
		const lan: Domaner["lan"] = [];
		for (const r of omr) {
			const namn = str(r.namn);
			if (!namn) continue;
			const kod = str(r.kod);
			switch (r.niva) {
				case "kommun": {
					if (!kod) break;
					const l = lanByKod(kod.slice(0, 2));
					kommuner.push({ kod, namn, lan_kod: l?.kod ?? kod.slice(0, 2), lan_namn: l?.namn ?? "" });
					break;
				}
				case "socken": {
					let koder = kommunPerSocken.get(Number(r.id)) ?? [];
					// Indexet har angett socknens län (namnet finns i flera län): bara kommuner i det länet.
					const sockenLan = str(r.lan);
					if (sockenLan) {
						const iLanet = koder.filter((k) => lanByKod(k.slice(0, 2))?.namn === sockenLan);
						if (iLanet.length) koder = iLanet;
					}
					socknar.push({ id: kod ?? `omrade:${String(r.id)}`, namn, kommunkoder: koder });
					break;
				}
				case "landskap":
					landskap.push({ kod: kod ?? namn, namn });
					break;
				case "lan":
					lan.push({ kod: kod ?? LAN.find((x) => x.namn === namn)?.kod ?? "", namn });
					break;
			}
		}
		const kopiaDom = parseKopia(kopia[0]?.data);
		if (kopiaDom) return mergeKopia(kopiaDom, { kommuner, socknar, landskap, typnamn, katPerTyp });
		const d: Domaner = {
			lamningstyper: typnamn.map((namn, i) => ({ id: i + 1, namn, kategorier: katPerTyp.get(namn) ?? [] })),
			kategorier,
			bedomningar: BEDOMNINGAR.map((namn) => ({ namn, beskrivning: null })),
			kommuner,
			socknar,
			landskap,
			lan,
			hamtad: new Date().toISOString(),
			kalla: "index",
		};
		return d;
	}
}

/** Nyckeln i vardelista_kopia för Fornsök-appens värdelistor (sparade av nattsynken). */
export const KOPIA_NYCKEL = "domaner";

function parseKopia(x: unknown): Domaner | null {
	if (typeof x !== "string" || !x) return null;
	try {
		const d = JSON.parse(x) as Domaner;
		return domanerProblem(d) === null ? d : null;
	} catch {
		return null;
	}
}

/**
 * Appens listor (sparade i D1) med de namn som finns i indexet men saknas i
 * kopian tillagda. Appens listor ger samma beteende som förut för flertydiga
 * socknar och kvalificerare (socknarnas kommuner enligt RAÄ, inte bara där det
 * finns lämningar); indexets namn gör att nya namn ändå känns igen.
 */
function mergeKopia(
	d: Domaner,
	ix: { kommuner: Kommun[]; socknar: Socken[]; landskap: Domaner["landskap"]; typnamn: string[]; katPerTyp: Map<string, string[]> },
): Domaner {
	const har = (xs: Array<{ namn: string }>) => new Set(xs.map((x) => x.namn));
	const k = har(d.kommuner);
	const s = har(d.socknar);
	const l = har(d.landskap);
	const t = har(d.lamningstyper);
	let id = Math.max(0, ...d.lamningstyper.map((x) => x.id)) + 1;
	return {
		...d,
		kommuner: [...d.kommuner, ...ix.kommuner.filter((x) => !k.has(x.namn))],
		socknar: [...d.socknar, ...ix.socknar.filter((x) => !s.has(x.namn))],
		landskap: [...d.landskap, ...ix.landskap.filter((x) => !l.has(x.namn))],
		lamningstyper: [...d.lamningstyper, ...ix.typnamn.filter((n) => !t.has(n)).map((namn) => ({ id: id++, namn, kategorier: ix.katPerTyp.get(namn) ?? [] }))],
		kalla: "index",
	};
}

/** Sats som sparar Fornsök-appens värdelistor i D1 (nattsynken), så att namnuppslaget klarar sig utan appen. */
export function sparaKopiaSats(db: D1Like, d: Domaner): D1LikeStatement {
	const { kalla: _k, ...rest } = d;
	return db
		.prepare("INSERT INTO vardelista_kopia (nyckel, data, hamtad) VALUES (?, ?, ?) ON CONFLICT(nyckel) DO UPDATE SET data = excluded.data, hamtad = excluded.hamtad")
		.bind(KOPIA_NYCKEL, JSON.stringify(rest), d.hamtad);
}

/**
 * Indexets listor först; är de ofullständiga eller fallerar frågan, Fornsök-
 * appens (KV-cachade) listor. Felet i indexet loggas.
 */
export class FallbackDomainSource implements DomainSource {
	constructor(
		private readonly primary: DomainSource,
		private readonly fallback: DomainSource,
	) {}

	async loadDomaner(): Promise<Domaner> {
		try {
			const d = await this.primary.loadDomaner();
			const problem = domanerProblem(d);
			if (!problem) return d;
			console.warn(`värdelistor: indexets listor är ofullständiga (${problem}); använder Fornsök-appens.`);
		} catch (err) {
			console.error("värdelistor: indexet svarade inte; använder Fornsök-appens:", err instanceof Error ? err.message : String(err));
		}
		return this.fallback.loadDomaner();
	}
}
