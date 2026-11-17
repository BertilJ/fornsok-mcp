/**
 * Tunn adapter som ger node:sqlite samma yta som Workers D1-bindningen
 * (prepare/bind/all/batch), för tester av src/store mot en lokal laddning.
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { D1Like, D1LikeResult, D1LikeStatement } from "../../src/store/d1";

interface AdapterStatement extends D1LikeStatement {
	run(): unknown[];
}

export function d1FromSqlite(db: DatabaseSync, log?: (sql: string, params: unknown[]) => void): D1Like {
	const make = (sql: string, params: unknown[]): AdapterStatement => {
		const exec = () => {
			log?.(sql, params);
			for (const p of params) {
				// D1 tar emot null, tal, strängar och ArrayBuffer; inget annat.
				if (!(p === null || typeof p === "number" || typeof p === "string" || p instanceof Uint8Array)) {
					throw new Error(`D1_TYPE_ERROR: Type '${typeof p}' not supported for value '${String(p)}'`);
				}
			}
			if (params.length > 100) throw new Error("too many SQL variables (D1: högst 100)");
			if (Buffer.byteLength(sql) > 100_000) throw new Error("SQL statement too long (D1: högst 100 000 byte)");
			return db.prepare(sql).all(...(params as SQLInputValue[])) as unknown[];
		};
		return {
			bind: (...values: unknown[]) => make(sql, values),
			all: async <T>() => ({ results: exec() as T[], success: true }) as D1LikeResult<T>,
			run: exec,
		};
	};
	return {
		prepare: (sql: string) => make(sql, []),
		batch: async <T>(statements: D1LikeStatement[]) => {
			// D1 kör en batch som en transaktion; här räcker det att köra i ordning.
			return statements.map((s) => ({ results: (s as AdapterStatement).run() as T[], success: true }));
		},
	};
}
