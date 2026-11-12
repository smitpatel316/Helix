// Normality tests — Shapiro–Wilk, D'Agostino–Pearson omnibus K2,
// Anderson–Darling and Kolmogorov–Smirnov, run per column (plan 23).
// The file keeps its name (and the "shapiro-wilk" type key) for
// saved-project compatibility; the scope is the four tests now.
// P values are shown neutrally (no significance stars): for normality the
// meaning is inverted — a *significant* P value means the data are NOT normal.
//
// How each test is computed:
// - Shapiro–Wilk: base R `shapiro.test` (the default).
// - D'Agostino–Pearson: implemented in TypeScript below from the published
//   formulae (D'Agostino 1970 skewness transform + Anscombe–Glynn 1983
//   kurtosis transform; K2 = Z1² + Z2² ~ χ²₂, so P = exp(−K2/2)). R only
//   supplies the central moments — no R package is needed. Note:
//   `nortest::pearson.test` is NOT this test (it is a Pearson chi-square
//   goodness-of-fit test on binned data), so there is no package route for
//   the omnibus K2; the TS implementation is cross-checked against the
//   same formulae evaluated in R in tests/reference.ts, and matches
//   SciPy 1.11's `normaltest` exactly. Prism needs n ≥ 20 for this test:
//   GraphPad's FAQ lists 8 as Prism's hard floor, but the kurtosis
//   approximation is only reliable at n ≥ 20, so the plan enforces 20.
// - Anderson–Darling: `nortest::ad.test` (plan 00's bundled repo; the
//   analysis installs it on first run). Its P value is a table
//   approximation — see the notes.
// - Kolmogorov–Smirnov: base R `ks.test(x, "pnorm", mean(x), sd(x))`,
//   exactly as Prism does it — but estimating the mean and SD from the
//   same sample makes the P value anti-conservative (the proper test with
//   estimated parameters is Lilliefors); the notes say so. R's P value is
//   the asymptotic Kolmogorov distribution, not the exact finite-n one
//   SciPy's `kstest` reports by default (A: 0.8889 vs 0.8508) — the
//   reference pins R's values, since Titer runs R.
// A column a test can't take (too few values, too many for Shapiro–Wilk,
// or all identical) gets no result, and the notes say so.
import { dataGroups, declareGroups, type ColumnTestSpec, type Group } from "./base";
import type { NormalityTest, ShapiroWilkParams } from "../types";

/** D'Agostino–Pearson needs at least 20 values (see the header); the other
 *  tests need 3 (Anderson–Darling 8 — `nortest::ad.test` refuses fewer).
 *  Shapiro–Wilk also caps at 5000 (Royston checked it only to 5000). */
const MIN_N: Record<NormalityTest, number> = {
  "shapiro-wilk": 3,
  "dagostino-pearson": 20,
  "anderson-darling": 8,
  "kolmogorov-smirnov": 3,
};
const MAX_N: Record<NormalityTest, number> = {
  "shapiro-wilk": 5000,
  "dagostino-pearson": Infinity,
  "anderson-darling": Infinity,
  "kolmogorov-smirnov": Infinity,
};

/** The statistic's letter, as the result rows label it. */
const STAT_LABEL: Record<NormalityTest, string> = {
  "shapiro-wilk": "W",
  "dagostino-pearson": "K2",
  "anderson-darling": "A²",
  "kolmogorov-smirnov": "D",
};

/** The resolved test name, shown under the result heading. */
const TEST_NAME: Record<NormalityTest, string> = {
  "shapiro-wilk": "Shapiro–Wilk test",
  "dagostino-pearson": "D'Agostino–Pearson omnibus K2 test",
  "anderson-darling": "Anderson–Darling test",
  "kolmogorov-smirnov": "Kolmogorov–Smirnov test",
};

const TESTS: NormalityTest[] = ["shapiro-wilk", "dagostino-pearson", "anderson-darling", "kolmogorov-smirnov"];

/** The params resolved: an unknown `test` falls back to Shapiro–Wilk, and
 *  a missing `lognormal` to false (old saved analyses have no params). */
export const resolveNormalityParams = (params: ShapiroWilkParams | undefined): Required<ShapiroWilkParams> => ({
  test: params && TESTS.includes(params.test) ? params.test : "shapiro-wilk",
  lognormal: params?.lognormal ?? false,
});

/** Whether this test can take these values. */
export const testable = (test: NormalityTest, { values }: Group) =>
  values.length >= MIN_N[test] &&
  values.length <= MAX_N[test] &&
  values.some((v) => v !== values[0]);

/** D'Agostino–Pearson omnibus K2 from a sample's size and central moments
 *  (m2, m3, m4 = mean((x − mean)²), mean((x − mean)³), mean((x − mean)⁴)):
 *  the skewness transform of D'Agostino (1970) and the kurtosis transform
 *  of Anscombe & Glynn (1983), combined as K2 = Z1² + Z2². With 2 degrees
 *  of freedom the χ² survival function is closed-form, P = exp(−K2/2) —
 *  no chi-square helper is needed. Null when the moments are degenerate
 *  (a constant column — guarded in R before this is ever called). */
export function dagostinoPearson(
  n: number,
  m2: number,
  m3: number,
  m4: number,
): { k2: number; p: number } | null {
  if (!(m2 > 0) || n < 8) return null;
  const g1 = m3 / Math.pow(m2, 1.5);
  const b2 = m4 / (m2 * m2);
  // Skewness: Y is g1 rescaled; W², delta and alpha turn it into Z1 ~ N(0, 1).
  const y = g1 * Math.sqrt(((n + 1) * (n + 3)) / (6 * (n - 2)));
  const beta2 = (3 * (n * n + 27 * n - 70) * (n + 1) * (n + 3)) / ((n - 2) * (n + 5) * (n + 7) * (n + 9));
  const w2 = -1 + Math.sqrt(2 * (beta2 - 1));
  // δ = 1/√(ln W): W is √W², so ln W = ½·ln W² (scipy's skewtest uses
  // 0.5*log(W2) — the bare log(W2) halves Z1² and is wrong).
  const delta = 1 / Math.sqrt(0.5 * Math.log(w2));
  const alpha = Math.sqrt(2 / (w2 - 1));
  const z1 = delta * Math.log(y / alpha + Math.sqrt((y / alpha) ** 2 + 1));
  // Kurtosis: x is b2 standardised; A turns it into Z2 ~ N(0, 1).
  const e = (3 * (n - 1)) / (n + 1);
  const varB2 = (24 * n * (n - 2) * (n - 3)) / ((n + 1) ** 2 * (n + 3) * (n + 5));
  const x = (b2 - e) / Math.sqrt(varB2);
  const sqrtBeta1 =
    (6 * (n * n - 5 * n + 2)) / ((n + 7) * (n + 9)) * Math.sqrt((6 * (n + 3) * (n + 5)) / (n * (n - 2) * (n - 3)));
  const a = 6 + (8 / sqrtBeta1) * (2 / sqrtBeta1 + Math.sqrt(1 + 4 / sqrtBeta1 ** 2));
  const z2 = (1 - 2 / (9 * a) - Math.cbrt((1 - 2 / a) / (1 + x * Math.sqrt(2 / (a - 4))))) / Math.sqrt(2 / (9 * a));
  const k2 = z1 * z1 + z2 * z2;
  return { k2, p: Math.exp(-k2 / 2) };
}

/** Whether a group holds a repeated value: KS (and AD) lose power with
 *  many ties, and KS's P value is asymptotic, not exact, with ties. */
const hasTies = ({ values }: Group) => new Set(values).size < values.length;

/** R for one test on one column: a length-2 (statistic, P) vector, or a
 *  length-4 (n, m2, m3, m4) vector for D'Agostino–Pearson, whose statistic
 *  is computed in TypeScript. NA when the test can't take the column. */
const testFn = (test: NormalityTest) => {
  switch (test) {
    case "shapiro-wilk":
      return `f<-function(x){if(length(x)<3||length(x)>5000||min(x)==max(x))return(c(NA,NA));s<-shapiro.test(x);c(unname(s$statistic),s$p.value)}`;
    case "dagostino-pearson":
      return `f<-function(x){if(length(x)<20||min(x)==max(x))return(c(NA,NA,NA,NA));d<-x-mean(x);c(length(x),mean(d^2),mean(d^3),mean(d^4))}`;
    case "anderson-darling":
      return `f<-function(x){if(length(x)<8||min(x)==max(x))return(c(NA,NA));a<-nortest::ad.test(x);c(unname(a$statistic),a$p.value)}`;
    case "kolmogorov-smirnov":
      return `f<-function(x){if(length(x)<3||min(x)==max(x))return(c(NA,NA));k<-suppressWarnings(ks.test(x,"pnorm",mean(x),sd(x)));c(unname(k$statistic),k$p.value)}`;
  }
};

export const shapiroWilkSpec: ColumnTestSpec<ShapiroWilkParams> = {
  testType: "shapiro-wilk",
  minGroups: 1,
  check: (columns, params) => {
    if (!resolveNormalityParams(params).lognormal) return undefined;
    const bad = dataGroups(columns).find((c) => c.values.some((v) => v <= 0));
    return bad
      ? `Lognormality testing needs all values > 0 (log is undefined at or below zero) — “${bad.name}” holds ${bad.values.find((v) => v <= 0)}.`
      : undefined;
  },
  rCode: (groups, params) => {
    const { test, lognormal } = resolveNormalityParams(params);
    // Raw run keys: `s{i}`/`p{i}` (statistic, P) — or `n{i}`/`m2_{i}`/`m3_{i}`/
    // `m4_{i}` for D'Agostino–Pearson. The log run's keys carry an `l`
    // (`sl{i}`/`pl{i}`, `nl{i}`/`m2l_{i}`/`m3l_{i}`/`m4l_{i}`).
    const perGroup = (i: number) =>
      test === "dagostino-pearson"
        ? `n${i}=r${i}[1],m2_${i}=r${i}[2],m3_${i}=r${i}[3],m4_${i}=r${i}[4]` +
          (lognormal ? `,nl${i}=l${i}[1],m2l_${i}=l${i}[2],m3l_${i}=l${i}[3],m4l_${i}=l${i}[4]` : "")
        : `s${i}=r${i}[1],p${i}=r${i}[2]` + (lognormal ? `,sl${i}=l${i}[1],pl${i}=l${i}[2]` : "");
    return (
      `${declareGroups(groups)};${testFn(test)};` +
      groups.map((_, i) => `r${i}<-f(g${i})${lognormal ? `;l${i}<-f(log(g${i}))` : ""}`).join(";") +
      `;c(${groups.map((_, i) => perGroup(i)).join(",")})`
    );
  },
  rows: (v, groups, params) => {
    const { test, lognormal } = resolveNormalityParams(params);
    const stat = STAT_LABEL[test];
    const one = (i: number, logged: boolean): { stat: number | null; p: number | null } => {
      if (test === "dagostino-pearson") {
        const n = logged ? v[`nl${i}`] : v[`n${i}`];
        const m2 = logged ? v[`m2l_${i}`] : v[`m2_${i}`];
        const m3 = logged ? v[`m3l_${i}`] : v[`m3_${i}`];
        const m4 = logged ? v[`m4l_${i}`] : v[`m4_${i}`];
        const dp = n != null && m2 != null && m3 != null && m4 != null ? dagostinoPearson(n, m2, m3, m4) : null;
        return { stat: dp?.k2 ?? null, p: dp?.p ?? null };
      }
      return {
        stat: v[logged ? `sl${i}` : `s${i}`] ?? null,
        p: v[logged ? `pl${i}` : `p${i}`] ?? null,
      };
    };
    return groups.flatMap((g, i) => {
      const raw = one(i, false);
      const out = [
        { label: `${g.name} — ${stat}`, value: raw.stat },
        { label: `${g.name} — P value`, value: raw.p },
      ];
      if (lognormal) {
        const log = one(i, true);
        out.push(
          { label: `${g.name} — log ${stat}`, value: log.stat },
          { label: `${g.name} — log P value`, value: log.p },
        );
      }
      return out;
    });
  },
  subtitle: (params) => TEST_NAME[resolveNormalityParams(params).test],
  notes: (params, groups) => {
    const { test, lognormal } = resolveNormalityParams(params);
    const untested = groups.filter((g) => !testable(test, g)).map((g) => `“${g.name}”`);
    const range =
      test === "shapiro-wilk"
        ? "3 to 5000 values that aren't all identical"
        : test === "dagostino-pearson"
          ? "at least 20 values that aren't all identical"
          : test === "anderson-darling"
            ? "at least 8 values that aren't all identical"
            : "at least 3 values that aren't all identical";
    const parts = [
      test === "shapiro-wilk"
        ? "Shapiro–Wilk test per column."
        : test === "dagostino-pearson"
          ? "D'Agostino–Pearson omnibus K2 test per column: it combines skewness and kurtosis into one statistic, so it can miss a distribution whose skewness and kurtosis both match a normal distribution's."
          : test === "anderson-darling"
            ? "Anderson–Darling test per column: it compares the cumulative distribution with a Gaussian's, weighting the tails. Its P value is a table approximation."
            : "Kolmogorov–Smirnov test per column: it compares the cumulative distribution with a Gaussian's, using only the largest discrepancy, so it is the least sensitive of the four tests. The mean and SD are estimated from the same sample, which makes the P value anti-conservative (the proper test with estimated parameters is Lilliefors); Prism does the same, so Titer matches Prism.",
      "P > 0.05: data are consistent with a normal distribution. P < 0.05: significant departure from normality.",
    ];
    if (test === "kolmogorov-smirnov" || test === "anderson-darling") {
      const tied = groups.filter(hasTies).map((g) => `“${g.name}”`);
      if (tied.length)
        parts.push(
          `Tied values present (${tied.join(", ")}) — the test${tied.length > 1 ? "s lose" : " loses"} power with many ties${test === "kolmogorov-smirnov" ? ", and the P value is asymptotic, not exact" : ""}.`,
        );
      if (test === "kolmogorov-smirnov")
        parts.push("KS is weak at small n — a non-significant result on a small sample is weak evidence for normality.");
    }
    if (lognormal)
      parts.push(
        "Also tested on log-transformed values: a log P value above 0.05 means the data are consistent with a lognormal distribution.",
      );
    if (untested.length) parts.push(`Not tested (the test needs ${range}): ${untested.join(", ")}.`);
    return parts.join(" ");
  },
};
