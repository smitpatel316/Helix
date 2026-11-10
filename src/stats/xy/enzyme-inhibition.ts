// Enzyme kinetics — Inhibition (plan 17): Prism's inhibition models as
// global fits over substrate–velocity curves at several inhibitor
// concentrations — one set of shared parameters (Vmax, Km, Ki, and Alpha
// for mixed) fitted simultaneously to every series — plus the single-curve
// tight-binding Morrison Ki fit. The global fits run through the shared
// global-fit helper (see xy/global-fit.ts, plan 18) — one stacked nls()
// over concatenated x, y and the per-point inhibitor vector — so there is
// exactly one stacked-nls implementation in the repo. CIs are the Wald 95%
// CIs of the shared plan-09 plumbing (estimate ± t·SE);
// profile-likelihood confint() would be a cross-cutting change to every
// nonlinear fit, not a plan-17 one.
// No Lineweaver–Burk fitting anywhere: Prism offers Lineweaver–Burk only
// as a display Transform, never to estimate Km/Vmax, and Helix has no
// transform infrastructure — a display-only LB graph, if ever added, must
// be computed from this nls fit and must never run a linear regression.
import type {
  AnalysisOutcome,
  Column,
  EnzymeInhibitionModel,
  EnzymeInhibitionParams,
  RegressionCoefficient,
  StatRow,
} from "../types";
import { ENZYME_INHIBITION_MODELS } from "../types";
import { describe } from "../column/base";
import { num } from "../../lib/format";
import { fitModelSpec, type ModelSpec } from "./nonlinear-fit";
import { runGlobalFit, type GlobalModelDef } from "./global-fit";
import { pairUp, splitXY, xyProblem } from "../../lib/dataset";

export const ENZYME_INHIBITION_LABEL: Record<EnzymeInhibitionModel, string> = {
  competitive: "Competitive",
  noncompetitive: "Noncompetitive",
  uncompetitive: "Uncompetitive",
  mixed: "Mixed model",
  morrison: "Morrison Ki (tight binding)",
};

/** The first number in a column title ("10 nM" → 10, "I=5" → 5) — the
 *  Prism convention that the inhibitor concentration is entered in the
 *  column title. Titles with no number ("Control") give undefined, and the
 *  wizard asks for the value instead. */
export function parseInhibitorConcentration(title: string): number | undefined {
  const m = title.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  if (!m) return undefined;
  const v = Number(m[0]);
  return Number.isFinite(v) ? v : undefined;
}

const coefOf = (coefficients: RegressionCoefficient[], term: string) =>
  coefficients.find((c) => c.term === term)?.estimate ?? null;

/** The nls non-convergence message, worded exactly like the shared
 *  fitError in nonlinear-fit.ts. */
function inhibitionFitError(err: unknown, label: string): AnalysisOutcome {
  return {
    error: `This curve ("${label}") could not be fitted to these data (${err instanceof Error ? err.message : String(err)}). Try another model or Y data set.`,
  };
}

/** R's median (the mean of the two middle values for an even count), in TS. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The Y of the point whose X is nearest `target` (the mid-[S] velocity). */
function nearestY(xs: number[], ys: number[], target: number): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - target) < Math.abs(xs[best] - target)) best = i;
  return ys[best];
}

/** The fitted curve's value at X for one inhibitor concentration, from the
 *  fit's coefficients — the same closed form R fitted, so the graph overlay
 *  and the analysis can never disagree. Morrison ignores `inhibitor` (X is
 *  the total inhibitor concentration there) and reads its constrained Et
 *  from the coefficients. */
export function evaluateEnzymeInhibitionModel(
  model: EnzymeInhibitionModel,
  coefficients: RegressionCoefficient[],
  x: number,
  inhibitor = 0,
): number {
  const c = (term: string) => coefOf(coefficients, term) ?? NaN;
  const vmax = c("Vmax");
  const km = c("Km");
  const ki = c("Ki");
  switch (model) {
    case "competitive":
      return (vmax * x) / (km * (1 + inhibitor / ki) + x);
    case "noncompetitive":
      return (vmax / (1 + inhibitor / ki)) * (x / (km + x));
    case "uncompetitive":
      return (vmax / (1 + inhibitor / ki)) * (x / (km / (1 + inhibitor / ki) + x));
    case "mixed": {
      const alpha = c("Alpha");
      return (
        (vmax / (1 + inhibitor / (alpha * ki))) *
        (x / ((km * (1 + inhibitor / ki)) / (1 + inhibitor / (alpha * ki)) + x))
      );
    }
    case "morrison": {
      const v0 = c("v0");
      const et = c("Et");
      const kiapp = c("Kiapp");
      return v0 * (1 - (et + x + kiapp - Math.sqrt((et + x + kiapp) ** 2 - 4 * et * x)) / (2 * et));
    }
  }
}

/** The global model as a global-fit definition: the R formula references
 *  B (the per-point inhibitor concentration, the helper's covariate
 *  vector) and the shared parameters Vmax/Km/Ki/Alpha. Start values are
 *  computed in TS from the data (see globalStarts) and inlined — nls
 *  "port" needs starts strictly inside the (0, ∞) bounds, and the plan's
 *  start rules are data-driven, not constants. AICc is a derived row:
 *  AIC(m) + 2k(k+1)/(n−k−1). */
function globalModelDef(
  model: EnzymeInhibitionModel,
  starts: { vmax: number; km: number; ki: number },
): GlobalModelDef {
  const { vmax, km, ki } = starts;
  const aicc = { label: "AICc", expr: "AIC(m)+2*length(cf)*(length(cf)+1)/(length(y)-length(cf)-1)" };
  const shared: GlobalModelDef["params"] = [
    { name: "Vmax", shared: true, start: () => vmax, lower: 0 },
    { name: "Km", shared: true, start: () => km, lower: 0 },
    { name: "Ki", shared: true, start: () => ki, lower: 0 },
  ];
  const evaluate: GlobalModelDef["evaluate"] = (coefficients, s, _i, x) =>
    evaluateEnzymeInhibitionModel(model, coefficients, x, s.covariate);
  switch (model) {
    case "competitive":
      // Y = Vmax·X/(KmApp + X), KmApp = Km·(1 + B/Ki).
      return { formula: "Vmax*x/(Km*(1+B/Ki)+x)", params: shared, derived: [aicc], evaluate };
    case "noncompetitive":
      // Y = VmaxApp·X/(Km + X), VmaxApp = Vmax/(1 + B/Ki).
      return { formula: "(Vmax/(1+B/Ki))*x/(Km+x)", params: shared, derived: [aicc], evaluate };
    case "uncompetitive":
      // Y = VmaxApp·X/(KmApp + X), VmaxApp = Vmax/(1 + B/Ki), KmApp = Km/(1 + B/Ki).
      return { formula: "(Vmax/(1+B/Ki))*x/(Km/(1+B/Ki)+x)", params: shared, derived: [aicc], evaluate };
    case "mixed":
      // Y = VmaxApp·X/(KmApp + X), VmaxApp = Vmax/(1 + B/(Alpha·Ki)),
      // KmApp = Km·(1 + B/Ki)/(1 + B/(Alpha·Ki)). Alpha starts at 1 (the
      // noncompetitive case) — the fit moves it toward the mechanism the
      // data support. Alpha is capped at 1e6: the competitive limit is at
      // Alpha → ∞, so on competitive-truth data the port optimizer chases
      // Alpha to infinity and fails ("iteration limit reached" / "false
      // convergence", verified in WebR); at the 1e6 cap the model is
      // competitive to within B/(1e6·Ki), port converges at the boundary,
      // and Vmax/Km/Ki recover within ~1e-5. The cap is inactive for
      // identified Alphas (Alpha = 2 recovers exactly). A fit that lands
      // on the cap reports Alpha = 1e6 and the boundary note fires.
      return {
        formula: "(Vmax/(1+B/(Alpha*Ki)))*x/(Km*(1+B/Ki)/(1+B/(Alpha*Ki))+x)",
        params: [...shared, { name: "Alpha", shared: true, start: () => 1, lower: 0, upper: 1e6 }],
        derived: [aicc],
        evaluate,
      };
    case "morrison":
      // Unreachable — Morrison has its own spec (morrisonSpec), not a stacked fit.
      throw new Error("Morrison is a single-curve fit, not a global fit.");
  }
}

/** The R spec for the Morrison Ki fit. X is the total inhibitor
 *  concentration It; Et is assigned by the runner before the fit. */
function morrisonSpec(starts: { v0: number; kiapp: number }): ModelSpec {
  return {
    kind: "nls",
    fit: `m<-nls(y~v0*(1-((Et+x+Kiapp)-sqrt((Et+x+Kiapp)^2-4*Et*x))/(2*Et)),start=list(v0=${starts.v0},Kiapp=${starts.kiapp}),algorithm="port",lower=c(0,0),upper=c(Inf,Inf))`,
    terms: ["v0", "Kiapp"],
  };
}

/** The data-driven start values the R fit used — Vmax ≈ max(Y) over the
 *  I = 0 series, Km ≈ median(X) of the I = 0 series, Ki ≈ the [I] at
 *  which the velocity at mid-[S] is roughly halved, else the median
 *  non-zero [I] — recomputed here from the fitted points, so the note
 *  always names what nls() actually started from. */
function globalStarts(
  zero: { x: number[]; y: number[] },
  nonzero: { x: number[]; y: number[]; I: number }[],
): { vmax: number; km: number; ki: number } {
  const vmax = Math.max(...zero.y);
  const km = median(zero.x.filter((x) => x > 0));
  const nonzeroIs = nonzero.map((s) => s.I);
  let ki = median(nonzeroIs);
  const midS = km;
  const v0mid = nearestY(zero.x, zero.y, midS);
  if (v0mid > 0) {
    let best: { I: number; dist: number } | null = null;
    for (const s of nonzero) {
      const dist = Math.abs(nearestY(s.x, s.y, midS) / v0mid - 0.5);
      if (!best || dist < best.dist) best = { I: s.I, dist };
    }
    if (best && best.dist <= 0.25) ki = best.I;
  }
  return { vmax, km, ki };
}

/** The fitted equation, from the fitted coefficients (4 significant figures,
 *  like the rest of Helix's display). */
function equation(
  model: EnzymeInhibitionModel,
  coefficients: RegressionCoefficient[],
  et?: number,
): string | undefined {
  const vmax = coefOf(coefficients, "Vmax");
  const km = coefOf(coefficients, "Km");
  const ki = coefOf(coefficients, "Ki");
  switch (model) {
    case "competitive":
      if (vmax == null || km == null || ki == null) return undefined;
      return `Y = ${num(vmax)}·X/(KmApp + X), KmApp = ${num(km)}·(1 + I/${num(ki)})`;
    case "noncompetitive":
      if (vmax == null || km == null || ki == null) return undefined;
      return `Y = VmaxApp·X/(${num(km)} + X), VmaxApp = ${num(vmax)}/(1 + I/${num(ki)})`;
    case "uncompetitive":
      if (vmax == null || km == null || ki == null) return undefined;
      return `Y = VmaxApp·X/(KmApp + X), VmaxApp = ${num(vmax)}/(1 + I/${num(ki)}), KmApp = ${num(km)}/(1 + I/${num(ki)})`;
    case "mixed": {
      const alpha = coefOf(coefficients, "Alpha");
      if (vmax == null || km == null || ki == null || alpha == null) return undefined;
      return (
        `Y = VmaxApp·X/(KmApp + X), VmaxApp = ${num(vmax)}/(1 + I/(${num(alpha)}·${num(ki)})), ` +
        `KmApp = ${num(km)}·(1 + I/${num(ki)})/(1 + I/(${num(alpha)}·${num(ki)}))`
      );
    }
    case "morrison": {
      const v0 = coefOf(coefficients, "v0");
      const kiapp = coefOf(coefficients, "Kiapp");
      if (v0 == null || kiapp == null || et == null) return undefined;
      return `Y = ${num(v0)}·(1 − ((Et + X + ${num(kiapp)}) − √((Et + X + ${num(kiapp)})² − 4·Et·X))/(2·Et)), Et = ${num(et)}`;
    }
  }
}

interface SeriesFit {
  col: Column;
  I: number;
  x: number[];
  y: number[];
}

/** Which model the mixed fit's Alpha points to — the note the plan asks
 *  for, so model choice is left to the user but the Alpha diagnosis is
 *  spelled out. */
function alphaMechanism(alpha: number): string {
  if (alpha >= 0.9 && alpha <= 1.1)
    return "Alpha ≈ 1 — the fit points to noncompetitive inhibition (Alpha = 1 is the noncompetitive limit).";
  if (alpha > 1.1)
    return "Alpha > 1 — the inhibitor prefers the free enzyme; the fit points toward competitive inhibition (Alpha → ∞ is the competitive limit).";
  return "Alpha < 1 — the inhibitor prefers the enzyme–substrate complex; the fit points toward uncompetitive inhibition (Alpha → 0 is the uncompetitive limit).";
}

export async function runEnzymeInhibition(
  columns: Column[],
  params: EnzymeInhibitionParams | undefined,
): Promise<AnalysisOutcome> {
  const model = params?.model;
  if (!model || !ENZYME_INHIBITION_MODELS.includes(model))
    return { error: "Choose an enzyme inhibition model to fit." };
  const label = ENZYME_INHIBITION_LABEL[model];
  const { x: xCol, ys: yCols } = splitXY(columns);
  if (!xCol || !yCols.length) return { error: xyProblem(columns)! };

  if (model === "morrison") return runMorrison(xCol, yCols, params, label);

  // ── Global models (competitive / noncompetitive / uncompetitive / mixed) ──
  const requested = params?.y?.length ? params.y : yCols.map((c) => c.name);
  if (requested.length < 2)
    return {
      error:
        "A global inhibition fit needs at least two series — an uninhibited series ([I] = 0) and at least one inhibited series.",
    };
  const missing = requested.find((n) => !yCols.some((c) => c.name === n));
  if (missing) return { error: `“${missing}” holds no numbers yet.` };

  // [I] per series: the wizard's value, else the number parsed out of the
  // column title (the Prism convention) — a series with neither errors
  // naming it, so the fit never silently invents an inhibitor concentration.
  const series: SeriesFit[] = [];
  for (const name of requested) {
    const col = yCols.find((c) => c.name === name)!;
    const fromParams = params?.inhibitorConcentrations?.[name];
    const I = fromParams ?? parseInhibitorConcentration(name);
    if (I === undefined || !Number.isFinite(I))
      return {
        error: `“${name}” has no inhibitor concentration — enter [I] for every series (or put it in the column title, e.g. “10 nM”).`,
      };
    if (I < 0) return { error: `“${name}” has an inhibitor concentration below 0 — [I] cannot be negative.` };
    const { x, y } = pairUp(xCol, col);
    series.push({ col, I, x, y });
  }
  const dup = series.find((s, i) => series.some((o, j) => j > i && o.I === s.I));
  if (dup) {
    const other = series.find((o) => o !== dup && o.I === dup.I)!;
    return {
      error: `“${dup.col.name}” and “${other.col.name}” have the same inhibitor concentration (${dup.I}) — each series needs a distinct [I].`,
    };
  }
  const zero = series.find((s) => s.I === 0);
  if (!zero)
    return {
      error: "Include an uninhibited series ([I] = 0) — Vmax and Km cannot be determined without it.",
    };
  for (const s of series)
    if (s.x.length < 4)
      return {
        error: `“${s.col.name}” has only ${s.x.length} complete points; a global inhibition fit needs at least 4 per series.`,
      };

  const allX = series.flatMap((s) => s.x);
  if (allX.some((x) => x < 0)) return { error: "Substrate concentrations cannot be negative." };
  if (!allX.some((x) => x > 0)) return { error: "No positive substrate concentration — Km cannot be estimated." };
  if (new Set(allX).size === 1) return { error: "All substrate concentrations are equal — Km cannot be estimated." };
  if (Math.max(...zero.y) <= 0) return { error: "No positive velocities — Vmax cannot be estimated." };

  const starts = globalStarts(
    zero,
    series.filter((s) => s.I !== 0),
  );
  const def = globalModelDef(model, starts);
  try {
    const { coefficients, derived, stats } = await runGlobalFit(
      series.map((s) => ({ name: s.col.name, x: s.x, y: s.y, covariate: s.I })),
      def,
    );
    const vmax = coefOf(coefficients, "Vmax");
    const km = coefOf(coefficients, "Km");
    const ki = coefOf(coefficients, "Ki");
    const alpha = coefOf(coefficients, "Alpha");
    if (vmax != null && vmax <= 0) return { error: "Fitted Vmax ≤ 0 — the data do not support this inhibition model." };
    if (km != null && km <= 0) return { error: "Fitted Km ≤ 0 — the data do not support this inhibition model." };
    if (ki != null && ki <= 0) return { error: "Fitted Ki ≤ 0 — the data do not support this inhibition model." };
    if (alpha != null && alpha <= 0)
      return { error: "Fitted Alpha ≤ 0 — the data do not support this inhibition model." };

    const k = def.params.length;
    const notes = [
      `Enzyme kinetics — Inhibition fit ("${label}") of ${series.map((s) => `“${s.col.name}”`).join(", ")} on “${xCol.name}” — one global fit: Vmax, Km${model === "mixed" ? ", Ki and Alpha" : " and Ki"} are shared across all ${series.length} series.`,
      `Inhibitor concentrations: ${series.map((s) => `“${s.col.name}” [I] = ${s.I}`).join(", ")} (same units for every series; Ki is reported in these units).`,
      `Starting values: Vmax = ${num(starts.vmax)}, Km = ${num(starts.km)}, Ki = ${num(starts.ki)}${model === "mixed" ? ", Alpha = 1" : ""}.`,
    ];
    const thin = series.filter((s) => s.x.length < 5);
    if (thin.length)
      notes.push(
        `${thin.map((s) => `“${s.col.name}” has only ${s.x.length} complete points`).join("; ")} — thin series for a global fit with ${k} shared parameters; treat Ki with caution.`,
      );
    if (model === "mixed" && alpha != null) {
      notes.push(
        "Alpha = 1 is noncompetitive; Alpha > 1 means the inhibitor prefers the free enzyme; Alpha < 1 means it prefers the enzyme–substrate complex.",
        alphaMechanism(alpha),
      );
      if (alpha <= 0.05 || alpha > 100)
        notes.push("Alpha at the boundary — mechanism not identified by these data; compare the simpler models.");
    }

    const eq = equation(model, coefficients);
    return {
      testType: "enzyme-inhibition",
      subtitle: label,
      ...(eq ? { equation: eq } : {}),
      stats: [...derived, ...stats],
      groups: [xCol, ...series.map((s) => s.col)].map(describe),
      notes: notes.join(" "),
      coefficients,
    };
  } catch (err) {
    return inhibitionFitError(err, label);
  }
}

/** The single-curve tight-binding Morrison Ki fit: X is the total
 *  inhibitor concentration It at one fixed [S]; Et is a constrained
 *  constant, Kiapp is fitted, and Ki = Kiapp/(1 + [S]/Km) is derived when
 *  [S] and Km are both supplied. */
async function runMorrison(
  xCol: Column,
  yCols: Column[],
  params: EnzymeInhibitionParams | undefined,
  label: string,
): Promise<AnalysisOutcome> {
  const yCol = params?.y?.length ? yCols.find((c) => c.name === params.y![0]) : yCols[0];
  if (!yCol) return { error: xyProblem([xCol, ...yCols])! };
  const et = params?.enzymeConcentration;
  if (et === undefined || !Number.isFinite(et))
    return { error: "Total enzyme concentration (Et) is required for the Morrison Ki fit." };
  if (et <= 0) return { error: "Et (total enzyme concentration) must be greater than 0." };
  const s = params?.substrateConcentration;
  const km = params?.kmForMorrison;
  if ((s === undefined) !== (km === undefined))
    return {
      error:
        "Substrate concentration and Km must be supplied together — provide both, or neither, to convert Kiapp to Ki.",
    };
  if (s !== undefined && (!Number.isFinite(s) || s <= 0))
    return { error: "Substrate concentration must be greater than 0." };
  if (km !== undefined && (!Number.isFinite(km) || km <= 0)) return { error: "Km must be greater than 0." };

  const { x: xs, y: ys } = pairUp(xCol, yCol);
  const n = xs.length;
  if (xs.some((x) => x < 0)) return { error: "Inhibitor concentrations cannot be negative." };
  if (new Set(xs).size < 2)
    return { error: "Need at least two different inhibitor concentrations to fit the Morrison Ki." };
  if (n < 3) return { error: `Not enough complete points (${n}) to fit this curve; need at least 3.` };
  if (Math.max(...ys) <= 0) return { error: "No positive velocities — v0 cannot be estimated." };

  // v0 ≈ max(Y) (the curve falls with It); Kiapp ≈ the It at which Y is
  // closest to v0/2, else the median positive It.
  const v00 = Math.max(...ys);
  const positiveIt = xs.filter((x) => x > 0);
  let kiapp0 = median(positiveIt);
  let bestIt: number | null = null;
  let bestDist = Infinity;
  xs.forEach((x, i) => {
    const d = Math.abs(ys[i] - v00 / 2);
    if (d < bestDist) {
      bestDist = d;
      bestIt = x;
    }
  });
  if (bestIt != null && bestIt > 0) kiapp0 = bestIt;

  const spec = morrisonSpec({ v0: v00, kiapp: kiapp0 });
  try {
    const { coefficients, stats } = await fitModelSpec(xs, ys, spec, `Et<-${et};`);
    const v0 = coefOf(coefficients, "v0");
    const kiapp = coefOf(coefficients, "Kiapp");
    if (v0 != null && v0 <= 0) return { error: "Fitted v0 ≤ 0 — the data do not support the Morrison Ki model." };
    if (kiapp != null && kiapp <= 0)
      return { error: "Fitted Kiapp ≤ 0 — the data do not support the Morrison Ki model." };

    const ki = s !== undefined && km !== undefined && kiapp != null ? kiapp / (1 + s / km) : null;
    // Ki (derived) and Et (constrained) join the fitted rows — both carry
    // an estimate only, no SE/t/p/CI, because neither is fitted.
    const allCoefficients: RegressionCoefficient[] = [
      ...coefficients,
      ...(ki != null
        ? [{ term: "Ki", estimate: ki, stdError: null, t: null, p: null, ciLow: null, ciHigh: null }]
        : []),
      { term: "Et", estimate: et, stdError: null, t: null, p: null, ciLow: null, ciHigh: null },
    ];
    // The plan's Morrison rows are R², Sy.x, DF and N (no sum of squares,
    // no AICc — a single-curve fit at one fixed [S]).
    const morrisonStats: StatRow[] = stats.filter((row) =>
      ["R squared", "Sy.x", "Degrees of freedom", "N"].includes(row.label),
    );

    const notes = [
      `Morrison Ki fit ("${label}") of “${yCol.name}” on “${xCol.name}” (total inhibitor concentration) at one fixed substrate concentration — a single-curve fit, not a global fit.`,
      `Total enzyme concentration Et = ${num(et)} is a constrained constant, not a fitted parameter.`,
      `Starting values: v0 = ${num(v00)}, Kiapp = ${num(kiapp0)}.`,
    ];
    if (ki != null && kiapp != null)
      notes.push(`Ki = Kiapp/(1 + [S]/Km) = ${num(kiapp)}/(1 + ${num(s!)}/${num(km!)}) = ${num(ki)}.`);
    else notes.push("Ki needs [S] and Km — supply both to convert Kiapp to Ki; Kiapp is reported on its own.");
    if (kiapp != null && et < kiapp / 10) notes.push("Et ≪ Kiapp — standard (non-tight) models would suffice.");

    const eq = equation("morrison", allCoefficients, et);
    return {
      testType: "enzyme-inhibition",
      subtitle: label,
      ...(eq ? { equation: eq } : {}),
      stats: morrisonStats,
      groups: [xCol, yCol].map(describe),
      notes: notes.join(" "),
      coefficients: allCoefficients,
    };
  } catch (err) {
    return inhibitionFitError(err, label);
  }
}
