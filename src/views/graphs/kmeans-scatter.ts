// "Cluster scatter" of a K-means clustering: one point per subject (its
// first two variables, labelled by row title), coloured by cluster, with
// the cluster centres marked ×. Family `multiple`: the assignments and
// centres come from a sibling K-means analysis's cached runAnalysis result
// (see graph-view.tsx) — the graph draws only its axes until one is
// chosen, exactly like the forest plot (see forest-plot.ts). The points'
// coordinates come from the table's own first two variables; the centres
// are the result's back-transformed (original-unit) centres, so they sit
// on the plotted points.
import type { GraphOptions } from "../../store/types";
import type { AnalysisResult } from "../../stats/types";
import type { Column } from "../../lib/dataset";
import { pointKeyOf } from "../../lib/columns";
import { addNote, INK, seriesPoints, xyLayout, type Paint } from "./plot-helpers";
import type { GraphFigure, GraphModule } from ".";

/** The centres trace, as the Series section names it. */
export const KMEANS_CENTRES_SERIES = "Cluster centres";

/** The legend name of one cluster's points (canonical cluster numbers, 1-based). */
export const kmeansClusterName = (cluster: number) => `Cluster ${cluster}`;

/** Draw the points + centres of a K-means result onto a cluster-scatter
 *  figure (its build's axes). No-op when the result has no assignments
 *  (not a K-means result, or the fit failed). The rows plotted are the
 *  complete rows across every variable — the same rows the runner
 *  clustered, in the same order — so assignment i names row i. */
export function addKmeansScatter(
  fig: GraphFigure,
  columns: Column[],
  outcome: AnalysisResult,
  options: GraphOptions,
  paint: Paint,
  titles?: (string | null)[],
): void {
  const clusters = outcome.kmeansClusters ?? [];
  const assignments = outcome.kmeansAssignments ?? [];
  if (!clusters.length || !assignments.length) return;
  const [xCol, yCol] = columns;
  if (!xCol || !yCol) {
    addNote(fig, "The cluster scatter needs at least 2 variables with data.", options);
    return;
  }
  const rows = xCol.rows.filter((r) => columns.every((c) => c.byRow[r] != null));
  if (assignments.length !== rows.length) return;
  const layout = fig.layout as Record<string, unknown>;
  if (!options.xLabel) {
    (layout.xaxis as Record<string, unknown>).title = { text: xCol.name, standoff: options.xTitleGap };
  }
  if (!options.yLabel) {
    (layout.yaxis as Record<string, unknown>).title = { text: yCol.name, standoff: options.yTitleGap };
  }
  layout.showlegend = true;

  const xs = rows.map((r) => xCol.byRow[r]);
  const ys = rows.map((r) => yCol.byRow[r]);
  const labels = rows.map((r) => titles?.[r]?.trim() || `Row ${r + 1}`);
  fig.data = [
    // One trace per cluster, so each gets its own colour and legend entry.
    ...clusters.map((_c, ci) => {
      const idx = assignments.map((a, i) => (a.cluster === ci + 1 ? i : -1)).filter((i) => i >= 0);
      return {
        type: "scatter",
        mode: "markers+text",
        name: kmeansClusterName(ci + 1),
        x: idx.map((i) => xs[i]),
        y: idx.map((i) => ys[i]),
        text: idx.map((i) => labels[i]),
        textposition: "top center",
        textfont: { color: INK, size: Math.max(options.fontSize - 2, 8) },
        ...seriesPoints(
          paint,
          kmeansClusterName(ci + 1),
          ci,
          idx.map((i) => pointKeyOf(kmeansClusterName(ci + 1), i)),
        ),
        hoverinfo: "text+x+y",
        showlegend: true,
      };
    }),
    // The centres, marked × in the original units.
    {
      type: "scatter",
      mode: "markers",
      name: KMEANS_CENTRES_SERIES,
      x: clusters.map((c) => c.centre[0] ?? null),
      y: clusters.map((c) => c.centre[1] ?? null),
      marker: { color: INK, size: 14, symbol: "x", line: { color: INK, width: 2 } },
      hoverinfo: "x+y",
      showlegend: true,
    },
  ];
}

function build(columns: Column[], options: GraphOptions, _paint: Paint): GraphFigure {
  return {
    data: [],
    layout: xyLayout(options, columns[0]?.name ?? "X", 1, { yName: columns[1]?.name ?? "Y" }),
  };
}

export const kmeansScatter: GraphModule = {
  label: "Cluster scatter",
  family: "multiple",
  points: () => true,
  build,
};
