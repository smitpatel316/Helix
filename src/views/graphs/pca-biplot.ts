// "Scores biplot" of a Principal component analysis: one point per subject
// (its PC scores on two chosen components, labelled by row title), with the
// loadings as arrows from the origin — one per variable, scaled to the score
// cloud. Family `multiple`: the points and arrows come from a sibling PCA's
// cached runAnalysis result (see graph-view.tsx) — the graph draws only its
// axes until one is chosen, exactly like the forest plot (see forest-plot.ts).
import type { GraphOptions } from "../../store/types";
import type { AnalysisResult } from "../../stats/types";
import type { Column } from "../../lib/dataset";
import { pointKeyOf } from "../../lib/columns";
import { addNote, GUIDE, INK, seriesPoints, xyLayout, type Paint } from "./plot-helpers";
import type { GraphFigure, GraphModule } from ".";

/** The one series this graph draws, as the Series section names it. */
export const PCA_BIPLOT_SERIES = "Scores";

/** The two plotted components (1-based), clamped to the components the
 *  result actually reports; when both options name the same component the
 *  other of PC1/PC2 is used, so the plot never draws a component against
 *  itself. */
export function biplotComponents(options: GraphOptions, count: number): [number, number] {
  const x = Math.min(Math.max(Math.floor(options.pcaX) || 1, 1), count);
  let y = Math.min(Math.max(Math.floor(options.pcaY) || 2, 1), count);
  if (y === x) y = x === 1 ? 2 : 1;
  return [x, y];
}

/** The factor the loading arrows are scaled by, so the longest arrow reaches
 *  the edge of the score cloud (Prism scales loadings to the score range the
 *  same way): max |score| over the two plotted components, over max |loading|
 *  over the same two. 0 when there is nothing to scale (no loadings). */
export function biplotArrowScale(
  loadings: { loadings: (number | null)[] }[],
  scores: { scores: (number | null)[] }[],
  x: number,
  y: number,
): number {
  const maxScore = Math.max(
    0,
    ...scores.flatMap((s) => [Math.abs(s.scores[x - 1] ?? 0), Math.abs(s.scores[y - 1] ?? 0)]),
  );
  const maxLoading = Math.max(
    0,
    ...loadings.flatMap((l) => [Math.abs(l.loadings[x - 1] ?? 0), Math.abs(l.loadings[y - 1] ?? 0)]),
  );
  return maxLoading > 0 ? maxScore / maxLoading : 0;
}

/** Draw the score points + loading arrows of a PCA result onto a biplot
 *  figure (its build's axes). No-op when the result has no scores (not a PCA
 *  result, or the fit failed); a note when it reports fewer than 2
 *  components, since a biplot needs a pair. */
export function addPcaBiplot(
  fig: GraphFigure,
  outcome: AnalysisResult,
  options: GraphOptions,
  paint: Paint,
): void {
  const variance = outcome.pcaVariance ?? [];
  const loadings = outcome.pcaLoadings ?? [];
  const scores = outcome.pcaScores ?? [];
  if (!scores.length) return;
  if (variance.length < 2) {
    addNote(fig, "The biplot needs at least 2 components — re-run the analysis reporting more.", options);
    return;
  }
  const [x, y] = biplotComponents(options, variance.length);
  const pct = (i: number) => ((variance[i - 1]?.proportion ?? 0) * 100).toFixed(1);
  const layout = fig.layout as Record<string, unknown>;
  // The axes are the components, with their variance explained; the user's
  // titles still win when set (xyLayout already applied them).
  if (!options.xLabel) {
    (layout.xaxis as Record<string, unknown>).title = { text: `PC${x} (${pct(x)}%)`, standoff: options.xTitleGap };
  }
  if (!options.yLabel) {
    (layout.yaxis as Record<string, unknown>).title = { text: `PC${y} (${pct(y)}%)`, standoff: options.yTitleGap };
  }
  // Equal aspect: one score unit is the same distance on both axes, so the
  // cloud's shape (and the arrows' angles) is geometrically honest.
  (layout.yaxis as Record<string, unknown>).scaleanchor = "x";
  (layout.yaxis as Record<string, unknown>).scaleratio = 1;
  layout.showlegend = false;

  const xs = scores.map((s) => s.scores[x - 1] ?? null);
  const ys = scores.map((s) => s.scores[y - 1] ?? null);
  const scale = biplotArrowScale(loadings, scores, x, y);
  fig.data = [
    {
      type: "scatter",
      mode: "markers+text",
      name: PCA_BIPLOT_SERIES,
      x: xs,
      y: ys,
      text: scores.map((s) => s.row),
      textposition: "top center",
      textfont: { color: INK, size: Math.max(options.fontSize - 2, 8) },
      ...seriesPoints(paint, PCA_BIPLOT_SERIES, 0, scores.map((_, i) => pointKeyOf(PCA_BIPLOT_SERIES, i))),
      hoverinfo: "text+x+y",
      showlegend: false,
    },
  ];
  // One arrow per variable, from the origin to its (scaled) loading on the
  // two plotted components, labelled with the variable's name at the tip.
  const annotations = loadings
    .map((l) => {
      const tipX = (l.loadings[x - 1] ?? 0) * scale;
      const tipY = (l.loadings[y - 1] ?? 0) * scale;
      if (tipX === 0 && tipY === 0) return null;
      return {
        xref: "x",
        yref: "y",
        x: tipX,
        y: tipY,
        axref: "x",
        ayref: "y",
        ax: 0,
        ay: 0,
        text: l.variable,
        showarrow: true,
        arrowhead: 2,
        arrowsize: 1,
        arrowwidth: 1.5,
        arrowcolor: GUIDE,
        font: { color: INK, size: Math.max(options.fontSize - 1, 8) },
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);
  if (annotations.length) {
    fig.layout.annotations = [...((fig.layout.annotations as unknown[]) ?? []), ...annotations];
  }
}

function build(_columns: Column[], options: GraphOptions, _paint: Paint): GraphFigure {
  return {
    data: [],
    layout: xyLayout(options, "PC1", 1, { yName: "PC2" }),
  };
}

export const pcaBiplot: GraphModule = {
  label: "Scores biplot",
  family: "multiple",
  points: () => true,
  build,
};
