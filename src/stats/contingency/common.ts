// Shared contingency-table builder: the count matrix every contingency test
// reads (each data column is a group, each row a category, built from
// complete rows), plus the validation all of them share.
import type { Column } from "../types";
import { dataGroups, pairedGroups } from "../column/base";

export interface ContingencyMatrix {
  matrix: number[][];
  rows: number;
  cols: number;
}

export function buildContingencyMatrix(columns: Column[]): ContingencyMatrix | { error: string } {
  const cols = dataGroups(columns).length;
  if (cols < 2) return { error: "A contingency table needs at least 2 group columns." };

  // Category rows = complete rows (a count in every group column).
  const groups = pairedGroups(columns);
  const matrix = (groups[0]?.values ?? []).map((_, r) => groups.map((g) => g.values[r]));
  if (matrix.flat().some((v) => v < 0)) return { error: "Counts can't be negative." };
  const part = matrix.flat().find((v) => !Number.isInteger(v));
  if (part !== undefined) return { error: `Counts must be whole numbers; the table holds ${part}.` };
  if (matrix.length < 2) {
    return { error: "A contingency table needs at least 2 rows with a count in every group column." };
  }

  const flat = matrix.flat();
  if (flat.every((v) => v === 0)) return { error: "The contingency table is empty (all counts are zero)." };
  return { matrix, rows: matrix.length, cols };
}
