/**
 * Koppla ihop förmågorna med källorna. Etapp 1–2: bara levande källor, med
 * valfri KV-cache för värdelistor och dokumentlistor. Senare etapper lägger en
 * indexkälla först i respektive kedja.
 */
import { type KvLike, KvDocumentSource, KvDomainSource } from "./cache/kv";
import { userAgent } from "./config";
import { DomainService } from "./lookup/domains";
import { FornsokAppSource } from "./sources/fornsokapp/source";
import { KsamsokSource } from "./sources/ksamsok/source";
import { OgcSource } from "./sources/ogc/source";
import type { ToolDeps } from "./tools/common";
import { UpstreamClient, type UpstreamClientOptions } from "./upstream/client";

export interface LiveDepsOptions extends UpstreamClientOptions {
	/** Kontaktväg i User-Agent (`CONTACT_URL`). */
	contactUrl?: string | null;
	/** KV-namnrymd för cache (`CACHE`), om den finns. */
	kv?: KvLike;
}

export function createLiveDeps(options: LiveDepsOptions = {}): ToolDeps {
	const { contactUrl, kv, ...clientOptions } = options;
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
	};
}
