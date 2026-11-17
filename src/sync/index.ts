/**
 * Nattsynk för lämningsindexet (SPEC 5.3). Se run.ts för flödet.
 *
 * Innehållshashen: raderna får samma hash som inläsningen (ingest/) skulle ge
 * samma post – samma algoritm (post.ts) över samma fält. Där appens post inte
 * kan ge exakt GeoPackage-filens värden (ingående lämningars id, ibland namn)
 * blir hashen en annan, och den månatliga avstämningen skriver då om raden
 * från GeoPackage-filen en gång. Det är avsiktligt och ofarligt: filen är
 * källan för grundladdningen, raden blir likadan som efter en grundladdning,
 * och inbäddningen bäddar bara om när texten eller metadata faktiskt ändrats
 * (egen hash i tabellen inbaddning). Reservposter från K-samsök får prefixet
 * "ksamsok:" och skrivs därför alltid om av avstämningen. Ingen ändring i
 * ingest/ behövs.
 */
export {
	runSync,
	type SyncEnv,
	type SyncOptions,
	type SyncResult,
	STATUS_SENAST,
	STATUS_INTERVALL,
	STATUS_UTTAG_SETT,
} from "./run";
export {
	appTillPost,
	ksamsokTillPost,
	contentHash,
	appTidTillIso,
	TRANSFORM_VERSION,
	type SynkPost,
} from "./post";
export { tillRad } from "./rad";
export { parseFlodeSida, hamtaFlode } from "./flode";
export { senasteKlaraDag } from "./datum";
