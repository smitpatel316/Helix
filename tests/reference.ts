// Reference test: runs every analysis (R) and draws every graph (Plotly figures) on
// fixed tables, then compares the results with `reference.json`. A change in any
// number shows up as a diff. `npm test` checks; `npm test -- --update` rewrites the
// reference after an intended change. It also checks that TypeScript and R agree
// where both compute the same thing, and that the sample project's items all work.
/// <reference types="node" />
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAnalysis } from "../src/stats";
import type { AnalysisParams, AnalysisType } from "../src/stats/types";
import type { GraphOptions, GraphType, TableData } from "../src/store/types";
import { GRAPHS, graphSeries, newGraphOptions, plotColumns } from "../src/views/graphs";
import { paintOf } from "../src/views/graphs/plot-helpers";
import { pairUp, readTable, splitXY } from "../src/lib/dataset";
import { countDataColumns, countDataGroups } from "../src/views/analyses";
import { fitLinear } from "../src/views/graphs/regression-overlay";
import { computeGroupedDEG } from "../src/lib/deg";
import { tCrit95 } from "../src/lib/student-t";
import { evalNamedVector, startR } from "../src/stats/webr";
import { prettyBreaks } from "../src/stats/column/frequency-distribution";
import { sampleProject } from "./sample-project";

// ── Tables ───────────────────────────────────────────────────────────────

/** A table from a header and rows of cells ("" = blank). */
const table = (columns: string[], rows: string[][], extra: Partial<TableData> = {}): TableData => ({
  columns,
  rows: rows.map((row) => row.map((cell) => (cell === "" ? null : cell))),
  ...extra,
});

const column = table(
  ["Title", "Control", "Low", "High", "Sparse"],
  [
    ["", "12.1", "14.3", "18.2", "9"],
    ["", "11.4", "15.1", "19.9", ""],
    ["", "13.2", "13.8", "17.5", "11"],
    ["", "12.8", "16.2", "21.3", ""],
    ["", "10.9", "14.9", "18.8", "10.5"],
    ["", "12.5", "abc", "20.1", ""],
    ["", "11.8", "15.5", "", "12"],
    ["", "30", "14.1", "19.4", ""],
  ],
  { excluded: ["2,3"] },
);

const xy = table(
  ["Title", "X", "Y1", "Y2", "Y3"],
  [
    ["", "0", "1.1", "2", "5"],
    ["", "1", "2.9", "", "4.1"],
    ["", "2", "5.2", "6.1", "3.2"],
    ["", "3", "6.8", "8.2", ""],
    ["", "4", "9.1", "9.7", "1.9"],
    ["", "5", "11.2", "12.4", "1.1"],
    ["", "6", "12.7", "", "0.4"],
    ["", "", "15", "15", "15"],
    ["", "8", "17.3", "18.1", "-0.8"],
  ],
);

/** log10 concentrations and a noisy sigmoid. */
const doseLog = table(
  ["Title", "X", "Response"],
  [
    ["", "-3", "2.1"],
    ["", "-2.5", "3.4"],
    ["", "-2", "8.2"],
    ["", "-1.5", "19.5"],
    ["", "-1", "41.2"],
    ["", "-0.5", "68.9"],
    ["", "0", "86.1"],
    ["", "0.5", "94.2"],
    ["", "1", "97.8"],
    ["", "1.5", "99.1"],
  ],
);

/** Raw concentrations, a control at 0 and a saturating response. */
const doseRaw = table(
  ["Title", "X", "Response"],
  [
    ["", "0", "1"],
    ["", "0.1", "9.8"],
    ["", "0.3", "22.5"],
    ["", "1", "47.1"],
    ["", "3", "71.9"],
    ["", "10", "88.2"],
    ["", "30", "95.1"],
    ["", "100", "98.3"],
  ],
);

const survivalTable = table(
  ["Title", "Days", "Treated", "Placebo"],
  [
    ["", "3", "1", ""],
    ["", "5", "", "1"],
    ["", "7", "0", "1"],
    ["", "8", "", "1"],
    ["", "10", "1", ""],
    ["", "12", "", "0"],
    ["", "15", "1", "1"],
    ["", "20", "0", ""],
  ],
);

/** Binary outcome vs. one predictor (simple logistic regression). */
const logistic = table(
  ["Title", "X", "Response"],
  [
    ["", "0", "0"],
    ["", "1", "0"],
    ["", "2", "0"],
    ["", "3", "0"],
    ["", "4", "1"],
    ["", "5", "0"],
    ["", "6", "1"],
    ["", "7", "1"],
    ["", "8", "1"],
    ["", "9", "1"],
  ],
);

/** Completely separated: the outcome flips exactly at X = 5, so glm diverges. */
const logisticSeparated = table(
  ["Title", "X", "Response"],
  [
    ["", "0", "0"],
    ["", "1", "0"],
    ["", "2", "0"],
    ["", "3", "0"],
    ["", "4", "0"],
    ["", "5", "1"],
    ["", "6", "1"],
    ["", "7", "1"],
    ["", "8", "1"],
    ["", "9", "1"],
  ],
);

/** Frequency distribution (plan 06): one column, n = 10. */
const freqCol = table(
  ["Title", "Values"],
  [
    ["", "2.1"],
    ["", "3.5"],
    ["", "3.9"],
    ["", "4.2"],
    ["", "5.0"],
    ["", "5.8"],
    ["", "6.1"],
    ["", "7.4"],
    ["", "8.0"],
    ["", "9.3"],
  ],
);

/** Values sitting exactly on the bin edges (plan 06, case D). */
const freqEdge = table(
  ["Title", "Values"],
  [
    ["", "2"],
    ["", "4"],
    ["", "6"],
    ["", "8"],
  ],
);

/** A gap in the middle, so two bins stay empty (plan 06, case B2). */
const freqGap = table(
  ["Title", "Values"],
  [
    ["", "1"],
    ["", "2"],
    ["", "9"],
    ["", "10"],
  ],
);

/** A constant column: one bin (plan 06 edge case). */
const freqConst = table(
  ["Title", "Values"],
  [
    ["", "5"],
    ["", "5"],
    ["", "5"],
  ],
);

/** A single value: too few to bin (plan 06 edge case). */
const freqSingle = table(["Title", "Values"], [["", "5"]]);

/** Kolmogorov-Smirnov (plan 07): two clearly separated groups (D = 1). */
const ksShifted = table(
  ["Title", "Control", "Treated"],
  [
    ["", "12.1", "18.2"],
    ["", "11.4", "19.9"],
    ["", "13.2", "17.5"],
    ["", "12.8", "21.3"],
    ["", "10.9", "18.8"],
    ["", "12.5", "20.1"],
    ["", "11.8", "19.4"],
    ["", "14.0", "22.0"],
  ],
);

/** Kolmogorov-Smirnov (plan 07): same Control vs. a similar group (D = 0.25). */
const ksSimilar = table(
  ["Title", "Control", "Similar"],
  [
    ["", "12.1", "11.9"],
    ["", "11.4", "12.6"],
    ["", "13.2", "12.2"],
    ["", "12.8", "13.1"],
    ["", "10.9", "11.5"],
    ["", "12.5", "12.9"],
    ["", "11.8", "12.0"],
    ["", "14.0", "13.5"],
  ],
);

/** Kolmogorov-Smirnov (plan 07): repeated values, so the P value is asymptotic. */
const ksTies = table(
  ["Title", "A", "B"],
  [
    ["", "12", "12"],
    ["", "12", "13"],
    ["", "13", "13"],
    ["", "13", "14"],
    ["", "14", "14"],
    ["", "14", "15"],
    ["", "15", "15"],
    ["", "15", "16"],
  ],
);

/** Kolmogorov-Smirnov (plan 07): a column compared with itself (D = 0, p = 1). */
const ksIdentical = table(
  ["Title", "X", "Y"],
  [
    ["", "12.1", "12.1"],
    ["", "11.4", "11.4"],
    ["", "13.2", "13.2"],
    ["", "12.8", "12.8"],
    ["", "10.9", "10.9"],
    ["", "12.5", "12.5"],
    ["", "11.8", "11.8"],
    ["", "14.0", "14.0"],
  ],
);

/** Kolmogorov-Smirnov (plan 07): too few values in one group — an error. */
const ksTooFew = table(
  ["Title", "A", "B"],
  [
    ["", "5", "1"],
    ["", "", "2"],
    ["", "", "3"],
    ["", "", "4"],
    ["", "", "5"],
    ["", "", "6"],
    ["", "", "7"],
    ["", "", "8"],
  ],
);

/** Two methods on the same subjects (Bland-Altman method comparison). */
const blandAltman = table(
  ["Title", "Method A", "Method B"],
  [
    ["", "12.1", "12.4"],
    ["", "11.4", "11.9"],
    ["", "13.2", "13.0"],
    ["", "12.8", "13.5"],
    ["", "10.9", "11.2"],
    ["", "12.5", "12.9"],
    ["", "11.8", "12.0"],
    ["", "13.0", "13.6"],
    ["", "12.2", "12.5"],
    ["", "11.6", "12.1"],
  ],
);

const grouped = table(
  ["Title", "A:Y1", "A:Y2", "A:Y3", "B:Y1", "B:Y2", "B:Y3", "C:Y1", "C:Y2", "C:Y3"],
  [
    ["Day 1", "10", "11", "12", "14", "15", "13", "9", "10", "11"],
    ["Day 2", "12", "13", "14", "18", "19", "17", "10", "", "12"],
    ["Day 3", "15", "14", "16", "22", "24", "21", "11", "12", "13"],
    ["Day 4", "18", "19", "17", "27", "26", "28", "12", "14", "13"],
    ["Day 5", "20", "21", "22", "31", "30", "33", "13", "13", "15"],
  ],
  { groups: 3, replicates: 3 },
);

const twoGroups = table(
  ["Title", "A:Y1", "A:Y2", "A:Y3", "B:Y1", "B:Y2", "B:Y3"],
  [
    ["Gene 1", "10", "11", "12", "20", "22", "21"],
    ["Gene 2", "5", "6", "5.5", "5.2", "6.1", "5.8"],
    ["Gene 3", "8", "9", "8.5", "4", "4.5", "3.9"],
    ["Gene 4", "30", "28", "31", "33", "", "32"],
    ["Gene 5", "2", "2.2", "1.9", "6", "6.5", "7"],
  ],
  { groups: 2, replicates: 3 },
);

/** Three-way ANOVA (plan 03): Grouped, groups 2, replicates 3, row bands
 *  WT × 2 rows / KO × 2 rows. Full-precision values are deliberate: the
 *  expected ANOVA table was computed from exactly these numbers — do not round
 *  them, or the expected values must be regenerated. */
const grouped3way = table(
  ["Title", "Placebo:Y1", "Placebo:Y2", "Placebo:Y3", "Drug:Y1", "Drug:Y2", "Drug:Y3"],
  [
    ["Day 1", "10.001230153357483", "10.29874553750847", "9.725862144637782", "11.109408161242726", "11.545329214828277", "11.008353445003538"],
    ["Day 2", "14.060143602597439", "15.340215245554534", "13.50779348144867", "19.37952510018006", "20.4898420501852", "20.35688700816006"],
    ["Day 1", "11.1054142489979", "10.069531955291795", "10.970748177536727", "13.695303194458289", "11.655785452714918", "12.542384238959782"],
    ["Day 2", "11.098777260199157", "11.710462260215024", "11.158264962208268", "14.76490886892532", "13.732553518556298", "15.271264358821702"],
  ],
  { groups: 2, replicates: 3, rowGroups: [{ name: "WT", count: 2 }, { name: "KO", count: 2 }] },
);

/** The Drug × Day 2 × KO cell emptied (all three replicates blank). */
const grouped3wayEmpty = table(
  ["Title", "Placebo:Y1", "Placebo:Y2", "Placebo:Y3", "Drug:Y1", "Drug:Y2", "Drug:Y3"],
  [
    ["Day 1", "10.001230153357483", "10.29874553750847", "9.725862144637782", "11.109408161242726", "11.545329214828277", "11.008353445003538"],
    ["Day 2", "14.060143602597439", "15.340215245554534", "13.50779348144867", "19.37952510018006", "20.4898420501852", "20.35688700816006"],
    ["Day 1", "11.1054142489979", "10.069531955291795", "10.970748177536727", "13.695303194458289", "11.655785452714918", "12.542384238959782"],
    ["Day 2", "11.098777260199157", "11.710462260215024", "11.158264962208268", "", "", ""],
  ],
  { groups: 2, replicates: 3, rowGroups: [{ name: "WT", count: 2 }, { name: "KO", count: 2 }] },
);

/** Bands that don't tile the rows (3 + 2 ≠ 4). */
const grouped3wayBadBands = { ...grouped3way, rowGroups: [{ name: "WT", count: 3 }, { name: "KO", count: 2 }] };

/** One observation per cell: no residual degrees of freedom. */
const grouped3wayN1 = table(
  ["Title", "Placebo:Y1", "Drug:Y1"],
  [
    ["Day 1", "10.0", "11.1"],
    ["Day 2", "14.1", "19.4"],
    ["Day 1", "11.1", "13.7"],
    ["Day 2", "11.1", "14.8"],
  ],
  { groups: 2, replicates: 1, rowGroups: [{ name: "WT", count: 2 }, { name: "KO", count: 2 }] },
);

const multiple = table(
  ["Title", "Weight", "Height", "Age", "Dose"],
  [
    ["", "70", "175", "34", "1"],
    ["", "82", "181", "45", "2"],
    ["", "65", "168", "29", "1"],
    ["", "90", "185", "51", "3"],
    ["", "75", "172", "38", "2"],
    ["", "58", "160", "25", "1"],
    ["", "88", "179", "48", "3"],
    ["", "72", "170", "41", "2"],
    ["", "95", "188", "55", "3"],
    ["", "68", "", "33", "1"],
  ],
);

const volcanoTable = table(
  ["Title", "Gene", "Log2 FC", "P"],
  [
    ["", "TP53", "2.5", "0.0001"],
    ["", "MYC", "-1.8", "0.002"],
    ["", "GAPDH", "0.1", "0.8"],
    ["", "EGFR", "1.2", "0.03"],
    ["", "ACTB", "-0.3", "0.5"],
  ],
);

const contingency2 = table(
  ["Title", "Outcome A", "Outcome B"],
  [
    ["Drug", "15", "5"],
    ["Placebo", "6", "14"],
  ],
);
const contingency3 = table(
  ["Title", "Outcome A", "Outcome B", "Outcome C"],
  [
    ["North", "20", "15", "10"],
    ["South", "12", "18", "25"],
    ["East", "14", "16", "15"],
  ],
);

/** As the app creates them: many columns, only the first ones filled. */
const wide = (t: TableData, width: number): TableData => ({
  ...t,
  columns: [...t.columns, ...Array.from({ length: width }, (_, i) => `Extra ${i + 1}`)],
});
const contingencyWide = wide(contingency2, 13);
/** An XY table whose X column is still empty. */
const xyNoX = table(
  ["Title", "X", "Y1", "Y2"],
  [
    ["", "", "1", "2"],
    ["", "", "3", "5"],
    ["", "", "4", "4"],
    ["", "", "6", "9"],
  ],
);

// ── What to run ──────────────────────────────────────────────────────────

const ANALYSES: [string, TableData, AnalysisType, AnalysisParams?][] = [
  ["column", column, "descriptive-statistics"],
  [
    "column",
    column,
    "compare-two-groups",
    { paired: false, gaussian: true, equalVariance: false, ratio: false, tails: "two-sided" },
  ],
  [
    "column",
    column,
    "compare-two-groups",
    { paired: false, gaussian: true, equalVariance: true, ratio: false, tails: "less" },
  ],
  [
    "column",
    column,
    "compare-two-groups",
    { paired: true, gaussian: true, equalVariance: false, ratio: false, tails: "two-sided" },
  ],
  [
    "column",
    column,
    "compare-two-groups",
    { paired: true, gaussian: true, equalVariance: false, ratio: true, tails: "two-sided" },
  ],
  [
    "column",
    column,
    "compare-two-groups",
    { paired: false, gaussian: false, equalVariance: false, ratio: false, tails: "two-sided" },
  ],
  [
    "column",
    column,
    "compare-two-groups",
    { paired: true, gaussian: false, equalVariance: false, ratio: false, tails: "greater" },
  ],
  ["column", column, "one-sample-t", { hypotheticalValue: 12, tails: "two-sided", gaussian: true }],
  ["column", column, "one-sample-t", { hypotheticalValue: 12, tails: "two-sided", gaussian: false }],
  ["column", column, "anova", { posthoc: "none" }],
  ["column", column, "anova", { posthoc: "tukey" }],
  ["column", column, "anova", { posthoc: "bonferroni" }],
  ["column", column, "kruskal-wallis", { posthoc: "dunn" }],
  ["column", column, "rm-anova"],
  ["column", column, "rm-anova", { posthoc: "tukey" }],
  ["column", column, "rm-anova", { posthoc: "bonferroni" }],
  ["column", column, "friedman", { posthoc: "dunn" }],
  ["column", column, "shapiro-wilk"],
  // Kolmogorov-Smirnov (plan 07): separated, similar, ties (asymptotic p),
  // identical, too-few (error), the shared multi-column table (first two
  // columns + the non-numeric cell), and an explicit `sets` selection.
  ["ksShifted", ksShifted, "kolmogorov-smirnov"],
  ["ksSimilar", ksSimilar, "kolmogorov-smirnov"],
  ["ksTies", ksTies, "kolmogorov-smirnov"],
  ["ksIdentical", ksIdentical, "kolmogorov-smirnov"],
  ["ksTooFew", ksTooFew, "kolmogorov-smirnov"],
  ["column", column, "kolmogorov-smirnov"],
  ["column", column, "kolmogorov-smirnov", { sets: ["High", "Control"] }],
  ["column", column, "outliers", { q: 1 }],
  ["column", column, "outliers", { q: 5 }],
  ["xy", xy, "correlation", { method: "pearson", mode: "x-vs-every-y" }],
  ["xy", xy, "correlation", { method: "spearman", mode: "x-vs-every-y" }],
  ["xy", xy, "correlation", { method: "pearson", mode: "two-datasets", datasets: ["Y1", "Y3"] }],
  ["xy", xy, "correlation", { method: "pearson", mode: "matrix" }],
  ["xy", xy, "linear-regression", { forceOrigin: false }],
  ["xy", xy, "linear-regression", { y: "Y2", forceOrigin: false }],
  ["xy", xy, "linear-regression", { y: "Y3", forceOrigin: true }],
  ["xy", xy, "area-under-curve", { baseline: 0 }],
  ["xy", xy, "area-under-curve", { baseline: 2 }],
  ["xy", xy, "nonlinear-regression", { model: "line" }],
  ["xy", xy, "nonlinear-regression", { y: "Y3", model: "quadratic" }],
  ["xy", xy, "nonlinear-regression", { y: "Y1", model: "cubic" }],
  ["doseLog", doseLog, "nonlinear-regression", { model: "sigmoidal-4pl-logx" }],
  // Standard-curve interpolation (plan 02): the reference 4PL fit, the
  // out-of-range case, the lm band path (line), and the 4PL-X band path.
  ["doseLog", doseLog, "standard-curve-interpolation", { model: "sigmoidal-4pl-logx", unknowns: [20, 50, 80] }],
  ["doseLog", doseLog, "standard-curve-interpolation", { model: "sigmoidal-4pl-logx", unknowns: [20, 150] }],
  ["xy", xy, "standard-curve-interpolation", { model: "line", unknowns: [5, 10] }],
  ["doseRaw", doseRaw, "standard-curve-interpolation", { model: "sigmoidal-4pl-x", unknowns: [30, 60] }],
  ["doseRaw", doseRaw, "nonlinear-regression", { model: "sigmoidal-4pl-x" }],
  ["doseRaw", doseRaw, "nonlinear-regression", { model: "hyperbola" }],
  ["doseRaw", doseRaw, "nonlinear-regression", { model: "semilog-line" }],
  ["logistic", logistic, "simple-logistic-regression", {}],
  ["logisticSeparated", logisticSeparated, "simple-logistic-regression", {}],
  ["blandAltman", blandAltman, "bland-altman", { sets: ["Method A", "Method B"] }],
  // Frequency distribution (plan 06): A explicit width, B explicit count, B2
  // empty bins, C auto (Sturges + pretty), D on-edge values, plus the constant,
  // too-few and invalid-params edge cases and a multi-column run (the shared
  // `column` table, whose Low column holds a non-numeric cell).
  ["freqCol", freqCol, "frequency-distribution", { binMode: "width", binWidth: 2, startAt: 2 }],
  ["freqCol", freqCol, "frequency-distribution", { binMode: "count", binCount: 5, startAt: 2 }],
  ["freqGap", freqGap, "frequency-distribution", { binMode: "width", binWidth: 2, startAt: 0 }],
  ["freqCol", freqCol, "frequency-distribution", { binMode: "auto" }],
  ["freqCol", freqCol, "frequency-distribution", {}],
  ["freqCol", freqCol, "frequency-distribution", { binMode: "width", binWidth: 100, startAt: 2 }],
  ["freqEdge", freqEdge, "frequency-distribution", { binMode: "width", binWidth: 2, startAt: 2 }],
  ["freqConst", freqConst, "frequency-distribution", { binMode: "auto" }],
  ["freqSingle", freqSingle, "frequency-distribution", { binMode: "auto" }],
  ["freqCol", freqCol, "frequency-distribution", { binMode: "width", binWidth: 0, startAt: 2 }],
  ["freqCol", freqCol, "frequency-distribution", { binMode: "count", binCount: 1, startAt: 2 }],
  ["column", column, "frequency-distribution", { binMode: "auto" }],
  ["survival", survivalTable, "survival-log-rank"],
  ["grouped", grouped, "two-way-anova", { design: "ordinary", posthoc: "none", posthocTarget: "groups" }],
  ["grouped", grouped, "two-way-anova", { design: "ordinary", posthoc: "tukey", posthocTarget: "groups" }],
  ["grouped", grouped, "two-way-anova", { design: "ordinary", posthoc: "bonferroni", posthocTarget: "rows" }],
  ["grouped", grouped, "two-way-anova", { design: "repeated-measures", posthoc: "tukey", posthocTarget: "groups" }],
  ["grouped", grouped, "two-way-anova", { design: "nonparametric", posthoc: "none", posthocTarget: "groups" }],
  ["twoGroups", twoGroups, "multiple-t-tests", { paired: false, gaussian: true, pooledSd: false, correction: "holm" }],
  ["twoGroups", twoGroups, "multiple-t-tests", { paired: false, gaussian: true, pooledSd: true, correction: "fdr" }],
  ["twoGroups", twoGroups, "multiple-t-tests", { paired: true, gaussian: true, pooledSd: false, correction: "none" }],
  ["twoGroups", twoGroups, "multiple-t-tests", { paired: false, gaussian: false, pooledSd: false, correction: "holm" }],
  ["twoGroups", twoGroups, "multiple-t-tests", { paired: true, gaussian: false, pooledSd: false, correction: "fdr" }],
  // Three-way ANOVA (plan 03): the ANOVA table, Tukey on A:B, the two-way
  // ANOVA on the same table (rowGroups must be ignored — no diff), and the
  // empty-cell / bands-don't-tile / no-residual-df errors.
  ["grouped3way", grouped3way, "three-way-anova", { posthoc: "none" }],
  ["grouped3way", grouped3way, "three-way-anova", { posthoc: "tukey", posthocTerm: "A:B" }],
  ["grouped3way", grouped3way, "three-way-anova", { posthoc: "bonferroni", posthocTerm: "A:B:C" }],
  ["grouped3way", grouped3way, "two-way-anova", { design: "ordinary", posthoc: "none", posthocTarget: "groups" }],
  ["grouped3wayEmpty", grouped3wayEmpty, "three-way-anova", { posthoc: "none" }],
  ["grouped3wayBadBands", grouped3wayBadBands, "three-way-anova", { posthoc: "none" }],
  ["grouped3wayN1", grouped3wayN1, "three-way-anova", { posthoc: "none" }],
  ["grouped", grouped, "three-way-anova", { posthoc: "none" }],
  ["multiple", multiple, "correlation-matrix", { method: "pearson" }],
  ["multiple", multiple, "correlation-matrix", { method: "spearman" }],
  ["multiple", multiple, "multiple-regression", { dependent: "Weight" }],
  ["multiple", multiple, "multiple-regression", { dependent: "Weight", predictors: ["Height", "Age"] }],
  ["contingency2", contingency2, "chi-square"],
  ["contingency3", contingency3, "chi-square"],
  ["contingencyWide", contingencyWide, "chi-square"],
  ["xyNoX", xyNoX, "linear-regression", { forceOrigin: false }],
  ["xyNoX", xyNoX, "correlation", { method: "pearson", mode: "x-vs-every-y" }],
  // On the data sets chosen, in their order.
  ["column", column, "descriptive-statistics", { sets: ["Sparse", "Low"] }],
  [
    "column",
    column,
    "compare-two-groups",
    {
      paired: false,
      gaussian: true,
      equalVariance: false,
      ratio: false,
      tails: "two-sided",
      sets: ["High", "Control"],
    },
  ],
  [
    "column",
    column,
    "compare-two-groups",
    {
      paired: true,
      gaussian: true,
      equalVariance: false,
      ratio: false,
      tails: "two-sided",
      sets: ["Control", "Sparse"],
    },
  ],
  ["column", column, "anova", { posthoc: "tukey", sets: ["Control", "Low", "High"] }],
  [
    "grouped",
    grouped,
    "two-way-anova",
    { design: "ordinary", posthoc: "tukey", posthocTarget: "groups", sets: ["A", "C"] },
  ],
  [
    "grouped",
    grouped,
    "multiple-t-tests",
    { paired: false, gaussian: true, pooledSd: false, correction: "holm", sets: ["C", "A"] },
  ],
  ["multiple", multiple, "correlation-matrix", { method: "pearson", sets: ["Age", "Weight"] }],
];

const volcano: Partial<GraphOptions> = { volcanoX: "Log2 FC", volcanoY: "P", volcanoLabel: "Gene" };
const GRAPH_CASES: [string, TableData, GraphType, Partial<GraphOptions>?][] = [
  ["column", column, "individual"],
  ["column", column, "box-violin", { kind: "violin", showPoints: true }],
  ["column", column, "mean-error", { error: "sd" }],
  ["column", column, "pie"],
  ["column", column, "donut", { pieValue: "mean" }],
  ["xy", xy, "xy-scatter", { xyStyle: "points+line" }],
  ["xy", xy, "xy-bar"],
  ["xy", xy, "xy-area"],
  ["doseLog", doseLog, "dose-response"],
  ["logistic", logistic, "logistic-curve"],
  ["blandAltman", blandAltman, "bland-altman"],
  ["freqCol", freqCol, "histogram"],
  ["survival", survivalTable, "survival"],
  ["grouped", grouped, "grouped-scatter"],
  ["grouped", grouped, "grouped-bars", { groupLayout: "separated" }],
  ["grouped", grouped, "grouped-lines"],
  ["grouped", grouped, "grouped-stacked"],
  ["grouped", grouped, "grouped-hbars", { center: "median" }],
  ["multiple", multiple, "heatmap"],
  ["volcano", volcanoTable, "volcano", volcano],
  ["contingency2", contingency2, "grouped-stacked"],
  ["xyNoX", xyNoX, "xy-scatter"],
];

// ── Run and compare ──────────────────────────────────────────────────────

/** Rounds every number to 10 significant digits, so the reference ignores float noise. */
const rounded = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "number" ? Number(v.toPrecision(10)) : v)));

async function run() {
  await startR(fileURLToPath(new URL("../node_modules/webr/dist/", import.meta.url)));
  const out: Record<string, unknown> = {};
  for (const [name, data, type, params] of ANALYSES) {
    out[`${type} ${name} ${JSON.stringify(params ?? {})}`] = await runAnalysis(type, data, params);
  }
  for (const [name, data, type, options] of GRAPH_CASES) {
    const opts = {
      ...newGraphOptions(type),
      series: { Low: { color: "#D55E00" } },
      points: { "Control#1": { color: "#4ADE80" } },
      ...options,
    };
    const columns = plotColumns(readTable(data), type);
    const paint = paintOf(opts, GRAPHS[type].family === "volcano" ? 2 : columns.length);
    out[`graph ${type} ${name}`] = GRAPHS[type].build(columns, opts, paint, readTable(data).titles);
  }
  for (const [name, data] of Object.entries({ column, xy, grouped, twoGroups, multiple })) {
    out[`counts ${name}`] = { columns: countDataColumns(data), groups: countDataGroups(data) };
  }
  return rounded(out) as Record<string, unknown>;
}

/** Where TypeScript computes what R also computes, both must agree: a graph's
 *  regression line, the volcano's per-row P values, Tukey after a repeated-measures
 *  ANOVA, the regression band's t. */
async function disagreements(): Promise<string[]> {
  const { x, ys } = splitXY(readTable(xy).columns);
  const out: string[] = [];
  for (const y of ys) {
    for (const forceOrigin of [false, true]) {
      const r = await runAnalysis("linear-regression", xy, { y: y.name, forceOrigin });
      const pairs = pairUp(x!, y);
      const js = fitLinear(pairs.x, pairs.y, forceOrigin);
      const rSlope = "error" in r ? null : r.stats.find((s) => s.label === "Slope")?.value;
      if (rSlope == null || js == null || Math.abs(rSlope - js.slope) > 1e-9)
        out.push(
          `Regression of ${y.name}${forceOrigin ? " through the origin" : ""}: graph slope ${js?.slope}, R slope ${rSlope}`,
        );
    }
  }
  const tests = await runAnalysis("multiple-t-tests", twoGroups, {
    paired: false,
    gaussian: true,
    pooledSd: false,
    correction: "none",
  });
  const volcano = computeGroupedDEG(twoGroups, "A", "B", "difference");
  for (const row of volcano) {
    const p = "error" in tests ? null : tests.comparisons?.find((c) => c.group1 === row.label)?.p;
    if (p == null || Math.abs(p - row.p) > 1e-9)
      out.push(`Volcano P for ${row.label}: ${row.p}, multiple t tests: ${p}`);
  }
  // Tukey after a repeated-measures ANOVA equals R's TukeyHSD on the same model.
  const rm = await runAnalysis("rm-anova", column, { posthoc: "tukey" });
  const hsd = await evalNamedVector(
    "g0<-c(12.1,10.9);g1<-c(14.3,14.9);g2<-c(18.2,18.8);g3<-c(9,10.5);v<-c(g0,g1,g2,g3);gr<-factor(rep(1:4,each=2));" +
      'subj<-factor(rep(1:2,4));tk<-TukeyHSD(aov(v~gr+subj),"gr")$gr;c(a=tk["2-1",4],b=tk["3-1",4],c=tk["3-2",4])',
  );
  const rmP = "error" in rm ? [] : (rm.comparisons ?? []).map((c) => c.p);
  [hsd.a, hsd.b, hsd.c].forEach((p, i) => {
    const ours = rmP[[0, 1, 3][i]];
    if (p == null || ours == null || Math.abs(p - ours) > 1e-9) out.push(`RM ANOVA Tukey P: ${ours}, TukeyHSD: ${p}`);
  });
  const q = await evalNamedVector("c(a=qt(0.975,3),b=qt(0.975,10),c=qt(0.975,50))");
  for (const [key, df] of [
    ["a", 3],
    ["b", 10],
    ["c", 50],
  ] as const) {
    if (Math.abs(tCrit95(df) - q[key]!) > 1e-9) out.push(`t critical value, df ${df}: ${tCrit95(df)}, R: ${q[key]}`);
  }
  // Logistic spot check: this data set is symmetric about X = 4.5, so the
  // fitted P(Y=1) there is 0.5.
  const log = await runAnalysis("simple-logistic-regression", logistic, {});
  if ("error" in log) {
    out.push(`Logistic spot check: ${log.error}`);
  } else {
    const b0 = log.coefficients?.find((c) => c.term === "Intercept")?.estimate;
    const b1 = log.coefficients?.find((c) => c.term === "X")?.estimate;
    const p = b0 == null || b1 == null ? NaN : 1 / (1 + Math.exp(-(b0 + b1 * 4.5)));
    if (!Number.isFinite(p) || Math.abs(p - 0.5) > 1e-6) out.push(`Logistic P(Y=1) at X=4.5: ${p}, expected 0.5`);
    // The logistic-curve graph's sigmoid overlay, from the same cached result.
    const { addLogisticCurve } = await import("../src/views/graphs/logistic-curve");
    const fig = GRAPHS["logistic-curve"].build(
      plotColumns(readTable(logistic), "logistic-curve"),
      newGraphOptions("logistic-curve"),
      paintOf(newGraphOptions("logistic-curve"), 1),
      readTable(logistic).titles,
    );
    addLogisticCurve(
      fig,
      plotColumns(readTable(logistic), "logistic-curve"),
      log,
      paintOf(newGraphOptions("logistic-curve"), 1),
    );
    const traces = fig.data as { x?: number[]; y?: number[] }[];
    const curve = traces.find((t) => t.x?.length === 101);
    const mid = curve?.y?.[50];
    if (!curve || mid == null || Math.abs(mid - 0.5) > 1e-6) out.push(`Logistic curve at X=4.5: ${mid}, expected 0.5`);
  }
  // Standard-curve interpolation (plan 02): the fit equals the
  // nonlinear-regression fit on the same table (the shared-fit refactor's
  // proof, beyond the unchanged reference entries); the point estimates
  // match the planner's scipy values; the band-inversion CIs sit within
  // 0.02 of the planner's delta-method CIs (cross-check only — the locked
  // values are the band-inversion ones from WebR).
  const interp = await runAnalysis("standard-curve-interpolation", doseLog, {
    model: "sigmoidal-4pl-logx",
    unknowns: [20, 50, 80],
  });
  const nonlin = await runAnalysis("nonlinear-regression", doseLog, { model: "sigmoidal-4pl-logx" });
  if ("error" in interp) {
    out.push(`Standard-curve interpolation: ${interp.error}`);
  } else if ("error" in nonlin) {
    out.push(`Standard-curve interpolation: nonlinear-regression comparison failed: ${nonlin.error}`);
  } else {
    const close = (a: number | null | undefined, b: number | null | undefined, tol: number) =>
      a != null && b != null && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
    (interp.coefficients ?? []).forEach((c, i) => {
      const n = nonlin.coefficients?.[i];
      if (!n || !close(c.estimate, n.estimate, 1e-9) || !close(c.stdError, n.stdError, 1e-9))
        out.push(
          `Interpolation fit ${c.term}: ${c.estimate} ± ${c.stdError}, nonlinear-regression: ${n?.estimate} ± ${n?.stdError}`,
        );
    });
    (interp.stats ?? []).forEach((s) => {
      const n = nonlin.stats.find((t) => t.label === s.label);
      if (!n || !close(s.value, n.value, 1e-9))
        out.push(`Interpolation stat ${s.label}: ${s.value}, nonlinear-regression: ${n?.value}`);
    });
    const planX: [number, number][] = [
      [20, -1.4834],
      [50, -0.8467],
      [80, -0.2157],
    ];
    const planCI: [number, number, number][] = [
      [20, -1.5011, -1.4657],
      [50, -0.8577, -0.8358],
      [80, -0.2332, -0.1982],
    ];
    for (const [y0, x] of planX) {
      const row = interp.interpolations?.find((r) => r.unknownY === y0);
      if (!row || !close(row.x, x, 1e-3)) out.push(`Interpolation Y=${y0}: x=${row?.x}, plan says ${x}`);
    }
    for (const [y0, lo, hi] of planCI) {
      const row = interp.interpolations?.find((r) => r.unknownY === y0);
      if (
        !row ||
        row.ciLow == null ||
        row.ciHigh == null ||
        Math.abs(row.ciLow - lo) > 0.02 ||
        Math.abs(row.ciHigh - hi) > 0.02
      )
        out.push(`Interpolation Y=${y0}: CI=[${row?.ciLow}, ${row?.ciHigh}], delta-method cross-check [${lo}, ${hi}]`);
    }
    // The dose-response graph's drop-lines, from the same cached result.
    const { addDoseCurve } = await import("../src/views/graphs/dose-response-curve");
    const doseOpts = { ...newGraphOptions("dose-response"), doseModel: "sigmoidal-4pl-logx" as const };
    const doseColumns = plotColumns(readTable(doseLog), "dose-response");
    const doseFig = GRAPHS["dose-response"].build(
      doseColumns,
      doseOpts,
      paintOf(doseOpts, 1),
      readTable(doseLog).titles,
    );
    addDoseCurve(doseFig, doseColumns, doseOpts, nonlin, paintOf(doseOpts, 1), interp);
    const traces = doseFig.data as { mode?: string; x?: number[]; y?: number[]; line?: { dash?: string } }[];
    const dashed = traces.filter((t) => t.line?.dash === "dash");
    const dropMarkers = traces.filter(
      (t) => t.mode === "markers" && t.x?.length === 3 && JSON.stringify(t.y) === JSON.stringify([20, 50, 80]),
    );
    const xs = (interp.interpolations ?? []).map((r) => r.x);
    if (dashed.length !== 6) out.push(`Dose-response drop-lines: ${dashed.length} dashed traces, expected 6`);
    if (dropMarkers.length !== 1 || JSON.stringify(dropMarkers[0]?.x) !== JSON.stringify(xs))
      out.push(`Dose-response drop-line markers: ${JSON.stringify(dropMarkers[0]?.x)}, expected ${JSON.stringify(xs)}`);
    for (const y0 of [20, 50, 80]) {
      const row = interp.interpolations?.find((r) => r.unknownY === y0);
      const horiz = dashed.find((t) => t.y?.[0] === y0 && t.y?.[1] === y0);
      if (!horiz || horiz.x?.[1] !== row?.x)
        out.push(`Dose-response drop-line Y=${y0}: horizontal to ${horiz?.x?.[1]}, expected ${row?.x}`);
      const vert = dashed.find((t) => t.x?.[0] === row?.x && t.x?.[1] === row?.x);
      if (!vert || vert.y?.[1] !== y0)
        out.push(`Dose-response drop-line Y=${y0}: vertical to ${vert?.y?.[1]}, expected ${y0}`);
    }
  }
  // Out of range: Y = 150 is above the curve's Top — a null row, not an error.
  const oor = await runAnalysis("standard-curve-interpolation", doseLog, {
    model: "sigmoidal-4pl-logx",
    unknowns: [20, 150],
  });
  if ("error" in oor) {
    out.push(`Standard-curve interpolation out-of-range: ${oor.error}`);
  } else {
    const row150 = oor.interpolations?.find((r) => r.unknownY === 150);
    const row20 = oor.interpolations?.find((r) => r.unknownY === 20);
    if (!row150 || row150.x !== null) out.push(`Interpolation Y=150: x=${row150?.x}, expected null`);
    if (!row20 || row20.x == null) out.push(`Interpolation Y=150 run: Y=20 row missing: ${JSON.stringify(row20)}`);
    if (!oor.notes.includes("Y = 150 is above the fitted curve's maximum"))
      out.push(`Interpolation out-of-range note missing: ${oor.notes}`);
  }
  // Bland-Altman: the plot's three lines equal the analysis's bias and limits.
  const ba = await runAnalysis("bland-altman", blandAltman, { sets: ["Method A", "Method B"] });
  if ("error" in ba) {
    out.push(`Bland-Altman spot check: ${ba.error}`);
  } else {
    const stat = (label: string) => ba.stats.find((s) => s.label === label)?.value;
    const fig = GRAPHS["bland-altman"].build(
      plotColumns(readTable(blandAltman), "bland-altman"),
      newGraphOptions("bland-altman"),
      paintOf(newGraphOptions("bland-altman"), 2),
      readTable(blandAltman).titles,
    );
    const lines = (fig.data as { mode?: string; y?: number[] }[])
      .filter((t) => t.mode === "lines" && t.y?.length === 2 && t.y[0] === t.y[1])
      .map((t) => t.y![0])
      .sort((a, b) => a - b);
    const expected = [
      stat("Lower limit of agreement"),
      stat("Bias (mean difference)"),
      stat("Upper limit of agreement"),
    ];
    if (lines.length !== 3 || expected.some((v, i) => v == null || Math.abs(v - lines[i]) > 1e-9))
      out.push(`Bland-Altman lines: ${lines}, expected ${expected}`);
    // The plan's hand-verified values (Python/scipy, sample SD, t crit 2.262, df 9).
    const plan: [string, number][] = [
      ["Bias (mean difference)", -0.36],
      ["SD of differences", 0.2503],
      ["Lower limit of agreement", -0.8507],
      ["Upper limit of agreement", 0.1307],
      ["Bias 95% CI lower", -0.5391],
      ["Bias 95% CI upper", -0.1809],
      ["Lower limit 95% CI lower", -1.1608],
      ["Lower limit 95% CI upper", -0.5405],
      ["Upper limit 95% CI lower", -0.1795],
      ["Upper limit 95% CI upper", 0.4408],
    ];
    for (const [label, value] of plan) {
      const got = stat(label);
      if (got == null || Math.abs(got - value) > 1e-3) out.push(`Bland-Altman ${label}: ${got}, plan says ${value}`);
    }
    if (stat("N (pairs)") !== 10) out.push(`Bland-Altman N: ${stat("N (pairs)")}, expected 10`);
  }
  // Kolmogorov-Smirnov: the plan's values, computed independently in Python
  // with scipy.stats.ks_2samp(..., method='exact') (scipy 1.11.4) and verified
  // by a manual ECDF-difference calculation in the same script — both agreed
  // exactly. Tolerance: D exact to 1e-12; p to 1e-4 relative. The ties
  // fixture's D (0.125) is the same manual calculation; its p is asymptotic
  // (R falls back when ties exist), so only its presence is asserted here and
  // the WebR value is pinned in reference.json.
  const ksRun = async (data: TableData, label: string) => {
    const r = await runAnalysis("kolmogorov-smirnov", data);
    if ("error" in r) {
      out.push(`Kolmogorov-Smirnov ${label}: ${r.error}`);
      return null;
    }
    return { stat: (l: string) => r.stats.find((s) => s.label === l)?.value, notes: r.notes };
  };
  const ksShiftedR = await ksRun(ksShifted, "shifted");
  if (ksShiftedR) {
    const d = ksShiftedR.stat("KS distance D");
    const p = ksShiftedR.stat("P value");
    if (d == null || Math.abs(d - 1) > 1e-12) out.push(`KS shifted D: ${d}, plan says 1`);
    if (p == null || Math.abs(p - 0.0001554) / 0.0001554 > 1e-4)
      out.push(`KS shifted p: ${p}, plan says 0.0001554`);
    if (ksShiftedR.stat("N (group 1)") !== 8 || ksShiftedR.stat("N (group 2)") !== 8)
      out.push(
        `KS shifted N: ${ksShiftedR.stat("N (group 1)")}/${ksShiftedR.stat("N (group 2)")}, expected 8/8`,
      );
  }
  const ksSimilarR = await ksRun(ksSimilar, "similar");
  if (ksSimilarR) {
    const d = ksSimilarR.stat("KS distance D");
    const p = ksSimilarR.stat("P value");
    if (d == null || Math.abs(d - 0.25) > 1e-12) out.push(`KS similar D: ${d}, plan says 0.25`);
    if (p == null || Math.abs(p - 0.9801) / 0.9801 > 1e-4)
      out.push(`KS similar p: ${p}, plan says 0.9801`);
  }
  const ksTiesR = await ksRun(ksTies, "ties");
  if (ksTiesR) {
    const d = ksTiesR.stat("KS distance D");
    const p = ksTiesR.stat("P value");
    if (d == null || Math.abs(d - 0.125) > 1e-12) out.push(`KS ties D: ${d}, expected 0.125`);
    if (p == null) out.push(`KS ties p: missing`);
    if (!ksTiesR.notes.includes("Tied values present — P value is asymptotic, not exact."))
      out.push(`KS ties notes missing the asymptotic warning: ${ksTiesR.notes}`);
  }
  const ksIdenticalR = await ksRun(ksIdentical, "identical");
  if (ksIdenticalR) {
    if (ksIdenticalR.stat("KS distance D") !== 0)
      out.push(`KS identical D: ${ksIdenticalR.stat("KS distance D")}, expected 0`);
    if (ksIdenticalR.stat("P value") !== 1)
      out.push(`KS identical p: ${ksIdenticalR.stat("P value")}, expected 1`);
  }
  // Frequency distribution: the TypeScript binning equals R's hist() with the
  // matching (left-closed) edge rule, the auto breaks are R's pretty() breaks,
  // and the histogram's bars equal the analysis's counts. The plan's counts are
  // exact arithmetic on the stated data; R's hist(right=FALSE) confirms them.
  const freqCounts = async (params: AnalysisParams) => {
    const r = await runAnalysis("frequency-distribution", freqCol, params);
    return "error" in r ? null : (r.frequencyBins?.[0].bins.map((b) => b.count) ?? null);
  };
  const freqX = "c(2.1,3.5,3.9,4.2,5,5.8,6.1,7.4,8,9.3)";
  const hist = await evalNamedVector(
    `x<-${freqX};h<-hist(x,plot=FALSE);ha<-hist(x,breaks=c(2,4,6,8,10),plot=FALSE,right=FALSE);` +
      `hb<-hist(x,breaks=c(2,3.6,5.2,6.8,8.4,10),plot=FALSE,right=FALSE);` +
      `hd<-hist(c(2,4,6,8),breaks=c(2,4,6,8),plot=FALSE,right=FALSE);` +
      `c(sturges=nclass.Sturges(x),` +
      `b1=h$breaks[1],b2=h$breaks[2],b3=h$breaks[3],b4=h$breaks[4],b5=h$breaks[5],` +
      `a1=ha$counts[1],a2=ha$counts[2],a3=ha$counts[3],a4=ha$counts[4],` +
      `c1=hb$counts[1],c2=hb$counts[2],c3=hb$counts[3],c4=hb$counts[4],c5=hb$counts[5],` +
      `d1=hd$counts[1],d2=hd$counts[2],d3=hd$counts[3])`,
  );
  const eq = (a: (number | null)[] | null, b: (number | null)[]) =>
    a !== null && a.length === b.length && a.every((v, i) => v === b[i]);
  if (hist.sturges !== 5) out.push(`Sturges count: ${hist.sturges}, expected 5`);
  if (!eq([hist.b1, hist.b2, hist.b3, hist.b4, hist.b5], [2, 4, 6, 8, 10]))
    out.push(`R hist() breaks: ${[hist.b1, hist.b2, hist.b3, hist.b4, hist.b5]}, expected 2,4,6,8,10`);
  const planCounts: [AnalysisParams, (number | null)[], string][] = [
    [{ binMode: "width", binWidth: 2, startAt: 2 }, [hist.a1, hist.a2, hist.a3, hist.a4], "case A (width 2)"],
    [{ binMode: "count", binCount: 5, startAt: 2 }, [hist.c1, hist.c2, hist.c3, hist.c4, hist.c5], "case B (count 5)"],
  ];
  for (const [params, expected, label] of planCounts) {
    const got = await freqCounts(params);
    if (!eq(got, expected)) out.push(`Frequency distribution ${label}: ${got}, R hist() (right=FALSE): ${expected}`);
  }
  const edge = await runAnalysis("frequency-distribution", freqEdge, { binMode: "width", binWidth: 2, startAt: 2 });
  const edgeCounts = "error" in edge ? null : (edge.frequencyBins?.[0].bins.map((b) => b.count) ?? null);
  if (!eq(edgeCounts, [hist.d1, hist.d2, hist.d3]))
    out.push(
      `Frequency distribution case D (on-edge): ${edgeCounts}, R hist() (right=FALSE): ${[hist.d1, hist.d2, hist.d3]}`,
    );
  // The auto breaks are R's pretty() breaks: step, count and ends pin the
  // (equally spaced) sequence. Includes the float-boundary cases where a naive
  // floor/ceil of lo/step lands a step off (0.3/0.1, 0.07/0.005, …).
  const prettyCases: [number, number, number][] = [
    [2.1, 9.3, 5], [0, 10, 5], [0, 1, 5], [1, 2, 5], [0, 100, 5], [3, 97, 5], [0.2, 0.9, 5],
    [-5, 5, 5], [10, 20, 5], [100, 200, 5], [0, 7, 5], [0, 3, 5], [2, 4, 5], [0, 0.5, 5],
    [5, 6, 5], [0, 1000, 5], [123, 456, 5], [0.001, 0.009, 5], [2.1, 9.3, 4], [2.1, 9.3, 6],
    [0, 10, 3], [0, 10, 10], [7, 8, 5], [-100, -10, 5], [0.15, 0.85, 5], [42, 42.5, 5],
    [0, 7.005, 5], [0, 14.02, 5], [0, 35.1, 5], [0.3, 0.9, 5], [0.6, 0.9, 5], [1.1, 1.9, 5],
    [2.3, 2.9, 5], [0.3, 0.7, 5], [-0.3, 0.3, 5], [0.07, 0.11, 5], [999, 1001, 5],
  ];
  const prettyVals = await evalNamedVector(
    `${prettyCases.map(([lo, hi, n], i) => `pr${i}<-pretty(c(${lo},${hi}),n=${n},min.n=1)`).join(";")};` +
      `c(${prettyCases.map((_, i) => `s${i}=pr${i}[2]-pr${i}[1],k${i}=length(pr${i}),l${i}=pr${i}[1],h${i}=pr${i}[length(pr${i})]`).join(",")})`,
  );
  prettyCases.forEach(([lo, hi, n], i) => {
    const got = prettyBreaks(lo, hi, n);
    const close = (a: number | null, b: number) => a != null && Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b));
    if (
      !close(prettyVals[`s${i}`], got[1] - got[0]) ||
      prettyVals[`k${i}`] !== got.length ||
      !close(prettyVals[`l${i}`], got[0]) ||
      !close(prettyVals[`h${i}`], got.at(-1)!)
    )
      out.push(
        `pretty(${lo},${hi},n=${n}): TS=[${got.join(", ")}], R step=${prettyVals[`s${i}`]} k=${prettyVals[`k${i}`]} ${prettyVals[`l${i}`]}..${prettyVals[`h${i}`]}`,
      );
  });
  // The histogram's bars equal the auto analysis's counts.
  const auto = await runAnalysis("frequency-distribution", freqCol, { binMode: "auto" });
  const fig = GRAPHS.histogram.build(
    plotColumns(readTable(freqCol), "histogram"),
    newGraphOptions("histogram"),
    paintOf(newGraphOptions("histogram"), 1),
    readTable(freqCol).titles,
  );
  const bars = (fig.data as { y?: number[] }[])[0]?.y ?? null;
  const autoCounts = "error" in auto ? null : auto.frequencyBins?.[0].bins.map((b) => b.count);
  if (!eq(bars, autoCounts ?? [])) out.push(`Histogram bars: ${bars}, analysis counts: ${autoCounts}`);
  if (JSON.stringify(bars) !== JSON.stringify([3, 3, 2, 2]))
    out.push(`Histogram bars for freqCol: ${bars}, plan says [3, 3, 2, 2]`);
  // Three-way ANOVA (plan 03): the plan's values, computed independently in
  // Python (numpy/scipy, effect-coded least squares) and re-verified in WebR
  // base R (aov + drop1, match() on row names) before locking. Tolerances from
  // the plan: SS/F relative 1e-3; p relative 1e-2 for p < 0.01, absolute 1e-3
  // for p >= 0.01. The Tukey A:B comparisons are cross-checked against an
  // independent R computation (tapply cell means + pooled MSE + ptukey),
  // matched by comparison label, not by row order.
  const three = await runAnalysis("three-way-anova", grouped3way, { posthoc: "none" });
  if ("error" in three) {
    out.push(`Three-way ANOVA: ${three.error}`);
  } else {
    const stat = (label: string) => three.stats.find((s) => s.label === label)?.value;
    const planF: [string, number, number][] = [
      ["A", 126.6761, 5.18e-9],
      ["B", 211.2669, 1.22e-10],
      ["C", 34.4906, 2.36e-5],
      ["A:B", 29.8974, 5.16e-5],
      ["A:C", 2.7785, 0.115],
      ["B:C", 95.8185, 3.69e-8],
      ["A:B:C", 8.811, 0.00906],
    ];
    for (const [term, f, p] of planF) {
      const gotF = stat(`${term} F`);
      const gotP = stat(`${term} P value`);
      if (gotF == null || Math.abs(gotF - f) / f > 1e-3) out.push(`Three-way ANOVA ${term} F: ${gotF}, plan says ${f}`);
      if (gotP == null || (p < 0.01 ? Math.abs(gotP - p) / p > 1e-2 : Math.abs(gotP - p) > 1e-3))
        out.push(`Three-way ANOVA ${term} p: ${gotP}, plan says ${p}`);
      if (stat(`${term} DFn`) !== 1) out.push(`Three-way ANOVA ${term} DFn: ${stat(`${term} DFn`)}, expected 1`);
    }
    if (stat("DFd (residual)") !== 16)
      out.push(`Three-way ANOVA DFd: ${stat("DFd (residual)")}, expected 16`);
    if (three.subtitle !== "Ordinary three-way ANOVA") out.push(`Three-way ANOVA subtitle: ${three.subtitle}`);
    if (!three.notes.includes("A = Group (Placebo, Drug); B = Row (Day 1, Day 2); C = Row group (WT, KO)."))
      out.push(`Three-way ANOVA notes missing the factor mapping: ${three.notes}`);
  }
  const threeTukey = await runAnalysis("three-way-anova", grouped3way, { posthoc: "tukey", posthocTerm: "A:B" });
  if ("error" in threeTukey) {
    out.push(`Three-way ANOVA Tukey: ${threeTukey.error}`);
  } else {
    const comps = threeTukey.comparisons ?? [];
    if (comps.length !== 6) out.push(`Three-way ANOVA Tukey A:B comparisons: ${comps.length}, expected 6`);
    if (threeTukey.comparisonsLabel !== "Tukey's multiple comparisons test (A:B cell means)")
      out.push(`Three-way ANOVA Tukey label: ${threeTukey.comparisonsLabel}`);
    const raw = grouped3way.rows.flatMap((row) => row.slice(1).map((c) => (c == null ? "NA" : c)));
    // R orders tapply cells by factor level (Drug before Placebo) and flattens
    // the A×B matrix column-major: m[1]=Drug/Day 1, m[2]=Placebo/Day 1,
    // m[3]=Drug/Day 2, m[4]=Placebo/Day 2. The JS runner orders them first-seen
    // (Placebo first) — match by label, and compare the (label1, label2) pair's
    // P, whichever order R lists it in.
    const rCells = ["Day 1", "Day 2"].flatMap((b) => ["Drug", "Placebo"].map((a) => `${a} (${b})`));
    const pairs: [number, number][] = [
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
      [1, 3],
      [2, 3],
    ];
    const expected = await evalNamedVector(
      `v<-c(${raw.join(",")});` +
        `A<-factor(rep(c("Placebo","Drug"),each=3,times=4));` +
        `B<-factor(rep(c("Day 1","Day 2","Day 1","Day 2"),each=6));` +
        `C<-factor(rep(c("WT","KO"),each=12));` +
        `f<-aov(v~A*B*C);mse<-deviance(f)/df.residual(f);` +
        `m<-tapply(v,list(A,B),mean);n<-tapply(v,list(A,B),length);` +
        `c(${pairs.map(([i, j], k) => `p${k}=1-ptukey(sqrt(2)*abs((m[${i + 1}]-m[${j + 1}])/sqrt(mse*(1/n[${i + 1}]+1/n[${j + 1}]))),4,df.residual(f))`).join(",")})`,
    );
    pairs.forEach(([i, j], k) => {
      const got =
        comps.find((c) => c.group1 === rCells[i] && c.group2 === rCells[j]) ??
        comps.find((c) => c.group1 === rCells[j] && c.group2 === rCells[i]);
      const want = expected[`p${k}`];
      if (!got || got.p == null || want == null || Math.abs(got.p - want) > 1e-9)
        out.push(`Three-way ANOVA Tukey ${rCells[i]} vs ${rCells[j]}: ${got?.p}, R says ${want}`);
    });
  }
  // The edge cases are errors, not NA rows.
  for (const [data, label, want] of [
    [grouped3wayEmpty, "empty cell", "Drug × Day 2 × KO has no values"],
    [grouped3wayBadBands, "bands don't tile", "Row groups must cover every row exactly once."],
    [grouped3wayN1, "no residual df", "no residual degrees of freedom"],
    [grouped, "no row groups", "2 row groups"],
  ] as const) {
    const r = await runAnalysis("three-way-anova", data, { posthoc: "none" });
    if (!("error" in r) || !r.error.includes(want))
      out.push(`Three-way ANOVA ${label}: ${"error" in r ? r.error : "ran without error"}, expected an error naming ${want}`);
  }
  return out;
}

/** Every analysis and graph of the sample project must work. */
async function sampleFailures(): Promise<string[]> {
  const out: string[] = [];
  const { nodes } = sampleProject;
  for (const node of Object.values(nodes)) {
    const data = node.parentId ? nodes[node.parentId].data! : undefined;
    if (node.type === "analysis") {
      const outcome = await runAnalysis(node.analysisType!, data!, node.analysisParams);
      if ("error" in outcome) out.push(`Sample analysis “${node.name}”: ${outcome.error}`);
    } else if (node.type === "graph") {
      const type = node.graphType!;
      const paint = paintOf(node.graphOptions!, graphSeries(type, data!, nodes[node.parentId!].tableType!).length);
      const fig = GRAPHS[type].build(
        plotColumns(readTable(data!), type),
        node.graphOptions!,
        paint,
        readTable(data!).titles,
      );
      if (!fig.data.length) out.push(`Sample graph “${node.name}” draws nothing.`);
    }
  }
  return out;
}

const file = new URL("reference.json", import.meta.url);
const actual = await run();
const disagree = await disagreements();
const broken = await sampleFailures();
for (const d of disagree) console.log(`✗ Engines disagree. ${d}`);
for (const b of broken) console.log(`✗ Sample project. ${b}`);
if (process.argv.includes("--update")) {
  writeFileSync(file, JSON.stringify(actual, null, 1) + "\n");
  console.log(`Reference updated: ${Object.keys(actual).length} results.`);
} else {
  const expected = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const changed = [...keys].filter((k) => JSON.stringify(expected[k]) !== JSON.stringify(actual[k]));
  for (const k of changed)
    console.log(`✗ ${k}\n  was: ${JSON.stringify(expected[k])}\n  now: ${JSON.stringify(actual[k])}`);
  console.log(
    changed.length ? `${changed.length} of ${keys.size} results changed.` : `All ${keys.size} results match.`,
  );
  process.exitCode = changed.length || disagree.length || broken.length ? 1 : 0;
}
process.exit();
