/// <reference types="node" />
// Checks for what must never break: .hlx files opening across versions and never
// trusted, table edits keeping every value where it belongs, graphs drawing each
// setting and following renamed columns, selected points, exports, analyses on the
// data asked, Undo, and the app's menus, recents and update check. `npm test` runs them.
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cancelActiveEvals, EvalCancelledError, ensurePackages, evalNamedVector, packageDiagnostics, packageStatus, resetR, setPackageRepo, startR } from "../src/stats/webr";
import {
  createEvalQueue,
  getRQueueSnapshot,
  onRQueueSnapshot,
  rQueueStatusText,
  setRQueueSnapshot,
  type RQueueSnapshot,
} from "../src/stats/r-queue";
import { parseProjectFile, parseProjectText, readPalette, serializeProjectFile, type ProjectFilePayload } from "../src/lib/project-file";
import {
  DEFAULT_GRAPH_OPTIONS,
  GRAPH_LIMITS,
  SAME_AS_FILL,
  type GraphOptions,
  type GraphType,
  type ProjectNode,
  type TableData,
} from "../src/store/types";
import {
  addRowGroup,
  columnsBeyond,
  defaultRowGroups,
  deleteColumns,
  deleteRows,
  fillRange,
  freshColumnNames,
  insertRows,
  newGroupedTable,
  newNestedTable,
  newTable,
  regroupLoses,
  regroupTable,
  removeRowGroup,
  renameGroup,
  renameSubgroup,
  renestLoses,
  renestTable,
  rowsDeleted,
  rowsInserted,
  setRowGroupCount,
  setRowGroupName,
  toggleExcluded,
  writeBlock,
} from "../src/views/tables/table-data";
import { flattenThreeWay, rowGroupBands } from "../src/stats/grouped/base";
import { gridMenu } from "../src/views/tables/grid-menu";
import { analysisOptionsForTable, analysisOptionsKey } from "../src/views/analyses";
import { followTable } from "../src/store/references";
import { pairKey } from "../src/lib/columns";
import {
  NAMED_COLORS,
  PALETTES,
  isTiterPalette,
  paletteColor,
  paletteNamed,
  paletteOf,
  reversedPalette,
  withOpacity,
  withoutColors,
} from "../src/lib/palettes";
import { deletePalette, keepPalette, loadMyPalettes } from "../src/store/my-palettes";
import { GRAPHS, GRAPH_OPTIONS_BY_TABLE, newGraphOptions, plotColumns, type GraphFigure } from "../src/views/graphs";
import { datasetColumns, isGrouped, isNested, readTable, setColumns, type Dataset } from "../src/lib/dataset";
import { prepareFit } from "../src/stats/xy/nonlinear-fit";
import { adjustComparisonRows, adjustPValues, incompleteRows, missingColumn } from "../src/stats/column/base";
import { droppedPredictorsNote, selectPredictors } from "../src/stats/multiple/predictors";
import { compareTwoGroupsSpec } from "../src/stats/column/compare-two-groups";
import { kruskalWallisSpec } from "../src/stats/column/kruskal-wallis";
import { anovaSpec } from "../src/stats/column/anova";
import { dagostinoPearson } from "../src/stats/column/shapiro-wilk";
import { runRout } from "../src/stats/column/rout";
import { parseGroupLevels, toggled, WIZARDS, type Question } from "../src/views/analyses/wizards";
import { initialAnswer } from "../src/views/analyses/analysis-wizard";
import { checkNormality } from "../src/views/analyses/normality-check";
import { addNote, groupedBarLayout, groupedScatterLayout, heatmapLayout, legendRightMargin, legendWidthPx, movedText, paintOf, vectorTraces, visibleOutline, withCaps, xyLayout } from "../src/views/graphs/plot-helpers";
import {
  drawnKeys,
  drawnStyle,
  keysOf,
  picked,
  pointLabels,
  resizePoints,
  selectionRing,
  stylePoints,
  withoutSelection,
} from "../src/views/graphs/selection";
import { genesNamed, VOLCANO_MAX_LOG10 } from "../src/views/graphs/volcano";
import { XY_SCATTER_MAX_POINTS } from "../src/views/graphs/xy-scatter";
import { addForestPlot } from "../src/views/graphs/forest-plot";
import { addSchildPlot, schildPlotPoints } from "../src/views/graphs/schild-plot";
import { addRegression, fitLinear } from "../src/views/graphs/regression-overlay";
import { addObservedFitted } from "../src/views/graphs/observed-fitted";
import { examplesFor, matched, type Matched } from "../src/views/graphs/match-graph";
import type { OutlineNode } from "../src/store/use-project-store";
import { deriveComparisons } from "../src/views/graphs/significance-overlay";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalysisResultsView, headline } from "../src/views/analyses/analysis-results-view";
import { loadPrismSaveChoice, nextSaveAction } from "../src/lib/prism-nudge";
import { convertPrism } from "../src/lib/prism";
import { yieldToPaint } from "../src/lib/yield-to-paint";
import { fitWidths, fitZoom } from "../src/store/use-layout";
import { prismDropSkippedMessage } from "../src/store/use-document";
import { computeGroupedDEG } from "../src/lib/deg";
import { logisticCurveNote } from "../src/views/graphs/logistic-curve";
import { ANALYSES, runAnalysis } from "../src/stats";
import {
  computeFrequencyBins,
  niceWidthUp,
  prettyBreaks,
  sturgesCount,
} from "../src/stats/column/frequency-distribution";
import { makeInitialState, reducer } from "../src/store/use-project-store";
import { isNewer, latestVersion } from "../src/lib/version";
import { titleCase } from "../src/lib/format";
import { loadRecents } from "../src/store/recents";
import { largestAt, PX_PER_INCH, withDpi } from "../src/lib/image-dpi";
import {
  assignLabels,
  clampPanel,
  composeFigureSvg,
  duplicateLabels,
  figureExportSize,
  figureLabel,
  figurePixelSize,
  missingPanels,
  newFigurePanels,
  panelPlotSize,
  panelRects,
  sharedLegendCheck,
  validateFigureSize,
} from "../src/lib/figure";
import { buildPanelFigure } from "../src/views/figures/panel-figure";
import { sampleProject } from "./sample-project";
import { crc32 } from "node:zlib";
import type { AnalysisOutcome, AnalysisParams, AnalysisResult, DoseResponseSpecialParams, MonteCarloParams, RegressionCoefficient, SimulationSpec } from "../src/stats/types";
import { simulationRCode, validateSimulationSpec } from "../src/stats/simulation/simulate";
import { aicc, coefficientsForSet, invertMethod, invertModel, nestedPair } from "../src/stats/xy/nonlinear-regression";
import { evaluate as evaluateCurve } from "../src/views/graphs/fitted-curve";
import { parseInhibitorConcentration } from "../src/stats/xy/enzyme-inhibition";
import { monteCarloRCode, percentile } from "../src/stats/simulation/monte-carlo";
import { addMonteCarloHistogram } from "../src/views/graphs/monte-carlo-histogram";

const checks: [string, () => void | Promise<void>][] = [];
const check = (name: string, fn: () => void | Promise<void>) => checks.push([name, fn]);

const read = (text: string) => {
  const result = parseProjectFile(JSON.parse(text));
  if ("error" in result) throw new Error(result.error);
  return result;
};

const table: ProjectNode = {
  id: "t1",
  type: "table",
  name: "Doses",
  parentId: null,
  tableType: "xy",
  data: {
    columns: ["Title", "X", "Y1"],
    rows: [
      ["a", "1", "2.5"],
      [null, "2", null],
    ],
    excluded: ["0,2"],
  },
};
const analysis: ProjectNode = {
  id: "a1",
  type: "analysis",
  name: "Fit",
  parentId: "t1",
  analysisType: "linear-regression",
  analysisParams: { y: "Y1", forceOrigin: true },
};
const graph: ProjectNode = {
  id: "g1",
  type: "graph",
  name: "Plot",
  parentId: "t1",
  graphType: "xy-scatter",
  graphOptions: {
    ...newGraphOptions("xy-scatter"),
    title: "My Title",
    yMax: 10,
    regAnalysisId: "a1",
    series: { Y1: { color: "#D55E00" } },
    points: { "Y1#0": { color: "#0072B2", size: 10 } },
  },
};
const payload: ProjectFilePayload = {
  nodes: { t1: table, a1: analysis, g1: graph },
  rootOrder: ["t1"],
  childOrder: { t1: ["g1", "a1"] },
  activeNodeId: "g1",
};

// ── Shared tables ────────────────────────────────────────────────────────

// A volcano's genes, one per row; the first has no P value, so it isn't drawn.
const genes = {
  columns: ["Title", "Gene", "LFC", "P"],
  rows: [
    [null, "A1", "2", ""],
    [null, "B2", "0.1", "0.5"],
    [null, "C3", "-3", "0.001"],
  ],
};

const volcanoOptions: GraphOptions = {
  ...newGraphOptions("volcano"),
  volcanoX: "LFC",
  volcanoY: "P",
  volcanoLabel: "Gene",
  volcanoYIsPValue: true,
};

const grouped = (): TableData => {
  let t = newGroupedTable(2, 3); // A:Y1 A:Y2 A:Y3 B:Y1 B:Y2 B:Y3
  t = writeBlock(t, 0, 0, [["r1", "a1", "a2", "a3", "b1", "b2", "b3"]], "grouped");
  t = renameGroup(t, "B", "Treated");
  return { ...t, excluded: ["0,4"] }; // Treated:Y1
};

const treatments = (columns: string[]): TableData => ({
  columns: ["Title", ...columns],
  rows: [1, 2, 3].map((r) => [null, ...columns.map((_, c) => String(r + c))]),
});

// ── .hlx files ───────────────────────────────────────────────────────────

check("a file Helix had to repair or bring up to date opens to be saved; a sound one doesn't", () => {
  strictEqual(read(serializeProjectFile(payload)).updated, false);
  strictEqual(read(readFileSync("samples/Titer Sample.hlx", "utf8")).updated, false);
  const file = () => JSON.parse(serializeProjectFile(payload));
  const repaired = file();
  repaired.project.nodes.g1.graphOptions.lineDash = "zigzag";
  strictEqual(read(JSON.stringify(repaired)).updated, true);
  const older = file(); // from a Helix before the bars' gap
  delete older.project.nodes.g1.graphOptions.barGap;
  strictEqual(read(JSON.stringify(older)).updated, true);
});

// R3 #22 (rootOrder leg): a table created after a figure goes before the
// figure in rootOrder, so the save/load round-trip doesn't report the file as
// updated. Before the fix `create` appended the table after the figure and
// parseProjectFile's tables-then-figures reorder made every load dirty.
// (The spar leg was already fixed: a spline-lowess `spar: null` round-trips
// — project-file.ts keeps it on read instead of stripping it.)
check("a table created after a figure still opens unedited (R3 #22)", () => {
  let s = makeInitialState();
  const t1 = s.rootOrder[0];
  const figure: ProjectNode = {
    id: "f1",
    type: "figure",
    name: "Figure",
    parentId: null,
    panels: [],
    grid: { rows: 1, cols: 1 },
    figureSize: { widthIn: 10, heightIn: 7.5 },
    labelStyle: { position: "top-left", fontSizePt: 12, bold: true },
    figureTitle: "",
    sharedLegend: "none",
    dpi: "600",
  } as ProjectNode;
  const second: ProjectNode = {
    id: "t2",
    type: "table",
    name: "Table",
    parentId: null,
    tableType: "xy",
    data: { columns: ["Title", "X", "Y1"], rows: [["a", "1", "2.5"]] },
  };
  s = reducer(s, { type: "create", node: figure });
  s = reducer(s, { type: "create", node: second });
  deepStrictEqual(s.rootOrder, [t1, "t2", "f1"]);
  const { updated } = read(
    serializeProjectFile({
      nodes: s.nodes,
      rootOrder: s.rootOrder,
      childOrder: s.childOrder,
      activeNodeId: s.activeNodeId,
    }),
  );
  strictEqual(updated, false);
});

// R2 FF-F12: a newer (or hand-edited) file's unknown keys and params survive a
// save instead of being dropped or lowercased — the file header's forward-compat
// promise. Before the fix the top-level and project keys were dropped outright,
// and an unknown param survived only as a lowercase word: "My Column" and an
// object value were dropped, "MyColumn" came back "mycolumn". Carrying them
// through is not a repair, so the file still opens unedited.
check("unknown file and project keys and unknown params survive a save, verbatim", () => {
  const file = JSON.parse(serializeProjectFile(payload)) as { project: ProjectFilePayload } & Record<string, unknown>;
  file.futureFileKey = { note: "from a newer Helix" };
  (file.project as unknown as Record<string, unknown>).futureProjectKey = "keep me";
  const a1 = file.project.nodes.a1 as ProjectNode;
  a1.analysisParams = {
    ...a1.analysisParams,
    futureParam: "My Column",
    futureFlag: { nested: [1, 2] },
    futureList: ["A", "B"],
    futureUpper: "MyColumn",
    futureWord: "spline",
  } as unknown as AnalysisParams;
  const { project, updated } = read(JSON.stringify(file));
  const kept = {
    y: "Y1",
    forceOrigin: true,
    futureParam: "My Column",
    futureFlag: { nested: [1, 2] },
    futureList: ["A", "B"],
    futureUpper: "MyColumn",
    futureWord: "spline",
  };
  deepStrictEqual(project.nodes.a1.analysisParams, kept);
  const again = JSON.parse(serializeProjectFile(project));
  strictEqual(again.futureFileKey.note, "from a newer Helix");
  strictEqual(again.project.futureProjectKey, "keep me");
  deepStrictEqual(again.project.nodes.a1.analysisParams, kept);
  strictEqual(updated, false);
});

// R2 M5: a dropped/invalid param value falls back to its runner default, and
// says so — a hand-edited or cross-version value must not silently change the
// test on re-run. Before the fix the reader left the key out and the runner
// read `undefined`: a dropped `gaussian` ran a Wilcoxon instead of a t test, a
// dropped `tails` reached R as alternative="undefined", a dropped `posthoc` ran
// Dunn, a dropped `correction` reached R as p.adjust(pr,"undefined"). (The
// queue's `q` example did not reproduce: the ROUT runner already falls back
// to `q ?? 1`, so a dropped `q` was never NaN.)
check("a dropped param value falls back to its default, and says so", () => {
  const withAnalysis = (id: string, type: string, params: unknown) => {
    const file = JSON.parse(serializeProjectFile(payload)) as { project: ProjectFilePayload };
    file.project.nodes[id] = {
      id,
      type: "analysis",
      name: id,
      parentId: "t1",
      analysisType: type,
      analysisParams: params,
    } as ProjectNode;
    file.project.childOrder.t1 = [...file.project.childOrder.t1, id];
    return read(JSON.stringify(file));
  };
  const paramsOf = (result: ReturnType<typeof read>, id: string) =>
    (result.project.nodes[id] as ProjectNode).analysisParams as Record<string, unknown>;

  const bad = withAnalysis("m5a", "compare-two-groups", {
    paired: "yes",
    gaussian: "yes",
    equalVariance: "maybe",
    tails: "sideways",
    ratio: 1,
  });
  deepStrictEqual(paramsOf(bad, "m5a"), {
    paired: false,
    gaussian: true,
    equalVariance: true,
    ratio: false,
    tails: "two-sided",
  });
  strictEqual(bad.updated, true);
  for (const key of ["paired", "gaussian", "equalVariance", "tails", "ratio"])
    ok(
      bad.issues.some((i) => i.message.includes(`“${key}”`) && i.message.includes("usual default")),
      `expected a warning naming “${key}”`,
    );
  // The runner now sees the defaults, not `undefined`.
  strictEqual(compareTwoGroupsSpec.subtitle?.(paramsOf(bad, "m5a") as never), "Unpaired t test");
  ok(
    !compareTwoGroupsSpec
      .rCode(
        [
          { name: "A", values: [1, 2, 3] },
          { name: "B", values: [2, 3, 4] },
        ],
        paramsOf(bad, "m5a") as never,
      )
      .includes("undefined"),
    "no undefined reaches R",
  );

  // Valid values are never overwritten by the defaults.
  const good = withAnalysis("m5b", "compare-two-groups", {
    paired: true,
    gaussian: false,
    equalVariance: false,
    tails: "less",
    ratio: false,
  });
  deepStrictEqual(paramsOf(good, "m5b"), {
    paired: true,
    gaussian: false,
    equalVariance: false,
    tails: "less",
    ratio: false,
  });
  strictEqual(good.issues.length, 0);

  const kw = withAnalysis("m5c", "kruskal-wallis", { posthoc: "bogus" });
  deepStrictEqual(paramsOf(kw, "m5c"), { posthoc: "none" });
  ok(
    !kruskalWallisSpec
      .rCode(
        [
          { name: "A", values: [1, 2, 3] },
          { name: "B", values: [2, 3, 4] },
          { name: "C", values: [3, 4, 5] },
        ],
        paramsOf(kw, "m5c") as never,
      )
      .includes("Rbar<-"),
    "no Dunn runs when the post-hoc fell back to none",
  );

  const deming = withAnalysis("m5d", "deming-regression", { y: "Y1", lambda: "wide" });
  deepStrictEqual(paramsOf(deming, "m5d"), { y: "Y1", lambda: 1 });

  const multi = withAnalysis("m5e", "multiple-t-tests", { correction: "bogus", gaussian: "yes" });
  // Both values were written and unusable, so both fall back; keys the file
  // never wrote stay absent (the runner's own fallbacks cover them).
  deepStrictEqual(paramsOf(multi, "m5e"), { gaussian: true, correction: "holm" });

  // A dropped `q` was already safe (the runner falls back to 1); the reader
  // still leaves it out, and the method stays.
  const outliers = withAnalysis("m5f", "outliers", { q: "bad", method: "rout" });
  deepStrictEqual(paramsOf(outliers, "m5f"), { method: "rout" });
});

// R2 FF-F16: a saved param outside its limits was silently rewritten on load
// (500 bins became 100) and the analysis re-ran on different parameters than
// the file specifies — with no warning. The clamp stays, but it says so; and
// `spar`/`df: null` (an explicit "choose automatically") round-trips instead
// of being dropped.
check("an out-of-range saved param warns when it is brought within its limits", () => {
  const withAnalysis = (id: string, type: string, params: unknown) => {
    const file = JSON.parse(serializeProjectFile(payload)) as { project: ProjectFilePayload };
    file.project.nodes[id] = {
      id,
      type: "analysis",
      name: id,
      parentId: "t1",
      analysisType: type,
      analysisParams: params,
    } as ProjectNode;
    file.project.childOrder.t1 = [...file.project.childOrder.t1, id];
    return read(JSON.stringify(file));
  };
  const paramsOf = (result: ReturnType<typeof read>, id: string) =>
    (result.project.nodes[id] as ProjectNode).analysisParams as Record<string, unknown>;

  const freq = withAnalysis("ff16a", "frequency-distribution", { binMode: "count", binCount: 500, startAt: 0 });
  strictEqual(paramsOf(freq, "ff16a").binCount, 100);
  ok(
    freq.issues.some((i) => i.message.includes("“binCount”") && i.message.includes("500") && i.message.includes("100")),
    "warns about the binCount clamp",
  );

  const outliers = withAnalysis("ff16b", "outliers", { method: "rout", q: 99 });
  strictEqual(paramsOf(outliers, "ff16b").q, 50);
  ok(
    outliers.issues.some((i) => i.message.includes("“q”") && i.message.includes("99") && i.message.includes("50")),
    "warns about the q clamp",
  );

  // In-range values stay silent.
  const inRange = withAnalysis("ff16c", "frequency-distribution", { binMode: "count", binCount: 10, startAt: 0 });
  strictEqual(paramsOf(inRange, "ff16c").binCount, 10);
  strictEqual(inRange.issues.length, 0);

  // `spar`/`df: null` is an explicit auto-choice, not a missing value: it
  // survives the round-trip instead of being dropped on load.
  const spline = withAnalysis("ff16d", "spline-lowess", { method: "spline", f: 0.5, spar: null, df: null });
  strictEqual(paramsOf(spline, "ff16d").spar, null);
  strictEqual(paramsOf(spline, "ff16d").df, null);
  const resaved = parseProjectFile(JSON.parse(serializeProjectFile(spline.project)));
  if ("error" in resaved) throw new Error(resaved.error);
  strictEqual(paramsOf(resaved, "ff16d").spar, null);
  strictEqual(paramsOf(resaved, "ff16d").df, null);
});

// R2 M6: one bad entry in an array/map param leaves the rest out on its own —
// the whole value used to be dropped, so the analysis silently ran on all
// columns instead of the chosen subset, or lost every wizard-entered
// concentration at once. The reader warns about the entries it left out.
check("one bad entry in a param list leaves the rest alone", () => {
  const withAnalysis = (id: string, type: string, params: unknown) => {
    const file = JSON.parse(serializeProjectFile(payload)) as { project: ProjectFilePayload };
    file.project.nodes[id] = {
      id,
      type: "analysis",
      name: id,
      parentId: "t1",
      analysisType: type,
      analysisParams: params,
    } as ProjectNode;
    file.project.childOrder.t1 = [...file.project.childOrder.t1, id];
    return read(JSON.stringify(file));
  };
  const paramsOf = (result: ReturnType<typeof read>, id: string) =>
    (result.project.nodes[id] as ProjectNode).analysisParams as Record<string, unknown>;

  const sets = withAnalysis("m6a", "compare-two-groups", { sets: ["A", 42, "B"], gaussian: true });
  deepStrictEqual(paramsOf(sets, "m6a").sets, ["A", "B"]);
  ok(sets.issues.some((i) => i.message.includes("“sets”") && i.message.includes("1 invalid entry")));

  const conc = withAnalysis("m6b", "enzyme-inhibition", { inhibitorConcentrations: { A: 10, B: "x", C: 5 } });
  deepStrictEqual(paramsOf(conc, "m6b").inhibitorConcentrations, { A: 10, C: 5 });
  ok(conc.issues.some((i) => i.message.includes("“inhibitorConcentrations”")));

  const bounds = withAnalysis("m6c", "nonlinear-regression", {
    bounds: { X: [0, 1], Y: [0, "z"], Z: [1] },
  });
  deepStrictEqual(paramsOf(bounds, "m6c").bounds, { X: [0, 1] });
  ok(bounds.issues.some((i) => i.message.includes("2 invalid entries")));

  const subject = withAnalysis("m6d", "mixed-effects", {
    subjectFactor: { name: "S", levels: ["a", 3, "b"] },
  });
  deepStrictEqual(paramsOf(subject, "m6d").subjectFactor, { name: "S", levels: ["a", "b"] });

  const ys = withAnalysis("m6e", "nonlinear-regression", { y: ["Y1", null] });
  deepStrictEqual(paramsOf(ys, "m6e").y, ["Y1"]);

  // Every entry bad still drops the value — but now with a warning, not silence.
  const allBad = withAnalysis("m6f", "compare-two-groups", { sets: [42, true] });
  strictEqual(paramsOf(allBad, "m6f").sets, undefined);
  ok(allBad.issues.some((i) => i.message.includes("“sets”") && i.message.includes("2 invalid entries")));

  // A graph's significance pairs filter the same way.
  const file = JSON.parse(serializeProjectFile(payload)) as { project: ProjectFilePayload };
  (file.project.nodes.g1.graphOptions as unknown as Record<string, unknown>).sigPairs = ["A-B", 7, "C-D"];
  const graph = read(JSON.stringify(file));
  deepStrictEqual((graph.project.nodes.g1 as ProjectNode).graphOptions?.sigPairs, ["A-B", "C-D"]);
  ok(graph.issues.some((i) => i.message.includes("“sigPairs”") && i.message.includes("1 invalid entry")));
});

// R2 M7: a choice value from another test's family is left out at load and
// falls back to the default, with a warning — it used to be silently
// reinterpreted (ANOVA `posthoc: "dunn"` ran Dunnett's T3 math under a Dunn's
// label; `"tukey"` on Kruskal-Wallis ran Dunn regardless; `method: "spline"`
// on a correlation was silently Pearson). Tests whose runner already refuses
// a cross-family value with a clean error keep the value, so the error still
// reaches the user: nested/three-way ANOVA posthoc, spline-lowess method.
check("a cross-family choice value falls back to the default", () => {
  const withAnalysis = (id: string, type: string, params: unknown) => {
    const file = JSON.parse(serializeProjectFile(payload)) as { project: ProjectFilePayload };
    file.project.nodes[id] = {
      id,
      type: "analysis",
      name: id,
      parentId: "t1",
      analysisType: type,
      analysisParams: params,
    } as ProjectNode;
    file.project.childOrder.t1 = [...file.project.childOrder.t1, id];
    return read(JSON.stringify(file));
  };
  const paramsOf = (result: ReturnType<typeof read>, id: string) =>
    (result.project.nodes[id] as ProjectNode).analysisParams as Record<string, unknown>;
  const groups = [
    { name: "A", values: [1, 2, 3] },
    { name: "B", values: [2, 3, 4] },
    { name: "C", values: [3, 4, 5] },
  ];

  const anova = withAnalysis("m7a", "anova", { posthoc: "dunn" });
  deepStrictEqual(paramsOf(anova, "m7a"), { posthoc: "none" });
  ok(anova.issues.some((i) => i.message.includes("“posthoc”") && i.message.includes("doesn't offer")));
  // No T3 math runs for the fallen-back params.
  ok(!anovaSpec.rCode(groups, paramsOf(anova, "m7a") as never).includes("smm("));

  const kw = withAnalysis("m7b", "kruskal-wallis", { posthoc: "tukey" });
  deepStrictEqual(paramsOf(kw, "m7b"), { posthoc: "none" });
  ok(kw.issues.some((i) => i.message.includes("“posthoc”") && i.message.includes("doesn't offer")));
  ok(!kruskalWallisSpec.rCode(groups, paramsOf(kw, "m7b") as never).includes("Rbar<-"));

  const friedman = withAnalysis("m7c", "friedman", { posthoc: "bonferroni" });
  deepStrictEqual(paramsOf(friedman, "m7c"), { posthoc: "none" });

  const corr = withAnalysis("m7d", "correlation", { method: "spline", mode: "x-vs-every-y" });
  deepStrictEqual(paramsOf(corr, "m7d"), { method: "pearson", mode: "x-vs-every-y" });

  const matrix = withAnalysis("m7e", "correlation-matrix", { method: "lowess" });
  deepStrictEqual(paramsOf(matrix, "m7e"), { method: "pearson" });

  const outliers = withAnalysis("m7f", "outliers", { method: "pearson", q: 1 });
  deepStrictEqual(paramsOf(outliers, "m7f"), { method: "rout", q: 1 });

  // Each family's own values pass through untouched, with no warning.
  const own = withAnalysis("m7g", "anova", { posthoc: "dunnett", control: "A" });
  deepStrictEqual(paramsOf(own, "m7g"), { posthoc: "dunnett", control: "A" });
  strictEqual(own.issues.length, 0);
  const ownKw = withAnalysis("m7h", "kruskal-wallis", { posthoc: "dunn-sidak" });
  deepStrictEqual(paramsOf(ownKw, "m7h"), { posthoc: "dunn-sidak" });
  const ownCorr = withAnalysis("m7i", "correlation", { method: "spearman" });
  deepStrictEqual(paramsOf(ownCorr, "m7i"), { method: "spearman" });

  // Runners that refuse cross-family values cleanly keep them, so the user
  // still gets the error instead of a silent fallback.
  const nested = withAnalysis("m7j", "nested-anova", { posthoc: "dunn" });
  deepStrictEqual(paramsOf(nested, "m7j"), { posthoc: "dunn" });
  const threeWay = withAnalysis("m7k", "three-way-anova", { posthoc: "sidak" });
  deepStrictEqual(paramsOf(threeWay, "m7k"), { posthoc: "sidak" });
  const spline = withAnalysis("m7l", "spline-lowess", { method: "pearson" });
  deepStrictEqual(paramsOf(spline, "m7l"), { method: "pearson" });
});

// Quirk 2: the "Project Updated" notice must not go through the native dialog —
// its window lingered on macOS after dismissal, blocking clicks and quitting.
// load() raises the in-app dialog state instead, and the shell mounts it.
// What this proves: the wiring. It cannot prove the Mac orphan is gone: the
// orphan was rfd's NSAlert lingering, which Linux never reproduces — the Mac
// retest (open an older .hlx, dismiss, assert no AXDialog remains) still stands.
check("an updated project is announced in-app, never through the native dialog", () => {
  const document = readFileSync("src/store/use-document.ts", "utf8");
  ok(!/native\.alert\([^;]*"Project Updated"/.test(document), "load() must not route the notice through native.alert");
  ok(document.includes("setProjectUpdated(true)"), "load() raises the in-app notice");
  const shell = readFileSync("src/components/app-shell.tsx", "utf8");
  ok(shell.includes('title="Project Updated"'), "the shell mounts the in-app notice");
  ok(shell.includes("projectUpdated"), "the shell reads the notice state");
});

// Plan 28: a dose-response graph's radioligand concentration — the
// homologous model's [L], which the graph carries in its own options — is
// written to the file, and on read the graph becomes a scatter whose created
// Nonlinear regression analysis carries [L], so the homologous curve draws
// instead of erroring.
check("a dose-response graph keeps its radioligand concentration", () => {
  // The retired graph's own options, as an old file holds them: the loader
  // still reads them (see LEGACY_DOSE_OPTIONS) to build the replacement analysis.
  const doseGraph: ProjectNode = {
    id: "g2",
    type: "graph",
    name: "Homologous curve",
    parentId: "t1",
    graphType: "dose-response" as GraphType,
    graphOptions: {
      ...newGraphOptions("xy-scatter"),
      ...({
        doseModel: "homologous-competition-logx",
        doseLigandConcentration: 1,
      } as Partial<GraphOptions>),
    },
  };
  const file = JSON.parse(
    serializeProjectFile({
      nodes: { t1: table, g2: doseGraph },
      rootOrder: ["t1"],
      childOrder: { t1: ["g2"] },
      activeNodeId: "g2",
    }),
  );
  strictEqual(file.project.nodes.g2.graphOptions.doseLigandConcentration, 1);
  const { project } = read(JSON.stringify(file));
  const fit = Object.values(project.nodes).find(
    (n) => n.type === "analysis" && n.parentId === "t1" && n.analysisType === "nonlinear-regression",
  );
  strictEqual(
    (fit?.analysisParams as { ligandConcentration?: number } | undefined)?.ligandConcentration,
    1,
  );
});

check("a table that doesn't hold together is put straight", () => {
  const file = JSON.parse(serializeProjectFile(payload));
  Object.assign(file.project.nodes.t1.data, {
    columns: ["Title", "A", "B"],
    rows: [
      ["r1", "1"],
      ["r2", "2", "3", "4", null, "5"],
    ],
    excluded: ["0,1", "9,1", "0,7"],
    widths: { A: 80, Gone: 90 },
  });
  const { project, issues, updated } = read(JSON.stringify(file));
  const data = project.nodes.t1.data!;
  deepStrictEqual(
    [data.rows, data.excluded, data.widths],
    [
      [
        ["r1", "1"],
        ["r2", "2", "3"],
      ],
      ["0,1"],
      { A: 80 },
    ],
  );
  ok(issues.some((i) => i.message.includes("2 values beyond its last column")));
  ok(updated);
  const grouped = JSON.parse(serializeProjectFile(payload));
  grouped.project.nodes.t1.data = {
    columns: ["Title", "A:Y1", "A:Y2", "B:Y1", "B:Y2"],
    rows: [["r", "1", "2", "3", "4"]],
    groups: 5,
    replicates: 1,
  };
  deepStrictEqual(read(JSON.stringify(grouped)).project.nodes.t1.data, {
    ...grouped.project.nodes.t1.data,
    groups: 2,
    replicates: 2,
  });
});

check("a gapped sub-column's values are warned about, not silently dropped on load", () => {
  // R2 FF-F10: a grouped table whose stored counts disagree with its columns
  // is rebuilt from the columns on load, and a gapped sub-column ("A:Y3"
  // with no "A:Y2") has no slot in the rebuilt set — its values used to
  // vanish with no warning, and saving then persisted the loss.
  const gapped = JSON.parse(serializeProjectFile(payload));
  gapped.project.nodes.t1.data = {
    columns: ["Title", "A:Y1", "A:Y3"],
    rows: [["r1", "1", "3"]],
    groups: 1,
    replicates: 3,
  };
  const grouped = read(JSON.stringify(gapped));
  deepStrictEqual(grouped.project.nodes.t1.data!.columns, ["Title", "A:Y1", "A:Y2"]);
  ok(
    grouped.issues.some((i) => i.message.includes("left out a column with values") && i.message.includes("A:Y3")),
    `expected a warning naming A:Y3, got ${JSON.stringify(grouped.issues)}`,
  );
  // The same gap one level deeper, in a nested table.
  const nested = JSON.parse(serializeProjectFile(payload));
  nested.project.nodes.t1.data = {
    columns: ["Title", "A:S1:R1", "A:S1:R3"],
    rows: [["r1", "1", "3"]],
    groups: 1,
    subgroups: 1,
    replicates: 3,
  };
  const renested = read(JSON.stringify(nested));
  deepStrictEqual(renested.project.nodes.t1.data!.columns, ["Title", "A:S1:R1", "A:S1:R2"]);
  ok(
    renested.issues.some((i) => i.message.includes("left out a column with values") && i.message.includes("A:S1:R3")),
    `expected a warning naming A:S1:R3, got ${JSON.stringify(renested.issues)}`,
  );
  // A gapped column holding nothing is still dropped, but silently — there
  // is no value to lose.
  const empty = JSON.parse(serializeProjectFile(payload));
  empty.project.nodes.t1.data = {
    columns: ["Title", "A:Y1", "A:Y3"],
    rows: [["r1", "1", null]],
    groups: 1,
    replicates: 3,
  };
  strictEqual(read(JSON.stringify(empty)).issues.length, 0);
});

check("a saved project reads back identical", () => {
  const { project, issues } = read(serializeProjectFile(payload));
  deepStrictEqual(project, payload);
  deepStrictEqual(issues, []);
});

check("only the project is saved (no app state, no file path)", () => {
  const withState = { ...payload, filePath: "/Users/someone/secret.hlx", isDirty: true, activeNode: table };
  const file = JSON.parse(serializeProjectFile(withState));
  deepStrictEqual(Object.keys(file.project).sort(), ["activeNodeId", "childOrder", "nodes", "rootOrder"]);
});

check("a table row is written on one line", () => {
  ok(serializeProjectFile(payload).includes(`["a", "1", "2.5"]`.replace(/, /g, ",")));
});

check("names and choices are read whatever their case", () => {
  const text = serializeProjectFile(payload)
    .replace(`"tableType": "xy"`, `"TableType": "XY"`)
    .replace(`"graphOptions"`, `"GRAPHOPTIONS"`)
    .replace(`"center": "mean"`, `"Center": "Median"`)
    .replace(`"app": "helix"`, `"App": "Helix"`)
    .replace(`"title": "My Title"`, `"Title": "My Title"`);
  const { project } = read(text);
  strictEqual(project.nodes.t1.tableType, "xy");
  strictEqual(project.nodes.g1.graphOptions!.center, "median");
  strictEqual(project.nodes.g1.graphOptions!.title, "My Title"); // the user's text keeps its case
  ok(!("GRAPHOPTIONS" in project.nodes.g1));
});

check("fields from a newer version are kept when saving again", () => {
  const file = JSON.parse(serializeProjectFile(payload));
  file.project.nodes.t1.futureNote = "hello";
  file.project.nodes.t1.data.futureLayout = { a: 1 };
  file.project.nodes.g1.graphOptions.futureOption = true;
  const again = JSON.parse(serializeProjectFile(read(JSON.stringify(file)).project));
  strictEqual(again.project.nodes.t1.futureNote, "hello");
  deepStrictEqual(again.project.nodes.t1.data.futureLayout, { a: 1 });
  strictEqual(again.project.nodes.g1.graphOptions.futureOption, true);
});

check("an older file without newer fields opens with defaults", () => {
  const old = {
    app: "helix",
    schemaVersion: 1,
    project: {
      nodes: {
        t1: {
          id: "t1",
          type: "table",
          name: "T",
          parentId: null,
          tableType: "grouped",
          data: { columns: ["X", "A:Y1"], rows: [[1, 2]], groups: 1, replicates: 1, xColumn: true },
        },
        g1: {
          id: "g1",
          type: "graph",
          name: "G",
          parentId: "t1",
          graphType: "grouped-bars",
          graphOptions: { center: "median" },
        },
      },
      rootOrder: ["t1"],
    },
  };
  const { project } = read(JSON.stringify(old));
  deepStrictEqual(project.childOrder, { t1: ["g1"] });
  strictEqual(project.nodes.g1.graphOptions!.center, "median");
  strictEqual(project.nodes.g1.graphOptions!.width, DEFAULT_GRAPH_OPTIONS.width);
  deepStrictEqual(project.nodes.t1.data!.rows, [["1", "2"]]); // numbers become cell text
});

check("wrong values fall back to their defaults", () => {
  const file = JSON.parse(serializeProjectFile(payload));
  Object.assign(file.project.nodes.g1.graphOptions, { width: "big", fontSize: null, bars: "yes", yMax: "ten" });
  file.project.nodes.g1.graphOptions.series = {
    Y1: { color: "red", shape: "star" },
    Y2: { Color: "#00ff00", Shape: "Square", Pattern: "Dots", dash: "wavy", glow: 2 },
  };
  file.project.nodes.g1.graphOptions.points = {
    "Y1#0": { color: "pink", size: -2, Shape: "Square", future: 1 },
    "Y1#1": { color: "#ffffff", outline: "thick" },
    "not a point": { color: "#000000" },
  };
  const { project } = read(JSON.stringify(file));
  const o = project.nodes.g1.graphOptions!;
  strictEqual(o.width, DEFAULT_GRAPH_OPTIONS.width);
  strictEqual(o.fontSize, DEFAULT_GRAPH_OPTIONS.fontSize);
  strictEqual(o.bars, DEFAULT_GRAPH_OPTIONS.bars);
  strictEqual(o.yMax, undefined);
  // A style keeps what's unknown of it (glow), not a wrong dash.
  deepStrictEqual(o.series, { Y2: { color: "#00ff00", shape: "square", pattern: "dots", glow: 2 } });
  deepStrictEqual(o.points, { "Y1#0": { shape: "square", size: 2, future: 1 }, "Y1#1": { color: "#ffffff" } });
});

check("a file from Helix 1.0 keeps its colors, now each graph's own", () => {
  const old = {
    app: "helix",
    project: {
      nodes: {
        t1: {
          id: "t1",
          type: "table",
          name: "T",
          parentId: null,
          tableType: "xy",
          data: { columns: ["Title", "X", "Y1", "Y2"], rows: [], seriesColors: { Y2: "Red" } },
        },
        g1: { id: "g1", type: "graph", name: "Plot", parentId: "t1", graphType: "xy-scatter", graphOptions: {} },
        g2: {
          id: "g2",
          type: "graph",
          name: "Heat",
          parentId: "t1",
          graphType: "heatmap",
          graphOptions: { heatmapColorScale: "yellow-red" },
        },
        g3: { id: "g3", type: "graph", name: "Heat 2", parentId: "t1", graphType: "heatmap", graphOptions: {} },
        g4: {
          id: "g4",
          type: "graph",
          name: "Volcano",
          parentId: "t1",
          graphType: "volcano",
          graphOptions: { volcanoColorUp: "green", volcanoPointSize: 8 },
        },
        g5: {
          id: "g5",
          type: "graph",
          name: "Box",
          parentId: "t1",
          graphType: "box-violin",
          graphOptions: { showPoints: true },
        },
        g6: { id: "g6", type: "graph", name: "Pie", parentId: "t1", graphType: "pie", graphOptions: {} },
        g7: {
          id: "g7",
          type: "graph",
          name: "Big",
          parentId: "t1",
          graphType: "volcano",
          graphOptions: { volcanoPointSize: 500 },
        },
      },
    },
  };
  const { project } = read(JSON.stringify(old));
  const { g1, g2, g3, g4, g5, g6 } = project.nodes;
  // The series drew in Helix 1.0's blue, then its red (the table's choice), fills at 50 %.
  const paint = paintOf(g1.graphOptions!, 2);
  strictEqual(paint.color("Y1", 0), NAMED_COLORS.blue);
  strictEqual(paint.fill("Y2", 1), "rgba(248,113,113,0.5)");
  strictEqual(paint.dot("Y2", 1), "rgba(248,113,113,0.5)");
  strictEqual(g1.graphOptions!.palette!.name, "titer");
  // A heatmap keeps its scale as Plotly drew it, or Viridis.
  strictEqual(g2.graphOptions!.palette!.name, "Heat (Titer 1.0)");
  strictEqual(g2.graphOptions!.palette!.colors.length, 256);
  deepStrictEqual([g2.graphOptions!.palette!.colors[0], g2.graphOptions!.palette!.colors[255]], ["#800026", "#FFFFCC"]);
  strictEqual(g3.graphOptions!.palette!.name, "viridis");
  // A volcano keeps its two colors.
  deepStrictEqual(g4.graphOptions!.series, { down: { color: NAMED_COLORS.blue }, up: { color: NAMED_COLORS.green } });
  // Points keep their size and outline: a box's 5 px, a volcano's own size and no outline.
  deepStrictEqual([g1.graphOptions!.pointSize, g1.graphOptions!.pointOutline], [7, 1.5]);
  deepStrictEqual(
    [g4.graphOptions!.pointSize, g4.graphOptions!.pointOutline, g4.graphOptions!.pointFill],
    [8, 0, 0.75],
  );
  strictEqual(project.nodes.g7.graphOptions!.pointSize, 20); // within what Helix offers
  deepStrictEqual([g5.graphOptions!.pointSize, g5.graphOptions!.pointOutline], [5, 1.5]);
  // Shapes keep their outline (a box's 2 px), and a row's bars stay side by side.
  deepStrictEqual([g5.graphOptions!.outline, g1.graphOptions!.barGap], [2, 0]);
  strictEqual(g6.graphOptions!.fill, 1); // slices were solid
  // The old fields are gone once read.
  const again = JSON.parse(serializeProjectFile(project));
  ok(!("seriesColors" in again.project.nodes.t1.data));
  ok(!("heatmapColorScale" in again.project.nodes.g2.graphOptions));
  ok(!("volcanoColorUp" in again.project.nodes.g4.graphOptions));
  ok(!("volcanoPointSize" in again.project.nodes.g4.graphOptions));
});

// M11: a missing palette alone must not rewrite a graph's own options —
// the Helix 1.0 rebuild only fills in what the file never saved. A graph
// that saved its fill, point size, outline and bar gap keeps them (and its
// series), while one that saved only its fill still takes its type's
// point size, outline and bar gap.
check("a graph without a palette keeps the options it saved", () => {
  const file = {
    app: "helix",
    project: {
      nodes: {
        t1: {
          id: "t1",
          type: "table",
          name: "T",
          parentId: null,
          tableType: "xy",
          data: { columns: ["Title", "X", "Y1", "Y2"], rows: [] },
        },
        g1: {
          id: "g1",
          type: "graph",
          name: "Box",
          parentId: "t1",
          graphType: "box-violin",
          graphOptions: {
            showPoints: true,
            fill: 0.9,
            pointFill: 0.8,
            pointSize: 9,
            outline: 1,
            barGap: 0.3,
            series: { Y1: { color: "#D55E00" } },
          },
        },
        g2: {
          id: "g2",
          type: "graph",
          name: "Box 2",
          parentId: "t1",
          graphType: "box-violin",
          graphOptions: { fill: 0.9 },
        },
      },
    },
  };
  const { project } = read(JSON.stringify(file));
  const o1 = project.nodes.g1.graphOptions!;
  deepStrictEqual(
    [o1.fill, o1.pointFill, o1.pointSize, o1.outline, o1.barGap],
    [0.9, 0.8, 9, 1, 0.3],
  );
  deepStrictEqual(o1.series, { Y1: { color: "#D55E00" } });
  strictEqual(o1.palette!.name, "titer"); // the missing palette is still rebuilt
  const o2 = project.nodes.g2.graphOptions!;
  deepStrictEqual([o2.fill, o2.pointSize, o2.outline, o2.barGap], [0.9, 5, 2, 0]);
});

check("cell colors from older files become their graphs' point colors", () => {
  const file = JSON.parse(serializeProjectFile(payload));
  file.project.nodes.t1.data.pointColors = { "Y1#1": "Green" };
  const { project } = read(JSON.stringify(file));
  // The graph's own style of a point wins; the cell's color joins the rest.
  deepStrictEqual(project.nodes.g1.graphOptions!.points, {
    "Y1#1": { color: NAMED_COLORS.green },
    "Y1#0": { color: "#0072B2", size: 10 },
  });
  ok(!("pointColors" in JSON.parse(serializeProjectFile(project)).project.nodes.t1.data));
});

check("a dose-response graph from an older Helix becomes a scatter drawing a new analysis's curve", () => {
  const file = JSON.parse(serializeProjectFile(payload));
  file.project.nodes.g1.graphType = "dose-response";
  Object.assign(file.project.nodes.g1.graphOptions, {
    doseY: "Y1",
    doseModel: "sigmoidal-4pl-logx",
    doseShowCurve: true,
    doseShowEquation: false,
  });
  const { project, issues, updated } = read(JSON.stringify(file));
  const fit = project.nodes.analysis_fit_g1;
  deepStrictEqual(fit.analysisParams, { y: "Y1", model: "sigmoidal-4pl-logx" });
  strictEqual(fit.parentId, "t1");
  const o = project.nodes.g1.graphOptions!;
  strictEqual(project.nodes.g1.graphType, "xy-scatter");
  strictEqual(o.regAnalysisId, "analysis_fit_g1");
  ok(o.regShowLine && !o.regShowEquation && o.xyStyle === "points" && !("doseModel" in o));
  // The fit comes just before its graph, and the project opens to be saved, said nothing else.
  const children = project.childOrder.t1;
  strictEqual(children.indexOf("analysis_fit_g1") + 1, children.indexOf("g1"));
  ok(updated && issues.length === 0);
});

// Plan 32: the graph menu for XY tables no longer offers the retired curve.
check("an XY table's graph menu no longer offers the dose-response curve", () => {
  ok(!GRAPH_OPTIONS_BY_TABLE.xy.some((o) => (o.value as string) === "dose-response"));
  ok(!("dose-response" in GRAPHS));
});

// Plan 32: the migration takes the model from the graph — a rising 3PL and
// a falling 3PL alike (the loader never evaluates the curve, so direction
// doesn't matter, only the model's name).
check("a dose-response graph with a 3PL model migrates to a 3PL Nonlinear regression analysis", () => {
  for (const model of ["agonist-3pl-logx", "inhibitor-3pl-logx"]) {
    const file = JSON.parse(serializeProjectFile(payload));
    file.project.nodes.g1.graphType = "dose-response";
    Object.assign(file.project.nodes.g1.graphOptions, {
      doseY: "Y1",
      doseModel: model,
      doseShowCurve: true,
      doseShowEquation: true,
    });
    const { project } = read(JSON.stringify(file));
    deepStrictEqual(project.nodes.analysis_fit_g1.analysisParams, { y: "Y1", model });
    strictEqual(project.nodes.g1.graphType, "xy-scatter");
  }
});

// Plan 32: a dose-response graph whose table is gone is left out with the
// other dangling items — the migration never sees it, so it can't crash.
check("a dose-response graph whose table is gone is left out, not crashed on", () => {
  const file = JSON.parse(serializeProjectFile(payload));
  file.project.nodes.g1.graphType = "dose-response";
  file.project.nodes.g1.parentId = "missing";
  const { project, issues } = read(JSON.stringify(file));
  ok(!("g1" in project.nodes));
  ok(!("analysis_fit_g1" in project.nodes));
  ok(issues.some((i) => i.message.includes("unreadable")));
});

check("a broken item is left out alone, and said so", () => {
  const file = JSON.parse(serializeProjectFile(payload));
  file.project.nodes.bad = { type: "graph" };
  file.project.nodes.orphan = { id: "orphan", type: "graph", name: "O", parentId: "missing", graphType: "pie" };
  file.project.nodes.t2 = {
    id: "t2",
    type: "table",
    name: "Future",
    parentId: null,
    tableType: "future",
    data: { columns: ["Title", "A"], rows: [] },
  };
  const { project, issues } = read(JSON.stringify(file));
  deepStrictEqual(Object.keys(project.nodes).sort(), ["a1", "g1", "t1", "t2"]);
  strictEqual(project.nodes.t2.tableType, "column");
  deepStrictEqual(project.rootOrder, ["t1", "t2"]);
  ok(issues.some((i) => i.message.includes("2 unreadable items")));
  ok(issues.some((i) => i.message.includes("Future")));
});

// R2 FF-F19: a duplicated node id is last-wins in `JSON.parse`, so the first
// copy used to vanish with no warning — a whole node gone on open. The
// text-level read keeps both: the first copy under its id, the second under
// a renamed id, and the open says so.
check("a duplicated node id keeps both copies, and says so", () => {
  const file = JSON.parse(serializeProjectFile(payload));
  const second = {
    ...table,
    name: "Second Copy",
    data: { columns: ["Title", "X", "Y1"], rows: [["b", "1", "9"]] },
  };
  const text = JSON.stringify(file).replace('"a1":', `"t1":${JSON.stringify(second)},"a1":`);
  // The old path drops the first copy silently: `JSON.parse` keeps the last.
  const old = read(text);
  deepStrictEqual(Object.keys(old.project.nodes).sort(), ["a1", "g1", "t1"]);
  strictEqual(old.project.nodes.t1.name, "Second Copy");
  ok(!old.issues.some((i) => i.message.includes("appears twice")));
  const result = parseProjectText(text);
  if ("error" in result) throw new Error(result.error);
  deepStrictEqual(Object.keys(result.project.nodes).sort(), ["a1", "g1", "t1", "t1__2"]);
  strictEqual(result.project.nodes.t1.name, "Doses");
  strictEqual(result.project.nodes["t1__2"].name, "Second Copy");
  deepStrictEqual(result.project.rootOrder, ["t1", "t1__2"]);
  strictEqual(result.updated, true);
  ok(result.issues.some((i) => i.message.includes("Item id “t1” appears twice") && i.message.includes("t1__2")));
});

check("a file is never trusted: unknown types, R code in params, a huge graph", async () => {
  const file = JSON.parse(serializeProjectFile(payload));
  const nodes = file.project.nodes;
  nodes.t1.tableType = "constructor";
  nodes.a1 = { type: "analysis", name: "A", parentId: "t1", analysisType: "constructor" };
  nodes.a2 = {
    type: "analysis",
    name: "B",
    parentId: "t1",
    analysisType: "one-sample-t",
    analysisParams: {
      hypotheticalValue: "0);quit(",
      tails: "LESS",
      gaussian: true,
      y: "Dose (µM)",
      sets: 5,
      datasets: ["A", 3],
    },
  };
  Object.assign(nodes.g1.graphOptions, { width: 1e9, height: -5 });
  const { project, issues } = read(JSON.stringify(file));
  strictEqual(project.nodes.t1.tableType, "column");
  strictEqual(issues.filter((i) => /doesn't know/.test(i.message)).length, 2);
  // R2 M6: `datasets` keeps its usable entry instead of dropping the whole list.
  deepStrictEqual(project.nodes.a2.analysisParams, { tails: "less", gaussian: true, y: "Dose (µM)", datasets: ["A"] });
  const o = project.nodes.g1.graphOptions!;
  deepStrictEqual([o.width, o.height], [2400, 120]);
  ok("error" in (await runAnalysis("constructor" as never, project.nodes.t1.data!)));
});

check("an item can't be named __proto__, and an id names one of the file's own items", () => {
  const file = JSON.parse(serializeProjectFile(payload));
  file.project.nodes = JSON.parse(
    JSON.stringify(file.project.nodes).replace(
      "{",
      '{"__proto__":{"type":"table","name":"P","data":{"columns":["Title"],"rows":[]}},',
    ),
  );
  file.project.activeNodeId = "constructor";
  file.project.nodes.g1.graphOptions.sigAnalysisId = "toString";
  const { project, issues } = read(JSON.stringify(file));
  strictEqual(Object.getPrototypeOf(project.nodes), Object.prototype);
  deepStrictEqual(Object.keys(project.nodes).sort(), ["a1", "g1", "t1"]);
  strictEqual(project.activeNodeId, "t1");
  ok(issues.some((i) => i.message.includes("1 unreadable item")));
  ok(issues.some((i) => i.message.includes("no longer exists")));
});

check("a file's choices and numbers stay within what Helix offers", () => {
  const file = JSON.parse(serializeProjectFile(payload));
  const nodes = file.project.nodes;
  Object.assign(nodes.g1.graphOptions, {
    lineDash: "zigzag",
    pointShape: "STAR",
    errorDirection: "Above",
    background: "pink",
    pointSize: 500,
    fill: 3,
    outline: -2,
    lineWidth: 0,
    fontSize: 100,
    volcanoLabelCount: -5,
    barGap: 0.9,
    points: { "A#0": { size: 500, fill: 3, outline: 99 } },
  });
  nodes.a3 = {
    type: "analysis",
    name: "C",
    parentId: "t1",
    analysisType: "outliers",
    analysisParams: { q: 500, tails: "three", paired: "yes", posthoc: "magic", model: "line", method: "PEARSON" },
  };
  const { project } = read(JSON.stringify(file));
  const o = project.nodes.g1.graphOptions!;
  const d = DEFAULT_GRAPH_OPTIONS;
  deepStrictEqual(
    [o.lineDash, o.pointShape, o.errorDirection, o.background],
    [d.lineDash, d.pointShape, "above", d.background],
  );
  deepStrictEqual(
    [o.pointSize, o.fill, o.outline, o.lineWidth, o.fontSize, o.volcanoLabelCount, o.barGap],
    [20, 1, 0, 0.5, 28, 0, 0.5],
  );
  deepStrictEqual(o.points?.["A#0"], { size: 20, fill: 1, outline: 6 });
  // R2 M7: `method: "pearson"` is not an outliers method, so it falls back to ROUT.
  deepStrictEqual(project.nodes.a3.analysisParams, { q: 50, model: "line", method: "rout" });
});

// ── Tables ───────────────────────────────────────────────────────────────

check("fewer sub-columns keep each value in its group", () => {
  const t = regroupTable(grouped(), 2, 2);
  deepStrictEqual(t.columns, ["Title", "A:Y1", "A:Y2", "Treated:Y1", "Treated:Y2"]);
  deepStrictEqual(t.rows[0], ["r1", "a1", "a2", "b1", "b2"]);
  deepStrictEqual(t.excluded, ["0,3"]);
});

check("clearing an excluded cell drops its exclusion, so no phantom * and no auto-exclude (#21)", () => {
  const t = toggleExcluded(writeBlock(newTable("xy", 2), 0, 0, [["r1", "5", "6"]], "xy"), {
    r0: 0,
    c0: 1,
    r1: 0,
    c1: 1,
  });
  deepStrictEqual(t.excluded, ["0,1"]);
  // Delete/Backspace clears the exclusion with the value.
  const cleared = fillRange(t, { r0: 0, c0: 1, r1: 0, c1: 1 }, null);
  strictEqual(cleared.rows[0][1], null);
  strictEqual(cleared.excluded, undefined);
  // Typing blank over it does the same.
  const blanked = writeBlock(t, 0, 1, [[""]], "xy");
  strictEqual(blanked.rows[0][1], null);
  strictEqual(blanked.excluded, undefined);
  // A fresh value in the cleared cell is live, not auto-excluded…
  const revalued = writeBlock(cleared, 0, 1, [["9"]], "xy");
  strictEqual(revalued.rows[0][1], "9");
  strictEqual(revalued.excluded, undefined);
  // …while overwriting an excluded cell with a value keeps it excluded.
  const kept = writeBlock(t, 0, 1, [["7"]], "xy");
  deepStrictEqual(kept.excluded, ["0,1"]);
});

check("more groups and sub-columns add empty ones after the data", () => {
  const t = regroupTable(grouped(), 3, 4);
  deepStrictEqual(t.columns.slice(1, 5), ["A:Y1", "A:Y2", "A:Y3", "A:Y4"]);
  deepStrictEqual(t.columns.slice(-4), ["C:Y1", "C:Y2", "C:Y3", "C:Y4"]);
  deepStrictEqual(t.rows[0].slice(5, 9), ["b1", "b2", "b3", null]);
});

check("fewer groups or sub-columns ask first only when they hold values", () => {
  const t = regroupTable(grouped(), 3, 4); // C and every Y4 are empty
  ok(!regroupLoses(t, 2, 4));
  ok(!regroupLoses(t, 3, 3));
  ok(regroupLoses(t, 1, 4)); // Treated
  ok(regroupLoses(t, 3, 2)); // A:Y3, Treated:Y3
  ok(!regroupLoses(t, 3, 5));
});

// ── Nested tables (plan 14) ──────────────────────────────────────────────

const nested = (): TableData => {
  let t = newNestedTable(2, 2, 2); // A:S1:R1 A:S1:R2 A:S2:R1 A:S2:R2 B:S1:R1 …
  t = writeBlock(
    t,
    0,
    0,
    [["r1", "a11", "a12", "a21", "a22", "b11", "b12", "b21", "b22"]],
    "nested",
  );
  return t;
};

check("a nested table names its columns group:subgroup:replicate", () => {
  const t = newNestedTable(2, 3, 3);
  deepStrictEqual(t.columns.slice(0, 4), ["Title", "A:S1:R1", "A:S1:R2", "A:S1:R3"]);
  deepStrictEqual(t.columns.slice(-3), ["B:S3:R1", "B:S3:R2", "B:S3:R3"]);
  deepStrictEqual([t.groups, t.subgroups, t.replicates], [2, 3, 3]);
  strictEqual(isNested(t), true);
  strictEqual(isGrouped(t), false);
  strictEqual(isGrouped(newGroupedTable(2, 3)), true);
  strictEqual(isNested(newGroupedTable(2, 3)), false);
});

check("nestedGroupsOf splits columns into groups and subgroups, and sets scope by group", () => {
  const { nested: groups, sets } = readTable(nested());
  deepStrictEqual(
    groups.map((g) => [g.name, g.subgroups.map((s) => s.name)]),
    [
      ["A", ["S1", "S2"]],
      ["B", ["S1", "S2"]],
    ],
  );
  deepStrictEqual(sets.map((s) => s.name), ["A", "B"]);
  deepStrictEqual(setColumns(readTable(nested()), ["B"]).map((c) => c.name), [
    "B:S1:R1",
    "B:S1:R2",
    "B:S2:R1",
    "B:S2:R2",
  ]);
});

check("fewer subgroups keep each value in its group and subgroup", () => {
  const t = renestTable(nested(), 2, 1, 2);
  deepStrictEqual(t.columns, ["Title", "A:S1:R1", "A:S1:R2", "B:S1:R1", "B:S1:R2"]);
  deepStrictEqual(t.rows[0], ["r1", "a11", "a12", "b11", "b12"]);
  deepStrictEqual([t.groups, t.subgroups, t.replicates], [2, 1, 2]);
});

check("more groups, subgroups and replicates add empty ones after the data", () => {
  const t = renestTable(nested(), 3, 3, 3);
  deepStrictEqual(t.columns.slice(1, 4), ["A:S1:R1", "A:S1:R2", "A:S1:R3"]);
  deepStrictEqual(t.columns.slice(-3), ["C:S3:R1", "C:S3:R2", "C:S3:R3"]);
  deepStrictEqual(t.rows[0].slice(1, 5), ["a11", "a12", null, "a21"]);
});

check("fewer groups, subgroups or replicates ask first only when they hold values", () => {
  const t = renestTable(nested(), 3, 3, 3); // C, every S3 and every R3 are empty
  ok(!renestLoses(t, 2, 3, 3));
  ok(!renestLoses(t, 3, 2, 3));
  ok(!renestLoses(t, 3, 3, 2));
  ok(renestLoses(t, 1, 3, 3)); // B
  ok(renestLoses(t, 3, 1, 3)); // A:S2, B:S2
  ok(renestLoses(t, 3, 3, 1)); // every R2
});

check("renaming a subgroup renames it within its group only", () => {
  const t = renameSubgroup(nested(), "A", "S1", "Mouse 1");
  deepStrictEqual(t.columns.slice(1, 5), ["A:Mouse 1:R1", "A:Mouse 1:R2", "A:S2:R1", "A:S2:R2"]);
  deepStrictEqual(t.columns.slice(5, 7), ["B:S1:R1", "B:S1:R2"]);
  strictEqual(renameSubgroup(t, "A", "S2", "Mouse 1"), t); // taken, within the group
});

check("renaming a nested table's top-level group renames all its sub-columns, and the menu offers Rename Group", () => {
  const t = renameGroup(nested(), "A", "Control");
  deepStrictEqual(t.columns.slice(1, 5), ["Control:S1:R1", "Control:S1:R2", "Control:S2:R1", "Control:S2:R2"]);
  deepStrictEqual(t.columns.slice(5, 7), ["B:S1:R1", "B:S1:R2"]);
  strictEqual(renameGroup(t, "B", "Control"), t); // taken, by another group
  // The menu for a Nested table offers both levels: Rename Subgroup for the
  // subgroup the column belongs to, and Rename Group for its top-level group.
  // Before the fix only Rename Subgroup was offered, and the Group header's
  // double-click opened the subgroup editor too, so kind "group" was
  // unreachable in Nested tables.
  let groupColumn = -1;
  let subgroupColumn = -1;
  const menu = (data: TableData, type: "nested" | "grouped") =>
    gridMenu({
      data,
      type,
      zone: "column",
      range: { r0: 0, r1: 0, c0: 1, c1: 1 },
      update: () => {},
      rename: (c) => {
        subgroupColumn = c;
      },
      renameGroup: (c) => {
        groupColumn = c;
      },
      showGroups: () => {},
    });
  const items = menu(nested(), "nested");
  const texts = items.map((i) => ("text" in i ? i.text : ""));
  ok(texts.includes("Rename Group"));
  ok(texts.includes("Rename Subgroup"));
  const groupItem = items.find((i) => "text" in i && i.text === "Rename Group");
  const action = groupItem && "action" in groupItem ? groupItem.action : undefined;
  action?.("Rename Group");
  strictEqual(groupColumn, 1);
  strictEqual(subgroupColumn, -1); // the group entry must not open the subgroup editor
  // A plain Grouped table still offers Rename Group exactly once.
  const groupedTexts = menu(grouped(), "grouped").map((i) => ("text" in i ? i.text : ""));
  strictEqual(groupedTexts.filter((text) => text === "Rename Group").length, 1);
  ok(!groupedTexts.includes("Rename Subgroup"));
});

check("renesting after a subgroup rename keeps each group's own subgroup names and values", () => {
  // A renamed its S1 to "Mouse 1"; B still has S1 — renesting must not look for
  // "B:Mouse 1" and overwrite B's S1 values with null.
  const renamed = renameSubgroup(nested(), "A", "S1", "Mouse 1");
  ok(!renestLoses(renamed, 2, 3, 3)); // a pure replicate increase loses nothing
  const t = renestTable(renamed, 2, 3, 3);
  deepStrictEqual(t.columns.slice(1, 4), ["A:Mouse 1:R1", "A:Mouse 1:R2", "A:Mouse 1:R3"]);
  deepStrictEqual(t.columns.slice(10, 13), ["B:S1:R1", "B:S1:R2", "B:S1:R3"]);
  strictEqual(t.rows[0][t.columns.indexOf("B:S1:R1")], "b11");
  strictEqual(t.rows[0][t.columns.indexOf("A:Mouse 1:R1")], "a11");
});

check("a nested table survives a save and reload", () => {
  const data = nested();
  const file: ProjectFilePayload = {
    nodes: {
      t1: { id: "t1", type: "table", name: "Nested", parentId: null, tableType: "nested", data },
    },
    rootOrder: ["t1"],
    childOrder: { t1: [] },
    activeNodeId: "t1",
  };
  const { project, updated } = read(serializeProjectFile(file));
  strictEqual(updated, false);
  const back = project.nodes.t1.data!;
  deepStrictEqual([back.groups, back.subgroups, back.replicates], [2, 2, 2]);
  deepStrictEqual(back.columns, data.columns);
  deepStrictEqual(back.rows, data.rows);
  strictEqual(project.nodes.t1.tableType, "nested");
});

check("a nested table whose counts disagree with its columns is put straight", () => {
  const file: ProjectFilePayload = {
    nodes: {
      t1: {
        id: "t1",
        type: "table",
        name: "Nested",
        parentId: null,
        tableType: "nested",
        data: { ...nested(), groups: 5, subgroups: 1, replicates: 1 },
      },
    },
    rootOrder: ["t1"],
    childOrder: { t1: [] },
    activeNodeId: "t1",
  };
  const { project } = read(serializeProjectFile(file));
  deepStrictEqual(
    [project.nodes.t1.data!.groups, project.nodes.t1.data!.subgroups, project.nodes.t1.data!.replicates],
    [2, 2, 2],
  );
});

check("nested tests are offered only for their group count", () => {
  const two: TableData = {
    columns: ["Title", "A:S1:R1", "B:S1:R1"],
    rows: [[null, "1", "2"]],
    groups: 2,
    subgroups: 1,
    replicates: 1,
  };
  const three: TableData = {
    columns: ["Title", "A:S1:R1", "B:S1:R1", "C:S1:R1"],
    rows: [[null, "1", "2", "3"]],
    groups: 3,
    subgroups: 1,
    replicates: 1,
  };
  deepStrictEqual(
    analysisOptionsForTable("nested", two).map((o) => o.value),
    ["nested-t-test"],
  );
  deepStrictEqual(
    analysisOptionsForTable("nested", three).map((o) => o.value),
    ["nested-anova"],
  );
});

check("the nested ANOVA wizard asks only for a post-hoc choice", () => {
  const table = readTable({
    columns: ["Title", "A:S1:R1", "A:S2:R1", "B:S1:R1", "B:S2:R1", "C:S1:R1", "C:S2:R1"],
    rows: [[null, "1", "2", "3", "4", "5", "6"]],
    groups: 3,
    subgroups: 2,
    replicates: 1,
  });
  const wizard = WIZARDS["nested-anova"]!;
  const questions = wizard.questions({}, table).filter(Boolean) as Question[];
  deepStrictEqual(questions.map((q) => q.id), ["posthoc"]);
  deepStrictEqual(wizard.finish({ posthoc: "tukey" }, table), {
    type: "nested-anova",
    params: { posthoc: "tukey" },
  });
});

// Round 2 M18: a choice question with zero options used to throw `TypeError`
// (`q.options[0].value` in the wizard's `initialAnswer`) — e.g. Correlation
// "Two chosen data sets" on X + 1 Y, a two-series binding-saturation model on
// X + 1 Y, or ROC when the truth column is the table's only numeric column.
check("a choice question with zero options has no answer instead of throwing (M18)", () => {
  const empty: Question = { id: "second", ask: "Which is the second data set?", kind: "choice", options: [] };
  strictEqual(initialAnswer(empty, undefined), null);
  const two: Question = {
    id: "mode",
    ask: "Which?",
    kind: "choice",
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
  };
  strictEqual(initialAnswer(two, undefined), "a");
  strictEqual(initialAnswer(two, "b"), "b");
  strictEqual(initialAnswer(two, "gone"), "a");
});

check("the correlation and binding wizards hide their two-series paths on X + 1 Y (M18)", () => {
  const oneY = readTable({
    columns: ["Title", "X", "Y1"],
    rows: [
      ["", "0", "1.1"],
      ["", "1", "2.9"],
      ["", "2", "5.2"],
    ],
  });
  const choiceValues = (q: Question) => {
    if (q.kind !== "choice") throw new Error(`${q.id} is not a choice question`);
    return q.options.map((o) => o.value);
  };
  const mode = WIZARDS["correlation"]!
    .questions({}, oneY)
    .filter(Boolean)
    .find((q) => (q as Question).id === "mode") as Question;
  deepStrictEqual(choiceValues(mode), ["x-vs-every-y", "matrix"]);
  const model = WIZARDS["binding-saturation"]!
    .questions({}, oneY)
    .filter(Boolean)
    .find((q) => (q as Question).id === "model") as Question;
  deepStrictEqual(choiceValues(model), ["one-site-total", "two-site-specific"]);
  // With two Y series both paths are offered again.
  const twoY = readTable({
    columns: ["Title", "X", "Y1", "Y2"],
    rows: [
      ["", "0", "1.1", "0.9"],
      ["", "1", "2.9", "2.1"],
      ["", "2", "5.2", "4.0"],
    ],
  });
  const mode2 = WIZARDS["correlation"]!
    .questions({}, twoY)
    .filter(Boolean)
    .find((q) => (q as Question).id === "mode") as Question;
  deepStrictEqual(choiceValues(mode2), ["x-vs-every-y", "two-datasets", "matrix"]);
  const model2 = WIZARDS["binding-saturation"]!
    .questions({}, twoY)
    .filter(Boolean)
    .find((q) => (q as Question).id === "model") as Question;
  deepStrictEqual(choiceValues(model2), [
    "one-site-total",
    "two-site-specific",
    "one-site-total-and-ns",
    "two-site-total-and-ns",
  ]);
  // A stale "two-datasets" answer on X + 1 Y still reaches the second
  // question — with no options and a message for the blocked step, never a throw.
  const second = WIZARDS["correlation"]!
    .questions({ method: "pearson", mode: "two-datasets", first: "Y1" }, oneY)
    .filter(Boolean)
    .find((q) => (q as Question).id === "second") as Question;
  if (second.kind !== "choice") throw new Error("second is not a choice question");
  deepStrictEqual(second.options, []);
  ok(second.emptyMessage?.includes("only one Y data set"));
  strictEqual(initialAnswer(second, undefined), null);
});

check("the ROC wizard's score question carries a message when the truth is the only numeric column (M18)", () => {
  const table = readTable({
    columns: ["Title", "Score"],
    rows: [["", "1"], ["", "2"], ["", "3"]],
  });
  const score = WIZARDS["roc-curve"]!
    .questions({ truth: "Score" }, table)
    .filter(Boolean)
    .find((q) => (q as Question).id === "score") as Question;
  if (score.kind !== "choice") throw new Error("score is not a choice question");
  deepStrictEqual(score.options, []);
  ok(score.emptyMessage?.includes("only numeric column"));
  strictEqual(initialAnswer(score, undefined), null);
});

check("the Bland-Altman wizard never offers the X column as a method on XY tables (F8)", () => {
  const xy = readTable({
    columns: ["Title", "Time", "Method A", "Method B"],
    rows: [
      ["", "0", "1.1", "1.0"],
      ["", "1", "2.9", "3.1"],
      ["", "2", "5.2", "4.8"],
    ],
  });
  const choiceValues = (q: Question) => {
    if (q.kind !== "choice") throw new Error(`${q.id} is not a choice question`);
    return q.options.map((o) => o.value);
  };
  const first = WIZARDS["bland-altman"]!
    .questions({}, xy, "xy")
    .filter(Boolean)
    .find((q) => (q as Question).id === "first") as Question;
  deepStrictEqual(choiceValues(first), ["Method A", "Method B"]);
  // With the first method picked, the second question still cannot offer X.
  const second = WIZARDS["bland-altman"]!
    .questions({ first: "Method A" }, xy, "xy")
    .filter(Boolean)
    .find((q) => (q as Question).id === "second") as Question;
  deepStrictEqual(choiceValues(second), ["Method B"]);
  // A column table has no X column, so every numeric column stays a method.
  const column = readTable({
    columns: ["Title", "Method A", "Method B"],
    rows: [
      ["", "1.1", "1.0"],
      ["", "2.9", "3.1"],
      ["", "5.2", "4.8"],
    ],
  });
  const firstCol = WIZARDS["bland-altman"]!
    .questions({}, column, "column")
    .filter(Boolean)
    .find((q) => (q as Question).id === "first") as Question;
  deepStrictEqual(choiceValues(firstCol), ["Method A", "Method B"]);
  // X + 1 Y: no second method exists, and the wizard says so instead of
  // offering X as the second method.
  const oneY = readTable({
    columns: ["Title", "Time", "Method A"],
    rows: [
      ["", "0", "1.1"],
      ["", "1", "2.9"],
      ["", "2", "5.2"],
    ],
  });
  const secondOneY = WIZARDS["bland-altman"]!
    .questions({ first: "Method A" }, oneY, "xy")
    .filter(Boolean)
    .find((q) => (q as Question).id === "second") as Question;
  if (secondOneY.kind !== "choice") throw new Error("second is not a choice question");
  deepStrictEqual(secondOneY.options, []);
  ok(secondOneY.emptyMessage?.includes("only one Y data set"));
});

check("the Bland-Altman graph never plots X as a method on XY tables (FL-f8-graph)", () => {
  const xy = readTable({
    columns: ["Title", "Time", "Method A", "Method B"],
    rows: [
      ["", "0", "1.1", "1.0"],
      ["", "1", "2.9", "3.1"],
      ["", "2", "5.2", "4.8"],
    ],
  });
  // The graph path the GUI uses: plotColumns picks the columns, the
  // builder draws the first two — so X must never be among the picked
  // columns, and the plotted trace must compare the two methods.
  const options = newGraphOptions("bland-altman");
  const picked = plotColumns(xy, "bland-altman", options, "xy").map((c) => c.name);
  deepStrictEqual(picked, ["Method A", "Method B"]);
  const fig = GRAPHS["bland-altman"].build(plotColumns(xy, "bland-altman", options, "xy"), options, paintOf(options, 2));
  const [trace] = fig.data as { name: string; x: number[]; y: number[] }[];
  strictEqual(trace.name, "Method A − Method B");
  // The plotted points are Method A − Method B against their mean — never
  // X (Time) against a method: the first point is (1.05, 0.1), not (0, 1.1).
  const rounded = (vs: number[]) => vs.map((v) => Number(v.toFixed(2)));
  deepStrictEqual(rounded(trace.x), [1.05, 3, 5]);
  deepStrictEqual(rounded(trace.y), [0.1, -0.2, 0.4]);
  // X + 1 Y: there is no second method, so the graph draws nothing rather
  // than falling back to X as a method.
  const oneY = readTable({
    columns: ["Title", "Time", "Method A"],
    rows: [
      ["", "0", "1.1"],
      ["", "1", "2.9"],
      ["", "2", "5.2"],
    ],
  });
  deepStrictEqual(
    plotColumns(oneY, "bland-altman", options, "xy").map((c) => c.name),
    ["Method A"],
  );
  deepStrictEqual(
    GRAPHS["bland-altman"].build(plotColumns(oneY, "bland-altman", options, "xy"), options, paintOf(options, 1)).data,
    [],
  );
  // A column table has no X column, so every numeric column stays a method.
  const column = readTable({
    columns: ["Title", "Method A", "Method B"],
    rows: [
      ["", "1.1", "1.0"],
      ["", "2.9", "3.1"],
      ["", "5.2", "4.8"],
    ],
  });
  deepStrictEqual(
    plotColumns(column, "bland-altman", options, "column").map((c) => c.name),
    ["Method A", "Method B"],
  );
});

// The Bland-Altman graph still draws its lines on a two-method table
// (FL-ba-lines): the FL-f8-graph fix made plotColumns drop the first column
// for BA on "xy" tables, which is right for a real XY table — but the
// reference fixture is a method-comparison table with no X column, so it is
// modelled as a column table, and its figure must carry the scatter plus the
// three lines at the analysis's bias and limits. (Passing "xy" for this
// fixture dropped Method A as if it were X and the graph rendered empty.)
check("the Bland-Altman graph still draws its lines on a two-method table (FL-ba-lines)", () => {
  const twoMethods = readTable({
    columns: ["Title", "Method A", "Method B"],
    rows: [
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
  });
  const options = newGraphOptions("bland-altman");
  deepStrictEqual(
    plotColumns(twoMethods, "bland-altman", options, "column").map((c) => c.name),
    ["Method A", "Method B"],
  );
  const fig = GRAPHS["bland-altman"].build(
    plotColumns(twoMethods, "bland-altman", options, "column"),
    options,
    paintOf(options, 2),
  );
  const traces = fig.data as { mode?: string; y?: number[]; x?: number[] }[];
  strictEqual(traces.length, 4);
  strictEqual(traces[0].x?.length, 10);
  const lines = traces
    .filter((t) => t.mode === "lines" && t.y?.length === 2 && t.y[0] === t.y[1])
    .map((t) => t.y![0])
    .sort((a, b) => a - b);
  deepStrictEqual(lines, [-0.8506528983575519, -0.36, 0.1306528983575519]);
});

// ── Row groups (a grouped table's third factor, plan 03) ─────────────────

check("row groups split, resize and merge keeping every row covered", () => {
  const bands = [
    { name: "WT", count: 2 },
    { name: "KO", count: 2 },
  ];
  // Splitting takes 1 row off the last splittable band.
  deepStrictEqual(addRowGroup(bands), [
    { name: "WT", count: 2 },
    { name: "KO", count: 1 },
    { name: "Row group 3", count: 1 },
  ]);
  deepStrictEqual(addRowGroup([{ name: "Only", count: 1 }]), [{ name: "Only", count: 1 }]);
  // Resizing one band takes the difference from its neighbour.
  deepStrictEqual(setRowGroupCount(bands, 0, 3), [
    { name: "WT", count: 3 },
    { name: "KO", count: 1 },
  ]);
  deepStrictEqual(setRowGroupCount(bands, 1, 3), [
    { name: "WT", count: 1 },
    { name: "KO", count: 3 },
  ]);
  // A band never drops below 1 row, whatever is asked.
  deepStrictEqual(setRowGroupCount(bands, 0, 0)[0].count, 1);
  // Removing a band gives its rows to a neighbour; the last band leaves none.
  deepStrictEqual(removeRowGroup(bands, 0), [{ name: "KO", count: 4 }]);
  deepStrictEqual(removeRowGroup(bands, 1), [{ name: "WT", count: 4 }]);
  deepStrictEqual(removeRowGroup([{ name: "Only", count: 4 }], 0), []);
  deepStrictEqual(setRowGroupName(bands, 1, "Mutant")[1], { name: "Mutant", count: 2 });
  deepStrictEqual(defaultRowGroups({ columns: ["Title"], rows: [[null], [null], [null]] }), [
    { name: "All rows", count: 3 },
  ]);
});

check("inserting and deleting rows keeps the row groups tiling", () => {
  const t: TableData = {
    columns: ["Title", "A:Y1", "B:Y1"],
    rows: [["r1", "1", "2"], ["r2", "3", "4"], ["r3", "5", "6"], ["r4", "7", "8"]],
    groups: 2,
    replicates: 1,
    rowGroups: [
      { name: "WT", count: 2 },
      { name: "KO", count: 2 },
    ],
  };
  // Two rows inserted inside WT grow WT; two deleted from KO shrink it away.
  deepStrictEqual(insertRows(t, 1, 2).rowGroups, [
    { name: "WT", count: 4 },
    { name: "KO", count: 2 },
  ]);
  deepStrictEqual(deleteRows(t, 2, 2).rowGroups, [{ name: "WT", count: 2 }]);
  deepStrictEqual(deleteRows(t, 0, 4).rowGroups, undefined);
  // Pasting past the last row grows the last band with the table.
  const grown = writeBlock(t, 4, 0, [["r5", "9", "10"]], "grouped");
  deepStrictEqual(grown.rowGroups, [
    { name: "WT", count: 2 },
    { name: "KO", count: 3 },
  ]);
});

check("flattenThreeWay tags every observation by group, row-in-band and band", () => {
  const t: TableData = {
    columns: ["Title", "Placebo:Y1", "Placebo:Y2", "Drug:Y1", "Drug:Y2"],
    rows: [
      ["Day 1", "1", "2", "3", "4"],
      ["Day 2", "5", "6", "7", "8"],
      ["Day 1", "9", "10", "11", "12"],
      ["Day 2", "13", null, "15", "16"],
    ],
    groups: 2,
    replicates: 2,
    rowGroups: [
      { name: "WT", count: 2 },
      { name: "KO", count: 2 },
    ],
  };
  const flat = flattenThreeWay(readTable(t).columns, rowGroupBands(t.rowGroups)!);
  // Group-major, like flattenGrouped: all of Placebo's values, then Drug's.
  deepStrictEqual(flat.values, [1, 2, 5, 6, 9, 10, 13, 3, 4, 7, 8, 11, 12, 15, 16]);
  deepStrictEqual(flat.a.slice(0, 7), ["Placebo", "Placebo", "Placebo", "Placebo", "Placebo", "Placebo", "Placebo"]);
  deepStrictEqual(flat.a.slice(7), ["Drug", "Drug", "Drug", "Drug", "Drug", "Drug", "Drug", "Drug"]);
  deepStrictEqual(flat.b.slice(0, 7), ["R1", "R1", "R2", "R2", "R1", "R1", "R2"]);
  deepStrictEqual(flat.c, ["WT", "WT", "WT", "WT", "KO", "KO", "KO", "WT", "WT", "WT", "WT", "KO", "KO", "KO", "KO"]);
  strictEqual(flat.dropped, 1); // the blank Placebo:Y2 on KO Day 2
  // flattenGrouped is unchanged: it still reads row position, not bands.
  strictEqual(rowGroupBands(undefined), undefined);
});

check("row groups survive a save and reload; a broken band is left out", () => {
  const project: ProjectFilePayload = {
    nodes: {
      t1: {
        id: "t1",
        type: "table",
        name: "T",
        parentId: null,
        tableType: "grouped",
        data: {
          columns: ["Title", "A:Y1", "B:Y1"],
          rows: [["r1", "1", "2"], ["r2", "3", "4"]],
          groups: 2,
          replicates: 1,
          rowGroups: [
            { name: "WT", count: 1 },
            { name: "KO", count: 1 },
          ],
        },
      },
    },
    rootOrder: ["t1"],
    childOrder: { t1: [] },
    activeNodeId: "t1",
  };
  const again = read(serializeProjectFile(project));
  deepStrictEqual(again.project.nodes.t1.data!.rowGroups, [
    { name: "WT", count: 1 },
    { name: "KO", count: 1 },
  ]);
  strictEqual(again.updated, false);
  // An older file without rowGroups opens unchanged, with no third factor.
  const old = JSON.parse(serializeProjectFile(project));
  delete old.project.nodes.t1.data.rowGroups;
  const reopened = read(JSON.stringify(old));
  strictEqual(reopened.project.nodes.t1.data!.rowGroups, undefined);
  strictEqual(reopened.updated, false);
  // A broken band is left out on its own: the valid bands stay, and the
  // warning names the band that went.
  for (const [rowGroups, kept, dropped] of [
    [[{ name: "", count: 1 }, { name: "KO", count: 1 }], [{ name: "KO", count: 1 }], "a band with no name"],
    [
      [{ name: "WT", count: 1 }, { name: "WT", count: 1 }],
      [{ name: "WT", count: 1 }],
      "a second band with this name",
    ],
    [[{ name: "WT", count: 0 }, { name: "KO", count: 2 }], [{ name: "KO", count: 2 }], "“WT” (count 0)"],
    [[{ name: "WT", count: 1.5 }, { name: "KO", count: 1 }], [{ name: "KO", count: 1 }], "“WT” (count 1.5)"],
  ] as const) {
    const broken = JSON.parse(serializeProjectFile(project));
    broken.project.nodes.t1.data.rowGroups = rowGroups;
    const result = read(JSON.stringify(broken));
    deepStrictEqual(result.project.nodes.t1.data!.rowGroups, kept);
    ok(
      result.issues.some((i) => i.message.includes("left out a row group") && i.message.includes(dropped)),
      `expected a warning naming ${dropped}, got ${JSON.stringify(result.issues)}`,
    );
  }
  // Every band broken reads as no third factor — still with a warning.
  const allBroken = JSON.parse(serializeProjectFile(project));
  allBroken.project.nodes.t1.data.rowGroups = [{ name: "", count: 0 }];
  const allBrokenResult = read(JSON.stringify(allBroken));
  strictEqual(allBrokenResult.project.nodes.t1.data!.rowGroups, undefined);
  ok(allBrokenResult.issues.some((i) => i.message.includes("left out a row group")));
  // A rowGroups that isn't a list at all reads as no third factor, silently,
  // like a missing field.
  const notAList = JSON.parse(serializeProjectFile(project));
  notAList.project.nodes.t1.data.rowGroups = "WT/KO";
  strictEqual(read(JSON.stringify(notAList)).project.nodes.t1.data!.rowGroups, undefined);
  strictEqual(read(JSON.stringify(notAList)).issues.length, 0);
  // A three-way analysis's posthocTerm survives the same round-trip; a bogus
  // term falls back (the runner takes its default).
  const withAnalysis: ProjectFilePayload = {
    ...project,
    nodes: {
      ...project.nodes,
      a1: {
        id: "a1",
        type: "analysis",
        name: "A",
        parentId: "t1",
        analysisType: "three-way-anova",
        analysisParams: { posthoc: "tukey", posthocTerm: "A:B" },
      },
    },
    childOrder: { t1: ["a1"] },
  };
  deepStrictEqual(read(serializeProjectFile(withAnalysis)).project.nodes.a1.analysisParams, {
    posthoc: "tukey",
    posthocTerm: "A:B",
  });
  const bogus = JSON.parse(serializeProjectFile(withAnalysis));
  bogus.project.nodes.a1.analysisParams.posthocTerm = "A:B:C:D";
  strictEqual(
    (read(JSON.stringify(bogus)).project.nodes.a1.analysisParams as { posthocTerm?: string } | undefined)
      ?.posthocTerm,
    undefined,
  );
});

check("a malformed row-group band no longer blocks the three-way ANOVA", async () => {
  const project: ProjectFilePayload = {
    nodes: {
      t1: {
        id: "t1",
        type: "table",
        name: "T",
        parentId: null,
        tableType: "grouped",
        data: {
          columns: ["Title", "A:Y1", "A:Y2", "B:Y1", "B:Y2"],
          rows: [
            ["Day 1", "1", "2", "3", "4"],
            ["Day 2", "5", "6", "7", "8"],
            ["Day 1", "9", "10", "11", "12"],
            ["Day 2", "13", "14", "15", "16"],
          ],
          groups: 2,
          replicates: 2,
          rowGroups: [
            { name: "WT", count: 2 },
            { name: "KO", count: 2 },
            { name: "", count: 2 },
          ],
        },
      },
    },
    rootOrder: ["t1"],
    childOrder: { t1: [] },
    activeNodeId: "t1",
  };
  const result = read(serializeProjectFile(project));
  deepStrictEqual(result.project.nodes.t1.data!.rowGroups, [
    { name: "WT", count: 2 },
    { name: "KO", count: 2 },
  ]);
  ok(result.issues.some((i) => i.message.includes("a band with no name")));
  // Before this fix the whole third factor was dropped on load, so the run
  // failed with the misleading "needs row groups" error.
  const out = await runAnalysis("three-way-anova", result.project.nodes.t1.data!);
  if ("error" in out) throw new Error(`three-way ANOVA should run, got ${out.error}`);
});

check("the three-way ANOVA is offered only with at least 2 row bands", () => {
  const withBands: TableData = {
    columns: ["Title", "A:Y1"],
    rows: [["r1", "1"], ["r2", "2"]],
    groups: 1,
    replicates: 1,
    rowGroups: [
      { name: "WT", count: 1 },
      { name: "KO", count: 1 },
    ],
  };
  const values = (data?: TableData) => analysisOptionsForTable("grouped", data).map((o) => o.value);
  deepStrictEqual(values(withBands), ["two-way-anova", "mixed-effects", "three-way-anova", "multiple-t-tests"]);
  deepStrictEqual(values({ ...withBands, rowGroups: [{ name: "All rows", count: 2 }] }), [
    "two-way-anova",
    "mixed-effects",
    "multiple-t-tests",
  ]);
  deepStrictEqual(values({ ...withBands, rowGroups: undefined }), [
    "two-way-anova",
    "mixed-effects",
    "multiple-t-tests",
  ]);
  deepStrictEqual(values(), ["two-way-anova", "mixed-effects", "multiple-t-tests"]);
});

// The native Analysis menu's effect depends on this key, not on the table data
// itself: it must change exactly when the data-dependent items change, or the
// menu goes stale once isDirty is true and consecutive edits share an undoName
// (BUG-REPORT #16 — three-way ANOVA, nested t-test, nested ANOVA).
check("the native Analysis menu key follows the data-dependent tests (R3-16)", () => {
  const grouped: TableData = {
    columns: ["Title", "A:Y1"],
    rows: [["r1", "1"], ["r2", "2"]],
    groups: 1,
    replicates: 1,
    rowGroups: [{ name: "All rows", count: 2 }],
  };
  const twoBands: TableData = {
    ...grouped,
    rowGroups: [
      { name: "WT", count: 1 },
      { name: "KO", count: 1 },
    ],
  };
  // A second row band offers the three-way ANOVA, so the key must change.
  ok(analysisOptionsKey("grouped", grouped) !== analysisOptionsKey("grouped", twoBands));
  ok(analysisOptionsKey("grouped", twoBands).includes("three-way-anova"));
  // A value-only edit leaves the offered set alone, so the key stays put.
  strictEqual(
    analysisOptionsKey("grouped", twoBands),
    analysisOptionsKey("grouped", { ...twoBands, rows: [["r1", "9"], ["r2", "8"]] }),
  );
  const nestedTwo: TableData = {
    columns: ["Title", "A:S1:R1", "B:S1:R1"],
    rows: [[null, "1", "2"]],
    groups: 2,
    subgroups: 1,
    replicates: 1,
  };
  const nestedThree: TableData = {
    columns: ["Title", "A:S1:R1", "B:S1:R1", "C:S1:R1"],
    rows: [[null, "1", "2", "3"]],
    groups: 3,
    subgroups: 1,
    replicates: 1,
  };
  // A third data group swaps the nested t-test for the nested ANOVA.
  ok(analysisOptionsKey("nested", nestedTwo) !== analysisOptionsKey("nested", nestedThree));
  strictEqual(analysisOptionsKey("nested", nestedTwo), "nested-t-test");
  strictEqual(analysisOptionsKey("nested", nestedThree), "nested-anova");
  strictEqual(analysisOptionsKey(undefined, nestedTwo), "");
});

check("the three-way ANOVA wizard asks for a post-hoc term only when comparing", () => {
  const table = readTable({
    columns: ["Title", "A:Y1", "A:Y2", "B:Y1", "B:Y2"],
    rows: [
      ["r1", "1", "2", "3", "4"],
      ["r2", "5", "6", "7", "8"],
    ],
    groups: 2,
    replicates: 2,
  });
  const wizard = WIZARDS["three-way-anova"]!;
  const asked = (a: Record<string, string | number | string[] | undefined>) =>
    wizard.questions(a, table).filter((q): q is Question => q !== false);
  deepStrictEqual(
    asked({}).map((q) => q.id),
    ["posthoc", "posthocTerm"],
  );
  deepStrictEqual(
    asked({ posthoc: "none" }).map((q) => q.id),
    ["posthoc"],
  );
  deepStrictEqual(
    asked({ posthoc: "tukey" }).map((q) => q.id),
    ["posthoc", "posthocTerm"],
  );
  // The term defaults to A (the wizard cannot know significance yet); "none"
  // carries no term at all.
  deepStrictEqual(wizard.finish({ posthoc: "tukey" }, table), {
    type: "three-way-anova",
    params: { posthoc: "tukey", posthocTerm: "A" },
  });
  deepStrictEqual(wizard.finish({ posthoc: "none" }, table), {
    type: "three-way-anova",
    params: { posthoc: "none" },
  });
  deepStrictEqual(wizard.finish({ posthoc: "bonferroni", posthocTerm: "A:B:C" }, table), {
    type: "three-way-anova",
    params: { posthoc: "bonferroni", posthocTerm: "A:B:C" },
  });
});

check("a column gone takes its width with it: a new one of its name starts at the default", () => {
  const wide = { columns: ["Title", "A", "B", "C"], rows: [], widths: { A: 200, C: 150 } };
  deepStrictEqual(deleteColumns(wide, 3, 1).widths, { A: 200 });
  strictEqual(deleteColumns(wide, 1, 1).widths?.A, undefined);
  const t = { ...regroupTable(grouped(), 2, 3), widths: { "A:Y3": 120, "A:Y1": 90 } };
  deepStrictEqual(regroupTable(t, 2, 2).widths, { "A:Y1": 90 });
});

check("an XY table with a renamed X gets Y columns, not a second X", () => {
  deepStrictEqual(freshColumnNames(["Title", "Dose", "Y1"], "xy", 2), ["Y2", "Y3"]);
  deepStrictEqual(freshColumnNames(["Title"], "xy", 2), ["X", "Y1"]);
});

check("a new column is named for its place: a renamed one never frees its name", () => {
  deepStrictEqual(freshColumnNames(["Title", "Control", "B", "C"], "column", 2), ["D", "E"]);
  deepStrictEqual(freshColumnNames(["Title", "A", "C"], "column", 2), ["D", "E"]); // C, the 3rd's, is taken
  deepStrictEqual(freshColumnNames(["Title", "Time", "Vehicle"], "survival", 1), ["Group B"]);
});

check("too large a number to be one is text", () => {
  deepStrictEqual(
    readTable({
      columns: ["Title", "A"],
      rows: [
        [null, "1e999"],
        [null, "1e300"],
      ],
    }).columns[0].values,
    [1e300],
  );
});

// ── Renamed columns and moved rows ───────────────────────────────────────

check("a column whose name holds ':' keeps its points' styles when renamed", () => {
  const node: ProjectNode = {
    id: "g",
    type: "graph",
    name: "G",
    parentId: "t",
    graphType: "individual",
    graphOptions: { ...DEFAULT_GRAPH_OPTIONS, points: { "Dose: 5#0": { color: "#ff0000" } } },
  };
  const o = followTable(node, { renamed: { "Dose: 5": "Low" } }, ["Title", "Low"]).graphOptions!;
  deepStrictEqual(o.points, { "Low#0": { color: "#ff0000" } });
  const kept = followTable(node, { renamed: { Dose: "X" } }, ["Title", "Dose: 5", "X"]).graphOptions!;
  deepStrictEqual(kept.points, { "Dose: 5#0": { color: "#ff0000" } });
});

check("comparing groups asks equal SDs, then offers the comparisons that fit and a control", () => {
  const wizard = WIZARDS["compare-many-groups"]!;
  const table = readTable({ columns: ["Title", "A", "B", "C"], rows: [["", "1", "2", "3"]] });
  const asked = (a: Record<string, string>) => wizard.questions(a, table).flatMap((q) => (q ? [q] : []));
  const offered = (a: Record<string, string>) => {
    const q = asked(a).find((q) => q.id === "posthoc");
    return q?.kind === "choice" ? q.options.map((o) => o.value) : [];
  };
  const unpaired = { paired: "unpaired", gaussian: "yes" };
  deepStrictEqual(offered({ ...unpaired, equalSd: "yes" }), [
    "none",
    "tukey",
    "bonferroni",
    "sidak",
    "holm-sidak",
    "lsd",
    "dunnett",
  ]);
  deepStrictEqual(offered({ ...unpaired, equalSd: "no" }), ["none", "games-howell", "t3"]);
  deepStrictEqual(offered({ paired: "paired", gaussian: "yes" }), [
    "none",
    "tukey",
    "bonferroni",
    "sidak",
    "holm-sidak",
    "lsd",
  ]);
  deepStrictEqual(offered({ paired: "unpaired", gaussian: "no" }), [
    "none",
    "dunn",
    "dunn-sidak",
    "dunn-holm-sidak",
  ]);
  ok(!asked({ paired: "paired", gaussian: "yes" }).some((q) => q.id === "equalSd"));
  ok(asked({ paired: "paired", gaussian: "yes" }).some((q) => q.id === "sphericity"));
  ok(!asked({ ...unpaired }).some((q) => q.id === "sphericity"));
  deepStrictEqual(wizard.finish({ paired: "paired", gaussian: "yes", sphericity: "no", posthoc: "tukey" }, table), {
    type: "rm-anova",
    params: { posthoc: "tukey", sphericity: false },
  });
  ok(asked({ ...unpaired, equalSd: "yes", posthoc: "dunnett" }).some((q) => q.id === "control"));
  deepStrictEqual(wizard.finish({ ...unpaired, equalSd: "yes", posthoc: "dunnett", control: "B" }, table), {
    type: "anova",
    params: { posthoc: "dunnett", equalSd: true, control: "B" },
  });
  deepStrictEqual(wizard.finish({ ...unpaired, equalSd: "no", posthoc: "t3", control: "B" }, table).params, {
    posthoc: "t3",
    equalSd: false,
  });
});

// Welch's ANOVA + unequal-SD post-hocs (plan 34): Games-Howell and
// Dunnett's T3 assume unequal SDs, so a saved analysis forcing them onto the
// ordinary ANOVA must error rather than silently run; Welch's ANOVA needs at
// least 2 values in each group; Dunnett with a missing control errors naming it.
check("Games-Howell and Dunnett's T3 need Welch's ANOVA, and Welch needs two values a group", async () => {
  const table: TableData = {
    columns: ["Title", "A", "B", "C"],
    rows: [
      ["", "12.1", "14.3", "18.2"],
      ["", "11.4", "15.1", "19.9"],
      ["", "13.2", "13.8", "17.5"],
      ["", "12.8", "16.2", "21.3"],
      ["", "10.9", "14.9", "18.8"],
    ],
  };
  for (const posthoc of ["games-howell", "t3"] as const) {
    for (const params of [{ posthoc }, { posthoc, equalSd: true }] as const) {
      const out = await runAnalysis("anova", table, params as AnalysisParams);
      if (!("error" in out) || !out.error.includes(posthoc === "games-howell" ? "Games-Howell" : "Dunnett's T3"))
        throw new Error(`expected the unequal-SDs error for ${JSON.stringify(params)}, got ${JSON.stringify(out)}`);
    }
    const welch = await runAnalysis("anova", table, { posthoc, equalSd: false } as AnalysisParams);
    if ("error" in welch) throw new Error(`Welch ${posthoc} should run, got ${welch.error}`);
  }
  const one = await runAnalysis(
    "anova",
    { columns: ["Title", "A", "B", "C"], rows: [["", "12.1", "14.3", "18.2"]] },
    { equalSd: false } as AnalysisParams,
  );
  if (!("error" in one) || !one.error.includes("holds 1 value"))
    throw new Error(`expected the too-few-values error, got ${JSON.stringify(one)}`);
  const missing = await runAnalysis("anova", table, { posthoc: "dunnett", control: "Missing" } as AnalysisParams);
  if (!("error" in missing) || !missing.error.includes("Missing"))
    throw new Error(`expected the missing-control error, got ${JSON.stringify(missing)}`);
});

check("a two-way ANOVA of one value per cell asks nothing and runs the ordinary one", () => {
  const wizard = WIZARDS["two-way-anova"]!;
  const single = readTable({
    columns: ["Title", "A:Y1", "A:Y2", "B:Y1", "B:Y2"],
    rows: [["a", "1", null, "2", null]],
    groups: 2,
    replicates: 2,
  });
  deepStrictEqual(wizard.questions({}, single).filter(Boolean), []);
  deepStrictEqual(wizard.finish({}, single).params, { design: "ordinary", posthoc: "none", posthocTarget: "groups" });
  const replicated = readTable({
    columns: ["Title", "A:Y1", "A:Y2", "B:Y1", "B:Y2"],
    rows: [["a", "1", "3", "2", null]],
    groups: 2,
    replicates: 2,
  });
  ok(wizard.questions({}, replicated).some((q) => q && q.id === "design"));
  // Repeated measures ask about sphericity; not assuming it is what new analyses take.
  ok(wizard.questions({ design: "repeated-measures" }, replicated).some((q) => q && q.id === "sphericity"));
  ok(!wizard.questions({ design: "ordinary" }, replicated).some((q) => q && q.id === "sphericity"));
  deepStrictEqual(wizard.finish({ design: "repeated-measures", sphericity: "no" }, replicated).params, {
    design: "repeated-measures",
    posthoc: "none",
    posthocTarget: "groups",
    sphericity: false,
  });
});

// BUG-REPORT #14 (FL-R3-14): a repeated-measures two-way ANOVA used to crash
// inside R with "missing value where TRUE/FALSE needed" when one group had a
// single complete subject — cov() of one row is all NA, and 0 * NA is NA,
// poisoning the pooled covariance S and the Geisser-Greenhouse epsilon (the
// GG code is spliced in even when sphericity is assumed). The single-subject
// group now contributes a zero matrix to S, and one subject per group in
// every group is refused up front instead of crashing in R.
check("a repeated-measures two-way ANOVA survives a group with one complete subject (FL-R3-14)", async () => {
  // Group A has 3 complete subjects; Group B has 1 (Y2 misses row 3, Y3 misses row 1).
  const table: TableData = {
    columns: ["Title", "A:Y1", "A:Y2", "A:Y3", "B:Y1", "B:Y2", "B:Y3"],
    rows: [
      ["", "10", "12", "11", "20", "22", null],
      ["", "13", "14", "15", "24", "25", "26"],
      ["", "16", "17", "18", "27", null, "29"],
    ],
    groups: 2,
    replicates: 3,
  };
  const params = { design: "repeated-measures", sphericity: false, posthoc: "none", posthocTarget: "groups" } as AnalysisParams;
  const out = await runAnalysis("two-way-anova", table, params);
  if ("error" in out) throw new Error(`expected a result, got ${out.error}`);
  const stats = Object.fromEntries(out.stats.map((s) => [s.label, s.value]));
  // Epsilon 0.5 and the corrected P values, verified against an independent
  // (pure-JS) computation of the pooled covariance and the F distribution.
  ok(Math.abs((stats["Geisser-Greenhouse epsilon"] ?? NaN) - 0.5) < 1e-12);
  ok(Math.abs((stats["Row P value"] ?? NaN) - 0.008421202561088295) < 1e-9);
  ok(Math.abs((stats["Interaction P value"] ?? NaN) - 0.47776703213290367) < 1e-9);
  // Sphericity assumed: same data, no GG correction, no epsilon reported.
  const assumed = await runAnalysis("two-way-anova", table, { ...params, sphericity: true });
  if ("error" in assumed) throw new Error(`expected a result with sphericity assumed, got ${assumed.error}`);
  const assumedStats = Object.fromEntries(assumed.stats.map((s) => [s.label, s.value]));
  ok(!assumed.stats.some((s) => s.label === "Geisser-Greenhouse epsilon"));
  ok(Math.abs((assumedStats["Row P value"] ?? NaN) - 0.0002812828254859835) < 1e-9);
  // One complete subject per group in every group: no residual variation, so a
  // clean error, not an R crash.
  const allSingle: TableData = {
    columns: ["Title", "A:Y1", "A:Y2", "B:Y1", "B:Y2"],
    rows: [
      ["", "10", "12", "20", null],
      ["", "13", null, "24", "25"],
      ["", "16", "17", "27", "29"],
    ],
    groups: 2,
    replicates: 2,
  };
  const refused = await runAnalysis("two-way-anova", allSingle, params);
  if (!("error" in refused) || !refused.error.includes("more complete subjects than column groups"))
    throw new Error(`expected the too-few-subjects error, got ${JSON.stringify(refused)}`);
});

// BUG-REPORT #26 (FL-R3-26): partial AnalysisParams used to crash (or refuse)
// four runners — `params ?? DEFAULTS` only covers a wholly missing params
// object, so a partial one left fields `undefined` and R saw
// `alternative="undefined"` / `p.adjust(pr,"undefined")`, or the runner
// refused with a "“undefined” multiple comparisons" error. Each runner now
// merges over its defaults, so a partial object runs with the missing fields
// defaulted.
check("partial compare-two-groups params fall back to the defaults (FL-R3-26)", async () => {
  const out = await runAnalysis("compare-two-groups", treatments(["Control", "Drug A"]), {
    paired: false,
  } as AnalysisParams);
  if ("error" in out) throw new Error(`expected a result, got ${out.error}`);
  strictEqual(out.subtitle, "Unpaired t test");
});

check("partial nested-anova params fall back to no post-hoc (FL-R3-26)", async () => {
  const table: TableData = {
    columns: ["Title", "A:S1:R1", "A:S2:R1", "B:S1:R1", "B:S2:R1", "C:S1:R1", "C:S2:R1"],
    rows: [[null, "1", "2", "3", "4", "5", "6"]],
    groups: 3,
    subgroups: 2,
    replicates: 1,
  };
  const out = await runAnalysis("nested-anova", table, {} as AnalysisParams);
  if ("error" in out) throw new Error(`expected a result, got ${out.error}`);
  strictEqual(out.stats.find((s) => s.label === "Groups")?.value, 3);
});

check("partial two-way-anova params fall back to the ordinary design (FL-R3-26)", async () => {
  const table: TableData = {
    columns: ["Title", "A:Y1", "A:Y2", "B:Y1", "B:Y2"],
    rows: [
      ["a", "1", "3", "2", "4"],
      ["b", "5", "6", "7", "8"],
      ["c", "9", "10", "11", "12"],
    ],
    groups: 2,
    replicates: 2,
  };
  const out = await runAnalysis("two-way-anova", table, { design: "ordinary" } as AnalysisParams);
  if ("error" in out) throw new Error(`expected a result, got ${out.error}`);
  strictEqual(out.subtitle, "Ordinary two-way ANOVA");
});

check("partial multiple-t-tests params fall back to the unpaired Gaussian Holm defaults (FL-R3-26)", async () => {
  const data: TableData = {
    columns: ["Title", "A:1", "A:2", "A:3", "B:1", "B:2", "B:3"],
    rows: [
      ["r1", "1", "2", "3", "4", "5", "6"],
      ["r2", "2", "3", "4", "5", "6", "7"],
    ],
  };
  const out = await runAnalysis("multiple-t-tests", data, {} as AnalysisParams);
  if ("error" in out) throw new Error(`expected a result, got ${out.error}`);
  strictEqual(out.stats.find((s) => s.label === "Rows compared")?.value, 2);
  ok(out.comparisons!.every((c) => c.p !== null), "every row completes with a P value");
});

// BUG-REPORT #26, leg 2 (FL-R3-26): installBatch used to call evalNamedVector
// with no timeout, so the 300 s EVAL_TIMEOUT_MS aborted a package install
// before the 360 s PACKAGE_INSTALL_TIMEOUT_MS — and classifyInstallError
// then misread the EvalTimeoutError as "install-failed". The install eval
// now carries the install budget. A runtime repro would need a >300 s
// install, so this pins the call itself.
check("installBatch gives the install eval the package-install timeout (FL-R3-26)", () => {
  const webr = readFileSync("src/stats/webr.ts", "utf8");
  const batch = webr.slice(webr.indexOf("async function installBatch"));
  ok(
    /const loaded = await evalNamedVector\(code, \{ timeoutMs \}\)/.test(batch),
    "installBatch must pass { timeoutMs } to evalNamedVector",
  );
});

// R2-B3: with X + 1 Y the enzyme-inhibition wizard used to dead-end — the
// model defaulted to a global fit whose Y question needed min: 2 from a
// single option, so Next stayed disabled with no message. Now only Morrison
// (a single-curve fit) is offered, the question says why the global models
// are missing, and the wizard reaches Run.
check("the enzyme-inhibition wizard completes with X + 1 Y (Morrison only)", () => {
  const wizard = WIZARDS["enzyme-inhibition"]!;
  const oneY = readTable({
    columns: ["Title", "X", "Y1"],
    rows: [
      ["", "0", "10"],
      ["", "1", "9"],
      ["", "2", "7"],
      ["", "5", "4"],
      ["", "10", "2"],
    ],
  });
  const modelQ = wizard.questions({}, oneY).filter(Boolean)[0] as Question;
  if (modelQ.kind !== "choice") throw new Error("expected the model choice first");
  deepStrictEqual(
    modelQ.options.map((o) => o.value),
    ["morrison"],
  );
  ok(/at least two Y data sets/.test(modelQ.ask), `model question should name the shortfall, got: ${modelQ.ask}`);
  // The Y question can be satisfied: one option, min 1 — so every question
  // in the walk has options >= min and Next is never permanently disabled.
  const yQ = wizard.questions({ model: "morrison" }, oneY).filter(Boolean)[1] as Question;
  if (yQ.kind !== "names") throw new Error("expected the Y names question second");
  deepStrictEqual(yQ.options, ["Y1"]);
  strictEqual(yQ.min, 1);
  deepStrictEqual(wizard.finish({ model: "morrison", y: ["Y1"], enzymeConcentration: "5" }, oneY), {
    type: "enzyme-inhibition",
    params: { model: "morrison", y: ["Y1"], enzymeConcentration: 5 },
  });
  // With two Y data sets the global models are back, and the Y question
  // says at least two are needed for a global fit.
  const twoY = readTable({
    columns: ["Title", "X", "Y1", "Y2"],
    rows: [
      ["", "0", "10", "10"],
      ["", "1", "9", "9"],
      ["", "2", "7", "8"],
      ["", "5", "4", "6"],
      ["", "10", "2", "4"],
    ],
  });
  const modelQ2 = wizard.questions({}, twoY).filter(Boolean)[0] as Question;
  if (modelQ2.kind !== "choice") throw new Error("expected the model choice first");
  deepStrictEqual(
    modelQ2.options.map((o) => o.value),
    ["mixed", "competitive", "noncompetitive", "uncompetitive", "morrison"],
  );
  const yQ2 = wizard.questions({ model: "mixed" }, twoY).filter(Boolean)[1] as Question;
  if (yQ2.kind !== "names") throw new Error("expected the Y names question second");
  ok(/at least two/.test(yQ2.ask), `global Y question should state the minimum, got: ${yQ2.ask}`);
  strictEqual(yQ2.min, 2);
});

check("a saved analysis without sphericity still assumes it (Geisser-Greenhouse compat)", async () => {
  // Geisser-Greenhouse is the default for new analyses, but a file saved
  // before 1.0.7 has no `sphericity` field — loading it must keep the
  // sphericity-assumed result, not silently correct it. The table is the
  // reference `matched` fixture; the uncorrected F/df/P are its pinned values.
  const matched: TableData = {
    columns: ["Title", "Day 0", "Day 7", "Day 14"],
    rows: [
      ["", "10.1", "12.0", "15.2"],
      ["", "9.8", "12.9", "18.1"],
      ["", "11.2", "13.1", "14.0"],
      ["", "10.5", "14.2", "21.3"],
      ["", "9.9", "11.8", "13.1"],
      ["", "10.8", "13.6", "19.4"],
    ],
  };
  const file = JSON.parse(
    serializeProjectFile({
      nodes: {
        t1: { id: "t1", type: "table", name: "Matched", parentId: null, tableType: "column", data: matched },
        a1: {
          id: "a1",
          type: "analysis",
          name: "RM ANOVA",
          parentId: "t1",
          analysisType: "rm-anova",
          analysisParams: { posthoc: "tukey" },
        },
      },
      rootOrder: ["t1"],
      childOrder: { t1: ["a1"] },
      activeNodeId: "a1",
    }),
  );
  ok(!("sphericity" in file.project.nodes.a1.analysisParams));
  const { project } = read(JSON.stringify(file));
  const node = project.nodes.a1;
  if (!node || node.type !== "analysis") throw new Error("no analysis after load");
  strictEqual("sphericity" in (node.analysisParams ?? {}), false);
  const out = await runAnalysis("rm-anova", project.nodes.t1.data!, node.analysisParams as AnalysisParams);
  if ("error" in out) throw new Error(out.error);
  const stats = Object.fromEntries(out.stats.map((s) => [s.label, s.value]));
  ok(Math.abs((stats.F ?? NaN) - 21.84728313) < 1e-8);
  strictEqual(stats.DFn, 2);
  strictEqual(stats.DFd, 10);
  ok(Math.abs((stats["P value"] ?? NaN) - 0.0002240517331) < 1e-9);
  ok(!out.stats.some((s) => s.label === "Geisser-Greenhouse epsilon"));
  ok(out.notes.includes("Assumes sphericity (no Geisser-Greenhouse correction)."));
});

check("fitting a curve asks its kind, then its model, then what to compare", () => {
  const wizard = WIZARDS["nonlinear-regression"]!;
  const table = readTable({ columns: ["Title", "X", "A", "B"], rows: [["", "1", "2", "3"]] });
  const asked = (a: Record<string, string>) => wizard.questions(a, table).flatMap((q) => (q ? [q] : []));
  const options = (a: Record<string, string>, id: string) => {
    const q = asked(a).find((q) => q.id === id);
    return q?.kind === "choice" ? q.options.map((o) => o.value) : [];
  };
  ok(options({ kind: "dose" }, "model").includes("asymmetric-5pl-logx"));
  ok(!options({ kind: "other" }, "model").includes("sigmoidal-4pl-logx"));
  deepStrictEqual(options({ y: "A", kind: "dose" }, "compareWith"), ["none", "B"]);
  ok(!asked({ y: "A", kind: "other" }).some((q) => q.id === "compareWith"));
  ok(!asked({ y: "A", kind: "dose", compareWith: "none" }).some((q) => q.id === "compare"));
  deepStrictEqual(
    wizard.finish({ y: "A", kind: "dose", model: "inhibitor-3pl-logx", compareWith: "B", compare: "ec50" }, table),
    {
      type: "nonlinear-regression",
      params: { y: "A", model: "inhibitor-3pl-logx", compareWith: "B", compare: "ec50" },
    },
  );
  deepStrictEqual(wizard.finish({ y: "A", kind: "other", model: "line", compareWith: "B" }, table).params, {
    y: "A",
    model: "line",
  });
  // Binding competition (plan 28): the dose list gains the two-site and
  // homologous models; the Fit-Ki toggle appears on competition models only,
  // then [L] and Kd — [L] only for homologous, whose Kd is fitted.
  ok(options({ kind: "dose" }, "model").includes("two-site-competition-logx"));
  ok(options({ kind: "dose" }, "model").includes("homologous-competition-logx"));
  ok(!options({ kind: "other" }, "model").includes("two-site-competition-logx"));
  // Merge note (plans 26+28): the merged wizard also asks plan 26's
  // framework questions (weights, compareModel, global, constrain) before
  // the Fit-Ki toggle, in that order.
  deepStrictEqual(asked({ y: "A", kind: "dose", model: "inhibitor-3pl-logx" }).map((q) => q.id), [
    "y",
    "kind",
    "model",
    "weights",
    "compareWith",
    "compareModel",
    "global",
    "constrain",
    "fitKi",
  ]);
  deepStrictEqual(
    asked({ y: "A", kind: "dose", model: "inhibitor-3pl-logx", fitKi: "yes" }).map((q) => q.id),
    [
      "y",
      "kind",
      "model",
      "weights",
      "compareWith",
      "compareModel",
      "global",
      "constrain",
      "fitKi",
      "ligandConcentration",
      "ligandKd",
    ],
  );
  deepStrictEqual(
    asked({ y: "A", kind: "dose", model: "homologous-competition-logx" }).map((q) => q.id),
    ["y", "kind", "model", "weights", "compareWith", "compareModel", "global", "constrain", "ligandConcentration"],
  );
  ok(!asked({ y: "A", kind: "dose", model: "sigmoidal-4pl-logx" }).some((q) => q.id === "fitKi"));
  deepStrictEqual(
    wizard.finish(
      { y: "A", kind: "dose", model: "inhibitor-3pl-logx", fitKi: "yes", ligandConcentration: "1", ligandKd: "0.5" },
      table,
    ).params,
    { y: "A", model: "inhibitor-3pl-logx", fitKi: true, ligandConcentration: 1, ligandKd: 0.5 },
  );
  deepStrictEqual(
    wizard.finish({ y: "A", kind: "dose", model: "homologous-competition-logx", ligandConcentration: "1" }, table)
      .params,
    { y: "A", model: "homologous-competition-logx", ligandConcentration: 1 },
  );
});

// Plan 26: the nonlinear wizard's framework questions — weighting (1/SD²
// only when the table has replicates), the model comparison (never the
// model itself), the global fit (opt-in, then which series and which
// parameters), and the advanced fix/bounds fields — and what finish makes
// of them.
check("the curve wizard asks about weighting, comparing models and global fits", () => {
  const wizard = WIZARDS["nonlinear-regression"]!;
  const oneY = readTable({ columns: ["Title", "X", "A"], rows: [["", "1", "2"]] });
  const twoY = readTable({ columns: ["Title", "X", "A", "B"], rows: [["", "1", "2", "3"]] });
  const asked = (a: Record<string, string | string[]>, table: Dataset) =>
    wizard.questions(a, table).flatMap((q) => (q ? [q] : []));
  const options = (a: Record<string, string | string[]>, table: Dataset, id: string) => {
    const q = asked(a, table).find((q) => q.id === id);
    return q?.kind === "choice" ? q.options.map((o) => o.value) : [];
  };
  const ids = (a: Record<string, string | string[]>, table: Dataset) => asked(a, table).map((q) => q.id);
  deepStrictEqual(options({ kind: "other", model: "line" }, twoY, "weights"), [
    "none",
    "1/y",
    "1/y2",
    "1/x",
    "1/x2",
    "1/sd2",
  ]);
  ok(!options({ kind: "other", model: "line" }, oneY, "weights").includes("1/sd2"));
  ok(!options({ kind: "other", model: "line" }, twoY, "compareModel").includes("line"));
  ok(options({ kind: "other", model: "line" }, twoY, "compareModel").includes("quadratic"));
  // Plan 29: the completed lines & polynomials appear in the "other
  // curves" list, in Prism's order after cubic.
  deepStrictEqual(
    options({ kind: "other", model: "line" }, twoY, "model").filter((m) =>
      ["cubic", "segmental-linear", "quartic", "quintic"].includes(m),
    ),
    ["cubic", "segmental-linear", "quartic", "quintic"],
  );
  ok(!ids({ y: "A", kind: "dose", model: "sigmoidal-4pl-logx", global: "no" }, twoY).includes("globalY"));
  ok(ids({ y: "A", kind: "dose", model: "sigmoidal-4pl-logx", global: "yes" }, twoY).includes("globalY"));
  ok(
    ids({ y: "A", kind: "dose", model: "sigmoidal-4pl-logx", global: "yes", globalY: ["B"], shared: "custom" }, twoY).includes(
      "sharedParams",
    ),
  );
  ok(
    !ids(
      { y: "A", kind: "dose", model: "sigmoidal-4pl-logx", global: "yes", globalY: ["B"], shared: "default" },
      twoY,
    ).includes("sharedParams"),
  );
  ok(!ids({ y: "A", kind: "other", model: "line", constrain: "no" }, twoY).includes("fix_Slope"));
  ok(ids({ y: "A", kind: "other", model: "line", constrain: "yes" }, twoY).includes("fix_Slope"));
  ok(ids({ y: "A", kind: "other", model: "line", constrain: "yes" }, twoY).includes("bound_Slope"));
  deepStrictEqual(
    wizard.finish(
      {
        y: "A",
        kind: "dose",
        model: "sigmoidal-4pl-logx",
        weights: "1/y2",
        compareModel: "agonist-3pl-logx",
        global: "yes",
        globalY: ["B"],
        shared: "default",
        constrain: "yes",
        fix_HillSlope: "1",
        bound_Top: "",
      },
      twoY,
    ),
    {
      type: "nonlinear-regression",
      params: {
        y: "A",
        model: "sigmoidal-4pl-logx",
        weights: "1/y2",
        compareModel: "agonist-3pl-logx",
        globalY: ["B"],
        fixed: { HillSlope: 1 },
      },
    },
  );
  // Sharing every parameter passes the full list; sharing the usual ones
  // leaves sharedParams out (the runner's default).
  deepStrictEqual(
    wizard.finish(
      { y: "A", kind: "dose", model: "sigmoidal-4pl-logx", global: "yes", globalY: ["B"], shared: "all" },
      twoY,
    ).params,
    {
      y: "A",
      model: "sigmoidal-4pl-logx",
      globalY: ["B"],
      sharedParams: ["Bottom", "Top", "LogEC50", "HillSlope"],
    },
  );
});

// R3-11x: a global homologous fit with Kd = [L] exactly (LogKd = 0) used to
// crash — the shared LogKd start is the mean of the single-curve fits, so
// it sat exactly on the optimum and port misfired with "false convergence
// (8)". The global fit now retries once from nudged starts. Same fixture
// shape as the #11 homologous check, with LogKd = 0 in the generator.
check("a global homologous fit with Kd = [L] fits instead of failing on false convergence", async () => {
  const xs = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3];
  const noise = [0, 0.4, -0.3, 0.5, -0.4, 0.3, -0.5, 0.4, -0.3, 0.2, -0.2];
  const homo = (bmax: number) => (x: number) => (bmax * 1) / (1 + 10 ** x + 10 ** 0) + 10;
  const table: TableData = {
    columns: ["Title", "X", "Y1", "Y2"],
    rows: xs.map((x, i) => ["", String(x), String(homo(100)(x) + noise[i]), String(homo(95)(x) - noise[i])]),
  };
  const h = await runAnalysis("nonlinear-regression", table, {
    y: "Y1",
    model: "homologous-competition-logx",
    globalY: ["Y2"],
    ligandConcentration: 1,
  });
  ok(!("error" in h), `global homologous fit with Kd = [L] failed: ${"error" in h ? h.error : ""}`);
  const r2 = h.fit?.rows.find((r) => r.label === "R squared")?.values;
  ok(r2?.length === 2 && r2.every((v) => v != null && Number.isFinite(v) && v > 0.9), `per-series R² should be finite and > 0.9, got ${r2}`);
  const logKd = h.coefficients?.find((c) => c.term === "LogKd")?.estimate;
  ok(logKd != null && Math.abs(logKd) < 0.1, `fitted LogKd should be ~0 (Kd = [L]), got ${logKd}`);
});

// Plan 26: only nested model pairs get the F test, and AICc matches R
// (line AICc −19.5734 for RSS 0.3112, n = 8, k = 2 — verified in R).
check("only nested model pairs get the F test", () => {
  ok(nestedPair("line", "quadratic") !== null);
  deepStrictEqual(nestedPair("line", "quadratic"), { simpler: "line", complex: "quadratic" });
  deepStrictEqual(nestedPair("quadratic", "line"), { simpler: "line", complex: "quadratic" });
  // Plan 29: the polynomial ladder continues, but the segmental line is
  // not nested with the line for an F test (its breakpoint is
  // unidentified when B2 = 0).
  deepStrictEqual(nestedPair("cubic", "quartic"), { simpler: "cubic", complex: "quartic" });
  deepStrictEqual(nestedPair("quartic", "quintic"), { simpler: "quartic", complex: "quintic" });
  deepStrictEqual(nestedPair("line", "quintic"), { simpler: "line", complex: "quintic" });
  strictEqual(nestedPair("line", "segmental-linear"), null);
  strictEqual(nestedPair("line", "hyperbola"), null);
  strictEqual(nestedPair("sigmoidal-4pl-logx", "hyperbola"), null);
  strictEqual(nestedPair("sigmoidal-4pl-logx", "asymmetric-5pl-logx")?.complex, "asymmetric-5pl-logx");
  ok(Math.abs((aicc(0.3112, 8, 2) ?? 0) - -19.5734) < 0.001);
  strictEqual(aicc(1, 4, 3), null);
});

// R3-12: a weighted model comparison must fit both models weighted, a
// homologous comparison model must get [L], and the comparison model must
// be validated before R sees it. Before the fix both models were fitted
// unweighted (only their sums of squares were weighted afterward, so the
// F test and AICc were invalid), "homologous-competition-logx" as
// compareModel crashed on the unbound R variable L, and a comparison model
// needing more points — or different X — than the primary reached R.
check("a weighted model comparison fits both models weighted", async () => {
  const xs = [0, 1, 2, 3, 4, 5, 6, 7];
  const ys = [2, 5.1, 7.8, 11.4, 13.2, 18.5, 17.5, 27];
  const table: TableData = {
    columns: ["Title", "X", "Y1"],
    rows: xs.map((x, i) => ["", String(x), String(ys[i])]),
  };
  const out = await runAnalysis("nonlinear-regression", table, {
    y: "Y1",
    model: "line",
    compareModel: "quadratic",
    weights: "1/y2",
  });
  ok(!("error" in out), `weighted comparison failed: ${"error" in out ? out.error : ""}`);
  // Independent R: the weighted and unweighted line fits, and the weighted
  // quadratic's weighted sum of squares.
  const ref = await evalNamedVector(
    `x<-c(${xs.join(",")});y<-c(${ys.join(",")});w<-1/y^2;` +
      `mw<-lm(y~x,weights=w);mu<-lm(y~x);mq<-lm(y~x+I(x^2),weights=w);` +
      `c(bw=as.numeric(coef(mw)[2]),bu=as.numeric(coef(mu)[2]),ssq=sum(w*residuals(mq)^2))`,
  );
  const slope = out.coefficients?.find((c) => c.term === "Slope")?.estimate;
  ok(
    slope != null && ref.bw != null && Math.abs(slope - ref.bw) < 0.05,
    `Slope should be the weighted fit (${ref.bw}), got ${slope} (unweighted: ${ref.bu})`,
  );
  ok(
    ref.bw != null && ref.bu != null && Math.abs(ref.bw - ref.bu) > 0.1,
    `weighted and unweighted slopes should differ (weighted: ${ref.bw}, unweighted: ${ref.bu})`,
  );
  const ssB = out.stats?.find((s) => s.label === "Sum of squares (comparison model)")?.value;
  ok(
    ssB != null && ref.ssq != null && Math.abs(ssB - ref.ssq) < 0.05,
    `comparison SS should be the weighted quadratic's (${ref.ssq}), got ${ssB}`,
  );
  // Homologous competition as the comparison model: [L] must reach its spec.
  const hXs = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3];
  const hNoise = [0, 0.4, -0.3, 0.5, -0.4, 0.3, -0.5, 0.4, -0.3, 0.2, -0.2];
  const homo = (bmax: number) => (x: number) => (bmax * 1) / (1 + 10 ** x + 10 ** 0.3) + 10;
  const hTable: TableData = {
    columns: ["Title", "X", "Y1"],
    rows: hXs.map((x, i) => ["", String(x), String(homo(100)(x) + hNoise[i])]),
  };
  const h = await runAnalysis("nonlinear-regression", hTable, {
    y: "Y1",
    model: "inhibitor-3pl-logx",
    compareModel: "homologous-competition-logx",
    ligandConcentration: 1,
  });
  ok(!("error" in h), `homologous comparison failed: ${"error" in h ? h.error : ""}`);
  // A comparison model needing more points than the data holds is refused
  // up front, not left for R to choke on.
  const few: TableData = {
    columns: ["Title", "X", "Y1"],
    rows: [
      ["", "0", "2"],
      ["", "1", "5"],
      ["", "2", "8"],
      ["", "3", "11"],
      ["", "4", "14"],
    ],
  };
  const q = await runAnalysis("nonlinear-regression", few, {
    y: "Y1",
    model: "line",
    compareModel: "quintic",
  });
  ok("error" in q && q.error.includes("Not enough complete points"), `quintic comparison on 5 points should be refused up front, got ${"error" in q ? q.error : "no error"}`);
  // A comparison model needing different X than the primary (a log-X model
  // drops X = 0) is refused up front too.
  const s = await runAnalysis("nonlinear-regression", table, {
    y: "Y1",
    model: "line",
    compareModel: "semilog-line",
  });
  ok("error" in s && s.error.includes("same points"), `semilog comparison on data with X = 0 should be refused up front, got ${"error" in s ? s.error : "no error"}`);
});
check("a global fit's coefficients split per series for the overlay", () => {
  const row = (term: string, estimate: number): RegressionCoefficient => ({
    term,
    estimate,
    stdError: null,
    t: null,
    p: null,
    low: null,
    high: null,
  });
  const coefs = [
    row("LogEC50", -0.6),
    row("Bottom (Control)", 4.9),
    row("Bottom (Treated)", -3.2),
    row("Asymmetry (S)", 1.2),
  ];
  deepStrictEqual(
    coefficientsForSet(coefs, "Control", ["Control", "Treated"]).map((c) => c.term),
    ["LogEC50", "Bottom", "Asymmetry (S)"],
  );
  deepStrictEqual(
    coefficientsForSet(coefs, "Treated", ["Control", "Treated"]).map((c) => c.term),
    ["LogEC50", "Bottom", "Asymmetry (S)"],
  );
});

// R3-11: a global fit with a fixed parameter, and a global homologous fit.
// Fixed parameters were filtered out of the global fit's coefficients, so
// the per-series evaluator got NaN for them: every per-series R² was NaN,
// Span vanished, and the overlay drew nothing. The homologous curve also
// lost [L] on the way through (evaluateCurve, the returned result, and
// the multi-series overlay branch), so its R² was NaN too.
check("a global fit with a fixed parameter keeps finite R², Span and curves", async () => {
  const xs = [-9, -8.5, -8, -7.5, -7, -6.5, -6, -5.5, -5, -4.5, -4];
  const noise = [0, 0.4, -0.3, 0.5, -0.4, 0.3, -0.5, 0.4, -0.3, 0.2, -0.2];
  const fourPl = (top: number) => (x: number) => 0 + (top - 0) / (1 + 10 ** (-6.5 - x));
  const table: TableData = {
    columns: ["Title", "X", "Y1", "Y2"],
    rows: xs.map((x, i) => ["", String(x), String(fourPl(100)(x) + noise[i]), String(fourPl(90)(x) - noise[i])]),
  };
  const out = await runAnalysis("nonlinear-regression", table, {
    y: "Y1",
    model: "sigmoidal-4pl-logx",
    globalY: ["Y2"],
    fixed: { Bottom: 0 },
  });
  ok(!("error" in out), `global fit with fixed Bottom failed: ${"error" in out ? out.error : ""}`);
  const r2 = out.fit?.rows.find((r) => r.label === "R squared")?.values;
  ok(r2?.length === 2 && r2.every((v) => v != null && Number.isFinite(v) && v > 0.9), `per-series R² should be finite and > 0.9, got ${r2}`);
  const span = out.fit?.rows.find((r) => r.label === "Span")?.values;
  ok(span?.length === 2 && span.every((v) => v != null && v > 50), `Span should be present per series, got ${span}`);
  const bottom = out.coefficients?.find((c) => c.term === "Bottom");
  ok(bottom?.estimate === 0, `fixed Bottom should be reported as a coefficient, got ${bottom?.estimate}`);
  // The overlay's evaluator, per series, from the returned coefficients.
  const sets = out.fit?.sets ?? ["Y1", "Y2"];
  for (const [name, top] of [["Y1", 100], ["Y2", 90]] as const) {
    const atMid = evaluateCurve("sigmoidal-4pl-logx", coefficientsForSet(out.coefficients ?? [], name, sets), -6.5);
    ok(Number.isFinite(atMid) && Math.abs(atMid - top / 2) < 5, `${name} curve at X = -6.5 should be ~${top / 2}, got ${atMid}`);
  }
  // Homologous competition, globally: [L] must survive into the result
  // and the evaluator, or its R² is NaN and no curve draws. LogKd = 0.3
  // (Kd ≈ 2·[L]) puts the transition inside the X range; Kd = [L]
  // exactly starts the shared fit at its optimum and port misfires with
  // "false convergence (8)" — a pre-existing optimizer quirk, not this fix.
  const hXs = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3];
  const homo = (bmax: number) => (x: number) => (bmax * 1) / (1 + 10 ** x + 10 ** 0.3) + 10;
  const hTable: TableData = {
    columns: ["Title", "X", "Y1", "Y2"],
    rows: hXs.map((x, i) => ["", String(x), String(homo(100)(x) + noise[i]), String(homo(95)(x) - noise[i])]),
  };
  const h = await runAnalysis("nonlinear-regression", hTable, {
    y: "Y1",
    model: "homologous-competition-logx",
    globalY: ["Y2"],
    ligandConcentration: 1,
  });
  ok(!("error" in h), `global homologous fit failed: ${"error" in h ? h.error : ""}`);
  const hr2 = h.fit?.rows.find((r) => r.label === "R squared")?.values;
  ok(hr2?.length === 2 && hr2.every((v) => v != null && Number.isFinite(v) && v > 0.9), `homologous per-series R² should be finite and > 0.9, got ${hr2}`);
  ok(h.ligandConcentration === 1, `homologous result should carry [L], got ${h.ligandConcentration}`);
  const hSets = h.fit?.sets ?? ["Y1", "Y2"];
  const hAt = evaluateCurve(
    "homologous-competition-logx",
    coefficientsForSet(h.coefficients ?? [], "Y1", hSets),
    0,
    h.ligandConcentration,
  );
  // At X = 0 the curve is Bmax/(2 + 10^0.3) + Bottom ≈ 35.0.
  ok(Number.isFinite(hAt) && Math.abs(hAt - 35) < 5, `homologous curve at X = 0 should be ~35, got ${hAt}`);
});

// Plan 26: the closed-form inverses agree with R — the plan's pinned
// values (line Y = 10 → X = 4.4760; 4PL Y = 50 → X = −0.8467, both
// verified in R) and the interpolation path's own uniroot X for the same
// fitted curve.
check("closed-form inverses read unknowns off the fitted curve", async () => {
  const xy: TableData = {
    columns: ["Title", "X", "Y1"],
    rows: [
      ["", "0", "1.1"],
      ["", "1", "2.9"],
      ["", "2", "5.2"],
      ["", "3", "6.8"],
      ["", "4", "9.1"],
      ["", "5", "11.2"],
      ["", "6", "12.7"],
      ["", "", "15"],
      ["", "8", "17.3"],
    ],
  };
  const line = await runAnalysis("nonlinear-regression", xy, { y: "Y1", model: "line" });
  ok(!("error" in line) && line.coefficients);
  const lineX = invertModel("line", line.coefficients, 10);
  ok(lineX != null && Math.abs(lineX - 4.476) < 0.002);
  const interp = await runAnalysis("nonlinear-regression", xy, { y: "Y1", model: "line", interpolate: true });
  ok(!("error" in interp) && interp.interpolated?.length === 1);
  const interpX = interp.interpolated[0].x;
  const lineX15 = invertModel("line", line.coefficients, 15);
  ok(interpX != null && lineX15 != null && Math.abs(interpX - lineX15) < 1e-4);
  const doseLog: TableData = {
    columns: ["Title", "X", "Response"],
    rows: [
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
  };
  const dose = await runAnalysis("nonlinear-regression", doseLog, { model: "sigmoidal-4pl-logx" });
  ok(!("error" in dose) && dose.coefficients);
  const doseX = invertModel("sigmoidal-4pl-logx", dose.coefficients, 50);
  ok(doseX != null && Math.abs(doseX - -0.8467) < 0.002);
  // Outside the asymptotes the curve never reaches the Y.
  strictEqual(invertModel("sigmoidal-4pl-logx", dose.coefficients, 150), null);
  strictEqual(invertModel("sigmoidal-4pl-logx", dose.coefficients, 0.5), null);
  // No closed form: the numeric-only models, and the method table agrees.
  strictEqual(invertMethod("quadratic"), "numeric");
  strictEqual(invertMethod("quartic"), "numeric");
  strictEqual(invertMethod("quintic"), "numeric");
  strictEqual(invertMethod("segmental-linear"), "numeric");
  strictEqual(invertMethod("sigmoidal-4pl-logx"), "closed-form");
  strictEqual(invertModel("quadratic", dose.coefficients, 50), null);
});

// R2-m10: band inversion on a non-monotonic standard curve can return an
// inverted 95% CI (low > high), which reads as a valid interval. An
// inverted-U quadratic (Y = −x² + 6x over X 0..7, noisy so the band has
// width) with an unknown Y = 5 on the rising limb inverts on unfixed code
// (low 1.096 > high 0.847): the fix drops the CI and says so in the notes,
// keeping the point estimate.
check("an inverted band-inversion CI is dropped, never shown as an interval", async () => {
  const xs = [0, 1, 2, 3, 4, 5, 6, 7];
  const noise = [0.3, -0.2, 0.4, -0.3, 0.2, -0.4, 0.3, -0.2];
  const quad: TableData = {
    columns: ["Title", "X", "Y1"],
    rows: [
      ...xs.map((x, i) => ["", String(x), String(-x * x + 6 * x + noise[i])]),
      ["", "", "5"],
    ],
  };
  const out = await runAnalysis("nonlinear-regression", quad, { y: "Y1", model: "quadratic", interpolate: true });
  ok(!("error" in out) && out.interpolated?.length === 1);
  const u = out.interpolated[0];
  ok(u.x != null && Math.abs(u.x - 0.973) < 0.01);
  strictEqual(u.low, null);
  strictEqual(u.high, null);
  ok(!("error" in out) && out.notes.includes("comes back inverted"));
});

// BUG-REPORT #9 (FL-R3-09): a smoothing spline on an XY table with tied X
// values failed outright — smooth.spline's fit$y lives on the UNIQUE sorted
// knots (length(unique(x))), so the old code returned 4 + 100 values for 5
// observations and R recycled fit$y across mismatched rows in the RSS.
// fitted(fit) is per-observation, so the fit now returns one fitted value
// per row and the RSS is sum((y - fitted(fit))^2). Reference values below
// are smooth.spline(x, y) on X = [1,1,2,3,4], Y = [2,2.5,4,6,8], computed
// straight from R (spar 1.4805142007968894, df 2.00000000833144).
check("a smoothing spline fits tied X values, one fitted value per observation (FL-R3-09)", async () => {
  const table: TableData = {
    columns: ["Title", "X", "Y1"],
    rows: [
      ["", "1", "2"],
      ["", "1", "2.5"],
      ["", "2", "4"],
      ["", "3", "6"],
      ["", "4", "8"],
    ],
  };
  const out = await runAnalysis("spline-lowess", table, { method: "spline" } as never);
  if ("error" in out) throw new Error(out.error);
  const expected = [2.2058824056037776, 2.2058824056037776, 4.117646984179642, 6.029411567068956, 7.941176153346085];
  strictEqual(out.fitted?.length, 5);
  strictEqual(out.curve?.length, 100);
  out.fitted!.forEach((p, i) => ok(Math.abs(p.y - expected[i]) < 1e-9, `fitted[${i}]`));
  // The tied X = 1 rows share one knot but are two observations: both get
  // the knot's fitted value, and the residuals use each row's own Y.
  strictEqual(out.fitted![0].y, out.fitted![1].y);
  const rss = out.stats.find((s) => s.label === "Residual sum of squares")?.value;
  ok(rss != null && Math.abs(rss - 0.14705882236979922) < 1e-9, `rss ${rss}`);
  // The reported RSS agrees with the fitted values it ships: recomputed
  // in TS from the residuals, so a recycled fit$y cannot hide in it.
  const recomputed = out.fitted!.reduce((sum, p) => sum + (p.observed! - p.y) ** 2, 0);
  ok(rss != null && Math.abs(recomputed - rss) < 1e-9, `recomputed rss ${recomputed}`);
  const spar = out.stats.find((s) => s.label === "Smoothing parameter (spar)")?.value;
  ok(spar != null && Math.abs(spar - 1.4805142007968894) < 1e-9, `spar ${spar}`);
  // Fewer than 4 DISTINCT X values is rejected cleanly before R runs,
  // instead of surfacing R's "need at least four unique 'x' values".
  const few: TableData = {
    columns: ["Title", "X", "Y1"],
    rows: [
      ["", "1", "2"],
      ["", "1", "2.5"],
      ["", "2", "4"],
      ["", "3", "6"],
      ["", "3", "7"],
    ],
  };
  deepStrictEqual(await runAnalysis("spline-lowess", few, { method: "spline" } as never), {
    error: "A smoothing spline needs at least 4 distinct X values.",
  });
});

// Remove baseline (v2): subtract a baseline — first value, mean of the first
// N, mean of control column(s), or a constant — from every value in the
// chosen columns, recording the baseline used per column; the source data
// is never touched.
check("remove baseline subtracts the first value and records the baseline used", async () => {
  const table: TableData = {
    columns: ["Title", "Time", "Y1", "Y2"],
    rows: [
      ["", "0", "10", "5"],
      ["", "1", "12", "7"],
      ["", "2", "14", "9"],
      ["", "3", "16", "11"],
    ],
  };
  const out = await runAnalysis("remove-baseline", table, {
    ys: ["Y1", "Y2"],
    x: "Time",
    baselineMethod: "first-value",
  });
  if ("error" in out) throw new Error(out.error);
  strictEqual(out.testType, "remove-baseline");
  deepStrictEqual(
    out.baselineRemoved?.map((c) => [c.column, c.baseline, c.method]),
    [
      ["Y1", 10, "First value"],
      ["Y2", 5, "First value"],
    ],
  );
  deepStrictEqual(
    out.baselineRemoved?.[0].rows.map((r) => [r.x, r.original, r.subtracted]),
    [
      [0, 10, 0],
      [1, 12, 2],
      [2, 14, 4],
      [3, 16, 6],
    ],
  );
  // The baseline is also in the stats, so it survives without the rows.
  deepStrictEqual(
    out.stats.map((s) => [s.label, s.value]),
    [
      ["Baseline for “Y1”", 10],
      ["Baseline for “Y2”", 5],
    ],
  );
  ok(out.notes.includes("first value"));
  // The descriptives are of the subtracted values, not the originals.
  deepStrictEqual(
    out.groups.map((g) => [g.name, g.mean, g.n]),
    [
      ["Y1", 3, 4],
      ["Y2", 3, 4],
    ],
  );
  // Mean of the first N, and a constant, use the same rows.
  const meanFirst = await runAnalysis("remove-baseline", table, {
    ys: ["Y1"],
    x: "Time",
    baselineMethod: "mean-first-n",
    firstN: 2,
  });
  if ("error" in meanFirst) throw new Error(meanFirst.error);
  strictEqual(meanFirst.baselineRemoved?.[0].baseline, 11);
  deepStrictEqual(
    meanFirst.baselineRemoved?.[0].rows.map((r) => r.subtracted),
    [-1, 1, 3, 5],
  );
  const constant = await runAnalysis("remove-baseline", table, {
    ys: ["Y1"],
    x: "Time",
    baselineMethod: "constant",
    constant: 10,
  });
  if ("error" in constant) throw new Error(constant.error);
  strictEqual(constant.baselineRemoved?.[0].baseline, 10);
  // Mean of the controls averages every value in the control column(s).
  const controls = await runAnalysis("remove-baseline", table, {
    ys: ["Y1"],
    x: "Time",
    baselineMethod: "mean-of-controls",
    controls: ["Y2"],
  });
  if ("error" in controls) throw new Error(controls.error);
  strictEqual(controls.baselineRemoved?.[0].baseline, 8);
  // Errors name the problem instead of subtracting something wrong.
  deepStrictEqual(
    await runAnalysis("remove-baseline", table, {
      ys: ["Y1"],
      x: "Time",
      baselineMethod: "mean-first-n",
      firstN: 9,
    }),
    { error: "“Y1” holds only 4 values, but the baseline is the mean of the first 9." },
  );
  deepStrictEqual(
    await runAnalysis("remove-baseline", table, {
      ys: ["Y1"],
      x: "Time",
      baselineMethod: "mean-of-controls",
      controls: ["Nope"],
    }),
    { error: "The column “Nope” is no longer in the table. Create this analysis again to choose another." },
  );
});

check("remove-baseline wizard asks for the baseline and finishes with its params", () => {
  const data: TableData = {
    columns: ["Title", "Time", "Y1", "Y2"],
    rows: [
      ["", "0", "10", "5"],
      ["", "1", "12", "7"],
    ],
  };
  const table = readTable(data);
  const wizard = WIZARDS["remove-baseline"]!;
  // The follow-up question depends on the method answered.
  deepStrictEqual(
    wizard.questions({ baselineMethod: "mean-first-n", ys: ["Y1"] }, table, "xy").filter(Boolean).map((q) => (q as Question).id),
    ["ys", "baselineMethod", "firstN"],
  );
  deepStrictEqual(
    wizard.questions({ baselineMethod: "mean-of-controls", ys: ["Y1"] }, table, "xy").filter(Boolean).map((q) => (q as Question).id),
    ["ys", "baselineMethod", "controls"],
  );
  deepStrictEqual(wizard.finish({ ys: ["Y1", "Y2"], baselineMethod: "first-value" }, table, "xy"), {
    type: "remove-baseline",
    params: { ys: ["Y1", "Y2"], x: "Time", baselineMethod: "first-value" },
  });
  deepStrictEqual(
    wizard.finish({ ys: ["Y1"], baselineMethod: "mean-of-controls", controls: ["Y2"] }, table, "xy"),
    {
      type: "remove-baseline",
      params: { ys: ["Y1"], x: "Time", baselineMethod: "mean-of-controls", controls: ["Y2"] },
    },
  );
  // A Column table has no X column to carry into the result rows.
  deepStrictEqual(wizard.finish({ ys: ["Y1"], baselineMethod: "constant", constant: 3 }, table, "column"), {
    type: "remove-baseline",
    params: { ys: ["Y1"], baselineMethod: "constant", constant: 3 },
  });
});

// R3-10: standard-curve interpolation on enzyme models. Their formulas
// are defined at X = 0, so they set neither positiveX nor nonNegativeX —
// and the interpolation grid extended a full width BELOW zero, into
// negative concentrations. On allosteric-sigmoidal that made x^h NaN for
// non-integer h, so `inc` was NA and R crashed on `if (inc)` for every
// unknown; on Michaelis-Menten the pole at X = −Km sat inside the grid and
// the band inversion converged onto −Km instead of a positive X.
check("enzyme standard curves interpolate unknowns to positive X with positive CIs", async () => {
  const noise = [0, 0.4, -0.3, 0.5, -0.4, 0.3, -0.5, 0.4, -0.3];
  const xs = [0, 1, 2, 3, 5, 7, 10, 15, 20];
  const mm = (x: number) => (100 * x) / (5 + x);
  const allo = (x: number) => (100 * x ** 1.5) / (5 ** 1.5 + x ** 1.5);
  const table = (f: (x: number) => number): TableData => ({
    columns: ["Title", "X", "Y1"],
    rows: [...xs.map((x, i) => ["", String(x), String(f(x) + noise[i])]), ["", "", "50"]],
  });
  // Allosteric-sigmoidal: Y = 50 sits at X = Khalf = 5.
  const a = await runAnalysis("nonlinear-regression", table(allo), { y: "Y1", model: "allosteric-sigmoidal", interpolate: true });
  ok(!("error" in a) && a.interpolated?.length === 1, `allosteric interpolation failed: ${"error" in a ? a.error : "no interpolated row"}`);
  const ua = a.interpolated[0];
  ok(ua.x != null && Math.abs(ua.x - 5) < 0.75, `allosteric X should be ~5, got ${ua.x}`);
  ok(ua.low != null && ua.high != null && ua.low > 0 && ua.low < ua.x && ua.x < ua.high, `allosteric CI should be positive and bracket X, got [${ua.low}, ${ua.high}]`);
  // Michaelis-Menten: Y = 50 sits at X = Km = 5; the pole at −Km must not
  // capture the CI.
  const m = await runAnalysis("nonlinear-regression", table(mm), { y: "Y1", model: "michaelis-menten", interpolate: true });
  ok(!("error" in m) && m.interpolated?.length === 1, `Michaelis-Menten interpolation failed: ${"error" in m ? m.error : "no interpolated row"}`);
  const um = m.interpolated[0];
  ok(um.x != null && Math.abs(um.x - 5) < 0.75, `Michaelis-Menten X should be ~5, got ${um.x}`);
  ok(um.low != null && um.high != null && um.low > 0 && um.low < um.x && um.x < um.high, `Michaelis-Menten CI should be positive and bracket X, got [${um.low}, ${um.high}]`);
});

check("data sets ticked again keep the table's order", () => {
  const options = ["A", "B", "C"];
  deepStrictEqual(toggled(options, ["A", "C"], "B", true), ["A", "B", "C"]);
  deepStrictEqual(toggled(options, ["A", "B", "C"], "A", false), ["B", "C"]);
});

check("a paste wider than a grouped table says how many columns didn't fit", () => {
  const grouped = newGroupedTable(2, 2); // Title + 4 sub-columns
  strictEqual(columnsBeyond(grouped, 3, [["1", "2", "3", "4"]]), 2);
  strictEqual(columnsBeyond(grouped, 1, [["1", "2"]]), 0);
  strictEqual(columnsBeyond({ columns: ["Title", "A"], rows: [] }, 1, [["1", "2", "3"]]), 0);
});

check("analyses follow renamed columns", () => {
  const regression = followTable(analysis, { renamed: { Y1: "Response" } }, []);
  deepStrictEqual(regression.analysisParams, { y: "Response", forceOrigin: true });
  const multiple = followTable(
    {
      ...analysis,
      analysisType: "multiple-regression",
      analysisParams: { dependent: "Y1", predictors: ["Age", "BMI"] },
    },
    { renamed: { BMI: "Body mass" } },
    [],
  );
  deepStrictEqual(multiple.analysisParams, { dependent: "Y1", predictors: ["Age", "Body mass"] });
  const chosen = followTable(
    { ...analysis, analysisType: "anova", analysisParams: { posthoc: "tukey", sets: ["Control", "A", "B"] } },
    { renamed: { A: "Treated" } },
    [],
  );
  deepStrictEqual(chosen.analysisParams, { posthoc: "tukey", sets: ["Control", "Treated", "B"] });
});

check("renaming a Y column follows y2, ys, globalY, truth, score and record keys, and subgroup point styles follow a subgroup rename", () => {
  const binding = followTable(
    { ...analysis, analysisType: "binding-saturation", analysisParams: { y: "Total", y2: "Nonspecific" } },
    { renamed: { Nonspecific: "NS" } },
    [],
  );
  deepStrictEqual(binding.analysisParams, { y: "Total", y2: "NS" });
  const special = followTable(
    {
      ...analysis,
      analysisType: "dose-response-special",
      analysisParams: { model: "schild", ys: ["Y1", "Y2"], antagonistConcentrations: { Y1: 10, Y2: 20 } },
    },
    { renamed: { Y2: "High" } },
    [],
  );
  deepStrictEqual(special.analysisParams, {
    model: "schild",
    ys: ["Y1", "High"],
    antagonistConcentrations: { Y1: 10, High: 20 },
  });
  const global = followTable(
    { ...analysis, analysisType: "nonlinear-regression", analysisParams: { model: "sigmoidal-4pl-logx", globalY: ["Y1", "Y2"] } },
    { renamed: { Y1: "Response" } },
    [],
  );
  deepStrictEqual(global.analysisParams, { model: "sigmoidal-4pl-logx", globalY: ["Response", "Y2"] });
  const roc = followTable(
    { ...analysis, analysisType: "roc-curve", analysisParams: { truth: "Disease", score: "Marker" } },
    { renamed: { Marker: "Score" } },
    [],
  );
  deepStrictEqual(roc.analysisParams, { truth: "Disease", score: "Score" });
  const enzyme = followTable(
    { ...analysis, analysisType: "enzyme-inhibition", analysisParams: { model: "competitive", inhibitorConcentrations: { Drug: 5 } } },
    { renamed: { Drug: "Inhibitor" } },
    [],
  );
  deepStrictEqual(enzyme.analysisParams, { model: "competitive", inhibitorConcentrations: { Inhibitor: 5 } });
  // A subgroup rename hands its renamed columns to followTable, so per-point
  // styles in that subgroup move with the column instead of being dropped.
  const before = nested();
  const after = renameSubgroup(before, "A", "S1", "Mouse 1");
  const renamed = Object.fromEntries(
    before.columns.map((n, i) => [n, after.columns[i]] as const).filter(([from, to]) => from !== to),
  );
  const styled = followTable(
    { ...graph, graphOptions: { ...graph.graphOptions!, points: { "A:S1:R1#0": { size: 3 } } } },
    { renamed },
    after.columns,
  ).graphOptions!.points;
  deepStrictEqual(styled, { "A:Mouse 1:R1#0": { size: 3 } });
});

check("graphs follow renamed columns, groups, compared pairs and colors", () => {
  const node: ProjectNode = {
    ...graph,
    graphOptions: {
      ...DEFAULT_GRAPH_OPTIONS,
      xVariable: "Y1",
      volcanoGroupA: "A",
      sigPairs: [pairKey("Y1", "Y2"), pairKey("Y2", "Y3")],
      title: "Y1",
      series: { Y1: { color: "#D55E00" }, Y2: { color: "#0072B2" } },
    },
  };
  const o = followTable(node, { renamed: { Y1: "Drug", A: "Control" } }, ["Title", "Drug", "Y2", "Y3"]).graphOptions!;
  strictEqual(o.xVariable, "Drug");
  strictEqual(o.volcanoGroupA, "Control");
  deepStrictEqual(o.sigPairs, [pairKey("Drug", "Y2"), pairKey("Y2", "Y3")]);
  deepStrictEqual(o.series, { Drug: { color: "#D55E00" }, Y2: { color: "#0072B2" } });
  strictEqual(o.title, "Y1"); // the user's text is left alone
});

check("styled points follow moved rows, renamed columns and groups, and leave with their column", () => {
  const styled = (
    points: Record<string, { size: number }>,
    columns: string[],
    move: Parameters<typeof followTable>[1],
  ) => followTable({ ...graph, graphOptions: { ...graph.graphOptions!, points } }, move, columns).graphOptions!.points;
  const points = { "Y1#0": { size: 1 }, "Y1#3": { size: 2 } };
  deepStrictEqual(styled(points, ["Title", "Y1"], { rows: rowsInserted(1, 2) }), {
    "Y1#0": { size: 1 },
    "Y1#5": { size: 2 },
  });
  deepStrictEqual(styled(points, ["Title", "Y1"], { rows: rowsDeleted(0, 1) }), { "Y1#2": { size: 2 } });
  deepStrictEqual(styled(points, ["Title", "Dose"], { renamed: { Y1: "Dose" } }), {
    "Dose#0": { size: 1 },
    "Dose#3": { size: 2 },
  });
  deepStrictEqual(styled({ "A:Y1#1": { size: 3 } }, ["Title", "Ctrl:Y1"], { renamed: { A: "Ctrl" } }), {
    "Ctrl:Y1#1": { size: 3 },
  });
  strictEqual(styled(points, ["Title", "Y2"], {}), undefined); // its column was deleted
});

check("deleting a column drops its points' styles, even with no move given", () => {
  let s = makeInitialState();
  const tableId = s.rootOrder[0];
  const data: TableData = { columns: ["Title", "A", "B"], rows: [[null, "1", "2"]] };
  s = reducer(s, { type: "updateTable", id: tableId, data, label: "Typing" });
  const g = {
    ...graph,
    id: "g9",
    parentId: tableId,
    graphOptions: { ...graph.graphOptions!, points: { "A#0": { size: 9 }, "B#0": { size: 9 } } },
  };
  s = reducer(s, { type: "create", node: g });
  s = reducer(s, {
    type: "updateTable",
    id: tableId,
    data: { columns: ["Title", "A"], rows: [[null, "1"]] },
    label: "Delete Column",
  });
  deepStrictEqual(s.nodes.g9.graphOptions!.points, { "A#0": { size: 9 } });
});

// ── Graphs ───────────────────────────────────────────────────────────────

check("palettes keep their authors' colors, in their order and number", () => {
  const counts = Object.fromEntries(PALETTES.map((p) => [p.name, p.colors.length]));
  // prettier-ignore
  deepStrictEqual(counts, {
    "okabe-ito": 8, "tol-bright": 7, "tol-muted": 9, "tableau-10": 10, grayscale: 5, titer: 6,
    viridis: 256, cividis: 256, magma: 256, batlow: 256,
    coolwarm: 256, fast: 256, vik: 256, vlag: 256, rdbu: 11,
  });
  ok(PALETTES.every((p) => p.colors.every((c) => /^#[0-9A-F]{6}$/.test(c))));
  deepStrictEqual(paletteNamed("okabe-ito")!.colors, [
    "#000000",
    "#E69F00",
    "#56B4E9",
    "#009E73",
    "#F0E442",
    "#0072B2",
    "#D55E00",
    "#CC79A7",
  ]);
});

check("bars and points have their own fill; new bars under points start half-opaque", () => {
  const fills = (options: GraphOptions) => {
    const [bar, , , points] = GRAPHS.individual.build(readTable(table.data!).numeric, options, paintOf(options, 2))
      .data as {
      marker: { color: string | string[] };
    }[];
    return [
      (bar.marker.color as string).match(/,([\d.]+)\)$/)![1],
      (points.marker.color as string[])[0].match(/,([\d.]+)\)$/)![1],
    ];
  };
  const fresh = { ...newGraphOptions("individual"), bars: true };
  deepStrictEqual(fills(fresh), ["0.5", "1"]);
  deepStrictEqual(fills({ ...fresh, fill: 0.2, pointFill: 0.7 }), ["0.2", "0.7"]);
  strictEqual(newGraphOptions("grouped-bars").fill, 1);
});

check("outlines take the color of what they outline, or the one chosen", () => {
  const data = {
    columns: ["Title", "A", "B"],
    rows: [
      [null, "1", "2"],
      [null, "3", "4"],
    ],
  };
  // Each column's bar, then its points: the traces with an outline.
  const outlines = (options: GraphOptions) =>
    (
      GRAPHS.individual.build(readTable(data).numeric, options, paintOf(options, 2)).data as {
        marker?: { line?: { color: unknown; width: unknown } };
      }[]
    ).flatMap((t) => (t.marker?.line ? [t.marker.line] : []));
  const fresh: GraphOptions = {
    ...newGraphOptions("individual"),
    bars: true,
    series: { A: { color: "#CC79A7" } }, // not Okabe-Ito's first color, black
    points: { "A#1": { outlineColor: SAME_AS_FILL }, "B#0": { outlineColor: "#808080" } },
  };
  const [barA, pointsA, barB, pointsB] = outlines(fresh);
  const color = paintOf(fresh, 2).color;
  deepStrictEqual(
    [barA, barB].map((l) => [l.color, l.width]),
    [
      [color("A", 0), 1.5],
      [color("B", 1), 1.5],
    ],
  );
  deepStrictEqual(
    [pointsA.color, pointsB.color],
    [
      [color("A", 0), color("A", 0)],
      ["#808080", color("B", 1)],
    ],
  );
  const black = outlines({ ...fresh, outline: 3, outlineColor: "#000000", pointOutlineColor: "#000000" });
  deepStrictEqual([black[0].color, black[0].width], ["#000000", 3]);
  deepStrictEqual(black[1].color, ["#000000", "#CC79A7"]); // a point's own choice wins
  strictEqual(newGraphOptions("pie").outlineColor, "#FFFFFF"); // slices apart in white
  // A color given to an outline of none (a volcano's) comes with a thickness, so it shows.
  deepStrictEqual(
    [visibleOutline(0, "#000000"), visibleOutline(0, SAME_AS_FILL), visibleOutline(2, "#000000")],
    [1.5, undefined, undefined],
  );
  // A row's bars stand apart on a new graph, so their outlines never overlap.
  const bars = GRAPHS["grouped-bars"].build(
    readTable(grouped()).columns,
    newGraphOptions("grouped-bars"),
    paintOf(fresh, 2),
  );
  strictEqual(bars.layout.bargroupgap, 0.1);
  const xyData = { columns: ["Title", "X", "Y1", "Y2"], rows: [[null, "1", "2", "3"]] };
  strictEqual(
    GRAPHS["xy-bar"].build(readTable(xyData).columns, newGraphOptions("xy-bar"), paintOf(fresh, 2)).layout.bargroupgap,
    0.1,
  );
  // A series' own marker (a mean drawn as a point) takes the points' outline color too.
  const means = { ...newGraphOptions("mean-error"), shape: "point" as const, pointOutlineColor: "#808080" };
  const meanTraces = GRAPHS["mean-error"].build(readTable(data).numeric, means, paintOf(means, 2)).data as {
    marker?: { line?: { color: string } };
  }[];
  ok(meanTraces.some((t) => t.marker?.line?.color === "#808080"));
  // Selected, a point shows its own color, not its half-opaque fill nor its outline.
  const half = { ...fresh, pointFill: 0.5, pointOutlineColor: "#000000" };
  strictEqual(
    drawnStyle(GRAPHS.individual.build(readTable(data).numeric, half, paintOf(half, 2)).data, "A#0")!.color,
    color("A", 0),
  );
});

// R2-G-F18: a very large XY scatter thins to the cap instead of freezing the
// render — timed renders on current code took 1.3s for 10k SVG points and
// 5.3s for 50k (14.2s / 50.4s on a loaded machine; the graph view redraws
// with no cancel), so the figure keeps at most XY_SCATTER_MAX_POINTS and
// says how it thinned.
check("a very large XY scatter thins to the cap and says so", () => {
  const options = newGraphOptions("xy-scatter");
  const rows = Array.from({ length: 10_000 }, (_, i) => [null, String(i), String(Math.sin(i / 100))]);
  const fig = GRAPHS["xy-scatter"].build(
    readTable({ columns: ["Title", "X", "Y"], rows }).columns,
    options,
    paintOf(options, 1),
  );
  const trace = fig.data[0] as { type: string; x: number[] };
  strictEqual(trace.type, "scatter");
  strictEqual(trace.x.length, XY_SCATTER_MAX_POINTS); // stride 2 over 10,000
  const notes = (fig.layout.annotations as { name?: string; text?: string }[] | undefined) ?? [];
  ok(
    notes.some(
      (a) => a.name === "note" && (a.text ?? "").includes("1 in 2 points") && (a.text ?? "").includes("5000 of 10000"),
    ),
  );
  // A small series is untouched: every point drawn, no thinning note.
  const small = GRAPHS["xy-scatter"].build(
    readTable({ columns: ["Title", "X", "Y"], rows: [[null, "1", "2"], [null, "2", "3"]] }).columns,
    options,
    paintOf(options, 1),
  );
  strictEqual((small.data[0] as { x: number[] }).x.length, 2);
  const smallNotes = (small.layout.annotations as { name?: string; text?: string }[] | undefined) ?? [];
  ok(!smallNotes.some((a) => a.name === "note"));
});

check("error bars, the center line drawn with them, and lines take their own style", () => {
  const data = {
    columns: ["Title", "A", "B"],
    rows: [
      [null, "1", "2"],
      [null, "3", "5"],
    ],
  };
  const options: GraphOptions = {
    ...newGraphOptions("individual"),
    series: { A: { color: "#CC79A7" } },
    errorWidth: 3,
    errorCaps: 0,
    errorDirection: "above",
  };
  type Trace = { mode?: string; line?: { color: string; width: number }; error_y?: Record<string, unknown> };
  const traces = GRAPHS.individual.build(readTable(data).numeric, options, paintOf(options, 2)).data as Trace[];
  const [center, whiskers] = traces.filter((t) => t.mode === "lines" || t.error_y);
  deepStrictEqual(center.line, { color: "#CC79A7", width: 3 });
  deepStrictEqual(whiskers.error_y, {
    type: "data",
    array: [1],
    symmetric: false,
    arrayminus: [0],
    color: "#CC79A7",
    thickness: 3,
    width: 0,
  });
  // A color chosen for them all, and every series line's thickness.
  const black = { ...options, errorColor: "#000000", lineWidth: 4 };
  const blackTraces = GRAPHS.individual.build(readTable(data).numeric, black, paintOf(black, 2)).data as Trace[];
  ok(
    blackTraces
      .filter((t) => t.mode === "lines" || t.error_y)
      .every((t) => (t.line?.color ?? t.error_y!.color) === "#000000"),
  );
  const groupedData = {
    columns: ["Title", "A:Y1", "B:Y1"],
    rows: [
      [null, "1", "2"],
      [null, "3", "4"],
    ],
  };
  const lines = GRAPHS["grouped-lines"].build(readTable(groupedData).columns, black, paintOf(black, 2)).data as Trace[];
  deepStrictEqual(
    lines.map((t) => t.line!.width),
    [4, 4],
  );
});

check("series take their own dashes and patterns, and a palette can be reversed", () => {
  type Trace = {
    line?: { dash: string };
    marker?: { color: string; pattern?: Record<string, unknown> };
    fillpattern?: { shape: string };
  };
  const grouped = {
    columns: ["Title", "A:Y1", "B:Y1"],
    rows: [
      [null, "1", "2"],
      [null, "3", "4"],
    ],
  };
  const options: GraphOptions = {
    ...newGraphOptions("grouped-lines"),
    lineDash: "dot",
    series: { B: { dash: "dash" }, A: { pattern: "diagonal" } },
  };
  const paint = paintOf(options, 2);
  const lines = GRAPHS["grouped-lines"].build(readTable(grouped).columns, options, paint).data as Trace[];
  deepStrictEqual(
    lines.map((t) => t.line!.dash),
    ["dot", "dash"],
  );
  const [a, b] = GRAPHS["grouped-bars"].build(readTable(grouped).columns, options, paint).data as Trace[];
  // Its lines in its color, over a light tint of it, so they show even on a solid fill.
  deepStrictEqual(a.marker!.pattern, {
    shape: "/",
    fgcolor: paint.color("A", 0),
    bgcolor: withOpacity(paint.color("A", 0), 0.4),
    fillmode: "replace",
    size: 8,
    solidity: 0.3,
  });
  ok(!("pattern" in b.marker!));
  const xy = {
    columns: ["Title", "X", "A"],
    rows: [
      [null, "1", "2"],
      [null, "2", "3"],
    ],
  };
  const [area] = GRAPHS["xy-area"].build(readTable(xy).columns, options, paint).data as Trace[];
  strictEqual(area.fillpattern!.shape, "/");
  const column = { columns: ["Title", "A", "B"], rows: [[null, "1", "2"]] };
  const [slices] = GRAPHS.pie.build(readTable(column).numeric, options, paint).data as {
    marker: { pattern: { shape: string[] } };
  }[];
  deepStrictEqual(slices.marker.pattern.shape, ["/", ""]);
  // A new or reversed palette drops only the colors picked by hand.
  deepStrictEqual(withoutColors({ A: { color: "#000000" }, B: { color: "#FFFFFF", dash: "dot" } }), {
    B: { dash: "dot" },
  });
  const okabe = paletteOf(options);
  const reversed = reversedPalette(okabe);
  deepStrictEqual([reversed.colors[0], reversed.reversed], [okabe.colors.at(-1), true]);
  deepStrictEqual(reversedPalette(reversed), okabe);
  const file = JSON.parse(serializeProjectFile(payload));
  file.project.nodes.g1.graphOptions.palette = reversed;
  deepStrictEqual(read(JSON.stringify(file)).project.nodes.g1.graphOptions!.palette, reversed);
});

check("a line or area graph draws its points in X order, not table row order", () => {
  type Trace = { x: number[]; y: number[] };
  // X out of order in the table: 3, 1, 2 — the drawn line must still run 1, 2, 3,
  // matching the shape of a fitted overlay plotted on a sorted grid.
  const xy = {
    columns: ["Title", "X", "Y"],
    rows: [
      [null, "3", "30"],
      [null, "1", "10"],
      [null, "2", "20"],
    ],
  };
  const columns = readTable(xy).columns;
  const scatterOptions: GraphOptions = { ...newGraphOptions("xy-scatter"), xyStyle: "points+line" };
  const [line] = GRAPHS["xy-scatter"].build(columns, scatterOptions, paintOf(scatterOptions, 1)).data as Trace[];
  deepStrictEqual(line.x, [1, 2, 3]);
  deepStrictEqual(line.y, [10, 20, 30]);
  const areaOptions = newGraphOptions("xy-area");
  const [area] = GRAPHS["xy-area"].build(columns, areaOptions, paintOf(areaOptions, 1)).data as Trace[];
  deepStrictEqual(area.x, [1, 2, 3]);
  deepStrictEqual(area.y, [10, 20, 30]);
});

check("a markers-only xy-scatter keeps table row order, not X order (R2-G-F9)", () => {
  type Trace = { x: number[]; y: number[]; customdata?: string[] };
  // Same unsorted table as the line check above: 3, 1, 2. With no connecting
  // line there is nothing to straighten, so the points stay in table row
  // order — the Height vs Weight reference golden is recorded that way — and
  // each point keeps its own row's key.
  const xy = {
    columns: ["Title", "X", "Y"],
    rows: [
      [null, "3", "30"],
      [null, "1", "10"],
      [null, "2", "20"],
    ],
  };
  const columns = readTable(xy).columns;
  const options: GraphOptions = { ...newGraphOptions("xy-scatter"), xyStyle: "points" };
  const [markers] = GRAPHS["xy-scatter"].build(columns, options, paintOf(options, 1)).data as Trace[];
  deepStrictEqual(markers.x, [3, 1, 2]);
  deepStrictEqual(markers.y, [30, 10, 20]);
  deepStrictEqual(markers.customdata, ["Y#0", "Y#1", "Y#2"]);
  // And the line mode still sorts, so the two modes genuinely differ.
  const lineOptions: GraphOptions = { ...newGraphOptions("xy-scatter"), xyStyle: "points+line" };
  const [line] = GRAPHS["xy-scatter"].build(columns, lineOptions, paintOf(lineOptions, 1)).data as Trace[];
  deepStrictEqual(line.x, [1, 2, 3]);
  deepStrictEqual(line.y, [10, 20, 30]);
});

check("a linked weighted linear regression draws its weighted fit, band and equation (R3-08)", async () => {
  // BUG-REPORT #8: the overlay ignored params.weights and always drew the
  // unweighted OLS line. Heteroscedastic data where the two fits disagree
  // sharply: the (10, 25)/(10, 15) points dominate OLS but carry almost no
  // weight under 1/Y² (OLS slope 2.167, weighted slope 1.536).
  const table: TableData = {
    columns: ["Title", "X", "Y"],
    rows: [
      [null, "1", "1.1"],
      [null, "2", "1.9"],
      [null, "10", "25"],
      [null, "10", "15"],
    ],
  };
  const x = [1, 2, 10, 10];
  const y = [1.1, 1.9, 25, 15];
  const stat = (r: Awaited<ReturnType<typeof runAnalysis>>, label: string) => {
    if ("error" in r) throw new Error(`weighted regression: ${r.error}`);
    return r.stats.find((s) => s.label === label)?.value;
  };
  // Every weighting scheme the analysis offers, plus a forced-origin
  // weighted fit, must match R's lm() on slope, intercept, R² and P.
  for (const weights of ["1/y", "1/y2", "1/x", "1/x2"] as const) {
    const r = await runAnalysis("linear-regression", table, { y: "Y", forceOrigin: false, weights });
    const js = fitLinear(x, y, false, weights);
    ok(js != null, `fitLinear with ${weights} must fit`);
    for (const [label, value] of [
      ["Slope", js.slope],
      ["Y-intercept", js.intercept],
      ["R squared", js.r2],
      ["P value (slope ≠ 0)", js.p],
    ] as const) {
      const rValue = stat(r, label);
      ok(rValue != null && Math.abs(rValue - value) < 1e-9, `${weights} ${label}: graph ${value}, R ${rValue}`);
    }
  }
  const rOrigin = await runAnalysis("linear-regression", table, { y: "Y", forceOrigin: true, weights: "1/y2" });
  const jsOrigin = fitLinear(x, y, true, "1/y2");
  ok(jsOrigin != null, "weighted through-origin fit must fit");
  const rOriginSlope = stat(rOrigin, "Slope");
  ok(
    rOriginSlope != null && Math.abs(rOriginSlope - jsOrigin.slope) < 1e-9,
    `1/y2 through origin slope: graph ${jsOrigin.slope}, R ${rOriginSlope}`,
  );
  // Weights that cannot apply draw nothing instead of a wrong line.
  strictEqual(fitLinear([1, 2, 3], [1, 0, 2], false, "1/y"), null);
  strictEqual(fitLinear([1, 2, 3], [0, 2, 3], false, "1/y2"), null);
  strictEqual(fitLinear([0, 1, 2], [1, 2, 3], false, "1/x"), null);
  // The full overlay path: the drawn line, band and equation are the
  // weighted fit's, not the OLS one's.
  const options: GraphOptions = {
    ...newGraphOptions("xy-scatter"),
    regShowLine: true,
    regShowBand: true,
    regShowEquation: true,
  };
  const cols = plotColumns(readTable(table), "xy-scatter", options, "xy");
  const fig = GRAPHS["xy-scatter"].build(cols, options, paintOf(options, 1));
  addRegression(fig, cols, options, { y: "Y", forceOrigin: false, weights: "1/y2" }, paintOf(options, 1));
  type Trace = { x: number[]; y: number[]; mode?: string; line?: { dash?: string } };
  const traces = fig.data as Trace[];
  const lineTrace = traces.find((t) => t.mode === "lines" && t.line?.dash === "dash");
  ok(lineTrace, "the overlay must draw a dashed line");
  const lineSlope =
    (lineTrace!.y[lineTrace!.y.length - 1] - lineTrace!.y[0]) /
    (lineTrace!.x[lineTrace!.x.length - 1] - lineTrace!.x[0]);
  const rW = await runAnalysis("linear-regression", table, { y: "Y", forceOrigin: false, weights: "1/y2" });
  const wSlope = stat(rW, "Slope");
  ok(wSlope != null && Math.abs(lineSlope - wSlope) < 1e-9, `overlay line slope ${lineSlope}, R weighted ${wSlope}`);
  const notes = ((fig.layout.annotations as { text?: string }[] | undefined) ?? []).map((n) => n.text ?? "");
  ok(
    notes.some((t) => t === "Y = 1.536*X − 0.6054<br>R² = 0.8487, P = 0.07873"),
    `equation note must be the weighted fit's, got ${JSON.stringify(notes)}`,
  );
  // The band is R's predict(interval="confidence") for the weighted fit.
  const pred = await evalNamedVector(
    `x<-c(1,2,10,10);y<-c(1.1,1.9,25,15);w<-1/y^2;m<-lm(y~x,weights=w);` +
      `p<-predict(m,newdata=data.frame(x=c(1,10)),interval="confidence");` +
      `c(lo1=p[1,2],hi1=p[1,3],lo10=p[2,2],hi10=p[2,3])`,
  );
  const [lo, hi] = traces;
  ok(lo && hi, "the overlay must draw a band");
  for (const [got, want, where] of [
    [lo.y[0], pred.lo1, "band low at x=1"],
    [hi.y[0], pred.hi1, "band high at x=1"],
    [lo.y[lo.y.length - 1], pred.lo10, "band low at x=10"],
    [hi.y[hi.y.length - 1], pred.hi10, "band high at x=10"],
  ] as const) {
    ok(want != null && Math.abs(got - want) < 1e-9, `${where}: graph ${got}, R ${want}`);
  }
});

check("the pie drops a negative slice and names it, instead of showing inflated percentages (R2-G-F12)", () => {
  const options = newGraphOptions("pie");
  const notesOf = (fig: GraphFigure) =>
    ((fig.layout.annotations as { text?: string }[] | undefined) ?? []).map((n) => n.text ?? "");
  // Plotly 4.1.2 silently drops the -10 slice and recomputes the rest
  // over the remaining total: A 75% + C 50% = 125%, no error (runtime
  // check). The guard drops it first and says so on the figure.
  const mixed = { columns: ["Title", "A", "B", "C"], rows: [[null, "30", "-10", "20"]] };
  const fig = GRAPHS.pie.build(readTable(mixed).numeric, options, paintOf(options, 3));
  const [trace] = fig.data as { labels?: string[]; values?: number[] }[];
  deepStrictEqual(trace.labels, ["A", "C"]);
  deepStrictEqual(trace.values, [30, 20]);
  ok(
    notesOf(fig).some((t) => t.includes("“B”") && t.includes("-10") && t.includes("cannot be negative")),
    `the dropped slice must be named with its value, got ${JSON.stringify(notesOf(fig))}`,
  );
  // A zero slice is fine as-is: 0%, and the rest still sum to 100%.
  const withZero = { columns: ["Title", "A", "B", "C"], rows: [[null, "10", "0", "5"]] };
  const zeroFig = GRAPHS.pie.build(readTable(withZero).numeric, options, paintOf(options, 3));
  const [zeroTrace] = zeroFig.data as { labels?: string[]; values?: number[] }[];
  deepStrictEqual(zeroTrace.labels, ["A", "B", "C"]);
  deepStrictEqual(zeroTrace.values, [10, 0, 5]);
  strictEqual(notesOf(zeroFig).length, 0);
  // Nothing drawable (all zero, or all negative): no trace, but the
  // figure still explains why instead of drawing a silent empty pie.
  const allZero = GRAPHS.pie.build(
    readTable({ columns: ["Title", "A", "B"], rows: [[null, "0", "0"]] }).numeric,
    options,
    paintOf(options, 2),
  );
  strictEqual(allZero.data.length, 0);
  ok(
    notesOf(allZero).some((t) => t.includes("No positive slices")),
    `the all-zero pie must explain itself, got ${JSON.stringify(notesOf(allZero))}`,
  );
  const allNeg = GRAPHS.pie.build(
    readTable({ columns: ["Title", "A", "B"], rows: [[null, "-5", "-10"]] }).numeric,
    options,
    paintOf(options, 2),
  );
  strictEqual(allNeg.data.length, 0);
  ok(
    notesOf(allNeg).some((t) => t.includes("“A”") && t.includes("“B”") && t.includes("cannot be negative")),
    `the all-negative pie must name both slices, got ${JSON.stringify(notesOf(allNeg))}`,
  );
  // The donut shares the guard (same builder).
  const donutFig = GRAPHS.donut.build(readTable(mixed).numeric, options, paintOf(options, 3));
  const [donutTrace] = donutFig.data as { labels?: string[]; values?: number[] }[];
  deepStrictEqual(donutTrace.labels, ["A", "C"]);
});

check("Match Another Graph… takes only what is ticked, series in order", () => {
  const graph = (type: GraphType, table: string, series: string[], over: Partial<GraphOptions>): Matched => ({
    type,
    table,
    series,
    options: { ...newGraphOptions(type), ...over },
  });
  const example = graph("mean-error", "t1", ["Vehicle", "Low", "High"], {
    pointSize: 12,
    yMax: 100,
    title: "Example",
    series: { Vehicle: { color: "#000000", shape: "diamond" }, High: { color: "#FF0000" } },
    points: { "Vehicle#0": { size: 15 } },
  });
  const target = graph("box-violin", "t2", ["A", "B"], { series: { A: { color: "#00FF00", dash: "dot" } } });
  const options = matched(target, example, ["points", "colors", "styled"]);
  strictEqual(options.pointSize, 12);
  deepStrictEqual(options.palette, example.options.palette);
  // By order: A takes Vehicle's color, B none (Low has none); A keeps its own dash.
  deepStrictEqual(options.series, { A: { color: "#000000", dash: "dot" } });
  // Unticked or out of reach: ranges, titles, and points styled in another table.
  deepStrictEqual([options.yMax, options.title, options.points], [undefined, "", undefined]);
  ok(matched({ ...target, table: "t1" }, example, ["styled"]).points);
  // A heatmap keeps its gradient when the example's palette is categorical.
  const heat = graph("heatmap", "t2", [], {});
  deepStrictEqual(matched(heat, example, ["colors"]).palette, heat.options.palette);
  // The examples: the other graphs Helix can draw, not one from a newer Helix.
  const child = (id: string): OutlineNode => ({ id, type: "graph", name: id, parentId: "t" });
  const tables = [
    { id: "t", type: "table" as const, name: "T", parentId: null, children: ["g1", "g2", "g3"].map(child) },
  ];
  const nodes = {
    g1: { ...child("g1"), graphType: "box-violin" },
    g2: { ...child("g2"), graphType: "mean-error" },
    g3: { ...child("g3"), graphType: "sankey" as GraphType }, // from a newer Helix
  } as Record<string, ProjectNode>;
  deepStrictEqual(examplesFor("g1", tables, nodes), [{ table: "T", graphs: [child("g2")] }]);
});

check("a column graph's bars stand at their column, even with one-way error bars", () => {
  const table = {
    columns: ["Title", "A", "B", "C"],
    rows: [
      [null, "1", "2", "3"],
      [null, "2", "3", "4"],
    ],
  };
  for (const errorDirection of ["above", "both"] as const) {
    const options: GraphOptions = { ...newGraphOptions("mean-error"), errorDirection };
    const { data } = GRAPHS["mean-error"].build(readTable(table).numeric, options, paintOf(options, 3));
    // One offset group for every bar (and its caps' twin): Plotly sets none aside.
    deepStrictEqual(
      new Set(withCaps(data, options).map((t) => (t as { offsetgroup?: string }).offsetgroup)),
      new Set(["column"]),
    );
  }
});

check("error bars that go one way have no foot: their caps are at their tips alone", () => {
  type Trace = {
    type: string;
    y: number[];
    offsetgroup?: string;
    mode?: string;
    error_y?: { array: number[]; width: number };
  };
  const grouped = { columns: ["Title", "A:Y1", "A:Y2", "B:Y1", "B:Y2"], rows: [[null, "1", "3", "2", "6"]] };
  const above: GraphOptions = { ...newGraphOptions("grouped-bars"), errorDirection: "above", errorCaps: 8 };
  const built = GRAPHS["grouped-bars"].build(readTable(grouped).columns, above, paintOf(above, 2)).data;
  const [barA, capA, barB] = withCaps(built, above) as Trace[];
  strictEqual(barA.error_y!.width, 0); // the stem alone
  deepStrictEqual(
    [capA.type, capA.offsetgroup, barA.offsetgroup, capA.y, capA.error_y!.array, capA.error_y!.width],
    ["bar", "0", "0", [3], [0], 8],
  );
  strictEqual(barB.offsetgroup, "1");
  // Points' error bars get a twin of points; error bars both ways keep their caps.
  const points = { ...newGraphOptions("grouped-lines"), errorDirection: "above" as const };
  const [, twin] = withCaps(
    GRAPHS["grouped-lines"].build(readTable(grouped).columns, points, paintOf(points, 2)).data,
    points,
  ) as Trace[];
  strictEqual(twin.mode, "markers");
  const both = newGraphOptions("grouped-bars");
  const plain = GRAPHS["grouped-bars"].build(readTable(grouped).columns, both, paintOf(both, 2)).data;
  deepStrictEqual(withCaps(plain, both), plain);
  strictEqual((plain[0] as Trace).error_y!.width, 6);
});

check("a series' shape wins over the graph's, on every point it draws", () => {
  const options: GraphOptions = {
    ...newGraphOptions("individual"),
    pointShape: "diamond",
    series: { B: { shape: "square" } },
  };
  const paint = paintOf(options, 2);
  const data = {
    columns: ["Title", "A", "B"],
    rows: [
      [null, "1", "2"],
      [null, "3", "4"],
    ],
  };
  const traces = GRAPHS.individual.build(readTable(data).numeric, options, paint).data as {
    marker?: { symbol?: string[] };
  }[];
  deepStrictEqual(traces.map((t) => t.marker?.symbol?.[0]).filter(Boolean), ["diamond", "square"]);
});

check("a box's points are drawn over it, each with its own color", () => {
  const options: GraphOptions = { ...newGraphOptions("box-violin"), showPoints: true };
  const data = {
    columns: ["Title", "A"],
    rows: [
      [null, "1"],
      [null, "3"],
    ],
  };
  options.points = { "A#0": { color: NAMED_COLORS.green } };
  const [box, points] = GRAPHS["box-violin"].build(readTable(data).numeric, options, paintOf(options, 1)).data as {
    type: string;
    boxpoints?: boolean;
    marker?: { line: { color: string[] } };
  }[];
  deepStrictEqual([box.type, box.boxpoints, points.type], ["box", false, "scatter"]);
  strictEqual(points.marker!.line.color[0], NAMED_COLORS.green);
});

check("a point's own color, size, shape, fill and outline reach its marker", () => {
  const options: GraphOptions = {
    ...newGraphOptions("individual"),
    pointFill: 0.5,
    points: { "A#1": { color: "#000000", size: 12, shape: "triangle-up", fill: 0.3, outline: 3 } },
  };
  const data = {
    columns: ["Title", "A"],
    rows: [
      [null, "1"],
      [null, "3"],
    ],
  };
  const traces = GRAPHS.individual.build(readTable(data).numeric, options, paintOf(options, 1)).data;
  const m = (
    traces as {
      marker?: { color: string[]; size: number[]; symbol: string[]; line: { color: string[]; width: number[] } };
    }[]
  ).find((t) => Array.isArray(t.marker?.size))!.marker!;
  deepStrictEqual(
    [m.size, m.symbol, m.line.width, m.line.color[1]],
    [[7, 12], ["circle", "triangle-up"], [1.5, 3], "#000000"],
  );
  deepStrictEqual(
    [m.color[1], drawnStyle(traces, "A#0")!.fill, drawnStyle(traces, "A#1")!.fill],
    ["rgba(0,0,0,0.3)", 0.5, 0.3],
  );
  // In the file, a fill is brought within 0 to 1.
  const file = JSON.parse(serializeProjectFile(payload));
  file.project.nodes.g1.graphOptions.points = { "Y1#0": { fill: 0 }, "Y1#1": { fill: 1.5 } };
  deepStrictEqual(read(JSON.stringify(file)).project.nodes.g1.graphOptions!.points, {
    "Y1#0": { fill: 0 },
    "Y1#1": { fill: 1 },
  });
});

check("a Mean & error line takes the graph's dashes", () => {
  const options: GraphOptions = { ...newGraphOptions("mean-error"), shape: "line", lineDash: "dot" };
  const data = {
    columns: ["Title", "A", "B"],
    rows: [
      [null, "1", "2"],
      [null, "3", "4"],
    ],
  };
  const [line] = GRAPHS["mean-error"].build(readTable(data).numeric, options, paintOf(options, 2)).data as {
    line: { dash: string };
  }[];
  strictEqual(line.line.dash, "dot");
});

check("a survival curve runs on to the last subject followed", () => {
  const options = newGraphOptions("survival");
  // Deaths at 1 and 2, then one subject censored at 5.
  const data = {
    columns: ["Title", "X", "A"],
    rows: [
      [null, "1", "1"],
      [null, "2", "1"],
      [null, "5", "0"],
    ],
  };
  const [curve] = GRAPHS.survival.build(readTable(data).columns, options, paintOf(options, 1)).data as {
    x: number[];
    y: number[];
  }[];
  // The last step, at the level of the last death.
  deepStrictEqual([curve.x.slice(-2), curve.y.at(-1)], [[2, 5], curve.y.at(-2)]);
});

check("a survival counts curve never plots above 100% from a zero initial count", () => {
  // R2-G-F11: the old `|| 1` fallback divided by 1 when the initial count
  // was 0, so counts [0, 5] plotted as [0%, 500%] presented as fact.
  const options: GraphOptions = { ...newGraphOptions("survival"), survivalMode: "counts" };
  const data = {
    columns: ["Title", "X", "A", "B", "C"],
    rows: [
      [null, "0", "0", "10", "10"],
      [null, "1", "5", "12", "8"],
    ],
  };
  const fig = GRAPHS.survival.build(readTable(data).columns, options, paintOf(options, 3));
  const traces = fig.data as { name?: string; y: number[] }[];
  // A has no starting population: no curve, named on the figure instead.
  deepStrictEqual(
    traces.map((t) => t.name),
    ["B", "C"],
  );
  // B's later count exceeds its initial count: clamped to 100%, not 120%.
  deepStrictEqual(
    traces.map((t) => t.y),
    [
      [100, 100],
      [100, 80],
    ],
  );
  ok(traces.every((t) => t.y.every((v) => v >= 0 && v <= 100)), "every plotted percent is within 0–100%");
  const notes = (fig.layout.annotations as { text?: string }[] | undefined) ?? [];
  ok(notes.some((n) => n.text?.includes("“A” omitted")), "names the omitted zero-initial group");
  ok(notes.some((n) => n.text?.includes("“B” clamped to 0–100%")), "names the clamped group");
});

check("a survival group with zero complete pairs draws no point", () => {
  const options = newGraphOptions("survival");
  // Group B has times but no event codes at all — zero complete pairs.
  const data = {
    columns: ["Title", "X", "A", "B"],
    rows: [
      [null, "1", "1", null],
      [null, "2", "1", null],
      [null, "5", "0", null],
    ],
  };
  const fig = GRAPHS.survival.build(readTable(data).columns, options, paintOf(options, 2));
  const traces = fig.data as { legendgroup?: string; name?: string }[];
  // Group A still draws its curve; group B draws nothing — before the fix
  // kaplanMeier([], []) returned its (0, 100%) anchor, a phantom point.
  ok(traces.length > 0, "the group with data still draws");
  ok(traces.some((t) => t.name === "A"), "the group with data keeps its curve");
  ok(traces.every((t) => t.legendgroup !== "B"), "no trace for the group with no data");
});

check("texts moved by hand stay where they were dropped", () => {
  // What Plotly reports of a move: the legend, a color legend, a named text; a
  // significance label has no name, so it isn't one.
  deepStrictEqual(movedText({ "legend.x": 0.8, "legend.y": 0.1 }, []), { name: "legend", at: { x: 0.8, y: 0.1 } });
  deepStrictEqual(movedText({ "colorbar.x": 0.7, "colorbar.y": 0.3 }, []), { name: "legend", at: { x: 0.7, y: 0.3 } });
  deepStrictEqual(movedText({ "annotations[1].ax": 40, "annotations[1].ay": -20 }, ["note", "A#1"]), {
    name: "A#1",
    at: { x: 40, y: -20 },
  });
  strictEqual(movedText({ "annotations[0].ax": 5, "annotations[0].ay": 5 }, [undefined]), null);
  // Drawn there: the legend, a heatmap's color legend, the note, a point's or a gene's name.
  const xy = { columns: ["Title", "X", "Y1", "Y2"], rows: [[null, "1", "2", "3"]] };
  const moved: GraphOptions = { ...newGraphOptions("xy-scatter"), legend: { x: 0.5, y: 0.2 }, note: { x: 30, y: 40 } };
  deepStrictEqual(GRAPHS["xy-scatter"].build(readTable(xy).columns, moved, paintOf(moved, 2)).layout.legend, {
    x: 0.5,
    y: 0.2,
    xanchor: "left",
  });
  const heat = GRAPHS.heatmap.build(readTable(xy).numeric, moved, paintOf(moved, 0)).data[0] as { colorbar?: object };
  deepStrictEqual(heat.colorbar, { x: 0.5, y: 0.2 });
  const fig: GraphFigure = { data: [], layout: {} };
  addNote(fig, "Y = X", moved);
  const [note] = fig.layout.annotations as { name: string; ax: number; ay: number }[];
  deepStrictEqual([note.name, note.ax, note.ay], ["note", 30, 40]);
  const labelled: GraphOptions = {
    ...newGraphOptions("individual"),
    points: { "A#0": { label: true, labelOffset: { x: -25, y: 15 } }, "A#1": { label: true } },
  };
  const data = {
    columns: ["Title", "A"],
    rows: [
      ["Mouse 1", "1"],
      [null, "3"],
    ],
  };
  const names = pointLabels(
    GRAPHS.individual.build(readTable(data).numeric, labelled, paintOf(labelled, 1)).data,
    labelled.points,
    ["Mouse 1"],
    13,
  );
  deepStrictEqual(
    names.map((n) => [n.name, n.ax, n.ay]),
    [
      ["A#0", -25, 15],
      ["A#1", names[1].ax, 0],
    ],
  );
  ok(names[1].ax > 0); // right of its point
  const gene = { ...volcanoOptions, volcanoLabelCount: 5, points: { "#2": { labelOffset: { x: -30, y: 10 } } } };
  const geneNames = GRAPHS.volcano.build(readTable(genes).columns, gene, paintOf(gene, 2)).layout.annotations as {
    name: string;
    ax: number;
    ay: number;
  }[];
  deepStrictEqual(
    geneNames.map((n) => [n.name, n.ax, n.ay]),
    [["#2", -30, 10]],
  );
  // Read back from a file; a place that isn't two numbers is left out.
  const file = JSON.parse(serializeProjectFile(payload));
  Object.assign(file.project.nodes.g1.graphOptions, { legend: { x: 0.9, y: 0.4 }, note: { x: "far" } });
  file.project.nodes.g1.graphOptions.points = { "Y1#0": { labelOffset: { x: 12, y: -8 } } };
  const o = read(JSON.stringify(file)).project.nodes.g1.graphOptions!;
  deepStrictEqual(
    [o.legend, o.note, o.points],
    [{ x: 0.9, y: 0.4 }, undefined, { "Y1#0": { labelOffset: { x: 12, y: -8 } } }],
  );
});

check("a legend shown outside the plot reserves its own right margin (M13)", () => {
  const options = { ...newGraphOptions("xy-scatter") };
  const names = ["Control", "Treated with a very long drug name"];
  // A two-series XY graph reserves room for the legend past the right edge.
  const two = xyLayout(options, "X", 2, { seriesNames: names });
  const right = (two.margin as { r: number }).r;
  ok(right > 16);
  strictEqual(right, legendRightMargin(options, names));
  // The room covers the legend itself: its offset past the plot plus its width.
  ok(right >= 12 + legendWidthPx(names, options.fontSize));
  // One series shows no legend and keeps the tight margin.
  strictEqual((xyLayout(options, "X", 1).margin as { r: number }).r, 16);
  // A legend the user dragged inside the plot needs no room.
  const inside = xyLayout({ ...options, legend: { x: 0.5, y: 0.2 } }, "X", 2, { seriesNames: ["A", "B"] });
  strictEqual((inside.margin as { r: number }).r, 16);
  // Grouped bar + scatter with two groups reserve room for the group names.
  ok((groupedBarLayout(options, 2, { seriesNames: ["Drug", "Placebo"] }).margin as { r: number }).r > 16);
  ok((groupedScatterLayout(options, ["R1", "R2"], 2, undefined, ["Drug", "Placebo"]).margin as { r: number }).r > 16);
  // A heatmap with its scale shown reserves the colorbar's room (30 px bar +
  // numeric ticks + offset); without the scale it keeps the tight margin.
  const heat = heatmapLayout({ ...options, heatmapShowScale: true }, ["A", "B"], ["R1"]);
  ok((heat.margin as { r: number }).r >= 78);
  strictEqual((heatmapLayout({ ...options, heatmapShowScale: false }, ["A", "B"], ["R1"]).margin as { r: number }).r, 16);
});

// ── Selected points ──────────────────────────────────────────────────────

check("the selection ring circles exactly the selected points, and is never exported", () => {
  const options = newGraphOptions("individual");
  const data = {
    columns: ["Title", "A"],
    rows: [
      [null, "1"],
      [null, "3"],
      [null, "5"],
    ],
  };
  const fig = GRAPHS.individual.build(readTable(data).numeric, options, paintOf(options, 1)).data;
  strictEqual(selectionRing(fig, new Set(), "#FF0000"), null);
  const ring = selectionRing(fig, new Set(["A#2", "B#0"]), "#FF0000")!; // B#0 isn't drawn
  const points = fig.find((t) => (t as { customdata?: unknown }).customdata) as { x: number[]; y: number[] };
  deepStrictEqual([ring.x, ring.y], [[points.x[2]], [5]]);
  deepStrictEqual(withoutSelection([...fig, ring]), fig);
  deepStrictEqual([...drawnKeys(fig)], ["A#0", "A#1", "A#2"]);
});

check("a drag picks the points it covers, alone or added to the selection", () => {
  const reported = [{ customdata: "A#1" }, { customdata: undefined }, { customdata: "B#0" }]; // a bar has no key
  deepStrictEqual(keysOf(reported), ["A#1", "B#0"]);
  deepStrictEqual([...picked(new Set(["A#0"]), ["A#1"], false)], ["A#1"]);
  deepStrictEqual([...picked(new Set(["A#0", "A#1"]), ["A#1", "B#0"], true)], ["A#0", "A#1", "B#0"]);
});

check("styling selected points touches only them; Reset and unset fields leave no trace", () => {
  const points = { "A#0": { size: 9 }, "A#1": { color: "#000000" } };
  deepStrictEqual(stylePoints(points, ["A#1", "A#2"], { label: true }), {
    "A#0": { size: 9 },
    "A#1": { color: "#000000", label: true },
    "A#2": { label: true },
  });
  deepStrictEqual(stylePoints(points, ["A#1"], null), { "A#0": { size: 9 } });
  deepStrictEqual(stylePoints({ "A#0": { label: true } }, ["A#0"], { label: undefined }), undefined);
});

check("Bigger and Smaller change each point from its own size, within the sizes allowed", () => {
  const points = { "A#1": { size: 11, color: "#000000" }, "A#2": { size: 20 } };
  const options: GraphOptions = { ...newGraphOptions("individual"), points };
  const data = {
    columns: ["Title", "A"],
    rows: [
      [null, "1"],
      [null, "3"],
      [null, "5"],
    ],
  };
  const fig = GRAPHS.individual.build(readTable(data).numeric, options, paintOf(options, 1)).data;
  deepStrictEqual(resizePoints(points, fig, ["A#0", "A#1", "A#2", "B#0"], 1), {
    "A#0": { size: 8 },
    "A#1": { size: 12, color: "#000000" },
    "A#2": { size: 20 },
  });
  deepStrictEqual(resizePoints(undefined, fig, ["A#0"], -6), { "A#0": { size: 2 } });
});

check("a point shows its row's title as its name, else its row number", () => {
  const options: GraphOptions = {
    ...newGraphOptions("individual"),
    points: { "A#0": { label: true }, "A#1": { label: true } },
  };
  const data = {
    columns: ["Title", "A"],
    rows: [
      ["Mouse 1", "1"],
      [null, "3"],
    ],
  };
  const fig = GRAPHS.individual.build(readTable(data).numeric, options, paintOf(options, 1)).data;
  deepStrictEqual(
    pointLabels(fig, options.points, ["Mouse 1", null], 13).map((l) => l.text),
    ["Mouse 1", "Row 2"],
  );
  const file = JSON.parse(serializeProjectFile(payload));
  file.project.nodes.g1.graphOptions.points = { "Y1#0": { label: true }, "Y1#1": { label: "yes" } };
  deepStrictEqual(read(JSON.stringify(file)).project.nodes.g1.graphOptions!.points, { "Y1#0": { label: true } });
  // Outline colors: a hex, or a point's "fill"; anything else is left out.
  Object.assign(file.project.nodes.g1.graphOptions, {
    outlineColor: "black",
    pointOutlineColor: "#00FF00",
    errorColor: "red",
  });
  file.project.nodes.g1.graphOptions.points = { "Y1#0": { outlineColor: "FILL" }, "Y1#1": { outlineColor: "red" } };
  const o = read(JSON.stringify(file)).project.nodes.g1.graphOptions!;
  deepStrictEqual(
    [o.outlineColor, o.pointOutlineColor, o.errorColor, o.points],
    [undefined, "#00FF00", undefined, { "Y1#0": { outlineColor: SAME_AS_FILL } }],
  );
});

// ── Volcano ──────────────────────────────────────────────────────────────

check("a volcano gene is its row: its own style wins over up / down, and it can show its name", () => {
  const options: GraphOptions = {
    ...volcanoOptions,
    volcanoLabelCount: 0,
    points: { "#1": { color: "#000000", shape: "diamond", label: true } },
  };
  const fig = GRAPHS.volcano.build(readTable(genes).columns, options, paintOf(options, 2));
  // The styled gene is drawn over the others.
  const traces = fig.data as { customdata: string[]; marker: { color: string[] } }[];
  deepStrictEqual(
    traces.map((t) => t.customdata),
    [["#2"], ["#1"]],
  );
  strictEqual(traces[1].marker.color[0], "rgba(0,0,0,0.75)"); // filled as the graph's points are
  deepStrictEqual(drawnStyle(fig.data, "#1"), { color: "#000000", size: 5, shape: "diamond", fill: 0.75, outline: 0 });
  deepStrictEqual(
    (fig.layout.annotations as { text: string }[]).map((a) => a.text),
    ["B2"],
  );
});

check("genes are found by their whole name, in any case, several at once", () => {
  const columns = readTable(genes).columns;
  deepStrictEqual(genesNamed(columns, volcanoOptions, " C3, b2 ,Nope"), { keys: ["#2", "#1"], missing: ["Nope"] });
  deepStrictEqual(genesNamed(columns, volcanoOptions, "b"), { keys: [], missing: ["b"] });
});

// M12: a p / FDR of exactly 0 (R underflow for a very small p, or 0 from BH
// adjustment) is the most significant gene there is — it plots at the capped
// -log10, with its label, instead of being dropped. A negative p is still
// skipped, and a subnormal-but-nonzero p caps at the same height.
check("a volcano plots a p / FDR of exactly 0 at the capped -log10, and still skips a negative one", () => {
  const columns = readTable({
    columns: ["Title", "Gene", "LFC", "P"],
    rows: [
      [null, "ZERO", "2", "0"],
      [null, "TINY", "-2", "1e-320"],
      [null, "NEG", "3", "-0.01"],
      [null, "OK", "-1", "0.001"],
    ],
  }).columns;
  const fig = GRAPHS.volcano.build(columns, volcanoOptions, paintOf(volcanoOptions, 2));
  const traces = fig.data as { customdata: string[]; x: number[]; y: number[] }[];
  const drawn = new Map(traces.flatMap((t) => t.customdata.map((key, i) => [key, { x: t.x[i], y: t.y[i] }] as const)));
  deepStrictEqual([...drawn.keys()].sort(), ["#0", "#1", "#3"]); // NEG (#2) is not drawn
  strictEqual(drawn.get("#0")!.y, VOLCANO_MAX_LOG10);
  strictEqual(drawn.get("#1")!.y, VOLCANO_MAX_LOG10);
  ok(Math.abs(drawn.get("#3")!.y - 3) < 1e-9);
  // The zero-p gene is the most significant, so it is labelled first.
  deepStrictEqual(
    (fig.layout.annotations as { text: string }[]).map((a) => a.text),
    ["ZERO", "TINY", "OK"],
  );
});

check("a grouped volcano's genes keep their table rows, and follow them", () => {
  const data = {
    columns: ["Title", "A:Y1", "A:Y2", "B:Y1", "B:Y2"],
    rows: [
      ["g1", "1", "", "2", "3"],
      ["g2", "1", "2", "3", "4"],
      ["g3", "2", "3", "5", "6"],
    ],
  };
  deepStrictEqual(
    computeGroupedDEG(data, "A", "B", "log2ratio").map((d) => [d.row, d.label]),
    [
      [1, "g2"],
      [2, "g3"],
    ],
  );
  const v = { ...graph, graphOptions: { ...graph.graphOptions!, points: { "#2": { size: 9 } } } };
  deepStrictEqual(followTable(v, { rows: rowsInserted(0, 1) }, data.columns).graphOptions!.points, {
    "#3": { size: 9 },
  });
});

check("a huge volcano names its genes, and thousands of genes resize at once", () => {
  const volcanoOf = (n: number) => {
    const columns = readTable({
      columns: ["Title", "Gene", "LFC", "P"],
      rows: Array.from({ length: n }, (_, r) => [
        null,
        r < 3 ? `G${r}` : null,
        String((r % 200) / 50 - 2),
        String(((r % 997) + 1) / 1000),
      ]),
    }).columns;
    const options: GraphOptions = { ...volcanoOptions, volcanoLabelCount: 3 };
    return GRAPHS.volcano.build(columns, options, paintOf(options, 2));
  };
  strictEqual((volcanoOf(1_000_000).layout.annotations as unknown[]).length, 3);
  // 20,000 genes, all selected: milliseconds, never seconds, whatever the machine.
  const fig = volcanoOf(20_000);
  const keys = Array.from({ length: 20_000 }, (_, r) => `#${r}`);
  const start = performance.now();
  const sized = resizePoints(undefined, fig.data, keys, 1)!;
  ok(performance.now() - start < 1000, "resizing took over a second");
  strictEqual(Object.keys(sized).length, 20_000);
});

check("an exported volcano draws its genes as shapes, sharp at any resolution", () => {
  const columns = readTable({
    columns: ["Title", "Gene", "LFC", "P"],
    rows: [
      [null, "A", "2", "0.001"],
      [null, "B", "-1", "0.5"],
    ],
  }).columns;
  const options: GraphOptions = { ...volcanoOptions, points: { "#0": { size: 12 } } };
  const drawn = GRAPHS.volcano.build(columns, options, paintOf(options, 2)).data as { type: string; marker: unknown }[];
  deepStrictEqual(
    drawn.map((t) => t.type),
    ["scattergl", "scattergl"],
  ); // on screen: WebGL, fast
  const exported = vectorTraces(drawn) as typeof drawn;
  deepStrictEqual(
    exported.map((t) => t.type),
    ["scatter", "scatter"],
  );
  deepStrictEqual(
    exported.map((t) => t.marker),
    drawn.map((t) => t.marker),
  );
});

// ── Export ───────────────────────────────────────────────────────────────

check("an exported image stays within what a Mac can draw", () => {
  const biggest = { width: GRAPH_LIMITS.width.max, height: GRAPH_LIMITS.height.max };
  deepStrictEqual(largestAt(biggest, 150), biggest);
  deepStrictEqual(largestAt(biggest, 300), biggest);
  const at600 = largestAt(biggest, 600);
  ok(at600.width < 1250 && Math.abs(at600.width / at600.height - 4 / 3) < 0.01, `${at600.width} × ${at600.height}`);
  ok(at600.width * at600.height * (600 / 96) ** 2 <= 7500 * 5625);
  // A size that fits is taken as it is, even one not rounded (a graph resized by hand).
  const odd = { width: 341.79, height: 460 };
  deepStrictEqual(largestAt(odd, 600), odd);
});

// ── Multi-panel figures ──────────────────────────────────────────────────

const figurePayload = (): ProjectFilePayload => {
  // Its own table (the shared `table` fixture excludes its only Y value, so
  // its series list is empty — a shared legend needs real series).
  const ft: ProjectNode = {
    id: "ft",
    type: "table",
    name: "Figure data",
    parentId: null,
    tableType: "column",
    data: {
      columns: ["Title", "Control", "Treated"],
      rows: [
        [null, "10", "14"],
        [null, "12", "16"],
        [null, "11", "15"],
      ],
    },
  };
  const g1: ProjectNode = {
    id: "g1",
    type: "graph",
    name: "Plot",
    parentId: "ft",
    graphType: "mean-error",
    graphOptions: {
      ...newGraphOptions("mean-error"),
      series: { Control: { color: "#0072B2" }, Treated: { color: "#D55E00" } },
    },
  };
  const g2: ProjectNode = {
    id: "g2",
    type: "graph",
    name: "Bars",
    parentId: "ft",
    graphType: "individual",
    graphOptions: {
      ...newGraphOptions("individual"),
      series: { Control: { color: "#0072B2" }, Treated: { color: "#D55E00" } },
    },
  };
  return {
    nodes: {
      ft,
      g1,
      g2,
      f1: {
        id: "f1",
        type: "figure",
        name: "Figure 1",
        parentId: null,
        panels: [
          { graphId: "g1", graphName: "Plot", label: "A", title: "", row: 0, col: 0, rowSpan: 1, colSpan: 1 },
          { graphId: "g2", graphName: "Bars", label: "B", title: "", row: 0, col: 1, rowSpan: 1, colSpan: 1 },
        ],
        grid: { rows: 1, cols: 2 },
        figureSize: { widthIn: 10, heightIn: 7.5 },
        labelStyle: { position: "top-left", fontSizePt: 12, bold: true },
        figureTitle: "",
        sharedLegend: "none",
        dpi: "600",
      },
    },
    rootOrder: ["ft", "f1"],
    childOrder: { ft: ["g1", "g2"], f1: [] },
    activeNodeId: "f1",
  };
};

check("a figure round-trips through .hlx exactly (F-01)", () => {
  const before = figurePayload();
  const { project, issues } = read(serializeProjectFile(before));
  deepStrictEqual(issues, []);
  deepStrictEqual(project.nodes.f1, before.nodes.f1);
  deepStrictEqual(project.rootOrder, ["ft", "f1"]);
  // And re-saving the read-back project writes the same figure again.
  strictEqual(read(serializeProjectFile(project)).updated, false);
});

check("a figure's export size and panel alignment are arithmetic (F-02, F-04)", () => {
  deepStrictEqual(figurePixelSize({ widthIn: 10, heightIn: 7.5 }, 600), { width: 6000, height: 4500 });
  const { panels, grid, figureSize } = figurePayload().nodes.f1;
  const rects = panelRects(panels!, grid!, figureSize!, 300);
  strictEqual(rects.length, 2);
  deepStrictEqual([rects[0].x, rects[0].width], [0, 1500]);
  deepStrictEqual([rects[1].x, rects[1].width], [1500, 1500]);
});

// F-#7: a 600 DPI panel must render at its rectangle, not scaled twice.
// r3-15.hlx is 10×7.5 in on a 1×2 grid, so each panel's rectangle at 600 DPI
// is 3000×4500. Plotly's toImage multiplies the size it is handed by
// dpi/96, so the size handed to Plotly must be the rectangle in 96-DPI
// layout units — handing it the rectangle scales twice (18750×28125 at 600
// DPI, past what WebKit draws), and createImageBitmap then fails to decode
// the panel image. The 300 DPI control works because its double-scaled
// image (4687×7031) still fits.
check("a 600 DPI figure panel renders at its rectangle, not scaled twice (F-#7)", () => {
  for (const dpi of [150, 300, 600]) {
    const { panels, grid, figureSize } = figurePayload().nodes.f1;
    const rects = panelRects(panels!, grid!, figureSize!, dpi);
    for (const rect of rects) {
      const plot = panelPlotSize({ width: rect.width, height: rect.height }, dpi);
      // The image Plotly's toImage returns: the handed size times dpi/96.
      const image = {
        width: Math.round((plot.width * dpi) / PX_PER_INCH),
        height: Math.round((plot.height * dpi) / PX_PER_INCH),
      };
      deepStrictEqual(image, { width: rect.width, height: rect.height }, `panel image at ${dpi} DPI`);
    }
  }
  // The r3-15 geometry, spelled out: 3000×4500 at 600 DPI draws from a
  // 480×720 layout, never a 18750×28125 canvas.
  deepStrictEqual(panelPlotSize({ width: 3000, height: 4500 }, 600), { width: 480, height: 720 });
});

check("a figure's SVG export is one vector parent with labelled panels (F-03, F-05)", () => {
  const { panels, grid, figureSize, labelStyle, figureTitle, sharedLegend } = figurePayload().nodes.f1;
  const panel = () =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><rect width="300" height="200"/></svg>`;
  const { svg, missing } = composeFigureSvg(
    panels!.map((p) => ({ panel: p, svg: panel() })),
    { panels: panels!, grid: grid!, figureSize: figureSize!, labelStyle: labelStyle!, figureTitle: figureTitle!, sharedLegend: sharedLegend! },
  );
  strictEqual(missing, 0);
  ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="540"'));
  ok(svg.includes("<text") && svg.includes(">A</text>") && svg.includes(">B</text>"), svg);
  strictEqual((svg.match(/<svg x="/g) ?? []).length, 2);
});

check("a figure holds references, not copies, of its graphs (F-07)", () => {
  const before = figurePayload();
  const { project } = read(serializeProjectFile(before));
  const figure = project.nodes.f1;
  ok(!("graphOptions" in figure), "a figure node carries no graph options");
  // Editing the graph's title changes the graph, never the figure node.
  const edited = { ...before, nodes: { ...before.nodes, g1: { ...before.nodes.g1, name: "Renamed Plot" } } };
  const { project: after } = read(serializeProjectFile(edited));
  deepStrictEqual(after.nodes.f1, before.nodes.f1);
  strictEqual(after.nodes.g1.name, "Renamed Plot");
});

check("a deleted graph leaves a placeholder panel, and the figure still opens (F-08)", () => {
  const before = figurePayload();
  delete before.nodes.g2;
  const { project, issues } = read(serializeProjectFile(before));
  ok(project.nodes.f1, "the figure opens");
  deepStrictEqual(missingPanels(project.nodes.f1.panels!, project.nodes).map((p) => p.graphId), ["g2"]);
  ok(issues.some((i) => i.message.includes("Figure “Figure 1”")), JSON.stringify(issues));
});

check("an older Helix drops the figure node but keeps the data (F-09)", () => {
  const before = figurePayload();
  // A node type this version doesn't know, as an older Helix sees "figure".
  const old = JSON.parse(serializeProjectFile(before)) as { project: ProjectFilePayload };
  old.project.nodes.f1.type = "layout" as never;
  const { project, issues } = read(JSON.stringify(old));
  ok(!project.nodes.f1, "the unknown node is left out");
  ok(project.nodes.ft && project.nodes.g1, "tables and graphs still open");
  ok(issues.some((i) => i.message.includes("unreadable item")), JSON.stringify(issues));
});

check("a shared legend needs identical series in identical colours (F-10, F-11)", () => {
  const before = figurePayload();
  const okResult = sharedLegendCheck(before.nodes.f1.panels!, before.nodes);
  ok(okResult.ok, JSON.stringify(okResult));
  strictEqual(okResult.entries?.length, 2);
  // Same series name, a different colour: refused, with the reason shown.
  const recoloured: ProjectFilePayload = {
    ...before,
    nodes: {
      ...before.nodes,
      g2: {
        ...before.nodes.g2,
        graphOptions: { ...before.nodes.g2.graphOptions!, series: { Control: { color: "#0072B2" }, Treated: { color: "#009E73" } } },
      },
    },
  };
  const refused = sharedLegendCheck(recoloured.nodes.f1.panels!, recoloured.nodes);
  ok(!refused.ok && refused.reason?.includes("different colours"), JSON.stringify(refused));
});

// BUG-REPORT #15: a figure with a shared legend promised "per-panel legends
// are hidden", but every panel kept drawing its own alongside the shared one
// below the grid — `buildPanelFigure` never touched `showlegend`, and neither
// the preview nor the exporter overrode it. Before the fix both panels below
// came back `showlegend: true` with a valid shared legend. The fixture's own
// graphs (mean-error, individual) never draw a legend, so the check uses XY
// scatters with two Y series, which do (`showlegend: seriesCount > 1`).
check("a shared legend hides each panel's own legend (BUG-REPORT #15)", () => {
  const ft: ProjectNode = {
    id: "ft",
    type: "table",
    name: "Figure data",
    parentId: null,
    tableType: "xy",
    data: {
      columns: ["Title", "X", "Y1", "Y2"],
      rows: [
        [null, "1", "10", "14"],
        [null, "2", "12", "16"],
        [null, "3", "11", "15"],
      ],
    },
  };
  const scatter = (id: string, name: string): ProjectNode => ({
    id,
    type: "graph",
    name,
    parentId: "ft",
    graphType: "xy-scatter",
    graphOptions: {
      ...newGraphOptions("xy-scatter"),
      series: { Y1: { color: "#0072B2" }, Y2: { color: "#D55E00" } },
    },
  });
  const nodes: Record<string, ProjectNode> = { ft, g1: scatter("g1", "Scatter 1"), g2: scatter("g2", "Scatter 2") };
  const panels = [
    { graphId: "g1", graphName: "Scatter 1", label: "A", title: "", row: 0, col: 0, rowSpan: 1, colSpan: 1 },
    { graphId: "g2", graphName: "Scatter 2", label: "B", title: "", row: 0, col: 1, rowSpan: 1, colSpan: 1 },
  ];
  ok(sharedLegendCheck(panels, nodes).ok, "the shared legend must be valid for this check to mean anything");
  for (const panel of panels) {
    const graph = nodes[panel.graphId];
    // The legend exists to hide: without the flag the panel still draws it.
    strictEqual(buildPanelFigure(graph, nodes)?.layout.showlegend, true, `${panel.graphId} draws a legend on its own`);
    strictEqual(buildPanelFigure(graph, nodes, { hideLegend: false })?.layout.showlegend, true);
    // With the flag — the shared-legend case — the panel draws none, and
    // nothing else about the figure changes.
    const hidden = buildPanelFigure(graph, nodes, { hideLegend: true });
    strictEqual(hidden?.layout.showlegend, false, `${panel.graphId} must hide its legend under a shared legend`);
    strictEqual(hidden?.data.length, buildPanelFigure(graph, nodes)?.data.length);
  }
  // The wiring: the preview hides a panel's legend exactly when the figure
  // has a shared legend and it is valid; the exporter does the same on both
  // its raster and SVG paths (each already computes `legend.ok` that way).
  const view = readFileSync("src/views/figures/figure-view.tsx", "utf8");
  ok(view.includes('hideLegend={sharedLegend === "shared" && legend.ok}'), "the preview must pass hideLegend");
  const exporter = readFileSync("src/views/figures/figure-export.ts", "utf8");
  ok(exporter.includes("}, format, dpi, legend.ok)"), "the raster export must pass legend.ok");
  ok(exporter.includes('}, "svg", dpi, legend.ok)'), "the SVG export must pass legend.ok");
});

check("an oversize figure offers the largest fitting size, never silently (F-12)", () => {
  const out = figureExportSize({ widthIn: 20, heightIn: 15 }, 600);
  ok(out.capped && out.reason !== undefined, JSON.stringify(out));
  ok(out.width * out.height <= 7500 * 5625, `${out.width} × ${out.height}`);
  ok(!figureExportSize({ widthIn: 10, heightIn: 7.5 }, 600).capped);
});

check("figure labels run A…Z then AA, AB…; manual labels stick; duplicates are found", () => {
  strictEqual(figureLabel(0), "A");
  strictEqual(figureLabel(25), "Z");
  strictEqual(figureLabel(26), "AA");
  strictEqual(figureLabel(27), "AB");
  const { panels } = newFigurePanels(["g1", "g2", "g3", "g4", "g5"]);
  deepStrictEqual(panels.map((p) => p.label), ["A", "B", "C", "D", "E"]);
  // Five panels wrap after four columns: 2 rows × 4 columns.
  deepStrictEqual([panels[4].row, panels[4].col], [1, 0]);
  const manual = assignLabels([
    { graphId: "g1", label: "X", labelManual: true, title: "", row: 0, col: 1, rowSpan: 1, colSpan: 1 },
    { graphId: "g2", label: "", title: "", row: 0, col: 0, rowSpan: 1, colSpan: 1 },
  ]);
  deepStrictEqual(manual.map((p) => p.label), ["A", "X"]);
  deepStrictEqual(duplicateLabels(manual), []);
  deepStrictEqual(
    duplicateLabels([
      { graphId: "g1", label: "A", title: "", row: 0, col: 0, rowSpan: 1, colSpan: 1 },
      { graphId: "g2", label: "A", title: "", row: 0, col: 1, rowSpan: 1, colSpan: 1 },
    ]),
    ["A"],
  );
  // A panel out of range is clamped into the grid.
  deepStrictEqual(clampPanel({ graphId: "g1", label: "A", title: "", row: 9, col: 9, rowSpan: 3, colSpan: 3 }, { rows: 1, cols: 2 }), {
    graphId: "g1",
    label: "A",
    title: "",
    row: 0,
    col: 1,
    rowSpan: 1,
    colSpan: 1,
  });
});

check("a figure's size is validated in inches, within 1–20 and 4:1", () => {
  ok(validateFigureSize({ widthIn: 10, heightIn: 7.5 }).size !== undefined);
  ok(validateFigureSize({ widthIn: 25, heightIn: 7.5 }).reason !== undefined);
  ok(validateFigureSize({ widthIn: 10, heightIn: 40 }).reason !== undefined);
  ok(validateFigureSize({ widthIn: 20, heightIn: 1 }).reason !== undefined);
});

check("figures are created, edited and undone through the store", () => {
  let s = makeInitialState();
  const tableId = s.rootOrder[0];
  s = reducer(s, { type: "create", node: { id: "g9", type: "graph", name: "Plot", parentId: tableId, graphType: "xy-scatter", graphOptions: undefined } });
  s = reducer(s, {
    type: "create",
    node: {
      id: "f9",
      type: "figure",
      name: "Figure",
      parentId: null,
      panels: [{ graphId: "g9", label: "A", title: "", row: 0, col: 0, rowSpan: 1, colSpan: 1 }],
      grid: { rows: 1, cols: 1 },
      figureSize: { widthIn: 10, heightIn: 7.5 },
      labelStyle: { position: "top-left", fontSizePt: 12, bold: true },
      figureTitle: "",
      sharedLegend: "none",
      dpi: "600",
    },
  });
  strictEqual(s.nodes.f9.type, "figure");
  ok(s.rootOrder.includes("f9") && s.rootOrder.at(-1) === "f9");
  s = reducer(s, { type: "updateFigure", id: "f9", patch: { figureTitle: "Dose response" }, at: Date.now() });
  strictEqual(s.nodes.f9.figureTitle, "Dose response");
  s = reducer(s, { type: "undo" });
  strictEqual(s.nodes.f9.figureTitle, "");
});

check("the sample project ships a 2-panel figure", () => {
  const figure = sampleProject.nodes["f-main"];
  strictEqual(figure?.type, "figure");
  deepStrictEqual(
    figure.panels!.map((p) => p.graphId),
    ["g-viab", "g-volume-bars"],
  );
  // The sample file on disk round-trips with its figure intact.
  const { project } = read(readFileSync("samples/Titer Sample.hlx", "utf8"));
  deepStrictEqual(project.nodes["f-main"].panels, figure.panels);
});

check("an exported image says its resolution, and none of the headers that say 72 DPI", async () => {
  const chunk = (name: string, data: number[]) => [
    0,
    0,
    0,
    data.length,
    ...[...name].map((c) => c.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0,
  ];
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const png = [
    ...signature,
    ...chunk("IHDR", Array(13).fill(1)),
    ...chunk("eXIf", [7]),
    ...chunk("pHYs", Array(9).fill(2)),
    ...chunk("IDAT", [3]),
    ...chunk("IEND", []),
  ];
  const out = new Uint8Array(await withDpi(new Uint8Array(png), "png", 300).arrayBuffer());
  const names: string[] = [];
  for (let at = 8; at < out.length; at += 12 + out[at + 3])
    names.push(String.fromCharCode(...out.subarray(at + 4, at + 8)));
  deepStrictEqual(names, ["IHDR", "pHYs", "IDAT", "IEND"]);
  const phys = new DataView(out.buffer, 33);
  deepStrictEqual(
    [phys.getUint32(8), phys.getUint32(12), out[49], phys.getUint32(17)],
    [11811, 11811, 1, crc32(out.subarray(37, 50))],
  );
  // A JPEG: its JFIF header at 300 DPI, first; Exif and Photoshop's left out, a color profile kept.
  const segment = (marker: number, name: string) => [0xff, marker, 0, 6, ...[...name].map((c) => c.charCodeAt(0))];
  const jpeg = [
    0xff,
    0xd8,
    ...segment(0xe0, "JFIF"),
    ...segment(0xe1, "Exif"),
    ...segment(0xe2, "ICC_"),
    ...segment(0xed, "Phot"),
    0xff,
    0xdb,
    9,
  ];
  const jpg = [...new Uint8Array(await withDpi(new Uint8Array(jpeg), "jpeg", 300).arrayBuffer())];
  deepStrictEqual(jpg, [
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    16,
    ...segment(0, "JFIF").slice(4),
    0,
    1,
    1,
    1,
    1,
    44,
    1,
    44,
    0,
    0,
    ...segment(0xe2, "ICC_"),
    0xff,
    0xdb,
    9,
  ]);
});

// ── Analyses ─────────────────────────────────────────────────────────────

// P-value adjustments (plan 25): Šídák and Holm–Šídák are pure TypeScript
// arithmetic on raw P values — the plan's hand-computed values, pinned here
// so a regression in the formula shows up without running R.
check("Šídák adjusts 1 − (1 − p)^m, and is the identity for one comparison", () => {
  const got = adjustPValues([0.808, 0.0253, 0.0482], "sidak");
  for (const [i, want] of [0.9929, 0.0741, 0.1378].entries())
    ok(Math.abs(got[i]! - want) < 0.001, `Šídák #${i}: ${got[i]}, want ${want}`);
  // With one comparison the adjustment is the identity (up to float noise).
  for (const method of ["sidak", "holm-sidak"] as const) {
    const one = adjustPValues([0.04], method);
    ok(one.length === 1 && Math.abs(one[0]! - 0.04) < 1e-12, `${method} m=1: ${one[0]}`);
  }
});

check("Holm–Šídák steps down over the sorted P values, keeping the running max", () => {
  // Sorted raw 0.0253, 0.0482, 0.8080 → 0.0741, max(0.0741, 0.0941), 0.8080 —
  // and the input order (unsorted) is preserved in the output.
  deepStrictEqual(
    adjustPValues([0.808, 0.0253, 0.0482], "holm-sidak").map((p) => Number(p!.toFixed(4))),
    [0.808, 0.074, 0.0941],
  );
  // A small P later in the order can't lower an earlier adjusted value.
  deepStrictEqual(
    adjustPValues([0.9, 0.01, 0.5], "holm-sidak").map((p) => Number(p!.toFixed(4))),
    [0.9, 0.0297, 0.75],
  );
});

check("P-value adjustments pass nulls through", () => {
  deepStrictEqual(adjustPValues([null, 0.9], "sidak"), [null, 0.99]);
  deepStrictEqual(adjustPValues([1, null], "holm-sidak"), [1, null]);
  deepStrictEqual(
    adjustComparisonRows(
      [
        { group1: "A", group2: "B", diff: 1, p: 0.0253 },
        { group1: "A", group2: "C", diff: 2, p: 0.0482 },
      ],
      "sidak",
    ).map((r) => Number(r.p!.toFixed(4))),
    [0.05, 0.0941],
  );
});

check("an analysis runs on the data sets chosen, in their order", async () => {
  const column = readTable(treatments(["Control", "Drug A", "Drug B"]));
  deepStrictEqual(
    setColumns(column, ["Drug B", "Control"]).map((c) => c.name),
    ["Drug B", "Control"],
  );
  const grouped = readTable(newGroupedTable(3, 2));
  deepStrictEqual(
    setColumns(grouped, ["C", "A"]).map((c) => c.name),
    ["C:Y1", "C:Y2", "A:Y1", "A:Y2"],
  );
  const params = {
    paired: false,
    gaussian: true,
    equalVariance: true,
    ratio: false,
    tails: "two-sided",
    sets: ["Control", "Drug C"],
  };
  deepStrictEqual(
    await runAnalysis("compare-two-groups", treatments(["Control", "Drug A"]), params as AnalysisParams),
    {
      error: missingColumn("Drug C"),
    },
  );
});

check("a result's heading says whether the test itself is significant", () => {
  const row = (label: string, value: number) => ({ label, value, p: true });
  strictEqual(headline([row("P value", 0.01), row("F test P value", 0.4)]), 0.01);
  strictEqual(headline([row("P value (Fisher's exact test)", 0.2)]), 0.2);
  strictEqual(headline([row("Control — P value", 0.03)]), 0.03);
  strictEqual(headline([row("Control — P value", 0.01), row("Drug — P value", 0.3)]), null);
  strictEqual(headline([row("Group P value", 0.01), row("Row P value", 0.3)]), null);
});

check("a long equation does not push the stats values out of the stats table (F-01)", () => {
  // The Operational model's 183-char equation used to be a row of the
  // two-column stats table, whose nowrap cells stretched the table to
  // ~1,700px and pushed the right-aligned values off-screen. The equation
  // is now its own wrapping block above the table, so the table holds only
  // the stats. Pinned values from tests/reference.json (Operational model —
  // Partial agonist); num() renders Sy.x as "1.44e-7" and SS as "2.49e-13".
  const result: AnalysisResult = {
    testType: "dose-response-special",
    subtitle: "Operational model — Partial agonist",
    equation:
      "Full agonist: Y = 3.447e-7 + (100 − 3.447e-7)/(1 + 10^((-7 − X)·1)); partial agonists: Y = 3.447e-7 + (100 − 3.447e-7)/(1 + operate), operate = ((10^logKA + 10^X)/(10^(logtau + X)))^1",
    stats: [
      { label: "R squared (Full agonist)", value: 1 },
      { label: "R squared (Partial agonist)", value: 1 },
      { label: "R squared", value: 1 },
      { label: "Sy.x", value: 1.440383352e-7 },
      { label: "Sum of squares", value: 2.489645039e-13 },
      { label: "Degrees of freedom", value: 12 },
      { label: "N", value: 18 },
    ],
    groups: [],
    notes: "",
  };
  const html = renderToStaticMarkup(createElement(AnalysisResultsView, { result }));
  for (const text of ["1.44e-7", "2.49e-13", ">12<", ">18<"]) ok(html.includes(text), `missing ${text}`);
  strictEqual((html.match(/>1</g) ?? []).length, 3, "three R squared values of 1");
  // The stats table holds exactly the 7 stats rows — no equation row — and
  // the equation renders outside it, in its own wrapping block.
  const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
  strictEqual((table.match(/<tr/g) ?? []).length, 7);
  ok(!table.includes("Full agonist: Y"), "equation is a row of the stats table");
  ok(/<p[^>]*>.*Equation:/s.test(html), "equation is not its own block");
});

check("a graph's stars compare the two groups its t test chose, with the test's own P value", () => {
  const outcome = {
    testType: "compare-two-groups",
    stats: [
      { label: "F test P value", value: 0.4, p: true },
      { label: "P value", value: 0.01, p: true },
    ],
    groups: [{ name: "Control" }, { name: "Drug B" }],
  } as unknown as AnalysisOutcome;
  deepStrictEqual(
    deriveComparisons(outcome).map((c) => [c.group1, c.group2, c.p]),
    [["Control", "Drug B", 0.01]],
  );
});

check("a matched test counts as left out only the rows holding some of its values", () => {
  const data = {
    columns: ["Title", "A", "B", "C"],
    rows: [
      [null, "1", "2", "3"],
      [null, "4", null, "6"],
      [null, "7", "8", "9"],
      [null, null, null, null],
      [null, null, null, null],
    ],
  };
  const columns = readTable(data).columns;
  strictEqual(incompleteRows(columns), 1);
});

check("an analysis whose chosen column is gone says so, whatever the test", async () => {
  const xy = treatments(["X", "Y1", "Y2"]);
  const cases: [Parameters<typeof runAnalysis>[0], object][] = [
    ["linear-regression", { y: "Gone", forceOrigin: false }],
    ["nonlinear-regression", { y: "Gone", model: "line" }],
    ["correlation", { method: "pearson", mode: "two-datasets", datasets: ["Y1", "Gone"] }],
    ["multiple-regression", { dependent: "Y1", predictors: ["X", "Gone"] }],
    ["multiple-logistic-regression", { dependent: "Y1", predictors: ["X", "Gone"] }],
  ];
  for (const [type, params] of cases) {
    deepStrictEqual(await runAnalysis(type, xy, params as AnalysisParams), { error: missingColumn("Gone") }, type);
  }
});

// R2-m5 (bug-fix queue item 39 — not the review sweep's M5, the params
// fallback): a chosen predictor holding no numbers was silently dropped and
// the fit ran on the subset. The fit now names it in its notes. The
// selection is pure, so this checks the shared selector + note directly;
// a full fit would need R, and the three runners append this note verbatim
// to their outcome.
check("a chosen predictor holding no numbers is named, not silently dropped", () => {
  const data: TableData = {
    columns: ["Title", "Y", "X", "Empty"],
    rows: [
      [null, "0", "1", null],
      [null, "1", "2", null],
      [null, "0", "3", null],
      [null, "1", "4", null],
      [null, "0", "5", null],
    ],
  };
  const columns = readTable(data).columns;
  const { dep, predictors, dropped } = selectPredictors(columns, {
    dependent: "Y",
    predictors: ["X", "Empty"],
  });
  strictEqual(dep?.name, "Y");
  deepStrictEqual(predictors.map((c) => c.name), ["X"]);
  deepStrictEqual(dropped, ["Empty"]);
  const note = droppedPredictorsNote(dropped);
  ok(note.includes("“Empty”"), `note should name the dropped predictor, got: ${note}`);
  ok(note.includes("left out of the fit"), `note should say it was left out, got: ${note}`);
  // Nothing chosen dataless: no note, and the no-predictors-chosen default
  // (every other data-bearing column) is unchanged.
  deepStrictEqual(selectPredictors(columns, { dependent: "Y" }).dropped, []);
  strictEqual(droppedPredictorsNote([]), "");
});

// R3-23: the constant-variable check ran on the raw columns, before
// complete-case filtering — a variable that varies only on rows another
// variable leaves blank is constant on the complete rows, and prcomp /
// scale then failed with a raw R error. The check now runs on the aligned
// (complete-case) columns, so the variable is named instead.
check("a variable constant only after complete-case filtering names itself in PCA and K-means (R3-23)", async () => {
  // A varies (1, 2, 5, 5, 5) but is 5, 5, 5 on the complete rows — B is
  // blank on the two rows where A varies.
  const data: TableData = {
    columns: ["Title", "A", "B", "C"],
    rows: [
      ["", "1", null, "10"],
      ["", "2", null, "20"],
      ["", "5", "1", "30"],
      ["", "5", "2", "40"],
      ["", "5", "3", "50"],
    ],
  };
  deepStrictEqual(await runAnalysis("principal-component-analysis", data, { scale: "correlation" }), {
    error:
      "“A” is constant — PCA on the correlation matrix cannot standardise a variable with no " +
      "variation. Remove it from the table, or run PCA on the covariance matrix instead.",
  });
  deepStrictEqual(await runAnalysis("k-means", data, { clusters: 2 }), {
    error:
      "“A” is constant — K-means clustering cannot standardise a variable with no " +
      "variation. Remove it from the table, or run without standardisation instead.",
  });
  // The same table runs on the settings that do not standardise: a constant
  // variable contributes no variance / nothing to the distances there.
  const cov = await runAnalysis("principal-component-analysis", data, { scale: "covariance" });
  ok(!("error" in cov), `covariance PCA should run, got ${"error" in cov ? cov.error : "ok"}`);
  const raw = await runAnalysis("k-means", data, { clusters: 2, standardise: false });
  ok(!("error" in raw), `raw K-means should run, got ${"error" in raw ? raw.error : "ok"}`);
});

// R3-23: same complete-case leak in Cox PH — a covariate varying only on
// rows another used column leaves blank was checked on its raw values, then
// coxph could not estimate it. The check now runs on the aligned columns.
check("a Cox covariate constant only after complete-case filtering names itself (R3-23)", async () => {
  // Age varies (20, 30) only on the rows where Trt is blank; it is 40 on
  // every complete row.
  const data: TableData = {
    columns: ["Title", "Time", "Status", "Trt", "Age"],
    rows: [
      ["", "1", "1", null, "20"],
      ["", "2", "1", null, "30"],
      ["", "3", "0", "1", "40"],
      ["", "4", "1", "0", "40"],
      ["", "5", "0", "1", "40"],
      ["", "6", "1", "0", "40"],
      ["", "7", "1", "1", "40"],
      ["", "8", "0", "0", "40"],
    ],
  };
  deepStrictEqual(
    await runAnalysis("cox-proportional-hazards", data, { time: "Time", status: "Status", covariates: ["Trt", "Age"] }),
    { error: "Covariate “Age” has no variation." },
  );
});

// R3-23: a constant or collinear predictor was aliased by R —
// summary(m)$coefficients drops the aliased row, so co[t + 1, ] crashed
// with "subscript out of bounds". The runners now check is.na(coef(m))
// before indexing and name the aliased predictor instead.
check("a constant or collinear predictor is named, not a crash, in multiple regression (R3-23)", async () => {
  const table = (x2: string[]): TableData => ({
    columns: ["Title", "Y", "X1", "X2"],
    rows: [
      ["", "3", "1", x2[0]],
      ["", "5", "2", x2[1]],
      ["", "4", "3", x2[2]],
      ["", "6", "4", x2[3]],
      ["", "7", "5", x2[4]],
      ["", "5", "6", x2[5]],
      ["", "8", "7", x2[6]],
      ["", "6", "8", x2[7]],
    ],
  });
  const params = { dependent: "Y", predictors: ["X1", "X2"] };
  deepStrictEqual(await runAnalysis("multiple-regression", table(["5", "5", "5", "5", "5", "5", "5", "5"]), params), {
    error:
      "“X2” is constant — Multiple linear regression cannot estimate a slope for a predictor with no " +
      "variation. Drop or recode the predictor and try again.",
  });
  deepStrictEqual(
    await runAnalysis("multiple-regression", table(["2", "4", "6", "8", "10", "12", "14", "16"]), params),
    {
      error:
        "“X2” is collinear with another predictor — Multiple linear regression cannot estimate a separate " +
        "coefficient for it. Drop or recode the predictor and try again.",
    },
  );
  // Both predictors constant: every slope is aliased (an intercept-only
  // fit, whose F statistic is NULL) — still a named error, not a crash.
  const bothConstant: TableData = {
    columns: ["Title", "Y", "X1", "X2"],
    rows: [
      ["", "3", "5", "5"],
      ["", "5", "5", "5"],
      ["", "4", "5", "5"],
      ["", "6", "5", "5"],
      ["", "7", "5", "5"],
      ["", "5", "5", "5"],
      ["", "8", "5", "5"],
      ["", "6", "5", "5"],
    ],
  };
  deepStrictEqual(await runAnalysis("multiple-regression", bothConstant, params), {
    error:
      "“X1”, “X2” are constant — Multiple linear regression cannot estimate a slope for a predictor with no " +
      "variation. Drop or recode the predictors and try again.",
  });
  // A clean fit still fits: the aliasing guard must not fire on good data.
  const good = await runAnalysis("multiple-regression", table(["1", "0", "2", "1", "0", "2", "1", "0"]), params);
  ok(!("error" in good), `clean fit should run, got ${"error" in good ? good.error : "ok"}`);
});

check("a constant or collinear predictor is named, not a crash, in multiple logistic regression (R3-23)", async () => {
  const table = (x2: string[]): TableData => ({
    columns: ["Title", "Y", "X1", "X2"],
    rows: [
      ["", "0", "22", x2[0]],
      ["", "1", "25", x2[1]],
      ["", "0", "28", x2[2]],
      ["", "1", "31", x2[3]],
      ["", "1", "34", x2[4]],
      ["", "0", "37", x2[5]],
      ["", "1", "40", x2[6]],
      ["", "0", "43", x2[7]],
    ],
  });
  const params = { dependent: "Y", predictors: ["X1", "X2"] };
  deepStrictEqual(
    await runAnalysis("multiple-logistic-regression", table(["5", "5", "5", "5", "5", "5", "5", "5"]), params),
    {
      error:
        "“X2” is constant — Multiple logistic regression cannot estimate a slope for a predictor with no " +
        "variation. Drop or recode the predictor and try again.",
    },
  );
  deepStrictEqual(
    await runAnalysis("multiple-logistic-regression", table(["44", "50", "56", "62", "68", "74", "80", "86"]), params),
    {
      error:
        "“X2” is collinear with another predictor — Multiple logistic regression cannot estimate a separate " +
        "coefficient for it. Drop or recode the predictor and try again.",
    },
  );
  const good = await runAnalysis("multiple-logistic-regression", table(["1", "0", "2", "1", "0", "2", "1", "0"]), params);
  ok(!("error" in good), `clean fit should run, got ${"error" in good ? good.error : "ok"}`);
});

check("a constant or collinear predictor is named, not a crash, in Poisson regression (R3-23)", async () => {
  const table = (x2: string[]): TableData => ({
    columns: ["Title", "Y", "X1", "X2"],
    rows: [
      ["", "2", "0", x2[0]],
      ["", "3", "1", x2[1]],
      ["", "2", "0", x2[2]],
      ["", "5", "1", x2[3]],
      ["", "4", "2", x2[4]],
      ["", "6", "1", x2[5]],
      ["", "5", "2", x2[6]],
      ["", "7", "3", x2[7]],
    ],
  });
  const params = { dependent: "Y", predictors: ["X1", "X2"], quasi: false };
  deepStrictEqual(await runAnalysis("poisson-regression", table(["1", "1", "1", "1", "1", "1", "1", "1"]), params), {
    error:
      "“X2” is constant — Poisson regression cannot estimate a slope for a predictor with no " +
      "variation. Drop or recode the predictor and try again.",
  });
  deepStrictEqual(
    await runAnalysis("poisson-regression", table(["0", "2", "0", "2", "4", "2", "4", "6"]), params),
    {
      error:
        "“X2” is collinear with another predictor — Poisson regression cannot estimate a separate " +
        "coefficient for it. Drop or recode the predictor and try again.",
    },
  );
  const good = await runAnalysis("poisson-regression", table(["1", "0", "2", "1", "0", "2", "1", "0"]), params);
  ok(!("error" in good), `clean fit should run, got ${"error" in good ? good.error : "ok"}`);
});

// M8: a hand-edited or older file may carry y as one bare string — the file
// reader's `name-or-names` kind permits it — while the runner works with a
// list. One name must mean one series, never one character per series.
check("a bare-string y in enzyme inhibition means one series", async () => {
  const oneSeries: TableData = {
    columns: ["Title", "X", "Total"],
    rows: [
      ["", "1", "10"],
      ["", "2", "20"],
      ["", "3", "30"],
      ["", "5", "40"],
      ["", "10", "50"],
    ],
  };
  const twoSeriesError =
    "A global inhibition fit needs at least two series — an uninhibited series ([I] = 0) and at least one inhibited series.";
  // A global fit naming one series: the two-series error — before the fix
  // `.find` on the string threw a TypeError instead.
  deepStrictEqual(
    await runAnalysis("enzyme-inhibition", oneSeries, { y: "Total", model: "competitive" } as AnalysisParams),
    { error: twoSeriesError },
  );
  // A one-character name: the same error, now because one series was
  // chosen — before the fix it came from the string's length.
  const oneChar: TableData = {
    columns: ["Title", "X", "A", "B"],
    rows: [
      ["", "1", "10", "9"],
      ["", "2", "20", "18"],
      ["", "3", "30", "27"],
      ["", "5", "40", "36"],
      ["", "10", "50", "45"],
    ],
  };
  deepStrictEqual(
    await runAnalysis("enzyme-inhibition", oneChar, { y: "A", model: "competitive" } as AnalysisParams),
    { error: twoSeriesError },
  );
  // Morrison reads the whole name, not its first character: with no Et the
  // run must reach the Et check — before the fix it looked for a column
  // called "T", found none, and returned a phantom `{ error: undefined }`.
  deepStrictEqual(
    await runAnalysis("enzyme-inhibition", oneSeries, { y: "Total", model: "morrison" } as AnalysisParams),
    { error: "Total enzyme concentration (Et) is required for the Morrison Ki fit." },
  );
  // And with Et it fits the "Total" column (Et = 5, Kiapp = 2, v0 = 100,
  // noiseless — the reference Morrison numbers under a multi-letter name).
  const morrison: TableData = {
    columns: ["Title", "X", "Total"],
    rows: [
      ["", "0", "100"],
      ["", "1", "86.3324958071"],
      ["", "2", "74.0312423743"],
      ["", "5", "46.3324958071"],
      ["", "10", "24.3398113206"],
      ["", "20", "11.3835714722"],
      ["", "50", "4.2362280552"],
    ],
  };
  const fit = await runAnalysis(
    "enzyme-inhibition",
    morrison,
    { y: "Total", model: "morrison", enzymeConcentration: 5 } as AnalysisParams,
  );
  ok(!("error" in fit) && fit.coefficients, "bare-string y must run the Morrison fit");
  const kiapp = fit.coefficients!.find((c) => c.term === "Kiapp")?.estimate;
  ok(kiapp != null && Math.abs(kiapp - 2) < 0.01, `Kiapp should be ~2, got ${kiapp}`);
});

check("a wizard asks which data sets only when there is a choice", () => {
  const ids = (type: keyof typeof WIZARDS, data: TableData, a = {}) =>
    WIZARDS[type]!.questions(a, readTable(data)).flatMap((q) => (q ? [q.id] : []));
  const three = treatments(["Control", "Drug A", "Drug B"]);
  deepStrictEqual(ids("compare-two-groups", three).slice(0, 2), ["set1", "set2"]);
  ok(!ids("compare-two-groups", treatments(["Control", "Drug A"])).includes("set1"));
  deepStrictEqual(ids("descriptive-statistics", treatments(["Control"])), []);
  deepStrictEqual(ids("descriptive-statistics", three), ["sets"]);
  const answers = {
    set1: "Drug B",
    set2: "Control",
    paired: "unpaired",
    gaussian: "yes",
    variance: "equal",
    tails: "two-sided",
  };
  deepStrictEqual(WIZARDS["compare-two-groups"]!.finish(answers, readTable(three)).params?.sets, ["Drug B", "Control"]);
  const many = WIZARDS["compare-many-groups"]!.questions({}, readTable(treatments(["A", "B", "C", "D"])))[0];
  ok(many && many.kind === "names" && many.min === 3);
  let grouped = newGroupedTable(3, 1);
  grouped = writeBlock(grouped, 0, 0, [["r1", "1", "2", "3"]], "grouped");
  deepStrictEqual(
    WIZARDS["multiple-t-tests"]!.questions({}, readTable(grouped))
      .slice(0, 2)
      .map((q) => q && q.kind === "choice" && q.options.map((o) => o.value)),
    [
      ["A", "B", "C"],
      ["A", "B", "C"],
    ],
  );
});

check("multiple t tests leave a constant row open instead of aborting the analysis", async () => {
  // Row r0 is constant in both groups ([5,5,5] vs [5,5,5]): t.test errors
  // "data are essentially constant" on it and used to abort the whole
  // multi-row analysis. (A [0,0,0] row only yields NaN, since R's
  // epsilon-scaled check is 0 < 0 there.)
  const data: TableData = {
    columns: ["Title", "A:1", "A:2", "A:3", "B:1", "B:2", "B:3"],
    rows: [
      ["r0", "5", "5", "5", "5", "5", "5"],
      ["r1", "1", "2", "3", "4", "5", "6"],
      ["r2", "2", "3", "4", "5", "6", "7"],
    ],
  };
  const out = await runAnalysis("multiple-t-tests", data, {
    gaussian: true,
    pooledSd: false,
    paired: false,
    correction: "holm",
  });
  if ("error" in out) throw new Error(out.error);
  strictEqual(out.stats.find((s) => s.label === "Rows compared")?.value, 3);
  strictEqual(out.comparisons![0].p, null, "the constant row is open");
  ok(out.comparisons![1].p !== null && out.comparisons![2].p !== null, "non-constant rows still complete");
});

check("the dose-response — Special wizard completes with X + 1 Y and the fit names the shortfall (R2-B4)", async () => {
  // One Y could never satisfy the two-series minimum, so the wizard used to
  // strand on a permanently disabled Next with no message; the runner's
  // clear error ("add at least a control and one shifted curve") was
  // unreachable. The step now relaxes its minimum to 1 and names the
  // shortfall, so the wizard reaches Run and the fit reports it.
  const one = treatments(["X", "Y1"]);
  const ys = WIZARDS["dose-response-special"]!.questions({}, readTable(one)).find((q) => q && q.id === "ys");
  ok(ys && ys.kind === "names" && ys.options.length === 1 && ys.min === 1, "one Y: the step is passable");
  ok(
    ys &&
      ys.kind === "names" &&
      /Only one Y data set exists/.test(ys.ask) &&
      /control and at least one shifted curve/.test(ys.ask),
    "one Y: the question names the shortfall",
  );
  const finished = WIZARDS["dose-response-special"]!.finish(
    { model: "schild-slope-1", ys: ["Y1"], first: "Y1", bUnits: "M", fixHillSlope: "no" },
    readTable(one),
  );
  deepStrictEqual(await runAnalysis(finished.type, one, finished.params), {
    error: "Dose-response — Special fits several curves at once — add at least a control and one shifted curve.",
  });
  // With two Y series the requirement is unchanged.
  const two = treatments(["X", "Y1", "Y2"]);
  const ys2 = WIZARDS["dose-response-special"]!.questions({}, readTable(two)).find((q) => q && q.id === "ys");
  ok(ys2 && ys2.kind === "names" && ys2.min === 2, "two Y: the minimum stays 2");
  ok(ys2 && ys2.kind === "names" && /Which Y data sets should be fitted/.test(ys2.ask), "two Y: the usual question");
});

check("a Schild plot with duplicate antagonist concentrations shows no slope, not Infinity", () => {
  // G-F10: two antagonist series at the same B share one log[B], so the
  // two-point slope divides by zero (±Inf, or NaN when the points
  // coincide) — mathematically undefined, never a number to display.
  const group = (name: string) => ({ name, mean: null, sd: null, sem: null, median: null, n: 3 });
  const duplicateFit: AnalysisResult = {
    testType: "dose-response-special",
    stats: [],
    groups: [group("0 M"), group("1e-8 M"), group("10 nM")],
    notes: "",
    coefficients: [
      { term: "pA2", estimate: 8, stdError: null, t: null, p: null },
      { term: "SchildSlope", estimate: 1, stdError: null, t: null, p: null },
    ],
  };
  const params: DoseResponseSpecialParams = {
    model: "schild-slope-1",
    antagonistConcentrations: { "1e-8 M": 1e-8, "10 nM": 1e-8 },
  };
  const plot = schildPlotPoints(duplicateFit, params);
  strictEqual(plot.points.length, 2, "both duplicate-B points are still plotted");
  strictEqual(plot.slope, null, "duplicate log[B] gives no slope, not ±Inf/NaN");
  strictEqual(plot.intercept, null, "duplicate log[B] gives no intercept");
  const opts = newGraphOptions("schild-plot");
  const fig = { data: [], layout: { annotations: [] } } as unknown as GraphFigure;
  addSchildPlot(fig, duplicateFit, params, paintOf(opts, 3), opts);
  const traces = fig.data as { mode?: string }[];
  ok(traces.some((t) => t.mode === "markers"), "the points are drawn");
  ok(!traces.some((t) => t.mode === "lines"), "no fitted line is drawn without a slope");
  const notes = (fig.layout.annotations as { text?: string }[] | undefined) ?? [];
  ok(notes.some((a) => a.text?.includes("Slope undefined")), "the note says the slope is undefined");
  ok(!notes.some((a) => a.text?.includes("Infinity")), "no note prints 'Slope = Infinity'");
});

check("the ROC wizard asks truth, score and positive class, defaulting to the largest value", () => {
  const data: TableData = {
    columns: ["Title", "Truth", "Score"],
    rows: [
      [null, "Diseased", "0.9"],
      [null, "Healthy", "0.2"],
    ],
  };
  const asked = (a: Record<string, string>) =>
    WIZARDS["roc-curve"]!.questions(a, readTable(data)).flatMap((q) => (q ? [q.id] : []));
  deepStrictEqual(asked({}), ["truth", "score", "positive"]);
  // The positive question lists the largest value first (the wizard
  // pre-selects the first option) and says so in the question.
  const positive = WIZARDS["roc-curve"]!.questions({ truth: "Truth" }, readTable(data))[2];
  ok(positive && positive.kind === "choice");
  deepStrictEqual(
    positive.options.map((o) => o.value),
    ["Healthy", "Diseased"],
  );
  ok(positive.ask.includes("largest value"));
  // finish keeps a text positive value as text, a numeric one as a number.
  deepStrictEqual(
    WIZARDS["roc-curve"]!.finish({ truth: "Truth", score: "Score", positive: "Diseased" }, readTable(data)).params,
    { truth: "Truth", score: "Score", positive: "Diseased" },
  );
  const numeric: TableData = {
    columns: ["Title", "Truth", "Score"],
    rows: [
      [null, "1", "0.9"],
      [null, "0", "0.2"],
    ],
  };
  deepStrictEqual(
    WIZARDS["roc-curve"]!.finish({ truth: "Truth", score: "Score", positive: "1" }, readTable(numeric)).params,
    { truth: "Truth", score: "Score", positive: 1 },
  );
  // The menu offers ROC curve after Bland-Altman on column tables, and ROC
  // curve last (after Interpolate) on XY tables.
  deepStrictEqual(
    analysisOptionsForTable("column")
      .map((o) => o.value)
      .slice(-2),
    ["bland-altman", "roc-curve"],
  );
  deepStrictEqual(
    analysisOptionsForTable("xy")
      .map((o) => o.value)
      .slice(-2),
    ["interpolate", "roc-curve"],
  );
});

check("the normality-tests wizard asks for the test and lognormality, and D'Agostino–Pearson matches SciPy", () => {
  const data = treatments(["A", "B"]);
  const asked = (a: Record<string, string | string[]> = {}) =>
    WIZARDS["shapiro-wilk"]!.questions(a, readTable(data)).flatMap((q) => (q ? [q.id] : []));
  deepStrictEqual(asked(), ["sets", "test", "lognormal"]);
  deepStrictEqual(
    WIZARDS["shapiro-wilk"]!.questions({}, readTable(treatments(["A"]))).flatMap((q) => (q ? [q.id] : [])),
    ["test", "lognormal"],
  );
  const testQ = WIZARDS["shapiro-wilk"]!.questions({}, readTable(data))[1];
  ok(testQ && testQ.kind === "choice");
  deepStrictEqual(
    testQ.options.map((o) => o.value),
    ["shapiro-wilk", "dagostino-pearson", "anderson-darling", "kolmogorov-smirnov"],
  );
  // Shapiro–Wilk is the first option, so the default; the D'Agostino–Pearson
  // option names its n ≥ 20 floor.
  ok(testQ.options[1].label.includes("n ≥ 20"));
  deepStrictEqual(
    WIZARDS["shapiro-wilk"]!.finish({ test: "anderson-darling", lognormal: "yes" }, readTable(data)),
    { type: "shapiro-wilk", params: { test: "anderson-darling", lognormal: true } },
  );
  deepStrictEqual(
    WIZARDS["shapiro-wilk"]!.finish({ test: "shapiro-wilk", lognormal: "no" }, readTable(data)).params,
    { test: "shapiro-wilk", lognormal: false },
  );
  // The menu offers Normality tests between "Compare one group to a value"
  // and the Kolmogorov-Smirnov test on column tables.
  const columnOrder = analysisOptionsForTable("column").map((o) => o.value);
  strictEqual(columnOrder[columnOrder.indexOf("shapiro-wilk") - 1], "one-sample-t");
  strictEqual(columnOrder[columnOrder.indexOf("shapiro-wilk") + 1], "kolmogorov-smirnov");
  // D'Agostino–Pearson (plan 23's A/B columns): the TS implementation
  // matches SciPy 1.11's normaltest — A K2 0.1566 P 0.9247, B K2 23.7348
  // P 0.000007 — to 1e-9.
  const moments = (xs: number[]) => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const d = xs.map((x) => x - mean);
    return {
      n: xs.length,
      m2: d.reduce((a, x) => a + x * x, 0) / xs.length,
      m3: d.reduce((a, x) => a + x ** 3, 0) / xs.length,
      m4: d.reduce((a, x) => a + x ** 4, 0) / xs.length,
    };
  };
  const A = [12.0, 12.4, 11.7, 10.9, 11.5, 10.8, 12.1, 13.6, 11.4, 11.3, 12.6, 12.4, 12.1, 10.9, 12.0, 12.8, 10.4, 11.5, 9.7, 10.5, 9.8, 11.7, 10.5, 12.3, 12.2];
  const B = [6.5, 1.3, 5.1, 7.1, 8.0, 2.5, 5.3, 3.7, 4.2, 15.5, 4.2, 7.2, 13.7, 4.9, 6.8, 8.0, 7.7, 3.1, 7.8, 19.1, 2.5, 13.5, 8.0, 4.7, 30.0];
  for (const [xs, k2, p] of [
    [A, 0.15657081422370814, 0.9247004727869231],
    [B, 23.73481271219545, 0.0000070153752305447],
  ] as const) {
    const { n, m2, m3, m4 } = moments(xs);
    const got = dagostinoPearson(n, m2, m3, m4);
    ok(got && Math.abs(got.k2 - k2) < 1e-9 && Math.abs(got.p - p) < 1e-9, `DP: ${got?.k2} / ${got?.p}`);
  }
  // The params survive a .hlx round-trip; a bogus test falls back (the
  // runner takes its default).
  const withAnalysis: ProjectFilePayload = {
    ...payload,
    nodes: {
      ...payload.nodes,
      a1: {
        id: "a1",
        type: "analysis",
        name: "A",
        parentId: "t1",
        analysisType: "shapiro-wilk",
        analysisParams: { test: "anderson-darling", lognormal: true },
      },
    },
    childOrder: { t1: ["a1"] },
  };
  deepStrictEqual(read(serializeProjectFile(withAnalysis)).project.nodes.a1.analysisParams, {
    test: "anderson-darling",
    lognormal: true,
  });
  const bogus = JSON.parse(serializeProjectFile(withAnalysis));
  bogus.project.nodes.a1.analysisParams.test = "dagostino";
  strictEqual(
    (read(JSON.stringify(bogus)).project.nodes.a1.analysisParams as { test?: string } | undefined)?.test,
    undefined,
  );
});

check("the mixed-effects wizard asks the layout's questions, and the menu offers it next to the analysis it replaces", () => {
  const asked = (data: TableData, a: Record<string, string | string[]> = {}) =>
    WIZARDS["mixed-effects"]!.questions(a, readTable(data)).flatMap((q) => (q ? [q.id] : []));
  // A Column table: the repeated-measure columns, then the matched-subjects
  // question, then the optional between-subject-factor question.
  const column = treatments(["T0", "T1", "T2", "T3"]);
  deepStrictEqual(asked(column), ["sets", "matched", "groups"]);
  deepStrictEqual(asked(column, { groups: "yes" }), ["sets", "matched", "groups", "groupName", "groupLevels"]);
  const setsQ = WIZARDS["mixed-effects"]!.questions({}, readTable(column))[0];
  ok(setsQ && setsQ.kind === "names" && setsQ.min === 3);
  // A Grouped table: interaction, then matched-subjects.
  deepStrictEqual(asked(grouped()), ["interaction", "matched"]);
  // The finish names the time factor from the columns' shared prefix (T0–T3 → "T").
  deepStrictEqual(
    WIZARDS["mixed-effects"]!.finish({ sets: ["T0", "T1", "T2", "T3"], matched: "matched" }, readTable(column)),
    {
      type: "mixed-effects",
      params: { subjectId: "row", randomStructure: "intercept", fixedFactors: ["T"], sets: ["T0", "T1", "T2", "T3"] },
    },
  );
  // With groups answered, the finish carries the subject factor (two-factor fit).
  deepStrictEqual(
    WIZARDS["mixed-effects"]!.finish(
      {
        sets: ["T0", "T1", "T2", "T3"],
        matched: "matched",
        groups: "yes",
        groupName: "Treatment",
        groupLevels: "Control, Control, Control, Treated, Treated, Treated",
      },
      readTable(column),
    ),
    {
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
    },
  );
  // The menu offers it after "Compare more than two groups" on column tables
  // (next to the repeated-measures ANOVA it replaces when data are missing),
  // and after two-way ANOVA on grouped tables.
  const columnOrder = analysisOptionsForTable("column").map((o) => o.value);
  strictEqual(columnOrder[columnOrder.indexOf("mixed-effects") - 1], "compare-many-groups");
  const groupedOrder = analysisOptionsForTable("grouped").map((o) => o.value);
  strictEqual(groupedOrder[groupedOrder.indexOf("mixed-effects") - 1], "two-way-anova");
});

check("parseGroupLevels validates the mixed-effects per-row group list", () => {
  deepStrictEqual(parseGroupLevels("Control, Control, Control, Treated, Treated, Treated", 6).values, [
    "Control",
    "Control",
    "Control",
    "Treated",
    "Treated",
    "Treated",
  ]);
  ok(parseGroupLevels("", 6).error?.includes("6 rows"));
  ok(parseGroupLevels("Control, Treated", 6).error?.includes("found 2 for 6 rows"));
  ok(parseGroupLevels("Control, , Control, Treated, Treated, Treated", 6).error?.includes("row 2 is blank"));
  ok(parseGroupLevels("Control, Control, Control, Control, Control, Control", 6).error?.includes("at least two levels"));
  // The group-name question needs its own parse: a text question without one
  // falls back to comma-separated numbers, so "Treatment" would error as
  // "not a number" and the wizard could never advance (caught in the GUI).
  const groupNameQ = WIZARDS["mixed-effects"]!
    .questions({ groups: "yes" }, readTable(treatments(["T0", "T1", "T2", "T3"])))
    .find((q): q is Question => q !== false && q.id === "groupName");
  ok(groupNameQ && groupNameQ.kind === "text");
  if (groupNameQ?.kind === "text") {
    strictEqual(groupNameQ.parse?.("Treatment")?.error, undefined);
    ok(groupNameQ.parse?.("")?.error);
  }
});

check("mixed-effects skips entirely empty rows in a Grouped table and reports a dropped rank-deficient term as NA", async () => {
  // Group B holds data only at the first row, so the Group × Row interaction
  // column is all zeros: lmer drops it from summary(m)$coefficients, and
  // indexing it by position used to crash "subscript out of bounds" (and
  // mislabel the terms after it). The last row is entirely empty: it must
  // not count toward "Observations dropped as missing".
  const data: TableData = {
    columns: ["Title", "A:1", "A:2", "A:3", "B:1", "B:2", "B:3"],
    rows: [
      ["", "10", "12", "11", "20", "22", "21"],
      ["", "11", "13", "12", null, null, null],
      ["", "12", "14", "13", null, null, null],
      ["", "13", "15", "14", null, null, null],
      ["", null, null, null, null, null, null],
    ],
  };
  const out = await runAnalysis("mixed-effects", data, {});
  if ("error" in out) throw new Error(out.error);
  const stat = (label: string) => out.stats.find((s) => s.label === label)?.value;
  // 4 non-empty rows × 6 columns = 24 in the table; 15 used; 9 dropped.
  strictEqual(stat("Observations in table"), 24);
  strictEqual(stat("Observations dropped as missing"), 9);
  const byTerm = (term: string) => out.coefficients?.find((c) => c.term === term)?.estimate;
  ok(byTerm("Intercept") !== null && byTerm("Intercept") !== undefined, "intercept estimated");
  ok(byTerm("Group (B vs A)") !== null && byTerm("Group (B vs A)") !== undefined, "group effect estimated");
  ok(byTerm("Row") !== null && byTerm("Row") !== undefined, "row effect estimated");
  strictEqual(byTerm("Group × Row (B vs A)"), null, "the dropped interaction is open, not mislabelled");
  ok(out.notes?.includes("could not be estimated"), "the note names the dropped term");
});

check("the chi-square wizard asks about ordering only on a 2×k / k×2 table, defaulting to no trend", () => {
  const asked = (data: TableData) =>
    WIZARDS["chi-square"]!.questions({}, readTable(data)).flatMap((q) => (q ? [q.id] : []));
  const trend2x4: TableData = {
    columns: ["Title", "Success", "Failure"],
    rows: [
      ["Dose 1", "2", "18"],
      ["Dose 2", "5", "15"],
      ["Dose 3", "9", "11"],
      ["Dose 4", "14", "6"],
    ],
  };
  const trend4x2: TableData = {
    columns: ["Title", "Dose 1", "Dose 2", "Dose 3", "Dose 4"],
    rows: [
      ["Success", "2", "5", "9", "14"],
      ["Failure", "18", "15", "11", "6"],
    ],
  };
  const twoByTwo: TableData = {
    columns: ["Title", "Outcome A", "Outcome B"],
    rows: [
      ["Drug", "15", "5"],
      ["Placebo", "6", "14"],
    ],
  };
  const threeByThree: TableData = {
    columns: ["Title", "Outcome A", "Outcome B", "Outcome C"],
    rows: [
      ["North", "20", "15", "10"],
      ["South", "12", "18", "25"],
      ["East", "14", "16", "15"],
    ],
  };
  deepStrictEqual(asked(trend2x4), ["trendOrdered"]);
  deepStrictEqual(asked(trend4x2), ["trendOrdered"]);
  deepStrictEqual(asked(twoByTwo), []);
  deepStrictEqual(asked(threeByThree), []);
  const q = WIZARDS["chi-square"]!.questions({}, readTable(trend2x4))[0];
  ok(q && q.kind === "choice");
  // "No" comes first: the wizard pre-selects the first option, so the trend
  // does not run unless the user confirms the ordering.
  deepStrictEqual(
    q.kind === "choice" ? q.options.map((o) => o.value) : [],
    ["no", "yes"],
  );
  deepStrictEqual(WIZARDS["chi-square"]!.finish({ trendOrdered: "yes" }, readTable(trend2x4)), {
    type: "chi-square",
    params: { trendOrdered: true },
  });
  deepStrictEqual(WIZARDS["chi-square"]!.finish({}, readTable(twoByTwo)), {
    type: "chi-square",
    params: { trendOrdered: false },
  });
  // McNemar's test sits after chi-square on contingency tables.
  deepStrictEqual(
    analysisOptionsForTable("contingency").map((o) => o.value),
    ["chi-square", "mcnemar"],
  );
  deepStrictEqual(analysisOptionsForTable("contingency")[1]?.label, "McNemar's test (paired proportions)");
});

// QAB-4: the 2×2 chi-square shown for reference is the UNCORRECTED Pearson
// statistic (Prism's default), not R's Yates-corrected default. Fisher's exact
// test is the primary result and must stay untouched.
check("the 2x2 chi-square for reference is uncorrected, Fisher's exact unchanged", async () => {
  const twoByTwo: TableData = {
    columns: ["Title", "Outcome A", "Outcome B"],
    rows: [
      ["Drug", "15", "5"],
      ["Placebo", "6", "14"],
    ],
  };
  const out = await runAnalysis("chi-square", twoByTwo);
  if ("error" in out) throw new Error(out.error);
  const stat = (label: string) => out.stats.find((s) => s.label === label)?.value;
  close(stat("Chi-square (for reference)"), 8.1203, 1e-3, "uncorrected chi-square");
  close(stat("P value (Fisher's exact test)"), 0.0103867, 1e-3, "Fisher p value");
  strictEqual(stat("df"), 1);
  const second: TableData = {
    columns: ["Title", "Outcome A", "Outcome B"],
    rows: [
      ["Group 1", "10", "20"],
      ["Group 2", "30", "40"],
    ],
  };
  const out2 = await runAnalysis("chi-square", second);
  if ("error" in out2) throw new Error(out2.error);
  const stat2 = (label: string) => out2.stats.find((s) => s.label === label)?.value;
  close(stat2("Chi-square (for reference)"), 0.7937, 1e-3, "uncorrected chi-square, second table");
});

// BUG-REPORT #28 leg 3: prop.trend.test on a first row/column holding 0%
// or 100% of the counts crashed R's lm.wfit ("NA/NaN/Inf in 'x'"). The
// guard names the constant row/column instead of calling it — and a table
// with a real trend still runs the trend test.
check("the chi-square trend test names a constant first row or column instead of crashing R", async () => {
  const trendError = async (data: TableData) => {
    const out = await runAnalysis("chi-square", data, { trendOrdered: true });
    if (!("error" in out)) throw new Error(`expected a trend error, got ${JSON.stringify(out.stats)}`);
    return out.error;
  };
  const firstCol0: TableData = {
    columns: ["Title", "Success", "Failure"],
    rows: [
      ["Dose 1", "0", "20"],
      ["Dose 2", "0", "15"],
      ["Dose 3", "0", "11"],
      ["Dose 4", "0", "6"],
    ],
  };
  const firstCol100: TableData = {
    columns: ["Title", "Success", "Failure"],
    rows: [
      ["Dose 1", "20", "0"],
      ["Dose 2", "15", "0"],
      ["Dose 3", "11", "0"],
      ["Dose 4", "6", "0"],
    ],
  };
  const firstRow0: TableData = {
    columns: ["Title", "Dose 1", "Dose 2", "Dose 3", "Dose 4"],
    rows: [
      ["Success", "0", "0", "0", "0"],
      ["Failure", "18", "15", "11", "6"],
    ],
  };
  const firstRow100: TableData = {
    columns: ["Title", "Dose 1", "Dose 2", "Dose 3", "Dose 4"],
    rows: [
      ["Success", "2", "5", "9", "14"],
      ["Failure", "0", "0", "0", "0"],
    ],
  };
  const e0 = await trendError(firstCol0);
  ok(e0.includes("test for trend is undefined") && e0.includes("first column") && e0.includes("0%"), e0);
  const e100 = await trendError(firstCol100);
  ok(e100.includes("test for trend is undefined") && e100.includes("first column") && e100.includes("100%"), e100);
  const r0 = await trendError(firstRow0);
  ok(r0.includes("test for trend is undefined") && r0.includes("first row") && r0.includes("0%"), r0);
  const r100 = await trendError(firstRow100);
  ok(r100.includes("test for trend is undefined") && r100.includes("first row") && r100.includes("100%"), r100);
  // A table with a real trend still runs the trend test (same data as the
  // wizard check above).
  const trend2x4: TableData = {
    columns: ["Title", "Success", "Failure"],
    rows: [
      ["Dose 1", "2", "18"],
      ["Dose 2", "5", "15"],
      ["Dose 3", "9", "11"],
      ["Dose 4", "14", "6"],
    ],
  };
  const out = await runAnalysis("chi-square", trend2x4, { trendOrdered: true });
  if ("error" in out) throw new Error(out.error);
  const stat = (label: string) => out.stats.find((s) => s.label === label)?.value;
  close(stat("Chi-square for trend"), 17.0667, 1e-3, "chi-square for trend");
  close(stat("P value (test for trend)"), 0.0000361, 1e-6, "trend p value");
});

check("the McNemar wizard confirms paired data and defaults the correction on", () => {
  const data: TableData = {
    columns: ["Title", "Second: Yes", "Second: No"],
    rows: [
      ["First: Yes", "20", "12"],
      ["First: No", "4", "30"],
    ],
  };
  const asked = (a: Record<string, string>) =>
    WIZARDS["mcnemar"]!.questions(a, readTable(data)).flatMap((q) => (q ? [q.id] : []));
  deepStrictEqual(asked({}), ["paired", "continuityCorrection"]);
  const qs = WIZARDS["mcnemar"]!.questions({}, readTable(data)).filter((q): q is Question => q !== false);
  const paired = qs.find((q) => q.id === "paired");
  ok(paired && paired.kind === "choice");
  deepStrictEqual(
    paired.kind === "choice" ? paired.options.map((o) => o.value) : [],
    ["yes"],
  );
  ok(paired.ask.includes("paired outcomes") && paired.ask.includes("Do NOT use this for two independent groups"));
  const correction = qs.find((q) => q.id === "continuityCorrection");
  ok(correction && correction.kind === "choice");
  deepStrictEqual(
    correction.kind === "choice" ? correction.options.map((o) => o.value) : [],
    ["yes", "no"],
  );
  deepStrictEqual(
    WIZARDS["mcnemar"]!.finish({ paired: "yes", continuityCorrection: "yes" }, readTable(data)),
    { type: "mcnemar", params: { continuityCorrection: true } },
  );
  deepStrictEqual(
    WIZARDS["mcnemar"]!.finish({ paired: "yes", continuityCorrection: "no" }, readTable(data)),
    { type: "mcnemar", params: { continuityCorrection: false } },
  );
});

check("the Cox wizard asks time, status, covariates, stratifier and ties, with binary-only stratification", () => {
  const data: TableData = {
    columns: ["Title", "Time", "Status", "Trt", "Age"],
    rows: [
      [null, "3", "1", "0", "62"],
      [null, "6", "1", "1", "60"],
      [null, "9", "0", "1", "57"],
    ],
  };
  const asked = (a: Record<string, string>) =>
    WIZARDS["cox-proportional-hazards"]!.questions(a, readTable(data)).flatMap((q) => (q ? [q.id] : []));
  deepStrictEqual(asked({}), ["time", "status", "covariates", "stratifyBy", "ties"]);
  const qs = WIZARDS["cox-proportional-hazards"]!.questions({}, readTable(data)).filter(
    (q): q is Question => q !== false,
  );
  const covariates = qs.find((q) => q.id === "covariates");
  ok(covariates && covariates.kind === "names");
  deepStrictEqual(covariates.kind === "names" ? covariates.options : [], ["Trt", "Age"]);
  // Only binary (exactly two distinct values) covariates stratify the curves.
  const stratify = qs.find((q) => q.id === "stratifyBy");
  ok(stratify && stratify.kind === "choice");
  deepStrictEqual(
    stratify.kind === "choice" ? stratify.options.map((o) => o.value) : [],
    ["Trt", "none"],
  );
  deepStrictEqual(
    WIZARDS["cox-proportional-hazards"]!.finish(
      { time: "Time", status: "Status", covariates: ["Trt", "Age"], stratifyBy: "Trt", ties: "breslow" },
      readTable(data),
    ),
    {
      type: "cox-proportional-hazards",
      params: { time: "Time", status: "Status", covariates: ["Trt", "Age"], ties: "breslow", stratifyBy: "Trt" },
    },
  );
  // "None" drops the stratifier from the params.
  deepStrictEqual(
    WIZARDS["cox-proportional-hazards"]!.finish(
      { time: "Time", status: "Status", covariates: ["Trt"], stratifyBy: "none", ties: "efron" },
      readTable(data),
    ).params,
    { time: "Time", status: "Status", covariates: ["Trt"], ties: "efron" },
  );
  // The menu offers Descriptive statistics first on Multiple Variables
  // tables, Principal component analysis after Multiple regression,
  // K-means clustering after that, Outliers after that, Multiple logistic
  // regression after that, Poisson regression after that, and Cox after that.
  deepStrictEqual(
    analysisOptionsForTable("multiple").map((o) => o.value),
    [
      "descriptive-statistics",
      "correlation-matrix",
      "multiple-regression",
      "principal-component-analysis",
      "k-means",
      "outliers",
      "multiple-logistic-regression",
      "poisson-regression",
      "cox-proportional-hazards",
    ],
  );
  // Multiple Variables tables offer the scatter plot, the forest plot, the
  // observed-vs-fitted graph, the scree plot, the scores biplot, the
  // cluster scatter, and survival curves.
  deepStrictEqual(
    GRAPH_OPTIONS_BY_TABLE["multiple"].map((o) => o.value),
    ["xy-scatter", "heatmap", "volcano", "forest-plot", "observed-fitted", "scree-plot", "pca-biplot", "kmeans-scatter", "survival"],
  );
  // Renaming a column follows the Cox analysis's params.
  const renamed = followTable(
    {
      ...analysis,
      analysisType: "cox-proportional-hazards",
      analysisParams: { time: "Time", status: "Status", covariates: ["Trt", "Age"], stratifyBy: "Trt" },
    },
    { renamed: { Trt: "Treatment", Age: "Years" } },
    [],
  );
  deepStrictEqual(renamed.analysisParams, {
    time: "Time",
    status: "Status",
    covariates: ["Treatment", "Years"],
    stratifyBy: "Treatment",
  });
});

check("the forest plot drops non-finite or non-positive hazard ratios instead of blanking on a log axis (R2-M14)", () => {
  const options = newGraphOptions("forest-plot");
  const fig = GRAPHS["forest-plot"].build([], options, paintOf(options, 1));
  // Under separation a Cox CI underflows to 0 or overflows to Inf (and the
  // hazard ratio itself can underflow to 0): log10 of those is -Infinity /
  // Infinity, an invalid Plotly range that blanked the whole plot.
  const outcome: AnalysisResult = {
    testType: "cox-proportional-hazards",
    stats: [],
    groups: [],
    notes: "",
    coefficients: [
      { term: "Trt", estimate: null, stdError: null, t: null, p: null, hazardRatio: 0.3672, low: 0.1009, high: 1.3369 },
      { term: "Age", estimate: null, stdError: null, t: null, p: null, hazardRatio: 2.1, low: 0, high: 4.5 },
      { term: "Sex", estimate: null, stdError: null, t: null, p: null, hazardRatio: 1.4, low: 0.8, high: Number.POSITIVE_INFINITY },
      { term: "Stage", estimate: null, stdError: null, t: null, p: null, hazardRatio: 0, low: 0.5, high: 2 },
    ],
  };
  addForestPlot(fig, outcome, paintOf(options, 1), options);
  const traces = fig.data as { mode?: string; x?: number[]; y?: string[]; text?: string[] }[];
  const row = traces.find((t) => t.mode === "markers");
  deepStrictEqual(row?.y, ["Trt"]);
  deepStrictEqual(row?.x, [0.3672]);
  const xaxis = fig.layout.xaxis as { type?: string; range?: number[] };
  ok(
    xaxis.range?.every((v) => Number.isFinite(v)),
    `forest-plot range must be finite, got ${JSON.stringify(xaxis.range)}`,
  );
  const notes = (fig.layout.annotations as { text?: string }[] | undefined) ?? [];
  ok(
    notes.some((n) => n.text?.includes("“Age”") && n.text?.includes("“Sex”") && n.text?.includes("“Stage”")),
    `omitted covariates must be named on the figure, got ${JSON.stringify(notes.map((n) => n.text))}`,
  );
  // All rows degenerate: nothing to draw, but the note still lands and
  // nothing throws — the figure keeps its (log, empty) axes.
  const empty = GRAPHS["forest-plot"].build([], options, paintOf(options, 1));
  addForestPlot(
    empty,
    {
      testType: "cox-proportional-hazards",
      stats: [],
      groups: [],
      notes: "",
      coefficients: [{ term: "Age", estimate: null, stdError: null, t: null, p: null, hazardRatio: 2.1, low: 0, high: 4.5 }],
    },
    paintOf(options, 1),
    options,
  );
  strictEqual(empty.data.length, 0);
  ok(
    ((empty.layout.annotations as { text?: string }[] | undefined) ?? []).some((n) => n.text?.includes("“Age”")),
    "the all-dropped note must still name the omitted covariate",
  );
});

check("the forest plot names a covariate whose CI bound came back null (R2-M14)", () => {
  const options = newGraphOptions("forest-plot");
  const fig = GRAPHS["forest-plot"].build([], options, paintOf(options, 1));
  // The real separation signature: R's exp(confint(m)) upper bound
  // overflows to +Inf and evalNamedVector maps it to null (headless repro
  // on the GUI fixture: Safe HR 1.226e-9, low 0, high null). A null bound
  // must be omitted WITH a note, not silently filtered out first.
  const outcome: AnalysisResult = {
    testType: "cox-proportional-hazards",
    stats: [],
    groups: [],
    notes: "",
    coefficients: [
      { term: "Trt", estimate: null, stdError: null, t: null, p: null, hazardRatio: 0.4164, low: 0.1149, high: 1.5091 },
      { term: "Age", estimate: null, stdError: null, t: null, p: null, hazardRatio: 1.012, low: 0.909, high: 1.1267 },
      { term: "Safe", estimate: null, stdError: null, t: null, p: null, hazardRatio: 1.226e-9, low: 0, high: null },
    ],
  };
  addForestPlot(fig, outcome, paintOf(options, 1), options);
  const traces = fig.data as { mode?: string; x?: number[]; y?: string[] }[];
  const row = traces.find((t) => t.mode === "markers");
  deepStrictEqual(row?.y, ["Trt", "Age"]);
  const xaxis = fig.layout.xaxis as { range?: number[] };
  ok(
    xaxis.range?.every((v) => Number.isFinite(v)),
    `forest-plot range must be finite, got ${JSON.stringify(xaxis.range)}`,
  );
  const notes = (fig.layout.annotations as { text?: string }[] | undefined) ?? [];
  ok(
    notes.some((n) => n.text?.includes("“Safe”")),
    `the null-bound covariate must be named on the figure, got ${JSON.stringify(notes.map((n) => n.text))}`,
  );
});

check("the observed-vs-fitted plot drops overflowed fitted counts with a note instead of hiding the worst misfit (R2-G-F15)", () => {
  const options = newGraphOptions("observed-fitted");
  const fig = GRAPHS["observed-fitted"].build([], options, paintOf(options, 1));
  // A linear predictor past ~709 overflows exp(): the fitted count comes
  // back Infinity, which Plotly silently drops from the trace — and the
  // y = x line's range stretches to Infinity with it, so the line vanishes
  // too. The overflowed rows are the worst misfits; they must be named on
  // the figure, not silently hidden, and the line must span the drawable
  // points only.
  // NOTE — synthetic coefficients only, by design: no live GLM can ever
  // produce this note. A converging Poisson glm can never yield an infinite
  // fitted count, because R's glm.fit IRLS overflows mu/weights to Inf/NaN
  // and errors ("NA/NaN/Inf in 'x'") before converging whenever a linear
  // predictor would pass ~709. The live stretch fixture built on the
  // opposite assumption (poisson-overflow.hlx: Dose 0–0.003, Count 1 /
  // 1e150 / 1e300 / 1) failed deterministically in the 2026-11-13 final GUI
  // session (reproduced via Retry): the analysis errored, so the graph had
  // no coefficients and showed empty axes with no note. That fixture is
  // retired — do not re-add a live-GLM expectation for this note. The
  // overflow path is reachable only when coefficients arrive without a live
  // fit (as below), and that is what this check verifies.
  const { columns } = readTable({
    columns: ["Title", "Count", "Dose"],
    rows: [
      [null, "3", "0"],
      [null, "5", "1"],
      [null, "7", "2"],
    ],
  });
  const outcome: AnalysisResult = {
    testType: "poisson-regression",
    stats: [],
    groups: [],
    notes: "",
    coefficients: [
      { term: "Intercept", estimate: 1, stdError: null, t: null, p: null },
      { term: "Dose", estimate: 800, stdError: null, t: null, p: null },
    ],
  };
  addObservedFitted(fig, columns, outcome, { dependent: "Count", predictors: ["Dose"], quasi: false }, paintOf(options, 1), options);
  const traces = fig.data as { mode?: string; name?: string; x?: number[]; y?: number[] }[];
  const points = traces.find((t) => t.mode === "markers");
  deepStrictEqual(points?.x, [3]);
  deepStrictEqual(points?.y, [Math.exp(1)]);
  ok(
    traces.every((t) => [...(t.x ?? []), ...(t.y ?? [])].every((v) => Number.isFinite(v))),
    `no trace may carry a non-finite value, got ${JSON.stringify(fig.data)}`,
  );
  const line = traces.find((t) => t.name === "y = x");
  ok(
    line?.x?.every((v) => Number.isFinite(v)) && line?.y?.every((v) => Number.isFinite(v)),
    `the y = x line must span the drawable points only, got ${JSON.stringify(line?.x)} / ${JSON.stringify(line?.y)}`,
  );
  const notes = (fig.layout.annotations as { text?: string }[] | undefined) ?? [];
  ok(
    notes.some((n) => n.text?.includes("2 rows omitted")),
    `the omitted rows must be named on the figure, got ${JSON.stringify(notes.map((n) => n.text))}`,
  );
  // All rows overflow: nothing to draw, but the note still lands and
  // nothing throws — the figure keeps its (empty) axes.
  const empty = GRAPHS["observed-fitted"].build([], options, paintOf(options, 1));
  addObservedFitted(
    empty,
    columns,
    {
      testType: "poisson-regression",
      stats: [],
      groups: [],
      notes: "",
      coefficients: [
        { term: "Intercept", estimate: 800, stdError: null, t: null, p: null },
        { term: "Dose", estimate: 0.5, stdError: null, t: null, p: null },
      ],
    },
    { dependent: "Count", predictors: ["Dose"], quasi: false },
    paintOf(options, 1),
    options,
  );
  strictEqual(empty.data.length, 0);
  ok(
    ((empty.layout.annotations as { text?: string }[] | undefined) ?? []).some((n) => n.text?.includes("3 rows omitted")),
    "the all-overflowed note must still name the omitted rows",
  );
});

check("the PCA wizard asks scale then components, defaulting to the correlation matrix and all components", () => {
  const data: TableData = {
    columns: ["Title", "Var1", "Var2", "Var3"],
    rows: [
      [null, "2.5", "2.4", "1.0"],
      [null, "0.5", "0.7", "0.2"],
    ],
  };
  const qs = WIZARDS["principal-component-analysis"]!.questions({}, readTable(data)).filter(
    (q): q is Question => q !== false,
  );
  deepStrictEqual(
    qs.map((q) => q.id),
    ["scale", "components"],
  );
  const scale = qs.find((q) => q.id === "scale");
  ok(scale && scale.kind === "choice");
  deepStrictEqual(
    scale.kind === "choice" ? scale.options.map((o) => o.value) : [],
    ["correlation", "covariance"],
  );
  const components = qs.find((q) => q.id === "components");
  ok(components && components.kind === "number");
  if (components?.kind === "number") {
    strictEqual(components.initial, 0);
    strictEqual(components.validate?.(-1), "Enter a whole number of components (0 = all).");
    strictEqual(components.validate?.(1.5), "Enter a whole number of components (0 = all).");
    strictEqual(components.validate?.(2), undefined);
  }
  deepStrictEqual(
    WIZARDS["principal-component-analysis"]!.finish({ scale: "covariance", components: 2 }, readTable(data)),
    {
      type: "principal-component-analysis",
      params: { scale: "covariance", components: 2 },
    },
  );
  // No answers: the correlation matrix (first choice) and all components.
  deepStrictEqual(WIZARDS["principal-component-analysis"]!.finish({}, readTable(data)), {
    type: "principal-component-analysis",
    params: { scale: "correlation", components: undefined },
  });
});

check("the K-means wizard asks clusters then standardisation, defaulting to 2 clusters, standardised", () => {
  const data: TableData = {
    columns: ["Title", "X", "Y"],
    rows: [
      [null, "1", "1"],
      [null, "8", "8"],
    ],
  };
  const qs = WIZARDS["k-means"]!.questions({}, readTable(data)).filter(
    (q): q is Question => q !== false,
  );
  deepStrictEqual(
    qs.map((q) => q.id),
    ["clusters", "standardise"],
  );
  const clusters = qs.find((q) => q.id === "clusters");
  ok(clusters && clusters.kind === "number");
  if (clusters?.kind === "number") {
    strictEqual(clusters.initial, 2);
    strictEqual(clusters.validate?.(1), "Enter a whole number of clusters (at least 2).");
    strictEqual(clusters.validate?.(2.5), "Enter a whole number of clusters (at least 2).");
    strictEqual(clusters.validate?.(3), undefined);
  }
  const standardise = qs.find((q) => q.id === "standardise");
  ok(standardise && standardise.kind === "choice");
  deepStrictEqual(
    standardise.kind === "choice" ? standardise.options.map((o) => o.value) : [],
    ["yes", "no"],
  );
  deepStrictEqual(WIZARDS["k-means"]!.finish({ clusters: 3, standardise: "no" }, readTable(data)), {
    type: "k-means",
    params: { clusters: 3, standardise: false },
  });
  // No answers: 2 clusters (the initial), standardised (the default).
  deepStrictEqual(WIZARDS["k-means"]!.finish({ clusters: 2 }, readTable(data)), {
    type: "k-means",
    params: { clusters: 2, standardise: true },
  });
});

check("the outliers wizard rejects an out-of-range ROUT Q, and the runner refuses it too", async () => {
  const data: TableData = {
    columns: ["Title", "A", "B"],
    rows: [
      [null, "1.2", "2.1"],
      [null, "1.5", "2.4"],
      [null, "1.1", "2.0"],
      [null, "1.4", "2.2"],
      [null, "9.8", "2.3"],
    ],
  };
  const qs = WIZARDS["outliers"]!.questions({}, readTable(data)).filter(
    (q): q is Question => q !== false,
  );
  const q = qs.find((x) => x.id === "q");
  ok(q && q.kind === "number");
  if (q?.kind === "number") {
    // Q = 0 (or below) can never flag anything; above 50 flags nearly
    // everything — both are degenerate, not just unusual.
    strictEqual(q.validate?.(0), "Q must be between 0.01 and 50.");
    strictEqual(q.validate?.(100), "Q must be between 0.01 and 50.");
    strictEqual(q.validate?.(0.01), undefined);
    strictEqual(q.validate?.(1), undefined);
    strictEqual(q.validate?.(50), undefined);
  }
  // The runner refuses the same values: saved projects and direct
  // runAnalysis calls bypass the wizard, so the guard lives there too.
  const columns = readTable(data).columns;
  deepStrictEqual(await runRout(columns, { q: 0 }), { error: "Q must be between 0.01 and 50." });
  deepStrictEqual(await runRout(columns, { q: 100 }), { error: "Q must be between 0.01 and 50." });
  ok(!("error" in (await runRout(columns, { q: 1 }))));
  ok(!("error" in (await runRout(columns, { q: 50 }))));
});

check("the multiple logistic regression wizard offers only 0/1 columns as the outcome", () => {
  const data: TableData = {
    columns: ["Title", "Outcome", "Age", "Dose"],
    rows: [
      [null, "0", "22", "0"],
      [null, "1", "31", "1"],
      [null, "0", "42", "2"],
    ],
  };
  const qs = WIZARDS["multiple-logistic-regression"]!.questions({}, readTable(data)).filter(
    (q): q is Question => q !== false,
  );
  deepStrictEqual(
    qs.map((q) => q.id),
    ["dependent", "predictors"],
  );
  // Only the binary column is offered as the dependent; with none chosen yet,
  // the predictors are every data column.
  const dependent = qs.find((q) => q.id === "dependent");
  ok(dependent && dependent.kind === "choice");
  deepStrictEqual(
    dependent.kind === "choice" ? dependent.options.map((o) => o.value) : [],
    ["Outcome"],
  );
  const predictors = qs.find((q) => q.id === "predictors");
  ok(predictors && predictors.kind === "names");
  deepStrictEqual(predictors.kind === "names" ? predictors.options : [], ["Outcome", "Age", "Dose"]);
  // With a dependent chosen, the predictors exclude it.
  const asked = WIZARDS["multiple-logistic-regression"]!.questions({ dependent: "Outcome" }, readTable(data)).filter(
    (q): q is Question => q !== false,
  );
  const predictorsAfter = asked.find((q) => q.id === "predictors");
  deepStrictEqual(predictorsAfter?.kind === "names" ? predictorsAfter.options : [], ["Age", "Dose"]);
  deepStrictEqual(
    WIZARDS["multiple-logistic-regression"]!.finish(
      { dependent: "Outcome", predictors: ["Age", "Dose"] },
      readTable(data),
    ),
    {
      type: "multiple-logistic-regression",
      params: { dependent: "Outcome", predictors: ["Age", "Dose"] },
    },
  );
  // With no binary column at all, every data column is offered and the
  // runner (not the wizard) reports the problem.
  const noBinary: TableData = {
    columns: ["Title", "Weight", "Height"],
    rows: [
      [null, "70", "175"],
      [null, "82", "181"],
    ],
  };
  const fallback = WIZARDS["multiple-logistic-regression"]!.questions({}, readTable(noBinary)).filter(
    (q): q is Question => q !== false,
  );
  const fallbackDependent = fallback.find((q) => q.id === "dependent");
  deepStrictEqual(
    fallbackDependent?.kind === "choice" ? fallbackDependent.options.map((o) => o.value) : [],
    ["Weight", "Height"],
  );
});

check("multiple logistic regression refuses a non-binary or constant outcome, and too few rows", async () => {
  const table = (outcome: (string | null)[], age: (string | null)[], dose: (string | null)[]): TableData => ({
    columns: ["Title", "Outcome", "Age", "Dose"],
    rows: outcome.map((v, r) => [null, v, age[r], dose[r]]),
  });
  const params = { dependent: "Outcome", predictors: ["Age", "Dose"] };
  // A 2 in the outcome is named, not coerced.
  deepStrictEqual(
    await runAnalysis("multiple-logistic-regression", table(["0", "2", "1", "0"], ["22", "25", "28", "31"], ["0", "0", "1", "0"]), params),
    { error: "“Outcome” holds 2, but the outcome must hold only 0s and 1s (1 = event, 0 = no event)." },
  );
  // All-0 outcome has no contrast to fit.
  deepStrictEqual(
    await runAnalysis("multiple-logistic-regression", table(["0", "0", "0", "0"], ["22", "25", "28", "31"], ["0", "0", "1", "0"]), params),
    { error: "The outcome has only one value (all 0s / all 1s). Logistic regression needs both outcomes." },
  );
  // Three complete rows cannot fit two predictors.
  deepStrictEqual(
    await runAnalysis("multiple-logistic-regression", table(["0", "1", "0"], ["22", "25", "28"], ["0", "1", "0"]), params),
    { error: "Not enough complete rows (3) to fit 2 predictor(s). Enter more data and try again." },
  );
});

check("a logistic curve on a non-binary Y shows the points and says the outcome must be 0/1 (F-02)", async () => {
  // The textbook dose-response table (F-02's fixture): X −2..2, Response 2..98.
  const textbook: TableData = {
    columns: ["Title", "X", "Response"],
    rows: [
      [null, "-2", "2"],
      [null, "-1.5", "5"],
      [null, "-1", "12"],
      [null, "-0.5", "30"],
      [null, "0", "50"],
      [null, "0.5", "70"],
      [null, "1", "88"],
      [null, "1.5", "95"],
      [null, "2", "98"],
    ],
  };
  // The binary fixture (reference.ts's `logistic`): X 0..9, Response 0/0/0/0/1/0/1/1/1/1.
  const binary: TableData = {
    columns: ["Title", "X", "Response"],
    rows: [
      [null, "0", "0"],
      [null, "1", "0"],
      [null, "2", "0"],
      [null, "3", "0"],
      [null, "4", "1"],
      [null, "5", "0"],
      [null, "6", "1"],
      [null, "7", "1"],
      [null, "8", "1"],
      [null, "9", "1"],
    ],
  };
  const build = (data: TableData) => {
    const opts = newGraphOptions("logistic-curve");
    return GRAPHS["logistic-curve"].build(
      plotColumns(readTable(data), "logistic-curve", opts, "xy"),
      opts,
      paintOf(opts, 1),
      readTable(data).titles,
    );
  };
  // Binary, as designed: the fixed 0–1 axis with 0/1 ticks.
  const binaryFig = build(binary);
  const binaryY = binaryFig.layout.yaxis as { range: number[]; autorange: boolean; tickvals: number[] };
  deepStrictEqual(binaryY.range, [-0.05, 1.05]);
  strictEqual(binaryY.autorange, false);
  deepStrictEqual(binaryY.tickvals, [0, 1]);
  // Non-binary: no fixed 0–1 range — Plotly autoranges, so all 9 points stay visible.
  const fig = build(textbook);
  const yaxis = fig.layout.yaxis as { range?: number[]; autorange?: boolean };
  ok(yaxis.range === undefined || yaxis.range[1] >= 98, `logistic Y range: ${JSON.stringify(yaxis.range)}`);
  ok(yaxis.autorange !== false, "logistic Y axis must autorange on a non-binary Y");
  const [trace] = fig.data as { y?: number[] }[];
  deepStrictEqual(trace?.y, [2, 5, 12, 30, 50, 70, 88, 95, 98]);
  // The runner's error becomes the on-graph note; a good fit, or a fit still
  // running, becomes no note.
  const bad = await runAnalysis("simple-logistic-regression", textbook, {});
  ok("error" in bad, "the textbook table must refuse simple logistic regression");
  const note = logisticCurveNote(bad);
  ok(note?.includes("0/1"), `logistic note: ${note}`);
  const good = await runAnalysis("simple-logistic-regression", binary, {});
  ok(!("error" in good), `binary logistic fit: ${"error" in good ? good.error : "ok"}`);
  strictEqual(logisticCurveNote(good), null);
  strictEqual(logisticCurveNote(null), null);
});

check("the poisson regression wizard asks for the dependent, predictors, and quasi-Poisson", () => {
  const data: TableData = {
    columns: ["Title", "Count", "Dose", "Age"],
    rows: [
      [null, "2", "0", "20"],
      [null, "3", "1", "25"],
    ],
  };
  const qs = WIZARDS["poisson-regression"]!.questions({}, readTable(data)).filter(
    (q): q is Question => q !== false,
  );
  deepStrictEqual(
    qs.map((q) => q.id),
    ["dependent", "predictors", "quasi"],
  );
  const quasi = qs.find((q) => q.id === "quasi");
  ok(quasi && quasi.kind === "choice");
  deepStrictEqual(
    quasi.kind === "choice" ? quasi.options.map((o) => o.value) : [],
    ["no", "yes"],
  );
  // With a dependent chosen, the predictors exclude it.
  const asked = WIZARDS["poisson-regression"]!.questions({ dependent: "Count" }, readTable(data)).filter(
    (q): q is Question => q !== false,
  );
  const predictorsAfter = asked.find((q) => q.id === "predictors");
  deepStrictEqual(predictorsAfter?.kind === "names" ? predictorsAfter.options : [], ["Dose", "Age"]);
  // "yes" turns the quasi refit on; an unanswered quasi defaults to standard Poisson.
  deepStrictEqual(
    WIZARDS["poisson-regression"]!.finish(
      { dependent: "Count", predictors: ["Dose", "Age"], quasi: "yes" },
      readTable(data),
    ),
    {
      type: "poisson-regression",
      params: { dependent: "Count", predictors: ["Dose", "Age"], quasi: true },
    },
  );
  deepStrictEqual(
    WIZARDS["poisson-regression"]!.finish({ dependent: "Count", predictors: ["Dose", "Age"] }, readTable(data)),
    {
      type: "poisson-regression",
      params: { dependent: "Count", predictors: ["Dose", "Age"], quasi: false },
    },
  );
});

check("poisson regression refuses non-count, all-zero, and too-few-rows outcomes", async () => {
  const table = (outcome: (string | null)[], dose: (string | null)[], age: (string | null)[]): TableData => ({
    columns: ["Title", "Count", "Dose", "Age"],
    rows: outcome.map((v, r) => [null, v, dose[r], age[r]]),
  });
  const params = { dependent: "Count", predictors: ["Dose", "Age"], quasi: false };
  // A 2.5 in the outcome is named, not coerced.
  deepStrictEqual(
    await runAnalysis(
      "poisson-regression",
      table(["2", "2.5", "3", "5"], ["0", "0", "1", "1"], ["20", "25", "22", "27"]),
      params,
    ),
    { error: "“Count” holds 2.5, but Poisson regression needs whole-number counts (0, 1, 2, …)." },
  );
  // A negative count is named too.
  deepStrictEqual(
    await runAnalysis(
      "poisson-regression",
      table(["2", "-1", "3", "5"], ["0", "0", "1", "1"], ["20", "25", "22", "27"]),
      params,
    ),
    { error: "“Count” holds -1, but Poisson regression needs whole-number counts (0, 1, 2, …)." },
  );
  // An all-0 outcome has no information to fit.
  deepStrictEqual(
    await runAnalysis(
      "poisson-regression",
      table(["0", "0", "0", "0"], ["0", "0", "1", "1"], ["20", "25", "22", "27"]),
      params,
    ),
    { error: "The outcome is all zeros — Poisson regression needs counts that vary." },
  );
  // Three complete rows cannot fit two predictors.
  deepStrictEqual(
    await runAnalysis(
      "poisson-regression",
      table(["2", "3", "5"], ["0", "1", "1"], ["20", "25", "22"]),
      params,
    ),
    { error: "Not enough complete rows (3) to fit 2 predictor(s). Enter more data and try again." },
  );
});

check("an XY table without numbers in X or Y says which, in every XY analysis", async () => {
  const table = (x: (string | null)[], y: (string | null)[]): TableData => ({
    columns: ["Title", "Time", "Y1"],
    rows: x.map((v, r) => [null, v, y[r]]),
  });
  const cases: [TableData, string][] = [
    [
      table([null, null, null], ["1", "2", "3"]),
      "“Time”, the X column, is empty. Type the X values (times, doses…) in it.",
    ],
    [
      table(["Day 1", "Day 2", null], ["1", "2", "3"]),
      "“Time”, the X column, holds text (“Day 1”). X values must be numbers.",
    ],
    [table(["1", "2", "3"], [null, null, null]), "No Y column holds numbers yet."],
  ];
  for (const [data, message] of cases) {
    for (const [type, params] of [
      ["linear-regression", undefined],
      ["nonlinear-regression", { model: "line" }],
      ["area-under-curve", undefined],
      ["correlation", undefined],
    ] as const) {
      deepStrictEqual(await runAnalysis(type, data, params as AnalysisParams | undefined), { error: message }, type);
    }
  }
});

// ── Undo and names ───────────────────────────────────────────────────────

check("Undo and Redo take back and replay every kind of change", () => {
  let s = makeInitialState();
  const tableId = s.rootOrder[0];
  const empty = s.nodes[tableId].data!;
  const filled: TableData = { ...empty, rows: [[null, "1", "2"]] };
  s = reducer(s, { type: "updateTable", id: tableId, data: filled, label: "Typing" });
  s = reducer(s, { type: "rename", id: tableId, name: "Doses" });
  deepStrictEqual(
    s.past.map((step) => step.label),
    ["Typing", "Rename"],
  ); // "Undo Rename" in the Edit menu
  s = reducer(s, { type: "undo" });
  strictEqual(s.future.at(-1)?.label, "Rename"); // "Redo Rename"
  strictEqual(s.nodes[tableId].name, "Table 1");
  strictEqual(s.nodes[tableId].data, filled);
  s = reducer(s, { type: "undo" });
  strictEqual(s.nodes[tableId].data, empty);
  s = reducer(s, { type: "redo" });
  s = reducer(s, { type: "redo" });
  strictEqual(s.nodes[tableId].name, "Doses");
  strictEqual(s.future.length, 0);
});

check("new items are named among the names taken, and only ever in a table", () => {
  let s = makeInitialState(); // "Table 1"
  const table = (id: string): ProjectNode => ({
    id,
    type: "table",
    name: "Table",
    parentId: null,
    tableType: "column",
  });
  s = reducer(s, { type: "create", node: table("t2") });
  s = reducer(s, { type: "create", node: table("t3") });
  s = reducer(s, { type: "remove", id: "t2" });
  s = reducer(s, { type: "create", node: table("t4") });
  deepStrictEqual(
    s.rootOrder.map((id) => s.nodes[id].name),
    ["Table 1", "Table 3", "Table 2"],
  );
  s = reducer(s, { type: "create", node: { ...graph, id: "g2", parentId: "t3" } });
  s = reducer(s, { type: "create", node: { ...graph, id: "g3", parentId: "t3" } });
  deepStrictEqual(
    s.childOrder.t3.map((id) => s.nodes[id].name),
    ["Plot", "Plot 2"],
  );
  strictEqual(reducer(s, { type: "create", node: { ...graph, id: "g4", parentId: "g2" } }), s);
});

check("a deleted table comes back with its analyses and graphs", () => {
  let s = makeInitialState();
  const tableId = s.rootOrder[0];
  s = reducer(s, { type: "create", node: { ...analysis, parentId: tableId } });
  s = reducer(s, { type: "remove", id: tableId });
  strictEqual(Object.keys(s.nodes).length, 0);
  s = reducer(s, { type: "undo" });
  deepStrictEqual(Object.keys(s.nodes).sort(), [analysis.id, tableId].sort());
  deepStrictEqual(s.childOrder[tableId], [analysis.id]);
});

check("quick edits to one graph undo together; a pause starts a new step", () => {
  const start = makeInitialState();
  let s = reducer(start, { type: "create", node: { ...graph, parentId: start.rootOrder[0] } });
  const set = (title: string, at: number) =>
    (s = reducer(s, { type: "updateGraph", id: graph.id, options: { ...DEFAULT_GRAPH_OPTIONS, title }, at }));
  set("T", 1000);
  set("Ti", 1200);
  set("Title", 1400);
  set("Title 2", 5000);
  s = reducer(s, { type: "undo" });
  strictEqual(s.nodes[graph.id].graphOptions!.title, "Title");
  s = reducer(s, { type: "undo" });
  strictEqual(s.nodes[graph.id].graphOptions, graph.graphOptions);
});

check("changes that change nothing, and opening a file, leave no Undo step", () => {
  let s = makeInitialState();
  s = reducer(s, { type: "reorderRoot", order: [...s.rootOrder] });
  strictEqual(s.past.length, 0);
  s = reducer(s, { type: "rename", id: s.rootOrder[0], name: "Table 1" });
  strictEqual(s.past.length, 0);
  s = reducer(s, { type: "rename", id: s.rootOrder[0], name: "Other" });
  s = reducer(s, { type: "load", nodes: {}, rootOrder: [], childOrder: {}, activeNodeId: null, filePath: "/x.hlx" });
  strictEqual(s.past.length, 0);
});

// ── The app ──────────────────────────────────────────────────────────────

// F5: the Linux native About dialog drops AboutMetadata.credits (muda:
// "Windows / Linux: Unsupported") — the tagline and coffee address only
// reached macOS. The same text rides in `comments` and the address in
// `website`, the fields the GTK dialog renders; credits stays for macOS.
check("the About dialog carries the Buy Me a Coffee address where Linux renders it (F5)", () => {
  const menus = readFileSync(fileURLToPath(new URL("../src/menus.ts", import.meta.url)), "utf8");
  ok(menus.includes('const COFFEE_URL = "https://www.buymeacoffee.com/smitpatel316"'));
  ok(menus.includes("comments: ABOUT_CREDITS"), "the tagline + coffee address must ride in comments for Linux");
  ok(menus.includes("website: COFFEE_URL"), "the coffee address must ride in website for Linux");
  ok(menus.includes('websiteLabel: "Buy Me a Coffee"'));
  ok(menus.includes("credits: ABOUT_CREDITS"), "credits stays: it is what macOS renders");
});

check("menus and pickers name things in title case, as macOS does", () => {
  deepStrictEqual(
    [
      "Compare one group to a value",
      "Multiple t tests",
      "Identify outliers",
      "Chi-square or Fisher's exact test",
      "Two-way ANOVA",
      "Area under the curve",
      "Multiple Variables",
      "XY",
    ].map(titleCase),
    [
      "Compare One Group to a Value",
      "Multiple t Tests",
      "Identify Outliers",
      "Chi-Square or Fisher's Exact Test",
      "Two-Way ANOVA",
      "Area Under the Curve",
      "Multiple Variables",
      "XY",
    ],
  );
});

// QAB-1: a position-less native popup parked macOS's main thread in NSMenu's tracking
// loop and destroyed every window. This pins the CHANGE only — an explicit position +
// window at the click, passed through from the Match button, with a re-entrancy guard —
// not the bug itself: no popupMenu call has ever been observed working on the Mac GUI,
// so only the Mac repro proves the fix.
check("the Match popup menu passes an explicit position and window, with a re-entrancy guard", () => {
  const native = readFileSync(fileURLToPath(new URL("../src/native.ts", import.meta.url)), "utf8");
  ok(native.includes("menu.popup(new LogicalPosition(event.clientX, event.clientY), getCurrentWindow())"));
  ok(native.includes("popupMenu(items: PopupItem[], event?: { clientX: number; clientY: number })"));
  const match = readFileSync(fileURLToPath(new URL("../src/views/graphs/match-graph.tsx", import.meta.url)), "utf8");
  ok(match.includes("const choose = async (event: React.MouseEvent) => {"));
  ok(match.includes("if (popupOpen.current) return;"));
  ok(match.includes("await choose(event);"));
});

check("Open Recent reads only a list of paths", () => {
  const stored: Record<string, string> = {};
  const storage = {
    getItem: (k: string) => stored[k] ?? null,
    setItem: (k: string, v: string) => void (stored[k] = v),
  };
  Object.assign(globalThis, { localStorage: storage });
  try {
    for (const bad of ['{"a":1}', "[1, null]", "not json"]) {
      stored["titer.recent"] = bad;
      deepStrictEqual(loadRecents(), []);
    }
    stored["titer.recent"] = '["/a.hlx", 3, "/b.hlx"]';
    deepStrictEqual(loadRecents(), ["/a.hlx", "/b.hlx"]);
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

check("My Palettes keep, replace and delete palettes; a gradient of few colors blends evenly", async () => {
  const stored: Record<string, string> = {};
  const storage = {
    getItem: (k: string) => stored[k] ?? null,
    setItem: (k: string, v: string) => void (stored[k] = v),
  };
  const lab = { name: "Lab", kind: "categorical" as const, colors: ["#111111", "#222222"] };
  const heat = { name: "Heat", kind: "sequential" as const, colors: ["#FFFFFF", "#FF0000"] };
  Object.assign(globalThis, { localStorage: storage });
  try {
    ok((await keepPalette({ ...lab, reversed: true })) && (await keepPalette(heat)));
    deepStrictEqual(await loadMyPalettes(), [lab, heat]); // kept as shown: no `reversed`
    ok(await keepPalette({ ...lab, name: "Lab 2" }, "Lab"));
    deepStrictEqual(
      (await loadMyPalettes()).map((p) => p.name),
      ["Lab 2", "Heat"],
    );
    ok(await deletePalette("Lab 2"));
    deepStrictEqual(await loadMyPalettes(), [heat]);
    // A broken entry is left out, the others kept.
    stored["titer.palettes"] = JSON.stringify([heat, { name: "No colors", colors: [] }, 7]);
    deepStrictEqual(await loadMyPalettes(), [heat]);
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  deepStrictEqual(
    [0, 1, 2, 3, 4].map((i) => paletteColor(heat, i, 5)),
    ["#FFFFFF", "#FFBFBF", "#FF8080", "#FF4040", "#FF0000"],
  );
  ok(isTiterPalette("viridis") && isTiterPalette("Okabe-Ito") && !isTiterPalette("Lab"));
  // A gradient of one color, from a broken file, runs from it to itself.
  deepStrictEqual(readPalette({ name: "Red", kind: "sequential", colors: ["#FF0000"] })!.colors, [
    "#FF0000",
    "#FF0000",
  ]);
});

check("a release is newer only when its version number is higher", () => {
  ok(isNewer("v1.1.0", "1.0.0"));
  ok(isNewer("v1.10.0", "1.9.0"));
  ok(isNewer("2", "1.99.9"));
  ok(!isNewer("v1.0.0", "1.0.0"));
  ok(!isNewer("1.0", "1.0.1"));
});

check("a narrow window narrows the sidebar for the inspector only where there is one", () => {
  const layout = { sidebar: true, sidebarWidth: 224, inspector: true, inspectorWidth: 256 };
  deepStrictEqual(fitWidths(layout, 700, true), { sidebarWidth: 180, inspectorWidth: 220 });
  strictEqual(fitWidths(layout, 700, false).sidebarWidth, 224);
});

check("a graph too wide for its pane is fitted to the pane, never enlarged", () => {
  // A 640×460 sheet in a 520×600 pane (inspector open at a 1000px window):
  // 520 / (640 + 96) ≈ 0.71.
  const fitted = fitZoom(520, 600, 640, 460);
  ok(fitted > 0.7 && fitted < 0.72);
  // Room to spare: no scaling.
  strictEqual(fitZoom(1000, 800, 640, 460), 1);
  // Height-bound: a short pane clamps on height, not width (400 / (460 + 96) ≈ 0.72).
  const short = fitZoom(1000, 400, 640, 460);
  ok(short > 0.71 && short < 0.73);
  // A small graph is never enlarged.
  strictEqual(fitZoom(1000, 800, 200, 100), 1);
  // Fitting is view-only: it takes the saved size, it does not change it.
  const saved = { ...DEFAULT_GRAPH_OPTIONS };
  fitZoom(520, 600, saved.width, saved.height);
  deepStrictEqual(saved, DEFAULT_GRAPH_OPTIONS);
});

check("the update check still answers when GitHub refuses it", async () => {
  const answers = (...responses: Response[]) => {
    const asked: string[] = [];
    globalThis.fetch = async (url) => (asked.push(String(url)), responses.shift()!);
    return asked;
  };
  const json = (body: object) => new Response(JSON.stringify(body));
  const realFetch = globalThis.fetch;
  try {
    let asked = answers(json({ tag_name: "v1.2.0" }));
    strictEqual(await latestVersion(), "v1.2.0");
    strictEqual(asked.length, 1);
    answers(new Response(null, { status: 404 }));
    strictEqual(await latestVersion(), null);
    asked = answers(new Response(null, { status: 403 }), json({ version: "1.3.0" }));
    strictEqual(await latestVersion(), "1.3.0");
    ok(asked[1].startsWith("https://raw.githubusercontent.com/"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

import { parsePzfx } from "../src/lib/pzfx";

// ── Prism (.pzfx) import ──────────────────────────────────────────────
// Fixtures in tests/testdata/ are GraphPad Prism files from the pypzfx project
// (MIT, © Yue Jiang); the expected tables are in their `.tab` files, as
// pypzfx reads them. The importer is checked against those, not against Prism.

const pzfxFile = (name: string) =>
  parsePzfx(readFileSync(new URL(`./testdata/${name}.pzfx`, import.meta.url), "utf8"));
const importedTable = (name: string) => {
  const imported = pzfxFile(name);
  strictEqual(imported.tables.length, 1, `${name}: one table`);
  const node = imported.project.nodes[imported.project.rootOrder[0]];
  if (!node || node.type !== "table") throw new Error(`${name}: no table node`);
  return { imported, table: node };
};
const close = (value: number | null | undefined, expected: number, tol: number, what: string) =>
  ok(value != null && Math.abs(value - expected) <= tol, `${what}: got ${value}, expected ${expected}`);

check(".pzfx import reads a Column table", () => {
  const { imported, table } = importedTable("column");
  strictEqual(imported.issues.length, 0);
  strictEqual(table.name, "Data 1");
  strictEqual(table.tableType, "column");
  deepStrictEqual(table.data!.columns, ["Title", "Aa", "Bb"]);
  deepStrictEqual(table.data!.rows, [
    [null, "1.", "100."],
    [null, "2.", "90."],
    [null, "3.", "80."],
    [null, "4.", "70."],
  ]);
});

check(".pzfx import reads an XY table with replicates", () => {
  const { table } = importedTable("x_y_rep");
  strictEqual(table.tableType, "xy");
  deepStrictEqual(table.data!.columns, ["Title", "XX", "Ya_1", "Ya_2", "Yb_1", "Yb_2", "Yc_1", "Yc_2"]);
  deepStrictEqual(table.data!.rows, [
    ["A", "1.", "100.", "50.", "1.", "10.", "5.", "2."],
    ["B", "2.", "90.", "60.", "2.", "9.", "5.", "2."],
    ["C", "3.", "80.", "70.", "3.", "8.", "5.", "2."],
  ]);
});

check(".pzfx import keeps date X values as row titles", () => {
  const { imported, table } = importedTable("x_date");
  strictEqual(table.name, "Sample Data");
  strictEqual(table.tableType, "xy");
  deepStrictEqual(table.data!.columns, ["Title", "Date X", "Observation"]);
  strictEqual(table.data!.rows.length, 50);
  deepStrictEqual(table.data!.rows[0], ["16-Jan-2004", "0", "120"]);
  deepStrictEqual(table.data!.rows[1], ["9-Apr-2009", "5.22929500342231", "64"]);
  deepStrictEqual(table.data!.rows[2], ["1-Mar-2012", "8.12320328542094", "46"]);
  deepStrictEqual(table.data!.rows[49], ["17-Oct-2018", "14.7515400410678", "87"]);
  ok(imported.issues.some((i) => i.message.includes("kept as row titles")), "says the dates were kept as row titles");
});

check(".pzfx import keeps date X values in their own column when row titles exist", () => {
  const { imported, table } = importedTable("x_date_row_titles");
  strictEqual(table.name, "Sample Data");
  strictEqual(table.tableType, "xy");
  deepStrictEqual(table.data!.columns, ["Title", "Date X", "Date X (date)", "Observation"]);
  strictEqual(table.data!.rows.length, 5);
  deepStrictEqual(table.data!.rows[0], ["Sample A", "0", "16-Jan-2004", "120"]);
  deepStrictEqual(table.data!.rows[1], ["Sample B", "5.22929500342231", "9-Apr-2009", "64"]);
  deepStrictEqual(table.data!.rows[4], ["Sample E", "8.27652292950034", "26-Apr-2012", "52"]);
  // The warning must be true in this branch: the row titles are the original
  // ones, the dates live in their own column — neither "kept as row titles"
  // (false: the titles are the samples') nor "dropped" (false: kept).
  ok(
    imported.issues.some((i) => i.message.includes("kept in a “Date X (date)” column")),
    "says the dates were kept in their own column",
  );
  ok(
    !imported.issues.some((i) => i.message.includes("kept as row titles") || i.message.includes("were dropped")),
    "never claims the dates were kept as row titles or dropped",
  );
});

check(".pzfx import reads a Survival table (time + event codes)", () => {
  const { imported, table } = importedTable("survival");
  strictEqual(table.tableType, "survival");
  deepStrictEqual(table.data!.columns, ["Title", "Days", "Control", "Treatment A", "Treatment B"]);
  strictEqual(table.data!.rows.length, 27);
  deepStrictEqual(table.data!.rows[0], ["CO", "78", "1", null, null]);
  deepStrictEqual(table.data!.rows[26], ["OO", "351", null, null, "1"]);
  ok(imported.issues.some((i) => i.message.includes("Survival table")), "says the survival analysis applies");
});

check("the survival analysis reproduces the log-rank value on survival.pzfx", async () => {
  const { table } = importedTable("survival");
  const out = await runAnalysis("survival", table.data!, { curveTest: "logrank", correction: "holm" });
  if ("error" in out) throw new Error(out.error);
  const stat = (label: string) => out.stats.find((s) => s.label === label)?.value;
  close(stat("Chi-square"), 4.844, 1e-3, "chi-square");
  strictEqual(stat("df"), 2);
  close(stat("P value"), 0.0888, 1e-3, "P value");
});

check(".pzfx import reads a Contingency table", () => {
  const { table } = importedTable("contingency");
  strictEqual(table.tableType, "contingency");
  deepStrictEqual(table.data!.columns, ["Title", "A", "B"]);
  deepStrictEqual(table.data!.rows, [
    ["a", "10", "30"],
    ["b", "20", "40"],
  ]);
});

check(".pzfx import keeps struck-through values as excluded cells", () => {
  const { table } = importedTable("x_y_with_strike");
  deepStrictEqual(table.data!.rows[1], ["B", "2.", "90.", "60.", "2.", "9.", "5.", "2."]);
  deepStrictEqual(table.data!.excluded, ["1,2", "1,3", "1,4"]);
});

check(".pzfx import keeps Excluded markers on the X column and its X error column", () => {
  // Before the fix the XY/Survival branch pushed the X and X error columns
  // with `excluded: new Set()`, so a struck-through X value (row 1 here, in
  // both X and X error) silently became an active data point.
  const text = `<?xml version="1.0" encoding="UTF-8"?><GraphPadPrismFile PrismXMLVersion="5.00">
<Table ID="Table0" XFormat="error" TableType="XY" YFormat="replicates">
<Title>XY strike</Title>
<RowTitlesColumn Width="89"><Subcolumn><d>A</d><d>B</d><d>C</d></Subcolumn></RowTitlesColumn>
<XColumn Width="89" Decimals="0" Subcolumns="2"><Title>X</Title><Subcolumn><d>1.</d><d Excluded="1">2.</d><d>3.</d></Subcolumn><Subcolumn><d>0.1</d><d Excluded="1">0.2</d><d>0.3</d></Subcolumn></XColumn>
<YColumn Width="89" Decimals="0" Subcolumns="1"><Title>A</Title><Subcolumn><d>10.</d><d>20.</d><d>30.</d></Subcolumn></YColumn>
</Table>
</GraphPadPrismFile>`;
  const imported = parsePzfx(text);
  strictEqual(imported.tables.length, 1);
  const node = imported.project.nodes[imported.project.rootOrder[0]];
  if (!node || node.type !== "table") throw new Error("no table node");
  strictEqual(node.tableType, "xy");
  deepStrictEqual(node.data!.columns, ["Title", "X", "X error", "A"]);
  deepStrictEqual(node.data!.rows, [
    ["A", "1.", "0.1", "10."],
    ["B", "2.", "0.2", "20."],
    ["C", "3.", "0.3", "30."],
  ]);
  // Row 1 is excluded in the X column (index 1) and the X error column
  // (index 2); the values stay visible, only their excluded state survives.
  deepStrictEqual(node.data!.excluded, ["1,1", "1,2"]);
});

check(".pzfx import keeps a struck-through date X value excluded in its date column (#20 follow-up)", () => {
  // Same drop as #20, one column over: the X-date path pushed the dates
  // with a fresh empty excluded set, so a struck-through date imported as
  // live text. The dates sit in their own column here (row titles exist),
  // so the marker must land on that column — row 1, col 2.
  const text = `<?xml version="1.0" encoding="UTF-8"?><GraphPadPrismFile PrismXMLVersion="5.00">
<Table ID="Table0" XFormat="date" YFormat="replicates" Replicates="1" TableType="XY" EVFormat="AsteriskAfterNumber">
<Title>Sample Data</Title>
<RowTitlesColumn Width="41"><Subcolumn><d>Sample A</d><d>Sample B</d><d>Sample C</d></Subcolumn></RowTitlesColumn>
<XColumn Width="114" Subcolumns="1" Decimals="14"><Title>Date X</Title>
<Subcolumn><d>0</d><d>5.22929500342231</d><d>8.12320328542094</d></Subcolumn>
</XColumn>
<XAdvancedColumn Version="1" Width="114" Decimals="0" Subcolumns="1"><Title>Date X</Title>
<Subcolumn><d>16-Jan-2004</d><d Excluded="1">9-Apr-2009</d><d>1-Mar-2012</d></Subcolumn>
</XAdvancedColumn>
<YColumn Width="89" Decimals="0" Subcolumns="1"><Title>Observation</Title><Subcolumn><d>120</d><d>64</d><d>46</d></Subcolumn></YColumn>
</Table>
</GraphPadPrismFile>`;
  const imported = parsePzfx(text);
  strictEqual(imported.tables.length, 1);
  const node = imported.project.nodes[imported.project.rootOrder[0]];
  if (!node || node.type !== "table") throw new Error("no table node");
  deepStrictEqual(node.data!.columns, ["Title", "Date X", "Date X (date)", "Observation"]);
  deepStrictEqual(node.data!.rows[1], ["Sample B", "5.22929500342231", "9-Apr-2009", "64"]);
  deepStrictEqual(node.data!.excluded, ["1,2"]);
});

check(".pzfx import names summary subcolumns and warns they aren't replicates", () => {
  const { imported, table } = importedTable("column_sdn");
  strictEqual(table.tableType, "column");
  deepStrictEqual(table.data!.columns, ["Title", "A_MEAN", "A_SD", "A_N", "B_MEAN", "B_SD", "B_N"]);
  deepStrictEqual(table.data!.rows[0], [null, "100", "10", "2", "10", "1", "10"]);
  ok(imported.issues.some((i) => i.message.includes("not raw replicates")), "warns about summaries");
});

check(".pzfx import never assumes an empty YFormat means replicates (FF-F7)", () => {
  // twoway_empty_yformat.pzfx is the column_sdn.pzfx table (TwoWay, 3
  // mean/SD/N-shaped subcolumns per group) with YFormat blanked. Before the
  // fix it imported as a grouped table (groups 2, replicates 3) with no
  // warning, so a group comparison would treat the means as raw replicates.
  const { imported, table } = importedTable("twoway_empty_yformat");
  strictEqual(table.tableType, "column");
  strictEqual(table.data!.groups, undefined);
  strictEqual(table.data!.replicates, undefined);
  deepStrictEqual(table.data!.columns, ["Title", "A_1", "A_2", "A_3", "B_1", "B_2", "B_3"]);
  deepStrictEqual(table.data!.rows[0], ["Low", "100", "10", "2", "10", "1", "10"]);
  ok(
    imported.issues.some((i) => i.message.includes("empty YFormat") && i.message.includes("not replicates")),
    "warns the Y format wasn't recorded and the subcolumns aren't replicates",
  );
});

check(".pzfx import reads '1,000' as 1000 in a dot-decimal file — and keeps a comma decimal a decimal (FF-F8)", () => {
  // The fixture is a dot-decimal file ("1.5", "2.5" prove the decimal
  // separator is "."), so "1,000" can only be a thousands separator: reading
  // it as 1.000 would be a 1000x error. The guard leg is a comma-decimal
  // file ("7,5" proves the separator is ","): there "1,875" is 1.875, as in
  // the real SaturationBinding.pzfx — the two readings are told apart by the
  // file, never by the string alone.
  const { table } = importedTable("column_thousands");
  deepStrictEqual(table.data!.columns, ["Title", "Aa"]);
  deepStrictEqual(table.data!.rows, [
    [null, "1.5"],
    [null, "1000"],
    [null, "2.5"],
  ]);
  const commaDecimal = parsePzfx(
    `<?xml version="1.0" encoding="UTF-8"?><GraphPadPrismFile PrismXMLVersion="5.00">` +
      `<Table ID="Table0" XFormat="none" TableType="OneWay" EVFormat="AsteriskAfterNumber">` +
      `<Title>Data 1</Title>` +
      `<YColumn Width="89" Decimals="0" Subcolumns="1"><Title>Aa</Title><Subcolumn>` +
      `<d>1,875</d><d>7,5</d>` +
      `</Subcolumn></YColumn></Table></GraphPadPrismFile>`,
  );
  strictEqual(commaDecimal.tables.length, 1, "comma-decimal table imports");
  const commaNode = commaDecimal.project.nodes[commaDecimal.project.rootOrder[0]];
  if (!commaNode || commaNode.type !== "table") throw new Error("comma-decimal: no table node");
  deepStrictEqual(commaNode.data!.rows, [
    [null, "1.875"],
    [null, "7.5"],
  ]);
});

check(".pzfx import dedupes duplicate column names so the second keeps its own data", () => {
  // Two Y columns both titled "Control", plus a third already titled
  // "Control 2" and a third "Control" — the rename must skip names that
  // are already taken, and each column must keep its own values.
  const text = `<?xml version="1.0" encoding="UTF-8"?><GraphPadPrismFile PrismXMLVersion="5.00">
<Table ID="Table0" XFormat="none" TableType="OneWay">
<Title>Data 1</Title>
<YColumn Width="89" Decimals="0" Subcolumns="1"><Title>Control</Title><Subcolumn><d>1.</d><d>2.</d></Subcolumn></YColumn>
<YColumn Width="89" Decimals="0" Subcolumns="1"><Title>Control</Title><Subcolumn><d>10.</d><d>20.</d></Subcolumn></YColumn>
<YColumn Width="89" Decimals="0" Subcolumns="1"><Title>Control 2</Title><Subcolumn><d>100.</d><d>200.</d></Subcolumn></YColumn>
<YColumn Width="89" Decimals="0" Subcolumns="1"><Title>Control</Title><Subcolumn><d>1000.</d><d>2000.</d></Subcolumn></YColumn>
</Table>
</GraphPadPrismFile>`;
  const imported = parsePzfx(text);
  strictEqual(imported.tables.length, 1);
  const node = imported.project.nodes[imported.project.rootOrder[0]];
  if (!node || node.type !== "table") throw new Error("no table node");
  deepStrictEqual(node.data!.columns, ["Title", "Control", "Control 2", "Control 3", "Control 4"]);
  // The renamed columns still carry their own data: a lookup by name
  // (data.columns.indexOf) now lands on the intended column, not the first.
  deepStrictEqual(node.data!.rows, [
    [null, "1.", "10.", "100.", "1000."],
    [null, "2.", "20.", "200.", "2000."],
  ]);
  const renamed = node.data!.columns.indexOf("Control 2");
  strictEqual(node.data!.rows[0][renamed], "10.");
  ok(imported.issues.some((i) => i.message.includes("duplicate column names were renamed")), "warns about the rename");
});

check(".pzfx import keeps untitled, colon-titled and ragged TwoWay replicate groups through a save/reload round-trip", () => {
  // Two untitled Y columns, one titled "1:10", one ragged (1 of 2
  // subcolumns). Before the fix all three legs lost data on reload: the
  // untitled groups merged into "Group" (FF-F9 renamed the duplicate to
  // "Group:Y1 2", which the reload's regroupTable then dropped), "1:10:Y1"
  // split at the first ":" into group "1", and the ragged group was short
  // a subcolumn.
  const text = `<?xml version="1.0" encoding="UTF-8"?><GraphPadPrismFile PrismXMLVersion="5.00">
<Table ID="Table0" XFormat="none" TableType="TwoWay" YFormat="replicates">
<Title>TwoWay reps</Title>
<RowTitlesColumn Width="89"><Subcolumn><d>Low</d><d>High</d></Subcolumn></RowTitlesColumn>
<YColumn Width="89" Decimals="0" Subcolumns="2"><Subcolumn><d>1.</d><d>2.</d></Subcolumn><Subcolumn><d>3.</d><d>4.</d></Subcolumn></YColumn>
<YColumn Width="89" Decimals="0" Subcolumns="2"><Subcolumn><d>10.</d><d>20.</d></Subcolumn><Subcolumn><d>30.</d><d>40.</d></Subcolumn></YColumn>
<YColumn Width="89" Decimals="0" Subcolumns="2"><Title>1:10</Title><Subcolumn><d>100.</d><d>200.</d></Subcolumn><Subcolumn><d>300.</d><d>400.</d></Subcolumn></YColumn>
<YColumn Width="89" Decimals="0" Subcolumns="1"><Title>Ragged</Title><Subcolumn><d>1000.</d><d>2000.</d></Subcolumn></YColumn>
</Table>
</GraphPadPrismFile>`;
  const imported = parsePzfx(text);
  strictEqual(imported.tables.length, 1);
  const node = imported.project.nodes[imported.project.rootOrder[0]];
  if (!node || node.type !== "table") throw new Error("no table node");
  strictEqual(node.tableType, "grouped");
  strictEqual(node.data!.groups, 4);
  strictEqual(node.data!.replicates, 2);
  deepStrictEqual(node.data!.columns, [
    "Title",
    "Group:Y1",
    "Group:Y2",
    "Group 2:Y1",
    "Group 2:Y2",
    "1-10:Y1",
    "1-10:Y2",
    "Ragged:Y1",
    "Ragged:Y2",
  ]);
  deepStrictEqual(node.data!.rows, [
    ["Low", "1.", "3.", "10.", "30.", "100.", "300.", "1000.", null],
    ["High", "2.", "4.", "20.", "40.", "200.", "400.", "2000.", null],
  ]);
  ok(imported.issues.some((i) => i.message.includes("group names must be unique")), "warns about the renames");
  // The round-trip is the point: save as .hlx, reload, every value still there.
  const { project } = read(serializeProjectFile(imported.project));
  const reloaded = project.nodes[imported.project.rootOrder[0]];
  if (!reloaded || reloaded.type !== "table") throw new Error("no reloaded table node");
  deepStrictEqual(reloaded.data!.columns, node.data!.columns);
  deepStrictEqual(reloaded.data!.rows, node.data!.rows);
  strictEqual(reloaded.data!.groups, 4);
  strictEqual(reloaded.data!.replicates, 2);
});

check(".pzfx import refuses files that aren't .pzfx", () => {
  for (const text of ["hello", "<GraphPadPrismFile></GraphPadPrismFile>", "<Other><Table/></Other>"]) {
    const imported = parsePzfx(text);
    strictEqual(imported.tables.length, 0);
    ok(imported.issues.some((i) => i.severity === "error"), text);
  }
});

check("an imported project round-trips through the .hlx format", () => {
  const { imported } = importedTable("column");
  const serialized = serializeProjectFile(imported.project);
  const reparsed = parseProjectFile(JSON.parse(serialized));
  if ("error" in reparsed) throw new Error(reparsed.error);
  const node = reparsed.project.nodes[reparsed.project.rootOrder[0]];
  if (!node || node.type !== "table") throw new Error("no table after round-trip");
  deepStrictEqual(node.data!.columns, ["Title", "Aa", "Bb"]);
  deepStrictEqual(node.data!.rows, [
    [null, "1.", "100."],
    [null, "2.", "90."],
    [null, "3.", "80."],
    [null, "4.", "70."],
  ]);
});

// ── Survival (log-rank) ────────────────────────────────────────────────
// Expected numbers were computed independently in Python (first-principles
// O−E/V plus scipy's chi-square tail), not from this code.

const logRankTable = (columns: string[], rows: (string | null)[][]): TableData => ({
  columns,
  rows: rows.map((row) => row.map((cell) => cell ?? null)),
});

check("the survival analysis matches the independent Python computation", async () => {
  const data = logRankTable(
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
  const out = await runAnalysis("survival", data, { curveTest: "logrank", correction: "holm" });
  if ("error" in out) throw new Error(out.error);
  const stat = (label: string) => out.stats.find((s) => s.label === label)?.value;
  close(stat("Chi-square"), 0.528, 1e-3, "chi-square");
  strictEqual(stat("df"), 1);
  close(stat("P value"), 0.4674, 1e-3, "P value");
  deepStrictEqual(
    out.survivalGroups!.map((g) => [g.group, g.median, g.subjects]),
    [
      ["Treated", 15, 5],
      ["Placebo", 8, 5],
    ],
  );
});

check("the survival analysis handles three groups", async () => {
  const data = logRankTable(
    ["Title", "Days", "A", "B", "C"],
    [
      ["", "4", "1", "", ""],
      ["", "6", "1", "", ""],
      ["", "8", "0", "", ""],
      ["", "10", "1", "", ""],
      ["", "12", "0", "", ""],
      ["", "3", "", "1", ""],
      ["", "5", "", "1", ""],
      ["", "7", "", "1", ""],
      ["", "9", "", "0", ""],
      ["", "11", "", "1", ""],
      ["", "6", "", "", "1"],
      ["", "9", "", "", "1"],
      ["", "12", "", "", "1"],
      ["", "15", "", "", "0"],
      ["", "18", "", "", "1"],
    ],
  );
  const out = await runAnalysis("survival", data, { curveTest: "logrank", correction: "holm" });
  if ("error" in out) throw new Error(out.error);
  const stat = (label: string) => out.stats.find((s) => s.label === label)?.value;
  close(stat("Chi-square"), 1.9194, 1e-3, "chi-square");
  strictEqual(stat("df"), 2);
  close(stat("P value"), 0.383, 1e-3, "P value");
  deepStrictEqual(
    out.survivalGroups!.map((g) => [g.group, g.median]),
    [
      ["A", 10],
      ["B", 7],
      ["C", 12],
    ],
  );
});

check("the survival analysis refuses bad survival data", async () => {
  const cases: [TableData, string][] = [
    // A code that isn't 0 or 1.
    [logRankTable(["Title", "Days", "A", "B"], [["", "3", "2", "1"]]), "enter 1 for an event, 0 for a censored subject"],
    // Only one group with data.
    [logRankTable(["Title", "Days", "A", "B"], [["", "3", "1", ""]]), "at least 2 groups holding subjects"],
  ];
  for (const [data, message] of cases) {
    const out = await runAnalysis("survival", data, { curveTest: "logrank", correction: "holm" });
    if (!("error" in out) || !out.error.includes(message)) {
      throw new Error(`expected an error mentioning "${message}", got ${JSON.stringify(out)}`);
    }
  }
});

check("the survival analysis and Cox refuse a table with no events at all", async () => {
  // All subjects censored: the log-rank path used to return a meaningless
  // chi-square of 0 (P = 1), the Gehan path crashed in solve() on a singular
  // matrix, and Cox crashed subscripting cox.zph's empty table.
  const data = logRankTable(
    ["Title", "Days", "A", "B"],
    [
      ["", "3", "0", ""],
      ["", "5", "0", ""],
      ["", "7", "", "0"],
      ["", "8", "", "0"],
      ["", "10", "0", ""],
      ["", "12", "", "0"],
    ],
  );
  for (const curveTest of ["logrank", "gehan"] as const) {
    const out = await runAnalysis("survival", data, { curveTest, correction: "holm" });
    if (!("error" in out) || !out.error.includes("No events")) {
      throw new Error(`survival/${curveTest}: expected a "No events" error, got ${JSON.stringify(out).slice(0, 300)}`);
    }
  }
  const cox = await runAnalysis("cox", data, {});
  if (!("error" in cox) || !cox.error.includes("No events")) {
    throw new Error(`cox: expected a "No events" error, got ${JSON.stringify(cox).slice(0, 300)}`);
  }
});

check("a pairwise Gehan comparison with no events returns NA, not a crash", async () => {
  // Only group C holds events, so the A–B pair has none: its Gehan test used
  // to crash in solve() on a singular matrix and abort the whole analysis.
  const data = logRankTable(
    ["Title", "Days", "A", "B", "C"],
    [
      ["", "3", "0", "", ""],
      ["", "5", "0", "", ""],
      ["", "7", "", "0", ""],
      ["", "8", "", "0", ""],
      ["", "4", "", "", "1"],
      ["", "6", "", "", "1"],
      ["", "9", "", "", "0"],
    ],
  );
  const out = await runAnalysis("survival", data, { curveTest: "gehan", correction: "holm" });
  if ("error" in out) throw new Error(out.error);
  strictEqual(out.comparisons![0].p, null, "the event-less A–B pair is open");
  ok(out.comparisons![1].p !== null && out.comparisons![2].p !== null, "pairs with events still complete");
  ok(out.stats.find((s) => s.label === "Chi-square")?.value !== null, "the overall Gehan test still runs");
});

check("Cox regression leaves the proportional-hazards P open when a group is never at risk at an event time", async () => {
  // Group B's subjects are all censored before A's first event: cox.zph
  // used to crash subscripting its table and abort the whole regression.
  const data = logRankTable(
    ["Title", "Days", "A", "B"],
    [
      ["", "10", "1", ""],
      ["", "12", "1", ""],
      ["", "15", "0", ""],
      ["", "1", "", "0"],
      ["", "2", "", "0"],
      ["", "2", "", "0"],
    ],
  );
  const out = await runAnalysis("cox", data, {});
  if ("error" in out) throw new Error(out.error);
  strictEqual(
    out.stats.find((s) => s.label === "Proportional hazards test P")?.value,
    null,
    "cox.zph could not run on this fit",
  );
  strictEqual(out.hazardRatios?.length, 1, "one hazard ratio still reported");
});

check("frequency bins are left-closed with the last bin closed, and empty bins stay", () => {
  // On-edge values go into the bin above them; the maximum stays in the last bin.
  deepStrictEqual(
    computeFrequencyBins([2, 4, 6, 8], { binMode: "width", binWidth: 2, startAt: 2 }).bins.map((b) => b.count),
    [1, 1, 2],
  );
  // A gap leaves zero-count bins in place.
  deepStrictEqual(
    computeFrequencyBins([1, 2, 9, 10], { binMode: "width", binWidth: 2, startAt: 0 }).bins.map((b) => b.count),
    [1, 1, 0, 0, 2],
  );
  // Relative and cumulative frequencies sum to 1.
  const { bins } = computeFrequencyBins([2.1, 3.5, 3.9, 4.2, 5, 5.8, 6.1, 7.4, 8, 9.3], {
    binMode: "width",
    binWidth: 2,
    startAt: 2,
  });
  deepStrictEqual(
    bins.map((b) => [b.count, b.relativeFrequency, b.cumulativeCount, b.cumulativeFrequency]),
    [
      [3, 0.3, 3, 0.3],
      [3, 0.3, 6, 0.6],
      [2, 0.2, 8, 0.8],
      [2, 0.2, 10, 1],
    ],
  );
});

check("frequency bins put a value exactly on an edge into the bin above it, not below", () => {
  // (0.3 - 0.1) / 0.1 is 1.9999999999999998 in doubles, so Math.floor alone
  // bins 0.3 into "0.2 to <0.3"; the index is nudged against the actual
  // edges until the value lies inside its bin.
  const { bins } = computeFrequencyBins([0.1, 0.3, 0.5], { binMode: "auto" });
  deepStrictEqual(
    bins.map((b) => [b.bin, b.count]),
    [
      ["0.1 to <0.2", 1],
      ["0.2 to <0.3", 0],
      ["0.3 to <0.4", 1],
      ["0.4 to 0.5", 1],
    ],
  );
});

check("pretty breaks stay distinct at large magnitudes instead of collapsing to NaN counts", () => {
  // toPrecision(12) rounded both ends of [1e9, 1e9+0.0005] to the same
  // value, collapsing start === end and producing NaN counts.
  deepStrictEqual(prettyBreaks(1e9, 1e9 + 0.0005, 5), [
    1000000000, 1000000000.0001, 1000000000.0002, 1000000000.0003, 1000000000.0004, 1000000000.0005,
  ]);
  const { bins } = computeFrequencyBins([1e9, 1e9 + 0.0005], { binMode: "auto" });
  deepStrictEqual(
    bins.map((b) => b.count),
    [1, 0, 1],
  );
  ok(bins.every((b) => Number.isFinite(b.count) && Number.isFinite(b.relativeFrequency)));
});

check("width-mode binning terminates when the width is below the rounding resolution at 1e9", () => {
  // clean(1e9 + 0.0002) rounded back to 1e9, so the old repeated-addition
  // loop pushed 1e9 forever (OOM/hang). Edges are built by index now, so
  // this returns 5,000 bins in milliseconds.
  const { bins, edges } = computeFrequencyBins([1e9, 1e9 + 1], { binMode: "width", binWidth: 0.0002 });
  strictEqual(bins.length, 5000);
  strictEqual(edges.length, 5001);
  strictEqual(edges[0], 1e9);
  strictEqual(edges.at(-1), 1e9 + 1);
  deepStrictEqual(
    bins.map((b) => b.count).filter((c) => c > 0),
    [1, 1],
  );
  strictEqual(
    bins.reduce((s, b) => s + b.count, 0),
    2,
  );
});

check("a constant column bins into one bin, and bad binning is an error, not a crash", async () => {
  const table = (values: (number | string)[]): TableData => ({
    columns: ["Title", "V"],
    rows: values.map((v) => [null, String(v)]),
  });
  const one = await runAnalysis("frequency-distribution", table([5, 5, 5]), { binMode: "auto" });
  if ("error" in one) throw new Error(one.error);
  deepStrictEqual(
    one.frequencyBins?.[0].bins.map((b) => [b.lower, b.upper, b.count]),
    [[5, 5, 3]],
  );
  for (const [params, message] of [
    [{ binMode: "width", binWidth: 0, startAt: 2 }, "greater than 0"],
    [{ binMode: "width", binWidth: -1, startAt: 2 }, "greater than 0"],
    [{ binMode: "count", binCount: 1, startAt: 2 }, "at least 2"],
    [{ binMode: "count", binCount: 2.5, startAt: 2 }, "at least 2"],
  ] as const) {
    const out = await runAnalysis("frequency-distribution", table([1, 2, 3]), params);
    if (!("error" in out) || !out.error.includes(message))
      throw new Error(`expected an error mentioning "${message}", got ${JSON.stringify(out)}`);
  }
  const few = await runAnalysis("frequency-distribution", table([5]), { binMode: "auto" });
  if (!("error" in few) || !few.error.includes("at least 2 values"))
    throw new Error(`expected the too-few-values error, got ${JSON.stringify(few)}`);
});

check("Sturges, pretty breaks and nice widths match R's rules", () => {
  strictEqual(sturgesCount(10), 5);
  strictEqual(sturgesCount(2), 2);
  // pretty() may return fewer intervals than asked for: 4, not 5, on 2.1–9.3.
  deepStrictEqual(prettyBreaks(2.1, 9.3, 5), [2, 4, 6, 8, 10]);
  deepStrictEqual(prettyBreaks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
  deepStrictEqual(prettyBreaks(123, 456, 5), [100, 150, 200, 250, 300, 350, 400, 450, 500]);
  // A ratio a hair from a whole number counts as that number (0.3 / 0.1).
  deepStrictEqual(prettyBreaks(0.3, 0.9, 5), [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
  strictEqual(niceWidthUp(1.44), 2);
  strictEqual(niceWidthUp(2), 2);
  strictEqual(niceWidthUp(2.01), 5);
  strictEqual(niceWidthUp(0.06), 0.1);
});

// ── Simulate data + Monte Carlo (plan 22) ───────────────────────────────

check("simulationRCode draws each distribution from the right R call", () => {
  const code = (spec: SimulationSpec) => simulationRCode(spec);
  strictEqual(code({ distribution: "gaussian", mean: 0, sd: 1, n: 20, datasets: 1, seed: 42, tableType: "column" }), "set.seed(42);rnorm(20,0,1)");
  strictEqual(code({ distribution: "uniform", min: 0, max: 1, n: 20, datasets: 1, seed: 42, tableType: "column" }), "set.seed(42);runif(20,0,1)");
  strictEqual(code({ distribution: "exponential", rate: 2, n: 20, datasets: 1, seed: 42, tableType: "column" }), "set.seed(42);rexp(20,2)");
  strictEqual(
    code({ distribution: "binomial", size: 10, prob: 0.5, n: 20, datasets: 1, seed: 42, tableType: "column" }),
    "set.seed(42);rbinom(20,10,0.5)",
  );
  strictEqual(code({ distribution: "poisson", lambda: 3, n: 20, datasets: 1, seed: 42, tableType: "column" }), "set.seed(42);rpois(20,3)");
  strictEqual(
    code({ distribution: "lognormal", meanlog: 0, sdlog: 0.5, n: 20, datasets: 1, seed: 42, tableType: "column" }),
    "set.seed(42);rlnorm(20,0,0.5)",
  );
  // Two datasets are one draw of n × datasets values, in dataset order.
  strictEqual(code({ distribution: "gaussian", mean: 0, sd: 1, n: 3, datasets: 2, seed: 7, tableType: "column" }), "set.seed(7);rnorm(6,0,1)");
});

check("validateSimulationSpec rejects a bad spec, and accepts a good one", () => {
  const good: SimulationSpec = { distribution: "gaussian", mean: 0, sd: 1, n: 20, datasets: 1, seed: 42, tableType: "column" };
  strictEqual(validateSimulationSpec(good), undefined);
  for (const [spec, message] of [
    [{ ...good, sd: 0 }, "greater than 0"],
    [{ ...good, sd: -1 }, "greater than 0"],
    [{ ...good, n: 1 }, "at least 2"],
    [{ ...good, n: 2.5 }, "whole number"],
    [{ ...good, datasets: 0 }, "at least 1"],
    [{ ...good, seed: 1.5 }, "whole number"],
    [{ ...good, distribution: "uniform", min: 2, max: 1 }, "less than the maximum"],
    [{ ...good, distribution: "binomial", size: 0, prob: 0.5 }, "number of trials"],
    [{ ...good, distribution: "binomial", size: 10, prob: 1.5 }, "between 0 and 1"],
    [{ ...good, distribution: "poisson", lambda: 0 }, "greater than 0"],
    [{ ...good, distribution: "lognormal", meanlog: 0, sdlog: 0 }, "greater than 0"],
    [{ ...good, n: 200_000, datasets: 1 }, "at most 100000"],
  ] as const) {
    const error = validateSimulationSpec(spec as SimulationSpec);
    if (!error || !error.includes(message))
      throw new Error(`expected an error mentioning "${message}", got ${JSON.stringify(error)}`);
  }
});

check("monteCarloRCode repeats the target inside R and returns the observed value first", () => {
  const twoGroups = {
    target: "compare-two-groups" as const,
    statistic: "P value" as const,
    repeats: 1000,
    seed: 42,
    groups: [
      { n: 3, mean: 0, sd: 1, observed: [1, 2, 3] },
      { n: 3, mean: 0.5, sd: 1, observed: [4, 5, 6] },
    ],
    equalVariance: true,
  };
  strictEqual(
    monteCarloRCode(twoGroups),
    "set.seed(42);v<-replicate(1000,t.test(rnorm(3,0,1),rnorm(3,0.5,1),var.equal=TRUE)$p.value);o<-t.test(c(1,2,3),c(4,5,6),var.equal=TRUE)$p.value;c(o,v)",
  );
  strictEqual(
    monteCarloRCode({ ...twoGroups, statistic: "Mean difference" }),
    "set.seed(42);v<-replicate(1000,mean(rnorm(3,0,1))-mean(rnorm(3,0.5,1)));o<-mean(c(1,2,3))-mean(c(4,5,6));c(o,v)",
  );
  strictEqual(
    monteCarloRCode({
      target: "one-sample-t",
      statistic: "P value",
      repeats: 1000,
      seed: 42,
      groups: [{ n: 3, mean: 5, sd: 2, observed: [1, 2, 3] }],
      hypotheticalValue: 0,
    }),
    "set.seed(42);v<-replicate(1000,t.test(rnorm(3,5,2),mu=0)$p.value);o<-t.test(c(1,2,3),mu=0)$p.value;c(o,v)",
  );
  strictEqual(
    monteCarloRCode({
      target: "descriptive-statistics",
      statistic: "Mean",
      repeats: 1000,
      seed: 42,
      groups: [{ n: 3, mean: 5, sd: 2, observed: [1, 2, 3] }],
    }),
    "set.seed(42);v<-replicate(1000,mean(rnorm(3,5,2)));o<-mean(c(1,2,3));c(o,v)",
  );
  strictEqual(
    monteCarloRCode({
      target: "linear-regression",
      statistic: "Slope",
      repeats: 100,
      seed: 42,
      groups: [{ n: 4, mean: 5, sd: 2, observed: [2, 4, 6, 8] }],
      x: [1, 2, 3, 4],
    }),
    "set.seed(42);x<-c(1,2,3,4);v<-replicate(100,coef(lm(rnorm(4,5,2)~x))[2]);o<-coef(lm(c(2,4,6,8)~x))[2];c(o,v)",
  );
  strictEqual(
    monteCarloRCode({
      target: "correlation",
      statistic: "r",
      repeats: 100,
      seed: 42,
      groups: [{ n: 4, mean: 5, sd: 2, observed: [2, 4, 6, 8] }],
      x: [1, 2, 3, 4],
      method: "spearman",
    }),
    'set.seed(42);x<-c(1,2,3,4);v<-replicate(100,cor(x,rnorm(4,5,2),method="spearman"));o<-cor(x,c(2,4,6,8),method="spearman");c(o,v)',
  );
});

check("percentile interpolates R-style (type 7)", () => {
  strictEqual(percentile([0, 10], 0.5), 5);
  strictEqual(percentile([0, 10], 0.025), 0.25);
  strictEqual(percentile([0, 10], 0.975), 9.75);
  strictEqual(percentile([5], 0.5), 5);
  strictEqual(percentile([1, 2, 3], 0.5), 2); // input must already be sorted
});

check("the Monte Carlo wizard asks for the target, the simulation and the repeats", () => {
  const table = readTable({
    columns: ["Title", "A", "B"],
    rows: [
      ["", "1", "4"],
      ["", "2", "5"],
      ["", "3", "6"],
    ],
  });
  const wizard = WIZARDS["monte-carlo"]!;
  deepStrictEqual(
    wizard.questions({}, table, "column").filter(Boolean).map((q) => (q as Question).id),
    ["target", "statistic", "equalVariance", "mean:A", "sd:A", "mean:B", "sd:B", "repeats", "seed"],
  );
  deepStrictEqual(
    wizard
      .questions({ target: "compare-two-groups" }, table, "column")
      .filter(Boolean)
      .map((q) => (q as Question).id),
    ["target", "statistic", "equalVariance", "mean:A", "sd:A", "mean:B", "sd:B", "repeats", "seed"],
  );
  deepStrictEqual(
    wizard
      .questions({ target: "descriptive-statistics" }, table, "column")
      .filter(Boolean)
      .map((q) => (q as Question).id),
    ["target", "group", "mean:A", "sd:A", "repeats", "seed"],
  );
  deepStrictEqual(
    wizard.finish(
      {
        target: "compare-two-groups",
        statistic: "P value",
        equalVariance: "yes",
        "mean:A": 0,
        "sd:A": 1,
        "mean:B": 0.5,
        "sd:B": 1,
        repeats: 1000,
        seed: 42,
      },
      table,
      "column",
    ),
    {
      type: "monte-carlo",
      params: {
        targetAnalysis: "compare-two-groups",
        summaryStatistic: "P value",
        repeats: 1000,
        seed: 42,
        groupMeans: { A: 0, B: 0.5 },
        groupSds: { A: 1, B: 1 },
        equalVariance: true,
      },
    },
  );
  // An XY table offers only the XY targets, and the finish carries the Y name.
  const xy = readTable({
    columns: ["Title", "X", "Y1"],
    rows: [
      ["", "1", "2"],
      ["", "2", "4"],
      ["", "3", "6"],
      ["", "4", "8"],
    ],
  });
  deepStrictEqual(
    wizard.questions({}, xy, "xy").filter(Boolean).map((q) => (q as Question).id),
    ["target", "statistic", "y", "mean:Y1", "sd:Y1", "repeats", "seed"],
  );
  deepStrictEqual(
    wizard.finish(
      { target: "linear-regression", statistic: "Slope", y: "Y1", "mean:Y1": 5, "sd:Y1": 2, repeats: 100, seed: 7 },
      xy,
      "xy",
    ),
    {
      type: "monte-carlo",
      params: {
        targetAnalysis: "linear-regression",
        summaryStatistic: "Slope",
        repeats: 100,
        seed: 7,
        groupMeans: { Y1: 5 },
        groupSds: { Y1: 2 },
        y: "Y1",
      },
    },
  );
});

check("Monte Carlo is offered on column and XY tables only, with its histogram graph", () => {
  const two: TableData = {
    columns: ["Title", "A", "B"],
    rows: [["", "1", "4"]],
  };
  ok(analysisOptionsForTable("column", two).some((o) => o.value === "monte-carlo"));
  ok(analysisOptionsForTable("xy", two).some((o) => o.value === "monte-carlo"));
  ok(!analysisOptionsForTable("grouped", two).some((o) => o.value === "monte-carlo"));
  for (const tableType of ["column", "xy"] as const)
    ok(GRAPH_OPTIONS_BY_TABLE[tableType].some((o) => o.value === "monte-carlo-histogram"));
  ok(!GRAPH_OPTIONS_BY_TABLE.grouped.some((o) => o.value === "monte-carlo-histogram"));
});

// BUG-REPORT #28 leg 4: a Monte Carlo repeat of a regression/correlation
// with all X values identical failed only with the generic "did not return
// the expected values" error (lm()/cor() return NA on a constant X). The
// guard names the constant X — and a varying X still runs.
check("Monte Carlo names a constant X instead of the generic failure", async () => {
  const constX: TableData = {
    columns: ["Title", "X", "Y1"],
    rows: [
      ["", "5", "2"],
      ["", "5", "4"],
      ["", "5", "6"],
      ["", "5", "8"],
    ],
  };
  for (const [target, statistic] of [
    ["linear-regression", "Slope"],
    ["correlation", "r"],
  ] as const) {
    const out = await runAnalysis("monte-carlo", constX, {
      targetAnalysis: target,
      summaryStatistic: statistic,
      repeats: 100,
      seed: 42,
    } as AnalysisParams);
    if (!("error" in out)) throw new Error(`expected a constant-X error for ${target}`);
    ok(
      out.error.includes("at least 2 different X values") && out.error.includes("all X values are the same"),
      out.error,
    );
  }
  // A varying X still runs (same table with X 1–4).
  const varyingX: TableData = {
    columns: ["Title", "X", "Y1"],
    rows: [
      ["", "1", "2"],
      ["", "2", "4"],
      ["", "3", "6"],
      ["", "4", "8"],
    ],
  };
  const mc = await runAnalysis("monte-carlo", varyingX, {
    targetAnalysis: "linear-regression",
    summaryStatistic: "Slope",
    repeats: 100,
    seed: 42,
  });
  if ("error" in mc) throw new Error(mc.error);
  strictEqual(mc.monteCarlo?.repeats, 100);
  close(mc.monteCarlo?.mean, 0.0728, 1e-3, "mean slope over repeats");
  strictEqual(mc.monteCarlo?.observed, 2);
});

check("a Monte Carlo analysis, its histogram and a simulated table survive a file round-trip", () => {
  const mcPayload: ProjectFilePayload = {
    nodes: {
      t1: {
        id: "t1",
        type: "table",
        name: "Table 1",
        parentId: null,
        tableType: "column",
        data: {
          columns: ["Title", "A", "B"],
          rows: [["r1", "1", "2"]],
          notes: "Simulated data: Gaussian (mean 0, SD 1), n = 20 × 1 dataset, seed 42. Same seed + same settings reproduce this table exactly.",
        },
      },
      a1: {
        id: "a1",
        type: "analysis",
        name: "Monte Carlo simulation",
        parentId: "t1",
        analysisType: "monte-carlo",
        analysisParams: {
          targetAnalysis: "compare-two-groups",
          summaryStatistic: "P value",
          repeats: 1000,
          seed: 42,
          groupMeans: { A: 0, B: 0.5 },
          groupSds: { A: 1, B: 1 },
          equalVariance: true,
        },
      },
      g1: {
        id: "g1",
        type: "graph",
        name: "Monte Carlo histogram",
        parentId: "t1",
        graphType: "monte-carlo-histogram",
        graphOptions: { ...newGraphOptions("monte-carlo-histogram"), monteCarloAnalysisId: "a1" },
      },
    },
    rootOrder: ["t1"],
    childOrder: { t1: ["a1", "g1"] },
    activeNodeId: "t1",
  };
  const { project, issues } = read(serializeProjectFile(mcPayload));
  deepStrictEqual(project, mcPayload);
  deepStrictEqual(issues, []);
});

check("renaming a column renames its Monte Carlo group means and SDs", () => {
  const params: MonteCarloParams = {
    targetAnalysis: "compare-two-groups",
    summaryStatistic: "P value",
    repeats: 1000,
    seed: 42,
    groupMeans: { A: 0, B: 0.5 },
    groupSds: { A: 1, B: 1 },
    equalVariance: true,
  };
  const mc = { ...analysis, analysisType: "monte-carlo" as const, analysisParams: params };
  deepStrictEqual(
    followTable(mc, { renamed: { A: "Control", B: "Treated" } }, []).analysisParams,
    {
      ...params,
      groupMeans: { Control: 0, Treated: 0.5 },
      groupSds: { Control: 1, Treated: 1 },
    },
  );
  // A key the rename doesn't mention is left alone.
  deepStrictEqual(
    (followTable(mc, { renamed: { A: "Control" } }, []).analysisParams as typeof params).groupMeans,
    { Control: 0, B: 0.5 },
  );
});

check("the Monte Carlo histogram draws the bins, shades P < 0.05 and marks the observed value", () => {
  const fake = (statistic: string, observed: number): AnalysisResult => ({
    testType: "monte-carlo",
    stats: [],
    groups: [],
    notes: "",
    monteCarlo: {
      repeats: 100,
      statistic,
      mean: 0.5,
      sd: 0.2,
      ciLow: 0.1,
      ciHigh: 0.9,
      proportionSignificant: 0.8,
      observed,
      bins: { edges: [0, 0.25, 0.5, 0.75, 1], counts: [10, 30, 40, 20] },
    },
  });
  const options = newGraphOptions("monte-carlo-histogram");
  const paint = paintOf(options, 1);
  const fig = GRAPHS["monte-carlo-histogram"].build([], options, paint);
  addMonteCarloHistogram(fig, fake("P value", 0.03), paint);
  const [bars] = fig.data as { type: string; y: number[] }[];
  deepStrictEqual([bars.type, bars.y], ["bar", [10, 30, 40, 20]]);
  const shapes = fig.layout.shapes as { type: string }[];
  deepStrictEqual(
    shapes.map((s) => s.type),
    ["rect", "line"],
  );
  const annotations = fig.layout.annotations as { text: string }[];
  ok(annotations.some((a) => a.text === "Observed 0.03"));
  // A non-P statistic has no shaded region, only the observed line.
  const fig2 = GRAPHS["monte-carlo-histogram"].build([], options, paint);
  addMonteCarloHistogram(fig2, fake("Slope", 0.03), paint);
  deepStrictEqual((fig2.layout.shapes as { type: string }[]).map((s) => s.type), ["line"]);
});

// ── R2-M1: inhibitor concentration is parsed from the number next to a
// concentration unit, never a stray leading number ─────────────────────────
check("parseInhibitorConcentration takes the unit-adjacent number, not the first number", () => {
  // The finding: "Day 2 — 10 nM", "Exp 1: 5 nM" and "Replicate 1 50 nM"
  // used to parse as 2, 1 and 1 — a wrong-but-plausible [I] that silently
  // corrupted Ki, pA2, Kb and dose ratios.
  const cases: [string, number | undefined][] = [
    ["Day 2 — 10 nM", 10],
    ["Exp 1: 5 nM", 5],
    ["Replicate 1 50 nM", 50],
    ["10 nM", 10],
    ["I=5", 5],
    ["Control", undefined],
    ["0 nM", 0],
    ["10 nM Day 2", 10],
    ["1e-8 M", 1e-8],
    ["2.5 µM", 2.5],
    ["Day 2 — 10", 10],
    ["10 nM, 20 nM", undefined],
  ];
  for (const [title, want] of cases)
    strictEqual(parseInhibitorConcentration(title), want, `${JSON.stringify(title)} should parse as ${want}`);
});

// R2-B1: a hung R evaluation must not strand the run on "Running…" forever.
// The watchdog stops it with a clear error, the interrupt frees R (no engine
// restart — the message says nothing about one), and the next evaluation on
// the same engine works — that is the retry.
check("hung R eval times out, is interrupted, and retry works", async () => {
  const started = Date.now();
  await rejects(
    evalNamedVector("while(TRUE){}", { timeoutMs: 1_000, graceMs: 1_000 }),
    (err: unknown) =>
      err instanceof Error && /took longer than 1 second/.test(err.message) && !/restarted/.test(err.message),
  );
  const elapsed = Date.now() - started;
  ok(elapsed < 10_000, `hung eval took ${elapsed} ms to fail`);
  const v = await evalNamedVector("c(a=1)");
  deepStrictEqual(v, { a: 1 });
});

// R2-F14: the "Not sure" Shapiro-Wilk check must be cancellable while it
// runs — aborting its signal stops the in-flight R evaluation (the same
// `cancelActiveEvals` the analysis view's Cancel button uses) and the check
// resolves null with no verdict/error alert, so the wizard returns to the
// question instead of stranding the user until the 5-minute eval watchdog.
// `alert` is a native dialog in the app; under tsx there is no `window`, so
// the check records it through a stubbed `window.alert` instead.
check("cancelling the Shapiro-Wilk check stops R and reports nothing", async () => {
  const alerts: string[] = [];
  const prevWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { alert: (msg: string) => alerts.push(msg) };
  try {
    // A pre-aborted signal never starts the run — and shows no alert.
    // (The first column is the row-title column: data starts at "A".)
    const table: TableData = {
      columns: ["Title", "A"],
      rows: [["", "1"], ["", "2"], ["", "3"], ["", "4"], ["", "5"], ["", "6"], ["", "7"], ["", "8"]],
    };
    strictEqual(await checkNormality(table, undefined, { signal: AbortSignal.abort() }), null);
    strictEqual(alerts.length, 0, `expected no alert, got ${JSON.stringify(alerts)}`);
    // The live flow: R is busy in an infinite loop (the R2-B1 occupier), the
    // check queues behind it, and aborting the signal mid-flight stops the
    // run and returns null promptly — no alert, and the engine is usable
    // afterwards (that is the retry).
    const busy: TableData = {
      columns: ["Title", "A"],
      rows: [["", "1.1"], ["", "2.3"], ["", "1.9"], ["", "3.2"], ["", "2.8"], ["", "1.5"], ["", "2.1"], ["", "3.0"]],
    };
    const hung = evalNamedVector("while(TRUE){}", { timeoutMs: 120_000, graceMs: 1_000 }).catch(() => {});
    const controller = new AbortController();
    const started = Date.now();
    const pending = checkNormality(busy, undefined, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 500));
    controller.abort();
    strictEqual(await pending, null);
    const elapsed = Date.now() - started;
    ok(elapsed < 10_000, `cancelled check took ${elapsed} ms to return`);
    strictEqual(alerts.length, 0, `expected no alert, got ${JSON.stringify(alerts)}`);
    await hung;
    // The cancel may have escalated to restarting the engine (the
    // watchdog's grace expiry abandons a stuck engine): re-boot explicitly,
    // as the R2-M15 check does, so the retry below proves R itself is
    // healthy either way.
    await startR(fileURLToPath(new URL("../node_modules/webr/dist/", import.meta.url)));
    deepStrictEqual(await evalNamedVector("c(a=1)"), { a: 1 });
  } finally {
    if (prevWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = prevWindow;
  }
});

// R2-B1: a failed run is not cached — Retry runs it for real. A runner
// that returns an error outcome (a bad fit, a timeout, a cancel) used to
// stay cached under the table version, so Retry replayed the stale error
// instead of re-running.
check("a failed analysis is not cached: fixing the data and re-running works", async () => {
  // The Y series follows a one-phase association curve (Kobs ≈ 1, plateau 5)
  // at times 0–6 — but the X column was mistyped: every time reads 5.
  const ys = ["0.03", "3.12", "4.35", "4.71", "4.95", "4.93", "4.98"];
  const table: TableData = {
    columns: ["Title", "X", "Y"],
    rows: ys.map((y) => ["", "5", y]),
  };
  const params = { y: "Y", model: "association-one-phase" } as AnalysisParams;
  const first = await runAnalysis("binding-kinetics", table, params);
  ok(
    "error" in first && /two different times/.test(first.error),
    `expected the equal-times error, got ${JSON.stringify(first)}`,
  );
  // Retry on the same table re-runs the runner for real instead of replaying
  // the cached error outcome: count invocations through the registry. (The
  // data is unchanged, so the retry fails the same way — what matters is
  // that it ran again.)
  let runs = 0;
  const entry = ANALYSES["binding-kinetics"];
  const orig = entry.run;
  entry.run = (...args: Parameters<typeof orig>) => {
    runs++;
    return orig(...args);
  };
  try {
    const retried = await runAnalysis("binding-kinetics", table, params);
    strictEqual(runs, 1, `retry should re-run the runner once, ran ${runs} times`);
    ok(
      "error" in retried && /two different times/.test(retried.error),
      `retry on unchanged data should fail the same way, got ${JSON.stringify(retried)}`,
    );
  } finally {
    entry.run = orig;
  }
  // Fixing the data — an edit makes a NEW TableData — and re-running fits.
  // (Mutating the same object in place would NOT do: readTable caches the
  // parsed table per TableData, by design — an edit makes a new one.)
  const fixed: TableData = {
    columns: table.columns,
    rows: ys.map((y, i) => ["", String(i), y]),
  };
  const second = await runAnalysis("binding-kinetics", fixed, params);
  ok(!("error" in second), `fixed data should fit, got ${JSON.stringify(second)}`);
});

// R2-M15: a hung R boot must not strand the run — or the runAnalysis cache —
// forever. The boot watchdog stops it with a clear error, the boot memo is
// reset, and the next startR boots fresh — that is the retry. The hung boot
// is a worker that starts but never becomes ready: a scratch dir symlinks
// the real runtime and replaces only the worker with a never-responding
// stub, so init() waits on it forever; without the watchdog this check
// would hang with it. resetR() first: the suite already booted R at the
// top, and startR returns the live engine while one exists — the hung boot
// only happens on a fresh boot. The timed-out boot is what `runAnalysis`
// then surfaces and evicts from its cache, so a retry starts a fresh run
// instead of returning the same hung promise.
check("hung R boot times out and retry boots fresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-hung-webr-"));
  try {
    const real = fileURLToPath(new URL("../node_modules/webr/dist/", import.meta.url));
    for (const name of readdirSync(real)) {
      if (name === "webr-worker.js") continue;
      symlinkSync(join(real, name), join(dir, name));
    }
    writeFileSync(
      join(dir, "webr-worker.js"),
      "// Never responds: the worker starts but never becomes ready.\nsetInterval(() => {}, 3_600_000);\n",
    );
    resetR();
    const started = Date.now();
    await rejects(
      startR(`${dir}/`, { timeoutMs: 1_000 }),
      (err: unknown) =>
        err instanceof Error && /took longer than 1 second to start/.test(err.message),
    );
    const elapsed = Date.now() - started;
    ok(elapsed < 10_000, `hung boot took ${elapsed} ms to fail`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The memo was reset: a good boot works on the same engine slot, and the
  // evaluation that follows it proves R itself is healthy.
  await startR(fileURLToPath(new URL("../node_modules/webr/dist/", import.meta.url)));
  deepStrictEqual(await evalNamedVector("c(a=1)"), { a: 1 });
});

// ── M17: the R queue is an explicit FIFO, and the UI shows it ───────────

check("R evaluations run one at a time, in the order they were asked (M17)", async () => {
  const seen: RQueueSnapshot[] = [];
  const queue = createEvalQueue((snap) => seen.push({ ...snap }));
  const done: number[] = [];
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const p1 = queue.enqueue(async () => {
    await sleep(30);
    done.push(1);
    return 1;
  });
  const p2 = queue.enqueue(async () => {
    await sleep(10);
    done.push(2);
    return 2;
  });
  const p3 = queue.enqueue(async () => {
    done.push(3);
    return 3;
  });
  deepStrictEqual(await Promise.all([p1, p2, p3]), [1, 2, 3]);
  deepStrictEqual(done, [1, 2, 3]);
  deepStrictEqual(queue.snapshot(), { running: false, queued: 0 });
  ok(
    seen.some((s) => s.running && s.queued === 2),
    "the queue must publish a snapshot with two waiting",
  );
});

check("one R evaluation failing never stalls the queue behind it (M17)", async () => {
  const queue = createEvalQueue();
  const done: number[] = [];
  const p1 = queue.enqueue(async () => {
    done.push(1);
    return 1;
  });
  const p2 = queue.enqueue(async () => {
    throw new Error("boom");
  });
  const p3 = queue.enqueue(async () => {
    done.push(3);
    return 3;
  });
  strictEqual(await p1, 1);
  await rejects(p2, /boom/);
  strictEqual(await p3, 3);
  deepStrictEqual(done, [1, 3]);
  deepStrictEqual(queue.snapshot(), { running: false, queued: 0 });
});

check("cancelling a queued R evaluation drops it without touching the running one (FL-F14)", async () => {
  const queue = createEvalQueue();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const ran: number[] = [];
  // Id 1 is the other window's install (running); id 2 is this window's
  // check, queued behind it; id 3 waits behind the check.
  const p1 = queue.enqueue(async () => {
    await sleep(30);
    ran.push(1);
    return 1;
  }, 1);
  const p2 = queue.enqueue(async () => {
    ran.push(2);
    return 2;
  }, 2);
  const p3 = queue.enqueue(async () => {
    ran.push(3);
    return 3;
  }, 3);
  // Let the install's turn start, so it is genuinely running while the check waits.
  await sleep(0);
  // Cancel the queued check while the install still runs: it never runs,
  // and the running install is not reported as cancelled.
  deepStrictEqual(queue.cancel([2]), { cancelledQueued: 1, runningCancelled: false });
  strictEqual(await p1, 1);
  await rejects(p2, (err: unknown) => err instanceof EvalCancelledError);
  strictEqual(await p3, 3);
  deepStrictEqual(ran, [1, 3]);
  deepStrictEqual(queue.snapshot(), { running: false, queued: 0 });
});

check("cancelling the running R evaluation says so, and an unknown id cancels nothing (FL-F14)", async () => {
  const queue = createEvalQueue();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const p1 = queue.enqueue(async () => {
    await sleep(20);
    return 1;
  }, 1);
  const p2 = queue.enqueue(async () => 2, 2);
  // Let the first task's turn start, so it is genuinely running.
  await sleep(0);
  deepStrictEqual(queue.cancel([99]), { cancelledQueued: 0, runningCancelled: false });
  // The running evaluation is reported, not stopped here — stopping it is
  // the caller's interrupt — so it still completes, and so does the queued one.
  deepStrictEqual(queue.cancel([1]), { cancelledQueued: 0, runningCancelled: true });
  strictEqual(await p1, 1);
  strictEqual(await p2, 2);
  deepStrictEqual(queue.snapshot(), { running: false, queued: 0 });
});

check("a waiting view names the R queue instead of bare Running… (M17)", () => {
  strictEqual(rQueueStatusText(null), "");
  strictEqual(rQueueStatusText({ running: false, queued: 0 }), "");
  strictEqual(rQueueStatusText({ running: true, queued: 1 }), " · R queue: 1 waiting");
  strictEqual(rQueueStatusText({ running: true, queued: 2 }), " · R queue: 2 waiting");
  const heard: RQueueSnapshot[] = [];
  const off = onRQueueSnapshot((s) => heard.push(s));
  setRQueueSnapshot({ running: true, queued: 2 });
  deepStrictEqual(getRQueueSnapshot(), { running: true, queued: 2 });
  deepStrictEqual(heard, [{ running: true, queued: 2 }]);
  off();
  setRQueueSnapshot({ running: false, queued: 0 });
  deepStrictEqual(heard, [{ running: true, queued: 2 }]);
});

check("the engine window answers R requests through the FIFO, and publishes its queue (M17)", () => {
  const native = readFileSync("src/native.ts", "utf8");
  ok(/createEvalQueue/.test(native), "serveR must dispatch through createEvalQueue");
  ok(/emit\("r-queue"/.test(native), "serveR must publish the queue on \"r-queue\"");
  const view = readFileSync("src/views/analyses/analysis-view.tsx", "utf8");
  ok(/rQueueStatusText\(queue\)/.test(view), "the analysis view must show the queue depth while running");
});

check("a cancel drops only its own window's requests, and the engine dequeues them (FL-F14)", () => {
  const main = readFileSync("src-tauri/src/main.rs", "utf8");
  ok(/emit_to\("engine", "r-cancel"/.test(main), "cancel_r must tell the engine which requests were dropped");
  ok(/waiting\.retain/.test(main), "cancel_r must drop only the calling window's waiting requests");
  ok(
    /caller == "engine"/.test(main),
    "cancel_r from the engine window must still drop every waiting request (stuck-engine recovery)",
  );
  const native = readFileSync("src/native.ts", "utf8");
  ok(/listen<number\[\]>\("r-cancel"/.test(native), "serveR must listen for the dropped request ids");
  ok(/queue\.cancel\(ids\)\.runningCancelled/.test(native), "serveR must interrupt only when the running evaluation was cancelled");
  const queue = readFileSync("src/stats/r-queue.ts", "utf8");
  ok(/cancel\(ids: Iterable<unknown>\)/.test(queue), "the FIFO must drop queued entries by id");
});

// R3-02: resetR() used to leave installed packages marked "ready" while the
// fresh engine's VFS was empty, so ensurePackages() became a permanent
// no-op and the next package-backed analysis failed with `there is no
// package called 'survival'`. resetR() now clears the states (and cancels
// any install in flight), and the shell broadcasts the engine restart so
// project windows — which keep their own states — clear theirs too.
check("an engine restart clears package states, so the next analysis reinstalls (R3-02)", async () => {
  // The broadcast wiring: the shell tells every window the engine
  // (re)started, project windows listen for it, and the listener clears
  // the states through resetR.
  const main = readFileSync("src-tauri/src/main.rs", "utf8");
  ok(/app\.emit\("r-reset", \(\)\)/.test(main), "r_ready must broadcast the engine restart");
  const native = readFileSync("src/native.ts", "utf8");
  ok(/listen\("r-reset"/.test(native), "project windows must listen for the engine restart");
  ok(/onEngineReset/.test(native), "native.ts must expose the engine-restart listener");
  const entry = readFileSync("src/main.tsx", "utf8");
  ok(/onEngineReset\(\)/.test(entry), "project windows must wire the engine-restart listener");
  // The runtime proof: survival installed, engine restarted, survival
  // analysis re-run — it must reinstall instead of failing with
  // `there is no package called 'survival'`.
  await ensurePackages(["survival"]);
  strictEqual(packageStatus("survival").status, "ready", "survival must install before the restart");
  const started = packageDiagnostics().installsStarted;
  resetR();
  strictEqual(
    packageStatus("survival").status,
    "not-loaded",
    "resetR must clear installed-package states",
  );
  // The restart drops the booted engine, so the re-run boots a fresh one —
  // and a fresh boot needs the tests' baseUrl: the eval path's `startR()`
  // defaults to the app's "/webr/", which does not exist here (same
  // re-boot the suite does after a failed boot below).
  await startR(fileURLToPath(new URL("../node_modules/webr/dist/", import.meta.url)));
  const { table } = importedTable("survival");
  const out = await runAnalysis("survival", table.data!, { curveTest: "logrank", correction: "holm" });
  ok(!("error" in out), `survival after an engine restart should reinstall and run, got ${JSON.stringify(out)}`);
  strictEqual(packageStatus("survival").status, "ready", "survival must be ready again after the re-run");
  ok(
    packageDiagnostics().installsStarted > started,
    "the re-run must have started a fresh install",
  );
});

// R3-03: a cancel in the engine never escalated — both listeners called a
// bare interruptR(), a no-op on Tauri's PostMessage channel, so a wedged
// engine sat out the full 5-minute watchdog budget instead of the
// 5-second grace → reload. They now also abort the live evaluations, and
// the shell clears its `ready` flag on reload / (re)start, so a request
// arriving mid-reload is sent once instead of twice. (FL-F14 already
// fixed the other leg — cancel_r dropping every window's requests — so
// this check does not re-litigate it.)
check("a cancel in the engine escalates through the watchdog, and a mid-reload request is sent once (R3-03)", async () => {
  // The wiring, leg (a): both engine-window listeners abort the live
  // evaluations (not just a bare interrupt), so the watchdog's 5-second
  // grace starts and a stuck engine is abandoned + reloaded.
  const native = readFileSync("src/native.ts", "utf8");
  const serveR = native.slice(
    native.indexOf("export async function serveR"),
    native.indexOf("export async function onRQueue"),
  );
  ok(
    (serveR.match(/cancelActiveEvals\(\)/g) ?? []).length >= 2,
    "both engine-window cancel listeners must abort the live evaluations",
  );
  ok(
    /runningCancelled/.test(serveR) && /cancelActiveEvals\(\)/.test(serveR),
    "a cancelled running evaluation must reach cancelActiveEvals",
  );
  // The wiring, leg (b): the shell clears `ready` when the engine reloads
  // and when it (re)starts, and serveR announces the (re)start before its
  // listeners attach.
  const main = readFileSync("src-tauri/src/main.rs", "utf8");
  ok(/fn r_starting/.test(main), "the shell must expose r_starting");
  ok(/r_starting,/.test(main), "r_starting must be registered as a command");
  const cancelR = main.slice(main.indexOf("fn cancel_r"), main.indexOf("fn r_starting"));
  ok(/ready = false/.test(cancelR), "the engine's own cancel must clear ready before the reload");
  const rStarting = main.slice(main.indexOf("fn r_starting"), main.indexOf("fn r_ready"));
  ok(/ready = false/.test(rStarting), "r_starting must clear ready until the engine says it is ready");
  ok(/invoke\("r_starting"\)/.test(serveR), "serveR must announce the (re)start");
  ok(
    serveR.indexOf('invoke("r_starting")') < serveR.indexOf('listen<[number, string]>("r-eval"'),
    "r_starting must come before the listeners attach",
  );
  ok(
    serveR.indexOf('invoke("r_starting")') < serveR.indexOf('invoke("r_ready")'),
    "r_starting must come before r_ready",
  );
  // The runtime proof, leg (a): a long evaluation aborted through
  // cancelActiveEvals rejects promptly with EvalCancelledError — it must
  // not sit out the 5-minute watchdog budget the way the bare-interrupt
  // path did. (The Tauri listener wiring above is code-level: there is no
  // engine window in this process.)
  await startR(fileURLToPath(new URL("../node_modules/webr/dist/", import.meta.url)));
  const started = Date.now();
  const pending = evalNamedVector("Sys.sleep(30); c(a=1)");
  await new Promise((r) => setTimeout(r, 500));
  cancelActiveEvals();
  await rejects(pending, (err: unknown) => err instanceof EvalCancelledError);
  const elapsed = Date.now() - started;
  ok(elapsed < 30_000, `cancel took ${elapsed} ms — the engine must not sit out the 5-minute budget`);
  // The cancel may have escalated to restarting the engine (the
  // watchdog's grace expiry abandons a stuck engine): re-boot explicitly,
  // as the M15 check does, so the retry below proves R itself is healthy
  // either way.
  await startR(fileURLToPath(new URL("../node_modules/webr/dist/", import.meta.url)));
  deepStrictEqual(await evalNamedVector("c(a=1)"), { a: 1 });
});

// ── Open-format nudge (prism-format-work (f)) ─────────────────────────────

check("the save prompt asks once per Prism project, and a remembered choice applies silently", () => {
  // No Prism origin, or already prompted: straight to the .hlx save.
  strictEqual(nextSaveAction({ prismOrigin: false, prompted: false, remembered: null }), "save-hlx");
  strictEqual(nextSaveAction({ prismOrigin: true, prompted: true, remembered: null }), "save-hlx");
  // Prism origin, never prompted, nothing remembered: prompt.
  strictEqual(nextSaveAction({ prismOrigin: true, prompted: false, remembered: null }), "prompt");
  // Remembered choices apply silently — "don't ask again" (f.4).
  strictEqual(nextSaveAction({ prismOrigin: true, prompted: false, remembered: "hlx" }), "save-hlx");
  strictEqual(nextSaveAction({ prismOrigin: true, prompted: false, remembered: "prism" }), "save-prism");
  // A remembered choice doesn't matter once prompted: still no prompt.
  strictEqual(nextSaveAction({ prismOrigin: true, prompted: true, remembered: "prism" }), "save-prism");
  // No localStorage under Node: reads as "no remembered choice", never throws.
  strictEqual(loadPrismSaveChoice(), null);
});

// ── FF-F15: a multi-file Prism drop imports the first and names the rest ──
check("a multi-file Prism drop names the skipped files", () => {
  strictEqual(
    prismDropSkippedMessage("a.prism", ["b.prism"]),
    "Imported a.prism; b.prism was not imported — drop one file at a time, or use File ▸ Convert….",
  );
  strictEqual(
    prismDropSkippedMessage("a.prism", ["b.prism", "c.pzfx"]),
    "Imported a.prism; b.prism, c.pzfx were not imported — drop one file at a time, or use File ▸ Convert….",
  );
});

// ── FL-rebrand: the prism-format surface says Titer, never Helix ────────
// The rebrand branch was cut before the prism-format code landed, so
// user-visible "Helix" strings survived in the converter dialog, the save
// prompt, the import alert and the import/write reports. This pins the
// rebranded strings and fails if "Helix" ever creeps back into the surface.
// src/lib/version.ts is deliberately NOT covered: its GitHub URLs point at
// the repo, which is still named smitpatel316/Helix.
check("prism-format surface strings say Titer, not Helix (FL-rebrand)", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const surface = [
    "src/components/converter-dialog.tsx",
    "src/components/save-prompt-dialog.tsx",
    "src/store/use-document.ts",
    "src/lib/prism.ts",
    "src/lib/prism-write.ts",
    "src/lib/dataset.ts",
  ];
  for (const rel of surface) {
    const text = readFileSync(join(root, rel), "utf8");
    ok(!text.includes("Helix"), `${rel} still mentions Helix`);
  }
  const converter = readFileSync(join(root, "src/components/converter-dialog.tsx"), "utf8");
  for (const s of [
    "the open Titer format",
    "Prism (.prism) → Titer (.hlx)",
    "Titer (this project) → Prism (.prism)",
    "the analyses Titer offers",
    "Open in Titer",
    "Titer Project",
  ]) {
    ok(converter.includes(s), `converter dialog is missing ${JSON.stringify(s)}`);
  }
  const savePrompt = readFileSync(join(root, "src/components/save-prompt-dialog.tsx"), "utf8");
  ok(savePrompt.includes("Save it as the open Titer format"), "save prompt is missing the Titer format string");
  const useDocument = readFileSync(join(root, "src/store/use-document.ts"), "utf8");
  ok(
    useDocument.includes("Save the project to keep it as a Titer project."),
    "import alert is missing the Titer project string",
  );
  const writer = readFileSync(join(root, "src/lib/prism-write.ts"), "utf8");
  ok(writer.includes('createdBy: { name: "Titer"'), "written .prism files must claim createdBy Titer");
});

// ── FL-r3-convert-stall: the Convert dialog must not wait on a frame ─────
// Mac proof Take 21 (3cd7dc4): File ▸ Convert stalls BOTH directions in the
// built app — "Reading tables from 'roundtrip'…" / "Writing 14 tables as
// .prism…" stuck 60–90 s at 0.0% CPU, Cancel still works, the same file
// imports via File ▸ Import in seconds. Both directions await the dialog's
// yield before any work, and the yield was requestAnimationFrame — the only
// awaited rAF in the app. In the built Tauri webview rAF only fires while
// the window is the active/key window; driven without focus, the callback
// never runs and the dialog waits forever. This pins the dialog's own await
// chain — yield, then the real convertPrism on a real fixture — with rAF
// stubbed to never fire, the backgrounded-webview condition. A yield that
// depends on a frame hangs here and the check fails; a yield that doesn't
// lets the conversion complete.
check("the Convert dialog finishes when requestAnimationFrame never fires (FL-r3-convert-stall)", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const g = globalThis as Record<string, unknown>;
  const savedRaf = g.requestAnimationFrame;
  // Backgrounded webview: rAF callbacks never run.
  g.requestAnimationFrame = () => 0;
  try {
    const tables = await Promise.race([
      (async () => {
        await yieldToPaint();
        const data = readFileSync(join(root, "tests/testdata/prism/prism2R-demo_dataset.prism"));
        const converted = await convertPrism(new Uint8Array(data), "prism2R-demo_dataset.prism");
        return converted.report.tables.length;
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Convert stalled: the dialog's yield never resolved with requestAnimationFrame silenced")),
          5000,
        ),
      ),
    ]);
    ok(tables > 0, "expected the fixture to convert at least one table");
  } finally {
    if (savedRaf === undefined) delete g.requestAnimationFrame;
    else g.requestAnimationFrame = savedRaf;
  }
});

// ── R3-01: the release pipeline ships the vendored webR repo ─────────────
// webr-repo/ is gitignored, so a fresh checkout (CI, or a clean clone) has
// no bundled repo: vite build warns and omits it from dist/, and the CDN
// fallback was blocked by the CSP (connect-src had no repo.r-wasm.org) —
// every package-backed analysis broke in release builds. The pipeline now
// builds the repo before the tests and before the Tauri build, the build
// scripts build it too, and the CSP allows the CDN fallback. This pins all
// three, plus the Mac DMG flow that already built it.
check("the release pipeline builds webr-repo/, and the CSP allows the CDN fallback (R3-01)", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  // Both CI jobs (check and build) run the script, each before the step
  // that needs the repo: npm test in check, tauri-action in build.
  const occurrences = release.split("build-webr-repo.sh").length - 1;
  ok(occurrences >= 2, `release.yml runs build-webr-repo.sh ${occurrences} time(s), want >= 2 (check + build jobs)`);
  ok(
    release.indexOf("build-webr-repo.sh") < release.indexOf("npm test"),
    "release.yml must build webr-repo/ before npm test (or packages.ts skips)",
  );
  ok(
    release.lastIndexOf("build-webr-repo.sh") < release.indexOf("tauri-apps/tauri-action"),
    "release.yml must build webr-repo/ before tauri-action (or vite build omits it from dist/)",
  );
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  for (const script of ["build", "build:linux"]) {
    ok(
      pkg.scripts[script]?.includes("./scripts/build-webr-repo.sh"),
      `package.json ${script} must run build-webr-repo.sh first`,
    );
  }
  // The Mac DMG flow already built the repo — keep it that way.
  ok(
    readFileSync(join(root, "scripts/build-mac-dmg.sh"), "utf8").includes("./scripts/build-webr-repo.sh"),
    "scripts/build-mac-dmg.sh must keep running build-webr-repo.sh",
  );
  // The CSP must allow the same CDN origin the code falls back to.
  const webr = readFileSync(join(root, "src/stats/webr.ts"), "utf8");
  const cdn = /export const CDN_REPO_URL = "(https:\/\/[^"]+)"/.exec(webr)?.[1];
  ok(cdn, "src/stats/webr.ts must define CDN_REPO_URL");
  const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")) as {
    app: { security: { csp: Record<string, string> } };
  };
  ok(
    conf.app.security.csp["connect-src"]?.includes(cdn!),
    `tauri.conf.json connect-src must allow the CDN fallback ${cdn}`,
  );
});

// ── R3-17: the engine window can show dialogs ─────────────────────────────
// With no project window open, the hidden engine window sets the menu bar
// (engine.ts), so "Check for Updates…" and the missing-file alert
// (menus.ts: sayGone) run there — and both go through the dialog plugin
// (native.ts: alert/askToDownload → message()). The engine capability
// granted only "core:default", so those calls failed with a permission
// error whenever no project window was open. The project windows already
// had "dialog:default" (capabilities/default.json); this pins the engine
// window to the same. Static assertion: there is no dialog call in the
// test harness, and the permission is what the runtime enforces.
check("the engine window grants dialog:default, so Check for Updates and missing-file alerts work with no project open (R3-17)", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const engine = JSON.parse(readFileSync(join(root, "src-tauri/capabilities/engine.json"), "utf8")) as {
    windows: string[];
    permissions: string[];
  };
  ok(engine.windows.includes("engine"), "capabilities/engine.json must target the engine window");
  ok(
    engine.permissions.includes("dialog:default"),
    `capabilities/engine.json permissions must include "dialog:default" (has: ${engine.permissions.join(", ")})`,
  );
  // The dialog calls the windowless menu bar depends on must actually be
  // the plugin's message dialog, not a window.alert fallback.
  const native = readFileSync(join(root, "src/native.ts"), "utf8");
  ok(
    native.includes('from "@tauri-apps/plugin-dialog"'),
    "src/native.ts must use @tauri-apps/plugin-dialog for alerts",
  );
  const menus = readFileSync(join(root, "src/menus.ts"), "utf8");
  ok(menus.includes("checkForUpdates()"), "the windowless menu bar must offer Check for Updates…");
  ok(menus.includes("sayGone"), "the windowless menu bar must report a missing recent file");
});

// ── R3-27: linux-smoke boots webR; the Mac DMG script reads its version ───
// BUG-REPORT #27, two legs. (a) build-mac-dmg.sh hardcoded 1.0.6 while the
// project was 1.0.7 — already fixed by the rebrand (Batch D), which reads
// VERSION from package.json; this pins the derivation so a hardcoded
// version can never creep back. (b) linux-smoke.ts called runAnalysis
// without startR, so the survival leg crashed in Node with
// `Cannot find module '/webr/webr-worker.js'`; it now boots from the
// filesystem webr/dist path and serves webr-repo/ on localhost, as this
// file does. This pins the init statically — the smoke script itself is
// the runtime proof (it is not part of `npm test`).
check("linux-smoke boots webR from the filesystem path, and build-mac-dmg.sh reads its version from package.json (R3-27)", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const smoke = readFileSync(join(root, "tests/linux-smoke.ts"), "utf8");
  ok(smoke.includes('from "../src/stats/webr"'), "linux-smoke.ts must import the engine from src/stats/webr");
  ok(smoke.includes("setPackageRepo("), "linux-smoke.ts must point the package repo at the bundled webr-repo/");
  ok(
    smoke.includes('await startR(fileURLToPath(new URL("../node_modules/webr/dist/", import.meta.url)))'),
    "linux-smoke.ts must boot webR from the filesystem webr/dist path before running analyses",
  );
  ok(
    smoke.indexOf("await startR(") < smoke.indexOf('runAnalysis("survival"'),
    "linux-smoke.ts must boot the engine before the survival analysis runs",
  );
  const dmg = readFileSync(join(root, "scripts/build-mac-dmg.sh"), "utf8");
  ok(
    dmg.includes("require('./package.json').version"),
    "build-mac-dmg.sh must derive its version from package.json",
  );
  ok(!/Titer_\d+\.\d+\.\d+/.test(dmg), "build-mac-dmg.sh must not hardcode a version in the DMG name");
  ok(
    dmg.includes('DMG_NAME="Titer_${VERSION}_aarch64.dmg"'),
    "the DMG name must use the derived version",
  );
});

// ── Replicate pooling (prism-format-work (b)/(g)) ─────────────────────────
// An imported Prism analysis names its Y data set ("Control"), not a column
// — the fit pools the data set's replicate columns, as Prism does.
check("a nonlinear fit pools a Y data set's replicates, and a column name still fits one column", () => {
  // (g) fix, 2026-11-11: the fixture as written omitted the Title column,
  // so readTable ate "X" as row titles and splitXY took "Control_1" as X —
  // the fit pooled 7 points, not 14. The Title column is the repo
  // convention (see the fixtures above); with it, X is X again.
  const columns = readTable({
    columns: ["Title", "X", "Control_1", "Control_2", "Treated_1"],
    rows: [
      ["", "0", "5", "6", "10"],
      ["", "1", "10", "11", "20"],
      ["", "2", "20", "21", "40"],
      ["", "4", "40", "41", "80"],
      ["", "8", "80", "81", "90"],
      ["", "16", "90", "91", "95"],
      ["", "32", "95", "96", "98"],
    ],
  }).columns;
  deepStrictEqual(
    datasetColumns(columns, "Control").map((c) => c.name),
    ["Control_1", "Control_2"],
  );
  deepStrictEqual(datasetColumns(columns, "Control_1").map((c) => c.name), ["Control_1"]);
  deepStrictEqual(datasetColumns(columns, "Nope"), []);
  const pooled = prepareFit(columns, "Control", "sigmoidal-4pl-x");
  if ("error" in pooled) throw new Error(pooled.error);
  // 7 rows × 2 replicates = 14 points, named for the data set — and the
  // X = 0 vehicle point stays in a raw-concentration fit (it is Bottom).
  strictEqual(pooled.xs.length, 14);
  strictEqual(pooled.ys.length, 14);
  strictEqual(pooled.yCol.name, "Control");
  ok(pooled.xs.includes(0));
  const single = prepareFit(columns, "Control_1", "sigmoidal-4pl-x");
  if ("error" in single) throw new Error(single.error);
  strictEqual(single.xs.length, 7);
  strictEqual(single.yCol.name, "Control_1");
  // A log-X curve keeps X = 0: X is already log10(concentration), so 0
  // is a valid log value (concentration 1), not log(0) — the model never
  // takes log(X). (The first version of this check expected 12 here, on
  // the mistaken idea that log-X drops X = 0; it does not, and never did
  // — the log-X spec sets no positiveX flag, which is why the b-domain
  // corpus files fit at all with their all-negative log-X values.)
  const logged = prepareFit(columns, "Control", "sigmoidal-4pl-logx");
  if ("error" in logged) throw new Error(logged.error);
  strictEqual(logged.xs.length, 14);
  ok(logged.xs.includes(0));
  ok("error" in prepareFit(columns, "Nope", "sigmoidal-4pl-x"));
});

// ── Run ──────────────────────────────────────────────────────────────────

// Descriptives are computed by R since the v1.0.7 rebase, so checks that run
// an analysis need the engine — booted from the installed webR, as
// tests/reference.ts does. Package installs read the BUNDLED repo
// (webr-repo/, served on localhost — the same pattern as reference.ts and
// packages.ts), never the CDN: a survival install must not depend on the
// egress proxy being up.
const REPO_DIR = fileURLToPath(new URL("../webr-repo/", import.meta.url));
// Hoisted so the run can shut the server down at the end: without the
// close + process.exit() below, the listening server keeps the event loop
// alive and `npm test` never reaches tests/reference.ts (the process hung
// ~20 min after printing "All 119 checks pass" on the rebased tree).
let repoServer: ReturnType<typeof createServer> | undefined;
if (existsSync(`${REPO_DIR}MANIFEST.json`)) {
  const server = (repoServer = createServer((req, res) => {
    const path = decodeURIComponent(req.url!.split("?")[0]).replace(/^\/+/, "");
    const file = `${REPO_DIR}${path}`;
    if (!path || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(readFileSync(file));
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  setPackageRepo(`http://127.0.0.1:${(server.address() as { port: number }).port}`, {
    allowCdnFallback: false,
  });
} else {
  console.log("⚠ webr-repo/ is not built — package-dependent checks will use the CDN. Run scripts/build-webr-repo.sh, then re-run npm test.");
}
await startR(fileURLToPath(new URL("../node_modules/webr/dist/", import.meta.url)));

let failed = 0;
// CHECK=<substring> runs only the matching checks (e.g. CHECK=FL-rebrand
// for the rebrand regression check alone, without the full suite).
const only = process.env.CHECK;
const selected = only ? checks.filter(([name]) => name.includes(only)) : checks;
for (const [name, fn] of selected) {
  try {
    await fn();
  } catch (err) {
    failed++;
    console.log(`✗ ${name}\n  ${err instanceof Error ? err.message.split("\n").join("\n  ") : err}`);
  }
}
console.log(failed ? `${failed} of ${selected.length} checks failed.` : `All ${selected.length} checks pass.`);
process.exitCode = failed ? 1 : 0;
// Shut down the repo server and exit explicitly (same as reference.ts /
// packages.ts): otherwise the listening server + webR workers keep the
// process alive forever and `npm test` stalls here.
repoServer?.close();
process.exit(process.exitCode);
