# R2-M1 GUI proof (Linux) — PASS

Date: 2026-11-12 ~17:40–18:00 UTC (09:40–10:00 PST). Branch `fix/r2-m1`, base `cd327b8`.
Binary: `/home/hatch/workspace/helix/src-tauri/target/release/helix`,
103,682,144 B, sha256 `b7f83004b80c4356bf4f5457a88541b868a633c33b7081d61f8d12191cc5c449`,
mtime 2026-11-12 17:40 UTC (built from this worktree; `CARGO_TARGET_DIR` pointed
at the main checkout's target dir — see quota note below).

## Display
Xvfb **:97**, not :98 — :98 was already owned by a sibling Round 2 lane
(PID 28144, started 17:27). 1280x800x24 + openbox, `dbus-run-session`.
App launched with fixture `m1-inhibition.hlx` (XY table, columns `0 nM` and
`Day 2 — 10 nM`; noiseless competitive data, Vmax=100, Km=10, Ki=5).
Note: the app session-restored the `plan18` project first (argv .hlx ignored);
fixture opened via Ctrl+O. Fixture untouched (821 B, md5
`689b6b5ed379da8c8cb3ba3bd7c57593`, mtime unchanged).

## Asserts
1. **Wizard [I] prefill — PASS.** `m1-16-wizard-i-fields.png`: [I] for "0 nM"
   prefilled `0`. `m1-17-wizard-i-day2.png`: [I] for "Day 2 — 10 nM"
   prefilled **`10`** — pre-fix it parsed as 2 (first number in the title).
2. **End-to-end fit — PASS.** `m1-18-fit-running.png`: Competitive, R² = 1,
   Vmax = 100, Km = 10, **Ki = 5** — exact ground truth.
   `m1-20-fit-notes2.png`: notes record `Inhibitor concentrations: "0 nM"
   [I] = 0, "Day 2 — 10 nM" [I] = 10`.
3. App quit via PID file; no save of the fixture.

## Build note (quota)
A fresh `cargo check` in this worktree died on btrfs `Disk quota exceeded`
(os error 122) — writes anywhere under /home/hatch failed until 596 MB of
the partial worktree target was freed; sibling lanes were concurrently
building fresh targets. `cargo check` and `npm run build:linux` were run
with `CARGO_TARGET_DIR=/home/hatch/workspace/helix/src-tauri/target`
(reusing the main checkout's compiled deps; only the app crate rebuilt).
The worktree's own `src-tauri/target/` was removed and stays absent — do
not mistake that for a missing build; the binary lives in the shared target.
