// "Survival curve" (XY table): X is time, each Y series is a group. Two modes
// (options.survivalMode):
// - "codes": cells are per-subject event codes (1 = event, 0 = censored) at that
//   time; Kaplan-Meier estimator (lib/kaplan-meier.ts, shared with the Survival analysis),
//   computed in plain JS (closed-form, no WebR round-trip needed).
// - "counts": cells are the number of survivors remaining in that group at that
//   time; plotted directly as percent-of-initial, no event/censor concept.
import type { GraphOptions, TableData } from "../../store/types";
import type { CoxPHParams } from "../../stats/types";
import type { GraphModule, GraphFigure } from ".";
import { pairUp, readTable, type Column } from "../../lib/dataset";
import { num } from "../../lib/format";
import { xyLayout, type Paint } from "./plot-helpers";
import { withOpacity } from "../../lib/palettes";
import { kaplanMeier } from "../../lib/kaplan-meier";

// Re-exported for existing importers (tests/reference.ts): the lib
// version returns the same steps plus the 95% band (lower/upper).
export { kaplanMeier };

/** "counts" mode: cells are survivors remaining, plotted directly as percent-of-initial. */
function survivorCountsStep(x: number[], counts: number[]): { t: number[]; s: number[] } {
  const order = x.map((_, i) => i).sort((a, b) => x[a] - x[b]);
  const initial = counts[order[0]] || 1;
  return { t: order.map((i) => x[i]), s: order.map((i) => (counts[i] / initial) * 100) };
}

function build(columns: Column[], options: GraphOptions, paint: Paint): GraphFigure {
  const [xCol, ...ySeries] = columns;
  const layout = xyLayout(options, xCol?.name ?? "Time", ySeries.length, { zeroBase: true, yName: "Percent survival", seriesNames: ySeries.map((y) => y.name) });
  if (!xCol || ySeries.length === 0) return { data: [], layout };

  const byCodes = options.survivalMode !== "counts";
  const data = ySeries.flatMap((y, i) => {
    const { x, y: values } = pairUp(xCol, y);
    const color = paint.color(y.name, i);
    // A group's curve, band and ticks are one legend item: hiding it hides them all.
    const steps = (t: number[], s: number[], style: object) => ({
      type: "scatter",
      mode: "lines",
      legendgroup: y.name,
      x: t,
      y: s,
      line: { shape: "hv", ...style },
      hoverinfo: "skip",
      showlegend: false,
    });
    if (!byCodes) {
      const { t, s } = survivorCountsStep(x, values);
      return [{ ...steps(t, s, paint.line(y.name, i)), name: y.name, hoverinfo: "x+y", showlegend: true }];
    }
    const km = kaplanMeier(x, values);
    const percent = (curve: (number | null)[]) => curve.map((v, k) => (v ?? km.s[k]) * 100);
    const traces: unknown[] = [];
    // The 95% band, under the curve; where it can't be computed (S = 1 or 0) it closes on the curve.
    if (options.survivalShowBand) {
      traces.push(steps(km.t, percent(km.lower), { width: 0 }), {
        ...steps(km.t, percent(km.upper), { width: 0 }),
        fill: "tonexty",
        fillcolor: withOpacity(color, 0.2), // light: the curves' bands overlap
      });
    }
    traces.push({
      ...steps(km.t, percent(km.s), paint.line(y.name, i)),
      name: y.name,
      hoverinfo: "x+y",
      showlegend: true,
    });
    if (options.survivalShowCensors && km.censorT.length) {
      traces.push({
        type: "scatter",
        mode: "markers",
        name: y.name,
        legendgroup: y.name,
        x: km.censorT,
        y: percent(km.censorS),
        marker: { color, size: 9, symbol: "line-ns-open", line: { width: 1.5 } },
        showlegend: false,
        hoverinfo: "skip",
      });
    }
    return traces;
  });

  // The groups in table order: Plotly would list them backwards once a band fills.
  return { data, layout: { ...layout, legend: { ...(layout.legend as object), traceorder: "normal" } } };
}

export const survival: GraphModule = { label: "Survival curve", family: "xy", lines: () => true, build };

/** The survival graph's columns from a Multiple Variables table + a Cox
 *  analysis's params: the time column, then one event-code column per value
 *  of the stratifier (or a single code column for all subjects when the
 *  analysis stratifies by nothing) — the XY shape this graph already draws.
 *  Rows are complete cases only. Null when the time/status columns are
 *  missing or no complete row exists. */
export function coxSurvivalColumns(data: TableData, params: CoxPHParams): Column[] | null {
  const dataset = readTable(data);
  const time = params.time ? dataset.columns.find((c) => c.name === params.time) : dataset.numeric[0];
  const status = params.status ? dataset.columns.find((c) => c.name === params.status) : dataset.numeric[1];
  if (!time?.values.length || !status?.values.length) return null;
  const strat = params.stratifyBy ? dataset.columns.find((c) => c.name === params.stratifyBy) : undefined;
  const rows = time.rows.filter((r) => status.byRow[r] != null && (!strat || strat.byRow[r] != null));
  if (!rows.length) return null;
  const groups = strat ? [...new Set(rows.map((r) => strat.byRow[r]!))] : [null];
  const columns = [
    "Title",
    time.name,
    ...groups.map((g) => (strat ? `${strat.name} = ${num(g)}` : "All subjects")),
  ];
  const tableRows = rows.map((r) => [
    null,
    String(time.byRow[r]),
    ...groups.map((g) => (g === null || strat!.byRow[r] === g ? String(status.byRow[r]) : null)),
  ]);
  return readTable({ columns, rows: tableRows }).columns;
}
