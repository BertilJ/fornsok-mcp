import { createMcpHandler } from "agents/mcp/server";
import { verifyAccessRequest } from "./auth/access";
import { checkRateLimit } from "./auth/ratelimit";
import { createLiveDeps } from "./deps";
import { type WorkerEnv, accessConfig } from "./env";
import { createServer } from "./server";
import type { ToolDeps } from "./tools/common";

const MCP_ROUTE = "/mcp";

/**
 * Delas mellan förfrågningar i samma isolat: uppströmsklienten (med
 * samtidighetsgränser) och cacharna. Skapas vid första förfrågan, eftersom
 * inställningar och bindningar kommer via `env` (som är densamma för hela
 * isolatet). McpServer skapas däremot ny per förfrågan av handlern
 * (tillståndslöst).
 */
let shared: { deps: ToolDeps; handler: ReturnType<typeof createMcpHandler> } | null = null;

function getShared(env: WorkerEnv) {
	if (!shared) {
		const deps = createLiveDeps({ contactUrl: env.CONTACT_URL, kv: env.CACHE });
		const handler = createMcpHandler(() => createServer(deps), { route: MCP_ROUTE });
		shared = { deps, handler };
	}
	return shared;
}

export default {
	async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
		// 1. Åtkomst (SPEC 9.2, 9.3): före all routing, så att även okända sökvägar ger 401.
		const auth = await verifyAccessRequest(request, accessConfig(env));
		if (!auth.ok) {
			console.warn(`access: avvisad (${auth.reason})`);
			return auth.response;
		}
		// 2. Begränsning per användare.
		const limited = await checkRateLimit(env.RATE_LIMITER, auth.identity);
		if (limited) return limited;
		// 3. Routing: bara /mcp.
		const url = new URL(request.url);
		if (url.pathname !== MCP_ROUTE) {
			return new Response("Not found", { status: 404 });
		}
		return getShared(env).handler(request, env, ctx);
	},
} satisfies ExportedHandler<WorkerEnv>;
