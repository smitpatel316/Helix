# Plan 29 GUI Proof — Merged Tree Retest

**Date:** 2026-11-11 ~14:05–14:20 UTC (06:05–06:20 PST)
**Tree:** `5f9901b` "Merge Plan 29: Lines and polynomials completion" (on top of `9584051` Plan 28). No code changed, nothing committed or pushed.
**Verdict: ALL CASES PASS.** No value differed from `tests/reference.json`.

## Build

- The first background build failed mid-link on a disk-quota file-create error (not a code failure). The coordinator freed 4.2 GB and restarted the build; I started no `cargo clean` and no rebuild of my own.
- Fresh log `~/.helix-merge-p29-tmp/build-linux.log`: `BUILD-EXIT:0` ("Finished `release` profile in 1m 58s").
- Binary `src-tauri/target/release/helix`: **103,674,400 bytes (~103 MB)**, built Nov 11 14:04 UTC — healthy size, no quota-corruption symptoms (R engine ready immediately; no analysis stuck on "Running…").

## Method

- Headless under Xvfb **:99** (free; :97 and :98 in use by sibling lanes), openbox + `dbus-run-session`, private `XDG_CONFIG_HOME`/`XDG_DATA_HOME` under `~/.helix-merge-p29-tmp/` (shared `open-projects` untouched). Launch script: `~/.helix-merge-p29-tmp/launch99.sh`; app log `~/.helix-merge-p29-tmp/helix99.log`.
- Fresh "Untitled" project → Table → XY (Table 2) → data typed by hand, the reference XY data (fitted N = 8): X = 0, 1, 2, 3, 4, 5, 6, 8; Y1 = 1.1, 2.9, 5.2, 6.8, 9.1, 11.2, 12.7, 17.3.
- Wizard path per fit: Analysis → New Analysis… → Nonlinear Regression → Y1 → "Another curve…" → model → No weighting → No comparison → fit freely → Run.

## Case 1 — Model list order (Prism order after cubic): PASS

Screenshot `16-wizard3-modellist.png` (also `31-wizard3b.png`). Wizard step 3 lists, in order: Line, Semilog line, Hyperbola (X is concentration), Second order polynomial (quadratic), Third order polynomial (cubic), **Segmental linear regression (two segments)**, **Fourth order polynomial (quartic)**, **Fifth order polynomial (quintic)**, Exponential growth, One-phase decay, Michaelis-Menten, Two-phase decay, Plateau followed by one-phase decay, One-phase association, Allosteric sigmoidal, Substrate inhibition. The three Plan 29 models appear exactly where Prism puts them. The comparison step (step 5) also offers "Also fit Fourth/Fifth order polynomial" (`20-wizard5-compare.png`).

## Case 2 — Segmental linear fit: PASS

Screenshot `22-segmental-running.png`; notes `23-segmental-notes.png`. GUI vs `tests/reference.json` (`segmental-linear`):

| Quantity | GUI | Reference |  |
|---|---|---|---|
| Breakpoint (X0) | 3 | 2.999990678 | ✓ |
| Slope below X0 | 1.953 (95% CI 1.715 to 2.191) | 1.952992009 (1.715296464–2.190687554) | ✓ |
| Slope above X0 | 2.045 (95% CI 1.895 to 2.195) | 2.045039224 (1.89510221–2.194976238) | ✓ |
| R squared | 0.9986 | 0.998594642 | ✓ |
| Sy.x | 0.2384 | 0.2384365781 | ✓ |
| Sum of squares | 0.2843 | 0.284260009 | ✓ |
| Degrees of freedom / N | 5 / 8 | 5 / 8 | ✓ |
| B0 | 1.081, SE 0.1963, t 5.508, p 0.002698 ** | 1.08133851, 0.1963238289, 5.507933071, 0.002697960041 | ✓ |
| B1 | 1.953, SE 0.09247, t 21.12, p <0.0001 **** | 1.952992009, 0.09246760477, 21.12082403, 4.4e-06 | ✓ |
| B2 | 0.09205, SE 0.1336, t 0.6887, p 0.5216 ns | 0.09204721538, 0.1336468333, 0.6887347279, 0.5216377277 | ✓ |
| X0 (coefficient row) | 3, no SE / t / p / CI (—) | 2.999990678, stdError null | ✓ (estimate-only, as designed — X0 fitted by profiling, not `nls()`) |

Notes text matches reference verbatim: "Breakpoint X0 = 3 (fitted by profiling over X: the breakpoint minimising the residual sum of squares); slope below X0 = 1.953, slope above X0 = 2.045."

## Case 3 — Segmental overlay (kink at X0 = 3): PASS

Screenshots `27-overlay.png`, `28-overlay-full.png`, `29-overlay-clean.png`. Graph → Scatter or Line → right-panel STATISTICS → Analysis: Nonlinear regression → "Show fitted curve" + "Show fit results" both on. The continuous hinge line is drawn through all 8 points with the visible kink at X = 3 (slopes 1.953 below / 2.045 above, so the kink is slight, as expected); the on-graph legend reads: Breakpoint (X0) = 3, Slope below X0 = 1.953, Slope above X0 = 2.045, B0 = 1.081, B1 = 1.953, B2 = 0.09205, X0 = 3, R² = 0.9986.

## Case 4 — Quartic fit: PASS

Screenshot `32-quartic-result.png`; notes `33-quartic-notes.png`. GUI vs reference (`quartic`):

| Quantity | GUI | Reference |  |
|---|---|---|---|
| R squared / Sy.x / Sum of squares | 0.999 / 0.2543 / 0.194 | 0.9990410 / 0.2542806 / 0.1939759 | ✓ |
| Degrees of freedom / N | 3 / 8 | 3 / 8 | ✓ |
| B0 | 1.107, SE 0.2499, t 4.428, p 0.02139 * | 1.106827309, 0.2499399131, 4.428373586, 0.02139191004 | ✓ |
| B1 | 1.618, SE 0.5348, t 3.026, p 0.05649 ns | 1.618239625, 0.5347888403, 3.025941275, 0.05649234212 | ✓ |
| B2 | 0.2639, SE 0.3166, t 0.8335, p 0.4657 ns | 0.2639056225, 0.316604511, 0.8335497863, 0.465693278 | ✓ |
| B3 | −0.0584, SE 0.06381, t −0.9153, p 0.4275 ns | −0.05840026774, 0.06380696452, −0.9152647862, 0.4275439528 | ✓ |
| B4 | 0.003966, SE 0.004044, t 0.9807, p 0.3991 ns | 0.003965863454, 0.004043825946, 0.9807206113, 0.3990512726 | ✓ |

Notes carry the overfitting sentence verbatim from reference: "A fourth order polynomial can overfit — it follows the noise as well as the trend, so prefer a lower order unless the extra terms are justified."

## Case 5 — Quintic fit (bonus, same machinery): PASS

Screenshot `35-quintic-result.png`. GUI vs reference (`quintic`): R² 0.9992 (0.9992457), Sy.x 0.2762 (0.2762068), SS 0.1526 (0.1525804), df 2, N 8; B0 1.072 (1.0724), B1 2.234 (2.2343), B2 −0.4417, B3 0.2103, B4 −0.03705 (−0.0371), B5 0.002158 (0.0022). All match.

## Driving quirks (not product failures)

- Menu-bar y-coordinate in this 975×740 window is y≈66, not y≈93 as in the builder's screenshots (different window geometry) — early clicks at y=93 hit dead space. Menu x-positions: Table ≈205, Analysis ≈283, Graph ≈325.
- On wizard step 3, mouse clicks on the Next button twice did not advance the wizard (screenshot byte-identical); pressing Enter (Next is the default button) advanced it. Used Enter for Next/Run thereafter; radio selections by mouse worked throughout.
- The first scatter render showed only X ≤ 6 — the 640×460 px canvas is wider than the visible pane while the inspector is open, so the X = 8 point hid behind the inspector. Hiding the inspector (top-right icon) shows the full plot; overlay screenshots 28/29 are the clean full view.
- The app was killed by exact PID (mine 78565; Xvfb :99 78549; openbox 78558) after the run. The sibling lane's helix (PID 55021, display :97) was untouched. The Untitled project was never saved, so no repo files changed (`git status` clean apart from pre-existing untracked `test-corpus-*` dirs).

## Screenshots

All under `~/workspace/helix/qa/retest-plan29/` (never in the repo):

- `01-launch.png` launch · `10-xytable.png` XY table · `11-xtyped.png` / `12-data.png` data entry · `13-analysis.png` chooser · `14-wizard1.png` Y1 · `15-wizard2.png` curve kind · `16-wizard3-modellist.png` model list · `17–19` step-3/weighting navigation · `20-wizard5-compare.png` comparison · `21-wizard6-run.png` Run · `22-segmental-running.png` segmental result · `23-segmental-notes.png` segmental notes · `24-graphmenu.png` Graph menu · `25-scatter.png` scatter · `26-overlay-dropdown.png` Analysis dropdown · `27-overlay.png` overlay on · `28-overlay-full.png` / `29-overlay-clean.png` full overlay · `30-analysis2.png` second analysis · `31-wizard3b.png` model list again · `32-quartic-result.png` quartic result · `33-quartic-notes.png` quartic notes · `34-wizard3c.png` · `35-quintic-result.png` quintic result
