# Mac Fix Proof — overnight Nov 11–12, 2026

Agent: Mac fix-proof agent (overnight). Mac unlocked by Smit ~22:37 PT Nov 11; he is asleep. Caffeinate PIDs 89566 (`-i -s`) + 89577 (`-d`) running; do NOT stop until wrap-up (~07:00 PT).

Base: `feat/prism-import-survival` at `0473d73` (all 37 plans verified, 1.0.7 installed, Mac GUI retest PASS Nov 11 evening).

## Tips tested

| Tip | Fixes in it | npm test | DMGs | GUI proof | Verdict |
|-----|-------------|----------|------|-----------|---------|
| 3772d91 | QAB-2 | 663 green (156+363+144), exit 0 | arm64 258ac993… (102,300,203 B), x64 18c24d30… (103,037,206 B) | heatmap + volcano + Plan 18 EC50-shift, all at 1000px | **QAB-2 PASS** |
| 0499c04 | QAB-2 follow-up: Reset re-centers graph desk | 663 green (156+363+144), exit 0 | arm64 09deb351… (102,300,204 B), x64 89c183a4… (103,035,459 B) | **BLOCKED — device gateway down** (see below) | Installed, not yet GUI-proven |
| e62aaf4 | QAB-1 + F-01 | 665 green (158+363+144), exit 0 | arm64 b9c1e3ef… (102,298,904 B), x64 da1fca01… (103,036,053 B) | **BLOCKED — device gateway down** (see below) | Installed, not yet GUI-proven |
| 82f7a9c | QAB-3 + QAB-4 | 667 green (160+363+144), exit 0 | arm64 ac4a04ca… (102,301,005 B), x64 9107e13e… (103,036,984 B) | **BLOCKED — device gateway down** (see below) | Installed, not yet GUI-proven |
| cd327b8 | Linux 4PL + Quirk-2 (orphan dialog) | 669 green (161+364+144), exit 0 | arm64 e25bff52… (102,301,654 B), x64 1872e01b… (103,037,622 B) | **BLOCKED — device gateway down** (see below) | Installed, not yet GUI-proven |

## Per-fix results

### QAB-2 (graph canvas clipped by the inspector) — PASS on tip 3772d91
- Fix: `fix/qab-2` 2550383, merged as 3772d91. Mac npm test 663 green (156 checks + 363 reference + 144 package, exit 0). DMGs built 22:57–22:58 PT, arm64 sha256 `258ac9935a4b92487c74dd170a90ecbb1fe30cc521bcba08a6f6c0c6069e0dc5`, x64 `18c24d30466fa40e40e30774a480a0424db1210e911b5818ab078345267cc00b`. Installed to /Applications/Helix.app (101 MB, version 1.0.7, `codesign --verify --deep --strict` OK); old build stashed at /Applications/Helix.app.old-2026-11-11-fix (delete after all fixes proven). Relaunched via device route: new PID 91483; plan16-gui re-ran with exact values (R² 1, Sy.x 2.644e-11, Bmax 100, Kd 5, NS 0.5, Background 2).
- Proof (all at default 1000px window width, inspector open):
  - **Heatmap (grouped)** in plan33-proof.hlx: canvas fits the visible pane; color scale 26→10 fully visible, all cell values visible (11/14/9, 13/18/10, 15/22/11, 18/27/12), columns A/B/C + Day 1–4 labels visible. Screenshot `qab2-heatmap-grouped-1000px.jpg`.
  - **Volcano (A vs B)**: full plot visible; x-axis Log2 FC −1…1 with the "1" tick at the right edge, y-axis −log10(P) 1.5–3.5, threshold dashed lines visible. Previously the right edge sat under the inspector. Screenshot `qab2-volcano-1000px.jpg`.
  - **Plan 18 EC50-shift (Schild slope = 1)** stats table: value column fully visible at 1000px — EC50 (control) 0.000001, Kb 1e-8, Dose ratio 2 / 11, R² 1, Sy.x 1.971e-8, SS 8.546e-15, DF 22, N 27; Coefficients table complete (Bottom −2.372e-8, Top 100, LogEC50 −6, 95% CIs). Previously clipped at the window's right edge. Screenshots `qab2-plan18-ec50shift-1000px.jpg` (+ `-alert.jpg` with the Project Updated dialog up).
- Note: opening plan33-proof.hlx and plan18-gui.hlx each raised the native "Project Updated" sheet (quirk-2 fix is NOT in this tip — expected old behavior). Dismissed with OK, no orphaning observed. `open_app` file_path refuses .hlx files; `open <file>` via SSH works while Helix is running.

### QAB-1 (second MATCH "Choose…" click destroys all Helix windows) — BLOCKER
- Fix branch: in progress, uncommitted at 22:38 PT.
- Proof criteria: plan33-proof.hlx, heatmap inspector MATCH click, then volcano inspector MATCH click — windows must SURVIVE.
- Result: _pending merge_

### F-01 (Plan 18 Operational stats table renders blank values)
- Fix branch: `fix/f-01` 0c58d6c.
- Proof criteria: stats table shows R² 1/1/1, Sy.x 1.440383352e-07, SS 2.489645039e-13, DF 12, N 18.
- Result: _pending merge_

### QAB-3 (.pzfx date-X drops dates) / QAB-4 (chi-square Yates) / Linux 4PL / Mac quirks
- Fix branches: fix/qab-3 364f48a, fix/qab-4 71527c1, fix/linux-4pl 3a59d65, fix/quirk-2-orphan-dialog 67b0ee3.
- Mostly Linux-proven; Mac-proof only if GUI-visible and time allows.

### Tip 0499c04 — QAB-2 follow-up (Reset re-centers the graph desk) — GUI proof BLOCKED
- Fix: `fix/qab-2` follow-up d7b5552, merged as 0499c04 (~00:32 PT). Change is in `src/views/graphs/graph-view.tsx` only: the "Reset zoom to fit" button sets `resetScroll` so the layout effect zeroes `scrollLeft`/`scrollTop`, re-centring the sheet at the fit (plus an immediate re-centre when already at the fit).
- Mac npm test 663 green at 0499c04 (156+363+144, exit 0; log /tmp/npm-test-0499c04.log on the Mac). DMGs built 00:35–00:37 PT, arm64 sha256 `09deb3514731ce690a22351c1c0442e9d369188dd8ad6d1ad98a95790a2c39f2`, x64 `89c183a4523ccefdd1a0dcd2bffbe06e4509ddfb6eebbcde56ee68ec39be8bde`. Installed to /Applications/Helix.app (101 MB, version 1.0.7, codesign OK); 3772d91 build stashed at /Applications/Helix.app.old-3772d91 (0473d73 build still at /Applications/Helix.app.old-2026-11-11-fix).
- **GUI proof NOT done — device gateway dropped ~00:40 PT.** Sequence: install finished ~00:38 PT; first `computer.control` at ~00:40 PT failed `node_offline`; retried screen.snap at ~00:42, ~00:45, ~00:47 PT — all `node_offline`, last_seen stuck at 00:33 PT. The Mac itself is fine (SSH works; Helix 91483 running; caffeinate 89566/89577 alive; no screensaver; Muse app process alive, PID 72062 /Applications/Muse.app) — the gateway connection is stale, same failure as the evening (fixed then only by Smit relaunching the Muse app). Per brief, stopped retrying after the ~10 min window.
- Consequence: the running Helix (PID 91483) is still the 3772d91 build — the 0499c04 build is installed but not yet launched. GUI proof for the Reset re-centring (zoom the heatmap off-centre via wheel, click Reset, verify sheet centred) is pending gateway recovery. Retry whenever the gateway comes back.
- Note: a Hatch container replacement happened ~00:34 PT (uptime 0 min); /root/.ssh/config mirror was missing and rebuilt (ProxyCommand verified). The service also restarted mid-call once during this tip's npm-test step — the test had already completed (log intact), only the receipt was lost.

### Tip e62aaf4 — QAB-1 + F-01 — GUI proof BLOCKED (gateway still down)
- Merged ~01:02 PT: 168db2a "Merge Fix QAB-1: pass explicit position and window to MATCH popup menu" (a65310b) + e62aaf4 "Merge Fix F-01: move Operational equation out of the stats table" (0c58d6c).
- Mac npm test 665 green at e62aaf4 (158 checks + 363 reference + 144 package, exit 0; log /tmp/npm-test-e62aaf4.log). DMGs built 01:05–01:06 PT, arm64 sha256 `b9c1e3ef390d86597a63f411da603ae17a941de44200d5c40d82bce38150e0a3`, x64 `da1fca018c638ebea59c4fdf21326f6b13bf981035eb9c45b17e24eb748ff2b7`. Installed to /Applications/Helix.app (101 MB, version 1.0.7, codesign OK); 0499c04 build stashed at /Applications/Helix.app.old-0499c04.
- **GUI proof NOT done — gateway still down** (retried ~01:07 PT, `node_offline`; last_seen still 00:33 PT). Running Helix (PID 91483) is still the 3772d91 build — neither the 0499c04 nor the e62aaf4 build has launched yet. Pending proofs if the gateway recovers: (1) QAB-1 two-graph MATCH test in plan33-proof.hlx, (2) F-01 Plan 18 Operational stats table values, (3) 0499c04 Reset re-centring.
- Deliberately NOT restarting the Muse app from SSH: the evening precedent needed Smit relaunching it, and GUI launches from SSH are known to fail silently (no Aqua session); killing his live Muse session while he sleeps risks leaving it down with no recovery path. Gateway retried once per poll cycle (~15 min); if it recovers, GUI proof resumes immediately.

## Wrap-up (~02:17 PT Nov 12)
- Gateway stayed offline ~96 min (last_seen frozen at 00:33 PT; retries at ~00:42, 00:45, 00:47, 01:02, 01:07, 01:27, 01:46, 02:01, 02:16 PT all `node_offline`). Mac itself verified fine via SSH throughout (awake, unlocked, no screensaver; Muse app PID 72062 alive but gateway connection stale — same failure as the evening, which needed Smit relaunching the Muse app). Per parent's heads-up, wrapped up cleanly instead of waiting to 07:00 PT.
- **Mac-proven before the drop: QAB-2 only** (tip 3772d91, PASS — heatmap + volcano + Plan 18 EC50-shift at 1000px, 4 screenshots).
- **Installed and suite-green but NOT Mac-proven:** 0499c04 (Reset re-centring), e62aaf4 (QAB-1 + F-01), 82f7a9c (QAB-3 + QAB-4), cd327b8 (Linux 4PL + Quirk-2). All DMGs built, installed, codesign-verified; Mac npm test green at every tip (663 → 663 → 665 → 667 → 669).
- **Final Mac state:** /Applications/Helix.app is the cd327b8 build (1.0.7, codesign OK) but has never launched — running Helix (PID 91483) is still the 3772d91 build. Stashes kept for every superseded build: Helix.app.old-2026-11-11-fix (0473d73), .old-3772d91, .old-0499c04, .old-e62aaf4, .old-82f7a9c. Both caffeinate PIDs stopped (89566, 89577); Mac will sleep on its own. Mac repo at cd327b8.
- **To finish:** Smit relaunches the Muse app on the Mac (gateway fix) → relaunch Helix via the device route (new PID, cd327b8 build) → GUI-prove in order: QAB-1 two-graph MATCH test (blocker), F-01 Operational stats values, Reset re-centring, QAB-3 date-X import, QAB-4 2×2 chi-square 8.120, Quirk-2 in-app alert. Then delete the old stashes once the cd327b8 build is proven.

## Poll log
- 22:38 PT — origin still 0473d73. Caffeinate 89566/89577 alive, Helix 88323 running, Mac online + unlocked, no screensaver.
- 22:53 PT — tip moved to 3772d91 (QAB-2 merge). Mac reset to tip, npm test 663 green, DMGs built, installed (codesign OK), new PID 91483. QAB-2 GUI proof PASS (heatmap + volcano + Plan 18 EC50-shift at 1000px, 4 screenshots).
- 23:17 / 23:32 / 23:47 / 00:02 / 00:17 PT — tip still 3772d91.
- 00:32 PT — tip moved to 0499c04 (QAB-2 Reset-scroll follow-up). Mac reset, npm test 663 green, DMGs built, installed (codesign OK). GUI proof BLOCKED: device gateway down since ~00:40 PT (Muse app PID 72062 alive, gateway stale; 3 retries failed). Polling continues; retry GUI proof if the gateway recovers.
- 01:02 PT — tip moved to e62aaf4 (QAB-1 + F-01 merges). Mac reset, npm test 665 green, DMGs built, installed (codesign OK). GUI proof BLOCKED: gateway still down (~01:07 PT retry failed). Running Helix still 3772d91 build (PID 91483).
- 01:22 PT — tip moved to 82f7a9c (QAB-3 + QAB-4 merges: 11cec2c QAB-3, 82f7a9c QAB-4). Mac reset, npm test 667 green (160+363+144, exit 0; log /tmp/npm-test-82f7a9c.log). DMGs built 01:24–01:26 PT, arm64 sha256 `ac4a04ca605d7316709345b0bcc149035e17e3946bcf99078d44819274168696`, x64 `9107e13e535bccf1633aa5a54bb605b3c1f71a8d86521b4f7a642d8cd7fe85bb`. Installed (codesign OK); e62aaf4 build stashed at /Applications/Helix.app.old-e62aaf4. GUI proof BLOCKED: gateway still down (~01:27 PT retry failed, ~47 min down). Pending GUI proofs if it recovers: QAB-1 two-graph MATCH test, F-01 Operational stats values, 0499c04 Reset re-centring, QAB-3 date-X .pzfx import (fixture x_date.pzfx), QAB-4 2×2 chi-square 8.120 view.
- 01:41 PT — tip moved to cd327b8 (Linux 4PL merge 14503be + Quirk-2 merge cd327b8). All 8 fix items now merged. Mac reset, npm test 669 green (161+364+144, exit 0; log /tmp/npm-test-cd327b8.log). DMGs built 01:44–01:45 PT, arm64 sha256 `e25bff5230c6c17bcc9148bb1256869b1beee46f1b9bd7b721b7417848c4db13`, x64 `1872e01b7eee7003ee4941116dbf06ecbe542c5097008f8424cfd05f7377d0a5`. Installed (codesign OK); 82f7a9c build stashed at /Applications/Helix.app.old-82f7a9c. GUI proof BLOCKED: gateway still down (~01:46 PT retry failed, ~66 min down). Running Helix still 3772d91 build (PID 91483) — no fix build has launched yet.

## Take 2 — Nov 12 morning (reconstructed by take 4; take 2 wrote no report section)

- Gateway came back ~09:36 PT (Smit relaunched the Muse app). Take 2 relaunched Helix via the device route (new PID 5509, cd327b8 build) and worked through the proof list. It was interrupted ~10:27 PT by a Hatch container replacement — no handoff, no report section — but left 6 screenshots in `qa/fix-proof-2026-11-11/` (timestamps 18:01–18:11 UTC = 10:01–10:11 PT), reviewed by take 4 below.

### Take-2 evidence reviewed by take 4
- **F-01 (Plan 18 Operational stats) — PASS** (screenshot `f01-operational-stats-values.jpg`, 10:03 PT). Stats table shows all values: R² (Full agonist) 1, R² (Partial agonist) 1, R² 1, Sy.x 1.44e-7, Sum of squares 2.49e-13, DF 12, N 18 — exact match to the pinned values (1.440383352e-07, 2.489645039e-13, 12, 18). The equation renders as a wrapping block above the table, coefficients complete below. The fix (equation moved out of the stats table) is proven.
- **Reset re-centring (0499c04) — PASS** (screenshots `reset-baseline-fit.jpg`, `reset-zoomed-212pct-offcentre.jpg`, `reset-after-reset.jpg`, 10:11 PT). Baseline at fit → zoomed to 212% off-centre (badge "212%" bottom-right, only part of the heatmap visible) → after Reset, back at fit, pixel-identical framing to baseline (all cells 11/14/9, 13/18/10, 15/22/11, 18/27/12; color scale 26→10).
- **QAB-1 — PARTIAL, needs a clean re-run.** Screenshots `qab1-heatmap-inspector-1000px.jpg` (10:01 PT) and `qab1-volcano-match-menu-open.jpg` (10:01 PT) show: heatmap inspector open with MATCH "Choose…" visible, then the volcano inspector with the second MATCH popup menu OPEN (graph list visible: Grouped — dose by day, Heatmap (grouped), Box and violin, Box and whiskers, …) and all windows still alive. The second menu opening without destroying windows is a strong signal the fix works, but there is no evidence of a graph selection in the second menu + survival after selection. Take 4 re-runs the full two-graph MATCH test.

### Take-2 state at interruption (~10:27 PT)
- Helix (PID 5509, cd327b8) was running; QAB-3, QAB-4, Quirk-2 not yet attempted. Take 3 (71066558) spawned ~10:36 PT died in a second daemon restart ~10:41 PT before doing anything (only listed the screenshots dir); the sanity check's replacement (3a643a0a) died in the same restart. Take 4 resumes here.

## Take 4 — Nov 12 late morning

### State on arrival (~10:44 PT)
- SSH mirror verified (`ssh -G macbook` shows ProxyCommand). Hatch container replaced again ~10:41 PT (uptime 2 min at 10:43 PT); mirror rebuilt 10:43 PT.
- Mac via SSH: awake, no screensaver; caffeinate PIDs 4249 (`-i -s`) + 4263 (`-d`) alive; `/Applications/Helix.app` = cd327b8 build (1.0.7, md5 of Info.plist `490e0981…`) but **Helix NOT running** at 10:35 PT — it exited sometime after take 2's interruption (cause unknown; not a QAB-1 window-kill, which leaves the process alive). Stashes intact (5).
- Gateway: `device.list` shows "Smit's MacBook Air" **offline**, last_seen 18:42:51Z (~10:42 PT, ~2 min before the check) — possibly just dropped in the restart; retrying.

### Gateway block (~10:44–10:50 PT)
- `device.list` shows "Smit's MacBook Air" **offline**, last_seen frozen at 18:42:51Z (~10:42 PT). `connection.health` invoke fails `node_offline` (no wake-up path advertised). Mac itself is fine via SSH (awake, unlocked, no screensaver; caffeinate 4249/4263 alive) — same stale-gateway failure as overnight, which needed Smit relaunching the Muse app. Per brief, retrying after ~10 min; the Muse app is NOT being restarted from SSH.
- SSH prep done while waiting: origin still cd327b8 (no Round 2 merges yet); Mac repo at cd327b8, clean; fixtures present (plan33-proof.hlx, plan18-gui.hlx in `~/retest/retest-2026-11-11/`; x_date.pzfx at `~/helix/tests/testdata/x_date.pzfx`).

### Gateway retry (~10:55 PT) — still down
- After the 5-min wait, `device.list` showed last_seen moved 18:42:51Z → 18:52:22Z (~10:52 PT) and the connection-recovery entry updated to 18:51:12Z, but connection_state is still "offline" and a live `screen.snap` fails `node_offline` (no wake-up path). `connection.repair` (target web) also fails `node_offline` — the repair ask cannot be delivered to an offline device.
- Verdict: gateway is down; only Smit relaunching the Muse app on the Mac restores it (the established fix from Nov 11 evening and this morning). Take 4 is blocked on GUI proof until then and reports here. SSH-side state is staged and ready: origin still cd327b8, Mac repo clean, fixtures present, caffeinate 4249/4263 alive, Helix not running (to be relaunched via the device route once the gateway is back).
- Still to prove once the gateway recovers: QAB-1 full two-graph MATCH test (take 2's evidence is partial), QAB-3 date-X import, QAB-4 chi-square 8.120, Quirk-2 in-app alert — then Round 2 tip polling as merges land.

## Take 5 — Nov 12 late morning

### Arrival state (~10:58 PT)
- Take 4 (25e72f59) died in a daemon restart ~10:56 PT after writing its sections above. The sanity check's replacement for it was cancelled. Take 5 resumes here.
- **Correction to take 4's record: Helix IS running.** Take 4 (and take 2's handoff) reported "Helix NOT running" based on `pgrep -x Helix` — that check is case-wrong: the process name is lowercase `helix`. `ps aux` shows PID 5509 `/Applications/Helix.app/Contents/MacOS/helix` alive since 9:54 PT (take 2's launch, cd327b8 build, 0:48 CPU time). No relaunch is needed once the gateway is back; the session take 2 was working in is still alive. Lesson for future takes: check with `pgrep -x helix` (lowercase) or `ps aux | grep -i helix`.
- Take-2 screenshot evidence independently re-reviewed by take 5 — agrees with take 4: **F-01 PASS** (all stats values visible, exact), **Reset re-centring PASS** (after-reset framing matches baseline), **QAB-1 PARTIAL** (second MATCH menu opened with windows alive, but no selection step screenshotted — needs a clean full re-run).
- SSH mirror verified (`ssh -G macbook` shows ProxyCommand). Container uptime 17 min at 10:58 PT (replaced ~10:41 PT); mirror intact from 10:43 PT rebuild.
- Mac via SSH: awake, no screensaver; caffeinate PIDs 4249 (`-i -s`) + 4263 (`-d`) alive; Muse.app PID 72062 alive (since 7:16 PM Nov 11) but its gateway connection is stale; `/Applications/Helix.app` = cd327b8, stashes intact (5). Mac repo at cd327b8, clean.
- Origin still cd327b8 (no Round 2 merges yet). `rebrand/titer` on origin at 7ffb614 (Batch A identity committed + pushed).

### Gateway block — still down (~11:00 PT, third consecutive failure)
- `device.list`: "Smit's MacBook Air" **offline**, last_seen frozen at 18:56:40Z (10:56:40 PT). `connection.health` fails `node_offline`; `screen.snap` fails `node_offline` (no wake-up path advertised). Same stale-gateway failure as overnight and this morning — take 4 retried ~10:44 and ~10:55 PT, take 5 retried ~11:00 PT, all `node_offline`.
- Verdict: GUI proof is blocked until Smit relaunches the Muse app on the Mac (the established fix). The Muse app is NOT being restarted from SSH. Take 5 reports blocked here; a later take resumes when the gateway recovers.
- SSH-side state is staged and ready: Helix PID 5509 alive (cd327b8), caffeinate 4249/4263 alive, fixtures present (plan33-proof.hlx, plan18-gui.hlx in `~/retest/retest-2026-11-11/`; x_date.pzfx at `~/helix/tests/testdata/x_date.pzfx`).
- Still to prove once the gateway recovers: QAB-1 full two-graph MATCH test, QAB-3 date-X import, QAB-4 chi-square 8.120, Quirk-2 in-app alert — then Round 2 tip polling as merges land (origin still cd327b8 at 11:00 PT).

## Take 6 — Nov 12 late morning (~11:18 PT)

### Peer check
- No peer Mac fix-proof agent running (`subagent.list`: only this take, the rebrand lane take 6, and the Round 2 coordinator active). Proceeding as the sole proof agent.

### Gateway block — STILL DOWN (fourth consecutive failure)
- `device.list`: "Smit's MacBook Air" **offline**, last_seen 19:10:06Z (11:10:06 PT) — moved forward from take 5's frozen 18:56:40Z, but connection_state is still `offline`.
- `connection.health` fails `node_offline` (no wake-up path advertised). Same stale-gateway failure as overnight and all morning (take 4 ~10:44/10:55, take 5 ~11:00, take 6 ~11:18 PT).
- Verdict: GUI proof is blocked until Smit relaunches the Muse app on the Mac (the established fix). The Muse app is NOT being restarted from SSH. Take 6 stops here per brief — no retries in a loop, nothing woken.

### SSH-side state verified (~11:18 PT)
- Mac awake via SSH (Tailscale path working); HIDIdleTime ≈ 3,872 s (~65 min) — Smit is NOT active on the Mac.
- Helix PID 5509 still running (take 2's 9:54 PT launch, 1:00 CPU time); caffeinate PIDs 4249 (`-i -s`) + 4263 (`-d`) alive.
- **Installed binary is still the OLD build:** /Applications/Helix.app binary 103,717,072 B, md5 `52aefdb75a5e58a0fc184fb67780a772` — matches the sanity check's 3772d91-era build. The cd327b8 DMG install recorded overnight (01:44 PT, arm64 sha `e25bff52…`) is NOT reflected in the live binary md5 — the cd327b8 fixes are NOT installed on the running app. Re-verify the DMG shas and reinstall from cd327b8 before any proof run once the gateway recovers (do NOT build from the local-only F-02 merge 2aa5dc5).
- Origin `feat/prism-import-survival` still cd327b8 (no Round 2 merges yet). Hatch container uptime 37 min (replaced ~10:41 PT; no new swap this take).

### Still to prove once the gateway recovers
- QAB-1 full two-graph MATCH test (take 2's evidence is PARTIAL only), F-01 already PASS (take 2, re-reviewed), Reset re-centring already PASS (take 2), QAB-3 date-X import, QAB-4 chi-square 8.120, Quirk-2 in-app alert — then Round 2 tip polling as merges land.
- Standing lesson: check Mac processes with `pgrep -x helix` (lowercase) or `ps aux | grep -i helix` — `pgrep -x Helix` is a false negative.

### Correction — installed binary IS cd327b8 (Atlas, ~11:25 PT, verified via SSH)
- Take 6's "Installed binary is still the OLD build" bullet above is WRONG — do not act on it. Atlas re-verified with md5s of every build on disk:
  - Live /Applications/Helix.app: 103,717,072 B, md5 `52aefdb75a5e58a0fc184fb67780a772`
  - .old-82f7a9c: same size, md5 `09528061f052a546b5bd22c6f48d619d` (DIFFERENT)
  - .old-e62aaf4: same size, md5 `cf59627c914cf0863acb43e51f6cb62b` (DIFFERENT)
  - .old-0499c04: same size, md5 `a9dc7b4cf139cc9b48bfe560c37acfa6` (DIFFERENT)
- The live md5 matches NONE of the stashed known-commit builds, and no reference md5 for a 3772d91 binary exists anywhere in this record (the report holds DMG sha256s only — not comparable to a binary md5). By elimination + the install sequence (01:44–01:45 install, after the 82f7a9c stash) + F-01 PASS on the running app (F-01's fix came after 3772d91), the installed app IS cd327b8. Next take: do NOT reinstall before proving; prove the cd327b8 fixes in the running app (PID 5509).
- Note: stashes .old-3772d91 and .old-2026-11-11-fix are gone (only .old-0499c04/.old-e62aaf4/.old-82f7a9c remain) — fallback to 0473d73 now requires a rebuild, not a stash swap.

## Take 7 — Nov 12 afternoon (~13:33 PT)

### Gateway RECOVERED — proof resumes
- Gateway back ~13:22 PT (Smit relaunched the Muse app; he is messaging from the Mac). `device.list`: "Smit's MacBook Air" **online**, last_seen 13:22:17 PT. `connection.health`: native + web transports both `connected`, lastResponseAgeSeconds 0 / 3.
- SSH-side state verified ~13:34 PT: Hatch container replaced ~13:22 PT (uptime 13 min); /root/.ssh/config mirror rebuilt 21:22 UTC, present. Helix PID 5509 alive (cd327b8, since 9:54 PT); caffeinate 4249 (`-i -s`) + 4263 (`-d`) alive. Live binary md5 `52aefdb75a…` — matches Atlas's cd327b8 verification; **no reinstall**. Mac repo at cd327b8, clean. Fixtures present (plan33-proof.hlx in `~/retest/retest-2026-11-11/`; x_date.pzfx at `~/helix/tests/testdata/`).
- On arrival the Helix window (background, Smit in the Muse app) had a stale **"Import Prism File"** dialog open over plan33-proof.hlx — leftover from take 2's interrupted session (~10:27 PT), not Smit's (Helix is not frontmost). Dismissed via Cancel through the device route (background input, app never brought forward). All proof work this take is background-only: Smit is actively using the Mac.

### QAB-1 (second MATCH "Choose…" click destroys all Helix windows) — PASS, clean full re-run (~13:35 PT)
- plan33-proof.hlx already open (Heatmap (grouped) selected). Step 1: heatmap inspector MATCH "Choose…" → popup menu opened (7 graph entries) → selected **"Box and whiskers"** — MATCH button updated, window alive. Step 2: switched to **Volcano (A vs B)** graph (volcano plot rendered, Log2 FC −1…1, −log10(P) 1.5–3.5) → its MATCH "Choose…" → second popup menu opened (10 entries) with all windows alive → selected **"Heatmap (subjects)"** — MATCH button updated to "Heatmap (subjects)", menu closed, window survived with sidebar + canvas + inspector all intact.
- This closes take 2's PARTIAL: the second menu's **selection step is now captured**, not just the menu opening. The fix (explicit position + window passed to the MATCH popup menu) is proven on cd327b8.
- Screenshot: `qab1-full-rerun-pass.jpg` (volcano plot + MATCH showing "Heatmap (subjects)").
- Note: the two MATCH selections changed plan33-proof.hlx's in-memory match state only (not saved to disk).

### QAB-3 (.pzfx date-X drops dates) — PASS (~13:41 PT)
- Imported `x_date.pzfx` (~/helix/tests/testdata/) via File → Import Prism File… into the Untitled window (renamed to 'x_date'). In-app import alert: "Prism File Imported — Imported 1 table from "x_date": • Sample Data. Notes: • "Sample Data": the X values are dates; the dates were kept as row titles. Save the project to keep it as a Helix project." — the alert is an in-app sheet (Quirk-2 mechanism working; dedicated Quirk-2 check still to do).
- Table "Sample Data", XY, columns Title / Date X / Observation / Y2–Y7, 50 data rows. Values match the pinned check exactly: row 1 "16-Jan-2004" / "0" / "120"; row 2 "9-Apr-2009" / "5.22929500342231" / "64"; row 3 "1-Mar-2012" / "8.12320328542094" / "46"; last row "17-Oct-2018" / "14.7515400410678" / "87" (verified by scrolling to row 50; rows 51+ empty). Dates are row titles; Date X holds the numeric values.
- Screenshots: `qab3-date-x-first-rows.jpg`, `qab3-date-x-last-row.jpg`.
- Side notes: (1) `open x_date.pzfx` via SSH fails — LaunchServices has no app claiming .pzfx (kLSApplicationNotFoundErr); `open -a Helix` created a new empty window then showed a wrong "Couldn't Open Project — 'x_date.pzfx' couldn't be found" alert even though the file exists — the app's Apple-Event open handler does not resolve the path. In-app File → Import is the working route. (2) The Import picker's search-suggestion menu and list-row clicks do not reliably take background input; navigating via the sidebar (Desktop, after copying the fixture there) worked. (3) A "Helix 1.0.9 is available" update alert appeared after dismissing the failed-open alert — dismissed with Later; upstream 1.0.9 is HELD for v1.1, do not download.

### QAB-4 (2×2 chi-square shows Yates-corrected value) — PASS (~13:53 PT)
- Created a new Contingency table in the x_date window ("Table 1", columns Title / Outcome A–H) and typed the pinned 2×2: Drug 15/5, Placebo 6/14. Analysis menu → "Chi-Square or Fisher's Exact Test".
- First run showed the validator error "A contingency table needs at least 2 rows with a count in every group column" — cause was my own data entry: the last "14" was typed but never committed (no Tab/Enter after it), so Placebo's Outcome B was empty when the analysis read the table. Re-typed "14" + Tab to commit; the live analysis sheet recomputed automatically.
- Result sheet "Chi-square or Fisher's exact test" shows exactly the pinned values: **P value (Fisher's exact test) 0.01039** (pinned 0.0103867), **Chi-square (for reference) 8.12** (pinned 8.1203 — the UNCORRECTED Pearson statistic, Prism's default), **df 1**, Odds ratio 6.615, "Contingency table 2×2, N = 40", "Significant *". The empty Outcome C–H columns are correctly ignored (columns without numbers are left out of the matrix).
- Screenshot: `qab4-chi-square-8-120.jpg`.
- Side note: the grid's native right-click (context) menu does not open via background input — right-clicking a column header only selects the column. Column delete therefore couldn't be exercised this way; it wasn't needed here. (Also: always Tab/Enter to commit the last typed cell before switching views — an uncommitted edit is discarded.)

### Quirk-2 ("Project Updated" native dialog orphans its window) — PASS (~13:56 PT)
- Opened `plan18-gui.hlx` (~/retest/retest-2026-11-11/) via `open` from SSH; it opened as a new window (16153). On load the **"Project Updated" notice appeared as an in-app dialog** rendered inside the plan18-gui window (part of the window's own AX tree, no separate native window): title "Project Updated", text "This project was made with an older Helix, or part of it couldn't be read as it was. Helix brought it up to date; save it to keep the update.", OK button. Behind it the Schild (slope = 1) results (R² 1/1/1, Sy.x 1.971e-8, SS 8.546e-15, DF 22, N 27).
- Clicked OK: dialog gone, full results view restored. Window list unchanged at 18 windows — no new window created for the dialog and none left behind. Clicks work after dismissal: clicked "Schild (slope free)" in the sidebar and the view switched (equation SchildSlope free, Sy.x 1.631e-8, SS 5.583e-15, DF 21, Bottom −2.637e-8). The old failure (native dialog's window lingering, blocking clicks and quitting) does not reproduce.
- Screenshot: `quirk2-project-updated-in-app.jpg`.
- Note: a tiny 66×20 "Window" entry appears in list_windows with a changing id each listing (16123 → 16133 → 16156) — transient, not a lingered dialog. A 260×218 untitled window (16130) has persisted since the "Helix 1.0.9 is available" update alert earlier this take; it predates the plan18 open and is not an orphan from this dismissal, but its origin is unconfirmed.

## Take 7 — status after the four proofs (~13:57 PT)
- **All four Round 1 fixes now Mac-proven on cd327b8: QAB-1 PASS (clean full re-run), QAB-3 PASS, QAB-4 PASS, Quirk-2 PASS.** Plus F-01 PASS + Reset re-centring PASS (take 2, re-reviewed). Round 1 Mac proof is complete.
- Origin still cd327b8 at last check (~13:34 PT). F-02 merge 2aa5dc5 still unpushed. Polling for Round 2 tips next, per brief.

## Take 7 — Round 2 tip poll (~14:08 PT): tip moved to c1195cb
- Poll ~14:08 PT: origin `feat/prism-import-survival` moved cd327b8 → **cc96b78** (F-02 merge 2aa5dc5 + M1 merge). While resetting the Mac repo (~14:10 PT) it moved again → **c1195cb** (adds M10 merge). Tip to prove: **c1195cb = F-02 + R2-M1 + R2-M10**.
  - F-02 (8611f9f): Logistic Curve guard for non-binary Y — GUI proof: textbook XY table (X −2..2, Response 2..98) → Logistic Curve graph shows all 9 points autoranged + note "Logistic curve needs a 0/1 outcome — the Y values are not all 0 or 1, so no fitted curve is drawn."
  - R2-M1 (25930d8): parse inhibitor concentration from the unit-adjacent number ("Day 2 — 10 nM" → 10, not 2) — stats-engine fix; Mac verification is the npm test (its check runs on the Mac). No separate GUI proof planned.
  - R2-M10 (3d44d70): .pzfx date-X with row titles — GUI proof: import `x_date_row_titles.pzfx` → "Sample Data", columns Title / Date X / Date X (date) / Observation, 5 rows (row 0 "Sample A"/"0"/"16-Jan-2004"/"120"; row 4 "Sample E"/"8.27652292950034"/"26-Apr-2012"/"52"); warning "kept in a "Date X (date)" column".
- Mac repo reset to c1195cb (fetch + reset --hard, ~14:10 PT). Helix PID 5509 still running cd327b8; caffeinate 4249/4263 alive. Gateway healthy (connection.health both transports connected, 0s).
- **Mac npm test on c1195cb: GREEN, 673 total (164 checks + 365 reference + 144 package)** — checks 161→164 (+F-02, +M1, +M10), reference 364→365 (+F-02 logistic fixture). Log /tmp/npm-test-c1195cb.log on the Mac. Only benign R/webR warnings (glm.fit, ties, MethComp repo). This is also the Mac verification for M1 (stats-engine fix; its check runs in this suite).
- SSH flaked ~14:15 PT (egress proxy broken pipe on the primary Tailscale path; Pi-tunnel backup `mac` also down — Pi-side localhost:2222 listener refused). Retried after a few minutes; primary recovered ~14:19 PT. The nohup'd npm test was unaffected.
- DMG build on the Mac launched ~14:22 PT (scripts/build-mac-dmg.sh, PID 35476, log /tmp/build-dmg-c1195cb.log). Awaiting completion before install + GUI proof (F-02 textbook table, M10 x_date_row_titles import).

## Take 7 — c1195cb DMG build + install (~14:27–14:31 PT)
- DMG build DONE (~14:19 PT per file timestamps; build wait returned ~14:27 PT). The script produces the **1.0.6-named DMGs** (Tauri's own step also leaves 1.0.7-named DMGs from the same build — same .app inside, different DMG metadata; the script's 1.0.6 files are the install source):
  - arm64: `Helix_1.0.6_aarch64.dmg`, 102,289,515 B, sha256 `75d8cc4285f86d2ebb2c68001dcf70d740fe211792b03f45500d78238549b95e`
  - x64: `Helix_1.0.6_x64.dmg`, 103,040,821 B, sha256 `7de22fef38abc8a6f3d5d48e07669c839a46b3d8d5b1ebb76ae6146704b76266`
- Install: mounted the arm64 DMG, copied Helix.app to a temp name, detached, stashed the old build as `/Applications/Helix.app.old-cd327b8` FIRST, swapped in the new build, `codesign --verify --deep --strict` → **OK**. New binary md5 `39e8d63cb1574b9da350ccb2dd9c3c7c` (cd327b8 live binary was `52aefdb75a…`).
- Quit the old build (PID 5509, cd327b8) via device-route Cmd+Q: three save dialogs appeared in sequence (x_date → plan33-proof → plan18-gui), each dismissed with **Don't Save** — all changes were this take's in-memory test artifacts, already recorded with screenshots; the on-disk fixtures are untouched. (Note: plan18-gui was dirty because the "Project Updated" migration marks the project changed; Don't Save means it re-migrates on every open — expected.) Old process fully gone after the third dismissal (pgrep exit 1).
- Relaunch via device route (open_app Helix): **new PID 38337, started 14:28:06 PT, binary md5 39e8d63c… — c1195cb confirmed running.** macOS restored a 14-window session from an older saved state (plan02, plan03, plan08–plan16, plan18, plan33, fixture-nested, roc-plan05, retest + the tiny 66×20 "Window") — all restored, none modified by this take. plan18-gui again showed the "Project Updated" in-app dialog on open (migration not saved); dismissed with OK, full Schild results behind it (R² 1/1/1, Sy.x 1.971e-8, SS 8.546e-15, DF 22, N 27).
- Side notes: (1) File menu has no "New Project" item (only Close Window / Close All) — a new table is made with the in-window "New Table…" button. (2) The device-route pointer badge (Muse avatar) sits fixed over the plot centre in screenshots and does not move with a background `move` — it partially covers one plot point in the F-02 screenshot; it is a route artifact, not part of the app.

### F-02 (Logistic Curve empty for non-binary Y) — PASS (~14:31 PT, tip c1195cb)
- Fixture: the Mac had no `qa/fix-4pl/textbook-4pl.hlx`, so it was copied from Hatch (`scp`, 1,100 B) to `~/helix/qa/fix-4pl/` and opened via `open` from SSH (new window 16228, "textbook-4pl"). The window's 4PL fit sheet confirms the fixture: Bottom −1.351, Top 101.4, EC50 1, HillSlope 0.7766, R² 0.9993 — the textbook XY table (X −2..2, Response 2..98).
- Graph menu → "Logistic Curve" (direct menu item; "New Graph…" also exists). The graph renders the fix exactly as designed:
  - **All 9 points visible** in the sigmoid pattern — (−2,2), (−1.5,5), (−1,12), (−0.5,30), (0,50), (0.5,70), (1,88), (1.5,95), (2,98). (8 clearly visible in the screenshot; the (0,50) point sits under the device-route pointer badge — the 9-point trace is pinned by the Mac npm test's F-02 checks case.)
  - **Y axis autoranged 0–100** (ticks 0/20/40/60/80/100), X −2..2 — the old hard-clamped 0..1 Y range is gone.
  - **On-graph note rendered at the top of the plot: "Logistic curve needs a 0/1 outcome — the Y values are not all 0 or 1, so no fitted curve is drawn."**
  - **No fitted curve drawn** (correct — the logistic runner refuses non-0/1 data; no fit is claimed).
- Screenshot: `f02-logistic-curve-pass.jpg` (the pointer badge covers the (0,50) point; see install note above).
- The binary-fixture regression (X 0..9, Response 0/0/0/0/1/0/1/1/1/1 → fixed 0..1 axis, ticks [0,1], sigmoid midpoint 0.5 at X=4.5) is covered by the Mac npm test on this tip (673 green, reference 365 incl. the F-02 logistic fixture) — not re-proven separately in the GUI this take.

## Take 7 — M10 proof next (tip c1195cb)

### R2-M10 (.pzfx date-X with row titles drops the dates) — PASS (~14:38 PT, tip c1195cb)
- Fixture `x_date_row_titles.pzfx` (~/helix/tests/testdata/, 1,258 B) copied to ~/Desktop; File → Import Prism File… in the textbook-4pl window.
- **Picker lesson (new): the native open panel does NOT take background input on its file list** — single-click, double-click, Up arrow, Cmd+Shift+G, search-field click + type, and coordinate clicks all showed no change (same class as take 7's QAB-3 finding). What worked: clicking a row's DATE cell via click_element (element 16, "Today at 1:41 PM") — the click selected the FIRST row (x_date_row_titles.pzfx, blue highlight; the date-cell click seems to land on the row above the clicked cell, or earlier unobserved clicks had primed the selection — either way the screenshot confirmed the correct row). The Open button is not a numbered element while disabled; once enabled it is clickable via click_element with label "Open" (route "sheet_label_press").
- **Save-prompt detour:** the import first raised "Do you want to save the changes you made to your project?" because the textbook-4pl window was dirty (the Logistic Curve graph created for F-02). Chose **Don't Save** — the import then REPLACED the window's project with the imported data (window retitled 'x_date_row_titles'; sidebar shows only "Sample Data"). The on-disk `textbook-4pl.hlx` is untouched (mtime still 14:29, the copy time; md5 `47be426c…`), and the F-02 proof is already recorded with its screenshot.
- Import alert "Prism File Imported": **"Imported 1 table from "x_date_row_titles": • Sample Data. Notes: • "Sample Data": the X values are dates; the existing row titles were kept and the dates were kept in a "Date X (date)" column."** — the dates are kept in their own column (the old bug dropped them while claiming the opposite); "row titles were kept" here means the Sample A–E titles stay as the Title column, not that the dates were kept as row titles.
- Imported table "Sample Data", XY — columns **Title / Date X / Date X (date) / Observation** (+ empty Y3–Y7), 5 rows, all exactly the pinned values:
  - Sample A / **0** / 16-Jan-2004 / 120
  - Sample B / 5.22929500342231 / 9-Apr-2009 / 64
  - Sample C / 8.12320328542094 / 1-Mar-2012 / 46
  - Sample D / 8.23819301848049 / 12-Apr-2012 / 51
  - Sample E / 8.27652292950034 / 26-Apr-2012 / 52
  - Rows 6+ empty.
- Screenshot: `m10-date-x-row-titles-pass.jpg`. (AX note: the focused "Date X, row 1" cell editor reported value='' in the AX tree, but the screenshot shows the cell displays **0** — the editor value is unreliable while focused; the visual grid is authoritative.)
- **Round 2 tip c1195cb Mac proof is now COMPLETE: F-02 PASS + M10 PASS (GUI) + M1 covered by the Mac npm test (673 green).**

## Take 7 — status after the c1195cb proofs (~14:38 PT)
- Installed build: c1195cb (PID 38337, since 14:28 PT, binary md5 39e8d63c…). Round 1 Mac proof complete (cd327b8); Round 2 tip c1195cb Mac proof complete (F-02, M10 GUI + M1 via npm test).
- Polling for the next Round 2 tip next, per brief (ls-remote ~every 15 min; on a move: reset Mac repo, npm test, DMG build, install via stash-first swap, GUI-prove). The current window state: 'x_date_row_titles' window (16228) holds the unsaved M10 import; the F-02 textbook window was replaced by it (fixture file intact on disk). The empty "Tauri App" dialog-host window (16196) lingers — harmless.

## Take 8 — Nov 12 afternoon (~14:40 PT)

### Arrival state
- Resumed from the proof file. Gateway online (last_seen 14:37 PT). Helix PID 38337 (c1195cb, since 14:28 PT, binary md5 39e8d63c…) running; caffeinate 4249/4263 alive. Mac repo at c1195cb.
- Window wrangling: plan33-proof was covered by x_date_row_titles (unsaved M10 import), Tauri App dialog-host, and plan18-gui, and returned no painted content while covered. Closed x_date_row_titles (Don't Save — M10 proof already recorded, fixture untouched), Tauri App (empty, no prompt), plan18-gui (Don't Save — re-opened fresh for Quirk-2 below). plan33-proof's content still didn't paint until a 1px resize forced a repaint — which revealed the "Project Updated" in-app dialog waiting in it (restored session re-shows it since the migration was never saved). Resized back to 1000×700.
- Lessons: background menu/key shortcuts are ignored until the window has focus (click a neutral element first, then the menu works). The transient 66×20 "Window" overlay sits over the frontmost window's traffic lights and blocks clicks there; it closes when activated and respawns on interaction — use menu/keyboard or click elsewhere, never the traffic-light buttons.

### QAB-1 (second MATCH "Choose…" click destroys all Helix windows) — PASS, clean full re-run on c1195cb (~14:47 PT)
- plan33-proof.hlx, Heatmap (grouped) selected. Step 1: heatmap inspector MATCH "Choose…" → popup menu opened (7 entries) → selected "Box and whiskers" — MATCH updated, window alive. Step 2: switched to Volcano (A vs B) (volcano rendered, Log2 FC −1…1, −log10(P) 1.5–3.5) → its MATCH "Choose…" → second popup menu opened (10 entries) with all windows alive → selected "Heatmap (subjects)" — MATCH updated to "Heatmap (subjects)", menu closed, sidebar + canvas + inspector intact.
- Window count after both selections: 15 (14 project windows + the transient tiny "Window") — nothing destroyed.
- Screenshot: `qab1-full-rerun-c1195cb-pass.jpg` (volcano plot + MATCH showing "Heatmap (subjects)").
- This re-proves on c1195cb what take 7 proved on cd327b8; the QAB-1 fix code is unchanged between the tips, and the c1195cb delta (F-02/M1/M10) doesn't touch the MATCH popup path.

### Quirk-2 supporting evidence on c1195cb
- The plan33-proof window's restored session showed the "Project Updated" notice as an in-app dialog (centred sheet over the heatmap, OK button) — screenshot `quirk2-project-updated-plan33-c1195cb.jpg`. Dismissed with OK; dialog gone, full heatmap + inspector restored, no orphan window. Dedicated Quirk-2 proof (fresh plan18-gui open) still to do.

### QAB-3 (.pzfx date-X drops dates) — PASS on c1195cb (~14:52 PT)
- Imported `x_date.pzfx` (~/Desktop copy) via File → Import Prism File… into the plan33-proof window. Picker: a single row click selected the file this take (take 7's row-click failure didn't reproduce); Open enabled. Import raised the save prompt (plan33-proof dirty from QAB-1) → Don't Save → import replaced the window's project with 'x_date' (on-disk plan33-proof.hlx untouched).
- Import alert (in-app sheet): "Prism File Imported — Imported 1 table from "x_date": • Sample Data. Notes: • "Sample Data": the X values are dates; the dates were kept as row titles. Save the project to keep it as a Helix project."
- Table "Sample Data", XY — columns Title / Date X / Observation / Y2–Y7, 50 data rows. Values exactly the pinned ones: row 1 "16-Jan-2004" / "0" / "120"; row 2 "9-Apr-2009" / "5.22929500342231" / "64"; row 3 "1-Mar-2012" / "8.12320328542094" / "46"; last row 50 "17-Oct-2018" / "14.7515400410678" / "87"; rows 51+ empty. Dates are the Title column (row titles); Date X holds the numeric values.
- Screenshots: `qab3-date-x-first-rows-c1195cb.jpg`, `qab3-date-x-last-row-c1195cb.jpg`.
- Note: the focused "Date X, row 1" cell editor reports value='' in the AX tree while the grid visibly shows 0 — same AX quirk as M10; the visual grid is authoritative.

## Take 9 — Nov 12 afternoon (~15:00 PT)

### Arrival state
- Take 8 (480446af) died ~14:57 PT in a daemon restart after completing QAB-1 PASS, QAB-3 PASS, and Quirk-2 supporting evidence on c1195cb (all recorded above with screenshots). Nothing was written to the proof file by take 8 itself beyond those sections; the QAB-4 + Quirk-2 dedicated proofs on c1195cb are still open.
- Gateway online (last_seen 14:57 PT). Helix PID 38337 (c1195cb, since 14:28 PT, binary md5 39e8d63c…) running; caffeinate 4249/4263 alive. Mac repo at c1195cb. Origin at 6fe68c7 (F-02+M1+M10+B3+M2+M8) — merged-suite check on 6fe68c7 still QUEUED at last check; per brief, no rebuild from 6fe68c7 until it passes or the coordinator says so.
- Resumed in the x_date window (16210, take 7's restored session window: Sample Data + Table 1 with its cd327b8 chi-square analysis). Created a fresh **Table 2 Contingency** and typed the pinned 2×2 (Drug 15/5, Placebo 6/14), all Tab-committed; screenshot-verified the grid before running the analysis.

### QAB-4 (2×2 chi-square) — HUNG on first R eval in the c1195cb session, relaunching to test
- Triggered Analysis → "Chi-Square or Fisher's Exact Test" on Table 2 (~15:01 PT). Result sheet shows "Running..." and never completes: still running after ~2 min of waiting (8s + 10s + 10s + 20s + 30s waits), Escape does nothing, no cancel affordance exists in this build (that's B1, the Round 2 hang blocker, not yet fixed here).
- The process is idle, not slow: Helix PID 38337 at **0.0% CPU**, 0:15.80 total CPU over 35 min elapsed. webR runs in-process, so a computing eval would show CPU — this one is wedged waiting (likely the first-eval engine/package load never resolving; no timeout exists to bound it).
- This is the FIRST R-backed analysis in the c1195cb app session (relaunched 14:28 PT; takes 7/8 ran GUI-only proofs). Take 7 proved QAB-4 on cd327b8 in the prior session (PID 5509), so the engine worked there. The c1195cb delta (F-02/M1/M10) doesn't touch the R bridge — M1 touches stats-engine parsing only.
- Next step: quit + relaunch Helix via the device route (same binary, no reinstall) and redo QAB-4 from scratch. If it completes in the fresh session, the hang was session/transient; if it hangs again, that's a c1195cb first-eval regression and a launch-blocking finding. Table 2 is unsaved test data — discarded on quit, recreated after relaunch; on-disk fixtures untouched.

### Relaunch + Quirk-2 dedicated proof — PASS (~15:04–15:06 PT, tip c1195cb)
- Quit via device-route Cmd+Q: one save sheet (the x_date window, dirty with Table 2) → Don't Save. Helix exited (PID 38337 gone); fixtures on disk untouched (plan33-proof.hlx / plan18-gui.hlx still dated Nov 11 11:08). Relaunch via device-route open_app: **new PID 46055, started 15:04:27 PT, binary md5 39e8d63c… — c1195cb confirmed.** 13 windows restored (the unsaved x_date window is gone, as expected).
- Fresh open of `plan33-proof.hlx` (via `open` from SSH, new window 16349): the **"Project Updated" notice appeared as an in-app dialog** centred over the heatmap (title "Project Updated", text "This project was made with an older Helix, or part of it couldn't be read as it was. Helix brought it up to date; save it to keep the update.", OK button) — part of the window's own AX tree, no separate native window. Screenshot: `quirk2-project-updated-plan33-fresh-c1195cb.jpg`.
- Clicked OK: dialog gone, full heatmap + inspector restored (Day 1: 11/14, Day 2: 13/18/10, Day 3: 15/16, Day 4: 27/12; MATCH "Choose…" present). Window count after dismissal: 14 project windows + the known transient 66×20 "Window" (16350, pre-existing artifact — appears on interaction, not a dialog orphan). No lingering dialog window.
- Clicks work after dismissal: clicked "Volcano (A vs B)" in the sidebar and the view switched (Volcano Plot, Fold change / −log10 P, threshold lines). **Quirk-2 PASS on c1195cb (dedicated fresh-open proof).** This also re-proves on c1195cb what take 7 proved on cd327b8 (plan18-gui) and take 8 saw in the restored session.

### QAB-4 (2×2 chi-square) — PASS on relaunch (~15:07 PT, tip c1195cb)
- Redid the proof from scratch in the fresh session (PID 46055): new Contingency "Table 1" in plan33-proof, typed the pinned 2×2 (Drug 15/5, Placebo 6/14, all Tab-committed), Analysis → "Chi-Square or Fisher's Exact Test". **The analysis completed immediately — no "Running..." wait at all.**
- Result sheet "Chi-square or Fisher's exact test" shows exactly the pinned values: **P value (Fisher's exact test) 0.01039** (pinned 0.0103867), **Chi-square (for reference) 8.12** (pinned 8.1203 — the UNCORRECTED Pearson statistic, Prism's default), **df 1**, Odds ratio 6.615, "Fisher's exact test", "Significant *", "Contingency table 2×2, N = 40". The empty Outcome C–H columns are correctly ignored.
- Screenshot: `qab4-chi-square-8-120-c1195cb.jpg`.
- **Hang verdict: TRANSIENT, not a c1195cb regression.** The first R eval in the old session (PID 38337) hung ~2 min at 0% CPU with no interrupt; the identical analysis in the fresh session (PID 46055, same binary) completed instantly. The wedged eval died with the old process. Worth noting for B1 (the Round 2 hang blocker): a stuck first eval had no timeout/interrupt to bound it — the only recovery was quitting the app. If it recurs, it belongs to B1/M15/M17 territory.

## Take 9 — status after the proofs (~15:08 PT)
- **All four Round 1 fixes now Mac-proven on c1195cb: QAB-1 PASS (take 8), QAB-3 PASS (take 8), QAB-4 PASS (this take, after relaunch), Quirk-2 PASS (this take, dedicated fresh-open proof).** Plus F-02 + M10 PASS (take 7) and M1 via Mac npm test (673 green) on the same tip. Round 1 + Round 2 tip c1195cb Mac proof is complete.
- Installed build: c1195cb (PID 46055, since 15:04:27 PT, binary md5 39e8d63c…). Polling for the next Round 2 tip next, per brief (origin 6fe68c7 at last check; merged-suite check on it was QUEUED — no rebuild until it passes or the coordinator says so).

## Take 9 — Round 2 tip poll (~15:10 PT): tip moved to c9ae7d4, merged suite still queued
- Origin `feat/prism-import-survival` moved 6fe68c7 → **c9ae7d4** (B2 merge: fix/r2-b2 1f27a96, "Hung install batch permanently poisons the install chain", webr.ts +190 / packages.ts +73; branch verification full-green 161+364+154 = 679 on-branch, GUI smoke PASS). Origin HEAD now c9ae7d4 (F-02+M1+M10+B3+M2+M8+B2).
- Merged-suite verification on c9ae7d4 is **still QUEUED** (runs when the box quiets) — per brief, no rebuild until it passes or the coordinator says so. B2 note: B1 also touches webr.ts, so B1's merge will need conflict resolution against B2's rework.
- B2 side note from the coordinator log: cold lme4+lmerTest install measured 213.6s (232.8s second probe) on BASE code vs the 120s install budget — pre-existing, not a B2 regression; B2's fix makes the retry succeed (89.5s). Raising the budget is a scope decision, out of this round.
- Polling continues (~15 min cycle): on a merged-suite PASS for the current tip, reset Mac repo → npm test → DMG build → install via stash-first swap → GUI-prove the new tip's fixes (B2's install-chain fix is engine-side; Mac verification is the npm test + a GUI smoke of an install-heavy flow if one is pinned).

## Take 10 — Nov 12 afternoon (~15:32 PT)

### Arrival state
- Container replaced ~15:23 PT (uptime 9 min at 15:32 PT; /root/.ssh/config present, rebuilt 23:24 UTC by the sanity check — ProxyCommand verified via `ssh -G macbook`). No rebuild of the mirror needed this take.
- Origin `feat/prism-import-survival` moved c9ae7d4 → **d3c1ea5** (M18 merge, coordinator 15:28 PT: fix/r2-m18 890d10e, clean auto-merge of wizards.ts + checks.ts, pushed, ls-remote confirmed). Tip now d3c1ea5 = F-02+M1+M10+B3+M2+M8+B2+M18.
- **Merged-suite verification for the d3c1ea5 tree still QUEUED** (TRACKING.md row 16 + coordinator log ~15:28 PT) — per brief, no rebuild until it passes or the coordinator says so. (B4 fix/r2-b4 9104de1 committed + pushed pre-swap; trio M5/M6/M7 commits 318f4cf/86619ac/c69e60b exist but branch NOT pushed — neither is in the tip yet.)
- Mac via SSH: Helix PID 46055 (c1195cb, since 15:04:27 PT, binary md5 39e8d63c…) still running. Gateway: "Smit's MacBook Air" **online**, last_seen 23:23:43 UTC (15:23:43 PT) — device route available.
- Note: the shared Hatch checkout `~/workspace/helix` HEAD is already d3c1ea5 but has uncommitted modifications + a UU conflict in tests/checks.ts (coordinator/merge activity in the shared checkout — not mine to touch; Mac proof uses the Mac repo, not this checkout).
- Polling: waiting for the d3c1ea5 merged-suite verdict. Next poll ~15:47 PT.

---
### PROCESS CHANGE — batch Mac proofs (Smit, ~15:38 PT)
- No more per-tip Mac proofs. Take 10's 6c7d350 proof IS the current batch's proof (covers B3, M2, M8, B2, M18, B1 + the c1195cb fixes). Finish it as-is.
- When the 6c7d350 batch proof is done, report completion and STOP — do NOT poll for the next tip. The next Mac proof waits for the next batch threshold (4–5 merges or 2h) and the coordinator spawns a fresh lane for it.
- If the batch proof fails on a fix, report exactly which fix and how — bisect on Linux first; do not fall back to per-fix proofs.
- Full rule: `~/workspace/helix-vault/Decisions/2026-11-12 Batch Mac proofs; merged suite per batch tip.md`.

## Take 11 — Nov 12 afternoon (~15:54 PT) — Batch 1 proof (tip 6c7d350)

### Arrival state
- Take 10 (70990980) died ~15:50 PT in a daemon restart; it only did arrival checks and wrote its arrival state — NO build or proof work on the batch tip. Resuming from this file.
- Batch 1 = through **6c7d350** (B1 merge, 9th fix). Covers B3, M2, M8, B2, M18, B1 + the c1195cb fixes (F-02, M1, M10). Origin has since moved to 9c4cbcd — that is Batch 2 territory, NOT this proof.
- Container: uptime 31 min at 15:54 PT (replaced ~15:23 PT); /root/.ssh/config present (ProxyCommand verified via `ssh -G macbook`). No mirror rebuild needed.
- Merged-suite agent on 6c7d350 (d3066302, parent-spawned ~15:40 PT) is RUNNING (last activity ~1 min ago at check). Worktree ~/workspace/helix-merged-suite-6c7d350 checked out 15:40 PT, node_modules 15:43, webr-repo 15:44 — suite in progress, no verdict yet. Per brief: WAIT for its PASS before building the DMG; do NOT run the merged suite myself.
- Mac via SSH: Helix PID 46055 (c1195cb, since 15:04:27 PT, binary md5 39e8d63c…) still running; Mac repo at c1195cb. Installed build unchanged — do NOT reinstall until the batch DMG is built.
- Waiting on the merged-suite verdict. Next poll ~16:09 PT.

### Merged-suite progress (~16:14 PT)
- Suite agent d3066302 still running (leg 2 reference tests in flight, started ~16:02 PT). Leg 1 (checks) already GREEN: "All 170 checks pass" (leg1-checks.log, 23:59 UTC) — 164 at c1195cb + 6 new checks in the batch. Leg 2 log shows only benign R warnings ("cannot compute exact p-value with ties").
- Note: two earlier poll scripts exited on false positives (word "fails" in B1 prose; "MERGED-SUITE VERIFIED GREEN" on c1195cb rows). No 6c7d350 verdict exists yet; the watcher now requires the exact phrase on a 6c7d350 line. Still waiting — no DMG build until the PASS lands.

### Merged-suite progress (~16:22 PT)
- Leg 1 (checks) GREEN: "All 170 checks pass" (was 164 at c1195cb). Leg 2 (reference) GREEN: "All 366 results match" (was 365 at c1195cb). Leg 3 (packages) running since ~16:16 PT — "cold start: survival ready in 45.6s"; MethComp repo warnings are the known benign ones from the c1195cb run. Watching the leg3 process (PID 48054) for completion; cargo/build/GUI legs follow.
- (Fourth false-positive note: the B1 TRACKING.md row contains "merged-suite … failed" only via its apt-get caveat sentence — prose greps on that row are unreliable; leg logs + agent status are the signal now.)

### Merged-suite progress (~16:28 PT)
- Leg 3 (packages) GREEN: "All 154 package checks pass" (144 at c1195cb + 10). Merged-suite tally so far: checks 170/170, reference 366/366, packages 154/154 — total 690. Cargo check running since ~16:23 PT (PID 51223). Linux release build + Xvfb GUI proof still to come, then the agent's verdict.

### Merged-suite progress (~16:34 PT)
- Cargo check GREEN: "Finished `dev` profile … in 10m 06s". Suite tally: checks 170/170, reference 366/366, packages 154/154, cargo check clean. Suite agent d3066302 still running (54 min in, active seconds ago) — between steps; Linux release build + Xvfb GUI proof still to come. Watching the worktree for the build log / release binary / GUI screenshots.

## Take 11 — Batch 1 proof (tip 6c7d350) — merged-suite PASS, Mac build starting (~16:43 PT)

### Merged-suite verdict: FULLY GREEN (~16:33 PT)
- Suite agent d3066302's final report (session jsonl, 00:33:49 UTC — the subagent.list `completed_at` 23:49:58 UTC is stale, a daemon-restart artifact; the agent survived the restart and finished at 00:33 UTC): worktree ~/workspace/helix-merged-suite-6c7d350, detached HEAD 6c7d350, clean.
- Legs (each independently confirmed from the logs by this take): `npm run check` CLEAN; checks **170/170**; reference **366/366**; packages **154/154** — total **690** (669 → 673 → 679 → 690 across the batch). `cargo check` PASS (10m06s). No failures, no retries needed. Packages leg passed first try (B2's 360s budget in effect; "survival ready in 45.6s"); MethComp repo warning pre-existing, non-fatal. First `npm run check` attempt was killed by a runtime restart and re-run clean.
- Flag flipped: `suite-6c7d350-done` created in ~/workspace/.helix-fix2-coord/, `-running` removed; result appended to investigations.md. TRACKING.md still shows the B1 row as "QUEUED" (stale — the agent did not update TRACKING.md; the verdict lives in its report + the flag + the logs).
- **Gate for the Mac build is OPEN: proceeding to reset the Mac repo to 6c7d350 → Mac npm test → DMG build → install → full QAB proof.**

### Mac npm test on 6c7d350: GREEN (~16:52 PT)
- Mac repo reset to 6c7d350 (fetch + reset --hard; log shows 6c7d350 / 931f8ff / d3c1ea5). Note: the first npm test launch failed — `npm`/`node` are at /opt/homebrew/bin, which non-interactive SSH never gets from ~/.zprofile (`brew shellenv`); relaunched with PATH=/opt/homebrew/bin exported (PID 49272).
- **Mac npm test GREEN: checks 170/170, reference 366/366, packages 154/154 (total 690)** — identical counts to the merged-suite run. Only benign R/webR warnings (MethComp repo "Download failed", ties). Log /tmp/npm-test-6c7d350.log on the Mac.
- This is also the Mac verification for B2 (P-12 install-chain checks in the packages leg) and M1/M2/M8/B1/B3/M18 (their checks run in this suite).
- DMG build starting next.

### DMG build on 6c7d350 (~16:59 PT)
- Build launched via scripts/build-mac-dmg.sh (both archs), nohup PID 49541, log /tmp/build-dmg-6c7d350.log. Frontend built (2.79s); Rust compile in progress.
- Fixtures copied from Hatch to ~/helix/qa/ on the Mac (qa/fix-r2-*/ are untracked scratch, not in the repo): b3-one-y.hlx (362 B), m8-morrison.hlx, m8-bare-string-y.hlx, m2-gui.hlx (6,304 B), m18-correlation-x1y.hlx, m18-roc-only-numeric.hlx. textbook-4pl.hlx + x_date_row_titles.pzfx already on the Mac.

### DMG build on 6c7d350: DONE (~17:00 PT)
- Build script finished both archs (log /tmp/build-dmg-6c7d350.log). The script's 1.0.6-named DMGs are the install source (Tauri also leaves 1.0.7-named DMGs from the same build — same .app inside):
  - arm64: `Helix_1.0.6_aarch64.dmg`, 102,291,091 B (c1195cb was 102,289,515 B)
  - x64: `Helix_1.0.6_x64.dmg`, 103,042,291 B, sha256 `a2fb05772f7aa6ab259bb99f4a71a502e07005bff59ca69aac91281a99e22fb6`
- (Watcher died in a runtime restart ~17:23 PT; build state recovered from disk + log. No build work was lost — both DMGs were complete at 17:00 PT.)

### Install + relaunch on 6c7d350 (~17:27 PT)
- DMG hashes: arm64 `Helix_1.0.6_aarch64.dmg` 102,291,091 B sha256 `5fc1021501e974a151c1ae3c65ff545248bc72f50bf144775ab9b6e51ec2f760`; x64 103,042,291 B sha256 `a2fb05772f7aa6ab259bb99f4a71a502e07005bff59ca69aac91281a99e22fb6`.
- Install: mounted arm64 DMG, copied Helix.app to /tmp, detached, stashed the old build as `/Applications/Helix.app.old-c1195cb` FIRST, swapped in the new build, `codesign --verify --deep --strict` → **OK**. New binary md5 `6c3001e59f0c9468c6c56ee377462ce0` (c1195cb live binary was `39e8d63c…`).
- Quit old build (PID 46055, c1195cb) via device-route Cmd+Q: one save sheet (plan33-proof, dirty with take 9's QAB-4 test data) → Don't Save. On-disk fixtures untouched (textbook-4pl.hlx mtime still 14:29 Nov 12).
- Relaunch via device route open_app: **new PID 51564, started 17:27:29 PT, binary md5 6c3001e5… — 6c7d350 confirmed running.** Session restored (plan33-proof window 16400 + the restored set); "Project Updated" in-app dialog showing on plan33-proof (migration never saved — expected).

### F-02 (Logistic Curve empty for non-binary Y) — PASS, re-confirmed on 6c7d350 (~17:32 PT)
- Fixture textbook-4pl.hlx opened in the new build (window 16421); 4PL fit sheet confirms it (Bottom −1.351, Top 101.4, EC50 1, HillSlope 0.7766, R² 0.9993). Graph menu → "Logistic Curve".
- **All 9 points visible** in the sigmoid pattern — (−2,2), (−1.5,5), (−1,12), (−0.5,30), (0,50), (0.5,70), (1,88), (1.5,95), (2,98). (The (0,50) point sits under the device-route pointer badge, as in take 7.)
- **Y axis autoranged 0–100** (ticks 0/20/40/60/80/100), X −2..2. **On-graph note: "Logistic curve needs a 0/1 outcome — the Y values are not all 0 or 1, so no fitted curve is drawn." No fitted curve drawn** (correct).
- Screenshot: `qa/f02-logistic-curve-6c7d350-pass.jpg`.

### R2-M10 (.pzfx date-X with row titles drops the dates) — PASS, re-confirmed on 6c7d350 (~17:47 PT)
- Imported `x_date_row_titles.pzfx` (~/Desktop copy) via File → Import Prism File… into the textbook-4pl window. Picker: the native open panel does NOT take background input on its file list (single-click on the filename, Cmd+Shift+G, and the Open button while disabled all no-op; Open is disabled until a real selection exists). Working method (same class as take 7): clicking a row's DATE cell selects the row ABOVE it — clicking the Nov 9 date cell selected `x_date_row_titles.pzfx`. (Take 7's click selected the first row the same way.)
- Save-prompt detour: import raised "Do you want to save the changes…" (textbook-4pl dirty from the F-02 graph) → Don't Save → import replaced the window's project (window retitled 'x_date_row_titles'; on-disk textbook-4pl.hlx untouched, mtime still 14:29).
- Import alert "Prism File Imported": "Imported 1 table from "x_date_row_titles": • Sample Data. Notes: • "Sample Data": the X values are dates; the existing row titles were kept and the dates were kept in a "Date X (date)" column."
- Imported table "Sample Data", XY — columns **Title / Date X / Date X (date) / Observation** (+ empty Y3–Y7), 5 rows, all exactly the pinned values: Sample A / 0 / 16-Jan-2004 / 120; Sample B / 5.22929500342231 / 9-Apr-2009 / 64; Sample C / 8.12320328542094 / 1-Mar-2012 / 46; Sample D / 8.23819301848049 / 12-Apr-2012 / 51; Sample E / 8.27652292950034 / 26-Apr-2012 / 52. Rows 6+ empty.
- Screenshot: `qa/m10-date-x-row-titles-6c7d350-pass.jpg`. (AX quirk as before: focused "Date X, row 1" editor reports value='' while the grid visibly shows 0 — visual grid authoritative.)
- Note: a device-service restart mid-proof closed computer session cc-11; resumed on cc-13. SSH also flaked once (egress proxy reset, take 7's ~14:15 pattern) — recovered on retry.

### R2-B3 (Enzyme-inhibition wizard dead-end, X + 1 Y) — PASS on 6c7d350 (~18:00 PT)
- Fixture `b3-one-y.hlx` opened in the new build (window 16493; "Project Updated" dialog dismissed). Analysis → "Enzyme Kinetics — Inhibition".
- **Model question — PASS:** "Which inhibition model should be fitted? Global models need at least two Y data sets — with one Y data set, only Morrison Ki (tight binding) can be fitted." Only option offered: **Morrison Ki (tight binding)** (checked), Next enabled. The pre-fix dead-end (a global model whose Y question needed min 2 from one option) is gone.
- **Y question — PASS:** "Which Y data sets should be fitted? Each is one inhibitor concentration." Y1 checked, Next enabled.
- **Walk to Run — PASS:** Et question ("Total enzyme concentration (Et), in the same units as [I].") → typed 5; [S] question left blank; Km question left blank; final step shows **Run** enabled.
- **Run end-to-end — PASS:** analysis node "Enzyme kinetics — Inhibition" created in the sidebar; the run completes with the clean expected message: "This curve ("Morrison Ki (tight binding)") could not be fitted to these data (Convergence failure: false convergence (8)). Try another model or Y data set." — expected: the fixture data are arbitrary decreasing values, not real inhibition data. No hang, no crash. A **Retry** button is present on the error state (B1's control).
- Screenshots: `qa/b3-wizard-run-6c7d350-pass.jpg` (Km step, Run enabled), `qa/b3-fit-result-6c7d350-pass.jpg` (error state + Retry).

### B1 Retry smoke (on the B3 error state) — inconclusive visually, engine-level check green
- Clicked Retry on the B3 error state 3×; at 0s, 1s, and 6s after the clicks the view shows the identical deterministic error message with the Retry button still present — no "Running…" flash caught. The eval is sub-second on the warm engine (the original B3 run also completed within one receipt round-trip), so a real re-run and a cached replay look identical here; this smoke test alone cannot distinguish them.
- The distinguishing evidence is the Mac npm test on this tip (170/170 green), which includes B1's regression check "a failed analysis is not cached: fixing the data and re-running works" — the cache-eviction fix is verified at engine level. The decisive GUI proof (Cancel during a cold R boot + Retry re-running for real + engine healthy after) is planned at the end of this take via a relaunch + M2 cold fit.

### R2-M8 (Enzyme-inhibition y as bare string bricks analysis) — PASS on 6c7d350 (~18:09 PT)
- Fixture `m8-morrison.hlx` opened in the new build (window 16521; "Project Updated" dialog dismissed). The fixture carries a pre-built analysis node ("Morrison Ki (bare-string y)", model morrison, y:"Total", Et=5) and NO stored results — the results shown were computed live on open. Pre-fix, the bare-string y threw TypeError "requested.find is not a function" (global-fit path + runMorrison); the fix normalizes y to [y].
- **Full Morrison Ki fit, exactly the pinned values: v0 = 100 (95% CI 100 to 100), Kiapp = 2 (95% CI 2 to 2), Et = 5, R² = 1, Sy.x = 2.233e-11, DF = 5, N = 7.** Equation: Y = 100·(1 − ((Et + X + 2) − √((Et + X + 2)² − 4·Et·X))/(2·Et)), Et = 5. No error, no phantom {}.
- Screenshot: `qa/m8-morrison-bare-string-y-6c7d350-pass.jpg` (pointer badge covers part of the P-value column; values verified in the AX tree).

### R2-M2 (Kon start Inf when median pre-t0 time is 0) — PASS on 6c7d350 (~18:17 PT)
- Fixture `m2-gui.hlx` opened in the new build (window 16527; no "Project Updated" dialog this time). The pre-built "Association then dissociation (zero median)" analysis (XY [0,0,2,12,20,30], Time0=10, pre-Time0 median 0, HotNM=1) re-ran live on open.
- **Fit succeeds on zero-median data — PASS: Kinetic Kd (nM) = 1, Eq = 50, R² = 1, Sy.x = 4.078e-12, Sum of squares = 3.325e-23, DF = 2, N = 6. Coefficients: Kon = 100000000, Koff = 0.1, Bmax = 100, NS = 0.5 — exact ground truth.** Pre-fix, nls got a non-finite Kon start and the fit failed outright.
- **Finite Kon start named in the notes — PASS:** "Binding kinetics fit ("Association then dissociation") of "Y" on "X" (time). Starting values: Kon = 329900000, Koff = 0.01667, Bmax = 35.9, NS = 0.5. HotNM = 1 nM and Time0 = 10 are constrained const…" (median floored at the smallest positive pre-Time0 time, 2).
- **Fitted curve renders — PASS:** "Zero-median curve" graph shows the rise to ~43 at t = 10 then exponential decay, annotated "Kon = 100000000, Koff = 0.1, Kinetic Kd = 1 nM, R² = 1".
- Screenshots: `qa/m2-binding-fit-6c7d350-pass.jpg`, `qa/m2-zero-median-curve-6c7d350-pass.jpg`.

### BLOCKED — Mac gateway offline (~18:04 PT)
- After M2 PASS (~18:17 PT per file order — see timestamps), `m18-roc-only-numeric.hlx` was opened on the Mac via SSH (window 16533 created, PID 51564), but the device route then reported `node_offline` on the next invoke: "Smit's MacBook Air" (5aec44c8-cdbd-caec-7447-1bbf6968c5e7) offline, last seen 2026-11-13T02:03:54Z. Known pattern: the Mac sleeps on idle even with lid open + charger; the `helix-mac-alive` hook polls every 5 min and may wake it.
- Remaining in this take: **M18** (ROC zero-options + Back; correlation X+1Y), **B1** (Cancel during a cold R boot + Retry re-runs for real + engine healthy after), **B2** (engine-side, already covered by the Mac npm test packages leg + merged suite — no GUI step needed unless an install-heavy flow is quick).
- State on the Mac at loss of contact: 6c7d350 build running (PID 51564); windows open include m18-roc-only-numeric (16533), m2-gui (16527), m8-morrison (16521), b3-one-y (16493, B3 error state + Retry), x_date_row_titles (16421, M10 state), textbook-4pl/plan33-proof and the plan*-gui set. No unsaved work is at risk — all proof fixtures were opened read-only in-memory (Don't Save on dialogs; on-disk fixtures untouched).
- Polling for the gateway to come back; will resume with M18 on the already-open ROC window (16533).

### Gateway still down at poll 1 (~18:12 PT)
- device.list 02:11Z: "Smit's MacBook Air" still offline, last seen 02:03:54Z (unchanged). The iPhone also dropped (last seen 02:06:43Z) — both Apple devices within minutes, pointing at a service-side gateway issue rather than the Mac.
- Via SSH the Mac is awake: Muse.app running (PID 72062), Helix PID 51564 alive, `pmset` shows sleep prevented by caffeinate + powerd and display sleep prevented by caffeinate + Muse. No restart of the Muse app from here (out of scope; would disrupt Smit's session). Continuing to poll on the 5-min cadence.

### Gateway recovered (~18:23 PT)
- device.list 02:23Z: "Smit's MacBook Air" ONLINE again (last seen 02:23:33Z) after ~20 min offline (last seen 02:03:54Z). iPhone flapped (online 02:17Z, offline again by 02:23Z) — service-side flapping, Mac route now usable. Helix PID 51564 + Muse.app PID 72062 both alive throughout (verified via SSH at 18:18 PT). Resuming M18 on the already-open ROC window (16533).

### R2-M18 (Choice question with zero options throws TypeError) — ROC path PASS on 6c7d350 (~18:30 PT)
- Fixture `m18-roc-only-numeric.hlx` (Column table, only numeric column Score 1–5), window 16533. Analysis → ROC Curve.
- **Step 1 truth — PASS:** "Which column holds the known outcome (e.g. diseased / healthy)?" — only option Score (checked), Next enabled as a real button.
- **Step 2 score, zero options — PASS:** no throw; the wizard shows the emptyMessage "The truth column is the table's only numeric column, so no column is left to hold the test score. Go back and choose a text column as the truth, or add another numeric column." Next is NOT an enabled control (AX tree lists it as OCR text only, not a button) — blocked as designed. Cancel + Back present.
- **Back navigation — PASS:** Back returns to step 1, truth question intact, Score still checked, Next a real button again. No crash, no stale state.
- Screenshot: `qa/m18-roc-empty-score-6c7d350-pass.jpg` (step-2 empty state; Next visually blue but AX-disabled — the AX tree is authoritative here).
- **Gateway dropped AGAIN ~18:30 PT** (node_offline on the observe right after the Cancel click; the click itself returned "aborted" — unknown whether Cancel landed). The ROC window's wizard state is unverified until the gateway returns. Remaining: M18 correlation path (+ binding-saturation if smooth), B1 cold-boot Cancel + Retry.

### R2-M18 — correlation path PASS on 6c7d350 (~18:44 PT)
- Fixture `m18-correlation-x1y.hlx` (XY, X + 1 Y: Y1 = 1.1, 2.9, 5.2, 7.0, 9.3), window 16569. Analysis → New Analysis… → Correlation.
- **Step 1 method — PASS:** "Which correlation coefficient should be computed?" Pearson (checked) / Spearman, Next enabled. No throw.
- **Step 2 mode — PASS:** "What do you want to correlate?" offers ONLY "X against every Y data set" (checked) and "Correlation matrix among the Y data sets" — **"Two chosen data sets" is hidden** with 1 Y, as the fix specifies. Run enabled.
- **Run end-to-end — PASS:** Pearson correlation completes: Y1 r = 0.9991, P < 0.0001 (****); analysis node "Correlation" created.
- Screenshot: `qa/m18-correlation-run-6c7d350-pass.jpg`.

### R2-M18 — binding-saturation path PASS on 6c7d350 (~18:50 PT)
- Same fixture `m18-correlation-x1y.hlx` (1 Y), window 16569. Analysis → New Analysis… → Binding — Saturation.
- **Step 1 Y — PASS:** "Which Y data set is the total binding?" Y1 checked, Next enabled.
- **Step 2 model — PASS:** "Which saturation model should be fitted?" offers ONLY "One site — Total binding" (checked) and "Two sites — Specific binding" — **two-series models (needing a second Y) are hidden** with 1 Y, as the fix specifies. Run enabled. Back returns to step 1 intact; Cancel closes the wizard cleanly.
- **M18 COMPLETE on the Mac: all 3 Linux paths confirmed (ROC zero-options + Back, correlation hides "Two chosen data sets", binding-saturation hides two-series models). No TypeError anywhere.**

### R2-B1 (No timeout or interrupt on any R evaluation) — PASS on 6c7d350 (~19:00 PT)
- Vehicle: Monte Carlo Simulation (Linear regression slope, Y from the m2-gui table, mean 12.7727, SD 13.4767, **10,000 repeats**, seed 42) in the freshly relaunched build (PID 60153, cold R engine — the M2 analyses had already re-fit to exact ground truth on this cold engine: Kd=1, Eq=50, R²=1, Kon=100000000, Koff=0.1, Bmax=100, NS=0.5).
- **Running state + Cancel — PASS:** after Run, the view shows "Running… 0:00" ticking up (0:08, 0:09, 0:49, 2:03 observed) with a **Cancel** button present throughout. Screenshot: `qa/b1-running-cancel-6c7d350-pass.jpg` (Running… 0:08 + Cancel).
- **Cancel works — PASS:** Cancel clicked at ~0:09 → "Could not run the test: The calculation was cancelled." + **Retry** button. The run stops promptly (no hang, no zombie eval).
- **Retry re-runs for real — PASS:** Retry restarts the eval from "Running… 0:00" (not a cached replay of the cancelled outcome) and runs to completion in ~3.5 min (10,000 repeats; the wizard's "~15–25 seconds" hint understates the Mac webR cost — noted, not a defect).
- **Engine healthy after cancel — PASS:** the retried run completes with the full result: Repeats completed 10000, Mean of Slope 0.004318, SD of Slope 0.4901, 2.5th percentile −0.9573, 97.5th percentile 0.9625, Observed (real data) 0.2168, Seed 42. Screenshot: `qa/b1-monte-carlo-retry-complete-6c7d350-pass.jpg`.
- Note: the earlier B3-error-state Retry smoke (3 clicks, no Running flash caught) is superseded by this decisive test — the sub-second B3 eval simply completes faster than the observation cadence. No eval anywhere in this take timed out or hung; the 300s watchdog never needed to fire.
- **B1 COMPLETE.**

### R2-B2 (Hung install batch poisons chain) — COVERED, engine-side, no GUI step
- B2 is engine-side (PACKAGE_INSTALL_TIMEOUT_MS 120→360s). Covered by the Mac npm test on this tip (packages leg **154/154**, incl. the P-12 install-chain checks; "survival ready in 45.6s" first try) and the merged suite on 6c7d350 (packages 154/154). No install-heavy GUI flow was needed; no separate GUI verdict.

## BATCH 1 COMPLETE — 6c7d350 Mac proof, all fixes PASS (~19:02 PT, Thu Nov 12, 2026)
- **Build:** 6c7d350, DMG-built + installed via stash-first swap; binary md5 `6c3001e59f0c9468c6c56ee377462ce0`. arm64 DMG sha256 `5fc1021501e974a151c1ae3c65ff545248bc72f50bf144775ab9b6e51ec2f760`; x64 `a2fb05772f7aa6ab259bb99f4a71a502e07005bff59ca69aac91281a99e22fb6`. Running now as PID 60153 (third launch of the take; PIDs 51564 → 59283 → 60153, all the same 6c7d350 binary).
- **Merged suite on 6c7d350:** FULLY GREEN — checks 170/170, reference 366/366, packages 154/154 (total 690), `npm run check` clean, `cargo check` PASS. **Mac npm test on 6c7d350:** GREEN, identical 690.
- **GUI verdicts (this take, all on 6c7d350):**
  - F-02 PASS (logistic curve, no fitted curve for non-0/1 Y; note shown).
  - M10 PASS (date-X + row titles import, 5 rows pinned exactly).
  - M1 covered by Mac npm test (same as take 7).
  - B3 PASS (wizard walk to Run; expected "false convergence (8)" message; analysis node created).
  - M8 PASS (Morrison Ki bare-string y: v0=100, Kiapp=2, Et=5, R²=1).
  - M2 PASS (zero-median Kon start finite 329900000; fit Kd=1, Eq=50, R²=1, Kon=100000000, Koff=0.1, Bmax=100, NS=0.5; curve renders).
  - M18 PASS (3/3 Linux paths: ROC zero-options + Back; correlation hides "Two chosen data sets"; binding-saturation hides two-series models with 1 Y).
  - B1 PASS (Running… timer + Cancel; Cancel → "(The calculation was cancelled.)" + Retry; Retry re-runs for real and completes 10,000-repeat Monte Carlo; engine healthy after cancel; cold engine re-fits M2 to ground truth).
  - B2 COVERED engine-side (Mac npm test packages 154/154 incl. P-12; merged suite packages 154/154). No GUI step.
- **QAB-1/3/4 + Quirk-2:** proven on c1195cb in earlier takes; not re-run on 6c7d350 (brief required F-02/M1/M10 re-confirmation, done).
- **Gateway:** two device-route outages this take (~18:04–18:23 PT, ~20 min; ~18:30–18:37 PT, ~7 min) — service-side flapping (iPhone dropped in the same windows). Mac itself stayed awake throughout (SSH + Helix alive); no Muse-app restart attempted (out of scope). Recovered on its own both times.
- **Fixtures:** all on-disk fixtures untouched (mtimes verified 19:02 PT: b3/m2/m8/m18 files at the 16:59 copy time; textbook-4pl.hlx still Nov 12 14:29). All proof work was in-memory; no fixture was saved.
- **Screenshots (qa/):** f02-logistic-curve-6c7d350-pass.jpg, m10-date-x-row-titles-6c7d350-pass.jpg, b3-wizard-run-6c7d350-pass.jpg, b3-fit-result-6c7d350-pass.jpg, m8-morrison-bare-string-y-6c7d350-pass.jpg, m2-binding-fit-6c7d350-pass.jpg, m2-zero-median-curve-6c7d350-pass.jpg, m18-roc-empty-score-6c7d350-pass.jpg, m18-correlation-run-6c7d350-pass.jpg, b1-running-cancel-6c7d350-pass.jpg, b1-monte-carlo-retry-complete-6c7d350-pass.jpg.
- **Batch 1 DONE. No merges/pushes/branch modifications by this take (Mac proof only).** Next Mac proof waits for the next batch threshold; this take stops here per the brief.

## Take 12 — Nov 12 evening (~20:36 PT) — Batch 2 proof (tip e6591d2)

### Arrival state
- Smit confirms the Mac is open and available, no one using it. Parent-spawned take 12 on origin `feat/prism-import-survival` @ **e6591d2**. Batch 2 = **B4, M9, M12** (3 merges since the 6c7d350 proof). M16 is NOT in this batch — if it lands mid-proof it goes in the next batch; this take does not chase it. Coordinator will NOT spawn a duplicate Mac proof (coordinator log 20:36 PT).
- Gateway: "Smit's MacBook Air" **online**, last_seen 04:28:27Z (~20:28 PT). SSH works (Tailscale path). /root/.ssh/config present, ProxyCommand verified.
- Mac repo at **6c7d350** (Batch 1 tip); origin ref on the Mac still at 9c4cbcd (stale — needs fetch). Helix NOT running (Batch 1 PID 60153 gone by 20:36 PT). Caffeinate PIDs 4249 (`-i -s`) + 4263 (`-d`) alive — do NOT start duplicates.
- Note: the Linux merged-suite run on e6591d2 has NOT happened yet — it waits on the M16 cut (4th merge). This take proceeds per the parent's brief; the Mac npm test on e6591d2 is the full-suite evidence on the Mac, and the pending Linux suite verdict is recorded here, not assumed.
- Fixtures to copy from Hatch: `qa/fix-r2-b4/b4-one-y.hlx`, `qa/fix-r2-m9/m9-broken-band.hlx`, `qa/fix-r2-m12/m12-gui.hlx` (all in ~/workspace/helix/qa/ on Hatch).

### Mac repo reset + fixtures + npm test launch (~20:37–20:39 PT)
- Mac repo reset to **e6591d2** (fetch + reset --hard; log: e6591d2 M12 merge / 9c00f28 / 91078ce M9 merge). Fetch also pulled origin/main at 85f6c91 (expected — main merge).
- Fixtures copied to ~/helix/qa/ on the Mac: b4-one-y.hlx (360 B), m9-broken-band.hlx (989 B), m12-gui.hlx (7386 B, md5 `b8aa6382a3ed4693aca255f79ab59afe` — exact match to the M12 NOTES.md pinned md5). webr-repo present on the Mac (no rebuild needed).
- Mac npm test launched ~20:39 PT (PID 66182, PATH=/opt/homebrew/bin, log /tmp/npm-test-e6591d2.log). Early log shows only the benign R "cannot compute exact p-value with ties" warnings. Awaiting completion.

### Mac npm test on e6591d2: GREEN (~20:41 PT)
- Full log read (51 lines, terse runner): `node --import tsx tests/checks.ts && tests/reference.ts && tests/packages.ts` — chained, so all three pass lines mean exit 0.
- **Checks 173/173** (170 at 6c7d350 + B4 + M9 + M12, one new check each), **reference 366/366**, **packages 154/154 — total 693 green.** "cold start: survival ready in 3.1s (budget 360s)" — B2's raised budget in effect. Only the known benign warnings (glm.fit convergence, ties, MethComp repo "Download failed", Emscripten `.tgz` fallback). Fast run (~2 min) because the Mac was warm (webr-repo built, packages cached).
- This is also the Mac verification for B4/M9/M12's checks and for B2's install-chain (packages leg).
- `npm run check` (tsc): CLEAN, exit 0.

### DMG build on e6591d2 (~20:42–20:43 PT)
- Build launched via scripts/build-mac-dmg.sh (both archs), nohup PID 66487, log /tmp/build-dmg-e6591d2.log. Frontend built in 2.72s; Rust compile + bundling took ~2 min total. The script's 1.0.6-named DMGs are the install source (Tauri also leaves 1.0.7-named DMGs from the same build — same .app inside):
  - arm64: `Helix_1.0.6_aarch64.dmg`, 102,292,500 B, sha256 `1d286fbf7ecf19550c9d920e9bffae3ef4b687ea2648a6d7a0d46e092178d01c`
  - x64: `Helix_1.0.6_x64.dmg`, 103,042,691 B, sha256 `2df0eff911ea147a1fb923d1241b3007e98a43062d784356e9e7f9e327f24d31`

### Install + swap on e6591d2 (~20:44 PT)
- Pre-swap verification: installed binary md5 was `6c3001e59f0c9468c6c56ee377462ce0` — exactly the 6c7d350 build. Stash name .old-6c7d350 was free.
- Install: mounted arm64 DMG (/Volumes/Helix), copied Helix.app to /tmp/Helix-e6591d2.app, detached, stashed the old build as `/Applications/Helix.app.old-6c7d350` FIRST, swapped in the new build, `codesign --verify --deep --strict` → **OK**. New binary md5 `e3911b92892977aad0c7c6860756e877` (103,733,488 B) — differs from 6c7d350 as expected.
- Helix was NOT running at install time (Batch 1 PID 60153 gone by 20:36 PT). Relaunch via device route next.

### Relaunch on e6591d2 (~20:45 PT)
- Relaunch via device route (open_app Helix, session cc-1): **new PID 67693, started 20:45:02 PT, binary md5 e3911b92… — e6591d2 confirmed running.** Restored session opened the m2-gui project window (16962); its pre-built M2 analysis re-runs live on open ("Running… 0:00" + Cancel visible) — expected engine behavior, same as take 11.

## Take 14 — Nov 12 evening (~21:08 PT) — Batch 2 GUI proofs (tip e6591d2)

### Arrival state
- Take 13 died ~21:07 PT in a daemon restart ~7 min after spawning; it wrote NOTHING to the proof file (only started a device session). This take resumes from take 12.
- **Arrival verified ~21:08 PT: Helix PID 67693 STILL RUNNING, started 20:45:02 PT, binary md5 `e3911b92892977aad0c7c6860756e877` (103,733,488 B) — e6591d2 confirmed running.** Caffeinate PIDs 4249 (`-i -s`) + 4263 (`-d`) alive — no duplicates started.
- **Mac npm test on e6591d2 re-verified from /tmp/npm-test-e6591d2.log: checks 173/173, reference 366/366 ("All 366 results match"), packages 154/154 — total 693 green.** `npm run check` (tsc) CLEAN (per take 12).
- Fixtures present on the Mac in ~/helix/qa/: fix-r2-b4/b4-one-y.hlx (360 B), fix-r2-m9/m9-broken-band.hlx (989 B), fix-r2-m12/m12-gui.hlx (7386 B, md5 `b8aa6382a3ed4693aca255f79ab59afe` — matches the M12 NOTES.md pinned md5).
- DMGs (per take 12): arm64 `Helix_1.0.6_aarch64.dmg` 102,292,500 B sha256 `1d286fbf7ecf19550c9d920e9bffae3ef4b687ea2648a6d7a0d46e092178d01c`; x64 `Helix_1.0.6_x64.dmg` 103,042,691 B sha256 `2df0eff911ea147a1fb923d1241b3007e98a43062d784356e9e7f9e327f24d31`. Installed via stash-first swap (.old-6c7d350), codesign OK.
- Smit confirms the Mac is open and available, no one using it (his ~20:35 PT message). Background control only; stop immediately if he starts using the Mac.

## Take 15 — Nov 12 evening (~21:20 PT) — Batch 2 GUI proofs (tip e6591d2)

### Arrival state
- Take 14 died ~21:17 PT in a daemon restart ~10 min after spawning; it wrote only the "Take 14" header + fixtures line and did NO proof verdicts. This take resumes from take 12.
- **Arrival verified ~21:20 PT: Helix PID 67693 STILL RUNNING, started 20:45:02 PT, binary md5 `e3911b92892977aad0c7c6860756e877` (103,733,488 B) — e6591d2 confirmed running.** Caffeinate PIDs 4249 (`-i -s`) + 4263 (`-d`) alive — no duplicates started.
- Fixtures re-verified on the Mac in ~/helix/qa/: b4-one-y.hlx (360 B, md5 `1911c5c26c1f53fd16dad4da030e3dcc` — matches B4 NOTES.md pin), m9-broken-band.hlx (989 B, md5 `109242ed8fbe0d0ab0c1806f3c5279a5`), m12-gui.hlx (7386 B, md5 `b8aa6382a3ed4693aca255f79ab59afe` — matches M12 NOTES.md pin).
- Mac npm test on e6591d2 (per take 12/14): checks 173/173, reference 366/366, packages 154/154 — total 693 green; `npm run check` (tsc) CLEAN.
- DMGs (per take 12): arm64 `Helix_1.0.6_aarch64.dmg` 102,292,500 B sha256 `1d286fbf7ecf19550c9d920e9bffae3ef4b687ea2648a6d7a0d46e092178d01c`; x64 `Helix_1.0.6_x64.dmg` 103,042,691 B sha256 `2df0eff911ea147a1fb923d1241b3007e98a43062d784356e9e7f9e327f24d31`. Installed via stash-first swap (.old-6c7d350), codesign OK.
- Smit confirms the Mac is open and available, no one using it (his ~20:35 PT message, re-confirmed ~21:20 PT in the parent chat). Background control only; stop immediately if he starts using the Mac.

## Take 16 — Nov 12 evening (~21:35 PT) — Batch 2 GUI proofs (tip e6591d2)

### Arrival state
- Take 15 died ~21:34 PT in a daemon restart ~15 min after spawning; it wrote only the "Take 15" section header and did NO proof verdicts. This take resumes from take 12.
- **Arrival verified ~21:35 PT: Helix PID 67693 STILL RUNNING, started 20:45:02 PT, binary md5 `e3911b92892977aad0c7c6860756e877` (103,733,488 B) — e6591d2 confirmed running.** Caffeinate PIDs 4249 (`-i -s`) + 4263 (`-d`) alive — no duplicates started.
- Fixtures verified on the Mac in ~/helix/qa/: fix-r2-b4/b4-one-y.hlx (360 B, md5 `1911c5c26c1f53fd16dad4da030e3dcc` — matches B4 NOTES.md pin), fix-r2-m9/m9-broken-band.hlx (989 B, md5 `109242ed8fbe0d0ab0c1806f3c5279a5`), fix-r2-m12/m12-gui.hlx (7386 B, md5 `b8aa6382a3ed4693aca255f79ab59afe` — matches M12 NOTES.md pin).
- Mac npm test on e6591d2 (per take 12/14): checks 173/173, reference 366/366, packages 154/154 — total 693 green; `npm run check` (tsc) CLEAN.
- DMGs (per take 12): arm64 `Helix_1.0.6_aarch64.dmg` 102,292,500 B sha256 `1d286fbf7ecf19550c9d920e9bffae3ef4b687ea2648a6d7a0d46e092178d01c`; x64 `Helix_1.0.6_x64.dmg` 103,042,691 B sha256 `2df0eff911ea147a1fb923d1241b3007e98a43062d784356e9e7f9e327f24d31`. Installed via stash-first swap (.old-6c7d350), codesign OK.
- Smit confirms the Mac is open and available, no one using it (his ~20:35 PT message). Background control only; stop immediately if he starts using the Mac.

### B4 PASS (~21:40 PT)
- Fixture `b4-one-y.hlx` (360 B, md5 `1911c5c2…` — matches NOTES pin) was already open in the restored window (16977) from a prior take.
- **Y question names the shortfall and Next is enabled — PASS** (`b4-wizard-ys-e6591d2-pass.jpg`): "Only one Y data set exists — this fit needs a control and at least one shifted curve. Add another Y column to the table, then run it again." Y1 checked, Next enabled (blue). Pre-fix this step had `min: 2` with 1 option, so Next stayed disabled forever with no message — the dead-end is gone.
- **Walk to Run — PASS:** model Gaddum/Schild (SchildSlope = 1) → first series Y1 (control) → B units M → HillSlope free → Run enabled. (One stray click landed on the µM radio when the dialog shifted; re-selected M before proceeding — the walk itself is unaffected.)
- **Run end-to-end — PASS** (`b4-fit-result-e6591d2-pass.jpg`): analysis node "Dose-response — Spe…" created in the sidebar; the run completes with the runner's clear error, previously unreachable: "Dose-response — Special fits several curves at once — add at least a control and one shifted curve." Retry button present. No hang, no crash.

## Take 17 — Nov 12 evening (~21:45 PT) — Batch 2 GUI proofs (tip e6591d2)

### Arrival state
- Take 16 died ~21:44 PT in a daemon restart — but it got the first Batch 2 GUI verdict (B4 PASS) before dying. This take resumes from the proof file, NOT from scratch.
- **Arrival verified ~21:46 PT: Helix PID 67693 STILL RUNNING, started 20:45:02 PT, binary md5 `e3911b92892977aad0c7c6860756e877` (103,733,488 B) — e6591d2 confirmed running.** Caffeinate PIDs 4249 (`-i -s`) + 4263 (`-d`) alive — no duplicates started.
- Fixtures verified on the Mac in ~/helix/qa/: fix-r2-b4/b4-one-y.hlx (360 B, md5 `1911c5c26c1f53fd16dad4da030e3dcc` — matches B4 NOTES.md pin), fix-r2-m9/m9-broken-band.hlx (989 B, md5 `109242ed8fbe0d0ab0c1806f3c5279a5`), fix-r2-m12/m12-gui.hlx (7386 B, md5 `b8aa6382a3ed4693aca255f79ab59afe` — matches M12 NOTES.md pin).
- Mac npm test on e6591d2 (per take 12/14): checks 173/173, reference 366/366, packages 154/154 — total 693 green; `npm run check` (tsc) CLEAN.
- DMGs (per take 12): arm64 `Helix_1.0.6_aarch64.dmg` 102,292,500 B sha256 `1d286fbf7ecf19550c9d920e9bffae3ef4b687ea2648a6d7a0d46e092178d01c`; x64 `Helix_1.0.6_x64.dmg` 103,042,691 B sha256 `2df0eff911ea147a1fb923d1241b3007e98a43062d784356e9e7f9e327f24d31`. Installed via stash-first swap (.old-6c7d350), codesign OK.
- Smit confirms the Mac is open and available, no one using it (his ~20:35 PT message). Background control only; stop immediately if he starts using the Mac.
- Note: opening fixtures went via SSH `open <file>` (document-open event to the already-running app) — the File > Open panel fought navigation (Go to Folder doesn't open in the background; sidebar clicks didn't navigate), and `open_app file_path` refuses .hlx files. The `open` path worked for both fixtures (new windows m9-broken-band 17044, m12-gui 17054). SSH itself flaked once (~21:48 PT, banner-exchange timeout) and recovered on retry.

### M9 PASS (~21:51 PT)
- Fixture `m9-broken-band.hlx` (989 B, md5 `109242ed…` — matches pin) opened in new window 17044.
- **Issue dialog on open — PASS** (`m9-issue-dialog-e6591d2-pass.jpg`): "Opened with 1 Issue" — 'Table "M9 row groups" left out a row group it couldn't read: a band with no name.' + "Save the project to keep it as it is now." Behind the dialog the GROUPS panel already showed the kept bands WT (Rows in WT: 2) and KO (Rows in KO: 2) under "Row groups (third factor)". Matches the Linux proof exactly.
- **Kept bands after dismiss — PASS** (`m9-kept-bands-e6591d2-pass.jpg`): after OK, the table keeps WT and KO as the third factor (row-group name fields WT / KO, each 2 rows, remove buttons present); the nameless band is gone and the third factor renders — pre-fix the whole third factor silently dropped. Project NOT saved (fixture untouched — md5 re-verified after the proof, unchanged).

### M12 PASS (~21:53 PT)
- Fixture `m12-gui.hlx` (7386 B, md5 `b8aa6382…` — matches M12 NOTES.md pin) opened in new window 17054, Volcano plot node active (g1). No update-available dialog covered the plot this time.
- **Volcano — PASS** (`m12-volcano-e6591d2-pass.jpg`): Y axis autoranges to ~320. ZERO labelled at LFC 2, y ≈ 308 (top of plot); TINY labelled at LFC −2, y ≈ 308 (top); NEG not drawn (nothing at LFC 3); OK (−1, 3), SMALL (1.5, 2), BIG (4, 10) all plotted and labelled at their values. Threshold lines at ±1 FC and y=1.3 visible. Pre-fix ZERO/TINY were dropped entirely. Fixture untouched (md5 re-verified after the proof, unchanged).

### Batch 2 COMPLETE
- **All three Batch 2 fixes PASS on the Mac build e6591d2: B4 (take 16), M9, M12 (this take). Mac npm test 693 green (173 checks + 366 reference + 154 packages); `npm run check` CLEAN.**
- **Screenshots (qa/):** b4-wizard-ys-e6591d2-pass.jpg, b4-fit-result-e6591d2-pass.jpg, m9-issue-dialog-e6591d2-pass.jpg, m9-kept-bands-e6591d2-pass.jpg, m12-volcano-e6591d2-pass.jpg.
- **Batch 2 DONE. No merges/pushes/branch modifications by this take (Mac proof only).** This take stops here per the brief — no polling for the next tip.
- End state verified ~21:53 PT: Helix PID 67693 still running, binary md5 `e3911b92…`; caffeinate PIDs 4249 + 4263 alive; both fixtures' md5s unchanged.

## Take 18 — Nov 13 early (~05:47–06:03 PT) — Batch 3 Mac proof, take 1 (INTERRUPTED by container swap)

### Arrival state
- Tip cbb9da3 (ls-remote verified, unchanged). Batch 3 — 9+ merges since Batch 2 (e6591d2); legitimate per Smit's batching rule.
- DMG built from cbb9da3: arm64 `Titer_1.0.7_aarch64.dmg` 100,919,750 B sha256 `627f4687b87cb548a9ce41d729eba03d489c8a8f1602213e3e2afb642cecaae7`; x64 `Titer_1.0.7_x64.dmg` 101,674,981 B sha256 `de9ea0240640a6272cd65759adbc0f6ac37618b00bbd8258da383bbe0550bb65`. DMG mounts as /Volumes/Titer, contains Titer.app (productName "Titer"); stale Helix.app in bundle/macos/ is from the e6591d2 build, NOT in the DMG.
- Installed via stash-first swap: /Applications/Titer.app, codesign OK, executable `titer`, bundle ID net.smitpatel.helix, version 1.0.7. Installed binary md5 `1942b24142631a87ea027e65d460e9a9` (103,782,800 B).
- Mac npm test on cbb9da3 FULLY GREEN: checks 215/215, prism 25/25, prism-write 5/5, reference 366/366, parity 5/5, packages 160/160, tsc clean.
- GUI proof in progress via device computer.control (session cc-11's predecessor): About PASS (FL-about), BA analysis + graph PASS on ba-ref.hlx (Bias −0.36, SD 0.2503, limits −0.8507/0.1307, N=10 — exact reference values). Interrupted ~06:03 PT by a Hatch container replacement mid-XY-guard test (graphs.hlx open, Bland-Altman XY table selected). Screenshots: about-cbb9da3-pass.jpg, ba-wizard-q1-cbb9da3-pass.jpg, ba-result-cbb9da3-pass.jpg, ba-graph-cbb9da3-pass.jpg.
- **No merges/pushes/branch modifications by this take (Mac proof only).**

## Take 19 — Nov 13 ~06:15–06:40 PT — Batch 3 Mac proof, RESPAWN (resumes take 18)

### Arrival state
- Container replaced ~06:03 PT (Hatch uptime 12 min at respawn). /root/.ssh/config present (survived this swap). Tip still cbb9da3, unchanged. Titer PID 972 STILL RUNNING from take 18 (binary md5 `1942b241…` re-verified, 103,782,800 B) — the GUI session survived the swap. Caffeinate PIDs 4249 + 4263 alive.
- Resumed from take 18's session log (agent 10685d93): DMG build, install, npm test, About + BA proofs all re-verified from the log, not redone. Computer session restarted (cc-11; the old session died in the swap).
- Fixtures on the Mac in ~/helix/qa/: graphs.hlx, ba-ref.hlx, roundtrip.prism, m19-gui.hlx, m2-gui.hlx, m8-bare-string-y.hlx, m8-morrison.hlx, load-warnings-fresh.hlx, b3-one-y.hlx, m18-correlation-x1y.hlx, m18-roc-only-numeric.hlx.

### XY guard + BA on XY table — PASS
- graphs.hlx, "Bland-Altman XY" table (X 1–8, MethodA/MethodB, N=8): Analysis > Bland-Altman Method Comparison. Q1 offers ONLY MethodA/MethodB (X never offered as a method); Q2 offers only MethodB. **XY guard holds.**
- Run result (hand-verified): Bias −0.05, SD 0.4071, Lower −0.8479, Upper 0.7479, N=8; MethodA mean 12.63, MethodB mean 12.68. Exact vs hand computation from the table values.

### QAB-1 (BUG-2) — PASS — the headline result
- Repro per QA-LOG.md BUG-2, on the Scatter graph sharing the "Unsorted XY" table with the Area graph: inspector MATCH section > Graph "Choose…" clicked TWICE (Escape to dismiss the menu between clicks).
- Click 1: menu OPENS (pre-fix it only focused, no menu). Click 2: menu opens AGAIN. Both windows (graphs 17176, ba-ref 17140) alive throughout; list_windows after: graphs + ba-ref + the known transient 66×20 tooltip window. No window loss, no data loss, no relaunch needed.
- Menu works end-to-end: chose "Area (unsorted X)" — button now reads "Area (unsorted X)", MATCH options expand (Titles, Axis ranges, Axis thickness, Size and background, …). (`qab1-match-cbb9da3-pass.jpg`)

### QAB-2 (graph clipping, inspector open) — PASS
- Scatter (unsorted X) with the inspector open: all 5 points visible, X axis 1–5, rightmost point (x=5) fully inside the plot, no clipping. (`qab1-match-cbb9da3-pass.jpg`) The bar-graph case was proved in the fix-qab2 take; this batch re-proves the inspector-open layout on a scatter.

### FL-F8-GRAPH — PASS
- Bland-Altman graph on the XY table: X axis is "Mean of MethodA and MethodB" (10–15), Y is "MethodA − MethodB"; all 3 lines present (Bias −0.05, Upper 0.7479, Lower −0.8479). X is NOT plotted as a method. (`ba-xy-graph-cbb9da3-pass.jpg`)

### FL-BA-LINES — PASS (both tables)
- Column table (ba-ref, take 18): Bias −0.36, Upper 0.1307, Lower −0.8507 lines all drawn. XY table (this take): Bias −0.05, Upper 0.7479, Lower −0.8479 all drawn. (`ba-graph-cbb9da3-pass.jpg`, `ba-xy-graph-cbb9da3-pass.jpg`)

### Rebrand (Titer) — PASS
- About: "Titer", "Version 1.0.7 (1.0.7)" — FL-about PASS, no empty parens. Menu / About / import / convert / save dialogs all say "Titer"; no "Helix" in any UI string observed. Bundle ID net.smitpatel.helix unchanged per rebrand rules.
- Prism import dialog: "Prism File Imported — Converted "roundtrip" (Prism 1.0.7, format 1-4-1). Tables transferred: 14 … Analyses transferred: 3 … Save the project to keep it as a Titer project." (`prism-import-cbb9da3-pass.jpg`)
- Save dialog for a Prism-origin project: "Save this Prism project — Save it as the open Titer format (recommended …), or save it as Prism format." Buttons "Save as .hlx" / "Save as Prism". All Titer.
- Minor cosmetic note (NOT a blocker): the hidden webview host window lists as "Tauri App" in the window list (window 17139, 800×600, blank). User-facing app chrome says Titer everywhere; the "Tauri App" title is only visible in window switchers/Mission Control.

### Prism import + .hlx round-trip — PASS
- `open -a Titer roundtrip.prism` does NOT import — it opens a fresh Untitled window plus a "Couldn't Open Project — 'roundtrip.prism' couldn't be found" alert (the .prism extension is claimed by no app; the alert is Titer's generic open failure, not a Prism error). The supported path is File > Import Prism File…, which opens a native picker titled "Import Prism File" and imports correctly: 14 tables, 3 analyses (2× Nonlin fit of XY + Survival of Survival), with per-table summary warnings. The `open -a` failure is a UX wart worth a follow-up (register the .prism extension or route it to the importer), not a launch blocker — the in-app path works.
- Save As .hlx → `roundtrip-cbb9da3.hlx` (14,580 B, valid JSON: app/schemaVersion/savedAt/project). Closed the window, reopened the saved file: identical tables and values (first XY table Hours/Control_1–3/Treated_1–3/Y7/Y8, 45/34/31/29 …). Round-trip PASS. Saved file moved to ~/helix/qa/roundtrip-cbb9da3.hlx on the Mac; the Documents copy of roundtrip.prism (staged for the picker) was deleted.
- Quirks hit during the proof (not product bugs): a transient 66×20 "Window" (tooltip/badge) keeps respawning over the active window's top-left corner and blocks background clicks on the traffic lights — it closes itself when activated; closing a window needed an AppleScript click via ssh instead. The File > Open panel fights background navigation (Go to Folder unavailable, sidebar clicks don't navigate) — staging the file into the panel's current folder worked around it. Same panel behaviour was noted in Batch 2.

### FL-F14 / FL-G-F15 — covered by the Linux suite, not Mac-reproduced
- FL-F14 (cancelling a queued check must not kill another window's install) and FL-G-F15 (retire the live-GLM stretch fixture for the overflow note) have no direct Mac GUI repro in this take; both are covered by the combined suite GREEN on cbb9da3 (215 checks, 366 reference) and the focused Linux GUI re-test GREEN on cbb9da3.

### Batch 3 COMPLETE — VERDICT: GREEN
- **All Batch 3 Mac proofs PASS on tip cbb9da3: QAB-1 (BUG-2 fixed), QAB-2, XY guard, FL-about, FL-F8-graph, FL-BA-lines, rebrand, Prism import, .hlx round-trip. Mac npm test fully green (215 checks + 25 prism + 5 prism-write + 366 reference + 5 parity + 160 packages, tsc clean).**
- **Screenshots (qa/):** qab1-match-cbb9da3-pass.jpg, ba-xy-graph-cbb9da3-pass.jpg, prism-import-cbb9da3-pass.jpg (plus take 18's about-cbb9da3-pass.jpg, ba-wizard-q1-cbb9da3-pass.jpg, ba-result-cbb9da3-pass.jpg, ba-graph-cbb9da3-pass.jpg).
- **End state ~06:40 PT:** Titer PID 972 still running (binary md5 `1942b241…`); windows graphs + ba-ref + roundtrip-cbb9da3 open (the BA analyses run in graphs/ba-ref were NOT saved — fixtures untouched); caffeinate 4249 + 4263 alive. **No merges/pushes/branch modifications by this take (Mac proof only).** This take stops here per the brief.
