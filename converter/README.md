# prism2hlx — Prism 10 → Helix converter (standalone CLI)

Converts a Prism 10 `.prism` file to a Helix `.hlx` file, headless, from the
command line. No app, no Mac. This is the converter core that will later be
hooked into the Helix app (import `.prism`, work, save to `.hlx`); it also
stands alone.

## Usage

```sh
# from the repo root (after npm ci)
npm run convert -- converter ... # see converter/package.json scripts
# directly:
node --import tsx converter/src/cli.ts <input.prism> [output.hlx] [--json]
```

Setup: `npm ci` in the repo root AND in `converter/` — the converter
reuses Helix's own project-file code, so `npm run check` needs the root
`node_modules` (React/WebR types) as well as the converter's own
`@types/node`. The `convert` and `verify` commands run without the root
install; `check` does not.

- The input file is only ever read, never written (the CLI verifies its
  checksum before and after).
- The output is written with Helix's own `serializeProjectFile`, so it opens
  in Helix unchanged.
- `--json` prints the transfer report as JSON instead of text.

## What transfers

The field-by-field mapping is the spec in the vault:
`~/workspace/helix-vault/Research/Prism 10 to hlx mapping.md`

- **Tables:** all data sheets — values cell-exact, row titles, X values,
  summary subcolumns (mean/SD/N…) named, with a warning that they are
  summaries, not raw replicates.
- **Analyses:** the ones Helix offers, with parameters (nonlinear-regression
  4PL, survival log-rank in the demo file). Anything else is named in the
  report as not yet supported — never silently dropped, never faked.
  Fitted results are NOT carried: Helix recomputes every analysis from the
  table when the file opens.
- **Graphs and layouts:** NOT transferred — Prism stores them in an
  undocumented binary blob (`data.bin`, magic `PCFFGRA4`). They are listed
  in the report; re-create them in Helix.
- **Info sheets:** not transferred (Helix has no info sheet).

## Verify

```sh
node --import tsx converter/tests/verify.ts          # demo file: 22 checks
npm run verify-corpus                                # 66-file public corpus: 510 checks
PRISM_TEST_CORPUS_PRISM10=~/workspace/helix/test-corpus-synthetic npm run verify-corpus
                                                     # 6 synthetic edge cases: 41 checks
npm test                                             # abstract unit suites: 326 checks
```

`verify.ts` converts the public demo file (`prism2R-demo_dataset.prism`,
Mansi's files are never test material), checks every table cell-by-cell
against its source CSV, checks the analysis nodes, round-trips the output
through Helix's own `parseProjectFile`, and prints PASS/FAIL per check with
exact figures. Corpus path defaults to `~/workspace/helix/test-corpus`;
override with `PRISM_TEST_CORPUS`.

`verify-corpus.ts` runs every `.prism` in a corpus directory through the
same checks, plus a CLI check (C0: a good file converts, exit 0; a bad
file is refused, exit 1; a write failure is a plain-language error, not a
stack), a source-untouched checksum (C7), a values-clean check (C8: no
stray carriage return or unconverted comma leaks into the `.hlx`), and an
alignment check (C9: every converted table's layout accounts for each
dataset's columns exactly once and never consumes more than the file's
declared columns). Corpus path defaults to
`~/workspace/helix/test-corpus-prism10`; override with
`PRISM_TEST_CORPUS_PRISM10`. The C3/C4 expectations come from
`tests/layout-spec.ts` — an independent implementation of the vault spec,
not the converter's walk — so a converter bug that shifts a column fails
here as wrong values instead of being agreed with.

## Test corpus

Public files only — Mansi's files are never test material.

### Public corpus — `~/workspace/helix/test-corpus-prism10/` (66 files, 510/510 checks)

All 66 files are committed in this repo at `test-corpus-prism10/` — per-file sources and licenses: `test-corpus-prism10/LICENSES.md`. The source links below are the original downloads.

| File | Source | What it covers |
|---|---|---|
| `no_analysis.prism` (31 KB) | prism2R test data — https://github.com/Biomiha/prism2R (`inst/extdata/.for_testing/`) | 2 tables, 0 analyses; Prism 10.4.1.532 |
| `empty.prism` (194 bytes) | prism2R test data (same repo) | ZIP with 1 entry, no `document.json` — expected reject, exit 1 |
| `survival-zenodo-19717603.prism` (191 KB) | Zenodo record 19717603 | 3 tables, 7 SURVIVAL analyses — survival date X (start/end dates → durations) |
| `elisa-standard-curves-zenodo-21038547.prism` (1.5 MB) | Zenodo record 21038547 | 12 tables, 20 analyses incl. 6× 4PL + 6× INTERPOLATION — rich-text titles, XY tables with row titles |
| `dose-curve-zenodo-15257821.prism` (284 KB) | Zenodo record 15257821 | 3 tables, 5 analyses — column tables with no row titles, rich-text titles |
| `one-phase-decay-zenodo-21936291.prism` (2.35 MB) | Zenodo record 21936291 | 42 tables, 84 analyses (42× AREA_UNDER_CURVE + 42× One phase decay) — scale test, 168 orphan result-view sheets correctly ignored |
| `figure1-analysis-zenodo-8356786.prism` (861 KB) | Zenodo record 8356786 | 12 tables, 24 analyses (NORMALITY_TESTS + t-tests) |
| `senolytics-25hc-zenodo-15875512.prism` (127 KB) | Zenodo record 15875512 | 9 tables, 4 analyses |
| `single-case-zenodo-10616381.prism` (143 KB) | Zenodo record 10616381 | 9 tables, 0 analyses — largest single table in the corpus |
| `dilution-analysis-zenodo-22981103.prism` (40 MB) | Zenodo record 22981103 | 31 tables, 40 analyses — error-bar X (value + error subcolumns) |
| `violin-plots-zenodo-16883557.prism` (112 KB) | Zenodo record 16883557 | 12 tables, 0 analyses — column tables with no row titles |
| `cdv-experiments-zenodo-8347134.prism` (33 KB) | Zenodo record 8347134 | 1 table, 0 analyses |
| `dimensional-analysis-zenodo-8347134.prism` (449 KB) | Zenodo record 8347134 | 3 tables, 9 analyses — first `Line` equation in the wild |
| `figure-2-analysis-file-zenodo-8356786.prism` (980 KB) | Zenodo record 8356786 | 12 tables, 24 analyses |
| `figure-3-analysis-file-zenodo-8356786.prism` (664 KB) | Zenodo record 8356786 | 6 tables, 12 analyses |
| `figure-4-analysis-file-zenodo-8356786.prism` (154 KB) | Zenodo record 8356786 | 9 tables, 12 analyses — **first contingency table + first parts_of_whole tables** in the corpus |
| `mefs-vps35-wt-and-d620n-with-chx-mg-132-pic-8-and-12-hrs-zenodo-8385479.prism` (200 KB) | Zenodo record 8385479 | 3 tables, 8 analyses |
| `quantitation-of-gfp-lrrk2-and-tmem192-3ha-colocalisation-vps-zenodo-8385479.prism` (27 KB) | Zenodo record 8385479 | 1 table, 1 analysis |
| `prism-data-chinese-version-zenodo-10189403.prism` (140 KB) | Zenodo record 10189403 | 3 tables, 0 analyses — **Chinese-language template** (Prism 10.0.2.232) |
| `angley-summary-graph-zenodo-10616381.prism` (13 KB) | Zenodo record 10616381 | 1 table, 0 analyses |
| `20240619-collection-manuscript-endosymbioses-zenodo-12189101.prism` (506 KB) | Zenodo record 12189101 | 18 tables, 11 analyses — contingency table; grouped table with no `replicatesCount` |
| `capsanoicids-241121-pn-zenodo-14204350.prism` (10 MB) | Zenodo record 14204350 | 12 tables, 150 analyses — largest analysis count in the corpus (132 converted nodes) |
| `fig-1d-e-and-fig-s1e-04-25-zenodo-15257821.prism` (216 KB) | Zenodo record 15257821 | 22 tables, 0 analyses |
| `fig-3c-right-zenodo-15257821.prism` (13 KB) | Zenodo record 15257821 | 1 table, 0 analyses |
| `fig-3d-right-zenodo-15257821.prism` (50 KB) | Zenodo record 15257821 | 1 table, 0 analyses |
| `fig-5c-fig-6b-and-figs6-zenodo-15257821.prism` (1.3 MB) | Zenodo record 15257821 | 86 tables, 0 analyses — most tables in one file |
| `fig-7c-right-zenodo-15257821.prism` (1.1 MB) | Zenodo record 15257821 | 4 tables, 4 analyses |
| `fig-7d-zenodo-15257821.prism` (118 KB) | Zenodo record 15257821 | 3 tables, 6 analyses |
| `fig-7e-zenodo-15257821.prism` (50 KB) | Zenodo record 15257821 | 1 table, 1 analysis |
| `fig-8a-zenodo-15257821.prism` (37 KB) | Zenodo record 15257821 | 4 tables, 0 analyses |
| `fig-s3b-zenodo-15257821.prism` (11 KB) | Zenodo record 15257821 | 1 table, 0 analyses |
| `fig-s7b-zenodo-15257821.prism` (196 KB) | Zenodo record 15257821 | 3 tables, 0 analyses |
| `opossum-danielle-zenodo-15285264.prism` (193 KB) | Zenodo record 15285264 | 3 tables, 5 analyses — grouped table with no `replicatesCount` |
| `c2c12kd-transfer-zenodo-15723625.prism` (154 KB) | Zenodo record 15723625 | 8 tables, 4 analyses |
| `canna-cannb-senolytics-assay-zenodo-15875512.prism` (142 KB) | Zenodo record 15875512 | 8 tables, 6 analyses |
| `1f-zenodo-16883557.prism` (10 KB) | Zenodo record 16883557 | 1 table, 0 analyses |
| `3e-zenodo-16883557.prism` (28 KB) | Zenodo record 16883557 | 1 table, 1 analysis |
| `4b-f-zenodo-16883557.prism` (42 KB) | Zenodo record 16883557 | 5 tables, 0 analyses |
| `sup3b-zenodo-16883557.prism` (25 KB) | Zenodo record 16883557 | 3 tables, 0 analyses |
| `sup5a-zenodo-16883557.prism` (16 KB) | Zenodo record 16883557 | 1 table, 0 analyses |
| `b-domain-paper-ic50-graphs-corrected-dilution-zenodo-17489262.prism` (131 KB) | Zenodo record 17489262 | 4 tables, 5 analyses |
| `b-domain-paper-serum-elisa-figures-compiled-zenodo-17489262.prism` (1.7 MB) | Zenodo record 17489262 | 11 tables, 94 analyses — first `log(agonist) vs. response` equations (90 converted nodes) |
| `halo-data-graphs-zenodo-17583211.prism` (150 KB) | Zenodo record 17583211 | 9 tables, 0 analyses |
| `cloud-verification-mdp-zenodo-17746477.prism` (3.5 KB) | Zenodo record 17746477 | **Not GraphPad at all** — PRISM model-checker file, same extension; expected reject (not a ZIP) |
| `figure-1-zenodo-18623500.prism` (132 KB) | Zenodo record 18623500 | 6 tables, 2 analyses |
| `figure-2-zenodo-18623500.prism` (71 KB) | Zenodo record 18623500 | 2 tables, 1 analysis |
| `figure-3-zenodo-18623500.prism` (36 KB) | Zenodo record 18623500 | 1 table, 1 analysis |
| `figure-4-zenodo-18623500.prism` (166 KB) | Zenodo record 18623500 | 15 tables, 11 analyses |
| `figure-5-zenodo-18623500.prism` (123 KB) | Zenodo record 18623500 | 6 tables, 6 analyses |
| `figure-6-zenodo-18623500.prism` (184 KB) | Zenodo record 18623500 | 7 tables, 3 analyses — `\r` multi-line row titles; grouped table with no `replicatesCount` |
| `figure-7-zenodo-18623500.prism` (154 KB) | Zenodo record 18623500 | 5 tables, 5 analyses |
| `figure-s2-zenodo-18623500.prism` (260 KB) | Zenodo record 18623500 | 15 tables, 3 analyses |
| `figure-s3-zenodo-18623500.prism` (270 KB) | Zenodo record 18623500 | 6 tables, 0 analyses |
| `figure-s4-zenodo-18623500.prism` (301 KB) | Zenodo record 18623500 | 10 tables, 10 analyses — `\r` multi-line row titles |
| `figure-s5-zenodo-18623500.prism` (293 KB) | Zenodo record 18623500 | 9 tables, 10 analyses — `\r` multi-line row titles |
| `figure-s6-zenodo-18623500.prism` (325 KB) | Zenodo record 18623500 | 12 tables, 7 analyses |
| `figure-s7-zenodo-18623500.prism` (491 KB) | Zenodo record 18623500 | 18 tables, 11 analyses |
| `prism-file-marelli-et-al-zenodo-20311470.prism` (623 KB) | Zenodo record 20311470 | 11 tables, 7 analyses — first `log(inhibitor) vs. response` equation (analysis with no input sheet, warned + left out); grouped table with no `replicatesCount` |
| `plasmin-activity-assay-curve-and-analysis-zenodo-21038547.prism` (432 KB) | Zenodo record 21038547 | 6 tables, 19 analyses — first `Second order polynomial (quadratic) ` equation (trailing space) |
| `sirna-pai-1-manuscript-data-zenodo-21038547.prism` (475 KB) | Zenodo record 21038547 | 55 tables, 0 analyses |
| `lymph-study-plasma-auc-zenodo-21936291.prism` (154 KB) | Zenodo record 21936291 | 12 tables, 12 analyses |
| `oral-auc-unesterified-esterified-zenodo-21936291.prism` (337 KB) | Zenodo record 21936291 | 24 tables, 24 analyses |
| `figure-4abc-zenodo-22933325.prism` (56 KB) | Zenodo record 22933325 | 3 tables, 3 analyses — **Prism 11.1.0.224** (formatVersion 1-6-1); converts cleanly |
| `figure-5d-zenodo-22933325.prism` (33 KB) | Zenodo record 22933325 | 1 table, 1 analysis — **Prism 11.1.0.224**; converts cleanly |
| `figure-6d-zenodo-22933325.prism` (41 KB) | Zenodo record 22933325 | 1 table, 1 analysis — **Prism 11.1.0.224**; converts cleanly |
| `energy-system-zenodo-23184357.prism` (1.4 KB) | Zenodo record 23184357 | **Not GraphPad at all** — PRISM model-checker file, same extension; expected reject (not a ZIP) |

Results (2026-11-10, round 3): **510/510 checks pass** — 9,528,251 cells compared across the
corpus, 0 mismatches; 288 analysis nodes converted (4PL both X conventions,
log(agonist)/log(inhibitor) variable slope, one-phase decay, Line, quadratic —
plus survival), 375 named as unsupported; every source file's checksum unchanged.
Prism versions in the corpus: 10.0.0–10.6.1 plus 11.1.0.224 (3 files).

### Synthetic corpus — `~/workspace/helix/test-corpus-synthetic/` (6 files, 41/41 checks)

Committed in this repo at `test-corpus-synthetic/` (provenance: `test-corpus-synthetic/NOTICE.md` — derived from the MIT-licensed prism2R demo file).

Built by `npm run make-synthetic` (`tests/make-synthetic.ts`) from the
public demo file — each is one deliberate mutation, labelled `synthetic-`,
never written by Prism:

| File | Edge case | Expected behaviour |
|---|---|---|
| `synthetic-empty-table.prism` | First table has 0 rows | Table left out with a warning; other 13 convert; its 4PL analysis left out (input table missing) |
| `synthetic-crlf-unicode.prism` | CRLF line endings; unicode titles ("Café — αβγ ☃") | Values byte-identical to the demo; titles survive |
| `synthetic-missing-dataset.prism` | One dataset JSON deleted | Warning; table converts without that dataset's columns |
| `synthetic-graphs-only.prism` | No data sheets at all | Refused cleanly, exit 1 — a `.hlx` with no tables is one Helix itself can't open |
| `synthetic-unknown-analysis.prism` | 4PL analysis relabelled `SOMETHING_NEW` | Named as unsupported, never faked |
| `synthetic-comma-decimal.prism` | Numbers as quoted comma decimals (`"45,5"`) | Converted to plain decimals (`45.5`) in the `.hlx` |

## Bugs found by the corpus (2026-11-10, all fixed + regression-checked)

- **Row-title rule was wrong (value corruption).** The converter assumed
  "not XY ⇒ row titles". Real files break that both ways (column tables
  with no row titles; XY tables with empty ones). Now: a CSV has a
  row-title column iff `table.rowTitlesDataSet` is present.
- **X datasets can have multiple subcolumns (value corruption).** The
  converter read exactly one X column, shifting every dataset after it.
  Now all X subcolumns are consumed; a survival date X becomes durations
  in days, otherwise the first subcolumn is kept and the rest are named
  in a warning.
- **Titles can be rich-text objects.** Dataset/X/sheet/analysis titles are
  sometimes `{ string, version, formatting }`, not strings. Now the
  `.string` field is used; a title never becomes "[object Object]".
- **A file with no data tables** used to produce a `.hlx` Helix's own
  parser rejects. Now the converter refuses it cleanly, exit 1.

## Bugs found by the corpus, round 2 (2026-11-10 — 55 new files, all fixed + regression-checked)

- **`\r` inside quoted fields is a real line break, not a leak (value
  corruption).** Prism writes multi-line row titles with `\r` as the
  break, inside a quoted CSV field ("BACE-I \r& DOX", "WT\r(3 weeks)") and
  in JSON titles ("Nonlin fit of 15-HEPE-d5\r A"). The converter passed it
  through raw, which C8 rightly flags. Now `cleanText` normalises the
  break to one space, collapsing surrounding whitespace ("BACE-I & DOX",
  "WT (3 weeks)"); the verifier rebuilds expectations with the same rule.
- **Grouped tables can omit `replicatesCount`.** Four files carry no
  `replicatesCount` on grouped tables (marelli, opossum, endosymbioses,
  figure-6) — the count lives only in each dataset's `replicates` array.
  The converter already fell back to the per-dataset count; the verifier's
  expectation used the raw field (`undefined`) and failed. The verifier now
  uses the same fallback, and the vault spec records it.
- **Six more nonlinear equations map exactly onto Helix models.** The
  corpus showed the converter leaving 52 analyses unconverted that Helix
  already offers: "One phase decay" → `one-phase-decay` (42 analyses;
  formula and terms match Helix's modelSpec exactly),
  "log(agonist)/log(inhibitor) vs. response -- Variable slope (four
  parameters)" → `sigmoidal-4pl-logx` (9 analyses; Prism's
  `Y=Bottom+(Top-Bottom)/(1+10^((LogEC50-X)*HillSlope))` is Helix's logx
  fit), "Line" → `line`, "Second order polynomial (quadratic)" →
  `quadratic`. Equation names are trimmed before lookup — Prism writes the
  quadratic name with a trailing space. C5 now checks the converted node
  carries the right model, not just the right name.
- **An analysis can have no input sheet at all.** Marelli's "Nonlin fit"
  has `inputSheets: []` (never run, no input recorded) — the converter
  warns and leaves it out, whatever its equation. C5's non-4PL branch
  didn't accept that warning; it does now.
- **`.prism` is also the PRISM model checker's extension.** Two Zenodo
  files (`cloud-verification-mdp`, `energy-system`) are model-checker
  text, not GraphPad. The converter refuses them cleanly (not a ZIP) and
  they are now expected-reject regression tests.
- **Prism 11 files convert.** Three files written by Prism 11.1.0.224
  (formatVersion 1-6-1) pass all checks — the converter is not
  version-gated, and the corpus proves it.

## Bugs found by the review sweep, round 3 (2026-11-10 — read-only review, all fixed + regression-checked)

- **A missing dataset JSON mid-table shifted every later dataset (B1).**
  The load loop warned and dropped the missing dataset but never
  advanced the CSV cursor past its columns. Now the layout is resolved
  up front: a missing dataset is skipped by the table's
  `replicatesCount` (`y_replicates`) or its `dataFormat`'s fixed shape,
  or inferred from `content.json`'s `numberOfColumns` when it is the
  only unknown; two or more unknowns (or an inference that doesn't fit
  the declared width) refuses the table with a warning that says what
  actually happened. The old warning ("its columns were left out") was
  false and is gone.
- **A missing X dataset JSON shifted every Y value (B2).** The fallback
  `xCount = 1` was wrong for an error-bar X (value + error). Now the X
  count is inferred from the declared columns, or the table is refused.
- **A malformed `replicate ranges` silently yielded 0 subcolumns (B3).**
  An unparseable range (`"abc"`) or a reversed one (`"2~0"`) now makes
  the dataset's count unknown — inferred from the dims, or the table is
  refused — with a warning naming the bad range. The unit-suite pin
  that called "ranges bad value → 0 subcolumns" intended behaviour was
  part of the bug and is fixed.
- **Survival durations were wrong across DST and with mixed date forms
  (M1).** ISO datetimes parsed as local midnight but date-only strings
  as UTC midnight, so a 7-day span across US DST start came out 6.958
  days under America/Los_Angeles. Every date form now parses as UTC,
  one frame; a slash date whose first component is over 12 reads as
  DD/MM. The unit suite runs under both UTC and
  `TZ=America/Los_Angeles` so this class can't hide again. A survival X
  whose `dateTimeConversion.units` isn't Days is warned about (m1).
- **The verifier mirrored the converter (M2).** It built expectations
  from the same filtered `sets` list and the same `xCount = 1`
  fallback, so the 446/446 corpus result couldn't see B1/B2/B3. The
  expectations now come from `tests/layout-spec.ts` — an independent
  implementation of the vault spec — and a new C9 alignment check
  verifies every dataset's columns are accounted for exactly once.
  Proof: three probe files (mid-table missing dataset, missing
  multi-subcolumn X, malformed range) pass under the new verifier +
  new converter, fail under the new verifier + old converter, and pass
  under the old verifier + old converter — the old verifier was blind
  to all three shifts.
- **Also fixed:** a CSV shorter than `numberOfRows` is still padded
  with null rows, but now warns (M3); a supported analysis with zero
  `inputDataSets` is warned about by name instead of silently dropped
  (M4); a leading BOM is stripped in `parseCsv` (M5); the orphan /
  unreferenced scan matches any UID shape, not just UUIDs (m3); a CLI
  `writeFile` failure is a plain-language error, not a stack (m4);
  whitespace-only cells are empty and lone `\n` breaks collapse like
  `\r` (m5); commas are thousands separators file-wide when any value
  has 2+ comma groups, else a single comma is a decimal (m6); the C0
  probe runs with CWD = the converter dir (m7); the demo `verify.ts`
  builder is ported to the current spec (m8).
## Unit tests (abstract layer)

Real files only sample the input space, so the converter is also tested
against the input model itself — minimal `.prism` buffers built in
memory, fed straight to `convertPrism`, with every combination of the
dimensions below pinned:

```sh
npm test            # tests/unit.ts + tests/unit-helpers.ts — 326 checks
```

- `tests/unit.ts` — `convertPrism` over in-memory files. Dimensions:
  A table format × data format (9 × 12 = 108); B row titles × format;
  C title shape (plain / rich-text / missing / empty / number) ×
  location (sheet / dataset / X / analysis) + sheet-attributes-map
  titles; D X shape (absent / 1–3 subcolumns / survival date ISO+US /
  unparseable / missing JSON); E Y cell values (empty / text /
  scientific / comma-decimal / unicode / …); F subcolumn source
  (`replicates` / `replicate ranges` / table fallback) × data format;
  G dataset presence; H analysis class × input state; I project-level
  rejects; J `content.json` shape; K orphan/unreferenced tables;
  L CSV text shape (CRLF, quoted fields, embedded line breaks in row
  titles, whitespace-only cells); M review regressions (B1/B2/B3/M1/
  m1/M5/m6). Every successful conversion is also round-tripped through
  Helix's own `parseProjectFile`, so a case that converts but produces
  a `.hlx` Helix rejects still fails.
- `tests/unit-helpers.ts` — the pure helpers directly: `plainTitle`,
  `parsePrismDate`, `daysBetween`, `subcolumnNames`, `replicateCount`,
  `replicateRangeProblems`.
  These are exported from `src/prism.ts` for the tests only (marked in
  the source); the converter uses them internally and nothing else
  should import them. Tests go through the exported surface — no
  test-only backdoors into production code. Run the suite under both
  UTC and `TZ=America/Los_Angeles`: the DST date pins only fail on a
  local-time parser under a non-UTC timezone.
- `tests/build-prism.ts` — the in-memory `.prism` builder the suite
  uses. Test UIDs are hex-only (`A0000001`, …) by convention; the
  converter's orphan scan matches any path segment, so a non-UUID test
  UID is counted too.
- `tests/unit.ts` has a `product2` combinatorial generator: a new
  dimension value is one list entry, not a new test file.

### Regression verification

The four corpus bugs (commit 13c75c2) are regression tests named
`REGRESSION R1–R4` in `tests/unit.ts`. They were verified against the
pre-fix converter (run the suite with `converter/src/prism.ts`
replaced by `git show 13c75c2^:converter/src/prism.ts`): 66/226 pass
and all 160 failures map to R1–R4 — the row-title rule (R1: every
non-XY matrix case shifts by one), multi-subcolumn X and survival
dates (R2), title unwrapping plus the empty/missing-title fallback
(R3, including `"[object Object]"` column names), and the no-tables
refusal (R4). Nothing else fails on the old code, so the suite pins
exactly the fixed behaviour. The helper tests can't run against the
old code (the helpers weren't exported then); R3's helpers are covered
there by the convert-level tests, which do fail on the old code.

The review-sweep regressions (commit 4383421) are named `REGRESSION`
in section M of `tests/unit.ts` (B1/B2/B3/M1/m1/M5/m6) and in the
updated pins of sections F/G/H/J/K/L. Verified against the pre-fix
converter (`git stash push converter/src/`, run, `git stash pop`):
225/244 pass under UTC and 224/244 under `TZ=America/Los_Angeles` —
the 19 failures under UTC are exactly the new/updated pins (the B1
shifts show C reading B's values, B2 shows A reading the X-error
column, B3 shows an X-only table where A should be, m6 shows
`"1,234,567"` left as text and `"45,5"` → `"45.5"`), and the 20th
failure under LA is the M1 DST case (`6.958333` instead of `7`). The
helper DST/DD/MM pins were verified the same way against the pre-fix
`parsePrismDate`/`daysBetween` (all 6 fail under LA: ISO/US off by
the UTC offset, DD/MM null, DST `6.958333`/`7.041667`, mixed forms
`0.291667`).

### Known behaviour pinned by the suite (not bugs to fix silently)

- A comma in a number reads by the file's own values: if any cell in
  the file holds a number with two or more comma digit-groups
  (`"1,234,567"`), commas are thousands separators file-wide and are
  stripped (`"1,234"` → `1234`); otherwise a single comma is a decimal
  separator (`"45,5"` → `45.5`, and `"1,234"` → `1.234`). Prism records
  no locale, so the file's values decide; the rule is pinned, not
  changed silently.
- An embedded line break inside a quoted row title (Prism writes
  multi-line titles with a bare CR) becomes one space — Helix labels
  are single-line, so `cleanText` collapses the break (and a lone
  `\n` too) with surrounding whitespace. A value that is only
  whitespace becomes empty, never a stray space. The corpus verifier's
  C8 check flags any `\r` or `\n` surviving into the `.hlx` as a
  possible CSV leak.

## Layout

- `src/prism.ts` — the converter core (ZIP + `document.json` + CSVs → `.hlx` project + transfer report).
- `src/csv.ts` — small CSV reader (quoted fields, CRLF/LF).
- `src/cli.ts` — command-line entry.
- `tests/verify.ts` — headless verification against the demo file.
- `tests/verify-corpus.ts` — multi-file verification over a corpus directory (see above).
- `tests/layout-spec.ts` — the independent layout + expectation builder
  the verifiers use (M2): same spec as the converter, written
  separately from it, so the verifiers can't agree with a converter bug.
- `tests/make-synthetic.ts` — builds the synthetic edge-case corpus from the demo file.
- `tests/build-prism.ts` — builds minimal `.prism` buffers in memory for the unit tests.
- `tests/unit.ts` — abstract-layer unit tests for `convertPrism` (permutation suite).
- `tests/unit-helpers.ts` — direct unit tests for the pure helpers.
