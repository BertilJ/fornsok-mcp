import { describe, expect, it } from "vitest";
import { RRF_K, reciprocalRankFusion } from "../../src/search/fusion";

describe("reciprocal rank fusion", () => {
	it("summerar 1/(k + rang) över listorna", () => {
		const r = reciprocalRankFusion([
			["a", "b", "c"],
			["c", "a", "d"],
		]);
		const score = Object.fromEntries(r.map((x) => [x.id, x.score]));
		expect(score.a).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2), 12);
		expect(score.c).toBeCloseTo(1 / (RRF_K + 3) + 1 / (RRF_K + 1), 12);
		expect(score.b).toBeCloseTo(1 / (RRF_K + 2), 12);
		expect(score.d).toBeCloseTo(1 / (RRF_K + 3), 12);
		expect(r.map((x) => x.id)).toEqual(["a", "c", "b", "d"]);
	});

	it("rang per lista, null där id:t saknas", () => {
		const r = reciprocalRankFusion([["a", "b"], ["b"]]);
		expect(r.find((x) => x.id === "a")?.ranks).toEqual([1, null]);
		expect(r.find((x) => x.id === "b")?.ranks).toEqual([2, 1]);
	});

	it("något som finns i båda listorna slår något som är först i bara en", () => {
		const ord = ["x", "y", "z", "w"];
		const sem = ["q", "z"];
		const r = reciprocalRankFusion([ord, sem]);
		expect(r[0].id).toBe("z");
	});

	it("lika poäng avgörs av bästa rang och sedan av första listan – deterministiskt", () => {
		const r = reciprocalRankFusion([
			["a", "b"],
			["b", "a"],
		]);
		// a och b har exakt samma poäng och samma bästa rang (1): ordningen i första listan avgör.
		expect(r.map((x) => x.id)).toEqual(["a", "b"]);
		const r2 = reciprocalRankFusion([["a"], ["b"]]);
		expect(r2.map((x) => x.id)).toEqual(["a", "b"]);
	});

	it("dubbletter inom en lista räknas vid första förekomsten och flyttar inte rangen för övriga", () => {
		const r = reciprocalRankFusion([["a", "a", "b"]]);
		expect(r.find((x) => x.id === "b")?.ranks).toEqual([2]);
		expect(r.find((x) => x.id === "a")?.score).toBeCloseTo(1 / (RRF_K + 1), 12);
	});

	it("tomma listor och eget k", () => {
		expect(reciprocalRankFusion([])).toEqual([]);
		expect(reciprocalRankFusion([[], []])).toEqual([]);
		const r = reciprocalRankFusion([["a", "b"]], 0);
		expect(r[0].score).toBe(1);
		expect(r[1].score).toBe(0.5);
		expect(() => reciprocalRankFusion([["a"]], -1)).toThrow(RangeError);
	});
});
