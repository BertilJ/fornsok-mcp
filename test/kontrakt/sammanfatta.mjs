#!/usr/bin/env node
/**
 * Sammanfattning av kontrakttesterna som Markdown (för $GITHUB_STEP_SUMMARY).
 *
 *   node test/kontrakt/sammanfatta.mjs [rapport.json] [anropslogg.jsonl]
 *
 * Läser vitests JSON-rapport (standard: $KONTRAKT_RAPPORT) och anropsloggen
 * (standard: $KONTRAKT_LOGG) och skriver rapporten på stdout. Felrader har
 * formen `[KLASS] källa | anrop | fält: avvikelse` (se stod.ts). Skriptet
 * avslutar alltid med 0; det är testkörningen som gör jobbet rött.
 */
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rapportSokvag = process.argv[2] || process.env.KONTRAKT_RAPPORT || join(tmpdir(), "fornsok-kontrakt-rapport.json");
const loggSokvag = process.argv[3] || process.env.KONTRAKT_LOGG || join(tmpdir(), "fornsok-kontrakt-anrop.jsonl");

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
const LINJE = /\[(FORMAT|OTILLGÄNGLIG)\] ([^\n]*?) \| ([^\n]*?) \| ([^\n]*)/g;

function out(s = "") {
	process.stdout.write(`${s}\n`);
}

if (!existsSync(rapportSokvag)) {
	out("## Kontrakttest mot RAÄ:s källor");
	out();
	out(`Ingen testrapport hittades (${rapportSokvag}). Testkörningen avbröts troligen innan den hann skriva en rapport; se loggen för steget.`);
	process.exit(0);
}

let rapport;
try {
	rapport = JSON.parse(readFileSync(rapportSokvag, "utf8"));
} catch (e) {
	out("## Kontrakttest mot RAÄ:s källor");
	out();
	out(`Testrapporten gick inte att läsa: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(0);
}

const format = new Map();
const otillganglig = new Map();
const ovrigt = [];
const perKalla = new Map();
let godkanda = 0;
let misslyckade = 0;

for (const fil of rapport.testResults ?? []) {
	const filnamn = String(fil.name ?? "").split("/").pop();
	if (fil.status === "failed" && (fil.assertionResults ?? []).length === 0) {
		ovrigt.push({ test: filnamn, text: String(fil.message ?? "filen kunde inte köras").split("\n")[0] });
		misslyckade++;
	}
	for (const t of fil.assertionResults ?? []) {
		const namn = t.fullName || [...(t.ancestorTitles ?? []), t.title].join(" > ");
		const grupp = (t.ancestorTitles ?? [])[0] ?? filnamn;
		const rad = perKalla.get(grupp) ?? { ok: 0, fel: 0 };
		perKalla.set(grupp, rad);
		if (t.status === "passed") {
			godkanda++;
			rad.ok++;
			continue;
		}
		if (t.status !== "failed") continue;
		misslyckade++;
		rad.fel++;
		const text = (t.failureMessages ?? []).join("\n");
		let hittad = false;
		for (const m of text.matchAll(LINJE)) {
			hittad = true;
			const [, klass, kalla, anrop, rest] = m;
			const i = rest.indexOf(": ");
			const falt = i >= 0 ? rest.slice(0, i) : "";
			const avvikelse = i >= 0 ? rest.slice(i + 2) : rest;
			const mapp = klass === "FORMAT" ? format : otillganglig;
			mapp.set(`${kalla}|${anrop}|${falt}|${avvikelse}`, { kalla, anrop, falt, avvikelse });
		}
		if (!hittad) ovrigt.push({ test: namn, text: text.split("\n").find((l) => l.trim()) ?? "okänt fel" });
	}
}

let anrop = null;
if (existsSync(loggSokvag)) {
	const rader = readFileSync(loggSokvag, "utf8").split("\n").filter(Boolean);
	anrop = rader.length;
}

const totalt = godkanda + misslyckade;
out("## Kontrakttest mot RAÄ:s källor");
out();
if (misslyckade === 0) {
	out(`Alla ${totalt} kontroller godkändes${anrop !== null ? ` (${anrop} anrop mot källorna)` : ""}. Inget svarsformat har ändrats.`);
} else if (format.size > 0) {
	out(`**Svarsformatet har ändrats hos minst en källa.** ${misslyckade} av ${totalt} kontroller misslyckades${anrop !== null ? ` (${anrop} anrop)` : ""}. Servern kan sluta fungera mot den källan; åtgärda tolkningen i \`src/sources/\` eller \`src/sync/\`, eller rätta testet om ändringen är avsiktlig.`);
} else if (otillganglig.size > 0 && ovrigt.length === 0) {
	out(`**Bara otillgänglighet.** ${misslyckade} av ${totalt} kontroller kunde inte köras för att en tjänst inte svarade. Det säger inget om svarsformaten och är oftast tillfälligt; kör om manuellt (\`workflow_dispatch\`) om det upprepas flera nätter.`);
} else {
	out(`**${misslyckade} av ${totalt} kontroller misslyckades** av annat skäl än en ändring i ett svarsformat (se nedan).`);
}

function tabell(rubrik, mapp, kolumner) {
	if (mapp.size === 0) return;
	out();
	out(`### ${rubrik} (${mapp.size})`);
	out();
	out(`| Källa | Anrop | ${kolumner} |`);
	out("|---|---|---|");
	for (const r of mapp.values()) out(`| ${cell(r.kalla)} | ${cell(r.anrop)} | ${r.falt ? `\`${cell(r.falt)}\`: ` : ""}${cell(r.avvikelse)} |`);
}

tabell("Svarsformatet har ändrats", format, "Fält och avvikelse");
tabell("Tjänsten svarar inte (tillfälligt?)", otillganglig, "Orsak");

if (ovrigt.length > 0) {
	out();
	out(`### Övriga fel (${ovrigt.length})`);
	out();
	for (const o of ovrigt) out(`- ${cell(o.test)}: ${cell(o.text)}`);
}

out();
out("### Per källa");
out();
out("| Grupp | Godkända | Misslyckade |");
out("|---|---|---|");
for (const [grupp, r] of perKalla) out(`| ${cell(grupp)} | ${r.ok} | ${r.fel} |`);
