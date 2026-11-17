import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { LAN, normalizeName } from "../lookup/names";
import { READ_ONLY, type ToolDeps, ok, runTool } from "./common";

const LISTOR = ["lamningstyper", "kategorier", "bedomningar", "egenskapstyper", "kommuner", "socknar", "landskap", "lan"] as const;
const MAX_ROWS = 200;

export const uppslagInput = z.object({
	lista: z.enum(LISTOR).describe("Vilken värdelista."),
	sok: z.string().min(1).max(100).optional().describe("Delsträng att filtrera på (skiftlägesokänsligt)."),
});

const varde = z.object({
	namn: z.string(),
	kod: z.string().optional(),
	kategori: z.array(z.string()).optional(),
	aktiv: z.boolean().optional(),
	beskrivning: z.string().nullable().optional(),
	lan: z.array(z.string()).optional(),
	kommuner: z.array(z.string()).optional(),
	fullstandigt_namn: z.string().optional(),
});

export const uppslagOutput = z.object({
	lista: z.enum(LISTOR),
	sok: z.string().nullable(),
	totalt: z.number().int(),
	visade: z.number().int(),
	varden: z.array(varde),
	kalla: z.string(),
	anmarkning: z.string().optional(),
});

type UppslagArgs = z.infer<typeof uppslagInput>;
type Varde = z.infer<typeof varde>;

export function registerUppslag(server: McpServer, deps: ToolDeps): void {
	server.registerTool(
		"uppslag",
		{
			title: "Värdelistor",
			description:
				"Värdelistor i Kulturmiljöregistret: lämningstyper (med kategori), kategorier, antikvariska bedömningar, kommuner, socknar (med län och kommuner), landskap och län. " +
				"Använd för att hitta exakta namn till filtren i sok_lamningar och lamningar_nara. `sok` filtrerar på delsträng; högst 200 rader visas.",
			inputSchema: uppslagInput,
			outputSchema: uppslagOutput,
			annotations: { ...READ_ONLY, title: "Värdelistor" },
		},
		async (args) => runTool(() => uppslag(args, deps)),
	);
}

export async function uppslag(args: UppslagArgs, deps: ToolDeps) {
	let varden: Varde[] = [];
	let kalla = "Fornsök-appens värdelistor (cachade)";
	let anmarkning: string | undefined;

	if (args.lista === "lan") {
		kalla = "Fast tabell i servern";
		varden = LAN.map((l) => ({ namn: l.namn, kod: l.kod, fullstandigt_namn: l.fullt }));
	} else if (args.lista === "egenskapstyper") {
		kalla = "–";
		anmarkning =
			"Egenskapstyper finns inte i Fornsök-appens värdelistor; listan kommer med det egna indexet. Egenskaper syns per lämning via verktyget lamning.";
	} else {
		const d = await deps.domains.get();
		switch (args.lista) {
			case "lamningstyper":
				varden = d.lamningstyper.map((t) => ({ namn: t.namn, kategori: t.kategorier, aktiv: t.aktiv }));
				break;
			case "kategorier":
				varden = d.kategorier.map((namn) => ({ namn }));
				break;
			case "bedomningar":
				varden = d.bedomningar.map((b) => ({ namn: b.namn, beskrivning: b.beskrivning }));
				break;
			case "kommuner":
				varden = d.kommuner.map((k) => ({ namn: k.namn, kod: k.kod, lan: [k.lan_namn] }));
				break;
			case "landskap":
				varden = d.landskap.map((l) => ({ namn: l.namn, kod: l.kod }));
				break;
			case "socknar":
				varden = d.socknar.map((s) => ({
					namn: s.namn,
					lan: deps.domains.lanForSocken(s),
					kommuner: [...new Set(s.kommunkoder.map((k) => d.kommuner.find((x) => x.kod === k)?.namn).filter((x): x is string => !!x))],
				}));
				break;
		}
	}

	if (args.sok) {
		const q = normalizeName(args.sok);
		varden = varden.filter((v) => normalizeName(v.namn).includes(q) || (v.fullstandigt_namn && normalizeName(v.fullstandigt_namn).includes(q)));
	}
	varden.sort((a, b) => a.namn.localeCompare(b.namn, "sv"));
	const totalt = varden.length;
	const shown = varden.slice(0, MAX_ROWS);
	if (totalt > MAX_ROWS) anmarkning = `Visar ${MAX_ROWS} av ${totalt}. Avgränsa med sok.`;

	const structured = { lista: args.lista, sok: args.sok ?? null, totalt, visade: shown.length, varden: shown, kalla, ...(anmarkning ? { anmarkning } : {}) };
	const lines: string[] = [];
	lines.push(`${args.lista}${args.sok ? ` som innehåller "${args.sok}"` : ""}: ${totalt} värden.`);
	for (const v of shown) {
		const extra = [
			v.kod ? `kod ${v.kod}` : null,
			v.kategori?.length ? v.kategori.join(", ") : null,
			v.lan?.length ? `län ${v.lan.join("/")}` : null,
			v.kommuner?.length ? `kommun ${v.kommuner.join(", ")}` : null,
			v.aktiv === false ? "inaktiv" : null,
			v.beskrivning ?? null,
		].filter(Boolean);
		lines.push(`- ${v.namn}${extra.length ? ` (${extra.join("; ")})` : ""}`);
	}
	if (anmarkning) lines.push(`Obs: ${anmarkning}`);
	return ok(lines.join("\n"), structured);
}
