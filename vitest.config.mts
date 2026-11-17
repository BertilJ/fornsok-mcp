import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		// Inga riktiga uppströmsanrop i testerna: allt går via inspelade svar.
		testTimeout: 20_000,
	},
});
