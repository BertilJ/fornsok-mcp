# fornsok-mcp

En MCP-server (Model Context Protocol) som ger läsåtkomst till Riksantikvarieämbetets kulturmiljöregister – det som visas i Fornsök: fornlämningar och andra kulturhistoriska lämningar i Sverige. Servern är skriven i TypeScript för Cloudflare Workers och är tillståndslös: en enda ändpunkt, `/mcp`, över Streamable HTTP.

Projektet är under uppbyggnad (etapp 4–6). Sökning, närhetssök, statistik och grundposten går mot ett eget index över hela registret i Cloudflare D1, laddat från RAÄ:s GeoPackage-uttag och uppdaterat nattligen via RAÄ:s ändringsflöde. Inom ett semantiskt omfång (Dalarnas län) kan sökningen också gå på frågans innebörd (Vectorize och Workers AI). Saknas indexet, är det tomt eller fallerar ett indexanrop, används RAÄ:s levande källor (reservläge). Inventeringsböcker, dokument och historik hämtas alltid från de levande källorna. Servern är förberedd för drift bakom Cloudflare Access. `SPEC.md` beskriver hela planen.

## Verktyg

| Verktyg | Vad det gör |
|---|---|
| `sok_lamningar` | Sök med fritext och filter: lämningsnummer eller RAÄ-nummer, lämningstyp, kategori, antikvarisk bedömning, kommun, socken, landskap, län, egenskap (t.ex. Material = Koppar) och område (`nara`, med avstånd till närmaste punkt på geometrin). Ger nummer, typ, bedömning, indelning, koordinat, lägesosäkerhet, ett utdrag på cirka 200 tecken runt träffen och länk. Svaret anger `sokkanaler`, `hamtad_fran` och `reservlage`. |
| `lamningar_nara` | Lämningar närmast en punkt (lat/lon i WGS 84) inom en radie, eller inom en ruta. Avståndet räknas till närmaste punkt på lämningens geometri (punkt, linje eller yta), med väderstreck. |
| `lamning` | Hela posten för 1–10 lämningar, på lämningsnummer, RAÄ-nummer, UUID eller K-samsök-URI. Grundposten ur indexet; valfritt med geometri (GeoJSON), referenser, dokument (med `dokument_ref`) och versionshistorik, som hämtas från Fornsök-appen. Ett RAÄ-nummer som delas av flera lämningar ger alla. |
| `lamning_dokument` | Dokumenten för en lämning: inventeringsboksuppslag, händelseloggar, bilder och maritim dokumentation, var och en med en `dokument_ref`. |
| `hamta_dokument` | Hämtar ett dokument via `dokument_ref`. JPEG och PNG upp till 2 MB kommer som bild i svaret (så att en inventeringsbokssida kan läsas direkt); större filer och PDF som länk med metadata. |
| `statistik` | Antal lämningar per lämningstyp, kategori, bedömning, län, kommun, socken eller landskap, i en eller två nivåer, med samma filter som `sok_lamningar`. Högst 200 rader. Kräver indexet. |
| `uppslag` | Värdelistor: lämningstyper med kategori, kategorier, bedömningar, egenskapstyper med värden och antal (ur indexet), kommuner, socknar, landskap och län. |
| `hitta_plats` | Ortnamn till koordinat: först socknar, kommuner och namngivna lämningar i indexet, sedan OpenStreetMap Nominatim (bara Sverige, högst ett anrop per sekund, svar sparas 30 dygn). Koordinaten kan skickas till `lamningar_nara`. |

Alla verktyg är läsande. Svaren har både läsbar text och `structuredContent` enligt ett `outputSchema`. Namn på kommuner, socknar, typer, län och egenskaper slås upp skiftlägesokänsligt; okända namn ger ett fel med närmaste förslag, och en socken som finns i flera län ger en lista att välja ur.

### Ordsökningen

Fritexten söks med SQLite FTS5 över typ, namn, beskrivning, tradition och terräng. Alla ord måste finnas (OCH), i valfri ordning och kolumn. Det finns **ingen stamning**: "källa" hittar inte "källan". Pröva flera böjningsformer, synonymer och äldre stavningar, och använd prefix med `*` (`hytt*` hittar hytta, hyttan, hyttområde). Å, ä och ö skiljs från a och o. Träffarna rangordnas med bm25 (typ och namn väger tyngst). Lämnings- och RAÄ-nummer i fritexten söks som nummer.

### Semantisk sökning

När bindningarna `AI` och `VECTORIZE` finns söker `sok_lamningar` också på frågans innebörd, men bara när frågans geografiska filter (län, kommun, socken, landskap eller `nara`) ligger helt inom det semantiska omfånget (`SEMANTIC_LAN`, standard Dalarna). Rikstäckande frågor och frågor utanför omfånget får bara ordsök, så att de inte får slagsida mot omfånget.

- `lage: "auto"` (standard): ordsök och semantisk sökning parallellt; rangordningarna slås ihop med reciprocal rank fusion (`src/search/fusion.ts`). Varje träff anger `kanaler`, svaret `sokkanaler`.
- `lage: "betydelse"`: bara semantisk sökning. Utanför omfånget, eller utan geografiskt filter, ger den ett fel som förklarar var den gäller.
- `lage: "ord"`: bara ordsök.

Semantiska träffar kontrolleras alltid mot hela filtret i indexet. Faller den semantiska kanalen blir `"auto"` ordsök med en anmärkning. Inbäddningen (`@cf/baai/bge-m3`) görs av de schemalagda körningarna, i delar, tills omfånget är inbäddat; fram till dess ger den semantiska kanalen färre träffar. Utan `AI`/`VECTORIZE` är `"auto"` ordsök och `"betydelse"` ger ett tydligt fel.

### Schemalagda körningar

`src/scheduled.ts`, med Cron Triggers i `wrangler.local.example.jsonc`:

| Cron | Gör |
|---|---|
| `40 3-6 * * *` | Nattsynk (`src/sync/`): gårdagens ändringar ur RAÄ:s ändringsflöde, varje ändrad lämning hämtas från Fornsök-appen (reserv K-samsök) och skrivs till D1. Fyra tillfällen per natt, så att en lång körning fortsätter där den slutade. Därefter inbäddning. |
| `*/15 * * * *` | Inbäddning (`src/semantic/`): högst 1 500 lämningar per körning, tills omfånget är inbäddat; sedan bara ändrade poster. |

Utan `DB` görs ingenting; utan `AI` eller `VECTORIZE` ingen inbäddning. Ett fel i synken hindrar inte inbäddningen. Varje körning skriver en loggrad. Den schemalagda vägen har ingen HTTP-förfrågan och går inte genom Access-kontrollen; `fetch`-vägen är skyddad som förut.

### Indexet och reservläget

| Läge | `sok_lamningar` | `lamningar_nara` | `lamning` | `statistik`, egenskapsfilter |
|---|---|---|---|---|
| Indexet laddat | Indexet | Indexet (exakt avstånd) | Grundpost ur indexet; referenser, dokument, historik från Fornsök-appen. Poster som saknas i indexet hämtas från appen | Indexet |
| Ingen `DB`-bindning, tomt index eller fel i ett indexanrop | K-samsök | OGC API Features | Fornsök-appen, K-samsök som reserv | Tydligt fel |

`hamtad_fran` säger varifrån svaret kom och hur färskt det är: `index 2026-11-17` (GeoPackage-uttagets datum, eller nattsynkens datum `synk_status.senast_synkat` när det är senare), eller t.ex. `K-samsök (reservläge: indexet är tomt (inte laddat)), data byggd 2026-11-14`. `reservlage: true` och en anmärkning märker svaret. Efter ett fel i ett indexanrop används reserven i 15 sekunder innan indexet prövas igen; läget (laddat, datum) kontrolleras högst en gång per minut och isolat.

I mycket täta områden prövas högst 5 000 kandidater med exakt avstånd, de närmaste först; svaret anger då radien inom vilken det är fullständigt. Högst 10 000 träffar går att bläddra till (`nabara`).

`dokument_ref` är en ogenomskinlig referens som servern skapar. Den valideras strikt, och filen slås upp på nytt i lämningens dokumentlista innan något hämtas; bara filer i den listan kan nås, och bara via dokumentändpunkten. Innan en bild skickas kontrolleras storlek (enligt listan, `Content-Length` och faktiskt läst mängd), innehållstyp och filsignatur. Versionshistoriken visar publicerade versioner med åtgärd eller uppdrag, inte vad som ändrades.

## Källor

| Källa | Används till | Status |
|---|---|---|
| RAÄ:s [GeoPackage-uttag](https://pub.raa.se/nedladdning/datauttag/lamningar_v1/) | Indexet (grundladdning och avstämning, se `ingest/`) | Officiell, öppen, CC0 |
| RAÄ:s ändringsflöde (`pub.raa.se/datauttag/lamningar`) | Nattsynken: vilka lämningar som ändrats | Officiell, öppen, CC0 |
| [OpenStreetMap Nominatim](https://nominatim.org/) | `hitta_plats` när indexet saknar namnet | Öppen, ODbL; högst 1 anrop/s, identifierande User-Agent |
| [K-samsök](https://www.raa.se/hitta-information/k-samsok/) (`kulturarvsdata.se/ksamsok/api`) | Reserv för sök och nummeruppslag, reserv för hela posten (JSON-LD) | Officiell, öppen, CC0 |
| RAÄ:s [OGC API Features](https://inspire-raa.metria.se/geoserver/Kulturhistoriska_lamningar/ogc/features/v1/) | Reserv för närhetssök (ruta + CQL2-filter) | Officiell, öppen, CC0 |
| Fornsök-appens läs-API (`app.raa.se/open/fornsok/api`) | Hela posten, värdelistor, dokument och filer, versionshistorik | **Odokumenterat och inofficiellt** – se nedan |

All data kommer från Riksantikvarieämbetet, Kulturmiljöregistret, och är CC0. Beskrivningarna i registret är inte kvalitetssäkrade, och den antikvariska bedömningen är registrets – det är länsstyrelsen som avgör i det enskilda fallet. Svaren ska inte användas som underlag för markarbeten. K-samsök ligger några dagar efter registret.

### Om Fornsök-appens läs-API

Fornsök-appens API är inte dokumenterat och inte avsett som ett öppet gränssnitt. Det kan ändras eller stängas utan förvarning, och det ska användas sparsamt:

- Servern anropar bara ett fåtal uttryckligen listade läsanrop: en post, dess dokumentlista, dess versionshistorik och en bildfil i taget, samt värdelistorna. Värdelistorna cachas (24 h i KV, 1 h i minnet) och dokumentlistorna 1 h i KV. Samma bas-URL har skrivande ändpunkter; en fast lista över tillåtna anrop (`src/upstream/allowlist.ts`) gör att de aldrig kan nås. Filändpunkten är dessutom begränsad till JPEG/PNG – andra filer hämtas aldrig av servern, de ges som länk.
- Högst fyra samtidiga anrop per källa, tidsgräns 10 s, ett omförsök vid 5xx/429, och en identifierande `User-Agent` med kontaktväg.
- Massuttag ska aldrig göras via appen. För hela registret finns RAÄ:s öppna GeoPackage-uttag.
- Om appen inte svarar hämtas posten från K-samsök i stället, med färre fält.

Kör du en egen instans: sätt din egen kontaktväg (se Inställningar) och fråga RAÄ innan servern öppnas för fler än några få användare.

## Köra lokalt

Kräver Node 22 och npm. Ingen Cloudflare-inloggning behövs för lokal körning.

Servern kräver alltid en giltig Cloudflare Access-JWT (se Åtkomst). Lokalt slås ett utvecklingsläge på i en ospårad `.dev.vars`:

```bash
npm install
echo 'ACCESS_DEV_BYPASS=true' > .dev.vars
npm run dev            # wrangler dev, servern svarar på http://localhost:8787/mcp
```

Utan D1-bindning går allt mot de levande källorna (reservläge). Med ett lokalt index (Falu kommun räcker för att prova) i en ospårad konfiguration med `d1_databases`-bindningen `DB` (se `wrangler.local.example.jsonc`; för lokal körning räcker `database_name`, `database_id` kan vara vilket värde som helst):

```bash
curl -fo ingest/.cache/falun.gpkg 'https://pub.raa.se/nedladdning/datauttag/lamningar_v1/kommun/l%c3%a4mningar_kommun_falun.gpkg'
npm run ingest -- sql ingest/.cache/falun.gpkg --ut ingest/out/falun
npx wrangler d1 migrations apply fornsok --local -c <din lokala konfiguration>   # 0001 och 0002
for f in ingest/out/falun/*.sql; do npx wrangler d1 execute fornsok --local -c <din lokala konfiguration> --file "$f" -y; done
npx wrangler dev -c <din lokala konfiguration>
```

Prova med en MCP-klient, till exempel MCP Inspector mot `http://localhost:8787/mcp`, eller med det medföljande röktestet (gör ett femtontal riktiga anrop mot RAÄ, bland annat hämtning av ett inventeringsboksuppslag; med `--index` kontrolleras också att indexet används, att `statistik` svarar och att posterna kommer ur indexet):

```bash
node scripts/smoke.mjs http://localhost:8787/mcp
node scripts/smoke.mjs --index http://localhost:8787/mcp             # med lokalt index (Falun)
node scripts/smoke.mjs --index --semantisk <url>                    # mot driftsatt server med AI/Vectorize
node scripts/smoke.mjs --utan-inloggning http://localhost:8787/mcp   # utan .dev.vars: allt ska ge 401
```

Tester och typkontroll:

```bash
npm test               # vitest, mot inspelade svar i test/fixtures – inga nätverksanrop
npm run type-check     # src/, test/ och ingest/
```

## Åtkomst

Servern är tänkt att köras bakom [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/) och innehåller ingen egen inloggning. Workern litar ändå inte på att Access sitter framför: allra först, före all routing, verifieras `Cf-Access-Jwt-Assertion` (signatur mot teamets nycklar, `aud`, `iss`, giltighetstid) i `src/auth/access.ts`. Utan giltig JWT blir svaret 401 – för alla sökvägar, och även när Access-inställningarna saknas.

Utvecklingsläget (`ACCESS_DEV_BYPASS="true"`, bara i `.dev.vars`) hoppar över kontrollen, men bara för anrop till `localhost`/`127.0.0.1`/`[::1]` som saknar `cf-ray` (som alla anrop via Cloudflares edge bär). Det är kontrollerat mot `wrangler dev`: där saknas `cf-ray` och adressen är `http://localhost:<port>`; ett anrop med annan `Host` eller med `cf-ray` kräver JWT.

Efter inloggningen begränsas varje användare (e-post ur JWT:n, eller `common_name` för tjänstetoken) med Workers [Rate Limiting-bindning](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), förslagsvis 120 anrop per minut. Över gränsen blir svaret 429 med `Retry-After: 60` och ett JSON-RPC-fel på svenska. Cloudflare räknar ungefärligt och per plats. Saknas bindningen begränsas inget.

## Driftsättning

Den spårade `wrangler.jsonc` är för lokal utveckling och saknar medvetet allt kontospecifikt. För drift:

1. Kopiera `wrangler.local.example.jsonc` till `wrangler.local.jsonc` (ospårad, står i `.gitignore`) och fyll i alla platshållare: konto-id, värdnamn (Workers Custom Domain), kontaktväg, Access-teamdomän och AUD-tagg, ett `namespace_id` för begränsningen, samt id:n för KV (och D1/Vectorize, som används från en senare etapp).
2. `npx wrangler deploy -c wrangler.local.jsonc`

`workers_dev` och förhandsadresser är avstängda, så Workern nås bara via den egna domänen bakom Access. `DB` är indexet; utan det går servern i reservläge mot de levande källorna. `VECTORIZE` och `AI` ger semantisk sökning. Utan `CACHE` cachas bara i minnet. Migreringarna (`migrations/0001_init.sql`, `0002_synk_semantik.sql`) körs med `npx wrangler d1 migrations apply <databas> --remote -c wrangler.local.jsonc`.

Indexet laddas från din dator (se kommentaren överst i `ingest/cli.ts`): `npm run ingest -- sql <fil.gpkg> --ut <katalog>` skriver idempotenta SQL-filer som körs med `wrangler d1 execute --remote --file`. Inläsningen stämmer av antalet rader mot källfilen och avbryter med fel om någon lämning tappats.

## Inställningar

| Inställning | Var | Standard |
|---|---|---|
| `CONTACT_URL` | `vars` | Projektets förvar på GitHub. Hamnar i `User-Agent` mot RAÄ: `fornsok-mcp/0.1 (+<CONTACT_URL>)`. Sätt din egen vid driftsättning. |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | `vars` i `wrangler.local.jsonc` | Saknas – då svarar Workern 401 på allt. |
| `ACCESS_DEV_BYPASS` | bara `.dev.vars` | Av. `"true"` slår på utvecklingsläget (bara localhost). |
| `RATE_LIMITER` | `ratelimits` i `wrangler.local.jsonc` | Saknas – ingen begränsning. Håll gränsen i takt med `RATE_LIMIT_PER_MINUTE` i `src/config.ts`. |
| `CACHE` | `kv_namespaces` i `wrangler.local.jsonc` | Saknas – bara minnescache. |
| `DB` | `d1_databases` i `wrangler.local.jsonc` | Saknas – reservläge (levande källor), ingen `statistik`, ingen nattsynk. |
| `AI`, `VECTORIZE` | `ai`, `vectorize` i `wrangler.local.jsonc` | Saknas – bara ordsök, ingen inbäddning. |
| `SEMANTIC_LAN` | `vars` | `Dalarna`. Län i det semantiska omfånget, kommaseparerat. |
| `NOMINATIM` | `vars` | På. `"av"` stänger av Nominatim i `hitta_plats` (då bara indexets namn). |
| `triggers.crons` | `wrangler.local.jsonc` | `["40 3-6 * * *", "*/15 * * * *"]` (se Schemalagda körningar). |
| `CONTACT_URL` (miljövariabel) | `ingest/referens.ts` | Projektets förvar. Kontaktväg i User-Agent när referensdata hämtas från K-samsök. |

Inga API-nycklar behövs för källorna. Hemligheter och kontospecifika värden (konto-id, domäner, Access-uppgifter) hör inte hemma i spårade filer; `wrangler.local.jsonc`, `.dev.vars`, `.dev.env`, `.env.cloudflare` och `.local/` är undantagna i `.gitignore`.

## Struktur

```
src/
  index.ts              Worker: Access-JWT först, sedan begränsning per användare, sedan bara /mcp
  env.ts                Workerns miljö (inställningar och valfria bindningar)
  auth/                 Access-JWT (access.ts) och begränsning per användare (ratelimit.ts)
  cache/                KV-cache för värdelistor och dokumentlistor
  server.ts             McpServer med instruktioner och de åtta verktygen
  scheduled.ts          Schemalagda körningar: nattsynk och inbäddning
  sync/                 Nattsynk via RAÄ:s ändringsflöde
  semantic/             Inbäddning och semantisk sökning (Workers AI, Vectorize)
  deps.ts               Kopplar förmågorna till källorna (index, levande källor, semantisk kanal)
  tools/                Verktygen (scheman, text- och strukturerade svar); via_index.ts väljer index eller reserv
  store/                Indexet i D1: sök, närhet, grundpost, statistik (index.ts), läge och reserv (access.ts)
  search/               Sammanslagning av rangordningar (reciprocal rank fusion)
  sources/              Ett gränssnitt per förmåga, en implementation per källa
    ksamsok/            Frågebyggare och tolkning av K-samsök
    ogc/                OGC API Features och CQL2
    fornsokapp/         Fornsök-appens läs-API
  upstream/             Den enda vägen ut: tillåtna anrop, tidsgräns, omförsök, samtidighet
  lookup/               Värdelistor (cachade) och namnuppslag, fast länstabell
  geo/                  SWEREF 99 TM ⇄ WGS 84, avstånd till geometri, GML
ingest/                 Inläsning av GeoPackage till indexet (Node 22, körs med npm run ingest)
migrations/             D1-schemat
test/                   vitest; inspelade svar under test/fixtures, indexet mot Falu kommun
scripts/smoke.mjs       Röktest mot en körande server (även --utan-inloggning)
wrangler.local.example.jsonc  Mall för driftkonfigurationen (platshållare)
```

## Licens

Ingen licens är vald än; tills vidare gäller full upphovsrätt för koden. Registerdata från RAÄ, även de inspelade testsvaren, är CC0.
