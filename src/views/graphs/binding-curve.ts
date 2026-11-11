// Binding curve overlay: evaluates the fitted saturation / kinetics
// equation (computed by a "Binding — Saturation" or "Binding — Kinetics"
// analysis via WebR nls()) at evenly spaced X points for plotting — no
// re-fitting here, just the closed form applied to the returned
// coefficients. Follows fitted-curve.ts exactly: the graph reads the
// cached runAnalysis result, as addFittedCurve does.
import type { GraphOptions } from "../../store/types";
import type {
  AnalysisResult,
  BindingKineticsModel,
  BindingKineticsParams,
  BindingSaturationModel,
  BindingSaturationParams,
  DoseResponseSpecialModel,
  DoseResponseSpecialParams,
  EnzymeInhibitionModel,
  EnzymeInhibitionParams,
  RegressionCoefficient,
  StatRow,
} from "../../stats/types";
import { evaluateBindingModel, isTwoSeriesSaturation } from "../../stats/xy/binding";
import { evaluateEnzymeInhibitionModel, parseInhibitorConcentration } from "../../stats/xy/enzyme-inhibition";
import { evaluateDoseResponseSpecialModel } from "../../stats/xy/dose-response-special";
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

/** Evenly-spaced points across [xMin, xMax] tracing a fitted curve, from any
 *  per-X evaluator — the binding overlay and the enzyme-inhibition overlay
 *  share this, so there is exactly one 100-point evaluator in the repo. */
function curvePoints(
  evaluate: (x: number) => number,
  xMin: number,
  xMax: number,
  steps = 100,
): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const x0 = xMin + ((xMax - xMin) * i) / steps;
    x.push(x0);
    y.push(evaluate(x0));
  }
  return { x, y };
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
  return curvePoints((x0) => evaluateBindingModel(model, coefficients, x0, series, atd), xMin, xMax, steps);
}

/** "Bmax = 100<br>Kd = 5<br>R² = 1" annotation text (Plotly-ready) — the
 *  fitted constants, the half-life / residence time for kinetics, and R²
 *  (the total series' for a two-series fit). */
function bindingLabel(model: BindingModel, coefficients: RegressionCoefficient[], stats: StatRow[]): string {
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

/** "Vmax = 100<br>Km = 10<br>Ki = 5<br>R² = 1" annotation text
 *  (Plotly-ready) for an enzyme-inhibition fit — the shared fitted
 *  constants, Alpha for the mixed model, Et/Kiapp/Ki for Morrison, and R². */
function enzymeInhibitionLabel(
  model: EnzymeInhibitionModel,
  coefficients: RegressionCoefficient[],
  stats: StatRow[],
): string {
  const r2 = stat(stats, "R squared");
  const lines: string[] = [];
  if (model === "morrison") {
    lines.push(`Et = ${num(coef(coefficients, "Et"))}`, `Kiapp = ${num(coef(coefficients, "Kiapp"))}`);
    const ki = coef(coefficients, "Ki");
    if (Number.isFinite(ki)) lines.push(`Ki = ${num(ki)}`);
  } else {
    lines.push(
      `Vmax = ${num(coef(coefficients, "Vmax"))}`,
      `Km = ${num(coef(coefficients, "Km"))}`,
      `Ki = ${num(coef(coefficients, "Ki"))}`,
    );
    if (model === "mixed") lines.push(`Alpha = ${num(coef(coefficients, "Alpha"))}`);
  }
  if (r2 != null) lines.push(`R² = ${num(r2)}`);
  return lines.join("<br>");
}

/** Draws one fitted curve per inhibitor concentration, each in its series'
 *  colour, evaluated from the closed-form model + shared fitted parameters
 *  at 100 X points across the pooled X range (Morrison: one curve, X = [I]).
 *  No Lineweaver–Burk overlay: Prism offers LB only as a display Transform,
 *  never as a fit, and Helix has no transform infrastructure — these curves
 *  are always the closed-form nls fit, never a reciprocal linear regression. */
export function addEnzymeInhibitionCurve(
  fig: GraphFigure,
  columns: Column[],
  options: GraphOptions,
  fit: AnalysisResult,
  params: EnzymeInhibitionParams,
  paint: Paint,
) {
  const [x, ...ys] = columns;
  const model = params.model;
  const coefficients = fit.coefficients ?? [];
  if (!x || !coefficients.length) return;
  const included = params.y?.length ? ys.filter((c) => params.y!.includes(c.name)) : ys;
  if (!included.length) return;
  // The pooled X range, so every curve spans the data the fit saw.
  const allXs = included.flatMap((c) => pairUp(x, c).x);
  if (!allXs.length) return;
  const [xMin, xMax] = extent(allXs);
  const traces: GraphFigure["data"] = [];
  for (const col of included) {
    // Morrison's X is the inhibitor concentration itself, so no [I] is needed.
    const inhibitor =
      model === "morrison" ? 0 : (params.inhibitorConcentrations?.[col.name] ?? parseInhibitorConcentration(col.name));
    if (inhibitor === undefined) continue;
    const curve = curvePoints((x0) => evaluateEnzymeInhibitionModel(model, coefficients, x0, inhibitor), xMin, xMax);
    traces.push({
      type: "scatter",
      mode: "lines",
      x: curve.x,
      y: curve.y,
      line: { color: paint.color(col.name, ys.indexOf(col)), width: 1.5 },
      hoverinfo: "skip",
      showlegend: false,
    });
  }
  if (!traces.length) return;
  fig.data = [...traces, ...fig.data];
  addNote(fig, enzymeInhibitionLabel(model, coefficients, fit.stats), options);
}

/** "Bottom = 0<br>Top = 100<br>HillSlope = 1<br>EC50 (Control) = 1e-6<br>R² = 1"
 *  annotation text (Plotly-ready) for a dose-response — Special fit — the
 *  shared parameters, the per-series EC50s (EC50 shift) or pA2 + EC50
 *  (Schild, with B's units) or the per-partial logKA/logtau (operational),
 *  and R². */
function doseResponseSpecialLabel(
  model: DoseResponseSpecialModel,
  coefficients: RegressionCoefficient[],
  stats: StatRow[],
  params: DoseResponseSpecialParams,
): string {
  const r2 = stat(stats, "R squared");
  const lines: string[] = [];
  if (model === "ec50-shift") {
    lines.push(
      `Bottom = ${num(coef(coefficients, "Bottom"))}`,
      `Top = ${num(coef(coefficients, "Top"))}`,
      `HillSlope = ${num(coef(coefficients, "HillSlope"))}`,
    );
    for (const c of coefficients.filter((c) => c.term.startsWith("EC50[")))
      lines.push(`${c.term} = ${num(c.estimate)}`);
  } else if (model === "schild" || model === "schild-slope-1") {
    lines.push(
      `pA2 = ${num(coef(coefficients, "pA2"))} (B in ${params.bUnits ?? "M"})`,
      `EC50 = ${num(stat(stats, "EC50 (control)"))}`,
    );
    if (model === "schild") lines.push(`SchildSlope = ${num(coef(coefficients, "SchildSlope"))}`);
  } else {
    lines.push(
      `Basal = ${num(coef(coefficients, "Basal"))}`,
      `Effectmax = ${num(coef(coefficients, "Effectmax"))}`,
      `n = ${num(coef(coefficients, "n"))}`,
    );
    for (const c of coefficients.filter((c) => c.term.startsWith("logKA[") || c.term.startsWith("logtau[")))
      lines.push(`${c.term} = ${num(c.estimate)}`);
  }
  if (r2 != null) lines.push(`R² = ${num(r2)}`);
  return lines.join("<br>");
}

/** Draws one fitted curve per Y series of a dose-response — Special fit,
 *  each in its series' colour, evaluated from the closed-form model +
 *  shared fitted parameters at 100 X points across the pooled X range.
 *  The series order is the fit's (params.ys — the control / full agonist
 *  first), not the table's, because the operational model's first series
 *  takes the 4PL branch and the rest the operational branch. */
export function addDoseResponseSpecialCurve(
  fig: GraphFigure,
  columns: Column[],
  options: GraphOptions,
  fit: AnalysisResult,
  params: DoseResponseSpecialParams,
  paint: Paint,
) {
  const [x, ...ys] = columns;
  const model = params.model;
  const coefficients = fit.coefficients ?? [];
  if (!x || !coefficients.length) return;
  const ordered = params.ys?.length
    ? params.ys.map((n) => ys.find((c) => c.name === n)).filter((c): c is Column => c !== undefined)
    : ys;
  if (!ordered.length) return;
  // The pooled X range, so every curve spans the data the fit saw.
  const allXs = ordered.flatMap((c) => pairUp(x, c).x);
  if (!allXs.length) return;
  const [xMin, xMax] = extent(allXs);
  const traces: GraphFigure["data"] = [];
  for (const [i, col] of ordered.entries()) {
    // The operational model has no B; Schild / EC50 shift read it from
    // the params, else the column title (the Prism convention).
    const B =
      model === "operational-partial"
        ? 0
        : (params.antagonistConcentrations?.[col.name] ?? parseInhibitorConcentration(col.name));
    if (B === undefined) continue;
    const curve = curvePoints(
      (x0) => evaluateDoseResponseSpecialModel(model, coefficients, { name: col.name, covariate: B }, i, x0),
      xMin,
      xMax,
    );
    traces.push({
      type: "scatter",
      mode: "lines",
      x: curve.x,
      y: curve.y,
      line: { color: paint.color(col.name, ys.indexOf(col)), width: 1.5 },
      hoverinfo: "skip",
      showlegend: false,
    });
  }
  if (!traces.length) return;
  fig.data = [...traces, ...fig.data];
  addNote(fig, doseResponseSpecialLabel(model, coefficients, fit.stats, params), options);
}
