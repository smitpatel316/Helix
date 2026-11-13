# Plan 24 GUI proof — merged tree (retest)

- **Tree:** `~/workspace/helix` at `87bd870` "Merge Plan 24: Outlier completion
  (Grubbs)" (on top of `a01849f` Plan 23). Nothing committed or pushed.
- **Date:** 2026-11-11 ~09:25–10:15 UTC. Verifier: Helix Plan 24 GUI-proof
  verifier (merged tree).
- **Fixture:** working copy `qa/retest-plan24/plan24-gui.hlx` (built from the
  builder's `qa/plan24/plan24-gui.hlx` plus two added tables). Tables: t1
  "Outliers — reference columns" (Control/Low/High/Sparse, 17.5 cell
  excluded), t2 "Grubbs — iterate case" (Values [10, 10.2, 9.8, 10.1, 10,
  25, 45]), t3 "Grubbs — masked case" (Masked [10, 10.2, 9.8, 10.1, 10, 25,
  26]). All five wizard-created analyses were saved into the working copy
  (Ctrl+S after each run), so the fixture now carries the nodes and any
  later launch recomputes them from the stored params.
- **Method:** each analysis created live through the wizard under Xvfb :98
  (`dbus-run-session`, openbox), driven by mouse via xdotool with
  `muse.visual_grounding` for exact button coordinates. No code was changed,
  so the full suite was not re-run (already green on this tree per the
  brief: 129 + 312 + 144 = 585, exit 0).

## Build

- `~/workspace/.helix-merge-p24-tmp/build-linux.log`: `BUILD-EXIT:0`
  ("Finished `release` profile [optimized] target(s) in 8m 37s", "Built
  application at: .../src-tauri/target/release/helix").
- Binary `src-tauri/target/release/helix`: **103,664,736 bytes (~103.7 MB)**,
  built Nov 11 09:35. Healthy size — no `cargo clean` / rebuild needed.
- R engine ready: the ROUT run (which needs webR `pt()`) rendered results
  within the 30 s wait; no analysis ever stuck on "Running…".

## Results — all PASS

Reference values are from `tests/reference.json` (GUI shows 4 significant
digits; values below are as rendered, with the frozen reference in
brackets). Critical values from the plan: Control n=8 → 2.126, Low n=7 →
2.020.

| Case | Shot | Result |
|---|---|---|
| Grubbs on reference columns (t1) | `r24-08-grubbs-result.png` → `r24-10-grubbs-notes.png` | **PASS.** "Grubbs' test (α = 0.05)": 25 obs, 4 groups, **1 outlier** (4%). Control — G **2.458** [2.457924065] > 2.126 → value **30.0 flagged**; P 0.000006392 [6.39176906e-06]. Low — G **1.607** [1.60740129] < 2.020 → clean; P 0.522 [0.522030338]. High — G 1.554 [1.553809378], P 0.4723 [0.4723455532]. Sparse — G 1.3 [1.3], P 0.5333 [0.5333333333]. Outliers by column: Control 8/1/12.5%, mean (outliers removed) **12.1**; Low 7/0/14.84; High 6/0/19.62; Sparse 4/0/10.63. Notes verbatim: "Flagged as outliers (Grubbs' test, α = 0.05): Control row 8 (value 30, P = 0.0000)…" + Gaussian-assumption + masking/iteration sentences. |
| ROUT default unchanged (t1, Q=1) | `r24-15-rout-result.png` / `r24-16-rout-notes.png` (re-run `r24-28-g2-rout-result.png`, identical) | **PASS.** Wizard Q2 shows ROUT pre-selected by default; Q (%) = 1. "ROUT method (Q = 1%)": 25 obs, 4 groups, **1 outlier** (4%), Q parameter 1. Outliers by column: Control 8/1/12.5%, **Robust mean 12.3**; Low 7/0/14.82; High 6/0/19.55; Sparse 4/0/10.67 — header is "Robust mean", not "Mean (outliers removed)". Notes: "Flagged as outliers (FDR-adjusted P < Q): Control row 8 (value 30, adj. P = 0.0000)…" — all values byte-match the frozen `outliers column {"q":1}` entry. |
| Iterate ON (t2, [.., 25, 45]) | `r24-30-t2-iterate-on.png` | **PASS.** "Grubbs' test (α = 0.05)": 7 obs, 1 group, **2 outliers** (28.57%). Values — G **2.064** [2.064306328], P 0.03088 [0.03087818994]. Mean (outliers removed) **10.02**. Notes: "Values row 7 (value 45, P = 0.0309); Values row 6 (value 25, P = 0.0000)" — 45 flagged first, then 25. |
| Iterate OFF (t2, [.., 25, 45]) | `r24-33-t2-iterate-off.png` | **PASS.** Same round-1 G 2.064 / P 0.03088, but **1 outlier** (14.29%): only "Values row 7 (value 45, P = 0.0309)". Mean (outliers removed) **12.52** [12.51666667]. |
| Masked case (t3, [.., 25, 26]) | `r24-36-t3-masked.png` | **PASS (0 outliers — documented, not a bug).** "Grubbs' test (α = 0.05)": 7 obs, **0 outliers**. Masked — G **1.529** [1.528732535], P **0.6775** [0.6774511628]. Notes: "No outliers detected by Grubbs' test at α = 0.05." Matches R `outliers::grubbs.test` round-1 G=1.5287, P=0.6774 per the plan file's Builder notes; the plan's original expectation (both flagged) is contradicted by R ground truth. |
| Wizard end-to-end | `r24-03-wizard-q1.png` → `r24-07-wizard-iterate.png`, `r24-12b-rout-q1.png` → `r24-14-rout-q.png`, `r24-18-t2-q1.png` → `r24-20-t2-iterate-on.png` | **PASS.** Analysis → "Identify Outliers" → data-sets step (shown for the 4-column table; skipped for single-column tables, which go straight to the method step) → method choice (ROUT default, Grubbs' test second) → conditional fields: ROUT shows Q (%) = 1; Grubbs shows alpha = 0.05 then the iterate choice ("Keep testing after removing each outlier (recommended)" default) → Run → results match the frozen reference. Saved params confirm the finish contract: Grubbs `{method: "grubbs", alpha: 0.05, iterate: true/false, sets: [...]}`, ROUT `{q: 1, sets: [...]}` (no `method` key for ROUT, as designed). |

## Notes / caveats

- **App exit mid-run (transient, not a Plan 24 failure):** during the first
  t2 iterate-on attempt the whole app window vanished between the alpha
  step and Run (process gone, no panic/crash line in the log, no OOM in
  dmesg, 3.1 GB free). The two unsaved analyses from that session (Grubbs
  t1 + ROUT t1) were lost with it. Relaunched, re-drove both t1 runs
  (identical values), and saved (Ctrl+S) after every run thereafter; the
  t2 iterate-on step then completed fine at the exact same wizard point,
  and the app stayed alive through four more runs. Best explanation is a
  transient WebKit/process loss under the sibling-lane build storm
  (plan26/plan28 vite builds were running at the time), not the Grubbs
  code path — Grubbs is pure TypeScript and the same params ran clean
  before and after.
- **Wizard driving gotcha (tooling, not the app):** screenshot pixel
  estimates read ~95 px left of the true button positions for the narrow
  dialog buttons; early Next clicks landed on Cancel/the gap. Fixed by
  grounding every button with `muse.visual_grounding` before clicking.
  One wrong menu pick ("Compare One Group to a Value" instead of
  "Identify Outliers") was cancelled immediately; no stray analysis was
  created.
- **"Project Updated" dialog:** did not appear on either launch of this
  fixture (the driver's 640,456 click is retained as a harmless
  dismiss-if-present).
- No full `npm test` re-run (no code changed). App killed after the run;
  `~/.local/share/com.helix-desktop.helix/open-projects` restored to the
  value found on arrival (`qa/plan21-gui.hlx`). Working tree untouched
  (`87bd870`, `git status` shows only the two pre-existing untracked
  `test-corpus-*` dirs; `qa/retest-plan24/` is git-ignored).

## Screenshots

All under `~/workspace/helix/qa/retest-plan24/`:

- `r24-01-t1-table.png` — t1 reference table on launch
- `r24-02-analysis-menu.png` — Analysis menu with "Identify Outliers"
- `r24-03-wizard-q1.png` — wizard data-sets step (all four pre-checked)
- `r24-04-wizard-method.png` — method choice (ROUT default)
- `r24-05-grubbs-picked.png` — Grubbs' test selected
- `r24-06-wizard-alpha.png` — alpha = 0.05
- `r24-07-wizard-iterate.png` — iterate choice (keep testing, default)
- `r24-08-grubbs-result.png` — Grubbs t1 stats (Control G 2.458, Low G 1.607)
- `r24-09-grubbs-result-scrolled.png` — outliers-by-column + descriptives
- `r24-10-grubbs-notes.png` — Grubbs t1 notes (Control row 8 flagged)
- `r24-12b-rout-q1.png` → `r24-14-rout-q.png` — ROUT wizard (Q = 1)
- `r24-15-rout-result.png` / `r24-16-rout-notes.png` — ROUT result + notes
- `r24-17-t2-table.png` — t2 iterate-case table
- `r24-18-t2-q1.png` — t2 wizard (single set → straight to method)
- `r24-19-t2-alpha.png` — t2 alpha step
- `r24-20-t2-iterate-on.png` — first-session t2 iterate step (pre-crash)
- `r24-21-relaunch.png` — clean relaunch after the crash
- `r24-22-file-menu.png` / `r24-23-file-menu.png` — Helix/File menus (Save Ctrl+S)
- `r24-24-g2-method.png` → `r24-26-g2-result.png` — Grubbs t1 re-run (identical values)
- `r24-27-g2-rout-q.png` / `r24-28-g2-rout-result.png` — ROUT t1 re-run (identical)
- `r24-29-t2-iterate.png` / `r24-30-t2-iterate-on.png` — iterate ON: 2 outliers (45, then 25)
- `r24-31-t2-iterate-off-q.png` / `r24-32-t2-iterate-off-picked.png` / `r24-33-t2-iterate-off.png` — iterate OFF: 1 outlier (45 only)
- `r24-34-t3-table.png` — t3 masked-case table
- `r24-35-t3-iterate.png` / `r24-36-t3-masked.png` — masked case: 0 outliers, G 1.529, P 0.6775
- `retest-drive.sh` — the relaunch/screenshot driver used
- `plan24-gui.hlx` — the fixture working copy (3 tables + 5 saved analyses)
