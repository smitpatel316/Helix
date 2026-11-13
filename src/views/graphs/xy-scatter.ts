// "XY scatter": each Y data set plotted against the shared X, as points, a
// connecting line, or both (Prism's Scatter / Scatter+line / Line-only icons
// collapsed into one graph type via a style toggle). Replicates are drawn each, or
// as each X's center with its error bars (`xyDrawn`).
import type { GraphOptions } from "../../store/types";
import type { GraphModule, GraphFigure } from ".";
import { splitXY, type Column } from "../../lib/dataset";
import { addNote, seriesMarker, seriesPoints, xyDrawn, xyLayout, type Paint } from "./plot-helpers";

/** The most points an XY scatter draws in total. An SVG `scatter` trace costs
 *  about 0.1 ms of blocked UI thread per point — timed renders (R2-G-F18,
 *  headless Chromium, same `Plotly.react` the graph view makes): 10k points
 *  took 1.3s unloaded (14.2s on a loaded machine) and 50k took 5.3s (50.4s
 *  loaded), while the volcano's `scattergl` took 3.9s for the same 10k — and
 *  the graph view redraws with no cancel, so an uncapped series freezes the
 *  app for seconds, longer the larger the table. Above the cap each series
 *  is stride-sampled and the figure says so. */
export const XY_SCATTER_MAX_POINTS = 5000;

function build(columns: Column[], options: GraphOptions, paint: Paint): GraphFigure {
  const { x: xCol, ys } = splitXY(columns);
  if (!xCol || ys.length === 0) return { data: [], layout: xyLayout(options, columns[0]?.name ?? "X", 0) };

  const mode = options.xyStyle === "line" ? "lines" : options.xyStyle === "points+line" ? "lines+markers" : "markers";
  // Replicates as their center (or each value) per `xyReplicates`; then the cap
  // is on the total plotted, so the stride is shared — each series keeps its
  // shape and the total stays at the cap.
  const drawn = ys.map((set) => xyDrawn(xCol, set, options));
  const total = drawn.reduce((sum, d) => sum + d.x.length, 0);
  const stride = total > XY_SCATTER_MAX_POINTS ? Math.ceil(total / XY_SCATTER_MAX_POINTS) : 1;
  const thin = <T>(values: T[] | undefined): T[] | undefined =>
    values === undefined ? undefined : stride === 1 ? values : values.filter((_, i) => i % stride === 0);
  const data = ys.map((set, i) => {
    const d = drawn[i];
    // Sort by X only when the mode draws a line: the line must follow the
    // trend, not the table's row order. Markers-only has no connecting line,
    // so the points keep table row order (the reference golden for Height vs
    // Weight is recorded that way). Thinned after the sort-or-not decision,
    // so the sampled points keep the shape either way.
    const order =
      mode !== "markers" ? d.x.map((_, k) => k).sort((a, b) => d.x[a] - d.x[b]) : d.x.map((_, k) => k);
    const pick = <T>(v: T[] | undefined) => (v ? order.map((k) => v[k]) : undefined);
    const px = thin(pick(d.x)!);
    const py = thin(pick(d.y)!);
    const pkeys = thin(pick(d.keys));
    const perr = thin(pick(d.errors));
    return {
      type: "scatter",
      mode,
      name: set.name,
      x: px,
      y: py,
      ...(mode !== "lines"
        ? pkeys
          ? seriesPoints(paint, set.name, i, pkeys)
          : { marker: seriesMarker(paint, set.name, i) }
        : {}),
      ...(mode !== "markers" ? { line: paint.line(set.name, i) } : {}),
      ...(perr ? { error_y: paint.errorBars(set.name, i, perr) } : {}),
      hoverinfo: "x+y",
    };
  });

  const fig: GraphFigure = {
    data,
    layout: xyLayout(options, xCol.name, ys.length, { seriesNames: ys.map((y) => y.name) }),
  };
  if (stride > 1) {
    const shown = data.reduce((sum, t) => sum + (t.x?.length ?? 0), 0);
    addNote(
      fig,
      `Large series thinned for speed: showing 1 in ${stride} points (${shown} of ${total} plotted).`,
      options,
    );
  }
  return fig;
}

export const xyScatter: GraphModule = {
  label: "Scatter or line",
  family: "xy",
  points: (options) => options.xyStyle !== "line",
  lines: (options) => options.xyStyle !== "points",
  build,
};
