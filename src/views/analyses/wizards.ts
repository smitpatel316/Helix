// The questions each analysis asks before it runs, as Prism does: one question per
// step, each answer choosing the next question. A wizard only declares its questions
// and how the answers make the test's params; analysis-wizard.tsx asks them.
// A test without an entry here runs as soon as it is picked.
import { DOSE_MODELS, CONCENTRATION_UNITS, MONTE_CARLO_REPEATS, MONTE_CARLO_TARGET_STATISTICS, NONLINEAR_MODELS, ROUT_Q, routQError, type ConcentrationUnit, type LinearRegressionParams, type MonteCarloStatistic, type MonteCarloTarget, type NonlinearModel } from "../../stats/types";
import type { TableType } from "../../store/types";
import { MODEL_LABEL, termLabel } from "../../stats/xy/nonlinear-regression";
import { modelSpec } from "../../stats/xy/nonlinear-fit";
import { dataGroups, pairedGroups } from "../../stats/column/base";
import { distinctTruthValues } from "../../stats/column/roc-curve";

const isDoseModel = (m: string) => (DOSE_MODELS as readonly string[]).includes(m);
import {
  floorToWidth,
  niceWidthUp,
  sturgesCount,
} from "../../stats/column/frequency-distribution";
import type {
  AnalysisParams,
  AnalysisPickerValue,
  AnalysisType,
  BindingKineticsParams,
  BindingSaturationParams,
  CompareTwoGroupsParams,
  CorrelationParams,
  CoxPHParams,
  DoseResponseSpecialParams,
  EnzymeInhibitionParams,
  FrequencyDistributionParams,
  MultipleTTestsParams,
  NestedAnovaParams,
  NonlinearRegressionParams,
  NormalizeParams,
  OneSampleTParams,
  RemoveBaselineParams,
  PruneRowsParams,
  FractionOfTotalParams,
  SurvivalParams,
  CoxParams,
  PrincipalComponentAnalysisParams,
  ShapiroWilkParams,
  SplineLowessParams,
  ThreeWayAnovaParams,
  TransformFunction,
  TransformConcentrationsParams,
  TwoWayAnovaParams,
  XYCorrelationParams,
} from "../../stats/types";
import { parseInhibitorConcentration } from "../../stats/xy/enzyme-inhibition";
import { columnFactorName } from "../../stats/mixed/mixed-effects";
import { splitXY, type Dataset } from "../../lib/dataset";

export type Answer = string | number | string[];
export type Answers = Record<string, Answer | undefined>;

export type Question = { id: string; ask: string } & (
  | {
      kind: "choice";
      options: { value: string; label: string }[];
      /** Adds "Not sure — check for normality first", answered "yes" or "no" by Shapiro-Wilk. */
      normality?: boolean;
      /** What the wizard says when this choice has no options (M18): the step
       *  is blocked with this message instead of throwing. */
      emptyMessage?: string;
    }
  | {
      kind: "number";
      label: string;
      initial: number;
      min?: number;
      max?: number;
      step?: number;
      validate?: (value: number) => string | undefined;
    }
  /** Several of `options`, all ticked at first: at least `min` (1 by default). */
  | { kind: "names"; options: string[]; min?: number }
  /** Free text, a single line — the answer is the raw string. `parse` checks
   *  it before Next is allowed (blank counts as valid when `parse` says so);
   *  without it, the text must parse as comma-separated numbers. */
  | { kind: "text"; label: string; initial: string; placeholder?: string; parse?: (text: string) => { error?: string } }
);

/** Parse a comma-separated list of numbers (the default check for a `text`
 *  question without its own `parse` — see analysis-wizard.tsx).
 *  Empty entries are ignored; a non-numeric entry, or an empty list, is an
 *  error naming the problem. */
export function parseUnknowns(text: string): { values: number[]; error?: string } {
  const entries = text
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  if (!entries.length) return { values: [], error: "Enter at least one unknown Y value." };
  const bad = entries.find((e) => !Number.isFinite(Number(e)));
  if (bad !== undefined)
    return { values: [], error: `“${bad}” is not a number — enter unknown Y values separated by commas.` };
  return { values: entries.map(Number) };
}

export interface Wizard {
  /** Every question, given the answers so far (false: not asked with these answers). */
  questions: (a: Answers, table: Dataset, type?: TableType) => (Question | false)[];
  /** The test to create, once every question is answered. */
  finish: (a: Answers, table: Dataset, type?: TableType) => { type: AnalysisType; params?: AnalysisParams };
}

/** Parse the spline's spar field: blank = automatic (GCV), otherwise a number
 *  in 0–1.5. `value` is null when blank; `error` is set (and `value` null) when
 *  the text is neither — the runner re-checks, so a bad value passed straight
 *  to `runAnalysis` still fails clearly. */
export function parseSpar(text: string): { value: number | null; error?: string } {
  const t = text.trim();
  if (t === "") return { value: null };
  const v = Number(t);
  if (!Number.isFinite(v))
    return {
      value: null,
      error: `“${t}” is not a number — enter a smoothing parameter between 0 and 1.5, or leave it blank.`,
    };
  if (v < 0 || v > 1.5) return { value: null, error: "The smoothing parameter (spar) must be between 0 and 1.5." };
  return { value: v };
}

/** Parse an optional positive number (the binding kinetics constants):
 *  blank = not supplied, otherwise a number > 0. `value` is undefined when
 *  blank; `error` is set (and `value` undefined) when the text is neither —
 *  the runner re-checks, so a bad value passed straight to `runAnalysis`
 *  still fails clearly. */
export function parseOptionalPositive(text: string, label: string): { value?: number; error?: string } {
  const t = text.trim();
  if (t === "") return {};
  const v = Number(t);
  if (!Number.isFinite(v)) return { error: `“${t}” is not a number — enter a ${label}, or leave it blank.` };
  if (v <= 0) return { error: `The ${label} must be greater than 0.` };
  return { value: v };
}

/** Parse an optional number (a fixed parameter, plan 26): blank = fit it,
 *  otherwise a finite number. `value` is undefined when blank; `error` is
 *  set (and `value` undefined) when the text is neither — the runner
 *  re-checks, so a bad value passed straight to `runAnalysis` still fails
 *  clearly. */
export function parseOptionalNumber(text: string, label: string): { value?: number; error?: string } {
  const t = text.trim();
  if (t === "") return {};
  const v = Number(t);
  if (!Number.isFinite(v)) return { error: `“${t}” is not a number — enter a ${label}, or leave it blank to fit it.` };
  return { value: v };
}

/** Parse optional bounds "lower, upper" (plan 26): blank = unbounded,
 *  otherwise two numbers with lower < upper. */
export function parseOptionalBounds(text: string, label: string): { value?: [number, number]; error?: string } {
  const t = text.trim();
  if (t === "") return {};
  const parts = t.split(",").map((p) => p.trim());
  if (parts.length !== 2)
    return { error: `Enter ${label} bounds as “lower, upper” (e.g. “0, 2”), or leave it blank for unbounded.` };
  const [lo, hi] = parts.map(Number);
  if (!Number.isFinite(lo) || !Number.isFinite(hi))
    return { error: `“${t}” is not two numbers — enter bounds as “lower, upper”, or leave it blank.` };
  if (lo >= hi) return { error: `The lower bound (${lo}) must be below the upper bound (${hi}).` };
  return { value: [lo, hi] };
}

/** Parse a required positive number (association-then-dissociation's
 *  HotNM / Time0): blank is an error — the wizard must not proceed without it. */
export function parseRequiredPositive(text: string, label: string): { value?: number; error?: string } {
  const t = text.trim();
  if (t === "") return { error: `Enter a ${label} — it is required for this model.` };
  const parsed = parseOptionalPositive(t, label);
  return parsed.error ? parsed : { value: parsed.value };
}

/** Parse a required non-negative number (an inhibitor concentration — 0 is
 *  the uninhibited series): blank is an error — the wizard must not
 *  proceed without it. */
export function parseRequiredNonNegative(text: string, label: string): { value?: number; error?: string } {
  const t = text.trim();
  if (t === "") return { error: `Enter a ${label} — it is required.` };
  const v = Number(t);
  if (!Number.isFinite(v)) return { error: `“${t}” is not a number — enter a ${label}.` };
  if (v < 0) return { error: `The ${label} cannot be negative.` };
  return { value: v };
}

/** Split a comma-separated per-row group-level list (the mixed-effects
 *  subject factor): one level per table row, in row order. */
export function splitGroupLevels(text: string): string[] {
  return text.split(",").map((e) => e.trim());
}

/** Validate a per-row group-level list against the table's row count: blank
 *  is an error (the wizard must not proceed without it), as is a count that
 *  does not match the rows, a blank level, or a single distinct level. */
export function parseGroupLevels(text: string, rowCount: number): { values: string[]; error?: string } {
  const levels = splitGroupLevels(text);
  if (levels.length === 1 && levels[0] === "") {
    return { values: [], error: `Enter one group level per row (${rowCount} rows), separated by commas.` };
  }
  if (levels.length !== rowCount) {
    return {
      values: [],
      error: `Enter one group level per row — found ${levels.length} for ${rowCount} rows.`,
    };
  }
  const blank = levels.findIndex((l) => l === "");
  if (blank !== -1) {
    return { values: [], error: `Every row needs a group level — row ${blank + 1} is blank.` };
  }
  if (new Set(levels).size < 2) {
    return { values: [], error: `The group factor needs at least two levels — all rows are “${levels[0]}”.` };
  }
  return { values: levels };
}

export interface Wizard {
  /** Every question, given the answers so far (false: not asked with these answers).
   *  `tableType` scopes the questions to the table's kind (the Monte Carlo
   *  wizard offers different targets for Column and XY tables); wizards that
   *  don't need it ignore it, and callers without a table pass none. */
  questions: (a: Answers, table: Dataset, tableType?: TableType) => (Question | false)[];
  /** The test to create, once every question is answered. */
  finish: (a: Answers, table: Dataset, tableType?: TableType) => { type: AnalysisType; params?: AnalysisParams };
  /** The assumptions checklist for the test this wizard is building, given
   *  the answers so far — so the checklist follows the branch taken (a
   *  parametric answer gets the t-test checklist, a non-parametric one the
   *  rank-test checklist). Absent: the wizard has no checklist yet, and the
   *  setup shows none. */
  checklist?: (a: Answers, table: Dataset, tableType?: TableType) => AnalysisChecklist | undefined;
}

/** One line of an analysis checklist: an assumption to check before running
 *  the test, and what it means (or what to do instead) when it does not hold.
 *  Content is written from the statistical definitions, in our own words. */
export interface ChecklistItem {
  /** The assumption or condition, in plain words. */
  assumption: string;
  /** What it means / what to do instead when it does not hold. */
  ifNot?: string;
}

/** A checklist for one analysis: when the test is the right one, and the
 *  assumptions to check before running it. Shown in the setup wizard,
 *  alongside the questions — not buried in the results. */
export interface AnalysisChecklist {
  /** Short heading, e.g. "One-sample t test — checklist". */
  title: string;
  /** When this test is the right one. */
  whenToUse: string;
  items: ChecklistItem[];
}

const choice = (
  id: string,
  ask: string,
  options: [string, string][],
  normality = false,
  emptyMessage?: string,
): Question => ({
  id,
  ask,
  kind: "choice",
  options: options.map(([value, label]) => ({ value, label })),
  normality,
  ...(emptyMessage ? { emptyMessage } : {}),
});

const names = (list: string[]) => list.map((n): [string, string] => [n, n]);

/** The Y data sets to fit, all ticked at first (asked when there is a choice); one answered
 *  is the regression's `y`, several its `ys`. A lone `y` answer (the pre-1.0.9 shape, and
 *  what a caller passing one data set writes) counts as that one set. */
const ysQuestion = (table: Dataset, ask: string): Question | false =>
  yNames(table).length > 1 && { id: "ys", ask, kind: "names", options: yNames(table), min: 1 };
const fittedYs = (a: Answers) => {
  const ys = (a.ys as string[] | undefined) ?? (a.y !== undefined ? [a.y as string] : undefined);
  return ys === undefined ? {} : ys.length === 1 ? { y: ys[0] } : { ys };
};
const yNames = (table: Dataset) => splitXY(table.columns).ys.map((c) => c.name);
const dataNames = (table: Dataset) => table.numeric.map((c) => c.name);

// Which data sets a test runs on (`sets`), asked first as in Prism, and only when there
// is a choice: columns, or a grouped table's groups, holding numbers.
const setNames = (table: Dataset) =>
  table.sets.filter((s) => s.columns.some((c) => c.values.length > 0)).map((s) => s.name);

/** The two data sets to compare, in order. */
const twoSets = (a: Answers, table: Dataset): Question[] => {
  const sets = setNames(table);
  if (sets.length <= 2) return [];
  return [
    choice("set1", "Which is the first data set?", names(sets)),
    choice("set2", "Which is the second data set?", names(sets.filter((n) => n !== a.set1))),
  ];
};

/** The data sets to analyze, at least `min`, all ticked at first. */
const someSets = (table: Dataset, min: number): Question[] => {
  const sets = setNames(table);
  if (sets.length <= min) return [];
  const ask = min > 1 ? `Choose the data sets to analyze (at least ${min}).` : "Choose the data sets to analyze.";
  return [{ id: "sets", ask, kind: "names", options: sets, min }];
};

/** The names ticked once `name` is ticked (`on`) or not: always in `options`' order,
 *  the table's, whatever order they were clicked in. */
export const toggled = (options: string[], ticked: string[], name: string, on: boolean) =>
  options.filter((n) => (n === name ? on : ticked.includes(n)));

/** A column's observed mean and (sample, n − 1) SD — a Monte Carlo wizard's
 *  starting values for the simulated mean/SD. */
const meanSd = (values: number[]) => {
  const mean = values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
  const sd =
    values.length > 1
      ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1))
      : 0;
  return { mean, sd };
};

/** 6 significant digits — a readable starting value for a simulated mean/SD. */
const round6 = (v: number) => Number(v.toPrecision(6));

/** Whether a grouped table holds replicates: a group with 2 values or more at a row. */
const replicated = (table: Dataset) =>
  table.sets.some((s) => s.columns[0]?.byRow.some((_, r) => s.columns.filter((c) => c.byRow[r] != null).length > 1));

/** The data sets answered, if they were asked. */
export const chosenSets = (a: Answers): string[] | undefined =>
  a.set1 && a.set2 ? [a.set1 as string, a.set2 as string] : (a.sets as string[] | undefined);

/** `params` with the data sets answered. */
const withSets = <P extends object>(a: Answers, params?: P) => {
  const sets = chosenSets(a);
  return sets ? { ...params, sets } : params;
};

/** Whether the table is a Grouped one (column groups with replicate columns),
 *  for the wizards that serve both layouts (mixed-effects): multi-column
 *  sets, or a ":" in a column name (a grouped table with one replicate per
 *  group has one-column sets). */
const isGroupedTable = (table: Dataset) =>
  table.sets.some((s) => s.columns.length > 1) || table.columns.some((c) => c.name.includes(":"));

const GAUSSIAN = "Assume the data are sampled from Gaussian (normal) distributions?";
const PAIRED = "How were the data collected?";

/** The key of a checklist in CHECKLISTS. */
export type ChecklistKey =
  | "one-sample-t"
  | "wilcoxon-signed-rank"
  | "two-sample-t"
  | "paired-t"
  | "mann-whitney"
  | "wilcoxon-paired"
  | "anova"
  | "kruskal-wallis"
  | "rm-anova"
  | "friedman"
  | "two-way-anova"
  | "two-way-anova-rm"
  | "two-way-anova-srh"
  | "three-way-anova"
  | "linear-regression"
  | "nonlinear-regression"
  | "survival"
  | "cox-ph"
  | "correlation-pearson"
  | "correlation-spearman";

/** The assumption checklists: one per analysis (or per branch of one — a
 *  t test and its rank-based alternative check different things). Content is
 *  factual assumption lists written in our own words from the statistical
 *  definitions; each item says what to do when the assumption does not hold,
 *  so the checklist is advice, not just a warning. */
export const CHECKLISTS: Record<ChecklistKey, AnalysisChecklist> = {
  "one-sample-t": {
    title: "One-sample t test — checklist",
    whenToUse:
      "Use this when you have one group of numbers and want to test whether its mean differs from a value you chose before seeing the data.",
    items: [
      {
        assumption: "The values are numbers on a continuous scale — measurements, not counts or categories.",
        ifNot: "For counts or categories a t test does not apply; use a test built for that kind of data.",
      },
      {
        assumption:
          "Each value is independent — no value is a repeat measurement of another, and no two values come from the same subject.",
        ifNot: "Repeated or matched values need a paired test instead.",
      },
      {
        assumption:
          "The values are roughly symmetric around their mean (no strong skew), or the sample is large enough that the mean still behaves well.",
        ifNot:
          "With skewed data or a small sample, use the Wilcoxon signed-rank test (answer “No” to the Gaussian question) or transform the data first.",
      },
      {
        assumption: "No single value dominates the result — check for extreme outliers before trusting the mean.",
        ifNot: "Investigate outliers first; one extreme value can move the mean and the P value a lot.",
      },
      {
        assumption:
          "The hypothetical value was picked before looking at the data, not chosen to match the observed mean.",
        ifNot: "Testing against a value picked from the same data makes the P value meaningless.",
      },
    ],
  },
  "wilcoxon-signed-rank": {
    title: "Wilcoxon signed-rank test — checklist",
    whenToUse:
      "Use this when you have one group of numbers and want to test whether its median differs from a chosen value, without assuming the values follow a normal distribution.",
    items: [
      {
        assumption:
          "The values are numbers on a continuous scale, or at least ordered — the test ranks the distances from the hypothetical value.",
        ifNot: "For unordered categories this test does not apply.",
      },
      {
        assumption: "Each value is independent — no value is a repeat measurement of another.",
        ifNot: "Repeated or matched values need a paired test instead.",
      },
      {
        assumption: "The values are roughly symmetric around their median, so the median is a fair centre to test.",
        ifNot:
          "With a strongly lopsided distribution, consider the sign test, which only asks whether values fall above or below the hypothetical value.",
      },
      {
        assumption:
          "The hypothetical value was picked before looking at the data, not chosen to match the observed median.",
        ifNot: "Testing against a value picked from the same data makes the P value meaningless.",
      },
    ],
  },
  "two-sample-t": {
    title: "Unpaired t test — checklist",
    whenToUse: "Use this when you have two independent groups of numbers and want to test whether their means differ.",
    items: [
      {
        assumption:
          "The two groups are independent — no subject appears in both groups, and no value in one group is matched to a value in the other.",
        ifNot: "Matched or repeated measurements need a paired t test instead.",
      },
      {
        assumption: "The outcome is a number on a continuous scale in both groups.",
        ifNot: "For counts or categories a t test does not apply; use a test built for that kind of data.",
      },
      {
        assumption:
          "Each group is roughly symmetric around its mean (no strong skew), or each group is large enough that its mean still behaves well.",
        ifNot:
          "With skewed data or small groups, use the Mann-Whitney test (answer “No” to the Gaussian question) or transform the data first.",
      },
      {
        assumption: "The two groups have similar spread — the t test pools their variances.",
        ifNot:
          "When the spreads clearly differ, use Welch's t test (answer “No” to the equal-variances question); it does not pool the variances.",
      },
      {
        assumption: "No single value dominates either group — check for extreme outliers before trusting the means.",
        ifNot: "Investigate outliers first; one extreme value can move a mean and the P value a lot.",
      },
    ],
  },
  "paired-t": {
    title: "Paired t test — checklist",
    whenToUse:
      "Use this when each value in one group is matched to one value in the other — the same subject measured twice, or matched pairs — and you want to test whether the mean difference is zero.",
    items: [
      {
        assumption:
          "The pairing is real: each pair belongs together (same subject, or a deliberate match), and the difference within a pair is what matters.",
        ifNot:
          "If the groups are actually independent, use an unpaired t test — pairing unrelated values throws away information.",
      },
      {
        assumption:
          "The differences between pairs are roughly symmetric around their mean (no strong skew), or there are enough pairs that the mean difference still behaves well.",
        ifNot:
          "With skewed differences or few pairs, use the Wilcoxon signed-rank test (answer “No” to the Gaussian question) or transform the data first.",
      },
      {
        assumption:
          "The pairs are independent of each other — no subject appears in two pairs, and no pair shares a subject with another.",
        ifNot: "Overlapping pairs need a model that accounts for the sharing, such as a mixed-effects analysis.",
      },
      {
        assumption:
          "No single pair dominates the result — check the largest differences before trusting the mean difference.",
        ifNot:
          "Investigate extreme pairs first; one wild difference can move the mean difference and the P value a lot.",
      },
    ],
  },
  "mann-whitney": {
    title: "Mann-Whitney test — checklist",
    whenToUse:
      "Use this when you have two independent groups and want to test whether one tends to give larger values than the other, without assuming either group follows a normal distribution.",
    items: [
      {
        assumption:
          "The two groups are independent — no subject appears in both groups, and no value in one group is matched to a value in the other.",
        ifNot: "Matched or repeated measurements need a paired rank test instead.",
      },
      {
        assumption:
          "The outcome is at least ordered — numbers, or ranks such as scores — so that values from the two groups can be ranked together.",
        ifNot: "For unordered categories this test does not apply.",
      },
      {
        assumption: "Each group's values are independent of each other within the group.",
        ifNot: "Repeated measurements within a group need a model that accounts for the repeats.",
      },
      {
        assumption:
          "If you want to read the result as a difference in medians, the two distributions have similar shapes and differ mainly in where they sit.",
        ifNot:
          "When the shapes differ a lot, the test still works, but report it as one group tending to larger values — not as a median difference.",
      },
    ],
  },
  "wilcoxon-paired": {
    title: "Wilcoxon signed-rank test (paired) — checklist",
    whenToUse:
      "Use this when each value in one group is matched to one value in the other and you want to test whether the median difference is zero, without assuming the differences follow a normal distribution.",
    items: [
      {
        assumption:
          "The pairing is real: each pair belongs together (same subject, or a deliberate match), and the difference within a pair is what matters.",
        ifNot:
          "If the groups are actually independent, use the Mann-Whitney test — pairing unrelated values throws away information.",
      },
      {
        assumption:
          "The differences are roughly symmetric around their median, so the median is a fair centre to test.",
        ifNot:
          "With a strongly lopsided set of differences, consider the sign test, which only asks whether differences fall above or below zero.",
      },
      {
        assumption: "The pairs are independent of each other — no subject appears in two pairs.",
        ifNot: "Overlapping pairs need a model that accounts for the sharing.",
      },
    ],
  },
  anova: {
    title: "One-way ANOVA — checklist",
    whenToUse:
      "Use this when you have three or more independent groups of numbers and want to test whether any group's mean differs from the others.",
    items: [
      {
        assumption: "The groups are independent — no subject appears in more than one group.",
        ifNot: "Matched or repeated measurements need a repeated-measures ANOVA instead.",
      },
      {
        assumption: "The outcome is a number on a continuous scale in every group.",
        ifNot: "For counts or categories an ANOVA does not apply; use a test built for that kind of data.",
      },
      {
        assumption:
          "Each group is roughly symmetric around its mean (no strong skew), or each group is large enough that its mean still behaves well.",
        ifNot:
          "With skewed data or small groups, use the Kruskal-Wallis test (answer “No” to the Gaussian question) or transform the data first.",
      },
      {
        assumption: "The groups have similar spread — the ANOVA pools their variances.",
        ifNot:
          "When the spreads clearly differ, use Welch's ANOVA (answer “No” to the equal-SDs question); it does not pool the variances.",
      },
      {
        assumption: "No single value dominates any group — check for extreme outliers before trusting the means.",
        ifNot: "Investigate outliers first; one extreme value can move a group mean and the P value a lot.",
      },
      {
        assumption:
          "The comparisons you will run afterwards were planned before seeing the results — the ANOVA only says that some difference exists, not where it is.",
        ifNot:
          "Comparisons picked because the data looked interesting need a stricter correction for multiple testing.",
      },
    ],
  },
  "kruskal-wallis": {
    title: "Kruskal-Wallis test — checklist",
    whenToUse:
      "Use this when you have three or more independent groups and want to test whether one tends to give larger values than the others, without assuming any group follows a normal distribution.",
    items: [
      {
        assumption: "The groups are independent — no subject appears in more than one group.",
        ifNot: "Matched or repeated measurements need the Friedman test instead.",
      },
      {
        assumption:
          "The outcome is at least ordered — numbers, or ranks such as scores — so that values from all groups can be ranked together.",
        ifNot: "For unordered categories this test does not apply.",
      },
      {
        assumption: "Each group's values are independent of each other within the group.",
        ifNot: "Repeated measurements within a group need a model that accounts for the repeats.",
      },
      {
        assumption:
          "If you want to read the result as a difference in medians, the distributions have similar shapes and differ mainly in where they sit.",
        ifNot:
          "When the shapes differ a lot, the test still works, but report it as one group tending to larger values — not as a median difference.",
      },
    ],
  },
  "rm-anova": {
    title: "Repeated-measures ANOVA — checklist",
    whenToUse:
      "Use this when the same subjects are measured under three or more conditions and you want to test whether any condition's mean differs from the others.",
    items: [
      {
        assumption: "Every subject was measured in every condition — the matching is what gives this test its power.",
        ifNot:
          "A subject missing a condition drops out of the analysis entirely; with patchy data, consider a mixed-effects model instead.",
      },
      {
        assumption: "The outcome is a number on a continuous scale in every condition.",
        ifNot: "For counts or categories this test does not apply.",
      },
      {
        assumption:
          "Each condition is roughly symmetric around its mean (no strong skew), or there are enough subjects that the means still behave well.",
        ifNot:
          "With skewed data or few subjects, use the Friedman test (answer “No” to the Gaussian question) or transform the data first.",
      },
      {
        assumption: "Sphericity holds: the differences between every pair of conditions vary by similar amounts.",
        ifNot:
          "When sphericity is doubtful, apply the Geisser-Greenhouse correction (answer “No” to the sphericity question); it widens the P value to allow for the uneven differences.",
      },
      {
        assumption: "The subjects are independent of each other — no subject's values influence another's.",
        ifNot:
          "Subjects measured in clusters (for example, animals from the same litter) need a model that accounts for the clustering.",
      },
    ],
  },
  friedman: {
    title: "Friedman test — checklist",
    whenToUse:
      "Use this when the same subjects are measured under three or more conditions and you want to test whether one condition tends to give larger values than the others, without assuming any condition follows a normal distribution.",
    items: [
      {
        assumption: "Every subject was measured in every condition — the matching is what gives this test its power.",
        ifNot: "A subject missing a condition drops out; with patchy data, consider a mixed-effects model instead.",
      },
      {
        assumption:
          "The outcome is at least ordered — numbers, or ranks such as scores — so that each subject's values can be ranked across conditions.",
        ifNot: "For unordered categories this test does not apply.",
      },
      {
        assumption: "The blocks (subjects) are independent of each other.",
        ifNot: "Subjects measured in clusters need a model that accounts for the clustering.",
      },
    ],
  },
  "two-way-anova": {
    title: "Two-way ANOVA — checklist",
    whenToUse:
      "Use this when two factors (for example, treatment and time) may each affect a numeric outcome, and you want to test both factors and whether they interact.",
    items: [
      {
        assumption:
          "The observations are independent — no subject appears in more than one cell, unless the design is repeated-measures.",
        ifNot: "Repeated measurements need the repeated-measures design (choose it in the wizard).",
      },
      {
        assumption: "The outcome is a number on a continuous scale.",
        ifNot: "For counts or categories an ANOVA does not apply.",
      },
      {
        assumption:
          "The residuals — what is left after the factors explain what they can — are roughly symmetric, with similar spread in every cell.",
        ifNot:
          "With skewed residuals or very uneven spread between cells, use the Scheirer-Ray-Hare test (answer “non-parametric” to the design question) or transform the data first.",
      },
      {
        assumption:
          "You read the interaction first: if the factors interact, the effect of one factor depends on the other, so a single main-effect summary misleads.",
        ifNot:
          "With a significant interaction, compare the groups within each level of the other factor instead of reporting the main effects alone.",
      },
      {
        assumption:
          "Each cell holds enough replicates to estimate its mean and spread — one value per cell can test the factors but cannot test the interaction.",
        ifNot:
          "Without replicates, the interaction cannot be separated from noise; replicate within cells if the interaction matters.",
      },
    ],
  },
  "two-way-anova-rm": {
    title: "Repeated-measures two-way ANOVA — checklist",
    whenToUse:
      "Use this when two factors may affect a numeric outcome and one of them is repeated within each subject (for example, every subject measured at several times, under several treatments).",
    items: [
      {
        assumption:
          "Every subject was measured at every level of the repeated factor — the matching is what gives this test its power.",
        ifNot:
          "A subject missing a level drops out of that comparison; with patchy data, consider a mixed-effects model instead.",
      },
      {
        assumption: "The outcome is a number on a continuous scale.",
        ifNot: "For counts or categories this test does not apply.",
      },
      {
        assumption: "The residuals are roughly symmetric, with similar spread in every cell.",
        ifNot:
          "With skewed residuals or very uneven spread, use the Scheirer-Ray-Hare test or transform the data first.",
      },
      {
        assumption:
          "Sphericity holds for the repeated factor: the differences between every pair of its levels vary by similar amounts.",
        ifNot:
          "When sphericity is doubtful, apply the Geisser-Greenhouse correction (answer “No” to the sphericity question).",
      },
      {
        assumption:
          "You read the interaction first: if the factors interact, the effect of one factor depends on the other, so a single main-effect summary misleads.",
        ifNot:
          "With a significant interaction, compare the groups within each level of the other factor instead of reporting the main effects alone.",
      },
    ],
  },
  "two-way-anova-srh": {
    title: "Scheirer-Ray-Hare test — checklist",
    whenToUse:
      "Use this when two factors may affect an outcome and you want to test both factors and their interaction, without assuming the outcome follows a normal distribution.",
    items: [
      {
        assumption: "The observations are independent — no subject appears in more than one cell.",
        ifNot: "Repeated measurements need a repeated-measures or mixed-effects design instead.",
      },
      {
        assumption: "The outcome is at least ordered, so that all values can be ranked together.",
        ifNot: "For unordered categories this test does not apply.",
      },
      {
        assumption:
          "The cells have similar distribution shapes if you want to read the result as a difference in medians.",
        ifNot:
          "When the shapes differ a lot, report the result as one cell tending to larger values — not as a median difference.",
      },
      {
        assumption:
          "The interaction result is treated as approximate: ranking the data first makes the interaction test less exact than the main-effect tests.",
        ifNot:
          "If the interaction is the question that matters most, consider transforming the data and running a parametric two-way ANOVA instead.",
      },
    ],
  },
  "three-way-anova": {
    title: "Three-way ANOVA — checklist",
    whenToUse:
      "Use this when three factors may each affect a numeric outcome, and you want to test all three factors and how they interact.",
    items: [
      {
        assumption: "The observations are independent — no subject appears in more than one cell.",
        ifNot: "Repeated measurements need a repeated-measures or mixed-effects design instead.",
      },
      {
        assumption: "The outcome is a number on a continuous scale.",
        ifNot: "For counts or categories an ANOVA does not apply.",
      },
      {
        assumption: "The residuals are roughly symmetric, with similar spread in every cell.",
        ifNot: "With skewed residuals or very uneven spread, transform the data first or use a rank-based test.",
      },
      {
        assumption:
          "Each cell holds enough replicates to estimate the three-way interaction — the number of cells grows fast with three factors.",
        ifNot: "Without replicates in every cell, the higher-order interactions cannot be separated from noise.",
      },
      {
        assumption:
          "You decided before running which comparisons matter: with three factors, the list of possible interactions is long and most of them will be hard to interpret.",
        ifNot:
          "Comparisons picked because the data looked interesting need a stricter correction for multiple testing.",
      },
      {
        assumption:
          "You read the interactions before the main effects: a significant interaction means the effect of one factor depends on the others.",
        ifNot:
          "With a significant interaction, compare the groups within each level of the other factors instead of reporting the main effects alone.",
      },
    ],
  },
  "linear-regression": {
    title: "Linear regression — checklist",
    whenToUse:
      "Use this when you want to describe how a numeric Y changes with X, or predict Y from X, and the relationship looks like a straight line.",
    items: [
      {
        assumption: "The relationship is straight — check a scatter plot of Y against X before fitting, not after.",
        ifNot:
          "A curved relationship needs a curve fit (nonlinear regression) or a transformation, not a straight line through a curve.",
      },
      {
        assumption:
          "Each point is independent — no point is a repeat measurement of another, and no two points share a subject.",
        ifNot: "Repeated measurements need a model that accounts for the repeats, such as a mixed-effects analysis.",
      },
      {
        assumption: "The scatter around the line is similar all along X — no funnel shape that widens or narrows.",
        ifNot:
          "When the scatter grows with Y, weight the points (the wizard offers 1/Y or 1/Y² weighting) or transform Y first.",
      },
      {
        assumption:
          "The residuals — the distances from the line — are roughly symmetric, which matters most for small samples and for confidence intervals.",
        ifNot: "With skewed residuals, transform Y first or use a robust fit.",
      },
      {
        assumption:
          "No single point drags the line: check points with extreme X (high leverage) and points far from the line.",
        ifNot: "Investigate influential points first; one point can move the slope and the P value a lot.",
      },
      {
        assumption: "X is measured precisely, or nearly so — the fit assumes the scatter is all in Y.",
        ifNot: "When both X and Y carry similar measurement error, use Deming regression instead.",
      },
      {
        assumption:
          "Forcing the line through the origin is only justified when Y really is zero at X = 0 — the wizard asks, and “No” is the safe default.",
        ifNot: "Forcing through the origin when it does not hold bends the whole line and biases the slope.",
      },
    ],
  },
  "nonlinear-regression": {
    title: "Nonlinear regression — checklist",
    whenToUse:
      "Use this when Y follows a curve with X — a dose-response, a growth or decay, a binding curve — and you want the curve's parameters (such as EC50 or a rate constant) rather than just a line.",
    items: [
      {
        assumption:
          "The curve's shape comes from the mechanism or prior knowledge — a dose-response, a decay, a binding model — not from trying shapes until one happens to fit.",
        ifNot:
          "A shape picked because it fits this data set will flatter the data and its parameters will not generalise.",
      },
      {
        assumption:
          "Every parameter means something and the data can pin it down: enough points spread across the curve, including near its bends and plateaus.",
        ifNot:
          "Parameters the data cannot see (for example, a top plateau with no points near it) come back with absurd values and wide intervals — fix them or collect the missing points.",
      },
      {
        assumption: "The residuals are independent, with similar spread all along X.",
        ifNot: "When the scatter grows with Y, weight the points or transform Y first.",
      },
      {
        assumption: "The starting values are sensible — the fit searches from them and can stall on a bad start.",
        ifNot:
          "If the fit fails or looks wrong, start from values read off the data (for example, the half-maximal X) rather than the defaults.",
      },
      {
        assumption:
          "Replicates at each X help judge lack of fit: without them, a curve can look good while missing the true shape.",
        ifNot:
          "With no replicates, check the residuals for a pattern (runs of points above, then below, the curve) — a pattern means the shape is wrong.",
      },
      {
        assumption:
          "The fitted parameters, not the R² alone, are what you report — a flexible curve can hug the points while its parameters stay meaningless.",
        ifNot:
          "Compare candidate shapes by whether their parameters are stable and interpretable, not only by which fits tightest.",
      },
    ],
  },
  survival: {
    title: "Survival analysis (log-rank) — checklist",
    whenToUse:
      "Use this when you compare how long subjects survive (or stay event-free) in two or more groups, with some subjects still event-free when follow-up ends.",
    items: [
      {
        assumption: "The groups were defined before follow-up started — not picked after seeing who lived longest.",
        ifNot: "Groups defined from the outcome make the comparison circular.",
      },
      {
        assumption:
          "Censoring is unrelated to the chance of the event: a subject who leaves follow-up early is no sicker or healthier than one who stays.",
        ifNot:
          "When sicker subjects drop out first, the curves are biased — the comparison no longer measures the groups, it measures who stayed.",
      },
      {
        assumption:
          "Follow-up ran long enough to see events in each group — a comparison with almost no events has almost no power.",
        ifNot:
          "With too few events, report the curves and the follow-up time, and treat the P value as the weak evidence it is.",
      },
      {
        assumption:
          "The log-rank test compares the whole curves, giving each event time similar weight — it does not assume the curves keep a fixed ratio.",
        ifNot:
          "When the curves cross, a single summary such as a hazard ratio misleads; describe where the curves differ instead.",
      },
      {
        assumption:
          "The test is about events, not subjects: what matters is how many events happened, not only how many subjects were enrolled.",
        ifNot: "A large study with few events is still a small study for this test.",
      },
      {
        assumption:
          "When three or more groups are compared pair by pair, the P values are corrected for multiple testing.",
        ifNot:
          "Uncorrected pairwise P values overstate the evidence; the wizard offers Holm or false-discovery-rate correction.",
      },
    ],
  },
  "cox-ph": {
    title: "Cox proportional-hazards regression — checklist",
    whenToUse:
      "Use this when you want to estimate how variables change the hazard (the event rate) over follow-up time, while allowing for subjects who are still event-free when follow-up ends.",
    items: [
      {
        assumption:
          "The hazards stay proportional: the ratio between two subjects' hazards does not drift over follow-up time.",
        ifNot:
          "When the ratio changes with time, a single hazard ratio misleads — stratify, or let the effect vary with time.",
      },
      {
        assumption:
          "Censoring is unrelated to the chance of the event: a subject who leaves follow-up early is no sicker or healthier than one who stays.",
        ifNot: "When sicker subjects drop out first, the hazard ratios are biased.",
      },
      {
        assumption:
          "There are enough events for the variables fitted — roughly ten events per variable is a common rule of thumb.",
        ifNot:
          "With too few events per variable, the estimates swing wildly; fit fewer variables or collect more follow-up.",
      },
      {
        assumption:
          "The covariates are measured before follow-up (or handled as time-varying with care) — a variable measured after the event cannot explain it.",
        ifNot:
          "Variables recorded after the event, or changed by the treatment, do not belong in the model as ordinary covariates.",
      },
      {
        assumption:
          "No two covariates are near-duplicates of each other — strongly correlated variables split one effect between them and inflate the uncertainty.",
        ifNot: "Drop or combine near-duplicate variables before fitting.",
      },
      {
        assumption:
          "Tied event times are handled by the method the wizard asks about — Efron is the usual default; with many ties the choice matters.",
        ifNot: "With heavy ties, check that the hazard ratios do not hinge on the tie method.",
      },
    ],
  },
  "correlation-pearson": {
    title: "Pearson correlation — checklist",
    whenToUse:
      "Use this when you want one number for how closely two numeric variables move together in a straight line.",
    items: [
      {
        assumption: "Both variables are numbers on a continuous scale.",
        ifNot: "For ordered ranks or categories, use Spearman correlation instead.",
      },
      {
        assumption:
          "The relationship is a straight line — check a scatter plot first; a strong curve can still give a weak r.",
        ifNot:
          "A curved but consistent relationship needs Spearman correlation (monotonic, not necessarily straight) or a curve fit.",
      },
      {
        assumption: "No single point dominates the result — one extreme pair can create a correlation, or hide one.",
        ifNot: "Investigate outlying pairs first; report r with and without them if they matter.",
      },
      {
        assumption:
          "The pairs are independent — no subject contributes two pairs, and no pair shares a subject with another.",
        ifNot: "Repeated measurements need a method that accounts for the repeats.",
      },
      {
        assumption:
          "A strong correlation does not mean one variable causes the other — a third variable, or the study design, may explain both.",
        ifNot: "Treat r as a measure of association, and look for the cause elsewhere.",
      },
    ],
  },
  "correlation-spearman": {
    title: "Spearman correlation — checklist",
    whenToUse:
      "Use this when you want one number for how consistently two variables rise (or fall) together, without assuming the relationship is a straight line or the values follow a normal distribution.",
    items: [
      {
        assumption:
          "Both variables are at least ordered — numbers, or ranks such as scores — so that their values can be ranked.",
        ifNot: "For unordered categories this test does not apply.",
      },
      {
        assumption:
          "The relationship is monotonic: as one rises, the other consistently rises (or consistently falls), even if not in a straight line.",
        ifNot:
          "A U-shaped or other non-monotonic relationship gives a Spearman r near zero even when the variables are strongly related — plot the data first.",
      },
      {
        assumption: "The pairs are independent — no subject contributes two pairs.",
        ifNot: "Repeated measurements need a method that accounts for the repeats.",
      },
      {
        assumption:
          "A strong correlation does not mean one variable causes the other — a third variable, or the study design, may explain both.",
        ifNot: "Treat r as a measure of association, and look for the cause elsewhere.",
      },
    ],
  },
};

/** The checklist for `key`, or undefined for an unknown key. */
export function checklistFor(key: string): AnalysisChecklist | undefined {
  return (CHECKLISTS as Record<string, AnalysisChecklist | undefined>)[key];
}

/** The checklist keys, in the order they are defined — so a caller can check
 *  that every key a wizard can resolve is a real checklist. */
export const CHECKLIST_KEYS = Object.keys(CHECKLISTS) as ChecklistKey[];

export const WIZARDS: Partial<Record<AnalysisPickerValue, Wizard>> = {
  "descriptive-statistics": {
    questions: (_, table) => someSets(table, 1),
    finish: (a) => ({ type: "descriptive-statistics", params: withSets(a) }),
  },

  "compare-two-groups": {
    questions: (a, table) => {
      const [first = "Group 1", second = "Group 2"] = chosenSets(a) ?? setNames(table);
      const gaussian = a.gaussian === "yes";
      return [
        ...twoSets(a, table),
        choice("paired", PAIRED, [
          ["unpaired", "Unpaired (independent groups)"],
          ["paired", "Paired (matched samples)"],
        ]),
        choice(
          "gaussian",
          GAUSSIAN,
          [
            ["yes", "Yes — use a parametric test"],
            ["no", "No — use a non-parametric test"],
          ],
          true,
        ),
        gaussian &&
          (a.paired === "paired"
            ? choice("ratio", "How should the paired values be compared?", [
                ["diff", "Compute differences (paired t test)"],
                ["ratio", "Compute ratios (ratio t test) — for log-normal data"],
              ])
            : choice("lognormal", "How should the two groups be compared?", [
                ["no", "Compare means (t test)"],
                ["yes", "Compare geometric means (lognormal t test) — for log-normal data"],
              ])),
        gaussian &&
          a.paired !== "paired" &&
          choice("variance", "Assume the two groups have equal variances?", [
            ["equal", a.lognormal === "yes" ? "Yes — lognormal t test" : "Yes — Student's t test"],
            ["unequal", a.lognormal === "yes" ? "No — lognormal Welch's t test" : "No — Welch's t test"],
          ]),
        choice("tails", "One-tailed or two-tailed P value?", [
          ["two-sided", "Two-tailed (recommended)"],
          ["less", `One-tailed: expect ${first} < ${second}`],
          ["greater", `One-tailed: expect ${first} > ${second}`],
        ]),
      ];
    },
    // An answer left from a question no longer asked (after Back) doesn't count.
    finish: (a) => {
      const [paired, gaussian] = [a.paired === "paired", a.gaussian === "yes"];
      return {
        type: "compare-two-groups",
        params: withSets(a, {
          paired,
          gaussian,
          equalVariance: a.variance !== "unequal",
          ratio: paired && gaussian && a.ratio === "ratio",
          ...(!paired && gaussian && a.lognormal === "yes" ? { lognormal: true } : {}),
          tails: a.tails as CompareTwoGroupsParams["tails"],
        }),
      };
    },
    // The checklist follows the branch: parametric or rank-based, paired or not.
    // Unanswered, the first options (unpaired, Gaussian) give the unpaired t test.
    checklist: (a) => {
      const [paired, gaussian] = [a.paired === "paired", a.gaussian !== "no"];
      return CHECKLISTS[
        gaussian ? (paired ? "paired-t" : "two-sample-t") : paired ? "wilcoxon-paired" : "mann-whitney"
      ];
    },
  },

  "compare-many-groups": {
    questions: (a, table) => {
      const paired = a.paired === "paired";
      const nonParametric = paired ? "Friedman test" : "Kruskal-Wallis test";
      // Independent groups sampled from Gaussian distributions: equal SDs or not.
      const anova = !paired && a.gaussian === "yes";
      const posthocs: [string, string][] =
        a.gaussian !== "yes"
          ? [
              ["none", `No — only the overall ${nonParametric}`],
              ["dunn", "Yes — Dunn's multiple comparisons test (Bonferroni-corrected)"],
              ["dunn-sidak", "Yes — Dunn's multiple comparisons test (Šídák-corrected)"],
              ["dunn-holm-sidak", "Yes — Dunn's multiple comparisons test (Holm–Šídák-corrected)"],
            ]
          : anova && a.equalSd === "no"
            ? [
                ["none", "No — only the overall Welch's ANOVA"],
                ["games-howell", "Yes, every pair — Games-Howell test"],
                ["t3", "Yes, every pair — Dunnett's T3 test (fewer than 50 values per group)"],
              ]
            : [
                ["none", "No — only the overall ANOVA"],
                ["tukey", "Yes, every pair — Tukey's multiple comparisons test"],
                ["bonferroni", "Yes, every pair — Bonferroni-corrected comparisons"],
                ["sidak", "Yes, every pair — Šídák-corrected comparisons"],
                ["holm-sidak", "Yes, every pair — Holm–Šídák comparisons"],
                ["lsd", "Yes, every pair — Fisher's LSD test (uncorrected — only if the ANOVA is significant)"],
                ...(anova
                  ? [["dunnett", "Yes, each group against a control — Dunnett's test"] as [string, string]]
                  : []),
              ];
      return [
        ...someSets(table, 3),
        choice("paired", PAIRED, [
          ["unpaired", "Unpaired (independent groups)"],
          ["paired", "Paired (matched / repeated-measures)"],
        ]),
        choice(
          "gaussian",
          GAUSSIAN,
          [
            ["yes", `Yes — ${paired ? "repeated-measures" : "one-way"} ANOVA (parametric)`],
            ["no", `No — ${nonParametric} (non-parametric)`],
          ],
          true,
        ),
        anova &&
          choice("equalSd", "Assume the groups have equal SDs?", [
            ["yes", "Yes — ordinary one-way ANOVA"],
            ["no", "No — Welch's ANOVA"],
          ]),
        paired &&
          a.gaussian === "yes" &&
          choice("sphericity", "Assume sphericity (equal variability of the differences between groups)?", [
            ["no", "No — Geisser-Greenhouse correction (recommended)"],
            ["yes", "Yes — no correction"],
          ]),
        choice("posthoc", paired ? "Compare the matched groups?" : "Compare the groups?", posthocs),
        a.posthoc === "dunnett" &&
          choice("control", "Which group is the control?", names(chosenSets(a) ?? setNames(table))),
      ];
    },
    finish: (a) => {
      const paired = a.paired === "paired";
      const type = a.gaussian === "yes" ? (paired ? "rm-anova" : "anova") : paired ? "friedman" : "kruskal-wallis";
      const anova = type === "anova" && {
        equalSd: a.equalSd !== "no",
        ...(a.posthoc === "dunnett" ? { control: a.control as string } : {}),
      };
      const rm = type === "rm-anova" && { sphericity: a.sphericity === "yes" };
      return { type, params: withSets(a, { posthoc: a.posthoc, ...anova, ...rm }) as AnalysisParams };
    },
    // The checklist follows the branch: which of the four tests the answers build.
    // Unanswered, the first options (unpaired, Gaussian) give the one-way ANOVA.
    checklist: (a) => {
      const paired = a.paired === "paired";
      const key: ChecklistKey =
        a.gaussian !== "no" ? (paired ? "rm-anova" : "anova") : paired ? "friedman" : "kruskal-wallis";
      return CHECKLISTS[key];
    },
  },

  "mixed-effects": {
    // One wizard serves both layouts (Column and Grouped tables) — the
    // Dataset alone must tell them apart: multi-column sets, or a ":" in a
    // column name (a grouped table with one replicate per group has
    // one-column sets). v1 is random-intercept only: the random structure
    // is stated, never chosen, and the choice arrives in v2. On a Column
    // table the wizard also asks for an optional between-subject factor
    // (one level per row): without it the fit is y ~ T only, with it the
    // two-factor fit the reference test pins (y ~ Treatment + T) — the
    // table layout alone cannot express the factor, so the wizard must ask.
    questions: (a, table) => {
      const grouped = isGroupedTable(table);
      if (grouped) {
        return [
          choice(
            "interaction",
            "Fixed factor A is the column groups, fixed factor B is the rows (time/condition). The interaction A×B is included by default.",
            [
              ["yes", "Include the A×B interaction"],
              ["no", "Main effects only — no interaction"],
            ],
          ),
          choice(
            "matched",
            "Subjects are the replicate columns within each group: replicate 1 in group A is the same subject as replicate 1 in group B, measured at every row. The model fits a random intercept per subject, so it uses every observed value even when some are missing.",
            [
              ["matched", "Replicates are the same subjects across groups — continue"],
              ["not-matched", "Replicates are NOT the same subjects — stop and use ordinary two-way ANOVA instead"],
            ],
          ),
        ];
      }
      const rowCount = table.numeric[0]?.byRow.length ?? 0;
      return [
        {
          id: "sets",
          ask: "Which columns are the repeated measurements? Each column is one time point or condition, measured on every subject (row).",
          kind: "names",
          options: dataNames(table),
          min: 3,
        },
        choice(
          "matched",
          "Subjects are the rows: each row is one subject, measured in every column. The model fits a random intercept per subject (one intercept per row), so it uses every observed value even when some are missing.",
          [
            ["matched", "Rows are matched subjects — continue"],
            ["not-matched", "Rows are NOT matched subjects — stop and use one-way ANOVA instead"],
          ],
        ),
        choice(
          "groups",
          "Do the subjects (rows) fall into groups — for example a treatment arm? A between-subject factor adds one fixed effect per group; without one, the model fits the repeated-measure factor only.",
          [
            ["no", "No — all subjects are one group"],
            ["yes", "Yes — subjects fall into groups"],
          ],
        ),
        a.groups === "yes" && {
          id: "groupName",
          ask: "What is the group factor called?",
          kind: "text" as const,
          label: "Group factor name",
          initial: "Treatment",
          placeholder: "Treatment",
          // A text question without `parse` falls back to comma-separated
          // numbers (the standard-curve unknowns) — a factor name needs its
          // own parse, else "Treatment" errors as "not a number".
          parse: (text: string) => (text.trim() === "" ? { error: "Enter a group factor name." } : {}),
        },
        a.groups === "yes" && {
          id: "groupLevels",
          ask: `Enter one group level per row, in row order, separated by commas — e.g. Control, Control, Control, Treated, Treated, Treated (${rowCount} rows).`,
          kind: "text" as const,
          label: "Group level for each row",
          initial: "",
          placeholder: "Control, Control, Control, Treated, Treated, Treated",
          parse: (text: string) => parseGroupLevels(text, rowCount),
        },
      ];
    },
    finish: (a, table) => {
      if (isGroupedTable(table)) {
        if (a.matched === "not-matched") {
          return {
            type: "two-way-anova",
            params: { design: "ordinary", posthoc: "none", posthocTarget: "groups" } as AnalysisParams,
          };
        }
        return {
          type: "mixed-effects",
          params: {
            subjectId: "replicate",
            randomStructure: "intercept",
            fixedFactors: ["Group", "Row"],
            interaction: a.interaction !== "no",
          },
        };
      }
      if (a.matched === "not-matched") {
        return { type: "anova", params: withSets(a, { posthoc: "none" }) as AnalysisParams };
      }
      const chosen = chosenSets(a) ?? dataNames(table);
      const cols = table.numeric.filter((c) => chosen.includes(c.name));
      const timeName = columnFactorName(cols.length ? cols : table.numeric);
      if (a.groups === "yes") {
        const name = String(a.groupName ?? "").trim() || "Treatment";
        const levels = splitGroupLevels(String(a.groupLevels ?? ""));
        return {
          type: "mixed-effects",
          params: withSets(a, {
            subjectId: "row",
            randomStructure: "intercept",
            fixedFactors: [name, timeName],
            subjectFactor: { name, levels },
          }) as AnalysisParams,
        };
      }
      return {
        type: "mixed-effects",
        params: withSets(a, {
          subjectId: "row",
          randomStructure: "intercept",
          fixedFactors: [timeName],
        }) as AnalysisParams,
      };
    },
  },

  "one-sample-t": {
    questions: (a, table) => {
      const center = a.gaussian === "yes" ? "mean" : "median";
      return [
        ...someSets(table, 1),
        {
          id: "value",
          ask: "Which hypothetical value should each data set be tested against?",
          kind: "number",
          label: "Hypothetical value",
          initial: 0,
        },
        choice(
          "gaussian",
          "Assume the data are sampled from a Gaussian (normal) distribution?",
          [
            ["yes", "Yes — one-sample t test (parametric)"],
            ["no", "No — Wilcoxon signed-rank test (non-parametric)"],
          ],
          true,
        ),
        choice("tails", "One-tailed or two-tailed P value?", [
          ["two-sided", "Two-tailed (recommended)"],
          ["less", `One-tailed: expect ${center} < hypothetical value`],
          ["greater", `One-tailed: expect ${center} > hypothetical value`],
        ]),
      ];
    },
    finish: (a) => ({
      type: "one-sample-t",
      params: withSets(a, {
        hypotheticalValue: a.value as number,
        gaussian: a.gaussian === "yes",
        tails: a.tails as OneSampleTParams["tails"],
      }),
    }),
    checklist: (a) => CHECKLISTS[a.gaussian === "no" ? "wilcoxon-signed-rank" : "one-sample-t"],
  },

  outliers: {
    questions: (a, table) => [
      ...someSets(table, 1),
      choice("method", "Which method should identify the outliers?", [
        ["rout", "ROUT method (recommended — Q = maximum false discovery rate)"],
        ["grubbs", "Grubbs' test (tests the single most extreme value; assumes Gaussian data)"],
      ]),
      // Before the method is answered the ROUT question shows (ROUT is the
      // default — the first option); picking Grubbs swaps it for alpha +
      // iterate on the next step.
      (a.method === "rout" || a.method === undefined) && {
        id: "q",
        ask: "How strict should the search be? ROUT fits each data set to a robust mean and flags a point as an outlier when its false discovery rate is below Q: a smaller Q flags fewer.",
        kind: "number",
        label: "Q (%) =",
        initial: 1,
        ...ROUT_Q,
        // min/max alone are only HTML attributes — the wizard's Next gate
        // reads `validate`, so without this an out-of-range Q sailed through.
        validate: routQError,
        step: 0.5,
      },
      a.method === "grubbs" && {
        id: "alpha",
        ask: "How strict should the test be? A value is an outlier when its Grubbs P value is below alpha.",
        kind: "number",
        label: "Significance level (alpha) =",
        initial: 0.05,
        min: 0.001,
        max: 0.5,
        step: 0.01,
      },
      a.method === "grubbs" &&
        choice("iterate", "Keep testing after removing each outlier?", [
          ["yes", "Keep testing after removing each outlier (recommended)"],
          ["no", "Test only the single most extreme value"],
        ]),
    ],
    finish: (a) => {
      const method = (a.method as "rout" | "grubbs" | undefined) ?? "rout";
      return {
        type: "outliers",
        params: withSets(
          a,
          // ROUT params carry no alpha/iterate and Grubbs params carry no q,
          // so each method's cached results keep their existing keys.
          method === "grubbs"
            ? { method, alpha: (a.alpha as number | undefined) ?? 0.05, iterate: a.iterate !== "no" }
            : { q: (a.q as number | undefined) ?? 1 },
        ),
      };
    },
  },

  // Normality tests (plan 23): which of the four tests, and whether to also
  // test the log-transformed values. Shapiro–Wilk is the default; the
  // D'Agostino–Pearson option names its n ≥ 20 floor (the runner still
  // reports per-column when a column is too short, since columns can
  // differ in n).
  "shapiro-wilk": {
    questions: (_, table) => [
      ...someSets(table, 1),
      choice("test", "Which normality test?", [
        ["shapiro-wilk", "Shapiro–Wilk (recommended)"],
        ["dagostino-pearson", "D'Agostino–Pearson omnibus K2 (needs n ≥ 20)"],
        ["anderson-darling", "Anderson–Darling"],
        ["kolmogorov-smirnov", "Kolmogorov–Smirnov"],
      ]),
      choice("lognormal", "Should the test also run on the log-transformed values?", [
        ["no", "Test normality only"],
        ["yes", "Also test lognormality (test log-transformed data)"],
      ]),
    ],
    finish: (a) => ({
      type: "shapiro-wilk",
      params: withSets(a, {
        test: a.test as ShapiroWilkParams["test"],
        lognormal: a.lognormal === "yes",
      }),
    }),
  },

  "frequency-distribution": {
    questions: (a, table) => {
      // Defaults from the first data column (the runner bins every column with
      // the same settings, so one column's scale is the honest starting point).
      const values = table.numeric[0]?.values ?? [];
      const min = values.length ? Math.min(...values) : 0;
      const max = values.length ? Math.max(...values) : 0;
      const k = sturgesCount(Math.max(values.length, 2));
      const width = niceWidthUp((max - min) / k);
      const mode = a.binMode as string | undefined;
      return [
        ...someSets(table, 1),
        choice("binMode", "How should the values be grouped into bins?", [
          ["auto", "Automatic (Sturges' rule)"],
          ["width", "Bin width"],
          ["count", "Number of bins"],
        ]),
        mode === "width" && {
          id: "binWidth",
          ask: "Each bin covers this range of values.",
          kind: "number",
          label: "Bin width",
          initial: width,
        },
        mode === "count" && {
          id: "binCount",
          ask: "Split the range into this many bins of equal width.",
          kind: "number",
          label: "Number of bins",
          initial: k,
          min: 2,
          max: 100,
        },
        (mode === "width" || mode === "count") && {
          id: "startAt",
          ask: "The lower edge of the first bin.",
          kind: "number",
          label: "First bin starts at",
          initial: mode === "width" ? floorToWidth(min, (a.binWidth as number | undefined) ?? width) : min,
        },
      ];
    },
    finish: (a) => ({
      type: "frequency-distribution",
      params: withSets(a, {
        binMode: (a.binMode as FrequencyDistributionParams["binMode"] | undefined) ?? "auto",
        ...(a.binMode === "width"
          ? { binWidth: a.binWidth as number, startAt: a.startAt as number }
          : a.binMode === "count"
            ? { binCount: a.binCount as number, startAt: a.startAt as number }
            : {}),
      }),
    }),
  },

  // Transform data (v2, item 1): one function applied to every value of the
  // chosen columns. Prism's standard set (log10, ln, log2, sqrt, reciprocal,
  // exp, square); a value the function is undefined for is left blank in
  // the results sheet, never NaN — the runner states the reason in its notes.
  "transform-data": {
    questions: (_, table) => [
      ...someSets(table, 1),
      choice("function", "Which function should be applied to the values?", [
        ["log10", "log10(Y) — logarithm, base 10"],
        ["ln", "ln(Y) — natural logarithm"],
        ["log2", "log2(Y) — logarithm, base 2"],
        ["sqrt", "sqrt(Y) — square root"],
        ["reciprocal", "1/Y — reciprocal"],
        ["exp", "exp(Y) — e to the power of Y"],
        ["square", "Y² — square"],
      ]),
    ],
    finish: (a) => ({
      type: "transform-data",
      params: withSets(a, { function: (a.function as TransformFunction | undefined) ?? "log10" }),
    }),
  },
  // Transform concentrations (v2): one numeric column (an XY table's X
  // dose column, or any Y / Column-table column) between molar units.
  // The target list leaves the source unit out — converting a unit to
  // itself is a no-op, not a conversion. Mass units are not offered:
  // they need a molecular weight this operation does not collect.
  "transform-concentrations": {
    questions: (a, table) => {
      const units: [string, string][] = CONCENTRATION_UNITS.map((u) => [u, u]);
      return [
        choice(
          "column",
          "Which column holds the concentrations to convert?",
          names(dataNames(table)),
          false,
          "This table has no numeric column to convert. Enter concentrations in a column first.",
        ),
        choice("fromUnit", "Which unit are the values in now?", units),
        choice(
          "toUnit",
          "Which unit should they be converted to?",
          units.filter(([u]) => u !== a.fromUnit),
        ),
      ];
    },
    finish: (a) => ({
      type: "transform-concentrations",
      params: {
        column: a.column as string,
        fromUnit: a.fromUnit as ConcentrationUnit,
        toUnit: a.toUnit as ConcentrationUnit,
      } as TransformConcentrationsParams,
    }),
  },

  "bland-altman": {
    questions: (a, table, tableType) => {
      // On an XY table the X column is the independent variable (time,
      // dose…) — not a measurement method. Offering it as a "method" let
      // the wizard present an X − Y difference's bias/limits as a method
      // comparison, which is scientifically meaningless, so only the Y
      // columns are methods there. A column table has no X, so every
      // numeric column stays a method.
      const isXY = tableType === "xy";
      const methods = isXY ? yNames(table) : dataNames(table);
      return [
        choice("first", "Which column is the first method?", names(methods)),
        choice(
          "second",
          "Which column is the second method? The difference is computed as first − second.",
          names(methods.filter((n) => n !== a.first)),
          false,
          isXY
            ? "This table has only one Y data set, so there is no second method to choose. Add another Y column first."
            : "This table has only one numeric column, so there is no second method to choose. Add another numeric column first.",
        ),
      ];
    },
    finish: (a) => ({ type: "bland-altman", params: { sets: [a.first as string, a.second as string] } }),
  },

  "roc-curve": {
    questions: (a, table) => {
      // The truth column may be text ("Diseased"/"Healthy"), so it is picked
      // among all columns; the score must hold numbers.
      const truthCol = table.columns.find((c) => c.name === a.truth) ?? table.columns[0];
      const distinct = truthCol ? distinctTruthValues(truthCol) : [];
      // The default positive class is the largest value, so it comes first
      // (the wizard pre-selects the first option); the question says so, so
      // a text-outcome user picks deliberately.
      const ordered = [...distinct].sort((x, y) => {
        const nx = Number(x);
        const ny = Number(y);
        if (Number.isFinite(nx) && Number.isFinite(ny)) return ny - nx;
        return y.localeCompare(x);
      });
      return [
        choice(
          "truth",
          "Which column holds the known outcome (e.g. diseased / healthy)?",
          names(table.columns.map((c) => c.name)),
        ),
        choice(
          "score",
          "Which column holds the test score?",
          names(dataNames(table).filter((n) => n !== a.truth)),
          false,
          "The truth column is the table's only numeric column, so no column is left to hold the test score. Go back and choose a text column as the truth, or add another numeric column.",
        ),
        distinct.length > 0 &&
          choice(
            "positive",
            "Which outcome value counts as positive (diseased)? The largest value is the default.",
            names(ordered),
          ),
      ];
    },
    finish: (a, table) => {
      const truthCol = table.columns.find((c) => c.name === a.truth);
      const distinct = truthCol ? distinctTruthValues(truthCol) : [];
      const numeric = distinct.length > 0 && distinct.every((v) => Number.isFinite(Number(v)));
      return {
        type: "roc-curve",
        params: {
          truth: a.truth as string,
          score: a.score as string,
          positive: a.positive === undefined ? undefined : numeric ? Number(a.positive) : (a.positive as string),
        },
      };
    },
  },

  // Monte Carlo (plan 22, sub-task b): repeat a chosen analysis on simulated
  // data. v1 repeats only the five targets below — each one's per-repeat
  // statistic has a one-call in-R `replicate()` form, so 10,000 repeats take
  // seconds, not minutes (a per-repeat round-trip would take ~5 min). The
  // simulation is Gaussian per data set, with each set's mean/SD defaulting
  // to its observed mean/SD (a parametric bootstrap) — set the means to the
  // effect you want to test (e.g. two groups 0 and 0.5 apart, SD 1) and the
  // "% P < 0.05" row reads the power. Tails are two-sided in v1; Grouped
  // tables have no v1 target (two-way ANOVA is a follow-on), so the picker
  // does not offer Monte Carlo there.
  "monte-carlo": {
    questions: (a, table, tableType) => {
      const isXY = tableType === "xy";
      const targets: [string, string][] = isXY
        ? [
            ["linear-regression", "Linear regression (repeat its slope)"],
            ["correlation", "Correlation (repeat its r)"],
          ]
        : [
            ["compare-two-groups", "Compare two groups (repeat its t test)"],
            ["one-sample-t", "Compare one group to a value (repeat its t test)"],
            ["descriptive-statistics", "Descriptive statistics (repeat its mean)"],
          ];
      const target = (a.target as MonteCarloTarget | undefined) ?? (targets[0][0] as MonteCarloTarget);
      const statistics = MONTE_CARLO_TARGET_STATISTICS[target];
      // The data sets the repeats simulate: compare-two-groups takes the two
      // chosen (or first two) columns; one-sample-t / descriptive-statistics
      // the one chosen column; the XY targets the chosen Y series.
      const dataCols = dataNames(table);
      const yCols = yNames(table);
      const groupNames: string[] =
        target === "compare-two-groups"
          ? (chosenSets(a) ?? dataCols.slice(0, 2))
          : target === "one-sample-t" || target === "descriptive-statistics"
            ? [(a.group as string | undefined) ?? dataCols[0]].filter((n): n is string => n !== undefined)
            : [(a.y as string | undefined) ?? yCols[0]].filter((n): n is string => n !== undefined);
      const simQuestions = groupNames.flatMap((name): (Question | false)[] => {
        const column = table.numeric.find((c) => c.name === name);
        const { mean, sd } = meanSd(column?.values ?? []);
        const observed = column ? ` (observed ${round6(mean)} ± ${round6(sd)})` : "";
        return [
          {
            id: `mean:${name}`,
            ask: `Mean to simulate for “${name}”${observed}? Set it to the effect you want to test.`,
            kind: "number",
            label: `Mean for “${name}”`,
            initial: round6(mean),
          },
          {
            id: `sd:${name}`,
            ask: `SD to simulate for “${name}”${observed}?`,
            kind: "number",
            label: `SD for “${name}”`,
            initial: round6(sd),
            validate: (v) => (v > 0 ? undefined : "The SD must be greater than 0."),
          },
        ];
      });
      return [
        choice(
          "target",
          "Which analysis should be repeated? Each repeat draws new Gaussian data for the data sets below and runs the analysis on it.",
          targets,
        ),
        statistics.length > 1 &&
          choice(
            "statistic",
            "Which result should be summarised across the repeats?",
            statistics.map((s): [string, string] => [s, s]),
          ),
        ...(target === "compare-two-groups"
          ? [
              ...twoSets(a, table),
              choice("equalVariance", "Assume the two groups have equal variances?", [
                ["yes", "Yes — Student's t test"],
                ["no", "No — Welch's t test"],
              ]),
            ]
          : []),
        (target === "one-sample-t" || target === "descriptive-statistics") &&
          dataCols.length > 1 &&
          choice("group", "Which data set should be repeated?", names(dataCols)),
        target === "one-sample-t" && {
          id: "hypotheticalValue",
          ask: "Which hypothetical value should each repeat be tested against?",
          kind: "number",
          label: "Hypothetical value",
          initial: 0,
        },
        (target === "linear-regression" || target === "correlation") &&
          choice("y", "Which Y data set should be simulated?", names(yCols)),
        target === "correlation" &&
          choice("method", "Which correlation coefficient should be repeated?", [
            ["pearson", "Pearson (parametric)"],
            ["spearman", "Spearman (non-parametric)"],
          ]),
        ...simQuestions,
        {
          id: "repeats",
          ask: "How many times should the analysis be repeated? More repeats give a steadier power estimate; 1,000 is usually enough, 10,000 takes ~15–25 seconds.",
          kind: "number",
          label: "Repeats",
          initial: 1000,
          min: MONTE_CARLO_REPEATS.min,
          max: MONTE_CARLO_REPEATS.max,
          validate: (v) =>
            !Number.isInteger(v)
              ? "Repeats must be a whole number."
              : v < MONTE_CARLO_REPEATS.min || v > MONTE_CARLO_REPEATS.max
                ? `Repeats must be from ${MONTE_CARLO_REPEATS.min} to ${MONTE_CARLO_REPEATS.max}.`
                : undefined,
        },
        {
          id: "seed",
          ask: "Seed for the simulation — the same seed + same settings reproduce the same repeats.",
          kind: "number",
          label: "Seed",
          initial: 42,
          validate: (v) => (Number.isInteger(v) ? undefined : "The seed must be a whole number."),
        },
      ];
    },
    finish: (a, table, tableType) => {
      const isXY = tableType === "xy";
      const target = (a.target as MonteCarloTarget | undefined) ??
        (isXY ? "linear-regression" : "compare-two-groups");
      const statistics = MONTE_CARLO_TARGET_STATISTICS[target];
      const statistic = (a.statistic as MonteCarloStatistic | undefined) ?? statistics[0];
      const dataCols = dataNames(table);
      const yCols = yNames(table);
      const groupNames: string[] =
        target === "compare-two-groups"
          ? (chosenSets(a) ?? dataCols.slice(0, 2))
          : target === "one-sample-t" || target === "descriptive-statistics"
            ? [(a.group as string | undefined) ?? dataCols[0]]
            : [(a.y as string | undefined) ?? yCols[0]];
      const groupMeans: Record<string, number> = {};
      const groupSds: Record<string, number> = {};
      for (const name of groupNames) {
        if (typeof a[`mean:${name}`] === "number") groupMeans[name] = a[`mean:${name}`] as number;
        if (typeof a[`sd:${name}`] === "number") groupSds[name] = a[`sd:${name}`] as number;
      }
      return {
        type: "monte-carlo",
        params: withSets(a, {
          targetAnalysis: target,
          summaryStatistic: statistic,
          repeats: a.repeats as number,
          seed: a.seed as number,
          groupMeans,
          groupSds,
          ...(target === "compare-two-groups" ? { equalVariance: a.equalVariance !== "no" } : {}),
          ...(target === "one-sample-t" ? { hypotheticalValue: a.hypotheticalValue as number } : {}),
          ...(target === "one-sample-t" || target === "descriptive-statistics"
            ? { sets: groupNames }
            : {}),
          ...(target === "linear-regression" || target === "correlation" ? { y: groupNames[0] } : {}),
          ...(target === "correlation" ? { method: (a.method as "pearson" | "spearman" | undefined) ?? "pearson" } : {}),
        }),
      };
    },
  },

  correlation: {
    questions: (a, table) => {
      const ys = yNames(table);
      // "Two chosen data sets" needs two Y series to choose from (M18):
      // with one Y it would ask for a second data set that does not exist.
      const modes: [string, string][] = [["x-vs-every-y", "X against every Y data set"]];
      if (ys.length >= 2) modes.push(["two-datasets", "Two chosen data sets"]);
      modes.push(["matrix", "Correlation matrix among the Y data sets"]);
      return [
        choice("method", "Which correlation coefficient should be computed?", [
          ["pearson", "Pearson (parametric)"],
          ["spearman", "Spearman (non-parametric)"],
        ]),
        choice("mode", "What do you want to correlate?", modes),
        a.mode === "two-datasets" && choice("first", "Which is the first data set?", names(ys)),
        a.mode === "two-datasets" &&
          choice(
            "second",
            "Which is the second data set?",
            names(ys.filter((n) => n !== a.first)),
            false,
            "This table has only one Y data set, so there is no second data set to choose. Go back and choose “X against every Y data set” instead.",
          ),
      ];
    },
    finish: (a) => ({
      type: "correlation",
      params: {
        method: a.method as XYCorrelationParams["method"],
        mode: a.mode as XYCorrelationParams["mode"],
        ...(a.mode === "two-datasets" ? { datasets: [a.first as string, a.second as string] as [string, string] } : {}),
      },
    }),
    checklist: (a) => CHECKLISTS[a.method === "spearman" ? "correlation-spearman" : "correlation-pearson"],
  },

  "linear-regression": {
    // A Multiple Variables table has no X column: both variables are asked.
    questions: (a, table, type) => [
      type === "multiple" && choice("x", "Which variable is X?", names(dataNames(table))),
      type === "multiple"
        ? choice("y", "Which variable is Y?", names(dataNames(table).filter((n) => n !== a.x)))
        : ysQuestion(table, "Which Y data sets should be regressed on X? Each is regressed on its own."),
      choice("origin", "Force the line through the origin (0,0)?", [
        ["no", "No — fit both slope and Y-intercept (recommended)"],
        ["yes", "Yes — assume Y = 0 when X = 0"],
      ]),
      // Plan 26: weighting (1/SD² needs the replicate columns this runner
      // never sees, so it is not offered here). Only an XY table's regression
      // on X is weighted — a Multiple Variables table regresses two named
      // columns, and asks no weighting question.
      ...(type === "xy"
        ? [
            choice("weights", "Weight the points?", [
              ["none", "No weighting (recommended unless scatter grows with Y)"],
              ["1/y", "Weight by 1/Y"],
              ["1/y2", "Weight by 1/Y²"],
              ["1/x", "Weight by 1/X"],
              ["1/x2", "Weight by 1/X²"],
            ]),
          ]
        : []),
    ],
    finish: (a) => ({
      type: "linear-regression",
      params: {
        ...(a.x === undefined ? { ...fittedYs(a) } : { x: a.x as string, y: a.y as string }),
        forceOrigin: a.origin === "yes",
        ...(a.weights !== undefined && a.weights !== "none"
          ? { weights: a.weights as LinearRegressionParams["weights"] }
          : {}),
      },
    }),
    checklist: () => CHECKLISTS["linear-regression"],
  },

  "deming-regression": {
    questions: (_, table) => [
      choice("y", "Which Y data set should be compared with X?", names(yNames(table))),
      {
        id: "lambda",
        ask: "What is the error variance ratio (λ = error in Y ÷ error in X)? 1 = both methods have equal error. Use the ratio of the squared standard deviations if you know them.",
        kind: "number",
        label: "Error variance ratio (λ = error in Y ÷ error in X).",
        initial: 1,
        validate: (v) => (v > 0 ? undefined : "The error variance ratio must be greater than 0."),
      },
    ],
    finish: (a) => ({ type: "deming-regression", params: { y: a.y as string, lambda: a.lambda as number } }),
  },

  "simple-logistic-regression": {
    questions: (_, table) => [
      yNames(table).length > 1 && choice("y", "Which Y data set holds the outcome, 1 or 0?", names(yNames(table))),
    ],
    finish: (a) => ({ type: "simple-logistic-regression", params: a.y === undefined ? {} : { y: a.y as string } }),
  },

  "area-under-curve": {
    questions: () => [
      {
        id: "baseline",
        ask: "From which baseline should each data set's area be measured? Area below it counts as negative.",
        kind: "number",
        label: "Baseline Y =",
        initial: 0,
      },
    ],
    finish: (a) => ({ type: "area-under-curve", params: { baseline: a.baseline as number } }),
  },

  // Remove baseline (v2): subtract a baseline from a curve — Prism's Analyze >
  // Remove Baseline. The X column (XY tables) is carried into the result
  // rows; on a Column table every chosen column is its own data set.
  "remove-baseline": {
    questions: (a, table, tableType) => {
      const targets = tableType === "xy" ? yNames(table) : dataNames(table);
      if (!targets.length) return [];
      const method = a.baselineMethod as string | undefined;
      return [
        {
          id: "ys",
          ask: "Which data sets should have the baseline removed?",
          kind: "names",
          options: targets,
          min: 1,
        },
        choice("baselineMethod", "What should be subtracted from each value?", [
          ["first-value", "First value — each data set's first value"],
          ["mean-first-n", "Mean of the first N values"],
          ["mean-of-controls", "Mean of control column(s)"],
          ["constant", "A constant value"],
        ]),
        method === "mean-first-n" && {
          id: "firstN",
          ask: "How many first values should be averaged for the baseline?",
          kind: "number",
          label: "Number of first values (N)",
          initial: 3,
          min: 1,
          validate: (v) =>
            Number.isInteger(v) && v >= 1 ? undefined : "Enter a whole number of 1 or more.",
        },
        method === "mean-of-controls" && {
          id: "controls",
          ask: "Which column(s) are the controls? Their values are averaged for the baseline.",
          kind: "names",
          options: dataNames(table),
          min: 1,
        },
        method === "constant" && {
          id: "constant",
          ask: "What constant value should be subtracted from each value?",
          kind: "number",
          label: "Constant baseline value",
          initial: 0,
        },
      ];
    },
    finish: (a, table, tableType) => ({
      type: "remove-baseline",
      params: {
        ys: a.ys as string[],
        ...(tableType === "xy" ? { x: table.columns[0]?.name } : {}),
        baselineMethod: a.baselineMethod as RemoveBaselineParams["baselineMethod"],
        ...(a.baselineMethod === "mean-first-n" ? { firstN: a.firstN as number } : {}),
        ...(a.baselineMethod === "mean-of-controls" ? { controls: a.controls as string[] } : {}),
        ...(a.baselineMethod === "constant" ? { constant: a.constant as number } : {}),
      },
    }),
  },

  "prune-rows": {
    questions: (a, table, tableType) => {
      const targets = tableType === "xy" ? yNames(table) : dataNames(table);
      if (!targets.length) return [];
      const condition = a.condition as string | undefined;
      return [
        {
          id: "ys",
          ask: "Which data sets should rows be pruned from?",
          kind: "names",
          options: targets,
          min: 1,
        },
        choice("condition", "Which rows should be dropped?", [
          ["empty", "Empty rows — the row holds no value in any chosen data set"],
          ["below", "Rows below a threshold — every value in the row is below it"],
          ["above", "Rows above a threshold — every value in the row is above it"],
          ["outside", "Rows outside a range — every value in the row is outside it"],
        ]),
        (condition === "below" || condition === "above") && {
          id: "threshold",
          ask:
            condition === "below"
              ? "Drop rows whose every value is below what threshold?"
              : "Drop rows whose every value is above what threshold?",
          kind: "number",
          label: "Threshold value",
          initial: 0,
        },
        condition === "outside" && {
          id: "low",
          ask: "What is the low end of the range? Rows whose every value is below it (or above the high end) are dropped.",
          kind: "number",
          label: "Low end of the range",
          initial: 0,
        },
        condition === "outside" && {
          id: "high",
          ask: "What is the high end of the range? Rows whose every value is above it (or below the low end) are dropped.",
          kind: "number",
          label: "High end of the range",
          initial: 100,
        },
      ];
    },
    finish: (a, table, tableType) => ({
      type: "prune-rows",
      params: {
        ys: a.ys as string[],
        ...(tableType === "xy" ? { x: table.columns[0]?.name } : {}),
        condition: a.condition as PruneRowsParams["condition"],
        ...(a.condition === "below" || a.condition === "above" ? { threshold: a.threshold as number } : {}),
        ...(a.condition === "outside" ? { low: a.low as number, high: a.high as number } : {}),
      },
    }),
  },

  "fraction-of-total": {
    questions: (_, table, tableType) => {
      const targets = tableType === "xy" ? yNames(table) : dataNames(table);
      if (!targets.length) return [];
      return [
        {
          id: "ys",
          ask: "Which data sets should be expressed as a fraction of their total?",
          kind: "names",
          options: targets,
          min: 1,
        },
        choice("totalBy", "Divide each value by…", [
          ["column", "Its column total — each value as a share of its data set"],
          ["row", "Its row total — each value as a share of its row"],
          ["grand", "The grand total — each value as a share of all the chosen values"],
        ]),
        choice("format", "Show the result as…", [
          ["fraction", "Fractions (0 to 1)"],
          ["percent", "Percentages (0 to 100)"],
        ]),
      ];
    },
    finish: (a, table, tableType) => ({
      type: "fraction-of-total",
      params: {
        ys: a.ys as string[],
        ...(tableType === "xy" ? { x: table.columns[0]?.name } : {}),
        totalBy: a.totalBy as FractionOfTotalParams["totalBy"],
        format: a.format as FractionOfTotalParams["format"],
      },
    }),
  },

  "normalize": {
    questions: (a, table, tableType) => {
      const targets = tableType === "xy" ? yNames(table) : dataNames(table);
      if (!targets.length) return [];
      const method = a.normalizeMethod as string | undefined;
      return [
        {
          id: "ys",
          ask: "Which data sets should be normalized?",
          kind: "names",
          options: targets,
          min: 1,
        },
        choice("normalizeMethod", "How should each value be rescaled?", [
          ["percent-of-largest", "Percent of the largest value in each data set (100% = largest)"],
          ["percent-of-smallest", "Percent of the smallest value in each data set (100% = smallest)"],
          ["percent-of-first", "Percent of the first value in each data set (100% = first)"],
          ["percent-of-mean-controls", "Percent of the mean of control column(s) (100% = control mean)"],
          ["percent-of-constant", "Percent of a constant value you enter (100% = constant)"],
          ["zero-to-hundred", "0–100% — define 0% and 100% separately"],
        ]),
        method !== undefined &&
          method !== "zero-to-hundred" &&
          choice("scale", "Express the results as a percent or a fraction?", [
            ["percent", "Percent — multiply by 100"],
            ["fraction", "Fraction — 1 = 100%"],
          ]),
        method === "percent-of-mean-controls" && {
          id: "controls",
          ask: "Which column(s) are the controls? Their values are averaged for the 100% reference.",
          kind: "names",
          options: dataNames(table),
          min: 1,
        },
        method === "percent-of-constant" && {
          id: "constant",
          ask: "What value is 100%?",
          kind: "number",
          label: "100% reference value",
          initial: 100,
        },
        method === "zero-to-hundred" &&
          choice("zeroDef", "What is 0%?", [
            ["smallest", "Smallest value in each data set"],
            ["first", "Value in the first row of each data set"],
            ["constant", "A value you enter"],
          ]),
        method === "zero-to-hundred" &&
          a.zeroDef === "constant" && {
            id: "zeroConstant",
            ask: "What value is 0%?",
            kind: "number",
            label: "0% value",
            initial: 0,
          },
        method === "zero-to-hundred" &&
          choice("hundredDef", "What is 100%?", [
            ["largest", "Largest value in each data set"],
            ["last", "Value in the last row of each data set"],
            ["constant", "A value you enter"],
            ["sum", "Sum of all values in the column"],
          ]),
        method === "zero-to-hundred" &&
          a.hundredDef === "constant" && {
            id: "hundredConstant",
            ask: "What value is 100%?",
            kind: "number",
            label: "100% value",
            initial: 100,
          },
      ];
    },
    finish: (a, table, tableType) => ({
      type: "normalize",
      params: {
        ys: a.ys as string[],
        ...(tableType === "xy" ? { x: table.columns[0]?.name } : {}),
        normalizeMethod: a.normalizeMethod as NormalizeParams["normalizeMethod"],
        ...((a.normalizeMethod as string) !== "zero-to-hundred" ? { asPercent: a.scale !== "fraction" } : {}),
        ...(a.normalizeMethod === "percent-of-mean-controls" ? { controls: a.controls as string[] } : {}),
        ...(a.normalizeMethod === "percent-of-constant" ? { constant: a.constant as number } : {}),
        ...(a.normalizeMethod === "zero-to-hundred"
          ? {
              zeroDef: a.zeroDef as NormalizeParams["zeroDef"],
              hundredDef: a.hundredDef as NormalizeParams["hundredDef"],
              ...(a.zeroDef === "constant" ? { zeroConstant: a.zeroConstant as number } : {}),
              ...(a.hundredDef === "constant" ? { hundredConstant: a.hundredConstant as number } : {}),
            }
          : {}),
      },
    }),
  },

  "nonlinear-regression": {
    questions: (a, table) => {
      const dose = a.kind !== "other";
      const models = (dose ? DOSE_MODELS : NONLINEAR_MODELS.filter((m) => !isDoseModel(m))).map(
        (m): [string, string] => [m, MODEL_LABEL[m]],
      );
      // One data set fitted can be compared with another's curve; several are each fitted.
      const ys = (a.ys as string[] | undefined) ?? yNames(table).slice(0, 1);
      const others = ys.length === 1 ? yNames(table).filter((n) => n !== ys[0]) : [];
      const modelName = String(a.model ?? "");
      const midpoint = modelName.startsWith("inhibitor")
        ? "IC50"
        : modelName.startsWith("two-site")
          ? "IC50 (high affinity)"
          : modelName === "homologous-competition-logx"
            ? "Kd"
            : "EC50";
      // Plan 26: the weighting options (1/SD² only when the table has
      // replicates to take an SD over), the model comparison, the global
      // fit, and the parameter constraints.
      const weightOptions: [string, string][] = [
        ["none", "No weighting (recommended unless scatter grows with Y)"],
        ["1/y", "Weight by 1/Y"],
        ["1/y2", "Weight by 1/Y²"],
        ["1/x", "Weight by 1/X"],
        ["1/x2", "Weight by 1/X²"],
        ...(yNames(table).length > 1 ? [["1/sd2", "Weight by 1/SD² (needs replicates)"] as [string, string]] : []),
      ];
      const terms = a.model ? modelSpec(a.model as NonlinearModel).terms : [];
      return [
        ysQuestion(table, "Which Y data sets should be fitted? Each is fitted on its own."),
        choice("kind", "Which kind of curve?", [
          ["dose", "Dose-response (sigmoidal)"],
          ["other", "Another curve (line, polynomial, exponential, Michaelis-Menten…)"],
        ]),
        choice("model", "Which curve should be fitted to X and Y?", models),
        choice("weights", "Weight the points?", weightOptions),
        dose &&
          others.length > 0 &&
          choice("compareWith", "Compare this curve with another data set's?", [
            ["none", "No"],
            ...others.map((n): [string, string] => [n, `Yes, with “${n}”`]),
          ]),
        dose &&
          a.compareWith !== undefined &&
          a.compareWith !== "none" &&
          choice("compare", "What should be compared?", [
            ["ec50", `Is the ${midpoint} different between the two data sets?`],
            ["all", "Does one curve fit both data sets?"],
          ]),
        // Outliers are looked for in a curve fitted on its own, not in two compared.
        (!dose || ys.length > 1 || others.length === 0 || a.compareWith === "none") &&
          choice("rout", "Identify outliers, points too far from the curve, and leave them out of the fit?", [
            ["no", "No — fit every point"],
            ["yes", "Yes — ROUT method (Q = 1%)"],
          ]),
        choice("compareModel", "Also fit another model to the same data and compare (F test + AICc)?", [
          ["none", "No comparison — fit this model only"],
          ...models
            .filter(([m]) => m !== a.model)
            .map(([m, label]): [string, string] => [m, `Also fit ${label}`]),
        ]),
        others.length > 0 &&
          choice("global", "Fit additional Y data sets together with shared parameters (a global fit)?", [
            ["no", "No — fit this data set alone"],
            ["yes", "Yes — fit them together"],
          ]),
        a.global === "yes" &&
          others.length > 0 && {
            id: "globalY",
            ask: "Which additional Y data sets should be fitted together?",
            kind: "names",
            options: others,
            min: 1,
          },
        a.global === "yes" &&
          ((a.globalY as string[] | undefined)?.length ?? 0) > 0 &&
          choice("shared", "Which parameters should be shared across the data sets?", [
            ["default", `The usual ones — the curve's midpoint and Hill slope (recommended)`],
            ["all", "Every parameter (one curve for all data sets)"],
            ["custom", "Choose…"],
          ]),
        a.global === "yes" &&
          a.shared === "custom" && {
            id: "sharedParams",
            ask: "Which parameters should be shared across the data sets?",
            kind: "names",
            options: terms,
            min: 1,
          },
        choice("constrain", "Fix or bound any parameters? (Advanced — leave the fit free unless you have a reason.)", [
          ["no", "No — fit every parameter freely"],
          ["yes", "Yes — fix parameters to constants or bound them"],
        ]),
        ...(a.constrain === "yes"
          ? terms.flatMap((term): Question[] => [
              {
                id: `fix_${term}`,
                ask: `Fix ${termLabel(term)} to a constant? Leave blank to fit it. (A fixed parameter is held at the value you enter, not fitted.)`,
                kind: "text",
                label: `Fix ${termLabel(term)} =`,
                initial: "",
                parse: (text: string) => parseOptionalNumber(text, termLabel(term)),
              },
              {
                id: `bound_${term}`,
                ask: `Bound ${termLabel(term)}? Leave blank for unbounded, or enter “lower, upper”. (A bounded parameter is fitted within the bounds.)`,
                kind: "text",
                label: `${termLabel(term)} bounds [lower, upper] =`,
                initial: "",
                parse: (text: string) => parseOptionalBounds(text, termLabel(term)),
              },
            ])
          : []),
        // Binding competition (plan 28): Fit Ki on the one-site (inhibitor
        // 3PL) and two-site competition fits — Ki = IC50 / (1 + [L]/Kd).
        dose &&
          (modelName === "inhibitor-3pl-logx" || modelName.startsWith("two-site-competition")) &&
          choice("fitKi", "Also report Ki (Cheng–Prusoff)?", [
            ["no", "Report IC50 only"],
            ["yes", "Also report Ki (Cheng–Prusoff)"],
          ]),
        // Fit Ki — or the homologous model, whose equation needs [L] — both
        // values required, in the same units as X; the wizard must not
        // proceed without them (the runner re-checks, so a bad value passed
        // straight to runAnalysis still fails clearly).
        dose &&
          (a.fitKi === "yes" || modelName === "homologous-competition-logx") &&
          {
            id: "ligandConcentration",
            ask: "Radioligand concentration [L], in the same units as X.",
            kind: "text",
            label: "Radioligand concentration [L] =",
            initial: "",
            placeholder: "e.g. 1",
            parse: (text: string) => parseRequiredPositive(text, "radioligand concentration [L]"),
          },
        dose &&
          a.fitKi === "yes" &&
          {
            id: "ligandKd",
            ask: "Radioligand Kd, in the same units as [L] — Ki = IC50 / (1 + [L]/Kd).",
            kind: "text",
            label: "Radioligand Kd =",
            initial: "",
            placeholder: "e.g. 0.5",
            parse: (text: string) => parseRequiredPositive(text, "radioligand Kd"),
          },
      ];
    },
    finish: (a) => {
      const compare =
        a.kind !== "other" && a.compareWith !== undefined && a.compareWith !== "none" && fittedYs(a).ys === undefined
          ? { compareWith: a.compareWith as string, compare: a.compare as NonlinearRegressionParams["compare"] }
          : {};
      const weights =
        a.weights !== undefined && a.weights !== "none"
          ? { weights: a.weights as NonlinearRegressionParams["weights"] }
          : {};
      const compareModel =
        a.compareModel !== undefined && a.compareModel !== "none"
          ? { compareModel: a.compareModel as NonlinearModel }
          : {};
      const globalY = a.global === "yes" ? ((a.globalY as string[] | undefined) ?? []) : [];
      const global = globalY.length ? { globalY } : {};
      const terms = modelSpec(a.model as NonlinearModel).terms;
      const sharedParams =
        globalY.length && a.shared === "all"
          ? { sharedParams: terms }
          : globalY.length && a.shared === "custom"
            ? { sharedParams: (a.sharedParams as string[] | undefined) ?? [] }
            : {};
      // Fixed/bounded parameters from the advanced section (blank = fit it /
      // unbounded). A parameter fixed AND bounded is refused by the runner —
      // the wizard has no cross-question validation to refuse it here.
      const fixed: Record<string, number> = {};
      const bounds: Record<string, [number, number]> = {};
      for (const term of terms) {
        const f = parseOptionalNumber(String(a[`fix_${term}`] ?? ""), termLabel(term));
        if (f.value !== undefined) fixed[term] = f.value;
        const b = parseOptionalBounds(String(a[`bound_${term}`] ?? ""), termLabel(term));
        if (b.value !== undefined) bounds[term] = b.value;
      }
      const ligand = parseRequiredPositive(String(a.ligandConcentration ?? ""), "radioligand concentration [L]");
      const kd = parseRequiredPositive(String(a.ligandKd ?? ""), "radioligand Kd");
      const wantsKi = a.fitKi === "yes";
      const isHomologous = a.model === "homologous-competition-logx";
      return {
        type: "nonlinear-regression",
        params: {
          ...fittedYs(a),
          model: a.model as NonlinearModel,
          ...compare,
          ...(a.rout === "yes" && !compare.compareWith ? { rout: true } : {}),
          ...weights,
          ...compareModel,
          ...global,
          ...sharedParams,
          ...(Object.keys(fixed).length ? { fixed } : {}),
          ...(Object.keys(bounds).length ? { bounds } : {}),
          ...(wantsKi ? { fitKi: true } : {}),
          ...((wantsKi || isHomologous) && ligand.value !== undefined
            ? { ligandConcentration: ligand.value }
            : {}),
          ...(wantsKi && kd.value !== undefined ? { ligandKd: kd.value } : {}),
        },
      };
    },
    checklist: () => CHECKLISTS["nonlinear-regression"],
  },

  // A nonlinear regression whose unknowns (a Y, no X) are read off the curve; the 3PLs,
  // whose slope is fixed, aren't standard curves. Curves of X as entered first (an ELISA's
  // concentrations), those of log X after.
  interpolate: {
    questions: (_, table) => [
      choice("y", "Which Y data set should be fitted?", names(yNames(table))),
      // Prism's "Standard curves to interpolate": the ones that fit reliably in WebR.
      // (PATCH's list from Plan 08, plus the 5PLs from HEAD's dynamic filter —
      // HEAD's filter excludes the kinetic models, so one-phase-decay and
      // exponential-growth come from PATCH's list.)
      choice("model", "Which standard curve should be fitted to X and Y?", [
        ["sigmoidal-4pl-logx", "Sigmoidal, 4PL, X is log(concentration)"],
        ["sigmoidal-4pl-x", "Sigmoidal, 4PL, X is concentration"],
        ["asymmetric-5pl-logx", "Asymmetric sigmoidal, 5PL, X is log(concentration)"],
        ["asymmetric-5pl-x", "Asymmetric sigmoidal, 5PL, X is concentration"],
        ["line", "Line"],
        ["semilog-line", "Semilog line"],
        ["hyperbola", "Hyperbola (X is concentration)"],
        ["quadratic", "Second order polynomial (quadratic)"],
        ["cubic", "Third order polynomial (cubic)"],
        // Prism's "Exponential" family (plan 08, 1/2: decay first).
        ["one-phase-decay", "One-phase decay"],
        ["two-phase-decay", "Two-phase decay"],
        ["plateau-decay", "Plateau followed by one-phase decay"],
        // Prism's "Exponential" family (plan 08, 2/2: association + growth).
        ["one-phase-association", "One-phase association"],
        ["exponential-growth", "Exponential growth"],
        // Prism's "Enzyme kinetics" family (plan 09).
        ["michaelis-menten", "Michaelis-Menten"],
        ["allosteric-sigmoidal", "Allosteric sigmoidal"],
        ["substrate-inhibition", "Substrate inhibition"],
      ]),
    ],
    finish: (a) => ({
      type: "nonlinear-regression",
      params: { y: a.y as string, model: a.model as NonlinearRegressionParams["model"], interpolate: true },
    }),
  },

  "binding-saturation": {
    questions: (a, table) => {
      const ys = yNames(table);
      // The two-series models fit a second Y series jointly (M18): with one
      // Y there is no nonspecific-binding series to choose, so they are not offered.
      const models: [string, string][] = [
        ["one-site-total", "One site — Total binding"],
        ["two-site-specific", "Two sites — Specific binding"],
      ];
      if (ys.length >= 2)
        models.push(
          ["one-site-total-and-ns", "One site — Total and nonspecific"],
          ["two-site-total-and-ns", "Two sites — Total and nonspecific"],
        );
      return [
        choice("y", "Which Y data set is the total binding?", names(ys)),
        choice("model", "Which saturation model should be fitted?", models),
        // Two-series models fit a second Y series jointly, with NS and
        // Background shared — the first option after the total series is the
        // second Y column, so it defaults to the second Y data set.
        (a.model === "one-site-total-and-ns" || a.model === "two-site-total-and-ns") &&
          choice(
            "y2",
            "Which Y data set is the nonspecific binding?",
            names(ys.filter((n) => n !== a.y)),
            false,
            "This table has only one Y data set, so there is no nonspecific-binding series to choose. Go back and choose a one-site model, or add another Y column.",
          ),
      ];
    },
    finish: (a) => ({
      type: "binding-saturation",
      params: {
        y: a.y as string,
        model: a.model as BindingSaturationParams["model"],
        ...(a.y2 ? { y2: a.y2 as string } : {}),
      },
    }),
  },

  "binding-kinetics": {
    questions: (a, table) => [
      choice("y", "Which Y data set should be fitted?", names(yNames(table))),
      choice("model", "Which kinetics model should be fitted?", [
        ["association-one-phase", "Association — One phase"],
        ["dissociation-one-phase", "Dissociation — One phase"],
        ["association-two-phase", "Association — Two phases"],
        ["dissociation-two-phase", "Dissociation — Two phases"],
        ["association-then-dissociation", "Association then dissociation"],
      ]),
      // Derived kon / kinetic Kd need the radioligand concentration and a
      // Koff from a dissociation experiment — both optional, blank = not reported.
      a.model === "association-one-phase" && {
        id: "ligandConcentration",
        ask: "Radioligand concentration (for kon — same units as in the experiment; leave blank if unknown).",
        kind: "text",
        label: "Radioligand concentration (for kon)",
        initial: "",
        placeholder: "Blank = unknown",
        parse: (text) => parseOptionalPositive(text, "radioligand concentration"),
      },
      a.model === "association-one-phase" && {
        id: "koff",
        ask: "Koff from a dissociation experiment, in the same time units as X (leave blank if unknown). Needed with the radioligand concentration to derive kon and the kinetic Kd.",
        kind: "text",
        label: "Koff from a dissociation experiment",
        initial: "",
        placeholder: "Blank = unknown",
        parse: (text) => parseOptionalPositive(text, "Koff"),
      },
      // Association-then-dissociation's constrained constants: no defaults,
      // the wizard must not proceed without them.
      a.model === "association-then-dissociation" && {
        id: "hotNM",
        ask: "Radioligand concentration in nM during association (HotNM).",
        kind: "text",
        label: "HotNM (nM)",
        initial: "",
        placeholder: "e.g. 1",
        parse: (text) => parseRequiredPositive(text, "HotNM"),
      },
      a.model === "association-then-dissociation" && {
        id: "time0",
        ask: "Time at which dissociation starts (Time0), in the same time units as X.",
        kind: "text",
        label: "Time0",
        initial: "",
        placeholder: "e.g. 10",
        parse: (text) => parseRequiredPositive(text, "Time0"),
      },
    ],
    finish: (a) => {
      const ligand = parseOptionalPositive(String(a.ligandConcentration ?? ""), "radioligand concentration");
      const koff = parseOptionalPositive(String(a.koff ?? ""), "Koff");
      const hotNM = parseRequiredPositive(String(a.hotNM ?? ""), "HotNM");
      const time0 = parseRequiredPositive(String(a.time0 ?? ""), "Time0");
      return {
        type: "binding-kinetics",
        params: {
          y: a.y as string,
          model: a.model as BindingKineticsParams["model"],
          ...(ligand.value !== undefined ? { ligandConcentration: ligand.value } : {}),
          ...(koff.value !== undefined ? { koff: koff.value } : {}),
          ...(hotNM.value !== undefined ? { hotNM: hotNM.value } : {}),
          ...(time0.value !== undefined ? { time0: time0.value } : {}),
        },
      };
    },
  },

  // Enzyme kinetics — Inhibition (plan 17): the model picker defaults to
  // the Mixed model — it nests the others and its Alpha diagnoses the
  // mechanism — so it is listed first (a choice question defaults to its
  // first option). Y is a multi-select (default: all series); each included
  // series then gets its own inhibitor-concentration field, pre-filled from
  // the number in the column title and required when the title has none.
  // Per-series number fields are a new wizard pattern — one "text" question
  // per series, keyed `I:<series>` — noted here for reuse by later plans
  // (plan 18's global fits will want the same shape).
  "enzyme-inhibition": {
    questions: (a, table) => [
      // A global fit needs at least two Y series (the runner errors with
      // one), so with a single Y data set only Morrison — a single-curve
      // fit — is offered, and the question says why: otherwise the Y
      // question's min: 2 can never be met and Next stays disabled with
      // no message.
      choice(
        "model",
        yNames(table).length >= 2
          ? "Which inhibition model should be fitted?"
          : "Which inhibition model should be fitted? Global models need at least two Y data sets — with one Y data set, only Morrison Ki (tight binding) can be fitted.",
        [
          ...(yNames(table).length >= 2
            ? ([
                ["mixed", "Mixed model"],
                ["competitive", "Competitive"],
                ["noncompetitive", "Noncompetitive"],
                ["uncompetitive", "Uncompetitive"],
              ] as [string, string][])
            : []),
          ["morrison", "Morrison Ki (tight binding)"],
        ],
      ),
      {
        id: "y",
        ask:
          a.model === "morrison"
            ? "Which Y data sets should be fitted? Each is one inhibitor concentration."
            : "Which Y data sets should be fitted? Each is one inhibitor concentration — at least two for a global fit.",
        kind: "names",
        options: yNames(table),
        min: a.model === "morrison" ? 1 : 2,
      },
      // Global models only: one inhibitor-concentration field per included
      // series, pre-filled from the column title ("10 nM" → 10, "I=5" → 5);
      // a blank field blocks Next — the fit needs [I] for every series.
      ...(a.model !== "morrison"
        ? (Array.isArray(a.y) ? (a.y as string[]) : []).map((name) => ({
            id: `I:${name}`,
            ask: `Inhibitor concentration for “${name}” (same units for every series; Ki is reported in these units).`,
            kind: "text" as const,
            label: `[I] for “${name}”`,
            initial: parseInhibitorConcentration(name)?.toString() ?? "",
            placeholder: "e.g. 5",
            parse: (text: string) => parseRequiredNonNegative(text, "inhibitor concentration"),
          }))
        : []),
      // Morrison only: Et is required; [S] + Km are an optional pair (both
      // or neither) that converts Kiapp to Ki.
      a.model === "morrison" && {
        id: "enzymeConcentration",
        ask: "Total enzyme concentration (Et), in the same units as [I].",
        kind: "text",
        label: "Total enzyme concentration (Et)",
        initial: "",
        placeholder: "e.g. 5",
        parse: (text: string) => parseRequiredPositive(text, "total enzyme concentration"),
      },
      a.model === "morrison" && {
        id: "substrateConcentration",
        ask: "Substrate concentration used ([S]) — with Km, converts Kiapp to Ki; leave blank to report Kiapp only.",
        kind: "text",
        label: "Substrate concentration [S]",
        initial: "",
        placeholder: "Blank = Kiapp only",
        parse: (text: string) => parseOptionalPositive(text, "substrate concentration"),
      },
      a.model === "morrison" && {
        id: "kmForMorrison",
        ask: "Michaelis constant (Km) — with [S], converts Kiapp to Ki; leave blank to report Kiapp only.",
        kind: "text",
        label: "Michaelis constant (Km)",
        initial: "",
        placeholder: "Blank = Kiapp only",
        parse: (text: string) => parseOptionalPositive(text, "Michaelis constant"),
      },
    ],
    finish: (a, table) => {
      const model = (a.model as EnzymeInhibitionParams["model"] | undefined) ?? "mixed";
      const y = (Array.isArray(a.y) ? (a.y as string[]) : undefined) ?? yNames(table);
      const params: EnzymeInhibitionParams = { model, y };
      if (model !== "morrison") {
        const inhibitorConcentrations: Record<string, number> = {};
        for (const name of y) {
          const parsed = parseRequiredNonNegative(String(a[`I:${name}`] ?? ""), "inhibitor concentration");
          if (parsed.value !== undefined) inhibitorConcentrations[name] = parsed.value;
        }
        params.inhibitorConcentrations = inhibitorConcentrations;
      } else {
        const et = parseRequiredPositive(String(a.enzymeConcentration ?? ""), "total enzyme concentration");
        const s = parseOptionalPositive(String(a.substrateConcentration ?? ""), "substrate concentration");
        const km = parseOptionalPositive(String(a.kmForMorrison ?? ""), "Michaelis constant");
        if (et.value !== undefined) params.enzymeConcentration = et.value;
        if (s.value !== undefined) params.substrateConcentration = s.value;
        if (km.value !== undefined) params.kmForMorrison = km.value;
      }
      return { type: "enzyme-inhibition", params };
    },
  },

  // Dose-response — Special (plan 18): the model picker defaults to the
  // SchildSlope = 1 variant (Prism's guide presents it first), so it is
  // listed first (a choice question defaults to its first option). Y is a
  // multi-select (default: all series, in table order); the next question
  // names the assumed first series — the control (no antagonist) for
  // Schild/EC50 shift, the full agonist for the operational model — and
  // the user picks it explicitly, so a wrong first series is fixed by
  // picking another one instead of re-ticking. Each included series
  // except the control then gets its own antagonist-concentration field
  // (the plan-17 per-series-number pattern), pre-filled from the column
  // title and required when the title has none; B's units are one choice
  // for all series (pA2 is the negative log of B in these units). Schild
  // only: a HillSlope = 1.0 constraint choice, default free.
  "dose-response-special": {
    questions: (a, table) => {
      const model = (a.model as DoseResponseSpecialParams["model"] | undefined) ?? "schild-slope-1";
      const ys = (Array.isArray(a.ys) ? (a.ys as string[]) : undefined) ?? yNames(table);
      const first = (a.first as string | undefined) ?? ys[0];
      const isSchild = model === "schild" || model === "schild-slope-1";
      const needsB = isSchild || model === "ec50-shift";
      // One Y (or none) can never satisfy the two-series minimum, so the
      // step used to strand the wizard on a permanently disabled Next with
      // no message (R2-B4): relax the minimum to 1 and name the shortfall
      // in the question itself. The wizard then reaches Run and the runner
      // reports it too ("add at least a control and one shifted curve").
      const yCount = yNames(table).length;
      const shortfall =
        yCount === 0
          ? "This table has no Y data sets — this fit needs a control and at least one shifted curve. Add Y columns to the table first."
          : yCount === 1
            ? model === "operational-partial"
              ? "Only one Y data set exists — this fit needs a full agonist and at least one partial agonist. Add another Y column to the table, then run it again."
              : "Only one Y data set exists — this fit needs a control and at least one shifted curve. Add another Y column to the table, then run it again."
            : null;
      return [
        choice("model", "Which dose-response — Special model should be fitted?", [
          ["schild-slope-1", "Gaddum/Schild EC50 shift (SchildSlope = 1)"],
          ["schild", "Gaddum/Schild EC50 shift (SchildSlope free)"],
          ["ec50-shift", "EC50 shift"],
          ["operational-partial", "Operational model — Partial agonist"],
        ]),
        {
          id: "ys",
          ask:
            shortfall ??
            (model === "operational-partial"
              ? "Which Y data sets should be fitted? The first is the full agonist; the rest are partial agonists."
              : "Which Y data sets should be fitted? Each is one antagonist concentration; the first is the control (no antagonist)."),
          kind: "names",
          options: yNames(table),
          min: yCount < 2 ? 1 : 2,
        },
        // The assumed first series, named — proceeding picks it (or
        // another series) explicitly, so the fit never silently takes
        // the wrong series as the control / full agonist.
        choice(
          "first",
          model === "operational-partial"
            ? "The first series is the full agonist. Which series is it?"
            : "The first series is the control (no antagonist). Which series is it?",
          names(ys),
        ),
        // Schild / EC50 shift only: one B field per included series
        // except the control, pre-filled from the column title
        // ("10 nM" → 10); a blank field blocks Next.
        ...(needsB
          ? ys
              .filter((name) => name !== first)
              .map((name) => ({
                id: `B:${name}`,
                ask: `Antagonist concentration B for “${name}” (same units for every series; pA2 is reported in these units).`,
                kind: "text" as const,
                label: `B for “${name}”`,
                initial: parseInhibitorConcentration(name)?.toString() ?? "",
                placeholder: "e.g. 1e-8",
                parse: (text: string) => parseRequiredNonNegative(text, "antagonist concentration"),
              }))
          : []),
        needsB &&
          choice(
            "bUnits",
            "Which units is B entered in? pA2 is the negative log of B in these units — a nanomolar antagonist has pA2 ≈ 8–9 in M, ≈ −1 in nM.",
            [
              ["M", "M (molar)"],
              ["nM", "nM (nanomolar)"],
              ["µM", "µM (micromolar)"],
            ],
          ),
        isSchild &&
          choice(
            "fixHillSlope",
            "Constrain HillSlope to 1.0? Prism's guide suggests considering it — the fit is unconstrained by default.",
            [
              ["no", "No — fit HillSlope freely"],
              ["yes", "Yes — constrain HillSlope to 1.0"],
            ],
          ),
      ];
    },
    finish: (a, table) => {
      const model = (a.model as DoseResponseSpecialParams["model"] | undefined) ?? "schild-slope-1";
      const picked = (Array.isArray(a.ys) ? (a.ys as string[]) : undefined) ?? yNames(table);
      const first = (a.first as string | undefined) ?? picked[0];
      const ys = [first, ...picked.filter((n) => n !== first)];
      const params: DoseResponseSpecialParams = { model, ys };
      if (model === "schild" || model === "schild-slope-1" || model === "ec50-shift") {
        const antagonistConcentrations: Record<string, number> = { [first]: 0 };
        for (const name of ys.slice(1)) {
          const parsed = parseRequiredNonNegative(String(a[`B:${name}`] ?? ""), "antagonist concentration");
          if (parsed.value !== undefined) antagonistConcentrations[name] = parsed.value;
        }
        params.antagonistConcentrations = antagonistConcentrations;
        params.bUnits = (a.bUnits as string | undefined) ?? "M";
      }
      if (model === "schild" || model === "schild-slope-1") params.fixHillSlope = a.fixHillSlope === "yes";
      return { type: "dose-response-special", params };
    },
  },

  "spline-lowess": {
    questions: (a, table) => [
      choice("method", "Which smoother should be fitted?", [
        ["lowess", "Lowess (locally weighted smoothing)"],
        ["spline", "Spline (smoothing spline)"],
      ]),
      choice("y", "Which Y data set should be smoothed?", names(yNames(table))),
      a.method === "lowess" && {
        id: "f",
        ask: "Larger = smoother. 2/3 is the usual default; try 0.3–0.5 for wiggly data you want to follow closely.",
        kind: "number",
        label: "Span (fraction of points in each local fit)",
        initial: 2 / 3,
        step: 0.05,
        validate: (v) => (v > 0 && v <= 1 ? undefined : "The span must be between 0 and 1."),
      },
      a.method === "spline" && {
        id: "spar",
        ask: "Larger = smoother. Leave blank to let the fit choose; if the curve follows every point, set spar to 0.5–1.0.",
        kind: "text",
        label: "Smoothing parameter (spar). Blank = choose automatically.",
        initial: "",
        placeholder: "Blank = automatic (GCV)",
        parse: (text) => parseSpar(text),
      },
    ],
    finish: (a) => {
      const method = (a.method as SplineLowessParams["method"] | undefined) ?? "lowess";
      const spar = parseSpar(String(a.spar ?? ""));
      return {
        type: "spline-lowess",
        params: {
          y: a.y as string,
          method,
          ...(method === "lowess"
            ? { f: (a.f as number | undefined) ?? 2 / 3 }
            : { spar: spar.error ? NaN : spar.value }),
        },
      };
    },
  },

  "two-way-anova": {
    // One value per cell: only the ordinary ANOVA, without comparisons (see two-way-anova.ts).
    questions: (a, table) => [
      ...someSets(table, 2),
      replicated(table) &&
        choice("design", "Which two-way ANOVA? Each compares the groups, the rows and their interaction.", [
          ["ordinary", "Ordinary two-way ANOVA (parametric)"],
          ["repeated-measures", "Repeated-measures (matched by row, parametric)"],
          ["nonparametric", "Scheirer-Ray-Hare test (non-parametric)"],
        ]),
      replicated(table) &&
        a.design === "repeated-measures" &&
        choice("sphericity", "Assume sphericity (equal variability of the differences between rows)?", [
          ["no", "No — Geisser-Greenhouse correction (recommended)"],
          ["yes", "Yes — no correction"],
        ]),
      replicated(table) &&
        a.design !== "nonparametric" &&
        choice("posthoc", "Run multiple comparisons? Only meaningful if the ANOVA is significant.", [
          ["none", "No — just the ANOVA table"],
          ["tukey groups", "Yes — Tukey's, comparing groups within each row"],
          ["tukey rows", "Yes — Tukey's, comparing rows within each group"],
          ["bonferroni groups", "Yes — Bonferroni, comparing groups within each row"],
          ["bonferroni rows", "Yes — Bonferroni, comparing rows within each group"],
          ["sidak groups", "Yes — Šídák, comparing groups within each row"],
          ["sidak rows", "Yes — Šídák, comparing rows within each group"],
          ["holm-sidak groups", "Yes — Holm–Šídák, comparing groups within each row"],
          ["holm-sidak rows", "Yes — Holm–Šídák, comparing rows within each group"],
          ["lsd groups", "Yes — Fisher's LSD (uncorrected), comparing groups within each row"],
          ["lsd rows", "Yes — Fisher's LSD (uncorrected), comparing rows within each group"],
        ]),
    ],
    finish: (a) => {
      const [posthoc, posthocTarget = "groups"] = String(a.posthoc ?? "none").split(" ");
      return {
        type: "two-way-anova",
        params: withSets(a, {
          design: (a.design ?? "ordinary") as TwoWayAnovaParams["design"],
          posthoc: posthoc as TwoWayAnovaParams["posthoc"],
          posthocTarget: posthocTarget as TwoWayAnovaParams["posthocTarget"],
          ...(a.design === "repeated-measures" ? { sphericity: a.sphericity === "yes" } : {}),
        }),
      };
    },
    // The checklist follows the design: ordinary, repeated-measures, or rank-based.
    checklist: (a) =>
      CHECKLISTS[
        a.design === "repeated-measures"
          ? "two-way-anova-rm"
          : a.design === "nonparametric"
            ? "two-way-anova-srh"
            : "two-way-anova"
      ],
  },

  "three-way-anova": {
    questions: (a, table) => [
      ...someSets(table, 2),
      choice("posthoc", "Run multiple comparisons? Only meaningful if the ANOVA is significant.", [
        ["none", "No — just the ANOVA table"],
        ["tukey", "Yes — Tukey's"],
        ["bonferroni", "Yes — Bonferroni-corrected"],
      ]),
      a.posthoc !== "none" &&
        choice(
          "posthocTerm",
          "Which term should the comparisons follow up? The wizard cannot know yet which terms will be significant — pick the one you most want to follow up.",
          [
            ["A", "Factor A (column groups)"],
            ["B", "Factor B (rows)"],
            ["C", "Factor C (row groups)"],
            ["A:B", "Interaction A:B"],
            ["A:C", "Interaction A:C"],
            ["B:C", "Interaction B:C"],
            ["A:B:C", "Interaction A:B:C"],
          ],
        ),
    ],
    finish: (a) => ({
      type: "three-way-anova",
      params: withSets(a, {
        posthoc: (a.posthoc as ThreeWayAnovaParams["posthoc"] | undefined) ?? "none",
        ...(a.posthoc !== undefined && a.posthoc !== "none"
          ? { posthocTerm: (a.posthocTerm as ThreeWayAnovaParams["posthocTerm"] | undefined) ?? "A" }
          : {}),
      }),
    }),
    checklist: () => CHECKLISTS["three-way-anova"],
  },

  "nested-anova": {
    questions: (_, table) => [
      ...someSets(table, 3),
      choice("posthoc", "Compare each pair of groups?", [
        ["none", "No — only the overall ANOVA"],
        ["tukey", "Yes — Tukey's multiple comparisons test"],
        ["bonferroni", "Yes — Bonferroni-corrected comparisons"],
      ]),
    ],
    finish: (a) => ({
      type: "nested-anova",
      params: withSets(a, {
        posthoc: (a.posthoc as NestedAnovaParams["posthoc"] | undefined) ?? "none",
      }),
    }),
  },

  "multiple-t-tests": {
    questions: (a, table) => [
      ...twoSets(a, table),
      choice("paired", PAIRED, [
        ["unpaired", "Unpaired (independent groups)"],
        ["paired", "Paired (matched samples)"],
      ]),
      choice("gaussian", "Assume the data are sampled from a Gaussian (normal) distribution?", [
        ["yes", "Yes — t test at each row (parametric)"],
        [
          "no",
          `No — ${a.paired === "paired" ? "Wilcoxon signed-rank" : "Mann-Whitney"} test at each row (non-parametric)`,
        ],
      ]),
      a.gaussian === "yes" &&
        choice("pooled", "Assume every row has the same amount of scatter (SD)?", [
          ["no", "No — fit each row's SD independently (recommended)"],
          ["yes", "Yes — pool one shared SD across all rows"],
        ]),
      choice("correction", "Correct for running many comparisons at once?", [
        ["holm", "Holm correction (recommended)"],
        ["fdr", "False discovery rate (Benjamini-Hochberg)"],
        ["none", "None — treat each row independently"],
      ]),
    ],
    finish: (a) => ({
      type: "multiple-t-tests",
      params: withSets(a, {
        paired: a.paired === "paired",
        gaussian: a.gaussian === "yes",
        pooledSd: a.gaussian === "yes" && a.pooled === "yes",
        correction: a.correction as MultipleTTestsParams["correction"],
      }),
    }),
    // The per-row test's assumptions are the two-group ones (the multiple-comparison
    // correction is already a wizard question, not a checklist item).
    // Unanswered, the first options (unpaired, Gaussian) give the unpaired t test.
    checklist: (a) => {
      const [paired, gaussian] = [a.paired === "paired", a.gaussian !== "no"];
      return CHECKLISTS[
        gaussian ? (paired ? "paired-t" : "two-sample-t") : paired ? "wilcoxon-paired" : "mann-whitney"
      ];
    },
  },

  "correlation-matrix": {
    questions: (_, table) => [
      ...someSets(table, 2),
      choice("method", "Which correlation coefficient should be computed for every pair of variables?", [
        ["pearson", "Pearson (parametric)"],
        ["spearman", "Spearman (non-parametric)"],
      ]),
    ],
    finish: (a) => ({
      type: "correlation-matrix",
      params: withSets(a, { method: a.method as CorrelationParams["method"] }),
    }),
    checklist: (a) => CHECKLISTS[a.method === "spearman" ? "correlation-spearman" : "correlation-pearson"],
  },

  "multiple-regression": {
    questions: (a, table) => [
      choice("dependent", "Which variable is the dependent one (Y)?", names(dataNames(table))),
      {
        id: "predictors",
        ask: "Which variables are the predictors?",
        kind: "names",
        options: dataNames(table).filter((n) => n !== a.dependent),
      },
    ],
    finish: (a) => ({
      type: "multiple-regression",
      params: { dependent: a.dependent as string, predictors: a.predictors as string[] },
    }),
  },

  survival: {
    questions: (_, table) => {
      const groups = splitXY(table.columns).ys.length;
      return [
        choice("curveTest", "Which test should compare the survival curves?", [
          ["logrank", "Log-rank (Mantel-Cox) test (recommended)"],
          ...(groups > 2
            ? [["trend", "Log-rank test for trend — the groups are in a meaningful order"] as [string, string]]
            : []),
          ["gehan", "Gehan-Breslow-Wilcoxon test — more weight on early events"],
        ]),
        groups > 2 &&
          choice("correction", "Correct the comparisons of each pair of groups for multiple testing?", [
            ["holm", "Holm correction (recommended)"],
            ["fdr", "False discovery rate (Benjamini-Hochberg)"],
            ["none", "None — treat each pair independently"],
          ]),
      ];
    },
    finish: (a) => ({
      type: "survival",
      params: {
        curveTest: a.curveTest as SurvivalParams["curveTest"],
        correction: (a.correction ?? "holm") as SurvivalParams["correction"],
      },
    }),
    checklist: () => CHECKLISTS["survival"],
  },

  cox: {
    questions: (_, table) => [
      choice(
        "reference",
        "Which group's hazard should the others be compared to?",
        names(splitXY(table.columns).ys.map((s) => s.name)),
      ),
    ],
    finish: (a) => ({ type: "cox", params: { reference: a.reference as CoxParams["reference"] } }),
  },
  "multiple-logistic-regression": {
    questions: (a, table) => {
      // Only 0/1 columns can be the outcome — offer those, so a non-binary
      // dependent is rejected at selection time. When no column is binary,
      // offer every data column and let the runner say so.
      const binary = table.numeric
        .filter((c) => c.values.length > 0 && c.values.every((v) => v === 0 || v === 1))
        .map((c) => c.name);
      const dependents = binary.length > 0 ? binary : dataNames(table);
      return [
        choice("dependent", "Choose the dependent variable (Y).", names(dependents)),
        {
          id: "predictors",
          ask: "Choose which variables to include as predictors.",
          kind: "names",
          options: dataNames(table).filter((n) => n !== a.dependent),
        },
      ];
    },
    finish: (a) => ({
      type: "multiple-logistic-regression",
      params: { dependent: a.dependent as string, predictors: a.predictors as string[] },
    }),
  },

  "poisson-regression": {
    questions: (a, table) => [
      choice("dependent", "Choose the dependent variable (Y) — the counts.", names(dataNames(table))),
      {
        id: "predictors",
        ask: "Choose which variables to include as predictors.",
        kind: "names",
        options: dataNames(table).filter((n) => n !== a.dependent),
      },
      choice(
        "quasi",
        "Adjust for overdispersion (quasi-Poisson)? Run standard Poisson first; if the result warns about overdispersion, re-run with this on.",
        [
          ["no", "No — standard Poisson (recommended unless the dispersion warning appears)"],
          ["yes", "Yes — scale standard errors for overdispersion"],
        ],
      ),
    ],
    finish: (a) => ({
      type: "poisson-regression",
      params: {
        dependent: a.dependent as string,
        predictors: a.predictors as string[],
        quasi: a.quasi === "yes",
      },
    }),
  },

  "principal-component-analysis": {
    questions: () => [
      choice("scale", "Standardise variables before PCA?", [
        [
          "correlation",
          "Use the correlation matrix — standardise each variable (recommended when variables are on different scales)",
        ],
        ["covariance", "Use the covariance matrix — keep original units"],
      ]),
      {
        id: "components",
        ask: "Components to report (0 = all).",
        kind: "number",
        label: "Components to report (0 = all)",
        initial: 0,
        min: 0,
        validate: (v) =>
          Number.isInteger(v) && v >= 0 ? undefined : "Enter a whole number of components (0 = all).",
      },
    ],
    finish: (a) => ({
      type: "principal-component-analysis",
      params: {
        scale: (a.scale as PrincipalComponentAnalysisParams["scale"] | undefined) ?? "correlation",
        components: a.components as number,
      },
    }),
  },

  "k-means": {
    questions: () => [
      {
        id: "clusters",
        ask: "Number of clusters (k).",
        kind: "number",
        label: "Number of clusters (k)",
        initial: 2,
        min: 2,
        validate: (v) =>
          Number.isInteger(v) && v >= 2 ? undefined : "Enter a whole number of clusters (at least 2).",
      },
      choice("standardise", "Standardise variables first? — z-score each variable (recommended when variables are on different scales)", [
        ["yes", "Yes — standardise each variable (recommended when variables are on different scales)"],
        ["no", "No — cluster on the original units"],
      ]),
    ],
    finish: (a) => ({
      type: "k-means",
      params: {
        clusters: a.clusters as number,
        standardise: (a.standardise as string | undefined) !== "no",
      },
    }),
  },

  "cox-proportional-hazards": {
    questions: (a, table) => {
      const all = dataNames(table);
      const time = (a.time as string | undefined) ?? all[0];
      const status = (a.status as string | undefined) ?? all.filter((n) => n !== time)[0];
      const remaining = all.filter((n) => n !== time && n !== status);
      // Only binary (exactly two distinct values) covariates can stratify
      // the survival curves — among the covariates chosen so far.
      const chosenCovariates = (a.covariates as string[] | undefined) ?? remaining;
      const binary = chosenCovariates.filter((n) => {
        const col = table.numeric.find((c) => c.name === n);
        return col !== undefined && new Set(col.values).size === 2;
      });
      return [
        choice("time", "Which column holds the survival (follow-up) times?", names(all)),
        choice(
          "status",
          "Which column holds the event codes? 1 = event occurred, 0 = censored.",
          names(all.filter((n) => n !== time)),
        ),
        {
          id: "covariates",
          ask: "Choose which variables to include as covariates.",
          kind: "names",
          options: remaining,
        },
        choice(
          "stratifyBy",
          "Stratify the survival curves by which covariate? Only 0/1 (binary) covariates are offered.",
          [...binary.map((n): [string, string] => [n, n]), ["none", "None — one curve for all subjects"]],
        ),
        choice("ties", "How should tied event times be handled?", [
          ["efron", "Efron (recommended)"],
          ["breslow", "Breslow"],
        ]),
      ];
    },
    finish: (a) => ({
      type: "cox-proportional-hazards",
      params: {
        time: a.time as string,
        status: a.status as string,
        covariates: a.covariates as string[],
        ties: (a.ties as CoxPHParams["ties"] | undefined) ?? "efron",
        ...(a.stratifyBy !== undefined && a.stratifyBy !== "none" ? { stratifyBy: a.stratifyBy as string } : {}),
      },
    }),
    checklist: () => CHECKLISTS["cox-ph"],
  },

  "chi-square": {
    questions: (_, table) => {
      // The trend test only has a direction on a 2×k / k×2 table (k ≥ 3):
      // a 2×2 has no trend and a 3×3 has no single trend direction.
      const cols = dataGroups(table.columns).length;
      const rows = pairedGroups(table.columns)[0]?.values.length ?? 0;
      const qualifies = (cols === 2 && rows >= 3) || (rows === 2 && cols >= 3);
      return [
        qualifies &&
          choice("trendOrdered", "Are the rows (or columns) in a natural order (age, dose, time) and equally spaced?", [
            ["no", "No — do not run the test for trend"],
            ["yes", "Yes — ordered and equally spaced, run the test for trend"],
          ]),
      ];
    },
    finish: (a) => ({
      type: "chi-square",
      params: { trendOrdered: a.trendOrdered === "yes" },
    }),
  },

  mcnemar: {
    questions: () => [
      // A single-option choice: the dialog's own Cancel is the
      // "use Chi-square instead" path — the framework has no per-question
      // cancel, and a checkbox kind that must be ticked does not exist
      // either. Prism does not offer this test at all; the statement says
      // so in the result's notes as well.
      choice(
        "paired",
        "These counts are paired outcomes (same subjects measured twice, or matched pairs) — b and c are the pairs that changed. Do NOT use this for two independent groups (use Chi-square instead).",
        [["yes", "Yes — paired data"]],
      ),
      choice("continuityCorrection", "Apply the continuity correction?", [
        ["yes", "Yes (recommended, R default)"],
        ["no", "No"],
      ]),
    ],
    finish: (a) => ({
      type: "mcnemar",
      params: { continuityCorrection: a.continuityCorrection !== "no" },
    }),
  },
};
