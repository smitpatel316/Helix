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
  RegressionCoefficient,
  StatRow,
} from "../types";
import { describe, pRow, rVec } from "../column/base";
import { num } from "../../lib/format";
import { splitXY, xyProblem } from "../../lib/dataset";
import { evalNamedVector, type RVector } from "../webr";
import { rowName } from "../grouped/base";
import {
  ENZYME_MODELS,
  EXPONENTIAL_MODELS,
  fitEntries,
  fitError,
  fitModelSpec,
  fitStatementsForSpec,
  fitSummaryStatements,
  MODEL_LABEL,
  modelSpec,
  parseFit,
  prepareFit,
  type DerivedRow,
  type ModelSpec,
} from "./nonlinear-fit";

// Re-exported for upstream importers (wizards.ts, fitted-curve.ts): the labels
// live in nonlinear-fit.ts now; positiveXOnly matches upstream's helper.
export { MODEL_LABEL };
export const positiveXOnly = (model: NonlinearModel) => modelSpec(model).positiveX === true;

/** A parameter as results name it (its name in the equations otherwise). */
const TERM_LABEL: Record<string, string> = { HillSlope: "Hill slope", S: "Asymmetry (S)" };
export const termLabel = (term: string) => TERM_LABEL[term] ?? term;
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
 *  like the rest of Helix's display). Only the exponential models carry one —
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
  const [gLo, gHi] = spec.positiveX ? [lo / 10, hi * 10] : [lo - w, hi + w];
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

export async function runNonlinearRegression(
  columns: Column[],
  params: NonlinearRegressionParams | undefined,
  titles: (string | null)[] = [],
): Promise<AnalysisOutcome> {
  const model = params?.model;
  if (!model || !Object.hasOwn(MODEL_LABEL, model)) return { error: "Choose a standard curve to fit." };

  const { x: xCol, ys: yCols } = splitXY(columns);
  const yCol = params?.y === undefined ? yCols[0] : yCols.find((c) => c.name === params.y);
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
  const other = params?.compareWith === undefined ? undefined : yCols.find((c) => c.name === params.compareWith);
  if (params?.compareWith !== undefined && !other) return { error: xyProblem(columns, params.compareWith)! };
  if (other && !spec.dose) return { error: "Only dose-response curves can be compared." };

  const first = prepareFit(columns, params?.y, model);
  if ("error" in first) return first;
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
    const rCode =
      `${fitStatementsForSpec(first.xs, first.ys, spec)}${R_INTERP}\n` +
      `ix<-interp(m,${rVec(unknownY)},${lo},${hi},${spec.positiveX ? "TRUE" : "FALSE"})\n` +
      `${interpolationCode(spec, unknownY, lo, hi)}c(${fitEntries(spec)},${interpNames})`;
    try {
      v = await evalNamedVector(rCode);
    } catch (err) {
      if (isTwoSiteCompetition(model)) return twoSiteError;
      return fitError(err, model);
    }
  } else {
    try {
      const fitted = await fitModelSpec(first.xs, first.ys, spec, "", termLabel);
      retried = fitted.retried;
      // One R call already ran; reuse its entries by re-reading them out of
      // the same shape — simplest is to keep the parsed fit and build the
      // result from it (no second R call).
      return assembleResult(model, spec, xCol, yCol, other, sets, [fitted], [], [], titles, first, fitted.retried, params);
    } catch (err) {
      if (isTwoSiteCompetition(model)) return twoSiteError;
      return fitError(err, model);
    }
  }

  // Comparison / interpolation paths: parse each set's prefixed entries.
  const prefix = other ? ["a_", "b_"] : [""];
  const parsed = sets.map((s, i) => parseFit(v, spec, s.xs.length, termLabel, prefix[i]));
  if (other) {
    // Comparison coefficients name their set ("Control — Bottom").
    parsed.forEach((p, i) => {
      p.coefficients.forEach((c) => {
        c.term = `${sets[i].name} — ${c.term}`;
      });
    });
  }
  const interpolated: InterpolatedRow[] = unknowns.map((r, i) => {
    const x = v[`ix_${i}`] ?? null;
    return {
      label: rowName(titles, r),
      y: yCol.byRow[r]!,
      x,
      ...(logX ? { concentration: v[`ic_${i}`] ?? null } : {}),
      extrapolated: x != null && (x < lo || x > hi),
      low: v[`il_${i}`] ?? null,
      high: v[`ih_${i}`] ?? null,
    };
  });
  return assembleResult(model, spec, xCol, yCol, other, sets, parsed, interpolated, v, titles, first, retried, params);
}

/** The result all three paths share: fit block + coefficients + notes, with
 *  the exponential/enzyme extras (equation, starting values, warnings) and
 *  the comparison F test / interpolation sentences when they apply.
 *  `parsed` is one parsed fit per set; `v` the raw vector (comparison F/p). */
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
  params: NonlinearRegressionParams | undefined,
): Promise<AnalysisOutcome> {
  const other = sets.length > 1;
  const coefficients = parsed.flatMap((p) => p.coefficients);
  const fit = { sets: sets.map((s) => s.name), rows: fitRows(parsed.map((p) => p.derived), parsed.map((p) => p.stats)) };
  const stats: StatRow[] = other
    ? [
        { label: "F", value: (v as RVector).F ?? null },
        { label: "DFn", value: (v as RVector).dfn ?? null },
        { label: "DFd", value: (v as RVector).dfd ?? null },
        pRow("P value", (v as RVector).p ?? null),
      ]
    : [];
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
          : "");
  const notes =
    `Least-squares fit ("${MODEL_LABEL[model]}") of ${sets.map((s) => `“${s.name}”`).join(" and ")} on “${xCol.name}”. ` +
    `95% CIs are asymptotic (from each parameter's standard error${spec.terms.includes("S") ? "; the asymmetry S's, on its log" : ""}).` +
    (other ? ` Extra sum-of-squares F test: ${question} ${answer}` : "") +
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
