// Host for a graph node: reads the parent table (lib/dataset.ts), draws the chart
// with Plotly on a sheet (exactly the exported image), and shows the Format panel.
// The graph is resized by grabbing an axis (X = width, Y = height) or by typing its
// size under Export: during a drag only a light axis outline follows, and the plot
// redraws once on release. Ctrl+scroll or a pinch zooms the view only, round the pointer.
import * as React from "react";
import { cn } from "../../ui/controls";
import { WithInspector } from "../../components/inspector";
import {
  clamp,
  DEFAULT_GRAPH_OPTIONS,
  GRAPH_LIMITS,
  hasXColumn,
  SAME_AS_FILL,
  type GraphOptions,
  type PointStyle,
  type ProjectNode,
  type SeriesStyle,
} from "../../store/types";
import type { BindingKineticsParams, BindingSaturationParams, DoseResponseSpecialParams, EnzymeInhibitionParams, LinearRegressionParams, SimpleLogisticRegressionParams, NonlinearRegressionParams, CoxPHParams, PoissonRegressionParams, DemingRegressionParams } from "../../stats/types";
import { useProjectStore } from "../../store/use-project-store";
import { groupsOf, isGrouped, readTable, splitXY, xyProblem, type Column } from "../../lib/dataset";
import { paletteOf } from "../../lib/palettes";
import { computeGroupedDEG } from "../../lib/deg";
import { useAnalysis } from "../analyses/use-analysis";
import { GRAPHS, graphSeries, plotColumns } from ".";
import { addFittedCurve } from "./fitted-curve";
import { addBindingCurve, addDoseResponseSpecialCurve, addEnzymeInhibitionCurve } from "./binding-curve";
import { addSchildPlot } from "./schild-plot";
import { addSmoothCurve } from "./smooth-curve";
import { addLogisticCurve, logisticCurveNote } from "./logistic-curve";
import { addForestPlot } from "./forest-plot";
import { coxSurvivalColumns } from "./survival";
import { FormatPanel } from "./format-panel";
import { copyGraphImage, saveGraphImage } from "./graph-export";
import { addNote, INK, MOVABLE, marginsFor, movedText, onAxis, paintOf, withCaps } from "./plot-helpers";
import { addLogisticCurve as addAnalysisLogisticCurve } from "./fitted-curve";
import { useStartAnalysis } from "../analyses/use-analysis-launcher";
import { loadPlotly } from "./plotly";
import { fitZoom } from "../../store/use-layout";
import { addRegression } from "./regression-overlay";
import { addDeming } from "./deming-overlay";
import { addObservedFitted } from "./observed-fitted";
import { addScreePlot } from "./scree-plot";
import { addPcaBiplot } from "./pca-biplot";
import { addKmeansScatter } from "./kmeans-scatter";
import { addMonteCarloHistogram } from "./monte-carlo-histogram";
import { addSignificance, deriveComparisons } from "./significance-overlay";
import {
  drawnKeys,
  drawnStyle,
  keysOf,
  picked,
  pointLabels,
  resizePoints,
  selectionRing,
  stylePoints,
} from "./selection";
import { chooseSelectionStyle } from "./style-menus";
import { genesNamed, volcanoAxes, volcanoPair } from "./volcano";
import { titleCase } from "../../lib/format";
import { tooManyBins } from "../../lib/histogram";

// The view's zoom, 25 % to 400 %, as in Pages; WebGL's resolution, which Plotly takes up to 4.
const ZOOM = { min: 0.25, max: 4 };
const GL_RATIO = { min: 1, max: 4 };

type Size = { width: number; height: number };
type Margins = { l: number; r: number; t: number; b: number };

export function GraphView({ node }: { node: ProjectNode }) {
  const { nodes, updateGraph, openSelector } = useProjectStore();
  const type = node.graphType!;
  const family = GRAPHS[type].family;
  const parent = node.parentId ? nodes[node.parentId] : undefined;
  const data = parent?.data;
  // Merged over the defaults, so options added after a file was saved have a value.
  const options = { ...DEFAULT_GRAPH_OPTIONS, ...node.graphOptions };
  // A setting chosen again (a choice already on) changes nothing, and leaves no Undo step.
  const set = (patch: Partial<GraphOptions>) => {
    const same = (Object.keys(patch) as (keyof GraphOptions)[]).every(
      (k) => JSON.stringify(patch[k]) === JSON.stringify(options[k]),
    );
    if (!same) updateGraph(node.id, { ...options, ...patch });
  };
  // A series styled by hand (the Series section's Reset puts them all back).
  const setSeriesStyle = (key: string, style: SeriesStyle) =>
    set({ series: { ...options.series, [key]: { ...options.series?.[key], ...style } } });

  // The points picked on the graph, by key: a click picks one, ⌘- or ⇧-click adds or
  // removes one, a click elsewhere or Escape clears them. Never saved, never undone;
  // another graph starts with none (the view is rebuilt per graph).
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const clearSelection = () => setSelected((s) => (s.size ? new Set() : s));
  const styleSelected = (keys: ReadonlySet<string>, style: PointStyle | null) =>
    set({ points: stylePoints(options.points, keys, style) });

  const containerRef = React.useRef<HTMLDivElement>(null);
  const plottedRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLDivElement>(null);
  const startAnalysis = useStartAnalysis();
  // The saved size, and a live preview while dragging an axis.
  const size: Size = { width: options.width, height: options.height };
  const [drag, setDrag] = React.useState<Size | null>(null);
  // The view-only fit: the sheet is scaled to the visible pane until the user
  // zooms by hand (Ctrl+scroll/pinch), which sets an explicit zoom; Reset returns
  // to the fit. The saved size never changes — fitting only scales the view.
  const [fit, setFit] = React.useState(1);
  const [explicitZoom, setExplicitZoom] = React.useState<number | null>(null);
  const zoom = explicitZoom ?? fit;
  const zoomRef = React.useRef(zoom);
  zoomRef.current = zoom;
  // The margins Plotly drew, which grow for long labels and place the resize grab
  // zones on the real axes.
  const [margins, setMargins] = React.useState<Margins | null>(null);

  // ── Data ─────────────────────────────────────────────────────────────

  const dataset = data ? readTable(data) : null;
  const columns = React.useMemo(
    () => (dataset && parent?.tableType ? plotColumns(dataset, type, options, parent.tableType) : []),
    [dataset, type, options.center, options.xVariable, options.yVariable, parent?.tableType],
  );
  // A graph of a table with an X needs numbers in X and in a Y column, and says which it lacks —
  // except the ROC curve, whose truth (X) may be text ("Diseased"/"Healthy"):
  // its build draws nothing when the truth has other than two classes.
  // An XY graph needs numbers in X and in a Y column, and says which it lacks — except the
  // ROC curve (its truth may be text), the forest plot (its points come from a Cox analysis,
  // not the table's columns), and a survival curve on a Multiple Variables table (its
  // columns are derived from the Cox analysis below, not the table's own X/Y shape).
  // A survival curve, one column per group (each row a subject, or a count), never replicates.
  const xyLack =
    type === "survival" && parent?.data && isGrouped(parent.data)
      ? "Each group needs one column of event codes or survivor counts, not replicates."
      : family === "xy" &&
        type !== "roc-curve" &&
        type !== "forest-plot" &&
        !(type === "survival" && parent?.tableType === "multiple") &&
        parent?.tableType &&
        hasXColumn(parent.tableType) &&
        dataset
        ? xyProblem(dataset.columns)
        : undefined;

  // A volcano on a grouped table: Titer computes the DEGs between two of its groups
  // (per-row Welch t test + BH FDR) and plots them, read like any other table.
  const volcanoGroups =
    family === "volcano" && parent?.tableType === "grouped" && dataset
      ? groupsOf(dataset.numeric).map((g) => g.name)
      : undefined;
  const volcanoColumns = React.useMemo(() => {
    if (!volcanoGroups || !data) return columns;
    const [a, b] = volcanoPair(volcanoGroups, options);
    const deg = a && b && a !== b ? computeGroupedDEG(data, a, b, options.volcanoEffect) : [];
    // One row per table row, so a gene keeps its row's number (its key, see volcano.ts).
    const rows: (string | null)[][] = data.rows.map(() => []);
    for (const d of deg) rows[d.row] = [null, d.label, String(d.log2FC), String(d.p), String(d.padj)];
    return readTable({ columns: ["Title", "Gene", "Log2 FC", "P", "FDR"], rows }).columns;
  }, [columns, data, volcanoGroups?.join("\n"), options.volcanoGroupA, options.volcanoGroupB, options.volcanoEffect]);
  // The rows of a grouped table holding values of the two groups that gave no gene.
  const volcanoLeftOut = React.useMemo(() => {
    if (!volcanoGroups || !dataset) return 0;
    const pair = volcanoPair(volcanoGroups, options);
    const held = groupsOf(dataset.numeric)
      .filter((g) => pair.includes(g.name))
      .flatMap((g) => g.columns);
    const rows = new Set(held.flatMap((c) => c.rows));
    return rows.size - (volcanoColumns.find((c) => c.name === "Log2 FC")?.values.length ?? 0);
  }, [dataset, volcanoColumns, volcanoGroups?.join("\n"), options.volcanoGroupA, options.volcanoGroupB]);

  // The series drawn, one row each in the Series section.
  const seriesNames = data && parent?.tableType ? graphSeries(type, data, parent.tableType, options) : [];

  // The grouped volcano maps the computed DEG columns (P values) onto its axes; an XY
  // table's X is its X column.
  const buildOptions = volcanoGroups
    ? {
        ...options,
        volcanoLabel: "Gene",
        volcanoX: "Log2 FC",
        volcanoY: options.volcanoSignificance === "fdr" ? "FDR" : "P",
        volcanoYIsPValue: true,
      }
    : family === "volcano" && parent?.tableType === "xy"
      ? { ...options, volcanoX: dataset?.columns[0]?.name }
      : options;
  // What a graph can't draw, said in its Format panel: values at or under 0 on a log axis
  // (X: only a numeric one; on XY, its first column is X), a volcano's P values under 0.
  const atOrUnder0 = (cols: Column[]) => cols.reduce((n, c) => n + c.values.filter((v) => v <= 0).length, 0);
  const logLeftOut = {
    x: family === "xy" && options.xScale !== "linear" ? atOrUnder0(columns.slice(0, 1)) : 0,
    // A histogram's Y counts values: an empty bin is simply not drawn.
    y:
      options.yScale !== "linear" && family !== "histogram"
        ? atOrUnder0(family === "xy" ? columns.slice(1) : columns)
        : 0,
  };
  const binsTooMany =
    family === "histogram" &&
    tooManyBins(
      columns.flatMap((c) => c.values),
      options.binWidth,
    );
  const volcanoY =
    family === "volcano" && !volcanoGroups
      ? volcanoAxes(
          volcanoColumns.filter((c) => c.values.length > 0),
          volcanoColumns,
          buildOptions,
        ).y
      : undefined;
  const volcanoBelowZero = volcanoY?.values.filter((p) => p < 0).length ?? 0;
  // A volcano whose chosen column is gone says so, and draws no other in its place.
  const gone = family === "volcano" ? volcanoAxes([], volcanoColumns, buildOptions).gone : undefined;
  const lack = xyLack ?? (gone === undefined ? undefined : `The column “${gone}” is no longer in the table.`);
  const hasData = !lack && columns.some((c) => c.values.length > 0);

  // The figure's traces as last drawn, without the selection ring.
  const [drawn, setDrawn] = React.useState<unknown[]>([]);
  // Each point made bigger or smaller from the size it is drawn at.
  const resizeSelected = (keys: ReadonlySet<string>, by: number) =>
    set({ points: resizePoints(options.points, drawn, keys, by) });
  // A point's style as the figure draws it, its outline color as chosen, and its name shown or not.
  const styleOf = (key: string) => {
    const style = drawnStyle(drawn, key);
    const own = options.points?.[key];
    return (
      style && {
        ...style,
        outlineColor: own?.outlineColor ?? options.pointOutlineColor ?? SAME_AS_FILL,
        label: own?.label ?? false,
      }
    );
  };
  const firstSelected = selected.values().next().value;
  const firstStyle = firstSelected === undefined ? undefined : styleOf(firstSelected);

  // The genes named in the Find gene field become the selection; returns the names no gene has.
  const findGenes = (query: string) => {
    const { keys, missing } = genesNamed(volcanoColumns, buildOptions, query, dataset?.titles);
    setSelected(new Set(keys));
    return missing;
  };

  // The right-click menu of the selected points; a point clicked outside them is picked first.
  const openSelectionMenu = (key: string | null) => {
    const keys = key && !selected.has(key) ? new Set([key]) : selected;
    if (keys !== selected) setSelected(keys);
    const first = keys.values().next().value;
    const style = first && styleOf(first);
    if (!style) return;
    void chooseSelectionStyle(paletteOf(options), style, {
      style: (style) => styleSelected(keys, style),
      resize: (by) => resizeSelected(keys, by),
      reset: () => styleSelected(keys, null),
    });
  };

  // Plotly reports clicks, hovers and dragged-over points on the plot; the handlers it
  // calls read the latest state through these refs (they are set once, when the plot is
  // first drawn). A drag over the plot picks the points in its rectangle; ⌘ or ⇧, held
  // as it starts, adds them to the selection.
  const hovered = React.useRef<string | null>(null);
  const pointClicked = React.useRef(false);
  const dragAdds = React.useRef(false);
  // Pressed on the plot and not yet a click: only then is Plotly's report of dragged-over
  // points the user's. It reports an empty one too when a redraw clears its rectangle.
  const pressed = React.useRef(false);
  const onPlotClick = React.useRef((_key: string, _add: boolean) => {});
  const onPlotSelect = React.useRef((_keys: string[]) => {});
  const onPlotMove = React.useRef((_moved: PlotMove, _names: (string | undefined)[]) => {});
  React.useEffect(() => {
    // A text dropped where it now stays: the legend (or color legend), the note, or a
    // point's name, kept with its style.
    onPlotMove.current = (moved, names) => {
      const text = movedText(moved, names);
      if (text) pressed.current = false; // the press moved a text: no points were dragged over
      if (text?.name === "legend") set({ legend: text.at });
      else if (text?.name === "note") set({ note: text.at });
      else if (text) set({ points: stylePoints(options.points, [text.name], { labelOffset: text.at }) });
    };
    onPlotClick.current = (key, add) => {
      pointClicked.current = true;
      setSelected((s) => {
        if (!add) return new Set([key]);
        const next = new Set(s);
        if (!next.delete(key)) next.add(key);
        return next;
      });
    };
    onPlotSelect.current = (keys) => {
      if (!pressed.current) return;
      pressed.current = false;
      setSelected((s) => picked(s, keys, dragAdds.current));
    };
  });
  // Escape clears the selection, unless it's for a field being typed in.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement))
        clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Overlays from the table's analyses ───────────────────────────────

  const analyses = Object.values(nodes).filter((n) => n.type === "analysis" && n.parentId === node.parentId);
  // Significance brackets read the chosen analysis's own result (the one its view shows).
  const sigAnalysis = options.sigAnalysisId ? nodes[options.sigAnalysisId] : undefined;
  const sigOutcome = useAnalysis(
    family === "column" ? sigAnalysis?.analysisType : undefined,
    data,
    sigAnalysis?.analysisParams,
  );
  // None while its analysis runs (its stars come once R answers).
  const comparisons = React.useMemo(
    () => (sigAnalysis && !sigOutcome ? null : deriveComparisons(sigOutcome)),
    [sigAnalysis, sigOutcome],
  );
  // An XY scatter draws a regression of its table: a linear one's line and band it computes
  // itself; a nonlinear or logistic one's curve, from its result.
  const regNode = options.regAnalysisId ? nodes[options.regAnalysisId] : undefined;
  const regParams = regNode?.analysisParams as LinearRegressionParams | undefined;
  const curveParams =
    regNode?.analysisType === "nonlinear-regression"
      ? (regNode.analysisParams as NonlinearRegressionParams)
      : undefined;
  const logistic = regNode?.analysisType === "simple-logistic-regression";
  const curveOutcome = useAnalysis(
    type === "xy-scatter" && (curveParams || logistic) ? regNode!.analysisType : undefined,
    data,
    regNode?.analysisParams,
  );
  const curveFit = curveOutcome && !("error" in curveOutcome) ? curveOutcome : null;
  const demingParams = (options.demingAnalysisId ? nodes[options.demingAnalysisId]?.analysisParams : undefined) as
    DemingRegressionParams | undefined;
  // An XY scatter also draws a sibling binding analysis's fitted curve
  // (saturation or kinetics) — the same cached run (no extra R call).
  // Without one it draws only its own regression curve.
  const bindingAnalysis =
    type === "xy-scatter"
      ? analyses.find((n) => n.analysisType === "binding-saturation" || n.analysisType === "binding-kinetics")
      : undefined;
  const bindingOutcome = useAnalysis(bindingAnalysis?.analysisType, data, bindingAnalysis?.analysisParams);
  const bindingFit = bindingOutcome && !("error" in bindingOutcome) ? bindingOutcome : null;
  const bindingParams = (bindingAnalysis?.analysisParams ?? undefined) as
    BindingSaturationParams | BindingKineticsParams | undefined;
  // An XY scatter also draws a sibling enzyme-inhibition analysis's
  // fitted curves — one per inhibitor concentration — from the same cached
  // run (no extra R call), as the binding overlay above.
  const inhibitionAnalysis =
    type === "xy-scatter" ? analyses.find((n) => n.analysisType === "enzyme-inhibition") : undefined;
  const inhibitionOutcome = useAnalysis(inhibitionAnalysis?.analysisType, data, inhibitionAnalysis?.analysisParams);
  const inhibitionFit = inhibitionOutcome && !("error" in inhibitionOutcome) ? inhibitionOutcome : null;
  const inhibitionParams = (inhibitionAnalysis?.analysisParams ?? undefined) as EnzymeInhibitionParams | undefined;
  // An XY scatter also draws a sibling dose-response — Special
  // analysis's fitted curves — one per Y series — from the same cached
  // run (no extra R call), as the binding overlay above. A Schild plot
  // draws its computed points from a sibling Gaddum/Schild analysis.
  const specialAnalysis =
    type === "xy-scatter" || type === "schild-plot"
      ? analyses.find((n) => n.analysisType === "dose-response-special")
      : undefined;
  const specialOutcome = useAnalysis(specialAnalysis?.analysisType, data, specialAnalysis?.analysisParams);
  const specialFit = specialOutcome && !("error" in specialOutcome) ? specialOutcome : null;
  const specialParams = (specialAnalysis?.analysisParams ?? undefined) as DoseResponseSpecialParams | undefined;
  // A logistic-curve graph fits its own curve (no analysis node needed): the
  // first Y series is the binary outcome, as in the analysis's default.
  const logisticY = columns[1]?.name;
  const logisticOutcome = useAnalysis(
    type === "logistic-curve" && logisticY ? "simple-logistic-regression" : undefined,
    data,
    { y: logisticY },
  );
  const logisticFit = logisticOutcome && !("error" in logisticOutcome) ? logisticOutcome : null;
  // A forest plot draws a sibling Cox regression's hazard ratios, and a
  // survival curve on a Multiple Variables table stratifies by its binary
  // covariate — both from the same cached runAnalysis result (no extra R call).
  const coxAnalysis = options.coxAnalysisId ? nodes[options.coxAnalysisId] : undefined;
  const coxOutcome = useAnalysis(
    (type === "forest-plot" || (type === "survival" && parent?.tableType === "multiple")) &&
      coxAnalysis?.analysisType === "cox-proportional-hazards"
      ? "cox-proportional-hazards"
      : undefined,
    data,
    coxAnalysis?.analysisParams,
  );
  const coxResult = coxOutcome && !("error" in coxOutcome) ? coxOutcome : null;
  const coxParams = (coxAnalysis?.analysisParams ?? undefined) as CoxPHParams | undefined;
  // An observed-vs-fitted graph draws a sibling Poisson regression's fitted
  // counts (closed-form in TS from its coefficients) — the same cached
  // runAnalysis result, no extra R call. Without one it draws only its axes.
  const poissonAnalysis = options.poissonAnalysisId ? nodes[options.poissonAnalysisId] : undefined;
  const poissonOutcome = useAnalysis(
    type === "observed-fitted" && poissonAnalysis?.analysisType === "poisson-regression"
      ? "poisson-regression"
      : undefined,
    data,
    poissonAnalysis?.analysisParams,
  );
  const poissonResult = poissonOutcome && !("error" in poissonOutcome) ? poissonOutcome : null;
  const poissonParams = (poissonAnalysis?.analysisParams ?? undefined) as PoissonRegressionParams | undefined;
  // A scree plot or scores biplot draws a sibling Principal component
  // analysis's variance/loadings/scores — the same cached runAnalysis result
  // (no extra R call). Without one it draws only its axes, and the Format
  // panel says to run the analysis first — exactly like the forest plot.
  const pcaAnalysis = options.pcaAnalysisId ? nodes[options.pcaAnalysisId] : undefined;
  const pcaOutcome = useAnalysis(
    (type === "scree-plot" || type === "pca-biplot") &&
      pcaAnalysis?.analysisType === "principal-component-analysis"
      ? "principal-component-analysis"
      : undefined,
    data,
    pcaAnalysis?.analysisParams,
  );
  const pcaResult = pcaOutcome && !("error" in pcaOutcome) ? pcaOutcome : null;
  // A cluster scatter draws a sibling K-means clustering's assignments and
  // centres — the same cached runAnalysis result (no extra R call). Without
  // one it draws only its axes, and the Format panel says to run the
  // analysis first — exactly like the scree plot.
  const kmeansAnalysis = options.kmeansAnalysisId ? nodes[options.kmeansAnalysisId] : undefined;
  const kmeansOutcome = useAnalysis(
    type === "kmeans-scatter" && kmeansAnalysis?.analysisType === "k-means" ? "k-means" : undefined,
    data,
    kmeansAnalysis?.analysisParams,
  );
  const kmeansResult = kmeansOutcome && !("error" in kmeansOutcome) ? kmeansOutcome : null;
  // A smooth-curve graph draws a sibling Spline and Lowess analysis's fitted
  // curve — the same cached runAnalysis result (no extra R call). Without one
  // it draws only the points, and the Format panel prompts for one.
  const smoothAnalysis = options.smoothAnalysisId ? nodes[options.smoothAnalysisId] : undefined;
  const smoothOutcome = useAnalysis(
    type === "smooth-curve" && smoothAnalysis?.analysisType === "spline-lowess" ? "spline-lowess" : undefined,
    data,
    smoothAnalysis?.analysisParams,
  );
  const smoothResult = smoothOutcome && !("error" in smoothOutcome) ? smoothOutcome : null;
  // A Monte Carlo histogram draws a sibling Monte Carlo simulation's
  // statistic distribution — the same cached runAnalysis result (no extra R
  // call). Without one it draws only its axes, and the Format panel says to
  // run the analysis first — exactly like the scree plot.
  const mcAnalysis = options.monteCarloAnalysisId ? nodes[options.monteCarloAnalysisId] : undefined;
  const mcOutcome = useAnalysis(
    type === "monte-carlo-histogram" && mcAnalysis?.analysisType === "monte-carlo" ? "monte-carlo" : undefined,
    data,
    mcAnalysis?.analysisParams,
  );
  const mcResult = mcOutcome && !("error" in mcOutcome) ? mcOutcome : null;
  // A survival curve on a Multiple Variables table plots the Cox analysis's
  // time/status columns, stratified by its binary covariate (or one curve for
  // all subjects); without a Cox analysis it draws nothing — the Format panel
  // says to pick one.
  const coxSurvivalCols =
    type === "survival" && parent?.tableType === "multiple"
      ? coxResult && coxParams && data
        ? (coxSurvivalColumns(data, coxParams) ?? [])
        : []
      : undefined;

  // ── Drawing ──────────────────────────────────────────────────────────

  // Ctrl+scroll or a pinch zooms the view round the pointer: the spot of the sheet under
  // it (`anchor`, a fraction of the sheet) stays there, the view scrolling once the sheet
  // has its new size. A non-passive listener, so the page itself doesn't zoom.
  const sheetRef = React.useRef<HTMLDivElement>(null);
  const anchor = React.useRef<{ x: number; y: number; fx: number; fy: number } | null>(null);
  // Reset (below) also re-centres the desk: the zoom gesture's leftover scroll
  // would otherwise leave the sheet off-centre at the fit.
  const resetScroll = React.useRef(false);
  React.useEffect(() => {
    const el = canvasRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = sheetRef.current?.getBoundingClientRect();
      if (r)
        anchor.current = {
          x: e.clientX,
          y: e.clientY,
          fx: (e.clientX - r.left) / r.width,
          fy: (e.clientY - r.top) / r.height,
        };
      setExplicitZoom((z) => clamp((z ?? zoomRef.current) * (1 - e.deltaY * 0.01), ZOOM));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  React.useLayoutEffect(() => {
    const view = canvasRef.current;
    // Resetting the zoom returns to the fit — and to the fit's centred scroll:
    // the sheet fits the pane at the fit, so 0,0 is its centred position.
    if (resetScroll.current) {
      resetScroll.current = false;
      if (view) {
        view.scrollLeft = 0;
        view.scrollTop = 0;
      }
      return;
    }
    const a = anchor.current;
    const r = sheetRef.current?.getBoundingClientRect();
    anchor.current = null;
    if (!a || !r || !view) return;
    view.scrollLeft += r.left + a.fx * r.width - a.x;
    view.scrollTop += r.top + a.fy * r.height - a.y;
  }, [zoom]);

  // The volcano's points are WebGL pixels, not shapes: once a zoom gesture ends, they are
  // redrawn at the screen's resolution times the zoom (Plotly allows up to 4), so they stay sharp.
  const [settledZoom, setSettledZoom] = React.useState(1);
  React.useEffect(() => {
    const t = setTimeout(() => setSettledZoom(zoom), 200);
    return () => clearTimeout(t);
  }, [zoom]);
  const glRatio = family === "volcano" ? clamp(Math.ceil(devicePixelRatio * settledZoom * 2) / 2, GL_RATIO) : 2;

  /** Follows the plot's clicks, hovers and dragged-over points (once per drawn element). */
  const listen = (el: PlotElement) => {
    el.on("plotly_click", (e) => {
      const [key] = keysOf(e.points);
      if (key) onPlotClick.current(key, e.event.metaKey || e.event.shiftKey);
    });
    el.on("plotly_hover", (e) => (hovered.current = keysOf(e.points)[0] ?? null));
    el.on("plotly_unhover", () => (hovered.current = null));
    // Without an event: the drag was undone (Plotly's own double-click), nothing picked.
    el.on("plotly_selected", (e) => e && onPlotSelect.current(keysOf(e.points)));
    // A text moved by hand; a color legend's move comes as a restyle of its trace.
    const names = () => (el.layout.annotations ?? []).map((a) => a.name);
    el.on("plotly_relayout", (moved) => onPlotMove.current(moved, names()));
    el.on("plotly_restyle", ([moved]) => onPlotMove.current(moved, names()));
  };

  // Draws at the committed size. `Plotly.react` updates the chart in place, and an
  // explicit width and height make every draw a full, deterministic layout.
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || !hasData) return;
    let current = true;
    void loadPlotly().then(async (Plotly) => {
      if (!current) return;
      // The cluster scatter's series are its clusters (graphSeries has no
      // fixed list for them), so the paint is sized by the linked result's
      // cluster count — otherwise a gradient palette would colour every
      // cluster the same.
      const paint = paintOf(
        options,
        type === "kmeans-scatter" && kmeansResult?.kmeansClusters
          ? kmeansResult.kmeansClusters.length
          : seriesNames.length,
      );
      const fig = GRAPHS[type].build(coxSurvivalCols ?? volcanoColumns, buildOptions, paint, dataset?.titles);
      fig.data = withCaps(fig.data, options);
      if (family === "column" && options.sigAnalysisId) addSignificance(fig, columns, type, options, comparisons ?? []);
      if (type === "xy-scatter" && curveParams) {
        const { x, ys } = splitXY(columns);
        const fitted = curveParams.ys ?? [curveParams.y ?? ys[0]?.name ?? ""];
        const y0 = ys.find((s) => s.name === (curveParams.y ?? fitted[0])) ?? ys[0];
        if (curveFit && x && y0 && options.regShowLine)
          addFittedCurve(fig, x, y0, ys, curveParams.model, curveFit, options.regShowEquation, options, paint);
      } else if (type === "xy-scatter" && logistic) {
        const { x, ys } = splitXY(columns);
        const y = ys.find((s) => s.name === (regNode.analysisParams as SimpleLogisticRegressionParams)?.y) ?? ys[0];
        if (curveFit && x && y && options.regShowLine)
          addAnalysisLogisticCurve(fig, x, y, ys, curveFit, options.regShowEquation, options, paint);
      } else if (type === "xy-scatter" && regNode) addRegression(fig, columns, options, regParams, paint);
      if (type === "xy-scatter" && options.demingAnalysisId) addDeming(fig, columns, options, demingParams, paint);
      if (bindingFit && bindingParams) addBindingCurve(fig, columns, options, bindingFit, bindingParams, paint);
      if (inhibitionFit && inhibitionParams)
        addEnzymeInhibitionCurve(fig, columns, options, inhibitionFit, inhibitionParams, paint);
      if (specialFit && specialParams && type === "xy-scatter")
        addDoseResponseSpecialCurve(fig, columns, options, specialFit, specialParams, paint);
      if (type === "schild-plot") {
        if (
          specialFit &&
          specialParams &&
          (specialParams.model === "schild" || specialParams.model === "schild-slope-1")
        )
          addSchildPlot(fig, specialFit, specialParams, paint, options);
        else addNote(fig, "Run a Gaddum/Schild analysis on this table to draw the Schild plot.", options);
      }
      if (type === "smooth-curve" && smoothResult) addSmoothCurve(fig, columns, options, smoothResult, paint);
      if (type === "logistic-curve") {
        // A non-binary Y has no fit to draw: the build already leaves the
        // points on their own scale, and the runner's error is shown as a
        // note (F-02) instead of a silent empty 0–1 plot.
        if (logisticFit) addLogisticCurve(fig, columns, logisticFit, paint);
        else {
          const note = logisticCurveNote(logisticOutcome);
          if (note) addNote(fig, note, options);
        }
      }
      if (type === "forest-plot" && coxResult) addForestPlot(fig, coxResult, paint, options);
      if (type === "observed-fitted" && poissonResult)
        addObservedFitted(fig, columns, poissonResult, poissonParams, paint, options);
      if (type === "scree-plot") {
        if (pcaResult) addScreePlot(fig, pcaResult, paint);
        else addNote(fig, "Run a Principal component analysis on this table to draw the scree plot.", options);
      }
      if (type === "monte-carlo-histogram") {
        if (mcResult) addMonteCarloHistogram(fig, mcResult, paint);
        else
          addNote(fig, "Run a Monte Carlo simulation on this table to draw the histogram.", options);
      }
      if (type === "pca-biplot") {
        if (pcaResult) addPcaBiplot(fig, pcaResult, options, paint);
        else addNote(fig, "Run a Principal component analysis on this table to draw the scores biplot.", options);
      }
      if (type === "kmeans-scatter") {
        if (kmeansResult)
          addKmeansScatter(fig, columns, kmeansResult, options, paint, dataset?.titles);
        else addNote(fig, "Run a K-means clustering on this table to draw the cluster scatter.", options);
      }
      // The points' names are part of the figure (the volcano places its own, among the
      // genes it names); the selection ring only of the view.
      const labels =
        family === "volcano"
          ? []
          : pointLabels(fig.data, options.points, dataset?.titles, options.fontSize).map((label) => ({
              ...label,
              // A text sits at the log10 of its place on a log axis (X: only a numeric one).
              x: family === "xy" ? onAxis(label.x, options.xScale) : label.x,
              y: onAxis(label.y, options.yScale),
            }));
      if (labels.length) fig.layout.annotations = [...((fig.layout.annotations as unknown[]) ?? []), ...labels];
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent");
      const ring = selectionRing(fig.data, selected, accent);
      // A graph of individual points picks them by dragging; the others stay still.
      const keys = drawnKeys(fig.data);
      if (keys.size) fig.layout.dragmode = "select";
      await Plotly.react(
        el,
        ring ? [...fig.data, ring] : fig.data,
        { ...fig.layout, ...size },
        { displayModeBar: false, scrollZoom: false, doubleClick: false, plotGlPixelRatio: glRatio, edits: MOVABLE },
      );
      if (plottedRef.current !== el) listen(el as PlotElement);
      plottedRef.current = el;
      if (!current) return;
      setDrawn(fig.data);
      // A selected point that's no longer drawn (its row deleted…) leaves the selection.
      if ([...selected].some((key) => !keys.has(key)))
        setSelected(new Set([...selected].filter((key) => keys.has(key))));
      const resolved = (el as { _fullLayout?: PlotlyLayout })._fullLayout;
      if (resolved?._size) setMargins(resolved._size);
    });
    return () => {
      current = false;
    };
  }, [
    type,
    hasData,
    volcanoColumns,
    coxSurvivalCols,
    node.graphOptions,
    comparisons,
    regParams,
    curveParams,
    curveFit,
    bindingFit,
    bindingParams,
    inhibitionFit,
    inhibitionParams,
    specialFit,
    specialParams,
    smoothResult,
    logisticFit,
    logisticOutcome,
    coxResult,
    poissonResult,
    poissonParams,
    pcaResult,
    kmeansResult,
    mcResult,
    seriesNames.length,
    selected,
    glRatio,
  ]);

  // Frees Plotly's resources when the chart disappears (no data, or leaving the view).
  React.useEffect(() => {
    if (hasData) return;
    const el = plottedRef.current;
    plottedRef.current = null;
    if (el) void loadPlotly().then((Plotly) => Plotly.purge(el));
  }, [hasData]);
  React.useEffect(
    () => () => {
      const el = plottedRef.current;
      if (el) void loadPlotly().then((Plotly) => Plotly.purge(el));
    },
    [],
  );

  // Dragging an axis: X changes the width, Y the height. Only the outline follows
  // the pointer; the size is committed (and saved) on release.
  const onResize = (e: React.PointerEvent, axis: "x" | "y") => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, ...size };
    let next = size;
    const onMove = (ev: PointerEvent) => {
      // Screen pixels are divided by the view zoom.
      next = {
        width:
          axis === "x"
            ? clamp(Math.round(start.width + (ev.clientX - start.x) / zoom), GRAPH_LIMITS.width)
            : start.width,
        height:
          axis === "y"
            ? clamp(Math.round(start.height + (start.y - ev.clientY) / zoom), GRAPH_LIMITS.height)
            : start.height,
      };
      setDrag(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      set(next);
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const box = drag ?? size;
  const m = margins ?? marginsFor(options); // until Plotly reports the real ones

  // The fit follows the visible pane: the inspector opening or closing, the window
  // resizing, or the sheet itself changing size all refit it. The observer reads
  // the live sheet size through a ref, so it never goes stale.
  const boxRef = React.useRef(box);
  boxRef.current = box;
  React.useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const update = () =>
      setFit((prev) => {
        const next = fitZoom(el.clientWidth, el.clientHeight, boxRef.current.width, boxRef.current.height);
        return next === prev ? prev : next;
      });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <WithInspector
      title={node.name}
      tag={titleCase(GRAPHS[type].label)}
      inspector={
        <FormatPanel
          graphId={node.id}
          graphType={type}
          tableType={parent?.tableType}
          options={options}
          set={set}
          analyses={analyses}
          comparisons={comparisons}
          seriesNames={seriesNames}
          setSeriesStyle={setSeriesStyle}
          selection={
            firstStyle && {
              count: selected.size,
              style: firstStyle,
              styled: [...selected].some((key) => options.points?.[key]),
              set: (style) => styleSelected(selected, style),
              resize: (by) => resizeSelected(selected, by),
              reset: () => styleSelected(selected, null),
            }
          }
          volcanoGroups={volcanoGroups}
          volcanoLeftOut={volcanoLeftOut}
          volcanoBelowZero={volcanoBelowZero}
          logLeftOut={logLeftOut}
          binsTooMany={binsTooMany}
          replicates={parent?.tableType === "xy" && Boolean(parent.data && isGrouped(parent.data))}
          onFindGenes={findGenes}
          numericNames={dataset?.numeric.map((c) => c.name) ?? []}
          allNames={dataset?.columns.map((c) => c.name) ?? []}
          fitError={curveOutcome && "error" in curveOutcome ? curveOutcome.error : null}
          onNewAnalysis={(test) => {
            if (!node.parentId) return;
            if (test) startAnalysis(node.parentId, test);
            else openSelector({ kind: "new-analysis", tableId: node.parentId });
          }}
          canExport={hasData}
          onSave={(format, dpi) =>
            plottedRef.current && saveGraphImage(plottedRef.current, size, format, dpi, node.name)
          }
          onCopy={(dpi) => plottedRef.current && copyGraphImage(plottedRef.current, size, dpi)}
        />
      }
    >
      {/* The desk scrolls; the zoom level stays in its corner, over it. */}
      <div className="relative min-h-0 flex-1">
        <div ref={canvasRef} className="absolute inset-0 overflow-auto bg-desk">
          {hasData ? (
            <div className="flex min-h-full w-max min-w-full items-center p-12">
              {/* The sheet: exactly the exported image, white or checked (transparent). Zoomed, it
                  takes its zoomed size, so the view scrolls to every edge of it. `m-auto` (not
                  `justify-center`) centers it with room to spare and keeps its left edge
                  reachable when it overflows — centered flex content otherwise pushes the
                  left edge past where the scroll container can reach. */}
              <div
                ref={sheetRef}
                className="relative m-auto shrink-0"
                style={{ width: box.width * zoom, height: box.height * zoom }}
              >
                <div
                  className={cn(
                    "absolute top-0 left-0 shadow-sheet",
                    options.background === "transparent" ? "checkerboard" : "bg-white",
                  )}
                  style={{ ...box, transform: `scale(${zoom})`, transformOrigin: "0 0" }}
                >
                  {/* The plot, at the committed size; hidden while an axis is dragged. A click
                      that hit no point clears the selection; a right-click opens its menu. A
                      right press (or Control-click) never reaches Plotly: it would start a drag
                      and cover the window, a cover macOS never lifts after a context menu. */}
                  <div
                    ref={containerRef}
                    className={cn(drag && "invisible")}
                    style={size}
                    onMouseDownCapture={(e) => {
                      if (e.button === 2 || e.ctrlKey) return e.stopPropagation();
                      pressed.current = true;
                      dragAdds.current = e.metaKey || e.shiftKey;
                    }}
                    onClick={() => {
                      if (!pointClicked.current) clearSelection();
                      pointClicked.current = false;
                      pressed.current = false;
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openSelectionMenu(hovered.current);
                    }}
                  />
                  {drag && (
                    <svg className="pointer-events-none absolute inset-0" width={drag.width} height={drag.height}>
                      <path
                        d={`M${m.l} ${m.t}V${drag.height - m.b}H${drag.width - m.r}`}
                        fill="none"
                        stroke={INK}
                        strokeWidth={1.5}
                      />
                    </svg>
                  )}
                  {/* Invisible grab zones on the axes: the cursor is the only hint. */}
                  <div
                    onPointerDown={(e) => onResize(e, "x")}
                    role="slider"
                    aria-label="Resize width"
                    title="Drag the X axis to resize"
                    className="absolute z-10 cursor-ew-resize rounded-full hover:bg-accent/10"
                    style={{ left: m.l, right: m.r, bottom: m.b - 7, height: 14 }}
                  />
                  <div
                    onPointerDown={(e) => onResize(e, "y")}
                    role="slider"
                    aria-label="Resize height"
                    title="Drag the Y axis to resize"
                    className="absolute z-10 cursor-ns-resize rounded-full hover:bg-accent/10"
                    style={{ left: m.l - 7, width: 14, top: m.t, bottom: m.b }}
                  />
                  {/* Its size, under it and unscaled, live while an axis is dragged. */}
                  <p
                    className="absolute top-full right-0 left-0 mt-2 text-center text-small text-secondary tabular-nums"
                    style={{ transform: `scale(${1 / zoom})`, transformOrigin: "top" }}
                  >
                    {Math.round(box.width)} × {Math.round(box.height)} px
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-regular text-secondary">
                {lack ?? "Enter numeric data in the source table to draw this graph."}
              </p>
            </div>
          )}
        </div>
        {explicitZoom !== null && (
          <button
            type="button"
            onClick={() => {
              // The layout effect above re-centres once the fit re-renders; if
              // the zoom is already the fit, no re-render follows, so re-centre now.
              resetScroll.current = true;
              setExplicitZoom(null);
              if (explicitZoom === fit && canvasRef.current) {
                canvasRef.current.scrollLeft = 0;
                canvasRef.current.scrollTop = 0;
              }
            }}
            title="Reset zoom to fit"
            className="absolute right-3 bottom-3 z-20 rounded-full bg-black/70 px-2.5 py-1 text-small text-white hover:bg-black/80"
          >
            {Math.round(zoom * 100)}%
          </button>
        )}
      </div>
    </WithInspector>
  );
}

/** A drawn plot, which reports what happens on its points and texts. */
interface PlotEvent {
  points: { customdata?: unknown }[];
  event: MouseEvent;
}
/** What Plotly reports of a text moved: its new place, by attribute ("legend.x"…). */
type PlotMove = Record<string, number | undefined>;
type PlotElement = HTMLDivElement & {
  layout: { annotations?: { name?: string }[] };
  on(name: "plotly_relayout", handler: (moved: PlotMove) => void): void;
  on(name: "plotly_restyle", handler: (update: [PlotMove, number[]]) => void): void;
  on(name: string, handler: (e: PlotEvent) => void): void;
};

/** The part of Plotly's resolved layout read back after drawing. */
interface PlotlyLayout {
  _size?: Margins;
}
