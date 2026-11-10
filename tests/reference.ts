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
import { kaplanMeier } from "../src/lib/kaplan-meier";
import { rVec } from "../src/stats/column/base";
import { R_MAXIMUM_T } from "../src/stats/column/anova";
import { evaluate as doseCurveAt } from "../src/views/graphs/fitted-curve";
import { NONLINEAR_MODELS, type NonlinearModel } from "../src/stats/types";
import { positiveXOnly } from "../src/stats/xy/nonlinear-regression";
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

/** A tumor growing exponentially, a drug cleared from plasma, an enzyme's rate. */
const growth = table(
  ["Title", "Day", "Volume"],
  [
    ["", "0", "105"],
    ["", "3", "142"],
    ["", "7", "198"],
    ["", "10", "251"],
    ["", "14", "378"],
    ["", "17", "455"],
    ["", "21", "702"],
  ],
);
const decay = table(
  ["Title", "Hours", "Plasma"],
  [
    ["", "0", "98.2"],
    ["", "0.5", "71.5"],
    ["", "1", "55.1"],
    ["", "2", "33.8"],
    ["", "4", "17.9"],
    ["", "6", "12.6"],
    ["", "8", "10.8"],
    ["", "12", "10.1"],
  ],
);
const enzyme = table(
  ["Title", "Substrate", "Rate"],
  [
    ["", "0.5", "9.8"],
    ["", "1", "17.1"],
    ["", "2", "27.9"],
    ["", "5", "44.2"],
    ["", "10", "55.9"],
    ["", "20", "63.1"],
    ["", "50", "70.4"],
  ],
);

/** The same standards, then unknowns to read off them (a Y, no X): within the standards,
 *  below them, and beyond the curve's top. */
const doseUnknowns = table(doseLog.columns, [
  ...doseLog.rows.map((r) => r.map((c) => c ?? "")),
  ["Sample 1", "", "50"],
  ["Sample 2", "", "10"],
  ["", "", "1.5"],
  ["Sample 4", "", "150"],
]);

/** Two dose-response curves on one X, the second shifted right (a higher EC50). */
const doseTwo = table(
  ["Title", "X", "Control", "Treated"],
  [
    ["", "-3", "2.1", "1.2"],
    ["", "-2.5", "3.4", "2.0"],
    ["", "-2", "8.2", "3.9"],
    ["", "-1.5", "19.5", "9.1"],
    ["", "-1", "41.2", "21.7"],
    ["", "-0.5", "68.9", "43.5"],
    ["", "0", "86.1", "70.2"],
    ["", "0.5", "94.2", "87.4"],
    ["", "1", "97.8", "95.1"],
    ["", "1.5", "99.1", "98.0"],
  ],
);
/** Two inhibitor curves far apart: no 4PL fit shares one midpoint. */
const doseFar = table(
  ["Title", "X", "A", "B"],
  [
    ["", "-9", "98.2", "100.7"],
    ["", "-8.5", "97.2", "97.7"],
    ["", "-8", "95.7", "93.5"],
    ["", "-7.5", "84.7", "96.9"],
    ["", "-7", "64.9", "97.2"],
    ["", "-6.5", "29.8", "92.9"],
    ["", "-6", "12.1", "77.4"],
    ["", "-5.5", "9.7", "54.5"],
    ["", "-5", "4.9", "32.3"],
    ["", "-4.5", "3.6", "22.5"],
    ["", "-4", "6.8", "17.3"],
  ],
);
/** The same doses falling: an inhibitor's curve. */
const doseFall = table(
  ["Title", "X", "Response"],
  doseLog.rows.map(([, x, y]) => ["", x ?? "", String(100 - Number(y))]),
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

/** Exponential curves (plan 08): noiseless by construction on the shared X
 *  grid 0–12, so each fit must recover its generating parameters.
 *  A: one-phase decay Y0=100, Plateau=10, K=0.5. B: two-phase decay
 *  Plateau=10, Span1=60, K1=1, Span2=30, K2=0.1. C: one-phase association
 *  Y0=0, Plateau=100, K=0.3. D: the plan's saturating "growth" fixture —
 *  covered as association (Y0=10, Plateau=200, K=0.2), since the growth
 *  model is Prism's explicit Y0·exp(K·X) (see nonlinear-fit.ts). D2: pure
 *  exponential growth Y0=10, K=0.2. E: plateau-then-decay X0=2, Y0=100,
 *  Plateau=10, K=0.5. */
const expX = table(
  ["Title", "X", "A", "B", "C", "D", "D2", "E"],
  [
    ["", "0", "100", "100", "0", "10", "10", "100"],
    ["", "0.5", "80.0920704764", "74.9287223178", "13.9292023575", "28.0808905732", "11.0517091808", "100"],
    ["", "1", "64.5877593741", "59.2178890114", "25.9181779318", "44.4411569152", "12.2140275816", "100"],
    ["", "2", "43.1091497054", "42.6820395865", "45.1188363906", "72.6391912532", "14.9182469764", "100"],
    ["", "3", "30.0817144134", "35.2117707225", "59.3430340259", "95.7257891421", "18.2211880039", "64.5877593741"],
    ["", "4", "22.1801754913", "31.2085397144", "69.8805788088", "114.6274968177", "22.2554092849", "43.1091497054"],
    ["", "6", "14.4808361531", "26.6130742134", "83.4701111778", "142.7730997367", "33.2011692274", "22.1801754913"],
    ["", "8", "11.6484075", "23.4999966812", "90.9282046711", "161.639661581", "49.530324244", "14.4808361531"],
    ["", "10", "10.6064152299", "21.0391072309", "95.0212931632", "174.286296185", "73.8905609893", "11.6484075"],
    ["", "12", "10.2230876959", "19.0361950101", "97.2676277553", "182.763588875", "110.2317638064", "10.6064152299"],
  ],
);

/** Plateau-then-decay with no points above the breakpoint (median X = 2):
 *  X0 is unidentifiable, so the runner must error before calling R. */
const plateauOneSided = table(
  ["Title", "X", "Y"],
  [
    ["", "0", "100"],
    ["", "1", "99"],
    ["", "2", "98"],
    ["", "2", "97"],
    ["", "2", "96"],
    ["", "2", "95"],
  ],
);

/** Two-phase decay needs ≥ 6 points (5 parameters + 1) — this has 5. */
const expTooFew = table(
  ["Title", "X", "Y"],
  [
    ["", "0", "100"],
    ["", "0.5", "74.9287223178"],
    ["", "1", "59.2178890114"],
    ["", "2", "42.6820395865"],
    ["", "3", "35.2117707225"],
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

/** One subject per row: its time, then 1 (event) or 0 (censored) in its group's column. */
const subjects = (groups: [number, number][][]) =>
  groups.flatMap((g, k) =>
    g.map(([time, code]) => ["", String(time), ...groups.map((_, j) => (j === k ? String(code) : ""))]),
  );

// Freireich's leukemia trial (Gehan 1965): 6-MP vs. placebo, the textbook survival data.
const freireich = table(
  ["Title", "Weeks", "6-MP", "Placebo"],
  subjects([
    [
      [6, 1],
      [6, 1],
      [6, 1],
      [6, 0],
      [7, 1],
      [9, 0],
      [10, 1],
      [10, 0],
      [11, 0],
      [13, 1],
      [16, 1],
      [17, 0],
      [19, 0],
      [20, 0],
      [22, 1],
      [23, 1],
      [25, 0],
      [32, 0],
      [32, 0],
      [34, 0],
      [35, 0],
    ],
    [1, 1, 2, 2, 3, 4, 4, 5, 5, 8, 8, 8, 8, 11, 11, 12, 12, 15, 17, 22, 23].map((t): [number, number] => [t, 1]),
  ]),
);

const survival3 = table(
  ["Title", "Days", "A", "B", "C"],
  subjects([
    [
      [5, 1],
      [8, 1],
      [12, 1],
      [15, 0],
      [20, 1],
      [22, 1],
      [30, 0],
      [31, 1],
    ],
    [
      [3, 1],
      [4, 1],
      [6, 1],
      [7, 1],
      [9, 0],
      [10, 1],
      [14, 1],
      [18, 1],
    ],
    [
      [12, 1],
      [18, 0],
      [24, 1],
      [30, 0],
      [36, 1],
      [40, 0],
      [45, 0],
      [50, 1],
    ],
  ]),
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

/** ROC curve (plan 05): 10 diseased (Truth 1) + 10 healthy (Truth 0), rows
 *  interleaved. AUC 0.97, DeLong SE 0.0302, CI [0.9108, 1.0000] (raw upper
 *  1.0292, truncated); Youden optimum 0.71 (sens 0.80, spec 1.00, J 0.80),
 *  tied with 0.65 and 0.58 — the tie rule picks 0.71, the highest threshold. */
const rocTable = table(
  ["Title", "Truth", "Score"],
  [
    ["", "1", "0.82"],
    ["", "0", "0.42"],
    ["", "1", "0.76"],
    ["", "0", "0.55"],
    ["", "1", "0.91"],
    ["", "0", "0.31"],
    ["", "1", "0.65"],
    ["", "0", "0.61"],
    ["", "1", "0.88"],
    ["", "0", "0.48"],
    ["", "1", "0.71"],
    ["", "0", "0.39"],
    ["", "1", "0.95"],
    ["", "0", "0.66"],
    ["", "1", "0.58"],
    ["", "0", "0.28"],
    ["", "1", "0.79"],
    ["", "0", "0.52"],
    ["", "1", "0.84"],
    ["", "0", "0.45"],
  ],
);

/** The same scores with a text truth column ("Diseased"/"Healthy"). */
const rocTableText = table(
  ["Title", "Truth", "Score"],
  [
    ["", "Diseased", "0.82"],
    ["", "Healthy", "0.42"],
    ["", "Diseased", "0.76"],
    ["", "Healthy", "0.55"],
    ["", "Diseased", "0.91"],
    ["", "Healthy", "0.31"],
    ["", "Diseased", "0.65"],
    ["", "Healthy", "0.61"],
    ["", "Diseased", "0.88"],
    ["", "Healthy", "0.48"],
    ["", "Diseased", "0.71"],
    ["", "Healthy", "0.39"],
    ["", "Diseased", "0.95"],
    ["", "Healthy", "0.66"],
    ["", "Diseased", "0.58"],
    ["", "Healthy", "0.28"],
    ["", "Diseased", "0.79"],
    ["", "Healthy", "0.52"],
    ["", "Diseased", "0.84"],
    ["", "Healthy", "0.45"],
  ],
);

/** A single-class truth: AUC is undefined — an error, not 0.5. */
const rocTableSingle = table(
  ["Title", "Truth", "Score"],
  [
    ["", "1", "0.82"],
    ["", "1", "0.42"],
    ["", "1", "0.76"],
    ["", "1", "0.55"],
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

// Six subjects measured three times, their scatter growing: sphericity doesn't hold.
const matched = table(
  ["Title", "Day 0", "Day 7", "Day 14"],
  [
    ["", "10.1", "12.0", "15.2"],
    ["", "9.8", "12.9", "18.1"],
    ["", "11.2", "13.1", "14.0"],
    ["", "10.5", "14.2", "21.3"],
    ["", "9.9", "11.8", "13.1"],
    ["", "10.8", "13.6", "19.4"],
  ],
);

// Edge cases: a stored empty row, one value per cell, a falling dose-response curve, too
// little data, a column of identical values, counts that aren't whole, a group without event.
const groupedBlankRow: TableData = { ...grouped, rows: [...grouped.rows, grouped.columns.map(() => null)] };
const noReplicates = table(
  ["Title", "A:Y1", "B:Y1"],
  [
    ["a", "1", "2"],
    ["b", "2", "5"],
    ["c", "4", "4"],
  ],
  { groups: 2, replicates: 1 },
);
const inhibition = table(
  ["Title", "X", "Y"],
  [-9, -8.5, -8, -7.5, -7, -6.5, -6, -5.5, -5].map((x, i) => [
    "",
    String(x),
    String([98, 97, 90, 72, 48, 25, 10, 4, 2][i]),
  ]),
);
const sparse = table(
  ["Title", "A", "B", "C"],
  [
    ["", "1", "", "5"],
    ["", "2", "", "5"],
    ["", "0", "", "5"],
    ["", "4", "3", "5"],
  ],
);
const decimalCounts = table(
  ["Title", "Outcome A", "Outcome B"],
  [
    ["Drug", "3.6", "10.4"],
    ["Placebo", "8.5", "2.5"],
  ],
);
const noEvent = table(
  ["Title", "Time", "A", "B"],
  [
    ["", "1", "1", ""],
    ["", "2", "1", ""],
    ["", "3", "0", ""],
    ["", "4", "", "0"],
    ["", "5", "", "0"],
    ["", "6", "", "0"],
  ],
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

// The same genes on an XY table: X is the fold change, the row titles name the genes.
const volcanoXY = table(
  ["Title", "Log2 FC", "P"],
  volcanoTable.rows.map(([, gene, fc, p]) => [gene, fc, p].map((cell) => cell ?? "")),
);
// The same again, its P values entered as -log10 already.
const volcanoLog = table(
  ["Title", "Log2 FC", "-log10 P"],
  volcanoXY.rows.map(([gene, fc, p]) => [
    gene ?? "",
    fc ?? "",
    p && Number(p) > 0 ? String(-Math.log10(Number(p))) : "",
  ]),
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
  ["column", column, "anova", { posthoc: "dunnett", control: "Control" }],
  ["column", column, "anova", { posthoc: "none", equalSd: false }],
  ["column", column, "anova", { posthoc: "games-howell", equalSd: false }],
  ["column", column, "anova", { posthoc: "t3", equalSd: false }],
  ["column", column, "kruskal-wallis", { posthoc: "dunn" }],
  ["column", column, "rm-anova"],
  ["column", column, "rm-anova", { posthoc: "tukey" }],
  ["column", column, "rm-anova", { posthoc: "bonferroni" }],
  ["column", column, "friedman", { posthoc: "dunn" }],
  ["matched", matched, "rm-anova", { posthoc: "none" }],
  ["matched", matched, "rm-anova", { posthoc: "tukey", sphericity: false }],
  ["matched", matched, "rm-anova", { posthoc: "bonferroni", sphericity: false }],
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
  ["doseLog", doseLog, "nonlinear-regression", { model: "agonist-3pl-logx" }],
  ["doseFall", doseFall, "nonlinear-regression", { model: "inhibitor-3pl-logx" }],
  ["doseLog", doseLog, "nonlinear-regression", { model: "asymmetric-5pl-logx" }],
  ["doseUnknowns", doseUnknowns, "nonlinear-regression", { model: "sigmoidal-4pl-logx", interpolate: true }],
  [
    "doseFar",
    doseFar,
    "nonlinear-regression",
    { y: "A", model: "sigmoidal-4pl-logx", compareWith: "B", compare: "ec50" },
  ],
  ["growth", growth, "nonlinear-regression", { model: "exponential-growth" }],
  ["decay", decay, "nonlinear-regression", { model: "one-phase-decay" }],
  ["enzyme", enzyme, "nonlinear-regression", { model: "michaelis-menten" }],
  ["xy", xy, "nonlinear-regression", { y: "Y1", model: "line", interpolate: true }],
  ["doseRaw", doseRaw, "nonlinear-regression", { model: "asymmetric-5pl-x" }],
  // prettier-ignore
  ["doseTwo", doseTwo, "nonlinear-regression", { y: "Control", model: "sigmoidal-4pl-logx", compareWith: "Treated", compare: "ec50" }],
  // prettier-ignore
  ["doseTwo", doseTwo, "nonlinear-regression", { y: "Control", model: "sigmoidal-4pl-logx", compareWith: "Treated", compare: "all" }],
  // Exponential curves (plan 08, 1/2: decay) — noiseless fixtures A/B/E, the
  // Exponential curves (plan 08) — noiseless fixtures A–E + D2, the
  // one-sided-breakpoint error, and the too-few-points error for two-phase.
  // D is the plan's saturating "growth" fixture, fitted as association
  // (see nonlinear-fit.ts — the growth model is Prism's explicit form).
  ["expX", expX, "nonlinear-regression", { y: "A", model: "one-phase-decay" }],
  ["expX", expX, "nonlinear-regression", { y: "B", model: "two-phase-decay" }],
  ["expX", expX, "nonlinear-regression", { y: "C", model: "one-phase-association" }],
  ["expX", expX, "nonlinear-regression", { y: "D", model: "one-phase-association" }],
  ["expX", expX, "nonlinear-regression", { y: "D2", model: "exponential-growth" }],
  ["expX", expX, "nonlinear-regression", { y: "E", model: "plateau-decay" }],
  ["plateauOneSided", plateauOneSided, "nonlinear-regression", { model: "plateau-decay" }],
  ["expTooFew", expTooFew, "nonlinear-regression", { model: "two-phase-decay" }],
  ["logistic", logistic, "simple-logistic-regression", {}],
  ["logisticSeparated", logisticSeparated, "simple-logistic-regression", {}],
  ["blandAltman", blandAltman, "bland-altman", { sets: ["Method A", "Method B"] }],
  // ROC curve (plan 05): the reference run, the defaults (same numbers),
  // the text-truth run, the single-class error and the unknown-positive error.
  ["rocTable", rocTable, "roc-curve", { truth: "Truth", score: "Score", positive: 1 }],
  ["rocTable", rocTable, "roc-curve", {}],
  ["rocTableText", rocTableText, "roc-curve", { truth: "Truth", score: "Score", positive: "Diseased" }],
  ["rocTableSingle", rocTableSingle, "roc-curve", { truth: "Truth", score: "Score", positive: 1 }],
  ["rocTable", rocTable, "roc-curve", { truth: "Truth", score: "Score", positive: 2 }],
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
  [
    "grouped",
    grouped,
    "two-way-anova",
    { design: "repeated-measures", posthoc: "tukey", posthocTarget: "groups", sphericity: false },
  ],
  [
    "grouped",
    grouped,
    "two-way-anova",
    { design: "repeated-measures", posthoc: "bonferroni", posthocTarget: "rows", sphericity: false },
  ],
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
  ["multiple", multiple, "descriptive-statistics"],
  ["multiple", multiple, "outliers", { q: 1 }],
  ["contingency2", contingency2, "chi-square"],
  ["contingency3", contingency3, "chi-square"],
  ["contingencyWide", contingencyWide, "chi-square"],
  ["freireich", freireich, "survival", { curveTest: "logrank", correction: "holm" }],
  ["freireich", freireich, "survival", { curveTest: "gehan", correction: "holm" }],
  ["survival3", survival3, "survival", { curveTest: "logrank", correction: "holm" }],
  ["survival3", survival3, "survival", { curveTest: "trend", correction: "none" }],
  ["survival3", survival3, "survival", { curveTest: "gehan", correction: "fdr" }],
  ["freireich", freireich, "cox", { reference: "6-MP" }],
  ["survival3", survival3, "cox"],
  ["survival3", survival3, "cox", { reference: "C" }],
  // prettier-ignore
  ["groupedBlankRow", groupedBlankRow, "two-way-anova", { design: "repeated-measures", posthoc: "none", posthocTarget: "groups" }],
  ["noReplicates", noReplicates, "two-way-anova", { design: "ordinary", posthoc: "tukey", posthocTarget: "groups" }],
  // prettier-ignore
  ["noReplicates", noReplicates, "two-way-anova", { design: "repeated-measures", posthoc: "none", posthocTarget: "groups" }],
  ["inhibition", inhibition, "nonlinear-regression", { model: "sigmoidal-4pl-logx" }],
  ["sparse", sparse, "shapiro-wilk"],
  ["sparse", sparse, "friedman", { posthoc: "none" }],
  ["sparse", sparse, "rm-anova", { posthoc: "none" }],
  // prettier-ignore
  ["sparse", sparse, "compare-two-groups", { paired: true, gaussian: true, equalVariance: true, ratio: false, tails: "two-sided" }],
  // prettier-ignore
  ["sparse", sparse, "compare-two-groups", { paired: true, gaussian: true, equalVariance: true, ratio: true, tails: "two-sided", sets: ["A", "C"] }],
  // prettier-ignore
  ["sparse", sparse, "compare-two-groups", { paired: false, gaussian: true, equalVariance: true, ratio: false, tails: "two-sided", sets: ["B", "C"] }],
  ["decimalCounts", decimalCounts, "chi-square"],
  ["noEvent", noEvent, "cox"],
  ["survival3", survival3, "cox", { reference: "Gone" }],
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
  ["rocTable", rocTable, "roc-curve"],
  ["freqCol", freqCol, "histogram"],
  ["survival", survivalTable, "survival"],
  ["freireich", freireich, "survival", { survivalShowBand: true }],
  ["grouped", grouped, "grouped-scatter"],
  ["grouped", grouped, "grouped-bars", { groupLayout: "separated" }],
  ["grouped", grouped, "grouped-lines"],
  ["grouped", grouped, "grouped-stacked"],
  ["grouped", grouped, "grouped-hbars", { center: "median" }],
  ["grouped", grouped, "heatmap", { center: "median", heatmapShowValues: true }],
  ["grouped", grouped, "grouped-box", { showPoints: true }],
  ["groupedViolin", grouped, "grouped-box", { kind: "violin", groupLayout: "separated" }],
  ["multiple", multiple, "heatmap"],
  ["multiple", multiple, "xy-scatter", { xVariable: "Height", yVariable: "Weight" }],
  ["volcano", volcanoTable, "volcano", volcano],
  ["volcanoXY", volcanoXY, "volcano", { volcanoY: "P" }],
  ["volcanoLog", volcanoLog, "volcano", { volcanoY: "-log10 P", volcanoYIsPValue: false }],
  ["contingency2", contingency2, "grouped-stacked"],
  ["contingency3", contingency3, "heatmap", { heatmapShowValues: true }],
  ["xyNoX", xyNoX, "xy-scatter"],
];

// ── Run and compare ──────────────────────────────────────────────────────

/** Rounds every number to 10 significant digits, so the reference ignores float noise. */
const rounded = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "number" ? Number(v.toPrecision(10)) : v)));

async function run() {
  await startR(
    fileURLToPath(new URL("../node_modules/webr/dist/", import.meta.url)),
    fileURLToPath(new URL("../r-packages/", import.meta.url)),
  );
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
    // Of the tables here, only a Multiple Variables one changes what a graph plots.
    const columns = plotColumns(readTable(data), type, opts, data === multiple ? "multiple" : "xy");
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
 *  ANOVA, the regression band's t; and the survival analysis gives Freireich's
 *  published results. */
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
  // The Geisser-Greenhouse P equals R's own, from a multivariate model (anova.mlm).
  const gg = await runAnalysis("rm-anova", matched, { posthoc: "none", sphericity: false });
  const mlm = await evalNamedVector(
    `M<-cbind(${["Day 0", "Day 7", "Day 14"].map((d) => rVec(readTable(matched).columns.find((c) => c.name === d)!.values)).join(",")});` +
      'f<-lm(M~1);s<-anova(f,X=~1,test="Spherical");c(p=s$"G-G Pr"[1])',
  );
  const ours = "error" in gg ? {} : Object.fromEntries(gg.stats.map((s) => [s.label, s.value]));
  if (mlm.p == null || Math.abs(mlm.p - (ours["P value"] ?? NaN)) > 1e-9)
    out.push(`Geisser-Greenhouse P: ${ours["P value"]}, R's: ${mlm.p}`);
  // Two-way, rows repeated: the corrected row and interaction P equal anova.mlm's, on the
  // subjects holding every row (C:Y2 lacks one); rows within a group, a paired t test.
  const gg2 = await runAnalysis("two-way-anova", grouped, {
    design: "repeated-measures",
    posthoc: "bonferroni",
    posthocTarget: "rows",
    sphericity: false,
  });
  const subjects = readTable(grouped).columns.filter((c) => c.name !== "C:Y2");
  const mlm2 = await evalNamedVector(
    `Y<-rbind(${subjects.map((c) => rVec(c.values)).join(",")});gs<-factor(c(${subjects.map((c) => `"${c.name[0]}"`).join(",")}));` +
      's<-anova(lm(Y~gs),X=~1,test="Spherical");' +
      'c(row=s$"G-G Pr"[1],inter=s$"G-G Pr"[2],pair=min(1,10*t.test(Y[1:3,1],Y[1:3,3],paired=TRUE)$p.value))',
  );
  const two = "error" in gg2 ? {} : Object.fromEntries(gg2.stats.map((s) => [s.label, s.value]));
  for (const [ours, theirs, what] of [
    [two["Row P value"], mlm2.row, "row"],
    [two["Interaction P value"], mlm2.inter, "interaction"],
    ["error" in gg2 ? null : gg2.comparisons?.[1].p, mlm2.pair, "Day 1 vs. Day 3 (A)"],
  ] as const)
    if (ours == null || theirs == null || Math.abs(ours - theirs) > 1e-9)
      out.push(`Two-way Geisser-Greenhouse, ${what}: ${ours}, R's: ${theirs}`);
  // Sphericity assumed, the comparisons are of the subjects the ANOVA kept: C at Day 4 is
  // (12 + 13) / 2 without C:Y2, which lacks Day 2, so A − C is 18 − 12.5.
  const kept = await runAnalysis("two-way-anova", grouped, {
    design: "repeated-measures",
    posthoc: "tukey",
    posthocTarget: "groups",
  });
  const a4 =
    "error" in kept ? undefined : kept.comparisons?.find((c) => c.group1 === "A (Day 4)" && c.group2 === "C (Day 4)");
  if (a4?.diff !== 5.5) out.push(`Two-way RM comparisons: A − C at Day 4 is ${a4?.diff}, not 5.5`);
  // Graphs draw each model's curve as R fits it: its squared distances to the points add up to
  // R's sum of squares.
  const curveData: Partial<Record<NonlinearModel, TableData>> = {
    "inhibitor-3pl-logx": doseFall,
    "semilog-line": doseRaw,
    hyperbola: doseRaw,
    line: xy,
    quadratic: xy,
    cubic: xy,
    "exponential-growth": growth,
    "one-phase-decay": decay,
    "michaelis-menten": enzyme,
  };
  for (const [model, data] of NONLINEAR_MODELS.map(
    (m) => [m, curveData[m] ?? (m.endsWith("-x") ? doseRaw : doseLog)] as const,
  )) {
    const r = await runAnalysis("nonlinear-regression", data, { model });
    if ("error" in r) {
      out.push(`${model}: ${r.error}`);
      continue;
    }
    const { x: dose, ys } = splitXY(readTable(data).columns);
    const pairs = pairUp(dose!, ys[0]);
    const ss = pairs.x.reduce(
      (sum, x, i) =>
        positiveXOnly(model) && x <= 0 ? sum : sum + (pairs.y[i] - doseCurveAt(model, r.coefficients!, x)) ** 2,
      0,
    );
    const rss = r.fit?.rows.find((row) => row.label === "Sum of squares")?.values?.[0];
    if (rss == null || Math.abs(ss - rss) > 1e-6 * Math.max(1, rss))
      out.push(`${model}: the graph's curve misses R's fit (${ss} vs. ${rss})`);
  }
  // An interpolated X, put back in the curve, gives its unknown's Y.
  const interpolated = await runAnalysis("nonlinear-regression", doseUnknowns, {
    model: "sigmoidal-4pl-logx",
    interpolate: true,
  });
  if ("error" in interpolated) out.push(`Interpolation: ${interpolated.error}`);
  else
    for (const u of interpolated.interpolated ?? [])
      if (u.x != null) {
        const y = doseCurveAt("sigmoidal-4pl-logx", interpolated.coefficients!, u.x);
        if (Math.abs(y - u.y) > 1e-6 || Math.abs(10 ** u.x - u.concentration!) > 1e-9 * 10 ** u.x)
          out.push(`Interpolation: ${u.label}'s X gives ${y}, not ${u.y}`);
      }
  // Comparing two curves: F from the two fits on their own and one fit on all their points.
  const both = await runAnalysis("nonlinear-regression", doseTwo, {
    y: "Control",
    model: "sigmoidal-4pl-logx",
    compareWith: "Treated",
    compare: "all",
  });
  const pooled = await runAnalysis(
    "nonlinear-regression",
    table(
      ["Title", "X", "Y"],
      doseTwo.rows.flatMap(([, x, a, b]) => [
        ["", x ?? "", a ?? ""],
        ["", x ?? "", b ?? ""],
      ]),
    ),
    { model: "sigmoidal-4pl-logx" },
  );
  if (!("error" in both) && !("error" in pooled)) {
    const row = (r: typeof both, label: string) =>
      ("error" in r ? [] : (r.fit?.rows.find((row) => row.label === label)?.values ?? [])).map((v) => v!);
    const [ssf, dff] = ["Sum of squares", "Degrees of freedom"].map((l) => row(both, l)[0] + row(both, l)[1]);
    const [ssr, dfr] = ["Sum of squares", "Degrees of freedom"].map((l) => row(pooled, l)[0]);
    const f = (ssr - ssf) / (dfr - dff) / (ssf / dff);
    const ours = both.stats.find((s) => s.label === "F")?.value;
    if (ours == null || Math.abs(f - ours) > 1e-6 * f) out.push(`Comparing curves: F ${ours}, by hand ${f}`);
  } else out.push("Comparing curves: a fit failed");
  // Dunnett's critical values (two-sided, 5%, equal groups) as his tables give them: 2 groups
  // against a control at 10 and 20 df, and 2 to 4 groups at infinite df; and T3's largest of
  // one t, which is that t.
  const dunnett = await evalNamedVector(
    `${R_MAXIMUM_T}\ncv<-function(k,df)uniroot(function(c)dun(c,rep(sqrt(0.5),k),df)-0.05,c(1.5,5),tol=1e-9)$root\n` +
      "c(a=cv(2,10),b=cv(2,20),c=cv(2,1e6),d=cv(3,1e6),f=cv(4,1e6),e=smm(2.1,1,12)-2*pt(-2.1,12))",
  );
  for (const [key, table] of [
    ["a", 2.57],
    ["b", 2.38],
    ["c", 2.21],
    ["d", 2.35],
    ["f", 2.44],
  ] as const) {
    const ours = dunnett[key];
    if (ours == null || Math.abs(ours - table) > 0.006) out.push(`Dunnett's critical value: ${ours}, table ${table}`);
  }
  if (dunnett.e == null || Math.abs(dunnett.e) > 1e-8) out.push(`T3 of one t: off by ${dunnett.e}`);
  // Freireich's data as the textbooks give it (SAS PROC LIFETEST, R survdiff and survfit with
  // log-log intervals): log-rank 16.79, Gehan-Wilcoxon 13.46; medians 23 (13 to —) and 8 (4 to 11).
  for (const [curveTest, chi] of [
    ["logrank", 16.7929],
    ["gehan", 13.4579],
  ] as const) {
    const r = await runAnalysis("survival", freireich, { curveTest, correction: "holm" });
    const ours = "error" in r ? null : r.stats[0].value;
    if (ours == null || Math.abs(ours - chi) > 1e-4)
      out.push(`Freireich ${curveTest} chi-square: ${ours}, published ${chi}`);
    const medians = "error" in r ? [] : r.survivalGroups?.map((g) => [g.median, g.low, g.high].join(" "));
    if (medians?.join(", ") !== "23 13 , 8 4 11") out.push(`Freireich medians: ${medians?.join(", ")}`);
  }
  // Its Cox regression, as published (Efron's ties): placebo's hazard 4.82 times 6-MP's, LR test 16.35.
  const cox = await runAnalysis("cox", freireich, { reference: "6-MP" });
  const hr = "error" in cox ? null : cox.hazardRatios?.[0]?.ratio;
  const lr = "error" in cox ? null : cox.stats[0].value;
  if (hr == null || Math.abs(hr - 4.817) > 0.001 || lr == null || Math.abs(lr - 16.35) > 0.01)
    out.push(`Freireich Cox: hazard ratio ${hr}, likelihood ratio ${lr}; published 4.817 and 16.35`);
  // The Survival curve's own Kaplan-Meier (TS) draws R's: the same steps and 95% band.
  for (const data of [freireich, survival3]) {
    const { x, ys } = splitXY(readTable(data).columns);
    for (const y of ys) {
      const { x: t, y: s } = pairUp(x!, y);
      const km = kaplanMeier(t, s);
      const r = await evalNamedVector(
        `library(survival);f<-survfit(Surv(${rVec(t)},${rVec(s)})~1,conf.type="log-log");e<-f$n.event>0;` +
          `c(setNames(f$surv[e],paste0("s",1:sum(e))),setNames(f$lower[e],paste0("l",1:sum(e))),setNames(f$upper[e],paste0("u",1:sum(e))))`,
      );
      // The curve's steps after (0, 1), one per event time; its last point only carries the curve on.
      km.t.slice(1, km.t.length).forEach((_, k) => {
        if (r[`s${k + 1}`] === undefined) return;
        const pairs: [number | null, number | null | undefined][] = [
          [km.s[k + 1], r[`s${k + 1}`]],
          [km.lower[k + 1], r[`l${k + 1}`]],
          [km.upper[k + 1], r[`u${k + 1}`]],
        ];
        for (const [ours, theirs] of pairs) {
          if ((ours ?? null) === (theirs ?? null)) continue;
          if (ours == null || theirs == null || Math.abs(ours - theirs) > 1e-9)
            out.push(`Kaplan-Meier of ${y.name}, step ${k + 1}: ${ours}, survfit: ${theirs}`);
        }
      });
    }
  }
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
      plotColumns(readTable(logistic), "logistic-curve", newGraphOptions("logistic-curve"), "xy"),
      newGraphOptions("logistic-curve"),
      paintOf(newGraphOptions("logistic-curve"), 1),
      readTable(logistic).titles,
    );
    addLogisticCurve(
      fig,
      plotColumns(readTable(logistic), "logistic-curve", newGraphOptions("logistic-curve"), "xy"),
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
    const doseColumns = plotColumns(readTable(doseLog), "dose-response", doseOpts, "xy");
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
  // Exponential curves (plan 08): the plan's values, by construction
  // (noiseless fixtures) and re-verified against WebR nls() before locking.
  // Tolerances from the plan: parameters 1e-3 relative, R² 1e-6 absolute,
  // half-life 1e-3 relative.
  const relClose = (got: number | null | undefined, want: number, tol: number) =>
    got != null && Math.abs(got - want) <= tol * Math.max(1, Math.abs(want));
  const checkExp = async (
    label: string,
    y: string,
    model: "one-phase-decay" | "two-phase-decay" | "plateau-decay" | "one-phase-association" | "exponential-growth",
    coefs: [string, number][],
    stats: [string, number][],
  ) => {
    const r = await runAnalysis("nonlinear-regression", expX, { y, model });
    if ("error" in r) {
      out.push(`Exponential ${label}: ${r.error}`);
      return null;
    }
    for (const [term, want] of coefs) {
      const got = r.coefficients?.find((c) => c.term === term)?.estimate;
      if (!relClose(got, want, 1e-3)) out.push(`Exponential ${label} ${term}: ${got}, plan says ${want}`);
    }
    for (const [name, want] of stats) {
      const got = r.stats.find((s) => s.label === name)?.value;
      const ok = name === "R squared" ? got != null && Math.abs(got - want) <= 1e-6 : relClose(got, want, 1e-3);
      if (!ok) out.push(`Exponential ${label} ${name}: ${got}, plan says ${want}`);
    }
    return r;
  };
  const fitA = await checkExp(
    "one-phase decay",
    "A",
    "one-phase-decay",
    [
      ["Y0", 100],
      ["Plateau", 10],
      ["K", 0.5],
    ],
    [
      ["Half-life", 1.3863],
      ["Span", 90],
      ["R squared", 1],
    ],
  );
  if (fitA) {
    if (fitA.equation !== "Y = (100 − 10)·exp(−0.5·X) + 10")
      out.push(`Exponential one-phase decay equation: ${fitA.equation}`);
    if (!fitA.notes.includes("Starting values: Y0 = 100, Plateau = 10.22, K = 0.5."))
      out.push(`Exponential one-phase decay notes missing starts: ${fitA.notes}`);
    // The fitted-curve overlay: passes through (0, 100) and (12, ~10.2),
    // monotone decreasing, and the TypeScript evaluator matches an
    // independent R evaluation of the fitted formula at the data X to 1e-6.
    const { addDoseCurve, evaluateFittedCurve } = await import("../src/views/graphs/dose-response-curve");
    const expOpts = { ...newGraphOptions("dose-response"), doseModel: "one-phase-decay" as const, doseY: "A" };
    const expColumns = plotColumns(readTable(expX), "dose-response", expOpts, "xy");
    const expFig = GRAPHS["dose-response"].build(
      expColumns,
      expOpts,
      paintOf(expOpts, 1),
      readTable(expX).titles,
    );
    addDoseCurve(expFig, expColumns, expOpts, fitA, paintOf(expOpts, 1));
    const traces = expFig.data as { mode?: string; x?: number[]; y?: number[] }[];
    const curve = traces.find((t) => t.mode === "lines" && t.x?.length === 101);
    if (!curve || curve.x?.[0] !== 0 || curve.y?.[0] == null || Math.abs(curve.y[0] - 100) > 1e-9)
      out.push(`Exponential overlay start: ${JSON.stringify(curve?.y?.slice(0, 1))}, expected 100 at X=0`);
    const lastY = curve?.y?.at(-1);
    if (!curve || curve.x?.at(-1) !== 12 || lastY == null || Math.abs(lastY - 10.2230876959) > 1e-6)
      out.push(`Exponential overlay end: ${lastY}, expected ~10.223 at X=12`);
    if (curve?.y?.some((v, i, a) => i > 0 && v >= a[i - 1]!))
      out.push(`Exponential overlay is not monotone decreasing`);
    const anns = (expFig.layout.annotations as { text?: string }[] | undefined) ?? [];
    if (!anns.some((a) => a.text?.includes("Half-life = 1.386")))
      out.push(`Exponential overlay note missing half-life: ${JSON.stringify(anns.map((a) => a.text))}`);
    const y0 = fitA.coefficients?.find((c) => c.term === "Y0")?.estimate;
    const pl = fitA.coefficients?.find((c) => c.term === "Plateau")?.estimate;
    const k = fitA.coefficients?.find((c) => c.term === "K")?.estimate;
    if (y0 != null && pl != null && k != null) {
      const xs = [0, 0.5, 1, 2, 3, 4, 6, 8, 10, 12];
      const rY = await evalNamedVector(
        `x<-c(${xs.join(",")});yv<-(${y0.toPrecision(15)}-${pl.toPrecision(15)})*exp(-${k.toPrecision(15)}*x)+${pl.toPrecision(15)};` +
          `c(${xs.map((_, i) => `y${i}=yv[${i + 1}]`).join(",")})`,
      );
      xs.forEach((x, i) => {
        const ts = evaluateFittedCurve("one-phase-decay", fitA.coefficients ?? [], x);
        const rv = rY[`y${i}`];
        if (rv == null || Math.abs(ts - rv) > 1e-6)
          out.push(`Exponential overlay at X=${x}: TS ${ts}, R ${rv}`);
      });
    }
  }
  await checkExp(
    "two-phase decay",
    "B",
    "two-phase-decay",
    [
      ["Plateau", 10],
      ["Span1", 60],
      ["K1", 1],
      ["Span2", 30],
      ["K2", 0.1],
    ],
    [
      ["Half-life (fast)", 0.6931],
      ["Half-life (slow)", 6.9315],
      ["Span", 90],
      ["R squared", 1],
    ],
  );
  const fitE = await checkExp(
    "plateau-decay",
    "E",
    "plateau-decay",
    [
      ["X0", 2],
      ["Y0", 100],
      ["Plateau", 10],
      ["K", 0.5],
    ],
    [
      ["Half-life", 1.3863],
      ["Span", 90],
      ["R squared", 1],
    ],
  );
  if (fitE) {
    if (fitE.equation !== "Y = 100 for X < 2; Y = 10 + (100 − 10)·exp(−0.5·(X − 2)) for X ≥ 2")
      out.push(`Exponential plateau-decay equation: ${fitE.equation}`);
    if (!fitE.notes.includes("Starting values: X0 = 3.5, Y0 = 92.92, Plateau = 10.61, K = 0.5."))
      out.push(`Exponential plateau-decay notes missing starts: ${fitE.notes}`);
  }
  // Association + growth (plan 08, 2/2). Case D is the plan's saturating
  // "growth" fixture, fitted as association: the fitted half-life 3.4657 is
  // the plan's doubling-time number (ln 2 / 0.2), and Span is the rise
  // (Plateau − Y0 = 190), positive like the decay span.
  const fitC = await checkExp(
    "one-phase association",
    "C",
    "one-phase-association",
    [
      ["Y0", 0],
      ["Plateau", 100],
      ["K", 0.3],
    ],
    [
      ["Half-life", 2.3105],
      ["Span", 100],
      ["R squared", 1],
    ],
  );
  if (fitC) {
    // The fitted Y0 is −1.2e-7, not exactly 0, so the equation carries that
    // tiny value — assert the shape, not the literal string.
    if (
      fitC.equation == null ||
      !fitC.equation.startsWith("Y = ") ||
      !fitC.equation.includes("(1 − exp(−0.3·X))")
    )
      out.push(`Exponential one-phase association equation: ${fitC.equation}`);
    if (!fitC.notes.includes("Starting values: Y0 = 0, Plateau = 97.27, K = 0.5."))
      out.push(`Exponential one-phase association notes missing starts: ${fitC.notes}`);
  }
  const fitD = await checkExp(
    "association (saturating fixture)",
    "D",
    "one-phase-association",
    [
      ["Y0", 10],
      ["Plateau", 200],
      ["K", 0.2],
    ],
    [
      ["Half-life", 3.4657],
      ["Span", 190],
      ["R squared", 1],
    ],
  );
  if (fitD) {
    if (fitD.equation !== "Y = 10 + (200 − 10)·(1 − exp(−0.2·X))")
      out.push(`Exponential association (saturating) equation: ${fitD.equation}`);
    if (!fitD.notes.includes("Starting values: Y0 = 10, Plateau = 182.8, K = 0.5."))
      out.push(`Exponential association (saturating) notes missing starts: ${fitD.notes}`);
  }
  const fitD2 = await checkExp(
    "exponential growth",
    "D2",
    "exponential-growth",
    [
      ["Y0", 10],
      ["K", 0.2],
    ],
    [
      ["Doubling time", 3.4657],
      ["R squared", 1],
    ],
  );
  if (fitD2) {
    if (fitD2.equation !== "Y = 10·exp(0.2·X)") out.push(`Exponential growth equation: ${fitD2.equation}`);
    if (!fitD2.notes.includes("Starting values: Y0 = 10, K = 0.1."))
      out.push(`Exponential growth notes missing starts: ${fitD2.notes}`);
    // The growth overlay: passes through (0, 10) and (12, ~110.2), monotone
    // increasing, and the TypeScript evaluator matches an independent R
    // evaluation of the fitted formula at the data X to 1e-6.
    const { addDoseCurve, evaluateFittedCurve } = await import("../src/views/graphs/dose-response-curve");
    const growthOpts = { ...newGraphOptions("dose-response"), doseModel: "exponential-growth" as const, doseY: "D2" };
    const growthColumns = plotColumns(readTable(expX), "dose-response", growthOpts, "xy");
    const growthFig = GRAPHS["dose-response"].build(
      growthColumns,
      growthOpts,
      paintOf(growthOpts, 1),
      readTable(expX).titles,
    );
    addDoseCurve(growthFig, growthColumns, growthOpts, fitD2, paintOf(growthOpts, 1));
    const gTraces = growthFig.data as { mode?: string; x?: number[]; y?: number[] }[];
    const gCurve = gTraces.find((t) => t.mode === "lines" && t.x?.length === 101);
    if (!gCurve || gCurve.x?.[0] !== 0 || gCurve.y?.[0] == null || Math.abs(gCurve.y[0] - 10) > 1e-9)
      out.push(`Exponential growth overlay start: ${JSON.stringify(gCurve?.y?.slice(0, 1))}, expected 10 at X=0`);
    const gLastY = gCurve?.y?.at(-1);
    if (!gCurve || gCurve.x?.at(-1) !== 12 || gLastY == null || Math.abs(gLastY - 110.2317638064) > 1e-6)
      out.push(`Exponential growth overlay end: ${gLastY}, expected ~110.23 at X=12`);
    if (gCurve?.y?.some((v, i, a) => i > 0 && v <= a[i - 1]!))
      out.push(`Exponential growth overlay is not monotone increasing`);
    const gAnns = (growthFig.layout.annotations as { text?: string }[] | undefined) ?? [];
    if (!gAnns.some((a) => a.text?.includes("Doubling time = 3.466")))
      out.push(`Exponential growth overlay note missing doubling time: ${JSON.stringify(gAnns.map((a) => a.text))}`);
    const gy0 = fitD2.coefficients?.find((c) => c.term === "Y0")?.estimate;
    const gk = fitD2.coefficients?.find((c) => c.term === "K")?.estimate;
    if (gy0 != null && gk != null) {
      const xs = [0, 0.5, 1, 2, 3, 4, 6, 8, 10, 12];
      const rY = await evalNamedVector(
        `x<-c(${xs.join(",")});yv<-${gy0.toPrecision(15)}*exp(${gk.toPrecision(15)}*x);` +
          `c(${xs.map((_, i) => `y${i}=yv[${i + 1}]`).join(",")})`,
      );
      xs.forEach((x, i) => {
        const ts = evaluateFittedCurve("exponential-growth", fitD2.coefficients ?? [], x);
        const rv = rY[`y${i}`];
        if (rv == null || Math.abs(ts - rv) > 1e-6)
          out.push(`Exponential growth overlay at X=${x}: TS ${ts}, R ${rv}`);
      });
    }
  }
  // The edge cases are errors, not fits — and the plateau error must come
  // from the runner before R is called.
  const oneSided = await runAnalysis("nonlinear-regression", plateauOneSided, { model: "plateau-decay" });
  if (!("error" in oneSided) || !oneSided.error.includes("both sides of the breakpoint"))
    out.push(
      `Exponential plateau one-sided: ${"error" in oneSided ? oneSided.error : "ran without error"}, expected an error naming both sides of the breakpoint`,
    );
  const tooFew = await runAnalysis("nonlinear-regression", expTooFew, { model: "two-phase-decay" });
  if (!("error" in tooFew) || !tooFew.error.includes("need at least 6"))
    out.push(
      `Exponential two-phase too-few: ${"error" in tooFew ? tooFew.error : "ran without error"}, expected an error naming at least 6 points`,
    );
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
      plotColumns(readTable(blandAltman), "bland-altman", newGraphOptions("bland-altman"), "xy"),
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
  // ROC curve (plan 05): the plan's values, computed independently in Python
  // (numpy 1.26.4 / scipy 1.11.4: Mann-Whitney U for AUC, DeLong
  // placement-variance for the CI, exact counting for sens/spec) and
  // re-verified before locking. Tolerances: absolute 1e-3 on AUC/SE/CI;
  // sensitivity/specificity exact (they are rational counts).
  const roc = await runAnalysis("roc-curve", rocTable, { truth: "Truth", score: "Score", positive: 1 });
  if ("error" in roc) {
    out.push(`ROC curve: ${roc.error}`);
  } else {
    const stat = (label: string) => roc.stats.find((s) => s.label === label)?.value;
    const plan: [string, number][] = [
      ["AUC", 0.97],
      ["AUC standard error", 0.0302],
      ["AUC 95% CI lower", 0.9108],
      ["AUC 95% CI upper", 1],
      ["Optimal cutpoint (Youden)", 0.71],
      ["Sensitivity at cutpoint", 0.8],
      ["Specificity at cutpoint", 1],
      ["Youden's J", 0.8],
      ["N positive", 10],
      ["N negative", 10],
    ];
    for (const [label, value] of plan) {
      const got = stat(label);
      if (got == null || Math.abs(got - value) > 1e-3) out.push(`ROC ${label}: ${got}, plan says ${value}`);
    }
    if (roc.subtitle !== "ROC curve analysis") out.push(`ROC subtitle: ${roc.subtitle}`);
    // The raw upper limit is 1.0292 — the stored value must be the truncated 1.
    if (!roc.notes.includes("the upper limit hit 1 and was truncated"))
      out.push(`ROC notes missing the truncation: ${roc.notes}`);
    if (!roc.notes.includes("among tied J values the highest threshold is reported"))
      out.push(`ROC notes missing the tie rule: ${roc.notes}`);
    // Tie check: J = 0.80 also at 0.65 (sens 0.90, spec 0.90) and 0.58
    // (sens 1.00, spec 0.80) — the optimum is 0.71, the highest threshold.
    const at = (t: number) => roc.rocCurve?.find((p) => p.threshold === t);
    const youden = (t: number) => {
      const p = at(t);
      return p === undefined ? null : p.sensitivity + p.specificity - 1;
    };
    if (youden(0.65) == null || Math.abs(youden(0.65)! - 0.8) > 1e-12)
      out.push(`ROC J at 0.65: ${youden(0.65)}, expected 0.80`);
    if (youden(0.58) == null || Math.abs(youden(0.58)! - 0.8) > 1e-12)
      out.push(`ROC J at 0.58: ${youden(0.58)}, expected 0.80`);
    // Spot checks on the ROC-points table.
    const s65 = at(0.65);
    if (s65?.sensitivity !== 0.9 || s65?.specificity !== 0.9)
      out.push(`ROC at 0.65: sens ${s65?.sensitivity}, spec ${s65?.specificity}, expected 0.90/0.90`);
    const s61 = at(0.61);
    if (s61?.sensitivity !== 0.9 || s61?.specificity !== 0.8)
      out.push(`ROC at 0.61: sens ${s61?.sensitivity}, spec ${s61?.specificity}, expected 0.90/0.80`);
    if (roc.rocCurve?.length !== 20) out.push(`ROC points: ${roc.rocCurve?.length}, expected 20 thresholds`);
    // The graph smoke: the curve passes through (1 − spec, sens) = (0.00, 0.80)
    // at the optimal point and includes (0,0) and (1,1); the diagonal and the
    // optimal-point marker are drawn.
    const rocFig = GRAPHS["roc-curve"].build(
      plotColumns(readTable(rocTable), "roc-curve", newGraphOptions("roc-curve"), "xy"),
      newGraphOptions("roc-curve"),
      paintOf(newGraphOptions("roc-curve"), 2),
      readTable(rocTable).titles,
    );
    const traces = rocFig.data as { mode?: string; x?: number[]; y?: number[] }[];
    const curve = traces.find((t) => t.mode === "lines+markers");
    const has = (x: number, y: number) =>
      curve?.x?.some((v, i) => Math.abs(v - x) < 1e-12 && Math.abs(curve.y![i] - y) < 1e-12);
    if (!curve || !has(0, 0) || !has(0, 0.8) || !has(1, 1))
      out.push(
        `ROC curve points: ${JSON.stringify(curve?.x)}/${JSON.stringify(curve?.y)}, expected (0,0), (0,0.80) and (1,1)`,
      );
    const diagonal = traces.find((t) => t.mode === "lines");
    if (
      !diagonal ||
      JSON.stringify(diagonal.x) !== JSON.stringify([0, 1]) ||
      JSON.stringify(diagonal.y) !== JSON.stringify([0, 1])
    )
      out.push(`ROC diagonal: ${JSON.stringify(diagonal?.x)}/${JSON.stringify(diagonal?.y)}, expected (0,0)–(1,1)`);
    const marker = traces.find((t) => t.mode === "markers");
    if (!marker || marker.x?.[0] !== 0 || marker.y?.[0] !== 0.8)
      out.push(`ROC optimal marker: ${JSON.stringify(marker?.x)}/${JSON.stringify(marker?.y)}, expected (0, 0.80)`);
  }
  // The defaults (no params) give the same numbers as the explicit run.
  const rocDef = await runAnalysis("roc-curve", rocTable, {});
  if ("error" in rocDef) {
    out.push(`ROC defaults: ${rocDef.error}`);
  } else if ("error" in roc) {
    out.push(`ROC defaults: no explicit run to compare against`);
  } else {
    for (const s of roc.stats) {
      const got = rocDef.stats.find((t) => t.label === s.label)?.value;
      if (got !== s.value) out.push(`ROC defaults ${s.label}: ${got}, explicit run: ${s.value}`);
    }
  }
  // A text truth column ("Diseased"/"Healthy") gives the same numbers.
  const rocText = await runAnalysis("roc-curve", rocTableText, {
    truth: "Truth",
    score: "Score",
    positive: "Diseased",
  });
  if ("error" in rocText) {
    out.push(`ROC text truth: ${rocText.error}`);
  } else if ("error" in roc) {
    out.push(`ROC text truth: no numeric run to compare against`);
  } else {
    for (const s of roc.stats) {
      const got = rocText.stats.find((t) => t.label === s.label)?.value;
      if (got == null || Math.abs(got - (s.value ?? 0)) > 1e-12)
        out.push(`ROC text truth ${s.label}: ${got}, numeric truth: ${s.value}`);
    }
  }
  // The edge cases are errors, not numbers.
  const rocSingle = await runAnalysis("roc-curve", rocTableSingle, { truth: "Truth", score: "Score", positive: 1 });
  if (!("error" in rocSingle) || !rocSingle.error.includes("exactly two values (found 1)"))
    out.push(
      `ROC single-class truth: ${"error" in rocSingle ? rocSingle.error : "ran without error"}, expected an error naming found 1`,
    );
  const rocBad = await runAnalysis("roc-curve", rocTable, { truth: "Truth", score: "Score", positive: 2 });
  if (!("error" in rocBad) || !rocBad.error.includes("is not in the outcome column"))
    out.push(
      `ROC unknown positive: ${"error" in rocBad ? rocBad.error : "ran without error"}, expected an error naming the outcome column`,
    );
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
    plotColumns(readTable(freqCol), "histogram", newGraphOptions("histogram"), "xy"),
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
      const tableType = nodes[node.parentId!].tableType!;
      const paint = paintOf(node.graphOptions!, graphSeries(type, data!, tableType, node.graphOptions!).length);
      const fig = GRAPHS[type].build(
        plotColumns(readTable(data!), type, node.graphOptions!, tableType),
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
