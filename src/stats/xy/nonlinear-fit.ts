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
  "semilog-line": "Semilog line",
  hyperbola: "Hyperbola (X is concentration)",
  quadratic: "Second order polynomial (quadratic)",
  cubic: "Third order polynomial (cubic)",
};

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
  return { xCol, yCol, xs, ys };
}

/** R statements that assign `x`/`y`, fit `m`, and compute the summary
 *  quantities (`s`, `co`, `cf`, `df`, `ss`, `sst`, `r2`, `syx`) — everything
 *  up to the final `c(...)`. The caller appends its own result vector, so one
 *  eval can cover the fit plus further computation on it (interpolation). */
export function fitStatements(xs: number[], ys: number[], model: NonlinearModel): string {
  const spec = modelSpec(model);
  // R² for lm comes from summary(); for nls we compute it from residual/total SS.
  const r2 = spec.kind === "lm" ? "s$r.squared" : "1-ss/sst";
  return (
    `x<-${rVec(xs)};y<-${rVec(ys)};${spec.fit};s<-summary(m);co<-s$coefficients;cf<-coef(m);` +
    `df<-df.residual(m);ss<-sum(residuals(m)^2);sst<-sum((y-mean(y))^2);r2<-${r2};syx<-sqrt(ss/df);`
  );
}

/** The named entries the fit contributes to the result vector, in order. */
export function fitEntries(spec: ModelSpec): string {
  // Positional coefficient extraction (co has one row per term, in fit order).
  const coefAssigns = spec.terms
    .map((_, i) => `b${i}=co[${i + 1},1],se${i}=co[${i + 1},2],t${i}=co[${i + 1},3],pv${i}=co[${i + 1},4]`)
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
}

/** Fit the curve and return its coefficients, derived quantities and
 *  goodness-of-fit rows — one R call. */
export async function fitNonlinearModel(xs: number[], ys: number[], model: NonlinearModel): Promise<NonlinearFit> {
  const spec = modelSpec(model);
  const rCode = `${fitStatements(xs, ys, model)}c(${fitEntries(spec)})`;
  const v = await evalNamedVector(rCode);
  const { coefficients, derived, stats } = parseFit(v, spec, xs.length);
  return { coefficients, derived, stats, rCode };
}

/** The nls non-convergence message, shared by both runners. */
export function fitError(err: unknown): AnalysisOutcome {
  return {
    error: `This curve could not be fitted to these data (${err instanceof Error ? err.message : String(err)}). Try another model or Y data set.`,
  };
}
