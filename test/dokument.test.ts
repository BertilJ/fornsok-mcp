/**
 * Etapp 2: lamning_dokument, hamta_dokument, inkludera dokument/historik.
 * Mot inspelade svar (app-dokument-*, app-version-*) och en nedskalad JPEG.
 */
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { ToolInputError } from "../src/errors";
import { parseDokumentLista, parseVersioner } from "../src/sources/fornsokapp/dokument";
import { makeDokumentRef, parseDokumentRef } from "../src/tools/dokument_ref";
import { checkAllowed } from "../src/upstream/allowlist";
import { type Route, connectMcp, fixture, fixtureBytes, fixtureResponse, memoryKv, standardRoutes } from "./helpers";

type Structured = Record<string, any>;
type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

const U7415 = "bfe10d94-5d11-4943-8085-4b1bfcaacf64";
const U646 = "adc490ba-871a-45bd-8e3d-0a27761b3b6c";
const FIL_JPG = "aWlwYXg6Ly9vYmplY3RiYXNlLmRvY3VtZW50L2RvY3BhcnRpdGlvbiMzMTA5ODk=";
const FIL_PDF = "aWlwYXg6Ly9vYmplY3RiYXNlLmRvY3VtZW50L2RvY3BhcnRpdGlvbiMxNDE4NzQwMw==";
const FIL_PATH = `/open/fornsok/api/lamning/dokument/fil/${encodeURIComponent(FIL_JPG)}/2566-0114-01-D.jpg`;

const isFilCall = (u: URL) => u.pathname.includes("/dokument/fil/");

/** Ersätt filsvaret med ett eget. */
function withFile(respond: () => Response): Route[] {
	return [{ match: (u) => u.hostname === "app.raa.se" && u.pathname === FIL_PATH, respond }, ...standardRoutes()];
}

/** Ersätt dokumentlistan för L1946:7415 med en ändrad kopia. */
function withList(change: (d: Structured) => void, extra: Route[] = []): Route[] {
	const d = fixture<Structured>("app-dokument-L1946-7415.json");
	change(d);
	return [
		{
			match: (u) => u.pathname === "/open/fornsok/api/lamning/dokument" && u.searchParams.get("lamning_id") === U7415,
			respond: () => new Response(JSON.stringify(d), { headers: { "content-type": "application/json" } }),
		},
		...extra,
		...standardRoutes(),
	];
}

describe("dokument_ref", () => {
	it("går fram och tillbaka och är ogenomskinlig", () => {
		const ref = makeDokumentRef(U7415, FIL_JPG);
		expect(ref).toMatch(/^dok1_[A-Za-z0-9_-]+$/);
		expect(ref).not.toContain(U7415);
		expect(parseDokumentRef(ref)).toEqual({ uuid: U7415, filId: FIL_JPG });
		expect(parseDokumentRef(`  ${ref} `)).toEqual({ uuid: U7415, filId: FIL_JPG });
	});

	it("avvisar allt som servern inte kan ha skapat", () => {
		const b64 = (t: string) => Buffer.from(t).toString("base64url");
		const bad = [
			"",
			"dok1_",
			"https://app.raa.se/open/fornsok/api/lamning/dokument/fil/1/x.jpg",
			`dok2_${b64(`${U7415}|${FIL_JPG}`)}`,
			`dok1_${b64(`${U7415}|${FIL_JPG}|extra`)}`,
			`dok1_${b64(`${U7415.toUpperCase()}|${FIL_JPG}`)}`,
			`dok1_${b64(`inte-en-uuid-alls-inte-en-uuid-alls-xx|${FIL_JPG}`)}`,
			`dok1_${b64(`${U7415}|../../admin`)}`,
			`dok1_${b64(`${U7415}|abc def`)}`,
			`dok1_${b64(`${U7415}|${FIL_JPG}`)}!`,
			`dok1_${Buffer.from([0xff, 0xfe, 0xfd, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e, 0x8f, 0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a]).toString("base64url")}`,
		];
		for (const r of bad) expect(() => parseDokumentRef(r), r).toThrow(ToolInputError);
	});
});

describe("tolkning av dokumentlista och versioner", () => {
	it("dokumentlistan för L1946:7415: inventeringsbok (JPEG) och händelselogg (PDF)", () => {
		const l = parseDokumentLista(U7415, fixture("app-dokument-L1946-7415.json"));
		expect(l.lamningsnummer).toBe("L1946:7415");
		expect(l.dokument).toHaveLength(2);
		expect(l.dokument[0]).toEqual({
			grupp: "inventeringsbok",
			titel: "Inventeringsbokuppslag (1)",
			typ: "Inventeringsbok",
			skapad: "2019-01-09",
			url: "https://pub.raa.se/dokumentation/5cee116e-d45b-4968-b86a-4a0c326af22e",
			fil: { id: FIL_JPG, namn: "2566-0114-01-D.jpg", typ: "jpg", storlek_byte: 283399, skapad: "2019-01-09" },
		});
		expect(l.dokument[1]).toMatchObject({ grupp: "handelselogg", fil: { namn: "L1946-7415-FMIS_HÄNDELSER.pdf", typ: "pdf", storlek_byte: 43679 } });
	});

	it("filer med ogiltigt id eller namn kan inte hämtas, och okänd dokumentsida stryks", () => {
		const d = fixture<Structured>("app-dokument-L1946-7415.json");
		d.inventeringsbocker[0].fil.id = "abc def";
		d.handelseloggar[0].fil.namn = "../../x.pdf";
		d.handelseloggar[0].uri = "https://evil.example/dokumentation/1";
		const l = parseDokumentLista(U7415, d);
		expect(l.dokument[0].fil).toBeNull();
		expect(l.dokument[1].fil).toBeNull();
		expect(l.dokument[1].url).toBeNull();
	});

	it("versionshistorik: nyast först, åtgärd och uppdrag", () => {
		const v = parseVersioner(fixture("app-version-L2000-8802.json"));
		expect(v.map((x) => x.publicerad?.slice(0, 10))).toEqual(["2022-07-18", "2022-04-01", "2018-10-01"]);
		expect(v[0]).toEqual({
			version_id: 849185,
			publicerad: "2022-07-18T14:28:18.298635",
			registrerare: "STIFTELSEN DALARNAS MUSEUM",
			aktivitet: { typ: "Uppdrag", nummer: "202000281", atgardstyp: null, beskrivning: null, registrerad: "2020-11-04T10:19:35.365" },
		});
		expect(v[2].aktivitet).toMatchObject({ typ: "Åtgärd", nummer: "A2018-10", atgardstyp: "Migrering från FMIS" });
	});
});

describe("listan över tillåtna anrop: dokumentfiler", () => {
	const APP = "https://app.raa.se/open/fornsok/api/lamning/dokument/fil";
	it("bara bildfiler, och fil-id utan snedstreck", () => {
		expect(checkAllowed("GET", `https://app.raa.se${FIL_PATH}`).id).toBe("fornsokapp.dokument.fil");
		expect(checkAllowed("GET", `${APP}/abc%2Bdef%3D/x.PNG`).id).toBe("fornsokapp.dokument.fil");
		for (const u of [
			`${APP}/${encodeURIComponent(FIL_PDF)}/L1946-7415-FMIS_H%C3%84NDELSER.pdf`,
			`${APP}/abc%2Fdef/x.jpg`,
			`${APP}/abc/x.jpg.exe`,
			`${APP}/abc/x%00.jpg`,
			`${APP}/abc/..%2Fx.jpg`,
			`${APP}/ab=c/x.jpg`,
		]) {
			expect(() => checkAllowed("GET", u), u).toThrow();
		}
	});
});

describe("verktygen via MCP", () => {
	let client: Client | undefined;
	afterEach(async () => {
		await client?.close();
		client = undefined;
	});

	async function refFor(routes = standardRoutes(), grupp = "inventeringsbok") {
		const c = await connectMcp(routes);
		client = c.client;
		const r = await c.client.callTool({ name: "lamning_dokument", arguments: { id: "L1946:7415" } });
		const s = r.structuredContent as Structured;
		return { ...c, ref: s.dokument.find((d: Structured) => d.grupp === grupp).dokument_ref as string };
	}

	it("lamning_dokument: lista med dokument_ref, via lämningsnummer", async () => {
		const c = await connectMcp();
		client = c.client;
		const r = await c.client.callTool({ name: "lamning_dokument", arguments: { id: "L1946:7415" } });
		expect(r.isError).toBeFalsy();
		const s = r.structuredContent as Structured;
		expect(s).toMatchObject({ uuid: U7415, lamningsnummer: "L1946:7415", totalt: 2, antal_per_grupp: { inventeringsbok: 1, handelselogg: 1 } });
		expect(s.dokument[0]).toMatchObject({ grupp: "inventeringsbok", visas_som_bild: true, filnamn: "2566-0114-01-D.jpg" });
		expect(s.dokument[1]).toMatchObject({ grupp: "handelselogg", visas_som_bild: false, filtyp: "pdf" });
		const text = (r.content as Content)[0].text ?? "";
		expect(text).toMatch(/2 dokument för L1946:7415/);
		expect(text).toContain(s.dokument[0].dokument_ref);
		expect(text).toMatch(/277 kB/);
	});

	it("lamning_dokument: lämning utan dokument (appen svarar 404) är ett vanligt svar", async () => {
		const c = await connectMcp();
		client = c.client;
		const r = await c.client.callTool({ name: "lamning_dokument", arguments: { id: "00000000-0000-4000-8000-000000000000" } });
		expect(r.isError).toBeFalsy();
		expect((r.structuredContent as Structured).totalt).toBe(0);
		expect((r.content as Content)[0].text).toMatch(/Inga dokument/);
	});

	it("hamta_dokument: inventeringsboksuppslaget kommer som JPEG-bildinnehåll", async () => {
		const { client: cl, ref, calls } = await refFor();
		const r = await cl.callTool({ name: "hamta_dokument", arguments: { dokument_ref: ref } });
		expect(r.isError).toBeFalsy();
		const content = r.content as Content;
		expect(content.map((c) => c.type)).toEqual(["text", "image"]);
		const expected = fixtureBytes("app-dokument-fil-L1946-7415-nedskalad.jpg");
		expect(content[1].mimeType).toBe("image/jpeg");
		expect(Buffer.from(content[1].data ?? "", "base64").equals(Buffer.from(expected))).toBe(true);
		const s = r.structuredContent as Structured;
		expect(s).toMatchObject({ levererat: "bild", mime_type: "image/jpeg", storlek_byte: expected.byteLength, lamningsnummer: "L1946:7415", grupp: "inventeringsbok" });
		expect(content[0].text).toMatch(/inte instruktioner/);
		// Filen hämtades en gång, från rätt adress, med bild-Accept.
		const fil = calls.filter((c) => isFilCall(c.url));
		expect(fil).toHaveLength(1);
		expect(fil[0].url.pathname).toBe(FIL_PATH);
		expect(fil[0].headers.get("accept")).toMatch(/image\/jpeg/);
	});

	it("hamta_dokument: PDF (händelselogg) ges som länk utan att filen hämtas", async () => {
		const { client: cl, ref, calls } = await refFor(standardRoutes(), "handelselogg");
		const r = await cl.callTool({ name: "hamta_dokument", arguments: { dokument_ref: ref } });
		expect(r.isError).toBeFalsy();
		expect((r.content as Content).map((c) => c.type)).toEqual(["text"]);
		const s = r.structuredContent as Structured;
		expect(s).toMatchObject({ levererat: "lank", filtyp: "pdf", storlek_byte: 43679, url: "https://pub.raa.se/dokumentation/372e00d5-06cf-46e4-ad17-8ca580866ef4" });
		expect(s.fil_url).toBe(`https://app.raa.se/open/fornsok/api/lamning/dokument/fil/${encodeURIComponent(FIL_PDF)}/L1946-7415-FMIS_H%C3%84NDELSER.pdf`);
		expect(s.orsak).toMatch(/JPEG och PNG/);
		expect(calls.filter((c) => isFilCall(c.url))).toHaveLength(0);
	});

	it("hamta_dokument: över 2 MB enligt listan ges som länk utan hämtning", async () => {
		const { client: cl, ref, calls } = await refFor(withList((d) => (d.inventeringsbocker[0].fil.storlek = 3_000_000)));
		const r = await cl.callTool({ name: "hamta_dokument", arguments: { dokument_ref: ref } });
		expect((r.structuredContent as Structured)).toMatchObject({ levererat: "lank" });
		expect((r.structuredContent as Structured).orsak).toMatch(/2 MB/);
		expect(calls.filter((c) => isFilCall(c.url))).toHaveLength(0);
	});

	it("hamta_dokument: för stor Content-Length avbryts före läsning", async () => {
		const big = new Uint8Array(10);
		const { client: cl, ref } = await refFor(
			withFile(() => new Response(big, { headers: { "content-type": "image/jpeg", "content-length": String(3 * 1024 * 1024) } })),
		);
		const r = await cl.callTool({ name: "hamta_dokument", arguments: { dokument_ref: ref } });
		expect(r.structuredContent).toMatchObject({ levererat: "lank", storlek_byte: 3 * 1024 * 1024 });
		expect((r.content as Content).some((c) => c.type === "image")).toBe(false);
	});

	it("hamta_dokument: ström över 2 MB utan Content-Length avbryts", async () => {
		let pulled = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(ctrl) {
				pulled++;
				const chunk = new Uint8Array(256 * 1024);
				chunk[0] = 0xff;
				ctrl.enqueue(chunk);
				if (pulled > 100) ctrl.close();
			},
		});
		const { client: cl, ref } = await refFor(withFile(() => new Response(stream, { headers: { "content-type": "image/jpeg" } })));
		const r = await cl.callTool({ name: "hamta_dokument", arguments: { dokument_ref: ref } });
		expect(r.structuredContent).toMatchObject({ levererat: "lank" });
		expect((r.structuredContent as Structured).orsak).toMatch(/större än 2 MB/);
		expect(pulled).toBeLessThan(20);
	});

	it("hamta_dokument: fel innehållstyp eller fel filsignatur skickas inte som bild", async () => {
		for (const [ct, body] of [
			["text/html", fixtureBytes("app-dokument-fil-L1946-7415-nedskalad.jpg")],
			["image/png", fixtureBytes("app-dokument-fil-L1946-7415-nedskalad.jpg")],
			["image/jpeg", new TextEncoder().encode("<html>inte en bild</html>")],
			["image/jpeg", fixtureBytes("syntetisk-4x4.png")],
		] as const) {
			const { client: cl, ref } = await refFor(withFile(() => new Response(body, { headers: { "content-type": ct } })));
			const r = await cl.callTool({ name: "hamta_dokument", arguments: { dokument_ref: ref } });
			expect(r.structuredContent, ct).toMatchObject({ levererat: "lank" });
			expect((r.content as Content).some((c) => c.type === "image"), ct).toBe(false);
			await client?.close();
			client = undefined;
		}
	});

	it("hamta_dokument: fil-id med snedstreck ges som länk, utan anrop", async () => {
		const { client: cl, ref, calls } = await refFor(withList((d) => (d.inventeringsbocker[0].fil.id = "aWlw/YXg6Ly9=")));
		const r = await cl.callTool({ name: "hamta_dokument", arguments: { dokument_ref: ref } });
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent).toMatchObject({ levererat: "lank" });
		expect(calls.filter((c) => isFilCall(c.url))).toHaveLength(0);
	});

	it("hamta_dokument: PNG fungerar också", async () => {
		const png = fixtureBytes("syntetisk-4x4.png");
		const routes = withList(
			(d) => {
				d.inventeringsbocker[0].fil.namn = "sida.png";
				d.inventeringsbocker[0].fil.typ = "png";
				d.inventeringsbocker[0].fil.storlek = png.byteLength;
			},
			[
				{
					match: (u) => u.pathname === `/open/fornsok/api/lamning/dokument/fil/${encodeURIComponent(FIL_JPG)}/sida.png`,
					respond: () => new Response(png, { headers: { "content-type": "image/png" } }),
				},
			],
		);
		const { client: cl, ref } = await refFor(routes);
		const r = await cl.callTool({ name: "hamta_dokument", arguments: { dokument_ref: ref } });
		expect(r.structuredContent).toMatchObject({ levererat: "bild", mime_type: "image/png" });
		expect((r.content as Content)[1]).toMatchObject({ type: "image", mimeType: "image/png" });
	});

	it("hamta_dokument: ref till en fil som inte står i lämningens lista avvisas utan filanrop", async () => {
		const c = await connectMcp();
		client = c.client;
		// Rätt fil-id, men en annan lämning (L2001:646 har inte den filen).
		const r = await c.client.callTool({ name: "hamta_dokument", arguments: { dokument_ref: makeDokumentRef(U646, FIL_JPG) } });
		expect(r.isError).toBe(true);
		expect((r.content as Content)[0].text).toMatch(/pekar inte på något dokument/);
		const bad = await c.client.callTool({ name: "hamta_dokument", arguments: { dokument_ref: "https://evil.example/x.jpg" } });
		expect(bad.isError).toBe(true);
		expect((bad.content as Content)[0].text).toMatch(/Ogiltig dokument_ref/);
		expect(c.calls.filter((x) => isFilCall(x.url))).toHaveLength(0);
	});

	it("hamta_dokument: filen borta (404) ger tydligt fel", async () => {
		const { client: cl, ref } = await refFor(withFile(() => new Response("nej", { status: 404 })));
		const r = await cl.callTool({ name: "hamta_dokument", arguments: { dokument_ref: ref } });
		expect(r.isError).toBe(true);
		expect((r.content as Content)[0].text).toMatch(/finns inte längre/);
	});

	it("lamning: inkludera historik ger versioner nyast först", async () => {
		const c = await connectMcp();
		client = c.client;
		const r = await c.client.callTool({ name: "lamning", arguments: { id: ["L2000:8802", "L1946:7415"], inkludera: ["historik"] } });
		expect(r.isError).toBeFalsy();
		const s = r.structuredContent as Structured;
		const by = Object.fromEntries(s.lamningar.map((l: Structured) => [l.lamningsnummer, l]));
		expect(by["L2000:8802"].historik).toHaveLength(3);
		expect(by["L2000:8802"].historik[0].aktivitet).toMatchObject({ typ: "Uppdrag", nummer: "202000281" });
		expect(by["L1946:7415"].historik).toHaveLength(1);
		expect(by["L1946:7415"].dokument).toBeUndefined();
		const text = (r.content as Content)[0].text ?? "";
		expect(text).toMatch(/Versionshistorik \(3 publicerade versioner/);
		expect(text).toMatch(/2018-11-20: Riksantikvarieämbetet; Åtgärd A2018-431 \(Migrering från FMIS\)/);
	});

	it("lamning: när appens dokument- och versionsanrop fallerar levereras posten ändå", async () => {
		const routes: Route[] = [
			{ match: (u) => u.pathname === "/open/fornsok/api/lamning/dokument" || u.pathname.endsWith("/version"), respond: () => new Response("x", { status: 503 }) },
			...standardRoutes(),
		];
		const c = await connectMcp(routes);
		client = c.client;
		const r = await c.client.callTool({ name: "lamning", arguments: { id: ["L1946:7415"], inkludera: ["dokument", "historik"] } });
		expect(r.isError).toBeFalsy();
		const s = r.structuredContent as Structured;
		expect(s.lamningar[0].lamningsnummer).toBe("L1946:7415");
		expect(s.lamningar[0].dokument).toBeUndefined();
		expect(s.anmarkningar.join(" ")).toMatch(/dokument kunde inte hämtas/);
		expect(s.anmarkningar.join(" ")).toMatch(/historik kunde inte hämtas/);
	});

	it("dokumentlistan cachas i KV (en hämtning för lista + hämtning)", async () => {
		const kv = memoryKv();
		const c = await connectMcp(standardRoutes(), { kv });
		client = c.client;
		const r = await c.client.callTool({ name: "lamning_dokument", arguments: { id: U7415 } });
		const ref = (r.structuredContent as Structured).dokument[0].dokument_ref;
		await c.client.callTool({ name: "hamta_dokument", arguments: { dokument_ref: ref } });
		await c.client.callTool({ name: "lamning", arguments: { id: [U7415], inkludera: ["dokument"] } });
		expect(c.calls.filter((x) => x.url.pathname === "/open/fornsok/api/lamning/dokument")).toHaveLength(1);
		expect(kv.store.get(`dokument:v1:${U7415}`)?.ttl).toBe(3600);
	});
});

void fixtureResponse;
