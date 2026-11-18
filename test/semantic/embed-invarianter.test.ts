/**
 * Acceptanstester för felhanteringen i runEmbedBatch, ett per sond ur
 * granskningen (omöjliga texter, batchgräns i tjänsten, fel i Vectorize och
 * D1, hängande anrop, slumpmässiga fel). Varje test kör körningar var
 * femtonde minut och kontrollerar invarianterna I1–I7 (beslutsregeln överst i
 * runEmbedBatch) direkt i D1 och den falska Vectorize:
 *
 * - I1 alla friska texter bäddas in inom ett angivet antal körningar,
 * - I2 felrader bara för texter som verkligen är omöjliga,
 * - I4 högst MAX_ANROP + några kontroller per körning,
 * - I5 `klar` aldrig medan en felrad är förfallen (räknas här oberoende av koden),
 * - I6 vektorerna stämmer med bokföringen.
 *
 * Med miljövariabeln EMBED_RAPPORT skrivs utfallet per test (körningar, anrop).
 */
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODELL } from "../../src/semantic/bindings";
import { KONTROLL_EFTER, MAX_ANROP, MAX_FEL_PER_POST, OMPROVNING_DYGN, PABORJAD, runEmbedBatch } from "../../src/semantic/embed";
import type { D1Like, D1LikeStatement } from "../../src/store/d1";
import { emptyDb, openD1 } from "../sync/helpers";
import { bagOfWords, FakeVectorize } from "./fakes";

const uuidN = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const frisk = (i: number) => `Fångstgrop nummer ${i}, rund, 3 m i diameter.`;
const OMOJLIG = "OMÖJLIG";
const dag = (d: number, h = 4, m = 0) => new Date(Date.UTC(2026, 10, 1 + d, h, m));
/** Högsta tillåtna antal anrop i en körning: taket, kontroller (en per KONTROLL_EFTER fel, högst fyra anrop var) och slutkontrollen. */
const TAK = MAX_ANROP + Math.ceil(MAX_ANROP / KONTROLL_EFTER) * 4 + 1;

/** Fast frö (mulberry32). */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Workers AI som avvisar anrop enligt `fel` (null = svara). Svaret är en ordpåse, som FakeAi. */
class Tjanst {
	anrop = 0;
	constructor(public fel: (texter: string[]) => Error | null | Promise<never> = () => null) {}
	async run(_m: string, inp: { text: string[] }) {
		this.anrop++;
		const f = this.fel(inp.text);
		if (f instanceof Promise) return f;
		if (f) throw f;
		return { shape: [inp.text.length, 1024], data: inp.text.map(bagOfWords), pooling: "cls" };
	}
}
const omojligFel = (t: string[]) => (t.some((x) => x.includes(OMOJLIG)) ? new Error("AiError: 3010: Input too long") : null);
const hanger = () => new Promise<never>(() => {});

function lamning(db: DatabaseSync, i: number, text: string, socknar: string[] = []): void {
	db.prepare("INSERT INTO lamning (uuid, lamningsnummer, lamningstyp, bedomning, beskrivning, lat, lon, hash) VALUES (?, ?, 'Fångstgrop', 'Fornlämning', ?, 60.6, 15.6, ?)").run(uuidN(i), `L2099:${i}`, text, `h${i}`);
	for (const [niva, namn] of [["lan", "Dalarna"], ...socknar.map((s) => ["socken", s])]) {
		db.prepare("INSERT OR IGNORE INTO omrade (niva, namn, lan) VALUES (?, ?, '')").run(niva, namn);
		db.prepare("INSERT INTO lamning_omrade (omrade_id, lamning_id) SELECT o.id, l.id FROM omrade o, lamning l WHERE o.niva = ? AND o.namn = ? AND o.lan = '' AND l.uuid = ?").run(niva, namn, uuidN(i));
	}
}
/** Lämningar 1…n; de där `omojlig(i)` har en text som tjänsten alltid avvisar. Returnerar de omöjligas uuid. */
function fyll(db: DatabaseSync, n: number, omojlig: (i: number) => boolean = () => false): Set<string> {
	const ut = new Set<string>();
	db.exec("BEGIN");
	for (let i = 1; i <= n; i++) {
		const o = omojlig(i);
		lamning(db, i, o ? `${OMOJLIG} ${frisk(i)}` : frisk(i));
		if (o) ut.add(uuidN(i));
	}
	db.exec("COMMIT");
	return ut;
}

/** D1 vars batch kastar när `fel` säger det (efter SQL-texterna i batchen). */
function d1MedFel(db: DatabaseSync, fel: (sql: string[]) => boolean): D1Like {
	const d = openD1(db);
	type S = D1LikeStatement & { inner: D1LikeStatement; sql: string };
	const wrap = (inner: D1LikeStatement, sql: string): S => ({ inner, sql, bind: (...v: unknown[]) => wrap(inner.bind(...v), sql), all: <T>() => inner.all<T>() });
	return {
		prepare: (sql: string) => wrap(d.prepare(sql), sql),
		batch: async <T>(st: D1LikeStatement[]) => {
			if (fel((st as S[]).map((s) => s.sql))) throw new Error("D1_ERROR: batch failed");
			return d.batch<T>((st as S[]).map((s) => s.inner));
		},
	};
}

const tyst = () => {
	const e = vi.spyOn(console, "error").mockImplementation(() => {});
	const w = vi.spyOn(console, "warn").mockImplementation(() => {});
	return () => {
		e.mockRestore();
		w.mockRestore();
	};
};

const n = (db: DatabaseSync, sql: string, ...p: Array<string | number>) => (db.prepare(sql).get(...p) as { n: number }).n;
/** Felrader som är förfallna vid `nu` för lämningar som inte är inbäddade (I5), räknat i JS. */
function forfallna(db: DatabaseSync, nu: Date): number {
	const dygnet = `${nu.toISOString().slice(0, 10)}T00:00:00.000Z`;
	const omprovas = new Date(nu.getTime() - OMPROVNING_DYGN * 86_400_000).toISOString();
	const r = db
		.prepare(
			"SELECT f.rad_hash = l.hash AS samma, f.forsok, f.andrad FROM inbaddning_fel f JOIN lamning l ON l.uuid = f.uuid WHERE NOT EXISTS (SELECT 1 FROM inbaddning i WHERE i.uuid = l.uuid AND i.rad_hash = l.hash AND i.modell = ?)",
		)
		.all(MODELL) as Array<{ samma: number; forsok: number; andrad: string }>;
	return r.filter((x) => !(x.samma && (x.forsok < MAX_FEL_PER_POST ? x.andrad >= dygnet : x.andrad > omprovas))).length;
}
/** Vektor-id som inte stämmer med bokföringen (I6): saknade eller överblivna. */
function ejITakt(db: DatabaseSync, vec: FakeVectorize): string[] {
	const vantat = new Set<string>();
	for (const r of db.prepare("SELECT uuid, vektorer FROM inbaddning").all() as Array<{ uuid: string; vektorer: number }>)
		for (let k = 0; k < r.vektorer; k++) vantat.add(k ? `${r.uuid}#${k}` : r.uuid);
	return [...[...vec.store.keys()].filter((id) => !vantat.has(id)).map((id) => `över ${id}`), ...[...vantat].filter((id) => !vec.store.has(id)).map((id) => `saknas ${id}`)];
}

interface Utfall {
	/** Körningar tills alla friska var inbäddade, alla omöjliga bokförda och körningen sa klar (−1 = aldrig). */
	klarEfter: number;
	maxAnrop: number;
	kast: number;
	friskaKvar: number;
	omojligaObokforda: number;
	felPaFriska: number;
}

/**
 * Kör var femtonde minut från `fran` tills allt är avgjort och körningen säger
 * klar, högst `korningar` gånger. Kontrollerar I5 efter varje körning och
 * `efterVarje` (t.ex. att ingen frisk text hoppas över).
 */
async function kor(
	db: DatabaseSync,
	ai: Tjanst,
	vec: FakeVectorize,
	o: { korningar: number; omojliga?: Set<string>; fran?: Date; max?: number; efterVarje?: () => void; namn?: string; tidsgransMs?: number },
): Promise<Utfall> {
	const omojliga = o.omojliga ?? new Set<string>();
	const fran = o.fran ?? dag(0);
	const u: Utfall = { klarEfter: -1, maxAnrop: 0, kast: 0, friskaKvar: 0, omojligaObokforda: 0, felPaFriska: 0 };
	const lage = () => {
		const ok = new Set((db.prepare("SELECT uuid FROM inbaddning WHERE status = 'ok'").all() as Array<{ uuid: string }>).map((r) => r.uuid));
		const fel = new Set((db.prepare("SELECT uuid FROM inbaddning_fel").all() as Array<{ uuid: string }>).map((r) => r.uuid));
		const alla = (db.prepare("SELECT uuid FROM lamning").all() as Array<{ uuid: string }>).map((r) => r.uuid);
		u.friskaKvar = alla.filter((x) => !omojliga.has(x) && !ok.has(x)).length;
		u.omojligaObokforda = [...omojliga].filter((x) => !fel.has(x)).length;
		u.felPaFriska = [...fel].filter((x) => !omojliga.has(x)).length;
	};
	const atersta = tyst();
	try {
		for (let k = 0; k < o.korningar; k++) {
			const nu = new Date(fran.getTime() + k * 15 * 60_000);
			const fore = ai.anrop;
			let klar = false;
			try {
				klar = (await runEmbedBatch({ DB: openD1(db), AI: ai, VECTORIZE: vec, SEMANTIC_LAN: "Dalarna" }, { max: o.max ?? 1500, now: nu, tidsgransMs: o.tidsgransMs ?? 2000 })).klar;
			} catch {
				u.kast++;
			}
			u.maxAnrop = Math.max(u.maxAnrop, ai.anrop - fore);
			if (klar) expect(forfallna(db, nu), `I5: klar med förfallna felrader (körning ${k + 1})`).toBe(0);
			o.efterVarje?.();
			lage();
			if (klar && u.friskaKvar === 0 && u.omojligaObokforda === 0) {
				u.klarEfter = k + 1;
				break;
			}
		}
	} finally {
		atersta();
	}
	if (process.env.EMBED_RAPPORT) console.info(`UTFALL ${o.namn ?? ""}: ${JSON.stringify(u)}`);
	return u;
}

/** Alla friska inbäddade och alla omöjliga bokförda inom `korningar`, inga felrader på friska, högst TAK anrop per körning, vektorerna i takt. */
function vantaKlart(u: Utfall, korningar: number, db: DatabaseSync, vec: FakeVectorize): void {
	const v = JSON.stringify(u);
	expect(u.klarEfter, v).toBeGreaterThan(0);
	expect(u.klarEfter, v).toBeLessThanOrEqual(korningar);
	expect(u.felPaFriska, v).toBe(0);
	expect(u.maxAnrop, v).toBeLessThanOrEqual(TAK);
	expect(ejITakt(db, vec)).toEqual([]);
}

describe("runEmbedBatch: acceptanstest (invarianterna I1–I7)", () => {
	let db: DatabaseSync;
	let vec: FakeVectorize;
	beforeEach(() => {
		db = emptyDb();
		vec = new FakeVectorize();
		return () => db.close();
	});

	// ---------------------------------------------- I1–I4: omöjliga texter och batchgräns

	for (const k of [5, 8])
		it(`I1: 2 000 lämningar med ${k} omöjliga grannar: allt avgjort inom 4 körningar (granskningen: aldrig, 38 av 40 körningar kastade)`, async () => {
			const omojliga = fyll(db, 2000, (i) => i >= 1000 && i < 1000 + k);
			const u = await kor(db, new Tjanst(omojligFel), vec, { korningar: 40, omojliga, namn: `grannar ${k}` });
			vantaKlart(u, 4, db, vec);
			expect(u.kast).toBe(0);
		});

	it("I1: 120 lämningar med 8 omöjliga utspridda: allt avgjort i första körningen (granskningen: aldrig)", async () => {
		const spridda = new Set([2, 12, 32, 38, 55, 77, 88, 93]);
		const omojliga = fyll(db, 120, (i) => spridda.has(i));
		const u = await kor(db, new Tjanst(omojligFel), vec, { korningar: 40, omojliga, namn: "120 spridda 8" });
		vantaKlart(u, 2, db, vec);
	});

	for (const [andel, korningar] of [[0.01, 5], [0.05, 12]] as const)
		it(`I1: 1 500 lämningar med ${andel * 100} % omöjliga: allt avgjort inom ${korningar} körningar (granskningen: ${andel === 0.05 ? "inget inbäddat" : "inget bokfört"} efter 40)`, async () => {
			const r = rng(1500 * 7 + andel * 1000);
			const omojliga = fyll(db, 1500, () => r() < andel);
			expect(omojliga.size).toBeGreaterThan(andel === 0.05 ? 50 : 5);
			const u = await kor(db, new Tjanst(omojligFel), vec, { korningar: 40, omojliga, namn: `1500 ${andel}` });
			vantaKlart(u, korningar, db, vec);
		});

	it("I1: de 60 första lämningarna i listan är omöjliga (inget inbäddat än): allt avgjort inom 4 körningar", async () => {
		const omojliga = fyll(db, 1500, (i) => i <= 60);
		const u = await kor(db, new Tjanst(omojligFel), vec, { korningar: 40, omojliga, namn: "60 först" });
		vantaKlart(u, 4, db, vec);
	});

	it("I1: 6 000 lämningar med 30 omöjliga utspridda: allt avgjort inom 6 körningar (granskningen, 33 000: 9 kvar utan bokföring efter 120)", async () => {
		const r = rng(30 * 31 + 5);
		const valda = new Set<number>();
		while (valda.size < 30) valda.add(1 + Math.floor(r() * 6000));
		const omojliga = fyll(db, 6000, (i) => valda.has(i));
		const u = await kor(db, new Tjanst(omojligFel), vec, { korningar: 40, omojliga, namn: "6000 spridda 30" });
		vantaKlart(u, 6, db, vec);
	}, 60_000);

	for (const L of [1, 2, 7, 25, 49])
		for (const [namn, fel] of [["okänt fel", () => new Error("InferenceUpstreamError: Unknown internal error")], ["3007", () => new Error("AiError: 3007: Timeout")]] as const)
			it(`I1: tjänsten avvisar batchar större än ${L} (${namn}): 1 500 lämningar inbäddade inom ${L === 1 ? 25 : L === 2 ? 14 : 3} körningar (granskningen: inget, 9 anrop per körning)`, async () => {
				fyll(db, 1500);
				const ai = new Tjanst((t) => (t.length > L ? fel() : null));
				const u = await kor(db, ai, vec, { korningar: 40, namn: `L=${L} ${namn}` });
				vantaKlart(u, L === 1 ? 25 : L === 2 ? 14 : 3, db, vec);
				expect(u.kast).toBe(0);
				expect(n(db, "SELECT count(*) AS n FROM inbaddning_fel")).toBe(0);
			});

	// ---------------------------------------------- I5: varje felrad prövas igen

	it("I5 (F2): tillfälligt fel dygn 0, okänt fel dygn 1, sedan frisk tjänst: texten bäddas in dygn 2 (granskningen: aldrig, och klar varje körning)", async () => {
		fyll(db, 120);
		db.prepare("UPDATE lamning SET beskrivning = 'SJUK fångstgrop.' WHERE uuid = ?").run(uuidN(7));
		let lage: "503" | "okänt" | "frisk" = "503";
		const ai = new Tjanst((t) => (lage !== "frisk" && t.some((x) => x.includes("SJUK")) ? (lage === "503" ? Object.assign(new Error("503 Service Unavailable"), { status: 503 }) : new Error("InferenceUpstreamError: Unknown internal error")) : null));
		const sjuk = new Set([uuidN(7)]);
		const u0 = await kor(db, ai, vec, { korningar: 4, omojliga: sjuk, fran: dag(0) });
		expect(u0.klarEfter).toBe(2);
		lage = "okänt";
		const u1 = await kor(db, ai, vec, { korningar: 4, omojliga: sjuk, fran: dag(1) });
		expect(u1.klarEfter).toBe(2);
		expect(db.prepare("SELECT forsok FROM inbaddning_fel").get()).toEqual({ forsok: 2 });
		lage = "frisk";
		const u2 = await kor(db, ai, vec, { korningar: 4, fran: dag(2) });
		expect(u2.klarEfter).toBe(1);
		expect(vec.store.has(uuidN(7))).toBe(true);
		expect(n(db, "SELECT count(*) AS n FROM inbaddning_fel")).toBe(0);
	});

	// ---------------------------------------------- I2: fel i Vectorize och D1 är inte textens

	it("I2 (F3): upsert kastar efter lyckad AI: ingen felrad, högljutt fel, läker när felet upphör", async () => {
		fyll(db, 3);
		const upsert = vec.upsert.bind(vec);
		vec.upsert = async () => {
			throw new Error("VECTOR_UPSERT_ERROR: boom");
		};
		const ai = new Tjanst();
		const atersta = tyst();
		try {
			for (let k = 0; k < 3; k++) await expect(runEmbedBatch({ DB: openD1(db), AI: ai, VECTORIZE: vec, SEMANTIC_LAN: "Dalarna" }, { now: dag(0, 4, 15 * k) })).rejects.toThrow(/VECTOR_UPSERT_ERROR/);
		} finally {
			atersta();
		}
		expect(n(db, "SELECT count(*) AS n FROM inbaddning_fel")).toBe(0);
		// Avsikten står kvar i kön (regel 7).
		expect(n(db, "SELECT count(*) AS n FROM inbaddning_ko WHERE orsak = ?", PABORJAD)).toBe(3);
		vec.upsert = upsert;
		const u = await kor(db, ai, vec, { korningar: 3, fran: dag(0, 5) });
		vantaKlart(u, 1, db, vec);
		expect(n(db, "SELECT count(*) AS n FROM inbaddning_ko")).toBe(0);
	});

	it("I2 (F3): upsert kastar när en text bäddats in ensam efter att ha fallerat i delar (andra försöket): ingen felrad på texten, högljutt fel, läker", async () => {
		fyll(db, 50);
		db.prepare("UPDATE lamning SET beskrivning = 'SJUK fångstgrop.' WHERE uuid = ?").run(uuidN(7));
		let kvar = 6;
		// SJUK fallerar sex gånger (delningen ned till texten ensam, och dess första försök), sedan lyckas AI.
		const ai = new Tjanst((t) => (t.some((x) => x.includes("SJUK")) && kvar-- > 0 ? new Error("InferenceUpstreamError: Unknown internal error") : null));
		const upsert = vec.upsert.bind(vec);
		vec.upsert = async (v: VectorizeVector[]) => {
			if (v.some((x) => x.id === uuidN(7))) throw new Error("VECTOR_UPSERT_ERROR: boom");
			return upsert(v);
		};
		const atersta = tyst();
		try {
			await expect(runEmbedBatch({ DB: openD1(db), AI: ai, VECTORIZE: vec, SEMANTIC_LAN: "Dalarna" }, { now: dag(0) })).rejects.toThrow(/VECTOR_UPSERT_ERROR/);
		} finally {
			atersta();
		}
		expect(kvar).toBeLessThan(0);
		expect(n(db, "SELECT count(*) AS n FROM inbaddning_fel")).toBe(0);
		vec.upsert = upsert;
		const u = await kor(db, ai, vec, { korningar: 3, fran: dag(0, 4, 15) });
		vantaKlart(u, 1, db, vec);
		expect(vec.store.size).toBe(50);
	});

	// ---------------------------------------------- I6: vektorer och bokföring i takt

	it("I6 (F4): D1-bokföringen kastar efter upsert; sedan får lämningen färre socknar respektive tas bort: inga vektorer blir kvar", async () => {
		lamning(db, 1, frisk(1), ["A", "B", "C"]);
		lamning(db, 2, frisk(2), ["A", "B", "C"]);
		const ai = new Tjanst();
		const atersta = tyst();
		try {
			const fel = d1MedFel(db, (sql) => sql.some((q) => q.startsWith("INSERT INTO inbaddning (")));
			await expect(runEmbedBatch({ DB: fel, AI: ai, VECTORIZE: vec, SEMANTIC_LAN: "Dalarna" }, { now: dag(0) })).rejects.toThrow(/D1_ERROR/);
		} finally {
			atersta();
		}
		expect(vec.store.size).toBe(6);
		expect(n(db, "SELECT count(*) AS n FROM inbaddning")).toBe(0);
		// Utan att kön fylls på (spåret räcker): 1 lämnar två socknar, 2 tas bort.
		db.prepare("DELETE FROM lamning_omrade WHERE lamning_id = (SELECT id FROM lamning WHERE uuid = ?) AND omrade_id IN (SELECT id FROM omrade WHERE niva = 'socken' AND namn IN ('B', 'C'))").run(uuidN(1));
		db.prepare("UPDATE lamning SET hash = 'ny' WHERE uuid = ?").run(uuidN(1));
		db.prepare("DELETE FROM lamning_omrade WHERE lamning_id = (SELECT id FROM lamning WHERE uuid = ?)").run(uuidN(2));
		db.prepare("DELETE FROM lamning WHERE uuid = ?").run(uuidN(2));
		const u = await kor(db, ai, vec, { korningar: 3, fran: dag(0, 4, 15) });
		vantaKlart(u, 1, db, vec);
		expect([...vec.store.keys()]).toEqual([uuidN(1)]);
		expect(db.prepare("SELECT uuid, vektorer FROM inbaddning").all()).toEqual([{ uuid: uuidN(1), vektorer: 1 }]);
	});

	it("I6: D1 kastar före upsert (avsikten skrivs inte): ingen vektor skrivs", async () => {
		fyll(db, 3);
		const atersta = tyst();
		try {
			const fel = d1MedFel(db, (sql) => sql.some((q) => q.startsWith("INSERT INTO inbaddning_ko")));
			await expect(runEmbedBatch({ DB: fel, AI: new Tjanst(), VECTORIZE: vec, SEMANTIC_LAN: "Dalarna" }, { now: dag(0) })).rejects.toThrow(/D1_ERROR/);
		} finally {
			atersta();
		}
		expect(vec.store.size).toBe(0);
		expect(n(db, "SELECT count(*) AS n FROM inbaddning_fel")).toBe(0);
	});

	// ---------------------------------------------- I7: tidsgränser

	it("I7 (F5): ett hängande AI-anrop ger tidsgräns och körningen fortsätter; hänger alla avbryts den; nästa körning är korrekt", async () => {
		fyll(db, 120);
		let nr = 0;
		const ai = new Tjanst(() => (++nr === 2 ? hanger() : null));
		const vakt = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, nej) => setTimeout(() => nej(new Error("körningen avgjordes inte")), 3000))]);
		const atersta = tyst();
		try {
			const r = await vakt(runEmbedBatch({ DB: openD1(db), AI: ai, VECTORIZE: vec, SEMANTIC_LAN: "Dalarna" }, { now: dag(0), tidsgransMs: 20 }));
			expect(r).toMatchObject({ inbaddade: 120, klar: true });
			expect(r.fel ?? 0).toBe(0);
			for (let i = 121; i <= 130; i++) lamning(db, i, frisk(i));
			db.prepare("INSERT INTO synk_status (nyckel, varde, andrad) VALUES ('senaste_avstamning', 'x', 't')").run();
			ai.fel = hanger;
			const fore = ai.anrop;
			await expect(vakt(runEmbedBatch({ DB: openD1(db), AI: ai, VECTORIZE: vec, SEMANTIC_LAN: "Dalarna" }, { now: dag(0, 4, 15), tidsgransMs: 20 }))).rejects.toThrow(/avbrott.*inget svar inom 20 ms/);
			expect(ai.anrop - fore).toBeLessThanOrEqual(5);
		} finally {
			atersta();
		}
		ai.fel = () => null;
		const u = await kor(db, ai, vec, { korningar: 3, fran: dag(0, 4, 30) });
		vantaKlart(u, 1, db, vec);
		expect(vec.store.size).toBe(130);
	});

	it("I7: en hängande upsert ger tidsgräns och högljutt fel, ingen felrad; nästa körning är korrekt", async () => {
		fyll(db, 60);
		const upsert = vec.upsert.bind(vec);
		vec.upsert = () => hanger();
		const atersta = tyst();
		try {
			await expect(runEmbedBatch({ DB: openD1(db), AI: new Tjanst(), VECTORIZE: vec, SEMANTIC_LAN: "Dalarna" }, { now: dag(0), tidsgransMs: 20 })).rejects.toThrow(/Vectorize: inget svar inom 20 ms/);
		} finally {
			atersta();
		}
		expect(n(db, "SELECT count(*) AS n FROM inbaddning_fel")).toBe(0);
		vec.upsert = upsert;
		const u = await kor(db, new Tjanst(), vec, { korningar: 3, fran: dag(0, 4, 15) });
		vantaKlart(u, 1, db, vec);
	});

	// ---------------------------------------------- slumpmässiga fel

	for (const [namn, fel] of [["okända", () => new Error("InferenceUpstreamError: Unknown internal error")], ["tillfälliga (503)", () => Object.assign(new Error("503 Service Unavailable"), { status: 503 })]] as const)
		it(`I1, I2, I5: slumpmässiga ${namn} fel på 30 % av anropen (fast frö): allt inbäddat inom två dygn, ingen frisk text överhoppad`, async () => {
			fyll(db, 1500);
			const r = rng(namn.length * 1000 + 1500);
			const ai = new Tjanst(() => (r() < 0.3 ? fel() : null));
			const u = await kor(db, ai, vec, {
				korningar: 2 * 96,
				fran: dag(0, 0, 0),
				namn: `slump ${namn}`,
				efterVarje: () => expect(n(db, "SELECT count(*) AS n FROM inbaddning_fel WHERE forsok >= ?", MAX_FEL_PER_POST)).toBe(0),
			});
			vantaKlart(u, 2 * 96, db, vec);
			expect(n(db, "SELECT count(*) AS n FROM inbaddning_fel")).toBe(0);
		}, 60_000);

	// ---------------------------------------------- det som redan var rätt

	const former: Array<[string, (t: string[]) => unknown]> = [
		["tomt svar", () => ({})],
		["null", () => null],
		["inga vektorer", () => ({ data: [] })],
		["en vektor för lite", (t) => ({ data: t.slice(1).map(bagOfWords) })],
		["fel dimension", (t) => ({ data: t.map(() => new Array(768).fill(0.1)) })],
		["NaN", (t) => ({ data: t.map(() => new Array(1024).fill(Number.NaN)) })],
	];
	for (const [namn, svar] of former)
		it(`fel svarsform (${namn}): avbrott efter högst fem anrop, inget bokförs; sedan bäddas allt in`, async () => {
			fyll(db, 1);
			await runEmbedBatch({ DB: openD1(db), AI: new Tjanst(), VECTORIZE: vec, SEMANTIC_LAN: "Dalarna" }, { now: dag(0) });
			for (let i = 2; i <= 60; i++) lamning(db, i, frisk(i));
			db.prepare("INSERT INTO synk_status (nyckel, varde, andrad) VALUES ('senaste_avstamning', 'x', 't')").run();
			const ai = { anrop: 0, run: async (_m: string, i: { text: string[] }) => (ai.anrop++, svar(i.text)) };
			const atersta = tyst();
			try {
				await expect(runEmbedBatch({ DB: openD1(db), AI: ai, VECTORIZE: vec, SEMANTIC_LAN: "Dalarna" }, { now: dag(0, 4, 15) })).rejects.toThrow(/avbrott.*oväntat svar|avbrott.*fel form/);
			} finally {
				atersta();
			}
			expect(ai.anrop).toBeLessThanOrEqual(5);
			expect(n(db, "SELECT count(*) AS n FROM inbaddning_fel")).toBe(0);
			expect(n(db, "SELECT count(*) AS n FROM inbaddning")).toBe(1);
			const u = await kor(db, new Tjanst(), vec, { korningar: 3, fran: dag(0, 4, 30) });
			vantaKlart(u, 1, db, vec);
		});

	it("noll anrop när inget finns att göra, även dagar senare", async () => {
		fyll(db, 70);
		const ai = new Tjanst();
		expect((await kor(db, ai, vec, { korningar: 2 })).klarEfter).toBe(1);
		const fore = ai.anrop;
		for (const d of [0, 1, 9]) expect(await runEmbedBatch({ DB: openD1(db), AI: ai, VECTORIZE: vec, SEMANTIC_LAN: "Dalarna" }, { now: dag(d, 12) })).toMatchObject({ klar: true, inbaddade: 0 });
		expect(ai.anrop).toBe(fore);
	});
});
