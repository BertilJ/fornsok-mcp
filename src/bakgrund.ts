/**
 * Bakgrundsarbete som ska få löpa klart efter svaret (granskningen av
 * b327106, punkt 1). I Workers kan arbete som inte är anmält med
 * `ctx.waitUntil` avbrytas när förfrågan är klar; ett löfte som då aldrig
 * avgörs får inte ligga kvar och blockera senare förfrågningar.
 *
 * `fetch`-hanteraren (src/index.ts) kör varje förfrågan i `medBakgrund(ctx, …)`,
 * så att djupt liggande kod (t.ex. hämtningen av Fornsök-appens värdelistor i
 * lookup/index_domaner.ts, som delas mellan förfrågningar i isolatet) kan anmäla
 * sitt arbete med `iBakgrunden` utan att `ctx` skickas genom varje anrop.
 * Kontexten följer med över `await` (AsyncLocalStorage, `nodejs_compat`).
 * Utanför en förfrågan (test, schemalagda körningar som själva väntar ut
 * arbetet) gör `iBakgrunden` ingenting.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface Bakgrund {
	waitUntil(p: Promise<unknown>): void;
}

const lagring = new AsyncLocalStorage<Bakgrund>();

/** Kör `fn` med `ctx` som mottagare av bakgrundsarbete. */
export function medBakgrund<T>(ctx: Bakgrund, fn: () => T): T {
	return lagring.run(ctx, fn);
}

/** Anmäl `p` till den pågående förfrågans `waitUntil`, om det finns en. Fel i `p` sväljs här (anroparen loggar). */
export function iBakgrunden(p: Promise<unknown>): boolean {
	const ctx = lagring.getStore();
	if (!ctx) return false;
	try {
		ctx.waitUntil(p.catch(() => {}));
		return true;
	} catch {
		return false;
	}
}
