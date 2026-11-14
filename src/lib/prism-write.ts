// `.hlx` → `.prism` writer (in-app).
//
// Builds a Prism 10 `.prism` file (a ZIP of JSON + CSVs) from a Titer
// project: data tables with their values, and the analyses Titer offers,
// with their parameters. Graphs and layouts are NEVER written — Prism
// stores them in an undocumented binary blob, and writing a fake
// `data.bin` is forbidden. Fitted results are never written either:
// Titer stores params, never results, and whether Prism recomputes on
// open is unknown until a Prism/Viewer read-back (test C-07, still open).
//
// The spec is the vault note `Research/.prism write spec (1C).md` — this
// file implements it. Anything the spec marks unknown is left out, never
// guessed. Clean-room: written from files Prism wrote, never from Prism's
// program. Every UUID is fresh per write; `createdBy.name` is honestly
// "Titer", never "Prism".
//
// Table emission is the reverse of src/lib/prism.ts's import mapping:
//   xy         → format "xy", X dataset + Y datasets (replicates regrouped
//                 from `T_1…T_n` names; summary suffixes → summary formats)
//   column     → format "column", one y_single dataset per column
//   grouped    → format "grouped", one y_replicates dataset per group
//   contingency→ format "contingency", one y_single dataset per column
//   survival   → format "survival", X = time, one dataset per group
//   nested / multiple → the write FAILS with a plain-language error naming
//                 the table: silently dropping a table would be data loss,
//                 and Prism has no counterpart for them.

import JSZip from "jszip";
import type { ProjectFilePayload } from "./project-file";
import type { NonlinearModel } from "../stats/types";

export interface PrismWriteIssue {
  severity: "error" | "warning";
  message: string;
}

export interface PrismWriteReport {
  /** Tables written, in project order. */
  tables: string[];
  /** Analysis nodes written, in project order. */
  analyses: string[];
  /** Analyses present in the project that weren't written (named, not dropped). */
  analysesNotWritten: string[];
  issues: PrismWriteIssue[];
}

export interface PrismWriteResult {
  bytes: Uint8Array;
  report: PrismWriteReport;
}

/** Prism nonlinear equation name → Titer model is in src/lib/prism.ts
 *  (NONLINEAR_MODELS); this is the reverse map, for writing. Only models
 *  whose Prism equation + definition + parameters were seen in a real file
 *  (demo or corpus) are here. The log-X definition is Prism's
 *  Y=Bottom+(Top-Bottom)/(1+10^((LogEC50-X)*HillSlope)) — the same fit the
 *  importer maps from log(agonist)/log(inhibitor) files. */
const PRISM_EQUATION: Partial<Record<NonlinearModel, { name: string; definition: string; parameters: string[] }>> = {
  "sigmoidal-4pl-x": {
    name: "Sigmoidal, 4PL, X is concentration",
    definition: "Y=Bottom + (Top-Bottom)/(1+(IC50/X)^HillSlope)",
    parameters: ["Bottom", "Top", "IC50", "HillSlope"],
  },
  "sigmoidal-4pl-logx": {
    name: "Sigmoidal, 4PL, X is log(concentration)",
    definition: "Y=Bottom + (Top-Bottom)/(1+10^((LogEC50-X)*HillSlope))",
    parameters: ["Bottom", "Top", "LogEC50", "HillSlope"],
  },
  "one-phase-decay": {
    name: "One phase decay",
    definition: "Y=(Y0-Plateau)*exp(-K*X)+Plateau",
    parameters: ["Y0", "Plateau", "K"],
  },
  line: {
    name: "Line",
    definition: "Y=YIntercept+X*Slope",
    parameters: ["YIntercept", "Slope"],
  },
  quadratic: {
    name: "Second order polynomial (quadratic)",
    definition: "Y=B0+B1*X+B2*X^2",
    parameters: ["B0", "B1", "B2"],
  },
};

/** Summary subcolumn shapes, by the Titer column-name suffixes the importer
 *  produces for them (src/lib/prism.ts SUBCOLUMN_SUFFIXES). A group of
 *  columns sharing a base with exactly these suffixes becomes one dataset
 *  in that dataFormat; anything else is replicates or singles. */
const SUMMARY_FORMATS: { suffixes: string[]; dataFormat: string }[] = [
  { suffixes: ["_MEAN", "_SD", "_N"], dataFormat: "y_sd_n" },
  { suffixes: ["_MEAN", "_SEM", "_N"], dataFormat: "y_se_n" },
  { suffixes: ["_MEAN", "_CV", "_N"], dataFormat: "y_cv_n" },
  { suffixes: ["_MEAN", "_SD"], dataFormat: "y_sd" },
  { suffixes: ["_MEAN", "_SE"], dataFormat: "y_se" },
  { suffixes: ["_MEAN", "_CV"], dataFormat: "y_cv" },
  // y_plus_minus and y_high_low share the importer's column names; the
  // writer emits y_plus_minus (the importer reads both back the same way).
  { suffixes: ["_MEAN", "_PLUSERROR", "_MINUSERROR"], dataFormat: "y_plus_minus" },
];

/** One Titer data column's values, as text, per row. */
interface WriteColumn {
  name: string;
  values: (string | null)[];
}

/** A dataset to emit: its title, its columns' CSV positions, and the
 *  dataFormat the importer reads back from it. */
interface WriteSet {
  title: string;
  /** Indices into the table's CSV data columns (X excluded). */
  columns: number[];
  dataFormat: string;
  /** Replicate subcolumns (y_replicates only). */
  replicatesCount?: number;
}

const csvEncode = (rows: (string | null)[][]): string =>
  rows
    .map((row) =>
      row
        .map((cell) => {
          const v = cell ?? "";
          return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
        })
        .join(","),
    )
    .join("\n") + (rows.length ? "\n" : "");

/** Split Titer Y columns into Prism datasets. `columns` are the data columns
 *  (Title and X already removed). Grouping rules, in order:
 *  1. summary suffix groups (`T_MEAN`/`T_SD`/`T_N` → one y_sd_n dataset);
 *  2. replicate groups (`T_1`…`T_n` → one y_replicates dataset);
 *  3. anything left is one y_single dataset per column. */
function groupDatasets(columns: WriteColumn[]): WriteSet[] {
  const sets: WriteSet[] = [];
  const used = new Set<number>();
  // 1. Summary groups: exact suffix sets, same base.
  for (let i = 0; i < columns.length; i++) {
    if (used.has(i)) continue;
    for (const { suffixes, dataFormat } of SUMMARY_FORMATS) {
      if (!columns[i].name.endsWith(suffixes[0])) continue;
      const base = columns[i].name.slice(0, -suffixes[0].length);
      const group = suffixes.map((s) => columns.findIndex((c, j) => !used.has(j) && c.name === base + s));
      if (group.every((g) => g >= 0)) {
        group.forEach((g) => used.add(g));
        sets.push({ title: base, columns: group, dataFormat });
        break;
      }
    }
  }
  // 2. Replicate groups: `Base_1`…`Base_n`, consecutive from 1.
  for (let i = 0; i < columns.length; i++) {
    if (used.has(i)) continue;
    const m = /^(.*)_1$/.exec(columns[i].name);
    if (!m) continue;
    const base = m[1];
    const group = [i];
    for (let n = 2; ; n++) {
      const j = columns.findIndex((c, k) => !used.has(k) && c.name === `${base}_${n}`);
      if (j < 0) break;
      group.push(j);
    }
    if (group.length > 1) {
      group.forEach((g) => used.add(g));
      sets.push({ title: base, columns: group, dataFormat: "y_replicates", replicatesCount: group.length });
    }
  }
  // 3. Singles, in column order.
  for (let i = 0; i < columns.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    sets.push({ title: columns[i].name, columns: [i], dataFormat: "y_single" });
  }
  sets.sort((a, b) => Math.min(...a.columns) - Math.min(...b.columns));
  return sets;
}

const replicateEntry = (lastRow: number) => ({
  "@class": "DriverReplicate",
  valueType: "real",
  commonAttributes: ["NUMERIC"],
  decimalsLength: 1,
  significantDigitsCount: 7,
  lastRow,
  firstRow: 0,
});

export async function writePrism(project: ProjectFilePayload, appVersion: string): Promise<PrismWriteResult> {
  const issues: PrismWriteIssue[] = [];
  const report: PrismWriteReport = { tables: [], analyses: [], analysesNotWritten: [], issues };
  const zip = new JSZip();
  const setJson = (path: string, value: unknown) => zip.file(path, JSON.stringify(value, null, 2));

  const dataSheetUids: string[] = [];
  const analysisUids: string[] = [];
  const titles: Record<string, { title: string }> = {};
  // Table node id → { sheetUid, tableUid, datasetUidByTitle, datasetTitles }.
  const tableInfo = new Map<
    string,
    { sheetUid: string; tableUid: string; datasetUidByTitle: Map<string, string>; datasetTitles: string[] }
  >();

  const tables = project.rootOrder.map((id) => project.nodes[id]).filter((n) => n?.type === "table");
  if (tables.length === 0) {
    throw new Error("This project has no data tables to write — a .prism file with no tables isn't a Prism file.");
  }

  for (const table of tables) {
    const name = table.name;
    const displayName = `“${name}”`;
    const data = table.data;
    if (!data || data.columns.length < 2) {
      issues.push({ severity: "warning", message: `${displayName} holds no data columns; it was left out.` });
      continue;
    }
    const tableType = table.tableType ?? "column";
    if (tableType === "nested" || tableType === "multiple") {
      // Refuse the whole write: dropping a table silently would be data
      // loss, and Prism has no counterpart for these types. The user can
      // convert the table to Column first and try again.
      throw new Error(
        `${displayName} is a ${tableType === "nested" ? "Nested" : "Multiple variables"} table, and Prism has no matching table type — convert it to a Column table first, then save as .prism.`,
      );
    }
    const rowCount = data.rows.length;
    const rowTitles = data.rows.map((r) => r[0]);
    const hasRowTitles = rowTitles.some((v) => v !== null && v !== "");
    const sheetUid = crypto.randomUUID().toUpperCase();
    const tableUid = crypto.randomUUID().toUpperCase();
    dataSheetUids.push(sheetUid);
    titles[sheetUid] = { title: name };

    // Columns after Title: X first for xy/survival, then Y columns.
    const allColumns: WriteColumn[] = data.columns.slice(1).map((colName, i) => ({
      name: colName,
      values: data.rows.map((r) => r[i + 1] ?? null),
    }));
    const isXY = tableType === "xy" || tableType === "survival";
    const xColumn = isXY ? allColumns[0] : null;
    const yColumns = isXY ? allColumns.slice(1) : allColumns;

    // CSV column order: [row titles?] + [X subcolumns] + [dataset subcolumns…].
    // The writer emits one subcolumn per dataset, except y_replicates
    // (n subcolumns) — so the CSV order follows the dataset order below.
    let format: string;
    let dataFormat: string;
    let replicatesCount: number | undefined;
    let sets: WriteSet[];
    if (tableType === "grouped") {
      format = "grouped";
      // Columns are "Group:Y1"… — regroup by the part before ":Y".
      const groups = new Map<string, number[]>();
      yColumns.forEach((c, i) => {
        const m = /^(.*):Y\d+$/.exec(c.name);
        const group = m ? m[1] : c.name;
        const list = groups.get(group) ?? [];
        list.push(i);
        groups.set(group, list);
      });
      sets = [...groups.entries()].map(([title, cols]) => ({
        title,
        columns: cols,
        dataFormat: "y_replicates",
        replicatesCount: cols.length,
      }));
      dataFormat = "y_replicates";
      replicatesCount =
        data.groups !== undefined && data.replicates !== undefined
          ? data.replicates
          : Math.max(...sets.map((s) => s.columns.length));
    } else {
      sets = groupDatasets(yColumns);
      // The table's dataFormat is its datasets' format when they agree
      // (the usual case — e.g. a y_sd_n table); otherwise y_replicates
      // when any dataset replicates, else y_single.
      const uniform = sets.length > 0 && sets.every((s) => s.dataFormat === sets[0].dataFormat);
      if (tableType === "xy") {
        format = "xy";
        dataFormat = uniform
          ? sets[0].dataFormat
          : sets.some((s) => s.dataFormat === "y_replicates")
            ? "y_replicates"
            : "y_single";
        if (dataFormat === "y_replicates") {
          replicatesCount = Math.max(
            ...sets.filter((s) => s.dataFormat === "y_replicates").map((s) => s.columns.length),
          );
        }
      } else if (tableType === "survival") {
        format = "survival";
        dataFormat = "y_single";
      } else if (tableType === "contingency") {
        format = "contingency";
        dataFormat = "y_single";
      } else {
        format = "column";
        dataFormat = uniform ? sets[0].dataFormat : "y_single";
      }
    }

    // Dataset JSONs + CSV column layout, in dataset order.
    const csvCols: (string | null)[][] = [];
    const datasetUidByTitle = new Map<string, string>();
    const datasetTitles: string[] = [];
    const setUids: string[] = [];
    let xUid: string | undefined;
    if (xColumn) {
      xUid = crypto.randomUUID().toUpperCase();
      setJson(`data/sets/${xUid}.json`, {
        "@class": "DataSet",
        uid: xUid,
        format: "y_single",
        title: xColumn.name,
        attributes: ["DS_ATTR_X"],
        replicates: [{ ...replicateEntry(rowCount - 1), commonAttributes: ["NUMERIC", "NOTCONV"] }],
      });
      csvCols.push(xColumn.values);
    }
    for (const set of sets) {
      const setUid = crypto.randomUUID().toUpperCase();
      setUids.push(setUid);
      datasetTitles.push(set.title);
      datasetUidByTitle.set(set.title, setUid);
      const lastRow = rowCount - 1;
      if (set.dataFormat === "y_replicates") {
        setJson(`data/sets/${setUid}.json`, {
          "@class": "DataSet",
          uid: setUid,
          format: "y_replicates",
          title: set.title,
          attributes: ["DS_ATTR_Y"],
          "replicate ranges": [
            {
              range: set.columns.length === 1 ? "0" : `0~${set.columns.length - 1}`,
              replicate: replicateEntry(lastRow),
            },
          ],
        });
      } else {
        setJson(`data/sets/${setUid}.json`, {
          "@class": "DataSet",
          uid: setUid,
          format: set.dataFormat,
          title: set.title,
          attributes: ["DS_ATTR_Y"],
          replicates: set.columns.map(() => replicateEntry(lastRow)),
        });
      }
      for (const colIdx of set.columns) csvCols.push(yColumns[colIdx].values);
    }
    let rowTitlesUid: string | undefined;
    if (hasRowTitles) {
      rowTitlesUid = crypto.randomUUID().toUpperCase();
      setJson(`data/sets/${rowTitlesUid}.json`, {
        "@class": "DataSet",
        uid: rowTitlesUid,
        format: "text",
        title: "Row titles",
        attributes: ["DS_ATTR_RT"],
        replicates: [],
      });
    }

    // CSV: [row titles?] + [X] + [datasets in order].
    const csvRows: (string | null)[][] = Array.from({ length: rowCount }, (_, r) => [
      ...(hasRowTitles ? [rowTitles[r]] : []),
      ...csvCols.map((col) => col[r] ?? null),
    ]);
    const csvWidth = (hasRowTitles ? 1 : 0) + csvCols.length;
    zip.file(`data/tables/${tableUid}/data.csv`, csvEncode(csvRows));
    setJson(`data/tables/${tableUid}/content.json`, {
      numberOfColumns: csvWidth,
      numberOfRows: rowCount,
      version: 1,
    });
    setJson(`data/sheets/${sheetUid}/sheet.json`, {
      "@class": "DataSheet",
      title: name,
      table: {
        uid: tableUid,
        format,
        dataFormat,
        ...(replicatesCount !== undefined ? { replicatesCount } : {}),
        dataSets: setUids,
        ...(xUid ? { xDataSetFormat: "y_single", xDataSet: xUid } : {}),
        ...(rowTitlesUid ? { rowTitlesDataSet: rowTitlesUid } : {}),
      },
    });
    tableInfo.set(table.id, { sheetUid, tableUid, datasetUidByTitle, datasetTitles });
    report.tables.push(name);
  }

  if (report.tables.length === 0) {
    throw new Error("This project has no data tables Titer can write — nothing was written.");
  }

  // Analyses: one Prism analysis per Titer node (the importer splits one
  // Prism 4PL analysis over two datasets into two Titer nodes; the writer
  // reverses per node — the report says the written file has one analysis
  // per node, not per source analysis).
  for (const table of tables) {
    const info = tableInfo.get(table.id);
    if (!info) continue;
    const children = (project.childOrder[table.id] ?? [])
      .map((id) => project.nodes[id])
      .filter((n) => n?.type === "analysis");
    for (const node of children) {
      const params = (node.analysisParams ?? {}) as Record<string, unknown>;
      if (node.analysisType === "nonlinear-regression" && typeof params.model === "string") {
        const model = params.model as NonlinearModel;
        const equation = PRISM_EQUATION[model];
        if (!equation) {
          report.analysesNotWritten.push(
            `${node.name} (nonlinear model “${params.model}” — not yet supported in Prism)`,
          );
          continue;
        }
        const analysisUid = crypto.randomUUID().toUpperCase();
        analysisUids.push(analysisUid);
        const yTitle = typeof params.y === "string" ? params.y : undefined;
        // The importer names per-dataset nodes "<title> (<dataset>)" — the
        // Prism analysis title is the base name, so strip that suffix back
        // off on write, or the name doubles on every round trip.
        const baseName =
          yTitle && node.name.endsWith(` (${yTitle})`) ? node.name.slice(0, -(yTitle.length + 3)) : node.name;
        titles[analysisUid] = { title: baseName };
        const yDatasetUid = yTitle ? info.datasetUidByTitle.get(yTitle) : undefined;
        const inputDataSets =
          yDatasetUid && yTitle
            ? [{ uid: yDatasetUid, title: yTitle, idx: info.datasetTitles.indexOf(yTitle) }]
            : info.datasetTitles.map((title, idx) => ({
                uid: info.datasetUidByTitle.get(title) ?? "",
                title,
                idx,
              }));
        const is4PLx = model === "sigmoidal-4pl-x";
        setJson(`analyses/${analysisUid}/sheet.json`, {
          "@class": "AnalysisSheet",
          analysisClass: "NONLINEAR_REGRESSION",
          title: baseName,
          inputSheets: [{ uid: info.sheetUid, title: table.name }],
          inputDataSets,
          resultSheets: [],
          isCalculated: false,
        });
        setJson(`analyses/${analysisUid}/parameters.json`, {
          "@class": "AnalysisParameters",
          analysisClass: "NONLINEAR_REGRESSION",
          content: {
            data: {
              handleReplicatesAs: "INDIVIDUAL",
              range: {
                minX: { enabled: false, value: "undefined" },
                maxX: { enabled: false, value: "undefined" },
              },
            },
            model: {
              equation: {
                name: equation.name,
                definition: equation.definition,
                parameters: equation.parameters,
                intermediateVariables: [],
                // Initial-value rules and transforms are emitted only where
                // they were seen in a real file (the demo's 4PL); other
                // equations omit them — Titer's runner sets its own
                // starting values.
                ...(is4PLx
                  ? {
                      initialValueRules: {
                        Bottom: { value: 1.0, rule: "*YMIN" },
                        HillSlope: { value: 1.0, rule: "SIGN(YatXMax - YatXMin)" },
                        IC50: { value: 1.0, rule: "X_AT_YMID" },
                        Top: { value: 1.0, rule: "*YMAX" },
                      },
                      transforms: [
                        { name: "logIC50", definition: "log(IC50)", ciMethod: "ASYMMETRICAL" },
                        { name: "Span", definition: "Top-Bottom", ciMethod: "SYMMETRICAL" },
                      ],
                    }
                  : {}),
              },
              constraints: {},
              initialValues: {},
            },
          },
        });
        setJson(`analyses/${analysisUid}/constants.json`, { "@class": "AnalysisConstants", version: 1 });
        report.analyses.push(node.name);
      } else if (node.analysisType === "survival") {
        const analysisUid = crypto.randomUUID().toUpperCase();
        analysisUids.push(analysisUid);
        titles[analysisUid] = { title: node.name };
        setJson(`analyses/${analysisUid}/sheet.json`, {
          "@class": "AnalysisSheet",
          analysisClass: "SURVIVAL",
          title: node.name,
          inputSheets: [{ uid: info.sheetUid, title: table.name }],
          inputDataSets: info.datasetTitles.map((title, idx) => ({
            uid: info.datasetUidByTitle.get(title) ?? "",
            title,
            idx,
          })),
          resultSheets: [],
          isCalculated: false,
        });
        setJson(`analyses/${analysisUid}/parameters.json`, {
          "@class": "AnalysisParameters",
          analysisClass: "SURVIVAL",
          content: {
            data: { eventCode: 1, censorCode: 0 },
            calc: {
              twoGroupsLogrankTest: true,
              twoGroupsGehanBreslowWilcoxonTest: true,
              logrankTest: true,
              logrankTestForTrend: true,
              gehanBreslowWilcoxonTest: true,
              logrankTestMethod: "RECOMMENDED",
              logrankTestForTrendMethod: "RECOMMENDED",
              tabulate: "EVENT",
              probabilityAs: "PERCENTAGE",
              ciMethod: "ASYMMETRICAL",
            },
            graph: { showCensoredSubjects: true, errorBars: "NONE" },
            output: {
              significantDigitCount: 4,
              pValueStyle: { type: "P_VALUE_STYLE_GP", decimalDigitCount: 6 },
            },
          },
        });
        setJson(`analyses/${analysisUid}/constants.json`, { "@class": "AnalysisConstants", version: 1 });
        report.analyses.push(node.name);
      } else {
        report.analysesNotWritten.push(`${node.name} (${node.analysisType} — not yet supported in Prism)`);
      }
    }
  }

  // One Prism analysis per Titer node, not per source analysis (the importer
  // splits one Prism 4PL over two datasets into two nodes) — say so plainly.
  const analysisNodes = report.analyses.length;
  if (analysisNodes > 0) {
    issues.push({
      severity: "warning",
      message: `Analyses are written one per Titer node (${analysisNodes} written) — a Prism analysis over two datasets becomes two Titer nodes on import, and each writes back as its own analysis.`,
    });
  }
  issues.push({
    severity: "warning",
    message:
      "Graphs and layouts are not written — Prism stores them in a binary format it does not document. Re-create them in Prism from the tables.",
  });

  setJson("document.json", {
    "@class": "Document",
    creationDate: new Date().toISOString(),
    createdBy: { name: "Titer", version: appVersion },
    formatVersion: "1-4-1",
    minFormatVersion: "1-4-0",
    minPrismVersion: "10.3.0",
    sheets: {
      graphs: [],
      layouts: [],
      analyses: analysisUids,
      info: [],
      data: dataSheetUids,
    },
    sheetAttributesMap: titles,
  });

  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { bytes, report };
}

/** The transfer report as plain text, for the save dialog and the log. */
export function formatWriteReport(report: PrismWriteReport): string {
  const lines: string[] = [
    `Tables written: ${report.tables.length}${report.tables.length ? " — " + report.tables.join(", ") : ""}`,
    `Analyses written: ${report.analyses.length}${report.analyses.length ? " — " + report.analyses.join(", ") : ""}`,
  ];
  if (report.analysesNotWritten.length) {
    lines.push(`Analyses not written (not yet supported in Prism): ${report.analysesNotWritten.join("; ")}`);
  }
  for (const issue of report.issues)
    lines.push(`${issue.severity === "error" ? "Error" : "Warning"}: ${issue.message}`);
  return lines.join("\n");
}
