/**
 * Källagret: ett gränssnitt per förmåga, en implementation per källa.
 *
 * Etapp 1 kopplar förmågorna till levande källor (K-samsök, OGC API Features,
 * Fornsök-appen). Etapp 3–5 lägger till en indexkälla (D1/Vectorize) som
 * implementerar samma gränssnitt; verktygen behöver då inte skrivas om.
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

/** Filter efter att namn slagits upp till de värden källan använder. */
export interface ResolvedSearchFilter {
	ord?: string[];
	nummer?: string[];
	lamningstyp?: string[];
	antikvarisk_bedomning?: Bedomning[];
	kommun?: string[];
	/** Socken med ev. länsavgränsning när namnet finns i flera län. */
	socken?: Array<{ namn: string; lan?: string[] }>;
	landskap?: string[];
	lan?: string[];
	/** Ruta i WGS 84: [minLon, minLat, maxLon, maxLat]. */
	bbox?: [number, number, number, number];
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
	/** Antal geometrier (inte lämningar) i rutan enligt källan. */
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
