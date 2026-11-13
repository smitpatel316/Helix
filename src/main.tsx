import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ProjectProvider } from "./store/use-project-store";
import { LayoutProvider } from "./store/use-layout";
import { AppShell } from "./components/app-shell";
import { connectR } from "./stats/webr";
import { accentColor, cancelR, evalR, isNative, onEngineReset, onFocusChange } from "./native";
import { checkForUpdatesDaily } from "./updates";
import "./styles.css";

// E2E only (VITE_E2E=1 at build time, spike/tauri-e2e): the WebdriverIO Tauri
// plugin, which exposes window.wdioTauri for browser.tauri.execute/mock.
// Never in production bundles — Vite replaces import.meta.env.VITE_E2E at
// build time, so the branch is dead-code-eliminated when the flag is unset.
if ((import.meta.env as Record<string, string | undefined>).VITE_E2E) {
  void import("@wdio/tauri-plugin");
}

// Highlights take the accent color chosen in System Settings, read again whenever
// the window comes to the front (it can only change while System Settings is).
const syncAccent = () =>
  void accentColor().then((color) => color && document.documentElement.style.setProperty("--accent", color));
onFocusChange((focused) => focused && syncAccent());

// Analyses run in the app's one R, in the engine window (engine.ts). In a plain
// browser (`npm run web`), this page starts its own R at the first analysis.
// `cancelR` is the watchdog's / Cancel button's way to stop that R.
if (isNative) connectR(evalR, cancelR);
// The engine window (re)starting voids this window's installed-package
// states (R3-02): listen for its broadcast, so the next analysis
// reinstalls instead of failing with `there is no package called '…'`.
void onEngineReset();

// Whether a newer Titer is out, at most once a day.
checkForUpdatesDaily();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ProjectProvider>
      <LayoutProvider>
        <AppShell />
      </LayoutProvider>
    </ProjectProvider>
  </StrictMode>,
);
