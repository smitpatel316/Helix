# R2-M12 GUI proof (Linux) — PASS

Date: 2026-11-13 ~02:59–03:00 UTC (Nov 12 ~18:59–19:00 PST). Branch `fix/r2-m12`, base `9c4cbcd`.
Binary: `/home/hatch/workspace/helix-fix-r2-m12/src-tauri/target/release/helix`,
102,731,736 B, sha256 `1780cde9e8735fbf5b6d756ea3d9070f…` (built from this worktree).

## Fix (take 1's code, resumed by take 2)
`src/views/graphs/volcano.ts`: a p / FDR of exactly 0 no longer drops the gene.
`if (yv <= 0) continue` → `if (yv < 0 || !Number.isFinite(yv)) continue` plus
`yv = Math.min(-Math.log10(Math.max(yv, Number.MIN_VALUE)), VOLCANO_MAX_LOG10)`
with `VOLCANO_MAX_LOG10 = 308`. Only genuinely invalid values (negative, NaN,
±Infinity) are skipped. Regression test in `tests/checks.ts` (ZERO p=0 and
TINY p=1e-320 plot at 308 and are labelled first; NEG p=-0.01 is not drawn).

## Verification (this worktree, base 9c4cbcd)
- `npm run check` (tsc): clean.
- `npm test` legs, run one at a time (box loaded; suite agent on 6c7d350 was
  running): checks **172/172**, reference **366/366**, packages **154/154**
  = **692 green**. First checks run showed 4 failures — all environmental
  (webr-repo/ not built in this worktree + a transient repo.r-wasm.org CDN
  failure on package installs); after `scripts/build-webr-repo.sh` (45
  packages, PACKAGES.rds round-trips) the re-run passed 172/172.
- `cargo check` (Linux host): PASS — `Finished dev profile in 22m 52s`, no errors.
- Linux build (`npm run build:linux`): release binary above. First attempt
  died at link time (`rust-lld: unable to find library -lgtk-3` etc.) —
  the ~01:48 PT container replacement had wiped the dev libs; fixed by
  killing a stuck orphaned `apt-get update` (PID 10038, 2h07m, 0 CPU, PPid 1)
  that held the apt lock, then `APT_UPDATE=1 scripts/setup-linux.sh` (exit 0).

## Display
Xvfb **:98**, 1280x800x24 + openbox, `dbus-run-session`, private XDG_DATA_HOME.
Fixture `m12-gui.hlx` (multiple table, Gene/LFC/P; ZERO p=0, TINY p=1e-320,
NEG p=-0.01, OK p=0.001, plus MID1/MID2/BIG/SMALL) opened via the seeded
session; `activeNodeId` g1 (Volcano plot). Fixture untouched (md5
`b8aa6382a3ed4693aca255f79ab59afe`, 7386 B).

## Asserts (screenshot `m12-02-after-later.png`)
1. **ZERO plots at the top — PASS.** Labelled "ZERO" at LFC 2, y ≈ 308 (Y axis
   autoranges to ~320). Pre-fix it was dropped entirely.
2. **TINY plots at the top — PASS.** Labelled "TINY" at LFC −2, y ≈ 308
   (1e-320 → −log10 320, capped at 308).
3. **NEG is not drawn — PASS.** No point or label at LFC 3.
4. **OK / SMALL / BIG plot at their values — PASS.** OK (−1, 3), SMALL (1.5, 2),
   BIG (4, 10), all labelled. Threshold lines at ±1 FC and y=1.3 visible.
5. An update dialog ("Helix 1.0.9 is available") covered the plot on launch;
   dismissed with "Later" — the dialog is pre-existing update-check behavior,
   unrelated to this fix.

## Incident (stash cross-contamination, ~15:52 PT — resolved, no work lost)
After the ~15:50 PT daemon restart, the M12, M14 and M19 take-2 builders all
did a stash → reset → pop dance at once. `git stash` is shared across all
worktrees, so plain `git stash pop` took the top of the shared stack: M12
popped M19's stash and M19 popped M12's. Recovered by saving both contents
as patch files, reverting both trees to clean 9c4cbcd, and applying each patch
to the correct tree (verified by `git diff --stat` matching the take-1 diffs
exactly). Full write-up: `~/workspace/.helix-fix2-coord/STASH-CROSS-1552-NOTE.md`.
Rule for all lanes: never plain `git stash pop` while other lanes are alive —
pop by explicit index, or use a patch file.
