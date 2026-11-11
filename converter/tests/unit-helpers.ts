// Direct unit tests for the converter's pure helpers
// (tests/unit-helpers.ts).
//
//   npm run test:unit   (runs this file and tests/unit.ts)
//
// These test the abstract layer directly — no files, no ZIPs — so a
// behaviour is pinned at the smallest unit that owns it. The end-to-end
// behaviour (a whole .prism file through `convertPrism`) lives in
// tests/unit.ts; the real-file corpora live in tests/verify-corpus.ts.

import {
  daysBetween,
  parsePrismDate,
  plainTitle,
  replicateCount,
  replicateRangeProblems,
  subcolumnNames,
} from "../src/prism";

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail: string): void {
  checks++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) failures++;
}
function eq(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

// ── plainTitle ───────────────────────────────────────────────────────────
// Usually a string — but Prism sometimes writes a rich-text object
// { string, version, formatting }. Anything else is "" and the caller's
// fallback applies. It must NEVER return "[object Object]".
for (const [label, input, want] of [
  ["plain string", "Dose", "Dose"],
  ["rich-text object", { string: "Dose", version: 1, formatting: {} }, "Dose"],
  ["rich-text, empty string", { string: "", version: 1 }, ""],
  ["rich-text, no string field", { version: 1, formatting: {} }, ""],
  ["rich-text, non-string field", { string: 5 }, ""],
  ["null", null, ""],
  ["undefined", undefined, ""],
  ["number", 42, ""],
  ["empty object", {}, ""],
  ["array", ["Dose"], ""],
] as [string, unknown, string][]) {
  const got = plainTitle(input);
  check(`plainTitle ${label}`, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  if (typeof got === "string") {
    check(`plainTitle ${label} never "[object Object]"`, !got.includes("[object Object]"), JSON.stringify(got));
  }
}

// ── parsePrismDate ───────────────────────────────────────────────────────
// ISO ("2024-09-06 00:00:00") or US ("12/17/2024"). Anything else is null.
// Every shape reads as UTC — one frame, whatever the machine's timezone
// (the old code read ISO datetimes as local time but date-only strings as
// UTC, so a DST-spanning gap came out short under America/Los_Angeles).
// A slash date whose first component is over 12 reads as DD/MM.
const ISO = Date.parse("2024-09-06T00:00:00Z");
const US = Date.parse("2024-12-17T00:00:00Z");
for (const [label, input, want] of [
  ["ISO with space", "2024-09-06 00:00:00", ISO],
  ["ISO with T", "2024-09-06T00:00:00", ISO],
  ["ISO date only", "2024-09-06", ISO],
  ["US month/day/year", "12/17/2024", US],
  ["US single digits", "1/2/2024", Date.parse("2024-01-02T00:00:00Z")],
  ["US with surrounding spaces", " 12/17/2024 ", US],
  ["DD/MM unambiguous", "13/02/2024", Date.parse("2024-02-13T00:00:00Z")],
  ["DD/MM end of year", "31/12/2024", Date.parse("2024-12-31T00:00:00Z")],
  ["DD/MM impossible stays null", "13/13/2024", null],
  ["empty string", "", null],
  ["null", null, null],
  ["garbage", "not-a-date", null],
  ["impossible date", "2024-13-40", null],
  ["year only", "2024", Date.parse("2024-01-01T00:00:00Z")],
] as [string, string | null, number | null][]) {
  const got = parsePrismDate(input);
  check(`parsePrismDate ${label}`, got === want, `got ${got}, want ${want}`);
}

// ── daysBetween ──────────────────────────────────────────────────────────
// Whole days as a plain integer string; fractions to 6 decimal places.
// The DST cases are the point: a 7-day span across a US clock change is
// exactly 7 only when both ends are read in the same frame (UTC). Under
// the old local-time parsing they came out 6.958333 / 7.041667 under
// America/Los_Angeles — so run this suite under a non-UTC TZ too.
for (const [label, start, end, want] of [
  ["ten days", "2024-01-01", "2024-01-11", "10"],
  ["one day", "2024-01-01", "2024-01-02", "1"],
  ["same day", "2024-01-01", "2024-01-01", "0"],
  ["negative gap", "2024-01-11", "2024-01-01", "-10"],
  ["half a day", "2024-01-01 00:00:00", "2024-01-01 12:00:00", "0.5"],
  ["DST spring forward", "2024-03-09 00:00:00", "2024-03-16 00:00:00", "7"],
  ["DST fall back", "2024-11-02 00:00:00", "2024-11-09 00:00:00", "7"],
  ["mixed forms same instant", "2024-09-06", "2024-09-06 00:00:00", "0"],
  ["null start", null, "2024-01-01", null],
  ["null end", "2024-01-01", null, null],
  ["unparseable start", "not-a-date", "2024-01-01", null],
  ["US dates", "01/01/2024", "01/11/2024", "10"],
] as [string, string | null, string | null, string | null][]) {
  const got = daysBetween(start, end);
  check(`daysBetween ${label}`, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ── subcolumnNames ───────────────────────────────────────────────────────
// One subcolumn keeps the bare title; summary formats name their parts
// only when the count matches exactly; anything else is Y_1..Y_n.
for (const [label, title, dataFormat, count, want] of [
  ["single replicate", "Dose", "y_replicates", 1, ["Dose"]],
  ["replicates", "Dose", "y_replicates", 3, ["Dose_1", "Dose_2", "Dose_3"]],
  ["mean/SD/N exact", "Dose", "y_sd_n", 3, ["Dose_MEAN", "Dose_SD", "Dose_N"]],
  ["mean/SD/N wrong count", "Dose", "y_sd_n", 2, ["Dose_1", "Dose_2"]],
  ["mean/SEM/N", "Dose", "y_se_n", 3, ["Dose_MEAN", "Dose_SEM", "Dose_N"]],
  ["mean/CV/N", "Dose", "y_cv_n", 3, ["Dose_MEAN", "Dose_CV", "Dose_N"]],
  ["mean/SD", "Dose", "y_sd", 2, ["Dose_MEAN", "Dose_SD"]],
  ["mean/SE", "Dose", "y_se", 2, ["Dose_MEAN", "Dose_SE"]],
  ["mean/CV", "Dose", "y_cv", 2, ["Dose_MEAN", "Dose_CV"]],
  ["plus/minus", "Dose", "y_plus_minus", 3, ["Dose_MEAN", "Dose_PLUSERROR", "Dose_MINUSERROR"]],
  ["high/low", "Dose", "y_high_low", 3, ["Dose_MEAN", "Dose_PLUSERROR", "Dose_MINUSERROR"]],
  ["single, no suffixes", "Dose", "y_single", 1, ["Dose"]],
  ["empty title falls back to Y", "", "y_sd_n", 3, ["Y_MEAN", "Y_SD", "Y_N"]],
  ["empty title, single", "", "y_replicates", 1, ["Y"]],
  ["unknown format", "Dose", "bogus", 2, ["Dose_1", "Dose_2"]],
  ["missing format", "Dose", "", 2, ["Dose_1", "Dose_2"]],
] as [string, string, string, number, string[]][]) {
  const got = subcolumnNames(title, dataFormat, count);
  check(`subcolumnNames ${label}`, eq(got, want), `got [${got.join(", ")}], want [${want.join(", ")}]`);
}

// ── replicateCount ───────────────────────────────────────────────────────
// `replicates` array wins; else the span of "replicate ranges"; else the
// table's replicatesCount; else 0. The arguments are object literals —
// they are assignable to the converter's own PrismDataSet / table shapes
// structurally, so no cast is needed. Note the "bad value" pin: the
// helper skips a bad range (count 0 for it). The converter never relies
// on that 0 for layout — it checks `replicateRangeProblems` first and
// treats a dataset with problems as unknown (see below). A helper that
// silently counts 0 is fine; a converter that lays out on it is not.
const repCases: [string, number][] = [
  ["replicates array", replicateCount({ replicates: [1, 2, 3] }, {})],
  ["replicates empty", replicateCount({ replicates: [] }, {})],
  ["ranges 0~2", replicateCount({ "replicate ranges": [{ range: "0~2" }] }, {})],
  ["ranges single", replicateCount({ "replicate ranges": [{ range: "0" }] }, {})],
  ["ranges 1~3", replicateCount({ "replicate ranges": [{ range: "1~3" }] }, {})],
  [
    "ranges two parts",
    replicateCount({ "replicate ranges": [{ range: "0~0" }, { range: "2" }] }, {}),
  ],
  ["ranges bad value ignored", replicateCount({ "replicate ranges": [{ range: "abc" }] }, {})],
  ["ranges empty", replicateCount({ "replicate ranges": [] }, {})],
  ["table fallback", replicateCount({}, { replicatesCount: 4 })],
  ["table fallback zero", replicateCount({}, { replicatesCount: 0 })],
  ["nothing anywhere", replicateCount({}, {})],
  [
    "replicates beat ranges",
    replicateCount({ replicates: [1], "replicate ranges": [{ range: "0~4" }] }, {}),
  ],
];
const repWant = [3, 0, 3, 1, 3, 2, 0, 0, 4, 0, 0, 1];
repCases.forEach(([label, got], i) => {
  check(`replicateCount ${label}`, got === repWant[i], `got ${got}, want ${repWant[i]}`);
});

// ── replicateRangeProblems ───────────────────────────────────────────────
// A dataset's "replicate ranges" are either clean or the dataset's count
// is unknown. Unparseable strings and reversed ranges are problems;
// anything well-formed is not, even across several ranges.
for (const [label, set, want] of [
  ["good ranges", { "replicate ranges": [{ range: "0~2" }] }, []],
  ["good single", { "replicate ranges": [{ range: "0" }] }, []],
  ["no ranges field", {}, []],
  ["empty ranges", { "replicate ranges": [] }, []],
  ["bad value", { "replicate ranges": [{ range: "abc" }] }, ["“abc” isn't a replicate range"]],
  ["reversed", { "replicate ranges": [{ range: "2~0" }] }, ["“2~0” is reversed (start after end)"]],
  [
    "mixed good and bad",
    { "replicate ranges": [{ range: "0~1" }, { range: "xx" }, { range: "5~3" }] },
    ["“xx” isn't a replicate range", "“5~3” is reversed (start after end)"],
  ],
  ["empty string range", { "replicate ranges": [{ range: "" }] }, ["“” isn't a replicate range"]],
] as [string, { "replicate ranges"?: { range: string }[] }, string[]][]) {
  const got = replicateRangeProblems(set);
  check(`replicateRangeProblems ${label}`, eq(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

console.log(`\n${checks - failures}/${checks} checks passed.`);
process.exit(failures ? 1 : 0);
