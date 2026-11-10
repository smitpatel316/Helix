// Binding curve overlay: evaluates the fitted saturation / kinetics
// equation (computed by a "Binding — Saturation" or "Binding — Kinetics"
// analysis via WebR nls()) at evenly spaced X points for plotting — no
// re-fitting here, just the closed form applied to the returned
// coefficients. Follows dose-response-curve.ts exactly: the graph reads the
// cached runAnalysis result, as addDoseCurve does.
import type { GraphOptions } from "../../store/types";
import type {
  AnalysisResult,
  BindingKineticsModel,
  BindingKineticsParams,
  BindingSaturationModel,
  BindingSaturationParams,
  RegressionCoefficient,
  StatRow,
} from "../../stats/types";
import { evaluateBindingModel, isTwoSeriesSaturation } from "../../stats/xy/binding";
import { pairUp, type Column } from "../../lib/dataset";
import type { GraphFigure } from ".";
import { num } from "../../lib/format";
import { addNote, extent, type Paint } from "./plot-helpers";

type BindingModel = BindingSaturationModel | BindingKineticsModel;
type BindingParams = BindingSaturationParams | BindingKineticsParams;

function coef(coefficients: RegressionCoefficient[], term: string): number {
  return coefficients.find((c) => c.term === term)?.estimate ?? NaN;
}

function stat(stats: StatRow[], label: string): number | null | undefined {
  return stats.find((s) => s.label === label)?.value;
}

/** Evenly-spaced points across [xMin, xMax] tracing the fitted curve. */
function fittedCurve(
  model: BindingModel,
  coefficients: RegressionCoefficient[],
  xMin: number,
  xMax: number,
  series: "total" | "nonspecific" = "total",
  atd?: { hotNM: number; time0: number },
  steps = 100,
): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const x0 = xMin + ((xMax - xMin) * i) / steps;
    x.push(x0);
    y.push(evaluateBindingModel(model, coefficients, x0, series, atd));
  }
  return { x, y };
}

/** "Bmax = 100<br>Kd = 5<br>R² = 1" annotation text (Plotly-ready) — the
 *  fitted constants, the half-life / residence time for kinetics, and R²
 *  (the total series' for a two-series fit). */
function bindingLabel(
  model: BindingModel,
  coefficients: RegressionCoefficient[],
  stats: StatRow[],
): string {
  const r2 = stat(stats, "R squared (total)") ?? stat(stats, "R squared");
  const lines: string[] = [];
  switch (model) {
    case "one-site-total":
    case "one-site-total-and-ns":
      lines.push(`Bmax = ${num(coef(coefficients, "Bmax"))}`, `Kd = ${num(coef(coefficients, "Kd"))}`);
      lines.push(`NS = ${num(coef(coefficients, "NS"))}`, `Background = ${num(coef(coefficients, "Background"))}`);
      break;
    case "two-site-specific":
    case "two-site-total-and-ns":
      lines.push(
        `BmaxHi = ${num(coef(coefficients, "BmaxHi"))}`,
        `KdHi = ${num(coef(coefficients, "KdHi"))}`,
        `BmaxLo = ${num(coef(coefficients, "BmaxLo"))}`,
        `KdLo = ${num(coef(coefficients, "KdLo"))}`,
      );
      if (model === "two-site-total-and-ns")
        lines.push(`NS = ${num(coef(coefficients, "NS"))}`, `Background = ${num(coef(coefficients, "Background"))}`);
      break;
    case "association-one-phase":
      lines.push(`Kobs = ${num(coef(coefficients, "Kobs"))}`, `Half-life = ${num(stat(stats, "Half-life"))}`);
      break;
    case "dissociation-one-phase":
      lines.push(
        `Koff = ${num(coef(coefficients, "Koff"))}`,
        `Half-life = ${num(stat(stats, "Half-life"))}`,
        `Residence time = ${num(stat(stats, "Residence time"))}`,
      );
      break;
    case "association-two-phase":
    case "dissociation-two-phase":
      lines.push(
        `KFast = ${num(coef(coefficients, "KFast"))}`,
        `KSlow = ${num(coef(coefficients, "KSlow"))}`,
        `Half-life (fast) = ${num(stat(stats, "Half-life (fast)"))}`,
        `Half-life (slow) = ${num(stat(stats, "Half-life (slow)"))}`,
      );
      break;
    case "association-then-dissociation":
      lines.push(
        `Kon = ${num(coef(coefficients, "Kon"))}`,
        `Koff = ${num(coef(coefficients, "Koff"))}`,
        `Kinetic Kd = ${num(stat(stats, "Kinetic Kd (nM)"))} nM`,
      );
      break;
  }
  if (r2 != null) lines.push(`R² = ${num(r2)}`);
  return lines.join("<br>");
}

/** Draws the fitted curve (and its fit-summary note) of the chosen Y series
 *  (`columns` = X, then the Y series), under the points. Two-series
 *  saturation fits draw both curves: total in the series colour,
 *  nonspecific as a dashed line in the second series' colour. Kinetics
 *  curves start at Y0 — X is time, nothing is forced through the origin. */
export function addBindingCurve(
  fig: GraphFigure,
  columns: Column[],
  options: GraphOptions,
  fit: AnalysisResult,
  params: BindingParams,
  paint: Paint,
) {
  const [x, ...ys] = columns;
  const model = params.model as BindingModel;
  const y = ys.find((c) => c.name === params.y) ?? ys[0];
  const coefficients = fit.coefficients ?? [];
  if (!x || !y || !coefficients.length) return;
  const pairs = pairUp(x, y);
  const xs = pairs.x;
  if (!xs.length) return;
  const atd =
    model === "association-then-dissociation"
      ? {
          hotNM: (params as BindingKineticsParams).hotNM ?? NaN,
          time0: (params as BindingKineticsParams).time0 ?? NaN,
        }
      : undefined;
  const [xMin, xMax] = extent(xs);
  const curve = fittedCurve(model, coefficients, xMin, xMax, "total", atd);
  const color = paint.color(y.name, ys.indexOf(y));
  const traces: GraphFigure["data"] = [
    {
      type: "scatter",
      mode: "lines",
      x: curve.x,
      y: curve.y,
      line: { color, width: 1.5 },
      hoverinfo: "skip",
      showlegend: false,
    },
  ];
  // The nonspecific branch of a two-series fit, dashed in its own colour.
  if (isTwoSeriesSaturation(model as BindingSaturationModel) && "y2" in params) {
    const y2 = ys.find((c) => c.name === (params as BindingSaturationParams).y2) ?? ys[1];
    if (y2) {
      const nsCurve = fittedCurve(model, coefficients, xMin, xMax, "nonspecific", atd);
      traces.push({
        type: "scatter",
        mode: "lines",
        x: nsCurve.x,
        y: nsCurve.y,
        line: { color: paint.color(y2.name, ys.indexOf(y2)), width: 1.5, dash: "dash" },
        hoverinfo: "skip",
        showlegend: false,
      });
    }
  }
  fig.data = [...traces, ...fig.data];
  addNote(fig, bindingLabel(model, coefficients, fit.stats), options);
}
