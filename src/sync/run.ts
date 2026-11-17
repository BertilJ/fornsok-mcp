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
 * (ny GeoPackage-fil inläst) flyttas markören tillbaka till dagen före
 * uttagsdatum, så att ändringar som filen kanske inte hann få med skrivs igen.
 * En avstämning med en äldre fil kan alltså inte ta bort nyare synkade
 * ändringar för gott.
 */
import { KvDomainSource, type KvLike } from "../cache/kv";
import { FORNSOK_APP_API, userAgent } from "../config";
import { UpstreamError } from "../errors";
import { wgsToSweref } from "../geo/geometry";
import { inScope, parseScope, type Scope } from "../semantic/scope";
import { FornsokAppSource } from "../sources/fornsokapp/source";
import { KsamsokSource } from "../sources/ksamsok/source";
import type { Domaner } from "../sources/types";
import type { D1Like, D1LikeStatement } from "../store/d1";
import { type FetchLike, UpstreamClient } from "../upstream/client";
import { arDatum, dagarMellan, laggTillDagar, senasteKlaraDag, stockholmNu } from "./datum";
import { FLODE_SIDSTORLEK, hamtaFlode } from "./flode";
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
	fel: string[];
}

export const STATUS_SENAST = "senast_synkat";
export const STATUS_INTERVALL = "synk_intervall";
export const STATUS_UTTAG_SETT = "synk_uttagsdatum_sett";

type Row = Record<string, unknown>;

interface KoRad {
	uuid: string;
	typer: string;
	utgar: number;
	status: string;
	forsok: number;
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
	const scope: Scope = parseScope(env.SEMANTIC_LAN);

	const client = new UpstreamClient({
		userAgent: userAgent(env.CONTACT_URL),
		...(opts.fetch ? { fetch: opts.fetch } : {}),
		maxConcurrent: 1,
	});
	const app = new FornsokAppSource(client);
	const ksamsok = new KsamsokSource(client);
	let register: OmradesRegister | null = null;
	const domaner = new KvDomainSource(app, env.CACHE);
	const getRegister = async (): Promise<OmradesRegister> => {
		if (!register) {
			const d: Domaner = await domaner.loadDomaner();
			register = new OmradesRegister(d);
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
				// Ny GeoPackage-laddning: synka om från dagen före uttagsdatum.
				const tillbaka = laggTillDagar(uttag, -2);
				if (!markor || tillbaka < markor) markor = tillbaka;
				uttagAttSatta = uttag;
			}
			if (!markor) markor = laggTillDagar(senaste, -1);
			const fran = laggTillDagar(markor, 1);
			let till = senaste;
			if (dagarMellan(fran, till) + 1 > maxDagar) till = laggTillDagar(fran, maxDagar - 1);
			if (fran <= till) {
				const flode = await hamtaFlode(client, fran, till, {
					storlek: opts.sidstorlek ?? FLODE_SIDSTORLEK,
					paus: () => sleep(pausMs),
				});
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
			`SELECT uuid, typer, utgar, status, forsok FROM synk_ko
			  WHERE status = 'vantar' OR substr(andrad, 1, 10) < ?
			  ORDER BY CASE status WHEN 'vantar' THEN 0 ELSE 1 END, datum, uuid LIMIT ?`,
			idag,
			maxPoster,
		);
		let skrivna = 0;
		let forstaAnrop = true;
		for (const k of ko) {
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
					markeraSats(db, k.uuid, "utgar", false, tid),
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
			const forsok = k.forsok + 1;
			const misslyckat = async (nyStatus: "vantar" | "saknas", fel: string) => {
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
			try {
				const r = await client.get(`${FORNSOK_APP_API}/lamning/lamning/${k.uuid}`);
				if (r.status === 404) {
					await misslyckat("saknas", "Fornsök-appen känner inte till lämningen (404)");
					continue;
				}
				if (r.status >= 400) appFel = `Fornsök-appen svarade ${r.status}`;
				else {
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
			}

			let reserv = false;
			if (!byggd) {
				// Reserv: K-samsök (SPEC 8). Posten prövas mot appen igen nästa dag.
				try {
					const ks = await ksamsok.getByUuid(k.uuid);
					if (ks) {
						byggd = ksamsokTillPost(ks.post, ks.geometriWgs ?? null, idag, wgsToSweref);
						reserv = true;
					}
				} catch (e) {
					if (!(e instanceof UpstreamError)) throw e;
				}
				if (!byggd) {
					await misslyckat("vantar", appFel ?? "okänt fel");
					continue;
				}
			}

			const rad = await tillRad(byggd.post, reserv ? RESERV_HASH_PREFIX : "");
			const fore = await rows<{ hash: string }>(
				db,
				"SELECT hash FROM lamning WHERE uuid = ?",
				k.uuid,
			);
			const iOmfang = inScope(scope, splitList(byggd.post.lan));
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
			satser.push(markeraSats(db, k.uuid, fore.length ? "andrad" : "ny", iOmfang, tid));
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
