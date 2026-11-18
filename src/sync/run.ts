/**
 * Nattsynken (SPEC 5.3, 8): ändringsflödet → Fornsök-appen (reserv K-samsök)
 * → D1. Tänkt för en Cron-körning efter 04:30 svensk tid, men kan köras när
 * som helst: den gör bara det som återstår.
 *
 * En körning:
 * 1. Läser läget i `synk_status`: `senast_synkat` (sista dag som är helt
 *    synkad) och `synk_intervall` (ett påbörjat intervall).
 * 2. Finns inget påbörjat intervall: hämtar ändringsflödet (alla sidor) för
 *    dagarna efter `senast_synkat` till och med senaste kompletta dag (högst
 *    `maxDagar` åt gången) och lägger varje lämning i kön `synk_ko`.
 * 3. Bearbetar högst `maxPoster` lämningar ur kön, EN I TAGET med `pausMs`
 *    paus mellan anropen till appen: hämtar posten, bygger raderna och skriver
 *    dem i en D1-batch tillsammans med borttagningen ur kön och markeringen för
 *    ny inbäddning. `UTGAR` tar bort lämningen.
 * 4. Är kön tom (utom poster som väntar på nytt försök): `senast_synkat` sätts
 *    till intervallets sista dag.
 * 5. Skriver en rad i `synk`.
 *
 * Återupptagbar och idempotent: varje lämning tas ur kön i samma transaktion
 * som den skrivs, och att skriva samma post igen ger samma rader.
 *
 * Grundladdning/avstämning (ingest/): när `synk_status.uttagsdatum` ändras
 * (ny GeoPackage-fil inläst) flyttas markören tillbaka till två dagar före
 * uttagsdatum, så att ändringar som filen kanske inte hann få med skrivs igen.
 * En avstämning med en äldre fil kan alltså inte ta bort nyare synkade
 * ändringar för gott.
 */
import { KvDomainSource, type KvLike } from "../cache/kv";
import { FORNSOK_APP_API, userAgent } from "../config";
import { UpstreamError } from "../errors";
import { wgsToSweref } from "../geo/geometry";
import { checkedScope, inScope, type Scope } from "../semantic/scope";
import { FornsokAppSource } from "../sources/fornsokapp/source";
import { KsamsokSource } from "../sources/ksamsok/source";
import type { Domaner } from "../sources/types";
import { KOPIA_NYCKEL, sparaKopiaSats } from "../lookup/index_domaner";
import type { D1Like, D1LikeStatement } from "../store/d1";
import { refreshInaktuella } from "../store/omraden";
import { type FetchLike, UpstreamClient } from "../upstream/client";
import { arDatum, dagarMellan, laggTillDagar, senasteKlaraDag, stockholmNu } from "./datum";
import { FLODE_MAX_SIDOR, FLODE_MAX_STORLEK, FLODE_SIDSTORLEK, ForMangaSidorError, hamtaFlode } from "./flode";
import { OmradesRegister } from "./omraden";
import {
	appTillPost,
	type ByggdPost,
	ksamsokTillPost,
	RESERV_HASH_PREFIX,
	splitList,
} from "./post";
import { tillRad } from "./rad";
import { skrivSatser, taBortSatser } from "./skriv";

/** Det runSync behöver ur Workerns miljö. */
export interface SyncEnv {
	DB?: D1Like;
	CACHE?: KvLike;
	CONTACT_URL?: string;
	SEMANTIC_LAN?: string;
}

export interface SyncOptions {
	/** Nu (för test). */
	now?: Date;
	/** fetch (för test). */
	fetch?: FetchLike;
	/** Högst så många lämningar per körning (standard 200). */
	maxPoster?: number;
	/** Paus mellan anropen till RAÄ i ms (standard 500). */
	pausMs?: number;
	/** Sidstorlek i ändringsflödet (standard 500). */
	sidstorlek?: number;
	/** Högst så många dagar ur flödet åt gången (standard 31). */
	maxDagar?: number;
	/** Försök per lämning innan den lämnas åt avstämningen (standard 5). */
	maxForsok?: number;
	/** Körningen avslutar efter så här lång tid (ms, standard 10 min; Cron får 15). */
	maxTidMs?: number;
	/** Väntan (för test). */
	sleep?: (ms: number) => Promise<void>;
	/** Avbryt efter så här många skrivna lämningar (för test av återupptag). */
	avbrytEfter?: number;
}

export interface SyncResult {
	status: "klar" | "pagaende" | "inget_nytt" | "fel";
	fran: string | null;
	till: string | null;
	senast_synkat: string | null;
	nya: number;
	andrade: number;
	oforandrade: number;
	borttagna: number;
	/** Skrivna från K-samsök (appen svarade inte). */
	reserv: number;
	/** Kvar i kön efter körningen. */
	kvar: number;
	/** Lämningar markerade för ny inbäddning. */
	markerade: number;
	/** Områden vars sammanfattning räknades om (src/store/omraden.ts). */
	omraden?: { omraknade: number; kvar: number };
	fel: string[];
}

export const STATUS_SENAST = "senast_synkat";
/** Nattsynken förnyar kopian av appens värdelistor när den är äldre än så här. */
export const KOPIA_SYNK_ALDER_MS = 20 * 60 * 60 * 1000;
export const STATUS_INTERVALL = "synk_intervall";
export const STATUS_UTTAG_SETT = "synk_uttagsdatum_sett";

type Row = Record<string, unknown>;

interface KoRad {
	uuid: string;
	typer: string;
	utgar: number;
	status: string;
	forsok: number;
	andrad: string;
}

/** Så många poster i rad som fallerar på infrastrukturfel i början av en körning avbryter den (strömbrytare). */
export const STROMBRYTARE_POSTER = 5;

/** Infrastrukturfel (5xx, 429, tidsgräns, nätverk) – inte fel på posten. Förbrukar inga försök. */
function arInfrafel(e: unknown): boolean {
	if (!(e instanceof UpstreamError)) return false;
	return e.status === undefined || e.status === 429 || e.status >= 500;
}

const sleepReal = (ms: number) =>
	ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();

async function rows<T = Row>(db: D1Like, sql: string, ...params: unknown[]): Promise<T[]> {
	const s = db.prepare(sql);
	return ((await (params.length ? s.bind(...params) : s).all<T>()).results ?? []) as T[];
}

function statusSats(
	db: D1Like,
	nyckel: string,
	varde: string | null,
	tid: string,
): D1LikeStatement {
	return db
		.prepare(
			"INSERT INTO synk_status (nyckel, varde, andrad) VALUES (?, ?, ?) ON CONFLICT(nyckel) DO UPDATE SET varde = excluded.varde, andrad = excluded.andrad",
		)
		.bind(nyckel, varde, tid);
}

/**
 * Ogiltigt omfång: synken skriver utan att markera för inbäddning. Då tas
 * inbäddningens klar-markering bort (src/semantic/embed.ts), så att nästa
 * inbäddning med rättat omfång går igenom omfånget och hittar det som ändrats
 * eller tagits bort under tiden (radhashen skiljer sig, vektorer utan lämning).
 */
function ogiltigforklaraInbaddning(db: D1Like): D1LikeStatement {
	return db.prepare("DELETE FROM synk_status WHERE nyckel = 'inbaddning_klar'");
}

/** Markera för ny inbäddning om lämningen ligger inom omfånget eller redan är inbäddad. */
function markeraSats(
	db: D1Like,
	uuid: string,
	orsak: string,
	iOmfang: boolean,
	tid: string,
): D1LikeStatement {
	return db
		.prepare(
			"INSERT INTO inbaddning_ko (uuid, orsak, lagd) SELECT ?, ?, ? WHERE ? = 1 OR EXISTS (SELECT 1 FROM inbaddning WHERE uuid = ?) ON CONFLICT(uuid) DO UPDATE SET orsak = excluded.orsak, lagd = excluded.lagd",
		)
		.bind(uuid, orsak, tid, iOmfang ? 1 : 0, uuid);
}

export async function runSync(env: SyncEnv, opts: SyncOptions = {}): Promise<SyncResult> {
	const db = env.DB;
	if (!db) throw new Error("runSync: bindningen DB saknas");
	const now = opts.now ?? new Date();
	const startad = now.toISOString();
	const t0 = Date.now();
	const sleep = opts.sleep ?? sleepReal;
	const pausMs = opts.pausMs ?? 500;
	const maxPoster = Math.max(1, opts.maxPoster ?? 200);
	const maxDagar = Math.max(1, opts.maxDagar ?? 31);
	const maxForsok = Math.max(1, opts.maxForsok ?? 5);
	const maxTidMs = opts.maxTidMs ?? 10 * 60 * 1000;
	const idag = stockholmNu(now).datum;
	// Ogiltigt omfång: synken skriver lämningarna men markerar inget för inbäddning
	// (inbäddningen gör ändå ingenting förrän SEMANTIC_LAN är rättat).
	let scope: Scope | null = null;
	let omfangFel: string | null = null;
	try {
		scope = checkedScope(env.SEMANTIC_LAN);
	} catch (e) {
		omfangFel = e instanceof Error ? e.message : String(e);
		console.error(`synk: ${omfangFel}`);
	}

	const client = new UpstreamClient({
		userAgent: userAgent(env.CONTACT_URL),
		...(opts.fetch ? { fetch: opts.fetch } : {}),
		maxConcurrent: 1,
	});
	const app = new FornsokAppSource(client);
	const ksamsok = new KsamsokSource(client);
	let register: OmradesRegister | null = null;
	const domaner = new KvDomainSource(app, env.CACHE);
	let kopiaSparad = false;
	const getRegister = async (): Promise<OmradesRegister> => {
		if (!register) {
			const d: Domaner = await domaner.loadDomaner();
			register = new OmradesRegister(d);
			// Spara listorna i D1, så att namnuppslaget klarar sig när appen är nere.
			try {
				await db.batch([sparaKopiaSats(db, d)]);
				kopiaSparad = true;
			} catch (e) {
				console.warn("synk: värdelistorna kunde inte sparas i D1:", e instanceof Error ? e.message : String(e));
			}
		}
		return register;
	};

	const res: SyncResult = {
		status: "inget_nytt",
		fran: null,
		till: null,
		senast_synkat: null,
		nya: 0,
		andrade: 0,
		oforandrade: 0,
		borttagna: 0,
		reserv: 0,
		kvar: 0,
		markerade: 0,
		fel: [],
	};

	if (omfangFel) res.fel.push(`${omfangFel} Inga lämningar markerades för inbäddning.`);
	try {
		// ------------------------------------------------ 1. läget
		const status = new Map<string, string | null>();
		for (const r of await rows<{ nyckel: string; varde: string | null }>(
			db,
			"SELECT nyckel, varde FROM synk_status WHERE nyckel IN (?, ?, ?, 'uttagsdatum')",
			STATUS_SENAST,
			STATUS_INTERVALL,
			STATUS_UTTAG_SETT,
		))
			status.set(r.nyckel, r.varde);
		const senaste = senasteKlaraDag(now);
		let markor = arDatum(status.get(STATUS_SENAST))
			? (status.get(STATUS_SENAST) as string)
			: null;
		const uttag = arDatum(status.get("uttagsdatum"))
			? (status.get("uttagsdatum") as string)
			: null;
		let intervall: { fran: string; till: string; uttag: string | null } | null = null;
		try {
			const v = status.get(STATUS_INTERVALL);
			const p = v
				? (JSON.parse(v) as { fran?: unknown; till?: unknown; uttag?: unknown })
				: null;
			if (p && arDatum(p.fran) && arDatum(p.till))
				intervall = {
					fran: p.fran,
					till: p.till,
					uttag: arDatum(p.uttag) ? p.uttag : null,
				};
		} catch {
			intervall = null;
		}

		// ------------------------------------------------ 2. nytt intervall
		if (!intervall) {
			let uttagAttSatta: string | null = null;
			if (uttag && uttag !== status.get(STATUS_UTTAG_SETT)) {
				// Ny GeoPackage-laddning: synka om från två dagar före uttagsdatum (marginal för
				// ändringar som filen kanske inte hann få med).
				const tillbaka = laggTillDagar(uttag, -2);
				if (!markor || tillbaka < markor) markor = tillbaka;
				uttagAttSatta = uttag;
			}
			if (!markor) markor = laggTillDagar(senaste, -1);
			const fran = laggTillDagar(markor, 1);
			let till = senaste;
			if (dagarMellan(fran, till) + 1 > maxDagar) till = laggTillDagar(fran, maxDagar - 1);
			if (fran <= till) {
				// En mycket stor ändringsdag (fler sidor än FLODE_MAX_SIDOR): först en dag i
				// taget, sedan större sidor (högst FLODE_MAX_STORLEK), i stället för att fastna.
				let storlek = opts.sidstorlek ?? FLODE_SIDSTORLEK;
				let flode: Awaited<ReturnType<typeof hamtaFlode>> | null = null;
				while (!flode) {
					try {
						flode = await hamtaFlode(client, fran, till, { storlek, paus: () => sleep(pausMs) });
					} catch (e) {
						if (!(e instanceof ForMangaSidorError)) throw e;
						if (till > fran) {
							till = fran;
							continue;
						}
						const behov = e.totalElements ? Math.ceil(e.totalElements / FLODE_MAX_SIDOR) : storlek * Math.ceil(e.totalPages / FLODE_MAX_SIDOR);
						const ny = Math.min(FLODE_MAX_STORLEK, Math.max(storlek * 2, behov));
						if (ny <= storlek) throw e;
						storlek = ny;
					}
				}
				const tid = startad;
				const satser: D1LikeStatement[] = flode.poster.map((p) =>
					db
						.prepare(
							`INSERT INTO synk_ko (uuid, lamningsnummer, typer, utgar, datum, status, forsok, lagd, andrad) VALUES (?, ?, ?, ?, ?, 'vantar', 0, ?, ?)
							 ON CONFLICT(uuid) DO UPDATE SET lamningsnummer = excluded.lamningsnummer, typer = excluded.typer, utgar = excluded.utgar,
							 datum = excluded.datum, status = 'vantar', forsok = 0, senaste_fel = NULL, andrad = excluded.andrad`,
						)
						.bind(
							p.uuid,
							p.lamningsnummer,
							JSON.stringify(p.typer),
							p.utgar ? 1 : 0,
							till,
							tid,
							tid,
						),
				);
				for (let i = 0; i < satser.length; i += 50) await db.batch(satser.slice(i, i + 50));
				intervall = { fran, till, uttag: uttagAttSatta };
				await db.batch([statusSats(db, STATUS_INTERVALL, JSON.stringify(intervall), tid)]);
			}
		}
		res.fran = intervall?.fran ?? null;
		res.till = intervall?.till ?? null;

		// ------------------------------------------------ 3. kön
		const ko = await rows<KoRad>(
			db,
			`SELECT uuid, typer, utgar, status, forsok, andrad FROM synk_ko
			  WHERE status = 'vantar' OR substr(andrad, 1, 10) < ?
			  ORDER BY CASE status WHEN 'vantar' THEN 0 ELSE 1 END, datum, uuid LIMIT ?`,
			idag,
			maxPoster,
		);
		let skrivna = 0;
		let forstaAnrop = true;
		// Strömbrytare: fallerar de första posterna alla på infrastrukturfel är RAÄ nere;
		// då avbryts körningen i stället för att pröva hela kön.
		let infraIRad = 0;
		let natSvar = false;
		for (const k of ko) {
			if (!natSvar && infraIRad >= STROMBRYTARE_POSTER) {
				res.fel.push(`strömbrytare: de ${infraIRad} första posterna fallerade på infrastrukturfel (RAÄ svarar inte); avbryter och försöker nästa körning`);
				break;
			}
			if (Date.now() - t0 > maxTidMs) {
				res.fel.push("tidsgränsen nåddes; fortsätter nästa körning");
				break;
			}
			if (opts.avbrytEfter !== undefined && skrivna >= opts.avbrytEfter) break;
			const tid = startad;
			const taUr = db.prepare("DELETE FROM synk_ko WHERE uuid = ?").bind(k.uuid);

			if (k.utgar) {
				const fanns =
					(await rows(db, "SELECT 1 AS x FROM lamning WHERE uuid = ?", k.uuid)).length >
					0;
				await db.batch([
					...taBortSatser(db, k.uuid),
					scope ? markeraSats(db, k.uuid, "utgar", false, tid) : ogiltigforklaraInbaddning(db),
					taUr,
				]);
				if (fanns) res.borttagna++;
				skrivna++;
				continue;
			}

			// Värdelistorna behövs för indelningen; hämtas (via KV) före första posten.
			let reg: OmradesRegister;
			try {
				reg = await getRegister();
			} catch (e) {
				res.fel.push(
					`värdelistorna gick inte att hämta (${e instanceof Error ? e.message : String(e)}); fortsätter nästa körning`,
				);
				break;
			}
			if (!forstaAnrop) await sleep(pausMs);
			forstaAnrop = false;
			// Försök räknas per kalenderdag (fyra körningar per natt ska inte förbruka fyra),
			// och infrastrukturfel räknas inte alls (se misslyckat).
			const nyDag = k.forsok === 0 || !k.andrad || k.andrad.slice(0, 10) < idag;
			let forsok = k.forsok + (nyDag ? 1 : 0);
			const misslyckat = async (nyStatus: "vantar" | "saknas", fel: string, infra = false) => {
				if (infra) {
					infraIRad++;
					forsok = k.forsok;
				} else natSvar = true;
				if (forsok >= maxForsok) {
					res.fel.push(
						`${k.uuid}: ${fel}; gav upp efter ${forsok} försök (avstämningen rättar)`,
					);
					await db.batch([taUr]);
				} else {
					await db.batch([
						db
							.prepare(
								"UPDATE synk_ko SET status = ?, forsok = ?, senaste_fel = ?, andrad = ? WHERE uuid = ?",
							)
							.bind(nyStatus, forsok, fel, tid, k.uuid),
					]);
				}
			};

			let byggd: ByggdPost | null = null;
			let appFel: string | null = null;
			let appInfra = false;
			let app404 = false;
			try {
				const r = await client.get(`${FORNSOK_APP_API}/lamning/lamning/${k.uuid}`);
				if (r.status === 404) {
					app404 = true;
					appFel = "Fornsök-appen känner inte till lämningen (404)";
				} else if (r.status >= 400) {
					appFel = `Fornsök-appen svarade ${r.status}`;
					appInfra = r.status === 429 || r.status >= 500;
				} else {
					try {
						byggd = appTillPost(JSON.parse(r.body) as Record<string, unknown>, idag);
					} catch {
						appFel = "Fornsök-appen svarade inte med JSON";
					}
					if (!byggd && !appFel) appFel = "Fornsök-appens svar var ingen lämning";
				}
			} catch (e) {
				if (!(e instanceof UpstreamError)) throw e;
				appFel = e.message;
				appInfra = arInfrafel(e);
			}

			if (app404) {
				// Appen känner inte till posten, och flödet säger inte UTGAR. K-samsöks (äldre) post
				// skrivs inte – den kan vara en nyss borttagen lämning. Efter maxForsok dagar avgör
				// K-samsök: saknas posten där också tas den bort ur indexet (annars låg den kvar,
				// sökbar); finns den där lämnas den åt avstämningen.
				natSvar = true;
				if (forsok < maxForsok) {
					await misslyckat("saknas", appFel ?? "404");
					continue;
				}
				let ksFinns: boolean | null = null;
				try {
					ksFinns = (await ksamsok.getByUuid(k.uuid)) !== null;
				} catch (e) {
					if (!(e instanceof UpstreamError)) throw e;
				}
				if (ksFinns === null) {
					// K-samsök svarade inte: pröva igen nästa dag, utan att ge upp.
					await db.batch([db.prepare("UPDATE synk_ko SET status = 'saknas', senaste_fel = ?, andrad = ? WHERE uuid = ?").bind("404 i appen; K-samsök svarade inte", tid, k.uuid)]);
					continue;
				}
				if (!ksFinns) {
					const fanns = (await rows(db, "SELECT 1 AS x FROM lamning WHERE uuid = ?", k.uuid)).length > 0;
					await db.batch([...taBortSatser(db, k.uuid), scope ? markeraSats(db, k.uuid, "saknas", false, tid) : ogiltigforklaraInbaddning(db), taUr]);
					const msg = `${k.uuid}: finns varken i Fornsök-appen (404) eller K-samsök efter ${forsok} dagar; borttagen ur indexet`;
					console.warn(`synk: ${msg}`);
					res.fel.push(msg);
					if (fanns) res.borttagna++;
				} else {
					await db.batch([taUr]);
					const msg = `${k.uuid}: 404 i Fornsök-appen i ${forsok} dagar men finns i K-samsök; lämnas åt avstämningen`;
					console.warn(`synk: ${msg}`);
					res.fel.push(msg);
				}
				skrivna++;
				continue;
			}

			let reserv = false;
			if (!byggd) {
				// Reserv: K-samsök (SPEC 8). Posten prövas mot appen igen nästa dag.
				let ksInfra = false;
				let ksSaknar = false;
				try {
					const ks = await ksamsok.getByUuid(k.uuid);
					if (ks) {
						byggd = ksamsokTillPost(ks.post, ks.geometriWgs ?? null, idag, wgsToSweref);
						reserv = true;
					} else ksSaknar = true;
				} catch (e) {
					if (!(e instanceof UpstreamError)) throw e;
					ksInfra = arInfrafel(e);
				}
				if (!byggd) {
					await misslyckat("vantar", appFel ?? "okänt fel", appInfra && (ksInfra || ksSaknar));
					continue;
				}
			}
			natSvar = true;

			const rad = await tillRad(byggd.post, reserv ? RESERV_HASH_PREFIX : "");
			const fore = await rows<{ hash: string }>(
				db,
				"SELECT hash FROM lamning WHERE uuid = ?",
				k.uuid,
			);
			const iOmfang = scope ? inScope(scope, splitList(byggd.post.lan)) : false;
			if (!reserv && fore[0]?.hash === rad.rad.hash) {
				// Oförändrad (t.ex. omkörning): ingen skrivning, bara ur kön.
				await db.batch([taUr]);
				res.oforandrade++;
				skrivna++;
				continue;
			}
			const satser = skrivSatser(
				db,
				rad,
				reg.omraden(byggd.post, byggd.indelning),
				reg.kategorierFor(rad.rad.lamningstyp),
				{ reserv },
			);
			satser.push(scope ? markeraSats(db, k.uuid, fore.length ? "andrad" : "ny", iOmfang, tid) : ogiltigforklaraInbaddning(db));
			if (reserv) {
				satser.push(
					forsok >= maxForsok
						? taUr
						: db
								.prepare(
									"UPDATE synk_ko SET status = 'reserv', forsok = ?, senaste_fel = ?, andrad = ? WHERE uuid = ?",
								)
								.bind(forsok, appFel, tid, k.uuid),
				);
			} else satser.push(taUr);
			await db.batch(satser);
			if (iOmfang) res.markerade++;
			if (reserv) res.reserv++;
			if (fore.length) res.andrade++;
			else res.nya++;
			skrivna++;
		}

		// ------------------------------------------------ 3b. områdenas sammanfattning
		// Områden som skrivna eller borttagna lämningar låg i räknas om (hitta_plats,
		// statistik). Ett fel här hindrar inte synken; nästa körning tar dem.
		try {
			const o = await refreshInaktuella(db);
			if (o.omraknade || o.kvar) res.omraden = o;
		} catch (e) {
			res.fel.push(`områdenas sammanfattning kunde inte räknas om: ${e instanceof Error ? e.message : String(e)}`);
		}

		// ------------------------------------------------ 3c. värdelistorna
		// Kopian av appens listor förnyas varje natt även utan ändringar (namnuppslaget
		// läser den; src/lookup/index_domaner.ts). Via KV: högst en hämtning per dygn.
		if (!kopiaSparad) {
			try {
				const k = await rows<{ hamtad: string }>(db, "SELECT hamtad FROM vardelista_kopia WHERE nyckel = ?", KOPIA_NYCKEL);
				const alder = now.getTime() - Date.parse(k[0]?.hamtad ?? "");
				if (!(alder < KOPIA_SYNK_ALDER_MS)) {
					const d = await domaner.loadDomaner();
					await db.batch([sparaKopiaSats(db, d)]);
				}
			} catch (e) {
				res.fel.push(`värdelistorna kunde inte sparas i D1: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		// ------------------------------------------------ 4. klart?
		const kvar = await rows<{ status: string; n: number }>(
			db,
			"SELECT status, count(*) AS n FROM synk_ko GROUP BY status",
		);
		const vantar = kvar.find((r) => r.status === "vantar")?.n ?? 0;
		res.kvar = kvar.reduce((s, r) => s + Number(r.n), 0);
		const klarTid = startad;
		if (intervall && Number(vantar) === 0) {
			const satser = [
				statusSats(db, STATUS_SENAST, intervall.till, klarTid),
				db.prepare("DELETE FROM synk_status WHERE nyckel = ?").bind(STATUS_INTERVALL),
			];
			if (intervall.uttag)
				satser.push(statusSats(db, STATUS_UTTAG_SETT, intervall.uttag, klarTid));
			await db.batch(satser);
			res.senast_synkat = intervall.till;
			res.status = intervall.till < senaste ? "pagaende" : "klar";
		} else {
			res.senast_synkat = arDatum(status.get(STATUS_SENAST))
				? (status.get(STATUS_SENAST) as string)
				: null;
			res.status = intervall ? "pagaende" : "inget_nytt";
		}
		if (res.senast_synkat && dagarMellan(res.senast_synkat, senaste) >= 2) {
			res.fel.push(
				`LARM: synken ligger ${dagarMellan(res.senast_synkat, senaste)} dagar efter (senast synkat ${res.senast_synkat})`,
			);
		}
	} catch (e) {
		res.status = "fel";
		res.fel.push(e instanceof Error ? e.message : String(e));
	}

	// ------------------------------------------------ 5. logg
	try {
		const fel = [
			...res.fel,
			...(res.kvar ? [`kvar i kön: ${res.kvar}`] : []),
			...(res.reserv ? [`från K-samsök: ${res.reserv}`] : []),
		];
		await db.batch([
			db
				.prepare(
					"INSERT INTO synk (typ, startad, klar, kalla, fran, till, nya, andrade, borttagna, fel) VALUES ('nattsynk', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.bind(
					startad,
					new Date().toISOString(),
					"ändringsflödet + Fornsök-appen",
					res.fran,
					res.till,
					res.nya,
					res.andrade,
					res.borttagna,
					fel.length ? fel.join("; ").slice(0, 2000) : null,
				),
		]);
	} catch (e) {
		console.error(
			"synk: kunde inte logga körningen:",
			e instanceof Error ? e.message : String(e),
		);
	}
	if (res.status === "fel" || res.fel.some((f) => f.startsWith("LARM")))
		console.error("synk:", JSON.stringify(res));
	else console.log("synk:", JSON.stringify({ ...res, fel: res.fel.length }));
	return res;
}
