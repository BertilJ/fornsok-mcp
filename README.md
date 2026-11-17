# fornsok-mcp

En MCP-server (Model Context Protocol) som ger läsåtkomst till Riksantikvarieämbetets kulturmiljöregister – det som visas i Fornsök: fornlämningar och andra kulturhistoriska lämningar i Sverige. Servern är skriven i TypeScript för Cloudflare Workers och är tillståndslös: en enda ändpunkt, `/mcp`, över Streamable HTTP.

Projektet är under uppbyggnad. Den här versionen (etapp 1) går direkt mot RAÄ:s levande källor och körs lokalt. Ett eget sökindex, dokumenthämtning och inloggning kommer i senare etapper. `SPEC.md` beskriver hela planen.

## Verktyg

| Verktyg | Vad det gör |
|---|---|
| `sok_lamningar` | Ordsök med filter: fritext (alla ord måste finnas), lämningsnummer eller RAÄ-nummer, lämningstyp, antikvarisk bedömning, kommun, socken, landskap, län och område. Ger nummer, typ, bedömning, indelning, koordinat, ett utdrag ur beskrivningen och länk. |
| `lamningar_nara` | Lämningar närmast en punkt (lat/lon i WGS 84) inom en radie, eller inom en ruta. Avståndet räknas till närmaste punkt på lämningens geometri (punkt, linje eller yta), med väderstreck. |
| `lamning` | Hela posten för 1–10 lämningar, på lämningsnummer, RAÄ-nummer, UUID eller K-samsök-URI. Valfritt med geometri (GeoJSON) och referenser. |
| `uppslag` | Värdelistor: lämningstyper med kategori, kategorier, bedömningar, kommuner, socknar, landskap och län. |

Alla verktyg är läsande. Svaren har både läsbar text och `structuredContent` enligt ett `outputSchema`. Namn på kommuner, socknar, typer och län slås upp skiftlägesokänsligt; okända namn ger ett fel med närmaste förslag, och en socken som finns i flera län ger en lista att välja ur.

Några parametrar finns i schemat men kräver det kommande indexet och ger i dag ett tydligt fel: `lage: "betydelse"` (semantisk sökning), `kategori` och `egenskap`. I `lamning` svarar `inkludera: dokument`, `historik` och `relaterat` att de inte finns än.

## Källor

| Källa | Används till | Status |
|---|---|---|
| [K-samsök](https://www.raa.se/hitta-information/k-samsok/) (`kulturarvsdata.se/ksamsok/api`) | Ordsök, nummeruppslag, reserv för hela posten (JSON-LD) | Officiell, öppen, CC0 |
| RAÄ:s [OGC API Features](https://inspire-raa.metria.se/geoserver/Kulturhistoriska_lamningar/ogc/features/v1/) | Närhetssök (ruta + CQL2-filter) | Officiell, öppen, CC0 |
| Fornsök-appens läs-API (`app.raa.se/open/fornsok/api`) | Hela posten, värdelistor | **Odokumenterat och inofficiellt** – se nedan |

All data kommer från Riksantikvarieämbetet, Kulturmiljöregistret, och är CC0. Beskrivningarna i registret är inte kvalitetssäkrade, och den antikvariska bedömningen är registrets – det är länsstyrelsen som avgör i det enskilda fallet. Svaren ska inte användas som underlag för markarbeten. K-samsök ligger några dagar efter registret.

### Om Fornsök-appens läs-API

Fornsök-appens API är inte dokumenterat och inte avsett som ett öppet gränssnitt. Det kan ändras eller stängas utan förvarning, och det ska användas sparsamt:

- Servern anropar bara ett fåtal uttryckligen listade läsanrop (en post i taget och värdelistorna, som cachas). Samma bas-URL har skrivande ändpunkter; en fast lista över tillåtna anrop (`src/upstream/allowlist.ts`) gör att de aldrig kan nås.
- Högst fyra samtidiga anrop per källa, tidsgräns 10 s, ett omförsök vid 5xx/429, och en identifierande `User-Agent` med kontaktväg.
- Massuttag ska aldrig göras via appen. För hela registret finns RAÄ:s öppna GeoPackage-uttag.
- Om appen inte svarar hämtas posten från K-samsök i stället, med färre fält.

Kör du en egen instans: sätt din egen kontaktväg (se Inställningar) och fråga RAÄ innan servern öppnas för fler än några få användare.

## Köra lokalt

Kräver Node 22 och npm. Ingen Cloudflare-inloggning behövs för lokal körning.

```bash
npm install
npm run dev            # wrangler dev, servern svarar på http://localhost:8787/mcp
```

Prova med en MCP-klient, till exempel MCP Inspector mot `http://localhost:8787/mcp`, eller med det medföljande röktestet (gör ett tiotal riktiga anrop mot RAÄ):

```bash
node scripts/smoke.mjs http://localhost:8787/mcp
```

Tester och typkontroll:

```bash
npm test               # vitest, mot inspelade svar i test/fixtures – inga nätverksanrop
npm run type-check
```

## Inställningar

| Inställning | Var | Standard |
|---|---|---|
| `CONTACT_URL` | `vars` i `wrangler.jsonc` | Projektets förvar på GitHub. Hamnar i `User-Agent` mot RAÄ: `fornsok-mcp/0.1 (+<CONTACT_URL>)`. Sätt din egen vid driftsättning. |

Inga API-nycklar behövs för källorna. Hemligheter och kontospecifika värden (konto-id, domäner, Access-uppgifter) hör inte hemma i spårade filer; `.dev.vars`, `.dev.env`, `.env.cloudflare` och `.local/` är undantagna i `.gitignore`.

## Struktur

```
src/
  index.ts              Worker: bara /mcp; plats för åtkomstkontroll före MCP-hanteraren
  server.ts             McpServer med instruktioner och de fyra verktygen
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
scripts/smoke.mjs       Röktest mot lokal server
```

## Licens

Ingen licens är vald än; tills vidare gäller full upphovsrätt för koden. Registerdata från RAÄ, även de inspelade testsvaren, är CC0.
