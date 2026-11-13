// "Smooth curve": the fitted curve of a sibling "Spline and Lowess" analysis
// drawn over the XY scatter. The curve comes from the analysis's own result
// (its `curve` field — the dense grid), never re-fitted here: the R code that
// produces it lives in exactly one place, the runner (stats/xy/spline-lowess.ts),
// and the graph reads the same cached runAnalysis result the analysis view
// shows. Without a linked analysis the graph draws the points only and the
// Format panel prompts for one.
import type { GraphOptions } from "../../store/types";
import type { AnalysisResult } from "../../stats/types";
import { xyScatter } from "./xy-scatter";
import type { GraphModule, GraphFigure } from ".";
import type { Paint } from "./plot-helpers";
import type { Column } from "../../lib/dataset";

export const smoothCurve: GraphModule = {
  label: "Smooth curve",
  family: "xy",
  points: () => true,
  build: (columns, options, paint) => xyScatter.build(columns, { ...options, xyStyle: "points" }, paint),
};

/** Draws the sibling analysis's smooth line under the points. The line is
 *  drawn from `curve` (the dense grid), not by joining the fitted points —
 *  joining fitted points is visibly polygonal when n is small. An old result
 *  without `curve` falls back to joining `fitted`. Nothing is drawn when the
 *  toggle is off or there is no result to draw from. */
export function addSmoothCurve(
  fig: GraphFigure,
  columns: Column[],
  options: GraphOptions,
  fit: AnalysisResult | null,
  paint: Paint,
) {
  const [x, ...ys] = columns;
  if (!options.smoothShowCurve || !fit) return;
  const pts = fit.curve?.length ? fit.curve : fit.fitted;
  if (!x || !ys.length || !pts?.length) return;
  // The curve belongs to the Y series the analysis smoothed (its second group).
  const y = ys.find((c) => c.name === fit.groups[1]?.name) ?? ys[0];
  fig.data = [
    {
      type: "scatter",
      mode: "lines",
      x: pts.map((p) => p.x),
      y: pts.map((p) => p.y),
      line: { color: paint.color(y.name, ys.indexOf(y)), width: 1.5 },
      hoverinfo: "skip",
      showlegend: false,
    },
    ...fig.data,
  ];
}
