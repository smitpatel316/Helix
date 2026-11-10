// Standard-curve interpolation for an XY table — Prism's "Interpolating from a
// standard curve": fit one of the standard curves to the standards, then read
// unknown concentrations off it from their Y (response) values. The fit is the
// shared nonlinear fit (nonlinear-fit.ts); the inverse prediction and its 95%
// CI happen in the SAME R call, so the curve is fitted once per run.
//
// Inverse prediction: uniroot() on the fitted curve over the observed X range.
// The 95% CI inverts the curve's 95% confidence band — predict(interval =
// "confidence") on a 200-point grid for lm models; for nls models the band
// comes from vcov(m) plus the numeric gradient of the curve (delta method),
// since predict.nls has no interval. An unknown whose Y the curve (or its
// band) never reaches on the observed range gets x: null, not an error.
import type {
  AnalysisOutcome,
  Column,
  InterpolationRow,
  NonlinearModel,
  StandardCurveInterpolationParams,
} from "../types";
import { describe } from "../column/base";
import { num } from "../../lib/format";
import { evalNamedVector } from "../webr";
import {
  fitEntries,
  fitError,
  fitStatements,
  MODEL_LABEL,
  modelSpec,
  parseFit,
  prepareFit,
  type ModelSpec,
} from "./nonlinear-fit";

/** R that, after `fitStatements`, evaluates the fitted curve and its 95%
 *  confidence band on a 200-point grid (`fg`, `lo`, `up`), defines the scalar
 *  curve/band functions (`f`, `fu`, `fl`), and inverts them for every unknown
 *  in `u` — `xi` the interpolated X, `li`/`hi` its 95% CI (NA when the curve
 *  or band never reaches the unknown on the observed X range). */
function interpolationCode(spec: ModelSpec, unknowns: number[]): string {
  const u = `u<-c(${unknowns.join(",")});`;
  const grid = `xg<-seq(min(x),max(x),length.out=200);`;
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
  // First root of h on the grid, scanning from min(x) upward and refined by
  // uniroot — so a non-monotonic curve reports its first crossing. NA when the
  // curve (or band edge) never reaches the value on the observed range.
  const root = `firstRoot<-function(vals,fn){for(i in 1:(length(xg)-1)){a<-vals[i];b<-vals[i+1];if(is.na(a)||is.na(b)) next;if(a==0) return(xg[i]);if(a*b<0) return(uniroot(fn,c(xg[i],xg[i+1]))$root)};NA_real_};`;
  // An unknown within the fit's residual scale of a 4PL asymptote inverts to
  // ±∞ — treat it as outside range instead of returning an extreme X.
  const guard = spec.asymptotes
    ? `if(abs(y0-cf[["${spec.asymptotes[1]}"]])<=syx||abs(y0-cf[["${spec.asymptotes[0]}"]])<=syx) next;`
    : "";
  const loop =
    `xi<-rep(NA_real_,length(u));li<-rep(NA_real_,length(u));hi<-rep(NA_real_,length(u));` +
    `inc<-fg[length(fg)]>fg[1];` +
    `for(k in seq_along(u)){y0<-u[k];${guard}` +
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

/** The full R code for a run: the shared fit, then the interpolation, returning
 *  one named vector with the fit entries plus `x/lo/hi` per unknown. */
export function standardCurveRCode(xs: number[], ys: number[], model: NonlinearModel, unknowns: number[]): string {
  const spec = modelSpec(model);
  const interpNames = unknowns
    .map((_, i) => `x${i + 1}=xi[${i + 1}],lo${i + 1}=li[${i + 1}],hi${i + 1}=hi[${i + 1}]`)
    .join(",");
  return `${fitStatements(xs, ys, model)}${interpolationCode(spec, unknowns)}c(${fitEntries(spec)},${interpNames})`;
}

export async function runStandardCurveInterpolation(
  columns: Column[],
  params: StandardCurveInterpolationParams | undefined,
): Promise<AnalysisOutcome> {
  const model = params?.model;
  if (!model || !Object.hasOwn(MODEL_LABEL, model)) return { error: "Choose a standard curve to fit." };

  // The runner is the authority on unknowns: each must be a finite number.
  // Non-finite entries are dropped (with a note); an empty list is an error.
  const raw = params?.unknowns ?? [];
  const unknowns = raw.filter((u) => Number.isFinite(u));
  if (!unknowns.length) return { error: "Enter at least one unknown Y value." };
  const dropped = raw.length - unknowns.length;

  const prepared = prepareFit(columns, params?.y, model);
  if ("error" in prepared) return prepared;
  const { xCol, yCol, xs, ys } = prepared;

  const spec = modelSpec(model);
  const rCode = standardCurveRCode(xs, ys, model, unknowns);

  try {
    const v = await evalNamedVector(rCode);
    const { coefficients, derived, stats } = parseFit(v, spec, xs.length);
    const interpolations: InterpolationRow[] = unknowns.map((y0, i) => ({
      unknownY: y0,
      x: v[`x${i + 1}`] ?? null,
      ciLow: v[`lo${i + 1}`] ?? null,
      ciHigh: v[`hi${i + 1}`] ?? null,
    }));

    const notes = [
      `Nonlinear least-squares fit ("${MODEL_LABEL[model]}") of "${yCol.name}" on "${xCol.name}".`,
      `95% CI from inverting the curve's 95% confidence band.`,
      model === "sigmoidal-4pl-logx"
        ? "Interpolated X values are log(concentrations)."
        : "Interpolated X values are in the table's X units.",
    ];
    const top = coefficients.find((c) => c.term === "Top")?.estimate;
    const bottom = coefficients.find((c) => c.term === "Bottom")?.estimate;
    for (const r of interpolations.filter((row) => row.x == null)) {
      if (top != null && bottom != null) {
        if (r.unknownY >= top)
          notes.push(
            `Y = ${r.unknownY} is above the fitted curve's maximum (Top ≈ ${num(top)}) and cannot be interpolated.`,
          );
        else if (r.unknownY <= bottom)
          notes.push(
            `Y = ${r.unknownY} is below the fitted curve's minimum (Bottom ≈ ${num(bottom)}) and cannot be interpolated.`,
          );
        else {
          const nearTop = Math.abs(r.unknownY - top) < Math.abs(r.unknownY - bottom);
          notes.push(
            `Y = ${r.unknownY} is within the fit's scatter of the curve's ${nearTop ? "maximum (Top" : "minimum (Bottom"} ≈ ${num(nearTop ? top : bottom)}) and cannot be interpolated reliably.`,
          );
        }
      } else {
        notes.push(`Y = ${r.unknownY} is outside the fitted curve's range and cannot be interpolated.`);
      }
    }
    if (model === "quadratic" || model === "cubic")
      notes.push(
        "A quadratic/cubic curve can cross a Y value more than once — the first crossing from the lowest X is reported.",
      );
    if (dropped > 0) notes.push(`${dropped} non-numeric unknown${dropped > 1 ? "s were" : " was"} dropped.`);

    return {
      testType: "standard-curve-interpolation",
      subtitle: MODEL_LABEL[model],
      stats: [...derived, ...stats],
      groups: (await describe([xCol, yCol])).groups,
      notes: notes.join(" "),
      coefficients,
      interpolations,
    };
  } catch (err) {
    return fitError(err);
  }
}
