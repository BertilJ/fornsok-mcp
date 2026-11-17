# fornsok-mcp

En MCP-server (Model Context Protocol) som ger läsåtkomst till Riksantikvarieämbetets kulturmiljöregister – det som visas i Fornsök: fornlämningar och andra kulturhistoriska lämningar i Sverige. Servern är skriven i TypeScript för Cloudflare Workers och är tillståndslös: en enda ändpunkt, `/mcp`, över Streamable HTTP.

Projektet är under uppbyggnad. Den här versionen (etapp 1, 1b och 2) går direkt mot RAÄ:s levande källor, kan läsa inventeringsböcker och historik, och är förberedd för drift bakom Cloudflare Access. Ett eget sökindex kommer i senare etapper. `SPEC.md` beskriver hela planen.

## Verktyg

| Verktyg | Vad det gör |
|---|---|
| `sok_lamningar` | Ordsök med filter: fritext (alla ord måste finnas, högst 12), lämningsnummer eller RAÄ-nummer, lämningstyp, kategori (översätts till kategorins lämningstyper), antikvarisk bedömning, kommun, socken, landskap, län och område. Ger nummer, typ, bedömning, indelning, koordinat, ett utdrag ur beskrivningen och länk. Nummer som skrivs i fritexten söks som nummer. |
| `lamningar_nara` | Lämningar närmast en punkt (lat/lon i WGS 84) inom en radie, eller inom en ruta. Avståndet räknas till närmaste punkt på lämningens geometri (punkt, linje eller yta), med väderstreck. |
| `lamning` | Hela posten för 1–10 lämningar, på lämningsnummer, RAÄ-nummer, UUID eller K-samsök-URI. Valfritt med geometri (GeoJSON), referenser, dokument (med `dokument_ref`) och versionshistorik. |
| `lamning_dokument` | Dokumenten för en lämning: inventeringsboksuppslag, händelseloggar, bilder och maritim dokumentation, var och en med en `dokument_ref`. |
| `hamta_dokument` | Hämtar ett dokument via `dokument_ref`. JPEG och PNG upp till 2 MB kommer som bild i svaret (så att en inventeringsbokssida kan läsas direkt); större filer och PDF som länk med metadata. |
| `uppslag` | Värdelistor: lämningstyper med kategori, kategorier, bedömningar, kommuner, socknar, landskap och län. |

Alla verktyg är läsande. Svaren har både läsbar text och `structuredContent` enligt ett `outputSchema`. Namn på kommuner, socknar, typer och län slås upp skiftlägesokänsligt; okända namn ger ett fel med närmaste förslag, och en socken som finns i flera län ger en lista att välja ur.

Några parametrar finns i schemat men kräver det kommande indexet och ger i dag ett tydligt fel: `lage: "betydelse"` (semantisk sökning) och `egenskap`. I `lamning` svarar `inkludera: relaterat` att det inte finns än.

`dokument_ref` är en ogenomskinlig referens som servern skapar. Den valideras strikt, och filen slås upp på nytt i lämningens dokumentlista innan något hämtas; bara filer i den listan kan nås, och bara via dokumentändpunkten. Innan en bild skickas kontrolleras storlek (enligt listan, `Content-Length` och faktiskt läst mängd), innehållstyp och filsignatur. Versionshistoriken visar publicerade versioner med åtgärd eller uppdrag, inte vad som ändrades.

## Källor

| Källa | Används till | Status |
|---|---|---|
| [K-samsök](https://www.raa.se/hitta-information/k-samsok/) (`kulturarvsdata.se/ksamsok/api`) | Ordsök, nummeruppslag, reserv för hela posten (JSON-LD) | Officiell, öppen, CC0 |
| RAÄ:s [OGC API Features](https://inspire-raa.metria.se/geoserver/Kulturhistoriska_lamningar/ogc/features/v1/) | Närhetssök (ruta + CQL2-filter) | Officiell, öppen, CC0 |
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

Prova med en MCP-klient, till exempel MCP Inspector mot `http://localhost:8787/mcp`, eller med det medföljande röktestet (gör ett femtontal riktiga anrop mot RAÄ, bland annat hämtning av ett inventeringsboksuppslag):

```bash
node scripts/smoke.mjs http://localhost:8787/mcp
node scripts/smoke.mjs --utan-inloggning http://localhost:8787/mcp   # utan .dev.vars: allt ska ge 401
```

Tester och typkontroll:

```bash
npm test               # vitest, mot inspelade svar i test/fixtures – inga nätverksanrop
npm run type-check
```

## Åtkomst

Servern är tänkt att köras bakom [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/) och innehåller ingen egen inloggning. Workern litar ändå inte på att Access sitter framför: allra först, före all routing, verifieras `Cf-Access-Jwt-Assertion` (signatur mot teamets nycklar, `aud`, `iss`, giltighetstid) i `src/auth/access.ts`. Utan giltig JWT blir svaret 401 – för alla sökvägar, och även när Access-inställningarna saknas.

Utvecklingsläget (`ACCESS_DEV_BYPASS="true"`, bara i `.dev.vars`) hoppar över kontrollen, men bara för anrop till `localhost`/`127.0.0.1`/`[::1]` som saknar `cf-ray` (som alla anrop via Cloudflares edge bär). Det är kontrollerat mot `wrangler dev`: där saknas `cf-ray` och adressen är `http://localhost:<port>`; ett anrop med annan `Host` eller med `cf-ray` kräver JWT.

Efter inloggningen begränsas varje användare (e-post ur JWT:n, eller `common_name` för tjänstetoken) med Workers [Rate Limiting-bindning](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), förslagsvis 120 anrop per minut. Över gränsen blir svaret 429 med `Retry-After: 60` och ett JSON-RPC-fel på svenska. Cloudflare räknar ungefärligt och per plats. Saknas bindningen begränsas inget.

## Driftsättning

Den spårade `wrangler.jsonc` är för lokal utveckling och saknar medvetet allt kontospecifikt. För drift:

1. Kopiera `wrangler.local.example.jsonc` till `wrangler.local.jsonc` (ospårad, står i `.gitignore`) och fyll i alla platshållare: konto-id, värdnamn (Workers Custom Domain), kontaktväg, Access-teamdomän och AUD-tagg, ett `namespace_id` för begränsningen, samt id:n för KV (och D1/Vectorize, som används från en senare etapp).
2. `npx wrangler deploy -c wrangler.local.jsonc`

`workers_dev` och förhandsadresser är avstängda, så Workern nås bara via den egna domänen bakom Access. Bindningarna `DB`, `VECTORIZE` och `AI` används inte än; koden fungerar utan dem, och utan `CACHE` (då cachas bara i minnet).

## Inställningar

| Inställning | Var | Standard |
|---|---|---|
| `CONTACT_URL` | `vars` | Projektets förvar på GitHub. Hamnar i `User-Agent` mot RAÄ: `fornsok-mcp/0.1 (+<CONTACT_URL>)`. Sätt din egen vid driftsättning. |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | `vars` i `wrangler.local.jsonc` | Saknas – då svarar Workern 401 på allt. |
| `ACCESS_DEV_BYPASS` | bara `.dev.vars` | Av. `"true"` slår på utvecklingsläget (bara localhost). |
| `RATE_LIMITER` | `ratelimits` i `wrangler.local.jsonc` | Saknas – ingen begränsning. Håll gränsen i takt med `RATE_LIMIT_PER_MINUTE` i `src/config.ts`. |
| `CACHE` | `kv_namespaces` i `wrangler.local.jsonc` | Saknas – bara minnescache. |

Inga API-nycklar behövs för källorna. Hemligheter och kontospecifika värden (konto-id, domäner, Access-uppgifter) hör inte hemma i spårade filer; `wrangler.local.jsonc`, `.dev.vars`, `.dev.env`, `.env.cloudflare` och `.local/` är undantagna i `.gitignore`.

## Struktur

```
src/
  index.ts              Worker: Access-JWT först, sedan begränsning per användare, sedan bara /mcp
  env.ts                Workerns miljö (inställningar och valfria bindningar)
  auth/                 Access-JWT (access.ts) och begränsning per användare (ratelimit.ts)
  cache/                KV-cache för värdelistor och dokumentlistor
  server.ts             McpServer med instruktioner och de sex verktygen
  deps.ts               Kopplar förmågorna till källorna
  tools/                Verktygen (scheman, text- och strukturerade svar)
  sources/              Ett gränssnitt per förmåga, en implementation per källa
    ksamsok/            Frågebyggare och tolkning av K-samsök
    ogc/                OGC API Features och CQL2
    fornsokapp/         Fornsök-appens läs-API
  upstream/             Den enda vägen ut: tillåtna anrop, tidsgräns, omförsök, samtidighet
  lookup/               Värdelistor (cachade) och namnuppslag, fast länstabell
  geo/                  SWEREF 99 TM ⇄ WGS 84, avstånd till geometri, GML
test/                   vitest; inspelade svar under test/fixtures
scripts/smoke.mjs       Röktest mot en körande server (även --utan-inloggning)
wrangler.local.example.jsonc  Mall för driftkonfigurationen (platshållare)
```

## Licens

Ingen licens är vald än; tills vidare gäller full upphovsrätt för koden. Registerdata från RAÄ, även de inspelade testsvaren, är CC0.
