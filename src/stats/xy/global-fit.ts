// The shared global (shared-parameter) fit — the single place that knows how
// to fit several series at once with one nls() call (plan 18). Plans 16
// (two-series saturation) and 17 (enzyme inhibition) fit through it, so
// there is exactly one stacked-nls implementation in the repo; the
// single-curve runner (nonlinear-regression.ts / nonlinear-fit.ts) is
// untouched — this helper builds on its fitModelSpec, the one nls call
// site, rather than adding a second one.
//
// Contract: an array of series, each { x, y, covariate } (covariate = the
// per-series quantity the formula needs — antagonist concentration B for
// Schild, inhibitor concentration [I] for plan 17, 0 when the model has no
// covariate), plus a model definition: an R formula fragment referencing
// x, y, g (integer series index, 1-based) and B (the per-point covariate
// vector), and a parameter list. Each parameter is either shared (one value
// for all series) or per-series (one value per applicable series, named
// `Name[series]` in the coefficients table — `LogEC50[Control]`,
// `LogEC50[10 nM]` — so the results view is unambiguous). A per-series
// parameter may apply to a subset of the series (`appliesTo`, 1-based):
// the operational model's logKA/logtau exist only for the partial agonists
// (series 2..k), and the formula indexes them with an explicit expression
// (`logKA[pmax(g-1,1)]`) — a parameter no series uses would be
// unidentified and make nls fail, so the subset must be real.
//
// The helper stacks the series (x, y, g, B) and issues one nls() call with
// algorithm "port" (bounds are how positive parameters stay positive —
// HillSlope, SchildSlope, Vmax, Km, Ki). Coefficients, SE/t/p and CIs come
// back in the same shape the single-curve runner returns: Wald 95% CIs
// (estimate ± t·SE), the repo's nonlinear-runner convention —
// profile-likelihood confint() would be a cross-cutting change to every
// nonlinear fit, not a plan-18 one. Per-series R² is computed here from
// the model's closed-form evaluator (the same function the graph overlay
// uses), so the fit and the overlay can never disagree.
import type { RegressionCoefficient, StatRow } from "../types";
import { rVec } from "../column/base";
import { fitModelSpec, type ModelSpec } from "./nonlinear-fit";

/** One series of a global fit: its points, its display name, and its
 *  covariate (antagonist / inhibitor concentration, or 0 when the model
 *  has no per-series quantity). */
export interface GlobalFitSeries {
  name: string;
  x: number[];
  y: number[];
  covariate: number;
}

/** One fitted parameter. `start` receives all series, so a shared start
 *  can pool them (e.g. min(Y) over every series) and a per-series start
 *  can look at its own series; it returns one number for a shared
 *  parameter, one per applicable series (in `appliesTo` order) for a
 *  per-series one. Bounds are scalar, applied to every element of the
 *  parameter (shared or per-series); absent bounds are free (±Inf). */
export interface GlobalParamDef {
  name: string;
  shared: boolean;
  start: (series: GlobalFitSeries[]) => number | number[];
  /** 1-based series indices this parameter applies to (per-series only;
   *  default: every series). */
  appliesTo?: number[];
  lower?: number;
  upper?: number;
}

/** A global model, as data: the R formula, its parameters, optional
 *  derived quantities (R expressions over cf, as in ModelSpec), and the
 *  closed-form evaluator the per-series R² and the graph overlay share. */
export interface GlobalModelDef {
  /** R formula RHS, referencing x, y, g (1-based series index), B
   *  (per-point covariate) and the parameter names. A per-series
   *  parameter is referenced as `Name[g]` when it applies to every
   *  series, or with an explicit index expression otherwise. */
  formula: string;
  params: GlobalParamDef[];
  derived?: { label: string; expr: string }[];
  /** The fitted curve's value at X for one series, from the fit's
   *  coefficients — the same closed form R fitted. `seriesIndex` is
   *  0-based; the series' covariate is on `series.covariate`. */
  evaluate: (coefficients: RegressionCoefficient[], series: GlobalFitSeries, seriesIndex: number, x: number) => number;
  /** nls maxiter (raised when a model needs it). */
  maxiter?: number;
}

/** One series' breakdown: its point count, its own R² (null when its Y
 *  is constant), and its fitted per-series parameter values by name. */
export interface GlobalFitPerSeries {
  name: string;
  n: number;
  rSquared: number | null;
  params: Record<string, number>;
}

export interface GlobalFitResult {
  coefficients: RegressionCoefficient[];
  derived: StatRow[];
  stats: StatRow[];
  perSeries: GlobalFitPerSeries[];
  /** The exact R code that was evaluated (for debugging). */
  rCode: string;
}

/** R² of `ys` against their fitted values (null when Y is constant). */
function rSquared(ys: number[], fitted: number[]): number | null {
  const mean = ys.reduce((s, v) => s + v, 0) / ys.length;
  const sst = ys.reduce((s, v) => s + (v - mean) ** 2, 0);
  if (sst === 0) return null;
  const ssr = ys.reduce((s, v, i) => s + (v - fitted[i]) ** 2, 0);
  return 1 - ssr / sst;
}

const rNum = (v: number): string => (v === Infinity ? "Inf" : v === -Infinity ? "-Inf" : String(v));

/** Fit `def` to `series` with one stacked nls() call. The caller owns
 *  validation (series count, point counts, covariate rules) — this helper
 *  only fits what it is given. */
export async function runGlobalFit(series: GlobalFitSeries[], def: GlobalModelDef): Promise<GlobalFitResult> {
  const stackedX = series.flatMap((s) => s.x);
  const stackedY = series.flatMap((s) => s.y);
  // g is the 1-based series index per point; B repeats each series'
  // covariate over its points. `times=` (not `each=`) because the series
  // need not have the same point count (missing cells pair up per series).
  const g = series.flatMap((s, i) => s.x.map(() => i + 1));
  const b = series.flatMap((s) => s.x.map(() => s.covariate));
  const extra = `g<-${rVec(g)};B<-${rVec(b)};`;

  // The parameter vector, in definition order: a shared parameter is one
  // scalar, a per-series parameter is a vector over its applicable series.
  // Terms, starts and bounds all follow the same element order, so the
  // positional extraction in fitModelSpec lines up.
  const terms: string[] = [];
  const starts: string[] = [];
  const lower: number[] = [];
  const upper: number[] = [];
  for (const p of def.params) {
    const applies = p.shared ? [1] : (p.appliesTo ?? series.map((_, i) => i + 1));
    const start = p.start(series);
    const values = Array.isArray(start) ? start : [start];
    if (!p.shared && values.length !== applies.length)
      throw new Error(`Parameter “${p.name}” needs ${applies.length} start values, got ${values.length}.`);
    if (values.some((v) => !Number.isFinite(v))) throw new Error(`Parameter “${p.name}” has a non-finite start value.`);
    if (p.shared) {
      terms.push(p.name);
      starts.push(`${p.name}=${rNum(values[0])}`);
      lower.push(p.lower ?? -Infinity);
      upper.push(p.upper ?? Infinity);
    } else {
      starts.push(`${p.name}=${rVec(values)}`);
      applies.forEach((i) => {
        terms.push(`${p.name}[${series[i - 1].name}]`);
        lower.push(p.lower ?? -Infinity);
        upper.push(p.upper ?? Infinity);
      });
    }
  }
  const control = def.maxiter !== undefined ? `,control=nls.control(maxiter=${def.maxiter})` : "";
  const spec: ModelSpec = {
    kind: "nls",
    fit:
      `m<-nls(y~${def.formula},start=list(${starts.join(",")}),` +
      `algorithm="port",lower=c(${lower.map(rNum).join(",")}),upper=c(${upper.map(rNum).join(",")})${control})`,
    terms,
    derived: def.derived,
  };
  const { coefficients, derived, stats, rCode } = await fitModelSpec(stackedX, stackedY, spec, extra);

  const coefOf = (term: string) => coefficients.find((c) => c.term === term)?.estimate ?? null;
  const perSeries: GlobalFitPerSeries[] = series.map((s, i) => {
    const fitted = s.x.map((x0) => def.evaluate(coefficients, s, i, x0));
    const params: Record<string, number> = {};
    for (const p of def.params) {
      if (p.shared) continue;
      const applies = p.appliesTo ?? series.map((_, j) => j + 1);
      if (!applies.includes(i + 1)) continue;
      const v = coefOf(`${p.name}[${s.name}]`);
      if (v != null) params[p.name] = v;
    }
    return { name: s.name, n: s.x.length, rSquared: rSquared(s.y, fitted), params };
  });
  return { coefficients, derived, stats, perSeries, rCode };
}
