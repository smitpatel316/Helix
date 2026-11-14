// What the New Analysis picker and the Analysis menu offer for each table type.
// The tests themselves (name, needs, computation) are in stats/index.ts.

import { ANALYSES } from "../../stats";
import type { AnalysisPickerValue } from "../../stats/types";
import type { TableData, TableType } from "../../store/types";
import type { SelectorOption } from "../../components/universal-modal";
import { groupsOf, readTable } from "../../lib/dataset";
import { titleCase } from "../../lib/format";

/** A test as the picker, the Analysis menu and its wizard name it. */
export const analysisLabel = (value: AnalysisPickerValue) =>
  titleCase(
    value === "compare-many-groups"
      ? "Compare more than two groups"
      : value === "interpolate"
        ? "Interpolate a standard curve"
        : ANALYSES[value].label,
  );

const optionsFor = (order: AnalysisPickerValue[]): SelectorOption<AnalysisPickerValue>[] =>
  order.map((value) => ({ value, label: analysisLabel(value) }));

/** Test options for the selector + menu, scoped per table type (each table's columns mean
 *  something different — a Column table's columns are independent groups, an XY table's are
 *  X + Y data series — so the tests that make statistical sense differ too) and given in a fixed
 *  logical order rather than sorted by label. ANOVA/Kruskal-Wallis and Repeated-measures
 *  ANOVA/Friedman aren't listed individually — Prism-style, one meta entry cascades to whichever
 *  the wizard's Paired?/Gaussian? answers resolve to. Shapiro-Wilk is its own entry, and is
 *  offered as "Not sure?" on every Gaussian? question too (see `normality-check.ts`). */
export const ANALYSIS_OPTIONS_BY_TABLE: Record<TableType, SelectorOption<AnalysisPickerValue>[]> = {
  column: optionsFor([
    "descriptive-statistics",
    "frequency-distribution",
    "transform-data",
    "transform-concentrations",
    "remove-baseline",
    "normalize",
    "compare-two-groups",
    "compare-many-groups",
    "mixed-effects",
    "one-sample-t",
    "shapiro-wilk",
    "kolmogorov-smirnov",
    "outliers",
    "monte-carlo",
    "bland-altman",
    "roc-curve",
  ]),
  xy: optionsFor([
    "correlation",
    "linear-regression",
    "deming-regression",
    "simple-logistic-regression",
    "area-under-curve",
    "transform-data",
    "transform-concentrations",
    "remove-baseline",
    "normalize",
    "nonlinear-regression",
    "dose-response-special",
    "binding-saturation",
    "binding-kinetics",
    "enzyme-inhibition",
    "spline-lowess",
    "monte-carlo",
    "bland-altman",
    "interpolate",
    "roc-curve",
  ]),
  grouped: optionsFor(["two-way-anova", "mixed-effects", "three-way-anova", "multiple-t-tests"]),
  nested: optionsFor(["nested-t-test", "nested-anova"]),
  multiple: optionsFor(["descriptive-statistics", "shapiro-wilk", "correlation-matrix", "linear-regression", "multiple-regression", "principal-component-analysis", "k-means", "outliers", "multiple-logistic-regression", "poisson-regression", "cox-proportional-hazards"]),
  survival: optionsFor(["survival", "cox"]),
  contingency: [...optionsFor(["chi-square"]), { value: "mcnemar", label: "McNemar's test (paired proportions)" }],
};

/** Whether the table has the ≥ 2 row bands a three-way ANOVA needs. */
export function hasRowGroups(data: TableData | undefined): boolean {
  return (data?.rowGroups?.length ?? 0) >= 2;
}

/** The picker/menu options for a table: the three-way ANOVA is offered only
 *  when the table has ≥ 2 row bands — without them it would be a dead test.
 *  Likewise the nested tests are offered only for their group count (t test
 *  for exactly 2 groups with data, ANOVA for 3+) — the runners validate
 *  either way, so a stale entry point still gets a clear error. */
export function analysisOptionsForTable(tableType: TableType, data?: TableData): SelectorOption<AnalysisPickerValue>[] {
  return ANALYSIS_OPTIONS_BY_TABLE[tableType].filter((o) => {
    if (o.value === "three-way-anova") return hasRowGroups(data);
    if (o.value === "nested-t-test") return data === undefined || countDataGroups(data) === 2;
    if (o.value === "nested-anova") return data === undefined || countDataGroups(data) >= 3;
    return true;
  });
}

/** The key the native Analysis menu depends on for its data-dependent items:
 *  the offered tests, joined. It changes exactly when the offered set changes
 *  (a row band added/removed, a nested group gaining/losing data) and stays
 *  put on edits that don't change the set, so the menu effect re-runs only
 *  when the menu itself would change — without it the menu goes stale once
 *  `isDirty` is true and consecutive edits share an `undoName` (BUG-REPORT #16). */
export function analysisOptionsKey(tableType: TableType | undefined, data?: TableData): string {
  if (!tableType) return "";
  return analysisOptionsForTable(tableType, data)
    .map((o) => o.value)
    .join(",");
}

/** Count data columns (excluding the leading Title column) that hold ≥1 numeric value. */
export function countDataColumns(data: TableData | undefined): number {
  if (!data) return 0;
  return readTable(data).numeric.length;
}

/** Count Grouped-table column-groups (by "A:Y1"-style name prefix) that hold ≥1 numeric
 *  value. A table's `groups` field is structural (how many are provisioned), not how many
 *  actually have data entered — tests needing an exact data-group count must check this. */
export function countDataGroups(data: TableData | undefined): number {
  if (!data) return 0;
  return groupsOf(readTable(data).numeric).length;
}
