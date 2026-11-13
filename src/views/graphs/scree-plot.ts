// "Scree plot" of a Principal component analysis: one bar per component
// (its % of the total variance) with the cumulative % as a line on a
// secondary axis. Family `multiple`: the bars come from a sibling PCA's
// cached runAnalysis result (see graph-view.tsx) — the graph draws only its
// axes until one is chosen, exactly like the forest plot (see forest-plot.ts).
import type { GraphOptions } from "../../store/types";
import type { AnalysisResult } from "../../stats/types";
import type { Column } from "../../lib/dataset";
import { INK, xyLayout, type Paint } from "./plot-helpers";
import type { GraphFigure, GraphModule } from ".";

/** The one series this graph draws, as the Series section names it. */
export const SCREE_SERIES = "Scree plot";

/** Draw the scree bars + cumulative-% line of a PCA result onto a scree-plot
 *  figure (its build's axes). No-op when the result has no variance table
 *  (not a PCA result, or the fit failed). */
export function addScreePlot(fig: GraphFigure, outcome: AnalysisResult, paint: Paint): void {
  const variance = outcome.pcaVariance ?? [];
  if (!variance.length) return;
  const xs = variance.map((v) => v.component);
  const pct = variance.map((v) => (v.proportion ?? 0) * 100);
  const cum = variance.map((v) => (v.cumulative ?? 0) * 100);
  const layout = fig.layout as Record<string, unknown>;
  layout.showlegend = true;
  layout.xaxis = {
    ...(layout.xaxis as Record<string, unknown>),
    type: "category",
    categoryorder: "array",
    categoryarray: xs,
  };
  layout.yaxis = {
    ...(layout.yaxis as Record<string, unknown>),
    range: [0, 100],
    autorange: false,
  };
  layout.yaxis2 = {
    title: { text: "Cumulative %", standoff: 2 },
    overlaying: "y",
    side: "right",
    range: [0, 100],
    autorange: false,
    tickfont: { color: INK },
  };
  fig.data = [
    {
      type: "bar",
      name: "Variance explained",
      x: xs,
      y: pct,
      marker: paint.bars(SCREE_SERIES, 0),
      hovertemplate: "%{x}: %{y:.2f}%<extra></extra>",
      showlegend: true,
    },
    {
      type: "scatter",
      mode: "lines+markers",
      name: "Cumulative %",
      x: xs,
      y: cum,
      yaxis: "y2",
      line: { color: INK, width: 2 },
      marker: { color: INK, size: 6 },
      hovertemplate: "%{x}: %{y:.2f}%<extra></extra>",
      showlegend: true,
    },
  ];
}

function build(_columns: Column[], options: GraphOptions, _paint: Paint): GraphFigure {
  return {
    data: [],
    layout: xyLayout(options, "Component", 1, { yName: "Variance explained (%)" }),
  };
}

export const screePlot: GraphModule = {
  label: "Scree plot",
  family: "multiple",
  points: () => false,
  build,
};
