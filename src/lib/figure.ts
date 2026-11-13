// A multi-panel figure: several existing graphs composed into one labelled
// publication figure. The figure holds references to graph nodes, never copies
// of them — editing a graph updates its panel automatically, and deleting a
// graph leaves a placeholder panel instead of deleting the panel silently.
// Pure logic (no React, no Plotly): the editor and the exporter both build on
// these functions, and the tests drive them directly.

import { largestAt, PX_PER_INCH } from "./image-dpi";
import { graphSeries } from "../views/graphs";
import { paintOf } from "../views/graphs/plot-helpers";
import {
  DEFAULT_GRAPH_OPTIONS,
  type FigureGrid,
  type FigureLabelStyle,
  type FigurePanel,
  type FigureSize,
  type LabelPosition,
  type ProjectNode,
  type Resolution,
  type SharedLegend,
} from "../store/types";

/** The figure's defaults (see the plan): US Letter landscape usable area,
 *  bold 12 pt labels top-left, no title, no shared legend, 600 DPI. */
export const DEFAULT_FIGURE_SIZE: FigureSize = { widthIn: 10, heightIn: 7.5 };
export const DEFAULT_LABEL_STYLE: FigureLabelStyle = { position: "top-left", fontSizePt: 12, bold: true };
export const DEFAULT_FIGURE_DPI: Resolution = "600";
export const FIGURE_RESOLUTIONS: Resolution[] = ["150", "300", "600"];
/** A figure's page, in inches: papers are in inches, and beyond this is
 *  almost certainly a typo (also see the 4:1 aspect rule below). */
export const FIGURE_SIZE_LIMITS = { min: 1, max: 20 };
/** The editor wraps a new row after this many columns (the user may raise it to 6). */
export const FIGURE_MAX_COLS_DEFAULT = 4;
export const FIGURE_MAX_COLS = 6;
/** Points per inch (an SVG's unit). */
export const PT_PER_INCH = 72;

// ── Labels ───────────────────────────────────────────────────────────────

/** The label of the `n`th panel (0-based) in reading order: A…Z, then AA, AB… */
export function figureLabel(n: number): string {
  let label = "";
  let i = n;
  do {
    label = String.fromCharCode(65 + (i % 26)) + label;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return label;
}

/** Panels in reading order (row-major, then column). */
export function readingOrder(panels: FigurePanel[]): FigurePanel[] {
  return [...panels].sort((a, b) => a.row - b.row || a.col - b.col || a.graphId.localeCompare(b.graphId));
}

/** Labels (re)assigned in reading order — except a panel whose label was
 *  typed by hand, which keeps its own (it sticks to the panel, not the cell).
 *  Returns new panels; the input is untouched. */
export function assignLabels(panels: FigurePanel[]): FigurePanel[] {
  let n = 0;
  const used = new Set(panels.filter((p) => p.labelManual).map((p) => p.label));
  return readingOrder(panels).map((p) => {
    if (p.labelManual) return p;
    let label = figureLabel(n++);
    while (used.has(label)) label = figureLabel(n++);
    used.add(label);
    return { ...p, label };
  });
}

/** Labels used more than once (after a manual override): rejected at edit time. */
export function duplicateLabels(panels: FigurePanel[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const p of panels) {
    if (seen.has(p.label)) dupes.add(p.label);
    seen.add(p.label);
  }
  return [...dupes];
}

// ── Grid ─────────────────────────────────────────────────────────────────

/** A new figure over `graphIds` (in the order given): 1 row × N columns,
 *  wrapping to a new row after the default max columns. */
export function newFigurePanels(
  graphIds: string[],
  graphNames: Record<string, string> = {},
): { panels: FigurePanel[]; grid: FigureGrid } {
  const cols = Math.max(1, Math.min(graphIds.length || 1, FIGURE_MAX_COLS_DEFAULT));
  const panels = assignLabels(
    graphIds.map((graphId, i) => ({
      graphId,
      graphName: graphNames[graphId],
      label: "",
      title: "",
      row: Math.floor(i / cols),
      col: i % cols,
      rowSpan: 1,
      colSpan: 1,
    })),
  );
  const grid = { rows: Math.max(1, Math.ceil(graphIds.length / cols)), cols };
  return { panels, grid };
}

/** Whether two panels' cells overlap. */
export function panelsOverlap(a: FigurePanel, b: FigurePanel): boolean {
  return a.row < b.row + b.rowSpan && b.row < a.row + a.rowSpan && a.col < b.col + b.colSpan && b.col < a.col + a.colSpan;
}

/** The first empty cell of the grid (row-major), if any — where a new panel goes. */
export function firstFreeCell(panels: FigurePanel[], grid: FigureGrid): { row: number; col: number } | null {
  for (let row = 0; row < grid.rows; row++)
    for (let col = 0; col < grid.cols; col++)
      if (!panels.some((p) => row >= p.row && row < p.row + p.rowSpan && col >= p.col && col < p.col + p.colSpan))
        return { row, col };
  return null;
}

/** Whether any cell of the grid is empty (a panel spans, leaving a gap): the
 *  editor warns about it at export time, but it is allowed. */
export function hasEmptyCell(panels: FigurePanel[], grid: FigureGrid): boolean {
  return firstFreeCell(panels, grid) !== null;
}

/** A panel brought inside the grid: its row/col clamped, its spans at least 1
 *  and never past the grid's edge. */
export function clampPanel(panel: FigurePanel, grid: FigureGrid): FigurePanel {
  const row = Math.max(0, Math.min(grid.rows - 1, Math.floor(panel.row) || 0));
  const col = Math.max(0, Math.min(grid.cols - 1, Math.floor(panel.col) || 0));
  return {
    ...panel,
    row,
    col,
    rowSpan: Math.max(1, Math.min(grid.rows - row, Math.floor(panel.rowSpan) || 1)),
    colSpan: Math.max(1, Math.min(grid.cols - col, Math.floor(panel.colSpan) || 1)),
  };
}

// ── Size ─────────────────────────────────────────────────────────────────

/** A figure's size in pixels at `dpi` (the exported image's size). */
export function figurePixelSize(size: FigureSize, dpi: number): { width: number; height: number } {
  return { width: Math.round(size.widthIn * dpi), height: Math.round(size.heightIn * dpi) };
}

/** The size a figure actually exports at: its size, unless that exceeds the
 *  pixel cap — then the largest fitting size in the same proportions (via
 *  `largestAt`, exactly like a single graph), with the reason to show the user.
 *  Never silently downscales: `capped` says so. */
export function figureExportSize(
  size: FigureSize,
  dpi: number,
): { width: number; height: number; capped: boolean; reason?: string } {
  const at96 = { width: size.widthIn * PX_PER_INCH, height: size.heightIn * PX_PER_INCH };
  const most = largestAt(at96, dpi);
  const capped = most.width < at96.width || most.height < at96.height;
  const px = { width: Math.round((most.width * dpi) / PX_PER_INCH), height: Math.round((most.height * dpi) / PX_PER_INCH) };
  return capped
    ? {
        ...px,
        capped: true,
        reason: `At ${dpi} DPI, the largest figure Titer exports is ${px.width} × ${px.height} px. Choose a lower resolution, or make the figure smaller.`,
      }
    : { ...px, capped: false };
}

/** A figure size as typed, within 1–20 in each dimension and an aspect ratio
 *  no more extreme than 4:1 — beyond that is almost certainly a typo. Returns
 *  the size to keep, or the reason it cannot be kept. */
export function validateFigureSize(size: FigureSize): { size?: FigureSize; reason?: string } {
  const { min, max } = FIGURE_SIZE_LIMITS;
  const widthIn = Math.min(max, Math.max(min, size.widthIn || 0));
  const heightIn = Math.min(max, Math.max(min, size.heightIn || 0));
  if (widthIn / heightIn > 4 || heightIn / widthIn > 4)
    return { reason: "A figure's width and height must be within 4× of each other." };
  if (widthIn !== size.widthIn || heightIn !== size.heightIn)
    return { reason: `Figure size must be between ${min} and ${max} inches in each dimension.` };
  return { size: { widthIn, heightIn } };
}

/** A resolution as saved, or the default when it is not one Titer offers. */
export function figureDpi(dpi: unknown): Resolution {
  return typeof dpi === "string" && FIGURE_RESOLUTIONS.includes(dpi as Resolution) ? (dpi as Resolution) : DEFAULT_FIGURE_DPI;
}

// ── Layout geometry ──────────────────────────────────────────────────────

/** Where a panel sits in the exported image: its cell's rectangle, in pixels
 *  at `dpi`. Same-span panels get the same cell size; panels align on the
 *  grid by cell edge (their axes are independent — the plan promises no shared
 *  axes). */
export function panelRects(
  panels: FigurePanel[],
  grid: FigureGrid,
  size: FigureSize,
  dpi: number,
): { panel: FigurePanel; x: number; y: number; width: number; height: number }[] {
  const { width, height } = figurePixelSize(size, dpi);
  const cellW = width / grid.cols;
  const cellH = height / grid.rows;
  return panels.map((panel) => ({
    panel,
    x: Math.round(panel.col * cellW),
    y: Math.round(panel.row * cellH),
    width: Math.round(panel.colSpan * cellW),
    height: Math.round(panel.rowSpan * cellH),
  }));
}

/** A panel's size as Plotly sees it: the size the exporter hands to
 *  `Plotly.react` and `Plotly.toImage` for that panel. Plotly's `toImage`
 *  multiplies width/height by its `scale` (dpi/96), so this must be the
 *  rectangle in Plotly's own 96-DPI layout units — handing it the rectangle
 *  (already in DPI pixels) scales twice, and at 600 DPI a 3000×4500 panel
 *  becomes a 18750×28125 image, past what WebKit draws. */
export function panelPlotSize(rect: { width: number; height: number }, dpi: number): { width: number; height: number } {
  return {
    width: Math.round((rect.width * PX_PER_INCH) / dpi),
    height: Math.round((rect.height * PX_PER_INCH) / dpi),
  };
}

/** The same rectangles in points (an SVG's units): 1 pt = 1/72 in. */
export function panelRectsPt(
  panels: FigurePanel[],
  grid: FigureGrid,
  size: FigureSize,
): { panel: FigurePanel; x: number; y: number; width: number; height: number }[] {
  const cellW = (size.widthIn * PT_PER_INCH) / grid.cols;
  const cellH = (size.heightIn * PT_PER_INCH) / grid.rows;
  return panels.map((panel) => ({
    panel,
    x: panel.col * cellW,
    y: panel.row * cellH,
    width: panel.colSpan * cellW,
    height: panel.rowSpan * cellH,
  }));
}

// ── Shared legend ────────────────────────────────────────────────────────

/** Whether the figure may draw one shared legend: only when every panel's
 *  graph has the identical set of series, each in the identical colour. Same
 *  names in different colours would make a shared legend wrong, so that is
 *  refused too (edge case 7). `nodes` is the project's nodes, by id. */
export function sharedLegendCheck(
  panels: FigurePanel[],
  nodes: Record<string, ProjectNode>,
): { ok: boolean; reason?: string; entries?: { name: string; color: string }[] } {
  if (panels.length < 2) return { ok: false, reason: "A shared legend needs at least two panels." };
  let entries: { name: string; color: string }[] | null = null;
  for (const panel of panels) {
    const graph = nodes[panel.graphId];
    if (!graph || graph.type !== "graph" || !graph.graphType || !graph.graphOptions)
      return { ok: false, reason: `Panel ${panel.label || "“" + (panel.graphName ?? panel.graphId) + "”"} has no graph to read a legend from.` };
    const table = graph.parentId ? nodes[graph.parentId] : undefined;
    if (!table?.data || !table.tableType)
      return { ok: false, reason: `Panel ${panel.label} has no table to read a legend from.` };
    const options = { ...DEFAULT_GRAPH_OPTIONS, ...graph.graphOptions };
    const names = graphSeries(graph.graphType, table.data, table.tableType, options);
    const paint = paintOf(options, names.length);
    const mine = names.map((name, i) => ({ name, color: paint.color(name, i) }));
    if (!entries) {
      entries = mine;
      continue;
    }
    const same =
      mine.length === entries.length &&
      mine.every((m, i) => m.name === entries![i].name && m.color.toLowerCase() === entries![i].color.toLowerCase());
    if (!same)
      return {
        ok: false,
        reason:
          mine.length !== entries.length || mine.some((m, i) => m.name !== entries![i].name)
            ? "Panels have different series — a shared legend would be wrong."
            : "Panels use different colours for the same series — a shared legend would be wrong.",
      };
  }
  return { ok: true, entries: entries ?? [] };
}

// ── Missing graphs ───────────────────────────────────────────────────────

/** Panels whose graph is gone (deleted, or from an older Titer): they stay as
 *  placeholders naming the graph, and export leaves their cell blank. */
export function missingPanels(panels: FigurePanel[], nodes: Record<string, ProjectNode>): FigurePanel[] {
  return panels.filter((p) => !nodes[p.graphId] || nodes[p.graphId].type !== "graph");
}

// ── SVG composition ──────────────────────────────────────────────────────

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A panel SVG's inner content, with its own outer `<svg …>` wrapper stripped
 *  (so it can sit inside the figure's parent SVG at the panel's offset). */
export function svgInner(svg: string): { inner: string; width: number; height: number } | null {
  const open = svg.match(/<svg[^>]*>/);
  const close = svg.lastIndexOf("</svg>");
  if (!open || close < 0) return null;
  const width = Number(/width="([\d.]+)"/.exec(open[0])?.[1]);
  const height = Number(/height="([\d.]+)"/.exec(open[0])?.[1]);
  if (!width || !height) return null;
  return { inner: svg.slice(open[0].length, close), width, height };
}

export interface ComposedPanelSvg {
  panel: FigurePanel;
  svg: string;
}

/** One parent SVG containing each panel's SVG at its grid offset, with the
 *  labels, per-panel titles, figure title and (when shared) the single legend
 *  drawn as SVG text — so the export stays vector and editable. Width/height
 *  are the figure size in points (10 in = 720 pt). A shared legend takes a
 *  strip below the grid, so the parent grows by 28 pt in that case. */
export function composeFigureSvg(
  panels: ComposedPanelSvg[],
  figure: {
    panels: FigurePanel[];
    grid: FigureGrid;
    figureSize: FigureSize;
    labelStyle: FigureLabelStyle;
    figureTitle: string;
    sharedLegend: SharedLegend;
  },
  sharedEntries?: { name: string; color: string }[],
): { svg: string; missing: number } {
  const widthPt = figure.figureSize.widthIn * PT_PER_INCH;
  const heightPt = figure.figureSize.heightIn * PT_PER_INCH;
  const legendStrip = figure.sharedLegend === "shared" && sharedEntries?.length ? 28 : 0;
  const { position, fontSizePt, bold } = figure.labelStyle;
  // A figure title takes a strip above the grid, so it never overlaps a panel.
  const titleStrip = figure.figureTitle ? fontSizePt + 16 : 0;
  const rects = panelRectsPt(figure.panels, figure.grid, figure.figureSize).map((r) => ({ ...r, y: r.y + titleStrip }));
  const rectOf = new Map(rects.map((r) => [r.panel.graphId, r]));
  const fontWeight = bold ? "bold" : "normal";
  const fontFamily = "Arial, Helvetica, sans-serif";
  let missing = 0;
  const parts: string[] = [];
  if (figure.figureTitle)
    parts.push(
      `<text x="${widthPt / 2}" y="${fontSizePt + 6}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSizePt + 4}" font-weight="bold">${escapeXml(figure.figureTitle)}</text>`,
    );
  for (const { panel, svg } of panels) {
    const rect = rectOf.get(panel.graphId);
    if (!rect) continue;
    const inner = svgInner(svg);
    if (!inner) {
      missing++;
      continue;
    }
    parts.push(
      `<svg x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" viewBox="0 0 ${inner.width} ${inner.height}">${inner.inner}</svg>`,
    );
    const labelX =
      position === "top-right" ? rect.x + rect.width - 6 : position === "above-panel" ? rect.x + rect.width / 2 : rect.x + 6;
    const anchor = position === "top-right" ? "end" : position === "above-panel" ? "middle" : "start";
    parts.push(
      `<text x="${labelX}" y="${rect.y + fontSizePt + 2}" text-anchor="${anchor}" font-family="${fontFamily}" font-size="${fontSizePt}" font-weight="${fontWeight}">${escapeXml(panel.label)}</text>`,
    );
    if (panel.title)
      parts.push(
        `<text x="${rect.x + rect.width / 2}" y="${rect.y + fontSizePt * 2 + 8}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSizePt}" font-weight="${fontWeight}">${escapeXml(panel.title)}</text>`,
      );
  }
  // Panels whose graph is gone leave their cell blank (counted, not failed).
  for (const panel of figure.panels)
    if (!panels.some((p) => p.panel.graphId === panel.graphId)) missing++;
  if (legendStrip && sharedEntries) {
    const swatch = 10;
    const gap = 6;
    const widths = sharedEntries.map((e) => swatch + gap + e.name.length * (fontSizePt * 0.6));
    const total = widths.reduce((a, b) => a + b, 0) + gap * (sharedEntries.length - 1);
    let x = (widthPt - total) / 2;
    const y = titleStrip + heightPt + 18;
    sharedEntries.forEach((e, i) => {
      parts.push(
        `<rect x="${x}" y="${y - fontSizePt + 2}" width="${swatch}" height="${swatch}" fill="${escapeXml(e.color)}"/>`,
        `<text x="${x + swatch + gap}" y="${y}" font-family="${fontFamily}" font-size="${fontSizePt}">${escapeXml(e.name)}</text>`,
      );
      x += widths[i] + gap;
    });
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPt}" height="${heightPt + legendStrip + titleStrip}" viewBox="0 0 ${widthPt} ${heightPt + legendStrip + titleStrip}">` +
    `<rect x="0" y="0" width="${widthPt}" height="${heightPt + legendStrip + titleStrip}" fill="#ffffff"/>` +
    parts.join("") +
    `</svg>`;
  return { svg, missing };
}

/** A label position's name, as the editor shows it. */
export const LABEL_POSITIONS: { value: LabelPosition; label: string }[] = [
  { value: "top-left", label: "Top left" },
  { value: "top-right", label: "Top right" },
  { value: "above-panel", label: "Above panel" },
];
