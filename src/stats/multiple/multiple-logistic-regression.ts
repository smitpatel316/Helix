// Multiple logistic regression on a Multiple Variables table: a binary (0/1)
// outcome regressed on several predictors, fit on complete cases. Bespoke
// runner (not ColumnTestSpec) — needs a chosen outcome, a coefficients table
// whose statistic is a z, and per-predictor odds ratios as stats rows.
// Mirrors multiple-regression.ts, with glm(family = binomial) in place of lm
// and the separation guard from xy/logistic-regression.ts (plan 01).
import type {
  AnalysisOutcome,
  Column,
  MultipleLogisticRegressionParams,
  RegressionCoefficient,
  StatRow,
} from "../types";
import { describe, pairedGroups, pRow, rVec } from "../column/base";
import { droppedPredictorsNote, selectPredictors } from "./predictors";
import { evalNamedVector } from "../webr";
import { num } from "../../lib/format";

/** Complete separation makes glm diverge (huge coefficients, no convergence):
 *  R still returns numbers, so the guard below refuses to present them. */
const SEPARATION_ERROR =
  "The outcome is (nearly) perfectly separated by the predictor(s) — the odds ratios are not estimable. " +
  "Try different predictors, or collect more data where the outcomes overlap.";

export async function runMultipleLogisticRegression(
  columns: Column[],
  params: MultipleLogisticRegressionParams | undefined,
): Promise<AnalysisOutcome> {
  const { dep, predictors, dropped } = selectPredictors(columns, params);
  if (!dep || predictors.length < 1) {
    return {
      error: "Multiple logistic regression needs a dependent variable and at least one other variable with data.",
    };
  }

  // Complete cases: the rows where every variable used has a value.
  const used = [dep, ...predictors];
  const aligned = pairedGroups(used).map((g) => g.values);
  const n = aligned[0].length;
  const p = predictors.length;

  // The outcome must hold only 0s and 1s (blanks are already dropped as incomplete
  // rows). Text codes ("yes"/"no") are not coerced in v1 — 0/1 only.
  const bad = aligned[0].find((v) => v !== 0 && v !== 1);
  if (bad !== undefined) {
    return {
      error: `“${dep.name}” holds ${bad}, but the outcome must hold only 0s and 1s (1 = event, 0 = no event).`,
    };
  }
  const ones = aligned[0].filter((v) => v === 1).length;
  if (ones === 0 || ones === n) {
    return {
      error: "The outcome has only one value (all 0s / all 1s). Logistic regression needs both outcomes.",
    };
  }
  if (n <= p + 1) {
    return { error: `Not enough complete rows (${n}) to fit ${p} predictor(s). Enter more data and try again.` };
  }

  const decls = [`y<-${rVec(aligned[0])}`, ...predictors.map((_, i) => `x${i}<-${rVec(aligned[i + 1])}`)];
  const formula = `y~${predictors.map((_, i) => `x${i}`).join("+")}`;
  // Each coefficient row t (0 = intercept) pulled from summary()'s coefficient
  // matrix by explicit index → keyed names, so extraction never depends on order.
  // Column 3 of a glm coefficient matrix is the z value, not a t value. Odds
  // ratios (per predictor only) are Wald: exp(estimate ± 1.96·SE).
  const coefAssigns = Array.from({ length: p + 1 }, (_, t) => {
    const base = `b${t}=co[${t + 1},1],se${t}=co[${t + 1},2],z${t}=co[${t + 1},3],pv${t}=co[${t + 1},4]`;
    return t === 0
      ? base
      : `${base},or${t}=exp(co[${t + 1},1]),orLo${t}=exp(co[${t + 1},1]-1.96*co[${t + 1},2]),orHi${t}=exp(co[${t + 1},1]+1.96*co[${t + 1},2])`;
  });
  const code =
    `${decls.join(";")};m<-glm(${formula},family=binomial);s<-summary(m);co<-s$coefficients;` +
    `c(dev=m$deviance,nulldev=m$null.deviance,residDf=m$df.residual,aic=m$aic,` +
    `modelP=pchisq(m$null.deviance-m$deviance,${p},lower.tail=FALSE),converged=as.numeric(m$converged),${coefAssigns.join(",")})`;

  const v = await evalNamedVector(code);
  const terms = ["Intercept", ...predictors.map((c) => c.name)];
  const coefficients: RegressionCoefficient[] = terms.map((term, t) => ({
    term,
    estimate: v[`b${t}`] ?? null,
    stdError: v[`se${t}`] ?? null,
    t: v[`z${t}`] ?? null,
    p: v[`pv${t}`] ?? null,
  }));
  // glm's warnings (non-convergence, fitted probabilities 0/1) are swallowed by
  // evalNamedVector, so separation is caught here from the fit itself: no
  // convergence, a huge |coefficient|, or a missing/non-finite standard error.
  const separated =
    v.converged !== 1 ||
    coefficients.some((c) => c.estimate == null || !Number.isFinite(c.estimate) || Math.abs(c.estimate) > 30) ||
    coefficients.some((c) => c.stdError == null || !Number.isFinite(c.stdError));
  if (separated) return { error: SEPARATION_ERROR };

  const pseudoR2 = v.nulldev != null && v.nulldev !== 0 && v.dev != null ? 1 - v.dev / v.nulldev : null;
  const stats: StatRow[] = [
    ...predictors.flatMap((c, i) => {
      const t = i + 1;
      return [
        { label: `Odds ratio (${c.name})`, value: v[`or${t}`] ?? null },
        { label: `Odds ratio 95% CI lower (${c.name})`, value: v[`orLo${t}`] ?? null },
        { label: `Odds ratio 95% CI upper (${c.name})`, value: v[`orHi${t}`] ?? null },
      ];
    }),
    { label: "Residual deviance", value: v.dev ?? null },
    { label: "Null deviance", value: v.nulldev ?? null },
    { label: "Residual df", value: v.residDf ?? null },
    { label: "AIC", value: v.aic ?? null },
    pRow("P value (model)", v.modelP ?? null),
    { label: "McFadden pseudo-R²", value: pseudoR2 },
    { label: "Complete rows (n)", value: n },
    { label: "Predictors", value: p },
  ];

  const described = (await describe(pairedGroups(used))).groups;
  // logit(p) = b0 + b1·X1 + b2·X2 + …
  const b0 = v.b0;
  const equation =
    b0 == null
      ? undefined
      : `logit(p) = ${num(b0)} ${predictors
          .map((c, i) => {
            const b = v[`b${i + 1}`];
            return b == null ? null : `${b < 0 ? "−" : "+"} ${num(Math.abs(b))}·${c.name}`;
          })
          .filter((s): s is string => s !== null)
          .join(" ")}`;

  return {
    testType: "multiple-logistic-regression",
    subtitle: "Multiple logistic regression",
    equation,
    stats,
    groups: described,
    notes:
      `Multiple logistic regression of “${dep.name}” on ${p} predictor(s), fit on ${n} complete rows. ` +
      "The odds ratios are per one-unit increase in each predictor, with Wald 95% confidence intervals (a normal approximation). " +
      "Each predictor's P value tests whether its coefficient differs from zero, holding the others fixed." +
      droppedPredictorsNote(dropped),
    coefficients,
    // The coefficients table's statistic is a z, not a t.
    statisticLabel: "z",
  };
}
