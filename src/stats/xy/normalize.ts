// Normalize (v2): rescale every value in the chosen columns to a common
// scale (Prism's Analyze > Normalize) — each value as a percent (or
// fraction) of a reference, or on a 0–100% scale with 0% and 100% defined
// separately. Pure arithmetic, no R: the only R call is `describe`, for the
// descriptives of the normalized values (as every other analysis reports
// them). The source data is never touched — the normalized values live in
// the result only, with the reference used recorded per column so the
// operation is auditable.
//
// Prism (Prism 11 User Guide, "Normalize") defines the scale two ways:
// a percent/fraction of a reference — the largest value in each data set,
// the smallest value, the first value, the mean of control column(s), or a
// constant you enter — or 0–100%, where 0% is the smallest value, the first
// row's value, or a value you enter, and 100% is the largest value, the
// last row's value, a value you enter, or the sum of all values.
//
// A value that cannot be normalized — a zero reference (dividing by zero),
// or a 0–100% scale whose 0% and 100% are equal (a zero range) — is left
// blank (null) in the results and counted in `excluded`, never NaN or
// Infinity, and the notes say why: Prism likewise leaves such values blank.
import type {
  AnalysisOutcome,
  NormalizedColumn,
  NormalizeHundredDef,
  NormalizeMethod,
  NormalizeParams,
  NormalizeZeroDef,
} from "../types";
import { describe, missingColumn } from "../column/base";
import { datasetColumns, type Column as DatasetColumn } from "../../lib/dataset";

/** The row title, or the row number when the table has none (as K-means/PCA name rows). */
const rowName = (titles: (string | null)[], r: number) => titles[r]?.trim() || `Row ${r + 1}`;

const sum = (values: number[]) => values.reduce((s, v) => s + v, 0);
const mean = (values: number[]) => sum(values) / values.length;

/** How each method is written in the results (and in the wizard's labels). */
export const NORMALIZE_LABEL: Record<NormalizeMethod, string> = {
  "percent-of-largest": "Percent of largest value",
  "percent-of-smallest": "Percent of smallest value",
  "percent-of-first": "Percent of first value",
  "percent-of-mean-controls": "Percent of mean of controls",
  "percent-of-constant": "Percent of constant",
  "zero-to-hundred": "0–100%",
};

const PERCENT_METHODS: NormalizeMethod[] = [
  "percent-of-largest",
  "percent-of-smallest",
  "percent-of-first",
  "percent-of-mean-controls",
  "percent-of-constant",
];

/** The shared 100% reference for the "mean-of-controls" and "constant"
 *  methods, resolved once: both are one value for every column, unlike the
 *  per-column references (largest/smallest/first), which resolve inside
 *  the loop below. */
function sharedReference(
  method: NormalizeMethod,
  params: NormalizeParams | undefined,
  columns: DatasetColumn[],
): { reference: number; description: string } | { error: string } {
  if (method === "percent-of-constant") {
    const constant = params?.constant;
    if (constant == null || !Number.isFinite(constant))
      return { error: "Enter the constant value that is 100%." };
    return { reference: constant, description: `Constant ${constant}` };
  }
  // percent-of-mean-controls.
  const names = params?.controls ?? [];
  if (!names.length) return { error: "Choose at least one control column to average for the 100% reference." };
  const gone = names.find((n) => datasetColumns(columns, n).length === 0);
  if (gone) return { error: missingColumn(gone) };
  const controlColumns = names.flatMap((n) => datasetColumns(columns, n));
  const empty = names.find((n) => datasetColumns(columns, n).every((c) => c.values.length === 0));
  if (empty) return { error: `“${empty}” holds no numbers yet.` };
  return {
    reference: mean(controlColumns.flatMap((c) => c.values)),
    description: `Mean of ${names.map((n) => `“${n}”`).join(", ")}`,
  };
}

/** One end of a 0–100% scale for one column, from its definition. */
function scaleEnd(
  def: NormalizeZeroDef | NormalizeHundredDef,
  constant: number | undefined,
  col: DatasetColumn,
  which: "0%" | "100%",
): { value: number } | { error: string } {
  switch (def) {
    case "smallest":
      return { value: Math.min(...col.values) };
    case "first":
      return { value: col.values[0] };
    case "constant":
      if (constant == null || !Number.isFinite(constant))
        return { error: `Enter the constant value that is ${which}.` };
      return { value: constant };
    case "largest":
      return { value: Math.max(...col.values) };
    case "last":
      return { value: col.values[col.values.length - 1] };
    case "sum":
      return { value: sum(col.values) };
  }
}

export async function runNormalize(
  columns: DatasetColumn[],
  params: NormalizeParams | undefined,
  titles: (string | null)[],
): Promise<AnalysisOutcome> {
  const method = params?.normalizeMethod ?? "percent-of-largest";
  if (![...PERCENT_METHODS, "zero-to-hundred"].includes(method))
    return { error: `Unknown normalize method: “${method}”.` };
  const xCol = params?.x ? columns.find((c) => c.name === params.x) : undefined;

  // The columns to normalize: the wizard's choice, or every numeric column
  // except X. A named column holding no numbers is named, not silently
  // skipped (a deleted one is caught earlier, by runAnalysis).
  let targets: DatasetColumn[];
  if (params?.ys?.length) {
    targets = params.ys.flatMap((n) => datasetColumns(columns, n));
    const empty = params.ys.find((n) => datasetColumns(columns, n).every((c) => c.values.length === 0));
    if (empty) return { error: `“${empty}” holds no numbers yet.` };
  } else {
    targets = columns.filter((c) => c !== xCol && c.values.length > 0);
  }
  if (!targets.length)
    return { error: xCol ? "No Y column holds numbers yet." : "No column holds numbers yet." };

  const asPercent = method === "zero-to-hundred" ? true : (params?.asPercent ?? true);

  // The shared reference, when the method has one.
  let shared: { reference: number; description: string } | undefined;
  if (method === "percent-of-mean-controls" || method === "percent-of-constant") {
    const resolved = sharedReference(method, params, columns);
    if ("error" in resolved) return resolved;
    shared = resolved;
  }
  const zeroDef: NormalizeZeroDef = params?.zeroDef ?? "smallest";
  const hundredDef: NormalizeHundredDef = params?.hundredDef ?? "largest";
  if (method === "zero-to-hundred" && !["smallest", "first", "constant"].includes(zeroDef))
    return { error: `Unknown 0% definition: “${zeroDef}”.` };
  if (method === "zero-to-hundred" && !["largest", "last", "constant", "sum"].includes(hundredDef))
    return { error: `Unknown 100% definition: “${hundredDef}”.` };

  const normalized: NormalizedColumn[] = [];
  for (const col of targets) {
    let reference: number;
    let hundred: number | undefined;
    let description: string;
    if (shared) {
      ({ reference, description } = shared);
    } else if (method === "percent-of-largest") {
      reference = Math.max(...col.values);
      description = `Largest value: ${reference}`;
    } else if (method === "percent-of-smallest") {
      reference = Math.min(...col.values);
      description = `Smallest value: ${reference}`;
    } else if (method === "percent-of-first") {
      reference = col.values[0];
      description = `First value: ${reference}`;
    } else {
      // zero-to-hundred: 0% and 100% are defined separately, per column.
      const zero = scaleEnd(zeroDef, params?.zeroConstant, col, "0%");
      if ("error" in zero) return zero;
      const top = scaleEnd(hundredDef, params?.hundredConstant, col, "100%");
      if ("error" in top) return top;
      reference = zero.value;
      hundred = top.value;
      description = `0% = ${reference}, 100% = ${hundred}`;
    }

    const scale = asPercent ? 100 : 1;
    const rows = col.rows.map((r) => {
      const original = col.byRow[r]!;
      let value: number | null;
      if (hundred !== undefined) {
        // 0–100%: a zero range (0% = 100%) leaves every value undefined.
        value = hundred === reference ? null : ((original - reference) / (hundred - reference)) * 100;
      } else {
        // Percent/fraction of the reference: a zero reference leaves
        // every value undefined (dividing by zero).
        value = reference === 0 ? null : (original / reference) * scale;
      }
      return {
        row: rowName(titles, r),
        ...(xCol ? { x: xCol.byRow[r] ?? null } : {}),
        original,
        normalized: value != null && Number.isFinite(value) ? value : null,
      };
    });
    normalized.push({
      column: col.name,
      method: NORMALIZE_LABEL[method],
      reference,
      ...(hundred !== undefined ? { hundred } : {}),
      asPercent,
      rows,
      // Kept beside the rows so the results table can name the scale.
      referenceDescription: description,
    });
  }

  const withValues = normalized
    .map((c) => ({ name: c.column, values: c.rows.map((r) => r.normalized).filter((v): v is number => v != null) }))
    .filter((g) => g.values.length > 0);
  const { groups } = withValues.length ? await describe(withValues) : { groups: [] };

  const stats = normalized.flatMap((c) =>
    c.hundred !== undefined
      ? [
          { label: `0% reference for “${c.column}”`, value: c.reference },
          { label: `100% reference for “${c.column}”`, value: c.hundred },
        ]
      : [{ label: `100% reference for “${c.column}”`, value: c.reference }],
  );

  const scaleNote =
    method === "zero-to-hundred"
      ? "each value on a 0–100% scale"
      : `each value as a ${asPercent ? "percent" : "fraction"} of ${shared ? shared.description.toLowerCase() : "its reference"}`;
  const references = normalized.map((c) => `${c.column}: ${c.referenceDescription}`).join("; ");
  const blanks = normalized
    .map((c) => {
      const excluded = c.rows.filter((r) => r.normalized == null).length;
      if (excluded === 0) return "";
      const reason =
        c.hundred !== undefined
          ? "the 0% and 100% values are equal, so the scale has no range"
          : "the 100% reference is 0, so dividing by it is undefined";
      if (excluded === c.rows.length)
        return `“${c.column}”: no value could be normalized (${reason}), so the column is blank.`;
      return `“${c.column}”: ${excluded} value${excluded === 1 ? "" : "s"} left blank (${reason}).`;
    })
    .filter(Boolean)
    .join(" ");
  return {
    testType: "normalize",
    subtitle: `Normalize (${NORMALIZE_LABEL[method]})`,
    stats,
    groups,
    notes:
      `Rescaled ${scaleNote} in ${normalized.map((c) => `“${c.column}”`).join(", ")}. ` +
      `References used — ${references}. ` +
      "The original values are unchanged; the tables below are the normalized values. " +
      "Only rows holding a value are listed." +
      (blanks ? ` ${blanks}` : ""),
    normalized,
  };
}
