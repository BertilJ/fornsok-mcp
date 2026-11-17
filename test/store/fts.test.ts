import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildFtsQuery, MAX_TERMS, tokenize } from "../../src/store/fts";

describe("FTS5-uttryck", () => {
	it("delar i ord, gemener, OCH-kopplar inom citattecken", () => {
		expect(buildFtsQuery("Hytta  slagg")?.match).toBe('"hytta" "slagg"');
	});

	it("behåller å, ä, ö och normaliserar till NFC", () => {
		const decomposed = "önskekälla"; // ö och ä som kombinerande tecken
		expect(buildFtsQuery(decomposed)?.match).toBe('"önskekälla"');
	});

	it("prefix med * direkt efter ordet, minst två tecken", () => {
		expect(buildFtsQuery("hytt* s* slagg *")?.match).toBe('"hytt"* "s" "slagg"');
		expect(tokenize("hytt*")).toEqual([{ term: "hytt", prefix: true }]);
	});

	it("operatorer och syntax blir vanliga ord eller skiljetecken", () => {
		expect(buildFtsQuery('källa OR "tradition" NEAR(a b) NOT x AND y')?.match).toBe(
			'"källa" "or" "tradition" "near" "a" "b" "not" "x" "and" "y"',
		);
		expect(buildFtsQuery("beskrivning:hytta")?.match).toBe('"beskrivning" "hytta"');
		expect(buildFtsQuery("^start +plus -minus {a b}")?.match).toBe('"start" "plus" "minus" "a" "b"');
	});

	it("inget sökbart ord ger null", () => {
		expect(buildFtsQuery('"" * : () -- ;')).toBeNull();
		expect(buildFtsQuery("")).toBeNull();
		expect(buildFtsQuery(null, [])).toBeNull();
	});

	it("tar ord ur både fråga och ordlista, utan dubbletter, högst MAX_TERMS", () => {
		expect(buildFtsQuery("hytta", ["Hytta", "slagg"])?.match).toBe('"hytta" "slagg"');
		const many = Array.from({ length: 40 }, (_, i) => `ord${i}`).join(" ");
		expect(buildFtsQuery(many)?.terms.length).toBe(MAX_TERMS);
	});

	it("elaka strängar ger giltiga FTS5-uttryck", () => {
		const db = new DatabaseSync(":memory:");
		db.exec("CREATE VIRTUAL TABLE t USING fts5(a, tokenize = 'unicode61 remove_diacritics 0', prefix = '2 3')");
		db.exec("INSERT INTO t VALUES ('Önskekälla vid hyttan, NEAR OR AND')");
		const evil = [
			'"',
			'""""',
			"*",
			"**hytt**",
			"NEAR",
			"NEAR(",
			"OR",
			"AND NOT",
			"a OR b",
			":",
			"a:b",
			"'; DROP TABLE t; --",
			"\u0000\u0001",
			"x".repeat(10_000),
			"(((((",
			"🙂 hytt*",
			"col:*",
			"^",
			"önske*",
		];
		for (const s of evil) {
			const q = buildFtsQuery(s);
			if (!q) continue;
			expect(() => db.prepare("SELECT count(*) AS c FROM t WHERE t MATCH ?").get(q.match)).not.toThrow();
		}
		const count = (input: string) => {
			const q = buildFtsQuery(input);
			if (!q) throw new Error(`inget uttryck för ${input}`);
			return (db.prepare("SELECT count(*) AS c FROM t WHERE t MATCH ?").get(q.match) as { c: number }).c;
		};
		expect(count("önske*")).toBe(1);
		// Utan stamning: "källa" hittar inte "källan"; prefix gör det.
		db.exec("INSERT INTO t VALUES ('källan')");
		expect(count("källa")).toBe(0);
		expect(count("käll*")).toBe(1);
	});
});
