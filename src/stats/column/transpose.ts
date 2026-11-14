// "Transpose rows/columns" (v2): flip a table's orientation — each row
// becomes a column (data set) and each column becomes a row (Prism's
// Analyze > Transpose). Pure TypeScript, no R: the values are only moved,
// never computed. The source table is never touched: like Prism, the
// transposed values live in the result's `transposed` table only, as a
// results sheet.
//
// Prism's rules (Prism 8/9 User Guide, "Transpose rows and columns";
// GraphPad FAQ 342): each row of Y values becomes one column in the results
// table — the first row becomes the first data set, the second row the
// second, and so on — and the column and row titles of the results table
// are the source table's row and column titles. A table with more than 256
// rows cannot be transposed, because Prism cannot create a table with more
// than 256 columns; the runner enforces the same cap.
//
// No wizard: transposing takes no options in this first version (Prism's
// dialog also offers the new table's type and its row titles — a follow-up,
// not this lane). Picking it runs at once, like the other wizard-less
// analyses. Offered on XY and Column tables only, like the other data
// operations; grouped tables (replicate sub-columns) are out of scope.
import type { AnalysisOutcome, TransposedCell } from "../types";
import type { Column as DatasetColumn } from "../../lib/dataset";

/** Prism's cap: a transposed table has one column per source row, and
 *  Prism cannot create a table with more than 256 columns. */
const MAX_ROWS = 256;

/** The row title, or the row number when the table has none (as K-means/PCA name rows). */
const rowName = (titles: (string | null)[], r: number) => titles[r]?.trim() || `Row ${r + 1}`;

/** One cell, moved as-is: a number where the source cell held one, the raw
 *  text where it held text, null where it was blank (or excluded — excluded
 *  cells already read as blank). */
function transposedCell(column: DatasetColumn, r: number): TransposedCell {
  const numeric = column.byRow[r];
  if (numeric != null) return numeric;
  const raw = column.cells[r];
  return raw == null || raw.trim() === "" ? null : raw;
}

export async function runTranspose(
  columns: DatasetColumn[],
  titles: (string | null)[],
): Promise<AnalysisOutcome> {
  const rowCount = titles.length;
  if (rowCount > MAX_ROWS)
    return {
      error:
        `A table with ${rowCount} rows cannot be transposed — ` +
        `Prism cannot create a table with more than 256 columns.`,
    };
  const anyValue = columns.some((c) => c.cells.some((cell) => cell != null && cell.trim() !== ""));
  if (!anyValue) return { error: "No cell holds a value yet." };

  return {
    testType: "transpose",
    subtitle: "Transpose rows/columns",
    stats: [],
    groups: [],
    notes:
      `Transposed the table: each row became a column (data set) and each column became a row — ` +
      `the ${rowCount}-row × ${columns.length}-column table became a ${columns.length}-row × ${rowCount}-column table. ` +
      `The source table is unchanged; the transposed values below are a results sheet. ` +
      `Blank cells stay blank, and text stays text.`,
    transposed: {
      columns: ["Title", ...titles.map((_, r) => rowName(titles, r))],
      rows: columns.map((c) => [c.name, ...titles.map((_, r) => transposedCell(c, r))]),
    },
  };
}
