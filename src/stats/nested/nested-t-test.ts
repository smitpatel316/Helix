// Nested t test — compares two groups by taking the mean of each subcolumn
// (each animal/subject) and running an unpaired Student t test on those
// subcolumn means (df = number of subcolumns − 2), as Prism does. The
// subcolumn means are the data: running the test on the raw replicate values
// would inflate n and fabricate significance, so the means-based values here
// are the correct ones — a far smaller P from the raw values would be the bug.
// Bespoke runner (not ColumnTestSpec): the data are subgroup means, not columns.
import type { AnalysisOutcome, AnalysisParams, Column } from "../types";
import { describe, pRow, rVec } from "../column/base";
import { evalNamedVector } from "../webr";
import { droppedStatement, meansStatement, nestedMeans } from "./base";

export async function runNestedTTest(columns: Column[], _params: AnalysisParams | undefined): Promise<AnalysisOutcome> {
  const { groups, dropped } = nestedMeans(columns);
  if (groups.length !== 2) {
    return {
      error: `Nested t test needs exactly two groups — this table has ${groups.length}.`,
    };
  }
  const empty = groups.filter((g) => g.means.length === 0);
  if (empty.length) {
    return {
      error: `Group “${empty[0].name}” has no subcolumns with values. Enter data into at least one subcolumn and try again.`,
    };
  }
  const thin = groups.filter((g) => g.means.length < 2);
  if (thin.length) {
    return {
      error:
        `Nested t test needs at least two subcolumns with values in each group — with one subcolumn per group ` +
        `there is no variation to test. “${thin[0].name}” has ${thin[0].means.length}.`,
    };
  }
  const [g0, g1] = groups;
  // t.test(g1, g0): the difference, t and confidence interval are group 2
  // minus group 1 (Treated − Control), so a positive t means group 2 is higher.
  const code =
    `g0<-${rVec(g0.means)};g1<-${rVec(g1.means)};tt<-t.test(g1,g0,var.equal=TRUE);` +
    `c(t=unname(tt$statistic),df=unname(tt$parameter),p=tt$p.value,m1=mean(g0),m2=mean(g1),` +
    `diff=mean(g1)-mean(g0),lo=tt$conf.int[1],hi=tt$conf.int[2])`;
  const v = await evalNamedVector(code);
  const described = (
    await describe(
      groups.map((g) => ({ name: g.name, values: g.means })),
    )
  ).groups;
  return {
    testType: "nested-t-test",
    stats: [
      { label: "t", value: v.t },
      { label: "df", value: v.df },
      pRow("P value", v.p),
      { label: `Mean (${g0.name})`, value: v.m1 },
      { label: `Mean (${g1.name})`, value: v.m2 },
      { label: "Difference of means", value: v.diff },
      { label: "95% CI lower", value: v.lo },
      { label: "95% CI upper", value: v.hi },
      { label: `Subcolumns (${g0.name})`, value: g0.means.length },
      { label: `Subcolumns (${g1.name})`, value: g1.means.length },
    ],
    groups: described,
    notes:
      meansStatement(groups) +
      droppedStatement(dropped) +
      ` Student's t test (equal variances assumed) comparing “${g0.name}” with “${g1.name}”.`,
  };
}
