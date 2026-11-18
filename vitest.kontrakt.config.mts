import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Kontrakttester mot de riktiga källorna (SPEC 10). Körs separat från den vanliga
 * sviten (`vitest.config.mts` tar bara `test/**\/*.test.ts`):
 *
 *   npx vitest run --config vitest.kontrakt.config.mts
 *
 * Filerna ligger i test/kontrakt/ och heter `*.kontrakt.ts`.
 *
 * - En fil i taget och ett anrop i taget (hövlighet mot RAÄ, SPEC 9.1).
 * - JSON-rapport för sammanfattningen i GitHub Actions (test/kontrakt/sammanfatta.mjs).
 * - Anropsloggen delas mellan filerna så att taket på antal anrop gäller för hela körningen.
 */
const rapport = process.env.KONTRAKT_RAPPORT || join(tmpdir(), "fornsok-kontrakt-rapport.json");
const logg = process.env.KONTRAKT_LOGG || join(tmpdir(), "fornsok-kontrakt-anrop.jsonl");

export default defineConfig({
	test: {
		include: ["test/kontrakt/**/*.kontrakt.ts"],
		environment: "node",
		globalSetup: ["test/kontrakt/global.ts"],
		fileParallelism: false,
		sequence: { concurrent: false },
		retry: 0,
		testTimeout: 90_000,
		hookTimeout: 30_000,
		reporters: ["default", "json"],
		outputFile: { json: rapport },
		env: { KONTRAKT_LOGG: logg },
	},
});
