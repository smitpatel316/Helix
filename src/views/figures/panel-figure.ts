// A figure panel's Plotly figure, built the way the graph's own view builds
// it — from the same `GRAPHS` module, the same columns and the same paint —
// but without the overlays that need a live analysis run (significance
// brackets, regression and dose-response curves, the forest/scree/PCA/K-means
// overlays in graph-view.tsx). Those overlays need React hooks (`useAnalysis`)
// and cannot be built by a pure function; the panel therefore draws the
// graph's base chart (its data, colours, styles and titles) exactly as the
// graph view does, and a graph whose chart *is* its overlay (a forest plot
// with no Cox analysis, a scree plot with no PCA) draws only its axes here,
// exactly as it does in its own view without the analysis. See the plan
// file's Builder notes: extracting the overlay pipeline into a shared
// `buildGraphFigure` is the follow-up that makes panels pixel-identical to
// the graph view for overlay graphs.

import { DEFAULT_GRAPH_OPTIONS, type ProjectNode } from "../../store/types";
import { readTable } from "../../lib/dataset";
import { GRAPHS, graphSeries, plotColumns, type GraphFigure } from "../graphs";
import { paintOf } from "../graphs/plot-helpers";

/** The panel's figure, or null when its graph has nothing to draw (no table,
 *  no numeric columns, or an unknown graph type). With `hideLegend`, the
 *  panel draws no legend of its own — a figure with a shared legend promises
 *  "per-panel legends are hidden", so a panel that draws a legend (an XY
 *  scatter with >1 Y series, a grouped scatter…) must not draw it here.
 *  The graph's own view is untouched: only figure panels hide it. */
export function buildPanelFigure(
  graph: ProjectNode,
  nodes: Record<string, ProjectNode>,
  opts: { hideLegend?: boolean } = {},
): GraphFigure | null {
  if (graph.type !== "graph" || !graph.graphType || !Object.hasOwn(GRAPHS, graph.graphType)) return null;
  const parent = graph.parentId ? nodes[graph.parentId] : undefined;
  if (!parent?.data || !parent.tableType) return null;
  const options = { ...DEFAULT_GRAPH_OPTIONS, ...graph.graphOptions };
  const dataset = readTable(parent.data);
  const columns = plotColumns(dataset, graph.graphType, options, parent.tableType);
  if (!columns.some((c) => c.values.length > 0)) return null;
  const paint = paintOf(options, graphSeries(graph.graphType, parent.data, parent.tableType, options).length);
  const fig = GRAPHS[graph.graphType].build(columns, options, paint, dataset.titles);
  return opts.hideLegend ? { ...fig, layout: { ...fig.layout, showlegend: false } } : fig;
}
