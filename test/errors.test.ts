/** Felmeddelanden för alla uppströmskällor har ett namn (inte "undefined svarade 503"). */
import { describe, expect, it } from "vitest";
import { SOURCE_NAMES, type SourceId, UpstreamError } from "../src/errors";
import { nominatimUrl } from "../src/tools/hitta_plats";
import { ALLOWED_CALLS } from "../src/upstream/allowlist";
import { UpstreamClient } from "../src/upstream/client";

describe("källnamn", () => {
	it("varje källa i listan över tillåtna anrop har ett namn", () => {
		for (const c of ALLOWED_CALLS) expect(SOURCE_NAMES[c.source as SourceId], c.id).toBeTruthy();
		expect(SOURCE_NAMES.nominatim).toBe("OpenStreetMap Nominatim");
		expect(SOURCE_NAMES.raa_datauttag).toBe("RAÄ:s ändringsflöde (datauttag)");
	});

	it("fel från Nominatim och ändringsflödet ger läsbara meddelanden", async () => {
		const nere = new UpstreamClient({
			userAgent: "test",
			retryDelayMs: 0,
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
		});
		const n = await nere.get(nominatimUrl("Bjursås")).catch((e) => e);
		expect(n).toBeInstanceOf(UpstreamError);
		expect(n.message).toBe("OpenStreetMap Nominatim gick inte att nå");
		const tom = new UpstreamClient({ userAgent: "test", retryDelayMs: 0, fetch: async () => new Response("nere", { status: 503 }) });
		const f = await tom.getJson("https://pub.raa.se/datauttag/lamningar?from=2026-11-17&to=2026-11-17").catch((e) => e);
		expect(f).toBeInstanceOf(UpstreamError);
		expect(f.message).toBe("RAÄ:s ändringsflöde (datauttag) svarade inte med JSON (status 503)");
	});
});
