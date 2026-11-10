// "Observed vs fitted": the observed counts of a Multiple Variables table
// against the fitted counts of a sibling "Poisson regression" analysis —
// the same cached run the analysis view reads (see graph-view), evaluated
// here in plain TS from its coefficients (fitted = exp(b0 + b1·X1 + …)), so
// no second R call is needed. A dashed y = x identity line shows where the
// model fits: points far from it are the rows the model fits badly. Without
// a linked analysis the graph draws only its axes, and the Format panel says
// to run the analysis first — exactly like the forest plot (see forest-plot.ts).
import type { GraphOptions } from "../../store/types";
import type { AnalysisResult, PoissonRegressionParams } from "../../stats/types";
import { pairedGroups } from "../../stats/column/base";
import type { Column } from "../../lib/dataset";
import { extent, GUIDE, seriesMarker, xyLayout, type Paint } from "./plot-helpers";
import type { GraphFigure, GraphModule } from ".";

/** The one series this graph draws, as the Series section names it. */
export const OBSERVED_FITTED_SERIES = "Observed vs fitted";

/** One complete row: its observed count and the model's fitted count. */
export interface FittedPoint {
  observed: number;
  fitted: number;
}

/** The observed and fitted counts of a Poisson result's complete rows, from
 *  its coefficients — closed-form in TS (fitted = exp(linear predictor)), so
 *  the graph needs no second R round-trip. The predictor names come from the
 *  coefficients' terms (so a run whose wizard left `predictors` out still
 *  resolves); the dependent comes from the analysis's params. Null when the
 *  result has no usable coefficients, or the params don't name its columns. */
export function fittedCounts(
  columns: Column[],
  outcome: AnalysisResult,
  params: PoissonRegressionParams | undefined,
): FittedPoint[] | null {
  const coefficients = outcome.coefficients ?? [];
  const byTerm = new Map(coefficients.map((c) => [c.term, c.estimate]));
  const b0 = byTerm.get("Intercept");
  if (b0 == null || !Number.isFinite(b0)) return null;
  const depName = params?.dependent;
  const predNames = coefficients.filter((c) => c.term !== "Intercept").map((c) => c.term);
  if (!depName || !predNames.length) return null;
  const dep = columns.find((c) => c.name === depName);
  const preds = predNames.map((name) => columns.find((c) => c.name === name));
  if (!dep || preds.some((c) => !c)) return null;
  const bs = preds.map((c) => byTerm.get(c!.name));
  if (bs.some((b) => b == null || !Number.isFinite(b))) return null;
  // Complete rows, aligned across the outcome and the predictors.
  const aligned = pairedGroups([dep, ...(preds as Column[])]).map((g) => g.values);
  return aligned[0].map((observed, i) => ({
    observed,
    fitted: Math.exp(b0 + (bs as number[]).reduce((s, b, j) => s + b * aligned[j + 1][i], 0)),
  }));
}

/** Draws the observed-vs-fitted points of a Poisson result, with the dashed
 *  y = x identity line through the data range (floored at 0 — counts can't be
 *  negative). No-op when the result has no fitted counts to draw. */
export function addObservedFitted(
  fig: GraphFigure,
  columns: Column[],
  outcome: AnalysisResult,
  params: PoissonRegressionParams | undefined,
  paint: Paint,
) {
  const points = fittedCounts(columns, outcome, params);
  if (!points?.length) return;
  const observed = points.map((p) => p.observed);
  const fitted = points.map((p) => p.fitted);
  const [lo, hi] = extent([...observed, ...fitted]);
  const pad = (hi - lo) * 0.05 || 1;
  const line: [number, number] = [Math.max(0, lo - pad), hi + pad];
  fig.data = [
    {
      type: "scatter",
      mode: "lines",
      name: "y = x",
      x: line,
      y: line,
      line: { color: GUIDE, width: 1.5, dash: "dash" },
      hoverinfo: "skip",
      showlegend: false,
    },
    {
      type: "scatter",
      mode: "markers",
      name: OBSERVED_FITTED_SERIES,
      x: observed,
      y: fitted,
      marker: seriesMarker(paint, OBSERVED_FITTED_SERIES, 0),
      hoverinfo: "x+y",
      showlegend: false,
    },
  ];
}

function build(_columns: Column[], options: GraphOptions, _paint: Paint): GraphFigure {
  return { data: [], layout: xyLayout(options, "Observed count", 1, { yName: "Fitted count" }) };
}

export const observedFitted: GraphModule = {
  label: "Observed vs fitted",
  family: "multiple",
  points: () => true,
  build,
};
