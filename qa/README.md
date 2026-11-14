# qa/ — QA evidence index

Dated proof records for the Titer launch. Nothing here is a plan or a
status doc — status lives in `~/workspace/helix-vault/Plans/Implementation/TRACKING.md`.
These files are the evidence behind it. This directory is **gitignored**
(`qa/` in `.gitignore`): it exists only in the main checkout, not in
clones or fresh worktrees. Screenshots live alongside the notes that cite
them (same directories, `*.jpg`/`*.png`).

## Launch QA (side-by-side, Mac + Linux)

- `side-by-side-v1/PLAN.md` — runbook for the launch QA run.
- `side-by-side-v1/CHECKS.md` — the check list (~106 checks, §1–§7).
- `side-by-side-v1/CORPUS.md` — fixtures used.
- `side-by-side-v1/harness/mac-runbook.md` — how the Mac leg runs.
- `END-TO-END-2026-11-09.md` — end-to-end report, Nov 9.
- `REVIEW-SWEEP-2026-11-10.md` — the 88-finding review sweep (4
  blockers, 19 majors, 65 minors) + 11 new v2 candidates.
- `MAC-RETEST-2026-11-09.md`, `MAC-RETEST-2026-11-10.md`,
  `MAC-RETEST-2026-11-11.md` — Mac retest reports.
- `MAC-FIX-PROOF-2026-11-11.md` — Mac fix-proof record, Batches 1–3
  (Batch 3 GREEN on cbb9da3).
- `QA-LOG.md` — Mac GUI QA log (Nov 9 evening session).
- `QA-LOG-LINUX.md` — Linux GUI QA log (Nov 9 evening session).

## Per-fix / per-plan proof notes

Each directory holds the proof note for one fix or plan; the note names
the commit tested and the PASS/FAIL verdict.

- `fix-qab3/merge5-notes.md`, `fix-qab4/merge6-PROOF.md`,
  `fix-quirk2/merge8-NOTES.md` — Round 1 fixes.
- `fix-r2-b1/NOTES.md`, `fix-r2-b2/NOTES.md`, `fix-r2-b3/NOTES.md`,
  `fix-r2-b4/NOTES.md`, `fix-r2-m1/NOTES.md`, `fix-r2-m2/NOTES.md`,
  `fix-r2-m9/NOTES.md`, `fix-r2-m10/NOTES.md`, `fix-r2-m12/NOTES.md`,
  `fix-r2-m19/NOTES.md` — Round 2 fix proofs (per-fix notes; the
  coordinator's full log is `~/.helix-fix2-coord/investigations.md`).
- `plan22/PROOF.md`, `plan24/QA-PLAN24.md`,
  `plan34/PLAN34-GUI-PROOF.md`, `plan34-merged/PLAN34-MERGED-GUI-PROOF.md`
  — plan GUI proofs.
- `rebase-gui-anova/LANE-LOG.md` — rebase GUI lane log.
- `retest-plan23/PLAN23-GUI-PROOF.md`, `retest-plan24/PLAN24-GUI-PROOF.md`,
  `retest-plan25/PLAN25-GUI-PROOF.md`, `retest-plan26/PLAN26-GUI-PROOF.md`,
  `retest-plan28/PLAN28-GUI-PROOF.md`, `retest-plan29/PLAN29-GUI-PROOF.md`
  — plan retest proofs.

## Ground truth

- `ground-truth/gt.py` (+ `gt1.txt`) — scipy reference values the GUI
  proofs compare against.
