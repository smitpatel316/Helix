// Dose-response — Special (plan 18): Prism's Dose-Response — Special
// models as global (shared-parameter) fits — EC50 shift, Gaddum/Schild
// pA2 and the operational model for partial agonists — on top of the
// shared global-fit helper (see global-fit.ts). The three models are data
// here (formula + parameter defs + start values); this file contains no
// R-vector plumbing of its own. All fits are base-R nls() algorithm
// "port"; CIs are the Wald 95% CIs of the shared nonlinear plumbing
// (estimate ± t·SE), like plans 16/17.
//
// Unit trap (Schild): pA2 is the negative log of B IN THE UNITS B WAS
// ENTERED IN. If B is in molar, pA2 ≈ 8–9 for a nanomolar antagonist; if
// B is in nM, the same antagonist has pA2 ≈ −1. A negative pA2 is never
// "corrected"; B's units are shown next to pA2 (notes + Kb row).
//
// KA is never labelled as an EC50: the operational model's logKA is the
// log equilibrium dissociation constant (affinity), logtau the log
// transducer constant (efficacy). A partial curve alone does not identify
// Effectmax/KA/tau separately — only the joint fit with the full agonist
// sharing Effectmax does — so there is no single-series operational model.
import type {
  AnalysisOutcome,
  Column,
  DoseResponseSpecialModel,
  DoseResponseSpecialParams,
  RegressionCoefficient,
  StatRow,
} from "../types";
import { DOSE_RESPONSE_SPECIAL_MODELS } from "../types";
import { describe } from "../column/base";
import { num } from "../../lib/format";
import { parseInhibitorConcentration } from "./enzyme-inhibition";
import { runGlobalFit, type GlobalFitSeries, type GlobalModelDef } from "./global-fit";
import { pairUp, splitXY, xyProblem } from "../../lib/dataset";

export const DOSE_RESPONSE_SPECIAL_LABEL: Record<DoseResponseSpecialModel, string> = {
  "ec50-shift": "EC50 shift",
  schild: "Gaddum/Schild EC50 shift (SchildSlope free)",
  "schild-slope-1": "Gaddum/Schild EC50 shift (SchildSlope = 1)",
  "operational-partial": "Operational model — Partial agonist",
};

const coefOf = (coefficients: RegressionCoefficient[], term: string) =>
  coefficients.find((c) => c.term === term)?.estimate ?? null;

/** R's median (the mean of the two middle values for an even count), in TS. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The nls non-convergence message, worded exactly like the shared
 *  fitError in nonlinear-fit.ts, plus the plan's pointer at the most
 *  common user error: the first series is not the control / full agonist. */
function specialFitError(err: unknown, label: string, firstRole: string): AnalysisOutcome {
  return {
    error: `This curve ("${label}") could not be fitted to these data (${err instanceof Error ? err.message : String(err)}). Try another model or Y data set. Check that the first series really is the ${firstRole}.`,
  };
}

/** The fitted curve's value at X for one series, from the fit's
 *  coefficients — the same closed form R fitted, so the graph overlay and
 *  the analysis can never disagree. `series.covariate` is B (the
 *  antagonist concentration) for Schild/EC50 shift; `seriesIndex` 0 is
 *  the full agonist for the operational model. A missing HillSlope means
 *  it was constrained to 1.0; a missing SchildSlope means it was fixed
 *  at 1.0. */
export function evaluateDoseResponseSpecialModel(
  model: DoseResponseSpecialModel,
  coefficients: RegressionCoefficient[],
  series: { name: string; covariate: number },
  seriesIndex: number,
  x: number,
): number {
  const c = (term: string) => coefOf(coefficients, term) ?? NaN;
  const fourPL = (bottom: number, top: number, logEC50: number, hill: number) =>
    bottom + (top - bottom) / (1 + 10 ** ((logEC50 - x) * hill));
  switch (model) {
    case "ec50-shift":
      return fourPL(c("Bottom"), c("Top"), c(`LogEC50[${series.name}]`), c("HillSlope"));
    case "schild":
    case "schild-slope-1": {
      const pA2 = c("pA2");
      const schildSlope = c("SchildSlope");
      const hill = c("HillSlope");
      const antag = 1 + (series.covariate / 10 ** -pA2) ** (Number.isFinite(schildSlope) ? schildSlope : 1);
      const logEC = c("LogEC50") + Math.log10(antag);
      return fourPL(c("Bottom"), c("Top"), logEC, Number.isFinite(hill) ? hill : 1);
    }
    case "operational-partial": {
      const basal = c("Basal");
      const effectmax = c("Effectmax");
      const n = c("n");
      if (seriesIndex === 0) return fourPL(basal, effectmax, c("LogEC50"), n);
      const operate = ((10 ** c(`logKA[${series.name}]`) + 10 ** x) / 10 ** (c(`logtau[${series.name}]`) + x)) ** n;
      return basal + (effectmax - basal) / (1 + operate);
    }
  }
}

/** A derived coefficient row (EC50, KA, tau): an estimate only, no
 *  SE/t/p/CI, because it is computed from a fitted parameter, not fitted
 *  itself — the Morrison Ki/Et precedent. */
const derivedCoef = (term: string, estimate: number | null): RegressionCoefficient => ({
  term,
  estimate,
  stdError: null,
  t: null,
  p: null,
  low: null,
  high: null,
});

interface SeriesFit {
  col: Column;
  B: number;
  x: number[];
  y: number[];
}

/** The R spec for one model, as a global-fit definition. Starts follow
 *  the plan's rules from the data (never hard-coded reference answers):
 *  Bottom/Basal ≈ min(Y) pooled, Top/Effectmax ≈ max(Y) pooled, LogEC50
 *  ≈ median(X) of the control series, HillSlope/n start 1, pA2 start =
 *  −log10(median non-zero B), SchildSlope start 1, logKA start =
 *  LogEC50 (median X) of the partial series, logtau start 0. */
function modelDef(model: DoseResponseSpecialModel, series: SeriesFit[], fixHillSlope: boolean): GlobalModelDef {
  const pooledY = series.flatMap((s) => s.y);
  const bottom0 = Math.min(...pooledY);
  const top0 = Math.max(...pooledY);
  const controlX = series[0].x;
  const logEC50_0 = median(controlX);
  const hill: GlobalModelDef["params"][number] = {
    name: "HillSlope",
    shared: true,
    start: () => 1,
    lower: 0,
  };
  const evaluate = (coefficients: RegressionCoefficient[], s: GlobalFitSeries, i: number, x: number) =>
    evaluateDoseResponseSpecialModel(model, coefficients, s, i, x);
  switch (model) {
    case "ec50-shift":
      return {
        formula: "Bottom+(Top-Bottom)/(1+10^((LogEC50[g]-x)*HillSlope))",
        params: [
          { name: "Bottom", shared: true, start: () => bottom0 },
          { name: "Top", shared: true, start: () => top0 },
          hill,
          { name: "LogEC50", shared: false, start: (all) => all.map((s) => median(s.x)) },
        ],
        evaluate,
      };
    case "schild":
    case "schild-slope-1": {
      const nonzeroB = series.map((s) => s.B).filter((b) => b > 0);
      const pA2_0 = -Math.log10(median(nonzeroB));
      const hillTerm = fixHillSlope ? "" : "*HillSlope";
      const antag = model === "schild-slope-1" ? `log10(1+B/10^(-pA2))` : `log10(1+(B/10^(-pA2))^SchildSlope)`;
      return {
        formula: `Bottom+(Top-Bottom)/(1+10^((LogEC50+${antag}-x)${hillTerm}))`,
        params: [
          { name: "Bottom", shared: true, start: () => bottom0 },
          { name: "Top", shared: true, start: () => top0 },
          { name: "LogEC50", shared: true, start: () => logEC50_0 },
          ...(fixHillSlope ? [] : [hill]),
          { name: "pA2", shared: true, start: () => pA2_0 },
          ...(model === "schild" ? [{ name: "SchildSlope", shared: true, start: () => 1, lower: 0 }] : []),
        ],
        evaluate,
      };
    }
    case "operational-partial": {
      const partials = series.map((_, i) => i + 1).filter((i) => i > 1);
      return {
        formula:
          "ifelse(g==1,Basal+(Effectmax-Basal)/(1+10^((LogEC50-x)*n))," +
          "Basal+(Effectmax-Basal)/(1+(((10^logKA[pmax(g-1,1)]+10^x)/(10^(logtau[pmax(g-1,1)]+x)))^n)))",
        params: [
          { name: "Basal", shared: true, start: () => bottom0 },
          { name: "Effectmax", shared: true, start: () => top0 },
          { name: "LogEC50", shared: true, start: () => logEC50_0 },
          { name: "n", shared: true, start: () => 1, lower: 0 },
          {
            name: "logKA",
            shared: false,
            appliesTo: partials,
            start: (all) => partials.map((i) => median(all[i - 1].x)),
          },
          {
            name: "logtau",
            shared: false,
            appliesTo: partials,
            start: () => partials.map(() => 0),
          },
        ],
        evaluate,
      };
    }
  }
}

/** The fitted equation, from the fitted coefficients (4 significant figures,
 *  like the rest of Helix's display). */
function equation(
  model: DoseResponseSpecialModel,
  coefficients: RegressionCoefficient[],
  series: SeriesFit[],
  units: string,
): string | undefined {
  switch (model) {
    case "ec50-shift": {
      const bottom = coefOf(coefficients, "Bottom");
      const top = coefOf(coefficients, "Top");
      const hill = coefOf(coefficients, "HillSlope");
      if (bottom == null || top == null || hill == null) return undefined;
      const logEC50s = series
        .map((s) => `“${s.col.name}” = ${num(coefOf(coefficients, `LogEC50[${s.col.name}]`))}`)
        .join(", ");
      return (
        `Y = ${num(bottom)} + (${num(top)} − ${num(bottom)})/(1 + 10^((LogEC50 − X)·${num(hill)})), ` +
        `LogEC50: ${logEC50s}`
      );
    }
    case "schild":
    case "schild-slope-1": {
      const bottom = coefOf(coefficients, "Bottom");
      const top = coefOf(coefficients, "Top");
      const logEC50 = coefOf(coefficients, "LogEC50");
      const hill = coefOf(coefficients, "HillSlope");
      const pA2 = coefOf(coefficients, "pA2");
      const schildSlope = coefOf(coefficients, "SchildSlope");
      if (bottom == null || top == null || logEC50 == null || pA2 == null) return undefined;
      const kb = 10 ** -pA2;
      const hillText = hill == null ? "1 (constrained)" : num(hill);
      const antag =
        model === "schild-slope-1"
          ? `(1 + B/${num(kb)} ${units})`
          : `(1 + (B/${num(kb)} ${units})^${num(schildSlope)})`;
      return `Y = ${num(bottom)} + (${num(top)} − ${num(bottom)})/(1 + 10^((${num(logEC50)} + log10${antag} − X)·${hillText}))`;
    }
    case "operational-partial": {
      const basal = coefOf(coefficients, "Basal");
      const effectmax = coefOf(coefficients, "Effectmax");
      const logEC50 = coefOf(coefficients, "LogEC50");
      const n = coefOf(coefficients, "n");
      if (basal == null || effectmax == null || logEC50 == null || n == null) return undefined;
      return (
        `Full agonist: Y = ${num(basal)} + (${num(effectmax)} − ${num(basal)})/(1 + 10^((${num(logEC50)} − X)·${num(n)})); ` +
        `partial agonists: Y = ${num(basal)} + (${num(effectmax)} − ${num(basal)})/(1 + operate), ` +
        `operate = ((10^logKA + 10^X)/(10^(logtau + X)))^${num(n)}`
      );
    }
  }
}

export async function runDoseResponseSpecial(
  columns: Column[],
  params: DoseResponseSpecialParams | undefined,
): Promise<AnalysisOutcome> {
  const model = params?.model;
  if (!model || !DOSE_RESPONSE_SPECIAL_MODELS.includes(model))
    return { error: "Choose a dose-response — Special model to fit." };
  const label = DOSE_RESPONSE_SPECIAL_LABEL[model];
  const isSchild = model === "schild" || model === "schild-slope-1";
  const firstRole = model === "operational-partial" ? "full agonist" : "control (no antagonist)";
  const { x: xCol, ys: yCols } = splitXY(columns);
  if (!xCol || !yCols.length) return { error: xyProblem(columns)! };

  const requested = params?.ys?.length ? params.ys : yCols.map((c) => c.name);
  if (requested.length < 2)
    return {
      error: "Dose-response — Special fits several curves at once — add at least a control and one shifted curve.",
    };
  const missing = requested.find((n) => !yCols.some((c) => c.name === n));
  if (missing) return { error: `“${missing}” holds no numbers yet.` };

  // B per series (Schild / EC50 shift): the wizard's value, else the number
  // parsed out of the column title (the Prism convention) — a series with
  // neither errors naming it, so the fit never silently invents an
  // antagonist concentration. The operational model has no B.
  const units = params?.bUnits ?? "M";
  const series: SeriesFit[] = [];
  for (const name of requested) {
    const col = yCols.find((c) => c.name === name)!;
    const { x, y } = pairUp(xCol, col);
    if (x.length < 5)
      return {
        error: `“${name}” has only ${x.length} complete points; a Dose-response — Special fit needs at least 5 per series.`,
      };
    let B = 0;
    if (!isSchild && model !== "ec50-shift") {
      series.push({ col, B, x, y });
      continue;
    }
    const fromParams = params?.antagonistConcentrations?.[name];
    const parsed = fromParams ?? parseInhibitorConcentration(name);
    if (parsed === undefined || !Number.isFinite(parsed))
      return {
        error: `“${name}” has no antagonist concentration — enter B for every series (or put it in the column title, e.g. “10 nM”).`,
      };
    if (parsed < 0) return { error: `“${name}” has an antagonist concentration below 0 — B cannot be negative.` };
    B = parsed;
    series.push({ col, B, x, y });
  }
  if (model === "ec50-shift" || isSchild) {
    const dup = series.find((s, i) => series.some((o, j) => j > i && o.B === s.B));
    if (dup) {
      const other = series.find((o) => o !== dup && o.B === dup.B)!;
      return {
        error: `“${dup.col.name}” and “${other.col.name}” have the same antagonist concentration (${dup.B} ${units}) — each series needs a distinct B.`,
      };
    }
    if (series[0].B > 0)
      return {
        error: `“${series[0].col.name}” is the first series but has B = ${series[0].B} ${units} — the first series must be the control (no antagonist).`,
      };
    if (!series.some((s) => s.B > 0))
      return {
        error: "Every series has B = 0 — include at least one series with an antagonist concentration above 0.",
      };
  }

  const fixHillSlope = isSchild && (params?.fixHillSlope ?? false);
  const def = modelDef(model, series, fixHillSlope);
  const fitSeries: GlobalFitSeries[] = series.map((s) => ({ name: s.col.name, x: s.x, y: s.y, covariate: s.B }));
  try {
    const { coefficients, stats, perSeries } = await runGlobalFit(fitSeries, def);
    const hill = coefOf(coefficients, "HillSlope");
    const n = coefOf(coefficients, "n");
    const schildSlope = coefOf(coefficients, "SchildSlope");
    if (hill != null && hill <= 0)
      return { error: "Fitted HillSlope ≤ 0 — the data do not support this dose-response model." };
    if (n != null && n <= 0) return { error: "Fitted n ≤ 0 — the data do not support the operational model." };
    if (schildSlope != null && schildSlope <= 0)
      return { error: "Fitted SchildSlope ≤ 0 — the data do not support the Schild model." };

    const r2PerSeries: StatRow[] = perSeries.map((s) => ({ label: `R squared (${s.name})`, value: s.rSquared }));

    // Derived rows: EC50 per series (EC50 shift), EC50 of the control +
    // Kb + dose ratios (Schild), KA and tau per partial agonist
    // (operational) — all estimate-only, computed from fitted parameters.
    let allCoefficients = coefficients;
    let extraStats: StatRow[] = [];
    const notes = [
      model === "operational-partial"
        ? `Dose-response — Special fit ("${label}") of ${series.map((s) => `“${s.col.name}”`).join(", ")} on “${xCol.name}” — one global fit: Basal, Effectmax and n are shared across all ${series.length} series; the first series (“${series[0].col.name}”) is fitted as a 4PL (the full agonist) and the rest as partial agonists.`
        : `Dose-response — Special fit ("${label}") of ${series.map((s) => `“${s.col.name}”`).join(", ")} on “${xCol.name}” — one global fit: ${model === "ec50-shift" ? "Bottom, Top and HillSlope are shared across all " + series.length + " series; each series has its own LogEC50" : "Bottom, Top, LogEC50, HillSlope and pA2 are shared across all " + series.length + " series"}. The first series (“${series[0].col.name}”) is the control (no antagonist).`,
    ];
    if (model === "ec50-shift" || isSchild) {
      notes.push(`Antagonist concentrations: ${series.map((s) => `“${s.col.name}” B = ${s.B} ${units}`).join(", ")}.`);
    }
    if (model === "ec50-shift") {
      const logEC50_0 = coefOf(coefficients, `LogEC50[${series[0].col.name}]`);
      allCoefficients = [
        ...coefficients,
        ...series.map((s) => {
          const v = coefOf(coefficients, `LogEC50[${s.col.name}]`);
          return derivedCoef(`EC50[${s.col.name}]`, v == null ? null : 10 ** v);
        }),
      ];
      extraStats = series.slice(1).map((s) => {
        const v = coefOf(coefficients, `LogEC50[${s.col.name}]`);
        return {
          label: `Dose ratio (${s.col.name})`,
          value: v == null || logEC50_0 == null ? null : 10 ** (v - logEC50_0),
        };
      });
      notes.push(
        `Starting values: Bottom = ${num(Math.min(...series.flatMap((s) => s.y)))}, Top = ${num(Math.max(...series.flatMap((s) => s.y)))}, HillSlope = 1, LogEC50 = median(X) per series.`,
      );
    }
    if (isSchild) {
      const logEC50 = coefOf(coefficients, "LogEC50");
      const pA2 = coefOf(coefficients, "pA2");
      const kb = pA2 == null ? null : 10 ** -pA2;
      const slope = schildSlope ?? 1;
      extraStats = [
        { label: "EC50 (control)", value: logEC50 == null ? null : 10 ** logEC50 },
        { label: `Kb (${units})`, value: kb },
        ...series.slice(1).map((s) => ({
          label: `Dose ratio (${s.col.name})`,
          value: kb == null || kb <= 0 ? null : 1 + (s.B / kb) ** slope,
        })),
      ];
      notes.push(
        `B is entered in ${units}; pA2 is the negative log of B in these units — a negative pA2 is not an error (the same antagonist has pA2 ≈ 8 in M and ≈ −1 in nM). Kb = 10^(−pA2) = ${num(kb)} ${units}.`,
      );
      if (model === "schild-slope-1")
        notes.push(
          "SchildSlope is fixed at 1, so pA2 = pKb (the negative log of the antagonist dissociation constant).",
        );
      else {
        notes.push(
          fixHillSlope
            ? "HillSlope is constrained to 1.0; SchildSlope is fitted freely."
            : "SchildSlope is fitted freely.",
        );
        if (schildSlope != null && (schildSlope < 0.7 || schildSlope > 1.3))
          notes.push("Schild slope ≠ 1 — antagonism may not be simply competitive; the pA2 is not a pKb.");
      }
      notes.push(
        `Starting values: Bottom = ${num(Math.min(...series.flatMap((s) => s.y)))}, Top = ${num(Math.max(...series.flatMap((s) => s.y)))}, LogEC50 = ${num(median(series[0].x))}, HillSlope = ${fixHillSlope ? "1 (constrained)" : "1"}, pA2 = ${num(-Math.log10(median(series.map((s) => s.B).filter((b) => b > 0))))}${model === "schild" ? ", SchildSlope = 1" : ""}.`,
      );
    }
    if (model === "operational-partial") {
      const partials = series.slice(1);
      allCoefficients = [
        ...coefficients,
        ...partials.flatMap((s) => {
          const logKA = coefOf(coefficients, `logKA[${s.col.name}]`);
          const logtau = coefOf(coefficients, `logtau[${s.col.name}]`);
          return [
            derivedCoef(`KA[${s.col.name}]`, logKA == null ? null : 10 ** logKA),
            derivedCoef(`tau[${s.col.name}]`, logtau == null ? null : 10 ** logtau),
          ];
        }),
      ];
      notes.push(
        `Starting values: Basal = ${num(Math.min(...series.flatMap((s) => s.y)))}, Effectmax = ${num(Math.max(...series.flatMap((s) => s.y)))}, LogEC50 (full agonist) = ${num(median(series[0].x))}, n = 1, logKA = median(X) per partial agonist, logtau = 0.`,
      );
      // Identification warnings (notes, never errors).
      const effectmax = coefOf(coefficients, "Effectmax");
      const effectmaxRow = coefficients.find((c) => c.term === "Effectmax");
      if (
        effectmax != null &&
        effectmaxRow?.low != null &&
        effectmaxRow?.high != null &&
        effectmaxRow.low > 0 &&
        effectmaxRow.high / effectmaxRow.low > 10
      )
        notes.push(
          "The full agonist's Effectmax has a confidence interval spanning more than an order of magnitude — its top plateau is not clearly reached, so Effectmax, KA and tau are poorly identified.",
        );
      const basal = coefOf(coefficients, "Basal");
      const nVal = coefOf(coefficients, "n");
      for (const s of partials) {
        const logtau = coefOf(coefficients, `logtau[${s.col.name}]`);
        if (basal == null || effectmax == null || nVal == null || logtau == null) continue;
        const tau = 10 ** logtau;
        const plateau = basal + (effectmax - basal) / (1 + tau ** -nVal);
        if (plateau >= effectmax)
          notes.push(
            `“${s.col.name}” plateaus at ${num(plateau)}, at or above Effectmax — it looks like a full agonist, not a partial agonist; check that the first series really is the full agonist.`,
          );
      }
    }

    const eq = equation(model, allCoefficients, series, units);
    return {
      testType: "dose-response-special",
      subtitle: label,
      ...(eq ? { equation: eq } : {}),
      stats: [...r2PerSeries, ...extraStats, ...stats],
      groups: (await describe([xCol, ...series.map((s) => s.col)])).groups,
      notes: notes.join(" "),
      coefficients: allCoefficients,
    };
  } catch (err) {
    return specialFitError(err, label, firstRole);
  }
}
