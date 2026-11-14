// `.prism` import tests — plan prism-format-work, regression tests C-01, C-02,
// C-08, C-10, C-11 (plus the post-rebase survival-type regression).
//
//   C-01  demo file: 14 tables, 2 analyses (4PL → 2 nodes, survival → 1 node),
//         report lists 17 graphs + 1 layout not transferred
//   C-02  cell-by-cell diff of every imported table vs its source `data.csv`
//         (expectations from tests/prism-layout-spec.ts — an independent
//         implementation of the vault spec, never the converter's own walk)
//   C-08  checksum: the source file is byte-identical before and after
//   C-10  transfer-report honesty: exact counts, "not transferred" for
//         graphs/layouts, no "100% compatible" claim anywhere
//   C-11  corrupt `.prism` (truncated zip; document.json deleted; non-ZIP):
//         plain-language error, no crash, no partial project
//
// Corpus: the demo file lives in tests/testdata/prism/ (a copy of the public
// prism2R demo; the original stays in ~/workspace/helix/test-corpus/ — Mansi's
// files are never test material). A wider sweep runs when
// PRISM_TEST_CORPUS_PRISM10 points at a directory of public `.prism` files
// (the 66-file corpus on branch feat/prism-converter-cli): every file must
// convert and round-trip through Helix's own parser with zero error issues,
// except the two known rejects (empty.prism, cloud-verification-mdp).
// `npm test` runs the demo checks; the sweep runs only when the dir exists.
//
// Ported from the standalone converter CLI's verify.ts (branch
// feat/prism-converter-cli), adapted to the app: the survival analysis node
// is `analysisType: "survival"` with `{ curveTest: "logrank", correction:
// "holm" }` (the Nov 10 rebase dropped the CLI's "survival-log-rank" key),
// and Prism survival tables import as Helix tableType `"survival"`.
/// <reference types="node" />
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { parseProjectFile, serializeProjectFile } from "../src/lib/project-file";
import { convertPrism, formatReport, type ConvertResult } from "../src/lib/prism";
import { parseCsv } from "../src/lib/prism-csv";
import { detectThousandsMode, expectedRows, resolveLayout, type SetJson } from "./prism-layout-spec";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEMO = join(HERE, "testdata", "prism", "prism2R-demo_dataset.prism");

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail: string) {
  checks++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) failures++;
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

let result: ConvertResult;
try {
  result = await convertPrism(new Uint8Array(input), "prism2R-demo_dataset.prism");
  check(
    "P1 convert",
    true,
    `no error; ${result.report.tables.length} tables, ${result.report.analyses.length} analysis nodes`,
  );
} catch (err) {
  check("P1 convert", false, err instanceof Error ? err.message : String(err));
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

// P2 (C-01): 14 tables, document order, exact titles.
const expectedTitles = doc.sheets.data.map((uid) => doc.sheetAttributesMap[uid]?.title ?? "");
check(
  "P2 tables",
  tables.length === 14 && tables.map((t) => t.name).join("|") === expectedTitles.join("|"),
  `${tables.length} tables; order ${tables.map((t) => t.name).join(" / ")}`,
);

// P3 + P4 (C-02): dims + cell-by-cell vs source CSVs. Expectations come from
// tests/prism-layout-spec.ts (the independent builder), per sheet.
let v4cells = 0;
let v4bad: string[] = [];
let thousandsMode = false;
for (const path of Object.keys(zip.files)) {
  if (!/^data\/tables\/[^/]+\/data\.csv$/.test(path)) continue;
  const csvFile = zip.file(path);
  if (!csvFile) continue;
  if (detectThousandsMode(parseCsv(await csvFile.async("string")))) {
    thousandsMode = true;
    break;
  }
}
for (const sheetUid of doc.sheets.data) {
  const sheet = await json<{
    title?: string;
    table: {
      uid: string;
      format: string;
      dataFormat: string;
      replicatesCount?: number;
      dataSets: string[];
      xDataSet?: string;
      rowTitlesDataSet?: string;
    };
  }>(`data/sheets/${sheetUid}/sheet.json`);
  const csvText = (await text(`data/tables/${sheet.table.uid}/data.csv`)) as string;
  let csv = parseCsv(csvText);
  const contentRaw = await json<{ numberOfColumns?: number; numberOfRows?: number }>(
    `data/tables/${sheet.table.uid}/content.json`,
  ).catch(() => null);
  const content = {
    numberOfColumns: contentRaw?.numberOfColumns ?? csv[0]?.length ?? 0,
    numberOfRows: contentRaw?.numberOfRows ?? csv.length,
  };
  if (csv.length > content.numberOfRows) csv = csv.slice(0, content.numberOfRows);
  while (csv.length < content.numberOfRows) csv.push([]);
  const setJsons = await Promise.all(
    sheet.table.dataSets.map((u) => json<SetJson>(`data/sets/${u}.json`).catch(() => null)),
  );
  const xJson = sheet.table.xDataSet
    ? await json<SetJson>(`data/sets/${sheet.table.xDataSet}.json`).catch(() => null)
    : null;
  const layoutInput = {
    format: sheet.table.format,
    dataFormat: sheet.table.dataFormat,
    replicatesCount: sheet.table.replicatesCount,
    hasTitleCol: sheet.table.rowTitlesDataSet != null,
    declaredCols: content.numberOfColumns,
    declaredRows: content.numberOfRows,
    xPresent: sheet.table.xDataSet !== undefined,
    xJson,
    sets: setJsons,
    thousandsMode,
  };
  const layout = resolveLayout(layoutInput);
  const expCols = ["Title", ...layout.columns];
  const node = tables.find((t) => t.name === sheet.title && t.data!.columns.join("|") === expCols.join("|"));
  if (!node) {
    v4bad.push(`${sheet.title}: no table with expected columns [${expCols.join(", ")}]`);
    continue;
  }
  const data = node.data!;
  const expectedHlxCols = 1 + layout.columns.length;
  check(
    `P3 dims ${sheet.title}`,
    data.columns.length === expectedHlxCols && data.rows.length === content.numberOfRows,
    `${data.columns.length}x${data.rows.length} vs layout ${expectedHlxCols}x${content.numberOfRows}`,
  );
  const expRows = expectedRows(layoutInput, layout, csv);
  for (let r = 0; r < data.rows.length; r++) {
    const expected = expRows[r];
    for (let c = 0; c < expected.length; c++) {
      v4cells++;
      if (data.rows[r][c] !== expected[c]) {
        v4bad.push(
          `${sheet.title} r${r} c${c} (${data.columns[c]}): got ${JSON.stringify(data.rows[r][c])}, want ${JSON.stringify(expected[c])}`,
        );
      }
    }
  }
  if (sheet.table.format === "grouped") {
    const presentCounts = setJsons
      .map((s, i) => (s === null ? null : layout.counts[i]))
      .filter((c): c is number => c !== null);
    const expectedReplicates = sheet.table.replicatesCount ?? Math.max(...presentCounts);
    const ok = data.groups === layout.presentSets.length && data.replicates === expectedReplicates;
    check(`P3 grouped ${sheet.title}`, ok === true, `groups=${data.groups} replicates=${data.replicates}`);
  }
}
check(
  "P4 cells",
  v4bad.length === 0,
  `${v4cells} cells compared; ${v4bad.length} mismatches${v4bad.length ? ": " + v4bad.slice(0, 3).join(" | ") : ""}`,
);

// P5 (C-01): analysis nodes — 2 nonlinear-regression (4PL, one per dataset)
// + 1 survival. The survival node must carry the CURRENT registry key
// "survival" (not the pre-rebase "survival-log-rank", which parseProjectFile
// flags as an unknown test) with log-rank params, and its parent table must
// be a Helix "survival" table.
const analyses = Object.values(project.nodes).filter((n) => n.type === "analysis");
const nonlin = analyses.filter((a) => a.analysisType === "nonlinear-regression");
const survival = analyses.filter((a) => a.analysisType === "survival");
const staleSurvival = analyses.filter((a) => (a.analysisType as string) === "survival-log-rank");
const nonlinOk =
  nonlin.length === 2 &&
  nonlin.every((a) => (a.analysisParams as { model?: string })?.model === "sigmoidal-4pl-x") &&
  new Set(nonlin.map((a) => (a.analysisParams as { y?: string })?.y)).size === 2 &&
  nonlin.every((a) => project.nodes[a.parentId ?? ""]?.name === "XY: Entering replicate data");
const survParams = survival[0]?.analysisParams as { curveTest?: string; correction?: string } | undefined;
const survOk =
  survival.length === 1 &&
  staleSurvival.length === 0 &&
  project.nodes[survival[0].parentId ?? ""]?.name === "Survival: Two groups" &&
  project.nodes[survival[0].parentId ?? ""]?.tableType === "survival" &&
  survParams?.curveTest === "logrank" &&
  survParams?.correction === "holm";
check(
  "P5 analyses",
  analyses.length === 3 && nonlinOk && survOk,
  `${analyses.length} nodes: ${analyses.map((a) => `${a.name} (${a.analysisType})`).join("; ")}`,
);

// P6: round-trip through Helix's own parser — with ZERO error issues. This is
// the regression test that would have caught the stale "survival-log-rank"
// key: parseProjectFile flags an unknown analysis type as an error.
const dir = await mkdtemp(join(tmpdir(), "prism-import-"));
const outPath = join(dir, "demo.hlx");
await writeFile(outPath, serializeProjectFile(project));
const parsed = parseProjectFile(JSON.parse(await readFile(outPath, "utf8")));
if ("error" in parsed) {
  check("P6 round-trip", false, parsed.error);
} else {
  const n = Object.keys(parsed.project.nodes).length;
  const errors = parsed.issues.filter((i) => i.severity === "error");
  check(
    "P6 round-trip",
    n === Object.keys(project.nodes).length && errors.length === 0,
    `${n} nodes re-read; issues: ${parsed.issues.map((i) => i.message).join(" | ") || "none"}`,
  );
}

// P7 (C-08): source untouched.
const afterHash = createHash("sha256")
  .update(await readFile(DEMO))
  .digest("hex");
check("P7 source untouched", beforeHash === afterHash, `sha256 ${beforeHash.slice(0, 12)}… before and after`);

// P8 (C-01 + C-10): report counts and honest wording.
const reportText = formatReport(report);
check(
  "P8 report",
  report.tables.length === 14 &&
    report.graphsNotTransferred === 17 &&
    report.layoutsNotTransferred === 1 &&
    report.orphanSheetsIgnored === 7 &&
    report.unreferencedTablesIgnored === 8 &&
    report.analysesUnsupported.length === 0 &&
    reportText.includes("not transferred") &&
    !reportText.includes("100% compatible"),
  `tables=${report.tables.length} graphs=${report.graphsNotTransferred} layouts=${report.layoutsNotTransferred} orphans=${report.orphanSheetsIgnored} unreferenced=${report.unreferencedTablesIgnored} unsupported=${report.analysesUnsupported.length}`,
);

// P9 (C-11): corrupt files fail with a plain-language error, never a crash.
async function expectRefusal(name: string, bytes: Uint8Array, want: string) {
  try {
    await convertPrism(bytes, name);
    check(`P9 corrupt ${name}`, false, "converted without error");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    check(
      `P9 corrupt ${name}`,
      message.length > 0 && message.includes(want) && !message.includes("\n    at ") && !message.includes("node:"),
      message.slice(0, 120),
    );
  }
}
await expectRefusal(
  "truncated.prism",
  new Uint8Array(input.slice(0, Math.floor(input.length / 2))),
  "isn't a Prism 10",
);
await expectRefusal("not-a-prism.prism", new TextEncoder().encode("this is not a zip file at all"), "isn't a Prism 10");
{
  const empty = new JSZip();
  await expectRefusal(
    "no-document.prism",
    new Uint8Array(await empty.generateAsync({ type: "uint8array" })),
    "document.json is missing",
  );
}

// P14: corpus sweep (only when PRISM_TEST_CORPUS_PRISM10 is set and exists).
const corpusDir = process.env.PRISM_TEST_CORPUS_PRISM10;
if (corpusDir) {
  const files = (await readdir(corpusDir)).filter((f) => f.endsWith(".prism")).sort();
  // Files that must fail conversion (mirrors the converter CLI's
  // EXPECTED_REJECTS in verify-corpus.ts — same extension, not GraphPad at
  // all, or no data tables Helix can use).
  const knownRejects = new Set([
    "empty.prism",
    "synthetic-graphs-only.prism",
    "cloud-verification-mdp-zenodo-17746477.prism",
    "energy-system-zenodo-23184357.prism",
  ]);
  if (files.length === 0) {
    console.log("P14 corpus sweep — no .prism files found, skipped");
  } else {
    let swept = 0;
    let sweptBad: string[] = [];
    for (const file of files) {
      const bytes = await readFile(join(corpusDir, file));
      try {
        const converted = await convertPrism(new Uint8Array(bytes), file);
        const reparsed = parseProjectFile(JSON.parse(serializeProjectFile(converted.project)));
        if ("error" in reparsed) sweptBad.push(`${file}: re-parse error ${reparsed.error}`);
        else if (reparsed.issues.some((i) => i.severity === "error")) {
          sweptBad.push(
            `${file}: ${reparsed.issues
              .filter((i) => i.severity === "error")
              .map((i) => i.message)
              .join("; ")}`,
          );
        } else if (knownRejects.has(file)) sweptBad.push(`${file}: converted, expected refusal`);
        else swept++;
      } catch (err) {
        if (knownRejects.has(file)) swept++;
        else sweptBad.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    check(
      "P14 corpus sweep",
      sweptBad.length === 0,
      `${swept}/${files.length} files converted + re-parsed clean${sweptBad.length ? ": " + sweptBad.slice(0, 3).join(" | ") : ""}`,
    );
  }
} else {
  console.log("P14 corpus sweep — PRISM_TEST_CORPUS_PRISM10 not set, skipped");
}

console.log(`\n${checks - failures}/${checks} checks passed.`);
process.exit(failures ? 1 : 0);
