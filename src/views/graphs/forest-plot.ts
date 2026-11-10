// "Forest plot" of a Cox proportional-hazards regression's hazard ratios:
// one row per covariate, the hazard ratio on a LOG-scale x-axis, a vertical
// reference line at HR = 1, whiskers = the 95% CI. Family `xy`: the x-axis
// is numeric (log HR), the y-axis is the covariate names. The rows come from
// a sibling Cox analysis's cached runAnalysis result (see graph-view.tsx) —
// the graph draws only its axes until one is chosen, exactly like the
// dose-response curve's fitted overlay (see dose-response-curve.ts).
import type { GraphOptions } from "../../store/types";
import type { AnalysisResult } from "../../stats/types";
import type { Column } from "../../lib/dataset";
import { GUIDE, INK, xyLayout, type Paint } from "./plot-helpers";
import { num } from "../../lib/format";
import type { GraphFigure, GraphModule } from ".";

/** One row's label: "HR 0.37 (95% CI 0.10–1.34)". */
export function forestRowLabel(hazardRatio: number, ciLow: number, ciHigh: number): string {
  return `HR ${num(hazardRatio)} (95% CI ${num(ciLow)}–${num(ciHigh)})`;
}

/** The vertical reference line at HR = 1, drawn as a layout shape. */
function referenceLine(): Record<string, unknown> {
  return {
    type: "line",
    x0: 1,
    x1: 1,
    y0: 0,
    y1: 1,
    yref: "paper",
    line: { color: GUIDE, width: 1.5, dash: "dash" },
  };
}

function build(_columns: Column[], options: GraphOptions, _paint: Paint): GraphFigure {
  const layout = xyLayout(options, "Hazard ratio", 1, { yName: "" });
  return {
    data: [],
    layout: {
      ...layout,
      showlegend: false,
      xaxis: { ...(layout.xaxis as Record<string, unknown>), type: "log" },
      yaxis: { ...(layout.yaxis as Record<string, unknown>), autorange: "reversed" },
      shapes: [referenceLine()],
    },
  };
}

/** Draw the hazard-ratio rows of a Cox result onto a forest-plot figure (its
 *  build's axes + reference line). No-op when the result has no hazard ratios
 *  (not a Cox result, or the fit failed). */
export function addForestPlot(fig: GraphFigure, outcome: AnalysisResult, _paint: Paint): void {
  const rows = (outcome.coefficients ?? []).filter(
    (c) => c.hazardRatio != null && c.ciLow != null && c.ciHigh != null,
  );
  if (!rows.length) return;
  const terms = rows.map((c) => c.term);
  const hrs = rows.map((c) => c.hazardRatio!);
  const los = rows.map((c) => c.ciLow!);
  const his = rows.map((c) => c.ciHigh!);
  const layout = fig.layout as Record<string, unknown>;
  // The range covers every whisker plus the reference line at 1, with room
  // for the labels: a log axis takes data units, not log units.
  const lo = Math.min(1, ...los) * 0.7;
  const hi = Math.max(1, ...his) * 1.4;
  // A log axis takes its range in log10 units (Plotly reference: "If the axis
  // `type` is `log`, then you must take the log of your desired range"). The
  // first version passed data units [0.072, 1.89] and rendered [1.18, 78] —
  // caught by Linux GUI QA, Plan 10. `autorange: false` is the codebase's
  // usual pairing for an explicit range (Plotly sets it anyway when `range`
  // is provided).
  layout.xaxis = {
    ...(layout.xaxis as Record<string, unknown>),
    type: "log",
    range: [Math.log10(lo), Math.log10(hi)],
    autorange: false,
  };
  layout.yaxis = {
    ...(layout.yaxis as Record<string, unknown>),
    categoryorder: "array",
    categoryarray: terms,
    autorange: "reversed",
  };
  fig.data = [
    {
      type: "scatter",
      mode: "markers",
      name: "Hazard ratio",
      x: hrs,
      y: terms,
      marker: { color: INK, size: 9, symbol: "diamond" },
      error_x: {
        type: "data",
        symmetric: false,
        array: his.map((v, i) => v - hrs[i]),
        arrayminus: hrs.map((v, i) => v - los[i]),
        color: INK,
        thickness: 1.5,
        width: 6,
      },
      text: rows.map((c) => forestRowLabel(c.hazardRatio!, c.ciLow!, c.ciHigh!)),
      hoverinfo: "text+x",
      showlegend: false,
    },
  ];
}

export const forestPlot: GraphModule = { label: "Forest plot", family: "xy", points: () => true, build };
