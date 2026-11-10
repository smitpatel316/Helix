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
import { rVec } from "../src/stats/column/base";
import { R_MAXIMUM_T } from "../src/stats/column/anova";
import { evaluate as doseCurveAt } from "../src/views/graphs/fitted-curve";
import { NONLINEAR_MODELS, type NonlinearModel } from "../src/stats/types";
import { positiveXOnly } from "../src/stats/xy/nonlinear-regression";
import { evalNamedVector, setPackageRepo, startR } from "../src/stats/webr";
import { prettyBreaks } from "../src/stats/column/frequency-distribution";
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

/** Nested t test / nested one-way ANOVA (plan 14): 3 groups × 3 subgroups × 3
 *  replicates, one row — each subgroup's three replicate values sit in that
 *  row across its replicate columns, so the subcolumn means are exactly
 *  Control [11, 13, 11], Treated [16, 17, 16], High [20, 22, 20]. */
const nested3 = table(
  [
    "Title",
    "Control:S1:R1", "Control:S1:R2", "Control:S1:R3",
    "Control:S2:R1", "Control:S2:R2", "Control:S2:R3",
    "Control:S3:R1", "Control:S3:R2", "Control:S3:R3",
    "Treated:S1:R1", "Treated:S1:R2", "Treated:S1:R3",
    "Treated:S2:R1", "Treated:S2:R2", "Treated:S2:R3",
    "Treated:S3:R1", "Treated:S3:R2", "Treated:S3:R3",
    "High:S1:R1", "High:S1:R2", "High:S1:R3",
    "High:S2:R1", "High:S2:R2", "High:S2:R3",
    "High:S3:R1", "High:S3:R2", "High:S3:R3",
  ],
  [
    ["", "10", "11", "12", "13", "12", "14", "11", "10", "12",
     "16", "15", "17", "18", "17", "16", "15", "16", "17",
     "20", "21", "19", "22", "21", "23", "19", "20", "21"],
  ],
  { groups: 3, subgroups: 3, replicates: 3 },
);

/** The first two groups of `nested3` — a two-group nested table. */
const nested2 = table(
  [
    "Title",
    "Control:S1:R1", "Control:S1:R2", "Control:S1:R3",
    "Control:S2:R1", "Control:S2:R2", "Control:S2:R3",
    "Control:S3:R1", "Control:S3:R2", "Control:S3:R3",
    "Treated:S1:R1", "Treated:S1:R2", "Treated:S1:R3",
    "Treated:S2:R1", "Treated:S2:R2", "Treated:S2:R3",
    "Treated:S3:R1", "Treated:S3:R2", "Treated:S3:R3",
  ],
  [
    ["", "10", "11", "12", "13", "12", "14", "11", "10", "12",
     "16", "15", "17", "18", "17", "16", "15", "16", "17"],
  ],
  { groups: 2, subgroups: 3, replicates: 3 },
);

/** `nested2` with Control's S2 subgroup emptied: the t test runs on
 *  Control means [11, 11] and Treated [16, 17, 16], and the notes name the
 *  dropped subgroup. */
const nestedDrop = table(
  [
    "Title",
    "Control:S1:R1", "Control:S1:R2", "Control:S1:R3",
    "Control:S2:R1", "Control:S2:R2", "Control:S2:R3",
    "Control:S3:R1", "Control:S3:R2", "Control:S3:R3",
    "Treated:S1:R1", "Treated:S1:R2", "Treated:S1:R3",
    "Treated:S2:R1", "Treated:S2:R2", "Treated:S2:R3",
    "Treated:S3:R1", "Treated:S3:R2", "Treated:S3:R3",
  ],
  [
    ["", "10", "11", "12", "", "", "", "11", "10", "12",
     "16", "15", "17", "18", "17", "16", "15", "16", "17"],
  ],
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
  [
    "bindTotalNs",
    bindTotalNs,
    "binding-saturation",
    { y: "Total", y2: "Nonspecific", model: "one-site-total-and-ns" },
  ],
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
  ["enzMixed", enzMixed, "enzyme-inhibition", { model: "mixed", inhibitorConcentrations: { "0 nM": 0, "5 nM": 5, "20 nM": 20 } }],
  ["enzCompetitive", enzCompetitive, "enzyme-inhibition", { model: "competitive", inhibitorConcentrations: { "0 nM": 0, "5 nM": 5, "20 nM": 20 } }],
  ["enzCompetitive", enzCompetitive, "enzyme-inhibition", { model: "mixed", inhibitorConcentrations: { "0 nM": 0, "5 nM": 5, "20 nM": 20 } }],
  ["enzMorrison", enzMorrison, "enzyme-inhibition", { model: "morrison", enzymeConcentration: 5 }],
  ["enzMorrison", enzMorrison, "enzyme-inhibition", { model: "morrison", enzymeConcentration: 5, substrateConcentration: 10, kmForMorrison: 10 }],
  ["enzNoZero", enzNoZero, "enzyme-inhibition", { model: "mixed", inhibitorConcentrations: { "5 nM": 5, "20 nM": 20 } }],
  ["enzMorrison", enzMorrison, "enzyme-inhibition", { model: "morrison", enzymeConcentration: 5, substrateConcentration: 10 }],
  // The wizard always sets `y` explicitly (a string[]), so the mixed fit is
  // pinned with it too — the shared runAnalysis pre-flight once treated it
  // as one comma-joined column name and every wizard-created fit failed.
  ["enzMixed", enzMixed, "enzyme-inhibition", { model: "mixed", y: ["0 nM", "5 nM", "20 nM"], inhibitorConcentrations: { "0 nM": 0, "5 nM": 5, "20 nM": 20 } }],
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
    // Without the bundled repo the Cox cases cannot run (see the repo note
    // above) — skipped, never silently passed.
    if (!repoReady && type === "cox-proportional-hazards") continue;
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
      if (c == null || c.ciLow == null || c.ciHigh == null)
        out.push(`Enzyme ${label} ${term}: CI missing (low=${c?.ciLow}, high=${c?.ciHigh})`);
      else if (c.estimate == null || c.ciLow > c.estimate + 1e-6 || c.ciHigh < c.estimate - 1e-6)
        out.push(`Enzyme ${label} ${term}: CI [${c.ciLow}, ${c.ciHigh}] does not contain ${c.estimate}`);
    }
    for (const [name, want] of stats) {
      const got = r.stats.find((s) => s.label === name)?.value;
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
        if (rv == null || Math.abs(ts - rv) > 1e-6)
          out.push(`Enzyme MM overlay at X=${x}: TS ${ts}, R ${rv}`);
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
      ["HillSlope", 2],
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
    if (fitSI.equation !== "Y = 100·X / (2 + X + X²/10)") out.push(`Enzyme substrate-inhibition equation: ${fitSI.equation}`);
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
      if (!relClose(c?.stdError, wantSe, 1e-3)) out.push(`Enzyme noisy MM ${term} SE: ${c?.stdError}, WebR says ${wantSe}`);
      if (c == null || c.ciLow == null || c.ciHigh == null || c.ciHigh <= c.ciLow)
        out.push(`Enzyme noisy MM ${term}: CI not a nonzero interval (low=${c?.ciLow}, high=${c?.ciHigh})`);
      else if (c.estimate == null || c.ciLow > c.estimate || c.ciHigh < c.estimate)
        out.push(`Enzyme noisy MM ${term}: CI [${c.ciLow}, ${c.ciHigh}] does not contain ${c.estimate}`);
      else {
        if (!relClose(c.ciLow, wantLo, 1e-3)) out.push(`Enzyme noisy MM ${term} CI low: ${c.ciLow}, WebR says ${wantLo}`);
        if (!relClose(c.ciHigh, wantHi, 1e-3)) out.push(`Enzyme noisy MM ${term} CI high: ${c.ciHigh}, WebR says ${wantHi}`);
      }
    }
    const r2 = fitNoisy.stats.find((s) => s.label === "R squared")?.value;
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
      rel(trt?.ciLow, 0.103, 1e-2, "A HR_Trt CI low");
      rel(trt?.ciHigh, 1.3516, 1e-2, "A HR_Trt CI high");
      close(trt?.t, -1.501, 1e-3, "A z_Trt");
      close(trt?.p, 0.1333, 1e-3, "A p_Trt");
      close(age?.estimate, -0.0351, 1e-3, "A β_Age");
      close(age?.stdError, 0.0598, 1e-3, "A SE_Age");
      rel(age?.hazardRatio, 0.9655, 1e-3, "A HR_Age");
      rel(age?.ciLow, 0.8587, 1e-2, "A HR_Age CI low");
      rel(age?.ciHigh, 1.0857, 1e-2, "A HR_Age CI high");
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
      if (!coxA.notes.includes("Ties handled by the Breslow method"))
        out.push(`Cox A notes: tie method missing`);
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
      rel(trt?.ciLow, 0.1009, 1e-2, "B HR_Trt CI low");
      rel(trt?.ciHigh, 1.3369, 1e-2, "B HR_Trt CI high");
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
    await coxErr(coxTable, { time: "Time", status: "Status", covariates: [] }, "at least one covariate", "no covariates");
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
      if (row?.error_x?.arrayminus?.[0] == null || Math.abs(row.error_x.arrayminus[0] - (0.3672 - 0.1009)) / 0.3672 > 1e-2)
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
      if (
        !xaxis.range ||
        10 ** xaxis.range[0] >= 0.1009 ||
        10 ** xaxis.range[1] <= 1.3369
      )
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
      const survFig = GRAPHS["survival"].build(
        survCols,
        survOpts,
        paintOf(survOpts, 2),
        readTable(coxTable).titles,
      );
      const curves = (
        survFig.data as { mode?: string; name?: string; y?: number[] }[]
      ).filter((t) => t.mode === "lines");
      if (curves.length !== 2) out.push(`Cox survival graph curves: ${curves.length}, expected 2`);
      const names = curves.map((t) => t.name).sort();
      if (JSON.stringify(names) !== JSON.stringify(["Trt = 0", "Trt = 1"]))
        out.push(`Cox survival curves: ${names.join(",")}, expected "Trt = 0" and "Trt = 1"`);
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
    if (poisA.notes.includes("overdispersed"))
      out.push(`Poisson Case A notes warn of overdispersion: ${poisA.notes}`);
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
    if (!pts || pts.x?.length !== 12 || JSON.stringify(pts.x) !== JSON.stringify([2, 3, 3, 5, 4, 7, 6, 9, 8, 12, 11, 14]))
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
    if (dose?.t == null || Math.abs(dose.t - 5.04) > 1e-3) out.push(`Poisson Case B Dose z: ${dose?.t}, plan says 5.04`);
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
    if (!spline.notes.includes("spar = 0.5"))
      out.push(`Spline notes do not name the spar used: ${spline.notes}`);
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
  const smoothTooFewRun = await runAnalysis("spline-lowess", smoothTooFew, { y: "Response", method: "lowess", f: 2 / 3 });
  if (!("error" in smoothTooFewRun) || !smoothTooFewRun.error.toLowerCase().includes("at least 4"))
    out.push(`Spline/Lowess n < 4: ${"error" in smoothTooFewRun ? smoothTooFewRun.error : "ran"}, expected “at least 4 points”`);
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
    out.push(`Spline/Lowess wizard (Lowess): ${JSON.stringify(asked({ method: "lowess" }))}, expected ["method", "y", "f"]`);
  if (JSON.stringify(asked({ method: "spline" })) !== JSON.stringify(["method", "y", "spar"]))
    out.push(
      `Spline/Lowess wizard (spline): ${JSON.stringify(asked({ method: "spline" }))}, expected ["method", "y", "spar"]`,
    );
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
      if (
        c.estimate == null ||
        c.stdError == null ||
        c.t == null ||
        c.p == null ||
        c.ciLow == null ||
        c.ciHigh == null
      )
        out.push(`Binding ${label} ${c.term}: missing estimate/SE/t/p/CI`);
    }
    if (bindStat(r, "R squared") !== 1 && label !== "association then dissociation") {
      // Two-series fits report the pooled R² under "R squared" too.
      const pooled = bindStat(r, "R squared");
      if (pooled == null || Math.abs(pooled - 1) > 1e-9)
        out.push(`Binding ${label} R²: ${pooled}, expected 1`);
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
    addBindingCurve(fig, cols, opts, twoSeries, { y: "Total", y2: "Nonspecific", model: "one-site-total-and-ns" }, paintOf(opts, 2));
    const traces = fig.data as { mode?: string; x?: number[]; y?: number[]; line?: { dash?: string } }[];
    const curves = traces.filter((t) => t.mode === "lines" && t.x?.length === 101);
    if (curves.length !== 2) out.push(`Binding curve graph draws ${curves.length} 101-point lines, expected 2`);
    const [total, ns] = curves;
    if (total && (total.x?.[0] !== 0 || total.x?.at(-1) !== 50))
      out.push(`Binding total curve spans [${total.x?.[0]}, ${total.x?.at(-1)}], expected [0, 50]`);
    if (total && total.y) {
      const at5 = total.y[10];
      if (at5 == null || Math.abs(at5 - 54.5) > 1e-6)
        out.push(`Binding total curve at X=5: ${at5}, expected 54.5`);
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
  if (
    JSON.stringify(satAsked({ model: "one-site-total-and-ns" })) !== JSON.stringify(["y", "model", "y2"])
  )
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
      await runAnalysis("enzyme-inhibition", enzCompetitive, { model: "competitive", inhibitorConcentrations: enzConc }),
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
      if (
        c.estimate == null ||
        c.stdError == null ||
        c.t == null ||
        c.p == null ||
        c.ciLow == null ||
        c.ciHigh == null
      )
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
    addEnzymeInhibitionCurve(fig, cols, opts, enzMixedRun, { model: "mixed", inhibitorConcentrations: enzConc }, paintOf(opts, 3));
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
  // Without the bundled repo the Cox cases were skipped above — the same keys
  // are dropped from the expectation, so the comparison stays exact.
  if (!repoReady) {
    for (const k of Object.keys(expected)) if (k.startsWith("cox-proportional-hazards ")) delete expected[k];
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
