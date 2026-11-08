// Survival analysis — the log-rank (Mantel-Cox) test: whether two or more
// Kaplan-Meier curves differ more than chance allows. Prism runs this
// automatically on survival tables; Helix drew the curves (see
// views/graphs/survival.ts) but had no test for them.
//
// The test is closed-form, so it is computed here in plain TypeScript — no R
// round-trip — and the Kaplan-Meier steps are the graph's own (`kaplanMeier`).
// At each event time t, with n_j at risk and d_j events in group j (d events
// in n subjects overall): E_j = d·n_j/n, and the covariance across groups is
// V_jl = n_j·(δ_jl·n − n_l)·d·(n−d) / (n²·(n−1)). Chi-square = U′V⁻¹U over
// the first k−1 groups (V over all k is singular), df = k−1.

import type { AnalysisOutcome, Column, GroupDescriptives, StatRow } from "../types";
import { pairUp } from "../../lib/dataset";
import { chiSquareSF } from "../../lib/chi-square";
import { kaplanMeier } from "../../views/graphs/survival";
import { num } from "../../lib/format";

interface Group {
  name: string;
  times: number[];
  codes: number[];
  n: number;
  events: number;
  censored: number;
  median: number | null;
}

/** First event time at which survival is ≤ 0.5, else null (not reached). */
function medianSurvival(times: number[], codes: number[]): number | null {
  const { t, s } = kaplanMeier(times, codes);
  for (let i = 1; i < t.length; i++) {
    if (s[i] <= 0.5) return t[i];
  }
  return null;
}

/** Solve A·x = b by Gaussian elimination with partial pivoting; null when A is singular. */
function solve(matrix: number[][], rhs: number[]): number[] | null {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col] / a[col][col];
      for (let c = col; c <= n; c++) a[r][c] -= factor * a[col][c];
    }
  }
  return a.map((row, i) => row[n] / a[i][i]);
}

export async function runLogRank(columns: Column[]): Promise<AnalysisOutcome> {
  const [xCol, ...ySeries] = columns;
  if (!xCol || ySeries.length === 0) {
    return { error: "Survival analysis needs a time column and at least two groups." };
  }
  const groups: Group[] = [];
  for (const y of ySeries) {
    const { x, y: codes } = pairUp(xCol, y);
    if (x.length === 0) continue;
    const bad = codes.find((c) => c !== 0 && c !== 1);
    if (bad !== undefined) {
      return {
        error: `“${y.name}” holds ${bad}, but survival codes must be 1 (event) or 0 (censored).`,
      };
    }
    const events = codes.filter((c) => c === 1).length;
    groups.push({
      name: y.name,
      times: x,
      codes,
      n: x.length,
      events,
      censored: x.length - events,
      median: medianSurvival(x, codes),
    });
  }
  if (groups.length < 2) {
    return { error: "Survival analysis needs at least two groups with data." };
  }
  const totalEvents = groups.reduce((sum, g) => sum + g.events, 0);
  if (totalEvents === 0) {
    return { error: "Survival analysis needs at least one event (a code of 1)." };
  }

  // One pass over the distinct event times.
  const k = groups.length;
  const observed = groups.map((g) => g.events);
  const expected = new Array<number>(k).fill(0);
  const covariance: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const eventTimes = [...new Set(groups.flatMap((g) => g.times.filter((_, i) => g.codes[i] === 1)))].sort(
    (a, b) => a - b,
  );
  for (const t of eventTimes) {
    const atRisk = groups.map((g) => g.times.filter((time) => time >= t).length);
    const events = groups.map(
      (g) => g.times.filter((time, i) => time === t && g.codes[i] === 1).length,
    );
    const n = atRisk.reduce((a, b) => a + b, 0);
    const d = events.reduce((a, b) => a + b, 0);
    if (d === 0 || n <= 1) continue;
    for (let j = 0; j < k; j++) expected[j] += (d * atRisk[j]) / n;
    const factor = (d * (n - d)) / (n * n * (n - 1));
    for (let j = 0; j < k; j++) {
      for (let l = 0; l < k; l++) {
        covariance[j][l] += (j === l ? atRisk[j] * (n - atRisk[j]) : -atRisk[j] * atRisk[l]) * factor;
      }
    }
  }
  // Drop the last group: U and V over all k groups sum to zero / are singular.
  const m = k - 1;
  const u = observed.slice(0, m).map((o, j) => o - expected[j]);
  const v = covariance.slice(0, m).map((row) => row.slice(0, m));
  const solved = solve(v, u);
  if (!solved) {
    return { error: "The log-rank test couldn't be computed for these groups." };
  }
  const chi2 = u.reduce((sum, uj, j) => sum + uj * solved[j], 0);
  const df = m;
  const p = chiSquareSF(Math.max(0, chi2), df);

  const stats: StatRow[] = [
    { label: "Chi-square", value: chi2 },
    { label: "df", value: df },
    { label: "P value", value: p, p: true },
  ];
  const descriptives: GroupDescriptives[] = groups.map((g) => ({
    name: g.name,
    mean: null,
    sd: null,
    sem: null,
    median: g.median,
    n: g.n,
  }));
  const summary = groups
    .map(
      (g, j) =>
        `${g.name}: ${g.n} subjects, ${g.events} events, ${g.censored} censored, ` +
        `observed ${observed[j]} vs expected ${num(expected[j])}, ` +
        `median survival ${g.median === null ? "not reached" : num(g.median)}`,
    )
    .join("; ");
  return {
    testType: "survival-log-rank",
    subtitle: "Log-rank (Mantel-Cox) test",
    stats,
    groups: descriptives,
    notes:
      `Log-rank test comparing ${k} survival curves (df = ${df}). ` +
      `The median shown per group is the Kaplan-Meier median survival. ${summary}.`,
  };
}
