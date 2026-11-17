import { describe, expect, it, vi } from "vitest";
import { FAIL_TTL_MS, IndexAccess, STATUS_TTL_MS, indexHamtadFran, reservHamtadFran } from "../../src/store/access";
import type { IndexStatus, IndexStore } from "../../src/store/index";

const status = (over: Partial<IndexStatus> = {}): IndexStatus => ({
	laddad: true,
	uttagsdatum: "2026-11-17",
	senast_synkat: null,
	senaste_grundladdning: "2026-11-17T21:21:47Z",
	senaste_avstamning: null,
	...over,
});

function fakeStore(impl: () => Promise<IndexStatus>) {
	const s = { status: vi.fn(impl), egenskaper: vi.fn(async () => [{ typ: "Material", varde: "Koppar", antal: 3 }]) };
	return s as unknown as IndexStore & { status: ReturnType<typeof vi.fn>; egenskaper: ReturnType<typeof vi.fn> };
}

describe("hamtad_fran", () => {
	it("index med uttagsdatum, eller nattsynkens datum när det är senare", () => {
		expect(indexHamtadFran(status())).toBe("index 2026-11-17");
		expect(indexHamtadFran(status({ senast_synkat: "2026-11-19T04:41:00Z" }))).toBe("index 2026-11-19 (nattsynk; uttag 2026-11-17)");
		expect(indexHamtadFran(status({ senast_synkat: "2026-11-16" }))).toBe("index 2026-11-17");
		expect(indexHamtadFran(status({ uttagsdatum: null }))).toBe("index (datum okänt)");
	});
	it("reservläge", () => {
		expect(reservHamtadFran("K-samsök", "indexet är tomt (inte laddat)", "2026-11-14")).toBe(
			"K-samsök (reservläge: indexet är tomt (inte laddat)), data byggd 2026-11-14",
		);
	});
});

describe("IndexAccess", () => {
	it("cachar ett laddat index i STATUS_TTL_MS", async () => {
		let t = 1000;
		const store = fakeStore(async () => status());
		const a = new IndexAccess(store, { now: () => t });
		const o = await a.open();
		expect(o).toMatchObject({ ok: true, hamtad_fran: "index 2026-11-17" });
		await a.open();
		expect(store.status).toHaveBeenCalledTimes(1);
		t += STATUS_TTL_MS + 1;
		await a.open();
		expect(store.status).toHaveBeenCalledTimes(2);
	});

	it("tomt index och fel ger reserv med orsak, och prövas igen efter FAIL_TTL_MS", async () => {
		let t = 0;
		let mode: "tom" | "fel" | "ok" = "tom";
		const store = fakeStore(async () => {
			if (mode === "fel") throw new Error("D1 nere");
			return status({ laddad: mode === "ok" });
		});
		const a = new IndexAccess(store, { now: () => t });
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await a.open()).toEqual({ ok: false, orsak: "indexet är tomt (inte laddat)" });
		mode = "fel";
		t += FAIL_TTL_MS - 1;
		expect(await a.open()).toEqual({ ok: false, orsak: "indexet är tomt (inte laddat)" });
		t += 2;
		expect(await a.open()).toEqual({ ok: false, orsak: "indexet svarade inte" });
		mode = "ok";
		t += FAIL_TTL_MS + 1;
		expect((await a.open()).ok).toBe(true);
	});

	it("reportFailure stänger av indexet en stund", async () => {
		let t = 0;
		const store = fakeStore(async () => status());
		const a = new IndexAccess(store, { now: () => t });
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect((await a.open()).ok).toBe(true);
		a.reportFailure(new Error("x"));
		expect(await a.open()).toEqual({ ok: false, orsak: "indexanropet misslyckades" });
		t += FAIL_TTL_MS + 1;
		expect((await a.open()).ok).toBe(true);
	});

	it("samtidiga anrop delar en lägeskontroll", async () => {
		const store = fakeStore(async () => status());
		const a = new IndexAccess(store);
		await Promise.all([a.open(), a.open(), a.open()]);
		expect(store.status).toHaveBeenCalledTimes(1);
	});

	it("egenskapslistan cachas", async () => {
		const store = fakeStore(async () => status());
		const a = new IndexAccess(store);
		await a.egenskaper();
		await a.egenskaper();
		expect(store.egenskaper).toHaveBeenCalledTimes(1);
	});
});
