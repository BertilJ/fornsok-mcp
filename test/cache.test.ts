import { describe, expect, it, vi } from "vitest";
import { DOMANER_KEY, kvCached } from "../src/cache/kv";
import { createLiveDeps } from "../src/deps";
import { fakeFetch, memoryKv, standardRoutes } from "./helpers";

const isNum = (v: unknown): v is number => typeof v === "number";

describe("KV-cache", () => {
	it("värdelistorna läses ur KV i nästa isolat (24 h)", async () => {
		const kv = memoryKv();
		const a = fakeFetch(standardRoutes());
		await createLiveDeps({ fetch: a.fetch, kv }).domains.get();
		expect(a.calls.filter((c) => c.url.pathname.endsWith("/domaner"))).toHaveLength(2);
		expect(kv.store.get(DOMANER_KEY)?.ttl).toBe(24 * 60 * 60);
		// Nytt isolat (nya beroenden), samma KV: inga anrop mot appen.
		const b = fakeFetch(standardRoutes());
		const d = await createLiveDeps({ fetch: b.fetch, kv }).domains.get();
		expect(b.calls).toHaveLength(0);
		expect(d.lamningstyper.length).toBeGreaterThan(100);
	});

	it("utan KV, med träff, och med fel i KV", async () => {
		const load = vi.fn(async () => 42);
		expect(await kvCached(undefined, "k", 60, load, isNum)).toBe(42);
		const kv = memoryKv();
		await kv.put("k", "7");
		expect(await kvCached(kv, "k", 60, load, isNum)).toBe(7);
		expect(load).toHaveBeenCalledTimes(1);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const broken = { get: async () => Promise.reject(new Error("kv nere")), put: async () => Promise.reject(new Error("kv nere")) };
		expect(await kvCached(broken, "k", 60, load, isNum)).toBe(42);
		expect(warn).toHaveBeenCalledTimes(2);
		warn.mockRestore();
	});

	it("TTL under KV:s minimum (60 s) höjs", async () => {
		const kv = memoryKv();
		await kvCached(kv, "x", 5, async () => 1, isNum);
		expect(kv.store.get("x")?.ttl).toBe(60);
	});
});
