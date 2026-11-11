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
  /** A dose-response curve's formula (its right side) and midpoint, which
   *  comparing two curves shares (upstream 1.0.7). */
  dose?: { expr: string; midpoint: string };
}

// The 4PL's starting slope takes the curve's own sign, so a falling curve keeps Bottom under Top.
const SIGN = "if(isTRUE(cor(x,y)<0))-1 else 1";
const FOUR_LOG = "Bottom+(Top-Bottom)/(1+10^((LogEC50-x)*HillSlope))";
const FOUR_X = "Bottom+(Top-Bottom)/(1+(EC50/x)^HillSlope)";
const nls200 = (expr: string, start: string) => `nls(y~${expr},start=${start},control=nls.control(maxiter=200))`;

export function modelSpec(model: NonlinearModel): ModelSpec {
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
      return {
        kind: "nls",
        fit: `m<-${nls200(FOUR_LOG, `list(Bottom=min(y),Top=max(y),LogEC50=median(x),HillSlope=${SIGN})`)}`,
        terms: ["Bottom", "Top", "LogEC50", "HillSlope"],
        derived: [tenTo("EC50", "LogEC50"), span],
        curveFn:
          'g<-function(xv,p) p[["Bottom"]]+(p[["Top"]]-p[["Bottom"]])/(1+10^((p[["LogEC50"]]-xv)*p[["HillSlope"]]))',
        asymptotes: ["Bottom", "Top"],
        dose: { expr: FOUR_LOG, midpoint: "LogEC50" },
      };
    case "sigmoidal-4pl-x":
      // X is the raw concentration; EC50 is fitted directly.
      return {
        kind: "nls",
        fit: `m<-${nls200(FOUR_X, `list(Bottom=min(y),Top=max(y),EC50=median(x[x>0]),HillSlope=${SIGN})`)}`,
        terms: ["Bottom", "Top", "EC50", "HillSlope"],
        derived: [span],
        positiveX: true,
        curveFn: 'g<-function(xv,p) p[["Bottom"]]+(p[["Top"]]-p[["Bottom"]])/(1+(p[["EC50"]]/xv)^p[["HillSlope"]])',
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
      // The Hill slope is −1: a falling curve.
      const expr = "Bottom+(Top-Bottom)/(1+10^(x-LogIC50))";
      return {
        kind: "nls",
        fit: `m<-${nls200(expr, "list(Bottom=min(y),Top=max(y),LogIC50=median(x))")}`,
        terms: ["Bottom", "Top", "LogIC50"],
        derived: [tenTo("IC50", "LogIC50"), span],
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
      const expr = "Bottom+(Top-Bottom)/(1+(EC50*(2^(1/S)-1)^(1/HillSlope)/x)^HillSlope)^S";
      return {
        kind: "nls",
        fit: `m<-${nls200(expr, `c(as.list(coef(${nls200(FOUR_X, `list(Bottom=min(y),Top=max(y),EC50=median(x[x>0]),HillSlope=${SIGN})`)})),S=1)`)}`,
        terms: ["Bottom", "Top", "EC50", "HillSlope", "S"],
        derived: [span],
        positiveX: true,
        curveFn:
          'g<-function(xv,p) p[["Bottom"]]+(p[["Top"]]-p[["Bottom"]])/(1+((p[["EC50"]]*(2^(1/p[["S"]])-1)^(1/p[["HillSlope"]]))/xv)^p[["HillSlope"]])^p[["S"]]',
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
    // the Km/Khalf start values.
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
  // The start list ends where the outer call's trailing arguments begin:
  // `,control=nls.control(maxiter=200))` or `,algorithm="port")`.
  const suffixes = [",control=nls.control(maxiter=200))", ',algorithm="port")'];
  const suffix = suffixes.find((s) => rest.endsWith(s));
  if (!suffix) throw new Error("Cannot parse the fit's trailing arguments.");
  const start = transformStart(rest.slice(0, rest.length - suffix.length), fixedByVar);
  const hasControl = suffix.startsWith(",control=");
  const hadPort = suffix.startsWith(',algorithm=');
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
  if (hasControl) args += ",control=nls.control(maxiter=200)";
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
    ...(spec.retryFit
      ? { retryFit: transformNlsCall(spec.retryFit, fixedByVar, boundsByVar, remainingVars) }
      : {}),
  };
  if (opts.weights && out.retryFit) out.retryFit = `${out.retryFit.slice(0, -1)},weights=w)`;
  return { spec: out, extraAssignments };
}

/** The X/Y columns and the points to fit: the `positiveX` X > 0 drop rule and
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
  const yCol = yName === undefined ? yCols[0] : yCols.find((c) => c.name === yName);
  if (!xCol || !yCol) return { error: xyProblem(columns, yName)! };

  const complete = pairUp(xCol, yCol);
  const spec = modelSpec(model);
  const nParams = spec.terms.length - fixedCount;

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
  // The fitted points' rows, in fit order (plan 26: 1/SD² weights need the
  // row's replicate values, not just the fitted pair).
  const rows = complete.rows.filter((_, i) => !spec.positiveX || complete.x[i] > 0);
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
  labelTerm: (term: string) => string = (t) => t,
  options?: FitOptions,
): Promise<NonlinearFit> {
  const applied = applyFitOptions(spec, options ?? {});
  const eff = applied.spec;
  const extra = extraAssignments + applied.extraAssignments;
  const weighted = !!(options?.weights);
  try {
    const rCode = `${fitStatementsForSpec(xs, ys, eff, undefined, extra, weighted)}c(${fitEntries(eff)})`;
    const v = await evalNamedVector(rCode);
    const { coefficients, derived, stats } = parseFit(v, eff, xs.length, labelTerm);
    return { coefficients, derived, stats, rCode };
  } catch (err) {
    if (!eff.retryFit) throw err;
    const rCode = `${fitStatementsForSpec(xs, ys, eff, eff.retryFit, extra, weighted)}c(${fitEntries(eff)})`;
    const v = await evalNamedVector(rCode);
    const { coefficients, derived, stats } = parseFit(v, eff, xs.length, labelTerm);
    return { coefficients, derived, stats, rCode, retried: true };
  }
}

/** Fit the curve and return its coefficients, derived quantities and
 *  goodness-of-fit rows — one R call (two when a spec carries a retry fit
 *  and the first attempt fails). */
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
