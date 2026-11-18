/**
 * Värdelistor (Fornsök-appens `domaner`) cachade i minnet, och uppslag av
 * namn → de värden källorna använder. Okända namn ger svenskt fel med närmaste
 * förslag; flertydig socken ger kandidater med län.
 */
import { DOMAIN_CACHE_TTL_MS } from "../config";
import { ToolInputError, UpstreamError } from "../errors";
import type { DomainSource, Domaner, Kommun, Socken } from "../sources/types";
import { LAN, didYouMean, findLan, lanByKod, normalizeName, suggest, suggestLan } from "./names";

export interface ResolvedSocken {
	namn: string;
	/** Länsavgränsning när namnet finns i flera socknar i landet. */
	lan?: string[];
	/** Kommunavgränsning när namnet finns i flera socknar i samma län. */
	kommun?: string[];
	/** Upplysning till svaret, t.ex. när avgränsningen inte kan bli exakt. */
	anmarkning?: string;
	id: string;
}

/** Hur länge ett misslyckat hämtförsök gör att nya försök väntar (felcache). */
export const DOMAIN_ERROR_TTL_MS = 15_000;
/** Listor byggda ur indexet i väntan på appens kopia (Domaner.kortlivad) cachas högst så länge. */
export const DOMAIN_KORT_TTL_MS = 60_000;
/** Längsta väntan på en annan förfrågans pågående hämtning innan man hämtar själv. */
export const DOMAIN_SHARED_WAIT_MS = 25_000;

/** Är värdelistorna rimligt kompletta? Tomma eller trasiga listor cachas aldrig. */
export function domanerProblem(d: Domaner | null | undefined): string | null {
	if (!d || typeof d !== "object") return "saknas";
	const tomma = (["lamningstyper", "kommuner", "socknar", "landskap"] as const).filter((k) => !Array.isArray(d[k]) || d[k].length === 0);
	if (tomma.length) return `tomma listor: ${tomma.join(", ")}`;
	if (d.lamningstyper.some((t) => !t.namn) || d.kommuner.some((k) => !k.namn || !k.kod)) return "poster utan namn eller kod";
	return null;
}

/** Okänt namn (inte flertydigt): DomainService prövar då reservlistan, om den finns. */
export class OkantNamnError extends ToolInputError {
	constructor(message: string, details?: Record<string, unknown>) {
		super(message, details);
		this.name = "OkantNamnError";
	}
}

export class DomainService {
	/**
	 * Reserv för namn som saknas i listorna (t.ex. Fornsök-appens listor när de
	 * primära kommer ur ett index som bara har en del av landet). Prövas bara vid
	 * okänt namn; går den inte att nå gäller det ursprungliga felet (med förslag).
	 */
	reserv?: DomainService;
	private cache: { value: Domaner; at: number } | null = null;
	private inflight: Promise<Domaner> | null = null;
	private failure: { error: unknown; at: number } | null = null;

	constructor(
		private readonly source: DomainSource,
		private readonly ttlMs = DOMAIN_CACHE_TTL_MS,
		private readonly now: () => number = Date.now,
		private readonly errorTtlMs = DOMAIN_ERROR_TTL_MS,
		private readonly sharedWaitMs = DOMAIN_SHARED_WAIT_MS,
	) {}

	private load(): Promise<Domaner> {
		const p = this.source.loadDomaner().then((value) => {
			const problem = domanerProblem(value);
			if (problem) throw new UpstreamError("fornsokapp", `Fornsök-appens värdelistor var ofullständiga (${problem})`);
			this.cache = { value, at: this.now() };
			this.failure = null;
			return value;
		});
		const guarded = p.catch((err: unknown) => {
			this.failure = { error: err, at: this.now() };
			throw err;
		});
		this.inflight = guarded;
		void guarded
			.catch(() => {})
			.finally(() => {
				if (this.inflight === guarded) this.inflight = null;
			});
		return guarded;
	}

	/**
	 * Hämta värdelistorna: minnescache (TTL), annars källan (med KV framför).
	 * Samtidiga anrop delar på en pågående hämtning, men den som väntar på en
	 * hämtning som en annan förfrågan startat gör ett eget försök om den
	 * misslyckas eller dröjer (en avbruten förfrågan ska inte ge sitt fel eller
	 * sin hängning till andra). Ett misslyckande cachas kort.
	 */
	async get(): Promise<Domaner> {
		const t = this.now();
		const ttl = this.cache?.value.kortlivad ? Math.min(this.ttlMs, DOMAIN_KORT_TTL_MS) : this.ttlMs;
		if (this.cache && t - this.cache.at < ttl) return this.cache.value;
		if (this.failure && t - this.failure.at < this.errorTtlMs && t >= this.failure.at) {
			if (this.cache) return this.cache.value;
			throw this.failure.error;
		}
		try {
			if (this.inflight) {
				try {
					return await withTimeout(this.inflight, this.sharedWaitMs);
				} catch {
					// Den delade hämtningen misslyckades eller dröjde: försök själv en gång.
					return await this.load();
				}
			}
			return await this.load();
		} catch (err) {
			// Hellre gamla listor än inga.
			if (this.cache) return this.cache.value;
			throw err;
		}
	}

	private async reservVid<T>(e: unknown, f: (r: DomainService) => Promise<T>): Promise<T> {
		if (!(e instanceof OkantNamnError) || !this.reserv) throw e;
		try {
			return await f(this.reserv);
		} catch (e2) {
			if (e2 instanceof ToolInputError) throw e2;
			console.warn("värdelistor: reservlistan gick inte att nå:", e2 instanceof Error ? e2.message : String(e2));
			throw e;
		}
	}

	async resolveLamningstyper(names: readonly string[]): Promise<string[]> {
		try {
			const d = await this.get();
			const all = d.lamningstyper.map((t) => t.namn);
			return names.map((input) => {
				const hit = all.find((n) => normalizeName(n) === normalizeName(input));
				if (hit) return hit;
				throw new OkantNamnError(
					`Okänd lämningstyp "${input}".${didYouMean(suggest(input, all))} Använd verktyget uppslag med lista "lamningstyper" för alla typer.`,
				);
			});
		} catch (e) {
			return this.reservVid(e, (r) => r.resolveLamningstyper(names));
		}
	}

	/** Kategorier (exakta namn) med närmaste förslag vid okänt namn. */
	async resolveKategorier(names: readonly string[]): Promise<string[]> {
		try {
			const d = await this.get();
			const all = d.kategorier.length ? d.kategorier : [...new Set(d.lamningstyper.flatMap((t) => t.kategorier))];
			return names.map((input) => {
				const hit = all.find((n) => normalizeName(n) === normalizeName(input));
				if (hit) return hit;
				throw new OkantNamnError(
					`Okänd kategori "${input}".${didYouMean(suggest(input, all))} Använd verktyget uppslag med lista "kategorier" för alla kategorier.`,
				);
			});
		} catch (e) {
			return this.reservVid(e, (r) => r.resolveKategorier(names));
		}
	}

	/** Alla lämningstyper (även inaktiva, som finns kvar på äldre poster) i någon av kategorierna. */
	async lamningstyperIKategorier(kategorier: readonly string[]): Promise<string[]> {
		const d = await this.get();
		const set = new Set(kategorier);
		return d.lamningstyper.filter((t) => t.kategorier.some((k) => set.has(k))).map((t) => t.namn);
	}

	async resolveKommuner(names: readonly string[]): Promise<Kommun[]> {
		try {
			const d = await this.get();
			return names.map((input) => {
				const q = normalizeName(input).replace(/ kommun$/, "");
				const hit = d.kommuner.find((k) => normalizeName(k.namn) === q || k.kod === q);
				if (hit) return hit;
				throw new OkantNamnError(`Okänd kommun "${input}".${didYouMean(suggest(q, d.kommuner.map((k) => k.namn)))}`);
			});
		} catch (e) {
			return this.reservVid(e, (r) => r.resolveKommuner(names));
		}
	}

	async resolveLandskap(names: readonly string[]): Promise<string[]> {
		try {
			const d = await this.get();
			return names.map((input) => {
				const q = normalizeName(input).replace(/ landskap$/, "");
				const hit = d.landskap.find((l) => normalizeName(l.namn) === q || normalizeName(l.kod) === q);
				if (hit) return hit.namn;
				throw new OkantNamnError(`Okänt landskap "${input}".${didYouMean(suggest(q, d.landskap.map((l) => l.namn)))}`);
			});
		} catch (e) {
			return this.reservVid(e, (r) => r.resolveLandskap(names));
		}
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
		try {
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
					throw new OkantNamnError(`Okänd socken "${input}".${didYouMean(suggest(q, [...new Set(d.socknar.map((s) => s.namn))]))}`);
				}
				const nationallyUnique = candidates.length === 1;
				if (nationallyUnique && qualifier) {
					// En kvalificerare som motsäger en entydig socken ska inte tas tyst.
					const s = candidates[0];
					const qual = qualifier;
					const lan = findLan(qual);
					const kommun = d.kommuner.find((k) => normalizeName(k.namn) === normalizeName(qual).replace(/ kommun$/, ""));
					const matches = (lan && this.lanForSocken(s).includes(lan.namn)) || (kommun && s.kommunkoder.includes(kommun.kod));
					if (!matches) {
						throw new ToolInputError(
							`Socknen "${s.namn}" finns bara i ${this.describeSocken(s, d)}, inte i "${qual}". Ange socknen utan kvalificerare eller med rätt län/kommun.`,
							{ kandidater: [this.describeSocken(s, d)] },
						);
					}
				}
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
				if (s.sammanslagen) return this.sammanslagenSocken(s, d, input, qualifier, kontext);
				if (nationallyUnique) return { namn: s.namn, id: s.id };
				const lan = this.lanForSocken(s);
				const out: ResolvedSocken = { namn: s.namn, id: s.id, lan };
				// Samma namn i samma län (t.ex. Mo, Råda, Torp i Västra Götaland): län räcker inte,
				// K-samsök har inget socken-id – avgränsa även på socknens kommuner.
				const sameLan = d.socknar.filter((x) => x !== s && normalizeName(x.namn) === q && this.lanForSocken(x).some((l) => lan.includes(l)));
				if (sameLan.length) {
					const kommunNamn = (koder: string[]) =>
						[...new Set(koder.map((k) => d.kommuner.find((x) => x.kod === k)?.namn).filter((x): x is string => !!x))];
					out.kommun = kommunNamn(s.kommunkoder);
					const andras = new Set(sameLan.flatMap((x) => x.kommunkoder));
					const delade = kommunNamn(s.kommunkoder.filter((k) => andras.has(k)));
					if (out.kommun.length === 0) {
						delete out.kommun;
						out.anmarkning = `Det finns flera socknar som heter ${s.namn} i ${lan.join("/")}, och socknens kommun är okänd; träffarna kan omfatta alla.`;
					} else if (delade.length) {
						out.anmarkning = `Det finns flera socknar som heter ${s.namn} i ${lan.join("/")}; avgränsat till kommun ${out.kommun.join(", ")}, men ${delade.join(", ")} har också en annan socken ${s.namn}, så träffar där kan höra till den.`;
					} else {
						out.anmarkning = `Det finns flera socknar som heter ${s.namn} i ${lan.join("/")}; avgränsat till kommun ${out.kommun.join(", ")}.`;
					}
				}
				return out;
			});
		} catch (e) {
			return this.reservVid(e, (r) => r.resolveSocknar(inputs, kontext));
		}
	}

	/**
	 * En socken som indexet slagit ihop med andra med samma namn i samma län
	 * (listor ur indexet utan appens kopia). Med en kommun (kvalificerare eller
	 * kommunfilter) avgränsas sökningen till socknens lämningar i kommunen, och
	 * svaret säger det; utan kommun går namnet inte att avgöra.
	 */
	private sammanslagenSocken(s: Socken, d: Domaner, input: string, qualifier: string | null, kontext: { kommunkoder?: string[] }): ResolvedSocken {
		const lan = this.lanForSocken(s);
		const lanText = lan.join("/") || "samma län";
		const namnFor = (koder: string[]) => [...new Set(koder.map((k) => d.kommuner.find((x) => x.kod === k)?.namn).filter((x): x is string => !!x))];
		const qualKommun = qualifier ? d.kommuner.find((k) => normalizeName(k.namn) === normalizeName(qualifier).replace(/ kommun$/, "")) : undefined;
		const koder = (qualKommun ? [qualKommun.kod] : (kontext.kommunkoder ?? [])).filter((k) => s.kommunkoder.includes(k));
		const kommuner = namnFor(koder);
		const alla = namnFor(s.kommunkoder);
		if (!kommuner.length) {
			throw new ToolInputError(
				`Socknen "${input}" är flertydig: det finns flera socknar som heter ${s.namn} i ${lanText}, och serverns index skiljer inte på dem (Fornsök-appens värdelista, som gör det, gick inte att hämta). ` +
					`Ange kommun, t.ex. "${s.namn} (${alla[0] ?? "kommun"})"${alla.length ? `. Kommuner där indexet har lämningar i en socken ${s.namn} i ${lanText}: ${alla.join(", ")}` : ""}.`,
				{ kandidater: alla.map((k) => `${s.namn} (${k})`) },
			);
		}
		return {
			namn: s.namn,
			id: s.id,
			...(lan.length ? { lan } : {}),
			kommun: kommuner,
			anmarkning:
				`Det finns flera socknar som heter ${s.namn} i ${lanText}, och serverns index skiljer inte på dem (Fornsök-appens värdelista gick inte att hämta). ` +
				`Sökningen gäller lämningar i en socken ${s.namn} som ligger i ${kommuner.join(", ")} kommun; ligger fler av socknarna i samma kommun kan träffar från dem komma med.`,
		};
	}
}

export { LAN };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("timeout")), ms);
	});
	return Promise.race([p, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}
