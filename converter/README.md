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
npm run verify-corpus                                # 11-file public corpus: 73 checks
PRISM_TEST_CORPUS_PRISM10=~/workspace/helix/test-corpus-synthetic npm run verify-corpus
                                                     # 6 synthetic edge cases: 36 checks
```

`verify.ts` converts the public demo file (`prism2R-demo_dataset.prism`,
Mansi's files are never test material), checks every table cell-by-cell
against its source CSV, checks the analysis nodes, round-trips the output
through Helix's own `parseProjectFile`, and prints PASS/FAIL per check with
exact figures. Corpus path defaults to `~/workspace/helix/test-corpus`;
override with `PRISM_TEST_CORPUS`.

`verify-corpus.ts` runs every `.prism` in a corpus directory through the
same checks, plus a CLI check (C0: a good file converts, exit 0; a bad
file is refused, exit 1), a source-untouched checksum (C7), and a
values-clean check (C8: no stray carriage return or comma-decimal text
leaks into the `.hlx`). Corpus path defaults to
`~/workspace/helix/test-corpus-prism10`; override with
`PRISM_TEST_CORPUS_PRISM10`.

## Test corpus

Public files only — Mansi's files are never test material.

### Public corpus — `~/workspace/helix/test-corpus-prism10/` (11 files, 73/73 checks)

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

Results (2026-11-10): **73/73 checks pass** — 26,623 cells compared across the
corpus, 0 mismatches; 10 analyses converted (4PL + survival), 163 named as
unsupported; every source file's checksum unchanged.

### Synthetic corpus — `~/workspace/helix/test-corpus-synthetic/` (6 files, 36/36 checks)

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

## Unit tests (abstract layer)

Real files only sample the input space, so the converter is also tested
against the input model itself — minimal `.prism` buffers built in
memory, fed straight to `convertPrism`, with every combination of the
dimensions below pinned:

```sh
npm test            # tests/unit.ts + tests/unit-helpers.ts — 295 checks
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
  titles). Every successful conversion is also round-tripped through
  Helix's own `parseProjectFile`, so a case that converts but produces
  a `.hlx` Helix rejects still fails.
- `tests/unit-helpers.ts` — the pure helpers directly: `plainTitle`,
  `parsePrismDate`, `daysBetween`, `subcolumnNames`, `replicateCount`.
  These are exported from `src/prism.ts` for the tests only (marked in
  the source); the converter uses them internally and nothing else
  should import them. Tests go through the exported surface — no
  test-only backdoors into production code.
- `tests/build-prism.ts` — the in-memory `.prism` builder the suite
  uses. Test UIDs are hex-only (`A0000001`, …) because the converter's
  orphan scan matches UUID-shaped UIDs (`[0-9A-F-]+`).
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

### Known behaviour pinned by the suite (not bugs to fix silently)

- A comma in a number is always read as a decimal separator:
  `"45,5"` → `45.5`, and `"1,234"` → `1.234` too. Prism records no
  locale, so a thousands separator is indistinguishable from a decimal
  comma; the rule is pinned, not changed.
- An embedded line break inside a quoted row title (Prism writes
  multi-line titles with a bare CR) passes through byte-exact — the
  converter never rewrites a value. The corpus verifier's C8 check
  flags any `\r` as a possible CSV leak, so on real files with
  multi-line titles C8 is a false positive; the value itself is exact
  (C4 confirms it).

## Layout

- `src/prism.ts` — the converter core (ZIP + `document.json` + CSVs → `.hlx` project + transfer report).
- `src/csv.ts` — small CSV reader (quoted fields, CRLF/LF).
- `src/cli.ts` — command-line entry.
- `tests/verify.ts` — headless verification against the demo file.
- `tests/verify-corpus.ts` — multi-file verification over a corpus directory (see above).
- `tests/make-synthetic.ts` — builds the synthetic edge-case corpus from the demo file.
- `tests/build-prism.ts` — builds minimal `.prism` buffers in memory for the unit tests.
- `tests/unit.ts` — abstract-layer unit tests for `convertPrism` (permutation suite).
- `tests/unit-helpers.ts` — direct unit tests for the pure helpers.
