#!/usr/bin/env node
/**
 * Röktest mot en lokalt körande server (`npm run dev`) över MCP.
 * Gör få, riktiga anrop mot RAÄ via servern: tools/list och ett tools/call per verktyg
 * med de tre fasta testposterna (SPEC 10).
 *
 *   node scripts/smoke.mjs [http://localhost:8787/mcp]
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = new URL(process.argv[2] ?? "http://localhost:8787/mcp");
const client = new Client({ name: "fornsok-smoke", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(url));

const out = (label, value) => console.log(`\n=== ${label} ===\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
let failures = 0;
const check = (cond, msg) => {
	console.log(`${cond ? "OK  " : "FEL "} ${msg}`);
	if (!cond) failures++;
};

const info = client.getServerVersion();
out("server", { ...info, instruktioner: (client.getInstructions() ?? "").slice(0, 120) + "…" });

const { tools } = await client.listTools();
out("tools/list", tools.map((t) => ({ name: t.name, annotations: t.annotations, har_outputSchema: !!t.outputSchema })));
check(tools.map((t) => t.name).join(",") === "sok_lamningar,lamningar_nara,lamning,uppslag", "fyra verktyg i fast ordning");

async function call(name, args) {
	const t0 = Date.now();
	const r = await client.callTool({ name, arguments: args });
	const ms = Date.now() - t0;
	out(`tools/call ${name} ${JSON.stringify(args)} (${ms} ms)${r.isError ? " – FEL" : ""}`, r.content?.[0]?.text ?? "");
	return r;
}

// lamning: de tre testposterna, via tre olika identitetsformer.
const l = await call("lamning", {
	id: ["L1946:7415", "Stora Kopparberg 172:1", "adc490ba-871a-45bd-8e3d-0a27761b3b6c"],
	inkludera: ["geometri", "referenser"],
});
const posts = l.structuredContent?.lamningar ?? [];
const nr = posts.map((p) => p.lamningsnummer).sort();
check(!l.isError && nr.join(",") === "L1946:7415,L2000:8802,L2001:646", `lamning: tre testposter (${nr.join(", ")})`);
const p646 = posts.find((p) => p.lamningsnummer === "L2001:646");
check(p646?.raa_nummer === "Bjursås 27:1" && /önskekälla/.test(p646?.tradition ?? ""), "L2001:646: RAÄ-nummer och traditionstext");
check(Math.abs((p646?.lage?.lat ?? 0) - 60.73368161435678) < 1e-6, "L2001:646: mittpunkt stämmer med K-samsök");
const p7415 = posts.find((p) => p.lamningsnummer === "L1946:7415");
check(p7415?.raa_nummer === "Stugun 114:1" && p7415?.geometri?.type === "LineString", "L1946:7415: Stugun 114:1, linje");
const p8802 = posts.find((p) => p.lamningsnummer === "L2000:8802");
check(p8802?.lamningstyp === "Hyttområde" && p8802?.raa_nummer === "Stora Kopparberg 172:1", "L2000:8802: hyttområde");

// sok_lamningar: ordsök med filter.
const s = await call("sok_lamningar", { fraga: "trefaldighetskälla", kommun: ["Falun"], socken: ["Bjursås"], antal: 10 });
check(!s.isError && (s.structuredContent?.traffar ?? []).some((t) => t.lamningsnummer === "L2001:646"), "sok_lamningar hittar L2001:646");

// lamningar_nara: runt L2000:8802.
const n = await call("lamningar_nara", { lat: 60.66159242831314, lon: 15.554018818384327, radie_m: 500, antal: 10 });
const nl = n.structuredContent?.lamningar ?? [];
check(!n.isError && nl[0]?.lamningsnummer === "L2000:8802" && new Set(nl.map((x) => x.lamningsnummer)).size === nl.length, "lamningar_nara: L2000:8802 först, deduplicerat");

// uppslag.
const u = await call("uppslag", { lista: "socknar", sok: "Bjursås" });
check(!u.isError && u.structuredContent?.varden?.[0]?.namn === "Bjursås", "uppslag hittar Bjursås");

// Felväg: parameter som kräver indexet.
const e = await call("sok_lamningar", { fraga: "offerkälla", lage: "betydelse" });
check(e.isError === true, "lage=betydelse ger tydligt fel");

await client.close();
console.log(`\n${failures === 0 ? "Röktest: alla kontroller OK" : `Röktest: ${failures} kontroll(er) fallerade`}`);
process.exit(failures === 0 ? 0 : 1);
