import * as React from "react";
import { useProjectStore, type ProjectNode } from "./use-project-store";
import { parseProjectText, serializeProjectFile, PROJECT_FILE_EXTENSION } from "../lib/project-file";
import { parsePzfx } from "../lib/pzfx";
import { convertPrism, formatReport } from "../lib/prism";
import { writePrism } from "../lib/prism-write";
import { loadPrismSaveChoice, nextSaveAction, savePrismSaveChoice } from "../lib/prism-nudge";
import type { SavePromptChoice } from "../components/save-prompt-dialog";
import * as native from "../native";
import { loadRecents, MAX_RECENTS, saveRecents } from "./recents";
import { openProjectsOrSay, sayGone } from "../menus";
import { fileName, fileTitle } from "../lib/paths";

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
        setRecents((list) => (stored.join("\n") === list.join("\n") ? list : stored));
      }),
    [],
  );
  const addRecent = (path: string) =>
    setRecents((list) => [path, ...list.filter((p) => p !== path)].slice(0, MAX_RECENTS));
  const clearRecents = () => setRecents([]);
  const forgetRecent = (path: string) => setRecents((list) => list.filter((p) => p !== path));

  React.useEffect(() => saveRecents(recents), [recents]);

  const { filePath, isDirty } = store;
  const title = filePath ? fileTitle(filePath) : untitled;
  const blank = !filePath && !isDirty && untitled === UNTITLED;
  // Told again when an opening fails, so the shell doesn't keep the file it expected here.
  const report = () => native.setDocument(title, filePath, isDirty, blank);
  React.useEffect(() => report(), [title, filePath, isDirty, blank]);

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
    const version = native.isNative ? await native.appVersion().catch(() => "1.0.7") : "1.0.7";
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
      addRecent(target);
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

  const save = async (saveAs = false): Promise<boolean> => {
    const { filePath } = latest.current;
    // A project already saved as `.prism` saves back as `.prism` — never
    // write `.hlx` JSON into a `.prism` file.
    if (!saveAs && filePath?.toLowerCase().endsWith(".prism")) {
      const s = latest.current.get();
      const revision = s.revision;
      const version = native.isNative ? await native.appVersion().catch(() => "1.0.7") : "1.0.7";
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
      addRecent(target);
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

  /** Opens a project file in this window; `untitled`, as a new document named after it. */
  const load = async (path: string, untitled: boolean) => {
    let text: string;
    try {
      text = await native.readText(path);
    } catch {
      report();
      // Gone since it was opened last: it leaves Open Recent too.
      setRecents((list) => list.filter((p) => p !== path));
      return sayGone(path);
    }
    try {
      // Read from the text, not `JSON.parse` + `parseProjectFile`: a duplicated
      // node id is last-wins in `JSON.parse`, so the text-level read (FF-F19)
      // is what keeps the later copy instead of dropping it silently.
      const parsed = parseProjectText(text);
      if ("error" in parsed) {
        report();
        return native.alert("Couldn't Open Project", parsed.error, "error");
      }
      // A file changed as it was read (repaired, or from an older Titer) opens edited: saving
      // it keeps the project as it is now. The sample stays untitled, never to be saved.
      const edited = parsed.updated && !untitled;
      prismOrigin.current = false;
      prompted.current = false;
      latest.current.loadProject({ ...parsed.project, filePath: untitled ? null : path, edited });
      if (untitled) setUntitled(fileTitle(path));
      else addRecent(path);
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
    } catch {
      report();
      await native.alert("Couldn't Open Project", "This file is damaged or isn't a valid Titer project.", "error");
    }
  };

  /** Imports a Prism `.pzfx` file as a new untitled project (File ▸ Import Prism File…,
   *  or a dropped file). Analyses and graphs aren't in the file — only its data tables —
   *  so the imported project opens edited: saving keeps it as a Titer project. */
  const importPrismText = async (text: string, name: string) => {
    const imported = parsePzfx(text);
    if (imported.tables.length === 0) {
      report();
      return native.alert(
        "Couldn't Import File",
        imported.issues.map((i) => i.message).join("\n") || "No tables in this file could be imported.",
        "error",
      );
    }
    if (!(await confirmDiscard())) return;
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
      await importPrismBytes(bytes, fileTitle(path));
      return;
    }
    let text: string;
    try {
      text = await native.readPrismText(path);
    } catch {
      report();
      return native.alert("Couldn't Import File", `“${fileName(path)}” couldn't be read.`, "error");
    }
    await importPrismText(text, fileTitle(path));
  };

  /** Imports a Prism `.prism` file (Prism 10's ZIP format) as a new untitled
   *  project. Tables and the analyses Titer offers come across; graphs and
   *  layouts don't — Prism stores them in a binary format it doesn't
   *  document — and fitted results aren't carried: Titer recomputes every
   *  analysis from the table when the file opens. The transfer report says
   *  exactly what came across and what didn't, in plain language. */
  const importPrismBytes = async (data: Uint8Array, name: string) => {
    let converted;
    try {
      converted = await convertPrism(data, name);
    } catch (err) {
      report();
      return native.alert(
        "Couldn't Import File",
        err instanceof Error ? err.message : "This file couldn't be imported.",
        "error",
      );
    }
    if (!(await confirmDiscard())) return;
    prismOrigin.current = true;
    prompted.current = false;
    latest.current.loadProject({ ...converted.project, filePath: null, edited: true });
    setUntitled(name);
    await native.alert(
      "Prism File Imported",
      formatReport(converted.report) + "\n\nSave the project to keep it as a Titer project.",
      converted.report.issues.length ? "warning" : "info",
    );
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
      await importPrismBytes(new Uint8Array(picked.data), picked.name.replace(/\.prism$/i, ""));
    } else {
      await importPrismText(picked.data, "Prism import");
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

  return { save, recents, forgetRecent, clearRecents, importPrism, projectUpdated, dismissProjectUpdated, resolveSavePrompt };
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
