// Floating notes: color-coded sticky notes pinned to a sheet (data, results
// or graph) for review or collaboration. They live on the sheet's node, are
// shown on screen only, and never reach print or any export: the graph and
// figure exporters render Plotly figures, never this DOM layer (see
// graph-export.ts / figure-export.ts), and the .prism writer writes typed
// fields only — so there is nothing to strip at export time, by construction.
// The layer itself is `pointer-events-none` except for the notes, so the sheet
// beneath keeps working; a note drags from its body, edits on click, and
// deletes with its × (Undo brings it back).
import * as React from "react";
import { PlusIcon, XIcon } from "@phosphor-icons/react";
import { FLOATING_NOTE_COLORS, type FloatingNote, type FloatingNoteColor, type ProjectNode } from "../store/types";
import { useProjectActions } from "../store/use-project-store";
import { Button, cn } from "../ui/controls";

/** A note's sticky colors: pale fill, a darker edge, dark ink. */
const NOTE_STYLE: Record<FloatingNoteColor, { background: string; border: string }> = {
  yellow: { background: "#fff7ae", border: "#e3d26a" },
  gray: { background: "#ececec", border: "#c9c9c9" },
  green: { background: "#d9f3c0", border: "#a8d98a" },
  pink: { background: "#ffd7e5", border: "#f0a8c0" },
  blue: { background: "#cfe8ff", border: "#9cc8f0" },
};

const NOTE_WIDTH = 180;

/** A new note's id, like the store's `genId`. */
function noteId() {
  return `note_${Math.random().toString(36).slice(2, 10)}`;
}

/** The button that pins a note to a sheet: it lands near the top-left,
 *  staggered so a fresh note never covers the last one. */
export function AddFloatingNoteButton({ node }: { node: ProjectNode }) {
  const { updateFloatingNotes } = useProjectActions();
  const notes = node.floatingNotes ?? [];
  return (
    <Button
      size="small"
      className="floating-note-add"
      title="Pin a note to this sheet — shown on screen, never printed or exported"
      aria-label="Add note"
      onClick={() => {
        const step = notes.length % 5;
        updateFloatingNotes(node.id, [
          ...notes,
          { id: noteId(), text: "", color: "yellow", x: 24 + step * 24, y: 24 + step * 24 },
        ]);
      }}
    >
      <PlusIcon className="size-3.5" /> Note
    </Button>
  );
}

/** The notes pinned to a sheet, over its content. The parent must be
 *  `relative`: the layer covers it, and note positions are px from its
 *  top-left (in the sheet's own px — inside a zoomed graph sheet the layer
 *  inherits the sheet's scale, so notes stay pinned to the graph). */
export function FloatingNotesLayer({ node }: { node: ProjectNode }) {
  const { updateFloatingNotes } = useProjectActions();
  const notes = node.floatingNotes ?? [];
  const layerRef = React.useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [drag, setDrag] = React.useState<{ id: string; x: number; y: number } | null>(null);
  const dragStart = React.useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);

  const setNotes = (next: FloatingNote[]) => updateFloatingNotes(node.id, next);
  // A pointer position in the layer's own px (the layer may sit inside a
  // scaled sheet, so the screen rect is divided back down).
  const toLayer = (e: React.PointerEvent) => {
    const el = layerRef.current!;
    const rect = el.getBoundingClientRect();
    const scale = rect.width / (el.offsetWidth || 1) || 1;
    return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
  };

  const commitDraft = (id: string) => {
    setNotes(notes.map((n) => (n.id === id ? { ...n, text: draft } : n)));
    setEditingId(null);
  };

  return (
    <div ref={layerRef} className="floating-notes-layer pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {notes.map((note) => {
        const shown = drag?.id === note.id ? drag : note;
        const editing = editingId === note.id;
        const style = NOTE_STYLE[note.color];
        return (
          <div
            key={note.id}
            role="note"
            aria-label={note.text ? `Note: ${note.text}` : "Empty note"}
            className="floating-note pointer-events-auto absolute flex flex-col rounded-md shadow-md"
            style={{
              left: shown.x,
              top: shown.y,
              width: NOTE_WIDTH,
              background: style.background,
              border: `1px solid ${style.border}`,
              color: "#1a1a1a",
              touchAction: "none",
            }}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest("textarea,button,input")) return;
              const p = toLayer(e);
              dragStart.current = { px: p.x, py: p.y, x: note.x, y: note.y, moved: false };
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const start = dragStart.current;
              if (!start) return;
              const p = toLayer(e);
              const dx = p.x - start.px;
              const dy = p.y - start.py;
              if (Math.abs(dx) + Math.abs(dy) > 3) start.moved = true;
              if (start.moved) setDrag({ id: note.id, x: Math.max(0, start.x + dx), y: Math.max(0, start.y + dy) });
            }}
            onPointerUp={(e) => {
              const start = dragStart.current;
              dragStart.current = null;
              if (!start) return;
              if (start.moved) {
                // Drop where the pointer is, from the event — not from state,
                // which may not have flushed the last move yet.
                const p = toLayer(e);
                const x = Math.max(0, start.x + (p.x - start.px));
                const y = Math.max(0, start.y + (p.y - start.py));
                setDrag(null);
                setNotes(notes.map((n) => (n.id === note.id ? { ...n, x, y } : n)));
              } else if ((e.target as HTMLElement).closest("[data-note-text]")) {
                // A click on the text edits it (a drag never does).
                setDraft(note.text);
                setEditingId(note.id);
              }
            }}
          >
            <div className="flex items-center justify-between px-1.5 pt-1">
              <span className="flex items-center gap-1" aria-label="Note color">
                {FLOATING_NOTE_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={`Color: ${c}`}
                    aria-label={`Note color ${c}`}
                    aria-pressed={note.color === c}
                    className="size-3 rounded-full border border-black/25"
                    style={{ background: NOTE_STYLE[c].background }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setNotes(notes.map((n) => (n.id === note.id ? { ...n, color: c } : n)));
                    }}
                  />
                ))}
              </span>
              <button
                type="button"
                title="Delete note (Undo brings it back)"
                aria-label="Delete note"
                className="rounded p-0.5 text-black/50 hover:bg-black/10 hover:text-black"
                onClick={(e) => {
                  e.stopPropagation();
                  setNotes(notes.filter((n) => n.id !== note.id));
                }}
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
            {editing ? (
              <textarea
                autoFocus
                value={draft}
                rows={3}
                aria-label="Note text"
                placeholder="Write a note…"
                className="mx-1.5 mb-1.5 resize-none rounded bg-white/60 px-1.5 py-1 text-regular text-black outline-none"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commitDraft(note.id)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditingId(null);
                  else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commitDraft(note.id);
                }}
              />
            ) : (
              <p
                data-note-text
                className={cn("px-2.5 pt-0.5 pb-2 text-regular break-words whitespace-pre-wrap", !note.text && "italic opacity-50")}
                title="Click to edit"
              >
                {note.text || "Write a note…"}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
