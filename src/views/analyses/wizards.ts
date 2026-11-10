// The questions each analysis asks before it runs, as Prism does: one question per
// step, each answer choosing the next question. A wizard only declares its questions
// and how the answers make the test's params; analysis-wizard.tsx asks them.
// A test without an entry here runs as soon as it is picked.
import { DOSE_MODELS, NONLINEAR_MODELS, ROUT_Q } from "../../stats/types";
import { MODEL_LABEL } from "../../stats/xy/nonlinear-regression";
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
  OneSampleTParams,
  SurvivalParams,
  CoxParams,
  SplineLowessParams,
  StandardCurveInterpolationParams,
  ThreeWayAnovaParams,
  TwoWayAnovaParams,
  XYCorrelationParams,
} from "../../stats/types";
import { parseInhibitorConcentration } from "../../stats/xy/enzyme-inhibition";
import { splitXY, type Dataset } from "../../lib/dataset";

export type Answer = string | number | string[];
export type Answers = Record<string, Answer | undefined>;

export type Question = { id: string; ask: string } & (
  | {
      kind: "choice";
      options: { value: string; label: string }[];
      /** Adds "Not sure — check for normality first", answered "yes" or "no" by Shapiro-Wilk. */
      normality?: boolean;
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

/** Parse a comma-separated list of numbers (the standard-curve unknowns).
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

export interface Wizard {
  /** Every question, given the answers so far (false: not asked with these answers). */
  questions: (a: Answers, table: Dataset) => (Question | false)[];
  /** The test to create, once every question is answered. */
  finish: (a: Answers, table: Dataset) => { type: AnalysisType; params?: AnalysisParams };
}

const choice = (id: string, ask: string, options: [string, string][], normality = false): Question => ({
  id,
  ask,
  kind: "choice",
  options: options.map(([value, label]) => ({ value, label })),
  normality,
});

const names = (list: string[]) => list.map((n): [string, string] => [n, n]);
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

const GAUSSIAN = "Assume the data are sampled from Gaussian (normal) distributions?";
const PAIRED = "How were the data collected?";

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
          a.paired === "paired" &&
          choice("ratio", "How should the paired values be compared?", [
            ["diff", "Compute differences (paired t test)"],
            ["ratio", "Compute ratios (ratio t test) — for log-normal data"],
          ]),
        gaussian &&
          a.paired !== "paired" &&
          choice("variance", "Assume the two groups have equal variances?", [
            ["equal", "Yes — Student's t test"],
            ["unequal", "No — Welch's t test"],
          ]),
        choice("tails", "One-tailed or two-tailed P value?", [
          ["two-sided", "Two-tailed (recommended)"],
          ["less", `One-tailed: expect ${first} < ${second}`],
          ["greater", `One-tailed: expect ${first} > ${second}`],
        ]),
      ];
    },
    finish: (a) => ({
      type: "compare-two-groups",
      params: withSets(a, {
        paired: a.paired === "paired",
        gaussian: a.gaussian === "yes",
        equalVariance: a.variance !== "unequal",
        ratio: a.ratio === "ratio",
        tails: a.tails as CompareTwoGroupsParams["tails"],
      }),
    }),
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
  },

  outliers: {
    questions: (_, table) => [
      ...someSets(table, 1),
      {
        id: "q",
        ask: "How strict should the search be? ROUT fits each data set to a robust mean and flags a point as an outlier when its false discovery rate is below Q: a smaller Q flags fewer.",
        kind: "number",
        label: "Q (%) =",
        initial: 1,
        ...ROUT_Q,
        step: 0.5,
      },
    ],
    finish: (a) => ({ type: "outliers", params: withSets(a, { q: a.q as number }) }),
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

  "bland-altman": {
    questions: (a, table) => {
      const methods = dataNames(table);
      return [
        choice("first", "Which column is the first method?", names(methods)),
        choice(
          "second",
          "Which column is the second method? The difference is computed as first − second.",
          names(methods.filter((n) => n !== a.first)),
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
        choice("score", "Which column holds the test score?", names(dataNames(table).filter((n) => n !== a.truth))),
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

  correlation: {
    questions: (a, table) => {
      const ys = yNames(table);
      return [
        choice("method", "Which correlation coefficient should be computed?", [
          ["pearson", "Pearson (parametric)"],
          ["spearman", "Spearman (non-parametric)"],
        ]),
        choice("mode", "What do you want to correlate?", [
          ["x-vs-every-y", "X against every Y data set"],
          ["two-datasets", "Two chosen data sets"],
          ["matrix", "Correlation matrix among the Y data sets"],
        ]),
        a.mode === "two-datasets" && choice("first", "Which is the first data set?", names(ys)),
        a.mode === "two-datasets" &&
          choice("second", "Which is the second data set?", names(ys.filter((n) => n !== a.first))),
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
  },

  "linear-regression": {
    questions: (_, table) => [
      choice("y", "Which Y data set should be regressed on X?", names(yNames(table))),
      choice("origin", "Force the line through the origin (0,0)?", [
        ["no", "No — fit both slope and Y-intercept (recommended)"],
        ["yes", "Yes — assume Y = 0 when X = 0"],
      ]),
    ],
    finish: (a) => ({ type: "linear-regression", params: { y: a.y as string, forceOrigin: a.origin === "yes" } }),
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
      choice("y", "Which Y data set is the binary outcome (0 = no, 1 = yes)?", names(yNames(table))),
    ],
    finish: (a) => ({ type: "simple-logistic-regression", params: { y: a.y as string } }),
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

  "nonlinear-regression": {
    questions: (a, table) => {
      const dose = a.kind !== "other";
      const models = (dose ? DOSE_MODELS : NONLINEAR_MODELS.filter((m) => !isDoseModel(m))).map(
        (m): [string, string] => [m, MODEL_LABEL[m]],
      );
      const others = yNames(table).filter((n) => n !== (a.y ?? yNames(table)[0]));
      const midpoint = String(a.model).startsWith("inhibitor") ? "IC50" : "EC50";
      return [
        choice("y", "Which Y data set should be fitted?", names(yNames(table))),
        choice("kind", "Which kind of curve?", [
          ["dose", "Dose-response (sigmoidal)"],
          ["other", "Another curve (line, polynomial, exponential, Michaelis-Menten…)"],
        ]),
        choice("model", "Which curve should be fitted to X and Y?", models),
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
      ];
    },
    finish: (a) => {
      const compare =
        a.kind !== "other" && a.compareWith !== undefined && a.compareWith !== "none"
          ? { compareWith: a.compareWith as string, compare: a.compare as NonlinearRegressionParams["compare"] }
          : {};
      return {
        type: "nonlinear-regression",
        params: { y: a.y as string, model: a.model as NonlinearRegressionParams["model"], ...compare },
      };
    },
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
    questions: (a, table) => [
      choice("y", "Which Y data set is the total binding?", names(yNames(table))),
      choice("model", "Which saturation model should be fitted?", [
        ["one-site-total", "One site — Total binding"],
        ["two-site-specific", "Two sites — Specific binding"],
        ["one-site-total-and-ns", "One site — Total and nonspecific"],
        ["two-site-total-and-ns", "Two sites — Total and nonspecific"],
      ]),
      // Two-series models fit a second Y series jointly, with NS and
      // Background shared — the first option after the total series is the
      // second Y column, so it defaults to the second Y data set.
      (a.model === "one-site-total-and-ns" || a.model === "two-site-total-and-ns") &&
        choice("y2", "Which Y data set is the nonspecific binding?", names(yNames(table).filter((n) => n !== a.y))),
    ],
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
      choice("model", "Which inhibition model should be fitted?", [
        ["mixed", "Mixed model"],
        ["competitive", "Competitive"],
        ["noncompetitive", "Noncompetitive"],
        ["uncompetitive", "Uncompetitive"],
        ["morrison", "Morrison Ki (tight binding)"],
      ]),
      {
        id: "y",
        ask: "Which Y data sets should be fitted? Each is one inhibitor concentration.",
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
            model === "operational-partial"
              ? "Which Y data sets should be fitted? The first is the full agonist; the rest are partial agonists."
              : "Which Y data sets should be fitted? Each is one antagonist concentration; the first is the control (no antagonist).",
          kind: "names",
          options: yNames(table),
          min: 2,
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

  "standard-curve-interpolation": {
    questions: (_, table) => [
      choice("y", "Which Y data set holds the standards?", names(yNames(table))),
      // Same 7 options, same order and labels as the nonlinear-regression wizard.
      choice("model", "Which standard curve should be fitted to X and Y?", [
        ["sigmoidal-4pl-logx", "Sigmoidal, 4PL, X is log(concentration)"],
        ["sigmoidal-4pl-x", "Sigmoidal, 4PL, X is concentration"],
        ["line", "Line"],
        ["semilog-line", "Semilog line"],
        ["hyperbola", "Hyperbola (X is concentration)"],
        ["quadratic", "Second order polynomial (quadratic)"],
        ["cubic", "Third order polynomial (cubic)"],
      ]),
      {
        id: "unknowns",
        ask: "Enter the unknown Y values to interpolate, separated by commas (e.g. 20, 50, 80). Single Y values only — unknowns as replicate means, weighting of the fit and comparing two standard curves are not supported in this version.",
        kind: "text",
        label: "Unknown Y values",
        initial: "",
        placeholder: "20, 50, 80",
      },
    ],
    finish: (a) => ({
      type: "standard-curve-interpolation",
      params: {
        y: a.y as string,
        model: a.model as StandardCurveInterpolationParams["model"],
        unknowns: parseUnknowns(String(a.unknowns ?? "")).values,
      },
    }),
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
      const groups = splitXY(table.columns).ys.filter((c) => c.values.length > 0).length;
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
  },

  cox: {
    questions: (_, table) => [
      choice(
        "reference",
        "Which group's hazard should the others be compared to?",
        names(
          splitXY(table.columns)
            .ys.filter((c) => c.values.length > 0)
            .map((c) => c.name),
        ),
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
