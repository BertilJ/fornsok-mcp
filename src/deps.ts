/**
 * Koppla ihop förmågorna med källorna. Etapp 1: bara levande källor.
 * Senare etapper lägger en indexkälla först i respektive kedja.
 */
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
}

export function createLiveDeps(options: LiveDepsOptions = {}): ToolDeps {
	const { contactUrl, ...clientOptions } = options;
	const client = new UpstreamClient({ userAgent: userAgent(contactUrl), ...clientOptions });
	const ksamsok = new KsamsokSource(client);
	let domains: DomainService;
	const app = new FornsokAppSource(client, () => domains.get());
	domains = new DomainService(app);
	return {
		search: ksamsok,
		ids: ksamsok,
		records: [
			{ name: "Fornsök-appen", source: app },
			{ name: "K-samsök", source: ksamsok },
		],
		nearby: new OgcSource(client),
		domains,
	};
}
