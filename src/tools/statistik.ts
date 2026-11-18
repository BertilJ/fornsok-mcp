import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { strikt } from "./schema";
import type { ResolvedSearchFilter } from "../sources/types";
import { MAX_STATISTIK_RADER, STATISTIK_DIMENSIONER } from "../store/index";
import { READ_ONLY, type ToolDeps, ok, runTool } from "./common";
import { describeFilter, filterShape, resolveEgenskaper, resolveFilter } from "./filter";
import { indexOnly } from "./via_index";

const NIVA_NAMN: Record<(typeof STATISTIK_DIMENSIONER)[number], string> = {
	typ: "lämningstyp",
	kategori: "kategori",
	bedomning: "antikvarisk bedömning",
	lan: "län",
	kommun: "kommun",
	socken: "socken",
	landskap: "landskap",
};

export const statistikInput = strikt("statistik", {
	gruppera_pa: z
		.array(z.enum(STATISTIK_DIMENSIONER))
		.min(1)
		.max(2)
		.describe(
			'En eller två nivåer att gruppera på: typ, kategori, bedomning, lan, kommun, socken, landskap. Två nivåer ger en rad per kombination, t.ex. ["kommun", "typ"].',
		),
	...filterShape,
});

export const statistikOutput = z.object({
	gruppera_pa: z.array(z.enum(STATISTIK_DIMENSIONER)),
	/** Antal lämningar som matchar filtret. */
	totalt: z.number().int(),
	totalt_ungefar: z.boolean().optional(),
	grupper: z.array(z.object({ varden: z.array(z.string()), antal: z.number().int() })),
	/** true om fler än 200 grupper fanns (de största visas). */
	avkortad: z.boolean(),
	kalla: z.string(),
	hamtad_fran: z.string(),
	filter: z.record(z.string(), z.unknown()),
	anmarkningar: z.array(z.string()),
});

type StatistikArgs = z.infer<typeof statistikInput>;

export function registerStatistik(server: McpServer, deps: ToolDeps): void {
	server.registerTool(
		"statistik",
		{
			title: "Statistik över lämningar",
			description:
				"Antal lämningar per grupp: lämningstyp, kategori, antikvarisk bedömning, län, kommun, socken eller landskap, i en eller två nivåer. " +
				"Samma filter som sok_lamningar (fritext, typ, kategori, bedömning, område, egenskap, nara). Högst 200 rader, största grupperna först. " +
				"En lämning räknas i varje grupp den tillhör (t.ex. en lämning i två socknar, eller en typ med två kategorier), så gruppernas summa kan överstiga totalen. " +
				"Kräver serverns eget index.",
			inputSchema: statistikInput,
			outputSchema: statistikOutput,
			annotations: { ...READ_ONLY, title: "Statistik över lämningar" },
		},
		async (args) => runTool(() => statistik(args, deps)),
	);
}

export async function statistik(args: StatistikArgs, deps: ToolDeps) {
	const { gruppera_pa, ...filterArgs } = args;
	return indexOnly(deps, "statistik", async (ix) => {
		const r = await resolveFilter(filterArgs, deps);
		const filter: ResolvedSearchFilter = { ...r.filter };
		if (filter.egenskap?.length) filter.egenskap = resolveEgenskaper(filter.egenskap, await deps.index!.egenskaper());
		const s = await ix.store.statistik(gruppera_pa, filter);
		const anmarkningar = [...r.anmarkningar];
		if (s.avkortad) anmarkningar.push(`Fler än ${MAX_STATISTIK_RADER} grupper; de ${MAX_STATISTIK_RADER} största visas. Avgränsa med filter eller färre nivåer.`);
		if (s.totalt_ungefar) anmarkningar.push("Mycket tätt område: fler kandidater än som kunde prövas mot radien; antalen är undre gränser. Minska radien.");
		if (gruppera_pa.some((d) => d === "kommun" || d === "socken" || d === "kategori" || d === "lan" || d === "landskap")) {
			anmarkningar.push("En lämning räknas i varje grupp den tillhör, så summan av grupperna kan bli större än totalen.");
		}
		const structured = {
			gruppera_pa,
			totalt: s.totalt,
			...(s.totalt_ungefar ? { totalt_ungefar: true } : {}),
			grupper: s.grupper,
			avkortad: s.avkortad,
			kalla: "Lämningsindex (D1)",
			hamtad_fran: ix.hamtad_fran,
			filter: { ...filter } as Record<string, unknown>,
			anmarkningar,
		};
		const villkor = describeFilter(filter);
		const lines: string[] = [];
		lines.push(
			`${s.totalt} lämningar${villkor ? ` (${villkor})` : " i hela registret"}, per ${gruppera_pa.map((d) => NIVA_NAMN[d]).join(" och ")}. Källa: Lämningsindex (D1); ${ix.hamtad_fran}.`,
		);
		for (const g of s.grupper) lines.push(`- ${g.varden.join(" / ")}: ${g.antal}`);
		if (s.totalt === 0) lines.push("Inga lämningar matchar filtret.");
		for (const a of anmarkningar) lines.push(`Obs: ${a}`);
		return ok(lines.join("\n"), structured);
	});
}
