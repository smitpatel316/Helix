// K-means clustering on a Multiple Variables table: kmeans() (base R
// `stats`, Hartigan-Wong) on the complete cases, standardised (z-scores)
// by default or in the original units. Bespoke runner (not ColumnTestSpec)
// — the result is cluster assignments and centres, not per-column scalars.
// One evalNamedVector call returning a flat named vector (no matrices cross
// the WebR boundary, only a named vector — the same flat-map rule as
// correlation-matrix.ts).
import type { AnalysisOutcome, Column, KMeansParams } from "../types";
import { dataGroups, describe, incompleteRows, pairedGroups, rVec } from "../column/base";
import { mean, sd } from "../../lib/summary";
import { evalNamedVector, type RVector } from "../webr";

/** The fixed seed, so the same table + params always give the same
 *  partition — R's random starts are not deterministic across runs
 *  without it. */
const SEED = 1;
/** Random starts per run (R's kmeans default is 1; 25 makes the result
 *  far less start-dependent). */
const NSTART = 25;

export async function runKMeans(
  columns: Column[],
  params: KMeansParams | undefined,
  titles?: (string | null)[],
): Promise<AnalysisOutcome> {
  const vars = dataGroups(columns);
  if (vars.length < 2) {
    return { error: "K-means clustering needs at least 2 variables containing numeric data." };
  }
  const k = params?.clusters ?? 2;
  if (!Number.isInteger(k) || k < 2) {
    return { error: "K-means clustering needs at least 2 clusters." };
  }
  // Standardise by default (Prism's default): z-score each variable first.
  const standardise = params?.standardise !== false;
  // Complete cases: the rows where every variable used has a value.
  const aligned = pairedGroups(vars).map((g) => g.values);
  const n = aligned[0].length;
  const p = vars.length;
  const dropped = incompleteRows(vars);
  if (n < 2) {
    return { error: "K-means clustering needs at least 2 complete rows (rows measured in every variable)." };
  }
  if (k >= n) {
    return {
      error: `K-means clustering needs fewer clusters than observations (k = ${k}, ${n} complete rows).`,
    };
  }
  // A constant variable has SD 0: z-scoring divides by zero, so name it
  // before calling R (same convention as Plan 21's PCA constant-variable
  // error). The check runs on the complete cases, not the raw columns — a
  // variable can vary only on rows another variable leaves blank, and be
  // constant once those rows are dropped. In the original units a constant
  // variable is fine — it just contributes nothing to the distances — so
  // the check only applies when standardising.
  if (standardise) {
    const constantIdx = aligned.findIndex((col) => sd(col) === 0);
    if (constantIdx >= 0) {
      const constant = vars[constantIdx];
      return {
        error:
          `“${constant.name}” is constant — K-means clustering cannot standardise a variable with no ` +
          `variation. Remove it from the table, or run without standardisation instead.`,
      };
    }
  }

  // The matrix fills column by column (R's default), and `aligned` is one
  // group (column) per entry — so the flat group-major vector lands as the
  // table's columns, no byrow needed.
  const decls = `m<-matrix(${rVec(aligned.flat())},nrow=${n},ncol=${p})`;
  // as.vector() strips the row names kmeans puts on its centres matrix (a
  // bare `km$centers[1,1]` comes back named "1", which evalNamedVector
  // would surface as "cen0_0.1"); the flattened vector is column-major, so
  // cc[j*k+i] is centers[i,j].
  const centreKeys = Array.from({ length: k }, (_, i) =>
    Array.from({ length: p }, (_, j) => `cen${i}_${j}=cc[${j * k + i + 1}]`),
  ).flat();
  const assignKeys = Array.from({ length: n }, (_, i) => `a${i}=km$cluster[${i + 1}]`);
  const withinKeys = Array.from({ length: k }, (_, i) => `w${i}=km$withinss[${i + 1}]`);
  const sizeKeys = Array.from({ length: k }, (_, i) => `sz${i}=km$size[${i + 1}]`);
  const code =
    `${decls};${standardise ? "m<-scale(m);" : ""}` +
    `set.seed(${SEED});km<-kmeans(m,centers=${k},nstart=${NSTART});cc<-as.vector(km$centers);` +
    `c(tot=km$totss,wth=km$tot.withinss,bet=km$betweenss,${[...centreKeys, ...assignKeys, ...withinKeys, ...sizeKeys].join(",")})`;

  let v: RVector;
  try {
    v = await evalNamedVector(code);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // R's kmeans errors when a cluster empties mid-run, and when there are
    // fewer distinct points than centres — both are the user's k being too
    // big for the data, so say that instead of surfacing R's wording.
    if (msg.includes("empty cluster")) {
      return { error: "K-means clustering ended with an empty cluster — try fewer clusters." };
    }
    if (msg.includes("more cluster centers than distinct data points")) {
      const distinct = new Set(aligned[0].map((_, i) => aligned.map((col) => col[i]).join(","))).size;
      return {
        error:
          `K-means clustering needs fewer clusters than distinct data points — there are only ${distinct} distinct ` +
          `complete row${distinct === 1 ? "" : "s"} for ${k} clusters.`,
      };
    }
    throw err;
  }

  // Centres back-transformed to the original units when standardised
  // (centre_z * SD + mean per variable, with the sample SD R's scale()
  // uses), so the plotted centres sit on the plotted points.
  const means = aligned.map((col) => mean(col));
  const sds = aligned.map((col) => sd(col));
  const centresOrig: (number | null)[][] = Array.from({ length: k }, (_, i) =>
    Array.from({ length: p }, (_, j) => {
      const z = v[`cen${i}_${j}`];
      if (z == null) return null;
      return standardise ? z * sds[j] + means[j] : z;
    }),
  );
  // Cluster labels are arbitrary (R numbers clusters in the order its
  // algorithm finds them): canonicalise by sorting clusters by their
  // first centre coordinate (ascending), then the next coordinates, so a
  // stored result is stable and two runs agree.
  const order = Array.from({ length: k }, (_, i) => i).sort((a, b) => {
    for (let j = 0; j < p; j++) {
      const d = (centresOrig[a][j] ?? 0) - (centresOrig[b][j] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
  const relabel = new Map(order.map((old, idx) => [old, idx + 1]));

  const clusters = order.map((old, idx) => ({
    cluster: `Cluster ${idx + 1}`,
    centre: centresOrig[old],
    n: v[`sz${old}`] ?? 0,
    withinSs: v[`w${old}`] ?? null,
  }));
  // The complete rows, in table order — pairedGroups filters the first
  // variable's rows by the same predicate, so these are its rows.
  const completeRows = vars[0].rows.filter((r) => vars.every((c) => c.byRow[r] != null));
  const assignments = completeRows.map((r, i) => ({
    row: titles?.[r]?.trim() || `Row ${r + 1}`,
    cluster: relabel.get((v[`a${i}`] ?? 1) - 1) ?? 1,
  }));

  const { groups: described } = await describe(pairedGroups(vars));
  const notes: string[] = [
    standardise
      ? "K-means clustering on standardised variables (z-scores) — each variable scaled to mean 0, SD 1 before clustering. Cluster centres are reported back-transformed to the original units, and the sums of squares are on the standardised scale."
      : "K-means clustering on the variables in their original units.",
    `Seed 1, ${NSTART} random starts.`,
    dropped > 0
      ? `Uses ${n} complete rows (${dropped} row${dropped === 1 ? "" : "s"} left out for missing data).`
      : `Uses ${n} complete rows.`,
  ];
  return {
    testType: "k-means",
    subtitle: "K-means clustering",
    stats: [
      { label: "Total sum of squares", value: v.tot ?? null },
      { label: "Within-cluster sum of squares", value: v.wth ?? null },
      { label: "Between-cluster sum of squares", value: v.bet ?? null },
      { label: "Number of clusters (k)", value: k },
      { label: "Complete rows (n)", value: n },
      { label: "Variables (p)", value: p },
    ],
    groups: described,
    notes: notes.join(" "),
    kmeansClusters: clusters,
    kmeansAssignments: assignments,
  };
}
