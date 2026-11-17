/**
 * Den del av bindningarna AI (Workers AI) och VECTORIZE som modulen använder,
 * så att testerna kan ge falska bindningar. De riktiga typerna ur
 * worker-configuration.d.ts ska gå att skicka in direkt (kontrolleras nedan).
 */
import type { D1Like } from "../store/d1";

/** Workers AI-modell (SPEC 5.2). 1 024 dimensioner. */
export const MODELL = "@cf/baai/bge-m3";
export const DIMENSIONER = 1024;

export interface AiLike {
	run(
		model: typeof MODELL,
		inputs: { text: string[]; truncate_inputs?: boolean },
	): Promise<unknown>;
}

export interface VectorizeLike {
	upsert(vectors: VectorizeVector[]): Promise<unknown>;
	deleteByIds(ids: string[]): Promise<unknown>;
	query(
		vector: number[] | Float32Array,
		options?: VectorizeQueryOptions,
	): Promise<VectorizeMatches>;
}

/** Det inbäddning och sökning behöver ur Workerns miljö. */
export interface SemanticEnv {
	DB?: D1Like;
	AI?: AiLike;
	VECTORIZE?: VectorizeLike;
	/** Län i det semantiska omfånget, kommaseparerat (standard "Dalarna"). */
	SEMANTIC_LAN?: string;
}

type Assert<T extends true> = T;
export type _AiIsAiLike = Assert<Ai extends AiLike ? true : false>;
export type _VectorizeIsVectorizeLike = Assert<Vectorize extends VectorizeLike ? true : false>;

/** Plocka ut vektorerna ur bge-m3:s svar ({ shape, data }) och kontrollera formen. */
export function vektorerUrSvar(svar: unknown, antal: number): number[][] {
	const data = (svar as { data?: unknown } | null)?.data;
	if (!Array.isArray(data) || data.length !== antal) {
		throw new Error(
			`Workers AI: oväntat svar (väntade ${antal} vektorer, fick ${Array.isArray(data) ? data.length : "inga"})`,
		);
	}
	for (const v of data) {
		if (
			!Array.isArray(v) ||
			v.length !== DIMENSIONER ||
			!v.every((x) => typeof x === "number" && Number.isFinite(x))
		) {
			throw new Error(`Workers AI: vektor med fel form (väntade ${DIMENSIONER} tal)`);
		}
	}
	return data as number[][];
}
