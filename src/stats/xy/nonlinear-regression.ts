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
import { ENZYME_MODELS, EXPONENTIAL_MODELS, fitError, fitNonlinearModel, MODEL_LABEL, prepareFit } from "./nonlinear-fit";

const isExponential = (model: NonlinearModel) => EXPONENTIAL_MODELS.includes(model);
const isEnzyme = (model: NonlinearModel) => ENZYME_MODELS.includes(model);

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
    case "one-phase-association":
      if (y0 == null || plateau == null || k == null) return undefined;
      return `Y = ${num(y0)} + (${num(plateau)} − ${num(y0)})·(1 − exp(−${num(k)}·X))`;
    case "exponential-growth":
      if (y0 == null || k == null) return undefined;
      return `Y = ${num(y0)}·exp(${num(k)}·X)`;
    case "michaelis-menten": {
      const vmax = coefOf(coefficients, "Vmax");
      const km = coefOf(coefficients, "Km");
      if (vmax == null || km == null) return undefined;
      return `Y = ${num(vmax)}·X / (${num(km)} + X)`;
    }
    case "allosteric-sigmoidal": {
      const vmax = coefOf(coefficients, "Vmax");
      const khalf = coefOf(coefficients, "Khalf");
      const h = coefOf(coefficients, "HillSlope");
      if (vmax == null || khalf == null || h == null) return undefined;
      return `Y = ${num(vmax)}·X^${num(h)} / (${num(khalf)}^${num(h)} + X^${num(h)})`;
    }
    case "substrate-inhibition": {
      const vmax = coefOf(coefficients, "Vmax");
      const km = coefOf(coefficients, "Km");
      const ki = coefOf(coefficients, "Ki");
      if (vmax == null || km == null || ki == null) return undefined;
      return `Y = ${num(vmax)}·X / (${num(km)} + X + X²/${num(ki)})`;
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
    case "one-phase-association":
      return `Starting values: Y0 = ${num(yAtMinX)}, Plateau = ${num(maxY)}, K = 0.5.`;
    case "exponential-growth":
      return `Starting values: Y0 = ${num(yAtMinX)}, K = 0.1.`;
    case "michaelis-menten":
      return `Starting values: Vmax = ${num(maxY * 1.1)}, Km = ${num(median(xs.filter((x) => x > 0)))}.`;
    case "allosteric-sigmoidal":
      return `Starting values: Vmax = ${num(maxY * 1.1)}, Khalf = ${num(median(xs.filter((x) => x > 0)))}, Hill slope = 1.`;
    case "substrate-inhibition":
      return `Starting values: Vmax = ${num(maxY * 1.5)}, Km = ${num(median(xs.filter((x) => x > 0)))}, Ki = ${num(Math.max(...xs))}.`;
    default:
      return "";
  }
}

/** Warnings the fit itself cannot express: a fitted K ≤ 0 makes its
 *  half-life / doubling time undefined (the derived row is null), and
 *  K1 ≈ K2 leaves a two-phase fit unidentifiable. Enzyme models (plan 09):
 *  a fitted Km/Ki ≤ 0 or Hill slope ≤ 0 is reported, not hidden (Vmax/Km
 *  is null when Km ≤ 0), and a substrate range that does not bracket Km /
 *  Khalf warns that the constant is imprecisely estimated. `xs` is the
 *  fitted X values (the bracketing check needs them). */
function fitWarnings(model: NonlinearModel, coefficients: RegressionCoefficient[], xs?: number[]): string[] {
  const out: string[] = [];
  const k = coefOf(coefficients, "K");
  if (model === "one-phase-decay" || model === "plateau-decay" || model === "one-phase-association") {
    if (k != null && k <= 0) out.push("Fitted K ≤ 0 — half-life not defined.");
  }
  if (model === "exponential-growth" && k != null && k <= 0) out.push("Fitted K ≤ 0 — doubling time not defined.");
  if (model === "two-phase-decay") {
    const k1 = coefOf(coefficients, "K1");
    const k2 = coefOf(coefficients, "K2");
    if (k1 != null && k1 <= 0) out.push("Fitted K1 ≤ 0 — half-life (fast) not defined.");
    if (k2 != null && k2 <= 0) out.push("Fitted K2 ≤ 0 — half-life (slow) not defined.");
    if (k1 != null && k2 != null && Math.abs(k1 - k2) / Math.max(Math.abs(k1), Math.abs(k2), 1e-12) < 0.01)
      out.push("K1 ≈ K2 — the two phases are nearly identical, so the separate phase parameters are poorly identified.");
  }
  if (isEnzyme(model)) {
    const km = coefOf(coefficients, "Km");
    const ki = coefOf(coefficients, "Ki");
    const vmax = coefOf(coefficients, "Vmax");
    if (km != null && km <= 0)
      out.push("Fitted Km ≤ 0 — the data do not constrain Km; check the concentration range.");
    if (ki != null && ki <= 0)
      out.push("Fitted Ki ≤ 0 — the data do not constrain Ki; check the concentration range.");
    if (model === "michaelis-menten" && km != null && km <= 0 && vmax != null)
      out.push("Vmax/Km is not defined when Km ≤ 0.");
    if (model === "allosteric-sigmoidal") {
      const h = coefOf(coefficients, "HillSlope");
      const khalf = coefOf(coefficients, "Khalf");
      if (h != null && h <= 0)
        out.push("Fitted Hill slope ≤ 0 — the curve decreases, which contradicts the allosteric model.");
      if (xs && khalf != null && khalf > 0) {
        const positive = xs.filter((x) => x > 0);
        if (Math.max(...xs) < khalf || Math.min(...positive) > khalf)
          out.push("The substrate range does not bracket Khalf — Khalf is imprecisely estimated.");
      }
    } else if (xs && km != null && km > 0) {
      const positive = xs.filter((x) => x > 0);
      if (Math.max(...xs) < km || Math.min(...positive) > km)
        out.push("The substrate range does not bracket Km — Km is imprecisely estimated.");
    }
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
    const { coefficients, derived, stats, retried } = await fitNonlinearModel(xs, ys, model);
    const notes = [`Nonlinear least-squares fit ("${MODEL_LABEL[model]}") of "${yCol.name}" on "${xCol.name}".`];
    const eq = isExponential(model) || isEnzyme(model) ? equation(model, coefficients) : undefined;
    if (isExponential(model) || isEnzyme(model)) {
      notes.push(startingValues(model, xs, ys));
      if (isEnzyme(model)) {
        if (xs.includes(0))
          notes.push("The X = 0 (vehicle) point is included in the fit; the fitted curve is Y = 0 at X = 0.");
        if (ys.some((y) => y < 0))
          notes.push("Some velocities are negative — measurement noise around zero; the fit allows negative Y.");
        if (retried) {
          const median = (v: number[]) => {
            const s = [...v].sort((a, b) => a - b);
            return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
          };
          notes.push(
            `The first substrate-inhibition fit failed; retried with Ki = ${num(median(xs.filter((x) => x > 0)) * 5)} (5 × median substrate concentration) and converged.`,
          );
        }
      }
      notes.push(...fitWarnings(model, coefficients, xs));
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
