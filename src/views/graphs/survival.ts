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
import { addNote, xyLayout, type Paint } from "./plot-helpers";
import { withOpacity } from "../../lib/palettes";
import { kaplanMeier } from "../../lib/kaplan-meier";

// Re-exported for existing importers (tests/reference.ts): the lib
// version returns the same steps plus the 95% band (lower/upper).
export { kaplanMeier };

/** "counts" mode: cells are survivors remaining, plotted directly as percent-of-initial.
 *  Returns null when the initial count (at the earliest time) is not a positive
 *  number: percent survival is undefined with no starting population, and the
 *  old `|| 1` fallback divided by 1 instead, so a later nonzero count plotted
 *  above 100% as fact. Percentages are clamped to [0, 100]; `clamped` says a
 *  count fell outside [0, initial] (a later count above the initial, or a
 *  negative count) so the caller can say so on the figure. */
function survivorCountsStep(x: number[], counts: number[]): { t: number[]; s: number[]; clamped: boolean } | null {
  const order = x.map((_, i) => i).sort((a, b) => x[a] - x[b]);
  const initial = counts[order[0]];
  if (!Number.isFinite(initial) || initial <= 0) return null;
  let clamped = false;
  const s = order.map((i) => {
    const pct = (counts[i] / initial) * 100;
    const c = Math.min(100, Math.max(0, pct));
    if (c !== pct) clamped = true;
    return c;
  });
  return { t: order.map((i) => x[i]), s, clamped };
}

function build(columns: Column[], options: GraphOptions, paint: Paint): GraphFigure {
  const [xCol, ...ySeries] = columns;
  const layout = xyLayout(options, xCol?.name ?? "Time", ySeries.length, { zeroBase: true, yName: "Percent survival", seriesNames: ySeries.map((y) => y.name) });
  if (!xCol || ySeries.length === 0) return { data: [], layout };

  const byCodes = options.survivalMode !== "counts";
  // Counts mode: a group with no starting population has no curve, and a
  // count outside [0, initial] is clamped to 0–100% — both named on the
  // figure, so no group is silently dropped or silently re-scaled.
  const omitted: string[] = [];
  const clampedGroups: string[] = [];
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
      const step = survivorCountsStep(x, values);
      if (!step) {
        omitted.push(y.name);
        return [];
      }
      if (step.clamped) clampedGroups.push(y.name);
      const { t, s } = step;
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
  const fig: GraphFigure = { data, layout: { ...layout, legend: { ...(layout.legend as object), traceorder: "normal" } } };
  const notes: string[] = [];
  if (omitted.length)
    notes.push(`${omitted.map((n) => `“${n}”`).join(", ")} omitted: the initial count is 0, so percent survival is undefined.`);
  if (clampedGroups.length)
    notes.push(
      `${clampedGroups.map((n) => `“${n}”`).join(", ")} clamped to 0–100%: a count fell outside 0 and the initial count.`,
    );
  if (notes.length) addNote(fig, notes.join(" "), options);
  return fig;
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
