// The analyses: one entry per test (its name, the data columns it needs, how it runs)
// and the one place analyses are run from. Adding a test = its file + an entry here
// (+ a wizard in views/analyses/wizards.ts when it has options).

import type {
  AnalysisType,
  AnalysisOutcome,
  AnalysisParams,
  AreaUnderCurveParams,
  CorrelationParams,
  CoxPHParams,
  FrequencyDistributionParams,
  MultipleRegressionParams,
  MultipleLogisticRegressionParams,
  MultipleTTestsParams,
  NonlinearRegressionParams,
  OutliersParams,
  RocParams,
  SimpleLogisticRegressionParams,
  StandardCurveInterpolationParams,
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
import { runRout } from "./column/rout";
import { runXYCorrelation } from "./xy/correlation";
import { linearRegressionSpec } from "./xy/linear-regression";
import { runSimpleLogisticRegression } from "./xy/logistic-regression";
import { runAreaUnderCurve } from "./xy/area-under-curve";
import { runNonlinearRegression } from "./xy/nonlinear-regression";
import { runStandardCurveInterpolation } from "./xy/standard-curve-interpolation";
import { runTwoWayAnova } from "./grouped/two-way-anova";
import { runThreeWayAnova } from "./grouped/three-way-anova";
import { runMultipleTTests } from "./grouped/multiple-t-tests";
import { runCorrelationMatrix } from "./multiple/correlation-matrix";
import { runMultipleRegression } from "./multiple/multiple-regression";
import { runMultipleLogisticRegression } from "./multiple/multiple-logistic-regression";
import { runChiSquare } from "./contingency/chi-square";
import { runLogRank } from "./survival/log-rank";
import { runCoxPH } from "./survival/cox-ph";
import { runBlandAltman } from "./column/bland-altman";
import { runRocCurve } from "./column/roc-curve";
import { runFrequencyDistribution } from "./column/frequency-distribution";
import type { TableData } from "../store/types";
import { readTable, setColumns, type Column } from "../lib/dataset";
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
   *  no analysis can start a computation it cannot finish. Absent: none. */
  requiredPackages?: string[];
  run: Runner;
}

/** A column test from its spec. The params cast is confined here: each spec stays
 *  type-checked against its own params. */
const spec = <P>(label: string, s: ColumnTestSpec<P>): Analysis => ({
  label,
  name: s.subtitle && ((params) => s.subtitle!(params as P | undefined)),
  minColumns: s.minGroups,
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
  "shapiro-wilk": spec("Shapiro-Wilk normality", shapiroWilkSpec),
  "kolmogorov-smirnov": spec("Kolmogorov-Smirnov test", kolmogorovSmirnovSpec),
  outliers: { label: "Identify outliers (ROUT)", minColumns: 1, run: (c, p) => runRout(c, p as OutliersParams) },
  correlation: { label: "Correlation", minColumns: 2, run: (c, p) => runXYCorrelation(c, p as XYCorrelationParams) },
  "linear-regression": spec("Linear regression", linearRegressionSpec),
  "simple-logistic-regression": {
    label: "Simple logistic regression",
    minColumns: 2,
    run: (c, p) => runSimpleLogisticRegression(c, p as SimpleLogisticRegressionParams),
  },
  "area-under-curve": {
    label: "Area under the curve",
    minColumns: 2,
    run: (c, p) => runAreaUnderCurve(c, p as AreaUnderCurveParams),
  },
  "nonlinear-regression": {
    label: "Nonlinear regression",
    minColumns: 2,
    run: (c, p) => runNonlinearRegression(c, p as NonlinearRegressionParams),
  },
  "standard-curve-interpolation": {
    label: "Interpolate from a standard curve",
    minColumns: 2,
    run: (c, p) => runStandardCurveInterpolation(c, p as StandardCurveInterpolationParams),
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
  "chi-square": { label: "Chi-square or Fisher's exact test", minColumns: 2, run: (c) => runChiSquare(c) },
  "survival-log-rank": {
    label: "Survival analysis (log-rank test)",
    minColumns: 3,
    run: (c) => runLogRank(c),
  },
  "cox-proportional-hazards": {
    label: "Cox proportional-hazards regression",
    minColumns: 3,
    requiredPackages: ["survival"],
    run: (c, p) => runCoxPH(c, p as CoxPHParams),
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
};

/** Whether the wizard for `type` may run: `blocked` when a required package
 *  already failed to install (the Run button stays disabled and the dialog
 *  shows `message` plus Retry); a `not-loaded` package does not block — the
 *  analysis installs it on first run. */
export function packageGate(type: AnalysisType): {
  blocked: boolean;
  message: string | null;
  packages: string[];
} {
  const required = ANALYSES[type]?.requiredPackages ?? [];
  const failed = required.filter((n) => packageStatus(n).status === "failed");
  if (!failed.length) return { blocked: false, message: null, packages: required };
  const detail = failed
    .map((n) => packageStatus(n).error ?? `The R package “${n}” could not be installed.`)
    .join(" ");
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
  const named = params as
    | { y?: string; dependent?: string; predictors?: string[]; datasets?: string[]; time?: string; status?: string; covariates?: string[]; stratifyBy?: string }
    | undefined;
  const chosen = [
    named?.y,
    named?.dependent,
    ...(named?.predictors ?? []),
    ...(named?.datasets ?? []),
    named?.time,
    named?.status,
    ...(named?.covariates ?? []),
    named?.stratifyBy,
  ];
  const gone =
    params?.sets?.find((name) => !table.sets.some((s) => s.name === name)) ??
    chosen.find((name) => name !== undefined && !table.columns.some((c) => c.name === name));
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
      const required = analysis.requiredPackages ?? [];
      if (required.length) {
        try {
          await ensurePackages(required);
        } catch (err) {
          byTest.delete(key);
          return { error: packageErrorMessage(err) };
        }
      }
      try {
        return await analysis.run(columns, params, table.titles, data.rowGroups);
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
