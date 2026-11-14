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
import { addNote, INK, marginsFor, textWidth, xyLayout, type Paint } from "./plot-helpers";
import { withOpacity } from "../../lib/palettes";
import { kaplanMeier, type KaplanMeier } from "../../lib/kaplan-meier";

// Re-exported for existing importers (tests/reference.ts): the lib
// version returns the same steps plus the 95% band (lower/upper).
export { kaplanMeier };

/** "counts" mode: cells are survivors remaining, plotted directly as percent-of-initial.
 *  Returns null when the initial count (at the earliest time) is not a positive
 *  number: percent survival is undefined with no starting population, and the
 *  old `|| 1` fallback divided by 1 instead, so a later nonzero count plotted
 *  above 100% as fact. Percentages are clamped to [0, 100]; `clamped` says a
 *  count fell outside [0, initial] (a later count above the initial, or a
 *  negative count) so the caller can say so on the figure. `counts` is the raw
 *  counts in time order — the Number at Risk table's values for this group. */
function survivorCountsStep(
  x: number[],
  counts: number[],
): { t: number[]; s: number[]; clamped: boolean; counts: number[] } | null {
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
  return { t: order.map((i) => x[i]), s, clamped, counts: order.map((i) => counts[i]) };
}

/** A "nice" step for the at-risk table's ticks: the smallest 1/2/5 (×10ᵏ) step
 *  at or above `raw`, so the table has at most ~6 columns. */
function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

/** The X-axis major ticks the Number at Risk table tabulates at: "nice" steps
 *  over [lo, hi], or the user's own step when one is set. Values are rounded to
 *  kill float noise (0.30000000000000004). Always at least one tick. */
export function atRiskTicks(lo: number, hi: number, step?: number): number[] {
  const s = step ?? niceStep(Math.max(hi - lo, 0) / 5 || 1);
  if (!(s > 0) || !Number.isFinite(s)) return [lo];
  const clean = (v: number) => Number(v.toPrecision(12));
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / s - 1e-9) * s; v <= hi + 1e-9; v += s) ticks.push(clean(v));
  return ticks.length ? ticks : [clean(lo)];
}

/** Subjects at risk at time `t` from a Kaplan-Meier run: the at-risk count at
 *  the first step at or after `t` — subjects whose time is ≥ `t` are still
 *  under observation at `t`, including one whose event falls exactly on `t`;
 *  the count at the last step at or before `t` would still hold that subject
 *  (it counts the risk BEFORE that step's events are removed). 0 past the last
 *  subject followed. */
function atRiskAt(km: KaplanMeier, t: number): number {
  const k = km.riskT.findIndex((rt) => rt >= t);
  return k === -1 ? 0 : km.risk[k];
}

/** Survivors remaining at time `t` in "counts" mode: the count at the latest
 *  step time at or before `t` — the initial count before the first step. */
function countsAt(t: number[], counts: number[], at: number): number {
  let v = counts[0];
  for (let k = 0; k < t.length; k++) {
    if (t[k] <= at) v = counts[k];
    else break;
  }
  return v;
}

/** One table row: its label, its group's color, and its count at each tick. */
interface AtRiskRow {
  label: string;
  color: string;
  values: number[];
}

/** The Number at Risk table under the curve (Prism 10.5): one row per group of
 *  subjects at risk at each X-axis major tick, plus a cumulative-censored row
 *  for a group that has any (codes mode only). Drawn as annotations — counts at
 *  the tick's X (`xref: "x"`), labels right-anchored in a widened left margin —
 *  with the bottom margin grown to fit, so the rows sit below the axis title.
 *  The ticks are set explicitly on the X axis, so the columns ARE the major
 *  ticks. `showarrow: false` throughout: the view only lets arrowed texts be
 *  dragged, so the table stays put. */
function addAtRiskTable(
  fig: GraphFigure,
  groups: { name: string; color: string; atRisk: (t: number) => number; censored?: (t: number) => number }[],
  ticks: number[],
  options: GraphOptions,
): void {
  const rows: AtRiskRow[] = groups.flatMap((g) => [
    { label: g.name, color: g.color, values: ticks.map((t) => g.atRisk(t)) },
    ...(g.censored
      ? [{ label: `${g.name} censored`, color: g.color, values: ticks.map((t) => g.censored!(t)) }]
      : []),
  ]);
  if (!rows.length) return;
  const fs = options.fontSize;
  const width = options.width || 640;
  const height = options.height || 460;
  const labels = ["Number at risk", ...rows.map((r) => r.label)];
  const rowH = fs + 6;
  const nRows = 1 + rows.length;
  const tablePx = nRows * rowH;
  const bottomPad = 8;
  const gap = 10;
  const tickArea = fs + 8; // the X tick labels
  const titleArea = fs + options.xTitleGap; // the X-axis title (always present: label or column name)
  const margin = (fig.layout.margin as Record<string, number> | undefined) ?? marginsFor(options);
  const labelW = Math.max(...labels.map((l) => textWidth(l, fs)));
  const marginL = Math.max(margin.l ?? 16, 16 + labelW + 8);
  const marginB = bottomPad + tablePx + gap + titleArea + tickArea;
  fig.layout.margin = { ...margin, l: marginL, b: Math.max(margin.b ?? 16, marginB) };
  const xaxis = fig.layout.xaxis as Record<string, unknown>;
  xaxis.tickmode = "array";
  xaxis.tickvals = ticks;
  xaxis.ticktext = ticks.map((t) => num(t));
  // Rows are laid out from the figure's bottom up: bottom pad, then the table
  // (title first), then a gap, the axis title, and the tick labels to the plot.
  const labelX = (marginL - 8) / width;
  const rowY = (i: number) => (bottomPad + (nRows - i - 0.5) * rowH) / height;
  const font = { color: INK, size: fs };
  const annotations: unknown[] = [
    {
      xref: "paper",
      yref: "paper",
      x: labelX,
      y: rowY(0),
      xanchor: "right",
      yanchor: "middle",
      text: "<b>Number at risk</b>",
      showarrow: false,
      font,
    },
  ];
  rows.forEach((row, k) => {
    const y = rowY(k + 1);
    annotations.push({
      xref: "paper",
      yref: "paper",
      x: labelX,
      y,
      xanchor: "right",
      yanchor: "middle",
      text: row.label,
      showarrow: false,
      font,
    });
    ticks.forEach((tick, j) => {
      annotations.push({
        xref: "x",
        yref: "paper",
        x: tick,
        y,
        xanchor: "center",
        yanchor: "middle",
        text: String(row.values[j]),
        showarrow: false,
        font: { color: row.color, size: fs },
      });
    });
  });
  fig.layout.annotations = [...((fig.layout.annotations as unknown[]) ?? []), ...annotations];
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
  // The Number at Risk table reads the same numbers the curves drew: each
  // group's at-risk count at a tick, and its cumulative censored (codes mode).
  const tableGroups: {
    name: string;
    color: string;
    atRisk: (t: number) => number;
    censored?: (t: number) => number;
  }[] = [];
  let maxTime = 0;
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
      for (const v of t) if (v > maxTime) maxTime = v;
      tableGroups.push({ name: y.name, color, atRisk: (at) => countsAt(step.t, step.counts, at) });
      return [{ ...steps(t, s, paint.line(y.name, i)), name: y.name, hoverinfo: "x+y", showlegend: true }];
    }
    // R2-G-F16: no complete pairs means no data for this group — skip it.
    // kaplanMeier([], []) returns its (0, 100%) anchor, which would draw a
    // fabricated point for a group with no subjects at all.
    if (x.length === 0) return [];
    const km = kaplanMeier(x, values);
    for (const v of x) if (v > maxTime) maxTime = v;
    tableGroups.push({
      name: y.name,
      color,
      atRisk: (at) => atRiskAt(km, at),
      ...(km.censorT.length ? { censored: (at: number) => km.censorT.filter((c) => c < at).length } : {}),
    });
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
  // The Number at Risk table under the curve, at the X-axis major ticks. A log
  // time axis has no linear nice ticks, so the table stays off there.
  if (options.survivalShowAtRisk && tableGroups.length && options.xScale === "linear") {
    const lo = options.xMin ?? 0;
    const hi = options.xMax ?? maxTime;
    if (hi >= lo) addAtRiskTable(fig, tableGroups, atRiskTicks(lo, hi, options.xStep), options);
  }
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
