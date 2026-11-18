# Fornsök MCP – specifikation

Status: utkast 3, 2026-11-17. Inget är byggt.
Utgår från din förlaga (K-samsök-brygga på Cloudflare Workers, tre verktyg) och målet "bästa möjliga lösning på Cloudflare, betald plan", utan märkbar merkostnad. Beslut står i avsnitt 12.

Märkning: **[V]** = verifierat med riktiga anrop 2026-11-17, **[D]** = enligt dokumentation, inte provkört, **[A]** = antagande som ska kontrolleras vid bygget.

---

## 1. Sammanfattning

- Förlagans grundidé håller: K-samsök innehåller hela lämningsposten, med beskrivning, tradition, terräng och referenser **[V]**.
- Tolv detaljer i förlagan stämmer inte mot API:et och hade gett noll träffar eller fel (avsnitt 3).
- Bästa lösningen är inte en ren brygga. Den har ett eget index på Cloudflare (D1 + Vectorize) för sökning, och använder levande källor för det indexet inte rymmer: dokument, inventeringsböcker, historik, relationer.
- Fulltextsök, filter, närhetssök och statistik gäller hela landet. Semantisk sökning gäller Dalarnas län, vilket håller Vectorize inom det som ingår i planen (9.4). Omfånget är en inställning och kan utökas senare.
- Inga API-nycklar från tredje part behövs (avsnitt 2).

## 2. API-nycklar och konton

| Tjänst | Nyckel? | Kommentar |
|---|---|---|
| K-samsök | Nej | Dokumentationen nämner ingen nyckel och anrop fungerar utan **[V]**. Förlagans `KSAMSOK_API_KEY`/`x-api-key` stryks |
| RAÄ: GeoPackage, ändringsflöde, OGC API, Fornsök-appens läs-API | Nej | Alla svarade utan inloggning **[V]** |
| Cloudflare D1, Vectorize, Workers AI, KV, Cron, Workflows | Nej | Nås via bindningar i `wrangler.jsonc`. Ingår i eller debiteras på ditt konto |
| Driftsättning och första inläsningen | Nej | `wrangler login` räcker när det körs från din dator. En Cloudflare API-token behövs bara om det ska köras i CI |
| OpenStreetMap Nominatim (ortnamn → koordinat) | Nej | Kräver identifierande User-Agent och högst 1 anrop/s |
| Lantmäteriet | Ja, men används inte | Deras API för kulturhistoriska lämningar svarade 401 **[V]**. Bara aktuellt om du senare vill ha deras ortnamnstjänst |
| Åtkomstkontroll | Nej | Cloudflare Access med passkeys (9.2), i ditt befintliga Zero Trust-konto |

Inga nycklar från tredje part behövs. Det enda som krävs är en tillfällig Cloudflare-token för uppsättningen (avsnitt 14).

---

## 3. Granskning av förlagan

| # | Förlagan | Verkligheten | Följd |
|---|---|---|---|
| 1 | `serviceOrganization="raa"` | Ger 0 träffar. Värdet är `raä` **[V]** | Alla sökningar hade varit tomma |
| 2 | Filtrerar bara på organisation | `raä` omfattar även arkivbilder, arkivdokument och bebyggelseregistret. "hytta" ger 3 123 träffar, varav 1 625 lämningar **[V]** | Kräver `serviceName=kmr_lamningar` |
| 3 | `countyName="Dalarnas län"` | 0 träffar. Värdet är `Dalarna` **[V]** | Länsnamn måste normaliseras via fast tabell |
| 4 | `boundingBox="/WGS84 a b c d"` | Fel: "ogiltligt format". Rätt: `boundingBox=/WGS84 "minLon minLat maxLon maxLat"` **[V]** | Platssökningen hade inte fungerat |
| 5 | Bbox hittar allt i området | Matchar bara mittpunkten. 51 träffar mot 62 geometrier i samma ruta via RAÄ:s geotjänst **[V]** | Stora ytor (gruvområden, fossil åker) missas |
| 6 | `recordSchema=xml` + `fields` ger rena fält | Fungerar, men är odokumenterat (dokumentationen nämner bara `presentation`). `itemDescription` kommer som åtta otypade värden: beskrivning, terräng, referens och statusar blandat **[V]** | Går inte att veta vilket värde som är beskrivningen |
| 7 | `itemLabel` = namn/nummer, `itemType` = typ | `itemLabel` är lämningstypen. `itemType` är "Kulturlämning" för alla. Lämningsnumret ligger i `itemNumber`, tillsammans med RAÄ-numret **[V]** | Fältmappningen blir fel |
| 8 | `thumbnail` | Finns inte för lämningar. Okänt fältnamn ger HTTP 400 **[V]** | Stryks |
| 9 | `text="<sökord>"` | Flera ord inom citattecken matchar som ELLER (897 träffar mot 25 med OCH). Lämningsnummer går inte att hitta via `text` **[V]** | Ord ska delas och OCH-kopplas; nummer söks via `itemNumber` |
| 10 | JSON-svaret är en lista | `record` är ett objekt vid en träff och en lista vid flera; samma för `field`. Vissa fel kommer som XML trots `Accept: application/json` **[V]** | Tolkningen måste normalisera |
| 11 | `McpAgent` + `/sse` | Föråldrat. Cloudflares mall använder `createMcpHandler` ur `agents/mcp/server` med `@modelcontextprotocol/server` 2.3.1, utan Durable Object och utan session. GET ger 405. SSE-transporten är utfasad i MCP 2026-07-28 **[V/D]** | Bara `/mcp`. Mallkommandot i förlagan gäller fortfarande |
| 12 | Detaljverktyget ger "allt" | K-samsök saknar dokument, inventeringsboksbilder, egenskaper, ingående lämningar, lägesosäkerhet och versionshistorik | Hämtas från Fornsök-appens läs-API |

Övrigt:
- Ändpunkten är `https://kulturarvsdata.se/ksamsok/api`; förlagan anger bara värdnamnet.
- K-samsök ligger några dagar efter: testposten var byggd 2026-11-14, och antalet fornlämningar i Falun var 891 mot 911 i dagens GeoPackage **[V]**.
- Rätt index för filter: lämningstyp `itemName`, antikvarisk bedömning `itemSpecification`, nummer `itemNumber`, kommun `municipalityName`, socken `parishName`, landskap `provinceName` **[V]**.
- `hitsPerPage` får vara 1–1 000, standard 50 **[D/V]**.

---

## 4. Datakällor

| Källa | Roll i lösningen | Officiell |
|---|---|---|
| GeoPackage, `pub.raa.se/nedladdning/datauttag/lamningar_v1/` | Grundladdning av indexet. Hela Sverige 2,3 GB, nygenereras varje natt **[V]** | Ja, CC0 |
| Ändringsflöde, `pub.raa.se/datauttag/lamningar?from=&to=` | Nattlig synk: vilka lämningar som är nya, ändrade eller utgångna. 98 ändringar 10–11 nov **[V]** | Ja, CC0 |
| Fornsök-appens läs-API, `app.raa.se/open/fornsok/api/…` | Fullständig post vid synk; dokument, bilder och historik vid fråga **[V]** | Nej, odokumenterat |
| OGC API Features, `inspire-raa.metria.se/…/ogc/features/v1/` | Reserv för rumslig sökning. Bbox på 0,09 s, CQL2-filter **[V]** | Ja, CC0 |
| K-samsök, `kulturarvsdata.se/ksamsok/api` | Reserv för sök och post; relationer till foton, arkivhandlingar och föremål **[V]** | Ja, CC0 |
| Nominatim | Ortnamn till koordinat | Öppen, ODbL |

Det här finns i respektive källa:

| Uppgift | GeoPackage | Fornsök-appen | K-samsök |
|---|---|---|---|
| Beskrivning, terräng, orientering, tradition | Ja | Ja | Ja |
| Egenskaper, ingående lämningar | Ja | Ja | Nej |
| Geometri (punkt, linje, yta) | Ja, SWEREF 99 TM | Ja | Ja, WGS 84 |
| Lägesosäkerhet i meter | Ja | Ja | Nej |
| Skriftliga källor och kartreferenser | Nej | Ja | Ja |
| Antikvarisk kommentar, höjd över havet | Nej | Ja | Nej |
| Dokument, inventeringsbok som bild | Nej | Ja | Länk via relation |
| Versionshistorik | Nej | Ja | Nej |

Identiteter: lämningsnummer `L1946:7415`, RAÄ-nummer `Stugun 114:1` (äldre litteratur), UUID (teknisk nyckel i alla källor), publik länk `https://pub.raa.se/visa/objekt/lamning/{uuid}`, K-samsök-URI `http://kulturarvsdata.se/raa/lamning/{uuid}`.

Fornsök-appens läsanrop som används **[V]**:

| Anrop | Ger |
|---|---|
| `GET api/lamning/lamning/{uuid}` | Fullständig post |
| `GET api/lamning/lamning/{uuid}/version` | Versionshistorik |
| `GET api/lamning/dokument?lamning_id={uuid}` | Inventeringsböcker, händelseloggar, bilder, maritim dokumentation |
| `GET api/lamning/dokument/fil/{fil.id}/{fil.namn}` | Filen. Testat: inventeringsboksuppslag, 283 kB JPEG i 300 dpi |
| `GET api/lamning/domaner`, `GET api/uppdrag/domaner` | Värdelistor: 169 lämningstyper i 12 kategorier, 5 bedömningar, 290 kommuner, 2 434 socknar, 25 landskap |
| `POST proxy/api/lamning/search/lamning` | Sökning. Används bara som reserv |

Samma bas-URL har skrivande ändpunkter. Servern får bara kunna anropa listan ovan (9.3).

---

## 5. Arkitektur

```
Claude ── MCP, Streamable HTTP, /mcp ──▶ Worker (createMcpHandler, tillståndslös)
                                           │
              ┌────────────────────────────┼─────────────────────────────┐
              ▼                            ▼                             ▼
   Eget index (sökning)          Levande källor (djup)          Reserv vid fel
   D1: poster, FTS5, geometri    Fornsök-appen: dokument,       K-samsök: sök, post
   Vectorize: semantisk sökning  bilder, historik               OGC API: närhetssök
   Workers AI: inbäddningar      K-samsök: relationer
              ▲                  Nominatim: ortnamn
              │
   Inläsning: GeoPackage (en gång, sedan avstämning) + nattlig synk
   via ändringsflödet (Cron → Workflow)
```

### 5.1 Varför eget index

| Förmåga | Bara K-samsök | Eget index |
|---|---|---|
| Fråga i naturligt språk ("platser där man offrat mynt") | Nej, bara ordmatchning | Ja, inom det semantiska området (5.2) |
| Textutdrag i träfflistan | Nej | Ja. Färre följdanrop |
| Avstånd till ytans kant i stället för mittpunkt | Nej | Ja |
| Fritext, filter och radie i samma fråga | Delvis | Ja |
| Filter på egenskaper och ingående lämningar | Nej | Ja |
| Statistik per typ, bedömning och område | Enkel facettering | Fri gruppering |
| Aktualitet | Några dagars eftersläpning | Nattlig |
| Fungerar när RAÄ:s tjänster är nere | Nej | Ja, för sök och grundpost |

Kostnaden är en inläsningskedja. Den byggs så att servern fungerar mot levande källor redan innan indexet finns (etapp 1) och faller tillbaka på dem om indexet fallerar.

### 5.2 Indexet

**D1** (gräns 10 GB per databas; FTS5 stöds **[D]**):

| Tabell | Innehåll |
|---|---|
| `lamning` | uuid, lämningsnummer, RAÄ-nummer, typ, kategori, bedömning + motivering, beskrivning, terräng, orientering, tradition, namn, statusar, placering, mittpunkt (WGS 84 och SWEREF), omslutande ruta, geometrityp, geometri (GeoJSON), osäkerhet i meter, publiceringsdatum, innehållshash |
| `lamning_omrade` | uuid, nivå (län/kommun/socken/landskap), namn, kod. Egen tabell eftersom en lämning kan ligga i flera socknar (66 av 3 908 i Falun) |
| `egenskap` | uuid, typ, värde |
| `ingaende` | uuid, lämningstyp, antal |
| `lamning_fts` | FTS5 över beskrivning, tradition, terräng, namn, typ. `unicode61` med `remove_diacritics 0` så att å/ä/ö inte slås ihop med a/o; prefixindex |
| Rumsligt index | R\*Tree om D1 tillåter det **[A]** – annars index på rutans fyra kolumner |
| `synk` | Senast synkade datum, körningar, fel |

Uppskattad storlek: 1,5–2,5 GB (Falun: 3 908 lämningar, 1,8 MB beskrivningstext; hela landet cirka 770 000 lämningar).

**Vectorize** (gräns 20 miljoner vektorer per index, 10 KiB metadata per vektor, 10 metadataindex **[D]**):
- Omfång: Dalarnas län, drygt 30 000 lämningar (landskapet Dalarna har 32 944 poster i K-samsök **[V]**). Omfånget är en inställning (lista av län), så att fler län kan läggas till utan kodändring.
- En vektor per lämning med meningsfull text inom omfånget. Standardfrasen "Beskrivningen är inte kvalitetssäkrad …" tas bort före inbäddning.
- Text som bäddas in: typ, namn, beskrivning, tradition, terräng.
- Metadataindex: typ, bedömning, län, kommun, socken, landskap, så att filter kan tillämpas före likhetssökningen.
- Modell: `@cf/baai/bge-m3` (1 024 dimensioner, flerspråkig **[D]**). Vald för att den är beprövad; `@cf/google/embeddinggemma-2` släpptes 2026-11-12 och är för ny att lita på utan jämförelse. Jämförelsen på svenska frågor kan göras senare – ett modellbyte kräver ett nytt index och ny inbäddning, vilket är billigt.

**Sökning:** FTS5 är alltid med. Vectorize används när frågans geografiska filter (län, kommun, socken, landskap eller `nara`) ligger helt inom det semantiska omfånget; då körs båda parallellt, rangordningarna slås ihop (reciprocal rank fusion) och träffarna fylls på från D1. Utan geografiskt filter, eller utanför omfånget, används bara FTS5 – annars skulle rikstäckande frågor få en slagsida mot Dalarna. Svaret anger vilka kanaler som användes.

FTS5 har ingen svensk stamning. Prefixsökning täcker en del böjningsformer; i övrigt får modellen söka med flera former och synonymer (se serverinstruktionerna).

### 5.3 Inläsning

| Steg | Var | Hur |
|---|---|---|
| Grundladdning | Din dator (eller CI) | Skript laddar ned Sverige-filen, läser den med SQLite, skriver till D1 i omgångar via Wrangler. GeoPackage är en SQLite-fil och ryms inte i en Workers minne, därför utanför |
| Inbäddning | Cloudflare Workflow | Läser nya eller ändrade rader inom det semantiska omfånget ur D1, bäddar in med Workers AI, skriver till Vectorize |
| Nattlig synk | Cron efter 04:30 → Workflow | Hämtar gårdagens ändringar ur ändringsflödet. Per ändrad lämning: hämta fullständig post från Fornsök-appen (reserv: K-samsök), uppdatera D1, bädda in på nytt. `UTGAR` tar bort posten |
| Avstämning | Månadsvis, samma skript som grundladdningen | Jämför innehållshash mot ny GeoPackage och rättar avvikelser |

Flödet uppdateras nattligen 00–04 **[D]**, därav klockslaget. Alternativ till lokal grundladdning: Cloudflare Containers **[A]**.

### 5.4 Teknikval

| Del | Val |
|---|---|
| Stomme | `npm create cloudflare@latest -- fornsok-mcp --template=cloudflare/ai/demos/remote-mcp-authless` **[V]** |
| MCP | `createMcpHandler` ur `agents/mcp/server` + `@modelcontextprotocol/server` (exakt den version Agents-paketet kräver; mallen har 2.3.1) |
| Protokoll | MCP 2026-07-28, tillståndslöst. Samma `/mcp` betjänar äldre klienter i tillståndslöst läge **[D]** |
| Validering | zod 4, `outputSchema` per verktyg |
| Koordinater | Egen Gauss-Krüger-omräkning SWEREF 99 TM ⇄ WGS 84 (inga tunga beroenden) |
| Cache | KV för värdelistor, dokumentlistor och geokodning; Cache API för filer |
| Test | vitest med inspelade svar; MCP Inspector |
| Adress | `https://fornsok.example.se/mcp` (Workers Custom Domain i zonen example.se). `workers.dev`-adressen och förhandsadresser stängs av |
| Åtkomst | Cloudflare Access: passkeys som inloggning, Managed OAuth mot MCP-klienter (9.2) |

---

## 6. Verktyg

Gemensamt:
- Läsande: `readOnlyHint`, `idempotentHint`, `openWorldHint`. Fast ordning i verktygslistan.
- Indata tar namn ("Falun", "Hyttområde", "Fornlämning"); servern slår upp koder. Okänt namn ger fel med närmaste förslag.
- Svar har läsbar text och `structuredContent`. Koordinater ut i WGS 84, med SWEREF 99 TM i den strukturerade delen.
- Varje lämning har `lamningsnummer` och `url`.
- Inga träffar är ett vanligt svar med förslag på bredare sökning, inte ett fel (som i förlagan).

Förlagans tre verktyg motsvaras av `sok_lamningar`, `lamningar_nara` och `lamning`.

### `sok_lamningar`
| Parameter | Typ | Beskrivning |
|---|---|---|
| `fraga` | string? | Sökord eller fråga i naturligt språk |
| `lage` | `auto` \| `ord` \| `betydelse` = `auto` | `auto`: ordsök, plus semantisk sökning inom omfånget. `ord`: bara ordmatchning. `betydelse`: bara semantisk; utanför omfånget ger den ett fel som förklarar var den gäller |
| `nummer` | string[]? | Lämningsnummer eller RAÄ-nummer |
| `lamningstyp`, `kategori` | string[]? | |
| `antikvarisk_bedomning` | enum[]? | Fornlämning, Möjlig fornlämning, Övrig kulturhistorisk lämning, Ingen antikvarisk bedömning, Ej kulturhistorisk lämning |
| `kommun`, `socken`, `landskap`, `lan` | string[]? | |
| `egenskap` | {typ, varde}[]? | T.ex. Verksamhet, Material, Form |
| `nara` | {lat, lon, radie_m}? | Begränsar till ett område |
| `antal` | int = 15, max 50 | |
| `sida` | int = 1 | |

Svar: `totalt`, `sokkanaler` (`ord`, `betydelse` eller båda) och en lista med nummer, typ, bedömning, kommun, socken, koordinat, `utdrag` (cirka 200 tecken runt träffen), `url`, och `avstand_m` om `nara` angavs.

### `lamningar_nara`
`lat`, `lon`, `radie_m` (500, max 10 000) eller `bbox`; filter på typ och bedömning; `antal` (25, max 100). Avstånd räknas i SWEREF 99 TM till närmaste punkt på geometrin. Sorterat närmast först, med `avstand_m` och väderstreck. Koordinater utanför Sverige avvisas utan anrop.

### `lamning`
`id` (lämningsnummer, RAÄ-nummer, UUID eller K-samsök-URI; upp till 10 åt gången) och `inkludera` (`geometri`, `referenser`, `dokument`, `historik`, `relaterat`).

Grundsvaret kommer ur D1: identiteter, typ, bedömning med motivering, beskrivning, terräng, orientering, tradition, egenskaper, ingående lämningar, statusar, indelning, mittpunkt, osäkerhet, `url`. `inkludera` hämtar resten från levande källor. Geometri returneras som GeoJSON i WGS 84, förenklad över 500 brytpunkter och då märkt som förenklad.

### `lamning_dokument` och `hamta_dokument`
Lista över inventeringsboksuppslag, händelseloggar, bilder och maritim dokumentation, var och en med en `dokument_ref` som servern skapar. `hamta_dokument` returnerar JPEG/PNG upp till 2 MB som bildinnehåll, så att Claude kan läsa inventeringsboken; större filer och PDF som länk med metadata.

### `statistik`
`gruppera_pa` (typ, kategori, bedömning, län, kommun, socken, landskap; en eller två nivåer) med samma filter som `sok_lamningar`. Svar: antal per grupp, högst 200 rader.

### `uppslag`
`lista` (lämningstyper, kategorier, bedömningar, egenskapstyper, kommuner, socknar, landskap, län) och `sok` (delsträng). Lämningstyper returneras med kategori.

### `hitta_plats`
`namn` och valfritt `kommun`/`lan`. Söker först bland socknar, kommuner och namngivna lämningar i indexet, och går till Nominatim bara om det inte ger något. Svar: kandidater med koordinat, typ och källa. Nominatim-svar sparas 30 dygn.

OpenStreetMap är ojämnt för torp, fäbodar och äldre gruvnamn. För sådana platser är TORA i Riksarkivets koppling bättre; verktygsbeskrivningen ska säga att en koordinat därifrån kan skickas direkt till `lamningar_nara`.

### Senare
| Verktyg | Källa | Återstår att utreda |
|---|---|---|
| `relaterat` – foton, arkivhandlingar, föremål | K-samsök `getRelations` **[V]** | Vilka relationstyper som är värda att visa |
| `sok_uppdrag`, `uppdrag` – arkeologiska uppdrag och rapporter | Fornsök-appen, egna GeoPackage för uppdrag | Sökparametrarna är inte kartlagda |
| `karta` – interaktiv karta i samtalet | MCP Apps, `@modelcontextprotocol/ext-apps` 2.0.4 **[D]** | Klientstöd |

### Serverinstruktioner
- Ange lämningsnummer och länk för varje sakuppgift.
- Beskrivningarna är inte kvalitetssäkrade och ofta överförda från äldre register; återge dem som registrets uppgift.
- Antikvarisk bedömning är registrets bedömning. Länsstyrelsen avgör i det enskilda fallet. Svaren ska inte användas som underlag för markarbeten.
- Ange lägesosäkerheten när läget spelar roll.
- Äldre litteratur använder RAÄ-nummer; sök på det när en källa anger ett.
- Semantiska träffar är förslag: läs posten innan något påstås om den.
- Semantisk sökning finns bara för Dalarnas län. I övrigt gäller ordsök utan stamning: pröva flera böjningsformer, synonymer och äldre stavningar innan du drar slutsatsen att något saknas.
- Står det inte i registret: säg det.

---

## 7. Svarsformat

```json
{
  "lamningsnummer": "L2001:646",
  "raa_nummer": "Bjursås 27:1",
  "uuid": "adc490ba-871a-45bd-8e3d-0a27761b3b6c",
  "lamningstyp": "Källa med tradition",
  "antikvarisk_bedomning": { "varde": "Övrig kulturhistorisk lämning", "motivering": "…" },
  "beskrivning": "Trefaldighetskälla, oval, 1.5x1 m …",
  "tradition": "…",
  "terrang": "Måttlig NÖ-sluttning. Moränmark. Skogsmark (blandskog).",
  "egenskaper": [{ "typ": "…", "varde": "…" }],
  "lage": { "lat": 60.7337, "lon": 15.4564, "osakerhet_m": 10, "geometrityp": "Point" },
  "indelning": { "lan": ["Dalarna"], "kommun": ["Falun"], "socken": ["Bjursås"], "landskap": ["Dalarna"] },
  "url": "https://pub.raa.se/visa/objekt/lamning/adc490ba-871a-45bd-8e3d-0a27761b3b6c",
  "kalla": "Riksantikvarieämbetet, Kulturmiljöregistret (CC0)",
  "hamtad_fran": "index 2026-11-17"
}
```

`hamtad_fran` säger om svaret kom från indexet eller en reservkälla, och hur färskt det är.

---

## 8. Fel och reservvägar

| Händelse | Beteende |
|---|---|
| Inga träffar | Vanligt svar: vilka filter som gällde, förslag på bredare sökning |
| Okänt typ-, kommun- eller sockennamn | Verktygsfel med närmaste namn. Flertydig socken: kandidater med län |
| D1 eller Vectorize otillgängligt | Sök via K-samsök, närhetssök via OGC API. Svaret märks som reservläge |
| Fornsök-appen otillgänglig | Grundposten ur D1 levereras; `inkludera`-delarna rapporteras som ej hämtade. Nattsynken hämtar posten från K-samsök i stället |
| Uppströms 5xx eller tidsgräns (10 s) | Ett omförsök, sedan strukturerat fel |
| Nattsynken misslyckas | Nästa körning tar från senast lyckade datum. Larm efter två missade nätter |

Vid anrop mot K-samsök: värden sätts inom citattecken med `"` och `\` undantagna, ord OCH-kopplas, svaret normaliseras (objekt eller lista), och XML-fel tolkas.

---

## 9. Drift och säkerhet

### 9.1 Uppförande mot RAÄ
- `User-Agent` med tjänstens namn och en kontaktväg som du väljer.
- Högst 4 samtidiga anrop per källa. Nattsynken hämtar ändrade poster en i taget med paus.
- Massuttag sker bara via GeoPackage, aldrig via Fornsök-appen.
- Efter etapp 2 skickas ett mejl till fornsok@raa.se som beskriver vilka läsanrop servern gör och hur ofta, med nattsynken särskilt nämnd eftersom den är den enda automatiska trafiken. Indexet gör att servern klarar ett nej: då hämtas ändrade poster från K-samsök, och dokumentverktygen utgår.
- Om servern öppnas för fler än ägaren och enstaka bekanta ska RAÄ tillfrågas innan.

### 9.2 Åtkomst
Servern är för ägaren och enstaka bekanta. Åtkomsten sköts av Cloudflare Access framför Workern; servern innehåller ingen egen inloggningskod.

| Del | Utformning |
|---|---|
| Access-applikation | Self-hosted, värdnamn `fornsok.example.se` **[D]** |
| Inloggning | Vid start: engångskod till e-post. Kräver ingen ändring på organisationsnivå. Passkeys (stöds av Access sedan 2026-11-06 **[D]**) läggs till när ägaren uttryckligen godkänt det (avsnitt 14); därefter kan engångskoden stängas av för den här applikationen |
| Policy | Allow för en lista av e-postadresser: ägaren, och bekanta som läggs till vid behov |
| MCP-klienter | Managed OAuth påslaget: Access är OAuth-server, klienten öppnar ett webbläsarfönster för passkey-inloggning och får en token **[D]** |
| Klientregistrering | Dynamisk. Tillåtna omdirigeringsadresser: claude.ai:s och claude.com:s MCP-callback, samt localhost och loopback för Claude Code och Desktop. De exakta adresserna kontrolleras vid uppsättningen **[A]** |
| Livslängd | Åtkomsttoken 15 minuter, förnyas tyst; ny passkey-inloggning efter 30 dagar |
| I Workern | Verifierar `Cf-Access-Jwt-Assertion` (signatur mot teamets nycklar, `aud`, `iss`, giltighetstid) och avvisar allt annat. Skyddar om Access av misstag kopplas bort |
| Begränsning | Per användare (e-post ur JWT), inte per IP |

Första gången registrerar varje användare sin passkey på Access-sidan; då skickas en engångskod till e-postadressen för att bekräfta identiteten **[D]**. En bekant läggs till genom att adressen läggs i policyn. Borttappad enhet: passkeyn tas bort i Zero Trust under användaren.

Förlagans `MCP_AUTH_TOKEN` och den hemliga sökvägen utgår.

### 9.3 Säkerhet
- Fast lista över tillåtna uppströmsanrop (metod + sökvägsmönster). Indata valideras mot mönster innan de används i sökvägar.
- `dokument_ref` kan bara peka på dokumentändpunkten.
- Registertext är data, inte instruktioner, och märks som källtext.
- Frågor mot D1 är parametriserade; FTS5-uttryck byggs av servern, aldrig av rå indata.
- Ingen väg förbi Access: `workers_dev` och förhandsadresser är avstängda, och Workern svarar 401 utan giltig Access-JWT även om den nås direkt.
- Cloudflare-token ligger i `.dev.env` (rättighet 600, utanför versionshantering) och skrivs aldrig ut i loggar eller svar. Bygg-agenterna läser den inte; bara samordnaren använder den, och först från etapp 1b.

### 9.4 Kostnad utöver grundplanen (uppskattning)
| Post | Uppskattning |
|---|---|
| Vectorize, Dalarnas län: cirka 33 000 vektorer à 1 024 dimensioner (34 miljoner) | cirka 0,01 USD/månad |
| Inbäddning av Dalarnas län, engångs | under 0,10 USD |
| D1, cirka 2 GB | ingår |
| Nattsynk, cirka 100 poster | försumbart |

Räknat på Cloudflares prislista 2026-11-17 **[D]**. Vectorize debiterar två saker:

- Sökta dimensioner: (lagrade vektorer + antal sökningar) × dimensioner per månad. 50 miljoner ingår, därefter 0,01 USD per miljon.
- Lagrade dimensioner: 10 miljoner ingår, därefter 0,05 USD per 100 miljoner.

| Omfång | Vektorer × 768 | Sökta, över det som ingår | Lagrade, över det som ingår | Summa per månad |
|---|---|---|---|---|
| Dalarnas län | 25 miljoner | 0 | 15 miljoner → 0,008 USD | under 0,01 USD |
| Hela landet | 591 miljoner | 541 miljoner → 5,41 USD | 581 miljoner → 0,29 USD | cirka 5,70 USD |

Indexets storlek avgör alltså kostnaden, inte hur mycket det används. Taket för att stanna inom det som ingår är ungefär 65 000 vektorer med 768 dimensioner (minus en vektor per sökning under månaden; Dalarna lämnar utrymme för cirka 30 000 sökningar). Varje ytterligare 100 000 vektorer kostar omkring 0,80 USD per månad. Fler län kan därför läggas till billigt, och med 512 dimensioner ryms cirka 97 000 vektorer utan kostnad.

---

## 10. Test

| Nivå | Innehåll |
|---|---|
| Enhet | Namnuppslag, koordinatomräkning mot kända punkter, avstånd till geometri, sammanslagning av rangordningar, tolkning av K-samsök-svar |
| Källor | Inspelade svar från varje anrop i avsnitt 4 |
| Kontrakt | Nattlig kontroll mot riktiga källor: finns fälten, svarar ändpunkterna? |
| Inläsning | Falu kommun som fast testmängd: 3 908 lämningar ska ge 3 908 rader |
| Sökkvalitet | 30 svenska frågor med kända rätta svar i Falu-data; mäts per sökläge och inbäddningsmodell |
| MCP | Inspector: verktygslista, scheman, felvägar |

Fasta testposter: `L1946:7415` (Stugun 114:1, linje, har inventeringsbok), `L2000:8802` (Stora Kopparberg 172:1, hyttområde), `L2001:646` (Bjursås 27:1, har traditionstext).

---

## 11. Etapper

| Etapp | Innehåll | Klar när |
|---|---|---|
| 1 | Stomme ur mallen. `sok_lamningar` (ordsök), `lamningar_nara`, `lamning`, `uppslag` mot levande källor. Körs lokalt | Tester gröna; de tre testposterna hämtas rätt via MCP mot lokal server |
| 1b | Driftsättning på `fornsok.example.se`, Access-applikation med passkeys och Managed OAuth, JWT-kontroll i Workern. Kräver Cloudflare-token | Fungerar som koppling i claude.ai efter passkey-inloggning; anrop utan inloggning avvisas |
| 2 | `lamning_dokument`, `hamta_dokument` | Claude läser en inventeringsbokssida |
| 3 | D1-schema, grundladdning, nattsynk, avstämning | Antal rader stämmer mot GeoPackage; en natts ändringar slår igenom |
| 4 | Sök och närhetssök flyttas till indexet: utdrag, avstånd till geometri, egenskapsfilter, `statistik` | Reservläget fungerar när indexet stängs av |
| 5 | Vectorize för Dalarnas län, semantisk sökning, sammanslagen rangordning | Sökkvalitetstestet visar förbättring mot enbart ordsök; frågor utan geografiskt filter påverkas inte |
| 6 | `hitta_plats`, `relaterat` | "Lämningar nära Falu gruva" besvaras utan att koordinat anges |
| 7 | Uppdrag, karta | Efter behov |

Servern är användbar efter etapp 1b. Etapp 1 och 2 kan byggas och testas utan Cloudflare-token; från 1b krävs den.

---

## 12. Beslut

| Fråga | Beslut | Status |
|---|---|---|
| Drift | Cloudflare Workers, betald plan | Bestämt av dig |
| Semantisk sökning | Bara Dalarnas län, så att Vectorize ryms i planen | Bestämt av dig |
| Åtkomst | Du och enstaka bekanta, med passkey via Cloudflare Access | Bestämt av dig |
| Adress | Underdomän på example.se. Namnet `fornsok` är mitt förslag | Domänen bestämd av dig |
| Vem skriver kod | Bara Opus och Sonnet. Fable samordnar, granskar och skriver spec | Bestämt av dig |
| Versionshantering | Git, en commit per etapp | Bestämt av dig |
| Publicering | Publikt på GitHub, utan nycklar eller kontospecifika uppgifter | Bestämt av dig |
| Licens | MIT | Bestämt av dig |
| Driftadress | Står inte i förvaret; exemplen använder `fornsok.example.se` | Bestämt av dig |
| RAÄ | Bygg först, informera fornsok@raa.se efter etapp 2 | Mitt förslag, inte bekräftat av dig |
| Ortnamn | Indexets egna namn först, Nominatim i andra hand, TORA via Riksarkivets koppling för äldre platser | Mitt förslag, inte bekräftat av dig |
| Grundladdning | Från din dator med `wrangler login`, ingen API-token | Mitt förslag, inte bekräftat av dig |
| API-nycklar | Inga behövs | Verifierat |

---

## 13. Byggprocess

- All kod skrivs av Opus- eller Sonnet-agenter. Fable skriver ingen kod, utan delar ut uppdrag, kör tester, granskar resultat mot specen och uppdaterar specen.
- En etapp i taget, i ordningen i avsnitt 11. Varje etapp går igenom: bygg → typkontroll och tester → oberoende granskning av en annan agent → rättning → kontroll mot etappens "klar när".
- En etapp är inte klar förrän testerna har körts och utfallet redovisats. Avvikelser från specen redovisas och förs in här, eller rättas.
- Agenter verifierar bibliotekens API mot installerade paket och aktuell dokumentation, inte ur minnet.
- Inget driftsätts och inget i Cloudflare-kontot ändras utan token (avsnitt 14).
- Versionshantering: git. Samordnaren gör en commit per godkänd etapp; agenterna committar inte själva.
- Förvaret är publikt på GitHub (`BertilJ/fornsok-mcp`). Därför gäller:
  - Inga hemligheter och inga kontospecifika värden i spårade filer: ingen token, inget konto-id, inga resurs-id:n, ingen teamdomän, ingen AUD-tagg, inga e-postadresser. Den spårade `wrangler.jsonc` har platshållare; de riktiga värdena ligger i en ospårad lokal konfigurationsfil.
  - Driftadress och kontaktväg i `User-Agent` är inställningar, inte hårdkodade, så att andra kan driftsätta med egna värden.
  - Före varje push kontrolleras att token inte finns i någon spårad fil eller i historiken, och att mönster för nycklar, id:n och adresser saknas.
  - Commits görs med GitHubs noreply-adress.
  - Licens: MIT (filen `LICENSE`). Registerdata från RAÄ är CC0 och omfattas inte av licensen.
  - Den riktiga driftadressen står inte i någon spårad fil; exemplen använder `fornsok.example.se`.
  - Inspelade testsvar från RAÄ innehåller bara öppna registerdata (CC0).
- Tester mot RAÄ:s tjänster görs sparsamt: inspelade svar i första hand, levande anrop bara för inspelning och kontraktstest.

## 14. Cloudflare-token för uppsättningen

Skapas under My Profile → API Tokens → Create Custom Token.

| Nivå | Behörighet | Rätt | Används till |
|---|---|---|---|
| Konto | Workers Scripts | Edit | Driftsätta Workern, hemligheter, schemalagda körningar, Workflows |
| Konto | D1 | Edit | Skapa databasen, köra migreringar, grundladdning |
| Konto | Vectorize | Edit | Skapa index och metadataindex |
| Konto | Workers KV Storage | Edit | Skapa namnrymd för cache |
| Konto | Workers AI | Read | Köra inbäddningsmodellen vid lokal test och modelljämförelse |
| Konto | Workers Tail | Read | Läsa loggar vid felsökning |
| Konto | Access: Apps and Policies | Edit | Skapa Access-applikationen, policyn och Managed OAuth |
| Konto | Access: Organizations, Identity Providers, and Groups | Edit | Lägga till Passkeys som inloggningsmetod |
| Konto | Access: Service Tokens | Edit | En tillfällig tjänstetoken för automatiska tester av den skyddade adressen; tas bort efteråt |
| Konto | Account Settings | Read | Wrangler slår upp kontot |
| Zon | Zone | Read | Slå upp zonen example.se |
| Zon | Workers Routes | Edit | Koppla `fornsok.example.se` till Workern |
| Zon | DNS | Read | Kontrollera att värdnamnet är ledigt |
| Användare | User Details | Read | Wrangler (`whoami`) |
| Användare | Memberships | Read | Wrangler (`whoami`) |

Avgränsning:
- Kontoresurser: bara ditt konto. Zonresurser: bara example.se.
- Giltighetstid: sju dagar räcker för uppsättningen. Återkalla den när etapp 5 är klar.
- IP-filter mot din egen adress om den är fast.

Två rader kan snävas åt:
- "Organizations, Identity Providers, and Groups: Edit" ger skrivrätt till Zero Trust-inställningarna. Lägger du själv till Passkeys under Zero Trust → Integrations → Identity providers räcker Read.
- "DNS: Read" kan behöva bli Edit om kopplingen av domänen visar sig kräva det **[A]**. Dokumentationen anger bara Workers Routes.

Behövs inte: R2, Queues, Containers, Pages, Zone Settings, Firewall, Billing.

Överlämning: token ligger i `.dev.env` i projektroten (rättighet 600, undantagen från git). Wrangler läser inte den filen själv; samordnaren skickar in värdet som `CLOUDFLARE_API_TOKEN` per kommando. Den skrivs aldrig ut.

Kontrollerat 2026-11-17 med enbart läsande anrop **[V]**: token är aktiv; läsning fungerar för Workers, D1, Vectorize, KV, Workers AI, Access (organisation, inloggningsmetoder, applikationer, tjänstetoken), zonen och DNS. Skrivrätten visar sig först vid första ändringen.

### Befintligt i kontot som inte får röras

Kontot bär annan produktion: Workers, databaser, domäner och Access-applikationer **[V]**. Därför:

- Allt som skapas får egna namn med prefixet `fornsok`: Worker `fornsok-mcp`, D1 `fornsok`, Vectorize `fornsok-lamningar`, KV `fornsok-cache`, Access-applikation "Fornsök MCP".
- Inget befintligt ändras eller tas bort. Före varje skapande kontrolleras att namnet är ledigt.
- `fornsok.example.se` var ledigt i DNS och det fanns inga Workers-rutter i zonen **[V]**.
- Inloggningsmetoder i Zero Trust-organisationen i dag: engångskod och Cloudflare-konto. Passkeys finns inte än **[V]**.
- Kontospecifika uppgifter (konto-id, teamdomän, resurs-id:n, AUD-tagg, tillåtna e-postadresser) står i den lokala, ospårade filen `.local/drift.md` och ska inte in i spårade filer.

### Skapat i kontot 2026-11-17

| Resurs | Namn | Kommentar |
|---|---|---|
| D1 | `fornsok` | Tom, Västeuropa |
| KV | `fornsok-cache` | Tom |
| Vectorize | `fornsok-lamningar` | 1 024 dimensioner, cosinus; metadataindex beställda för typ, bedömning, län, kommun, socken, landskap |
| Access-applikation | "Fornsök MCP", `fornsok.example.se` | Engångskod via e-post, Managed OAuth påslaget, policy "Ägare" med ägarens e-postadresser |

Inga befintliga resurser är ändrade.

**Kräver ditt godkännande:** att lägga till Passkeys är en ändring på organisationsnivå. Inloggning med engångskod via e-post påverkas inte: metoden finns kvar, och applikationer som är låsta till den ändras inte alls. Befintliga Access-applikationer som godtar alla inloggningsmetoder kommer då också att visa "Sign in with a passkey" på sin inloggningssida. Det ger ingen ny åtkomst (policyn avgör fortfarande), men utseendet ändras. Alternativet är att varje befintlig applikation låses till sina nuvarande metoder först.

Efter uppsättningen behövs ingen token för driften: Workern når D1, Vectorize, KV och Workers AI via bindningar. Den månatliga avstämningen (5.3) körs med `wrangler login` eller en ny, smal token med bara D1: Edit.

## 15. Källor

- K-samsök, metoder och index: https://www.raa.se/hitta-information/k-samsok/att-anvanda-k-samsok/metoder/ och https://www.raa.se/hitta-information/k-samsok/att-anvanda-k-samsok/ytterligare-index-for-sok/
- RAÄ:s öppna data-portal: https://www.raa.se/hitta-information/oppna-data/oppna-data-portal/ (katalog `https://catalog.raa.se/store/`)
- Aktuellt om öppna data: https://www.raa.se/hitta-information/oppna-data/aktuellt-om-oppna-data/
- Direktåtkomst, OpenAPI: https://pub.raa.se/datauttag/swagger/index.html
- OGC API Features: https://inspire-raa.metria.se/geoserver/Kulturhistoriska_lamningar/ogc/features/v1/
- GeoPackage: https://pub.raa.se/nedladdning/datauttag/lamningar_v1/
- Fornsök: https://app.raa.se/open/fornsok/
- Cloudflare, `createMcpHandler`: https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
- Cloudflare, mallen: https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-authless
- Cloudflare, gränser och priser: https://developers.cloudflare.com/d1/platform/limits/ , https://developers.cloudflare.com/vectorize/platform/limits/ , https://developers.cloudflare.com/vectorize/platform/pricing/ , https://developers.cloudflare.com/workers-ai/platform/pricing/
- MCP 2026-07-28, ändringar: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- Nominatim, användningsvillkor: https://operations.osmfoundation.org/policies/nominatim/
- Cloudflare Access, passkeys: https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/passkeys/
- Cloudflare Access, Managed OAuth: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
- Cloudflare, token-behörigheter: https://developers.cloudflare.com/fundamentals/api/reference/permissions/
