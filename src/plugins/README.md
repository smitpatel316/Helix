# Plugin API — groundwork (v3 Phase 4, roadmap §4b + §5)

Branch `v3/plugin-api`. Groundwork only — no marketplace.

## What exists

| Piece | File | What it does |
|---|---|---|
| Manifest | `manifest.ts` | Schema + validation: id, name, version, apiVersion (semver), author, license, permissions. Unknown permission names rejected at install time. `titer.` ids reserved for first-party. Plain-language permission lines for install/review. `apiVersion` major compatibility → "needs Titer 3.x" disable message. |
| Parameters | `parameters.ts` | Parameter kinds reusing the app's existing kinds: choice (same shape as TAILS / CORRELATION_METHODS option lists), number (range + default, ROUT_Q-style), boolean, text, names, column. Defaults, range/option re-checks (the runner re-checks, as first-party wizards do). |
| Capabilities | `capabilities.ts` | Closed `titer.*` command catalogue (8 commands), one permission per command, fail-closed check. Only permissions granted at the enable review step count — a declared permission grants nothing until granted. |
| Analysis spec | `analysis-spec.ts` | Table types, parameters, serialisable wizard questions (choice/number/names/text; `"columns"` options resolve at ask time) + adapter to the wizard's own `Question` type. R compute contract: groups as `g0`, `g1`, … ending in a `c(name=value, …)` named vector (the `ColumnTestSpec` contract); packages only via the vendored repo; load-time denylist scan as a tripwire. JSON specs are R-only; TypeScript compute registers in code. |
| Registry | `registry.ts` | Plugin analyses under namespaced ids (`plugin:<plugin-id>:<analysis-id>`) so they can never collide with or shadow first-party analyses. `resolveAnalysis` covers both sources in one call. `runPluginAnalysis` mirrors `runAnalysis`: params resolve + re-check, packages install first via `ensurePackages`, R via `evalNamedVector`, pure-TS via `lib/summary`, failures as error outcomes. |
| Loader | `loader.ts` | Folder/zip loading (JSZip, text files only). Install DISABLED by default → `requestEnable` (pending-review) → `confirmEnable` (granted subset) → enabled; disable unregisters at once; app-update recheck disables incompatibles with the clear message and never auto-enables. |
| Fixture | `examples/hello-analysis/` | `plugin.json` + `index.ts`: `hello-mean` (R, through the install path) and `hello-scaled-mean` (pure-TS, choice + ranged-number params, in code). `verifyHelloPlugin()` runs both on synthetic columns and checks the numbers. |

## What is deliberately NOT here

- Plugin JS is never executed. There is no Isolation webview yet (Phase 4)
  — executing third-party JS without it would be the no-sandbox default
  the roadmap explicitly does not borrow.
- No marketplace UI/server, listing/review flow, delayed auto-updates,
  safety scorecards, publisher verification, paid-plugin handling.
- No wizard-picker or results-view wiring for plugin analyses. The seam
  is `resolveAnalysis` / `runPluginAnalysis`; the picker must offer
  plugin ids, the wizard must call `toWizardQuestions` +
  `answersToParams`, and the results view must accept
  `PluginAnalysisResult` (its `testType` is the namespaced id string).
- No plugin cache in `runPluginAnalysis` (first-party `runAnalysis`
  caches per table version; same-keyed plugin caching is Phase 4).

## Blocked — assumed nothing

- **Q7 (paid plugins under GPL-3.0 — needs Smit + a lawyer):** no license
  allowlist, no paid handling, no marketplace cut. The license string is
  recorded verbatim and never judged.
- **Q8 (who reviews / hosting model):** no review queue, no listing flow,
  no hosted-vs-GitHub-index decision. The groundwork works the same under
  any of the three review models.

## Trust model (roadmap §4b, honest line)

There is no true JS sandbox in a desktop webview. The model is a
capability boundary, not a sandbox: the `titer.*` allowlist (fail closed),
permissions shown in plain language at install/review, install-disabled-
by-default with a review step, and computation contained in webR (R cannot
touch the filesystem or network except through the host bridge). The R
denylist scan in `analysis-spec.ts` is a load-time tripwire, not a
security proof.

## Verification status

- `npm run check` (tsc) — the verification that runs in this lane.
- Runtime: `verifyHelloPlugin()` + the R path through `evalNamedVector`
  boot the webR engine — **build verification pending v1 clear** (no
  rustc builds, no test-suite runs, no GUI runs in this lane per the
  v1-owns-the-box rule).
- No Rust touched.
