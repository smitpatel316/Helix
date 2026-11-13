// A fitted curve drawn over an XY graph's points: the "Nonlinear regression" analysis's
// coefficients (computed by R's nls() or lm()) put in the model's equation at evenly spaced X,
// no re-fitting here: an XY scatter draws the curve of a nonlinear regression of its table.
import type { GraphOptions } from "../../store/types";
import type { AnalysisResult, NonlinearModel, RegressionCoefficient } from "../../stats/types";
import { nonNegativeXOnly, positiveXOnly, coefficientsForSet, termLabel } from "../../stats/xy/nonlinear-regression";
import { xyPoints, type Column, type DataSet } from "../../lib/dataset";
import type { GraphFigure } from ".";
import { num } from "../../lib/format";
import { addNote, curveXs, extent, type Paint } from "./plot-helpers";

function coef(coefficients: RegressionCoefficient[], term: string): number {
  return coefficients.find((c) => c.term === term)?.estimate ?? NaN;
}

/** The fitted curve at `x`: the model's equation (nonlinear-regression.ts) with its coefficients.
 *  The homologous model also needs the radioligand concentration [L] (its
 *  fit carries it — see AnalysisResult.ligandConcentration); without it the
 *  curve is undefined (NaN). */
export function evaluate(
  model: NonlinearModel,
  coefficients: RegressionCoefficient[],
  x: number,
  ligandConcentration?: number,
): number {
  const c = (term: string) => coef(coefficients, termLabel(term));
  const [bottom, top, hill, s] = [c("Bottom"), c("Top"), c("HillSlope"), c("S")];
  const rise = top - bottom;
  switch (model) {
    case "sigmoidal-4pl-logx":
      return bottom + rise / (1 + 10 ** ((c("LogEC50") - x) * hill));
    case "sigmoidal-4pl-x":
      return bottom + rise / (1 + (c("EC50") / x) ** hill);
    case "agonist-3pl-logx":
      return bottom + rise / (1 + 10 ** (c("LogEC50") - x));
    case "inhibitor-3pl-logx":
      return bottom + rise / (1 + 10 ** (x - c("LogIC50")));
    case "asymmetric-5pl-logx":
      return bottom + rise / (1 + 10 ** ((c("LogEC50") + Math.log10(2 ** (1 / s) - 1) / hill - x) * hill)) ** s;
    case "asymmetric-5pl-x":
      return bottom + rise / (1 + ((c("EC50") * (2 ** (1 / s) - 1) ** (1 / hill)) / x) ** hill) ** s;
    case "line":
      return c("Intercept") + c("Slope") * x;
    case "semilog-line":
      return c("Intercept") + c("Slope") * Math.log(x);
    case "hyperbola":
      return (c("Bmax") * x) / (c("Kd") + x);
    case "quadratic":
      return c("B0") + c("B1") * x + c("B2") * x ** 2;
    case "cubic":
      return c("B0") + c("B1") * x + c("B2") * x ** 2 + c("B3") * x ** 3;
    case "quartic":
      // Plan 29: the polynomial evaluator generalises by degree.
      return c("B0") + c("B1") * x + c("B2") * x ** 2 + c("B3") * x ** 3 + c("B4") * x ** 4;
    case "quintic":
      return (
        c("B0") + c("B1") * x + c("B2") * x ** 2 + c("B3") * x ** 3 + c("B4") * x ** 4 + c("B5") * x ** 5
      );
    case "segmental-linear":
      // Plan 29: the continuous hinge (X0 is the coefficient row the
      // runner appends for the profiled breakpoint) — one unbroken line,
      // never two disjoint segments.
      return c("B0") + c("B1") * x + c("B2") * Math.max(x - c("X0"), 0);
    case "exponential-growth":
      return c("Y0") * Math.exp(c("K") * x);
    case "one-phase-decay":
      return (c("Y0") - c("Plateau")) * Math.exp(-c("K") * x) + c("Plateau");
    case "two-phase-decay":
      return c("Plateau") + c("Span1") * Math.exp(-c("K1") * x) + c("Span2") * Math.exp(-c("K2") * x);
    case "plateau-decay":
      return x < c("X0")
        ? c("Y0")
        : c("Plateau") + (c("Y0") - c("Plateau")) * Math.exp(-c("K") * (x - c("X0")));
    case "one-phase-association":
      return c("Y0") + (c("Plateau") - c("Y0")) * (1 - Math.exp(-c("K") * x));
    case "michaelis-menten":
      return (c("Vmax") * x) / (c("Km") + x);
    case "allosteric-sigmoidal":
      return (c("Vmax") * x ** c("HillSlope")) / (c("Khalf") ** c("HillSlope") + x ** c("HillSlope"));
    case "substrate-inhibition":
      return (c("Vmax") * x) / (c("Km") + x + x ** 2 / c("Ki"));
    // Binding competition (plan 28): both Hill slopes fixed at −1 (Prism's
    // built-in two-site model — see modelSpec in stats/xy/nonlinear-fit.ts).
    case "two-site-competition-logx": {
      const frac = c("FractionHi");
      return (
        bottom +
        rise * (frac / (1 + 10 ** (x - c("LogIC50Hi"))) + (1 - frac) / (1 + 10 ** (x - c("LogIC50Lo"))))
      );
    }
    case "two-site-competition-x": {
      const frac = c("FractionHi");
      return bottom + rise * (frac / (1 + x / c("IC50Hi")) + (1 - frac) / (1 + x / c("IC50Lo")));
    }
    case "homologous-competition-logx": {
      const l = ligandConcentration ?? NaN;
      return (c("Bmax") * l) / (l + 10 ** x + 10 ** c("LogKd")) + c("Bottom");
    }
  }
}

/** Evenly-spaced points across [xMin, xMax] tracing the fitted curve. */
function fittedCurve(
  model: NonlinearModel,
  coefficients: RegressionCoefficient[],
  xMin: number,
  xMax: number,
  steps = 100,
  ligandConcentration?: number,
): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const x0 = xMin + ((xMax - xMin) * i) / steps;
    x.push(x0);
    y.push(evaluate(model, coefficients, x0, ligandConcentration));
  }
  return { x, y };
}

/** The X values a fitted curve draws over: log-X curves need X > 0, raw
 *  ratio curves need X ≥ 0 (X = 0 is their Bottom), everything else any X. */
const keepCurveX = (model: NonlinearModel, v: number) =>
  positiveXOnly(model) ? v > 0 : nonNegativeXOnly(model) ? v >= 0 : true;

/** A data set's lines of a fit's note, as the analysis reports them: its derived values (an
 *  EC50, a half-life…, not a Span), then the coefficients they don't already say (a
 *  dose-response's Bottom, Top and log midpoint), then R². `set`: its column in the fit,
 *  `coefficients` its own. (Upstream 1.0.9.) */
function curveLines(fit: AnalysisResult, set: number, coefficients: RegressionCoefficient[]): string[] {
  const rows = fit.fit?.rows ?? [];
  const derived = rows.filter(
    (r) => r.values && r.label !== "Span" && rows.indexOf(r) < rows.findIndex((x) => x.label === "R squared"),
  );
  const said = new Set(["Bottom", "Top", "LogEC50", "LogIC50"]);
  const lines = [
    ...derived.map((r) => `${r.label} = ${num(r.values![set])}`),
    ...coefficients.filter((c) => !said.has(c.term)).map((c) => `${c.term} = ${num(c.estimate)}`),
  ];
  const r2 = rows.find((r) => r.label === "R squared")?.values?.[set];
  if (r2 != null) lines.push(`R² = ${num(r2)}`);
  return lines;
}

/** "EC50 = 12.3<br>Hill slope = 1.05<br>R² = 0.9821" annotation text (Plotly-ready), as the
 *  analysis reports them: one data set's lines, from curveLines. */
function curveLabel(fit: AnalysisResult): string {
  return curveLines(fit, 0, fit.coefficients ?? []).join("<br>");
}

/** Draws `model`'s fitted curve of each data set fitted (`fitted`, by name) against `x`
 *  under the points, in its color (`ys`, the graph's Y series, places it in the palette),
 *  and their note when `note`: one data set's values one per line, several's one line
 *  each, after its name. (Upstream 1.0.9, with our fittedCurve's grid; the ROUT
 *  hollow-out is skipped — our fits carry no curveOutliers until the ROUT-in-fit
 *  follow-up lands, so it would be the identity. The multi-Y reference check
 *  drives this; the app's scatter uses addFittedCurve for the same curves.) */
export function addFittedCurves(
  fig: GraphFigure,
  x: Column,
  fitted: string[],
  ys: DataSet[],
  model: NonlinearModel,
  fit: AnalysisResult,
  note: boolean,
  options: GraphOptions,
  paint: Paint,
) {
  const all = fit.coefficients ?? [];
  const many = fitted.length > 1;
  const notes: string[] = [];
  const curves = fitted.flatMap((name, i) => {
    const y = ys.find((s) => s.name === name);
    // Several data sets' coefficients are named after each ("A — Top").
    const coefficients = many
      ? all.filter((c) => c.term.startsWith(`${name} — `)).map((c) => ({ ...c, term: c.term.slice(name.length + 3) }))
      : all;
    const xs = y ? xyPoints(x, y).x.filter((v) => keepCurveX(model, v)) : [];
    if (!y || !xs.length || !coefficients.some((c) => c.estimate != null)) return [];
    const lines = curveLines(fit, i, coefficients);
    notes.push(many ? `${name}: ${lines.join(", ")}` : lines.join("<br>"));
    const curve = fittedCurve(model, coefficients, ...extent(xs), 100, fit.ligandConcentration);
    return [
      {
        type: "scatter",
        mode: "lines",
        x: curve.x,
        y: curve.y,
        line: { color: paint.color(y.name, ys.indexOf(y)), width: 1.5 },
        hoverinfo: "skip",
        showlegend: false,
      },
    ];
  });
  if (!curves.length) return;
  fig.data = [...curves, ...fig.data];
  if (note) addNote(fig, notes.join("<br>"), options);
}

/** Draws `model`'s fitted curve of `y` against `x` under the points, in `y`'s color (`ys`,
 *  the graph's Y series, places it in the palette), and its note when `note`. A global
 *  fit (`fit.fit.sets` with > 1 series) draws one curve per series, each in its
 *  series' color, from that series' coefficients, and no single-curve note. */
export function addFittedCurve(
  fig: GraphFigure,
  x: Column,
  y: DataSet,
  ys: DataSet[],
  model: NonlinearModel,
  fit: AnalysisResult,
  note: boolean,
  options: GraphOptions,
  paint: Paint,
) {
  const coefficients = fit.coefficients ?? [];
  if (!coefficients.length) return;
  // The homologous curve needs [L], which the fit carries — without it,
  // there is no curve to draw.
  if (model === "homologous-competition-logx" && fit.ligandConcentration == null) return;
  const sets = fit.fit?.sets ?? [];
  if (sets.length > 1) {
    for (const setName of sets) {
      const yCol = ys.find((c) => c.name === setName) ?? y;
      const xs = xyPoints(x, yCol).x.filter((v) => keepCurveX(model, v));
      if (!xs.length) continue;
      const curve = fittedCurve(model, coefficientsForSet(coefficients, setName, sets), ...extent(xs), 100, fit.ligandConcentration);
      fig.data = [
        {
          type: "scatter",
          mode: "lines",
          x: curve.x,
          y: curve.y,
          line: { color: paint.color(yCol.name, ys.indexOf(yCol)), width: 1.5 },
          hoverinfo: "skip",
          showlegend: false,
        },
        ...fig.data,
      ];
    }
    return;
  }
  const xs = xyPoints(x, y).x.filter((v) => keepCurveX(model, v));
  if (!xs.length) return;
  const curve = fittedCurve(model, coefficients, ...extent(xs), 100, fit.ligandConcentration);
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
  if (note) addNote(fig, curveLabel(fit), options);
}

/** The probability a logistic regression gives Y = 1 at `x`, from R's coefficients (B0, B1).
 *  (Upstream 1.0.9; the S-curve overlay for its logistic-regression analysis.) */
export function logisticAt(coefficients: RegressionCoefficient[], x: number): number {
  const [b0, b1] = coefficients.map((c) => c.estimate ?? NaN);
  return 1 / (1 + Math.exp(-(b0 + b1 * x)));
}

/** Draws a logistic regression's S curve of `y` (0s and 1s) against `x` under the points, in
 *  `y`'s color, and its note when `note`: the odds ratio, the X at 50% and Tjur's R². */
export function addLogisticCurve(
  fig: GraphFigure,
  x: Column,
  y: DataSet,
  ys: DataSet[],
  fit: AnalysisResult,
  note: boolean,
  options: GraphOptions,
  paint: Paint,
) {
  const coefficients = fit.coefficients ?? [];
  const xs = xyPoints(x, y).x;
  if (coefficients.length !== 2 || !xs.length) return;
  const curve = curveXs(xs, options.xScale, 100);
  fig.data = [
    {
      type: "scatter",
      mode: "lines",
      x: curve,
      y: curve.map((x0) => logisticAt(coefficients, x0)),
      line: { color: paint.color(y.name, ys.indexOf(y)), width: 1.5 },
      hoverinfo: "skip",
      showlegend: false,
    },
    ...fig.data,
  ];
  const stat = (label: string) => num(fit.stats.find((s) => s.label === label)?.value);
  if (note)
    addNote(
      fig,
      `Odds ratio = ${stat("Odds ratio (per unit of X)")}<br>X at 50% = ${stat("X at 50% probability")}<br>` +
        `Tjur's R² = ${stat("Tjur's R squared")}`,
      options,
    );
}
