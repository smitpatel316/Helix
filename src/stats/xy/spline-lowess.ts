// Spline and Lowess smoothing for an XY table — Prism's "Spline and Lowess":
// a smooth curve through scattered XY data with no model assumed. Lowess fits
// each point from a weighted regression on its neighbours (span `f`); a
// smoothing spline is a cubic spline with a roughness penalty (`spar`, or
// `df`, or neither — then spar is chosen by generalized cross-validation).
// Both are descriptive: there are no parameters with meaning, no equation,
// no hypothesis test — the result is the curve itself, plus the smoothing
// actually used and the residuals, so over/under-smoothing is visible.
//
// The R code lives in exactly one place — `fitSmooth` here, which the graph
// module reuses through the sibling analysis's cached result (see
// views/graphs/smooth-curve.ts). One `evalNumericVector` call returns the
// fitted values at the data X's plus the dense grid, concatenated and split
// in TS on the known lengths; one `evalNamedVector` call returns the scalars.
import type { AnalysisOutcome, Column, FittedPoint, SplineLowessParams, StatRow } from "../types";
import { describe, rVec } from "../column/base";
import { pairUp, splitXY, xyProblem } from "../../lib/dataset";
import { num } from "../../lib/format";
import { evalNamedVector, evalNumericVector } from "../webr";

/** Points on the dense grid the graph draws the curve from. */
const GRID_POINTS = 100;

export interface SmoothFit {
  fitted: FittedPoint[];
  curve: { x: number; y: number }[];
  stats: StatRow[];
}

/** X and the chosen Y series (the first by default), on the rows where both
 *  have a value — sorted by X, since `pairUp` preserves row order and both
 *  smoothers (and the returned arrays) are in ascending X. */
function pickSortedPairs(columns: Column[], yName: string | undefined): { xCol: Column; yCol: Column; xs: number[]; ys: number[] } | null {
  const { x, ys } = splitXY(columns);
  const y = yName === undefined ? ys[0] : ys.find((c) => c.name === yName);
  if (!x || !y) return null;
  const pairs = pairUp(x, y);
  const order = pairs.x.map((_, i) => i).sort((a, b) => pairs.x[a] - pairs.x[b]);
  return { xCol: x, yCol: y, xs: order.map((i) => pairs.x[i]), ys: order.map((i) => pairs.y[i]) };
}

/** The R expression for the smoother's fit object, from the validated params. */
function fitExpression(method: "spline" | "lowess", f: number, spar: number | null, df: number | null): string {
  if (method === "lowess") return `lowess(x,y,f=${f})`;
  if (spar != null) return `smooth.spline(x,y,spar=${spar})`;
  if (df != null) return `smooth.spline(x,y,df=${df})`;
  return "smooth.spline(x,y)";
}

/**
 * Smooth `columns`' chosen Y series against X, returning the fitted values
 * at the data X's, the curve on a dense grid across exactly [min X, max X]
 * (never extrapolated), and the stats rows. An error string when the params
 * or the data cannot be smoothed.
 */
export async function fitSmooth(
  columns: Column[],
  params: SplineLowessParams | undefined,
): Promise<SmoothFit | { error: string }> {
  const problem = xyProblem(columns, params?.y);
  if (problem) return { error: problem };
  const method = params?.method ?? "lowess";
  if (method !== "lowess" && method !== "spline") return { error: "Choose a smoothing method: Lowess or Spline." };
  const f = params?.f ?? 2 / 3;
  if (method === "lowess" && (!Number.isFinite(f) || f <= 0 || f > 1))
    return { error: "The span must be between 0 and 1." };
  const spar = params?.spar ?? null;
  const df = params?.df ?? null;
  if (method === "spline") {
    if (spar != null && df != null) return { error: "Choose spar or df, not both." };
    if (spar != null && !Number.isFinite(spar))
      return { error: "The smoothing parameter (spar) must be a number, or left blank for automatic selection." };
    if (spar != null && (spar < 0 || spar > 1.5))
      return { error: "The smoothing parameter (spar) must be between 0 and 1.5." };
    if (df != null && !Number.isFinite(df))
      return { error: "The degrees of freedom (df) must be a number, or left blank for automatic selection." };
  }

  const picked = pickSortedPairs(columns, params?.y);
  if (!picked) return { error: "No Y column holds numbers yet." };
  const { xs, ys } = picked;
  const n = xs.length;
  if (n < 4) return { error: "Smoothing needs at least 4 complete pairs of X and Y values." };
  const minX = xs[0];
  const maxX = xs[n - 1];

  // Lowess has no `predict` method — the curve is the interpolation of its
  // fitted values on the grid, which is the standard way to draw it.
  const fitExpr = fitExpression(method, f, spar, df);
  const vectorCode =
    method === "lowess"
      ? `x<-${rVec(xs)};y<-${rVec(ys)};fit<-${fitExpr};` +
        `grid<-seq(${minX},${maxX},length.out=${GRID_POINTS});` +
        `c(fit$y,approx(fit$x,fit$y,xout=grid)$y)`
      : `x<-${rVec(xs)};y<-${rVec(ys)};fit<-${fitExpr};` +
        `grid<-seq(${minX},${maxX},length.out=${GRID_POINTS});` +
        `c(fit$y,predict(fit,x=grid)$y)`;
  const scalarCode =
    method === "lowess"
      ? `x<-${rVec(xs)};y<-${rVec(ys)};fit<-${fitExpr};` +
        `c(f=${f},rss=sum((y-fit$y)^2),n=length(x))`
      : `x<-${rVec(xs)};y<-${rVec(ys)};fit<-${fitExpr};` +
        `c(spar=fit$spar,df=fit$df,rss=sum((y-fit$y)^2),n=length(x))`;
  let values: number[];
  let scalars: Record<string, number | null>;
  try {
    values = await evalNumericVector(vectorCode);
    scalars = await evalNamedVector(scalarCode);
  } catch (err) {
    return { error: `Could not fit the smoother: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (values.length !== n + GRID_POINTS)
    return { error: `The smoother returned ${values.length} values, expected ${n + GRID_POINTS}.` };
  const fittedY = values.slice(0, n);
  const gridY = values.slice(n);
  // The grid R drew from, recomputed in TS — seq(min, max, length.out=100)
  // steps by (max − min)/99, so the two agree to float noise.
  const gridX = Array.from({ length: GRID_POINTS }, (_, i) => minX + ((maxX - minX) * i) / (GRID_POINTS - 1));
  const fitted: FittedPoint[] = xs.map((x, i) => ({ x, y: fittedY[i], observed: ys[i] }));
  const curve = gridX.map((x, i) => ({ x, y: gridY[i] }));
  const rss = scalars.rss;
  const stats: StatRow[] =
    method === "lowess"
      ? [
          { label: "Span (f)", value: f },
          { label: "Residual sum of squares", value: rss },
          { label: "Complete pairs", value: n },
        ]
      : [
          { label: "Smoothing parameter (spar)", value: scalars.spar },
          { label: "Effective degrees of freedom", value: scalars.df },
          { label: "Residual sum of squares", value: rss },
          { label: "Complete pairs", value: n },
        ];
  return { fitted, curve, stats };
}

export async function runSplineLowess(
  columns: Column[],
  params: SplineLowessParams | undefined,
): Promise<AnalysisOutcome> {
  const method = params?.method ?? "lowess";
  const fit = await fitSmooth(columns, params);
  if ("error" in fit) return fit;
  const { fitted, curve, stats } = fit;
  const { x, ys } = splitXY(columns);
  const yCol = params?.y === undefined ? ys[0] : ys.find((c) => c.name === params.y);
  if (!x || !yCol) return { error: "No Y column holds numbers yet." };
  const stat = (label: string) => stats.find((s) => s.label === label)?.value;
  const rss = stat("Residual sum of squares");
  const n = fitted.length;
  const notes: string[] = [];
  if (method === "lowess") {
    notes.push(
      `Lowess smoothing of “${yCol.name}” on “${x.name}” (span f = ${num(params?.f ?? 2 / 3)}). ` +
        `Residual sum of squares ${num(rss)}.`,
    );
    notes.push("Lowess has no closed-form effective degrees of freedom, so none is reported.");
  } else {
    const sparUsed = stat("Smoothing parameter (spar)");
    const dfUsed = stat("Effective degrees of freedom");
    const auto = (params?.spar ?? null) == null && (params?.df ?? null) == null;
    notes.push(
      `Smoothing spline of “${yCol.name}” on “${x.name}”` +
        (auto
          ? ` (spar = ${num(sparUsed)} chosen automatically by generalized cross-validation).`
          : (params?.df ?? null) != null
            ? ` (df = ${num(dfUsed)}, spar = ${num(sparUsed)}).`
            : ` (spar = ${num(sparUsed)}).`) +
        ` Residual sum of squares ${num(rss)}.`,
    );
    // GCV can choose (nearly) no smoothing at all — say so plainly, with the
    // remedy, rather than letting the curve silently follow every point.
    if (dfUsed != null && dfUsed > n - 1)
      notes.push(
        `With spar = ${num(sparUsed)} the spline follows the data almost exactly (effective df ${num(dfUsed)} of ${n} points) — set spar to 0.5–1.0 for a smoother curve.`,
      );
  }
  notes.push(
    "A smoother is descriptive — it shows the shape of the data, it does not test a hypothesis and has no parameters to interpret.",
  );
  return {
    testType: "spline-lowess",
    subtitle: method === "lowess" ? "Lowess" : "Smoothing spline",
    stats,
    groups: (await describe([x, yCol])).groups,
    notes: notes.join(" "),
    fitted,
    curve,
  };
}
