import { describe, expect, it } from "vitest";
import { ToolInputError } from "../src/errors";
import { DomainService } from "../src/lookup/domains";
import { findLan, levenshtein, suggest } from "../src/lookup/names";
import { parseDomaner } from "../src/sources/fornsokapp/parse";
import type { Domaner } from "../src/sources/types";
import { fixture } from "./helpers";

function service(): { svc: DomainService; loads: () => number } {
	let n = 0;
	const d: Domaner = parseDomaner(fixture("app-lamning-domaner.json"), fixture("app-uppdrag-domaner.json"));
	const svc = new DomainService({
		loadDomaner: async () => {
			n++;
			return d;
		},
	});
	return { svc, loads: () => n };
}

describe("län via fast tabell", () => {
	it("normaliserar till K-samsöks kortnamn", () => {
		expect(findLan("Dalarnas län")?.namn).toBe("Dalarna");
		expect(findLan("dalarna")?.namn).toBe("Dalarna");
		expect(findLan("DALARNAS LÄN")?.namn).toBe("Dalarna");
		expect(findLan("Dalarnas")?.namn).toBe("Dalarna");
		expect(findLan("20")?.namn).toBe("Dalarna");
		expect(findLan("W")?.namn).toBe("Dalarna");
		expect(findLan("Kopparbergs län")?.namn).toBe("Dalarna");
		expect(findLan("Västra Götalands län")?.namn).toBe("Västra Götaland");
		expect(findLan("Skåne län")?.namn).toBe("Skåne");
		expect(findLan("Jämtlands län")?.namn).toBe("Jämtland");
		expect(findLan("Atlantis")).toBeNull();
	});

	it("okänt län ger fel med förslag", () => {
		const { svc } = service();
		expect(() => svc.resolveLan(["Dalarnaa"])).toThrow(/Okänt län "Dalarnaa".*Dalarna/);
	});
});

describe("förslag", () => {
	it("levenshtein", () => {
		expect(levenshtein("falun", "falun")).toBe(0);
		expect(levenshtein("faluun", "falun")).toBe(1);
	});
	it("närmaste namn först", () => {
		expect(suggest("Faluun", ["Falun", "Malung", "Borlänge"])[0]).toBe("Falun");
	});
});

describe("namnuppslag mot värdelistorna", () => {
	it("kommun, skiftlägesokänsligt, med ' kommun' och kod", async () => {
		const { svc } = service();
		const [a, b, c] = await svc.resolveKommuner(["falun", "Falun kommun", "2080"]);
		expect(a.namn).toBe("Falun");
		expect(b.kod).toBe("2080");
		expect(c.lan_namn).toBe("Dalarna");
	});

	it("okänd kommun ger fel med närmaste förslag", async () => {
		const { svc } = service();
		await expect(svc.resolveKommuner(["Faluun"])).rejects.toThrow(/Okänd kommun "Faluun".*"Falun"/);
		await expect(svc.resolveKommuner(["Faluun"])).rejects.toBeInstanceOf(ToolInputError);
	});

	it("lämningstyp, skiftlägesokänsligt, och förslag vid fel", async () => {
		const { svc } = service();
		expect(await svc.resolveLamningstyper(["hyttområde", "KÄLLA MED TRADITION"])).toEqual(["Hyttområde", "Källa med tradition"]);
		await expect(svc.resolveLamningstyper(["Hyttomrade"])).rejects.toThrow(/Hyttområde/);
	});

	it("landskap", async () => {
		const { svc } = service();
		expect(await svc.resolveLandskap(["dalarna", "Jä"])).toEqual(["Dalarna", "Jämtland"]);
		await expect(svc.resolveLandskap(["Dalarnas län"])).rejects.toThrow(/Okänt landskap/);
	});

	it("entydig socken", async () => {
		const { svc } = service();
		expect(await svc.resolveSocknar(["bjursås", "Stora Kopparberg socken"])).toEqual([
			expect.objectContaining({ namn: "Bjursås" }),
			expect.objectContaining({ namn: "Stora Kopparberg" }),
		]);
		const [b] = await svc.resolveSocknar(["Bjursås"]);
		expect(b.lan).toBeUndefined();
	});

	it("flertydig socken ger kandidater med län", async () => {
		const { svc } = service();
		const err = await svc.resolveSocknar(["Näs"]).catch((e) => e);
		expect(err).toBeInstanceOf(ToolInputError);
		expect(err.message).toMatch(/flertydig/);
		expect(err.message).toMatch(/Näs \(Jämtland/);
		expect(err.message).toMatch(/Näs \(Gotland/);
		expect((err as ToolInputError).details?.kandidater).toHaveLength(3);
	});

	it("flertydig socken avgörs av län eller kommun", async () => {
		const { svc } = service();
		const [a] = await svc.resolveSocknar(["Näs (Gotland)"]);
		expect(a).toMatchObject({ namn: "Näs", lan: ["Gotland"] });
		const [b] = await svc.resolveSocknar(["Näs, Jämtlands län"]);
		expect(b.lan).toEqual(["Jämtland"]);
		const [c] = await svc.resolveSocknar(["Näs"], { lan: ["Gotland"] });
		expect(c.lan).toEqual(["Gotland"]);
		await expect(svc.resolveSocknar(["Näs (Skåne)"])).rejects.toThrow(/Kandidater/);
	});

	it("okänd socken ger förslag", async () => {
		const { svc } = service();
		await expect(svc.resolveSocknar(["Bjursas"])).rejects.toThrow(/Bjursås/);
	});

	it("värdelistorna hämtas en gång och cachas", async () => {
		const { svc, loads } = service();
		await Promise.all([svc.get(), svc.get(), svc.resolveKommuner(["Falun"])]);
		await svc.get();
		expect(loads()).toBe(1);
	});

	it("värdelistorna har förväntad omfattning", async () => {
		const { svc } = service();
		const d = await svc.get();
		expect(d.lamningstyper).toHaveLength(169);
		expect(d.kategorier).toHaveLength(12);
		expect(d.bedomningar).toHaveLength(5);
		expect(d.kommuner).toHaveLength(290);
		expect(d.socknar).toHaveLength(2434);
		expect(d.landskap).toHaveLength(25);
		expect(d.lan).toHaveLength(21);
	});
});
