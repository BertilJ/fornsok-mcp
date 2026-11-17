/**
 * Bygger ingest/data/referens.json: värdelistor som GeoPackage-filen saknar.
 *
 * - Lämningstyp → kategorier (ur Fornsök-appens domäner).
 * - Kommun- och länskoder, socken-id med kommunkoder, landskapskoder (ur appens
 *   uppdragsdomäner).
 * - Socken → landskap. GeoPackage-filen har län, kommun och socken men inte
 *   landskap. Kopplingen hämtas ur K-samsök med två facettanrop per landskap
 *   (socknar respektive län där landskapet har lämningar), en sekunds paus
 *   mellan anropen. Facetten ger högst 100 termer, så landskap med fler socknar
 *   delas upp per kommun: cirka 200 anrop och 4 minuter totalt. Körs sällan
 *   (värdena ändras nästan aldrig).
 *
 * Användning:
 *   node ingest/referens.ts [--lamning-domaner fil] [--uppdrag-domaner fil] [--utan-ksamsok]
 *
 * Standard för domänfilerna är de inspelade svaren i test/fixtures. Utan
 * --utan-ksamsok anropas K-samsök; annars behålls socken→landskap från en
 * befintlig referens.json.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(HERE, "data", "referens.json");
const USER_AGENT = "fornsok-mcp/0.1 (+https://fornsok.example.se)";

export interface Referens {
	byggd: string;
	lamningstyper: Array<{ namn: string; kategorier: string[] }>;
	lan: Array<{ kod: string; namn: string }>;
	kommuner: Array<{ kod: string; namn: string; lan_kod: string; lan_namn: string }>;
	socknar: Array<{ id: string; namn: string; kommunkoder: string[] }>;
	landskap: Array<{
		kod: string;
		namn: string;
		/**
		 * Socknar (gemener, som K-samsök returnerar dem) → antal lämningar i
		 * landskapet. Lämningar som korsar en landskapsgräns gör att en socken kan
		 * förekomma i flera landskap; antalet avgör.
		 */
		socknar: Record<string, number>;
		/** Län (gemener) med lämningar i landskapet. */
		lan: string[];
	}>;
}

type Obj = Record<string, unknown>;
const arr = (x: unknown): Obj[] => (Array.isArray(x) ? (x as Obj[]) : []);
const str = (x: unknown): string => (typeof x === "string" ? x : "");

/** K-samsöks facett returnerar högst så många termer (konstaterat 2026-11-17). */
const FACET_MAX = 100;

const cite = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

async function facet(index: string, landskap: string, kommun?: string): Promise<Map<string, number>> {
	const u = new URL("https://kulturarvsdata.se/ksamsok/api");
	u.searchParams.set("method", "facet");
	u.searchParams.set("index", index);
	// Värden citeras med " och \ undantagna (SPEC 8).
	let query = `serviceName=kmr_lamningar and provinceName=${cite(landskap)}`;
	if (kommun) query += ` and municipalityName=${cite(kommun)}`;
	u.searchParams.set("query", query);
	u.searchParams.set("removeBelow", "1");
	const res = await fetch(u, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
	if (!res.ok) throw new Error(`K-samsök svarade ${res.status} för ${index}/${landskap}`);
	const body = (await res.json()) as Obj;
	const result = (body.result ?? {}) as Obj;
	const terms = Array.isArray(result.term) ? result.term : result.term ? [result.term] : [];
	const out = new Map<string, number>();
	for (const t of terms as Obj[]) {
		const v = str((t.indexFields as Obj | undefined)?.value).trim().toLowerCase();
		const n = typeof t.records === "number" ? t.records : 0;
		if (v) out.set(v, (out.get(v) ?? 0) + n);
	}
	return out;
}

const sorted = (m: Map<string, number>): Record<string, number> =>
	Object.fromEntries([...m.entries()].sort((a, b) => a[0].localeCompare(b[0], "sv")));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const args = process.argv.slice(2);
	const opt = (name: string, def: string) => {
		const i = args.indexOf(name);
		return i >= 0 && args[i + 1] ? args[i + 1] : def;
	};
	const lamningDom = JSON.parse(readFileSync(opt("--lamning-domaner", join(ROOT, "test/fixtures/app-lamning-domaner.json")), "utf8")) as Obj;
	const uppdragDom = JSON.parse(readFileSync(opt("--uppdrag-domaner", join(ROOT, "test/fixtures/app-uppdrag-domaner.json")), "utf8")) as Obj;
	const utanKsamsok = args.includes("--utan-ksamsok");

	const previous: Referens | null = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as Referens) : null;

	const landskapBas = arr(uppdragDom.landskap).map((l) => ({ kod: str(l.landskap_kod), namn: str(l.landskap_namn) }));
	const landskap: Referens["landskap"] = [];
	for (const l of landskapBas) {
		if (utanKsamsok) {
			const p = previous?.landskap.find((x) => x.namn === l.namn);
			landskap.push({ ...l, socknar: p?.socknar ?? {}, lan: p?.lan ?? [] });
			continue;
		}
		let socknar = await facet("parishName", l.namn);
		await sleep(1000);
		if (socknar.size >= FACET_MAX) {
			// Kapat: dela upp per kommun (varje kommun har färre än 100 socknar).
			const kommuner = await facet("municipalityName", l.namn);
			await sleep(1000);
			if (kommuner.size >= FACET_MAX) throw new Error(`För många kommuner i ${l.namn}`);
			const all = new Map<string, number>();
			for (const k of kommuner.keys()) {
				const part = await facet("parishName", l.namn, k);
				await sleep(1000);
				if (part.size >= FACET_MAX) throw new Error(`För många socknar i ${l.namn}/${k}`);
				for (const [s, n] of part) all.set(s, (all.get(s) ?? 0) + n);
			}
			socknar = all;
		}
		const lan = await facet("countyName", l.namn);
		await sleep(1000);
		console.error(`${l.namn}: ${socknar.size} socknar, ${lan.size} län`);
		landskap.push({ ...l, socknar: sorted(socknar), lan: [...lan.keys()].sort() });
	}

	const ref: Referens = {
		byggd: new Date().toISOString().slice(0, 10),
		lamningstyper: arr(lamningDom.lamningstyp)
			.map((t) => ({ namn: str(t.namn), kategorier: arr(t.kategorier).map((k) => str(k.namn)).filter(Boolean) }))
			.filter((t) => t.namn)
			.sort((a, b) => a.namn.localeCompare(b.namn, "sv")),
		lan: arr(uppdragDom.lan).map((l) => ({ kod: str(l.lan_kod), namn: str(l.lan_namn) })),
		kommuner: arr(uppdragDom.kommun).map((k) => ({
			kod: str(k.kommun_kod),
			namn: str(k.kommun_namn),
			lan_kod: str(k.lan_kod),
			lan_namn: str(k.lan_namn),
		})),
		socknar: arr(uppdragDom.socken).map((s) => ({
			id: str(s.socken_id),
			namn: str(s.socken_namn),
			kommunkoder: Array.isArray(s.kommunkoder) ? (s.kommunkoder as unknown[]).map(str).filter(Boolean) : [],
		})),
		landskap,
	};
	mkdirSync(dirname(OUT), { recursive: true });
	writeFileSync(OUT, `${JSON.stringify(ref, null, "\t")}\n`);
	console.error(`Skrev ${OUT}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
