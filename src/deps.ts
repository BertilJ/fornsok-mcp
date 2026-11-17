/**
 * Koppla ihop förmågorna med källorna: levande källor (med valfri KV-cache för
 * värdelistor och dokumentlistor), indexet i D1 när bindningen finns, och den
 * semantiska kanalen när den är ansluten.
 */
import { type KvLike, KvDocumentSource, KvDomainSource } from "./cache/kv";
import { userAgent } from "./config";
import { DomainService } from "./lookup/domains";
import { FornsokAppSource } from "./sources/fornsokapp/source";
import { KsamsokSource } from "./sources/ksamsok/source";
import { OgcSource } from "./sources/ogc/source";
import type { SemanticSearch } from "./sources/types";
import { IndexAccess } from "./store/access";
import type { D1Like } from "./store/d1";
import { IndexStore } from "./store/index";
import { createHittaPlatsDeps } from "./tools/hitta_plats";
import type { ToolDeps } from "./tools/common";
import { UpstreamClient, type UpstreamClientOptions } from "./upstream/client";

export interface LiveDepsOptions extends UpstreamClientOptions {
	/** Kontaktväg i User-Agent (`CONTACT_URL`). */
	contactUrl?: string | null;
	/** KV-namnrymd för cache (`CACHE`), om den finns. */
	kv?: KvLike;
	/** Inställningen `NOMINATIM` ("av" stänger av Nominatim i hitta_plats). */
	nominatim?: string | null;
}

export interface DepsOptions extends LiveDepsOptions {
	/** D1-bindningen `DB` (indexet), om den finns. */
	db?: D1Like;
	/**
	 * Den semantiska kanalen (etapp 5), om den finns. Används bara när `db`
	 * också finns: träffarna fylls på och kontrolleras mot filtret i indexet.
	 */
	semantic?: SemanticSearch;
}

/** Alla beroenden: levande källor, och indexet/semantiken när de finns. */
export function createDeps(options: DepsOptions = {}): ToolDeps {
	const { db, semantic, ...live } = options;
	const deps = createLiveDeps(live);
	if (db) {
		deps.index = new IndexAccess(new IndexStore(db), { kv: live.kv });
		if (semantic) deps.semantic = semantic;
		// hitta_plats söker först bland indexets namn.
		deps.plats = createHittaPlatsDeps({ db, kv: live.kv, contactUrl: live.contactUrl, nominatim: live.nominatim, fetch: live.fetch });
	}
	return deps;
}

/** Bara levande källor (etapp 1–2), utan index. */
export function createLiveDeps(options: LiveDepsOptions = {}): ToolDeps {
	const { contactUrl, kv, nominatim, ...clientOptions } = options;
	const client = new UpstreamClient({ userAgent: userAgent(contactUrl), ...clientOptions });
	const ksamsok = new KsamsokSource(client);
	let domains: DomainService;
	const app = new FornsokAppSource(client, () => domains.get());
	domains = new DomainService(new KvDomainSource(app, kv));
	return {
		search: ksamsok,
		ids: ksamsok,
		records: [
			{ name: "Fornsök-appen", source: app },
			{ name: "K-samsök", source: ksamsok },
		],
		nearby: new OgcSource(client),
		domains,
		documents: new KvDocumentSource(app, kv),
		history: app,
		// Utan index går hitta_plats direkt till Nominatim.
		plats: createHittaPlatsDeps({ kv, contactUrl, nominatim, fetch: clientOptions.fetch }),
	};
}
