import { describe, expect, it } from "vitest";
import { ToolInputError } from "../src/errors";
import { DomainService, domanerProblem } from "../src/lookup/domains";
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

	it("flertydig socken: förslaget skiljer verkligen kandidaterna åt (kommun när länet inte räcker)", async () => {
		const { svc } = service();
		// Ägarens fall: socken Mo med län Västra Götaland. Tre Mo ligger i länet; länet skiljer dem inte åt.
		const err = (await svc.resolveSocknar(["Mo"], { lan: ["Västra Götaland"] }).catch((e) => e)) as ToolInputError;
		expect(err).toBeInstanceOf(ToolInputError);
		expect(err.message).toMatch(/3 socknar heter så/);
		expect(err.message).not.toMatch(/"Mo \(Västra Götaland\)"/);
		expect(err.message).toMatch(/Ange en kvalificerare som skiljer dem åt: "Mo \(Tanum\)", "Mo \(Åmål\)", "Mo \(Skövde\)"\./);
		// Varje förslag ger exakt en socken.
		for (const f of (err.details?.forslag as string[]) ?? []) {
			const [r] = await svc.resolveSocknar([f], { lan: ["Västra Götaland"] });
			expect(r.namn).toBe("Mo");
		}
		// Utan län: Mo i Gävleborg och Västernorrland pekas ut med länet, de andra med kommun.
		const alla = (await svc.resolveSocknar(["Mo"]).catch((e) => e)) as ToolInputError;
		expect(alla.details?.forslag).toEqual(["Mo (Tanum)", "Mo (Åmål)", "Mo (Skövde)", "Mo (Gävleborg)", "Mo (Västernorrland)"]);
	});

	it("kommun där socknen bara har enstaka lämningar (indexets listor, under 5 %): begripligt fel, inte bara 'Ingen socken'", async () => {
		const d = await service().svc.get();
		const munkedal = d.kommuner.find((k) => k.namn === "Munkedal")!;
		const tanum = d.kommuner.find((k) => k.namn === "Tanum")!;
		const amal = d.kommuner.find((k) => k.namn === "Åmål")!;
		const lista: Domaner = {
			...d,
			socknar: [
				{ id: "omrade:1", namn: "Mo", kommunkoder: [tanum.kod, amal.kod], sammanslagen: true, enstaka_kommunkoder: [munkedal.kod] },
				{ id: "c0e16ce1-a20b-40d3-853d-b784212f55ce", namn: "Mo", kommunkoder: ["2182"] },
				{ id: "x", namn: "Bjursås", kommunkoder: ["2080"], enstaka_kommunkoder: ["2026"] },
			],
		};
		const svc = new DomainService({ loadDomaner: async () => lista });
		const err = (await svc.resolveSocknar(["Mo (Munkedal)"]).catch((e) => e)) as ToolInputError;
		expect(err.message).toMatch(/^Ingen socken "Mo" i kommunen Munkedal enligt serverns index: Mo \(Västra Götaland: Tanum, Åmål\) har bara enstaka lämningar i Munkedal \(under 5 % av socknens\)/);
		expect(err.message).toMatch(/sök med kommun Munkedal utan socken/);
		const gagnef = d.kommuner.find((k) => k.kod === "2026")?.namn ?? "Gagnef";
		const err2 = (await svc.resolveSocknar([`Bjursås (${gagnef})`]).catch((e) => e)) as ToolInputError;
		expect(err2.message).toMatch(/bara enstaka lämningar i socknen/);
	});

	it("domanerProblem kontrollerar även län, kategorier, bedömningar, socknarnas form och hämtningsdatum", () => {
		const d = parseDomaner(fixture("app-lamning-domaner.json"), fixture("app-uppdrag-domaner.json"));
		expect(domanerProblem(d)).toBeNull();
		expect(domanerProblem({ ...d, lan: undefined } as unknown as Domaner)).toMatch(/listor saknas: lan/);
		expect(domanerProblem({ ...d, kategorier: "x" } as unknown as Domaner)).toMatch(/kategorier/);
		expect(domanerProblem({ ...d, bedomningar: null } as unknown as Domaner)).toMatch(/bedomningar/);
		expect(domanerProblem({ ...d, hamtad: "igår" })).toMatch(/hämtningsdatum/);
		expect(domanerProblem({ ...d, hamtad: undefined } as unknown as Domaner)).toMatch(/hämtningsdatum/);
		expect(domanerProblem({ ...d, socknar: [{ id: "x", namn: "", kommunkoder: [] }] })).toMatch(/socknar/);
		expect(domanerProblem({ ...d, lan: [{ kod: "20", namn: "" }] })).toMatch(/län utan namn/);
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
