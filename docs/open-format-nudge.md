# Open-format nudge — friction audit + no-dark-patterns rule

Plan prism-format-work, sub-task (f). The nudge asks once, when a project
that came from a Prism file is saved, whether to keep it as the open `.hlx`
format (recommended — your data stays readable by any program, forever) or
save it as Prism format. It never blocks saving, never nags, and never
hides the Prism option.

## f.2 Friction audit — every "trapped" feeling has a one-click way out

| "I'm trapped because…" | Way out (verified in the app) |
|---|---|
| "My collaborator needs Prism" | Save prompt → "Save as Prism (.prism)"; also File ▸ Convert… → Helix → Prism → "Save .prism…". Prism 10+ can itself save as `.pzfx`, so a collaborator who needs `.pzfx` gets it by opening Helix's `.prism` in Prism and re-saving. |
| "My lab only accepts Prism files" | Same as above — "Save as Prism" is one click in the save prompt, every time until "don't ask again" is set; after that, File ▸ Convert… is still one click away. |
| "I already sent the `.prism`" | The original file is never modified by import, conversion, or migration (proved by checksum in tests/prism.ts, P7/C-08). The sent file is untouched; send the new `.prism` when ready, or keep working in `.hlx` and convert at the end. |
| "I don't want to lose my graphs/layouts" | The transfer report says so plainly at import and at conversion: graphs and layouts are not transferred (Prism stores them in an undocumented binary format). They are re-created in Helix (graphs) or with the figure builder (layouts) — nothing is silently dropped. |
| "I clicked the wrong thing and now I'm stuck in `.hlx`" | Nothing is stuck: File ▸ Convert… converts back to `.prism` at any time, and the save prompt's Prism option is always visible, never behind a second click. |
| "The prompt keeps asking" | It asks at most once per project (f.4). "Don't ask again" remembers the choice in app settings; the prompt never reappears for that choice. |

## f.4 No dark patterns — the rule

- Prompt once per project; respect "don't ask again" (stored in app
  settings — `localStorage` key `helix.prism-save-choice` — never in the
  `.hlx` file, which holds the project only).
- Prism save always one click away; never hidden behind a second click.
- No nagging, no guilt copy. The forbidden line — "Are you sure you want
  to stay locked in?" — must never appear. The approved line is the one in
  the save prompt: "Save as the open Helix format (recommended — your data
  stays readable by any program, forever), or save as Prism format."
- Esc / Cancel still saves in the current format (`.hlx` for an imported,
  unsaved project).

## f.3 Migration helper

"Move this project to open format" is the save prompt's
"Save as .hlx (recommended)" action on a Prism-origin project: the project
was already converted on import (tables + supported analyses, with the
transfer report as the before/after summary — tables N, analyses N, graphs
re-created: 0 transferred, stated honestly), the Prism original is untouched
(checksum-proved), and saving as `.hlx` completes the move in under a
minute for a normal project. File ▸ Convert… → "Open in Helix" +
"Save .hlx…" is the same move from the converter.
