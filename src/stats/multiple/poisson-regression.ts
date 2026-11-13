// Poisson regression on a Multiple Variables table: a count outcome regressed
// on several predictors, fit on complete cases. Bespoke runner (not
// ColumnTestSpec) — needs a chosen outcome, a coefficients table whose
// statistic is a z, per-predictor rate ratios as stats rows, and a dispersion
// check that warns on overdispersion and offers a quasi-Poisson refit.
// Mirrors multiple-logistic-regression.ts, with glm(family = poisson /
// quasipoisson) in place of glm(family = binomial).
import type { AnalysisOutcome, Column, PoissonRegressionParams, RegressionCoefficient, StatRow } from "../types";
import { describe, pairedGroups, rVec } from "../column/base";
import { droppedPredictorsNote, selectPredictors } from "./predictors";
import { evalNamedVector } from "../webr";
import { num } from "../../lib/format";

/** Non-convergence makes glm's numbers untrustworthy (huge coefficients, no
 *  convergence): R still returns numbers, so the guard below refuses to
 *  present them — same shape as plan 11's separation guard. */
const NONCONVERGENCE_ERROR =
  "The Poisson model did not converge — the rate ratios are not estimable. " +
  "Try different predictors, or collect more data where the counts overlap.";

export async function runPoissonRegression(
  columns: Column[],
  params: PoissonRegressionParams | undefined,
): Promise<AnalysisOutcome> {
  const { dep, predictors, dropped } = selectPredictors(columns, params);
  if (!dep || predictors.length < 1) {
    return {
      error: "Poisson regression needs a dependent variable and at least one other variable with data.",
    };
  }

  // Complete cases: the rows where every variable used has a value.
  const used = [dep, ...predictors];
  const aligned = pairedGroups(used).map((g) => g.values);
  const n = aligned[0].length;
  const p = predictors.length;

  // The outcome must hold whole-number counts (blanks are already dropped as
  // incomplete rows). R's glm would accept non-integers with a warning, but
  // silently fitting a Poisson model to non-counts is worse than refusing.
  const bad = aligned[0].find((v) => !Number.isInteger(v) || v < 0);
  if (bad !== undefined) {
    return {
      error: `“${dep.name}” holds ${bad}, but Poisson regression needs whole-number counts (0, 1, 2, …).`,
    };
  }
  if (aligned[0].every((v) => v === 0)) {
    return { error: "The outcome is all zeros — Poisson regression needs counts that vary." };
  }
  if (n <= p + 1) {
    return { error: `Not enough complete rows (${n}) to fit ${p} predictor(s). Enter more data and try again.` };
  }

  const quasi = params?.quasi ?? false;
  const decls = [`y<-${rVec(aligned[0])}`, ...predictors.map((_, i) => `x${i}<-${rVec(aligned[i + 1])}`)];
  const formula = `y~${predictors.map((_, i) => `x${i}`).join("+")}`;
  // Each coefficient row t (0 = intercept) pulled from summary()'s coefficient
  // matrix by explicit index → keyed names, so extraction never depends on order.
  // Column 3 of a glm coefficient matrix is the z value, not a t value. Rate
  // ratios (per predictor only) are Wald: exp(estimate ± 1.96·SE). Under
  // quasipoisson the coefficient matrix's SEs are already scaled by
  // sqrt(dispersion) — the runner scales nothing itself.
  const coefAssigns = Array.from({ length: p + 1 }, (_, t) => {
    const base = `b${t}=co[${t + 1},1],se${t}=co[${t + 1},2],z${t}=co[${t + 1},3],pv${t}=co[${t + 1},4]`;
    return t === 0
      ? base
      : `${base},rr${t}=exp(co[${t + 1},1]),rrLo${t}=exp(co[${t + 1},1]-1.96*co[${t + 1},2]),rrHi${t}=exp(co[${t + 1},1]+1.96*co[${t + 1},2])`;
  });
  // AIC is dropped under quasi-Poisson: a quasi-likelihood has no true AIC
  // (R's m$aic is NA there). The dispersion row, from summary()'s dispersion,
  // is the scaling factor the quasi fit actually used (Pearson-based).
  const code =
    `${decls.join(";")};m<-glm(${formula},family=${quasi ? "quasipoisson" : "poisson"});s<-summary(m);co<-s$coefficients;` +
    `c(dev=m$deviance,nulldev=m$null.deviance,residDf=m$df.residual,` +
    `pearson=sum(residuals(m,type="pearson")^2),converged=as.numeric(m$converged),` +
    `${quasi ? "disp=s$dispersion," : "aic=m$aic,"}${coefAssigns.join(",")})`;

  const v = await evalNamedVector(code);
  const terms = ["Intercept", ...predictors.map((c) => c.name)];
  const coefficients: RegressionCoefficient[] = terms.map((term, t) => ({
    term,
    estimate: v[`b${t}`] ?? null,
    stdError: v[`se${t}`] ?? null,
    t: v[`z${t}`] ?? null,
    p: v[`pv${t}`] ?? null,
  }));
  // glm's warnings (non-convergence) are swallowed by evalNamedVector, so a
  // divergent fit is caught here from the fit itself: no convergence, a huge
  // |coefficient|, or a missing/non-finite standard error.
  const diverged =
    v.converged !== 1 ||
    coefficients.some((c) => c.estimate == null || !Number.isFinite(c.estimate) || Math.abs(c.estimate) > 30) ||
    coefficients.some((c) => c.stdError == null || !Number.isFinite(c.stdError));
  if (diverged) return { error: NONCONVERGENCE_ERROR };

  // Dispersion, two estimators: deviance-based and Pearson-based. The verdict
  // uses the Pearson one — the standard choice, and the one quasipoisson uses.
  const residDf = v.residDf ?? null;
  const pearson = v.pearson ?? null;
  const phiPearson = pearson != null && residDf != null && residDf !== 0 ? pearson / residDf : null;
  const phiDeviance = v.dev != null && residDf != null && residDf !== 0 ? v.dev / residDf : null;
  const stats: StatRow[] = [
    ...predictors.flatMap((c, i) => {
      const t = i + 1;
      return [
        { label: `Rate ratio (${c.name})`, value: v[`rr${t}`] ?? null },
        { label: `Rate ratio 95% CI lower (${c.name})`, value: v[`rrLo${t}`] ?? null },
        { label: `Rate ratio 95% CI upper (${c.name})`, value: v[`rrHi${t}`] ?? null },
      ];
    }),
    { label: "Residual deviance", value: v.dev ?? null },
    { label: "Null deviance", value: v.nulldev ?? null },
    { label: "Residual df", value: residDf },
    ...(quasi ? [] : [{ label: "AIC", value: v.aic ?? null }]),
    { label: "Pearson chi-square", value: pearson },
    { label: "Dispersion (Pearson)", value: phiPearson },
    { label: "Dispersion (deviance)", value: phiDeviance },
    ...(quasi ? [{ label: "Quasi-Poisson dispersion", value: v.disp ?? null }] : []),
    { label: "Complete rows (n)", value: n },
    { label: "Predictors", value: p },
  ];

  const described = (await describe(pairedGroups(used))).groups;
  // log(count) = b0 + b1·X1 + b2·X2 + …
  const b0 = v.b0;
  const equation =
    b0 == null
      ? undefined
      : `log(${dep.name}) = ${num(b0)} ${predictors
          .map((c, i) => {
            const b = v[`b${i + 1}`];
            return b == null ? null : `${b < 0 ? "−" : "+"} ${num(Math.abs(b))}·${c.name}`;
          })
          .filter((s): s is string => s !== null)
          .join(" ")}`;

  // The dispersion verdict, first: overdispersion warns (and points at the
  // quasi-Poisson refit — never auto-switched, the model choice stays the
  // user's); underdispersion is informational; otherwise one consistent line.
  // Under quasi the verdict says how the SEs were scaled instead.
  const verdict =
    quasi && phiPearson != null
      ? `Quasi-Poisson refit (dispersion φ = ${num(phiPearson)}): standard errors and P values are scaled by √φ = ${num(Math.sqrt(phiPearson))}; the coefficients are unchanged from the standard Poisson fit.`
      : phiPearson != null && phiPearson > 1.5
        ? `Counts are overdispersed (dispersion φ = ${num(phiPearson)}) — standard errors and P values are too optimistic. Re-run with quasi-Poisson.`
        : phiPearson != null && phiPearson < 0.5
          ? `Counts are underdispersed (dispersion φ = ${num(phiPearson)}) — counts vary less than Poisson expects; standard errors may be conservative.`
          : phiPearson != null
            ? `Dispersion φ = ${num(phiPearson)} — consistent with Poisson.`
            : "Dispersion could not be computed.";

  return {
    testType: "poisson-regression",
    subtitle: "Poisson regression",
    equation,
    stats,
    groups: described,
    notes:
      `${verdict} ` +
      `Poisson regression of “${dep.name}” on ${p} predictor(s), fit on ${n} complete rows. ` +
      "The rate ratios are per one-unit increase in each predictor, with Wald 95% confidence intervals (a normal approximation). " +
      "Each predictor's P value tests whether its coefficient differs from zero, holding the others fixed." +
      droppedPredictorsNote(dropped),
    coefficients,
    // The coefficients table's statistic is a z, not a t.
    statisticLabel: "z",
  };
}
