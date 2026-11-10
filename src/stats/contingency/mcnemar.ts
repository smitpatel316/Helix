// McNemar's test for paired proportions: a 2×2 table of paired outcomes
// (the same subjects measured twice, or matched pairs) — cells b and c are
// the discordant pairs, the pairs that changed. Prism does not offer this
// test; its guide directs matched-design users to it, so Helix provides it
// here. Base R only: mcnemar.test (with or without the continuity correction)
// and binom.test for the exact two-sided P value and the paired odds ratio's
// exact 95% CI. One WebR round-trip returning a flat named vector.
import type { AnalysisOutcome, Column, McNemarParams, StatRow } from "../types";
import { buildContingencyMatrix } from "./common";
import { evalNamedVector } from "../webr";
import { num } from "../../lib/format";

export async function runMcNemar(columns: Column[], params?: McNemarParams): Promise<AnalysisOutcome> {
  const built = buildContingencyMatrix(columns);
  if ("error" in built) return built;
  const { matrix, rows, cols } = built;
  if (rows !== 2 || cols !== 2) return { error: "McNemar's test needs a 2 × 2 table of paired outcomes." };
  // Rows are the first measurement, columns the second: a = both yes,
  // b = yes→no, c = no→yes, d = both no.
  const [[a, b], [c, d]] = matrix;
  const discordant = b + c;
  if (discordant === 0) {
    return { error: "No discordant pairs (b + c = 0) — McNemar's test cannot be computed." };
  }
  const correct = params?.continuityCorrection !== false;

  // binom.test's CI is for p = b/(b+c); the paired odds ratio is p/(1-p),
  // so the same transform gives its exact 95% CI. (Non-finite endpoints —
  // when c = 0 the upper end is infinite — come back as null from
  // evalNamedVector, and the CI rows are omitted below in that case.)
  const rCode =
    `m<-matrix(c(${a},${b},${c},${d}),nrow=2,byrow=TRUE);` +
    `mt<-mcnemar.test(m,correct=${correct ? "TRUE" : "FALSE"});bt<-binom.test(${b},${discordant},p=0.5);` +
    `c(chisq=as.numeric(mt$statistic),p=mt$p.value,exactP=bt$p.value,` +
    `orLo=bt$conf.int[1]/(1-bt$conf.int[1]),orHi=bt$conf.int[2]/(1-bt$conf.int[2]))`;

  const v = await evalNamedVector(rCode);
  // The test is symmetric in b/c, but the odds ratio is not: it is
  // (row1-yes, row2-no) / (row1-no, row2-yes).
  const or = c === 0 ? null : b / c;
  const stats: StatRow[] = [
    { label: "McNemar's chi-square", value: v.chisq ?? null },
    { label: "P value (McNemar's test)", value: v.p ?? null, p: true },
    { label: "P value (exact binomial)", value: v.exactP ?? null, p: true },
    { label: "Discordant pairs (b + c)", value: discordant },
    { label: "Odds ratio (paired, b/c)", value: or },
  ];
  if (c !== 0) {
    stats.push({ label: "Odds ratio (paired) 95% CI lower", value: v.orLo ?? null });
    stats.push({ label: "Odds ratio (paired) 95% CI upper", value: v.orHi ?? null });
  }

  const smallDiscordant = discordant < 10;
  const notes =
    `McNemar's test for paired proportions (2×2, N = ${num(a + b + c + d)}, 1 df). ` +
    `Prism does not offer this test — it is included because Prism's own guide directs matched-design users to it. ` +
    `Cells are paired outcomes, not independent groups: rows are the first measurement, columns the second — ` +
    `a = both yes (${a}), b = yes→no (${b}), c = no→yes (${c}), d = both no (${d}). ` +
    `Odds ratio (paired) = b/c${c === 0 ? ", undefined here (c = 0 — no no→yes pairs)" : ""}.` +
    (smallDiscordant
      ? ` Warning: only ${discordant} discordant pair${discordant === 1 ? "" : "s"} (b + c < 10), so the chi-square ` +
        `approximation may be unreliable — the exact binomial P value is the safer guide.`
      : "");

  return {
    testType: "mcnemar",
    subtitle: "McNemar's test",
    stats,
    groups: [],
    notes,
  };
}
