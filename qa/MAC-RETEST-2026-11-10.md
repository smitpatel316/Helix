# Mac GUI retest — Helix Plans 02, 03, 05, 08, 09, 10, 11, 12, 13, 14, 15, 16

Date: 2026-11-10 (morning, PT). Tester: Atlas (subagent) via paired-Mac computer control (session cc-17).
Mac: Smit's MacBook Air, Smits-MacBook-Air.local, macOS 26.6, arm64. `caffeinate -i -s` (PID 36329) kept it awake; left running.
Project files used: `~/retest/retest-2026-11-10/*.hlx` on the Mac — 12 fixture projects built 2026-11-10 by earlier lanes from the app's own serializer using `tests/reference.ts` fixtures; analysis nodes store params only, no cached results, so every value below was computed live by this build. Repo fixtures only; no Mansi files.
Screenshots: `~/workspace/helix/qa/retest-2026-11-10/` (15 files).

## Install — confirmed

- `/Applications/Helix.app`, version 1.0.6, modified 2026-11-10 08:59, built from origin HEAD **49f1675** "Plan 16: Binding kinetics and saturation" (Mac clone `git log` confirmed). `codesign --verify` passes. `npm test` 454 green on the Mac (per task brief).
- Analysis menu lists all new analyses (Cox PH, Multiple logistic, Poisson, Deming, Nested t, Spline and Lowess, Binding — Saturation/Kinetics, ROC, Three-way ANOVA, Standard-curve interpolation, Exponential curves, Enzyme kinetics). This is the new build, not the Plan 02-era one.
- Every `.hlx` opened shows a "Project Updated" alert (project made with an older Helix; brought up to date). Dismissed with OK every time; **nothing was ever saved** — all projects are scratch copies, on-disk fixtures untouched (mtimes unchanged).

## Plan 02 — standard-curve interpolation — PASS

Analysis > Interpolate From a Standard Curve, doseLog table, Sigmoidal 4PL logx, unknowns 20/50/80. CIs are the plan-locked band-inversion values.

| Stat | Expected | Actual (GUI) |
|---|---|---|
| EC50 | 0.143886 | 0.1439 |
| Span | 97.964 | 97.96 |
| R² | 0.999922 | 0.9999 |
| Sy.x | 0.44747 | 0.4475 |
| SS / df / N | 1.20139 / 6 / 10 | 1.201 / 6 / 10 |
| Bottom / Top | 1.2783 / 99.2422 | 1.278 / 99.24 |
| LogEC50 / HillSlope | −0.8420 / 0.9770 | −0.842 / 0.977 |
| Y=20 → X [CI] | −1.4834 [−1.5056, −1.4614] | −1.483 [−1.506, −1.461] |
| Y=50 → X [CI] | −0.8467 [−0.8604, −0.8330] | −0.8467 [−0.8604, −0.833] |
| Y=80 → X [CI] | −0.2157 [−0.2375, −0.1937] | −0.2157 [−0.2375, −0.1937] |

Screenshot: `retest-2026-11-10/plan02-interpolation.jpg`.

## Plan 03 — three-way ANOVA — PASS

Analysis > Three-Way ANOVA, 'Three-way' grouped table, posthoc none. All 7 terms, DFn 1 each.

| Term | Expected F / p | Actual (GUI) |
|---|---|---|
| A | 126.6761 / 5.18e-09 | 126.7 / <0.0001 |
| B | 211.2669 / 1.22e-10 | 211.3 / <0.0001 |
| C | 34.4906 / 2.36e-05 | 34.49 / <0.0001 |
| A:B | 29.8974 / 5.16e-05 | 29.9 / <0.0001 |
| A:C | 2.7785 / 0.1150 | 2.779 / 0.115 ns |
| B:C | 95.8185 / 3.69e-08 | 95.82 / <0.0001 |
| A:B:C | 8.8110 / 0.00906 | 8.811 / 0.009058 |

Screenshot: `retest-2026-11-10/plan03-three-way-anova.jpg`.

## Plan 05 — ROC curve — PASS

Pre-created analysis node on rocTable (10 diseased / 10 healthy).

| Stat | Expected | Actual (GUI) |
|---|---|---|
| AUC | 0.9700 | 0.97 |
| SE | 0.0302 | 0.03018 |
| 95% CI | [0.9108, 1.0000] (raw upper 1.0292, truncated) | [0.9108, 1] — truncation confirmed |
| Optimal cutpoint (Youden) | 0.71 | 0.71 |
| Sensitivity / specificity at cutpoint | 0.80 / 1.00 | 0.8 / 1 |
| Youden's J | 0.80 | 0.8 |
| N positive / negative | 10 / 10 | 10 / 10 |

Threshold table spot checks consistent (0.95→sens 0.1/spec 1; 0.91→0.2/1; 0.88→0.3/1; 0.84→0.4/1; 0.82→0.5/1; 0.79→0.6/1). ROC graph renders (diagonal chance line, optimal-cutpoint marker at 0.71).
Screenshots: `retest-2026-11-10/plan05-roc-result.jpg`, `plan05-roc-graph.jpg`.

## Plan 08 — exponential curves — PASS (all 5 cases, Nonlinear Regression wizard)

| Case | Expected | Actual (GUI) |
|---|---|---|
| A one-phase decay (Y=A) | Y0 100, Plateau 10, K 0.5, half-life 1.3863, Span 90, R² 1 | half-life 1.386, Span 90, R² 1, Sy.x 2.485e-11, df 7, N 10 |
| B two-phase decay (Y=B) | Plateau 10, Span1 60, K1 1, Span2 30, K2 0.1, half-lives 0.6931 / 6.9315, Span 90, R² 1 | half-lives 0.6931 / 6.931, Span 90, R² 1 |
| C one-phase association (Y=C) | Y0 0, Plateau 100, K 0.3, half-life 2.3105, Span 100, R² 1 | Y0 −1.236e-7 (≈0, float residue), Plateau 100, K 0.3, half-life 2.31, Span 100, R² 1 |
| D2 exponential growth (Y=D2) | Y = 10·exp(0.2·X), Y0 10, K 0.2, doubling 3.4657, R² 1 | Y0 10, K 0.2, doubling 3.466, R² 1 |
| E plateau-decay (Y=E) | X0 2, Y0 100, Plateau 10, K 0.5, half-life 1.386, R² 1 | X0 2, Y0 100, Plateau 10, K 0.5, half-life 1.386, R² 1 |

Not run in GUI: Case D (SSasymp form, Y=D series — Asym 200, R0 10, lrc −1.6094, doubling 3.4657); covered by `npm test` only.
Screenshot: `retest-2026-11-10/plan08-plateau-decay.jpg` (Case E result).

## Plan 09 — enzyme kinetics substrate-velocity — PASS (all 3 cases, pre-created nodes)

| Case | Expected | Actual (GUI) |
|---|---|---|
| A Michaelis-Menten | Y = 100·X/(5+X), Vmax 100, Km 5, Vmax/Km 20, R² 1 | Vmax 100, Km 5, Vmax/Km 20, R² 1, Sy.x 2.399e-11, df 5, N 7 |
| B allosteric sigmoidal | Y = 100·X²/(5²+X²), Vmax 100, Khalf 5, Hill 2, R² 1 | Vmax 100, Khalf 5, Hill 2, R² 1, Sy.x 1.98e-11, df 4, N 7 |
| C substrate inhibition | Y = 100·X/(2+X+X²/10), Vmax 100, Km 2, Ki 10, R² 1 | Vmax 100, Km 2, Ki 10, R² 1, Sy.x 2.675e-11, df 4, N 7 |

MM dose-response graph renders with fitted curve. Screenshot: `retest-2026-11-10/plan09-substrate-inhibition.jpg`.

## Plan 10 — Cox proportional-hazards — PASS (numbers + forest plot + KM curves)

Pre-created Efron analysis (Trt + Age) computed live in the GUI ("Running…" then results). Re-verified a second time after a full app relaunch — identical values.

| Stat | Expected | Actual (GUI) |
|---|---|---|
| Concordance (SE) | 0.6526 (0.08413) | 0.6526 (0.08413) |
| Likelihood-ratio χ² (df, p) | 2.724 (2, 0.2561) | 2.724 (2, 0.2561 ns) |
| Wald χ² (df, p) | 2.62 (2, 0.2698) | 2.62 (2, 0.2698 ns) |
| Score χ² (df, p) | 2.813 (2, 0.245) | 2.813 (2, 0.245 ns) |
| Events / censored / N | 12 / 4 / 16 | 12 / 4 / 16 |
| Trt β (SE, z, p) | −0.9859 (0.6567, −1.501, 0.1333) | −0.9859 (0.6567, −1.501, 0.1333 ns) |
| Trt HR (95% CI) | 0.3731 (0.103, 1.352) | 0.3731 (0.103, 1.352) |
| Age β (SE, z, p) | −0.03508 (0.05984, −0.5861, 0.5578) | −0.03508 (0.05984, −0.5861, 0.5578 ns) |
| Age HR (95% CI) | 0.9655 (0.8587, 1.086) | 0.9655 (0.8587, 1.086) |

(Note: the plan text says events 13/censored 3, but the frozen reference and the task brief say 12/4 — the task's numbers are authoritative and they match.)
Forest plot (Trt + Age) renders: Trt row CI whisker 0.103–1.352, diamond at 0.373; Age row below; log-scaled Hazard ratio axis.
KM curves by Trt render: two step curves (black/gold) with censoring ticks, Percent survival vs Time. Medians read off the steps ≈ **10 vs 18**, matching the plan. (See "Incidents" — the survival node only opened after a relaunch; see also QAB-2 note on the missing legend.)
Breslow and Trt-only Cox nodes were not individually verified in the GUI (same table, same code path; covered by `npm test`).
Screenshots: `retest-2026-11-10/plan10-cox-result.jpg`, `plan10-cox-forest.jpg`, `plan10-survival-curves.jpg`.

## Plan 11 — multiple logistic regression — PASS

| Stat | Expected | Actual (GUI) |
|---|---|---|
| Equation | logit(p) = −4.8326 + 0.0906·Age + 1.9011·Dose | logit(p) = −4.833 + 0.09063·Age + 1.901·Dose |
| Intercept (SE, z, p) | −4.8326 (3.1989, −1.5107, 0.1309) | −4.833 (3.199, −1.511, 0.1309 ns) |
| Age est (SE, z, p) | 0.0906 (0.0718, 1.2627, 0.2067) | 0.09063 (0.07178, 1.263, 0.2067 ns) |
| Dose est (SE, z, p) | 1.9011 (1.5281, 1.2440, 0.2135) | 1.901 (1.528, 1.244, 0.2135 ns) |
| Age OR (95% CI) | 1.0949 (0.9512–1.2603) | 1.095 (0.9512–1.26) |
| Dose OR (95% CI) | 6.6930 (0.3348–133.7829) | 6.693 (0.3348–133.8) |
| Residual deviance (df) / null deviance | 11.4354 (9) / 16.6355 | 11.44 (9) / 16.64 |
| AIC / McFadden pseudo-R² | 17.4354 / 0.3126 | 17.44 / 0.3126 |
| Complete rows / predictors | 12 / 2 | 12 / 2 |

Screenshot: `retest-2026-11-10/plan11-multiple-logistic.jpg`.

## Plan 12 — Poisson regression — PASS (Case A + Case B + quasi-Poisson)

Case A (well-behaved):

| Stat | Expected | Actual (GUI) |
|---|---|---|
| Equation | log(Count) = 0.4735 + 0.4287·Dose + 0.02436·Age | same |
| Intercept (SE, z, p) | 0.4735 (0.7023, 0.6742, 0.5002) | 0.4735 (0.7023, 0.6742, 0.5002 ns) |
| Dose (SE, z, p) / RR (CI) | 0.4287 (0.1178, 3.6383, 0.000274) / 1.5353 (1.2187–1.9342) | 0.4287 (0.1178, 3.638, 0.0002744 ***) / 1.535 (1.219–1.934) |
| Age (SE, z, p) / RR (CI) | 0.0244 (0.0255, 0.9542, 0.3400) / 1.0247 (0.9746–1.0772) | 0.02436 (0.02553, 0.9542, 0.34 ns) / 1.025 (0.9746–1.077) |
| Residual deviance (df) / null deviance | 1.4898 (9) / 24.0778 | 1.49 (9) / 24.08 |
| AIC / Pearson χ² | 51.3667 / 1.5121 | 51.37 / 1.512 |
| Dispersion (deviance / Pearson) | 0.1655 / 0.1680 | 0.1655 / 0.168 |

Case B (overdispersed), standard fit: Dose 0.4512 (SE 0.08952, z 5.04, p <0.0001); residual deviance 95.8 (exp 95.7988); dispersion (deviance) 10.64 (exp 10.6443), (Pearson) 9.14 (exp 9.1402); RR Dose 1.57 (1.317–1.871). Overdispersion warning shown: "Counts are overdispersed (dispersion φ = 9.14) — standard errors and P values are too optimistic. Re-run with quasi-Poisson."
Quasi-Poisson refit: Dose 0.4512, SE **0.2707** (exp 0.2707), z 1.667, p **0.1299** ns — significance flips as designed; quasi dispersion 9.14; **no AIC row** (correct). Observed-vs-fitted graph renders (Observed vs Fitted count axes, linked to Case A analysis).
Screenshot: `retest-2026-11-10/plan12-poisson-quasi.jpg`.

## Plan 13 — Deming regression — PASS (λ=1 and λ=0.25)

| Stat | λ=1 expected | λ=1 actual | λ=0.25 expected | λ=0.25 actual |
|---|---|---|---|---|
| Equation | Y = 0.9764·X + 0.25 | same | Y = 0.9813·X + 0.2228 | same |
| Slope | 0.9764 | 0.9764 | 0.9813 | 0.9813 |
| Slope 95% CI | 0.6998–1.2529 | 0.6998–1.253 | — | 0.7001–1.262 |
| Y-intercept | 0.2500 | 0.25 | 0.2228 | 0.2228 |
| Intercept 95% CI | −1.3314–1.8315 | −1.331–1.832 | — | −1.384–1.83 |
| Lambda | 1 | 1 | 0.25 | 0.25 |
| OLS slope / intercept | 0.9685 / 0.2933 | 0.9685 / 0.2933 | 0.9685 / 0.2933 | 0.9685 / 0.2933 |
| Complete pairs | 10 | 10 | 10 | 10 |

Notes state the 95% CIs are leave-one-out jackknife intervals, for both λ values. Scatter graph renders with both lines labeled "Deming: Y = 0.9764·X + 0.25" and "OLS: Y = 0.9685·X + 0.2933".
Screenshot: `retest-2026-11-10/plan13-deming-scatter.jpg`.

## Plan 14 — nested t test / nested one-way ANOVA — PASS

Nested t (Control vs Treated, subcolumn means [11,13,11] vs [16,17,16]):

| Stat | Expected | Actual (GUI) |
|---|---|---|
| t (df, p) | 6.2610 (4, 0.003320) | 6.261 (4, 0.00332 **) |
| Mean Control / Treated | 11.6667 / 16.3333 | 11.67 / 16.33 |
| Difference of means (95% CI) | 4.6667 (2.5972–6.7361) | 4.667 (2.597–6.736) |

Nested one-way ANOVA: F 60.7778 (df 2,6, p 0.0001041) → GUI 60.78, DFn 2, DFd 6, p 0.0001041 ***; SS between 121.5556 → 121.6; SS within 6.0000 → 6; grand mean 16.2222 → 16.22. Group means Control 11.67, Treated 16.33, High 20.67. Both results carry the note "Ran on subcolumn means — one value per animal/subject, not the individual replicate values". The 3-group table correctly refuses a nested t ("Nested t test needs exactly two groups — this table has 3.").
Screenshot: `retest-2026-11-10/plan14-nested-anova.jpg`.

## Plan 15 — spline / Lowess — PASS (all three smoothers)

| Smoother | Expected | Actual (GUI) |
|---|---|---|
| Lowess f=2/3 | span 0.6667, RSS 161.7778; fitted −3→−1.0097, −1→43.9129, 1.5→101.2181 | span 0.6667, RSS 161.8; fitted −1.01, 43.91, 101.2 |
| Spline spar=0.5 | spar 0.5, eff df 3.7193, RSS 257.4490; fitted −3.7016 / 44.5394 / 104.1698 | spar 0.5, df 3.719, RSS 257.4; fitted −3.702 / 44.54 / 104.2 |
| Spline auto (GCV) | spar ≈ −1.226, df ≈ 10.00, fitted ≈ observed | spar −1.226, df 10, RSS 1.471e-21, fitted = observed (residuals ~1e-11) |

Boundary overshoot 101.2 > 99.1 max on Lowess is expected, not a failure. RSS(spline 0.5) 257.4 > RSS(lowess) 161.8, as expected. Lowess smooth-curve graph renders.
Screenshot: `retest-2026-11-10/plan15-lowess-graph.jpg`.

## Plan 16 — binding kinetics + saturation — PASS (all 5 cases)

| Case | Expected | Actual (GUI) |
|---|---|---|
| One-site total saturation | Y = 100·X/(5+X) + 0.5·X + 2; Bmax 100, Kd 5, NS 0.5, Background 2, R² 1.0 | Equation same; Bmax 100, Kd 5, NS 0.5, Background 2, R² 1, Sy.x 2.644e-11, df 4, N 8 |
| Two-site specific | Y = 60·X/(1+X) + 40·X/(20+X); BmaxHi 60, KdHi 1, BmaxLo 40, KdLo 20, R² 1.0 | Equation same; BmaxHi 60, KdHi 1, BmaxLo 40, KdLo 20, R² 1, Sy.x 3.412e-11, df 6, N 10 |
| Association 1-phase | Y0 0, Plateau 100, Kobs 0.5, half-life 1.3863 | Y0 1.35e-7 (≈0), Plateau 100, Kobs 0.5, half-life 1.386, R² 1 |
| Dissociation 1-phase | Y0 100, Plateau 5, Koff 0.3, half-life 2.3105, residence 3.3333 | Y0 100, Plateau 5, Koff 0.3, half-life 2.31, residence 3.333, R² 1 |
| Two-phase association | Plateau 100, PercentFast 0.7, KFast 1.0, KSlow 0.1 | Plateau 100, PercentFast 0.7, KFast 1.0, KSlow 0.1, half-lives (fast/slow) 0.6931 / 6.931, R² 1 |

Fixture also contains extra cases not in the brief (one-site total+NS, two-site total+NS, two-phase dissociation, assoc-then-dissoc, association+kon, error cases) — not verified in the GUI.
Screenshot: `retest-2026-11-10/plan16-two-phase-association.jpg`.

## QAB-1 (blocker) — second click on graph inspector MATCH "Choose…" — NOT REPRODUCED on build 49f1675

Tested on the Plan 10 survival-curve graph's MATCH "Choose…" control: click 1 — no visible change (focus only, as in the Nov 9 repro); click 2 — no visible change. All 13 project windows intact afterwards, process alive. On builds c1ac377 and 9272645 (Nov 9), click 2 destroyed every window. On 49f1675 it does not — **QAB-1 appears fixed**.
Caveat: the planned second confirmation on a different graph type (Plan 12 observed-vs-fitted scatter) could not run — the paired-Mac device channel went offline mid-retest (see "Incidents"). The single-graph result is solid; re-confirm on a second graph type in a future retest if cheap.

## QAB-2 (major) — graph canvas clipped by the inspector — STILL REPRODUCES on build 49f1675

- Survival curves (Plan 10): the Plotly legend (reference layout places it at x=1.02, just right of the plot) is **not visible** with the inspector open — the fixed 640×460 canvas ends at the inspector boundary.
- Forest plot (Plan 10, morning screenshot `plan10-cox-forest.jpg`): x-axis right end is clipped behind the inspector; the leftmost tick labels "0.08/0.09" render as "8/9".
- The "Hide Inspector" toggle did not produce a usable inspector-hidden comparison in this session (checkbox click returned unconfirmed with no visible change; the top-right panel-icon click was a no-op), so the open-vs-hidden comparison from Nov 9 could not be repeated. Clipping with the inspector open is confirmed present; do not ship on this alone if the legend/clipping matters — QAB-2 is still open.

## Incidents during the retest (findings, not fixes)

1. **Plan 10 window froze mid-session (transient).** After the forest plot was opened, the plan10-gui window stopped responding to all input for ~10 min: sidebar clicks, Graph-menu commands, File > Close, System Events Cmd+W, AXRaise, and AX close-button clicks all dispatched with no effect, while the Helix process sat idle at 0.0–0.2% CPU and other windows in the same session responded normally. The 'Survival curves by Trt' row also rendered dimmed. After a full app relaunch (SIGTERM + `open -a Helix`, session restore), the same window responded normally and the survival node opened on first click. Treat as a transient window/renderer state, not a reproducible bug on this evidence — but note the app can get into a state where one window ignores all input while the process looks healthy.
2. **AppleScript `tell application "Helix" to quit` is refused (-128 "User canceled"), twice.** No dialog is visible and no sheet exists on any window (verified via System Events). Likely blocked by the orphaned dialog below. SIGTERM exits the app cleanly.
3. **Orphaned "Project Updated" dialog window (id 15173, 260×170, empty title, AXDialog).** After dismissing the plan10 window's migration alert, a detached copy of that alert remained as a standalone window. It ignores OK clicks and Escape, and it blocks driver clicks whose point it covers ("Window 15173 covers this point"). It survived a return-key press. It did NOT survive the SIGTERM relaunch cycle (not present after relaunch until the next alert dismissal recreated it — it reappeared after the post-relaunch plan10 alert dismissal). Minor, but it interferes with automation and can block quit.
4. **Container replaced ~09:38 PST (17:38 UTC); paired-Mac device channel went offline and stayed offline.** The Hatch container was replaced mid-retest (runtime restart notice; `/root/.ssh/config` mirror gone, rebuilt via the known playbook; SSH to the Mac restored). At the same time, the Mac's device link (`Smit's MacBook Air`, last seen 17:38:08Z) went offline and did not reconnect after 90+ s — and every other paired device shows offline too, so this is a Hatch-side device-gateway issue after the replacement, not the Mac (SSH to the Mac works, Helix was running, Muse.app on the Mac is alive, caffeinate still running). Consequence: the QAB-1 second-graph confirmation, the inspector-hidden QAB-2 comparison, and the computer-session close (cc-17) could not be completed from the device channel. Cleanup below was done via SSH instead.
5. **Exec-shell file writes failed ~17:34 UTC (pre-restart).** `cp`/`echo >` in exec created 0-byte files then EPERM, in `~/workspace` and `/tmp` alike (disk 38G free); the file tool (`muse.write`) still worked. This report was written with the file tool. The failure cleared with the container replacement. No results were lost (all 15 screenshots were already saved before 17:34).

## Skipped / not verified in the GUI

- Plans 01/04/06/07 — passed on Mac Nov 9, not re-run (per brief).
- Plan 08 Case D (SSasymp form) — `npm test` only.
- Plan 10 Breslow + Trt-only Cox nodes — `npm test` only.
- Plan 16 extra cases (total+NS variants, two-phase dissociation, assoc-then-dissoc, association+kon, error cases) — not in the brief, not verified.
- QAB-1 second-graph confirmation — blocked by the device going offline (see Incidents 4).

## Verdict

- **Plans 02, 03, 05, 08, 09, 10, 11, 12, 13, 14, 15, 16: all PASS in the Mac GUI** on build 49f1675. Every checked number matches `tests/reference.json` (to displayed precision); all checked graphs render.
- **QAB-1 (blocker) does NOT reproduce on this build** — the window-destroying second click is gone on the one graph tested. Re-confirm on a second graph type when the device channel is back.
- **QAB-2 (major) still reproduces** — graph canvas clipped by the inspector (survival legend invisible, forest-plot axis ticks clipped). Still the ship-blocker on the QA side.
- **New observations (not ship-blockers on current evidence):** transient single-window input freeze (Plan 10, recovered by relaunch); AppleScript quit refused (-128); orphaned "Project Updated" dialog window that blocks clicks and likely blocks quit.

## Cleanup state

Helix exited via SIGTERM (AppleScript quit refused, see above); no Helix process running. No project was saved; on-disk fixtures untouched. `caffeinate -i -s` (PID 36329) LEFT RUNNING per instructions — Atlas to stop it when the Mac is handed back. Computer session cc-17 could NOT be ended via the device channel (offline at end of retest) — it should expire server-side; verify it is closed before the next drive. Scratch files on the Mac: `~/retest/retest-2026-11-10/` (12 fixture `.hlx` files). The `helix-mac-alive` hook remains DISABLED.
