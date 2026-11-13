// Nested one-way ANOVA — compares three or more groups by running a one-way
// ANOVA on the subcolumn means (one value per animal/subject), as Prism does.
// Post-hoc comparisons reuse the ANOVA post-hoc computation on those means
// (Tukey via TukeyHSD, Bonferroni via pairwise.t.test). Bespoke runner (not
// ColumnTestSpec): the data are subgroup means, not columns.
import type { AnalysisOutcome, Column, ComparisonRow, NestedAnovaParams } from "../types";
import {
  describe,
  groupsSetup,
  pairIndices,
  pairwisePosthocStatements,
  posthocOf,
  pRow,
  tukeyPosthocStatements,
} from "../column/base";
import { evalNamedVector } from "../webr";
import { droppedStatement, meansStatement, nestedMeans } from "./base";

const DEFAULTS: NestedAnovaParams = { posthoc: "none" };

export async function runNestedAnova(
  columns: Column[],
  params: NestedAnovaParams | undefined,
): Promise<AnalysisOutcome> {
  // A partial params object still runs with the missing fields defaulted
  // (BUG-REPORT #26): `params ?? DEFAULTS` only covered a wholly missing
  // object, so `{}` left posthoc `undefined` and the run was refused.
  const method = ({ ...DEFAULTS, ...params }).posthoc;
  // POSTHOCS also carries the Šídák / Holm–Šídák / LSD options other ANOVAs
  // offer — this runner only does Tukey and Bonferroni, so refuse those here
  // rather than silently running Bonferroni under a Šídák label.
  if (method !== "none" && method !== "tukey" && method !== "bonferroni") {
    return {
      error:
        `“${method}” multiple comparisons are not available for nested one-way ANOVA — ` +
        `choose Tukey or Bonferroni.`,
    };
  }
  const { groups, dropped } = nestedMeans(columns);
  if (groups.length < 3) {
    return {
      error: `Nested one-way ANOVA needs three or more groups — this table has ${groups.length}.`,
    };
  }
  const empty = groups.filter((g) => g.means.length === 0);
  if (empty.length) {
    return {
      error: `Group “${empty[0].name}” has no subcolumns with values. Enter data into at least one subcolumn and try again.`,
    };
  }
  const total = groups.reduce((sum, g) => sum + g.means.length, 0);
  if (total <= groups.length) {
    return {
      error:
        `Nested one-way ANOVA needs at least one group with two or more subcolumns with values — with one ` +
        `subcolumn per group there is no variation within groups to compare against.`,
    };
  }
  const asGroups = groups.map((g) => ({ name: g.name, values: g.means }));
  const setup = `${groupsSetup(asGroups)};a<-summary(aov(v~gr))[[1]]`;
  const mainNames =
    `F=a$"F value"[1],dfn=a$Df[1],dfd=a$Df[2],p=a$"Pr(>F)"[1],` + `ssb=a$"Sum Sq"[1],ssw=a$"Sum Sq"[2],grand=mean(v)`;
  let code: string;
  if (method === "none") {
    code = `${setup};c(${mainNames})`;
  } else {
    const ph =
      method === "tukey"
        ? tukeyPosthocStatements(groups.length)
        : pairwisePosthocStatements(groups.length, `pairwise.t.test(v,gr,p.adjust.method="bonferroni")$p.value`);
    code = `${setup};${ph.setup};c(${mainNames},${ph.assign})`;
  }
  const v = await evalNamedVector(code);
  const described = (await describe(asGroups)).groups;
  const label = posthocOf({ posthoc: method });
  const comparisons: ComparisonRow[] | undefined = label
    ? pairIndices(groups.length).map(([i, j]) => ({
        group1: described[i].name,
        group2: described[j].name,
        diff: described[i].mean != null && described[j].mean != null ? described[i].mean - described[j].mean : null,
        p: v[`p_${i}_${j}`],
      }))
    : undefined;
  return {
    testType: "nested-anova",
    stats: [
      { label: "F", value: v.F },
      { label: "DFn", value: v.dfn },
      { label: "DFd", value: v.dfd },
      pRow("P value", v.p),
      { label: "SS between groups", value: v.ssb },
      { label: "SS within groups", value: v.ssw },
      { label: "Grand mean", value: v.grand },
      { label: "Subcolumns", value: total },
      { label: "Groups", value: groups.length },
    ],
    groups: described,
    notes:
      meansStatement(groups) +
      droppedStatement(dropped) +
      ` One-way ANOVA on the subcolumn means, assuming normal distributions with equal variances` +
      (label ? `, followed by ${label}.` : `.`),
    comparisons,
    comparisonsLabel: label,
  };
}
