import { McpServer } from "@modelcontextprotocol/server";
import { SERVER_NAME, SERVER_VERSION } from "./config";
import { serverInstructions } from "./instructions";
import type { ToolDeps } from "./tools/common";
import { registerHamtaDokument, registerLamningDokument } from "./tools/dokument";
import { registerHittaPlats } from "./tools/hitta_plats";
import { registerLamning } from "./tools/lamning";
import { registerLamningarNara } from "./tools/lamningar_nara";
import { registerRelaterat } from "./tools/relaterat";
import { registerSokLamningar } from "./tools/sok_lamningar";
import { registerStatistik } from "./tools/statistik";
import { registerUppslag } from "./tools/uppslag";

/**
 * Skapar en ny McpServer. Anropas per förfrågan av `createMcpHandler`
 * (tillståndslöst); beroendena (klient, cachar) delas mellan förfrågningar.
 * Verktygen registreras i fast ordning (SPEC 6).
 */
export function createServer(deps: ToolDeps): McpServer {
	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION, title: "Fornsök – Kulturmiljöregistret" },
		{ instructions: serverInstructions({ semantic: deps.semantic ? (deps.semantic.omfang ?? "det semantiska omfånget") : null }) },
	);
	registerSokLamningar(server, deps);
	registerLamningarNara(server, deps);
	registerLamning(server, deps);
	registerLamningDokument(server, deps);
	registerHamtaDokument(server, deps);
	registerRelaterat(server, deps);
	registerStatistik(server, deps);
	registerUppslag(server, deps);
	if (deps.plats) registerHittaPlats(server, deps.plats);
	return server;
}
