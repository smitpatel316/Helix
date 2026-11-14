// Prune rows (v2): drop rows matching a condition — empty, below a
// threshold, above a threshold, or outside a range — from the chosen
// columns (the backlog's item 6: "drop rows matching a condition (e.g.
// empty, below threshold)"). Pure row filtering, no R except `describe`,
// for the descriptives of the kept values (as every other analysis
// reports them). The source data is never touched — the kept rows live
// in the result with the pruned rows listed right after them, so exactly
// what was dropped stays visible and recoverable from the source table.
//
// Note: Prism's literal Prune analysis is a different operation — it
// averages every K rows (decimation by averaging) to shrink a huge
// table. This item implements the backlog's condition-based row drop
// instead; the averaging decimation is not built here.
import type {
  AnalysisOutcome,
  PruneRowsCondition,
  PruneRowsParams,
  PrunedRowsRow,
} from "../types";
import { describe } from "../column/base";
import { datasetColumns, type Column as DatasetColumn } from "../../lib/dataset";

/** The row title, or the row number when the table has none (as K-means/PCA name rows). */
const rowName = (titles: (string | null)[], r: number) => titles[r]?.trim() || `Row ${r + 1}`;

/** Whether a row matches the condition: every value it holds in the
 *  chosen columns meets it. Blank cells hold no value, so they never
 *  match on their own — a row with no values at all matches only
 *  "empty", and is kept by below/above/outside (use "empty" to drop
 *  blank rows). The X column never participates. */
function matches(
  condition: PruneRowsCondition,
  values: number[],
  threshold: number | undefined,
  low: number | undefined,
  high: number | undefined,
): boolean {
  if (condition === "empty") return values.length === 0;
  if (values.length === 0) return false;
  if (condition === "below") return values.every((v) => v < threshold!);
  if (condition === "above") return values.every((v) => v > threshold!);
  // outside.
  return values.every((v) => v < low! || v > high!);
}

/** The condition in words, for the subtitle and the notes. */
function conditionText(
  condition: PruneRowsCondition,
  threshold: number | undefined,
  low: number | undefined,
  high: number | undefined,
): { short: string; long: string } {
  if (condition === "empty") return { short: "empty rows", long: "held no value in any chosen data set" };
  if (condition === "below") return { short: `below ${threshold}`, long: `had every value below ${threshold}` };
  if (condition === "above") return { short: `above ${threshold}`, long: `had every value above ${threshold}` };
  return { short: `outside ${low} to ${high}`, long: `had every value outside ${low} to ${high}` };
}

export async function runPruneRows(
  columns: DatasetColumn[],
  params: PruneRowsParams | undefined,
  titles: (string | null)[],
): Promise<AnalysisOutcome> {
  const condition = params?.condition ?? "empty";
  if (!["empty", "below", "above", "outside"].includes(condition))
    return { error: `Unknown prune condition: “${condition}”.` };
  const xCol = params?.x ? columns.find((c) => c.name === params.x) : undefined;

  // The columns to prune on: the wizard's choice, or every numeric
  // column except X. A named column holding no numbers is named, not
  // silently skipped (a deleted one is caught earlier, by runAnalysis).
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

  // The threshold(s) the condition needs.
  let threshold: number | undefined;
  let low: number | undefined;
  let high: number | undefined;
  if (condition === "below" || condition === "above") {
    threshold = params?.threshold;
    if (threshold == null || !Number.isFinite(threshold))
      return { error: "Enter a threshold value to prune against." };
  } else if (condition === "outside") {
    low = params?.low;
    high = params?.high;
    if (low == null || !Number.isFinite(low) || high == null || !Number.isFinite(high))
      return { error: "Enter the low and high ends of the range to prune outside of." };
    if (low >= high) return { error: `The range's low end (${low}) must be below its high end (${high}).` };
  }

  const rowCount = titles.length;
  const kept: PrunedRowsRow[] = [];
  const pruned: PrunedRowsRow[] = [];
  for (let r = 0; r < rowCount; r++) {
    const values = targets.map((c) => c.byRow[r] ?? null);
    const held = values.filter((v): v is number => v != null);
    const row: PrunedRowsRow = {
      row: rowName(titles, r),
      ...(xCol ? { x: xCol.byRow[r] ?? null } : {}),
      values,
    };
    (matches(condition, held, threshold, low, high) ? pruned : kept).push(row);
  }
  if (!kept.length)
    return { error: "Every row matches the condition, so no rows would be kept." };

  // Descriptives of the kept values, per column. A column whose values
  // all sat in pruned rows kept nothing, so it has no descriptives —
  // its kept values are still listed (as blanks) in the kept table.
  const keptValues: number[][] = targets.map(() => []);
  for (const row of kept) row.values.forEach((v, i) => {
    if (v != null) keptValues[i].push(v);
  });
  const { groups } = await describe(
    targets.map((c, i) => ({ name: c.name, values: keptValues[i] })).filter((g) => g.values.length > 0),
  );

  const { short, long } = conditionText(condition, threshold, low, high);
  const prunedNames = pruned.map((r) => r.row).join(", ");
  return {
    testType: "prune-rows",
    subtitle: `Prune rows (${short})`,
    stats: [
      { label: "Rows in table", value: rowCount },
      { label: "Rows kept", value: kept.length },
      { label: "Rows pruned", value: pruned.length },
    ],
    groups,
    notes:
      `Dropped ${pruned.length} of ${rowCount} row${rowCount === 1 ? "" : "s"} — the row${pruned.length === 1 ? "" : "s"} that ${long}` +
      (pruned.length ? ` (${prunedNames}). ` : ". ") +
      "The kept rows are in the first table below and the pruned rows in the second, so what was dropped stays visible. " +
      "The original table is unchanged — the pruned rows are still in it.",
    prunedRows: { columns: targets.map((c) => c.name), kept, pruned },
  };
}
