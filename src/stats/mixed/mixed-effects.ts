// Mixed-effects model — Prism's repeated-measures analysis that tolerates
// missing values: every observed cell stays in the fit (unlike
// repeated-measures ANOVA, which drops a subject entirely when any of its
// values is missing). Fit with lme4::lmer, Satterthwaite p-values from
// lmerTest::lmer (plan 00 provisions both packages). Bespoke async runner
// (not a ColumnTestSpec) — it needs the long-format reshaping in TypeScript
// (build y / time / subject vectors from the wide table), one R call, and a
// coefficients table + variance components. v1: random intercept only,
// Column tables (rows = subjects) and Grouped tables (replicate columns =
// subjects); random slopes are the v2 follow-on (see types.ts). No base-R
// fallback: an aov(Error()) fit would be repeated-measures ANOVA, which drops
// incomplete subjects and silently defeats the point of the analysis.
import type {
  AnalysisOutcome,
  Column,
  GroupDescriptives,
  MixedEffectsParams,
  RegressionCoefficient,
  StatRow,
  VarianceComponent,
} from "../types";
import { dataGroups, describe, rStr, rVec } from "../column/base";
import { groupsOf } from "../../lib/dataset";
import { evalNamedVector } from "../webr";
import { num } from "../../lib/format";

/** The user-facing error when the lme4/lmerTest packages cannot be loaded —
 *  never a raw R error (plan 00). Unreachable through runAnalysis (it installs
 *  requiredPackages first), but a direct runner call still fails clearly. */
export const MIXED_EFFECTS_PACKAGE_ERROR =
  "The lme4 / lmerTest R packages are not available in this build — see plan 00.";

/** One long-format observation: `tm` is the numeric time/condition index
 *  (0-based column or row), `subj` identifies the subject (table row, or
 *  replicate index within a group), `grp` the between-subject factor level. */
interface LongObs {
  y: number;
  tm: number;
  subj: number;
  grp?: string;
}

/** A Grouped layout: the columns split into named groups ("A:Y1"…) with
 *  replicate columns inside them — the same signal readTable uses for its
 *  sets, plus a ":" in a column name (a grouped table with one replicate per
 *  group has one-column sets). */
function isGroupedLayout(columns: Column[]): boolean {
  return groupsOf(columns).some((g) => g.columns.length > 1) || columns.some((c) => c.name.includes(":"));
}

/** The repeated-measure factor's name: the columns' shared prefix (trailing
 *  digits/spaces trimmed), else "Condition" — e.g. T0–T3 → "T". The wizard
 *  uses the same rule, so the runner and the wizard agree on the name. */
export function columnFactorName(columns: Column[]): string {
  const names = columns.map((c) => c.name);
  let prefix = names[0] ?? "";
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const trimmed = prefix.replace(/[\d\s._-]+$/, "");
  return trimmed || "Condition";
}

/** Column layout: columns are the repeated measurements, rows are subjects.
 *  Only individual missing cells are dropped — never a whole subject. */
function flattenColumn(columns: Column[]): {
  obs: LongObs[];
  subjectRows: number[];
  total: number;
  perColumn: number[];
} {
  const cols = dataGroups(columns);
  const rowCount = cols[0]?.byRow.length ?? 0;
  const subjectRows: number[] = [];
  for (let r = 0; r < rowCount; r++) if (cols.some((c) => c.byRow[r] != null)) subjectRows.push(r);
  const obs: LongObs[] = [];
  const perColumn = cols.map(() => 0);
  for (let j = 0; j < cols.length; j++) {
    for (const r of subjectRows) {
      const v = cols[j].byRow[r];
      if (v != null) {
        obs.push({ y: v, tm: j, subj: r });
        perColumn[j]++;
      }
    }
  }
  return { obs, subjectRows, total: subjectRows.length * cols.length, perColumn };
}

/** Grouped layout: column groups are factor A, rows are factor B (numeric row
 *  index), replicate columns are subjects — replicate k in group A is the same
 *  subject as replicate k in group B, so a replicate column missing in one
 *  group is a missing observation, not a missing subject. */
function flattenGroupedMixed(columns: Column[]): {
  obs: LongObs[];
  groups: string[];
  total: number;
  perGroup: Map<string, number>;
} {
  const groups = groupsOf(columns);
  const rowCount = columns[0]?.byRow.length ?? 0;
  const obs: LongObs[] = [];
  const perGroup = new Map<string, number>();
  let total = 0;
  for (const g of groups) {
    perGroup.set(g.name, 0);
    for (let r = 0; r < rowCount; r++) {
      g.columns.forEach((col, k) => {
        total++;
        const v = col.byRow[r];
        if (v != null) {
          obs.push({ y: v, tm: r, subj: k, grp: g.name });
          perGroup.set(g.name, (perGroup.get(g.name) ?? 0) + 1);
        }
      });
    }
  }
  return { obs, groups: groups.map((g) => g.name), total, perGroup };
}

export async function runMixedEffects(
  columns: Column[],
  params: MixedEffectsParams | undefined,
): Promise<AnalysisOutcome> {
  if (params?.randomStructure === "slope") {
    return {
      error:
        "Random slopes are not yet supported — run the random-intercept model (random slopes arrive in v2).",
    };
  }
  const layout = params?.subjectId ?? (isGroupedLayout(columns) ? "replicate" : "row");

  // ── Long format + fixed-effect terms, per layout ───────────────────────
  let obs: LongObs[];
  let total: number;
  let subjectCount: number;
  let grpLevels: string[] | undefined;
  let grpName = "";
  let timeName: string;
  let interaction: boolean;
  let described: GroupDescriptives[];
  let thinLevels: { name: string; n: number }[] = [];
  if (layout === "row") {
    const cols = dataGroups(columns);
    if (cols.length < 3) {
      return { error: "Mixed-effects model needs at least 3 repeated measurements (columns with data)." };
    }
    const flat = flattenColumn(columns);
    obs = flat.obs;
    total = flat.total;
    subjectCount = flat.subjectRows.length;
    // Per-column available-case descriptives (NOT pairedGroups): the old sync
    // describe ran per column over that column's own non-missing values, and
    // the lme4 fit uses all 23 observations. pairedGroups drops the whole
    // row holding a missing value from EVERY time point, which silently
    // changed the pinned descriptives (T0/T1/T3 n 6 -> 5) in the rebase.
    described = (await describe(cols.map((c) => ({ name: c.name, values: c.values })))).groups;
    thinLevels = cols.map((c, j) => ({ name: c.name, n: flat.perColumn[j] })).filter((t) => t.n < 2);
    const sf = params?.subjectFactor;
    if (sf) {
      const rowCount = cols[0]?.byRow.length ?? 0;
      if (sf.levels.length !== rowCount) {
        return {
          error:
            `The subject factor “${sf.name}” lists ${sf.levels.length} level${sf.levels.length === 1 ? "" : "s"} ` +
            `for ${rowCount} table rows — it needs one level per row.`,
        };
      }
      const blank = flat.subjectRows.find((r) => !sf.levels[r]?.trim());
      if (blank !== undefined) {
        return { error: `The subject factor “${sf.name}” has no level for row ${blank + 1}.` };
      }
      grpLevels = [...new Set(flat.subjectRows.map((r) => sf.levels[r]!))];
      if (grpLevels.length < 2) {
        return { error: `The subject factor “${sf.name}” has only one level — it cannot be a fixed effect.` };
      }
      grpName = sf.name;
      for (const o of obs) o.grp = sf.levels[o.subj]!;
    }
    timeName = params?.fixedFactors?.[sf ? 1 : 0] ?? columnFactorName(cols);
    interaction = params?.interaction ?? false;
  } else {
    const groups = groupsOf(columns);
    if (groups.length < 2) {
      return { error: "Mixed-effects model needs at least 2 column groups." };
    }
    const rowCount = columns[0]?.byRow.length ?? 0;
    if (rowCount < 2) {
      return { error: "Mixed-effects model needs at least 2 rows." };
    }
    const flat = flattenGroupedMixed(columns);
    obs = flat.obs;
    total = flat.total;
    subjectCount = new Set(obs.map((o) => o.subj)).size;
    grpLevels = flat.groups;
    grpName = params?.fixedFactors?.[0] ?? "Group";
    described = (
      await describe(flat.groups.map((name) => ({ name, values: obs.filter((o) => o.grp === name).map((o) => o.y) })))
    ).groups;
    thinLevels = flat.groups
      .map((name) => ({ name, n: flat.perGroup.get(name) ?? 0 }))
      .filter((t) => t.n < 2);
    timeName = params?.fixedFactors?.[1] ?? "Row";
    interaction = params?.interaction ?? true;
  }

  if (subjectCount < 3) {
    return {
      error:
        `Mixed-effects model needs at least 3 subjects (random-effect groups) — ` +
        `this table has ${subjectCount}.`,
    };
  }
  if (obs.length / subjectCount < 3) {
    return {
      error:
        "Mixed-effects model needs at least 3 repeated measures per subject on average — " +
        `this table has ${num(obs.length / subjectCount)}.`,
    };
  }

  // Fixed-effect terms in formula order, with their display labels. R names
  // its coefficients by position, so the labels are built here in TypeScript
  // and the R variables stay the generic grp / tm (a factor named "T" would
  // shadow R's TRUE).
  const terms: { label: string }[] = [{ label: "Intercept" }];
  if (grpLevels) {
    for (const lv of grpLevels.slice(1)) terms.push({ label: `${grpName} (${lv} vs ${grpLevels[0]})` });
  }
  terms.push({ label: timeName });
  if (interaction && grpLevels) {
    for (const lv of grpLevels.slice(1))
      terms.push({ label: `${grpName} × ${timeName} (${lv} vs ${grpLevels[0]})` });
  }
  const fixedPart =
    grpLevels == null ? timeName : interaction ? `${grpName} * ${timeName}` : `${grpName} + ${timeName}`;
  const equation = `y ~ ${fixedPart} + (1 | subject)`;
  const formula = grpLevels == null ? "y~tm+(1|subj)" : interaction ? "y~grp*tm+(1|subj)" : "y~grp+tm+(1|subj)";

  // ── One R call ─────────────────────────────────────────────────────────
  // lmerTest::lmer (not library(lmerTest)) — summary() on its fit carries
  // the Satterthwaite df + p column; plain lmer's summary has 3 columns, so
  // the extraction branches on ncol(co) and reports p = null if lmerTest
  // ever stops providing it, rather than substituting lm p-values.
  // evalNamedVector returns numbers only, so warnings are classified into
  // flags (converged / unidentifiable / boundary) instead of quoted verbatim.
  const decls = [
    `y<-${rVec(obs.map((o) => o.y))}`,
    `tm<-${rVec(obs.map((o) => o.tm))}`,
    `subj<-factor(c(${obs.map((o) => o.subj).join(",")}))`,
  ];
  if (grpLevels) {
    decls.push(
      `grp<-factor(c(${obs.map((o) => rStr(o.grp!)).join(",")}),levels=c(${grpLevels.map(rStr).join(",")}))`,
    );
  }
  const coefKeys = terms.map((_, i) => {
    const r = i + 1;
    return `e${r}=co[${r},1],se${r}=co[${r},2],t${r}=co[${r},if(nc>=5)4 else 3],p${r}=if(nc>=5)co[${r},5] else NA_real_`;
  });
  const code =
    `${decls.join(";")};warns<-c();` +
    `m<-withCallingHandlers(lmerTest::lmer(${formula},REML=TRUE),` +
    `warning=function(w){warns<<-c(warns,conditionMessage(w));invokeRestart("muffleWarning")});` +
    `s<-summary(m);co<-s$coefficients;nc<-ncol(co);` +
    `vc<-as.data.frame(lme4::VarCorr(m));` +
    `c(${coefKeys.join(",")},` +
    `sv=vc$vcov[vc$grp=="subj"],ssd=vc$sdcor[vc$grp=="subj"],` +
    `rv=vc$vcov[vc$grp=="Residual"],rsd=vc$sdcor[vc$grp=="Residual"],` +
    `aic=AIC(m),bic=BIC(m),ll=as.numeric(stats::logLik(m)),reml=-2*as.numeric(stats::logLik(m)),` +
    `nobs=nobs(m),ngrps=length(unique(subj)),dfres=df.residual(m),` +
    `singular=as.numeric(lme4::isSingular(m)),nwarn=length(warns),` +
    `conv=as.numeric(any(grepl("failed to converge",warns))),` +
    `unident=as.numeric(any(grepl("unidentifiable",warns))),` +
    `bound=as.numeric(any(grepl("singular|boundary",warns))))`;

  let v: Awaited<ReturnType<typeof evalNamedVector>>;
  try {
    v = await evalNamedVector(code);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/there is no package called|package.*lme4|lme4.*package|lmerTest/i.test(detail)) {
      return { error: MIXED_EFFECTS_PACKAGE_ERROR };
    }
    return { error: detail };
  }

  const coefficients: RegressionCoefficient[] = terms.map((t, i) => ({
    term: t.label,
    estimate: v[`e${i + 1}`] ?? null,
    stdError: v[`se${i + 1}`] ?? null,
    t: v[`t${i + 1}`] ?? null,
    p: v[`p${i + 1}`] ?? null,
  }));
  const varianceComponents: VarianceComponent[] = [
    { group: "Subject", component: "Intercept", variance: v.sv ?? null, sd: v.ssd ?? null },
    { group: "Residual", component: "Residual", variance: v.rv ?? null, sd: v.rsd ?? null },
  ];
  const dropped = total - obs.length;
  const stats: StatRow[] = [
    { label: "AIC", value: v.aic ?? null },
    { label: "BIC", value: v.bic ?? null },
    { label: "Log-likelihood", value: v.ll ?? null },
    { label: "REML criterion", value: v.reml ?? null },
    { label: "Observations used", value: v.nobs ?? obs.length },
    { label: "Observations in table", value: total },
    { label: "Observations dropped as missing", value: dropped },
    { label: "Subjects (groups)", value: v.ngrps ?? subjectCount },
    { label: "Residual DF", value: v.dfres ?? null },
  ];

  const perSubject = new Map<number, number>();
  for (const o of obs) perSubject.set(o.subj, (perSubject.get(o.subj) ?? 0) + 1);
  const singles = [...perSubject.values()].filter((n) => n === 1).length;
  const notesParts = [
    `Mixed-effects model: ${equation}. Random intercept per subject, fitted by restricted maximum likelihood (REML).`,
    "P-values by Satterthwaite's approximation (lmerTest).",
    `${obs.length} of ${total} observations used (${dropped} observation${dropped === 1 ? "" : "s"} dropped as missing).`,
  ];
  if (singles > 0) {
    notesParts.push(
      `${singles} subject${singles === 1 ? " has" : "s have"} only a single observation and contribute${singles === 1 ? "s" : ""} no within-subject information.`,
    );
  }
  for (const t of thinLevels) {
    notesParts.push(
      `“${t.name}” has only ${t.n} observation${t.n === 1 ? "" : "s"} — its mean is a single point.`,
    );
  }
  if (v.singular === 1) {
    notesParts.push(
      "Singular fit — estimated subject variance is (near) zero; the model reduces to an ordinary regression and the random effect may not be needed.",
    );
  }
  if (v.conv === 1) {
    notesParts.push("lmer() reported the model failed to converge — fixed effects and p-values may be unreliable.");
  }
  if (v.unident === 1) {
    notesParts.push(
      "lmer() reported the model is nearly unidentifiable (very large eigenvalue) — consider rescaling the variables.",
    );
  }
  if (v.bound === 1 && v.singular !== 1) {
    notesParts.push("lmer() reported a boundary (singular) fit.");
  }
  if ((v.nwarn ?? 0) > 0 && v.conv !== 1 && v.unident !== 1 && v.bound !== 1) {
    notesParts.push("lmer() issued a warning while fitting — estimates may be unreliable.");
  }
  if (v.p1 == null) {
    notesParts.push("P-values are unavailable because lmerTest did not load — estimates are reported without p-values.");
  }
  return {
    testType: "mixed-effects",
    subtitle: "Mixed-effects model (random intercept)",
    equation,
    stats,
    groups: described,
    notes: notesParts.join(" "),
    coefficients,
    varianceComponents,
  };
}
