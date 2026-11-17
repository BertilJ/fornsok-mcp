/**
 * Verifiering av Cloudflare Access-JWT (SPEC 9.2, 9.3).
 *
 * Workern litar aldrig på att Access satt framför den: varje anrop måste bära en
 * giltig `Cf-Access-Jwt-Assertion`, annars svarar vi 401. Ingen extern
 * JWT-lib; bara WebCrypto.
 *
 * Access-JWT (enligt Cloudflares dokumentation):
 *  - header: alg RS256, kid som matchar en nyckel i JWKS
 *  - nycklar: https://<teamdomän>/cdn-cgi/access/certs  ({ keys: [JWK...], public_certs: [...] })
 *    Access roterar var 6:e vecka; gamla nycklar gäller 7 dagar till.
 *  - claims: aud (lista med AUD-tagg), iss (https://<teamdomän>), exp, iat, nbf,
 *    email + sub för användare; för tjänstetoken saknas email och `common_name`
 *    (klient-ID) finns i stället.
 */

export interface AccessConfig {
	/** Teamdomän, t.ex. "mitt-team.cloudflareaccess.com" (utan https://). */
	teamDomain: string;
	/** AUD-taggen för Access-applikationen. */
	aud: string;
	/**
	 * Utvecklingsläge. Verifieringen hoppas över ENDAST om detta är exakt `true`
	 * och anropet kommer till localhost. Utelämnad/falsk = JWT krävs alltid.
	 */
	devBypass?: boolean;
}

export interface AccessIdentity {
	kind: "user" | "service";
	email?: string;
	sub: string;
	/** Endast tjänstetoken: klient-ID. */
	commonName?: string;
}

export type AccessResult =
	| { ok: true; identity: AccessIdentity }
	| {
			ok: false;
			/** Färdigt 401-svar med generiskt JSON-fel. */
			response: Response;
			/** Intern orsak för loggning. Aldrig i svaret. */
			reason: string;
	  };

export interface KeyCache {
	teamHost: string;
	keys: Map<string, CryptoKey>;
	fetchedAt: number; // 0 = aldrig hämtad
	lastAttemptAt: number; // 0 = aldrig försökt
	inflight: Promise<void> | null;
}

export interface AccessDeps {
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
	/** Millisekunder sedan epoch. */
	now?: () => number;
	/** Nyckelcache; standard är en per teamdomän i modulen. */
	cache?: KeyCache;
}

/** Högsta klockavvikelse i sekunder. */
export const CLOCK_SKEW_S = 60;
/** Hur länge hämtade nycklar används innan de hämtas om. */
export const KEY_CACHE_TTL_MS = 10 * 60 * 1000;
/** Kortast tid mellan två hämtningar (oavsett orsak). Begränsar omhämtning vid okänt kid. */
export const MIN_REFETCH_INTERVAL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_JWKS_BYTES = 64 * 1024;
const MAX_JWT_BYTES = 8 * 1024;
const MAX_KID_LENGTH = 128;

export const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";

const defaultCaches = new Map<string, KeyCache>();

export function createKeyCache(teamHost: string): KeyCache {
	return { teamHost, keys: new Map(), fetchedAt: 0, lastAttemptAt: 0, inflight: null };
}

function unauthorized(reason: string): AccessResult {
	return {
		ok: false,
		reason,
		response: new Response(JSON.stringify({ error: "unauthorized" }), {
			status: 401,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
				"WWW-Authenticate": "Bearer",
			},
		}),
	};
}

/** Normaliserar teamdomän till värdnamn, eller null om den är ogiltig. */
export function normalizeTeamDomain(raw: string): string | null {
	if (typeof raw !== "string") return null;
	let h = raw.trim().toLowerCase();
	if (h.startsWith("https://")) h = h.slice(8);
	if (h.endsWith("/")) h = h.slice(0, -1);
	if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) return null;
	return h;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalRequest(request: Request): boolean {
	let host: string;
	try {
		host = new URL(request.url).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (!LOCAL_HOSTS.has(host)) return false;
	// Anrop som passerat Cloudflares edge bär alltid cf-ray; lokalt (wrangler dev) saknas den.
	if (request.headers.has("cf-ray")) return false;
	return true;
}

function b64urlDecode(s: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
	if (s.length % 4 === 1) return null;
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
	try {
		const bin = atob(b64);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

function parseJsonSegment(seg: string): Record<string, unknown> | null {
	const bytes = b64urlDecode(seg);
	if (!bytes) return null;
	try {
		const v: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
		if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
		return v as Record<string, unknown>;
	} catch {
		return null;
	}
}

async function importJwk(jwk: Record<string, unknown>): Promise<CryptoKey | null> {
	if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") return null;
	if (jwk.alg !== undefined && jwk.alg !== "RS256") return null;
	if (jwk.use !== undefined && jwk.use !== "sig") return null;
	const nBytes = b64urlDecode(jwk.n);
	if (!nBytes || nBytes.length < 256) return null; // minst ~2048 bit
	try {
		return await crypto.subtle.importKey(
			"jwk",
			{ kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
	} catch {
		return null;
	}
}

async function loadKeys(cache: KeyCache, deps: Required<Pick<AccessDeps, "fetch" | "now">>): Promise<void> {
	cache.lastAttemptAt = deps.now();
	try {
		const res = await deps.fetch(`https://${cache.teamHost}/cdn-cgi/access/certs`, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			redirect: "error",
		} as RequestInit);
		if (!res.ok) throw new Error(`certs status ${res.status}`);
		const text = await res.text();
		if (text.length > MAX_JWKS_BYTES) throw new Error("certs too large");
		const body: unknown = JSON.parse(text);
		const list = (body as { keys?: unknown })?.keys;
		if (!Array.isArray(list)) throw new Error("certs without keys");
		const next = new Map<string, CryptoKey>();
		for (const item of list) {
			if (item === null || typeof item !== "object") continue;
			const jwk = item as Record<string, unknown>;
			if (typeof jwk.kid !== "string" || jwk.kid.length === 0 || jwk.kid.length > MAX_KID_LENGTH) continue;
			const key = await importJwk(jwk);
			if (key) next.set(jwk.kid, key);
		}
		if (next.size === 0) throw new Error("certs without usable keys");
		cache.keys = next;
		cache.fetchedAt = deps.now();
	} catch (e) {
		// Behåll ev. gamla nycklar; lastAttemptAt begränsar nya försök.
		console.error("access: could not refresh keys:", e instanceof Error ? e.message : "error");
	}
}

/** Hämtar nycklar (delad pågående hämtning). */
function refresh(cache: KeyCache, deps: Required<Pick<AccessDeps, "fetch" | "now">>): Promise<void> {
	if (!cache.inflight) {
		cache.inflight = loadKeys(cache, deps).finally(() => {
			cache.inflight = null;
		});
	}
	return cache.inflight;
}

async function getKey(
	cache: KeyCache,
	kid: string,
	deps: Required<Pick<AccessDeps, "fetch" | "now">>,
): Promise<CryptoKey | null> {
	const now = deps.now();
	const stale = cache.fetchedAt === 0 || now - cache.fetchedAt >= KEY_CACHE_TTL_MS || now < cache.fetchedAt;
	const canAttempt = cache.lastAttemptAt === 0 || now - cache.lastAttemptAt >= MIN_REFETCH_INTERVAL_MS || now < cache.lastAttemptAt;

	if (cache.inflight) {
		await cache.inflight;
	} else if (stale && canAttempt) {
		await refresh(cache, deps);
	}
	const hit = cache.keys.get(kid);
	if (hit) return hit;

	// Okänt kid: en omhämtning, men högst en per MIN_REFETCH_INTERVAL_MS.
	const t = deps.now();
	if (!cache.inflight && (cache.lastAttemptAt === 0 || t - cache.lastAttemptAt >= MIN_REFETCH_INTERVAL_MS || t < cache.lastAttemptAt)) {
		await refresh(cache, deps);
		return cache.keys.get(kid) ?? null;
	}
	if (cache.inflight) {
		await cache.inflight;
		return cache.keys.get(kid) ?? null;
	}
	return null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Verifierar Access-JWT:n på anropet. Returnerar identitet eller färdigt 401-svar.
 */
export async function verifyAccessRequest(
	request: Request,
	config: AccessConfig,
	deps: AccessDeps = {},
): Promise<AccessResult> {
	// Utvecklingsläge: kräver uttrycklig `true` OCH localhost.
	if (config?.devBypass === true && isLocalRequest(request)) {
		return { ok: true, identity: { kind: "user", email: "dev@localhost", sub: "dev" } };
	}

	const teamHost = normalizeTeamDomain(config?.teamDomain);
	if (!teamHost || typeof config?.aud !== "string" || config.aud.length === 0) {
		console.error("access: invalid configuration (teamDomain/aud)");
		return unauthorized("misconfigured");
	}

	const token = request.headers.get(ACCESS_HEADER);
	if (!token) return unauthorized("missing token");
	if (token.length > MAX_JWT_BYTES) return unauthorized("token too large");

	const parts = token.split(".");
	if (parts.length !== 3 || parts.some((p) => p.length === 0)) return unauthorized("malformed token");
	const [h, p, s] = parts as [string, string, string];

	const header = parseJsonSegment(h);
	if (!header) return unauthorized("malformed header");
	if (header.alg !== "RS256") return unauthorized("bad alg");
	if ("crit" in header) return unauthorized("unsupported crit");
	const kid = header.kid;
	if (typeof kid !== "string" || kid.length === 0 || kid.length > MAX_KID_LENGTH) return unauthorized("bad kid");

	const sig = b64urlDecode(s);
	if (!sig || sig.length === 0) return unauthorized("malformed signature");
	if (!parseJsonSegment(p)) return unauthorized("malformed payload");

	const resolved: Required<Pick<AccessDeps, "fetch" | "now">> = {
		fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
		now: deps.now ?? (() => Date.now()),
	};
	let cache = deps.cache;
	if (!cache) {
		cache = defaultCaches.get(teamHost);
		if (!cache) {
			cache = createKeyCache(teamHost);
			defaultCaches.set(teamHost, cache);
		}
	}
	if (cache.teamHost !== teamHost) return unauthorized("cache mismatch");

	const key = await getKey(cache, kid, resolved);
	if (!key) return unauthorized("unknown key");

	let valid = false;
	try {
		valid = await crypto.subtle.verify(
			{ name: "RSASSA-PKCS1-v1_5" },
			key,
			sig,
			new TextEncoder().encode(`${h}.${p}`),
		);
	} catch {
		valid = false;
	}
	if (!valid) return unauthorized("bad signature");

	// Signaturen är giltig; nu är innehållet betrott nog att granska.
	const claims = parseJsonSegment(p)!;
	const nowS = Math.floor(resolved.now() / 1000);

	if (claims.iss !== `https://${teamHost}`) return unauthorized("bad iss");

	const aud = claims.aud;
	const audOk = typeof aud === "string" ? aud === config.aud : Array.isArray(aud) && aud.some((a) => a === config.aud);
	if (!audOk) return unauthorized("bad aud");

	if (!isNum(claims.exp) || claims.exp + CLOCK_SKEW_S <= nowS) return unauthorized("expired");
	if (claims.nbf !== undefined && (!isNum(claims.nbf) || claims.nbf - CLOCK_SKEW_S > nowS)) return unauthorized("not yet valid");
	if (claims.iat !== undefined && (!isNum(claims.iat) || claims.iat - CLOCK_SKEW_S > nowS)) return unauthorized("iat in future");

	const email = typeof claims.email === "string" && claims.email.length > 0 ? claims.email : undefined;
	const commonName = typeof claims.common_name === "string" && claims.common_name.length > 0 ? claims.common_name : undefined;
	const sub = typeof claims.sub === "string" ? claims.sub : "";

	if (email) {
		if (sub.length === 0) return unauthorized("missing sub");
		return { ok: true, identity: { kind: "user", email, sub } };
	}
	if (commonName) {
		// Tjänstetoken: ingen email, och sub kan vara tom.
		return { ok: true, identity: { kind: "service", sub, commonName } };
	}
	return unauthorized("no identity");
}
