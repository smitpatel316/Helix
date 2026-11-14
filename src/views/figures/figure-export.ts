// Exporting a figure as one image: each panel is rendered through the
// existing graph machinery (`loadPlotly`, `toImage` via Plotly, `withDpi`),
// then composited onto one canvas (PNG/JPEG) or embedded in one parent SVG
// (SVG, staying vector). The figure is never rebuilt as a single Plotly
// subplot figure — the per-graph renderers are not subplot-compatible.
import { alert, pickSavePath, writeFile } from "../../native";
import { loadPlotly } from "../graphs/plotly";
import { withoutSelection } from "../graphs/selection";
import { vectorTraces } from "../graphs/plot-helpers";
import { PX_PER_INCH, withDpi } from "../../lib/image-dpi";
import {
  composeFigureSvg,
  figureExportSize,
  hasEmptyCell,
  missingPanels,
  panelPlotSize,
  panelRects,
  PT_PER_INCH,
  sharedLegendCheck,
} from "../../lib/figure";
import { buildPanelFigure } from "./panel-figure";
import type { ExportFormat, Resolution } from "../graphs/graph-export";
import type { FigurePanel, ProjectNode } from "../../store/types";

const EXTENSION: Record<ExportFormat, string> = { png: "png", jpeg: "jpg", svg: "svg" };
let lastFolder: string | null = null;
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Size = { width: number; height: number };

/** A panel drawn at `size`, as an image blob (raster at `dpi`, or SVG).
 *  With `hideLegend`, the panel draws no legend of its own — the figure's
 *  one shared legend (drawn below the grid by the caller) replaces it. */
async function panelImage(
  graph: ProjectNode,
  nodes: Record<string, ProjectNode>,
  size: Size,
  format: ExportFormat,
  dpi: Resolution,
  hideLegend: boolean,
): Promise<Blob | null> {
  const fig = buildPanelFigure(graph, nodes, { hideLegend });
  if (!fig) return null;
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;left:-10000px;top:0;visibility:hidden;";
  document.body.appendChild(el);
  try {
    const Plotly = await loadPlotly();
    // `size` is the panel's rectangle in DPI pixels; Plotly lays out in its
    // own 96-DPI units and `toImage` scales by dpi/96 on top, so the panel
    // is drawn at the 96-DPI size and the image lands exactly on the
    // rectangle (F-#7: handing Plotly the rectangle scaled twice, and at
    // 600 DPI the 18750×28125 canvas is past what WebKit draws).
    const plotSize = panelPlotSize(size, Number(dpi));
    await Plotly.react(
      el,
      fig.data,
      { ...fig.layout, ...plotSize },
      { displayModeBar: false, scrollZoom: false, doubleClick: false },
    );
    const drawn = el as unknown as { data: unknown[]; layout: object };
    const layout =
      format === "jpeg" ? { ...drawn.layout, paper_bgcolor: "#ffffff", plot_bgcolor: "#ffffff" } : drawn.layout;
    const figure = { data: vectorTraces(withoutSelection(drawn.data)), layout };
    const scale = format === "svg" ? 1 : Number(dpi) / PX_PER_INCH;
    const url = await Plotly.toImage(figure, { format, ...plotSize, scale });
    const image = await (await fetch(url)).blob();
    return format === "svg" ? image : withDpi(new Uint8Array(await image.arrayBuffer()), format, Number(dpi));
  } finally {
    void loadPlotly().then((Plotly) => Plotly.purge(el));
    el.remove();
  }
}

/** The figure's export geometry at `dpi`: its pixel size (capped like a
 *  single graph, never silently), each panel's rectangle, and the strips a
 *  figure title / shared legend take above / below the grid. */
function geometry(figure: ProjectNode, dpi: Resolution) {
  const size = figure.figureSize ?? { widthIn: 10, heightIn: 7.5 };
  const grid = figure.grid ?? { rows: 1, cols: 1 };
  const panels = figure.panels ?? [];
  const exported = figureExportSize(size, Number(dpi));
  // Rects are computed from the size that actually exports (the capped one).
  const rects = panelRects(panels, grid, { widthIn: exported.width / Number(dpi), heightIn: exported.height / Number(dpi) }, Number(dpi));
  const style = figure.labelStyle ?? { position: "top-left" as const, fontSizePt: 12, bold: true };
  const titleStrip = figure.figureTitle ? Math.round(((style.fontSizePt + 16) * Number(dpi)) / PT_PER_INCH) : 0;
  return { size, grid, panels, exported, rects, style, titleStrip };
}

function figureOf(figure: ProjectNode) {
  return {
    panels: figure.panels ?? [],
    grid: figure.grid ?? { rows: 1, cols: 1 },
    figureSize: figure.figureSize ?? { widthIn: 10, heightIn: 7.5 },
    labelStyle: figure.labelStyle ?? { position: "top-left" as const, fontSizePt: 12, bold: true },
    figureTitle: figure.figureTitle ?? "",
    sharedLegend: figure.sharedLegend ?? ("none" as const),
  };
}

/** The whole figure as a PNG/JPEG blob, composited on canvas: panel images
 *  in grid order, labels and titles as text, the figure title above the grid,
 *  and the shared legend (when valid) centred below it. */
export async function renderFigureRaster(
  figure: ProjectNode,
  nodes: Record<string, ProjectNode>,
  format: "png" | "jpeg",
  dpi: Resolution,
): Promise<{ blob: Blob; missing: number; capped: boolean; reason?: string }> {
  const g = geometry(figure, dpi);
  const legend =
    figure.sharedLegend === "shared" ? sharedLegendCheck(g.panels, nodes) : { ok: false as const };
  const legendEntries = legend.ok ? legend.entries! : undefined;
  const legendStripPx = legendEntries ? Math.round((28 * Number(dpi)) / PT_PER_INCH) : 0;
  const width = g.exported.width;
  const height = g.exported.height + g.titleStrip + legendStripPx;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  const missing = missingPanels(g.panels, nodes);
  const scale = Number(dpi) / PT_PER_INCH; // points → pixels at this DPI
  const fontPx = (pt: number) => pt * scale;
  // The figure title, centred in its strip above the grid.
  if (figure.figureTitle) {
    ctx.fillStyle = "#111827";
    ctx.font = `bold ${fontPx(g.style.fontSizePt + 4)}px Arial, Helvetica, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(figure.figureTitle, width / 2, fontPx(g.style.fontSizePt + 6));
  }
  for (const rect of g.rects) {
    const graph = nodes[rect.panel.graphId];
    const y = rect.y + g.titleStrip;
    if (graph) {
      const image = await panelImage(graph, nodes, { width: rect.width, height: rect.height }, format, dpi, legend.ok);
      if (image) {
        const bitmap = await createImageBitmap(image);
        ctx.drawImage(bitmap, rect.x, y, rect.width, rect.height);
        bitmap.close();
      }
    }
    // The label, in the cell's margin (top-left by default), over the panel.
    ctx.fillStyle = "#111827";
    ctx.font = `${g.style.bold ? "bold " : ""}${fontPx(g.style.fontSizePt)}px Arial, Helvetica, sans-serif`;
    ctx.textBaseline = "alphabetic";
    const labelY = y + fontPx(g.style.fontSizePt + 2);
    if (g.style.position === "top-right") {
      ctx.textAlign = "right";
      ctx.fillText(rect.panel.label, rect.x + rect.width - fontPx(6), labelY);
    } else if (g.style.position === "above-panel") {
      ctx.textAlign = "center";
      ctx.fillText(rect.panel.label, rect.x + rect.width / 2, labelY);
    } else {
      ctx.textAlign = "left";
      ctx.fillText(rect.panel.label, rect.x + fontPx(6), labelY);
    }
    if (rect.panel.title) {
      ctx.textAlign = "center";
      ctx.fillText(rect.panel.title, rect.x + rect.width / 2, y + fontPx(g.style.fontSizePt * 2 + 8));
    }
  }
  // One shared legend, centred below the grid.
  if (legendEntries) {
    const swatch = Math.round(10 * scale);
    const gap = Math.round(6 * scale);
    ctx.font = `${fontPx(g.style.fontSizePt)}px Arial, Helvetica, sans-serif`;
    ctx.textAlign = "left";
    const widths = legendEntries.map((e) => swatch + gap + ctx.measureText(e.name).width);
    const total = widths.reduce((a, b) => a + b, 0) + gap * (legendEntries.length - 1);
    let x = (width - total) / 2;
    const y = g.titleStrip + g.exported.height + Math.round(18 * scale);
    legendEntries.forEach((e, i) => {
      ctx.fillStyle = e.color;
      ctx.fillRect(x, y - fontPx(g.style.fontSizePt) + 2, swatch, swatch);
      ctx.fillStyle = "#111827";
      ctx.fillText(e.name, x + swatch + gap, y);
      x += widths[i] + gap;
    });
  }
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't draw the figure."))), `image/${format}`),
  );
  const stamped =
    format === "png" || format === "jpeg"
      ? withDpi(new Uint8Array(await blob.arrayBuffer()), format, Number(dpi))
      : blob;
  return { blob: stamped, missing: missing.length, capped: g.exported.capped, reason: g.exported.reason };
}

/** The whole figure as one SVG (vector, editable): each panel's SVG embedded
 *  at its grid offset, labels/titles/legend as SVG text. */
export async function renderFigureSvg(
  figure: ProjectNode,
  nodes: Record<string, ProjectNode>,
  dpi: Resolution,
): Promise<{ svg: string; missing: number }> {
  const g = geometry(figure, dpi);
  const legend =
    figure.sharedLegend === "shared" ? sharedLegendCheck(g.panels, nodes) : { ok: false as const };
  const composed: { panel: FigurePanel; svg: string }[] = [];
  for (const rect of g.rects) {
    const graph = nodes[rect.panel.graphId];
    if (!graph) continue;
    const image = await panelImage(graph, nodes, { width: rect.width, height: rect.height }, "svg", dpi, legend.ok);
    if (image) composed.push({ panel: rect.panel, svg: await image.text() });
  }
  const { svg, missing } = composeFigureSvg(composed, figureOf(figure), legend.ok ? legend.entries : undefined);
  return { svg, missing };
}

export async function saveFigureImage(
  figure: ProjectNode,
  nodes: Record<string, ProjectNode>,
  format: ExportFormat,
  dpi: Resolution,
  name: string,
) {
  if (!figure.panels?.length) return alert("Couldn't Export the Figure", "Add a panel first.", "error");
  const g = geometry(figure, dpi);
  if (hasEmptyCell(g.panels, g.grid))
    await alert("Empty Cell", "The figure has an empty cell — it exports blank.", "warning");
  try {
    let bytes: Uint8Array;
    let missing = 0;
    let capped = false;
    let capReason: string | undefined;
    if (format === "svg") {
      const out = await renderFigureSvg(figure, nodes, dpi);
      bytes = new TextEncoder().encode(out.svg);
      missing = out.missing;
    } else {
      const out = await renderFigureRaster(figure, nodes, format, dpi);
      bytes = new Uint8Array(await out.blob.arrayBuffer());
      missing = out.missing;
      capped = out.capped;
      capReason = out.reason;
    }
    if (capped && capReason) await alert("Figure Too Large", `${capReason} Exporting at the largest fitting size.`, "warning");
    const ext = EXTENSION[format];
    const fileName = `${name}.${ext}`;
    const path = await pickSavePath(
      "Export Figure",
      lastFolder ? `${lastFolder}/${fileName}` : fileName,
      ext.toUpperCase(),
      ext,
    );
    if (!path) return;
    lastFolder = path.slice(0, path.lastIndexOf("/"));
    await writeFile(path, bytes);
    if (missing)
      await alert(
        "Figure Exported",
        `${missing} panel${missing === 1 ? "" : "s"} couldn't be drawn — ${missing === 1 ? "its" : "their"} graph is missing. The ${missing === 1 ? "cell was left" : "cells were left"} blank.`,
        "warning",
      );
  } catch (err) {
    alert("Couldn't Export the Figure", reason(err), "error");
  }
}

/** Starts the clipboard write inside the click, with a promised image, as
 *  WebKit requires. Clipboard images must be raster: always PNG. */
export function copyFigureImage(figure: ProjectNode, nodes: Record<string, ProjectNode>, dpi: Resolution) {
  if (!figure.panels?.length) return void alert("Couldn't Copy the Figure", "Add a panel first.", "error");
  navigator.clipboard
    .write([
      new ClipboardItem({
        "image/png": renderFigureRaster(figure, nodes, "png", dpi).then((out) => out.blob),
      }),
    ])
    .catch((err) => alert("Couldn't Copy the Figure", reason(err), "error"));
}
