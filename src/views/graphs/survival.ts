// "Survival curve" (XY table): X is time, each Y series is a group. Two modes
// (options.survivalMode):
// - "codes": cells are per-subject event codes (1 = event, 0 = censored) at that
//   time; Kaplan-Meier estimator (lib/kaplan-meier.ts, shared with the Survival analysis),
//   computed in plain JS (closed-form, no WebR round-trip needed).
// - "counts": cells are the number of survivors remaining in that group at that
//   time; plotted directly as percent-of-initial, no event/censor concept.
import type { GraphOptions } from "../../store/types";
import type { GraphModule, GraphFigure } from ".";
import { pairUp, type Column } from "../../lib/dataset";
import { xyLayout, type Paint } from "./plot-helpers";
import { withOpacity } from "../../lib/palettes";
import { kaplanMeier } from "../../lib/kaplan-meier";

// Re-exported for existing importers (src/stats/survival/log-rank.ts): the lib
// version returns the same steps plus the 95% band (lower/upper).
export { kaplanMeier };

// Our pre-rebase inline Kaplan-Meier, preserved verbatim at rebase time (renamed
// so it doesn't collide with the lib import above). Same steps as the lib version,
// no confidence band. The dedup commit decides whether it goes away.
interface KaplanMeierLegacy {
  t: number[]; // step vertices (t[0] = 0, s[0] = 1)
  s: number[];
  censorT: number[]; // tick marks: subjects censored without an event
  censorS: number[];
}

export function kaplanMeierLegacy(times: number[], codes: number[]): KaplanMeierLegacy {
  const order = times.map((_, i) => i).sort((a, b) => times[a] - times[b]);
  const t = [0];
  const s = [1];
  const censorT: number[] = [];
  const censorS: number[] = [];
  let atRisk = times.length;
  let survival = 1;
  let i = 0;
  while (i < order.length) {
    const time = times[order[i]];
    let events = 0;
    let censored = 0;
    while (i < order.length && times[order[i]] === time) {
      if (codes[order[i]] === 1) events++;
      else censored++;
      i++;
    }
    if (events > 0) {
      survival *= 1 - events / atRisk;
      t.push(time);
      s.push(survival);
    }
    if (censored > 0) {
      censorT.push(time);
      censorS.push(survival);
    }
    atRisk -= events + censored;
  }
  // The curve runs on to the last subject followed, as Prism draws it.
  const last = times[order.at(-1)!];
  if (last > t.at(-1)!) {
    t.push(last);
    s.push(survival);
  }
  return { t, s, censorT, censorS };
}

/** "counts" mode: cells are survivors remaining, plotted directly as percent-of-initial. */
function survivorCountsStep(x: number[], counts: number[]): { t: number[]; s: number[] } {
  const order = x.map((_, i) => i).sort((a, b) => x[a] - x[b]);
  const initial = counts[order[0]] || 1;
  return { t: order.map((i) => x[i]), s: order.map((i) => (counts[i] / initial) * 100) };
}

function build(columns: Column[], options: GraphOptions, paint: Paint): GraphFigure {
  const [xCol, ...ySeries] = columns;
  const layout = xyLayout(options, xCol?.name ?? "Time", ySeries.length, { zeroBase: true, yName: "Percent survival" });
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
