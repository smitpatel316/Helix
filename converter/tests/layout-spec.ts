// Independent layout + expectation builder for the prism2hlx verifiers
// (tests/layout-spec.ts).
//
// This is the OTHER side of the M2 check: it implements the field-by-field
// mapping from the vault spec (~/workspace/helix-vault/Research/Prism 10
// to hlx mapping.md) straight from the raw files, separately from the
// converter (converter/src/prism.ts). The verifiers (verify-corpus.ts,
// verify.ts) build their expectations from here — never from the
// converter's own walk — so a converter bug that shifts a column shows
// up as a mismatch instead of being agreed with.
//
// What it pins, from the spec:
//   - CSV layout: title col iff rowTitlesDataSet; X subcolumns, then each
//     dataset's subcolumns in file order. A count comes from the dataset
//     JSON (replicates / replicate ranges / table replicatesCount); a
//     missing dataset is skipped by the table's replicatesCount
//     (y_replicates) or its dataFormat's fixed shape; anything still
//     unknown is inferred from content.json's numberOfColumns when it is
//     the ONLY unknown. Two or more unknowns, or an inference that
//     doesn't fit the declared width, refuses the table.
//   - Dates: every shape reads as UTC (one frame); a slash date whose
//     first component is over 12 reads as DD/MM.
//   - Numbers: file-level comma rule — any cell with 2+ comma groups
//     ("1,234,567") makes commas thousands separators file-wide
//     (stripped); otherwise a single comma is a decimal ("45,5" → "45.5").
//   - Labels: a line break (\r, \n, \r\n) becomes one space;
//     a whitespace-only value is empty.

/** A dataset JSON, as the verifier reads it (only the fields it uses). */
export interface SetJson {
  title?: unknown;
  format?: string;
  replicates?: unknown[];
  "replicate ranges"?: { range?: string }[];
  dateTimeConversion?: { units?: string; zeroDate?: string };
}

export interface LayoutInput {
  format: string;
  dataFormat: string;
  replicatesCount?: number;
  hasTitleCol: boolean;
  /** content.json numberOfColumns, or the CSV's own width when missing. */
  declaredCols: number;
  declaredRows: number;
  xPresent: boolean;
  xJson: SetJson | null;
  /** One entry per dataSets UID, in file order; null = JSON missing. */
  sets: (SetJson | null)[];
  thousandsMode: boolean;
}

export interface LayoutResult {
  /** False when the table can't be laid out without guessing. */
  convert: boolean;
  refuseReason?: string;
  /** X subcolumns consumed (0 = no X column). */
  xCount: number;
  xTitle: string | null;
  /** Resolved subcolumn count per dataset, in file order (missing
   *  datasets included — they consume CSV columns without becoming
   *  Helix columns). */
  counts: number[];
  /** Title col + X subcolumns + every dataset's subcolumns. */
  consumedCols: number;
  /** Helix data-column names, in order (after the Title column). */
  columns: string[];
  /** Present datasets, in file order (for grouped groups/replicates). */
  presentSets: SetJson[];
}

// ── Text helpers (vault spec §3.3, written here, not read from prism.ts) ──

export const cleanText = (value: string): string => {
  const collapsed = value.replace(/\s*(\r\n|\r|\n)\s*/g, " ");
  return collapsed.trim() === "" ? "" : collapsed;
};

export function plainTitle(value: unknown): string {
  if (typeof value === "string") return cleanText(value);
  if (value !== null && typeof value === "object") {
    const s = (value as { string?: unknown }).string;
    if (typeof s === "string") return cleanText(s);
  }
  return "";
}

/** UTC milliseconds for a validated Y/M/D (+ time); null when impossible. */
function utcMs(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

export function parsePrismDate(value: string | null): number | null {
  if (value === null || value === "") return null;
  const s = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(?:[Zz])?$/.exec(s);
  if (iso) {
    return utcMs(
      Number(iso[1]),
      Number(iso[2]),
      Number(iso[3]),
      iso[4] === undefined ? 0 : Number(iso[4]),
      iso[5] === undefined ? 0 : Number(iso[5]),
      iso[6] === undefined ? 0 : Number(iso[6]),
    );
  }
  if (/^\d{4}$/.test(s)) return Date.UTC(Number(s), 0, 1);
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const [mo, d] = a > 12 ? [b, a] : [a, b];
    return utcMs(Number(slash[3]), mo, d);
  }
  return null;
}

export function daysBetween(start: string | null, end: string | null): string | null {
  const a = parsePrismDate(start);
  const b = parsePrismDate(end);
  if (a === null || b === null) return null;
  const days = (b - a) / 86_400_000;
  return Number.isInteger(days) ? String(days) : String(Number(days.toFixed(6)));
}

/** `1,5` → `1.5` in decimal mode; grouped numbers stripped of commas in
 *  thousands mode, everything else left as typed. */
export const normalizeNumber = (value: string | null, thousandsMode: boolean): string | null => {
  if (value === null) return null;
  if (thousandsMode) {
    return /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(value) ? value.replace(/,/g, "") : value;
  }
  return /^-?\d+,\d+$/.test(value) ? value.replace(",", ".") : value;
};

/** True when any parsed cell holds a number with 2+ comma digit-groups.
 *  Takes PARSED rows — raw CSV text can't tell a field separator from a
 *  thousands separator. */
export function detectThousandsMode(rows: string[][]): boolean {
  for (const row of rows) {
    for (const cell of row) {
      if (/^-?\d{1,3}(,\d{3}){2,}(\.\d+)?$/.test(cell)) return true;
    }
  }
  return false;
}

// ── Subcolumn counts ─────────────────────────────────────────────────────

const RANGE_RE = /^(\d+)(?:~(\d+))?$/;

export function replicateRangeProblems(set: SetJson): string[] {
  const problems: string[] = [];
  const ranges = set["replicate ranges"];
  if (!Array.isArray(ranges)) return problems;
  for (const r of ranges) {
    const raw = r.range ?? "";
    const m = RANGE_RE.exec(raw);
    if (!m) {
      problems.push(`“${raw}” isn't a replicate range`);
      continue;
    }
    if (m[2] !== undefined && Number(m[2]) < Number(m[1])) {
      problems.push(`“${raw}” is reversed (start after end)`);
    }
  }
  return problems;
}

export function replicateCount(set: SetJson, tableReplicatesCount?: number): number {
  if (Array.isArray(set.replicates)) return set.replicates.length;
  const ranges = set["replicate ranges"];
  if (Array.isArray(ranges)) {
    return ranges.reduce((n, r) => {
      const m = RANGE_RE.exec(r.range ?? "");
      if (!m) return n;
      return n + (m[2] === undefined ? 1 : Number(m[2]) - Number(m[1]) + 1);
    }, 0);
  }
  return tableReplicatesCount ?? 0;
}

/** Fixed-shape dataFormats and their subcolumn count (y_replicates
 *  varies, so it isn't here — it uses the table's replicatesCount). */
const DATAFORMAT_SUBCOLUMNS: Record<string, number> = {
  y_single: 1,
  y_sd_n: 3,
  y_se_n: 3,
  y_cv_n: 3,
  y_sd: 2,
  y_se: 2,
  y_cv: 2,
  y_plus_minus: 3,
  y_high_low: 3,
};

// ── Column naming (same rule as the `.pzfx` importer) ────────────────────

const SUFFIXES: Record<string, string[] | null> = {
  y_replicates: null,
  y_single: [],
  y_sd_n: ["_MEAN", "_SD", "_N"],
  y_se_n: ["_MEAN", "_SEM", "_N"],
  y_cv_n: ["_MEAN", "_CV", "_N"],
  y_sd: ["_MEAN", "_SD"],
  y_se: ["_MEAN", "_SE"],
  y_cv: ["_MEAN", "_CV"],
  y_plus_minus: ["_MEAN", "_PLUSERROR", "_MINUSERROR"],
  y_high_low: ["_MEAN", "_PLUSERROR", "_MINUSERROR"],
};

export function expectedNames(title: string, dataFormat: string, count: number): string[] {
  const base = title === "" ? "Y" : title;
  if (count === 1) return [base];
  const s = SUFFIXES[dataFormat];
  if (s && s.length === count) return s.map((x) => `${base}${x}`);
  if (s === null) return Array.from({ length: count }, (_, i) => `${base}_${i + 1}`);
  return Array.from({ length: count }, (_, i) => `${base}_${i + 1}`);
}

// ── Layout resolution ────────────────────────────────────────────────────

export function resolveLayout(input: LayoutInput): LayoutResult {
  const titleCols = input.hasTitleCol ? 1 : 0;
  const presentSets = input.sets.filter((s): s is SetJson => s !== null);

  // A present dataset's count is known unless its ranges are malformed.
  const knownCount = (set: SetJson): number | null =>
    replicateRangeProblems(set).length > 0 ? null : replicateCount(set, input.replicatesCount);
  // A missing dataset's skip count, when the table itself determines it.
  const missingCount = (): number | null => {
    if (input.dataFormat === "y_replicates" && typeof input.replicatesCount === "number") {
      return input.replicatesCount;
    }
    return DATAFORMAT_SUBCOLUMNS[input.dataFormat] ?? null;
  };

  let xCount: number | null = 0;
  let xTitle: string | null = null;
  if (input.xPresent) {
    if (input.xJson) {
      const t = plainTitle(input.xJson.title);
      xTitle = t !== "" ? t : "X";
      xCount = knownCount(input.xJson);
    } else {
      xTitle = "X";
      xCount = null;
    }
  }
  const counts: (number | null)[] = input.sets.map((s) => (s === null ? missingCount() : knownCount(s)));
  const knownSum = titleCols + (xCount ?? 0) + counts.reduce<number>((n, c) => n + (c ?? 0), 0);
  const unknowns = (xCount === null ? 1 : 0) + counts.filter((c) => c === null).length;

  const refused = (reason: string): LayoutResult => ({
    convert: false,
    refuseReason: reason,
    xCount: 0,
    xTitle: null,
    counts: counts.map((c) => c ?? 0),
    consumedCols: knownSum,
    columns: [],
    presentSets,
  });
  if (unknowns >= 2) {
    return refused(`${unknowns} datasets have unknown column counts`);
  }
  if (unknowns === 1) {
    const inferred = input.declaredCols - knownSum;
    if (inferred < 0) {
      return refused(`known datasets span ${knownSum} columns but the file declares ${input.declaredCols}`);
    }
    if (xCount === null) xCount = inferred;
    else counts[counts.indexOf(null)] = inferred;
  }
  if (xCount === 0) xTitle = null;

  // Helix column names, in order (after Title). A missing dataset
  // consumes CSV columns but names none; a multi-subcolumn X collapses
  // to one Helix column (the first subcolumn, or durations for a
  // survival date X).
  const columns: string[] = [];
  if (xTitle !== null && (xCount as number) > 0) columns.push(xTitle);
  if (input.format === "grouped") {
    for (let i = 0; i < input.sets.length; i++) {
      const set = input.sets[i];
      if (set === null) continue;
      const group = plainTitle(set.title) || "Group";
      for (let j = 0; j < (counts[i] as number); j++) columns.push(`${group}:Y${j + 1}`);
    }
  } else {
    for (let i = 0; i < input.sets.length; i++) {
      const set = input.sets[i];
      if (set === null) continue;
      columns.push(...expectedNames(plainTitle(set.title), input.dataFormat, counts[i] as number));
    }
  }
  return {
    convert: true,
    xCount: xCount as number,
    xTitle,
    counts: counts as number[],
    consumedCols: titleCols + (xCount as number) + (counts as number[]).reduce((n, c) => n + c, 0),
    columns,
    presentSets,
  };
}

// ── Expected rows ────────────────────────────────────────────────────────

/** Expected .hlx rows for a sheet, built straight from its CSV through
 *  the resolved layout — the C4 expectation. */
export function expectedRows(
  input: LayoutInput,
  layout: LayoutResult,
  csv: string[][],
): (string | null)[][] {
  const hasX = layout.xTitle !== null && layout.xCount > 0;
  const xFormat = input.xJson?.format ?? "";
  const colVals: (string | null)[][] = [];
  let cursor = 0;
  if (input.hasTitleCol) cursor++;
  if (hasX) {
    if (input.format === "survival" && xFormat.startsWith("date") && layout.xCount >= 2) {
      const cleanCell = (v: string | undefined): string | null => {
        if (v === "" || v === undefined) return null;
        const cleaned = cleanText(v);
        return cleaned === "" ? null : cleaned;
      };
      const starts = csv.map((r) => cleanCell(r[cursor]));
      const ends = csv.map((r) => cleanCell(r[cursor + 1]));
      colVals.push(starts.map((s, i) => daysBetween(s, ends[i])));
    } else {
      colVals.push(
        csv.map((r) => {
          const v = r[cursor];
          if (v === "" || v === undefined) return null;
          const cleaned = cleanText(v);
          return cleaned === "" ? null : normalizeNumber(cleaned, input.thousandsMode);
        }),
      );
    }
    cursor += layout.xCount;
  }
  for (let i = 0; i < input.sets.length; i++) {
    const count = layout.counts[i];
    if (input.sets[i] === null) {
      // A missing dataset consumes CSV columns without becoming Helix
      // columns — advance the cursor past them, add nothing.
      cursor += count;
      continue;
    }
    for (let j = 0; j < count; j++) {
      colVals.push(
        csv.map((r) => {
          const v = r[cursor];
          if (v === "" || v === undefined) return null;
          const cleaned = cleanText(v);
          return cleaned === "" ? null : normalizeNumber(cleaned, input.thousandsMode);
        }),
      );
      cursor++;
    }
  }
  const titles = input.hasTitleCol
    ? csv.map((r) => (r[0] === "" || r[0] === undefined ? null : cleanText(r[0]) || null))
    : csv.map(() => null);
  return Array.from({ length: input.declaredRows }, (_, r) => [
    titles[r] ?? null,
    ...colVals.map((c) => c[r] ?? null),
  ]);
}
