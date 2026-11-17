/**
 * Källagret: ett gränssnitt per förmåga, en implementation per källa.
 *
 * Levande källor (K-samsök, OGC API Features, Fornsök-appen) och indexet
 * (src/store, D1) implementerar samma gränssnitt. Verktygen använder indexet
 * när det finns och faller tillbaka på de levande källorna (SPEC 8). Den
 * semantiska kanalen (Vectorize, etapp 5) ansluts via `SemanticSearch` nedan.
 */
import type { Geometry } from "../geo/geometry";

export const BEDOMNINGAR = [
	"Fornlämning",
	"Möjlig fornlämning",
	"Övrig kulturhistorisk lämning",
	"Ingen antikvarisk bedömning",
	"Ej kulturhistorisk lämning",
] as const;
export type Bedomning = (typeof BEDOMNINGAR)[number];

export interface Koordinat {
	lat: number;
	lon: number;
}

export interface Sweref {
	e: number;
	n: number;
}

// ---------------------------------------------------------------- sök

/**
 * Filter efter att namn slagits upp till de värden källan använder.
 *
 * Gemensamt för alla sökkällor. Indexet (src/store) stöder alla fält; K-samsök
 * stöder inte `fraga`, `kategori`, `egenskap` och `nara` – verktyget översätter
 * dem (`fraga` → `ord`, `kategori` → `lamningstyp`, `nara` → `bbox`) eller
 * avvisar frågan i reservläget (`egenskap`).
 */
export interface ResolvedSearchFilter {
	/** Fritext; delas i ord och OCH-kopplas med `ord`. Bara indexet. */
	fraga?: string;
	/** Ord som alla måste finnas (OCH). `*` sist i ett ord ger prefixsökning. */
	ord?: string[];
	nummer?: string[];
	lamningstyp?: string[];
	/** Kategorier av lämningstyper. Bara indexet. */
	kategori?: string[];
	antikvarisk_bedomning?: Bedomning[];
	kommun?: string[];
	/** Socken med ev. länsavgränsning när namnet finns i flera län. */
	socken?: Array<{ namn: string; lan?: string[]; kommun?: string[] }>;
	landskap?: string[];
	lan?: string[];
	/**
	 * Egenskaper. Samma typ: något av värdena. Olika typer: alla måste finnas.
	 * Gäller även ingående lämningars egenskaper. Bara indexet.
	 */
	egenskap?: Egenskap[];
	/** Ruta i WGS 84: [minLon, minLat, maxLon, maxLat]. */
	bbox?: [number, number, number, number];
	/** Punkt och radie; exakt avstånd till geometrin. Bara indexet. */
	nara?: { lat: number; lon: number; radie_m: number };
}

export interface SearchHit {
	uuid: string;
	lamningsnummer: string | null;
	raa_nummer: string | null;
	lamningstyp: string | null;
	antikvarisk_bedomning: string | null;
	kommun: string[];
	socken: string[];
	lan: string[];
	landskap: string[];
	/** Mittpunkt i WGS 84. */
	koordinat: Koordinat | null;
	/** Beskrivningstext (för utdrag); inte alltid tillgänglig. */
	beskrivning: string | null;
}

export interface SearchPage {
	totalt: number;
	traffar: SearchHit[];
	/** Varifrån svaret kom, t.ex. "K-samsök". */
	kalla: string;
	/** Datum då källans data byggdes, om känt. */
	byggdatum?: string | null;
}

export interface SearchSource {
	search(filter: ResolvedSearchFilter, page: { antal: number; sida: number }): Promise<SearchPage>;
}

// ---------------------------------------------------------------- id-uppslag

export type IdKind = "uuid" | "lamningsnummer" | "raa_nummer";

export interface IdResolver {
	/** Slå upp lämningsnummer/RAÄ-nummer → UUID. Okända saknas i svaret. */
	resolveNumbers(numbers: string[]): Promise<Map<string, string>>;
}

// ---------------------------------------------------------------- post

export interface Egenskap {
	typ: string;
	varde: string;
}

export interface Referenser {
	skriftliga_kallor: string[];
	kartmaterial: string[];
	uppgiftslamnare: string[];
}

export interface LamningPost {
	lamningsnummer: string | null;
	raa_nummer: string | null;
	uuid: string;
	lamningstyp: string | null;
	kategori?: string[];
	antikvarisk_bedomning: { varde: string | null; motivering: string | null };
	antikvarisk_kommentar?: string | null;
	beskrivning: string | null;
	tradition: string | null;
	terrang: string | null;
	orientering: string | null;
	vegetation?: string | null;
	namn?: string[];
	egenskaper: Egenskap[];
	ingaende_lamningar: Array<{ lamningstyp: string; antal: number | null; egenskaper: Egenskap[] }>;
	statusar: {
		aktualitet: string | null;
		undersokning: string | null;
		skada: string | null;
		placering: string | null;
	};
	lage: {
		lat: number | null;
		lon: number | null;
		sweref99tm: Sweref | null;
		osakerhet_m: number | null;
		geometrityp: string | null;
		hojd_over_havet_m?: { min: number | null; max: number | null } | null;
	};
	indelning: { lan: string[]; kommun: string[]; socken: string[]; landskap: string[] };
	url: string;
	kalla: string;
	hamtad_fran: string;
	/** Geometri i WGS 84 (lon, lat), bara när den efterfrågats. */
	geometri?: Geometry | null;
	geometri_forenklad?: boolean;
	referenser?: Referenser;
	/** Dokumentlista (bara när den efterfrågats). Formen ägs av verktygslagret. */
	dokument?: DokumentPost[];
	/** Versionshistorik, nyast först (bara när den efterfrågats). */
	historik?: Version[];
}

export interface RecordFetchResult {
	post: LamningPost;
	/** Full geometri i SWEREF 99 TM om källan har den (Fornsök-appen). */
	geometriSweref?: Geometry | null;
	/** Full geometri i WGS 84 om källan bara har den (K-samsök). */
	geometriWgs?: Geometry | null;
	referenser: Referenser;
}

export interface RecordSource {
	/** Hämta en post på UUID. Returnerar null om källan inte känner till den. */
	getByUuid(uuid: string): Promise<RecordFetchResult | null>;
}

// ---------------------------------------------------------------- närhet

export interface NearbyFeature {
	lamningsnummer: string;
	uuid: string | null;
	raa_nummer: string | null;
	lamningstyp: string | null;
	antikvarisk_bedomning: string | null;
	lamningsnamn: string | null;
	kommun: string | null;
	lan: string | null;
	url: string | null;
	/** Geometri i WGS 84. */
	geometry: Geometry;
}

export interface NearbyQuery {
	bbox: [number, number, number, number];
	lamningstyp?: string[];
	antikvarisk_bedomning?: string[];
	limit: number;
}

export interface NearbyPage {
	/**
	 * Antal träffar i rutan enligt källan. OGC-källan räknar geometrier (ett
	 * objekt per geometri, så en lämning kan räknas flera gånger); indexet
	 * räknar lämningar.
	 */
	numberMatched: number | null;
	/** Antal geometrier i svaret (före ev. bortfall av objekt utan lämningsnummer). */
	numberReturned: number | null;
	features: NearbyFeature[];
}

export interface NearbySource {
	featuresInBbox(q: NearbyQuery): Promise<NearbyPage>;
}

// ---------------------------------------------------------------- värdelistor

export interface Lamningstyp {
	id: number;
	namn: string;
	aktiv: boolean;
	kategorier: string[];
}
export interface Kommun {
	kod: string;
	namn: string;
	lan_kod: string;
	lan_namn: string;
}
export interface Socken {
	id: string;
	namn: string;
	kommunkoder: string[];
}
export interface Landskap {
	kod: string;
	namn: string;
}
export interface Lan {
	kod: string;
	namn: string;
}

export interface Domaner {
	lamningstyper: Lamningstyp[];
	kategorier: string[];
	bedomningar: Array<{ namn: string; beskrivning: string | null }>;
	kommuner: Kommun[];
	socknar: Socken[];
	landskap: Landskap[];
	lan: Lan[];
	hamtad: string;
}

export interface DomainSource {
	loadDomaner(): Promise<Domaner>;
}

// ---------------------------------------------------------------- dokument

/** Dokumentgrupperna i Fornsök-appens `dokument`-svar. */
export const DOKUMENT_GRUPPER = ["inventeringsbok", "handelselogg", "bild", "maritim_dokumentation"] as const;
export type DokumentGrupp = (typeof DOKUMENT_GRUPPER)[number];

export interface DokumentFil {
	/** Appens fil-id (base64-sträng). Används bara inom servern, aldrig som indata. */
	id: string;
	namn: string;
	/** Filtyp enligt appen, t.ex. "jpg", "pdf". */
	typ: string | null;
	storlek_byte: number | null;
	skapad: string | null;
}

export interface Dokument {
	grupp: DokumentGrupp;
	titel: string | null;
	/** `lamningsinformationstyp`, t.ex. "Inventeringsbok", "Händelselogg". */
	typ: string | null;
	skapad: string | null;
	/** Publik dokumentsida på pub.raa.se, om appen anger en giltig. */
	url: string | null;
	fil: DokumentFil | null;
}

/** Ett dokument som det visas i verktygssvaren (lamning_dokument, lamning). */
export interface DokumentPost {
	/** Ogenomskinlig referens till hamta_dokument; null om filen inte kan hämtas. */
	dokument_ref: string | null;
	grupp: DokumentGrupp;
	titel: string | null;
	typ: string | null;
	skapad: string | null;
	filnamn: string | null;
	filtyp: string | null;
	storlek_byte: number | null;
	/** JPEG/PNG upp till 2 MB: hamta_dokument returnerar bilden. */
	visas_som_bild: boolean;
	url: string | null;
}

export interface DokumentLista {
	uuid: string;
	lamningsnummer: string | null;
	dokument: Dokument[];
}

export interface DokumentFilSvar {
	status: number;
	/** Medietyp utan parametrar, gemener (t.ex. "image/jpeg"). */
	mimeType: string;
	contentLength: number | null;
	bytes: Uint8Array | null;
	tooLarge: boolean;
}

export interface DocumentSource {
	/** Dokumentlistan för en lämning. Tom lista om appen säger att inga dokument finns. */
	listDokument(uuid: string): Promise<DokumentLista>;
	/** Hämta en bildfil (bara JPEG/PNG tillåts av listan över anrop), högst `maxBytes`. */
	hamtaBild(fil: DokumentFil, maxBytes: number): Promise<DokumentFilSvar>;
	/** Direktadress till filen i appen (för länk), eller null om id/namn inte är giltiga. */
	filUrl(fil: DokumentFil): string | null;
}

// ---------------------------------------------------------------- historik

export interface Version {
	version_id: number | null;
	publicerad: string | null;
	registrerare: string | null;
	/** Aktiviteten bakom versionen: en åtgärd i registret eller ett arkeologiskt uppdrag. */
	aktivitet: {
		typ: "Åtgärd" | "Uppdrag" | string | null;
		nummer: string | null;
		/** Åtgärdstyp, t.ex. "Migrering från FMIS" (bara åtgärder). */
		atgardstyp: string | null;
		beskrivning: string | null;
		registrerad: string | null;
	} | null;
}

export interface HistorySource {
	/** Versionshistoriken, nyast först. null om lämningen inte finns. */
	getVersioner(uuid: string): Promise<Version[] | null>;
}

// ---------------------------------------------------------------- semantisk sökning

/** En semantisk träff: lämningens UUID och likhet (högre är bättre). */
export interface SemanticHit {
	uuid: string;
	score: number;
}

/**
 * Anslutningspunkt för den semantiska kanalen (SPEC 5.2, etapp 5). Byggs i
 * src/semantic/ och skickas in via `createDeps({ semantic })`. Saknas den
 * används bara ordsök, och `lage: "betydelse"` ger ett tydligt fel.
 *
 * Kontrakt:
 * - `scopeCovers(filter)`: true bara om filtrets geografiska avgränsning (län,
 *   kommun, socken, landskap eller `nara`) ligger helt inom det semantiska
 *   omfånget. Utan geografiskt filter: false (annars får rikstäckande frågor
 *   slagsida mot omfånget). Synkron och utan I/O.
 * - `search(fraga, filter, topK)`: högst `topK` träffar, bäst först. Får
 *   tillämpa det av filtret som går före likhetssökningen (metadata); verktyget
 *   kontrollerar ändå varje träff mot hela filtret i indexet, så träffar
 *   utanför filtret är ofarliga (de stryks). Kastar vid fel; verktyget faller
 *   då tillbaka på ordsök (`lage: "auto"`) eller ger ett fel (`"betydelse"`).
 */
export interface SemanticSearch {
	search(fraga: string, filter: ResolvedSearchFilter, topK: number): Promise<SemanticHit[]>;
	scopeCovers(filter: ResolvedSearchFilter): boolean;
	/** Beskrivning av omfånget för felmeddelanden, t.ex. "Dalarnas län". */
	readonly omfang?: string;
}
