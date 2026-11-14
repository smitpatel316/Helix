# Plan 26 GUI proof — merged tree retest (verifier)

- Tree: `~/workspace/helix` at `cdd695b` "Merge Plan 26: Nonlinear-regression framework"
  (on top of `1f9b2a1` Plan 25). Nothing committed or pushed by this verifier.
- Build: background `npm run build:linux` finished `BUILD-EXIT:0`
  ("Finished `release` profile in 2m 48s", log
  `~/workspace/.helix-merge-p26-tmp/build-linux.log`). Binary
  `src-tauri/target/release/helix` = **103,671,520 bytes (~103.7 MB)** — healthy,
  no rebuild needed. R/WebR came up; no analysis ever stuck on "Running…".
- Display: Xvfb **:96** (PID 24405) + openbox (PID 24418), app under
  `dbus-run-session` with private XDG dirs under
  `~/workspace/.helix-merge-p26-tmp/xdg-{config,data}` (shared `open-projects`
  untouched). App session PID 24615; left running.
- Fixture: copy of the builder's `qa/plan26/plan26-gui.hlx` at
  `qa/retest-plan26/plan26-gui.hlx` (doseLog table + 4PL-vs-3PL comparison;
  doseTwo table + global fit). Opened via File → Open… (GTK chooser worked).
- Suite was NOT re-run (no code changed; expected 619 green on this tree).

## Results

### Case 1 — 4PL vs 3PL comparison (pre-built analysis) — PASS
`10-compare.png`, `11-compare-scrolled.png`
- "Sigmoidal, 4PL, X is log(concentration)", **Not significant** badge.
- Best-fit: EC50 **0.1439**, 95% CI 0.1378 to 0.1502, Span 97.96, R² 0.9999,
  Sy.x 0.4475, Sum of squares 1.201, df 6, N 10.
- Comparison: **F 2.012, DFn 1, DFd 6, P 0.2058 ns, AICc −5.191,
  ΔAICc (primary — comparison) 3.108**, Sum of squares (comparison model) 1.604.
- Coefficients: **Bottom 1.278** (SE 0.3573, p 0.01167 *),
  **Top 99.24** (SE 0.3272, p <0.0001 ****),
  **LogEC50 −0.842** (SE 0.007679, p <0.0001 ****),
  **Hill slope 0.977** (SE 0.01584, p <0.0001 ****).
- All values match the expected reference values exactly.

### Case 2 — Global fit, shared LogEC50 + HillSlope (pre-built analysis) — PASS
`12-global.png`, `13-global-scrolled.png`
- Best-fit per series: EC50 **0.2434 / 0.2434** (shared), 95% CI 0.2245 to 0.2638
  both; Span 99.95 / 97.5; R² 0.9993 / 0.9993; N 10 / 10.
- All series: R² 0.9993, **Sum of squares 22.24**, Sy.x 1.26, df 14.
- Coefficients: Bottom (Control) 1.571, Bottom (Treated) 0.02939,
  Top (Control) 101.5, Top (Treated) 97.53,
  **LogEC50 −0.6137** (SE 0.01632, p <0.0001 ****),
  **Hill slope 0.9135** (SE 0.02995, p <0.0001 ****).
- All values match the expected reference values exactly.
  (Note: these are the builder's GUI-fixture values — the fixture's Treated
  series differs from `tests/reference.ts` doseTwo, whose global fit is
  SS 338.619 / LogEC50 −0.6161 / HillSlope 0.9045. The fixture values above
  are what the task specified to re-drive, and they reproduce exactly.)

### Case 3a — Compare-model wizard flow (gap the builder left) — PASS
`16-wizard-q1.png` … `46-wizard2-compare.png` (second wizard run)
- Drove the wizard on "Dose-response (4PL vs 3PL)": Y = Response, kind = dose,
  model = 4PL logX, weights = none, then the Plan 26 compareModel question
  ("Also fit another model to the same data and compare (F test + AICc)?")
  → chose "Also fit log(agonist) vs. response, standard slope (3PL)",
  constraints = No → Run.
- The dataset-comparison and global-fit questions were correctly **skipped**
  (single-Y table). The weighting question correctly offered **no 1/SD²**
  option on this single-Y table.
- Wizard-created analysis reproduces the pre-built comparison exactly:
  EC50 0.1439, Span 97.96, R² 0.9999, SS 1.201, df 6, **F 2.012, P 0.2058 ns,
  AICc −5.191, ΔAICc 3.108**, "Not significant".

### Case 3b — Global-fit wizard flow (gap the builder left) — PASS
`16-wizard-q1.png` … `34-wizard-global-scrolled.png` (first wizard run)
- Drove the wizard on "Two curves (global fit)": Y = Control, kind = dose,
  model = 4PL logX, weights = none (1/SD² **offered** — 2 Y columns),
  dataset comparison = No, compareModel = none, global fit = "Yes — fit them
  together", additional sets = Treated (ticked), shared = "The usual ones —
  the curve's midpoint and Hill slope (recommended)", constraints = No → Run.
- Wizard-created analysis reproduces the pre-built global fit exactly:
  EC50 **0.2434 / 0.2434**, **SS 22.24**, R² 0.9993, df 14,
  **LogEC50 −0.6137, Hill slope 0.9135**,
  Bottom (Control) 1.571 / (Treated) 0.02939, Top (Control) 101.5 /
  (Treated) 97.53.

### Case 4 — Global-fit multi-curve graph overlay (gap the builder left) — PASS
`59-scatter-global.png`, `60-graph-zoom.png`
- New "Scatter or Line" graph on the Two curves table; in the STATISTICS panel
  set Nonlinear regression → Analysis = "Global fit (shared LogEC50 +
  HillSlope)", "Show fitted curve" on.
- The graph draws **two sigmoidal curves**: dark through the Control points,
  gold through the Treated points, sharing one midpoint (both cross 50% at
  the same X ≈ −0.61) with different Bottom/Top plateaus — the shared-LogEC50
  + shared-HillSlope global fit, one curve per series, each in its series'
  color (`coefficientsForSet` path).
- Bonus check (`49-graph.png` → `52-graph-logx.png`): the "Dose-Response
  Curve" graph's own fit draws a single curve once its Model is switched to
  "Log X" (EC50 = 0.2164, Hill slope = 0.9548, R² = 0.9999 — a single-curve
  Control-only fit, as designed). With the default "Linear X" model it
  honestly reports "Not enough complete points with X > 0 (3) to fit this
  curve; need at least 5" — expected, since X here is already log-concentration;
  not a Plan 26 defect.

## Environment notes (for the coordinator)

- The container was replaced mid-task (~10:29 PT, uptime reset to 0) just after
  the build finished; the fresh binary survived in `~/workspace`. The
  replacement wiped apt packages; the os-intent replay reinstalled them
  (openbox/xdotool back ~11:00). No rebuild was needed.
- Disk quota blocked writes mid-task (EDQUOT writing screenshots). Freed
  **1.3 GB** by removing the stale `~/workspace/helix-plan26/src-tauri/target`
  (Plan 26 builder lane — already merged; only the target dir, source kept).
  No other lane's work touched. Writes recovered immediately.
- Driving quirk (worth knowing for future GUI verifiers): xdotool clicks land
  ~12–15 px **below** the specified y inside webview dialogs/panels
  (verified by zooming the rendered cursor against `getmouselocation`);
  sidebar/menu clicks land exactly. Compensate with target-y minus 15 for
  dialog/panel controls. Native `<select>` popups and the first click on
  picker rows only highlight — a second click confirms.
- Screenshots 01–60 in this directory are the full step-by-step record
  (launch, menus, open dialog, both pre-built results, both wizard runs,
  both graphs). Dot-prefixed zoom crops were deleted; `60-graph-zoom.png`
  is the kept close-up of the two-curve overlay.
