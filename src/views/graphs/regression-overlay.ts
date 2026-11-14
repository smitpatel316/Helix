// Linear-regression overlay for the XY scatter graph: a fit line + 95%
// confidence band, computed directly from the same x/y pairs the scatter plots —
// no WebR round-trip needed. The closed form here always matches the sibling
// "Linear regression" analysis's R-computed fit — unweighted OLS, or weighted
// least squares when the linked analysis carries a weighting scheme
// (checked by `npm test`).
import type { GraphOptions } from "../../store/types";
import type { LinearRegressionParams, NonlinearWeightScheme } from "../../stats/types";
import { splitXY, xyPoints, type Column } from "../../lib/dataset";
import type { GraphFigure } from ".";
import { num, pText } from "../../lib/format";
import { tCrit95, tTwoSidedP } from "../../lib/student-t";
import { withOpacity } from "../../lib/palettes";
import { addNote, curveXs, type Paint } from "./plot-helpers";

export interface LinearFit {
  slope: number;
  intercept: number; // 0 when forced through the origin
  forceOrigin: boolean;
  n: number;
  dof: number;
  r: number; // Pearson's
  r2: number;
  p: number;
  xbar: number; // weighted mean of x (plain mean when unweighted)
  sxx: number; // Σw(x-x̄)² (or Σwx² when forced through the origin)
  s: number; // residual standard error
  wSum: number; // Σw (n when unweighted)
  weighted: boolean; // a weighting scheme applied (no Pearson r is reported for a weighted fit)
}

/** The weight for one point under a weighting scheme, or null when the scheme
 *  cannot apply to this point — the same positivity guards as the analysis's
 *  `check` in stats/xy/linear-regression.ts ("1/sd2" is not a linear-regression
 *  scheme at all). A null anywhere makes the whole fit null: no overlay
 *  rather than a wrong one. */
function weightAt(scheme: Exclude<NonlinearWeightScheme, "1/sd2">, xi: number, yi: number): number | null {
  switch (scheme) {
    case "none":
      return 1;
    case "1/y":
      return yi > 0 ? 1 / yi : null;
    case "1/y2":
      return yi !== 0 ? 1 / (yi * yi) : null;
    case "1/x":
      return xi > 0 ? 1 / xi : null;
    case "1/x2":
      return xi !== 0 ? 1 / (xi * xi) : null;
    default:
      return null;
  }
}

/** (Weighted) least-squares fit of y on x (optionally forced through the
 *  origin), plus the slope's P value. Returns null with fewer than 3 points,
 *  a degenerate (all-identical) X, or weights that cannot apply to the data —
 *  too little residual freedom, or no valid weighting, for a meaningful band.
 *  With weights "none" this is plain OLS; otherwise it is the WLS fit R's
 *  `lm(y ~ x, weights = w)` computes: weighted means, Σw(x−x̄)², and a
 *  weighted R² (summary(lm)$r.squared is the weighted one). */
export function fitLinear(
  x: number[],
  y: number[],
  forceOrigin: boolean,
  weights: Exclude<NonlinearWeightScheme, "1/sd2"> = "none",
): LinearFit | null {
  const n = x.length;
  if (n < 3) return null;
  const w: number[] = [];
  for (let i = 0; i < n; i++) {
    const wi = weightAt(weights, x[i], y[i]);
    if (wi == null) return null;
    w.push(wi);
  }
  const wSum = w.reduce((s, wi) => s + wi, 0);
  const xbar = w.reduce((s, wi, i) => s + wi * x[i], 0) / wSum;
  const ybar = w.reduce((s, wi, i) => s + wi * y[i], 0) / wSum;
  const sxx = forceOrigin
    ? w.reduce((s, wi, i) => s + wi * x[i] * x[i], 0)
    : w.reduce((s, wi, i) => s + wi * (x[i] - xbar) ** 2, 0);
  if (sxx === 0) return null;
  const slope = forceOrigin
    ? w.reduce((s, wi, i) => s + wi * x[i] * y[i], 0) / sxx
    : w.reduce((s, wi, i) => s + wi * (x[i] - xbar) * (y[i] - ybar), 0) / sxx;
  const intercept = forceOrigin ? 0 : ybar - slope * xbar;
  const ssRes = w.reduce((s, wi, i) => s + wi * (y[i] - (intercept + slope * x[i])) ** 2, 0);
  const ssTot = forceOrigin
    ? w.reduce((s, wi, i) => s + wi * y[i] * y[i], 0)
    : w.reduce((s, wi, i) => s + wi * (y[i] - ybar) ** 2, 0);
  const dof = n - (forceOrigin ? 1 : 2);
  const s = Math.sqrt(ssRes / dof);
  const t = slope / (s / Math.sqrt(sxx));
  const centered = (v: number[], m: number) => v.map((vi) => vi - m);
  const [dx, dy] = [centered(x, xbar), centered(y, ybar)];
  const dot = (a: number[], b: number[]) => a.reduce((sum, ai, i) => sum + ai * b[i], 0);
  const r = dot(dx, dy) / Math.sqrt(dot(dx, dx) * dot(dy, dy));
  return { slope, intercept, forceOrigin, n, dof, r, r2: 1 - ssRes / ssTot, p: tTwoSidedP(t, dof), xbar, sxx, s, wSum, weighted: weights !== "none" };
}

/** Points across the data's X range (see `curveXs`) with the fit line + 95% confidence
 *  band (of the mean response, matching R's `predict(interval="confidence")`) at each —
 *  ready to hand to Plotly as line/fill traces. */
function regressionCurve(
  fit: LinearFit,
  xs: number[],
  scale: GraphOptions["xScale"],
): { x: number[]; yFit: number[]; yLo: number[]; yHi: number[] } {
  const tCrit = tCrit95(fit.dof);
  const x: number[] = [];
  const yFit: number[] = [];
  const yLo: number[] = [];
  const yHi: number[] = [];
  for (const x0 of curveXs(xs, scale, 60)) {
    const yHat = fit.intercept + fit.slope * x0;
    const variance = fit.forceOrigin
      ? (fit.s * x0) ** 2 / fit.sxx
      : fit.s ** 2 * (1 / fit.wSum + (x0 - fit.xbar) ** 2 / fit.sxx);
    const half = tCrit * Math.sqrt(variance);
    x.push(x0);
    yFit.push(yHat);
    yLo.push(yHat - half);
    yHi.push(yHat + half);
  }
  return { x, yFit, yLo, yHi };
}

/** "Y = 2.927*X − 0.3322<br>r = 0.9346, R² = 0.8734, P = 0.0021" (no r through the origin, and
 *  none for a weighted fit — R's lm reports no Pearson r for one, and the unweighted r
 *  would describe the wrong fit) annotation text — Plotly-ready
 *  (line break as `<br>`), formatted the same way as the Analysis panel's equation.
 *  Always uses literal "Y"/"X" rather than the actual column names, for simplicity. */
function regressionLabel(fit: LinearFit): string {
  const term = `${num(fit.slope)}*X`;
  const eq = fit.forceOrigin
    ? `Y = ${term}`
    : `Y = ${term} ${fit.intercept < 0 ? "−" : "+"} ${num(Math.abs(fit.intercept))}`;
  return `${eq}<br>${fit.forceOrigin || fit.weighted ? "" : `r = ${num(fit.r)}, `}R² = ${num(fit.r2)}, ${pText(fit.p)}`;
}

/** Draws a linear-regression analysis's fit on an XY scatter (`columns` = X, then
 *  the Y series): each data set's line, 95% CI band and equation as chosen, under the
 *  points (several equations one per line, after each one's name). A regression of two
 *  named variables is drawn only on the scatter of those two. */
export function addRegression(
  fig: GraphFigure,
  columns: Column[],
  options: GraphOptions,
  params: LinearRegressionParams | undefined,
  paint: Paint,
) {
  const { x, ys } = splitXY(columns);
  if (!x || (params?.x !== undefined && params.x !== x.name)) return;
  const names = params?.ys ?? [params?.y ?? (params?.x === undefined ? ys[0]?.name : undefined)];
  const many = names.length > 1;
  const traces: unknown[] = [];
  const notes: string[] = [];
  for (const name of names) {
    const y = ys.find((s) => s.name === name);
    if (!y) continue;
    const pairs = xyPoints(x, y);
    const fit = fitLinear(pairs.x, pairs.y, params?.forceOrigin ?? false, params?.weights ?? "none");
    if (!fit) continue;
    const color = paint.color(y.name, ys.indexOf(y));
    const curve = regressionCurve(fit, pairs.x, options.xScale);
    const line = (yv: number[], style: object) => ({
      type: "scatter",
      mode: "lines",
      x: curve.x,
      y: yv,
      line: style,
      hoverinfo: "skip",
      showlegend: false,
    });
    if (options.regShowBand) {
      traces.push(line(curve.yLo, { width: 0 }), {
        ...line(curve.yHi, { width: 0 }),
        fill: "tonexty",
        fillcolor: withOpacity(color, 0.5), // a band: always see-through
      });
    }
    if (options.regShowLine) traces.push(line(curve.yFit, { color, width: 1.5, dash: "dash" }));
    const label = regressionLabel(fit);
    notes.push(many ? `${y.name}: ${label.replace("<br>", ", ")}` : label);
  }
  fig.data = [...traces, ...fig.data];
  if (options.regShowEquation && notes.length) addNote(fig, notes.join("<br>"), options);
}
