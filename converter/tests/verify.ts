// Headless verification for prism2hlx, against the public demo file only.
//
//   node --import tsx converter/tests/verify.ts
//
// Converts prism2R-demo_dataset.prism, then checks, per check with exact
// figures:
//   V1  conversion succeeds with no errors
//   V2  14 tables, in document order, with the exact sheet titles
//   V3  every table's dims match its content.json
//   V4  every cell matches its source data.csv (independently rebuilt here
//       from the raw CSV + sheet/dataset JSONs — not via the converter)
//   V5  analysis nodes: 2 nonlinear-regression (4PL, Control + Treated)
//       + 1 survival-log-rank, on the right tables
//   V6  the written .hlx round-trips through Helix's own parseProjectFile
//   V7  the source file's checksum is unchanged by conversion
//   V8  the transfer report counts (14 tables, 17 graphs + 1 layout not
//       transferred, orphans ignored)
//
// Corpus: PRISM_TEST_CORPUS env var, else ~/workspace/helix/test-corpus.
// Mansi's files are never test material; the corpus is public files only.

import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { parseProjectFile, serializeProjectFile } from "../../src/lib/project-file";
import { convertPrism } from "../src/prism";
import { parseCsv } from "../src/csv";

const CORPUS = process.env.PRISM_TEST_CORPUS ?? join(process.env.HOME ?? "~", "workspace/helix/test-corpus");
const DEMO = join(CORPUS, "prism2R-demo_dataset.prism");

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail: string) {
  checks++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) failures++;
}

// Independent expectation builder: same mapping rules as the vault spec,
// written separately from the converter, straight from the raw files.
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

const input = await readFile(DEMO);
const beforeHash = createHash("sha256").update(input).digest("hex");
const zip = await JSZip.loadAsync(input);
const text = async (p: string) => (await zip.file(p)?.async("string")) ?? null;
const json = async <T>(p: string): Promise<T> => JSON.parse((await text(p)) as string) as T;

const doc = await json<{
  sheets: { data: string[]; graphs: string[]; layouts: string[]; analyses: string[]; info: string[] };
  sheetAttributesMap: Record<string, { title?: string }>;
}>("document.json");

let result;
try {
  result = await convertPrism(input, "prism2R-demo_dataset.prism");
  check("V1 convert", true, `no error; ${result.report.tables.length} tables, ${result.report.analyses.length} analysis nodes`);
} catch (err) {
  check("V1 convert", false, err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const { project, report } = result;
const tables = project.rootOrder.map((id) => project.nodes[id]);
const tableByName = new Map<string, (typeof tables)[number][]>();
for (const t of tables) {
  const list = tableByName.get(t.name) ?? [];
  list.push(t);
  tableByName.set(t.name, list);
}

// V2: 14 tables, document order, exact titles.
const expectedTitles = doc.sheets.data.map((uid) => doc.sheetAttributesMap[uid]?.title ?? "");
check(
  "V2 tables",
  tables.length === 14 && tables.map((t) => t.name).join("|") === expectedTitles.join("|"),
  `${tables.length} tables; order ${tables.map((t) => t.name).join(" / ")}`,
);

// V3 + V4: dims + cell-by-cell vs source CSVs.
let v4cells = 0;
let v4bad: string[] = [];
for (const sheetUid of doc.sheets.data) {
  const sheet = await json<{ title?: string; table: { uid: string; format: string; dataFormat: string; replicatesCount?: number; dataSets: string[]; xDataSet?: string } }>(
    `data/sheets/${sheetUid}/sheet.json`,
  );
  const content = await json<{ numberOfColumns: number; numberOfRows: number }>(
    `data/tables/${sheet.table.uid}/content.json`,
  );
  const csv = parseCsv((await text(`data/tables/${sheet.table.uid}/data.csv`)) as string).slice(0, content.numberOfRows);
  const sets = await Promise.all(
    sheet.table.dataSets.map((u) =>
      json<{ title?: string; replicates?: unknown[]; "replicate ranges"?: { range?: string }[] }>(
        `data/sets/${u}.json`,
      ),
    ),
  );
  const repCount = (s: { replicates?: unknown[]; "replicate ranges"?: { range?: string }[] }): number => {
    if (Array.isArray(s.replicates)) return s.replicates.length;
    if (Array.isArray(s["replicate ranges"])) {
      return s["replicate ranges"].reduce((n, r) => {
        const m = /^(\d+)(?:~(\d+))?$/.exec(r.range ?? "");
        return m ? n + (m[2] === undefined ? 1 : Number(m[2]) - Number(m[1]) + 1) : n;
      }, 0);
    }
    return sheet.table.replicatesCount ?? 0;
  };
  const xTitle = sheet.table.xDataSet
    ? ((await json<{ title?: string }>(`data/sets/${sheet.table.xDataSet}.json`)).title ?? "X")
    : null;
  const hasTitle = sheet.table.format !== "xy";
  const hasX = xTitle !== null;
  const expCols = ["Title"];
  if (hasX) expCols.push(xTitle);
  if (sheet.table.format === "grouped") {
    sets.forEach((s) => {
      const g = s.title && s.title !== "" ? s.title : "Group";
      for (let i = 0; i < repCount(s); i++) expCols.push(`${g}:Y${i + 1}`);
    });
  } else {
    sets.forEach((s) => {
      expCols.push(...expectedNames(s.title ?? "", sheet.table.dataFormat, repCount(s)));
    });
  }
  const node = tables.find((t) => t.name === sheet.title && t.data!.columns.join("|") === expCols.join("|"));
  if (!node) {
    v4bad.push(`${sheet.title}: no table with expected columns [${expCols.join(", ")}]`);
    continue;
  }
  const data = node.data!;
  // .hlx has a Title column the CSV doesn't have on XY tables (their first
  // CSV column is X); grouped/column/survival CSVs already carry titles.
  const expectedHlxCols = content.numberOfColumns + (sheet.table.format === "xy" ? 1 : 0);
  const titleNote = sheet.table.format === "xy" ? " (+1 Title col for XY)" : "";
  check(
    `V3 dims ${sheet.title}`,
    data.columns.length === expectedHlxCols && data.rows.length === content.numberOfRows,
    `${data.columns.length}x${data.rows.length} vs content.json ${content.numberOfColumns}x${content.numberOfRows}${titleNote}`,
  );
  // Expected rows, built straight from the CSV.
  let cursor = 0;
  const colVals: (string | null)[][] = [];
  if (hasTitle) cursor++;
  if (hasX) {
    colVals.push(csv.map((r) => (r[cursor] === "" ? null : (r[cursor] ?? null))));
    cursor++;
  }
  for (const s of sets) {
    for (let i = 0; i < repCount(s); i++) {
      colVals.push(csv.map((r) => (r[cursor] === "" ? null : (r[cursor] ?? null))));
      cursor++;
    }
  }
  const titles = hasTitle ? csv.map((r) => (r[0] === "" ? null : (r[0] ?? null))) : csv.map(() => null);
  for (let r = 0; r < data.rows.length; r++) {
    const expected = [titles[r], ...colVals.map((c) => c[r] ?? null)];
    for (let c = 0; c < expected.length; c++) {
      v4cells++;
      if (data.rows[r][c] !== expected[c]) {
        v4bad.push(`${sheet.title} r${r} c${c} (${data.columns[c]}): got ${JSON.stringify(data.rows[r][c])}, want ${JSON.stringify(expected[c])}`);
      }
    }
  }
  // Grouped groups/replicates.
  if (sheet.table.format === "grouped") {
    const ok = data.groups === sets.length && data.replicates === sheet.table.replicatesCount;
    check(`V3 grouped ${sheet.title}`, ok === true, `groups=${data.groups} replicates=${data.replicates}`);
  }
}
check("V4 cells", v4bad.length === 0, `${v4cells} cells compared; ${v4bad.length} mismatches${v4bad.length ? ": " + v4bad.slice(0, 3).join(" | ") : ""}`);

// V5: analysis nodes.
const analyses = Object.values(project.nodes).filter((n) => n.type === "analysis");
const nonlin = analyses.filter((a) => a.analysisType === "nonlinear-regression");
const survival = analyses.filter((a) => a.analysisType === "survival-log-rank");
const nonlinOk =
  nonlin.length === 2 &&
  nonlin.every((a) => (a.analysisParams as { model?: string })?.model === "sigmoidal-4pl-x") &&
  new Set(nonlin.map((a) => (a.analysisParams as { y?: string })?.y)).size === 2 &&
  nonlin.every((a) => project.nodes[a.parentId ?? ""]?.name === "XY: Entering replicate data");
const survOk =
  survival.length === 1 && project.nodes[survival[0].parentId ?? ""]?.name === "Survival: Two groups";
check(
  "V5 analyses",
  analyses.length === 3 && nonlinOk && survOk,
  `${analyses.length} nodes: ${analyses.map((a) => `${a.name} (${a.analysisType})`).join("; ")}`,
);

// V6: round-trip through Helix's own parser.
const dir = await mkdtemp(join(tmpdir(), "prism2hlx-"));
const outPath = join(dir, "demo.hlx");
await writeFile(outPath, serializeProjectFile(project));
const parsed = parseProjectFile(JSON.parse(await readFile(outPath, "utf8")));
if ("error" in parsed) {
  check("V6 round-trip", false, parsed.error);
} else {
  const n = Object.keys(parsed.project.nodes).length;
  check(
    "V6 round-trip",
    n === Object.keys(project.nodes).length && parsed.issues.filter((i) => i.severity === "error").length === 0,
    `${n} nodes re-read; issues: ${parsed.issues.map((i) => i.message).join(" | ") || "none"}`,
  );
}

// V7: source untouched.
const afterHash = createHash("sha256").update(await readFile(DEMO)).digest("hex");
check("V7 source untouched", beforeHash === afterHash, `sha256 ${beforeHash.slice(0, 12)}… before and after`);

// V8: report counts.
check(
  "V8 report",
  report.tables.length === 14 &&
    report.graphsNotTransferred === 17 &&
    report.layoutsNotTransferred === 1 &&
    report.orphanSheetsIgnored === 7 &&
    report.unreferencedTablesIgnored === 8 &&
    report.analysesUnsupported.length === 0,
  `tables=${report.tables.length} graphs=${report.graphsNotTransferred} layouts=${report.layoutsNotTransferred} orphans=${report.orphanSheetsIgnored} unreferenced=${report.unreferencedTablesIgnored} unsupported=${report.analysesUnsupported.length}`,
);

console.log(`\n${checks - failures}/${checks} checks passed.`);
process.exit(failures ? 1 : 0);
