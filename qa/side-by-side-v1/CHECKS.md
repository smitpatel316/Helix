# Side-by-side QA — check list (prep, 2026-11-12)

Every check the launch QA run must execute, per family. Each row names the
fixture, the Prism expected values + source, the tolerance, Mac vs Linux
applicability, and whether it is already covered by an earlier proof
(**re-run on the launch tip regardless** — earlier proofs were on older
tips; a re-run is a regression check, not a duplicate).

**Build rule:** all checks run against the LAUNCH TIP of
`feat/prism-import-survival` (branch, not a fixed commit — Round 2 +
prism-format merge + converter hook-up + rebrand all land before the run).
Record the tip SHA in `RESULTS.md` at run start. If the tip moves mid-run,
stop and re-start the affected families.

**"Numbers matching Prism" means:**
- Fitted parameters: **1e-3 relative** (different optimizers, same
  least-squares problem). If beyond 1e-3, the **RSS arbiter** decides:
  Helix RSS ≤ Prism RSS (× (1 + 1e-9)) on the same fit points = pass as an
  optimizer difference; Helix RSS worse = FAIL. CIs never arbitrate.
- χ² statistics: **1e-3 relative**.
- p-values: **1e-4 absolute** (never relative).
- CIs: **1e-2 relative**, only where BOTH bounds are numbers. Prism's CIs
  are profile-likelihood, Helix's are Wald — 1% passes that honest
  difference and still catches a wrong standard error. "Undefined" bounds
  are skipped, never passed or failed.
- `tests/reference.json` values (the suite pins): **exact to displayed
  precision** in the GUI. A GUI value that differs from its reference.json
  pin at displayed precision is a FAIL even if it is within the Prism
  tolerance above — the pin is the regression gate.
- Exports: pixel/DPI checks per §4 (dimensions + all content present).
- Anything Prism reports as "undefined" (CI uppers, medians) is skipped,
  never counted as pass or fail.

## §1. Plan families (36 verified plans; Plan 27 superseded — do not check)

Key to columns: **Fix** = fixture to drive. **Expected** = Prism values +
source. **Tol** = tolerance (P = parity tolerances above; R = reference.json
exact-to-displayed-precision). **Plat** = M (Mac GUI), L (Linux GUI/Xvfb),
S (suite-only, already pinned — GUI spot-check only). **Status** = what
earlier proof exists (all re-run on launch tip).

| Plan | Check | Fixture | Expected (source) | Tol | Plat | Status |
|---|---|---|---|---|---|---|
| 00 | R-package provisioning: all 11 packages install from bundled repo; cold start ≤120 s; engine-ready → survival ready | `tests/packages.ts` (143 checks) + Linux GUI launch | Package pins in `tests/packages.ts` (survival 3.8-12, pROC 1.19.1, lme4 2.0-6, lmerTest 3.2-1, multcomp 1.4-32, nortest 1.0-4, outliers 0.15, deming 1.4-1, MethComp 1.30.2, nlme 3.1-171) | R | M+L+S | Suite-pinned; Mac 662 green Nov 11. Re-run suite on launch tip |
| 01 | Simple logistic: intercept, slope, OR + CI, pseudo-R²; separation guard | `~/retest/retest-2026-11-10/` (Nov 9 Mac) + `tests/testdata/` logistic path | Intercept −5.857372, slope 1.301638, OR 3.675313 [0.708413, 19.067869], pseudo-R² 0.638027 (`tests/reference.json`: simple-logistic-regression, 2 keys) | R | M+L | Mac PASS Nov 9; Linux GUI proven (wizard + logistic-curve graph + PNG 300 DPI). Re-run |
| 02 | Standard-curve interpolation: 4PL fit + inverse at Y=20/50/80 + CIs; out-of-range Y=150 → null + note | `plan02-standard-curve.hlx` (Mac) | Bottom 1.2783, Top 99.2422, LogEC50 −0.8420, HillSlope 0.9770, EC50 0.1439, R² 0.9999; Y=20 → logX −1.4834 [−1.5056, −1.4614], Y=50 → −0.8467, Y=80 → −0.2157 (plan 02 file + reference.json) | R | M+L | Mac PASS Nov 10; Linux GUI proven. Re-run. Also C-04 demo-file interpolation on launch tip |
| 03 | Three-way ANOVA: F/p per factor + interactions | `plan03-gui.hlx` (Mac) | Plan 03 file + reference.json three-way-anova (7 keys) | R | M+L | Mac PASS Nov 10. Re-run |
| 04 | Bland–Altman: bias, limits of agreement, plot | `~/retest/bland.pzfx` (Mac loose) + plan 04 fixture | Plan 04 file + reference.json bland-altman (1 key) | R | M+L | Mac PASS Nov 9. Re-run |
| 05 | ROC: AUC + CI, optimal cutpoint, curve | `roc-plan05.hlx` (Mac) | Plan 05 file + reference.json roc-curve (5 keys); m15: (0,0)/(1,1) endpoints present | R | M+L | Mac PASS Nov 10. Re-run |
| 06 | Frequency distribution: bins, counts, histogram | `~/retest/freq.pzfx` (Mac loose) + plan 06 fixture | Plan 06 file + reference.json frequency-distribution (12 keys); binCount ≤100 (m14) | R | M+L | Mac PASS Nov 9. Re-run |
| 07 | Kolmogorov–Smirnov: D, p, two-sample | `~/retest/ks.pzfx`, `ks-ties.pzfx` (Mac loose) | Plan 07 file + reference.json kolmogorov-smirnov (7 keys); ties case | R | M+L | Mac PASS Nov 9. Re-run |
| 08 | Exponential curves: growth/decay fits (all 5 cases; Case D SSasymp suite-only) | `plan08-gui.hlx` (Mac) | Plan 08 file + reference.json nonlinear-regression (exponential subset of 60 keys) | R | M+L | Mac PASS Nov 10 (5 cases). Re-run |
| 09 | Enzyme kinetics substrate-velocity: Michaelis–Menten Bmax/Km | `plan09-gui.hlx` (Mac) | Plan 09 file + reference.json nonlinear-regression (MM subset) | R | M+L | Mac PASS Nov 10 (3 cases). Re-run |
| 10 | Cox PH: HRs + CIs, LR/Wald/Score χ², concordance, forest plot, KM curves | `plan10-gui.hlx` (Mac) + `sample-scratch.hlx` (deduped re-verify) | HR_Trt 0.3731 (0.103, 1.352), HR_Age 0.9655 (0.8587, 1.086), LR χ² 2.724 (df 2, p 0.2561), concordance 0.6526 (SE 0.08413), events 12, censored 4, N 16 (plan 10 + reference.json cox 5 + cox-proportional-hazards 8 keys). Deduped: LR χ² 15.27, HRs 0.2286/0.3098 | R | M+L | Mac PASS Nov 10 + Nov 11 deduped. Re-run. Forest-plot clip check (QAB-2 class) at 1000px |
| 11 | Multiple logistic: ORs + CIs, pseudo-R² | `plan11-gui.hlx` (Mac) | Age OR 1.0949 (0.9512–1.2603), Dose OR 6.6930 (0.3348–133.7829), pseudo-R² 0.3126 (plan 11 + reference.json multiple-logistic-regression, 3 keys) | R | M+L | Mac PASS Nov 10. Re-run |
| 12 | Poisson: coefficients, quasi-Poisson | `plan12-gui.hlx` (Mac) | Plan 12 file + reference.json poisson-regression (3 keys) | R | M+L | Mac PASS Nov 10 (A + B + quasi). Re-run |
| 13 | Deming: slope/intercept at λ=1 and λ=0.25 | `plan13-gui.hlx` (Mac) | Plan 13 file + reference.json deming-regression (7 keys); slope 1.9999988928883004 on y=2x (tolerance 1e-5, measured) | R | M+L | Mac PASS Nov 10. Re-run |
| 14 | Nested t / nested ANOVA: subgroup means, F/p | `plan14` fixture (Mac 11-10 dir has no plan14 .hlx — drive wizard fresh, as Nov 10 did) | Plan 14 file + reference.json nested-anova (4) + nested-t-test (3 keys) | R | M+L | Mac PASS Nov 10. Re-run |
| 15 | Spline/Lowess: all three smoothers | `plan15-gui.hlx` (Mac) | Plan 15 file + reference.json spline-lowess (8 keys) | R | M+L | Mac PASS Nov 10. Re-run |
| 16 | Binding kinetics + saturation: one-site total, two-site, assoc/dissoc | `plan16-gui.hlx` (Mac) | Plan 16 file + reference.json binding-kinetics (8) + binding-saturation (7 keys); Bmax 100, Kd 5, NS 0.5, Background 2 (Nov 11 recovery check) | R | M+L | Mac PASS Nov 10. Re-run |
| 17 | Enzyme inhibition: mixed, Morrison Ki, Kiapp | `plan17-gui.hlx` (Mac) | Mixed AICc −960.4; Morrison Kiapp 2, v0 100, Ki 1.0 (plan 17 + reference.json enzyme-inhibition, 8 keys) | R | M+L | Mac PASS Nov 11. Re-run |
| 18 | Dose-response special: Schild slope-1 + nM unit trap, EC50 shift, Operational partial | `plan18-gui.hlx` (Mac) | Schild pA2 8; nM trap pA2 −1 (NOT corrected); EC50-shift dose ratio 10; Operational R² 1/1/1, Sy.x 1.440383352e-07, SS 2.489645039e-13, DF 12, N 18 (plan 18 + reference.json dose-response-special, 8 keys). **F-01 re-check:** Operational stats table must SHOW values (Round 1 fix) | R | M+L | Mac PASS Nov 11 with F-01 found; F-01 fixed Round 1 (Linux-proven, Mac proof pending — re-prove on launch tip). Re-run |
| 19 | Chi-square trend + McNemar: trend χ²/p, McNemar χ²/p/OR/CI | `plan19-mac.hlx` (Mac, tables-only — drive wizards fresh) | Trend χ² 17.28 / trend 17.07, McNemar χ² 3.063, p 0.08012, OR 3 [0.9092, 12.76] (plan 19 + reference.json chi-square 9 + mcnemar 4 keys) | R | M+L | Mac PASS Nov 11 (wizard-driven). Re-run |
| 20 | Mixed-effects: AIC/BIC/logLik, fixed effects + p, subject variance | `plan20-mac.hlx` (Mac, tables-only — drive wizard fresh) | AIC 53.66, Treatment 4.966 p 0.02422, subject variance 2.934 (plan 20 + reference.json mixed-effects, 5 keys). Wizard must ASK for the subject factor (Round 1 fix) | R | M+L | Mac PASS Nov 11 (wizard-driven, ~20 s lme4 fit). Re-run |
| 21 | PCA: correlation + covariance, loadings, scores, scree, biplot | `plan21-gui.hlx` (Mac) | PC1 0.9744 corr / 0.9696 cov (plan 21 + reference.json principal-component-analysis, 9 keys) | R | M+L | Mac PASS Nov 11. Re-run |
| 22 | Simulate + Monte Carlo: Mean of P, Power, percentiles | `plan22-gui.hlx` (Mac) | Mean of P 0.4158, Power 11.5 (plan 22 + reference.json monte-carlo, 3 keys) | R | M+L | Mac PASS Nov 11. Re-run |
| 23 | Normality completion: SW/DP/AD/KS + log variants (6/6) | `plan23b-gui.hlx` (Mac — use the b fixture, not the tables-only plan23-gui.hlx) | Plan 23 file + reference.json shapiro-wilk (12 keys); DP in TS, AD via nortest::ad.test, KS base R with Lilliefors caveat (KS P is R's asymptotic value, not SciPy's exact one) | R | M+L | Mac PASS Nov 11 (6/6). Re-run |
| 24 | Outliers: ROUT + Grubbs (incl. iterate/masked) | `plan24-gui.hlx` (Mac) | ROUT Q=1%: 1 outlier; Grubbs Control G 2.458 / P 0.000006392 (plan 24 + reference.json outliers, 8 keys) | R | M+L | Mac PASS Nov 11. Re-run |
| 25 | Multiple comparisons: Šídák, Holm–Šídák, Fisher LSD, Dunn variants | `plan25-gui.hlx` (Mac) | Plan 25 file + reference.json anova post-hoc keys (11 keys incl. sidak/holm/lsd/games-howell/t3) | R | M+L | Mac PASS Nov 11 (6/6). Re-run |
| 26 | Nonlinear framework: 4PL vs 3PL, global fit, compare | `plan26-gui.hlx` (Mac) | Plan 26 file + reference.json nonlinear-regression (compare/global subset). Cases 3a/3b/4 NOT Mac-driven before — **drive them this run** (open gap) | R | M+L | Mac PASS Nov 11 (cases 3a/3b/4 skipped). Re-run + close the skip |
| 28 | Binding competition: two-site + Fit Ki, homologous, one-site Fit Ki | `plan28-mac.hlx` (Mac, tables-only — drive wizards fresh) | Two-site Ki 0.003333/3.333, homologous Kd 0.5, one-site Ki 0.04801 (plan 28 + reference.json binding families) | R | M+L | Mac PASS Nov 11 (3/3 wizard-driven). Re-run |
| 29 | Lines + polynomials: segmental X0, quartic, quintic, model list order | `plan29-mac.hlx` (Mac, tables-only — drive wizard fresh) | Segmental X0 3, quartic R² 0.999, quintic R² 0.9992 (plan 29 + reference.json nonlinear-regression subset). Model list order per Prism. Case 3 overlay kink at X0=3 NOT Mac-driven before — **drive it this run** | R | M+L | Mac PASS Nov 11 (4/4). Re-run + close the overlay skip |
| 30 | K-means: k=2/k=3 raw + std, constant-Y error, scatter graph | `plan30-gui.hlx` (Mac) | Plan 30 file + reference.json k-means (10 keys) | R | M+L | Mac PASS Nov 11. Re-run |
| 31 | Dose-response 3PL/5PL + EC50 comparison: 3PL F, 5PL S + CI | `plan31-gui.hlx` (Mac) | 3PL EC50 comparison F 1205; 5PL S 1.052, CI 0.7295–1.518 (plan 31 + reference.json nonlinear-regression subset) | R | M+L | Mac PASS Nov 11. Re-run |
| 32 | Retire dose-response graph: old graphs migrated to Scatter/Line; no dose-response entry in Graph menu | `plan32-gui.hlx` (Mac) | Migration behavior (no numeric keys — GUI check) | — | M+L | Mac PASS Nov 11. Re-run |
| 33 | New graph types: heatmap, box-violin, volcano, scatter (+ empty-cell heatmap) | `plan33-proof.hlx` (Mac) | Heatmap values 11/14/9, 13/18/10, 15/22/11, 18/27/12; volcano −log10(P) 1.5–3.5, Log2 FC −1…1 (plan 33 + reference.json graph, 42 keys subset) | R | M+L | Mac PASS Nov 11. Re-run. **Also the QAB-1 two-graph MATCH test fixture** (§3) |
| 34 | Welch/Dunnett/Games-Howell/T3: Welch F, post-hoc p tables | `plan34-gui.hlx` (Mac) | Games-Howell Welch F 44.46; Dunnett k−1 = 3 rows (plan 34 + reference.json anova keys) | R | M+L | Mac PASS Nov 11 (4/4). Re-run |
| 35 | Geisser–Greenhouse: ε RM + two-way RM | `plan35-gui.hlx` (Mac) | ε 0.5054 RM / 0.3947 two-way (plan 35 + reference.json rm-anova, 10 keys) | R | M+L | Mac PASS Nov 11. Re-run |
| 36 | Two-way ANOVA one value per cell: additive F, no Interaction row, nonparametric error | `plan36-gui.hlx` (Mac) | Additive Group F 2.286, DFd 2, warning note verbatim; nonparametric error text verbatim (plan 36 + reference.json two-way-anova, 17 keys). Empty-cell deviation (runs additive on remaining obs, DFd 1) is DOCUMENTED, not a fail | R | M+L | Mac PASS Nov 11. Re-run |
| — | Multi-panel figure builder: Figure 1 sidebar/menu, panels A/B render, inspector Panels/Layout/Labels/Legend/Export, round-trip from disk, new figure from graph → Figure 2 | `sample-scratch.hlx` (Mac) + `~/workspace/helix/qa/multipanel-merged/` evidence | Figure checks F-01–F-12 in `tests/checks.ts`; panels draw base chart (not pixel-perfect graph view — known deviation); export NOT clicked in GUI before (native picker freeze risk on Linux/Xvfb) — **attempt export on Mac this run** | R | M+L | Mac PASS Nov 11; Linux PASS 7/7 merged-tree. Re-run + attempt the export click on Mac |
| — | Upstream-deduped (adopted from v1.0.7): survival log-rank + GBW + pairwise Holm/BH, Cox, standard curve, 3PL/5PL, Welch/Dunnett/GH/T3, GG, two-way one-value, exponential/MM fits, fitted curve on XY graph, heatmap/box/violin/volcano/scatter | `sample-scratch.hlx` (Mac) | Log-rank χ² 18.21 (P 0.0001109); Cox LR χ² 15.27, HRs 0.2286/0.3098; standard-curve Patient 1 → X 12.53; 4PL EC50 1.485e-7, R² 0.9987; canonical survival.pzfx log-rank χ²=4.844 (suite-pinned) | R | M+L | Mac PASS Nov 11 deduped re-verify. Re-run. **Canonical survival.pzfx GUI import was never re-driven on Mac (picker navigation flaky via device route) — attempt it this run with a human-usable path; if the picker still can't be driven, record as open gap, do not fake it** |

## §2. Prism-format import / convert (post-merge re-run)

The prism-format branch (`feat/prism-format`, dae89cc) merges into the
launch tip before the QA run. These checks re-run the parity verification
**on the merged tree** — the pre-merge 824/824 does not count for the
launch gate.

| Check | Fixture | Expected (source) | Tol | Plat | Status |
|---|---|---|---|---|---|
| C-04 4PL Control | demo file (`tests/testdata/prism/prism2R-demo_dataset.prism` on merged tree) | Bottom 39.2558, Top 121.794, IC50 17.1832, HillSlope 1.0619; 2 CIs skipped ("undefined" uppers) (`tests/parity.ts`) | P | M+L+S | PASS pre-merge (6/6). **Re-run post-merge** |
| C-04 4PL Treated | demo file | Bottom 31.0799, Top 101.637, IC50 28.9967, HillSlope 0.9759 (parity.ts) | P | M+L+S | PASS pre-merge (6/6). **Re-run post-merge** |
| C-05 survival | demo file | Log-rank χ² 2.0098, p 0.15629; MH HR 0.38008 (CI 0.09978–1.4478); GBW χ² 2.5322, p 0.11155; medians "undefined" → skipped (parity.ts) | P | M+L+S | PASS pre-merge (7/7). **Re-run post-merge** |
| C-12 doctored-value gate | demo file, doctored expectations | 2/2 doctored values FAIL the gate; 0/2 true values fail (parity.ts) | — | S | PASS pre-merge. **Re-run post-merge** |
| g.5 corpus sweep | 66-file corpus (`PRISM_TEST_CORPUS_PRISM10` set) | 824/824 within tolerance pre-merge (184 via RSS arbiter, 0 worse-RSS). **Acceptance: no value regresses vs the pre-merge sweep; count changes are reported, not hidden.** New failures vs pre-merge = FAIL | P | L+S (Linux suite; Mac spot-check C-04/C-05 in GUI) | PASS pre-merge. **Re-run post-merge** |
| .prism import in GUI | demo file via File > Import Prism File… | 14 tables, 3 analyses transferred; 4PL (Control) Bottom 39.26, Top 121.8, EC50 17.18, HillSlope 1.062; survival log-rank χ² 2.01, p 0.1563, MH HR 0.3801 (CI 0.09978–1.448) (VALIDATION.md) | P | M+L | Linux GUI-proven pre-merge; Mac not yet. **Run on both** |
| .hlx → .prism writer + round-trip | `tests/prism-write.ts` (5 checks on format branch) | Round-trip preserves values (format branch suite) | R | S | PASS pre-merge. **Re-run post-merge** |
| Converter CLI (.prism → .hlx) | 66-file corpus + 6 synthetic | 446/446 public + 36/36 synthetic checks (converter branch `61335f7`); **note:** the CLI is STALE post-rebase (emits old `survival-log-rank` key, maps survival tables to `xy`) — the hook-up plan must land first; QA verifies the HOOKED-UP converter, not the stale CLI | — | L+S | Pre-merge CLI numbers do NOT transfer. **Verify post-hook-up** |
| **Convert dialog click-through .prism → .hlx (GUI, Smit's call Nov 13 ~09:47 PT)** | demo file (`tests/testdata/prism/prism2R-demo_dataset.prism`) | Open **File > Convert** from the menu (not the CLI, not Import), pick the .prism fixture, run the conversion in the dialog, save the .hlx, then open the output in the running app: 14 tables + 3 analyses intact, 4PL (Control) Bottom 39.26, Top 121.8, EC50 17.18, HillSlope 1.062. Screenshots: dialog open, conversion run, output open. | P | M+L | **NEW — never had a dedicated Mac/Linux GUI proof (unit-level only). Do NOT mark the converter GUI-proved until this passes on BOTH platforms.** |
| **Convert dialog click-through .hlx → .prism (GUI, Smit's call Nov 13 ~09:47 PT)** | a saved .hlx (e.g. the round-trip .hlx from the QA run) | Open **File > Convert** from the menu, pick the .hlx fixture, run the conversion in the dialog, save the .prism, then verify the output is a valid Prism 10 zip (opens / re-imports with tables + analyses intact). Screenshots: dialog open, conversion run, output verified. | P | M+L | **NEW — same as above, other direction. Both directions must pass on Mac + Linux.** |
| Open-format save nudge | App save flow | Prompt once, remember choice (format branch (f)) | — | M+L | Pre-merge GUI proof exists. **Re-run post-merge** |

## §3. Round 1 + Round 2 fix re-verification (launch-gate items)

These are the fixes the launch build contains. Each must be re-proven on
the launch tip — a fix proven on its own branch is not launch proof.

| Fix | Check | Fixture | Expected | Plat | Status |
|---|---|---|---|---|---|
| QAB-1 (Round 1) | **Two-graph MATCH test (most important):** heatmap inspector MATCH click, then volcano inspector MATCH click in `plan33-proof.hlx` — windows must SURVIVE | `plan33-proof.hlx` | No window loss, no silent data loss, process alive | M (macOS NSMenu fix — Linux cannot prove it) | **Mac proof OUTSTANDING** — gateway blocked the overnight proof; Mac fix-proof take 2 running in parallel. **Launch-gate item: must PASS on Mac before sign-off** |
| QAB-2 (Round 1) | Graph canvas not clipped by inspector at 1000px + 1350px | plan33 heatmap/volcano + plan18 EC50-shift | Heatmap color scale + right column visible; volcano right edge visible; EC50-shift value column visible | M+L | Mac-proven PASS on tip 3772d91 (overnight). Linux PASS. **Re-run on launch tip.** Note: sweep says QAB-2 may be M13 misattributed — re-confirm while fixing M13 (Round 2) |
| F-01 (Round 1) | Plan 18 Operational stats table shows values | `plan18-gui.hlx` | R² 1/1/1, Sy.x 1.440383352e-07, SS 2.489645039e-13, DF 12, N 18 visible at 1000px + 1280px | M+L | Linux PASS. Mac proof pending. **Re-run on launch tip, both platforms** |
| QAB-3 (Round 1) | Date-X import keeps dates as row titles | `x_date.pzfx` / `pypzfx-x_date.pzfx` | All 50 rows dated; warning text true | M+L | Linux PASS 4/4. Mac spot-check. Re-run |
| QAB-4 (Round 1) | 2×2 chi-square uncorrected | `contingency.pzfx` | 8.12 (not 6.416), Fisher p 0.01039, df 1 | M+L | Linux PASS 4/4. Re-run |
| Linux 4PL (Round 1) | Textbook 4PL converges (minFactor fix) | Textbook dose dataset (X log10 −2..2, Y=[2,5,12,30,50,70,88,95,98]) | Converges; values match pinned reference; retry note verbatim; Scatter/Line draws fitted curve | L | Linux PASS. Re-run |
| Quirk-2 (Round 1) | "Project Updated" alert is in-app, dismissible, no orphan dialog | `qa/fix-quirk2/older.hlx` | In-app React dialog, clean dismiss, repeat after relaunch PASS | M+L | Linux PASS. Mac proof pending. Re-run |
| F-02 (Round 2, first) | Logistic Curve graph: non-binary Y shows points OR explicit "Y must be 0/1" message — never silent empty 0..1 axes | Textbook fixture (9 points, Y ≈ 0..100) + binary fixture | Non-binary: all 9 points visible OR explicit message. Binary: points at 0/1, Y 0..1, sigmoid P(Y=1)=0.5 at X=4.5 | M+L | **In Round 2 now.** QA verifies the merged fix on the launch tip |
| B1–B4, M1–M19 (Round 2) | Per-item checks from the queue file (re-check flags apply pre-fix; QA re-verifies the merged fix) | Per queue item (`Quality/Bug-fix queue (after all plans).md` items 7–29) | Per item (each fix carries its own regression test in the suite) | M+L where GUI-visible; S otherwise | **In Round 2 now.** QA appends per-item rows from TRACKING.md at run start; any item parked as blocked = open major/blocker = gate FAIL |
| Triaged app-breaking minors | Any minor triage flags as app-breaking and Round 2 fixes | Per triage doc (`Quality/Minors triage (v1.0 vs v2).md`) | Per item | Per item | **Triage running.** QA appends rows for any stays; empty stays list = nothing to add |

## §4. Import GUI lane + exports + tables (open gaps from Nov 9 — close them this run)

These were NOT covered in any earlier proof. They are launch-gate checks,
not nice-to-haves — the import lane is the first thing a new user touches.

| Check | Fixture | Expected | Plat | Status |
|---|---|---|---|---|
| Import GUI: all 6 fixtures via File > Import Prism File… | `tests/testdata/` ×6 | Each imports ≥1 table, correct type, correct values (see CORPUS.md §4); no hang, no crash | M+L | **OPEN GAP** (Nov 9 import lane stopped at 19:44 PT; Linux proved survival only). **Close this run** |
| Import GUI: drag-and-drop a .pzfx onto the app | `survival.pzfx` | Imports as File-menu path does | M+L | **OPEN GAP** |
| Import GUI: error paths — HugeTable, empty file, corrupt file, .prism picked (pre-hook-up behaviour) | `column_hugetable.pzfx`, `pypzfx-empty.pzfx`, `bad-test.pzfx` (`qa/bad-test.pzfx`), a .prism file | Graceful warned failure / "No tables" message; no crash, no hang; .prism rejection names the converter (FF-F15, Round 2 scope-dependent — check what the launch build does and record it) | M+L | **OPEN GAP** |
| Import GUI: cancel paths — picker Cancel, no file picked | — | Clean dismiss, app unchanged | M+L | **OPEN GAP** |
| Multiple Variables table in GUI: correlation matrix, multiple regression | Fresh table or plan fixture | Matrix renders, values match reference.json correlation-matrix (3 keys) + multiple-regression (2 keys) | M+L | **OPEN GAP (Mac)** — Linux suite-pinned only |
| Contingency table in GUI: chi-square/Fisher | `contingency.pzfx` | χ² 8.12, Fisher p 0.01039 (QAB-4 values) | M+L | **OPEN GAP (Mac)** |
| Graph types in GUI (not yet Mac-driven): Box/Violin, Individual Values, Pie, Donut, XY scatter/bar/area, mean/error | Fresh tables | Each renders with correct values; no clip at 1000px (QAB-2 class) | M | **OPEN GAP (Mac)** — Linux suite-pinned (graph, 42 keys) |
| Export JPG 150 DPI | Any graph | Correct dimensions for 150 DPI, all content present | M+L | **OPEN GAP** |
| Export PNG 600 DPI | Any graph | Correct dimensions for 600 DPI, all content present | M+L | **OPEN GAP** |
| Export PNG 300 DPI + SVG (regression) | Any graph | 300 DPI dimensions; SVG valid (Nov 9: 2000×1437, 70 KB; SVG 8,109 B valid 640×460) | M+L | Covered Nov 9 (Mac) + Round 1. Re-run |
| Post-hoc tests in GUI: Tukey/Bonferroni/Dunn, RM two-way ANOVA, Scheirer-Ray-Hare, Multiple t tests | Plan fixtures (10/25/32 + grouped) | Values match reference.json post-hoc keys | M+L | **OPEN GAP (Mac GUI)** — suite-pinned only |
| Copy button / results copy | Any results view | Results selectable/copyable (UX papercut #2 is v2 — this check is only that existing copy works, not the new button) | M+L | **OPEN GAP** |
| Native `<select>` popup menus | Any wizard with a native select | Clicking a menu item selects it (Nov 9: automation couldn't drive them; a human clicking selects normally — verify by hand on Mac, not by driver) | M | **OPEN GAP — human check** |

## §5. Rebrand verification (launch-gate item — name is TITER)

**Name picked Nov 12 ~10:09 PT: TITER (American spelling, T-I-T-E-R).**
Rebrand apply phase started (coordinated with the Round 2 coordinator at
a clean merge point). Logo is whatever the rebrand lane produces — verify
the applied logo, don't assume one.

| Check | Expected | Plat | Status |
|---|---|---|---|
| Bundle ID is `net.smitpatel.helix` | `Info.plist` / Tauri config shows `net.smitpatel.helix`; no `com.*helix*` upstream ID remains | M+L (Mac DMG + Linux bundle) | **Verify on launch tip** |
| App name + logo applied | Window title, About dialog, DMG name, and icon show **Titer** + the new logo | M+L | **Verify on launch tip** |
| README + code contain no "Helix" mention | `grep -ri helix` over README + src/ returns only the GPL-3.0 modified-fork attribution + historical commit messages (allowed); no UI strings, no comments, no docs mention "Helix" | S (repo check) | **Verify on launch tip** |
| README Buy Me a Coffee link is Smit's own | Link points to Smit's Cricket 07 link (exact link TBD — Smit verifying; do not guess); the Helix owners' link is gone | S | **Verify on launch tip + Smit's link** |
| GPL-3.0 attribution retained | Modified-fork notice crediting mickaphd present in README + LICENSE bundled in the DMG | M+L+S | **Verify on launch tip** (release-paperwork branch 8f5d0a9 covers LICENSE-in-DMG + README links + fork notice — verify it merged and the DMG proves the bundling) |

## §6. Release paperwork verification

| Check | Expected | Plat | Status |
|---|---|---|---|
| LICENSE in the DMG | DMG contains LICENSE (GPL-3.0) | M | Branch `release-paperwork` (8f5d0a9) ready, unmerged. **Needs a Mac DMG build to prove the bundling — verify post-merge** |
| README download links → our releases, exact commit tagged | README links resolve to `smitpatel316/Titer` releases with the launch commit tagged | S | Same branch. Verify post-merge |
| Modified-fork notice | README carries the notice crediting the original Helix author (mickaphd) | S | Same branch. Verify post-merge |

## §7. Suite gate (runs before any GUI work)

| Check | Expected | Status |
|---|---|---|
| `npm run check` clean on launch tip | tsc clean | Must pass before GUI checks start |
| `npm test` green on launch tip (Linux) | All checks + reference + package green; count ≥ 669 (grows with Round 2 + format merge) | Must pass before GUI checks start |
| `npm test` green on Mac | Same suite green on the Mac (Nov 11: 662 on 0473d73; expect higher on launch tip) | Must pass before Mac GUI checks start |
| `cargo check` Linux host | Clean | Must pass |
| Parity re-run post-merge (§2) | C-04/C-05/C-12 + g.5 sweep, no regressions | Must pass before GUI checks start |

## Check counts

| Section | Checks |
|---|---|
| §1 Plan families (36 plans + multi-panel + upstream-deduped) | 39 |
| §2 Prism-format / convert | 11 (9 + 2 new Convert-dialog GUI click-throughs, Nov 13) |
| §3 Round 1 + Round 2 fixes | 7 (Round 1) + 1 (F-02) + 23 (B1–B4, M1–M19) + triaged minors (0 or more) |
| §4 Import GUI / exports / tables | 13 |
| §5 Rebrand | 5 |
| §6 Release paperwork | 3 |
| §7 Suite gate | 5 |
| **Total ready now** | **~106 checks** (plus any triaged app-breaking minors appended at run start) |
| **New vs already covered** | ~13 checks in §4 are entirely new (never run); §5/§6 are new (rebrand/paperwork never verified); everything else is a re-run on the launch tip plus the §1 skipped sub-cases (Plan 26 cases 3a/3b/4, Plan 29 overlay kink, canonical survival.pzfx Mac import, multi-panel export click) |
