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
	/** Kommande etapper (indexet). Används inte än. */
	DB?: D1Database;
	VECTORIZE?: Vectorize;
	AI?: Ai;
}

/** Access-inställningar ur env. Utvecklingsläget kräver exakt strängen "true". */
export function accessConfig(env: WorkerEnv): AccessConfig {
	return {
		teamDomain: env.ACCESS_TEAM_DOMAIN ?? "",
		aud: env.ACCESS_AUD ?? "",
		devBypass: env.ACCESS_DEV_BYPASS === "true",
	};
}
