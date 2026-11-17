/**
 * Begränsning per användare (SPEC 9.2) med Workers Rate Limiting-bindning.
 *
 * Nyckeln är identiteten ur Access-JWT:n (e-post för användare, `common_name`
 * för tjänstetoken), aldrig IP. Gränsen sätts i bindningens konfiguration;
 * Cloudflare räknar ungefärligt och per plats (enligt dokumentationen).
 * Saknas bindningen begränsas inget. Fel i bindningen släpper igenom anropet
 * (användaren är redan verifierad).
 */
import { RATE_LIMIT_PER_MINUTE } from "../config";
import type { AccessIdentity } from "./access";

export function rateLimitKey(identity: AccessIdentity): string {
	if (identity.kind === "service") return `service:${identity.commonName ?? identity.sub}`;
	return `user:${(identity.email ?? identity.sub).toLowerCase()}`;
}

let warnedMissing = false;

/** null = släpp igenom; annars ett färdigt 429-svar. */
export async function checkRateLimit(limiter: RateLimit | undefined, identity: AccessIdentity): Promise<Response | null> {
	if (!limiter) {
		if (!warnedMissing) {
			console.warn("ratelimit: bindningen RATE_LIMITER saknas – ingen begränsning per användare");
			warnedMissing = true;
		}
		return null;
	}
	let success = true;
	try {
		({ success } = await limiter.limit({ key: rateLimitKey(identity) }));
	} catch (err) {
		console.error("ratelimit: fel i bindningen:", err instanceof Error ? err.message : String(err));
		return null;
	}
	return success ? null : tooManyRequests();
}

export function tooManyRequests(): Response {
	const message = `För många anrop: högst ${RATE_LIMIT_PER_MINUTE} per minut och användare. Vänta en minut och försök igen.`;
	return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
		status: 429,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "60" },
	});
}
