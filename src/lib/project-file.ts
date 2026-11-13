// The Helix project file (.hlx): plain JSON, described in FILE-FORMAT.md, so a
// project is never locked into Helix.
//
// A file must keep opening across versions, in both directions:
//   1. Fields are only ever added, never renamed or removed.
//   2. Reading forgives: names match whatever their case, a value of the wrong
//      type falls back to its default, a broken item is skipped on its own, and
//      fields this version doesn't know are kept, so saving doesn't lose them.
// `schemaVersion` is informative; nothing branches on it.

import {
  DEFAULT_GRAPH_OPTIONS,
  FILL_PATTERNS,
  GRAPH_CHOICES,
  GRAPH_LIMITS,
  clamp,
  type FigurePanel,
  type Limits,
  type GraphOptions,
  type GraphPalette,
  type NodeType,
  PALETTE_KINDS,
  type PaletteColor,
  type PaletteKind,
  type Place,
  type PointStyle,
  type ProjectNode,
  type RowGroup,
  SAME_AS_FILL,
  type SeriesStyle,
  type TableData,
} from "../store/types";
import {
  type AnalysisParams,
  ANOVA_POSTHOCS,
  BINDING_KINETICS_MODELS,
  BINDING_SATURATION_MODELS,
  BIN_MODES,
  CORRECTIONS,
  CURVE_COMPARISONS,
  CORRELATION_METHODS,
  CORRELATION_MODES,
  CURVE_TESTS,
  DOSE_MODELS,
  DOSE_RESPONSE_SPECIAL_MODELS,
  ENZYME_INHIBITION_MODELS,
  MONTE_CARLO_STATISTICS,
  MONTE_CARLO_TARGETS,
  NONLINEAR_MODELS,
  POSTHOC_TARGETS,
  RANK_POSTHOCS,
  ROUT_Q,
  TAILS,
  THREE_WAY_TERMS,
  TWO_WAY_DESIGNS,
} from "../stats/types";
import { NAMED_COLORS, paletteNamed, savedPalette } from "./palettes";
import { TABLES } from "../views/tables";
import { GRAPHS, GRAPH_OPTIONS_BY_TABLE } from "../views/graphs";
import { ANALYSES } from "../stats";
import { isGrouped, isNested } from "./dataset";
import { seriesKeyOf } from "./columns";
import { regroupDropped, regroupTable, renestDropped, renestTable } from "../views/tables/table-data";
import {
  assignLabels,
  clampPanel,
  DEFAULT_FIGURE_SIZE,
  DEFAULT_LABEL_STYLE,
  figureDpi,
  FIGURE_SIZE_LIMITS,
} from "./figure";

export const PROJECT_FILE_EXTENSION = "hlx";

export interface ProjectFilePayload {
  nodes: Record<string, ProjectNode>;
  rootOrder: string[];
  /** Each table's analyses and graphs, in sidebar order. */
  childOrder: Record<string, string[]>;
  activeNodeId: string | null;
}

// ── Writing ──────────────────────────────────────────────────────────────

export function serializeProjectFile({ nodes, rootOrder, childOrder, activeNodeId }: ProjectFilePayload): string {
  const project: ProjectFilePayload = { nodes, rootOrder, childOrder, activeNodeId };
  return format({ app: "helix", schemaVersion: 1, savedAt: new Date().toISOString(), project }, "") + "\n";
}

/** Indented JSON, with each list of plain values (a table row, the column names)
 *  on one line, so a table reads row by row. */
function format(value: unknown, indent: string): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  if (Array.isArray(value) && value.every((v) => typeof v !== "object" || v === null)) return JSON.stringify(value);
  const inner = indent + "  ";
  const items = Array.isArray(value)
    ? value.map((v) => inner + format(v, inner))
    : Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${inner}${JSON.stringify(k)}: ${format(v, inner)}`);
  const [open, close] = Array.isArray(value) ? "[]" : "{}";
  return items.length ? `${open}\n${items.join(",\n")}\n${indent}${close}` : open + close;
}

// ── Reading ──────────────────────────────────────────────────────────────

interface ProjectIssue {
  severity: "error" | "warning";
  message: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const lower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : v);
/** `obj` without its empty (undefined) fields. */
const defined = <T extends object>(obj: T) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;

/** `obj` with its known keys spelled as Helix writes them, whatever their case. */
function canonical(obj: Obj, keys: readonly string[]): Obj {
  const spelling = new Map(keys.map((k) => [k.toLowerCase(), k]));
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [spelling.get(k.toLowerCase()) ?? k, v]));
}

// Every field Helix knows, per level. The `satisfies` checks make TypeScript
// flag any field added to a type but not listed here.
const FILE_KEYS = ["app", "schemaVersion", "savedAt", "project"];
const PROJECT_KEYS = ["nodes", "rootOrder", "childOrder", "activeNodeId"] satisfies (keyof ProjectFilePayload)[];
// prettier-ignore
const NODE_KEYS = Object.keys({
  id: 1, type: 1, name: 1, parentId: 1, tableType: 1, data: 1,
  analysisType: 1, analysisParams: 1, graphType: 1, graphOptions: 1,
  panels: 1, grid: 1, figureSize: 1, labelStyle: 1, figureTitle: 1, sharedLegend: 1, dpi: 1,
} satisfies Record<keyof ProjectNode, 1>);
// prettier-ignore
const DATA_KEYS = Object.keys({
  columns: 1, rows: 1, groups: 1, replicates: 1, subgroups: 1, rowGroups: 1, excluded: 1,
  widths: 1, freezeTitle: 1, notes: 1,
} satisfies Record<keyof TableData, 1>);

// Graph options without a default, by the kind of value they hold.
type OptionalOption = {
  [K in keyof GraphOptions]-?: undefined extends GraphOptions[K] ? K : never;
}[keyof GraphOptions];
// prettier-ignore
const OPTIONAL_OPTIONS = {
  yMin: "number", yMax: "number", yStep: "number", xMin: "number", xMax: "number", xStep: "number",
  sigAnalysisId: "text", sigPairs: "texts", regAnalysisId: "text", demingAnalysisId: "text", coxAnalysisId: "text", poissonAnalysisId: "text", smoothAnalysisId: "text", pcaAnalysisId: "text", kmeansAnalysisId: "text", monteCarloAnalysisId: "text", xVariable: "text", yVariable: "text",
  volcanoX: "text", volcanoY: "text", volcanoLabel: "text", volcanoGroupA: "text", volcanoGroupB: "text",
  palette: "palette", series: "styles", points: "pointStyles", outlineColor: "color", pointOutlineColor: "color", errorColor: "color",
  legend: "place", note: "place",
} as const satisfies Record<OptionalOption, keyof typeof READ_OPTION>;
// The retired dose-response graph's own options (before Helix 1.0.7): no
// longer a GraphOptions field, but still read — fitsFromDoseGraphs below
// needs them to turn an old graph into a scatter + analysis — and stripped
// from every graph on the way out (see parseProjectFile).
const LEGACY_DOSE_OPTIONS = ["doseY", "doseModel", "doseShowCurve", "doseShowEquation", "doseLigandConcentration"];
// Options whose text is the user's (titles, column names), not a choice from a list.
const FREE_TEXT_OPTIONS = new Set(["title", "xLabel", "yLabel"]);

// Every graph option offering choices has its list, and every number its limits.
type ChoiceOption = {
  [K in keyof GraphOptions]-?: string extends GraphOptions[K] ? never : GraphOptions[K] extends string ? K : never;
}[keyof GraphOptions];
type NumberOption = { [K in keyof GraphOptions]-?: GraphOptions[K] extends number ? K : never }[keyof GraphOptions];
GRAPH_CHOICES satisfies Record<ChoiceOption, readonly string[]>;
GRAPH_LIMITS satisfies Record<NumberOption, Limits>;

// What each analysis param holds: a choice from its list, yes/no, a number (within its
// limits), or the user's names (of columns). The R code is written with them: anything
// else is left out (the test takes its default), so a file can't slip R code into it.
type ParamKey = AnalysisParams extends infer P ? (P extends unknown ? keyof P : never) : never;
type ParamKind =
  | "yes/no"
  | "number"
  | "name"
  | "names"
  | "name-or-names"
  | "name-or-number"
  | "name-and-names"
  | "numbers-by-name"
  | "number-pairs-by-name"
  | readonly string[]
  | Limits;
// prettier-ignore
const PARAMS = {
  paired: "yes/no", gaussian: "yes/no", equalVariance: "yes/no", ratio: "yes/no", forceOrigin: "yes/no", pooledSd: "yes/no", quasi: "yes/no", fixHillSlope: "yes/no", trendOrdered: "yes/no", continuityCorrection: "yes/no",
  equalSd: "yes/no", sphericity: "yes/no", interpolate: "yes/no", tails: TAILS, posthoc: [...ANOVA_POSTHOCS, ...RANK_POSTHOCS],
  // `model` is shared by nonlinear-regression and the binding runners:
  // the reader only sanitizes, each runner validates its own.
  model: [...NONLINEAR_MODELS, ...BINDING_SATURATION_MODELS, ...BINDING_KINETICS_MODELS, ...ENZYME_INHIBITION_MODELS, ...DOSE_RESPONSE_SPECIAL_MODELS],
  // `method` is shared by correlation ("pearson"/"spearman") and Spline/Lowess
  // ("spline"/"lowess") — and now outliers ("rout"/"grubbs"): the reader only
  // sanitizes, each runner validates its own.
  method: [...CORRELATION_METHODS, "spline", "lowess", "rout", "grubbs"],
  mode: CORRELATION_MODES, design: TWO_WAY_DESIGNS, posthocTarget: POSTHOC_TARGETS, correction: CORRECTIONS, curveTest: CURVE_TESTS, compare: CURVE_COMPARISONS,
  // Nonlinear regression framework (plan 26): weighting, model comparison,
  // global fitting, fixed parameters and bounds.
  weights: ["none", "1/y", "1/y2", "1/x", "1/x2", "1/sd2"],
  compareModel: [...NONLINEAR_MODELS],
  globalY: "names",
  sharedParams: "names",
  fixed: "numbers-by-name",
  bounds: "number-pairs-by-name",
  hypotheticalValue: "number", baseline: "number", q: ROUT_Q, lambda: "number",
  alpha: { min: 0.001, max: 0.5 }, iterate: "yes/no",
  f: "number", spar: "number", df: "number",
  y: "name-or-names", y2: "name", ys: "names", dependent: "name", reference: "name", control: "name", compareWith: "name", datasets: "names", predictors: "names", sets: "names",
  ligandConcentration: "number", ligandKd: "number", fitKi: "yes/no", koff: "number", hotNM: "number", time0: "number",
  enzymeConcentration: "number", substrateConcentration: "number", kmForMorrison: "number",
  inhibitorConcentrations: "numbers-by-name",
  antagonistConcentrations: "numbers-by-name",
  bUnits: ["M", "nM", "µM"],
  binMode: BIN_MODES, binWidth: "number", binCount: { min: 2, max: 100 }, startAt: "number",
  posthocTerm: THREE_WAY_TERMS,
  truth: "name", score: "name", positive: "name-or-number",
  time: "name", status: "name", covariates: "names", stratifyBy: "name", ties: ["efron", "breslow"],
  // Normality tests (plan 23): which of the four tests, and whether to
  // also test the log-transformed values.
  test: ["shapiro-wilk", "dagostino-pearson", "anderson-darling", "kolmogorov-smirnov"],
  lognormal: "yes/no",
  // Principal component analysis (plan 21): the matrix, and how many
  // components to report (0 = all).
  scale: ["correlation", "covariance"], components: "number",
  // K-means clustering (plan 30): how many clusters, and whether to
  // standardise the variables first.
  clusters: "number", standardise: "yes/no",
  // Mixed-effects model (plan 20): the random structure and the subject
  // identity are choices; `subjectFactor` is one name + its per-row levels.
  randomStructure: ["intercept", "slope"], subjectId: ["row", "replicate"], interaction: "yes/no",
  fixedFactors: "names", slopeVariable: "name", subjectFactor: "name-and-names",
  // Monte Carlo simulation (plan 22): the target analysis + statistic are
  // choices; repeats/seed are numbers; the per-column simulated means/SDs
  // are numbers-by-name (the target's own options — equalVariance,
  // hypotheticalValue, y, method — already have entries above).
  targetAnalysis: MONTE_CARLO_TARGETS,
  summaryStatistic: MONTE_CARLO_STATISTICS,
  repeats: "number",
  seed: "number",
  groupMeans: "numbers-by-name",
  groupSds: "numbers-by-name",
} satisfies Record<ParamKey, ParamKind>;

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const cellText = (v: unknown) =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : null;

const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

const isWord = (v: unknown) =>
  typeof v === "boolean" || isFiniteNumber(v) || (typeof v === "string" && /^[a-z0-9.-]+$/.test(v));

/** Whether `key` is one of `list`'s own entries (not a name every object has, as "constructor"). */
const isIn = (list: object, key: unknown) => typeof key === "string" && Object.hasOwn(list, key);

const isNamed = (v: unknown): v is PaletteColor => typeof v === "string" && Object.hasOwn(NAMED_COLORS, v);

/** Named colors (Helix 1.0's), by key. */
function colors(v: unknown): Record<string, PaletteColor> | undefined {
  if (!isObj(v)) return undefined;
  const out = Object.entries(v)
    .map(([k, c]) => [k, lower(c)] as const)
    .filter((e): e is [string, PaletteColor] => isNamed(e[1]));
  return out.length ? Object.fromEntries(out) : undefined;
}

/** `v` when it is one of `choices`, whatever their case (the choices themselves
 *  are mostly lowercase, but a three-way ANOVA's post-hoc term is "A:B" — so
 *  both sides are compared lowercased). */
const oneOf = <T extends string>(choices: readonly T[], v: unknown) =>
  choices.find((c) => c.toLowerCase() === lower(v));

/** A number brought within `limits`; anything else, none. */
const within = (v: unknown, limits: Limits) => (isFiniteNumber(v) ? clamp(v, limits) : undefined);

/** A palette as a file holds it (a project's graph, My Palettes), or nothing if broken. */
export function readPalette(v: unknown): GraphPalette | undefined {
  if (!isObj(v)) return undefined;
  const p = canonical(v, ["name", "kind", "colors", "reversed"]);
  const colors = Array.isArray(p.colors) ? p.colors.filter(isHex) : [];
  if (typeof p.name !== "string" || !colors.length) return undefined;
  const kind = oneOf(PALETTE_KINDS, p.kind) ?? "categorical";
  // A gradient runs between two colors at least: one alone is taken at both ends.
  if (kind !== "categorical" && colors.length === 1) colors.push(colors[0]);
  return defined({ ...p, name: p.name, kind, colors, reversed: p.reversed === true || undefined });
}

/** Each series' style, keeping what this version doesn't know of it. */
function readStyles(v: unknown): Record<string, SeriesStyle> | undefined {
  if (!isObj(v)) return undefined;
  const out = Object.entries(v)
    .filter((e): e is [string, Obj] => isObj(e[1]))
    .map(([key, raw]) => {
      const style = canonical(raw, ["color", "shape", "dash", "pattern"]);
      const shape = oneOf(GRAPH_CHOICES.pointShape, style.shape);
      const dash = oneOf(GRAPH_CHOICES.lineDash, style.dash);
      const pattern = oneOf(FILL_PATTERNS, style.pattern);
      return [
        key,
        defined({ ...style, color: isHex(style.color) ? style.color : undefined, shape, dash, pattern }),
      ] as const;
    })
    .filter(([, style]) => Object.keys(style).length);
  return out.length ? Object.fromEntries(out) : undefined;
}

/** A position, both coordinates numbers. */
const readPlace = (v: unknown): Place | undefined =>
  isObj(v) && isFiniteNumber(v.x) && isFiniteNumber(v.y) ? { x: v.x, y: v.y } : undefined;

/** Each point's style, keeping what this version doesn't know of it. */
function readPointStyles(v: unknown): Record<string, PointStyle> | undefined {
  if (!isObj(v)) return undefined;
  const out = Object.entries(v)
    .filter((e): e is [string, Obj] => isObj(e[1]) && /#\d+$/.test(e[0]))
    .map(([key, raw]) => {
      const p = canonical(raw, ["color", "size", "shape", "fill", "outline", "outlineColor", "label", "labelOffset"]);
      const shape = oneOf(GRAPH_CHOICES.pointShape, p.shape);
      const color = isHex(p.color) ? p.color : undefined;
      const outlineColor = isHex(p.outlineColor)
        ? p.outlineColor
        : lower(p.outlineColor) === SAME_AS_FILL
          ? SAME_AS_FILL
          : undefined;
      const label = p.label === true || undefined;
      const labelOffset = readPlace(p.labelOffset);
      const size = within(p.size, GRAPH_LIMITS.pointSize);
      const fill = within(p.fill, GRAPH_LIMITS.pointFill);
      const outline = within(p.outline, GRAPH_LIMITS.pointOutline);
      return [key, defined({ ...p, color, size, shape, fill, outline, outlineColor, label, labelOffset })] as const;
    })
    .filter(([, style]) => Object.keys(style).length);
  return out.length ? Object.fromEntries(out) : undefined;
}

const READ_OPTION = {
  number: (v: unknown) => (isFiniteNumber(v) ? v : undefined),
  text: (v: unknown) => (typeof v === "string" ? v : undefined),
  texts: (v: unknown) => {
    // A graph's significance pairs, keeping the usable ones (M6): one bad
    // entry used to drop the whole list.
    if (!Array.isArray(v)) return undefined;
    const kept = v.filter((s) => typeof s === "string");
    return kept.length ? kept : undefined;
  },
  palette: readPalette,
  styles: readStyles,
  pointStyles: readPointStyles,
  place: readPlace,
  color: (v: unknown) => (isHex(v) ? v : undefined),
};

/** Colors a table kept for its graphs before Helix 1.0.3: its series' and its cells'. */
type TableColors = { series?: Record<string, PaletteColor>; cells?: Record<string, PaletteColor> };

/** A table's row groups as a file holds them: every band a non-empty, distinct
 *  name with a positive whole-row count. A broken band is left out on its own —
 *  the valid bands stay, and each dropped band is named so the user is told
 *  (a file whose every band is broken reads as no third factor). */
function readRowGroups(v: unknown): { groups: RowGroup[] | undefined; dropped: string[] } {
  if (!Array.isArray(v)) return { groups: undefined, dropped: [] };
  const groups: RowGroup[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const b of v) {
    if (!isObj(b) || typeof b.name !== "string" || b.name.trim() === "" || !isCount(b.count)) {
      dropped.push(describeDroppedBand(b));
      continue;
    }
    if (seen.has(b.name)) {
      dropped.push(`“${b.name}” (a second band with this name)`);
      continue;
    }
    seen.add(b.name);
    groups.push({ name: b.name, count: b.count });
  }
  return { groups: groups.length ? groups : undefined, dropped };
}

/** How a dropped row-group band is named in the warning: its name and count
 *  when it has them, so the user can tell which band went. */
function describeDroppedBand(b: unknown): string {
  if (!isObj(b)) return "an unreadable band";
  const name = typeof b.name === "string" && b.name.trim() !== "" ? `“${b.name}”` : "a band with no name";
  if (isCount(b.count)) return name;
  return typeof b.count === "number" ? `${name} (count ${b.count})` : `${name} (no count)`;
}

/** A table's data, and the colors it kept for its graphs. */
/** A table's data, put straight: no value beyond its last column (`beyond` counts those left
 *  out), exclusions and widths only on cells and columns it has, and a grouped table's
 *  groups and sub-columns those of its columns ("A:Y1"…). Rebuilding a grouped or
 *  nested table from its columns drops any column whose name has no slot in the
 *  rebuilt set — a gapped sub-column ("A:Y3" with no "A:Y2") — so `regroupDropped`
 *  names the valued columns that went, for a warning: without it the values
 *  would vanish on load and the loss would be saved over the file. */
function readData(raw: Obj): {
  data: TableData;
  colors: TableColors;
  beyond: number;
  regroupDropped: string[];
  rowGroupsDropped: string[];
} | null {
  const { seriesColors, pointColors, ...d } = canonical(raw, [...DATA_KEYS, "seriesColors", "pointColors"]);
  if (!Array.isArray(d.columns) || !Array.isArray(d.rows)) return null;
  const columns = d.columns.map((c) => cellText(c) ?? "");
  if (!columns.length) columns.push("Title");
  let beyond = 0;
  const rows = d.rows.map((row) => {
    const cells = Array.isArray(row) ? row.map((c) => cellText(c) || null) : [];
    beyond += cells.slice(columns.length).filter((c) => c !== null).length;
    return cells.slice(0, columns.length);
  });
  const onCell = (k: unknown): k is string => {
    const [r, c] = typeof k === "string" && /^\d+,\d+$/.test(k) ? k.split(",").map(Number) : [Infinity];
    return r < rows.length && c < columns.length;
  };
  const excluded = Array.isArray(d.excluded) ? d.excluded.filter(onCell) : [];
  const widths = isObj(d.widths)
    ? Object.fromEntries(
        Object.entries(d.widths).filter(([name, w]) => columns.includes(name) && isFiniteNumber(w) && w > 0),
      )
    : {};
  const rowGroups = readRowGroups(d.rowGroups);
  let data = defined({
    ...d,
    columns,
    rows,
    groups: isCount(d.groups) && isCount(d.replicates) ? d.groups : undefined,
    replicates: isCount(d.groups) && isCount(d.replicates) ? d.replicates : undefined,
    subgroups: isCount(d.groups) && isCount(d.replicates) && isCount(d.subgroups) ? d.subgroups : undefined,
    rowGroups: rowGroups.groups,
    excluded: excluded.length ? excluded : undefined,
    widths: Object.keys(widths).length ? (widths as Record<string, number>) : undefined,
    freezeTitle: d.freezeTitle === true || undefined,
  } as TableData);
  const regroupDroppedNames: string[] = [];
  if (isGrouped(data) && columns.length > 1) {
    const groups = [...new Set(columns.slice(1).map(seriesKeyOf))];
    const replicates = Math.max(...groups.map((g) => columns.filter((c) => seriesKeyOf(c) === g).length));
    if (groups.length !== data.groups || replicates !== data.replicates) {
      regroupDroppedNames.push(...regroupDropped(data, groups.length, replicates));
      data = defined(regroupTable(data, groups.length, replicates));
    }
  }
  if (isNested(data) && columns.length > 1) {
    // A nested table's groups, subgroups and replicates are those of its
    // columns ("A:S1:R1"…), as a grouped table's are of its "A:Y1" columns.
    const parts = columns
      .slice(1)
      .map((c) => c.split(":"))
      .filter((p) => p.length === 3);
    const groups = [...new Set(parts.map((p) => p[0]))];
    const subgroups = Math.max(0, ...groups.map((g) => new Set(parts.filter((p) => p[0] === g).map((p) => p[1])).size));
    const replicates = Math.max(
      0,
      ...groups.flatMap((g) =>
        [...new Set(parts.filter((p) => p[0] === g).map((p) => p[1]))].map(
          (s) => parts.filter((p) => p[0] === g && p[1] === s).length,
        ),
      ),
    );
    if (groups.length !== data.groups || subgroups !== data.subgroups || replicates !== data.replicates) {
      regroupDroppedNames.push(...renestDropped(data, groups.length, subgroups, replicates));
      data = defined(renestTable(data, groups.length, subgroups, replicates));
    }
  }
  return { data, colors: { series: colors(seriesColors), cells: colors(pointColors) }, beyond, regroupDropped: regroupDroppedNames, rowGroupsDropped: rowGroups.dropped };
}

/** Every option, of the right type, one of its choices and within its limits: a missing
 *  or wrong one takes its default, a number beyond its limits the nearest it can be. */
function readOptions(raw: unknown, label: string, issues: ProjectIssue[]): GraphOptions {
  const o = isObj(raw)
    ? canonical(raw, [
        ...Object.keys(DEFAULT_GRAPH_OPTIONS),
        ...Object.keys(OPTIONAL_OPTIONS),
        ...LEGACY_DOSE_OPTIONS,
      ])
    : {};
  const out: Obj = { ...o, ...DEFAULT_GRAPH_OPTIONS };
  for (const [key, fallback] of Object.entries(DEFAULT_GRAPH_OPTIONS)) {
    const v = typeof o[key] === "string" && !FREE_TEXT_OPTIONS.has(key) ? lower(o[key]) : o[key];
    const choices: readonly unknown[] | undefined = isIn(GRAPH_CHOICES, key)
      ? GRAPH_CHOICES[key as ChoiceOption]
      : undefined;
    if (typeof v !== typeof fallback || (typeof v === "number" && !Number.isFinite(v))) continue;
    if (!choices || choices.includes(v)) out[key] = v;
  }
  for (const [key, limits] of Object.entries(GRAPH_LIMITS)) out[key] = within(out[key], limits);
  for (const [key, kind] of Object.entries(OPTIONAL_OPTIONS)) {
    const raw = o[key];
    out[key] = READ_OPTION[kind](raw);
    if (kind === "texts" && Array.isArray(raw) && raw.length) {
      const kept = Array.isArray(out[key]) ? (out[key] as unknown[]).length : 0;
      if (kept < raw.length) {
        issues.push({
          severity: "warning",
          message: `Graph “${label}”: ${raw.length - kept} invalid ${raw.length - kept === 1 ? "entry" : "entries"} in “${key}” ${raw.length - kept === 1 ? "was" : "were"} left out; the rest were kept.`,
        });
      }
    }
  }
  return defined(out) as unknown as GraphOptions;
}

/** The runner default for a param, by analysis: when a file's value for one
 *  of these is unusable it falls back to this instead of being left out — the
 *  file header's promise. Only keys whose runner reads them whole-object
 *  (`(params ?? DEFAULTS).key`) are listed; the rest already fall back per
 *  key (`??` in the runner) or spread-merge their defaults (one-sample-t,
 *  one-way ANOVA, frequency-distribution). Mirrors each runner's DEFAULTS —
 *  compare-two-groups, kruskal-wallis, friedman, nested-anova,
 *  deming-regression — and the multiple-t-tests wizard default (Holm). */
const PARAM_DEFAULTS: Record<string, Record<string, unknown>> = {
  "compare-two-groups": { paired: false, gaussian: true, equalVariance: true, ratio: false, tails: "two-sided" },
  "kruskal-wallis": { posthoc: "none" },
  friedman: { posthoc: "none" },
  "nested-anova": { posthoc: "none" },
  "deming-regression": { lambda: 1 },
  "multiple-t-tests": { paired: false, gaussian: true, pooledSd: false, correction: "holm" },
  // M7 fallbacks: a cross-family choice left out below lands on these.
  anova: { posthoc: "none" },
  correlation: { method: "pearson" },
  "correlation-matrix": { method: "pearson" },
  outliers: { method: "rout" },
};

/** Choice values only one family of analyses may use (M7). The merged PARAMS
 *  lists admit them all, so each runner reinterprets the other family's
 *  values: `posthoc: "dunn"` on a one-way ANOVA runs Dunnett's T3 math under
 *  a Dunn's label, `"tukey"`/`"bonferroni"` on Kruskal-Wallis or Friedman
 *  runs Dunn regardless, `method: "spline"|"lowess"` on a correlation is
 *  silently treated as Pearson. Restricted here, at load, to the list its
 *  own analysis offers; anything else is left out and falls back to the
 *  default above, with a warning. Analyses whose runner already refuses
 *  cross-family values with a clean error — nested-anova and three-way-anova
 *  posthoc, two-way-anova posthoc, spline-lowess method, repeated-measures
 *  ANOVA posthoc — are left alone: the error is the honest answer there.
 *  The merged `model` list is likewise safe (each runner validates and
 *  errors cleanly). */
const PARAM_CHOICES: Record<string, Record<string, readonly string[]>> = {
  anova: { posthoc: ANOVA_POSTHOCS },
  "kruskal-wallis": { posthoc: RANK_POSTHOCS },
  friedman: { posthoc: RANK_POSTHOCS },
  correlation: { method: CORRELATION_METHODS },
  "correlation-matrix": { method: CORRELATION_METHODS },
  outliers: { method: ["rout", "grubbs"] },
};

/** A collection param, keeping its usable entries: one bad entry used to
 *  drop the whole value (M6) — the analysis then silently ran on all columns
 *  instead of the chosen subset, or lost every wizard-entered concentration
 *  at once. `report` hears how many entries were left out, so the reader
 *  can warn about them. */
function readParam(kind: ParamKind, v: unknown, report?: (dropped: number) => void): unknown {
  if (kind === "yes/no") return typeof v === "boolean" ? v : undefined;
  if (kind === "number") return isFiniteNumber(v) ? v : undefined;
  if (kind === "name") return typeof v === "string" ? v : undefined;
  if (kind === "name-or-number") return typeof v === "string" || isFiniteNumber(v) ? v : undefined;
  if (kind === "name-or-names") {
    if (typeof v === "string") return v;
    if (!Array.isArray(v)) return undefined;
    const kept = v.filter((s): s is string => typeof s === "string");
    if (kept.length !== v.length) report?.(v.length - kept.length);
    return kept.length ? kept : undefined;
  }
  if (kind === "numbers-by-name") {
    if (!isObj(v)) return undefined;
    const kept = Object.fromEntries(Object.entries(v).filter(([, n]) => isFiniteNumber(n)));
    const dropped = Object.keys(v).length - Object.keys(kept).length;
    if (dropped) report?.(dropped);
    return Object.keys(kept).length ? kept : undefined;
  }
  if (kind === "number-pairs-by-name") {
    if (!isObj(v)) return undefined;
    const kept = Object.fromEntries(
      Object.entries(v).filter(([, p]) => Array.isArray(p) && p.length === 2 && p.every(isFiniteNumber)),
    );
    const dropped = Object.keys(v).length - Object.keys(kept).length;
    if (dropped) report?.(dropped);
    return Object.keys(kept).length ? kept : undefined;
  }
  if (kind === "name-and-names") {
    if (!isObj(v) || typeof v.name !== "string" || !Array.isArray(v.levels)) return undefined;
    const levels = v.levels.filter((s): s is string => typeof s === "string");
    if (levels.length !== v.levels.length) report?.(v.levels.length - levels.length);
    return levels.length ? { ...v, levels } : undefined;
  }
  if (kind === "names") {
    if (!Array.isArray(v)) return undefined;
    const kept = v.filter((s): s is string => typeof s === "string");
    if (kept.length !== v.length) report?.(v.length - kept.length);
    return kept.length ? kept : undefined;
  }
  return Array.isArray(kind) ? oneOf(kind, v) : within(v, kind as Limits);
}

function readParams(
  raw: unknown,
  analysisType: string | undefined,
  label: string,
  issues: ProjectIssue[],
): AnalysisParams | undefined {
  if (!isObj(raw)) return undefined;
  const p = canonical(raw, Object.keys(PARAMS));
  // A param this version doesn't know is kept as a plain word.
  const read = (k: string, v: unknown) => {
    if (!isIn(PARAMS, k)) return isWord(lower(v)) ? lower(v) : undefined;
    let dropped = 0;
    const value = readParam(PARAMS[k as ParamKey], v, (n) => {
      dropped = n;
    });
    if (dropped > 0) {
      issues.push({
        severity: "warning",
        message: `Analysis “${label}”: ${dropped} invalid ${dropped === 1 ? "entry" : "entries"} in “${k}” ${dropped === 1 ? "was" : "were"} left out; the rest were kept.`,
      });
    }
    return value;
  };
  const sanitized = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, read(k, v)]));
  // A choice from another test's family is left out (M7) — it would be
  // silently reinterpreted by this test's runner — and falls back to the
  // default below, with a warning of its own (not the M5 one).
  const choices = (analysisType ? PARAM_CHOICES[analysisType] : undefined) ?? {};
  const restricted = new Set<string>();
  for (const [key, allowed] of Object.entries(choices)) {
    const value = sanitized[key];
    if (value !== undefined && !allowed.includes(value as string)) {
      issues.push({
        severity: "warning",
        message: `Analysis “${label}”: “${key}” was “${value}”, which this test doesn't offer, so the usual default applies.`,
      });
      delete sanitized[key];
      restricted.add(key);
    }
  }
  // A value the reader left out falls back to its runner default (M5) — a
  // dropped `gaussian` must not silently turn a t test into a Wilcoxon, a
  // dropped `tails` must not reach R as "undefined", a dropped `posthoc`
  // must not silently run Dunn. Only keys the file actually wrote get a
  // substituted default: a key the file never had stays absent — the
  // runner's own fallbacks cover it, and an older file (an outliers
  // analysis with `{q}` only) still opens clean instead of "updated".
  const defaults = (analysisType ? PARAM_DEFAULTS[analysisType] : undefined) ?? {};
  const present = new Set(Object.keys(p));
  const fill = Object.fromEntries(Object.entries(defaults).filter(([k]) => present.has(k)));
  for (const key of Object.keys(p)) {
    if (sanitized[key] === undefined && isIn(PARAMS, key) && key in defaults && !restricted.has(key)) {
      issues.push({
        severity: "warning",
        message: `Analysis “${label}”: “${key}” was not a usable value, so the usual default applies.`,
      });
    }
  }
  // Strip the left-out values first, so a dropped key falls back to its
  // default instead of shadowing it with `undefined`.
  return defined({ ...fill, ...defined(sanitized) }) as unknown as AnalysisParams;
}

const NODE_TYPES: NodeType[] = ["table", "analysis", "graph", "figure"];

/** A figure's fields as a file holds them, forgivingly: a missing or empty
 *  `panels` opens as an empty figure (not an error); a panel out of range is
 *  clamped into the grid; a `dpi` Helix doesn't offer falls back to 600; a
 *  size outside 1–20 in is brought within, and an aspect beyond 4:1 is
 *  reined in by shrinking the longer side. Unknown figure fields are kept
 *  by the node's spread in `readNode` and written back on save. */
function readFigure(raw: Obj): Pick<
  ProjectNode,
  "panels" | "grid" | "figureSize" | "labelStyle" | "figureTitle" | "sharedLegend" | "dpi"
> {
  const panels = (Array.isArray(raw.panels) ? raw.panels : [])
    .filter((p): p is Obj => isObj(p) && typeof p.graphId === "string" && p.graphId !== "")
    .map((p) => {
      const n = (k: string) => (isFiniteNumber(p[k]) ? Math.floor(p[k] as number) : undefined);
      return defined({
        graphId: p.graphId as string,
        graphName: typeof p.graphName === "string" ? (p.graphName as string) : undefined,
        label: typeof p.label === "string" ? (p.label as string) : "",
        labelManual: p.labelManual === true || undefined,
        title: typeof p.title === "string" ? (p.title as string) : "",
        row: n("row") ?? 0,
        col: n("col") ?? 0,
        rowSpan: Math.max(1, n("rowSpan") ?? 1),
        colSpan: Math.max(1, n("colSpan") ?? 1),
      }) as FigurePanel;
    });
  const gridRaw = isObj(raw.grid) ? raw.grid : {};
  const cols = isCount(gridRaw.cols)
    ? (gridRaw.cols as number)
    : Math.max(1, Math.min(panels.length || 1, 4));
  const rows = isCount(gridRaw.rows) ? (gridRaw.rows as number) : Math.max(1, Math.ceil(panels.length / cols));
  const grid = { rows, cols };
  const clamped = assignLabels(panels.map((p) => clampPanel(p, grid)));
  const sizeRaw = isObj(raw.figureSize) ? raw.figureSize : {};
  const { min, max } = FIGURE_SIZE_LIMITS;
  let widthIn = within(sizeRaw.widthIn, { min, max }) ?? DEFAULT_FIGURE_SIZE.widthIn;
  let heightIn = within(sizeRaw.heightIn, { min, max }) ?? DEFAULT_FIGURE_SIZE.heightIn;
  if (widthIn / heightIn > 4) widthIn = heightIn * 4;
  if (heightIn / widthIn > 4) heightIn = widthIn * 4;
  const styleRaw = isObj(raw.labelStyle) ? raw.labelStyle : {};
  const position = oneOf(["top-left", "top-right", "above-panel"] as const, styleRaw.position) ?? "top-left";
  const fontSizePt = within(styleRaw.fontSizePt, { min: 8, max: 28 }) ?? DEFAULT_LABEL_STYLE.fontSizePt;
  return {
    panels: clamped,
    grid,
    figureSize: { widthIn, heightIn },
    labelStyle: { position, fontSizePt, bold: styleRaw.bold !== false },
    figureTitle: typeof raw.figureTitle === "string" ? raw.figureTitle : "",
    sharedLegend: oneOf(["none", "shared"] as const, raw.sharedLegend) ?? "none",
    dpi: figureDpi(raw.dpi),
  };
}

/** `tableColors`: where a table leaves the colors it kept for its graphs. */
function readNode(
  id: string,
  raw: unknown,
  issues: ProjectIssue[],
  tableColors: Record<string, TableColors>,
): ProjectNode | null {
  if (!isObj(raw)) return null;
  const n = canonical(raw, NODE_KEYS);
  const type = lower(n.type) as NodeType;
  if (!NODE_TYPES.includes(type)) return null;
  const node = {
    ...n,
    id,
    type,
    name: cellText(n.name) ?? "Untitled",
    parentId: typeof n.parentId === "string" ? n.parentId : null,
  } as ProjectNode;

  if (type === "table") {
    const read = isObj(n.data) ? readData(n.data) : null;
    if (!read) return null;
    node.data = read.data;
    tableColors[id] = read.colors;
    if (read.beyond) {
      const values = read.beyond === 1 ? "1 value" : `${read.beyond} values`;
      issues.push({
        severity: "warning",
        message: `Table “${node.name}” had ${values} beyond its last column; they were left out.`,
      });
    }
    if (read.regroupDropped.length) {
      const dropped = read.regroupDropped;
      issues.push({
        severity: "warning",
        message: `Table “${node.name}” left out ${dropped.length === 1 ? "a column with values" : `${dropped.length} columns with values`} its groups couldn't hold: ${dropped.join(", ")}.`,
      });
    }
    if (read.rowGroupsDropped.length) {
      const dropped = read.rowGroupsDropped;
      issues.push({
        severity: "warning",
        message: `Table “${node.name}” left out ${dropped.length === 1 ? "a row group" : `${dropped.length} row groups`} it couldn't read: ${dropped.join(", ")}.`,
      });
    }
    node.parentId = null;
    node.tableType = lower(n.tableType) as ProjectNode["tableType"];
    if (!isIn(TABLES, node.tableType)) {
      issues.push({
        severity: "warning",
        message: `Table “${node.name}” has a type this version doesn't know; it opens as a Column table.`,
      });
      node.tableType = "column";
    }
  } else if (type === "analysis") {
    node.analysisType = lower(n.analysisType) as ProjectNode["analysisType"];
    node.analysisParams = readParams(n.analysisParams, node.analysisType as string, node.name, issues);
    if (!isIn(ANALYSES, node.analysisType)) {
      issues.push({ severity: "error", message: `Analysis “${node.name}” uses a test this version doesn't know.` });
    }
  } else if (type === "figure") {
    // A figure may span tables, so it lives at the project root, never under one table.
    node.parentId = null;
    Object.assign(node, readFigure(n));
  } else {
    node.graphType = lower(n.graphType) as ProjectNode["graphType"];
    node.graphOptions = readOptions(n.graphOptions, node.name, issues);
    if (!isIn(GRAPHS, node.graphType) && (node.graphType as string) !== DOSE_GRAPH) {
      issues.push({ severity: "error", message: `Graph “${node.name}” uses a chart this version doesn't know.` });
    }
  }
  return node;
}

/** `v` as JSON with its objects' keys in order, to compare contents whatever their order. */
const contents = (v: unknown) =>
  JSON.stringify(v, (_, x: unknown) =>
    isObj(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );

/** Reads a `.hlx` file forgivingly. `{ error }` only when nothing usable remains;
 *  otherwise the project, what the user should know about it, and whether Helix changed
 *  anything as it read it (`updated`: repaired, or brought up to date from an older Helix),
 *  so saving it keeps the project as it is now. */
export function parseProjectFile(
  raw: unknown,
): { project: ProjectFilePayload; issues: ProjectIssue[]; updated: boolean } | { error: string } {
  if (!isObj(raw)) return { error: "Not a valid Helix project file." };
  const file = canonical(raw, FILE_KEYS);
  if (lower(file.app) !== "helix") return { error: "This file was not created by Helix." };
  const project = isObj(file.project) ? canonical(file.project, PROJECT_KEYS) : null;
  if (!project || !isObj(project.nodes)) return { error: "This file's project data is missing or corrupted." };

  const issues: ProjectIssue[] = [];
  const nodes: Record<string, ProjectNode> = {};
  const tableColors: Record<string, TableColors> = {};
  let skipped = 0;
  // `__proto__` can't be an item's id: set on an object, it would change what the object is.
  for (const [id, raw] of Object.entries(project.nodes)) {
    const node = id === "__proto__" ? null : readNode(id, raw, issues, tableColors);
    if (node) nodes[id] = node;
    else skipped++;
  }
  /** The item with this id: one of the file's own, never a name every object has ("constructor"). */
  const nodeOf = (id: unknown) => (isIn(nodes, id) ? nodes[id as string] : undefined);
  // Analyses and graphs belong to a table: drop those whose table didn't survive.
  // Figures live at the project root (they may span tables), so they stay.
  for (const node of Object.values(nodes)) {
    if (node.type === "figure") continue;
    if (node.type !== "table" && nodeOf(node.parentId)?.type !== "table") {
      delete nodes[node.id];
      skipped++;
    }
  }
  if (skipped) {
    issues.push({
      severity: "warning",
      message: `${skipped} unreadable item${skipped === 1 ? " was" : "s were"} left out.`,
    });
  }

  const fits = fitsFromDoseGraphs(nodes);
  // The retired graph's options, on any graph that still carries them, go:
  // the migration above already took them off the graphs it converted.
  for (const node of Object.values(nodes)) {
    if (node.type !== "graph" || !node.graphOptions) continue;
    for (const key of LEGACY_DOSE_OPTIONS) delete (node.graphOptions as unknown as Obj)[key];
  }
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((id): id is string => typeof id === "string") : []);
  const tables = Object.values(nodes).filter((n) => n.type === "table");
  if (tables.length === 0) return { error: "This project file has no readable data tables." };
  // Saved order first, then anything the order missed: tables, then figures
  // (figures live at the project root, after the tables, in creation order).
  const figures = Object.values(nodes).filter((n) => n.type === "figure");
  const rootOrder = [
    ...new Set([
      ...ids(project.rootOrder).filter((id) => nodeOf(id)?.type === "table"),
      ...tables.map((t) => t.id),
      ...ids(project.rootOrder).filter((id) => nodeOf(id)?.type === "figure"),
      ...figures.map((f) => f.id),
    ]),
  ];
  const savedChildren = isObj(project.childOrder) ? project.childOrder : {};
  const childOrder = Object.fromEntries(
    rootOrder.map((tableId) => {
      const children = Object.values(nodes)
        .filter((n) => n.parentId === tableId)
        .map((n) => n.id);
      // A dose-response graph's fit, now an analysis, comes just before it.
      const saved = ids(savedChildren[tableId])
        .flatMap((id) => (fits[id] ? [fits[id], id] : [id]))
        .filter((id) => children.includes(id));
      return [tableId, [...new Set([...saved, ...children])]];
    }),
  );
  const activeNodeId = nodeOf(project.activeNodeId) ? (project.activeNodeId as string) : rootOrder[0];

  for (const node of Object.values(nodes)) {
    if (node.type === "figure") {
      // A panel whose graph is gone stays as a placeholder naming the graph;
      // the figure still opens, and export leaves that cell blank.
      const missing = (node.panels ?? []).filter((p) => !nodeOf(p.graphId) || nodeOf(p.graphId)?.type !== "graph");
      if (missing.length)
        issues.push({
          severity: "warning",
          message: `Figure “${node.name}” refers to ${missing.length === 1 ? "a graph" : `${missing.length} graphs`} that no longer exist.`,
        });
      continue;
    }
    if (node.type === "graph") {
      if (!node.graphOptions!.palette) {
        // The file's own options, as saved — the rebuild only fills in what they lack.
        const rawNodes = isObj(project.nodes) ? project.nodes : undefined;
        const rawNodeObj = rawNodes?.[node.id];
        const rawNode = isObj(rawNodeObj) ? canonical(rawNodeObj, NODE_KEYS) : undefined;
        colorsFromHelix1(node, tableColors[node.parentId!]?.series, rawNode?.graphOptions);
      }
      pointsFromCells(node, tableColors[node.parentId!]?.cells);
    }
    const tableType = nodeOf(node.parentId)?.tableType;
    if (node.type !== "graph" || !node.graphType || !tableType) continue;
    if (isIn(GRAPHS, node.graphType) && !GRAPH_OPTIONS_BY_TABLE[tableType].some((o) => o.value === node.graphType)) {
      issues.push({
        severity: "warning",
        message: `Graph “${node.name}” isn't a chart Helix offers for a ${TABLES[tableType].label} table.`,
      });
    }
    const o = node.graphOptions!;
    if (
      (o.sigAnalysisId && !nodeOf(o.sigAnalysisId)) ||
      (o.regAnalysisId && !nodeOf(o.regAnalysisId)) ||
      (o.demingAnalysisId && !nodeOf(o.demingAnalysisId)) ||
      (o.coxAnalysisId && !nodeOf(o.coxAnalysisId)) ||
      (o.poissonAnalysisId && !nodeOf(o.poissonAnalysisId)) ||
      (o.pcaAnalysisId && !nodeOf(o.pcaAnalysisId)) ||
      (o.smoothAnalysisId && !nodeOf(o.smoothAnalysisId))
    ) {
      issues.push({
        severity: "warning",
        message: `Graph “${node.name}” refers to an analysis that no longer exists.`,
      });
    }
  }

  const read = { nodes, rootOrder, childOrder, activeNodeId };
  return { project: read, issues, updated: contents(read) !== contents(file.project) };
}

// ── Dose-response graphs (before Helix 1.0.7) ───────────────────────────
// A "Dose-response curve" graph fitted its own curve. A curve now always comes from an
// analysis, as in Prism: each becomes an XY scatter drawing the curve of a new
// "Nonlinear regression" of the same data set and model, so it looks as it did.

const DOSE_GRAPH = "dose-response";

/** Turns each dose-response graph into a scatter and its fit into an analysis of its
 *  table; returns the new analyses' ids, by graph. */
function fitsFromDoseGraphs(nodes: Record<string, ProjectNode>): Record<string, string> {
  const fits: Record<string, string> = {};
  for (const graph of Object.values(nodes)) {
    if (graph.type !== "graph" || (graph.graphType as string) !== DOSE_GRAPH) continue;
    const { doseY, doseModel, doseShowCurve, doseShowEquation, doseLigandConcentration, ...options } =
      graph.graphOptions as unknown as Obj;
    let id = `analysis_fit_${graph.id}`;
    while (isIn(nodes, id)) id += "_";
    const siblings = Object.values(nodes)
      .filter((n) => n.parentId === graph.parentId)
      .map((n) => n.name);
    let name = "Nonlinear regression";
    for (let i = 2; siblings.includes(name); i++) name = `Nonlinear regression ${i}`;
    nodes[id] = {
      id,
      type: "analysis",
      name,
      parentId: graph.parentId,
      analysisType: "nonlinear-regression",
      // Helix's default then: a 4PL with X as the concentration.
      analysisParams: defined({
        y: typeof doseY === "string" ? doseY : undefined,
        model: oneOf(DOSE_MODELS, doseModel) ?? "sigmoidal-4pl-x",
        // The homologous model needs [L] (plan 28) — the graph carries it in
        // doseLigandConcentration; without it the created analysis errors
        // and the migrated scatter draws points only.
        ...(typeof doseLigandConcentration === "number" && Number.isFinite(doseLigandConcentration)
          ? { ligandConcentration: doseLigandConcentration }
          : {}),
      }),
    };
    graph.graphType = "xy-scatter";
    graph.graphOptions = {
      ...(options as unknown as GraphOptions),
      xyStyle: "points",
      regAnalysisId: id,
      regShowLine: doseShowCurve !== false,
      regShowEquation: doseShowEquation !== false,
    };
    fits[graph.id] = id;
  }
  return fits;
}

// ── Files from Helix 1.0 ─────────────────────────────────────────────────
// A graph's colors came from its table (`seriesColors`, named colors), a heatmap
// had one of three color scales, and a volcano two named colors. A graph saved
// without a palette gets them back as its own, so it looks as it did: the Helix
// palette with its table's colors, or its heatmap scale as Plotly drew it.

/** The heatmap scales of Helix 1.0 that the catalog doesn't have, as Plotly defines them. */
const HEATMAP_SCALES: Record<string, { name: string; kind: PaletteKind; stops: [number, string][] }> = {
  "red-blue": {
    name: "Red/Blue (Helix 1.0)",
    kind: "diverging",
    stops: [
      [0, "#050AAC"],
      [0.35, "#6A89F7"],
      [0.5, "#BEBEBE"],
      [0.6, "#DCAA84"],
      [0.7, "#E6915A"],
      [1, "#B20A1C"],
    ],
  },
  "yellow-red": {
    name: "Heat (Helix 1.0)",
    kind: "sequential",
    stops: [
      [0, "#800026"],
      [0.125, "#BD0026"],
      [0.25, "#E31A1C"],
      [0.375, "#FC4E2A"],
      [0.5, "#FD8D3C"],
      [0.625, "#FEB24C"],
      [0.75, "#FED976"],
      [0.875, "#FFEDA0"],
      [1, "#FFFFCC"],
    ],
  },
};

/** A scale's stops as 256 evenly spaced colors, blended as Plotly blends them. */
function resample(stops: [number, string][]): string[] {
  const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Array.from({ length: 256 }, (_, i) => {
    const t = i / 255;
    const j = Math.max(
      1,
      stops.findIndex(([at]) => at >= t),
    );
    const [[a, from], [b, to]] = [stops[j - 1], stops[j]];
    const f = (t - a) / (b - a);
    const [c0, c1] = [channels(from), channels(to)];
    return (
      "#" +
      c0
        .map((c, k) =>
          Math.round(c + (c1[k] - c) * f)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")
        .toUpperCase()
    );
  });
}

const LEGACY_OPTIONS = ["heatmapColorScale", "volcanoColorUp", "volcanoColorDown", "volcanoPointSize"];

/** A graph without a palette gets Helix 1.0's colors back as its own — but only
 *  for what the file never saved (`saved`: its options as the file held them).
 *  A graph that saved its fill, point size, outline, bar gap or series keeps
 *  them; the rebuild fills in the rest, so a missing palette alone never
 *  rewrites a graph's own options. */
function colorsFromHelix1(
  node: ProjectNode,
  tableColors: Record<string, PaletteColor> | undefined,
  saved: unknown,
) {
  const all = node.graphOptions as unknown as Obj;
  const old = canonical(all, LEGACY_OPTIONS);
  const named = (v: unknown, fallback: PaletteColor) => (isNamed(lower(v)) ? (lower(v) as PaletteColor) : fallback);
  let palette = savedPalette(paletteNamed("helix")!);
  let colors = tableColors;
  if (node.graphType === "heatmap") {
    const name = lower(old.heatmapColorScale);
    const scale = isIn(HEATMAP_SCALES, name) ? HEATMAP_SCALES[name as string] : undefined;
    palette = scale
      ? { name: scale.name, kind: scale.kind, colors: resample(scale.stops) }
      : savedPalette(paletteNamed("viridis")!);
  } else if (node.graphType === "volcano") {
    colors = { down: named(old.volcanoColorDown, "blue"), up: named(old.volcanoColorUp, "red") };
  }
  const series =
    colors && Object.fromEntries(Object.entries(colors).map(([key, c]) => [key, { color: NAMED_COLORS[c] }]));
  const legacy = (k: string) => LEGACY_OPTIONS.some((o) => o.toLowerCase() === k.toLowerCase());
  const options = Object.fromEntries(Object.entries(all).filter(([k]) => !legacy(k)));
  // Helix 1.0 filled shapes and points half-opaque (a pie's and a volcano's, their type's
  // fill), and set a row's bars side by side; its points had their type's size and
  // outline (a volcano, the size set on it, within what Helix offers).
  const { defaults } = isIn(GRAPHS, node.graphType) ? GRAPHS[node.graphType!] : {};
  const pointSize = within(old.volcanoPointSize, GRAPH_LIMITS.pointSize);
  const fills = { fill: defaults?.fill ?? 0.5, pointFill: defaults?.pointFill ?? 0.5 };
  // What the file saved, spelled as Helix writes it: the options above already
  // hold the global defaults for what it didn't, so only this tells the two apart.
  const savedKeys = new Set(
    isObj(saved)
      ? Object.keys(
          canonical(saved, [...Object.keys(DEFAULT_GRAPH_OPTIONS), ...Object.keys(OPTIONAL_OPTIONS)]),
        )
      : [],
  );
  const helix1: Obj = { ...options };
  for (const [key, value] of Object.entries({ ...defaults, ...fills })) {
    if (!savedKeys.has(key)) helix1[key] = value;
  }
  if (pointSize !== undefined && !savedKeys.has("pointSize")) helix1.pointSize = pointSize;
  if (!savedKeys.has("barGap")) helix1.barGap = 0;
  if (series && !savedKeys.has("series")) helix1.series = series;
  helix1.palette = palette;
  node.graphOptions = defined(helix1) as unknown as GraphOptions;
}

/** Points colored in their table's cells (before Helix 1.0.3) keep their color on
 *  each of its graphs, under any style the graph gives them itself. */
function pointsFromCells(node: ProjectNode, cells: Record<string, PaletteColor> | undefined) {
  if (!cells) return;
  const options = node.graphOptions!;
  const colored = Object.fromEntries(Object.entries(cells).map(([key, c]) => [key, { color: NAMED_COLORS[c] }]));
  node.graphOptions = { ...options, points: { ...colored, ...options.points } };
}
