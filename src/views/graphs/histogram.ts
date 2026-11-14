// "Histogram": one bar trace per data column, binned by the same
// `computeFrequencyBins` the frequency-distribution analysis runs (automatic /
// Sturges binning, or the typed bin width when one is set and it makes at
// most MAX_BINS bins — otherwise automatic, as the Format panel says), so the
// bars can never disagree with the analysis's table.
// Bars touch (bargap 0); x is the bin centre, y the count (or percent of the
// column's total when "Show as" says so), each bar as wide as its bin. The
// bin range is the hover text.
import type { GraphOptions } from "../../store/types";
import type { Column } from "../../lib/dataset";
import { tooManyBins } from "../../lib/histogram";
import { computeFrequencyBins } from "../../stats/column/frequency-distribution";
import { xyLayout, type Paint } from "./plot-helpers";
import type { GraphFigure, GraphModule } from ".";

function build(columns: Column[], options: GraphOptions, paint: Paint): GraphFigure {
  const xName = columns.length === 1 ? columns[0].name : "Value";
  const percent = options.stackAs === "percent";
  // A typed width draws only when it is positive and makes at most MAX_BINS
  // bins over all the plotted values together — the same test the Format
  // panel reports ("Auto is drawn"); otherwise automatic binning.
  const typedWidth = options.binWidth;
  const useWidth =
    typedWidth != null &&
    Number.isFinite(typedWidth) &&
    typedWidth > 0 &&
    !tooManyBins(
      columns.flatMap((c) => c.values),
      typedWidth,
    );
  const layout = () =>
    xyLayout({ ...options, xLabel: options.xLabel || xName }, xName, columns.length, {
      zeroBase: true,
      yName: percent ? "Percent of total" : "Count",
      seriesNames: columns.map((c) => c.name),
    });
  const data = columns
    .filter((c) => c.values.length > 0)
    .map((column, i) => {
      const { bins } = computeFrequencyBins(
        column.values,
        useWidth ? { binMode: "width", binWidth: typedWidth } : { binMode: "auto" },
      );
      return {
        type: "bar",
        name: column.name,
        x: bins.map((b) => (b.lower + b.upper) / 2),
        y: percent ? bins.map((b) => (100 * b.count) / column.values.length) : bins.map((b) => b.count),
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
