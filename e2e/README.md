# e2e — WebdriverIO + Tauri (spike, `spike/tauri-e2e`)

Drives the real built (debug) app with WebdriverIO 9/10 + `@wdio/tauri-service`
(embedded provider). See `../Research/Tauri e2e testing options.md` for the
full findings and `specs/convert.e2e.js` for the spike's one spec (the Convert
dialog, both directions).

## Run

```sh
npm run e2e:build   # VITE_E2E=1 + tauri build --debug --no-bundle
npx wdio run e2e/wdio.conf.js
```

The run needs an X server. On the Linux box, bare Xvfb (no window manager —
no window ever takes focus, which is the point: the Convert spec must pass
unfocused):

```sh
Xvfb :99 -listen tcp -screen 0 1280x800x24 &
DISPLAY=127.0.0.1:99 npx wdio run e2e/wdio.conf.js
```

On the Mac, run it from a logged-in GUI session (Batch 5 Mac proof must be
done first — do not contend with it for the Mac). Two Mac-specifics:
- **Isolation:** the debug binary shares the real bundle id, so run wdio
  with a scratch HOME — `mkdir -p /tmp/titer-e2e-home && HOME=/tmp/titer-e2e-home npx wdio run e2e/wdio.conf.js`
  — so the app's `~/Library/Application Support` never touches Smit's real
  app-data dir. (The XDG vars in `wdio.conf.js` are ignored on macOS.)
- **Unfocused:** the app launches as the key app on macOS, which would let
  `requestAnimationFrame` fire and mask the pre-fix stall. The spec's
  `before()` moves focus to Finder (`open -a Finder`) on darwin before the
  Convert steps; Linux needs no such step (bare Xvfb, no focus ever).

## What the spike changes in the app (all debug/e2e-only)

- `src-tauri/Cargo.toml` + `src/main.rs`: `tauri-plugin-wdio` and
  `tauri-plugin-wdio-webdriver` as debug-only deps, registered under
  `#[cfg(debug_assertions)]`; the `wdio:default` capability is added at
  runtime in `setup()` so release builds never see the permission.
- `src-tauri/tauri.conf.json`: `withGlobalTauri: true` (required by the plugin).
- `src/main.tsx`: `import "@wdio/tauri-plugin"`, gated on `VITE_E2E=1` at
  build time (dead-code-eliminated otherwise).
- `src/components/app-shell.tsx`: `window.__titerE2E.openConverter()` hook,
  gated on `VITE_E2E=1` (native menus are not WebDriver-drivable; the menu
  chrome stays a manual Mac-proof item).
- `src/lib/tauri-core-e2e-shim.ts` + the `vite.config.ts` alias (both
  `VITE_E2E=1` only): routes `@tauri-apps/api/core` through a mock-consulting
  `invoke`, so `browser.tauri.mock()` intercepts the app's own invokes
  (a Vite-bundled frontend calls `__TAURI_INTERNALS__.invoke` directly,
  which the plugin cannot patch).

## Layout

- `wdio.conf.js` — service config (embedded provider, scratch app-data dir).
- `specs/convert.e2e.js` — the one spec.
- `out/` — temp outputs from specs (gitignored).
- `.e2e-home/` — scratch app-data dir (gitignored).
- `logs/` — wdio backend/frontend logs (gitignored).
