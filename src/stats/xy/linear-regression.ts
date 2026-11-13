// Ordinary least-squares simple linear regression of a chosen Y data series on X,
// for an XY table. Optionally forces the line through the origin (intercept = 0);
// reports 95% confidence intervals for the slope and intercept alongside the fit.
import type { Column, LinearRegressionParams, NonlinearWeightScheme, StatRow } from "../types";
import { pRow, rVec, type ColumnTestSpec, type Group } from "../column/base";
import { pairUp, splitXY, xyProblem } from "../../lib/dataset";
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
function pickXY(columns: Column[], params: LinearRegressionParams | undefined): Group[] {
  const { x, ys } = splitXY(columns);
  const y = params?.y === undefined ? ys[0] : ys.find((c) => c.name === params.y);
  if (!x || !y) return [];
  const pairs = pairUp(x, y);
  return [
    { name: x.name, values: pairs.x },
    { name: y.name, values: pairs.y },
  ];
}

export const linearRegressionSpec: ColumnTestSpec<LinearRegressionParams> = {
  testType: "linear-regression",
  minGroups: 2,
  check: (columns, params) => {
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
    const { x, ys } = splitXY(columns);
    const y = params?.y === undefined ? ys[0] : ys.find((c) => c.name === params.y);
    if (!x || !y) return undefined;
    const pairs = pairUp(x, y);
    if (weights === "1/y" && pairs.y.some((v) => v <= 0))
      return "Weighting by 1/Y needs all Y > 0 — some fitted Y are ≤ 0.";
    if (weights === "1/y2" && pairs.y.some((v) => v === 0))
      return "Weighting by 1/Y² needs Y ≠ 0 — some fitted Y are 0.";
    if (weights === "1/x" && pairs.x.some((v) => v <= 0))
      return "Weighting by 1/X needs all X > 0 — some fitted X are ≤ 0.";
    if (weights === "1/x2" && pairs.x.some((v) => v === 0))
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
      `r2=s$r.squared,p=unname(s$coefficients[${slopeIdx},4]),` +
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
