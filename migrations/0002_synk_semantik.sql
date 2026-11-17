-- Fornsök MCP – nattsynk och semantisk sökning (SPEC 5.2, 5.3).
--
-- Bygger på 0001_init.sql och ändrar inget i den. Allt här är tillägg:
-- * synk_ko: arbetskö för nattsynken (src/sync/). En rad per lämning som
--   ändringsflödet anger som ny, ändrad eller utgången och som ännu inte är
--   skriven till indexet. Raden tas bort i samma D1-batch som lämningen skrivs,
--   så att en avbruten körning fortsätter där den slutade.
-- * inbaddning: vad som finns i Vectorize per lämning (src/semantic/), med
--   radens innehållshash och en hash över inbäddad text + metadata.
-- * inbaddning_ko: lämningar som nattsynken ändrat inom (eller ut ur) det
--   semantiska omfånget; bearbetas först av inbäddningskörningen.

CREATE TABLE IF NOT EXISTS synk_ko (
	uuid TEXT PRIMARY KEY,
	lamningsnummer TEXT,
	-- Ändringsflödets uppdateringstyper som JSON-lista, t.ex. ["NY"].
	typer TEXT NOT NULL DEFAULT '[]',
	-- 1 om UTGAR finns bland typerna.
	utgar INTEGER NOT NULL DEFAULT 0,
	-- Sista dag i det intervall i flödet där posten förekom.
	datum TEXT,
	-- 'vantar': ska hämtas. 'reserv': skriven från K-samsök, appen prövas igen.
	-- 'saknas': appen svarade 404, prövas igen.
	status TEXT NOT NULL DEFAULT 'vantar' CHECK (status IN ('vantar', 'reserv', 'saknas')),
	forsok INTEGER NOT NULL DEFAULT 0,
	senaste_fel TEXT,
	lagd TEXT NOT NULL,
	andrad TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_synk_ko_status ON synk_ko(status, forsok);

CREATE TABLE IF NOT EXISTS inbaddning (
	uuid TEXT PRIMARY KEY,
	-- lamning.hash när posten bäddades in (ändras när raden skrivs om av
	-- nattsynken eller avstämningen).
	rad_hash TEXT NOT NULL,
	-- Hash över inbäddad text och Vectorize-metadata.
	innehall_hash TEXT NOT NULL,
	-- Antal vektorer i Vectorize: id uuid, uuid#1, uuid#2 … (en per kombination
	-- av län/kommun/socken/landskap när lämningen ligger i flera). 0 = ingen.
	vektorer INTEGER NOT NULL DEFAULT 0,
	-- 'ok': inbäddad. 'tom': ingen meningsfull text, ingen vektor.
	status TEXT NOT NULL CHECK (status IN ('ok', 'tom')),
	modell TEXT NOT NULL,
	andrad TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS inbaddning_ko (
	uuid TEXT PRIMARY KEY,
	orsak TEXT,
	lagd TEXT NOT NULL
) WITHOUT ROWID;
