# Hello Analysis — the example plugin

The smallest possible plugin: one analysis, the mean of the first column.

## What it proves

- `plugin.json` (manifest + analysis spec) parses and validates through
  the install-time gates (`parsePluginPackage`).
- The plugin installs DISABLED, passes the review step, and enables
  (`installPlugin` → `requestEnable` → `confirmEnable`), registering
  `plugin:example.hello-analysis:hello-mean` in the same registry
  first-party analyses use.
- The R analysis runs through the existing webR engine
  (`runPluginAnalysis` → `evalNamedVector`), with its groups declared as
  `g0`, `g1`, … and its result as a `c(name=value, …)` named vector.
- `hello-scaled-mean` (registered in code in `index.ts`, not in
  `plugin.json`) proves the second compute path: a pure-TypeScript
  analysis with parameters (a choice + a number with a range) and wizard
  questions, whose descriptives come from `lib/summary` and which never
  touches R.

## Layout

- `plugin.json` — the manifest + the `hello-mean` R analysis spec. This
  is the whole plugin as a folder/zip would carry it (a real plugin also
  ships a README and its JS entry file; the entry file is Phase 4 — the
  Isolation webview that loads plugin JS does not exist yet, so this
  groundwork never executes plugin JS).
- `index.ts` — registers both analyses and verifies them
  (`verifyHelloPlugin`).

## Verify

- Type level: `npm run check` (tsc) — the registration + run path is
  exercised in code.
- Runtime: `verifyHelloPlugin()` — runs both analyses on synthetic
  columns and checks the numbers. The R half boots the webR engine, so
  it runs after v1 ships (build verification pending v1 clear, like the
  rest of this lane's runtime behaviour).
