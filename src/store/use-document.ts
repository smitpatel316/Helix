import * as React from "react";
import { useProjectStore, type ProjectNode } from "./use-project-store";
import { parseProjectText, serializeProjectFile, PROJECT_FILE_EXTENSION } from "../lib/project-file";
import { parsePzfx } from "../lib/pzfx";
import { convertPrism, formatReport } from "../lib/prism";
import { writePrism } from "../lib/prism-write";
import { loadPrismSaveChoice, nextSaveAction, savePrismSaveChoice } from "../lib/prism-nudge";
import type { SavePromptChoice } from "../components/save-prompt-dialog";
import * as native from "../native";
import { loadRecents, MAX_RECENTS, saveRecents, recentKey, type RecentEntry } from "./recents";
import { openProjectsOrSay, sayGone } from "../menus";
import { fileName, fileTitle } from "../lib/paths";
import {
  base64ToBytes,
  bytesToBase64,
  cloudErrorMessage,
  copyName,
  handleLabel,
  isConflictError,
  isNotAuthenticatedError,
  isOfflineError,
  readCachedFile,
  remoteHandle as makeRemoteHandle,
  writeFile as writeCloudFile,
  type FileHandle,
  type RemoteDownload,
} from "../lib/cloud";

const UNTITLED = "Untitled";

const isProjectFile = (path: string) => path.toLowerCase().endsWith(`.${PROJECT_FILE_EXTENSION}`);

/**
 * The window's project, from opening to saving: what the shell gives it to open (a
 * file, the sample, a project still open when Titer last quit), files dropped on it,
 * Save / Save As, Open Recent, the title and unsaved-changes dot of the window, and the
 * Save / Don't Save / Cancel prompt when it closes. Each project has its own window:
 * the shell decides where a project opens (native.openProjects).
 */
export function useDocument() {
  const store = useProjectStore();
  const latest = React.useRef(store);
  React.useEffect(() => {
    latest.current = store;
  });
  const [recents, setRecents] = React.useState(loadRecents);
  // The "Project Updated" notice, shown in-app rather than as a native dialog:
  // the native one's window lingered on macOS after dismissal, blocking clicks
  // and quitting (Quirk 2). Set when a load brings a file up to date.
  const [projectUpdated, setProjectUpdated] = React.useState(false);
  const dismissProjectUpdated = () => setProjectUpdated(false);
  // The window's title while the project isn't saved anywhere.
  const [untitled, setUntitled] = React.useState(UNTITLED);
  // Other windows change the list too: this one reads it again when it comes to the front.
  React.useEffect(
    () =>
      native.onFocusChange((focused) => {
        if (!focused) return;
        const stored = loadRecents();
        setRecents((list) =>
          stored.map(recentKey).join("\n") === list.map(recentKey).join("\n") ? list : stored,
        );
      }),
    [],
  );
  const addRecent = (entry: RecentEntry) =>
    setRecents((list) => [entry, ...list.filter((e) => recentKey(e) !== recentKey(entry))].slice(0, MAX_RECENTS));
  const clearRecents = () => setRecents([]);
  const forgetRecent = (entry: RecentEntry) =>
    setRecents((list) => list.filter((e) => recentKey(e) !== recentKey(entry)));

  React.useEffect(() => saveRecents(recents), [recents]);

  // ── Remote files (cloud storage, v2 item 75) ───────────────────────────
  // The open file's remote handle, if it lives in the cloud rather than on
  // disk. `filePath` in the store stays null for remote files (the shell's
  // session restore only knows local paths), and the title comes from the
  // remote display path instead. A ref mirrors the state for the save/close
  // callbacks, which run long after the render that set it.
  type RemoteHandle = Extract<FileHandle, { kind: "remote" }>;
  const [remote, setRemoteState] = React.useState<RemoteHandle | null>(null);
  const remoteRef = React.useRef<RemoteHandle | null>(null);
  const setRemote = (handle: RemoteHandle | null) => {
    remoteRef.current = handle;
    setRemoteState(handle);
  };
  // A save that hit a conflict: the dialog's three choices resolve it. The
  // bytes are the save attempt's, and the remote version is the one the
  // provider reported — both shown in the dialog.
  const [conflict, setConflict] = React.useState<{
    handle: RemoteHandle;
    bytes: Uint8Array;
    revision: number;
    remoteVersion: string;
    remoteModifiedAt: string | null;
    remoteSha1: string | null;
  } | null>(null);
  // Offline: the document stays editable from its cache copy. "open" means
  // the file was opened from the cache while offline; "save" means a save
  // failed for lack of network. Either way the document is never discarded.
  const [offlineNotice, setOfflineNotice] = React.useState<{ mode: "open" | "save" } | null>(null);

  const { filePath, isDirty } = store;
  const title = filePath ? fileTitle(filePath) : remote ? fileTitle(remote.path) : untitled;
  const blank = !filePath && !remote && !isDirty && untitled === UNTITLED;
  // Told again when an opening fails, so the shell doesn't keep the file it expected here.
  const report = () => native.setDocument(title, remote ? null : filePath, isDirty, blank);
  React.useEffect(() => report(), [title, filePath, remote, isDirty, blank]);

  // ── Open-format nudge (f) ─────────────────────────────────────────────
  // The rule lives in docs/open-format-nudge.md: prompt once per project
  // when a Prism-origin project is saved; respect "don't ask again" (app
  // settings, never the file); Prism save always one click away.
  // `prismOrigin` is set by either Prism import and cleared when a `.hlx`
  // file is opened; `prompted` is per project, per window.
  const prismOrigin = React.useRef(false);
  const prompted = React.useRef(false);
  const pendingPrompt = React.useRef<((choice: SavePromptChoice, remember: boolean) => void) | null>(null);

  /** The save prompt's answer: remember it if asked, close the dialog, and
   *  let the save waiting on it continue. */
  const resolveSavePrompt = (choice: SavePromptChoice, remember: boolean) => {
    if (remember && choice !== "cancel") savePrismSaveChoice(choice);
    const resolve = pendingPrompt.current;
    pendingPrompt.current = null;
    store.closeSelector();
    resolve?.(choice, remember);
  };

  /** Ask the save prompt and wait for its answer. */
  const askSaveFormat = () =>
    new Promise<{ choice: SavePromptChoice; remember: boolean }>((resolve) => {
      pendingPrompt.current = (choice, remember) => resolve({ choice, remember });
      store.openSelector({ kind: "save-prompt" });
    });

  /** Save the current project as a Prism `.prism` file (the prompt's Prism
   *  option, or the remembered choice). Returns false when the user cancels
   *  the path picker — the save is abandoned, not silently saved as `.hlx`. */
  const saveAsPrism = async (): Promise<boolean> => {
    const s = latest.current.get();
    const revision = s.revision;
    const version = native.isNative ? await native.appVersion().catch(() => "1.2.0") : "1.2.0";
    let bytes: Uint8Array;
    try {
      bytes = (
        await writePrism(
          { nodes: s.nodes, rootOrder: s.rootOrder, childOrder: s.childOrder, activeNodeId: s.activeNodeId },
          version,
        )
      ).bytes;
    } catch (err) {
      await native.alert(
        "Couldn't Save as Prism",
        err instanceof Error ? err.message : "This project couldn't be written as .prism.",
        "error",
      );
      return false;
    }
    const target = await native.pickSavePath("Save as Prism", `${title}.prism`, "GraphPad Prism File", "prism");
    if (!target) return false;
    try {
      await native.writeFile(target, bytes);
      latest.current.markProjectSaved(target, revision);
      // The project now lives on local disk, even if it came from the cloud.
      setRemote(null);
      addRecent({ kind: "local", path: target });
      return true;
    } catch (err) {
      const name = fileName(target);
      await native.alert(
        "Couldn't Save Project",
        `“${name}” couldn't be saved there (${err}). Try Save As… another folder.`,
        "error",
      );
      return false;
    }
  };

  // ── Remote save / open / conflict / offline (cloud storage) ────────────

  /** Saves the current project back to its remote file, conditional on the
   *  version seen at open/last-save. A `.prism` remote saves as Prism
   *  bytes, a `.hlx` remote as project JSON — the same rule as local files.
   *  A conflict opens the three-choice dialog instead of overwriting; an
   *  offline save shows the offline notice instead of losing the document. */
  const saveRemote = async (handle: RemoteHandle): Promise<boolean> => {
    const s = latest.current.get();
    const revision = s.revision;
    const version = native.isNative ? await native.appVersion().catch(() => "1.0.7") : "1.0.7";
    let bytes: Uint8Array;
    try {
      bytes = handle.path.toLowerCase().endsWith(".prism")
        ? (
            await writePrism(
              { nodes: s.nodes, rootOrder: s.rootOrder, childOrder: s.childOrder, activeNodeId: s.activeNodeId },
              version,
            )
          ).bytes
        : new TextEncoder().encode(serializeProjectFile(s));
    } catch (err) {
      await native.alert(
        "Couldn't Save Project",
        err instanceof Error ? err.message : "This project couldn't be written.",
        "error",
      );
      return false;
    }
    try {
      const saved = await writeCloudFile(handle, bytes);
      setRemote({
        ...handle,
        version: saved?.version ?? handle.version,
        sha1: saved?.sha1 ?? handle.sha1,
        modifiedAt: saved?.modifiedAt ?? handle.modifiedAt,
      });
      latest.current.markProjectSaved(null, revision);
      addRecent({
        kind: "remote",
        provider: handle.provider,
        accountId: handle.accountId,
        fileId: handle.fileId,
        path: handle.path,
      });
      setOfflineNotice(null);
      return true;
    } catch (err) {
      if (isConflictError(err)) {
        setConflict({
          handle,
          bytes,
          revision,
          remoteVersion: err.remote_version,
          remoteModifiedAt: err.remote_modified_at ?? null,
          remoteSha1: err.remote_sha1 ?? null,
        });
        latest.current.openSelector({ kind: "conflict" });
        return false;
      }
      if (isOfflineError(err)) {
        setOfflineNotice({ mode: "save" });
        return false;
      }
      if (isNotAuthenticatedError(err)) {
        await native.alert(
          "Signed Out of Box",
          "The Box sign-in expired or was revoked. Reconnect in Settings → Connected Storage, then save again. Your edits are still here.",
          "error",
        );
        return false;
      }
      await native.alert(
        "Couldn't Save Project",
        `“${handleLabel(handle)}” couldn't be saved to ${handle.provider === "box" ? "Box" : handle.provider} (${cloudErrorMessage(err)}). Your edits are still here.`,
        "error",
      );
      return false;
    }
  };

  /** Opens a remote `.hlx` / `.prism` file in this window. Downloads it
   *  (and writes the cache copy); offline, opens the cache copy instead and
   *  says so. A `.prism` file imports as a project that saves back as
   *  `.prism` — the open keeps its remote handle, unlike a local import,
   *  which starts untitled. */
  const loadRemote = async (handle: RemoteHandle): Promise<void> => {
    const recent: RecentEntry = {
      kind: "remote",
      provider: handle.provider,
      accountId: handle.accountId,
      fileId: handle.fileId,
      path: handle.path,
    };
    const openOfflineCopy = async (): Promise<boolean> => {
      // Offline: the cache copy, if there is one, is what editing uses.
      let cached: Uint8Array;
      try {
        cached = await readCachedFile(handle);
      } catch {
        await native.alert(
          "Couldn't Open Project",
          `“${handleLabel(handle)}” can't be opened while offline — no copy of it is saved on this computer yet.`,
          "error",
        );
        return false;
      }
      if (handle.path.toLowerCase().endsWith(".prism")) {
        if (!(await importPrismBytes(cached, fileTitle(handle.path)))) return false;
      } else {
        const ok = await applyProjectText(new TextDecoder().decode(cached), { filePath: null, untitled: false, displayName: handle.path }, () => {});
        if (!ok) return false;
      }
      prismOrigin.current = false;
      setRemote(handle);
      setUntitled(fileTitle(handle.path));
      addRecent(recent);
      setOfflineNotice({ mode: "open" });
      return true;
    };
    let downloaded: RemoteDownload;
    try {
      downloaded = await native.cloudDownload(handle.provider, handle.accountId, handle.fileId);
    } catch (err) {
      report();
      if (isOfflineError(err)) {
        await openOfflineCopy();
        return;
      }
      if (isNotAuthenticatedError(err)) {
        await native.alert(
          "Signed Out of Box",
          "The Box sign-in expired or was revoked. Reconnect in Settings → Connected Storage to open this file.",
          "error",
        );
        return;
      }
      // Gone since it was opened last: it leaves Open Recent too.
      setRecents((list) => list.filter((e) => recentKey(e) !== recentKey(recent)));
      return sayGone(handle.path);
    }
    const next: RemoteHandle = makeRemoteHandle(
      handle.provider,
      handle.accountId,
      handle.fileId,
      handle.path,
      downloaded.version ?? null,
      downloaded.sha1 ?? null,
      downloaded.modifiedAt ?? null,
    );
    if (handle.path.toLowerCase().endsWith(".prism")) {
      if (!(await importPrismBytes(base64ToBytes(downloaded.base64), fileTitle(handle.path)))) return;
      // The project came from a `.prism` file: it saves back as `.prism`,
      // like a local file after Save as Prism — no format nudge.
      prismOrigin.current = false;
      setRemote(next);
      setUntitled(fileTitle(handle.path));
      addRecent(recent);
      return;
    }
    await applyProjectText(
      new TextDecoder().decode(base64ToBytes(downloaded.base64)),
      { filePath: null, untitled: false, displayName: handle.path },
      () => {
        setRemote(next);
        setUntitled(fileTitle(handle.path));
        addRecent(recent);
      },
    );
  };

  /** The conflict dialog's answer. "copy" saves a new remote file next to
   *  the original; "reload" discards local edits and takes the remote
   *  version; "overwrite" saves anyway — explicit, and never taken by
   *  autosave (there is no autosave path that calls this). */
  const resolveConflict = async (choice: "copy" | "reload" | "overwrite" | "cancel"): Promise<void> => {
    const pending = conflict;
    setConflict(null);
    latest.current.closeSelector();
    if (!pending || choice === "cancel") return;
    if (choice === "reload") {
      await loadRemote(pending.handle);
      return;
    }
    if (choice === "copy") {
      // The new file goes next to the original: the parent folder comes
      // from fresh metadata (the handle doesn't carry it).
      let parentId = "0";
      try {
        const meta = await native.cloudMetadata(pending.handle.provider, pending.handle.accountId, pending.handle.fileId);
        parentId = meta.parentId ?? "0";
      } catch {
        // Unknown parent: the provider root is the fallback, and the name
        // says it's a copy, so nothing is silently overwritten.
      }
      const name = copyName(fileName(pending.handle.path));
      try {
        const entry = await native.cloudUploadNew(
          pending.handle.provider,
          pending.handle.accountId,
          parentId,
          name,
          bytesToBase64(pending.bytes),
        );
        const next: RemoteHandle = makeRemoteHandle(
          pending.handle.provider,
          pending.handle.accountId,
          entry.id,
          entry.path,
          entry.version ?? null,
          entry.sha1 ?? null,
          entry.modifiedAt ?? null,
        );
        setRemote(next);
        latest.current.markProjectSaved(null, pending.revision);
        addRecent({
          kind: "remote",
          provider: next.provider,
          accountId: next.accountId,
          fileId: next.fileId,
          path: next.path,
        });
      } catch (err) {
        await native.alert(
          "Couldn't Save a Copy",
          `“${name}” couldn't be saved to ${pending.handle.provider === "box" ? "Box" : pending.handle.provider} (${cloudErrorMessage(err)}). Your edits are still here.`,
          "error",
        );
      }
      return;
    }
    try {
      const saved = await writeCloudFile(pending.handle, pending.bytes, null);
      setRemote({
        ...pending.handle,
        version: saved?.version ?? pending.handle.version,
        sha1: saved?.sha1 ?? pending.handle.sha1,
        modifiedAt: saved?.modifiedAt ?? pending.handle.modifiedAt,
      });
      latest.current.markProjectSaved(null, pending.revision);
    } catch (err) {
      await native.alert(
        "Couldn't Save Project",
        `“${handleLabel(pending.handle)}” still couldn't be saved (${cloudErrorMessage(err)}). Your edits are still here.`,
        "error",
      );
    }
  };

  /** The offline notice's answer. "retry" saves again from the current
   *  project (fresh bytes, not the failed attempt's); "local-copy" saves
   *  to disk instead; "dismiss" keeps editing — the document is never
   *  discarded because the network is gone. */
  const resolveOfflineNotice = async (action: "retry" | "local-copy" | "dismiss"): Promise<void> => {
    const notice = offlineNotice;
    setOfflineNotice(null);
    if (!notice) return;
    if (action === "dismiss") return;
    if (action === "retry") {
      if (notice.mode === "save") await save();
      return;
    }
    // Save a local copy: the project then lives on local disk.
    await save(true);
  };

  /** File ▸ Open from Cloud…: the remote picker (in-app folder browsing —
   *  the native OS dialog can't browse cloud locations). */
  const openRemotePicker = () => latest.current.openSelector({ kind: "remote-picker" });

  /** Opens a remote file picked in the picker. */
  const openRemoteHandle = (handle: RemoteHandle) => {
    latest.current.closeSelector();
    void loadRemote(handle);
  };

  /** Opens an Open Recent entry. Remote entries load from the cloud;
   *  local ones go through the shell as today. */
  const openRemoteEntry = (entry: RecentEntry) => {
    if (entry.kind === "local") {
      openProjectsOrSay([entry.path], (gone) => forgetRecent({ kind: "local", path: gone }));
      return;
    }
    void loadRemote(makeRemoteHandle(entry.provider, entry.accountId, entry.fileId, entry.path, null));
  };

  const save = async (saveAs = false): Promise<boolean> => {
    // A remote file saves back to the cloud — unless Save As, which saves a
    // local copy instead (the project then lives on local disk).
    if (remoteRef.current && !saveAs) return saveRemote(remoteRef.current);
    const { filePath } = latest.current;
    // A project already saved as `.prism` saves back as `.prism` — never
    // write `.hlx` JSON into a `.prism` file.
    if (!saveAs && filePath?.toLowerCase().endsWith(".prism")) {
      const s = latest.current.get();
      const revision = s.revision;
      const version = native.isNative ? await native.appVersion().catch(() => "1.2.0") : "1.2.0";
      try {
        const { bytes } = await writePrism(
          { nodes: s.nodes, rootOrder: s.rootOrder, childOrder: s.childOrder, activeNodeId: s.activeNodeId },
          version,
        );
        await native.writeFile(filePath, bytes);
        latest.current.markProjectSaved(filePath, revision);
        return true;
      } catch (err) {
        await native.alert(
          "Couldn't Save Project",
          err instanceof Error ? err.message : "This project couldn't be written as .prism.",
          "error",
        );
        return false;
      }
    }
    // Nudge (f.1/f.4): a Prism-origin project prompts once; a remembered
    // choice applies silently. Marked prompted before awaiting, so a
    // re-entrant save can't double-prompt.
    if (prismOrigin.current && !prompted.current) {
      const action = nextSaveAction({
        prismOrigin: prismOrigin.current,
        prompted: prompted.current,
        remembered: loadPrismSaveChoice(),
      });
      if (action === "save-prism") {
        prompted.current = true;
        return saveAsPrism();
      }
      if (action === "prompt") {
        prompted.current = true;
        const { choice } = await askSaveFormat();
        if (choice === "prism") return saveAsPrism();
        // "hlx" or Cancel: fall through to the normal `.hlx` save below.
      }
    }
    const target =
      (!saveAs && filePath) ||
      (await native.pickSavePath(
        "Save Project",
        filePath ?? `${untitled}.${PROJECT_FILE_EXTENSION}`,
        "Titer Project",
        PROJECT_FILE_EXTENSION,
      ));
    if (!target) return false;
    // Read the project only now, after the dialog: edits made while it was open
    // must end up in the file. The revision lets markProjectSaved keep the dirty
    // flag if something changes during the write itself.
    const s = latest.current.get();
    const revision = s.revision;
    try {
      await native.writeFile(target, serializeProjectFile(s));
      latest.current.markProjectSaved(target, revision);
      // A remote file saved to a local path now lives on local disk.
      setRemote(null);
      addRecent({ kind: "local", path: target });
      return true;
    } catch (err) {
      const name = fileName(target);
      await native.alert(
        "Couldn't Save Project",
        `“${name}” couldn't be saved there (${err}). Try Save As… another folder.`,
        "error",
      );
      return false;
    }
  };

  /** True when it's fine to discard the project (saved, or the user said so). */
  const confirmDiscard = async (): Promise<boolean> => {
    if (!latest.current.isDirty) return true;
    const answer = await native.askToSave();
    return answer === "save" ? save() : answer === "discard";
  };

  /** Parses `.hlx` text and loads it as the window's project. `filePath` is
   *  the local path (null for remote/untitled); `afterLoad` runs once the
   *  project is in the store (recents, the remote handle). Returns false
   *  when the text isn't a readable project. Shared by local `load` and
   *  remote `loadRemote`, so both report the same issues the same way. */
  const applyProjectText = async (
    text: string,
    target: { filePath: string | null; untitled: boolean; displayName: string },
    afterLoad: () => void,
  ): Promise<boolean> => {
    try {
      // Read from the text, not `JSON.parse` + `parseProjectFile`: a duplicated
      // node id is last-wins in `JSON.parse`, so the text-level read (FF-F19)
      // is what keeps the later copy instead of dropping it silently.
      const parsed = parseProjectText(text);
      if ("error" in parsed) {
        report();
        await native.alert("Couldn't Open Project", parsed.error, "error");
        return false;
      }
      // A file changed as it was read (repaired, or from an older Titer) opens edited: saving
      // it keeps the project as it is now. The sample stays untitled, never to be saved.
      const edited = parsed.updated && !target.untitled;
      prismOrigin.current = false;
      prompted.current = false;
      latest.current.loadProject({ ...parsed.project, filePath: target.filePath, edited });
      if (target.untitled) setUntitled(fileTitle(target.displayName));
      afterLoad();
      // The project is loaded; still tell the user what in it couldn't be read as is.
      const { issues } = parsed;
      const save = edited ? "Save the project to keep it as it is now." : "";
      if (issues.length > 0) {
        const shown = issues.slice(0, 12).map((i) => `• ${i.message}`);
        if (issues.length > 12) shown.push(`…and ${issues.length - 12} more.`);
        if (save) shown.push("", save);
        await native.alert(`Opened with ${issues.length} Issue${issues.length === 1 ? "" : "s"}`, shown.join("\n"));
      } else if (edited) {
        // In-app, not native.alert: the native dialog's window lingered on macOS
        // after dismissal, blocking clicks and quitting (Quirk 2).
        setProjectUpdated(true);
      }
      return true;
    } catch {
      report();
      await native.alert("Couldn't Open Project", "This file is damaged or isn't a valid Titer project.", "error");
      return false;
    }
  };

  /** Opens a project file in this window; `untitled`, as a new document named after it. */
  const load = async (path: string, untitled: boolean) => {
    let text: string;
    try {
      text = await native.readText(path);
    } catch {
      report();
      // Gone since it was opened last: it leaves Open Recent too.
      setRecents((list) => list.filter((e) => !(e.kind === "local" && e.path === path)));
      return sayGone(path);
    }
    setRemote(null);
    await applyProjectText(
      text,
      { filePath: untitled ? null : path, untitled, displayName: path },
      () => {
        if (!untitled) addRecent({ kind: "local", path });
      },
    );
  };

  /** Imports a Prism `.pzfx` file as a new untitled project (File ▸ Import Prism File…,
   *  or a dropped file). Analyses and graphs aren't in the file — only its data tables —
   *  so the imported project opens edited: saving keeps it as a Titer project.
   *  Returns true when the project loaded, so a local import knows to drop
   *  the remote handle. */
  const importPrismText = async (text: string, name: string): Promise<boolean> => {
    const imported = parsePzfx(text);
    if (imported.tables.length === 0) {
      report();
      await native.alert(
        "Couldn't Import File",
        imported.issues.map((i) => i.message).join("\n") || "No tables in this file could be imported.",
        "error",
      );
      return false;
    }
    if (!(await confirmDiscard())) return false;
    prismOrigin.current = true;
    prompted.current = false;
    latest.current.loadProject({ ...imported.project, filePath: null, edited: true });
    setUntitled(name);
    const lines = [
      `Imported ${imported.tables.length} table${imported.tables.length === 1 ? "" : "s"} from “${name}”:`,
      ...imported.tables.map((t) => `• ${t}`),
    ];
    if (imported.issues.length > 0) {
      lines.push("", "Notes:", ...imported.issues.slice(0, 12).map((i) => `• ${i.message}`));
      if (imported.issues.length > 12) lines.push(`…and ${imported.issues.length - 12} more.`);
    }
    await native.alert(
      "Prism File Imported",
      lines.join("\n") + "\n\nSave the project to keep it as a Titer project.",
      imported.issues.length ? "warning" : "info",
    );
    return true;
  };

  const importPrismFile = async (path: string) => {
    if (path.toLowerCase().endsWith(".prism")) {
      let bytes: Uint8Array;
      try {
        bytes = await native.readPrismBytes(path);
      } catch {
        report();
        return native.alert("Couldn't Import File", `“${fileName(path)}” couldn't be read.`, "error");
      }
      // A local import starts an untitled local project: the remote handle
      // goes, even if the window held a remote file.
      if (await importPrismBytes(bytes, fileTitle(path))) setRemote(null);
      return;
    }
    let text: string;
    try {
      text = await native.readPrismText(path);
    } catch {
      report();
      return native.alert("Couldn't Import File", `“${fileName(path)}” couldn't be read.`, "error");
    }
    if (await importPrismText(text, fileTitle(path))) setRemote(null);
  };

  /** Imports a Prism `.prism` file (Prism 10's ZIP format) as a new untitled
   *  project. Tables and the analyses Titer offers come across; graphs and
   *  layouts don't — Prism stores them in a binary format it doesn't
   *  document — and fitted results aren't carried: Titer recomputes every
   *  analysis from the table when the file opens. The transfer report says
   *  exactly what came across and what didn't, in plain language. Returns
   *  true when the project loaded (false when the user cancelled or the
   *  file couldn't convert), so a remote open knows whether to keep its
   *  handle. */
  const importPrismBytes = async (data: Uint8Array, name: string): Promise<boolean> => {
    let converted;
    try {
      converted = await convertPrism(data, name);
    } catch (err) {
      report();
      await native.alert(
        "Couldn't Import File",
        err instanceof Error ? err.message : "This file couldn't be imported.",
        "error",
      );
      return false;
    }
    if (!(await confirmDiscard())) return false;
    prismOrigin.current = true;
    prompted.current = false;
    latest.current.loadProject({ ...converted.project, filePath: null, edited: true });
    setUntitled(name);
    await native.alert(
      "Prism File Imported",
      formatReport(converted.report) + "\n\nSave the project to keep it as a Titer project.",
      converted.report.issues.length ? "warning" : "info",
    );
    return true;
  };

  /** File ▸ Import Prism File…: pick a Prism file (`.pzfx` or `.prism`) and import it. In the web build
   *  (no native shell) the pick is a file input instead. */
  const importPrism = async () => {
    if (native.isNative) {
      // Listen first, then open the panel: the shell emits
      // "prism-file-picked" (path, or null on Cancel) when the user picks.
      // The old sync invoke blocked the main thread and deadlocked the
      // picker (Nov 9, macOS + Linux).
      const off = await native.onPrismFilePicked((path) => {
        off();
        if (path) void importPrismFile(path);
      });
      await native.choosePrismFile();
      return;
    }
    const picked = await new Promise<{ name: string; data: ArrayBuffer | string } | null>((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".pzfx,.prism";
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, data: reader.result as ArrayBuffer | string });
        reader.onerror = () => resolve(null);
        // A `.prism` file is a ZIP: read bytes, not text.
        if (file.name.toLowerCase().endsWith(".prism")) reader.readAsArrayBuffer(file);
        else reader.readAsText(file);
      };
      input.click();
    });
    if (!picked) return;
    if (typeof picked.data !== "string") {
      if (await importPrismBytes(new Uint8Array(picked.data), picked.name.replace(/\.prism$/i, ""))) setRemote(null);
    } else {
      if (await importPrismText(picked.data, "Prism import")) setRemote(null);
    }
  };

  const openPaths = (paths: string[]) => {
    const projects = paths.filter(isProjectFile);
    const prism = paths.filter((p) => p.toLowerCase().endsWith(".pzfx") || p.toLowerCase().endsWith(".prism"));
    if (paths.length > projects.length + prism.length) {
      void native.alert(
        "Can't Open File",
        "Titer can only open .hlx project files and import .pzfx / .prism Prism files. To convert a Prism file without opening it, use File ▸ Convert….",
      );
    }
    if (projects.length) openProjectsOrSay(projects);
    // One Prism file at a time: each imports as its own untitled project.
    // (FF-F15) If several were dropped, import the first and name the rest —
    // never silently swallow files.
    if (prism.length) {
      void importPrismFile(prism[0]);
      if (prism.length > 1) {
        const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
        void native.alert("Imported One Prism File", prismDropSkippedMessage(base(prism[0]), prism.slice(1).map(base)));
      }
    }
  };

  // Subscribed once; the handlers reach the current versions through this ref.
  const handlers = React.useRef({ confirmDiscard, load, openPaths });
  React.useEffect(() => {
    handlers.current = { confirmDiscard, load, openPaths };
  });
  React.useEffect(() => native.onCloseRequested(() => handlers.current.confirmDiscard()), []);
  React.useEffect(() => native.onDrop((paths) => handlers.current.openPaths(paths)), []);
  React.useEffect(() => native.onOpening(({ path, untitled }) => void handlers.current.load(path, untitled)), []);

  return {
    save,
    recents,
    forgetRecent,
    clearRecents,
    importPrism,
    projectUpdated,
    dismissProjectUpdated,
    resolveSavePrompt,
    remote,
    openRemotePicker,
    openRemoteHandle,
    openRemoteEntry,
    conflict,
    resolveConflict,
    offlineNotice,
    resolveOfflineNotice,
  };
}

/** (FF-F15) Message for a multi-file Prism drop: the first file imports,
 *  the rest are named, never silently swallowed. Pure, so checks.ts pins
 *  the exact wording. */
export function prismDropSkippedMessage(firstName: string, skippedNames: string[]): string {
  const skipped = skippedNames.join(", ");
  return `Imported ${firstName}; ${skipped} ${skippedNames.length === 1 ? "was" : "were"} not imported — drop one file at a time, or use File ▸ Convert….`;
}

export type DocumentActions = ReturnType<typeof useDocument>;

/** Deletes a table (with its analyses and graphs), an analysis or a graph once the
 *  user confirms (Edit ▸ Undo brings it back). */
export async function removeWithConfirm(node: Pick<ProjectNode, "id" | "name" | "type">, remove: (id: string) => void) {
  const detail =
    node.type === "table" ? "Its analyses and graphs will be deleted too. You can undo this." : "You can undo this.";
  if (await native.confirmDelete(`Delete “${node.name}”?`, detail)) remove(node.id);
}
