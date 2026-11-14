// The analyses: one entry per test (its name, the data columns it needs, how it runs)
// and the one place analyses are run from. Adding a test = its file + an entry here
// (+ a wizard in views/analyses/wizards.ts when it has options).

import type {
  AnalysisType,
  AnalysisOutcome,
  AnalysisParams,
  AreaUnderCurveParams,
  BindingKineticsParams,
  BindingSaturationParams,
  ChiSquareParams,
  CorrelationParams,
  CoxPHParams,
  DoseResponseSpecialParams,
  EnzymeInhibitionParams,
  FrequencyDistributionParams,
  KMeansParams,
  McNemarParams,
  MixedEffectsParams,
  MultipleRegressionParams,
  MultipleLogisticRegressionParams,
  MultipleTTestsParams,
  NestedAnovaParams,
  LinearRegressionParams,
  LogisticRegressionParams,
  NonlinearRegressionParams,
  OutliersParams,
  SurvivalParams,
  CoxParams,
  PoissonRegressionParams,
  PrincipalComponentAnalysisParams,
  RocParams,
  ShapiroWilkParams,
  SplineLowessParams,
  ThreeWayAnovaParams,
  TwoWayAnovaParams,
  XYCorrelationParams,
} from "./types";
import { missingColumn, runColumnTest, type ColumnTestSpec } from "./column/base";
import { runDescriptiveStatistics } from "./column/descriptive-statistics";
import { compareTwoGroupsSpec } from "./column/compare-two-groups";
import { oneSampleTSpec } from "./column/one-sample-t";
import { anovaSpec } from "./column/anova";
import { kruskalWallisSpec } from "./column/kruskal-wallis";
import { rmAnovaSpec } from "./column/rm-anova";
import { friedmanSpec } from "./column/friedman";
import { shapiroWilkSpec } from "./column/shapiro-wilk";
import { kolmogorovSmirnovSpec } from "./column/kolmogorov-smirnov";
import { runOutliers } from "./column/rout";
import { runXYCorrelation } from "./xy/correlation";
import { linearRegressionSpec, runLinearRegressions } from "./xy/linear-regression";
import { demingRegressionSpec } from "./xy/deming-regression";
import { runLogisticRegression } from "./xy/logistic-regression";
import { runAreaUnderCurve } from "./xy/area-under-curve";
import { runNonlinearRegression } from "./xy/nonlinear-regression";
import { runBindingKinetics, runBindingSaturation } from "./xy/binding";
import { runEnzymeInhibition } from "./xy/enzyme-inhibition";
import { runDoseResponseSpecial } from "./xy/dose-response-special";
import { runSplineLowess } from "./xy/spline-lowess";
import { runTwoWayAnova } from "./grouped/two-way-anova";
import { runThreeWayAnova } from "./grouped/three-way-anova";
import { runMultipleTTests } from "./grouped/multiple-t-tests";
import { runNestedTTest } from "./nested/nested-t-test";
import { runNestedAnova } from "./nested/nested-anova";
import { runCorrelationMatrix } from "./multiple/correlation-matrix";
import { runMultipleRegression } from "./multiple/multiple-regression";
import { runMultipleLogisticRegression } from "./multiple/multiple-logistic-regression";
import { runPoissonRegression } from "./multiple/poisson-regression";
import { runPrincipalComponentAnalysis } from "./multiple/principal-component-analysis";
import { runKMeans } from "./multiple/k-means";
import { runChiSquare } from "./contingency/chi-square";
import { runSurvival } from "./survival/survival-analysis";
import { runCox } from "./survival/cox-regression";
import { runMcNemar } from "./contingency/mcnemar";
import { runCoxPH } from "./survival/cox-ph";
import { runMixedEffects } from "./mixed/mixed-effects";
import { runBlandAltman } from "./column/bland-altman";
import { runRocCurve } from "./column/roc-curve";
import { runFrequencyDistribution } from "./column/frequency-distribution";
import { runTranspose } from "./column/transpose";
import { runMonteCarlo } from "./simulation/monte-carlo";
import type { MonteCarloParams } from "./types";
import type { TableData } from "../store/types";
import { datasetColumns, readTable, setColumns, type Column } from "../lib/dataset";
import { ensurePackages, packageErrorMessage, packageStatus } from "./webr";

/** How every test runs: the columns of its data sets (`sets`, all by default), the
 *  wizard's params, and the row titles, which name the rows in grouped-table results.
 *  `rowGroups` (grouped tables only) is the table's third-factor bands, for the
 *  tests that read them — the others ignore it. */
type Runner = (
  columns: Column[],
  params: AnalysisParams | undefined,
  titles: (string | null)[],
  rowGroups?: TableData["rowGroups"],
) => Promise<AnalysisOutcome>;

interface Analysis {
  label: string;
  /** The exact test these params run ("Welch's t test"), to name a new analysis. */
  name?: (params: AnalysisParams | undefined) => string;
  /** Data columns (holding numbers) the test needs; checked before it is created. */
  minColumns: number;
  /** R packages the test needs (plan 00 registry names). `runAnalysis` installs
   *  them before the test runs and fails clearly when one is unavailable, so
   *  no analysis can start a computation it cannot finish. Absent: none.
   *  A function of params when only some variants need a package (normality
   *  tests: only Anderson–Darling needs `nortest`). */
  requiredPackages?: string[] | ((params: AnalysisParams | undefined) => string[]);
  run: Runner;
}

/** The packages `analysis` needs for these params, resolved. */
const requiredPackagesOf = (analysis: Analysis | undefined, params?: AnalysisParams): string[] =>
  !analysis
    ? []
    : typeof analysis.requiredPackages === "function"
      ? analysis.requiredPackages(params)
      : (analysis.requiredPackages ?? []);

/** A column test from its spec. The params cast is confined here: each spec stays
 *  type-checked against its own params. */
const spec = <P>(
  label: string,
  s: ColumnTestSpec<P>,
  requiredPackages?: (params: P | undefined) => string[],
): Analysis => ({
  label,
  name: s.subtitle && ((params) => s.subtitle!(params as P | undefined)),
  minColumns: s.minGroups,
  requiredPackages: requiredPackages && ((params) => requiredPackages(params as P | undefined)),
  run: (columns, params) => runColumnTest(columns, s, params as P | undefined),
});

export const ANALYSES: Record<AnalysisType, Analysis> = {
  "descriptive-statistics": { label: "Descriptive statistics", minColumns: 1, run: (c) => runDescriptiveStatistics(c) },
  "compare-two-groups": spec("Compare two groups", compareTwoGroupsSpec),
  "one-sample-t": spec("Compare one group to a value", oneSampleTSpec),
  anova: spec("One-way ANOVA", anovaSpec),
  "kruskal-wallis": spec("Kruskal-Wallis test", kruskalWallisSpec),
  "rm-anova": spec("Repeated-measures ANOVA", rmAnovaSpec),
  friedman: spec("Friedman test", friedmanSpec),
  // Only Anderson–Darling needs a package (`nortest`); the other three
  // normality tests are base R (or TypeScript, for D'Agostino–Pearson) —
  // so the default Shapiro–Wilk run installs nothing.
  "shapiro-wilk": spec("Normality tests", shapiroWilkSpec, (p) =>
    (p as ShapiroWilkParams | undefined)?.test === "anderson-darling" ? ["nortest"] : [],
  ),
  "kolmogorov-smirnov": spec("Kolmogorov-Smirnov test", kolmogorovSmirnovSpec),
  outliers: { label: "Identify outliers", minColumns: 1, run: (c, p) => runOutliers(c, p as OutliersParams) },
  correlation: { label: "Correlation", minColumns: 2, run: (c, p) => runXYCorrelation(c, p as XYCorrelationParams) },
  "linear-regression": {
    ...spec("Linear regression", linearRegressionSpec),
    // Several Y data sets: each regressed on its own, side by side; one: as the spec says.
    run: (c, p) => {
      const params = p as LinearRegressionParams | undefined;
      const ys = params?.ys ?? [];
      return ys.length > 1
        ? runLinearRegressions(c, { ...params!, ys })
        : runColumnTest(c, linearRegressionSpec, ys.length ? { ...params!, y: ys[0], ys: undefined } : params);
    },
  },
  "deming-regression": spec("Deming regression", demingRegressionSpec),
  "logistic-regression": {
    label: "Simple logistic regression",
    minColumns: 2,
    run: (c, p) => runLogisticRegression(c, p as LogisticRegressionParams),
  },
  "area-under-curve": {
    label: "Area under the curve",
    minColumns: 2,
    run: (c, p) => runAreaUnderCurve(c, p as AreaUnderCurveParams),
  },
  "nonlinear-regression": {
    label: "Nonlinear regression",
    minColumns: 2,
    name: (p) =>
      (p as NonlinearRegressionParams | undefined)?.interpolate
        ? "Interpolated standard curve"
        : "Nonlinear regression",
    run: (c, p, t) => runNonlinearRegression(c, p as NonlinearRegressionParams, t),
  },
  "binding-saturation": {
    label: "Binding — Saturation",
    minColumns: 2,
    run: (c, p) => runBindingSaturation(c, p as BindingSaturationParams),
  },
  "binding-kinetics": {
    label: "Binding — Kinetics",
    minColumns: 2,
    run: (c, p) => runBindingKinetics(c, p as BindingKineticsParams),
  },
  // minColumns is a floor only: the global models need X + ≥ 2 Y series
  // (including an uninhibited one), while Morrison needs X + 1 Y series —
  // the runner enforces the per-model minimum.
  "enzyme-inhibition": {
    label: "Enzyme kinetics — Inhibition",
    minColumns: 2,
    run: (c, p) => runEnzymeInhibition(c, p as EnzymeInhibitionParams),
  },
  // minColumns is a floor only: every model needs X + ≥ 2 Y series
  // (control + ≥ 1 shifted curve; full agonist + ≥ 1 partial agonist) —
  // the runner enforces it.
  "dose-response-special": {
    label: "Dose-response — Special (EC50 shift / Schild / operational)",
    minColumns: 2,
    run: (c, p) => runDoseResponseSpecial(c, p as DoseResponseSpecialParams),
  },
  "spline-lowess": {
    label: "Spline and Lowess",
    minColumns: 2,
    run: (c, p) => runSplineLowess(c, p as SplineLowessParams),
  },
  "two-way-anova": {
    label: "Two-way ANOVA",
    minColumns: 2,
    run: (c, p, t) => runTwoWayAnova(c, p as TwoWayAnovaParams, t),
  },
  "three-way-anova": {
    label: "Three-way ANOVA",
    minColumns: 2,
    run: (c, p, t, r) => runThreeWayAnova(c, p as ThreeWayAnovaParams, t, r),
  },
  "multiple-t-tests": {
    label: "Multiple t tests",
    minColumns: 2,
    run: (c, p, t) => runMultipleTTests(c, p as MultipleTTestsParams, t),
  },
  // minColumns is a floor only: the runners validate the group and subgroup
  // counts themselves (a nested t test needs exactly 2 groups, a nested
  // ANOVA 3+, each with subcolumns holding values).
  "nested-t-test": { label: "Nested t test", minColumns: 2, run: (c, p) => runNestedTTest(c, p) },
  "nested-anova": {
    label: "Nested one-way ANOVA",
    minColumns: 3,
    run: (c, p) => runNestedAnova(c, p as NestedAnovaParams),
  },
  "correlation-matrix": {
    label: "Correlation matrix",
    minColumns: 2,
    run: (c, p) => runCorrelationMatrix(c, p as CorrelationParams),
  },
  "multiple-regression": {
    label: "Multiple regression",
    minColumns: 2,
    run: (c, p) => runMultipleRegression(c, p as MultipleRegressionParams),
  },
  "multiple-logistic-regression": {
    label: "Multiple logistic regression",
    minColumns: 2,
    run: (c, p) => runMultipleLogisticRegression(c, p as MultipleLogisticRegressionParams),
  },
  "poisson-regression": {
    label: "Poisson regression",
    minColumns: 2,
    run: (c, p) => runPoissonRegression(c, p as PoissonRegressionParams),
  },
  "principal-component-analysis": {
    label: "Principal component analysis",
    minColumns: 2,
    run: (c, p, t) => runPrincipalComponentAnalysis(c, p as PrincipalComponentAnalysisParams, t),
  },
  "k-means": {
    label: "K-means clustering",
    minColumns: 2,
    run: (c, p, t) => runKMeans(c, p as KMeansParams, t),
  },
  "chi-square": {
    label: "Chi-square or Fisher's exact test",
    minColumns: 2,
    run: (c, p) => runChiSquare(c, p as ChiSquareParams),
  },
  mcnemar: { label: "McNemar's test", minColumns: 2, run: (c, p) => runMcNemar(c, p as McNemarParams) },
  survival: {
    label: "Survival analysis",
    minColumns: 3,
    requiredPackages: ["survival"],
    run: (c, p) => runSurvival(c, p as SurvivalParams),
  },
  cox: {
    label: "Cox proportional hazards regression",
    minColumns: 3,
    requiredPackages: ["survival"],
    run: (c, p) => runCox(c, p as CoxParams),
  },
  "cox-proportional-hazards": {
    label: "Cox proportional-hazards regression",
    minColumns: 3,
    requiredPackages: ["survival"],
    run: (c, p) => runCoxPH(c, p as CoxPHParams),
  },
  "mixed-effects": {
    label: "Mixed-effects model",
    minColumns: 3,
    requiredPackages: ["lme4", "lmerTest"],
    run: (c, p) => runMixedEffects(c, p as MixedEffectsParams),
  },
  "bland-altman": { label: "Bland-Altman method comparison", minColumns: 2, run: (c) => runBlandAltman(c) },
  // minColumns 1: the truth column may be text ("Diseased"/"Healthy"), so a
  // table can hold only one numeric column (the score) — the runner checks
  // the truth column and the pairing itself.
  "roc-curve": { label: "ROC curve", minColumns: 1, run: (c, p) => runRocCurve(c, p as RocParams) },
  "frequency-distribution": {
    label: "Frequency distribution",
    minColumns: 1,
    run: (c, p) => runFrequencyDistribution(c, p as FrequencyDistributionParams),
  },
  // minColumns is a floor only: compare-two-groups needs 2 data sets, the
  // others 1 — the runner validates per target (as enzyme-inhibition does
  // for its per-model minimum).
  "monte-carlo": {
    label: "Monte Carlo simulation",
    minColumns: 1,
    run: (c, p) => runMonteCarlo(c, p as MonteCarloParams),
  },
  "transpose": {
    label: "Transpose rows/columns",
    minColumns: 1,
    run: (c, _p, t) => runTranspose(c, t),
  },
};

/** Whether the wizard for `type` may run: `blocked` when a required package
 *  already failed to install (the Run button stays disabled and the dialog
 *  shows `message` plus Retry); a `not-loaded` package does not block — the
 *  analysis installs it on first run. */
export function packageGate(type: AnalysisType, params?: AnalysisParams): {
  blocked: boolean;
  message: string | null;
  packages: string[];
} {
  const required = requiredPackagesOf(ANALYSES[type], params);
  const failed = required.filter((n) => packageStatus(n).status === "failed");
  if (!failed.length) return { blocked: false, message: null, packages: required };
  const detail = failed.map((n) => packageStatus(n).error ?? `The R package “${n}” could not be installed.`).join(" ");
  return {
    blocked: true,
    message: `${failed.map((n) => `“${n}”`).join(", ")} ${failed.length > 1 ? "are" : "is"} unavailable — ${detail}`,
    packages: failed,
  };
}

// One result per table version, test and params, shared by everyone who asks:
// the analysis view and the graphs' overlays read the same run, so R works once.
// An edit makes a new TableData, which starts a fresh set of results.
const results = new WeakMap<TableData, Map<string, Promise<AnalysisOutcome>>>();

export function runAnalysis(
  testType: AnalysisType,
  data: TableData,
  params?: AnalysisParams,
): Promise<AnalysisOutcome> {
  const analysis = Object.hasOwn(ANALYSES, testType) ? ANALYSES[testType] : undefined;
  if (!analysis) return Promise.resolve({ error: `Unknown analysis type: ${String(testType)}` });
  const table = readTable(data);
  // A data set or a column the analysis names (a regression's Y…) must still be there.
  // Enzyme inhibition names several Y series (its `y` is a string[]), so an
  // array `y` is spread — a bare array here would stringify to one bogus
  // comma-joined column name and every wizard-created inhibition fit would
  // fail the check below (found in the plan-17 GUI pass: the wizard always
  // sets `y`, so its fits hit this path while the `y`-less fixtures did not).
  // prettier-ignore
  const named = params as
    { x?: string; y?: string | string[]; ys?: string[]; y2?: string; dependent?: string; reference?: string; control?: string; compareWith?: string; predictors?: string[]; datasets?: string[]; time?: string; status?: string; covariates?: string[]; stratifyBy?: string } | undefined;
  // prettier-ignore
  const chosen = [
    ...(Array.isArray(named?.y) ? named.y : named?.y !== undefined ? [named.y] : []),
    ...(named?.ys ?? []),
    named?.x, named?.y2, named?.dependent, named?.reference, named?.control, named?.compareWith, ...(named?.predictors ?? []), ...(named?.datasets ?? []), named?.time, named?.status, ...(named?.covariates ?? []), named?.stratifyBy,
  ];
  const gone =
    params?.sets?.find((name) => !table.sets.some((s) => s.name === name)) ??
    chosen.find(
      (name) =>
        name !== undefined &&
        // A Y data set's replicates pool (see datasetColumns): "Control"
        // names "Control_1..3", so it counts as present.
        !table.columns.some((c) => c.name === name) &&
        datasetColumns(table.columns, name).length === 0,
    );
  if (gone) return Promise.resolve({ error: missingColumn(gone) });
  const byTest = results.get(data) ?? new Map<string, Promise<AnalysisOutcome>>();
  results.set(data, byTest);
  const key = `${testType} ${JSON.stringify(params ?? null)}`;
  let result = byTest.get(key);
  if (!result) {
    const columns = params?.sets ? setColumns(table, params.sets) : table.columns;
    result = (async () => {
      // A package-dependent test installs its packages first; a failure is a
      // user-facing error, never a raw R error — and the run is not cached,
      // so asking again retries the install.
      const required = requiredPackagesOf(analysis, params);
      if (required.length) {
        try {
          await ensurePackages(required);
        } catch (err) {
          byTest.delete(key);
          return { error: packageErrorMessage(err) };
        }
      }
      try {
        const outcome = await analysis.run(columns, params, table.titles, data.rowGroups);
        // A failed run is not cached — whether the runner threw (below) or
        // returned an error outcome (a bad fit, a timeout, a cancel): asking
        // again runs it for real instead of replaying the stale error.
        // Without this, the Retry button after a timeout/cancel was a no-op.
        if ("error" in outcome) byTest.delete(key);
        return outcome;
      } catch (err: unknown) {
        // A failure (an R error, R not starting) is shown, not kept: asking again retries.
        byTest.delete(key);
        return { error: `Could not run the test: ${err instanceof Error ? err.message : String(err)}` };
      }
    })();
    byTest.set(key, result);
  }
  return result;
}
