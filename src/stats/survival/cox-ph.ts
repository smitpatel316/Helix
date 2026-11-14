// Cox proportional-hazards regression on a Multiple Variables table: survival
// times + censoring codes + covariates, fit with survival::coxph() (plan 00
// provisions the package). Bespoke async runner (not ColumnTestSpec) — needs
// named time/status/covariate columns and a coefficients table, like
// src/stats/multiple/multiple-regression.ts. Reports hazard ratios with 95%
// CIs per covariate, the likelihood-ratio / Wald / score tests, and
// concordance. No centring: centring does not change a Cox slope, and the
// model has no intercept (stated in notes).
import type {
  AnalysisOutcome,
  Column,
  CoxPHParams,
  GroupDescriptives,
  RegressionCoefficient,
  StatRow,
} from "../types";
import { dataGroups, describe, pairedGroups, pRow, rVec } from "../column/base";
import { evalNamedVector } from "../webr";
import { num } from "../../lib/format";

/** The user-facing error when the `survival` package cannot be loaded — never
 *  a raw R error (plan 00). */
export const SURVIVAL_PACKAGE_ERROR =
  "The survival R package is not available in this build — see plan 00.";

/** A column's rows holding a non-numeric cell while the row is a subject row
 *  (it has a value in another used column): the value that cannot be a time
 *  or a code. */
function nonNumericCell(column: Column, subjectRows: ReadonlySet<number>): string | null {
  for (let i = 0; i < column.cells.length; i++) {
    if (column.cells[i] != null && column.byRow[i] == null && subjectRows.has(i)) return column.cells[i];
  }
  return null;
}

export async function runCoxPH(
  columns: Column[],
  params: CoxPHParams | undefined,
): Promise<AnalysisOutcome> {
  const vars = dataGroups(columns);
  if (vars.length < 3) {
    return { error: "Cox regression needs a time column, a status column and at least one covariate." };
  }
  const resolve = (name: string | undefined, fallback: Column | undefined, role: string): Column | { error: string } => {
    if (name === undefined) return fallback ?? { error: `Cox regression needs a ${role} column.` };
    const found = columns.find((c) => c.name === name);
    if (!found) return { error: `The column “${name}” is no longer in the table. Create this analysis again to choose another.` };
    if (!found.values.length) return { error: `The column “${name}” holds no numbers — it cannot be the ${role} column.` };
    return found;
  };
  const timeCol = resolve(params?.time, vars[0], "time");
  if ("error" in timeCol) return timeCol;
  const statusCol = resolve(params?.status, vars[1], "status");
  if ("error" in statusCol) return statusCol;
  if (timeCol === statusCol) {
    return { error: "The time and status columns must be different columns." };
  }
  const chosen = params?.covariates;
  if (chosen !== undefined && chosen.length === 0) {
    return { error: "Cox regression needs at least one covariate — choose one or more columns." };
  }
  const covariates = (chosen && chosen.length > 0
    ? chosen.map((name) => vars.find((c) => c.name === name) ?? columns.find((c) => c.name === name))
    : vars.filter((c) => c !== timeCol && c !== statusCol)
  ).filter((c): c is Column => c !== undefined);
  if (chosen !== undefined && covariates.length < chosen.length) {
    const missing = chosen.find((name) => !covariates.some((c) => c.name === name));
    return { error: `The column “${missing}” is no longer in the table. Create this analysis again to choose another.` };
  }
  const badCovariate = covariates.find((c) => !c.values.length);
  if (badCovariate) {
    return {
      error: `Multi-level categorical covariates are not yet supported — use a 0/1 column. “${badCovariate.name}” holds no numbers.`,
    };
  }
  if (covariates.length === 0) {
    return { error: "Cox regression needs at least one covariate — choose one or more columns." };
  }
  if (covariates.some((c) => c === timeCol || c === statusCol)) {
    return { error: "The time, status and covariate columns must all be different columns." };
  }

  // Complete cases: the rows where every variable used has a value.
  const used = [timeCol, statusCol, ...covariates];
  const subjectRows = new Set(used.flatMap((c) => c.rows));
  const total = subjectRows.size;
  const badTime = nonNumericCell(timeCol, subjectRows);
  if (badTime !== null) {
    return { error: `Survival times must be numbers — “${timeCol.name}” holds “${badTime}”.` };
  }
  const badStatus = nonNumericCell(statusCol, subjectRows);
  if (badStatus !== null) {
    return {
      error: `“${statusCol.name}” holds “${badStatus}”, but survival codes must be 1 (event) or 0 (censored).`,
    };
  }
  const aligned = pairedGroups(used).map((g) => g.values);
  const n = aligned[0].length;
  const times = aligned[0];
  const status = aligned[1];
  const p = covariates.length;
  // A covariate with no variation cannot be fit (coxph would return NA).
  // The check runs on the complete cases, not the raw columns — a covariate
  // can vary only on rows another used column leaves blank, and be constant
  // once those rows are dropped.
  if (n > 0) {
    const constantIdx = aligned.slice(2).findIndex((col) => col.every((v) => v === col[0]));
    if (constantIdx >= 0) {
      return { error: `Covariate “${covariates[constantIdx].name}” has no variation.` };
    }
  }
  const badTimeValue = times.find((t) => t <= 0);
  if (badTimeValue !== undefined) {
    return { error: `Survival times must be positive — “${timeCol.name}” holds ${num(badTimeValue)}.` };
  }
  const badCode = status.find((c) => c !== 0 && c !== 1);
  if (badCode !== undefined) {
    return {
      error: `“${statusCol.name}” holds ${num(badCode)}, but survival codes must be 1 (event) or 0 (censored).`,
    };
  }
  const events = status.filter((c) => c === 1).length;
  if (events < 2) {
    return { error: "Cox regression needs at least 2 events." };
  }
  if (events < p + 1) {
    return {
      error: `Too few events (${events}) to fit ${p} covariate(s) — Cox regression needs at least ${p + 1} events.`,
    };
  }
  const censored = n - events;

  const ties = params?.ties ?? "efron";
  const decls = [
    `time<-${rVec(times)}`,
    `status<-${rVec(status)}`,
    ...covariates.map((_, i) => `x${i}<-${rVec(aligned[i + 2])}`),
  ];
  const formula = `survival::Surv(time,status)~${covariates.map((_, i) => `x${i}`).join("+")}`;
  // Each coefficient row pulled from summary()'s coefficient matrix by explicit
  // index → keyed names, so extraction never depends on order. coxph warnings
  // (e.g. separation / monotone likelihood) are collected, not muffled away:
  // the fit reports them in notes.
  const coefAssigns = Array.from(
    { length: p },
    (_, i) =>
      `b${i}=co[${i + 1},1],hr${i}=co[${i + 1},2],se${i}=co[${i + 1},3],z${i}=co[${i + 1},4],pv${i}=co[${i + 1},5],` +
      `lo${i}=ci[${i + 1},1],hi${i}=ci[${i + 1},2]`,
  );
  const code =
    `${decls.join(";")};warns<-c();` +
    `m<-withCallingHandlers(survival::coxph(${formula},ties=${JSON.stringify(ties)}),` +
    `warning=function(w){warns<<-c(warns,conditionMessage(w));invokeRestart("muffleWarning")});` +
    `s<-summary(m);co<-s$coefficients;ci<-exp(confint(m));` +
    `lt<-s$logtest;wt<-s$waldtest;st<-s$sctest;cc<-s$concordance;` +
    `c(${coefAssigns.join(",")},` +
    `lr=unname(lt[1]),lrdf=unname(lt[2]),lrp=unname(lt[3]),` +
    `wald=unname(wt[1]),walddf=unname(wt[2]),waldp=unname(wt[3]),` +
    `score=unname(st[1]),scoredf=unname(st[2]),scorep=unname(st[3]),` +
    `conc=unname(cc[1]),concse=unname(cc[2]),ll1=m$loglik[2],ll0=m$loglik[1],` +
    `warned=as.numeric(length(warns)>0))`;

  let v: Awaited<ReturnType<typeof evalNamedVector>>;
  try {
    v = await evalNamedVector(code);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/there is no package called|package.*survival|survival.*package/i.test(detail)) {
      return { error: SURVIVAL_PACKAGE_ERROR };
    }
    // A coxph failure (e.g. singular fit) surfaces verbatim, not wrapped in
    // another layer — the runner returns it, runAnalysis does not re-wrap it.
    return { error: detail };
  }
  // A coefficient coxph could not estimate (NA — perfectly collinear
  // covariates, or separation / monotone likelihood) is an error, not a
  // fabricated hazard ratio.
  const unestimable = covariates.find((_, i) => v[`b${i}`] == null);
  if (unestimable) {
    return {
      error:
        `Cox regression could not estimate a coefficient for “${unestimable.name}” — ` +
        "it is collinear with another covariate, or the data separate the outcome (all events in one group). " +
        "Drop or recode the covariate and try again.",
    };
  }
  const coefficients: RegressionCoefficient[] = covariates.map((c, i) => ({
    term: c.name,
    estimate: v[`b${i}`] ?? null,
    stdError: v[`se${i}`] ?? null,
    // The Wald z goes in the `t` field (the results view labels the column
    // from statisticLabel, "z" here) — never silently relabelled as a t.
    t: v[`z${i}`] ?? null,
    p: v[`pv${i}`] ?? null,
    hazardRatio: v[`hr${i}`] ?? null,
    low: v[`lo${i}`] ?? null,
    high: v[`hi${i}`] ?? null,
  }));
  const described: GroupDescriptives[] = (await describe(pairedGroups(used))).groups;
  const stats: StatRow[] = [
    { label: "Concordance", value: v.conc ?? null },
    { label: "Concordance SE", value: v.concse ?? null },
    { label: "Likelihood ratio chi-square", value: v.lr ?? null },
    { label: "Likelihood ratio df", value: v.lrdf ?? null },
    pRow("Likelihood ratio P value", v.lrp ?? null),
    { label: "Wald chi-square", value: v.wald ?? null },
    { label: "Wald df", value: v.walddf ?? null },
    pRow("Wald P value", v.waldp ?? null),
    { label: "Score (log-rank) chi-square", value: v.score ?? null },
    { label: "Score (log-rank) df", value: v.scoredf ?? null },
    pRow("Score (log-rank) P value", v.scorep ?? null),
    { label: "Number of events", value: events },
    { label: "Number censored", value: censored },
    { label: "N (complete cases)", value: n },
  ];
  const dropped = total - n;
  const eventsPerCovariate = events / p;
  const notes =
    `Cox proportional-hazards regression of survival in “${timeCol.name}” (status “${statusCol.name}”: ` +
    `1 = event, 0 = censored) on ${p} covariate(s): ${covariates.map((c) => c.name).join(", ")}. ` +
    `Ties handled by the ${ties === "efron" ? "Efron" : "Breslow"} method. ` +
    `Covariates were entered as recorded (no centring — centring does not change a Cox slope, and the model has no intercept). ` +
    `Log partial likelihood ${num(v.ll1)} (vs ${num(v.ll0)} at β = 0). ` +
    `Proportional-hazards assumption not tested in this version — see sub-task 3 (diagnostics).` +
    (dropped > 0 ? ` ${dropped} row${dropped === 1 ? "" : "s"} left out for missing data (${n} complete of ${total}).` : "") +
    (eventsPerCovariate < 10
      ? ` Only ${events} event${events === 1 ? "" : "s"} for ${p} covariate(s) (${num(eventsPerCovariate)} per covariate) — fewer than 10 per covariate, so hazard ratios are imprecise.`
      : "") +
    (v.warned === 1
      ? " coxph() issued a warning while fitting (often separation / monotone likelihood) — hazard ratios and standard errors may be unreliable."
      : "");
  return {
    testType: "cox-proportional-hazards",
    subtitle: "Cox proportional-hazards regression",
    statisticLabel: "z",
    stats,
    groups: described,
    notes,
    coefficients,
  };
}
