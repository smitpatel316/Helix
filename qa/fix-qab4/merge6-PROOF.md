# Merge #6 GUI proof — QAB-4 (uncorrected 2×2 chi-square) — Nov 12, 2026

Merge commit `82f7a9c` "Merge Fix QAB-4: report uncorrected chi-square for 2x2 tables",
branch `feat/prism-import-survival`, `~/workspace/helix`.
Ground truth: `tests/checks.ts` "the 2x2 chi-square for reference is uncorrected,
Fisher's exact unchanged".

## Binary verified before launch
- `/home/hatch/workspace/helix/src-tauri/target/release/helix`
- size 103,681,504 B, sha256 `33fb7c83750d52de40a26eb7e711baf1f4cb82ac84e86fcd621ad5878b7f571a`,
  mtime Nov 12 09:15 UTC — matches the brief exactly. No rebuild, no stale binary.

## Environment
- Xvfb :105 (`-listen tcp`, 1280×800), openbox, `DISPLAY=127.0.0.1:105`,
  `TMPDIR=~/workspace/.helix-fix-merge-qab4-tmp`, `dbus-run-session`.
- App restored the session project `plan18.hlx` (F-01 lane scratch) and showed the
  expected "Project Updated" dialog — dismissed with OK. Work was done in a fresh
  File ▸ New Project ("Untitled") so no repo fixture was touched.
- No wizard appears for a 2×2: `asked(twoByTwo)` is `[]` in the test, so
  Analysis ▸ Chi-Square or Fisher's Exact Test runs straight through.

## Table 1 — Drug 15/5, Placebo 6/14 (typed in the GUI grid, verified in shot)
- `merge6-12-table1.png` — grid reads Drug 15 | 5, Placebo 6 | 14.
- Result (`merge6-14-wizard.png`, crop `merge6-14-result-crop.png`):
  - **Chi-square (for reference): 8.12** — expected 8.1203 (GUI rounds to 3 s.f.);
    NOT the pre-fix Yates value 6.416.
  - **P value (Fisher's exact test): 0.01039 \*** — expected 0.0103867.
  - **df: 1**. Odds ratio (conditional estimate) 6.615. Heading "Fisher's exact
    test", badge "Significant *". Note: "Contingency table 2×2, N = 40."

## Table 2 — Group 1 10/20, Group 2 30/40
- `merge6-16-table2.png` — grid reads Group 1 10 | 20, Group 2 30 | 40.
- Result (`merge6-17-result2.png`, crop `merge6-17-result2-crop.png`):
  - **Chi-square (for reference): 0.7937** — expected 0.7937.
  - P value (Fisher's exact test): 0.5045 ns. Odds ratio 0.6693. df: 1.
    Badge "Not significant". Note: "Contingency table 2×2, N = 100."

## Label check
- The stat label reads exactly **"Chi-square (for reference)"** in both results —
  same string the regression test asserts on. No "Yates" / "corrected" wording
  anywhere in the results view.

## Verdicts
1. Table 1 chi-square ≈ 8.1203 — **PASS** (GUI shows 8.12; pre-fix 6.416 absent).
2. Fisher p ≈ 0.0103867 and df = 1, primary result untouched — **PASS**
   (GUI shows 0.01039, df 1).
3. Table 2 chi-square ≈ 0.7937 — **PASS** (GUI shows 0.7937).
4. Label is the uncorrected "Chi-square (for reference)" — **PASS**.

## Cleanliness / notes
- Untitled project closed with "Don't Save"; plan18 window closed with no save
  prompt. `~/.local/share/com.helix-desktop.helix/open-projects` unchanged
  (still `.../.helix-fix-merge-f01-tmp/plan18.hlx`; backup at
  `merge6-open-projects.bak` — restore was not needed).
- `plan18.hlx` mtime still Nov 12 08:55 UTC (pre-run) — not modified.
- `git status` in `~/workspace/helix`: only the pre-existing untracked
  `.node-xmlhttprequest-content-4518`; HEAD still 82f7a9c. No edits/commits.
- Minor GUI-navigation notes: the sidebar "New Table…" button did not respond to
  clicks (used Table menu ▸ Contingency instead); menu-bar hit zones sit a few px
  off the visible labels (File hit at x=210, Edit at x=228, Analysis at x=368);
  the Title cell renders "Drug" with the trailing "g" hidden behind the mouse
  cursor in one shot — verified "Drug" by the earlier edit-mode shot and the crop.
  No typing race observed; Tab moves right across the grid as expected.
- Xvfb/openbox stopped after the run; helix process exited.

## Screenshots (all under `~/workspace/helix/qa/fix-qab4/`, prefix `merge6-`)
- `merge6-01-launch.png` launch + Project Updated dialog
- `merge6-05-newproject.png` fresh Untitled project
- `merge6-09-contingency.png` empty contingency Table 2
- `merge6-10-type1.png` / `merge6-11-row1.png` typing row 1
- `merge6-12-table1.png` Table 1 verified in grid
- `merge6-13-anmenu.png` Analysis menu
- `merge6-14-wizard.png` + `merge6-14-result-crop.png` Table 1 results
- `merge6-16-table2.png` Table 2 verified in grid
- `merge6-17-result2.png` + `merge6-17-result2-crop.png` Table 2 results
- `merge6-18-quit.png` / `merge6-19-afterclose.png` / `merge6-21-quit3.png` teardown
- `merge6-app.log`, `merge6-xvfb.log`, `merge6-openbox.log`
