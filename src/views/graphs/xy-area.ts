// "XY area": each Y series drawn as a line with the area beneath it filled,
// against the shared X.
import type { GraphOptions } from "../../store/types";
import type { GraphModule, GraphFigure } from ".";
import { pairUp, type Column } from "../../lib/dataset";
import { sortPairsByX, xyLayout, type Paint } from "./plot-helpers";

function build(columns: Column[], options: GraphOptions, paint: Paint): GraphFigure {
  const [xCol, ...ySeries] = columns;
  if (!xCol || ySeries.length === 0) return { data: [], layout: xyLayout(options, xCol?.name ?? "X", 0) };

  const data = ySeries.map((y, i) => {
    const pairs = pairUp(xCol, y);
    // Filled in X order, not table row order: the fill must follow the trend.
    const { x, y: yy } = sortPairsByX(pairs.x, pairs.y);
    const over = paint.pattern(y.name, i);
    return {
      type: "scatter",
      mode: "lines",
      name: y.name,
      x,
      y: yy,
      line: paint.edge(y.name, i),
      fill: "tozeroy",
      fillcolor: paint.fill(y.name, i),
      ...(over && { fillpattern: over }),
      hoverinfo: "x+y",
    };
  });

  return { data, layout: xyLayout(options, xCol.name, ySeries.length, { zeroBase: true, seriesNames: ySeries.map((y) => y.name) }) };
}

export const xyArea: GraphModule = {
  label: "Area",
  family: "xy",
  defaults: { fill: 0.5, outline: 2 },
  patterns: () => true,
  build,
};
