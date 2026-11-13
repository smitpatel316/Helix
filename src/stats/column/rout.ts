// Outlier detection, ROUT method (Motulsky & Brown, BMC Bioinformatics 2006) and
// Grubbs' test (extreme studentized deviate), column by column as in Prism.
// ROUT is computed by R: each column is fitted robustly (on a Column table, a
// Huber mean with MADN scale), each point's residual becomes a t statistic
// (df = n − 1), and points are outliers when their FDR-adjusted P
// (Benjamini-Hochberg) is below Q. Grubbs is plain TypeScript: the statistic
// is closed-form arithmetic (mean, SD, max deviation) and the P value comes
// from the t distribution (src/lib/student-t), so it needs no R package.
import type { AnalysisOutcome, Column, OutliersParams } from "../types";
import { routQError } from "../types";
import { describe, rVec } from "./base";
import { evalNamedVector } from "../webr";
import { tCrit, tTwoSidedP } from "../../lib/student-t";

/** R: `rout(x, q)`, a column's robust mean, then each point's adjusted P (none when the
 *  column has fewer than 3 values or none differ); `HUBER_K` gives 95% efficiency. */
const R_ROUT = `
rout<-function(x,q){mu<-median(x);s<-mad(x);if(length(x)<3||s==0)return(list(mu=if(length(x)<3)NA else mu,p=rep(NA,length(x))))
for(i in 1:30){u<-(x-mu)/s;w<-ifelse(abs(u)<=1.345,1,1.345/abs(u));nx<-sum(w*x)/sum(w);done<-abs(nx-mu)<1e-9;mu<-nx;if(done)break}
list(mu=mu,p=p.adjust(2*pt(-abs((x-mu)/s),length(x)-1),"BH"))}`;

export async function runRout(columns: Column[], params?: OutliersParams): Promise<AnalysisOutcome> {
  const groups = columns.filter((c) => c.values.length > 0);
  if (groups.length < 1) return { error: "This needs at least 1 column containing numeric data." };
  const qPercent = params?.q ?? 1;
  // An out-of-range Q is degenerate, not just unusual: Q ≤ 0 can never flag
  // anything (no adjusted P falls below it) and Q > 50 flags nearly every
  // point — so refuse it here too, not only in the wizard (saved projects
  // and direct runAnalysis calls bypass the wizard).
  const qError = routQError(qPercent);
  if (qError) return { error: qError };

  // Per column: its robust mean, points, outliers and their share; each point's adjusted P;
  // then the totals.
  const v = await evalNamedVector(
    `${R_ROUT}\nq<-${qPercent / 100};R<-lapply(list(${groups.map((g) => rVec(g.values)).join(",")}),rout,q)\n` +
      `o<-sapply(R,function(r)sum(r$p<q,na.rm=TRUE));N<-sapply(R,function(r)length(r$p))\n` +
      `c(unlist(lapply(seq_along(R),function(i)setNames(c(R[[i]]$mu,N[i],o[i],100*o[i]/N[i],R[[i]]$p),` +
      `c(paste0(c("mu_","n_","o_","pc_"),i-1),paste0("p_",i-1,"_",seq_along(R[[i]]$p)-1))))),` +
      `total=sum(N),outliers=sum(o),percent=100*sum(o)/sum(N))`,
  );

  const flagged = groups.flatMap((g, gi) =>
    g.rows.flatMap((row, k) => {
      const p = v[`p_${gi}_${k}`];
      return p != null && p < qPercent / 100 ? [{ group: g.name, row, value: g.values[k], p }] : [];
    }),
  );
  const skipped = groups.filter((_, gi) => v[`p_${gi}_0`] == null).map((g) => g.name);

  const notes =
    (flagged.length
      ? `Flagged as outliers (FDR-adjusted P < Q): ${flagged
          .map((f) => `${f.group} row ${f.row + 1} (value ${f.value}, adj. P = ${f.p.toFixed(4)})`)
          .join("; ")}. Use Edit ▸ Exclude / Include (⌘E) on those cells to leave them out of other tests and graphs.`
      : `No outliers detected at Q = ${qPercent}%.`) +
    ` Method: each column fit independently to a robust mean (Huber M-estimator, scale from the median absolute ` +
    `deviation), residuals tested via a two-tailed t distribution and FDR-corrected (Benjamini-Hochberg) within ` +
    `that column. This mirrors the published Motulsky & Brown (2006) ROUT algorithm's logic, not GraphPad's ` +
    `certified implementation.` +
    (skipped.length ? ` Skipped (too few values or no variation to test): ${skipped.join(", ")}.` : "");

  return {
    testType: "outliers",
    subtitle: `ROUT method (Q = ${qPercent}%)`,
    stats: [
      { label: "Total observations", value: v.total ?? null },
      { label: "Groups analyzed", value: groups.length },
      { label: "Outliers detected", value: v.outliers ?? null },
      { label: "Outlier percentage (%)", value: v.percent ?? null },
      { label: "Q parameter (%)", value: qPercent },
    ],
    groups: (await describe(groups)).groups,
    outlierGroups: groups.map((g, gi) => ({
      group: g.name,
      points: v[`n_${gi}`] ?? 0,
      outliers: v[`o_${gi}`] ?? 0,
      percent: v[`pc_${gi}`] ?? 0,
      robustMean: v[`mu_${gi}`] ?? null,
    })),
    notes,
  };
}

// ── Grubbs' test ───────────────────────────────────────────────────────────

/** R: the Grubbs P of a G at n — `2n × pt(−t, n−2)` with
 *  t² = n(n−2)G²/((n−1)² − nG²) — and the (index, G, P) of a column's most
 *  extreme value. (Upstream 1.0.9, verbatim; the reference check drives it.
 *  The TypeScript implementation below computes G/P directly.) */
export const R_GRUBBS = `
grubbsP<-function(G,n)min(1,2*n*pt(-sqrt(n*(n-2)*G^2/((n-1)^2-n*G^2)),n-2))
grubbs<-function(x){n<-length(x);s<-sd(x);if(n<3||s==0)return(c(NA,NA,NA));i<-which.max(abs(x-mean(x)));G<-abs(x[i]-mean(x))/s
c(i,G,grubbsP(G,n))}`;

/** One round of Grubbs' test on a column's values: its G, two-sided P and
 *  critical value, and the most extreme value's index within `values`. */
interface GrubbsRound {
  g: number;
  p: number;
  critical: number;
  index: number;
}

/** Grubbs' test on one set of values (n ≥ 3, SD > 0): G = max|Y − mean| / SD
 *  (sample SD), compared with the critical value for n and α from the
 *  published table (Grubbs 1969 / NIST Engineering Statistics Handbook).
 *  The P value comes from the t distribution: the most extreme value's
 *  externally studentized residual is t with t² = n(n−2)G² / ((n−1)² − nG²)
 *  on n−2 df, and the two-sided P is 2n × the one-sided t tail — any of the
 *  n values could be the extreme one, in either direction — i.e. n × the
 *  two-sided P. At G = G_crit the t is exactly the upper critical value at
 *  α/(2n), so P = α there, as the table requires. Returns null when the test
 *  cannot run (fewer than 3 values, or no variation). */
function grubbsRound(values: number[], alpha: number): GrubbsRound | null {
  const n = values.length;
  if (n < 3) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  if (sd === 0) return null;
  let index = 0;
  for (let i = 1; i < n; i++) if (Math.abs(values[i] - mean) > Math.abs(values[index] - mean)) index = i;
  const g = Math.abs(values[index] - mean) / sd;
  // G < (n−1)/√n always, so the denominator is positive unless n−1 values
  // coincide — then t is unbounded and the value is an outlier (P = 0).
  const denom = (n - 1) ** 2 - n * g * g;
  const t = denom <= 0 ? Infinity : Math.sqrt((n * (n - 2) * g * g) / denom);
  const p = Math.min(1, n * tTwoSidedP(t, n - 2));
  const tCritValue = tCrit(alpha / n, n - 2);
  const critical = ((n - 1) / Math.sqrt(n)) * Math.sqrt((tCritValue * tCritValue) / (n - 2 + tCritValue * tCritValue));
  return { g, p, critical, index };
}

export async function runGrubbs(columns: Column[], params?: OutliersParams): Promise<AnalysisOutcome> {
  const groups = columns.filter((c) => c.values.length > 0);
  if (groups.length < 1) return { error: "This needs at least 1 column containing numeric data." };
  const alpha = params?.alpha ?? 0.05;
  const iterate = params?.iterate ?? true;

  // Per column: rounds of the test, each on the values still standing; a
  // round that finds an outlier removes it (when iterating) and re-tests.
  // The loop stops when the most extreme value is not significant, when
  // fewer than 3 values remain (at most n−2 removals), or when the column
  // has no variation left to test.
  const perGroup = groups.map((g) => {
    let remaining = g.values.map((value, k) => ({ value, row: g.rows[k] }));
    const rounds: GrubbsRound[] = [];
    const flagged: { group: string; row: number; value: number; p: number }[] = [];
    while (remaining.length >= 3) {
      const round = grubbsRound(
        remaining.map((r) => r.value),
        alpha,
      );
      if (!round) break;
      rounds.push(round);
      if (round.g <= round.critical) break;
      const hit = remaining[round.index];
      flagged.push({ group: g.name, row: hit.row, value: hit.value, p: round.p });
      remaining = remaining.filter((_, i) => i !== round.index);
      if (!iterate) break;
    }
    const skipped = rounds.length === 0;
    return {
      group: g,
      rounds,
      flagged,
      skipped,
      // Mean of the values still standing: the column mean when nothing was
      // flagged (or the test could not run), the cleaned mean otherwise.
      meanAfter: remaining.reduce((a, r) => a + r.value, 0) / remaining.length,
    };
  });

  const flagged = perGroup.flatMap((p) => p.flagged);
  const skipped = perGroup.filter((p) => p.skipped).map((p) => p.group.name);
  const total = groups.reduce((a, g) => a + g.values.length, 0);
  const totalFlagged = flagged.length;

  const notes =
    (flagged.length
      ? `Flagged as outliers (Grubbs' test, α = ${alpha}): ${flagged
          .map((f) => `${f.group} row ${f.row + 1} (value ${f.value}, P = ${f.p.toFixed(4)})`)
          .join("; ")}. Use Edit ▸ Exclude / Include (⌘E) on those cells to leave them out of other tests and graphs.`
      : `No outliers detected by Grubbs' test at α = ${alpha}.`) +
    ` Method: each column's single most extreme value is tested against the t distribution ` +
    `(G = max|Y − mean| / SD); a value is an outlier when G exceeds the critical value for its sample size at α. ` +
    `The test assumes the data (without the outlier) are Gaussian — if they look clearly non-Gaussian, check with ` +
    `the normality analysis first. It tests one value at a time, so two outliers can mask each other` +
    (iterate
      ? `; re-testing after each removal (iteration) mitigates this.`
      : ` — with iteration off, a second outlier can hide behind the first.`) +
    ` The per-column mean shown is the mean after removing flagged outliers.` +
    (skipped.length ? ` Skipped (too few values or no variation to test): ${skipped.join(", ")}.` : "");

  return {
    testType: "outliers",
    subtitle: `Grubbs' test (α = ${alpha})`,
    stats: [
      { label: "Total observations", value: total },
      { label: "Groups analyzed", value: groups.length },
      { label: "Outliers detected", value: totalFlagged },
      { label: "Outlier percentage (%)", value: (100 * totalFlagged) / total },
      { label: "Significance level (alpha)", value: alpha },
      ...perGroup.flatMap((p) => {
        const first = p.rounds[0];
        return [
          { label: `${p.group.name} — G`, value: first?.g ?? null },
          { label: `${p.group.name} — P value`, value: first?.p ?? null },
        ];
      }),
    ],
    groups: (await describe(groups)).groups,
    outlierGroups: perGroup.map((p) => {
      const first = p.rounds[0];
      return {
        group: p.group.name,
        points: p.group.values.length,
        outliers: p.flagged.length,
        percent: (100 * p.flagged.length) / p.group.values.length,
        robustMean: null,
        mean: p.meanAfter,
        grubbs: {
          extreme: first === undefined ? null : (p.group.values[first.index] ?? null),
          g: first?.g ?? null,
          p: first?.p ?? null,
        },
      };
    }),
    notes,
  };
}

/** Outlier detection, ROUT or Grubbs by params — a missing `method` is ROUT,
 *  so old saved analyses (params `{q}` only, or none) reproduce exactly. */
export async function runOutliers(columns: Column[], params?: OutliersParams): Promise<AnalysisOutcome> {
  return params?.method === "grubbs" ? runGrubbs(columns, params) : runRout(columns, params);
}
