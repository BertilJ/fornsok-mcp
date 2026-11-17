#!/usr/bin/env node
/**
 * Röktest mot en körande server över MCP. Gör få, riktiga anrop mot RAÄ via
 * servern: tools/list och några tools/call med de tre fasta testposterna
 * (SPEC 10), inklusive ett inventeringsboksuppslag som bild.
 *
 *   node scripts/smoke.mjs [http://localhost:8787/mcp]
 *       Lokalt med utvecklingsläget på (ACCESS_DEV_BYPASS="true" i .dev.vars).
 *
 *   node scripts/smoke.mjs --utan-inloggning [url]
 *       Kontrollerar att servern avvisar anrop utan Access-JWT med 401
 *       (för /mcp och en okänd sökväg) och att en MCP-klient inte kommer in.
 *
 * Mot en driftsatt server bakom Access kan en tjänstetoken användas via
 * miljövariablerna FORNSOK_ACCESS_CLIENT_ID och FORNSOK_ACCESS_CLIENT_SECRET
 * (skickas som CF-Access-Client-Id/-Secret). De skrivs aldrig ut.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const args = process.argv.slice(2);
const utanInloggning = args.includes("--utan-inloggning");
const url = new URL(args.find((a) => !a.startsWith("--")) ?? "http://localhost:8787/mcp");

let failures = 0;
const check = (cond, msg) => {
	console.log(`${cond ? "OK  " : "FEL "} ${msg}`);
	if (!cond) failures++;
};
const out = (label, value) => console.log(`\n=== ${label} ===\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
const done = () => {
	console.log(`\n${failures === 0 ? "Röktest: alla kontroller OK" : `Röktest: ${failures} kontroll(er) fallerade`}`);
	process.exit(failures === 0 ? 0 : 1);
};

if (utanInloggning) {
	for (const [path, method] of [
		[url.pathname, "POST"],
		[url.pathname, "GET"],
		["/finns-inte", "GET"],
	]) {
		const target = new URL(path, url);
		const res = await fetch(target, {
			method,
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: method === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) : undefined,
		});
		const body = await res.text();
		check(res.status === 401, `${method} ${target.pathname} utan JWT → ${res.status} ${body.slice(0, 60)}`);
	}
	const client = new Client({ name: "fornsok-smoke", version: "0.0.0" });
	let connected = false;
	try {
		await client.connect(new StreamableHTTPClientTransport(url));
		connected = true;
		await client.close();
	} catch (err) {
		console.log(`     (MCP-klienten fick: ${String(err?.message ?? err).slice(0, 120)})`);
	}
	check(!connected, "MCP-klienten kommer inte in utan JWT");
	done();
}

const headers = {};
if (process.env.FORNSOK_ACCESS_CLIENT_ID && process.env.FORNSOK_ACCESS_CLIENT_SECRET) {
	headers["CF-Access-Client-Id"] = process.env.FORNSOK_ACCESS_CLIENT_ID;
	headers["CF-Access-Client-Secret"] = process.env.FORNSOK_ACCESS_CLIENT_SECRET;
	console.log("Använder tjänstetoken ur miljön.");
}
const client = new Client({ name: "fornsok-smoke", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));

const info = client.getServerVersion();
out("server", { ...info, instruktioner: (client.getInstructions() ?? "").slice(0, 120) + "…" });

const { tools } = await client.listTools();
out("tools/list", tools.map((t) => ({ name: t.name, annotations: t.annotations, har_outputSchema: !!t.outputSchema })));
check(
	tools.map((t) => t.name).join(",") === "sok_lamningar,lamningar_nara,lamning,lamning_dokument,hamta_dokument,uppslag",
	"sex verktyg i fast ordning",
);

async function call(name, args) {
	const t0 = Date.now();
	const r = await client.callTool({ name, arguments: args });
	const ms = Date.now() - t0;
	const text = (r.content ?? [])
		.map((c) => (c.type === "text" ? c.text : `[${c.type} ${c.mimeType ?? ""}, ${c.data ? Math.round((c.data.length * 3) / 4) : 0} byte]`))
		.join("\n");
	out(`tools/call ${name} ${JSON.stringify(args)} (${ms} ms)${r.isError ? " – FEL" : ""}`, text);
	return r;
}

// lamning: de tre testposterna, via tre olika identitetsformer, med dokument och historik.
const l = await call("lamning", {
	id: ["L1946:7415", "Stora Kopparberg 172:1", "adc490ba-871a-45bd-8e3d-0a27761b3b6c"],
	inkludera: ["geometri", "referenser", "dokument", "historik"],
});
const posts = l.structuredContent?.lamningar ?? [];
const nr = posts.map((p) => p.lamningsnummer).sort();
check(!l.isError && nr.join(",") === "L1946:7415,L2000:8802,L2001:646", `lamning: tre testposter (${nr.join(", ")})`);
const p646 = posts.find((p) => p.lamningsnummer === "L2001:646");
check(p646?.raa_nummer === "Bjursås 27:1" && /önskekälla/.test(p646?.tradition ?? ""), "L2001:646: RAÄ-nummer och traditionstext");
check(Math.abs((p646?.lage?.lat ?? 0) - 60.73368161435678) < 1e-6, "L2001:646: mittpunkt stämmer med K-samsök");
const p7415 = posts.find((p) => p.lamningsnummer === "L1946:7415");
check(p7415?.raa_nummer === "Stugun 114:1" && p7415?.geometri?.type === "LineString", "L1946:7415: Stugun 114:1, linje");
check((p7415?.dokument ?? []).some((d) => d.grupp === "inventeringsbok" && d.visas_som_bild), "L1946:7415: dokument med inventeringsbok");
check((p7415?.historik ?? []).length >= 1, "L1946:7415: versionshistorik");
const p8802 = posts.find((p) => p.lamningsnummer === "L2000:8802");
check(p8802?.lamningstyp === "Hyttområde" && p8802?.raa_nummer === "Stora Kopparberg 172:1", "L2000:8802: hyttområde");
check((p8802?.historik ?? []).some((v) => v.aktivitet?.typ === "Uppdrag"), "L2000:8802: historik med uppdrag");

// lamning_dokument + hamta_dokument: inventeringsbokssidan som bild, händelseloggen som länk.
const ld = await call("lamning_dokument", { id: "L1946:7415" });
const dok = ld.structuredContent?.dokument ?? [];
check(!ld.isError && dok.length >= 2, `lamning_dokument: ${dok.length} dokument`);
const bok = dok.find((d) => d.grupp === "inventeringsbok");
const logg = dok.find((d) => d.grupp === "handelselogg");
if (bok) {
	const h = await call("hamta_dokument", { dokument_ref: bok.dokument_ref });
	const img = (h.content ?? []).find((c) => c.type === "image");
	const bytes = img ? Buffer.from(img.data, "base64") : Buffer.alloc(0);
	check(!h.isError && img?.mimeType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8, "hamta_dokument: inventeringsbok som JPEG-bild");
	check(bytes.length === bok.storlek_byte, `hamta_dokument: storlek ${bytes.length} byte = dokumentlistans ${bok.storlek_byte}`);
} else check(false, "inventeringsbok saknas i listan");
if (logg) {
	const h = await call("hamta_dokument", { dokument_ref: logg.dokument_ref });
	check(!h.isError && h.structuredContent?.levererat === "lank" && /^https:\/\/pub\.raa\.se\/dokumentation\//.test(h.structuredContent?.url ?? ""), "hamta_dokument: händelselogg (PDF) som länk");
} else check(false, "händelselogg saknas i listan");
const forfalskad = await call("hamta_dokument", { dokument_ref: "https://app.raa.se/open/fornsok/api/lamning/lamning" });
check(forfalskad.isError === true, "hamta_dokument: påhittad referens avvisas");

// sok_lamningar: ordsök med filter, och kategori.
const s = await call("sok_lamningar", { fraga: "trefaldighetskälla", kommun: ["Falun"], socken: ["Bjursås"], antal: 10 });
check(!s.isError && (s.structuredContent?.traffar ?? []).some((t) => t.lamningsnummer === "L2001:646"), "sok_lamningar hittar L2001:646");
const k = await call("sok_lamningar", { kategori: ["Kult, offer och folktro"], socken: ["Bjursås"], antal: 10 });
check(!k.isError && (k.structuredContent?.traffar ?? []).some((t) => t.lamningsnummer === "L2001:646"), "sok_lamningar med kategori hittar L2001:646");

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
done();
