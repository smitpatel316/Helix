// Nonlinear regression for an XY table — Prism's "Standard curves to interpolate"
// category: a curated set of standard curves that fit reliably in WebR. Linear-in-
// parameters models (line, semilog, polynomials) fit with lm(); the sigmoidal and
// hyperbola forms fit with nls(). Each model reports its coefficients plus a
// goodness-of-fit block (R², degrees of freedom, sum of squares, Sy.x) and, where
// meaningful, derived quantities (e.g. a 4PL's EC50 and Span). The fit itself lives
// in nonlinear-fit.ts, shared with standard-curve interpolation.
import type { AnalysisOutcome, Column, NonlinearRegressionParams } from "../types";
import { describe } from "../column/base";
import { fitError, fitNonlinearModel, MODEL_LABEL, prepareFit } from "./nonlinear-fit";

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
    return {
      testType: "nonlinear-regression",
      subtitle: MODEL_LABEL[model],
      stats: [...derived, ...stats],
      groups: [xCol, yCol].map(describe),
      notes: `Nonlinear least-squares fit ("${MODEL_LABEL[model]}") of "${yCol.name}" on "${xCol.name}".`,
      coefficients,
    };
  } catch (err) {
    return fitError(err);
  }
}
