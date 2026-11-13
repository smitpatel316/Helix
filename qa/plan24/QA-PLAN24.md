# Plan 24 QA record (Helix — Grubbs' test)

Builder: resume agent, 2026-11-11. Branch `plan-24`, commit `ce08ccb`
("Plan 24: Outlier completion (Grubbs)"). Base e177ebd. NOT pushed.

## What was already done on arrival
Nearly everything, by the previous builder: Grubbs TS implementation in
`src/stats/column/rout.ts` (`runGrubbs` + `runOutliers` dispatcher),
`OutliersParams` extension, wizard (method first, Q / alpha+iterate),
label "Identify outliers", results-view "Mean (outliers removed)" header,
project-file sanitizer (`method: rout|grubbs`, `alpha`, `iterate`),
reference entries + R cross-check in `tests/reference.ts`.

## What the resume builder finished
- Added the explicit High-values statement to `tests/reference.ts`: High
  uses [18.2, 19.9, 21.3, 18.8, 20.1, 19.4] (n=6); 17.5 excluded by
  `excluded: ["2,3"]`, row-7 cell blank.
- Verified ROUT entries byte-identical (all 293 old reference entries
  unchanged; 5 new Grubbs entries).
- Full verification bar (see below); committed.

## Verification
- `npm run check`: clean (twice; before and after the comment edit).
- `npm test` (TMPDIR=~/workspace/.helix-p24-tmp): exit 0.
  **119 checks + 298 reference results + 145 package checks = 562**,
  up from the 557 baseline (+5: the new Grubbs reference entries).
  Checks re-run standalone also prints "All 119 checks pass."
- `cargo check`: Linux host exit 0; aarch64-apple-darwin exit 0;
  x86_64-apple-darwin exit 0 (with the DEV-SETUP.md clang override).
- `npm run build:linux`: exit 0, binary
  `src-tauri/target/release/helix`, 103,658,080 bytes, 13m 09s.
- GUI proof (Xvfb :99, screenshots p24-*.png in this dir):
  - ROUT via wizard (method default ROUT → Q=1 → Run): 1 outlier,
    Control robust mean 12.3, "Robust mean" header.
  - Grubbs via wizard (Grubbs → alpha 0.05 → keep testing → Run):
    "Grubbs' test (α = 0.05)", Control G 2.458 / P 0.000006392,
    Low G 1.607 / P 0.522, High G 1.554 / P 0.4723, Sparse G 1.3 /
    P 0.5333; Control row 8 (value 30) flagged; "Mean (outliers
    removed)" header (Control 12.1); notes name the flagged cell,
    the Gaussian assumption, masking + iteration.

## Deviations from the plan (all by the previous builder, kept)
1. **Masking case**: the plan expected [10, 10.2, 9.8, 10.1, 10.0, 25, 26]
   to flag both 25 and 26 in sequence. R `outliers::grubbs.test` says
   round 1 G=1.5287, P=0.6774 — not significant — so iteration flags
   nothing (masking wins outright). The reference pins that (0 outliers)
   and adds a substitute iterating case [.., 25, 45] that flags 45 then
   25 (2 with iteration, 1 without). The plan's Done criterion "iteration
   flags both values in the masking case" is therefore NOT met as written;
   the R ground truth contradicts it.
2. **P-value route**: pure TypeScript, no R package. t² =
   n(n−2)G²/((n−1)² − nG²) on n−2 df; P = n × two-sided t P (i.e. 2n ×
   one-sided tail). Verified against R `outliers::grubbs.test` (desktop R
   4.3.3, G/P agree ~1e-7) and re-verified in-suite: `disagreements()`
   cross-checks TS G/P against webr R's `pt()` on all four reference
   columns to 1e-6; critical values match qgrubbs(0.975, n).
3. **Wizard finish omits `method` for ROUT** (params `{q}` only, no
   `method: "rout"`), keeping cached ROUT result keys identical; the
   runner treats a missing method as ROUT. The plan's "pass {q, method,
   alpha, iterate}" is followed literally only for Grubbs.
4. **Grubbs `mean` field**: the new optional `mean` field on
   `OutlierGroupRow` holds the mean after removing flagged outliers
   (robustMean stays null for Grubbs); the results view shows
   "Mean (outliers removed)" when any `mean` is present.

## Environment notes (for the next lane)
- This container was replaced ~06:28; the os-intent replay held the apt
  lock until ~07:00. `scripts/setup-linux.sh` then restored GTK/WebKit
  dev, xdotool, openbox (replay had already installed most); `clang`
  was NOT restored and had to be `apt-get install`ed (18.1.3) for the
  Apple-target checks.
- Disk quota (btrfs qgroup, EDQUOT) tripped twice mid-build while sibling
  lanes built concurrently; freed ~2.9G of my own `target/debug` +
  Apple-target check artifacts and retried — the release build then
  passed. `cargo check` artifacts were deleted, not the release build.
- Shared-session collision: the app-data `open-projects` file is shared
  across worktrees; my seeding it with plan24-gui.hlx raced the plan22
  lane's launch (their app opened my file). I moved my proof to Xvfb
  :99; the session file is back to its original content
  (plan21-gui.hlx) at the end of this run.
- `pkill -f` matches its own command line (killed one of my shells);
  use the bracket trick for self-matching patterns.
- The `xdrive` XSendEvent driver in this dir was built as an xdotool
  fallback but not needed (xdotool was restored by the replay).
