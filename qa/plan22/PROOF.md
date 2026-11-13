# Plan 22 GUI proof (Linux, 2026-11-11)

Build: `npm run build:linux` from `~/workspace/helix-plan22` (plan-22 branch),
binary `src-tauri/target/release/helix`. Proof project `plan22-gui.hlx`
(two-group Column table A=1..8, B=2..9; pre-created Monte Carlo analysis
compare-two-groups / P value / 200 repeats / seed 42; Monte Carlo histogram
linked to it). Screenshots p22-*.png in this dir.

## What was shown live in the app

- **Monte Carlo result (pre-created node, computed live in-app):**
  Repeats 200, Mean of P value 0.4158, SD 0.2973, 2.5th pct 0.007662,
  97.5th pct 0.9517, Power (% P < 0.05) 11.5, Observed (real data) 0.4279,
  Seed 42. (p22-11-mc-result.png) — power is right for the true effect
  d = 0.408, n = 8/group (analytic ≈ 11%).
- **Monte Carlo histogram** (p22-12-histogram.png): bins from the analysis,
  x-axis "P value", y-axis "Count", dashed observed line "Observed 0.4279",
  P < 0.05 shading on the first bin. Format panel links the analysis.
  Cosmetic nits: bin labels are rotated and crowd the left edge; the first
  bar (count 40) touches the top of the plot area.
- **Simulate data dialog** (p22-15-dialog.png, via table right-click →
  "Simulate data…"): all six distributions, Gaussian mean 0 / SD 1,
  n = 20, 1 dataset, seed 42, Column table; summary line correct.
  After Simulate, new table **"Simulated data 1"** (p22-16-simulated.png)
  holds R's seed-42 N(0,1) stream to 10 significant digits:
  1.370958447, -0.5646981714, 0.3631284113, 0.632862605, …
- **Monte Carlo wizard, driven end-to-end** (p22-17…p22-20): New Analysis
  (Ctrl+Alt+A) → "Monte Carlo Simulation" → target compare-two-groups →
  statistic → equal variance → per-group mean/SD pre-filled from observed
  (4.5 ± 2.44949, 5.5 ± 2.44949) → repeats 1000 → seed 42 → Run. New node
  "Monte Carlo simulation 2" ran live: 1000 repeats, mean P 0.4179,
  SD 0.2986, 95% CI [0.009959, 0.9713], power 10.8%, observed 0.4279.

## Environment notes (for the coordinator, not plan defects)

- **Display contention:** :98 was already owned by the plan-24 lane's Xvfb
  (their app windows); :99 was taken too. Proof ran on **:96**, not :98.
- **Single-instance / shared-profile cross-talk:** all lanes share
  `$HOME` and app id `com.helix-desktop.helix`, so a fresh launch restored
  the previous lane's session (`open-projects` → plan21-gui.hlx opened in
  my window, with a "Project Updated" dialog). Workaround used: private
  `XDG_CONFIG_HOME`/`XDG_DATA_HOME` under `~/.helix-p22-tmp/profile`
  (same idea as the plan-23 lane's `/tmp/helix-p23-profile`). With the
  private profile the app opened an empty "Untitled" project — the CLI
  `.hlx` argument was NOT picked up on a cold Linux start; the proof file
  was opened via Ctrl+O → type path → Enter.
- **"Project Updated" dialog** appears when opening `plan22-gui.hlx`
  (written by the current serializer) — worth a look, but it did not
  block anything; OK dismissed it and the file loaded fine.
- **Disk quota:** `cargo check --target aarch64-apple-darwin` first failed
  with EDQUOT (disk quota exceeded) while sibling lanes built releases;
  freed ~2.9G by deleting already-passed `target/debug` +
  `target/{aarch64,x86_64}-apple-darwin` check artifacts, then all checks
  passed on retry. The release build also hit EDQUOT once, then succeeded
  (13m 13s).
- **Exec sessions SIGTERM'd:** several long `muse.exec` calls were killed
  by SIGTERM mid-run (incl. a bare `sleep`); orphaned children (cargo,
  tauri, helix) kept running and completed. Nothing was lost; builds were
  monitored via short polls.
- Menu clicks land ~50px right of the visual target (known L02 quirk);
  the Simulate dialog was reached via the table right-click menu instead.
