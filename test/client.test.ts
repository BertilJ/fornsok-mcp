import { describe, expect, it } from "vitest";
import { USER_AGENT } from "../src/config";
import { DisallowedCallError, UpstreamError } from "../src/errors";
import { Semaphore, UpstreamClient } from "../src/upstream/client";
import type { FetchLike } from "../src/upstream/client";

const DOMANER = "https://app.raa.se/open/fornsok/api/lamning/domaner";

function counting(responses: Array<() => Response | Promise<Response>>) {
	let i = 0;
	const seen: RequestInit[] = [];
	const fetch: FetchLike = async (_input, init) => {
		seen.push(init ?? {});
		const r = responses[Math.min(i, responses.length - 1)];
		i++;
		return r();
	};
	return { fetch, count: () => i, seen };
}

describe("uppströmsklienten", () => {
	it("skickar User-Agent och Accept och använder manuell omdirigering", async () => {
		const c = counting([() => new Response("{}", { status: 200 })]);
		await new UpstreamClient({ fetch: c.fetch }).get(DOMANER);
		const h = new Headers(c.seen[0].headers);
		expect(h.get("user-agent")).toBe(USER_AGENT);
		expect(h.get("accept")).toBe("application/json");
		expect(c.seen[0].redirect).toBe("manual");
		expect(c.seen[0].method).toBe("GET");
	});

	it("gör ett omförsök vid 5xx och lyckas", async () => {
		const c = counting([() => new Response("fel", { status: 503 }), () => new Response("{}", { status: 200 })]);
		const r = await new UpstreamClient({ fetch: c.fetch, retryDelayMs: 0 }).get(DOMANER);
		expect(r.status).toBe(200);
		expect(c.count()).toBe(2);
	});

	it("gör ett omförsök vid 429", async () => {
		const c = counting([() => new Response("", { status: 429, headers: { "retry-after": "0" } }), () => new Response("{}", { status: 200 })]);
		const r = await new UpstreamClient({ fetch: c.fetch, retryDelayMs: 0 }).get(DOMANER);
		expect(r.status).toBe(200);
		expect(c.count()).toBe(2);
	});

	it("ger upp efter ett omförsök (högst två försök)", async () => {
		const c = counting([() => new Response("fel", { status: 502 })]);
		const r = await new UpstreamClient({ fetch: c.fetch, retryDelayMs: 0 }).get(DOMANER);
		expect(r.status).toBe(502);
		expect(c.count()).toBe(2);
	});

	it("gör inte omförsök vid 4xx", async () => {
		const c = counting([() => new Response("nej", { status: 400 })]);
		const r = await new UpstreamClient({ fetch: c.fetch, retryDelayMs: 0 }).get(DOMANER);
		expect(r.status).toBe(400);
		expect(c.count()).toBe(1);
	});

	it("tidsgräns ger UpstreamError efter ett omförsök", async () => {
		let n = 0;
		const fetch: FetchLike = (_i, init) =>
			new Promise((_resolve, reject) => {
				n++;
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			});
		const client = new UpstreamClient({ fetch, timeoutMs: 30, retryDelayMs: 0 });
		await expect(client.get(DOMANER)).rejects.toThrow(/svarade inte inom/);
		expect(n).toBe(2);
	});

	it("nätverksfel ger UpstreamError", async () => {
		const fetch: FetchLike = async () => {
			throw new TypeError("fetch failed");
		};
		await expect(new UpstreamClient({ fetch, retryDelayMs: 0 }).get(DOMANER)).rejects.toBeInstanceOf(UpstreamError);
	});

	it("anropar aldrig fetch för otillåtna anrop", async () => {
		const c = counting([() => new Response("{}")]);
		const client = new UpstreamClient({ fetch: c.fetch });
		await expect(client.get("https://app.raa.se/open/fornsok/api/lamning/lamning")).rejects.toBeInstanceOf(DisallowedCallError);
		await expect(client.get("https://example.com/")).rejects.toBeInstanceOf(DisallowedCallError);
		expect(c.count()).toBe(0);
	});

	it("följer inte omdirigeringar till otillåtna adresser", async () => {
		const c = counting([() => new Response(null, { status: 302, headers: { location: "https://app.raa.se/open/fornsok/api/admin" } })]);
		await expect(new UpstreamClient({ fetch: c.fetch }).get(DOMANER)).rejects.toBeInstanceOf(DisallowedCallError);
		expect(c.count()).toBe(1);
	});

	it("följer omdirigeringar till tillåtna adresser", async () => {
		const c = counting([
			() => new Response(null, { status: 301, headers: { location: "/open/fornsok/api/uppdrag/domaner" } }),
			() => new Response("{}", { status: 200 }),
		]);
		const r = await new UpstreamClient({ fetch: c.fetch }).get(DOMANER);
		expect(r.status).toBe(200);
	});

	it("håller högst 4 samtidiga anrop per källa", async () => {
		let active = 0;
		let max = 0;
		const fetch: FetchLike = async () => {
			active++;
			max = Math.max(max, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
			return new Response("{}");
		};
		const client = new UpstreamClient({ fetch });
		await Promise.all(Array.from({ length: 12 }, () => client.get(DOMANER)));
		expect(max).toBe(4);
	});

	it("semaforen släpper inte in fler än max även när nya anropare kommer vid överlämning", async () => {
		const s = new Semaphore(2);
		let active = 0;
		let max = 0;
		const job = () =>
			s.run(async () => {
				active++;
				max = Math.max(max, active);
				await Promise.resolve();
				active--;
			});
		const all: Promise<void>[] = [];
		for (let i = 0; i < 10; i++) {
			all.push(job());
			if (i % 3 === 0) await Promise.resolve();
		}
		await Promise.all(all);
		expect(max).toBeLessThanOrEqual(2);
		expect(s.inFlight).toBe(0);
	});
});

describe("kontaktväg i User-Agent", () => {
	it("är en inställning med förvaret som standard", async () => {
		const { userAgent, DEFAULT_CONTACT_URL } = await import("../src/config");
		expect(DEFAULT_CONTACT_URL).toBe("https://github.com/BertilJ/fornsok-mcp");
		expect(userAgent()).toBe("fornsok-mcp/0.1 (+https://github.com/BertilJ/fornsok-mcp)");
		expect(userAgent("https://example.org/kontakt")).toBe("fornsok-mcp/0.1 (+https://example.org/kontakt)");
		expect(userAgent("inte en adress")).toBe(userAgent());
		expect(userAgent("javascript:alert(1)")).toBe(userAgent());
	});

	it("CONTACT_URL når anropen", async () => {
		const { createLiveDeps } = await import("../src/deps");
		const seen: Headers[] = [];
		const deps = createLiveDeps({
			contactUrl: "https://example.org/kontakt",
			fetch: async (_i, init) => {
				seen.push(new Headers(init?.headers));
				return new Response("{}");
			},
		});
		await deps.domains.get().catch(() => undefined);
		expect(seen[0].get("user-agent")).toBe("fornsok-mcp/0.1 (+https://example.org/kontakt)");
	});
});
