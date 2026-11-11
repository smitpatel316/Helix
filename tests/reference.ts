// Reference test: runs every analysis (R) and draws every graph (Plotly figures) on
// fixed tables, then compares the results with `reference.json`. A change in any
// number shows up as a diff. `npm test` checks; `npm test -- --update` rewrites the
// reference after an intended change. It also checks that TypeScript and R agree
// where both compute the same thing, and that the sample project's items all work.
/// <reference types="node" />
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAnalysis } from "../src/stats";
import type { AnalysisParams, AnalysisResult, AnalysisType } from "../src/stats/types";
import type { GraphOptions, GraphType, TableData } from "../src/store/types";
import { GRAPHS, graphSeries, newGraphOptions, plotColumns } from "../src/views/graphs";
import { paintOf } from "../src/views/graphs/plot-helpers";
import { pairUp, readTable, splitXY } from "../src/lib/dataset";
import { countDataColumns, countDataGroups } from "../src/views/analyses";
import { WIZARDS } from "../src/views/analyses/wizards";
import { fitLinear } from "../src/views/graphs/regression-overlay";
import { addDeming, fitDeming } from "../src/views/graphs/deming-overlay";
import { computeGroupedDEG } from "../src/lib/deg";
import { tCrit95 } from "../src/lib/student-t";
import { kaplanMeier } from "../src/lib/kaplan-meier";
import { dataGroups, groupsSetup, rVec } from "../src/stats/column/base";
import { R_MAXIMUM_T } from "../src/stats/column/anova";
import { evaluate as doseCurveAt } from "../src/views/graphs/fitted-curve";
import { NONLINEAR_MODELS, type NonlinearModel } from "../src/stats/types";
import { positiveXOnly } from "../src/stats/xy/nonlinear-regression";
import { ensurePackages, evalNamedVector, setPackageRepo, startR } from "../src/stats/webr";
import { prettyBreaks } from "../src/stats/column/frequency-distribution";
import { simulateTableData } from "../src/stats/simulation/simulate";
import { addMonteCarloHistogram } from "../src/views/graphs/monte-carlo-histogram";
import { sampleProject } from "./sample-project";

// ── R package repo (plan 00) ────────────────────────────────────────────
// Cox regression (plan 10) is the first analysis with requiredPackages: its
// package installs from the BUNDLED repo (webr-repo/, served on localhost),
// never the CDN — on Hatch the WASM side cannot reach the internet at all,
// so the bundled path is the only one provable here, and it is the shipping
// path. If webr-repo/ was not built yet, the Cox cases are skipped (never
// silently passed): run scripts/build-webr-repo.sh first.
const REPO_DIR = fileURLToPath(new URL("../webr-repo/", import.meta.url));
const repoReady = existsSync(`${REPO_DIR}MANIFEST.json`);
if (repoReady) {
  const repoServer = createServer((req, res) => {
    const path = decodeURIComponent(req.url!.split("?")[0]).replace(/^\/+/, "");
    const file = `${REPO_DIR}${path}`;
    if (!path || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => repoServer.listen(0, "127.0.0.1", r));
  setPackageRepo(`http://127.0.0.1:${(repoServer.address() as { port: number }).port}`, {
    allowCdnFallback: false,
  });
} else {
  console.log("⚠ webr-repo/ is not built — Cox cases skipped. Run scripts/build-webr-repo.sh, then re-run npm test.");
}

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

/** The literal simulated table (plan 22): Gaussian(100, SD 15), n = 20,
 *  seed 42 — the values `simulateTableData` must reproduce exactly, and the
 *  descriptives case below pins their mean (≈ 100) and SD (≈ 15). */
const simulated = table(
  ["Title", "Simulated 1"],
  [
    "120.5643767",
    "91.52952743",
    "105.4469262",
    "109.4929391",
    "106.0640248",
    "98.40813226",
    "122.67283",
    "98.58011442",
    "130.2763557",
    "99.05928851",
    "119.5730448",
    "134.2996809",
    "79.16708948",
    "95.8181685",
    "98.00017995",
    "109.539256",
    "95.73620618",
    "60.15316869",
    "63.39299607",
    "119.8017002",
  ].map((v) => ["", v]),
);

/** The Monte Carlo power fixture (plan 22): two groups of 64, the same
 *  pattern in both, B shifted +0.5 — so the simulated effect is d = 0.5 and
 *  the analytic power (power.t.test, n = 64, delta = 0.5, sd = 1) is 0.8015. */
const mcPattern = ["-1.5", "-1", "-0.5", "0", "0.5", "1", "1.5", "0"];
const mcPower = table(
  ["Title", "A", "B"],
  Array.from({ length: 64 }, (_, i) => ["", mcPattern[i % 8], String(Number(mcPattern[i % 8]) + 0.5)]),
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

/** Two replicate series around a line, with different spreads per row —
 *  so 1/SD² weights differ row to row (the tripwire that weighting is
 *  applied: the weighted intercept 1.0154 differs from the unweighted
 *  1.0800, verified in R). R1 is deliberately off the exact line — exactly
 *  collinear points would fit identically under any weights. */
const xyRep = table(
  ["Title", "X", "R1", "R2"],
  [
    ["", "0", "1.0", "1.2"],
    ["", "1", "3.2", "3.6"],
    ["", "2", "4.9", "5.1"],
    ["", "3", "7.1", "7.8"],
    ["", "4", "8.9", "9.05"],
  ],
);
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
/** Binding — Competition (plan 28): noiseless by construction on the doseLog
 *  X grid. Two-site: high-affinity IC50 0.01 (log −2), low-affinity IC50 10
 *  (log 1), high-affinity fraction 0.5, Bottom 0, Top 100 — Y =
 *  100·(0.5/(1+10^(X+2)) + 0.5/(1+10^(X−1))). The raw-concentration twin
 *  (10^ the log grid) is the -x model's fixture. Homologous: [L] = 1,
 *  Kd = 0.5, Bmax = 100, Bottom = 0 — Y = 100·1/(1 + 10^X + 0.5); the top
 *  plateau (66.67) sits below Bmax, which is the point: Bmax is the binding
 *  at infinite [L], not the curve's top. */
const competitionTwoSite = table(
  ["Title", "X", "Response"],
  [
    ["", "-3", "95.4495459545"],
    ["", "-2.5", "87.9715399425"],
    ["", "-2", "74.95004995"],
    ["", "-1.5", "61.8550382084"],
    ["", "-1", "54.0504050405"],
    ["", "-0.5", "50"],
    ["", "0", "45.9495949595"],
    ["", "0.5", "38.1449617916"],
    ["", "1", "25.04995005"],
    ["", "1.5", "12.0284600575"],
  ],
);
const competitionTwoSiteRaw = table(
  ["Title", "X", "Response"],
  [
    ["", "0.001", "95.4495459545"],
    ["", "0.0031622777", "87.9715399425"],
    ["", "0.01", "74.95004995"],
    ["", "0.0316227766", "61.8550382084"],
    ["", "0.1", "54.0504050405"],
    ["", "0.316227766", "50"],
    ["", "1", "45.9495949595"],
    ["", "3.1622776602", "38.1449617916"],
    ["", "10", "25.04995005"],
    ["", "31.6227766017", "12.0284600575"],
  ],
);
const competitionHomologous = table(
  ["Title", "X", "Response"],
  [
    ["", "-3", "66.6222518321"],
    ["", "-2.5", "66.5264166658"],
    ["", "-2", "66.2251655629"],
    ["", "-1.5", "65.2902278078"],
    ["", "-1", "62.5"],
    ["", "-0.5", "55.0591736736"],
    ["", "0", "40"],
    ["", "0.5", "21.4487440022"],
    ["", "1", "8.6956521739"],
    ["", "1.5", "3.0190705689"],
  ],
);
/** Three complete pairs — too few to smooth (needs ≥ 4). */
const smoothTooFew = table(
  ["Title", "X", "Response"],
  [
    ["", "-1", "2"],
    ["", "0", "5"],
    ["", "1", "9"],
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

/** Enzyme kinetics (plan 09): noiseless by construction on the shared
 *  substrate grid S = 0.5, 1, 2, 5, 10, 20, 50, so each fit must recover
 *  its generating parameters. A: Michaelis-Menten Vmax=100, Km=5.
 *  B: allosteric sigmoidal Vmax=100, Khalf=5, Hill slope=2.
 *  C: substrate inhibition Vmax=100, Km=2, Ki=10 — velocity falls at high S. */
const enzymeS = table(
  ["Title", "X", "A", "B", "C"],
  [
    ["", "0.5", "9.0909090909", "0.9900990099", "19.8019801980"],
    ["", "1", "16.6666666667", "3.8461538462", "32.2580645161"],
    ["", "2", "28.5714285714", "13.7931034483", "45.4545454545"],
    ["", "5", "50.0000000000", "50.0000000000", "52.6315789474"],
    ["", "10", "66.6666666667", "80.0000000000", "45.4545454545"],
    ["", "20", "80.0000000000", "94.1176470588", "32.2580645161"],
    ["", "50", "90.9090909091", "99.0099009901", "16.5562913907"],
  ],
);

/** Case A2: the same Michaelis-Menten data plus the (X = 0, Y = 0) vehicle point. */
const enzymeS0 = table(
  ["Title", "X", "Y"],
  [
    ["", "0", "0"],
    ["", "0.5", "9.0909090909"],
    ["", "1", "16.6666666667"],
    ["", "2", "28.5714285714"],
    ["", "5", "50.0000000000"],
    ["", "10", "66.6666666667"],
    ["", "20", "80.0000000000"],
    ["", "50", "90.9090909091"],
  ],
);

/** Noisy Michaelis-Menten (plan 09's CI fixture): the same generating
 *  parameters (Vmax=100, Km=5) with fixed deterministic ±1% offsets —
 *  ×[1.01, 0.99, 1.01, 0.99, 1.01, 0.99, 1.01] — recorded here, never random,
 *  so the SEs and Wald CIs are genuinely nonzero and pinnable. */
const enzymeNoisy = table(
  ["Title", "X", "Y"],
  [
    ["", "0.5", "9.1818181818"],
    ["", "1", "16.5000000000"],
    ["", "2", "28.8571428571"],
    ["", "5", "49.5000000000"],
    ["", "10", "67.3333333333"],
    ["", "20", "79.2000000000"],
    ["", "50", "91.8181818182"],
  ],
);

/** Negative substrate concentration: the runner must error before calling R. */
const enzymeNegX = table(
  ["Title", "X", "Y"],
  [
    ["", "-1", "5"],
    ["", "0.5", "9.0909090909"],
    ["", "1", "16.6666666667"],
    ["", "2", "28.5714285714"],
    ["", "5", "50.0000000000"],
  ],
);

/** All substrate concentrations equal: Km is unidentifiable, error before R. */
const enzymeConstX = table(
  ["Title", "X", "Y"],
  [
    ["", "2", "10"],
    ["", "2", "20"],
    ["", "2", "30"],
    ["", "2", "40"],
  ],
);

/** Michaelis-Menten needs ≥ 3 points (2 parameters + 1) — this has 2. */
const enzymeTooFew = table(
  ["Title", "X", "Y"],
  [
    ["", "0.5", "9.0909090909"],
    ["", "1", "16.6666666667"],
  ],
);

/** Binding — Saturation (plan 16): noiseless by construction, so each fit
 *  must recover its generating parameters. bindTotal: one-site total
 *  Bmax=100, Kd=5, NS=0.5, Background=2 (the X = 0 row pins Background).
 *  bindTwoSite: two-site specific BmaxHi=60, KdHi=1, BmaxLo=40, KdLo=20.
 *  bindTotalNs: the same total curve plus its nonspecific series
 *  (NS·X + Background), fitted jointly with NS/Background shared.
 *  bindTwoSiteNs: 12-point two-site total + nonspecific (BmaxHi=60,
 *  KdHi=1, BmaxLo=40, KdLo=20, NS=0.5, Background=2). */
const bindTotal = table(
  ["Title", "X", "Y"],
  [
    ["", "0", "2"],
    ["", "0.5", "11.3409090909"],
    ["", "1", "19.1666666667"],
    ["", "2", "31.5714285714"],
    ["", "5", "54.5"],
    ["", "10", "73.6666666667"],
    ["", "20", "92"],
    ["", "50", "117.9090909091"],
  ],
);
const bindTwoSite = table(
  ["Title", "X", "Y"],
  [
    // 10 points: the plan's 8-point table, plus X = 0.03 and X = 1000 —
    // the plan's own ≥10-point rule for two-site fits (see the
    // "at least 10 points" error) would reject its 8-point table, so the
    // table is extended with the same generating parameters (60/1/40/20).
    ["", "0.03", "1.8074829503"],
    ["", "0.1", "5.6535504297"],
    ["", "0.3", "14.4372868511"],
    ["", "1", "31.9047619048"],
    ["", "3", "50.2173913043"],
    ["", "10", "67.8787878788"],
    ["", "30", "82.064516129"],
    ["", "100", "92.7392739274"],
    ["", "300", "97.3006644518"],
    ["", "1000", "99.1557462146"],
  ],
);
const bindTotalNs = table(
  ["Title", "X", "Total", "Nonspecific"],
  [
    ["", "0", "2", "2"],
    ["", "0.5", "11.3409090909", "2.25"],
    ["", "1", "19.1666666667", "2.5"],
    ["", "2", "31.5714285714", "3"],
    ["", "5", "54.5", "4.5"],
    ["", "10", "73.6666666667", "7"],
    ["", "20", "92", "12"],
    ["", "50", "117.9090909091", "27"],
  ],
);
const bindTwoSiteNs = table(
  ["Title", "X", "Total", "Nonspecific"],
  [
    ["", "0.1", "7.7035504297", "2.05"],
    ["", "0.3", "16.5872868511", "2.15"],
    ["", "1", "34.4047619048", "2.5"],
    ["", "2", "46.6363636364", "3"],
    ["", "3", "53.7173913043", "3.5"],
    ["", "5", "62.5", "4.5"],
    ["", "10", "74.8787878788", "7"],
    ["", "20", "89.1428571429", "12"],
    ["", "30", "99.064516129", "17"],
    ["", "50", "114.3949579832", "27"],
    ["", "100", "144.7392739274", "52"],
    ["", "300", "249.3006644518", "152"],
  ],
);
/** Two-site model on 6 points: must error naming the 10-point requirement. */
const bindTwoSiteFew = table(
  ["Title", "X", "Y"],
  [
    ["", "0.1", "5.6535504297"],
    ["", "1", "31.9047619048"],
    ["", "3", "50.2173913043"],
    ["", "10", "67.8787878788"],
    ["", "30", "82.064516129"],
    ["", "100", "92.7392739274"],
  ],
);
/** Negative concentration: must error "Concentrations can't be negative." */
const bindNegX = table(
  ["Title", "X", "Y"],
  [
    ["", "-1", "5"],
    ["", "0.5", "11.3409090909"],
    ["", "1", "19.1666666667"],
    ["", "2", "31.5714285714"],
    ["", "5", "54.5"],
  ],
);
/** Two-series fit with 4 rows: each series is short of the 5-point minimum. */
const bindTotalNsFew = table(
  ["Title", "X", "Total", "Nonspecific"],
  [
    ["", "0", "2", "2"],
    ["", "1", "19.1666666667", "2.5"],
    ["", "5", "54.5", "4.5"],
    ["", "10", "73.6666666667", "7"],
  ],
);

/** Binding — Kinetics (plan 16): noiseless by construction on the shared
 *  time grid 0–15. Assoc: one-phase association Y0=0, Plateau=100,
 *  Kobs=0.5. Dissoc: one-phase dissociation Y0=100, Plateau=5, Koff=0.3.
 *  TwoPhase: two-phase association Plateau=100, PercentFast=0.7, KFast=1.0,
 *  KSlow=0.1. Dissoc2: two-phase dissociation Y0=100, Plateau=5,
 *  PercentFast=0.7, KFast=1.0, KSlow=0.1. */
const bindKinetics = table(
  ["Title", "X", "Assoc", "Dissoc", "TwoPhase", "Dissoc2"],
  [
    ["", "0", "0", "100", "0", "100"],
    ["", "1", "39.3469340287", "75.3777309648", "47.1033165769", "55.2518492519"],
    ["", "2", "63.2120558829", "57.1371054289", "65.9646075811", "37.333622798"],
    ["", "3", "77.6869839852", "43.6241176754", "74.2903585938", "29.4241593359"],
    ["", "5", "91.7915001376", "26.1973652141", "81.3324239187", "22.7341972772"],
    ["", "7", "96.9802616578", "16.633360684", "85.0386091487", "19.2133213088"],
    ["", "10", "99.3262053001", "9.7297714949", "88.9604387698", "15.4875831687"],
    ["", "15", "99.944691563", "6.0553546711", "93.3060737824", "11.3592299067"],
  ],
);
/** Association-then-dissociation (plan 16, third sub-task): one experiment,
 *  HotNM=1 nM, Time0=10, Kon=1e8 M⁻¹min⁻¹, Koff=0.1 min⁻¹, Bmax=100,
 *  NS=0.5 — Kob=0.2, kinetic Kd=1 nM, Eq=50. */
const bindAssocThenDissoc = table(
  ["Title", "X", "Y"],
  [
    ["", "0", "0.5"],
    ["", "1", "9.5634623461"],
    ["", "2", "16.9839976982"],
    ["", "3", "23.0594181953"],
    ["", "5", "32.1060279414"],
    ["", "7", "38.1701518029"],
    ["", "10", "43.7332358382"],
    ["", "12", "35.8963797358"],
    ["", "15", "26.7222830544"],
    ["", "20", "16.4046186402"],
    ["", "30", "6.3509822174"],
    ["", "40", "2.6524560684"],
  ],
);

/** Enzyme kinetics — Inhibition (plan 17): noiseless by construction on
 *  the shared substrate grid 1–100. enzMixed: Vmax=100, Km=10, Ki=5,
 *  Alpha=2 (mixed equation). enzCompetitive: Vmax=100, Km=10, Ki=5
 *  (competitive equation). The Y titles carry [I] ("0 nM" → 0), so the
 *  title-parsing path is exercised too. enzMorrison: Et=5, Kiapp=2,
 *  v0=100 on the It grid 0–50 nM. */
const enzMixed = table(
  ["Title", "X", "0 nM", "5 nM", "20 nM"],
  [
    ["", "1", "9.0909090909", "4.6511627907", "1.8867924528"],
    ["", "2", "16.6666666667", "8.6956521739", "3.5714285714"],
    ["", "5", "33.3333333333", "18.1818181818", "7.6923076923"],
    ["", "10", "50", "28.5714285714", "12.5"],
    ["", "20", "66.6666666667", "40", "18.1818181818"],
    ["", "50", "83.3333333333", "52.6315789474", "25"],
    ["", "100", "90.9090909091", "58.8235294118", "28.5714285714"],
  ],
);
const enzCompetitive = table(
  ["Title", "X", "0 nM", "5 nM", "20 nM"],
  [
    ["", "1", "9.0909090909", "4.7619047619", "1.9607843137"],
    ["", "2", "16.6666666667", "9.0909090909", "3.8461538462"],
    ["", "5", "33.3333333333", "20", "9.0909090909"],
    ["", "10", "50", "33.3333333333", "16.6666666667"],
    ["", "20", "66.6666666667", "50", "28.5714285714"],
    ["", "50", "83.3333333333", "71.4285714286", "50"],
    ["", "100", "90.9090909091", "83.3333333333", "66.6666666667"],
  ],
);
/** Global model with no uninhibited series: must error naming "uninhibited". */
const enzNoZero = table(
  ["Title", "X", "5 nM", "20 nM"],
  [
    ["", "1", "4.7619047619", "1.9607843137"],
    ["", "2", "9.0909090909", "3.8461538462"],
    ["", "5", "20", "9.0909090909"],
    ["", "10", "33.3333333333", "16.6666666667"],
    ["", "20", "50", "28.5714285714"],
    ["", "50", "71.4285714286", "50"],
    ["", "100", "83.3333333333", "66.6666666667"],
  ],
);
const enzMorrison = table(
  ["Title", "X", "Y"],
  [
    ["", "0", "100"],
    ["", "1", "86.3324958071"],
    ["", "2", "74.0312423743"],
    ["", "5", "46.3324958071"],
    ["", "10", "24.3398113206"],
    ["", "20", "11.3835714722"],
    ["", "50", "4.2362280552"],
  ],
);

/** Dose-response — Special (plan 18): noiseless by construction on the
 *  log10-agonist grid −8…−4. schild: Bottom=0, Top=100, LogEC50=−6,
 *  HillSlope=1, pA2=8 (Kb=1e-8 M) at B = 0, 1e-8, 1e-7 M — the Y titles
 *  carry B ("0 M" → 0), so the title-parsing path is exercised too.
 *  ec50shift: Bottom=0, Top=100, HillSlope=1, LogEC50 −6 and −5.
 *  operational: full agonist 4PL (Bottom=0, Top=100, LogEC50=−7, n=1)
 *  and a partial agonist from the operational equation (logKA=−6,
 *  logtau=0.5), sharing Basal=0, Effectmax=100, n=1. */
const schild = table(
  ["Title", "X", "0 M", "1e-8 M", "1e-7 M"],
  [
    ["", "-8", "0.9900990099", "0.4975124378", "0.0908265213"],
    ["", "-7.5", "3.0653430032", "1.5565279621", "0.2866557101"],
    ["", "-7", "9.0909090909", "4.7619047619", "0.9009009009"],
    ["", "-6.5", "24.0253073352", "13.6527059496", "2.7944627181"],
    ["", "-6", "50", "33.3333333333", "8.3333333333"],
    ["", "-5.5", "75.9746926648", "61.2574113277", "22.3288777134"],
    ["", "-5", "90.9090909091", "83.3333333333", "47.619047619"],
    ["", "-4.5", "96.9346569968", "94.0516512848", "74.1922022049"],
    ["", "-4", "99.0099009901", "98.0392156863", "90.0900900901"],
  ],
);
const ec50shift = table(
  ["Title", "X", "0 nM", "10 nM"],
  [
    ["", "-8", "0.9900990099", "0.0999000999"],
    ["", "-7.5", "3.0653430032", "0.3152309183"],
    ["", "-7", "9.0909090909", "0.9900990099"],
    ["", "-6.5", "24.0253073352", "3.0653430032"],
    ["", "-6", "50", "9.0909090909"],
    ["", "-5.5", "75.9746926648", "24.0253073352"],
    ["", "-5", "90.9090909091", "50"],
    ["", "-4.5", "96.9346569968", "75.9746926648"],
    ["", "-4", "99.0099009901", "90.9090909091"],
  ],
);
const operational = table(
  ["Title", "X", "Full agonist", "Partial agonist"],
  [
    ["", "-8", "9.0909090909", "3.0359144704"],
    ["", "-7.5", "24.0253073352", "8.8368670256"],
    ["", "-7", "50", "22.3288777134"],
    ["", "-6.5", "75.9746926648", "43.1736470252"],
    ["", "-6", "90.9090909091", "61.2574113277"],
    ["", "-5.5", "96.9346569968", "70.6101111697"],
    ["", "-5", "99.0099009901", "74.1922022049"],
    ["", "-4.5", "99.6847690817", "75.4018295819"],
    ["", "-4", "99.9000999001", "75.7925986172"],
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

/** Cox proportional-hazards regression (plan 10): the plan's fixture —
 *  n = 16. The plan's prose says 13 events / 3 censored, but counting its
 *  own rows gives 12 events / 4 censored (6 + 6 events, 2 + 2 censored),
 *  which WebR confirms (Number of events 12). Age is entered as recorded
 *  (no centring — centring does not change a Cox slope; there is no
 *  intercept). The one tied time, 12, holds one event (Trt = 1) and one
 *  censored subject (Trt = 0), so there is no tied *event* time and Efron
 *  agrees with Breslow exactly on this fixture (see disagreements()). */
const coxTable = table(
  ["Title", "Time", "Status", "Trt", "Age"],
  [
    ["", "3", "1", "0", "62"],
    ["", "5", "1", "0", "58"],
    ["", "7", "0", "0", "65"],
    ["", "8", "1", "0", "70"],
    ["", "10", "1", "0", "55"],
    ["", "12", "0", "0", "68"],
    ["", "15", "1", "0", "61"],
    ["", "20", "1", "0", "59"],
    ["", "6", "1", "1", "60"],
    ["", "9", "1", "1", "57"],
    ["", "12", "1", "1", "63"],
    ["", "15", "0", "1", "66"],
    ["", "18", "1", "1", "54"],
    ["", "22", "1", "1", "71"],
    ["", "25", "0", "1", "64"],
    ["", "30", "1", "1", "56"],
  ],
);

/** Every subject censored: Cox needs at least 2 events. */
const coxAllCensored = table(
  ["Title", "Time", "Status", "Trt", "Age"],
  [
    ["", "3", "0", "0", "62"],
    ["", "5", "0", "0", "58"],
    ["", "6", "0", "1", "60"],
    ["", "9", "0", "1", "57"],
  ],
);

/** A status code of 2: codes must be 1 (event) or 0 (censored). */
const coxBadStatus = table(
  ["Title", "Time", "Status", "Trt", "Age"],
  [
    ["", "3", "1", "0", "62"],
    ["", "5", "2", "0", "58"],
    ["", "6", "1", "1", "60"],
    ["", "9", "1", "1", "57"],
  ],
);

/** A zero survival time: times must be positive. */
const coxZeroTime = table(
  ["Title", "Time", "Status", "Trt", "Age"],
  [
    ["", "3", "1", "0", "62"],
    ["", "0", "1", "0", "58"],
    ["", "6", "1", "1", "60"],
    ["", "9", "1", "1", "57"],
  ],
);

/** Mixed-effects model (plan 20): the plan's balanced 6-subject × 4-time-point
 *  table (subjects 1–3 Control, 4–6 Treated; subject intercepts [0, 2, −1, 0, 2, −1];
 *  y = 10 + 5·treated + 1.5·time + intercept), with seeded noise (sd 0.5, seed 11 —
 *  the P-07 construction). The plan's noiseless values are NOT lme4 ground truth:
 *  on the noiseless table lme4 reports "Model failed to converge" and "nearly
 *  unidentifiable" (3 warnings, conv=1, unident=1), and nlme refuses it outright
 *  ("system is computationally singular") — the fixed effects it returns are
 *  unconverged optimizer artifacts whose values depend on the vector ordering:
 *  column-major (the runner's flatten order) gives max|grad| = 19,910, intercept
 *  10.1892, treatment 5.2211, subject variance 0.4483, p ≈ 0.95; row-major gives
 *  max|grad| = 9,584, intercept 10.4225, treatment 4.9398, subject variance
 *  0.4457, p ≈ 0.92 (both re-measured for the Plan 20 fix; the earlier quoted
 *  max|grad| = 0.661141 matches neither ordering and was wrong). The Satterthwaite
 *  p-values are meaningless on the unconverged fit. The noisy table converges
 *  cleanly (0 warnings, not singular) and its fixed effects equal the numpy OLS
 *  fit on the same cells to ~3e-9 (OLS 10.1926158 / 4.9656083 / 1.4972117 vs
 *  lme4 10.19261583 / 4.96560833 / 1.49721167 — recomputed for the fix) — and
 *  match the P-07-pinned values (same construction) to 1e-5, which is the
 *  independent reshaping check. Realised noise variance (sample variance,
 *  ddof=1, of the 24 seeded-minus-noiseless residuals) is 0.1561; the lme4
 *  REML residual variance 0.1337 sits 14% below it. */
const mixedBalanced = table(
  ["Title", "T0", "T1", "T2", "T3"],
  [
    ["", "9.7045", "11.5133", "12.2417", "13.8187"],
    ["", "12.5892", "13.0329", "15.6618", "16.8125"],
    ["", "8.9771", "9.9979", "11.5858", "13.3258"],
    ["", "14.2309", "16.3722", "17.4250", "19.5062"],
    ["", "16.8885", "18.9439", "19.7039", "21.1721"],
    ["", "13.6587", "15.4921", "16.7787", "18.6763"],
  ],
);

/** The same table with one cell blanked (S2/T2): the point of the analysis —
 *  23 observations used, no subject dropped. */
const mixedMissing = table(
  ["Title", "T0", "T1", "T2", "T3"],
  [
    ["", "9.7045", "11.5133", "12.2417", "13.8187"],
    ["", "12.5892", "13.0329", "", "16.8125"],
    ["", "8.9771", "9.9979", "11.5858", "13.3258"],
    ["", "14.2309", "16.3722", "17.4250", "19.5062"],
    ["", "16.8885", "18.9439", "19.7039", "21.1721"],
    ["", "13.6587", "15.4921", "16.7787", "18.6763"],
  ],
);

/** The same table with all of S6's values blanked except one: the
 *  single-observation warning. */
const mixedSingleObs = table(
  ["Title", "T0", "T1", "T2", "T3"],
  [
    ["", "9.7045", "11.5133", "12.2417", "13.8187"],
    ["", "12.5892", "13.0329", "15.6618", "16.8125"],
    ["", "8.9771", "9.9979", "11.5858", "13.3258"],
    ["", "14.2309", "16.3722", "17.4250", "19.5062"],
    ["", "16.8885", "18.9439", "19.7039", "21.1721"],
    ["", "13.6587", "", "", ""],
  ],
);

/** Two subjects only: a random intercept is not estimable. */
const mixedTwoSubjects = table(
  ["Title", "T0", "T1", "T2", "T3"],
  [
    ["", "9.7045", "11.5133", "12.2417", "13.8187"],
    ["", "12.5892", "13.0329", "15.6618", "16.8125"],
  ],
);

/** The subject-factor params for the Column reference tables (Treatment arm
 *  by subject group, as the plan's table encodes it). */
const mixedColumnParams: AnalysisParams = {
  subjectId: "row",
  randomStructure: "intercept",
  fixedFactors: ["Treatment", "T"],
  subjectFactor: { name: "Treatment", levels: ["Control", "Control", "Control", "Treated", "Treated", "Treated"] },
};

/** Two subjects, one per arm: the subject factor lists one level per row. */
const mixedTwoSubjectsParams: AnalysisParams = {
  subjectId: "row",
  randomStructure: "intercept",
  fixedFactors: ["Treatment", "T"],
  subjectFactor: { name: "Treatment", levels: ["Control", "Treated"] },
};

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

/** Grubbs' test (plan 24): the plan's masking case — two outliers so far out
 *  they inflate the SD and mask each other. Round 1: G = 1.5287, P = 0.6774
 *  (R outliers::grubbs.test, two-sided), not significant, so the standard
 *  iteration (stop when not significant) flags nothing. The plan expected
 *  both flagged; R says otherwise — masking wins outright here, which is the
 *  phenomenon the plan's own edge-case note describes. */
const grubbsMasked = table(
  ["Title", "Masked"],
  [["", "10"], ["", "10.2"], ["", "9.8"], ["", "10.1"], ["", "10"], ["", "25"], ["", "26"]],
);

/** Grubbs' test (plan 24): the iteration case that does flag twice — round 1
 *  G = 2.0643, P = 0.0309 flags 45, round 2 G = 2.0408, P = 0.0000 flags 25,
 *  round 3 G = 1.4832, P = 0.4128 stops (all R outliers::grubbs.test). */
const grubbsIterate = table(
  ["Title", "Values"],
  [["", "10"], ["", "10.2"], ["", "9.8"], ["", "10.1"], ["", "10"], ["", "25"], ["", "45"]],
);

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

/** Normality tests (plan 23): n = 25 per column, so D'Agostino–Pearson is
 *  valid. A is near-Gaussian; B is right-skewed (lognormal-ish: SW on
 *  log(B) passes). Values pinned from SciPy 1.11 for SW/DP/AD-statistic/KS-D,
 *  re-verified in webR — except the KS P values, where R reports the
 *  asymptotic Kolmogorov P (A 0.8889, B 0.0215) and SciPy's `kstest`
 *  defaults to the exact finite-n P (0.8508, 0.0166): the reference pins
 *  R's, since Helix runs R. AD P values are nortest's (A 0.6657, B 0.00009).
 *  DP is the TS implementation — `nortest::pearson.test` is a different
 *  test (Pearson chi-square goodness-of-fit on binned data), so the
 *  disagreements() cross-check below evaluates the same formulae in R. */
const normality = table(
  ["Title", "A", "B"],
  [
    ["", "12.0", "6.5"],
    ["", "12.4", "1.3"],
    ["", "11.7", "5.1"],
    ["", "10.9", "7.1"],
    ["", "11.5", "8.0"],
    ["", "10.8", "2.5"],
    ["", "12.1", "5.3"],
    ["", "13.6", "3.7"],
    ["", "11.4", "4.2"],
    ["", "11.3", "15.5"],
    ["", "12.6", "4.2"],
    ["", "12.4", "7.2"],
    ["", "12.1", "13.7"],
    ["", "10.9", "4.9"],
    ["", "12.0", "6.8"],
    ["", "12.8", "8.0"],
    ["", "10.4", "7.7"],
    ["", "11.5", "3.1"],
    ["", "9.7", "7.8"],
    ["", "10.5", "19.1"],
    ["", "9.8", "2.5"],
    ["", "11.7", "13.5"],
    ["", "10.5", "8.0"],
    ["", "12.3", "4.7"],
    ["", "12.2", "30.0"],
  ],
);

/** Normality tests (plan 23): a non-positive value — lognormality must
 *  refuse it with a user-facing error. */
const normalityNonpositive = table(
  ["Title", "A", "B"],
  [
    ["", "12.0", "6.5"],
    ["", "12.4", "0"],
    ["", "11.7", "5.1"],
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
    [
      "Day 1",
      "10.001230153357483",
      "10.29874553750847",
      "9.725862144637782",
      "11.109408161242726",
      "11.545329214828277",
      "11.008353445003538",
    ],
    [
      "Day 2",
      "14.060143602597439",
      "15.340215245554534",
      "13.50779348144867",
      "19.37952510018006",
      "20.4898420501852",
      "20.35688700816006",
    ],
    [
      "Day 1",
      "11.1054142489979",
      "10.069531955291795",
      "10.970748177536727",
      "13.695303194458289",
      "11.655785452714918",
      "12.542384238959782",
    ],
    [
      "Day 2",
      "11.098777260199157",
      "11.710462260215024",
      "11.158264962208268",
      "14.76490886892532",
      "13.732553518556298",
      "15.271264358821702",
    ],
  ],
  {
    groups: 2,
    replicates: 3,
    rowGroups: [
      { name: "WT", count: 2 },
      { name: "KO", count: 2 },
    ],
  },
);

/** The Drug × Day 2 × KO cell emptied (all three replicates blank). */
const grouped3wayEmpty = table(
  ["Title", "Placebo:Y1", "Placebo:Y2", "Placebo:Y3", "Drug:Y1", "Drug:Y2", "Drug:Y3"],
  [
    [
      "Day 1",
      "10.001230153357483",
      "10.29874553750847",
      "9.725862144637782",
      "11.109408161242726",
      "11.545329214828277",
      "11.008353445003538",
    ],
    [
      "Day 2",
      "14.060143602597439",
      "15.340215245554534",
      "13.50779348144867",
      "19.37952510018006",
      "20.4898420501852",
      "20.35688700816006",
    ],
    [
      "Day 1",
      "11.1054142489979",
      "10.069531955291795",
      "10.970748177536727",
      "13.695303194458289",
      "11.655785452714918",
      "12.542384238959782",
    ],
    ["Day 2", "11.098777260199157", "11.710462260215024", "11.158264962208268", "", "", ""],
  ],
  {
    groups: 2,
    replicates: 3,
    rowGroups: [
      { name: "WT", count: 2 },
      { name: "KO", count: 2 },
    ],
  },
);

/** Bands that don't tile the rows (3 + 2 ≠ 4). */
const grouped3wayBadBands = {
  ...grouped3way,
  rowGroups: [
    { name: "WT", count: 3 },
    { name: "KO", count: 2 },
  ],
};

/** One observation per cell: no residual degrees of freedom. */
const grouped3wayN1 = table(
  ["Title", "Placebo:Y1", "Drug:Y1"],
  [
    ["Day 1", "10.0", "11.1"],
    ["Day 2", "14.1", "19.4"],
    ["Day 1", "11.1", "13.7"],
    ["Day 2", "11.1", "14.8"],
  ],
  {
    groups: 2,
    replicates: 1,
    rowGroups: [
      { name: "WT", count: 2 },
      { name: "KO", count: 2 },
    ],
  },
);

/** Nested t test / nested one-way ANOVA (plan 14): 3 groups × 3 subgroups × 3
 *  replicates, one row — each subgroup's three replicate values sit in that
 *  row across its replicate columns, so the subcolumn means are exactly
 *  Control [11, 13, 11], Treated [16, 17, 16], High [20, 22, 20]. */
const nested3 = table(
  [
    "Title",
    "Control:S1:R1",
    "Control:S1:R2",
    "Control:S1:R3",
    "Control:S2:R1",
    "Control:S2:R2",
    "Control:S2:R3",
    "Control:S3:R1",
    "Control:S3:R2",
    "Control:S3:R3",
    "Treated:S1:R1",
    "Treated:S1:R2",
    "Treated:S1:R3",
    "Treated:S2:R1",
    "Treated:S2:R2",
    "Treated:S2:R3",
    "Treated:S3:R1",
    "Treated:S3:R2",
    "Treated:S3:R3",
    "High:S1:R1",
    "High:S1:R2",
    "High:S1:R3",
    "High:S2:R1",
    "High:S2:R2",
    "High:S2:R3",
    "High:S3:R1",
    "High:S3:R2",
    "High:S3:R3",
  ],
  [
    [
      "",
      "10",
      "11",
      "12",
      "13",
      "12",
      "14",
      "11",
      "10",
      "12",
      "16",
      "15",
      "17",
      "18",
      "17",
      "16",
      "15",
      "16",
      "17",
      "20",
      "21",
      "19",
      "22",
      "21",
      "23",
      "19",
      "20",
      "21",
    ],
  ],
  { groups: 3, subgroups: 3, replicates: 3 },
);

/** The first two groups of `nested3` — a two-group nested table. */
const nested2 = table(
  [
    "Title",
    "Control:S1:R1",
    "Control:S1:R2",
    "Control:S1:R3",
    "Control:S2:R1",
    "Control:S2:R2",
    "Control:S2:R3",
    "Control:S3:R1",
    "Control:S3:R2",
    "Control:S3:R3",
    "Treated:S1:R1",
    "Treated:S1:R2",
    "Treated:S1:R3",
    "Treated:S2:R1",
    "Treated:S2:R2",
    "Treated:S2:R3",
    "Treated:S3:R1",
    "Treated:S3:R2",
    "Treated:S3:R3",
  ],
  [["", "10", "11", "12", "13", "12", "14", "11", "10", "12", "16", "15", "17", "18", "17", "16", "15", "16", "17"]],
  { groups: 2, subgroups: 3, replicates: 3 },
);

/** `nested2` with Control's S2 subgroup emptied: the t test runs on
 *  Control means [11, 11] and Treated [16, 17, 16], and the notes name the
 *  dropped subgroup. */
const nestedDrop = table(
  [
    "Title",
    "Control:S1:R1",
    "Control:S1:R2",
    "Control:S1:R3",
    "Control:S2:R1",
    "Control:S2:R2",
    "Control:S2:R3",
    "Control:S3:R1",
    "Control:S3:R2",
    "Control:S3:R3",
    "Treated:S1:R1",
    "Treated:S1:R2",
    "Treated:S1:R3",
    "Treated:S2:R1",
    "Treated:S2:R2",
    "Treated:S2:R3",
    "Treated:S3:R1",
    "Treated:S3:R2",
    "Treated:S3:R3",
  ],
  [["", "10", "11", "12", "", "", "", "11", "10", "12", "16", "15", "17", "18", "17", "16", "15", "16", "17"]],
  { groups: 2, subgroups: 3, replicates: 3 },
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

/** Binary outcome vs. two predictors (multiple logistic regression, plan 11). */
const multipleBinary = table(
  ["Title", "Outcome", "Age", "Dose"],
  [
    ["", "0", "22", "0"],
    ["", "0", "25", "0"],
    ["", "0", "28", "1"],
    ["", "1", "31", "0"],
    ["", "0", "35", "1"],
    ["", "1", "38", "1"],
    ["", "0", "42", "0"],
    ["", "1", "45", "1"],
    ["", "1", "49", "1"],
    ["", "0", "53", "0"],
    ["", "1", "57", "1"],
    ["", "1", "61", "1"],
  ],
);

/** Completely separated: Dose predicts the outcome exactly, so glm diverges
 *  and the runner must refuse (same guard as plan 01's logisticSeparated). */
const multipleBinarySeparated = table(
  ["Title", "Outcome", "Age", "Dose"],
  [
    ["", "0", "22", "0"],
    ["", "0", "25", "0"],
    ["", "0", "28", "0"],
    ["", "0", "31", "0"],
    ["", "0", "35", "0"],
    ["", "0", "38", "0"],
    ["", "1", "42", "1"],
    ["", "1", "45", "1"],
    ["", "1", "49", "1"],
    ["", "1", "53", "1"],
    ["", "1", "57", "1"],
    ["", "1", "61", "1"],
  ],
);

/** Principal component analysis (plan 21): the plan's 6×3 set. NOTE the
 *  plan's "correlation matrix" values are the COVARIANCE values — confirmed
 *  in WebR prcomp (and an independent NumPy SVD): scale.=TRUE gives sdev
 *  1.7097/0.2535/0.1126, scale.=FALSE gives the plan's 1.2649/0.2172/0.0542.
 *  The correlation case pins the true scale.=TRUE values; the covariance
 *  case pins the plan's numbers. */
const pca = table(
  ["Title", "Var1", "Var2", "Var3"],
  [
    ["", "2.5", "2.4", "1.0"],
    ["", "0.5", "0.7", "0.2"],
    ["", "2.2", "2.9", "1.1"],
    ["", "1.9", "2.2", "0.9"],
    ["", "3.1", "3.0", "1.4"],
    ["", "2.3", "2.7", "1.2"],
  ],
);

/** A constant variable: the correlation matrix cannot standardise it (the
 *  runner must name it), while the covariance matrix runs with it
 *  contributing no variance. */
const pcaConstant = table(
  ["Title", "Var1", "Var2", "Var3"],
  [
    ["", "2.5", "2.4", "1"],
    ["", "0.5", "0.7", "1"],
    ["", "2.2", "2.9", "1"],
    ["", "1.9", "2.2", "1"],
  ],
);

/** Fewer complete rows (2) than variables (3): rank-deficient, one component. */
const pcaFewRows = table(
  ["Title", "Var1", "Var2", "Var3"],
  [
    ["", "2.5", "2.4", "1.0"],
    ["", "0.5", "0.7", "0.2"],
  ],
);

/** Var3 = Var1 + Var2 exactly: perfectly collinear, one zero eigenvalue. */
const pcaCollinear = table(
  ["Title", "Var1", "Var2", "Var3"],
  [
    ["", "1", "2", "3"],
    ["", "2", "1", "3"],
    ["", "3", "3", "6"],
    ["", "4", "2", "6"],
    ["", "5", "4", "9"],
    ["", "6", "3", "9"],
  ],
);

/** Well-behaved counts (Poisson regression, plan 12, Case A): dispersion
 *  ≈ 0.17, so no overdispersion warning is expected. */
const poissonCounts = table(
  ["Title", "Count", "Dose", "Age"],
  [
    ["", "2", "0", "20"],
    ["", "3", "0", "25"],
    ["", "3", "0", "30"],
    ["", "5", "1", "22"],
    ["", "4", "1", "27"],
    ["", "7", "1", "33"],
    ["", "6", "2", "24"],
    ["", "9", "2", "29"],
    ["", "8", "2", "35"],
    ["", "12", "3", "26"],
    ["", "11", "3", "31"],
    ["", "14", "3", "36"],
  ],
);

/** Overdispersed counts (Poisson regression, plan 12, Case B): dispersion
 *  ≈ 9.14 — the standard fit must warn, and the quasi-Poisson refit must
 *  flip the Dose P value with identical coefficients. */
const poissonOverdispersed = table(
  ["Title", "Count", "Dose", "Age"],
  [
    ["", "0", "0", "20"],
    ["", "9", "0", "25"],
    ["", "1", "0", "30"],
    ["", "14", "1", "22"],
    ["", "2", "1", "27"],
    ["", "20", "1", "33"],
    ["", "3", "2", "24"],
    ["", "25", "2", "29"],
    ["", "5", "2", "35"],
    ["", "30", "3", "26"],
    ["", "4", "3", "31"],
    ["", "35", "3", "36"],
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

/** Chi-square test for trend (plan 19): 2 columns × 4 ordered dose groups,
 *  successes x = [2, 5, 9, 14], totals n = [20, 20, 20, 20]. */
const contingencyTrend = table(
  ["Title", "Success", "Failure"],
  [
    ["Dose 1", "2", "18"],
    ["Dose 2", "5", "15"],
    ["Dose 3", "9", "11"],
    ["Dose 4", "14", "6"],
  ],
);
/** The same numbers transposed (2 rows × 4 columns): the trend statistic
 *  must be identical — this catches an orientation bug. */
const contingencyTrendT = table(
  ["Title", "Dose 1", "Dose 2", "Dose 3", "Dose 4"],
  [
    ["Success", "2", "5", "9", "14"],
    ["Failure", "18", "15", "11", "6"],
  ],
);
/** McNemar's test (plan 19): 2×2 paired outcomes — a = both yes (20),
 *  b = yes→no (12), c = no→yes (4), d = both no (30); discordant b + c = 16. */
const mcnemarTable = table(
  ["Title", "Second: Yes", "Second: No"],
  [
    ["First: Yes", "20", "12"],
    ["First: No", "4", "30"],
  ],
);
/** No pair changed: McNemar's test is undefined. */
const mcnemarNoDiscordant = table(
  ["Title", "Second: Yes", "Second: No"],
  [
    ["First: Yes", "10", "0"],
    ["First: No", "0", "10"],
  ],
);
/** A fractional count: counts must be whole numbers. */
const contingencyFractional = table(
  ["Title", "Success", "Failure"],
  [
    ["Dose 1", "2.5", "18"],
    ["Dose 2", "5", "15"],
    ["Dose 3", "9", "11"],
    ["Dose 4", "14", "6"],
  ],
);
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

/** Deming regression (plan 13): the reference case, X = 1..10 with a noisy
 *  near-linear Y; λ = 1 and λ = 0.25 runs below. */
const deming = table(
  ["Title", "X", "Y"],
  [
    ["", "1", "1.4"],
    ["", "2", "1.9"],
    ["", "3", "3.6"],
    ["", "4", "3.8"],
    ["", "5", "5.5"],
    ["", "6", "5.7"],
    ["", "7", "7.4"],
    ["", "8", "7.6"],
    ["", "9", "9.5"],
    ["", "10", "9.8"],
  ],
);

/** X and Y with no covariation (Sxy = 0): the closed form divides by zero. */
const demingNoCovary = table(
  ["Title", "X", "Y"],
  [
    ["", "1", "1"],
    ["", "2", "2"],
    ["", "3", "1"],
    ["", "4", "2"],
    ["", "5", "1"],
  ],
);

/** Too few complete pairs for the jackknife (n = 2). */
const demingTooFew = table(
  ["Title", "X", "Y"],
  [
    ["", "1", "1.4"],
    ["", "2", "1.9"],
  ],
);

/** Constant X / constant Y: no defined slope. */
const demingConstX = table(
  ["Title", "X", "Y"],
  [
    ["", "5", "1.4"],
    ["", "5", "1.9"],
    ["", "5", "3.6"],
    ["", "5", "3.8"],
  ],
);
const demingConstY = table(
  ["Title", "X", "Y"],
  [
    ["", "1", "2"],
    ["", "2", "2"],
    ["", "3", "2"],
    ["", "4", "2"],
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
  // Multiple comparisons completion (plan 25): Šídák, Holm–Šídák and Fisher's
  // LSD on the same table — raw P from pairwise.t.test, adjusted in TS
  // (see disagreements() below); Dunn–Šídák / Dunn–Holm–Šídák likewise.
  ["column", column, "anova", { posthoc: "sidak" }],
  ["column", column, "anova", { posthoc: "holm-sidak" }],
  ["column", column, "anova", { posthoc: "lsd" }],
  ["column", column, "kruskal-wallis", { posthoc: "dunn-sidak" }],
  ["column", column, "kruskal-wallis", { posthoc: "dunn-holm-sidak" }],
  ["column", column, "rm-anova", { posthoc: "sidak" }],
  ["column", column, "rm-anova", { posthoc: "holm-sidak" }],
  ["column", column, "rm-anova", { posthoc: "lsd" }],
  ["column", column, "friedman", { posthoc: "dunn-sidak" }],
  ["column", column, "friedman", { posthoc: "dunn-holm-sidak" }],
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
  // Normality tests (plan 23): all four tests on the n = 25 table (values
  // pinned in the `normality` table comment), SW + DP with lognormality,
  // and the edge cases — DP on the n = 8 `column` table (every column too
  // short: NA rows + note), AD on it (only Control, n = 8, runs), KS on it,
  // and lognormality refused on a table holding 0.
  ["normality", normality, "shapiro-wilk", { test: "shapiro-wilk" }],
  ["normality", normality, "shapiro-wilk", { test: "dagostino-pearson" }],
  ["normality", normality, "shapiro-wilk", { test: "anderson-darling" }],
  ["normality", normality, "shapiro-wilk", { test: "kolmogorov-smirnov" }],
  ["normality", normality, "shapiro-wilk", { test: "shapiro-wilk", lognormal: true }],
  ["normality", normality, "shapiro-wilk", { test: "dagostino-pearson", lognormal: true }],
  ["column", column, "shapiro-wilk", { test: "dagostino-pearson" }],
  ["column", column, "shapiro-wilk", { test: "anderson-darling" }],
  ["column", column, "shapiro-wilk", { test: "kolmogorov-smirnov" }],
  ["normalityNonpositive", normalityNonpositive, "shapiro-wilk", { test: "shapiro-wilk", lognormal: true }],
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
  // Grubbs' test (plan 24): the shared column table (Control flags 30, round
  // 2 clean; Low/High/Sparse clean), the masked column (nothing flagged —
  // see the table note), and the iterating column (45 then 25 with iteration,
  // 45 only without). G/P ground truth is R outliers::grubbs.test
  // (two-sided); the TS-vs-R cross-check is in disagreements() below.
  // High uses [18.2, 19.9, 21.3, 18.8, 20.1, 19.4] (n=6): the table's
  // excluded: ["2,3"] drops the 17.5 cell, and the row-7 High cell is blank.
  ["column", column, "outliers", { method: "grubbs" }],
  ["column", column, "outliers", { method: "grubbs", alpha: 0.05, iterate: false }],
  ["grubbsMasked", grubbsMasked, "outliers", { method: "grubbs" }],
  ["grubbsIterate", grubbsIterate, "outliers", { method: "grubbs" }],
  ["grubbsIterate", grubbsIterate, "outliers", { method: "grubbs", alpha: 0.05, iterate: false }],
  ["xy", xy, "correlation", { method: "pearson", mode: "x-vs-every-y" }],
  ["xy", xy, "correlation", { method: "spearman", mode: "x-vs-every-y" }],
  ["xy", xy, "correlation", { method: "pearson", mode: "two-datasets", datasets: ["Y1", "Y3"] }],
  ["xy", xy, "correlation", { method: "pearson", mode: "matrix" }],
  ["xy", xy, "linear-regression", { forceOrigin: false }],
  ["xy", xy, "linear-regression", { y: "Y2", forceOrigin: false }],
  ["xy", xy, "linear-regression", { y: "Y3", forceOrigin: true }],
  // Deming regression (plan 13): the reference case at λ = 1 and λ = 0.25
  // (the λ-sensitivity check lives in disagreements() below), plus the
  // error paths — λ ≤ 0, no covariation, too few pairs, constant X/Y.
  // Cross-check against deming::deming() is a follow-up, not done here:
  // the closed form is exact for known λ and needs no package — but the
  // λ direction was verified 2026-11-10 against both packages on this
  // table (deming::deming xstd=1, ystd=0.5 and MethComp::Deming sdr=0.5
  // both give slope 0.9813, the closed form at λ = 0.25), so λ is the
  // Y-error variance over the X-error variance; see the spec's header
  // comment for why the plan's "λ = error in X ÷ error in Y" prose and
  // its "slope(λ=0.25) between slope(λ=1) and OLS" assertion are inverted.
  ["deming", deming, "deming-regression", { y: "Y", lambda: 1 }],
  ["deming", deming, "deming-regression", { y: "Y", lambda: 0.25 }],
  ["deming", deming, "deming-regression", { y: "Y", lambda: 0 }],
  ["demingNoCovary", demingNoCovary, "deming-regression", { y: "Y", lambda: 1 }],
  ["demingTooFew", demingTooFew, "deming-regression", { y: "Y", lambda: 1 }],
  ["demingConstX", demingConstX, "deming-regression", { y: "Y", lambda: 1 }],
  ["demingConstY", demingConstY, "deming-regression", { y: "Y", lambda: 1 }],
  ["xy", xy, "area-under-curve", { baseline: 0 }],
  ["xy", xy, "area-under-curve", { baseline: 2 }],
  ["xy", xy, "nonlinear-regression", { model: "line" }],
  ["xy", xy, "nonlinear-regression", { y: "Y3", model: "quadratic" }],
  ["xy", xy, "nonlinear-regression", { y: "Y1", model: "cubic" }],
  // Lines & polynomials completion (plan 29): quartic R² = 0.9990, RSS =
  // 0.1940; quintic R² = 0.9992, RSS = 0.1526 — the plan's NumPy values,
  // confirmed independently here (polyfit agrees to 4 dp). Segmental:
  // the plan's hinge-RSS anchor (≈ 0.128) was two INDEPENDENT lines and
  // is unattainable under continuity — the profile minimum over X0 is
  // 0.2225 (verified in R), and the profile fit lands at X0 ≈ 3.0 with
  // RSS ≈ 0.2843, R² ≈ 0.9986, slopes 1.953 / 2.045 (also verified in
  // R); those are the values pinned below. The nls() fit the plan
  // specified does not converge on this data (see nonlinear-fit.ts).
  ["xy", xy, "nonlinear-regression", { y: "Y1", model: "quartic" }],
  ["xy", xy, "nonlinear-regression", { y: "Y1", model: "quintic" }],
  ["xy", xy, "nonlinear-regression", { y: "Y1", model: "segmental-linear" }],
  ["doseLog", doseLog, "nonlinear-regression", { model: "sigmoidal-4pl-logx" }],
  // Spline and Lowess (plan 15): the Lowess and fixed-spar spline reference
  // runs, the GCV auto-spar run (asserted as the overfit in disagreements()
  // below), and the validation errors.
  ["doseLog", doseLog, "spline-lowess", { y: "Response", method: "lowess", f: 2 / 3 }],
  ["doseLog", doseLog, "spline-lowess", { y: "Response", method: "spline", f: 2 / 3, spar: 0.5 }],
  ["doseLog", doseLog, "spline-lowess", { y: "Response", method: "spline", f: 2 / 3 }],
  ["doseLog", doseLog, "spline-lowess", { y: "Response", method: "lowess", f: 0 }],
  ["doseLog", doseLog, "spline-lowess", { y: "Response", method: "lowess", f: 1.5 }],
  ["doseLog", doseLog, "spline-lowess", { y: "Response", method: "spline", f: 2 / 3, spar: 2 }],
  ["doseLog", doseLog, "spline-lowess", { y: "Response", method: "spline", f: 2 / 3, spar: 0.5, df: 4 }],
  ["smoothTooFew", smoothTooFew, "spline-lowess", { y: "Response", method: "lowess", f: 2 / 3 }],
  ["doseRaw", doseRaw, "nonlinear-regression", { model: "sigmoidal-4pl-x" }],
  ["doseRaw", doseRaw, "nonlinear-regression", { model: "hyperbola" }],
  ["doseRaw", doseRaw, "nonlinear-regression", { model: "semilog-line" }],
  ["doseLog", doseLog, "nonlinear-regression", { model: "agonist-3pl-logx" }],
  ["doseFall", doseFall, "nonlinear-regression", { model: "inhibitor-3pl-logx" }],
  // Binding — Competition (plan 28): Fit Ki on the one-site inhibitor fit
  // ([L] = 1, Kd = 0.5 → Ki = IC50/3), the two-site logx/x fits (with and
  // without Fit Ki), the homologous fit ([L] = 1), and the validation
  // errors — Ki without [L]/Kd, homologous without [L].
  ["doseFall", doseFall, "nonlinear-regression", { model: "inhibitor-3pl-logx", fitKi: true, ligandConcentration: 1, ligandKd: 0.5 }],
  ["competitionTwoSite", competitionTwoSite, "nonlinear-regression", { model: "two-site-competition-logx" }],
  ["competitionTwoSite", competitionTwoSite, "nonlinear-regression", { model: "two-site-competition-logx", fitKi: true, ligandConcentration: 1, ligandKd: 0.5 }],
  ["competitionTwoSiteRaw", competitionTwoSiteRaw, "nonlinear-regression", { model: "two-site-competition-x" }],
  ["competitionHomologous", competitionHomologous, "nonlinear-regression", { model: "homologous-competition-logx", ligandConcentration: 1 }],
  ["doseFall", doseFall, "nonlinear-regression", { model: "inhibitor-3pl-logx", fitKi: true }],
  ["competitionHomologous", competitionHomologous, "nonlinear-regression", { model: "homologous-competition-logx" }],
  ["doseLog", doseLog, "nonlinear-regression", { model: "asymmetric-5pl-logx" }],
  // Nonlinear regression framework (plan 26): model comparison (line vs
  // quadratic — F = 0.6515, P = 0.4562; 4PL vs 3PL — F = 2.0124, P =
  // 0.2058; all verified in R before building), weighting (1/Y² line:
  // intercept 1.0840, slope 1.9730, verified in R), fixed parameters (4PL
  // with HillSlope = 1 is the 3PL: Bottom 1.5916, Top 98.9642, LogEC50
  // −0.8415), bounds (HillSlope in [0, 2] leaves the 4PL unchanged),
  // the global fit on doseTwo (shared LogEC50 + HillSlope by default;
  // shared LogEC50 only), a non-nested comparison (AICc only), and the
  // 1/SD² weights on xyRep.
  ["xy", xy, "nonlinear-regression", { y: "Y1", model: "line", compareModel: "quadratic" }],
  ["xy", xy, "nonlinear-regression", { y: "Y1", model: "line", weights: "1/y2" }],
  ["xy", xy, "linear-regression", { y: "Y1", weights: "1/y2" }],
  ["doseLog", doseLog, "nonlinear-regression", { model: "sigmoidal-4pl-logx", compareModel: "agonist-3pl-logx" }],
  ["doseLog", doseLog, "nonlinear-regression", { model: "sigmoidal-4pl-logx", fixed: { HillSlope: 1 } }],
  ["doseLog", doseLog, "nonlinear-regression", { model: "sigmoidal-4pl-logx", bounds: { HillSlope: [0, 2] } }],
  ["doseTwo", doseTwo, "nonlinear-regression", { y: "Control", model: "sigmoidal-4pl-logx", globalY: ["Treated"] }],
  ["doseTwo", doseTwo, "nonlinear-regression", { y: "Control", model: "sigmoidal-4pl-logx", globalY: ["Treated"], sharedParams: ["LogEC50"] }],
  ["doseRaw", doseRaw, "nonlinear-regression", { model: "sigmoidal-4pl-x", compareModel: "hyperbola" }],
  ["xyRep", xyRep, "nonlinear-regression", { y: "R1", model: "line", weights: "1/sd2" }],
  // Error paths: fixed parameters on a line fit, 1/Y weighting with
  // non-positive Y, and a fixed+bounded contradiction.
  ["xy", xy, "nonlinear-regression", { y: "Y1", model: "line", fixed: { Slope: 2 } }],
  ["xy", xy, "nonlinear-regression", { y: "Y3", model: "line", weights: "1/y" }],
  ["doseLog", doseLog, "nonlinear-regression", { model: "sigmoidal-4pl-logx", fixed: { HillSlope: 1 }, bounds: { HillSlope: [0, 2] } }],
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
  // Enzyme kinetics (plan 09) — noiseless fixtures A/A2/B/C, the noisy
  // CI fixture, and the negative-X / constant-X / too-few-points errors.
  ["enzymeS", enzymeS, "nonlinear-regression", { y: "A", model: "michaelis-menten" }],
  ["enzymeS0", enzymeS0, "nonlinear-regression", { model: "michaelis-menten" }],
  ["enzymeS", enzymeS, "nonlinear-regression", { y: "B", model: "allosteric-sigmoidal" }],
  ["enzymeS", enzymeS, "nonlinear-regression", { y: "C", model: "substrate-inhibition" }],
  ["enzymeNoisy", enzymeNoisy, "nonlinear-regression", { model: "michaelis-menten" }],
  ["enzymeNegX", enzymeNegX, "nonlinear-regression", { model: "michaelis-menten" }],
  ["enzymeConstX", enzymeConstX, "nonlinear-regression", { model: "michaelis-menten" }],
  ["enzymeTooFew", enzymeTooFew, "nonlinear-regression", { model: "michaelis-menten" }],
  // Binding — Saturation / Kinetics (plan 16): the noiseless reference
  // cases (coefficients + derived rows asserted in disagreements() below),
  // the two-series shared-NS fits, the derived-kon run, the
  // association-then-dissociation run, and the validation errors.
  ["bindTotal", bindTotal, "binding-saturation", { model: "one-site-total" }],
  ["bindTwoSite", bindTwoSite, "binding-saturation", { model: "two-site-specific" }],
  ["bindTotalNs", bindTotalNs, "binding-saturation", { y: "Total", y2: "Nonspecific", model: "one-site-total-and-ns" }],
  [
    "bindTwoSiteNs",
    bindTwoSiteNs,
    "binding-saturation",
    { y: "Total", y2: "Nonspecific", model: "two-site-total-and-ns" },
  ],
  ["bindTwoSiteFew", bindTwoSiteFew, "binding-saturation", { model: "two-site-specific" }],
  ["bindNegX", bindNegX, "binding-saturation", { model: "one-site-total" }],
  [
    "bindTotalNsFew",
    bindTotalNsFew,
    "binding-saturation",
    { y: "Total", y2: "Nonspecific", model: "one-site-total-and-ns" },
  ],
  ["bindKinetics", bindKinetics, "binding-kinetics", { y: "Assoc", model: "association-one-phase" }],
  ["bindKinetics", bindKinetics, "binding-kinetics", { y: "Dissoc", model: "dissociation-one-phase" }],
  ["bindKinetics", bindKinetics, "binding-kinetics", { y: "TwoPhase", model: "association-two-phase" }],
  ["bindKinetics", bindKinetics, "binding-kinetics", { y: "Dissoc2", model: "dissociation-two-phase" }],
  [
    "bindKinetics",
    bindKinetics,
    "binding-kinetics",
    { y: "Assoc", model: "association-one-phase", ligandConcentration: 10, koff: 0.3 },
  ],
  [
    "bindKinetics",
    bindKinetics,
    "binding-kinetics",
    { y: "Assoc", model: "association-one-phase", ligandConcentration: 10 },
  ],
  [
    "bindAssocThenDissoc",
    bindAssocThenDissoc,
    "binding-kinetics",
    { model: "association-then-dissociation", hotNM: 1, time0: 10 },
  ],
  [
    "bindAssocThenDissoc",
    bindAssocThenDissoc,
    "binding-kinetics",
    { model: "association-then-dissociation", hotNM: 1, time0: 100 },
  ],
  // Enzyme kinetics — Inhibition (plan 17): the noiseless reference cases
  // (coefficients + AICc + notes asserted in disagreements() below), the
  // mixed-on-competitive run (Alpha unidentifiable there — only Vmax/Km/Ki
  // asserted), the Morrison run with and without [S]/Km, and the validation
  // errors (no uninhibited series; Morrison with [S] but no Km).
  [
    "enzMixed",
    enzMixed,
    "enzyme-inhibition",
    { model: "mixed", inhibitorConcentrations: { "0 nM": 0, "5 nM": 5, "20 nM": 20 } },
  ],
  [
    "enzCompetitive",
    enzCompetitive,
    "enzyme-inhibition",
    { model: "competitive", inhibitorConcentrations: { "0 nM": 0, "5 nM": 5, "20 nM": 20 } },
  ],
  [
    "enzCompetitive",
    enzCompetitive,
    "enzyme-inhibition",
    { model: "mixed", inhibitorConcentrations: { "0 nM": 0, "5 nM": 5, "20 nM": 20 } },
  ],
  ["enzMorrison", enzMorrison, "enzyme-inhibition", { model: "morrison", enzymeConcentration: 5 }],
  [
    "enzMorrison",
    enzMorrison,
    "enzyme-inhibition",
    { model: "morrison", enzymeConcentration: 5, substrateConcentration: 10, kmForMorrison: 10 },
  ],
  [
    "enzNoZero",
    enzNoZero,
    "enzyme-inhibition",
    { model: "mixed", inhibitorConcentrations: { "5 nM": 5, "20 nM": 20 } },
  ],
  [
    "enzMorrison",
    enzMorrison,
    "enzyme-inhibition",
    { model: "morrison", enzymeConcentration: 5, substrateConcentration: 10 },
  ],
  // The wizard always sets `y` explicitly (a string[]), so the mixed fit is
  // pinned with it too — the shared runAnalysis pre-flight once treated it
  // as one comma-joined column name and every wizard-created fit failed.
  [
    "enzMixed",
    enzMixed,
    "enzyme-inhibition",
    { model: "mixed", y: ["0 nM", "5 nM", "20 nM"], inhibitorConcentrations: { "0 nM": 0, "5 nM": 5, "20 nM": 20 } },
  ],
  // Dose-response — Special (plan 18): the noiseless reference cases
  // (coefficients + dose ratios + notes asserted in disagreements()
  // below), the pA2 unit-trap case (B in nM → pA2 = −1), the title-parsed
  // run (B from the "0 M" / "1e-8 M" / "1e-7 M" titles), and the
  // validation errors (one series; first series not the control).
  [
    "schild",
    schild,
    "dose-response-special",
    { model: "schild-slope-1", antagonistConcentrations: { "0 M": 0, "1e-8 M": 1e-8, "1e-7 M": 1e-7 } },
  ],
  [
    "schild",
    schild,
    "dose-response-special",
    { model: "schild", antagonistConcentrations: { "0 M": 0, "1e-8 M": 1e-8, "1e-7 M": 1e-7 } },
  ],
  [
    "schild",
    schild,
    "dose-response-special",
    { model: "schild-slope-1", antagonistConcentrations: { "0 M": 0, "1e-8 M": 10, "1e-7 M": 100 }, bUnits: "nM" },
  ],
  ["schild", schild, "dose-response-special", { model: "schild-slope-1" }],
  [
    "ec50shift",
    ec50shift,
    "dose-response-special",
    { model: "ec50-shift", antagonistConcentrations: { "0 nM": 0, "10 nM": 10 }, bUnits: "nM" },
  ],
  ["operational", operational, "dose-response-special", { model: "operational-partial" }],
  [
    "schild",
    schild,
    "dose-response-special",
    { model: "schild-slope-1", ys: ["0 M"], antagonistConcentrations: { "0 M": 0 } },
  ],
  [
    "schild",
    schild,
    "dose-response-special",
    { model: "schild-slope-1", antagonistConcentrations: { "0 M": 1e-8, "1e-8 M": 0, "1e-7 M": 1e-7 } },
  ],
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
  // Cox proportional-hazards regression (plan 10): the reference run (Efron
  // default), the defaults (same numbers), the single-covariate run, the
  // Breslow run (identical here — no tied event times, see disagreements()),
  // and the error paths (all-censored, bad status code, zero time, no
  // covariates).
  ["coxTable", coxTable, "cox-proportional-hazards", { time: "Time", status: "Status", covariates: ["Trt", "Age"] }],
  ["coxTable", coxTable, "cox-proportional-hazards", {}],
  ["coxTable", coxTable, "cox-proportional-hazards", { time: "Time", status: "Status", covariates: ["Trt"] }],
  [
    "coxTable",
    coxTable,
    "cox-proportional-hazards",
    { time: "Time", status: "Status", covariates: ["Trt", "Age"], ties: "breslow" },
  ],
  [
    "coxAllCensored",
    coxAllCensored,
    "cox-proportional-hazards",
    { time: "Time", status: "Status", covariates: ["Trt", "Age"] },
  ],
  [
    "coxBadStatus",
    coxBadStatus,
    "cox-proportional-hazards",
    { time: "Time", status: "Status", covariates: ["Trt", "Age"] },
  ],
  [
    "coxZeroTime",
    coxZeroTime,
    "cox-proportional-hazards",
    { time: "Time", status: "Status", covariates: ["Trt", "Age"] },
  ],
  ["coxTable", coxTable, "cox-proportional-hazards", { time: "Time", status: "Status", covariates: [] }],
  // Mixed-effects model (plan 20): the balanced Column case, the one-missing-cell
  // case (23 observations, no subject dropped), the single-observation case,
  // the 2-subject error, and the Grouped case (groups × rows with interaction,
  // on the existing `grouped` table — 44 observations, 3 subjects).
  ["mixedBalanced", mixedBalanced, "mixed-effects", mixedColumnParams],
  ["mixedMissing", mixedMissing, "mixed-effects", mixedColumnParams],
  ["mixedSingleObs", mixedSingleObs, "mixed-effects", mixedColumnParams],
  ["mixedTwoSubjects", mixedTwoSubjects, "mixed-effects", mixedTwoSubjectsParams],
  [
    "grouped",
    grouped,
    "mixed-effects",
    { subjectId: "replicate", randomStructure: "intercept", fixedFactors: ["Group", "Row"], interaction: true },
  ],
  ["grouped", grouped, "two-way-anova", { design: "ordinary", posthoc: "none", posthocTarget: "groups" }],
  ["grouped", grouped, "two-way-anova", { design: "ordinary", posthoc: "tukey", posthocTarget: "groups" }],
  ["grouped", grouped, "two-way-anova", { design: "ordinary", posthoc: "bonferroni", posthocTarget: "rows" }],
  // Multiple comparisons completion (plan 25): per-family Šídák / Holm–Šídák /
  // LSD, both targets, plus the no-sphericity corrected path.
  ["grouped", grouped, "two-way-anova", { design: "ordinary", posthoc: "sidak", posthocTarget: "groups" }],
  ["grouped", grouped, "two-way-anova", { design: "ordinary", posthoc: "holm-sidak", posthocTarget: "rows" }],
  ["grouped", grouped, "two-way-anova", { design: "ordinary", posthoc: "lsd", posthocTarget: "groups" }],
  [
    "grouped",
    grouped,
    "two-way-anova",
    { design: "repeated-measures", posthoc: "sidak", posthocTarget: "groups", sphericity: false },
  ],
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
  // Nested t test and nested one-way ANOVA (plan 14): the tests run on
  // subcolumn MEANS, one value per animal/subject — the naive test on all 18
  // raw values would give a far smaller P, so these entries assert the
  // means-based values (t = 6.2610, F = 60.7778) and must not be "corrected"
  // to the raw-values version. The t test runs on Control+Treated only, via
  // `sets`; the last three are the error paths (wrong group count) and the
  // empty-subgroup drop.
  ["nested3", nested3, "nested-t-test", { sets: ["Control", "Treated"] }],
  ["nested3", nested3, "nested-anova", { posthoc: "none" }],
  ["nested3", nested3, "nested-anova", { posthoc: "tukey" }],
  ["nested3", nested3, "nested-anova", { posthoc: "bonferroni" }],
  ["nested3", nested3, "nested-t-test", {}],
  ["nested2", nested2, "nested-anova", { posthoc: "none" }],
  ["nestedDrop", nestedDrop, "nested-t-test", {}],
  ["multiple", multiple, "correlation-matrix", { method: "pearson" }],
  ["multiple", multiple, "correlation-matrix", { method: "spearman" }],
  ["multiple", multiple, "multiple-regression", { dependent: "Weight" }],
  ["multiple", multiple, "multiple-regression", { dependent: "Weight", predictors: ["Height", "Age"] }],
  ["multiple", multiple, "descriptive-statistics"],
  ["multiple", multiple, "outliers", { q: 1 }],
  // Multiple logistic regression (plan 11): explicit predictors, then the
  // predictors-omitted run (every other variable — same result), then the
  // separated table, which must error rather than publish absurd odds ratios.
  [
    "multipleBinary",
    multipleBinary,
    "multiple-logistic-regression",
    { dependent: "Outcome", predictors: ["Age", "Dose"] },
  ],
  ["multipleBinary", multipleBinary, "multiple-logistic-regression", { dependent: "Outcome" }],
  [
    "multipleBinarySeparated",
    multipleBinarySeparated,
    "multiple-logistic-regression",
    { dependent: "Outcome", predictors: ["Age", "Dose"] },
  ],
  // Poisson regression (plan 12): well-behaved counts, overdispersed counts,
  // and the overdispersed table refit as quasi-Poisson.
  ["poissonCounts", poissonCounts, "poisson-regression", { dependent: "Count", predictors: ["Dose", "Age"] }],
  [
    "poissonOverdispersed",
    poissonOverdispersed,
    "poisson-regression",
    { dependent: "Count", predictors: ["Dose", "Age"] },
  ],
  [
    "poissonOverdispersed",
    poissonOverdispersed,
    "poisson-regression",
    { dependent: "Count", predictors: ["Dose", "Age"], quasi: true },
  ],
  // Principal component analysis (plan 21): the correlation run (default),
  // the no-params run (same numbers), the covariance run (the plan's
  // numbers — see the `pca` table note), the first-two-components run, the
  // over-asked run (clamped to 3, noted), and the edge cases (constant
  // variable, too few rows, perfectly collinear variables).
  ["pca", pca, "principal-component-analysis", { scale: "correlation" }],
  ["pca", pca, "principal-component-analysis", {}],
  ["pca", pca, "principal-component-analysis", { scale: "covariance" }],
  ["pca", pca, "principal-component-analysis", { scale: "correlation", components: 2 }],
  ["pca", pca, "principal-component-analysis", { scale: "correlation", components: 9 }],
  ["pcaConstant", pcaConstant, "principal-component-analysis", { scale: "correlation" }],
  ["pcaConstant", pcaConstant, "principal-component-analysis", { scale: "covariance" }],
  ["pcaFewRows", pcaFewRows, "principal-component-analysis", { scale: "correlation" }],
  ["pcaCollinear", pcaCollinear, "principal-component-analysis", { scale: "correlation" }],
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
  // Chi-square test for trend + McNemar's test (plan 19): the trend run
  // (ordered, equally spaced), the same table with the trend unconfirmed
  // and with no params (no trend rows — assert the absence, not just the
  // values), the transposed orientation (same trend statistic), McNemar
  // with the correction on (default) and off, and the error paths (3×3
  // table, no discordant pairs, fractional count).
  ["contingencyTrend", contingencyTrend, "chi-square", { trendOrdered: true }],
  ["contingencyTrend", contingencyTrend, "chi-square", { trendOrdered: false }],
  ["contingencyTrend", contingencyTrend, "chi-square"],
  ["contingencyTrendT", contingencyTrendT, "chi-square", { trendOrdered: true }],
  ["mcnemarTable", mcnemarTable, "mcnemar"],
  ["mcnemarTable", mcnemarTable, "mcnemar", { continuityCorrection: false }],
  ["contingency3", contingency3, "mcnemar"],
  ["mcnemarNoDiscordant", mcnemarNoDiscordant, "mcnemar"],
  ["contingencyFractional", contingencyFractional, "chi-square", { trendOrdered: true }],
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
  // Simulate data + Monte Carlo (plan 22): the literal simulated table's
  // descriptives; the power case (5,000 repeats — the plan's 10,000-repeat
  // case at ~29 ms per-repeat round-trip would take ~5 minutes, so the
  // in-R loop runs it in ~21 s; the power is checked against the analytic
  // 0.8015 in disagreements() below); a small one-sample-t case; and a
  // 200-repeat linear-regression slope case on the XY table.
  ["simulated", simulated, "descriptive-statistics"],
  [
    "mcPower",
    mcPower,
    "monte-carlo",
    {
      targetAnalysis: "compare-two-groups",
      summaryStatistic: "P value",
      repeats: 5000,
      seed: 42,
      groupMeans: { A: 0, B: 0.5 },
      groupSds: { A: 1, B: 1 },
      equalVariance: true,
    },
  ],
  [
    "mcPower",
    mcPower,
    "monte-carlo",
    {
      targetAnalysis: "one-sample-t",
      summaryStatistic: "P value",
      repeats: 200,
      seed: 42,
      groupMeans: { A: 0 },
      groupSds: { A: 1 },
      hypotheticalValue: 0,
    },
  ],
  [
    "xy",
    xy,
    "monte-carlo",
    {
      targetAnalysis: "linear-regression",
      summaryStatistic: "Slope",
      repeats: 200,
      seed: 42,
      groupMeans: { Y1: 5 },
      groupSds: { Y1: 2 },
      y: "Y1",
    },
  ],
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
  ["schild", schild, "schild-plot"],
  ["doseLog", doseLog, "smooth-curve"],
  ["logistic", logistic, "logistic-curve"],
  ["blandAltman", blandAltman, "bland-altman"],
  ["rocTable", rocTable, "roc-curve"],
  ["freqCol", freqCol, "histogram"],
  ["survival", survivalTable, "survival"],
  ["freireich", freireich, "survival", { survivalShowBand: true }],
  ["coxTable", coxTable, "forest-plot"],
  ["grouped", grouped, "grouped-scatter"],
  ["grouped", grouped, "grouped-bars", { groupLayout: "separated" }],
  ["grouped", grouped, "grouped-lines"],
  ["grouped", grouped, "grouped-stacked"],
  ["grouped", grouped, "grouped-hbars", { center: "median" }],
  ["grouped", grouped, "heatmap", { center: "median", heatmapShowValues: true }],
  ["grouped", grouped, "grouped-box", { showPoints: true }],
  ["groupedViolin", grouped, "grouped-box", { kind: "violin", groupLayout: "separated" }],
  // A nested table's grouped-family graphs: one series per group across the rows.
  ["nested3", nested3, "grouped-bars"],
  ["nested3", nested3, "grouped-scatter"],
  ["nested3", nested3, "grouped-lines"],
  ["multiple", multiple, "heatmap"],
  ["multiple", multiple, "xy-scatter", { xVariable: "Height", yVariable: "Weight" }],
  ["poissonCounts", poissonCounts, "observed-fitted"],
  ["pca", pca, "scree-plot"],
  ["pca", pca, "pca-biplot"],
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
  await startR(fileURLToPath(new URL("../node_modules/webr/dist/", import.meta.url)));
  const out: Record<string, unknown> = {};
  for (const [name, data, type, params] of ANALYSES) {
    // Without the bundled repo the Cox and mixed-effects cases cannot run
    // (see the repo note above) — skipped, never silently passed.
    if (!repoReady && (type === "cox-proportional-hazards" || type === "mixed-effects")) continue;
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
  for (const [name, data] of Object.entries({ column, xy, grouped, twoGroups, multiple, nested3 })) {
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
  // Deming regression (plan 13): the TS closed form must match the R closed
  // form on the reference table, and λ must run the right way round. The
  // slope decreases monotonically in λ, from the inverse-regression slope
  // (Syy/Sxy, the λ → 0 limit) toward the OLS slope (the λ → ∞ limit) — so
  // slope(λ=0.25) sits between slope(λ=1) and the inverse slope, and
  // slope(λ=4) between slope(λ=1) and OLS. (The plan's "slope(λ=0.25)
  // between slope(λ=1) and OLS" is inverted: 0.9813 > 0.9764 > 0.9685. A
  // λ-inversion bug would reverse this order.)
  const { x: demX, ys: demYs } = splitXY(readTable(deming).columns);
  const demPairs = pairUp(demX!, demYs[0]);
  const demStat = (r: AnalysisResult | { error: string }, label: string) =>
    "error" in r ? null : r.stats.find((s) => s.label === label)?.value;
  const deming1 = await runAnalysis("deming-regression", deming, { y: "Y", lambda: 1 });
  const deming025 = await runAnalysis("deming-regression", deming, { y: "Y", lambda: 0.25 });
  const deming4 = await runAnalysis("deming-regression", deming, { y: "Y", lambda: 4 });
  for (const [r, lam] of [
    [deming1, 1],
    [deming025, 0.25],
    [deming4, 4],
  ] as const) {
    const js = fitDeming(demPairs.x, demPairs.y, lam);
    const rSlope = demStat(r, "Slope");
    const rInt = demStat(r, "Y-intercept");
    if (
      rSlope == null ||
      rInt == null ||
      js == null ||
      Math.abs(rSlope - js.slope) > 1e-9 ||
      Math.abs(rInt - js.intercept) > 1e-9
    )
      out.push(
        `Deming λ=${lam}: graph slope ${js?.slope}, R slope ${rSlope}; graph intercept ${js?.intercept}, R intercept ${rInt}`,
      );
  }
  const s1 = demStat(deming1, "Slope");
  const s025 = demStat(deming025, "Slope");
  const s4 = demStat(deming4, "Slope");
  const sOls = demStat(deming1, "OLS slope");
  const inv = (() => {
    const xb = demPairs.x.reduce((s, v) => s + v, 0) / demPairs.x.length;
    const yb = demPairs.y.reduce((s, v) => s + v, 0) / demPairs.y.length;
    const syy = demPairs.y.reduce((s, v) => s + (v - yb) ** 2, 0);
    const sxy = demPairs.x.reduce((s, v, i) => s + (v - xb) * (demPairs.y[i] - yb), 0);
    return syy / sxy;
  })();
  if (s1 == null || s025 == null || s4 == null || sOls == null || !(s025 > s1 && s1 > s4 && s4 > sOls && s025 < inv))
    out.push(
      `Deming λ-sensitivity: λ=0.25 slope ${s025}, λ=1 slope ${s1}, λ=4 slope ${s4}, OLS slope ${sOls}, inverse slope ${inv}`,
    );
  // The near-perfect line: all three lines nearly coincide, which is the
  // correct behaviour when error is small relative to signal — this catches
  // a sign or λ-inversion bug, which would show up large on the noisy table.
  const cleanX = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const cleanY = [1.1, 2.3, 2.8, 4.2, 4.9, 6.1, 6.8, 8.3, 8.9, 10.2];
  const clean1 = fitDeming(cleanX, cleanY, 1);
  const clean4 = fitDeming(cleanX, cleanY, 4);
  const cleanOls = fitLinear(cleanX, cleanY, false);
  if (!clean1 || Math.abs(clean1.slope - 0.9997) > 1e-3 || Math.abs(clean1.intercept - 0.0619) > 1e-3)
    out.push(`Deming clean line λ=1: slope ${clean1?.slope}, intercept ${clean1?.intercept}`);
  if (!clean4 || Math.abs(clean4.slope - 0.9984) > 1e-3 || Math.abs(clean4.intercept - 0.0688) > 1e-3)
    out.push(`Deming clean line λ=4: slope ${clean4?.slope}, intercept ${clean4?.intercept}`);
  if (!cleanOls || Math.abs(cleanOls.slope - 0.9976) > 1e-3 || Math.abs(cleanOls.intercept - 0.0733) > 1e-3)
    out.push(`Deming clean line OLS: slope ${cleanOls?.slope}, intercept ${cleanOls?.intercept}`);
  // The overlay itself: the xy-scatter of the reference table plus a linked
  // Deming analysis draws a solid Deming line and a dashed OLS line, with
  // the equations named.
  const demFig = GRAPHS["xy-scatter"].build(
    plotColumns(readTable(deming), "xy-scatter", newGraphOptions("xy-scatter"), "xy"),
    newGraphOptions("xy-scatter"),
    paintOf(newGraphOptions("xy-scatter"), 1),
    readTable(deming).titles,
  );
  addDeming(
    demFig,
    plotColumns(readTable(deming), "xy-scatter", newGraphOptions("xy-scatter"), "xy"),
    newGraphOptions("xy-scatter"),
    { y: "Y", lambda: 1 },
    paintOf(newGraphOptions("xy-scatter"), 1),
  );
  const demTraces = demFig.data as { x?: number[]; y?: number[]; line?: { dash?: string }; mode?: string }[];
  if (
    demTraces.length !== 3 ||
    demTraces[0]?.line?.dash !== "dash" ||
    demTraces[1]?.line?.dash !== undefined ||
    demTraces[0]?.x?.length !== 2 ||
    demTraces[1]?.x?.length !== 2
  )
    out.push(
      `Deming overlay traces: ${JSON.stringify(demTraces.map((t) => ({ mode: t.mode, dash: t.line?.dash, n: t.x?.length })))}`,
    );
  const demNote = (demFig.layout.annotations as { text?: string }[] | undefined)?.find((a) =>
    a.text?.includes("Deming:"),
  );
  if (!demNote) out.push("Deming overlay draws no equation note");
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
  // Grubbs' test (plan 24): the TypeScript G and P must match R's t tail on
  // the reference table — G from R's mean/SD, P from 2n × pt(−t, n−2) with
  // t² = n(n−2)G²/((n−1)² − nG²). The formula itself was verified against
  // outliers::grubbs.test on desktop R 4.3.3 (G and P agree to ~1e-7 on
  // every reference column; the critical values match qgrubbs(0.975, n)).
  const grubbs = await runAnalysis("outliers", column, { method: "grubbs" });
  if ("error" in grubbs) out.push(`Grubbs on the column table: ${grubbs.error}`);
  else {
    const gStat = (label: string) => grubbs.stats.find((s) => s.label === label)?.value ?? null;
    const r = await evalNamedVector(
      `G<-list(${readTable(column).numeric.map((c) => rVec(c.values)).join(",")});` +
        `c(unlist(lapply(seq_along(G),function(i){x<-G[[i]];n<-length(x);m<-mean(x);s<-sd(x);` +
        `g<-max(abs(x-m))/s;t<-sqrt(n*(n-2)*g*g/((n-1)^2-n*g*g));` +
        `setNames(c(g,2*n*pt(-t,n-2)),paste0(c("g_","p_"),i-1))})))`,
    );
    for (const [i, name] of ["Control", "Low", "High", "Sparse"].entries()) {
      if (gStat(`${name} — G`) == null || Math.abs(gStat(`${name} — G`)! - (r[`g_${i}`] ?? NaN)) > 1e-6)
        out.push(`Grubbs G, ${name}: TS ${gStat(`${name} — G`)}, R ${r[`g_${i}`]}`);
      if (gStat(`${name} — P value`) == null || Math.abs(gStat(`${name} — P value`)! - (r[`p_${i}`] ?? NaN)) > 1e-6)
        out.push(`Grubbs P, ${name}: TS ${gStat(`${name} — P value`)}, R ${r[`p_${i}`]}`);
    }
    // Verdicts: Control flags its 30 (and only that), the rest flag nothing;
    // the cleaned mean of Control is 12.1.
    const counts = Object.fromEntries((grubbs.outlierGroups ?? []).map((g) => [g.group, g.outliers]));
    if (JSON.stringify(counts) !== JSON.stringify({ Control: 1, Low: 0, High: 0, Sparse: 0 }))
      out.push(`Grubbs outlier counts: ${JSON.stringify(counts)}`);
    if (!grubbs.notes.includes("Control row 8 (value 30, P = 0.0000)"))
      out.push(`Grubbs notes do not flag Control row 8: ${grubbs.notes}`);
    const controlMean = grubbs.outlierGroups?.find((g) => g.group === "Control")?.mean;
    if (controlMean == null || Math.abs(controlMean - 12.1) > 1e-9)
      out.push(`Grubbs cleaned mean, Control: ${controlMean}, expected 12.1`);
  }
  // The iterating column flags 45 then 25 with iteration, 45 only without;
  // the masked column flags nothing (round 1 is not significant — see the
  // table note).
  const grubbsIt = await runAnalysis("outliers", grubbsIterate, { method: "grubbs" });
  const grubbsItOnce = await runAnalysis("outliers", grubbsIterate, {
    method: "grubbs",
    alpha: 0.05,
    iterate: false,
  });
  const grubbsMaskedRun = await runAnalysis("outliers", grubbsMasked, { method: "grubbs" });
  const flaggedOf = (r: AnalysisResult | { error: string }) =>
    "error" in r ? r.error : (r.outlierGroups ?? []).map((g) => g.outliers).join(",");
  if (flaggedOf(grubbsIt) !== "2") out.push(`Grubbs iterating column: ${flaggedOf(grubbsIt)} outliers, expected 2`);
  if (flaggedOf(grubbsItOnce) !== "1")
    out.push(`Grubbs iterating column, once: ${flaggedOf(grubbsItOnce)} outliers, expected 1`);
  if (flaggedOf(grubbsMaskedRun) !== "0")
    out.push(`Grubbs masked column: ${flaggedOf(grubbsMaskedRun)} outliers, expected 0`);
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
  // Šídák / Holm–Šídák (plan 25) adjust R's raw P values in TypeScript: the LSD
  // run's P values equal pairwise.t.test's unadjusted ones, and the Šídák /
  // Holm–Šídák runs' equal R's own arithmetic on those raw values (m = 6 pairs).
  const lsd = await runAnalysis("anova", column, { posthoc: "lsd" });
  const sid = await runAnalysis("anova", column, { posthoc: "sidak" });
  const hs = await runAnalysis("anova", column, { posthoc: "holm-sidak" });
  const rawP = await evalNamedVector(
    `${groupsSetup(dataGroups(readTable(column).columns))};` +
      `pm<-pairwise.t.test(v,gr,p.adjust.method="none")$p.value;` +
      `raw<-c(pm["G2","G1"],pm["G3","G1"],pm["G4","G1"],pm["G3","G2"],pm["G4","G2"],pm["G4","G3"]);` +
      `o<-order(raw);s<-raw[o];adj<-sapply(1:6,function(i)1-(1-s[i])^(6-i+1));h<-cummax(adj)[order(o)];` +
      `c(${[0, 1, 2, 3, 4, 5].map((n) => `r${n}=raw[${n + 1}],s${n}=1-(1-raw[${n + 1}])^6,h${n}=h[${n + 1}]`).join(",")})`,
  );
  const lsdP = "error" in lsd ? [] : (lsd.comparisons ?? []).map((c) => c.p);
  const sidP = "error" in sid ? [] : (sid.comparisons ?? []).map((c) => c.p);
  const hsP = "error" in hs ? [] : (hs.comparisons ?? []).map((c) => c.p);
  [0, 1, 2, 3, 4, 5].forEach((n) => {
    for (const [ours, theirs, what] of [
      [lsdP[n], rawP[`r${n}`], "LSD"],
      [sidP[n], rawP[`s${n}`], "Šídák"],
      [hsP[n], rawP[`h${n}`], "Holm–Šídák"],
    ] as const)
      if (ours == null || theirs == null || Math.abs(ours - theirs) > 1e-9)
        out.push(`ANOVA ${what} P #${n}: ${ours}, R's: ${theirs}`);
  });
  // Dunn's Šídák (plan 25): the same TS adjustment, raw P from Dunn's z
  // (global ranks, tie-corrected) — checked against R's arithmetic, not the
  // runner's own R code.
  const dunnSid = await runAnalysis("kruskal-wallis", column, { posthoc: "dunn-sidak" });
  const dunnRaw = await evalNamedVector(
    `${groupsSetup(dataGroups(readTable(column).columns))};` +
      `r<-rank(v);Rbar<-tapply(r,gr,mean);N<-length(v);tab<-table(v);` +
      `tiecorr<-sum(tab^3-tab)/(12*(N-1));n<-as.numeric(table(gr));` +
      `raw<-c(${[[1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 4]]
        .map(
          ([i, j]) =>
            `2*(1-pnorm(abs((Rbar[["G${i}"]]-Rbar[["G${j}"]])/sqrt((N*(N+1)/12-tiecorr)*(1/n[${i}]+1/n[${j}])))))`,
        )
        .join(",")});` +
      `c(${[0, 1, 2, 3, 4, 5].map((n) => `s${n}=1-(1-raw[${n + 1}])^6`).join(",")})`,
  );
  const dunnP = "error" in dunnSid ? [] : (dunnSid.comparisons ?? []).map((c) => c.p);
  [0, 1, 2, 3, 4, 5].forEach((n) => {
    const ours = dunnP[n];
    const theirs = dunnRaw[`s${n}`];
    if (ours == null || theirs == null || Math.abs(ours - theirs) > 1e-9)
      out.push(`Dunn–Šídák P #${n}: ${ours}, R's: ${theirs}`);
  });
  // Graphs draw each model's curve as R fits it: its squared distances to the points add up to
  // R's sum of squares.
  // Each model runs on the table (and Y series) it was fitted on: the
  // two-phase/plateau/association models on their expX series, the enzyme
  // models on their enzymeS series — running them on doseLog's log-X (or
  // the wrong series) is a convergence/validation error, not a fit.
  const curveData: Partial<Record<NonlinearModel, [TableData, string?, { ligandConcentration?: number }?]>> = {
    "inhibitor-3pl-logx": [doseFall],
    "two-phase-decay": [expX, "B"],
    "plateau-decay": [expX, "E"],
    "one-phase-association": [expX, "C"],
    "allosteric-sigmoidal": [enzymeS, "B"],
    "substrate-inhibition": [enzymeS, "C"],
    "semilog-line": [doseRaw],
    hyperbola: [doseRaw],
    line: [xy],
    quadratic: [xy],
    cubic: [xy],
    "exponential-growth": [growth],
    "one-phase-decay": [decay],
    "michaelis-menten": [enzyme],
    // Plan 28: the competition models run on their own fixtures — the
    // generic fallback (doseLog/doseRaw) is a rising one-site curve, which
    // a falling two-site curve cannot fit, and the homologous model needs
    // [L] supplied (it errors without it, by design).
    "two-site-competition-logx": [competitionTwoSite],
    "two-site-competition-x": [competitionTwoSiteRaw],
    "homologous-competition-logx": [competitionHomologous, undefined, { ligandConcentration: 1 }],
  };
  for (const [model, [data, y, extra]] of NONLINEAR_MODELS.map(
    (m) => [m, curveData[m] ?? (m.endsWith("-x") ? [doseRaw] : [doseLog])] as const,
  )) {
    const r = await runAnalysis("nonlinear-regression", data, { model, ...(y ? { y } : {}), ...extra });
    if ("error" in r) {
      out.push(`${model}: ${r.error}`);
      continue;
    }
    const { x: dose, ys } = splitXY(readTable(data).columns);
    const pairs = pairUp(dose!, ys.find((c) => c.name === (y ?? ys[0].name))!);
    const ss = pairs.x.reduce(
      (sum, x, i) =>
        positiveXOnly(model) && x <= 0
          ? sum
          : sum + (pairs.y[i] - doseCurveAt(model, r.coefficients!, x, extra?.ligandConcentration)) ** 2,
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
  // Normality tests (plan 23): the TypeScript D'Agostino–Pearson must match
  // the same formulae evaluated in R (there is no R package for the omnibus
  // K2 — `nortest::pearson.test` is a binned chi-square goodness-of-fit
  // test, not this test); Anderson–Darling must match `nortest::ad.test`
  // directly; lognormality must add log rows whose B P value passes (> 0.05,
  // B is lognormal); DP on the short `column` table must say it needs 20
  // values; lognormality on a table holding 0 must refuse with the
  // user-facing error.
  const normCols = readTable(normality).columns.filter((c) => c.values.length > 0);
  const dp = await runAnalysis("shapiro-wilk", normality, { test: "dagostino-pearson" });
  const dpR = await evalNamedVector(
    normCols.map((c, i) => `x${i}<-${rVec(c.values)}`).join(";") +
      `;f<-function(x){n<-length(x);m<-mean(x);d<-x-m;m2<-mean(d^2);m3<-mean(d^3);m4<-mean(d^4);` +
      `g1<-m3/m2^1.5;b2<-m4/m2^2;` +
      `Y<-g1*sqrt((n+1)*(n+3)/(6*(n-2)));be<-3*(n^2+27*n-70)*(n+1)*(n+3)/((n-2)*(n+5)*(n+7)*(n+9));` +
      `W2<--1+sqrt(2*(be-1));de<-1/sqrt(0.5*log(W2));al<-sqrt(2/(W2-1));` +
      `Z1<-de*log(Y/al+sqrt((Y/al)^2+1));` +
      `E<-3*(n-1)/(n+1);va<-24*n*(n-2)*(n-3)/((n+1)^2*(n+3)*(n+5));xx<-(b2-E)/sqrt(va);` +
      `sb<-6*(n^2-5*n+2)/((n+7)*(n+9))*sqrt(6*(n+3)*(n+5)/(n*(n-2)*(n-3)));` +
      `A<-6+8/sb*(2/sb+sqrt(1+4/sb^2));Z2<-(1-2/(9*A)-((1-2/A)/(1+xx*sqrt(2/(A-4))))^(1/3))/sqrt(2/(9*A));` +
      `K2<-Z1^2+Z2^2;c(K2,pchisq(K2,2,lower.tail=FALSE))};` +
      normCols.map((_, i) => `r${i}<-f(x${i})`).join(";") +
      `;c(${normCols.map((_, i) => `k${i}=r${i}[1],p${i}=r${i}[2]`).join(",")})`,
  );
  const dpStat = (label: string) => ("error" in dp ? null : dp.stats.find((s) => s.label === label)?.value);
  normCols.forEach((c, i) => {
    const k2 = dpStat(`${c.name} — K2`);
    const p = dpStat(`${c.name} — P value`);
    if (k2 == null || dpR[`k${i}`] == null || Math.abs(k2 - dpR[`k${i}`]!) > 1e-9)
      out.push(`D'Agostino–Pearson K2 of ${c.name}: TS ${k2}, R formulae ${dpR[`k${i}`]}`);
    if (p == null || dpR[`p${i}`] == null || Math.abs(p - dpR[`p${i}`]!) > 1e-9)
      out.push(`D'Agostino–Pearson P of ${c.name}: TS ${p}, R formulae ${dpR[`p${i}`]}`);
  });
  await ensurePackages(["nortest"]);
  const ad = await runAnalysis("shapiro-wilk", normality, { test: "anderson-darling" });
  const adR = await evalNamedVector(
    normCols.map((c, i) => `a${i}<-nortest::ad.test(${rVec(c.values)})`).join(";") +
      `;c(${normCols.map((_, i) => `s${i}=unname(a${i}$statistic),p${i}=a${i}$p.value`).join(",")})`,
  );
  const adStat = (label: string) => ("error" in ad ? null : ad.stats.find((s) => s.label === label)?.value);
  normCols.forEach((c, i) => {
    const a2 = adStat(`${c.name} — A²`);
    const p = adStat(`${c.name} — P value`);
    if (a2 == null || adR[`s${i}`] == null || Math.abs(a2 - adR[`s${i}`]!) > 1e-9)
      out.push(`Anderson–Darling A² of ${c.name}: runner ${a2}, nortest ${adR[`s${i}`]}`);
    if (p == null || adR[`p${i}`] == null || Math.abs(p - adR[`p${i}`]!) > 1e-9)
      out.push(`Anderson–Darling P of ${c.name}: runner ${p}, nortest ${adR[`p${i}`]}`);
  });
  const logSw = await runAnalysis("shapiro-wilk", normality, { test: "shapiro-wilk", lognormal: true });
  if ("error" in logSw) {
    out.push(`Lognormality SW: ${logSw.error}`);
  } else {
    const logP = logSw.stats.find((s) => s.label === "B — log P value")?.value;
    if (logP == null || logP <= 0.05) out.push(`Lognormality SW log P of B: ${logP}, expected > 0.05`);
    if (!logSw.stats.some((s) => s.label === "A — log W")) out.push("Lognormality SW: no log rows for A");
    if (!logSw.notes.includes("lognormal distribution")) out.push(`Lognormality SW notes: ${logSw.notes}`);
  }
  const dpShort = await runAnalysis("shapiro-wilk", column, { test: "dagostino-pearson" });
  if ("error" in dpShort) {
    out.push(`DP on the short table: ${dpShort.error}`);
  } else {
    if (dpShort.stats.some((s) => s.value != null)) out.push("DP on the short table: a column reported a value");
    if (!dpShort.notes.includes("at least 20 values")) out.push(`DP on the short table notes: ${dpShort.notes}`);
  }
  const logBad = await runAnalysis("shapiro-wilk", normalityNonpositive, { test: "shapiro-wilk", lognormal: true });
  if (!("error" in logBad) || !logBad.error.includes("all values > 0"))
    out.push(`Lognormality on a table holding 0: ${"error" in logBad ? logBad.error : "ran without error"}`);
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
  // Standard-curve interpolation (plan 02, folded into the merged
  // nonlinear runner): the interpolated fit equals the plain
  // nonlinear-regression fit on the same standards (the shared-fit
  // refactor's proof, beyond the unchanged reference entries); the point
  // estimates match the planner's scipy values; the band-inversion CIs sit
  // within 0.02 of the planner's delta-method CIs (cross-check only — the
  // locked values are the band-inversion ones from WebR).
  const interpTable = table(doseLog.columns, [
    ...doseLog.rows.map((r) => r.map((c) => c ?? "")),
    ["Unknown 1", "", "20"],
    ["Unknown 2", "", "50"],
    ["Unknown 3", "", "80"],
  ]);
  const interp = await runAnalysis("nonlinear-regression", interpTable, {
    model: "sigmoidal-4pl-logx",
    interpolate: true,
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
    // Fit rows come out in the same order from both runs — compare by
    // position, not label (the two "95% CI" rows share a label).
    const nonlinRows = nonlin.fit?.rows ?? [];
    if ((interp.fit?.rows ?? []).length !== nonlinRows.length)
      out.push(
        `Interpolation fit rows: ${(interp.fit?.rows ?? []).length}, nonlinear-regression: ${nonlinRows.length}`,
      );
    (interp.fit?.rows ?? []).forEach((row, idx) => {
      const n = nonlinRows[idx];
      // Derived rows carry a "95% CI" range instead of a value — compare
      // whichever the row has (a value row never carries a range, and
      // vice versa); a null bound matches a null bound.
      const sameBound = (a: number | null | undefined, b: number | null | undefined) =>
        (a == null && b == null) || close(a, b, 1e-9);
      const sameRange =
        (row.ranges?.length ?? 0) === (n?.ranges?.length ?? 0) &&
        (row.ranges ?? []).every(
          ([lo, hi], j) => sameBound(lo, n?.ranges?.[j]?.[0]) && sameBound(hi, n?.ranges?.[j]?.[1]),
        );
      if (!n || row.label !== n.label || !sameBound(row.values?.[0], n.values?.[0]) || !sameRange)
        out.push(`Interpolation fit row ${row.label}: ${row.values?.[0]}, nonlinear-regression: ${n?.values?.[0]}`);
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
      const row = interp.interpolated?.find((r) => r.y === y0);
      if (!row || !close(row.x, x, 1e-3)) out.push(`Interpolation Y=${y0}: x=${row?.x}, plan says ${x}`);
    }
    for (const [y0, lo, hi] of planCI) {
      const row = interp.interpolated?.find((r) => r.y === y0);
      if (
        !row ||
        row.low == null ||
        row.high == null ||
        Math.abs(row.low - lo) > 0.02 ||
        Math.abs(row.high - hi) > 0.02
      )
        out.push(`Interpolation Y=${y0}: CI=[${row?.low}, ${row?.high}], delta-method cross-check [${lo}, ${hi}]`);
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
    const xs = (interp.interpolated ?? []).map((r) => r.x);
    if (dashed.length !== 6) out.push(`Dose-response drop-lines: ${dashed.length} dashed traces, expected 6`);
    if (dropMarkers.length !== 1 || JSON.stringify(dropMarkers[0]?.x) !== JSON.stringify(xs))
      out.push(`Dose-response drop-line markers: ${JSON.stringify(dropMarkers[0]?.x)}, expected ${JSON.stringify(xs)}`);
    for (const y0 of [20, 50, 80]) {
      const row = interp.interpolated?.find((r) => r.y === y0);
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
      const got = r.fit?.rows.find((row) => row.label === name)?.values?.[0];
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
        if (rv == null || Math.abs(ts - rv) > 1e-6) out.push(`Exponential overlay at X=${x}: TS ${ts}, R ${rv}`);
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
    if (fitC.equation == null || !fitC.equation.startsWith("Y = ") || !fitC.equation.includes("(1 − exp(−0.3·X))"))
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
        if (rv == null || Math.abs(ts - rv) > 1e-6) out.push(`Exponential growth overlay at X=${x}: TS ${ts}, R ${rv}`);
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
  // Enzyme kinetics (plan 09): the plan's values, by construction
  // (noiseless fixtures) and re-verified against WebR nls() before locking.
  // Tolerances from the plan: parameters 1e-3 relative, R² 1e-6 absolute.
  // On noiseless data the SEs and Wald CIs collapse to 0-width intervals
  // around the estimates — assert the CIs are present and contain the
  // estimate, never a nonzero width; the noisy fixture tests real widths.
  const checkEnzyme = async (
    label: string,
    data: TableData,
    y: string | undefined,
    model: "michaelis-menten" | "allosteric-sigmoidal" | "substrate-inhibition",
    coefs: [string, number][],
    stats: [string, number][],
  ) => {
    const r = await runAnalysis("nonlinear-regression", data, y ? { y, model } : { model });
    if ("error" in r) {
      out.push(`Enzyme ${label}: ${r.error}`);
      return null;
    }
    for (const [term, want] of coefs) {
      const c = r.coefficients?.find((cc) => cc.term === term);
      if (!relClose(c?.estimate, want, 1e-3)) out.push(`Enzyme ${label} ${term}: ${c?.estimate}, plan says ${want}`);
      // CI fields present and containing the estimate (0-width on noiseless data).
      if (c == null || c.low == null || c.high == null)
        out.push(`Enzyme ${label} ${term}: CI missing (low=${c?.low}, high=${c?.high})`);
      else if (c.estimate == null || c.low > c.estimate + 1e-6 || c.high < c.estimate - 1e-6)
        out.push(`Enzyme ${label} ${term}: CI [${c.low}, ${c.high}] does not contain ${c.estimate}`);
    }
    for (const [name, want] of stats) {
      const got = r.fit?.rows.find((row) => row.label === name)?.values?.[0];
      const ok = name === "R squared" ? got != null && Math.abs(got - want) <= 1e-6 : relClose(got, want, 1e-3);
      if (!ok) out.push(`Enzyme ${label} ${name}: ${got}, plan says ${want}`);
    }
    return r;
  };
  const fitMM = await checkEnzyme(
    "Michaelis-Menten",
    enzymeS,
    "A",
    "michaelis-menten",
    [
      ["Vmax", 100],
      ["Km", 5],
    ],
    [
      ["Vmax/Km", 20],
      ["R squared", 1],
    ],
  );
  if (fitMM) {
    if (fitMM.equation !== "Y = 100·X / (5 + X)") out.push(`Enzyme MM equation: ${fitMM.equation}`);
    if (!fitMM.notes.includes("Starting values: Vmax = 100, Km = 5."))
      out.push(`Enzyme MM notes missing starts: ${fitMM.notes}`);
    if (fitMM.notes.includes("X = 0")) out.push(`Enzyme MM notes wrongly mention X = 0: ${fitMM.notes}`);
  }
  const fitMM0 = await checkEnzyme(
    "Michaelis-Menten with vehicle point",
    enzymeS0,
    undefined,
    "michaelis-menten",
    [
      ["Vmax", 100],
      ["Km", 5],
    ],
    [
      ["Vmax/Km", 20],
      ["R squared", 1],
      ["N", 8],
    ],
  );
  if (fitMM0) {
    if (!fitMM0.notes.includes("The X = 0 (vehicle) point is included in the fit"))
      out.push(`Enzyme MM vehicle notes missing X = 0: ${fitMM0.notes}`);
    // The fitted-curve overlay: passes through (0, 0) and (50, ~90.9),
    // monotone increasing, and the TypeScript evaluator matches an
    // independent R evaluation of the fitted formula at the data X to 1e-6.
    const { addDoseCurve, evaluateFittedCurve } = await import("../src/views/graphs/dose-response-curve");
    const mmOpts = { ...newGraphOptions("dose-response"), doseModel: "michaelis-menten" as const, doseY: "Y" };
    const mmColumns = plotColumns(readTable(enzymeS0), "dose-response", mmOpts, "xy");
    const mmFig = GRAPHS["dose-response"].build(mmColumns, mmOpts, paintOf(mmOpts, 1), readTable(enzymeS0).titles);
    addDoseCurve(mmFig, mmColumns, mmOpts, fitMM0, paintOf(mmOpts, 1));
    const mmTraces = mmFig.data as { mode?: string; x?: number[]; y?: number[] }[];
    const mmCurve = mmTraces.find((t) => t.mode === "lines" && t.x?.length === 101);
    if (!mmCurve || mmCurve.x?.[0] !== 0 || mmCurve.y?.[0] == null || Math.abs(mmCurve.y[0]) > 1e-9)
      out.push(`Enzyme MM overlay start: ${JSON.stringify(mmCurve?.y?.slice(0, 1))}, expected 0 at X=0`);
    const mmLastY = mmCurve?.y?.at(-1);
    if (!mmCurve || mmCurve.x?.at(-1) !== 50 || mmLastY == null || Math.abs(mmLastY - 90.9090909091) > 1e-6)
      out.push(`Enzyme MM overlay end: ${mmLastY}, expected ~90.909 at X=50`);
    if (mmCurve?.y?.some((v, i, a) => i > 0 && v <= a[i - 1]!))
      out.push(`Enzyme MM overlay is not monotone increasing`);
    const mmAnns = (mmFig.layout.annotations as { text?: string }[] | undefined) ?? [];
    if (!mmAnns.some((a) => a.text?.includes("Vmax/Km = 20")))
      out.push(`Enzyme MM overlay note missing Vmax/Km: ${JSON.stringify(mmAnns.map((a) => a.text))}`);
    const vmax = fitMM0.coefficients?.find((c) => c.term === "Vmax")?.estimate;
    const km = fitMM0.coefficients?.find((c) => c.term === "Km")?.estimate;
    if (vmax != null && km != null) {
      const xs = [0, 0.5, 1, 2, 5, 10, 20, 50];
      const rY = await evalNamedVector(
        `x<-c(${xs.join(",")});yv<-${vmax.toPrecision(15)}*x/(${km.toPrecision(15)}+x);` +
          `c(${xs.map((_, i) => `y${i}=yv[${i + 1}]`).join(",")})`,
      );
      xs.forEach((x, i) => {
        const ts = evaluateFittedCurve("michaelis-menten", fitMM0.coefficients ?? [], x);
        const rv = rY[`y${i}`];
        if (rv == null || Math.abs(ts - rv) > 1e-6) out.push(`Enzyme MM overlay at X=${x}: TS ${ts}, R ${rv}`);
      });
    }
  }
  await checkEnzyme(
    "allosteric sigmoidal",
    enzymeS,
    "B",
    "allosteric-sigmoidal",
    [
      ["Vmax", 100],
      ["Khalf", 5],
      ["Hill slope", 2],
    ],
    [["R squared", 1]],
  );
  const fitSI = await checkEnzyme(
    "substrate inhibition",
    enzymeS,
    "C",
    "substrate-inhibition",
    [
      ["Vmax", 100],
      ["Km", 2],
      ["Ki", 10],
    ],
    [["R squared", 1]],
  );
  if (fitSI) {
    if (fitSI.equation !== "Y = 100·X / (2 + X + X²/10)")
      out.push(`Enzyme substrate-inhibition equation: ${fitSI.equation}`);
    if (!fitSI.notes.includes("Starting values: Vmax = 78.95, Km = 5, Ki = 50."))
      out.push(`Enzyme substrate-inhibition notes missing starts: ${fitSI.notes}`);
    // The overlay peaks near S ≈ 4.5 (√(Km·Ki) = √20) and decreases
    // thereafter — the key discriminator for substrate inhibition.
    const { addDoseCurve } = await import("../src/views/graphs/dose-response-curve");
    const siOpts = { ...newGraphOptions("dose-response"), doseModel: "substrate-inhibition" as const, doseY: "C" };
    const siColumns = plotColumns(readTable(enzymeS), "dose-response", siOpts, "xy");
    const siFig = GRAPHS["dose-response"].build(siColumns, siOpts, paintOf(siOpts, 1), readTable(enzymeS).titles);
    addDoseCurve(siFig, siColumns, siOpts, fitSI, paintOf(siOpts, 1));
    const siTraces = siFig.data as { mode?: string; x?: number[]; y?: number[] }[];
    const siCurve = siTraces.find((t) => t.mode === "lines" && t.x?.length === 101);
    if (!siCurve || !siCurve.x?.length || !siCurve.y?.length) {
      out.push(`Enzyme substrate-inhibition overlay missing`);
    } else {
      const maxI = siCurve.y.indexOf(Math.max(...siCurve.y));
      const maxX = siCurve.x[maxI];
      if (maxX == null || maxX < 3 || maxX > 6)
        out.push(`Enzyme substrate-inhibition overlay peaks at S=${maxX}, expected between 3 and 6`);
      const after = siCurve.y.slice(maxI + 1);
      if (after.some((v, i, a) => i > 0 && v >= a[i - 1]!))
        out.push(`Enzyme substrate-inhibition overlay does not decrease after its peak`);
    }
  }
  // The noisy fixture: genuinely nonzero SEs and Wald CIs — widths > 0,
  // intervals containing the estimates, parameters still near the truth.
  const fitNoisy = await runAnalysis("nonlinear-regression", enzymeNoisy, { model: "michaelis-menten" });
  if ("error" in fitNoisy) {
    out.push(`Enzyme noisy MM: ${fitNoisy.error}`);
  } else {
    for (const [term, want, wantSe, wantLo, wantHi] of [
      ["Vmax", 100.5333227, 0.7353818191, 98.64296351, 102.4236818],
      ["Km", 5.068291815, 0.1211010523, 4.75699165, 5.37959198],
    ] as const) {
      const c = fitNoisy.coefficients?.find((cc) => cc.term === term);
      if (!relClose(c?.estimate, want, 1e-3)) out.push(`Enzyme noisy MM ${term}: ${c?.estimate}, WebR says ${want}`);
      if (!relClose(c?.stdError, wantSe, 1e-3))
        out.push(`Enzyme noisy MM ${term} SE: ${c?.stdError}, WebR says ${wantSe}`);
      if (c == null || c.low == null || c.high == null || c.high <= c.low)
        out.push(`Enzyme noisy MM ${term}: CI not a nonzero interval (low=${c?.low}, high=${c?.high})`);
      else if (c.estimate == null || c.low > c.estimate || c.high < c.estimate)
        out.push(`Enzyme noisy MM ${term}: CI [${c.low}, ${c.high}] does not contain ${c.estimate}`);
      else {
        if (!relClose(c.low, wantLo, 1e-3))
          out.push(`Enzyme noisy MM ${term} CI low: ${c.low}, WebR says ${wantLo}`);
        if (!relClose(c.high, wantHi, 1e-3))
          out.push(`Enzyme noisy MM ${term} CI high: ${c.high}, WebR says ${wantHi}`);
      }
    }
    const r2 = fitNoisy.fit?.rows.find((row) => row.label === "R squared")?.values?.[0];
    if (r2 == null || r2 < 0.999) out.push(`Enzyme noisy MM R squared: ${r2}, expected ≥ 0.999`);
  }
  // The edge cases are errors, not fits — and the negative-X / constant-X
  // errors must come from the runner before R is called.
  const negX = await runAnalysis("nonlinear-regression", enzymeNegX, { model: "michaelis-menten" });
  if (!("error" in negX) || !negX.error.includes("cannot be negative"))
    out.push(
      `Enzyme negative X: ${"error" in negX ? negX.error : "ran without error"}, expected an error about negative concentrations`,
    );
  const constX = await runAnalysis("nonlinear-regression", enzymeConstX, { model: "michaelis-menten" });
  if (!("error" in constX) || !constX.error.includes("All substrate concentrations are equal"))
    out.push(
      `Enzyme constant X: ${"error" in constX ? constX.error : "ran without error"}, expected an error about equal concentrations`,
    );
  const enzTooFew = await runAnalysis("nonlinear-regression", enzymeTooFew, { model: "michaelis-menten" });
  if (!("error" in enzTooFew) || !enzTooFew.error.includes("need at least 3"))
    out.push(
      `Enzyme too-few: ${"error" in enzTooFew ? enzTooFew.error : "ran without error"}, expected an error naming at least 3 points`,
    );
  // Out of range: Y = 150 is above the curve's Top — a null row, not an error.
  const oorTable = table(doseLog.columns, [
    ...doseLog.rows.map((r) => r.map((c) => c ?? "")),
    ["Unknown 1", "", "20"],
    ["Unknown 2", "", "150"],
  ]);
  const oor = await runAnalysis("nonlinear-regression", oorTable, {
    model: "sigmoidal-4pl-logx",
    interpolate: true,
  });
  if ("error" in oor) {
    out.push(`Standard-curve interpolation out-of-range: ${oor.error}`);
  } else {
    const row150 = oor.interpolated?.find((r) => r.y === 150);
    const row20 = oor.interpolated?.find((r) => r.y === 20);
    if (!row150 || row150.x !== null) out.push(`Interpolation Y=150: x=${row150?.x}, expected null`);
    if (!row20 || row20.x == null) out.push(`Interpolation Y=150 run: Y=20 row missing: ${JSON.stringify(row20)}`);
    if (!oor.notes.includes("never reaches that Y"))
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
  // Cox proportional-hazards regression (plan 10): the plan's Breslow values,
  // computed twice independently in Python (NumPy Newton–Raphson on the Cox
  // partial likelihood; scipy BFGS maximisation — agreed to 6 decimals).
  // Tolerances (plan): β 1e-3, HR 1e-3 relative, CIs 1e-2 relative, test
  // statistics 1e-2 relative, concordance 1e-3. Two plan values do NOT
  // survive the WebR check and are recorded here, not forced: the plan's
  // prose says 13 events / 3 censored, but its own rows hold 12 events / 4
  // censored; and its concordance 0.6559 (61/93 comparable pairs) counts the
  // tied-time pair differently from survival::concordance, which gives
  // 0.6526 (62/95) — the WebR value is pinned in reference.json and asserted
  // below. Efron (the default) agrees with Breslow exactly on this fixture:
  // the tied time 12 holds one event and one censored subject, so there is
  // no tied event time and the Efron correction never engages.
  if (repoReady) {
    const coxStat = (r: AnalysisResult, label: string) => r.stats.find((s) => s.label === label)?.value;
    const coxCoef = (r: AnalysisResult, term: string) => r.coefficients?.find((c) => c.term === term);
    const close = (got: number | null | undefined, want: number, tol: number, label: string) => {
      if (got == null || Math.abs(got - want) > tol) out.push(`Cox ${label}: ${got}, plan says ${want}`);
    };
    const rel = (got: number | null | undefined, want: number, relTol: number, label: string) => {
      if (got == null || Math.abs(got - want) > relTol * Math.abs(want))
        out.push(`Cox ${label}: ${got}, plan says ${want}`);
    };
    // Case A — two covariates (Trt + Age), Breslow ties.
    const coxA = await runAnalysis("cox-proportional-hazards", coxTable, {
      time: "Time",
      status: "Status",
      covariates: ["Trt", "Age"],
      ties: "breslow",
    });
    if ("error" in coxA) {
      out.push(`Cox case A: ${coxA.error}`);
    } else {
      const trt = coxCoef(coxA, "Trt");
      const age = coxCoef(coxA, "Age");
      close(trt?.estimate, -0.9859, 1e-3, "A β_Trt");
      close(trt?.stdError, 0.6567, 1e-3, "A SE_Trt");
      rel(trt?.hazardRatio, 0.3731, 1e-3, "A HR_Trt");
      rel(trt?.low, 0.103, 1e-2, "A HR_Trt CI low");
      rel(trt?.high, 1.3516, 1e-2, "A HR_Trt CI high");
      close(trt?.t, -1.501, 1e-3, "A z_Trt");
      close(trt?.p, 0.1333, 1e-3, "A p_Trt");
      close(age?.estimate, -0.0351, 1e-3, "A β_Age");
      close(age?.stdError, 0.0598, 1e-3, "A SE_Age");
      rel(age?.hazardRatio, 0.9655, 1e-3, "A HR_Age");
      rel(age?.low, 0.8587, 1e-2, "A HR_Age CI low");
      rel(age?.high, 1.0857, 1e-2, "A HR_Age CI high");
      close(age?.t, -0.586, 1e-3, "A z_Age");
      close(age?.p, 0.5578, 1e-3, "A p_Age");
      rel(coxStat(coxA, "Likelihood ratio chi-square"), 2.724, 1e-2, "A LR χ²");
      close(coxStat(coxA, "Likelihood ratio df"), 2, 0, "A LR df");
      rel(coxStat(coxA, "Likelihood ratio P value"), 0.2561, 1e-2, "A LR p");
      rel(coxStat(coxA, "Score (log-rank) chi-square"), 2.8128, 1e-2, "A score χ²");
      close(coxStat(coxA, "Score (log-rank) df"), 2, 0, "A score df");
      rel(coxStat(coxA, "Score (log-rank) P value"), 0.245, 1e-2, "A score p");
      close(coxStat(coxA, "Concordance"), 0.6526, 1e-3, "A concordance (WebR; plan says 0.6559)");
      close(coxStat(coxA, "Number of events"), 12, 0, "A events (plan prose says 13)");
      close(coxStat(coxA, "Number censored"), 4, 0, "A censored (plan prose says 3)");
      if (!coxA.notes.includes("Log partial likelihood -22.18 (vs -23.54 at β = 0)"))
        out.push(`Cox A notes: log partial likelihood line missing — ${coxA.notes}`);
      if (!coxA.notes.includes("Ties handled by the Breslow method")) out.push(`Cox A notes: tie method missing`);
      if (!coxA.notes.includes("Proportional-hazards assumption not tested"))
        out.push(`Cox A notes: PH-assumption notice missing`);
      if (!coxA.notes.includes("fewer than 10 per covariate"))
        out.push(`Cox A notes: events-per-covariate warning missing`);
      if (coxA.statisticLabel !== "z") out.push(`Cox A statistic label: ${coxA.statisticLabel}, expected "z"`);
    }
    // Case A, Efron (the default): identical numbers on this fixture.
    const coxAEfron = await runAnalysis("cox-proportional-hazards", coxTable, {
      time: "Time",
      status: "Status",
      covariates: ["Trt", "Age"],
    });
    if ("error" in coxAEfron) {
      out.push(`Cox case A (Efron): ${coxAEfron.error}`);
    } else if (!("error" in coxA)) {
      for (const term of ["Trt", "Age"]) {
        const e = coxCoef(coxAEfron, term);
        const b = coxCoef(coxA, term);
        if (e?.estimate == null || b?.estimate == null || Math.abs(e.estimate - b.estimate) > 1e-9)
          out.push(`Cox Efron vs Breslow β_${term}: ${e?.estimate}, Breslow: ${b?.estimate}`);
      }
    }
    // The defaults (no params) give the same numbers as the explicit run.
    const coxDef = await runAnalysis("cox-proportional-hazards", coxTable, {});
    if ("error" in coxDef) {
      out.push(`Cox defaults: ${coxDef.error}`);
    } else if (!("error" in coxA)) {
      for (const s of coxA.stats) {
        const got = coxStat(coxDef, s.label);
        if (got !== s.value) out.push(`Cox defaults ${s.label}: ${got}, explicit run: ${s.value}`);
      }
    }
    // Case B — single covariate (Trt only), Breslow ties.
    const coxB = await runAnalysis("cox-proportional-hazards", coxTable, {
      time: "Time",
      status: "Status",
      covariates: ["Trt"],
      ties: "breslow",
    });
    if ("error" in coxB) {
      out.push(`Cox case B: ${coxB.error}`);
    } else {
      const trt = coxCoef(coxB, "Trt");
      close(trt?.estimate, -1.0018, 1e-3, "B β_Trt");
      close(trt?.stdError, 0.6593, 1e-3, "B SE_Trt");
      rel(trt?.hazardRatio, 0.3672, 1e-3, "B HR_Trt");
      rel(trt?.low, 0.1009, 1e-2, "B HR_Trt CI low");
      rel(trt?.high, 1.3369, 1e-2, "B HR_Trt CI high");
      rel(coxStat(coxB, "Likelihood ratio chi-square"), 2.3715, 1e-2, "B LR χ²");
      close(coxStat(coxB, "Likelihood ratio df"), 1, 0, "B LR df");
      rel(coxStat(coxB, "Likelihood ratio P value"), 0.1236, 1e-2, "B LR p");
    }
    // Case C — error paths (assert the error strings, no numeric assertions).
    const coxErr = async (data: TableData, params: AnalysisParams, want: string, label: string) => {
      const r = await runAnalysis("cox-proportional-hazards", data, params);
      if (!("error" in r) || !r.error.includes(want))
        out.push(`Cox ${label}: ${"error" in r ? r.error : "ran without error"}, expected an error naming “${want}”`);
    };
    await coxErr(
      coxAllCensored,
      { time: "Time", status: "Status", covariates: ["Trt", "Age"] },
      "at least 2 events",
      "all-censored",
    );
    await coxErr(
      coxBadStatus,
      { time: "Time", status: "Status", covariates: ["Trt", "Age"] },
      "must be 1 (event) or 0 (censored)",
      "bad status",
    );
    await coxErr(
      coxZeroTime,
      { time: "Time", status: "Status", covariates: ["Trt", "Age"] },
      "must be positive",
      "zero time",
    );
    await coxErr(
      coxTable,
      { time: "Time", status: "Status", covariates: [] },
      "at least one covariate",
      "no covariates",
    );
    // The forest plot for Case B: one row, HR 0.3672 with CI (0.1009, 1.3369),
    // a log-scaled x-axis, and a reference line at HR = 1.
    if (!("error" in coxB)) {
      const { addForestPlot } = await import("../src/views/graphs/forest-plot");
      const forestOpts = newGraphOptions("forest-plot");
      const fig = GRAPHS["forest-plot"].build(
        plotColumns(readTable(coxTable), "forest-plot", forestOpts, "multiple"),
        forestOpts,
        paintOf(forestOpts, 1),
        readTable(coxTable).titles,
      );
      addForestPlot(fig, coxB, paintOf(forestOpts, 1));
      const traces = fig.data as {
        mode?: string;
        x?: number[];
        y?: string[];
        text?: string[];
        error_x?: { array?: number[]; arrayminus?: number[] };
      }[];
      const row = traces.find((t) => t.mode === "markers");
      if (!row || row.x?.length !== 1 || Math.abs(row.x[0] - 0.3672) / 0.3672 > 1e-3)
        out.push(`Forest plot HR: ${JSON.stringify(row?.x)}, expected [0.3672]`);
      if (!row || row.y?.[0] !== "Trt") out.push(`Forest plot row: ${JSON.stringify(row?.y)}, expected ["Trt"]`);
      if (row?.error_x?.array?.[0] == null || Math.abs(row.error_x.array[0] - (1.3369 - 0.3672)) / 1.3369 > 1e-2)
        out.push(`Forest plot CI high: ${JSON.stringify(row?.error_x?.array)}, expected [0.9697]`);
      if (
        row?.error_x?.arrayminus?.[0] == null ||
        Math.abs(row.error_x.arrayminus[0] - (0.3672 - 0.1009)) / 0.3672 > 1e-2
      )
        out.push(`Forest plot CI low: ${JSON.stringify(row?.error_x?.arrayminus)}, expected [0.2663]`);
      if (!row?.text?.[0]?.includes("HR 0.3672 (95% CI 0.1009–1.337)"))
        out.push(`Forest plot label: ${JSON.stringify(row?.text)}, expected "HR 0.3672 (95% CI 0.1009–1.337)"`);
      const xaxis = fig.layout.xaxis as { type?: string; range?: number[]; autorange?: boolean };
      if (xaxis.type !== "log") out.push(`Forest plot x-axis: ${xaxis.type}, expected "log"`);
      if (xaxis.autorange !== false)
        out.push(`Forest plot x-axis autorange: ${xaxis.autorange}, expected false (else Plotly ignores range)`);
      // A log axis takes its range in log10 units: 10**range must cover the
      // whisker (0.1009, 1.3369). Passing data units here rendered [1.18, 78]
      // — caught by Linux GUI QA, Plan 10.
      if (!xaxis.range || 10 ** xaxis.range[0] >= 0.1009 || 10 ** xaxis.range[1] <= 1.3369)
        out.push(
          `Forest plot x-axis range: ${JSON.stringify(xaxis.range)}, expected log10 units covering the whisker (0.1009, 1.3369)`,
        );
      const shapes = (fig.layout.shapes as { type?: string; x0?: number; x1?: number }[] | undefined) ?? [];
      if (!shapes.some((s) => s.type === "line" && s.x0 === 1 && s.x1 === 1))
        out.push(`Forest plot reference line: ${JSON.stringify(shapes)}, expected a line at HR = 1`);
    }
    // Survival curves by Trt (Case A fixture): two KM curves, Trt = 1 above
    // Trt = 0 at most times — median survival control ≈ 10, treated ≈ 18.
    const { coxSurvivalColumns, kaplanMeier } = await import("../src/views/graphs/survival");
    const survCols = coxSurvivalColumns(coxTable, { time: "Time", status: "Status", stratifyBy: "Trt" });
    if (!survCols || survCols.length !== 3) {
      out.push(`Cox survival columns: ${survCols?.map((c) => c.name).join(",")}, expected Time + 2 groups`);
    } else {
      const median = (col: (typeof survCols)[number]) => {
        const { x, y: codes } = pairUp(survCols[0], col);
        const { t, s } = kaplanMeier(x, codes);
        for (let i = 1; i < t.length; i++) if (s[i] <= 0.5) return t[i];
        return null;
      };
      const med0 = median(survCols[1]);
      const med1 = median(survCols[2]);
      if (med0 !== 10) out.push(`Cox KM median (control): ${med0}, expected 10`);
      if (med1 !== 18) out.push(`Cox KM median (treated): ${med1}, expected 18`);
      const survOpts = newGraphOptions("survival");
      const survFig = GRAPHS["survival"].build(survCols, survOpts, paintOf(survOpts, 2), readTable(coxTable).titles);
      const curves = (survFig.data as { mode?: string; name?: string; y?: number[] }[]).filter(
        (t) => t.mode === "lines",
      );
      if (curves.length !== 2) out.push(`Cox survival graph curves: ${curves.length}, expected 2`);
      const names = curves.map((t) => t.name).sort();
      if (JSON.stringify(names) !== JSON.stringify(["Trt = 0", "Trt = 1"]))
        out.push(`Cox survival curves: ${names.join(",")}, expected "Trt = 0" and "Trt = 1"`);
    }
  }
  // Mixed-effects model (plan 20): the reference values are the lme4 fit on
  // the noisy tables (see the mixedBalanced comment — the plan's noiseless
  // values do not converge in lme4 and are NOT asserted here). Fixed effects
  // are checked against the P-07-pinned values (the same seed-11/sd-0.5
  // construction, fitted from R vectors there and from table cells here —
  // agreement is the reshaping check) at 1e-3, and the grouped case against
  // the OLS fit on the same long data at ±0.05 (lmer and OLS agree closely
  // on a nearly-balanced design, and differ exactly where the missing cell
  // makes the random-effects weighting matter). Tolerances (plan): fixed
  // effects ±0.05 absolute on the balanced case is beaten by the 1e-3
  // P-07 check; the one-missing-cell treatment effect must stay within
  // ±0.1 of 5.0.
  if (repoReady) {
    const mixStat = (r: AnalysisResult, label: string) => r.stats.find((s) => s.label === label)?.value;
    const mixCoef = (r: AnalysisResult, term: string) => r.coefficients?.find((c) => c.term === term);
    const mixVar = (r: AnalysisResult, group: string) => r.varianceComponents?.find((v) => v.group === group);
    const close = (got: number | null | undefined, want: number, tol: number, label: string) => {
      if (got == null || Math.abs(got - want) > tol) out.push(`Mixed-effects ${label}: ${got}, expected ${want} ± ${tol}`);
    };
    const rel = (got: number | null | undefined, want: number, relTol: number, label: string) => {
      if (got == null || Math.abs(got - want) > relTol * Math.abs(want))
        out.push(`Mixed-effects ${label}: ${got}, expected ${want} ± ${relTol * 100}%`);
    };
    // Balanced Column case.
    const mix = await runAnalysis("mixed-effects", mixedBalanced, mixedColumnParams);
    if ("error" in mix) {
      out.push(`Mixed-effects balanced: ${mix.error}`);
    } else {
      close(mixCoef(mix, "Intercept")?.estimate, 10.1926, 1e-3, "balanced intercept");
      close(mixCoef(mix, "Treatment (Treated vs Control)")?.estimate, 4.9656, 1e-3, "balanced treatment");
      close(mixCoef(mix, "Treatment (Treated vs Control)")?.stdError, 1.4064, 1e-3, "balanced treatment SE");
      rel(mixCoef(mix, "Treatment (Treated vs Control)")?.p, 0.02422, 1e-3, "balanced treatment p");
      close(mixCoef(mix, "T")?.estimate, 1.4972, 1e-3, "balanced time");
      rel(mixCoef(mix, "T")?.p, 4.5688e-14, 1e-3, "balanced time p");
      rel(mixVar(mix, "Subject")?.variance, 2.9336, 1e-3, "balanced subject variance");
      rel(mixVar(mix, "Subject")?.sd, 1.7128, 1e-3, "balanced subject SD");
      // Residual variance is checked against the realised noise variance
      // (sample variance, ddof=1, of the 24 seeded-minus-noiseless residuals
      // = 0.1561 — see the mixedBalanced comment), not the plan's noiseless
      // < 1e-6: that check applies to the noiseless case only, which does not
      // converge in lme4 and is not asserted. ±25%: the REML residual estimate
      // on 19 residual df has ~32% sampling sd, so the band must be wide; a
      // reshaping error would move the residual by far more. The exact value
      // (0.1337) is pinned in reference.json.
      rel(mixVar(mix, "Residual")?.variance, 0.1561, 0.25, "balanced residual variance vs realised noise");
      rel(mixStat(mix, "AIC"), 53.6558, 1e-3, "balanced AIC");
      rel(mixStat(mix, "BIC"), 59.5461, 1e-3, "balanced BIC");
      rel(mixStat(mix, "Log-likelihood"), -21.8279, 1e-3, "balanced log-likelihood");
      rel(mixStat(mix, "REML criterion"), 43.6558, 1e-3, "balanced REML criterion");
      close(mixStat(mix, "Observations used"), 24, 0, "balanced observations used");
      close(mixStat(mix, "Observations in table"), 24, 0, "balanced observations in table");
      close(mixStat(mix, "Observations dropped as missing"), 0, 0, "balanced dropped");
      close(mixStat(mix, "Subjects (groups)"), 6, 0, "balanced subjects");
      close(mixStat(mix, "Residual DF"), 19, 0, "balanced residual DF");
      if (mix.equation !== "y ~ Treatment + T + (1 | subject)")
        out.push(`Mixed-effects balanced equation: ${mix.equation}`);
      if (mix.subtitle !== "Mixed-effects model (random intercept)")
        out.push(`Mixed-effects balanced subtitle: ${mix.subtitle}`);
      if (!mix.notes.includes("P-values by Satterthwaite's approximation (lmerTest)"))
        out.push(`Mixed-effects balanced notes: Satterthwaite sentence missing`);
      if (!mix.notes.includes("0 observations dropped as missing"))
        out.push(`Mixed-effects balanced notes: explicit 0-dropped sentence missing — ${mix.notes}`);
    }
    // One cell blanked: 23 observations, no subject dropped, treatment within ±0.1 of 5.0.
    const mixMiss = await runAnalysis("mixed-effects", mixedMissing, mixedColumnParams);
    if ("error" in mixMiss) {
      out.push(`Mixed-effects missing-cell: ${mixMiss.error}`);
    } else {
      close(mixStat(mixMiss, "Observations used"), 23, 0, "missing-cell observations used");
      close(mixStat(mixMiss, "Observations dropped as missing"), 1, 0, "missing-cell dropped");
      close(mixStat(mixMiss, "Subjects (groups)"), 6, 0, "missing-cell subjects (no subject dropped)");
      close(mixCoef(mixMiss, "Treatment (Treated vs Control)")?.estimate, 5.0, 0.1, "missing-cell treatment");
      if (!mixMiss.notes.includes("1 observation dropped as missing"))
        out.push(`Mixed-effects missing-cell notes: 1-dropped sentence missing — ${mixMiss.notes}`);
    }
    // One subject with a single observation: runs, and the notes warn.
    const mixSingle = await runAnalysis("mixed-effects", mixedSingleObs, mixedColumnParams);
    if ("error" in mixSingle) {
      out.push(`Mixed-effects single-observation: ${mixSingle.error}`);
    } else if (!mixSingle.notes.includes("single observation")) {
      out.push(`Mixed-effects single-observation notes: warning missing — ${mixSingle.notes}`);
    }
    // Two subjects: an error naming the subject requirement.
    const mixTwo = await runAnalysis("mixed-effects", mixedTwoSubjects, mixedTwoSubjectsParams);
    if (!("error" in mixTwo) || !mixTwo.error.includes("at least 3 subjects"))
      out.push(
        `Mixed-effects two-subjects: ${"error" in mixTwo ? mixTwo.error : "ran without error"}, expected an error naming "at least 3 subjects"`,
      );
    // Grouped case (groups × rows, interaction): fixed effects against the
    // OLS fit on the same 44 long-format observations; the one missing cell
    // (B:Y2 Day 2) is a missing observation, not a missing subject.
    const mixGrouped = await runAnalysis("mixed-effects", grouped, {
      subjectId: "replicate",
      randomStructure: "intercept",
      fixedFactors: ["Group", "Row"],
      interaction: true,
    });
    if ("error" in mixGrouped) {
      out.push(`Mixed-effects grouped: ${mixGrouped.error}`);
    } else {
      close(mixCoef(mixGrouped, "Intercept")?.estimate, 10.6, 0.05, "grouped intercept (OLS)");
      close(mixCoef(mixGrouped, "Group (B vs A)")?.estimate, 3.2, 0.05, "grouped B vs A (OLS)");
      close(mixCoef(mixGrouped, "Group (C vs A)")?.estimate, -0.5333, 0.05, "grouped C vs A (OLS)");
      close(mixCoef(mixGrouped, "Row")?.estimate, 2.5, 0.05, "grouped row (OLS)");
      close(mixCoef(mixGrouped, "Group × Row (B vs A)")?.estimate, 1.8667, 0.05, "grouped B×Row (OLS)");
      close(mixCoef(mixGrouped, "Group × Row (C vs A)")?.estimate, -1.5667, 0.05, "grouped C×Row (OLS)");
      close(mixStat(mixGrouped, "Observations used"), 44, 0, "grouped observations used");
      close(mixStat(mixGrouped, "Observations dropped as missing"), 1, 0, "grouped dropped");
      close(mixStat(mixGrouped, "Subjects (groups)"), 3, 0, "grouped subjects");
      if (mixGrouped.equation !== "y ~ Group * Row + (1 | subject)")
        out.push(`Mixed-effects grouped equation: ${mixGrouped.equation}`);
    }
    // The wizard asks the repeated-measure columns + the matched-subjects
    // question + the optional between-subject-factor question on a Column
    // table, and interaction + matched-subjects on a Grouped table; finish
    // maps the answers to the runner's params, and the not-matched escape
    // resolves to the ordinary ANOVA instead. With no groups the finish is
    // the single-factor fit (y ~ T); with groups it carries the subject
    // factor, and feeding those params to the runner must reproduce the
    // two-factor reference fit — that is the GUI path to the pinned values.
    const mixAsked = (a: Record<string, string | string[]>, data: TableData) =>
      WIZARDS["mixed-effects"]!.questions(a, readTable(data)).flatMap((q) => (q ? [q.id] : []));
    if (JSON.stringify(mixAsked({}, mixedBalanced)) !== JSON.stringify(["sets", "matched", "groups"]))
      out.push(`Mixed-effects wizard (column): ${JSON.stringify(mixAsked({}, mixedBalanced))}`);
    if (
      JSON.stringify(mixAsked({ groups: "yes" }, mixedBalanced)) !==
      JSON.stringify(["sets", "matched", "groups", "groupName", "groupLevels"])
    )
      out.push(`Mixed-effects wizard (column, groups): ${JSON.stringify(mixAsked({ groups: "yes" }, mixedBalanced))}`);
    if (JSON.stringify(mixAsked({}, grouped)) !== JSON.stringify(["interaction", "matched"]))
      out.push(`Mixed-effects wizard (grouped): ${JSON.stringify(mixAsked({}, grouped))}`);
    const mixSetsQ = WIZARDS["mixed-effects"]!.questions({}, readTable(mixedBalanced))[0];
    if (!mixSetsQ || mixSetsQ.kind !== "names" || mixSetsQ.min !== 3)
      out.push(`Mixed-effects wizard sets question: ${JSON.stringify(mixSetsQ)}`);
    const mixColFinished = WIZARDS["mixed-effects"]!.finish(
      { sets: ["T0", "T1", "T2", "T3"], matched: "matched" },
      readTable(mixedBalanced),
    );
    if (
      JSON.stringify(mixColFinished) !==
      JSON.stringify({
        type: "mixed-effects",
        params: { subjectId: "row", randomStructure: "intercept", fixedFactors: ["T"], sets: ["T0", "T1", "T2", "T3"] },
      })
    )
      out.push(`Mixed-effects wizard finish (column): ${JSON.stringify(mixColFinished)}`);
    const mixColGrouped = WIZARDS["mixed-effects"]!.finish(
      {
        sets: ["T0", "T1", "T2", "T3"],
        matched: "matched",
        groups: "yes",
        groupName: "Treatment",
        groupLevels: "Control, Control, Control, Treated, Treated, Treated",
      },
      readTable(mixedBalanced),
    );
    if (
      JSON.stringify(mixColGrouped) !==
      JSON.stringify({
        type: "mixed-effects",
        params: {
          subjectId: "row",
          randomStructure: "intercept",
          fixedFactors: ["Treatment", "T"],
          subjectFactor: {
            name: "Treatment",
            levels: ["Control", "Control", "Control", "Treated", "Treated", "Treated"],
          },
          sets: ["T0", "T1", "T2", "T3"],
        },
      })
    )
      out.push(`Mixed-effects wizard finish (column, grouped): ${JSON.stringify(mixColGrouped)}`);
    if (mixColGrouped.params) {
      const mixGui = await runAnalysis("mixed-effects", mixedBalanced, mixColGrouped.params);
      if ("error" in mixGui) {
        out.push(`Mixed-effects wizard two-factor fit: ${mixGui.error}`);
      } else {
        close(mixCoef(mixGui, "Intercept")?.estimate, 10.1926, 1e-3, "wizard two-factor intercept");
        close(mixCoef(mixGui, "Treatment (Treated vs Control)")?.estimate, 4.9656, 1e-3, "wizard two-factor treatment");
        close(mixCoef(mixGui, "T")?.estimate, 1.4972, 1e-3, "wizard two-factor time");
        rel(mixVar(mixGui, "Subject")?.variance, 2.9336, 1e-3, "wizard two-factor subject variance");
        rel(mixVar(mixGui, "Residual")?.variance, 0.1561, 0.25, "wizard two-factor residual variance");
      }
    }
    const mixColEscape = WIZARDS["mixed-effects"]!.finish(
      { sets: ["T0", "T1", "T2", "T3"], matched: "not-matched" },
      readTable(mixedBalanced),
    );
    if (
      JSON.stringify(mixColEscape) !==
      JSON.stringify({ type: "anova", params: { posthoc: "none", sets: ["T0", "T1", "T2", "T3"] } })
    )
      out.push(`Mixed-effects wizard finish (column escape): ${JSON.stringify(mixColEscape)}`);
    const mixGrpFinished = WIZARDS["mixed-effects"]!.finish(
      { interaction: "yes", matched: "matched" },
      readTable(grouped),
    );
    if (
      JSON.stringify(mixGrpFinished) !==
      JSON.stringify({
        type: "mixed-effects",
        params: {
          subjectId: "replicate",
          randomStructure: "intercept",
          fixedFactors: ["Group", "Row"],
          interaction: true,
        },
      })
    )
      out.push(`Mixed-effects wizard finish (grouped): ${JSON.stringify(mixGrpFinished)}`);
    const mixGrpEscape = WIZARDS["mixed-effects"]!.finish(
      { interaction: "yes", matched: "not-matched" },
      readTable(grouped),
    );
    if (
      JSON.stringify(mixGrpEscape) !==
      JSON.stringify({
        type: "two-way-anova",
        params: { design: "ordinary", posthoc: "none", posthocTarget: "groups" },
      })
    )
      out.push(`Mixed-effects wizard finish (grouped escape): ${JSON.stringify(mixGrpEscape)}`);
  }
  // Principal component analysis (plan 21). The plan's "correlation matrix"
  // values are the COVARIANCE values — WebR prcomp (confirmed by an
  // independent NumPy SVD) gives, for scale.=TRUE, sdev 1.7097/0.2535/0.1126
  // and proportions 0.9744/0.0214/0.0042, while scale.=FALSE gives exactly
  // the plan's 1.2649/0.2172/0.0542 and 0.9696/0.0286/0.0018. The correlation
  // case below pins the true scale.=TRUE values; the covariance case pins
  // the plan's numbers. Loadings/scores are asserted sign-canonicalised
  // (the runner flips each component so its largest-|loading| entry is
  // positive), so they are stable whatever sign R's SVD returns.
  {
    const pcaStat = (r: AnalysisResult, label: string) => r.stats.find((s) => s.label === label)?.value;
    const close = (got: number | null | undefined, want: number, tol: number, label: string) => {
      if (got == null || Math.abs(got - want) > tol) out.push(`PCA ${label}: ${got}, expected ${want} ± ${tol}`);
    };
    const closeAll = (
      got: (number | null | undefined)[],
      want: number[],
      tol: number,
      label: string,
    ) => {
      if (got.length !== want.length) {
        out.push(`PCA ${label}: ${got.length} values, expected ${want.length}`);
        return;
      }
      got.forEach((g, i) => close(g, want[i], tol, `${label}[${i}]`));
    };
    const pcaCorr = await runAnalysis("principal-component-analysis", pca, { scale: "correlation" });
    if ("error" in pcaCorr) {
      out.push(`PCA correlation: ${pcaCorr.error}`);
    } else {
      closeAll(
        pcaCorr.pcaVariance?.map((v) => v.sd) ?? [],
        [1.7097, 0.2535, 0.1126],
        1e-3,
        "correlation sdev",
      );
      closeAll(
        pcaCorr.pcaVariance?.map((v) => v.eigenvalue) ?? [],
        [2.9231, 0.0642, 0.0127],
        1e-3,
        "correlation eigenvalue",
      );
      closeAll(
        pcaCorr.pcaVariance?.map((v) => v.proportion) ?? [],
        [0.9744, 0.0214, 0.0042],
        1e-3,
        "correlation proportion",
      );
      closeAll(
        pcaCorr.pcaVariance?.map((v) => v.cumulative) ?? [],
        [0.9744, 0.9958, 1.0],
        1e-3,
        "correlation cumulative",
      );
      closeAll(
        pcaCorr.pcaLoadings?.find((l) => l.variable === "Var1")?.loadings ?? [],
        [0.5738, 0.7505, -0.3279],
        1e-3,
        "correlation loadings Var1",
      );
      closeAll(
        pcaCorr.pcaLoadings?.find((l) => l.variable === "Var2")?.loadings ?? [],
        [0.5759, -0.6544, -0.49],
        1e-3,
        "correlation loadings Var2",
      );
      closeAll(
        pcaCorr.pcaLoadings?.find((l) => l.variable === "Var3")?.loadings ?? [],
        [0.5823, -0.0923, 0.8077],
        1e-3,
        "correlation loadings Var3",
      );
      closeAll(
        pcaCorr.pcaScores?.map((s) => s.scores[0]) ?? [],
        [0.3776, -3.2207, 0.6612, -0.2938, 1.7438, 0.7319],
        1e-3,
        "correlation scores PC1",
      );
      closeAll(
        pcaCorr.pcaScores?.map((s) => s.scores[1]) ?? [],
        [0.2865, 0.0587, -0.3801, -0.0526, 0.2495, -0.1619],
        1e-3,
        "correlation scores PC2",
      );
      closeAll(
        pcaCorr.pcaScores?.map((s) => s.scores[2]) ?? [],
        [-0.1396, 0.031, -0.1205, 0.006, 0.07, 0.1531],
        1e-3,
        "correlation scores PC3",
      );
      close(pcaStat(pcaCorr, "Total variance"), 3, 1e-3, "correlation total variance");
      close(pcaStat(pcaCorr, "Number of components"), 3, 0, "correlation component count");
      close(pcaStat(pcaCorr, "Variance explained by PC1"), 0.9744, 1e-3, "correlation PC1 share");
      close(pcaStat(pcaCorr, "Variance explained by PC1+PC2"), 0.9958, 1e-3, "correlation PC1+PC2 share");
      close(pcaStat(pcaCorr, "Complete rows (n)"), 6, 0, "correlation n");
      close(pcaStat(pcaCorr, "Variables (p)"), 3, 0, "correlation p");
      if (!pcaCorr.notes.includes("correlation matrix")) out.push(`PCA correlation notes: matrix missing`);
      if (!pcaCorr.notes.includes("standardised")) out.push(`PCA correlation notes: standardised missing`);
      if (pcaCorr.pcaScores?.map((s) => s.row).join(",") !== "Row 1,Row 2,Row 3,Row 4,Row 5,Row 6")
        out.push(`PCA score rows: ${pcaCorr.pcaScores?.map((s) => s.row).join(",")}, expected Row 1..Row 6`);
    }
    // The defaults (no params) give the same numbers as the explicit
    // correlation run.
    const pcaDef = await runAnalysis("principal-component-analysis", pca, {});
    if ("error" in pcaDef) {
      out.push(`PCA defaults: ${pcaDef.error}`);
    } else if (!("error" in pcaCorr)) {
      for (const s of pcaCorr.stats) {
        const got = pcaStat(pcaDef, s.label);
        if (got !== s.value) out.push(`PCA defaults ${s.label}: ${got}, explicit run: ${s.value}`);
      }
    }
    // Covariance: the plan's numbers, exactly.
    const pcaCov = await runAnalysis("principal-component-analysis", pca, { scale: "covariance" });
    if ("error" in pcaCov) {
      out.push(`PCA covariance: ${pcaCov.error}`);
    } else {
      closeAll(
        pcaCov.pcaVariance?.map((v) => v.sd) ?? [],
        [1.2649, 0.2172, 0.0542],
        1e-3,
        "covariance sdev (plan's values)",
      );
      closeAll(
        pcaCov.pcaVariance?.map((v) => v.proportion) ?? [],
        [0.9696, 0.0286, 0.0018],
        1e-3,
        "covariance proportion (plan's values)",
      );
      closeAll(
        pcaCov.pcaVariance?.map((v) => v.cumulative) ?? [],
        [0.9696, 0.9982, 1.0],
        1e-3,
        "covariance cumulative (plan's values)",
      );
      closeAll(
        pcaCov.pcaLoadings?.find((l) => l.variable === "Var1")?.loadings ?? [],
        [0.6791, 0.71, -0.1865],
        1e-3,
        "covariance loadings Var1 (plan's values)",
      );
      closeAll(
        pcaCov.pcaLoadings?.find((l) => l.variable === "Var2")?.loadings ?? [],
        [0.6587, -0.7015, -0.2719],
        1e-3,
        "covariance loadings Var2 (plan's values)",
      );
      closeAll(
        pcaCov.pcaLoadings?.find((l) => l.variable === "Var3")?.loadings ?? [],
        [0.3239, -0.0618, 0.9441],
        1e-3,
        "covariance loadings Var3 (plan's values)",
      );
      closeAll(
        pcaCov.pcaScores?.map((s) => s.scores[0]) ?? [],
        [0.3486, -2.3885, 0.5067, -0.2229, 1.2809, 0.4752],
        1e-3,
        "covariance scores PC1 (plan's values)",
      );
      closeAll(
        pcaCov.pcaScores?.map((s) => s.scores[1]) ?? [],
        [0.2353, 0.0574, -0.3346, -0.0442, 0.2157, -0.1295],
        1e-3,
        "covariance scores PC2 (plan's values)",
      );
      close(pcaStat(pcaCov, "Total variance"), 1.65, 1e-3, "covariance total variance");
      close(pcaStat(pcaCov, "Variance explained by PC1"), 0.9696, 1e-3, "covariance PC1 share");
      close(pcaStat(pcaCov, "Variance explained by PC1+PC2"), 0.9982, 1e-3, "covariance PC1+PC2 share");
      if (!pcaCov.notes.includes("covariance matrix")) out.push(`PCA covariance notes: matrix missing`);
    }
    // First two components only: every table is two wide, and the note says so.
    const pcaTwo = await runAnalysis("principal-component-analysis", pca, { scale: "correlation", components: 2 });
    if ("error" in pcaTwo) {
      out.push(`PCA two components: ${pcaTwo.error}`);
    } else {
      if (pcaTwo.pcaVariance?.length !== 2) out.push(`PCA two components: ${pcaTwo.pcaVariance?.length} rows`);
      if (pcaTwo.pcaLoadings?.some((l) => l.loadings.length !== 2))
        out.push(`PCA two components: loadings not 2 wide`);
      if (pcaTwo.pcaScores?.some((s) => s.scores.length !== 2)) out.push(`PCA two components: scores not 2 wide`);
      if (!pcaTwo.notes.includes("Showing the first 2 of 3 components"))
        out.push(`PCA two components notes: ${pcaTwo.notes}`);
    }
    // Over-asked: clamped to the 3 available, and the note says so.
    const pcaNine = await runAnalysis("principal-component-analysis", pca, { scale: "correlation", components: 9 });
    if ("error" in pcaNine) {
      out.push(`PCA nine components: ${pcaNine.error}`);
    } else {
      if (pcaNine.pcaVariance?.length !== 3) out.push(`PCA nine components: ${pcaNine.pcaVariance?.length} rows`);
      if (!pcaNine.notes.includes("Asked for 9 components; only 3 available"))
        out.push(`PCA nine components notes: ${pcaNine.notes}`);
    }
    // Edge cases: a constant variable names itself on the correlation
    // matrix but runs on the covariance matrix (2 components, Var3
    // contributing nothing); too few rows and perfect collinearity each
    // report only the non-zero components and note the rank deficiency.
    const pcaConstCorr = await runAnalysis("principal-component-analysis", pcaConstant, { scale: "correlation" });
    if (!("error" in pcaConstCorr) || !pcaConstCorr.error.includes("Var3"))
      out.push(
        `PCA constant (correlation): ${"error" in pcaConstCorr ? pcaConstCorr.error : "ran without error"}, expected an error naming Var3`,
      );
    const pcaConstCov = await runAnalysis("principal-component-analysis", pcaConstant, { scale: "covariance" });
    if ("error" in pcaConstCov) {
      out.push(`PCA constant (covariance): ${pcaConstCov.error}`);
    } else if (pcaConstCov.pcaVariance?.length !== 2) {
      out.push(`PCA constant (covariance): ${pcaConstCov.pcaVariance?.length} components, expected 2`);
    }
    const pcaFew = await runAnalysis("principal-component-analysis", pcaFewRows, { scale: "correlation" });
    if ("error" in pcaFew) {
      out.push(`PCA few rows: ${pcaFew.error}`);
    } else {
      if (pcaFew.pcaVariance?.length !== 1) out.push(`PCA few rows: ${pcaFew.pcaVariance?.length} components`);
      if (!pcaFew.notes.includes("rank-deficient")) out.push(`PCA few rows notes: ${pcaFew.notes}`);
      if (pcaFew.stats.find((s) => s.label === "Variance explained by PC1+PC2")?.value !== null)
        out.push(`PCA few rows: PC1+PC2 should be blank with one component`);
    }
    const pcaColl = await runAnalysis("principal-component-analysis", pcaCollinear, { scale: "correlation" });
    if ("error" in pcaColl) {
      out.push(`PCA collinear: ${pcaColl.error}`);
    } else {
      if (pcaColl.pcaVariance?.length !== 2) out.push(`PCA collinear: ${pcaColl.pcaVariance?.length} components`);
      if (!pcaColl.notes.includes("rank-deficient")) out.push(`PCA collinear notes: ${pcaColl.notes}`);
    }
    // The scree plot for the correlation run: bars are the % variance
    // (97.44, 2.14, 0.42), the line the cumulative % (97.44, 99.58, 100),
    // on a category X axis with a 0–100 secondary axis.
    if (!("error" in pcaCorr)) {
      const { addScreePlot } = await import("../src/views/graphs/scree-plot");
      const screeOpts = newGraphOptions("scree-plot");
      const screeFig = GRAPHS["scree-plot"].build(
        plotColumns(readTable(pca), "scree-plot", screeOpts, "multiple"),
        screeOpts,
        paintOf(screeOpts, 1),
        readTable(pca).titles,
      );
      addScreePlot(screeFig, pcaCorr, paintOf(screeOpts, 1));
      const traces = screeFig.data as { type?: string; x?: string[]; y?: number[]; yaxis?: string }[];
      const bars = traces.find((t) => t.type === "bar");
      const line = traces.find((t) => t.type === "scatter");
      if (!bars || JSON.stringify(bars.x) !== JSON.stringify(["PC1", "PC2", "PC3"]))
        out.push(`Scree bars x: ${JSON.stringify(bars?.x)}, expected ["PC1","PC2","PC3"]`);
      closeAll(bars?.y ?? [], [97.44, 2.14, 0.42], 0.01, "scree bar heights");
      closeAll(line?.y ?? [], [97.44, 99.58, 100], 0.01, "scree cumulative line");
      if (line?.yaxis !== "y2") out.push(`Scree line axis: ${line?.yaxis}, expected "y2"`);
      const xaxis = screeFig.layout.xaxis as { type?: string };
      if (xaxis.type !== "category") out.push(`Scree x-axis: ${xaxis.type}, expected "category"`);
      const yaxis2 = screeFig.layout.yaxis2 as { range?: number[] } | undefined;
      if (!yaxis2 || JSON.stringify(yaxis2.range) !== JSON.stringify([0, 100]))
        out.push(`Scree secondary axis: ${JSON.stringify(yaxis2?.range)}, expected [0, 100]`);
      // The biplot for the same run: points are the PC1/PC2 scores, labelled
      // by row, with one arrow per variable scaled to the score cloud — the
      // longest arrow (Var1, PC2 loading 0.7505) reaches the largest score
      // (3.2207), so its tip is (2.4626, 3.2207).
      const { addPcaBiplot } = await import("../src/views/graphs/pca-biplot");
      const biplotOpts = newGraphOptions("pca-biplot");
      const biplotFig = GRAPHS["pca-biplot"].build(
        plotColumns(readTable(pca), "pca-biplot", biplotOpts, "multiple"),
        biplotOpts,
        paintOf(biplotOpts, 1),
        readTable(pca).titles,
      );
      addPcaBiplot(biplotFig, pcaCorr, biplotOpts, paintOf(biplotOpts, 1));
      const points = (biplotFig.data as { type?: string; x?: number[]; y?: number[]; text?: string[] }[]).find(
        (t) => t.type === "scatter",
      );
      closeAll(points?.x ?? [], [0.3776, -3.2207, 0.6612, -0.2938, 1.7438, 0.7319], 1e-3, "biplot x (PC1 scores)");
      closeAll(points?.y ?? [], [0.2865, 0.0587, -0.3801, -0.0526, 0.2495, -0.1619], 1e-3, "biplot y (PC2 scores)");
      if (JSON.stringify(points?.text) !== JSON.stringify(["Row 1", "Row 2", "Row 3", "Row 4", "Row 5", "Row 6"]))
        out.push(`Biplot labels: ${JSON.stringify(points?.text)}, expected Row 1..Row 6`);
      const arrows = (biplotFig.layout.annotations as { x?: number; y?: number; text?: string }[] | undefined) ?? [];
      if (arrows.length !== 3) out.push(`Biplot arrows: ${arrows.length}, expected 3`);
      const var1 = arrows.find((a) => a.text === "Var1");
      if (var1 == null || Math.abs((var1.x ?? 0) - 2.4626) > 0.01 || Math.abs((var1.y ?? 0) - 3.2207) > 0.01)
        out.push(`Biplot Var1 arrow tip: (${var1?.x}, ${var1?.y}), expected (2.4626, 3.2207)`);
      const yaxis = biplotFig.layout.yaxis as { scaleanchor?: string; scaleratio?: number; title?: { text?: string } };
      if (yaxis.scaleanchor !== "x" || yaxis.scaleratio !== 1)
        out.push(`Biplot aspect: scaleanchor ${yaxis.scaleanchor}/${yaxis.scaleratio}, expected "x"/1`);
      const xaxisB = biplotFig.layout.xaxis as { title?: { text?: string } };
      if (xaxisB.title?.text !== "PC1 (97.4%)") out.push(`Biplot x title: ${xaxisB.title?.text}, expected "PC1 (97.4%)"`);
      if (yaxis.title?.text !== "PC2 (2.1%)") out.push(`Biplot y title: ${yaxis.title?.text}, expected "PC2 (2.1%)"`);
      // The component selector: PC1 vs PC3 plots the third component's
      // scores on Y; asking for the same component twice falls back to the
      // other of PC1/PC2.
      const biplotOpts13 = { ...newGraphOptions("pca-biplot"), pcaX: 1, pcaY: 3 };
      const biplotFig13 = GRAPHS["pca-biplot"].build(
        plotColumns(readTable(pca), "pca-biplot", biplotOpts13, "multiple"),
        biplotOpts13,
        paintOf(biplotOpts13, 1),
        readTable(pca).titles,
      );
      addPcaBiplot(biplotFig13, pcaCorr, biplotOpts13, paintOf(biplotOpts13, 1));
      const points13 = (biplotFig13.data as { type?: string; y?: number[] }[]).find((t) => t.type === "scatter");
      closeAll(points13?.y ?? [], [-0.1396, 0.031, -0.1205, 0.006, 0.07, 0.1531], 1e-3, "biplot PC1 vs PC3 y");
      const biplotOpts22 = { ...newGraphOptions("pca-biplot"), pcaX: 2, pcaY: 2 };
      const biplotFig22 = GRAPHS["pca-biplot"].build(
        plotColumns(readTable(pca), "pca-biplot", biplotOpts22, "multiple"),
        biplotOpts22,
        paintOf(biplotOpts22, 1),
        readTable(pca).titles,
      );
      addPcaBiplot(biplotFig22, pcaCorr, biplotOpts22, paintOf(biplotOpts22, 1));
      const xaxis22 = biplotFig22.layout.xaxis as { title?: { text?: string } };
      const yaxis22 = biplotFig22.layout.yaxis as { title?: { text?: string } };
      if (xaxis22.title?.text !== "PC2 (2.1%)" || yaxis22.title?.text !== "PC1 (97.4%)")
        out.push(
          `Biplot same-component fallback: ${xaxis22.title?.text} vs ${yaxis22.title?.text}, expected PC2 (2.1%) vs PC1 (97.4%)`,
        );
    }
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
    if (p == null || Math.abs(p - 0.0001554) / 0.0001554 > 1e-4) out.push(`KS shifted p: ${p}, plan says 0.0001554`);
    if (ksShiftedR.stat("N (group 1)") !== 8 || ksShiftedR.stat("N (group 2)") !== 8)
      out.push(`KS shifted N: ${ksShiftedR.stat("N (group 1)")}/${ksShiftedR.stat("N (group 2)")}, expected 8/8`);
  }
  const ksSimilarR = await ksRun(ksSimilar, "similar");
  if (ksSimilarR) {
    const d = ksSimilarR.stat("KS distance D");
    const p = ksSimilarR.stat("P value");
    if (d == null || Math.abs(d - 0.25) > 1e-12) out.push(`KS similar D: ${d}, plan says 0.25`);
    if (p == null || Math.abs(p - 0.9801) / 0.9801 > 1e-4) out.push(`KS similar p: ${p}, plan says 0.9801`);
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
    if (ksIdenticalR.stat("P value") !== 1) out.push(`KS identical p: ${ksIdenticalR.stat("P value")}, expected 1`);
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
    [2.1, 9.3, 5],
    [0, 10, 5],
    [0, 1, 5],
    [1, 2, 5],
    [0, 100, 5],
    [3, 97, 5],
    [0.2, 0.9, 5],
    [-5, 5, 5],
    [10, 20, 5],
    [100, 200, 5],
    [0, 7, 5],
    [0, 3, 5],
    [2, 4, 5],
    [0, 0.5, 5],
    [5, 6, 5],
    [0, 1000, 5],
    [123, 456, 5],
    [0.001, 0.009, 5],
    [2.1, 9.3, 4],
    [2.1, 9.3, 6],
    [0, 10, 3],
    [0, 10, 10],
    [7, 8, 5],
    [-100, -10, 5],
    [0.15, 0.85, 5],
    [42, 42.5, 5],
    [0, 7.005, 5],
    [0, 14.02, 5],
    [0, 35.1, 5],
    [0.3, 0.9, 5],
    [0.6, 0.9, 5],
    [1.1, 1.9, 5],
    [2.3, 2.9, 5],
    [0.3, 0.7, 5],
    [-0.3, 0.3, 5],
    [0.07, 0.11, 5],
    [999, 1001, 5],
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
    if (stat("DFd (residual)") !== 16) out.push(`Three-way ANOVA DFd: ${stat("DFd (residual)")}, expected 16`);
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
      out.push(
        `Three-way ANOVA ${label}: ${"error" in r ? r.error : "ran without error"}, expected an error naming ${want}`,
      );
  }
  // Poisson regression (plan 12): the plan's values, computed by the planner
  // from R glm() in Helix's own webR. Tolerances from the plan: coefficients
  // / SEs / rate ratios ±0.001, z and P ±0.001 (the tiny Case B P ±1e-8
  // absolute), deviance / AIC / dispersion ±0.01.
  const poisParams = { dependent: "Count", predictors: ["Dose", "Age"], quasi: false };
  const poisA = await runAnalysis("poisson-regression", poissonCounts, poisParams);
  if ("error" in poisA) {
    out.push(`Poisson Case A: ${poisA.error}`);
  } else {
    const stat = (label: string) => poisA.stats.find((s) => s.label === label)?.value;
    const close = (got: number | null | undefined, want: number, tol: number) =>
      got != null && Math.abs(got - want) <= tol;
    const checkCoef = (term: string, est: number, se: number, z: number, p: number) => {
      const c = poisA.coefficients?.find((cc) => cc.term === term);
      if (!close(c?.estimate, est, 1e-3)) out.push(`Poisson Case A ${term} estimate: ${c?.estimate}, plan says ${est}`);
      if (!close(c?.stdError, se, 1e-3)) out.push(`Poisson Case A ${term} SE: ${c?.stdError}, plan says ${se}`);
      if (!close(c?.t, z, 1e-3)) out.push(`Poisson Case A ${term} z: ${c?.t}, plan says ${z}`);
      if (!close(c?.p, p, 1e-3)) out.push(`Poisson Case A ${term} P: ${c?.p}, plan says ${p}`);
    };
    checkCoef("Intercept", 0.4735, 0.7023, 0.6742, 0.5002);
    checkCoef("Dose", 0.4287, 0.1178, 3.6383, 0.000274);
    checkCoef("Age", 0.0244, 0.0255, 0.9542, 0.34);
    if (poisA.statisticLabel !== "z") out.push(`Poisson Case A statistic label: ${poisA.statisticLabel}, expected z`);
    if (!close(stat("Rate ratio (Dose)"), 1.5353, 1e-3))
      out.push(`Poisson Case A RR Dose: ${stat("Rate ratio (Dose)")}, plan says 1.5353`);
    if (!close(stat("Rate ratio 95% CI lower (Dose)"), 1.2187, 1e-3))
      out.push(`Poisson Case A RR Dose lower: ${stat("Rate ratio 95% CI lower (Dose)")}, plan says 1.2187`);
    if (!close(stat("Rate ratio 95% CI upper (Dose)"), 1.9342, 1e-3))
      out.push(`Poisson Case A RR Dose upper: ${stat("Rate ratio 95% CI upper (Dose)")}, plan says 1.9342`);
    if (!close(stat("Rate ratio (Age)"), 1.0247, 1e-3))
      out.push(`Poisson Case A RR Age: ${stat("Rate ratio (Age)")}, plan says 1.0247`);
    if (!close(stat("Rate ratio 95% CI lower (Age)"), 0.9746, 1e-3))
      out.push(`Poisson Case A RR Age lower: ${stat("Rate ratio 95% CI lower (Age)")}, plan says 0.9746`);
    if (!close(stat("Rate ratio 95% CI upper (Age)"), 1.0772, 1e-3))
      out.push(`Poisson Case A RR Age upper: ${stat("Rate ratio 95% CI upper (Age)")}, plan says 1.0772`);
    if (!close(stat("Residual deviance"), 1.4898, 0.01))
      out.push(`Poisson Case A residual deviance: ${stat("Residual deviance")}, plan says 1.4898`);
    if (!close(stat("Null deviance"), 24.0778, 0.01))
      out.push(`Poisson Case A null deviance: ${stat("Null deviance")}, plan says 24.0778`);
    if (!close(stat("AIC"), 51.3667, 0.01)) out.push(`Poisson Case A AIC: ${stat("AIC")}, plan says 51.3667`);
    if (!close(stat("Pearson chi-square"), 1.5121, 0.01))
      out.push(`Poisson Case A Pearson chi-square: ${stat("Pearson chi-square")}, plan says 1.5121`);
    if (!close(stat("Dispersion (deviance)"), 0.1655, 0.01))
      out.push(`Poisson Case A dispersion (deviance): ${stat("Dispersion (deviance)")}, plan says 0.1655`);
    if (!close(stat("Dispersion (Pearson)"), 0.168, 0.01))
      out.push(`Poisson Case A dispersion (Pearson): ${stat("Dispersion (Pearson)")}, plan says 0.168`);
    if (stat("Residual df") !== 9) out.push(`Poisson Case A residual df: ${stat("Residual df")}, expected 9`);
    if (poisA.notes.includes("overdispersed")) out.push(`Poisson Case A notes warn of overdispersion: ${poisA.notes}`);
    if (!poisA.notes.includes("underdispersed"))
      out.push(`Poisson Case A notes missing the underdispersion note: ${poisA.notes}`);
    // The graph's fitted values, computed in TS from the coefficients —
    // the plan's spot-checks (row 1, row 6, row 12).
    const { fittedCounts, addObservedFitted } = await import("../src/views/graphs/observed-fitted");
    const fitted = fittedCounts(
      plotColumns(readTable(poissonCounts), "observed-fitted", newGraphOptions("observed-fitted"), "multiple"),
      poisA,
      poisParams,
    );
    if (fitted?.length !== 12) out.push(`Poisson Case A fitted rows: ${fitted?.length}, expected 12`);
    for (const [i, want] of [
      [0, 2.6136],
      [5, 5.5077],
      [11, 13.9672],
    ] as const) {
      const got = fitted?.[i]?.fitted;
      if (got == null || Math.abs(got - want) > 0.01)
        out.push(`Poisson Case A fitted row ${i + 1}: ${got}, plan says ${want}`);
    }
    // The graph itself: one dashed y = x line and the 12 points.
    const poisOpts = newGraphOptions("observed-fitted");
    const poisCols = plotColumns(readTable(poissonCounts), "observed-fitted", poisOpts, "multiple");
    const poisFig = GRAPHS["observed-fitted"].build(
      poisCols,
      poisOpts,
      paintOf(poisOpts, 1),
      readTable(poissonCounts).titles,
    );
    addObservedFitted(poisFig, poisCols, poisA, poisParams, paintOf(poisOpts, 1));
    const pTraces = poisFig.data as { mode?: string; x?: number[]; y?: number[]; line?: { dash?: string } }[];
    const line = pTraces.find((t) => t.mode === "lines");
    const pts = pTraces.find((t) => t.mode === "markers");
    if (!line || line.line?.dash !== "dash" || line.x?.[0] !== line.y?.[0] || line.x?.[1] !== line.y?.[1])
      out.push(
        `Observed-vs-fitted identity line: ${JSON.stringify(line?.x)} vs ${JSON.stringify(line?.y)}, expected a dashed y = x line`,
      );
    if (
      !pts ||
      pts.x?.length !== 12 ||
      JSON.stringify(pts.x) !== JSON.stringify([2, 3, 3, 5, 4, 7, 6, 9, 8, 12, 11, 14])
    )
      out.push(`Observed-vs-fitted points x: ${JSON.stringify(pts?.x)}, expected the 12 observed counts`);
    if (pts?.y?.some((v, i) => Math.abs(v - (fitted?.[i]?.fitted ?? NaN)) > 1e-9))
      out.push(`Observed-vs-fitted points y differ from the TS fitted values`);
  }
  // Case B, standard and quasi-Poisson.
  const poisB = await runAnalysis("poisson-regression", poissonOverdispersed, poisParams);
  const poisBQ = await runAnalysis("poisson-regression", poissonOverdispersed, { ...poisParams, quasi: true });
  if ("error" in poisB) {
    out.push(`Poisson Case B: ${poisB.error}`);
  } else {
    const stat = (label: string) => poisB.stats.find((s) => s.label === label)?.value;
    const dose = poisB.coefficients?.find((c) => c.term === "Dose");
    if (dose?.estimate == null || Math.abs(dose.estimate - 0.4512) > 1e-3)
      out.push(`Poisson Case B Dose estimate: ${dose?.estimate}, plan says 0.4512`);
    if (dose?.stdError == null || Math.abs(dose.stdError - 0.0895) > 1e-3)
      out.push(`Poisson Case B Dose SE: ${dose?.stdError}, plan says 0.0895`);
    if (dose?.t == null || Math.abs(dose.t - 5.04) > 1e-3)
      out.push(`Poisson Case B Dose z: ${dose?.t}, plan says 5.04`);
    if (dose?.p == null || Math.abs(dose.p - 4.66e-7) > 1e-8)
      out.push(`Poisson Case B Dose P: ${dose?.p}, plan says 4.66e-7`);
    if (stat("Residual deviance") == null || Math.abs(stat("Residual deviance")! - 95.7988) > 0.01)
      out.push(`Poisson Case B residual deviance: ${stat("Residual deviance")}, plan says 95.7988`);
    if (stat("Dispersion (deviance)") == null || Math.abs(stat("Dispersion (deviance)")! - 10.6443) > 0.01)
      out.push(`Poisson Case B dispersion (deviance): ${stat("Dispersion (deviance)")}, plan says 10.6443`);
    if (stat("Dispersion (Pearson)") == null || Math.abs(stat("Dispersion (Pearson)")! - 9.1402) > 0.01)
      out.push(`Poisson Case B dispersion (Pearson): ${stat("Dispersion (Pearson)")}, plan says 9.1402`);
    if (!poisB.notes.includes("overdispersed") || !poisB.notes.includes("Re-run with quasi-Poisson"))
      out.push(`Poisson Case B notes missing the overdispersion warning: ${poisB.notes}`);
    if ("error" in poisBQ) {
      out.push(`Poisson Case B quasi: ${poisBQ.error}`);
    } else {
      const qDose = poisBQ.coefficients?.find((c) => c.term === "Dose");
      // The refit must not move the coefficients — only the SEs and P values.
      if (qDose?.estimate == null || dose?.estimate == null || Math.abs(qDose.estimate - dose.estimate) > 1e-9)
        out.push(`Poisson Case B quasi Dose estimate moved: ${qDose?.estimate} vs ${dose?.estimate}`);
      if (qDose?.stdError == null || Math.abs(qDose.stdError - 0.2707) > 1e-3)
        out.push(`Poisson Case B quasi Dose SE: ${qDose?.stdError}, plan says 0.2707`);
      if (qDose?.p == null || Math.abs(qDose.p - 0.1299) > 1e-3)
        out.push(`Poisson Case B quasi Dose P: ${qDose?.p}, plan says 0.1299`);
      if (qDose?.p != null && qDose.p <= 0.05)
        out.push(`Poisson Case B quasi Dose still significant: P = ${qDose.p}, the refit must flip it`);
      const qStat = (label: string) => poisBQ.stats.find((s) => s.label === label)?.value;
      if (qStat("Quasi-Poisson dispersion") == null || Math.abs(qStat("Quasi-Poisson dispersion")! - 9.1402) > 0.01)
        out.push(`Poisson Case B quasi dispersion: ${qStat("Quasi-Poisson dispersion")}, plan says 9.1402`);
      if (poisBQ.stats.some((s) => s.label === "AIC"))
        out.push(`Poisson Case B quasi keeps an AIC row — quasi-likelihood has no true AIC`);
      if (!poisBQ.notes.includes("scaled by √φ"))
        out.push(`Poisson Case B quasi notes missing the SE scaling: ${poisBQ.notes}`);
    }
  }
  // Chi-square test for trend + McNemar's test (plan 19): the plan's values,
  // computed in Python (scipy) from the stated tables and confirmed against
  // R prop.trend.test / mcnemar.test / binom.test in WebR. Tolerances from
  // the plan: statistics absolute 1e-3 (trend) / 1e-4 (McNemar), P values
  // relative 1e-3 (trend, small P) / absolute 1e-4 (McNemar).
  const trend = await runAnalysis("chi-square", contingencyTrend, { trendOrdered: true });
  const trendOff = await runAnalysis("chi-square", contingencyTrend, { trendOrdered: false });
  const trendNoParams = await runAnalysis("chi-square", contingencyTrend);
  const trendT = await runAnalysis("chi-square", contingencyTrendT, { trendOrdered: true });
  const tStat = (r: AnalysisResult | { error: string }, label: string) =>
    "error" in r ? null : r.stats.find((s) => s.label === label)?.value;
  const absClose = (got: number | null | undefined, want: number, tol: number) =>
    got != null && Math.abs(got - want) <= tol;
  const relClose19 = (got: number | null | undefined, want: number, tol: number) =>
    got != null && Math.abs(got - want) <= tol * Math.max(1, Math.abs(want));
  if ("error" in trend) {
    out.push(`Trend: ${trend.error}`);
  } else {
    if (!absClose(tStat(trend, "Chi-square"), 17.28, 1e-3))
      out.push(`Trend Pearson chi-square: ${tStat(trend, "Chi-square")}, plan says 17.28`);
    if (!relClose19(tStat(trend, "P value"), 0.000619, 1e-3))
      out.push(`Trend Pearson P: ${tStat(trend, "P value")}, plan says 0.000619`);
    if (!absClose(tStat(trend, "Chi-square for trend"), 17.0667, 1e-3))
      out.push(`Trend chi-square: ${tStat(trend, "Chi-square for trend")}, plan says 17.0667`);
    if (!relClose19(tStat(trend, "P value (test for trend)"), 0.000036, 1e-3))
      out.push(`Trend P: ${tStat(trend, "P value (test for trend)")}, plan says 0.000036`);
    if (!trend.notes.includes("Cochran–Armitage"))
      out.push(`Trend notes missing the Cochran–Armitage note: ${trend.notes}`);
  }
  // Trend off (and no params): the Pearson rows are identical, and no trend
  // rows are present at all — assert the absence, not just the values.
  for (const [label, r] of [
    ["trendOrdered false", trendOff],
    ["no params", trendNoParams],
  ] as const) {
    if ("error" in r) {
      out.push(`Trend (${label}): ${r.error}`);
    } else {
      if (!absClose(tStat(r, "Chi-square"), 17.28, 1e-3))
        out.push(`Trend (${label}) Pearson chi-square: ${tStat(r, "Chi-square")}, plan says 17.28`);
      if (r.stats.some((s) => s.label === "Chi-square for trend"))
        out.push(`Trend (${label}) reports a trend statistic — it must not run unconfirmed`);
      if (!r.notes.includes("was not run"))
        out.push(`Trend (${label}) notes missing the not-run explanation: ${r.notes}`);
    }
  }
  // Transposed orientation: the same trend statistic.
  if ("error" in trendT) {
    out.push(`Trend transposed: ${trendT.error}`);
  } else {
    if (!absClose(tStat(trendT, "Chi-square for trend"), 17.0667, 1e-3))
      out.push(`Trend transposed chi-square: ${tStat(trendT, "Chi-square for trend")}, plan says 17.0667`);
    if (!relClose19(tStat(trendT, "P value (test for trend)"), 0.000036, 1e-3))
      out.push(`Trend transposed P: ${tStat(trendT, "P value (test for trend)")}, plan says 0.000036`);
  }
  const mcnemar = await runAnalysis("mcnemar", mcnemarTable);
  const mcnemarNoCorr = await runAnalysis("mcnemar", mcnemarTable, { continuityCorrection: false });
  const mcnemarStat = (r: AnalysisResult | { error: string }, label: string) =>
    "error" in r ? null : r.stats.find((s) => s.label === label)?.value;
  if ("error" in mcnemar) {
    out.push(`McNemar: ${mcnemar.error}`);
  } else {
    if (!absClose(mcnemarStat(mcnemar, "McNemar's chi-square"), 3.0625, 1e-4))
      out.push(`McNemar chi-square (corrected): ${mcnemarStat(mcnemar, "McNemar's chi-square")}, plan says 3.0625`);
    if (!absClose(mcnemarStat(mcnemar, "P value (McNemar's test)"), 0.0801, 1e-4))
      out.push(`McNemar P (corrected): ${mcnemarStat(mcnemar, "P value (McNemar's test)")}, plan says 0.0801`);
    if (!absClose(mcnemarStat(mcnemar, "P value (exact binomial)"), 0.0768, 1e-4))
      out.push(`McNemar exact P: ${mcnemarStat(mcnemar, "P value (exact binomial)")}, plan says 0.0768`);
    if (!absClose(mcnemarStat(mcnemar, "Odds ratio (paired, b/c)"), 3.0, 1e-4))
      out.push(`McNemar OR: ${mcnemarStat(mcnemar, "Odds ratio (paired, b/c)")}, plan says 3.0`);
    if (mcnemarStat(mcnemar, "Discordant pairs (b + c)") !== 16)
      out.push(`McNemar discordant pairs: ${mcnemarStat(mcnemar, "Discordant pairs (b + c)")}, expected 16`);
    const orLo = mcnemarStat(mcnemar, "Odds ratio (paired) 95% CI lower");
    const orHi = mcnemarStat(mcnemar, "Odds ratio (paired) 95% CI upper");
    if (orLo == null || orHi == null || !(orLo < 3.0 && 3.0 < orHi))
      out.push(`McNemar OR 95% CI: [${orLo}, ${orHi}], expected to bracket 3.0`);
    if (!mcnemar.notes.includes("Prism does not offer this test"))
      out.push(`McNemar notes missing the Prism-does-not-offer-it note: ${mcnemar.notes}`);
  }
  if ("error" in mcnemarNoCorr) {
    out.push(`McNemar (no correction): ${mcnemarNoCorr.error}`);
  } else {
    if (!absClose(mcnemarStat(mcnemarNoCorr, "McNemar's chi-square"), 4.0, 1e-4))
      out.push(
        `McNemar chi-square (uncorrected): ${mcnemarStat(mcnemarNoCorr, "McNemar's chi-square")}, plan says 4.0`,
      );
    if (!absClose(mcnemarStat(mcnemarNoCorr, "P value (McNemar's test)"), 0.0455, 1e-4))
      out.push(`McNemar P (uncorrected): ${mcnemarStat(mcnemarNoCorr, "P value (McNemar's test)")}, plan says 0.0455`);
  }
  // Error paths: McNemar on a 3×3 table, on a table with no discordant
  // pairs, and chi-square with a fractional count.
  const mcnemar3x3 = await runAnalysis("mcnemar", contingency3);
  if (!("error" in mcnemar3x3) || !mcnemar3x3.error.includes("2 × 2"))
    out.push(`McNemar on 3×3: ${JSON.stringify(mcnemar3x3)}, expected a "2 × 2" error`);
  const mcnemarNone = await runAnalysis("mcnemar", mcnemarNoDiscordant);
  if (!("error" in mcnemarNone) || !mcnemarNone.error.includes("discordant"))
    out.push(`McNemar with no discordant pairs: ${JSON.stringify(mcnemarNone)}, expected a "discordant" error`);
  const fractional = await runAnalysis("chi-square", contingencyFractional, { trendOrdered: true });
  if (!("error" in fractional) || !fractional.error.includes("whole numbers"))
    out.push(`Chi-square with a fractional count: ${JSON.stringify(fractional)}, expected a "whole numbers" error`);
  // Spline and Lowess (plan 15): the plan's values on doseLog (tolerances:
  // fitted ±0.01, spar/df ±0.01, RSS ±0.5), the boundary overshoot, the RSS
  // ordering, and the GCV overfit asserted as the overfit it is.
  const lowess = await runAnalysis("spline-lowess", doseLog, { y: "Response", method: "lowess", f: 2 / 3 });
  const spline = await runAnalysis("spline-lowess", doseLog, { y: "Response", method: "spline", f: 2 / 3, spar: 0.5 });
  const gcv = await runAnalysis("spline-lowess", doseLog, { y: "Response", method: "spline", f: 2 / 3 });
  const observed = [2.1, 3.4, 8.2, 19.5, 41.2, 68.9, 86.1, 94.2, 97.8, 99.1];
  const sStat = (r: AnalysisResult | { error: string }, label: string) =>
    "error" in r ? null : r.stats.find((s) => s.label === label)?.value;
  const close = (got: number | null | undefined, want: number, tol: number) =>
    got != null && Math.abs(got - want) <= tol;
  if ("error" in lowess) {
    out.push(`Lowess: ${lowess.error}`);
  } else {
    const fit = lowess.fitted ?? [];
    const want: [number, number][] = [
      [0, -1.0097],
      [4, 43.9129],
      [5, 63.6076],
      [6, 80.069],
      [7, 91.0026],
      [8, 96.4214],
      [9, 101.2181],
    ];
    for (const [i, w] of want)
      if (!close(fit[i]?.y, w, 0.01)) out.push(`Lowess fitted[${i}]: ${fit[i]?.y}, plan says ${w}`);
    if (!close(sStat(lowess, "Residual sum of squares"), 161.7778, 0.5))
      out.push(`Lowess RSS: ${sStat(lowess, "Residual sum of squares")}, plan says 161.7778`);
    // The boundary overshoot is correct Lowess behaviour, not a bug: the last
    // fitted value leaves the observed range.
    if (!(fit[9] != null && fit[9].y > 99.1))
      out.push(`Lowess boundary overshoot missing: fitted at X=1.5 is ${fit[9]?.y}, expected > 99.1`);
    if (fit.length !== 10 || lowess.curve?.length !== 100)
      out.push(`Lowess fitted/curve lengths: ${fit.length}/${lowess.curve?.length}, expected 10/100`);
    if (lowess.curve?.[0]?.x !== -3 || lowess.curve?.at(-1)?.x !== 1.5)
      out.push(`Lowess curve grid: [${lowess.curve?.[0]?.x}, ${lowess.curve?.at(-1)?.x}], expected [-3, 1.5]`);
    if (lowess.fitted?.some((p, i) => p.observed !== observed[i]))
      out.push(`Lowess fitted observed values do not match the table`);
    if (lowess.equation !== undefined) out.push(`Lowess carries an equation — a smoother has none`);
    if (!lowess.notes.includes("descriptive"))
      out.push(`Lowess notes missing the descriptive reading aid: ${lowess.notes}`);
    if (lowess.stats.some((s) => s.label === "Effective degrees of freedom"))
      out.push(`Lowess reports an effective df — it has no closed-form df`);
  }
  if ("error" in spline) {
    out.push(`Spline spar=0.5: ${spline.error}`);
  } else {
    const fit = spline.fitted ?? [];
    const want = [-3.7016, 3.8447, 13.5642, 27.1787, 44.5394, 63.0041, 78.9725, 90.5762, 98.3521, 104.1698];
    want.forEach((w, i) => {
      if (!close(fit[i]?.y, w, 0.01)) out.push(`Spline fitted[${i}]: ${fit[i]?.y}, plan says ${w}`);
    });
    if (!close(sStat(spline, "Effective degrees of freedom"), 3.7193, 0.01))
      out.push(`Spline df: ${sStat(spline, "Effective degrees of freedom")}, plan says 3.7193`);
    if (!close(sStat(spline, "Smoothing parameter (spar)"), 0.5, 0.01))
      out.push(`Spline spar: ${sStat(spline, "Smoothing parameter (spar)")}, plan says 0.5`);
    if (!close(sStat(spline, "Residual sum of squares"), 257.449, 0.5))
      out.push(`Spline RSS: ${sStat(spline, "Residual sum of squares")}, plan says 257.449`);
    if (spline.curve?.length !== 100) out.push(`Spline curve length: ${spline.curve?.length}, expected 100`);
    if (!spline.notes.includes("spar = 0.5")) out.push(`Spline notes do not name the spar used: ${spline.notes}`);
    // The smoother spline (df 3.72) has the larger RSS here.
    const rssL = sStat(lowess, "Residual sum of squares");
    const rssS = sStat(spline, "Residual sum of squares");
    if (rssL == null || rssS == null || !(rssS > rssL))
      out.push(`RSS ordering: spline ${rssS} should exceed Lowess ${rssL}`);
  }
  if ("error" in gcv) {
    out.push(`Spline GCV: ${gcv.error}`);
  } else {
    const df = sStat(gcv, "Effective degrees of freedom");
    const spar = sStat(gcv, "Smoothing parameter (spar)");
    const maxDiff = Math.max(...(gcv.fitted ?? []).map((p, i) => Math.abs(p.y - observed[i])));
    if (df == null || !(df > 9)) out.push(`Spline GCV df: ${df}, expected > 9 (the overfit)`);
    if (!close(spar, -1.226, 0.01)) out.push(`Spline GCV spar: ${spar}, plan says ≈ -1.226`);
    if (!(maxDiff < 1e-6)) out.push(`Spline GCV fitted ≠ observed: max |diff| ${maxDiff}, expected < 1e-6`);
    if (!gcv.notes.includes("generalized cross-validation"))
      out.push(`Spline GCV notes do not name the GCV choice: ${gcv.notes}`);
  }
  // The validation errors.
  const errCases: [string, object, string][] = [
    ["f = 0", { y: "Response", method: "lowess", f: 0 }, "between 0 and 1"],
    ["f = 1.5", { y: "Response", method: "lowess", f: 1.5 }, "between 0 and 1"],
    ["spar = 2", { y: "Response", method: "spline", f: 2 / 3, spar: 2 }, "between 0 and 1.5"],
    ["spar + df", { y: "Response", method: "spline", f: 2 / 3, spar: 0.5, df: 4 }, "not both"],
  ];
  for (const [label, params, want] of errCases) {
    const r = await runAnalysis("spline-lowess", doseLog, params as AnalysisParams);
    if (!("error" in r) || !r.error.toLowerCase().includes(want))
      out.push(`Spline/Lowess ${label}: ${"error" in r ? r.error : "ran"}, expected an error naming “${want}”`);
  }
  const smoothTooFewRun = await runAnalysis("spline-lowess", smoothTooFew, {
    y: "Response",
    method: "lowess",
    f: 2 / 3,
  });
  if (!("error" in smoothTooFewRun) || !smoothTooFewRun.error.toLowerCase().includes("at least 4"))
    out.push(
      `Spline/Lowess n < 4: ${"error" in smoothTooFewRun ? smoothTooFewRun.error : "ran"}, expected “at least 4 points”`,
    );
  // The smooth-curve graph draws the linked analysis's curve over the points:
  // 100 grid points, spanning exactly the data range, plus the 10 points.
  if (!("error" in lowess)) {
    const { addSmoothCurve } = await import("../src/views/graphs/smooth-curve");
    const opts = { ...newGraphOptions("smooth-curve"), smoothShowCurve: true };
    const cols = plotColumns(readTable(doseLog), "smooth-curve", opts, "xy");
    const fig = GRAPHS["smooth-curve"].build(cols, opts, paintOf(opts, 1), readTable(doseLog).titles);
    addSmoothCurve(fig, cols, opts, lowess, paintOf(opts, 1));
    const traces = fig.data as { mode?: string; x?: number[]; y?: number[] }[];
    const curve = traces.find((t) => t.mode === "lines" && t.x?.length === 100);
    const points = traces.find((t) => t.mode === "markers" && t.x?.length === 10);
    if (!curve) out.push(`Smooth curve graph draws no 100-point line`);
    if (curve && (curve.x?.[0] !== -3 || curve.x?.at(-1) !== 1.5))
      out.push(`Smooth curve line spans [${curve.x?.[0]}, ${curve.x?.at(-1)}], expected [-3, 1.5]`);
    if (!points) out.push(`Smooth curve graph draws no 10-point scatter`);
    // No linked analysis: points only, no line.
    const fig2 = GRAPHS["smooth-curve"].build(cols, opts, paintOf(opts, 1), readTable(doseLog).titles);
    addSmoothCurve(fig2, cols, opts, null, paintOf(opts, 1));
    if ((fig2.data as { mode?: string }[]).some((t) => t.mode === "lines"))
      out.push(`Smooth curve graph draws a line with no analysis linked`);
    // Falling back to fitted points when an old result has no curve.
    const old = { ...lowess, curve: undefined };
    const fig3 = GRAPHS["smooth-curve"].build(cols, opts, paintOf(opts, 1), readTable(doseLog).titles);
    addSmoothCurve(fig3, cols, opts, old, paintOf(opts, 1));
    const fallback = (fig3.data as { mode?: string; x?: number[] }[]).find(
      (t) => t.mode === "lines" && t.x?.length === 10,
    );
    if (!fallback) out.push(`Smooth curve graph does not fall back to joining fitted points`);
  }
  // The wizard asks method, then the Y series, then span (Lowess) or spar (spline).
  const asked = (a: Record<string, string>) =>
    WIZARDS["spline-lowess"]!.questions(a, readTable(doseLog)).flatMap((q) => (q ? [q.id] : []));
  if (JSON.stringify(asked({})) !== JSON.stringify(["method", "y"]))
    out.push(`Spline/Lowess wizard first steps: ${JSON.stringify(asked({}))}, expected ["method", "y"]`);
  if (JSON.stringify(asked({ method: "lowess" })) !== JSON.stringify(["method", "y", "f"]))
    out.push(
      `Spline/Lowess wizard (Lowess): ${JSON.stringify(asked({ method: "lowess" }))}, expected ["method", "y", "f"]`,
    );
  if (JSON.stringify(asked({ method: "spline" })) !== JSON.stringify(["method", "y", "spar"]))
    out.push(
      `Spline/Lowess wizard (spline): ${JSON.stringify(asked({ method: "spline" }))}, expected ["method", "y", "spar"]`,
    );
  // Outliers wizard (plan 24): method first, then Q (ROUT) or alpha +
  // iterate (Grubbs); ROUT stays the default and carries no alpha/iterate,
  // Grubbs carries no q.
  const outAsked = (a: Record<string, string>) =>
    WIZARDS["outliers"]!.questions(a, readTable(column)).flatMap((q) => (q ? [q.id] : []));
  if (JSON.stringify(outAsked({})) !== JSON.stringify(["sets", "method", "q"]))
    out.push(`Outliers wizard first steps: ${JSON.stringify(outAsked({}))}, expected ["sets", "method", "q"]`);
  if (JSON.stringify(outAsked({ method: "rout" })) !== JSON.stringify(["sets", "method", "q"]))
    out.push(`Outliers wizard (ROUT): ${JSON.stringify(outAsked({ method: "rout" }))}, expected ["sets", "method", "q"]`);
  if (JSON.stringify(outAsked({ method: "grubbs" })) !== JSON.stringify(["sets", "method", "alpha", "iterate"]))
    out.push(
      `Outliers wizard (Grubbs): ${JSON.stringify(outAsked({ method: "grubbs" }))}, expected ["sets", "method", "alpha", "iterate"]`,
    );
  const outRout = WIZARDS["outliers"]!.finish({ method: "rout", q: 1 }, readTable(column));
  if (JSON.stringify(outRout) !== JSON.stringify({ type: "outliers", params: { q: 1 } }))
    out.push(`Outliers wizard finish (ROUT): ${JSON.stringify(outRout)}`);
  const outGrubbs = WIZARDS["outliers"]!.finish({ method: "grubbs", alpha: 0.05, iterate: "yes" }, readTable(column));
  if (
    JSON.stringify(outGrubbs) !==
    JSON.stringify({ type: "outliers", params: { method: "grubbs", alpha: 0.05, iterate: true } })
  )
    out.push(`Outliers wizard finish (Grubbs): ${JSON.stringify(outGrubbs)}`);
  const outGrubbsOnce = WIZARDS["outliers"]!.finish({ method: "grubbs", alpha: 0.01, iterate: "no" }, readTable(column));
  if (
    JSON.stringify(outGrubbsOnce) !==
    JSON.stringify({ type: "outliers", params: { method: "grubbs", alpha: 0.01, iterate: false } })
  )
    out.push(`Outliers wizard finish (Grubbs, once): ${JSON.stringify(outGrubbsOnce)}`);
  // Binding — Saturation / Kinetics (plan 16): noiseless fixtures must
  // recover their generating parameters (relative tolerances from the plan:
  // 1e-6 one-site/kinetics, 1e-4 two-site specific, 1e-3 two-phase
  // association); every fitted parameter carries estimate + SE + t + p +
  // 95% CI; the two-series fits share NS/Background; the graph draws the
  // fitted curve (both branches for two-series); the validation errors
  // name their requirement.
  const bindCoef = (r: AnalysisResult | { error: string }, term: string) =>
    "error" in r ? null : (r.coefficients?.find((c) => c.term === term)?.estimate ?? null);
  const bindStat = (r: AnalysisResult | { error: string }, label: string) =>
    "error" in r ? null : (r.stats.find((s) => s.label === label)?.value ?? null);
  const closeRel = (got: number | null, want: number, tol: number) =>
    got != null && Math.abs(got - want) <= tol * Math.max(Math.abs(want), 1e-12);
  const bindChecks: [string, AnalysisResult | { error: string }, [string, number, number][]][] = [
    [
      "one-site total",
      await runAnalysis("binding-saturation", bindTotal, { model: "one-site-total" }),
      [
        ["Bmax", 100, 1e-6],
        ["Kd", 5, 1e-6],
        ["NS", 0.5, 1e-6],
        ["Background", 2, 1e-6],
      ],
    ],
    [
      "two-site specific",
      await runAnalysis("binding-saturation", bindTwoSite, { model: "two-site-specific" }),
      [
        ["BmaxHi", 60, 1e-4],
        ["KdHi", 1, 1e-4],
        ["BmaxLo", 40, 1e-4],
        ["KdLo", 20, 1e-4],
      ],
    ],
    [
      "one-site total + nonspecific",
      await runAnalysis("binding-saturation", bindTotalNs, {
        y: "Total",
        y2: "Nonspecific",
        model: "one-site-total-and-ns",
      }),
      [
        ["Bmax", 100, 1e-6],
        ["Kd", 5, 1e-6],
        ["NS", 0.5, 1e-6],
        ["Background", 2, 1e-6],
      ],
    ],
    [
      "two-site total + nonspecific",
      await runAnalysis("binding-saturation", bindTwoSiteNs, {
        y: "Total",
        y2: "Nonspecific",
        model: "two-site-total-and-ns",
      }),
      [
        ["BmaxHi", 60, 1e-4],
        ["KdHi", 1, 1e-4],
        ["BmaxLo", 40, 1e-4],
        ["KdLo", 20, 1e-4],
        ["NS", 0.5, 1e-4],
        ["Background", 2, 1e-4],
      ],
    ],
    [
      "association one-phase",
      await runAnalysis("binding-kinetics", bindKinetics, { y: "Assoc", model: "association-one-phase" }),
      [
        ["Plateau", 100, 1e-6],
        ["Kobs", 0.5, 1e-6],
      ],
    ],
    [
      "dissociation one-phase",
      await runAnalysis("binding-kinetics", bindKinetics, { y: "Dissoc", model: "dissociation-one-phase" }),
      [
        ["Y0", 100, 1e-6],
        ["Plateau", 5, 1e-6],
        ["Koff", 0.3, 1e-6],
      ],
    ],
    [
      "association two-phase",
      await runAnalysis("binding-kinetics", bindKinetics, { y: "TwoPhase", model: "association-two-phase" }),
      [
        ["Plateau", 100, 1e-3],
        ["PercentFast", 0.7, 1e-3],
        ["KFast", 1.0, 1e-3],
        ["KSlow", 0.1, 1e-3],
      ],
    ],
    [
      "dissociation two-phase",
      await runAnalysis("binding-kinetics", bindKinetics, { y: "Dissoc2", model: "dissociation-two-phase" }),
      [
        ["Y0", 100, 1e-3],
        ["Plateau", 5, 1e-3],
        ["PercentFast", 0.7, 1e-3],
        ["KFast", 1.0, 1e-3],
        ["KSlow", 0.1, 1e-3],
      ],
    ],
    [
      "association then dissociation",
      await runAnalysis("binding-kinetics", bindAssocThenDissoc, {
        model: "association-then-dissociation",
        hotNM: 1,
        time0: 10,
      }),
      [
        ["Kon", 1e8, 1e-6],
        ["Koff", 0.1, 1e-6],
        ["Bmax", 100, 1e-6],
        ["NS", 0.5, 1e-6],
      ],
    ],
  ];
  for (const [label, r, terms] of bindChecks) {
    if ("error" in r) {
      out.push(`Binding ${label}: ${r.error}`);
      continue;
    }
    for (const [term, want, tol] of terms) {
      const got = bindCoef(r, term);
      if (!closeRel(got, want, tol)) out.push(`Binding ${label} ${term}: ${got}, expected ${want}`);
    }
    // Every fitted parameter carries estimate + SE + t + p + 95% CI.
    for (const c of r.coefficients ?? []) {
      if (c.estimate == null || c.stdError == null || c.t == null || c.p == null || c.low == null || c.high == null)
        out.push(`Binding ${label} ${c.term}: missing estimate/SE/t/p/CI`);
    }
    if (bindStat(r, "R squared") !== 1 && label !== "association then dissociation") {
      // Two-series fits report the pooled R² under "R squared" too.
      const pooled = bindStat(r, "R squared");
      if (pooled == null || Math.abs(pooled - 1) > 1e-9) out.push(`Binding ${label} R²: ${pooled}, expected 1`);
    }
  }
  // Derived rows: half-lives, residence time, kinetic Kd, Eq.
  const assoc = await runAnalysis("binding-kinetics", bindKinetics, { y: "Assoc", model: "association-one-phase" });
  if (!closeRel(bindStat(assoc, "Half-life"), Math.LN2 / 0.5, 1e-6))
    out.push(`Binding association half-life: ${bindStat(assoc, "Half-life")}, expected ${Math.LN2 / 0.5}`);
  if (bindCoef(assoc, "Y0") != null && Math.abs(bindCoef(assoc, "Y0")!) > 1e-6)
    out.push(`Binding association Y0: ${bindCoef(assoc, "Y0")}, expected 0`);
  const dissoc = await runAnalysis("binding-kinetics", bindKinetics, { y: "Dissoc", model: "dissociation-one-phase" });
  if (!closeRel(bindStat(dissoc, "Half-life"), Math.LN2 / 0.3, 1e-6))
    out.push(`Binding dissociation half-life: ${bindStat(dissoc, "Half-life")}, expected ${Math.LN2 / 0.3}`);
  if (!closeRel(bindStat(dissoc, "Residence time"), 1 / 0.3, 1e-6))
    out.push(`Binding dissociation residence time: ${bindStat(dissoc, "Residence time")}, expected ${1 / 0.3}`);
  const kon = await runAnalysis("binding-kinetics", bindKinetics, {
    y: "Assoc",
    model: "association-one-phase",
    ligandConcentration: 10,
    koff: 0.3,
  });
  if (!closeRel(bindStat(kon, "kon"), 0.02, 1e-6))
    out.push(`Binding derived kon: ${bindStat(kon, "kon")}, expected 0.02`);
  if (!closeRel(bindStat(kon, "Kinetic Kd"), 15, 1e-6))
    out.push(`Binding derived kinetic Kd: ${bindStat(kon, "Kinetic Kd")}, expected 15`);
  const konNoKoff = await runAnalysis("binding-kinetics", bindKinetics, {
    y: "Assoc",
    model: "association-one-phase",
    ligandConcentration: 10,
  });
  if (!("error" in konNoKoff) && bindStat(konNoKoff, "kon") != null)
    out.push(`Binding kon without Koff: ${bindStat(konNoKoff, "kon")}, expected none`);
  if (!("error" in konNoKoff) && !konNoKoff.notes.includes("dissociation experiment"))
    out.push(`Binding kon without Koff: notes do not say a dissociation experiment is needed`);
  const atd = await runAnalysis("binding-kinetics", bindAssocThenDissoc, {
    model: "association-then-dissociation",
    hotNM: 1,
    time0: 10,
  });
  if (!closeRel(bindStat(atd, "Kinetic Kd (nM)"), 1, 1e-6))
    out.push(`Binding assoc-then-dissoc kinetic Kd: ${bindStat(atd, "Kinetic Kd (nM)")}, expected 1 nM`);
  if (!closeRel(bindStat(atd, "Eq"), 50, 1e-6))
    out.push(`Binding assoc-then-dissoc Eq: ${bindStat(atd, "Eq")}, expected 50`);
  if (!closeRel(bindStat(atd, "R squared"), 1, 1e-9))
    out.push(`Binding assoc-then-dissoc R²: ${bindStat(atd, "R squared")}, expected 1`);
  // Two-series fits: R² per series + pooled, N per series, shared NS/Background noted.
  const twoSeries = await runAnalysis("binding-saturation", bindTotalNs, {
    y: "Total",
    y2: "Nonspecific",
    model: "one-site-total-and-ns",
  });
  if (!closeRel(bindStat(twoSeries, "R squared (total)"), 1, 1e-9))
    out.push(`Binding two-series R² (total): ${bindStat(twoSeries, "R squared (total)")}, expected 1`);
  if (!closeRel(bindStat(twoSeries, "R squared (nonspecific)"), 1, 1e-9))
    out.push(`Binding two-series R² (nonspecific): ${bindStat(twoSeries, "R squared (nonspecific)")}, expected 1`);
  if (bindStat(twoSeries, "N (total)") !== 8 || bindStat(twoSeries, "N (nonspecific)") !== 8)
    out.push(
      `Binding two-series N: ${bindStat(twoSeries, "N (total)")}/${bindStat(twoSeries, "N (nonspecific)")}, expected 8/8`,
    );
  if (!("error" in twoSeries) && !twoSeries.notes.includes("shared between the two series"))
    out.push(`Binding two-series notes do not say NS/Background are shared`);
  // Validation errors.
  const bindErrCases: [string, TableData, AnalysisType, AnalysisParams, string][] = [
    [
      "two-site < 10 points",
      bindTwoSiteFew,
      "binding-saturation",
      { model: "two-site-specific" },
      "at least 10 points",
    ],
    ["negative concentration", bindNegX, "binding-saturation", { model: "one-site-total" }, "can't be negative"],
    [
      "two-series < 5 points",
      bindTotalNsFew,
      "binding-saturation",
      { y: "Total", y2: "Nonspecific", model: "one-site-total-and-ns" },
      "at least 5",
    ],
    [
      "Time0 outside range",
      bindAssocThenDissoc,
      "binding-kinetics",
      { model: "association-then-dissociation", hotNM: 1, time0: 100 },
      "strictly inside",
    ],
  ];
  for (const [label, tableData, type, params, want] of bindErrCases) {
    const r = await runAnalysis(type, tableData, params);
    if (!("error" in r) || !r.error.includes(want))
      out.push(`Binding ${label}: ${"error" in r ? r.error : "ran"}, expected an error naming “${want}”`);
  }
  // The binding-curve graph draws the fitted curve over the points (101
  // points spanning exactly the data range), and both branches for a
  // two-series fit — the nonspecific curve dashed in its own colour.
  if (!("error" in twoSeries)) {
    const { addBindingCurve } = await import("../src/views/graphs/binding-curve");
    const opts = newGraphOptions("dose-response");
    const cols = plotColumns(readTable(bindTotalNs), "dose-response", opts, "xy");
    const fig = GRAPHS["dose-response"].build(cols, opts, paintOf(opts, 2), readTable(bindTotalNs).titles);
    addBindingCurve(
      fig,
      cols,
      opts,
      twoSeries,
      { y: "Total", y2: "Nonspecific", model: "one-site-total-and-ns" },
      paintOf(opts, 2),
    );
    const traces = fig.data as { mode?: string; x?: number[]; y?: number[]; line?: { dash?: string } }[];
    const curves = traces.filter((t) => t.mode === "lines" && t.x?.length === 101);
    if (curves.length !== 2) out.push(`Binding curve graph draws ${curves.length} 101-point lines, expected 2`);
    const [total, ns] = curves;
    if (total && (total.x?.[0] !== 0 || total.x?.at(-1) !== 50))
      out.push(`Binding total curve spans [${total.x?.[0]}, ${total.x?.at(-1)}], expected [0, 50]`);
    if (total && total.y) {
      const at5 = total.y[10];
      if (at5 == null || Math.abs(at5 - 54.5) > 1e-6) out.push(`Binding total curve at X=5: ${at5}, expected 54.5`);
    }
    if (ns && ns.line?.dash !== "dash") out.push(`Binding nonspecific curve is not dashed`);
    if (ns && ns.y) {
      const at5 = ns.y[10];
      if (at5 == null || Math.abs(at5 - 4.5) > 1e-6) out.push(`Binding nonspecific curve at X=5: ${at5}, expected 4.5`);
    }
    const note = (fig.layout.annotations as { text?: string }[] | undefined)?.find((a) => a.text?.includes("Bmax"));
    if (!note) out.push(`Binding curve graph draws no Bmax note`);
    // Kinetics curve: starts at Y0 (0), not forced through the origin.
    const fig2 = GRAPHS["dose-response"].build(
      plotColumns(readTable(bindKinetics), "dose-response", opts, "xy"),
      opts,
      paintOf(opts, 4),
      readTable(bindKinetics).titles,
    );
    if (!("error" in assoc)) {
      addBindingCurve(
        fig2,
        plotColumns(readTable(bindKinetics), "dose-response", opts, "xy"),
        opts,
        assoc,
        { y: "Assoc", model: "association-one-phase" },
        paintOf(opts, 4),
      );
      const kTraces = fig2.data as { mode?: string; x?: number[]; y?: number[] }[];
      const kCurve = kTraces.find((t) => t.mode === "lines" && t.x?.length === 101);
      if (!kCurve) out.push(`Binding kinetics graph draws no 101-point line`);
      if (kCurve && kCurve.y?.[0] != null && Math.abs(kCurve.y[0]) > 1e-6)
        out.push(`Binding kinetics curve at t=0: ${kCurve.y[0]}, expected Y0 = 0`);
      if (kCurve && kCurve.y?.[100] != null && Math.abs(kCurve.y[100] - 99.944691563) > 1e-3)
        out.push(`Binding kinetics curve at t=15: ${kCurve.y[100]}, expected 99.9447`);
    }
  }
  // The wizards ask Y, then model, then (two-series) the nonspecific series;
  // kinetics adds the optional kon constants, and HotNM/Time0 for
  // association-then-dissociation.
  const satAsked = (a: Record<string, string>) =>
    WIZARDS["binding-saturation"]!.questions(a, readTable(bindTotalNs)).flatMap((q) => (q ? [q.id] : []));
  if (JSON.stringify(satAsked({})) !== JSON.stringify(["y", "model"]))
    out.push(`Binding saturation wizard first steps: ${JSON.stringify(satAsked({}))}, expected ["y", "model"]`);
  if (JSON.stringify(satAsked({ model: "one-site-total-and-ns" })) !== JSON.stringify(["y", "model", "y2"]))
    out.push(
      `Binding saturation wizard (two-series): ${JSON.stringify(satAsked({ model: "one-site-total-and-ns" }))}, expected ["y", "model", "y2"]`,
    );
  const kinAsked = (a: Record<string, string>) =>
    WIZARDS["binding-kinetics"]!.questions(a, readTable(bindKinetics)).flatMap((q) => (q ? [q.id] : []));
  if (JSON.stringify(kinAsked({})) !== JSON.stringify(["y", "model"]))
    out.push(`Binding kinetics wizard first steps: ${JSON.stringify(kinAsked({}))}, expected ["y", "model"]`);
  if (
    JSON.stringify(kinAsked({ model: "association-one-phase" })) !==
    JSON.stringify(["y", "model", "ligandConcentration", "koff"])
  )
    out.push(
      `Binding kinetics wizard (association): ${JSON.stringify(kinAsked({ model: "association-one-phase" }))}, expected ["y", "model", "ligandConcentration", "koff"]`,
    );
  if (
    JSON.stringify(kinAsked({ model: "association-then-dissociation" })) !==
    JSON.stringify(["y", "model", "hotNM", "time0"])
  )
    out.push(
      `Binding kinetics wizard (assoc-then-dissoc): ${JSON.stringify(kinAsked({ model: "association-then-dissociation" }))}, expected ["y", "model", "hotNM", "time0"]`,
    );
  // Binding — Competition (plan 28): Fit Ki (Cheng–Prusoff) on the one-site
  // inhibitor fit and the two-site fits, the two-site logx/x fits and the
  // homologous fit on noiseless fixtures (relative tolerance 1e-4 two-site,
  // 1e-6 homologous/one-site), the validation errors, the degenerate-fraction
  // note, and the overlays (TS evaluator vs R).
  // DEVIATIONS from the plan, verified in R before implementing:
  // (1) the plan's one-site values (Bottom 1.278, Top 99.242, LogIC50
  // −0.8420, HillSlope 0.9770) are the 4PL fit of the RISING doseLog table,
  // not the inhibitor 3PL (fixed slope −1) on doseFall — the 3PL gives
  // Bottom 1.0358, Top 98.4084, LogIC50 −0.84155, and has no HillSlope term.
  // The Ki assertion still holds: IC50 0.14403 / 3 = 0.04801.
  // (2) Prism's built-in two-site model fixes both Hill slopes at −1, so
  // there is no HillSlope coefficient (the plan's equation is Prism's older
  // classic form); the default Gauss-Newton nls fails on noiseless
  // two-site/homologous data, so both fit with algorithm "port".
  const compCoef = (r: AnalysisResult | { error: string }, term: string) =>
    "error" in r ? null : (r.coefficients?.find((c) => c.term === term)?.estimate ?? null);
  const compFit = (r: AnalysisResult | { error: string }, label: string) =>
    "error" in r ? null : (r.fit?.rows.find((row) => row.label === label)?.values?.[0] ?? null);
  const compClose = (got: number | null, want: number, tol: number) =>
    got != null && Math.abs(got - want) <= tol;
  const compCloseRel = (got: number | null, want: number, tol: number) =>
    got != null && Math.abs(got - want) <= tol * Math.max(Math.abs(want), 1e-12);
  // One-site Fit Ki on doseFall ([L] = 1, Kd = 0.5 → divisor 3).
  const fitKi = await runAnalysis("nonlinear-regression", doseFall, {
    model: "inhibitor-3pl-logx",
    fitKi: true,
    ligandConcentration: 1,
    ligandKd: 0.5,
  });
  for (const [term, want] of [
    ["Bottom", 1.0358],
    ["Top", 98.4084],
    ["LogIC50", -0.84155],
  ] as const) {
    if (!compClose(compCoef(fitKi, term), want, 0.01))
      out.push(`Competition one-site ${term}: ${compCoef(fitKi, term)}, expected ${want}`);
  }
  if (!compClose(compFit(fitKi, "IC50"), 0.14403, 0.002))
    out.push(`Competition one-site IC50: ${compFit(fitKi, "IC50")}, expected 0.14403`);
  if (!compClose(compFit(fitKi, "Ki"), 0.04801, 0.002))
    out.push(`Competition one-site Ki: ${compFit(fitKi, "Ki")}, expected 0.04801`);
  if (!("error" in fitKi) && !fitKi.notes.includes("[L] = 1"))
    out.push(`Competition Fit Ki notes do not name [L] = 1: ${fitKi.notes}`);
  if (!("error" in fitKi) && !fitKi.notes.includes("Kd = 0.5"))
    out.push(`Competition Fit Ki notes do not name Kd = 0.5: ${fitKi.notes}`);
  // Without Fit Ki, the same fit reports no Ki row.
  const fitNoKi = await runAnalysis("nonlinear-regression", doseFall, { model: "inhibitor-3pl-logx" });
  if (!("error" in fitNoKi) && fitNoKi.fit?.rows.some((row) => row.label === "Ki"))
    out.push(`Competition one-site without Fit Ki reports a Ki row`);
  // Two-site logx: recovers the constructed parameters; Fit Ki divides each
  // IC50 by the same divisor 3.
  const twoSite = await runAnalysis("nonlinear-regression", competitionTwoSite, {
    model: "two-site-competition-logx",
  });
  for (const [term, want] of [
    ["Bottom", 0],
    ["Top", 100],
    ["LogIC50Hi", -2],
    ["LogIC50Lo", 1],
    ["FractionHi", 0.5],
  ] as const) {
    // Bottom's target is 0, so a relative check is meaningless (R's
    // noiseless fit lands ~1e-7 off zero); absolute tolerance for it.
    const ok =
      term === "Bottom"
        ? compClose(compCoef(twoSite, term), want, 1e-6)
        : compCloseRel(compCoef(twoSite, term), want, 1e-4);
    if (!ok) out.push(`Competition two-site ${term}: ${compCoef(twoSite, term)}, expected ${want}`);
  }
  if (!compCloseRel(compFit(twoSite, "IC50 (high affinity)"), 0.01, 1e-4))
    out.push(`Competition two-site IC50 (high affinity): ${compFit(twoSite, "IC50 (high affinity)")}, expected 0.01`);
  if (!compCloseRel(compFit(twoSite, "IC50 (low affinity)"), 10, 1e-4))
    out.push(`Competition two-site IC50 (low affinity): ${compFit(twoSite, "IC50 (low affinity)")}, expected 10`);
  if (!compCloseRel(compFit(twoSite, "R squared"), 1, 1e-9))
    out.push(`Competition two-site R²: ${compFit(twoSite, "R squared")}, expected 1`);
  const twoSiteKi = await runAnalysis("nonlinear-regression", competitionTwoSite, {
    model: "two-site-competition-logx",
    fitKi: true,
    ligandConcentration: 1,
    ligandKd: 0.5,
  });
  if (!compCloseRel(compFit(twoSiteKi, "Ki (high affinity)"), 0.01 / 3, 1e-4))
    out.push(`Competition two-site Ki (high affinity): ${compFit(twoSiteKi, "Ki (high affinity)")}, expected ${0.01 / 3}`);
  if (!compCloseRel(compFit(twoSiteKi, "Ki (low affinity)"), 10 / 3, 1e-4))
    out.push(`Competition two-site Ki (low affinity): ${compFit(twoSiteKi, "Ki (low affinity)")}, expected ${10 / 3}`);
  // Two-site -x on raw concentrations.
  const twoSiteX = await runAnalysis("nonlinear-regression", competitionTwoSiteRaw, {
    model: "two-site-competition-x",
  });
  for (const [term, want] of [
    ["Bottom", 0],
    ["Top", 100],
    ["IC50Hi", 0.01],
    ["IC50Lo", 10],
    ["FractionHi", 0.5],
  ] as const) {
    const ok =
      term === "Bottom"
        ? compClose(compCoef(twoSiteX, term), want, 1e-6)
        : compCloseRel(compCoef(twoSiteX, term), want, 1e-4);
    if (!ok) out.push(`Competition two-site -x ${term}: ${compCoef(twoSiteX, term)}, expected ${want}`);
  }
  if (!compCloseRel(compFit(twoSiteX, "R squared"), 1, 1e-9))
    out.push(`Competition two-site -x R²: ${compFit(twoSiteX, "R squared")}, expected 1`);
  // Homologous ([L] = 1): Bmax 100, Kd 0.5, Bottom 0; IC50 = [L] + Kd = 1.5.
  const homol = await runAnalysis("nonlinear-regression", competitionHomologous, {
    model: "homologous-competition-logx",
    ligandConcentration: 1,
  });
  for (const [term, want] of [
    ["Bmax", 100],
    ["LogKd", -0.30103],
    ["Bottom", 0],
  ] as const) {
    const ok =
      term === "Bottom"
        ? compClose(compCoef(homol, term), want, 1e-6)
        : compCloseRel(compCoef(homol, term), want, 1e-6);
    if (!ok) out.push(`Competition homologous ${term}: ${compCoef(homol, term)}, expected ${want}`);
  }
  if (!compCloseRel(compFit(homol, "Kd"), 0.5, 1e-6))
    out.push(`Competition homologous Kd: ${compFit(homol, "Kd")}, expected 0.5`);
  if (!compCloseRel(compFit(homol, "IC50"), 1.5, 1e-6))
    out.push(`Competition homologous IC50: ${compFit(homol, "IC50")}, expected 1.5`);
  if (!compCloseRel(compFit(homol, "R squared"), 1, 1e-9))
    out.push(`Competition homologous R²: ${compFit(homol, "R squared")}, expected 1`);
  if (!("error" in homol) && !homol.notes.includes("Kd = Ki"))
    out.push(`Competition homologous notes do not say Kd = Ki: ${homol.notes}`);
  if (!("error" in homol) && homol.ligandConcentration !== 1)
    out.push(`Competition homologous result does not carry [L] = 1`);
  // Validation errors name the missing radioligand values.
  const compErrCases: [string, TableData, AnalysisParams, string][] = [
    [
      "Fit Ki without [L]/Kd",
      doseFall,
      { model: "inhibitor-3pl-logx", fitKi: true },
      "radioligand concentration",
    ],
    [
      "Fit Ki without Kd",
      doseFall,
      { model: "inhibitor-3pl-logx", fitKi: true, ligandConcentration: 1 },
      "radioligand concentration",
    ],
    [
      "homologous without [L]",
      competitionHomologous,
      { model: "homologous-competition-logx" },
      "radioligand concentration",
    ],
  ];
  for (const [label, tableData, params, want] of compErrCases) {
    const r = await runAnalysis("nonlinear-regression", tableData, params);
    if (!("error" in r) || !r.error.includes(want))
      out.push(`Competition ${label}: ${"error" in r ? r.error : "ran"}, expected an error naming “${want}”`);
  }
  // Degenerate two-site: on the noisy one-site (doseFall) data the fit
  // converges with the high-affinity fraction dominant; on noiseless
  // one-site data it does not converge (singular) and says so plainly, or
  // converges onto a single site and notes it — either is the plan's
  // handling, never a silent garbage fit.
  const twoSiteOneSite = await runAnalysis("nonlinear-regression", doseFall, {
    model: "two-site-competition-logx",
  });
  if ("error" in twoSiteOneSite)
    out.push(`Competition two-site on one-site data errored: ${twoSiteOneSite.error}`);
  else if (compCoef(twoSiteOneSite, "FractionHi") == null || compCoef(twoSiteOneSite, "FractionHi")! < 0.9)
    out.push(
      `Competition two-site on one-site data FractionHi: ${compCoef(twoSiteOneSite, "FractionHi")}, expected > 0.9`,
    );
  const oneSiteNoiseless = table(
    ["Title", "X", "Response"],
    [
      ["", "-3", "99.0099009901"],
      ["", "-2.5", "96.9346569968"],
      ["", "-2", "90.9090909091"],
      ["", "-1.5", "75.9746926648"],
      ["", "-1", "50"],
      ["", "-0.5", "24.0253073352"],
      ["", "0", "9.0909090909"],
      ["", "0.5", "3.0653430032"],
      ["", "1", "0.9900990099"],
      ["", "1.5", "0.3152309183"],
    ],
  );
  const twoSiteSingular = await runAnalysis("nonlinear-regression", oneSiteNoiseless, {
    model: "two-site-competition-logx",
  });
  if ("error" in twoSiteSingular) {
    if (!twoSiteSingular.error.includes("did not converge"))
      out.push(`Competition two-site singular error: ${twoSiteSingular.error}, expected the non-convergence wording`);
  } else if (!twoSiteSingular.notes.includes("consistent with one site")) {
    out.push(`Competition two-site on noiseless one-site data: ${twoSiteSingular.notes}`);
  }
  // A curve that is 99% high-affinity sites fires the one-site note.
  const mostlyHi = table(
    ["Title", "X", "Response"],
    [
      ["", "-3", "90.99990001"],
      ["", "-2.5", "76.2146296104"],
      ["", "-2", "50.499000999"],
      ["", "-1.5", "24.7819019527"],
      ["", "-1", "9.9900990099"],
      ["", "-0.5", "4.0040361431"],
      ["", "0", "1.8892889289"],
      ["", "0.5", "1.0718255358"],
      ["", "1", "0.5989010989"],
      ["", "1.5", "0.2715497253"],
    ],
  );
  const twoSiteMostlyHi = await runAnalysis("nonlinear-regression", mostlyHi, {
    model: "two-site-competition-logx",
  });
  if ("error" in twoSiteMostlyHi)
    out.push(`Competition two-site on 99%-high-affinity data errored: ${twoSiteMostlyHi.error}`);
  else {
    if (!compCloseRel(compCoef(twoSiteMostlyHi, "FractionHi"), 0.99, 1e-4))
      out.push(
        `Competition two-site 99%-high-affinity FractionHi: ${compCoef(twoSiteMostlyHi, "FractionHi")}, expected 0.99`,
      );
    if (!twoSiteMostlyHi.notes.includes("consistent with one site"))
      out.push(`Competition two-site 99%-high-affinity notes: ${twoSiteMostlyHi.notes}`);
  }
  // Overlays: the two-site and homologous curves pass through the data's
  // endpoints, decrease monotonically, and the TypeScript evaluator matches
  // an independent R evaluation of the fitted formula at the data X to 1e-6.
  const { addDoseCurve, evaluateFittedCurve } = await import("../src/views/graphs/dose-response-curve");
  const compXs = [-3, -2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5];
  if (!("error" in twoSite)) {
    const opts = {
      ...newGraphOptions("dose-response"),
      doseModel: "two-site-competition-logx" as const,
      doseY: "Response",
    };
    const cols = plotColumns(readTable(competitionTwoSite), "dose-response", opts, "xy");
    const fig = GRAPHS["dose-response"].build(cols, opts, paintOf(opts, 1), readTable(competitionTwoSite).titles);
    addDoseCurve(fig, cols, opts, twoSite, paintOf(opts, 1));
    const traces = fig.data as { mode?: string; x?: number[]; y?: number[] }[];
    const curve = traces.find((t) => t.mode === "lines" && t.x?.length === 101);
    if (!curve) out.push(`Competition two-site overlay draws no 101-point line`);
    if (curve) {
      if (curve.x?.[0] !== -3 || curve.x?.at(-1) !== 1.5)
        out.push(`Competition two-site overlay spans [${curve.x?.[0]}, ${curve.x?.at(-1)}], expected [-3, 1.5]`);
      if (curve.y?.[0] == null || Math.abs(curve.y[0] - 95.4495459545) > 1e-6)
        out.push(`Competition two-site overlay start: ${curve.y?.[0]}, expected 95.4495 at X=-3`);
      const lastY = curve.y?.at(-1);
      if (lastY == null || Math.abs(lastY - 12.0284600575) > 1e-6)
        out.push(`Competition two-site overlay end: ${lastY}, expected 12.0285 at X=1.5`);
      if (curve.y?.some((v, i, a) => i > 0 && v >= a[i - 1]!))
        out.push(`Competition two-site overlay is not monotone decreasing`);
    }
    const anns = (fig.layout.annotations as { text?: string }[] | undefined) ?? [];
    if (!anns.some((a) => a.text?.includes("IC50 (high affinity) = 0.01")))
      out.push(`Competition two-site overlay note missing IC50s: ${JSON.stringify(anns.map((a) => a.text))}`);
    const b = compCoef(twoSite, "Bottom")!;
    const t = compCoef(twoSite, "Top")!;
    const f = compCoef(twoSite, "FractionHi")!;
    const l1 = compCoef(twoSite, "LogIC50Hi")!;
    const l2 = compCoef(twoSite, "LogIC50Lo")!;
    const rY = await evalNamedVector(
      `x<-c(${compXs.join(",")});yv<-${b.toPrecision(15)}+(${t.toPrecision(15)}-${b.toPrecision(15)})*(${f.toPrecision(15)}/(1+10^(x-${l1.toPrecision(15)}))+(1-${f.toPrecision(15)})/(1+10^(x-${l2.toPrecision(15)})));` +
        `c(${compXs.map((_, i) => `y${i}=yv[${i + 1}]`).join(",")})`,
    );
    compXs.forEach((x, i) => {
      const ts = evaluateFittedCurve("two-site-competition-logx", twoSite.coefficients ?? [], x);
      const rv = rY[`y${i}`];
      if (rv == null || Math.abs(ts - rv) > 1e-6)
        out.push(`Competition two-site overlay at X=${x}: TS ${ts}, R ${rv}`);
    });
  }
  if (!("error" in homol)) {
    const opts = {
      ...newGraphOptions("dose-response"),
      doseModel: "homologous-competition-logx" as const,
      doseY: "Response",
    };
    const cols = plotColumns(readTable(competitionHomologous), "dose-response", opts, "xy");
    const fig = GRAPHS["dose-response"].build(cols, opts, paintOf(opts, 1), readTable(competitionHomologous).titles);
    addDoseCurve(fig, cols, opts, homol, paintOf(opts, 1));
    const traces = fig.data as { mode?: string; x?: number[]; y?: number[] }[];
    const curve = traces.find((t) => t.mode === "lines" && t.x?.length === 101);
    if (!curve) out.push(`Competition homologous overlay draws no 101-point line`);
    if (curve) {
      if (curve.y?.[0] == null || Math.abs(curve.y[0] - 66.6222518321) > 1e-6)
        out.push(`Competition homologous overlay start: ${curve.y?.[0]}, expected 66.6223 at X=-3`);
      const lastY = curve.y?.at(-1);
      if (lastY == null || Math.abs(lastY - 3.0190705689) > 1e-6)
        out.push(`Competition homologous overlay end: ${lastY}, expected 3.0191 at X=1.5`);
      if (curve.y?.some((v, i, a) => i > 0 && v >= a[i - 1]!))
        out.push(`Competition homologous overlay is not monotone decreasing`);
    }
    const anns = (fig.layout.annotations as { text?: string }[] | undefined) ?? [];
    if (!anns.some((a) => a.text?.includes("Kd = 0.5")))
      out.push(`Competition homologous overlay note missing Kd: ${JSON.stringify(anns.map((a) => a.text))}`);
    const bmax = compCoef(homol, "Bmax")!;
    const logKd = compCoef(homol, "LogKd")!;
    const bottom = compCoef(homol, "Bottom")!;
    const rY = await evalNamedVector(
      `x<-c(${compXs.join(",")});yv<-${bmax.toPrecision(15)}*1/(1+10^x+10^${logKd.toPrecision(15)})+${bottom.toPrecision(15)};` +
        `c(${compXs.map((_, i) => `y${i}=yv[${i + 1}]`).join(",")})`,
    );
    compXs.forEach((x, i) => {
      const ts = evaluateFittedCurve("homologous-competition-logx", homol.coefficients ?? [], x, 1);
      const rv = rY[`y${i}`];
      if (rv == null || Math.abs(ts - rv) > 1e-6)
        out.push(`Competition homologous overlay at X=${x}: TS ${ts}, R ${rv}`);
    });
  }
  // The wizard asks the Fit-Ki toggle on competition models (not on the
  // 4PL), then [L] and Kd; the homologous model asks [L] only.
  const compAsked = (a: Record<string, string>) =>
    WIZARDS["nonlinear-regression"]!.questions(a, readTable(doseFall)).flatMap((q) => (q ? [q.id] : []));
  if (!compAsked({ kind: "dose", model: "inhibitor-3pl-logx" }).includes("fitKi"))
    out.push(`Competition wizard offers no Fit-Ki toggle on the inhibitor 3PL`);
  if (compAsked({ kind: "dose", model: "sigmoidal-4pl-logx" }).includes("fitKi"))
    out.push(`Competition wizard offers Fit Ki on the 4PL`);
  if (
    JSON.stringify(compAsked({ kind: "dose", model: "inhibitor-3pl-logx", fitKi: "yes" }).slice(-2)) !==
    JSON.stringify(["ligandConcentration", "ligandKd"])
  )
    out.push(
      `Competition wizard Fit-Ki fields: ${JSON.stringify(compAsked({ kind: "dose", model: "inhibitor-3pl-logx", fitKi: "yes" }))}, expected […, "ligandConcentration", "ligandKd"]`,
    );
  if (
    JSON.stringify(compAsked({ kind: "dose", model: "homologous-competition-logx" }).slice(-1)) !==
    JSON.stringify(["ligandConcentration"])
  )
    out.push(
      `Competition wizard homologous fields: ${JSON.stringify(compAsked({ kind: "dose", model: "homologous-competition-logx" }))}, expected […, "ligandConcentration"]`,
    );
  if (
    JSON.stringify(
      WIZARDS["nonlinear-regression"]!.finish(
        { y: "Response", kind: "dose", model: "inhibitor-3pl-logx", fitKi: "yes", ligandConcentration: "1", ligandKd: "0.5" },
        readTable(doseFall),
      ).params,
    ) !==
    JSON.stringify({
      y: "Response",
      model: "inhibitor-3pl-logx",
      fitKi: true,
      ligandConcentration: 1,
      ligandKd: 0.5,
    })
  )
    out.push(`Competition wizard finish does not pass Fit Ki + [L] + Kd through`);
  // Enzyme kinetics — Inhibition (plan 17): noiseless fixtures must recover
  // their generating parameters (relative tolerance 1e-6; 1e-4 for the
  // mixed-on-competitive run, where Alpha is unidentifiable); every fitted
  // parameter carries estimate + SE + t + p + 95% CI; AICc is reported per
  // global model; the notes name the [I] per series, the shared fit and the
  // Alpha mechanism; the graph draws one 101-point curve per series; the
  // validation errors name their requirement.
  const enzCoef = (r: AnalysisResult | { error: string }, term: string) =>
    "error" in r ? null : (r.coefficients?.find((c) => c.term === term)?.estimate ?? null);
  const enzStat = (r: AnalysisResult | { error: string }, label: string) =>
    "error" in r ? null : (r.stats.find((s) => s.label === label)?.value ?? null);
  const enzConc = { "0 nM": 0, "5 nM": 5, "20 nM": 20 };
  const enzChecks: [string, AnalysisResult | { error: string }, [string, number, number][]][] = [
    [
      "mixed",
      await runAnalysis("enzyme-inhibition", enzMixed, { model: "mixed", inhibitorConcentrations: enzConc }),
      [
        ["Vmax", 100, 1e-6],
        ["Km", 10, 1e-6],
        ["Ki", 5, 1e-6],
        ["Alpha", 2, 1e-6],
      ],
    ],
    [
      "competitive",
      await runAnalysis("enzyme-inhibition", enzCompetitive, {
        model: "competitive",
        inhibitorConcentrations: enzConc,
      }),
      [
        ["Vmax", 100, 1e-6],
        ["Km", 10, 1e-6],
        ["Ki", 5, 1e-6],
      ],
    ],
    [
      "mixed on competitive",
      await runAnalysis("enzyme-inhibition", enzCompetitive, { model: "mixed", inhibitorConcentrations: enzConc }),
      [
        ["Vmax", 100, 1e-4],
        ["Km", 10, 1e-4],
        ["Ki", 5, 1e-4],
      ],
    ],
    [
      "morrison",
      await runAnalysis("enzyme-inhibition", enzMorrison, { model: "morrison", enzymeConcentration: 5 }),
      [
        ["v0", 100, 1e-6],
        ["Kiapp", 2, 1e-6],
      ],
    ],
    [
      "morrison with [S]/Km",
      await runAnalysis("enzyme-inhibition", enzMorrison, {
        model: "morrison",
        enzymeConcentration: 5,
        substrateConcentration: 10,
        kmForMorrison: 10,
      }),
      [
        ["v0", 100, 1e-6],
        ["Kiapp", 2, 1e-6],
        ["Ki", 1, 1e-6],
      ],
    ],
    [
      // The wizard's params name the Y series explicitly — the same mixed
      // fit must recover its parameters when `y` is a string[].
      "mixed (explicit y)",
      await runAnalysis("enzyme-inhibition", enzMixed, {
        model: "mixed",
        y: ["0 nM", "5 nM", "20 nM"],
        inhibitorConcentrations: enzConc,
      }),
      [
        ["Vmax", 100, 1e-6],
        ["Km", 10, 1e-6],
        ["Ki", 5, 1e-6],
        ["Alpha", 2, 1e-6],
      ],
    ],
  ];
  for (const [label, r, terms] of enzChecks) {
    if ("error" in r) {
      out.push(`Enzyme inhibition ${label}: ${r.error}`);
      continue;
    }
    for (const [term, want, tol] of terms) {
      const got = enzCoef(r, term);
      if (!closeRel(got, want, tol)) out.push(`Enzyme inhibition ${label} ${term}: ${got}, expected ${want}`);
    }
    // Every fitted parameter carries estimate + SE + t + p + 95% CI (Et and
    // the derived Ki are not fitted, so they carry an estimate only).
    for (const c of r.coefficients ?? []) {
      if (c.term === "Et" || c.term === "Ki") {
        if (c.estimate == null) out.push(`Enzyme inhibition ${label} ${c.term}: missing estimate`);
        continue;
      }
      if (c.estimate == null || c.stdError == null || c.t == null || c.p == null || c.low == null || c.high == null)
        out.push(`Enzyme inhibition ${label} ${c.term}: missing estimate/SE/t/p/CI`);
    }
    const r2 = enzStat(r, "R squared");
    if (r2 == null || Math.abs(r2 - 1) > 1e-9) out.push(`Enzyme inhibition ${label} R²: ${r2}, expected 1`);
    // Global fits only: Morrison is a single-curve fit, not a shared fit.
    if (!label.startsWith("morrison") && !r.notes.includes("shared across"))
      out.push(`Enzyme inhibition ${label} notes do not say the parameters are shared`);
  }
  // AICc is reported per global model (not for the single-curve Morrison fit).
  const enzMixedRun = enzChecks[0][1];
  if (!("error" in enzMixedRun) && enzStat(enzMixedRun, "AICc") == null)
    out.push(`Enzyme inhibition mixed: no AICc row`);
  const enzMorrRun = enzChecks[3][1];
  if (!("error" in enzMorrRun) && enzStat(enzMorrRun, "AICc") != null)
    out.push(`Enzyme inhibition morrison: unexpected AICc row`);
  if (!("error" in enzMorrRun) && !enzMorrRun.notes.includes("Ki needs [S] and Km"))
    out.push(`Enzyme inhibition morrison notes do not say Ki needs [S] and Km`);
  if (!("error" in enzMorrRun) && enzCoef(enzMorrRun, "Ki") != null)
    out.push(`Enzyme inhibition morrison without [S]/Km: Ki ${enzCoef(enzMorrRun, "Ki")}, expected none`);
  // Mixed notes name the Alpha mechanism; on competitive truth they point
  // to the competitive limit.
  const enzMixedOnComp = enzChecks[2][1];
  if (!("error" in enzMixedOnComp) && !enzMixedOnComp.notes.includes("competitive limit"))
    out.push(`Enzyme inhibition mixed-on-competitive notes do not mention the competitive limit`);
  if (!("error" in enzMixedRun) && !enzMixedRun.notes.includes("Alpha = 1 is noncompetitive"))
    out.push(`Enzyme inhibition mixed notes do not state the Alpha interpretation`);
  // [I] per series is named in the notes.
  if (!("error" in enzMixedRun) && !enzMixedRun.notes.includes("“0 nM” [I] = 0"))
    out.push(`Enzyme inhibition mixed notes do not name [I] per series`);
  // Title parsing: the same mixed fit without inhibitorConcentrations
  // recovers the parameters from the "0 nM"/"5 nM"/"20 nM" titles.
  const enzTitleParsed = await runAnalysis("enzyme-inhibition", enzMixed, { model: "mixed" });
  if ("error" in enzTitleParsed) out.push(`Enzyme inhibition title-parsed mixed: ${enzTitleParsed.error}`);
  else if (!closeRel(enzCoef(enzTitleParsed, "Ki"), 5, 1e-6))
    out.push(`Enzyme inhibition title-parsed mixed Ki: ${enzCoef(enzTitleParsed, "Ki")}, expected 5`);
  // Validation errors.
  const enzErrCases: [string, TableData, AnalysisType, AnalysisParams, string][] = [
    [
      "no uninhibited series",
      enzNoZero,
      "enzyme-inhibition",
      { model: "mixed", inhibitorConcentrations: { "5 nM": 5, "20 nM": 20 } },
      "uninhibited",
    ],
    [
      "morrison [S] without Km",
      enzMorrison,
      "enzyme-inhibition",
      { model: "morrison", enzymeConcentration: 5, substrateConcentration: 10 },
      "both",
    ],
    [
      "morrison [S] without Km",
      enzMorrison,
      "enzyme-inhibition",
      { model: "morrison", enzymeConcentration: 5, substrateConcentration: 10 },
      "neither",
    ],
  ];
  for (const [label, tableData, type, params, want] of enzErrCases) {
    const r = await runAnalysis(type, tableData, params);
    if (!("error" in r) || !r.error.includes(want))
      out.push(`Enzyme inhibition ${label}: ${"error" in r ? r.error : "ran"}, expected an error naming “${want}”`);
  }
  // The inhibition-curve graph draws one 101-point line per series, each in
  // its series' colour, spanning the pooled X range.
  if (!("error" in enzMixedRun)) {
    const { addEnzymeInhibitionCurve } = await import("../src/views/graphs/binding-curve");
    const opts = newGraphOptions("dose-response");
    const cols = plotColumns(readTable(enzMixed), "dose-response", opts, "xy");
    const fig = GRAPHS["dose-response"].build(cols, opts, paintOf(opts, 3), readTable(enzMixed).titles);
    addEnzymeInhibitionCurve(
      fig,
      cols,
      opts,
      enzMixedRun,
      { model: "mixed", inhibitorConcentrations: enzConc },
      paintOf(opts, 3),
    );
    const traces = fig.data as { mode?: string; x?: number[]; y?: number[]; line?: { color?: string } }[];
    const curves = traces.filter((t) => t.mode === "lines" && t.x?.length === 101);
    if (curves.length !== 3) out.push(`Enzyme inhibition graph draws ${curves.length} 101-point lines, expected 3`);
    const [c0, c5, c20] = curves;
    if (c0 && (c0.x?.[0] !== 1 || c0.x?.at(-1) !== 100))
      out.push(`Enzyme inhibition curve spans [${c0.x?.[0]}, ${c0.x?.at(-1)}], expected [1, 100]`);
    if (c0 && c0.y?.[0] != null && Math.abs(c0.y[0] - 9.0909090909) > 1e-6)
      out.push(`Enzyme inhibition [I]=0 curve at X=1: ${c0.y[0]}, expected 9.0909`);
    if (c20 && c20.y?.[100] != null && Math.abs(c20.y[100] - 28.5714285714) > 1e-6)
      out.push(`Enzyme inhibition [I]=20 curve at X=100: ${c20.y[100]}, expected 28.5714`);
    if (c5 && c20 && c5.line?.color === c20.line?.color)
      out.push(`Enzyme inhibition curves share a colour — each series needs its own`);
    const note = (fig.layout.annotations as { text?: string }[] | undefined)?.find((a) => a.text?.includes("Ki"));
    if (!note) out.push(`Enzyme inhibition graph draws no Ki note`);
  }
  // The wizard asks model, then Y series, then one [I] field per series
  // (pre-filled from the title); Morrison asks Et, [S] and Km instead.
  const enzAsked = (a: Record<string, string | string[]>) =>
    WIZARDS["enzyme-inhibition"]!.questions(a, readTable(enzMixed)).flatMap((q) => (q ? [q.id] : []));
  if (JSON.stringify(enzAsked({})) !== JSON.stringify(["model", "y"]))
    out.push(`Enzyme inhibition wizard first steps: ${JSON.stringify(enzAsked({}))}, expected ["model", "y"]`);
  if (
    JSON.stringify(enzAsked({ model: "mixed", y: ["0 nM", "5 nM", "20 nM"] })) !==
    JSON.stringify(["model", "y", "I:0 nM", "I:5 nM", "I:20 nM"])
  )
    out.push(
      `Enzyme inhibition wizard (mixed): ${JSON.stringify(enzAsked({ model: "mixed", y: ["0 nM", "5 nM", "20 nM"] }))}, expected ["model", "y", "I:0 nM", "I:5 nM", "I:20 nM"]`,
    );
  if (
    JSON.stringify(enzAsked({ model: "morrison", y: ["Y"] })) !==
    JSON.stringify(["model", "y", "enzymeConcentration", "substrateConcentration", "kmForMorrison"])
  )
    out.push(
      `Enzyme inhibition wizard (morrison): ${JSON.stringify(enzAsked({ model: "morrison", y: ["Y"] }))}, expected ["model", "y", "enzymeConcentration", "substrateConcentration", "kmForMorrison"]`,
    );
  // The wizard's finish maps the answers to the runner's params, with [I]
  // parsed from the fields (title pre-fill) and Et/[S]/Km for Morrison.
  const enzFinished = WIZARDS["enzyme-inhibition"]!.finish(
    { model: "mixed", y: ["0 nM", "5 nM", "20 nM"], "I:0 nM": "0", "I:5 nM": "5", "I:20 nM": "20" },
    readTable(enzMixed),
  );
  if (
    JSON.stringify(enzFinished) !==
    JSON.stringify({
      type: "enzyme-inhibition",
      params: {
        model: "mixed",
        y: ["0 nM", "5 nM", "20 nM"],
        inhibitorConcentrations: { "0 nM": 0, "5 nM": 5, "20 nM": 20 },
      },
    })
  )
    out.push(`Enzyme inhibition wizard finish (mixed): ${JSON.stringify(enzFinished)}`);
  const enzMorrFinished = WIZARDS["enzyme-inhibition"]!.finish(
    { model: "morrison", y: ["Y"], enzymeConcentration: "5", substrateConcentration: "10", kmForMorrison: "10" },
    readTable(enzMorrison),
  );
  if (
    JSON.stringify(enzMorrFinished) !==
    JSON.stringify({
      type: "enzyme-inhibition",
      params: { model: "morrison", y: ["Y"], enzymeConcentration: 5, substrateConcentration: 10, kmForMorrison: 10 },
    })
  )
    out.push(`Enzyme inhibition wizard finish (morrison): ${JSON.stringify(enzMorrFinished)}`);
  // Dose-response — Special (plan 18): noiseless fixtures must recover
  // their generating parameters (relative tolerance 1e-6, absolute 1e-6
  // for the zero-valued Bottom/Basal, 1e-5 for tau); the pA2 unit-trap
  // case (B in nM) reports pA2 = −1; the Schild plot's points are
  // (−8, 0) and (−7, 1) with slope 1; the multi-curve overlay draws one
  // 101-point curve per series; the validation errors name their
  // requirement. Every fitted parameter carries estimate + SE + t + p +
  // 95% CI (derived EC50/KA/tau rows carry an estimate only).
  const specialCoef = (r: AnalysisResult | { error: string }, term: string) =>
    "error" in r ? null : (r.coefficients?.find((c) => c.term === term)?.estimate ?? null);
  const specialStat = (r: AnalysisResult | { error: string }, label: string) =>
    "error" in r ? null : (r.stats.find((s) => s.label === label)?.value ?? null);
  const closeAbs = (got: number | null, want: number, tol: number) => got != null && Math.abs(got - want) <= tol;
  const schildB = { "0 M": 0, "1e-8 M": 1e-8, "1e-7 M": 1e-7 };
  const specialChecks: [string, AnalysisResult | { error: string }, [string, number, number, boolean][]][] = [
    [
      "schild-slope-1",
      await runAnalysis("dose-response-special", schild, {
        model: "schild-slope-1",
        antagonistConcentrations: schildB,
      }),
      [
        ["Bottom", 0, 1e-6, true],
        ["Top", 100, 1e-6, false],
        ["LogEC50", -6, 1e-6, false],
        ["HillSlope", 1, 1e-6, false],
        ["pA2", 8, 1e-6, false],
      ],
    ],
    [
      "schild free",
      await runAnalysis("dose-response-special", schild, {
        model: "schild",
        antagonistConcentrations: schildB,
      }),
      [
        ["Bottom", 0, 1e-6, true],
        ["Top", 100, 1e-6, false],
        ["LogEC50", -6, 1e-6, false],
        ["HillSlope", 1, 1e-6, false],
        ["pA2", 8, 1e-6, false],
        ["SchildSlope", 1, 1e-6, false],
      ],
    ],
    [
      "schild nM units",
      await runAnalysis("dose-response-special", schild, {
        model: "schild-slope-1",
        antagonistConcentrations: { "0 M": 0, "1e-8 M": 10, "1e-7 M": 100 },
        bUnits: "nM",
      }),
      [
        ["pA2", -1, 1e-6, false],
        ["LogEC50", -6, 1e-6, false],
      ],
    ],
    [
      "ec50-shift",
      await runAnalysis("dose-response-special", ec50shift, {
        model: "ec50-shift",
        antagonistConcentrations: { "0 nM": 0, "10 nM": 10 },
        bUnits: "nM",
      }),
      [
        ["Bottom", 0, 1e-6, true],
        ["Top", 100, 1e-6, false],
        ["HillSlope", 1, 1e-6, false],
        ["LogEC50[0 nM]", -6, 1e-6, false],
        ["LogEC50[10 nM]", -5, 1e-6, false],
        ["EC50[0 nM]", 1e-6, 1e-6, false],
        ["EC50[10 nM]", 1e-5, 1e-6, false],
      ],
    ],
    [
      "operational-partial",
      await runAnalysis("dose-response-special", operational, { model: "operational-partial" }),
      [
        ["Basal", 0, 1e-6, true],
        ["Effectmax", 100, 1e-6, false],
        ["LogEC50", -7, 1e-6, false],
        ["n", 1, 1e-6, false],
        ["logKA[Partial agonist]", -6, 1e-6, false],
        ["logtau[Partial agonist]", 0.5, 1e-6, false],
        ["KA[Partial agonist]", 1e-6, 1e-6, false],
        ["tau[Partial agonist]", 3.1623, 1e-5, false],
      ],
    ],
  ];
  for (const [label, r, terms] of specialChecks) {
    if ("error" in r) {
      out.push(`Dose-response — Special ${label}: ${r.error}`);
      continue;
    }
    for (const [term, want, tol, abs] of terms) {
      const got = specialCoef(r, term);
      const ok = abs ? closeAbs(got, want, tol) : closeRel(got, want, tol);
      if (!ok) out.push(`Dose-response — Special ${label} ${term}: ${got}, expected ${want}`);
    }
    // Every fitted parameter carries estimate + SE + t + p + 95% CI;
    // derived rows (EC50/KA/tau) carry an estimate only.
    for (const c of r.coefficients ?? []) {
      const derived = c.term.startsWith("EC50[") || c.term.startsWith("KA[") || c.term.startsWith("tau[");
      if (derived) {
        if (c.estimate == null) out.push(`Dose-response — Special ${label} ${c.term}: missing estimate`);
        continue;
      }
      if (c.estimate == null || c.stdError == null || c.t == null || c.p == null || c.low == null || c.high == null)
        out.push(`Dose-response — Special ${label} ${c.term}: missing estimate/SE/t/p/CI`);
    }
    const r2 = specialStat(r, "R squared");
    if (r2 == null || Math.abs(r2 - 1) > 1e-9) out.push(`Dose-response — Special ${label} R²: ${r2}, expected 1`);
  }
  // Derived rows: EC50 (control) + Kb + dose ratios for Schild, dose
  // ratio for EC50 shift.
  const schildRun = specialChecks[0][1];
  if (!("error" in schildRun)) {
    if (!closeRel(specialStat(schildRun, "EC50 (control)"), 1e-6, 1e-6))
      out.push(
        `Dose-response — Special schild EC50 (control): ${specialStat(schildRun, "EC50 (control)")}, expected 1e-6`,
      );
    if (!closeRel(specialStat(schildRun, "Kb (M)"), 1e-8, 1e-6))
      out.push(`Dose-response — Special schild Kb (M): ${specialStat(schildRun, "Kb (M)")}, expected 1e-8`);
    if (!closeRel(specialStat(schildRun, "Dose ratio (1e-7 M)"), 11, 1e-6))
      out.push(
        `Dose-response — Special schild dose ratio (1e-7 M): ${specialStat(schildRun, "Dose ratio (1e-7 M)")}, expected 11`,
      );
    if (!closeRel(specialStat(schildRun, "Dose ratio (1e-8 M)"), 2, 1e-6))
      out.push(
        `Dose-response — Special schild dose ratio (1e-8 M): ${specialStat(schildRun, "Dose ratio (1e-8 M)")}, expected 2`,
      );
    if (!schildRun.notes.includes("is the control (no antagonist)"))
      out.push(`Dose-response — Special schild notes do not name the control`);
    if (!schildRun.notes.includes("“0 M” B = 0 M"))
      out.push(`Dose-response — Special schild notes do not name B per series`);
    if (!schildRun.notes.includes("pA2 = pKb"))
      out.push(`Dose-response — Special schild-slope-1 notes do not say pA2 = pKb`);
  }
  const schildNMRun = specialChecks[2][1];
  if (!("error" in schildNMRun)) {
    if (!closeRel(specialStat(schildNMRun, "Kb (nM)"), 10, 1e-6))
      out.push(`Dose-response — Special schild nM Kb (nM): ${specialStat(schildNMRun, "Kb (nM)")}, expected 10`);
    if (!schildNMRun.notes.includes("B is entered in nM"))
      out.push(`Dose-response — Special schild nM notes do not state B's units`);
  }
  const shiftRun = specialChecks[3][1];
  if (!("error" in shiftRun)) {
    if (!closeRel(specialStat(shiftRun, "Dose ratio (10 nM)"), 10, 1e-6))
      out.push(
        `Dose-response — Special ec50-shift dose ratio (10 nM): ${specialStat(shiftRun, "Dose ratio (10 nM)")}, expected 10`,
      );
    if (!shiftRun.notes.includes("each series has its own LogEC50"))
      out.push(`Dose-response — Special ec50-shift notes do not say LogEC50 is per series`);
  }
  const operRun = specialChecks[4][1];
  if (!("error" in operRun)) {
    if (!operRun.notes.includes("full agonist"))
      out.push(`Dose-response — Special operational notes do not name the full agonist`);
  }
  // Title parsing: the same Schild fit without antagonistConcentrations
  // recovers the parameters from the "0 M" / "1e-8 M" / "1e-7 M" titles.
  const schildTitleParsed = await runAnalysis("dose-response-special", schild, { model: "schild-slope-1" });
  if ("error" in schildTitleParsed) out.push(`Dose-response — Special title-parsed schild: ${schildTitleParsed.error}`);
  else if (!closeRel(specialCoef(schildTitleParsed, "pA2"), 8, 1e-6))
    out.push(`Dose-response — Special title-parsed schild pA2: ${specialCoef(schildTitleParsed, "pA2")}, expected 8`);
  // Validation errors.
  const specialErrCases: [string, TableData, AnalysisType, AnalysisParams, string][] = [
    [
      "one series",
      schild,
      "dose-response-special",
      { model: "schild-slope-1", ys: ["0 M"], antagonistConcentrations: { "0 M": 0 } },
      "several curves",
    ],
    [
      "first series not the control",
      schild,
      "dose-response-special",
      { model: "schild-slope-1", antagonistConcentrations: { "0 M": 1e-8, "1e-8 M": 0, "1e-7 M": 1e-7 } },
      "control",
    ],
  ];
  for (const [label, tableData, type, params, want] of specialErrCases) {
    const r = await runAnalysis(type, tableData, params);
    if (!("error" in r) || !r.error.includes(want))
      out.push(
        `Dose-response — Special ${label}: ${"error" in r ? r.error : "ran"}, expected an error naming “${want}”`,
      );
  }
  // The Schild plot: on the schild table the computed points are
  // (log10 B, log10(DR−1)) = (−8, 0) and (−7, 1), slope 1 — and the
  // graph draws them as markers plus the fitted line.
  if (!("error" in schildRun)) {
    const { schildPlotPoints, addSchildPlot } = await import("../src/views/graphs/schild-plot");
    const plot = schildPlotPoints(schildRun, {
      model: "schild-slope-1",
      antagonistConcentrations: schildB,
    });
    if (
      plot.points.length !== 2 ||
      !closeAbs(plot.points[0]?.logB ?? null, -8, 1e-6) ||
      !closeAbs(plot.points[0]?.logDRminus1 ?? null, 0, 1e-6) ||
      !closeAbs(plot.points[1]?.logB ?? null, -7, 1e-6) ||
      !closeAbs(plot.points[1]?.logDRminus1 ?? null, 1, 1e-6) ||
      !closeAbs(plot.slope, 1, 1e-6)
    )
      out.push(`Schild plot points: ${JSON.stringify(plot)}, expected (−8, 0), (−7, 1), slope 1`);
    const opts = newGraphOptions("schild-plot");
    const cols = plotColumns(readTable(schild), "schild-plot", opts, "xy");
    const fig = GRAPHS["schild-plot"].build(cols, opts, paintOf(opts, 3), readTable(schild).titles);
    addSchildPlot(
      fig,
      schildRun,
      { model: "schild-slope-1", antagonistConcentrations: schildB },
      paintOf(opts, 3),
      opts,
    );
    const traces = fig.data as { mode?: string; x?: number[]; y?: number[]; line?: { dash?: string } }[];
    const markers = traces.filter((t) => t.mode === "markers");
    const lines = traces.filter((t) => t.mode === "lines");
    if (markers.length !== 1 || markers[0]?.x?.length !== 2 || lines.length !== 1 || lines[0]?.line?.dash !== "dash")
      out.push(
        `Schild plot traces: ${JSON.stringify(traces.map((t) => ({ mode: t.mode, dash: t.line?.dash, n: t.x?.length })))}`,
      );
    const note = (fig.layout.annotations as { text?: string }[] | undefined)?.find((a) => a.text?.includes("Slope"));
    if (!note) out.push(`Schild plot draws no slope note`);
  }
  // The multi-curve overlay draws one 101-point line per series, each in
  // its series' colour, spanning the pooled X range.
  if (!("error" in schildRun)) {
    const { addDoseResponseSpecialCurve } = await import("../src/views/graphs/binding-curve");
    const opts = newGraphOptions("dose-response");
    const cols = plotColumns(readTable(schild), "dose-response", opts, "xy");
    const fig = GRAPHS["dose-response"].build(cols, opts, paintOf(opts, 3), readTable(schild).titles);
    addDoseResponseSpecialCurve(
      fig,
      cols,
      opts,
      schildRun,
      { model: "schild-slope-1", antagonistConcentrations: schildB },
      paintOf(opts, 3),
    );
    const traces = fig.data as { mode?: string; x?: number[]; y?: number[]; line?: { color?: string } }[];
    const curves = traces.filter((t) => t.mode === "lines" && t.x?.length === 101);
    if (curves.length !== 3)
      out.push(`Dose-response — Special graph draws ${curves.length} 101-point lines, expected 3`);
    const [c0, c1, c2] = curves;
    if (c0 && (c0.x?.[0] !== -8 || c0.x?.at(-1) !== -4))
      out.push(`Dose-response — Special curve spans [${c0.x?.[0]}, ${c0.x?.at(-1)}], expected [-8, -4]`);
    if (c0 && c0.y?.[50] != null && Math.abs(c0.y[50] - 50) > 1e-6)
      out.push(`Dose-response — Special control curve at X=−6: ${c0.y[50]}, expected 50`);
    if (c0 && c1 && c2 && (c0.line?.color === c1.line?.color || c1.line?.color === c2.line?.color))
      out.push(`Dose-response — Special curves share a colour — each series needs its own`);
    const note = (fig.layout.annotations as { text?: string }[] | undefined)?.find((a) => a.text?.includes("pA2"));
    if (!note) out.push(`Dose-response — Special graph draws no pA2 note`);
  }
  // The operational overlay: two curves, the partial agonist's lower
  // plateau visible at X = −4.
  if (!("error" in operRun)) {
    const { addDoseResponseSpecialCurve } = await import("../src/views/graphs/binding-curve");
    const opts = newGraphOptions("dose-response");
    const cols = plotColumns(readTable(operational), "dose-response", opts, "xy");
    const fig = GRAPHS["dose-response"].build(cols, opts, paintOf(opts, 2), readTable(operational).titles);
    addDoseResponseSpecialCurve(fig, cols, opts, operRun, { model: "operational-partial" }, paintOf(opts, 2));
    const traces = fig.data as { mode?: string; x?: number[]; y?: number[] }[];
    const curves = traces.filter((t) => t.mode === "lines" && t.x?.length === 101);
    if (curves.length !== 2) out.push(`Operational graph draws ${curves.length} 101-point lines, expected 2`);
    const [, c1] = curves;
    if (c1 && c1.y?.[100] != null && Math.abs(c1.y[100] - 75.7925986172) > 1e-5)
      out.push(`Operational partial curve at X=−4: ${c1.y[100]}, expected 75.7926`);
  }
  // The wizard asks model, then Y series, then which series is first
  // (the control / full agonist), then one B field per other series, the
  // B units and — for Schild — the HillSlope constraint; the operational
  // model asks nothing more.
  const specialAsked = (a: Record<string, string | string[]>) =>
    WIZARDS["dose-response-special"]!.questions(a, readTable(schild)).flatMap((q) => (q ? [q.id] : []));
  if (
    JSON.stringify(specialAsked({})) !==
    JSON.stringify(["model", "ys", "first", "B:1e-8 M", "B:1e-7 M", "bUnits", "fixHillSlope"])
  )
    out.push(`Dose-response — Special wizard first steps: ${JSON.stringify(specialAsked({}))}`);
  if (
    JSON.stringify(specialAsked({ model: "operational-partial", ys: ["Full agonist", "Partial agonist"] })) !==
    JSON.stringify(["model", "ys", "first"])
  )
    out.push(
      `Dose-response — Special wizard (operational): ${JSON.stringify(specialAsked({ model: "operational-partial", ys: ["Full agonist", "Partial agonist"] }))}`,
    );
  if (
    JSON.stringify(specialAsked({ model: "ec50-shift", ys: ["0 nM", "10 nM"] })) !==
    JSON.stringify(["model", "ys", "first", "B:10 nM", "bUnits"])
  )
    out.push(
      `Dose-response — Special wizard (ec50-shift): ${JSON.stringify(specialAsked({ model: "ec50-shift", ys: ["0 nM", "10 nM"] }))}`,
    );
  // The wizard's finish maps the answers to the runner's params, with the
  // control first (B = 0) and the B fields parsed per series.
  const specialFinished = WIZARDS["dose-response-special"]!.finish(
    {
      model: "schild-slope-1",
      ys: ["0 M", "1e-8 M", "1e-7 M"],
      first: "0 M",
      "B:1e-8 M": "1e-8",
      "B:1e-7 M": "1e-7",
      bUnits: "M",
      fixHillSlope: "no",
    },
    readTable(schild),
  );
  if (
    JSON.stringify(specialFinished) !==
    JSON.stringify({
      type: "dose-response-special",
      params: {
        model: "schild-slope-1",
        ys: ["0 M", "1e-8 M", "1e-7 M"],
        antagonistConcentrations: { "0 M": 0, "1e-8 M": 1e-8, "1e-7 M": 1e-7 },
        bUnits: "M",
        fixHillSlope: false,
      },
    })
  )
    out.push(`Dose-response — Special wizard finish (schild): ${JSON.stringify(specialFinished)}`);
  // Re-picking the first series reorders ys and moves B = 0 with it.
  const specialReordered = WIZARDS["dose-response-special"]!.finish(
    {
      model: "schild-slope-1",
      ys: ["0 M", "1e-8 M", "1e-7 M"],
      first: "1e-8 M",
      "B:0 M": "1e-8",
      "B:1e-7 M": "1e-7",
      bUnits: "M",
      fixHillSlope: "no",
    },
    readTable(schild),
  );
  if (
    JSON.stringify(specialReordered) !==
    JSON.stringify({
      type: "dose-response-special",
      params: {
        model: "schild-slope-1",
        ys: ["1e-8 M", "0 M", "1e-7 M"],
        antagonistConcentrations: { "1e-8 M": 0, "0 M": 1e-8, "1e-7 M": 1e-7 },
        bUnits: "M",
        fixHillSlope: false,
      },
    })
  )
    out.push(`Dose-response — Special wizard finish (reordered): ${JSON.stringify(specialReordered)}`);
  const specialOperFinished = WIZARDS["dose-response-special"]!.finish(
    { model: "operational-partial", ys: ["Full agonist", "Partial agonist"], first: "Full agonist" },
    readTable(operational),
  );
  if (
    JSON.stringify(specialOperFinished) !==
    JSON.stringify({
      type: "dose-response-special",
      params: { model: "operational-partial", ys: ["Full agonist", "Partial agonist"] },
    })
  )
    out.push(`Dose-response — Special wizard finish (operational): ${JSON.stringify(specialOperFinished)}`);
  // ── Simulate data + Monte Carlo (plan 22) ─────────────────────────────
  // Determinism: the same seed + spec reproduces the same table, and it is
  // the literal fixture above.
  const simSpec = {
    distribution: "gaussian" as const,
    mean: 100,
    sd: 15,
    n: 20,
    datasets: 1,
    seed: 42,
    tableType: "column" as const,
  };
  const simA = await simulateTableData(simSpec);
  const simB = await simulateTableData(simSpec);
  if (JSON.stringify(simA) !== JSON.stringify(simB))
    out.push("Simulate data is not deterministic: the same seed + spec gave different tables.");
  if (JSON.stringify(simA.rows.map((r) => r[1])) !== JSON.stringify(simulated.rows.map((r) => r[1])))
    out.push(`Simulated Gaussian(100,15) values differ from the literal fixture: ${JSON.stringify(simA.rows.map((r) => r[1]))}`);
  // Distribution sanity at n = 10,000, seed 42: Gaussian(10,2) mean 10 ± 0.1,
  // SD 2 ± 0.1; Uniform(0,1) mean 0.5 ± 0.02.
  const gauss = await simulateTableData({ ...simSpec, mean: 10, sd: 2, n: 10_000 });
  const gVals = gauss.rows.map((r) => Number(r[1]));
  const gMean = gVals.reduce((s, v) => s + v, 0) / gVals.length;
  const gSd = Math.sqrt(gVals.reduce((s, v) => s + (v - gMean) ** 2, 0) / (gVals.length - 1));
  if (Math.abs(gMean - 10) > 0.1 || Math.abs(gSd - 2) > 0.1)
    out.push(`Gaussian(10,2) sanity: mean ${gMean}, SD ${gSd}`);
  const uni = await simulateTableData({
    distribution: "uniform" as const,
    min: 0,
    max: 1,
    n: 10_000,
    datasets: 1,
    seed: 42,
    tableType: "column" as const,
  });
  const uMean = uni.rows.reduce((s, r) => s + Number(r[1]), 0) / uni.rows.length;
  if (Math.abs(uMean - 0.5) > 0.02) out.push(`Uniform(0,1) sanity: mean ${uMean}`);
  // Power: the 5,000-repeat case against the analytic 0.8015 (± 0.02).
  const mcPowerRun = await runAnalysis("monte-carlo", mcPower, {
    targetAnalysis: "compare-two-groups",
    summaryStatistic: "P value",
    repeats: 5000,
    seed: 42,
    groupMeans: { A: 0, B: 0.5 },
    groupSds: { A: 1, B: 1 },
    equalVariance: true,
  });
  const powerPct = demStat(mcPowerRun, "Power (% P < 0.05)");
  if (powerPct == null || Math.abs(powerPct / 100 - 0.8015) > 0.02)
    out.push(`Monte Carlo power: ${powerPct}% vs analytic 80.15%`);
  // The observed P from a Monte Carlo run is the same t test on the same data.
  const mcObs = await runAnalysis("monte-carlo", column, {
    targetAnalysis: "compare-two-groups",
    summaryStatistic: "P value",
    repeats: 100,
    seed: 42,
    equalVariance: false,
  });
  const obsP = demStat(mcObs, "Observed (real data)");
  const ttest = await runAnalysis("compare-two-groups", column, {
    paired: false,
    gaussian: true,
    equalVariance: false,
    ratio: false,
    tails: "two-sided",
  });
  const tP = demStat(ttest, "P value");
  if (obsP == null || tP == null || Math.abs(obsP - tP) > 1e-9)
    out.push(`Monte Carlo observed P ${obsP} != compare-two-groups P ${tP}`);
  // The histogram overlay draws every repeat and marks the observed value.
  if (!("error" in mcObs) && mcObs.monteCarlo) {
    const mcOpts = newGraphOptions("monte-carlo-histogram");
    const mcFig = GRAPHS["monte-carlo-histogram"].build([], mcOpts, paintOf(mcOpts, 1));
    addMonteCarloHistogram(mcFig, mcObs, paintOf(mcOpts, 1));
    const bars = (mcFig.data as { y?: number[] }[])[0]?.y ?? [];
    const total = bars.reduce((s, v) => s + v, 0);
    const shapes = (mcFig.layout.shapes as { type: string }[]) ?? [];
    if (total !== 100 || !shapes.some((s) => s.type === "rect") || !shapes.some((s) => s.type === "line"))
      out.push(
        `Monte Carlo histogram: ${total} values in bins, shapes ${JSON.stringify(shapes.map((s) => s.type))}`,
      );
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
  // Without the bundled repo the Cox and mixed-effects cases were skipped
  // above — the same keys are dropped from the expectation, so the
  // comparison stays exact.
  if (!repoReady) {
    for (const k of Object.keys(expected)) {
      if (k.startsWith("cox-proportional-hazards ") || k.startsWith("mixed-effects ")) delete expected[k];
    }
  }
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
