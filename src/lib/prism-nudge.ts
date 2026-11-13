// The open-format nudge (plan prism-format-work, sub-task (f)): the pure
// decision logic for the save prompt, kept out of the React hook so it can
// be tested headlessly.
//
// Rule (f.4, also in docs/open-format-nudge.md): prompt once per project;
// respect "don't ask again" (stored in app settings — localStorage here,
// never in the `.hlx` file); Prism save always one click away; no nagging,
// no guilt copy. The prompt never blocks saving: Esc / Cancel still saves
// in the current format.

export type PrismSaveChoice = "hlx" | "prism";

const CHOICE_KEY = "helix.prism-save-choice";

/** The remembered choice, or null when the user hasn't set one. Never throws
 *  (no localStorage in tests, private mode, or a quota error all read as "no
 *  remembered choice"). */
export function loadPrismSaveChoice(): PrismSaveChoice | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const value = localStorage.getItem(CHOICE_KEY);
    return value === "hlx" || value === "prism" ? value : null;
  } catch {
    return null;
  }
}

/** Remember the choice (f.1's "remember my choice" checkbox). */
export function savePrismSaveChoice(choice: PrismSaveChoice): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(CHOICE_KEY, choice);
  } catch {
    // A choice that can't be stored is a choice that doesn't stick; the
    // prompt simply appears again next time. Never throw on save.
  }
}

/** Forget the remembered choice (used by tests; there is no user-facing
 *  reset — the choice is a deliberate "don't ask again"). */
export function clearPrismSaveChoice(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(CHOICE_KEY);
  } catch {
    // Ignore.
  }
}

export interface SavePromptState {
  /** The project came from a Prism file (.prism or .pzfx import). */
  prismOrigin: boolean;
  /** The prompt already appeared for this project (f.4: at most once). */
  prompted: boolean;
  /** The remembered "don't ask again" choice, if any. */
  remembered: PrismSaveChoice | null;
}

export type SaveAction = "prompt" | "save-hlx" | "save-prism";

/** What save() should do next, given the nudge state. A remembered choice
 *  wins over "already prompted" — prompting suppresses the prompt, never
 *  the choice itself. */
export function nextSaveAction(state: SavePromptState): SaveAction {
  if (!state.prismOrigin) return "save-hlx";
  if (state.remembered === "prism") return "save-prism";
  if (state.remembered === "hlx" || state.prompted) return "save-hlx";
  return "prompt";
}
