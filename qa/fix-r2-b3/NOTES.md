# R2-B3 GUI proof (Linux) — PASS

Date: 2026-11-12 ~22:00–22:15 UTC (14:00–14:15 PST). Branch `fix/r2-b3`, base `cd327b8`.
Binary: `/home/hatch/workspace/helix-fix-r2-b3/src-tauri/target/release/helix`,
103,682,144 B, sha256 `63debd6d8b0ed5c8a30c83c8e78d0d357658b07945e18d164d9cd2f045505a1c`,
mtime 2026-11-12 21:06 UTC. Built from this worktree before the ~13:22 PT
container replacement (`build-linux.log` in `~/.tmp-r2-b3`, 54m54s); both
changed sources are older than the binary (wizards.ts 20:04 UTC, checks.ts
18:09 UTC), so no rebuild was repeated.

## Display
Xvfb **:98** (1280x800x24 + openbox, `dbus-run-session`). :99 was owned by
sibling lane M10. App session-restored the `plan18` project first (argv .hlx
ignored); fixture opened via Ctrl+O. Fixture untouched (362 B, md5
`833c7be197516d152c8c0b470e545f13`, mtime unchanged).

## Fixture
`b3-one-y.hlx` — XY table "B3 one-Y inhibition", columns Title/X/Y1, rows
(0,10), (1,9), (2,7), (5,4), (10,2). Deliberately unfittable synthetic data:
it exercises the wizard walk, not a Morrison fit.

## Asserts
1. **Model question — PASS** (`b3-08-wizard-model.png`): "Which inhibition
   model should be fitted? Global models need at least two Y data sets —
   with one Y data set, only Morrison Ki (tight binding) can be fitted."
   Only option offered: **Morrison Ki (tight binding)** (selected), Next
   enabled. Pre-fix the default was a global model whose Y question needed
   min 2 from one option.
2. **Y question — PASS** (`b3-09-wizard-y.png`): "Which Y data sets should
   be fitted? Each is one inhibitor concentration." Y1 checked, Next
   enabled — the dead-end is gone.
3. **Walk to Run — PASS** (`b3-10` Et=5, `b3-11` [S] blank, `b3-12` Km
   blank): every step advances; final step shows **Run** enabled.
4. **Run end-to-end — PASS** (`b3-25-fit-result2.png`): analysis created
   ("Enzyme kinetics — Inhibition" in the sidebar) and the run completes
   with a clean message: "This curve ("Morrison Ki (tight binding)") could
   not be fitted to these data (Convergence failure: false convergence
   (8)). Try another model or Y data set." — expected: the fixture data
   are arbitrary decreasing values, not real inhibition data. No hang, no
   crash on the retry.

## First-Run crash note (transient, not reproduced)
The first Run click (~22:05 UTC) ended with a black screen and the helix
process gone by 22:07, with no crash message in `app.log` (it ends with
non-fatal Gtk-CRITICAL assertions from 22:01, while the app kept running
fine for 4+ minutes after). Relaunch + identical walk + Run completed
cleanly (assert 4). No dmesg access in this container to confirm/deny an
OOM kill; the box was running 4+ sibling lanes (B2 npm test, M8 tauri
build, B4/M2 cargo) at the time. The crash path (Run → WebR boot) is
untouched by this change, and the suite's enzyme-inhibition checks pass,
so this is recorded as a transient environmental event, not a B3
regression. If it recurs on the merged tree, it belongs to B1/M15/M17
territory, not B3.

## Verification summary
- `npm run check` (tsc): clean.
- Full suite: checks **162/162 pass** (161 base + 1 new B3 check),
  reference **364/364 match**, packages **144/144 pass** — total **670
  green**. Note: the single `npm test` run's packages leg timed out on
  the lme4/lmerTest install (>120 s, loaded box); packages.ts was re-run
  standalone once and passed 144/144 (log `packages-retry.log`).
- `cargo check`: clean (11.28 s).
- Re-check (prior session, `~/.tmp-r2-b3/repro-base-out.txt` /
  `repro-fixed-out.txt`): REPRODUCED on base, NOT REPRODUCED after fix —
  not redone per the re-check rule.
