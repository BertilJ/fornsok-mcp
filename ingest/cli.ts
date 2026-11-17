/**
 * Inläsning av RAÄ:s GeoPackage till lämningsindexet (SPEC 5.3).
 * Körs med Node 22 (typstrippning, node:sqlite), utan npm-beroenden.
 *
 *   node ingest/cli.ts sql   <fil.gpkg> --ut <katalog> [--max-fil-mb 20]
 *       Skriver idempotenta SQL-filer för `wrangler d1 execute --remote --file`.
 *       0000_huvud.sql (kategorier), 0001_data.sql …, sist NNNN_synk.sql.
 *
 *   node ingest/cli.ts lokal <fil.gpkg> --db <fil.sqlite> [--ny]
 *       Kör samma satser direkt mot en lokal SQLite-fil (migreringen körs först).
 *       --ny tar bort filen först.
 *
 *   node ingest/cli.ts diff  <fil.gpkg> (--mot <fil.sqlite> | --mot-json a.json,b.json)
 *                            [--sql-ut <katalog>] [--lista <fil.json>]
 *       Avstämning: nya, ändrade (hash) och borttagna jämfört med en befintlig
 *       laddning. --sql-ut skriver SQL som bara rättar avvikelserna.
 *       Filen måste täcka samma område som laddningen (annars blir allt utanför
 *       "borttaget").
 *
 *   node ingest/cli.ts hashfragor [--databas fornsok]
 *       Skriver ut wrangler-kommandon som hämtar uuid+hash ur D1 i 16 delar
 *       (under gränsen 50 MB per svar), till indata för `diff --mot-json`.
 *
 * Gemensamt: --referens <fil> (standard ingest/data/referens.json; se
 * ingest/referens.ts) ger kategorier, koder och landskap.
 *
 * Testdata (läses bara som data; ingest/.cache är undantagen från git):
 *   curl -fo ingest/.cache/falun.gpkg \
 *     'https://pub.raa.se/nedladdning/datauttag/lamningar_v1/kommun/l%c3%a4mningar_kommun_falun.gpkg'
 *   curl -fo ingest/.cache/dalarna.gpkg \
 *     'https://pub.raa.se/nedladdning/datauttag/lamningar_v1/lan/l%c3%a4mningar_l%c3%a4n_dalarna.gpkg'
 *
 * Hela landet till D1 (kräver d1_databases-bindning i wrangler.jsonc med
 * migrations_dir "migrations"):
 *   node ingest/cli.ts sql ingest/.cache/sverige.gpkg --ut ingest/out/sverige
 *   npx wrangler d1 migrations apply fornsok --remote
 *   for f in ingest/out/sverige/*.sql; do npx wrangler d1 execute fornsok --remote --file "$f" -y || break; done
 * Filerna är idempotenta: en fil som fallerar kan köras om, och körningen kan
 * fortsätta från den.
 */
import { registerHooks } from "node:module";

// src/ är skriven för Workers-bundlaren och importerar utan filändelse
// ("./sweref"). Node kräver filändelse; prova ".ts" när upplösningen misslyckas.
registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (e) {
			if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]s$/.test(specifier)) {
				return nextResolve(`${specifier}.ts`, context);
			}
			throw e;
		}
	},
});

const { main } = await import("./main.ts");
process.exitCode = await main(process.argv.slice(2));
