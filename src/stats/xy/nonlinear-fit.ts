// The shared standard-curve fit: Prism's "Standard curves to interpolate"
// category, a curated set that fits reliably in WebR. Linear-in-parameters
// models (line, semilog, polynomials) fit with lm(); the sigmoidal and
// hyperbola forms fit with nls(). `runNonlinearRegression` builds on this —
// one fit, one set of numbers — as do the binding (plan 16), enzyme
// inhibition (plan 17) and global-fit runners, through `fitModelSpec`.
// Upstream 1.0.7's runner is merged in here (dedup, Nov 10): the 3PL/5PL
// models, the sign-aware 4PL HillSlope start, the dose-response `dose`
// shape for curve comparison, and derived quantities with their 95% CIs
// (upstream's `fit` block). The exponential (plan 08) and enzyme (plan 09)
// models keep their `algorithm="port"` fits and X = 0 retention — upstream's
// defaults fail or drop points there.
import type { AnalysisOutcome, Column, NonlinearModel, RegressionCoefficient, StatRow } from "../types";
import { rVec } from "../column/base";
import { datasetColumns, pairUp, splitXY, xyProblem } from "../../lib/dataset";
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
  // Plan 29: lines & polynomials completion.
  "segmental-linear": "Segmental linear regression (two segments)",
  quartic: "Fourth order polynomial (quartic)",
  quintic: "Fifth order polynomial (quintic)",
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
  // Prism's "Binding — Competition" (plan 28): two-site competition and
  // homologous competition. The one-site Fit logIC50 is the inhibitor 3PL
  // above; Fit Ki is a derived quantity on it (see modelSpec's opts).
  "two-site-competition-logx": "Two sites — Fit logIC50, X is log(concentration)",
  "two-site-competition-x": "Two sites — Fit logIC50, X is concentration",
  "homologous-competition-logx": "One site — Homologous, X is log(concentration)",
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
 *  defined at X = 0, so the vehicle point stays in the fit — they set
 *  `nonNegativeX`, not `positiveX`; the positive-X values are used only for
 *  start values. `nonNegativeX` keeps the interpolation grid (and the
 *  point-estimate search) at X ≥ 0: below zero the allosteric form is NaN
 *  for a non-integer Hill slope and the Michaelis-Menten pole at −Km sits
 *  inside the grid (R3-10). */
export const ENZYME_MODELS: NonlinearModel[] = [
  "michaelis-menten",
  "allosteric-sigmoidal",
  "substrate-inhibition",
];

/** A derived quantity, as R expressions of the fit (`cf`, its coefficients;
 *  `pci(p)`, a coefficient's 95% CI; `V`, their covariance; `q`, the t
 *  critical value). `low`/`high` omitted: the quantity has no CI. */
export interface Derived {
  label: string;
  expr: string;
  low?: string;
  high?: string;
}

/** 10 to a log coefficient, its CI 10 to the coefficient's. */
const tenTo = (label: string, p: string): Derived => ({
  label,
  expr: `10^cf[["${p}"]]`,
  low: `10^pci("${p}")[1]`,
  high: `10^pci("${p}")[2]`,
});
/** `a` − `b`, its CI from both and their covariance. */
const difference = (a: string, b: string, label = "Span"): Derived => {
  const se = `sqrt(V["${a}","${a}"]+V["${b}","${b}"]-2*V["${a}","${b}"])`;
  const value = `cf[["${a}"]]-cf[["${b}"]]`;
  return { label, expr: value, low: `${value}-q*${se}`, high: `${value}+q*${se}` };
};
/** `a` + `b`, its CI from both and their covariance. */
const sumOf = (a: string, b: string, label = "Span"): Derived => {
  const se = `sqrt(V["${a}","${a}"]+V["${b}","${b}"]+2*V["${a}","${b}"])`;
  const value = `cf[["${a}"]]+cf[["${b}"]]`;
  return { label, expr: value, low: `${value}-q*${se}`, high: `${value}+q*${se}` };
};
const span = difference("Top", "Bottom");
/** Ki from a log midpoint: Ki = 10^LogIC50 / D, where D = 1 + [L]/Kd is a
 *  constant the wizard supplies — so log Ki's SE is logIC50's SE, and the
 *  Ki CI is 10^ the logIC50 CI, over D. (Cheng–Prusoff; plan 28.) */
const kiFromLog = (label: string, p: string, d: number): Derived => ({
  label,
  expr: `10^cf[["${p}"]]/${d}`,
  low: `10^pci("${p}")[1]/${d}`,
  high: `10^pci("${p}")[2]/${d}`,
});
/** Ki from a linear IC50: Ki = IC50 / D, its CI the IC50 CI over D. */
const kiFromLinear = (label: string, p: string, d: number): Derived => ({
  label,
  expr: `cf[["${p}"]]/${d}`,
  low: `pci("${p}")[1]/${d}`,
  high: `pci("${p}")[2]/${d}`,
});
/** `c` / K (a half-life, a doubling time, tau), its CI `c` over K's: none when K's
 *  includes 0, the time then unbounded. The value is null when the fitted K ≤ 0. */
const overK = (label: string, c: string, k = "K"): Derived => {
  const ends = `sort(${c}/pci("${k}"))`;
  return {
    label,
    expr: `ifelse(cf[["${k}"]]>0,${c}/cf[["${k}"]],NA_real_)`,
    low: `if(prod(pci("${k}"))>0)${ends}[1] else NA`,
    high: `if(prod(pci("${k}"))>0)${ends}[2] else NA`,
  };
};

/** R that assigns `m<-lm(...)` or `m<-nls(...,start=...)`; `x`/`y` are in scope. */
export interface ModelSpec {
  /** Which R fitter to use — lm() (linear in params) or nls() (nonlinear). */
  kind: "lm" | "nls";
  /** R that assigns `m<-lm(...)` or `m<-nls(...,start=...)`; `x`/`y` are in scope. */
  fit: string;
  /** Coefficient display names, in the order lm/nls reports them (positional extraction). */
  terms: string[];
  /** Derived quantities computed from the fit's named coefficients (`cf[["Name"]]`). */
  derived?: Derived[];
  /** Log-X curves fit the points with X > 0 only (log(0) is undefined). */
  positiveX?: boolean;
  /** Raw-concentration ratio curves (4PL/5PL X, hyperbola, two-site X, enzyme
   *  kinetics): defined at X = 0 — the vehicle point is the Bottom anchor, so
   *  it stays in the fit — but not at X < 0 (a fractional power of a negative
   *  is NaN in R). The enzyme models share the "defined at 0" half and set
   *  this flag (R3-10: without it the interpolation grid extended below zero,
   *  where allosteric-sigmoidal is NaN and Michaelis-Menten has its pole);
   *  their negative-X error still lives in prepareFit. */
  nonNegativeX?: boolean;
  /** nls models only: R defining `g<-function(xv,p)` — the curve evaluated at
   *  X `xv` with parameter vector `p` (named, as `coef(m)` reports them).
   *  Used for the confidence band (delta method) and inverse prediction. */
  curveFn?: string;
  /** Coefficient names of the curve's lower/upper asymptotes (4PL only) —
   *  an unknown within the fit's residual scale of one is outside range. */
  asymptotes?: [string, string];
  /** nls models only: alternate `m<-nls(...)` assignments to retry, IN
   *  ORDER, when the primary fit fails. `fitModelSpec` tries each in turn
   *  and reports which one converged (`retryMethod`). The 4PLs chain the
   *  port optimizer first (prism-format parity: it fixes the Gauss-Newton
   *  stalls) and the relaxed tolerance second (Linux 4PL fix: the
   *  textbook dose data converges only that way — port fails it with
   *  "singular convergence (7)"). Order matters: the first success wins.
   *  Substrate inhibition retries once with its Ki start (plan 09). */
  retryFits?: { fit: string; method: string }[];
  /** A dose-response curve's formula (its right side) and midpoint, which
   *  comparing two curves shares (upstream 1.0.7). */
  dose?: { expr: string; midpoint: string };
  /** True when the model cannot be fitted without the radioligand
   *  concentration [L] (plan 28: homologous competition — [L] is a constant
   *  of its equation). The runner refuses before calling R when it is
   *  missing; other models take [L]/Kd only for the optional Fit-Ki
   *  derived rows (see modelSpec's opts). */
  needsRadioligand?: boolean;
}

// The 4PL's starting slope takes the curve's own sign, so a falling curve keeps Bottom under Top.
const SIGN = "if(isTRUE(cor(x,y)<0))-1 else 1";
const FOUR_LOG = "Bottom+(Top-Bottom)/(1+10^((LogEC50-x)*HillSlope))";
// Raw-concentration 4PL, guarded at X = 0 (prism-format-work (g)): the
// vehicle point is the Bottom anchor and stays in the fit, but (EC50/x)
// is Inf/NaN at x = 0 whenever a trial step takes EC50 ≤ 0 with a
// fractional HillSlope — R's nls then dies with "Missing value or an
// infinity produced when evaluating the model" on datasets Prism fits
// (39 such failures in the corpus sweep). ifelse returns Bottom at x = 0
// without evaluating the ratio there; for x > 0 the formula is unchanged,
// so fitted values on data without an X = 0 point do not move. (ifelse
// evaluates both branches, but a NaN in the unselected branch is
// discarded — the plateau-decay model already relies on this.)
const FOUR_X = "ifelse(x==0,Bottom,Bottom+(Top-Bottom)/(1+(EC50/x)^HillSlope))";
const nls200 = (expr: string, start: string) => `nls(y~${expr},start=${start},control=nls.control(maxiter=200))`;
/** The 4PL retry (Linux 4PL fix): the same nls call with a relaxed
 *  convergence tolerance. On near-perfect sigmoids the default tol=1e-5
 *  Gauss-Newton reaches the optimum, then stalls — the residual sum of
 *  squares is flat while the relative offset oscillates, step-halving
 *  bottoms out, and nls errors "step factor reduced below 'minFactor'".
 *  tol=1e-3 converges at the same optimum (verified in R and scipy). */
const nls200Tol = (expr: string, start: string) =>
  `nls(y~${expr},start=${start},control=nls.control(maxiter=200,tol=1e-3))`;

export function modelSpec(
  model: NonlinearModel,
  opts?: {
    /** Cheng–Prusoff divisor D = 1 + [L]/Kd (plan 28): when supplied, the
     *  competition models gain Ki derived rows (Ki = IC50 / D). */
    kiDivisor?: number;
    /** Radioligand concentration [L] (plan 28, homologous only): embedded
     *  as an R literal in its fit / curve / derived expressions, so every
     *  path that uses the spec (single fit, comparison, interpolation)
     *  sees the same constant. Absent, the expressions use the R variable
     *  `L` instead — the runner must then define it (it always supplies
     *  opts, after validating [L] > 0). */
    ligandConcentration?: number;
  },
): ModelSpec {
  switch (model) {
    case "line":
      return { kind: "lm", fit: "m<-lm(y~x)", terms: ["Intercept", "Slope"] };
    case "quadratic":
      return { kind: "lm", fit: "m<-lm(y~x+I(x^2))", terms: ["B0", "B1", "B2"] };
    case "cubic":
      return { kind: "lm", fit: "m<-lm(y~x+I(x^2)+I(x^3))", terms: ["B0", "B1", "B2", "B3"] };
    case "quartic":
      // Plan 29: 4th order polynomial — base R lm, the exact pattern of
      // the quadratic/cubic entries.
      return { kind: "lm", fit: "m<-lm(y~x+I(x^2)+I(x^3)+I(x^4))", terms: ["B0", "B1", "B2", "B3", "B4"] };
    case "quintic":
      // Plan 29: 5th order polynomial — same pattern, one degree higher.
      return {
        kind: "lm",
        fit: "m<-lm(y~x+I(x^2)+I(x^3)+I(x^4)+I(x^5))",
        terms: ["B0", "B1", "B2", "B3", "B4", "B5"],
      };
    case "segmental-linear":
      // Plan 29: continuous two-segment line (hinge), Y = B0 + B1·X +
      // B2·max(X − X0, 0): slope B1 below the breakpoint X0, B1+B2 above.
      // DEVIATION from the plan: the plan fits this with nls() from
      // B2 = 0, X0 = median(X) starts — that does not converge. At B2 = 0
      // the X0 gradient is zero ("singular gradient matrix at initial
      // parameter estimates"), and from a slope-difference B2 start (or
      // algorithm="port", or "plinear") Gauss-Newton stalls on the flat
      // RSS surface ("step factor reduced below 'minFactor'" / "false
      // convergence") — verified in R on the reference data from every
      // start (x0 = 2, 3.5, 5, 6; B2 = 0, 0.09, ±0.5). The model is
      // linear given X0, so X0 is fitted by profiling instead: optimize()
      // (Brent, derivative-free) minimises the conditional-lm RSS over
      // [min X, max X], and the fit is the lm at that breakpoint. X0 is
      // therefore a derived value with no standard error (the runner
      // reports it as a coefficient row with no SE — the fixed-parameter
      // precedent), and a global fit is not supported for it
      // (formulaVariables is undefined for this multi-statement fit, so
      // runGlobalNonlinear refuses it cleanly). The slopes' CIs are
      // positional (cf[[2]], cf[[3]]) because lm() names the hinge term
      // "I(pmax(x - brk, 0))", not "b2". `brk` (not `x0`) names the
      // breakpoint variable, so it cannot collide with the curve-
      // comparison code's x0/y0/x1/y1 vectors.
      return {
        kind: "lm",
        fit: "brk<-optimize(function(v)sum(residuals(lm(y~x+I(pmax(x-v,0))))^2),c(min(x),max(x)))$minimum;m<-lm(y~x+I(pmax(x-brk,0)))",
        terms: ["B0", "B1", "B2"],
        derived: [
          { label: "Breakpoint (X0)", expr: "brk" },
          {
            label: "Slope below X0",
            expr: "cf[[2]]",
            low: "cf[[2]]-q*sqrt(V[2,2])",
            high: "cf[[2]]+q*sqrt(V[2,2])",
          },
          {
            label: "Slope above X0",
            expr: "cf[[2]]+cf[[3]]",
            low: "cf[[2]]+cf[[3]]-q*sqrt(V[2,2]+V[3,3]+2*V[2,3])",
            high: "cf[[2]]+cf[[3]]+q*sqrt(V[2,2]+V[3,3]+2*V[2,3])",
          },
        ],
      };
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
      // The retries are the port optimizer first, then a relaxed tolerance
      // (see retryFits): the primary stays Gauss-Newton, so every pinned
      // 4PL number is untouched — only a dataset the primary cannot
      // converge on takes a retry. Order matters: the first success wins.
      return {
        kind: "nls",
        fit: `m<-${nls200(FOUR_LOG, `list(Bottom=min(y),Top=max(y),LogEC50=median(x),HillSlope=${SIGN})`)}`,
        // (g) parity + C4 chain: Gauss-Newton stalls ("singular gradient"
        // / "step factor reduced below 'minFactor'") on flat,
        // ill-determined curves Prism fits (41 such failures in the corpus
        // sweep, all log-X) — retry with the port optimizer first, same
        // starts, then with a relaxed tolerance (the Linux 4PL fix: the
        // textbook dose data converges only that way — port fails it with
        // "singular convergence (7)"). The retries only run when the
        // primary fit fails, so passing fits never touch them and their
        // pinned values do not move. Order matters: the first success wins.
        retryFits: [
          {
            fit: `m<-nls(y~${FOUR_LOG},start=list(Bottom=min(y),Top=max(y),LogEC50=median(x),HillSlope=${SIGN}),algorithm="port",control=nls.control(maxiter=200))`,
            method: "port",
          },
          {
            fit: `m<-${nls200Tol(FOUR_LOG, `list(Bottom=min(y),Top=max(y),LogEC50=median(x),HillSlope=${SIGN})`)}`,
            method: "relaxed tolerance",
          },
        ],
        terms: ["Bottom", "Top", "LogEC50", "HillSlope"],
        derived: [tenTo("EC50", "LogEC50"), span],
        curveFn:
          'g<-function(xv,p) p[["Bottom"]]+(p[["Top"]]-p[["Bottom"]])/(1+10^((p[["LogEC50"]]-xv)*p[["HillSlope"]]))',
        asymptotes: ["Bottom", "Top"],
        dose: { expr: FOUR_LOG, midpoint: "LogEC50" },
      };
    case "sigmoidal-4pl-x":
      // X is the raw concentration; EC50 is fitted directly.
      // Same port-then-relaxed retries as the logx twin, for symmetry: the
      // raw-concentration parameterisation converges at the default
      // tolerance on the textbook data, but a flat-asymptote dataset can
      // stall it the same way.
      return {
        kind: "nls",
        fit: `m<-${nls200(FOUR_X, `list(Bottom=min(y),Top=max(y),EC50=median(x[x>0]),HillSlope=${SIGN})`)}`,
        // (g) parity + C4 chain: same port-then-relaxed retries as the
        // log-X form, for the Gauss-Newton failures that are not X = 0
        // artefacts.
        retryFits: [
          {
            fit: `m<-nls(y~${FOUR_X},start=list(Bottom=min(y),Top=max(y),EC50=median(x[x>0]),HillSlope=${SIGN}),algorithm="port",control=nls.control(maxiter=200))`,
            method: "port",
          },
          {
            fit: `m<-${nls200Tol(FOUR_X, `list(Bottom=min(y),Top=max(y),EC50=median(x[x>0]),HillSlope=${SIGN})`)}`,
            method: "relaxed tolerance",
          },
        ],
        terms: ["Bottom", "Top", "EC50", "HillSlope"],
        derived: [span],
        nonNegativeX: true,
        curveFn:
          'g<-function(xv,p) ifelse(xv==0,p[["Bottom"]],p[["Bottom"]]+(p[["Top"]]-p[["Bottom"]])/(1+(p[["EC50"]]/xv)^p[["HillSlope"]]))',
        asymptotes: ["Bottom", "Top"],
        dose: { expr: FOUR_X, midpoint: "EC50" },
      };
    case "agonist-3pl-logx": {
      // The Hill slope is 1: a rising curve.
      const expr = "Bottom+(Top-Bottom)/(1+10^(LogEC50-x))";
      return {
        kind: "nls",
        fit: `m<-${nls200(expr, "list(Bottom=min(y),Top=max(y),LogEC50=median(x))")}`,
        terms: ["Bottom", "Top", "LogEC50"],
        derived: [tenTo("EC50", "LogEC50"), span],
        curveFn:
          'g<-function(xv,p) p[["Bottom"]]+(p[["Top"]]-p[["Bottom"]])/(1+10^(p[["LogEC50"]]-xv))',
        asymptotes: ["Bottom", "Top"],
        dose: { expr, midpoint: "LogEC50" },
      };
    }
    case "inhibitor-3pl-logx": {
      // The Hill slope is −1: a falling curve. Prism's "One site — Fit
      // logIC50"; with opts.kiDivisor it also reports Ki (Cheng–Prusoff).
      const expr = "Bottom+(Top-Bottom)/(1+10^(x-LogIC50))";
      return {
        kind: "nls",
        fit: `m<-${nls200(expr, "list(Bottom=min(y),Top=max(y),LogIC50=median(x))")}`,
        terms: ["Bottom", "Top", "LogIC50"],
        derived: [
          tenTo("IC50", "LogIC50"),
          ...(opts?.kiDivisor != null ? [kiFromLog("Ki", "LogIC50", opts.kiDivisor)] : []),
          span,
        ],
        curveFn:
          'g<-function(xv,p) p[["Bottom"]]+(p[["Top"]]-p[["Bottom"]])/(1+10^(xv-p[["LogIC50"]]))',
        asymptotes: ["Bottom", "Top"],
        dose: { expr, midpoint: "LogIC50" },
      };
    }
    case "asymmetric-5pl-logx": {
      // Prism's 5PL: the curve's asymmetry S (1 = the 4PL); it starts from the 4PL's fit.
      const expr = "Bottom+(Top-Bottom)/(1+10^((LogEC50+log10(2^(1/S)-1)/HillSlope-x)*HillSlope))^S";
      return {
        kind: "nls",
        fit: `m<-${nls200(expr, `c(as.list(coef(${nls200(FOUR_LOG, `list(Bottom=min(y),Top=max(y),LogEC50=median(x),HillSlope=${SIGN})`)})),S=1)`)}`,
        terms: ["Bottom", "Top", "LogEC50", "HillSlope", "S"],
        derived: [tenTo("EC50", "LogEC50"), span],
        curveFn:
          'g<-function(xv,p) p[["Bottom"]]+(p[["Top"]]-p[["Bottom"]])/(1+10^((p[["LogEC50"]]+log10(2^(1/p[["S"]])-1)/p[["HillSlope"]]-xv)*p[["HillSlope"]]))^p[["S"]]',
        asymptotes: ["Bottom", "Top"],
        dose: { expr, midpoint: "LogEC50" },
      };
    }
    case "asymmetric-5pl-x": {
      // Same X = 0 guard as FOUR_X (see above): at x = 0 the curve is its
      // Bottom; the unguarded ratio is Inf/NaN there whenever a trial
      // step takes EC50 ≤ 0.
      const expr =
        "ifelse(x==0,Bottom,Bottom+(Top-Bottom)/(1+(EC50*(2^(1/S)-1)^(1/HillSlope)/x)^HillSlope)^S)";
      return {
        kind: "nls",
        fit: `m<-${nls200(expr, `c(as.list(coef(${nls200(FOUR_X, `list(Bottom=min(y),Top=max(y),EC50=median(x[x>0]),HillSlope=${SIGN})`)})),S=1)`)}`,
        terms: ["Bottom", "Top", "EC50", "HillSlope", "S"],
        derived: [span],
        nonNegativeX: true,
        curveFn:
          'g<-function(xv,p) ifelse(xv==0,p[["Bottom"]],p[["Bottom"]]+(p[["Top"]]-p[["Bottom"]])/(1+((p[["EC50"]]*(2^(1/p[["S"]])-1)^(1/p[["HillSlope"]]))/xv)^p[["HillSlope"]])^p[["S"]])',
        asymptotes: ["Bottom", "Top"],
        dose: { expr, midpoint: "EC50" },
      };
    }
    case "hyperbola":
      // Y = Bmax * X / (Kd + X).
      return {
        kind: "nls",
        fit: `m<-${nls200("Bmax*x/(Kd+x)", "list(Bmax=max(y)*1.1,Kd=median(x[x>0]))")}`,
        terms: ["Bmax", "Kd"],
        nonNegativeX: true,
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
          overK("Half-life", "log(2)"),
          overK("Tau", "1"),
          difference("Y0", "Plateau"),
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
          overK("Half-life (fast)", "log(2)", "K1"),
          overK("Half-life (slow)", "log(2)", "K2"),
          sumOf("Span1", "Span2"),
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
        derived: [overK("Half-life", "log(2)"), difference("Y0", "Plateau")],
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
        derived: [overK("Half-life", "log(2)"), difference("Plateau", "Y0")],
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
        derived: [overK("Doubling time", "log(2)"), overK("Tau", "1")],
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
    // the Km/Khalf start values. All three set nonNegativeX (R3-10): the
    // interpolation grid and point-estimate search must stay at X ≥ 0 —
    // below zero allosteric-sigmoidal is NaN for a non-integer Hill slope
    // and Michaelis-Menten's pole at −Km captures the band inversion.
    case "michaelis-menten": {
      // Y = Vmax·X / (Km + X). Vmax/Km's CI is the delta method (upstream
      // reports no CI for it; Prism does).
      const ratio = 'cf[["Vmax"]]/cf[["Km"]]';
      const se =
        'sqrt(V["Vmax","Vmax"]/cf[["Km"]]^2+cf[["Vmax"]]^2*V["Km","Km"]/cf[["Km"]]^4-2*cf[["Vmax"]]*V["Vmax","Km"]/cf[["Km"]]^3)';
      return {
        kind: "nls",
        fit: "m<-nls(y~Vmax*x/(Km+x),start=list(Vmax=max(y)*1.1,Km=median(x[x>0])),algorithm=\"port\")",
        terms: ["Vmax", "Km"],
        nonNegativeX: true,
        derived: [
          {
            label: "Vmax/Km",
            expr: `ifelse(cf[["Km"]]>0,${ratio},NA_real_)`,
            low: `ifelse(cf[["Km"]]>0,${ratio}-q*${se},NA_real_)`,
            high: `ifelse(cf[["Km"]]>0,${ratio}+q*${se},NA_real_)`,
          },
        ],
        curveFn: 'g<-function(xv,p) p[["Vmax"]]*xv/(p[["Km"]]+xv)',
      };
    }
    case "allosteric-sigmoidal":
      // Y = Vmax·X^h / (Khalf^h + X^h).
      return {
        kind: "nls",
        fit: "m<-nls(y~Vmax*x^h/(Khalf^h+x^h),start=list(Vmax=max(y)*1.1,Khalf=median(x[x>0]),h=1),algorithm=\"port\")",
        terms: ["Vmax", "Khalf", "HillSlope"],
        nonNegativeX: true,
        curveFn: 'g<-function(xv,p) p[["Vmax"]]*xv^p[["h"]]/(p[["Khalf"]]^p[["h"]]+xv^p[["h"]])',
      };
    case "substrate-inhibition":
      // Y = Vmax·X / (Km + X + X²/Ki). Ki's start is the least robust, so
      // the fit is retried once with Ki = 5 × median(S) if nls() fails.
      return {
        kind: "nls",
        fit: "m<-nls(y~Vmax*x/(Km+x+x^2/Ki),start=list(Vmax=max(y)*1.5,Km=median(x[x>0]),Ki=max(x)),algorithm=\"port\")",
        terms: ["Vmax", "Km", "Ki"],
        nonNegativeX: true,
        curveFn: 'g<-function(xv,p) p[["Vmax"]]*xv/(p[["Km"]]+xv+xv^2/p[["Ki"]])',
        retryFits: [
          {
            fit: "m<-nls(y~Vmax*x/(Km+x+x^2/Ki),start=list(Vmax=max(y)*1.5,Km=median(x[x>0]),Ki=median(x[x>0])*5),algorithm=\"port\")",
            method: "port",
          },
        ],
      };
    // ── Binding — Competition (plan 28) ─────────────────────────────────
    // Prism's built-in "Two sites — Fit logIC50" fixes BOTH Hill slopes at
    // −1 (standard slope):
    //   Y = Bottom + (Top−Bottom)·(Frac/(1+10^(X−LogIC50Hi)) + (1−Frac)/(1+10^(X−LogIC50Lo)))
    // Source: GraphPad Prism Curve Fitting Guide, "Equation: Two sites -
    // Fit logIC50" (graphpad.com/guides/prism/10/curve-fitting/reg_competition_two_sites_ic50.htm).
    // DEVIATION from the plan: the plan's equation carries a shared fitted
    // HillSlope — that is Prism's older "classic" variable-slope form, not
    // the built-in model, so this build has no HillSlope term.
    // Both two-site fits use nls() algorithm "port": the default
    // Gauss-Newton fails on (near-)noiseless two-site data in WebR's R
    // ("step factor reduced below 'minFactor'"), while "port" recovers the
    // generating parameters exactly (verified in R before implementing).
    // FractionHi is bounded to [0,1] — outside it, the "fraction" is meaningless.
    case "two-site-competition-logx": {
      const expr =
        "Bottom+(Top-Bottom)*(FractionHi/(1+10^(x-LogIC50Hi))+(1-FractionHi)/(1+10^(x-LogIC50Lo)))";
      // Starting values (the plan's strategy — a bad start is the #1 reason
      // two-site fits fail): the high-affinity LogIC50 from the
      // low-concentration half's median X, the low-affinity one from the
      // high half's, Frac = 0.5.
      const start =
        "list(Bottom=min(y),Top=max(y),LogIC50Hi=median(x[x<=median(x)]),LogIC50Lo=median(x[x>median(x)]),FractionHi=0.5)";
      return {
        kind: "nls",
        fit:
          `m<-nls(y~${expr},start=${start},algorithm="port",` +
          `lower=c(-Inf,-Inf,-Inf,-Inf,0),upper=c(Inf,Inf,Inf,Inf,1),control=nls.control(maxiter=200))`,
        terms: ["Bottom", "Top", "LogIC50Hi", "LogIC50Lo", "FractionHi"],
        derived: [
          tenTo("IC50 (high affinity)", "LogIC50Hi"),
          ...(opts?.kiDivisor != null ? [kiFromLog("Ki (high affinity)", "LogIC50Hi", opts.kiDivisor)] : []),
          tenTo("IC50 (low affinity)", "LogIC50Lo"),
          ...(opts?.kiDivisor != null ? [kiFromLog("Ki (low affinity)", "LogIC50Lo", opts.kiDivisor)] : []),
          span,
        ],
        curveFn:
          'g<-function(xv,p) p[["Bottom"]]+(p[["Top"]]-p[["Bottom"]])*(p[["FractionHi"]]/(1+10^(xv-p[["LogIC50Hi"]]))+(1-p[["FractionHi"]])/(1+10^(xv-p[["LogIC50Lo"]])))',
        asymptotes: ["Bottom", "Top"],
        dose: { expr, midpoint: "LogIC50Hi" },
      };
    }
    case "two-site-competition-x": {
      // Same model, X the raw concentration: 1/(1+X/IC50) is the fixed-slope
      // (−1) form in concentration units. X = 0 vehicle points are dropped
      // (positiveX), as for the other ratio forms. The raw-concentration
      // parameterisation is worse conditioned than the log form: in WebR's
      // R 4.6.0 the half-median starts that the log form uses fail here
      // ("singular convergence"), so this model starts from the geometric
      // mean of each half instead (concentrations are log-spaced in
      // practice) and retries once from the half-medians without bounds if
      // port still fails — both start strategies were verified in WebR on
      // the noiseless fixture before implementing (the retry is modelSpec's
      // retryFits, the substrate-inhibition pattern).
      const expr = "Bottom+(Top-Bottom)*(FractionHi/(1+x/IC50Hi)+(1-FractionHi)/(1+x/IC50Lo))";
      const geoStart =
        "list(Bottom=min(y),Top=max(y),IC50Hi=10^mean(log10(x[x<=median(x)])),IC50Lo=10^mean(log10(x[x>median(x)])),FractionHi=0.5)";
      const medianStart =
        "list(Bottom=min(y),Top=max(y),IC50Hi=median(x[x<=median(x)]),IC50Lo=median(x[x>median(x)]),FractionHi=0.5)";
      return {
        kind: "nls",
        fit:
          `m<-nls(y~${expr},start=${geoStart},algorithm="port",` +
          `lower=c(-Inf,-Inf,0,0,0),upper=c(Inf,Inf,Inf,Inf,1),control=nls.control(maxiter=200))`,
        terms: ["Bottom", "Top", "IC50Hi", "IC50Lo", "FractionHi"],
        derived: [
          ...(opts?.kiDivisor != null ? [kiFromLinear("Ki (high affinity)", "IC50Hi", opts.kiDivisor)] : []),
          ...(opts?.kiDivisor != null ? [kiFromLinear("Ki (low affinity)", "IC50Lo", opts.kiDivisor)] : []),
          span,
        ],
        nonNegativeX: true,
        curveFn:
          'g<-function(xv,p) p[["Bottom"]]+(p[["Top"]]-p[["Bottom"]])*(p[["FractionHi"]]/(1+xv/p[["IC50Hi"]])+(1-p[["FractionHi"]])/(1+xv/p[["IC50Lo"]]))',
        asymptotes: ["Bottom", "Top"],
        dose: { expr, midpoint: "IC50Hi" },
        retryFits: [
          {
            fit: `m<-nls(y~${expr},start=${medianStart},algorithm="port",control=nls.control(maxiter=200))`,
            method: "port",
          },
        ],
      };
    }
    case "homologous-competition-logx": {
      // Prism's "One site — Homologous": the labeled and unlabeled ligands
      // are the same compound, so Ki = Kd by definition. With [L] the
      // radioligand concentration (same units as 10^X) and Kd fitted:
      //   Cold = 10^X;  Y = Bmax·[L]/([L] + Cold + Kd) + Bottom
      // fitted as LogKd, so Kd = 10^LogKd > 0 by construction (the plan's
      // "negative Kd" case cannot occur). Source: GraphPad Prism Curve
      // Fitting Guide, "Equation: One site - Homologous"
      // (graphpad.com/guides/prism/7/curve-fitting/reg_homologous_one_site_two_conc.htm).
      // The default Gauss-Newton fails on (near-)noiseless homologous data
      // ("singular gradient"); algorithm "port" recovers the generating
      // parameters exactly (verified in R before implementing). The cold
      // concentration displacing half the hot binding is IC50 = [L] + Kd.
      const l =
        opts?.ligandConcentration != null && Number.isFinite(opts.ligandConcentration)
          ? String(opts.ligandConcentration)
          : "L";
      const expr = `Bmax*${l}/(${l}+10^x+10^LogKd)+Bottom`;
      return {
        kind: "nls",
        fit:
          `m<-nls(y~${expr},start=list(Bmax=(max(y)-min(y))*(${l}+10^median(x))/${l},` +
          `LogKd=median(x),Bottom=min(y)),algorithm="port",control=nls.control(maxiter=200))`,
        terms: ["Bmax", "LogKd", "Bottom"],
        derived: [
          tenTo("Kd", "LogKd"),
          {
            label: "IC50",
            expr: `${l}+10^cf[["LogKd"]]`,
            low: `${l}+10^pci("LogKd")[1]`,
            high: `${l}+10^pci("LogKd")[2]`,
          },
        ],
        curveFn: `g<-function(xv,p) p[["Bmax"]]*${l}/(${l}+10^xv+10^p[["LogKd"]])+p[["Bottom"]]`,
        dose: { expr, midpoint: "LogKd" },
        needsRadioligand: true,
      };
    }
    default:
      throw new Error(`Model "${model}" is not implemented in the shared fit yet.`);
  }
}

/** The formula's right-hand side: the `EXPR` of `m<-nls(y~EXPR,start=...)`
 *  (lm specs have no nls formula — `undefined`). Plan 26 needs it for the
 *  global fit's stacked formula; the first `,start=` after `y~` delimits it
 *  (no formula contains that sequence; the 5PL's inner nls comes later). */
export function formulaExpr(spec: ModelSpec): string | undefined {
  const fit = spec.fit;
  const yAt = fit.indexOf("y~");
  if (yAt < 0) return undefined;
  const startAt = fit.indexOf(",start=", yAt);
  if (startAt < 0) return undefined;
  return fit.slice(yAt + 2, startAt);
}

/** Index of the `)` matching the `(` at `open` (-1 when unbalanced). */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a comma list at depth 0 (parentheses respected). */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

/** The R variable name of each term, in terms order, read off the fit's
 *  start list (`list(Bottom=...,Top=...)` or the 5PL's
 *  `c(as.list(coef(<inner nls>)),S=1)` — the inner fit's start list, then
 *  the plain entries). Usually identical to the terms; the exception is the
 *  allosteric sigmoidal, whose Hill slope is the variable `h`. `undefined`
 *  when the start list cannot be parsed — the caller must refuse to rewrite
 *  the fit rather than guess. */
export function formulaVariables(spec: ModelSpec): string[] | undefined {
  const startAt = spec.fit.indexOf(",start=");
  if (startAt < 0) return undefined;
  return startVariables(spec.fit.slice(startAt + 7));
}

/** The model's data-driven start expressions (`Name=expr` over `x`/`y`,
 *  in start-list order) — what the single-curve fit starts from. Only a
 *  plain `list(...)` start qualifies: a 5PL's `c(as.list(coef(...)), S=1)`
 *  start needs its inner fit first, so it returns undefined. The global
 *  fit's restart ladder (F5-hom) evaluates these per series to rebuild
 *  stacked starts far from the singles' fitted values. */
export function startExpressions(spec: ModelSpec): { name: string; expr: string }[] | undefined {
  const startAt = spec.fit.indexOf(",start=list(");
  if (startAt < 0) return undefined;
  const s = spec.fit.slice(startAt + 7);
  const close = matchParen(s, 4);
  if (close < 0) return undefined;
  const out: { name: string; expr: string }[] = [];
  for (const e of splitTopLevel(s.slice(5, close))) {
    const m = e.trim().match(/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.+)$/s);
    if (!m) return undefined;
    out.push({ name: m[1], expr: m[2].trim() });
  }
  return out.length ? out : undefined;
}

/** Variable names of one start expression (`list(...)` / `c(...)`). */
function startVariables(expr: string): string[] | undefined {
  const s = expr.trim();
  if (s.startsWith("list(")) {
    const close = matchParen(s, 4);
    if (close < 0) return undefined;
    const names: string[] = [];
    for (const e of splitTopLevel(s.slice(5, close))) {
      const m = e.trim().match(/^([A-Za-z][A-Za-z0-9_]*)\s*=/);
      if (!m) return undefined;
      names.push(m[1]);
    }
    return names;
  }
  if (s.startsWith("c(")) {
    const close = matchParen(s, 1);
    if (close < 0) return undefined;
    const out: string[] = [];
    for (const e of splitTopLevel(s.slice(2, close))) {
      const t = e.trim();
      if (t.startsWith("as.list(coef(")) {
        const innerStart = t.indexOf(",start=");
        if (innerStart < 0) return undefined;
        const inner = startVariables(t.slice(innerStart + 7));
        if (!inner) return undefined;
        out.push(...inner);
      } else {
        const m = t.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=/);
        if (!m) return undefined;
        out.push(m[1]);
      }
    }
    return out;
  }
  return undefined;
}

// ── Fit options (plan 26): weighting, fixed parameters, bounds ──────────
// A fixed parameter is substituted as a constant into the formula (and the
// derived expressions, the curve function and the dose expression) and
// dropped from the start list — nls() ERRORS on a start value for a
// parameter the formula no longer has ("singular gradient matrix at initial
// parameter estimates", verified in R), so the drop is not optional, and
// the 5PL's inner nls (which only supplies starts) is rewritten the same
// way. Bounds switch the fit to algorithm="port" with lower/upper vectors
// aligned with the remaining parameters' start order (±Inf where unbounded);
// a start outside its bounds makes nls fail with "initial par violates
// constraints", surfaced as the usual fit error. Weights add `weights=w`
// (the vector is assigned before the fit) and the summary quantities become
// the weighted ones — summary(lm)'s R² is the weighted one, so the weighted
// SS/SST definitions below match it (verified in R: 0.998473 either way).

/** Per-point weights (same order as xs/ys), parameters held constant, and
 *  parameter bounds — all optional; absent means the historical fit. */
export interface FitOptions {
  weights?: number[];
  fixed?: Record<string, number>;
  bounds?: Record<string, [number, number]>;
}

export interface AppliedFitOptions {
  /** The spec to fit (terms/derived/curveFn/dose rewritten when parameters
   *  are fixed; fit rewritten for weights/bounds). */
  spec: ModelSpec;
  /** R run before the fit (the weights vector, when weighted). */
  extraAssignments: string;
}

const rNum = (v: number): string => {
  if (!Number.isFinite(v)) throw new Error(`Not a finite number: ${v}`);
  return String(v);
};

/** Substitute fixed parameters as constants in a formula (bare names). */
function substituteFormula(expr: string, fixedByVar: Record<string, number>): string {
  let out = expr;
  for (const [name, value] of Object.entries(fixedByVar))
    out = out.replace(new RegExp(`\\b${name}\\b`, "g"), `(${rNum(value)})`);
  return out;
}

/** Substitute fixed parameters in a curve function (`p[["Name"]]`). */
function substituteCurveFn(fn: string, fixedByVar: Record<string, number>): string {
  let out = fn;
  for (const [name, value] of Object.entries(fixedByVar))
    out = out.replaceAll(`p[["${name}"]]`, `(${rNum(value)})`);
  return out;
}

/** Substitute fixed parameters in a derived expression: `cf[["P"]]` becomes
 *  the constant, `pci("P")` its degenerate CI, and any covariance with P
 *  becomes 0 (a fixed parameter has no variance). */
function substituteDerived(expr: string, fixedByVar: Record<string, number>): string {
  let out = expr;
  for (const [name, value] of Object.entries(fixedByVar)) {
    const v = rNum(value);
    out = out.replaceAll(`pci("${name}")`, `c(${v},${v})`);
    out = out.replaceAll(`cf[["${name}"]]`, `(${v})`);
    out = out.replace(new RegExp(`V\\["${name}","[^"]+"\\]`, "g"), "0");
    out = out.replace(new RegExp(`V\\["[^"]+","${name}"\\]`, "g"), "0");
  }
  return out;
}

/** Rewrite one nls call's start list, dropping the fixed variables and
 *  rewriting any inner nls the same way (the 5PL's start supplier). */
function transformStart(start: string, fixedByVar: Record<string, number>): string {
  const s = start.trim();
  if (s.startsWith("list(")) {
    const close = matchParen(s, 4);
    if (close < 0) throw new Error("Cannot parse the fit's start list.");
    const kept = splitTopLevel(s.slice(5, close)).filter((e) => {
      const m = e.trim().match(/^([A-Za-z][A-Za-z0-9_]*)\s*=/);
      return !m || !Object.hasOwn(fixedByVar, m[1]);
    });
    return `list(${kept.join(",")})`;
  }
  if (s.startsWith("c(")) {
    const close = matchParen(s, 1);
    if (close < 0) throw new Error("Cannot parse the fit's start list.");
    const kept = splitTopLevel(s.slice(2, close))
      .map((e) => {
        const t = e.trim();
        if (!t.startsWith("as.list(coef(")) return t;
        // The inner nls supplies starts: rewrite it the same way, so a
        // fixed parameter leaves its coefficient list too. The inner call
        // is the `nls(...)` ending at its own matching paren (the trailing
        // `))` closes coef(/as.list(), not the call).
        const nlsAt = t.indexOf("nls(");
        const callClose = matchParen(t, nlsAt + 3);
        if (callClose < 0) throw new Error("Cannot parse the fit's start list.");
        const inner = transformNlsCall(t.slice(nlsAt, callClose + 1), fixedByVar, {});
        return t.slice(0, nlsAt) + inner + t.slice(callClose + 1);
      })
      .filter((e) => {
        const m = e.trim().match(/^([A-Za-z][A-Za-z0-9_]*)\s*=/);
        return !m || !Object.hasOwn(fixedByVar, m[1]);
      });
    return `c(${kept.join(",")})`;
  }
  throw new Error("Cannot parse the fit's start list.");
}

/** Rewrite one `nls(y~EXPR,start=START,...)` call (with or without an
 *  `m<-` assignment): fixed variables substituted into the formula and
 *  dropped from the start list, bounds (when given, aligned with
 *  `remainingVars`) switching the call to algorithm="port". `bounds` is
 *  keyed by variable name. */
function transformNlsCall(
  call: string,
  fixedByVar: Record<string, number>,
  boundsByVar: Record<string, [number, number]>,
  remainingVars?: string[],
): string {
  const yAt = call.indexOf("y~");
  const startAt = call.indexOf(",start=", yAt);
  if (yAt < 0 || startAt < 0) throw new Error("Cannot parse the fit's formula.");
  const head = call.slice(0, yAt + 2);
  const expr = substituteFormula(call.slice(yAt + 2, startAt), fixedByVar);
  const rest = call.slice(startAt + 7);
  // The start expression (`list(...)` / `c(...)`) ends at its matching
  // paren; everything after it is the call's trailing arguments plus the
  // closing paren of nls(. They are parsed, not matched against a fixed
  // list: `,algorithm="port"`, `,control=nls.control(maxiter=200)` (or
  // with `,tol=1e-3` — the 4PL retry), `,lower=...`, `,upper=...`. The
  // control call is preserved verbatim — its tolerance is the retry's
  // point, and dropping it would silently re-impose tol=1e-5 on a retried
  // fit. lower/upper are dropped and regenerated below when bounds are
  // given; anything else unrecognised still throws rather than guessing.
  if (!rest.startsWith("list(") && !rest.startsWith("c(")) throw new Error("Cannot parse the fit's start list.");
  const openAt = rest.indexOf("(");
  const startClose = matchParen(rest, openAt);
  if (startClose < 0) throw new Error("Cannot parse the fit's start list.");
  const trailing = rest.slice(startClose + 1);
  if (!trailing.endsWith(")")) throw new Error("Cannot parse the fit's trailing arguments.");
  const trailingArgs = splitTopLevel(trailing.slice(0, -1).replace(/^,/, ""));
  const hadPort = trailingArgs.some((a) => a.trim() === 'algorithm="port"');
  const control = trailingArgs.find((a) => a.trim().startsWith("control="));
  for (const a of trailingArgs) {
    const t = a.trim();
    if (t !== 'algorithm="port"' && !t.startsWith("control=") && !t.startsWith("lower=") && !t.startsWith("upper="))
      throw new Error("Cannot parse the fit's trailing arguments.");
  }
  const start = transformStart(rest.slice(0, startClose + 1), fixedByVar);
  const boundNames = Object.keys(boundsByVar);
  let args = "";
  // The "port" algorithm must survive the rewrite (the exponential/enzyme
  // fits use it even unbounded); bounds switch a Gauss-Newton fit to it.
  if (boundNames.length || hadPort) args += `,algorithm="port"`;
  if (boundNames.length) {
    if (!remainingVars) throw new Error("Bounds need the parameter order.");
    const lower = remainingVars.map((v) => (boundsByVar[v] ? rNum(boundsByVar[v][0]) : "-Inf"));
    const upper = remainingVars.map((v) => (boundsByVar[v] ? rNum(boundsByVar[v][1]) : "Inf"));
    args += `,lower=c(${lower.join(",")}),upper=c(${upper.join(",")})`;
  }
  if (control) args += `,${control.trim()}`;
  return `${head}${expr},start=${start}${args})`;
}

/** Apply weighting / fixed parameters / bounds to a spec, returning the spec
 *  to fit and any R to run before it. Throws when the spec cannot be
 *  rewritten (lm models cannot fix or bound parameters — `lm()` has no such
 *  arguments). The default (no options) returns the spec untouched. */
export function applyFitOptions(spec: ModelSpec, opts: FitOptions): AppliedFitOptions {
  const fixed = opts.fixed ?? {};
  const bounds = opts.bounds ?? {};
  const fixedNames = Object.keys(fixed);
  const boundNames = Object.keys(bounds);
  const extraAssignments = opts.weights ? `w<-${rVec(opts.weights)};` : "";
  if (!fixedNames.length && !boundNames.length && !opts.weights) return { spec, extraAssignments: "" };
  if (spec.kind === "lm") {
    if (fixedNames.length || boundNames.length)
      throw new Error("Fixing or bounding parameters is only supported for nonlinear (nls) curves, not for line/polynomial fits.");
    // Weights only: `lm(y~x)` -> `lm(y~x,weights=w)`.
    if (!spec.fit.endsWith(")")) throw new Error("Cannot parse the fit's formula.");
    return { spec: { ...spec, fit: `${spec.fit.slice(0, -1)},weights=w)` }, extraAssignments };
  }
  const vars = formulaVariables(spec);
  if (!vars || vars.length !== spec.terms.length)
    throw new Error(`Cannot rewrite the "${spec.terms.join(", ")}" fit for fixed/bounded parameters.`);
  const fixedByVar: Record<string, number> = {};
  const boundsByVar: Record<string, [number, number]> = {};
  spec.terms.forEach((term, i) => {
    if (Object.hasOwn(fixed, term)) fixedByVar[vars[i]] = fixed[term]!;
    if (Object.hasOwn(bounds, term)) boundsByVar[vars[i]] = bounds[term]!;
  });
  const remainingTerms = spec.terms.filter((t) => !Object.hasOwn(fixed, t));
  const remainingVars = spec.terms.map((_, i) => vars[i]).filter((_, i) => !Object.hasOwn(fixed, spec.terms[i]));
  let fit = transformNlsCall(spec.fit, fixedByVar, boundsByVar, remainingVars);
  if (opts.weights) fit = `${fit.slice(0, -1)},weights=w)`;
  const out: ModelSpec = {
    ...spec,
    fit,
    terms: remainingTerms,
    derived: spec.derived?.map((d) => ({
      ...d,
      expr: substituteDerived(d.expr, fixedByVar),
      ...(d.low !== undefined ? { low: substituteDerived(d.low, fixedByVar) } : {}),
      ...(d.high !== undefined ? { high: substituteDerived(d.high, fixedByVar) } : {}),
    })),
    ...(spec.curveFn ? { curveFn: substituteCurveFn(spec.curveFn, fixedByVar) } : {}),
    ...(spec.dose ? { dose: { ...spec.dose, expr: substituteFormula(spec.dose.expr, fixedByVar) } } : {}),
    ...(spec.retryFits
      ? {
          retryFits: spec.retryFits.map((r) => ({
            fit: transformNlsCall(r.fit, fixedByVar, boundsByVar, remainingVars),
            method: r.method,
          })),
        }
      : {}),
  };
  if (opts.weights && out.retryFits)
    out.retryFits = out.retryFits.map((r) => ({ ...r, fit: `${r.fit.slice(0, -1)},weights=w)` }));
  return { spec: out, extraAssignments };
}

/** The X/Y columns and the points to fit: the `positiveX` X > 0 drop rule
 *  (log forms), the `nonNegativeX` X ≥ 0 drop rule (raw ratio forms), and
 *  the `nParams + 1` minimum-points rule, shared by both runners. */
export function prepareFit(
  columns: Column[],
  yName: string | undefined,
  model: NonlinearModel,
  /** Parameters held fixed (plan 26): they are not fitted, so they do not
   *  count toward the minimum-points rule. */
  fixedCount = 0,
): { xCol: Column; yCol: Column; xs: number[]; ys: number[]; rows: number[] } | { error: string } {
  const { x: xCol, ys: yCols } = splitXY(columns);
  // A Y data set's replicates pool into one fit (see datasetColumns): a name
  // that is no column but is a data set ("Control" → "Control_1..3") fits
  // every replicate point, as Prism does. A plain column name fits that
  // column alone. The pooled yCol keeps the first replicate's cells (so
  // interpolation still reads a Y per row) under the data set's name.
  const cols = yName === undefined ? (yCols[0] ? [yCols[0]] : []) : datasetColumns(yCols, yName);
  const yCol = cols.length === 1 ? cols[0] : cols.length > 1 ? { ...cols[0], name: yName! } : undefined;
  if (!xCol || !yCol) return { error: xyProblem(columns, yName)! };

  const complete =
    cols.length <= 1
      ? pairUp(xCol, yCol)
      : cols.reduce(
          (acc, c) => {
            const p = pairUp(xCol, c);
            return { x: [...acc.x, ...p.x], y: [...acc.y, ...p.y], rows: [...acc.rows, ...p.rows] };
          },
          { x: [] as number[], y: [] as number[], rows: [] as number[] },
        );
  const spec = modelSpec(model);
  const nParams = spec.terms.length - fixedCount;

  // A log-X curve drops its X = 0 vehicle/control point (log(0) is
  // undefined); a raw-concentration ratio curve keeps it — at X = 0 the
  // curve is its Bottom, so the vehicle point anchors Bottom (Prism fits
  // it too) — and drops only X < 0, where a fractional power is NaN in R.
  let xs = complete.x;
  let ys = complete.y;
  if (spec.positiveX || spec.nonNegativeX) {
    const keep = spec.positiveX ? (x: number) => x > 0 : (x: number) => x >= 0;
    xs = [];
    ys = [];
    complete.x.forEach((x, i) => {
      if (keep(x)) {
        xs.push(x);
        ys.push(complete.y[i]);
      }
    });
  }
  if (xs.length < nParams + 1) {
    const scope = spec.positiveX ? " with X > 0" : spec.nonNegativeX ? " with X ≥ 0" : "";
    return {
      error: `Not enough complete points${scope} (${xs.length}) to fit this curve; need at least ${nParams + 1}.`,
    };
  }
  if (ENZYME_MODELS.includes(model)) {
    // Substrate concentrations: negative X is a data error, and Km/Khalf
    // is unidentifiable with no positive X or with all X equal — validate
    // before calling R, not after it fails. The X = 0 vehicle point is
    // kept (the formulas are defined at X = 0); only the start values use
    // the positive X values. The negativity test reads the unfiltered
    // points: `nonNegativeX` drops X < 0 from `xs` above, so testing `xs`
    // would never fire (R3-10).
    if (complete.x.some((x) => x < 0)) return { error: "Substrate concentrations cannot be negative." };
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
  // The fitted points' rows, in fit order (plan 26: 1/SD² weights need the
  // row's replicate values, not just the fitted pair).
  const rows = complete.rows.filter(
    (_, i) => (!spec.positiveX && !spec.nonNegativeX) || (spec.positiveX ? complete.x[i] > 0 : complete.x[i] >= 0),
  );
  return { xCol, yCol, xs, ys, rows };
}

/** R statements that, after `m` is fitted, compute the summary quantities
 *  (`s`, `co`, `cf`, `df`, `ss`, `sst`, `r2`, `syx`) plus the covariance
 *  (`V`), the t critical value (`q`) and a coefficient's 95% CI (`pci`) —
 *  everything the fit entries and the derived CIs need. Weighted fits use
 *  the weighted sums of squares (summary(lm)'s R² is the weighted one, so
 *  this matches it — verified in R). */
export function fitSummaryStatements(spec: ModelSpec, weighted = false): string {
  // R² for lm comes from summary(); for nls we compute it from residual/total SS.
  // (A weighted lm's R² is 1 − weighted SS / weighted SST, like an nls's.)
  const r2 = spec.kind === "lm" && !weighted ? "s$r.squared" : "1-ss/sst";
  const ss = weighted ? "sum(w*residuals(m)^2)" : "sum(residuals(m)^2)";
  const sst = weighted ? "sum(w*(y-sum(w*y)/sum(w))^2)" : "sum((y-mean(y))^2)";
  return (
    `s<-summary(m);co<-s$coefficients;cf<-coef(m);` +
    `df<-df.residual(m);ss<-${ss};sst<-${sst};r2<-${r2};syx<-sqrt(ss/df);` +
    `V<-vcov(m);q<-qt(0.975,df);pci<-function(p)cf[[p]]+c(-1,1)*q*sqrt(V[p,p]);`
  );
}

/** R statements that assign `x`/`y`, fit `m`, and compute the summary
 *  quantities — everything up to the final `c(...)`. The caller appends its
 *  own result vector, so one eval can cover the fit plus further computation
 *  on it (interpolation, comparison).
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
  weighted = false,
): string {
  return (
    `x<-${rVec(xs)};y<-${rVec(ys)};${extraAssignments}${fitOverride ?? spec.fit};` +
    fitSummaryStatements(spec, weighted)
  );
}

export function fitStatements(xs: number[], ys: number[], model: NonlinearModel, fitOverride?: string): string {
  return fitStatementsForSpec(xs, ys, modelSpec(model), fitOverride);
}

/** The named entries the fit contributes to the result vector, in order.
 *  `cl`/`ch` are the 95% CIs (estimate ± t(0.975, df)·SE — on noiseless data
 *  the SEs are 0, so the intervals collapse to the estimates; the reference
 *  tests assert that, plus genuinely nonzero widths on a noisy fixture).
 *  A 5PL's asymmetry S is above 0, so its CI is taken on its log and stays
 *  there (upstream 1.0.7). `prefix` names a second set's entries in a
 *  curve comparison (`a_`/`b_`). */
export function fitEntries(spec: ModelSpec, prefix = ""): string {
  // Positional coefficient extraction (co has one row per term, in fit order).
  const coefAssigns = spec.terms
    .map((term, i) => {
      const est = `co[${i + 1},1]`;
      const se = `co[${i + 1},2]`;
      const [lo, hi] =
        term === "S"
          ? [`${est}*exp(-qt(0.975,df)*${se}/${est})`, `${est}*exp(qt(0.975,df)*${se}/${est})`]
          : [`${est}-qt(0.975,df)*${se}`, `${est}+qt(0.975,df)*${se}`];
      return (
        `${prefix}b${i}=${est},${prefix}se${i}=${se},${prefix}t${i}=co[${i + 1},3],` +
        `${prefix}pv${i}=co[${i + 1},4],${prefix}cl${i}=${lo},${prefix}ch${i}=${hi}`
      );
    })
    .join(",");
  const derived = spec.derived ?? [];
  const derivedAssigns = derived
    .map((d, i) => {
      const parts = [`${prefix}d${i}=${d.expr}`];
      if (d.low !== undefined && d.high !== undefined) parts.push(`${prefix}dl${i}=${d.low}`, `${prefix}dh${i}=${d.high}`);
      return parts.join(",");
    })
    .join(",");
  return `${prefix}r2=r2,${prefix}df=df,${prefix}ss=ss,${prefix}syx=syx,${coefAssigns}${derivedAssigns ? "," + derivedAssigns : ""}`;
}

/** A derived quantity's value, with its 95% CI when the spec defines one
 *  (binding/global-fit specs define none — their rows stay value-only). */
export interface DerivedRow extends StatRow {
  low?: number | null;
  high?: number | null;
}

/** The fit's coefficients, derived quantities and goodness-of-fit rows, read
 *  out of an `evalNamedVector` result that carries `fitEntries(spec)`.
 *  `labelTerm` names the coefficients as results show them (the nonlinear
 *  runner passes `termLabel`: "HillSlope" → "Hill slope", "S" →
 *  "Asymmetry (S)"); the shared-fit consumers keep the raw terms. */
export function parseFit(
  v: RVector,
  spec: ModelSpec,
  n: number,
  labelTerm: (term: string) => string = (t) => t,
  prefix = "",
): { coefficients: RegressionCoefficient[]; derived: DerivedRow[]; stats: StatRow[] } {
  const coefficients: RegressionCoefficient[] = spec.terms.map((term, i) => ({
    term: labelTerm(term),
    estimate: v[`${prefix}b${i}`] ?? null,
    stdError: v[`${prefix}se${i}`] ?? null,
    t: v[`${prefix}t${i}`] ?? null,
    p: v[`${prefix}pv${i}`] ?? null,
    low: v[`${prefix}cl${i}`] ?? null,
    high: v[`${prefix}ch${i}`] ?? null,
  }));
  const derived: DerivedRow[] = (spec.derived ?? []).map((d, i) => {
    const row: DerivedRow = { label: d.label, value: v[`${prefix}d${i}`] ?? null };
    if (d.low !== undefined && d.high !== undefined) {
      row.low = v[`${prefix}dl${i}`] ?? null;
      row.high = v[`${prefix}dh${i}`] ?? null;
    }
    return row;
  });
  const stats: StatRow[] = [
    { label: "R squared", value: v[`${prefix}r2`] },
    { label: "Sy.x", value: v[`${prefix}syx`] },
    { label: "Sum of squares", value: v[`${prefix}ss`] },
    { label: "Degrees of freedom", value: v[`${prefix}df`] },
    { label: "N", value: n },
  ];
  return { coefficients, derived, stats };
}

export interface NonlinearFit {
  coefficients: RegressionCoefficient[];
  derived: DerivedRow[];
  stats: StatRow[];
  /** The exact R code that was evaluated (for debugging). */
  rCode: string;
  /** True when the primary fit failed and the alternate-start retry
   *  (substrate inhibition's Ki) converged instead — the runner notes it. */
  retried?: boolean;
  /** Which retry converged, when `retried` is true — the `method` of the
   *  winning `retryFits` entry ("port", "relaxed tolerance", …). The
   *  runner names it in the result note. */
  retryMethod?: string;
}

/** Fit a model spec (not necessarily one of the curated nonlinear models)
 *  and return its coefficients, derived quantities and goodness-of-fit rows —
 *  one R call per attempt: the primary, then each `retryFits` entry in
 *  order until one converges. The binding runners (plan 16) fit their own
 *  specs through this, so there is exactly one nls call site in the repo. */
export async function fitModelSpec(
  xs: number[],
  ys: number[],
  spec: ModelSpec,
  extraAssignments = "",
  labelTerm: (term: string) => string = (t) => t,
  options?: FitOptions,
): Promise<NonlinearFit> {
  const applied = applyFitOptions(spec, options ?? {});
  const eff = applied.spec;
  const extra = extraAssignments + applied.extraAssignments;
  const weighted = !!(options?.weights);
  const attempts: ({ fit?: string; method?: string } | undefined)[] = [undefined, ...(eff.retryFits ?? [])];
  let lastErr: unknown;
  for (const attempt of attempts) {
    const rCode = `${fitStatementsForSpec(xs, ys, eff, attempt?.fit, extra, weighted)}c(${fitEntries(eff)})`;
    try {
      const v = await evalNamedVector(rCode);
      const { coefficients, derived, stats } = parseFit(v, eff, xs.length, labelTerm);
      return {
        coefficients,
        derived,
        stats,
        rCode,
        ...(attempt ? { retried: true, retryMethod: attempt.method } : {}),
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Fit the curve and return its coefficients, derived quantities and
 *  goodness-of-fit rows — one R call per attempt (the primary, then each
 *  retry in order). */
export async function fitNonlinearModel(
  xs: number[],
  ys: number[],
  model: NonlinearModel,
  labelTerm: (term: string) => string = (t) => t,
): Promise<NonlinearFit> {
  return fitModelSpec(xs, ys, modelSpec(model), "", labelTerm);
}

/** The nls non-convergence message, shared by both runners — it names the
 *  model, so a failure on an exponential curve says which one. */
export function fitError(err: unknown, model?: NonlinearModel): AnalysisOutcome {
  const which = model ? ` ("${MODEL_LABEL[model]}")` : "";
  // Plan 29: a segmental fit fails only on degenerate X (the breakpoint
  // is profiled, not iterated) — say what it needs, and point curved
  // data at the polynomials.
  const hint =
    model === "segmental-linear"
      ? " It needs X values on both sides of a breakpoint; for smoothly curved data, try a polynomial instead."
      : "";
  return {
    error: `This curve${which} could not be fitted to these data (${err instanceof Error ? err.message : String(err)}).${hint} Try another model or Y data set.`,
  };
}
