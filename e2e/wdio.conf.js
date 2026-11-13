// WebdriverIO config for the Tauri e2e spike (spike/tauri-e2e, v2 backlog item 76).
//
// Runs the DEBUG binary (built with `npm run e2e:build`, i.e. VITE_E2E=1 +
// `tauri build --debug --no-bundle`) under the embedded WebDriver provider —
// the in-app server from tauri-plugin-wdio-webdriver, debug builds only.
// One app instance, one spec file at a time (maxInstances: 1).
//
// Isolation: the app runs with a scratch XDG_DATA_HOME / XDG_CONFIG_HOME /
// XDG_CACHE_HOME under e2e/.e2e-home/, so e2e runs never touch the real
// app-data dir (recents, session restore, window state) — and never Smit's
// real data. Fixtures live in the repo (tests/testdata/, samples/); no Mansi
// files, ever.
//
// Focus: nothing in this config focuses the window. The Convert spec must pass
// with the window unfocused (background-driven, the exact condition that
// stalled the dialog pre-fix) — that is the point of the spike.
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const E2E_HOME = path.resolve(__dirname, ".e2e-home");

export const config = {
  runner: "local",
  specs: ["./e2e/specs/**/*.e2e.js"],
  maxInstances: 1,
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: "./src-tauri/target/debug/titer",
        driverProvider: "embedded",
        startTimeout: 90000,
        captureBackendLogs: true,
        captureFrontendLogs: true,
        logDir: "./e2e/logs",
        // Scratch app-data dir (see header). Merged with process.env and passed
        // to the spawned app by the embedded provider.
        env: {
          XDG_DATA_HOME: path.join(E2E_HOME, "data"),
          XDG_CONFIG_HOME: path.join(E2E_HOME, "config"),
          XDG_CACHE_HOME: path.join(E2E_HOME, "cache"),
        },
      },
    ],
  ],
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: "./src-tauri/target/debug/titer",
      },
    },
  ],
  logLevel: "info",
  bail: 0,
  waitforTimeout: 15000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 120000,
  },
};
