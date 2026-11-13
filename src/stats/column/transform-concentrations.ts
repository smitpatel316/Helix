// "Transform concentrations" — convert one dose/concentration column between
// molar units (Prism's Transform > Transform concentrations). Pure
// TypeScript, no R: a conversion is an exact power of 1000, so there is
// nothing to fit. The source column is never touched — the converted
// values live only in the results sheet this returns.
//
// Units (see CONCENTRATION_UNITS in stats/types.ts): M, mM, µM, nM, pM.
// Mass units (mg/mL, …) are out of scope: they need a molecular weight,
// which this operation does not collect — the notes say so.
import type {
  AnalysisOutcome,
  Column,
  ConcentrationUnit,
  TransformConcentrationsParams,
} from "../types";
import { CONCENTRATION_UNITS, CONCENTRATION_UNIT_EXPONENTS } from "../types";
import { describe, missingColumn } from "./base";

/** The factor to multiply a value in `from` by to get it in `to`: an exact
 *  power of 1000 (each molar step is ×1000). */
export function concentrationFactor(from: ConcentrationUnit, to: ConcentrationUnit): number {
  return 10 ** (CONCENTRATION_UNIT_EXPONENTS[from] - CONCENTRATION_UNIT_EXPONENTS[to]);
}

/** A number without float dust (2.5 × 1000 is 2500, not 2500.0000000000005),
 *  for converted values. 15 significant digits: doubles carry ~15.95, so
 *  dust (16th digit) is stripped while genuine differences survive — the
 *  same clean() frequency-distribution uses for its bin edges. */
const clean = (v: number): number => Number(v.toPrecision(15));

/** One value converted from `from` to `to`. */
export function convertConcentration(value: number, from: ConcentrationUnit, to: ConcentrationUnit): number {
  return clean(value * concentrationFactor(from, to));
}

const isUnit = (u: unknown): u is ConcentrationUnit =>
  typeof u === "string" && (CONCENTRATION_UNITS as readonly string[]).includes(u);

/** How many of a column's cells hold text instead of a number (blank cells don't count). */
const skippedCells = (column: Column): number =>
  column.cells.filter((c, r) => c != null && c.trim() !== "" && column.byRow[r] == null).length;

export async function runTransformConcentrations(
  columns: Column[],
  params: TransformConcentrationsParams | undefined,
): Promise<AnalysisOutcome> {
  const name = params?.column;
  const fromUnit = params?.fromUnit;
  const toUnit = params?.toUnit;
  if (!name) return { error: "Choose a column to convert." };
  if (!isUnit(fromUnit) || !isUnit(toUnit)) {
    return { error: "Choose the units the values are in now and the units to convert them to." };
  }
  const column = columns.find((c) => c.name === name);
  if (!column) return { error: missingColumn(name) };
  if (column.values.length < 1) {
    return { error: `“${name}” holds no numeric values — enter concentrations in it first.` };
  }
  const factor = concentrationFactor(fromUnit, toUnit);
  const values = column.rows.map((r) => ({
    row: r + 1,
    original: clean(column.byRow[r]!),
    converted: convertConcentration(column.byRow[r]!, fromUnit, toUnit),
  }));
  const skipped = skippedCells(column);
  const notes =
    `Converted “${name}” from ${fromUnit} to ${toUnit} (×${factor}). ` +
    "The source column is unchanged — the converted values are in this results sheet only. " +
    "Only molar units are converted: mass units (mg/mL, …) need a molecular weight and are not offered here." +
    (skipped ? ` ${skipped} non-numeric cell${skipped === 1 ? "" : "s"} ignored.` : "");

  return {
    testType: "transform-concentrations",
    subtitle: `Concentrations converted from ${fromUnit} to ${toUnit} (×${factor})`,
    stats: [
      { label: "Values converted", value: values.length },
      { label: `Conversion factor (${fromUnit} → ${toUnit})`, value: factor },
    ],
    groups: (await describe([column])).groups,
    notes,
    convertedColumns: [{ column: name, fromUnit, toUnit, values }],
  };
}
