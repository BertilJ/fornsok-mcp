/**
 * Gemensamt för synktesterna: tom databas med migreringarna 0001 och 0002 i
 * node:sqlite (via adaptern i test/store), och en falsk fetch som svarar från
 * inspelade svar.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FetchLike } from "../../src/upstream/client";
import { fixture, fixtureResponse, json } from "../helpers";
import { d1FromSqlite } from "../store/d1-adapter";

export const MIGRATIONS = join(__dirname, "../../migrations");
export const SYNC_FIXTURES = join(__dirname, "fixtures");

export const UUID = {
	L2001_646: "adc490ba-871a-45bd-8e3d-0a27761b3b6c",
	L2000_8802: "6d1cf7b6-f5bd-4066-aba6-fb1ea3ce8c75",
	L1946_7415: "bfe10d94-5d11-4943-8085-4b1bfcaacf64",
} as const;

export const NR_FOR_UUID: Record<string, string> = {
	[UUID.L2001_646]: "L2001-646",
	[UUID.L2000_8802]: "L2000-8802",
	[UUID.L1946_7415]: "L1946-7415",
};

export function emptyDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(readFileSync(join(MIGRATIONS, "0001_init.sql"), "utf8"));
	db.exec(readFileSync(join(MIGRATIONS, "0002_synk_semantik.sql"), "utf8"));
	return db;
}

export function openD1(db: DatabaseSync) {
	return d1FromSqlite(db);
}

export function syncFixture<T = unknown>(name: string): T {
	return JSON.parse(readFileSync(join(SYNC_FIXTURES, name), "utf8")) as T;
}

/** En post i ändringsflödet, byggd på en riktig post ur den inspelade dagen 2026-11-10. */
export function flodePost(
	uuid: string,
	lamningsnummer: string,
	typer: string[],
): Record<string, unknown> {
	const day = syncFixture<{ content: Array<Record<string, unknown>> }>("flode-2026-11-10.json");
	const mall = structuredClone(day.content[3]);
	return {
		...mall,
		id: uuid,
		lamningsnummer,
		uppdateringstyp: typer,
		url: `https://pub.raa.se/visa/objekt/lamning/${uuid}`,
	};
}

/** Sidindelat svar som ändringsflödet ger det (form som i den inspelade sidan). */
export function flodeSvar(
	content: Array<Record<string, unknown>>,
	page: number,
	size: number,
): Record<string, unknown> {
	const mall = syncFixture<Record<string, unknown>>("flode-2026-11-10-sida0-storlek5.json");
	const totalPages = Math.max(1, Math.ceil(content.length / size));
	const slice = content.slice(page * size, page * size + size);
	return {
		...mall,
		content: slice,
		number: page,
		size,
		numberOfElements: slice.length,
		totalElements: content.length,
		totalPages,
		first: page === 0,
		last: page >= totalPages - 1,
		empty: slice.length === 0,
		pageable: {
			...(mall.pageable as object),
			pageNumber: page,
			pageSize: size,
			offset: page * size,
		},
	};
}

export interface FakeRaa {
	fetch: FetchLike;
	calls: URL[];
	/** Ändringsflödet per datum (from-datum → poster). Intervall slås ihop. */
	flode: Map<string, Array<Record<string, unknown>>>;
	/** Ändrade apposter (uuid → JSON) eller status. */
	app: Map<string, Record<string, unknown> | number>;
	ksamsokStatus?: number;
}

export function fakeRaa(): FakeRaa {
	const state: FakeRaa = {
		fetch: null as unknown as FetchLike,
		calls: [],
		flode: new Map(),
		app: new Map(),
	};
	state.fetch = async (input) => {
		const url = new URL(
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
		);
		state.calls.push(url);
		if (url.hostname === "pub.raa.se" && url.pathname === "/datauttag/lamningar") {
			const from = url.searchParams.get("from") as string;
			const to = url.searchParams.get("to") as string;
			const all: Array<Record<string, unknown>> = [];
			for (const [d, poster] of state.flode) if (d >= from && d <= to) all.push(...poster);
			return json(
				flodeSvar(
					all,
					Number(url.searchParams.get("page") ?? 0),
					Number(url.searchParams.get("size") ?? 20),
				),
			);
		}
		const m = /^\/open\/fornsok\/api\/lamning\/lamning\/([0-9a-f-]{36})$/.exec(url.pathname);
		if (url.hostname === "app.raa.se" && m) {
			const override = state.app.get(m[1]);
			if (typeof override === "number") return json({ message: "fel" }, override);
			if (override) return json(override);
			const nr = NR_FOR_UUID[m[1]];
			return nr
				? fixtureResponse(`app-lamning-${nr}.json`)
				: json({ message: "Not found" }, 404);
		}
		if (url.hostname === "app.raa.se" && url.pathname === "/open/fornsok/api/lamning/domaner")
			return fixtureResponse("app-lamning-domaner.json");
		if (url.hostname === "app.raa.se" && url.pathname === "/open/fornsok/api/uppdrag/domaner")
			return fixtureResponse("app-uppdrag-domaner.json");
		const k = /^\/raa\/lamning\/([0-9a-f-]{36})$/.exec(url.pathname);
		if (url.hostname === "kulturarvsdata.se" && k) {
			if (state.ksamsokStatus) return json({}, state.ksamsokStatus);
			const nr = NR_FOR_UUID[k[1]];
			return nr
				? fixtureResponse(`ksamsok-jsonld-${nr}.json`, 200, "application/ld+json")
				: json({}, 404);
		}
		return new Response(`ingen fixtur för ${url.href}`, { status: 599 });
	};
	return state;
}

export function appFixture(uuid: string): Record<string, unknown> {
	return fixture<Record<string, unknown>>(`app-lamning-${NR_FOR_UUID[uuid]}.json`);
}

/** FTS5:s fullständiga kontroll mot innehållstabellen (rank 1). Kastar vid fel. */
export function ftsIntegrity(db: DatabaseSync): void {
	db.exec("INSERT INTO lamning_fts(lamning_fts, rank) VALUES('integrity-check', 1)");
}

export function ftsUuids(db: DatabaseSync, match: string): string[] {
	return (
		db
			.prepare(
				"SELECT l.uuid FROM lamning_fts f JOIN lamning l ON l.id = f.rowid WHERE lamning_fts MATCH ? ORDER BY l.uuid",
			)
			.all(match) as Array<{ uuid: string }>
	).map((r) => r.uuid);
}
