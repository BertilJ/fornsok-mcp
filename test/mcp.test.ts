/**
 * Hela vägen genom MCP i processen: klient → createMcpHandler → verktyg →
 * källor → falsk fetch med inspelade svar. Inga nätverksanrop.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "agents/mcp/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server";
import { fixtureDeps, fixtureResponse, standardRoutes } from "./helpers";

type Calls = ReturnType<typeof fixtureDeps>["calls"];

async function connect(routes = standardRoutes()): Promise<{ client: Client; calls: Calls }> {
	const { deps, calls } = fixtureDeps(routes);
	const handler = createMcpHandler(() => createServer(deps));
	const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
	const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		// Node lägger inte till Host på ett Request-objekt; det gör workerd.
		const req = new Request(input, init);
		req.headers.set("host", new URL(req.url).host);
		return handler(req, {}, ctx);
	};
	const client = new Client({ name: "test", version: "0.0.0" });
	await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp"), { fetch: fetchImpl }));
	return { client, calls };
}

type Structured = Record<string, any>;

describe("MCP-servern med inspelade svar", () => {
	let client: Client;
	let calls: Calls;
	beforeEach(async () => {
		({ client, calls } = await connect());
	});
	afterEach(async () => {
		await client?.close();
	});

	it("listar sex verktyg i fast ordning med scheman och annotationer", async () => {
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).toEqual(["sok_lamningar", "lamningar_nara", "lamning", "lamning_dokument", "hamta_dokument", "uppslag"]);
		for (const t of tools) {
			expect(t.description).toBeTruthy();
			expect(t.outputSchema).toBeTruthy();
			expect(t.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: true, destructiveHint: false });
		}
		expect(client.getInstructions()).toMatch(/Länsstyrelsen avgör/);
		expect(client.getInstructions()).not.toMatch(/Semantisk sökning finns bara/);
	});

	it("sok_lamningar: ordsök med filter", async () => {
		const r = await client.callTool({
			name: "sok_lamningar",
			arguments: { fraga: "slagg hytta", kommun: ["falun"], antikvarisk_bedomning: ["Fornlämning"], antal: 5 },
		});
		expect(r.isError).toBeFalsy();
		const s = r.structuredContent as Structured;
		expect(s.totalt).toBe(39);
		expect(s.sokkanaler).toEqual(["ord"]);
		expect(s.traffar).toHaveLength(5);
		expect(s.traffar[0]).toMatchObject({ lamningsnummer: "L1999:1393", antikvarisk_bedomning: "Fornlämning", kommun: ["Falun"] });
		expect(s.traffar[0].url).toMatch(/^https:\/\/pub\.raa\.se\/visa\/objekt\/lamning\//);
		expect(s.traffar.some((t: Structured) => typeof t.utdrag === "string")).toBe(true);
		const q = calls.map((c) => c.url.searchParams.get("query")).find(Boolean) ?? "";
		expect(q).toContain('text="slagg" AND text="hytta"');
		expect(q).toContain('municipalityName="Falun"');
		expect((r.content as Array<{ text: string }>)[0].text).toMatch(/39 träffar/);
	});

	it("sok_lamningar: nummer och nara", async () => {
		const r = await client.callTool({ name: "sok_lamningar", arguments: { nummer: ["L2001:646", "Stugun 114:1", "Stora Kopparberg 172:1"] } });
		expect((r.structuredContent as Structured).totalt).toBe(3);
		const n = await client.callTool({ name: "sok_lamningar", arguments: { nara: { lat: 60.6616, lon: 15.554, radie_m: 500 } } });
		const s = n.structuredContent as Structured;
		expect(s.traffar.find((t: Structured) => t.lamningsnummer === "L2000:8802").avstand_m).toBeLessThan(10);
		const q = calls.map((c) => c.url.searchParams.get("query") ?? "").find((x) => x.includes("boundingBox"));
		expect(q).toMatch(/boundingBox=\/WGS84 "[\d.]+ [\d.]+ [\d.]+ [\d.]+"/);
	});

	it("sok_lamningar: parametrar som kräver indexet ger tydligt fel", async () => {
		for (const args of [{ fraga: "offer", lage: "betydelse" }, { fraga: "x", egenskap: [{ typ: "Material", varde: "Koppar" }] }]) {
			const r = await client.callTool({ name: "sok_lamningar", arguments: args });
			expect(r.isError).toBe(true);
			expect((r.content as Array<{ text: string }>)[0].text).toMatch(/finns inte än/);
		}
		expect(calls.filter((c) => c.url.hostname === "kulturarvsdata.se")).toHaveLength(0);
	});

	it("sok_lamningar: okänt namn och flertydig socken", async () => {
		const r = await client.callTool({ name: "sok_lamningar", arguments: { kommun: ["Faluun"] } });
		expect(r.isError).toBe(true);
		expect((r.content as Array<{ text: string }>)[0].text).toMatch(/Menade du: "Falun"/);
		const s = await client.callTool({ name: "sok_lamningar", arguments: { socken: ["Näs"] } });
		expect(s.isError).toBe(true);
		expect((s.content as Array<{ text: string }>)[0].text).toMatch(/Näs \(Gotland/);
		const l = await client.callTool({ name: "sok_lamningar", arguments: { lan: ["Dalarnas län"], fraga: "slagg hytta" } });
		expect((l.structuredContent as Structured).filter.lan).toEqual(["Dalarna"]);
	});

	it("lamningar_nara: deduplicerat, sorterat, med väderstreck", async () => {
		const r = await client.callTool({ name: "lamningar_nara", arguments: { lat: 60.6616, lon: 15.554, radie_m: 500 } });
		expect(r.isError).toBeFalsy();
		const s = r.structuredContent as Structured;
		const nr = s.lamningar.map((l: Structured) => l.lamningsnummer);
		expect(new Set(nr).size).toBe(nr.length);
		expect(nr[0]).toBe("L2000:8802");
		expect(s.lamningar[0].geometrier).toBe(3);
		for (let i = 1; i < s.lamningar.length; i++) expect(s.lamningar[i].avstand_m).toBeGreaterThanOrEqual(s.lamningar[i - 1].avstand_m);
		expect(s.lamningar.slice(1).every((l: Structured) => typeof l.vaderstreck === "string")).toBe(true);
		expect(s.fullstandig).toBe(true);
	});

	it("lamningar_nara: filter går som CQL2", async () => {
		const r = await client.callTool({
			name: "lamningar_nara",
			arguments: { lat: 60.6616, lon: 15.554, radie_m: 500, lamningstyp: ["hyttområde", "Gruvområde"], antikvarisk_bedomning: ["Fornlämning"] },
		});
		const s = r.structuredContent as Structured;
		expect(s.lamningar).toHaveLength(1);
		const f = calls.find((c) => c.url.hostname === "inspire-raa.metria.se")?.url.searchParams.get("filter");
		expect(f).toBe("(lamningstyp = 'Hyttområde' OR lamningstyp = 'Gruvområde') AND (antikvariskbedomning = 'Fornlämning')");
	});

	it("lamningar_nara: punkt utanför Sverige avvisas utan anrop", async () => {
		const r = await client.callTool({ name: "lamningar_nara", arguments: { lat: 15.55, lon: 60.66 } });
		expect(r.isError).toBe(true);
		expect((r.content as Array<{ text: string }>)[0].text).toMatch(/utanför Sverige/);
		expect(calls).toHaveLength(0);
	});

	it("lamning: de tre testposterna via olika identiteter", async () => {
		const r = await client.callTool({
			name: "lamning",
			arguments: {
				id: ["L2001:646", "Stora Kopparberg 172:1", "http://kulturarvsdata.se/raa/lamning/bfe10d94-5d11-4943-8085-4b1bfcaacf64"],
				inkludera: ["geometri", "referenser", "dokument"],
			},
		});
		expect(r.isError).toBeFalsy();
		const s = r.structuredContent as Structured;
		expect(s.ej_hittade).toEqual([]);
		const byNr = Object.fromEntries(s.lamningar.map((l: Structured) => [l.lamningsnummer, l]));
		const a = byNr["L2001:646"];
		expect(a.raa_nummer).toBe("Bjursås 27:1");
		expect(a.tradition).toMatch(/önskekälla/);
		expect(a.antikvarisk_bedomning.motivering).toBeTruthy();
		expect(a.lage.osakerhet_m).toBe(10);
		expect(a.lage.lat).toBeCloseTo(60.73368161, 6);
		expect(a.lage.sweref99tm).toEqual({ e: 524892.6, n: 6733210.7 });
		expect(a.geometri.type).toBe("Point");
		expect(a.egenskaper).toEqual([{ typ: "Typ", varde: "Midsommar/trefaldighet" }]);
		expect(a.kategori).toEqual(["Kult, offer och folktro"]);
		expect(a.hamtad_fran).toMatch(/Fornsök-appen/);
		const b = byNr["L2000:8802"];
		expect(b.lamningstyp).toBe("Hyttområde");
		expect(b.geometri.type).toBe("GeometryCollection");
		expect(b.ingaende_lamningar.length).toBeGreaterThan(0);
		expect(b.referenser.skriftliga_kallor.length).toBeGreaterThan(0);
		const c = byNr["L1946:7415"];
		expect(c.raa_nummer).toBe("Stugun 114:1");
		expect(c.geometri.type).toBe("LineString");
		// dokument: listan för var och en av de tre posterna, med dokument_ref.
		expect(a.dokument.map((d: Structured) => d.grupp)).toEqual(["inventeringsbok", "inventeringsbok", "handelselogg"]);
		expect(c.dokument[0]).toMatchObject({ grupp: "inventeringsbok", filnamn: "2566-0114-01-D.jpg", storlek_byte: 283399, visas_som_bild: true });
		expect(c.dokument[0].dokument_ref).toMatch(/^dok1_/);
		expect(c.dokument[1]).toMatchObject({ grupp: "handelselogg", filtyp: "pdf", visas_som_bild: false });
		expect(b.dokument).toHaveLength(5);
		expect(s.anmarkningar).toEqual([]);
		// Ett nummeruppslag mot K-samsök för de två numren, tre poster från appen, inga JSON-LD-anrop.
		expect(calls.filter((x) => x.url.pathname === "/ksamsok/api")).toHaveLength(1);
		expect(calls.filter((x) => x.url.pathname.startsWith("/raa/lamning/"))).toHaveLength(0);
		const text = (r.content as Array<{ text: string }>)[0].text;
		expect(text).toMatch(/Tradition \(källtext\): «Fru Lax Greta Holm/);
	});

	it("lamning: faller tillbaka på K-samsök när Fornsök-appen är nere", async () => {
		await client.close();
		const routes = [
			{ match: (u: URL) => u.hostname === "app.raa.se" && u.pathname.includes("/lamning/lamning/"), respond: () => new Response("fel", { status: 503 }) },
			...standardRoutes(),
		];
		({ client, calls } = await connect(routes));
		const r = await client.callTool({ name: "lamning", arguments: { id: ["adc490ba-871a-45bd-8e3d-0a27761b3b6c"] } });
		expect(r.isError).toBeFalsy();
		const s = r.structuredContent as Structured;
		expect(s.lamningar[0].lamningsnummer).toBe("L2001:646");
		expect(s.lamningar[0].hamtad_fran).toMatch(/K-samsök \(reserv\)/);
		expect(s.anmarkningar.join(" ")).toMatch(/reservkällan K-samsök/);
		// Ett försök + ett omförsök mot appen, sedan K-samsök.
		expect(calls.filter((c) => c.url.hostname === "app.raa.se" && c.url.pathname.includes("/lamning/lamning/"))).toHaveLength(2);
	});

	it("lamning: okänt nummer och otolkbar identitet", async () => {
		const r = await client.callTool({ name: "lamning", arguments: { id: ["L9999:1", "L2001:646"] } });
		const s = r.structuredContent as Structured;
		expect(s.lamningar).toHaveLength(1);
		expect(s.ej_hittade[0].id).toBe("L9999:1");
		const bad = await client.callTool({ name: "lamning", arguments: { id: ["../../admin"] } });
		expect(bad.isError).toBe(true);
	});

	it("uppslag: värdelistor, cachade", async () => {
		const r = await client.callTool({ name: "uppslag", arguments: { lista: "lamningstyper", sok: "hytt" } });
		const s = r.structuredContent as Structured;
		expect(s.varden.map((v: Structured) => v.namn)).toContain("Hyttområde");
		expect(s.varden.find((v: Structured) => v.namn === "Hyttområde").kategori).toEqual(["Metallframställning och bergsbruk"]);
		await client.callTool({ name: "uppslag", arguments: { lista: "socknar", sok: "Näs" } });
		await client.callTool({ name: "uppslag", arguments: { lista: "kommuner" } });
		expect(calls.filter((c) => c.url.pathname.endsWith("/domaner"))).toHaveLength(2);
		const lan = await client.callTool({ name: "uppslag", arguments: { lista: "lan" } });
		expect((lan.structuredContent as Structured).totalt).toBe(21);
		const eg = await client.callTool({ name: "uppslag", arguments: { lista: "egenskapstyper" } });
		expect((eg.structuredContent as Structured).anmarkning).toMatch(/kommer med det egna indexet/);
	});
});

// Säkerställ att fixtureResponse används (exporteras för andra tester).
void fixtureResponse;
