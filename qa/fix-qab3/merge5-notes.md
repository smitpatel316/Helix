# GUI proof — merge #5, QAB-3 (.pzfx date-X import drops the dates)

- Merge: `11cec2c` "Merge Fix QAB-3: keep date X values as row titles on .pzfx import"
  (branch `feat/prism-import-survival`, origin HEAD 11cec2c)
- Binary verified before launch: `/home/hatch/workspace/helix/src-tauri/target/release/helix`,
  103,681,504 B, sha256 `90e18fbf5d53ad43beda4dd53afe5a605f523546869fa774a9b7fa23d6762d1c`,
  mtime Nov 12 09:04 UTC — matches the brief exactly.
- Ground truth: `tests/checks.ts` ".pzfx import keeps date X values as row titles"
  (rows[0]=`["16-Jan-2004","0","120"]`, rows[1]=`["9-Apr-2009","5.22929500342231","64"]`,
  rows[2]=`["1-Mar-2012","8.12320328542094","46"]`, rows[49]=`["17-Oct-2018","14.7515400410678","87"]`,
  50 rows, columns `["Title","Date X","Observation"]`, plus an issue saying the dates
  were kept as row titles). Note: the brief's "third row 17-Oct-2018" was wrong;
  17-Oct-2018 is the LAST row (row 50); the test is ground truth and the GUI matches it.
- Method: Xvfb :104 (1280x800), openbox, dbus-run-session, release binary (bundled dist/,
  no dev server). Import via File ▸ Import Prism File… → native GTK chooser → Ctrl+L,
  typed path to a COPY in `~/workspace/.helix-fix-merge-qab3-tmp/` (repo fixture untouched).
  Window restores at 1000x700. Menu-bar hit areas sit ~30 px right of where the labels
  appear in screenshots — "File" is at x≈220, not 175 (first two clicks opened the
  Helix app menu instead). The app opened on the restored "plan18" sample project and
  showed a "Project Updated" migration dialog first; answered OK, and "Don't Save" on
  the discard prompt both times so no repo/sample file was modified.
- Prior lane artefacts (`qab3-01-launch.png` black screen, `x_date-imported.hlx` headless
  import) were read, not overwritten; all new shots are `merge5-*`.

## Results

### Assert 1 — PASS: dates appear as row titles in the imported "Sample Data" XY table
`merge5-12-table-top.png`: Title column shows 16-Jan-2004, 9-Apr-2009, 1-Mar-2012,
12-Apr-2012, 26-Apr-2012, … (rows 1–25 visible, all dated, none blank/null).
`merge5-14-table-scrolled.png`: rows 26–50, ending 17-Oct-2018. All 50 rows dated.

### Assert 2 — PASS: data columns match the fixture/test
- Row 1: `16-Jan-2004 | 0 | 120`
- Row 2: `9-Apr-2009 | 5.22929500342231 | 64`
- Row 3: `1-Mar-2012 | 8.12320328542094 | 46`
- Row 50: `17-Oct-2018 | 14.7515400410678 | 87`
All read off the GUI screenshots, matching `tests/checks.ts` exactly.

### Assert 3 — PASS: the "kept as row titles" note fires AND is now true
`merge5-11-imported-alert.png`: "Prism File Imported — Imported 1 table from "x_date":
• Sample Data. Notes: • "Sample Data": the X values are dates; the dates were kept
as row titles. Save the project to keep it as a Helix project." The dates are
visibly present in the table behind/after the dialog, so the warning is accurate —
no spurious claim.

### Assert 4 — PASS: regression — survival.pzfx still imports normally
`merge5-16-survival-imported.png`: "Three groups" Survival table, columns
Title | Days | Control | Treatment A | Treatment B | Group D…, rows CO/78/1,
NT/34/1, RO/123/0, LT/45/1; note correctly says "imported as a Survival table…".
`merge5-19-survival-bottom.png`: 27 data rows, last row 27 = OO / 351 / (blank) /
(blank) / 1 — matches the test's rows[26] `["OO","351",null,null,"1"]`.

## Verdict: PASS (4/4)

## Unexpected / notes for the next proof agent
- The "Prism File Imported" dialog is taller when its Notes text wraps (survival:
  640x270, OK at y≈515) than when it doesn't (x_date: 617x232, OK at y≈500) —
  click the OK row by its rendered position, not a fixed y.
- The x_date import's discard prompt appears because the restored plan18 sample was
  marked edited by the migration; "Don't Save" is the right answer in proof runs.
- App quit without saving (pkill -x helix); no repo files touched. Screenshots only
  under `~/workspace/helix/qa/fix-qab3/`.

## Screenshots (all in `~/workspace/helix/qa/fix-qab3/`)
- `merge5-01-launch.png` — launch, plan18 restored + "Project Updated" dialog
- `merge5-03/04/06-file-menu*.png` — menu-bar calibration (Helix menu opened by mistake)
- `merge5-07-file-menu.png` — File menu open
- `merge5-08-file-dialog.png` — native "Import Prism File" chooser
- `merge5-09-dialog-path.png` — path typed via Ctrl+L
- `merge5-10-after-import.png` — discard-changes prompt
- `merge5-11-imported-alert.png` — "Prism File Imported" dialog + table behind it
- `merge5-12-table-top.png` — Sample Data rows 1–25 (asserts 1+2)
- `merge5-13-table-bottom.png` — Ctrl+End does NOT scroll the grid (cell cursor only)
- `merge5-14-table-scrolled.png` — rows 26–50 incl. row 50 = 17-Oct-2018
- `merge5-15-survival-dialog.png` — discard prompt before survival import
- `merge5-16-survival-imported.png` — survival import alert + table
- `merge5-17/18-survival-*.png` — OK-click calibration (dialog taller, OK at y≈515)
- `merge5-19-survival-bottom.png` — survival rows 20–27, last row OO/351/…/1
