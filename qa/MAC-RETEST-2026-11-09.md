# Mac GUI retest — Helix Plans 01, 04, 06, 07

Date: 2026-11-09 (evening, PT). Tester: Atlas (subagent) via paired-Mac computer control.
Mac: Smit's MacBook Air, Smits-MacBook-Air.local, macOS 26.6, arm64. `caffeinate -i -s` (PID 27902) kept it awake; left running.
Project file used: `~/retest/retest.hlx` on the Mac (copy in `~/workspace/helix/qa/retest/retest.hlx`) — 7 tables built from `tests/reference.ts` fixtures. Repo fixtures only; no Mansi files.

## Install finding — the "71c9480" build was NOT what was installed

The installed `/Applications/Helix.app` (binary dated Nov 9 20:21) was built from the Mac clone at **`c1ac377`** (parent `2e99023` = Plan 04), **not** HEAD `71c9480`. Plans 06 (Frequency distribution) and 07 (Kolmogorov-Smirnov) were **absent from the Analysis menu and the New Analysis dialog** in that build — only Bland-Altman (04) was present alongside the older items. The DMG shas verified earlier (`a4baa6bd…`, `b019b134…`) are that 01+04 build.

Consequence: Plans 01 and 04 were retested on the installed `c1ac377` build (valid — that code is unchanged in later commits). Plans 06 and 07 required a rebuild; see "Rebuild" below.

## Plan 04 — Bland-Altman — PASS (build c1ac377)

Table: Column, Method A / Method B, 10 pairs (reference fixture `blandAltman`).
Wizard: first method Method A, second Method B (difference A − B). Ran in GUI, instant (pure TS).

| Stat | Expected | Actual (GUI) |
|---|---|---|
| Bias (mean difference) | −0.36 | −0.36 |
| SD of differences | 0.25033 | 0.2503 |
| Lower limit of agreement | −0.85065 | −0.8507 |
| Upper limit of agreement | 0.13065 | 0.1307 |
| Bias 95% CI | [−0.5391, −0.1809] | [−0.5391, −0.1809] |
| Lower limit 95% CI | [−1.1608, −0.5405] | [−1.161, −0.5405] |
| Upper limit 95% CI | [−0.1795, 0.4408] | [−0.1795, 0.4408] |
| N (pairs) | 10 | 10 |
| Method A mean / SD / SEM / median | 12.15 / 0.7397 / 0.2339 / 12.15 | 12.15 / 0.7397 / 0.2339 / 12.15 |
| Method B mean / SD / SEM / median | 12.51 / 0.7520 / 0.2378 / 12.45 | 12.51 / 0.752 / 0.2378 / 12.45 |

Bland-Altman plot renders: 10 points, solid bias line at −0.36, dashed limits at 0.1307 / −0.8507.
Screenshots: `qa/retest/plan04-bland-altman-result.jpg`, `plan04-bland-altman-plot-inspector-open.jpg`, `plan04-bland-altman-plot-inspector-hidden.jpg`.

## Plan 01 — Simple logistic regression — PASS (build c1ac377)

Table: XY, X 0–9, Response 0,0,0,0,1,0,1,1,1,1 (reference fixture `logistic`). Wizard: outcome = Response. Ran via WebR `glm` in GUI.

| Stat | Expected | Actual (GUI) |
|---|---|---|
| Intercept | −5.857372 | −5.857 (SE 3.949, z −1.483, p 0.138, ns) |
| Slope | 1.301638 | 1.302 (SE 0.84, z 1.55, p 0.1212, ns) |
| Odds ratio | 3.675313 | 3.675 |
| OR 95% CI | [0.708413, 19.067869] | [0.7084, 19.07] |
| Slope 95% CI | [−0.3448, 2.9481] | [−0.3447, 2.948] |
| Null deviance (df) | 13.8629 (9) | 13.86 (9) |
| Residual deviance (df) | 5.0180 (8) | 5.018 (8) |
| McFadden pseudo-R² | 0.638027 | 0.638 |
| AIC | 9.0180 | 9.018 |
| N | 10 | 10 |
| Equation | P(Y=1) = 1 / (1 + exp(−(1.302·X − 5.857))) | same, as shown |

Logistic-curve graph renders: sigmoid 0→1 across X 0–9 with all 10 observed points.
Screenshot: `qa/retest/plan01-logistic-result.jpg`, `qa/retest/plan01-logistic-curve.jpg`.

## QAB-2 (major) — graph canvas clipped by inspector — REPRODUCES (builds c1ac377 AND 9272645)

On the Bland-Altman plot with the inspector open, the x-axis stopped at 12.5 and the two rightmost points (means ≈13.15, ≈13.25) were hidden behind the inspector panel. Hiding the inspector revealed the full axis to 13, both points, and the "Upper limit 0.1307" / "Bias −0.36" / "Lower limit −0.8507" labels. Compare the two plot screenshots. On the rebuilt build, the histogram showed the same clipping: bars "2 to <4" (3), "4 to <6" (3), "6 to <8" (2) visible, the "8 to 10" bar (2) hidden behind the inspector. Still present in the current tip, not fixed.

## QAB-1 (blocker) — MATCH "Choose…" destroys all windows — REPRODUCES (builds c1ac377 AND 9272645)

On the Logistic curve graph, inspector open, MATCH section: first click on "Choose…" did nothing visible (button focused only); **second click destroyed every Helix window**. Process stayed alive (PID 29763 on c1ac377; PID 33367 on 9272645, both 0.0% CPU), System Events reported 0 windows, computer control could no longer observe a target window. No save prompt; the unsaved in-app analyses/graphs from the session were silently lost (the on-disk `retest.hlx` tables were unaffected). Recovered with `pkill -x helix`. Reproduced on both builds — still present in the current tip, not fixed. Do not ship.
Note: the histogram graph's inspector has NO MATCH section (STATISTICS/SERIES/TEXT/AXES/EXPORT only); the blocker was re-confirmed via the Logistic curve graph, where MATCH exists.

## Rebuild (for Plans 06 + 07) — done, installed

- First rebuild attempt built STALE code: `git pull` failed ("divergent branches… need to specify how to reconcile them" — Mac-local `c1ac377` duplicates origin's `70f9592`), but the script had no `set -e`, so it continued and built `c1ac377` again (npm test "All 92 results match"). DMGs `66abc028…` (arm64) / `6b5fc2e0…` (x64) from that run are the OLD build — do not install them.
- Origin had moved on: HEAD `9272645` "Plan 02: Standard-curve interpolation" (= 71c9480 + Plan 00 `670fc68` + `ecd417c` + Plan 02). Plans 06/07 code is unchanged since 71c9480.
- Second rebuild (script fixed with `set -euo pipefail`, `git fetch` + `git reset --hard origin/feat/prism-import-survival`) completed rc=0, npm test **All 116 results match**, no errors. DMGs:
  - arm64 `41f6cd1aea2f0cc681831bf6433db52bacbbcc55dd603814124229b49a1a06a6`
  - x64 `0676d3a9b62afec3ec6d5ad0b5691f58d2e5b8b14cc3e05eec25bb37cb2e79bc`
- Installed arm64 DMG to `/Applications/Helix.app` (copy to `Helix.app.new`, `codesign --verify` clean, then swap; old build removed). Installed binary is **103,634,992 bytes** vs 43,732,992 for the old build — ~2.4× larger, likely Plan 00's bundled R packages. New build verified in the Analysis menu: "Frequency Distribution" (after Descriptive Statistics) and "Kolmogorov-Smirnov Test" (after Compare One Group to a Value) now appear.

## Plan 06 — Frequency distribution — PASS (build 9272645)

Table: Column, Values 2.1, 3.5, 3.9, 4.2, 5.0, 5.8, 6.1, 7.4, 8.0, 9.3 (reference fixture `freqCol`).

Automatic (Sturges) run:
| Stat | Expected | Actual (GUI) |
|---|---|---|
| N | 10 | 10 |
| Number of bins | 4 (Sturges asks 5, pretty() gives 4) | 4 |
| Bin width | 2 | 2 |
| Minimum / Maximum | 2.1 / 9.3 | 2.1 / 9.3 |
| 2 to <4 | count 3, rel 0.30, cum 3, cumfreq 0.30 | 3, 0.3, 3, 0.3 |
| 4 to <6 | 3, 0.30, 6, 0.60 | 3, 0.3, 6, 0.6 |
| 6 to <8 | 2, 0.20, 8, 0.80 | 2, 0.2, 8, 0.8 |
| 8 to 10 | 2, 0.20, 10, 1.00 | 2, 0.2, 10, 1 |
| Mean / SD / SEM / median | 5.53 / 2.231 / 0.7055 / 5.4 | 5.53 / 2.231 / 0.7055 / 5.4 |
| Note | "automatic binning (Sturges' rule asks for 5 bins; R's pretty() breaks give 4: 2, 4, 6, 8, 10)" | same |

Number-of-bins run (count 5, first bin starts at 2 — wizard defaults were count 5, start 2.1; start edited to 2):
| Stat | Expected | Actual (GUI) |
|---|---|---|
| Number of bins / Bin width | 5 / 1.6 | 5 / 1.6 |
| 2 to <3.6 | 2, 0.2, 2, 0.2 | 2, 0.2, 2, 0.2 |
| 3.6 to <5.2 | 3, 0.3, 5, 0.5 | 3, 0.3, 5, 0.5 |
| 5.2 to <6.8 | 2, 0.2, 7, 0.7 | 2, 0.2, 7, 0.7 |
| 6.8 to <8.4 | 2, 0.2, 9, 0.9 | 2, 0.2, 9, 0.9 |
| 8.4 to 10 | 1, 0.1, 10, 1 | 1, 0.1, 10, 1 |
| Note | "5 bins of width 1.6, first bin starts at 2" | same |

Histogram graph renders with touching bars at heights 3 / 3 / 2 (4th bar "8 to 10" hidden only by the QAB-2 inspector clipping; see above).
Screenshots: `qa/retest/plan06-freq-auto.jpg`, `qa/retest/plan06-histogram.jpg`.
(The width-2 manual case gives the same bins as auto and shares the binning code; it was covered by the 116-result `npm test` reference suite, not re-run separately in the GUI.)

## Plan 07 — Kolmogorov-Smirnov — PASS (build 9272645)

Note: the menu action runs immediately with NO wizard — it compares the first two columns with data. To cover all four reference cases, the project file carries one table per case (each case's two groups as the first two columns).

| Case | Expected D / p | Actual (GUI) |
|---|---|---|
| ksShifted (Control vs Treated) | D=1, p=0.0001554 | D=1, p=0.0001554 ***, N 8/8; Control 12.34/1.003/0.3545/12.3; Treated 19.65/1.513/0.5349/19.65 |
| ksSimilar (Control vs Similar) | D=0.25, p=0.9801 | D=0.25, p=0.9801 ns, N 8/8; Control 12.34/1.003/0.3545/12.3; Similar 12.46/0.6781/0.2397/12.4 |
| ksTies (A vs B) | D=0.125, p=1 | D=0.125, p=1 ns, N 8/8; A 13.5/1.195/0.4226/13.5; B 14/1.309/0.4629/14 |
| ksIdentical (X vs Y) | D=0, p=1 | D=0, p=1 ns, N 8/8; X and Y both 12.34/1.003/0.3545/12.3 |

Ties note shown on ksTies and ksIdentical: "Tied values present — P value is asymptotic, not exact." Correct. "Significant ***" badge on ksShifted, "Not significant" on the other three. No cumulative-distribution graph in v1 (follow-on, as planned).
Screenshots: `qa/retest/plan07-ks-shifted.jpg`, `qa/retest/plan07-ks-identical.jpg` (ksSimilar/ksTies values recorded from the live result views).

## Verdict

- **Plans 01, 04, 06, 07: all PASS in the Mac GUI** (01/04 on the c1ac377 build, 06/07 on the 9272645 build). Every checked number matches `tests/reference.json` exactly (to displayed precision).
- **Do NOT ship:** QAB-1 (blocker) and QAB-2 (major) both still reproduce in the current tip (9272645). QAB-1 silently destroys all windows and loses unsaved work; QAB-2 hides the right edge of every graph while the inspector is open.

## Cleanup state

Helix quit (windowless process killed after the QAB-1 retest); no Helix process running. Computer session cc-15 ended. `caffeinate -i -s` (PID 27902) LEFT RUNNING per instructions — Atlas to stop it when the Mac is handed back. Scratch files on the Mac: `~/retest/retest.hlx` (+ the 5 unused `.pzfx` fixtures), `~/helix-rebuild.sh`, `~/helix-rebuild-71c9480.log`, `~/helix-rebuild-9272645.log`. The `helix-mac-alive` hook remains DISABLED.
