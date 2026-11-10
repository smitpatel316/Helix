// Simple logistic regression of a binary (0/1) outcome on X, for an XY table.
// Fits glm(y ~ x, family = binomial) in base R and reports the coefficients
// (with z-statistics), the odds ratio per one-unit increase in X with its Wald
// 95% CI, both deviances and McFadden's pseudo-R². Bespoke runner (not a
// ColumnTestSpec) — it needs the deviance/pseudo-R² block and a coefficients
// table whose statistic is a z, not a t.
import type {
  AnalysisOutcome,
  Column,
  RegressionCoefficient,
  SimpleLogisticRegressionParams,
  StatRow,
} from "../types";
import { describe, rVec } from "../column/base";
import { pairUp, splitXY, xyProblem } from "../../lib/dataset";
import { num } from "../../lib/format";
import { evalNamedVector } from "../webr";

/** Complete separation makes glm diverge (huge coefficients, no convergence):
 *  R still returns numbers, so the guard below refuses to present them. */
const SEPARATION_ERROR =
  "The outcome is (nearly) perfectly separated by X — the odds ratio is not estimable. " +
  "Try a different predictor, or collect more data where the outcomes overlap.";

export async function runSimpleLogisticRegression(
  columns: Column[],
  params: SimpleLogisticRegressionParams | undefined,
): Promise<AnalysisOutcome> {
  const { x: xCol, ys: yCols } = splitXY(columns);
  const yCol = params?.y === undefined ? yCols[0] : yCols.find((c) => c.name === params.y);
  if (!xCol || !yCol) return { error: xyProblem(columns, params?.y)! };

  const { x, y } = pairUp(xCol, yCol);
  if (y.some((v) => v !== 0 && v !== 1)) {
    return { error: "The outcome column must contain only 0s and 1s." };
  }
  const ones = y.filter((v) => v === 1).length;
  const zeros = y.length - ones;
  if (ones === 0 || zeros === 0) {
    return { error: "The outcome has only one value (all 0s / all 1s). Logistic regression needs both outcomes." };
  }
  // A Helix guardrail, not Prism's: a handful of points (or of the rarer outcome)
  // cannot support a two-parameter fit.
  if (y.length < 5) {
    return {
      error: `Only ${y.length} complete pair${y.length === 1 ? "" : "s"} — logistic regression needs at least 5 (a Helix guardrail, not Prism's).`,
    };
  }
  const minority = Math.min(ones, zeros);
  if (minority < 2) {
    return {
      error: `Only ${minority} observation of the less common outcome — logistic regression needs at least 2 of each outcome (a Helix guardrail, not Prism's).`,
    };
  }
  if (new Set(x).size < 2) {
    return { error: "X has only one distinct value." };
  }

  const code =
    `x<-${rVec(x)};y<-${rVec(y)};m<-glm(y~x,family=binomial);s<-summary(m);co<-s$coefficients;` +
    `c(intercept=unname(co[1,1]),slope=unname(co[2,1]),` +
    `seInt=unname(co[1,2]),seSlope=unname(co[2,2]),` +
    `zInt=unname(co[1,3]),zSlope=unname(co[2,3]),` +
    `pInt=unname(co[1,4]),pSlope=unname(co[2,4]),` +
    `or=exp(unname(co[2,1])),` +
    `orLo=exp(unname(co[2,1])-1.96*unname(co[2,2])),` +
    `orHi=exp(unname(co[2,1])+1.96*unname(co[2,2])),` +
    `slopeLo=unname(co[2,1])-1.96*unname(co[2,2]),` +
    `slopeHi=unname(co[2,1])+1.96*unname(co[2,2]),` +
    `nullDev=m$null.deviance,nullDf=m$df.null,` +
    `residDev=m$deviance,residDf=m$df.residual,aic=m$aic,` +
    `converged=as.numeric(m$converged))`;

  const v = await evalNamedVector(code);
  const coefficients: RegressionCoefficient[] = [
    { term: "Intercept", estimate: v.intercept ?? null, stdError: v.seInt ?? null, t: v.zInt ?? null, p: v.pInt ?? null },
    { term: xCol.name, estimate: v.slope ?? null, stdError: v.seSlope ?? null, t: v.zSlope ?? null, p: v.pSlope ?? null },
  ];
  // glm's warnings (non-convergence, fitted probabilities 0/1) are swallowed by
  // evalNamedVector, so separation is caught here from the fit itself: no
  // convergence, a huge |coefficient|, or a missing/non-finite standard error.
  const separated =
    v.converged !== 1 ||
    coefficients.some((c) => c.estimate == null || Math.abs(c.estimate) > 30) ||
    coefficients.some((c) => c.stdError == null);
  if (separated) return { error: SEPARATION_ERROR };

  const pseudoR2 =
    v.nullDev != null && v.nullDev !== 0 && v.residDev != null ? 1 - v.residDev / v.nullDev : null;
  const stats: StatRow[] = [
    { label: "Odds ratio (per 1 unit X)", value: v.or ?? null },
    { label: "Odds ratio 95% CI lower", value: v.orLo ?? null },
    { label: "Odds ratio 95% CI upper", value: v.orHi ?? null },
    { label: "Slope 95% CI lower", value: v.slopeLo ?? null },
    { label: "Slope 95% CI upper", value: v.slopeHi ?? null },
    { label: "Null deviance", value: v.nullDev ?? null },
    { label: "Null deviance DF", value: v.nullDf ?? null },
    { label: "Residual deviance", value: v.residDev ?? null },
    { label: "Residual deviance DF", value: v.residDf ?? null },
    { label: "McFadden pseudo-R²", value: pseudoR2 },
    { label: "AIC", value: v.aic ?? null },
    { label: "N", value: y.length },
  ];

  const b0 = v.intercept;
  const b1 = v.slope;
  const equation =
    b0 == null || b1 == null
      ? undefined
      : `P(Y=1) = 1 / (1 + exp(-(${num(b1)}*X ${b0 < 0 ? "−" : "+"} ${num(Math.abs(b0))})))`;

  return {
    testType: "simple-logistic-regression",
    subtitle: "Simple logistic regression",
    equation,
    stats,
    groups: [xCol, yCol].map(describe),
    notes:
      `Simple logistic regression of “${yCol.name}” on “${xCol.name}” (n = ${y.length}). ` +
      "The odds ratio is per one-unit increase in X. " +
      "The 95% confidence intervals are Wald intervals (a normal approximation).",
    coefficients,
    // The coefficients table's statistic is a z, not a t.
    statisticLabel: "z",
  };
}
