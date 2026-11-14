# Plan 25 GUI proof — merged tree (retest)

- **Tree:** `~/workspace/helix` at `1f9b2a1` "Merge Plan 25: Multiple-comparisons
  completion" (on top of `87bd870` Plan 24). Nothing committed or pushed.
- **Date:** 2026-11-11 ~10:01–10:20 UTC. Verifier: Helix Plan 25 GUI-proof
  verifier (merged tree).
- **Fixture:** working copy `qa/retest-plan25/plan25-retest.hlx` (copy of the
  builder's `qa/plan25/plan25-gui.hlx`, untouched original). Tables: t1
  "ANOVA groups" (Control/Low/High/Sparse, 17.5 cell excluded, "abc"
  non-numeric — identical to the `column` reference fixture) and t2
  "Two-way groups" (A/B/C × Y1–Y3, Day 1–5). All six wizard-created analyses
  were saved into the working copy (Ctrl+S after each run), so the fixture
  now carries the new nodes and any later launch recomputes them from the
  stored params.
- **Method:** each analysis created live through the wizard under Xvfb :98
  (`dbus-run-session`, openbox, private XDG dirs under
  `~/.helix-merge-p25-tmp/`), driven by mouse via xdotool with
  `muse.visual_grounding` for exact button coordinates. No code was changed,
  so the full suite was not re-run (already green on this tree per the brief
  and the coordinator's log: 132 checks + 326 reference + 144 package = 602,
  exit 0).

## Build

- `~/workspace/.helix-merge-p25-tmp/build-linux.log`: `BUILD-EXIT:0`
  ("Finished `release` profile [optimized] target(s) in 3m 44s", "Built
  application at: .../src-tauri/target/release/helix"). No link failure, no
  rebuild needed.
- Binary `src-tauri/target/release/helix`: **103,665,696 bytes (~103.7 MB)**,
  built Nov 11 10:05 UTC, md5 `0faa36e274e7804e7b661801e275e4c4`. Healthy size
  — no `cargo clean` / rebuild needed.
- R engine ready: the first (Šídák) run rendered results within the 40 s
  wait (webR cold start); later runs within 30 s. No analysis ever stuck on
  "Running…".

## Results — all PASS

Reference values are from `tests/reference.json` (GUI shows 4 significant
digits; values below are as rendered, with the frozen reference in
brackets). All six comparisons per case checked.

| Case | Shot | Result |
|---|---|---|
| Šídák (one-way ANOVA, t1) | `r25-14-sidak-result.png` | **PASS.** F 4.858, DFn 3, DFd 21, P 0.01014*, R² 0.4097. "Šídák-corrected multiple comparisons": Control vs Low **0.9999** [0.9999327713]; Control vs High **0.09818** [0.09818070727]; Control vs Sparse **0.5453** [0.545337089]; Low vs High **0.1854** [0.1853870846]; Low vs Sparse **0.4284** [0.4284437924]; High vs Sparse **0.008109** ** [0.008109345609]. |
| Holm–Šídák (one-way ANOVA, t1) | `r25-17-holmsidak-result.png` | **PASS.** Same ANOVA table. "Holm–Šídák multiple comparisons test": **0.7984** [0.79835268]; **0.08251** [0.08251367125]; **0.244** [0.2439866353]; **0.1278** [0.1277636248]; **0.244** [0.2439866353]; **0.008109** ** [0.008109345609]. |
| Fisher LSD (one-way ANOVA, t1) | `r25-19-lsd-result.png` (+ notes `r25-20-lsd-notes.png`) | **PASS.** Same ANOVA table. "Fisher's LSD test (uncorrected)": **0.7984** [0.79835268]; **0.01708** * [0.01707604303]; **0.1231** [0.1231036655]; **0.0336** * [0.03359637891]; **0.08902** [0.08901794033]; **0.001356** ** [0.001356147134]. Notes carry the required warning verbatim: "Fisher's LSD is uncorrected — only interpretable when the overall ANOVA was significant." |
| Dunn–Šídák (Kruskal–Wallis, t1) | `r25-23-kw-dunnsidak-result.png` | **PASS.** H 16.87, df 3, P 0.0007527 ***. "Dunn's multiple comparisons test (Šídák-corrected)": **0.6442** [0.6441920846]; **0.01675** * [0.01675184883]; **0.6827** [0.6827268794]; **0.511** [0.5110407264]; **0.07364** [0.07364383804]; **0.0009076** *** [0.0009075856075]. |
| Šídák, groups (two-way ANOVA, t2) | `r25-29-twoway-sidak-result.png` → `r25-30-twoway-sidak-scrolled.png` | **PASS.** Group F 337.4 (DFn 2, P <0.0001); Row F 120.8 (DFn 4, P <0.0001); Interaction F 17.64 (DFn 8, P <0.0001); DFd (residual) 29. "Šídák-corrected multiple comparisons (groups within each row, each row a family)", all 15 comparisons match: Day 1 A/B **0.007726** [0.007726075285], A/C **0.6278** [0.6278467959], B/C **0.0004047** [0.000404743865]; Day 2 A/B, B/C <0.0001 [1.918099473e-05, 4.388189743e-07], A/C **0.1665** [0.1664722343]; Day 3 A/C **0.007726** [0.007726075285], the rest <0.0001 as the reference's 1e-08…1e-15 values require. |
| Holm–Šídák, rows (two-way ANOVA, t2) — bonus | `r25-32-twoway-holmrows-result.png` → `r25-33-twoway-holmrows-scrolled.png` | **PASS.** Same ANOVA table. "Holm–Šídák multiple comparisons (rows within each group, each group a family)", 30 comparisons; spot-checked A-family head (Day 1 vs Day 2 **0.07079** [0.07079138432]; Day 1 vs Day 3 **0.0006745** [0.0006744820944]; Day 2 vs Day 3 **0.07079**) and the full C-family tail (Day 1 vs Day 2 **0.7323** [0.7323119299]; Day 1 vs Day 4 **0.023** * [0.02299961032]; Day 1 vs Day 5 **0.003676** ** [0.003675780415]; Day 2 vs Day 5 **0.1051** [0.1051127044]; Day 3 vs Day 5 **0.3309** [0.330935524]) plus B-family Day 4 vs Day 5 **0.0001468** [0.0001468395012] — all match. |

## Wizard surface

- `r25-12-wizard-posthoc.png` (one-way posthoc step): the parametric list
  offers **"Yes, every pair — Šídák-corrected comparisons"**,
  **"Yes, every pair — Holm–Šídák comparisons"**, and
  **"Yes, every pair — Fisher's LSD test (uncorrected — only if the ANOVA is
  significant)"**, plus Tukey / Bonferroni / none as before.
- `r25-22-wizard4-posthoc.png` (non-parametric posthoc step): offers
  **"Yes — Dunn's multiple comparisons test (Šídák-corrected)"** and
  **"Yes — Dunn's multiple comparisons test (Holm–Šídák-corrected)"**,
  plus Dunn (Bonferroni) / none as before.
- `r25-28-twoway-posthoc.png` (two-way posthoc step): offers Šídák /
  Holm–Šídák / Fisher's LSD each in "groups within each row" and "rows
  within each group" variants. No Dunnett in two-way (correct — two-way
  refuses it by design).
- **Dunnett:** "Yes, each group against a control — Dunnett's test" IS
  offered in the one-way posthoc list (`r25-12-wizard-posthoc.png`). Per the
  brief this is upstream v1.0.7, already present — **not** a Plan 25
  deliverable and not flagged as an issue either way. Not exercised here.
- Saved params confirm the wizard finish contract: `anova` sidak /
  holm-sidak / lsd (`equalSd: true`, all four sets); `kruskal-wallis`
  dunn-sidak; `two-way-anova` sidak/groups and holm-sidak/rows
  (`design: ordinary`, sets A/B/C).

## Notes / caveats

- **App killed once by my own cleanup, not a crash:** after the first
  launch the exec wrapper reported an output-drain timeout (dbus/portal
  children hold the exec pipe) and my `process.kill` on that stale session
  took the app down with it. Relaunched with a fully detached launcher
  (`qa/retest-plan25/launch.sh`: `setsid nohup bash -c 'dbus-run-session …
  > log 2>&1'`, all fds off the exec pipe); the second launch stayed alive
  through all six runs (~11 min). No app crash or freeze in the whole
  retest; the "Project Updated" dialog appeared on launch and was dismissed
  once (click 640,456). The launcher kills only processes whose cwd is this
  checkout, so sibling lanes (plan26 :97, plan28 :99) were never touched.
- **Wizard driving gotcha (tooling, not the app):** screenshot pixel
  estimates read left of the true button positions (same as the plan24
  lane's ~95 px note — here the Next button grounded ~43 px right of its
  apparent spot, and its y moves with the dialog height per step). One
  early Next click landed in the Cancel/Next gap and dismissed the wizard;
  one wrong menu pick opened Mixed-Effects instead of Compare More Than Two
  Groups (cancelled immediately, no stray analysis). Fixed by grounding
  every button with `muse.visual_grounding` before clicking. The six
  analyses actually created are exactly the six intended (verified in the
  saved `.hlx`).
- Builder's saved analyses (a1–a6) also recompute correctly on the merged
  tree: on launch the active node a1 showed Šídák
  [0.9999, 0.09818, 0.5453, 0.1854, 0.4284, 0.008109]
  (`r25-01-launch.png`), byte-identical to the fresh re-drive.
- No full `npm test` re-run (no code changed). App killed after the run;
  `~/.local/share/com.helix-desktop.helix/open-projects` untouched (still
  `qa/plan21-gui.hlx`) — this run used private XDG dirs. Working tree
  untouched (`1f9b2a1`, `git status` shows only the two pre-existing
  untracked `test-corpus-*` dirs; `qa/retest-plan25/` is git-ignored).

## Screenshots

All under `~/workspace/helix/qa/retest-plan25/`:

- `r25-01-launch.png` — launch, builder's a1 Šídák recomputed on merged tree
- `r25-02-t1-table.png` — t1 reference table (17.5* excluded, "abc")
- `r25-03b-analysis-menu.png` — Analysis menu ("Compare More Than Two Groups")
- `r25-05-wizard-sets.png` — wizard data-sets step (all four pre-checked)
- `r25-08-wizard-paired.png` — paired step (Unpaired pre-selected)
- `r25-10-wizard-gaussian.png` — Gaussian step (one-way ANOVA pre-selected)
- `r25-11-wizard-equalsd.png` — equal-SD step (ordinary ANOVA pre-selected)
- `r25-12-wizard-posthoc.png` — parametric posthoc list (3 new + Dunnett)
- `r25-13-sidak-picked.png` — Šídák selected
- `r25-14-sidak-result.png` — Šídák result (all 6 P match)
- `r25-17-holmsidak-result.png` — Holm–Šídák result (all 6 P match)
- `r25-19-lsd-result.png` — Fisher LSD result (all 6 P match)
- `r25-20-lsd-notes.png` — LSD notes with uncorrected warning + descriptives
- `r25-22-wizard4-posthoc.png` — non-parametric posthoc list (2 new Dunn)
- `r25-23-kw-dunnsidak-result.png` — KW Dunn–Šídák result (all 6 P match)
- `r25-25-twoway-menu.png` — Analysis menu on grouped table
- `r25-26-twoway-wizard1.png` — two-way sets step (A/B/C checked) + table
- `r25-27-twoway-design.png` — two-way design step (Ordinary)
- `r25-28-twoway-posthoc.png` — two-way posthoc list (6 new variants)
- `r25-29-twoway-sidak-result.png` — two-way Šídák groups, head (Day 1–2)
- `r25-30-twoway-sidak-scrolled.png` — two-way Šídák groups, tail (Day 2–5)
- `r25-32-twoway-holmrows-result.png` — two-way Holm–Šídák rows, head
- `r25-33-twoway-holmrows-scrolled.png` — two-way Holm–Šídák rows, C-family
- `plan25-retest.hlx` — working fixture with the 6 new analyses saved
- `launch.sh`, `helix-retest.log` — launcher + app log
