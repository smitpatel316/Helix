// Contingency-table analysis: Pearson's chi-square test, with Fisher's exact test
// used automatically for 2×2 tables (more accurate for small samples — Prism's
// default there), and the chi-square test for trend (Cochran–Armitage) on a
// qualifying 2×k / k×2 table when the user confirms the categories are ordered
// and equally spaced. Each data column holding counts is a group; each row is a
// category. The count matrix is built from complete rows (every group column
// filled) and the whole test is one WebR round-trip returning a flat named vector.
import type { AnalysisOutcome, ChiSquareParams, Column, StatRow } from "../types";
import { buildContingencyMatrix } from "./common";
import { evalNamedVector } from "../webr";
import { num } from "../../lib/format";

export async function runChiSquare(columns: Column[], params?: ChiSquareParams): Promise<AnalysisOutcome> {
  const built = buildContingencyMatrix(columns);
  if ("error" in built) return built;
  const { matrix, rows, cols } = built;
  const flat = matrix.flat();
  const is2x2 = rows === 2 && cols === 2;

  // The trend test has one direction: 2 columns × ≥3 rows trends across rows
  // on the first column's proportion; ≥3 columns × 2 rows trends across
  // columns on the first row's proportion. A 2×2 has no trend (1 df trend =
  // the association itself) and a 3×3 has no single trend direction.
  const trendAcrossRows = !is2x2 && cols === 2 && rows >= 3;
  const trendAcrossCols = !is2x2 && rows === 2 && cols >= 3;
  const trendShape = trendAcrossRows || trendAcrossCols;
  // Prism always computes the trend on a qualifying table; Helix only does
  // when the user confirms the ordering, so a meaningless trend is never
  // silently reported.
  const trend = trendShape && params?.trendOrdered === true;
  const trendX = trendAcrossRows ? matrix.map((r) => r[0]) : matrix[0];
  const trendN = trendAcrossRows
    ? matrix.map((r) => r.reduce((s, v) => s + v, 0))
    : matrix[0].map((_, c) => matrix.reduce((s, r) => s + r[c], 0));

  // as.numeric() drops R's own names ("X-squared", "df"…): the keys are only ours.
  const rCode = is2x2
    ? `m<-matrix(c(${flat.join(",")}),nrow=2,byrow=TRUE);ft<-fisher.test(m);ct<-suppressWarnings(chisq.test(m));` +
      `c(p=ft$p.value,odds=as.numeric(ft$estimate),oddsLo=ft$conf.int[1],oddsHi=ft$conf.int[2],` +
      `chisq=as.numeric(ct$statistic),df=as.numeric(ct$parameter),minexp=min(ct$expected),n=sum(m))`
    : `m<-matrix(c(${flat.join(",")}),nrow=${rows},byrow=TRUE);ct<-suppressWarnings(chisq.test(m));` +
      (trend ? `tt<-prop.trend.test(c(${trendX.join(",")}),c(${trendN.join(",")}));` : "") +
      `c(chisq=as.numeric(ct$statistic),df=as.numeric(ct$parameter),p=ct$p.value,minexp=min(ct$expected),n=sum(m)` +
      (trend ? `,trend=as.numeric(tt$statistic),trendP=tt$p.value` : "") +
      `)`;

  const v = await evalNamedVector(rCode);
  const stats: StatRow[] = [];
  if (is2x2) {
    stats.push({ label: "P value (Fisher's exact test)", value: v.p ?? null, p: true });
    stats.push({ label: "Odds ratio (conditional estimate)", value: v.odds ?? null });
    stats.push({ label: "Chi-square (Yates' correction, for reference)", value: v.chisq ?? null });
    stats.push({ label: "df", value: v.df ?? null });
  } else {
    stats.push({ label: "Chi-square", value: v.chisq ?? null });
    stats.push({ label: "df", value: v.df ?? null });
    stats.push({ label: "P value", value: v.p ?? null, p: true });
    if (trend) {
      stats.push({ label: "Chi-square for trend", value: v.trend ?? null });
      stats.push({ label: "P value (test for trend)", value: v.trendP ?? null, p: true });
    }
  }

  const lowExpected = !is2x2 && v.minexp != null && v.minexp < 5;
  const notes =
    `Contingency table ${rows}×${cols}, N = ${num(v.n ?? null)}. ` +
    (is2x2
      ? `Fisher's exact test (2×2). Odds ratio 95% CI: ${num(v.oddsLo ?? null)} to ${num(v.oddsHi ?? null)} ` +
        `for the table as entered (rows × columns); it is the test's conditional estimate, close to but not a·d / b·c.`
      : `Pearson's chi-square test.`) +
    (trend
      ? ` Chi-square test for trend (Cochran–Armitage, 1 df): tests for a linear trend in the proportion in the first ` +
        `${trendAcrossRows ? "column across ordered, equally spaced rows." : "row across ordered, equally spaced columns."}`
      : trendShape
        ? ` The table has ordered-looking dimensions (${rows} × ${cols}); the chi-square test for trend was not run — ` +
          `confirm the categories are in a natural order and equally spaced to include it.`
        : "") +
    (lowExpected
      ? " Warning: some expected counts are below 5, so the chi-square approximation may be unreliable — consider combining categories."
      : "");

  return {
    testType: "chi-square",
    subtitle: is2x2 ? "Fisher's exact test" : "Pearson's chi-square test",
    stats,
    groups: [],
    notes,
  };
}
