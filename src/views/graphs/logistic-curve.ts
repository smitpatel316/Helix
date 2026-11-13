// "Logistic curve": the 0/1 data points of an XY table's first Y series plus
// the fitted sigmoid from the "Simple logistic regression" analysis (upstream 1.0.9) — the same
// cached run the analysis view reads (see graph-view), evaluated here in plain
// TS from its intercept and slope, so no second R call is needed.
//
// Binary-only by design (F-02): the 0–1 Y axis is forced only when the first
// Y series really is 0/1. On a non-binary Y the points are drawn on their own
// (autoranged) scale and the view adds a note saying so — never a silent
// empty 0–1 plot.
import type { GraphOptions } from "../../store/types";
import type { AnalysisOutcome, AnalysisResult, RegressionCoefficient } from "../../stats/types";
import { extent, type Paint } from "./plot-helpers";
import { pairUp, type Column } from "../../lib/dataset";
import type { GraphFigure, GraphModule } from ".";
import { xyScatter } from "./xy-scatter";

function coef(coefficients: RegressionCoefficient[], term: string): number {
  return coefficients.find((c) => c.term === term)?.estimate ?? NaN;
}

/** The intercept and slope, by position: upstream 1.0.9's logistic-regression
 *  names them "B0 (intercept)" / "B1 (slope)" (our F-02 build used "Intercept" /
 *  the X name — kept as fallback, for results stored before the rebase). */
function coefPair(coefficients: RegressionCoefficient[], xName: string): [number, number] {
  if (coefficients.length >= 2) {
    const [b0, b1] = [coefficients[0].estimate, coefficients[1].estimate];
    if (b0 != null && b1 != null) return [b0, b1];
  }
  return [coef(coefficients, "Intercept"), coef(coefficients, xName)];
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
  const [intercept, slope] = coefPair(coefficients, x.name);
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
  // series' fit. The 0–1 Y axis with 0/1 ticks applies only when the plotted
  // values really are 0/1; otherwise the scatter keeps its autoranged Y, so
  // a continuous outcome (a dose-response table, say) stays visible instead
  // of falling outside a fixed 0–1 range with no explanation (F-02).
  const fig = xyScatter.build(xCol && ySeries[0] ? [xCol, ySeries[0]] : columns, { ...options, xyStyle: "points" }, paint);
  const plottedY = xCol && ySeries[0] ? pairUp(xCol, ySeries[0]).y : [];
  const binary = plottedY.length > 0 && plottedY.every((v) => v === 0 || v === 1);
  if (!binary) return fig;
  const yaxis = { ...(fig.layout.yaxis as Record<string, unknown>), range: [-0.05, 1.05], autorange: false, tickmode: "array", tickvals: [0, 1] };
  return { data: fig.data, layout: { ...fig.layout, yaxis } };
}

/** The on-graph note for a logistic curve whose fit never arrived (F-02):
 *  null while the fit is still running or when it succeeded; the runner's
 *  error otherwise, so a non-binary Y says so instead of drawing silently
 *  empty. The non-binary case names the requirement outright. */
export function logisticCurveNote(outcome: AnalysisOutcome | null): string | null {
  if (!outcome || !("error" in outcome)) return null;
  if (outcome.error.includes("only 0s and 1s") || outcome.error.includes("enter 1 for an event, 0 for none"))
    return "Logistic curve needs a 0/1 outcome — the Y values are not all 0 or 1, so no fitted curve is drawn.";
  return `Logistic curve: ${outcome.error}`;
}

export const logisticCurveGraph: GraphModule = {
  label: "Logistic curve",
  family: "xy",
  points: () => true,
  lines: () => true,
  build,
};
