// The shared standard-curve fit: Prism's "Standard curves to interpolate"
// category, a curated set that fits reliably in WebR. Linear-in-parameters
// models (line, semilog, polynomials) fit with lm(); the sigmoidal and
// hyperbola forms fit with nls(). Both `runNonlinearRegression` and
// `runStandardCurveInterpolation` build on this — one fit, one set of numbers.
import type { AnalysisOutcome, Column, NonlinearModel, RegressionCoefficient, StatRow } from "../types";
import { rVec } from "../column/base";
import { pairUp, splitXY, xyProblem } from "../../lib/dataset";
import { evalNamedVector, type RVector } from "../webr";

export const MODEL_LABEL: Record<NonlinearModel, string> = {
  line: "Line",
  "sigmoidal-4pl-logx": "Sigmoidal, 4PL, X is log(concentration)",
  "sigmoidal-4pl-x": "Sigmoidal, 4PL, X is concentration",
  "agonist-3pl-logx": "log(agonist) vs. response, standard slope (3PL)",
  "inhibitor-3pl-logx": "log(inhibitor) vs. response, standard slope (3PL)",
  "asymmetric-5pl-logx": "Asymmetric sigmoidal, 5PL, X is log(concentration)",
  "asymmetric-5pl-x": "Asymmetric sigmoidal, 5PL, X is concentration",
  "semilog-line": "Semilog line",
  hyperbola: "Hyperbola (X is concentration)",
  quadratic: "Second order polynomial (quadratic)",
  cubic: "Third order polynomial (cubic)",
  "exponential-growth": "Exponential growth",
  "one-phase-decay": "One-phase decay",
  "michaelis-menten": "Michaelis-Menten",
  // Prism's "Exponential" family (plan 08).
  "two-phase-decay": "Two-phase decay",
  "plateau-decay": "Plateau followed by one-phase decay",
  "one-phase-association": "One-phase association",
  // Prism's "Enzyme kinetics — Substrate vs. velocity" (plan 09;
  // michaelis-menten's label already exists above).
  "allosteric-sigmoidal": "Allosteric sigmoidal",
  "substrate-inhibition": "Substrate inhibition",
};

/** The exponential-curve models (plan 08): fitted with nls() algorithm
 *  "port" (see modelSpec) and carrying half-life / span derived rows. */
export const EXPONENTIAL_MODELS: NonlinearModel[] = [
  "one-phase-decay",
  "two-phase-decay",
  "plateau-decay",
  "one-phase-association",
  "exponential-growth",
];

/** The enzyme-kinetics models (plan 09): fitted with nls() algorithm
 *  "port" (see modelSpec). Unlike the log/ratio forms, their formulas are
 *  defined at X = 0, so the vehicle point stays in the fit — they set no
 *  `positiveX`; the positive-X values are used only for start values. */
export const ENZYME_MODELS: NonlinearModel[] = [
  "michaelis-menten",
  "allosteric-sigmoidal",
  "substrate-inhibition",
];

export interface ModelSpec {
  /** Which R fitter to use — lm() (linear in params) or nls() (nonlinear). */
  kind: "lm" | "nls";
  /** R that assigns `m<-lm(...)` or `m<-nls(...,start=...)`; `x`/`y` are in scope. */
  fit: string;
  /** Coefficient display names, in the order lm/nls reports them (positional extraction). */
  terms: string[];
  /** Derived quantities computed from the fit's named coefficients (`cf[["Name"]]`). */
  derived?: { label: string; expr: string }[];
  /** Curves of log or ratio forms fit the points with X > 0 only. */
  positiveX?: boolean;
  /** nls models only: R defining `g<-function(xv,p)` — the curve evaluated at
   *  X `xv` with parameter vector `p` (named, as `coef(m)` reports them).
   *  Used for the confidence band (delta method) and inverse prediction. */
  curveFn?: string;
  /** Coefficient names of the curve's lower/upper asymptotes (4PL only) —
   *  an unknown within the fit's residual scale of one is outside range. */
  asymptotes?: [string, string];
  /** nls models only: an alternate `m<-nls(...)` assignment to retry once
   *  with if the primary fit fails (substrate inhibition's Ki start is the
   *  least robust — plan 09). `fitNonlinearModel` reports the retry. */
  retryFit?: string;
}

export function modelSpec(model: NonlinearModel): ModelSpec {
  switch (model) {
    case "line":
      return { kind: "lm", fit: "m<-lm(y~x)", terms: ["Intercept", "Slope"] };
    case "quadratic":
      return { kind: "lm", fit: "m<-lm(y~x+I(x^2))", terms: ["B0", "B1", "B2"] };
    case "cubic":
      return { kind: "lm", fit: "m<-lm(y~x+I(x^2)+I(x^3))", terms: ["B0", "B1", "B2", "B3"] };
    case "semilog-line":
      // Y = intercept + slope * ln(X).
      return {
        kind: "lm",
        fit: "m<-lm(y~log(x))",
        terms: ["Intercept", "Slope"],
        positiveX: true,
      };
    case "sigmoidal-4pl-logx":
      // X is already log10(dose). EC50 = 10^LogEC50.
      return {
        kind: "nls",
        fit: "m<-nls(y~Bottom+(Top-Bottom)/(1+10^((LogEC50-x)*HillSlope)),start=list(Bottom=min(y),Top=max(y),LogEC50=median(x),HillSlope=1))",
        terms: ["Bottom", "Top", "LogEC50", "HillSlope"],
        derived: [
          { label: "EC50", expr: '10^cf[["LogEC50"]]' },
          { label: "Span", expr: 'cf[["Top"]]-cf[["Bottom"]]' },
        ],
        curveFn:
          'g<-function(xv,p) p[["Bottom"]]+(p[["Top"]]-p[["Bottom"]])/(1+10^((p[["LogEC50"]]-xv)*p[["HillSlope"]]))',
        asymptotes: ["Bottom", "Top"],
      };
    case "sigmoidal-4pl-x":
      // X is the raw concentration; EC50 is fitted directly.
      return {
        kind: "nls",
        fit: "m<-nls(y~Bottom+(Top-Bottom)/(1+(EC50/x)^HillSlope),start=list(Bottom=min(y),Top=max(y),EC50=median(x[x>0]),HillSlope=1))",
        terms: ["Bottom", "Top", "EC50", "HillSlope"],
        derived: [{ label: "Span", expr: 'cf[["Top"]]-cf[["Bottom"]]' }],
        positiveX: true,
        curveFn: 'g<-function(xv,p) p[["Bottom"]]+(p[["Top"]]-p[["Bottom"]])/(1+(p[["EC50"]]/xv)^p[["HillSlope"]])',
        asymptotes: ["Bottom", "Top"],
      };
    case "hyperbola":
      // Y = Bmax * X / (Kd + X).
      return {
        kind: "nls",
        fit: "m<-nls(y~Bmax*x/(Kd+x),start=list(Bmax=max(y)*1.1,Kd=median(x[x>0])))",
        terms: ["Bmax", "Kd"],
        positiveX: true,
        curveFn: 'g<-function(xv,p) p[["Bmax"]]*xv/(p[["Kd"]]+xv)',
      };
    // ── Exponential family (plan 08) ──────────────────────────────────
    // All five fit with nls() algorithm "port" (nl2sol), not the default
    // Gauss-Newton: in WebR's R 4.6.0 the default fails to converge on
    // (near-)noiseless exponential fits even from exact starts ("number of
    // iterations exceeded maximum of 50", or "step factor reduced below
    // 'minFactor'"), while "port" recovers the generating parameters to
    // ~1e-13. The older models keep the default, so their pinned numbers
    // do not move. Half-life is null (NA) when the fitted K ≤ 0 — a
    // negative half-life is meaningless — and the runner notes it.
    case "one-phase-decay":
      // Y = (Y0 − Plateau)·exp(−K·X) + Plateau.
      return {
        kind: "nls",
        fit: "m<-nls(y~(Y0-Plateau)*exp(-K*x)+Plateau,start=list(Y0=y[which.min(x)],Plateau=min(y),K=0.5),algorithm=\"port\")",
        terms: ["Y0", "Plateau", "K"],
        derived: [
          { label: "Half-life", expr: 'ifelse(cf[["K"]]>0,log(2)/cf[["K"]],NA_real_)' },
          { label: "Span", expr: 'cf[["Y0"]]-cf[["Plateau"]]' },
        ],
        curveFn:
          'g<-function(xv,p) (p[["Y0"]]-p[["Plateau"]])*exp(-p[["K"]]*xv)+p[["Plateau"]]',
      };
    case "two-phase-decay":
      // Y = Plateau + Span1·exp(−K1·X) + Span2·exp(−K2·X).
      return {
        kind: "nls",
        fit: "m<-nls(y~Plateau+Span1*exp(-K1*x)+Span2*exp(-K2*x),start=list(Plateau=min(y),Span1=0.6*(max(y)-min(y)),K1=1,Span2=0.4*(max(y)-min(y)),K2=0.1),algorithm=\"port\")",
        terms: ["Plateau", "Span1", "K1", "Span2", "K2"],
        derived: [
          { label: "Half-life (fast)", expr: 'ifelse(cf[["K1"]]>0,log(2)/cf[["K1"]],NA_real_)' },
          { label: "Half-life (slow)", expr: 'ifelse(cf[["K2"]]>0,log(2)/cf[["K2"]],NA_real_)' },
          { label: "Span", expr: 'cf[["Span1"]]+cf[["Span2"]]' },
        ],
        curveFn:
          'g<-function(xv,p) p[["Plateau"]]+p[["Span1"]]*exp(-p[["K1"]]*xv)+p[["Span2"]]*exp(-p[["K2"]]*xv)',
      };
    case "plateau-decay":
      // Y = Y0 for X < X0; Y = Plateau + (Y0 − Plateau)·exp(−K·(X − X0)) after.
      return {
        kind: "nls",
        fit: "m<-nls(y~ifelse(x<X0,Y0,Plateau+(Y0-Plateau)*exp(-K*(x-X0))),start=list(X0=median(x),Y0=mean(y[x<median(x)]),Plateau=min(y),K=0.5),algorithm=\"port\")",
        terms: ["X0", "Y0", "Plateau", "K"],
        derived: [
          { label: "Half-life", expr: 'ifelse(cf[["K"]]>0,log(2)/cf[["K"]],NA_real_)' },
          { label: "Span", expr: 'cf[["Y0"]]-cf[["Plateau"]]' },
        ],
        curveFn:
          'g<-function(xv,p) ifelse(xv<p[["X0"]],p[["Y0"]],p[["Plateau"]]+(p[["Y0"]]-p[["Plateau"]])*exp(-p[["K"]]*(xv-p[["X0"]])))',
      };
    case "one-phase-association":
      // Y = Y0 + (Plateau − Y0)·(1 − exp(−K·X)). Span is the rise
      // (Plateau − Y0), positive like the decay span — the plan's literal
      // "Y0 − Plateau" would report a negative span for a rising curve.
      return {
        kind: "nls",
        fit: "m<-nls(y~Y0+(Plateau-Y0)*(1-exp(-K*x)),start=list(Y0=y[which.min(x)],Plateau=max(y),K=0.5),algorithm=\"port\")",
        terms: ["Y0", "Plateau", "K"],
        derived: [
          { label: "Half-life", expr: 'ifelse(cf[["K"]]>0,log(2)/cf[["K"]],NA_real_)' },
          { label: "Span", expr: 'cf[["Plateau"]]-cf[["Y0"]]' },
        ],
        curveFn:
          'g<-function(xv,p) p[["Y0"]]+(p[["Plateau"]]-p[["Y0"]])*(1-exp(-p[["K"]]*xv))',
      };
    case "exponential-growth":
      // Prism's "Exponential growth": Y = Y0·exp(K·X).
      // DEVIATION from the plan's Case D: the plan fits the growth model
      // with SSasymp (Asym/R0/lrc) on saturating data (Y → 200). That
      // parameterisation cannot be the growth model: SSasymp on pure
      // exponential data fails in WebR ("singular gradient"), and explicit
      // growth on the saturating fixture fits badly (R² = 0.798, verified
      // in WebR before implementing). The saturating fixture is the
      // association shape — Y0=10, Plateau=200, K=0.2 — and is covered as
      // an association case (D) instead; growth is the Prism-explicit form,
      // with the pure-growth fixture as Case D2.
      return {
        kind: "nls",
        fit: "m<-nls(y~Y0*exp(K*x),start=list(Y0=y[which.min(x)],K=0.1),algorithm=\"port\")",
        terms: ["Y0", "K"],
        derived: [{ label: "Doubling time", expr: 'ifelse(cf[["K"]]>0,log(2)/cf[["K"]],NA_real_)' }],
        curveFn: 'g<-function(xv,p) p[["Y0"]]*exp(p[["K"]]*xv)',
      };
    // ── Enzyme kinetics (plan 09) ───────────────────────────────────────
    // All three fit with nls() algorithm "port" (nl2sol), like plan 08's
    // exponentials: the default Gauss-Newton fails to converge on
    // (near-)noiseless fits in WebR's R 4.6.0 even from exact starts, while
    // "port" recovers the generating parameters. Michaelis-Menten is
    // algebraically the hyperbola (Bmax·X/(Kd + X)) with Prism's Vmax/Km
    // names — a separate model entry, same formula, no duplicated fitter.
    // None sets positiveX: the formulas are defined at X = 0, so the
    // vehicle point stays in the fit; median(x[x > 0]) is used only for
    // the Km/Khalf start values.
    case "michaelis-menten":
      // Y = Vmax·X / (Km + X).
      return {
        kind: "nls",
        fit: "m<-nls(y~Vmax*x/(Km+x),start=list(Vmax=max(y)*1.1,Km=median(x[x>0])),algorithm=\"port\")",
        terms: ["Vmax", "Km"],
        derived: [{ label: "Vmax/Km", expr: 'ifelse(cf[["Km"]]>0,cf[["Vmax"]]/cf[["Km"]],NA_real_)' }],
        curveFn: 'g<-function(xv,p) p[["Vmax"]]*xv/(p[["Km"]]+xv)',
      };
    case "allosteric-sigmoidal":
      // Y = Vmax·X^h / (Khalf^h + X^h).
      return {
        kind: "nls",
        fit: "m<-nls(y~Vmax*x^h/(Khalf^h+x^h),start=list(Vmax=max(y)*1.1,Khalf=median(x[x>0]),h=1),algorithm=\"port\")",
        terms: ["Vmax", "Khalf", "HillSlope"],
        curveFn: 'g<-function(xv,p) p[["Vmax"]]*xv^p[["h"]]/(p[["Khalf"]]^p[["h"]]+xv^p[["h"]])',
      };
    case "substrate-inhibition":
      // Y = Vmax·X / (Km + X + X²/Ki). Ki's start is the least robust, so
      // the fit is retried once with Ki = 5 × median(S) if nls() fails.
      return {
        kind: "nls",
        fit: "m<-nls(y~Vmax*x/(Km+x+x^2/Ki),start=list(Vmax=max(y)*1.5,Km=median(x[x>0]),Ki=max(x)),algorithm=\"port\")",
        terms: ["Vmax", "Km", "Ki"],
        curveFn: 'g<-function(xv,p) p[["Vmax"]]*xv/(p[["Km"]]+xv+xv^2/p[["Ki"]])',
        retryFit:
          "m<-nls(y~Vmax*x/(Km+x+x^2/Ki),start=list(Vmax=max(y)*1.5,Km=median(x[x>0]),Ki=median(x[x>0])*5),algorithm=\"port\")",
      };
    default:
      // Upstream 1.0.7 models not yet ported into the shared-fit layer
      // (3PL/5PL) — the dedup commit merges them (Plan 31). Their labels
      // exist above so the type stays complete.
      throw new Error(`Model "${model}" is not implemented in the shared fit yet.`);
  }
}

/** The X/Y columns and the points to fit: the `positiveX` X > 0 drop rule and
 *  the `nParams + 1` minimum-points rule, shared by both runners. */
export function prepareFit(
  columns: Column[],
  yName: string | undefined,
  model: NonlinearModel,
): { xCol: Column; yCol: Column; xs: number[]; ys: number[] } | { error: string } {
  const { x: xCol, ys: yCols } = splitXY(columns);
  const yCol = yName === undefined ? yCols[0] : yCols.find((c) => c.name === yName);
  if (!xCol || !yCol) return { error: xyProblem(columns, yName)! };

  const complete = pairUp(xCol, yCol);
  const spec = modelSpec(model);
  const nParams = spec.terms.length;

  // Curves that need X > 0 (log/ratio forms) commonly get a X=0 vehicle/control
  // point in real dose-response data — drop it from the fit rather than
  // rejecting the whole curve, mirroring how these curves are conventionally fit.
  let xs = complete.x;
  let ys = complete.y;
  if (spec.positiveX) {
    xs = [];
    ys = [];
    complete.x.forEach((x, i) => {
      if (x > 0) {
        xs.push(x);
        ys.push(complete.y[i]);
      }
    });
  }
  if (xs.length < nParams + 1) {
    const scope = spec.positiveX ? " with X > 0" : "";
    return {
      error: `Not enough complete points${scope} (${xs.length}) to fit this curve; need at least ${nParams + 1}.`,
    };
  }
  if (ENZYME_MODELS.includes(model)) {
    // Substrate concentrations: negative X is a data error, and Km/Khalf
    // is unidentifiable with no positive X or with all X equal — validate
    // before calling R, not after it fails. The X = 0 vehicle point is
    // kept (the formulas are defined at X = 0); only the start values use
    // the positive X values.
    if (xs.some((x) => x < 0)) return { error: "Substrate concentrations cannot be negative." };
    if (!xs.some((x) => x > 0))
      return { error: "No positive substrate concentration — Km cannot be estimated." };
    if (new Set(xs).size === 1)
      return { error: "All substrate concentrations are equal — Km cannot be estimated." };
  }
  if (model === "plateau-decay") {
    // X0 (the breakpoint) is unidentifiable without data on both sides of
    // it — validate before calling nls(), not after it fails. R's median of
    // an even count is the mean of the two middle values.
    const sorted = [...xs].sort((a, b) => a - b);
    const mid =
      sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    if (!xs.some((x) => x < mid) || !xs.some((x) => x > mid)) {
      return { error: "Plateau-followed-by-decay needs data on both sides of the breakpoint." };
    }
  }
  return { xCol, yCol, xs, ys };
}

/** R statements that assign `x`/`y`, fit `m`, and compute the summary
 *  quantities (`s`, `co`, `cf`, `df`, `ss`, `sst`, `r2`, `syx`) — everything
 *  up to the final `c(...)`. The caller appends its own result vector, so one
 *  eval can cover the fit plus further computation on it (interpolation).
 *  `fitOverride` replaces the spec's fit assignment (the substrate-inhibition
 *  retry with its alternate Ki start). `extraAssignments` is R run after the
 *  `x`/`y` assignments and before the fit — a two-series binding fit's group
 *  indicator, or an association-then-dissociation fit's HotNM/Time0 constants. */
export function fitStatementsForSpec(
  xs: number[],
  ys: number[],
  spec: ModelSpec,
  fitOverride?: string,
  extraAssignments = "",
): string {
  // R² for lm comes from summary(); for nls we compute it from residual/total SS.
  const r2 = spec.kind === "lm" ? "s$r.squared" : "1-ss/sst";
  return (
    `x<-${rVec(xs)};y<-${rVec(ys)};${extraAssignments}${fitOverride ?? spec.fit};s<-summary(m);co<-s$coefficients;cf<-coef(m);` +
    `df<-df.residual(m);ss<-sum(residuals(m)^2);sst<-sum((y-mean(y))^2);r2<-${r2};syx<-sqrt(ss/df);`
  );
}

export function fitStatements(xs: number[], ys: number[], model: NonlinearModel, fitOverride?: string): string {
  return fitStatementsForSpec(xs, ys, modelSpec(model), fitOverride);
}

/** The named entries the fit contributes to the result vector, in order.
 *  `cl`/`ch` are the Wald 95% CIs (estimate ± t(0.975, df)·SE, plan 09) —
 *  on noiseless data the SEs are 0, so the intervals collapse to the
 *  estimates; the reference tests assert that, plus genuinely nonzero
 *  widths on a noisy fixture. */
export function fitEntries(spec: ModelSpec): string {
  // Positional coefficient extraction (co has one row per term, in fit order).
  const coefAssigns = spec.terms
    .map(
      (_, i) =>
        `b${i}=co[${i + 1},1],se${i}=co[${i + 1},2],t${i}=co[${i + 1},3],pv${i}=co[${i + 1},4],` +
        `cl${i}=co[${i + 1},1]-qt(0.975,df)*co[${i + 1},2],ch${i}=co[${i + 1},1]+qt(0.975,df)*co[${i + 1},2]`,
    )
    .join(",");
  const derived = spec.derived ?? [];
  const derivedAssigns = derived.map((d, i) => `d${i}=${d.expr}`).join(",");
  return `r2=r2,df=df,ss=ss,syx=syx,${coefAssigns}${derivedAssigns ? "," + derivedAssigns : ""}`;
}

/** The fit's coefficients, derived quantities and goodness-of-fit rows, read
 *  out of an `evalNamedVector` result that carries `fitEntries(spec)`. */
export function parseFit(
  v: RVector,
  spec: ModelSpec,
  n: number,
): { coefficients: RegressionCoefficient[]; derived: StatRow[]; stats: StatRow[] } {
  const coefficients: RegressionCoefficient[] = spec.terms.map((term, i) => ({
    term,
    estimate: v[`b${i}`] ?? null,
    stdError: v[`se${i}`] ?? null,
    t: v[`t${i}`] ?? null,
    p: v[`pv${i}`] ?? null,
    ciLow: v[`cl${i}`] ?? null,
    ciHigh: v[`ch${i}`] ?? null,
  }));
  const derived: StatRow[] = (spec.derived ?? []).map((d, i) => ({ label: d.label, value: v[`d${i}`] ?? null }));
  const stats: StatRow[] = [
    { label: "R squared", value: v.r2 },
    { label: "Sy.x", value: v.syx },
    { label: "Sum of squares", value: v.ss },
    { label: "Degrees of freedom", value: v.df },
    { label: "N", value: n },
  ];
  return { coefficients, derived, stats };
}

export interface NonlinearFit {
  coefficients: RegressionCoefficient[];
  derived: StatRow[];
  stats: StatRow[];
  /** The exact R code that was evaluated (for debugging). */
  rCode: string;
  /** True when the primary fit failed and the alternate-start retry
   *  (substrate inhibition's Ki) converged instead — the runner notes it. */
  retried?: boolean;
}

/** Fit a model spec (not necessarily one of the curated nonlinear models)
 *  and return its coefficients, derived quantities and goodness-of-fit rows —
 *  one R call (two when a spec carries a retry fit and the first attempt
 *  fails). The binding runners (plan 16) fit their own specs through this,
 *  so there is exactly one nls call site in the repo. */
export async function fitModelSpec(
  xs: number[],
  ys: number[],
  spec: ModelSpec,
  extraAssignments = "",
): Promise<NonlinearFit> {
  try {
    const rCode = `${fitStatementsForSpec(xs, ys, spec, undefined, extraAssignments)}c(${fitEntries(spec)})`;
    const v = await evalNamedVector(rCode);
    const { coefficients, derived, stats } = parseFit(v, spec, xs.length);
    return { coefficients, derived, stats, rCode };
  } catch (err) {
    if (!spec.retryFit) throw err;
    const rCode = `${fitStatementsForSpec(xs, ys, spec, spec.retryFit, extraAssignments)}c(${fitEntries(spec)})`;
    const v = await evalNamedVector(rCode);
    const { coefficients, derived, stats } = parseFit(v, spec, xs.length);
    return { coefficients, derived, stats, rCode, retried: true };
  }
}

/** Fit the curve and return its coefficients, derived quantities and
 *  goodness-of-fit rows — one R call (two when a spec carries a retry fit
 *  and the first attempt fails). */
export async function fitNonlinearModel(xs: number[], ys: number[], model: NonlinearModel): Promise<NonlinearFit> {
  return fitModelSpec(xs, ys, modelSpec(model));
}

/** The nls non-convergence message, shared by both runners — it names the
 *  model, so a failure on an exponential curve says which one. */
export function fitError(err: unknown, model?: NonlinearModel): AnalysisOutcome {
  const which = model ? ` ("${MODEL_LABEL[model]}")` : "";
  return {
    error: `This curve${which} could not be fitted to these data (${err instanceof Error ? err.message : String(err)}). Try another model or Y data set.`,
  };
}
