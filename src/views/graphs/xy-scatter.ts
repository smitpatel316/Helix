// "XY scatter": each Y series plotted against the shared X, as points, a
// connecting line, or both (Prism's Scatter / Scatter+line / Line-only icons
// collapsed into one graph type via a style toggle).
import type { GraphOptions } from "../../store/types";
import type { GraphModule, GraphFigure } from ".";
import { pairUp, type Column } from "../../lib/dataset";
import { addNote, seriesPoints, xyLayout, type Paint } from "./plot-helpers";
import { pointKeyOf } from "../../lib/columns";

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
  const [xCol, ...ySeries] = columns;
  if (!xCol || ySeries.length === 0) return { data: [], layout: xyLayout(options, xCol?.name ?? "X", 0) };

  const mode = options.xyStyle === "line" ? "lines" : options.xyStyle === "points+line" ? "lines+markers" : "markers";
  // Pair every series up first: the cap is on the total plotted, so the stride
  // is shared — each series keeps its shape and the total stays at the cap.
  const pairs = ySeries.map((y) => pairUp(xCol, y));
  const total = pairs.reduce((sum, p) => sum + p.x.length, 0);
  const stride = total > XY_SCATTER_MAX_POINTS ? Math.ceil(total / XY_SCATTER_MAX_POINTS) : 1;
  const thin = <T>(values: T[]): T[] => (stride === 1 ? values : values.filter((_, i) => i % stride === 0));
  const data = ySeries.map((y, i) => {
    const { x, y: yy, rows } = pairs[i];
    const px = thin(x);
    const py = thin(yy);
    const prows = thin(rows);
    return {
      type: "scatter",
      mode,
      name: y.name,
      x: px,
      y: py,
      ...(mode !== "lines"
        ? seriesPoints(
            paint,
            y.name,
            i,
            prows.map((r) => pointKeyOf(y.name, r)),
          )
        : {}),
      ...(mode !== "markers" ? { line: paint.line(y.name, i) } : {}),
      hoverinfo: "x+y",
    };
  });

  const fig: GraphFigure = {
    data,
    layout: xyLayout(options, xCol.name, ySeries.length, { seriesNames: ySeries.map((y) => y.name) }),
  };
  if (stride > 1) {
    const shown = data.reduce((sum, t) => sum + t.x.length, 0);
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
