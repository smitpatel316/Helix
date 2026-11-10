// `.prism` → `.hlx` converter core.
//
// Reads a Prism 10 `.prism` file (a ZIP of JSON + CSVs) and builds the Helix
// project it holds: data tables with their values, and the analyses Helix
// offers, with their parameters. Graphs and layouts are NOT transferred —
// Prism stores them in an undocumented binary blob — and neither are
// fitted results: Helix recomputes every analysis from the table when the
// file opens, so results always match the data.
//
// The field-by-field mapping lives in the vault:
//   ~/workspace/helix-vault/Research/Prism 10 to hlx mapping.md
// That doc is the spec; this file implements it. Anything the doc marks
// unknown is a warning here, never a guess.
//
// Clean-room: written from files Prism wrote, never from Prism's program.
// The source file is only ever read, never written.

import JSZip from "jszip";
import type { ProjectFilePayload } from "../../src/lib/project-file";
import type { ProjectNode, TableData, TableType } from "../../src/store/types";
import type { NonlinearModel } from "../../src/stats/types";
import { parseCsv } from "./csv";

export interface ConvertIssue {
  severity: "error" | "warning";
  message: string;
}

export interface ConvertReport {
  source: string;
  /** Prism version that wrote the file, from document.json. */
  prismVersion: string;
  formatVersion: string;
  /** Tables transferred, in file order. */
  tables: string[];
  /** Analysis nodes transferred, in file order. */
  analyses: string[];
  /** Analyses present in the file that Helix doesn't offer (named, not dropped). */
  analysesUnsupported: string[];
  graphsNotTransferred: number;
  layoutsNotTransferred: number;
  infoSheets: number;
  orphanSheetsIgnored: number;
  unreferencedTablesIgnored: number;
  issues: ConvertIssue[];
}

export interface ConvertResult {
  project: ProjectFilePayload;
  report: ConvertReport;
}

// ── Prism document shapes (only the fields the converter reads) ─────────

interface PrismDocument {
  createdBy?: { version?: string };
  formatVersion?: string;
  sheets?: {
    graphs?: string[];
    layouts?: string[];
    analyses?: string[];
    info?: string[];
    data?: string[];
  };
  sheetAttributesMap?: Record<string, { title?: string | { string?: string } }>;
}

interface PrismDataSheet {
  /** Sheet title — a plain string, or a rich-text object (see PrismDataSet). */
  title?: string | { string?: string };
  table?: {
    uid?: string;
    format?: string;
    dataFormat?: string;
    replicatesCount?: number;
    dataSets?: string[];
    xDataSet?: string;
    rowTitlesDataSet?: string;
  };
}

interface PrismDataSet {
  /**
   * The dataset's title. Usually a plain string — but Prism sometimes
   * writes a rich-text object `{ string, version, formatting }` (seen in
   * real files: dose-curve, dilution, ELISA). `plainTitle` unwraps it.
   */
  title?: string | { string?: string };
  format?: string;
  replicates?: unknown[];
  /** `y_replicates` datasets carry this instead of `replicates`: a list of
   *  ranges, each covering one or more replicate subcolumns ("0~1" = two,
   *  "2" = one). */
  "replicate ranges"?: { range?: string }[];
  /** Survival X datasets carry this: how their dates become durations. */
  dateTimeConversion?: { units?: string; zeroDate?: string };
}

/** How many subcolumns a dataset holds: its `replicates` array, else the
 *  span of its `replicate ranges`, else the table's `replicatesCount`. */
function replicateCount(set: PrismDataSet, table: PrismDataSheet["table"]): number {
  if (Array.isArray(set.replicates)) return set.replicates.length;
  const ranges = set["replicate ranges"];
  if (Array.isArray(ranges)) {
    return ranges.reduce((n, r) => {
      const m = /^(\d+)(?:~(\d+))?$/.exec(r.range ?? "");
      if (!m) return n;
      return n + (m[2] === undefined ? 1 : Number(m[2]) - Number(m[1]) + 1);
    }, 0);
  }
  return table?.replicatesCount ?? 0;
}

interface PrismAnalysisSheet {
  /** Sheet title — a plain string, or a rich-text object (see PrismDataSet). */
  title?: string | { string?: string };
  analysisClass?: string;
  inputSheets?: { uid?: string; title?: string }[];
  inputDataSets?: { uid?: string; title?: string | { string?: string }; idx?: string }[];
}

interface PrismAnalysisParameters {
  analysisClass?: string;
  content?: {
    model?: { equation?: { name?: string } };
  };
}

// ── Column naming (same rules as the `.pzfx` importer, src/lib/pzfx.ts) ──

/** Summary subcolumns, by Prism dataFormat. `null` = raw replicates. */
const SUBCOLUMN_SUFFIXES: Record<string, string[] | null> = {
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

/** Prism nonlinear-regression equation name → Helix model. Only what a corpus
 *  file has shown; anything else is unsupported, never guessed. */
const NONLINEAR_MODELS: Record<string, NonlinearModel> = {
  "Sigmoidal, 4PL, X is concentration": "sigmoidal-4pl-x",
};

const genId = (type: string) => `${type}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * A Prism title as plain text. Usually a string — but Prism sometimes
 * writes a rich-text object `{ string, version, formatting }` (seen on
 * dataset and X titles in real files). Anything else is "" and the
 * caller's fallback applies. Never returns "[object Object]".
 */
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

/** Days between two Prism date cells, as Helix stores numbers (text). */
function daysBetween(start: string | null, end: string | null): string | null {
  const a = parsePrismDate(start);
  const b = parsePrismDate(end);
  if (a === null || b === null) return null;
  const days = (b - a) / 86_400_000;
  return Number.isInteger(days) ? String(days) : String(Number(days.toFixed(6)));
}

/** `1,5` (comma decimal) → `1.5`; anything else stays as typed. */
const normalizeNumber = (value: string | null): string | null =>
  value !== null && /^-?\d+,\d+$/.test(value) ? value.replace(",", ".") : value;

function subcolumnNames(title: string, dataFormat: string, count: number): string[] {
  const base = title === "" ? "Y" : title;
  if (count === 1) return [base];
  const suffixes = SUBCOLUMN_SUFFIXES[dataFormat];
  if (suffixes && suffixes.length === count) return suffixes.map((s) => `${base}${s}`);
  if (suffixes === null) return Array.from({ length: count }, (_, i) => `${base}_${i + 1}`);
  return Array.from({ length: count }, (_, i) => `${base}_${i + 1}`);
}

const isSummaryFormat = (dataFormat: string) => {
  const s = SUBCOLUMN_SUFFIXES[dataFormat];
  return s !== undefined && s !== null && s.length > 0;
};

// ── The converter ────────────────────────────────────────────────────────

export async function convertPrism(buffer: Buffer, sourceName: string): Promise<ConvertResult> {
  const issues: ConvertIssue[] = [];
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error(
      `“${sourceName}” isn't a Prism 10 .prism file — it isn't a ZIP archive. ` +
        `A .prism file is a ZIP holding JSON and CSV files.`,
    );
  }
  const readText = async (path: string): Promise<string | null> => {
    const file = zip.file(path);
    return file ? file.async("string") : null;
  };
  const readJson = async <T>(path: string): Promise<T | null> => {
    const text = await readText(path);
    if (text === null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      issues.push({ severity: "warning", message: `“${path}” isn't valid JSON; it was left out.` });
      return null;
    }
  };

  const docText = await readText("document.json");
  if (docText === null) {
    throw new Error(
      `“${sourceName}” isn't a Prism 10 .prism file — document.json is missing. ` +
        `A .prism file is a ZIP with document.json at its top level.`,
    );
  }
  let doc: PrismDocument;
  try {
    doc = JSON.parse(docText) as PrismDocument;
  } catch {
    throw new Error(`“${sourceName}” has a document.json that isn't valid JSON — the file may be corrupt.`);
  }
  const sheets = doc.sheets ?? {};
  const titles = doc.sheetAttributesMap ?? {};
  const titleOf = (uid: string, fallback: string) => {
    const t = plainTitle(titles[uid]?.title);
    return t !== "" ? t : fallback;
  };

  const nodes: Record<string, ProjectNode> = {};
  const rootOrder: string[] = [];
  const childOrder: Record<string, string[]> = {};
  const tableNodeBySheet = new Map<string, string>();
  const report: ConvertReport = {
    source: sourceName,
    prismVersion: doc.createdBy?.version ?? "unknown",
    formatVersion: doc.formatVersion ?? "unknown",
    tables: [],
    analyses: [],
    analysesUnsupported: [],
    graphsNotTransferred: (sheets.graphs ?? []).length,
    layoutsNotTransferred: (sheets.layouts ?? []).length,
    infoSheets: (sheets.info ?? []).length,
    orphanSheetsIgnored: 0,
    unreferencedTablesIgnored: 0,
    issues,
  };

  // ── Data tables ──
  for (const sheetUid of sheets.data ?? []) {
    const sheet = await readJson<PrismDataSheet>(`data/sheets/${sheetUid}/sheet.json`);
    if (!sheet || !sheet.table?.uid) {
      issues.push({ severity: "warning", message: `Data sheet “${sheetUid}” has no table; it was left out.` });
      continue;
    }
    const table = sheet.table;
    const name = plainTitle(sheet.title) || titleOf(sheetUid, "Imported table");
    const displayName = `“${name}”`;
    const tableUid = table.uid as string;

    const content = await readJson<{ numberOfColumns?: number; numberOfRows?: number }>(
      `data/tables/${tableUid}/content.json`,
    );
    const csvText = await readText(`data/tables/${tableUid}/data.csv`);
    if (csvText === null) {
      issues.push({ severity: "warning", message: `${displayName} has no data.csv; it was left out.` });
      continue;
    }
    let csv = parseCsv(csvText);
    if (typeof content?.numberOfRows === "number") {
      if (csv.length > content.numberOfRows) csv = csv.slice(0, content.numberOfRows);
      while (csv.length < content.numberOfRows) csv.push([]);
    }

    const format = table.format ?? "";
    const dataFormat = table.dataFormat ?? "";
    const setUids = table.dataSets ?? [];
    const sets: PrismDataSet[] = [];
    for (const setUid of setUids) {
      const set = await readJson<PrismDataSet>(`data/sets/${setUid}.json`);
      if (set) sets.push(set);
      else issues.push({ severity: "warning", message: `${displayName}: dataset “${setUid}” is missing; its columns were left out.` });
    }
    if (sets.length === 0) {
      issues.push({ severity: "warning", message: `${displayName} holds no data columns. It was left out.` });
      continue;
    }
    // The CSV's first column holds row titles only when the table has a
    // row-titles dataset. Never assume it from the format: column tables
    // usually have none, and XY tables sometimes have one (empty titles).
    const hasTitleCol = table.rowTitlesDataSet != null;
    // An X dataset can hold more than one subcolumn (an error-bar X has
    // value + error; a survival date X has start + end dates). All of
    // them sit in the CSV and must be consumed, or every dataset after
    // them shifts by one.
    let xTitle: string | null = null;
    let xCount = 0;
    let xFormat = "";
    if (table.xDataSet) {
      const xSet = await readJson<PrismDataSet>(`data/sets/${table.xDataSet}.json`);
      if (xSet) {
        const t = plainTitle(xSet.title);
        xTitle = t !== "" ? t : "X";
        xCount = replicateCount(xSet, table);
        xFormat = xSet.format ?? "";
      } else {
        issues.push({
          severity: "warning",
          message: `${displayName}: the X dataset “${table.xDataSet}” is missing; one column was read as X.`,
        });
        xTitle = "X";
        xCount = 1;
      }
    }
    const hasXCol = xTitle !== null;

    // Helix columns: [Title, ...data]. Each entry: name + values per row.
    interface ImportColumn {
      name: string;
      values: (string | null)[];
    }
    const columns: ImportColumn[] = [];
    // CSV column cursor: title col, then X subcolumns, then each dataset's
    // subcolumns. An empty CSV field is an empty cell (null in .hlx), not "".
    let cursor = 0;
    const csvCol = (i: number) =>
      csv.map((r) => {
        const v = r[i];
        return v === "" || v === undefined ? null : normalizeNumber(v);
      });
    if (hasTitleCol) cursor++; // row titles are read separately below
    if (hasXCol) {
      const xCols: (string | null)[][] = [];
      for (let i = 0; i < xCount; i++) {
        xCols.push(csvCol(cursor));
        cursor++;
      }
      if (xCount === 1) {
        columns.push({ name: xTitle as string, values: xCols[0] });
      } else if (format === "survival" && xFormat.startsWith("date") && xCount >= 2) {
        // A survival table's X is time. With dates Prism stores start and
        // end dates; time is the gap between them, in days — exactly what
        // Prism's own survival analysis uses.
        const durations = xCols[0].map((start, r) => daysBetween(start, xCols[1][r] ?? null));
        const unparsed = xCols[0].filter(
          (v, r) => v !== null && v !== "" && durations[r] === null && xCols[1][r] !== null && xCols[1][r] !== "",
        ).length;
        columns.push({ name: xTitle as string, values: durations });
        issues.push({
          severity: "warning",
          message: `${displayName}: the X dates were converted to durations in days (end − start), which is what the survival analysis uses as time.` +
            (unparsed > 0 ? ` ${unparsed} row(s) had a date that couldn't be read, so their time is empty.` : ""),
        });
      } else {
        // Helix tables hold one X column: keep the first subcolumn (the
        // value; for an error-bar X the second is the error) and say so.
        columns.push({ name: xTitle as string, values: xCols[0] });
        issues.push({
          severity: "warning",
          message: `${displayName}: the X dataset has ${xCount} subcolumns; only the first was imported as X.`,
        });
      }
    }
    let groups: number | undefined;
    let replicates: number | undefined;
    if (format === "grouped") {
      groups = sets.length;
      replicates = table.replicatesCount ?? Math.max(...sets.map((s) => replicateCount(s, table)));
      sets.forEach((set) => {
        const group = plainTitle(set.title) || "Group";
        const count = replicateCount(set, table);
        for (let i = 0; i < count; i++) {
          columns.push({ name: `${group}:Y${i + 1}`, values: csvCol(cursor) });
          cursor++;
        }
      });
    } else {
      for (const set of sets) {
        const count = replicateCount(set, table);
        const names = subcolumnNames(plainTitle(set.title), dataFormat, count);
        for (let i = 0; i < count; i++) {
          columns.push({ name: names[i], values: csvCol(cursor) });
          cursor++;
        }
      }
    }

    const rowTitles = hasTitleCol ? csv.map((r) => (r[0] === "" ? null : (r[0] ?? null))) : [];
    const hasRowTitles = rowTitles.some((v) => v !== null && v !== "");
    const rowCount = Math.max(0, ...columns.map((c) => c.values.length), rowTitles.length);
    if (rowCount === 0 || columns.length === 0) {
      issues.push({ severity: "warning", message: `${displayName} holds no data. It was left out.` });
      continue;
    }
    // CSV columns the converter consumed: title + every X subcolumn + every
    // dataset subcolumn. (Helix holds fewer columns when X subcolumns
    // collapse into one X — that is expected, not a leftover.)
    const datasetCols = columns.length - (hasXCol ? 1 : 0);
    const consumedCols = (hasTitleCol ? 1 : 0) + xCount + datasetCols;
    if (typeof content?.numberOfColumns === "number" && content.numberOfColumns > consumedCols) {
      issues.push({
        severity: "warning",
        message: `${displayName}: the file holds ${content.numberOfColumns} columns but only ${consumedCols} map to Helix columns; the extra columns were left out.`,
      });
    }

    let helixType: TableType;
    if (format === "xy" || format === "survival") helixType = "xy";
    else if (format === "grouped") helixType = "grouped";
    else if (format === "contingency") helixType = "contingency";
    else if (format === "column") helixType = "column";
    else if (format === "nested") {
      // A Prism nested table is one of Prism's formats, but Helix's nested
      // table needs its own structure — import as Column, never silently.
      helixType = "column";
      issues.push({
        severity: "warning",
        message: `${displayName}: Prism nested tables import as Column — convert it to Nested by hand in Helix.`,
      });
    } else {
      helixType = "column";
      issues.push({
        severity: "warning",
        message: `${displayName}: table format “${format}” isn't one Helix knows; it was imported as a Column table.`,
      });
    }
    if (format === "survival") {
      issues.push({
        severity: "warning",
        message: `${displayName}: imported as an XY table (time in X, event codes 1 = event, 0 = censored in each group) — the survival graph and log-rank analysis apply to it.`,
      });
    }
    if (isSummaryFormat(dataFormat)) {
      issues.push({
        severity: "warning",
        message: `${displayName}: the values are summaries (${dataFormat}), not raw replicates — don't run group comparisons on them as if they were.`,
      });
    }

    const data: TableData = {
      columns: ["Title", ...columns.map((c) => c.name)],
      rows: Array.from({ length: rowCount }, (_, r) => [
        hasRowTitles ? (rowTitles[r] ?? null) : null,
        ...columns.map((c) => c.values[r] ?? null),
      ]),
      ...(groups !== undefined && replicates !== undefined ? { groups, replicates } : {}),
    };
    const node: ProjectNode = {
      id: genId("table"),
      type: "table",
      name,
      parentId: null,
      tableType: helixType,
      data,
    };
    nodes[node.id] = node;
    rootOrder.push(node.id);
    childOrder[node.id] = [];
    tableNodeBySheet.set(sheetUid, node.id);
    report.tables.push(name);
  }

  // ── Analyses ──
  for (const analysisUid of sheets.analyses ?? []) {
    const sheet = await readJson<PrismAnalysisSheet>(`analyses/${analysisUid}/sheet.json`);
    if (!sheet) {
      issues.push({ severity: "warning", message: `Analysis “${analysisUid}” has no sheet.json; it was left out.` });
      continue;
    }
    const name = plainTitle(sheet.title) || titleOf(analysisUid, "Imported analysis");
    const inputSheetUid = sheet.inputSheets?.[0]?.uid;
    const parentId = inputSheetUid ? tableNodeBySheet.get(inputSheetUid) : undefined;
    if (!parentId) {
      issues.push({
        severity: "warning",
        message: `Analysis “${name}” has no input table in this file; it was left out.`,
      });
      continue;
    }
    const params = await readJson<PrismAnalysisParameters>(`analyses/${analysisUid}/parameters.json`);
    const analysisClass = sheet.analysisClass ?? params?.analysisClass ?? "";

    if (analysisClass === "NONLINEAR_REGRESSION") {
      const equation = params?.content?.model?.equation?.name ?? "";
      const model = NONLINEAR_MODELS[equation];
      if (!model) {
        report.analysesUnsupported.push(`${name} (nonlinear model “${equation}” — not yet supported in Helix)`);
        continue;
      }
      for (const ds of sheet.inputDataSets ?? []) {
        const y = plainTitle(ds.title);
        const node: ProjectNode = {
          id: genId("analysis"),
          type: "analysis",
          name: y ? `${name} (${y})` : name,
          parentId,
          analysisType: "nonlinear-regression",
          analysisParams: { model, ...(y ? { y } : {}) },
        };
        nodes[node.id] = node;
        childOrder[parentId].push(node.id);
        report.analyses.push(node.name);
      }
    } else if (analysisClass === "SURVIVAL") {
      const node: ProjectNode = {
        id: genId("analysis"),
        type: "analysis",
        name,
        parentId,
        analysisType: "survival-log-rank",
      };
      nodes[node.id] = node;
      childOrder[parentId].push(node.id);
      report.analyses.push(name);
    } else {
      report.analysesUnsupported.push(`${name} (${analysisClass} — not yet supported in Helix)`);
    }
  }

  // ── Orphans: sheets and tables document.json doesn't list ──
  const listedSheets = new Set([
    ...(sheets.data ?? []),
    ...(sheets.graphs ?? []),
    ...(sheets.layouts ?? []),
    ...(sheets.analyses ?? []),
    ...(sheets.info ?? []),
  ]);
  for (const path of Object.keys(zip.files)) {
    const m = /^data\/sheets\/([0-9A-F-]+)\/sheet\.json$/i.exec(path);
    if (m && !listedSheets.has(m[1].toUpperCase()) && !listedSheets.has(m[1])) report.orphanSheetsIgnored++;
  }
  // Tables referenced by ANY sheet in the zip (listed or orphan) count as
  // referenced; only tables no sheet points at are unreferenced.
  const referencedTables = new Set<string>();
  for (const path of Object.keys(zip.files)) {
    const m = /^data\/sheets\/([0-9A-F-]+)\/sheet\.json$/i.exec(path);
    if (!m) continue;
    const sheet = await readJson<PrismDataSheet>(path);
    const uid = (sheet?.table as { uid?: string } | undefined)?.uid;
    if (uid) referencedTables.add(uid.toUpperCase());
  }
  for (const path of Object.keys(zip.files)) {
    const m = /^data\/tables\/([0-9A-F-]+)\/content\.json$/i.exec(path);
    if (m && !referencedTables.has(m[1].toUpperCase())) report.unreferencedTablesIgnored++;
  }

  // A project with no tables is not a project Helix can open — its own
  // parser rejects it ("no readable data tables"). Refuse cleanly instead
  // of writing a .hlx that Helix itself won't read.
  if (report.tables.length === 0) {
    const dataSheets = sheets.data?.length ?? 0;
    throw new Error(
      `“${sourceName}” has no data tables Helix can use — all ${dataSheets} data sheet(s) were left out, ` +
        `and graphs/layouts are not transferred. Nothing was written.`,
    );
  }

  return {
    project: { nodes, rootOrder, childOrder, activeNodeId: rootOrder[0] ?? null },
    report,
  };
}

/** The transfer report as plain text, for the terminal and the log. */
export function formatReport(report: ConvertReport): string {
  const lines: string[] = [
    `Converted “${report.source}” (Prism ${report.prismVersion}, format ${report.formatVersion}).`,
    `Tables transferred: ${report.tables.length}${report.tables.length ? " — " + report.tables.join(", ") : ""}`,
    `Analyses transferred: ${report.analyses.length}${report.analyses.length ? " — " + report.analyses.join(", ") : ""}`,
  ];
  if (report.analysesUnsupported.length) {
    lines.push(`Analyses not transferred (not yet supported in Helix): ${report.analysesUnsupported.join("; ")}`);
  }
  if (report.graphsNotTransferred) {
    lines.push(
      `Graphs not transferred: ${report.graphsNotTransferred} — re-create in Helix (graph data is stored in a binary format Prism does not document).`,
    );
  }
  if (report.layoutsNotTransferred) {
    lines.push(`Layouts not transferred: ${report.layoutsNotTransferred} — re-create with the figure builder.`);
  }
  if (report.infoSheets) lines.push(`Info sheets not transferred: ${report.infoSheets} (Helix has no info sheet).`);
  if (report.orphanSheetsIgnored || report.unreferencedTablesIgnored) {
    lines.push(
      `Ignored: ${report.orphanSheetsIgnored} orphan sheet(s) and ${report.unreferencedTablesIgnored} unreferenced table(s) that document.json doesn't list.`,
    );
  }
  for (const issue of report.issues) lines.push(`${issue.severity === "error" ? "Error" : "Warning"}: ${issue.message}`);
  return lines.join("\n");
}
