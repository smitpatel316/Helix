# Plan 34 GUI proof — worktree helix-plan34, base 9584051

- **Tree:** `~/workspace/helix-plan34`, branch `plan-34`, base `9584051`
  "Merge Plan 28: Binding-competition completion", plus the Plan 34 commit
  (see report). Nothing pushed.
- **Date:** 2026-11-11 ~13:48–13:57 UTC. Display Xvfb :98 (`dbus-run-session`,
  openbox, private XDG dirs under `~/.helix-plan34-tmp/`), driven by mouse
  via xdotool with `muse.visual_grounding` for exact coordinates.
  Launcher: `qa/plan34/launch.sh`.
- **Fixture:** `qa/plan34/plan34-gui.hlx` (copy of the Plan 25 retest fixture
  `qa/retest-plan25/plan25-retest.hlx`). Table "ANOVA groups"
  (Control/Low/High/Sparse; the 17.5 cell excluded, "abc" non-numeric —
  identical to the `column` reference fixture). All four wizard-created
  analyses + the graph were saved into the working copy (Ctrl+S after each
  run), so the fixture now carries the new nodes and any later launch
  recomputes them from the stored params.

## Build

- `~/.helix-plan34-tmp/build-linux.log`: `build-exit=0` ("Finished `release`
  profile [optimized] target(s) in 22m 57s", "Built application at:
  /srv/helix-plan34-cargo-target/release/helix").
- Binary `/srv/helix-plan34-cargo-target/release/helix`:
  **103,673,696 bytes (~103.7 MB)**, built Nov 11 13:48 UTC, md5
  `fb0c41ee3f0f4bf82b03b921c1f7b621`. Healthy size — no `cargo clean` /
  rebuild needed. (The binary lives under `/srv/...` instead of
  `src-tauri/target/release/` because the home-dir disk quota was exhausted;
  `CARGO_TARGET_DIR=/srv/helix-plan34-cargo-target` — see the builder's
  report for the quota story.)
- R engine ready: the first (Games-Howell) run rendered results within the
  45 s wait (webR cold start); later runs within 30–35 s. No analysis ever
  stuck on "Running…".

## Results — all PASS

Reference values are from `tests/reference.json` (GUI shows 4 significant
digits; values below are as rendered, with the frozen reference in
brackets). All comparisons per case checked.

| Case | Shot | Result |
|---|---|---|
| Games-Howell (Welch's ANOVA) | `p34-12-games-howell-result.png` | **PASS.** "Welch's ANOVA — Significant ****": F (Welch) **44.46** [44.45757269], DFn **3**, DFd **9.66** [9.659745383], P **<0.0001** **** [5.757840605e-06]. "Games-Howell multiple comparisons test": Control vs Low **0.9958** ns [0.9957862486]; Control vs High **0.1816** ns [0.1816107811]; Control vs Sparse **0.4358** ns [0.4357968804]; Low vs High **<0.0001** **** [3.843734807e-05]; Low vs Sparse **0.00879** ** [0.008789595204]; High vs Sparse **0.0001116** *** [0.0001115788581]. |
| Dunnett's T3 (Welch's ANOVA) | `p34-14-t3-result.png` | **PASS.** Same Welch table. "Dunnett's T3 multiple comparisons test": Control vs Low **0.9999** ns [0.9999440378]; Control vs High **0.233** ns [0.2330004846]; Control vs Sparse **0.5531** ns [0.5530673068]; Low vs High **<0.0001** **** [4.487244755e-05]; Low vs Sparse **0.01101** * [0.01101162976]; High vs Sparse **0.000137** *** [0.0001370051153]. |
| Dunnett (ordinary ANOVA, control = Control) | `p34-18-dunnett-result.png` | **PASS.** "One-way ANOVA — Significant *": F **4.858** [4.857880533], DFn **3**, DFd **21**, P **0.01014** * [0.01013594077], R² **0.4097** [0.4096752805]. "Dunnett's multiple comparisons test (vs. Control)" — exactly k−1 = 3 rows: Low vs Control **0.9891** ns [0.9891219737]; High vs Control **0.04589** * [0.04589486477]; Sparse vs Control **0.2913** ns [0.2913382669]. |
| Welch's ANOVA, no post-hoc | `p34-19-welch-only-result.png` | **PASS.** Same Welch table (F 44.46, DFn 3, DFd 9.66, P <0.0001 ****), no comparisons table, note "Compares means across groups without assuming equal SDs (Welch's ANOVA); assumes normal distributions." — the pinned Welch case itself. |

## Wizard surface

- `p34-10-wizard-q4-equalsd.png` (equal-SDs step): "Yes — ordinary one-way
  ANOVA" / "No — Welch's ANOVA".
- `p34-11-wizard-posthoc-welch.png` (Welch post-hoc step): offers ONLY
  "No — only the overall Welch's ANOVA", "Yes, every pair — Games-Howell
  test", "Yes, every pair — Dunnett's T3 test (fewer than 50 values per
  group)". No Tukey / Bonferroni / Dunnett — correct.
- `p34-15-wizard-posthoc-equalsd.png` (equal-SD post-hoc step): offers
  none / Tukey / Bonferroni / Šídák / Holm–Šídák / Fisher's LSD /
  "Yes, each group against a control — Dunnett's test". No Games-Howell,
  no T3 — correct.
- `p34-17-wizard-control-select.png` (control step): "Which group is the
  control?" — Control (default, first group) / Low / High / Sparse.

## Significance overlay (Dunnett k−1 rows)

- `p34-24-graph-dunnett-overlay.png`: an "Individual values" graph with the
  STATISTICS Analysis picker set to "One-way ANOVA 4" (the Dunnett run)
  lists exactly the k−1 comparisons — Low vs. Control (ns), High vs.
  Control (*), Sparse vs. Control (ns) — with a Stars / P value toggle.
- `p34-26-graph-overlay-high.png`: checking "High vs. Control" draws the
  bracket from Control to High with a single "*" above it (y-axis rescaled
  to 35 to fit). The overlay handles Dunnett's k−1 rows.
- (Driving note: two early clicks at (894,322)/(894,302) missed the small
  checkboxes; `muse.visual_grounding` put them at (902,326)/(902,307) and
  the precise click landed — see `p34-25-graph-overlay-drawn.png` for the
  missed attempt.)

## Saved params (from the fixture file after Ctrl+S)

- Welch's ANOVA: `{posthoc: games-howell, equalSd: false}`
- Welch's ANOVA 2: `{posthoc: t3, equalSd: false}`
- One-way ANOVA 4: `{posthoc: dunnett, equalSd: true, control: Control}`
- Welch's ANOVA 3: `{posthoc: none, equalSd: false}`
- Graph: Individual values (STATISTICS analysis "One-way ANOVA 4",
  High-vs-Control bracket on)
- All sets `['Control', 'Low', 'High', 'Sparse']`.

## Notes / caveats

- The app was killed by exact PID only (`kill 68444`, the binary at
  `/srv/helix-plan34-cargo-target/release/helix`); no sibling lane's app
  was touched (merge-p28 was live on :97 throughout).
- The new check() error (Games-Howell / T3 forced onto the ordinary ANOVA)
  is covered by the `checks.ts` regression test and the live probe, not by
  a GUI drive — forcing it through the GUI would need hand-editing a saved
  analysis file, which the wizard never produces.
