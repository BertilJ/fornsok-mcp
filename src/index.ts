import { createMcpHandler } from "agents/mcp/server";
import { createLiveDeps } from "./deps";
import { createServer } from "./server";
import type { ToolDeps } from "./tools/common";

const MCP_ROUTE = "/mcp";

/**
 * Delas mellan förfrågningar i samma isolat: uppströmsklienten (med
 * samtidighetsgränser) och cachen för värdelistor. Skapas vid första
 * förfrågan, eftersom inställningarna (`CONTACT_URL`) kommer via `env`.
 * McpServer skapas däremot ny per förfrågan av handlern (tillståndslöst).
 */
let shared: { deps: ToolDeps; handler: ReturnType<typeof createMcpHandler> } | null = null;

function getShared(env: Env) {
	if (!shared) {
		const deps = createLiveDeps({ contactUrl: env.CONTACT_URL });
		const handler = createMcpHandler(() => createServer(deps), { route: MCP_ROUTE });
		shared = { deps, handler };
	}
	return shared;
}

/**
 * Åtkomstkontroll före MCP-hanteraren.
 *
 * Etapp 1b (SPEC 9.2, 9.3): verifiera `Cf-Access-Jwt-Assertion` – signatur mot
 * Access-teamets nycklar (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`),
 * `aud`, `iss` och giltighetstid – och svara 401 annars. Teamdomän och AUD-tagg
 * är inställningar (vars/hemligheter), aldrig hårdkodade. Returnera `null` för
 * att släppa igenom, eller ett `Response` för att avvisa. E-postadressen ur
 * JWT:n kan föras vidare via `authContext` till verktygen
 * (`getMcpAuthContext()`), t.ex. för begränsning per användare.
 *
 * Etapp 1 körs bara lokalt och har ingen kontroll.
 */
async function authorize(_request: Request, _env: Env): Promise<Response | null> {
	return null;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== MCP_ROUTE) {
			return new Response("Not found", { status: 404 });
		}
		const denied = await authorize(request, env);
		if (denied) return denied;
		return getShared(env).handler(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
