/**
 * ingest/ körs direkt av Node 22 med typstrippning (inga npm-beroenden, ingen
 * byggsteg). Typstrippningen klarar bara syntax som kan strykas, vilket tsc
 * inte kontrollerar här; därför startas cli.ts på riktigt, så att alla moduler
 * (även de i src/ som ingest importerar) laddas.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../..");

describe("node ingest/cli.ts", () => {
	it("laddar alla moduler med Node:s typstrippning och visar användning", () => {
		const r = spawnSync(process.execPath, ["ingest/cli.ts"], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
		expect(r.stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError|ERR_MODULE_NOT_FOUND/);
		expect(r.stderr).toMatch(/Användning/);
		expect(r.status).toBe(2);
	});

	it("referens.ts laddas fristående (utan cli.ts:s upplösningskrok)", () => {
		const r = spawnSync(process.execPath, ["-e", "import('./ingest/referens.ts').then(() => console.log('ok'))"], {
			cwd: ROOT,
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(r.stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError|ERR_MODULE_NOT_FOUND/);
		expect(r.stdout.trim()).toBe("ok");
	});
});

describe("ingest/referens.ts: User-Agent", () => {
	it("använder samma kontaktväg som servern (inställningen, aldrig en hårdkodad driftadress)", async () => {
		const { USER_AGENT } = await import("../../ingest/referens.ts");
		const { DEFAULT_CONTACT_URL } = await import("../../src/config");
		expect(USER_AGENT).toBe(`fornsok-mcp/0.1 (+${process.env.CONTACT_URL ? new URL(process.env.CONTACT_URL).href : DEFAULT_CONTACT_URL})`);
		// Utan CONTACT_URL är kontaktvägen exakt standardvärdet ur src/config.ts, inget annat.
		if (!process.env.CONTACT_URL) expect(USER_AGENT).toBe(`fornsok-mcp/0.1 (+${DEFAULT_CONTACT_URL})`);
	});
});
