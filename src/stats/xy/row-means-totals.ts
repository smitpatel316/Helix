// Row means / totals (v2): per-row totals, means, medians, geometric means
// with SD, SEM, %CV and the 95% CI of the mean, for XY and Grouped tables
// (Prism's Analyze > Row Means/Totals) — the step before almost every grouped
// figure, where each row is summarised across its data sets. Computed by R,
// following the per-column descriptives exactly (same SD/SEM/CI/CV/geometric-
// mean definitions, plus the row's total): a row holding one value has no SD,
// SEM, CI or %CV, and the geometric mean needs every value above 0. The
// source data is never touched — the summaries live in the result only.
import type { AnalysisOutcome, RowMeansRow, RowMeansTotalsParams } from "../types";
import { evalNamedVector } from "../webr";
import { datasetColumns, type Column as DatasetColumn } from "../../lib/dataset";

/** The row title, or the row number when the table has none (as K-means/PCA name rows). */
const rowName = (titles: (string | null)[], r: number) => titles[r]?.trim() || `Row ${r + 1}`;

export async function runRowMeansTotals(
  columns: DatasetColumn[],
  params: RowMeansTotalsParams | undefined,
  titles: (string | null)[],
): Promise<AnalysisOutcome> {
  const xCol = params?.x ? columns.find((c) => c.name === params.x) : undefined;

  // The columns to summarise across each row: the wizard's choice, or every
  // numeric column except X. A named column holding no numbers is named, not
  // silently skipped (a deleted one is caught earlier, by runAnalysis).
  let targets: DatasetColumn[];
  if (params?.ys?.length) {
    targets = params.ys.flatMap((n) => datasetColumns(columns, n));
    const empty = params.ys.find((n) => datasetColumns(columns, n).every((c) => c.values.length === 0));
    if (empty) return { error: `“${empty}” holds no numbers yet.` };
  } else {
    targets = columns.filter((c) => c !== xCol && c.values.length > 0);
  }
  if (!targets.length) return { error: xCol ? "No Y column holds numbers yet." : "No column holds numbers yet." };

  // The rows holding a value in any chosen column, in table order — a row
  // holding nothing has no summary to report.
  const rows = [...new Set(targets.flatMap((c) => c.rows))].sort((a, b) => a - b);
  // Each row's values across the chosen columns (only the values present
  // count), then its total, mean, SD, SEM, median, CI, %CV and geometric
  // mean — the per-column descriptives' definitions, transposed to rows.
  const v = await evalNamedVector(
    `G<-list(${rows.map((r) => `c(${targets.flatMap((c) => (c.byRow[r] == null ? [] : [c.byRow[r]!])).join(",")})`).join(",")});` +
      "unlist(lapply(seq_along(G),function(i){x<-G[[i]];n<-length(x);s<-if(n>1)sd(x) else NA;" +
      "h<-if(n>1)qt(0.975,n-1)*s/sqrt(n) else NA;" +
      "setNames(c(n,sum(x),mean(x),s,s/sqrt(n),median(x),mean(x)-h,mean(x)+h," +
      "if(mean(x)!=0)100*s/mean(x) else NA,if(all(x>0))exp(mean(log(x))) else NA)," +
      'paste0(c("n_","tot_","m_","s_","e_","md_","lo_","hi_","cv_","gm_"),i-1))}))',
  );
  const rowMeans: RowMeansRow[] = rows.map((r, i) => ({
    row: rowName(titles, r),
    ...(xCol ? { x: xCol.byRow[r] ?? null } : {}),
    n: v[`n_${i}`] ?? 0,
    total: v[`tot_${i}`] ?? 0,
    mean: v[`m_${i}`] ?? null,
    sd: v[`s_${i}`] ?? null,
    sem: v[`e_${i}`] ?? null,
    median: v[`md_${i}`] ?? null,
    ciLow: v[`lo_${i}`] ?? null,
    ciHigh: v[`hi_${i}`] ?? null,
    cv: v[`cv_${i}`] ?? null,
    geoMean: v[`gm_${i}`] ?? null,
  }));
  const single = rowMeans.filter((r) => r.n < 2).length;
  return {
    testType: "row-means-totals",
    subtitle: "Row means and totals",
    stats: [],
    groups: [],
    notes:
      `Summarised each row across ${targets.map((c) => `“${c.name}”`).join(", ")}: the row's total, mean, SD, SEM, ` +
      "median, 95% CI of the mean, %CV and geometric mean. " +
      "Only values present in the row count; rows holding no value are not listed. " +
      "95% CI is the t-based confidence interval of the mean. " +
      "The coefficient of variation is SD ÷ mean. " +
      (single > 0
        ? `${single} row${single === 1 ? " has" : "s have"} a single value, so ${single === 1 ? "it has" : "they have"} no SD, SEM, CI or %CV. `
        : "") +
      "The geometric mean needs every value in the row above 0.",
    rowMeans,
  };
}
