// Three-way ANOVA — a Grouped table's column-groups (A), row position within
// each band (B) and row bands (C), plus every interaction. Type III sums of
// squares, like the two-way ANOVA: sum-to-zero contrasts + drop1 over the full
// scope, with each term's F/Df/P pulled out by matching drop1's row names
// (never by assumed row index). Post-hoc Tukey/Bonferroni on one chosen term
// reuses the pooled-MSE + ptukey technique from the two-way ANOVA's runPosthoc
// (q = sqrt(2)*|t|, t from the pooled-MSE two-sample statistic). No TukeyHSD call.
import type { AnalysisOutcome, Column, ComparisonRow, ThreeWayAnovaParams } from "../types";
import type { RowGroup } from "../../store/types";
import { describe, pairIndices, pRow, rStr, rVec } from "../column/base";
import { evalNamedVector } from "../webr";
import { flattenThreeWay, rowGroupBands, rowName } from "./base";
import { mean } from "../../lib/summary";

const TERMS = ["A", "B", "C", "A:B", "A:C", "B:C", "A:B:C"] as const;
type ThreeWayTerm = (typeof TERMS)[number];

/** The cell means of one term: one entry per level (or level combination),
 *  with the values behind it and its result-table label. */
interface TermCell {
  label: string;
  values: number[];
}

function termCells(
  term: ThreeWayTerm,
  flat: { values: number[]; a: string[]; b: string[]; c: string[] },
  titles: (string | null)[],
): TermCell[] {
  const byKey = new Map<string, { label: string; values: number[] }>();
  const bLabel = (b: string) => rowName(titles, Number(b.slice(1)) - 1);
  const keyAndLabel = (i: number): [string, string] => {
    const a = flat.a[i];
    const b = flat.b[i];
    const c = flat.c[i];
    switch (term) {
      case "A":
        return [a, a];
      case "B":
        return [b, bLabel(b)];
      case "C":
        return [c, c];
      case "A:B":
        return [`${a}\n${b}`, `${a} (${bLabel(b)})`];
      case "A:C":
        return [`${a}\n${c}`, `${a} (${c})`];
      case "B:C":
        return [`${b}\n${c}`, `${bLabel(b)} (${c})`];
      case "A:B:C":
        return [`${a}\n${b}\n${c}`, `${a} (${bLabel(b)}, ${c})`];
    }
  };
  flat.values.forEach((v, i) => {
    const [key, label] = keyAndLabel(i);
    const cell = byKey.get(key) ?? { label, values: [] };
    cell.values.push(v);
    byKey.set(key, cell);
  });
  // Keep the cells in first-seen order: A, B and C levels in table order, and
  // interactions in the same (A, then B, then C) nesting as the flattened data.
  return [...byKey.values()];
}

async function runPosthoc(
  cells: TermCell[],
  method: "tukey" | "bonferroni",
  mse: number,
  dfResid: number,
): Promise<ComparisonRow[] | undefined> {
  const pairs: { label1: string; label2: string; diff: number; t: number }[] = [];
  for (const [i, j] of pairIndices(cells.length)) {
    const vi = cells[i].values;
    const vj = cells[j].values;
    const diff = mean(vi) - mean(vj);
    const t = diff / Math.sqrt(mse * (1 / vi.length + 1 / vj.length));
    pairs.push({ label1: cells[i].label, label2: cells[j].label, diff, t });
  }
  if (pairs.length === 0) return undefined;
  const nmeans = cells.length;
  const m = pairs.length;
  const rCode =
    method === "tukey"
      ? `c(${pairs.map((c, k) => `p${k}=1-ptukey(${Math.abs(c.t) * Math.SQRT2},${nmeans},${dfResid})`).join(",")})`
      : `c(${pairs.map((c, k) => `p${k}=pmin(1,${m}*2*pt(${-Math.abs(c.t)},${dfResid}))`).join(",")})`;
  const v = await evalNamedVector(rCode);
  return pairs.map((c, k) => ({ group1: c.label1, group2: c.label2, diff: c.diff, p: v[`p${k}`] ?? null }));
}

export async function runThreeWayAnova(
  columns: Column[],
  params: ThreeWayAnovaParams | undefined,
  titles: (string | null)[],
  rowGroups?: RowGroup[],
): Promise<AnalysisOutcome> {
  const rowCount = columns[0]?.byRow.length ?? 0;
  const bands = rowGroupBands(rowGroups);
  if (!bands || bands.length < 2) {
    return {
      error:
        "Three-way ANOVA needs at least 2 column groups, 2 rows per row group, and 2 row groups. " +
        "Add row groups in the table's Groups panel: split the rows into at least 2 named bands.",
    };
  }
  if (bands.some((b) => !b.name.trim()) || new Set(bands.map((b) => b.name)).size !== bands.length) {
    return { error: "Row group names must be non-empty and different from each other." };
  }
  if (bands.reduce((sum, b) => sum + b.count, 0) !== rowCount || bands.some((b) => b.count < 1)) {
    return { error: "Row groups must cover every row exactly once." };
  }
  const flat = flattenThreeWay(columns, bands);
  const aLevels = [...new Set(flat.a)];
  const bLevels = [...new Set(flat.b)];
  const cLevels = [...new Set(flat.c)];
  if (aLevels.length < 2 || bLevels.length < 2 || cLevels.length < 2 || flat.values.length === 0) {
    return {
      error: "Three-way ANOVA needs at least 2 column groups, 2 rows per row group, and 2 row groups.",
    };
  }
  // An empty A×B×C cell makes the 3-way term inestimable in R (NA rows) —
  // refuse it up front, naming the first empty cell.
  const counts = new Map<string, number>();
  flat.values.forEach((_, i) => {
    const key = `${flat.a[i]}\n${flat.b[i]}\n${flat.c[i]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  for (const a of aLevels) {
    for (const b of bLevels) {
      for (const c of cLevels) {
        if (!counts.has(`${a}\n${b}\n${c}`)) {
          return {
            error:
              `Every combination of the three factors needs at least one value. ` +
              `${a} × ${rowName(titles, Number(b.slice(1)) - 1)} × ${c} has no values.`,
          };
        }
      }
    }
  }
  const dfResid = flat.values.length - aLevels.length * bLevels.length * cLevels.length;
  if (dfResid < 1) {
    return {
      error:
        "Each combination needs replicates (or the design needs more rows) — there are no residual degrees of freedom.",
    };
  }

  const rFactor = (labels: string[]) => `factor(c(${labels.map(rStr).join(",")}))`;
  const setup = `v<-${rVec(flat.values)};A<-${rFactor(flat.a)};B<-${rFactor(flat.b)};C<-${rFactor(flat.c)}`;
  // Type III sums of squares (matches GraphPad Prism on unbalanced designs; on
  // balanced designs Type I = II = III, so nothing changes there). Base-R recipe:
  // sum-to-zero contrasts on the factors + drop1 over the full scope. Contrasts are
  // set on the factor objects (NOT global options()) so no other analysis is affected.
  // Each term is pulled out by matching drop1's row names — drop1 returns one row
  // per term in formula order ("<none>", "A", "B", "C", "A:B", "A:C", "B:C", "A:B:C").
  const keyOf = (term: string) => term.replace(/:/g, "");
  const pick = (term: string, col: string) => `a$${col}[match("${term}",rn)]`;
  const rCode =
    `${setup};contrasts(A)<-"contr.sum";contrasts(B)<-"contr.sum";contrasts(C)<-"contr.sum";` +
    `f<-aov(v~A*B*C);a<-drop1(f,~.,test="F");dfr<-df.residual(f);mse<-deviance(f)/dfr;rn<-rownames(a);` +
    `c(${TERMS.map(
      (t) =>
        `${keyOf(t)}F=${pick(t, '"F value"')},${keyOf(t)}Df=${pick(t, "Df")},${keyOf(t)}P=${pick(t, '"Pr(>F)"')}`,
    ).join(",")},dfResid=dfr,mse=mse)`;

  const v = await evalNamedVector(rCode);
  const effect = (term: string) => [
    { label: `${term} F`, value: v[`${keyOf(term)}F`] ?? null },
    { label: `${term} DFn`, value: v[`${keyOf(term)}Df`] ?? null },
    pRow(`${term} P value`, v[`${keyOf(term)}P`] ?? null),
  ];
  const stats = [...TERMS.flatMap(effect), { label: "DFd (residual)", value: v.dfResid ?? null }];
  const groups = aLevels.map((name) => describe({ name, values: flat.values.filter((_, i) => flat.a[i] === name) }));

  const posthoc = params?.posthoc ?? "none";
  const posthocTerm: ThreeWayTerm =
    params?.posthocTerm && (TERMS as readonly string[]).includes(params.posthocTerm) ? params.posthocTerm : "A";
  const cells = posthoc === "none" ? [] : termCells(posthocTerm, flat, titles);
  const comparisons =
    posthoc === "none" ? undefined : await runPosthoc(cells, posthoc, v.mse ?? NaN, v.dfResid ?? NaN);
  const bLabels = bLevels.map((b) => rowName(titles, Number(b.slice(1)) - 1));
  const notes =
    `A = Group (${aLevels.join(", ")}); B = Row (${bLabels.join(", ")}); C = Row group (${cLevels.join(", ")}). ` +
    `Compares the three factors and all their interactions; assumes normal distributions with equal variances (Type III sums of squares). ` +
    `${flat.values.length} observations in ${aLevels.length * bLevels.length * cLevels.length} cells` +
    (flat.dropped > 0 ? `; ${flat.dropped} empty cell${flat.dropped === 1 ? "" : "s"} left out` : "") +
    "." +
    (posthoc === "none" ? "" : ` Multiple comparisons follow the ${posthocTerm} term.`);
  return {
    testType: "three-way-anova",
    subtitle: "Ordinary three-way ANOVA",
    stats,
    groups,
    notes,
    comparisons,
    comparisonsLabel: comparisons?.length
      ? `${posthoc === "tukey" ? "Tukey's" : "Bonferroni-corrected"} multiple comparisons test ` +
        `(${posthocTerm} ${posthocTerm.includes(":") ? "cell means" : "means"})`
      : undefined,
  };
}
