// The figure editor: the grid on canvas, with a panel toolbar (add / remove /
// move / resize) and a properties panel (grid size, figure size, labels,
// title, shared legend, export DPI). The editor is the preview: panels render
// with the real graph renderers at editor scale, labels and titles drawn as
// they will export. Double-clicking a panel opens that graph's own editor;
// the figure editor itself never edits graph options — it only arranges graphs.
import * as React from "react";
import { Button, Field, Input, NumberInput, RadioList, Segmented, Select, Switch, cn } from "../../ui/controls";
import { Section, WithInspector } from "../../components/inspector";
import {
  DEFAULT_FIGURE_DPI,
  DEFAULT_FIGURE_SIZE,
  DEFAULT_LABEL_STYLE,
  FIGURE_MAX_COLS,
  FIGURE_RESOLUTIONS,
  LABEL_POSITIONS,
} from "../../lib/figure";
import {
  assignLabels,
  clampPanel,
  duplicateLabels,
  firstFreeCell,
  hasEmptyCell,
  missingPanels,
  panelsOverlap,
  sharedLegendCheck,
  validateFigureSize,
} from "../../lib/figure";
import { useProjectStore } from "../../store/use-project-store";
import { fitZoom } from "../../store/use-layout";
import { GRAPHS } from "../graphs";
import { DEFAULT_GRAPH_OPTIONS, type FigurePanel, type ProjectNode, type Resolution } from "../../store/types";
import { PanelPlot } from "./panel-plot";
import { copyFigureImage, saveFigureImage } from "./figure-export";
import { saveGraphImage, type ExportFormat } from "../graphs/graph-export";

/** Screen pixels per inch in the editor (the figure keeps its true aspect ratio). */
const SCREEN_PX_PER_IN = 72;

export function FigureView({ node }: { node: ProjectNode }) {
  const { nodes, updateFigure, setActiveNode } = useProjectStore();
  const panels = node.panels ?? [];
  const grid = node.grid ?? { rows: 1, cols: 1 };
  const figureSize = node.figureSize ?? { ...DEFAULT_FIGURE_SIZE };
  const labelStyle = node.labelStyle ?? { ...DEFAULT_LABEL_STYLE };
  const figureTitle = node.figureTitle ?? "";
  const sharedLegend = node.sharedLegend ?? "none";
  const dpi = node.dpi ?? DEFAULT_FIGURE_DPI;

  const set = (patch: Parameters<typeof updateFigure>[1]) => updateFigure(node.id, patch);
  const setPanels = (next: FigurePanel[]) => set({ panels: next });

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected = panels.find((p) => p.graphId === selectedId) ?? null;
  const [addGraphId, setAddGraphId] = React.useState("");
  const [exportFormat, setExportFormat] = React.useState<ExportFormat>("png");
  const [exporting, setExporting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sizeError, setSizeError] = React.useState<string | null>(null);
  // The drawn panel elements, for per-panel export (the graph's own export path).
  const plottedRef = React.useRef(new Map<string, HTMLElement>());
  // The view-only fit, as in the graph view: the figure is scaled to the visible
  // pane (the inspector is a flex sibling, so the pane narrows when it opens).
  // The saved figure size never changes — fitting only scales the view.
  const canvasRef = React.useRef<HTMLDivElement>(null);
  const [fit, setFit] = React.useState(1);

  const graphs = Object.values(nodes).filter((n) => n.type === "graph");
  const available = graphs.filter((g) => !panels.some((p) => p.graphId === g.id));
  const missing = missingPanels(panels, nodes);
  const legend = sharedLegendCheck(panels, nodes);
  const dupes = duplicateLabels(panels);

  const addPanel = (graphId: string) => {
    const graph = nodes[graphId];
    if (!graph) return;
    const cell = firstFreeCell(panels, grid);
    const row = cell?.row ?? grid.rows - 1;
    const col = cell?.col ?? grid.cols - 1;
    // No free cell: grow a row (up to the grid's rows, else a new row) rather
    // than stacking a panel on top of another.
    const nextGrid = cell ? grid : { rows: grid.rows + 1, cols: grid.cols };
    const panel: FigurePanel = {
      graphId,
      graphName: graph.name,
      label: "",
      title: "",
      row: cell ? row : grid.rows,
      col: cell ? col : 0,
      rowSpan: 1,
      colSpan: 1,
    };
    const next = assignLabels([...panels, panel]);
    set({ panels: next, grid: nextGrid });
    setSelectedId(graphId);
    setAddGraphId("");
  };

  const removePanel = (graphId: string) => {
    setPanels(panels.filter((p) => p.graphId !== graphId));
    if (selectedId === graphId) setSelectedId(null);
  };

  const movePanel = (panel: FigurePanel, dr: number, dc: number) => {
    const row = panel.row + dr;
    const col = panel.col + dc;
    if (row < 0 || col < 0 || row + panel.rowSpan > grid.rows || col + panel.colSpan > grid.cols) return;
    const occupant = panels.find((p) => p !== panel && row < p.row + p.rowSpan && p.row < row + panel.rowSpan && col < p.col + p.colSpan && p.col < col + panel.colSpan);
    const next = panels.map((p) => {
      if (p === panel) return { ...p, row, col };
      if (occupant && p === occupant) return { ...p, row: panel.row, col: panel.col };
      return p;
    });
    setPanels(next);
  };

  const resizePanel = (panel: FigurePanel, rowSpan: number, colSpan: number) => {
    const next = { ...panel, rowSpan: Math.max(1, rowSpan), colSpan: Math.max(1, colSpan) };
    const clamped = clampPanel(next, grid);
    if (panels.some((p) => p !== panel && panelsOverlap(clamped, p))) {
      setError("That span would overlap another panel.");
      return;
    }
    setError(null);
    setPanels(panels.map((p) => (p === panel ? clamped : p)));
  };

  const setLabel = (panel: FigurePanel, label: string) => {
    const next = panels.map((p) =>
      p === panel ? { ...p, label, labelManual: label.trim() !== "" } : p,
    );
    if (duplicateLabels(next).length) {
      setError(`Two panels can't share the label “${label}”.`);
      return;
    }
    setError(null);
    setPanels(assignLabels(next));
  };

  const changeSize = (widthIn: number | null, heightIn: number | null) => {
    const size = { widthIn: widthIn ?? figureSize.widthIn, heightIn: heightIn ?? figureSize.heightIn };
    const checked = validateFigureSize(size);
    if (checked.reason) {
      setSizeError(checked.reason);
      return;
    }
    setSizeError(null);
    set({ figureSize: checked.size! });
  };

  const changeGrid = (rows: number | null, cols: number | null) => {
    const next = {
      rows: Math.max(1, Math.min(6, rows ?? grid.rows)),
      cols: Math.max(1, Math.min(FIGURE_MAX_COLS, cols ?? grid.cols)),
    };
    set({ grid: next, panels: panels.map((p) => clampPanel(p, next)) });
  };

  const onExport = async () => {
    setExporting(true);
    try {
      await saveFigureImage(node, nodes, exportFormat, dpi, node.name);
    } finally {
      setExporting(false);
    }
  };

  const widthPx = Math.round(figureSize.widthIn * SCREEN_PX_PER_IN);
  const heightPx = Math.round(figureSize.heightIn * SCREEN_PX_PER_IN);
  const cellW = widthPx / grid.cols;
  const cellH = heightPx / grid.rows;

  React.useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const update = () =>
      setFit((prev) => {
        const next = fitZoom(el.clientWidth, el.clientHeight, widthPx, heightPx);
        return next === prev ? prev : next;
      });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [widthPx, heightPx]);

  const inspector = (
    <>
      <Section title="Panels">
        <div className="flex flex-col gap-2">
          <Select
            value={addGraphId}
            onChange={(v) => setAddGraphId(v)}
            placeholder={available.length ? "Add a graph…" : "All graphs are already in this figure"}
            options={available.map((g) => ({
              value: g.id,
              label: `${nodes[g.parentId ?? ""]?.name ?? ""} — ${g.name} (${GRAPHS[g.graphType!]?.label ?? g.graphType})`,
            }))}
          />
          <Button disabled={!addGraphId} onClick={() => addGraphId && addPanel(addGraphId)}>
            Add Panel
          </Button>
          <p className="text-small text-secondary">
            A graph can appear in a figure only once — to use it twice, duplicate the graph first.
          </p>
          {selected && (
            <div className="flex flex-col gap-2 border-t border-separator pt-2">
              <Field label="Label">
                <Input
                  value={selected.label}
                  aria-label="Panel label"
                  onChange={(e) => setLabel(selected, e.target.value)}
                />
              </Field>
              <p className="text-small text-secondary">
                Labels are assigned A, B, C… in reading order; a label you type sticks to the panel when it moves.
              </p>
              <Field label="Panel title">
                <Input
                  value={selected.title}
                  aria-label="Panel title"
                  placeholder="Optional"
                  onChange={(e) =>
                    setPanels(panels.map((p) => (p === selected ? { ...p, title: e.target.value } : p)))
                  }
                />
              </Field>
              <Field label="Rows spanned">
                <NumberInput
                  value={selected.rowSpan}
                  aria-label="Rows spanned"
                  onChange={(v) => v !== null && resizePanel(selected, v, selected.colSpan)}
                />
              </Field>
              <Field label="Columns spanned">
                <NumberInput
                  value={selected.colSpan}
                  aria-label="Columns spanned"
                  onChange={(v) => v !== null && resizePanel(selected, selected.rowSpan, v)}
                />
              </Field>
              <div className="flex gap-1">
                <Button onClick={() => movePanel(selected, 0, -1)}>←</Button>
                <Button onClick={() => movePanel(selected, 0, 1)}>→</Button>
                <Button onClick={() => movePanel(selected, -1, 0)}>↑</Button>
                <Button onClick={() => movePanel(selected, 1, 0)}>↓</Button>
                <Button
                  onClick={() => {
                    const graph = nodes[selected.graphId];
                    if (graph) setActiveNode(graph.id);
                  }}
                >
                  Open Graph
                </Button>
                <Button variant="ghost" onClick={() => removePanel(selected.graphId)}>
                  Remove
                </Button>
              </div>
              {error && <p className="text-small text-red-600">{error}</p>}
            </div>
          )}
        </div>
      </Section>
      <Section title="Layout">
        <div className="flex flex-col gap-2">
          <Field label="Rows">
            <NumberInput value={grid.rows} aria-label="Grid rows" onChange={(v) => changeGrid(v, null)} />
          </Field>
          <Field label="Columns">
            <NumberInput value={grid.cols} aria-label="Grid columns" onChange={(v) => changeGrid(null, v)} />
          </Field>
          <Field label="Width (in)">
            <NumberInput
              value={figureSize.widthIn}
              aria-label="Figure width in inches"
              onChange={(v) => changeSize(v, null)}
            />
          </Field>
          <Field label="Height (in)">
            <NumberInput
              value={figureSize.heightIn}
              aria-label="Figure height in inches"
              onChange={(v) => changeSize(null, v)}
            />
          </Field>
          {sizeError && <p className="text-small text-red-600">{sizeError}</p>}
          <Field label="Figure title">
            <Input
              value={figureTitle}
              aria-label="Figure title"
              placeholder="Optional"
              onChange={(e) => set({ figureTitle: e.target.value })}
            />
          </Field>
        </div>
      </Section>
      <Section title="Labels">
        <div className="flex flex-col gap-2">
          <Field label="Position">
            <Select
              value={labelStyle.position}
              onChange={(v) => set({ labelStyle: { ...labelStyle, position: v } })}
              options={LABEL_POSITIONS}
            />
          </Field>
          <Field label="Font size (pt)">
            <NumberInput
              value={labelStyle.fontSizePt}
              aria-label="Label font size in points"
              onChange={(v) => v !== null && set({ labelStyle: { ...labelStyle, fontSizePt: Math.max(8, Math.min(28, v)) } })}
            />
          </Field>
          <Field label="Bold">
            <Switch checked={labelStyle.bold} onChange={(v) => set({ labelStyle: { ...labelStyle, bold: v } })} />
          </Field>
        </div>
      </Section>
      <Section title="Legend">
        <div className="flex flex-col gap-2">
          <Field label="Shared legend">
            <Switch
              checked={sharedLegend === "shared"}
              disabled={sharedLegend !== "shared" && !legend.ok}
              onChange={(v) => set({ sharedLegend: v ? "shared" : "none" })}
            />
          </Field>
          {!legend.ok && sharedLegend !== "shared" && (
            <p className="text-small text-secondary">{legend.reason}</p>
          )}
          {sharedLegend === "shared" && (
            <p className="text-small text-secondary">One legend below the grid; per-panel legends are hidden.</p>
          )}
        </div>
      </Section>
      <Section title="Export">
        <div className="flex flex-col gap-2">
          <RadioList
            value={exportFormat}
            onChange={setExportFormat}
            options={[
              { value: "png", label: "PNG" },
              { value: "jpeg", label: "JPG" },
              { value: "svg", label: "SVG" },
            ]}
          />
          <Field label="Resolution">
            <Segmented
              value={dpi}
              onChange={(v) => set({ dpi: v })}
              options={FIGURE_RESOLUTIONS.map((r) => ({ value: r as Resolution, label: `${r} DPI` }))}
            />
          </Field>
          <Button disabled={!panels.length || exporting} onClick={onExport}>
            {exporting ? "Exporting…" : `Export Figure (${dpi} DPI)`}
          </Button>
          <Button
            variant="ghost"
            disabled={!panels.length || exporting}
            onClick={() => copyFigureImage(node, nodes, dpi)}
          >
            Copy Figure (PNG)
          </Button>
          {hasEmptyCell(panels, grid) && (
            <p className="text-small text-secondary">The figure has an empty cell — it exports blank.</p>
          )}
        </div>
      </Section>
    </>
  );

  return (
    <WithInspector title={node.name} tag="Figure" inspector={inspector}>
      <div className="relative min-h-0 flex-1">
        <div ref={canvasRef} className="absolute inset-0 overflow-auto bg-desk">
          {panels.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-regular text-secondary">This figure has no panels yet — add a graph above.</p>
            </div>
          ) : (
            <div className="flex min-h-full w-max min-w-full items-center p-12">
              <div className="m-auto shrink-0">
                {figureTitle && (
                  <p className="mb-2 text-center text-large-strong">{figureTitle}</p>
                )}
                {panels.length === 1 && (
                  <p className="mb-2 text-center text-small text-secondary">
                    A figure with one panel is the same as the graph itself — export the graph instead?
                  </p>
                )}
                {missing.length > 0 && (
                  <p className="mb-2 text-center text-small text-red-600">
                    {missing.length} panel{missing.length === 1 ? "" : "s"} couldn&apos;t be drawn —{" "}
                    {missing.length === 1 ? "its" : "their"} graph is missing.
                  </p>
                )}
                {dupes.length > 0 && (
                  <p className="mb-2 text-center text-small text-red-600">
                    Duplicate label{ dupes.length === 1 ? "" : "s" }: {dupes.join(", ")}.
                  </p>
                )}
                {/* The grid at its saved size, scaled by the fit: the wrapper takes the
                    scaled size, so the view scrolls to every edge of it. */}
                <div style={{ width: widthPx * fit, height: heightPx * fit }}>
                  <div
                    className="grid bg-white shadow-sheet"
                    style={{
                      width: widthPx,
                      height: heightPx,
                      transform: `scale(${fit})`,
                      transformOrigin: "0 0",
                      gridTemplateColumns: `repeat(${grid.cols}, 1fr)`,
                      gridTemplateRows: `repeat(${grid.rows}, 1fr)`,
                    }}
                  >
                  {panels.map((panel) => {
                    const graph = nodes[panel.graphId];
                    const w = Math.round(panel.colSpan * cellW);
                    const h = Math.round(panel.rowSpan * cellH);
                    return (
                      <div
                        key={panel.graphId}
                        className={cn(
                          "relative overflow-hidden ring-1 ring-separator",
                          selectedId === panel.graphId && "ring-2 ring-accent",
                        )}
                        style={{ gridRow: `${panel.row + 1} / span ${panel.rowSpan}`, gridColumn: `${panel.col + 1} / span ${panel.colSpan}` }}
                        onClick={() => setSelectedId(panel.graphId)}
                        onDoubleClick={() => graph && setActiveNode(graph.id)}
                      >
                        {!graph ? (
                          <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-white px-2 text-center">
                            <p className="text-regular">Graph deleted — pick a replacement</p>
                            <p className="text-small text-secondary">
                              {panel.graphName ? `“${panel.graphName}” is missing.` : "The graph this panel showed is gone."}
                            </p>
                            <Button variant="ghost" onClick={() => removePanel(panel.graphId)}>
                              Remove Panel
                            </Button>
                          </div>
                        ) : (
                          <>
                            <PanelPlot
                              graph={graph}
                              nodes={nodes}
                              width={w}
                              height={h}
                              hideLegend={sharedLegend === "shared" && legend.ok}
                              onPlot={(el) => {
                                if (el) plottedRef.current.set(panel.graphId, el);
                                else plottedRef.current.delete(panel.graphId);
                              }}
                            />
                            <span className="absolute top-1 left-2 text-regular font-bold">{panel.label}</span>
                            {panel.title && (
                              <span className="absolute top-1 left-1/2 -translate-x-1/2 text-small font-bold">
                                {panel.title}
                              </span>
                            )}
                            <button
                              type="button"
                              className="absolute right-1 bottom-1 rounded bg-black/60 px-1.5 py-0.5 text-small text-white"
                              title="Export this panel (the graph's own export)"
                              onClick={(e) => {
                                e.stopPropagation();
                                const el = plottedRef.current.get(panel.graphId);
                                const options = { ...DEFAULT_GRAPH_OPTIONS, ...graph.graphOptions };
                                if (el) void saveGraphImage(el, { width: options.width, height: options.height }, exportFormat, dpi, graph.name);
                              }}
                            >
                              Export panel
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
                </div>
                {sharedLegend === "shared" && legend.entries && (
                  <div className="mt-2 flex justify-center gap-4 text-small">
                    {legend.entries.map((e) => (
                      <span key={e.name} className="flex items-center gap-1">
                        <span className="inline-block size-2.5" style={{ background: e.color }} />
                        {e.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </WithInspector>
  );
}
