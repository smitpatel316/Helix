// Fraction of total (v2): express each value as a fraction or a percent of
// its column total, its row total, or the grand total (Prism's Analyze >
// Fraction of Total). Pure arithmetic, no R for the values themselves: the
// only R call is `describe`, for the descriptives of the fractions (as every
// other analysis reports them). The source data is never touched — the
// fractions live in the result only, with the total divided by recorded per
// column (stats rows, notes, and per-column tables) so the operation is
// auditable. A value whose total is 0 is left blank, counted, and explained
// in the notes — never NaN or Infinity into results.
import type {
  AnalysisOutcome,
  FractionOfTotalColumn,
  FractionOfTotalFormat,
  FractionOfTotalParams,
  FractionOfTotalRow,
  FractionOfTotalTotal,
  GroupDescriptives,
} from "../types";
import { describe } from "../column/base";
import { datasetColumns, type Column as DatasetColumn } from "../../lib/dataset";

/** The row title, or the row number when the table has none (as K-means/PCA name rows). */
const rowName = (titles: (string | null)[], r: number) => titles[r]?.trim() || `Row ${r + 1}`;

const sum = (values: number[]) => values.reduce((s, v) => s + v, 0);

export async function runFractionOfTotal(
  columns: DatasetColumn[],
  params: FractionOfTotalParams | undefined,
  titles: (string | null)[],
): Promise<AnalysisOutcome> {
  const totalBy: FractionOfTotalTotal = params?.totalBy ?? "column";
  if (!["column", "row", "grand"].includes(totalBy))
    return { error: `Unknown total to divide by: “${totalBy}”.` };
  const format: FractionOfTotalFormat = params?.format ?? "fraction";
  if (!["fraction", "percent"].includes(format))
    return { error: `Unknown result format: “${format}”.` };
  const xCol = params?.x ? columns.find((c) => c.name === params.x) : undefined;

  // The columns to divide: the wizard's choice, or every numeric column
  // except X. A named column holding no numbers is named, not silently
  // skipped (a deleted one is caught earlier, by runAnalysis).
  let targets: DatasetColumn[];
  if (params?.ys?.length) {
    targets = params.ys.flatMap((n) => datasetColumns(columns, n));
    const empty = params.ys.find((n) => datasetColumns(columns, n).every((c) => c.values.length === 0));
    if (empty) return { error: `“${empty}” holds no numbers yet.` };
  } else {
    targets = columns.filter((c) => c !== xCol && c.values.length > 0);
  }
  if (!targets.length)
    return { error: xCol ? "No Y column holds numbers yet." : "No column holds numbers yet." };

  // The totals, resolved once: a column's own sum, the grand sum of every
  // chosen value, or — for row totals — each row's sum across the chosen
  // columns (only the values present in that row count).
  const grandTotal = sum(targets.flatMap((c) => c.values));
  const rowTotals = new Map<number, number>();
  if (totalBy === "row") {
    const rows = [...new Set(targets.flatMap((c) => c.rows))];
    for (const r of rows)
      rowTotals.set(
        r,
        sum(targets.flatMap((c) => (c.byRow[r] == null ? [] : [c.byRow[r]!]))),
      );
  }

  const scale = format === "percent" ? 100 : 1;
  let blank = 0;
  const fractions: FractionOfTotalColumn[] = targets.map((col) => {
    const columnTotal = totalBy === "column" ? sum(col.values) : totalBy === "grand" ? grandTotal : null;
    const rows: FractionOfTotalRow[] = col.rows.map((r) => {
      const total = totalBy === "row" ? rowTotals.get(r)! : columnTotal!;
      const original = col.byRow[r]!;
      const value = total === 0 ? null : (original / total) * scale;
      if (value === null) blank += 1;
      return {
        row: rowName(titles, r),
        ...(xCol ? { x: xCol.byRow[r] ?? null } : {}),
        original,
        total,
        value,
      };
    });
    return { column: col.name, total: columnTotal, format, rows };
  });

  // Descriptives of the fractions (or percentages), not the originals. A
  // column whose every value is blank has no values to describe — R's mean
  // of an empty vector is NaN, so it gets an empty group instead.
  const withValues = fractions
    .map((c) => ({ name: c.column, values: c.rows.flatMap((r) => (r.value == null ? [] : [r.value])) }))
    .filter((g) => g.values.length > 0);
  const described = withValues.length > 0 ? (await describe(withValues)).groups : [];
  const groups: GroupDescriptives[] = fractions.map(
    (c) =>
      described.find((g) => g.name === c.column) ?? {
        name: c.column,
        mean: null,
        sd: null,
        sem: null,
        median: null,
        n: 0,
      },
  );

  const unit = format === "percent" ? "percentage" : "fraction";
  const totalWord =
    totalBy === "column" ? "its column total" : totalBy === "row" ? "its row total" : "the grand total";
  const stats =
    totalBy === "column"
      ? fractions.map((c) => ({ label: `Total for “${c.column}”`, value: c.total }))
      : totalBy === "grand"
        ? [{ label: "Grand total", value: grandTotal }]
        : [];
  const totalsNote =
    totalBy === "column"
      ? `Column totals — ${fractions.map((c) => `${c.column}: ${c.total}`).join("; ")}. `
      : totalBy === "grand"
        ? `Grand total: ${grandTotal}. `
        : "";
  return {
    testType: "fraction-of-total",
    subtitle: `Fraction of total (${totalBy} total, as ${format === "percent" ? "percentages" : "fractions"})`,
    stats,
    groups,
    notes:
      `Divided each value in ${fractions.map((c) => `“${c.column}”`).join(", ")} by ${totalWord} and reported the result as a ${unit}. ` +
      totalsNote +
      "The original values are unchanged; the tables below are the fractions of total. " +
      "Only rows holding a value are listed." +
      (blank > 0
        ? ` ${blank} value${blank === 1 ? " is" : "s are"} blank because ${blank === 1 ? "its" : "their"} total is 0.`
        : ""),
    fractionsOfTotal: fractions,
  };
}
