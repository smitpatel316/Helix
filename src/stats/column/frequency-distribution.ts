// "Frequency distribution" (Prism's Column-table frequency distribution) —
// each data column binned independently, reporting per bin the count, relative
// frequency and cumulative frequency, with a histogram graph. Pure TypeScript,
// no R: the counting is trivial arithmetic, and the auto breaks are R's pretty()
// breaks, reimplemented here and checked against R (see tests/reference.ts) —
// so the graph, which draws from the same function, can never disagree with
// the analysis.
//
// Bin-edge rule (pinned, tested, stated in `notes`): bins are left-closed
// [lower, upper), except the last bin, which is closed on both sides so the
// maximum is always counted. A value sitting exactly on an edge goes into the
// bin above it (except the maximum, which stays in the last bin). Empty bins
// are shown with count 0, never dropped.
//
// Binning modes: "auto" uses Sturges' count with R's pretty() breaks;
// "width" steps by the chosen width from `startAt` (default: the data minimum)
// until the maximum is covered; "count" splits the pretty-rounded range into
// the requested number of equal bins, so the edges stay readable.
import type {
  AnalysisOutcome,
  Column,
  FrequencyBinRow,
  FrequencyBins,
  FrequencyDistributionParams,
  StatRow,
} from "../types";
import { dataGroups, describe } from "./base";

/** Sturges' rule: the number of bins R's `nclass.Sturges` asks for. */
export function sturgesCount(n: number): number {
  return Math.ceil(Math.log2(n)) + 1;
}

/**
 * R's `pretty()` break points for [lo, hi] asking for about `n` intervals
 * (what `hist()` uses: `pretty(range(x), n = nclass.Sturges(x), min.n = 1)`).
 * The step is the smallest 1/2/5 × 10^k with the target cell size at most
 * 1.4× the step — pinned against R over a battery of ranges (see
 * tests/reference.ts), including the exact 1.4 boundary (a target of exactly
 * 1.4 takes the smaller step; 1.401 takes the larger). `pretty()` may return
 * fewer intervals than asked for (e.g. 4 for Sturges' 5 on 2.1–9.3): that is
 * R's behaviour, not a bug.
 */
export function prettyBreaks(lo: number, hi: number, n: number): number[] {
  const target = (hi - lo) / Math.max(n, 1);
  const base = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].map((m) => m * base).find((s) => target <= 1.4 * s) ?? 10 * base;
  // R treats a ratio a hair's breadth from a whole number as that number
  // (0.3 / 0.1 is 2.9999999999999996 in doubles, yet pretty() starts at 0.3):
  // round the ratio to 12 significant digits before flooring/ceiling.
  const ratio = (v: number) => Number((v / step).toPrecision(12));
  const start = Math.floor(ratio(lo)) * step;
  const end = Math.ceil(ratio(hi)) * step;
  const intervals = Math.round((end - start) / step);
  return Array.from({ length: intervals + 1 }, (_, i) => clean(start + i * step));
}

/** Smallest 1/2/5 × 10^k that is at least `width` (Prism-style readable width). */
export function niceWidthUp(width: number): number {
  if (!(width > 0) || !Number.isFinite(width)) return 1;
  const base = 10 ** Math.floor(Math.log10(width));
  const m = width / base;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * base;
}

/** `value` floored to a multiple of `width`. */
export function floorToWidth(value: number, width: number): number {
  return clean(Math.floor(value / width) * width);
}

/** A number without float dust (6.800000000000001 → 6.8), for edges and labels. */
const clean = (v: number): number => Number(v.toPrecision(12));

const fmt = (v: number): string => String(clean(v));

/** The bin edges for `values` under `params` (cleaned, covering the full range). */
function binEdges(values: number[], p: FrequencyDistributionParams): {
  edges: number[];
  binWidth: number;
  requestedBins?: number;
} {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return { edges: [min, max], binWidth: 0 };
  if (p.binMode === "width") {
    const width = p.binWidth!;
    const start = Math.min(p.startAt ?? min, min);
    const edges = [clean(start)];
    while (edges.at(-1)! < max) edges.push(clean(edges.at(-1)! + width));
    return { edges, binWidth: width };
  }
  if (p.binMode === "count") {
    // Split the pretty range into `count` equal bins: pretty() rounds the
    // data range out to readable bounds (2.1–9.3 becomes 2–10), so the edges
    // stay readable instead of ending on the raw maximum (9.3). This is the
    // plan's case B: 5 bins over 2–10, width 1.6, edges 2, 3.6, …, 10.
    const count = p.binCount!;
    const pretty = prettyBreaks(min, max, count);
    const start = Math.min(p.startAt ?? pretty[0], min);
    const end = pretty.at(-1)!;
    const width = (end - start) / count;
    const edges = Array.from({ length: count + 1 }, (_, i) => clean(start + i * width));
    edges[count] = end;
    return { edges, binWidth: width };
  }
  const k = sturgesCount(values.length);
  return { edges: prettyBreaks(min, max, k), binWidth: 0, requestedBins: k };
}

/** One column's bins, counted left-closed with the last bin closed. Shared by
 *  the runner and the histogram graph, so the two can never disagree. */
export function computeFrequencyBins(
  values: number[],
  params: FrequencyDistributionParams | undefined,
): { bins: FrequencyBinRow[]; binWidth: number; requestedBins?: number; edges: number[] } {
  const p = { binMode: "auto", ...params } as FrequencyDistributionParams;
  const n = values.length;
  const { edges, binWidth, requestedBins } = binEdges(values, p);
  const width = edges.length > 1 ? edges[1] - edges[0] : 0;
  const counts = new Array<number>(edges.length - 1).fill(0);
  for (const v of values) {
    // Equal-width edges: the index is arithmetic, with the maximum clamped
    // into the last (closed) bin. A value exactly on an edge goes above it.
    const i = width > 0 ? Math.min(Math.floor((v - edges[0]) / width), counts.length - 1) : 0;
    counts[Math.max(i, 0)]++;
  }
  let cumulative = 0;
  const bins: FrequencyBinRow[] = counts.map((count, i) => {
    cumulative += count;
    const lower = edges[i];
    const upper = edges[i + 1];
    const last = i === counts.length - 1;
    return {
      bin: last ? `${fmt(lower)} to ${fmt(upper)}` : `${fmt(lower)} to <${fmt(upper)}`,
      lower,
      upper,
      count,
      relativeFrequency: count / n,
      cumulativeCount: cumulative,
      cumulativeFrequency: cumulative / n,
    };
  });
  return { bins, binWidth: binWidth || (edges.length > 1 ? edges[1] - edges[0] : 0), requestedBins, edges };
}

/** How many of a column's cells hold text instead of a number (blank cells don't count). */
const skippedCells = (column: Column): number =>
  column.cells.filter((c, r) => c != null && c.trim() !== "" && column.byRow[r] == null).length;

export async function runFrequencyDistribution(
  columns: Column[],
  params: FrequencyDistributionParams | undefined,
): Promise<AnalysisOutcome> {
  const p = { binMode: "auto", ...params } as FrequencyDistributionParams;
  if (p.binMode === "width" && (p.binWidth == null || !Number.isFinite(p.binWidth) || p.binWidth <= 0)) {
    return { error: "Bin width must be greater than 0." };
  }
  if (p.binMode === "count" && (p.binCount == null || !Number.isInteger(p.binCount) || p.binCount < 2)) {
    return { error: "Number of bins must be a whole number of at least 2." };
  }
  if (p.binMode === "count" && p.binCount! > 10000) {
    return { error: "Number of bins must be at most 10,000." };
  }
  const groups = dataGroups(columns);
  if (groups.length < 1) {
    return { error: "This needs at least 1 column containing numeric data." };
  }
  const perColumn: { column: Column; bins: FrequencyBins; binWidth: number; requestedBins?: number; edges: number[]; skipped: number }[] = [];
  for (const column of groups) {
    if (column.values.length < 2) {
      return { error: "Frequency distribution needs at least 2 values." };
    }
    if (
      p.binMode === "width" &&
      (Math.max(...column.values) - Math.min(p.startAt ?? Infinity, Math.min(...column.values))) / p.binWidth! > 10000
    ) {
      return { error: "Bin width is too small for this range (more than 10,000 bins)." };
    }
    const { bins, binWidth, requestedBins, edges } = computeFrequencyBins(column.values, p);
    perColumn.push({ column, bins: { column: column.name, bins }, binWidth, requestedBins, edges, skipped: skippedCells(column) });
  }

  const stats: StatRow[] = perColumn.flatMap(({ column, bins, binWidth }) => {
    const values = column.values;
    return [
      { label: `${column.name} — N`, value: values.length },
      { label: `${column.name} — Number of bins`, value: bins.bins.length },
      { label: `${column.name} — Bin width`, value: binWidth },
      { label: `${column.name} — Minimum`, value: Math.min(...values) },
      { label: `${column.name} — Maximum`, value: Math.max(...values) },
    ];
  });

  const notes = [
    "Bins are [lower, upper); the last bin includes the maximum, so no value is dropped.",
    ...perColumn.map(({ column, bins, binWidth, requestedBins, edges, skipped }) => {
      const min = Math.min(...column.values);
      const max = Math.max(...column.values);
      const parts: string[] = [];
      if (min === max) {
        parts.push(`“${column.name}”: all values are ${fmt(min)}, so there is a single bin.`);
      } else if (p.binMode === "auto") {
        parts.push(
          `“${column.name}”: automatic binning (Sturges' rule asks for ${requestedBins} bins; R's pretty() breaks give ${bins.bins.length}: ${edges.map(fmt).join(", ")}).`,
        );
      } else if (p.binMode === "width") {
        const start = edges[0];
        parts.push(
          `“${column.name}”: bin width ${fmt(p.binWidth!)}, first bin starts at ${fmt(start)}${bins.bins.length === 1 ? " — the width covers the whole range, so there is a single bin" : ""}.`,
        );
      } else {
        parts.push(
          `“${column.name}”: ${p.binCount} bins of width ${fmt(binWidth)}, first bin starts at ${fmt(edges[0])}.`,
        );
      }
      const empty = bins.bins.filter((b) => b.count === 0).length;
      if (empty) parts.push(`${empty} empty bin${empty === 1 ? "" : "s"} shown.`);
      if (skipped) parts.push(`${skipped} non-numeric cell${skipped === 1 ? "" : "s"} ignored.`);
      return parts.join(" ");
    }),
  ].join(" ");

  return {
    testType: "frequency-distribution",
    subtitle: "Frequency distribution",
    stats,
    groups: (await describe(groups)).groups,
    notes,
    frequencyBins: perColumn.map((c) => c.bins),
  };
}
