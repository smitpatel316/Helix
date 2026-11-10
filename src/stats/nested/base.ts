// Shared reading for Nested-table tests. A column "A:S1:R1" belongs to group
// "A", subgroup "S1" (see `nestedGroupsOf`); the replicates are its sibling
// columns. Unlike the Grouped-table tests (one observation per cell), these
// run on one value per subgroup: the mean of its replicate columns, so several
// measurements from one animal (or subject) count once — the Prism nested
// tests' answer to pseudoreplication.
import type { Column } from "../types";
import { nestedGroupsOf } from "../../lib/dataset";
import { mean } from "../../lib/summary";

/** One group's subcolumn means: one value per subgroup holding numbers. */
export interface NestedMeans {
  name: string;
  means: number[];
  /** Subgroups the group has, holding numbers or not. */
  subgroups: number;
  /** Subgroups with no numbers at all, named "group:subgroup". */
  dropped: string[];
}

/** Every group's subcolumn means, in table order. A subgroup's mean is over
 *  all the numbers in its replicate columns (every row); a subgroup with zero
 *  numbers is dropped, not an error — its name is returned so the runner can
 *  say so in its notes. Excluded cells never reach here: `readTable` drops
 *  them before the means are computed. */
export function nestedMeans(columns: Column[]): { groups: NestedMeans[]; dropped: string[] } {
  const groups = nestedGroupsOf(columns).map((g) => {
    const means: number[] = [];
    const dropped: string[] = [];
    for (const s of g.subgroups) {
      const values = s.columns.flatMap((c) => c.values);
      if (!values.length) dropped.push(`${g.name}:${s.name}`);
      else means.push(mean(values));
    }
    return { name: g.name, means, subgroups: g.subgroups.length, dropped };
  });
  return { groups, dropped: groups.flatMap((g) => g.dropped) };
}

/** The sentence every nested test's notes open with: the test ran on subcolumn
 *  means (one value per animal/subject), which groups, and how many subcolumns
 *  each group contributed — so an unbalanced table shows its imbalance. */
export function meansStatement(groups: NestedMeans[]): string {
  const counts = groups
    .map((g) => `“${g.name}” (${g.means.length} subcolumn${g.means.length === 1 ? "" : "s"})`)
    .join(", ");
  return (
    `Ran on subcolumn means — one value per animal/subject, not the individual replicate values — ` + `for ${counts}.`
  );
}

/** The dropped subgroups, as a sentence ("Subgroup B:S2 had no values and was
 *  left out"), or "" when none were dropped. */
export function droppedStatement(dropped: string[]): string {
  if (!dropped.length) return "";
  const names = dropped.map((d) => `“${d}”`).join(", ");
  return dropped.length === 1
    ? ` Subgroup ${names} had no values and was left out.`
    : ` Subgroups ${names} had no values and were left out.`;
}
