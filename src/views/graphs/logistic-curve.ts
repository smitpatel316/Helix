// "Logistic curve": the 0/1 data points of an XY table's first Y series plus
// the fitted sigmoid from the "Simple logistic regression" analysis — the same
// cached run the analysis view reads (see graph-view), evaluated here in plain
// TS from its intercept and slope, so no second R call is needed.
import type { GraphOptions } from "../../store/types";
import type { AnalysisResult, RegressionCoefficient } from "../../stats/types";
import { extent, type Paint } from "./plot-helpers";
import { pairUp, type Column } from "../../lib/dataset";
import type { GraphFigure, GraphModule } from ".";
import { xyScatter } from "./xy-scatter";

function coef(coefficients: RegressionCoefficient[], term: string): number {
  return coefficients.find((c) => c.term === term)?.estimate ?? NaN;
}

/** Evenly-spaced points across [xMin, xMax] tracing the fitted sigmoid. */
function logisticCurve(
  intercept: number,
  slope: number,
  xMin: number,
  xMax: number,
  steps = 100,
): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const x0 = xMin + ((xMax - xMin) * i) / steps;
    x.push(x0);
    y.push(1 / (1 + Math.exp(-(intercept + slope * x0))));
  }
  return { x, y };
}

/** Draws the fitted sigmoid of the first Y series (`columns` = X, then the Y
 *  series) under the points, from a "Simple logistic regression" result. */
export function addLogisticCurve(
  fig: GraphFigure,
  columns: Column[],
  fit: AnalysisResult,
  paint: Paint,
) {
  const [x, ...ys] = columns;
  const y = ys[0];
  const coefficients = fit.coefficients ?? [];
  if (!x || !y || !coefficients.length) return;
  const intercept = coef(coefficients, "Intercept");
  const slope = coef(coefficients, x.name);
  if (!Number.isFinite(intercept) || !Number.isFinite(slope)) return;
  const xs = pairUp(x, y).x;
  if (!xs.length) return;
  const curve = logisticCurve(intercept, slope, ...extent(xs));
  fig.data = [
    {
      type: "scatter",
      mode: "lines",
      x: curve.x,
      y: curve.y,
      line: { color: paint.color(y.name, 0), width: 1.5 },
      hoverinfo: "skip",
      showlegend: false,
    },
    ...fig.data,
  ];
}

function build(columns: Column[], options: GraphOptions, paint: Paint): GraphFigure {
  const [xCol, ...ySeries] = columns;
  // The scatter of the outcome (first Y series) only — the sigmoid is that
  // series' fit. Y is fixed 0–1 with 0/1 ticks.
  const fig = xyScatter.build(xCol && ySeries[0] ? [xCol, ySeries[0]] : columns, { ...options, xyStyle: "points" }, paint);
  const yaxis = { ...(fig.layout.yaxis as Record<string, unknown>), range: [-0.05, 1.05], autorange: false, tickmode: "array", tickvals: [0, 1] };
  return { data: fig.data, layout: { ...fig.layout, yaxis } };
}

export const logisticCurveGraph: GraphModule = {
  label: "Logistic curve",
  family: "xy",
  points: () => true,
  lines: () => true,
  build,
};
