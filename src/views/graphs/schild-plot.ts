// Schild plot: log(DR − 1) against log[B] for a Gaddum/Schild fit — the
// diagnostic that slope ≈ 1 means the antagonism is simply competitive.
// The points are computed here from the cached analysis result (no new R
// call): one point per antagonist series (B > 0), DR = EC50(B)/EC50(control)
// = the fitted Antag factor 1 + (B/Kb)^SchildSlope, with Kb = 10^(−pA2).
// The line is the existing linear-regression overlay (fitLinear in
// regression-overlay.ts); with exactly two points the line through them
// is exact (fitLinear needs ≥ 3).
import type { GraphOptions } from "../../store/types";
import type { AnalysisResult, DoseResponseSpecialParams } from "../../stats/types";
import type { GraphFigure, GraphModule } from ".";
import { fitLinear } from "./regression-overlay";
import { parseInhibitorConcentration } from "../../stats/xy/enzyme-inhibition";
import { addNote, xyLayout, type Paint } from "./plot-helpers";
import { num } from "../../lib/format";

export interface SchildPlotPoint {
  logB: number;
  logDRminus1: number;
  series: string;
}

export interface SchildPlot {
  points: SchildPlotPoint[];
  slope: number | null;
  intercept: number | null;
}

/** The Schild-plot points + fitted slope/intercept from a fitted Schild
 *  analysis. Empty (null slope) when the fit has no pA2 or no series
 *  with B > 0. */
export function schildPlotPoints(fit: AnalysisResult, params: DoseResponseSpecialParams): SchildPlot {
  const coefficients = fit.coefficients ?? [];
  const coef = (term: string) => coefficients.find((c) => c.term === term)?.estimate ?? null;
  const pA2 = coef("pA2");
  const empty: SchildPlot = { points: [], slope: null, intercept: null };
  if (pA2 == null) return empty;
  const kb = 10 ** -pA2;
  const schildSlope = coef("SchildSlope") ?? 1;
  const points: SchildPlotPoint[] = [];
  // groups[0] is X; the rest are the fitted series, in fit order — the
  // first is the control (B = 0), the rest carry the antagonist.
  for (const group of fit.groups.slice(1)) {
    const B = params.antagonistConcentrations?.[group.name] ?? parseInhibitorConcentration(group.name);
    if (B === undefined || B <= 0 || kb <= 0) continue;
    const dr = 1 + (B / kb) ** schildSlope;
    if (dr <= 1) continue;
    points.push({ logB: Math.log10(B), logDRminus1: Math.log10(dr - 1), series: group.name });
  }
  if (points.length >= 3) {
    const f = fitLinear(
      points.map((p) => p.logB),
      points.map((p) => p.logDRminus1),
      false,
    );
    if (f) return { points, slope: f.slope, intercept: f.intercept };
    return { points, slope: null, intercept: null };
  }
  if (points.length === 2) {
    const [a, b] = points;
    const slope = (b.logDRminus1 - a.logDRminus1) / (b.logB - a.logB);
    return { points, slope, intercept: a.logDRminus1 - slope * a.logB };
  }
  return { points, slope: null, intercept: null };
}

/** Draws the Schild plot on its graph: the computed points as markers,
 *  the fitted line across them (when ≥ 2 points), and the slope +
 *  intercept annotated. Without a Schild analysis the graph is empty
 *  axes — the graph view notes that instead. */
export function addSchildPlot(
  fig: GraphFigure,
  fit: AnalysisResult,
  params: DoseResponseSpecialParams,
  paint: Paint,
  options: GraphOptions,
) {
  const { points, slope, intercept } = schildPlotPoints(fit, params);
  if (!points.length) return;
  const color = paint.color(points[0].series, 0);
  const traces: GraphFigure["data"] = [
    {
      type: "scatter",
      mode: "markers",
      x: points.map((p) => p.logB),
      y: points.map((p) => p.logDRminus1),
      marker: { color, size: 7 },
      hoverinfo: "x+y",
      showlegend: false,
    },
  ];
  if (slope != null && intercept != null) {
    const xs = points.map((p) => p.logB);
    const [xMin, xMax] = [Math.min(...xs), Math.max(...xs)];
    const pad = (xMax - xMin) * 0.1 || 0.5;
    traces.push({
      type: "scatter",
      mode: "lines",
      x: [xMin - pad, xMax + pad],
      y: [intercept + slope * (xMin - pad), intercept + slope * (xMax + pad)],
      line: { color, width: 1.5, dash: "dash" },
      hoverinfo: "skip",
      showlegend: false,
    });
    addNote(fig, `Slope = ${num(slope)}<br>Intercept = ${num(intercept)}`, options);
  }
  fig.data = [...traces, ...fig.data];
}

/** "Schild plot": a computed-points graph — its build draws empty axes
 *  (X = log[B], Y = log(DR − 1)); the graph view adds the points and the
 *  fitted line from the table's sibling Gaddum/Schild analysis. */
export const schildPlot: GraphModule = {
  label: "Schild plot",
  family: "xy",
  points: () => true,
  build: (_columns, options, _paint) => ({
    data: [],
    layout: xyLayout(options, "log [B]", 0, { yName: "log (DR − 1)" }),
  }),
};
