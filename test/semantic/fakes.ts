/**
 * Falska bindningar för AI (bge-m3) och VECTORIZE. Den falska modellen ger en
 * ordpåse-vektor (1 024 dimensioner, normerad), så att texter med samma ord
 * hamnar nära varandra. Den falska Vectorize följer de dokumenterade gränserna
 * (topK ≤ 100 utan metadata, filter < 2 048 byte, upsert ≤ 1 000, id ≤ 64 byte)
 * och filtrerar på metadata med $eq/$in som Vectorize.
 */
import type { AiLike, VectorizeLike } from "../../src/semantic/bindings";

export function bagOfWords(text: string): number[] {
	const v = new Array<number>(1024).fill(0);
	for (const w of text.toLocaleLowerCase("sv").match(/[\p{L}\p{N}]+/gu) ?? []) {
		let h = 2166136261;
		for (const ch of w) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
		v[h % 1024] += 1;
	}
	const n = Math.hypot(...v) || 1;
	return v.map((x) => x / n);
}

export class FakeAi implements AiLike {
	calls: string[][] = [];
	fail = false;
	/** Fallera anropet om någon text uppfyller villkoret (en text som modellen avvisar). */
	failIf?: (text: string) => boolean;
	async run(_model: "@cf/baai/bge-m3", inputs: { text: string[]; truncate_inputs?: boolean }) {
		if (this.fail) throw new Error("AI nere");
		if (this.failIf && inputs.text.some(this.failIf)) throw new Error("AiError: 3010: Invalid input");
		this.calls.push(inputs.text);
		return {
			shape: [inputs.text.length, 1024],
			data: inputs.text.map(bagOfWords),
			pooling: "cls",
		};
	}
}

type Meta = Record<string, VectorizeVectorMetadata>;

export class FakeVectorize implements VectorizeLike {
	store = new Map<string, { values: number[]; metadata: Meta }>();
	upserts = 0;
	deletes: string[] = [];
	queries: Array<{ topK?: number; filter?: unknown }> = [];

	async upsert(vectors: VectorizeVector[]) {
		if (vectors.length > 1000) throw new Error("för många vektorer i en upsert");
		this.upserts++;
		for (const v of vectors) {
			if (new TextEncoder().encode(v.id).length > 64) throw new Error("för långt id");
			this.store.set(v.id, { values: [...v.values], metadata: (v.metadata ?? {}) as Meta });
		}
		return { mutationId: "m" };
	}

	async deleteByIds(ids: string[]) {
		for (const id of ids) {
			this.deletes.push(id);
			this.store.delete(id);
		}
		return { mutationId: "d" };
	}

	async query(
		vector: number[] | Float32Array,
		options: VectorizeQueryOptions = {},
	): Promise<VectorizeMatches> {
		this.queries.push({ topK: options.topK, filter: options.filter });
		const topK = options.topK ?? 5;
		if (topK > 100) throw new Error("topK > 100");
		if (
			options.filter &&
			new TextEncoder().encode(JSON.stringify(options.filter)).length >= 2048
		)
			throw new Error("filtret är för stort");
		const q = [...vector];
		const matches: VectorizeMatch[] = [];
		for (const [id, v] of this.store) {
			if (
				options.filter &&
				!matchesFilter(v.metadata, options.filter as Record<string, unknown>)
			)
				continue;
			const score = v.values.reduce((s, x, i) => s + x * q[i], 0);
			matches.push({ id, score });
		}
		matches.sort((a, b) => b.score - a.score);
		return { matches: matches.slice(0, topK), count: Math.min(topK, matches.length) };
	}
}

function trunc64(s: string): string {
	const enc = new TextEncoder();
	let out = "";
	for (const ch of s) {
		if (enc.encode(out + ch).length > 64) break;
		out += ch;
	}
	return out;
}

function matchesFilter(meta: Meta, filter: Record<string, unknown>): boolean {
	return Object.entries(filter).every(([k, cond]) => {
		const raw = meta[k];
		const v = typeof raw === "string" ? trunc64(raw) : raw;
		if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
			const c = cond as Record<string, unknown>;
			if ("$in" in c)
				return (c.$in as unknown[])
					.map((x) => (typeof x === "string" ? trunc64(x) : x))
					.includes(v);
			if ("$eq" in c) return v === c.$eq;
			throw new Error(`okänd operator i ${JSON.stringify(c)}`);
		}
		return v === (typeof cond === "string" ? trunc64(cond) : cond);
	});
}
