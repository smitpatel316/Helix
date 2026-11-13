# R2-M2 GUI proof (Linux) — PASS

Date: 2026-11-12 ~22:23–22:29 UTC (14:23–14:29 PST). Branch `fix/r2-m2`, base `cd327b8`.
Binary: `/home/hatch/workspace/helix-fix-r2-m2/src-tauri/target/release/helix`,
103,682,144 B, sha256 `8e34773c74e706b0793ae7881613e383a3a4b2f40dbcf4d2f1ede2e6fa249d22`,
mtime 2026-11-12 22:18 UTC. Built from this worktree (own target dir; the
frontend `dist/` was built 20:50 UTC from the same tree, with the fix).
Note: the link step first failed for missing system libs — the 21:22 UTC
container replacement had wiped the dev packages installed by the 19:39 UTC
setup run (`rust-lld: unable to find library -lgtk-3` etc.); setup-linux.sh
was re-run (attempt 8 won the post-replacement apt stampede) and the link
then succeeded. A second, unattributed agent also ran `cargo check` and a
release `cargo build` in this worktree during the evening (logs
`build-cargo-direct4.log`, PIDs 24841/27712, parent hatch-execd) — the
binary above is from that build + a no-op rebuild by this lane; same tree,
same hash.

## Display
Xvfb **:98**, 1280x800x24 + openbox, `dbus-run-session`. Fixture
`m2-gui.hlx` (left by an earlier M2 attempt): XY table `[0,0,2,12,20,30]`
with Time0 = 10 (pre-Time0 median 0) + a pre-built `binding-kinetics`
analysis node (association-then-dissociation, HotNM = 1, Time0 = 10) and a
full-grid control table/analysis. Launched via `m2-gui.sh` (session restore
seeded through a private XDG_DATA_HOME).

## Asserts
1. **Fit succeeds on zero-median data — PASS.** `m2-02-after-later.png`:
   Kinetic Kd (nM) = 1, Eq = 50, R squared = 1, Sy.x = 4.078e-12,
   Sum of squares = 3.325e-23, DF = 2, N = 6. Coefficients: Kon =
   100000000, Koff = 0.1, Bmax = 100, NS = 0.5 — exact ground truth.
   Pre-fix, nls got a non-finite Kon start and the fit failed outright.
2. **Finite Kon start named in the notes — PASS.** `m2-03-notes.png`:
   "Starting values: Kon = 329900000, Koff = 0.01667, Bmax = 35.9,
   NS = 0.5." (median floored at the smallest positive pre-Time0 time, 2).
3. **Fitted curve renders — PASS.** `m2-04-graph.png`: rise to ~43 at
   t = 10 then exponential decay, annotated "Kon = 100000000, Koff = 0.1,
   Kinetic Kd = 1 nM, R² = 1". (First capture was a blank canvas — the
   Plotly render took ~20 s under load; the retake shows the curve.)
4. `m2-01-analysis.png` shows the same result with the "Helix 1.0.9 is
   available" update dialog overlaying it; dismissed via "Later".
   App-log "errors" are environment noise only (DBus fd limit, AT-SPI
   bus, fuse mount, DRI3) — no app errors.

## Suite caveat (for the coordinator)
`npm test` did NOT go green in one pass in this lane: checks 161/161 pass;
reference 364/365 — the single mismatch is the mixed-effects case failing
to install `lme4`/`lmerTest` inside the 120 s WebR budget (infra timeout,
unrelated to M2; the same timeout hit the previous builder at 19:31 UTC);
the M2 regression case itself matches reference.json and passes all
`disagreements()` true-parameter assertions (0 failures). The `packages`
stage never ran (chain stops at reference exit 1). Needs a re-run in the
merged-suite verification, where the install may fit the budget.

## Addendum — full suite green (same session, ~22:33–22:47 UTC)
The caveat above is superseded: a fresh full `npm test` run
(`~/.tmp-r2-m2/npm-test-final4.log`, exit 0) went green in one pass —
**161/161 checks, 365/365 results match, 144/144 package checks**.
The earlier mixed-effects `lme4` install timeout did not recur
(survival cold start 40.3 s, inside the 120 s budget). `npm run check`
(tsc) clean, `cargo check` clean, and a full `npm run build:linux`
(exit 0, 9m 37s) rebuilt the binary to the **identical sha256
`8e34773c…49d22`** (103,682,144 B), so the GUI proof above stands
against the final artifact unchanged.
