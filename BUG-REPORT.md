# Helix Bug Report

Review of `smitpatel316/Helix` (`85f6c91`) with 28 verified findings grouped by severity (14 High, 12 Medium, 2 Low).

---

## Summary of Findings

| # | Severity | Area | Issue Title |
| :- | :--- | :--- | :--- |
| 1 | **High** | Build / CSP / WebR | Release pipeline omits `webr-repo/` and CSP blocks the CDN fallback, breaking all R-package analyses in release builds |
| 2 | **High** | WebR / Multi-window | R package `states` map is not cleared in `resetR()` and is tracked per project window instead of in the shared `engine` window |
| 3 | **High** | Native / IPC | Cancelling an R evaluation in a project window does not trigger `withEvalWatchdog` escalation in `engine` and immediately fails other windows' queued requests |
| 4 | **High** | Stats Caching | `runAnalysis` permanently caches `{ error }` outcomes when runners catch `evalNamedVector` errors, breaking Cancel + Retry |
| 5 | **High** | Nested Tables | `renestTable` (and `.hlx` load reconciliation) overwrites non-first groups' data with `null` after renaming a subgroup in a Nested table |
| 6 | **High** | Store / Rename | Column/group rename (`followTable`) fails to update `y2`, `ys`, `globalY`, `truth`, `score`, `inhibitorConcentrations`, `antagonistConcentrations`, and subgroup point styles |
| 7 | **High** | Figure Export | Figure export passes already-DPI-scaled pixel dimensions as CSS layout size to `Plotly.react` and `Plotly.toImage`, double-scaling raster panels and shrinking text/markers by `dpi / 72` |
| 8 | **High** | Graph Overlays | Weighted linear regression overlay on XY scatter graphs ignores `params.weights`, plotting an unweighted OLS line, confidence band, equation, $R^2$, and $P$ value |
| 9 | **High** | XY Stats (`spline-lowess`) | Smoothing spline (`spline-lowess`) fails and miscomputes RSS whenever X has duplicate/tied values |
| 10 | **High** | XY Stats (`nonlinear-regression`) | Standard-curve interpolation (`interpolate: true`) crashes on `"allosteric-sigmoidal"` and returns negative `[-Km, -Km]` 95% CIs on `"michaelis-menten"` |
| 11 | **High** | XY Stats (`nonlinear-regression`) | Global nonlinear regression (`runGlobalNonlinear`) produces `NaN` $R^2$, drops fixed coefficients, and fails to draw curves when parameters are fixed or when fitting `"homologous-competition-logx"` |
| 12 | **High** | XY Stats (`nonlinear-regression`) | Model comparison (`compareModels` / `params.compareModel`) ignores weights in `lm`/`nls` fits, crashes on `"homologous-competition-logx"`, and skips `prepareFit` validation for `compareModel` |
| 13 | **High** | Column Stats (`frequency-distribution`) | `frequency-distribution.ts`: Infinite loop (OOM/hang) in `binEdges`, `NaN` counts in `prettyBreaks`, and IEEE-754 float mis-binning at exact bin boundaries |
| 14 | **High** | Grouped Stats (`two-way-anova`) | Repeated-measures Two-Way ANOVA Geisser–Greenhouse calculation crashes with `missing value where TRUE/FALSE needed` when any group has only 1 complete subject |
| 15 | **Medium** | Figures UI / Export | Shared legend mode in Figures (`sharedLegend === "shared"`) never hides per-panel legends in the canvas preview or exported figures |
| 16 | **Medium** | Native Menu | Native `Analysis` menu fails to update data-dependent test items (`three-way-anova`, `nested-t-test`, `nested-anova`) when table data or row groups change |
| 17 | **Medium** | Tauri Capabilities | `engine` window capability omits `"dialog:default"`, breaking "Check for Updates…" and missing-file alerts when no project window is open |
| 18 | **Medium** | Nested Tables UI | Cannot rename top-level groups in a Nested table (`startRename` always opens the subgroup editor) |
| 19 | **Medium** | Prism `.pzfx` Import | `.pzfx` import of `TwoWay` replicate tables with untitled/duplicate `<YColumn>` titles, colons in titles, or ragged subcolumns corrupts Grouped tables and loses data on reload |
| 20 | **Medium** | Prism `.pzfx` Import | `.pzfx` import silently drops `Excluded="1"` markers on `<XColumn>` and its error subcolumn |
| 21 | **Medium** | Data Grid | Clearing or overwriting an excluded cell with blank leaves a phantom `*` marker that cannot be toggled off and auto-excludes future values |
| 22 | **Medium** | Project File Save/Load | Save/load round-trip falsely marks valid current-version `.hlx` files as `updated: true` (dirty + "Project Updated" banner) |
| 23 | **Medium** | Multiple / Survival Stats | Constant-variable check in PCA, K-means, and Cox PH runs before complete-case filtering (`pairedGroups`), leaking raw R errors; constant/collinear predictors in `multiple-regression`, `multiple-logistic-regression`, and `poisson-regression` crash with `subscript out of bounds` |
| 24 | **Medium** | Survival Stats | `survival-analysis.ts` and `cox-regression.ts` crash with unhandled R errors when all subjects are censored or a group has no subjects at risk at event times |
| 25 | **Medium** | Mixed / Grouped Stats | `mixed-effects.ts` fails to skip empty rows in Grouped layout and crashes with `subscript out of bounds` on rank-deficient fixed effects; `multiple-t-tests.ts` crashes on a single constant row in unpooled mode |
| 26 | **Medium** | Stats Params / WebR | Partial `AnalysisParams` crash `compare-two-groups`, `nested-anova`, `two-way-anova`, and `multiple-t-tests` (`params ?? DEFAULTS`); `installBatch` omits `timeoutMs` when calling `evalNamedVector` |
| 27 | **Low** | Build / Tests | `scripts/build-mac-dmg.sh` hardcodes version `1.0.6` (project is `1.0.7`); `tests/linux-smoke.ts` crashes in Node because it never calls `startR()` with the filesystem `webr/dist` path |
| 28 | **Low** | Table / Stats Edge Cases | Nested table paste drops overflow columns without warning; `parseProjectFile` misses `kmeansAnalysisId`/`monteCarloAnalysisId` in dangling check; `chi-square.ts` trend test crashes when first row/col has 0% or 100% of counts; `monte-carlo.ts` fails opaquely on constant X |

---

## High-Severity Issues

### Issue 1: Release pipeline omits `webr-repo/` and CSP blocks the CDN fallback, breaking all R-package analyses in release builds
- **Severity**: High
- **Files**:
  - `.github/workflows/release.yml:19-41`
  - `src-tauri/tauri.conf.json:43`
  - `vite.config.ts:45-49`
  - `src/stats/webr.ts:327-329, 673-685`
  - `package.json:10-12`
- **Explanation**:
  1. `webr-repo/` is gitignored (`.gitignore:14`). Neither `.github/workflows/release.yml` nor `package.json`'s `build` scripts run `./scripts/build-webr-repo.sh`.
  2. In `release.yml`'s `check` job, `npm test` runs without `webr-repo/`, so `tests/packages.ts:60-65` prints a warning and exits `0` (skipping all 145 package checks in CI).
  3. In `release.yml`'s `build` job, `vite build` logs a warning (`vite.config.ts:45-49`) and omits `webr-repo/` from `dist/`, assuming package installs will fall back to `CDN_REPO_URL` (`https://repo.r-wasm.org`).
  4. However, `src-tauri/tauri.conf.json:43` sets `"connect-src": "'self' ipc: http://ipc.localhost data: blob: https://api.github.com https://raw.githubusercontent.com"`, which blocks `https://repo.r-wasm.org`.
  5. Consequently, in release DMGs built by GitHub Actions (or `npm run build` on a clean checkout), both `/webr-repo` and the CDN fallback fail, breaking every package-backed analysis (`survival`, `cox`, `cox-proportional-hazards`, `mixed-effects`, and `shapiro-wilk` Anderson–Darling).
- **Minimal Reproduction**:
  Build on a fresh clone (where `webr-repo/` does not exist) via `npm run build` or the `release.yml` workflow, launch the app, open **Help ▸ Sample Project**, and click **Log-rank test** (`a-surv`) or **Cox regression** (`a-surv-cox`).
- **Suggested Fix**:
  Run `./scripts/build-webr-repo.sh` in `.github/workflows/release.yml` (before `npm test` and `tauri-action`) and in `package.json` build scripts, and add `https://repo.r-wasm.org` to `app.security.csp.connect-src` in `src-tauri/tauri.conf.json:43`.

---

### Issue 2: R package `states` map is not cleared in `resetR()` and is tracked per project window instead of in the shared `engine` window
- **Severity**: High
- **Files**:
  - `src/stats/webr.ts:108-111`
  - `src/stats/webr.ts:397-413, 565-568`
  - `src/main.tsx:20`
  - `src/engine.ts:8-19`
- **Explanation**:
  1. `resetR()` (`src/stats/webr.ts:108-111`) sets `engine = null; liveWebR = null;` so the next evaluation boots a fresh `WebR` instance with an empty Emscripten VFS, **but it never clears `states` or `inflight`**. Any previously installed package remains `{ status: "ready" }` in `states`, so `ensurePackages()` becomes a permanent no-op and subsequent runs fail with `there is no package called ‘…’`.
  2. In the native Tauri app, `runAnalysis` calls `ensurePackages()` in each **project window's** JS context while sending `webr::install(...)` R code over IPC (`eval_r`) to the shared **`engine` window**. When `engine.html` reloads (`onEngineStuck` at `src/engine.ts:16-19`), the `engine` window has a fresh R VFS while open project windows still have `states.get(pkg) === { status: "ready" }`.
- **Minimal Reproduction**:
  Run a `survival` or `mixed-effects` analysis so the package is marked `"ready"`, trigger `resetR()` (or a watchdog timeout/cancel reload), and re-run the analysis on edited data: `ensurePackages` skips installation and R throws `there is no package called ‘survival’`.
- **Suggested Fix**:
  Clear `states.clear()` and cancel/clear `inflight` inside `resetR()`, and in native mode either run `ensurePackages` in the `engine` window or broadcast an engine-reset event from `r_ready` in `main.rs` so project windows clear their `states`.

---

### Issue 3: Cancelling an R evaluation in a project window does not trigger `withEvalWatchdog` escalation in `engine` and immediately fails other windows' queued requests
- **Severity**: High
- **Files**:
  - `src/native.ts:89-116`
  - `src-tauri/src/main.rs:563-604`
  - `src/stats/webr.ts:165-226`
- **Explanation**:
  1. When a project window cancels an evaluation, `cancelR()` invokes `cancel_r`, which emits `"r-interrupt"` to `"engine"`. In `src/native.ts:114`, the listener calls `interruptR()` instead of `cancelActiveEvals()`. On Tauri's `PostMessage` channel, `interruptR()` is a no-op (`src/stats/webr.ts:91-94`). Because `cancelActiveEvals()` is never called in `engine`, `engine`'s `withEvalWatchdog` never starts its 5-second `graceTimer` to call `onEngineStuck` and reload `engine.html` — leaving `engine` wedged for the full 5-minute `EVAL_TIMEOUT_MS`.
  2. `cancel_r` (`src-tauri/src/main.rs:593`) calls `waiting.clear()`, dropping every `Sender<RResult>`, which causes `receiver.recv().await` in `eval_r` (`src-tauri/src/main.rs:574`) to immediately return `None` → `Err("R stopped unexpectedly.")` in other open project windows (contrary to the comment claiming dropped requests never resolve).
  3. `requests.ready` (`src-tauri/src/main.rs:557`) is never reset to `false` when `engine` reloads, so requests arriving during reload between `listen("r-eval")` and `invoke("r_ready")` are emitted twice.
- **Minimal Reproduction**:
  Start a long R calculation in a project window and click **Cancel**. The project window shows `"The calculation was cancelled."`, but the `engine` window remains wedged for 5 minutes instead of reloading after the 5s grace period.
- **Suggested Fix**:
  Call `cancelActiveEvals()` in the `"r-interrupt"` listener in `src/native.ts:114`, and track whether waiting requests have already been dispatched (or reset `requests.ready = false` on engine reload).

---

### Issue 4: `runAnalysis` permanently caches `{ error }` outcomes when runners catch `evalNamedVector` errors, breaking Cancel + Retry
- **Severity**: High
- **Files**:
  - `src/stats/index.ts:378-386`
  - `src/stats/mixed/mixed-effects.ts:280-288`
  - `src/views/analyses/analysis-view.tsx:50-55`
- **Explanation**:
  `runAnalysis` (`src/stats/index.ts:378-386`) caches the result promise in `byTest` (`results.get(data)`) and only deletes `key` in `catch (err)`. However, many runners (`runMixedEffects`, `runCoxPH`, `runSplineLowess`, `runNonlinearRegression`, `runBindingSaturation`, `runBindingKinetics`, `runEnzymeInhibition`, `runDoseResponseSpecial`, `runKMeans`) wrap `evalNamedVector` in their own `try / catch` and **return** `{ error: detail }` instead of throwing. When a user cancels a running evaluation (`EvalCancelledError`) or hits a timeout/transient error, the promise resolves to `{ error: "The calculation was cancelled." }` and stays cached in `byTest`. Clicking **Retry** in `AnalysisView` (`setRetryNonce`) calls `runAnalysis` with the same `data` and `params` and immediately gets back the cached cancellation error without re-running R.
- **Minimal Reproduction**:
  Start a `mixed-effects` or `nonlinear-regression` analysis, click **Cancel** while it is running, then click **Retry**: the error `"The calculation was cancelled."` is returned immediately from cache without invoking WebR.
- **Suggested Fix**:
  In `src/stats/index.ts:379`, evict the cache entry whenever `"error" in outcome` (or rethrow `EvalCancelledError` / `EvalTimeoutError` inside runners):
  ```ts
  const outcome = await analysis.run(columns, params, table.titles, data.rowGroups);
  if ("error" in outcome) byTest.delete(key);
  return outcome;
  ```

---

### Issue 5: `renestTable` (and `.hlx` load reconciliation) overwrites non-first groups' data with `null` after renaming a subgroup in a Nested table
- **Severity**: High
- **Files**:
  - `src/views/tables/table-data.ts:271-292` (`renameSubgroup`)
  - `src/views/tables/table-data.ts:325-353` (`renestTable`, `renestLoses`)
  - `src/views/tables/table-view.tsx:73-85`
  - `src/lib/project-file.ts:433-452`
- **Explanation**:
  `renameSubgroup` (`src/views/tables/table-data.ts:273`) renames a subgroup within one group only (e.g., `"A:S1:R1"` → `"A:Mouse 1:R1"`, while Group B retains `"B:S1:R1"`). However, `renestTable` (`src/views/tables/table-data.ts:331`) collects unique subgroup names globally across all columns and slices to `subgroups`:
  ```ts
  const subs = [...new Set(data.columns.slice(1).map((n) => n.split(":")[1] ?? ""))].filter(Boolean).slice(0, subgroups);
  ```
  Because Group A's 3 subgroups (`["Mouse 1", "S2", "S3"]`) fill `subs.slice(0, 3)`, `nestedSubColumns(keys, subs, replicates)` looks for `"B:Mouse 1:R1"` instead of `"B:S1:R1"`. `data.columns.indexOf("B:Mouse 1:R1")` is `-1`, so all values in `"B:S1:R*"` are overwritten with `null`! Moreover, `renestLoses` (`src/views/tables/table-data.ts:350`) reports data loss even when *increasing* groups, subgroups, or replicates.
- **Minimal Reproduction**:
  1. Create a Nested table (2 groups `A`, `B`; 3 subgroups `S1`, `S2`, `S3`; 2 replicates) and enter numbers in `"B:S1:R1"`.
  2. Rename Group A's `"S1"` subgroup to `"Mouse 1"`.
  3. Increase Replicates from `2` to `3` in the toolbar: a bogus confirmation dialog asks `"Delete replicate 3 of each subgroup?"` and confirming deletes all data in `"B:S1:R1"` and `"B:S1:R2"`.
- **Suggested Fix**:
  Collect existing subgroup names **per group** in `renestTable` rather than sharing a single global `subs` list across all groups.

---

### Issue 6: Column/group rename (`followTable`) fails to update `y2`, `ys`, `globalY`, `truth`, `score`, `inhibitorConcentrations`, `antagonistConcentrations`, and subgroup point styles
- **Severity**: High
- **Files**:
  - `src/store/references.ts:19-94`
  - `src/views/tables/grid.tsx:284`
  - `src/stats/index.ts:347-357`
- **Explanation**:
  1. `PARAM_NAMES` in `src/store/references.ts:19-32` omits `y2` (`BindingSaturationParams`), `ys` (`DoseResponseSpecialParams`), `globalY` (`NonlinearRegressionParams`), `truth` (`RocParams`), and `score` (`RocParams`) — even though `runAnalysis` (`src/stats/index.ts:349-357`) validates all five against `table.columns`.
  2. The record-key rename loop (`src/store/references.ts:51-58`) only renames keys in `groupMeans` and `groupSds`, omitting `inhibitorConcentrations` (`EnzymeInhibitionParams`) and `antagonistConcentrations` (`DoseResponseSpecialParams`).
  3. `finishEdit` for `ed.kind === "subgroup"` (`src/views/tables/grid.tsx:284`) calls `update(renameSubgroup(...), "Rename Subgroup")` with no `TableMove`, so per-point style overrides (`options.points`) in that subgroup are dropped.
- **Minimal Reproduction**:
  Run a ROC Curve (`truth`, `score`), Two-Series Binding Saturation (`y2`), Global Nonlinear Fit (`globalY`), or Schild / Enzyme Inhibition analysis (`ys`, `antagonistConcentrations`, `inhibitorConcentrations`), then rename one of the referenced Y columns in the table. The analysis breaks with `Column "…" is not in the table`.
- **Suggested Fix**:
  Add `"y2"`, `"ys"`, `"globalY"`, `"truth"`, and `"score"` to `PARAM_NAMES`; add `"inhibitorConcentrations"` and `"antagonistConcentrations"` to the record-key loop at lines 51–58; and pass `{ renamed }` when renaming a subgroup in `grid.tsx`.

---

### Issue 7: Figure export passes already-DPI-scaled pixel dimensions as CSS layout size to `Plotly.react` and `Plotly.toImage`, double-scaling raster panels and shrinking text/markers by `dpi / 72`
- **Severity**: High
- **Files**:
  - `src/views/figures/figure-export.ts:45-56, 68-78, 128, 197`
  - `src/views/figures/figure-view.tsx:417-418`
  - `src/lib/figure.ts:343`
- **Explanation**:
  In `FigureView` (`src/views/figures/figure-view.tsx:417-418`), panels are laid out at `SCREEN_PX_PER_IN = 72` px/inch (e.g., `360 × 270` CSS px per panel on a 2×2 10×7.5 in figure). In `figure-export.ts`, `geometry(figure, dpi)` computes `rect.width × rect.height` in target `dpi` pixels (e.g., `2048 × 1536` px at 600 DPI) and passes that as `size` into `panelImage`:
  1. `Plotly.react(el, fig.data, { ...fig.layout, ...size })` lays out the panel at `2048 × 1536` CSS pixels while keeping `fontSize: 12`, marker sizes (~7px), line widths (~1.5px), and margins (`16–44px`) unscaled — shrinking all text, markers, lines, and margins by up to `8.33×` relative to the panel.
  2. For PNG/JPEG, lines 55–56 then compute `scale = Number(dpi) / PX_PER_INCH` (`6.25` at 600 DPI) and call `Plotly.toImage(figure, { format, ...size, scale })`, multiplying the already-DPI-scaled `size` by `scale` a **second** time (rendering a `12,800 × 9,600` = 123 MP image per panel before downscaling).
  3. For SVG (`src/views/figures/figure-export.ts:197` + `src/lib/figure.ts:343`), `composeFigureSvg` embeds the `viewBox="0 0 2048 1536"` panel SVG into `<svg width="360" height="270" viewBox="0 0 2048 1536">`, shrinking all panel text and markers in the vector SVG by `72 / dpi`.
- **Minimal Reproduction**:
  Create a Figure with any graph assigned to Panel A, keep the default 600 DPI setting, and export as PNG or SVG. In the exported file, Panel A's axis titles, tick labels, and data points are ~6×–8× smaller than in the Figure preview.
- **Suggested Fix**:
  Lay out each panel in `panelImage` using its unscaled point/CSS dimensions (`panelRects(panels, grid, figureSize, PT_PER_INCH)`), and pass `scale = rect.width / ptRect.width` for raster export (and `scale = 1` with `ptRect` dimensions for SVG).

---

### Issue 8: Weighted linear regression overlay on XY scatter graphs ignores `params.weights`, plotting an unweighted OLS line, confidence band, equation, $R^2$, and $P$ value
- **Severity**: High
- **Files**:
  - `src/views/graphs/regression-overlay.ts:32-49, 93-130`
  - `src/stats/xy/linear-regression.ts:73-81`
- **Explanation**:
  `LinearRegressionParams` supports differential weighting (`weights: "none" | "1/y" | "1/y2" | "1/x" | "1/x2"`) and fits `lm(y ~ x, weights = w)` in R (`src/stats/xy/linear-regression.ts:73-81`). However, `addRegression` (`src/views/graphs/regression-overlay.ts:93-130`) ignores `params?.weights` and always calls unweighted `fitLinear(pairs.x, pairs.y, params?.forceOrigin ?? false)`. As a result, the plotted regression line, 95% confidence band, and on-graph equation (`Y = slope*X + intercept`, `R²`, `P`) show unweighted OLS values that disagree with the linked analysis result.
- **Minimal Reproduction**:
  On an XY table with heteroscedastic data (`(1, 1.1), (2, 1.9), (10, 25), (10, 15)`), run **Linear regression** with `Weighting: 1/Y²`, then link that analysis to an XY scatter graph with **Show equation on graph** enabled. The graph displays the unweighted OLS fit instead of the `1/Y²` weighted fit.
- **Suggested Fix**:
  Support `weights` (`"none" | "1/y" | "1/y2" | "1/x" | "1/x2"`, with the same positivity guards as `linear-regression.ts`) in `fitLinear` and `regressionCurve`, and pass `params?.weights ?? "none"` from `addRegression`.

---

### Issue 9: Smoothing spline (`spline-lowess`) fails and miscomputes RSS whenever X has duplicate/tied values
- **Severity**: High
- **Files**:
  - `src/stats/xy/spline-lowess.ts:95-115`
- **Explanation**:
  In R's `stats::smooth.spline(x, y)`, `fit$x` and `fit$y` store the fitted values at the **unique** sorted knots (`length(unique(x))`), not at each of the `n = length(x)` input observations.
  1. In `fitSmooth` (`src/stats/xy/spline-lowess.ts:95-97`), the `"spline"` branch evaluates `c(fit$y, predict(fit, x=grid)$y)`, returning `length(unique(xs)) + 100` values instead of `n + 100`. Line 112 (`if (values.length !== n + GRID_POINTS)`) then rejects the fit with `"The smoother returned <k+100> values, expected <n+100>."` whenever the XY table has any duplicate/replicate X values.
  2. In `scalarCode` (`src/stats/xy/spline-lowess.ts:102-103`), `rss=sum((y-fit$y)^2)` subtracts `fit$y` (length `length(unique(x))`) from `y` (length `n`), recycling `fit$y` across mismatched observations.
  3. Line 83 checks `n < 4`, not `new Set(xs).size < 4` (which `smooth.spline` requires).
- **Minimal Reproduction**:
  Run `spline-lowess` with `{ method: "spline" }` on an XY table with `X = [1, 1, 2, 3, 4]`, `Y = [2, 2.5, 4, 6, 8]`. It fails with `"The smoother returned 104 values, expected 105."`.
- **Suggested Fix**:
  Check `new Set(xs).size >= (method === "spline" ? 4 : 2)` before calling R, and replace `fit$y` in the `"spline"` branch with `fitted(fit)` (`c(fitted(fit), predict(fit, x=grid)$y)` and `rss=sum((y-fitted(fit))^2)`).

---

### Issue 10: Standard-curve interpolation (`interpolate: true`) crashes on `"allosteric-sigmoidal"` and returns negative `[-Km, -Km]` 95% CIs on `"michaelis-menten"`
- **Severity**: High
- **Files**:
  - `src/stats/xy/nonlinear-regression.ts:629-684`
  - `src/stats/xy/nonlinear-fit.ts:454-493`
  - `src/views/analyses/wizards.ts:1287-1289`
- **Explanation**:
  Because `ENZYME_MODELS` (`"michaelis-menten"`, `"allosteric-sigmoidal"`, `"substrate-inhibition"`) do not set `spec.positiveX = true`, `interpolationCode` (`src/stats/xy/nonlinear-regression.ts:647`) sets `[gLo, gHi] = [lo - w, hi + w]`, which extends into negative concentrations (`gLo < 0`):
  1. **`"allosteric-sigmoidal"` crash**: `g(xg, cf)` evaluates `xv^p[["h"]]` at `xg[1] = lo - w < 0`. For any non-integer Hill slope `h`, `xg[1]^h` is `NaN`, so `fg[1]` is `NaN`. Line 672 (`inc <- fg[length(fg)] > fg[1]`) is `NA`, and line 682 (`if (inc)`) crashes R with `Error in if (inc) { : missing value where TRUE/FALSE needed` on every unknown.
  2. **`"michaelis-menten"` bogus `-Km` CIs**: For $Y = V_{\max} X / (K_m + X)$, whenever $w = \text{hi} - \text{lo} > K_m$, the vertical asymptote $X = -K_m$ lies inside $[g_{\text{Lo}}, \text{lo}]$. Across $X = -K_m$, the hyperbola jumps from $+\infty$ to $-\infty$, producing a sign flip that `firstRoot` (line 669) hits before scanning $X \ge 0$. `uniroot` bisects the vertical pole, so `li[k]` and `hi[k]` converge to `-Km` (reporting 95% CI `[-Km, -Km]` for a positive interpolated concentration).
- **Minimal Reproduction**:
  Fit an XY table with `model: "allosteric-sigmoidal", interpolate: true` (or `model: "michaelis-menten", interpolate: true` with $X \in [0, 20], K_m \approx 5$) and one unknown row with $Y = 50$.
- **Suggested Fix**:
  Clamp `gLo` (and `R_INTERP`'s lower bound) to `>= 0` for `ENZYME_MODELS`, compute `inc` from finite curve values on `[lo, hi]`, and search `[lo, hi]` first before extrapolation intervals in `interpolationCode` (matching `R_INTERP`).

---

### Issue 11: Global nonlinear regression (`runGlobalNonlinear`) produces `NaN` $R^2$, drops fixed coefficients, and fails to draw curves when parameters are fixed or when fitting `"homologous-competition-logx"`
- **Severity**: High
- **Files**:
  - `src/stats/xy/nonlinear-regression.ts:843-1018`
  - `src/views/graphs/fitted-curve.ts:159-167`
- **Explanation**:
  1. **Fixed parameters (`params.fixed`) in global fits**:
     - `runGlobalNonlinear` filters fixed parameters out of `defs` (`src/stats/xy/nonlinear-regression.ts:896`), so `result.coefficients` only contains free parameters.
     - Inside `def.evaluate` (lines 917–929), `perSeries` is built without fixed parameters, so `evaluateCurve` gets `NaN` for fixed terms and returns `NaN` for every point — making all per-series `R squared` values `NaN`.
     - Fixed parameters are never appended to the returned `coefficients` array, so `Span` is omitted when `Top` or `Bottom` is fixed and `addFittedCurve` (`src/views/graphs/fitted-curve.ts:166`) evaluates `NaN` and draws no curves.
  2. **`"homologous-competition-logx"` in global fits**:
     - Line 928 calls `evaluateCurve(model, perSeries, x)` without `params?.ligandConcentration`, lines 1009–1017 omit `ligandConcentration` from the returned `AnalysisOutcome`, and `src/views/graphs/fitted-curve.ts:166` omits `100, fit.ligandConcentration` in the `sets.length > 1` branch.
- **Minimal Reproduction**:
  Run a global nonlinear fit (`globalY: ["Y2"]`) on `sigmoidal-4pl-logx` with `fixed: { Bottom: 0 }` (or on `homologous-competition-logx` with `ligandConcentration: 1`): per-series $R^2$ is blank/`NaN` and no fitted curves appear on the graph.
- **Suggested Fix**:
  Include fixed parameters in `perSeries` inside `def.evaluate` and in the returned `coefficients` array, pass `{ fixed, bounds }` into the per-series start `fitModelSpec` call (line 868), and thread `ligandConcentration` through `evaluateCurve`, `runGlobalNonlinear`'s return object, and `fitted-curve.ts:166`.

---

### Issue 12: Model comparison (`compareModels` / `params.compareModel`) ignores weights in `lm`/`nls` fits, crashes on `"homologous-competition-logx"`, and skips `prepareFit` validation for `compareModel`
- **Severity**: High
- **Files**:
  - `src/stats/xy/nonlinear-regression.ts:729-790, 1036-1055, 1118-1145`
- **Explanation**:
  1. In `runNonlinearRegression`, line 1145 passes the **unmodified** `spec` (not `effSpec = applyFitOptions(spec, fitOpts)`) to `compareModels`, and line 770 creates `specB = modelSpec(otherModel)` without `applyFitOptions(specB, { weights })`. In `compareModelsRCode` (lines 737–740), `w` is defined in R and `ss = sum(w * residuals(m)^2)` is computed, **but neither `specA.fit` nor `specB.fit` passes `weights=w` to `lm()` or `nls()`**. Both models are fitted unweighted while their residuals are weighted afterward, producing wrong estimates and invalid F-test / AICc values.
  2. When `compareModel` is `"homologous-competition-logx"`, `modelSpec(otherModel)` is called without `opts`, leaving R variable `L` unbound (`object 'L' not found`).
  3. `prepareFit` is never called for `otherModel`, so if `otherModel` requires positive X or more data points than `model`, R crashes.
- **Minimal Reproduction**:
  Run `nonlinear-regression` with `{ model: "line", compareModel: "quadratic", weights: "1/y2" }`: both models are fitted unweighted in R.
- **Suggested Fix**:
  Validate `otherModel` via `prepareFit`, pass `{ kiDivisor, ligandConcentration }` to `modelSpec(otherModel)`, and apply `applyFitOptions(..., { weights: params?.weights })` to both `specA` and `specB`.

---

### Issue 13: `frequency-distribution.ts`: Infinite loop (OOM/hang) in `binEdges`, `NaN` counts in `prettyBreaks`, and IEEE-754 float mis-binning at exact bin boundaries
- **Severity**: High
- **Files**:
  - `src/stats/column/frequency-distribution.ts:51-55, 86-90, 119-125`
- **Explanation**:
  1. **Infinite loop in `binEdges` (`width` mode)**: Line 89 runs `while (edges.at(-1)! < max) edges.push(clean(edges.at(-1)! + width));` where `clean(v) = Number(v.toPrecision(12))`. When `width < Math.abs(start) * 1e-12` while `(max - min) / width <= 10000` (e.g., `values = [1e9, 1e9 + 1], binMode: "width", binWidth: 0.0002`, which is 5,000 bins), `clean(1e9 + 0.0002)` rounds back to `1e9` and the `while` loop never terminates.
  2. **`NaN` count in `prettyBreaks`**: Lines 51–54 round `lo / step` and `hi / step` to 12 total significant digits (`toPrecision(12)`), collapsing `start === end` when `(hi - lo) < Math.abs(lo) * 1e-12` and producing `counts = [NaN]`.
  3. **Exact bin boundary mis-binning**: Line 124 computes `Math.floor((v - edges[0]) / width)`. For `values = [0.1, 0.3, 0.5]` (`edges = [0.1, 0.2, 0.3, 0.4, 0.5]`, `width = 0.1`), `(0.3 - 0.1) / 0.1 === 1.9999999999999998`, so `Math.floor` puts `0.3` into bin 1 (`"0.2 to <0.3"`) instead of bin 2 (`"0.3 to <0.4"`).
- **Minimal Reproduction**:
  - `computeFrequencyBins([0.1, 0.3, 0.5], { binMode: "auto" })` places `0.3` in `"0.2 to <0.3"`.
  - `computeFrequencyBins([1e9, 1e9 + 1], { binMode: "width", binWidth: 0.0002 })` hangs forever.
- **Suggested Fix**:
  Build `edges` via index multiplication `start + i * width` rather than repeated `clean(prev + width)` addition, avoid `toPrecision(12)` before `Math.floor`/`Math.ceil` in `prettyBreaks`, and clamp bin index `i` against `edges[i]` / `edges[i + 1]` after `Math.floor`.

---

### Issue 14: Repeated-measures Two-Way ANOVA Geisser–Greenhouse calculation crashes with `missing value where TRUE/FALSE needed` when any group has only 1 complete subject
- **Severity**: High
- **Files**:
  - `src/stats/grouped/two-way-anova.ts:204-241`
- **Explanation**:
  In `runRepeatedMeasures` (`src/stats/grouped/two-way-anova.ts:225`), the pooled covariance matrix `S` is computed via:
  ```r
  S<-Reduce("+",lapply(split(seq_len(nrow(Y)),gs),function(i)(length(i)-1)*cov(Y[i,,drop=FALSE])))/(nrow(Y)-nlevels(gs))
  ```
  If any group has only **1 complete subject** (`length(i) == 1`, e.g., Group A has 3 complete subjects and Group B has 1 after dropping an incomplete replicate column), `cov(Y[i,,drop=FALSE])` returns a matrix of `NA`s, and in R `0 * NA` is `NA` (not `0`). This poisons `S`, `C`, and `ggd` with `NA`, causing `if (ggd > 0)` to crash with `Error: missing value where TRUE/FALSE needed` (even when `sphericity: true`, because `${gg}` is always spliced into `rCode`). Additionally, if *every* group has only 1 complete subject (`nrow(Y) == nlevels(gs)`), residual DF is 0 and `pf(NULL, ...)` crashes with `Non-numeric argument to mathematical function`.
- **Minimal Reproduction**:
  Create a Grouped table where Group A has 3 complete replicate columns and Group B has 1 complete replicate column across 3 rows, and run `two-way-anova` with `design: "repeated-measures"`.
- **Suggested Fix**:
  Require total complete subjects `> groupNames.length` before calling R, and in `gg` skip groups with `length(i) <= 1`: `function(i) if(length(i)>1) (length(i)-1)*cov(Y[i,,drop=FALSE]) else matrix(0,${q},${q})`.

---

## Medium-Severity Issues

### Issue 15: Shared legend mode in Figures (`sharedLegend === "shared"`) never hides per-panel legends in the canvas preview or exported figures
- **Severity**: Medium
- **Files**:
  - `src/views/figures/figure-view.tsx:330-332`
  - `src/views/figures/panel-figure.ts:22-35`
  - `src/views/figures/panel-plot.tsx:25`
  - `src/views/figures/figure-export.ts:38`
- **Explanation**:
  Although the Figure inspector states `"One legend below the grid; per-panel legends are hidden"` when `sharedLegend === "shared"`, `buildPanelFigure` leaves `fig.layout.showlegend = true` untouched, and neither `PanelPlot` nor `panelImage` overrides `showlegend: false`. Every panel continues to render its own legend alongside the shared legend below the grid.
- **Suggested Fix**:
  Set `fig.layout.showlegend = false` in `PanelPlot` and `panelImage` when `figure.sharedLegend === "shared" && legend.ok`.

---

### Issue 16: Native `Analysis` menu fails to update data-dependent test items (`three-way-anova`, `nested-t-test`, `nested-anova`) when table data or row groups change
- **Severity**: Medium
- **Files**:
  - `src/app-menu.ts:219-225, 285-301`
- **Explanation**:
  `useAppMenu` calls `analysisOptionsForTable(tableType, activeTableId ? nodes[activeTableId]?.data : undefined)`, which inspects `data` to decide whether to show `"three-way-anova"`, `"nested-t-test"`, or `"nested-anova"`. However, the `useEffect` dependency array (lines 285–301) omits `nodes[activeTableId]?.data`. Once `isDirty` is `true` and consecutive cell edits share the same `undoName`, the effect does not re-run and the native macOS `Analysis` menu stays stale.
- **Suggested Fix**:
  Include a key derived from `analysisOptionsForTable(tableType, activeTableData).map((o) => o.value).join(",")` in `useAppMenu`'s `useEffect` dependency array.

---

### Issue 17: `engine` window capability omits `"dialog:default"`, breaking "Check for Updates…" and missing-file alerts when no project window is open
- **Severity**: Medium
- **Files**:
  - `src-tauri/capabilities/engine.json:1-7`
  - `src/engine.ts:22-31`
  - `src/menus.ts:30-39`
  - `src/updates.ts:11-24`
- **Explanation**:
  When all project windows are closed, the hidden `engine` window owns the windowless menu bar (`src/engine.ts:22-31`). Clicking **Helix ▸ Check for Updates…** or a missing file in **File ▸ Open Recent** runs `message()` from `@tauri-apps/plugin-dialog` inside the `engine` window, which fails with a permission error because `src-tauri/capabilities/engine.json:6` only grants `["core:default"]`.
- **Suggested Fix**:
  Add `"dialog:default"` to `"permissions"` in `src-tauri/capabilities/engine.json:6`.

---

### Issue 18: Cannot rename top-level groups in a Nested table (`startRename` always opens the subgroup editor)
- **Severity**: Medium
- **Files**:
  - `src/views/tables/grid.tsx:252-261, 679-690`
  - `src/views/tables/grid-menu.ts:96-99`
- **Explanation**:
  Double-clicking the top-level Group header row in `src/views/tables/grid.tsx:690` calls `startRename(lo)`. Because `startRename` checks `if (nested && c > 0)` first and sets `editing.kind = "subgroup"`, `editing.kind === "group"` is unreachable in Nested tables, and `grid-menu.ts` only offers `"Rename Subgroup"`.
- **Suggested Fix**:
  Add a `startRenameGroup(c)` helper for the Group header row in `grid.tsx` and add `"Rename Group…"` to the context menu in `grid-menu.ts` for Nested tables.

---

### Issue 19: `.pzfx` import of `TwoWay` replicate tables with untitled/duplicate `<YColumn>` titles, colons in titles, or ragged subcolumns corrupts Grouped tables and loses data on reload
- **Severity**: Medium
- **Files**:
  - `src/lib/pzfx.ts:362-371`
  - `src/lib/project-file.ts:427-432`
- **Explanation**:
  In `importTable`'s `TwoWay` replicate branch (`src/lib/pzfx.ts:362-371`):
  1. Untitled `<YColumn>`s all get `group = "Group"` (not deduplicated), producing duplicate column names `"Group:Y1"` that merge groups and overwrite subsequent groups with `null` on `.hlx` save/reload (`regroupTable`).
  2. `<YColumn>` titles containing `:` (e.g. `"1:10"`) produce `"1:10:Y1"`, which `seriesKeyOf` splits at the first `:` as group `"1"`, wiping the group's data on save/reload.
  3. Ragged `<Subcolumn>` counts across `<YColumn>`s are not padded to `replicates`, breaking `1 + groups * replicates` indexing in `grid.tsx`.
- **Suggested Fix**:
  Sanitize `:` in group titles, deduplicate group names across `yColumns`, and pad each `<YColumn>` to `replicates` subcolumns.

---

### Issue 20: `.pzfx` import silently drops `Excluded="1"` markers on `<XColumn>` and its error subcolumn
- **Severity**: Medium
- **Files**:
  - `src/lib/pzfx.ts:284-293, 385-390`
- **Explanation**:
  `readSubcolumn` parses `<d Excluded="1">` into `sub.excluded`, but `src/lib/pzfx.ts:386-389` hardcodes `excluded: new Set()` when pushing the X column and X error column. Struck-through X values in Prism XY or Survival tables become active data points in Helix.
- **Suggested Fix**:
  Preserve `xColumns[0].subcolumns[0]?.excluded ?? new Set()` (and `subcolumns[1]?.excluded`) when pushing the X and X error columns.

---

### Issue 21: Clearing or overwriting an excluded cell with blank leaves a phantom `*` marker that cannot be toggled off and auto-excludes future values
- **Severity**: Medium
- **Files**:
  - `src/views/tables/table-data.ts:108-173` (`writeBlock`, `fillRange`, `valueKeys`)
  - `src/views/tables/grid.tsx:828`
- **Explanation**:
  Clearing an excluded cell via Delete/Backspace (`fillRange`) or typing blank (`writeBlock`) sets `rows[r][c] = null` without removing `"${r},${c}"` from `data.excluded`. `Cells` (`src/views/tables/grid.tsx:828`) renders `after:content-['*']` on the empty cell, `valueKeys` ignores empty cells so `⌘E` cannot remove the `*`, and any number entered into that cell later is automatically excluded.
- **Suggested Fix**:
  Remove `"${r},${c}"` from `excluded` whenever a cell is set to `null` in `fillRange` and `writeBlock` (and for trimmed cells in `trimData`).

---

### Issue 22: Save/load round-trip falsely marks valid current-version `.hlx` files as `updated: true` (dirty + "Project Updated" banner)
- **Severity**: Medium
- **Files**:
  - `src/lib/project-file.ts:481, 700-708, 766`
  - `src/views/analyses/wizards.ts:1673`
  - `src/store/use-project-store.tsx:92`
- **Explanation**:
  `parseProjectFile` sets `updated = ... || contents(read) !== contents(file.project)`. Two paths produce a mismatch on fresh v1 files saved by Helix:
  1. The `spline-lowess` wizard (`src/views/analyses/wizards.ts:1673`) sets `spar: null` when left blank; on reload, `readParam("number", null)` returns `undefined`, stripping `spar` and triggering `updated: true`.
  2. `addTable` (`src/store/use-project-store.tsx:92`) appends new table IDs after existing figure IDs in `rootOrder`, whereas `parseProjectFile` (`src/lib/project-file.ts:708`) reorders `rootOrder` into `[...tableOrder, ...figureOrder]`, triggering `updated: true`.
- **Suggested Fix**:
  Use `spar: sparRaw === "" ? undefined : Number(sparRaw)` in `wizards.ts:1673`, and insert new table IDs before figure IDs in `addTable`.

---

### Issue 23: Constant-variable check in PCA, K-means, and Cox PH runs before complete-case filtering (`pairedGroups`), and constant/collinear predictors crash `multiple-regression`, `multiple-logistic-regression`, and `poisson-regression`
- **Severity**: Medium
- **Files**:
  - `src/stats/multiple/principal-component-analysis.ts:39-53`
  - `src/stats/multiple/k-means.ts:41-55`
  - `src/stats/survival/cox-ph.ts:83-106`
  - `src/stats/multiple/multiple-regression.ts:38-45`
  - `src/stats/multiple/multiple-logistic-regression.ts:72-82`
  - `src/stats/multiple/poisson-regression.ts:69-83`
- **Explanation**:
  1. PCA, K-means, and Cox PH check `sd(c.values) === 0` before calling `pairedGroups(...)`. If a column varies only on rows where another selected column is blank, `aligned[i]` is constant after complete-case filtering, causing `prcomp` / `scale` / `coxph` to fail with raw R errors (`cannot rescale a constant/zero column`, `NA/NaN/Inf in foreign function call`).
  2. In `multiple-regression`, `multiple-logistic-regression`, and `poisson-regression`, when a predictor is constant or collinear, R's `summary(m)$coefficients` drops the aliased row (`nrow(co) < p + 1`), so `co[${t + 1}, 1]` crashes with `subscript out of bounds`.
- **Suggested Fix**:
  Run the zero-variance check on `aligned` (after `pairedGroups`), and in the regression runners check `any(is.na(coef(m)))` in R before indexing `summary(m)$coefficients`.

---

### Issue 24: `survival-analysis.ts` and `cox-regression.ts` crash with unhandled R errors when all subjects are censored or a group has no subjects at risk at event times
- **Severity**: Medium
- **Files**:
  - `src/stats/survival/base.ts:15-26`
  - `src/stats/survival/survival-analysis.ts:32-41`
  - `src/stats/survival/cox-regression.ts:23-30`
- **Explanation**:
  `survivalGroups` does not verify that any events (`status === 1`) exist. When all observations are censored (`0`) — or when a pairwise Gehan comparison has 0 events — `solve(V[1:m, 1:m, drop=FALSE], Z[1:m])` in `survival-analysis.ts` crashes with `Lapack routine dgesv: system is exactly singular`, and `survival::cox.zph(f)` in `cox-regression.ts` crashes with `there are aliased coefficients in the model`.
- **Suggested Fix**:
  Require at least 1 event in `survivalGroups` (and guard `quad(Z, V)` with `tryCatch(..., error=function(e) NA_real_)` in `survival-analysis.ts` and check `!any(is.na(coef(f)))` before `cox.zph(f)` in `cox-regression.ts`).

---

### Issue 25: `mixed-effects.ts` fails to skip empty rows in Grouped layout and crashes with `subscript out of bounds` on rank-deficient fixed effects; `multiple-t-tests.ts` crashes on a single constant row in unpooled mode
- **Severity**: Medium
- **Files**:
  - `src/stats/mixed/mixed-effects.ts:102-121, 259-263`
  - `src/stats/grouped/multiple-t-tests.ts:51-53`
- **Explanation**:
  1. `flattenGroupedMixed` iterates over all `r < rowCount` without skipping completely empty rows (unlike `flattenColumn` and `completeSubjects`), inflating `"Observations dropped as missing"` and allowing rank-deficient fixed effects that drop rows from `summary(m)$coefficients` (`co[r, 1]` → `subscript out of bounds`).
  2. In `multiple-t-tests.ts` (`gaussian: true, pooledSd: false`), `t.test(a(r), b(r))$p.value` is not wrapped in `tryCatch`, so a single constant row (e.g. `[0, 0, 0]` vs `[0, 0, 0]` at baseline) aborts the entire multi-row analysis with `data are essentially constant`.
- **Suggested Fix**:
  Filter `flattenGroupedMixed` to rows with at least one numeric cell and guard `co` indexing in `mixed-effects.ts`; wrap `t.test(...)$p.value` in `tryCatch(..., error=function(e) NA_real_)` in `multiple-t-tests.ts`.

---

### Issue 26: Partial `AnalysisParams` crash `compare-two-groups`, `nested-anova`, `two-way-anova`, and `multiple-t-tests` (`params ?? DEFAULTS`); `installBatch` omits `timeoutMs` when calling `evalNamedVector`
- **Severity**: Medium
- **Files**:
  - `src/stats/column/compare-two-groups.ts:91-106`
  - `src/stats/nested/nested-anova.ts:25-35`
  - `src/stats/grouped/two-way-anova.ts:322`
  - `src/stats/grouped/multiple-t-tests.ts:31`
  - `src/stats/webr.ts:687`
- **Explanation**:
  1. When `readParams` strips an invalid field from a `.hlx` file (or a caller passes `{ sets: [...] }`), `params` is a partial object. Because `compare-two-groups.ts` and `nested-anova.ts` use `params ?? DEFAULTS` instead of `{ ...DEFAULTS, ...params }` (and `two-way-anova.ts` / `multiple-t-tests.ts` do not default `params` at all), missing fields evaluate to `undefined` and crash R (`alternative="undefined"`).
  2. In `webr.ts`, `installBatch` (line 687) calls `evalNamedVector(code)` without passing `{ timeoutMs }`, so `EVAL_TIMEOUT_MS` (300 s) aborts package installs before `PACKAGE_INSTALL_TIMEOUT_MS` (360 s) and `classifyInstallError` misclassifies `EvalTimeoutError` as `"install-failed"`.
- **Suggested Fix**:
  Use `{ ...DEFAULTS, ...params }` across all column/grouped/nested runners, and pass `{ timeoutMs }` to `evalNamedVector` in `installBatch`.

---

## Low-Severity Issues

### Issue 27: `scripts/build-mac-dmg.sh` hardcodes version `1.0.6` (project is `1.0.7`), and `tests/linux-smoke.ts` crashes in Node because it never initializes `startR()` with the filesystem `webr/dist` path
- **Severity**: Low
- **Files**:
  - `scripts/build-mac-dmg.sh:45-68`
  - `tests/linux-smoke.ts:37-41`
- **Explanation**:
  1. `scripts/build-mac-dmg.sh:45-46` hardcodes `Helix_1.0.6_aarch64.dmg` while `package.json` and `Cargo.toml` are at `1.0.7`.
  2. `tests/linux-smoke.ts:38` calls `runAnalysis("survival", ...)` without calling `startR(fileURLToPath(new URL("../node_modules/webr/dist/", import.meta.url)))` or serving `webr-repo/`, crashing in Node with `ENOENT: /webr/`.
- **Suggested Fix**:
  Read `VERSION` from `package.json` in `scripts/build-mac-dmg.sh`, and initialize `startR` + `setPackageRepo` in `tests/linux-smoke.ts` (matching `tests/checks.ts:4952-4977`).

---

### Issue 28: Minor table, project-file, and stats edge cases (`columnsBeyond` in Nested tables, dangling `kmeansAnalysisId`/`monteCarloAnalysisId` warning, `chi-square.ts` trend with 0%/100% row, `monte-carlo.ts` constant X)
- **Severity**: Low
- **Files**:
  - `src/views/tables/table-data.ts:134-137`
  - `src/lib/project-file.ts:748-763`
  - `src/stats/contingency/chi-square.ts:30-45`
  - `src/stats/simulation/monte-carlo.ts:150-160`
- **Explanation**:
  1. `columnsBeyond` (`src/views/tables/table-data.ts:135`) checks `if (!isGrouped(data)) return 0;`, omitting `isNested(data)`, so pasting overflow columns into a Nested table silently drops them with no warning dialog.
  2. `parseProjectFile` (`src/lib/project-file.ts:749-757`) omits `kmeansAnalysisId` and `monteCarloAnalysisId` when checking for dangling analysis references to warn about on load.
  3. `chi-square.ts` runs `prop.trend.test` even when `sum(trendX) == 0` or `sum(trendX) == sum(trendN)`, crashing R's `lm.wfit` with `NA/NaN/Inf in 'x'`.
  4. `monte-carlo.ts` does not check `new Set(pairs.x).size >= 2` for `"linear-regression"` / `"correlation"`, failing with a generic `"did not return the expected values"` error when all X values are identical.
