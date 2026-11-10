// Kolmogorov-Smirnov test — two-sample, base R ks.test. Compares two independent
// groups without assuming Gaussian distributions: D is the largest absolute
// vertical distance between the two cumulative frequency distributions.
// One-sample KS (a sample vs. a reference distribution) is out of scope here;
// see plan 07 follow-on.
import type { Column, StatRow } from "../types";
import { dataGroups, declareGroups, pRow, type ColumnTestSpec, type Group } from "./base";

const ERROR = "Kolmogorov-Smirnov test needs two groups with at least 2 values each.";

/** A value appearing more than once in the pooled samples (within or across
 *  groups): R then warns and falls back to the asymptotic P value. */
function hasTies(groups: Group[]): boolean {
  const seen = new Set<number>();
  for (const g of groups) {
    for (const v of g.values) {
      if (seen.has(v)) return true;
      seen.add(v);
    }
  }
  return false;
}

/** How many of a column's cells hold text instead of a number (blank cells don't count). */
const skippedCells = (column: Column): number =>
  column.cells.filter((c, r) => c != null && c.trim() !== "" && column.byRow[r] == null).length;

export const kolmogorovSmirnovSpec: ColumnTestSpec = {
  testType: "kolmogorov-smirnov",
  minGroups: 2,
  maxGroups: 2,
  check: (columns) => {
    const groups = dataGroups(columns).slice(0, 2);
    return groups.length < 2 || groups.some((g) => g.values.length < 2) ? ERROR : undefined;
  },
  // R warns "p-value will be approximate" when ties exist; suppressWarnings keeps
  // that warning from surfacing as a failure — the ties are reported in `notes`
  // instead (detected in TypeScript above), and D stays exact either way.
  rCode: (groups) =>
    `${declareGroups(groups)};k<-suppressWarnings(ks.test(g0,g1));c(D=unname(k$statistic),p=k$p.value)`,
  rows: (v, groups): StatRow[] => [
    { label: "KS distance D", value: v.D },
    pRow("P value", v.p),
    { label: "N (group 1)", value: groups[0].n },
    { label: "N (group 2)", value: groups[1].n },
  ],
  notes: (_params, groups, columns) => {
    const parts = ["D is the maximum absolute difference between the two cumulative distributions."];
    if (hasTies(groups)) parts.push("Tied values present — P value is asymptotic, not exact.");
    const ignored = dataGroups(columns)
      .slice(2)
      .map((c) => c.name);
    if (ignored.length) {
      parts.push(
        `Compares “${groups[0].name}” and “${groups[1].name}”, the first two columns with data; ` +
          `not included: ${ignored.map((n) => `“${n}”`).join(", ")}.`,
      );
    }
    const skipped = groups.map((g) => {
      const column = dataGroups(columns).find((c) => c.name === g.name);
      return column ? skippedCells(column) : 0;
    });
    skipped.forEach((n, i) => {
      if (n) parts.push(`“${groups[i].name}”: ${n} non-numeric cell${n === 1 ? "" : "s"} ignored.`);
    });
    parts.push("One-sample KS (vs. a reference distribution) is not included; see plan 07 follow-on.");
    return parts.join(" ");
  },
  subtitle: () => "Kolmogorov-Smirnov test (two-sample)",
};
