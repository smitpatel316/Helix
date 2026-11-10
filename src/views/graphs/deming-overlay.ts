// Deming-regression overlay for the XY scatter graph: the Deming fit line (solid)
// plus the OLS line (dashed) for comparison, computed directly from the same x/y
// pairs the scatter plots — no WebR round-trip needed. The closed form has one
// unique solution, so the Deming slope/intercept here always match the sibling
// "Deming regression" analysis's R-computed fit (checked by `npm test`).
import type { GraphOptions } from "../../store/types";
import type { DemingRegressionParams } from "../../stats/types";
import { pairUp, type Column } from "../../lib/dataset";
import type { GraphFigure } from ".";
import { num } from "../../lib/format";
import { addNote, extent, type Paint } from "./plot-helpers";
import { mean } from "../../lib/summary";
import { fitLinear, type LinearFit } from "./regression-overlay";

export interface DemingFit {
  slope: number;
  intercept: number;
  lambda: number;
}

/** Closed-form Deming fit of y on x with error-variance ratio λ = σ²ε/σ²δ
 *  (variance of the Y errors over variance of the X errors — the
 *  deming::deming / MethComp::Deming convention; λ = 1 is the equal-error /
 *  orthogonal case). Returns null with fewer than 2 points, λ ≤ 0, a
 *  degenerate (all-identical) X or Y, or no covariation — the same cases
 *  the analysis reports as errors. */
export function fitDeming(x: number[], y: number[], lambda: number): DemingFit | null {
  const n = x.length;
  if (n < 2 || !(lambda > 0)) return null;
  const xbar = mean(x);
  const ybar = mean(y);
  const sxx = x.reduce((s, xi) => s + (xi - xbar) ** 2, 0);
  const syy = y.reduce((s, yi) => s + (yi - ybar) ** 2, 0);
  const sxy = x.reduce((s, xi, i) => s + (xi - xbar) * (y[i] - ybar), 0);
  if (sxx === 0 || syy === 0 || sxy === 0) return null;
  const d = syy - lambda * sxx;
  const slope = (d + Math.sqrt(d * d + 4 * lambda * sxy * sxy)) / (2 * sxy);
  return { slope, intercept: ybar - slope * xbar, lambda };
}

/** "Y = 0.9764*X + 0.25" — the same shape as the Analysis panel's equation. */
function equationText(slope: number, intercept: number): string {
  const term = `${num(slope)}*X`;
  if (intercept === 0) return `Y = ${term}`;
  return `Y = ${term} ${intercept < 0 ? "−" : "+"} ${num(Math.abs(intercept))}`;
}

/** "Deming: Y = …<br>OLS: Y = …" annotation text — Plotly-ready (line break as
 *  `<br>`), naming each line, since the two nearly coincide. Always uses literal
 *  "Y"/"X" rather than the actual column names, for simplicity. */
function demingLabel(fit: DemingFit, ols: LinearFit | null): string {
  const deming = `Deming: ${equationText(fit.slope, fit.intercept)}`;
  if (!ols) return deming;
  return `${deming}<br>OLS: ${equationText(ols.slope, ols.intercept)}`;
}

/** Draws a Deming-regression analysis's fit on an XY scatter (`columns` = X, then
 *  the Y series): its line (solid) and the OLS line (dashed) as chosen, under the
 *  points. The OLS line comes from the same `fitLinear` helper as the regression
 *  overlay, so the two lines always agree with their analyses. */
export function addDeming(
  fig: GraphFigure,
  columns: Column[],
  options: GraphOptions,
  params: DemingRegressionParams | undefined,
  paint: Paint,
) {
  const [x, ...ys] = columns;
  const y = ys.find((c) => c.name === params?.y) ?? ys[0];
  if (!x || !y) return;
  const pairs = pairUp(x, y);
  const fit = fitDeming(pairs.x, pairs.y, params?.lambda ?? 1);
  if (!fit) return;
  const ols = fitLinear(pairs.x, pairs.y, false);
  const i = ys.indexOf(y);
  const [xMin, xMax] = extent(pairs.x);
  const line = (yv: number[], style: object) => ({
    type: "scatter",
    mode: "lines",
    x: [xMin, xMax],
    y: yv,
    line: style,
    hoverinfo: "skip",
    showlegend: false,
  });
  const traces: unknown[] = [];
  if (options.demingShowOls && ols) {
    traces.push(
      line([ols.intercept + ols.slope * xMin, ols.intercept + ols.slope * xMax], {
        color: paint.color(y.name, i),
        width: 1.5,
        dash: "dash",
      }),
    );
  }
  if (options.demingShowLine) {
    traces.push(
      line([fit.intercept + fit.slope * xMin, fit.intercept + fit.slope * xMax], {
        color: paint.color(y.name, i),
        width: 1.5,
      }),
    );
  }
  fig.data = [...traces, ...fig.data];
  if (options.demingShowEquation) addNote(fig, demingLabel(fit, ols), options);
}
