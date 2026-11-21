/**
 * Strikta indataschemor (granskningen av verktygsskiktet, punkt 1): okända
 * parametrar ger verktygsfel som namnger nyckeln och föreslår närmaste
 * giltiga, i stället för att tas bort tyst.
 */
import { describe, expect, it } from "vitest";
import { narmasteParameter, okandaParametrar } from "../src/tools/schema";
import { connectMcp } from "./helpers";

const text = (r: { content?: unknown }) => ((r.content as Array<{ text?: string }>) ?? []).map((c) => c.text ?? "").join("\n");

describe("strikta indataschemor", () => {
	it("närmaste parameter", () => {
		expect(narmasteParameter("radie", ["lat", "lon", "radie_m", "bbox"])).toBe("radie_m");
		expect(narmasteParameter("lamningstype", ["fraga", "lamningstyp", "lan"])).toBe("lamningstyp");
		expect(narmasteParameter("xyzzyabc", ["lat", "lon"])).toBeNull();
		expect(okandaParametrar("lamningar_nara", ["radie"], ["lat", "lon", "radie_m"])).toBe(
			'Okänd parameter "radie" (menade du "radie_m"?) i lamningar_nara. Giltiga parametrar: lat, lon, radie_m.',
		);
	});

	it("alla tolv verktyg avvisar okända nycklar över MCP, och JSON-schemat säger additionalProperties: false", async () => {
		const c = await connectMcp();
		try {
			const { tools } = await c.client.listTools();
			expect(tools).toHaveLength(12);
			for (const t of tools) expect((t.inputSchema as { additionalProperties?: unknown }).additionalProperties, t.name).toBe(false);
			const fall: Array<[string, Record<string, unknown>, RegExp]> = [
				["lamningar_nara", { lat: 60.6, lon: 15.6, radie: 9000 }, /Okänd parameter "radie" \(menade du "radie_m"\?\) i lamningar_nara/],
				["sok_lamningar", { kommun: ["Falun"], lamningstype: ["Hyttområde"] }, /"lamningstype" \(menade du "lamningstyp"\?\)/],
				["sok_lamningar", { fraga: "hytta", nara: { lat: 60.6, lon: 15.6, radius: 500 } }, /Okänd parameter "radius".* i nara\. Giltiga parametrar: lat, lon, radie_m/],
				["sok_lamningar", { egenskap: [{ typ: "Material", varde: "Koppar", vrde: "x" }] }, /i egenskap/],
				["lamning", { id: ["L2001:646"], inkludera_allt: true }, /"inkludera_allt" \(menade du "inkludera"\?\)/],
				["lamning_dokument", { id: "L2001:646", sida: 2 }, /Okänd parameter "sida"/],
				["hamta_dokument", { dokument_ref: "x", storlek: 1 }, /Okänd parameter "storlek"/],
				["relaterat", { id: "L2001:646", typ: ["foto"] }, /Okänd parameter "typ"/],
				["statistik", { gruppera_pa: ["typ"], grupper: ["kommun"] }, /Okänd parameter "grupper"/],
				["uppslag", { lista: "kommuner", soek: "Fal" }, /"soek" \(menade du "sok"\?\)/],
				["hitta_plats", { namn: "Bjursås", lan_namn: "Dalarna" }, /"lan_namn" \(menade du "lan"\?\)/],
				["kb_sok", { fraga: "hytta", nivå: "sida" }, /Okänd parameter "nivå" \(menade du "niva"\?\)/],
				["kb_objekt", { id: "dark-1", sida: 1 }, /Okänd parameter "sida"/],
				["kb_sida", { id: "dark-1", sidnummer: 3 }, /Okänd parameter "sidnummer"/],
			];
			for (const [name, args, re] of fall) {
				const r = await c.client.callTool({ name, arguments: args });
				expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
				expect(text(r)).toMatch(re);
			}
		} finally {
			await c.client.close();
		}
	});
});
