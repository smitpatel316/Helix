# Plan 28 GUI proof — merged tree (re-test)

- **Tree verified:** `9584051` "Merge Plan 28: Binding-competition completion" (on top of `cdd695b` Plan 26).
- **Build:** `~/workspace/.helix-merge-p28-tmp/build-linux.log` ends `BUILD-EXIT:0` (vite 25.01 s, Rust release 4 m 07 s). Binary `~/workspace/helix/src-tauri/target/release/helix` = **103,673,696 bytes**.
- **Date:** 2026-11-11, ~12:24–13:33 PST. Display `:97`, private XDG dirs under `~/workspace/.helix-merge-p28-tmp/`.
- **Fixture:** `~/workspace/.helix-merge-p28-tmp/plan28-retest.hlx` (hand-built, NOT in the repo) — three XY tables with exact `tests/reference.ts` values: two-site, homologous, one-site Fit Ki. Final saved copy (6,487 bytes, 13:32) also contains the wizard analyses, the dose-response graph, and the migration-created analysis.
- **Full suite:** not re-run (no code changed); expected suite on this tree was already green (137 + 346 + 144 = 627, exit 0).
- **Head note:** the shared checkout has since advanced to `5f9901b` "Merge Plan 29" (another lane merged during this verification). All GUI work below ran against the 9584051 build above; nothing in the repo was modified by this verification (`git status` shows only the pre-existing untracked `test-corpus-prism10/` and `test-corpus-synthetic/` dirs). No commits, no pushes.

## Case 1 — Two sites + Fit Ki: PASS

Wizard: Analysis → Nonlinear Regression → Response → Dose-response (sigmoidal) → "Two sites — Fit logIC50, X is log(concentration)" → No weighting → No comparison → fit every parameter freely → "Also report Ki (Cheng–Prusoff)" → [L] = 1 → Kd = 0.5 → Run. Re-driven twice (sessions 2 and 4); identical values both times.

Observed (best-fit values, `82-twosite-ki-result.png`; also `23-running.png` from session 2):

| Value | Expected | Observed |
|---|---|---|
| IC50 (high affinity) | 0.01 | **0.01** (95% CI 0.01 to 0.01) |
| Ki (high affinity) | 0.003333 | **0.003333** (0.003333 to 0.003333) |
| IC50 (low affinity) | 10 | **10** (10 to 10) |
| Ki (low affinity) | 3.333 | **3.333** (3.333 to 3.333) |
| Span | 100 | **100** (100 to 100) |
| R² | 1 | **1** |
| Sy.x / Sum of squares / df / N | — | 2.052e-8 / 2.106e-15 / 5 / 10 |

Coefficients (`24-twosite-ki-scrolled.png`): Bottom 9.959e-8 (≈ 0), Top 100, LogIC50Hi −2, LogIC50Lo 1, FractionHi 0.5. Notes (`25-twosite-ki-notes.png`): "Ki = IC50 / (1 + [L]/Kd), with [L] = 1 and Kd = 0.5 (same units as X)".

## Case 2 — Homologous: PASS

Wizard: same path → "One site — Homologous, X is log(concentration)" → [L] = 1 (no Fit-Ki step, no Kd field — Kd is fitted) → Run. Re-driven twice; identical values both times.

Observed (`31-homol-result.png`, `59-homol2-result.png`):

| Value | Expected | Observed |
|---|---|---|
| Kd | 0.5 | **0.5** (95% CI 0.5 to 0.5) |
| IC50 | 1.5 | **1.5** (1.5 to 1.5) |
| R² | 1 | **1** |
| Bmax / LogKd / Bottom | 100 / −0.30103 / 0 | **100 / −0.301 / 8.395e-8** |
| Sy.x / Sum of squares / df / N | — | 3.691e-8 / 9.537e-15 / 7 / 10 |

Notes (`32-homol-notes.png`): "Homologous competition: [L] = 1 (same units as X); Kd = Ki, since the competitor and radioligand are the same compound."

## Case 2b — Homologous dose-response graph draws its curve: PASS (the key regression check)

- Graph → Dose-Response Curve on the homologous table; Format panel Model = "One site — Homologous, X is log(concentration)", Radioligand [L] = 1 (`53-homol-pill.png`, `54-homol-l-set.png`).
- The graph draws the **fitted sigmoidal curve through the points** (not points-only) with the on-graph annotation **"Kd = 0.5, R² = 1"** (`54-homol-l-set.png`).
- After save → quit → relaunch → reopen, the graph still draws the curve, now annotated **"Kd = 0.5, IC50 = 1.5, Bmax = 100, LogKd = -0.301, R² = 1"** and bound to the migration-created analysis (`76-reopened-graph.png`).
- Migration check: on reopen, `fitsFromDoseGraphs` created a backing analysis "Nonlinear regression 2" under the homologous table from the dose-response graph (`73-reopened.png`); it refits to Kd 0.5, IC50 1.5, R² 1 (`75-migrated-homol.png`). Note: it does **not** dedupe against the wizard-created homologous analysis — the table now has two homologous analyses ("Nonlinear regression" and "Nonlinear regression 2") with identical values. Cosmetic duplication, not a value failure.

## Case 3 (optional) — One-site Fit Ki: PASS

Wizard: inhibitor 3PL ("log(inhibitor) vs. response, standard slope (3PL)") + "Also report Ki" → [L] = 1 → Kd = 0.5 → Run (`70-onesite-fitki.png`, `72-onesite-ki-result.png`).

| Value | Expected | Observed |
|---|---|---|
| IC50 | 0.144 | **0.144** (95% CI 0.1378 to 0.1505) |
| Ki | 0.04801 | **0.04801** (0.04595 to 0.05017) |
| Span | — | 97.37 (96.49 to 98.26) |
| R² | — | 0.9999 |

Coefficients: Bottom 1.036, Top 98.41, LogIC50 −0.8415.

Detour worth noting: my first attempt on this table clicked the **agonist** 3PL instead of the inhibitor 3PL (`63-onesite-fitki.png`: "log(agonist) vs. response", EC50 0.144, Span −97.37, R² 0.9999 — the negative span is the tell). The agonist analysis node was left in the fixture file alongside the correct inhibitor one ("Nonlinear regression" = agonist, "Nonlinear regression 2" = inhibitor). The EC50 0.144 coincidence is expected — same midpoint, opposite orientation.

## Wizard validation: PASS with one nuance

- Fit-Ki toggle offered on two-site and inhibitor-3PL models; homologous correctly skips it and asks only for [L] (`15-wizard-next.png`, `16-wizard-ki-on.png`, `21-fitki-step.png`, `27-homol-ligand.png`).
- [L] and Kd fields offered with the Cheng–Prusoff formula in the prompt (`17-wizard-ligand.png`, `19-wizard-kd.png`, `22-kd-entered.png`, `81-twosite-kd.png`).
- Blank [L]: Next/Run stays disabled and the wizard does not advance (`18-wizard-validation.png`, `28-homol-blank-run.png`) — but **no error text is shown for the blank case**. The code (`src/views/analyses/wizards.ts`, `parseRequiredPositive`) has the message ("Enter a {label} — it is required for this model.") but it is not surfaced in the GUI on this step.
- [L] = 0: inline error **"The radioligand concentration [L] must be greater than 0."**, Next stays disabled (`18c-wizard-zero.png`).
- All three Plan 28 models are present in the model list (`11-wizard-dose.png`).

## Environment incidents (for the record, not product failures)

1. **Container replaced ~12:35 PST** mid-wizard (after the Kd step, before Run): apt packages (xdotool/openbox) wiped; Xvfb :97 + app died. Recovered by re-running `scripts/setup-linux.sh`. Note: the stock `apt-get update` hung ~30 min on the Cogent mirror (repeated `Ign` hash mismatches); dropping the Cogent URI from `/etc/apt/sources.list.d/ubuntu.sources` (azure only) finished the update in 27 s. A sibling lane's concurrent identical setup install then provided the packages. The wizard was re-driven from scratch afterwards.
2. **Disk quota (EDQUOT, error 122) twice** — sibling lanes' cargo builds refilled the workspace quota. Freed only stale regenerable build scratch: `helix-plan30/src-tauri/target/debug` (session 1) and `helix-rebase/src-tauri/target` (4.2 G; rebase already pushed, no lane running from it). No other lane's work was touched.
3. **Transient wedged session (session 2, after deleting a graph):** Graph-menu creation (Dose-Response, Scatter, Area), `Ctrl+Alt+G`, right-click context menu, and File → Save all silently no-op'd, while the wizard, table selection, and the earlier graph deletion worked. No error was surfaced. A full app restart cleared it completely — graph creation, Save, and shortcuts all work in the fresh sessions. Root cause not established (suspected stale menu/focus state after the native delete-confirmation dialog); the fresh-session evidence above is from the healthy state. If it recurs, the repro is: create a graph, delete it via Graph → Delete Graph…, then try creating another graph.

## Screenshots (all under `~/workspace/helix/qa/retest-plan28/`)

Key evidence: `23-running.png` (two-site + Ki, session 2), `82-twosite-ki-result.png` (two-site + Ki, final session), `24-twosite-ki-scrolled.png`, `25-twosite-ki-notes.png`, `31-homol-result.png` + `59-homol2-result.png` (homologous), `32-homol-notes.png`, `54-homol-l-set.png` (homologous curve drawn, Kd = 0.5, R² = 1), `76-reopened-graph.png` (curve survives reopen), `75-migrated-homol.png` (migration-created analysis), `72-onesite-ki-result.png` (one-site Fit Ki), `18-wizard-validation.png` + `18c-wizard-zero.png` + `28-homol-blank-run.png` (validation), `11-wizard-dose.png` (model list), `17-wizard-ligand.png` + `19-wizard-kd.png` ([L]/Kd fields), `34-dose-graph.png` (Area graph sanity check — graph engine renders).
