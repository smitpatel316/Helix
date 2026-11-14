// Import GraphPad Prism `.pzfx` files (the XML format Prism 6 and later write).
//
// Clean-room: written from the file format as documented by the open-source
// `pzfx` (R, MIT) and `pypzfx` (Python, MIT) readers and their `.pzfx` test
// files — never from Prism's own code. Only the data tables are in the file's
// readable XML: analyses, graphs and layouts live in a compressed `<Template>`
// blob Titer doesn't read, so an import brings in the tables only; analyses
// and graphs are rebuilt in Titer.
//
// What maps where (Prism `TableType` → Titer table):
//   OneWay      → Column    (each Y column is a group)
//   TwoWay      → Grouped   when the Y values are replicates (groups = Y columns,
//                 replicates = subcolumns); otherwise Column, with the summary
//                 subcolumns named (MEAN, SD, N…) and a warning — summary values
//                 are not raw replicates, so they must not be analysed as if they were.
//                 An empty or missing YFormat is never assumed to be replicates:
//                 it imports as Column with a warning (FF-F7 — a mean/SD/N table
//                 with no YFormat would otherwise be analysed as raw replicates,
//                 giving wrong F/p/N).
//   XY          → XY        (X, then one Y series per subcolumn)
//   Survival    → Survival  (X = time, Y = event codes 1/0 per group; the survival
//                 graph and the survival analysis apply to it)
//   Contingency → Contingency
//   PartsOfWhole→ Column    (one Y column, rows named by the row titles)
//   Nested      → NO verified marker (see below): a Prism nested table is
//                 one of Prism's eight formats (Prism 8+), with replicates
//                 stacked into subcolumns, but no public .pzfx file or reader
//                 shows a distinct TableType/YFormat value for it — checked
//                 2026-11-10: no nested file in test-corpus/ or tests/testdata/,
//                 and the open-source readers (R pzfx 0.3.1, pypzfx) know no
//                 "Nested" TableType. A OneWay/replicates table therefore
//                 imports as Column (today's behaviour, unchanged) and the
//                 user converts it to Nested by hand — do NOT auto-convert
//                 OneWay/replicates to nested on a heuristic, a plain
//                 replicates Column table is far more common than a nested one.
//                 If a distinct marker is ever verified, map it here directly.
// A struck-through value (`<d Excluded="1">`) becomes a Titer excluded cell.
// A `.prism` file (Prism 10's newer format) is not `.pzfx` and is not imported.

import type { ProjectFilePayload } from "./project-file";
import type { ProjectNode, TableData, TableType } from "../store/types";

export interface PzfxIssue {
  severity: "error" | "warning";
  message: string;
}

export interface PzfxImport {
  project: ProjectFilePayload;
  /** Tables imported, in file order. */
  tables: string[];
  issues: PzfxIssue[];
}

// ── A small XML reader ───────────────────────────────────────────────────
// Only what a `.pzfx` file needs: elements, attributes, text, comments, CDATA
// and entities. No dependency, so it runs in the app and in the tests alike.

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Text directly inside this element (formatting children aside). */
  text: string;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, body: string) => {
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return '"';
    if (body === "apos") return "'";
    const code = body.startsWith("#x") ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

function parseXml(text: string): XmlNode {
  let i = 0;
  const n = text.length;
  const fail = (why: string): never => {
    throw new Error(`Not a valid .pzfx file (${why}).`);
  };
  const skipMisc = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text.startsWith("<?", i)) {
        const end = text.indexOf("?>", i + 2);
        if (end < 0) fail("unclosed processing instruction");
        i = end + 2;
      } else if (text.startsWith("<!--", i)) {
        const end = text.indexOf("-->", i + 4);
        if (end < 0) fail("unclosed comment");
        i = end + 3;
      } else if (text.startsWith("<!DOCTYPE", i)) {
        const end = text.indexOf(">", i);
        if (end < 0) fail("unclosed doctype");
        i = end + 1;
      } else break;
    }
  };
  const parseElement = (): XmlNode => {
    // At `<`.
    if (text[i] !== "<") fail("expected an element");
    i++;
    const tag = /^[A-Za-z_][\w:.-]*/.exec(text.slice(i))?.[0];
    if (tag === undefined) throw new Error("Not a valid .pzfx file (bad element name).");
    i += tag.length;
    const attrs: Record<string, string> = {};
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text.startsWith("/>", i)) {
        i += 2;
        return { tag, attrs, children: [], text: "" };
      }
      if (text[i] === ">") {
        i++;
        break;
      }
      if (i >= n) fail("unclosed tag");
      const name = /^[A-Za-z_][\w:.-]*/.exec(text.slice(i))?.[0];
      if (name === undefined) throw new Error("Not a valid .pzfx file (bad attribute name).");
      i += name.length;
      while (i < n && /\s/.test(text[i])) i++;
      let value = "";
      if (text[i] === "=") {
        i++;
        while (i < n && /\s/.test(text[i])) i++;
        const quote = text[i];
        if (quote !== '"' && quote !== "'") fail("bad attribute value");
        i++;
        const end = text.indexOf(quote, i);
        if (end < 0) fail("unclosed attribute value");
        value = decodeEntities(text.slice(i, end));
        i = end + 1;
      }
      attrs[name] = value;
    }
    const children: XmlNode[] = [];
    let textParts = "";
    for (;;) {
      if (i >= n) fail(`unclosed <${tag}>`);
      if (text.startsWith(`</${tag}`, i)) {
        const end = text.indexOf(">", i);
        if (end < 0) fail("unclosed closing tag");
        i = end + 1;
        return { tag, attrs, children, text: decodeEntities(textParts) };
      }
      if (text.startsWith("<!--", i)) {
        const end = text.indexOf("-->", i + 4);
        if (end < 0) fail("unclosed comment");
        i = end + 3;
      } else if (text.startsWith("<![CDATA[", i)) {
        const end = text.indexOf("]]>", i + 9);
        if (end < 0) fail("unclosed CDATA section");
        textParts += text.slice(i + 9, end);
        i = end + 3;
      } else if (text[i] === "<") {
        children.push(parseElement());
      } else {
        const next = text.indexOf("<", i);
        textParts += text.slice(i, next < 0 ? n : next);
        i = next < 0 ? n : next;
      }
    }
  };
  skipMisc();
  const root = parseElement();
  skipMisc();
  return root;
}

/** An element's text, including any formatting children it wraps (`<Title>` may
 *  hold a `<TextAlign>`). */
const childText = (node: XmlNode): string => {
  let out = node.text;
  for (const child of node.children) out += childText(child);
  return out.trim();
};

const childrenNamed = (node: XmlNode, tag: string) => node.children.filter((c) => c.tag === tag);
const firstChild = (node: XmlNode, tag: string) => childrenNamed(node, tag)[0];

// ── Subcolumns ───────────────────────────────────────────────────────────

/** One subcolumn's values, as typed, with the struck-through (excluded) rows. */
interface Subcolumn {
  values: (string | null)[];
  excluded: Set<number>;
}

function readSubcolumn(node: XmlNode): Subcolumn {
  const values: (string | null)[] = [];
  const excluded = new Set<number>();
  for (const d of childrenNamed(node, "d")) {
    const value = childText(d);
    values.push(value === "" ? null : value);
    if (d.attrs["Excluded"] === "1") excluded.add(values.length - 1);
  }
  return { values, excluded };
}

/** A column's title and subcolumns. */
interface PzfxColumn {
  title: string;
  subcolumns: Subcolumn[];
}

function readColumn(node: XmlNode): PzfxColumn {
  const titleNode = firstChild(node, "Title");
  return {
    title: titleNode ? childText(titleNode) : "",
    subcolumns: childrenNamed(node, "Subcolumn").map(readSubcolumn),
  };
}

// How a column's subcolumns are named in the imported table, by its format.
const SUBCOLUMN_SUFFIXES: Record<string, string[]> = {
  replicates: [],
  SDN: ["_MEAN", "_SD", "_N"],
  SEN: ["_MEAN", "_SEM", "_N"],
  CVN: ["_MEAN", "_CV", "_N"],
  SD: ["_MEAN", "_SD"],
  SE: ["_MEAN", "_SE"],
  CV: ["_MEAN", "_CV"],
  "low-high": ["_MEAN", "_PLUSERROR", "_MINUSERROR"],
  "upper-lower-limits": ["_MEAN", "_UPPERLIMIT", "_LOWERLIMIT"],
};

/** A `<d>` value that proves the file's decimal separator is a comma: a comma
 *  decimal whose fraction is not exactly three digits (`0,5`, `3,75`,
 *  `0,9375`), or a comma decimal with an exponent (`4,096e+007`). A `N,NNN`
 *  value alone proves nothing — it is a decimal (`1,875` = 1.875 in the real
 *  SaturationBinding.pzfx) as readily as a thousands separator. */
const COMMA_DECIMAL_EVIDENCE = /^-?\d+,\d{1,2}$|^-?\d+,\d{4,}$|^-?\d+,\d+[eE][+-]?\d+$/;
/** A `<d>` value that proves the file's decimal separator is a dot: a dot
 *  decimal (`1.5`, `8887.`, `5.22929500342231`), exponent included. */
const DOT_DECIMAL_EVIDENCE = /^-?\d+\.\d*([eE][+-]?\d+)?$|^-?\.\d+([eE][+-]?\d+)?$/;
/** A thousands-grouped value: `1,000`, `1,000,000`, `1,000.5` — groups of
 *  exactly three digits after the first comma. */
const GROUPED_NUMBER = /^-?\d{1,3}(,\d{3})+(\.\d+)?([eE][+-]?\d+)?$/;

/** Every `<d>` text in the parsed file (data values and row titles alike). */
function allDValues(node: XmlNode, out: string[] = []): string[] {
  if (node.tag === "d") out.push(childText(node));
  for (const child of node.children) allDValues(child, out);
  return out;
}

/**
 * Whether this file writes thousands separators (`1,000` = 1000). Decided
 * from the file, never from one string alone: dot-decimal evidence anywhere
 * in the file (`1.5`, `8887.`) with no comma-decimal evidence (`0,5`,
 * `4,096e+007`) means the file's decimals use dots, so a comma can only be
 * a grouping separator. With no evidence either way — or any comma-decimal
 * evidence at all — commas stay decimals: that is the only reading any real
 * .pzfx file has yet shown (Prism writes large values ungrouped in both
 * locales: `8887.`, `5120000`), and a `N,NNN` string in a real file is a
 * decimal (`1,875`, `4,096` in the binding corpora).
 */
function usesGroupingSeparators(root: XmlNode): boolean {
  let commaDecimal = false;
  let dotDecimal = false;
  for (const value of allDValues(root)) {
    if (COMMA_DECIMAL_EVIDENCE.test(value)) commaDecimal = true;
    else if (DOT_DECIMAL_EVIDENCE.test(value)) dotDecimal = true;
  }
  return dotDecimal && !commaDecimal;
}

/**
 * `1,5` (comma decimal) → `1.5`; anything else stays as typed — except in a
 * file whose own numbers prove dot decimals, where a grouped `1,000` is a
 * thousands separator, not a decimal comma, and the commas are stripped
 * (`1,000` → `1000`) instead of turning it into `1.000` (a 1000× error).
 * A bare `1,5` in such a file still becomes `1.5`: only the grouped shape
 * is reinterpreted, so nothing else changes.
 */
function normalizeNumber(value: string | null, groupingSeparators: boolean): string | null {
  if (value === null) return null;
  if (groupingSeparators && GROUPED_NUMBER.test(value)) return value.replace(/,/g, "");
  if (/^-?\d+,\d+$/.test(value)) return value.replace(",", ".");
  return value;
}

function subcolumnNames(title: string, format: string, count: number): string[] {
  const base = title === "" ? "Y" : title;
  if (count === 1) return [base];
  const suffixes = SUBCOLUMN_SUFFIXES[format];
  if (suffixes && suffixes.length === count) return suffixes.map((s) => `${base}${s}`);
  return Array.from({ length: count }, (_, i) => `${base}_${i + 1}`);
}

// ── One table ────────────────────────────────────────────────────────────

interface ImportedTable {
  node: ProjectNode;
  warnings: string[];
}

const genId = (type: string) => `${type}_${Math.random().toString(36).slice(2, 10)}`;

function importTable(table: XmlNode, issues: PzfxIssue[], groupingSeparators: boolean): ImportedTable | null {
  const warnings: string[] = [];
  const titleNode = firstChild(table, "Title");
  const name = titleNode ? childText(titleNode) : "";
  const tableType = table.attrs["TableType"] ?? "";
  const xFormat = table.attrs["XFormat"] ?? "";
  const yFormat = table.attrs["YFormat"] ?? "";
  const displayName = name === "" ? "Untitled table" : `“${name}”`;

  if (table.tag === "HugeTable") {
    issues.push({
      severity: "warning",
      message: `${displayName} is a HugeTable, which Titer can't import yet. It was left out.`,
    });
    return null;
  }

  const rowTitles = firstChild(table, "RowTitlesColumn");
  const rowTitleValues = rowTitles ? readColumn(rowTitles).subcolumns[0]?.values ?? [] : [];
  let hasRowTitles = rowTitleValues.some((v) => v !== null && v !== "");

  const xColumns = childrenNamed(table, "XColumn").map(readColumn);
  const xAdvanced = firstChild(table, "XAdvancedColumn");
  const yColumns = childrenNamed(table, "YColumn").map(readColumn);
  if (yColumns.length === 0) {
    issues.push({ severity: "warning", message: `${displayName} holds no data columns. It was left out.` });
    return null;
  }

  // The X series: its first subcolumn is X; a second (XFormat "error") is the X
  // error, kept as its own series so no data is silently dropped.
  let xValues: (string | null)[] = [];
  let xErrorValues: (string | null)[] | null = null;
  let xExcluded: Set<number> = new Set();
  let xErrorExcluded: Set<number> = new Set();
  let xName = "X";
  if (xColumns.length > 0) {
    const x = xColumns[0];
    xName = x.title === "" ? "X" : x.title;
    xValues = x.subcolumns[0]?.values ?? [];
    xExcluded = x.subcolumns[0]?.excluded ?? new Set();
    if (x.subcolumns.length > 1) {
      xErrorValues = x.subcolumns[1].values;
      xErrorExcluded = x.subcolumns[1].excluded ?? new Set();
      warnings.push(
        `${displayName}: the X error values were imported as a “${xName} error” series — Titer XY tables hold one X column.`,
      );
    }
  }
  // A date X whose dates survive import: as row titles when the table has
  // none of its own, else in a dedicated column next to X — never dropped.
  let dateColumn: { name: string; values: (string | null)[]; excluded: Set<number> } | null = null;
  if (xFormat === "date") {
    if (xAdvanced) {
      const dateSub = readColumn(xAdvanced).subcolumns[0];
      const dates = dateSub?.values ?? [];
      const dateExcluded = dateSub?.excluded ?? new Set<number>();
      const hasAnyDate = dates.some((v) => v !== null && v !== "");
      let datesKeptAsRowTitles = false;
      if (!hasRowTitles) {
        // The character dates name the rows, as Prism shows them.
        for (let r = 0; r < dates.length; r++) {
          if (dates[r] !== null) {
            rowTitleValues[r] = dates[r];
            datesKeptAsRowTitles = true;
          }
        }
      } else if (hasAnyDate) {
        // The row titles are the rows' names, so the dates get their own
        // column instead of being dropped: the numeric X stays the X axis
        // (years since the first date, as Prism stores it) and the dates
        // sit beside it as text, which analyses and graphs skip. A
        // struck-through date stays struck through: its Excluded marker
        // rides along, the same as the X / X error columns (#20).
        dateColumn = { name: `${xName} (date)`, values: dates, excluded: dateExcluded };
      }
      if (datesKeptAsRowTitles) {
        warnings.push(`${displayName}: the X values are dates; the dates were kept as row titles.`);
      } else if (dateColumn) {
        warnings.push(
          `${displayName}: the X values are dates; the existing row titles were kept and the dates were kept in a “${dateColumn.name}” column.`,
        );
      } else {
        warnings.push(`${displayName}: the X values are dates; they were imported as numbers.`);
      }
      // The dates above may have filled previously-empty row titles.
      hasRowTitles = rowTitleValues.some((v) => v !== null && v !== "");
    } else {
      warnings.push(`${displayName}: the X values are dates; they were imported as numbers.`);
    }
  }

  // Titer columns: [Title, ...data]. Each entry: its name, values per row, and
  // which rows are excluded in it.
  interface ImportColumn {
    name: string;
    values: (string | null)[];
    excluded: Set<number>;
  }
  const columns: ImportColumn[] = [];
  const pushColumn = (name: string, sub: Subcolumn) => {
    columns.push({ name, values: sub.values.map((v) => normalizeNumber(v, groupingSeparators)), excluded: sub.excluded });
  };

  let titerType: TableType;
  let groups: number | undefined;
  let replicates: number | undefined;
  // Only an explicit "replicates" YFormat is replicates. An empty or missing
  // YFormat must not default to replicates: a summary table (mean/SD/N) whose
  // YFormat wasn't recorded would otherwise import as grouped replicates,
  // and a group comparison would treat the means as raw values (FF-F7).
  const isGroupedReplicates =
    tableType === "TwoWay" && yFormat === "replicates";
  if (tableType === "OneWay" || tableType === "PartsOfWhole" || tableType === "Contingency") {
    titerType = tableType === "Contingency" ? "contingency" : "column";
    for (const y of yColumns) {
      const names = subcolumnNames(y.title, yFormat, y.subcolumns.length);
      y.subcolumns.forEach((sub, i) => pushColumn(names[i], sub));
      if (y.subcolumns.length > 1 && yFormat === "replicates") {
        warnings.push(
          `${displayName}: “${y.title}” holds replicate subcolumns; each replicate was imported as its own column.`,
        );
      }
    }
  } else if (tableType === "TwoWay" && isGroupedReplicates) {
    titerType = "grouped";
    const counts = yColumns.map((y) => y.subcolumns.length);
    groups = yColumns.length;
    replicates = Math.max(...counts);
    // A grouped table's columns are "Group:Y1"…, so a group name must be
    // unique and colon-free — seriesKeyOf splits at the first ":" and
    // regroupTable rebuilds exactly "Group:Y1"…"Group:Y<replicates>" on
    // reload. Before this fix untitled Y columns all became "Group"
    // (duplicate "Group:Y1" columns, renamed "Group:Y1 2" by FF-F9 but
    // still dropped on reload), a title like "1:10" became "1:10:Y1"
    // (group "1", its data wiped on reload), and a ragged Y column left
    // its group short of subcolumns. So: sanitize ":", dedupe the group
    // names, and pad every group to `replicates` subcolumns.
    const usedGroups = new Set<string>();
    const renamedGroups: string[] = [];
    const rowLen = Math.max(
      0,
      ...yColumns.flatMap((y) => y.subcolumns.map((s) => s.values.length)),
      rowTitleValues.length,
    );
    const emptySubcolumn = (): Subcolumn => ({ values: Array<string | null>(rowLen).fill(null), excluded: new Set() });
    const reps = replicates;
    yColumns.forEach((y) => {
      const raw = y.title === "" ? "Group" : y.title;
      const base = raw.replace(/:/g, "-");
      let group = base;
      for (let n = 2; usedGroups.has(group); n++) group = `${base} ${n}`;
      usedGroups.add(group);
      if (group !== raw) renamedGroups.push(`“${raw}” → “${group}”`);
      const subs = [...y.subcolumns];
      while (subs.length < reps) subs.push(emptySubcolumn());
      subs.forEach((sub, i) => pushColumn(`${group}:Y${i + 1}`, sub));
    });
    if (renamedGroups.length > 0) {
      warnings.push(
        `${displayName}: group names must be unique and can't contain “:”, so they were renamed (${renamedGroups.join(", ")}) — the data itself is unchanged.`,
      );
    }
  } else if (tableType === "TwoWay") {
    // Summary values (mean, SD, N…) — not raw replicates. Keep them, named, and
    // say so: running a group comparison on them as if they were replicates
    // would be wrong.
    titerType = "column";
    for (const y of yColumns) {
      const names = subcolumnNames(y.title, yFormat, y.subcolumns.length);
      y.subcolumns.forEach((sub, i) => pushColumn(names[i], sub));
    }
    // An empty YFormat records no format at all, so the subcolumns can't be
    // named as summaries — say so plainly instead of guessing "mean and error".
    warnings.push(
      yFormat === ""
        ? `${displayName}: the Y format wasn't recorded (empty YFormat), so the subcolumns were imported as named columns, not replicates — don't run group comparisons on them as if they were.`
        : `${displayName}: the values are summaries (${yFormat}), not raw replicates — don't run group comparisons on them as if they were.`,
    );
  } else if (tableType === "XY" || tableType === "Survival") {
    titerType = tableType === "Survival" ? "survival" : "xy";
    if (xValues.length > 0 || xColumns.length > 0) {
      // A struck-through X value (`Excluded="1"`) stays excluded: readSubcolumn
      // already parsed it into the X subcolumn's excluded set, and dropping it
      // here would turn an excluded point into active data.
      columns.push({ name: xName, values: xValues.map((v) => normalizeNumber(v, groupingSeparators)), excluded: xExcluded });
      if (xErrorValues) {
        columns.push({ name: `${xName} error`, values: xErrorValues.map((v) => normalizeNumber(v, groupingSeparators)), excluded: xErrorExcluded });
      }
    }
    for (const y of yColumns) {
      const names = subcolumnNames(y.title, yFormat, y.subcolumns.length);
      y.subcolumns.forEach((sub, i) => pushColumn(names[i], sub));
    }
    if (tableType === "Survival") {
      warnings.push(
        `${displayName}: imported as a Survival table (time in X, event codes 1 = event, 0 = censored in each group) — the survival analysis and graph apply to it.`,
      );
    }
  } else {
    titerType = "column";
    for (const y of yColumns) {
      const names = subcolumnNames(y.title, yFormat, y.subcolumns.length);
      y.subcolumns.forEach((sub, i) => pushColumn(names[i], sub));
    }
    warnings.push(`${displayName}: table type “${tableType}” isn't one Titer knows; it was imported as a Column table.`);
  }

  if (dateColumn) {
    // Next to X for XY/Survival (after X and its error, if any); first among
    // the data columns otherwise, since those types drop X entirely.
    let at = 0;
    if (titerType === "xy" || titerType === "survival") {
      at = Math.min((xColumns.length > 0 ? 1 : 0) + (xErrorValues ? 1 : 0), columns.length);
    }
    let name = dateColumn.name;
    for (let n = 2; columns.some((c) => c.name === name); n++) name = `${dateColumn.name} ${n}`;
    columns.splice(at, 0, { ...dateColumn, name });
  }

  // FF-F9: Prism lets two Y columns share a title (and an X title can match
  // a Y title), but Titer resolves a column by name with
  // `data.columns.indexOf(name)` — the first match wins, so an analysis
  // naming the second duplicate silently ran on the first column's data.
  // Rename later duplicates ("A" → "A 2", "A 3", …) so every imported
  // column has a distinct name and each keeps its own data. A duplicate
  // that already ends in " N" renumbers from its stem ("Control 2" →
  // "Control 3"), so renames never stack into "Control 2 2".
  const seenNames = new Set<string>(["Title"]);
  const renamed: string[] = [];
  for (const column of columns) {
    if (!seenNames.has(column.name)) {
      seenNames.add(column.name);
      continue;
    }
    const stem = column.name.replace(/ \d+$/, "");
    let n = 2;
    let renamedName = `${stem} ${n}`;
    while (seenNames.has(renamedName)) {
      n++;
      renamedName = `${stem} ${n}`;
    }
    renamed.push(`“${column.name}” → “${renamedName}”`);
    column.name = renamedName;
    seenNames.add(renamedName);
  }
  if (renamed.length > 0) {
    warnings.push(
      `${displayName}: duplicate column names were renamed so each column keeps its own data (${renamed.join(', ')}).`,
    );
  }

  const rowCount = Math.max(0, ...columns.map((c) => c.values.length), rowTitleValues.length);
  if (rowCount === 0 || columns.length === 0) {
    issues.push({ severity: "warning", message: `${displayName} holds no data. It was left out.` });
    return null;
  }
  const data: TableData = {
    columns: ["Title", ...columns.map((c) => c.name)],
    rows: Array.from({ length: rowCount }, (_, r) => [
      hasRowTitles ? (rowTitleValues[r] ?? null) : null,
      ...columns.map((c) => c.values[r] ?? null),
    ]),
    ...(groups !== undefined && replicates !== undefined ? { groups, replicates } : {}),
    excluded: Array.from(
      new Set(
        columns.flatMap((c, ci) => [...c.excluded].map((r) => `${r},${ci + 1}`)),
      ),
    ),
  };
  if (data.excluded!.length === 0) delete data.excluded;

  const node: ProjectNode = {
    id: genId("table"),
    type: "table",
    name: name === "" ? "Imported table" : name,
    parentId: null,
    tableType: titerType,
    data,
  };
  return { node, warnings };
}

// ── The file ─────────────────────────────────────────────────────────────

export function parsePzfx(text: string): PzfxImport {
  let root: XmlNode;
  try {
    root = parseXml(text);
  } catch (err) {
    return {
      project: { nodes: {}, rootOrder: [], childOrder: {}, activeNodeId: null },
      tables: [],
      issues: [{ severity: "error", message: err instanceof Error ? err.message : "Not a valid .pzfx file." }],
    };
  }
  if (root.tag !== "GraphPadPrismFile") {
    return {
      project: { nodes: {}, rootOrder: [], childOrder: {}, activeNodeId: null },
      tables: [],
      issues: [{ severity: "error", message: "This file isn't a GraphPad Prism .pzfx file." }],
    };
  }
  const issues: PzfxIssue[] = [];
  const tables: string[] = [];
  const nodes: Record<string, ProjectNode> = {};
  const rootOrder: string[] = [];
  const childOrder: Record<string, string[]> = {};
  // Tables live under the root (TableSequence only lists them); HugeTables too.
  const groupingSeparators = usesGroupingSeparators(root);
  const tableNodes = root.children.filter((c) => c.tag === "Table" || c.tag === "HugeTable");
  for (const tableNode of tableNodes) {
    const imported = importTable(tableNode, issues, groupingSeparators);
    if (!imported) continue;
    nodes[imported.node.id] = imported.node;
    rootOrder.push(imported.node.id);
    childOrder[imported.node.id] = [];
    tables.push(imported.node.name);
    for (const warning of imported.warnings) issues.push({ severity: "warning", message: warning });
  }
  if (tables.length === 0 && issues.every((i) => i.severity === "warning")) {
    issues.unshift({ severity: "error", message: "No tables in this file could be imported." });
  }
  return {
    project: { nodes, rootOrder, childOrder, activeNodeId: rootOrder[0] ?? null },
    tables,
    issues,
  };
}
