/**
 * Kontrakt: RAÄ:s ändringsflöde (`pub.raa.se/datauttag/lamningar`), den enda
 * automatiska trafiken från nattsynken (SPEC 9.1). Svarsform och sidindelning
 * prövas för gårdagen (UTC). Är den för tunn för att ge två sidor används ett
 * veckofönster i stället, men aldrig fler än fyra anrop.
 */
import { describe, it } from "vitest";
import { flodeUrl, parseFlodeSida } from "../../src/sync/flode";
import { en, hamta, jsonSvar, Kontroll, skapaKlient, sokvag, tolka } from "./stod";

const KALLA = "raa_datauttag" as const;
const klient = skapaKlient();
const STORLEK = 3;

const dag = (offsetDagar: number): string => new Date(Date.now() + offsetDagar * 86_400_000).toISOString().slice(0, 10);
const TILL = dag(-1);
const DYGN_FRAN = TILL;
const VECKA_FRAN = dag(-7);

const sida = (fran: string, till: string, nr: number) => {
	const anrop = `GET datauttag/lamningar?from=${fran}&to=${till}&page=${nr}&size=${STORLEK}`;
	return {
		anrop,
		hamta: en(async () => {
			const res = await hamta(KALLA, anrop, () => klient.get(flodeUrl(fran, till, nr, STORLEK)));
			return { res, data: jsonSvar(KALLA, anrop, res) as Record<string, unknown> };
		}),
	};
};

const dygn0 = sida(DYGN_FRAN, TILL, 0);
const dygn1 = sida(DYGN_FRAN, TILL, 1);
const vecka0 = sida(VECKA_FRAN, TILL, 0);
const vecka1 = sida(VECKA_FRAN, TILL, 1);

/** Dygnet om det ger minst två sidor, annars veckan. */
const underlag = en(async () => {
	const forsta = await dygn0.hamta();
	const total = sokvag(forsta.data, "totalElements");
	if (typeof total === "number" && total > STORLEK) {
		return { period: `${DYGN_FRAN}` as string, a: { ...dygn0, ...forsta }, b: { ...dygn1, ...(await dygn1.hamta()) } };
	}
	const v0 = await vecka0.hamta();
	const v1 = await vecka1.hamta();
	return { period: `${VECKA_FRAN}–${TILL}`, a: { ...vecka0, ...v0 }, b: { ...vecka1, ...v1 } };
});

function kontrolleraSida(anrop: string, data: Record<string, unknown>, forvantadStorlek = STORLEK): Kontroll {
	const k = new Kontroll(KALLA, anrop);
	k.typ(data, "content", "array");
	k.typ(data, "totalPages", "number");
	k.typ(data, "totalElements", "number");
	k.typ(data, "last", "boolean");
	const content = Array.isArray(data.content) ? (data.content as Array<Record<string, unknown>>) : [];
	k.krav(content.length <= forvantadStorlek, "content", `fler poster (${content.length}) än begärd sidstorlek (size=${forvantadStorlek})`);
	content.forEach((_, i) => {
		const p = `content[${i}]`;
		k.typ(content, `[${i}].id`, "uuid");
		k.typ(content, `[${i}].lamningsnummer`, "nonEmptyString");
		k.krav(/^L\d{4}:\d+$/.test(String(sokvag(content, `[${i}].lamningsnummer`))), `${p}.lamningsnummer`, `väntade L####:#, fick ${JSON.stringify(sokvag(content, `[${i}].lamningsnummer`))}`);
		k.typ(content, `[${i}].uppdateringstyp`, "array");
		const typer = sokvag(content, `[${i}].uppdateringstyp`);
		k.krav(Array.isArray(typer) && typer.length > 0 && typer.every((t) => typeof t === "string" && /^[A-Z_]{1,60}$/.test(t)), `${p}.uppdateringstyp`, `väntade en icke-tom lista med VERSALER_MED_UNDERSTRECK (NY, UTGAR, UPPDATERAD_…), fick ${JSON.stringify(typer)}`);
	});
	return k;
}

describe("Ändringsflödet (pub.raa.se/datauttag/lamningar)", () => {
	it("svarsform för gårdagen: sidobjekt och poster med id, lämningsnummer och uppdateringstyp", async () => {
		const { res, data } = await dygn0.hamta();
		const k = kontrolleraSida(dygn0.anrop, data);
		k.krav(res.contentType.includes("json"), "content-type", `väntade JSON, fick ${res.contentType || "saknas"}`);
		k.klar();
	});

	it("projektets tolkare (parseFlodeSida) ger poster med UUID och sidindelning", async () => {
		const { data } = await dygn0.hamta();
		const s = tolka(KALLA, dygn0.anrop, "parseFlodeSida", () => parseFlodeSida(data));
		const k = new Kontroll(KALLA, dygn0.anrop);
		const rader = Array.isArray(data.content) ? data.content.length : 0;
		k.krav(s.poster.length === rader, "content[].id", `${rader - s.poster.length} av ${rader} poster föll bort i tolkningen (id är inte ett giltigt UUID?)`);
		k.krav(s.poster.every((p) => p.typer.length > 0), "content[].uppdateringstyp", "post utan uppdateringstyp efter tolkning");
		k.typ(s, "totalPages", "number");
		k.typ(s, "totalElements", "number");
		k.typ(s, "last", "boolean");
		k.klar();
	});

	it("sidindelning: sida 0 och 1 hänger ihop (totalPages, last, olika poster)", async () => {
		const { period, a, b } = await underlag();
		const anrop = `${a.anrop} + page=1 (${period})`;
		const k = new Kontroll(KALLA, anrop);
		k.krav(Number(a.data.totalElements) > STORLEK, "totalElements", `ändringsflödet för ${period} ger för få poster (${String(a.data.totalElements)}) för att pröva sidindelning; försök igen en annan dag`);
		const total = Number(a.data.totalElements);
		const sidor = Number(a.data.totalPages);
		k.krav(sidor === Math.ceil(total / STORLEK), "totalPages", `väntade ceil(${total}/${STORLEK}) = ${Math.ceil(total / STORLEK)}, fick ${sidor}`);
		k.lika(a.data, "last", sidor <= 1);
		k.krav(Array.isArray(a.data.content) && a.data.content.length === STORLEK, "content", `första sidan ska vara full (${STORLEK} poster), fick ${Array.isArray(a.data.content) ? a.data.content.length : "ingen lista"}`);
		const k2 = kontrolleraSida(b.anrop, b.data);
		k.krav(Number(b.data.totalPages) === sidor, "totalPages", `sida 1 anger ${String(b.data.totalPages)}, sida 0 anger ${sidor}`);
		k.krav(Number(b.data.totalElements) === total, "totalElements", `sida 1 anger ${String(b.data.totalElements)}, sida 0 anger ${total}`);
		const idA = new Set((a.data.content as Array<{ id: string }>).map((p) => p.id));
		// Koden tål dubbletter mellan sidor (hamtaFlode slår ihop dem), så bara det grova prövas:
		// sida 1 ska inte vara en kopia av sida 0, annars har `page` slutat verka.
		const idB = ((b.data.content ?? []) as Array<{ id: string }>).map((p) => p.id);
		k.krav(idB.length === 0 || idB.some((id) => !idA.has(id)), "page", "sida 1 innehåller exakt samma poster som sida 0 (page verkar inte längre styra urvalet)");
		k.krav(Array.isArray(b.data.content) && b.data.content.length >= 1, "content", "sida 1 är tom fast totalPages anger fler sidor");
		k.klar();
		k2.klar();
	});
});
