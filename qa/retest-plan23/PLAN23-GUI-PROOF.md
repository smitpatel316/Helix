# Plan 23 GUI proof — merged tree (retest)

- **Tree:** `~/workspace/helix` at `a01849f` "Merge Plan 23: Normality-test completion"
  (on top of `344da4c` Plan 23 + `4cebead` Plan 22). Nothing committed or pushed.
- **Date:** 2026-11-11 ~08:09–08:20 UTC. Verifier: Helix Plan 23 GUI-proof verifier.
- **Fixture:** working copy `qa/retest-plan23/plan23-gui.hlx` (copied from
  `qa/plan23/plan23-gui.hlx`; the original was not modified). Tables: t1
  "Normality — A/B (n=25)" (reference A/B columns), t2 "Short columns (n=8)",
  t3 "Non-positive values" (F holds 0). Pre-built analyses a1–a6 + one
  wizard-created analysis.
- **Method:** each pre-built node opened by rewriting the copy's `activeNodeId`
  and relaunching the app under Xvfb :98 (`dbus-run-session`, openbox); ~50 s
  per launch, then the "Project Updated" dialog dismissed and the window
  maximized before screenshotting. Wizard driven by mouse via xdotool.
  No code was changed, so the full suite was not re-run.

## Build

- `~/workspace/.helix-merge-p23-tmp/build-linux.log`: `BUILD-EXIT:0`
  ("Finished `release` profile in 2m 30s", "Built application at:
  .../src-tauri/target/release/helix").
- Binary `src-tauri/target/release/helix`: **103,663,648 bytes (~103.7 MB)**,
  built Nov 11 08:09. Healthy size — no `cargo clean` / rebuild needed.
- R engine ready on every launch: all analyses rendered results within the
  ~50 s wait; none stuck on "Running…".

## Results — all PASS

Reference values are from `tests/reference.json` (tolerance: statistic ±0.01,
P ±0.005; AD P ±0.02). GUI shows 4 significant digits; values below are as
rendered, with the frozen reference in brackets.

| Case | Shot | Result |
|---|---|---|
| a1 Shapiro–Wilk (default) | `r23-01-a1-sw-default.png` | **PASS.** A — W 0.9773 [0.97731], P 0.8273 [0.82725]; B — W 0.779 [0.77898], P 0.0001035 [0.00010347]. |
| a2 D'Agostino–Pearson | `r23-02-a2-dp.png` | **PASS.** A — K2 0.1566 [0.15657], P 0.9247 [0.92470]; B — K2 23.73 [23.7348], P 0.000007015 [7.015e-06]. |
| a3 Anderson–Darling | `r23-03-a3-ad.png` | **PASS.** A — A² 0.2647 [0.26470], P 0.6657 [0.66575]; B — A² 1.808 [1.80817], P 0.00009042 [9.042e-05]. Notes name the table-approximated P and the tied values. |
| a4 Kolmogorov–Smirnov + lognormality | `r23-04-a4-ks-log.png` | **PASS.** A — D 0.1161 [0.11612], P 0.8889 [0.88890]; B — D 0.301 [0.30102], P 0.02155 [0.02155]. Log rows: A — log D 0.1252, log P 0.8281; B — log D 0.1692, log P 0.4716. Notes carry the Lilliefors caveat, ties, asymptotic P, and small-n weakness. |
| a5 D'Agostino–Pearson, n=8 (too short) | `r23-05-a5-dp-short.png` | **PASS.** All four cells render "—" (null, as frozen). Note: "Not tested (the test needs at least 20 values that aren't all identical): "C", "D"." Descriptive stats still render (C mean 3.888, D 7.338, N 8). |
| a6 Shapiro–Wilk + lognormality, value 0 | `r23-06-a6-log-refusal.png` | **PASS.** Refusal shown verbatim: "Lognormality testing needs all values > 0 (log is undefined at or below zero) — "F" holds 0." (matches the frozen `error` string exactly). |
| Wizard end-to-end (new analysis) | `r23-07-wizard-table.png` → `r23-13-wizard-result.png` | **PASS.** Analysis menu → "Normality Tests" → Q1 data sets A+B (both pre-checked) → Q2 test, picked D'Agostino–Pearson → Q3 "Also test lognormality" → Run enabled (packageGate not blocking) → new node "D'Agostino–Pearson o…" created under t1 and ran: A — K2 0.1566, P 0.9247, log K2 0.6887, log P 0.7087; B — K2 23.73, P 0.000007015, log K2 0.6331, log P 0.7287 — all matching the frozen DP+log reference exactly. The merge's combined `finish`/`packageGate` (P22 tableType + P23 params) carries through. |

## Notes / caveats

- **KS P is R's asymptotic value, not SciPy's exact one** (A: 0.8889 vs
  SciPy 0.8508) — documented in the plan and in the on-screen notes, not a bug.
- **KS + lognormality rows have no frozen reference** (`checks.ts` does not run
  that combo), so they were verified against system R instead:
  `ks.test(log(x), "pnorm", mean(log(x)), sd(log(x)))` gives A log D 0.12519 /
  P 0.82814 and B log D 0.16917 / P 0.47163 — exact match to the GUI.
  (Also confirmed SW on log(B): W 0.97915, P 0.8678, matching the frozen
  lognormality case.)
- **"Project Updated" dialog on every launch** of this fixture ("This project
  was made with an older Helix, or part of it couldn't be read as it was.
  Helix brought it up to date; save it to keep the update."). It does not
  block the analysis run (results render behind it) and was dismissed with OK
  each time. The fixture file was never saved, so the dialog recurs per
  launch. Cosmetic for this fixture, not a Plan 23 failure — but the
  coordinator will see it too if they open this fixture.
- **Driver fix during the run:** the first a2 pass left the previous app window
  alive (the PID file holds the `dbus-run-session` PID, not the helix PID), so
  two windows overlapped and the dialog OK click missed. Fixed in
  `retest-drive.sh` (kill via `pkill -f "target/release/heli[x]"` bracket
  trick); the a2 re-run was clean and single-window.
- No full `npm test` re-run (no code changed). App killed after the run;
  `~/.local/share/com.helix-desktop.helix/open-projects` restored to the
  value found on arrival (`qa/plan21-gui.hlx`). Working tree untouched
  (`a01849f`, no modifications).

## Screenshots

All under `~/workspace/helix/qa/retest-plan23/`:

- `r23-01-a1-sw-default.png` — SW default
- `r23-02-a2-dp.png` — D'Agostino–Pearson
- `r23-03-a3-ad.png` — Anderson–Darling
- `r23-04-a4-ks-log.png` — KS + lognormality
- `r23-05-a5-dp-short.png` — DP n<20
- `r23-06-a6-log-refusal.png` — log-of-0 refusal
- `r23-07-wizard-table.png` — table before wizard
- `r23-08-analysis-menu.png` — Analysis menu with "Normality Tests"
- `r23-09-wizard-q1.png` — wizard Q1 (data sets)
- `r23-10-wizard-q2.png` — wizard Q2 (test choice)
- `r23-11-wizard-q3.png` — wizard Q3 (lognormality) + Run
- `r23-12-wizard-running.png` / `r23-13-wizard-result.png` — wizard-created DP+log result
- `retest-drive.sh` — the relaunch/screenshot driver used
- `plan23-gui.hlx` — the fixture working copy
