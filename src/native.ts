// The only module that talks to the native shell (Tauri): dialogs, files, the R engine,
// the window, the project windows and what they open, and the menus. Everything else in
// the app is plain web code.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalPosition } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getVersion, setTheme as setAppTheme } from "@tauri-apps/api/app";
import { Image } from "@tauri-apps/api/image";
import { Menu, Submenu, type MenuOptions } from "@tauri-apps/api/menu";
import { message, save } from "@tauri-apps/plugin-dialog";
import type { RVector } from "./stats/webr";
import { cancelActiveEvals, interruptR, resetR } from "./stats/webr";
import {
  createEvalQueue,
  setRQueueSnapshot,
  type RQueueSnapshot,
} from "./stats/r-queue";
import type {
  CloudAccount,
  CloudStatus,
  ProviderId,
  RemoteDownload,
  RemoteEntry,
  RemoteVersion,
} from "./lib/cloud";

/** False when the UI runs in a plain browser (`npm run web`, for development) or in the tests. */
export const isNative = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const win = () => getCurrentWindow();

// ── Dialogs ────────────────────────────────────────────────────────────

/** Native alert: `title` in bold, `detail` below it. */
export async function alert(title: string, detail = "", kind: "info" | "warning" | "error" = "warning") {
  if (isNative) await message(detail, { title, kind });
  else window.alert(`${title}\n\n${detail}`);
}

/** The Save / Don't Save / Cancel prompt shown before unsaved work is discarded. */
export async function askToSave(): Promise<"save" | "discard" | "cancel"> {
  const answer = await message("Your changes will be lost if you don't save them.", {
    title: "Do you want to save the changes you made to your project?",
    kind: "warning",
    buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" },
  });
  if (answer === "Save" || answer === "Yes") return "save";
  if (answer === "Don't Save" || answer === "No") return "discard";
  return "cancel";
}

/** A Delete / Cancel confirmation. */
export async function confirmDelete(title: string, detail: string): Promise<boolean> {
  if (!isNative) return window.confirm(`${title}\n\n${detail}`);
  const answer = await message(detail, { title, kind: "warning", buttons: { ok: "Delete", cancel: "Cancel" } });
  return answer === "Delete" || answer === "Ok";
}

/** An Update Now / Later prompt for a newer version of Titer. `forced`:
 *  no Later — the channel says this version must not run, so the dialog
 *  has only Update Now. `installable`: false on a platform with no
 *  installable asset (Linux today) — the prompt then offers the manual
 *  download instead of promising a restart-to-install. */
export async function askToUpdate(version: string, forced: boolean, installable: boolean): Promise<boolean> {
  const detail = !installable
    ? "Download it from GitHub, then replace Titer in your Applications folder."
    : forced
      ? "This version can no longer run — update to keep using Titer."
      : "Download it now, and Titer will restart to install it.";
  const answer = await message(detail, {
    title: `Titer ${version} is available`,
    kind: "info",
    buttons: forced ? { ok: "Update Now" } : { ok: "Update Now", cancel: "Later" },
  });
  return answer === "Update Now" || answer === "Ok";
}

/** A Retry / Quit prompt when a forced update cannot install. */
export async function askToRetryUpdate(version: string, detail: string): Promise<boolean> {
  const answer = await message(`Titer ${version} could not be installed: ${detail}`, {
    title: "Couldn't Install the Update",
    kind: "warning",
    buttons: { ok: "Retry", cancel: "Quit" },
  });
  return answer === "Retry" || answer === "Ok";
}

/** This app's version ("1.0.0"), from its bundle. */
export const appVersion = getVersion;

/** `defaultPath` may be a bare file name; the panel then picks the folder. */
export function pickSavePath(title: string, defaultPath: string, name: string, ext: string) {
  return save({ title, defaultPath, filters: [{ name, extensions: [ext] }] });
}

// ── Files ──────────────────────────────────────────────────────────────

export const readText = (path: string) => invoke<string>("read_text", { path });

/** Atomic write (temp file + rename). Bytes go as a raw body, not JSON. */
export function writeFile(path: string, data: string | Uint8Array) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return invoke("write_file", bytes, { headers: { path: encodeURIComponent(path) } });
}

/** My Palettes' file in Titer's data folder: its text ("" before the first), and a new one. */
export const readMyPalettes = () => invoke<string>("read_my_palettes");
export const writeMyPalettes = (text: string) => invoke("write_my_palettes", { text });

// ── R engine ───────────────────────────────────────────────────────────
// One R for the whole app, in the hidden "engine" window. The native shell
// passes each request there and its answer back (see main.rs, `REngine`).

/** From a project window: runs R code in the engine. */
export function evalR(code: string): Promise<RVector> {
  return invoke<RVector>("eval_r", { code }).catch((err: unknown) => {
    throw new Error(String(err));
  });
}

/** From a project window: stop this window's own R work in the engine, if
 *  any is. The shell drops only this window's waiting requests and tells
 *  the engine window which ones, so a queued evaluation is dequeued
 *  without touching R — another window's in-flight install is left alone
 *  (FL-F14). From the engine window (its stuck-engine recovery) it drops
 *  every waiting request instead. Best effort, never throws. */
export async function cancelR(): Promise<void> {
  if (!isNative) return;
  try {
    await invoke("cancel_r");
  } catch {
    // Best effort: the caller's watchdog rejects with the timeout/cancel
    // error either way.
  }
}

/** In the engine window: answers every request with `evaluate`, one at a
 *  time, in arrival order — the app's explicit FIFO (M17: webR serializes
 *  internally too, but that queue is invisible; this one publishes its
 *  state on "r-queue" so project windows can show a queue position instead
 *  of bare "Running…"). A request cancelled by its window is dequeued
 *  (FL-F14), so a queued check's cancel never touches the running
 *  evaluation; a request whose caller gave up some other way still runs
 *  once when it reaches the front — the shell discards its late result —
 *  so a cancelled caller never wedges the queue. */
export async function serveR(evaluate: (code: string) => Promise<RVector>) {
  // The engine (re)started: until it says it is ready, no request may be
  // sent straight to it (R3-03). The shell clears its `ready` flag here,
  // so a request arriving between this window's listeners attaching and
  // `r_ready` is queued once and re-sent once — never emitted twice.
  await invoke("r_starting");
  const queue = createEvalQueue((snapshot) => {
    setRQueueSnapshot(snapshot);
    // Best effort: project windows listen for "r-queue" and show the depth.
    void getCurrentWebviewWindow().emit("r-queue", snapshot).catch(() => {});
  });
  await getCurrentWebviewWindow().listen<[number, string]>("r-eval", ({ payload: [id, code] }) =>
    queue.enqueue(() => evaluate(code), id).then(
      (values) => invoke("r_result", { id, values }),
      (err: unknown) => invoke("r_result", { id, error: err instanceof Error ? err.message : String(err) }),
    ),
  );
  // A project window cancelled its own requests (its watchdog fired, or
  // the user hit Cancel): the shell dropped them and sends their ids.
  // Dequeue the ones still waiting — without touching R — and interrupt R
  // only if the evaluation now running is one of them. A queued cancel
  // used to clear every window's waiting requests and restart the engine,
  // killing another window's in-flight install (FL-F14).
  await getCurrentWebviewWindow().listen<number[]>("r-cancel", ({ payload: ids }) => {
    if (queue.cancel(ids).runningCancelled) {
      // A bare interrupt is a no-op on Tauri's PostMessage channel, so it
      // alone would leave the engine wedged until the 5-minute watchdog
      // budget ran out (R3-03): abort this window's live evaluations too,
      // which starts their watchdog's 5-second grace — if R is still stuck
      // after it, the engine is abandoned and reloaded (onEngineStuck).
      // The queue runs one evaluation at a time, and `runningCancelled`
      // means that one is the canceller's, so no other window's work is
      // touched.
      interruptR();
      cancelActiveEvals();
    }
  });
  // The engine window itself asked R to stop (its stuck-engine recovery,
  // before the reload): interrupt this window's R, and abort its live
  // evaluations so the watchdog's grace / reload escalation runs even
  // where the interrupt itself is a no-op (R3-03).
  await getCurrentWebviewWindow().listen("r-interrupt", () => {
    interruptR();
    cancelActiveEvals();
  });
  await invoke("r_ready");
}

/** In a project window: keeps this window's copy of the R queue's state
 *  current (the engine window publishes "r-queue" whenever it changes).
 *  No-op outside the app (tests, `npm run web`) — the snapshot stays null
 *  there. Returns the unlisten function. */
export async function onRQueue() {
  if (!isNative) return () => {};
  return getCurrentWebviewWindow().listen<RQueueSnapshot>("r-queue", ({ payload }) => setRQueueSnapshot(payload));
}

/** In a project window: the engine window (re)started, so its R is fresh
 *  with an empty VFS — this window's installed-package states are void
 *  with it (R3-02). Clear them (`resetR`), or the next analysis would see
 *  its packages `ready`, skip the install, and fail with `there is no
 *  package called '…'` in the fresh engine. The shell broadcasts
 *  "r-reset" from `r_ready` (main.rs) on every engine start, including
 *  the first boot (when there is nothing to clear). No-op outside the app.
 *  Returns the unlisten function. */
export async function onEngineReset() {
  if (!isNative) return () => {};
  return getCurrentWebviewWindow().listen("r-reset", () => resetR());
}

// ── Window ─────────────────────────────────────────────────────────────

/** The window's title, and what the shell needs to know of its project: its file,
 *  its unsaved changes (the dot in the close button), and whether it is blank. */
export function setDocument(title: string, path: string | null, edited: boolean, blank: boolean) {
  if (!isNative) return;
  void win().setTitle(title);
  void invoke("set_document", { path, edited, blank });
}

/** Recent projects (newest first), also listed by macOS in the Dock icon's menu. */
export function setRecentDocuments(paths: string[]) {
  if (isNative) void invoke("set_recent_documents", { paths });
}

/** Run `canClose` whenever the window is about to close (red button, ⌘W, ⌘Q). A window
 *  that stays open while Titer quits stops the quitting. */
export function onCloseRequested(canClose: () => Promise<boolean>) {
  if (!isNative) return () => {};
  const off = win().onCloseRequested(async (event) => {
    if (await canClose()) return;
    event.preventDefault();
    void invoke("cancel_quit");
  });
  return () => void off.then((f) => f());
}

/** The accent color chosen in System Settings ▸ Appearance (#RRGGBB), or null. */
export const accentColor = () => (isNative ? invoke<string | null>("accent_color") : Promise.resolve(null));

// One request at a time: two sent together may reach the shell in either order, and a
// wheel shown after it was taken away would spin for ever.
let spinner = Promise.resolve();

/** macOS's spinning wheel over this window, centered at `at` (x, y from its top left); null takes it away. */
export function setSpinner(at: [number, number] | null) {
  spinner = spinner.then(() => invoke<void>("set_spinner", { at })).catch(() => {});
}

/** Titer's GitHub page, its releases, or Buy Me a Coffee, in the default browser. */
export const openLink = (link: "github" | "releases" | "coffee") => void invoke("open_link", { link });

// ── Updates ──────────────────────────────────────────────────────────────
// The shell side lives in src-tauri/src/updater.rs.

/** Downloads the update asset to a temp file and checks its size and
 *  sha256 against the manifest; the temp path. */
export const downloadUpdate = (url: string, sha256: string, size: number) =>
  invoke<string>("download_update", { url, sha256, size });

/** Verifies the downloaded asset's version stamp and stages the bundle
 *  swap. Resolves once the swap is staged; the caller then quits, and a
 *  helper swaps the bundle once this process has exited and opens the new
 *  app. */
export const applyUpdate = (path: string, version: string) =>
  invoke<string>("apply_update", { path, version });

/** Quits through the normal flow, as Titer ▸ Quit does: each project
 *  window asks about its unsaved changes first. */
export const quitApp = () => invoke("quit_app");
/** Opens a URL in the default browser. Only provider authorize hosts are
 *  allowed (the shell refuses anything else) — used for OAuth sign-in, so
 *  the webview never sees credentials. */
export const openUrl = (url: string) => invoke<void>("open_url", { url });

// ── Cloud storage (v2 item 75, Box first) ────────────────────────────────
// The page only ever sees account identity, listings, and file bytes — never
// a token. All errors arrive as `{ kind, ... }` (see src/lib/cloud.ts).
/** Connected accounts + whether Box has credentials saved (BYO) or a broker. */
export const cloudStatus = () => invoke<CloudStatus>("cloud_status");

/** Saves the user's own Box app credentials (client id + secret) to the OS
 *  keychain. They are validated at connect time, not here. */
export const cloudSaveBoxCredentials = (client_id: string, client_secret: string) =>
  invoke<void>("cloud_save_box_credentials", { client_id, client_secret });

/** The Box connect flow: opens Box sign-in in the system browser and waits
 *  for it (up to 5 minutes). Resolves with the connected account. */
export const cloudConnectBox = () => invoke<CloudAccount>("cloud_connect_box");

/** Disconnect: revokes server-side AND deletes the keychain entry. */
export const cloudDisconnect = (provider: ProviderId, account_id: string) =>
  invoke<void>("cloud_disconnect", { provider, account_id });

/** The entries of a remote folder (`"0"` is the Box root). */
export const cloudList = (provider: ProviderId, account_id: string, folder_id: string) =>
  invoke<RemoteEntry[]>("cloud_list", { provider, account_id, folder_id });

/** Downloads a remote file (and writes the local cache copy). */
export const cloudDownload = (provider: ProviderId, account_id: string, file_id: string) =>
  invoke<RemoteDownload>("cloud_download", { provider, account_id, file_id });

/** The cache copy of a remote file, for opening while offline. */
export const cloudReadCache = (provider: ProviderId, file_id: string, name: string) =>
  invoke<RemoteDownload>("cloud_read_cache", { provider, file_id, name });

/** Saves a new remote version, conditional on `expected_version` when
 *  given (`null` = overwrite anyway — the conflict dialog's explicit third
 *  choice only). Returns the new version. */
export const cloudUpload = (
  provider: ProviderId,
  account_id: string,
  file_id: string,
  name: string,
  base64: string,
  expected_version: string | null,
) => invoke<RemoteVersion>("cloud_upload", { provider, account_id, file_id, name, base64, expected_version });

/** A new remote file in `folder_id` ("Save as a copy" lands here). */
export const cloudUploadNew = (
  provider: ProviderId,
  account_id: string,
  folder_id: string,
  name: string,
  base64: string,
) => invoke<RemoteEntry>("cloud_upload_new", { provider, account_id, folder_id, name, base64 });

export const cloudCreateFolder = (provider: ProviderId, account_id: string, parent_id: string, name: string) =>
  invoke<RemoteEntry>("cloud_create_folder", { provider, account_id, parent_id, name });

export const cloudMove = (
  provider: ProviderId,
  account_id: string,
  file_id: string,
  new_parent_id: string,
  is_folder: boolean,
) => invoke<RemoteEntry>("cloud_move", { provider, account_id, file_id, new_parent_id, is_folder });

export const cloudMetadata = (provider: ProviderId, account_id: string, file_id: string) =>
  invoke<RemoteEntry>("cloud_metadata", { provider, account_id, file_id });

export const cloudRevisions = (provider: ProviderId, account_id: string, file_id: string) =>
  invoke<RemoteVersion[]>("cloud_revisions", { provider, account_id, file_id });

/** Calls `handler` now and whenever the window enters or leaves full screen. */
export function onFullscreenChange(handler: (fullscreen: boolean) => void) {
  if (!isNative) return () => {};
  const check = () => void win().isFullscreen().then(handler);
  check();
  const off = win().onResized(check);
  return () => void off.then((f) => f());
}

/** Calls `handler` now and whenever the window comes to the front or goes behind another. */
export function onFocusChange(handler: (focused: boolean) => void) {
  if (!isNative) return () => {};
  void win().isFocused().then(handler);
  const off = win().onFocusChanged(({ payload }) => handler(payload));
  return () => void off.then((f) => f());
}

export type Theme = "system" | "light" | "dark";

/** The appearance of every window. */
export function setTheme(theme: Theme) {
  if (isNative) void setAppTheme(theme === "system" ? null : theme);
}

// ── Projects ───────────────────────────────────────────────────────────
// Each project has its own window. The shell knows which window holds which
// file, so it decides where a project opens (see main.rs, `Projects`).

/** A project file for a window to open; `untitled`: as a new document, like the sample. */
type Opening = { path: string; untitled: boolean };

/** Opens projects: in their window if they're open, in this one if it's blank, else in new
 *  ones. Rejects with the path of a file that is gone, and opens nothing. */
export const openProjects = (paths: string[]) => invoke("open_projects", { paths });

/** The sample project, which ships inside the app, as a new document. */
export const openSample = () => invoke("open_sample");

/** A new window with a new project. */
export const newProject = () => invoke("new_project");

/** File ▸ Open…: the Open panel, then the chosen project opens as `openProjects` decides. */
export const chooseProject = () => invoke("choose_project");

/** File ▸ Import Prism File…: the Open panel for a Prism file (`.pzfx` or `.prism`).
 *  Non-blocking: the invoke returns at once, and the shell emits
 *  "prism-file-picked" with the path, or null on Cancel, once the user
 *  picks. A blocking picker here deadlocked the app (Nov 9, macOS +
 *  Linux): it parked the main thread while the panel needed that thread
 *  to process clicks. */
export const choosePrismFile = () => invoke("choose_prism_file");

/** Calls `handler` once with the path picked in the Import Prism File
 *  panel, or null if the user cancelled. Await it before opening the
 *  panel so the pick is never missed; it returns the unlisten function. */
export async function onPrismFilePicked(handler: (path: string | null) => void) {
  if (!isNative) return () => {};
  return getCurrentWebviewWindow().listen<string | null>("prism-file-picked", ({ payload }) => handler(payload));
}

/** A Prism `.pzfx` file's text, for import. */
export const readPrismText = (path: string) => invoke<string>("read_prism_text", { path });

/** A Prism `.prism` file's bytes, for import — a `.prism` file is a ZIP, so
 *  text won't do. The shell returns base64; this decodes it. */
export async function readPrismBytes(path: string): Promise<Uint8Array> {
  const base64 = await invoke<string>("read_prism_bytes", { path });
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** In the engine window: calls `handler` when the last project window has closed. */
export function onNoWindows(handler: () => void) {
  if (!isNative) return () => {};
  const off = getCurrentWebviewWindow().listen("no-windows", handler);
  return () => void off.then((f) => f());
}

/** Calls `handler` with what this window should open: once its page is ready, and
 *  whenever the shell gives it more (⌘O, Open Recent, the Finder, the Dock). */
export function onOpening(handler: (opening: Opening) => void) {
  if (!isNative) return () => {};
  const take = () => invoke<Opening | null>("take_opening").then((opening) => opening && handler(opening));
  // Listening first: an opening given while this window takes the first is not lost.
  const off = getCurrentWebviewWindow().listen("opening", take);
  void off.then(take);
  return () => void off.then((f) => f());
}

/** Calls `handler` with the files dropped on the window. */
export function onDrop(handler: (paths: string[]) => void) {
  if (!isNative) return () => {};
  const off = getCurrentWebviewWindow().onDragDropEvent(({ payload }) => {
    if (payload.type === "drop") handler(payload.paths);
  });
  return () => void off.then((f) => f());
}

// ── Menus ──────────────────────────────────────────────────────────────

export type MenuItems = NonNullable<MenuOptions["items"]>;

// Menus made here live in the shell until closed, even once replaced: each one is
// closed when it's done with, or they would pile up until Titer quits.
let menuBar: (Menu | Submenu)[] = [];
// One menu bar is installed at a time, in the order asked: an earlier one, slower to
// build, never ends up over a later one.
let installing: Promise<void> = Promise.resolve();

/** Installs the app's menu bar: `menus`, then Window and Help, which macOS fills with
 *  the open windows and its menu search. */
export function installMenuBar(menus: MenuItems, windowItems: MenuItems, helpItems: MenuItems): Promise<void> {
  if (!isNative) return Promise.resolve();
  const install = async () => {
    const windows = await Submenu.new({ text: "Window", items: windowItems });
    const help = await Submenu.new({ text: "Help", items: helpItems });
    const menu = await Menu.new({ items: [...menus, windows, help] });
    await menu.setAsAppMenu();
    await windows.setAsWindowsMenuForNSApp();
    await help.setAsHelpMenuForNSApp();
    const replaced = menuBar;
    menuBar = [menu, windows, help];
    for (const old of replaced) void old.close();
  };
  return (installing = installing.then(install, install));
}

/** A menu item's picture: RGBA pixels, shown 18 points high (36 pixels on Retina). */
export type Picture = { rgba: Uint8Array; width: number; height: number };
type PictureItem = { text: string; icon: Picture; action: () => void };
type PopupItem = MenuItems[number] | PictureItem | { text: string; items: PopupItem[] };
const isPicture = (icon: unknown): icon is Picture =>
  typeof icon === "object" && icon !== null && (icon as Picture).rgba instanceof Uint8Array;

// macOS leaves 8 points more right of a menu's pictures than left of them (room for key
// equivalents): in a menu of pictures alone, each gets that much more on its left
// (16 pixels on Retina), so it shows centered.
const CENTERING = 16;

/** `picture` with `by` transparent pixels more on its left. */
function shifted({ rgba, width, height }: Picture, by: number): Picture {
  const wider = new Uint8Array((width + by) * height * 4);
  for (let y = 0; y < height; y++) {
    wider.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), (y * (width + by) + by) * 4);
  }
  return { rgba: wider, width: width + by, height };
}

/** Shows a native context menu at the pointer (the call returns once it has closed). An
 *  item may show a picture before its text, in a submenu too. With the click `event`,
 *  the menu pops up at the click's position in this window: on macOS a position-less
 *  popup takes muda's nil-view + mouse-location branch, which parked the main thread
 *  inside NSMenu's tracking loop and destroyed every window (QAB-1). */
export async function popupMenu(items: PopupItem[], event?: { clientX: number; clientY: number }) {
  if (!isNative) return;
  const images: Image[] = [];
  // Each picture becomes an image the menu can show, freed once it has closed; in a menu
  // of pictures alone (as main.rs tells them: no text; separators aside), centered.
  const withImages = async (list: PopupItem[]): Promise<MenuItems> => {
    const picture = (item: PopupItem) => item.text === "" && "icon" in item && isPicture(item.icon);
    const alone = list.every((item) => !("text" in item) || picture(item));
    return Promise.all(
      list.map(async (item) => {
        if ("icon" in item && isPicture(item.icon)) {
          const picture = alone ? shifted(item.icon, CENTERING) : item.icon;
          const image = await Image.new(picture.rgba, picture.width, picture.height);
          images.push(image);
          return { ...item, icon: image };
        }
        if ("items" in item && Array.isArray(item.items)) {
          return { ...item, items: await withImages(item.items as PopupItem[]) };
        }
        return item;
      }),
    ) as Promise<MenuItems>;
  };
  const menu = await Menu.new({ items: await withImages(items) });
  if (event) await menu.popup(new LogicalPosition(event.clientX, event.clientY), getCurrentWindow());
  else await menu.popup();
  await menu.close();
  for (const image of images) void image.close();
}
