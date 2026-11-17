/**
 * Indelning (län, kommun, socken, landskap) för en synkad lämning, med samma
 * nycklar som inläsningen skriver i tabellen `omrade` (niva, namn, lan):
 *
 * - län, kommun och landskap: `lan` = ''.
 * - socken: `lan` = '' om namnet bara finns för en socken i värdelistan,
 *   annars sockenns län, valt som Indelning.sockenLan() i ingest/transform.ts
 *   (bland socknens möjliga län som också finns hos lämningen). Så hamnar en
 *   synkad lämning i samma `omrade`-rad som inläsningen gav den.
 *
 * Skillnad mot inläsningen: landskap tas direkt ur Fornsök-appens post (där det
 * finns), i stället för att härledas ur socknen via K-samsök. Namnen är desamma.
 */
import type { Domaner } from "../sources/types";
import type { AppIndelning, SynkPost } from "./post";
import { splitList } from "./post";

export type Niva = "lan" | "kommun" | "socken" | "landskap";

export interface Omrade {
	niva: Niva;
	namn: string;
	lan: string;
	kod: string | null;
}

/** Uppslag ur värdelistorna; byggs en gång per körning. */
export class OmradesRegister {
	private lanKod = new Map<string, string>();
	private kommunKod = new Map<string, string>();
	private kommunLan = new Map<string, string>();
	private socknar = new Map<string, Array<{ id: string; lan: Set<string> }>>();
	private landskapKod = new Map<string, string>();
	private kategorier = new Map<string, string[]>();

	constructor(dom: Domaner) {
		for (const l of dom.lan) this.lanKod.set(l.namn, l.kod);
		const kommunByKod = new Map<string, string>();
		for (const k of dom.kommuner) {
			this.kommunKod.set(k.namn, k.kod);
			this.kommunLan.set(k.namn, k.lan_namn);
			kommunByKod.set(k.kod, k.lan_namn);
		}
		for (const s of dom.socknar) {
			const lan = new Set(
				s.kommunkoder.map((k) => kommunByKod.get(k)).filter((x): x is string => !!x),
			);
			const list = this.socknar.get(s.namn) ?? [];
			list.push({ id: s.id, lan });
			this.socknar.set(s.namn, list);
		}
		for (const l of dom.landskap) this.landskapKod.set(l.namn, l.kod);
		for (const t of dom.lamningstyper) this.kategorier.set(t.namn, t.kategorier);
	}

	kategorierFor(typ: string | null): string[] {
		return typ ? (this.kategorier.get(typ) ?? []) : [];
	}

	/** Som Indelning.sockenLan() i ingest/transform.ts. */
	private sockenLan(socken: string, lan: string[], kommuner: string[]): string {
		const cand = this.socknar.get(socken) ?? [];
		const candLan = new Set<string>();
		for (const c of cand) for (const l of c.lan) candLan.add(l);
		const both = lan.filter((l) => candLan.has(l));
		if (both.length === 1) return both[0];
		if (both.length > 1) {
			const kommunLan = new Set(
				kommuner.map((k) => this.kommunLan.get(k)).filter((x): x is string => !!x),
			);
			return both.find((l) => kommunLan.has(l)) ?? both[0];
		}
		if (candLan.size === 1) return [...candLan][0];
		return lan[0] ?? "";
	}

	private sockenKod(socken: string, lan: string): string | null {
		const cand = (this.socknar.get(socken) ?? []).filter((c) => c.lan.has(lan));
		return cand.length === 1 ? cand[0].id : null;
	}

	omraden(p: SynkPost, ind: AppIndelning): Omrade[] {
		const lan = splitList(p.lan);
		const kommun = splitList(p.kommun);
		const out: Omrade[] = [];
		const add = (o: Omrade) => {
			if (!out.some((x) => x.niva === o.niva && x.namn === o.namn && x.lan === o.lan))
				out.push(o);
		};
		for (const namn of lan) {
			const k = ind.kommuner.find((x) => x.lan === namn)?.lan_kod ?? null;
			add({ niva: "lan", namn, lan: "", kod: k ?? this.lanKod.get(namn) ?? null });
		}
		for (const namn of kommun) {
			const k = ind.kommuner.find((x) => x.namn === namn)?.kod ?? null;
			add({ niva: "kommun", namn, lan: "", kod: k ?? this.kommunKod.get(namn) ?? null });
		}
		for (const s of ind.socknar) {
			const cand = this.socknar.get(s.namn) ?? [];
			if (cand.length <= 1) {
				add({ niva: "socken", namn: s.namn, lan: "", kod: cand[0]?.id ?? s.id ?? null });
				continue;
			}
			const l = this.sockenLan(s.namn, lan, kommun);
			add({ niva: "socken", namn: s.namn, lan: l, kod: this.sockenKod(s.namn, l) });
		}
		for (const l of ind.landskap)
			add({
				niva: "landskap",
				namn: l.namn,
				lan: "",
				kod: l.kod ?? this.landskapKod.get(l.namn) ?? null,
			});
		return out;
	}
}
