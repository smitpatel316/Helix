// Abstract-layer unit tests for prism2hlx (tests/unit.ts).
//
//   npm run test:unit   (runs this file and tests/unit-helpers.ts)
//
// Tests `convertPrism` through its exported surface only, on minimal
// `.prism` buffers built in memory by tests/build-prism.ts — no real
// files. The permutation space is enumerated, not sampled: every
// dimension below is crossed with the dimensions it interacts with, so a
// file Prism sends in lands on a combination this suite already pins.
//
// Dimensions (see the sections below; add a value to a dimension list to
// extend the space — no new test file needed):
//   A  table format × data format            (9 × 12 = 108 cases)
//   B  row titles × table format             (4 × 2 = 8)
//   C  title shape × title location          (6 × 4 = 24) + map titles (4)
//   D  X shape                               (10)
//   E  Y cell value shape                    (10)
//   F  subcolumn source × data format        (13 × 2 = 26)
//   G  dataset presence                      (6)
//   H  analysis class × input state          (14)
//   I  project-level rejects                 (8)
//   J  content.json shape                    (4)
//   K  orphan / unreferenced tables          (3)
//   L  CSV text shape                        (5)
//   M  review regressions (B1/B2/B3/M1/m1/M5/m6) (12)
//
// Every successful conversion is also round-tripped through Helix's own
// parseProjectFile, so a case that converts but produces a .hlx Helix
// itself rejects still fails here. The four regression tests from the
// 2026-11-10 corpus bugs (commit 13c75c2) are named REGRESSION R1–R4;
// they were run against the pre-fix converter and fail there (see the
// README's "Regression verification" note). Section M holds the
// regression tests from the 2026-11-10 read-only review sweep (B1/B2/B3
// blockers, M1/M3/M4/M5, m1/m6) — same rule: each was run against the
// pre-fix converter and fails there (the M1 DST cases only under a
// non-UTC timezone; run the suite with TZ=America/Los_Angeles).
//
// Real-file coverage lives in tests/verify.ts (demo) and
// tests/verify-corpus.ts (11 public + 6 synthetic files).

import JSZip from "jszip";
import { parseProjectFile, serializeProjectFile } from "../../src/lib/project-file";
import type { ProjectNode } from "../../src/store/types";
import { convertPrism, type ConvertResult } from "../src/prism";
import {
  buildPrism,
  type AnalysisSpec,
  type DataSetSpec,
  type ProjectSpec,
  type TableSpec,
} from "./build-prism";

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail: string): void {
  checks++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) failures++;
}
function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

/** Combinatorial generator: every pair of the two dimension lists, so a
 *  new dimension value is one list entry, not a new test. Add a
 *  `product3` the same way if a third interacting dimension appears. */
function product2<A, B>(as: A[], bs: B[]): [A, B][] {
  return as.flatMap((a) => bs.map((b): [A, B] => [a, b]));
}

/** The first table node with this name, if any. */
function tableOf(result: ConvertResult, name: string): ProjectNode | undefined {
  return Object.values(result.project.nodes).find((n) => n.type === "table" && n.name === name);
}

/** Serialize the project and re-read it with Helix's own parser. */
function roundTripOk(result: ConvertResult): { ok: boolean; detail: string } {
  try {
    const parsed = parseProjectFile(
      JSON.parse(serializeProjectFile(result.project)) as unknown,
    );
    if ("error" in parsed) return { ok: false, detail: `parse error: ${parsed.error}` };
    const errs = parsed.issues.filter((i) => i.severity === "error");
    if (errs.length) return { ok: false, detail: `parser errors: ${errs.map((i) => i.message).join(" | ")}` };
    if (Object.keys(parsed.project.nodes).length !== Object.keys(result.project.nodes).length) {
      return { ok: false, detail: "node count changed on re-read" };
    }
    return { ok: true, detail: "round-trips through parseProjectFile" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function convertSpec(spec: ProjectSpec, source = "test.prism"): Promise<ConvertResult> {
  return convertPrism(await buildPrism(spec), source);
}

const FOUR_PL = {
  analysisClass: "NONLINEAR_REGRESSION",
  content: { model: { equation: { name: "Sigmoidal, 4PL, X is concentration" } } },
};

// Independent copy of the column-naming rule, from the vault spec (same
// as tests/verify-corpus.ts) — the expectations are written here, not
// read out of the converter.
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

// ── A. Table format × data format ────────────────────────────────────────
section("A. table format × data format");
{
  const formats: [string, string, string][] = [
    // [prism format, expected Helix tableType, warning substring or ""]
    ["xy", "xy", ""],
    ["column", "column", ""],
    ["grouped", "grouped", ""],
    ["contingency", "contingency", ""],
    ["survival", "xy", "imported as an XY table"],
    ["nested", "column", "import as Column"],
    ["parts-of-whole", "column", "isn't one Helix knows"],
    ["", "column", "isn't one Helix knows"],
    ["bogus", "column", "isn't one Helix knows"],
  ];
  const dataFormats = [
    "y_replicates",
    "y_single",
    "y_sd_n",
    "y_se_n",
    "y_cv_n",
    "y_sd",
    "y_se",
    "y_cv",
    "y_plus_minus",
    "y_high_low",
    "",
    "bogus",
  ];
  for (const [[format, helixType, warn], dataFormat] of product2(formats, dataFormats)) {
    const name = `matrix ${format || "(no format)"} × ${dataFormat || "(no dataFormat)"}`;
    const table: TableSpec = {
      sheetTitle: "T",
      format,
      dataFormat,
      x: { title: "X", replicates: [1] },
      sets: [{ title: "Y1", replicates: [1, 2] }],
      csv: [
        ["0", "10", "20"],
        ["1", "11", "21"],
      ],
    };
    let result: ConvertResult;
    try {
      result = await convertSpec({ tables: [table] });
    } catch (err) {
      check(name, false, `threw: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const node = tableOf(result, "T");
    const problems: string[] = [];
    if (!node?.data) problems.push("no table node");
    else {
      const wantCols =
        format === "grouped"
          ? ["Title", "X", "Y1:Y1", "Y1:Y2"]
          : ["Title", "X", ...expectedNames("Y1", dataFormat, 2)];
      if (!eq(node.data.columns, wantCols)) {
        problems.push(`columns [${node.data.columns.join(", ")}] vs [${wantCols.join(", ")}]`);
      }
      const wantRows: (string | null)[][] = [
        [null, "0", "10", "20"],
        [null, "1", "11", "21"],
      ];
      if (!eq(node.data.rows, wantRows)) problems.push(`rows ${JSON.stringify(node.data.rows)}`);
      if (node.tableType !== helixType) problems.push(`type ${node.tableType} vs ${helixType}`);
      if (format === "grouped" && (node.data.groups !== 1 || node.data.replicates !== 2)) {
        problems.push(`groups=${node.data.groups} replicates=${node.data.replicates} vs 1/2`);
      }
    }
    if (warn && !result.report.issues.some((i) => i.message.includes(warn))) {
      problems.push(`missing warning containing “${warn}”`);
    }
    const rt = roundTripOk(result);
    if (!rt.ok) problems.push(rt.detail);
    check(name, problems.length === 0, problems.length ? problems.join("; ") : `2 rows, ${node?.data?.columns.length} cols, ${rt.detail}`);
  }
}

// ── B. Row titles × table format ─────────────────────────────────────────
section("B. row titles × table format");
{
  const titleCases: [string, boolean, (string | null)[][], (string | null)[]][] = [
    ["absent", false, [["0", "10", "20"], ["1", "11", "21"]], [null, null]],
    ["present", true, [["A", "0", "10", "20"], ["B", "1", "11", "21"]], ["A", "B"]],
    // Empty titles: the Title column exists but stays null — the values
    // must still not shift.
    ["present, empty titles", true, [["", "0", "10", "20"], ["", "1", "11", "21"]], [null, null]],
    // Commas and unicode in titles: quoted CSV fields, exact values.
    ["present, unicode", true, [["Café, ☃", "0", "10", "20"], ["D, E", "1", "11", "21"]], ["Café, ☃", "D, E"]],
  ];
  for (const [format] of [["column"], ["xy"]] as [string][]) {
    for (const [label, rowTitles, csv, wantTitles] of titleCases) {
      const regression =
        (format === "column" && label === "absent") || (format === "xy" && label === "present");
      const name = `${regression ? "REGRESSION R1 " : ""}row titles ${label} on ${format}`;
      const table: TableSpec = {
        sheetTitle: "T",
        format,
        dataFormat: "y_replicates",
        x: { title: "X", replicates: [1] },
        rowTitles,
        sets: [{ title: "Y1", replicates: [1, 2] }],
        csv,
      };
      let result: ConvertResult;
      try {
        result = await convertSpec({ tables: [table] });
      } catch (err) {
        check(name, false, `threw: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const node = tableOf(result, "T");
      const problems: string[] = [];
      if (!node?.data) problems.push("no table node");
      else {
        const wantRows = wantTitles.map((t, r) => [t, String(r), String(10 + r), String(20 + r)]);
        if (!eq(node.data.rows, wantRows)) {
          problems.push(`rows ${JSON.stringify(node.data.rows)} vs ${JSON.stringify(wantRows)}`);
        }
        if (!eq(node.data.columns, ["Title", "X", "Y1_1", "Y1_2"])) {
          problems.push(`columns [${node.data.columns.join(", ")}]`);
        }
      }
      const rt = roundTripOk(result);
      if (!rt.ok) problems.push(rt.detail);
      check(name, problems.length === 0, problems.length ? problems.join("; ") : "titles + values unshifted");
    }
  }
}

// ── C. Title shape × title location ──────────────────────────────────────
section("C. title shape × title location");
{
  const shapes: [string, unknown, string][] = [
    // [label, title value, plain-text result ("": falls back)]
    ["plain", "Dose", "Dose"],
    ["rich-text", { string: "Dose", version: 1, formatting: {} }, "Dose"],
    ["rich-text, no string", { version: 1 }, ""],
    ["missing", undefined, ""],
    ["empty", "", ""],
    ["number", 42, ""],
  ];
  const baseTable = (): TableSpec => ({
    sheetTitle: "T",
    format: "column",
    dataFormat: "y_replicates",
    sets: [{ title: "Y1", replicates: [1] }],
    csv: [["10"], ["11"]],
  });
  for (const [label, value, want] of shapes) {
    // Sheet title → the table's name (fallback "Imported table").
    {
      const name = `${label === "rich-text" ? "REGRESSION R3 " : ""}sheet title ${label}`;
      const table = baseTable();
      table.sheetTitle = value;
      const result = await convertSpec({ tables: [table] });
      const node = tableOf(result, want === "" ? "Imported table" : want);
      check(name, node !== undefined, node ? `table named “${node.name}”` : `no table named “${want === "" ? "Imported table" : want}”`);
    }
    // Dataset title → the column name base (fallback "Y").
    {
      const name = `${label === "rich-text" ? "REGRESSION R3 " : ""}dataset title ${label}`;
      const table = baseTable();
      table.sets = [{ title: value, replicates: [1] }];
      const result = await convertSpec({ tables: [table] });
      const node = tableOf(result, "T");
      const got = node?.data?.columns[1];
      check(name, got === (want === "" ? "Y" : want), `column “${got}”, want “${want === "" ? "Y" : want}”`);
    }
    // X title → the X column name (fallback "X").
    {
      const name = `${label === "rich-text" ? "REGRESSION R3 " : ""}X title ${label}`;
      const table = baseTable();
      table.x = { title: value, replicates: [1] };
      table.csv = [["0", "10"], ["1", "11"]];
      const result = await convertSpec({ tables: [table] });
      const node = tableOf(result, "T");
      const got = node?.data?.columns[1];
      check(name, got === (want === "" ? "X" : want), `X column “${got}”, want “${want === "" ? "X" : want}”`);
    }
    // Analysis title → the analysis node name (fallback "Imported analysis").
    {
      const name = `${label === "rich-text" ? "REGRESSION R3 " : ""}analysis title ${label}`;
      const table = baseTable();
      const analysis: AnalysisSpec = {
        title: value,
        analysisClass: "SURVIVAL",
      };
      const result = await convertSpec({ tables: [table], analyses: [analysis] });
      const wantName = want === "" ? "Imported analysis" : want;
      const node = Object.values(result.project.nodes).find(
        (n) => n.type === "analysis" && n.name === wantName,
      );
      check(name, node !== undefined, node ? `analysis named “${node.name}”` : `no analysis named “${wantName}”`);
    }
  }
  // Sheet-attributes-map titles: the fallback when the sheet has no title.
  for (const [label, mapTitle, mapPresent, want] of [
    ["map plain", "MapTitle", true, "MapTitle"],
    ["map rich-text", { string: "MapTitle", version: 1 }, true, "MapTitle"],
    ["map missing", undefined, false, "Imported table"],
    ["sheet empty, map plain", "MapTitle", true, "MapTitle"],
  ] as [string, unknown, boolean, string][]) {
    const name = `${label === "map rich-text" ? "REGRESSION R3 " : ""}map title ${label}`;
    const table = baseTable();
    if (label.startsWith("sheet empty")) table.sheetTitle = "";
    else table.sheetTitle = undefined;
    table.mapTitle = mapTitle;
    table.mapTitlePresent = mapPresent;
    const result = await convertSpec({ tables: [table] });
    const node = tableOf(result, want);
    check(name, node !== undefined, node ? `table named “${node.name}”` : `no table named “${want}”`);
  }
}

// ── D. X shape ───────────────────────────────────────────────────────────
section("D. X shape");
{
  const survSets: DataSetSpec[] = [
    { title: "A", replicates: [1] },
    { title: "B", replicates: [1] },
  ];
  const cases: [string, TableSpec, (r: ConvertResult) => { ok: boolean; detail: string }][] = [
    [
      "no X dataset",
      {
        sheetTitle: "T", format: "column", dataFormat: "y_replicates",
        sets: [{ title: "Y1", replicates: [1, 2] }],
        csv: [["10", "20"], ["11", "21"]],
      },
      (r) => {
        const node = tableOf(r, "T");
        const ok = eq(node?.data?.columns, ["Title", "Y1_1", "Y1_2"]) && eq(node?.data?.rows, [[null, "10", "20"], [null, "11", "21"]]);
        return { ok, detail: ok ? "Y values start at CSV column 0" : JSON.stringify(node?.data) };
      },
    ],
    [
      "REGRESSION R2 X with 2 subcolumns (error bar)",
      {
        sheetTitle: "T", format: "xy", dataFormat: "y_replicates",
        x: { title: "X", replicates: [1, 2] },
        sets: [{ title: "Y1", replicates: [1, 2] }],
        csv: [["0", "0.1", "10", "20"], ["1", "0.2", "11", "21"]],
      },
      (r) => {
        const node = tableOf(r, "T");
        const ok =
          eq(node?.data?.columns, ["Title", "X", "Y1_1", "Y1_2"]) &&
          eq(node?.data?.rows, [[null, "0", "10", "20"], [null, "1", "11", "21"]]) &&
          r.report.issues.some((i) => i.message.includes("2 subcolumns; only the first was imported"));
        return { ok, detail: ok ? "first X kept, Y unshifted, warning names the dropped subcolumn" : JSON.stringify(node?.data) };
      },
    ],
    [
      "REGRESSION R2 X with 3 subcolumns",
      {
        sheetTitle: "T", format: "xy", dataFormat: "y_replicates",
        x: { title: "X", replicates: [1, 2, 3] },
        sets: [{ title: "Y1", replicates: [1] }],
        csv: [["0", "0.1", "0.2", "10"], ["1", "0.2", "0.3", "11"]],
      },
      (r) => {
        const node = tableOf(r, "T");
        const ok =
          eq(node?.data?.rows, [[null, "0", "10"], [null, "1", "11"]]) &&
          r.report.issues.some((i) => i.message.includes("3 subcolumns; only the first was imported"));
        return { ok, detail: ok ? "all 3 X subcolumns consumed, Y unshifted" : JSON.stringify(node?.data) };
      },
    ],
    [
      "REGRESSION R2 survival date X, ISO",
      {
        sheetTitle: "T", format: "survival", dataFormat: "y_replicates",
        x: { title: "Time", format: "date", replicates: [1, 2] },
        sets: survSets,
        csv: [
          ["2024-01-01 00:00:00", "2024-01-11 00:00:00", "1", "0"],
          ["2024-02-01 00:00:00", "2024-02-02 00:00:00", "0", "1"],
        ],
      },
      (r) => {
        const node = tableOf(r, "T");
        const ok =
          eq(node?.data?.columns, ["Title", "Time", "A", "B"]) &&
          eq(node?.data?.rows, [[null, "10", "1", "0"], [null, "1", "0", "1"]]) &&
          r.report.issues.some((i) => i.message.includes("converted to durations in days"));
        return { ok, detail: ok ? "start/end dates → durations 10 and 1 day" : JSON.stringify(node?.data) };
      },
    ],
    [
      "REGRESSION R2 survival date X, US format",
      {
        sheetTitle: "T", format: "survival", dataFormat: "y_replicates",
        x: { title: "Time", format: "date_se", replicates: [1, 2] },
        sets: survSets,
        csv: [["01/01/2024", "01/11/2024", "1", "0"]],
      },
      (r) => {
        const node = tableOf(r, "T");
        const ok = eq(node?.data?.rows, [[null, "10", "1", "0"]]);
        return { ok, detail: ok ? "US dates → 10 days" : JSON.stringify(node?.data) };
      },
    ],
    [
      "REGRESSION R2 survival date X, unparseable row",
      {
        sheetTitle: "T", format: "survival", dataFormat: "y_replicates",
        x: { title: "Time", format: "date", replicates: [1, 2] },
        sets: survSets,
        csv: [
          ["not-a-date", "2024-01-11 00:00:00", "1", "0"],
          ["2024-02-01 00:00:00", "2024-02-02 00:00:00", "0", "1"],
        ],
      },
      (r) => {
        const node = tableOf(r, "T");
        const ok =
          eq(node?.data?.rows, [[null, null, "1", "0"], [null, "1", "0", "1"]]) &&
          r.report.issues.some((i) => i.message.includes("1 row(s) had a date that couldn't be read"));
        return { ok, detail: ok ? "bad date → empty time, counted in the warning" : JSON.stringify(node?.data) };
      },
    ],
    [
      "survival numeric X",
      {
        sheetTitle: "T", format: "survival", dataFormat: "y_replicates",
        x: { title: "Time", format: "number", replicates: [1] },
        sets: survSets,
        csv: [["5", "1", "0"], ["6", "0", "1"]],
      },
      (r) => {
        const node = tableOf(r, "T");
        const ok =
          eq(node?.data?.rows, [[null, "5", "1", "0"], [null, "6", "0", "1"]]) &&
          !r.report.issues.some((i) => i.message.includes("converted to durations"));
        return { ok, detail: ok ? "numeric X stays numeric, no duration conversion" : JSON.stringify(node?.data) };
      },
    ],
    [
      "REGRESSION R2 X dataset JSON missing",
      {
        sheetTitle: "T", format: "xy", dataFormat: "y_replicates",
        x: { title: "X", replicates: [1], missing: true },
        sets: [{ title: "Y1", replicates: [1] }],
        csv: [["0", "10"], ["1", "11"]],
      },
      (r) => {
        const node = tableOf(r, "T");
        const ok =
          eq(node?.data?.rows, [[null, "0", "10"], [null, "1", "11"]]) &&
          r.report.issues.some((i) => i.message.includes("the X dataset") && i.message.includes("is missing"));
        return { ok, detail: ok ? "one column read as X, warned" : JSON.stringify(node?.data) };
      },
    ],
    [
      "REGRESSION R3 X title rich-text",
      {
        sheetTitle: "T", format: "xy", dataFormat: "y_replicates",
        x: { title: { string: "Dose", version: 1 }, replicates: [1] },
        sets: [{ title: "Y1", replicates: [1] }],
        csv: [["0", "10"]],
      },
      (r) => {
        const node = tableOf(r, "T");
        const ok = node?.data?.columns[1] === "Dose";
        return { ok, detail: ok ? "X column “Dose”" : `X column “${node?.data?.columns[1]}”` };
      },
    ],
  ];
  for (const [name, table, assertFn] of cases) {
    let result: ConvertResult;
    try {
      result = await convertSpec({ tables: [table] });
    } catch (err) {
      check(name, false, `threw: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const a = assertFn(result);
    const rt = roundTripOk(result);
    check(name, a.ok && rt.ok, a.ok ? (rt.ok ? a.detail : rt.detail) : a.detail);
  }
}

// ── E. Y cell value shape ────────────────────────────────────────────────
section("E. Y cell value shape");
{
  // Each value is the only cell of a one-column table; the .hlx value is
  // pinned exactly. Note "1,234": normalizeNumber rewrites anything
  // matching ^-?\d+,\d+$ as a comma decimal, so a thousands separator
  // becomes 1.234 too. That is the existing rule, pinned here — not a
  // behaviour this suite changes; a file that means 1,234 needs the
  // converter to know the file's locale, which Prism doesn't record.
  const values: [string, string | null, string | null][] = [
    ["plain number", "10", "10"],
    ["empty cell", "", null],
    ["text", "n/a", "n/a"],
    ["scientific notation", "1.2e-3", "1.2e-3"],
    ["comma decimal", "45,5", "45.5"],
    ["comma thousands (same rule)", "1,234", "1.234"],
    ["unicode", "Café ☃", "Café ☃"],
    ["negative", "-3.5", "-3.5"],
    ["zero", "0", "0"],
    ["large exponent", "1e6", "1e6"],
  ];
  for (const [label, cell, want] of values) {
    const table: TableSpec = {
      sheetTitle: "T",
      format: "column",
      dataFormat: "y_replicates",
      sets: [{ title: "Y", replicates: [1] }],
      csv: [[cell]],
    };
    const result = await convertSpec({ tables: [table] });
    const node = tableOf(result, "T");
    const got = node?.data?.rows[0]?.[1];
    check(`Y cell ${label}`, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

// ── F. Subcolumn source × data format ────────────────────────────────────
section("F. subcolumn source × data format");
{
  const sources: [string, DataSetSpec, number | undefined, number][] = [
    // [label, dataset spec, table replicatesCount, expected subcolumns]
    ["replicates 0", { replicates: [] }, undefined, 0],
    ["replicates 1", { replicates: [1] }, undefined, 1],
    ["replicates 2", { replicates: [1, 2] }, undefined, 2],
    ["replicates 3", { replicates: [1, 2, 3] }, undefined, 3],
    ["replicates 5", { replicates: [1, 2, 3, 4, 5] }, undefined, 5],
    ["ranges 0~2", { replicateRanges: ["0~2"] }, undefined, 3],
    ["ranges 0", { replicateRanges: ["0"] }, undefined, 1],
    ["ranges 1~3", { replicateRanges: ["1~3"] }, undefined, 3],
    ["ranges 0~0 + 2", { replicateRanges: ["0~0", "2"] }, undefined, 2],
    ["ranges empty", { replicateRanges: [] }, undefined, 0],
    ["table fallback 0", {}, 0, 0],
    ["table fallback 3", {}, 3, 3],
    ["no source at all", {}, undefined, 0],
  ];
  for (const [dataFormat, [label, set, tableReps, count]] of product2(
    ["y_replicates", "y_sd_n"],
    sources,
  )) {
    {
      const name = `subcolumns ${label} × ${dataFormat}`;
      const table: TableSpec = {
        sheetTitle: "T",
        format: "column",
        dataFormat,
        replicatesCount: tableReps,
        x: { title: "X", replicates: [1] },
        sets: [{ title: "Y1", ...set }],
        csv: [
          ["0", "10", "20", "30", "40", "50"],
          ["1", "11", "21", "31", "41", "51"],
        ],
      };
      if (count === 0) {
        // No subcolumns from the dataset — but the X column alone still
        // makes a table, so it converts with X only (and a warning that
        // the file holds more columns than map). The refusal only happens
        // when there are no columns at all (see section G).
        let result: ConvertResult;
        try {
          result = await convertSpec({ tables: [table] });
        } catch (err) {
          check(name, false, `threw: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        const node = tableOf(result, "T");
        const ok =
          eq(node?.data?.columns, ["Title", "X"]) &&
          eq(node?.data?.rows, [[null, "0"], [null, "1"]]);
        const rt = roundTripOk(result);
        check(name, ok && rt.ok, ok ? `X-only table, ${rt.detail}` : JSON.stringify(node?.data));
        continue;
      }
      let result: ConvertResult;
      try {
        result = await convertSpec({ tables: [table] });
      } catch (err) {
        check(name, false, `threw: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const node = tableOf(result, "T");
      const wantCols = ["Title", "X", ...expectedNames("Y1", dataFormat, count)];
      const ok = eq(node?.data?.columns, wantCols);
      const rt = roundTripOk(result);
      check(name, ok && rt.ok, ok ? `${count} subcolumns, ${rt.detail}` : `columns [${node?.data?.columns.join(", ")}] vs [${wantCols.join(", ")}]`);
    }
  }
}

// ── G. Dataset presence ──────────────────────────────────────────────────
section("G. dataset presence");
{
  const goodTable = (): TableSpec => ({
    sheetTitle: "T",
    format: "column",
    dataFormat: "y_replicates",
    x: { title: "X", replicates: [1] },
    sets: [
      { title: "A", replicates: [1, 2] },
      { title: "B", replicates: [1, 2] },
    ],
    csv: [
      ["0", "10", "20", "30", "40"],
      ["1", "11", "21", "31", "41"],
    ],
  });
  // One dataset JSON missing: warn, convert without its columns.
  {
    const table = goodTable();
    table.sets[1].missing = true;
    const result = await convertSpec({ tables: [table] });
    const node = tableOf(result, "T");
    const ok =
      eq(node?.data?.columns, ["Title", "X", "A_1", "A_2"]) &&
      eq(node?.data?.rows, [[null, "0", "10", "20"], [null, "1", "11", "21"]]) &&
      result.report.issues.some((i) =>
        i.message.includes("is missing; its 2 column(s) were skipped (inferred from the file's 5 declared columns)"),
      );
    check("dataset one JSON missing", ok, ok ? "A converts, B warned about" : JSON.stringify(node?.data));
  }
  // All dataset JSONs missing: the table is left out; the project refuses.
  {
    const table = goodTable();
    table.sets[0].missing = true;
    table.sets[1].missing = true;
    try {
      await convertSpec({ tables: [table] });
      check("dataset all JSONs missing", false, "converted but should have been refused");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      check("dataset all JSONs missing", msg.includes("has no data tables Helix can use"), `refused: ${msg}`);
    }
  }
  // No datasets listed at all: same refusal.
  {
    const table = goodTable();
    table.sets = [];
    try {
      await convertSpec({ tables: [table] });
      check("dataset none listed", false, "converted but should have been refused");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      check("dataset none listed", msg.includes("has no data tables Helix can use"), `refused: ${msg}`);
    }
  }
  // A dataset with zero subcolumns contributes no columns; with a second
  // dataset present the table still converts, without it.
  {
    const table = goodTable();
    table.sets = [
      { title: "A", replicates: [] },
      { title: "B", replicates: [1, 2] },
    ];
    const result = await convertSpec({ tables: [table] });
    const node = tableOf(result, "T");
    // The CSV cursor still walks A first (0 columns), so B reads columns
    // 1–2 — the values that sit after X.
    const ok = eq(node?.data?.columns, ["Title", "X", "B_1", "B_2"]);
    check("dataset zero subcolumns", ok, ok ? "A contributes nothing, B converts" : JSON.stringify(node?.data));
  }
  // A dataset with zero subcolumns AND no X column: the table has no
  // columns at all, so it is left out and the project is refused.
  {
    const table: TableSpec = {
      sheetTitle: "T",
      format: "column",
      dataFormat: "y_replicates",
      sets: [{ title: "A", replicates: [] }],
      csv: [["10"]],
    };
    try {
      await convertSpec({ tables: [table] });
      check("dataset zero subcolumns, no X", false, "converted but should have been refused");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      check("dataset zero subcolumns, no X", msg.includes("has no data tables Helix can use"), `refused: ${msg}`);
    }
  }
  // Empty CSV (0 rows): the table holds no data and is left out.
  {
    const table = goodTable();
    table.csv = [];
    table.rows = 0;
    try {
      await convertSpec({ tables: [table] });
      check("dataset empty CSV", false, "converted but should have been refused");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      check("dataset empty CSV", msg.includes("has no data tables Helix can use"), `refused: ${msg}`);
    }
  }
  // data.csv itself missing: warn, leave the table out.
  {
    const table = goodTable();
    table.csvMissing = true;
    try {
      await convertSpec({ tables: [table] });
      check("dataset data.csv missing", false, "converted but should have been refused");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      check("dataset data.csv missing", msg.includes("has no data tables Helix can use"), `refused: ${msg}`);
    }
  }
}

// ── H. Analysis class × input state ──────────────────────────────────────
section("H. analysis class × input state");
{
  const baseTable = (): TableSpec => ({
    sheetTitle: "Data",
    format: "xy",
    dataFormat: "y_replicates",
    x: { title: "X", replicates: [1] },
    sets: [{ title: "Control", replicates: [1, 2] }],
    csv: [
      ["0", "1", "2"],
      ["1", "3", "4"],
    ],
  });
  const fit = (title: string, extra?: Partial<AnalysisSpec>): AnalysisSpec => ({
    title,
    analysisClass: "NONLINEAR_REGRESSION",
    params: FOUR_PL,
    inputDataSets: [{ title: "Control" }],
    ...extra,
  });
  // 4PL, one input dataset → one node, on the right table.
  {
    const result = await convertSpec({ tables: [baseTable()], analyses: [fit("Fit")] });
    const nodes = Object.values(result.project.nodes).filter((n) => n.type === "analysis");
    const table = tableOf(result, "Data");
    const ok =
      nodes.length === 1 &&
      nodes[0].name === "Fit (Control)" &&
      nodes[0].analysisType === "nonlinear-regression" &&
      (nodes[0].analysisParams as { model?: string })?.model === "sigmoidal-4pl-x" &&
      nodes[0].parentId === table?.id;
    check("analysis 4PL one dataset", ok, ok ? "1 node, model sigmoidal-4pl-x, parent Data" : JSON.stringify(nodes.map((n) => n.name)));
  }
  // 4PL, two input datasets → two nodes.
  {
    const result = await convertSpec({
      tables: [baseTable()],
      analyses: [fit("Fit", { inputDataSets: [{ title: "Control" }, { title: "Treated" }] })],
    });
    const nodes = Object.values(result.project.nodes).filter((n) => n.type === "analysis");
    const ok =
      nodes.length === 2 &&
      nodes.some((n) => n.name === "Fit (Control)") &&
      nodes.some((n) => n.name === "Fit (Treated)");
    check("analysis 4PL two datasets", ok, `${nodes.length} nodes: ${nodes.map((n) => n.name).join(", ")}`);
  }
  // Unknown equation, missing params, unknown classes: named, never faked.
  // ("One phase decay" is a MAPPED equation — it converts; the unknown
  // one here is "Two phase decay".)
  for (const [label, analysis, want] of [
    [
      "4PL unknown equation",
      fit("Fit", { params: { analysisClass: "NONLINEAR_REGRESSION", content: { model: { equation: { name: "Two phase decay" } } } } }),
      "nonlinear model “Two phase decay”",
    ],
    ["4PL missing params", fit("Fit", { params: undefined }), "nonlinear model “”"],
    ["unknown class", { title: "Mystery", analysisClass: "SOMETHING_NEW" } as AnalysisSpec, "SOMETHING_NEW"],
    ["t-test class", { title: "T", analysisClass: "T_TEST" } as AnalysisSpec, "T_TEST"],
    ["missing class", { title: "NoClass" } as AnalysisSpec, "not yet supported"],
  ] as [string, AnalysisSpec, string][]) {
    const result = await convertSpec({ tables: [baseTable()], analyses: [analysis] });
    const named = result.report.analysesUnsupported.some((u) => u.includes(want));
    const converted = Object.values(result.project.nodes).some((n) => n.type === "analysis");
    check(`analysis ${label}`, named && !converted, named ? `named unsupported: ${want}` : `unsupported list: [${result.report.analysesUnsupported.join("; ")}]`);
  }
  // Survival converts.
  {
    const result = await convertSpec({
      tables: [baseTable()],
      analyses: [{ title: "Survival", analysisClass: "SURVIVAL" }],
    });
    const nodes = Object.values(result.project.nodes).filter((n) => n.type === "analysis");
    const ok = nodes.length === 1 && nodes[0].analysisType === "survival-log-rank" && nodes[0].name === "Survival";
    check("analysis survival", ok, ok ? "1 survival-log-rank node" : JSON.stringify(nodes.map((n) => n.name)));
  }
  // A supported analysis with zero input datasets is warned about by
  // name and left out — never silently dropped (M4). Both shapes: an
  // empty list and a missing field.
  for (const [label, extra] of [
    ["empty inputDataSets", { inputDataSets: [] }],
    ["missing inputDataSets", { inputDataSets: undefined }],
  ] as [string, Partial<AnalysisSpec>][]) {
    const result = await convertSpec({ tables: [baseTable()], analyses: [fit("Fit", extra)] });
    const converted = Object.values(result.project.nodes).some((n) => n.type === "analysis");
    const warned = result.report.issues.some(
      (i) => i.message.includes("“Fit”") && i.message.includes("has no input datasets"),
    );
    check(`analysis zero inputs (${label})`, !converted && warned, `converted=${converted}, warned=${warned}`);
  }
  // Input table missing / no inputs / sheet missing: warned, left out.
  for (const [label, analysis] of [
    ["input table missing", fit("Fit", { inputSheetUid: "A0000099" })],
    ["no input sheets", fit("Fit", { inputSheetUid: null })],
    ["sheet.json missing", { ...fit("Fit"), sheetMissing: true }],
  ] as [string, AnalysisSpec][]) {
    const result = await convertSpec({ tables: [baseTable()], analyses: [analysis] });
    const converted = Object.values(result.project.nodes).some((n) => n.type === "analysis");
    // A missing sheet.json is warned about by analysis UID (the title is
    // unknowable — the sheet is gone); the others are warned about by name.
    const warned =
      label === "sheet.json missing"
        ? result.report.issues.some((i) => i.message.includes("has no sheet.json"))
        : result.report.issues.some((i) => i.message.includes("“Fit”"));
    check(`analysis ${label}`, !converted && warned, `converted=${converted}, warned=${warned}`);
  }
  // Analysis on a table that was left out: warned, left out; the good
  // table still converts.
  {
    const empty: TableSpec = {
      sheetTitle: "Empty",
      format: "column",
      dataFormat: "y_replicates",
      sets: [{ title: "A", replicates: [1] }],
      csv: [],
      rows: 0,
    };
    const result = await convertSpec({
      tables: [baseTable(), empty],
      analyses: [fit("Fit", { inputSheetUid: "A0000002" })],
    });
    const converted = Object.values(result.project.nodes).some((n) => n.type === "analysis");
    const warned = result.report.issues.some((i) => i.message.includes("“Fit”"));
    const good = tableOf(result, "Data") !== undefined;
    check("analysis input table left out", !converted && warned && good, `converted=${converted}, warned=${warned}, good table converts=${good}`);
  }
}

// ── I. Project-level rejects ─────────────────────────────────────────────
section("I. project-level rejects");
{
  async function expectThrow(
    name: string,
    buffer: Buffer,
    want: string,
  ): Promise<void> {
    try {
      await convertPrism(buffer, "test.prism");
      check(name, false, "converted but should have thrown");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      check(name, msg.includes(want), msg.includes(want) ? `threw: ${msg}` : `threw ${msg}, want text containing “${want}”`);
    }
  }
  await expectThrow("reject not a ZIP", Buffer.from("this is not a zip file"), "isn't a ZIP archive");
  await expectThrow(
    "reject no document.json",
    await buildPrism({ tables: [], noDocument: true }),
    "document.json is missing",
  );
  await expectThrow(
    "reject invalid document.json",
    await buildPrism({ tables: [], documentRaw: "{not json" }),
    "isn't valid JSON",
  );
  await expectThrow(
    "REGRESSION R4 reject no data sheets",
    await buildPrism({ tables: [] }),
    "has no data tables Helix can use",
  );
  await expectThrow(
    "REGRESSION R4 reject graphs only",
    await buildPrism({ tables: [], graphs: ["GRAPH-01"] }),
    "has no data tables Helix can use",
  );
  await expectThrow(
    "REGRESSION R4 reject all tables left out",
    await buildPrism({
      tables: [
        {
          sheetTitle: "Empty",
          format: "column",
          dataFormat: "y_replicates",
          sets: [{ title: "A", replicates: [1] }],
          csv: [],
          rows: 0,
        },
      ],
    }),
    "has no data tables Helix can use",
  );
  // A data sheet whose sheet.json has no table: warned, then refused.
  {
    const zip = await JSZip.loadAsync(
      await buildPrism({
        tables: [
          {
            sheetTitle: "T",
            format: "column",
            dataFormat: "y_replicates",
            sets: [{ title: "A", replicates: [1] }],
            csv: [["10"]],
          },
        ],
      }),
    );
    zip.file("data/sheets/A0000001/sheet.json", JSON.stringify({ title: "T" }));
    await expectThrow(
      "reject sheet with no table",
      await zip.generateAsync({ type: "nodebuffer" }),
      "has no data tables Helix can use",
    );
  }
  // A data sheet whose sheet.json is missing entirely: same.
  await expectThrow(
    "reject sheet.json missing",
    await buildPrism({
      tables: [
        {
          sheetTitle: "T",
          format: "column",
          dataFormat: "y_replicates",
          sets: [{ title: "A", replicates: [1] }],
          csv: [["10"]],
          sheetMissing: true,
        },
      ],
    }),
    "has no data tables Helix can use",
  );
}

// ── J. content.json shape ────────────────────────────────────────────────
section("J. content.json shape");
{
  const table = (): TableSpec => ({
    sheetTitle: "T",
    format: "column",
    dataFormat: "y_replicates",
    x: { title: "X", replicates: [1] },
    sets: [{ title: "Y1", replicates: [1] }],
    csv: [
      ["0", "10"],
      ["1", "11"],
    ],
  });
  // More rows declared than the CSV holds: padded with null rows, and
  // warned about — the padding is kept behaviour, the silence was the bug.
  {
    const t = table();
    t.rows = 4;
    const result = await convertSpec({ tables: [t] });
    const node = tableOf(result, "T");
    const ok =
      eq(node?.data?.rows, [
        [null, "0", "10"],
        [null, "1", "11"],
        [null, null, null],
        [null, null, null],
      ]) &&
      result.report.issues.some((i) =>
        i.message.includes("the file holds 2 rows but content.json declares 4; the missing rows were left empty"),
      );
    check("content rows > CSV rows pads nulls", ok, ok ? "4 rows, last two all null, warned" : JSON.stringify(node?.data?.rows));
  }
  // Fewer rows declared: the CSV is truncated.
  {
    const t = table();
    t.rows = 1;
    const result = await convertSpec({ tables: [t] });
    const node = tableOf(result, "T");
    const ok = eq(node?.data?.rows, [[null, "0", "10"]]);
    check("content rows < CSV rows truncates", ok, ok ? "1 row" : JSON.stringify(node?.data?.rows));
  }
  // More columns declared than map: warned, extra left out.
  {
    const t = table();
    t.cols = 6;
    const result = await convertSpec({ tables: [t] });
    const node = tableOf(result, "T");
    const ok =
      node?.data?.columns.length === 3 &&
      result.report.issues.some((i) => i.message.includes("holds 6 columns but only 2 map"));
    check("content cols > mapped warns", ok, ok ? "3 columns, extra named in a warning" : JSON.stringify(result.report.issues.map((i) => i.message)));
  }
  // No content.json at all: the CSV's own shape is used.
  {
    const t = table();
    t.contentMissing = true;
    const result = await convertSpec({ tables: [t] });
    const node = tableOf(result, "T");
    const ok = eq(node?.data?.rows, [[null, "0", "10"], [null, "1", "11"]]);
    check("content.json missing", ok, ok ? "CSV shape used" : JSON.stringify(node?.data?.rows));
  }
}

// ── K. Orphan / unreferenced tables ──────────────────────────────────────
section("K. orphan / unreferenced tables");
{
  const table = (): TableSpec => ({
    sheetTitle: "T",
    format: "column",
    dataFormat: "y_replicates",
    sets: [{ title: "A", replicates: [1] }],
    csv: [["10"]],
  });
  {
    const result = await convertSpec({
      tables: [table()],
      orphanSheets: [table()],
      extraTables: [{ uid: "B0000099", csv: [["1"]] }],
    });
    const ok =
      result.report.orphanSheetsIgnored === 1 &&
      result.report.unreferencedTablesIgnored === 1 &&
      result.report.tables.length === 1;
    check(
      "orphan sheet + unreferenced table counted",
      ok,
      `orphans=${result.report.orphanSheetsIgnored} unreferenced=${result.report.unreferencedTablesIgnored} tables=${result.report.tables.length}`,
    );
  }
  {
    const result = await convertSpec({ tables: [table()] });
    const ok = result.report.orphanSheetsIgnored === 0 && result.report.unreferencedTablesIgnored === 0;
    check("no orphans in a clean file", ok, `orphans=${result.report.orphanSheetsIgnored} unreferenced=${result.report.unreferencedTablesIgnored}`);
  }
  // Orphan UIDs need not be UUID-shaped: the scan matches any path
  // segment, so a sheet/table with a plain-name UID is still counted.
  {
    const orphan: TableSpec = {
      sheetUid: "not-a-uuid-sheet",
      tableUid: "not-a-uuid-table",
      sheetTitle: "T",
      format: "column",
      dataFormat: "y_replicates",
      sets: [{ title: "A", replicates: [1] }],
      csv: [["10"]],
    };
    const result = await convertSpec({
      tables: [table()],
      orphanSheets: [orphan],
      extraTables: [{ uid: "also-not-a-uuid", csv: [["1"]] }],
    });
    const ok = result.report.orphanSheetsIgnored === 1 && result.report.unreferencedTablesIgnored === 1;
    check(
      "non-UUID orphans counted",
      ok,
      `orphans=${result.report.orphanSheetsIgnored} unreferenced=${result.report.unreferencedTablesIgnored}`,
    );
  }
}

// ── L. CSV text shape ────────────────────────────────────────────────────
section("L. CSV text shape");
{
  // CRLF line endings: values come through identical to LF.
  {
    const table: TableSpec = {
      sheetTitle: "T",
      format: "column",
      dataFormat: "y_replicates",
      sets: [{ title: "A", replicates: [1] }],
      csv: [["10"], ["11"]],
      crlf: true,
    };
    const result = await convertSpec({ tables: [table] });
    const node = tableOf(result, "T");
    const ok = eq(node?.data?.rows, [[null, "10"], [null, "11"]]);
    check("CSV CRLF endings", ok, ok ? "values identical to LF" : JSON.stringify(node?.data?.rows));
  }
  // Quoted fields: commas and quotes inside row titles and values.
  {
    const table: TableSpec = {
      sheetTitle: "T",
      format: "column",
      dataFormat: "y_replicates",
      rowTitles: true,
      sets: [{ title: "A", replicates: [1] }],
      csv: [
        ["A, B", 'say "hi"'],
        ["C", "plain"],
      ],
    };
    const result = await convertSpec({ tables: [table] });
    const node = tableOf(result, "T");
    const ok = eq(node?.data?.rows, [["A, B", 'say "hi"'], ["C", "plain"]]);
    check("CSV quoted commas and quotes", ok, ok ? "titles and values exact" : JSON.stringify(node?.data?.rows));
  }
  // Embedded line breaks inside a quoted row title: Prism writes
  // multi-line titles with a bare CR (or CRLF, or a lone LF) inside the
  // quoted field. The field survives as ONE cell — the parser never
  // splits the row on it — and cleanText collapses the break to one
  // space, because Helix labels are single-line. (An earlier pin here
  // expected the break byte-exact; that contradicted cleanText, which
  // has collapsed breaks since the round-2 corpus fix — the pin was
  // wrong, not the converter.)
  for (const [label, title, want] of [
    ["bare CR", "BACE-I\r& DOX", "BACE-I & DOX"],
    ["CRLF", "WT\r(3 weeks)", "WT (3 weeks)"],
    ["lone LF", "Line1\nLine2", "Line1 Line2"],
  ] as [string, string, string][]) {
    const table: TableSpec = {
      sheetTitle: "T",
      format: "column",
      dataFormat: "y_replicates",
      rowTitles: true,
      sets: [{ title: "A", replicates: [1] }],
      csv: [[title, "10"]],
    };
    const result = await convertSpec({ tables: [table] });
    const node = tableOf(result, "T");
    const got = node?.data?.rows[0]?.[0];
    check(`CSV row title with embedded ${label}`, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  // A cell that is only whitespace — spaces, a lone CR, a lone LF — is
  // empty, never a stray space in the .hlx.
  {
    const table: TableSpec = {
      sheetTitle: "T",
      format: "column",
      dataFormat: "y_replicates",
      rowTitles: true,
      sets: [{ title: "A", replicates: [1] }],
      csv: [
        [" ", "10"],
        ["\r", "11"],
        ["\n", "12"],
      ],
    };
    const result = await convertSpec({ tables: [table] });
    const node = tableOf(result, "T");
    const ok = eq(node?.data?.rows, [
      [null, "10"],
      [null, "11"],
      [null, "12"],
    ]);
    check("CSV whitespace-only cells are empty", ok, ok ? "titles null, values kept" : JSON.stringify(node?.data?.rows));
  }
}

// ── M. Review regression tests (2026-11-10 read-only sweep) ─────────────
// Each case was run against the pre-fix converter and fails there (see
// the README's "Regression verification" note); the DST survival cases
// only fail on the old code under a non-UTC timezone, so run the suite
// with TZ=America/Los_Angeles for those.
section("M. review regressions (B1/B2/B3/M1/M3/M4/M5/m6)");
{
  // B1: a dataset JSON missing MID-table shifts every later dataset.
  {
    const table: TableSpec = {
      sheetTitle: "T",
      format: "column",
      dataFormat: "y_replicates",
      x: { title: "X", replicates: [1] },
      sets: [
        { title: "A", replicates: [1, 2] },
        { title: "B", replicates: [1, 2], missing: true },
        { title: "C", replicates: [1, 2] },
      ],
      csv: [
        ["0", "10", "20", "30", "40", "50", "60"],
        ["1", "11", "21", "31", "41", "51", "61"],
      ],
    };
    const result = await convertSpec({ tables: [table] });
    const node = tableOf(result, "T");
    const ok =
      eq(node?.data?.columns, ["Title", "X", "A_1", "A_2", "C_1", "C_2"]) &&
      eq(node?.data?.rows, [[null, "0", "10", "20", "50", "60"], [null, "1", "11", "21", "51", "61"]]) &&
      result.report.issues.some((i) =>
        i.message.includes("is missing; its 2 column(s) were skipped (inferred from the file's 7 declared columns)"),
      );
    const rt = roundTripOk(result);
    check("REGRESSION B1 missing mid-table dataset", ok && rt.ok, ok ? "C reads its own values, B skipped" : JSON.stringify(node?.data));
  }
  // B1: two unknowns can't be laid out — refuse, never guess.
  {
    const table: TableSpec = {
      sheetTitle: "T",
      format: "column",
      dataFormat: "y_replicates",
      x: { title: "X", replicates: [1] },
      sets: [
        { title: "A", replicates: [1, 2], missing: true },
        { title: "B", replicates: [1, 2], missing: true },
        { title: "C", replicates: [1, 2] },
      ],
      csv: [
        ["0", "10", "20", "30", "40", "50", "60"],
        ["1", "11", "21", "31", "41", "51", "61"],
      ],
    };
    try {
      await convertSpec({ tables: [table] });
      check("REGRESSION B1 two unknowns refuse", false, "converted but should have been refused");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      check("REGRESSION B1 two unknowns refuse", msg.includes("has no data tables Helix can use"), `refused: ${msg}`);
    }
  }
  // B1: a missing dataset's skip count from the table's replicatesCount.
  {
    const table: TableSpec = {
      sheetTitle: "T",
      format: "column",
      dataFormat: "y_replicates",
      replicatesCount: 3,
      x: { title: "X", replicates: [1] },
      sets: [
        { title: "A", replicates: [1, 2] },
        { title: "B", replicates: [1, 2], missing: true },
        { title: "C", replicates: [1, 2] },
      ],
      csv: [
        ["0", "10", "20", "30", "40", "50", "60", "70"],
        ["1", "11", "21", "31", "41", "51", "61", "71"],
      ],
    };
    const result = await convertSpec({ tables: [table] });
    const node = tableOf(result, "T");
    const ok =
      eq(node?.data?.columns, ["Title", "X", "A_1", "A_2", "C_1", "C_2"]) &&
      eq(node?.data?.rows, [[null, "0", "10", "20", "60", "70"], [null, "1", "11", "21", "61", "71"]]) &&
      result.report.issues.some((i) => i.message.includes("is missing; its 3 column(s) were skipped (the table's replicatesCount)"));
    check("REGRESSION B1 missing skipped by replicatesCount", ok, ok ? "C reads cols 6–7" : JSON.stringify(node?.data));
  }
  // B1: a missing dataset's skip count from the dataFormat's fixed shape.
  {
    const table: TableSpec = {
      sheetTitle: "T",
      format: "column",
      dataFormat: "y_sd_n",
      x: { title: "X", replicates: [1] },
      sets: [
        { title: "A", replicates: [1, 2, 3] },
        { title: "B", replicates: [1, 2, 3], missing: true },
        { title: "C", replicates: [1, 2, 3] },
      ],
      csv: [
        ["0", "10", "20", "30", "40", "50", "60", "70", "80", "90"],
        ["1", "11", "21", "31", "41", "51", "61", "71", "81", "91"],
      ],
    };
    const result = await convertSpec({ tables: [table] });
    const node = tableOf(result, "T");
    const ok =
      eq(node?.data?.columns, ["Title", "X", "A_MEAN", "A_SD", "A_N", "C_MEAN", "C_SD", "C_N"]) &&
      eq(node?.data?.rows, [[null, "0", "10", "20", "30", "70", "80", "90"], [null, "1", "11", "21", "31", "71", "81", "91"]]) &&
      result.report.issues.some((i) => i.message.includes("is missing; its 3 column(s) were skipped (the table's y_sd_n shape)"));
    check("REGRESSION B1 missing skipped by dataFormat shape", ok, ok ? "C reads cols 7–9" : JSON.stringify(node?.data));
  }
  // B1, grouped: the same skip, through the grouped emission loop.
  {
    const table: TableSpec = {
      sheetTitle: "T",
      format: "grouped",
      dataFormat: "y_replicates",
      replicatesCount: 2,
      sets: [
        { title: "A", replicates: [1, 2] },
        { title: "B", replicates: [1, 2], missing: true },
        { title: "C", replicates: [1, 2] },
      ],
      csv: [
        ["10", "20", "30", "40", "50", "60"],
        ["11", "21", "31", "41", "51", "61"],
      ],
    };
    const result = await convertSpec({ tables: [table] });
    const node = tableOf(result, "T");
    const ok =
      eq(node?.data?.columns, ["Title", "A:Y1", "A:Y2", "C:Y1", "C:Y2"]) &&
      eq(node?.data?.rows, [[null, "10", "20", "50", "60"], [null, "11", "21", "51", "61"]]) &&
      node?.data?.groups === 2 &&
      node?.data?.replicates === 2;
    check("REGRESSION B1 missing mid-table, grouped", ok, ok ? "C reads cols 4–5, groups=2" : JSON.stringify(node?.data));
  }
  // B2: a missing X dataset whose real X had 2 subcolumns (value + error).
  {
    const table: TableSpec = {
      sheetTitle: "T",
      format: "column",
      dataFormat: "y_replicates",
      x: { title: "X", replicates: [1, 2], missing: true },
      sets: [{ title: "A", replicates: [1, 2] }],
      csv: [
        ["5", "0.5", "10", "20"],
        ["6", "0.6", "11", "21"],
      ],
    };
    const result = await convertSpec({ tables: [table] });
    const node = tableOf(result, "T");
    const ok =
      eq(node?.data?.columns, ["Title", "X", "A_1", "A_2"]) &&
      eq(node?.data?.rows, [[null, "5", "10", "20"], [null, "6", "11", "21"]]) &&
      result.report.issues.some((i) => i.message.includes("the X dataset") && i.message.includes("is missing; 2 column(s) were read as X"));
    check("REGRESSION B2 missing multi-subcolumn X", ok, ok ? "A reads cols 2–3, X is the value" : JSON.stringify(node?.data));
  }
  // B2: a missing X plus a missing dataset is two unknowns — refuse.
  {
    const table: TableSpec = {
      sheetTitle: "T",
      format: "column",
      dataFormat: "y_replicates",
      x: { title: "X", replicates: [1, 2], missing: true },
      sets: [
        { title: "A", replicates: [1, 2], missing: true },
        { title: "B", replicates: [1, 2] },
      ],
      csv: [
        ["5", "0.5", "10", "20", "30", "40"],
        ["6", "0.6", "11", "21", "31", "41"],
      ],
    };
    try {
      await convertSpec({ tables: [table] });
      check("REGRESSION B2 missing X + missing dataset refuse", false, "converted but should have been refused");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      check("REGRESSION B2 missing X + missing dataset refuse", msg.includes("has no data tables Helix can use"), `refused: ${msg}`);
    }
  }
  // B3: a malformed replicate range is unknown, never 0 — inferred here.
  for (const [label, ranges, problem] of [
    ["unparseable", ["abc"], "“abc” isn't a replicate range"],
    ["reversed", ["2~0"], "“2~0” is reversed (start after end)"],
  ] as [string, string[], string][]) {
    const table: TableSpec = {
      sheetTitle: "T",
      format: "column",
      dataFormat: "y_replicates",
      x: { title: "X", replicates: [1] },
      sets: [
        { title: "A", replicateRanges: ranges },
        { title: "B", replicates: [1, 2] },
      ],
      csv: [
        ["0", "10", "20", "30", "40", "50"],
        ["1", "11", "21", "31", "41", "51"],
      ],
    };
    const result = await convertSpec({ tables: [table] });
    const node = tableOf(result, "T");
    const ok =
      eq(node?.data?.columns, ["Title", "X", "A_1", "A_2", "A_3", "B_1", "B_2"]) &&
      eq(node?.data?.rows, [[null, "0", "10", "20", "30", "40", "50"], [null, "1", "11", "21", "31", "41", "51"]]) &&
      result.report.issues.some((i) => i.message.includes("has malformed replicate ranges") && i.message.includes(problem));
    check(`REGRESSION B3 malformed range (${label})`, ok, ok ? "A inferred 3 subcolumns, B reads its own" : JSON.stringify(node?.data));
  }
  // M1: survival durations across US DST — exactly 7 and 1 days, and a
  // mixed date-only/datetime pair is 0, not −0.29. Only fails on the old
  // code under a non-UTC timezone (run with TZ=America/Los_Angeles).
  {
    const survival = (units: string): TableSpec => ({
      sheetTitle: "Survival",
      format: "survival",
      dataFormat: "y_single",
      x: {
        title: "Time",
        format: "date_se",
        replicates: [1, 2],
        dateTimeConversion: { units, zeroDate: "2024-03-09 00:00:00" },
      },
      sets: [{ title: "Control", replicates: [1] }],
      csv: [
        ["2024-03-09 00:00:00", "2024-03-16 00:00:00", "1"],
        ["2024-03-09 00:00:00", "2024-03-10 00:00:00", "0"],
        ["2024-09-06", "2024-09-06 00:00:00", "1"],
      ],
    });
    const result = await convertSpec({ tables: [survival("Days")] });
    const node = tableOf(result, "Survival");
    const ok =
      eq(node?.data?.columns, ["Title", "Time", "Control"]) &&
      eq(node?.data?.rows, [[null, "7", "1"], [null, "1", "0"], [null, "0", "1"]]);
    check("REGRESSION M1 survival durations across DST", ok, ok ? "7 / 1 / 0 days" : JSON.stringify(node?.data?.rows));
    // m1: units that aren't Days are warned about, not silently reported
    // in days.
    const hours = await convertSpec({ tables: [survival("Hours")] });
    const warned = hours.report.issues.some((i) => i.message.includes("the X dates use “Hours” units"));
    check("REGRESSION m1 non-Days units warned", warned, warned ? "Hours named in a warning" : hours.report.issues.map((i) => i.message).join(" | "));
  }
  // M5: a leading byte-order mark is file encoding, not the first cell.
  {
    const table: TableSpec = {
      sheetTitle: "T",
      format: "column",
      dataFormat: "y_replicates",
      sets: [{ title: "A", replicates: [1] }],
      csv: [["10"], ["11"]],
      bom: true,
    };
    const result = await convertSpec({ tables: [table] });
    const node = tableOf(result, "T");
    const ok = eq(node?.data?.rows, [[null, "10"], [null, "11"]]);
    check("REGRESSION M5 BOM stripped", ok, ok ? "first cell is 10, not \\uFEFF10" : JSON.stringify(node?.data?.rows));
  }
  // m6: a file with a multi-comma number reads commas as thousands
  // separators file-wide — "1,234" becomes 1234, and a lone comma
  // decimal like "45,5" stays text (in a thousands-locale file that
  // comma is not a decimal point the file means).
  {
    const table: TableSpec = {
      sheetTitle: "T",
      format: "column",
      dataFormat: "y_replicates",
      sets: [{ title: "A", replicates: [1] }],
      csv: [["1,234,567"], ["45,5"], ["1,234"]],
    };
    const result = await convertSpec({ tables: [table] });
    const node = tableOf(result, "T");
    const ok =
      eq(node?.data?.rows, [[null, "1234567"], [null, "45,5"], [null, "1234"]]) &&
      result.report.issues.some((i) => i.message.includes("thousands separators"));
    check("REGRESSION m6 thousands mode file-wide", ok, ok ? "1234567 / 45,5 / 1234, warned" : JSON.stringify(node?.data?.rows));
  }
}

console.log(`\n${checks - failures}/${checks} checks passed.`);
process.exit(failures ? 1 : 0);
