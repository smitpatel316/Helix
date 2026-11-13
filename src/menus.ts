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

export const separator = { item: "Separator" } as const;

// The icon comes from the app bundle. GitHub and Buy Me a Coffee are in the Help menu.
const ABOUT = {
  name: "Titer", // spelled out: in development the process is named "titer"
  version,
  // No shortVersion: Tauri renders one as "(<short>)" after the version, so an
  // empty string showed "1.0.7 ()". Omitting it shows just the version.
  // The coffee address is in the credits because the About dialog has no
  // link field on macOS (AboutMetadata.website is Windows/Linux only).
  credits: "Scientific data analysis, simplified.\nBuy Me a Coffee: https://www.buymeacoffee.com/smitpatel316",
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
 *  drops a recent project that is gone. */
export function projectItems(
  recents: string[],
  forgetRecent: (path: string) => void,
  clearRecents: () => void,
): MenuItems {
  const recentItems = recents.length
    ? [
        ...recents.map((path) => ({
          text: fileName(path),
          action: () => openProjectsOrSay([path], forgetRecent),
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
