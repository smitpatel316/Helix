// The parts of the menu bar that don't depend on a project, shared by the project
// windows' menu bar (app-menu.ts) and the one the engine window sets while no
// project window is open (engine.ts).
import {
  alert,
  chooseProject,
  installMenuBar,
  newProject,
  openLink,
  openProjects,
  openSample,
  type MenuItems,
} from "./native";
import { fileName } from "./lib/paths";
import { checkForUpdates } from "./updates";
import { version } from "../package.json";
import { recentLabel, type RecentEntry } from "./store/recents";

export const separator = { item: "Separator" } as const;

// The icon comes from the app bundle. GitHub and Buy Me a Coffee are in the Help menu.
const COFFEE_URL = "https://www.buymeacoffee.com/smitpatel316";
// The coffee address is in the credits because the About dialog has no
// link field on macOS (AboutMetadata.website is Windows/Linux only).
// Credits are macOS-only, so Linux/Windows never saw the tagline or the
// coffee address: their native dialog renders comments and website instead
// (muda drops credits on those platforms), hence the same text here —
// comments as visible text, website as the clickable link.
// NOTE: the Mac panel in practice renders the bundle's values, not this
// metadata (v1.1 showed "Version 1.1.0 (1.1.0)" and the one-line bundle
// copyright, no credits) — so the credits that actually show on macOS
// come from src-tauri/Credits.rtf, shipped as a bundle resource. Keep
// the two in sync: this metadata for Linux/Windows, the RTF for macOS.
const ABOUT_CREDITS = `Scientific data analysis, simplified.\nBuy Me a Coffee: ${COFFEE_URL}`;
const ABOUT = {
  name: "Titer", // spelled out: in development the process is named "titer"
  version,
  // No shortVersion: Tauri renders one as "(<short>)" after the version, so an
  // empty string showed "1.0.7 ()". Omitting it shows just the version.
  credits: ABOUT_CREDITS,
  comments: ABOUT_CREDITS,
  website: COFFEE_URL,
  websiteLabel: "Buy Me a Coffee",
  copyright: "© 2026 mickaphd\nFree and open source. No warranty.",
};

/** Says a project file is gone (moved or deleted since). */
export const sayGone = (path: string) =>
  alert("Couldn't Open Project", `“${fileName(path)}” couldn't be found. It may have been moved or deleted.`, "error");

/** Opens projects (native.openProjects); one that is gone is said, and `forget` drops it. */
export function openProjectsOrSay(paths: string[], forget: (path: string) => void = () => {}) {
  openProjects(paths).catch((gone: unknown) => {
    void sayGone(String(gone));
    forget(String(gone));
  });
}

/** File ▸ New Project, Open…, Open Recent: how every File menu starts. `forgetRecent`
 *  drops a recent project that is gone. Remote entries open from the cloud
 *  (via `openRemoteEntry`); without a project window to load into, a caller
 *  passes none and remote entries are left out by filtering first. */
export function projectItems(
  recents: RecentEntry[],
  forgetRecent: (entry: RecentEntry) => void,
  clearRecents: () => void,
  openRemoteEntry?: (entry: RecentEntry) => void,
): MenuItems {
  const recentItems = recents.length
    ? [
        ...recents.map((entry) => ({
          text: recentLabel(entry),
          action: () =>
            entry.kind === "local"
              ? openProjectsOrSay([entry.path], (gone) => forgetRecent({ kind: "local", path: gone }))
              : openRemoteEntry?.(entry),
        })),
        separator,
        { text: "Clear Menu", action: clearRecents },
      ]
    : [{ text: "No Recent Projects", enabled: false }];
  return [
    { text: "New Project", accelerator: "CmdOrCtrl+N", action: () => void newProject() },
    { text: "Open…", accelerator: "CmdOrCtrl+O", action: () => void chooseProject() },
    { text: "Open Recent", items: recentItems },
  ];
}

/** Sets the app's menu bar: the Titer menu, `menus`, then Window and Help. */
export function setMenuBar(menus: MenuItems) {
  const titer = {
    text: "Titer",
    items: [
      { item: { About: ABOUT }, text: "About Titer" },
      { text: "Check for Updates…", action: () => void checkForUpdates() },
      separator,
      { item: "Services" },
      separator,
      { item: "Hide", text: "Hide Titer" },
      { item: "HideOthers" },
      { item: "ShowAll" },
      separator,
      // The shell closes every project window first: each asks about its unsaved changes.
      { item: "Quit", text: "Quit Titer" },
    ],
  } as const;
  return installMenuBar(
    [titer, ...menus],
    [{ item: "Minimize" }, { item: "Maximize" }, separator, { item: "BringAllToFront" }],
    [
      { text: "Titer on GitHub", action: () => openLink("github") },
      { text: "Buy Me a Coffee", action: () => openLink("coffee") },
      separator,
      { text: "Sample Project", action: () => void openSample() },
    ],
  );
}
