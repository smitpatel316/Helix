# Side-by-side QA — corpus inventory (prep, 2026-11-12)

Prepared by the QA PREP lane. Read-only inventory: where every usable test
input lives, what it covers, which Prism values are known for it, and where
those expected values live. Nothing here was copied, moved, or modified.

**Scope note (v1.0 frozen Nov 12 ~10:01 PT):** the launch QA covers F-02 +
4 blockers + 19 majors + rebrand + prism-format merge + converter hook-up +
release paperwork. The 65 minors are OUT unless triage pulls one back as
app-breaking — if that happens, add its check from `CHECKS.md` §5 before the
run. Launch target moved to TONIGHT (Thu Nov 12, Smit's call ~10:07 PT);
the Nov 17 date in `Plans/launch plan.md` is superseded. **Name picked
~10:09 PT: TITER (American spelling, T-I-T-E-R)** — rebrand apply phase
started. The gate is
unchanged: suite green, Mac + Linux GUI-proved, no open blockers/majors,
rebrand applied.

**Mansi's files are NEVER test material** (standing rule). Everything below
is public corpus or synthetic fixtures.

## 1. `~/workspace/helix/test-corpus/` — 25 files (24 .pzfx + 1 .prism)

The original public corpus. Parser ground truth from Nov 9 (QA-CODE):
29/31 files import ≥1 table across this + testdata; `column_hugetable`
imports 0 tables (HugeTable unsupported, warned, expected); `pypzfx-empty`
0 tables ("No tables … could be imported", expected).

| File | Covers | Known Prism values / expected values live |
|---|---|---|
| `CompetitionBinding.pzfx` | Binding competition tables | Import shape only (no pinned numbers); use for import-GUI lane |
| `SaturationBinding.pzfx` | Binding saturation tables | Import shape only |
| `exponential_decay.pzfx` | Exponential decay XY | Import shape only |
| `prism2R-demo_dataset.prism` (217 KB) | 4PL Control/Treated + survival | **The parity demo file.** C-04 4PL Control 6/6 + Treated 6/6; C-05 survival 7/7; C-12 doctored-value gate. Values: Prism's own `results.json` inside the file; traced in `~/workspace/helix-vault/Research/.prism survey - demo dataset.md`. Also in `tests/testdata/prism/` on the `feat/prism-format` branch |
| `pypzfx-column.pzfx` | Column table | Parser: Column "Data 1" Aa 1,2,3,4 / Bb 100,90,80,70 |
| `pypzfx-column_cv.pzfx` | Column, CV error | Import shape only |
| `pypzfx-column_cvn.pzfx` | Column, CV + N | Import shape only |
| `pypzfx-column_empty.pzfx` | Column, empty | Import shape only |
| `pypzfx-column_hugetable.pzfx` | HugeTable | Expected: 0 tables, warned (documented ceiling) |
| `pypzfx-column_low-high.pzfx` | Column, low/high error | Import shape only |
| `pypzfx-column_sd.pzfx` | Column, SD error | Import shape only |
| `pypzfx-column_sdn.pzfx` | Column, SD + N | Parser: 6 cols with SDN warning |
| `pypzfx-column_se.pzfx` | Column, SE error | Import shape only |
| `pypzfx-column_sen.pzfx` | Column, SE + N | Import shape only |
| `pypzfx-column_unequal_lengths.pzfx` | Column, ragged | Import shape only |
| `pypzfx-column_upper-lower-limits.pzfx` | Column, limits | Import shape only |
| `pypzfx-comma_decimal.pzfx` | Comma-decimal numbers | Locale edge (see FF-F8) — import shape only |
| `pypzfx-contingency.pzfx` | Contingency table | Parser: 2×2 (a: 10,30; b: 20,40) |
| `pypzfx-empty.pzfx` | Empty file | Expected: 0 tables, "No tables …" message |
| `pypzfx-parts_of_whole.pzfx` | Parts-of-whole table | Import shape only |
| `pypzfx-survival.pzfx` | Survival XY table | Parser: XY "Three groups", 27 rows; log-rank χ²=4.8437, p=0.08876 (canonical) |
| `pypzfx-x_date.pzfx` | Date-X with row titles | QAB-3/M10 fixture: dates "16-Jan-2004", "9-Apr-2009", … (50 rows). Expected: dates kept as row titles (Round 1 QAB-3 fix) |
| `pypzfx-x_error_y_sdn.pzfx` | XY with X-error + Y-SDN | Import shape only |
| `pypzfx-x_y_no_rep.pzfx` | XY, no replicates | Import shape only |
| `pypzfx-x_y_rep.pzfx` | XY, replicates | Parser: 7 cols × 3 rows |
| `pypzfx-x_y_with_strike.pzfx` | XY, struck-through cells | Parser: same as x_y_rep + excluded `["1,2","1,3","1,4"]` |

## 2. Prism 10 public corpus — 66 .prism files

Location: `~/workspace/helix-converter-license-commit/test-corpus-prism10/`
(67 directory entries = 66 files + `LICENSES.md`). Committed on
`feat/prism-converter-cli` (`3f837f0`); licenses: 59 CC-BY, 4 public domain,
2 MIT, 1 GPL. **Do not copy into the main repo** — reference it in place
via `PRISM_TEST_CORPUS_PRISM10`.

- **What it covers:** real Prism 10 files from Zenodo (dose curves, ELISAs,
  survival, binding, dilution series, dimensional analysis, etc.).
- **Known Prism values:** each file's own `results.json` (Prism's numbers,
  read straight from the ZIP). The g.5 sweep (`tests/parity.ts` on the
  `feat/prism-format` branch) compares 4PL + survival only.
- **Sweep result (Nov 11, VALIDATION.md): 824 values, 824 within
  tolerance** — 184 via the RSS arbiter (optimizer difference), 0 with
  Helix RSS worse than Prism's. Files carrying compared analyses:
  b-domain, capsanoicids, dilution-analysis, dimensional-analysis,
  elisa-standard-curves, plasmin-activity, prism-file-marelli,
  survival-zenodo. (VALIDATION.md says "824 values across 4 files" in one
  place and lists 8 files — confirm the file count when the sweep is
  re-run post-merge; the 824/824 value count is the load-bearing number.)
- **Honest gaps to carry into the QA run (not hidden):** 62 files skipped
  (no extractable supported analysis); 28 datasets error in Helix where
  Prism fitted (degenerate/flat curves, parameters unidentifiable — flat
  RSS ridge); 135 datasets in analyses Helix does not import (Transform
  results sheets, no input table — importer warns and skips); 2 files
  unreadable (not valid zips: `cloud-verification-mdp-zenodo-17746477.prism`,
  `energy-system-zenodo-23184357.prism`); non-4PL nonlinear families not yet
  compared (e.g. one-phase decay, 42 analyses in the corpus); CIs skipped
  where Prism reports "undefined".

## 3. Synthetic .prism corpus — 6 files

Location: `~/workspace/helix-converter-license-commit/test-corpus-synthetic/`
(7 entries = 6 files + `NOTICE.md`). A second copy exists at
`~/workspace/helix-converter-hookup-prep/test-corpus-synthetic/` — use the
converter-license-commit copy as canonical.

| File | Covers |
|---|---|
| `synthetic-comma-decimal.prism` | Comma-decimal locale edge |
| `synthetic-crlf-unicode.prism` | CRLF + unicode handling |
| `synthetic-empty-table.prism` | Empty table import |
| `synthetic-graphs-only.prism` | Graphs-only file (no data tables) |
| `synthetic-missing-dataset.prism` | Dangling dataset reference |
| `synthetic-unknown-analysis.prism` | Unknown analysis type |

Converter CLI: 36/36 synthetic checks. Expected values: converter test
expectations in the converter repo (`tests/`); these are import-shape
checks, not numeric parity.

## 4. `~/workspace/helix/tests/testdata/` — 7 .pzfx fixtures

The unit-test fixtures (also the Linux smoke-test set,
`tests/linux-smoke.ts`):

| File | Covers | Known values |
|---|---|---|
| `column.pzfx` | Column table | See §1 `pypzfx-column.pzfx` |
| `column_sdn.pzfx` | Column, SD + N | 6 cols, SDN warning |
| `contingency.pzfx` | Contingency 2×2 | a: 10,30; b: 20,40; χ² uncorrected 8.120 (QAB-4), Fisher p 0.01039 |
| `survival.pzfx` | Survival XY | "Three groups", log-rank χ²=4.844, df 2, p=0.08876 |
| `x_date.pzfx` | Date-X | Same shape as `pypzfx-x_date.pzfx` (QAB-3 fixture) |
| `x_y_rep.pzfx` | XY replicates | 7 cols × 3 rows |
| `x_y_with_strike.pzfx` | XY struck-through | + excluded `["1,2","1,3","1,4"]` |

On the `feat/prism-format` branch, `tests/testdata/prism/` additionally
holds `prism2R-demo_dataset.prism` (the parity demo file, §1).

## 5. Mac fixtures — `~/retest/` on Smit's MacBook Air (listed via SSH, NOT copied off)

| Location | Contents | Covers |
|---|---|---|
| `~/retest/retest-2026-11-10/` | 11 .hlx: `plan02-standard-curve`, `plan03-gui`, `plan08-gui`, `plan09-gui`, `plan10-gui`, `plan11-gui`, `plan12-gui`, `plan13-gui`, `plan15-gui`, `plan16-gui`, `roc-plan05` | Plans 02, 03, 05, 08, 09, 10, 11, 12, 13, 15, 16 — Mac-proven PASS Nov 10 on build 49f1675 (re-run on launch tip) |
| `~/retest/retest-2026-11-11/` | 16 .hlx: `plan17-gui`, `plan18-gui`, `plan19-mac`, `plan20-mac`, `plan21-gui`, `plan22-gui`, `plan23-gui`, `plan23b-gui`, `plan24-gui`, `plan25-gui`, `plan26-gui`, `plan28-mac`, `plan29-mac`, `plan30-gui`, `plan31-gui`, `plan32-gui`, `plan33-proof`, `plan34-gui`, `plan35-gui`, `plan36-gui`, `sample-scratch` (count: 21 files listed; 16 .hlx per the Nov 11 report plus plan19/20/28/29-mac) | Plans 17–26, 28–36 + multi-panel + deduped upstream re-verify — Mac-proven PASS Nov 11 on build 0473d73 (re-run on launch tip). Plans 28/29/19/20 fixtures are tables-only; analyses are driven fresh in the GUI |
| `~/retest/` (loose) | `bland.pzfx`, `freq.pzfx`, `ks-ties.pzfx`, `ks.pzfx`, `logistic.pzfx`, `retest.hlx` | Ad-hoc fixtures (Bland–Altman, frequency, KS incl. ties, logistic). Provenance: staged for retests; treat as import/shape fixtures, not pinned-value sources |

Mac state at prep time (Nov 12 ~10:10 PT): `/Applications/Helix.app` is
1.0.7 from cd327b8 (installed, never launched); running Helix is still the
3772d91 build (PID 91483). Caffeinate restarted ~09:37 PT (PIDs 4249
`-i -s`, 4263 `-d`). Mac fix-proof take 2 is running in parallel — do NOT
drive the Mac GUI from this lane; the QA run uses the device route only
when the launch build is installed.

## 6. Ground-truth scripts — `~/workspace/helix/qa/ground-truth/`

| File | Covers |
|---|---|
| `gt.py`, `gt2.py` (+ `gt1.txt`, `gt2.txt` outputs) | Independent scipy ground truth from Nov 9: **230 checks pass** — Welch/Student/paired/ratio t, Mann-Whitney, Wilcoxon (exact enumeration), one-sample t/Wilcoxon, one-way ANOVA + Tukey/Bonferroni, Kruskal-Wallis + Dunn, RM-ANOVA + post-hoc, Friedman + Dunn, Shapiro-Wilk, Pearson/Spearman (exact permutation p), linear/multiple regression, AUC, 4PL (log-X + raw-X + hyperbola, vs `scipy.curve_fit`), log-rank, Fisher/χ², two-way ANOVA + post-hoc, multiple t-tests, correlation matrix, ROUT. Use as the independent arbiter when a Helix-vs-Prism value is disputed — scipy is the third opinion, not the source of truth (Prism's `results.json` / `tests/reference.json` are). |

## 7. Expected-values index (where numbers live)

| Source | Location | What it pins |
|---|---|---|
| `tests/reference.json` | `~/workspace/helix/tests/` (main branch) | **364 keys** at cd327b8 — every plan's pinned values. Family counts: nonlinear-regression 60, graph 42, two-way-anova 17, anova 11, compare-two-groups 11, frequency-distribution 12, shapiro-wilk 12, rm-anova 10, k-means 10, binding-kinetics 8, binding-saturation 8, dose-response-special 8, enzyme-inhibition 8, cox-proportional-hazards 8, spline-lowess 8, outliers 8, kolmogorov-smirnov 7, deming-regression 7, three-way-anova 7, counts 6, multiple-t-tests 6, cox 5, correlation 5, linear-regression 5, roc-curve 5, mixed-effects 5, survival 5, descriptive-statistics 4, friedman 4, mcnemar 4, nested-anova 4, correlation-matrix 3, multiple-logistic-regression 3, monte-carlo 3, nested-t-test 3, poisson-regression 3, area-under-curve 2, multiple-regression 2, one-sample-t 2, simple-logistic-regression 2, bland-altman 1, chi-square 9, kruskal-wallis 3, principal-component-analysis 9 |
| `tests/packages.ts` | `~/workspace/helix/tests/` | Plan 00 R-package pins (143 checks): survival/coxph, pROC, lme4/lmerTest, multcomp, nortest, outliers/Grubbs, deming/MethComp, nlme, moments |
| `tests/parity.ts` | `feat/prism-format` branch (`~/workspace/helix-prism-format/tests/`) | C-04/C-05/C-12 + g.5 corpus sweep (824 values). Re-run post-merge on the merged tree |
| `tests/checks.ts` | `~/workspace/helix/tests/` | 161 checks at cd327b8 incl. multi-panel figure checks F-01–F-12 |
| `~/workspace/helix-vault/Plans/Implementation/` | Plan files 00–36 + multi-panel + prism-format-work | Per-plan expected values with provenance (the plan file is the authority when reference.json and the plan disagree — flag it, don't silently pick one) |
| `~/workspace/helix-vault/Research/.prism survey - demo dataset.md` | Vault Research/ | Full fitted-values trace for the demo file (4PL Control/Treated estimates+SEs+CIs, survival χ²/p/HR, medians "undefined") |
| `~/workspace/helix/qa/MAC-RETEST-2026-11-10.md`, `MAC-RETEST-2026-11-11.md` | qa/ | Per-plan Mac GUI values actually seen on screen (the re-run targets) |
| `~/workspace/helix/qa/retest-planNN/`, `qa/fix-*/`, `qa/multipanel-merged/` | qa/ | Per-plan Linux GUI proof evidence (screenshots + proof docs) |

## Totals

| Source | Files |
|---|---|
| test-corpus/ | 25 (24 .pzfx + 1 .prism) |
| Prism 10 public corpus | 66 .prism |
| Synthetic corpus | 6 .prism |
| tests/testdata/ | 7 .pzfx (+1 .prism demo on the format branch) |
| Mac ~/retest/ | 27+ .hlx fixtures (11 + 16 in dated dirs) + 5 loose .pzfx + 1 loose .hlx |
| Ground truth | 2 scripts (230 scipy checks) |
| **Distinct test inputs** | **~136 files** (plus the 364-key reference.json and 824-value parity sweep as expected-value sources) |
