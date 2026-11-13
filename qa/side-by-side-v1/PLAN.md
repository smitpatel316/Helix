# Side-by-side QA — PLAN (launch runbook, prep 2026-11-12)

**Status: PREP ONLY.** This plan is ready to execute the moment the launch
tip lands. Do not run it before then — the build is mid-Round-2 and the
launch tip does not exist yet.

## 1. Scope (v1.0 FROZEN, Smit's call Nov 12 ~10:01 PT)

Full text: `~/workspace/helix-vault/Plans/v1.0 scope.md`.

**IN v1.0 (this QA covers all of it):**
1. Round 2 fixes — F-02 + all 4 blockers (B1–B4) + all 19 majors (M1–M19),
   plus any minor triage flags as app-breaking.
2. Rebrand applied (name **TITER**, picked Nov 12 ~10:09 PT, + logo from
   Smit's pick, bundle ID `net.smitpatel.helix`, full Helix scrub of
   README + code, Smit's own Buy Me a Coffee link; GPL-3.0 modified-fork
   attribution stays).
3. Prism-format merge + converter hook-up in the app (parity re-run
   post-merge).
4. This side-by-side QA, Mac + Linux, numbers matching Prism.
5. Release paperwork (LICENSE in DMG, README links to our releases with
   the exact commit tagged, modified-fork notice).

**OUT of v1.0 (do NOT check):** the 65 minors (unless triage pulls one
back), the 11 v2 ideas, remaining missing/partial analyses, the .pzfx
writer.

**Launch target:** TONIGHT, Thu Nov 12 (Smit's call ~10:07 PT; the Nov 17
date in `Plans/launch plan.md` is superseded). The gate is unchanged —
tonight means finishing the scope, not waiving it. **Name pick needed
TODAY or the rebrand slips** (the pick gates the apply, which gates the
QA that follows it).

## 2. Launch gate (all must hold — no exceptions)

- [ ] Full suite green on the launch tip, merged tree (all checks +
      reference + package; count ≥ 669 and growing with Round 2 + format
      merge). Linux AND Mac.
- [ ] Mac + Linux GUI-proved (no open Mac-proof items; QAB-1 two-graph
      MATCH test PASSED on Mac).
- [ ] No open blockers or majors (and no open app-breaking minors — the
      triage stays list must be empty or fixed).
- [ ] Rebrand applied (name, logo, bundle ID, scrub, Buy Me a Coffee link).
- [ ] Prism-format merged + converter hooked up, parity re-run post-merge
      with no regressions vs the pre-merge 824/824 sweep.
- [ ] Release paperwork merged and DMG-proven (LICENSE in the DMG).

## 3. What "numbers matching Prism" means

- Fitted parameters: **1e-3 relative**. Beyond 1e-3, the **RSS arbiter**
  decides: Helix RSS ≤ Prism RSS (× (1 + 1e-9)) on the same fit points =
  pass as an optimizer difference; Helix RSS worse = FAIL. CIs never
  arbitrate. (Why: Prism fits with Levenberg–Marquardt, Helix with R's
  nls — different optimizers on the same least-squares problem; Helix
  sometimes finds a *better* optimum than Prism.)
- χ² statistics: **1e-3 relative**.
- p-values: **1e-4 absolute** (never relative — a relative tolerance
  would pass garbage near 0 and fail honest noise near 1).
- CIs: **1e-2 relative**, only where BOTH bounds are numbers. Prism's
  CIs are profile-likelihood, Helix's are Wald — 1% passes that honest
  difference and still catches a wrong standard error.
- `tests/reference.json` pins: **exact to displayed precision** in the
  GUI. A GUI value differing from its pin at displayed precision is a
  FAIL even if it is within the Prism tolerances above.
- Prism "undefined" values (CI uppers, medians) are **skipped**, never
  passed or failed.
- Exports: correct dimensions for the DPI + all content present.
- **Disputed values:** `qa/ground-truth/gt.py` (scipy, 230 checks) is
  the independent third opinion — it arbitrates, it does not overrule
  Prism's `results.json` or `reference.json`.

## 4. Order of checks (run in this order; stop conditions in §5)

| Phase | What | Where | Notes |
|---|---|---|---|
| 0 | **Gate the run:** record the launch tip SHA; `npm run check` + `npm test` green on Linux; `cargo check` clean; parity re-run post-merge (CHECKS.md §2 + §7) | Linux (Hatch) + Mac (SSH) | If the suite is red, STOP — do not start GUI work on a red build |
| 1 | **Round 2 fix re-verification** (CHECKS.md §3): F-02 first, then B1–B4, M1–M19, then any triaged app-breaking minors | Linux GUI first (Xvfb), Mac where GUI-visible | Per-item rows appended from TRACKING.md at run start. Any item parked as blocked = gate FAIL — stop and report |
| 2 | **Plan families** (CHECKS.md §1): plans 01–36 + multi-panel + upstream-deduped, in plan order | Linux + Mac in parallel (separate agents; shared files are read-only here) | Re-run on launch tip; close the §1 skipped sub-cases (Plan 26 cases 3a/3b/4, Plan 29 overlay kink, canonical survival.pzfx Mac import, multi-panel export click) |
| 3 | **Prism-format in the GUI** (CHECKS.md §2): demo .prism import on both platforms, save nudge, converter hook-up | Mac + Linux | The CLI numbers (446/446 + 36/36) do NOT transfer — the CLI was stale post-rebase; verify the HOOKED-UP converter |
| 4 | **Import GUI lane + exports + tables** (CHECKS.md §4): the open gaps — all 6 fixtures, drag-and-drop, error/cancel paths, Multiple Variables + Contingency tables, graph types, JPG 150 / PNG 600 DPI, post-hoc tests | Mac + Linux | The single biggest gap (§7). Do not sign off with these unrun |
| 5 | **Rebrand + paperwork** (CHECKS.md §5–§6) | Mac DMG + Linux bundle + repo | Name picked (TITER); blocked until the apply phase lands. Verify LICENSE-in-DMG with a real DMG build |
| 6 | **Sign-off** (§8) | — | All gate boxes ticked or the run FAILS with reasons |

**Parallelism:** Linux and Mac halves run in parallel (different agents,
different machines). Within a platform, one check at a time — never batch
GUI steps without verifying each screenshot. Shared-file edits stay
single-threaded (this QA writes only under `qa/side-by-side-v1/runs/`).

## 5. Stop conditions (stop the run, report, do not push through)

- Suite red on the launch tip (Phase 0).
- Any Round 2 item parked as blocked (Phase 1) — open blocker/major.
- QAB-1 two-graph MATCH test destroys windows on Mac (Phase 1/2) —
  the exact Nov 9 signature; record with a `sample` and stop the Mac run.
- A GUI value differs from its reference.json pin at displayed precision
  and is NOT explained by the RSS arbiter (Phase 2) — record as FAIL,
  continue with the next family, do not re-run the same check hoping for
  a different result.
- Mac gateway down / screen re-locked for >10 min of retries — stop the
  Mac half, report it as blocked (not failed), and let the Linux half
  continue. The only known gateway fix is Smit relaunching the Muse app.
- Container replacement mid-run: re-run `scripts/setup-linux.sh` before
  linking (apt `-dev` packages are wiped); rebuild is NOT this lane's job
  — if the Linux binary is stale, stop and hand back to the parent.

## 6. Linux steps (detail)

Harness: `harness/run-linux-side-by-side.sh` (source it; do not execute
it end-to-end blindly — it stages, launches, smokes, and manifests, then
you drive checks one at a time). Environment lessons from Nov 9–11,
baked into the harness:
- Xvfb with `-listen tcp`, `DISPLAY=127.0.0.1:<n>` (`/tmp` gets wiped
  mid-session; the TCP display survives).
- `export PATH="$HOME/.cargo/bin:$PATH"` in non-login shells (cargo is
  not on PATH otherwise).
- Lane-specific TMPDIR under `~/workspace` (shared TMPDIR gets raced;
  `/tmp` fills up on full suites).
- After every container replacement, re-run `scripts/setup-linux.sh`
  before linking.
- Screenshots via `ffmpeg -f x11grab -i 127.0.0.1:<n>`; never `pkill -f`
  with a pattern matching your own command line.
- A failed build blocks a GUI proof — verify binary path/size/sha first,
  never run a stale binary.
- Disk quota (EDQUOT) can block writes with tens of GB free — free
  regenerable `target/` dirs of completed lanes only.

## 7. Mac steps (detail)

Runbook: `harness/mac-runbook.md` (device-route steps, preconditions,
wrap-up, gotchas). Summary: caffeinate `-i -s` + `-d`; repo reset via
fetch + hard reset (never plain pull); DMGs via `scripts/build-mac-dmg.sh`;
safe install swap (temp copy → codesign → stash old aside → swap →
codesign → delete stash only after GUI proof); fixtures in
`~/retest/retest-2026-11-10/` + `~/retest/retest-2026-11-11/`; GUI
launches only via the device route; screenshots copied back to
`qa/side-by-side-v1/runs/<run-name>/mac/` at the end.

## 8. Known gaps the run must close (the honest list)

1. **Import GUI lane never completed** (all 6 fixtures + drag-and-drop +
   error/cancel paths on Mac). The single biggest gap. Linux proved
   survival import only.
2. **Multiple Variables + Contingency tables never driven in the Mac GUI.**
3. **Graph types never Mac-driven:** Box/Violin, Individual Values, Pie,
   Donut, XY scatter/bar/area, mean/error.
4. **JPG 150 / PNG 600 DPI exports never verified** (only PNG 300 + SVG).
5. **Post-hoc tests never verified in the Mac GUI** (Tukey/Bonferroni/
   Dunn, RM two-way ANOVA, Scheirer–Ray–Hare, Multiple t tests) —
   suite-pinned only.
6. **Skipped sub-cases from Nov 11:** Plan 26 cases 3a/3b/4; Plan 29
   segmental overlay kink; canonical survival.pzfx Mac GUI import
   (picker navigation flaky via device route); multi-panel export click
   (never clicked); Plan 28 case 2b graph overlay (Linux-proven only).
7. **Parity sweep honest gaps (carry, don't hide):** 28 degenerate-fit
   errors (flat RSS ridges, parameters unidentifiable); 135
   transform-input datasets not imported; non-4PL nonlinear families not
   compared (e.g. one-phase decay, 42 analyses); 2 unreadable corpus
   files; CIs skipped where Prism reports "undefined". A future
   regression shows as a changed count — the harness reports counts.
8. **QAB-1 Mac proof outstanding** (gateway blocked the overnight proof;
   fix-proof take 2 running in parallel). Launch-gate item.
9. **Rebrand checks gated on the apply phase** (name picked: TITER,
   ~10:09 PT; apply coordinated with the Round 2 coordinator). The apply
   must land before §5 can run.
10. **Release paperwork DMG proof outstanding** (branch 8f5d0a9 ready,
    unmerged; LICENSE-in-DMG needs a real Mac DMG build to prove).

## 9. Sign-off checklist (copy to RESULTS.md at run start; all must tick)

- [ ] Launch tip SHA recorded: ________ (branch `feat/prism-import-survival`)
- [ ] Suite green on launch tip — Linux: ___ checks (≥669) / Mac: ___ checks
- [ ] Parity re-run post-merge: C-04 ___/6 + ___/6, C-05 ___/7, C-12 gate ___,
      g.5 sweep ___/824 (regressions vs pre-merge: ___)
- [ ] Round 2 fixes re-verified on launch tip: F-02 ___, B1–B4 ___/4,
      M1–M19 ___/19, triaged minors ___/___
- [ ] Plan families re-run: ___/39 (Mac ___/39, Linux ___/39)
- [ ] Import GUI lane closed: ___/13 (§4 checks)
- [ ] QAB-1 two-graph MATCH test PASSED on Mac: ___
- [ ] Rebrand applied + verified: name Titer, bundle ID `net.smitpatel.helix` ___,
      scrub ___ (grep clean except attribution), Buy Me a Coffee link ___
- [ ] Release paperwork: LICENSE in DMG ___, README links ___, fork notice ___
- [ ] No open blockers/majors (TRACKING.md Round 2 table: 0 blocked, 0 in progress)
- [ ] RESULTS.md complete with per-check PASS/FAIL + exact values + screenshots
- [ ] **LAUNCH GATE: PASS / FAIL** (signed, dated)

## 10. RESULTS.md template (create at run start under `runs/<run-name>/`)

```markdown
# Side-by-side QA — RESULTS (launch tip <SHA>, <date>)
- Launch tip: <sha> — <subject>
- Suite: Linux <n> green / Mac <n> green
- Parity post-merge: C-04 x/6 + x/6, C-05 x/7, C-12 gate, g.5 x/824 (regressions: none / <list>)
- Round 2: F-02 <PASS/FAIL>, B1–B4 <n>/4, M1–M19 <n>/19, triaged minors <n>/<n>
- Plans: Mac <n>/39, Linux <n>/39
- Import lane: <n>/13
- QAB-1 two-graph: <PASS/FAIL> (screenshot)
- Rebrand: name <…>, bundle ID <…>, scrub <clean/not>, BMC link <…>
- Paperwork: LICENSE in DMG <y/n>, README links <y/n>, fork notice <y/n>
- FAILs (each with exact values + screenshot + reference):
- Open gaps at sign-off (each with a reason):
- Gate: PASS / FAIL
```

## 11. Files in this directory

| File | What it is |
|---|---|
| `PLAN.md` | This runbook |
| `CORPUS.md` | Corpus inventory (~136 test inputs + expected-value sources) |
| `CHECKS.md` | Check list (~104 checks: §1 plans, §2 format, §3 fixes, §4 import/exports, §5 rebrand, §6 paperwork, §7 suite) |
| `harness/run-linux-side-by-side.sh` | Linux staging + launch + smoke + manifest harness (source it; do not build) |
| `harness/diff-reference.mjs` | Expected-values manifest generator (pure Node; reads reference.json) |
| `harness/mac-runbook.md` | Mac device-route runbook |
| `runs/` | Created at run start: per-run logs, screenshots, RESULTS.md (do not pre-fill) |
