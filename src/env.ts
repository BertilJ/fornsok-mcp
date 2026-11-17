import type { AccessConfig } from "./auth/access";

/**
 * Workerns miljö. Skrivs för hand i stället för att genereras av `wrangler types`,
 * eftersom den spårade wrangler.jsonc medvetet saknar kontospecifika värden och
 * bindningar (SPEC 13); de finns bara i den ospårade wrangler.local.jsonc.
 * Allt utom `CONTACT_URL` är därför valfritt, och koden fungerar utan dem.
 */
export interface WorkerEnv {
	/** Kontaktväg i User-Agent mot RAÄ (SPEC 9.1). */
	CONTACT_URL?: string;
	/** Access-teamets domän, t.ex. "mitt-team.cloudflareaccess.com". */
	ACCESS_TEAM_DOMAIN?: string;
	/** AUD-taggen för Access-applikationen. */
	ACCESS_AUD?: string;
	/**
	 * Utvecklingsläge: "true" hoppar över JWT-kontrollen, men bara för anrop till
	 * localhost utan `cf-ray` (se auth/access.ts). Sätts ENDAST i `.dev.vars`.
	 */
	ACCESS_DEV_BYPASS?: string;
	/** Rate Limiting-bindning: begränsning per användare. */
	RATE_LIMITER?: RateLimit;
	/** KV för värdelistor och dokumentlistor. */
	CACHE?: KVNamespace;
	/** Indexet (D1). Saknas det används de levande källorna (reservläge) och nattsynken körs inte. */
	DB?: D1Database;
	/** Semantisk sökning (SPEC 5.2): vektorer och inbäddningsmodell. Saknas någon används bara ordsök. */
	VECTORIZE?: Vectorize;
	AI?: Ai;
	/** Län i det semantiska omfånget, kommaseparerat (standard "Dalarna"). */
	SEMANTIC_LAN?: string;
	/** "av" stänger av Nominatim i hitta_plats (då bara indexets namn). */
	NOMINATIM?: string;
}

/** Access-inställningar ur env. Utvecklingsläget kräver exakt strängen "true". */
export function accessConfig(env: WorkerEnv): AccessConfig {
	return {
		teamDomain: env.ACCESS_TEAM_DOMAIN ?? "",
		aud: env.ACCESS_AUD ?? "",
		devBypass: env.ACCESS_DEV_BYPASS === "true",
	};
}
