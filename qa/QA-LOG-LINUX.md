# Helix Linux GUI QA — 2026-11-09 (evening PT) — LINUX

Build: Helix Linux release, branch feat/prism-import-survival HEAD 48f6bff
(picker deadlock fix e4f6e3a + build-script fix 48f6bff).
Host: Hatch Linux VM (Ubuntu 24.04, x86_64), Node v24.22.1, cargo/rustc 1.99.1.
Ground truth: scipy 1.11.4 / numpy 1.26.4 on Hatch, qa/ground-truth/gt.py + gt1.txt
(Mac QA's file, reused) + extensions computed inline below.
Datasets (scratch, Linux window only): same as Mac QA where noted
- Column Table 1: A=[1,2,3,4,5] B=[2,4,6,8,10] C=[5,5,6,6,7]
- XY: X=[1,2,3,4,5], Y=[2,4,6,8,10] (perfect), Y2=[1,3,2,5,4]
- Contingency: [[10,20],[30,40]]

Screenshots: qa/screenshots/lx-*.png (LINUX). Mac shots are 00-03-*.jpg.

## 0. Build & unit verification (LINUX)

- B01 git: HEAD 48f6bff == origin/feat/prism-import-survival 48f6bff238556fa4cb63126932f922eb361871d4. PASS.
- B02 npm ci: exit 0, 162 packages. PASS.
- B03 npm run check (tsc --noEmit): clean. PASS.
- B04 npm test: "All 80 checks pass." + "All 87 results match." (87/87). PASS.
  (13x "cannot compute exact p-value with ties" warnings from R-side reference — same as Mac run, non-fatal.)
- B05 cargo check (Linux host): exit 0. PASS.
- B06 cargo test: 4/4 read_prism_text tests pass. PASS.
- B07 npm run build:linux: exit 0. vite 38.59s; release compile 6m38s
  (box heavily loaded); binary src-tauri/target/release/helix, 43,806,800 bytes,
  md5 02786c9ff2e84fe4c4b23252cefc745d, built Nov 10 03:13. PASS.
  Copied to qa/helix-linux-48f6bff (same md5) so GUI tests run an immutable
  copy. NOTE: a second concurrent `npm run build:linux` (bash pid 42479,
  started 03:11, origin unknown — possibly a sibling agent) was compiling
  the same crate while mine finished; it was gone by 03:16. If a rebuild
  ever rewrites the repo binary mid-test, the qa/ copy is unaffected.
- B08 System deps: all apt -dev packages present (libwebkit2gtk-4.1-dev 2.52.6,
  libgtk-3-dev, librsvg2-dev, libssl-dev, libxdo-dev, zenity, xvfb, openbox,
  dbus-x11, xdg-desktop-portal[-gtk]) — no setup-linux.sh rerun needed.
  NOTE: first `npm run build:linux` failed with `cargo metadata: No such file
  or directory` because cargo is not on PATH in non-login exec shells;
  retry with `export PATH="$HOME/.cargo/bin:$PATH"` (documented in DEV-SETUP.md).

## 1. Parser-direct smoke (LINUX, no GUI)

- P01 tests/linux-smoke.ts: all 6 fixtures OK (column, column_sdn +1 warn,
  contingency, survival→XY 27 rows +1 warn, x_y_rep, x_y_with_strike);
  log-rank on imported survival: chi2=4.8437, df=2, p=0.08876 — matches
  Mac GUI result (4.844 / 0.08876) and R ground truth. PASS.
- P02 corpus smoke (/tmp/corpus-smoke.ts over test-corpus/*.pzfx, 25 files):
  12 OK, 11 WARN, 2 FAIL — see table below. All WARNs are informative
  (summary-data CV/SD/SE/SDN/CVN/low-high/upper-lower warnings, survival-as-XY
  note, X-dates note, X-error note). FAILs are graceful "left out" errors:
  pypzfx-column_hugetable.pzfx (HugeTable unsupported) and
  pypzfx-empty.pzfx (no data columns) — both report "No tables in this file
  could be imported." with no crash. PASS (with 2 known limitations).

| file | result |
|---|---|
| CompetitionBinding.pzfx | OK, 2 tables |
| SaturationBinding.pzfx | OK, 1 table |
| exponential_decay.pzfx | OK, 1 table |
| pypzfx-column.pzfx | OK |
| pypzfx-column_cv.pzfx | WARN (summary CV) |
| pypzfx-column_cvn.pzfx | WARN (summary CVN) |
| pypzfx-column_empty.pzfx | OK (empty table imports) |
| pypzfx-column_hugetable.pzfx | FAIL — HugeTable unsupported (graceful) |
| pypzfx-column_low-high.pzfx | WARN (summary low-high) |
| pypzfx-column_sd.pzfx | WARN (summary SD) |
| pypzfx-column_sdn.pzfx | WARN (summary SDN) |
| pypzfx-column_se.pzfx | WARN (summary SE) |
| pypzfx-column_sen.pzfx | WARN (summary SEN) |
| pypzfx-column_unequal_lengths.pzfx | OK |
| pypzfx-column_upper-lower-limits.pzfx | WARN (summary upper-lower) |
| pypzfx-comma_decimal.pzfx | OK |
| pypzfx-contingency.pzfx | OK |
| pypzfx-empty.pzfx | FAIL — no data columns (graceful) |
| pypzfx-parts_of_whole.pzfx | OK |
| pypzfx-survival.pzfx | WARN (imported as XY, note shown) |
| pypzfx-x_date.pzfx | WARN (X dates kept as row titles) |
| pypzfx-x_error_y_sdn.pzfx | WARN (X error as "XX error" series) |
| pypzfx-x_y_no_rep.pzfx | OK |
| pypzfx-x_y_rep.pzfx | OK |
| pypzfx-x_y_with_strike.pzfx | OK |

## 3. Picker retest (LINUX, priority) — FIXED

- Attempt 1 (03:33-03:37): File > Import Prism File… opened a working GTK
  chooser ("Import Prism File", "GraphPad Prism File" filter) — the Nov 8
  failure (no dialog + frozen UI) did NOT recur. Row survival.pzfx selected;
  Open clicked; path returned; app proceeded to confirmDiscard (doc dirty).
  The save-flow navigation then got confused (see L02 note below); import
  did not complete in attempt 1 — NOT a picker failure.
- Attempt 2 (clean, 03:39-03:44): File > Import Prism File… → chooser
  opened again; Ctrl+L + typed full path
  /home/hatch/workspace/helix/tests/testdata/survival.pzfx + Enter → chooser
  closed, path returned; confirmDiscard dialog appeared ("Do you want to
  save…", Save / Don't Save / Cancel); clicked Don't Save → import ran:
  window retitled "survival", table "Three groups" XY rendered (27 rows,
  Days + Control/Treatment A/Treatment B event codes), alert "Prism File
  Imported" with the survival-as-XY note. PASS — full round-trip, no freeze,
  twice-opened chooser, UI responsive throughout.
- Attempt 3 (column.pzfx, 04:07): same path → imported 1 table "Data 1"
  (Column, Aa=[1,2,3,4], Bb=[100,90,80,70]); alert "Imported 1 table
  from 'column'". Second completed import. PASS. (lx-106)
- Cancel path (04:06): chooser opened, Escape → closed, no import, UI
  responsive. PASS. (lx-105)
- Error path (04:09): garbage file qa/bad-test.pzfx (54 bytes) →
  "Couldn't Import File — Not a valid .pzfx file (expected an element)."
  with OK; existing project untouched, no crash/freeze. PASS. (lx-108)
- PICKER VERDICT (LINUX): **FIXED.** e4f6e3a works on Linux. Evidence:
  qa/screenshots/lx-03-picker-attempt1.png, lx-12-picker2.png,
  lx-13-picker2-path.png, lx-15-after-dontsave.png, lx-16-imported-table.png,
  lx-104-picker3.png, lx-105-after-cancel.png, lx-106-import-column.png,
  lx-108-badfile-step1.png. Drag-and-drop NOT TESTED (no file manager
  under Xvfb).
- T-log-rank GUI (on the imported table): Ctrl+Alt+A → "Survival Analysis
  (Log-Rank Test)" → Chi-square 4.844, df 2, P 0.08876 ns; medians
  Control 211 (n=10), Treatment A 211 (n=10), Treatment B 322 (n=7);
  O/E 8/8.095, 8/4.451, 6/9.455 — EXACT match to parser-direct smoke
  (4.8437/0.08876) and Mac GUI (4.844/0.08876). PASS. (lx-19-logrank.png)

- T-desc (Column A/B/C): A mean 3 SD 1.581 SEM 0.7071 CI 1.037–4.963;
  B mean 6 SD 3.162 SEM 1.414 CI 2.074–9.926; C mean 5.8 SD 0.8367
  SEM 0.3742 CI 4.761–6.839; medians 3/6/6, N=5 each — EXACT match to
  scipy gt1.txt. PASS. (lx-25-descstats-result2.png)
- T-ttest (unpaired Student A vs B): t=-1.897, df=8, P=0.09435 ns, mean
  diff -3, 95% CI -6.646 to 0.6461, R²=0.3103, F(var ratio)=0.25,
  F DFn/DFd 4/4, F P=0.208 ns — EXACT match to scipy + Mac. PASS.
  (lx-35-ttest-result.png). Wizard path: first set A → second set B →
  Unpaired → Gaussian Yes → equal variances Yes → two-tailed.
  NOTE: at wizard step 2 ("Choose the second data set"), three mouse
  clicks on Next did NOT advance it; pressing Return advanced it at once.
  Same coordinates worked for step 1→2 and for Run. Possibly a
  click-focus race in my driving rather than an app bug — UNCONFIRMED;
  keyboard (Return) is reliable throughout the wizards.
- T-anova (one-way A/B/C): F=3.197, DFn=2, DFd=12, P=0.0771 ns,
  R² (eta²)=0.3476 — EXACT match to scipy. PASS. (lx-39-anova-result.png)
- T-corr (XY Table 2, X=[1..5], Y1=2X, Y2=[1,3,2,5,4]): Y1 r=1.0
  P<0.0001; Y2 r=0.8 P=0.1041 ns — EXACT match to scipy gt1.txt. PASS.
  (lx-53-corr-result2.png). IMPORTANT false alarm, resolved: the FIRST
  correlation run showed Y2 r=0.5 P=0.6667 — my data-entry error, NOT an
  app bug. My entry loop did Down after the last value AND Return, so Y1
  landed on rows 2–6 and Y2 on rows 3–7; the app correctly paired by row
  (3 complete pairs X=[3,4,5]/Y2=[1,3,2] → r=0.5, p=0.6667, verified by
  hand). Verified against src/stats/xy/correlation.ts: it delegates to R
  cor.test via pairUp (row-aligned). Deleted Table 2, re-entered with the
  correct pattern (Down between values only, Return after last, Up×5,
  Right) and re-ran — exact match. Lesson: verify row alignment in the
  screenshot BEFORE comparing numbers.
- T-linreg (Y2 on X): Y = 0.8*X + 0.6; slope 0.8 (CI -0.3024 to 1.902);
  intercept 0.6 (CI -3.056 to 4.256); R²=0.64; P(slope≠0)=0.1041 ns —
  EXACT match to scipy. PASS. (lx-56-linreg-result.png)
- T-4pl (XY Table 3, X=log10 dose -2..2, Y=[2,5,12,30,50,70,88,95,98]):
  **FAIL — CONFIRMED (LINUX, MAJOR).** "Sigmoidal, 4PL, X is
  log(concentration)" returns: "This curve could not be fitted to these
  data (step factor 0.000488281 reduced below 'minFactor' of
  0.000976562). Try another model or data set." Reproduced TWICE
  identically (lx-61-4pl-result.png, lx-62-4pl-retry.png). scipy
  curve_fit on the same data converges cleanly: Bottom=-1.35,
  Top=101.35, LogEC50≈0, EC50≈1.0, HillSlope=0.7766, R²=0.99926
  (gt2.txt). Root cause (read-only, src/stats/xy/nonlinear-regression.ts
  L62): the nls() call uses plain Gauss-Newton with fixed starts
  (Bottom=min(y), Top=max(y), LogEC50=median(x), HillSlope=1) and no
  fallback (no algorithm="port", no control tweaks, no alternate starts).
  The module docstring claims these curves "fit reliably in WebR" — this
  textbook dataset disproves that for 4PL-logx. Control: the "Line" (lm)
  model on the SAME data fits fine (R²=0.9662, Intercept 50, Slope 28.2;
  lx-63-line-control.png), so the data path is fine — only the nls 4PL
  fails. Impact: 4PL/EC50 is a headline Prism feature and the core of
  Mansi's dose-response work; the error gives the user no actionable path.
  (Also note: no system R on Hatch to cross-check desktop R; webr R is
  real R, so desktop R would fail identically from these starts.)
- T-graph (Individual Values, Table 1 A/B/C): renders — A points (1–5,
  black, mean 3 + SEM bars) and B points (2–10, gold, mean 6 + SEM bars)
  correct. PASS for render. (lx-69-graph.png)
- T-graph-clip (LINUX, MAJOR — same as Mac QAB-2): the third series C
  (5,5,6,6,7) is NOT visible in the plot although it IS in the graph:
  SERIES section lists A (black), B (gold), C (light blue) and
  individual.ts builds one trace per column. The 640×460 canvas is wider
  than the visible area — its right part sits behind the inspector panel,
  and C (x-index 2, would sit ~230px right of B) is in the hidden part.
  Reproduced across many screenshots; collapsing the inspector via its
  top-right icon did NOT close the panel (that icon is a drag handle, see
  L08). Same defect class as Mac QAB-2, now confirmed on Linux.
  (lx-69, lx-82-series.png, lx-83-panel-collapsed.png)
- T-graph-export (LINUX, MAJOR — EXPORT section will not expand): the
  inspector's EXPORT section did NOT expand after 9 click attempts
  (label/chevron/double-click/slow-press/click+Enter, x=930–1100,
  y=617, before/after panel scroll). Sibling sections in the same panel
  and session DO respond: DATA expanded (1 click), SERIES expanded
  (1 click), STATISTICS Analysis dropdown opened (1 click). The fold()
  mechanism is uniform in code (format-panel.tsx) and export is the ONLY
  path to Save…/Copy (no Graph-menu item, no Plotly modebar — hover shows
  none). So graph export is unreachable in this Linux session. Caveat:
  needs a real-mouse retest to fully exclude an XTest coordinate artifact,
  but the differential evidence (siblings work, EXPORT never responds) is
  strong. (lx-88 through lx-96)
- L08 Inspector drag-handle arms a window drag (LINUX, minor): clicking
  the inspector panel's top-right drag icon (⊟/✥ at ~1115,173) then
  clicking elsewhere MOVED the whole Untitled window by the delta between
  the two clicks — twice: (1115,130)→(960,273) moved it to (8,245);
  (1115,173)→(960,770) moved it ~550px down. The mousedown on the handle
  apparently isn't released, so the next click completes a drag. Restored
  both times via xdotool windowmove. Likely a WebKitGTK/openbox drag
  artifact, not app logic — noted, not counted as an app bug.
- T-chisq (Contingency [[10,20],[30,40]]): Fisher's exact P=0.5045 ns,
  OR=0.6693 (R fisher.test conditional MLE; sample OR=0.6667), Yates
  chi-square 0.4464 "for reference", df=1, N=100, OR 95% CI 0.242–1.764
  — matches R/scipy exactly (Fisher p=0.5045; Yates χ²=0.4464,
  p=0.5040). NOTE (same as Mac QAB-4, LOW): the chi-square shown is the
  Yates-corrected value; Prism reports the uncorrected χ²=0.7937
  (p=0.3730). Fisher is primary and correct. PASS with that note.
  (lx-67-chisq-result.png)
- T-twoway (Grouped Table 1, 2 groups × 3 sub-cols, rows=A1/A2):
  A1B1=[1,2,3], A1B2=[2,3,4], A2B1=[4,5,6], A2B2=[7,8,9]. Ordinary
  two-way ANOVA: Group F=12 (DFn 1, P=0.008516 **), Row F=48 (DFn 1,
  P=0.000121 ***), Interaction F=3 (DFn 1, P=0.1215 ns), DFd=8 —
  EXACT match to scipy gt2.txt (F_A=48, F_B=12, F_AB=3). Grouped table
  creation works (GROUPS panel: Groups 4→2 via − stepper, Sub-columns 3).
  PASS. (lx-116-twoway-result.png)
- T-multreg (Multiple Variables Table 2: Var1=x1=[1..6],
  Var2=x2=[2,1,2,1,2,1], Var3=y=[3,5,7,9,11,13]): Multiple regression
  y~Var1+Var2: Intercept=1, Var1=2, Var2=6.335e-16, R²=1, Adjusted R²=1,
  F=4.03e+31, P<0.0001 — EXACT match to scipy gt1.txt (b0=1, b1=2,
  b2≈0, R²=1). PASS. (lx-125-multreg-result.png) NOTE: my first click on
  the Var 3 radio (circle at 455,537) did NOT register — dependent stayed
  Var 1 (predictors then showed Var 2 + Var 3); clicking the "Var 3"
  LABEL text selected it. Small-radio click misses are a driving
  hazard, not an app bug (same pattern as the wizard Next clicks).
- T-save/open: Ctrl+S → GTK "Save Project" chooser → typed full path
  ~/workspace/helix/qa/qa-linux-test.hlx → saved as
  qa-linux-test.hlx.hlx (8,916 bytes; the app appends .hlx to the typed
  name — expected GTK-filter behavior, not a bug). File is valid JSON
  (schemaVersion 1, project nodes incl. Table 1 A/B/C + analyses).
  Ctrl+O → Recent → double-clicked the file → new window
  "qa-linux-test.hlx" with all 4 tables, 10 analyses and the graph
  restored. Round-trip PASS. (lx-97/98/99/100)
- T-picker-2 (column.pzfx): File > Import Prism File… → chooser →
  Ctrl+L path → Enter → imported: window "column", table "Data 1"
  (Column, Aa=[1,2,3,4], Bb=[100,90,80,70]), alert "Imported 1 table
  from 'column': • Data 1". Second completed import. PASS.
  (lx-106-import-column.png)
- T-picker-cancel: opened chooser, pressed Escape → chooser closed, no
  import, Untitled window responsive. PASS. (lx-105-after-cancel.png)
- T-picker-error: imported qa/bad-test.pzfx (54 bytes garbage text) →
  "Couldn't Import File — Not a valid .pzfx file (expected an element)."
  with OK; existing project untouched, no crash/freeze. PASS.
  (lx-108-badfile-step1.png)
- T-dragdrop: NOT TESTED — no file manager in the Xvfb session to drag
  from; xdotool cross-window drags are unreliable. Needs a real desktop
  or a scripted DnD harness.
- T-table-types: all five created and data-entered in the GUI (Column,
  XY ×2, Grouped, Multiple Variables, Contingency). DONE.
- L05 Grid focus quirk (LINUX, minor/observation): after creating a new
  table via Ctrl+Alt+T, the grid shows a selected cell but typing goes
  nowhere — the grid has no keyboard focus until you CLICK a cell first.
  (lx-42-xydata.png: empty table after 15 typed values.) Workaround:
  click the first cell, then type. Not confirmed as a bug vs. expected
  focus behavior — a fresh table arguably should take focus; noted.
- L05 Grid focus quirk (LINUX, minor/observation): after creating a new
  table via Ctrl+Alt+T, the grid shows a selected cell but typing goes
  nowhere — the grid has no keyboard focus until you CLICK a cell first.
  (lx-42-xydata.png: empty table after 15 typed values.) Workaround:
  click the first cell, then type. Not confirmed as a bug vs. expected
  focus behavior — a fresh table arguably should take focus; noted.
- L06 Click-offset is PER-WINDOW, not global (refines L02): window #1
  (first window, at 141,80) needs ~+48px on grid clicks and ~+30-65px on
  the menu bar; window #2 (Ctrl+N, cascaded at ~163,102) takes grid
  clicks at their visual position (Δ≈0) and centered modals in both
  windows take direct clicks (Δ≈0). Calibrate with one probe click per
  window. Still UNPROVEN whether real-mouse Linux use hits the same
  mapping in window #1; XTEST events are protocol-identical to hardware.
- L07 Delete Table works: Ctrl+Backspace on selected Table 2 → native
  GTK confirm ("Delete 'Table 2'? Its analyses and graphs will be
  deleted too. You can undo this.") → Return → table + its Correlation
  analysis gone, Table 1 untouched. PASS. (lx-50/51)

## 4. GUI tests continued (LINUX, under Xvfb)

- L01 Launch: app renders (menu bar + Table 1 Column grid, 25 rows). PASS.
  (lx-00-launch.png)
- L02 Click-position offset (LINUX, MAJOR, reproduced 6x): synthetic clicks
  land ~1 column LEFT of the visual target in the webview grid, and ~1 menu
  item LEFT in the native menu bar. Evidence: click (438,173) → Title row 1
  (typed 1-5 went into Title, not A); (460,173) → Title; (500,173) → A1;
  (560,173) → B1; menu click (173,71) → Helix menu, (205,71) → File,
  (310,71) → Table menu (not Analysis). Constant-shift model fits the grid
  (app_x ≈ root_x − 48); menu fits a ~0.6 scale or a growing shift — either
  way, clicks must be aimed ~50px right of the visual target (grid) and the
  menu needs +30-65px. Workaround used for the rest of QA: keyboard
  shortcuts (Ctrl+Alt+A/T/G, arrows) + offset-compensated clicks. Whether
  this is an app bug or an Xvfb/WebKitGTK quirk is UNPROVEN — XTEST events
  are protocol-identical to hardware events, so a real Linux mouse would
  very likely hit the same mapping; needs a real-mouse retest to close.
  Note: the offset also explains the lx-01 Title-column accident (data
  entry went to Title; cleared with 6x Ctrl+Z — note: undo did NOT clear
  the dirty flag; confirmDiscard still prompted on import).
- L03 Extra windows during attempt 1 (UNCONFIRMED, not claimed as app bug):
  two sample projects opened in my app instance without my intentional
  input — "Helix Sample" (Help > Sample Project) and "Logistic Plan 01"
  (File > Open… + search "Plan 01.hlx"). Most likely cause: a sibling agent
  concurrently active in this repo (its untracked files
  samples/"Logistic Plan 01.hlx" (created Nov 10 03:15) and
  tmp-logistic-webr.ts appeared/vanished during my session; its mpmath
  Tukey process was seen 03:12) driving the shared :98 display documented
  in DEV-SETUP.md. Only my app process (18517) exists on :98; no second
  Helix instance. Both windows closed cleanly (xdotool windowclose, no
  prompts). If the parent can confirm the sibling's activity, this is
  environmental contamination, not an app bug. Not counted as a failure.
- L04 Container replacement 03:17 PT (uptime 2 min) wiped apt packages
  (xdotool, openbox, libwebkit2gtk-4.1 gone); first launch attempt failed
  `libwebkit2gtk-4.1.so.0: No such file or directory`. os-intent replay held
  the dpkg lock ~25 min (apt-get update + reinstalls); once free, ALL
  setup-linux.sh packages were already restored by the replay — no setup
  run needed. Rebuilt binary copy survived (md5 unchanged).
  (Recorded here; environment, not app.)

## 5. Wrap-up (2026-11-10 ~04:15 PT)

- All five table types created + data-entered in the GUI; 10 analyses run
  vs scipy ground truth (gt1/gt2): 9 PASS exact, 1 FAIL (4PL, confirmed
  2x, MAJOR). Graph renders; save/open round-trip PASS; picker FIXED
  (2 imports + cancel + error path all PASS). Drag-and-drop NOT TESTED.
- Close-out: "column" window (dirty: 2 tables + 2 analyses added after
  import) closed via `xdotool windowclose` with NO save prompt observed —
  work discarded silently. The "survival" window closed via its X button
  DID prompt ("Do you want to save…?") and Don't Save closed it; the
  clean qa-linux-test.hlx window closed without prompting. The
  windowclose-vs-X difference is UNCONFIRMED as an app bug (different
  close methods); needs an X-button retest on a dirty window to close.
- After the last window closed, the app process (pid 18517) LINGERED
  10+s with no windows (still alive at +5s check); terminated cleanly
  with SIGTERM. No frozen/hung process left. Whether lingering is by
  design (Tauri run loop) or a shutdown gap is unconfirmed — noted.
- Evidence: 134 screenshots in qa/screenshots/lx-*.png (the folder also
  holds 15 Mac-QA files — 14 .jpg + export-png-300dpi.png — from the
  sibling agent; those are not mine); saved project
  qa/qa-linux-test.hlx.hlx (8,916 bytes); error-test file
  qa/bad-test.pzfx (54 bytes). QA binary copy
  qa/helix-linux-48f6bff (md5 02786c9ff2e84fe4c4b23252cefc745d).

## 2. GUI tests (LINUX, under Xvfb)

- ENV 2026-11-09 ~03:17 PT: CONTAINER REPLACEMENT mid-QA (uptime 2 min).
  apt packages wiped: xdotool, openbox, libwebkit2gtk-4.1 all gone; Xvfb
  survived (base image). First launch attempt failed to start the app:
  `error while loading shared libraries: libwebkit2gtk-4.1.so.0: No such
  file or directory`. Xvfb :98 (pid 2271) survived. Re-running
  `APT_UPDATE=1 bash scripts/setup-linux.sh` after the dpkg lock frees
  (os-intent replay apt-get pid 2344 held it at 03:17).

## 3. Picker retest (LINUX, priority)

(pending build)

## 2026-11-10 ~23:40 PT — Plan 22 lane observations (pre-existing app behaviours, NOT plan-22 code; for the bug-fix phase)
- Shared-profile cross-talk: all lanes share $HOME + app id, so a fresh Linux launch restores the previous lane's session (e.g. plan21-gui.hlx opened in the plan-22 lane's window). Workaround used: private XDG_CONFIG_HOME/XDG_DATA_HOME per lane. Plan 24 hit the same race (moved its proof to Xvfb :99).
- CLI .hlx argument NOT picked up on a cold Linux start (opened empty "Untitled"); the proof file had to be opened via Ctrl+O.
- Spurious "Project Updated" dialog appears when opening a .hlx file written by the current serializer.
