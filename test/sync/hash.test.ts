/**
 * Synkens källpost och rad mot inläsningens (ingest/transform.ts): samma hash
 * och samma rad för samma post, och fältmappningen app → GeoPackage
 * kontrollerad mot Falu kommuns GeoPackage-fil (hoppas över om filen saknas).
 */
import { describe, expect, it } from "vitest";
import { GpkgReader } from "../../ingest/read.ts";
import {
	contentHash as ingestHash,
	Indelning,
	type KallPost,
	toIndexPost,
	TRANSFORM_VERSION as INGEST_VERSION,
} from "../../ingest/transform.ts";
import { appTidTillIso, appTillPost, contentHash, TRANSFORM_VERSION } from "../../src/sync/post";
import { tillRad } from "../../src/sync/rad";
import { FALUN_GPKG, HAS_FALUN, SKIP_MESSAGE } from "../store/falun-fixture";
import { appFixture, UUID } from "./helpers";

describe("samma hash och rad som inläsningen", () => {
	it("TRANSFORM_VERSION är densamma", () => {
		expect(TRANSFORM_VERSION).toBe(INGEST_VERSION);
	});

	for (const uuid of Object.values(UUID)) {
		it(`${uuid}: contentHash och rad som ingest/transform.ts`, async () => {
			const b = appTillPost(appFixture(uuid), "2026-11-17");
			expect(b).not.toBeNull();
			const post = b?.post as KallPost;
			expect(await contentHash(post)).toBe(ingestHash(post));
			const mine = await tillRad(post);
			const theirs = toIndexPost(post, new Indelning(null));
			expect(mine.rad).toEqual(theirs.rad);
			expect(mine.egenskaper).toEqual(theirs.egenskaper);
			expect(mine.ingaende).toEqual(theirs.ingaende);
		});
	}

	it("hashen ändras med innehållet men inte med uttagsdatum", async () => {
		const a = appTillPost(appFixture(UUID.L2001_646), "2026-11-17")?.post;
		const b = appTillPost(appFixture(UUID.L2001_646), "2026-11-18")?.post;
		const c = appTillPost(
			{ ...appFixture(UUID.L2001_646), tradition: "annan" },
			"2026-11-17",
		)?.post;
		if (!a || !b || !c) throw new Error("ingen post");
		expect(await contentHash(a)).toBe(await contentHash(b));
		expect(await contentHash(a)).not.toBe(await contentHash(c));
	});
});

describe("appens tidsstämpel → GeoPackage-filens form", () => {
	it("svensk tidszon, millisekunder avrundade", () => {
		expect(appTidTillIso("2018-10-01T09:34:41")).toBe("2018-10-01T09:34:41+02:00");
		expect(appTidTillIso("2022-07-18T14:28:18.298635")).toBe("2022-07-18T14:28:18.299+02:00");
		expect(appTidTillIso("2018-11-20T15:09:50.725")).toBe("2018-11-20T15:09:50.725+01:00");
		expect(appTidTillIso("2026-11-10T11:39:55.332744+01:00")).toBe(
			"2026-11-10T11:39:55.333+01:00",
		);
		expect(appTidTillIso("2026-03-29T03:30:00")).toBe("2026-03-29T03:30:00+02:00");
	});
});

describe.skipIf(!HAS_FALUN)(
	`fältmappning app → GeoPackage (Falun) ${HAS_FALUN ? "" : SKIP_MESSAGE}`,
	() => {
		function fromGpkg(uuids: string[]): Map<string, KallPost> {
			const r = new GpkgReader(FALUN_GPKG);
			const out = new Map<string, KallPost>();
			try {
				for (const p of r.posts()) if (uuids.includes(p.uuid)) out.set(p.uuid, p);
			} finally {
				r.close();
			}
			return out;
		}
		const gp = HAS_FALUN
			? fromGpkg([UUID.L2001_646, UUID.L2000_8802])
			: new Map<string, KallPost>();

		it("L2001:646: alla fält lika utom namn (appens alternativnamn saknas i filen)", () => {
			const app = appTillPost(appFixture(UUID.L2001_646), "2026-11-17")?.post as KallPost;
			const file = gp.get(UUID.L2001_646) as KallPost;
			expect(app.namn).toBe("Mas-källa");
			expect(file.namn).toBeNull();
			expect({ ...app, namn: null }).toEqual(file);
		});

		it("L2000:8802: alla fält lika utom ingående lämningars id", () => {
			const app = appTillPost(appFixture(UUID.L2000_8802), "2026-11-17")?.post as KallPost;
			const file = gp.get(UUID.L2000_8802) as KallPost;
			const utanId = (p: KallPost) => ({
				...p,
				ingaende: p.ingaende.map((i) => ({ ...i, nr: 0 })),
				egenskaper: p.egenskaper.map((e) => ({
					...e,
					ingaende_nr: e.ingaende_nr === null ? null : 0,
				})),
			});
			expect(utanId(app)).toEqual(utanId(file));
			// Ordningen motsvarar varandra: löpnummer 1–5 mot filens id i stigande ordning.
			expect(app.ingaende.map((i) => i.lamningstyp)).toEqual(
				file.ingaende.map((i) => i.lamningstyp),
			);
		});
	},
);
