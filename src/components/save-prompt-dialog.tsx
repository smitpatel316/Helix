// The open-format save prompt (plan prism-format-work, sub-task (f)): when
// a project that came from a Prism file is saved, ask once — save as the
// open `.hlx` format (recommended), or save as Prism format — with a
// "remember my choice" checkbox. The prompt never blocks saving: Esc /
// Cancel still saves in the current format. The rule it follows lives in
// docs/open-format-nudge.md (f.4): prompt once per project, respect "don't
// ask again" (app settings, never the file), Prism save always one click
// away, no nagging, no guilt copy.
import * as React from "react";
import { Button } from "../ui/controls";
import { Dialog } from "../ui/dialog";
import { useProjectStore } from "../store/use-project-store";

export type SavePromptChoice = "hlx" | "prism" | "cancel";

export function SavePromptDialog({ onChoose }: { onChoose: (choice: SavePromptChoice, remember: boolean) => void }) {
  const { selector } = useProjectStore();
  const [remember, setRemember] = React.useState(false);
  const open = selector?.kind === "save-prompt";

  React.useEffect(() => {
    if (open) setRemember(false);
  }, [open]);

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={() => onChoose("cancel", false)}
      title="Save this Prism project"
      description="This project came from a Prism file. Save it as the open Helix format (recommended — your data stays readable by any program, forever), or save it as Prism format. The original Prism file is never changed either way."
      footer={
        <>
          <Button variant="accent" onClick={() => onChoose("hlx", remember)}>
            Save as .hlx
          </Button>
          <Button onClick={() => onChoose("prism", remember)}>Save as Prism</Button>
        </>
      }
    >
      <label className="flex items-center gap-2 text-regular">
        <input
          type="checkbox"
          className="accent-accent focus-visible:outline-none"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
        />
        Don&apos;t ask again for Prism files
      </label>
    </Dialog>
  );
}
