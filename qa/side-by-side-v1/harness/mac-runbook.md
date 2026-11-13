# Mac runbook — side-by-side QA, launch tip (PREP lane)

Device-route steps for the Mac half of the launch QA. Do NOT run this
until the launch tip is installed on the Mac. Do NOT use this lane to
drive the Mac while the fix-proof agent is working there — coordinate
through the parent; the Mac is shared with the fix-proof take 2 lane
right now.

## 0. Preconditions (all must hold before step 1)

- [ ] Launch tip known: `git ls-remote origin feat/prism-import-survival`
      recorded in `RESULTS.md`; suite green on that tip (PLAN.md §7).
- [ ] Smit has unlocked the Mac and the paired-device gateway lists it
      ONLINE (last_seen within minutes). If the gateway is stale, the only
      known fix is Smit relaunching the Muse app on the Mac — do not loop
      retries for more than ~10 min.
- [ ] `caffeinate -i -s` AND `caffeinate -d` running on the Mac via SSH
      (`-i -s` alone does not prevent display sleep, the likely lock
      trigger). Record PIDs; stop both at the end.
- [ ] Mac repo `~/helix` reset to the launch tip (`git fetch origin` +
      `git reset --hard origin/feat/prism-import-survival` — NEVER plain
      `git pull`; a divergent Mac-local commit once made pull fail silently
      and the script built stale code).
- [ ] `npm test` green on the Mac (expect ≥669; the count grows with
      Round 2 + format merge — record the actual count). First run needs
      `scripts/build-webr-repo.sh` (45 packages, 57 MB); the DMG script
      runs it itself. Harmless warning even on passing runs: "Requested
      package MethComp not found in webR binary repo".
- [ ] DMGs built with `scripts/build-mac-dmg.sh` (both archs), installed
      with the safe swap (copy to temp name → verify codesign →
      stash old app aside → swap → verify codesign again → delete stash
      ONLY after the build is GUI-proven). Record both sha256s.
      **Never** `mv Helix.app.new Helix.app` while the old app exists —
      it moves `.new` INSIDE the old app and breaks codesign.
- [ ] Fixtures present in `~/retest/retest-2026-11-10/` (11 .hlx) and
      `~/retest/retest-2026-11-11/` (16+ .hlx). If any fixture is missing,
      copy it from `~/workspace/helix/qa/` (the Mac copies are scratch —
      never save over them; dismiss the "Project Updated" sheet with OK,
      never save).

## 1. Launch + smoke (do first, every run)

1. Launch Helix via the device route (`computer.control open_app`).
   `open -a Helix` from SSH silently fails without an Aqua session —
   never use it as the launch path.
2. Confirm the build: About dialog shows the launch version; the Analysis
   menu lists the new analyses (incl. the Round 2 fix surface where
   visible).
3. Screenshot the launch; record PID.
4. Open `~/retest/retest-2026-11-11/sample-scratch.hlx` via SSH
   (`open <file>` works while Helix is running) and confirm the survival
   log-rank χ²=18.21 and the 4PL EC50 1.485e-7 render (deduped re-verify
   values, CHECKS.md §1). This is the smoke check that the installed
   build is the launch tip, not a stale install.

## 2. Per-plan checks (CHECKS.md §1, in plan order 01–36 + multi-panel)

For each plan fixture in `~/retest/retest-2026-11-10/` then
`~/retest/retest-2026-11-11/`:
1. `open` the .hlx over SSH; `computer.control activate` + `list_windows`
   to select it. Dismiss the "Project Updated" sheet with OK (never save).
2. Screenshot the results view; read the values off the screenshot and
   compare to CHECKS.md (exact to displayed precision vs reference.json).
3. Record PASS/FAIL + exact values in `RESULTS.md` immediately — never
   batch-record from memory at the end.
4. Plans 19/20/28/29 have tables-only fixtures: drive their wizards fresh
   through the Analysis menu (as Nov 11 did). Plan 26 cases 3a/3b/4 and
   Plan 29's segmental overlay kink were skipped before — **drive them
   this run**.
5. Window management: windows open cascaded and can extend past the
   screen bottom — move with AppleScript `set position … to {100, 30}`
   (`computer.control` drag on the title bar does NOT move the window).
   `screen.snap` invalidates the current observation — re-observe before
   the next click. Transient 66×20 "Window" overlays spawn on activation
   and cover the close button; workaround for a stale window is opening a
   renamed copy of the file.

## 3. QAB-1 two-graph MATCH test (launch-gate item — do it early)

In `plan33-proof.hlx`: open the heatmap inspector, click MATCH
"Choose…"; then select the volcano graph, open its inspector, click its
MATCH "Choose…". **Windows must survive.** If all windows vanish (the
Nov 9 signature: process alive idle, no prompt, no crash report), the
gate FAILS — record it with a `sample` of the stuck process and stop the
Mac run. Note: in the background, MATCH clicks may only focus the button;
foreground the app via AppleScript `tell application "Helix" to activate`
first, then click.

## 4. Import GUI lane (CHECKS.md §4 — the open gap)

- File > Import Prism File… on each of the 6 `tests/testdata/` fixtures.
  **Picker navigation via the device route is flaky** (Nov 11: Cmd+Shift+G
  + typing produced no Go-to-Folder sheet; search typing produced no
  results; row clicks dispatched without effect; Cancel worked). Work
  around it by staging the fixtures in a short path first
  (e.g. `~/retest/import/`) and navigating with single clicks on the
  sidebar favorites if available. If the picker genuinely cannot be
  driven, record the check as BLOCKED (open gap), not as PASS — and say
  so plainly in RESULTS.md. Do not fake it.
- Drag-and-drop: drag a .pzfx from Finder onto the Helix window.
- Error paths: HugeTable, empty, corrupt (`qa/bad-test.pzfx`), .prism
  rejection wording.
- Cancel paths: picker Cancel, no file picked.

## 5. Exports + graphs (CHECKS.md §4)

- JPG 150 DPI, PNG 600 DPI (new), PNG 300 DPI + SVG (regression).
  Verify dimensions + all content present in the exported file.
- Graph types not yet Mac-driven: Box/Violin, Individual Values, Pie,
  Donut, XY scatter/bar/area, mean/error — render + values.
- Multi-panel: attempt the Export click on Mac (never clicked before).
- Native `<select>` menus: verify by hand (human click), not by driver.

## 6. Prism-format in the Mac GUI (CHECKS.md §2)

- File > Import Prism File… on the demo `.prism` (stage it in
  `~/retest/import/` first — same picker caveat as §4). Expect 14 tables,
  3 analyses; 4PL (Control) Bottom 39.26, Top 121.8, EC50 17.18,
  HillSlope 1.062; survival log-rank χ² 2.01, p 0.1563, MH HR 0.3801.
- Open-format save nudge: prompt once, remember choice.

## 7. Rebrand spot-checks (CHECKS.md §5 — only after the pick lands)

- About dialog + window title + DMG name show the new name/logo.
- Bundle ID `net.smitpatel.helix` (check `Info.plist` via SSH).
- No "Helix" in any visible UI string.

## 8. Wrap-up

1. Delete the old-app stash ONLY after the launch build is GUI-proven.
2. Stop both caffeinate PIDs; hand the Mac back.
3. Screenshots go to `~/workspace/helix/qa/side-by-side-v1/runs/<run-name>/mac/`
   (copy them off the Mac via the device route at the end of the run —
   do not leave evidence only on the Mac).
4. RESULTS.md is the record: per-check PASS/FAIL + exact values +
   screenshot names. No check is "passed" without a screenshot or a
   recorded value.

## Known Mac gotchas (from Nov 9–11 — do not rediscover them)

- Screen re-locks minutes after unlock; gateway goes stale while the Mac
  is awake/unlocked (SSH still works) — only Smit relaunching the Muse
  app fixes the gateway.
- `screencapture` over SSH is blocked — screen evidence comes via the
  device route only.
- AppleScript `tell application "Helix" to quit` may refuse (-128);
  quitting may produce NO save prompt even when the file was "updated" in
  memory (fixture unmodified, nothing lost).
- GUI launches must go through the device route.
- The Mac sleeps on idle even lid-open + charger — caffeinate `-i -s`
  + `-d` both, always.
