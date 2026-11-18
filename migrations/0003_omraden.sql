-- Fornsök MCP – förberäknade områden (hitta_plats, namnuppslag, statistik).
--
-- Bygger på 0001 och 0002 och ändrar inget i dem. Idempotent: kan köras om
-- (tabeller och index skapas bara om de saknas; omräkningen tar bara områden
-- som saknar rader, så en avbruten körning fortsätter där den slutade).
-- Säker mot en laddad databas: läser lamning, lamning_omrade och omrade, och
-- skriver bara i de nya tabellerna.
--
-- * omrade_sammanfattning: per område (län, kommun, socken, landskap) antal
--   lämningar, antal med läge, mittpunkt (medelvärdet av lämningarnas
--   mittpunkter) och omslutande ruta i WGS 84. Ersätter avg(l.lat) över alla
--   lämningar i området vid varje anrop till hitta_plats.
-- * omrade_relation: socken → kommun/län och kommun → län, med antalet
--   lämningar som ligger i båda. Ersätter självkopplingen av lamning_omrade.
--   Används också av namnuppslaget ur indexet (socknens kommuner).
-- * niva_sammanfattning: antal lämningar med område per nivå (statistik).
-- * vardelista_kopia: Fornsök-appens värdelistor sparade i D1 (se nedan).
-- * inbaddning_fel: lämningar vars inbäddning fallerat (se nedan).
--
-- Omräkningen nedan är uppdelad per nivå och i fyra delar (omrade.id % 4), så
-- att varje sats läser högst cirka 200 000 rader i lamning_omrade (hela
-- landet: 3 miljoner) och lika många uppslag i lamning. Samma satser ger
-- src/store/omraden.ts (fullRecomputeSql; ett test kontrollerar att de är
-- lika), och inläsningen (ingest/) kör dem sist i varje SQL-körning.
-- Nattsynken markerar berörda områden (inaktuell = 1) och räknar om dem efter
-- körningen.
--
-- Körning mot D1 (se README, Driftsättning): `wrangler d1 migrations apply`,
-- eller, om den stryps, satserna i omgångar med `wrangler d1 execute --file`.

CREATE TABLE IF NOT EXISTS omrade_sammanfattning (
	omrade_id INTEGER PRIMARY KEY,
	-- Lämningar i området.
	antal INTEGER NOT NULL DEFAULT 0,
	-- Lämningar med mittpunkt.
	med_lage INTEGER NOT NULL DEFAULT 0,
	lat REAL,
	lon REAL,
	min_lat REAL,
	min_lon REAL,
	max_lat REAL,
	max_lon REAL,
	-- 1 = nattsynken har ändrat en lämning i området; räknas om efter körningen.
	inaktuell INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_omrade_sammanfattning_inaktuell ON omrade_sammanfattning(inaktuell) WHERE inaktuell = 1;

CREATE TABLE IF NOT EXISTS omrade_relation (
	omrade_id INTEGER NOT NULL,
	overordnad_id INTEGER NOT NULL,
	antal INTEGER NOT NULL,
	PRIMARY KEY (omrade_id, overordnad_id)
) WITHOUT ROWID;

-- Per nivå: antal lämningar med minst ett område på nivån ("(saknas)" i
-- statistik är resten).
CREATE TABLE IF NOT EXISTS niva_sammanfattning (
	niva TEXT PRIMARY KEY,
	med_omrade INTEGER NOT NULL,
	inaktuell INTEGER NOT NULL DEFAULT 0
);

-- Kopia av Fornsök-appens värdelistor (JSON), sparad av nattsynken när den
-- hämtar dem. Namnuppslaget läser den ur D1 (src/lookup/index_domaner.ts), så
-- att sökningen fungerar när appen är nere (SPEC 5.1). Fylls inte här.
CREATE TABLE IF NOT EXISTS vardelista_kopia (
	nyckel TEXT PRIMARY KEY,
	data TEXT NOT NULL,
	hamtad TEXT NOT NULL
);

-- Inbäddning som fallerat för en enskild lämning (src/semantic/embed.ts): en
-- text som modellen avvisar ska inte blockera resten. Efter tre försök med
-- samma radhash hoppas lämningen över (loggat) tills raden ändras.
CREATE TABLE IF NOT EXISTS inbaddning_fel (
	uuid TEXT PRIMARY KEY,
	rad_hash TEXT NOT NULL,
	forsok INTEGER NOT NULL DEFAULT 0,
	senaste_fel TEXT,
	andrad TEXT NOT NULL
) WITHOUT ROWID;

-- Omräkning (genererad av fullRecomputeSql({ baraSaknade: true }) i src/store/omraden.ts).
-- Räknar bara områden som saknar rader: en avbruten körning kan köras om och
-- fortsätter där den slutade.

INSERT INTO niva_sammanfattning (niva, med_omrade, inaktuell)
SELECT niva, n, 0 FROM (SELECT 'socken' AS niva, count(*) AS n FROM (SELECT lamning_id FROM lamning_omrade INDEXED BY idx_lamning_omrade_lamning
WHERE omrade_id IN (SELECT id FROM omrade WHERE niva = 'socken') GROUP BY lamning_id)) WHERE NOT EXISTS (SELECT 1 FROM niva_sammanfattning WHERE niva = 'socken')
ON CONFLICT(niva) DO UPDATE SET med_omrade = excluded.med_omrade, inaktuell = 0;

INSERT INTO omrade_sammanfattning (omrade_id, antal, med_lage, lat, lon, min_lat, min_lon, max_lat, max_lon, inaktuell)
SELECT o.id, count(lo.lamning_id), count(l.lat), avg(l.lat), avg(l.lon), min(l.lat), min(l.lon), max(l.lat), max(l.lon), 0
FROM omrade o LEFT JOIN lamning_omrade lo ON lo.omrade_id = o.id LEFT JOIN lamning l ON l.id = lo.lamning_id
WHERE o.niva = 'socken' AND o.id % 4 = 0 AND NOT EXISTS (SELECT 1 FROM omrade_sammanfattning s0 WHERE s0.omrade_id = o.id)
GROUP BY o.id
ON CONFLICT(omrade_id) DO UPDATE SET antal = excluded.antal, med_lage = excluded.med_lage, lat = excluded.lat, lon = excluded.lon,
min_lat = excluded.min_lat, min_lon = excluded.min_lon, max_lat = excluded.max_lat, max_lon = excluded.max_lon, inaktuell = 0;

INSERT INTO omrade_relation (omrade_id, overordnad_id, antal)
SELECT lo.omrade_id, lo2.omrade_id, count(*)
FROM omrade o JOIN lamning_omrade lo ON lo.omrade_id = o.id
JOIN lamning_omrade lo2 ON lo2.lamning_id = lo.lamning_id
JOIN omrade o2 ON o2.id = lo2.omrade_id
WHERE o.niva = 'socken' AND o.id % 4 = 0 AND NOT EXISTS (SELECT 1 FROM omrade_relation r0 WHERE r0.omrade_id = o.id) AND o2.niva IN ('kommun', 'lan')
GROUP BY lo.omrade_id, lo2.omrade_id;

INSERT INTO omrade_sammanfattning (omrade_id, antal, med_lage, lat, lon, min_lat, min_lon, max_lat, max_lon, inaktuell)
SELECT o.id, count(lo.lamning_id), count(l.lat), avg(l.lat), avg(l.lon), min(l.lat), min(l.lon), max(l.lat), max(l.lon), 0
FROM omrade o LEFT JOIN lamning_omrade lo ON lo.omrade_id = o.id LEFT JOIN lamning l ON l.id = lo.lamning_id
WHERE o.niva = 'socken' AND o.id % 4 = 1 AND NOT EXISTS (SELECT 1 FROM omrade_sammanfattning s0 WHERE s0.omrade_id = o.id)
GROUP BY o.id
ON CONFLICT(omrade_id) DO UPDATE SET antal = excluded.antal, med_lage = excluded.med_lage, lat = excluded.lat, lon = excluded.lon,
min_lat = excluded.min_lat, min_lon = excluded.min_lon, max_lat = excluded.max_lat, max_lon = excluded.max_lon, inaktuell = 0;

INSERT INTO omrade_relation (omrade_id, overordnad_id, antal)
SELECT lo.omrade_id, lo2.omrade_id, count(*)
FROM omrade o JOIN lamning_omrade lo ON lo.omrade_id = o.id
JOIN lamning_omrade lo2 ON lo2.lamning_id = lo.lamning_id
JOIN omrade o2 ON o2.id = lo2.omrade_id
WHERE o.niva = 'socken' AND o.id % 4 = 1 AND NOT EXISTS (SELECT 1 FROM omrade_relation r0 WHERE r0.omrade_id = o.id) AND o2.niva IN ('kommun', 'lan')
GROUP BY lo.omrade_id, lo2.omrade_id;

INSERT INTO omrade_sammanfattning (omrade_id, antal, med_lage, lat, lon, min_lat, min_lon, max_lat, max_lon, inaktuell)
SELECT o.id, count(lo.lamning_id), count(l.lat), avg(l.lat), avg(l.lon), min(l.lat), min(l.lon), max(l.lat), max(l.lon), 0
FROM omrade o LEFT JOIN lamning_omrade lo ON lo.omrade_id = o.id LEFT JOIN lamning l ON l.id = lo.lamning_id
WHERE o.niva = 'socken' AND o.id % 4 = 2 AND NOT EXISTS (SELECT 1 FROM omrade_sammanfattning s0 WHERE s0.omrade_id = o.id)
GROUP BY o.id
ON CONFLICT(omrade_id) DO UPDATE SET antal = excluded.antal, med_lage = excluded.med_lage, lat = excluded.lat, lon = excluded.lon,
min_lat = excluded.min_lat, min_lon = excluded.min_lon, max_lat = excluded.max_lat, max_lon = excluded.max_lon, inaktuell = 0;

INSERT INTO omrade_relation (omrade_id, overordnad_id, antal)
SELECT lo.omrade_id, lo2.omrade_id, count(*)
FROM omrade o JOIN lamning_omrade lo ON lo.omrade_id = o.id
JOIN lamning_omrade lo2 ON lo2.lamning_id = lo.lamning_id
JOIN omrade o2 ON o2.id = lo2.omrade_id
WHERE o.niva = 'socken' AND o.id % 4 = 2 AND NOT EXISTS (SELECT 1 FROM omrade_relation r0 WHERE r0.omrade_id = o.id) AND o2.niva IN ('kommun', 'lan')
GROUP BY lo.omrade_id, lo2.omrade_id;

INSERT INTO omrade_sammanfattning (omrade_id, antal, med_lage, lat, lon, min_lat, min_lon, max_lat, max_lon, inaktuell)
SELECT o.id, count(lo.lamning_id), count(l.lat), avg(l.lat), avg(l.lon), min(l.lat), min(l.lon), max(l.lat), max(l.lon), 0
FROM omrade o LEFT JOIN lamning_omrade lo ON lo.omrade_id = o.id LEFT JOIN lamning l ON l.id = lo.lamning_id
WHERE o.niva = 'socken' AND o.id % 4 = 3 AND NOT EXISTS (SELECT 1 FROM omrade_sammanfattning s0 WHERE s0.omrade_id = o.id)
GROUP BY o.id
ON CONFLICT(omrade_id) DO UPDATE SET antal = excluded.antal, med_lage = excluded.med_lage, lat = excluded.lat, lon = excluded.lon,
min_lat = excluded.min_lat, min_lon = excluded.min_lon, max_lat = excluded.max_lat, max_lon = excluded.max_lon, inaktuell = 0;

INSERT INTO omrade_relation (omrade_id, overordnad_id, antal)
SELECT lo.omrade_id, lo2.omrade_id, count(*)
FROM omrade o JOIN lamning_omrade lo ON lo.omrade_id = o.id
JOIN lamning_omrade lo2 ON lo2.lamning_id = lo.lamning_id
JOIN omrade o2 ON o2.id = lo2.omrade_id
WHERE o.niva = 'socken' AND o.id % 4 = 3 AND NOT EXISTS (SELECT 1 FROM omrade_relation r0 WHERE r0.omrade_id = o.id) AND o2.niva IN ('kommun', 'lan')
GROUP BY lo.omrade_id, lo2.omrade_id;

INSERT INTO niva_sammanfattning (niva, med_omrade, inaktuell)
SELECT niva, n, 0 FROM (SELECT 'kommun' AS niva, count(*) AS n FROM (SELECT lamning_id FROM lamning_omrade INDEXED BY idx_lamning_omrade_lamning
WHERE omrade_id IN (SELECT id FROM omrade WHERE niva = 'kommun') GROUP BY lamning_id)) WHERE NOT EXISTS (SELECT 1 FROM niva_sammanfattning WHERE niva = 'kommun')
ON CONFLICT(niva) DO UPDATE SET med_omrade = excluded.med_omrade, inaktuell = 0;

INSERT INTO omrade_sammanfattning (omrade_id, antal, med_lage, lat, lon, min_lat, min_lon, max_lat, max_lon, inaktuell)
SELECT o.id, count(lo.lamning_id), count(l.lat), avg(l.lat), avg(l.lon), min(l.lat), min(l.lon), max(l.lat), max(l.lon), 0
FROM omrade o LEFT JOIN lamning_omrade lo ON lo.omrade_id = o.id LEFT JOIN lamning l ON l.id = lo.lamning_id
WHERE o.niva = 'kommun' AND o.id % 4 = 0 AND NOT EXISTS (SELECT 1 FROM omrade_sammanfattning s0 WHERE s0.omrade_id = o.id)
GROUP BY o.id
ON CONFLICT(omrade_id) DO UPDATE SET antal = excluded.antal, med_lage = excluded.med_lage, lat = excluded.lat, lon = excluded.lon,
min_lat = excluded.min_lat, min_lon = excluded.min_lon, max_lat = excluded.max_lat, max_lon = excluded.max_lon, inaktuell = 0;

INSERT INTO omrade_relation (omrade_id, overordnad_id, antal)
SELECT lo.omrade_id, lo2.omrade_id, count(*)
FROM omrade o JOIN lamning_omrade lo ON lo.omrade_id = o.id
JOIN lamning_omrade lo2 ON lo2.lamning_id = lo.lamning_id
JOIN omrade o2 ON o2.id = lo2.omrade_id
WHERE o.niva = 'kommun' AND o.id % 4 = 0 AND NOT EXISTS (SELECT 1 FROM omrade_relation r0 WHERE r0.omrade_id = o.id) AND o2.niva IN ('lan')
GROUP BY lo.omrade_id, lo2.omrade_id;

INSERT INTO omrade_sammanfattning (omrade_id, antal, med_lage, lat, lon, min_lat, min_lon, max_lat, max_lon, inaktuell)
SELECT o.id, count(lo.lamning_id), count(l.lat), avg(l.lat), avg(l.lon), min(l.lat), min(l.lon), max(l.lat), max(l.lon), 0
FROM omrade o LEFT JOIN lamning_omrade lo ON lo.omrade_id = o.id LEFT JOIN lamning l ON l.id = lo.lamning_id
WHERE o.niva = 'kommun' AND o.id % 4 = 1 AND NOT EXISTS (SELECT 1 FROM omrade_sammanfattning s0 WHERE s0.omrade_id = o.id)
GROUP BY o.id
ON CONFLICT(omrade_id) DO UPDATE SET antal = excluded.antal, med_lage = excluded.med_lage, lat = excluded.lat, lon = excluded.lon,
min_lat = excluded.min_lat, min_lon = excluded.min_lon, max_lat = excluded.max_lat, max_lon = excluded.max_lon, inaktuell = 0;

INSERT INTO omrade_relation (omrade_id, overordnad_id, antal)
SELECT lo.omrade_id, lo2.omrade_id, count(*)
FROM omrade o JOIN lamning_omrade lo ON lo.omrade_id = o.id
JOIN lamning_omrade lo2 ON lo2.lamning_id = lo.lamning_id
JOIN omrade o2 ON o2.id = lo2.omrade_id
WHERE o.niva = 'kommun' AND o.id % 4 = 1 AND NOT EXISTS (SELECT 1 FROM omrade_relation r0 WHERE r0.omrade_id = o.id) AND o2.niva IN ('lan')
GROUP BY lo.omrade_id, lo2.omrade_id;

INSERT INTO omrade_sammanfattning (omrade_id, antal, med_lage, lat, lon, min_lat, min_lon, max_lat, max_lon, inaktuell)
SELECT o.id, count(lo.lamning_id), count(l.lat), avg(l.lat), avg(l.lon), min(l.lat), min(l.lon), max(l.lat), max(l.lon), 0
FROM omrade o LEFT JOIN lamning_omrade lo ON lo.omrade_id = o.id LEFT JOIN lamning l ON l.id = lo.lamning_id
WHERE o.niva = 'kommun' AND o.id % 4 = 2 AND NOT EXISTS (SELECT 1 FROM omrade_sammanfattning s0 WHERE s0.omrade_id = o.id)
GROUP BY o.id
ON CONFLICT(omrade_id) DO UPDATE SET antal = excluded.antal, med_lage = excluded.med_lage, lat = excluded.lat, lon = excluded.lon,
min_lat = excluded.min_lat, min_lon = excluded.min_lon, max_lat = excluded.max_lat, max_lon = excluded.max_lon, inaktuell = 0;

INSERT INTO omrade_relation (omrade_id, overordnad_id, antal)
SELECT lo.omrade_id, lo2.omrade_id, count(*)
FROM omrade o JOIN lamning_omrade lo ON lo.omrade_id = o.id
JOIN lamning_omrade lo2 ON lo2.lamning_id = lo.lamning_id
JOIN omrade o2 ON o2.id = lo2.omrade_id
WHERE o.niva = 'kommun' AND o.id % 4 = 2 AND NOT EXISTS (SELECT 1 FROM omrade_relation r0 WHERE r0.omrade_id = o.id) AND o2.niva IN ('lan')
GROUP BY lo.omrade_id, lo2.omrade_id;

INSERT INTO omrade_sammanfattning (omrade_id, antal, med_lage, lat, lon, min_lat, min_lon, max_lat, max_lon, inaktuell)
SELECT o.id, count(lo.lamning_id), count(l.lat), avg(l.lat), avg(l.lon), min(l.lat), min(l.lon), max(l.lat), max(l.lon), 0
FROM omrade o LEFT JOIN lamning_omrade lo ON lo.omrade_id = o.id LEFT JOIN lamning l ON l.id = lo.lamning_id
WHERE o.niva = 'kommun' AND o.id % 4 = 3 AND NOT EXISTS (SELECT 1 FROM omrade_sammanfattning s0 WHERE s0.omrade_id = o.id)
GROUP BY o.id
ON CONFLICT(omrade_id) DO UPDATE SET antal = excluded.antal, med_lage = excluded.med_lage, lat = excluded.lat, lon = excluded.lon,
min_lat = excluded.min_lat, min_lon = excluded.min_lon, max_lat = excluded.max_lat, max_lon = excluded.max_lon, inaktuell = 0;

INSERT INTO omrade_relation (omrade_id, overordnad_id, antal)
SELECT lo.omrade_id, lo2.omrade_id, count(*)
FROM omrade o JOIN lamning_omrade lo ON lo.omrade_id = o.id
JOIN lamning_omrade lo2 ON lo2.lamning_id = lo.lamning_id
JOIN omrade o2 ON o2.id = lo2.omrade_id
WHERE o.niva = 'kommun' AND o.id % 4 = 3 AND NOT EXISTS (SELECT 1 FROM omrade_relation r0 WHERE r0.omrade_id = o.id) AND o2.niva IN ('lan')
GROUP BY lo.omrade_id, lo2.omrade_id;

INSERT INTO niva_sammanfattning (niva, med_omrade, inaktuell)
SELECT niva, n, 0 FROM (SELECT 'lan' AS niva, count(*) AS n FROM (SELECT lamning_id FROM lamning_omrade INDEXED BY idx_lamning_omrade_lamning
WHERE omrade_id IN (SELECT id FROM omrade WHERE niva = 'lan') GROUP BY lamning_id)) WHERE NOT EXISTS (SELECT 1 FROM niva_sammanfattning WHERE niva = 'lan')
ON CONFLICT(niva) DO UPDATE SET med_omrade = excluded.med_omrade, inaktuell = 0;

INSERT INTO omrade_sammanfattning (omrade_id, antal, med_lage, lat, lon, min_lat, min_lon, max_lat, max_lon, inaktuell)
SELECT o.id, count(lo.lamning_id), count(l.lat), avg(l.lat), avg(l.lon), min(l.lat), min(l.lon), max(l.lat), max(l.lon), 0
FROM omrade o LEFT JOIN lamning_omrade lo ON lo.omrade_id = o.id LEFT JOIN lamning l ON l.id = lo.lamning_id
WHERE o.niva = 'lan' AND o.id % 4 = 0 AND NOT EXISTS (SELECT 1 FROM omrade_sammanfattning s0 WHERE s0.omrade_id = o.id)
GROUP BY o.id
ON CONFLICT(omrade_id) DO UPDATE SET antal = excluded.antal, med_lage = excluded.med_lage, lat = excluded.lat, lon = excluded.lon,
min_lat = excluded.min_lat, min_lon = excluded.min_lon, max_lat = excluded.max_lat, max_lon = excluded.max_lon, inaktuell = 0;

INSERT INTO omrade_sammanfattning (omrade_id, antal, med_lage, lat, lon, min_lat, min_lon, max_lat, max_lon, inaktuell)
SELECT o.id, count(lo.lamning_id), count(l.lat), avg(l.lat), avg(l.lon), min(l.lat), min(l.lon), max(l.lat), max(l.lon), 0
FROM omrade o LEFT JOIN lamning_omrade lo ON lo.omrade_id = o.id LEFT JOIN lamning l ON l.id = lo.lamning_id
WHERE o.niva = 'lan' AND o.id % 4 = 1 AND NOT EXISTS (SELECT 1 FROM omrade_sammanfattning s0 WHERE s0.omrade_id = o.id)
GROUP BY o.id
ON CONFLICT(omrade_id) DO UPDATE SET antal = excluded.antal, med_lage = excluded.med_lage, lat = excluded.lat, lon = excluded.lon,
min_lat = excluded.min_lat, min_lon = excluded.min_lon, max_lat = excluded.max_lat, max_lon = excluded.max_lon, inaktuell = 0;

INSERT INTO omrade_sammanfattning (omrade_id, antal, med_lage, lat, lon, min_lat, min_lon, max_lat, max_lon, inaktuell)
SELECT o.id, count(lo.lamning_id), count(l.lat), avg(l.lat), avg(l.lon), min(l.lat), min(l.lon), max(l.lat), max(l.lon), 0
FROM omrade o LEFT JOIN lamning_omrade lo ON lo.omrade_id = o.id LEFT JOIN lamning l ON l.id = lo.lamning_id
WHERE o.niva = 'lan' AND o.id % 4 = 2 AND NOT EXISTS (SELECT 1 FROM omrade_sammanfattning s0 WHERE s0.omrade_id = o.id)
GROUP BY o.id
ON CONFLICT(omrade_id) DO UPDATE SET antal = excluded.antal, med_lage = excluded.med_lage, lat = excluded.lat, lon = excluded.lon,
min_lat = excluded.min_lat, min_lon = excluded.min_lon, max_lat = excluded.max_lat, max_lon = excluded.max_lon, inaktuell = 0;

INSERT INTO omrade_sammanfattning (omrade_id, antal, med_lage, lat, lon, min_lat, min_lon, max_lat, max_lon, inaktuell)
SELECT o.id, count(lo.lamning_id), count(l.lat), avg(l.lat), avg(l.lon), min(l.lat), min(l.lon), max(l.lat), max(l.lon), 0
FROM omrade o LEFT JOIN lamning_omrade lo ON lo.omrade_id = o.id LEFT JOIN lamning l ON l.id = lo.lamning_id
WHERE o.niva = 'lan' AND o.id % 4 = 3 AND NOT EXISTS (SELECT 1 FROM omrade_sammanfattning s0 WHERE s0.omrade_id = o.id)
GROUP BY o.id
ON CONFLICT(omrade_id) DO UPDATE SET antal = excluded.antal, med_lage = excluded.med_lage, lat = excluded.lat, lon = excluded.lon,
min_lat = excluded.min_lat, min_lon = excluded.min_lon, max_lat = excluded.max_lat, max_lon = excluded.max_lon, inaktuell = 0;

INSERT INTO niva_sammanfattning (niva, med_omrade, inaktuell)
SELECT niva, n, 0 FROM (SELECT 'landskap' AS niva, count(*) AS n FROM (SELECT lamning_id FROM lamning_omrade INDEXED BY idx_lamning_omrade_lamning
WHERE omrade_id IN (SELECT id FROM omrade WHERE niva = 'landskap') GROUP BY lamning_id)) WHERE NOT EXISTS (SELECT 1 FROM niva_sammanfattning WHERE niva = 'landskap')
ON CONFLICT(niva) DO UPDATE SET med_omrade = excluded.med_omrade, inaktuell = 0;

INSERT INTO omrade_sammanfattning (omrade_id, antal, med_lage, lat, lon, min_lat, min_lon, max_lat, max_lon, inaktuell)
SELECT o.id, count(lo.lamning_id), count(l.lat), avg(l.lat), avg(l.lon), min(l.lat), min(l.lon), max(l.lat), max(l.lon), 0
FROM omrade o LEFT JOIN lamning_omrade lo ON lo.omrade_id = o.id LEFT JOIN lamning l ON l.id = lo.lamning_id
WHERE o.niva = 'landskap' AND o.id % 4 = 0 AND NOT EXISTS (SELECT 1 FROM omrade_sammanfattning s0 WHERE s0.omrade_id = o.id)
GROUP BY o.id
ON CONFLICT(omrade_id) DO UPDATE SET antal = excluded.antal, med_lage = excluded.med_lage, lat = excluded.lat, lon = excluded.lon,
min_lat = excluded.min_lat, min_lon = excluded.min_lon, max_lat = excluded.max_lat, max_lon = excluded.max_lon, inaktuell = 0;

INSERT INTO omrade_sammanfattning (omrade_id, antal, med_lage, lat, lon, min_lat, min_lon, max_lat, max_lon, inaktuell)
SELECT o.id, count(lo.lamning_id), count(l.lat), avg(l.lat), avg(l.lon), min(l.lat), min(l.lon), max(l.lat), max(l.lon), 0
FROM omrade o LEFT JOIN lamning_omrade lo ON lo.omrade_id = o.id LEFT JOIN lamning l ON l.id = lo.lamning_id
WHERE o.niva = 'landskap' AND o.id % 4 = 1 AND NOT EXISTS (SELECT 1 FROM omrade_sammanfattning s0 WHERE s0.omrade_id = o.id)
GROUP BY o.id
ON CONFLICT(omrade_id) DO UPDATE SET antal = excluded.antal, med_lage = excluded.med_lage, lat = excluded.lat, lon = excluded.lon,
min_lat = excluded.min_lat, min_lon = excluded.min_lon, max_lat = excluded.max_lat, max_lon = excluded.max_lon, inaktuell = 0;

INSERT INTO omrade_sammanfattning (omrade_id, antal, med_lage, lat, lon, min_lat, min_lon, max_lat, max_lon, inaktuell)
SELECT o.id, count(lo.lamning_id), count(l.lat), avg(l.lat), avg(l.lon), min(l.lat), min(l.lon), max(l.lat), max(l.lon), 0
FROM omrade o LEFT JOIN lamning_omrade lo ON lo.omrade_id = o.id LEFT JOIN lamning l ON l.id = lo.lamning_id
WHERE o.niva = 'landskap' AND o.id % 4 = 2 AND NOT EXISTS (SELECT 1 FROM omrade_sammanfattning s0 WHERE s0.omrade_id = o.id)
GROUP BY o.id
ON CONFLICT(omrade_id) DO UPDATE SET antal = excluded.antal, med_lage = excluded.med_lage, lat = excluded.lat, lon = excluded.lon,
min_lat = excluded.min_lat, min_lon = excluded.min_lon, max_lat = excluded.max_lat, max_lon = excluded.max_lon, inaktuell = 0;

INSERT INTO omrade_sammanfattning (omrade_id, antal, med_lage, lat, lon, min_lat, min_lon, max_lat, max_lon, inaktuell)
SELECT o.id, count(lo.lamning_id), count(l.lat), avg(l.lat), avg(l.lon), min(l.lat), min(l.lon), max(l.lat), max(l.lon), 0
FROM omrade o LEFT JOIN lamning_omrade lo ON lo.omrade_id = o.id LEFT JOIN lamning l ON l.id = lo.lamning_id
WHERE o.niva = 'landskap' AND o.id % 4 = 3 AND NOT EXISTS (SELECT 1 FROM omrade_sammanfattning s0 WHERE s0.omrade_id = o.id)
GROUP BY o.id
ON CONFLICT(omrade_id) DO UPDATE SET antal = excluded.antal, med_lage = excluded.med_lage, lat = excluded.lat, lon = excluded.lon,
min_lat = excluded.min_lat, min_lon = excluded.min_lon, max_lat = excluded.max_lat, max_lon = excluded.max_lon, inaktuell = 0;
