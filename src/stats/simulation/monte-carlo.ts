// Monte Carlo (plan 22, sub-task b): repeat a chosen analysis `repeats`
// times on simulated data and summarise the chosen statistic — its mean, SD,
// 95% percentile interval, and (for a P value) the share of repeats with
// P < 0.05, i.e. the estimated power.
//
// How the repeats run — the plan's 10,000-repeat power case, done naively
// (one webR round-trip per repeat), takes ~5 minutes (measured Nov 10:
// ~29 ms per repeat). So the whole loop runs INSIDE R in one call:
// `replicate()` draws every repeat and computes its statistic, and the one
// `evalNumericVector` call returns the observed statistic (on the real data)
// followed by the `repeats` simulated ones. The simulated datasets are
// transient — they never become tables, and nothing here touches the
// `runAnalysis` cache. The binding constraint is time, not vector size:
// 10,000 two-sample t-tests take ~15–25 s in webR (measured Nov 11), so
// `repeats` caps at 10,000 and the repeats × values-per-repeat guard below
// is a sanity check, not the plan's literal 200,000 cap (that cap assumed
// one round-trip per repeat returning all simulated values; the in-R loop
// returns only repeats + 1 numbers).
import type {
  AnalysisOutcome,
  Column,
  MonteCarloParams,
  MonteCarloStatistic,
  MonteCarloTarget,
  StatRow,
} from "../types";
import { MONTE_CARLO_REPEATS, MONTE_CARLO_TARGET_STATISTICS } from "../types";
import { dataGroups, describe } from "../column/base";
import { evalNumericVector } from "../webr";
import { computeFrequencyBins } from "../column/frequency-distribution";
import { pairUp, splitXY } from "../../lib/dataset";

/** Sanity guard on repeats × values drawn per repeat (see the header note):
 *  far above anything a 10,000-repeat run needs (10,000 × 200), far below
 *  anything that would strain R. */
export const MONTE_CARLO_MAX_SIMULATED = 2_000_000;

/** The R code a Monte Carlo run is: `set.seed()` once, then one
 *  `replicate()` that draws every repeat and its statistic, plus the same
 *  statistic on the observed data — returned as one vector, the observed
 *  value first. Pure — unit-tested without R. */
export interface MonteCarloCodeSpec {
  target: MonteCarloTarget;
  statistic: MonteCarloStatistic;
  repeats: number;
  seed: number;
  /** One entry per simulated group: how many values, and from which Gaussian. */
  groups: { n: number; mean: number; sd: number; observed: number[] }[];
  /** X values (XY targets): fixed across repeats. */
  x?: number[];
  equalVariance?: boolean;
  hypotheticalValue?: number;
  method?: "pearson" | "spearman";
}

export function monteCarloRCode(spec: MonteCarloCodeSpec): string {
  const draw = (g: { n: number; mean: number; sd: number }) => `rnorm(${g.n},${g.mean},${g.sd})`;
  const obs = (i: number) => `c(${spec.groups[i].observed.join(",")})`;
  // The statistic as R computes it, from the drawn values (`g1`, `g2`…) or
  // the observed ones (`o1`, `o2`…) — one expression shape per target.
  const stat = (v: string[]): string => {
    switch (spec.target) {
      case "compare-two-groups": {
        const eq = spec.equalVariance !== false ? "var.equal=TRUE" : "var.equal=FALSE";
        return spec.statistic === "Mean difference"
          ? `mean(${v[0]})-mean(${v[1]})`
          : `t.test(${v[0]},${v[1]},${eq})$p.value`;
      }
      case "one-sample-t":
        return spec.statistic === "Mean"
          ? `mean(${v[0]})`
          : `t.test(${v[0]},mu=${spec.hypotheticalValue ?? 0})$p.value`;
      case "descriptive-statistics":
        return `mean(${v[0]})`;
      case "linear-regression":
        return spec.statistic === "Y-intercept"
          ? `coef(lm(${v[0]}~x))[1]`
          : `coef(lm(${v[0]}~x))[2]`;
      case "correlation":
        return `cor(x,${v[0]},method=${JSON.stringify(spec.method ?? "pearson")})`;
    }
  };
  const draws = spec.groups.map((g) => draw(g));
  const repeat = stat(draws);
  const observed = stat(spec.groups.map((_, i) => obs(i)));
  const xDecl = spec.x !== undefined ? `x<-c(${spec.x.join(",")});` : "";
  return `set.seed(${spec.seed});${xDecl}v<-replicate(${spec.repeats},${repeat});o<-${observed};c(o,v)`;
}

/** A percentile by linear interpolation (R's default, type 7): `sorted` must
 *  already be ascending. */
export function percentile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

const meanOf = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;
const sdOf = (values: number[], mean: number): number | null =>
  values.length > 1
    ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1))
    : null;

/** The simulated mean/SD of one group: the wizard's override when given, else
 *  the group's observed mean/SD (a parametric bootstrap). */
function simulatedParams(
  values: number[],
  meanOverride: number | undefined,
  sdOverride: number | undefined,
): { mean: number; sd: number } | { error: string } {
  const mean = meanOverride ?? meanOf(values);
  const sd = sdOverride ?? sdOf(values, meanOf(values));
  if (!Number.isFinite(mean)) return { error: "A group's simulated mean is not a number." };
  if (sd == null || !Number.isFinite(sd) || sd <= 0)
    return { error: "A group's simulated SD must be greater than 0 — a group with no variation cannot be simulated." };
  return { mean, sd };
}

export async function runMonteCarlo(
  columns: Column[],
  params: MonteCarloParams | undefined,
): Promise<AnalysisOutcome> {
  const target = params?.targetAnalysis;
  if (!target || !(MONTE_CARLO_TARGET_STATISTICS as Record<string, readonly string[]>)[target]) {
    return { error: "Monte Carlo needs a target analysis to repeat — pick one and try again." };
  }
  const statistic: MonteCarloStatistic =
    (params?.summaryStatistic as MonteCarloStatistic | undefined) ?? MONTE_CARLO_TARGET_STATISTICS[target][0];
  if (!MONTE_CARLO_TARGET_STATISTICS[target].includes(statistic)) {
    return { error: `“${statistic}” is not a statistic “${target}” reports — pick one it does and try again.` };
  }
  const repeats = params?.repeats ?? 1000;
  if (!Number.isInteger(repeats) || repeats < MONTE_CARLO_REPEATS.min || repeats > MONTE_CARLO_REPEATS.max) {
    return {
      error: `Repeats must be a whole number from ${MONTE_CARLO_REPEATS.min} to ${MONTE_CARLO_REPEATS.max}.`,
    };
  }
  if (!Number.isInteger(params?.seed)) return { error: "The seed must be a whole number." };

  // The groups the repeats simulate: Column targets simulate each data
  // column (compare-two-groups uses the first two — the wizard's `sets`
  // already narrowed them); XY targets simulate the chosen Y series at the
  // source table's X values.
  const groups: { name: string; values: number[] }[] = [];
  let x: number[] | undefined;
  if (target === "linear-regression" || target === "correlation") {
    const { x: xCol, ys } = splitXY(columns);
    const y = params?.y !== undefined ? ys.find((c) => c.name === params.y) : ys[0];
    if (!xCol || !y) return { error: "Monte Carlo needs an X column and a Y data set with values." };
    const pairs = pairUp(xCol, y);
    if (pairs.x.length < 3) {
      return { error: "Monte Carlo needs at least 3 complete X–Y pairs to repeat a regression or correlation." };
    }
    x = pairs.x;
    groups.push({ name: y.name, values: pairs.y });
  } else {
    const data = dataGroups(columns);
    const wanted = target === "compare-two-groups" ? 2 : 1;
    // `sets` rides on AnalysisParams (the DataSetsParam half of the union),
    // not on MonteCarloParams itself.
    const sets = (params as MonteCarloParams & { sets?: string[] } | undefined)?.sets;
    const picked =
      sets && sets.length >= wanted
        ? sets
            .map((name) => data.find((c) => c.name === name))
            .filter((c): c is Column => c !== undefined)
            .slice(0, wanted)
        : data.slice(0, wanted);
    if (picked.length < wanted) {
      return {
        error:
          target === "compare-two-groups"
            ? "Monte Carlo needs 2 data sets with values to repeat a two-group comparison."
            : "Monte Carlo needs a data set with values to repeat.",
      };
    }
    for (const c of picked) groups.push({ name: c.name, values: c.values });
  }
  for (const g of groups) {
    if (g.values.length < 2) {
      return { error: `“${g.name}” has fewer than 2 values — Monte Carlo needs at least 2 per data set.` };
    }
  }
  const perRepeat = groups.reduce((s, g) => s + g.values.length, 0);
  if (repeats * perRepeat > MONTE_CARLO_MAX_SIMULATED) {
    return {
      error: `That is ${repeats} repeats × ${perRepeat} values per repeat — at most ${MONTE_CARLO_MAX_SIMULATED} simulated values. Use fewer repeats.`,
    };
  }
  const simulated: { n: number; mean: number; sd: number; observed: number[] }[] = [];
  for (const g of groups) {
    const p = simulatedParams(g.values, params?.groupMeans?.[g.name], params?.groupSds?.[g.name]);
    if ("error" in p) return p;
    simulated.push({ n: g.values.length, mean: p.mean, sd: p.sd, observed: g.values });
  }

  const all = await evalNumericVector(
    monteCarloRCode({
      target,
      statistic,
      repeats,
      seed: params!.seed,
      groups: simulated,
      x,
      equalVariance: params?.equalVariance,
      hypotheticalValue: params?.hypotheticalValue,
      method: params?.method,
    }),
  );
  if (all.length !== repeats + 1 || all.some((v) => !Number.isFinite(v))) {
    return { error: "The Monte Carlo run did not return the expected values — try again." };
  }
  const observed = all[0];
  const values = all.slice(1);
  const sorted = [...values].sort((a, b) => a - b);
  const mean = meanOf(values);
  const sd = sdOf(values, mean);
  const ciLow = percentile(sorted, 0.025);
  const ciHigh = percentile(sorted, 0.975);
  const proportionSignificant =
    statistic === "P value" ? values.filter((v) => v < 0.05).length / values.length : undefined;
  const { bins } = computeFrequencyBins(values, { binMode: "auto" });
  const { groups: described } = await describe(groups.map((g) => ({ name: g.name, values: g.values })));

  const targetLabel =
    target === "compare-two-groups"
      ? "Compare two groups"
      : target === "one-sample-t"
        ? "Compare one group to a value"
        : target === "descriptive-statistics"
          ? "Descriptive statistics"
          : target === "linear-regression"
            ? "Linear regression"
            : "Correlation";
  const stats: StatRow[] = [
    { label: "Repeats completed", value: repeats },
    { label: `Mean of ${statistic}`, value: mean },
    { label: `SD of ${statistic}`, value: sd },
    { label: "2.5th percentile", value: ciLow },
    { label: "97.5th percentile", value: ciHigh },
    ...(proportionSignificant !== undefined
      ? [{ label: "Power (% P < 0.05)", value: proportionSignificant * 100 }]
      : []),
    { label: "Observed (real data)", value: observed },
    { label: "Seed", value: params!.seed },
  ];
  const simNote = simulated
    .map((s, i) => `“${groups[i].name}”: n = ${s.n}, simulated mean ${s.mean}, SD ${s.sd}`)
    .join("; ");
  const notes =
    `Repeated “${targetLabel}” ${repeats} times on simulated data (seed ${params!.seed}), summarising the ${statistic}. ` +
    `Each repeat drew ${simNote}. ` +
    `The 95% interval is the 2.5th–97.5th percentiles of the ${repeats} simulated ${statistic}s. ` +
    (proportionSignificant !== undefined
      ? `Power is the share of repeats with P < 0.05 — the chance this design detects the simulated effect. `
      : "") +
    `The observed ${statistic} on the real data is ${observed}. ` +
    `Tails are two-sided; the simulation is Gaussian (each group's mean/SD as simulated, or its observed mean/SD when not set).`;
  return {
    testType: "monte-carlo",
    subtitle: `Monte Carlo simulation — ${statistic}`,
    stats,
    groups: described,
    notes,
    monteCarlo: {
      repeats,
      statistic,
      mean,
      sd,
      ciLow,
      ciHigh,
      ...(proportionSignificant !== undefined ? { proportionSignificant } : {}),
      observed,
      bins: { edges: bins.map((b) => b.lower).concat(bins.at(-1)?.upper ?? []), counts: bins.map((b) => b.count) },
    },
  };
}
