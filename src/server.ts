import { McpServer } from "@modelcontextprotocol/server";
import { SERVER_NAME, SERVER_VERSION } from "./config";
import { SERVER_INSTRUCTIONS } from "./instructions";
import type { ToolDeps } from "./tools/common";
import { registerHamtaDokument, registerLamningDokument } from "./tools/dokument";
import { registerLamning } from "./tools/lamning";
import { registerLamningarNara } from "./tools/lamningar_nara";
import { registerSokLamningar } from "./tools/sok_lamningar";
import { registerUppslag } from "./tools/uppslag";

/**
 * Skapar en ny McpServer. Anropas per förfrågan av `createMcpHandler`
 * (tillståndslöst); beroendena (klient, cachar) delas mellan förfrågningar.
 * Verktygen registreras i fast ordning.
 */
export function createServer(deps: ToolDeps): McpServer {
	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION, title: "Fornsök – Kulturmiljöregistret" },
		{ instructions: SERVER_INSTRUCTIONS },
	);
	registerSokLamningar(server, deps);
	registerLamningarNara(server, deps);
	registerLamning(server, deps);
	registerLamningDokument(server, deps);
	registerHamtaDokument(server, deps);
	registerUppslag(server, deps);
	return server;
}
