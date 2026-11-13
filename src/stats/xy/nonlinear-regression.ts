// Nonlinear regression for an XY table — Prism's dose-response and standard curves, fitted by
// R: models linear in their parameters (line, semilog, polynomials) with lm(), the others
// (sigmoidal 3PL, 4PL and 5PL, hyperbola, exponential growth and decay, Michaelis-Menten)
// with nls(). Each model reports its coefficients with their 95% CI (asymptotic, as Prism's
// default), a goodness-of-fit block (R², df, sum of squares, Sy.x) and, where meaningful,
// derived quantities with their CI (EC50, Span, half-life…). A dose-response curve can be
// compared with another data set's: is the EC50 different, or does one curve fit both (the
// extra sum-of-squares F test). A standard curve interpolates its unknowns: the rows holding
// a Y but no X — with our band-inversion 95% CIs on the interpolated X (Prism reports them;
// upstream 1.0.7 has none). The fit itself lives in nonlinear-fit.ts, shared with the
// binding / enzyme-inhibition / global-fit runners.
import type {
  AnalysisOutcome,
  Column,
  FitRow,
  InterpolatedRow,
  NonlinearModel,
  NonlinearRegressionParams,
  NonlinearWeightScheme,
  RegressionCoefficient,
  StatRow,
} from "../types";
import { describe, pRow, rVec } from "../column/base";
import { num } from "../../lib/format";
import { datasetColumns, splitXY, xyProblem } from "../../lib/dataset";
import { evalNamedVector, type RVector } from "../webr";
import { rowName } from "../grouped/base";
import {
  ENZYME_MODELS,
  EXPONENTIAL_MODELS,
  applyFitOptions,
  fitEntries,
  fitError,
  fitModelSpec,
  fitStatementsForSpec,
  fitSummaryStatements,
  formulaExpr,
  formulaVariables,
  MODEL_LABEL,
  modelSpec,
  parseFit,
  prepareFit,
  type DerivedRow,
  type FitOptions,
  type ModelSpec,
} from "./nonlinear-fit";
import { runGlobalFit, type GlobalModelDef, type GlobalParamDef } from "./global-fit";
// The overlay's closed-form evaluator, reused for a global fit's per-series
// R² (the fit and the overlay can never disagree). This closes an import
// cycle with fitted-curve.ts (it imports termLabel/positiveXOnly from here),
// which is safe: both sides only call across it inside function bodies,
// never at module top level.
import { evaluate as evaluateCurve } from "../../views/graphs/fitted-curve";

// Re-exported for upstream importers (wizards.ts, fitted-curve.ts): the labels
// live in nonlinear-fit.ts now; positiveXOnly matches upstream's helper.
export { MODEL_LABEL };
export const positiveXOnly = (model: NonlinearModel) => modelSpec(model).positiveX === true;
export const nonNegativeXOnly = (model: NonlinearModel) => modelSpec(model).nonNegativeX === true;

/** A parameter as results name it (its name in the equations otherwise). */
const TERM_LABEL: Record<string, string> = { HillSlope: "Hill slope", S: "Asymmetry (S)" };
export const termLabel = (term: string) => TERM_LABEL[term] ?? term;

// ── Plan 26: closed-form inverses ────────────────────────────────────────
// The per-model invertibility table + closed-form inverse functions, exported
// for plan 02's standard-curve-interpolation runner (the contract this plan
// defines — plan 02 does not exist yet). `invertModel` solves the fitted
// curve for X at a given Y from its coefficients (display terms, as results
// store them); `null` means the model has no closed-form inverse (quadratic,
// cubic, two-phase decay, plateau-decay, substrate inhibition — invert those
// numerically, e.g. with the R `uniroot` search the interpolation path
// already uses) or the Y is outside the curve's range. The CI of an
// interpolated X is plan 02's band inversion, not a delta method on the
// inverse — this module owns only the point estimate.
export type InvertMethod = "closed-form" | "numeric";
export const invertMethod = (model: NonlinearModel): InvertMethod =>
  model === "quadratic" ||
  model === "cubic" ||
  // Plan 29: the higher polynomials and the segmental line have no
  // closed-form inverse either (the breakpoint is profiled, not fitted
  // as a coefficient) — invert numerically.
  model === "quartic" ||
  model === "quintic" ||
  model === "segmental-linear" ||
  model === "two-phase-decay" ||
  model === "plateau-decay" ||
  model === "substrate-inhibition"
    ? "numeric"
    : "closed-form";

/** The fitted curve's X at Y, from its coefficients (display terms) — the
 *  closed form where one exists, `null` otherwise. All forms assume the
 *  fitted coefficients; a Y outside the curve's range (between the
 *  asymptotes, below the plateau, above the maximum…) returns `null`. */
export function invertModel(
  model: NonlinearModel,
  coefficients: RegressionCoefficient[],
  y: number,
): number | null {
  const c = (term: string) => coefOf(coefficients, term);
  // The sigmoidal ratio (Top − Y)/(Y − Bottom), positive exactly when Y
  // lies strictly between the asymptotes.
  const ratio = () => {
    const bottom = c("Bottom");
    const top = c("Top");
    if (bottom == null || top == null || top === bottom) return null;
    const r = (top - y) / (y - bottom);
    return r > 0 ? r : null;
  };
  switch (model) {
    case "line": {
      const b = c("Intercept");
      const s = c("Slope");
      if (b == null || s == null || s === 0) return null;
      return (y - b) / s;
    }
    case "semilog-line": {
      const b = c("Intercept");
      const s = c("Slope");
      if (b == null || s == null || s === 0) return null;
      const x = Math.exp((y - b) / s);
      return x > 0 ? x : null;
    }
    case "sigmoidal-4pl-logx": {
      const r = ratio();
      const mid = c("LogEC50");
      const h = c("HillSlope");
      if (r == null || mid == null || h == null || h === 0) return null;
      return mid - Math.log10(r) / h;
    }
    case "sigmoidal-4pl-x": {
      const r = ratio();
      const ec50 = c("EC50");
      const h = c("HillSlope");
      if (r == null || ec50 == null || h == null || h === 0) return null;
      const x = ec50 / r ** (1 / h);
      return x > 0 ? x : null;
    }
    case "agonist-3pl-logx": {
      const r = ratio();
      const mid = c("LogEC50");
      if (r == null || mid == null) return null;
      return mid - Math.log10(r);
    }
    case "inhibitor-3pl-logx": {
      const r = ratio();
      const mid = c("LogIC50");
      if (r == null || mid == null) return null;
      return mid + Math.log10(r);
    }
    case "asymmetric-5pl-logx": {
      const r = ratio();
      const mid = c("LogEC50");
      const h = c("HillSlope");
      const s = c("S");
      if (r == null || mid == null || h == null || h === 0 || s == null || s === 0) return null;
      const u = (1 + r) ** (1 / s) - 1;
      if (u <= 0) return null;
      return mid + Math.log10(2 ** (1 / s) - 1) / h - Math.log10(u) / h;
    }
    case "asymmetric-5pl-x": {
      const r = ratio();
      const ec50 = c("EC50");
      const h = c("HillSlope");
      const s = c("S");
      if (r == null || ec50 == null || h == null || h === 0 || s == null || s === 0) return null;
      const u = (1 + r) ** (1 / s) - 1;
      if (u <= 0) return null;
      const x = (ec50 * (2 ** (1 / s) - 1) ** (1 / h)) / u ** (1 / h);
      return x > 0 ? x : null;
    }
    case "hyperbola": {
      const bmax = c("Bmax");
      const kd = c("Kd");
      if (bmax == null || kd == null || bmax === y) return null;
      const x = (y * kd) / (bmax - y);
      return x > 0 ? x : null;
    }
    case "one-phase-decay": {
      const y0 = c("Y0");
      const p = c("Plateau");
      const k = c("K");
      if (y0 == null || p == null || k == null || k === 0 || y0 === p) return null;
      const q = (y - p) / (y0 - p);
      if (q <= 0) return null;
      return -Math.log(q) / k;
    }
    case "one-phase-association": {
      const y0 = c("Y0");
      const p = c("Plateau");
      const k = c("K");
      if (y0 == null || p == null || k == null || k === 0 || p === y0) return null;
      const q = (y - y0) / (p - y0);
      if (q <= 0 || q >= 1) return null;
      return -Math.log(1 - q) / k;
    }
    case "exponential-growth": {
      const y0 = c("Y0");
      const k = c("K");
      if (y0 == null || k == null || k === 0) return null;
      const q = y / y0;
      if (q <= 0) return null;
      return Math.log(q) / k;
    }
    case "michaelis-menten": {
      const vmax = c("Vmax");
      const km = c("Km");
      if (vmax == null || km == null || vmax === y) return null;
      const x = (y * km) / (vmax - y);
      return x > 0 ? x : null;
    }
    case "allosteric-sigmoidal": {
      const vmax = c("Vmax");
      const khalf = c("Khalf");
      const h = c("HillSlope");
      if (vmax == null || khalf == null || h == null || h === 0 || vmax === y) return null;
      const q = y / (vmax - y);
      if (q <= 0) return null;
      const x = khalf * q ** (1 / h);
      return x > 0 ? x : null;
    }
    default:
      return null;
  }
}

// ── Plan 26: comparing models ────────────────────────────────────────────
/** Nested model pairs (the simpler model is the complex one with parameters
 *  fixed): line ⊂ quadratic ⊂ cubic; the 3PLs ⊂ 4PL (HillSlope = ±1);
 *  4PL ⊂ 5PL (S = 1); 3PL ⊂ 5PL. Anything else (line vs hyperbola, 4PL vs
 *  hyperbola…) is not nested — the extra-sum-of-squares F test is invalid
 *  there, and only the AICc comparison is reported. */
const NESTED_PAIRS: [NonlinearModel, NonlinearModel][] = [
  ["line", "quadratic"],
  ["line", "cubic"],
  ["quadratic", "cubic"],
  // Plan 29: the polynomial ladder continues — each higher order is the
  // lower one with its top coefficients fixed at zero. The segmental
  // line is NOT nested with the line for an F test: at B2 = 0 the
  // breakpoint X0 is unidentified (the Davies problem), so the test's
  // degrees of freedom are undefined — AICc only.
  ["line", "quartic"],
  ["line", "quintic"],
  ["quadratic", "quartic"],
  ["quadratic", "quintic"],
  ["cubic", "quartic"],
  ["cubic", "quintic"],
  ["quartic", "quintic"],
  ["agonist-3pl-logx", "sigmoidal-4pl-logx"],
  ["inhibitor-3pl-logx", "sigmoidal-4pl-logx"],
  ["sigmoidal-4pl-logx", "asymmetric-5pl-logx"],
  ["agonist-3pl-logx", "asymmetric-5pl-logx"],
  ["inhibitor-3pl-logx", "asymmetric-5pl-logx"],
  ["sigmoidal-4pl-x", "asymmetric-5pl-x"],
];
export function nestedPair(
  a: NonlinearModel,
  b: NonlinearModel,
): { simpler: NonlinearModel; complex: NonlinearModel } | null {
  for (const [s, c] of NESTED_PAIRS) {
    if ((a === s && b === c) || (a === c && b === s)) return { simpler: s, complex: c };
  }
  return null;
}

/** AICc (the small-sample-corrected AIC) from a fit's residual sum of
 *  squares, point count and parameter count; `null` when n − k − 1 ≤ 0. */
export function aicc(ss: number, n: number, k: number): number | null {
  if (!Number.isFinite(ss) || n - k - 1 <= 0) return null;
  return n * Math.log(ss / n) + 2 * k + (2 * k * (k + 1)) / (n - k - 1);
}

// ── Plan 26: weighting ───────────────────────────────────────────────────
const WEIGHT_LABEL: Record<Exclude<NonlinearWeightScheme, "none">, string> = {
  "1/y": "1/Y",
  "1/y2": "1/Y²",
  "1/x": "1/X",
  "1/x2": "1/X²",
  "1/sd2": "1/SD²",
};

/** The per-point weights for a scheme, from the fitted points. 1/SD² takes
 *  each fitted row's replicate SD — the SD across the table's Y columns on
 *  that row (so the table needs ≥ 2 Y columns, and every fitted row needs ≥
 *  2 values with a nonzero SD). 1/Y needs Y > 0; 1/X needs X > 0; 1/Y² and
 *  1/X² need Y ≠ 0 / X ≠ 0 (they are fine for negative values arithmetically
 *  but, as a variance model, assume scatter grows with |Y| / |X|). */
function computeWeights(
  scheme: NonlinearWeightScheme,
  first: { xs: number[]; ys: number[]; rows: number[] },
  yCols: Column[],
): { weights?: number[] } | { error: string } {
  switch (scheme) {
    case "none":
      return {};
    case "1/y":
      if (first.ys.some((y) => y <= 0))
        return { error: "Weighting by 1/Y needs all Y > 0 — some fitted Y are ≤ 0." };
      return { weights: first.ys.map((y) => 1 / y) };
    case "1/y2":
      if (first.ys.some((y) => y === 0))
        return { error: "Weighting by 1/Y² needs Y ≠ 0 — some fitted Y are 0." };
      return { weights: first.ys.map((y) => 1 / (y * y)) };
    case "1/x":
      if (first.xs.some((x) => x <= 0))
        return { error: "Weighting by 1/X needs all X > 0 — some fitted X are ≤ 0." };
      return { weights: first.xs.map((x) => 1 / x) };
    case "1/x2":
      if (first.xs.some((x) => x === 0))
        return { error: "Weighting by 1/X² needs X ≠ 0 — some fitted X are 0." };
      return { weights: first.xs.map((x) => 1 / (x * x)) };
    case "1/sd2": {
      if (yCols.length < 2)
        return { error: "Weighting by 1/SD² needs replicates — at least two Y data sets measuring the same thing." };
      const weights: number[] = [];
      for (const r of first.rows) {
        const values = yCols.map((c) => c.byRow[r]).filter((v): v is number => v != null);
        if (values.length < 2)
          return { error: "Weighting by 1/SD² needs at least two Y values on every fitted row — some rows have fewer." };
        const mean = values.reduce((s, v) => s + v, 0) / values.length;
        const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
        if (sd === 0) return { error: "Weighting by 1/SD² needs a nonzero replicate SD — some rows' replicates agree exactly." };
        weights.push(1 / (sd * sd));
      }
      return { weights };
    }
  }
}

/** A global fit's coefficients for one series: shared parameters as fitted,
 *  per-series parameters with their ` (Series)` suffix stripped, other
 *  series' parameters dropped. The overlays draw one curve per series from
 *  these. `sets` is the fit's series list (a display term like "Asymmetry
 *  (S)" ends in a parenthesis too, so only a suffix naming a series counts). */
export function coefficientsForSet(
  coefficients: RegressionCoefficient[],
  setName: string,
  sets: string[],
): RegressionCoefficient[] {
  const out: RegressionCoefficient[] = [];
  for (const c of coefficients) {
    const own = ` (${setName})`;
    if (c.term.endsWith(own)) {
      out.push({ ...c, term: c.term.slice(0, -own.length) });
      continue;
    }
    if (sets.some((s) => s !== setName && c.term.endsWith(` (${s})`))) continue;
    out.push(c);
  }
  return out;
}
//
// Plan 08 adds Prism's "Exponential" family (one/two-phase decay, plateau
// followed by decay, one-phase association, exponential growth) to the same
// runner: same result shape, plus a fitted equation and a note naming the
// data-driven starting values. A fitted K ≤ 0 leaves its half-life /
// doubling time null (see the derived expressions) and is noted, not hidden.
const isExponential = (model: NonlinearModel) => EXPONENTIAL_MODELS.includes(model);
const isEnzyme = (model: NonlinearModel) => ENZYME_MODELS.includes(model);
/** Binding competition (plan 28): the one-site Fit logIC50 (inhibitor 3PL)
 *  and the two-site models, which the Fit-Ki toggle applies to. */
const isTwoSiteCompetition = (model: NonlinearModel) =>
  model === "two-site-competition-logx" || model === "two-site-competition-x";
const isCompetition = (model: NonlinearModel) =>
  model === "inhibitor-3pl-logx" || isTwoSiteCompetition(model) || model === "homologous-competition-logx";

/** A coefficient's estimate, looked up by its equation name ("HillSlope",
 *  "S") — results store the display name ("Hill slope", "Asymmetry (S)"). */
const coefOf = (coefficients: RegressionCoefficient[], term: string) =>
  coefficients.find((c) => c.term === termLabel(term))?.estimate ?? null;

/** The fitted equation, from the fitted coefficients (4 significant figures,
 *  like the rest of Titer's display). Only the exponential models carry one —
 *  the older models keep their pinned result shape. */
function equation(
  model: NonlinearModel,
  coefficients: RegressionCoefficient[],
  ligandConcentration?: number,
): string | undefined {
  const y0 = coefOf(coefficients, "Y0");
  const plateau = coefOf(coefficients, "Plateau");
  const k = coefOf(coefficients, "K");
  switch (model) {
    case "one-phase-decay":
      if (y0 == null || plateau == null || k == null) return undefined;
      return `Y = (${num(y0)} − ${num(plateau)})·exp(−${num(k)}·X) + ${num(plateau)}`;
    case "two-phase-decay": {
      const span1 = coefOf(coefficients, "Span1");
      const k1 = coefOf(coefficients, "K1");
      const span2 = coefOf(coefficients, "Span2");
      const k2 = coefOf(coefficients, "K2");
      if (plateau == null || span1 == null || k1 == null || span2 == null || k2 == null) return undefined;
      return `Y = ${num(plateau)} + ${num(span1)}·exp(−${num(k1)}·X) + ${num(span2)}·exp(−${num(k2)}·X)`;
    }
    case "plateau-decay": {
      const x0 = coefOf(coefficients, "X0");
      if (x0 == null || y0 == null || plateau == null || k == null) return undefined;
      return `Y = ${num(y0)} for X < ${num(x0)}; Y = ${num(plateau)} + (${num(y0)} − ${num(plateau)})·exp(−${num(k)}·(X − ${num(x0)})) for X ≥ ${num(x0)}`;
    }
    case "one-phase-association":
      if (y0 == null || plateau == null || k == null) return undefined;
      return `Y = ${num(y0)} + (${num(plateau)} − ${num(y0)})·(1 − exp(−${num(k)}·X))`;
    case "exponential-growth":
      if (y0 == null || k == null) return undefined;
      return `Y = ${num(y0)}·exp(${num(k)}·X)`;
    case "michaelis-menten": {
      const vmax = coefOf(coefficients, "Vmax");
      const km = coefOf(coefficients, "Km");
      if (vmax == null || km == null) return undefined;
      return `Y = ${num(vmax)}·X / (${num(km)} + X)`;
    }
    case "allosteric-sigmoidal": {
      const vmax = coefOf(coefficients, "Vmax");
      const khalf = coefOf(coefficients, "Khalf");
      const h = coefOf(coefficients, "HillSlope");
      if (vmax == null || khalf == null || h == null) return undefined;
      return `Y = ${num(vmax)}·X^${num(h)} / (${num(khalf)}^${num(h)} + X^${num(h)})`;
    }
    case "substrate-inhibition": {
      const vmax = coefOf(coefficients, "Vmax");
      const km = coefOf(coefficients, "Km");
      const ki = coefOf(coefficients, "Ki");
      if (vmax == null || km == null || ki == null) return undefined;
      return `Y = ${num(vmax)}·X / (${num(km)} + X + X²/${num(ki)})`;
    }
    // Binding competition (plan 28).
    case "two-site-competition-logx": {
      const bottom = coefOf(coefficients, "Bottom");
      const top = coefOf(coefficients, "Top");
      const lo1 = coefOf(coefficients, "LogIC50Hi");
      const lo2 = coefOf(coefficients, "LogIC50Lo");
      const frac = coefOf(coefficients, "FractionHi");
      if (bottom == null || top == null || lo1 == null || lo2 == null || frac == null) return undefined;
      // A negative LogIC50 would render as "X − -2"; fold the sign in.
      const sub = (v: number) => (v < 0 ? `X + ${num(-v)}` : `X − ${num(v)}`);
      return (
        `Y = ${num(bottom)} + (${num(top)} − ${num(bottom)})·(${num(frac)}/(1 + 10^(${sub(lo1)})) + ` +
        `${num(1 - frac)}/(1 + 10^(${sub(lo2)})))`
      );
    }
    case "two-site-competition-x": {
      const bottom = coefOf(coefficients, "Bottom");
      const top = coefOf(coefficients, "Top");
      const ic1 = coefOf(coefficients, "IC50Hi");
      const ic2 = coefOf(coefficients, "IC50Lo");
      const frac = coefOf(coefficients, "FractionHi");
      if (bottom == null || top == null || ic1 == null || ic2 == null || frac == null) return undefined;
      return (
        `Y = ${num(bottom)} + (${num(top)} − ${num(bottom)})·(${num(frac)}/(1 + X/${num(ic1)}) + ` +
        `${num(1 - frac)}/(1 + X/${num(ic2)}))`
      );
    }
    case "homologous-competition-logx": {
      const bmax = coefOf(coefficients, "Bmax");
      const logKd = coefOf(coefficients, "LogKd");
      const bottom = coefOf(coefficients, "Bottom");
      if (bmax == null || logKd == null || bottom == null || ligandConcentration == null) return undefined;
      return `Y = ${num(bmax)}·${num(ligandConcentration)}/(${num(ligandConcentration)} + 10^X + 10^${num(logKd)}) + ${num(bottom)}`;
    }
    default:
      return undefined;
  }
}

/** The data-driven starting values the R fit used, in the same terms as
 *  modelSpec's `start` list — recomputed here from the fitted points, so the
 *  note always names what nls() actually started from. */
function startingValues(
  model: NonlinearModel,
  xs: number[],
  ys: number[],
  ligandConcentration?: number,
): string {
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const yAtMinX = ys[xs.indexOf(Math.min(...xs))];
  const median = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  switch (model) {
    case "one-phase-decay":
      return `Starting values: Y0 = ${num(yAtMinX)}, Plateau = ${num(minY)}, K = 0.5.`;
    case "two-phase-decay":
      return `Starting values: Plateau = ${num(minY)}, Span1 = ${num(0.6 * (maxY - minY))}, K1 = 1, Span2 = ${num(0.4 * (maxY - minY))}, K2 = 0.1.`;
    case "plateau-decay": {
      const x0 = median(xs);
      const below = ys.filter((_, i) => xs[i] < x0);
      const y0 = below.reduce((s, v) => s + v, 0) / below.length;
      return `Starting values: X0 = ${num(x0)}, Y0 = ${num(y0)}, Plateau = ${num(minY)}, K = 0.5.`;
    }
    case "one-phase-association":
      return `Starting values: Y0 = ${num(yAtMinX)}, Plateau = ${num(maxY)}, K = 0.5.`;
    case "exponential-growth":
      return `Starting values: Y0 = ${num(yAtMinX)}, K = 0.1.`;
    case "michaelis-menten":
      return `Starting values: Vmax = ${num(maxY * 1.1)}, Km = ${num(median(xs.filter((x) => x > 0)))}.`;
    case "allosteric-sigmoidal":
      return `Starting values: Vmax = ${num(maxY * 1.1)}, Khalf = ${num(median(xs.filter((x) => x > 0)))}, Hill slope = 1.`;
    case "substrate-inhibition":
      return `Starting values: Vmax = ${num(maxY * 1.5)}, Km = ${num(median(xs.filter((x) => x > 0)))}, Ki = ${num(Math.max(...xs))}.`;
    // Binding competition (plan 28): the two-site starts are the half-medians
    // (high-affinity from the low-concentration half, low-affinity from the
    // high half, fraction 0.5); the homologous Bmax start rescales the span
    // by ([L] + Kd₀)/[L], since Bmax is the binding at infinite [L].
    case "two-site-competition-logx": {
      const mid = median(xs);
      return (
        `Starting values: Bottom = ${num(minY)}, Top = ${num(maxY)}, ` +
        `LogIC50 (high affinity) = ${num(median(xs.filter((x) => x <= mid)))}, ` +
        `LogIC50 (low affinity) = ${num(median(xs.filter((x) => x > mid)))}, Fraction (high affinity) = 0.5.`
      );
    }
    case "two-site-competition-x": {
      const mid = median(xs);
      // The R start is the geometric mean of each half (see modelSpec) —
      // concentrations are log-spaced in practice, so the geometric mean is
      // the half's centre on the scale the curve lives on.
      const geo = (v: number[]) => 10 ** (v.reduce((s, x) => s + Math.log10(x), 0) / v.length);
      return (
        `Starting values: Bottom = ${num(minY)}, Top = ${num(maxY)}, ` +
        `IC50 (high affinity) = ${num(geo(xs.filter((x) => x <= mid)))}, ` +
        `IC50 (low affinity) = ${num(geo(xs.filter((x) => x > mid)))}, Fraction (high affinity) = 0.5.`
      );
    }
    case "homologous-competition-logx": {
      if (ligandConcentration == null) return "";
      const logKd = median(xs);
      const bmax = ((maxY - minY) * (ligandConcentration + 10 ** logKd)) / ligandConcentration;
      return `Starting values: Bmax = ${num(bmax)}, LogKd = ${num(logKd)}, Bottom = ${num(minY)}.`;
    }
    default:
      return "";
  }
}

/** Warnings the fit itself cannot express: a fitted K ≤ 0 makes its
 *  half-life / doubling time undefined (the derived row is null), and
 *  K1 ≈ K2 leaves a two-phase fit unidentifiable. Enzyme models (plan 09):
 *  a fitted Km/Ki ≤ 0 or Hill slope ≤ 0 is reported, not hidden (Vmax/Km
 *  is null when Km ≤ 0), and a substrate range that does not bracket Km /
 *  Khalf warns that the constant is imprecisely estimated. `xs` is the
 *  fitted X values (the bracketing check needs them). */
function fitWarnings(model: NonlinearModel, coefficients: RegressionCoefficient[], xs?: number[]): string[] {
  const out: string[] = [];
  const k = coefOf(coefficients, "K");
  if (model === "one-phase-decay" || model === "plateau-decay" || model === "one-phase-association") {
    if (k != null && k <= 0) out.push("Fitted K ≤ 0 — half-life not defined.");
  }
  if (model === "exponential-growth" && k != null && k <= 0) out.push("Fitted K ≤ 0 — doubling time not defined.");
  if (model === "two-phase-decay") {
    const k1 = coefOf(coefficients, "K1");
    const k2 = coefOf(coefficients, "K2");
    if (k1 != null && k1 <= 0) out.push("Fitted K1 ≤ 0 — half-life (fast) not defined.");
    if (k2 != null && k2 <= 0) out.push("Fitted K2 ≤ 0 — half-life (slow) not defined.");
    if (k1 != null && k2 != null && Math.abs(k1 - k2) / Math.max(Math.abs(k1), Math.abs(k2), 1e-12) < 0.01)
      out.push("K1 ≈ K2 — the two phases are nearly identical, so the separate phase parameters are poorly identified.");
  }
  if (isEnzyme(model)) {
    const km = coefOf(coefficients, "Km");
    const ki = coefOf(coefficients, "Ki");
    const vmax = coefOf(coefficients, "Vmax");
    if (km != null && km <= 0)
      out.push("Fitted Km ≤ 0 — the data do not constrain Km; check the concentration range.");
    if (ki != null && ki <= 0)
      out.push("Fitted Ki ≤ 0 — the data do not constrain Ki; check the concentration range.");
    if (model === "michaelis-menten" && km != null && km <= 0 && vmax != null)
      out.push("Vmax/Km is not defined when Km ≤ 0.");
    if (model === "allosteric-sigmoidal") {
      const h = coefOf(coefficients, "HillSlope");
      const khalf = coefOf(coefficients, "Khalf");
      if (h != null && h <= 0)
        out.push("Fitted Hill slope ≤ 0 — the curve decreases, which contradicts the allosteric model.");
      if (xs && khalf != null && khalf > 0) {
        const positive = xs.filter((x) => x > 0);
        if (Math.max(...xs) < khalf || Math.min(...positive) > khalf)
          out.push("The substrate range does not bracket Khalf — Khalf is imprecisely estimated.");
      }
    } else if (xs && km != null && km > 0) {
      const positive = xs.filter((x) => x > 0);
      if (Math.max(...xs) < km || Math.min(...positive) > km)
        out.push("The substrate range does not bracket Km — Km is imprecisely estimated.");
    }
  }
  if (isTwoSiteCompetition(model)) {
    // A fraction at either edge means one site explains the data — the
    // second LogIC50 is unidentifiable, so the one-site fit is preferred.
    const frac = coefOf(coefficients, "FractionHi");
    if (frac != null && (frac <= 0.02 || frac >= 0.98))
      out.push(
        "The high-affinity fraction is near 0 or 1 — the data are consistent with one site; prefer the one-site fit.",
      );
  }
  if (model === "homologous-competition-logx") {
    const bmax = coefOf(coefficients, "Bmax");
    if (bmax != null && bmax <= 0)
      out.push("Fitted Bmax ≤ 0 — the data do not support this binding model.");
  }
  return out;
}

/** The fit block's rows from each set's derived quantities and goodness of
 *  fit: each derived value, then its 95% CI row when the spec defines one,
 *  then R², Sy.x, sum of squares, df and N (one value per set). */
function fitRows(derivedSets: DerivedRow[][], statsSets: StatRow[][]): FitRow[] {
  const rows: FitRow[] = [];
  (derivedSets[0] ?? []).forEach((d, j) => {
    rows.push({ label: d.label, values: derivedSets.map((ds) => ds[j]?.value ?? null) });
    if (d.low !== undefined && d.high !== undefined)
      rows.push({
        label: "95% CI",
        ranges: derivedSets.map((ds) => [ds[j]?.low ?? null, ds[j]?.high ?? null] as [number | null, number | null]),
      });
  });
  for (const s of statsSets[0] ?? []) {
    rows.push({
      label: s.label,
      values: statsSets.map((ss) => ss.find((t) => t.label === s.label)?.value ?? null),
    });
  }
  return rows;
}

/** R: `interp(m, yu, lo, hi, pos)`, the X the fitted curve `m` gives each Y of `yu` (`ix_i`):
 *  the lowest one within the standards' X (`lo` to `hi`), else below them, else above them, as
 *  far again as their width (for a curve of X > 0, `pos`, a tenth of `lo` and ten times `hi`);
 *  NA when the curve never reaches that Y there. (Upstream 1.0.7, verbatim — its tight
 *  uniroot tolerance is what pins the interpolated values.) */
const R_INTERP =
  `interp<-function(m,yu,lo,hi,pos){fx<-function(x)as.numeric(predict(m,newdata=data.frame(x=x)))\n` +
  `root<-function(v,a,b){g<-seq(a,b,length.out=401);d<-fx(g)-v;i<-which(d[-1]*d[-length(d)]<=0)[1]\n` +
  `if(is.na(i))NA else if(d[i]==0)g[i] else uniroot(function(x)fx(x)-v,g[c(i,i+1)],tol=(b-a)*1e-12)$root}\n` +
  `w<-hi-lo;x<-sapply(yu,function(v){r<-root(v,lo,hi)\n` +
  `if(is.na(r))r<-root(v,if(pos)lo/10 else lo-w,lo);if(is.na(r))r<-root(v,hi,if(pos)hi*10 else hi+w);r})\n` +
  `setNames(x,paste0("ix_",seq_along(x)-1))}`;

/** R that, after `fitStatements`, evaluates the fitted curve and its 95%
 *  confidence band on a grid (`fg`, `lo`, `up`), defines the scalar
 *  curve/band functions (`f`, `fu`, `fl`), and inverts them for every unknown
 *  in `u` — `xi` the interpolated X, `li`/`hi` its 95% CI (NA when the curve
 *  or band never reaches the unknown). The grid covers the same extended
 *  range the point-estimate search covers, so extrapolated unknowns get a CI
 *  too. (Plan 02's band inversion, kept from our fork: upstream has no CIs.) */
function interpolationCode(spec: ModelSpec, unknowns: number[], lo: number, hi: number): string {
  const u = `u<-c(${unknowns.join(",")});`;
  const w = hi - lo;
  const [gLo, gHi] = spec.positiveX || spec.nonNegativeX ? [lo / 10, hi * 10] : [lo - w, hi + w];
  const grid = `xg<-seq(${gLo},${gHi},length.out=200);`;
  // Curve + band, per fitter kind.
  const band =
    spec.kind === "lm"
      ? `f<-function(xv) as.numeric(predict(m,newdata=data.frame(x=xv)));` +
        `pr<-predict(m,newdata=data.frame(x=xg),interval="confidence");fg<-pr[,"fit"];lo<-pr[,"lwr"];up<-pr[,"upr"];` +
        `fu<-function(xv) as.numeric(predict(m,newdata=data.frame(x=xv),interval="confidence")[,"upr"]);` +
        `fl<-function(xv) as.numeric(predict(m,newdata=data.frame(x=xv),interval="confidence")[,"lwr"]);`
      : `${spec.curveFn};` +
        `f<-function(xv) g(xv,cf);` +
        `V<-vcov(m);tc<-qt(0.975,df);np<-length(cf);` +
        // Numeric gradient of the curve w.r.t. its parameters (central
        // differences), then the delta-method standard error of the fit.
        `gr<-function(xv){h<-1e-6*pmax(1,abs(cf));sapply(seq_along(cf),function(j){e<-numeric(np);e[j]<-h[j];(g(xv,cf+e)-g(xv,cf-e))/(2*h[j])})};` +
        `se<-function(xv){gg<-gr(xv);sqrt(sum((gg%*%V)*gg))};` +
        `fg<-g(xg,cf);se_g<-sapply(xg,se);lo<-fg-tc*se_g;up<-fg+tc*se_g;` +
        `fu<-function(xv) f(xv)+tc*se(xv);` +
        `fl<-function(xv) f(xv)-tc*se(xv);`;
  // First root of h on the grid, scanning from the lowest X upward and refined by
  // uniroot — so a non-monotonic curve reports its first crossing. NA when the
  // curve (or band edge) never reaches the value on the grid.
  const root = `firstRoot<-function(vals,fn){for(i in 1:(length(xg)-1)){a<-vals[i];b<-vals[i+1];if(is.na(a)||is.na(b)) next;if(a==0) return(xg[i]);if(a*b<0) return(uniroot(fn,c(xg[i],xg[i+1]))$root)};NA_real_};`;
  const loop =
    `xi<-rep(NA_real_,length(u));li<-rep(NA_real_,length(u));hi<-rep(NA_real_,length(u));` +
    `inc<-fg[length(fg)]>fg[1];` +
    `for(k in seq_along(u)){y0<-u[k];` +
    `xi[k]<-firstRoot(fg-y0,function(xv) f(xv)-y0);` +
    // A band edge can cross a Y the curve itself never reaches — only invert
    // the band when the point estimate exists. On a rising curve the upper
    // band reaches Y first (the CI's lower bound); on a falling curve the
    // reverse. A bound the band never reaches stays NA (unbounded in range).
    // (The trailing `;`: R needs a separator after a `}`-closed loop before
    // the next expression — `}c(...)` is a parse error.)
    `if(!is.na(xi[k])){rUp<-firstRoot(up-y0,function(xv) fu(xv)-y0);rLo<-firstRoot(lo-y0,function(xv) fl(xv)-y0);` +
    `if(inc){li[k]<-rUp;hi[k]<-rLo}else{li[k]<-rLo;hi[k]<-rUp}}};`;
  return u + grid + band + root + loop;
}

/** R comparing two data sets' curves (`x0`, `y0` and `x1`, `y1`): each fitted on its own
 *  (the full model), then the reduced one — the midpoint shared, or one curve for both —
 *  and the extra sum-of-squares F test between them. (Upstream 1.0.7's comparison,
 *  re-pointed onto the shared fit layer: each set is fitted with the spec's own fit
 *  string, and its entries are captured with its prefix before the next fit.) */
function comparisonRCode(
  spec: ModelSpec,
  s0: { xs: number[]; ys: number[] },
  s1: { xs: number[]; ys: number[] },
  compare: "ec50" | "all",
): string {
  const { expr, midpoint } = spec.dose!;
  // Every parameter but the shared midpoint, one per data set (`g`).
  const own = spec.terms.filter((t) => t !== midpoint);
  const indexed = own.reduce((e, t) => e.replace(new RegExp(`\\b${t}\\b`, "g"), `${t}[g]`), expr);
  const start = own.map((t) => `${t}=c(c0[["${t}"]],c1[["${t}"]])`).join(",");
  // The shared midpoint starts between the two, else at either one's (curves far apart
  // may converge only from there); the best of the fits that converge is kept.
  const reduced =
    compare === "all"
      ? `x<-c(x0,x1);y<-c(y0,y1);${spec.fit}`
      : `x<-c(x0,x1);y<-c(y0,y1);g<-rep(1:2,c(length(x0),length(x1)));c0<-coef(m0);c1<-coef(m1)\n` +
        `ms<-lapply(c(mean(c(c0[["${midpoint}"]],c1[["${midpoint}"]])),c0[["${midpoint}"]],c1[["${midpoint}"]]),` +
        `function(s)tryCatch(nls(y~${indexed},start=list(${start},${midpoint}=s),control=nls.control(maxiter=200)),error=function(e)NULL))\n` +
        `ms<-Filter(Negate(is.null),ms);if(!length(ms))stop("no fit with a shared midpoint")\n` +
        `m<-ms[[which.min(sapply(ms,function(f)sum(residuals(f)^2)))]]`;
  // One set's fit, captured with its prefix (`a`/`b`) before the next fit overwrites `m`.
  const setBlock = (xVar: string, yVar: string, prefix: string) =>
    `x<-${xVar};y<-${yVar};${spec.fit};${fitSummaryStatements(spec)}` +
    `${prefix.replace(/_$/, "")}<-c(${fitEntries(spec, prefix)});`;
  return (
    `x0<-${rVec(s0.xs)};y0<-${rVec(s0.ys)};x1<-${rVec(s1.xs)};y1<-${rVec(s1.ys)};` +
    `${setBlock("x0", "y0", "a_")}m0<-m;${setBlock("x1", "y1", "b_")}m1<-m;${reduced}\n` +
    `ssf<-sum(residuals(m0)^2)+sum(residuals(m1)^2);dff<-df.residual(m0)+df.residual(m1)\n` +
    `ssr<-sum(residuals(m)^2);dfr<-df.residual(m);Fc<-((ssr-ssf)/(dfr-dff))/(ssf/dff)\n` +
    `c(a,b,F=Fc,dfn=dfr-dff,dfd=dff,p=pf(Fc,dfr-dff,dff,lower.tail=FALSE))`
  );
}

/** R fitting two models to the same points and comparing them: each fit's
 *  entries (prefixed `a_`/`b_`), then the extra-sum-of-squares F test (only
 *  when the pair is nested — `nested` says which fit is simpler and by how
 *  many parameters) and both AICc values. */
function compareModelsRCode(
  xs: number[],
  ys: number[],
  specA: ModelSpec,
  specB: ModelSpec,
  weights: number[] | undefined,
  nested: { simplerIsA: boolean; dfn: number } | null,
): string {
  const wAssign = weights ? `w<-${rVec(weights)};` : "";
  const weighted = !!weights;
  const codeA = fitStatementsForSpec(xs, ys, specA, undefined, wAssign, weighted);
  const codeB = fitStatementsForSpec(xs, ys, specB, undefined, wAssign, weighted);
  const fTest = nested
    ? `ssS<-ss${nested.simplerIsA ? "A" : "B"};ssC<-ss${nested.simplerIsA ? "B" : "A"};dfC<-df${nested.simplerIsA ? "B" : "A"};` +
      `Fc<-((ssS-ssC)/${nested.dfn})/(ssC/dfC);p<-pf(Fc,${nested.dfn},dfC,lower.tail=FALSE);`
    : `Fc<-NA_real_;p<-NA_real_;dfC<-NA_real_;`;
  return (
    `${codeA}ssA<-ss;dfA<-df;vA<-c(${fitEntries(specA, "a_")});` +
    `${codeB}ssB<-ss;dfB<-df;vB<-c(${fitEntries(specB, "b_")});` +
    `n<-length(x);` +
    `aicc<-function(ss,n,k) if(n-k-1>0) n*log(ss/n)+2*k+2*k*(k+1)/(n-k-1) else NA_real_;` +
    `aiccA<-aicc(ssA,n,${specA.terms.length});aiccB<-aicc(ssB,n,${specB.terms.length});` +
    fTest +
    `c(vA,vB,F=Fc,dfn=${nested ? nested.dfn : 0},dfd=dfC,p=p,aiccA=aiccA,aiccB=aiccB,ssA=ssA,ssB=ssB)`
  );
}

/** Two models fitted to the same data and compared (plan 26): the
 *  coefficients table reports the primary model; the comparison model's
 *  sum of squares, the F test (nested pairs only) and both AICc values are
 *  stats rows. */
async function compareModels(
  params: NonlinearRegressionParams,
  model: NonlinearModel,
  spec: ModelSpec,
  first: { xCol: Column; yCol: Column; xs: number[]; ys: number[]; rows: number[] },
  xCol: Column,
  weights: number[] | undefined,
  titles: (string | null)[],
): Promise<AnalysisOutcome> {
  const otherModel = params.compareModel!;
  const specB = modelSpec(otherModel);
  const nested = nestedPair(model, otherModel);
  const dfn = nested ? Math.abs(spec.terms.length - specB.terms.length) : 0;
  const nestedValid = nested !== null && dfn > 0;
  let v: RVector;
  try {
    v = await evalNamedVector(
      compareModelsRCode(
        first.xs,
        first.ys,
        spec,
        specB,
        weights,
        nestedValid ? { simplerIsA: nested!.simpler === model, dfn } : null,
      ),
    );
  } catch (err) {
    return fitError(err, model);
  }
  const parsedA = parseFit(v, spec, first.xs.length, termLabel, "a_");
  const aiccA = v.aiccA ?? null;
  const aiccB = v.aiccB ?? null;
  const delta = aiccA != null && aiccB != null ? aiccA - aiccB : null;
  const stats: StatRow[] = [
    ...(nestedValid
      ? [
          { label: "F", value: v.F ?? null },
          { label: "DFn", value: v.dfn ?? null },
          { label: "DFd", value: v.dfd ?? null },
          pRow("P value", v.p ?? null),
        ]
      : []),
    { label: "AICc", value: aiccA },
    { label: "ΔAICc (primary − comparison)", value: delta },
    { label: "Sum of squares (comparison model)", value: v.ssB ?? null },
  ];
  const complex = nestedValid ? nested!.complex : null;
  const fSentence =
    nestedValid && v.p != null
      ? v.p < 0.05
        ? `the extra parameters of the “${MODEL_LABEL[complex!]}” model are justified (F = ${num(v.F)}, P = ${num(v.p)}).`
        : `the extra parameters of the “${MODEL_LABEL[complex!]}” model are not justified (F = ${num(v.F)}, P = ${num(v.p)}).`
      : "";
  const preferred = delta == null ? null : delta < 0 ? model : delta > 0 ? otherModel : null;
  const extraNotes =
    `Compared with “${MODEL_LABEL[otherModel]}”. ` +
    (nestedValid
      ? `Extra sum-of-squares F test: ${fSentence} `
      : `The models are not nested, so no F test applies — the AICc comparison is the valid one. `) +
    (preferred
      ? `AICc prefers “${MODEL_LABEL[preferred]}” (ΔAICc = ${num(delta)}).`
      : delta === 0
        ? "AICc ties the two models."
        : "AICc could not be computed (too few points for the correction).");
  const sets = [{ name: first.yCol.name, xs: first.xs, ys: first.ys }];
  return assembleResult(model, spec, xCol, first.yCol, undefined, sets, [parsedA], [], [], titles, first, undefined, undefined, params, stats, extraNotes);
}

/** The default shared parameters for a global fit (plan 26): the dose
 *  midpoint + HillSlope when the model has them (Prism's typical 4PL
 *  default: share LogEC50 + HillSlope, fit Bottom/Top per curve); models
 *  without a midpoint share nothing by default. */
function defaultSharedParams(spec: ModelSpec): string[] {
  const out: string[] = [];
  if (spec.dose) out.push(spec.dose.midpoint);
  if (spec.terms.includes("HillSlope")) out.push("HillSlope");
  return out;
}

/** A global (shared-parameter) fit (plan 26): several Y series fitted in one
 *  stacked nls() call through runGlobalFit. Single-series fits supply the
 *  starts (a shared start is their mean); the stacked formula shares the
 *  chosen parameters, indexes the rest by `g`, and substitutes fixed ones. */
async function runGlobalNonlinear(
  columns: Column[],
  params: NonlinearRegressionParams | undefined,
  model: NonlinearModel,
  spec: ModelSpec,
  first: { xCol: Column; yCol: Column; xs: number[]; ys: number[]; rows: number[] },
  xCol: Column,
): Promise<AnalysisOutcome> {
  const fixed = params?.fixed ?? {};
  const bounds = params?.bounds ?? {};
  const extraNames = params!.globalY!;
  const series: { name: string; xs: number[]; ys: number[] }[] = [
    { name: first.yCol.name, xs: first.xs, ys: first.ys },
  ];
  const yCols: Column[] = [first.yCol];
  for (const name of extraNames) {
    const p = prepareFit(columns, name, model, Object.keys(fixed).length);
    if ("error" in p) return p;
    series.push({ name, xs: p.xs, ys: p.ys });
    yCols.push(p.yCol);
  }
  // A series that will not fit alone will not fit globally either. The
  // starts come from the same constrained fits (fixed/bounded parameters
  // applied), so a held parameter's value shapes the other starts too.
  const singles: { coefficients: RegressionCoefficient[] }[] = [];
  for (const s of series) {
    try {
      singles.push(await fitModelSpec(s.xs, s.ys, spec, "", termLabel, { fixed, bounds }));
    } catch (err) {
      return {
        error: `The “${s.name}” curve could not be fitted on its own (${err instanceof Error ? err.message : String(err)}). Fit each data set separately first.`,
      };
    }
  }
  const vars = formulaVariables(spec);
  const expr = formulaExpr(spec);
  if (!vars || vars.length !== spec.terms.length || expr === undefined)
    return { error: `Global fitting isn't supported for “${MODEL_LABEL[model]}” yet.` };
  const shared = params!.sharedParams ?? defaultSharedParams(spec);
  const varOfTerm = new Map(spec.terms.map((t, i) => [t, vars[i]!]));
  const termOfVar = new Map(vars.map((v, i) => [v, spec.terms[i]!]));
  // One regex pass (longest names first), so a replacement never matches
  // inside another (`K` inside `K1`, a shared name inside `Name[g]`).
  const replacement = new Map<string, string>();
  for (const term of spec.terms) {
    const v = varOfTerm.get(term)!;
    if (Object.hasOwn(fixed, term)) replacement.set(v, `(${fixed[term]})`);
    else if (shared.includes(term)) replacement.set(v, v);
    else replacement.set(v, `${v}[g]`);
  }
  const alt = [...replacement.keys()].sort((a, b) => b.length - a.length).join("|");
  const formula = expr.replace(new RegExp(`\\b(${alt})\\b`, "g"), (m) => replacement.get(m)!);
  const estOf = (seriesIdx: number, term: string) =>
    singles[seriesIdx].coefficients.find((c) => c.term === termLabel(term))?.estimate ?? null;
  const defs: GlobalParamDef[] = spec.terms
    .filter((t) => !Object.hasOwn(fixed, t))
    .map((term) => {
      const v = varOfTerm.get(term)!;
      const isShared = shared.includes(term);
      return {
        name: v,
        shared: isShared,
        start: () => {
          const ests = series.map((_, i) => estOf(i, term));
          if (ests.some((e) => e == null || !Number.isFinite(e)))
            throw new Error(`Parameter “${term}” has no fitted start value.`);
          const nums = ests as number[];
          return isShared ? nums.reduce((s, e) => s + e, 0) / nums.length : nums;
        },
        ...(Object.hasOwn(bounds, term) ? { lower: bounds[term]![0], upper: bounds[term]![1] } : {}),
      } satisfies GlobalParamDef;
    });
  const def: GlobalModelDef = {
    formula,
    params: defs,
    maxiter: 200,
    evaluate: (coefficients, series, _seriesIndex, x) => {
      // The raw coefficients name variables (`Top[Control]`, `h`); rename
      // them to this series' display terms before evaluating.
      const perSeries: RegressionCoefficient[] = [];
      for (const c of coefficients) {
        const m = c.term.match(/^([^\[]+)\[(.*)\]$/);
        if (m) {
          if (m[2] === series.name)
            perSeries.push({ ...c, term: termLabel(termOfVar.get(m[1]) ?? m[1]) });
        } else perSeries.push({ ...c, term: termLabel(termOfVar.get(c.term) ?? c.term) });
      }
      // Fixed parameters are not fitted, so they are absent from the
      // coefficients — but the curve still needs their values: without
      // them every point evaluates NaN and the per-series R² is NaN.
      for (const [name, value] of Object.entries(fixed))
        perSeries.push({
          term: termLabel(name),
          estimate: value,
          stdError: null,
          t: null,
          p: null,
          low: null,
          high: null,
        });
      // The homologous curve needs [L] (a constant of its equation).
      return evaluateCurve(model, perSeries, x, params?.ligandConcentration);
    },
  };
  let result;
  try {
    result = await runGlobalFit(
      series.map((s) => ({ name: s.name, x: s.xs, y: s.ys, covariate: 0 })),
      def,
    );
  } catch (err) {
    return {
      error: `The global fit could not be fitted (${err instanceof Error ? err.message : String(err)}). A shared parameter may be unidentifiable from one data set — try sharing fewer parameters, or fit each data set separately.`,
    };
  }
  // Rename the coefficients to display terms: shared plain, per-series as
  // "Top (Treated)".
  const coefficients = result.coefficients.map((c) => {
    const m = c.term.match(/^([^\[]+)\[(.*)\]$/);
    if (m) return { ...c, term: `${termLabel(termOfVar.get(m[1]) ?? m[1])} (${m[2]})` };
    return { ...c, term: termLabel(termOfVar.get(c.term) ?? c.term) };
  });
  // Fixed parameters are not in the fit — report them as coefficient rows
  // with no standard error (the single-curve paths' precedent), so Span,
  // the notes and the overlay all see what was held.
  for (const name of Object.keys(fixed))
    coefficients.push({
      term: termLabel(name),
      estimate: fixed[name]!,
      stdError: null,
      t: null,
      p: null,
      low: null,
      high: null,
    });
  const sets = series.map((s) => s.name);
  const coefFor = (term: string, setName: string): number | null => {
    const suffixed = coefficients.find((c) => c.term === `${termLabel(term)} (${setName})`)?.estimate ?? null;
    if (suffixed != null) return suffixed;
    return coefficients.find((c) => c.term === termLabel(term))?.estimate ?? null;
  };
  const rows: FitRow[] = [];
  // A shared midpoint gives one EC50/IC50 for all series (from the shared
  // coefficient, its CI on the log when fitted as one).
  const midpoint = spec.dose?.midpoint;
  if (midpoint && shared.includes(midpoint)) {
    const mid = coefficients.find((c) => c.term === termLabel(midpoint));
    if (mid?.estimate != null) {
      const isLog = midpoint.startsWith("Log");
      const label = midpoint === "LogIC50" ? "IC50" : "EC50";
      const value = isLog ? 10 ** mid.estimate : mid.estimate;
      rows.push({ label, values: sets.map(() => value) });
      if (mid.low != null && mid.high != null) {
        const lo = isLog ? 10 ** mid.low : mid.low;
        const hi = isLog ? 10 ** mid.high : mid.high;
        rows.push({ label: "95% CI", ranges: sets.map(() => [lo, hi] as [number | null, number | null]) });
      }
    }
  }
  // Span per series (Top − Bottom), value-only.
  if (spec.terms.includes("Top") && spec.terms.includes("Bottom")) {
    const spans = sets.map((s) => {
      const top = coefFor("Top", s);
      const bottom = coefFor("Bottom", s);
      return top != null && bottom != null ? top - bottom : null;
    });
    if (spans.some((v) => v != null)) rows.push({ label: "Span", values: spans });
  }
  rows.push({ label: "R squared", values: result.perSeries.map((p) => p.rSquared) });
  rows.push({ label: "N", values: result.perSeries.map((p) => p.n) });
  const statOf = (label: string) => result.stats.find((s) => s.label === label)?.value ?? null;
  const stats: StatRow[] = [
    { label: "R squared (all series)", value: statOf("R squared") },
    { label: "Sum of squares", value: statOf("Sum of squares") },
    { label: "Sy.x", value: statOf("Sy.x") },
    { label: "Degrees of freedom", value: statOf("Degrees of freedom") },
  ];
  const perSeriesParams = spec.terms.filter((t) => !shared.includes(t) && !Object.hasOwn(fixed, t));
  const groups = (await describe([xCol, ...yCols])).groups;
  const notes =
    `Global (shared-parameter) fit (“${MODEL_LABEL[model]}”) of ${sets.map((s) => `“${s}”`).join(", ")} on “${xCol.name}”. ` +
    `Shared across data sets: ${shared.length ? shared.map(termLabel).join(", ") : "none"}; ` +
    `fitted separately per data set: ${perSeriesParams.length ? perSeriesParams.map(termLabel).join(", ") : "none"}. ` +
    `95% CIs are asymptotic (from each parameter's standard error). ` +
    `R² is per data set; the sum of squares, Sy.x and degrees of freedom are for all series together.` +
    (Object.keys(fixed).length
      ? ` Fixed: ${Object.entries(fixed)
          .map(([n, v]) => `${termLabel(n)} = ${num(v)}`)
          .join(", ")}.`
      : "") +
    (Object.keys(bounds).length
      ? ` Bounded: ${Object.entries(bounds)
          .map(([n, [lo, hi]]) => `${termLabel(n)} in [${num(lo)}, ${num(hi)}]`)
          .join(", ")}.`
      : "");
  return {
    testType: "nonlinear-regression",
    subtitle: MODEL_LABEL[model],
    stats,
    fit: { sets, rows },
    groups,
    notes,
    coefficients,
    // The homologous curve needs [L] to draw (the overlay reads it off
    // the result) — without it the curve is undefined.
    ...(params?.ligandConcentration != null ? { ligandConcentration: params.ligandConcentration } : {}),
  };
}

export async function runNonlinearRegression(
  columns: Column[],
  params: NonlinearRegressionParams | undefined,
  titles: (string | null)[] = [],
): Promise<AnalysisOutcome> {
  const model = params?.model;
  if (!model || !Object.hasOwn(MODEL_LABEL, model)) return { error: "Choose a standard curve to fit." };

  const { x: xCol, ys: yCols } = splitXY(columns);
  // A Y data set's replicates pool (see datasetColumns): "Control" fits
  // "Control_1..3" together, as Prism does — an imported Prism analysis
  // names its data set, not a column.
  const yCol = params?.y === undefined ? yCols[0] : datasetColumns(yCols, params.y)[0];
  if (!xCol || !yCol) return { error: xyProblem(columns, params?.y)! };
  // Binding competition (plan 28): Fit Ki needs [L] and Kd (the
  // Cheng–Prusoff divisor 1 + [L]/Kd); the homologous model needs [L] (a
  // constant of its equation). Refuse before calling R — a missing constant
  // is a user-facing error, not an R crash. `fitKi` on any other model is
  // ignored (the wizard only offers it on competition fits).
  const isHomologous = model === "homologous-competition-logx";
  const wantsKi = params?.fitKi === true && (model === "inhibitor-3pl-logx" || isTwoSiteCompetition(model));
  const ligand = params?.ligandConcentration;
  const ligandKd = params?.ligandKd;
  const validPositive = (v: number | undefined) => v != null && Number.isFinite(v) && v > 0;
  if (isHomologous && !validPositive(ligand))
    return {
      error:
        "Enter the radioligand concentration [L] (greater than 0, in the same units as X) to fit the homologous competition model.",
    };
  if (wantsKi && (!validPositive(ligand) || !validPositive(ligandKd)))
    return {
      error:
        "Enter the radioligand concentration [L] and Kd (both greater than 0, in the same units as X) to calculate Ki — Ki = IC50 / (1 + [L]/Kd).",
    };
  const kiDivisor = wantsKi ? 1 + ligand! / ligandKd! : undefined;
  const spec = modelSpec(model, {
    ...(kiDivisor != null ? { kiDivisor } : {}),
    ...(isHomologous ? { ligandConcentration: ligand } : {}),
  });
  // A two-site fit that does not converge says so plainly (plan 28): the
  // likeliest cause is data with a single phase, not a numerical quirk.
  const twoSiteError: AnalysisOutcome = {
    error: "Two-site fit did not converge — try the one-site fit first, or check that the curve shows two clear phases.",
  };

  // ── Plan 26 validation (all combinations refused up front, plainly) ──
  const weightsScheme = params?.weights ?? "none";
  const fixed = params?.fixed ?? {};
  const bounds = params?.bounds ?? {};
  const fixedNames = Object.keys(fixed);
  const boundNames = Object.keys(bounds);
  for (const name of [...fixedNames, ...boundNames])
    if (!spec.terms.includes(name))
      return { error: `“${name}” is not a parameter of “${MODEL_LABEL[model]}”.` };
  for (const name of fixedNames)
    if (Object.hasOwn(bounds, name))
      return { error: `“${name}” cannot be both fixed and bounded — fix it or bound it, not both.` };
  for (const [name, [lo, hi]] of Object.entries(bounds))
    if (!(lo < hi)) return { error: `“${name}” bounds [${lo}, ${hi}]: the lower bound must be below the upper.` };
  for (const [name, value] of Object.entries(fixed))
    if (!Number.isFinite(value)) return { error: `Fixed “${name}” must be a finite number.` };
  const comparingModels = params?.compareModel !== undefined;
  if (comparingModels && params.compareModel === model)
    return { error: "Choose a different model to compare with." };
  if (comparingModels && !Object.hasOwn(MODEL_LABEL, params.compareModel!))
    return { error: "Choose a model to compare with." };
  const comparingSets = params?.compareWith !== undefined;
  const global = params?.globalY !== undefined && params.globalY.length > 0;
  if (comparingModels && comparingSets)
    return { error: "Compare with another model or another data set — not both at once." };
  if (comparingModels && (fixedNames.length || boundNames.length))
    return { error: "Fixed parameters and bounds can't be combined with comparing models — compare the unconstrained fits." };
  if (comparingModels && params?.interpolate)
    return { error: "Interpolation can't be combined with comparing models — fit the model first, then interpolate from it." };
  if (global && comparingSets)
    return { error: "A global fit can't be combined with comparing two data sets — the global fit already fits them together." };
  if (global && params?.interpolate)
    return { error: "Interpolation can't be combined with a global fit — fit one curve first, then interpolate from it." };
  if (global && weightsScheme !== "none")
    return { error: "Weighting can't be combined with a global fit yet." };
  if (global && spec.kind === "lm")
    return { error: "Global fitting is only supported for nonlinear (nls) curves, not for line/polynomial fits." };
  if ((fixedNames.length || boundNames.length) && spec.kind === "lm")
    return { error: "Fixing or bounding parameters is only supported for nonlinear (nls) curves, not for line/polynomial fits." };
  if (comparingSets && (weightsScheme !== "none" || fixedNames.length || boundNames.length))
    return { error: "Weighting, fixed parameters and bounds can't be combined with comparing two data sets yet — fit each data set separately." };
  if (global) {
    for (const name of params.globalY!) {
      if (name === yCol.name) return { error: `“${name}” is already the fitted data set — pick other Y data sets for the global fit.` };
      if (!yCols.some((c) => c.name === name)) return { error: xyProblem(columns, name)! };
    }
    if (new Set(params.globalY!).size !== params.globalY!.length)
      return { error: "Each Y data set can appear once in a global fit." };
    for (const p of params.sharedParams ?? [])
      if (!spec.terms.includes(p)) return { error: `“${p}” is not a parameter of “${MODEL_LABEL[model]}”.` };
  }

  const other = comparingSets ? yCols.find((c) => c.name === params.compareWith) : undefined;
  if (comparingSets && !other) return { error: xyProblem(columns, params.compareWith)! };
  if (other && !spec.dose) return { error: "Only dose-response curves can be compared." };

  const first = prepareFit(columns, params?.y, model, fixedNames.length);
  if ("error" in first) return first;
  // Weighting needs the fitted points (and, for 1/SD², their rows).
  const weightResult = computeWeights(weightsScheme, first, yCols);
  if ("error" in weightResult) return weightResult;
  const weights = weightResult.weights;
  const fitOpts: FitOptions = {
    ...(weights ? { weights } : {}),
    ...(fixedNames.length ? { fixed } : {}),
    ...(boundNames.length ? { bounds } : {}),
  };
  let effSpec: ModelSpec;
  let extraAssignments = "";
  try {
    const applied = applyFitOptions(spec, fitOpts);
    effSpec = applied.spec;
    extraAssignments = applied.extraAssignments;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  // The global fit is its own branch (one stacked nls call, not the
  // single-curve paths below).
  if (global) return runGlobalNonlinear(columns, params, model, spec, first, xCol);

  // Comparing two models on the same data (plan 26's `compareModel` — the
  // plan's `compareWith` name is already the other data set's column).
  if (comparingModels) return compareModels(params, model, spec, first, xCol, weights, titles);

  let second: { xs: number[]; ys: number[] } | undefined;
  if (other) {
    const p = prepareFit(columns, params.compareWith, model);
    if ("error" in p) return p;
    second = p;
  }
  const sets = [
    { name: yCol.name, xs: first.xs, ys: first.ys },
    ...(second && other ? [{ name: other.name, xs: second.xs, ys: second.ys }] : []),
  ];

  // The unknowns: the rows holding a Y but no X. A log X's is given as a concentration too.
  const unknowns = params?.interpolate && !other ? yCol.rows.filter((r) => xCol.byRow[r] == null) : [];
  const logX = model.endsWith("-logx");
  const [lo, hi] = [Math.min(...first.xs), Math.max(...first.xs)];

  let v: RVector;
  let retried: boolean | undefined;
  let retryMethod: string | undefined;
  if (other && second) {
    const rCode = comparisonRCode(spec, first, second, params.compare ?? "ec50");
    try {
      v = await evalNamedVector(rCode);
    } catch (err) {
      // R found no best fit (nls stops on its own terms): said plainly, with the likeliest reason.
      if (isTwoSiteCompetition(model)) return twoSiteError;
      if (String(err).includes("shared midpoint")) {
        const midpoint = spec.dose!.midpoint.replace(/^Log/, "");
        return {
          error:
            `These two curves can't be fitted with one ${midpoint}: they are too far apart, or their slopes too ` +
            `different. Ask whether one curve fits both instead, or compare them with a standard-slope (3PL) model.`,
        };
      }
      const logHint = model.endsWith("-logx")
        ? " This model takes X as log(concentration): if X holds concentrations, choose one where X is concentration."
        : "";
      return {
        error: `This curve could not be fitted to these data: they may not follow its shape.${logHint} Try another model or Y data set.`,
      };
    }
  } else if (unknowns.length) {
    const unknownY = unknowns.map((r) => yCol.byRow[r]!);
    // The whole vectors go in, names intact: re-tagging one element
    // (`ix_0=ix[1]`) would paste R's names together ("ix_0.ix_0") and the
    // lookup below would find nothing — upstream passes `ix` whole and
    // renames the concentration vector with sub(), and the CI vectors
    // (li/hi, built unnamed by interpolationCode) are named the same way.
    const interpNames =
      `ix` +
      (logX ? `,setNames(10^ix,sub("ix","ic",names(ix)))` : "") +
      `,setNames(li,sub("ix","il",names(ix))),setNames(hi,sub("ix","ih",names(ix)))`;
    // The effective spec (fixed parameters substituted, weights) drives
    // the interpolation too, so the unknowns are read off the same fit.
    const rCode =
      `${fitStatementsForSpec(first.xs, first.ys, effSpec, undefined, extraAssignments, !!weights)}${R_INTERP}\n` +
      `ix<-interp(m,${rVec(unknownY)},${lo},${hi},${spec.positiveX ? "TRUE" : "FALSE"})\n` +
      `${interpolationCode(effSpec, unknownY, lo, hi)}c(${fitEntries(effSpec)},${interpNames})`;
    try {
      v = await evalNamedVector(rCode);
    } catch (err) {
      if (isTwoSiteCompetition(model)) return twoSiteError;
      return fitError(err, model);
    }
  } else {
    try {
      const fitted = await fitModelSpec(first.xs, first.ys, spec, "", termLabel, fitOpts);
      retried = fitted.retried;
      retryMethod = fitted.retryMethod;
      // Fixed parameters are not in the fit — report them as coefficient
      // rows with no standard error, so the result names what was held.
      for (const name of fixedNames)
        fitted.coefficients.push({
          term: termLabel(name),
          estimate: fixed[name]!,
          stdError: null,
          t: null,
          p: null,
          low: null,
          high: null,
        });
      // One R call already ran; reuse its entries by re-reading them out of
      // the same shape — simplest is to keep the parsed fit and build the
      // result from it (no second R call).
      return assembleResult(model, spec, xCol, yCol, other, sets, [fitted], [], [], titles, first, fitted.retried, fitted.retryMethod, params);
    } catch (err) {
      if (isTwoSiteCompetition(model)) return twoSiteError;
      return fitError(err, model);
    }
  }

  // Comparison / interpolation paths: parse each set's prefixed entries.
  const prefix = other ? ["a_", "b_"] : [""];
  const parsed = sets.map((s, i) => parseFit(v, other ? spec : effSpec, s.xs.length, termLabel, prefix[i]));
  if (other) {
    // Comparison coefficients name their set ("Control — Bottom").
    parsed.forEach((p, i) => {
      p.coefficients.forEach((c) => {
        c.term = `${sets[i].name} — ${c.term}`;
      });
    });
  } else {
    // Interpolation with fixed parameters: the fixed rows belong with the fit.
    for (const name of fixedNames)
      parsed[0].coefficients.push({
        term: termLabel(name),
        estimate: fixed[name]!,
        stdError: null,
        t: null,
        p: null,
        low: null,
        high: null,
      });
  }
  let invertedCI = false;
  const interpolated: InterpolatedRow[] = unknowns.map((r, i) => {
    const x = v[`ix_${i}`] ?? null;
    const low = v[`il_${i}`] ?? null;
    const high = v[`ih_${i}`] ?? null;
    // R2-m10: band inversion on a non-monotonic curve can return the bounds
    // the wrong way round (low > high) — the first band-edge crossing on a
    // limb whose slope disagrees with the curve's overall trend. Never
    // present that as a valid interval: drop the CI (the notes say so).
    const inverted = low != null && high != null && low > high;
    if (inverted) invertedCI = true;
    return {
      label: rowName(titles, r),
      y: yCol.byRow[r]!,
      x,
      ...(logX ? { concentration: v[`ic_${i}`] ?? null } : {}),
      extrapolated: x != null && (x < lo || x > hi),
      low: inverted ? null : low,
      high: inverted ? null : high,
    };
  });
  return assembleResult(model, spec, xCol, yCol, other, sets, parsed, interpolated, v, titles, first, retried, retryMethod, params, [], "", invertedCI);
}

/** The notes' weighting / fixed-parameter / bounds sentences (plan 26): a
 *  weighted or constrained fit is uninterpretable without them. A parameter
 *  fitted at its bound is named — `nls(port)` converges onto the bound
 *  there, which is a property of the fit, not of the data. */
function frameworkNotes(
  params: NonlinearRegressionParams | undefined,
  coefficients: RegressionCoefficient[],
  first: { xs: number[]; ys: number[] },
): string {
  const parts: string[] = [];
  const scheme = params?.weights;
  if (scheme && scheme !== "none") {
    parts.push(`Weighted by ${WEIGHT_LABEL[scheme]}; R² and the sum of squares are weighted.`);
    if (scheme === "1/y2" && first.ys.some((y) => y <= 0))
      parts.push("Some Y are ≤ 0; 1/Y² weights still apply arithmetically but, as a variance model, assume scatter grows with |Y|.");
    if (scheme === "1/x2" && first.xs.some((x) => x <= 0))
      parts.push("Some X are ≤ 0; 1/X² weights still apply arithmetically but, as a variance model, assume scatter grows with |X|.");
  }
  const fixed = params?.fixed ?? {};
  if (Object.keys(fixed).length)
    parts.push(
      `Fixed parameters: ${Object.entries(fixed)
        .map(([n, v]) => `${termLabel(n)} = ${num(v)}`)
        .join(", ")}.`,
    );
  const bounds = params?.bounds ?? {};
  if (Object.keys(bounds).length)
    parts.push(
      `Bounded parameters: ${Object.entries(bounds)
        .map(([n, [lo, hi]]) => {
          const est = coefOf(coefficients, n);
          const atBound =
            est != null &&
            (Math.abs(est - lo) <= 1e-6 * Math.max(1, Math.abs(lo)) ||
              Math.abs(est - hi) <= 1e-6 * Math.max(1, Math.abs(hi)));
          return `${termLabel(n)} in [${num(lo)}, ${num(hi)}]${atBound ? " (fitted at its bound)" : ""}`;
        })
        .join(", ")}.`,
    );
  return parts.length ? ` ${parts.join(" ")}` : "";
}

/** The result all three paths share: fit block + coefficients + notes, with
 *  the exponential/enzyme extras (equation, starting values, warnings) and
 *  the comparison F test / interpolation sentences when they apply.
 *  `parsed` is one parsed fit per set; `v` the raw vector (comparison F/p).
 *  `extraStats`/`comparisonNotes` carry a model comparison's rows and verdict.
 *  `invertedCI` says a band-inversion CI came back inverted (low > high) and
 *  was dropped — the notes say so instead of showing a bogus interval. */
async function assembleResult(
  model: NonlinearModel,
  spec: ModelSpec,
  xCol: Column,
  yCol: Column,
  otherCol: Column | undefined,
  sets: { name: string; xs: number[]; ys: number[] }[],
  parsed: { coefficients: RegressionCoefficient[]; derived: DerivedRow[]; stats: StatRow[] }[],
  interpolated: InterpolatedRow[],
  v: RVector | [],
  _titles: (string | null)[],
  first: { xs: number[]; ys: number[] },
  retried: boolean | undefined,
  retryMethod: string | undefined,
  params: NonlinearRegressionParams | undefined,
  extraStats: StatRow[] = [],
  comparisonNotes = "",
  invertedCI = false,
): Promise<AnalysisOutcome> {
  const other = sets.length > 1;
  // Plan 29: the segmental breakpoint is a derived value, not a fitted
  // coefficient — report it as a coefficient row with no standard error
  // (the fixed-parameter precedent in runNonlinearRegression), so the
  // overlay can draw the hinge from the coefficients alone. The prefix
  // matches the set-prefixed coefficient names on comparison paths.
  if (model === "segmental-linear") {
    parsed.forEach((p, i) => {
      const x0 = p.derived.find((d) => d.label === "Breakpoint (X0)")?.value ?? null;
      const prefix = p.coefficients[0]?.term.startsWith(`${sets[i].name} — `) ? `${sets[i].name} — ` : "";
      p.coefficients.push({
        term: `${prefix}X0`,
        estimate: x0,
        stdError: null,
        t: null,
        p: null,
        low: null,
        high: null,
      });
    });
  }
  const coefficients = parsed.flatMap((p) => p.coefficients);
  const fit = { sets: sets.map((s) => s.name), rows: fitRows(parsed.map((p) => p.derived), parsed.map((p) => p.stats)) };
  const stats: StatRow[] = [
    ...(other
      ? [
          { label: "F", value: (v as RVector).F ?? null },
          { label: "DFn", value: (v as RVector).dfn ?? null },
          { label: "DFd", value: (v as RVector).dfd ?? null },
          pRow("P value", (v as RVector).p ?? null),
        ]
      : []),
    ...extraStats,
  ];
  const midpoint = spec.dose?.midpoint.replace(/^Log/, "") ?? "EC50";
  const question =
    params?.compare === "all" ? "Does one curve fit both data sets?" : `Is the ${midpoint} different between them?`;
  const differ = (v as RVector).p != null && (v as RVector).p! < 0.05;
  const answer =
    params?.compare === "all"
      ? differ
        ? "The curves differ: one curve doesn't fit both."
        : "One curve fits both data sets."
      : differ
        ? `The ${midpoint}s differ.`
        : `One ${midpoint} fits both data sets.`;
  const interpolation = !params?.interpolate
    ? ""
    : interpolated.length === 0
      ? " No unknowns to interpolate: enter their Y with X left blank."
      : ` Each unknown's X is read off the curve (the lowest, if the curve reaches its Y twice); “extrapolated”: beyond the standards' X.` +
        (interpolated.some((u) => u.x == null) ? " “—”: the curve never reaches that Y." : "") +
        (interpolated.some((u) => u.low != null || u.high != null)
          ? " Interpolated X 95% CIs invert the curve's 95% confidence band."
          : "") +
        (invertedCI
          ? " No 95% CI is shown for an unknown whose band inversion comes back inverted (lower bound above the upper bound): on a non-monotonic curve the band can cross its Y in the wrong order, so no valid interval exists for it."
          : "");
  const notes =
    `Least-squares fit ("${MODEL_LABEL[model]}") of ${sets.map((s) => `“${s.name}”`).join(" and ")} on “${xCol.name}”. ` +
    `95% CIs are asymptotic (from each parameter's standard error${spec.terms.includes("S") ? "; the asymmetry S's, on its log" : ""}).` +
    frameworkNotes(params, coefficients, first) +
    (other ? ` Extra sum-of-squares F test: ${question} ${answer}` : "") +
    (comparisonNotes ? ` ${comparisonNotes}` : "") +
    interpolation;
  const eq =
    isExponential(model) || isEnzyme(model) || isCompetition(model)
      ? equation(model, coefficients, params?.ligandConcentration)
      : undefined;
  const extraNotes: string[] = [];
  if (isCompetition(model)) {
    const starts = startingValues(model, first.xs, first.ys, params?.ligandConcentration);
    if (starts) extraNotes.push(starts);
    // A Ki without its [L] and Kd is uninterpretable — name both, and that
    // the divisor is constant (so log Ki's SE is logIC50's SE).
    if (params?.fitKi === true && (model === "inhibitor-3pl-logx" || isTwoSiteCompetition(model)))
      extraNotes.push(
        `Ki = IC50 / (1 + [L]/Kd), with [L] = ${num(params.ligandConcentration)} and Kd = ${num(params.ligandKd)} ` +
          `(same units as X); the divisor is a constant, so each Ki's 95% CI comes from its logIC50's.`,
      );
    if (model === "homologous-competition-logx")
      extraNotes.push(
        `Homologous competition: [L] = ${num(params?.ligandConcentration)} (same units as X); ` +
          `Kd = Ki, since the competitor and radioligand are the same compound.`,
      );
    extraNotes.push(...fitWarnings(model, coefficients, first.xs));
  }
  // The 4PL retries: a near-perfect sigmoid stalls the default
  // Gauss-Newton fit at the optimum, so the runner retried — with the port
  // optimizer first, then a relaxed convergence tolerance — say which one
  // converged, or the converged numbers look like they came from the
  // first attempt.
  if (retried && (model === "sigmoidal-4pl-logx" || model === "sigmoidal-4pl-x")) {
    extraNotes.push(
      retryMethod === "relaxed tolerance"
        ? "The first fit did not converge; retried with a relaxed convergence tolerance (tol = 1e-3) and converged."
        : retryMethod === "port"
          ? "The first fit did not converge; retried with the port optimizer and converged."
          : "The first fit did not converge; retried and converged.",
    );
  }
  // Plan 29: the segmental note states the fitted breakpoint and both
  // slopes in plain language (and warns when the breakpoint sits at the
  // edge of the data, where the fit is effectively a single line); the
  // quartic/quintic note carries Prism's overfitting caution.
  if (model === "segmental-linear") {
    const derived = parsed[0]?.derived ?? [];
    const value = (label: string) => derived.find((d) => d.label === label)?.value ?? null;
    const x0 = value("Breakpoint (X0)");
    const below = value("Slope below X0");
    const above = value("Slope above X0");
    const sentence =
      `Breakpoint X0 = ${num(x0)} (fitted by profiling over X: the breakpoint minimising the residual sum of squares); ` +
      `slope below X0 = ${num(below)}, slope above X0 = ${num(above)}.`;
    extraNotes.push(sentence);
    if (x0 != null) {
      const sorted = [...new Set(first.xs)].sort((a, b) => a - b);
      const spacing = Math.min(...sorted.slice(1).map((v, i) => v - sorted[i]));
      if (x0 - sorted[0] <= spacing || sorted[sorted.length - 1] - x0 <= spacing)
        extraNotes.push("The breakpoint is at the edge of the data — the fit is effectively a single line.");
    }
  }
  if (model === "quartic" || model === "quintic")
    extraNotes.push(
      `A ${model === "quartic" ? "fourth" : "fifth"} order polynomial can overfit — it follows the noise as well as the trend, so prefer a lower order unless the extra terms are justified.`,
    );
  if (isExponential(model) || isEnzyme(model)) {
    extraNotes.push(startingValues(model, first.xs, first.ys));
    if (isEnzyme(model)) {
      if (first.xs.includes(0))
        extraNotes.push("The X = 0 (vehicle) point is included in the fit; the fitted curve is Y = 0 at X = 0.");
      if (first.ys.some((y) => y < 0))
        extraNotes.push("Some velocities are negative — measurement noise around zero; the fit allows negative Y.");
      if (retried) {
        const median = (vv: number[]) => {
          const s = [...vv].sort((a, b) => a - b);
          return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
        };
        extraNotes.push(
          `The first substrate-inhibition fit failed; retried with Ki = ${num(median(first.xs.filter((x) => x > 0)) * 5)} (5 × median substrate concentration) and converged.`,
        );
      }
    }
    extraNotes.push(...fitWarnings(model, coefficients, first.xs));
  }
  // The groups describe the fitted columns (the Y column's descriptives
  // include the unknown rows, as upstream's do).
  const groups = (await describe([xCol, yCol, ...(otherCol ? [otherCol] : [])])).groups;
  return {
    testType: "nonlinear-regression",
    subtitle: MODEL_LABEL[model],
    ...(eq ? { equation: eq } : {}),
    stats,
    fit,
    groups,
    notes: notes + (extraNotes.length ? ` ${extraNotes.join(" ")}` : ""),
    coefficients,
    ...(params?.interpolate ? { interpolated } : {}),
    // The overlays need [L] to evaluate a homologous curve (plan 28).
    ...(params?.ligandConcentration != null ? { ligandConcentration: params.ligandConcentration } : {}),
  };
}
