-- Fornsök MCP – D1-schema för lämningsindexet (SPEC 5.2).
--
-- Val och gränser (se även ingest/cli.ts):
-- * FTS5 stöds av D1 enligt dokumentationen. Tabellen har extern innehållskälla
--   (content='lamning'), så att texten inte lagras två gånger; triggrarna nedan
--   håller den i takt med lamning.
-- * R*Tree är inte dokumenterat för D1 (workerd tillåter modulen, men D1:s
--   dokumentation nämner bara FTS5). Därför används indexerade kolumner för den
--   omslutande rutan i SWEREF 99 TM (hela meter) och en höjdklass, se
--   idx_lamning_ruta och src/store/spatial.ts.
-- * D1 kan inte exportera databaser med virtuella tabeller. Export görs genom att
--   lamning_fts tas bort, databasen exporteras och tabellen återskapas med
--   INSERT INTO lamning_fts(lamning_fts) VALUES('rebuild').
-- * Främmande nycklar är påslagna som standard i D1. Barntabellerna raderas
--   ändå uttryckligen av inläsningen, så att resultatet blir detsamma utan dem.

CREATE TABLE IF NOT EXISTS lamning (
	id INTEGER PRIMARY KEY,
	uuid TEXT NOT NULL UNIQUE,
	lamningsnummer TEXT,
	raa_nummer TEXT,
	-- RAÄ-numret i gemener med enkla mellanslag, för uppslag (SQLite:s lower()
	-- viker bara ASCII, därför görs normaliseringen i koden).
	raa_sok TEXT,
	lamningstyp TEXT,
	bedomning TEXT,
	bedomning_motivering TEXT,
	beskrivning TEXT,
	terrang TEXT,
	orientering TEXT,
	tradition TEXT,
	namn TEXT,
	aktualitet TEXT,
	skada TEXT,
	undersokning TEXT,
	placering TEXT,
	-- Mittpunkt i WGS 84 och SWEREF 99 TM.
	lat REAL,
	lon REAL,
	e REAL,
	n REAL,
	-- Omslutande ruta i SWEREF 99 TM, hela meter (golv/tak).
	min_e INTEGER,
	min_n INTEGER,
	max_e INTEGER,
	max_n INTEGER,
	-- Höjdklass för det rumsliga indexet: 0 ≤ 1 km, 1 ≤ 8 km, 2 ≤ 64 km, 3 större.
	rumsklass INTEGER,
	geometrityp TEXT,
	-- GeoJSON i WGS 84 (lon, lat), sju decimaler.
	geometri TEXT,
	geometri_forenklad INTEGER NOT NULL DEFAULT 0,
	osakerhet_m INTEGER,
	publicerad TEXT,
	publicerad_av TEXT,
	uttagsdatum TEXT,
	hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lamning_nummer ON lamning(lamningsnummer);
CREATE INDEX IF NOT EXISTS idx_lamning_raa ON lamning(raa_sok);
CREATE INDEX IF NOT EXISTS idx_lamning_typ ON lamning(lamningstyp);
CREATE INDEX IF NOT EXISTS idx_lamning_bedomning ON lamning(bedomning);
-- Rumsligt index: per höjdklass ett intervall på min_n, övriga villkor prövas i
-- indexet utan att tabellen läses.
CREATE INDEX IF NOT EXISTS idx_lamning_ruta ON lamning(rumsklass, min_n, min_e, max_e, max_n);

-- Indelning: län, kommun, socken, landskap. En lämning kan ligga i flera
-- områden på samma nivå (66 av 3 908 i Falun ligger i flera socknar).
CREATE TABLE IF NOT EXISTS omrade (
	id INTEGER PRIMARY KEY,
	niva TEXT NOT NULL CHECK (niva IN ('lan', 'kommun', 'socken', 'landskap')),
	namn TEXT NOT NULL,
	-- För socken vars namn finns i flera socknar (99 namn: Berg, Bro, Ekeby …):
	-- socknens län. Annars, och för övriga nivåer, tom sträng.
	lan TEXT NOT NULL DEFAULT '',
	-- Länskod, kommunkod, socken-id (när namnet är entydigt inom länet) eller
	-- landskapskod.
	kod TEXT,
	UNIQUE (niva, namn, lan)
);

CREATE TABLE IF NOT EXISTS lamning_omrade (
	omrade_id INTEGER NOT NULL REFERENCES omrade(id),
	lamning_id INTEGER NOT NULL REFERENCES lamning(id) ON DELETE CASCADE,
	PRIMARY KEY (omrade_id, lamning_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_lamning_omrade_lamning ON lamning_omrade(lamning_id);

-- Egenskaper på lämningen (ingaende_nr IS NULL) eller på en ingående lämning.
CREATE TABLE IF NOT EXISTS egenskap (
	lamning_id INTEGER NOT NULL REFERENCES lamning(id) ON DELETE CASCADE,
	ingaende_nr INTEGER,
	typ TEXT NOT NULL,
	varde TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_egenskap_lamning ON egenskap(lamning_id);
CREATE INDEX IF NOT EXISTS idx_egenskap_varde ON egenskap(typ, varde, lamning_id);

-- Ingående lämningar. nr är källans id och kopplar ihop med egenskap.ingaende_nr.
CREATE TABLE IF NOT EXISTS ingaende (
	lamning_id INTEGER NOT NULL REFERENCES lamning(id) ON DELETE CASCADE,
	nr INTEGER NOT NULL,
	lamningstyp TEXT NOT NULL,
	antal INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ingaende_lamning ON ingaende(lamning_id);

-- Lämningstyp → kategori (en typ kan ha flera kategorier). Ur Fornsök-appens
-- värdelistor; GeoPackage-filen saknar kategori.
CREATE TABLE IF NOT EXISTS lamningstyp_kategori (
	lamningstyp TEXT NOT NULL,
	kategori TEXT NOT NULL,
	PRIMARY KEY (lamningstyp, kategori)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_kategori ON lamningstyp_kategori(kategori, lamningstyp);

-- Fulltext. unicode61 med remove_diacritics 0: å/ä/ö skiljs från a/o.
-- Prefixindex för två och tre tecken; längre prefix söks som termintervall.
CREATE VIRTUAL TABLE IF NOT EXISTS lamning_fts USING fts5(
	lamningstyp,
	namn,
	beskrivning,
	tradition,
	terrang,
	content = 'lamning',
	content_rowid = 'id',
	tokenize = 'unicode61 remove_diacritics 0',
	prefix = '2 3'
);

CREATE TRIGGER IF NOT EXISTS lamning_fts_ai AFTER INSERT ON lamning BEGIN
	INSERT INTO lamning_fts(rowid, lamningstyp, namn, beskrivning, tradition, terrang)
	VALUES (new.id, new.lamningstyp, new.namn, new.beskrivning, new.tradition, new.terrang);
END;

CREATE TRIGGER IF NOT EXISTS lamning_fts_ad AFTER DELETE ON lamning BEGIN
	INSERT INTO lamning_fts(lamning_fts, rowid, lamningstyp, namn, beskrivning, tradition, terrang)
	VALUES ('delete', old.id, old.lamningstyp, old.namn, old.beskrivning, old.tradition, old.terrang);
END;

CREATE TRIGGER IF NOT EXISTS lamning_fts_au AFTER UPDATE OF lamningstyp, namn, beskrivning, tradition, terrang ON lamning BEGIN
	INSERT INTO lamning_fts(lamning_fts, rowid, lamningstyp, namn, beskrivning, tradition, terrang)
	VALUES ('delete', old.id, old.lamningstyp, old.namn, old.beskrivning, old.tradition, old.terrang);
	INSERT INTO lamning_fts(rowid, lamningstyp, namn, beskrivning, tradition, terrang)
	VALUES (new.id, new.lamningstyp, new.namn, new.beskrivning, new.tradition, new.terrang);
END;

-- Synk: en rad per körning (grundladdning, avstämning, nattsynk).
CREATE TABLE IF NOT EXISTS synk (
	id INTEGER PRIMARY KEY,
	typ TEXT NOT NULL,
	startad TEXT NOT NULL,
	klar TEXT,
	-- Grundladdning/avstämning: GeoPackage-filens uttagsdatum. Nattsynk: from/to.
	kalla TEXT,
	fran TEXT,
	till TEXT,
	nya INTEGER,
	andrade INTEGER,
	borttagna INTEGER,
	fel TEXT
);

-- Senaste läge: nyckel/värde, t.ex. 'uttagsdatum', 'senast_synkat'.
CREATE TABLE IF NOT EXISTS synk_status (
	nyckel TEXT PRIMARY KEY,
	varde TEXT,
	andrad TEXT
);
