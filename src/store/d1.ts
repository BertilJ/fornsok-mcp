/**
 * Den del av D1-bindningens yta som indexmodulen använder. Den riktiga
 * `D1Database` uppfyller gränssnittet (kontrolleras nedan); testerna ger
 * `node:sqlite` samma yta med en tunn adapter.
 */

export interface D1LikeResult<T> {
	results: T[];
	success?: boolean;
	meta?: unknown;
}

export interface D1LikeStatement {
	bind(...values: unknown[]): D1LikeStatement;
	all<T = Record<string, unknown>>(): Promise<D1LikeResult<T>>;
}

export interface D1Like {
	prepare(query: string): D1LikeStatement;
	batch<T = unknown>(statements: D1LikeStatement[]): Promise<D1LikeResult<T>[]>;
}

// Typkontroll: Workers-bindningen ska gå att skicka in direkt.
type Assert<T extends true> = T;
export type _D1DatabaseIsD1Like = Assert<D1Database extends D1Like ? true : false>;

/** Fel i en indexfråga (D1 otillgängligt, oväntat svar). Verktygen faller då tillbaka på levande källor. */
export class IndexError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message);
		this.name = "IndexError";
		if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
	}
}

/** Ogiltiga indata till indexet (t.ex. koordinat utanför Sverige). */
export class IndexInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IndexInputError";
	}
}
