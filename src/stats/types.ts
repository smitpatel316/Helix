// Analysis contract — the single source of truth for what a test receives
// (columns + params) and returns (a result or an error).

export type AnalysisType =
  | "descriptive-statistics"
  | "compare-two-groups"
  | "one-sample-t"
  | "anova"
  | "kruskal-wallis"
  | "rm-anova"
  | "friedman"
  | "shapiro-wilk"
  | "kolmogorov-smirnov"
  | "correlation"
  | "linear-regression"
  | "deming-regression"
  | "simple-logistic-regression"
  | "area-under-curve"
  | "nonlinear-regression"
  | "standard-curve-interpolation"
  | "two-way-anova"
  | "three-way-anova"
  | "multiple-t-tests"
  | "nested-t-test"
  | "nested-anova"
  | "correlation-matrix"
  | "multiple-regression"
  | "multiple-logistic-regression"
  | "poisson-regression"
  | "spline-lowess"
  | "binding-saturation"
  | "binding-kinetics"
  | "enzyme-inhibition"
  | "dose-response-special"
  | "outliers"
  | "chi-square"
  | "survival-log-rank"
  | "cox-proportional-hazards"
  | "bland-altman"
  | "roc-curve"
  | "frequency-distribution";

/** What the New Analysis picker offers: a test, or "Compare more than two groups",
 *  which its wizard resolves to one-way ANOVA, Kruskal-Wallis, repeated-measures ANOVA
 *  or Friedman (as Prism does). */
export type AnalysisPickerValue = AnalysisType | "compare-many-groups";

// The choices of the params, one list each: wizards ask among them, the types come from
// them, and a file's value outside them is left out (the test takes its default).
export const TAILS = ["two-sided", "less", "greater"] as const;
export const POSTHOCS = ["none", "tukey", "bonferroni"] as const;
export const RANK_POSTHOCS = ["none", "dunn"] as const;
export const NONLINEAR_MODELS = [
  "line",
  "sigmoidal-4pl-logx",
  "sigmoidal-4pl-x",
  "semilog-line",
  "hyperbola",
  "quadratic",
  "cubic",
  // Exponential family (plan 08, 1/2: decay first).
  "one-phase-decay",
  "two-phase-decay",
  "plateau-decay",
  // Plan 08, 2/2: association and growth.
  "one-phase-association",
  "exponential-growth",
  // Plan 09: enzyme kinetics (substrate–velocity).
  "michaelis-menten",
  "allosteric-sigmoidal",
  "substrate-inhibition",
] as const;
export const CORRELATION_METHODS = ["pearson", "spearman"] as const;
/** Binding — Saturation models (plan 16): one-site total, two-site
 *  specific, and the two-series total+nonspecific fits (NS/Background shared). */
export const BINDING_SATURATION_MODELS = [
  "one-site-total",
  "two-site-specific",
  "one-site-total-and-ns",
  "two-site-total-and-ns",
] as const;
/** Binding — Kinetics models (plan 16): one/two-phase association and
 *  dissociation, plus association-then-dissociation (one experiment). */
export const BINDING_KINETICS_MODELS = [
  "association-one-phase",
  "dissociation-one-phase",
  "association-two-phase",
  "dissociation-two-phase",
  "association-then-dissociation",
] as const;
/** Enzyme kinetics — Inhibition models (plan 17): global fits over
 *  substrate–velocity curves at several inhibitor concentrations
 *  (competitive, noncompetitive, uncompetitive, mixed — Vmax, Km, Ki and
 *  Alpha shared across series), plus the single-curve tight-binding
 *  Morrison Ki fit. */
export const ENZYME_INHIBITION_MODELS = [
  "competitive",
  "noncompetitive",
  "uncompetitive",
  "mixed",
  "morrison",
] as const;
/** Dose-response — Special models (plan 18): global fits over several
 *  dose-response curves — EC50 shift (each curve its own LogEC50; Bottom,
 *  Top, HillSlope shared), Gaddum/Schild (all parameters shared; the
 *  SchildSlope = 1 variant reports pA2 = pKb), and the operational model
 *  for partial agonists (full agonist as a 4PL; partial agonists via
 *  Black & Leff, sharing Basal, Effectmax and n). */
export const DOSE_RESPONSE_SPECIAL_MODELS = ["ec50-shift", "schild", "schild-slope-1", "operational-partial"] as const;
export const CORRELATION_MODES = ["x-vs-every-y", "two-datasets", "matrix"] as const;
export const TWO_WAY_DESIGNS = ["ordinary", "repeated-measures", "nonparametric"] as const;
export const POSTHOC_TARGETS = ["groups", "rows"] as const;
/** The terms a three-way ANOVA's post-hoc can follow up (one term only). */
export const THREE_WAY_TERMS = ["A", "B", "C", "A:B", "A:C", "B:C", "A:B:C"] as const;
export const CORRECTIONS = ["holm", "fdr", "none"] as const;
export const BIN_MODES = ["auto", "width", "count"] as const;
/** ROUT's Q, in percent. */
export const ROUT_Q = { min: 0.01, max: 50 };

/** Params for "compare-two-groups": resolves to Student/Welch t-test, paired
 *  t-test, ratio t-test, Mann-Whitney, or Wilcoxon signed-rank, Prism-wizard style. */
export interface CompareTwoGroupsParams {
  paired: boolean;
  gaussian: boolean;
  /** Only meaningful when gaussian && !paired (Student vs Welch). */
  equalVariance: boolean;
  /** Only meaningful when paired && gaussian: compare ratios (log-transformed)
   *  instead of differences — for data where proportional change is what matters. */
  ratio: boolean;
  /** "less"/"greater" follow R's t.test semantics: alternative on (col0 vs col1). */
  tails: (typeof TAILS)[number];
}

/** Params for "one-sample-t": tests each column against a hypothetical value —
 *  resolves to a one-sample t test (gaussian) or a Wilcoxon signed-rank test. */
export interface OneSampleTParams {
  hypotheticalValue: number;
  tails: (typeof TAILS)[number];
  gaussian: boolean;
}

/** Params for "anova": optional post-hoc pairwise comparisons between groups. */
export interface AnovaParams {
  posthoc: (typeof POSTHOCS)[number];
}

/** Params for "kruskal-wallis": optional Dunn's post-hoc pairwise comparisons between groups. */
export interface KruskalWallisParams {
  posthoc: (typeof RANK_POSTHOCS)[number];
}

/** Params for "friedman": optional Dunn's post-hoc pairwise comparisons between groups
 *  (block-rank flavor — same "none" | "dunn" shape as Kruskal-Wallis). */
export interface FriedmanParams {
  posthoc: (typeof RANK_POSTHOCS)[number];
}

/** Params for "linear-regression" (XY table): which Y series to regress on X, and
 *  whether to force the line through the origin (intercept = 0). */
export interface LinearRegressionParams {
  /** Omitted defaults to the first Y data column. */
  y?: string;
  forceOrigin: boolean;
}

/** Params for "deming-regression" (XY table): which Y series to compare with X,
 *  and the error-variance ratio λ = σ²ε/σ²δ (variance of the Y errors over
 *  variance of the X errors — the deming::deming / MethComp::Deming convention,
 *  λ = (ystd/xstd)²). λ = 1 assumes equal error in both; λ must be > 0. */
export interface DemingRegressionParams {
  /** Omitted defaults to the first Y data column. */
  y?: string;
  lambda: number;
}

/** Params for "simple-logistic-regression" (XY table): which Y series is the
 *  binary (0/1) outcome. Predictor is always X. */
export interface SimpleLogisticRegressionParams {
  /** Omitted defaults to the first Y data column. */
  y?: string;
}

/** Params for "area-under-curve": trapezoidal-rule AUC of every Y series against X,
 *  measured from a horizontal baseline (Prism's "Baseline Y =", default 0). */
export interface AreaUnderCurveParams {
  /** Baseline Y value the area is measured from (peaks are heights above it). */
  baseline: number;
}

/** Curated "Standard curves to interpolate" models (Prism's first category) that
 *  fit reliably in WebR. `-logx`/`-x` note whether X is log(concentration) or the
 *  raw concentration. Line/semilog/quadratic/cubic are linear-in-parameters (lm);
 *  the sigmoidal + hyperbola forms are nonlinear (nls). */
export type NonlinearModel = (typeof NONLINEAR_MODELS)[number];

/** Params for "nonlinear-regression" (XY table): which Y series to fit, and which
 *  curated standard curve. */
export interface NonlinearRegressionParams {
  /** Omitted defaults to the first Y data column. */
  y?: string;
  model: NonlinearModel;
}

/** Params for "standard-curve-interpolation" (XY table): fit a standard curve
 *  to the standards, then read unknown concentrations off it from their Y
 *  (response) values. */
export interface StandardCurveInterpolationParams {
  /** Omitted defaults to the first Y data column. */
  y?: string;
  model: NonlinearModel;
  /** The unknown Y values to interpolate, in the order entered. */
  unknowns: number[];
}

/** One interpolated unknown: `x: null` means the Y value falls outside the
 *  fitted curve's range and cannot be interpolated (see the result's notes). */
export interface InterpolationRow {
  unknownY: number;
  x: number | null;
  ciLow: number | null;
  ciHigh: number | null;
}

/** Params for "correlation-matrix": Pearson (parametric) vs. Spearman
 *  (rank-based, non-parametric). */
export interface CorrelationParams {
  method: (typeof CORRELATION_METHODS)[number];
}

/** Params for "correlation" on an XY table, Prism-style: Pearson vs. Spearman, and
 *  which of 3 modes to run — X against every Y series, two explicitly chosen data
 *  series, or a full correlation matrix among the Y series (X excluded). */
export interface XYCorrelationParams {
  method: (typeof CORRELATION_METHODS)[number];
  mode: (typeof CORRELATION_MODES)[number];
  /** Required for "two-datasets": the two column names to correlate. */
  datasets?: [string, string];
}

/** Params for "multiple-regression": which variable is the dependent (Y), and which
 *  other data-bearing variables to include as predictors. `predictors` omitted (or
 *  empty) falls back to every other data-bearing variable. */
export interface MultipleRegressionParams {
  dependent: string;
  predictors?: string[];
}

/** Params for "multiple-logistic-regression": which variable is the binary (0/1)
 *  outcome, and which other data-bearing variables to include as predictors.
 *  `predictors` omitted (or empty) falls back to every other data-bearing variable.
 *  Same shape as MultipleRegressionParams — a distinct interface so the wizard's
 *  params stay type-checked per analysis. */
export interface MultipleLogisticRegressionParams {
  dependent: string;
  predictors?: string[];
}

/** Params for "poisson-regression": which variable is the count outcome, and
 *  which other data-bearing variables to include as predictors. `predictors`
 *  omitted (or empty) falls back to every other data-bearing variable.
 *  `quasi` refits with family quasipoisson — same coefficients, standard errors
 *  scaled by sqrt(Pearson dispersion) — for overdispersed counts. */
export interface PoissonRegressionParams {
  dependent: string;
  predictors?: string[];
  quasi: boolean;
}

/** Params for "two-way-anova" on a Grouped table's column-groups × row position:
 *  "ordinary" (parametric, independent samples), "repeated-measures" (parametric,
 *  matched by row — each replicate column is the same subject across every row;
 *  incomplete replicate columns are dropped), or "nonparametric" (Scheirer-Ray-Hare).
 *  `posthoc` (parametric designs only) pairwise-compares either groups within each
 *  row or rows within each group ("row means"), Tukey- or Bonferroni-corrected. */
export interface TwoWayAnovaParams {
  design: (typeof TWO_WAY_DESIGNS)[number];
  posthoc: (typeof POSTHOCS)[number];
  posthocTarget: (typeof POSTHOC_TARGETS)[number];
}

/** Params for "three-way-anova" on a Grouped table's column-groups × row
 *  position × row bands: ordinary (parametric) only. `posthoc` pairwise-compares
 *  the means of one term (`posthocTerm`, required when posthoc !== "none"),
 *  Tukey- or Bonferroni-corrected. */
export interface ThreeWayAnovaParams {
  posthoc: (typeof POSTHOCS)[number];
  posthocTerm?: (typeof THREE_WAY_TERMS)[number];
}

/** Params for "nested-anova" on a Nested table: optional post-hoc pairwise
 *  comparisons between groups, on the subcolumn means (same choices as ANOVA). */
export interface NestedAnovaParams {
  posthoc: (typeof POSTHOCS)[number];
}

/** Params for "multiple-t-tests": a per-row t test (or Wilcoxon/Mann-Whitney)
 *  between a Grouped table's exactly-2 column-groups, with a multiplicity
 *  correction across rows. `paired` runs a paired test, matching replicate columns
 *  by position between the 2 groups. `pooledSd` (parametric only) assumes every row
 *  shares one SD (pooled across rows) instead of estimating each row's independently
 *  — more power when that assumption holds. */
export interface MultipleTTestsParams {
  paired: boolean;
  gaussian: boolean;
  pooledSd: boolean;
  correction: (typeof CORRECTIONS)[number];
}

/** Params for "binding-saturation" (XY table): which Y series is the total
 *  binding, and which saturation model. The two-series models also take
 *  `y2`, the nonspecific-binding series, fitted jointly with NS and
 *  Background shared between the series. */
export type BindingSaturationModel = (typeof BINDING_SATURATION_MODELS)[number];
export interface BindingSaturationParams {
  /** Omitted defaults to the first Y data column. */
  y?: string;
  model: BindingSaturationModel;
  /** The nonspecific series (two-series models only); omitted defaults to
   *  the second Y data column. */
  y2?: string;
}

/** Params for "binding-kinetics" (XY table, X = time): which Y series, and
 *  which kinetics model. `ligandConcentration` (association-one-phase only)
 *  is the radioligand concentration in the experiment; with a `koff` from a
 *  dissociation experiment it derives kon and the kinetic Kd. `hotNM` /
 *  `time0` are the constrained constants of association-then-dissociation
 *  (required for that model). */
export type BindingKineticsModel = (typeof BINDING_KINETICS_MODELS)[number];
export interface BindingKineticsParams {
  /** Omitted defaults to the first Y data column. */
  y?: string;
  model: BindingKineticsModel;
  /** Radioligand concentration (association-one-phase only), same units as
   *  the experiment; omitted = kon / kinetic Kd not reported. */
  ligandConcentration?: number;
  /** Koff from a dissociation experiment (association-one-phase only), same
   *  time units as X; omitted = kon / kinetic Kd not reported. */
  koff?: number;
  /** Radioligand concentration in nM during association
   *  (association-then-dissociation only, required). */
  hotNM?: number;
  /** Time at which dissociation starts (association-then-dissociation only,
   *  required), same time units as X. */
  time0?: number;
}

/** Params for "enzyme-inhibition" (XY table): which Y series to include
 *  (default: all), which inhibition model, and the per-series inhibitor
 *  concentration [I] — from the column titles when numeric, else
 *  wizard-filled. Morrison is a single-curve fit (X = total inhibitor
 *  concentration at one fixed [S]): `enzymeConcentration` (Et) is required,
 *  and `substrateConcentration` + `kmForMorrison` (both or neither) convert
 *  the fitted Kiapp to Ki. */
export type EnzymeInhibitionModel = (typeof ENZYME_INHIBITION_MODELS)[number];
export interface EnzymeInhibitionParams {
  /** Omitted defaults to all Y data columns. */
  y?: string[];
  model: EnzymeInhibitionModel;
  /** Per-series [I], keyed by Y column name. */
  inhibitorConcentrations?: Record<string, number>;
  /** Total enzyme concentration Et (Morrison only, required). */
  enzymeConcentration?: number;
  /** Fixed substrate concentration [S] (Morrison only, with Km). */
  substrateConcentration?: number;
  /** Michaelis constant Km (Morrison only, with [S]) — converts Kiapp to Ki. */
  kmForMorrison?: number;
}

/** Params for "dose-response-special" (XY table, X = log agonist
 *  concentration): which Y series to include (default: all — order
 *  matters, the first is the control / full agonist), which special
 *  model, and the per-series antagonist concentration B for Schild /
 *  EC50 shift — from the column titles when numeric, else wizard-filled.
 *  `bUnits` is the units B was entered in (default "M"): pA2 is the
 *  negative log of B in these units, and Kb is reported in them.
 *  `fixHillSlope` (Schild only, default false) constrains HillSlope to
 *  1.0. The operational model takes no B: the first series is the full
 *  agonist, the rest partial agonists. */
export type DoseResponseSpecialModel = (typeof DOSE_RESPONSE_SPECIAL_MODELS)[number];
export interface DoseResponseSpecialParams {
  /** Omitted defaults to all Y data columns, in table order — the first
   *  is the control (no antagonist) for Schild / EC50 shift, the full
   *  agonist for the operational model. */
  ys?: string[];
  model: DoseResponseSpecialModel;
  /** Per-series B, keyed by Y column name (Schild / EC50 shift only). */
  antagonistConcentrations?: Record<string, number>;
  /** Units B was entered in — shown next to pA2; default "M". */
  bUnits?: string;
  /** Constrain HillSlope to 1.0 (Schild only, default false). */
  fixHillSlope?: boolean;
}

/** Params for "spline-lowess" (XY table): smooth a chosen Y series against X
 *  with no model assumed — Lowess (locally weighted smoothing, span `f`) or a
 *  smoothing spline (`spar`, or `df`, or neither for the GCV auto-choice).
 *  Only one of `spar`/`df` may be set. */
export interface SplineLowessParams {
  /** Omitted defaults to the first Y data column. */
  y?: string;
  method: "spline" | "lowess";
  /** Lowess span: the fraction of points in each local fit (default 2/3, range (0, 1]). */
  f: number;
  /** Spline smoothing parameter (null = choose automatically by GCV, the default). */
  spar?: number | null;
  /** Alternative spline control: the equivalent degrees of freedom. */
  df?: number | null;
}

/** Params for "outliers" (Column table): ROUT-style outlier detection — each
 *  column is fit independently to a robust mean, and residuals are flagged
 *  outliers when their FDR-adjusted P falls below Q (Prism's "Q%", the
 *  maximum desired false discovery rate — smaller Q is more conservative). */
export interface OutliersParams {
  q: number;
}

/** Params for "frequency-distribution" (Column table): how each column's values
 *  are grouped into bins. `binWidth` is required for "width", `binCount` for
 *  "count"; `startAt` is the lower edge of the first bin (width/count modes),
 *  defaulting to the data minimum. */
export interface FrequencyDistributionParams {
  binMode: (typeof BIN_MODES)[number];
  binWidth?: number;
  binCount?: number;
  startAt?: number;
}

/** Params for "cox-proportional-hazards" (Multiple Variables table): which
 *  column holds survival times, which holds the 1 = event / 0 = censored
 *  codes, and which columns are the covariates. `ties` is the coxph tie
 *  method (Efron default); `stratifyBy` names the binary covariate the
 *  survival-curves graph stratifies by (the first binary covariate, or
 *  "None" — omitted when there is none). */
export interface CoxPHParams {
  /** Omitted defaults to the first data column. */
  time?: string;
  /** Omitted defaults to the second data column. */
  status?: string;
  /** Omitted (or empty — see the runner) defaults to all remaining data columns. */
  covariates?: string[];
  ties?: "efron" | "breslow";
  stratifyBy?: string;
}

/** Params for "roc-curve": a binary truth column against a continuous score
 *  column, paired by row. */
export interface RocParams {
  /** Truth column; defaults to the first data column. */
  truth?: string;
  /** Score column; defaults to the second data column. */
  score?: string;
  /** Which truth value counts as "positive" (e.g. 1, or "Diseased").
      Defaults to the larger/maximum distinct truth value. */
  positive?: string | number;
}

/** One ROC point: at this threshold (a score value), predict positive iff
 *  score ≥ threshold. The (0,0) and (1,1) endpoints have no score threshold —
 *  the graph adds them when it draws the curve. */
export interface RocPoint {
  threshold: number;
  sensitivity: number;
  specificity: number;
}

/** The data sets an analysis runs on, in this order: columns, or a grouped table's groups.
 *  Absent (files before Helix 1.0.5): all of them, the first two for a two-group test. */
interface DataSetsParam {
  sets?: string[];
}

export type AnalysisParams = DataSetsParam &
  (
    | DataSetsParam
    | CompareTwoGroupsParams
    | OneSampleTParams
    | AnovaParams
    | KruskalWallisParams
    | FriedmanParams
    | CorrelationParams
    | XYCorrelationParams
    | LinearRegressionParams
    | DemingRegressionParams
    | SimpleLogisticRegressionParams
    | AreaUnderCurveParams
    | NonlinearRegressionParams
    | StandardCurveInterpolationParams
    | BindingSaturationParams
    | BindingKineticsParams
    | EnzymeInhibitionParams
    | DoseResponseSpecialParams
    | TwoWayAnovaParams
    | ThreeWayAnovaParams
    | MultipleTTestsParams
    | NestedAnovaParams
    | MultipleRegressionParams
    | MultipleLogisticRegressionParams
    | PoissonRegressionParams
    | SplineLowessParams
    | CoxPHParams
    | OutliersParams
    | FrequencyDistributionParams
    | RocParams
  );

/** What every test reads: the table's data columns, parsed once (see lib/dataset.ts). */
export type { Column } from "../lib/dataset";

/** Descriptive statistics for one group (computed in JS, not R). `ciLow`/`ciHigh`
 *  (95% confidence interval of the mean) and `min`/`max`/`range` are only populated
 *  by the standalone "descriptive-statistics" analysis — every other test leaves
 *  them undefined, so the results view only shows those columns for that analysis. */
export interface GroupDescriptives {
  name: string;
  mean: number | null;
  sd: number | null;
  sem: number | null;
  median: number | null;
  n: number;
  ciLow?: number | null;
  ciHigh?: number | null;
  min?: number | null;
  max?: number | null;
  range?: number | null;
}

/** One displayed statistic. `p: true` marks a P value (rendered with significance colour + stars). */
export interface StatRow {
  label: string;
  value: number | null;
  p?: boolean;
}

/** One pairwise post-hoc comparison row (e.g. Tukey/Bonferroni/pairwise Wilcoxon). */
export interface ComparisonRow {
  group1: string;
  group2: string;
  /** Mean of group1 minus mean of group2. */
  diff: number | null;
  p: number | null;
}

/** A square correlation matrix: `r[i][j]` is the coefficient between variable i
 *  and j (symmetric, diagonal = 1), `p[i][j]` the matching P value. */
interface CorrelationMatrix {
  variables: string[];
  r: (number | null)[][];
  p: (number | null)[][];
  label?: string;
}

/** One row of a regression coefficients table (intercept or a predictor).
 *  `ciLow`/`ciHigh` are the Wald 95% CIs (estimate ± t(0.975, df)·SE),
 *  populated by the nonlinear-fit runner (plan 09) — other runners leave
 *  them undefined, and the results view only shows the CI columns when a
 *  coefficient carries them. A Cox regression (plan 10) also carries the
 *  hazard ratio `hazardRatio` = exp(estimate), with `ciLow`/`ciHigh` its
 *  95% CI on the hazard-ratio scale — the results view adds a Hazard ratio
 *  column when a coefficient carries one. */
export interface RegressionCoefficient {
  term: string;
  estimate: number | null;
  stdError: number | null;
  t: number | null;
  p: number | null;
  ciLow?: number | null;
  ciHigh?: number | null;
  hazardRatio?: number | null;
}

/** One row of "correlation" results in "x-vs-every-y" mode: X vs. one Y series. */
export interface CorrelationRow {
  variable: string;
  r: number | null;
  p: number | null;
}

/** One row of "area-under-curve" results: one Y series' trapezoidal AUC vs. X. */
export interface AreaUnderCurveRow {
  variable: string;
  area: number | null;
  n: number;
}

/** One row of "outliers" results: one column's outlier count + robust mean. */
export interface OutlierGroupRow {
  group: string;
  points: number;
  outliers: number;
  percent: number;
  robustMean: number | null;
}

/** One bin of a frequency distribution: left-closed `[lower, upper)`, except
 *  the last bin, which is closed on both sides so the maximum is always counted.
 *  The label matches the edge rule, e.g. "2 to <4", last bin "8 to 10". */
export interface FrequencyBinRow {
  bin: string;
  lower: number;
  upper: number;
  count: number;
  /** count / n, 0–1. */
  relativeFrequency: number;
  cumulativeCount: number;
  /** cumulativeCount / n, 0–1. */
  cumulativeFrequency: number;
}

/** One column's frequency-distribution bins. */
export interface FrequencyBins {
  column: string;
  bins: FrequencyBinRow[];
}

/** One fitted point of a smoother ("spline-lowess"): `y` is the fitted value
 *  at `x`; `observed` is the data's Y at that X, carried so the results view
 *  can show residuals without re-reading the table. */
export interface FittedPoint {
  x: number;
  y: number;
  observed?: number;
}

/** Unified result shape returned by every analysis module. */
export interface AnalysisResult {
  testType: AnalysisType;
  /** Resolved test name when params pick a specific variant, e.g. "Welch's t test". */
  subtitle?: string;
  /** Human-readable fitted-model equation, e.g. "Y = 2.927*X − 0.3322" (regressions). */
  equation?: string;
  stats: StatRow[];
  groups: GroupDescriptives[];
  notes: string;
  /** Optional pairwise post-hoc comparisons table. */
  comparisons?: ComparisonRow[];
  comparisonsLabel?: string;
  /** Optional correlation matrix (Multiple Variables correlation matrix). */
  matrix?: CorrelationMatrix;
  /** Optional regression coefficients table (multiple regression). */
  coefficients?: RegressionCoefficient[];
  /** What the coefficients table's statistic column is ("t" by default): a
   *  logistic regression's is a z-statistic, so it says "z". */
  statisticLabel?: string;
  /** Optional per-Y correlations table ("correlation", "x-vs-every-y" mode). */
  correlations?: CorrelationRow[];
  /** Optional per-Y area-under-curve table ("area-under-curve"). */
  areas?: AreaUnderCurveRow[];
  /** Optional interpolated unknowns ("standard-curve-interpolation"). */
  interpolations?: InterpolationRow[];
  /** Optional per-column outlier summary ("outliers"). */
  outlierGroups?: OutlierGroupRow[];
  /** Optional per-column frequency-distribution bins ("frequency-distribution"). */
  frequencyBins?: FrequencyBins[];
  /** Optional ROC points ("roc-curve"): one row per threshold (unique score
   *  values, descending); Youden's J is computed at render time. */
  rocCurve?: RocPoint[];
  /** Optional per-point smoother output ("spline-lowess"), the shared
   *  per-point-result mechanism for later plans: `fitted` = the fitted
   *  values at the data X's, in ascending X order; `curve` = the same
   *  smoother on a dense grid (100 points across the X range) for drawing. */
  fitted?: FittedPoint[];
  curve?: { x: number; y: number }[];
}

/** A test returns either a result or a user-facing error message. */
export type AnalysisOutcome = AnalysisResult | { error: string };
