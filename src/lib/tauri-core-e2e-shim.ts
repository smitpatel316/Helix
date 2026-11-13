// E2E only (spike/tauri-e2e): alias target for "@tauri-apps/api/core" in e2e
// builds (see vite.config.ts — the alias applies only when VITE_E2E=1).
// Re-exports the real core module, except `invoke`, which consults the
// WebdriverIO mocks (`window.__wdio_mocks__`, installed by
// `browser.tauri.mock(...)`) before falling through to the real invoke.
//
// Why this exists: a Vite-bundled frontend calls `__TAURI_INTERNALS__.invoke`
// directly, which is non-writable, so the @wdio/tauri-plugin's patch of
// `window.__TAURI__.core.invoke` never intercepts the app's own invokes and
// mocks silently never fire (que-lindo spike, 2026-09-07). Routing the import
// through this shim is what makes dialog mocking work.
//
// The relative import below is deliberate: it imports the real core module by
// file path, so the Vite alias (which only matches the bare specifier
// "@tauri-apps/api/core") does not redirect it back to this shim.
export * from "../../node_modules/@tauri-apps/api/core.js";
import { invoke as realInvoke } from "../../node_modules/@tauri-apps/api/core.js";
import type { InvokeArgs, InvokeOptions } from "../../node_modules/@tauri-apps/api/core.js";

export async function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  const mocks = (
    window as unknown as { __wdio_mocks__?: Record<string, (args: unknown) => unknown> }
  ).__wdio_mocks__;
  const mock = mocks?.[cmd];
  if (typeof mock === "function") return mock(args) as Promise<T>;
  return realInvoke<T>(cmd, args, options);
}
