# VALIDATION.md — Phase 4 parity record

## Plan 00 — R-package provisioning (2026-11-10)

Engine: **webR 0.6.0** (pinned exactly in package.json), **R 4.6.0**
(`R.version.string`, verified in WebR on Hatch Linux). Repo source:
**bundled** — `webr-repo/`, built by `scripts/build-webr-repo.sh` from
`https://repo.r-wasm.org/bin/emscripten/contrib/4.6` (see the manifest
`scripts/webr-repo-manifest.json`). The app copies it into the bundle at
`/webr-repo/` (vite plugin); installs read from disk, never the network.
CDN fallback exists in the app (`allowCdnFallback`, default on) for a build
made without the repo; tests run with it off, so every test install proves
the bundled path.

Closure: **45 packages, 57.0 MB** (11 pinned + 34 transitive). Every file's
MD5 is verified against the repo index at build time; the trimmed
`PACKAGES` index lists exactly the closure.

### Package table

| Package | In WASM index (4.6)? | Version pinned | License (CRAN) | WebR smoke result (Hatch Linux) | Plans needing it |
|---|---|---|---|---|---|
| survival | yes | 3.8-12 | LGPL (>= 2) | `coxph` exists; `survdiff` χ² 0.5280480582 = TS log-rank; `coxph` coef 0.5785983558686906 | 10, 27 |
| pROC | yes | 1.19.1 | GPL (>= 3) | `roc` AUC 1.0 on perfect separation | 05 |
| lme4 | yes | 2.0-6 | GPL (>= 2) | `lmer` converges (seeded design); fixed effects + REML criterion pinned in tests/packages.ts | 14-v2, 20 |
| lmerTest | yes | 3.2-1 | GPL (>= 2) | Satterthwaite p-values (group 0.0242, time 4.57e-14 on the P-07 design) | 20 |
| multcomp | yes | 1.4-32 | GPL-2 | `glht` Dunnett p 1.05e-11 / 1.48e-04 | 25 |
| mvtnorm | yes | 1.2-4 | GPL-2 | `pmvnorm` 0.46606494267439214 | 25 |
| nortest | yes | 1.0-4 | GPL (>= 2) | `ad.test` A 0.30904, p 0.54612 (seeded n=50); `pearson.test` exists | 23 |
| outliers | yes | 0.15 | GPL (>= 2) | `grubbs.test` G 2.0399410222962713, p 1.83e-06 | 24 |
| deming | yes | 1.4-1 | LGPL (>= 2) | slope 1.9999988928883004, intercept 3.3e-06 on y = 2x (see note) | 13 |
| MethComp | yes | 1.30.2 | GPL (>= 2) | `Deming` slope 2, intercept 0 exactly on y = 2x | 13 (alt) |
| nlme | yes | 3.1-171 | GPL (>= 2) | `lme` fixed effects match `lmer` to 1e-9 | 14-v2, 20 (alt) |
| moments | yes (0.14.1, GPL >= 2) | **not pinned** | GPL (>= 2) | available in the index; not bundled — plan 23 prefers the TS route for D'Agostino–Pearson | 23 (alt) |

No package in the table is absent from the WASM index. Nothing is silently
designed around: every dependent plan can use its package.

### Transitive closure (vendored with the 11 above)

MASS, Matrix, R6, RColorBrewer, Rcpp, RcppEigen, Rdpack, S7, TH.data, boot,
cli, codetools, coda, cpp11, farver, ggplot2, glue, gtable, isoband,
labeling, lattice, lifecycle, minqa, nloptr, numDeriv, rbibutils,
reformulas, rlang, sandwich, scales, vctrs, viridisLite, withr, zoo.
(`parallel` is a base R package and ships inside R.wasm.)

### Decisions and corrections (measured, not assumed)

1. **Vendored prebuilt binaries, not an rwasm Docker compile.** Hatch has
   no Docker, so the plan's literal option (b) build cannot run here — and
   the files on repo.r-wasm.org ARE the rwasm-built binaries for this
   webR/R release (same bytes, same MD5s). Vendoring them is the same
   shipped artifact without the compile step. `build-webr-repo.sh` fails
   loudly if a pinned version leaves the index, so versions cannot drift.
2. **57 MB exceeds the plan's ~50 MB "revisit" trigger.** Proceeding: the
   two big subtrees are hard dependencies, not optional — TH.data (8.8 MB)
   is a hard `Depends` of multcomp, and the ggplot2 tree (7.5 MB) is a hard
   `Imports` of lmerTest. Splitting them out would break offline use for
   plans 20/25. The size is recorded per package in
   `webr-repo/MANIFEST.json`.
3. **codetools must be vendored.** It is a *recommended* R package that
   webR 0.6.0 does NOT ship in its base library (verified:
   `installed.packages(priority="base")` lists 14 packages, codetools not
   among them), and multcomp `Imports` it — without it `multcomp::glht`
   fails at load. It is in the repo index (0.2-20) and is now vendored.
   The build script's base-package list was corrected accordingly.
4. **deming P-05 tolerance corrected: 1e-9 → 1e-5.** `deming::deming`
   1.4-1 returns slope 1.9999988928883004 / intercept 3.3e-06 on exact
   y = 2x data — identical for n = 5 and n = 10, a deterministic artifact
   of its internal fitting routine, not data noise. The plan's 1e-9 was
   the planner's assumption; the measured value is pinned instead.
   MethComp::Deming on the same data is exact (0 / 2).
5. **P-06/P-07 pins live in `tests/packages.ts`, not `tests/reference.json`.**
   `reference.ts` compares its whole output file, so foreign keys would
   report as changed; the pins carry full provenance comments in the test
   file instead (R 4.6.0 + package versions + seed).
6. **CDN installs do not work from WASM on Hatch.** The WASM network
   stack bypasses the egress proxy (raw TCP is redirected and fails), so
   `webr::install` from the CDN fails inside WebR here even though Node
   `fetch` reaches the repo. The bundled repo (localhost in tests,
   app bundle in the app) is the only working path on Hatch. On a real
   desktop the webview network works, so the CDN fallback remains valid
   there.
7. **No `PACKAGES.rds` is vendored.** The installer tries `.rds`, then
   `.gz`, then plain `PACKAGES`, and succeeds on the fallback (one
   harmless console line per install).
8. **Settings row is not built.** Helix has no Settings view; the helpers
   for it exist (`installedPackageVersions()`, `packageRepoSource()`,
   `packageDiagnostics()`) and the row lands when a Settings view does.
9. **License audit (Phase 0).** No third-party code is vendored into
   Helix source. The `.tgz` files are data artifacts (CRAN packages)
   that run inside the sandboxed WASM R process, never linked into Helix
   code; their licenses (GPL-2/3, LGPL, MIT, Apache-2.0, Unlimited for
   `boot`) are recorded per package in `src/stats/webr.ts` and
   `webr-repo/MANIFEST.json`, all compatible with Helix's GPL-3.0.
   The build script itself is original Hatch work (bash + python3 stdlib).

### Tests

`tests/packages.ts` (P-01–P-11 + registry/manifest consistency + registry
smoke): **143 checks, all passing** under `npm test` (83 checks +
112 reference results + 143 package checks). Cold start (engine-ready to
`survival` ready, bundled path): ~10 s, budget 30 s.
