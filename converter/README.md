# prism2hlx — Prism 10 → Helix converter (standalone CLI)

Converts a Prism 10 `.prism` file to a Helix `.hlx` file, headless, from the
command line. No app, no Mac. This is the converter core that will later be
hooked into the Helix app (import `.prism`, work, save to `.hlx`); it also
stands alone.

## Usage

```sh
# from the repo root (after npm ci)
npm run convert -- converter ... # see converter/package.json scripts
# directly:
node --import tsx converter/src/cli.ts <input.prism> [output.hlx] [--json]
```

Setup: `npm ci` in the repo root AND in `converter/` — the converter
reuses Helix's own project-file code, so `npm run check` needs the root
`node_modules` (React/WebR types) as well as the converter's own
`@types/node`. The `convert` and `verify` commands run without the root
install; `check` does not.

- The input file is only ever read, never written (the CLI verifies its
  checksum before and after).
- The output is written with Helix's own `serializeProjectFile`, so it opens
  in Helix unchanged.
- `--json` prints the transfer report as JSON instead of text.

## What transfers

The field-by-field mapping is the spec in the vault:
`~/workspace/helix-vault/Research/Prism 10 to hlx mapping.md`

- **Tables:** all data sheets — values cell-exact, row titles, X values,
  summary subcolumns (mean/SD/N…) named, with a warning that they are
  summaries, not raw replicates.
- **Analyses:** the ones Helix offers, with parameters (nonlinear-regression
  4PL, survival log-rank in the demo file). Anything else is named in the
  report as not yet supported — never silently dropped, never faked.
  Fitted results are NOT carried: Helix recomputes every analysis from the
  table when the file opens.
- **Graphs and layouts:** NOT transferred — Prism stores them in an
  undocumented binary blob (`data.bin`, magic `PCFFGRA4`). They are listed
  in the report; re-create them in Helix.
- **Info sheets:** not transferred (Helix has no info sheet).

## Verify

```sh
node --import tsx converter/tests/verify.ts
```

Converts the public demo file (`prism2R-demo_dataset.prism`, the only
`.prism` in the test corpus — Mansi's files are never test material),
checks every table cell-by-cell against its source CSV, checks the analysis
nodes, round-trips the output through Helix's own `parseProjectFile`, and
prints PASS/FAIL per check with exact figures. Corpus path defaults to
`~/workspace/helix/test-corpus`; override with `PRISM_TEST_CORPUS`.

## Layout

- `src/prism.ts` — the converter core (ZIP + `document.json` + CSVs → `.hlx` project + transfer report).
- `src/csv.ts` — small CSV reader (quoted fields, CRLF/LF).
- `src/cli.ts` — command-line entry.
- `tests/verify.ts` — headless verification against the demo file.
