# Plan 34 MERGED-tree GUI proof — HEAD c4c183a "Merge Plan 34"

- **Tree:** `~/workspace/helix`, HEAD `c4c183a8a292ae1297cd2f813eca2eaac8f6e379`
  "Merge Plan 34: Welch ANOVA + Dunnett + Games-Howell + T3".
- **Binary:** `/home/hatch/workspace/helix/src-tauri/target/release/helix`,
  **103,674,272 bytes** — size verified before launch (matches the brief).
- **Date:** 2026-11-11 ~16:33–16:42 PST. Display Xvfb :97 (own Xvfb +
  openbox, `dbus-run-session`, private XDG dirs under
  `~/workspace/.helix-plan34-merged-tmp/`), driven by mouse via xdotool
  with `muse.visual_grounding` for exact coordinates.
  Launcher: `qa/plan34-merged/launch.sh`.
- **Fixture:** `qa/plan34-merged/plan34-merged-gui.hlx` — byte-identical
  copy of the branch proof's `qa/plan34/plan34-gui.hlx` (md5
  `0b2a27da9331cf3ff7d02abb1c258e95`, verified unchanged after the run).
  Table "ANOVA groups" (Control/Low/High/Sparse). The app was never
  saved over the fixture; two wizard-created analyses (Welch's ANOVA 4,
  One-way ANOVA 5) existed in memory only at shutdown.
- **Reference:** branch proof `qa/plan34/PLAN34-GUI-PROOF.md`
  (shots p34-12 / p34-14 / p34-18 / p34-19 / p34-11 / p34-15).

## Results — all 7 checks PASS

| # | Check | Shot | Result |
|---|---|---|---|
| 1 | Launch, no crash/hang; open fixture | `01-launch.png`, `02-open-dialog.png`, `03-opened.png` | **PASS.** Clean launch to empty "Untitled" Table 1. Fixture opened via Ctrl+O → GTK chooser → typed path; title `plan34-merged-gui`, all saved analyses listed. |
| 2 | Welch's ANOVA, no post-hoc | `05-welch-only.png` (saved "Welch's ANOVA 3") | **PASS.** "Welch's ANOVA — Significant ****": F (Welch) **44.46**, DFn **3**, DFd **9.66**, P **<0.0001** ****. No comparisons table. Note "Compares means across groups without assuming equal SDs (Welch's ANOVA); assumes normal distributions." |
| 3 | Games-Howell (Welch, every pair) | `06-games-howell.png` (saved "Welch's ANOVA") | **PASS.** Same Welch table. "Games-Howell multiple comparisons test": Control vs Low **0.9958** ns; Control vs High **0.1816** ns; Control vs Sparse **0.4358** ns; Low vs High **<0.0001** ****; Low vs Sparse **0.00879** **; High vs Sparse **0.0001116** *** — identical to branch p34-12. |
| 4 | Dunnett's T3 (Welch, every pair) | `07-t3.png` (saved "Welch's ANOVA 2") | **PASS.** Same Welch table. "Dunnett's T3 multiple comparisons test": Control vs Low **0.9999** ns; Control vs High **0.233** ns; Control vs Sparse **0.5531** ns; Low vs High **<0.0001** ****; Low vs Sparse **0.01101** *; High vs Sparse **0.000137** *** — identical to branch p34-14. |
| 5 | Dunnett (ordinary ANOVA, control = Control) | `08-dunnett.png` (saved "One-way ANOVA 4") | **PASS.** "One-way ANOVA — Significant *": F **4.858**, DFn **3**, DFd **21**, P **0.01014** *, R² **0.4097**. "Dunnett's multiple comparisons test (vs. Control)" — exactly k−1 = 3 rows: Low vs Control **0.9891** ns; High vs Control **0.04589** *; Sparse vs Control **0.2913** ns — identical to branch p34-18. |
| 6 | Wizard gating | `13-wizard-q4-equalsd.png`, `14-wizard-posthoc-welch.png`, `16-wizard-posthoc-equalsd.png` | **PASS.** Equal-SDs step offers "Yes — ordinary one-way ANOVA" / "No — Welch's ANOVA". Welch post-hoc offers ONLY No / Games-Howell / Dunnett's T3 — no Tukey/Bonferroni/Dunnett. Equal-SD post-hoc offers No / Tukey / Bonferroni / Šídák / Holm–Šídák / Fisher's LSD / Dunnett's test — no Games-Howell, no T3. |
| 7 | GH/T3 forced under equal SDs must ERROR | `19-edge-gh-error.png`, `20-edge-t3-error.png` | **PASS — proven via UI, not just the regression test.** Edge file `plan34-merged-edge.hlx` (scratch copy with `equalSd: true` forced onto the saved Games-Howell and T3 nodes) renders, instead of results: "Games-Howell assumes unequal SDs (Welch's ANOVA). Create this analysis again to choose another." and "Dunnett's T3 assumes unequal SDs (Welch's ANOVA). Create this analysis again to choose another." No silent run. (The wizard never produces this combination, so the saved-file path is the only UI route.) |

## Bonus: fresh wizard runs reproduce the saved values

- `15-wizard-gh-result.png` — new "Welch's ANOVA 4" (wizard, Welch +
  Games-Howell): F 44.46, DFn 3, DFd 9.66, P <0.0001 ****; GH table
  identical to check 3.
- `17-wizard-control-select.png` — Dunnett control step: "Which group is
  the control?" — Control (default) / Low / High / Sparse.
- `18-wizard-dunnett-result.png` — new "One-way ANOVA 5" (wizard, equal
  SDs + Dunnett, control = Control): F 4.858, DFn 3, DFd 21, P 0.01014 *,
  R² 0.4097; 3 rows identical to check 5.
- `04-after-open.png` — the saved "Individual values" graph already shows
  the Dunnett overlay on open (STATISTICS picker "One-way ANOVA 4",
  High vs. Control bracket with "*", Low ns / High * / Sparse ns),
  matching branch p34-24/26.

## Notes / deviations

- **Display :97, not :98:** :98 already had an Xvfb + openbox running
  (started 16:13, no Helix window — possibly another lane's), so this
  proof used its own fresh Xvfb on :97 to avoid interference. No
  sibling lane's process was touched; the merged binary was killed by
  exact PID (69931) at the end.
- **"Project Updated" dialog on open** (both the fixture and the edge
  file): "This project was made with an older Helix, or part of it
  couldn't be read as it was. Helix has brought it up to date; save it
  to keep the update." Dismissed with OK, nothing saved. The branch
  fixture was written by the branch build, so a format-version bump
  between the branch base and the merged tree is the likely cause;
  loading + recomputation are unaffected (all values identical).
  Pre-existing environment quirk class, not a Plan 34 failure.
- **One missed click:** the first click on "One-way ANOVA 4" did not
  change the selection (view stayed on T3); the retry at a slightly
  different x landed and the Dunnett result rendered. UI timing quirk,
  not a failure.
- **Second window on edge-file open:** opening `plan34-merged-edge.hlx`
  while the first project was open created a second window instead of
  replacing the first, with no unsaved-changes prompt (the first window
  held two unsaved wizard analyses). Not Plan 34-related; the new
  analyses were discarded at shutdown with the process kill.
- R engine: first saved-analysis render completed within the 45 s wait
  (webR cold start); later runs within ~35 s. No analysis stuck on
  "Running…".
- Repo untouched: no code edits, no commits, no npm/cargo runs. Only
  `qa/plan34-merged/` (screenshots, logs, launcher, scratch fixtures)
  and `~/.helix-plan34-merged-tmp/` (private XDG dirs) were written.
