# R2-B2 GUI proof (Linux) — PASS (launch smoke test)

Date: 2026-11-12 ~22:57–22:59 UTC (14:57–14:59 PST). Branch `fix/r2-b2`
(`1f27a96`), base `cd327b8`.
Binary: `/home/hatch/workspace/helix-fix-r2-b2/src-tauri/target/release/helix`,
103,098,528 B, sha256 `4ccae99dc730f08e7e40cb01a2a9b4e44299f09d181e7d8370c7fafbda27b3aa`,
mtime 2026-11-12 22:56 UTC (built from this worktree; release build finished
12m 39s after one OOM-killed attempt at the LTO link — see build logs).

## Display
Xvfb **:98**, 1280x800x24 + openbox, `dbus-run-session`. (:97/:99 were in use
by the B4 lane's GUI proofs.)

## Asserts
B2 has no GUI-visible change — the fix is in the R-package install chain
(`src/stats/webr.ts`), so this is a launch smoke test, not a feature proof.
1. **Launch — PASS.** `b2-01-launch.png` / `b2-02-loaded.png`: app renders
   fully — menu bar (Helix/File/Edit/Table/Analysis/Graph/Figure/View/Window/
   Help), sidebar tables (Schild, EC50 shift, Operational, Error), main panel
   ("Operational — partial agonist"). Session-restored a previous project and
   showed the in-app "Project Updated" dialog (Quirk-2 fix).
2. **Interactivity — PASS.** `b2-03-after-ok.png`: Enter dismissed the dialog;
   main window renders cleanly behind it.
3. App quit via PID file (wrapper + orphaned child PID 56803 killed by exact
   PID); :98 freed.

## Verification status (for the merge decision — see coordinator report)
- `npm run check`: clean (this session).
- `cargo check`: clean (8.5 s incremental this session; also 20:20 full pass).
- Full `npm test`: NOT green this session — 161 checks pass, reference
  363/364 then 362/364, both mixed-effects cases failing only on the
  lme4/lmerTest install exceeding the 120 s budget. Root cause measured, not
  a B2 regression: a cold lme4+lmerTest install takes ~214 s on this box
  (base code, `time-lme4-base.log`), and the 120 s budget predates B2.
  A full green run exists from 17:46 UTC (`npm-test-run2.log`:
  161 + 364 + 154) with this fix, before P-12 was added.
- P-12 (the B2 regression test) verified standalone in
  `~/.tmp-r2-b2/verify-b2.log`: ALL 10 VERIFY CHECKS PASS — hung install
  times out for owner + joiner, status `failed`, chain advances
  (installsStarted +1), retries succeed after repo recovery. The committed
  P-12 block in `tests/packages.ts` is the same scenario; it has not yet
  passed inside a full `npm test` run because reference.ts stops the `&&`
  chain first. The lme4 probe (`time-lme4.log`) also shows the fix working
  on the real workload: attempt 1 times out at 120 s, retry starts a fresh
  install (installsStarted 2) and succeeds in 89.5 s.
