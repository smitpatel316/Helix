// "ROC curve": sensitivity against 1 − specificity across all thresholds, the
// diagonal chance line, and a marker at the optimal (Youden) cutpoint. Family
// `xy`: it is an X/Y scatter of derived points, not table columns. The points
// come from `computeRocCurve` in the runner module — the same arithmetic the
// analysis runs — so the graph works standalone (no analysis node needed) and
// its numbers agree exactly with the analysis result by construction, rather
// than by a second computation. The truth column may be text
// ("Diseased"/"Healthy"): `plotColumns` hands this graph the first two data
// columns whatever they hold (see graphs/index.ts).
import type { GraphOptions } from "../../store/types";
import type { Column } from "../../lib/dataset";
import { computeRocCurve, defaultPositive, rocPairs } from "../../stats/column/roc-curve";
import { num } from "../../lib/format";
import { GUIDE, INK, xyLayout, type Paint } from "./plot-helpers";
import type { GraphFigure, GraphModule } from ".";

function build(columns: Column[], options: GraphOptions, paint: Paint): GraphFigure {
  const layout = xyLayout(options, "1 − Specificity", 1, { yName: "Sensitivity" });
  const axes = {
    // Both axes are fixed 0–1 (an ROC curve has no values outside them).
    // Equal aspect is not forced: on a wider-than-tall sheet Plotly's
    // scaleanchor would stretch the X range past [0, 1] to keep it square.
    xaxis: { ...(layout.xaxis as Record<string, unknown>), range: [0, 1] },
    yaxis: { ...(layout.yaxis as Record<string, unknown>), range: [0, 1] },
  };
  const [truthCol, scoreCol] = columns;
  if (!truthCol || !scoreCol) return { data: [], layout: { ...layout, ...axes } };
  const { pairs } = rocPairs(truthCol, scoreCol);
  const distinct = [...new Set(pairs.map((p) => p.label))];
  if (distinct.length !== 2) return { data: [], layout: { ...layout, ...axes } };
  const r = computeRocCurve(pairs, defaultPositive(distinct));
  const color = paint.color(scoreCol.name, 0);
  // The empirical ROC curve: (0,0), then one vertex per threshold
  // (descending thresholds run from low sensitivity to high), then (1,1).
  const x = [0, ...r.points.map((p) => 1 - p.specificity), 1];
  const y = [0, ...r.points.map((p) => p.sensitivity), 1];
  const optX = 1 - r.optimum.specificity;
  const optY = r.optimum.sensitivity;
  const data: unknown[] = [
    {
      type: "scatter",
      mode: "lines+markers",
      name: "ROC curve",
      x,
      y,
      line: { color, width: 2 },
      marker: { color, size: 5 },
      hoverinfo: "x+y",
      showlegend: false,
    },
    {
      type: "scatter",
      mode: "lines",
      name: "Chance",
      x: [0, 1],
      y: [0, 1],
      line: { color: GUIDE, width: 1.5, dash: "dash" },
      hoverinfo: "skip",
      showlegend: false,
    },
    {
      type: "scatter",
      mode: "markers",
      name: `Optimal cutpoint ${num(r.optimum.threshold)}`,
      x: [optX],
      y: [optY],
      marker: { color, size: 12, symbol: "circle-open", line: { width: 2.5 } },
      text: [`Optimal cutpoint ${num(r.optimum.threshold)}`],
      hoverinfo: "text+x+y",
      showlegend: false,
    },
  ];
  const annotations: unknown[] = [
    {
      x: optX,
      y: optY,
      xref: "x",
      yref: "y",
      text: `Optimal cutpoint ${num(r.optimum.threshold)}`,
      showarrow: true,
      arrowhead: 2,
      arrowsize: 1,
      arrowwidth: 1,
      arrowcolor: INK,
      ax: 30,
      ay: -30,
      font: { color: INK, size: Math.max(options.fontSize - 1, 8) },
    },
  ];
  return { data, layout: { ...layout, ...axes, annotations } };
}

export const rocCurveGraph: GraphModule = {
  label: "ROC curve",
  family: "xy",
  points: () => true,
  lines: () => true,
  build,
};
