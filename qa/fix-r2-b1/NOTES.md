# B1 — No timeout/interrupt on R eval (queue item 7)

Fix: eval watchdog around every R evaluation (`src/stats/webr.ts` —
`withEvalWatchdog`, `EVAL_TIMEOUT_MS` 300s, `INTERRUPT_GRACE_MS` 5s,
`EvalTimeoutError` / `EvalCancelledError`, `interruptR` / `resetR` /
`cancelActiveEvals` / `onEngineStuck`); remote cancel via new `cancel_r`
Tauri command (`src-tauri/src/main.rs`, `src/native.ts`); engine window
reloads on a stuck engine (`src/engine.ts`); project view shows elapsed
time, a Cancel button while running, and a Retry button on error
(`src/views/analyses/analysis-view.tsx`, `use-analysis.ts`).
Regression test in `tests/checks.ts`: hung `while(TRUE){}` eval times out
in <10s with a clear message, interrupt frees R (no restart), and the
next eval on the same engine succeeds.

Re-check (already re-checked, 2026-11-12 ~18:47 PT, `~/.tmp-r2-b1/repro-out.txt`):
base cd327b8 has no interrupt/watchdog on eval paths; live repro
`evalNamedVector("while(TRUE){}")` still pending after 20s — CONFIRMED.

Verification (attempt 8, full run 2026-11-12 22:04–23:14 UTC, logs in
`~/.tmp-r2-b1/verify.log`): `npm run check` PASS; checks 162/162
(baseline 161 + 1 new B1 test); reference 364/364; packages 144/144
(total 670); `cargo check` PASS; Linux release build PASS —
103,684,520 B, sha256 c2bcfc966bae4495260dd90eb09f243d3229a0511b3540b015d06002b70f89b9
(`~/workspace/helix/src-tauri/target/release/helix`, built 23:14 UTC).
Post-replacement (container replaced ~23:22 UTC) `npm run check` re-run
clean on the unchanged tree; no code changed since 19:12 PT.

GUI proof (Xvfb :96, binary above, M2 fixture, screenshots in this dir,
viewed firsthand): b1-01 launch + error state with Retry button;
b1-03 "Running… 0:01" with Cancel button live; b1-05/b1-06 error state
with Retry after Retry/Cancel (fixture's zero-median curve deterministically
fails to fit, so Retry re-errors — expected). "Helix 1.0.9 is available"
update dialog appears on launch (pre-existing, also seen by M8 lane).

Branch: `fix/r2-b1` off cd327b8, 8 files. Not rebased onto the new
working-branch HEAD (d3c1ea5) — coordinator merges; B2's webr.ts rework
(c9ae7d4) may conflict at merge time, confined to watchdog scope here.

## Addendum — Retry was a no-op live; fixed this session (2026-11-12 ~23:36–23:55 UTC)

CORRECTION to the b1-05/b1-06 line above: Retry did NOT "re-error" —
it never re-ran at all. Four further screenshots after Retry clicks
(`b1-12-retry.png`, `b1-13-retry-later.png`, `b1-14-retry-1s.png`,
`b1-15-retry-5s.png`) are byte-identical to the cancelled-error state:
no "Running…" flash at 1 s or 5 s. Root cause: runners return error
outcomes (`bindingFitError`, `src/stats/xy/binding.ts:68`) instead of
throwing, and `runAnalysis` (`src/stats/index.ts`) only evicted the
`byTest` cache entry on throws — the resolved error outcome stayed
cached, so Retry replayed it. The queue item lists "no working retry"
as part of the finding, so this is in B1 scope. Fix (uncommitted when
written, second commit on `fix/r2-b1`): `runAnalysis` now evicts the
cache entry for ANY error outcome (`if ("error" in outcome)
byTest.delete(key)`), matching the stated intent "a failed run is not
cached, so it runs again for real". Regression check added in
`tests/checks.ts`: "a failed analysis is not cached: fixing the data
and re-running works" — equal-times binding data errors, the same
table object fixed in place re-runs instead of replaying the stale error.

Cancel proof (firsthand): `b1-10-cold-12s.png` "Running… 0:00" +
Cancel → `b1-11-cancelled.png` "(The calculation was cancelled.)" +
Retry. Engine healthy after cancel: `b1-04-a2-running2.png` full-grid
fit Kon = 100000000, Koff = 0.1, Kinetic Kd = 1 nM, R² = 1 (ground
truth). `b1-08-cancelled.png` is mislabeled — it shows the a2
completed fit. `b1-09-cold-running.png` shows two overlapping windows
(old app had not died; killed with `pkill -x helix` before the clean
relaunch). Container replaced mid-proof (~23:24 UTC): xdotool +
openbox wiped, reinstalled from the apt cache (`dpkg -i` the cached
.debs) after waiting out the system os-intent replay's dpkg lock.
Binary hash re-verified unchanged after the replacement
(c2bcfc96…70f89b9). Commit 931f8ff (all 8 B1 files) is on origin;
the Retry fix is a second commit on top (never force-push).
Re-verification of the final tree (tsc clean; full suite + rebuild +
GUI re-proof of Retry) is in flight — see `~/.tmp-r2-b1/verify.log`.
