/**
 * Värdelistor (Fornsök-appens `domaner`) cachade i minnet, och uppslag av
 * namn → de värden källorna använder. Okända namn ger svenskt fel med närmaste
 * förslag; flertydig socken ger kandidater med län.
 */
import { DOMAIN_CACHE_TTL_MS } from "../config";
import { ToolInputError } from "../errors";
import type { DomainSource, Domaner, Kommun, Socken } from "../sources/types";
import { LAN, didYouMean, findLan, lanByKod, normalizeName, suggest, suggestLan } from "./names";

export interface ResolvedSocken {
	namn: string;
	/** Länsavgränsning när namnet finns i flera socknar i landet. */
	lan?: string[];
	id: string;
}

export class DomainService {
	private cache: { value: Domaner; at: number } | null = null;
	private inflight: Promise<Domaner> | null = null;

	constructor(
		private readonly source: DomainSource,
		private readonly ttlMs = DOMAIN_CACHE_TTL_MS,
		private readonly now: () => number = Date.now,
	) {}

	/** Hämta värdelistorna (en gång per isolat och TTL; samtidiga anrop delar på samma hämtning). */
	async get(): Promise<Domaner> {
		if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.value;
		if (!this.inflight) {
			this.inflight = this.source
				.loadDomaner()
				.then((value) => {
					this.cache = { value, at: this.now() };
					return value;
				})
				.finally(() => {
					this.inflight = null;
				});
		}
		try {
			return await this.inflight;
		} catch (err) {
			// Hellre gamla listor än inga.
			if (this.cache) return this.cache.value;
			throw err;
		}
	}

	async resolveLamningstyper(names: readonly string[]): Promise<string[]> {
		const d = await this.get();
		const all = d.lamningstyper.map((t) => t.namn);
		return names.map((input) => {
			const hit = all.find((n) => normalizeName(n) === normalizeName(input));
			if (hit) return hit;
			throw new ToolInputError(
				`Okänd lämningstyp "${input}".${didYouMean(suggest(input, all))} Använd verktyget uppslag med lista "lamningstyper" för alla typer.`,
			);
		});
	}

	async resolveKommuner(names: readonly string[]): Promise<Kommun[]> {
		const d = await this.get();
		return names.map((input) => {
			const q = normalizeName(input).replace(/ kommun$/, "");
			const hit = d.kommuner.find((k) => normalizeName(k.namn) === q || k.kod === q);
			if (hit) return hit;
			throw new ToolInputError(`Okänd kommun "${input}".${didYouMean(suggest(q, d.kommuner.map((k) => k.namn)))}`);
		});
	}

	async resolveLandskap(names: readonly string[]): Promise<string[]> {
		const d = await this.get();
		return names.map((input) => {
			const q = normalizeName(input).replace(/ landskap$/, "");
			const hit = d.landskap.find((l) => normalizeName(l.namn) === q || normalizeName(l.kod) === q);
			if (hit) return hit.namn;
			throw new ToolInputError(`Okänt landskap "${input}".${didYouMean(suggest(q, d.landskap.map((l) => l.namn)))}`);
		});
	}

	/** Län via fast tabell (behöver inga värdelistor). */
	resolveLan(names: readonly string[]): string[] {
		return names.map((input) => {
			const hit = findLan(input);
			if (hit) return hit.namn;
			throw new ToolInputError(`Okänt län "${input}".${didYouMean(suggestLan(input))}`);
		});
	}

	/** Län (kortnamn) som en socken ligger i, härlett ur dess kommunkoder. */
	lanForSocken(s: Socken): string[] {
		const out = new Set<string>();
		for (const k of s.kommunkoder) {
			const lan = lanByKod(k.slice(0, 2));
			if (lan) out.add(lan.namn);
		}
		return [...out];
	}

	private describeSocken(s: Socken, d: Domaner): string {
		const lan = this.lanForSocken(s);
		const kommuner = s.kommunkoder
			.map((k) => d.kommuner.find((x) => x.kod === k)?.namn)
			.filter((x): x is string => !!x);
		const kom = kommuner.length ? `: ${[...new Set(kommuner)].join(", ")}` : "";
		return `${s.namn} (${lan.join("/") || "okänt län"}${kom})`;
	}

	/**
	 * Socken: "Näs", "Näs (Jämtland)", "Näs, Jämtland", "Bjursås socken".
	 * Avgränsas av en angiven kvalificerare och av `kontext` (kommun/län i samma
	 * sökning). Flertydigt namn som inte kan avgöras ger fel med kandidater.
	 */
	async resolveSocknar(
		inputs: readonly string[],
		kontext: { kommunkoder?: string[]; lan?: string[] } = {},
	): Promise<ResolvedSocken[]> {
		const d = await this.get();
		return inputs.map((input) => {
			let raw = input.trim();
			let qualifier: string | null = null;
			const paren = /^(.*?)\s*\((.+)\)\s*$/.exec(raw);
			const comma = /^([^,]+),\s*(.+)$/.exec(raw);
			if (paren) [, raw, qualifier] = paren;
			else if (comma) [, raw, qualifier] = comma;
			const q = normalizeName(raw).replace(/ (socken|sn|församling)$/, "");
			let candidates = d.socknar.filter((s) => normalizeName(s.namn) === q);
			if (candidates.length === 0) {
				throw new ToolInputError(`Okänd socken "${input}".${didYouMean(suggest(q, [...new Set(d.socknar.map((s) => s.namn))]))}`);
			}
			const nationallyUnique = candidates.length === 1;
			if (candidates.length > 1 && qualifier) {
				const qual = qualifier;
				const lan = findLan(qual);
				const kommun = d.kommuner.find((k) => normalizeName(k.namn) === normalizeName(qual).replace(/ kommun$/, ""));
				candidates = candidates.filter(
					(s) => (lan && this.lanForSocken(s).includes(lan.namn)) || (kommun && s.kommunkoder.includes(kommun.kod)),
				);
			}
			if (candidates.length > 1 && kontext.kommunkoder?.length) {
				const narrowed = candidates.filter((s) => s.kommunkoder.some((k) => kontext.kommunkoder?.includes(k)));
				if (narrowed.length) candidates = narrowed;
			}
			if (candidates.length > 1 && kontext.lan?.length) {
				const narrowed = candidates.filter((s) => this.lanForSocken(s).some((l) => kontext.lan?.includes(l)));
				if (narrowed.length) candidates = narrowed;
			}
			if (candidates.length === 0) {
				const all = d.socknar.filter((s) => normalizeName(s.namn) === q);
				throw new ToolInputError(
					`Ingen socken "${raw}" i "${qualifier}". Kandidater: ${all.map((s) => this.describeSocken(s, d)).join("; ")}.`,
					{ kandidater: all.map((s) => this.describeSocken(s, d)) },
				);
			}
			if (candidates.length > 1) {
				const list = candidates.map((s) => this.describeSocken(s, d));
				throw new ToolInputError(
					`Socknen "${input}" är flertydig – ${candidates.length} socknar heter så: ${list.join("; ")}. Ange län eller kommun, t.ex. "${candidates[0].namn} (${this.lanForSocken(candidates[0])[0] ?? "län"})".`,
					{ kandidater: list },
				);
			}
			const s = candidates[0];
			return nationallyUnique ? { namn: s.namn, id: s.id } : { namn: s.namn, id: s.id, lan: this.lanForSocken(s) };
		});
	}
}

export { LAN };
