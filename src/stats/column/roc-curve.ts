// "ROC curve analysis" (Prism's ROC curve): a binary truth against a continuous
// score, paired by row. Pure TypeScript, no R: AUC is Mann-Whitney U / (m·n)
// (ties count 0.5), identical to the trapezoidal area under the empirical ROC
// curve; the 95% CI is DeLong's (DeLong et al. 1988 — the method pROC::ci.auc
// uses by default), truncated to [0, 1]; the optimal cutpoint maximises
// Youden's J, ties broken toward the highest threshold. The graph reuses
// `computeRocCurve` below, so its curve can never disagree with this runner.
import type { AnalysisOutcome, Column, RocParams, RocPoint, StatRow } from "../types";
import { describe, missingColumn } from "./base";

/** One complete (truth, score) pair. */
export interface RocPair {
  label: string;
  score: number;
}

/** One truth cell as its class label: blank → null; a number → its canonical
 *  form ("1.0" and "1" are the same class); anything else → the trimmed text. */
export function truthLabel(cell: string | null): string | null {
  if (cell == null) return null;
  const text = cell.trim();
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? String(n) : text;
}

/** A column's distinct truth values, in first-seen order. */
export function distinctTruthValues(column: Column): string[] {
  const seen: string[] = [];
  for (const cell of column.cells) {
    const label = truthLabel(cell);
    if (label !== null && !seen.includes(label)) seen.push(label);
  }
  return seen;
}

/** The largest distinct truth value: numerically when every value is a
 *  number, lexicographically otherwise. */
export function defaultPositive(values: string[]): string {
  const nums = values.map(Number);
  if (nums.every(Number.isFinite)) return String(Math.max(...nums));
  return [...values].sort().at(-1)!;
}

/** Complete (truth, score) pairs from two columns, and how many rows were
 *  dropped for missing one of the two. */
export function rocPairs(truth: Column, score: Column): { pairs: RocPair[]; dropped: number } {
  const pairs: RocPair[] = [];
  let dropped = 0;
  const rows = Math.max(truth.cells.length, score.cells.length);
  for (let r = 0; r < rows; r++) {
    const label = truthLabel(truth.cells[r] ?? null);
    const value = score.byRow[r] ?? null;
    if (label !== null && value !== null) pairs.push({ label, score: value });
    else if (label !== null || value !== null) dropped++;
  }
  return { pairs, dropped };
}

const lowerBound = (sorted: number[], x: number): number => {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const upperBound = (sorted: number[], x: number): number => {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/** Sample variance (n − 1); 0 with fewer than 2 values. */
const sampleVar = (v: number[]): number => {
  if (v.length < 2) return 0;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1);
};

/** The ROC numbers for one set of complete pairs: `positive` must be one of
 *  the pairs' two labels, and both classes must be present. */
export interface RocComputation {
  auc: number;
  se: number;
  ciLow: number;
  ciHigh: number;
  /** Whether either CI end hit the [0, 1] bound and was truncated. */
  truncated: boolean;
  /** min(N positive, N negative) < 5 — the DeLong CI is asymptotic. */
  smallSample: boolean;
  /** One row per threshold (unique score values, descending). */
  points: RocPoint[];
  optimum: RocPoint & { youden: number };
  nPositive: number;
  nNegative: number;
  positiveScores: number[];
  negativeScores: number[];
}

export function computeRocCurve(pairs: RocPair[], positive: string): RocComputation {
  const positiveScores = pairs.filter((p) => p.label === positive).map((p) => p.score);
  const negativeScores = pairs.filter((p) => p.label !== positive).map((p) => p.score);
  const m = positiveScores.length;
  const n = negativeScores.length;
  const posSorted = [...positiveScores].sort((a, b) => a - b);
  const negSorted = [...negativeScores].sort((a, b) => a - b);

  // AUC = Mann-Whitney U / (m·n), ties count 0.5: average ranks over the
  // pooled scores, U = (sum of the positives' ranks) − m(m+1)/2.
  const pooled = [
    ...positiveScores.map((s) => ({ s, pos: true })),
    ...negativeScores.map((s) => ({ s, pos: false })),
  ].sort((a, b) => a.s - b.s);
  let rankSumPos = 0;
  let i = 0;
  while (i < pooled.length) {
    let j = i;
    while (j < pooled.length && pooled[j].s === pooled[i].s) j++;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (pooled[k].pos) rankSumPos += avgRank;
    i = j;
  }
  const auc = (rankSumPos - (m * (m + 1)) / 2) / (m * n);

  // DeLong (1988) placement values: V10[i] is how the i-th positive ranks
  // against all negatives, V01[j] how the j-th negative ranks against all
  // positives (ties 0.5); Var(AUC) = S10/m + S01/n, sample variances.
  const v10 = positiveScores.map(
    (p) => (lowerBound(negSorted, p) + 0.5 * (upperBound(negSorted, p) - lowerBound(negSorted, p))) / n,
  );
  const v01 = negativeScores.map(
    (q) => (m - upperBound(posSorted, q) + 0.5 * (upperBound(posSorted, q) - lowerBound(posSorted, q))) / m,
  );
  const se = Math.sqrt(sampleVar(v10) / m + sampleVar(v01) / n);
  const rawLow = auc - 1.96 * se;
  const rawHigh = auc + 1.96 * se;
  const ciLow = Math.max(0, rawLow);
  const ciHigh = Math.min(1, rawHigh);

  // Thresholds = each unique score, descending; predict positive iff score ≥ t.
  // The optimum keeps the FIRST largest J in this order — the highest
  // threshold among tied J values.
  const thresholds = [...new Set([...positiveScores, ...negativeScores])].sort((a, b) => b - a);
  let optimum: RocComputation["optimum"] | null = null;
  const points = thresholds.map((t) => {
    const tp = m - lowerBound(posSorted, t);
    const tn = lowerBound(negSorted, t);
    const sensitivity = tp / m;
    const specificity = tn / n;
    const youden = sensitivity + specificity - 1;
    if (optimum === null || youden > optimum.youden) optimum = { threshold: t, sensitivity, specificity, youden };
    return { threshold: t, sensitivity, specificity };
  });
  return {
    auc,
    se,
    ciLow,
    ciHigh,
    truncated: rawLow < 0 || rawHigh > 1,
    smallSample: Math.min(m, n) < 5,
    points,
    optimum: optimum!,
    nPositive: m,
    nNegative: n,
    positiveScores,
    negativeScores,
  };
}

/** Truth defaults to the first data column, score to the second, positive to
 *  the larger distinct truth value. */
export async function runRocCurve(columns: Column[], params?: RocParams): Promise<AnalysisOutcome> {
  const truthName = params?.truth ?? columns[0]?.name;
  const scoreName = params?.score ?? columns[1]?.name;
  if (!truthName || !scoreName) {
    return { error: "This test needs at least 2 columns containing numeric data." };
  }
  const truthCol = columns.find((c) => c.name === truthName);
  if (!truthCol) return { error: missingColumn(truthName) };
  const scoreCol = columns.find((c) => c.name === scoreName);
  if (!scoreCol) return { error: missingColumn(scoreName) };
  if (!scoreCol.values.length) {
    return { error: "This test needs at least 2 columns containing numeric data." };
  }
  const { pairs, dropped } = rocPairs(truthCol, scoreCol);
  const distinct = [...new Set(pairs.map((p) => p.label))];
  if (distinct.length !== 2) {
    return { error: `The outcome column must have exactly two values (found ${distinct.length}).` };
  }
  const given = params?.positive;
  const positive = given === undefined ? defaultPositive(distinct) : String(given);
  if (!distinct.includes(positive)) {
    return { error: `The positive value “${given}” is not in the outcome column.` };
  }
  const negative = distinct.find((d) => d !== positive)!;
  const r = computeRocCurve(pairs, positive);
  const stats: StatRow[] = [
    { label: "AUC", value: r.auc },
    { label: "AUC standard error", value: r.se },
    { label: "AUC 95% CI lower", value: r.ciLow },
    { label: "AUC 95% CI upper", value: r.ciHigh },
    { label: "Optimal cutpoint (Youden)", value: r.optimum.threshold },
    { label: "Sensitivity at cutpoint", value: r.optimum.sensitivity },
    { label: "Specificity at cutpoint", value: r.optimum.specificity },
    { label: "Youden's J", value: r.optimum.youden },
    { label: "N positive", value: r.nPositive },
    { label: "N negative", value: r.nNegative },
  ];
  const clamped =
    r.auc - 1.96 * r.se < 0 && r.auc + 1.96 * r.se > 1
      ? "both limits hit the [0, 1] bound and were truncated"
      : r.auc - 1.96 * r.se < 0
        ? "the lower limit hit 0 and was truncated"
        : r.auc + 1.96 * r.se > 1
          ? "the upper limit hit 1 and was truncated"
          : null;
  return {
    testType: "roc-curve",
    subtitle: "ROC curve analysis",
    stats,
    groups: (
      await describe([
        { name: positive, values: r.positiveScores },
        { name: negative, values: r.negativeScores },
      ])
    ).groups,
    rocCurve: r.points,
    notes:
      `“${positive}” is the positive class (N = ${r.nPositive}); “${negative}” is negative (N = ${r.nNegative}). ` +
      "AUC is the Mann-Whitney U statistic divided by the product of the class sizes — identical to the trapezoidal area under the empirical ROC curve. " +
      "An AUC of 0.5 is chance; 1 is perfect separation. " +
      "The 95% confidence interval is DeLong's (DeLong et al. 1988), truncated to [0, 1]" +
      (clamped ? ` — ${clamped}.` : ".") +
      " The optimal cutpoint maximises Youden's J (sensitivity + specificity − 1); among tied J values the highest threshold is reported. " +
      "Tied scores count 0.5 in the AUC, and a threshold equal to a tied score classifies the whole tie as positive. " +
      (dropped === 0
        ? "Uses complete pairs only; no rows were left out."
        : `Uses complete pairs only; ${dropped} row${dropped === 1 ? "" : "s"} left out for missing data.`) +
      (r.smallSample ? " Fewer than 5 in one class — the confidence interval is approximate." : ""),
  };
}
