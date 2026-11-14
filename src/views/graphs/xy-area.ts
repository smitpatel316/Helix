// "XY area": each Y data set drawn as a line with the area beneath it filled,
// against the shared X (replicates as each X's center, `xyDrawn`).
import type { GraphOptions } from "../../store/types";
import type { GraphModule, GraphFigure } from ".";
import { splitXY, type Column } from "../../lib/dataset";
import { xyDrawn, xyLayout, type Paint } from "./plot-helpers";

function build(columns: Column[], options: GraphOptions, paint: Paint): GraphFigure {
  const { x: xCol, ys } = splitXY(columns);
  if (!xCol || ys.length === 0) return { data: [], layout: xyLayout(options, columns[0]?.name ?? "X", 0) };

  const data = ys.map((set, i) => {
    // An area joins one value per X: replicates as their center, whatever `xyReplicates`.
    const raw = xyDrawn(xCol, set, { ...options, xyReplicates: "mean" });
    // Filled in X order, not table row order: the fill must follow the trend.
    const order = raw.x.map((_, k) => k).sort((a, b) => raw.x[a] - raw.x[b]);
    const drawn = {
      x: order.map((k) => raw.x[k]),
      y: order.map((k) => raw.y[k]),
      ...(raw.errors ? { errors: order.map((k) => raw.errors![k]) } : {}),
    };
    const over = paint.pattern(set.name, i);
    return {
      type: "scatter",
      mode: "lines",
      name: set.name,
      x: drawn.x,
      y: drawn.y,
      line: paint.edge(set.name, i),
      fill: "tozeroy",
      fillcolor: paint.fill(set.name, i),
      ...(over && { fillpattern: over }),
      ...(drawn.errors ? { error_y: paint.errorBars(set.name, i, drawn.errors) } : {}),
      hoverinfo: "x+y",
    };
  });

  return { data, layout: xyLayout(options, xCol.name, ys.length, { zeroBase: true, seriesNames: ys.map((y) => y.name) }) };
}

export const xyArea: GraphModule = {
  label: "Area",
  family: "xy",
  defaults: { fill: 0.5, outline: 2 },
  patterns: () => true,
  build,
};
