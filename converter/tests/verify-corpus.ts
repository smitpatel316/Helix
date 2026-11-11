// Multi-file verification for prism2hlx, over the .prism corpus.
//
//   npm run verify-corpus
//
// Runs every `.prism` in the corpus directory (PRISM_TEST_CORPUS_PRISM10,
// else ~/workspace/helix/test-corpus-prism10) through the converter and,
// per file, checks:
//   C0  the real CLI converts a good file (exit 0, .hlx written) and
//       refuses a bad one (exit 1), and a write failure is a
//       plain-language error, not a stack — once per run, not per file
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
//       that the file's own comma rule says should have been converted
//       — both would mean the CSV layer leaked raw text into the .hlx
//       (the C3/C4 rebuild shares the converter's parser, so it can't
//       catch those on its own)
//   C9  alignment: every converted table's layout accounts for each
//       dataset's columns exactly once, and the columns the layout
//       consumes never exceed the file's declared numberOfColumns
//       (a shortfall is either warned about as extra columns, or the
//       table is left out)
//
// The expectation builder lives in tests/layout-spec.ts: the field-by-
// field mapping from the vault spec, written separately from the
// converter, straight from the raw files. Public files only — Mansi's
// files are never test material.

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
import {
  detectThousandsMode,
  expectedRows,
  plainTitle,
  resolveLayout,
  type LayoutInput,
  type LayoutResult,
  type SetJson,
} from "./layout-spec";

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
  // Real-world .prism files that are NOT GraphPad at all: the PRISM
  // probabilistic model checker uses the same extension. The converter
  // refuses them cleanly (not a ZIP archive) — that rejection is the
  // correct behaviour, regression-checked here.
  "cloud-verification-mdp-zenodo-17746477.prism": "isn't a ZIP archive",
  "energy-system-zenodo-23184357.prism": "isn't a ZIP archive",
};

/** Prism nonlinear equation → Helix model the converter maps it to.
 *  Must mirror converter/src/prism.ts NONLINEAR_MODELS; if the two
 *  disagree, C5 fails — that is the check working. */
const NONLINEAR_MODEL_BY_EQUATION: Record<string, string> = {
  "Sigmoidal, 4PL, X is concentration": "sigmoidal-4pl-x",
  "Sigmoidal, 4PL, X is log(concentration)": "sigmoidal-4pl-logx",
  "log(agonist) vs. response -- Variable slope (four parameters)": "sigmoidal-4pl-logx",
  "log(inhibitor) vs. response -- Variable slope (four parameters)": "sigmoidal-4pl-logx",
  "One phase decay": "one-phase-decay",
  Line: "line",
  "Second order polynomial (quadratic)": "quadratic",
};

let failures = 0;
let checks = 0;
function check(file: string, name: string, ok: boolean, detail: string) {
  checks++;
  console.log(`${ok ? "PASS" : "FAIL"} ${file} ${name} — ${detail}`);
  if (!ok) failures++;
}

// ── Per-sheet raw pieces + the independently resolved layout ──────────

interface SheetInfo {
  uid: string;
  title: string;
  format: string;
  dataFormat: string;
  replicatesCount?: number;
  tableUid: string;
  content: { numberOfColumns: number; numberOfRows: number };
  /** False when content.json is absent (dims fall back to the CSV). */
  hasContentJson: boolean;
  csv: string[][];
  /** One entry per dataSets UID, in file order; null = JSON missing. */
  setJsons: (SetJson | null)[];
  xJson: SetJson | null;
  xPresent: boolean;
  hasTitleCol: boolean;
  thousandsMode: boolean;
  /** The layout input, kept so C3/C4 can rebuild rows from it. */
  layoutInput: LayoutInput;
  /** The layout, resolved from content.json dims + the raw JSONs — never
   *  from the converter's walk. */
  layout: LayoutResult;
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

  // File-level comma rule, from the file's own values (same rule as the
  // converter, read independently here): any parsed cell with 2+ comma
  // groups makes commas thousands separators file-wide.
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
    const csvText = await text(`data/tables/${table.uid}/data.csv`);
    if (csvText === null) continue;
    let csv = parseCsv(csvText);
    // content.json may be absent (the converter then uses the CSV's own
    // shape); when present, its dims rule the layout and the padding.
    const contentRaw = await json<{ numberOfColumns?: number; numberOfRows?: number }>(
      `data/tables/${table.uid}/content.json`,
    ).catch(() => null);
    const content = {
      numberOfColumns: contentRaw?.numberOfColumns ?? csv[0]?.length ?? 0,
      numberOfRows: contentRaw?.numberOfRows ?? csv.length,
    };
    const hasContentJson = contentRaw !== null;
    if (csv.length > content.numberOfRows) csv = csv.slice(0, content.numberOfRows);
    while (csv.length < content.numberOfRows) csv.push([]);
    // Missing dataset JSONs stay null here — the layout resolves their
    // skip count from the table/dims instead of dropping them silently.
    const setJsons = await Promise.all(
      (table.dataSets ?? []).map((u) => json<SetJson>(`data/sets/${u}.json`).catch(() => null)),
    );
    const xJson = table.xDataSet
      ? await json<SetJson>(`data/sets/${table.xDataSet}.json`).catch(() => null)
      : null;
    const layoutInput = {
      format: table.format ?? "",
      dataFormat: table.dataFormat ?? "",
      replicatesCount: table.replicatesCount,
      hasTitleCol: table.rowTitlesDataSet != null,
      declaredCols: content.numberOfColumns,
      declaredRows: content.numberOfRows,
      xPresent: table.xDataSet !== undefined,
      xJson,
      sets: setJsons,
      thousandsMode,
    };
    sheets.push({
      uid: sheetUid,
      title: plainTitle(sheet.title) || plainTitle(titles[sheetUid]?.title) || "Imported table",
      format: table.format ?? "",
      dataFormat: table.dataFormat ?? "",
      replicatesCount: table.replicatesCount,
      tableUid: table.uid,
      content,
      hasContentJson,
      csv,
      setJsons,
      xJson,
      xPresent: table.xDataSet !== undefined,
      hasTitleCol: table.rowTitlesDataSet != null,
      thousandsMode,
      layoutInput,
      layout: resolveLayout(layoutInput),
    });
  }

  // C2: converted tables are the sheets the layout says convert, in
  // document order; anything the layout refuses must be left out and
  // named in a warning — never silently dropped, never converted
  // against the layout.
  const expectedOrder = sheets.filter((s) => s.layout.convert).map((s) => s.title);
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
  // A sheet the layout says convert but the converter left out (empty
  // CSV, no data) counts as left out too — it still needs its warning.
  const notConverted = expectedOrder.filter((n) => !converted.includes(n));
  const leftOut = [...new Set([...sheets.filter((s) => !s.layout.convert).map((s) => s.title), ...notConverted])];
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

  // C3 + C4: dims + cells for every converted table. The expectations
  // come from the layout (content.json dims + raw JSONs), never from the
  // converter's walk — so a shifted column fails here as wrong values.
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
        node.data.columns.join("|") === ["Title", ...s.layout.columns].join("|"),
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
    const expectedCols = 1 + sheet.layout.columns.length;
    if (data.columns.length !== expectedCols || data.rows.length !== sheet.content.numberOfRows) {
      bad.push(
        `${node.name}: dims ${data.columns.length}x${data.rows.length} vs expected ${expectedCols}x${sheet.content.numberOfRows}`,
      );
    }
    if (sheet.format === "grouped") {
      // replicatesCount is absent from some files (seen: marelli, opossum,
      // endosymbioses, figure-6) — then it is the per-dataset subcolumn
      // count, the same fallback the converter uses. Groups count the
      // datasets whose JSON is present; a missing one consumes CSV
      // columns without becoming a group.
      const presentCounts = sheet.setJsons
        .map((s, i) => (s === null ? null : sheet.layout.counts[i]))
        .filter((c): c is number => c !== null);
      const expectedReplicates = sheet.replicatesCount ?? Math.max(...presentCounts);
      if (data.groups !== sheet.layout.presentSets.length || data.replicates !== expectedReplicates) {
        bad.push(`${node.name}: groups=${data.groups} replicates=${data.replicates} vs ${sheet.layout.presentSets.length}/${expectedReplicates}`);
      }
    }
    // Compare the overlapping cells even when the dims are off, so a
    // shifted column is caught as wrong values, not just wrong dims.
    const expRows = expectedRows(sheet.layoutInput, sheet.layout, sheet.csv);
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

  // C8: values are clean — no stray \r, and no comma the file's own
  // comma rule says should have been converted. The C3/C4 rebuild shares
  // the converter's CSV parser, so it would agree with a parser leak;
  // this check is independent of it. The \r check is unconditional; the
  // comma check is mode-aware — in decimal mode a "45,5" left in the
  // .hlx is a leak, in thousands mode it is expected text (only a
  // grouped "1,234,567" left behind is a leak there).
  const fileThousandsMode = sheets[0]?.thousandsMode ?? false;
  const commaLeak = fileThousandsMode
    ? /^-?\d{1,3}(,\d{3})+(\.\d+)?$/
    : /^-?\d+,\d+$/;
  const dirty: string[] = [];
  for (const node of convertedNodes) {
    if (!node.data) continue;
    for (let r = 0; r < node.data.rows.length; r++) {
      for (let c = 0; c < node.data.rows[r].length; c++) {
        const v = node.data.rows[r][c];
        if (typeof v === "string" && (v.includes("\r") || v.includes("\n") || commaLeak.test(v))) {
          dirty.push(`${node.name} r${r} c${c}: ${JSON.stringify(v)}`);
        }
      }
    }
  }
  check(
    fileName,
    "C8 values clean",
    dirty.length === 0,
    dirty.length ? dirty.slice(0, 3).join(" | ") : "no stray CR/LF or unconverted commas",
  );

  // C9: alignment — every converted table's layout accounts for each
  // dataset's columns exactly once, and the columns the layout consumes
  // never exceed the file's declared numberOfColumns. A shortfall is
  // either warned about as extra columns left out, or the table is
  // refused (C2 covers the refusal). This is the check that would have
  // caught B1/B2/B3: a converter that lays out on a shifted cursor
  // consumes a different column count than the layout says.
  const alignProblems: string[] = [];
  for (const sheet of sheets) {
    const layout = sheet.layout;
    if (!layout.convert) continue;
    if (layout.consumedCols > sheet.content.numberOfColumns) {
      alignProblems.push(
        `${sheet.title}: layout consumes ${layout.consumedCols} columns but the file declares ${sheet.content.numberOfColumns}`,
      );
      continue;
    }
    if (layout.consumedCols < sheet.content.numberOfColumns) {
      // Only when content.json exists: without it the converter has no
      // declared width to compare against, so no warning is expected.
      if (!sheet.hasContentJson) continue;
      const warned = report.issues.some((i) =>
        i.message.includes(`holds ${sheet.content.numberOfColumns} columns but only ${layout.consumedCols} map`),
      );
      if (!warned) {
        alignProblems.push(
          `${sheet.title}: ${sheet.content.numberOfColumns - layout.consumedCols} column(s) unaccounted for with no warning`,
        );
      }
    }
  }
  check(
    fileName,
    "C9 alignment",
    alignProblems.length === 0,
    alignProblems.length ? alignProblems.slice(0, 3).join(" | ") : "every dataset's columns accounted for exactly once",
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
      const equation = (params?.content?.model?.equation?.name ?? "").trim();
      const model = NONLINEAR_MODEL_BY_EQUATION[equation];
      if (model !== undefined) {
        // A mapped equation converts onto its input table — one node per
        // input dataset, carrying the mapped Helix model.
        if (!inputConverted) {
          if (!report.issues.some((i) => i.message.includes(`“${name}”`))) {
            analysisProblems.push(`${name}: ${equation} but input table missing and no warning`);
          }
        } else if ((sheet.inputDataSets ?? []).length === 0) {
          // A supported equation with no input datasets is warned about
          // and left out — it converts to no node at all (M4).
          const warned = report.issues.some(
            (i) => i.message.includes(`“${name}”`) && i.message.includes("has no input datasets"),
          );
          if (!warned) analysisProblems.push(`${name}: zero input datasets but no warning`);
          if (report.analyses.some((a) => a === name || a.startsWith(`${name} (`))) {
            analysisProblems.push(`${name}: zero input datasets but a node was converted`);
          }
        } else {
          const want = (sheet.inputDataSets ?? []).map((ds) =>
            plainTitle(ds.title) ? `${name} (${plainTitle(ds.title)})` : name,
          );
          const wantNames = want.length ? want : [name];
          for (const w of wantNames) {
            if (!report.analyses.includes(w)) analysisProblems.push(`${name}: expected converted node “${w}”`);
          }
          // The converted nodes must carry the right Helix model, not
          // just the right name — a wrong-model mapping would otherwise
          // pass C5 while fitting the wrong curve in Helix.
          const nodes = Object.values(project.nodes).filter(
            (n) => n.type === "analysis" && wantNames.includes(n.name),
          );
          for (const n of nodes) {
            const got = (n.analysisParams as { model?: unknown } | undefined)?.model;
            if (got !== model) {
              analysisProblems.push(`${name}: node “${n.name}” has model ${String(got)}, want ${model}`);
            }
          }
        }
      } else if (inputConverted) {
        if (!report.analysesUnsupported.some((u) => u.includes(name))) {
          analysisProblems.push(`${name}: model “${equation}” not named as unsupported`);
        }
      } else if (!report.issues.some((i) => i.message.includes(`“${name}”`))) {
        // Unmapped equation whose input table is missing: the converter
        // warns about the missing input instead of naming the model —
        // same as the mapped case, and the established behaviour for a
        // left-out analysis (see the synthetic empty-table file).
        analysisProblems.push(
          `${name}: model “${equation}” with missing input table, neither named unsupported nor warned about`,
        );
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
  // The CLI runs with CWD = the converter dir: its own node_modules
  // holds tsx, so the probe must not depend on the repo-root install.
  try {
    execFileSync(
      process.execPath,
      ["--import", "tsx", join(CONVERTER_DIR, "src/cli.ts"), good, goodOut],
      { cwd: CONVERTER_DIR, stdio: "pipe" },
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
      { cwd: CONVERTER_DIR, stdio: "pipe" },
    );
    check("cli", "C0 reject", false, "empty.prism converted but should have failed");
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer };
    check("cli", "C0 reject", e.status === 1, `exit ${e.status ?? "?"} on empty.prism`);
  }
  // A write failure (output folder doesn't exist) is a plain-language
  // error on stderr, exit 1 — never a raw stack trace.
  try {
    execFileSync(
      process.execPath,
      ["--import", "tsx", join(CONVERTER_DIR, "src/cli.ts"), good, join(dir, "no-such-dir", "out.hlx")],
      { cwd: CONVERTER_DIR, stdio: "pipe" },
    );
    check("cli", "C0 write failure", false, "write to a missing folder succeeded but should have failed");
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer };
    const stderr = e.stderr?.toString() ?? "";
    const plain = e.status === 1 && stderr.includes("Can't write") && !stderr.includes("    at ") && !stderr.includes("Error:");
    check("cli", "C0 write failure", plain, plain ? "exit 1, plain-language error" : `exit ${e.status ?? "?"}, stderr: ${stderr.slice(0, 200)}`);
  }
}

await checkCli();
const files = (await readdir(CORPUS)).filter((f) => f.endsWith(".prism")).sort();
console.log(`Corpus: ${CORPUS} — ${files.length} files`);
for (const f of files) await verifyFile(f);
console.log(`\n${checks - failures}/${checks} checks passed.`);
process.exit(failures ? 1 : 0);
