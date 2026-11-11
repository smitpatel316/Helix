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

/**
 * The pure helpers below are exported for the unit tests
 * (tests/unit-helpers.ts) — the converter only uses them internally, and
 * nothing else should import them. They are the abstract layer: given a
 * known input shape, their output is pinned by tests so any file Prism
 * sends in behaves the same way.
 */
export function replicateCount(set: PrismDataSet, table: PrismDataSheet["table"]): number {
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

/**
 * Problems with a dataset's "replicate ranges": strings that don't parse
 * as a range, and reversed ranges ("2~0"). A dataset with problems has an
 * UNKNOWN subcolumn count — the layout step infers it from the file's
 * dims or refuses the table; it must never silently count 0 and shift
 * the next dataset. `replicateCount` above still skips bad ranges when
 * called directly (its unit pin says so), but the converter never calls
 * it on a dataset with problems — it checks this first.
 */
export function replicateRangeProblems(set: PrismDataSet): string[] {
  const problems: string[] = [];
  const ranges = set["replicate ranges"];
  if (!Array.isArray(ranges)) return problems;
  for (const r of ranges) {
    const raw = r.range ?? "";
    const m = /^(\d+)(?:~(\d+))?$/.exec(raw);
    if (!m) {
      problems.push(`“${raw}” isn't a replicate range`);
      continue;
    }
    if (m[2] !== undefined && Number(m[2]) < Number(m[1])) {
      problems.push(`“${raw}” is reversed (start after end)`);
    }
  }
  return problems;
}

/** Subcolumns a Prism dataFormat spans when its shape is fixed — the
 *  count a MISSING dataset is skipped by (its JSON is gone, so no
 *  replicates/ranges can be read). `y_replicates` isn't here: its count
 *  varies, so it uses the table's replicatesCount instead; anything
 *  else is unknown and goes to the dims inference. */
const DATAFORMAT_SUBCOLUMNS: Record<string, number> = {
  y_single: 1,
  y_sd_n: 3,
  y_se_n: 3,
  y_cv_n: 3,
  y_sd: 2,
  y_se: 2,
  y_cv: 2,
  y_plus_minus: 3,
  y_high_low: 3,
};

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

/** Prism nonlinear-regression equation name → Helix model. Only equations
 *  whose formula matches a Helix model exactly (checked against
 *  src/stats/xy/nonlinear-fit.ts modelSpec, not just the label):
 *  - "Sigmoidal, 4PL, X is concentration" is Helix sigmoidal-4pl-x.
 *  - "Sigmoidal, 4PL, X is log(concentration)" and the older
 *    "log(agonist)/log(inhibitor) vs. response -- Variable slope (four
 *    parameters)" are Helix sigmoidal-4pl-logx: Prism's
 *    Y=Bottom+(Top-Bottom)/(1+10^((LogEC50-X)*HillSlope)) is the same fit
 *    (LogIC50 vs LogEC50 is a name, not a different curve).
 *  - "One phase decay" is Helix one-phase-decay:
 *    Y=(Y0-Plateau)*exp(-K*X)+Plateau, terms Y0/Plateau/K.
 *  - "Line" is Helix line (lm y~x); "Second order polynomial (quadratic)"
 *    is Helix quadratic (lm y~x+I(x^2), terms B0/B1/B2).
 *  Anything else is unsupported, never guessed. Equation names are trimmed
 *  before lookup — Prism writes at least one with a trailing space
 *  ("Second order polynomial (quadratic) "). */
const NONLINEAR_MODELS: Record<string, NonlinearModel> = {
  "Sigmoidal, 4PL, X is concentration": "sigmoidal-4pl-x",
  "Sigmoidal, 4PL, X is log(concentration)": "sigmoidal-4pl-logx",
  "log(agonist) vs. response -- Variable slope (four parameters)": "sigmoidal-4pl-logx",
  "log(inhibitor) vs. response -- Variable slope (four parameters)": "sigmoidal-4pl-logx",
  "One phase decay": "one-phase-decay",
  Line: "line",
  "Second order polynomial (quadratic)": "quadratic",
};

const genId = (type: string) => `${type}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * A Prism title as plain text. Usually a string — but Prism sometimes
 * writes a rich-text object `{ string, version, formatting }` (seen on
 * dataset and X titles in real files). Anything else is "" and the
 * caller's fallback applies. Never returns "[object Object]".
 * A title can also carry Prism's multi-line break — a carriage return
 * inside the string ("BACE-I \r& DOX", "Nonlin fit of 15-HEPE-d5\r A").
 * Helix labels are single-line, so the break becomes one space (see
 * cleanText); the title is never left with a bare \r in it.
 */
export function plainTitle(value: unknown): string {
  if (typeof value === "string") return cleanText(value);
  if (value !== null && typeof value === "object") {
    const s = (value as { string?: unknown }).string;
    if (typeof s === "string") return cleanText(s);
  }
  return "";
}

/**
 * Prism writes multi-line labels with a carriage return as the line break
 * — inside a quoted CSV field ("BACE-I \r& DOX") or in a JSON title
 * string — and sometimes with a lone newline. Helix labels and cell
 * values are single-line: the break becomes one space, with surrounding
 * whitespace collapsed ("BACE-I & DOX", "WT (3 weeks)"). A value that is
 * only whitespace (a lone break, spaces) becomes "" — the caller turns
 * that into an empty cell, never a stray space. A bare \r anywhere else
 * would be a CSV line-ending leak, and the verifier's C8 check confirms
 * none survives.
 */
const cleanText = (value: string): string => {
  const collapsed = value.replace(/\s*(\r\n|\r|\n)\s*/g, " ");
  return collapsed.trim() === "" ? "" : collapsed;
};

/**
 * Parse a Prism date cell as UTC — one frame for every shape, so a
 * duration never depends on the machine's timezone. Prism writes naive
 * datetimes (no zone); reading them as UTC is the only reading that is
 * the same everywhere. The old code parsed ISO datetimes as local time
 * but date-only strings as UTC, so a 7-day span across a US DST change
 * came out 6.958 days under America/Los_Angeles.
 *
 * Shapes: ISO datetime ("2024-09-06 00:00:00", "2024-09-06T00:00:00",
 * optional seconds/fraction/trailing Z), date-only ("2024-09-06"), bare
 * year ("2024"), US "MM/DD/YYYY" ("12/17/2024"). A slash date whose
 * first component is over 12 can't be month-first, so it reads as
 * DD/MM ("13/02/2024" = 13 Feb); anything ambiguous stays month-first.
 * Anything else — including impossible dates like 2024-13-40 — is null.
 */
export function parsePrismDate(value: string | null): number | null {
  if (value === null || value === "") return null;
  const s = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(?:[Zz])?$/.exec(s);
  if (iso) {
    const y = Number(iso[1]);
    const mo = Number(iso[2]);
    const d = Number(iso[3]);
    const h = iso[4] === undefined ? 0 : Number(iso[4]);
    const mi = iso[5] === undefined ? 0 : Number(iso[5]);
    const sec = iso[6] === undefined ? 0 : Number(iso[6]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null;
    const ms = Date.UTC(y, mo - 1, d, h, mi, sec);
    const back = new Date(ms);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return ms;
  }
  const yearOnly = /^(\d{4})$/.exec(s);
  if (yearOnly) return Date.UTC(Number(yearOnly[1]), 0, 1);
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const y = Number(slash[3]);
    const [mo, d] = a > 12 ? [b, a] : [a, b];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const ms = Date.UTC(y, mo - 1, d);
    const back = new Date(ms);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return ms;
  }
  return null;
}

/** Days between two Prism date cells, as Helix stores numbers (text). */
export function daysBetween(start: string | null, end: string | null): string | null {
  const a = parsePrismDate(start);
  const b = parsePrismDate(end);
  if (a === null || b === null) return null;
  const days = (b - a) / 86_400_000;
  return Number.isInteger(days) ? String(days) : String(Number(days.toFixed(6)));
}

/**
 * Number text → Helix text. Which rule applies is decided once per file
 * (see the thousands-mode pre-pass in convertPrism): decimal mode reads
 * a single comma as a decimal point (`1,5` → `1.5`); thousands mode
 * strips commas from grouped numbers (`1,234,567` → `1234567`) and
 * leaves anything else — including a lone comma decimal like `45,5` —
 * as typed text, because in a thousands-locale file that comma is not a
 * decimal point the file means.
 */
const normalizeNumber = (value: string | null, thousandsMode = false): string | null => {
  if (value === null) return null;
  if (thousandsMode) {
    return /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(value) ? value.replace(/,/g, "") : value;
  }
  return /^-?\d+,\d+$/.test(value) ? value.replace(",", ".") : value;
};

export function subcolumnNames(title: string, dataFormat: string, count: number): string[] {
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

  // ── File-level comma rule (m6) ──
  // Prism records no locale, so the file's own values decide: if any
  // data.csv cell holds a number with two or more comma digit-groups
  // ("1,234,567"), commas are thousands separators file-wide and are
  // stripped; otherwise a single comma is a decimal separator ("45,5"
  // → "45.5"). The scan runs on PARSED cells — raw CSV text can't tell
  // a field separator from a thousands separator ("0,100,100" as text
  // is three cells, not one number).
  let thousandsMode = false;
  let thousandsExample = "";
  for (const path of Object.keys(zip.files)) {
    if (!/^data\/tables\/[^/]+\/data\.csv$/.test(path)) continue;
    const csvFile = zip.file(path);
    if (!csvFile) continue;
    const rows = parseCsv(await csvFile.async("string"));
    for (const row of rows) {
      for (const cell of row) {
        if (/^-?\d{1,3}(,\d{3}){2,}(\.\d+)?$/.test(cell)) {
          thousandsMode = true;
          thousandsExample = cell;
          break;
        }
      }
      if (thousandsMode) break;
    }
    if (thousandsMode) break;
  }
  if (thousandsMode) {
    issues.push({
      severity: "warning",
      message: `Commas look like thousands separators in this file (e.g. “${thousandsExample}”), so commas were stripped from numbers rather than read as decimal points.`,
    });
  }

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
      // A CSV shorter than the declared rows is padded with empty rows
      // (kept behaviour) — but say so, instead of inventing rows silently.
      if (csv.length < content.numberOfRows) {
        issues.push({
          severity: "warning",
          message: `${displayName}: the file holds ${csv.length} rows but content.json declares ${content.numberOfRows}; the missing rows were left empty.`,
        });
      }
      while (csv.length < content.numberOfRows) csv.push([]);
    }

    const format = table.format ?? "";
    const dataFormat = table.dataFormat ?? "";
    const setUids = table.dataSets ?? [];
    // ── Layout: resolve every dataset's subcolumn count BEFORE reading
    // any values (B1/B2/B3). A count is known from the dataset JSON
    // (replicates / replicate ranges / table replicatesCount); a missing
    // dataset is skipped by the table's replicatesCount (y_replicates)
    // or its dataFormat's fixed shape; anything still unknown is
    // inferred from content.json's numberOfColumns when it is the ONLY
    // unknown. Two or more unknowns, or an inference that doesn't fit
    // the declared width, refuses the table — never silently shift.
    const declaredCols =
      typeof content?.numberOfColumns === "number" ? content.numberOfColumns : (csv[0]?.length ?? 0);
    // The CSV's first column holds row titles only when the table has a
    // row-titles dataset. Never assume it from the format: column tables
    // usually have none, and XY tables sometimes have one (empty titles).
    const hasTitleCol = table.rowTitlesDataSet != null;
    const titleCols = hasTitleCol ? 1 : 0;

    const xSet = table.xDataSet
      ? await readJson<PrismDataSet>(`data/sets/${table.xDataSet}.json`)
      : null;
    const setJsons: (PrismDataSet | null)[] = [];
    for (const setUid of setUids) {
      setJsons.push(await readJson<PrismDataSet>(`data/sets/${setUid}.json`));
    }
    if (setJsons.every((s) => s === null)) {
      issues.push({ severity: "warning", message: `${displayName} holds no data columns. It was left out.` });
      continue;
    }
    // A present dataset's count is known unless its replicate ranges are
    // malformed — then it is unknown, never 0.
    const knownCount = (set: PrismDataSet): number | null =>
      replicateRangeProblems(set).length > 0 ? null : replicateCount(set, table);
    // A missing dataset's skip count, when the table itself determines it.
    const missingCount = (): number | null => {
      if (dataFormat === "y_replicates" && typeof table.replicatesCount === "number") {
        return table.replicatesCount;
      }
      return DATAFORMAT_SUBCOLUMNS[dataFormat] ?? null;
    };

    let xTitle: string | null = null;
    let xCount: number | null = 0;
    let xFormat = "";
    if (table.xDataSet) {
      if (xSet) {
        const t = plainTitle(xSet.title);
        xTitle = t !== "" ? t : "X";
        xCount = knownCount(xSet);
        xFormat = xSet.format ?? "";
      } else {
        // A missing X is always unknown: its count comes only from the
        // dims inference below, never from a 1-column guess.
        xTitle = "X";
        xCount = null;
      }
    }
    const counts: (number | null)[] = setJsons.map((s) => (s === null ? missingCount() : knownCount(s)));
    const knownSum = titleCols + (xCount ?? 0) + counts.reduce<number>((n, c) => n + (c ?? 0), 0);
    const unknownCount = (xCount === null ? 1 : 0) + counts.filter((c) => c === null).length;
    if (unknownCount >= 2) {
      issues.push({
        severity: "warning",
        message: `${displayName}: ${unknownCount} datasets have unknown column counts (missing JSON or malformed replicate ranges), so the table can't be laid out without guessing; it was left out.`,
      });
      continue;
    }
    if (unknownCount === 1) {
      const inferred = declaredCols - knownSum;
      if (inferred < 0) {
        issues.push({
          severity: "warning",
          message: `${displayName}: the known datasets already span ${knownSum} columns but the file declares only ${declaredCols}; the table was left out rather than guessing.`,
        });
        continue;
      }
      if (xCount === null) {
        xCount = inferred;
        issues.push({
          severity: "warning",
          message:
            inferred === 0
              ? `${displayName}: the X dataset “${table.xDataSet}” is missing; it spans no columns, so the table has no X column.`
              : `${displayName}: the X dataset “${table.xDataSet}” is missing; ${inferred} column(s) were read as X (inferred from the file's ${declaredCols} declared columns).`,
        });
      } else {
        const idx = counts.indexOf(null);
        counts[idx] = inferred;
        if (setJsons[idx] === null) {
          issues.push({
            severity: "warning",
            message:
              inferred === 0
                ? `${displayName}: dataset “${setUids[idx]}” is missing; it spans no columns, so nothing was skipped.`
                : `${displayName}: dataset “${setUids[idx]}” is missing; its ${inferred} column(s) were skipped (inferred from the file's ${declaredCols} declared columns).`,
          });
        } else {
          const problems = replicateRangeProblems(setJsons[idx] as PrismDataSet);
          issues.push({
            severity: "warning",
            message: `${displayName}: dataset “${setUids[idx]}” has malformed replicate ranges (${problems.join("; ")}); its column count was inferred from the file's ${declaredCols} declared columns (${inferred} column(s)).`,
          });
        }
      }
    } else {
      // No unknowns: warn about each missing dataset whose skip count
      // the table itself determined, so the skip is visible.
      setUids.forEach((uid, i) => {
        if (setJsons[i] !== null) return;
        const c = counts[i] as number;
        issues.push({
          severity: "warning",
          message: `${displayName}: dataset “${uid}” is missing; its ${c} column(s) were skipped (${dataFormat === "y_replicates" ? "the table's replicatesCount" : `the table's ${dataFormat} shape`}).`,
        });
      });
    }
    if (xCount === 0) xTitle = null;
    const hasXCol = xTitle !== null && (xCount as number) > 0;
    // Ordered layout entries (present or missing), each with its resolved
    // count — the emission loops walk this, advancing the CSV cursor by
    // every entry's count whether or not it becomes a Helix column.
    interface LayoutSet {
      set: PrismDataSet | null;
      count: number;
    }
    const layoutSets: LayoutSet[] = setUids.map((_, i) => ({ set: setJsons[i], count: counts[i] as number }));

    // Helix columns: [Title, ...data]. Each entry: name + values per row.
    interface ImportColumn {
      name: string;
      values: (string | null)[];
    }
    const columns: ImportColumn[] = [];
    // CSV column cursor: title col, then X subcolumns, then each dataset's
    // subcolumns. An empty CSV field is an empty cell (null in .hlx), not "".
    // A field that is only whitespace (or only a line break) is empty too.
    let cursor = 0;
    const csvCol = (i: number) =>
      csv.map((r) => {
        const v = r[i];
        if (v === "" || v === undefined) return null;
        const cleaned = cleanText(v);
        return cleaned === "" ? null : normalizeNumber(cleaned, thousandsMode);
      });
    if (hasTitleCol) cursor++; // row titles are read separately below
    if (hasXCol) {
      const xCols: (string | null)[][] = [];
      for (let i = 0; i < (xCount as number); i++) {
        xCols.push(csvCol(cursor));
        cursor++;
      }
      if ((xCount as number) === 1) {
        columns.push({ name: xTitle as string, values: xCols[0] });
      } else if (format === "survival" && xFormat.startsWith("date") && (xCount as number) >= 2) {
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
        // The durations are days only when the file says Days — anything
        // else (Hours, Weeks, …) is a different time scale, so say so.
        const xUnits = xSet?.dateTimeConversion?.units;
        if (xUnits !== undefined && xUnits !== "Days") {
          issues.push({
            severity: "warning",
            message: `${displayName}: the X dates use “${xUnits}” units, but the durations were converted to days; check the time scale before using them.`,
          });
        }
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
      groups = layoutSets.filter((e) => e.set !== null).length;
      replicates = table.replicatesCount ?? Math.max(...layoutSets.filter((e) => e.set !== null).map((e) => e.count));
      for (const entry of layoutSets) {
        if (entry.set === null) {
          cursor += entry.count;
          continue;
        }
        const group = plainTitle(entry.set.title) || "Group";
        for (let i = 0; i < entry.count; i++) {
          columns.push({ name: `${group}:Y${i + 1}`, values: csvCol(cursor) });
          cursor++;
        }
      }
    } else {
      for (const entry of layoutSets) {
        if (entry.set === null) {
          cursor += entry.count;
          continue;
        }
        const names = subcolumnNames(plainTitle(entry.set.title), dataFormat, entry.count);
        for (let i = 0; i < entry.count; i++) {
          columns.push({ name: names[i], values: csvCol(cursor) });
          cursor++;
        }
      }
    }

    const rowTitles = hasTitleCol ? csv.map((r) => (r[0] === "" || r[0] === undefined ? null : cleanText(r[0]) || null)) : [];
    const hasRowTitles = rowTitles.some((v) => v !== null && v !== "");
    const rowCount = Math.max(0, ...columns.map((c) => c.values.length), rowTitles.length);
    if (rowCount === 0 || columns.length === 0) {
      issues.push({ severity: "warning", message: `${displayName} holds no data. It was left out.` });
      continue;
    }
    // CSV columns the converter consumed: title + every X subcolumn + every
    // dataset subcolumn — from the layout, not from the Helix columns
    // (missing datasets consume CSV columns without becoming Helix ones,
    // and multi-subcolumn X collapses into one Helix column).
    const consumedCols = titleCols + (xCount as number) + layoutSets.reduce((n, e) => n + e.count, 0);
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
      const equation = (params?.content?.model?.equation?.name ?? "").trim();
      const model = NONLINEAR_MODELS[equation];
      if (!model) {
        report.analysesUnsupported.push(`${name} (nonlinear model “${equation}” — not yet supported in Helix)`);
        continue;
      }
      const inputs = sheet.inputDataSets ?? [];
      if (inputs.length === 0) {
        issues.push({
          severity: "warning",
          message: `Analysis “${name}” (nonlinear model “${equation}”) has no input datasets; it was left out.`,
        });
        continue;
      }
      for (const ds of inputs) {
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
    const m = /^data\/sheets\/([^/]+)\/sheet\.json$/i.exec(path);
    if (m && !listedSheets.has(m[1].toUpperCase()) && !listedSheets.has(m[1])) report.orphanSheetsIgnored++;
  }
  // Tables referenced by ANY sheet in the zip (listed or orphan) count as
  // referenced; only tables no sheet points at are unreferenced.
  const referencedTables = new Set<string>();
  for (const path of Object.keys(zip.files)) {
    const m = /^data\/sheets\/([^/]+)\/sheet\.json$/i.exec(path);
    if (!m) continue;
    const sheet = await readJson<PrismDataSheet>(path);
    const uid = (sheet?.table as { uid?: string } | undefined)?.uid;
    if (uid) referencedTables.add(uid.toUpperCase());
  }
  for (const path of Object.keys(zip.files)) {
    const m = /^data\/tables\/([^/]+)\/content\.json$/i.exec(path);
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
