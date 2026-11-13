# R2-B4 GUI proof (Linux) — PASS

Date: 2026-11-12 ~22:50–23:05 UTC (14:50–15:05 PST). Branch `fix/r2-b4`, base `cd327b8`.
Binary: `/home/hatch/workspace/helix-fix-r2-b4/src-tauri/target/release/helix`,
103,682,144 B, sha256 `3d7def7436316fc6ddd87e13201f37d452e896fcd82766b85e7a0dd6252bfd10`,
mtime 2026-11-12 22:49 UTC. Built from this worktree after the ~13:22 PT
container replacement (`build-linux-3.log` in `~/.tmp-r2-b4`, 9m41s release
step; `cargo check` clean before it). Both changed sources are older than
the binary (wizards.ts, checks.ts), so no rebuild was repeated.

## Display
Xvfb **:97** (1280x800x24 + openbox, `dbus-run-session`). :96 B1, :98 B3,
:99 M10. App session-restored the `plan18` project first (argv .hlx
ignored); fixture opened via Ctrl+O. Fixture untouched (360 B, md5
`1911c5c26c1f53fd16dad4da030e3dcc`, mtime unchanged 22:50 UTC).

## Fixture
`b4-one-y.hlx` — XY table "B4 one-Y special", columns Title/X/Y1, rows
(0,10), (1,9), (2,7), (5,4), (10,2). Same shape as B3's `b3-one-y.hlx`
(one Y series). Deliberately unfittable synthetic data: it exercises the
wizard walk, not a Schild fit.

## Asserts
1. **Y question names the shortfall and Next is enabled — PASS**
   (`b4-25-wizard-ys.png`): "Only one Y data set exists — this fit needs
   a control and at least one shifted curve. Add another Y column to the
   table, then run it again." Y1 checked, **Next enabled**. Pre-fix this
   step had `min: 2` with 1 option, so Next stayed disabled forever with
   no message — the dead-end is gone.
2. **Walk to Run — PASS** (`b4-26` first series Y1, `b4-27` B units M,
   `b4-28` HillSlope step): every step advances; final step shows **Run**
   enabled.
3. **Run end-to-end — PASS** (`b4-29-running.png` / `b4-30-fit-result.png`):
   analysis created ("Dose-response — Spec..." in the sidebar) and the run
   completes with the runner's clear error, previously unreachable:
   "Dose-response — Special fits several curves at once — add at least a
   control and one shifted curve." No hang, no crash on the run.

## Transient crash note (same class as B3, not a B4 regression)
The first app instance died at ~22:58 UTC (black screen, process gone, no
crash message in `app.log`) right after an Escape + menu click — the same
transient B3 recorded on their first Run click. Relaunch + identical walk
completed cleanly (asserts 1–3 above). The crash path (menu interaction)
is untouched by this change, and the suite's dose-response checks pass, so
this is recorded as a transient environmental event. If it recurs on the
merged tree, it belongs to B1/M15/M17 territory, not B4.

## Click-offset note (Xvfb driving)
`xdotool mousemove` coordinates land ~55 px left of the reported pointer
in this Xvfb/openbox session (a click sent to x=330 opened the Table menu
whose label sits at ~275; OK-button clicks at x=850 missed). Keyboard
navigation (arrows/Return/Ctrl+O/Ctrl+Alt+A) is reliable; menu-bar clicks
were worked around with the Right-arrow key. Wide dialog rows (picker,
wizard options) are unaffected.

## Verification summary
- `npm run check` (tsc): clean.
- Re-check (this session, `~/.tmp-r2-b4/recheck-base-out.txt` /
  `recheck-fixed-out.txt`): REPRODUCED on pristine cd327b8 (`ys` min 2,
  1 option, DEAD-END: true), NOT REPRODUCED after fix (min 1, shortfall
  named, DEAD-END: false).
- Full suite: checks **162/162 pass** (161 base + 1 new B4 check),
  packages **144/144 pass**. Reference **363/364**: the single changed
  result is the mixed-effects `mixedBalanced` case failing on the
  documented lme4/lmerTest install timeout (>120 s, `webr.ts:280` —
  measured 48 s under load, 71 s with a second webR contending at load
  6–9; this box ran at load 11–21 with 18 lanes building). It failed
  identically 3x; the other mixed-effects cases pass because the install
  completes in the background and later calls join it. No causal path
  from this change: the failure is a package-install timeout before any
  fit runs, and the change touches only the dose-response-special wizard
  questions. B3's lane saw the same class of timeout on the packages leg
  and got a fully green re-run on a quieter box — the coordinator's
  merged-suite verification is the place to confirm this one green.
- `cargo check`: clean (11m20s, first build after replacement).
- Linux release build: `npm run build:linux` green (see binary above).
