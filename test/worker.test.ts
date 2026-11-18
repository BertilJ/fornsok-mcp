/**
 * Workerns ingång: Access-kontroll före all routing, utvecklingsläge och
 * begränsning per användare. Inga uppströmsanrop (bara Access-nycklar, mockade).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ACCESS_HEADER } from "../src/auth/access";
import { checkRateLimit, rateLimitKey } from "../src/auth/ratelimit";
import { type WorkerEnv, accessConfig } from "../src/env";
import worker from "../src/index";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const AUD = "test-aud";

function call(url: string, env: WorkerEnv, headers: Record<string, string> = {}, method = "GET") {
	return worker.fetch(new Request(url, { method, headers }), env, ctx);
}

const enc = new TextEncoder();
const b64u = (data: ArrayBuffer | string) =>
	Buffer.from(typeof data === "string" ? enc.encode(data) : new Uint8Array(data)).toString("base64url");

let pair: CryptoKeyPair;
let jwk: JsonWebKey;
beforeAll(async () => {
	pair = (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
});

async function token(team: string, claims: Record<string, unknown>) {
	const now = Math.floor(Date.now() / 1000);
	const header = b64u(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
	const payload = b64u(JSON.stringify({ aud: [AUD], iss: `https://${team}`, iat: now - 5, exp: now + 600, ...claims }));
	const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, pair.privateKey, enc.encode(`${header}.${payload}`));
	return `${header}.${payload}.${b64u(sig)}`;
}

let teamCounter = 0;
function team() {
	// Ny teamdomän per test, så att modulens nyckelcache inte delas mellan testerna.
	const t = `team${++teamCounter}.cloudflareaccess.com`;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			if (url === `https://${t}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] }));
			throw new Error(`oväntat anrop: ${url}`);
		}),
	);
	return t;
}

function limiter(allow: (key: string) => boolean) {
	const keys: string[] = [];
	return {
		keys,
		binding: { limit: vi.fn(async ({ key }: { key: string }) => (keys.push(key), { success: allow(key) })) } as unknown as RateLimit,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Access före all routing", () => {
	it("utan konfiguration och utan JWT: 401 för /mcp, okända sökvägar och alla metoder", async () => {
		for (const [path, method] of [
			["/mcp", "POST"],
			["/mcp", "GET"],
			["/", "GET"],
			["/finns-inte", "GET"],
			["/mcp/../admin", "DELETE"],
		]) {
			const r = await call(`https://fornsok.example.com${path}`, {}, {}, method);
			expect(r.status, `${method} ${path}`).toBe(401);
			expect(await r.json()).toEqual({ error: "unauthorized" });
		}
	});

	it("med konfiguration men utan eller med ogiltig JWT: 401", async () => {
		const t = team();
		const env: WorkerEnv = { ACCESS_TEAM_DOMAIN: t, ACCESS_AUD: AUD };
		expect((await call("https://fornsok.example.com/mcp", env)).status).toBe(401);
		expect((await call("https://fornsok.example.com/x", env, { [ACCESS_HEADER]: "a.b.c" })).status).toBe(401);
		const wrongAud = await token(t, { aud: ["annan"], email: "a@example.com", sub: "1" });
		expect((await call("https://fornsok.example.com/mcp", env, { [ACCESS_HEADER]: wrongAud })).status).toBe(401);
	});

	it("giltig JWT: släpps igenom till routingen (okänd sökväg ger 404 först efter kontrollen)", async () => {
		const t = team();
		const env: WorkerEnv = { ACCESS_TEAM_DOMAIN: t, ACCESS_AUD: AUD };
		const tok = await token(t, { email: "a@example.com", sub: "1" });
		const r = await call("https://fornsok.example.com/finns-inte", env, { [ACCESS_HEADER]: tok });
		expect(r.status).toBe(404);
	});
});

describe("hela vägen: POST /mcp med giltig JWT genom createMcpHandler (granskningen, punkt 8b)", () => {
	async function rpc(env: WorkerEnv, tok: string | null, body: unknown) {
		const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
		if (tok) headers[ACCESS_HEADER] = tok;
		const r = await worker.fetch(new Request("https://fornsok.example.se/mcp", { method: "POST", headers, body: JSON.stringify(body) }), env, ctx);
		const text = await r.text();
		const data = r.headers.get("content-type")?.includes("text/event-stream")
			? text
					.split("\n")
					.filter((l) => l.startsWith("data:"))
					.map((l) => JSON.parse(l.slice(5)))
			: text
				? [JSON.parse(text)]
				: [];
		return { status: r.status, data };
	}

	it("initialize och tools/list ger svar; samma anrop utan JWT ger 401", async () => {
		const t = team();
		const env: WorkerEnv = { ACCESS_TEAM_DOMAIN: t, ACCESS_AUD: AUD };
		const tok = await token(t, { email: "a@example.com", sub: "1" });
		const init = await rpc(env, tok, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
		});
		expect(init.status).toBe(200);
		expect(init.data[0]?.result?.serverInfo?.name).toBeTruthy();
		const list = await rpc(env, tok, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
		expect(list.status).toBe(200);
		expect(list.data[0]?.result?.tools?.map((x: { name: string }) => x.name)).toContain("sok_lamningar");
		// Okänd parameter ger verktygsfel hela vägen genom handlern (strikta scheman).
		const fel = await rpc(env, tok, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "uppslag", arguments: { lista: "lan", soek: "x" } } });
		expect(fel.data[0]?.result?.isError).toBe(true);
		expect(JSON.stringify(fel.data[0]?.result?.content)).toMatch(/Okänd parameter \\"soek\\"/);
		const utan = await rpc(env, null, { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
		expect(utan.status).toBe(401);
	});
});

describe("utvecklingsläge (ACCESS_DEV_BYPASS)", () => {
	it('bara exakt "true" slår på det', () => {
		expect(accessConfig({ ACCESS_DEV_BYPASS: "true" }).devBypass).toBe(true);
		for (const v of ["1", "TRUE", "yes", " true", "", undefined]) expect(accessConfig({ ACCESS_DEV_BYPASS: v }).devBypass).toBe(false);
	});

	it("på: localhost utan cf-ray släpps igenom utan JWT och utan Access-konfiguration", async () => {
		const env: WorkerEnv = { ACCESS_DEV_BYPASS: "true" };
		expect((await call("http://localhost:8787/finns-inte", env)).status).toBe(404);
		expect((await call("http://127.0.0.1:8787/finns-inte", env)).status).toBe(404);
	});

	it("på: annan värd eller anrop via Cloudflares edge (cf-ray) kräver ändå JWT", async () => {
		const env: WorkerEnv = { ACCESS_DEV_BYPASS: "true" };
		expect((await call("https://fornsok.example.com/mcp", env)).status).toBe(401);
		expect((await call("http://localhost:8787/mcp", env, { "cf-ray": "8f00000000000000-ARN" })).status).toBe(401);
	});

	it("av: localhost kräver JWT", async () => {
		expect((await call("http://localhost:8787/mcp", {})).status).toBe(401);
		expect((await call("http://localhost:8787/mcp", { ACCESS_DEV_BYPASS: "false" })).status).toBe(401);
	});
});

describe("begränsning per användare", () => {
	it("nyckel: e-post (gemener) för användare, common_name för tjänstetoken", () => {
		expect(rateLimitKey({ kind: "user", email: "Andra@Example.COM", sub: "1" })).toBe("user:andra@example.com");
		expect(rateLimitKey({ kind: "service", sub: "", commonName: "abc.access" })).toBe("service:abc.access");
	});

	it("över gränsen: 429 med tydligt meddelande och Retry-After", async () => {
		const t = team();
		const { binding, keys } = limiter((k) => k !== "user:blockerad@example.com");
		const env: WorkerEnv = { ACCESS_TEAM_DOMAIN: t, ACCESS_AUD: AUD, RATE_LIMITER: binding };
		const ok = await call("https://fornsok.example.com/x", env, { [ACCESS_HEADER]: await token(t, { email: "ok@example.com", sub: "1" }) });
		expect(ok.status).toBe(404);
		const r = await call("https://fornsok.example.com/mcp", env, { [ACCESS_HEADER]: await token(t, { email: "Blockerad@example.com", sub: "2" }) });
		expect(r.status).toBe(429);
		expect(r.headers.get("retry-after")).toBe("60");
		const body = (await r.json()) as { error: { message: string } };
		expect(body.error.message).toMatch(/högst 120 per minut och användare/);
		expect(keys).toEqual(["user:ok@example.com", "user:blockerad@example.com"]);
	});

	it("tjänstetoken begränsas på common_name", async () => {
		const t = team();
		const { binding, keys } = limiter(() => true);
		const env: WorkerEnv = { ACCESS_TEAM_DOMAIN: t, ACCESS_AUD: AUD, RATE_LIMITER: binding };
		await call("https://fornsok.example.com/x", env, { [ACCESS_HEADER]: await token(t, { common_name: "svc.access", sub: "" }) });
		expect(keys).toEqual(["service:svc.access"]);
	});

	it("utan JWT räknas inget mot gränsen (401 kommer före)", async () => {
		const { binding, keys } = limiter(() => true);
		expect((await call("https://fornsok.example.com/mcp", { RATE_LIMITER: binding })).status).toBe(401);
		expect(keys).toEqual([]);
	});

	it("bindning saknas eller fallerar: släpper igenom", async () => {
		const id = { kind: "user" as const, email: "a@example.com", sub: "1" };
		expect(await checkRateLimit(undefined, id)).toBeNull();
		const broken = { limit: async () => Promise.reject(new Error("boom")) } as unknown as RateLimit;
		expect(await checkRateLimit(broken, id)).toBeNull();
	});
});
