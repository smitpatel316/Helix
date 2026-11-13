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
import { addNote, GUIDE, INK, xyLayout, type Paint } from "./plot-helpers";
import { num } from "../../lib/format";
import type { GraphFigure, GraphModule } from ".";

/** One row's label: "HR 0.37 (95% CI 0.10–1.34)". */
export function forestRowLabel(hazardRatio: number, low: number, high: number): string {
  return `HR ${num(hazardRatio)} (95% CI ${num(low)}–${num(high)})`;
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
 *  (not a Cox result, or the fit failed). Rows whose hazard ratio or CI bound
 *  is not finite and positive are omitted with a note: a log axis cannot draw
 *  them (see below), and silently hiding a covariate would be worse. */
export function addForestPlot(
  fig: GraphFigure,
  outcome: AnalysisResult,
  _paint: Paint,
  options: GraphOptions,
): void {
  const rows = (outcome.coefficients ?? []).filter(
    (c) => c.hazardRatio != null && c.low != null && c.high != null,
  );
  if (!rows.length) return;
  // Under separation R's exp(confint(m)) underflows a CI bound to 0 or
  // overflows it to Inf (and the hazard ratio itself can underflow to 0);
  // log10(0) = -Infinity / log10(Inf) = Infinity is an invalid Plotly range
  // that blanks the whole plot, and a whisker to 0 or Inf has no place on a
  // log scale anyway. Keep only drawable rows, so the range below is finite
  // by construction, and name the omitted covariates on the figure.
  const kept = rows.filter(
    (c) =>
      Number.isFinite(c.hazardRatio!) &&
      c.hazardRatio! > 0 &&
      Number.isFinite(c.low!) &&
      c.low! > 0 &&
      Number.isFinite(c.high!) &&
      c.high! > 0,
  );
  if (kept.length < rows.length) {
    const dropped = rows.filter((c) => !kept.includes(c)).map((c) => `“${c.term}”`);
    addNote(
      fig,
      `${dropped.join(", ")} omitted: the hazard ratio or 95% CI is not finite and positive, so it cannot be drawn on a log scale.`,
      options,
    );
  }
  if (!kept.length) return;
  const terms = kept.map((c) => c.term);
  const hrs = kept.map((c) => c.hazardRatio!);
  const los = kept.map((c) => c.low!);
  const his = kept.map((c) => c.high!);
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
      text: kept.map((c) => forestRowLabel(c.hazardRatio!, c.low!, c.high!)),
      hoverinfo: "text+x",
      showlegend: false,
    },
  ];
}

export const forestPlot: GraphModule = { label: "Forest plot", family: "xy", points: () => true, build };
