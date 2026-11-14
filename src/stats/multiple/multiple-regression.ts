// Multiple linear regression on a Multiple Variables table: one chosen dependent
// variable regressed on every other data-bearing variable, fit on complete cases.
// Bespoke runner (not ColumnTestSpec) — needs a chosen response + a coefficients table.
import type { AnalysisOutcome, Column, MultipleRegressionParams, RegressionCoefficient } from "../types";
import { describe, pairedGroups, pRow, rVec } from "../column/base";
import { droppedPredictorsNote, selectPredictors, aliasedPredictorsError } from "./predictors";
import { evalNamedVector } from "../webr";

export async function runMultipleRegression(
  columns: Column[],
  params: MultipleRegressionParams | undefined,
): Promise<AnalysisOutcome> {
  const { dep, predictors, dropped } = selectPredictors(columns, params);
  if (!dep || predictors.length < 1) {
    return { error: "Multiple regression needs a dependent variable and at least one other variable with data." };
  }

  // Complete cases: the rows where every variable used has a value.
  const used = [dep, ...predictors];
  const aligned = pairedGroups(used).map((g) => g.values);
  const n = aligned[0].length;
  const p = predictors.length;
  if (n <= p + 1) {
    return { error: `Not enough complete rows (${n}) to fit ${p} predictor(s). Enter more data and try again.` };
  }

  const decls = [`y<-${rVec(aligned[0])}`, ...predictors.map((_, i) => `x${i}<-${rVec(aligned[i + 1])}`)];
  const formula = `y~${predictors.map((_, i) => `x${i}`).join("+")}`;
  // Each coefficient row t (0 = intercept) pulled from summary()'s coefficient
  // matrix by explicit index → keyed names, so extraction never depends on order.
  // A constant or collinear predictor is aliased: coef(m) holds NA for it and
  // summary()'s matrix DROPS its row, so co[t + 1, ] would read the wrong row
  // — or crash with "subscript out of bounds" past the last row. The
  // coefficient pulls are therefore guarded on nal (any NA in coef(m)), and
  // the aliased predictors are reported by index (al0…), so the runner can
  // name them instead of indexing the matrix. The F statistic is NULL when
  // every predictor is aliased (an intercept-only fit), so it is guarded too.
  const coefAssigns = Array.from(
    { length: p + 1 },
    (_, t) =>
      `b${t}=if(nal) NA else co[${t + 1},1],se${t}=if(nal) NA else co[${t + 1},2],` +
      `t${t}=if(nal) NA else co[${t + 1},3],pv${t}=if(nal) NA else co[${t + 1},4]`,
  );
  const aliasAssigns = Array.from({ length: p }, (_, i) => `al${i}=as.numeric(na[${i + 2}])`);
  const code =
    `${decls.join(";")};m<-lm(${formula});s<-summary(m);co<-s$coefficients;na<-is.na(coef(m));nal<-any(na);f<-s$fstatistic;` +
    `c(r2=s$r.squared,adjr2=s$adj.r.squared,fstat=if(is.null(f)) NA else unname(f[1]),n=length(y),` +
    `fp=if(is.null(f)) NA else unname(pf(f[1],f[2],f[3],lower.tail=FALSE)),` +
    `aliased=as.numeric(nal),${aliasAssigns.join(",")},${coefAssigns.join(",")})`;

  const v = await evalNamedVector(code);
  if (v.aliased === 1) {
    return {
      error:
        aliasedPredictorsError(
          predictors,
          aligned.slice(1),
          predictors.map((_, i) => v[`al${i}`]),
          "Multiple linear regression",
        ) ??
        "The fit could not estimate a separate coefficient for every predictor — two or more predictors carry the same information. Drop one of the collinear predictors and try again.",
    };
  }
  const terms = ["Intercept", ...predictors.map((c) => c.name)];
  const coefficients: RegressionCoefficient[] = terms.map((term, t) => ({
    term,
    estimate: v[`b${t}`] ?? null,
    stdError: v[`se${t}`] ?? null,
    t: v[`t${t}`] ?? null,
    p: v[`pv${t}`] ?? null,
  }));
  const { groups: described } = await describe(used);
  return {
    testType: "multiple-regression",
    subtitle: "Multiple linear regression",
    stats: [
      { label: "R squared", value: v.r2 },
      { label: "Adjusted R squared", value: v.adjr2 },
      { label: "F", value: v.fstat },
      pRow("P value (model)", v.fp ?? null),
      { label: "Complete rows (n)", value: v.n },
      { label: "Predictors", value: p },
    ],
    groups: described,
    notes:
      `Ordinary least-squares regression of “${dep.name}” on ${p} predictor(s), fit on ${n} complete rows. ` +
      "Each coefficient's P value tests whether that predictor's slope differs from zero, holding the others fixed." +
      droppedPredictorsNote(dropped),
    coefficients,
  };
}
