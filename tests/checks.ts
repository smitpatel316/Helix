/// <reference types="node" />
// Checks for what must never break: .hlx files opening across versions and never
// trusted, table edits keeping every value where it belongs, graphs drawing each
// setting and following renamed columns, selected points, exports, analyses on the
// data asked, Undo, and the app's menus, recents and update check. `npm test` runs them.
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { setPackageRepo, startR } from "../src/stats/webr";
import { parseProjectFile, readPalette, serializeProjectFile, type ProjectFilePayload } from "../src/lib/project-file";
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
  freshColumnNames,
  insertRows,
  newGroupedTable,
  newNestedTable,
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
  writeBlock,
} from "../src/views/tables/table-data";
import { flattenThreeWay, rowGroupBands } from "../src/stats/grouped/base";
import { analysisOptionsForTable } from "../src/views/analyses";
import { followTable } from "../src/store/references";
import { pairKey } from "../src/lib/columns";
import {
  NAMED_COLORS,
  PALETTES,
  isHelixPalette,
  paletteColor,
  paletteNamed,
  paletteOf,
  reversedPalette,
  withOpacity,
  withoutColors,
} from "../src/lib/palettes";
import { deletePalette, keepPalette, loadMyPalettes } from "../src/store/my-palettes";
import { GRAPHS, GRAPH_OPTIONS_BY_TABLE, newGraphOptions, type GraphFigure } from "../src/views/graphs";
import { datasetColumns, isGrouped, isNested, readTable, setColumns, type Dataset } from "../src/lib/dataset";
import { prepareFit } from "../src/stats/xy/nonlinear-fit";
import { adjustComparisonRows, adjustPValues, incompleteRows, missingColumn } from "../src/stats/column/base";
import { dagostinoPearson } from "../src/stats/column/shapiro-wilk";
import { parseGroupLevels, toggled, WIZARDS, type Question } from "../src/views/analyses/wizards";
import { addNote, movedText, paintOf, vectorTraces, visibleOutline, withCaps } from "../src/views/graphs/plot-helpers";
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
import { genesNamed } from "../src/views/graphs/volcano";
import { examplesFor, matched, type Matched } from "../src/views/graphs/match-graph";
import type { OutlineNode } from "../src/store/use-project-store";
import { deriveComparisons } from "../src/views/graphs/significance-overlay";
import { headline } from "../src/views/analyses/analysis-results-view";
import { loadPrismSaveChoice, nextSaveAction } from "../src/lib/prism-nudge";
import { fitWidths } from "../src/store/use-layout";
import { computeGroupedDEG } from "../src/lib/deg";
import { runAnalysis } from "../src/stats";
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
import { largestAt, withDpi } from "../src/lib/image-dpi";
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
  panelRects,
  sharedLegendCheck,
  validateFigureSize,
} from "../src/lib/figure";
import { sampleProject } from "./sample-project";
import { crc32 } from "node:zlib";
import type { AnalysisOutcome, AnalysisParams, AnalysisResult, MonteCarloParams, RegressionCoefficient, SimulationSpec } from "../src/stats/types";
import { simulationRCode, validateSimulationSpec } from "../src/stats/simulation/simulate";
import { aicc, coefficientsForSet, invertMethod, invertModel, nestedPair } from "../src/stats/xy/nonlinear-regression";
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
  strictEqual(read(readFileSync("samples/Helix Sample.hlx", "utf8")).updated, false);
  const file = () => JSON.parse(serializeProjectFile(payload));
  const repaired = file();
  repaired.project.nodes.g1.graphOptions.lineDash = "zigzag";
  strictEqual(read(JSON.stringify(repaired)).updated, true);
  const older = file(); // from a Helix before the bars' gap
  delete older.project.nodes.g1.graphOptions.barGap;
  strictEqual(read(JSON.stringify(older)).updated, true);
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
  strictEqual(g1.graphOptions!.palette!.name, "helix");
  // A heatmap keeps its scale as Plotly drew it, or Viridis.
  strictEqual(g2.graphOptions!.palette!.name, "Heat (Helix 1.0)");
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
  deepStrictEqual(project.nodes.a2.analysisParams, { tails: "less", gaussian: true, y: "Dose (µM)" });
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
  deepStrictEqual(project.nodes.a3.analysisParams, { q: 50, model: "line", method: "pearson" });
});

// ── Tables ───────────────────────────────────────────────────────────────

check("fewer sub-columns keep each value in its group", () => {
  const t = regroupTable(grouped(), 2, 2);
  deepStrictEqual(t.columns, ["Title", "A:Y1", "A:Y2", "Treated:Y1", "Treated:Y2"]);
  deepStrictEqual(t.rows[0], ["r1", "a1", "a2", "b1", "b2"]);
  deepStrictEqual(t.excluded, ["0,3"]);
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
  // A band with an empty name, a duplicate name or a bad count drops the field.
  for (const rowGroups of [
    [{ name: "", count: 1 }, { name: "KO", count: 1 }],
    [{ name: "WT", count: 1 }, { name: "WT", count: 1 }],
    [{ name: "WT", count: 0 }, { name: "KO", count: 2 }],
    [{ name: "WT", count: 1.5 }, { name: "KO", count: 1 }],
    "WT/KO",
  ]) {
    const broken = JSON.parse(serializeProjectFile(project));
    broken.project.nodes.t1.data.rowGroups = rowGroups;
    strictEqual(read(JSON.stringify(broken)).project.nodes.t1.data!.rowGroups, undefined);
  }
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

// Plan 26: a global fit's coefficients split per series for the overlay —
// shared parameters as fitted, per-series ones with their suffix stripped,
// other series' dropped (a display term ending in a parenthesis, like
// "Asymmetry (S)", is not a series suffix).
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
    "okabe-ito": 8, "tol-bright": 7, "tol-muted": 9, "tableau-10": 10, grayscale: 5, helix: 6,
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
  const { project } = read(readFileSync("samples/Helix Sample.hlx", "utf8"));
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

check("Open Recent reads only a list of paths", () => {
  const stored: Record<string, string> = {};
  const storage = {
    getItem: (k: string) => stored[k] ?? null,
    setItem: (k: string, v: string) => void (stored[k] = v),
  };
  Object.assign(globalThis, { localStorage: storage });
  try {
    for (const bad of ['{"a":1}', "[1, null]", "not json"]) {
      stored["helix.recent"] = bad;
      deepStrictEqual(loadRecents(), []);
    }
    stored["helix.recent"] = '["/a.hlx", 3, "/b.hlx"]';
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
    stored["helix.palettes"] = JSON.stringify([heat, { name: "No colors", colors: [] }, 7]);
    deepStrictEqual(await loadMyPalettes(), [heat]);
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  deepStrictEqual(
    [0, 1, 2, 3, 4].map((i) => paletteColor(heat, i, 5)),
    ["#FFFFFF", "#FFBFBF", "#FF8080", "#FF4040", "#FF0000"],
  );
  ok(isHelixPalette("viridis") && isHelixPalette("Okabe-Ito") && !isHelixPalette("Lab"));
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

check(".pzfx import names summary subcolumns and warns they aren't replicates", () => {
  const { imported, table } = importedTable("column_sdn");
  strictEqual(table.tableType, "column");
  deepStrictEqual(table.data!.columns, ["Title", "A_MEAN", "A_SD", "A_N", "B_MEAN", "B_SD", "B_N"]);
  deepStrictEqual(table.data!.rows[0], [null, "100", "10", "2", "10", "1", "10"]);
  ok(imported.issues.some((i) => i.message.includes("not raw replicates")), "warns about summaries");
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
for (const [name, fn] of checks) {
  try {
    await fn();
  } catch (err) {
    failed++;
    console.log(`✗ ${name}\n  ${err instanceof Error ? err.message.split("\n").join("\n  ") : err}`);
  }
}
console.log(failed ? `${failed} of ${checks.length} checks failed.` : `All ${checks.length} checks pass.`);
process.exitCode = failed ? 1 : 0;
// Shut down the repo server and exit explicitly (same as reference.ts /
// packages.ts): otherwise the listening server + webR workers keep the
// process alive forever and `npm test` stalls here.
repoServer?.close();
process.exit(process.exitCode);
