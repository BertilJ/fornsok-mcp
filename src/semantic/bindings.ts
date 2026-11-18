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
/**
 * Svarets form, utan innehåll: typer, nycklar och längder (för loggen, så att
 * det syns vad den riktiga tjänsten svarar om formen avviker från den väntade).
 */
export function svaretsForm(x: unknown, djup = 0): string {
	if (x === null) return "null";
	if (Array.isArray(x)) return `array(${x.length})${x.length && djup < 2 ? `<${svaretsForm(x[0], djup + 1)}>` : ""}`;
	if (typeof x === "object") {
		if (djup >= 2) return "object";
		const keys = Object.keys(x as object).slice(0, 12);
		return `{${keys.map((k) => `${k}: ${svaretsForm((x as Record<string, unknown>)[k], djup + 1)}`).join(", ")}}`;
	}
	return typeof x;
}

export function vektorerUrSvar(svar: unknown, antal: number): number[][] {
	const data = (svar as { data?: unknown } | null)?.data;
	if (!Array.isArray(data) || data.length !== antal) {
		throw new Error(
			`Workers AI: oväntat svar (väntade ${antal} vektorer, fick ${Array.isArray(data) ? data.length : "inga"}); svarets form: ${svaretsForm(svar)}`,
		);
	}
	for (const v of data) {
		if (
			!Array.isArray(v) ||
			v.length !== DIMENSIONER ||
			!v.every((x) => typeof x === "number" && Number.isFinite(x))
		) {
			throw new Error(`Workers AI: vektor med fel form (väntade ${DIMENSIONER} tal); svarets form: ${svaretsForm(svar)}`);
		}
	}
	return data as number[][];
}
