// The remote-change conflict dialog (cloud storage, v2 item 75): the file
// changed in the cloud since it was opened, so the save is conditional on
// the version seen at open — and a mismatch is never silently overwritten.
// Three explicit choices, no default taken for the user: Save as a copy
// (a new remote file next to the original), Reload the remote version
// (discards local edits, with this dialog as the confirm), or Overwrite
// anyway (explicit, logged). Autosave never takes the overwrite path —
// there is no autosave path that calls this dialog's resolver.
import { Button } from "../ui/controls";
import { Dialog } from "../ui/dialog";
import { useProjectStore } from "../store/use-project-store";
import { handleLabel } from "../lib/cloud";
import type { FileHandle } from "../lib/cloud";

export type ConflictChoice = "copy" | "reload" | "overwrite" | "cancel";

interface ConflictInfo {
  handle: Extract<FileHandle, { kind: "remote" }>;
  remoteVersion: string;
  remoteModifiedAt: string | null;
  remoteSha1: string | null;
}

export function ConflictDialog({
  conflict,
  onChoose,
}: {
  conflict: ConflictInfo | null;
  onChoose: (choice: ConflictChoice) => void;
}) {
  const { selector } = useProjectStore();
  const open = selector?.kind === "conflict" && conflict !== null;
  if (!open || !conflict) return null;

  const provider = conflict.handle.provider === "box" ? "Box" : conflict.handle.provider;
  const name = handleLabel(conflict.handle);
  const when = conflict.remoteModifiedAt ? ` (changed ${conflict.remoteModifiedAt})` : "";
  return (
    <Dialog
      open={open}
      onClose={() => onChoose("cancel")}
      title="This file changed in the cloud"
      description={`“${name}” changed in ${provider} since you opened it${when}. Saving would overwrite someone else's changes — choose what to do. Your edits are safe either way.`}
      footer={
        <>
          <Button variant="accent" onClick={() => onChoose("copy")}>
            Save as a Copy
          </Button>
          <Button onClick={() => onChoose("reload")}>Reload the Remote Version</Button>
          <Button onClick={() => onChoose("overwrite")}>Overwrite Anyway</Button>
        </>
      }
    >
      <p className="text-regular text-secondary">
        Save as a copy keeps both versions. Reloading discards your edits and opens the remote version. Overwriting
        replaces the remote version with yours.
      </p>
    </Dialog>
  );
}
