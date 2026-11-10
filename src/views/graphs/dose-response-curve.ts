// Dose-response curve overlay: evaluates the sigmoidal 4PL fit (computed by the
// "Nonlinear regression" analysis via WebR nls()) at evenly spaced X points for
// plotting — no re-fitting here, just the closed-form 4PL equation applied to the
// returned coefficients.
import type { GraphOptions } from "../../store/types";
import type { AnalysisResult, RegressionCoefficient, StatRow } from "../../stats/types";
import { EXPONENTIAL_MODELS } from "../../stats/xy/nonlinear-fit";
import { pairUp, type Column } from "../../lib/dataset";
import type { GraphFigure } from ".";
import { num } from "../../lib/format";
import { addNote, extent, type Paint } from "./plot-helpers";

type DoseModel = GraphOptions["doseModel"];

function coef(coefficients: RegressionCoefficient[], term: string): number {
  return coefficients.find((c) => c.term === term)?.estimate ?? NaN;
}

/** The fitted curve's value at X, from the fit's coefficients — the same
 *  closed form R fitted (see modelSpec in stats/xy/nonlinear-fit.ts), so the
 *  overlay and the analysis can never disagree. Exported for the reference
 *  tests, which check it against an independent R evaluation. */
export function evaluateFittedCurve(model: DoseModel, coefficients: RegressionCoefficient[], x: number): number {
  switch (model) {
    case "sigmoidal-4pl-logx": {
      const bottom = coef(coefficients, "Bottom");
      const top = coef(coefficients, "Top");
      const hill = coef(coefficients, "HillSlope");
      return bottom + (top - bottom) / (1 + 10 ** ((coef(coefficients, "LogEC50") - x) * hill));
    }
    case "sigmoidal-4pl-x": {
      const bottom = coef(coefficients, "Bottom");
      const top = coef(coefficients, "Top");
      const hill = coef(coefficients, "HillSlope");
      return bottom + (top - bottom) / (1 + (coef(coefficients, "EC50") / x) ** hill);
    }
    case "one-phase-decay":
      return (
        (coef(coefficients, "Y0") - coef(coefficients, "Plateau")) * Math.exp(-coef(coefficients, "K") * x) +
        coef(coefficients, "Plateau")
      );
    case "two-phase-decay":
      return (
        coef(coefficients, "Plateau") +
        coef(coefficients, "Span1") * Math.exp(-coef(coefficients, "K1") * x) +
        coef(coefficients, "Span2") * Math.exp(-coef(coefficients, "K2") * x)
      );
    case "plateau-decay":
      return x < coef(coefficients, "X0")
        ? coef(coefficients, "Y0")
        : coef(coefficients, "Plateau") +
            (coef(coefficients, "Y0") - coef(coefficients, "Plateau")) *
              Math.exp(-coef(coefficients, "K") * (x - coef(coefficients, "X0")));
    case "one-phase-association":
      return (
        coef(coefficients, "Y0") +
        (coef(coefficients, "Plateau") - coef(coefficients, "Y0")) * (1 - Math.exp(-coef(coefficients, "K") * x))
      );
    case "exponential-growth":
      return coef(coefficients, "Y0") * Math.exp(coef(coefficients, "K") * x);
  }
}

/** Evenly-spaced points across [xMin, xMax] tracing the fitted curve. */
function fittedCurve(
  model: DoseModel,
  coefficients: RegressionCoefficient[],
  xMin: number,
  xMax: number,
  steps = 100,
): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const x0 = xMin + ((xMax - xMin) * i) / steps;
    x.push(x0);
    y.push(evaluateFittedCurve(model, coefficients, x0));
  }
  return { x, y };
}

function stat(stats: StatRow[], label: string): number | null | undefined {
  return stats.find((s) => s.label === label)?.value;
}

/** "EC50 = 12.3<br>Hill slope = 1.05<br>R² = 0.9821" annotation text (Plotly-ready)
 *  — for the exponential models, the half-life / doubling time instead. */
function doseResponseLabel(model: DoseModel, coefficients: RegressionCoefficient[], stats: StatRow[]): string {
  const r2 = stat(stats, "R squared");
  const lines: string[] = [];
  if (model === "sigmoidal-4pl-logx" || model === "sigmoidal-4pl-x") {
    const ec50 = model === "sigmoidal-4pl-logx" ? 10 ** coef(coefficients, "LogEC50") : coef(coefficients, "EC50");
    lines.push(`EC50 = ${num(ec50)}`, `Hill slope = ${num(coef(coefficients, "HillSlope"))}`);
  } else if (model === "two-phase-decay") {
    lines.push(`Half-life (fast) = ${num(stat(stats, "Half-life (fast)"))}`);
    lines.push(`Half-life (slow) = ${num(stat(stats, "Half-life (slow)"))}`);
  } else if (model === "exponential-growth") {
    lines.push(`Doubling time = ${num(stat(stats, "Doubling time"))}`);
  } else if ((EXPONENTIAL_MODELS as readonly string[]).includes(model)) {
    lines.push(`Half-life = ${num(stat(stats, "Half-life"))}`);
  }
  if (r2 != null) lines.push(`R² = ${num(r2)}`);
  return lines.join("<br>");
}

/** Draws the fitted curve (and its fit-summary note) of the chosen Y series
 *  (`columns` = X, then the Y series), under the points. When `interp` is a
 *  standard-curve-interpolation result for the same model and Y series, each
 *  interpolated unknown also gets its drop-lines: a horizontal dashed line at
 *  Y = unknown from the Y axis to the curve, a vertical dashed line down to
 *  the interpolated X, and a marker at the curve point. */
export function addDoseCurve(
  fig: GraphFigure,
  columns: Column[],
  options: GraphOptions,
  fit: AnalysisResult,
  paint: Paint,
  interp?: AnalysisResult | null,
) {
  const [x, ...ys] = columns;
  const y = ys.find((c) => c.name === options.doseY) ?? ys[0];
  const coefficients = fit.coefficients ?? [];
  if (!x || !y || !coefficients.length || !options.doseShowCurve) return;
  const pairs = pairUp(x, y);
  const xs = pairs.x;
  if (!xs.length) return;
  const curve = fittedCurve(options.doseModel, coefficients, ...extent(xs));
  fig.data = [
    {
      type: "scatter",
      mode: "lines",
      x: curve.x,
      y: curve.y,
      line: { color: paint.color(y.name, ys.indexOf(y)), width: 1.5 },
      hoverinfo: "skip",
      showlegend: false,
    },
    ...fig.data,
  ];
  if (options.doseShowEquation) addNote(fig, doseResponseLabel(options.doseModel, coefficients, fit.stats), options);
  // Drop-lines only make sense on the curve they were interpolated from.
  if (
    interp?.interpolations?.length &&
    interp.subtitle === fit.subtitle &&
    interp.groups[1]?.name === fit.groups[1]?.name
  ) {
    const [xMin] = extent(xs);
    const yMin = Math.min(...pairs.y, ...curve.y);
    const color = paint.color(y.name, ys.indexOf(y));
    const rows = interp.interpolations.filter((r) => r.x != null);
    for (const r of rows) {
      fig.data = [
        ...fig.data,
        {
          type: "scatter",
          mode: "lines",
          x: [xMin, r.x],
          y: [r.unknownY, r.unknownY],
          line: { color, width: 1, dash: "dash" },
          hoverinfo: "skip",
          showlegend: false,
        },
        {
          type: "scatter",
          mode: "lines",
          x: [r.x, r.x],
          y: [yMin, r.unknownY],
          line: { color, width: 1, dash: "dash" },
          hoverinfo: "skip",
          showlegend: false,
        },
      ];
    }
    if (rows.length)
      fig.data = [
        ...fig.data,
        {
          type: "scatter",
          mode: "markers",
          x: rows.map((r) => r.x),
          y: rows.map((r) => r.unknownY),
          marker: { color, size: 7, symbol: "circle-open" },
          hoverinfo: "skip",
          showlegend: false,
        },
      ];
  }
}
