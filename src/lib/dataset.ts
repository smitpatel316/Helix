// The one reading of a table that the stats, the graphs and the analysis wizards
// share, so they always agree on the data: excluded cells read as blank, each cell
// is parsed once (numeric.ts decides what a number is), and the reading is cached
// per table version. An edit makes a new TableData, so the cache is never stale.
import { hasXColumn, type TableData, type TableType } from "../store/types";
import { excludedKey, seriesKeyOf } from "./columns";
import { parseCell } from "./numeric";

/** One data column, as every engine sees it. */
export interface Column {
  name: string;
  /** Raw text, one per table row (excluded cells read as blank). */
  cells: (string | null)[];
  /** The same rows as numbers (null: blank or text). */
  byRow: (number | null)[];
  /** Just the numbers, in row order… */
  values: number[];
  /** …and the row each one came from. */
  rows: number[];
}

export interface Dataset {
  /** The row titles (column 0), one per row. */
  titles: (string | null)[];
  /** Every data column, in table order. */
  columns: Column[];
  /** The data columns holding at least one number. */
  numeric: Column[];
  /** What an analysis runs on, in table order: each column, or a grouped table's groups
   *  (holding numbers or not). A nested table's sets are its groups, each holding
   *  every column of every subgroup — so `params.sets` scopes a nested test to
   *  the groups named, as it does for grouped tables. */
  sets: DataSet[];
  /** A nested table's groups with their subgroups (empty for other tables) —
   *  the structure the nested tests read, alongside `sets`. */
  nested: NestedGroup[];
}

/** A column, or a grouped table's group with its sub-columns. */
export interface DataSet {
  name: string;
  columns: Column[];
}

/** A nested table's group, with its subgroups (animals/subjects) in table order. */
export interface NestedGroup {
  name: string;
  subgroups: NestedSubgroup[];
}

/** One subgroup of a nested table's group, with its replicate columns. */
export interface NestedSubgroup {
  name: string;
  columns: Column[];
}

/** Whether a table is a grouped one (groups × sub-columns) — not a nested one,
 *  which carries `subgroups` too and reads through `nestedGroupsOf`. */
export const isGrouped = (data: TableData) => Boolean(data.groups && data.replicates && !data.subgroups);

/** Whether a table is a nested one (groups × subgroups × replicates). A table
 *  is nested iff all three counts are set — a grouped table never sets `subgroups`. */
export const isNested = (data: TableData) => Boolean(data.groups && data.subgroups && data.replicates);

const cache = new WeakMap<TableData, Dataset>();

export function readTable(data: TableData): Dataset {
  let dataset = cache.get(data);
  if (!dataset) {
    const excluded = new Set(data.excluded);
    const columns = data.columns.slice(1).map((name, i): Column => {
      const cells = data.rows.map((row, r) => (excluded.has(excludedKey(r, i + 1)) ? null : (row[i + 1] ?? null)));
      const byRow = cells.map(parseCell);
      const rows = byRow.flatMap((v, r) => (v == null ? [] : [r]));
      return { name, cells, byRow, values: rows.map((r) => byRow[r]!), rows };
    });
    dataset = {
      titles: data.rows.map((row) => row[0] ?? null),
      columns,
      numeric: columns.filter((c) => c.values.length > 0),
      sets: isNested(data)
        ? nestedGroupsOf(columns).map((g) => ({ name: g.name, columns: g.subgroups.flatMap((s) => s.columns) }))
        : isGrouped(data)
          ? byGroup(columns)
          : columns.map((c) => ({ name: c.name, columns: [c] })),
      nested: isNested(data) ? nestedGroupsOf(columns) : [],
    };
    cache.set(data, dataset);
  }
  return dataset;
}

/** An XY table's X (its first data column, whatever its name; undefined while it
 *  holds no number) and its Y series holding numbers. */
export function splitXY(columns: Column[]): { x?: Column; ys: Column[] } {
  const [x, ...ys] = columns;
  return { x: x?.values.length ? x : undefined, ys: ys.filter((c) => c.values.length > 0) };
}

/** The columns of one Y data set: the column itself, or its replicate
 *  columns ("Control" → "Control_1", "Control_2", …). Prism stores
 *  replicates as one data set and fits every replicate point; a Titer fit
 *  that names the data set does the same, so an imported Prism analysis
 *  runs on the points Prism fitted. A plain column name is unchanged. */
export function datasetColumns(columns: Column[], name: string): Column[] {
  const exact = columns.find((c) => c.name === name);
  if (exact) return [exact];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const replicate = new RegExp(`^${escaped}_\\d+$`);
  return columns.filter((c) => replicate.test(c.name));
}

/** Why an XY table can't be analyzed or drawn yet, if it can't: X (its first data column)
 *  needs numbers, and so does a Y column — `y`, when one is chosen. */
export function xyProblem(columns: Column[], y?: string): string | undefined {
  const [x, ...ys] = columns;
  if (!x?.values.length) {
    const name = x?.name ?? "X";
    const text = x?.cells.find((c) => c?.trim());
    return text
      ? `“${name}”, the X column, holds text (“${text}”). X values must be numbers.`
      : `“${name}”, the X column, is empty. Type the X values (times, doses…) in it.`;
  }
  const chosen = y === undefined ? ys : ys.filter((c) => c.name === y);
  if (!chosen.some((c) => c.values.length))
    return y === undefined ? "No Y column holds numbers yet." : `“${y}” holds no numbers yet.`;
}

/** The rows where both columns hold a number: how X and Y pair up. */
export function pairUp(a: Column, b: Column): { x: number[]; y: number[]; rows: number[] } {
  const rows = a.rows.filter((r) => b.byRow[r] != null);
  return { x: rows.map((r) => a.byRow[r]!), y: rows.map((r) => b.byRow[r]!), rows };
}

/** A grouped table's groups ("A" for "A:Y1", "A:Y2"…), in table order, each with
 *  its replicate columns. Groups without a single number are left out: `groups`
 *  on the table says how many exist, not how many hold data. */
export function groupsOf(columns: Column[]): DataSet[] {
  return byGroup(columns).filter((g) => g.columns.some((c) => c.values.length > 0));
}

/** Columns gathered by group ("A" for "A:Y1", "A:Y2"…), in table order. */
function byGroup(columns: Column[]): DataSet[] {
  const groups = new Map<string, Column[]>();
  for (const c of columns) {
    const key = seriesKeyOf(c.name);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups].map(([name, cols]) => ({ name, columns: cols }));
}

/** A nested table's groups ("A" for "A:S1:R1"…), each with its subgroups
 *  ("S1" for "A:S1:R1"…), in table order. A column whose name doesn't split
 *  into exactly three parts belongs to no subgroup and is left out — a nested
 *  table's columns are all "group:subgroup:replicate" by construction, so this
 *  only bites on a hand-edited name. Subgroups without a single number are
 *  kept here (the nested runners must see them to name the ones they drop);
 *  callers that only want data pass the numeric columns. */
export function nestedGroupsOf(columns: Column[]): NestedGroup[] {
  const groups = new Map<string, Map<string, Column[]>>();
  for (const c of columns) {
    const parts = c.name.split(":");
    if (parts.length !== 3) continue;
    const [group, subgroup] = parts;
    let subs = groups.get(group);
    if (!subs) groups.set(group, (subs = new Map()));
    subs.set(subgroup, [...(subs.get(subgroup) ?? []), c]);
  }
  return [...groups].map(([name, subs]) => ({
    name,
    subgroups: [...subs].map(([sub, cols]) => ({ name: sub, columns: cols })),
  }));
}

/** The columns of the data sets named, in their order. */
export function setColumns(table: Dataset, names: string[]): Column[] {
  return names.flatMap((name) => table.sets.find((s) => s.name === name)?.columns ?? []);
}

/** The series a table's graphs draw, in order: the Y series of a table with an X, a grouped
 *  table's groups, else its columns holding numbers. A series' default color is
 *  the palette color at its position here, in the table and in every graph. */
export function seriesOf(data: TableData, type: TableType): string[] {
  const { columns, numeric } = readTable(data);
  if (hasXColumn(type)) return splitXY(columns).ys.map((c) => c.name);
  if (type === "grouped") return groupsOf(numeric).map((g) => g.name);
  if (type === "nested") return nestedGroupsOf(numeric).map((g) => g.name);
  return numeric.map((c) => c.name);
}
