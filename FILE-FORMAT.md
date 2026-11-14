# The Titer project file (`.hlx`)

A Titer project is one plain-text JSON file (UTF-8). Any program can read or write
it: your data are never locked into Titer.

## Promises

- **Old files always open.** Fields are only ever added in new versions, never
  renamed or removed.
- **Newer files open too.** A version of Titer keeps the fields it doesn't know and
  writes them back when saving, so opening a newer file in an older Titer loses nothing.
- **Forgiving reading.** Field names and choices are read whatever their case
  (`tableType`, `TableType`, `"XY"`). A value of the wrong type, or a choice Titer doesn't
  offer (a dash `"zigzag"`), falls back to its default; a number beyond what Titer offers
  is brought back within (a point size of 500 reads as 20). A broken item is left out on
  its own, and Titer says so. A table is put straight: values beyond its last column are left
  out (and said), exclusions and column widths that point nowhere are dropped, and a grouped
  table's `groups` and `replicates` are those of its columns. A file Titer had to change as
  it read it (repaired, or written by an older Titer) opens as edited, and saving it writes it
  up to date.
- **Nothing about you.** The file holds the project only: no file paths, user
  names or app state.

## Layout

```json
{
  "app": "titer",
  "schemaVersion": 1,
  "savedAt": "2026-09-24T12:00:00.000Z",
  "project": {
    "nodes": { "<id>": { … }, … },
    "rootOrder": ["<table id>", …],
    "childOrder": { "<table id>": ["<analysis or graph id>", …] },
    "activeNodeId": "<id>"
  }
}
```

- `app` is `"titer"` for files Titer writes; files written before the rename carry `"helix"` and still open. `schemaVersion` and `savedAt` are informative.
- `nodes` holds every item, keyed by its `id`.
- `rootOrder` lists the data tables in sidebar order, then the figures (a figure
  lives at the project root, after the tables, in creation order); `childOrder`
  the analyses and graphs of each table. Items missing from these lists are
  shown after the others.
- `activeNodeId` is the item shown when the file opens.

## Items

Every item has `id`, `type` (`"table"`, `"analysis"`, `"graph"` or `"figure"`),
`name`, and `parentId`: `null` for a table or a figure, the table's id for an
analysis or a graph.

### Data table

```json
{
  "id": "table_x1y2", "type": "table", "name": "Table 1", "parentId": null,
  "tableType": "grouped",
  "data": {
    "columns": ["Title", "A:Y1", "A:Y2", "B:Y1", "B:Y2"],
    "rows": [
      ["Day 1", "10", "11", "14", "15"],
      ["Day 2", "12", null, "18", "19"]
    ],
    "groups": 2,
    "replicates": 2
  }
}
```

- `tableType`: `"column"`, `"xy"`, `"grouped"`, `"nested"`, `"multiple"` (Multiple Variables),
  `"contingency"` or `"survival"` (Titer 1.0.7 and later).
- `columns`: the column names. The first is always the row-title column (`Title`);
  in an XY table the second is X, in a Survival table the time (each subject's row then
  holds 1, event, or 0, censored, in its group's column).
- `rows`: one list per row, one cell per column, as typed: text, or `null` for an
  empty cell. Numbers are written as text (`"2.5"`), exactly as entered. A row may
  be shorter than `columns`: the missing cells are empty.
- A grouped table names its sub-columns `<group>:<sub-column>` (`"A:Y1"`) and gives
  `groups` and `replicates` (sub-columns per group). It may also give `rowGroups`:
  consecutive bands of rows carrying one level of a third factor, e.g.
  `"rowGroups": [{ "name": "WT", "count": 2 }, { "name": "KO", "count": 2 }]`
  — the bands must tile the table's rows exactly (their counts add up to the row
  count), with non-empty, distinct names. A table without `rowGroups` has no third
  factor; a three-way ANOVA needs at least 2 bands.
- An XY table whose data sets hold replicates (1.0.9 and later) names them the same
  way after its X (`"Title", "X", "A:Y1", "A:Y2"…`), with `groups` (its data sets) and
  `replicates`; without them, each Y column is a data set of its own.
- A nested table names its sub-columns `<group>:<subgroup>:<replicate>` (`"A:S1:R1"`)
  and gives `groups`, `subgroups` (subgroups per group — each subgroup is one
  animal/subject) and `replicates` (replicate sub-columns per subgroup). Each
  subgroup's replicate values sit across its replicate columns in a row; the
  nested tests run on one mean per subgroup. A nested table has no `rowGroups`.

Optional fields:

| Field | Meaning |
| --- | --- |
| `rowGroups` | A grouped table's third-factor bands, as `{ "name", "count" }` per band |
| `subgroups` | A nested table's subgroups per group |
| `excluded` | Cells excluded from analyses and graphs, as `"row,column"` (0-based, column 0 is Title): `["2,1"]` |
| `widths` | Column widths set by the user, in pixels, by column name |
| `freezeTitle` | `true` keeps the Title column visible while scrolling |

Files from before 1.0.3 may also have `seriesColors`, a color per column (or
group), and `pointColors`, a color per cell as `"column name#row"`, each `"blue"`,
`"red"`, `"green"`, `"purple"`, `"orange"` or `"black"`: Titer reads them as the
colors of the table's graphs (see Graph).

### Analysis

```json
{
  "id": "analysis_k3m4", "type": "analysis", "name": "Two-way ANOVA", "parentId": "table_x1y2",
  "analysisType": "two-way-anova",
  "analysisParams": { "design": "ordinary", "posthoc": "tukey", "posthocTarget": "groups", "sets": ["A", "C"] }
}
```

An analysis stores what to compute, never its results: Titer computes them again
from the table when the file opens, so results always match the data.
`analysisParams` holds the choices made in the analysis's wizard (see
`src/stats/types.ts`). `sets` (1.0.5 and later) names the data sets it runs on, in
order: columns, or a grouped table's groups, or a nested table's groups. Without it, an analysis runs on all of
them (a two-group test: the first two holding data). A linear regression's `x` (1.0.8 and later)
names its X variable in a Multiple Variables table; without it, X is the
table's first data column.

### Graph

```json
{
  "id": "graph_p5q6", "type": "graph", "name": "Interleaved bars", "parentId": "table_x1y2",
  "graphType": "grouped-bars",
  "graphOptions": { "center": "mean", "error": "sem", "width": 640, "height": 460, … }
}
```

`graphOptions` holds every display setting (see `GraphOptions` in
`src/store/types.ts`). A missing setting takes its default.

A graph's colors and style are its own:

```json
"palette": { "name": "okabe-ito", "kind": "categorical", "colors": ["#000000", "#E69F00", …] },
"series": { "Control": { "color": "#0072B2", "shape": "square", "dash": "dash", "pattern": "diagonal" } },
"points": { "Control#3": { "color": "#D55E00", "size": 11, "shape": "diamond", "outline": 2, "outlineColor": "#000000" } },
"fill": 1, "pointFill": 1, "pointSize": 7, "pointShape": "circle", "pointOutline": 1.5,
"outline": 1.5, "outlineColor": "#000000", "pointOutlineColor": "#FFFFFF", "barGap": 0.1,
"lineWidth": 2, "lineDash": "solid", "errorWidth": 1.5, "errorCaps": 6, "errorColor": "#000000", "errorDirection": "above",
"legend": { "x": 0.8, "y": 0.1 }, "note": { "x": 30, "y": 40 }, "xTitleGap": 12, "yTitleGap": 2
```

- `palette`: which palette (`src/lib/palettes.ts`, or one of the user's own, named as
  they named it), and its colors, written out so the figure keeps them whatever Titer's
  list of palettes becomes, and on a Mac that doesn't have the user's. `kind` is
  `"categorical"` (colors taken in turn) or `"sequential"` / `"diverging"` (a
  gradient: series take evenly spaced colors along it, a heatmap all of it; a
  gradient of one color runs from it to itself).
  `reversed: true`: its colors are written from the last (Reverse Colors).
- `series`: the series styled by hand, by column or group name (a volcano's are
  `"down"` and `"up"`): `color`, `shape` of its points, `dash` of its line (`"solid"`,
  `"dash"`, `"dot"`, `"dashdot"`) and `pattern` over its bars, area or slice
  (`"diagonal"`, `"back-diagonal"`, `"crosshatch"`, `"horizontal"`, `"vertical"`,
  `"grid"`, `"dots"`); the others take the palette's color for their place and the
  graph's `pointShape` and `lineDash`.
- `points`: the points styled one by one, as `"column name#row"` (row 0 is the first),
  each with any of `color`, `size`, `shape`, `fill` (how opaque, 0 to 1), `outline`,
  `outlineColor` (a color, or `"fill"`: the point's own color), `label` (`true`: it shows
  its row's title, or its row number, beside it) and `labelOffset` (where that name was
  moved, in pixels from the point, `y` downward); the rest comes from its series and the
  graph. A volcano's genes are their rows alone, `"#row"`; a gene's own style wins
  over its up / down / not significant look. They follow the table: a renamed column,
  inserted or deleted rows.
- `fill`: how opaque bars, boxes, violins and areas are, from 0 to 1; `pointFill`,
  points.
- `pointSize` (2 to 20) and `pointOutline` (0 to 6), in pixels, and `pointShape`
  (`"circle"`, `"square"`, `"diamond"`, `"triangle-up"`, `"triangle-down"`): every point of
  the graph.
- `outline` (in pixels, 0 to 6) and `outlineColor`: the outline of bars, boxes, violins,
  areas and pie slices; `pointOutlineColor`, of points. Without a color, an outline takes
  the color of what it outlines.
- `barGap`: on interleaved grouped bars and XY bars, the gap between the bars of a row
  (or of an X), as a fraction of it, 0 (side by side) to 0.5.
- `lineWidth`, `lineDash`: every series line's thickness (in pixels, 0.5 to 6) and dashes.
- `errorWidth` (0.5 to 6) and `errorCaps` (0 to 20), in pixels, `errorColor` (none: each
  series' color) and `errorDirection` (`"both"` or `"above"`: up, or right on horizontal
  bars): error bars, and the mean or median line drawn with them.
- `legend` and `note`: texts moved by hand. The legend (or a heatmap's color legend),
  as a fraction of the plot area from its bottom-left corner; the note (a fit's
  equation), in pixels from the plot's top-left corner, `y` downward. Without them,
  each sits in its usual place.
- `xTitleGap`, `yTitleGap`: the space in pixels between each axis title and its tick
  labels, 0 to 40.
- `xScale`, `yScale` (Helix 1.0.9 and later): `"linear"`, `"log10"` or `"log2"`, each axis's
  scale (Y is the value axis; X only where it holds numbers). On a log axis, `xMin`/`yMin`
  and `xMax`/`yMax` are values above 0, and the step is not used.
- `error`: `"none"`, `"sd"`, `"sem"` or `"ci"` (the 95% CI of the mean, Helix 1.0.9 and later).
- `stackAs` (Helix 1.0.9 and later): stacked bars show each group's `"values"`, or its
  `"percent"` of the row's total; a histogram each data set's counts (`"values"`), or
  their percent of its values.
- `xyReplicates` (Helix 1.0.9 and later): an XY scatter of replicates draws each X's
  `"mean"` (its `center`, mean or median, with its `error`), or `"each"` replicate.
- `binWidth` (Helix 1.0.9 and later): a `"histogram"` graph's bin width, in the values'
  units; without it (or at 0 and under), R's own bins.

A `"dose-response"` graph (before 1.0.7) fitted its own curve, from `doseY` (its data
set) and `doseModel`. It opens as an `"xy-scatter"` drawing the curve of a new
`"nonlinear-regression"` analysis of the same data set and model, placed just before it.

A graph without `palette` comes from 1.0.2 or before: it takes the Titer
palette, its table's `seriesColors`, its old `heatmapColorScale` or
`volcanoColorUp` / `volcanoColorDown` / `volcanoPointSize`, fills at 0.5 (a pie's at 1,
a volcano's points at 0.75), its type's point size and outline, and bars side by side
(`barGap` 0), so it looks as it did.

### Figure

A figure composes several existing graphs into one labelled publication
figure. It holds references to graph nodes, never copies of them: editing a
graph (its options, its analysis, its data) updates the figure panel
automatically, because the panel is drawn from the graph each time.

```json
{
  "id": "figure_a1b2", "type": "figure", "name": "Figure 1", "parentId": null,
  "panels": [
    { "graphId": "graph_p5q6", "graphName": "Interleaved bars", "label": "A", "title": "", "row": 0, "col": 0, "rowSpan": 1, "colSpan": 1 },
    { "graphId": "graph_q7r8", "graphName": "Dose-response curve", "label": "B", "title": "", "row": 0, "col": 1, "rowSpan": 1, "colSpan": 1 }
  ],
  "grid": { "rows": 1, "cols": 2 },
  "figureSize": { "widthIn": 10, "heightIn": 7.5 },
  "labelStyle": { "position": "top-left", "fontSizePt": 12, "bold": true },
  "figureTitle": "",
  "sharedLegend": "none",
  "dpi": "600"
}
```

- `panels`: the panels in any order (labels are assigned in reading order,
  row-major). Each panel's `graphId` is the graph node it shows, by id, never
  by name. `label` is its panel label (`A`, `B`, … `Z`, then `AA`, `AB`…);
  `labelManual: true` means the label was typed by hand and sticks to the
  panel when panels move, instead of being reassigned in reading order.
  `title` is an optional per-panel title. `row` / `col` is the panel's cell
  (0-based), `rowSpan` / `colSpan` how many cells it covers. `graphName` is a
  denormalised hint recorded at save time, so a panel whose graph is gone can
  say "Graph 'Dose-response curve' is missing" — it is never trusted for lookup.
- `grid`: `rows` × `cols` of the panel grid. A new figure with N panels is
  1 × N, wrapping to a new row after 4 columns (the user may raise the columns
  to 6). Empty cells are allowed.
- `figureSize`: the page size in inches (default 10 × 7.5 in, the usable area
  of US Letter landscape). Each dimension must be 1–20 in, and neither more
  than 4× the other.
- `labelStyle`: where the panel labels sit (`"top-left"`, `"top-right"` or
  `"above-panel"`), their size in points (default 12 pt) and whether bold
  (default on). Labels are part of the exported image, not a screen-only overlay.
- `figureTitle`: an optional title centred above the grid (default none).
- `sharedLegend`: `"none"` (default) or `"shared"` — one legend below the
  grid, centred, with the per-panel legends hidden. Only valid when every
  panel's graph has the identical set of series in the identical colours;
  otherwise the editor refuses it and says why.
- `dpi`: the export resolution, `"150"`, `"300"` or `"600"` (default `"600"`),
  the same choices as a single graph.

Forgiving reading (figures):

- A figure whose `panels` is missing or empty opens as an empty figure (the
  editor shows "Add a panel"), not as an error.
- A panel with an out-of-range row/col is clamped into the grid; a span past
  the grid's edge is shortened to fit.
- A `dpi` outside 150/300/600 falls back to 600. A size outside 1–20 in is
  brought within; an aspect beyond 4:1 is reined in by shrinking the longer side.
- A panel whose `graphId` points nowhere (the graph was deleted, or the file
  was hand-edited) reads as a placeholder panel naming the graph from
  `graphName`; the figure still opens, and export leaves that cell blank and
  says how many panels couldn't be drawn. It never fails the whole export.
- Unknown figure fields are preserved and written back, like any other node's.
- A figure node in a file opened by an **older** Titer (which has no figure
  type) is left out on its own, and Titer says so — the figure is the one case
  where opening a newer file in an older Titer loses visible content (the
  figure, not the data: the graphs and tables it references still open). The
  node is preserved in the file, not deleted, so re-opening in the newer Titer
  recovers the figure. (Note: preserving an unknown *node* across a re-save in
  the older Titer is not yet implemented — see the plan file's Builder notes —
  so the figure survives only until the older Titer saves the file.)

A figure is not a Prism layout: a `.prism` file's Layout sheet is not
transferred on import (the converter's transfer report says so — "not
transferred — re-create the figure in Titer"), and exporting a Titer figure to
Prism format is out of scope (the converter offers the figure's panels as
individual graphs instead, and says so).
