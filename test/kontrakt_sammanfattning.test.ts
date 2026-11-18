/**
 * Kontrakttesternas sammanfattning (test/kontrakt/sammanfatta.mjs): text ur
 * RAÄ:s svar ska visas som text i $GITHUB_STEP_SUMMARY, aldrig som Markdown
 * eller HTML (granskningen av b327106, punkt 6).
 */
import { describe, expect, it } from "vitest";
import { cell, kod } from "./kontrakt/markdown.mjs";

describe("sammanfattningens neutralisering", () => {
	it("HTML, Markdown, länkar, omnämnanden, tabellstreck och radbrytningar neutraliseras", () => {
		const elak = '<img src=x onerror=alert(1)> **fet** [länk](https://evil.example) `kod` | @someone\n# Rubrik';
		const c = cell(elak) as string;
		expect(c).not.toMatch(/<|>/);
		expect(c).toContain("&lt;img");
		expect(c).not.toMatch(/(?<!\\)\*\*/);
		expect(c).toContain("\\*\\*fet\\*\\*");
		expect(c).toContain("\\[länk\\]\\(https&#58;//evil\\.example\\)");
		expect(c).toContain("\\`kod\\`");
		expect(c).toContain("\\|");
		expect(c).toContain("&#64;someone");
		expect(c).not.toContain("\n");
		expect(c).toContain("\\# Rubrik");
		expect((cell("a".repeat(400)) as string).length).toBeLessThan(320);
		expect(cell("Fornsök-appens läs-API | GET /x")).toBe("Fornsök\\-appens läs\\-API \\| GET /x");
	});

	it("fältnamn som kod: HTML-entiteter, inga tabellstreck", () => {
		expect(kod("result.records`<b>|x")).toBe("<code>result.records`&lt;b&gt;&#124;x</code>");
	});
});
