# Merge #8 — Quirk-2 GUI proof (Linux, merged tree) — PASS

Date: 2026-11-12 ~09:37–09:45 UTC (01:37–01:45 PST). Agent: GUI-PROOF (merge8).
Branch: `feat/prism-import-survival`, HEAD `cd327b8` "Merge Fix Quirk-2: show Project Updated alert in-app instead of native dialog".

## Binary verified before launch
- `/home/hatch/workspace/helix/src-tauri/target/release/helix`
- Size 103,682,080 B, sha256 `e2f1be44ecf81029eb19c84b2deba65870f842755826f2aaffec1fbedb2fe712`, mtime 2026-11-12 09:36:16 UTC — matches the brief exactly. No rebuild.
- Launched directly (release binary, bundled dist/). No vite dev server, no port 1420.

## Setup
- Xvfb :107 (`-listen tcp`, 1280x800x24) + openbox, `dbus-run-session`.
- Fixture: copy of `qa/fix-quirk2/older.hlx` (742,383 B, sha256 `48d5f8010c663c85a699b3861fe09e75623acca920e630ebaacc6d5a573bb8bf`) at `~/workspace/.helix-fix-merge-quirk2-tmp/older-copy.hlx`, opened via session restore (`~/.local/share/com.helix-desktop.helix/open-projects`).
- Repo fixture untouched (sha identical before/after); copy untouched (sha identical before/after — never saved over).
- `open-projects` restored afterwards to its prior content (`/home/hatch/workspace/.helix-fix-merge-f01-tmp/plan18.hlx`).
- No repo edits/commits. `git status` clean apart from pre-existing untracked `.node-xmlhttprequest-content-4518`.

## Assert 1 — "Project Updated" is an IN-APP dialog, not native — PASS
- Launch 1: dialog appears centered inside the single 1000x700 Helix window ("older-copy"), white rounded React card over dimmed app content, title "Project Updated", text "This project was made with an older Helix, or part of it couldn't be read as it was. Helix brought it up to date; save it to keep the update.", single OK button.
- Evidence it is in-app: (a) visually contained within the app window bounds, moves with it, app content dimmed behind it; (b) `xwininfo -root -tree` shows exactly ONE app window `0x40000f "older-copy"` 1000x700 — no second top-level dialog window (only the known 10x10 `0x400001 "helix"` Tauri helper and openbox frame children).
- Shot: `merge8-1-dialog.png`

## Assert 2 — OK dismisses cleanly, no orphan, app usable — PASS
- Clicked OK at (838,451). Dialog gone; full app visible, no dimming overlay.
- `xwininfo -root -tree` after dismiss: same single app window, no leftover dialog window.
- Usability: clicked sidebar "Violin plot" → main view switched to Violin plot (Box and Violin); clicked "Cell viability (%)" table → data table rendered with values (log[HLX-101] -9.0 … -4.0, MIA PaCa-2 98.2 … 6.8). App fully responsive — the pre-fix dead-dialog block is gone.
- Shots: `merge8-2-after-dismiss.png`, `merge8-3-click-bars-points.png` (actually landed on Violin plot — sidebar rows sit slightly higher than estimated), `merge8-4-click-table.png`

## Assert 3 — Repeat after relaunch — PASS
- Quit via window close: app exited immediately, NO save prompt appeared (nothing to "Don't Save" — the update was not marked dirty, or the app does not prompt). Fixture copy sha unchanged, confirming nothing was saved.
- Relaunch 2 with the same copy: "Project Updated" dialog appears again, identical in-app rendering; `xwininfo` again shows a single app window.
- Clicked OK again: dialog gone cleanly; full `xwininfo -root -tree` dump shows no leftover dialog window; clicked "Violin plot" → view switched, app responsive.
- Shots: `merge8-5-quit-prompt.png` (black screen — app already exited, no prompt), `merge8-6-relaunch-dialog.png`, `merge8-7-relaunch-after-dismiss.png`, `merge8-8-relaunch-usable.png`

## Assert 4 — 66x20 "Window" overlay symptom — NOT OBSERVED
- No tiny "Window" overlay in any of the 8 screenshots across both runs; `xwininfo -root -tree` grep for `66x20` / `"Window"` after the second dismiss: none found. No separate finding to file.

## Verdict: PASS on all asserts (Linux). Mac GUI proof still outstanding (separate agent).
