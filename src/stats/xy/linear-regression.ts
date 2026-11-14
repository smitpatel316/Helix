// Ordinary least-squares simple linear regression of a chosen Y data series on X: an XY
// table's X, or two variables of a Multiple Variables table (`x`, `y`). Optionally forces the line through the origin (intercept = 0);
// reports 95% confidence intervals for the slope and intercept alongside the fit.
import type { AnalysisOutcome, Column, FitRow, LinearRegressionParams, NonlinearWeightScheme, StatRow } from "../types";
import { describe, pRow, rVec, type ColumnTestSpec, type Group } from "../column/base";
import { evalNamedVector } from "../webr";
import { pairUp, splitXY, xyPoints, xyProblem } from "../../lib/dataset";
import { num } from "../../lib/format";

const DEFAULTS: LinearRegressionParams = { forceOrigin: false };

/** The R expression for a weighting scheme, over the `x`/`y` vectors. */
const WEIGHT_R: Record<Exclude<NonlinearWeightScheme, "none" | "1/sd2">, string> = {
  "1/y": "1/y",
  "1/y2": "1/y^2",
  "1/x": "1/x",
  "1/x2": "1/x^2",
};
const WEIGHT_LABEL: Record<Exclude<NonlinearWeightScheme, "none" | "1/sd2">, string> = {
  "1/y": "1/Y",
  "1/y2": "1/Y²",
  "1/x": "1/X",
  "1/x2": "1/X²",
};

/** X and the chosen Y series (the first by default), on the rows where both have a value. */

/** X and Y regressed, on the points they make: two variables named (on the rows where
 *  both have a value), else an XY table's X and the chosen Y data set (the first by
 *  default), each replicate a point. */
function pickXY(columns: Column[], params: LinearRegressionParams | undefined): Group[] {
  const named = (name?: string) => columns.find((c) => c.name === name);
  let points: { x: number[]; y: number[] } | undefined;
  let names: [string, string] = ["", ""];
  if (params?.x !== undefined) {
    const [x, y] = [named(params.x), named(params.y)];
    if (x && y) [points, names] = [pairUp(x, y), [x.name, y.name]];
  } else {
    const { x, ys } = splitXY(columns);
    const y = params?.y === undefined ? ys[0] : ys.find((s) => s.name === params.y);
    if (x && y) [points, names] = [xyPoints(x, y), [x.name, y.name]];
  }
  return points
    ? [
        { name: names[0], values: points.x },
        { name: names[1], values: points.y },
      ]
    : [];
}

export const linearRegressionSpec: ColumnTestSpec<LinearRegressionParams> = {
  testType: "linear-regression",
  minGroups: 2,
  check: (columns, params) => {
    if (params?.x !== undefined) {
      const empty = [params.x, params.y].map((n) => columns.find((c) => c.name === n)).find((c) => c && !c.values.length);
      return empty && `“${empty.name}” holds no numbers yet.`;
    }
    const problem = xyProblem(columns, params?.y);
    if (problem) return problem;
    // Plan 26: weighting, the same schemes as nonlinear regression except
    // 1/SD², which needs the replicate columns this runner never sees.
    const weights = params?.weights ?? "none";
    // `1/sd2` is not in this runner's weights type — it can still arrive
    // from a saved file or a direct runAnalysis call, so check by string.
    if ((weights as string) === "1/sd2")
      return "Weighting by 1/SD² needs replicate SDs, which linear regression doesn't see — use nonlinear regression with the same weighting.";
    if (weights === "none") return undefined;
    const pairs = pickXY(columns, params);
    if (pairs.length < 2) return undefined;
    if (weights === "1/y" && pairs[1].values.some((v) => v <= 0))
      return "Weighting by 1/Y needs all Y > 0 — some fitted Y are ≤ 0.";
    if (weights === "1/y2" && pairs[1].values.some((v) => v === 0))
      return "Weighting by 1/Y² needs Y ≠ 0 — some fitted Y are 0.";
    if (weights === "1/x" && pairs[0].values.some((v) => v <= 0))
      return "Weighting by 1/X needs all X > 0 — some fitted X are ≤ 0.";
    if (weights === "1/x2" && pairs[0].values.some((v) => v === 0))
      return "Weighting by 1/X² needs X ≠ 0 — some fitted X are 0.";
    return undefined;
  },
  parseGroups: pickXY,
  rCode: (groups, params) => {
    const origin = (params ?? DEFAULTS).forceOrigin;
    const formula = origin ? "y~x+0" : "y~x";
    const slopeIdx = origin ? 1 : 2;
    const interceptTerms = origin ? "" : ",interceptCiLo=unname(ci[1,1]),interceptCiHi=unname(ci[1,2])";
    // summary(lm)'s R² is the weighted one when weights are given, so no
    // further adjustment is needed.
    const weights = (params ?? DEFAULTS).weights ?? "none";
    const wAssign = weights === "none" ? "" : `w<-${WEIGHT_R[weights]};`;
    const wArg = weights === "none" ? "" : ",weights=w";
    return (
      `x<-${rVec(groups[0].values)};y<-${rVec(groups[1].values)};${wAssign}m<-lm(${formula}${wArg});s<-summary(m);ci<-confint(m);` +
      `c(slope=unname(coef(m)[${slopeIdx}]),intercept=${origin ? "0" : "unname(coef(m)[1])"},` +
      `r=cor(x,y),r2=s$r.squared,p=unname(s$coefficients[${slopeIdx},4]),` +
      `slopeCiLo=unname(ci[${slopeIdx},1]),slopeCiHi=unname(ci[${slopeIdx},2])${interceptTerms})`
    );
  },
  rows: (v, _groups, params) => {
    const origin = (params ?? DEFAULTS).forceOrigin;
    const rows: StatRow[] = [
      { label: "Slope", value: v.slope },
      { label: "Slope 95% CI lower", value: v.slopeCiLo },
      { label: "Slope 95% CI upper", value: v.slopeCiHi },
    ];
    if (origin) {
      rows.push({ label: "Y-intercept", value: 0 });
    } else {
      rows.push(
        { label: "Y-intercept", value: v.intercept },
        { label: "Intercept 95% CI lower", value: v.interceptCiLo },
        { label: "Intercept 95% CI upper", value: v.interceptCiHi },
      );
      // r is the unweighted cor(x,y): on a weighted fit r² ≠ the weighted R²,
      // so no r is shown (Prism shows none either) — same rule as the
      // multi-Y table below.
      if (((params ?? DEFAULTS).weights ?? "none") === "none") rows.push({ label: "Pearson r", value: v.r });
    }
    rows.push({ label: "R squared", value: v.r2 }, pRow("P value (slope ≠ 0)", v.p));
    return rows;
  },
  notes: (params, groups) => {
    const weights = (params ?? DEFAULTS).weights ?? "none";
    return (
      `Ordinary least-squares linear regression of “${groups[1]?.name ?? "Y"}” on “${groups[0]?.name ?? "X"}”` +
      `${(params ?? DEFAULTS).forceOrigin ? ", forced through the origin" : ""}. ` +
      (weights === "none"
        ? "Assumes a linear relationship and homoscedastic residuals."
        : `Weighted by ${WEIGHT_LABEL[weights]}; R² is weighted.`)
    );
  },
  subtitle: (params) =>
    (params ?? DEFAULTS).forceOrigin ? "Simple linear regression (through origin)" : "Simple linear regression",
  equation: (v, _groups, params) => {
    if (v.slope == null) return undefined;
    const term = `${num(v.slope)}*X`;
    const b = v.intercept;
    if ((params ?? DEFAULTS).forceOrigin || b == null || b === 0) return `Y = ${term}`;
    return `Y = ${term} ${b < 0 ? "−" : "+"} ${num(Math.abs(b))}`;
  },
};

/** Several Y data sets of an XY table, each regressed on X on its own (each replicate a
 *  point): their best-fit values side by side, every number R's. */
export async function runLinearRegressions(
  columns: Column[],
  params: LinearRegressionParams & { ys: string[] },
): Promise<AnalysisOutcome> {
  const { x, ys } = splitXY(columns);
  const sets = params.ys.map((name) => ys.find((s) => s.name === name));
  const lacking = params.ys.find((_, i) => !sets[i]);
  if (!x || lacking !== undefined) return { error: xyProblem(columns, lacking)! };
  const points = sets.map((s) => xyPoints(x, s!));
  const few = sets.find((_, i) => points[i].x.length < 3);
  if (few) return { error: `“${few.name}” needs at least 3 points to be regressed on X.` };
  const origin = params.forceOrigin;
  // The multi-Y path never passes through the spec's check(), so weight
  // validity is checked here, per set on the paired points — the same
  // rules as the single-Y check, naming the set that fails them.
  const weights = params.weights ?? "none";
  if ((weights as string) === "1/sd2")
    return {
      error:
        "Weighting by 1/SD² needs replicate SDs, which linear regression doesn't see — use nonlinear regression with the same weighting.",
    };
  if (weights !== "none") {
    for (let i = 0; i < sets.length; i++) {
      const p = points[i];
      const bad =
        (weights === "1/y" && p.y.some((v) => v <= 0)) ||
        (weights === "1/y2" && p.y.some((v) => v === 0)) ||
        (weights === "1/x" && p.x.some((v) => v <= 0)) ||
        (weights === "1/x2" && p.x.some((v) => v === 0));
      if (!bad) continue;
      const need =
        weights === "1/y"
          ? "Weighting by 1/Y needs all Y > 0 — some fitted Y are ≤ 0."
          : weights === "1/y2"
            ? "Weighting by 1/Y² needs Y ≠ 0 — some fitted Y are 0."
            : weights === "1/x"
              ? "Weighting by 1/X needs all X > 0 — some fitted X are ≤ 0."
              : "Weighting by 1/X² needs X ≠ 0 — some fitted X are 0.";
      return { error: `“${sets[i]!.name}”: ${need}` };
    }
  }
  // Weights are per set: 1/Y and 1/Y² read that set's own Y (1/X and 1/X²
  // read the shared X), so the w vector is built inside each set's R code.
  const wAssign = weights === "none" ? "" : `w<-${WEIGHT_R[weights]};`;
  const wArg = weights === "none" ? "" : ",weights=w";
  const v = await evalNamedVector(
    points
      .map(
        (p, i) =>
          `x<-${rVec(p.x)};y<-${rVec(p.y)};${wAssign}m<-lm(${origin ? "y~x+0" : "y~x"}${wArg});s<-summary(m);ci<-confint(m);k<-${origin ? 1 : 2};` +
          `v${i}<-c(slope=unname(coef(m)[k]),slo=ci[k,1],shi=ci[k,2],` +
          `b=${origin ? "0" : "unname(coef(m)[1])"},blo=${origin ? "NA" : "ci[1,1]"},bhi=${origin ? "NA" : "ci[1,2]"},` +
          `r=${origin ? "NA" : "cor(x,y)"},r2=s$r.squared,p=s$coefficients[k,4],n=length(y))`,
      )
      .join(";") + `;c(${points.map((_, i) => `setNames(v${i},paste0(names(v${i}),"_${i}"))`).join(",")})`,
  );
  const of = (key: string) => sets.map((_, i) => v[`${key}_${i}`] ?? null);
  const range = (lo: string, hi: string) =>
    sets.map((_, i): [number | null, number | null] => [v[`${lo}_${i}`] ?? null, v[`${hi}_${i}`] ?? null]);
  const rows: FitRow[] = [
    { label: "Slope", values: of("slope") },
    { label: "95% CI", ranges: range("slo", "shi") },
    { label: "Y-intercept", values: of("b") },
    ...(origin ? [] : [{ label: "95% CI", ranges: range("blo", "bhi") }]),
    // No Pearson r on a weighted fit (it is the unweighted cor(x,y), so
    // r² ≠ the weighted R²) — same rule as the single-Y table above.
    ...(origin || weights !== "none" ? [] : [{ label: "Pearson r", values: of("r") }]),
    { label: "R squared", values: of("r2") },
    { label: "P value (slope ≠ 0)", values: of("p"), p: true },
    { label: "N", values: of("n") },
  ];
  return {
    testType: "linear-regression",
    subtitle: origin ? "Simple linear regression (through origin)" : "Simple linear regression",
    stats: [],
    fit: { sets: sets.map((s) => s!.name), rows },
    groups: (await describe([x, ...sets.map((s) => ({ name: s!.name, values: s!.columns.flatMap((c) => c.values) }))]))
      .groups,
    notes:
      `Ordinary least-squares linear regression of each Y data set on “${x.name}”, each on its own` +
      `${origin ? ", forced through the origin" : ""}. ` +
      (weights === "none"
        ? "Assumes a linear relationship and homoscedastic residuals."
        : `Weighted by ${WEIGHT_LABEL[weights]}; R² is weighted.`),
  };
}
