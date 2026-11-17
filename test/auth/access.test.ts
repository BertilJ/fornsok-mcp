import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	ACCESS_HEADER,
	KEY_CACHE_TTL_MS,
	MIN_REFETCH_INTERVAL_MS,
	createKeyCache,
	verifyAccessRequest,
	type AccessConfig,
} from "../../src/auth/access";

const TEAM = "test-team.cloudflareaccess.com";
const AUD = "aud-tag-123";
const CONFIG: AccessConfig = { teamDomain: TEAM, aud: AUD };
const T0 = 1_800_000_000_000; // ms

const enc = new TextEncoder();
function b64u(data: ArrayBuffer | Uint8Array | string): string {
	const bytes = typeof data === "string" ? enc.encode(data) : new Uint8Array(data);
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface TestKey {
	kid: string;
	priv: CryptoKey;
	jwk: JsonWebKey & { kid: string };
}
async function genKey(kid: string): Promise<TestKey> {
	const pair = (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
	return { kid, priv: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

async function sign(key: TestKey, payload: object, headerOver: object = {}): Promise<string> {
	const header = { alg: "RS256", kid: key.kid, typ: "JWT", ...headerOver };
	const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
	const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key.priv, enc.encode(input));
	return `${input}.${b64u(sig)}`;
}

const nowS = T0 / 1000;
function claims(over: Record<string, unknown> = {}) {
	return {
		aud: [AUD],
		iss: `https://${TEAM}`,
		email: "a@example.com",
		sub: "user-1",
		iat: nowS - 10,
		nbf: nowS - 10,
		exp: nowS + 600,
		type: "app",
		...over,
	};
}

function req(token?: string, url = "https://fornsok.example.com/mcp", headers: Record<string, string> = {}) {
	const h = new Headers(headers);
	if (token !== undefined) h.set(ACCESS_HEADER, token);
	return new Request(url, { headers: h });
}

/** Mockad fetch som serverar den nuvarande nyckeluppsättningen. */
function makeEnv(initial: TestKey[]) {
	let keys = initial;
	let t = T0;
	const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ keys: keys.map((k) => k.jwk) })));
	const cache = createKeyCache(TEAM);
	const deps = { fetch: fetchMock, now: () => t, cache };
	return {
		fetchMock,
		deps,
		setKeys: (k: TestKey[]) => (keys = k),
		advance: (ms: number) => (t += ms),
	};
}

let K1: TestKey, K2: TestKey, ATTACKER: TestKey;
beforeAll(async () => {
	[K1, K2, ATTACKER] = await Promise.all([genKey("k1"), genKey("k2"), genKey("k1")]);
});

async function expect401(res: Awaited<ReturnType<typeof verifyAccessRequest>>, reason?: string) {
	expect(res.ok).toBe(false);
	if (res.ok) return;
	expect(res.response.status).toBe(401);
	expect(await res.response.json()).toEqual({ error: "unauthorized" });
	if (reason) expect(res.reason).toBe(reason);
}

describe("verifyAccessRequest", () => {
	it("accepterar giltig användartoken och hämtar från rätt URL", async () => {
		const env = makeEnv([K1]);
		const r = await verifyAccessRequest(req(await sign(K1, claims())), CONFIG, env.deps);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.identity).toEqual({ kind: "user", email: "a@example.com", sub: "user-1" });
		expect(env.fetchMock).toHaveBeenCalledTimes(1);
		expect(env.fetchMock.mock.calls[0]![0]).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
	});

	it("accepterar tjänstetoken (common_name, ingen email, tom sub)", async () => {
		const env = makeEnv([K1]);
		const tok = await sign(K1, claims({ email: undefined, sub: "", common_name: "abc.access", type: "app" }));
		const r = await verifyAccessRequest(req(tok), CONFIG, env.deps);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.identity).toEqual({ kind: "service", sub: "", commonName: "abc.access" });
	});

	it("avvisar token utan email och common_name", async () => {
		const env = makeEnv([K1]);
		await expect401(await verifyAccessRequest(req(await sign(K1, claims({ email: undefined }))), CONFIG, env.deps), "no identity");
	});

	it("saknad rubrik ger 401 utan nätanrop", async () => {
		const env = makeEnv([K1]);
		await expect401(await verifyAccessRequest(req(), CONFIG, env.deps), "missing token");
		await expect401(await verifyAccessRequest(req(""), CONFIG, env.deps));
		expect(env.fetchMock).not.toHaveBeenCalled();
	});

	it("fel signatur (annan nyckel med samma kid)", async () => {
		const env = makeEnv([K1]);
		await expect401(await verifyAccessRequest(req(await sign(ATTACKER, claims())), CONFIG, env.deps), "bad signature");
	});

	it("manipulerad payload med behållen signatur", async () => {
		const env = makeEnv([K1]);
		const [h, , s] = (await sign(K1, claims())).split(".");
		const forged = `${h}.${b64u(JSON.stringify(claims({ email: "evil@example.com" })))}.${s}`;
		await expect401(await verifyAccessRequest(req(forged), CONFIG, env.deps), "bad signature");
	});

	it("fel aud", async () => {
		const env = makeEnv([K1]);
		await expect401(await verifyAccessRequest(req(await sign(K1, claims({ aud: ["annan"] }))), CONFIG, env.deps), "bad aud");
		await expect401(await verifyAccessRequest(req(await sign(K1, claims({ aud: "annan" }))), CONFIG, env.deps), "bad aud");
		await expect401(await verifyAccessRequest(req(await sign(K1, claims({ aud: undefined }))), CONFIG, env.deps), "bad aud");
	});

	it("aud som sträng och som lista med flera", async () => {
		const env = makeEnv([K1]);
		expect((await verifyAccessRequest(req(await sign(K1, claims({ aud: AUD }))), CONFIG, env.deps)).ok).toBe(true);
		expect((await verifyAccessRequest(req(await sign(K1, claims({ aud: ["x", AUD, "y"] }))), CONFIG, env.deps)).ok).toBe(true);
	});

	it("fel iss", async () => {
		const env = makeEnv([K1]);
		await expect401(
			await verifyAccessRequest(req(await sign(K1, claims({ iss: "https://evil.cloudflareaccess.com" }))), CONFIG, env.deps),
			"bad iss",
		);
	});

	it("utgången token, men inom 60 s skev tillåts", async () => {
		const env = makeEnv([K1]);
		await expect401(await verifyAccessRequest(req(await sign(K1, claims({ exp: nowS - 61 }))), CONFIG, env.deps), "expired");
		expect((await verifyAccessRequest(req(await sign(K1, claims({ exp: nowS - 30 }))), CONFIG, env.deps)).ok).toBe(true);
		await expect401(await verifyAccessRequest(req(await sign(K1, claims({ exp: undefined }))), CONFIG, env.deps), "expired");
		await expect401(await verifyAccessRequest(req(await sign(K1, claims({ exp: "9999999999" }))), CONFIG, env.deps), "expired");
	});

	it("nbf/iat i framtiden", async () => {
		const env = makeEnv([K1]);
		await expect401(await verifyAccessRequest(req(await sign(K1, claims({ nbf: nowS + 120 }))), CONFIG, env.deps), "not yet valid");
		await expect401(await verifyAccessRequest(req(await sign(K1, claims({ iat: nowS + 120 }))), CONFIG, env.deps), "iat in future");
		expect((await verifyAccessRequest(req(await sign(K1, claims({ nbf: nowS + 30, iat: nowS + 30 }))), CONFIG, env.deps)).ok).toBe(true);
	});

	it("alg none avvisas (även med tom signatur)", async () => {
		const env = makeEnv([K1]);
		const input = `${b64u(JSON.stringify({ alg: "none", kid: "k1" }))}.${b64u(JSON.stringify(claims()))}`;
		await expect401(await verifyAccessRequest(req(`${input}.`), CONFIG, env.deps));
		await expect401(await verifyAccessRequest(req(input), CONFIG, env.deps));
		await expect401(await verifyAccessRequest(req(`${input}.AAAA`), CONFIG, env.deps), "bad alg");
		expect(env.fetchMock).not.toHaveBeenCalled();
	});

	it("HS256-förväxling: HMAC med publik nyckel som hemlighet avvisas", async () => {
		const env = makeEnv([K1]);
		const secret = enc.encode(JSON.stringify(K1.jwk));
		const hk = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const input = `${b64u(JSON.stringify({ alg: "HS256", kid: "k1" }))}.${b64u(JSON.stringify(claims()))}`;
		const sig = await crypto.subtle.sign("HMAC", hk, enc.encode(input));
		await expect401(await verifyAccessRequest(req(`${input}.${b64u(sig)}`), CONFIG, env.deps), "bad alg");
	});

	it("andra alg (RS384, ES256) avvisas", async () => {
		const env = makeEnv([K1]);
		for (const alg of ["RS384", "ES256", "rs256", ""]) {
			await expect401(await verifyAccessRequest(req(await sign(K1, claims(), { alg })), CONFIG, env.deps), "bad alg");
		}
	});

	it("trasig base64/JSON/struktur", async () => {
		const env = makeEnv([K1]);
		const good = await sign(K1, claims());
		const [h, p, s] = good.split(".") as [string, string, string];
		const cases = [
			"abc",
			"a.b",
			"a.b.c.d",
			"..",
			`!!!.${p}.${s}`,
			`${h}.${p}.***`,
			`${h}.${p}.${s}=`, // padding är inte base64url
			`${h}.${b64u("inte json")}.${s}`,
			`${b64u("inte json")}.${p}.${s}`,
			`${b64u("[1,2]")}.${p}.${s}`,
			`${h}.${b64u("[]")}.${s}`,
			`${h}.${b64u("null")}.${s}`,
			`${h}.${p}.${"A".repeat(10000)}`,
		];
		for (const c of cases) await expect401(await verifyAccessRequest(req(c), CONFIG, env.deps));
	});

	it("kid saknas eller är fel typ", async () => {
		const env = makeEnv([K1]);
		await expect401(await verifyAccessRequest(req(await sign(K1, claims(), { kid: undefined })), CONFIG, env.deps), "bad kid");
		await expect401(await verifyAccessRequest(req(await sign(K1, claims(), { kid: 5 })), CONFIG, env.deps), "bad kid");
		await expect401(await verifyAccessRequest(req(await sign(K1, claims(), { kid: "x".repeat(500) })), CONFIG, env.deps), "bad kid");
	});

	it("okänt kid löses av omhämtning (nyckelrotation)", async () => {
		const env = makeEnv([K1]);
		expect((await verifyAccessRequest(req(await sign(K1, claims())), CONFIG, env.deps)).ok).toBe(true);
		expect(env.fetchMock).toHaveBeenCalledTimes(1);

		env.setKeys([K1, K2]);
		env.advance(MIN_REFETCH_INTERVAL_MS + 1);
		const r = await verifyAccessRequest(req(await sign(K2, claims())), CONFIG, env.deps);
		expect(r.ok).toBe(true);
		expect(env.fetchMock).toHaveBeenCalledTimes(2);
		// Båda nycklarna ligger nu i cachen
		expect((await verifyAccessRequest(req(await sign(K1, claims())), CONFIG, env.deps)).ok).toBe(true);
		expect(env.fetchMock).toHaveBeenCalledTimes(2);
	});

	it("okänt kid som inte finns: omhämtning begränsas", async () => {
		const env = makeEnv([K1]);
		const ghost = await genKey("ghost");
		const tok = await sign(ghost, claims());
		for (let i = 0; i < 50; i++) await expect401(await verifyAccessRequest(req(tok), CONFIG, env.deps), "unknown key");
		expect(env.fetchMock).toHaveBeenCalledTimes(1);
		// Slumpmässiga kid hjälper inte angriparen
		for (let i = 0; i < 50; i++) {
			await verifyAccessRequest(req(await sign(ghost, claims(), { kid: `r${i}` })), CONFIG, env.deps);
		}
		expect(env.fetchMock).toHaveBeenCalledTimes(1);
		// Efter intervallet tillåts exakt en ny hämtning
		env.advance(MIN_REFETCH_INTERVAL_MS + 1);
		for (let i = 0; i < 10; i++) await verifyAccessRequest(req(tok), CONFIG, env.deps);
		expect(env.fetchMock).toHaveBeenCalledTimes(2);
	});

	it("samtidiga anrop delar en hämtning", async () => {
		const env = makeEnv([K1]);
		const tok = await sign(K1, claims());
		const rs = await Promise.all(Array.from({ length: 10 }, () => verifyAccessRequest(req(tok), CONFIG, env.deps)));
		expect(rs.every((r) => r.ok)).toBe(true);
		expect(env.fetchMock).toHaveBeenCalledTimes(1);
	});

	it("cachen går ut efter TTL och nycklar hämtas om", async () => {
		const env = makeEnv([K1]);
		const tok = async () => sign(K1, claims({ exp: nowS + 100000 }));
		await verifyAccessRequest(req(await tok()), CONFIG, env.deps);
		env.advance(KEY_CACHE_TTL_MS - 1000);
		await verifyAccessRequest(req(await tok()), CONFIG, env.deps);
		expect(env.fetchMock).toHaveBeenCalledTimes(1);
		env.advance(2000);
		await verifyAccessRequest(req(await tok()), CONFIG, env.deps);
		expect(env.fetchMock).toHaveBeenCalledTimes(2);
	});

	it("misslyckad hämtning ger 401, och försöken begränsas", async () => {
		const env = makeEnv([K1]);
		env.fetchMock.mockImplementation(async () => new Response("nope", { status: 500 }));
		const tok = await sign(K1, claims());
		for (let i = 0; i < 5; i++) await expect401(await verifyAccessRequest(req(tok), CONFIG, env.deps), "unknown key");
		expect(env.fetchMock).toHaveBeenCalledTimes(1);
		// Hämtning som kastar
		env.advance(MIN_REFETCH_INTERVAL_MS + 1);
		env.fetchMock.mockImplementation(async () => {
			throw new Error("net");
		});
		await expect401(await verifyAccessRequest(req(tok), CONFIG, env.deps));
	});

	it("gamla nycklar behålls om omhämtning misslyckas", async () => {
		const env = makeEnv([K1]);
		const tok = async () => sign(K1, claims({ exp: nowS + 100000 }));
		expect((await verifyAccessRequest(req(await tok()), CONFIG, env.deps)).ok).toBe(true);
		env.advance(KEY_CACHE_TTL_MS + 1);
		env.fetchMock.mockImplementation(async () => new Response("x", { status: 503 }));
		expect((await verifyAccessRequest(req(await tok()), CONFIG, env.deps)).ok).toBe(true);
	});

	it("ogiltig konfiguration ger 401 (fail closed)", async () => {
		const env = makeEnv([K1]);
		const tok = await sign(K1, claims());
		for (const cfg of [
			{ teamDomain: "", aud: AUD },
			{ teamDomain: TEAM, aud: "" },
			{ teamDomain: "evil.com/path", aud: AUD },
			{ teamDomain: "a b.com", aud: AUD },
			{ teamDomain: "localhost", aud: AUD },
		]) {
			await expect401(await verifyAccessRequest(req(tok), cfg, env.deps), "misconfigured");
		}
		expect(env.fetchMock).not.toHaveBeenCalled();
	});

	it("teamDomain med https:// och versaler normaliseras", async () => {
		const env = makeEnv([K1]);
		const r = await verifyAccessRequest(req(await sign(K1, claims())), { teamDomain: `https://${TEAM.toUpperCase()}/`, aud: AUD }, env.deps);
		expect(r.ok).toBe(true);
	});

	it("nyckel under 2048 bit ignoreras", async () => {
		const small = (await crypto.subtle.generateKey(
			{ name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
			true,
			["sign", "verify"],
		)) as CryptoKeyPair;
		const jwk = (await crypto.subtle.exportKey("jwk", small.publicKey)) as JsonWebKey;
		const tk: TestKey = { kid: "small", priv: small.privateKey, jwk: { ...jwk, kid: "small", alg: "RS256", use: "sig" } };
		const env = makeEnv([tk, K1]);
		await expect401(await verifyAccessRequest(req(await sign(tk, claims())), CONFIG, env.deps), "unknown key");
	});

	describe("utvecklingsläge", () => {
		const local = "http://localhost:8787/mcp";
		const dev: AccessConfig = { ...CONFIG, devBypass: true };

		it("på + localhost: hoppar över verifiering", async () => {
			const env = makeEnv([K1]);
			for (const url of [local, "http://127.0.0.1:8787/", "http://[::1]:8787/"]) {
				const r = await verifyAccessRequest(req(undefined, url), dev, env.deps);
				expect(r.ok).toBe(true);
			}
			expect(env.fetchMock).not.toHaveBeenCalled();
		});

		it("på men inte localhost: JWT krävs", async () => {
			const env = makeEnv([K1]);
			for (const url of [
				"https://fornsok.example.com/mcp",
				"https://localhost.evil.com/",
				"https://evil.com/localhost",
				"http://127.0.0.1.evil.com/",
				"http://0.0.0.0/",
			]) {
				await expect401(await verifyAccessRequest(req(undefined, url), dev, env.deps), "missing token");
			}
		});

		it("på + localhost men via Cloudflares edge (cf-ray): JWT krävs", async () => {
			const env = makeEnv([K1]);
			await expect401(await verifyAccessRequest(req(undefined, local, { "cf-ray": "abc-ARN" }), dev, env.deps));
		});

		it("av (standard) + localhost: JWT krävs", async () => {
			const env = makeEnv([K1]);
			await expect401(await verifyAccessRequest(req(undefined, local), CONFIG, env.deps));
			await expect401(await verifyAccessRequest(req(undefined, local), { ...CONFIG, devBypass: false }, env.deps));
			// Bara exakt true räknas
			await expect401(await verifyAccessRequest(req(undefined, local), { ...CONFIG, devBypass: "true" as unknown as boolean }, env.deps));
		});

		it("på + localhost: giltig token fungerar fortfarande inte annorlunda (bypass tar företräde)", async () => {
			const env = makeEnv([K1]);
			const r = await verifyAccessRequest(req(await sign(K1, claims()), local), dev, env.deps);
			expect(r.ok).toBe(true);
		});
	});
});
