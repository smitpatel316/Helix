// "Histogram": one bar trace per data column, binned by the same
// `computeFrequencyBins` the frequency-distribution analysis runs (automatic /
// Sturges binning), so the bars can never disagree with the analysis's table.
// Bars touch (bargap 0); x is the bin centre, y the count, each bar as wide as
// its bin. The bin range is the hover text.
import type { GraphOptions } from "../../store/types";
import type { Column } from "../../lib/dataset";
import { computeFrequencyBins } from "../../stats/column/frequency-distribution";
import { xyLayout, type Paint } from "./plot-helpers";
import type { GraphFigure, GraphModule } from ".";

function build(columns: Column[], options: GraphOptions, paint: Paint): GraphFigure {
  const xName = columns.length === 1 ? columns[0].name : "Value";
  const layout = () => xyLayout({ ...options, xLabel: options.xLabel || xName }, xName, columns.length, { zeroBase: true, yName: "Count" });
  const data = columns
    .filter((c) => c.values.length > 0)
    .map((column, i) => {
      const { bins } = computeFrequencyBins(column.values, { binMode: "auto" });
      return {
        type: "bar",
        name: column.name,
        x: bins.map((b) => (b.lower + b.upper) / 2),
        y: bins.map((b) => b.count),
        // A zero-width bin (a constant column) still draws, one unit wide.
        width: bins.map((b) => b.upper - b.lower || 1),
        text: bins.map((b) => b.bin),
        hoverinfo: "text+y",
        marker: paint.bars(column.name, i),
      };
    });
  return {
    data,
    layout: { ...layout(), bargap: 0, barmode: "overlay" },
  };
}

export const histogram: GraphModule = {
  label: "Histogram",
  family: "column",
  // Overlapping columns stay visible through each other.
  defaults: { fill: 0.7 },
  patterns: () => true,
  build,
};
