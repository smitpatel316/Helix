// Multi-file verification for prism2hlx, over the .prism corpus.
//
//   npm run verify-corpus
//
// Runs every `.prism` in the corpus directory (PRISM_TEST_CORPUS_PRISM10,
// else ~/workspace/helix/test-corpus-prism10) through the converter and,
// per file, checks:
//   C0  the real CLI converts a good file (exit 0, .hlx written) and
//       refuses a bad one (exit 1) — once per run, not per file
//   C1  conversion succeeds (or fails cleanly, for the known-reject files)
//   C2  tables: converted names are the document's data sheets in order,
//       and any sheet left out is named in a warning — never silently
//       dropped
//   C3  every converted table's dims match its content.json
//   C4  every cell matches its source data.csv (independently rebuilt
//       here from the raw CSV + sheet/dataset JSONs — not via the
//       converter)
//   C5  analyses: supported ones transferred onto the right table,
//       everything else named in the report as not yet supported
//   C6  the written .hlx round-trips through Helix's own parseProjectFile
//   C7  the source file's checksum is unchanged
//   C8  no converted value carries a stray carriage return or a comma
//       decimal separator — both would mean the CSV layer leaked raw text
//       into the .hlx (the C3/C4 rebuild shares the converter's parser,
//       so it can't catch those on its own)
//
// The expectation builder mirrors the field-by-field mapping in the vault
// spec (~/workspace/helix-vault/Research/Prism 10 to hlx mapping.md) and
// is written separately from the converter, straight from the raw files.
// Public files only — Mansi's files are never test material.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { parseProjectFile, serializeProjectFile } from "../../src/lib/project-file";
import { convertPrism, type ConvertResult } from "../src/prism";
import { parseCsv } from "../src/csv";

const CONVERTER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CORPUS =
  process.env.PRISM_TEST_CORPUS_PRISM10 ??
  join(process.env.HOME ?? "~", "workspace/helix/test-corpus-prism10");

/** Files that must fail conversion, and the message the failure must carry. */
const EXPECTED_REJECTS: Record<string, string> = {
  "empty.prism": "document.json is missing",
  // Synthetic graphs-only file: no data tables at all, so the converter
  // refuses rather than writing a .hlx Helix itself can't open.
  "synthetic-graphs-only.prism": "has no data tables Helix can use",
};

let failures = 0;
let checks = 0;
function check(file: string, name: string, ok: boolean, detail: string) {
  checks++;
  console.log(`${ok ? "PASS" : "FAIL"} ${file} ${name} — ${detail}`);
  if (!ok) failures++;
}

// ── Independent expectation builder (vault spec, straight from raw files) ──

const SUFFIXES: Record<string, string[] | null> = {
  y_replicates: null,
  y_single: [],
  y_sd_n: ["_MEAN", "_SD", "_N"],
  y_se_n: ["_MEAN", "_SEM", "_N"],
  y_cv_n: ["_MEAN", "_CV", "_N"],
  y_sd: ["_MEAN", "_SD"],
  y_se: ["_MEAN", "_SE"],
  y_cv: ["_MEAN", "_CV"],
  y_plus_minus: ["_MEAN", "_PLUSERROR", "_MINUSERROR"],
  y_high_low: ["_MEAN", "_PLUSERROR", "_MINUSERROR"],
};
function expectedNames(title: string, dataFormat: string, count: number): string[] {
  const base = title === "" ? "Y" : title;
  if (count === 1) return [base];
  const s = SUFFIXES[dataFormat];
  if (s && s.length === count) return s.map((x) => `${base}${x}`);
  if (s === null) return Array.from({ length: count }, (_, i) => `${base}_${i + 1}`);
  return Array.from({ length: count }, (_, i) => `${base}_${i + 1}`);
}
/** `1,5` (comma decimal) → `1.5`; same rule as the converter. */
const normalizeNumber = (value: string | null): string | null =>
  value !== null && /^-?\d+,\d+$/.test(value) ? value.replace(",", ".") : value;

/** A Prism title as plain text (see converter/src/prism.ts plainTitle). */
function plainTitle(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const s = (value as { string?: unknown }).string;
    if (typeof s === "string") return s;
  }
  return "";
}

/** Parse a Prism date cell: ISO ("2024-09-06 00:00:00") or US ("12/17/2024"). */
function parsePrismDate(value: string | null): number | null {
  if (value === null || value === "") return null;
  let ms = Date.parse(value.replace(" ", "T"));
  if (!Number.isNaN(ms)) return ms;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (m) {
    ms = Date.parse(`${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}T00:00:00`);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

function daysBetween(start: string | null, end: string | null): string | null {
  const a = parsePrismDate(start);
  const b = parsePrismDate(end);
  if (a === null || b === null) return null;
  const days = (b - a) / 86_400_000;
  return Number.isInteger(days) ? String(days) : String(Number(days.toFixed(6)));
}

interface SheetInfo {
  uid: string;
  title: string;
  format: string;
  dataFormat: string;
  replicatesCount?: number;
  tableUid: string;
  content: { numberOfColumns: number; numberOfRows: number };
  csv: string[][];
  sets: { title?: string | { string?: string }; replicates?: unknown[]; "replicate ranges"?: { range?: string }[] }[];
  xTitle: string | null;
  /** Subcolumns the X dataset spans in the CSV (0 = no X dataset). */
  xCount: number;
  /** The X dataset's format (e.g. "date_se" on survival tables). */
  xFormat: string;
  hasTitleCol: boolean;
}
function repCount(
  s: { replicates?: unknown[]; "replicate ranges"?: { range?: string }[] },
  fallback: number,
): number {
  if (Array.isArray(s.replicates)) return s.replicates.length;
  if (Array.isArray(s["replicate ranges"])) {
    return s["replicate ranges"].reduce((n, r) => {
      const m = /^(\d+)(?:~(\d+))?$/.exec(r.range ?? "");
      return m ? n + (m[2] === undefined ? 1 : Number(m[2]) - Number(m[1]) + 1) : n;
    }, 0);
  }
  return fallback;
}
/** Expected Helix column names for a sheet, in order (after the Title col). */
function expectedColumns(sheet: SheetInfo): string[] {
  const cols: string[] = [];
  if (sheet.xTitle !== null) cols.push(sheet.xTitle);
  if (sheet.format === "grouped") {
    for (const s of sheet.sets) {
      const g = plainTitle(s.title) || "Group";
      for (let i = 0; i < repCount(s, sheet.replicatesCount ?? 0); i++) cols.push(`${g}:Y${i + 1}`);
    }
  } else {
    for (const s of sheet.sets) {
      cols.push(...expectedNames(plainTitle(s.title), sheet.dataFormat, repCount(s, sheet.replicatesCount ?? 0)));
    }
  }
  return cols;
}
/** Expected Helix rows for a sheet, built straight from its CSV. */
function expectedRows(sheet: SheetInfo): (string | null)[][] {
  const csv = sheet.csv;
  const hasTitle = sheet.hasTitleCol;
  const hasX = sheet.xTitle !== null;
  let cursor = 0;
  const colVals: (string | null)[][] = [];
  if (hasTitle) cursor++;
  if (hasX) {
    if (sheet.format === "survival" && sheet.xFormat.startsWith("date") && sheet.xCount >= 2) {
      // X is start/end dates: Helix time is the gap in days.
      const starts = csv.map((r) => (r[cursor] === "" ? null : (r[cursor] ?? null)));
      const ends = csv.map((r) => (r[cursor + 1] === "" ? null : (r[cursor + 1] ?? null)));
      colVals.push(starts.map((s, i) => daysBetween(s, ends[i])));
    } else {
      colVals.push(csv.map((r) => normalizeNumber(r[cursor] === "" ? null : (r[cursor] ?? null))));
    }
    cursor += sheet.xCount;
  }
  for (const s of sheet.sets) {
    for (let i = 0; i < repCount(s, sheet.replicatesCount ?? 0); i++) {
      colVals.push(csv.map((r) => normalizeNumber(r[cursor] === "" ? null : (r[cursor] ?? null))));
      cursor++;
    }
  }
  const titles = hasTitle ? csv.map((r) => (r[0] === "" ? null : (r[0] ?? null))) : csv.map(() => null);
  const rowCount = sheet.content.numberOfRows;
  return Array.from({ length: rowCount }, (_, r) => [
    titles[r] ?? null,
    ...colVals.map((c) => c[r] ?? null),
  ]);
}

interface DocJson {
  createdBy?: { version?: string };
  formatVersion?: string;
  sheets?: {
    graphs?: string[];
    layouts?: string[];
    analyses?: string[];
    info?: string[];
    data?: string[];
  };
  sheetAttributesMap?: Record<string, { title?: string }>;
}

async function verifyFile(fileName: string): Promise<void> {
  const path = join(CORPUS, fileName);
  const input = await readFile(path);
  const beforeHash = createHash("sha256").update(input).digest("hex");

  let result: ConvertResult;
  try {
    result = await convertPrism(input, fileName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const want = EXPECTED_REJECTS[fileName];
    check(fileName, "C1 convert", want !== undefined && msg.includes(want), `threw: ${msg}`);
    return;
  }
  if (EXPECTED_REJECTS[fileName] !== undefined) {
    check(fileName, "C1 convert", false, `should have failed (${EXPECTED_REJECTS[fileName]}) but converted`);
    return;
  }
  check(fileName, "C1 convert", true, `${result.report.tables.length} tables, ${result.report.analyses.length} analyses`);
  const { project, report } = result;

  const zip = await JSZip.loadAsync(input);
  const text = async (p: string) => (await zip.file(p)?.async("string")) ?? null;
  const json = async <T>(p: string): Promise<T> => JSON.parse((await text(p)) as string) as T;
  const doc = await json<DocJson>("document.json");
  const titles = doc.sheetAttributesMap ?? {};

  // Load every data sheet's raw pieces.
  const sheets: SheetInfo[] = [];
  for (const sheetUid of doc.sheets?.data ?? []) {
    const sheet = await json<{
      title?: string;
      table?: {
        uid?: string;
        format?: string;
        dataFormat?: string;
        replicatesCount?: number;
        dataSets?: string[];
        xDataSet?: string;
        rowTitlesDataSet?: string;
      };
    }>(`data/sheets/${sheetUid}/sheet.json`);
    const table = sheet.table;
    if (!table?.uid) continue;
    const content = await json<{ numberOfColumns: number; numberOfRows: number }>(
      `data/tables/${table.uid}/content.json`,
    );
    const csvText = await text(`data/tables/${table.uid}/data.csv`);
    if (csvText === null) continue;
    let csv = parseCsv(csvText);
    if (csv.length > content.numberOfRows) csv = csv.slice(0, content.numberOfRows);
    while (csv.length < content.numberOfRows) csv.push([]);
    const sets = await Promise.all(
      (table.dataSets ?? []).map((u) =>
        json<{ title?: string | { string?: string }; replicates?: unknown[]; "replicate ranges"?: { range?: string }[] }>(
          `data/sets/${u}.json`,
        ).catch(() => null),
      ),
    );
    let xTitle: string | null = null;
    let xCount = 0;
    let xFormat = "";
    if (table.xDataSet) {
      const xSet = await json<{ title?: string | { string?: string }; format?: string; replicates?: unknown[]; "replicate ranges"?: { range?: string }[] }>(
        `data/sets/${table.xDataSet}.json`,
      ).catch(() => null);
      if (xSet) {
        xTitle = plainTitle(xSet.title) || "X";
        xCount = repCount(xSet, table.replicatesCount ?? 0);
        xFormat = xSet.format ?? "";
      } else {
        xTitle = "X";
        xCount = 1;
      }
    }
    sheets.push({
      uid: sheetUid,
      title: plainTitle(sheet.title) || plainTitle(titles[sheetUid]?.title) || "Imported table",
      format: table.format ?? "",
      dataFormat: table.dataFormat ?? "",
      replicatesCount: table.replicatesCount,
      tableUid: table.uid,
      content,
      csv,
      sets: sets.filter((s): s is NonNullable<typeof s> => s !== null),
      xTitle,
      xCount,
      xFormat,
      hasTitleCol: table.rowTitlesDataSet != null,
    });
  }

  // C2: converted tables are the document's data sheets in order; anything
  // left out must be named in a warning.
  const expectedOrder = sheets.map((s) => s.title);
  const converted = report.tables;
  let sub = 0;
  let orderOk = true;
  for (const name of converted) {
    const idx = expectedOrder.indexOf(name, sub);
    if (idx === -1) {
      orderOk = false;
      break;
    }
    sub = idx + 1;
  }
  const leftOut = expectedOrder.filter((n) => !converted.includes(n));
  const warned = leftOut.filter((n) =>
    report.issues.some((i) => i.severity === "warning" && i.message.includes(`“${n}”`)),
  );
  check(
    fileName,
    "C2 tables",
    orderOk && warned.length === leftOut.length,
    `${converted.length} of ${expectedOrder.length} sheets converted in order` +
      (leftOut.length ? `; left out ${leftOut.length}, warned about ${warned.length}` : ""),
  );

  // C3 + C4: dims + cells for every converted table.
  const convertedNodes = project.rootOrder
    .map((id) => project.nodes[id])
    .filter((n) => n.type === "table");
  let cells = 0;
  const bad: string[] = [];
  const usedSheets = new Set<string>();
  for (const node of convertedNodes) {
    const sheet = sheets.find(
      (s) =>
        !usedSheets.has(s.uid) &&
        s.title === node.name &&
        node.data !== undefined &&
        node.data.columns.join("|") === ["Title", ...expectedColumns(s)].join("|"),
    );
    if (!sheet) {
      bad.push(`${node.name}: no source sheet matches its columns`);
      continue;
    }
    usedSheets.add(sheet.uid);
    const data = node.data;
    if (!data) {
      bad.push(`${node.name}: no data`);
      continue;
    }
    // .hlx columns: Title + one X column + dataset subcolumns. The CSV
    // holds the title column (only when the table has row titles) plus
    // every X subcolumn, so the counts differ by exactly that.
    const datasetCols = expectedColumns(sheet).length - (sheet.xTitle !== null ? 1 : 0);
    const expectedCols = 1 + (sheet.xTitle !== null ? 1 : 0) + datasetCols;
    if (data.columns.length !== expectedCols || data.rows.length !== sheet.content.numberOfRows) {
      bad.push(
        `${node.name}: dims ${data.columns.length}x${data.rows.length} vs expected ${expectedCols}x${sheet.content.numberOfRows}`,
      );
    }
    if (sheet.format === "grouped") {
      if (data.groups !== sheet.sets.length || data.replicates !== sheet.replicatesCount) {
        bad.push(`${node.name}: groups=${data.groups} replicates=${data.replicates} vs ${sheet.sets.length}/${sheet.replicatesCount}`);
      }
    }
    // Compare the overlapping cells even when the dims are off, so a
    // shifted column is caught as wrong values, not just wrong dims.
    const expRows = expectedRows(sheet);
    for (let r = 0; r < Math.min(data.rows.length, expRows.length); r++) {
      for (let c = 0; c < Math.min(data.rows[r].length, expRows[r].length); c++) {
        cells++;
        if (data.rows[r][c] !== expRows[r][c]) {
          bad.push(`${node.name} r${r} c${c} (${data.columns[c]}): got ${JSON.stringify(data.rows[r][c])}, want ${JSON.stringify(expRows[r][c])}`);
        }
      }
    }
  }
  check(
    fileName,
    "C3+C4 dims+cells",
    bad.length === 0,
    `${cells} cells compared; ${bad.length} problems${bad.length ? ": " + bad.slice(0, 3).join(" | ") : ""}`,
  );

  // C8: values are clean — no stray \r, no comma-decimal text left in the
  // .hlx. The C3/C4 rebuild shares the converter's CSV parser, so it
  // would agree with a parser leak; this check is independent of it.
  const dirty: string[] = [];
  for (const node of convertedNodes) {
    if (!node.data) continue;
    for (let r = 0; r < node.data.rows.length; r++) {
      for (let c = 0; c < node.data.rows[r].length; c++) {
        const v = node.data.rows[r][c];
        if (typeof v === "string" && (v.includes("\r") || /^-?\d+,\d+$/.test(v))) {
          dirty.push(`${node.name} r${r} c${c}: ${JSON.stringify(v)}`);
        }
      }
    }
  }
  check(
    fileName,
    "C8 values clean",
    dirty.length === 0,
    dirty.length ? dirty.slice(0, 3).join(" | ") : "no stray CR or comma decimals",
  );

  // C5: analyses — supported ones transferred onto the right table, the
  // rest named in the report.
  const analysisNodes = Object.values(project.nodes).filter((n) => n.type === "analysis");
  const nodeTypesOk = analysisNodes.every(
    (n) => n.analysisType === "nonlinear-regression" || n.analysisType === "survival-log-rank",
  );
  const parentsOk = analysisNodes.every((n) => n.parentId !== null && project.nodes[n.parentId]?.type === "table");
  const analysisProblems: string[] = [];
  if (!nodeTypesOk) analysisProblems.push("unknown analysisType on a converted node");
  if (!parentsOk) analysisProblems.push("analysis node without a table parent");
  for (const analysisUid of doc.sheets?.analyses ?? []) {
    const sheet = await json<{
      title?: string;
      analysisClass?: string;
      inputSheets?: { uid?: string; title?: string }[];
      inputDataSets?: { uid?: string; title?: string; idx?: string }[];
    }>(`analyses/${analysisUid}/sheet.json`).catch(() => null);
    if (!sheet) continue;
    const name = plainTitle(sheet.title) || plainTitle(titles[analysisUid]?.title) || "Imported analysis";
    const params = await json<{ analysisClass?: string; content?: { model?: { equation?: { name?: string } } } }>(
      `analyses/${analysisUid}/parameters.json`,
    ).catch(() => null);
    const analysisClass = sheet.analysisClass ?? params?.analysisClass ?? "";
    const inputUid = sheet.inputSheets?.[0]?.uid;
    const inputTable = inputUid ? sheets.find((s) => s.uid === inputUid) : undefined;
    const inputConverted = inputTable !== undefined && converted.includes(inputTable.title);
    if (analysisClass === "NONLINEAR_REGRESSION") {
      const equation = params?.content?.model?.equation?.name ?? "";
      if (equation === "Sigmoidal, 4PL, X is concentration") {
        if (!inputConverted) {
          if (!report.issues.some((i) => i.message.includes(`“${name}”`))) {
            analysisProblems.push(`${name}: 4PL but input table missing and no warning`);
          }
        } else {
          const want = (sheet.inputDataSets ?? []).map((ds) =>
            plainTitle(ds.title) ? `${name} (${plainTitle(ds.title)})` : name,
          );
          for (const w of want.length ? want : [name]) {
            if (!report.analyses.includes(w)) analysisProblems.push(`${name}: expected converted node “${w}”`);
          }
        }
      } else if (!report.analysesUnsupported.some((u) => u.includes(name))) {
        analysisProblems.push(`${name}: model “${equation}” not named as unsupported`);
      }
    } else if (analysisClass === "SURVIVAL") {
      if (inputConverted && !report.analyses.includes(name)) {
        analysisProblems.push(`${name}: survival not converted`);
      }
      if (!inputConverted && !report.issues.some((i) => i.message.includes(`“${name}”`))) {
        analysisProblems.push(`${name}: survival with missing input table and no warning`);
      }
    } else if (!report.analysesUnsupported.some((u) => u.includes(name))) {
      if (!report.issues.some((i) => i.message.includes(`“${name}”`))) {
        analysisProblems.push(`${name}: ${analysisClass} neither named unsupported nor warned about`);
      }
    }
  }
  check(
    fileName,
    "C5 analyses",
    analysisProblems.length === 0,
    `${analysisNodes.length} converted, ${report.analysesUnsupported.length} named unsupported` +
      (analysisProblems.length ? ": " + analysisProblems.slice(0, 3).join(" | ") : ""),
  );

  // C6: round-trip through Helix's own parser.
  const dir = await mkdtemp(join(tmpdir(), "prism2hlx-corpus-"));
  const outPath = join(dir, "out.hlx");
  await writeFile(outPath, serializeProjectFile(project));
  const parsed = parseProjectFile(JSON.parse(await readFile(outPath, "utf8")));
  if ("error" in parsed) {
    check(fileName, "C6 round-trip", false, parsed.error);
  } else {
    const n = Object.keys(parsed.project.nodes).length;
    const errs = parsed.issues.filter((i) => i.severity === "error");
    check(
      fileName,
      "C6 round-trip",
      n === Object.keys(project.nodes).length && errs.length === 0,
      `${n} nodes re-read; error issues: ${errs.length}`,
    );
  }

  // C7: source untouched.
  const afterHash = createHash("sha256").update(await readFile(path)).digest("hex");
  check(fileName, "C7 source untouched", beforeHash === afterHash, `sha256 ${beforeHash.slice(0, 12)}…`);
}

// C0: the real CLI, once per run. The probe files live in the public
// corpus; a corpus without them (e.g. the synthetic-only dir) skips C0.
async function checkCli(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "prism2hlx-cli-"));
  const good = join(CORPUS, "no_analysis.prism");
  const bad = join(CORPUS, "empty.prism");
  if (!existsSync(good) || !existsSync(bad)) {
    console.log("C0 skipped — probe files (no_analysis.prism, empty.prism) not in this corpus");
    return;
  }
  const goodOut = join(dir, "no_analysis.hlx");
  try {
    execFileSync(
      process.execPath,
      ["--import", "tsx", join(CONVERTER_DIR, "src/cli.ts"), good, goodOut],
      { cwd: join(CONVERTER_DIR, ".."), stdio: "pipe" },
    );
    const out = await readFile(goodOut, "utf8");
    check("cli", "C0 convert", out.includes("nodes"), "exit 0, .hlx written and parses as JSON");
  } catch (err) {
    check("cli", "C0 convert", false, err instanceof Error ? err.message : String(err));
  }
  try {
    execFileSync(
      process.execPath,
      ["--import", "tsx", join(CONVERTER_DIR, "src/cli.ts"), bad, join(dir, "empty.hlx")],
      { cwd: join(CONVERTER_DIR, ".."), stdio: "pipe" },
    );
    check("cli", "C0 reject", false, "empty.prism converted but should have failed");
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer };
    check("cli", "C0 reject", e.status === 1, `exit ${e.status ?? "?"} on empty.prism`);
  }
}

await checkCli();
const files = (await readdir(CORPUS)).filter((f) => f.endsWith(".prism")).sort();
console.log(`Corpus: ${CORPUS} — ${files.length} files`);
for (const f of files) await verifyFile(f);
console.log(`\n${checks - failures}/${checks} checks passed.`);
process.exit(failures ? 1 : 0);
