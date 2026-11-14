// "Monte Carlo histogram": the simulated distribution of a sibling "Monte
// Carlo simulation" analysis's statistic. The bins come from the analysis's
// own result (`monteCarlo.bins` — Sturges + R pretty() breaks, computed once
// by the runner, so the graph can never disagree with the analysis), never
// re-binned here. A vertical dashed line marks the observed (real-data)
// value of the same statistic, and for P values a shaded region covers
// P < 0.05 (the significant repeats — the power). Without a linked analysis
// the graph draws only its axes, and the Format panel says to run the
// analysis first — exactly like the forest plot / scree plot.
import type { GraphOptions } from "../../store/types";
import type { AnalysisResult } from "../../stats/types";
import type { Column } from "../../lib/dataset";
import { INK, xyLayout, type Paint } from "./plot-helpers";
import { num } from "../../lib/format";
import type { GraphFigure, GraphModule } from ".";

/** The series name the Series section styles. */
export const MONTE_CARLO_HISTOGRAM_SERIES = "Simulated";

function build(_columns: Column[], options: GraphOptions, _paint: Paint): GraphFigure {
  const layout = xyLayout(options, "Statistic", 1, { zeroBase: true, yName: "Count" });
  return { data: [], layout };
}

export const monteCarloHistogram: GraphModule = {
  label: "Monte Carlo histogram",
  family: "column",
  defaults: { fill: 0.7 },
  patterns: () => true,
  build,
};

/** Draw the sibling Monte Carlo result's bins onto a histogram figure (its
 *  build's axes), with the observed-value line and, for P values, the
 *  P < 0.05 shading. No-op when the result has no Monte Carlo summary (not
 *  a Monte Carlo result, or the run failed). */
export function addMonteCarloHistogram(
  fig: GraphFigure,
  outcome: AnalysisResult,
  paint: Paint,
): void {
  const mc = outcome.monteCarlo;
  if (!mc || mc.bins.edges.length < 2 || !mc.bins.counts.length) return;
  const { edges, counts } = mc.bins;
  const centers = counts.map((_, i) => (edges[i] + edges[i + 1]) / 2);
  const widths = counts.map((_, i) => edges[i + 1] - edges[i] || 1);
  const labels = counts.map((_, i) =>
    i === 0 ? `[${num(edges[i])}, ${num(edges[i + 1])}]` : `(${num(edges[i])}, ${num(edges[i + 1])}]`,
  );
  const maxCount = Math.max(...counts, 1);
  const layout = fig.layout as Record<string, unknown>;
  // The x-axis is the statistic (labelled by the analysis's subtitle); the
  // y-axis counts repeats. A zero-width bin (a constant statistic) still
  // draws, one unit wide — as the histogram graph does.
  layout.xaxis = {
    ...(layout.xaxis as Record<string, unknown>),
    title: { text: mc.statistic },
  };
  const shapes: Record<string, unknown>[] = [];
  if (mc.statistic === "P value") {
    // Shade the significant repeats: the region below 0.05, clipped to the
    // bins' range (a P-value histogram always starts at 0).
    const lo = edges[0];
    if (0.05 > lo) {
      shapes.push({
        type: "rect",
        x0: lo,
        x1: Math.min(0.05, edges.at(-1)!),
        y0: 0,
        y1: 1,
        yref: "paper",
        fillcolor: paint.color(MONTE_CARLO_HISTOGRAM_SERIES, 0),
        opacity: 0.18,
        line: { width: 0 },
      });
    }
  }
  if (mc.observed != null && Number.isFinite(mc.observed)) {
    shapes.push({
      type: "line",
      x0: mc.observed,
      x1: mc.observed,
      y0: 0,
      y1: 1,
      yref: "paper",
      line: { color: INK, width: 1.5, dash: "dash" },
    });
  }
  if (shapes.length) layout.shapes = shapes;
  // The observed line's label, above the plot: the value on the real data.
  const annotations: Record<string, unknown>[] = [...((layout.annotations as Record<string, unknown>[]) ?? [])];
  if (mc.observed != null && Number.isFinite(mc.observed)) {
    annotations.push({
      name: "observed",
      x: mc.observed,
      y: maxCount,
      xref: "x",
      yref: "y",
      text: `Observed ${num(mc.observed)}`,
      showarrow: false,
      xanchor: "left",
      yanchor: "bottom",
    });
  }
  if (annotations.length) layout.annotations = annotations;
  fig.data = [
    {
      type: "bar",
      name: MONTE_CARLO_HISTOGRAM_SERIES,
      x: centers,
      y: counts,
      width: widths,
      text: labels,
      hoverinfo: "text+y",
      marker: paint.bars(MONTE_CARLO_HISTOGRAM_SERIES, 0),
    },
  ];
}
