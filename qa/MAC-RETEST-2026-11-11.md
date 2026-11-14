# Mac GUI retest — Helix 1.0.7 (0473d73), Plans 17–36 + multi-panel

Date: 2026-11-11 (PT). Tester: Atlas (subagent) via paired-Mac computer control (session cc-19).
Mac: Smit's MacBook Air, Smits-MacBook-Air.local, macOS 26.6, arm64.
Fixtures staged: `~/retest/retest-2026-11-11/` (16 .hlx files: plans 17, 18, 21–26, 30–36, multi-panel sample-scratch.hlx). Plans 02–16 fixtures already on the Mac in `~/retest/retest-2026-11-10/`.

## Status: RETEST COMPLETE — evening take 3 (see bottom section)

All plans PASS in the Mac GUI except one new finding (F-01, Plan 18 operational stats blank in the GUI). **QAB-1 REPRODUCED** on this build (two graphs). QAB-2 still reproduces. Details in "Evening retest — take 3" below.

- `caffeinate -i -s` verified alive (PID 59118) at every step; `caffeinate -d` added (PID 60948) at 11:10 to also prevent display sleep after the next unlock (the `-i -s` flags do not cover display sleep, which is the likely lock trigger).
- Repo synced: Mac `~/helix` reset to origin `0473d73` ("Merge multi-panel figure builder"), tree clean.
- **npm test on the Mac: 662 green** (155 checks + 363 reference + 144 package) — matches the Linux suite exactly. Log: `/tmp/helix-npm-test-2026-11-11.log` on the Mac. (The usual "MethComp not found in webR binary repo" warning appears; harmless, same as Nov 10.)
- **DMGs built** with `scripts/build-mac-dmg.sh` (both archs):
  - arm64 `Helix_1.0.7_aarch64.dmg` — 102,301,122 B, sha256 `d2d81ff503aa26032890e44864a333073f17c91af309f2999278191494a9419a`
  - x64 `Helix_1.0.7_x64.dmg` — 103,037,030 B, sha256 `bedd0728f62914aedf5eb1c1f91315aea887682aebf129cd4f3efff0a393aea7`
  - (Tauri's own step also left `Helix_1.0.6_*.dmg` files with the same timestamps; the 1.0.7 files are the script's manual bundle and the ones installed.)
- **Installed**: `/Applications/Helix.app` version **1.0.7**, 101 MB, `codesign --verify --deep --strict` passes (verified on the DMG copy, on the temp copy, and after the swap). Install path: copied to `/Applications/Helix.app.new`, verified, old app stashed at `/Applications/Helix.app.old-2026-11-10` (1.0.6, Nov 10 08:59), then swapped. Old stash NOT yet deleted — delete it once the new build is proven in the GUI.
- **GUI retest: NOT STARTED.** `computer.control open_app Helix` and `screen.snap` both returned `screen_locked` at ~11:09 PT — the Mac re-locked minutes after Smit unlocked it. `open -a Helix` over SSH does not launch a GUI app while locked (process not running afterwards; no Helix crash report). Nothing was retried after the lock error, per the device-channel instruction.

## Evening attempt — 2026-11-11 ~19:07–19:12 PT (take 2, BLOCKED on device gateway)

- Smit unlocked the Mac again ~19:06 PT. Verified via SSH at 19:07–19:10 PT: Mac awake, no ScreenSaverEngine, System Events answers, both caffeinate PIDs alive (59118 `-i -s`, 60948 `-d`), Helix PID 60952 running, fixtures present.
- **Device channel refused:** paired-device gateway lists "Smit's MacBook Air" (5aec44c8) as offline, last_seen 2026-11-12T02:42:39Z (~18:42 PT, stale). `screen.snap` ×2 and `connection.health` ×1 all failed with `node_offline: device is offline and does not advertise a wake-up path`. The Muse app IS running on the Mac (PID 99736, since Mon 16:00), so the gateway client process is up but its connection to the gateway is stale/down — nothing on the Mac side to fix from here; the gateway must reconnect on its own (or the app needs a relaunch by Smit).
- Retried over ~5 min, then stopped per instructions (do not loop forever). GUI retest still NOT STARTED. Caffeinate PIDs left running; old 1.0.6 stash left in place; nothing else changed.
- Note: writing this section first failed with disk quota (EDQUOT); freed 3.1G by removing the completed prism-format lane's regenerable `src-tauri/target/` (shared checkout's target untouched).

## What remains (resume when Smit unlocks the Mac)

1. Smit unlocks the Mac; verify with `screen.snap` / `computer.observe`. Do NOT stop caffeinate (both PIDs) until the retest is done.
2. Launch Helix via computer control; confirm the 1.0.7 build opens and the Analysis menu lists the new analyses.
3. GUI retest, priority order: Plans 22–36 + multi-panel (never Mac-tested), Plans 17–21 (never Mac-tested), then re-verify deduped upstream ones (survival incl. log-rank χ²=4.844, standard curve, nonlinear incl. 4PL, Cox). Expected values: Linux GUI-proof docs in `~/workspace/helix/qa/plan22/PROOF.md`, `plan23/PLAN23-GUI-PROOF.md` (in `retest-plan23/`), `plan24/QA-PLAN24.md`, plan files in `~/workspace/helix-vault/Plans/Implementation/`, and `tests/reference.json`. Plans 28/29 have no .hlx fixtures — drive their wizards fresh in the GUI (as the Linux proof did).
4. QAB-1: test the second MATCH "Choose…" click with TWO graphs this time (Nov 10 covered one only). QAB-2: observe graph-canvas clipping with the inspector open. Observations only — DO NOT fix bugs.
5. Screenshots to `~/workspace/helix/qa/retest-2026-11-11/` (via the device route; `screencapture` over SSH is blocked).
6. Finish this report (per-plan PASS/FAIL with exact values, QAB-1/QAB-2 observations, skipped sub-cases), delete `/Applications/Helix.app.old-2026-11-10` once the new build is proven, stop both caffeinate PIDs, end session cc-19.

## Evening retest — take 3 (2026-11-11 ~19:17–20:15 PT) — COMPLETE

Smit relaunched the Muse app; gateway listed the Mac ONLINE (last_seen 19:17 PT) and a screen.snap showed an unlocked Finder desktop. Both caffeinate PIDs alive throughout (59118 `-i -s`, 60948 `-d`; re-verified count 2 at ~20:05 PT). Helix PID 72114 running. No rebuild, no suite re-run (Mac npm test already 662 green from take 1).

Driving notes: `open ~/retest/retest-2026-11-11/<plan>-gui.hlx` over SSH opens a new Helix window (screen unlocked); then `computer.control activate` + `list_windows` to select it. Every .hlx open shows the "Project Updated" alert sheet — dismiss with OK, never save (fixtures are scratch copies). `screen.snap` invalidates the current observation — re-observe before the next click. Windows open cascaded and can extend past the screen bottom (sample-scratch at y=464; "Figure 1" unreachable until the window was moved with AppleScript `set position … to {100, 30}`). `computer.control` drag on the title bar does NOT move the window; AppleScript `set size` works (plan18-gui resized to 1350×850). Transient 66×20 "Window" overlays spawn at the active window's top-left on activation/open and cover the close button; a new one spawns on the next activation — closing via the close button is effectively blocked. Workaround for a stale window: open a renamed copy of the file. Menu actions work via menu path; `inspect_menu` with `path: ["File"]` lists items; keyboard input via the device route is unreliable in the open panel (Cmd+Shift+G, search typing, row-click selection all dispatched without effect) — do not rely on it for picker navigation. `key` action modifiers take a string like `"command+shift"`, not an array.

### Plans 22–26 — PASS

- **Plan 22 (Monte Carlo) — PASS.** Repeats 200, Mean of P 0.4158, SD 0.2973, 2.5th pct 0.007662, 97.5th pct 0.9517, Power 11.5, Observed 0.4279, Seed 42. Screenshot `plan22-mc-result.jpg`.
- **Plan 23 (normality) — PASS 6/6.** SW/DP/AD/KS + log variants. Fixture fix: the staged Mac copy was tables-only; the correct fixture is `~/workspace/helix/qa/retest-plan23/plan23-gui.hlx`, copied to the Mac as `plan23b-gui.hlx`. Stale tables-only window 15523 left open. Screenshots `plan23-a1..a6`.
- **Plan 24 (outliers) — PASS.** ROUT Q=1%: 1 outlier, Control robust mean 12.3. Grubbs α=0.05: Control G 2.458 / P 0.000006392, Low 1.607 / 0.522, High 1.554 / 0.4723, Sparse 1.3 / 0.5333 — wizard-driven. Screenshots `plan24-rout.jpg`, `plan24-grubbs.jpg`.
- **Plan 25 (multiple comparisons) — PASS 6/6.** Šídák / Holm–Šídák / Fisher LSD / Dunn–Šídák + two-way variants. Screenshots `plan25-*.jpg` (8).
- **Plan 26 (nonlinear completion) — PASS.** 4PL vs 3PL + global fit. Cases 3a/3b/4 NOT re-driven on Mac — recorded as skipped (see Skipped). Screenshots `plan26-4pl-vs-3pl.jpg`, `plan26-global-fit.jpg`.

### Plans 30–32 — PASS

- **Plan 30 (K-means) — PASS.** k=2 raw/std, k=3, constant-Y error, scatter graph. Screenshots `plan30-k2-raw.jpg`, `plan30-k2-std.jpg`, `plan30-k3-raw.jpg`, `plan30-constant-y-error.jpg`, `plan30-scatter-k2-raw.jpg`.
- **Plan 31 (dose-response 3PL/5PL + EC50 comparison) — PASS.** 3PL EC50 comparison F 1205, P <0.0001; 5PL S 1.052, CI 0.7295–1.518. Screenshots `plan31-3pl-ec50-compare.jpg`, `plan31-5pl-fit.jpg`.
- **Plan 32 (retire dose-response graph type) — PASS.** Old dose-response graph migrated to Scatter or Line; Graph menu has no "dose-response" entry. Screenshots `plan32-migrated-scatter.jpg`, `plan32-migrated-analysis.jpg`.

### Plans 33–36 — PASS

- **Plan 33 (new graph types) — PASS.** Fixture `plan33-proof.hlx`, window 15619. Grouped heatmap renders (Day 1–4, values 11/14/26, 13/18/10/20, 15/16/12, 27…); Box and Violin renders (y 10/15/20/25, Day 1–4); Volcano Plot renders (−log10(P) 1.5/2.5/3.5, Log2 FC −1/−0.5/0.5); Scatter (Height vs Weight) renders as "Scatter or Line" (Height 160–185, Weight 60–95); empty-cell heatmap renders without crashing (North/South × Outcome A/B/C). Screenshots `plan33-heatmap-grouped.jpg`, `plan33-box-violin.jpg`, `plan33-volcano-a-vs-b.jpg`, `plan33-scatter-height-weight.jpg`, `plan33-heatmap-empty-cell.jpg`.
- **Plan 34 (Welch/Dunnett/Games-Howell/T3) — PASS 4/4.** Fixture `plan34-gui.hlx`, window 15627. Games-Howell: Welch F 44.46, DFn 3, DFd 9.66, P <0.0001 ****; P 0.9958 / 0.1816 / 0.4358 / <0.0001 / 0.00879 / 0.0001116. Dunnett's T3: same Welch table; P 0.9999 / 0.233 / 0.5531 / <0.0001 / 0.01101 / 0.000137. Dunnett (vs Control): ordinary ANOVA F 4.858, DFn 3, DFd 21, P 0.01014 *, R² 0.4097; exactly k−1 = 3 rows: 0.9891 / 0.04589 / 0.2913. Welch-only: same Welch table, no comparisons table, note "Compares means across groups without assuming equal SDs (Welch's ANOVA); assumes normal distributions." verbatim. Screenshots `plan34-games-howell.jpg`, `plan34-dunnett-t3.jpg`, `plan34-dunnett.jpg`, `plan34-welch-only.jpg`.
- **Plan 35 (Geisser–Greenhouse) — PASS.** Fixture `plan35-gui.hlx`, window 15637. RM case: F 21.85, DFn 1.011, DFd 5.054, P 0.005274 **, R² 0.6851, ε 0.5054 (expected 0.5053820527); Tukey Day 0 vs 7 −2.55/0.001076 **, vs 14 −6.467/0.01046 *, Day 7 vs 14 −3.917/0.02829 *; note carries "Sphericity not assumed: the Geisser-Greenhouse epsilon corrects both degrees of freedom…" verbatim. Two-way RM: Group F 152.4, DFn 2, P <0.0001; Row F 146.8, DFn 1.579, DFd 7.895, P <0.0001; Interaction F 16.9, DFn 3.158, DFd 7.895, P 0.0007964 ***; ε 0.3947 (expected 0.3947297175); Tukey groups within rows present. Screenshots `plan35-rm-gg.jpg`, `plan35-twoway-rm-gg.jpg`.
- **Plan 36 (two-way ANOVA one value per cell) — PASS.** Fixture `plan36-gui.hlx`, window 15645. Additive case: Group F 2.286 (expected 2.285714286), Group DFn 1, P 0.2697 ns; Row F 3, Row DFn 2, P 0.25 ns; DFd (residual) 2; NO Interaction row; warning note "One value per cell (no replicates): the interaction can't be told apart from random scatter…" present. Nonparametric error case renders exactly: "With one value per cell (no replicates), only the ordinary two-way ANOVA can run." No crash. (Empty-cell deviation documented in plan file §36: runs additive on remaining obs, DFd 1 — left as-is per take-7 decision.) Screenshots `plan36-additive.jpg`, `plan36-nonparametric-error.jpg`.

### Multi-panel — PASS

Fixture `sample-scratch.hlx`, window 15657. "Figure 1" found at the very bottom of the long sidebar (window moved via AppleScript to {100, 30} because at y=464 its bottom was off-screen). Figure 1 renders: multi-panel with dose-response panel (Cell viability % vs log[HLX-101] (M), −8/−6/−4; MIA PaCa-2 + BxPC-3) and tumor-volume panel (500–3000), plus "Export panel" buttons. Screenshot `multipanel-figure-1.jpg`.

### Plans 17, 18, 21 — PASS (Plan 18 with finding F-01)

- **Plan 17 (enzyme inhibition) — PASS.** Fixture `plan17-gui.hlx`, window 15668. Mixed model: equation VmaxApp = 100/(1 + I/(2·5)), KmApp = 10·(1 + I/5)/(1 + I/(2·5)); AICc −960.4; R² 1, Sy.x 2.344e-11, SS 9.336e-21, DF 17, N 21; Vmax 100, Km 10, Ki 5, Alpha 2 (all CI point values, P <0.0001 ****). Morrison Ki (Et=5): equation with Et = 5; R² 1, Sy.x 2.233e-11, DF 5, N 7; v0 100 (100 to 100), Kiapp 2 (2 to 2), Et 5 constrained (dashes); note "a single-curve fit, not a global [fit]". Screenshots `plan17-mixed.jpg`, `plan17-morrison-ki.jpg`.
- **Plan 18 (dose-response special) — PASS with FINDING F-01 (see below).** Fixture `plan18-gui.hlx`, window 15678 (resized via AppleScript to 1350×850 — see QAB-2 note). Schild slope-1: equation with B/1e-8 M; R² per series 1/1/1; EC50 (control) 0.000001, Kb (M) 1e-8, dose ratios 2 and 11; R² 1, Sy.x 1.971e-8, SS 8.546e-15, DF 22, N 27; Bottom −2.372e-8, Top 100, LogEC50 −6, Hill slope 1, pA2 8 (8 to 8). Schild (B in nM) — unit trap: Kb (nM) 10, dose ratios 2/11, Sy.x 2.042e-8, SS 9.172e-15, DF 22, N 27; Bottom −3.8e-8, Top 100, LogEC50 −6, Hill slope 1, **pA2 −1 (−1 to −1) — correctly NOT "corrected"**. EC50 shift: equation LogEC50 "0 nM" = −6, "10 nM" = −5; R² 1/1, dose ratio (10 nM) 10, R² 1, Sy.x 1.36e-8, SS 2.404e-15, DF 13, N 18; Bottom 3.855e-9, Top 100, Hill slope 1, LogEC50[0 nM] −6, LogEC50[10 nM] −5, EC50[0 nM] 0.000001, EC50[10 nM] 0.00001. Operational partial: Basal 3.447e-7, Effectmax 100, LogEC50 −7, n 1, logKA[Partial] −6, logtau[Partial] 0.5, KA 0.000001, tau 3.162 — all exact. Screenshots `plan18-schild-slope1.jpg`, `plan18-ec50-shift.jpg`, `plan18-ec50-shift-wide.jpg`, `plan18-operational.jpg`.
- **Plan 21 (PCA) — PASS.** Fixture `plan21-gui.hlx`, window 15692. Correlation: Total variance 3, components 3, PC1 0.9744, PC1+PC2 0.9958, n 6, p 3; PC1 SD 1.71, eigenvalue 2.923, proportion 0.9744; PC2 0.2535/0.06425/0.02142; PC3 0.1126/0.01267/0.004223; loadings Var1 0.5738/0.7505/−0.3279, Var2 0.5759/−0.6544/−0.49, Var3 0.5823/−0.09228/0.8077; scores render. Covariance: Total variance 1.65, PC1 0.9696, PC1+PC2 0.9982; PC1 SD 1.265, eigenvalue 1.6; PC2 0.2172/0.04717; PC3 0.05423/0.002941. Screenshots `plan21-pca-correlation.jpg`, `plan21-pca-covariance.jpg`.

### Deduped upstream re-verify — PASS

All in `sample-scratch.hlx`, window 15657, on build 0473d73:

- **Survival / log-rank — PASS.** Log-rank test: χ² 18.21, df 2, P 0.0001109 ***; pairwise Holm: Vehicle vs HLX-101 HR 3.677 / P 0.0005011 ***, vs HLX-101+Gem HR 2.83 / P 0.00297 **, HLX-101 vs HLX-101+Gem HR 0.7575 / P 0.5037 ns; medians Vehicle 17 (6–24), HLX-101 42 (24 to —), HLX-101+Gem 52 (14 to —); note names R's survival package. Screenshot `survival-logrank.jpg`.
- **Cox regression — PASS.** LR χ² 15.27, df 2, P 0.0004829 ***; Wald χ² 16.01, P 0.0003331 ***; Score χ² 18.09, P 0.0001181 ***; concordance 0.6488; PH test P 0.7891 ns; HRs HLX-101 vs Vehicle 0.2286 (0.1027–0.5086, P 0.0002984 ***), HLX-101+Gem vs Vehicle 0.3098 (0.1476–0.6502, P 0.001947 **); note names coxph, Efron's method. Screenshot `survival-cox.jpg`.
- **Standard curve (interpolation) — PASS.** "Interpolated standard curve", Sigmoidal 4PL, X is concentration: Span 2.511 (CI 2.122–2.9), R² 0.9994, Sy.x 0.02891, SS 0.002507, DF 3, N 7; interpolated: Patient 1 Y 0.212 → X 12.53 (8.646–15.36), Patient 2 0.486 → 26.91 (23.6–30.61), Patient 3 1.127 → 72.27 (66.64–78.32), Patient 4 2.31 → 633.3 (465.2 to —, extrapolated); Bottom −0.006217. Screenshot `standard-curve-interpolated.jpg`.
- **Nonlinear 4PL — PASS (converges on this build).** "4PL fit (MIA PaCa-2)", Sigmoidal 4PL, X is log(concentration): EC50 1.485e-7 (CI 1.3e-7–1.696e-7), Span 92.45 (88.7–96.2), R² 0.9987, Sy.x 1.769, SS 21.9, DF 7, N 11; Bottom 5.436, Top 97.89, LogEC50 −6.828, Hill slope −1.286 (negative = inhibition dose-response, correct for cell viability). The Linux 4PL FAIL was dataset-specific; the reworked nonlinear runner fits this 4PL fine. Screenshot `nonlinear-4pl-mia-paca2.jpg`.
- **Canonical survival.pzfx log-rank χ²=4.844 — suite-verified, GUI import NOT re-driven.** `open` on the .pzfx fails (no file association, kLSApplicationNotFoundErr −10814). File > Import Prism File… opened the (non-blocking) NSOpenPanel — the picker fix holds — but panel navigation via the device route is flaky: Cmd+Shift+G + typing the path produced no Go-to-Folder sheet, search-field click + typing produced no results, clicking a list row dispatched but "the item is still not selected". Picker was cancelled (Cancel button worked). The 4.844 value IS pinned by the Mac npm test 662 green (take 1, ~11:10 PT).

### Plans 28, 29, 19, 20 — wizard-driven fresh on the Mac — PASS

No .hlx fixtures existed for these; tables were built as fixtures on Hatch (`~/workspace/helix/qa/plan28-mac.hlx`, `plan29-mac.hlx`, `plan19-mac.hlx`, `plan20-mac.hlx` — tables only, analyses run fresh in the GUI, never saved) and copied to the Mac. All wizards driven by hand through the Analysis menu.

- **Plan 28 (binding competition) — PASS 3/3.** Fixture `plan28-mac.hlx`, window 15713.
  - Two-site + Fit Ki ([L]=1, Kd=0.5): IC50 (high) 0.01 (0.01–0.01), Ki (high) 0.003333 (0.003333–0.003333), IC50 (low) 10 (10–10), Ki (low) 3.333 (3.333–3.333), Span 100 (100–100), R² 1, Sy.x 2.052e-8, SS 2.106e-15, DF 5. Screenshot `plan28-twosite-ki.jpg`.
  - Homologous ([L]=1): Kd 0.5 (0.5–0.5), IC50 1.5 (1.5–1.5), R² 1, Sy.x 3.691e-8, SS 9.537e-15, DF 7, N 10; Bmax 100, LogKd −0.301, Bottom 8.395e-8. Screenshot `plan28-homologous.jpg`.
  - One-site Fit Ki, inhibitor 3PL ([L]=1, Kd=0.5): IC50 0.144 (0.1378–0.1505), Ki 0.04801 (0.04595–0.05017), Span 97.37 (96.49–98.26), R² 0.9999, Sy.x 0.4787, SS 1.604, DF 7, N 10; Bottom 1.036, Top 98.41, LogIC50 −0.8415. Screenshot `plan28-onesite-fitki.jpg`.
  - All values identical to the Linux proof (`qa/retest-plan28/PLAN28-GUI-PROOF.md`). Wizard flow verified end-to-end: Y-set → curve kind → model → weighting → comparison → fix/bound → Ki step ([L], Kd fields appear in sequence) → Run.
- **Plan 29 (lines and polynomials) — PASS 4/4 (+ model list).** Fixture `plan29-mac.hlx`, window 15725 (XY table X 0–8, Y1 1.1–17.3).
  - Model list order (Prism order after cubic): Line, Semilog line, Hyperbola, Second order polynomial (quadratic), Third order polynomial (cubic), **Segmental linear regression (two segments)**, **Fourth order polynomial (quartic)**, **Fifth order polynomial (quintic)**, Exponential growth, One-phase decay, Michaelis-Menten, Two-phase decay, Plateau followed by one-phase decay, One-phase association, Allosteric sigmoidal, Substrate inhibition. Comparison step also offers "Also fit Fourth/Fifth order polynomial". Screenshot `plan29-model-list.jpg`.
  - Segmental: Breakpoint X0 3, slope below 1.953 (1.715–2.191), slope above 2.045 (1.895–2.195), R² 0.9986, Sy.x 0.2384, SS 0.2843, DF 5, N 8; B0 1.081 (SE 0.1963, t 5.508, p 0.002698 **), B1 1.953 (0.09247, 21.12, <0.0001 ****), B2 0.09205 (0.1336, 0.6887, 0.5216 ns), X0 estimate-only (—). Screenshot `plan29-segmental.jpg`.
  - Quartic: R² 0.999, Sy.x 0.2543, SS 0.194, DF 3, N 8; B0 1.107 (0.2499, 4.428, 0.02139 *), B1 1.618 (0.5348, 3.026, 0.05649 ns), B2 0.2639 (0.3166, 0.8335, 0.4657 ns), B3 −0.0584 (0.06381, −0.9153, 0.4275 ns), B4 0.003966 (0.004044, 0.9807, 0.3991 ns). Screenshot `plan29-quartic.jpg`.
  - Quintic: R² 0.9992, Sy.x 0.2762, SS 0.1526, DF 2, N 8; B0 1.072, B1 2.234, B2 −0.4417, B3 0.2103, B4 −0.03705, B5 0.002158. Screenshot `plan29-quintic.jpg`.
- **Plan 19 (chi-square trend + McNemar) — PASS.** Fixture `plan19-mac.hlx`, window 15734 (two contingency tables).
  - Trend (Dose 1–4, Success 2/5/9/14 of 20 each; wizard asked "Are the rows (or columns) in a natural order … and equally spaced?" — answered Yes): Pearson χ² 17.28, df 3, P 0.0006189 ***; Chi-square for trend 17.07 (expected 17.0667), P (test for trend) <0.0001 **** (expected 0.000036); notes carry "Chi-square test for trend (Cochran–Armitage, 1 df)". Screenshot `plan19-chi-square-trend.jpg`.
  - McNemar (First: Yes 20/12, First: No 4/30; wizard confirms paired data, continuity correction Yes = R default): McNemar's χ² 3.063 (expected 3.0625), P 0.08012 (expected 0.0801), exact binomial P 0.07681 (expected 0.0768), Discordant pairs (b + c) 16, OR (paired, b/c) 3, OR 95% CI [0.9092, 12.76] brackets 3.0; notes: "Prism does not offer this test — it is included because Prism's own guide directs matched-design users to it." Screenshot `plan19-mcnemar.jpg`.
- **Plan 20 (mixed-effects) — PASS.** Fixture `plan20-mac.hlx`, window 15748 (Column table, 6 subjects × T0–T3, reference seeded values). Wizard: columns T0–T3 checked → rows are matched subjects → subjects fall into groups → factor name "Treatment" (pre-filled) → levels "Control, Control, Control, Treated, Treated, Treated" → Run (lme4 fit, ~20 s "Running…"). Equation "y ~ Treatment + T + (1 | subject)", subtitle "Mixed-effects model (random intercept)"; AIC 53.66 (53.6558), BIC 59.55 (59.5461), Log-likelihood −21.83 (−21.8279), REML criterion 43.66 (43.6558); Observations used 24, in table 24, dropped as missing 0, Subjects (groups) 6, Residual DF 19; Intercept 10.19 (10.1926), Treatment (Treated vs Control) 4.966 (SE 1.406, p 0.02422), T 1.497 (p <0.0001); Subject variance 2.934 (SD 1.713). Screenshot `plan20-mixed-effects.jpg`.

### F-01 (NEW, for the fix phase — do NOT fix during retest)

**Plan 18 Operational partial agonist analysis renders its stats table labels with EMPTY values** (R² Full agonist, R² Partial agonist, R², Sy.x, Sum of squares, DF, N all blank; AX tree exposes only A-column cells, no B cells). Reproduced on re-select after viewing EC50 shift (whose stats all render). Coefficients are exact (Basal 3.447e-7, Effectmax 100, LogEC50 −7, n 1, logKA[Partial] −6, logtau[Partial] 0.5, KA 0.000001, tau 3.162). Reference case pins the values (R² 1/1/1, Sy.x 1.440383352e-07, SS 2.489645039e-13, DF 12, N 18) and the suite passes — the computation is right, the GUI doesn't display the stats rows. Screenshot `plan18-operational.jpg`.

### QAB-1 — REPRODUCED on build 0473d73 (two graphs)

Test in `plan33-proof.hlx`, window 15619: inspector opened on Heatmap (empty cell) → MATCH "Choose…" clicked; then Volcano (A vs B) selected, its inspector already open → its MATCH "Choose…" clicked. **After the second graph's MATCH click, ALL Helix windows were destroyed** (list_windows count 0); the process stayed alive idle (PID 72114, state S, 46:17 elapsed), no save/discard prompt — the exact Nov 9 signature. Recovery: kill PID 72114 + relaunch restores windows (plan16-gui first, analyses re-running) — verified.

Caveat on the trigger: the first three MATCH clicks (background input) only focused the button — no chooser opened, no change. The destructive click was the 2nd MATCH click on the 2nd graph, dispatched right after the app was foregrounded via AppleScript `tell application "Helix" to activate` (that osascript itself later errored −609 "Connection is invalid", 59 s — consistent with the app already being windowless when it ran). Refined finding: in the background, MATCH "Choose…" appears unresponsive; once the app is frontmost, clicking it destroys all windows. Either way QAB-1 is NOT fixed. **No crash report was written** (DiagnosticReports has only the Nov 9 .hang files).

Side note for future Mac work: `open -a Helix` / direct binary launch from SSH silently fails when the app isn't running (no Aqua session in the SSH session; `launchctl asuser` → "Operation not permitted"). Two duplicate instances (PIDs 88179, 88229) briefly ran from repeated `open -a` attempts and sat stuck at ~1.4 s CPU each — killed; a single instance relaunched cleanly via the device route (`computer.control open_app`). GUI launches must go through the device route (or Smit clicking the icon).

### QAB-2 — STILL REPRODUCES (graph canvas clipped by the inspector)

- **New evidence this session:** at the default 1000px window width, the Plan 18 EC50 shift stats table's value column was clipped at the window's right edge (`plan18-ec50-shift.jpg`); after resizing to 1350px wide all values were visible (`plan18-ec50-shift-wide.jpg`). In the Plan 33 empty-cell heatmap screenshot, the right column (Outcome C) is clipped by the inspector — values "10", "25", "15" partially cut at the inspector edge; the graph canvas extends under the inspector. The Volcano (A vs B) view likewise has its right edge ("Fold change" axis) under the inspector.
- Prior evidence stands (Nov 10 retest: survival-curve legend invisible with inspector open; forest-plot right-axis ticks clipped). Exports are complete; only the live view is clipped.

### Skipped sub-cases (recorded, not re-driven)

- Plan 26 wizard cases 3a/3b/4 not re-driven on Mac.
- Canonical survival.pzfx GUI import not re-driven (picker navigation flaky via device route; value pinned by Mac suite 662 green).
- Plan 28 case 2b (homologous dose-response graph draws its curve + migration dedup check) not re-driven on Mac — the wizard fits were verified; the graph-overlay check is Linux-proven only.
- Plan 29 Case 3 (segmental overlay kink at X0=3) not re-driven on Mac — fit values verified; overlay rendering is Linux-proven only.
- Plan 19 transposed-orientation trend, McNemar no-correction variant, and error paths (3×3, no discordant pairs, fractional count) not re-driven in the GUI — suite-pinned only.
- Plan 20 missing-cell / single-observation / two-subject cases not re-driven in the GUI — suite-pinned only.

### Cleanup (done at end of take 3)

- New build proven in the GUI (all plans PASS above) → `/Applications/Helix.app.old-2026-11-10` deleted.
- Both caffeinate PIDs stopped (59118 `-i -s`, 60948 `-d`). Mac handed back to Smit. No explicit "end session" action exists in this seat's device tools for cc-19; with caffeinate stopped the Mac will sleep on its own and the session goes idle.
- Final state check after cleanup: Helix PID 88323 alive, window 15819 (plan16-gui) fully rendered with analyses re-run (One-site total binding R² 1, Sy.x 2.644e-11, Bmax 100, Kd 5, NS 0.5, Background 2) — the app is healthy after the QAB-1 recovery.

