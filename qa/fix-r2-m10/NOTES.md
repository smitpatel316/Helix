# R2-M10 GUI proof (Linux) — PASS

Date: 2026-11-12 ~21:55–22:05 UTC (13:55–14:05 PST). Branch `fix/r2-m10`, HEAD `3d44d70` (verified on origin).
Binary: `/home/hatch/workspace/helix-fix-r2-m10/src-tauri/target/release/helix`,
103,682,144 B, sha256 `b7e61268f96fd92d46c4a87880cb7f00b3bbfcfe1496c24d7dab68d21bb7df9e`,
built 2026-11-12 21:54 UTC (`npm run build:linux`, 20m 55s).

## Verification (all green, no fix-up commit needed)
- `npm run check`: exit 0 (tsc clean).
- `npm test` (single run): exit 0 — **All 162 checks pass** (incl. the new
  `.pzfx import keeps date X values in their own column when row titles exist`),
  **All 364 results match** (reference), **All 144 package checks pass**.
  No OOM this time (predecessor was OOM-killed twice; run survived on the
  post-replacement box, ~8.5 min).
- `cargo check`: exit 0 in 16.09 s (warm target). No Rust files touched by the fix.

## Display
Xvfb **:99** (free at launch; :98 belonged to a sibling lane — left alone),
1280x800x24 + openbox, `dbus-run-session`. App session-restored the `plan18`
project first (argv ignored); fixture opened via File ▸ Import Prism File…
(Ctrl+O is the wrong route: it opens .hlx projects and reports a .pzfx as
"couldn't be found" — that error dialog is pre-existing behaviour, not this fix).

## Asserts
1. **Date column renders — PASS.** `m10-19-table-clean2.png`: table "Sample Data"
   (XY), columns `Title | Date X | Date X (date) | Observation`; all 5 rows exact:
   Sample A / 0 / 16-Jan-2004 / 120; Sample B / 5.22929500342231 / 9-Apr-2009 / 64;
   Sample C / 8.12320328542094 / 1-Mar-2012 / 46; Sample D / 8.23819301848049 /
   12-Apr-2012 / 51; Sample E / 8.27652292950034 / 26-Apr-2012 / 52.
2. **Warning is truthful — PASS.** `m10-17-imported-settled.png`: "Prism File
   Imported" dialog notes: `"Sample Data": the X values are dates; the existing
   row titles were kept and the dates were kept in a "Date X (date)" column.`
   No "dropped" / "kept as row titles" claim anywhere.
3. Fixture untouched (md5 `44be18018a25e409c957e66ab9450e51`, mtime Nov 12 17:10);
   project not saved; app quit via PID file, Xvfb :99 + openbox stopped.

## Environment notes
- Container was replaced again mid-verification (~21:21 PT, seventh event today);
  this session survived it. Worktree HEAD unchanged, origin `fix/r2-m10` still
  `3d44d70`; nothing new pushed.
- `~/workspace/AGENTS.md` was read per the runtime house-rules note; it holds only
  Yahoo-hook logs, nothing affecting this verification.
