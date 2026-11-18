import { createMcpHandler } from "agents/mcp/server";
import { verifyAccessRequest } from "./auth/access";
import { checkRateLimit } from "./auth/ratelimit";
import { medBakgrund } from "./bakgrund";
import { createDeps } from "./deps";
import { type WorkerEnv, accessConfig } from "./env";
import { runScheduled } from "./scheduled";
import { createSemanticSearch } from "./semantic";
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
		const deps = createDeps({
			contactUrl: env.CONTACT_URL,
			kv: env.CACHE,
			db: env.DB,
			// null utan AI eller VECTORIZE: då bara ordsök.
			semantic: createSemanticSearch(env) ?? undefined,
			nominatim: env.NOMINATIM,
		});
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
		// Bakgrundsarbete (t.ex. förnyelse av värdelistorna) anmäls till ctx.waitUntil (src/bakgrund.ts).
		return medBakgrund(ctx, () => getShared(env).handler(request, env, ctx));
	},

	/**
	 * Schemalagda körningar (nattsynk, inbäddning), se scheduled.ts. Ingen
	 * HTTP-förfrågan och därmed ingen Access-kontroll; Cron Triggers kan bara
	 * startas av Cloudflare.
	 */
	async scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(
			runScheduled(controller.cron, env).catch((err) => {
				console.error(`schemalagd körning ${controller.cron}: oväntat fel:`, err);
			}),
		);
	},
} satisfies ExportedHandler<WorkerEnv>;
