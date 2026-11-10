// Nonlinear regression for an XY table — Prism's "Standard curves to interpolate"
// category: a curated set of standard curves that fit reliably in WebR. Linear-in-
// parameters models (line, semilog, polynomials) fit with lm(); the sigmoidal and
// hyperbola forms fit with nls(). Each model reports its coefficients plus a
// goodness-of-fit block (R², degrees of freedom, sum of squares, Sy.x) and, where
// meaningful, derived quantities (e.g. a 4PL's EC50 and Span). The fit itself lives
// in nonlinear-fit.ts, shared with standard-curve interpolation.
//
// Plan 08 adds Prism's "Exponential" family (one/two-phase decay, plateau
// followed by decay, one-phase association, exponential growth) to the same
// runner: same result shape, plus a fitted equation and a note naming the
// data-driven starting values. A fitted K ≤ 0 leaves its half-life /
// doubling time null (see the derived expressions) and is noted, not hidden.
import type { AnalysisOutcome, Column, NonlinearModel, NonlinearRegressionParams, RegressionCoefficient } from "../types";
import { describe } from "../column/base";
import { num } from "../../lib/format";
import { EXPONENTIAL_MODELS, fitError, fitNonlinearModel, MODEL_LABEL, prepareFit } from "./nonlinear-fit";

const isExponential = (model: NonlinearModel) => EXPONENTIAL_MODELS.includes(model);

const coefOf = (coefficients: RegressionCoefficient[], term: string) => coefficients.find((c) => c.term === term)?.estimate ?? null;

/** The fitted equation, from the fitted coefficients (4 significant figures,
 *  like the rest of Helix's display). Only the exponential models carry one —
 *  the older models keep their pinned result shape. */
function equation(model: NonlinearModel, coefficients: RegressionCoefficient[]): string | undefined {
  const y0 = coefOf(coefficients, "Y0");
  const plateau = coefOf(coefficients, "Plateau");
  const k = coefOf(coefficients, "K");
  switch (model) {
    case "one-phase-decay":
      if (y0 == null || plateau == null || k == null) return undefined;
      return `Y = (${num(y0)} − ${num(plateau)})·exp(−${num(k)}·X) + ${num(plateau)}`;
    case "two-phase-decay": {
      const span1 = coefOf(coefficients, "Span1");
      const k1 = coefOf(coefficients, "K1");
      const span2 = coefOf(coefficients, "Span2");
      const k2 = coefOf(coefficients, "K2");
      if (plateau == null || span1 == null || k1 == null || span2 == null || k2 == null) return undefined;
      return `Y = ${num(plateau)} + ${num(span1)}·exp(−${num(k1)}·X) + ${num(span2)}·exp(−${num(k2)}·X)`;
    }
    case "plateau-decay": {
      const x0 = coefOf(coefficients, "X0");
      if (x0 == null || y0 == null || plateau == null || k == null) return undefined;
      return `Y = ${num(y0)} for X < ${num(x0)}; Y = ${num(plateau)} + (${num(y0)} − ${num(plateau)})·exp(−${num(k)}·(X − ${num(x0)})) for X ≥ ${num(x0)}`;
    }
    default:
      return undefined;
  }
}

/** The data-driven starting values the R fit used, in the same terms as
 *  modelSpec's `start` list — recomputed here from the fitted points, so the
 *  note always names what nls() actually started from. */
function startingValues(model: NonlinearModel, xs: number[], ys: number[]): string {
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const yAtMinX = ys[xs.indexOf(Math.min(...xs))];
  const median = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  switch (model) {
    case "one-phase-decay":
      return `Starting values: Y0 = ${num(yAtMinX)}, Plateau = ${num(minY)}, K = 0.5.`;
    case "two-phase-decay":
      return `Starting values: Plateau = ${num(minY)}, Span1 = ${num(0.6 * (maxY - minY))}, K1 = 1, Span2 = ${num(0.4 * (maxY - minY))}, K2 = 0.1.`;
    case "plateau-decay": {
      const x0 = median(xs);
      const below = ys.filter((_, i) => xs[i] < x0);
      const y0 = below.reduce((s, v) => s + v, 0) / below.length;
      return `Starting values: X0 = ${num(x0)}, Y0 = ${num(y0)}, Plateau = ${num(minY)}, K = 0.5.`;
    }
    default:
      return "";
  }
}

/** Warnings the fit itself cannot express: a fitted K ≤ 0 makes its
 *  half-life / doubling time undefined (the derived row is null), and
 *  K1 ≈ K2 leaves a two-phase fit unidentifiable. */
function fitWarnings(model: NonlinearModel, coefficients: RegressionCoefficient[]): string[] {
  const out: string[] = [];
  const k = coefOf(coefficients, "K");
  if (model === "one-phase-decay" || model === "plateau-decay") {
    if (k != null && k <= 0) out.push("Fitted K ≤ 0 — half-life not defined.");
  }
  if (model === "two-phase-decay") {
    const k1 = coefOf(coefficients, "K1");
    const k2 = coefOf(coefficients, "K2");
    if (k1 != null && k1 <= 0) out.push("Fitted K1 ≤ 0 — half-life (fast) not defined.");
    if (k2 != null && k2 <= 0) out.push("Fitted K2 ≤ 0 — half-life (slow) not defined.");
    if (k1 != null && k2 != null && Math.abs(k1 - k2) / Math.max(Math.abs(k1), Math.abs(k2), 1e-12) < 0.01)
      out.push("K1 ≈ K2 — the two phases are nearly identical, so the separate phase parameters are poorly identified.");
  }
  return out;
}

export async function runNonlinearRegression(
  columns: Column[],
  params: NonlinearRegressionParams | undefined,
): Promise<AnalysisOutcome> {
  const model = params?.model;
  if (!model || !Object.hasOwn(MODEL_LABEL, model)) return { error: "Choose a standard curve to fit." };

  const prepared = prepareFit(columns, params?.y, model);
  if ("error" in prepared) return prepared;
  const { xCol, yCol, xs, ys } = prepared;

  try {
    const { coefficients, derived, stats } = await fitNonlinearModel(xs, ys, model);
    const notes = [`Nonlinear least-squares fit ("${MODEL_LABEL[model]}") of "${yCol.name}" on "${xCol.name}".`];
    const eq = isExponential(model) ? equation(model, coefficients) : undefined;
    if (isExponential(model)) {
      notes.push(startingValues(model, xs, ys));
      notes.push(...fitWarnings(model, coefficients));
    }
    return {
      testType: "nonlinear-regression",
      subtitle: MODEL_LABEL[model],
      ...(eq ? { equation: eq } : {}),
      stats: [...derived, ...stats],
      groups: [xCol, yCol].map(describe),
      notes: notes.join(" "),
      coefficients,
    };
  } catch (err) {
    return fitError(err, model);
  }
}
