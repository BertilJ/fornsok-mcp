#!/usr/bin/env node
/**
 * Röktest mot en körande server över MCP. Gör få, riktiga anrop mot RAÄ via
 * servern: tools/list och några tools/call med de tre fasta testposterna
 * (SPEC 10), inklusive ett inventeringsboksuppslag som bild.
 *
 *   node scripts/smoke.mjs [http://localhost:8787/mcp]
 *       Lokalt med utvecklingsläget på (ACCESS_DEV_BYPASS="true" i .dev.vars).
 *
 *   node scripts/smoke.mjs --index [url]
 *       Som ovan, mot en server med lokalt index (D1-bindningen DB, laddad med
 *       minst Falu kommun). Kontrollerar dessutom att sökning, närhet och post
 *       kommer ur indexet (hamtad_fran "index …", inget reservläge), egenskaps-
 *       filter och statistik. Utan --index förväntas reservläge.
 *
 *   node scripts/smoke.mjs --index --semantisk [url]
 *       Kräver dessutom att den semantiska kanalen är ansluten. Utan flaggan
 *       upptäcks läget ur serverns svar (sokkanaler) och kontrollerna anpassas;
 *       ett delvis inbäddat omfång ska då synas i svaret (semantisk_tackning).
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
const medIndex = args.includes("--index");
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
	tools.map((t) => t.name).join(",") === "sok_lamningar,lamningar_nara,lamning,lamning_dokument,hamta_dokument,statistik,uppslag,hitta_plats",
	`åtta verktyg i fast ordning (${tools.length})`,
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
if (medIndex) {
	check(/^index \d{4}-\d{2}-\d{2}/.test(p646?.hamtad_fran ?? "") && /^index /.test(p8802?.hamtad_fran ?? ""), `lamning: Falu-posterna ur indexet (${p646?.hamtad_fran})`);
	check((p646?.referenser?.skriftliga_kallor ?? null) !== null, "lamning: referenser till indexposten från Fornsök-appen");
	check(l.structuredContent?.reservlage === false, "lamning: inte reservläge");
} else {
	check(l.structuredContent?.reservlage === true, "lamning: reservläge utan index");
}
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
check(Array.isArray(s.structuredContent?.sokkanaler) && typeof s.structuredContent?.hamtad_fran === "string", `sok_lamningar: sokkanaler och hamtad_fran (${s.structuredContent?.hamtad_fran})`);
check(s.structuredContent?.reservlage === !medIndex, `sok_lamningar: reservlage = ${!medIndex}`);
if (medIndex) {
	const u = (s.structuredContent?.traffar ?? []).find((t) => t.lamningsnummer === "L2001:646")?.utdrag ?? "";
	check(u.includes("«"), "sok_lamningar: utdrag med markerad träff ur indexet");
	const pre = await call("sok_lamningar", { fraga: "önskekäll*", kommun: ["Falun"], antal: 5 });
	check((pre.structuredContent?.traffar ?? []).some((t) => t.lamningsnummer === "L2001:646"), "sok_lamningar: prefixsök önskekäll*");
	const eg = await call("sok_lamningar", { egenskap: [{ typ: "material", varde: "koppar" }], lamningstyp: ["Hyttområde"], kommun: ["Falun"], antal: 3 });
	check(!eg.isError && eg.structuredContent?.totalt > 0, `sok_lamningar: egenskapsfilter (${eg.structuredContent?.totalt} träffar)`);
	const nara = await call("sok_lamningar", { fraga: "hytt*", nara: { lat: 60.66159242831314, lon: 15.554018818384327, radie_m: 300 }, antal: 3 });
	check((nara.structuredContent?.traffar ?? [])[0]?.avstand_m !== undefined, "sok_lamningar: nara med avstånd");
}
const k = await call("sok_lamningar", { kategori: ["Kult, offer och folktro"], socken: ["Bjursås"], antal: 10 });
check(!k.isError && (k.structuredContent?.traffar ?? []).some((t) => t.lamningsnummer === "L2001:646"), "sok_lamningar med kategori hittar L2001:646");

// lamningar_nara: runt L2000:8802.
const n = await call("lamningar_nara", { lat: 60.66159242831314, lon: 15.554018818384327, radie_m: 500, antal: 10 });
const nl = n.structuredContent?.lamningar ?? [];
check(!n.isError && nl[0]?.lamningsnummer === "L2000:8802" && new Set(nl.map((x) => x.lamningsnummer)).size === nl.length, "lamningar_nara: L2000:8802 först, deduplicerat");
check(n.structuredContent?.reservlage === !medIndex, `lamningar_nara: reservlage = ${!medIndex} (${n.structuredContent?.hamtad_fran})`);

// statistik: kräver indexet.
const st = await call("statistik", { gruppera_pa: ["kategori"], kommun: ["Falun"] });
if (medIndex) {
	const kult = (st.structuredContent?.grupper ?? []).find((g) => g.varden[0] === "Kult, offer och folktro");
	check(!st.isError && kult?.antal > 0, `statistik per kategori i Falun (Kult, offer och folktro: ${kult?.antal})`);
	const eu = await call("uppslag", { lista: "egenskapstyper", sok: "Material" });
	check(!eu.isError && (eu.structuredContent?.varden ?? []).length > 0, "uppslag egenskapstyper ur indexet");
} else {
	check(st.isError === true, "statistik utan index ger tydligt fel");
}

// uppslag.
const u = await call("uppslag", { lista: "socknar", sok: "Bjursås" });
check(!u.isError && u.structuredContent?.varden?.[0]?.namn === "Bjursås", "uppslag hittar Bjursås");

// Semantisk sökning. Läget upptäcks ur serverns svar: "auto" inom omfånget ger
// sokkanaler ["ord","betydelse"] när kanalen är ansluten, annars ["ord"].
// --semantisk kräver att kanalen finns (fel om den saknas). Omfånget kan vara
// delvis inbäddat: då ska svaret säga det (semantisk_tackning och en anmärkning),
// och "betydelse" får ge få eller inga träffar.
const kraverSemantik = args.includes("--semantisk");
const a = await call("sok_lamningar", { fraga: "platser där man offrat", kommun: ["Falun"], antal: 5 });
const kanaler = JSON.stringify(a.structuredContent?.sokkanaler);
const medSemantik = kanaler === '["ord","betydelse"]';
console.log(`\n(semantisk kanal: ${medSemantik ? "ansluten" : "saknas"} enligt sokkanaler ${kanaler})`);
if (kraverSemantik) check(medSemantik, "--semantisk: servern använder den semantiska kanalen inom omfånget");
if (medSemantik) {
	const tack = a.structuredContent?.semantisk_tackning;
	check(tack && typeof tack.i_omfang === "number" && typeof tack.inbaddade === "number", `semantisk_tackning anges (${tack ? `${tack.inbaddade} av ${tack.i_omfang}` : "saknas"})`);
	if (tack && !tack.fullstandig) {
		check((a.structuredContent?.anmarkningar ?? []).some((x) => /inbäddat till/.test(x)), "delvis inbäddat omfång: svaret säger det");
	}
	const e = await call("sok_lamningar", { fraga: "offerkälla", lage: "betydelse", kommun: ["Falun"] });
	check(!e.isError && JSON.stringify(e.structuredContent?.sokkanaler) === '["betydelse"]', "lage=betydelse inom omfånget svarar med kanalen betydelse");
	if (tack?.fullstandig) check((e.structuredContent?.traffar ?? []).length > 0, "lage=betydelse ger träffar när omfånget är inbäddat");
	const ut = await call("sok_lamningar", { fraga: "offerkälla", lage: "betydelse", kommun: ["Uppsala"] });
	check(ut.isError === true && /gäller bara/.test(ut.content?.[0]?.text ?? ""), "lage=betydelse utanför omfånget ger fel som förklarar var den gäller");
	const riks = await call("sok_lamningar", { fraga: "offerkälla", antal: 3 });
	check(JSON.stringify(riks.structuredContent?.sokkanaler) === '["ord"]', "auto utan geografiskt filter: bara ordsök");
} else {
	check(kanaler === '["ord"]', "auto utan semantisk kanal: bara ordsök");
	const e = await call("sok_lamningar", { fraga: "offerkälla", lage: "betydelse", kommun: ["Falun"] });
	check(e.isError === true, "lage=betydelse ger tydligt fel utan semantisk kanal");
}

// hitta_plats: en socken i indexet. Bara med index, så att röktestet inte anropar Nominatim.
if (medIndex) {
	const hp = await call("hitta_plats", { namn: "Bjursås" });
	const kand = hp.structuredContent?.kandidater ?? [];
	check(!hp.isError && kand.length > 0 && hp.structuredContent?.kalla === "index", `hitta_plats: ${kand.length} kandidater för Bjursås ur indexet`);
}

await client.close();
done();
