// One panel of the figure editor: the graph's chart drawn with Plotly at the
// panel's size (see panel-figure.ts for what it draws), or the placeholder
// when the graph is gone or has nothing to draw.
import * as React from "react";
import type { ProjectNode } from "../../store/types";
import { loadPlotly } from "../graphs/plotly";
import { buildPanelFigure } from "./panel-figure";

export function PanelPlot({
  graph,
  nodes,
  width,
  height,
  onPlot,
}: {
  graph: ProjectNode;
  nodes: Record<string, ProjectNode>;
  width: number;
  height: number;
  /** The drawn element (for per-panel export, which reuses `saveGraphImage`). */
  onPlot: (el: HTMLElement | null) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const plottedRef = React.useRef<HTMLDivElement | null>(null);
  const fig = React.useMemo(() => buildPanelFigure(graph, nodes), [graph, nodes]);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || !fig) return;
    let current = true;
    void loadPlotly().then(async (Plotly) => {
      if (!current) return;
      await Plotly.react(
        el,
        fig.data,
        { ...fig.layout, width, height },
        { displayModeBar: false, scrollZoom: false, doubleClick: false },
      );
      if (!current) return;
      plottedRef.current = el;
      onPlot(el);
    });
    return () => {
      current = false;
    };
  }, [fig, width, height]);

  React.useEffect(
    () => () => {
      const el = plottedRef.current;
      plottedRef.current = null;
      if (el) void loadPlotly().then((Plotly) => Plotly.purge(el));
    },
    [],
  );

  if (!fig)
    return (
      <div className="flex h-full w-full items-center justify-center bg-white px-2 text-center text-small text-secondary">
        Graph “{graph.name}” has nothing to draw yet.
      </div>
    );
  return <div ref={ref} style={{ width, height }} />;
}
