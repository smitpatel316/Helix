// Shared predictor selection for the multiple-* regression runners
// (multiple-regression, multiple-logistic-regression, poisson-regression).
//
// A chosen predictor whose column holds no numbers is invisible to
// `dataGroups`, so filtering the chosen names against it drops the predictor
// without a word and the fit runs on the subset — R²/coefficients are then
// presented as the chosen model, with only the "Predictors: p" count hinting
// the subset is smaller. The runners name the dropped predictor(s) in the
// fit's notes instead (R2-m5, bug-fix queue item 39). A chosen name that is
// not a column at all never reaches here: runAnalysis errors on it first
// with missingColumn.
import { dataGroups } from "../column/base";
import type { Column } from "../types";

export interface PredictorSelection {
  dep: Column | undefined;
  predictors: Column[];
  /** Chosen predictors left out because their column holds no numbers. */
  dropped: string[];
}

export function selectPredictors(
  columns: Column[],
  params: { dependent?: string; predictors?: string[] } | undefined,
): PredictorSelection {
  const vars = dataGroups(columns);
  const dep = params?.dependent === undefined ? vars[0] : vars.find((c) => c.name === params.dependent);
  const chosen = params?.predictors;
  const predictors = dep
    ? chosen && chosen.length > 0
      ? vars.filter((c) => c !== dep && chosen.includes(c.name))
      : vars.filter((c) => c !== dep)
    : [];
  const dropped =
    dep && chosen && chosen.length > 0
      ? [...new Set(chosen.filter((name) => name !== dep.name && !predictors.some((c) => c.name === name)))]
      : [];
  return { dep, predictors, dropped };
}

/** The sentence the fit's notes carry for dropped predictors — "" when none
 *  were dropped, so callers append it unconditionally. */
export function droppedPredictorsNote(dropped: string[]): string {
  if (dropped.length === 0) return "";
  const plural = dropped.length > 1;
  const names = dropped.map((n) => `“${n}”`).join(", ");
  return (
    ` Note: ${names} ${plural ? "were" : "was"} chosen as predictor${plural ? "s" : ""} but hold${plural ? "" : "s"} no numbers, ` +
    `so ${plural ? "they were" : "it was"} left out of the fit — the statistics above describe the fitted predictors only.`
  );
}
