# Rebase log: feat/prism-import-survival (aa7ca30, 34 commits) onto upstream v1.0.7 (583d3cd)

Started 2026-11-10 ~15:25 PT. Rules: preserve everything at this stage (dedup deletions happen later in a separate commit). Never skip/abort except on a stop condition. reference.json merged by script (union keys, PATCH :3: wins on differing values). FLAG = same-line conflict resolved in favour of the PATCH side, for coordinator review.

## Commit 1/34 — 33f1178 Import GraphPad Prism (.pzfx) files and add a log-rank survival test
- Conflicted: README.md, src/stats/index.ts, src/stats/types.ts, src/views/analyses/index.ts, src/views/graphs/survival.ts, tests/reference.ts. Auto-merged: src-tauri/src/main.rs (our choose_prism_file + upstream nav guard, different hunks), tests/reference.json (138 keys: upstream 137 + our survival-log-rank key), tests/checks.ts, THIRD-PARTY-NOTICES.md, src/app-menu.ts, src/native.ts, src/lib/student-t.ts, src/store/use-document.ts.
- README.md hunk 1: kept HEAD (upstream) feature bullets — they strictly supersede our older narrower bullets (3PL/5PL, Welch, GG, Cox all covered; our "log-rank (Mantel-Cox)" wording subsumed by upstream's survival bullet). Per dedup map: take upstream README wording. No FLAG (docs wording, no code lost).
- README.md hunk 2: kept BOTH lines (upstream METHODS.md line + our Prism-import line).
- src/stats/index.ts: kept all three imports (runSurvival, runCox, runLogRank) and all three ANALYSES entries (survival, cox, survival-log-rank).
- src/stats/types.ts: AnalysisType union now includes "survival" | "cox" | "survival-log-rank".
- src/views/analyses/index.ts: xy picker now offers both "interpolate" (HEAD) and "survival-log-rank" (PATCH); survival table already offers "survival" + "cox".
- src/views/graphs/survival.ts: name collision — HEAD imports lib kaplanMeier (with 95% band, required by merged build() which reads km.lower/km.upper); PATCH defines an inline kaplanMeier (no band). Kept HEAD import; PATCH implementation preserved verbatim renamed to kaplanMeierLegacy (+ interface KaplanMeierLegacy), exported; lib kaplanMeier re-exported from this file so src/stats/survival/log-rank.ts's `import { kaplanMeier } from "../../views/graphs/survival"` keeps working (it uses only .t/.s). Dedup commit decides the legacy function's fate.
- tests/reference.ts: kept BOTH sides' entries (HEAD's 3PL/5PL/interpolate/compare runs + PATCH's ["survival", survivalTable, "survival-log-rank"]).
- Verification: `tsc --noEmit` clean after resolution. No FLAGs.

## Commit 7/34 — 50fe164 Plan 01: Simple logistic regression
- Conflicted: src/stats/index.ts, src/stats/types.ts, src/store/types.ts, src/views/analyses/index.ts, src/views/graphs/graph-view.tsx, src/views/graphs/index.ts, tests/reference.json, tests/reference.ts. Commits 2–6 (e3d9822, 59f5260, 9acb036, e4f6e3a, 48f6bff) applied cleanly, no conflicts.
- All hunks resolved keep-both: index.ts imports (SurvivalParams/CoxParams + SimpleLogisticRegressionParams); types.ts AnalysisOutcome keeps upstream fit?/interpolated? AND our statisticLabel?; store/types.ts GraphType keeps dose-response + logistic-curve; analyses/index.ts xy picker = correlation, linear-regression, simple-logistic-regression, area-under-curve, nonlinear-regression, interpolate, survival-log-rank; graphs/index.ts registry + xy options keep dose-response, logistic-curve, survival, volcano; graph-view.tsx keeps addFittedCurve AND addDoseCurve/addLogisticCurve imports, HEAD regNode/curveParams/curveFit block AND PATCH dose/logistic blocks, HEAD fitted-curve draw branch + PATCH dose/logistic draw lines, deps array keeps curveParams/curveFit + doseFit/logisticFit.
- NOTE (graph-view.tsx draw hunk): PATCH's standalone `if (type === "xy-scatter" && options.regAnalysisId) addRegression(...)` line was NOT kept as a separate call — HEAD's `else if (type === "xy-scatter" && regNode) addRegression(...)` is the same call with a stricter guard (regNode exists); keeping both would double-draw the regression overlay. Not a FLAG (same call, not a same-line content choice).
- NOTE (graph-view.tsx regParams hunk): PATCH's inline regParams definition dropped in favour of HEAD's equivalent `regNode?.analysisParams` definition (same value); regNode is also needed by HEAD's draw branch. Not a FLAG.
- tests/reference.ts: kept both sides in all 3 hunks (HEAD freireich/survival3 fixtures + PATCH logistic/logisticSeparated fixtures; HEAD 3PL/5PL/interpolate/compare runs + PATCH 2 logistic runs; PATCH dose-response/logistic-curve graph runs). FIX-UP: survival3's closing `);` was shared context after the conflict marker (it closes survival3 on the HEAD side and logisticSeparated on the PATCH side) — concatenation left survival3 unclosed, so one `);` was added after survival3's `]),`. Lesson: the earlier regex-based concat (since abandoned) truncated this file mid-hunk — restored via `git checkout -m` and re-resolved with a line-based state machine; use line-based resolution from now on.
- tests/reference.json via script: HEAD 138 keys, PATCH 90 keys, merged 142 (52 HEAD-only, 4 PATCH-only), 25 keys with differing values — PATCH won per rule 3. Spot-checked: differences are STRUCTURAL as the dedup map predicted (same numbers, e.g. EC50 0.1438862706 identical; upstream moved stats into a `fit` block with 95% CIs; graph survival survival differs by upstream's legendgroup/traceorder). Keeping PATCH values at this stage is correct because our runner still emits the old shape; the dedup commit re-pins to upstream's shape when the runner merges. Full 25-key list:
  anova column {"posthoc":"bonferroni"}; anova column {"posthoc":"none"}; anova column {"posthoc":"tukey","sets":["Control","Low","High"]}; anova column {"posthoc":"tukey"}; area-under-curve xy {"baseline":0}; area-under-curve xy {"baseline":2}; chi-square contingency2 {}; chi-square contingencyWide {}; correlation xy {"method":"pearson","mode":"x-vs-every-y"}; correlation xy {"method":"spearman","mode":"x-vs-every-y"}; graph survival survival; nonlinear-regression doseLog {"model":"sigmoidal-4pl-logx"}; nonlinear-regression doseRaw {"model":"hyperbola"}; nonlinear-regression doseRaw {"model":"semilog-line"}; nonlinear-regression doseRaw {"model":"sigmoidal-4pl-x"}; nonlinear-regression xy {"model":"line"}; nonlinear-regression xy {"y":"Y1","model":"cubic"}; nonlinear-regression xy {"y":"Y3","model":"quadratic"}; rm-anova column {"posthoc":"bonferroni"}; rm-anova column {"posthoc":"tukey"}; rm-anova column {}; two-way-anova grouped {"design":"ordinary","posthoc":"bonferroni","posthocTarget":"rows"}; two-way-anova grouped {"design":"ordinary","posthoc":"tukey","posthocTarget":"groups","sets":["A","C"]}; two-way-anova grouped {"design":"ordinary","posthoc":"tukey","posthocTarget":"groups"}; two-way-anova grouped {"design":"repeated-measures","posthoc":"tukey","posthocTarget":"groups"}.
- UPSTREAM-DELETION RESTORES (needed for this commit AND later commits 02/08/09, which modify these files — without them the rebase would hit the "patch depends on a file that no longer exists" stop): upstream 1.0.7 deleted src/views/graphs/dose-response.ts + src/views/graphs/dose-response-curve.ts (retiring the dose-response graph type) and dropped doseY/doseModel from GraphOptions. Restored both files verbatim from our base b745783, and restored doseModel choice + doseY?/doseModel/doseShowCurve/doseShowEquation options + defaults in src/store/types.ts, plus the doseY entry in src/lib/project-file.ts OPTIONAL_OPTIONS. Dedup commit (Plan 32) retires these properly.
- UPSTREAM API MIGRATIONS (minimal, to keep the tree compiling): src/stats/xy/logistic-regression.ts used sync per-column `describe` — upstream's describe is now async over Group[]: changed to `groups: (await describe([xCol, yCol])).groups` (same pattern as nonlinear-regression.ts:364). tests/reference.ts plotColumns calls updated to the 4-arg signature `plotColumns(data, type, opts, tableType)` (pattern from reference.ts:724).
- Verification: `tsc --noEmit` clean after resolution. No FLAGs.

## Commit 8/34 — 2e99023 Plan 04: Bland-Altman method comparison
- Conflicted: src/stats/types.ts, src/views/analyses/index.ts, src/views/graphs/index.ts, tests/reference.json, tests/reference.ts.
- types.ts: union deduped by hand — "chi-square" | "survival" | "cox" | "survival-log-rank" | "bland-altman" (both sides repeated "chi-square"/"survival-log-rank"; a naive concat would have duplicated them).
- analyses/index.ts: PATCH had reformatted the xy entry to multi-line and added "bland-altman" to column + xy (auto-merged above the conflict); the conflict was the leftover one-line HEAD xy version vs empty PATCH. Deleted the one-line version and added "interpolate" (HEAD) to the multi-line xy list.
- graphs/index.ts: column + xy both gain "bland-altman" (xy keeps dose-response, logistic-curve, survival, volcano).
- tests/reference.ts: same-line conflict on the addLogisticCurve call — PATCH reformatted it to multi-line but with the OLD 2-arg plotColumns; HEAD has the 4-arg call from the commit-7 fix. Resolved as PATCH's multi-line formatting WITH HEAD's 4-arg plotColumns (keeps both: formatting + API fix). HEAD-FAVOUR on the call itself (PATCH's 2-arg form would reintroduce the commit-7 tsc error) — recorded here for coordinator review, not counted as a FLAG.
- tests/reference.json via script: HEAD 142 keys, PATCH 92 keys, merged 144 (52 HEAD-only, 2 PATCH-only), 0 differing values.
- UPSTREAM API MIGRATIONS (same two classes as commit 7): src/stats/column/bland-altman.ts used sync per-group describe — changed to `groups: (await describe([first, second])).groups`; tests/reference.ts Bland-Altman spot-check plotColumns call updated to the 4-arg signature.
- Verification: `tsc --noEmit` clean after resolution. No FLAGs.

## Commit 9/34 — c880db0 Plan 06: Frequency distribution
- Conflicted: src/lib/project-file.ts, src/stats/types.ts, src/views/analyses/wizards.ts, src/views/graphs/index.ts, tests/reference.json. tests/reference.ts auto-merged.
- project-file.ts: kept both imports (ANOVA_POSTHOCS + BIN_MODES); PARAMS line hand-merged — PATCH's bin params (binMode/binWidth/binCount/startAt) added, HEAD's name params (reference/control/compareWith) kept, duplicate y/dependent/datasets/predictors/sets keys from the naive concat removed.
- types.ts: kept both CURVE_TESTS + BIN_MODES constants; AnalysisParams union keeps SurvivalParams/CoxParams + FrequencyDistributionParams; AnalysisOutcome keeps survivalGroups/comparisonsEffect/hazardRatios + frequencyBins.
- wizards.ts: kept both import groups + isDoseModel helper; FIX-UP: naive concat imported ROUT_Q twice — removed the duplicate `import { ROUT_Q }` line.
- graphs/index.ts: column gains "histogram"; xy keeps volcano + bland-altman.
- tests/reference.json via script: HEAD 144 keys, PATCH 105 keys, merged 157 (52 HEAD-only, 13 PATCH-only), 0 differing values.
- UPSTREAM API MIGRATIONS: src/stats/column/frequency-distribution.ts used sync per-group describe — changed to `groups: (await describe(groups)).groups`; tests/reference.ts histogram spot-check plotColumns call updated to the 4-arg signature.
- Verification: `tsc --noEmit` clean after resolution. No FLAGs.

## Commit 12/34 — 670fc68 Plan 00: R-package provisioning
- Conflicted: src/stats/webr.ts, src/views/analyses/analysis-wizard.tsx, vite.config.ts. Commits 10–11 applied cleanly (70f9592 build-mac-dmg fix, 71c9480 Plan 07 KS test). Auto-merged: .gitignore, package.json, src/stats/index.ts, scripts/build-webr-repo.sh + webr-repo-manifest.json + tests/packages.ts added, scripts/build-mac-dmg.sh.
- webr.ts: kept BOTH header comments (upstream's library()-mount note + our ensurePackages note).
- analysis-wizard.tsx: kept all imports — packageGate + ensurePackages (PATCH) and toggled (HEAD); merged into a single wizards import (kept toggled, which PATCH's import lacked).
- vite.config.ts: kept BOTH comments and BOTH writeBundle copies (HEAD: R_PACKAGES → webr/packages; PATCH: WEBR_REPO → webr-repo with CDN-fallback warning).
- tests/reference.json: no conflict at this commit (not listed); no script run needed.
- DEDUP-MAP TRAP STILL OPEN (for the coordinator's dedup commit, NOT done here): upstream's survival/Cox runners still load via literal `library(survival)` (src/stats/survival/cox-regression.ts:23, src/stats/survival/survival-analysis.ts:54), and the survival/cox ANALYSES entries have no `requiredPackages` yet. Our evalNamedVector doesn't auto-install on `library()`. Dedup must re-wire them to `requiredPackages: ["survival"]` and get `grep -rn 'library(' src/stats/` to zero. Upstream's scripts/r-packages.mjs + src/stats/r-packages.json are still present in the tree (kept per rebase-stage rules; dedup deletes them).
- Verification: `tsc --noEmit` clean after resolution. No FLAGs.

## Commit 14/34 — 9272645 Plan 02: Standard-curve interpolation
- Conflicted: src/lib/project-file.ts, src/stats/xy/nonlinear-regression.ts, src/views/analyses/analysis-wizard.tsx, src/views/analyses/wizards.ts, src/views/graphs/graph-view.tsx. tests/reference.json + tests/reference.ts auto-merged (no script run). Commit 13 (ecd417c Plan 00 ignore qa/) applied cleanly.
- src/stats/xy/nonlinear-regression.ts — FLAG (wholesale PATCH, 3 hunks): HEAD is upstream 1.0.7's self-contained runner (3PL/5PL, interpolate flag + `interpolated` shape, `fit` block, curve comparison, sign-aware starts, derived CIs); PATCH is our nonlinear-fit.ts-based thin runner. The two are different full implementations of the same module — hunk-by-hunk concat would not compile (HEAD's trailing code references HEAD-only symbols like spec/sets/R_INTERP). Per rule 5, kept the PATCH file wholesale (as in commit 9272645) and FLAGGED. Upstream's runner is recoverable from tag 583d3cd; the dedup commit merges its models into nonlinear-fit.ts per the dedup-map decision (KEEP nonlinear-fit.ts as the shared layer; Plan 31 covers 3PL/5PL). Consequence to expect: reference entries for upstream's 3PL/5PL/interpolate/compare runs will fail until the dedup merge lands.
- nonlinear-fit.ts compile shims (minimal, flagged for dedup): MODEL_LABEL gained upstream's 7 missing models with upstream's exact labels (agonist-3pl-logx, inhibitor-3pl-logx, asymmetric-5pl-logx, asymmetric-5pl-x, exponential-growth, one-phase-decay, michaelis-menten); modelSpec gained a `default:` that throws `Model "..." is not implemented in the shared fit yet` for those models (they have no spec until dedup/Plan 31 ports them).
- nonlinear-regression.ts re-exports for upstream importers: `export { MODEL_LABEL }` (from nonlinear-fit), `positiveXOnly` (via modelSpec, same semantics as upstream's), `termLabel` (upstream's exact TERM_LABEL map: HillSlope → "Hill slope", S → "Asymmetry (S)").
- project-file.ts: PARAMS gained `unknowns: "numbers"` (ParamKind already includes "numbers"); binMode line kept (an earlier edit in this commit accidentally dropped it — caught and restored before continuing).
- analysis-wizard.tsx: single wizards import keeps toggled (HEAD) + parseUnknowns (PATCH). wizards.ts: imports keep SurvivalParams/CoxParams + StandardCurveInterpolationParams.
- graph-view.tsx draw hunk: HEAD's fitted-curve if/else-if chain kept (same addRegression-subsumption note as commit 7); dose curve call uses PATCH's 6-arg form with interpFit (addDoseCurve accepts `interp?`).
- UPSTREAM API MIGRATIONS: nonlinear-regression.ts + standard-curve-interpolation.ts sync describe → `(await describe([xCol, yCol])).groups`; index.ts nonlinear-regression run call drops the `t` arg (our runner takes 2 args); tests/reference.ts dose-response drop-lines plotColumns call updated to the 4-arg signature.
- Verification: `tsc --noEmit` clean after resolution. FLAGs: nonlinear-regression.ts hunks 1–3 (wholesale PATCH; upstream runner set aside for dedup).

## Commit 15/34 — 6d29312 Plan 03: Three-way ANOVA
- Conflicted: src/components/app-shell.tsx, src/lib/project-file.ts, src/views/analyses/index.ts, src/views/tables/table-view.tsx, tests/checks.ts. tests/reference.json + tests/reference.ts auto-merged (no script run).
- app-shell.tsx — RENAME RESOLVED (upstream moved it, we didn't): base has it at src/components/layout/app-shell.tsx (with project-sidebar.tsx + workspace.tsx); upstream 1.0.7 moved all three to src/components/ (and universal-modal from components/common/ to components/). Our commit only changed 3 lines in it. Kept UPSTREAM'S location (src/components/app-shell.tsx, which the merged main.tsx already imports) and applied our change onto it: HEAD's import block with ANALYSIS_OPTIONS_BY_TABLE → analysisOptionsForTable; kept HEAD's TableDetail import (used by the merged body) and ./universal-modal path. No layout/ copy kept — nothing else references it (verified: no remaining `layout/app-shell` or `components/common/inspector` references).
- project-file.ts: PARAMS gained posthocTerm: THREE_WAY_TERMS (duplicate y-line from the naive concat removed); readRowGroups helper + comment kept (PATCH-only hunk).
- analyses/index.ts: grouped gains "three-way-anova"; multiple keeps descriptive-statistics + outliers (PATCH had dropped them — pre-survival-table state); survival line kept.
- table-view.tsx: HEAD's inspector path kept (../../components/inspector — PATCH's ../../components/common/inspector does not exist in the merged tree) + PATCH's Button/Input import from ../../ui/controls.
- checks.ts: kept both import groups (columnsBeyond + addRowGroup/defaultRowGroups; toggled + WIZARDS + Question).
- UPSTREAM API MIGRATION: src/stats/grouped/three-way-anova.ts used sync per-group describe — changed to `(await describe(aLevels.map(...))).groups`.
- Verification: `tsc --noEmit` clean after resolution. No FLAGs.

## Commit 16/34 — 4629540 Plan 05: ROC curve
- Conflicted: src/lib/project-file.ts, src/stats/index.ts, src/views/analyses/index.ts, src/views/analyses/wizards.ts, src/views/graphs/graph-view.tsx, src/views/graphs/index.ts, tests/reference.json. tests/reference.ts auto-merged.
- project-file.ts: PARAMS gained truth/score/positive ("name-or-number" kind already auto-merged into ParamKind); duplicate y-line dropped.
- index.ts imports: SurvivalParams/CoxParams + RocParams kept. analyses/index.ts xy list keeps "interpolate" (HEAD) + "roc-curve" (PATCH).
- wizards.ts: kept DOSE/KINETIC/NONLINEAR model imports + MODEL_LABEL + isDoseModel (HEAD) and distinctTruthValues (PATCH); single freq-distribution import.
- graph-view.tsx: HEAD's 4-arg plotColumns kept (PATCH's 2-arg form would reintroduce a tsc error — HEAD-FAVOUR, same as commit 8's note); PATCH's roc-curve exception merged into xyLack (`type !== "roc-curve"`) with PATCH's comment about text truth values.
- graphs/index.ts: column + xy both gain "roc-curve" (PATCH's multi-line form kept; "volcano" restored to xy, which PATCH lacked).
- tests/reference.json via script: HEAD 176 keys, PATCH 130 keys, merged 182 (52 HEAD-only, 6 PATCH-only), 0 differing values.
- UPSTREAM API MIGRATIONS: src/stats/column/roc-curve.ts sync describe → `(await describe([...])).groups`; tests/reference.ts ROC graph smoke plotColumns call updated to the 4-arg signature.
- Verification: `tsc --noEmit` clean after resolution. No FLAGs.

## Commit 18/34 — fa3868c Plan 08 (1/2): Exponential decay models
- Conflicted: src/stats/types.ts, src/stats/xy/nonlinear-fit.ts, src/stats/xy/nonlinear-regression.ts, src/views/analyses/wizards.ts, src/views/graphs/format-sections.tsx, tests/reference.json, tests/reference.ts. Commit 17 (51ff916 webr-repo fix) applied cleanly.
- types.ts NONLINEAR_MODELS: kept ...KINETIC_MODELS + two-phase-decay + plateau-decay (one-phase-decay is already in KINETIC_MODELS = [exponential-growth, one-phase-decay, michaelis-menten] — listing it again would duplicate wizard options; noted in a comment).
- nonlinear-fit.ts MODEL_LABEL: union of HEAD's upstream-label shims (exponential-growth, one-phase-decay, michaelis-menten) + PATCH's two-phase-decay/plateau-decay. modelSpec: PATCH's three decay cases (port algorithm, Half-life/Span derived) + HEAD's default-throw, comment updated (still-unported: 3PL/5PL, exponential-growth, Michaelis-Menten).
- nonlinear-regression.ts hunk 1: merged programmatically — HEAD's import/re-export block (MODEL_LABEL re-export, positiveXOnly, termLabel) with PATCH's additions (RegressionCoefficient type, num import, EXPONENTIAL_MODELS import, isExponential/coefOf/equation/startingValues/fitWarnings helpers + Plan 08 header comment). Hunk 2: await-describe (HEAD) + notes.join(" ") (PATCH).
- wizards.ts interpolate choice: kept HEAD's dynamic filter (NONLINEAR_MODELS minus 3pl/kinetic) — it subsumes PATCH's hardcoded 10-model list, including all three decay models. HEAD-FAVOUR, recorded here (not a FLAG: no PATCH-listed model is lost).
- format-sections.tsx: HEAD's inspector path kept (../../components/inspector; PATCH's common/inspector doesn't exist) + PATCH's EXPONENTIAL_MODELS/MODEL_LABEL import; dose-response section kept whole (model Choice with exponentials, toggles, doseError line) alongside HEAD's xy-scatter RegressionControls + fitError return.
- tests/reference.ts: kept both (HEAD upstream 3PL/5PL/interpolate/compare/growth/decay/enzyme runs + PATCH exponential runs).
- tests/reference.json via script: HEAD 182 keys, PATCH 135 keys, merged 187 (52 HEAD-only, 5 PATCH-only), 0 differing values.
- RESTORED DROPPED WIRING (lost in earlier merges, found via tsc): SectionContext had no doseError and graph-view.tsx never passed it — our branch had both (fa3868c:52, graph-view:467). Added `doseError: string | null` to SectionContext and the `doseError={...}` prop (FormatPanel Props extends SectionContext, so the prop flows through).
- fitted-curve.ts evaluate(): added two-phase-decay + plateau-decay cases from our curveFn formulas (dedup map explicitly wants these ported there); the switch was non-exhaustive for the two new union members.
- UPSTREAM API MIGRATION: tests/reference.ts exponential drop-lines plotColumns call updated to the 4-arg signature.
- Verification: `tsc --noEmit` clean after resolution. No FLAGs.

## Commit 19/34 — a2d9dff Plan 08 (2/2): Association and growth
- Conflicted: src/stats/xy/nonlinear-fit.ts, src/views/analyses/wizards.ts, tests/reference.json, tests/reference.ts. types.ts auto-merged (needed a dedup fix below).
- nonlinear-fit.ts modelSpec: PATCH's one-phase-association + exponential-growth cases + HEAD's default-throw; default comment updated (still-unported: 3PL/5PL, Michaelis-Menten only).
- types.ts dedup: NONLINEAR_MODELS had "exponential-growth" twice (once via ...KINETIC_MODELS, once explicit from PATCH) — removed the explicit entry (comment notes growth lives in KINETIC_MODELS). MODEL_LABEL had the same duplicate — removed the second "exponential-growth" entry.
- wizards.ts interpolate choice: PATCH's hardcoded list kept, PLUS the two 5PLs from HEAD's dynamic filter (which PATCH's list lacked); note in the code that HEAD's filter excludes kinetic models, so one-phase-decay + exponential-growth come from PATCH. Consequence: the dynamic filter is gone, so KINETIC_MODELS import removed (unused — verified by tsc). No content lost either way; no FLAG.
- tests/reference.ts: kept both (HEAD upstream runs + PATCH comment update for the exponential fixtures).
- tests/reference.json via script: HEAD 187 keys, PATCH 138 keys, merged 190 (52 HEAD-only, 3 PATCH-only), 0 differing values.
- fitted-curve.ts evaluate(): added the one-phase-association case from our curveFn formula (switch was non-exhaustive for the new union member).
- UPSTREAM API MIGRATION: tests/reference.ts growth drop-lines plotColumns call updated to the 4-arg signature.
- Verification: `tsc --noEmit` clean after resolution. No FLAGs.

## Commit 20/34 — e8257b6 Plan 09: Enzyme kinetics (substrate-velocity)
- Conflicted: src/stats/types.ts, src/stats/xy/nonlinear-fit.ts, src/stats/xy/nonlinear-regression.ts, src/views/analyses/analysis-results-view.tsx, tests/reference.json. tests/reference.ts auto-merged.
- types.ts NONLINEAR_MODELS: kept only the genuinely new models (allosteric-sigmoidal, substrate-inhibition) — PATCH also re-listed exponential-growth + michaelis-menten, which already exist via ...KINETIC_MODELS (duplicates removed).
- types.ts RegressionCoefficient: kept BOTH field pairs — HEAD's low?/high? AND PATCH's ciLow?/ciHigh? (dedup map says rename ciLow/ciHigh → low/high in the dedup commit; both populated by different runners at this stage — the nonlinear-fit runner fills ciLow/ciHigh at nonlinear-fit.ts:370-371). Also kept HEAD's SurvivalGroupRow + HazardRatioRow interfaces (PATCH's base predates them) with PATCH's extended RegressionCoefficient doc comment.
- MODEL_LABEL: kept only the two new labels (allosteric-sigmoidal, substrate-inhibition); PATCH's re-listed exponential-growth/michaelis-menten labels already exist.
- nonlinear-fit.ts modelSpec: PATCH's three enzyme cases (all nls algorithm "port"; MM/algebraically hyperbola with Vmax/Km names; no positiveX — vehicle point stays in) + HEAD's default-throw; default comment updated (still-unported: 3PL/5PL only).
- nonlinear-regression.ts: PATCH's import block was a duplicate of the existing top-of-file imports — dropped it, added ENZYME_MODELS to the existing import instead (isEnzyme helper already auto-merged).
- analysis-results-view.tsx: coefficients table keeps BOTH CI presentations — HEAD's single "95% CI" column (low to high) AND PATCH's conditional "95% CI lower"/"95% CI upper" columns gated on showCoefCi (already auto-merged at line 89); term cell keeps PATCH's HillSlope → "Hill slope" wording.
- tests/reference.json via script: HEAD 190 keys, PATCH 146 keys, merged 198 (52 HEAD-only, 8 PATCH-only), 17 differing values (PATCH won per rule): nonlinear-regression doseLog {sigmoidal-4pl-logx}; nonlinear-regression doseRaw {hyperbola}; nonlinear-regression doseRaw {semilog-line}; nonlinear-regression doseRaw {sigmoidal-4pl-x}; nonlinear-regression expX {y A one-phase-decay}; nonlinear-regression expX {y B two-phase-decay}; nonlinear-regression expX {y C one-phase-association}; nonlinear-regression expX {y D one-phase-association}; nonlinear-regression expX {y D2 exponential-growth}; nonlinear-regression expX {y E plateau-decay}; nonlinear-regression xy {line}; nonlinear-regression xy {y Y1 cubic}; nonlinear-regression xy {y Y3 quadratic}; standard-curve-interpolation doseLog {sigmoidal-4pl-logx, unknowns [20,150]}; standard-curve-interpolation doseLog {sigmoidal-4pl-logx, unknowns [20,50,80]}; standard-curve-interpolation doseRaw {sigmoidal-4pl-x, unknowns [30,60]}; standard-curve-interpolation xy {line, unknowns [5,10]}. (The 4 dose + 3 xy + 4 interpolation keys are the same structural 3PL/5PL/fit-block shape diff seen in commit 7; the 6 expX keys differ because Plan 09's runner now populates coefficient CIs.)
- fitted-curve.ts evaluate(): added allosteric-sigmoidal + substrate-inhibition cases from our curveFn formulas (switch was non-exhaustive for the new union members).
- UPSTREAM API MIGRATION: tests/reference.ts MM + substrate-inhibition drop-lines plotColumns calls updated to the 4-arg signature.
- Verification: `tsc --noEmit` clean after resolution. No FLAGs.

## Commit 21/34 — fae3fe8 Plan 10: Cox proportional-hazards regression
- Conflicted: src/lib/project-file.ts, src/stats/index.ts, src/store/references.ts, src/views/analyses/analysis-results-view.tsx, src/views/analyses/index.ts, src/views/analyses/wizards.ts, src/views/graphs/format-sections.tsx, src/views/graphs/graph-view.tsx, src/views/graphs/index.ts, tests/reference.json, tests/reference.ts.
- project-file.ts: OPTIONAL_OPTIONS gains coxAnalysisId (union with HEAD's xVariable/yVariable); the dangling-analysis check keeps HEAD's nodeOf() form + adds the coxAnalysisId check (nodeOf is the isIn-guarded nodes[] lookup).
- index.ts runAnalysis: named/chosen union — HEAD's reference/control/compareWith + PATCH's time/status/covariates/stratifyBy.
- references.ts: PARAM_NAMES union (HEAD's reference/control/compareWith + PATCH's time/status/covariates/stratifyBy); OPTION_NAMES union (PATCH's doseY + HEAD's xVariable/yVariable).
- analysis-results-view.tsx: coefficients table keeps HEAD's single "95% CI" column AND PATCH's conditional "Hazard ratio" column (showHr auto-merged at line 92; hazardRatio already in RegressionCoefficient).
- analyses/index.ts: multiple gains cox-proportional-hazards (kept alongside descriptive-statistics + outliers, which PATCH's base had dropped); survival line kept ([survival, cox]).
- wizards.ts: kept BOTH wizard sets — HEAD's survival + cox wizards (upstream 1.0.7) followed by PATCH's cox-proportional-hazards wizard (time/status/covariates/stratifyBy/ties).
- format-sections.tsx: survival case keeps HEAD's comment + PATCH's multiple-table Cox branch (NoAnalysis / CoxControls).
- graph-view.tsx: type import keeps NonlinearRegressionParams (HEAD) + CoxPHParams (PATCH); xyLack keeps HEAD's hasXColumn guard AND PATCH's forest-plot + survival-on-multiple exceptions (PATCH's version had dropped the guard).
- graphs/index.ts: multiple gains forest-plot + survival alongside HEAD's xy-scatter.
- tests/reference.ts: imports keep HEAD's six additions + PATCH's setPackageRepo (merged into the single webr import — concat would have duplicated the module import); fixtures keep HEAD's subjects/freireich/survival3 + PATCH's coxTable/coxAllCensored; graph runs keep HEAD's freireich band run + PATCH's coxTable forest-plot run. FIX-UP: the shared `);` after the hunk closes survival3's table( call in HEAD's version and coxTable's in PATCH's — after concat one `);` was added after survival3's `]),` (same shared-context-closer lesson as commit 7).
- tests/reference.json via script: HEAD 198 keys, PATCH 155 keys, merged 207 (52 HEAD-only, 9 PATCH-only), 0 differing values.
- API MIGRATIONS: src/stats/survival/cox-ph.ts sync describe → `(await describe(pairedGroups(used))).groups` (describe is now async over Group[]; pairedGroups converts the Column[]); tests/reference.ts forest-plot plotColumns call → 4-arg signature (table type "multiple").
- Verification: `tsc --noEmit` clean after resolution. No FLAGs.

## Commit 22/34 — c5f7d1a Plan 11: Multiple logistic regression
- Conflicted: src/views/analyses/index.ts, src/views/analyses/wizards.ts, tests/reference.json, tests/reference.ts.
- analyses/index.ts: multiple gains multiple-logistic-regression, kept alongside descriptive-statistics + outliers (PATCH's base had dropped them).
- wizards.ts: kept BOTH — HEAD's survival + cox wizards followed by PATCH's multiple-logistic-regression wizard (binary-dependent picker, predictors multi-select).
- tests/reference.ts: kept BOTH — HEAD's descriptive-statistics + outliers runs + PATCH's three multiple-logistic-regression runs (explicit predictors, predictors-omitted, separated-table error).
- tests/reference.json via script: HEAD 207 keys, PATCH 158 keys, merged 210 (52 HEAD-only, 3 PATCH-only), 0 differing values.
- API MIGRATION: src/stats/multiple/multiple-logistic-regression.ts sync describe → `(await describe(pairedGroups(used))).groups`.
- Verification: `tsc --noEmit` clean after resolution. No FLAGs.

## Commit 24/34 — f9d167f Plan 12: Poisson regression (commit 23, 16a291d Plan 11 error-path checks, applied cleanly)
- Conflicted: src/lib/project-file.ts, src/stats/index.ts, src/views/analyses/index.ts, src/views/graphs/graph-view.tsx, src/views/graphs/index.ts, tests/reference.json, tests/reference.ts.
- project-file.ts: OPTIONAL_OPTIONS gains poissonAnalysisId (union with HEAD's xVariable/yVariable); PARAMS gains `quasi: "yes/no"` alongside HEAD's full line (PATCH's POSTHOCS/curveTest-compare-dropping rewrite not taken — HEAD's ANOVA_POSTHOCS + curveTest/compare already cover it); the dangling-analysis check keeps HEAD's nodeOf() form + adds the poissonAnalysisId check.
- index.ts: type imports keep SurvivalParams/CoxParams (HEAD) + PoissonRegressionParams (PATCH).
- analyses/index.ts: multiple gains poisson-regression (kept alongside descriptive-statistics + outliers).
- graph-view.tsx: type import keeps NonlinearRegressionParams (HEAD) + CoxPHParams + PoissonRegressionParams.
- graphs/index.ts: graphSeries keeps HEAD's 4-arg signature (all callers pass options) + PATCH's observed-fitted branch (one "Observed vs fitted" series); multiple gains observed-fitted alongside HEAD's xy-scatter.
- tests/reference.ts: kept BOTH — HEAD's xy-scatter run + PATCH's observed-fitted run.
- tests/reference.json via script: HEAD 210 keys, PATCH 162 keys, merged 214 (52 HEAD-only, 4 PATCH-only), 0 differing values.
- API MIGRATIONS: src/stats/multiple/poisson-regression.ts sync describe → `(await describe(pairedGroups(used))).groups`; tests/reference.ts observed-fitted plotColumns calls → 4-arg signature (the fittedCounts call takes fresh `newGraphOptions("observed-fitted")` + "multiple" — the analysis params are NOT graph options).
- LESSON (repeated): when hand-resolving with muse.edit, the old_text MUST include the full `<<<<<<< HEAD` marker line — four edits in this commit omitted it and left stray markers, caught by the marker grep + tsc and removed.
- Verification: `tsc --noEmit` clean after resolution. No FLAGs.

## Commit 25/34 — fa76919 Plan 13: Deming regression
- Conflicted: samples/Helix Sample.hlx, src/lib/project-file.ts, src/views/graphs/format-sections.tsx, src/views/graphs/graph-view.tsx. tests/reference.json + tests/reference.ts auto-merged (no script run).
- samples/Helix Sample.hlx (21 hunks): upstream 1.0.7 REWROTE the sample (58 nodes → 50, new tables t-kinase/t-markers/t-volume etc.); PATCH's only semantic change vs base was adding 3 default keys (demingShowLine/demingShowOls/demingShowEquation: true) to every graph's graphOptions. Resolved by taking HEAD's file wholesale + inserting the 6 keys every graph was missing vs our DEFAULT_GRAPH_OPTIONS (the 3 Deming keys + doseModel/doseShowCurve/doseShowEquation, which upstream dropped when it retired the dose-response graph) with default values, in PATCH's key order (after regShowEquation). Verified with tsx + parseProjectFile: updated=false, issues=[] — the checks.ts:181 assertion holds.
- project-file.ts: OPTIONAL_OPTIONS gains demingAnalysisId (union with HEAD's xVariable/yVariable); PARAMS gains `lambda: "number"` alongside HEAD's full line (PATCH's POSTHOCS rewrite not taken); the dangling-analysis check keeps HEAD's nodeOf() form + adds the demingAnalysisId check.
- format-sections.tsx xy-scatter section (genuine structural merge): HEAD's section (linear + nonlinear sources, xy-table guard, fitError line) + PATCH's section (Linear + Deming groups). Merged: HEAD's `&& c.tableType === "xy"` guard kept; three groups — Linear regression, Deming regression (PATCH's DemingControls, kept whole), Nonlinear regression (HEAD's nonlinear filter, compareWith excluded) with the fitError line inside it; empty-state mentions all three. RegressionControls comment restored to HEAD's wording ("a nonlinear one has no band") since it again serves nonlinear sources.
- graph-view.tsx: type import keeps all five param types; the regression block keeps HEAD's regNode/curveParams/curveOutcome/curveFit + PATCH's demingParams line; the draw keeps HEAD's if/else-if chain (fitted curve XOR linear line — keeping both would double-draw, per the commit-7 note) + PATCH's separate addDeming if.
- UPSTREAM API MIGRATION: tests/reference.ts Deming spot-check plotColumns calls (2) updated to the 4-arg signature.
- Verification: `tsc --noEmit` clean after resolution; sample file verified via parseProjectFile (updated=false). No FLAGs.

## Commit 26/34 — 756be19 Plan 14: Nested t test and nested one-way ANOVA
- Conflicted: FILE-FORMAT.md, src/store/types.ts, src/views/analyses/index.ts, src/views/graphs/index.ts, src/views/tables/grid.tsx, tests/reference.json, tests/reference.ts, tests/sample-project.ts.
- FILE-FORMAT.md: tableType list union — adds "nested" alongside HEAD's "survival" (1.0.7+).
- store/types.ts: TableType union gains "nested" (kept alongside HEAD's "survival") + HEAD's hasXColumn helper kept.
- analyses/index.ts: adds the nested line (nested-t-test, nested-anova); multiple + survival lines kept. FIX-UP: my edit duplicated the grouped line (it was shared context above the hunk) — removed the duplicate.
- graphs/index.ts: adds the nested line + its groupsOf comment; multiple list kept (with xy-scatter).
- grid.tsx imports: keeps isGrouped + alert (HEAD) + isNested (PATCH).
- tests/reference.ts: kept BOTH — HEAD's grouped heatmap/box/violin runs + PATCH's nested grouped-bars/scatter/lines runs.
- tests/sample-project.ts: kept BOTH — HEAD's survival section + PATCH's nestedData helper + nested section. NOTE: the checked-in samples/Helix Sample.hlx was NOT touched by this commit and is now stale vs the generator (generator now builds t-nested/a-nested-t/g-nested-bars too); no test compares the file to the generator (checks.ts only asserts the file loads with updated=false), so regeneration is the coordinator's call, not done here.
- tests/reference.json via script: HEAD 221 keys, PATCH 180 keys, merged 232 (52 HEAD-only, 11 PATCH-only), 0 differing values.
- API MIGRATIONS: src/stats/nested/nested-anova.ts + nested-t-test.ts sync describe → `(await describe(...)).groups` (nested-anova reuses its asGroups array; the single-Group describe call is gone in 1.0.7).
- DEAD CODE (upstream rewrite): the `unpaired` helper in sample-project.ts lost its only use — upstream's generator replaced the t-tumor Welch analysis (a-tumor-welch) with t-volume ANOVA+Dunnett — so the unused const was removed (tsc noUnusedLocals).
- Verification: `tsc --noEmit` clean after resolution. No FLAGs.

## Commit 27/34 — 58c7d74 Plan 15: Spline and Lowess
- Conflicted: samples/Helix Sample.hlx, src/lib/project-file.ts, src/store/types.ts, src/views/analyses/wizards.ts, tests/reference.json, tests/reference.ts.
- samples/Helix Sample.hlx (8 hunks): PATCH's changes vs its base were (a) smoothShowCurve: true added to every graph's graphOptions, (b) the 3 Plan 14 sample nodes (t-nested, a-nested-t, g-nested-bars) finally written to the file. Merged onto HEAD's 50-node file: took HEAD wholesale, inserted smoothShowCurve after doseShowEquation in all 18 graphs, spliced the 3 nested node blocks verbatim from the PATCH stage (after g-immune, before t-surv), added t-nested to rootOrder (after t-immune, mirroring PATCH) + childOrder. FIX-UP: the copied g-nested-bars block lacked survivalShowBand: false (PATCH's own node was stale on that key) — added it; verified with tsx + parseProjectFile: updated=false, issues=[].
- project-file.ts: OPTIONAL_OPTIONS gains smoothAnalysisId (union with HEAD's xVariable/yVariable); PARAMS keeps HEAD's full lines + PATCH's method extension ([...CORRELATION_METHODS, "spline", "lowess"] with its comment) + f/spar/df number params; the dangling-analysis check keeps HEAD's nodeOf() form + adds the smoothAnalysisId check.
- store/types.ts: keeps HEAD's xVariable/yVariable + HEAD's heatmap comment, adds PATCH's smoothAnalysisId/smoothShowCurve block between them.
- wizards.ts: type imports keep SurvivalParams/CoxParams (HEAD) + SplineLowessParams (PATCH).
- tests/reference.ts: kept BOTH — HEAD's growth/decay/enzyme/dose fixtures + PATCH's smooth fixtures (smoothTooFew etc.). FIX-UP: the shared `);` after the hunk closes doseFall's table( call in HEAD's version and smoothTooFew's in PATCH's — after concat one `);` was added after doseFall's rows (same shared-context-closer lesson as commits 7 and 21).
- tests/reference.json via script: HEAD 232 keys, PATCH 189 keys, merged 241 (52 HEAD-only, 9 PATCH-only), 0 differing values.
- API MIGRATIONS: src/stats/xy/spline-lowess.ts sync describe → `(await describe([x, yCol])).groups`; tests/reference.ts smooth-curve spot-check plotColumns call → 4-arg signature.
- Verification: `tsc --noEmit` clean after resolution; sample file verified via parseProjectFile (updated=false). No FLAGs.

## Commit 28/34 — 49f1675 Plan 16: Binding kinetics and saturation
- Conflicted: src/lib/project-file.ts, src/stats/index.ts, src/views/graphs/graph-view.tsx, tests/reference.json. tests/reference.ts auto-merged.
- project-file.ts: imports keep ANOVA_POSTHOCS (HEAD) + BINDING_KINETICS_MODELS/BINDING_SATURATION_MODELS (PATCH); PARAMS model extended to [...NONLINEAR_MODELS, ...BINDING_SATURATION_MODELS, ...BINDING_KINETICS_MODELS] with PATCH's shared-model comment (HEAD's equalSd/sphericity/interpolate line kept); PARAMS gains y2 + the ligandConcentration/koff/hotNM/time0 number params alongside HEAD's reference/control/compareWith names.
- index.ts runAnalysis: named/chosen union — HEAD's reference/control/compareWith + PATCH's y2.
- graph-view.tsx: type import keeps all seven param types (NonlinearRegressionParams kept alongside PATCH's BindingKineticsParams/BindingSaturationParams).
- tests/reference.json via script: HEAD 241 keys, PATCH 204 keys, merged 256 (52 HEAD-only, 15 PATCH-only), 0 differing values.
- API MIGRATIONS: src/stats/xy/binding.ts sync describe → `(await describe([...])).groups` at both return sites (saturation with optional y2Col, kinetics); tests/reference.ts binding-curve spot-check plotColumns calls (3) → 4-arg signature (the first call needed its `opts` declaration hoisted above the call — use-before-declare, caught by tsc).
- Verification: `tsc --noEmit` clean after resolution. No FLAGs.

## Commit 29/34 — c2ac863 Plan 17: Enzyme kinetics — inhibition
- Conflicted: src/lib/project-file.ts, src/stats/index.ts, src/views/graphs/graph-view.tsx, tests/reference.json. tests/reference.ts auto-merged.
- project-file.ts: imports keep CURVE_TESTS/DOSE_MODELS (HEAD) + ENZYME_INHIBITION_MODELS (PATCH); PARAMS y widened to "name-or-names" on HEAD's existing y line (PATCH's duplicate y line dropped — it also lacked reference/control/compareWith); the "name-or-names"/"numbers-by-name" ParamKind extensions + readParam handlers auto-merged.
- index.ts runAnalysis: named/chosen union — HEAD's reference/control/compareWith + PATCH's array-y spread (enzyme inhibition's `y` is a string[]; PATCH's comment kept).
- graph-view.tsx: type import keeps all eight param types (NonlinearRegressionParams kept alongside PATCH's EnzymeInhibitionParams).
- tests/reference.json via script: HEAD 256 keys, PATCH 212 keys, merged 264 (52 HEAD-only, 8 PATCH-only), 0 differing values.
- API MIGRATIONS: src/stats/xy/enzyme-inhibition.ts sync describe → `(await describe([...])).groups` at both return sites (multi-series + Morrison); tests/reference.ts inhibition-curve spot-check plotColumns call → 4-arg signature (opts hoisted above the call — same use-before-declare pattern as commit 28).
- Verification: `tsc --noEmit` clean after resolution. No FLAGs.

## Commit 30/34 — 6eec315 Plan 18: Dose-response — special
- Conflicted: src/lib/project-file.ts, src/stats/index.ts, src/views/graphs/format-sections.tsx, src/views/graphs/graph-view.tsx, tests/reference.json, tests/reference.ts.
- project-file.ts: imports keep CURVE_TESTS/DOSE_MODELS (HEAD) + DOSE_RESPONSE_SPECIAL_MODELS (PATCH); PARAMS gains fixHillSlope on the paired line (PATCH's POSTHOCS rewrite not taken — HEAD's ANOVA_POSTHOCS + equalSd/sphericity/interpolate line kept); `ys: "names"` added to HEAD's existing y line (PATCH's duplicate y line dropped).
- index.ts runAnalysis: named/chosen union — HEAD's reference/control/compareWith + PATCH's ys spread. (NOTE: the first line-based resolution of this hunk duplicated the shared-context `// prettier-ignore`/`const named = params as` lines and left a double `];` — caught by tsc, fixed by content-based dedup before continuing.)
- format-sections.tsx: HEAD's inspector path kept (PATCH's components/common/inspector does not exist) + both NonlinearRegressionParams and DoseResponseSpecialParams types.
- graph-view.tsx: type import keeps all nine param types (NonlinearRegressionParams kept alongside PATCH's DoseResponseSpecialParams).
- tests/reference.ts: HEAD's 4-arg plotColumns + multi-line build kept (PATCH's 2-arg form would reintroduce the commit-7 tsc error — HEAD-FAVOUR, same as commits 8/16, not a FLAG).
- tests/reference.json via script: HEAD 264 keys, PATCH 221 keys, merged 273 (52 HEAD-only, 9 PATCH-only), 0 differing values.
- API MIGRATIONS: src/stats/xy/dose-response-special.ts sync describe → `(await describe([xCol, ...series.map((s) => s.col)])).groups`; tests/reference.ts Schild + special-curve + operational overlay spot-check plotColumns calls (3) → 4-arg signature (opts hoisted above each call).
- Verification: `tsc --noEmit` clean after resolution. No FLAGs.

## Commit 31/34 — 78997c1 Plan 19: Chi-square test for trend and McNemar's test
- Conflicted: src/lib/project-file.ts, src/stats/contingency/chi-square.ts, src/stats/index.ts, src/stats/types.ts, src/views/analyses/index.ts, src/views/analyses/wizards.ts, tests/reference.json, tests/reference.ts.
- project-file.ts: PARAMS gains trendOrdered + continuityCorrection on the paired line (PATCH's POSTHOCS rewrite not taken — HEAD's ANOVA_POSTHOCS + equalSd/sphericity/interpolate line kept).
- chi-square.ts — FLAG (wholesale PATCH preamble): HEAD's inline matrix-building preamble (dataGroups/pairedGroups + negative/integer/row-count checks) replaced by PATCH's `buildContingencyMatrix(columns)` helper from ./common (auto-merged import) + a `params?: ChiSquareParams` signature. Same-line rewrite, kept PATCH per rule 5; the dedup coordinator should confirm the helper reproduces HEAD's error messages (negative counts, fractional counts, <2 rows/cols).
- index.ts: imports keep runSurvival/runCox (HEAD) + runMcNemar (PATCH); ANALYSES keeps chi-square (PATCH's params form), mcnemar, survival, cox.
- types.ts: AnalysisType union keeps survival/cox (HEAD) + mcnemar (PATCH).
- analyses/index.ts: multiple keeps descriptive-statistics + outliers (HEAD); contingency keeps chi-square + PATCH's mcnemar entry. (NOTE: my first edit omitted the `<<<<<<< HEAD` line from old_text and left a stray marker — caught by the marker grep + tsc, removed before continuing.)
- wizards.ts: imports keep DOSE_MODELS/NONLINEAR_MODELS/MODEL_LABEL (HEAD) + dataGroups/pairedGroups (PATCH).
- tests/reference.ts: keep-both via resolver (HEAD's survival/cox/two-way runs + PATCH's trend/mcnemar runs, 1 hunk).
- tests/reference.json via script: HEAD 273 keys, PATCH 230 keys, merged 282 (52 HEAD-only, 9 PATCH-only), 0 differing values.
- API MIGRATIONS: none needed this commit (new runners already compile against the async describe / 4-arg plotColumns).
- Verification: `tsc --noEmit` clean after resolution. FLAGs: chi-square.ts preamble (wholesale PATCH).

## Commit 32/34 — 769d25b Plan 20: Mixed-effects model
- Conflicted: src/stats/types.ts, tests/reference.json. tests/reference.ts auto-merged.
- types.ts hunk 1: keep-both — HEAD's FitRow + InterpolatedRow interfaces + PATCH's VarianceComponent interface. (NOTE: the shared `}` after the marker closes the LAST interface in the merged block — my merged text already closed VarianceComponent, so the leftover shared `}` was removed; the reverse of the commit-7 pattern, where the closer had to be ADDED.)
- types.ts hunk 2: AnalysisOutcome keeps HEAD's fit?/interpolated? + PATCH's varianceComponents?.
- tests/reference.json via script: HEAD 282 keys, PATCH 235 keys, merged 287 (52 HEAD-only, 5 PATCH-only), 0 differing values.
- API MIGRATIONS: src/stats/mixed/mixed-effects.ts sync describe → async describe(Group[]) at both sites: row layout `cols.map(describe)` → `(await describe(pairedGroups(cols))).groups` (pairedGroups imported); grouped layout per-group `describe({name, values})` calls → one `(await describe(flat.groups.map(...))).groups`.
- Verification: `tsc --noEmit` clean after resolution. No FLAGs.

## Commit 33/34 — a0dab43 Plan 20: align references with the seeded fit; wizard asks for the subject factor
- Conflicted: tests/checks.ts only (single import hunk). Kept both imports in one line: toggled (HEAD) + parseGroupLevels (PATCH) + WIZARDS/type Question.
- tests/reference.json auto-merged (no script run).
- Verification: `tsc --noEmit` clean after resolution. No FLAGs.

## Commit 34/34 — aa7ca30 Plan 21: Principal component analysis
- Conflicted: samples/Helix Sample.hlx, src/lib/project-file.ts, src/views/analyses/index.ts, src/views/analyses/wizards.ts, src/views/graphs/index.ts, tests/reference.json. tests/reference.ts auto-merged.
- project-file.ts: OPTIONAL_OPTIONS gains pcaAnalysisId (union with HEAD's xVariable/yVariable); the dangling-analysis check keeps HEAD's nodeOf() form + adds the pcaAnalysisId check.
- analyses/index.ts: multiple gains principal-component-analysis (kept alongside descriptive-statistics + outliers); survival line kept.
- wizards.ts: type imports keep SurvivalParams/CoxParams (HEAD) + PrincipalComponentAnalysisParams (PATCH).
- graphs/index.ts graphSeries: PATCH's scree-plot/pca-biplot branches added ahead of HEAD's volcano/heatmap/xy-multiple branches (PATCH's collapsed ternary had dropped the xy-multiple branch — kept). Multiple graphs list keeps xy-scatter (HEAD) + scree-plot/pca-biplot (PATCH).
- samples/Helix Sample.hlx: Plan 21's own sample change vs its parent was ONLY adding pcaX: 1 / pcaY: 2 to every graph's graphOptions (no new nodes; the two samples' table sets diverged long before this commit — HEAD 53 nodes, PATCH 61 — so no node splice was attempted). Resolved by taking HEAD wholesale + textually inserting `"pcaX": 1, "pcaY": 2` after `volcanoSignificance` in all 19 graphs (18 "pvalue", 1 "fdr"). CAUGHT: a json.dumps round-trip would have expanded the file's compact single-line table arrays (911 KB → 2.5 MB), so the insertion was textual, preserving the original formatting (+798 bytes total). Verified with tsx + parseProjectFile: updated=false, issues=[].
- tests/reference.json via script: HEAD 287 keys, PATCH 246 keys, merged 298 (52 HEAD-only, 11 PATCH-only), 0 differing values.
- API MIGRATIONS: src/stats/multiple/principal-component-analysis.ts sync describe → `(await describe(pairedGroups(vars))).groups` (pairedGroups already imported); tests/reference.ts scree-plot + 3 pca-biplot spot-check plotColumns calls → 4-arg signature (table type "multiple").
- Verification: `tsc --noEmit` clean after resolution; sample file verified via parseProjectFile (updated=false). No FLAGs.

## Dedup commit — 6c68e51 Adopt upstream survival + drop our TS log-rank, keep our R-package provisioning
- Plan 00 provisioning: kept OURS (bundled 45-package webR repo, vendored PACKAGES.rds, 120 s cap) over upstream's scripts/r-packages.mjs provisioning — ours is pinned and offline-capable; upstream's script downloads at setup time.
- Survival/Cox: adopted UPSTREAM (R survival package, METHODS.md-documented, GBW + MH/log-rank HRs + pairwise Holm/BH). Our TS log-rank (`survival-log-rank` analysis + `src/lib/chi-square.ts`) deleted; Plan 27 (Kaplan-Meier completion) marked SUPERSEDED in TRACKING.md. The 4.844 survival.pzfx value re-pinned by a checks.ts test against the new `survival` analysis (values verified numerically identical where comparable).
- checks.ts wired to the local bundled repo (localhost webr-repo/ server). NOTE (found later, fixed in Batch 2): the server was never closed and checks.ts never called process.exit() — npm test hung ~20 min after "All 119 checks pass". tests/reference.ts and tests/packages.ts both exit explicitly; checks.ts was the only one missing teardown. Rebase-introduced (exists at neither aa7ca30 nor upstream 583d3cd).
- Verification: tsc clean, 119/119 checks pass.

## Dedup commit — Batch 2 (WIP 29346d5, then final): nonlinear-runner merge
- Upstream nonlinear runner merged into `src/stats/xy/nonlinear-fit.ts`; Plan 02 standard-curve interpolation folded in (`src/stats/xy/standard-curve-interpolation.ts` deleted); fit-block shape + `low`/`high` CIs; graph-panel fixes (dose-response-curve, forest-plot, format-sections, graph-view, panel-controls).
- Mixed-effects migration bug (found by the binding-cox investigator, fixed in Batch 2): rebase had switched `runMixedEffects` descriptives to `pairedGroups`, silently dropping the row holding a missing value from EVERY time point (T0/T1/T3 n 6 -> 5). Restored per-column available-case descriptives; values JSON-identical to aa7ca30 incl. AIC (live runner confirms).
- tests/reference.json re-pin (prepin 6c68e51 -> current): 298 -> 293 keys; 5 removed, all expected (4x standard-curve-interpolation + survival-log-rank, both deleted analyses); 0 added. 69 changed-value keys independently verified by 4 parallel family investigators (reports in ~/.helix-rebase-tmp/investigations/): 62 structural-only (bit-identical numbers; fit blocks, low/high CIs, notes wording, legend fields); 4 numeric-differ exactly upstream v1.0.7 (two-way ANOVA post-hoc p-values — family-size fix Tukey k 15->3, Bonferroni m 30->10; key 10 also drops incomplete subject C:Y2 from post-hoc; deep-equal leaf-for-leaf to upstream, live runner reproduces, scipy confirms from raw tables); 3 numeric-differ explained by optimizer convergence (growth/decay/enzyme, max rel 2.6e-7; HEAD keeps our nls(algorithm="port") fits; scipy converges to HEAD's values, SS/R2 identical).
- checks.ts exit fix (see Dedup commit above): server hoisted, close() + process.exit() at end.
- Verification: full npm test green — 119 checks + 293 reference results + 145 package checks = 557, exit 0 (log ~/.helix-rebase-tmp/npm-test2.log). Count vs aa7ca30 (501 = 110 + 246 + 145): +9 checks (dedup re-pin tests) and +47 reference (upstream v1.0.7's new entries). tsc --noEmit clean. cargo check Linux + both Apple targets clean (after scripts/setup-linux.sh re-run for GTK dev packages wiped by container replacement, and CC_<target> clang overrides per DEV-SETUP.md).
