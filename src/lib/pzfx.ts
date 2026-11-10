// Import GraphPad Prism `.pzfx` files (the XML format Prism 6 and later write).
//
// Clean-room: written from the file format as documented by the open-source
// `pzfx` (R, MIT) and `pypzfx` (Python, MIT) readers and their `.pzfx` test
// files — never from Prism's own code. Only the data tables are in the file's
// readable XML: analyses, graphs and layouts live in a compressed `<Template>`
// blob Helix doesn't read, so an import brings in the tables only; analyses
// and graphs are rebuilt in Helix.
//
// What maps where (Prism `TableType` → Helix table):
//   OneWay      → Column    (each Y column is a group)
//   TwoWay      → Grouped   when the Y values are replicates (groups = Y columns,
//                 replicates = subcolumns); otherwise Column, with the summary
//                 subcolumns named (MEAN, SD, N…) and a warning — summary values
//                 are not raw replicates, so they must not be analysed as if they were
//   XY          → XY        (X, then one Y series per subcolumn)
//   Survival    → XY        (X = time, Y = event codes 1/0 per group; the survival
//                 graph and the log-rank analysis apply to it)
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
// A struck-through value (`<d Excluded="1">`) becomes a Helix excluded cell.
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

/** `1,5` (comma decimal) → `1.5`; anything else stays as typed. */
function normalizeNumber(value: string | null): string | null {
  if (value !== null && /^-?\d+,\d+$/.test(value)) return value.replace(",", ".");
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

function importTable(table: XmlNode, issues: PzfxIssue[]): ImportedTable | null {
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
      message: `${displayName} is a HugeTable, which Helix can't import yet. It was left out.`,
    });
    return null;
  }

  const rowTitles = firstChild(table, "RowTitlesColumn");
  const rowTitleValues = rowTitles ? readColumn(rowTitles).subcolumns[0]?.values ?? [] : [];
  const hasRowTitles = rowTitleValues.some((v) => v !== null && v !== "");

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
  let xName = "X";
  if (xColumns.length > 0) {
    const x = xColumns[0];
    xName = x.title === "" ? "X" : x.title;
    xValues = x.subcolumns[0]?.values ?? [];
    if (x.subcolumns.length > 1) {
      xErrorValues = x.subcolumns[1].values;
      warnings.push(
        `${displayName}: the X error values were imported as a “${xName} error” series — Helix XY tables hold one X column.`,
      );
    }
  }
  if (xFormat === "date") {
    if (xAdvanced) {
      const dates = readColumn(xAdvanced).subcolumns[0]?.values ?? [];
      if (!hasRowTitles) {
        // The character dates name the rows, as Prism shows them.
        for (let r = 0; r < dates.length; r++) {
          if (dates[r] !== null) rowTitleValues[r] = dates[r];
        }
      }
      warnings.push(`${displayName}: the X values are dates; the dates were kept as row titles.`);
    } else {
      warnings.push(`${displayName}: the X values are dates; they were imported as numbers.`);
    }
  }

  // Helix columns: [Title, ...data]. Each entry: its name, values per row, and
  // which rows are excluded in it.
  interface ImportColumn {
    name: string;
    values: (string | null)[];
    excluded: Set<number>;
  }
  const columns: ImportColumn[] = [];
  const pushColumn = (name: string, sub: Subcolumn) => {
    columns.push({ name, values: sub.values.map(normalizeNumber), excluded: sub.excluded });
  };

  let helixType: TableType;
  let groups: number | undefined;
  let replicates: number | undefined;
  const isGroupedReplicates =
    tableType === "TwoWay" && (yFormat === "replicates" || yFormat === "");
  if (tableType === "OneWay" || tableType === "PartsOfWhole" || tableType === "Contingency") {
    helixType = tableType === "Contingency" ? "contingency" : "column";
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
    helixType = "grouped";
    const counts = yColumns.map((y) => y.subcolumns.length);
    groups = yColumns.length;
    replicates = Math.max(...counts);
    yColumns.forEach((y) => {
      const group = y.title === "" ? "Group" : y.title;
      y.subcolumns.forEach((sub, i) => pushColumn(`${group}:Y${i + 1}`, sub));
    });
  } else if (tableType === "TwoWay") {
    // Summary values (mean, SD, N…) — not raw replicates. Keep them, named, and
    // say so: running a group comparison on them as if they were replicates
    // would be wrong.
    helixType = "column";
    for (const y of yColumns) {
      const names = subcolumnNames(y.title, yFormat, y.subcolumns.length);
      y.subcolumns.forEach((sub, i) => pushColumn(names[i], sub));
    }
    warnings.push(
      `${displayName}: the values are summaries (${yFormat === "" ? "mean and error" : yFormat}), not raw replicates — don't run group comparisons on them as if they were.`,
    );
  } else if (tableType === "XY" || tableType === "Survival") {
    helixType = "xy";
    if (xValues.length > 0 || xColumns.length > 0) {
      columns.push({ name: xName, values: xValues.map(normalizeNumber), excluded: new Set() });
      if (xErrorValues) {
        columns.push({ name: `${xName} error`, values: xErrorValues.map(normalizeNumber), excluded: new Set() });
      }
    }
    for (const y of yColumns) {
      const names = subcolumnNames(y.title, yFormat, y.subcolumns.length);
      y.subcolumns.forEach((sub, i) => pushColumn(names[i], sub));
    }
    if (tableType === "Survival") {
      warnings.push(
        `${displayName}: imported as an XY table (time in X, event codes 1 = event, 0 = censored in each group) — the survival graph and log-rank analysis apply to it.`,
      );
    }
  } else {
    helixType = "column";
    for (const y of yColumns) {
      const names = subcolumnNames(y.title, yFormat, y.subcolumns.length);
      y.subcolumns.forEach((sub, i) => pushColumn(names[i], sub));
    }
    warnings.push(`${displayName}: table type “${tableType}” isn't one Helix knows; it was imported as a Column table.`);
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
    tableType: helixType,
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
  const tableNodes = root.children.filter((c) => c.tag === "Table" || c.tag === "HugeTable");
  for (const tableNode of tableNodes) {
    const imported = importTable(tableNode, issues);
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
