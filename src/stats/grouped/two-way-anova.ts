// Two-way ANOVA — compares a Grouped table's column-groups (A, B, C…) and row
// position, plus their interaction. `design` picks:
// - "ordinary": independent-samples two-way ANOVA.
// - "repeated-measures": matched by row — each replicate column is treated as
//   one subject, measured at every row within its group (a mixed/split-plot
//   design); computed via `aov(v~g*r+Error(id/r))`, base R's standard formula for
//   this design. Incomplete replicate columns (missing a row) are dropped. Sphericity not
//   assumed (`sphericity` false), the row and interaction effects, within subjects, take
//   the Geisser-Greenhouse epsilon of the rows' covariance pooled over the groups, and each
//   comparison its own error (`correctedPosthoc`).
// - "nonparametric": Scheirer-Ray-Hare — rank-transform the response, run the
//   same ANOVA on the ranks, then convert each effect's Sum-of-Squares into a
//   chi-square H statistic — fully computable in base R.
// `posthoc` (parametric designs only) pairwise-compares either groups within
// each row, or rows within each group ("row means"), using the design's own
// pooled residual variance — the same statistic R's own TukeyHSD computes
// internally (q = sqrt(2)*|t|, t from the pooled-MSE two-sample t stat), just
// derived directly instead of relying on TukeyHSD's interaction-term row naming.
// Each row (or each group) is a family of comparisons, corrected on its own.
// Tukey, Bonferroni, Šídák, Holm–Šídák and Fisher's LSD are offered (plan 25);
// the Šídák family adjusts in TS per family, on raw P values from R.
import type { AnalysisOutcome, Column, ComparisonRow, TwoWayAnovaParams } from "../types";
import { adjustPValues, describe, pairIndices, pRow, rStr, rVec } from "../column/base";
import { evalNamedVector } from "../webr";
import { completeSubjects, flattenGrouped, flattenRepeated, groupRows, rowName } from "./base";

/** Short heading for a post-hoc method in a two-way comparisons label. */
const POSTHOC_LABEL_SHORT: Record<string, string> = {
  tukey: "Tukey's",
  bonferroni: "Bonferroni-corrected",
  sidak: "Šídák-corrected",
  "holm-sidak": "Holm–Šídák",
  lsd: "Fisher's LSD (uncorrected)",
};

/** The post-hoc methods a two-way ANOVA offers (plan 25): Tukey, Bonferroni,
 *  Šídák, Holm–Šídák and Fisher's LSD. Anything else the params type allows
 *  (Dunnett, Games-Howell, T3 — one-way only) is refused up front rather than
 *  silently run as Bonferroni. */
const TWO_WAY_POSTHOCS = ["none", "tukey", "bonferroni", "sidak", "holm-sidak", "lsd"] as const;
type TwoWayPosthoc = (typeof TWO_WAY_POSTHOCS)[number];

/** Adjust each family's P values (one row, or one group, is a family) — the
 *  Šídák / Holm–Šídák step needs the whole family sorted, so R returns raw P
 *  values and the adjustment runs here, family by family. */
function adjustFamilies(rows: ComparisonRow[], families: string[], method: "sidak" | "holm-sidak"): ComparisonRow[] {
  const out = [...rows];
  for (const family of new Set(families)) {
    const idx = families.map((f, i) => (f === family ? i : -1)).filter((i) => i >= 0);
    const adjusted = adjustPValues(
      idx.map((i) => rows[i].p),
      method,
    );
    idx.forEach((i, k) => {
      out[i] = { ...rows[i], p: adjusted[k] };
    });
  }
  return out;
}

// Group/row/subject labels derive from user column names, so they must be escaped
// before interpolation — only their distinctness matters to the model, not their text.
const rFactor = (labels: string[]) => `factor(c(${labels.map(rStr).join(",")}))`;

async function runPosthoc(
  columns: Column[],
  method: TwoWayPosthoc,
  target: "groups" | "rows",
  mse: number | null,
  dfResid: number | null,
  titles: (string | null)[],
): Promise<ComparisonRow[] | undefined> {
  if (mse == null || dfResid == null) return undefined;
  const rows = groupRows(columns);
  const names = [...rows.keys()];
  const rowCount = rows.get(names[0])?.length ?? 0;
  // Each comparison's two cells (a group at a row) and how many means its family compares
  // (the groups holding data at its row, or the rows holding data in its group).
  // `family` is the row (groups target) or group (rows target) the comparison belongs to:
  // each family is corrected on its own.
  const cells: { label1: string; label2: string; a: number[]; b: number[]; means: number; family: string }[] = [];
  if (target === "groups") {
    for (let r = 0; r < rowCount; r++) {
      const means = names.filter((name) => rows.get(name)![r].length > 0).length;
      for (const [i, j] of pairIndices(names.length)) {
        const [a, b] = [rows.get(names[i])![r], rows.get(names[j])![r]];
        if (a.length && b.length)
          cells.push({
            label1: `${names[i]} (${rowName(titles, r)})`,
            label2: `${names[j]} (${rowName(titles, r)})`,
            a,
            b,
            means,
            family: rowName(titles, r),
          });
      }
    }
  } else {
    for (const name of names) {
      const rowsForGroup = rows.get(name)!;
      const means = rowsForGroup.filter((v) => v.length > 0).length;
      for (const [i, j] of pairIndices(rowCount)) {
        const [a, b] = [rowsForGroup[i], rowsForGroup[j]];
        if (a.length && b.length)
          cells.push({
            label1: `${rowName(titles, i)} (${name})`,
            label2: `${rowName(titles, j)} (${name})`,
            a,
            b,
            means,
            family: name,
          });
      }
    }
  }
  if (cells.length === 0) return undefined;
  // In R: each pair's difference of means, its t on the ANOVA's mean square, and its P
  // corrected within its family. Šídák / Holm–Šídák take the raw P here and adjust
  // in TS (adjustFamilies below); LSD reports it as is.
  const p = (c: (typeof cells)[number]) =>
    method === "tukey"
      ? `ptukey(abs(t)*sqrt(2),${c.means},${dfResid},lower.tail=FALSE)`
      : method === "bonferroni"
        ? `pmin(1,${(c.means * (c.means - 1)) / 2}*2*pt(-abs(t),${dfResid}))`
        : `2*pt(-abs(t),${dfResid})`;
  const v = await evalNamedVector(
    `c(${cells
      .map(
        (c) =>
          `{a<-${rVec(c.a)};b<-${rVec(c.b)};d<-mean(a)-mean(b);t<-d/sqrt(${mse}*(1/length(a)+1/length(b)));` +
          `c(d=d,p=${p(c)})}`,
      )
      .map((code, k) => `setNames(${code},c("d_${k}","p_${k}"))`)
      .join(",")})`,
  );
  const comparisons = cells.map((c, k) => ({
    group1: c.label1,
    group2: c.label2,
    diff: v[`d_${k}`] ?? null,
    p: v[`p_${k}`] ?? null,
  }));
  return method === "sidak" || method === "holm-sidak"
    ? adjustFamilies(
        comparisons,
        cells.map((c) => c.family),
        method,
      )
    : comparisons;
}

/** R comparing the cells of a repeated-measures design without assuming sphericity (`Y`:
 *  a subject per row, a table row per column; `gs`: each subject's group), each comparison on
 *  its own error, never the whole experiment's: rows within a group, a paired t on that
 *  group's differences (n − 1 df); groups within a row, that row's pooled SD. */
function correctedPosthoc(
  method: TwoWayPosthoc,
  target: "groups" | "rows",
  groupNames: string[],
  rowNames: string[],
): { rCode: string; labels: [string, string][]; families: string[] } {
  const labels: [string, string][] = [];
  const families: string[] = [];
  const parts: string[] = [];
  const p = (means: number, df: string) =>
    method === "tukey"
      ? `ptukey(t*sqrt(2),${means},${df},lower.tail=FALSE)`
      : method === "bonferroni"
        ? `pmin(1,${(means * (means - 1)) / 2}*2*pt(-t,${df}))`
        : // Šídák / Holm–Šídák take the raw P and adjust in TS per family; LSD as is.
          `2*pt(-t,${df})`;
  if (target === "rows") {
    for (const g of groupNames)
      for (const [i, j] of pairIndices(rowNames.length)) {
        labels.push([`${rowNames[i]} (${g})`, `${rowNames[j]} (${g})`]);
        families.push(g);
        parts.push(
          `{a<-Y[gs==${rStr(g)},${i + 1}];b<-Y[gs==${rStr(g)},${j + 1}];d<-a-b;n<-length(d);` +
            `t<-abs(mean(d))/(sd(d)/sqrt(n));c(mean(a)-mean(b),${p(rowNames.length, "n-1")})}`,
        );
      }
  } else {
    rowNames.forEach((row, r) => {
      for (const [i, j] of pairIndices(groupNames.length)) {
        const [a, b] = [groupNames[i], groupNames[j]];
        labels.push([`${a} (${row})`, `${b} (${row})`]);
        families.push(row);
        parts.push(
          `{e<-Y[,${r + 1}];m<-tapply(e,gs,mean);k<-tapply(e,gs,length);dfe<-length(e)-nlevels(gs);` +
            `mse<-sum((e-m[gs])^2)/dfe;t<-abs(m[[${rStr(a)}]]-m[[${rStr(b)}]])/sqrt(mse*(1/k[[${rStr(a)}]]+1/k[[${rStr(b)}]]));` +
            `c(m[[${rStr(a)}]]-m[[${rStr(b)}]],${p(groupNames.length, "dfe")})}`,
        );
      }
    });
  }
  const rCode = parts.map((code, k) => `setNames(${code},c("d_${k}","p_${k}"))`).join(",");
  return { rCode, labels, families };
}

async function runRepeatedMeasures(
  columns: Column[],
  params: TwoWayAnovaParams,
  titles: (string | null)[],
): Promise<AnalysisOutcome> {
  const { values, group, row, subject, dropped } = flattenRepeated(columns);
  if (new Set(group).size < 2 || new Set(row).size < 2 || values.length === 0) {
    return {
      error:
        "Repeated-measures two-way ANOVA needs at least 2 column groups and 2 rows, each with at least one " +
        "replicate column that has a value in every row.",
    };
  }
  const corrected = params.sphericity === false;
  // The kept rows, in order (each subject holds one value at each); their display names.
  const rowKeys = [...new Set(row)];
  const rowNames = rowKeys.map((key) => rowName(titles, Number(key.slice(1)) - 1));
  const groupNames = [...new Set(group)];
  const setup = `v<-${rVec(values)};g<-${rFactor(group)};r<-${rFactor(row)};id<-${rFactor(subject)}`;
  // Y: a subject per row (values come subject by subject, rows in order); gs its group.
  // Geisser-Greenhouse: epsilon of the rows' covariance pooled over the groups, double-centered.
  // A zero denominator means the differences have no variance at all (sphericity holds
  // exactly) — epsilon is 1, never 0/0.
  const q = rowKeys.length;
  const gg =
    `Y<-matrix(v,ncol=${q},byrow=TRUE);gs<-factor(g[seq(1,length(v),by=${q})]);` +
    `S<-Reduce("+",lapply(split(seq_len(nrow(Y)),gs),function(i)(length(i)-1)*cov(Y[i,,drop=FALSE])))/(nrow(Y)-nlevels(gs));` +
    `H<-diag(${q})-1/${q};C<-H%*%S%*%H;ggd<-(${q - 1})*sum(C*C);e<-if(ggd>0)min(1,sum(diag(C))^2/ggd)else 1`;
  const within = (k: string, f: string, df: string, resid: string, p: string) =>
    corrected
      ? `${k}S=${f},${k}Df=e*${df},${k}DfResid=e*${resid},${k}P=pf(${f},e*${df},e*${resid},lower.tail=FALSE)`
      : `${k}S=${f},${k}Df=${df},${k}DfResid=${resid},${k}P=${p}`;
  const posthoc =
    corrected && params.posthoc !== "none"
      ? // runTwoWayAnova refuses any posthoc outside TWO_WAY_POSTHOCS before dispatching here.
        correctedPosthoc(params.posthoc as TwoWayPosthoc, params.posthocTarget, groupNames, rowNames)
      : undefined;
  const rCode =
    `${setup};a<-summary(aov(v~g*r+Error(id/r)));e1<-a[["Error: id"]][[1]];e2<-a[["Error: id:r"]][[1]];` +
    `${gg};c(gS=e1$"F value"[1],gDf=e1$Df[1],gP=e1$"Pr(>F)"[1],gDfResid=e1$Df[2],gMse=e1$"Sum Sq"[2]/e1$Df[2],` +
    `${within("r", 'e2$"F value"[1]', "e2$Df[1]", "e2$Df[3]", 'e2$"Pr(>F)"[1]')},` +
    `${within("i", 'e2$"F value"[2]', "e2$Df[2]", "e2$Df[3]", 'e2$"Pr(>F)"[2]')},` +
    `rMse=e2$"Sum Sq"[3]/e2$Df[3],eps=e${posthoc ? "," + posthoc.rCode : ""})`;

  const v = await evalNamedVector(rCode);
  const effect = (label: string, k: string) => [
    { label: `${label} F`, value: v[`${k}S`] ?? null },
    { label: `${label} DFn`, value: v[`${k}Df`] ?? null },
    ...(corrected && k !== "g" ? [{ label: `${label} DFd`, value: v[`${k}DfResid`] ?? null }] : []),
    pRow(`${label} P value`, v[`${k}P`] ?? null),
  ];
  const stats = [
    ...effect("Group", "g"),
    ...effect("Row", "r"),
    ...effect("Interaction", "i"),
    ...(corrected ? [{ label: "Geisser-Greenhouse epsilon", value: v.eps ?? null }] : []),
  ];
  const { groups } = await describe(
    [...new Set(group)].map((name) => ({ name, values: values.filter((_, i) => group[i] === name) })),
  );
  // Groups (between-subjects) comparisons use the "Error: id" stratum's residual;
  // rows (within-subject) comparisons use the "Error: id:r" stratum's — an
  // approximation of Prism's exact RM multiple-comparisons SE, using each effect's
  // own pooled error term.
  const mse = params.posthocTarget === "groups" ? v.gMse : v.rMse;
  const dfResid = params.posthocTarget === "groups" ? v.gDfResid : v.rDfResid;
  const correctedRows: ComparisonRow[] | undefined = posthoc
    ? posthoc.labels.map(([group1, group2], k): ComparisonRow => ({
        group1,
        group2,
        diff: v[`d_${k}`] ?? null,
        p: v[`p_${k}`] ?? null,
      }))
    : undefined;
  const comparisons = correctedRows
    ? params.posthoc === "sidak" || params.posthoc === "holm-sidak"
      ? adjustFamilies(correctedRows, posthoc!.families, params.posthoc)
      : correctedRows
    : params.posthoc !== "none"
      ? await runPosthoc(
          // The subjects the ANOVA kept: comparisons are of the same means.
          // runTwoWayAnova refuses any posthoc outside TWO_WAY_POSTHOCS first.
          completeSubjects(columns).subjects,
          params.posthoc as TwoWayPosthoc,
          params.posthocTarget,
          mse ?? null,
          dfResid ?? null,
          titles,
        )
      : undefined;
  return {
    testType: "two-way-anova",
    subtitle: "Repeated-measures two-way ANOVA",
    stats,
    groups,
    notes:
      "Matched by row: each replicate column is treated as the same subject across every row within its group. " +
      (corrected
        ? "Sphericity not assumed: the Geisser-Greenhouse epsilon corrects the degrees of freedom of the row and " +
          "interaction effects" +
          (posthoc
            ? ", and each comparison has its own error (rows within a group: a paired t test; groups within a row: " +
              "that row's pooled SD)."
            : ".")
        : "Assumes sphericity (no Geisser-Greenhouse correction).") +
      (dropped > 0
        ? ` ${dropped} replicate column${dropped === 1 ? "" : "s"} excluded (missing a value in at least one row).`
        : ""),
    comparisons,
    comparisonsLabel: comparisons?.length
      ? `${POSTHOC_LABEL_SHORT[params.posthoc] ?? params.posthoc} multiple comparisons ` +
        (params.posthocTarget === "groups"
          ? "(groups within each row, each row a family)"
          : "(rows within each group, each group a family)")
      : undefined,
  };
}

export async function runTwoWayAnova(
  columns: Column[],
  params: TwoWayAnovaParams,
  titles: (string | null)[],
): Promise<AnalysisOutcome> {
  if (!(TWO_WAY_POSTHOCS as readonly string[]).includes(params.posthoc)) {
    return {
      error:
        `“${params.posthoc}” multiple comparisons are not available for two-way ANOVA — ` +
        `choose Tukey, Bonferroni, Šídák, Holm–Šídák or Fisher's LSD.`,
    };
  }
  // One value per cell (a group at a row): the interaction can't be told from scatter, so
  // only the ordinary ANOVA runs, without it (as Prism does).
  const replicated = [...groupRows(columns).values()].some((rows) => rows.some((cell) => cell.length > 1));
  if (!replicated && params.design !== "ordinary") {
    return { error: "With one value per cell (no replicates), only the ordinary two-way ANOVA can run." };
  }
  if (params.design === "repeated-measures") return runRepeatedMeasures(columns, params, titles);

  const { values, group, row } = flattenGrouped(columns);
  if (new Set(group).size < 2 || new Set(row).size < 2) {
    return { error: "Two-way ANOVA needs at least 2 column groups and 2 rows of numeric data." };
  }
  const nonparametric = params.design === "nonparametric";
  const setup = `v<-${rVec(values)};g<-${rFactor(group)};r<-${rFactor(row)}`;
  const rCode = nonparametric
    ? `${setup};a<-summary(aov(rank(v)~g*r))[[1]];ms<-sum(a$"Sum Sq")/(length(v)-1);` +
      `c(gS=a$"Sum Sq"[1]/ms,gDf=a$Df[1],gP=pchisq(a$"Sum Sq"[1]/ms,a$Df[1],lower.tail=FALSE),` +
      `rS=a$"Sum Sq"[2]/ms,rDf=a$Df[2],rP=pchisq(a$"Sum Sq"[2]/ms,a$Df[2],lower.tail=FALSE),` +
      `iS=a$"Sum Sq"[3]/ms,iDf=a$Df[3],iP=pchisq(a$"Sum Sq"[3]/ms,a$Df[3],lower.tail=FALSE))`
    : // Type III sums of squares (matches GraphPad Prism on unbalanced designs; on
      // balanced designs Type I = II = III, so nothing changes there). Base-R recipe:
      // sum-to-zero contrasts on the factors + drop1 over the full scope. Contrasts are
      // set on the factor objects (NOT global options()) so no other analysis is affected.
      `${setup};contrasts(g)<-"contr.sum";contrasts(r)<-"contr.sum";` +
      `f<-aov(v~g${replicated ? "*" : "+"}r);a<-drop1(f,~.,test="F");dfr<-df.residual(f);mse<-deviance(f)/dfr;` +
      `c(gS=a$"F value"[2],gDf=a$Df[2],gP=a$"Pr(>F)"[2],` +
      `rS=a$"F value"[3],rDf=a$Df[3],rP=a$"Pr(>F)"[3],` +
      (replicated ? `iS=a$"F value"[4],iDf=a$Df[4],iP=a$"Pr(>F)"[4],` : "") +
      `dfResid=dfr,mse=mse)`;

  const v = await evalNamedVector(rCode);
  const stat = nonparametric ? "H" : "F";
  const effect = (label: string, s: string, df: string, p: string) => [
    { label: `${label} ${stat}`, value: v[s] ?? null },
    { label: `${label} DFn`, value: v[df] ?? null },
    pRow(`${label} P value`, v[p] ?? null),
  ];
  const stats = [
    ...effect("Group", "gS", "gDf", "gP"),
    ...effect("Row", "rS", "rDf", "rP"),
    ...(replicated ? effect("Interaction", "iS", "iDf", "iP") : []),
    ...(nonparametric ? [] : [{ label: "DFd (residual)", value: v.dfResid ?? null }]),
  ];
  const { groups } = await describe(
    [...new Set(group)].map((name) => ({ name, values: values.filter((_, i) => group[i] === name) })),
  );
  const comparisons =
    replicated && !nonparametric && params.posthoc !== "none"
      ? await runPosthoc(
          columns,
          // The guard at the top of this function already refused any other value.
          params.posthoc as TwoWayPosthoc,
          params.posthocTarget,
          v.mse,
          v.dfResid,
          titles,
        )
      : undefined;
  return {
    testType: "two-way-anova",
    subtitle: nonparametric ? "Scheirer-Ray-Hare test" : "Ordinary two-way ANOVA",
    stats,
    groups,
    notes: nonparametric
      ? "Non-parametric two-way analysis (rank-based); no normality assumption."
      : replicated
        ? "Compares group and row-position effects, plus their interaction; assumes normal distributions with equal variances (Type III sums of squares)."
        : "One value per cell (no replicates): the interaction can't be told apart from random scatter, so the model " +
          "assumes there is none and tests the group and row effects only; if there is an interaction, their P values " +
          "mean little. Comparisons within rows or groups need replicates. Assumes normal distributions with equal variances.",
    comparisons,
    comparisonsLabel: comparisons?.length
      ? `${POSTHOC_LABEL_SHORT[params.posthoc] ?? params.posthoc} multiple comparisons ` +
        (params.posthocTarget === "groups"
          ? "(groups within each row, each row a family)"
          : "(rows within each group, each group a family)")
      : undefined,
  };
}
