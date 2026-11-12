// Binding — Saturation and Kinetics (plan 16): Prism's Binding panel.
// Saturation fits total / nonspecific binding against radioligand
// concentration (one-site total, two-site specific, and the two-series
// total+nonspecific fits, where NS and Background are SHARED between the
// series — the first shared-parameter fit in Helix). Kinetics fits
// association / dissociation against time (one/two-phase), plus
// association-then-dissociation (one experiment, HotNM/Time0 constrained).
// The two-series saturation fits run through the shared global-fit helper
// (see xy/global-fit.ts, plan 18) — one stacked nls() over both series —
// so there is exactly one stacked-nls implementation in the repo; the
// single-series fits use the shared fitModelSpec helper (see
// nonlinear-fit.ts). The kinetics exponentials ARE plan 08's forms with
// binding names on the parameters (association = one-phase association with
// Kobs, dissociation = one-phase decay with Koff), so there is exactly one
// implementation of each exponential form in the repo. Every fitted
// parameter reports estimate + SE + t + p + Wald 95% CI (the shared
// plan-09 plumbing — profile-likelihood confint() would be a cross-cutting
// change to every nonlinear fit, not a plan-16 one).
import type {
  AnalysisOutcome,
  BindingKineticsModel,
  BindingKineticsParams,
  BindingSaturationModel,
  BindingSaturationParams,
  Column,
  RegressionCoefficient,
  StatRow,
} from "../types";
import { BINDING_KINETICS_MODELS, BINDING_SATURATION_MODELS } from "../types";
import { describe } from "../column/base";
import { num } from "../../lib/format";
import { fitModelSpec, type ModelSpec } from "./nonlinear-fit";
import { runGlobalFit, type GlobalModelDef } from "./global-fit";
import { pairUp, splitXY, xyProblem } from "../../lib/dataset";

export const BINDING_SATURATION_LABEL: Record<BindingSaturationModel, string> = {
  "one-site-total": "One-site total binding",
  "two-site-specific": "Two-site specific binding",
  "one-site-total-and-ns": "One site — Total and nonspecific",
  "two-site-total-and-ns": "Two sites — Total and nonspecific",
};

export const BINDING_KINETICS_LABEL: Record<BindingKineticsModel, string> = {
  "association-one-phase": "Association — One phase",
  "dissociation-one-phase": "Dissociation — One phase",
  "association-two-phase": "Association — Two phases",
  "dissociation-two-phase": "Dissociation — Two phases",
  "association-then-dissociation": "Association then dissociation",
};

const isTwoSiteSaturation = (model: BindingSaturationModel) =>
  model === "two-site-specific" || model === "two-site-total-and-ns";
/** The two-series saturation models fit two Y series jointly, with NS and
 *  Background shared — `g` (1 = total, 0 = nonspecific) selects the branch. */
export const isTwoSeriesSaturation = (model: BindingSaturationModel) =>
  model === "one-site-total-and-ns" || model === "two-site-total-and-ns";
const isTwoPhaseKinetics = (model: BindingKineticsModel) =>
  model === "association-two-phase" || model === "dissociation-two-phase";

const coefOf = (coefficients: RegressionCoefficient[], term: string) =>
  coefficients.find((c) => c.term === term)?.estimate ?? null;

/** The nls non-convergence message, worded exactly like the shared
 *  fitError in nonlinear-fit.ts (which takes a NonlinearModel, so binding
 *  builds its own with the same shape). */
function bindingFitError(err: unknown, label: string): AnalysisOutcome {
  return {
    error: `This curve ("${label}") could not be fitted to these data (${err instanceof Error ? err.message : String(err)}). Try another model or Y data set.`,
  };
}

/** R's quantile type 7 (the default), in TS — for the two-site Kd starts. */
function quantile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p + 1;
  const lo = Math.floor(h);
  const frac = h - lo;
  return sorted[lo - 1] + frac * (sorted[Math.min(lo, n - 1)] - sorted[lo - 1]);
}

const HALF_LIFE = (k: string) => ({ label: "Half-life", expr: `ifelse(cf[["${k}"]]>0,log(2)/cf[["${k}"]],NA_real_)` });

/** The R spec for a single-series saturation model. Rate/Kd parameters
 *  are bounded below by 0 (nls algorithm "port" — the only algorithm base
 *  R offers bounds with); NS/Background stay unbounded. Start values are
 *  the Prism guide's rules of thumb, expressed in R so they follow the
 *  fitted points. The two-series models fit through the shared
 *  global-fit helper instead (twoSeriesSaturationDef below) — their
 *  starts are the same rules, computed in TS. */
function saturationSpec(model: BindingSaturationModel): ModelSpec {
  switch (model) {
    case "one-site-total":
      // Y = Bmax·X/(Kd + X) + NS·X + Background.
      return {
        kind: "nls",
        fit: 'm<-nls(y~Bmax*x/(Kd+x)+NS*x+Background,start=list(Bmax=max(y)*0.5,Kd=max(x)*0.2,NS=0.2*(max(y)-min(y))/(max(x)-min(x)),Background=min(y)),algorithm="port",lower=c(0,0,-Inf,-Inf),upper=c(Inf,Inf,Inf,Inf))',
        terms: ["Bmax", "Kd", "NS", "Background"],
      };
    case "two-site-specific":
      // Y = BmaxHi·X/(KdHi + X) + BmaxLo·X/(KdLo + X).
      return {
        kind: "nls",
        fit: 'm<-nls(y~BmaxHi*x/(KdHi+x)+BmaxLo*x/(KdLo+x),start=list(BmaxHi=max(y)*0.6,KdHi=quantile(x[x>0],0.25),BmaxLo=max(y)*0.4,KdLo=quantile(x[x>0],0.75)),algorithm="port",lower=c(0,0,0,0),upper=c(Inf,Inf,Inf,Inf))',
        terms: ["BmaxHi", "KdHi", "BmaxLo", "KdLo"],
      };
    default:
      throw new Error("Two-series saturation models fit through the global-fit helper, not a single-series spec.");
  }
}

/** The two-series saturation models as a global-fit definition: total and
 *  nonspecific binding fitted jointly, NS and Background shared — `g`
 *  (1 = total, 2 = nonspecific) selects the branch. Start values are the
 *  spec's R rules computed in TS from the fitted points: Bmax/Kd from the
 *  total series, NS/Background likewise, and the two-site Kd starts from
 *  the quantiles of the positive X values — over the STACKED x (each value
 *  twice), matching what the R `quantile(x[x>0], …)` saw. */
function twoSeriesSaturationDef(model: BindingSaturationModel, xs: number[], ys: number[]): GlobalModelDef {
  const maxX = Math.max(...xs);
  const minX = Math.min(...xs);
  const maxY = Math.max(...ys);
  const minY = Math.min(...ys);
  const ns0 = (0.2 * (maxY - minY)) / (maxX - minX);
  const evaluate: GlobalModelDef["evaluate"] = (coefficients, _s, i, x) =>
    evaluateBindingModel(model, coefficients, x, i === 0 ? "total" : "nonspecific");
  if (model === "one-site-total-and-ns") {
    // Total: specific + NS·X + Background; nonspecific: NS·X + Background.
    return {
      formula: "ifelse(g==1,Bmax*x/(Kd+x)+NS*x+Background,NS*x+Background)",
      params: [
        { name: "Bmax", shared: true, start: () => maxY * 0.5, lower: 0 },
        { name: "Kd", shared: true, start: () => maxX * 0.2, lower: 0 },
        { name: "NS", shared: true, start: () => ns0 },
        { name: "Background", shared: true, start: () => minY },
      ],
      evaluate,
    };
  }
  // two-site-total-and-ns.
  const positive = [...xs, ...xs].filter((x) => x > 0).sort((a, b) => a - b);
  return {
    formula: "ifelse(g==1,BmaxHi*x/(KdHi+x)+BmaxLo*x/(KdLo+x)+NS*x+Background,NS*x+Background)",
    params: [
      { name: "BmaxHi", shared: true, start: () => maxY * 0.6, lower: 0 },
      { name: "KdHi", shared: true, start: () => quantile(positive, 0.25), lower: 0 },
      { name: "BmaxLo", shared: true, start: () => maxY * 0.4, lower: 0 },
      { name: "KdLo", shared: true, start: () => quantile(positive, 0.75), lower: 0 },
      { name: "NS", shared: true, start: () => ns0 },
      { name: "Background", shared: true, start: () => minY },
    ],
    evaluate,
  };
}

/** The R spec for one kinetics model. Association is plan 08's one-phase
 *  association with K renamed Kobs; dissociation is its one-phase decay
 *  with K renamed Koff. `hot`/`t0` (association-then-dissociation only) are
 *  assigned by the runner before the fit. */
function kineticsSpec(model: BindingKineticsModel): ModelSpec {
  switch (model) {
    case "association-one-phase":
      // Y = Y0 + (Plateau − Y0)·(1 − exp(−Kobs·X)).
      return {
        kind: "nls",
        fit: 'm<-nls(y~Y0+(Plateau-Y0)*(1-exp(-Kobs*x)),start=list(Y0=y[which.min(x)],Plateau=max(y),Kobs=0.5/(max(x)-min(x))),algorithm="port",lower=c(-Inf,-Inf,0),upper=c(Inf,Inf,Inf))',
        terms: ["Y0", "Plateau", "Kobs"],
        derived: [HALF_LIFE("Kobs")],
      };
    case "dissociation-one-phase":
      // Y = (Y0 − Plateau)·exp(−Koff·X) + Plateau.
      return {
        kind: "nls",
        fit: 'm<-nls(y~(Y0-Plateau)*exp(-Koff*x)+Plateau,start=list(Y0=y[which.min(x)],Plateau=y[which.max(x)],Koff=0.5/(max(x)-min(x))),algorithm="port",lower=c(-Inf,-Inf,0),upper=c(Inf,Inf,Inf))',
        terms: ["Y0", "Plateau", "Koff"],
        derived: [
          HALF_LIFE("Koff"),
          { label: "Residence time", expr: 'ifelse(cf[["Koff"]]>0,1/cf[["Koff"]],NA_real_)' },
        ],
      };
    case "association-two-phase":
      // Y = Y0 + (Plateau − Y0)·(PercentFast·(1 − exp(−KFast·X)) + (1 − PercentFast)·(1 − exp(−KSlow·X))).
      return {
        kind: "nls",
        fit: 'm<-nls(y~Y0+(Plateau-Y0)*(PercentFast*(1-exp(-KFast*x))+(1-PercentFast)*(1-exp(-KSlow*x))),start=list(Y0=y[which.min(x)],Plateau=max(y),PercentFast=0.5,KFast=5/(max(x)-min(x)),KSlow=0.5/(max(x)-min(x))),algorithm="port",lower=c(-Inf,-Inf,0,0,0),upper=c(Inf,Inf,1,Inf,Inf))',
        terms: ["Y0", "Plateau", "PercentFast", "KFast", "KSlow"],
        derived: [
          { label: "Half-life (fast)", expr: 'ifelse(cf[["KFast"]]>0,log(2)/cf[["KFast"]],NA_real_)' },
          { label: "Half-life (slow)", expr: 'ifelse(cf[["KSlow"]]>0,log(2)/cf[["KSlow"]],NA_real_)' },
        ],
      };
    case "dissociation-two-phase":
      // Y = Plateau + (Y0 − Plateau)·(PercentFast·exp(−KFast·X) + (1 − PercentFast)·exp(−KSlow·X)).
      return {
        kind: "nls",
        fit: 'm<-nls(y~Plateau+(Y0-Plateau)*(PercentFast*exp(-KFast*x)+(1-PercentFast)*exp(-KSlow*x)),start=list(Y0=y[which.min(x)],Plateau=y[which.max(x)],PercentFast=0.5,KFast=5/(max(x)-min(x)),KSlow=0.5/(max(x)-min(x))),algorithm="port",lower=c(-Inf,-Inf,0,0,0),upper=c(Inf,Inf,1,Inf,Inf))',
        terms: ["Y0", "Plateau", "PercentFast", "KFast", "KSlow"],
        derived: [
          { label: "Half-life (fast)", expr: 'ifelse(cf[["KFast"]]>0,log(2)/cf[["KFast"]],NA_real_)' },
          { label: "Half-life (slow)", expr: 'ifelse(cf[["KSlow"]]>0,log(2)/cf[["KSlow"]],NA_real_)' },
        ],
      };
    case "association-then-dissociation": {
      // Prism's model, verbatim structure: Radioligand = HotNM·1e-9 (M);
      // Kob = [L]·Kon + Koff; Kd = Koff/Kon; Eq = Bmax·[L]/([L] + Kd);
      // Association = Eq·(1 − exp(−Kob·X)); YatTime0 = Eq·(1 − exp(−Kob·Time0));
      // Dissociation = YatTime0·exp(−Koff·(X − Time0));
      // Y = IF(X < Time0, Association, Dissociation) + NS.
      // The helper `f` keeps the nls formula readable; `hot`/`t0` are
      // assigned by the runner. Kinetic Kd is reported in nM. Kon starts
      // from the association phase's half-time (ln2 / median pre-Time0
      // time), so Kob starts near the observed rise rather than at 1e6 —
      // from a flat Kon start the port optimizer stalls at its iteration
      // limit on noiseless data. maxiter is raised for the same reason.
      // The median is floored at the smallest positive pre-Time0 time (or
      // Time0/2 when there is none — every pre-Time0 time is 0), and the
      // Kon start is clamped to [1e5, 1e10]: a zero median would otherwise
      // make log(2)/0 = Inf, and pmax(Inf, 1e5) = Inf hands nls a
      // non-finite start and the fit fails outright on fittable data (a
      // tiny-but-nonzero median likewise explodes the start, stalling the
      // optimizer). The cap is a start only — Kon itself stays unbounded.
      return {
        kind: "nls",
        fit: 'f<-function(xv,Kon,Koff,Bmax,NS){Kob<-hot*Kon+Koff;Kd<-Koff/Kon;Eq<-Bmax*hot/(hot+Kd);Yat0<-Eq*(1-exp(-Kob*t0));ifelse(xv<t0,Eq*(1-exp(-Kob*xv)),Yat0*exp(-Koff*(xv-t0)))+NS};med<-median(x[x<t0]);med<-max(med,min(c(x[x<t0&x>0],t0/2)));kon0<-pmin(pmax((log(2)/med-0.5/(max(x)-min(x)))/hot,1e5),1e10);m<-nls(y~f(x,Kon,Koff,Bmax,NS),start=list(Kon=kon0,Koff=0.5/(max(x)-min(x)),Bmax=max(y),NS=min(y)),algorithm="port",lower=c(0,0,0,-Inf),upper=c(Inf,Inf,Inf,Inf),control=nls.control(maxiter=200))',
        terms: ["Kon", "Koff", "Bmax", "NS"],
        derived: [
          { label: "Kinetic Kd (nM)", expr: 'cf[["Koff"]]/cf[["Kon"]]*1e9' },
          { label: "Eq", expr: 'cf[["Bmax"]]*hot/(hot+cf[["Koff"]]/cf[["Kon"]])' },
        ],
      };
    }
  }
}

/** The fitted curve's value at X, from the fit's coefficients — the same
 *  closed form R fitted, so the graph overlay and the analysis can never
 *  disagree. `series` selects the branch of a two-series saturation fit.
 *  Association-then-dissociation needs its constrained constants. */
export function evaluateBindingModel(
  model: BindingSaturationModel | BindingKineticsModel,
  coefficients: RegressionCoefficient[],
  x: number,
  series: "total" | "nonspecific" = "total",
  atd?: { hotNM: number; time0: number },
): number {
  const c = (term: string) => coefOf(coefficients, term) ?? NaN;
  switch (model) {
    case "one-site-total":
      return (c("Bmax") * x) / (c("Kd") + x) + c("NS") * x + c("Background");
    case "two-site-specific":
      return (c("BmaxHi") * x) / (c("KdHi") + x) + (c("BmaxLo") * x) / (c("KdLo") + x);
    case "one-site-total-and-ns":
      return series === "nonspecific"
        ? c("NS") * x + c("Background")
        : (c("Bmax") * x) / (c("Kd") + x) + c("NS") * x + c("Background");
    case "two-site-total-and-ns":
      return series === "nonspecific"
        ? c("NS") * x + c("Background")
        : (c("BmaxHi") * x) / (c("KdHi") + x) + (c("BmaxLo") * x) / (c("KdLo") + x) + c("NS") * x + c("Background");
    case "association-one-phase":
      return c("Y0") + (c("Plateau") - c("Y0")) * (1 - Math.exp(-c("Kobs") * x));
    case "dissociation-one-phase":
      return (c("Y0") - c("Plateau")) * Math.exp(-c("Koff") * x) + c("Plateau");
    case "association-two-phase":
      return (
        c("Y0") +
        (c("Plateau") - c("Y0")) *
          (c("PercentFast") * (1 - Math.exp(-c("KFast") * x)) +
            (1 - c("PercentFast")) * (1 - Math.exp(-c("KSlow") * x)))
      );
    case "dissociation-two-phase":
      return (
        c("Plateau") +
        (c("Y0") - c("Plateau")) *
          (c("PercentFast") * Math.exp(-c("KFast") * x) + (1 - c("PercentFast")) * Math.exp(-c("KSlow") * x))
      );
    case "association-then-dissociation": {
      if (!atd) return NaN;
      const hot = atd.hotNM * 1e-9;
      const kon = c("Kon");
      const koff = c("Koff");
      const kob = hot * kon + koff;
      const kd = koff / kon;
      const eq = (c("Bmax") * hot) / (hot + kd);
      const yat0 = eq * (1 - Math.exp(-kob * atd.time0));
      return (x < atd.time0 ? eq * (1 - Math.exp(-kob * x)) : yat0 * Math.exp(-koff * (x - atd.time0))) + c("NS");
    }
  }
}

/** R² of `ys` against their fitted values (null when Y is constant). */
function rSquared(ys: number[], fitted: number[]): number | null {
  const mean = ys.reduce((s, v) => s + v, 0) / ys.length;
  const sst = ys.reduce((s, v) => s + (v - mean) ** 2, 0);
  if (sst === 0) return null;
  const ssr = ys.reduce((s, v, i) => s + (v - fitted[i]) ** 2, 0);
  return 1 - ssr / sst;
}

/** The fitted equation, from the fitted coefficients (4 significant figures,
 *  like the rest of Helix's display). Two-series models show the total
 *  equation — the nonspecific branch is NS·X + Background, named in the notes. */
function equation(
  model: BindingSaturationModel | BindingKineticsModel,
  coefficients: RegressionCoefficient[],
  atd?: { hotNM: number; time0: number },
): string | undefined {
  const bmax = coefOf(coefficients, "Bmax");
  const kd = coefOf(coefficients, "Kd");
  const ns = coefOf(coefficients, "NS");
  const bg = coefOf(coefficients, "Background");
  const y0 = coefOf(coefficients, "Y0");
  const plateau = coefOf(coefficients, "Plateau");
  switch (model) {
    case "one-site-total":
    case "one-site-total-and-ns":
      if (bmax == null || kd == null || ns == null || bg == null) return undefined;
      return `Y = ${num(bmax)}·X/(${num(kd)} + X) + ${num(ns)}·X + ${num(bg)}`;
    case "two-site-specific":
    case "two-site-total-and-ns": {
      const bmaxHi = coefOf(coefficients, "BmaxHi");
      const kdHi = coefOf(coefficients, "KdHi");
      const bmaxLo = coefOf(coefficients, "BmaxLo");
      const kdLo = coefOf(coefficients, "KdLo");
      if (bmaxHi == null || kdHi == null || bmaxLo == null || kdLo == null) return undefined;
      const specific = `Y = ${num(bmaxHi)}·X/(${num(kdHi)} + X) + ${num(bmaxLo)}·X/(${num(kdLo)} + X)`;
      return model === "two-site-total-and-ns" && ns != null && bg != null
        ? `${specific} + ${num(ns)}·X + ${num(bg)}`
        : specific;
    }
    case "association-one-phase": {
      const kobs = coefOf(coefficients, "Kobs");
      if (y0 == null || plateau == null || kobs == null) return undefined;
      return `Y = ${num(y0)} + (${num(plateau)} − ${num(y0)})·(1 − exp(−${num(kobs)}·X))`;
    }
    case "dissociation-one-phase": {
      const koff = coefOf(coefficients, "Koff");
      if (y0 == null || plateau == null || koff == null) return undefined;
      return `Y = (${num(y0)} − ${num(plateau)})·exp(−${num(koff)}·X) + ${num(plateau)}`;
    }
    case "association-two-phase": {
      const pf = coefOf(coefficients, "PercentFast");
      const kf = coefOf(coefficients, "KFast");
      const ks = coefOf(coefficients, "KSlow");
      if (y0 == null || plateau == null || pf == null || kf == null || ks == null) return undefined;
      return `Y = ${num(y0)} + (${num(plateau)} − ${num(y0)})·(${num(pf)}·(1 − exp(−${num(kf)}·X)) + ${num(1 - pf)}·(1 − exp(−${num(ks)}·X)))`;
    }
    case "dissociation-two-phase": {
      const pf = coefOf(coefficients, "PercentFast");
      const kf = coefOf(coefficients, "KFast");
      const ks = coefOf(coefficients, "KSlow");
      if (y0 == null || plateau == null || pf == null || kf == null || ks == null) return undefined;
      return `Y = ${num(plateau)} + (${num(y0)} − ${num(plateau)})·(${num(pf)}·exp(−${num(kf)}·X) + ${num(1 - pf)}·exp(−${num(ks)}·X))`;
    }
    case "association-then-dissociation": {
      const kon = coefOf(coefficients, "Kon");
      const koff = coefOf(coefficients, "Koff");
      if (kon == null || koff == null || bmax == null || ns == null || !atd) return undefined;
      return `Y = Eq·(1 − exp(−Kob·X)) + ${num(ns)} for X < ${num(atd.time0)}; Y = YatTime0·exp(−${num(koff)}·(X − ${num(atd.time0)})) + ${num(ns)} after (Kon = ${num(kon)}, HotNM = ${num(atd.hotNM)} nM)`;
    }
  }
}

/** The data-driven starting values the R fit used, in the same terms as the
 *  spec's `start` list — recomputed here from the fitted points, so the note
 *  always names what nls() actually started from. */
function saturationStarts(model: BindingSaturationModel, xs: number[], ys: number[]): string {
  const maxX = Math.max(...xs);
  const minX = Math.min(...xs);
  const maxY = Math.max(...ys);
  const minY = Math.min(...ys);
  const twoSite = isTwoSiteSaturation(model);
  if (twoSite) {
    const positive = [...xs].filter((x) => x > 0).sort((a, b) => a - b);
    return (
      `Starting values: BmaxHi = ${num(maxY * 0.6)}, KdHi = ${num(quantile(positive, 0.25))}, ` +
      `BmaxLo = ${num(maxY * 0.4)}, KdLo = ${num(quantile(positive, 0.75))}.`
    );
  }
  return (
    `Starting values: Bmax = ${num(maxY * 0.5)}, Kd = ${num(maxX * 0.2)}, ` +
    `NS = ${num((0.2 * (maxY - minY)) / (maxX - minX))}, Background = ${num(minY)}.`
  );
}

function kineticsStarts(
  model: BindingKineticsModel,
  xs: number[],
  ys: number[],
  atd?: { hotNM: number; time0: number },
): string {
  const range = Math.max(...xs) - Math.min(...xs);
  const yAtMinX = ys[xs.indexOf(Math.min(...xs))];
  const yAtMaxX = ys[xs.indexOf(Math.max(...xs))];
  const maxY = Math.max(...ys);
  switch (model) {
    case "association-one-phase":
      return `Starting values: Y0 = ${num(yAtMinX)}, Plateau = ${num(maxY)}, Kobs = ${num(0.5 / range)}.`;
    case "dissociation-one-phase":
      return `Starting values: Y0 = ${num(yAtMinX)}, Plateau = ${num(yAtMaxX)}, Koff = ${num(0.5 / range)}.`;
    case "association-two-phase":
      return `Starting values: Y0 = ${num(yAtMinX)}, Plateau = ${num(maxY)}, PercentFast = 0.5, KFast = ${num(5 / range)}, KSlow = ${num(0.5 / range)}.`;
    case "dissociation-two-phase":
      return `Starting values: Y0 = ${num(yAtMinX)}, Plateau = ${num(yAtMaxX)}, PercentFast = 0.5, KFast = ${num(5 / range)}, KSlow = ${num(0.5 / range)}.`;
    case "association-then-dissociation": {
      // Kon starts from the association phase's half-time (see kineticsSpec):
      // the median pre-Time0 time floored at the smallest positive pre-Time0
      // time (or Time0/2 when there is none), with the start clamped to
      // [1e5, 1e10] — mirroring the R spec so the note always names what
      // nls() actually started from.
      const below = xs.filter((x) => x < atd!.time0).sort((a, b) => a - b);
      const median =
        below.length % 2 === 1
          ? below[(below.length - 1) / 2]
          : (below[below.length / 2 - 1] + below[below.length / 2]) / 2;
      const positive = below.filter((x) => x > 0);
      const medEff = Math.max(median, Math.min(...positive, atd!.time0 / 2));
      const kon0 = Math.min(Math.max((Math.LN2 / medEff - 0.5 / range) / (atd!.hotNM * 1e-9), 1e5), 1e10);
      return `Starting values: Kon = ${num(kon0)}, Koff = ${num(0.5 / range)}, Bmax = ${num(maxY)}, NS = ${num(Math.min(...ys))}.`;
    }
  }
}

export async function runBindingSaturation(
  columns: Column[],
  params: BindingSaturationParams | undefined,
): Promise<AnalysisOutcome> {
  const model = params?.model;
  if (!model || !BINDING_SATURATION_MODELS.includes(model)) return { error: "Choose a binding model to fit." };
  const label = BINDING_SATURATION_LABEL[model];
  const twoSeries = isTwoSeriesSaturation(model);
  const twoSite = isTwoSiteSaturation(model);
  // Single-series models fit through their spec; the two-series models
  // fit through the shared global-fit helper (see the fit call below).
  const spec = twoSeries ? null : saturationSpec(model);
  const nParams = model === "two-site-total-and-ns" ? 6 : 4;

  const { x: xCol, ys: yCols } = splitXY(columns);
  const yCol = params?.y === undefined ? yCols[0] : yCols.find((c) => c.name === params.y);
  if (!xCol || !yCol) return { error: xyProblem(columns, params?.y)! };
  let y2Col: Column | undefined;
  if (twoSeries) {
    y2Col = params?.y2 === undefined ? yCols[1] : yCols.find((c) => c.name === params.y2);
    if (!y2Col)
      return {
        error: "A two-series saturation model needs a second Y data set for the nonspecific binding.",
      };
    if (y2Col.name === yCol.name) return { error: "The total and nonspecific binding must be different Y data sets." };
  }

  // The complete-row set each series fits on; the two-series fit uses the
  // rows complete in both (a series short on points errors naming it).
  const p1 = pairUp(xCol, yCol);
  const p2 = y2Col ? pairUp(xCol, y2Col) : null;
  const minPts = twoSite ? 10 : 5;
  if (twoSeries && p2 && y2Col) {
    if (p1.x.length < minPts)
      return {
        error: `“${yCol.name}” (total binding) has only ${p1.x.length} complete points; a two-series ${twoSite ? "two-site" : "one-site"} saturation fit needs at least ${minPts}.`,
      };
    if (p2.x.length < minPts)
      return {
        error: `“${y2Col.name}” (nonspecific binding) has only ${p2.x.length} complete points; a two-series ${twoSite ? "two-site" : "one-site"} saturation fit needs at least ${minPts}.`,
      };
  }
  const rows = p2 ? p1.rows.filter((r) => p2.rows.includes(r)) : p1.rows;
  const xs = rows.map((r) => xCol.byRow[r]!);
  const ys = rows.map((r) => yCol.byRow[r]!);
  const ys2 = y2Col ? rows.map((r) => y2Col!.byRow[r]!) : null;
  const n = xs.length;

  if (xs.some((x) => x < 0)) return { error: "Concentrations can't be negative." };
  if (new Set(xs).size < 2) return { error: "Need at least two different concentrations to fit a saturation curve." };
  if (Math.max(...xs) <= 0) return { error: "No positive concentration — Kd cannot be estimated." };
  if (twoSite && n < 10) return { error: `Two-site binding needs at least 10 points (${n} complete points provided).` };
  if (twoSeries && n < minPts) return { error: `Only ${n} rows are complete in both series; need at least ${minPts}.` };
  if (n < nParams + 1)
    return {
      error: `Not enough complete points (${n}) to fit this curve; need at least ${nParams + 1}.`,
    };
  if (Math.max(...ys) <= 0) return { error: "No positive binding values — Bmax cannot be estimated." };

  try {
    // The two-series fit stacks total first, then nonspecific — the
    // stacking lives in the shared global-fit helper, not here.
    const { coefficients, derived, stats } = ys2
      ? await runGlobalFit(
          [
            { name: yCol.name, x: xs, y: ys, covariate: 0 },
            { name: y2Col!.name, x: xs, y: ys2, covariate: 0 },
          ],
          twoSeriesSaturationDef(model, xs, ys),
        )
      : await fitModelSpec(xs, ys, spec!);
    const bmax = coefOf(coefficients, "Bmax");
    const bmaxHi = coefOf(coefficients, "BmaxHi");
    const bmaxLo = coefOf(coefficients, "BmaxLo");
    if ((bmax != null && bmax <= 0) || (bmaxHi != null && bmaxHi <= 0) || (bmaxLo != null && bmaxLo <= 0))
      return { error: "Fitted Bmax ≤ 0 — the data do not support this binding model." };
    const kd = coefOf(coefficients, "Kd");
    if (kd != null && kd <= 0) return { error: "Fitted Kd ≤ 0 — the data do not constrain Kd." };

    const notes = [
      twoSeries
        ? `Binding saturation fit ("${label}") of "${yCol.name}" (total) and "${y2Col!.name}" (nonspecific) on "${xCol.name}", fitted jointly — NS and Background are shared between the two series.`
        : `Binding saturation fit ("${label}") of "${yCol.name}" on "${xCol.name}".`,
      saturationStarts(model, xs, ys),
    ];
    if (p2 && rows.length < Math.min(p1.x.length, p2.x.length))
      notes.push(
        `Dropped ${Math.min(p1.x.length, p2.x.length) - rows.length} row(s) where one series was blank; the fit uses the ${rows.length} rows complete in both series.`,
      );
    if (twoSite) {
      const kdHi = coefOf(coefficients, "KdHi");
      const kdLo = coefOf(coefficients, "KdLo");
      if (kdHi != null && kdLo != null && kdHi > 0 && kdLo > 0 && Math.max(kdHi, kdLo) / Math.min(kdHi, kdLo) < 3)
        notes.push(
          "KdHi and KdLo are within a factor of 3 — the two sites are not resolved; the fit is effectively one-site.",
        );
    }

    // Two-series goodness of fit: R² per series (from the closed form) plus
    // the pooled R² the shared fit returns.
    let outStats: StatRow[] = [...derived, ...stats];
    if (ys2) {
      const fitted1 = xs.map((x) => evaluateBindingModel(model, coefficients, x, "total"));
      const fitted2 = xs.map((x) => evaluateBindingModel(model, coefficients, x, "nonspecific"));
      const pooled = stats.find((s) => s.label === "R squared")?.value ?? null;
      const r2Total = rSquared(ys, fitted1);
      const r2Ns = rSquared(ys2, fitted2);
      outStats = [
        { label: "R squared (total)", value: r2Total },
        { label: "R squared (nonspecific)", value: r2Ns },
        { label: "R squared", value: pooled },
        ...stats.filter((s) => s.label !== "R squared" && s.label !== "N"),
        { label: "N (total)", value: n },
        { label: "N (nonspecific)", value: n },
      ];
    }
    const eq = equation(model, coefficients);
    return {
      testType: "binding-saturation",
      subtitle: label,
      ...(eq ? { equation: eq } : {}),
      stats: outStats,
      groups: (await describe([xCol, yCol, ...(y2Col ? [y2Col] : [])])).groups,
      notes: notes.join(" "),
      coefficients,
    };
  } catch (err) {
    return bindingFitError(err, label);
  }
}

export async function runBindingKinetics(
  columns: Column[],
  params: BindingKineticsParams | undefined,
): Promise<AnalysisOutcome> {
  const model = params?.model;
  if (!model || !BINDING_KINETICS_MODELS.includes(model)) return { error: "Choose a binding model to fit." };
  const label = BINDING_KINETICS_LABEL[model];
  const spec = kineticsSpec(model);
  const atd = model === "association-then-dissociation";

  const { x: xCol, ys: yCols } = splitXY(columns);
  const yCol = params?.y === undefined ? yCols[0] : yCols.find((c) => c.name === params.y);
  if (!xCol || !yCol) return { error: xyProblem(columns, params?.y)! };
  const { x: xs, y: ys } = pairUp(xCol, yCol);
  const n = xs.length;

  if (new Set(xs).size < 2) return { error: "Need at least two different times to fit a kinetics curve." };
  if (Math.max(...xs) - Math.min(...xs) <= 0)
    return { error: "All times are equal — the rate constant cannot be estimated." };
  if (n < spec.terms.length + 1)
    return {
      error: `Not enough complete points (${n}) to fit this curve; need at least ${spec.terms.length + 1}.`,
    };

  // Association-then-dissociation constants: HotNM > 0, Time0 strictly
  // inside the observed time range with data on both sides.
  let hotNM: number | undefined;
  let time0: number | undefined;
  if (atd) {
    hotNM = params?.hotNM;
    time0 = params?.time0;
    if (hotNM === undefined || !Number.isFinite(hotNM))
      return { error: "HotNM (radioligand concentration in nM) is required for association-then-dissociation." };
    if (hotNM <= 0) return { error: "HotNM must be greater than 0." };
    if (time0 === undefined || !Number.isFinite(time0))
      return { error: "Time0 (time at which dissociation starts) is required for association-then-dissociation." };
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const t0 = time0;
    if (t0 <= minX || t0 >= maxX || !xs.some((x) => x < t0) || !xs.some((x) => x > t0))
      return {
        error: "Time0 must lie strictly inside the observed time range, with data on both sides.",
      };
  }
  // Optional derived-kon constants (association-one-phase only).
  const ligand = model === "association-one-phase" ? params?.ligandConcentration : undefined;
  const koffIn = model === "association-one-phase" ? params?.koff : undefined;
  if (ligand !== undefined && (!Number.isFinite(ligand) || ligand <= 0))
    return { error: "Radioligand concentration must be greater than 0." };
  if (koffIn !== undefined && (!Number.isFinite(koffIn) || koffIn <= 0))
    return { error: "Koff must be greater than 0." };

  const extra = atd ? `hot<-${hotNM!}*1e-9;t0<-${time0!};` : "";
  try {
    const { coefficients, derived, stats } = await fitModelSpec(xs, ys, spec, extra);
    const plateau = coefOf(coefficients, "Plateau");
    if (plateau != null && plateau < 0)
      return { error: "Fitted Plateau < 0 — the data do not support this binding model." };
    const bmax = coefOf(coefficients, "Bmax");
    if (bmax != null && bmax <= 0) return { error: "Fitted Bmax ≤ 0 — the data do not support this binding model." };

    const notes = [
      `Binding kinetics fit ("${label}") of "${yCol.name}" on "${xCol.name}" (time).`,
      kineticsStarts(model, xs, ys, atd ? { hotNM: hotNM!, time0: time0! } : undefined),
    ];
    if (atd)
      notes.push(
        `HotNM = ${num(hotNM!)} nM and Time0 = ${num(time0!)} are constrained constants, not fitted parameters.`,
      );
    if (isTwoPhaseKinetics(model))
      notes.push("Two-phase fits need dense early time points — without them the fast phase is poorly identified.");
    const kobs = coefOf(coefficients, "Kobs");
    const koff = coefOf(coefficients, "Koff");
    if (model === "association-one-phase" && kobs != null && kobs <= 0)
      notes.push("Fitted Kobs ≤ 0 — half-life not defined.");
    if (model === "dissociation-one-phase" && koff != null && koff <= 0)
      notes.push("Fitted Koff ≤ 0 — half-life and residence time not defined.");
    if (isTwoPhaseKinetics(model)) {
      const kf = coefOf(coefficients, "KFast");
      const ks = coefOf(coefficients, "KSlow");
      if (kf != null && kf <= 0) notes.push("Fitted KFast ≤ 0 — half-life (fast) not defined.");
      if (ks != null && ks <= 0) notes.push("Fitted KSlow ≤ 0 — half-life (slow) not defined.");
      if (kf != null && ks != null && Math.abs(kf - ks) / Math.max(Math.abs(kf), Math.abs(ks), 1e-12) < 0.01)
        notes.push(
          "KFast ≈ KSlow — the two phases are nearly identical, so the separate phase parameters are poorly identified.",
        );
    }

    // Derived kon / kinetic Kd (association-one-phase only): kon =
    // (Kobs − Koff)/[L], kinetic Kd = Koff/kon. No Koff is invented — without
    // one from a dissociation experiment, Kobs is reported on its own.
    let konRows: StatRow[] = [];
    if (model === "association-one-phase" && kobs != null) {
      if (ligand !== undefined && koffIn !== undefined) {
        const kon = (kobs - koffIn) / ligand;
        if (kon > 0) {
          konRows = [
            { label: "kon", value: kon },
            { label: "Kinetic Kd", value: koffIn / kon },
          ];
          notes.push(
            `kon = (Kobs − Koff)/[L] = ${num(kon)} (per time per concentration unit); kinetic Kd = Koff/kon = ${num(koffIn / kon)} (same concentration units as [L]).`,
          );
        } else {
          notes.push(
            "Kobs ≤ Koff, so kon = (Kobs − Koff)/[L] ≤ 0 — kon and the kinetic Kd are not defined for these values.",
          );
        }
      } else if (ligand !== undefined) {
        notes.push(
          `Radioligand concentration ${num(ligand)} supplied, but no Koff — kon and the kinetic Kd need a dissociation experiment (supply Koff).`,
        );
      } else if (koffIn !== undefined) {
        notes.push(`Koff ${num(koffIn)} supplied, but no radioligand concentration — kon needs [L].`);
      }
    }

    const eq = equation(model, coefficients, atd ? { hotNM: hotNM!, time0: time0! } : undefined);
    return {
      testType: "binding-kinetics",
      subtitle: label,
      ...(eq ? { equation: eq } : {}),
      stats: [...derived, ...konRows, ...stats],
      groups: (await describe([xCol, yCol])).groups,
      notes: notes.join(" "),
      coefficients,
    };
  } catch (err) {
    return bindingFitError(err, label);
  }
}
