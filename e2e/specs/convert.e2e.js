// The Convert dialog, both directions — the spike's one spec (spike/tauri-e2e,
// v2 backlog item 76).
//
// Pass criteria (all three must hold):
//   1. FAILS on the pre-fix tip 3cd7dc4 (the dialog stalls on its progress line).
//   2. PASSES on 2f8eca2 (the rAF await is a setTimeout yield).
//   3. Works with the window UNFOCUSED — nothing here focuses the window, and
//      the run happens under bare Xvfb (no window manager), so no window is
//      ever the active one. That is the exact condition that stalled the
//      dialog in the Mac proof.
//
// What is driven for real: the dialog UI (radio, buttons, progress, report),
// the real converter (convertPrism / writePrism on real fixtures), the real
// file writes, and the real project load ("Open in Titer").
// What is NOT driven: the native file pickers (WebDriver cannot drive them)
// — the pick is delivered by mocking the picker invoke (see below), and the
// native menu (File > Convert) — the dialog is opened through the e2e hook
// (window.__titerE2E.openConverter), since menus are not WebDriver-drivable.
// Both stay manual Mac-proof items.
//
// Mocking: browser.tauri.mock() only intercepts invokes that go through the
// app's bundled "@tauri-apps/api/core" import, which this spike routes through
// the mock-consulting shim (src/lib/tauri-core-e2e-shim.ts, VITE_E2E=1 only).
//   - dir 1: "choose_prism_file" is mocked to return immediately (no native
//     panel opens); the pick is then delivered by emitting the
//     "prism-file-picked" event the dialog listens for, with the fixture path.
//   - dir 2: "plugin:dialog|save" is mocked to resolve to a temp path, so
//     "Save .prism…" writes a real file the spec asserts on disk.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO = path.resolve(__dirname, "../..");
const PRISM_FIXTURE = path.join(REPO, "tests/testdata/prism/prism2R-demo_dataset.prism");
const OUT_DIR = path.resolve(__dirname, "../out");
const OUT_PRISM = path.join(OUT_DIR, "converted.prism");

const DONE_TIMEOUT = 30000;

// The app is an engine window (hidden, runs webR) plus one window per project.
// The session may start on either — find the project window by URL.
async function switchToProjectWindow() {
  const handles = await browser.getWindowHandles();
  for (const handle of handles) {
    try {
      await browser.switchToWindow(handle);
      const url = await browser.getUrl();
      if (!url.includes("engine")) return;
    } catch {
      // A hidden window may refuse the switch; try the next handle.
    }
  }
  throw new Error(`no project window among ${handles.length} handles`);
}

// The daily update check can pop a "1.0.9 available" dialog on first launch
// (fresh app-data dir). Dismiss it if it is there; no-op if it is not.
async function dismissUpdateDialog() {
  try {
    const later = await $("button=Later");
    if (await later.isExisting()) await later.click();
  } catch {
    // No update dialog — nothing to dismiss.
  }
}

async function openConverter() {
  const hook = await browser.tauri.execute(() => typeof window.__titerE2E?.openConverter);
  assert.equal(hook, "function", "e2e hook window.__titerE2E.openConverter is missing");
  await browser.tauri.execute(() => window.__titerE2E.openConverter());
  await $("button*=Choose .prism file").waitForExist({ timeout: 15000 });
}

describe("Convert dialog", () => {
  before(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    await switchToProjectWindow();
    await dismissUpdateDialog();
    // macOS only: the app launches as the key app, which would let
    // requestAnimationFrame fire and mask the pre-fix stall. Move focus to
    // Finder so the window is unfocused during the Convert steps — the exact
    // condition that stalled the dialog in the Mac proof. Linux runs under
    // bare Xvfb, where no window is ever focused — no-op there.
    if (process.platform === "darwin") {
      try {
        execSync("open -a Finder");
      } catch {
        // Focus was already elsewhere; nothing to move.
      }
    }
  });

  // Dir 1 runs first: it needs no seeded project (the dialog converts a file,
  // not the current project), and its output — the converted project, opened
  // in Titer — seeds dir 2. (The bundled sample cannot seed dir 2: it holds a
  // Nested table, which Prism has no matching type for, so writePrism throws.
  // The converted project round-trips cleanly: 14 tables in, 14 tables out.)
  it("converts .prism → .hlx and opens the result in Titer", async () => {
    await openConverter();
    // Default direction is Prism → Titer. The picker is native — mock the
    // invoke so no panel opens, then deliver the pick as the event the dialog
    // listens for.
    const pickMock = await browser.tauri.mock("choose_prism_file");
    await pickMock.mockResolvedValue(undefined);
    await $("button*=Choose .prism file").click();
    await browser.tauri.execute(
      (tauri, prismPath) => window.__TAURI__.event.emit("prism-file-picked", prismPath),
      PRISM_FIXTURE,
    );
    // The stall point is the await before convertPrism: on the pre-fix tip the
    // progress line ("Reading tables…") never advances, so this wait times
    // out and the test fails — the expected pre-fix result.
    await $("pre*=Tables transferred: 14").waitForExist({
      timeout: DONE_TIMEOUT,
      timeoutMsg: "Convert stalled: no done report within 30s (pre-fix symptom)",
    });

    await $("button=Open in Titer").click();
    await browser.waitUntil(
      async () => (await $('[aria-label="Project"]').getText()).includes("Survival: Two groups"),
      { timeout: 30000, timeoutMsg: "converted project did not open" },
    );
  });

  it("converts .hlx → .prism and saves a valid Prism 10 file", async () => {
    await openConverter();
    // Switch direction to Titer → Prism (current project is the converted one).
    await $("label*=Titer (this project)").click();
    await $("button*=Convert this project").click();
    // Same stall point as dir 1, other direction: on the pre-fix tip this
    // wait times out and the test fails, which is the expected pre-fix result.
    await $("pre*=Tables written: 14").waitForExist({
      timeout: DONE_TIMEOUT,
      timeoutMsg: "Convert stalled: no done report within 30s (pre-fix symptom)",
    });

    // The save panel is native — mock it to a temp path instead of driving it.
    const saveMock = await browser.tauri.mock("plugin:dialog|save");
    await saveMock.mockResolvedValue(OUT_PRISM);
    await $("button*=Save .prism").click();
    await $("p*=Saved to").waitForExist({ timeout: 15000 });

    assert.ok(fs.existsSync(OUT_PRISM), `no output file at ${OUT_PRISM}`);
    const bytes = fs.readFileSync(OUT_PRISM);
    assert.ok(bytes.length > 0, "output file is empty");
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "PK\u0003\u0004", "output is not a ZIP");
    assert.ok(bytes.includes(Buffer.from("document.json")), "output ZIP has no document.json");
  });
});
