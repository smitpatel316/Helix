# M19 GUI proof — ROUT Q range enforcement (fix/r2-m19 @ c4eadec)

Verifier take 1, 2026-11-13 (UTC). Branch `fix/r2-m19`, commit `c4eadec`
(+54/−1, 4 files, TypeScript only). Worktree `~/workspace/helix-fix-r2-m19`,
base `6c7d350`.

## Binary under test

- Built with `npm run build:linux` (`tauri build --no-bundle`), finished
  07:29:20 UTC, rc=0.
- `src-tauri/target/release/helix` — **103,685,608 B**,
  sha256 `941552ffd2ac1bd77fa2c9df0779cde6f8f6504148f5783e8170f849edf27829`.
- Profile: **release**. Frontend EMBEDDED (strings: index-js=1, plotly=1).
- ⚠️ Bare `cargo build --release` does NOT embed the frontend in this repo:
  that binary was 5,766,976 B, launched to a black webview (3 launches), and
  was discarded. Lanes must build with `npm run build:linux` (as M12 did).

## Independent verification legs (all PASS, logged to `~/.tmp-r2-m19/verify.log`)

| Leg | Result |
| --- | --- |
| LEG1 tsc (`npm run check`) | CLEAN, exit 0 |
| LEG2a checks | PASS 172/172 |
| LEG2b reference | PASS 366/366 |
| LEG2c packages | PASS 154/154 |
| LEG3 cargo check (dev) | PASS — adopted coordinator-side re-run in `helix-fix-r2-m19-verify` @ c4eadec, Finished dev profile in 4m 51s, exit 0, 07:07:14 UTC (own run died 06:33 in a daemon restart; no second run launched) |
| LEG4 build | `npm run build:linux` rc=0 (see Binary above) |
| LEG5 GUI | PASS — all 3 cases below |

Total: **692 tests green** (172 + 366 + 154).

## GUI proof (Xvfb :98, Linux, seeded fixture `m19-gui.hlx`)

Fixture table "M19 ROUT Q": A = 1.2, 1.5, 1.1, 1.4, **9.8**; B = 2.1, 2.4,
2.0, 2.2, 2.3. Path: Analysis → Identify Outliers → datasets (A, B) → method
ROUT → Q question.

| Case | Result | Evidence |
| --- | --- | --- |
| Q = 0 | **BLOCKED** — description replaced by `Q must be between 0.01 and 50.`, Run greyed/disabled; Return does nothing (dialog stays) | `m19-35-q0-retry.png`, `m19-36-q0-return.png` |
| Q = 100 | **BLOCKED** — same error, Run disabled | `m19-38-q100-retry.png` |
| Q = 1 | **RUNS** — `ROUT method (Q = 1%)`: 10 obs, 2 groups, **1 outlier** (10%); A 1/5 (20%, robust mean 1.4), B 0/5 (robust mean 2.2); footer: `A row 5 (value 9.8, adj. P = 0.0000)` | `m19-40-q1-retry.png`, `m19-42-after-run2.png` |

No regression: the analysis runs end-to-end and flags exactly the planted
outlier (9.8) and nothing else.

## Harness quirks (not product bugs)

- **Mouse clicks on the wizard's primary button (Next/Run) do not register
  under this Xvfb/xdotool setup** — the dialog closes with no analysis
  created. Keyboard **Return** advances/runs correctly (the Dialog's
  `onReturn`). The same applies to the in-app "Project Updated" dialog's OK
  button (3 mouse clicks failed; Return dismissed it). Drive wizards with
  the keyboard: Return to advance/run.
- After a mouse click into the Q number field, `ctrl+a` + typed text may not
  land; **Tab / Shift+Tab to (re)focus the field, then type** — the typed
  value then replaces the selected content. (Shots 32–34, 37, 39 show the
  misses; 35, 38, 40 show the working pattern.)
- "Helix 1.0.9 is available" update dialog appears on launch; dismissed
  with Later. Pre-existing behavior, same as M12's proof.
- The wizard's dataset question defaults to all sets checked on reopen
  (A and B checked in shots 22/24); the first open showed them unchecked.

## Verdict

**READY-TO-MERGE.** Fix verified end-to-end: tsc clean, 692/692 tests green,
cargo check green, GUI blocks Q=0 and Q=100 with the exact error string and
runs Q=1 flagging only the planted outlier.
