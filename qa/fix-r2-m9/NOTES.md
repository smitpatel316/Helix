# R2-M9 GUI proof notes

Fix: `readRowGroups` keeps valid bands and drops only the broken one, and
`readNode` pushes a warning naming each dropped band (was: one malformed
band silently dropped the whole third factor, no warning).

## Environment

- Worktree `~/workspace/helix-fix-r2-m9`, branch `fix/r2-m9`, base `cd327b8`.
- Release build: `npm run build:linux`, binary
  `/home/hatch/workspace/helix/src-tauri/target/release/helix`
  (103,682,272 bytes, sha256
  `0bf3303e56348dbedc8f490df3892fcdb985ee5b4b5478877f69527d43c694c5`),
  run as a copy at `~/workspace/.tmp-r2-m9/helix-m9` (same sha).
- Xvfb :95 (1280x800), openbox, dbus-run-session. Driver: `gui.sh`.

## Fixture

`m9-broken-band.hlx` — grouped table "M9 row groups" (2 groups, 2
replicates) with rowGroups WT/2, KO/2, and a malformed band with an empty
name and count 2. Generated with the worktree's own `serializeProjectFile`.

## What the screenshots show

- `m9-09-new-window-settled2.png` — opening the fixture pops
  "Opened with 1 Issue": `Table "M9 row groups" left out a row group it
  couldn't read: a band with no name.` Behind the dialog the GROUPS panel
  already shows the kept bands WT (2 rows) and KO (2 rows) under
  "Row groups (third factor)".
- `m9-11-table-kept-bands.png` — after dismissing the dialog, the table
  keeps WT and KO as the third factor; the nameless band is gone.

## Suite

`npm test` green on-branch: checks 162/162, reference 364/364, packages
144/144 (total 670; baseline on cd327b8 was 669, +1 = the new regression
check "a malformed row-group band no longer blocks the three-way ANOVA").

Note: the app restored a leftover "plan18" project on launch (shared
profile state from other lanes) — dismissed its "Project Updated" dialog
before opening the fixture; unrelated to this fix.
