/** Kommandotolk för ingest/cli.ts (se där för användning). */
import { statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DbSink, FileSink } from "./sink.ts";
import { diff, hashesFromSqlite, hashesFromWranglerJson, hashQueries, load, loadReferens, DEFAULT_REFERENS } from "./load.ts";

function parseArgs(argv: string[]) {
	const pos: string[] = [];
	const opt = new Map<string, string | true>();
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				opt.set(a.slice(2), next);
				i++;
			} else opt.set(a.slice(2), true);
		} else pos.push(a);
	}
	const str = (k: string): string | null => {
		const v = opt.get(k);
		return typeof v === "string" ? v : null;
	};
	return { pos, opt, str };
}

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

export async function main(argv: string[]): Promise<number> {
	const { pos, opt, str } = parseArgs(argv);
	const [cmd, gpkg] = pos;
	const log = (s: string) => console.error(s);
	const refPath = str("referens") ?? DEFAULT_REFERENS;
	const referens = loadReferens(refPath);
	if (cmd !== "hashfragor" && !referens) log(`Varning: ${refPath} saknas – inga kategorier, koder eller landskap.`);

	switch (cmd) {
		case "sql": {
			const ut = str("ut");
			if (!gpkg || !ut) return usage();
			const maxMb = Number(str("max-fil-mb") ?? "20");
			const sink = new FileSink(resolve(ut), Math.max(1, maxMb) * 1024 * 1024);
			const r = load(resolve(gpkg), sink, { referens, log });
			const total = sink.files.reduce((s, f) => s + f.byte, 0);
			writeFileSync(
				join(resolve(ut), "manifest.json"),
				`${JSON.stringify({ kalla: gpkg, uttagsdatum: r.uttagsdatum, lamningar: r.stats.lamningar, filer: sink.files }, null, "\t")}\n`,
			);
			report(r);
			log(`${sink.files.length} filer, totalt ${mb(total)}, största ${mb(Math.max(...sink.files.map((f) => f.byte)))}`);
			return 0;
		}
		case "lokal": {
			const db = str("db");
			if (!gpkg || !db) return usage();
			const sink = new DbSink(resolve(db), { recreate: opt.has("ny") });
			const r = load(resolve(gpkg), sink, { referens, log });
			report(r);
			log(`${sink.statements} satser, databas ${mb(statSync(resolve(db)).size)}`);
			return 0;
		}
		case "diff": {
			if (!gpkg) return usage();
			const mot = str("mot");
			const motJson = str("mot-json");
			if (!mot && !motJson) return usage();
			const existing = mot ? hashesFromSqlite(resolve(mot)) : hashesFromWranglerJson((motJson as string).split(",").map((p) => resolve(p)));
			const sqlUt = str("sql-ut");
			const sink = sqlUt ? new FileSink(resolve(sqlUt), 20 * 1024 * 1024) : undefined;
			const r = diff(resolve(gpkg), existing, { sink, referens });
			console.log(
				JSON.stringify(
					{ befintliga: existing.size, nya: r.nya.length, andrade: r.andrade.length, borttagna: r.borttagna.length, oforandrade: r.oforandrade },
					null,
					2,
				),
			);
			const lista = str("lista");
			if (lista) writeFileSync(resolve(lista), `${JSON.stringify({ nya: r.nya, andrade: r.andrade, borttagna: r.borttagna }, null, "\t")}\n`);
			else {
				for (const u of r.nya.slice(0, 20)) console.log(`ny       ${u}`);
				for (const u of r.andrade.slice(0, 20)) console.log(`ändrad   ${u}`);
				for (const u of r.borttagna.slice(0, 20)) console.log(`borttagen ${u}`);
			}
			if (sink) log(`${sink.files.length} SQL-filer i ${sqlUt}`);
			return 0;
		}
		case "hashfragor": {
			for (const q of hashQueries(str("databas") ?? "fornsok")) console.log(q);
			return 0;
		}
		default:
			return usage();
	}
}

function report(r: ReturnType<typeof load>) {
	const s = r.stats;
	console.error(
		`${s.lamningar} lämningar, ${s.geometrier} geometrier, ${s.egenskaper} egenskaper, ${s.ingaende} ingående; uttagsdatum ${r.uttagsdatum}; ${r.sekunder.toFixed(1)} s`,
	);
	if (s.foraldralosa) console.error(`Föräldralösa barnrader: ${s.foraldralosa}`);
	if (r.utanLandskap) console.error(`Lämningar utan landskap: ${r.utanLandskap}`);
	for (const [k, v] of s.varningar) console.error(`Varning: ${k}: ${v}`);
}

function usage(): number {
	console.error("Användning: se kommentaren överst i ingest/cli.ts");
	return 2;
}
