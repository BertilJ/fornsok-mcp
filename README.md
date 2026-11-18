# fornsok-mcp

En MCP-server (Model Context Protocol) som ger läsåtkomst till Riksantikvarieämbetets kulturmiljöregister – det som visas i Fornsök: fornlämningar och andra kulturhistoriska lämningar i Sverige. Servern är skriven i TypeScript för Cloudflare Workers och är tillståndslös: en enda ändpunkt, `/mcp`, över Streamable HTTP.

Projektet är under uppbyggnad (etapp 4–6). Sökning, närhetssök, statistik och grundposten går mot ett eget index över hela registret i Cloudflare D1, laddat från RAÄ:s GeoPackage-uttag och uppdaterat nattligen via RAÄ:s ändringsflöde. Inom ett semantiskt omfång (Dalarnas län) kan sökningen också gå på frågans innebörd (Vectorize och Workers AI). Saknas indexet, är det tomt eller fallerar ett indexanrop, används RAÄ:s levande källor (reservläge). Inventeringsböcker, dokument och historik hämtas alltid från de levande källorna, och relaterat material (foton, arkivhandlingar, föremål) från K-samsök. Servern är förberedd för drift bakom Cloudflare Access. `SPEC.md` beskriver hela planen.

## Verktyg

| Verktyg | Vad det gör |
|---|---|
| `sok_lamningar` | Sök med fritext och filter: lämningsnummer eller RAÄ-nummer, lämningstyp, kategori, antikvarisk bedömning, kommun, socken, landskap, län, egenskap (t.ex. Material = Koppar) och område (`nara`, med avstånd till närmaste punkt på geometrin). Ger nummer, typ, bedömning, indelning, koordinat, lägesosäkerhet, ett utdrag på cirka 200 tecken runt träffen och länk. Svaret anger `sokkanaler`, `hamtad_fran` och `reservlage`. |
| `lamningar_nara` | Lämningar närmast en punkt (lat/lon i WGS 84) inom en radie, eller inom en ruta. Avståndet räknas till närmaste punkt på lämningens geometri (punkt, linje eller yta), med väderstreck. |
| `lamning` | Hela posten för 1–10 lämningar, på lämningsnummer, RAÄ-nummer, UUID eller K-samsök-URI. Grundposten ur indexet; valfritt med geometri (GeoJSON), referenser, dokument (med `dokument_ref`) och versionshistorik, som hämtas från Fornsök-appen, och en sammanfattning av relaterat material ur K-samsök (antal per slag och de första; resten med `relaterat`). Ett RAÄ-nummer som delas av flera lämningar ger alla. |
| `lamning_dokument` | Dokumenten för en lämning: inventeringsboksuppslag, händelseloggar, bilder och maritim dokumentation, var och en med en `dokument_ref`. |
| `hamta_dokument` | Hämtar ett dokument via `dokument_ref`. JPEG och PNG upp till 2 MB kommer som bild i svaret (så att en inventeringsbokssida kan läsas direkt); större filer och PDF som länk med metadata. |
| `relaterat` | Material som K-samsök knyter till en lämning: foton, ritningar och teckningar i RAÄ:s arkiv (slag `foto`), arkivhandlingar som inventeringsboksuppslag (`arkivhandling`), museiföremål (`föremål`), `dokumentation`, äldre FMI-poster som lämningen ersätter (`äldre post`) och `övrigt` (t.ex. samma runsten i Samnordisk runtextdatabas). Per objekt: slag, relationstyp, titel, beskrivning, institution, årtal, länk till objektets sida, bildlänkar och rättighetsuppgiften ordagrant ur K-samsök. Filter på slag, `antal` och `sida`. Servern hämtar inga bilder, bara länkar. |
| `statistik` | Antal lämningar per lämningstyp, kategori, bedömning, län, kommun, socken eller landskap, i en eller två nivåer, med samma filter som `sok_lamningar`. Högst 200 rader. En nivå utan filter går för hela landet (ur förberäknade tabeller); en nivå med filter går också för hela registret; två nivåer görs för högst 400 000 lämningar (200 000 med filter på område eller egenskap), annars ett fel som säger hur frågan kan delas. Kräver indexet. |
| `uppslag` | Värdelistor: lämningstyper med kategori, kategorier, bedömningar, egenskapstyper med värden och antal (ur indexet), kommuner, socknar, landskap och län. |
| `hitta_plats` | Ortnamn till koordinat: socknar, kommuner (förberäknad mittpunkt, migrering 0003) och namngivna lämningar (ordsök i namnet) i indexet, och OpenStreetMap Nominatim (bara Sverige, högst ett anrop per sekund även mellan isolat via en tidsstämpel i KV, inga omförsök, spärr i minst 10 minuter efter 429/403/5xx/tidsgräns/nätverksfel – men inte efter för stora svar eller serverns egen gräns för samtidiga anrop – som prövas också för frågor som redan väntar i kön, svar sparas 30 dygn) när indexet inte ger något, när träffen är en socken eller kommun, eller när namnet inte är exakt en namngiven lämning – så att orten själv kommer med som egen kandidat. OpenStreetMap-träffar utanför angivet län eller kommun tas bort (då begärs tio träffar i stället för fem, kommunnamnen jämförs i alla vanliga former – "Falu kommun", "Upplands-Väsby kommun", "Region Gotland" – och svaret säger det när filtreringen tog bort alla), och en ort paras bara ihop med en socken eller kommun med samma namn när de ligger i samma kommun och län och orten ligger inom områdets utbredning (5 km marginal); annars visas de som skilda kandidater med kommun och län, utan rekommendation. Varje kandidat säger vilken sorts punkt den är (`punkttyp`/`punkt`): mittpunkt för socknens eller kommunens registrerade lämningar, ort enligt OpenStreetMap, eller namngiven lämning; svaret säger hur långt orten ligger från områdets mittpunkt. Koordinaten kan skickas till `lamningar_nara`. |

Alla verktyg är läsande. Svaren har både läsbar text och `structuredContent` enligt ett `outputSchema`. Den läsbara texten har alltid en källrad i formen `Källa: <källa>; <hur färskt>.` (t.ex. `Källa: Lämningsindex (D1); index 2026-11-17.`), eftersom en del klienter (claude.ai) bara visar texten för modellen; samma uppgift står i `hamtad_fran`. Namn på kommuner, socknar, typer, län och egenskaper slås upp skiftlägesokänsligt; okända namn ger ett fel med närmaste förslag, och en socken som finns i flera län ger en lista att välja ur.

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
| `*/15 * * * *` | Inbäddning (`src/semantic/`): högst 1 500 lämningar per körning, tills omfånget är inbäddat; sedan bara ändrade poster. Fel i Workers AI: en del som fallerar delas direkt, djupet först, tills felet är isolerat, och batchstorleken minskas om bara mindre delar går igenom. En text som fallerar ensam två gånger bokförs bara när en annan verklig text ur omfånget lyckas efter den; den prövas igen nästa dygn och vilar efter tre försök i 7 dygn. Går ingen verklig text igenom (referenstexten och tre återstående texter ensamma) är det ett avbrott: körningen kastar efter högst fem anrop och bokför inget obekräftat. Fel i Vectorize och D1 skylls aldrig på texten; de avbryter körningen. Högst 100 anrop per körning, tidsgräns på varje anrop. Före upsert läggs lämningen i `inbaddning_ko` (`orsak = 'påbörjad'`), så att en avbruten körning städas eller fullföljs av nästa. Regeln står överst i `runEmbedBatch`. |

Utan `DB` görs ingenting; utan `AI` eller `VECTORIZE` ingen inbäddning. Ett fel i synken hindrar inte inbäddningen. Varje körning skriver en loggrad. Den schemalagda vägen har ingen HTTP-förfrågan och går inte genom Access-kontrollen; `fetch`-vägen är skyddad som förut.

### Indexet och reservläget

| Läge | `sok_lamningar` | `lamningar_nara` | `lamning` | `statistik`, egenskapsfilter |
|---|---|---|---|---|
| Indexet laddat | Indexet | Indexet (exakt avstånd) | Grundpost ur indexet; referenser, dokument, historik från Fornsök-appen. Poster som saknas i indexet hämtas från appen | Indexet |
| Ingen `DB`-bindning, tomt index eller fel i ett indexanrop | K-samsök | OGC API Features | Fornsök-appen, K-samsök som reserv | Tydligt fel |

`hamtad_fran` säger varifrån svaret kom och hur färskt det är: `index 2026-11-17` (GeoPackage-uttagets datum, eller nattsynkens datum `synk_status.senast_synkat` när det är senare), eller t.ex. `K-samsök (reservläge: indexet är tomt (inte laddat)), data byggd 2026-11-14`. `reservlage: true` och en anmärkning märker svaret. Efter ett fel i ett indexanrop används reserven i 15 sekunder innan indexet prövas igen; läget (laddat, datum) kontrolleras högst en gång per minut och isolat.

Namnuppslaget (kommun, socken, län, landskap, lämningstyp, kategori) går i första hand mot indexet: Fornsök-appens värdelistor sparade i D1 (`vardelista_kopia`), kompletterade med de namn som finns i indexet. Kopian sparas vid första uppslaget när den saknas (uppslaget väntar högst 4 s på appen), förnyas i bakgrunden när den är äldre än 7 dygn, och förnyas av nattsynken varje natt även utan ändringar. Svarar appen inte innan någon kopia finns byggs listorna direkt ur indexet (`omrade`, `lamningstyp_kategori`, lämningstyperna) och cachas bara en minut; socknar som indexet slagit ihop (samma namn i samma län, t.ex. Mo och Råda i Västra Götaland) kräver då en kommun, och svaret säger att det är en avgränsning på kommunen. Appens listor (KV-cachade) är reserv om indexet inte svarar, och för namn som saknas i indexets listor. Sökningen fungerar alltså när appen är nere.

Mycket vanliga ord (fler än 150 000 träffar, t.ex. "och") rangordnas inte med bm25 utan visas i indexets ordning, och svaret säger det; detsamma gäller sortering på lämningsnummer utan sökord. Mätningar mot hela landet: `node scripts/matning.ts` (se kommentaren i filen).

I mycket täta områden prövas högst 5 000 kandidater med exakt avstånd, de närmaste först; svaret anger då radien inom vilken det är fullständigt. Högst 10 000 träffar går att bläddra till (`nabara`).

### Relaterat material

`relaterat` (och `lamning` med `inkludera: ["relaterat"]`) gör ett fåtal läsanrop mot K-samsök per lämning, och resultatet sparas 7 dygn i KV (`CACHE`; utan bindning ingen cache), en tom lista bara ett dygn: `getRelations` (`relation=all`, `objectId=raa/lamning/{uuid}`) ger relationstyperna och de äldre FMI-poster lämningen ersätter; en sökning `relUri="lämningen" OR relUri="FMI-posten" …` (presentationsformatet, 1 000 objekt per sida begärs och nästa sida börjar efter de poster som kom, högst två sidor) ger objektens uppgifter; och bara för relationer som sökningen inte gav görs objektuppslag `itemId="…" OR …`, i omgångar under frågegränsen och högst 120 objekt. Objekt som inte slås upp visas med relation och adress, märkta som ej uppslagna, med slaget härlett ur relationstypen (`isVisualizedBy` → foto). Relationstyper visas bara om de står i en fast lista över K-samsöks relationstyper (annars "okänd relation"), objektens adresser måste vara K-samsök-URI:er, och länkar tolkas och normaliseras; länkar med användaruppgifter avvisas, och värden står vid varje länk (andra värdar än kulturarvsdata.se, raa.se, creativecommons.org, rightsstatements.org, DigitaltMuseum – digitaltmuseum.se och bildservern dimu.org –, riksarkivet.se, commons.wikimedia.org, upload.wikimedia.org och sv.wikipedia.org står som "extern länk, värd: …", oftast ett museums egen bildserver). Äldre FMI-poster slås inte upp och märks som ej uppslagna. Ett UUID kontrolleras mot registret innan K-samsök frågas. Många foton är fortfarande kopplade till den äldre FMI-posten och inte till lämningen (Rök 1:1: 47 objekt till lämningen, 168 till FMI-posten); de tas med och märks med vilken FMI-post de gäller, men utan relationstyp (den står hos FMI-posten). Text och rättighetsuppgifter från K-samsök är extern text och rensas och citeras som registertext. Ett fel hos K-samsök fäller inte `lamning`: delen rapporteras som ej hämtad. Klassningen i slag bygger på tjänst och typ (`arkiv-bilder` → foto, `arkiv-dokument` → arkivhandling); museiföremål har inte setts kopplade till lämningar vid undersökningen, så den klassningen är oprövad mot riktiga data.

`dokument_ref` är en ogenomskinlig referens som servern skapar. Den valideras strikt, och filen slås upp på nytt i lämningens dokumentlista innan något hämtas; bara filer i den listan kan nås, och bara via dokumentändpunkten. Innan en bild skickas kontrolleras storlek (enligt listan, `Content-Length` och faktiskt läst mängd), innehållstyp och filsignatur. Versionshistoriken visar publicerade versioner med åtgärd eller uppdrag, inte vad som ändrades.

## Källor

| Källa | Används till | Status |
|---|---|---|
| RAÄ:s [GeoPackage-uttag](https://pub.raa.se/nedladdning/datauttag/lamningar_v1/) | Indexet (grundladdning och avstämning, se `ingest/`) | Officiell, öppen, CC0 |
| RAÄ:s ändringsflöde (`pub.raa.se/datauttag/lamningar`) | Nattsynken: vilka lämningar som ändrats | Officiell, öppen, CC0 |
| [OpenStreetMap Nominatim](https://nominatim.org/) | `hitta_plats`, för de flesta namn som inte är en namngiven lämning | Öppen, ODbL; högst 1 anrop/s summerat över tjänstens användare, cache, identifierande User-Agent, inga omförsök, spärr efter fel |
| [K-samsök](https://www.raa.se/hitta-information/k-samsok/) (`kulturarvsdata.se/ksamsok/api`) | Reserv för sök och nummeruppslag, reserv för hela posten (JSON-LD), relaterat material (`getRelations`, sökindexen `relUri` och `itemId`) | Officiell, öppen; metadata CC0, medierna har egna rättigheter per objekt |
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
npx wrangler d1 migrations apply fornsok --local -c <din lokala konfiguration>   # 0001–0003
for f in ingest/out/falun/*.sql; do npx wrangler d1 execute fornsok --local -c <din lokala konfiguration> --file "$f" -y; done
npx wrangler dev -c <din lokala konfiguration>
```

Prova med en MCP-klient, till exempel MCP Inspector mot `http://localhost:8787/mcp`, eller med det medföljande röktestet (gör ett trettiotal riktiga läsanrop mot RAÄ, bland annat hämtning av ett inventeringsboksuppslag och relaterat material ur K-samsök, och kontrollerar att varje svar har en källrad; med `--index` kontrolleras också att indexet används, att `statistik` svarar och att posterna kommer ur indexet, och `hitta_plats` frågar OpenStreetMap en gång):

```bash
node scripts/smoke.mjs http://localhost:8787/mcp
node scripts/smoke.mjs --index http://localhost:8787/mcp             # med lokalt index (Falun)
node scripts/smoke.mjs --index <url>                                # upptäcker den semantiska kanalen ur svaret (sokkanaler)
node scripts/smoke.mjs --index --semantisk <url>                    # kräver dessutom att kanalen är ansluten
node scripts/smoke.mjs --utan-inloggning http://localhost:8787/mcp   # utan .dev.vars: allt ska ge 401
```

Tester och typkontroll:

```bash
npm test               # vitest, mot inspelade svar i test/fixtures – inga nätverksanrop
                       # (ett incheckat urval om 300 lämningar testar indexvägarna alltid; Falu kommun
                       #  och hela landet i ingest/.cache/ är valfria och hoppas över om filerna saknas)
npm run type-check     # src/, test/ och ingest/
npx oxlint
```

### Kontrakttester

`test/kontrakt/` innehåller kontrakttester mot de riktiga källorna (SPEC 10): cirka 28 riktiga läsanrop mot RAÄ:s tjänster (K-samsök, inklusive `getRelations` och objektuppslagen för relaterat material, Fornsök-appens läs-API, OGC API Features, ändringsflödet och GeoPackage-uttaget) som kontrollerar att ändpunkterna svarar och att svaren har de fält som koden läser, tolkade med projektets egna tolkare. Anropen går ett i taget med paus, med projektets User-Agent, och med ett hårt tak på 32 anrop per körning. De ingår inte i `npm test`.

```bash
npm run test:kontrakt  # = vitest run --config vitest.kontrakt.config.mts
```

De körs nattligen (05:47 UTC, efter RAÄ:s nattliga uppdatering) i GitHub Actions, `.github/workflows/kontrakt.yml`, och kan startas manuellt där (Run workflow, `workflow_dispatch`) eller lokalt med kommandot ovan. Ett misslyckat test ger en röd körning, och sammanfattningen (`test/kontrakt/sammanfatta.mjs`) skiljer två slags fel:

- `[OTILLGÄNGLIG]` – tjänsten svarade inte (tidsgräns, nätverksfel, 5xx, 429). Oftast tillfälligt; säger inget om svarsformatet.
- `[FORMAT]` – tjänsten svarade, men svaret avviker från det koden förutsätter (fält saknas, fel typ, ändpunkten finns inte längre, HTML i stället för JSON). Det är det verkliga larmet: koden behöver troligen ändras.

Varje felrad har formen `[KLASS] källa | anrop | fält: avvikelse`.

## Åtkomst

Servern är tänkt att köras bakom [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/) och innehåller ingen egen inloggning. Workern litar ändå inte på att Access sitter framför: allra först, före all routing, verifieras `Cf-Access-Jwt-Assertion` (signatur mot teamets nycklar, `aud`, `iss`, giltighetstid) i `src/auth/access.ts`. Utan giltig JWT blir svaret 401 – för alla sökvägar, och även när Access-inställningarna saknas.

Utvecklingsläget (`ACCESS_DEV_BYPASS="true"`, bara i `.dev.vars`) hoppar över kontrollen, men bara för anrop till `localhost`/`127.0.0.1`/`[::1]` som saknar `cf-ray` (som alla anrop via Cloudflares edge bär). Det är kontrollerat mot `wrangler dev`: där saknas `cf-ray` och adressen är `http://localhost:<port>`; ett anrop med annan `Host` eller med `cf-ray` kräver JWT.

Efter inloggningen begränsas varje användare (e-post ur JWT:n, eller `common_name` för tjänstetoken) med Workers [Rate Limiting-bindning](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), förslagsvis 120 anrop per minut. Över gränsen blir svaret 429 med `Retry-After: 60` och ett JSON-RPC-fel på svenska. Cloudflare räknar ungefärligt och per plats. Saknas bindningen begränsas inget.

## Driftsättning

Den spårade `wrangler.jsonc` är för lokal utveckling och saknar medvetet allt kontospecifikt. För drift:

1. Kopiera `wrangler.local.example.jsonc` till `wrangler.local.jsonc` (ospårad, står i `.gitignore`) och fyll i alla platshållare: konto-id, värdnamn (Workers Custom Domain), kontaktväg, Access-teamdomän och AUD-tagg, ett `namespace_id` för begränsningen, samt id:n för KV (och D1/Vectorize, som används från en senare etapp).
2. `npx wrangler deploy -c wrangler.local.jsonc`

`workers_dev` och förhandsadresser är avstängda, så Workern nås bara via den egna domänen bakom Access. `DB` är indexet; utan det går servern i reservläge mot de levande källorna. `VECTORIZE` och `AI` ger semantisk sökning. Utan `CACHE` cachas bara i minnet. Migreringarna (`migrations/0001_init.sql`, `0002_synk_semantik.sql`, `0003_omraden.sql`) körs med `npx wrangler d1 migrations apply <databas> --remote -c wrangler.local.jsonc`, **före** driftsättning av koden som använder dem.

`0003_omraden.sql` skapar tabellerna för förberäknade områden (`omrade_sammanfattning`, `omrade_relation`, `niva_sammanfattning`), kopian av appens värdelistor (`vardelista_kopia`) och felbokföringen för inbäddning (`inbaddning_fel`), och fyller områdestabellerna ur `lamning_omrade` – mot en redan laddad databas, utan omladdning. Omräkningen är uppdelad i 34 satser (per nivå, i fyra delar), som var och en läser högst cirka 200 000 rader; mot hela landet tar den lokalt 15 s sammanlagt och högst 0,9 s per sats. Satserna räknar bara det som saknas, så en avbruten körning kan köras om. Stryps `migrations apply` av D1 (30 s per fråga, strypning vid mycket arbete inom 10 s), kör satserna en i taget:

```bash
node scripts/dela-migrering.mjs migrations/0003_omraden.sql /tmp/0003
for f in /tmp/0003/*.sql; do npx wrangler d1 execute <databas> --remote -c wrangler.local.jsonc --file "$f" -y || break; sleep 5; done
npx wrangler d1 migrations apply <databas> --remote -c wrangler.local.jsonc   # bokför 0003; satserna hoppar över det som redan finns
```

Inläsningen räknar om områdestabellerna helt sist i varje körning, och nattsynken räknar om de områden som en skriven eller borttagen lämning ligger i.

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
  cache/                KV-cache för värdelistor, dokumentlistor och relaterat material
  server.ts             McpServer med instruktioner och de nio verktygen
  scheduled.ts          Schemalagda körningar: nattsynk och inbäddning
  sync/                 Nattsynk via RAÄ:s ändringsflöde
  semantic/             Inbäddning och semantisk sökning (Workers AI, Vectorize)
  deps.ts               Kopplar förmågorna till källorna (index, levande källor, semantisk kanal)
  tools/                Verktygen (scheman, text- och strukturerade svar); via_index.ts väljer index eller reserv
  store/                Indexet i D1: sök, närhet, grundpost, statistik (index.ts), läge och reserv (access.ts)
  search/               Sammanslagning av rangordningar (reciprocal rank fusion)
  sources/              Ett gränssnitt per förmåga, en implementation per källa
    ksamsok/            Frågebyggare och tolkning av K-samsök; relaterat material (relations.ts)
    ogc/                OGC API Features och CQL2
    fornsokapp/         Fornsök-appens läs-API
  upstream/             Den enda vägen ut: tillåtna anrop, tidsgräns, omförsök, samtidighet
  lookup/               Värdelistor (cachade) och namnuppslag, fast länstabell
  geo/                  SWEREF 99 TM ⇄ WGS 84, avstånd till geometri, GML
ingest/                 Inläsning av GeoPackage till indexet (Node 22, körs med npm run ingest)
migrations/             D1-schemat
test/                   vitest; inspelade svar under test/fixtures, indexet mot Falu kommun
scripts/smoke.mjs       Röktest mot en körande server (även --utan-inloggning)
test/kontrakt/          Kontrakttester mot RAÄ:s riktiga källor (npm run test:kontrakt)
scripts/matning.ts      Mätning av indexets frågor mot en lokal laddning av hela landet
scripts/dela-migrering.mjs  Delar en migrering i en fil per sats (för D1:s gränser)
scripts/bygg-testurval.mjs  Bygger det incheckade testurvalet (test/fixtures/falun-urval.sql)
wrangler.local.example.jsonc  Mall för driftkonfigurationen (platshållare)
```

## Licens

Koden är MIT-licensierad (se `LICENSE`). Registerdata från RAÄ, även de inspelade testsvaren, är CC0 och omfattas inte av MIT-licensen.
