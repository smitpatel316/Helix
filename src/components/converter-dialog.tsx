// File ▸ Convert… (plan prism-format-work, sub-task (e)): convert a file
// both ways between Prism and the open `.hlx` format, with an honest
// transfer report — what came across, and what didn't.
//
//   Prism → Helix: pick a `.prism` file, convert it, save the result as
//     `.hlx` or open it in Helix. Tables and the analyses Helix offers
//     come across; graphs and layouts don't (Prism stores them in a binary
//     format it doesn't document), and fitted results aren't carried —
//     Helix recomputes every analysis from the table when the file opens.
//   Helix → Prism: write the current project as `.prism` (Save As Prism).
//     A collaborator who needs `.pzfx` can open the `.prism` in Prism and
//     re-save it there — Helix doesn't write `.pzfx`.
//
// The source file is only ever read, never written. The picker is the
// non-blocking one (the Nov 9 deadlock fix): `pick_file`, never
// `blocking_pick_file` on the main thread. No "100% compatible" claim
// anywhere: the report lists exactly what transferred and what didn't.
import * as React from "react";
import { Button, RadioList } from "../ui/controls";
import { Dialog } from "../ui/dialog";
import * as native from "../native";
import { useProjectStore } from "../store/use-project-store";
import { convertPrism, formatReport, type ConvertResult } from "../lib/prism";
import { formatWriteReport, writePrism, type PrismWriteResult } from "../lib/prism-write";
import { serializeProjectFile } from "../lib/project-file";
import { fileTitle } from "../lib/paths";

type Direction = "prism-to-hlx" | "hlx-to-prism";

interface Done {
  direction: Direction;
  sourceName: string;
  reportText: string;
  /** The converted project (Prism → Helix), or the written bytes (Helix → Prism). */
  project?: ConvertResult["project"];
  bytes?: Uint8Array;
  savedPath?: string;
}

const baseName = (name: string) => name.replace(/\.(prism|hlx)$/i, "");

/** Let the progress line paint before the conversion starts. */
const paint = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export function ConverterDialog() {
  const { selector, closeSelector, get, loadProject } = useProjectStore();
  const [direction, setDirection] = React.useState<Direction>("prism-to-hlx");
  const [progress, setProgress] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<Done | null>(null);
  const [copied, setCopied] = React.useState(false);
  const open = selector?.kind === "converter";

  // A fresh dialog every time it opens.
  React.useEffect(() => {
    if (!open) return;
    setDirection("prism-to-hlx");
    setProgress(null);
    setError(null);
    setDone(null);
    setCopied(false);
  }, [open]);

  if (!open) return null;

  const convertPrismFile = async (data: Uint8Array, name: string) => {
    setError(null);
    setDone(null);
    setProgress(`Reading tables from “${name}”…`);
    await paint();
    try {
      const converted = await convertPrism(data, name);
      setProgress(`Converted ${converted.report.tables.length} tables — writing the report…`);
      await paint();
      setDone({
        direction: "prism-to-hlx",
        sourceName: name,
        reportText: formatReport(converted.report),
        project: converted.project,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "This file couldn't be converted.");
    } finally {
      setProgress(null);
    }
  };

  const pickPrismFile = async () => {
    if (native.isNative) {
      // Listen first, then open the panel — the same non-blocking pattern
      // as Import Prism File (Nov 9 deadlock fix).
      const off = await native.onPrismFilePicked(async (path) => {
        off();
        if (!path) return;
        try {
          await convertPrismFile(await native.readPrismBytes(path), fileTitle(path));
        } catch {
          setError(`“${path}” couldn't be read.`);
        }
      });
      await native.choosePrismFile();
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".prism";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => void convertPrismFile(new Uint8Array(reader.result as ArrayBuffer), file.name);
      reader.onerror = () => setError(`“${file.name}” couldn't be read.`);
      reader.readAsArrayBuffer(file);
    };
    input.click();
  };

  const convertCurrentProject = async () => {
    setError(null);
    setDone(null);
    const project = get();
    setProgress(`Writing ${project.rootOrder.length} tables as .prism…`);
    await paint();
    try {
      const version = native.isNative ? await native.appVersion().catch(() => "1.0.7") : "1.0.7";
      const written: PrismWriteResult = await writePrism(
        {
          nodes: project.nodes,
          rootOrder: project.rootOrder,
          childOrder: project.childOrder,
          activeNodeId: project.activeNodeId,
        },
        version,
      );
      setDone({
        direction: "hlx-to-prism",
        sourceName: project.filePath ? fileTitle(project.filePath) : "Untitled",
        reportText: formatWriteReport(written.report),
        bytes: written.bytes,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "This project couldn't be written as .prism.");
    } finally {
      setProgress(null);
    }
  };

  const saveDone = async () => {
    if (!done) return;
    const fallback = `${baseName(done.sourceName)}.${done.direction === "prism-to-hlx" ? "hlx" : "prism"}`;
    if (native.isNative) {
      const target = await native.pickSavePath(
        done.direction === "prism-to-hlx" ? "Save Converted Project" : "Save as Prism",
        fallback,
        done.direction === "prism-to-hlx" ? "Helix Project" : "GraphPad Prism File",
        done.direction === "prism-to-hlx" ? "hlx" : "prism",
      );
      if (!target) return;
      try {
        await native.writeFile(
          target,
          done.direction === "prism-to-hlx" ? serializeProjectFile(done.project!) : done.bytes!,
        );
        setDone({ ...done, savedPath: target });
      } catch {
        setError(`“${target}” couldn't be written there. Try another folder.`);
      }
      return;
    }
    // Web build: download the file.
    const blob = new Blob(
      [done.direction === "prism-to-hlx" ? serializeProjectFile(done.project!) : (done.bytes as BlobPart)],
      {
        type: "application/octet-stream",
      },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fallback;
    a.click();
    URL.revokeObjectURL(url);
    setDone({ ...done, savedPath: fallback });
  };

  const openInHelix = async () => {
    if (!done?.project) return;
    const current = get();
    if (current.isDirty) {
      const discard = await native.confirmDelete(
        "Open Converted Project?",
        "The current project has unsaved changes. Opening the converted project discards them.",
      );
      if (!discard) return;
    }
    loadProject({ ...done.project, filePath: null, edited: true });
    closeSelector();
  };

  const copyReport = async () => {
    if (!done) return;
    try {
      await navigator.clipboard.writeText(done.reportText);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={closeSelector}
      title="Convert"
      description="Convert between Prism files and the open Helix format. The original file is never changed. Graphs and layouts don't transfer — Prism stores them in a binary format it doesn't document."
    >
      <RadioList
        value={direction}
        onChange={(v) => {
          setDirection(v);
          setError(null);
          setDone(null);
        }}
        options={[
          { value: "prism-to-hlx", label: "Prism (.prism) → Helix (.hlx)" },
          { value: "hlx-to-prism", label: "Helix (this project) → Prism (.prism)" },
        ]}
      />
      {direction === "prism-to-hlx" ? (
        <p className="text-regular text-secondary">
          Tables and the analyses Helix offers come across. Fitted results aren&apos;t carried — Helix recomputes every
          analysis from the table when the file opens.
        </p>
      ) : (
        <p className="text-regular text-secondary">
          Writes this project as a Prism 10 file. A collaborator who needs .pzfx can open it in Prism and re-save it
          there.
        </p>
      )}
      {progress && <p className="text-regular">{progress}</p>}
      {error && <p className="text-regular text-red-600">{error}</p>}
      {done && (
        <div className="flex flex-col gap-2">
          <pre className="max-h-64 overflow-auto rounded-md bg-control p-3 text-small whitespace-pre-wrap">
            {done.reportText}
          </pre>
          {done.savedPath && <p className="text-regular text-secondary">Saved to “{done.savedPath}”.</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="accent" onClick={() => void saveDone()}>
              {done.direction === "prism-to-hlx" ? "Save .hlx…" : "Save .prism…"}
            </Button>
            {done.direction === "prism-to-hlx" && <Button onClick={() => void openInHelix()}>Open in Helix</Button>}
            <Button onClick={() => void copyReport()}>{copied ? "Copied" : "Copy report"}</Button>
          </div>
        </div>
      )}
      {!done && (
        <div className="flex gap-2">
          {direction === "prism-to-hlx" ? (
            <Button variant="accent" disabled={progress !== null} onClick={() => void pickPrismFile()}>
              Choose .prism file…
            </Button>
          ) : (
            <Button variant="accent" disabled={progress !== null} onClick={() => void convertCurrentProject()}>
              Convert this project…
            </Button>
          )}
        </div>
      )}
    </Dialog>
  );
}
