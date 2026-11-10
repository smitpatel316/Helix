// "Bland-Altman method comparison" (Prism's method comparison) — two measurement
// methods on the same subjects, paired by row. Pure TypeScript, no R: the bias
// (mean difference), the SD of the differences, the 95% limits of agreement
// (bias ± 1.96 SD) and the 95% CIs of the bias and of both limits — the CIs use
// the t distribution with n−1 df, the limits themselves the fixed 1.96 multiplier
// (Bland & Altman 1986: SE of a limit = SD·√(3/n)). The graph reuses
// `computeBlandAltman` below, so its lines can never disagree with this runner.
import type { AnalysisOutcome, Column, StatRow } from "../types";
import { describe, matchedRowsNote, pairedGroups } from "./base";
import { mean, sd } from "../../lib/summary";
import { tCrit95 } from "../../lib/student-t";

/** The Bland-Altman numbers for one set of paired differences. */
export interface BlandAltmanStats {
  n: number;
  bias: number;
  sd: number;
  lower: number;
  upper: number;
  biasLo: number;
  biasHi: number;
  lowerLo: number;
  lowerHi: number;
  upperLo: number;
  upperHi: number;
}

export function computeBlandAltman(diffs: number[]): BlandAltmanStats {
  const n = diffs.length;
  const bias = mean(diffs);
  const s = sd(diffs);
  const lower = bias - 1.96 * s;
  const upper = bias + 1.96 * s;
  const t = tCrit95(n - 1);
  const seBias = s / Math.sqrt(n);
  const seLimit = s * Math.sqrt(3 / n);
  return {
    n,
    bias,
    sd: s,
    lower,
    upper,
    biasLo: bias - t * seBias,
    biasHi: bias + t * seBias,
    lowerLo: lower - t * seLimit,
    lowerHi: lower + t * seLimit,
    upperLo: upper - t * seLimit,
    upperHi: upper + t * seLimit,
  };
}

/** The first two columns are the two methods, paired by row (complete pairs only). */
export async function runBlandAltman(columns: Column[]): Promise<AnalysisOutcome> {
  const groups = pairedGroups(columns.slice(0, 2));
  if (groups.length < 2) {
    return { error: "This test needs at least 2 columns containing numeric data." };
  }
  const [first, second] = groups;
  const diffs = first.values.map((v, i) => v - second.values[i]);
  const n = diffs.length;
  if (n < 3) {
    return { error: `Bland-Altman needs at least 3 paired measurements (found ${n}).` };
  }
  const s = computeBlandAltman(diffs);
  const stats: StatRow[] = [
    { label: "Bias (mean difference)", value: s.bias },
    { label: "SD of differences", value: s.sd },
    { label: "Lower limit of agreement", value: s.lower },
    { label: "Upper limit of agreement", value: s.upper },
    { label: "Bias 95% CI lower", value: s.biasLo },
    { label: "Bias 95% CI upper", value: s.biasHi },
    { label: "Lower limit 95% CI lower", value: s.lowerLo },
    { label: "Lower limit 95% CI upper", value: s.lowerHi },
    { label: "Upper limit 95% CI lower", value: s.upperLo },
    { label: "Upper limit 95% CI upper", value: s.upperHi },
    { label: "N (pairs)", value: n },
  ];
  const identical = s.sd === 0 ? " All differences are identical — the limits of agreement equal the bias." : "";
  return {
    testType: "bland-altman",
    subtitle: "Bland-Altman method comparison",
    stats,
    groups: (await describe([first, second])).groups,
    notes:
      `Difference is “${first.name}” − “${second.name}”. ${matchedRowsNote(columns.slice(0, 2))} ` +
      "Limits of agreement are bias ± 1.96 × SD of the differences. " +
      "The differences are assumed to be approximately normally distributed; " +
      "run a Shapiro-Wilk normality test on the differences to check this." +
      identical,
  };
}
