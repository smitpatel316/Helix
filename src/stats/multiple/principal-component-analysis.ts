// Principal component analysis on a Multiple Variables table: prcomp()
// (base R `stats`, SVD-based) on the complete cases, on the correlation
// matrix (standardised variables) or the covariance matrix (original units).
// Bespoke runner (not ColumnTestSpec) — the result is matrices, not
// per-column scalars. One evalNamedVector call returning a flat named vector
// (no matrices cross the WebR boundary, only a named vector — the same
// flat-map rule as correlation-matrix.ts).
import type {
  AnalysisOutcome,
  Column,
  PcaLoadingRow,
  PcaScoreRow,
  PcaVarianceRow,
  PrincipalComponentAnalysisParams,
} from "../types";
import { dataGroups, describe, incompleteRows, pairedGroups, rBool, rVec } from "../column/base";
import { sd } from "../../lib/summary";
import { evalNamedVector } from "../webr";

/** A component counts as real while its eigenvalue is more than this share of
 *  the total variance — prcomp's trailing components of a rank-deficient fit
 *  are exactly 0 or ~1e-16, so the cut is far from any genuine component. */
const ZERO_EIGENVALUE = 1e-12;

export async function runPrincipalComponentAnalysis(
  columns: Column[],
  params: PrincipalComponentAnalysisParams | undefined,
  titles?: (string | null)[],
): Promise<AnalysisOutcome> {
  const scale = params?.scale === "covariance" ? "covariance" : "correlation";
  const vars = dataGroups(columns);
  if (vars.length < 2) {
    return { error: "PCA needs at least 2 variables containing numeric data." };
  }
  // A constant variable has SD 0: with scale. = TRUE prcomp errors ("cannot
  // rescale a constant/zero column"), so name it before calling R. On the
  // covariance matrix a constant variable is fine — it just contributes no
  // variance — so the check only applies to the correlation matrix.
  if (scale === "correlation") {
    const constant = vars.find((c) => sd(c.values) === 0);
    if (constant) {
      return {
        error:
          `“${constant.name}” is constant — PCA on the correlation matrix cannot standardise a variable with no ` +
          `variation. Remove it from the table, or run PCA on the covariance matrix instead.`,
      };
    }
  }

  // Complete cases: the rows where every variable used has a value.
  const aligned = pairedGroups(vars).map((g) => g.values);
  const n = aligned[0].length;
  const p = vars.length;
  const dropped = incompleteRows(vars);
  if (n < 2) {
    return { error: "PCA needs at least 2 complete rows (rows measured in every variable)." };
  }

  const k = Math.min(n, p); // prcomp returns this many components
  // The matrix fills column by column (R's default), and `aligned` is one
  // group (column) per entry — so the flat group-major vector lands as the
  // table's columns, no byrow needed.
  const decls = `m<-matrix(${rVec(aligned.flat())},nrow=${n},ncol=${p})`;
  const sdKeys = Array.from({ length: k }, (_, j) => `sd${j}=sv[${j + 1}]`);
  const evKeys = Array.from({ length: k }, (_, j) => `ev${j}=ev[${j + 1}]`);
  // as.vector() strips the dimnames prcomp puts on rotation/scores (a bare
  // `pc$rotation[1,1]` comes back named "PC1", which evalNamedVector would
  // surface as "l0_0.PC1"); the flattened vectors are column-major, so
  // rt[j*p+i] is rotation[i,j] and sc[j*n+i] is x[i,j].
  const loadKeys = Array.from({ length: k }, (_, j) =>
    Array.from({ length: p }, (_, i) => `l${i}_${j}=rt[${j * p + i + 1}]`),
  ).flat();
  const scoreKeys = Array.from({ length: k }, (_, j) =>
    Array.from({ length: n }, (_, i) => `s${i}_${j}=sc[${j * n + i + 1}]`),
  ).flat();
  const code =
    `${decls};pc<-prcomp(m,center=TRUE,scale.=${rBool(scale === "correlation")});` +
    `sv<-as.vector(pc$sdev);ev<-sv^2;tot<-sum(ev);rt<-as.vector(pc$rotation);sc<-as.vector(pc$x);` +
    `c(tot=tot,${[...sdKeys, ...evKeys, ...loadKeys, ...scoreKeys].join(",")})`;

  const v = await evalNamedVector(code);
  const total = v.tot ?? 0;
  if (!(total > 0)) {
    return { error: "All variables are constant — PCA needs variation in at least one variable." };
  }
  // Only components with non-zero variance are reported; the trailing zero
  // ones are prcomp's answer to a rank-deficient fit (fewer complete rows
  // than variables, or perfectly collinear variables).
  const kept = Array.from({ length: k }, (_, j) => j).filter((j) => (v[`ev${j}`] ?? 0) / total > ZERO_EIGENVALUE);
  if (!kept.length) {
    return { error: "All variables are constant — PCA needs variation in at least one variable." };
  }
  const rankDeficient = kept.length < k;

  // How many components to report: 0 (or omitted) = all; more than available
  // clamps to what's there. The reported ones are always the first `count`
  // (the largest-variance components, in prcomp's order).
  const asked = params?.components ?? 0;
  const clamped = asked > 0 && asked > kept.length;
  const count = asked > 0 ? Math.min(asked, kept.length) : kept.length;
  const reported = kept.slice(0, count);

  // Sign indeterminacy: SVD signs are arbitrary, so each component is
  // canonicalised — the largest-|loading| entry of the component is made
  // positive, flipping its loadings and scores together — so a stored result
  // is stable and two runs agree.
  const signs = reported.map((j) => {
    let best = 0;
    let bestAbs = -1;
    for (let i = 0; i < p; i++) {
      const abs = Math.abs(v[`l${i}_${j}`] ?? 0);
      if (abs > bestAbs) {
        bestAbs = abs;
        best = i;
      }
    }
    return (v[`l${best}_${j}`] ?? 0) < 0 ? -1 : 1;
  });
  const flip = (j: number) => signs[reported.indexOf(j)];

  const variance: PcaVarianceRow[] = reported.map((j, idx) => {
    const eigenvalue = v[`ev${j}`] ?? null;
    const proportion = eigenvalue == null ? null : eigenvalue / total;
    return {
      component: `PC${idx + 1}`,
      eigenvalue,
      sd: v[`sd${j}`] ?? null,
      proportion,
      cumulative: reported
        .slice(0, idx + 1)
        .reduce((sum, jj) => sum + (v[`ev${jj}`] ?? 0), 0) / total,
    };
  });
  const loadings: PcaLoadingRow[] = vars.map((c, i) => ({
    variable: c.name,
    loadings: reported.map((j) => {
      const value = v[`l${i}_${j}`];
      return value == null ? null : value * flip(j);
    }),
  }));
  // The complete rows, in table order — pairedGroups filters the first
  // variable's rows by the same predicate, so these are its rows.
  const completeRows = vars[0].rows.filter((r) => vars.every((c) => c.byRow[r] != null));
  const scores: PcaScoreRow[] = completeRows.map((r, i) => ({
    row: titles?.[r]?.trim() || `Row ${r + 1}`,
    scores: reported.map((j) => {
      const value = v[`s${i}_${j}`];
      return value == null ? null : value * flip(j);
    }),
  }));

  const prop1 = variance[0]?.proportion ?? null;
  const prop12 =
    variance.length >= 2 ? (variance[0].proportion ?? 0) + (variance[1].proportion ?? 0) : null;
  const described = (await describe(pairedGroups(vars))).groups;
  const notes: string[] = [
    scale === "correlation"
      ? "Principal component analysis on the correlation matrix — each variable standardised to mean 0, SD 1 before the components were computed. Scores are on centred and scaled data."
      : "Principal component analysis on the covariance matrix — variables kept in their original units. Scores are on centred data.",
    dropped > 0
      ? `Uses ${n} complete rows (${dropped} row${dropped === 1 ? "" : "s"} left out for missing data).`
      : `Uses ${n} complete rows.`,
  ];
  if (rankDeficient) {
    notes.push(
      n < p
        ? `Only ${kept.length} component${kept.length === 1 ? "" : "s"} have non-zero variance — there are fewer complete rows (${n}) than variables (${p}), so the fit is rank-deficient.`
        : `Only ${kept.length} component${kept.length === 1 ? "" : "s"} have non-zero variance — some variables are linear combinations of the others, so the fit is rank-deficient.`,
    );
  }
  if (clamped) {
    notes.push(`Asked for ${asked} components; only ${kept.length} available — showing all ${kept.length}.`);
  } else if (asked > 0 && asked < kept.length) {
    notes.push(`Showing the first ${asked} of ${kept.length} components.`);
  }
  return {
    testType: "principal-component-analysis",
    subtitle: "Principal component analysis",
    stats: [
      { label: "Total variance", value: total },
      { label: "Number of components", value: count },
      { label: "Variance explained by PC1", value: prop1 },
      { label: "Variance explained by PC1+PC2", value: prop12 },
      { label: "Complete rows (n)", value: n },
      { label: "Variables (p)", value: p },
    ],
    groups: described,
    notes: notes.join(" "),
    pcaVariance: variance,
    pcaLoadings: loadings,
    pcaScores: scores,
  };
}
