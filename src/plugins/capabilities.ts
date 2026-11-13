// Capability allowlist — v3 Phase 4 groundwork (roadmap §4b).
//
// The trust model, stated plainly as the roadmap states it: there is no
// true JS sandbox in a desktop webview. The model is a CAPABILITY BOUNDARY,
// not a sandbox. Plugin JS runs behind the Tauri Isolation pattern and may
// call only the `titer.*` IPC commands its manifest declares; anything
// undeclared FAILS CLOSED — it is not callable at all.
//
// What this groundwork provides is the boundary's decision procedure:
// the catalogue of plugin-facing commands, which permission each one
// needs, and a fail-closed check. The Isolation webview that actually
// intercepts the IPC messages is Phase 4 work; until it exists, no plugin
// JS is executed at all (see loader.ts) — the gate is in place before
// anything can pass through it.
//
// Two sets matter at check time, not one: the permissions the manifest
// DECLARES, and the permissions the user GRANTED at the enable review step.
// A declared permission grants nothing until granted; a granted permission
// is always a subset of the declared ones. `checkCapability` takes the
// granted set.

import type { PluginPermission } from "./manifest";

/** The plugin-facing IPC commands. These are the only commands plugin code
 *  may ever call — the catalogue is closed, and an unknown name is denied
 *  (fail closed), never passed through to the host. */
export type TiterCommand =
  | "titer.readTable"
  | "titer.readColumns"
  | "titer.runAnalysis"
  | "titer.createAnalysis"
  | "titer.saveFile"
  | "titer.exportResults"
  | "titer.openLink"
  | "titer.fetch";

export const KNOWN_COMMANDS: readonly TiterCommand[] = [
  "titer.readTable",
  "titer.readColumns",
  "titer.runAnalysis",
  "titer.createAnalysis",
  "titer.saveFile",
  "titer.exportResults",
  "titer.openLink",
  "titer.fetch",
];

/** Which permission each command needs. One permission per command, so the
 *  install-time review line maps exactly onto what the plugin can do. */
export const COMMAND_PERMISSIONS: Record<TiterCommand, PluginPermission> = {
  "titer.readTable": "read-table",
  "titer.readColumns": "read-table",
  "titer.runAnalysis": "run-analysis",
  "titer.createAnalysis": "write-analysis",
  "titer.saveFile": "save-file",
  "titer.exportResults": "save-file",
  "titer.openLink": "open-link",
  "titer.fetch": "network",
};

/** What each command does, in the user's language — for the review step and
 *  for denial messages, never a raw command string. */
export const COMMAND_DESCRIPTIONS: Record<TiterCommand, string> = {
  "titer.readTable": "read the open table",
  "titer.readColumns": "read the table's columns",
  "titer.runAnalysis": "run an analysis",
  "titer.createAnalysis": "add a new analysis to the project",
  "titer.saveFile": "save a file",
  "titer.exportResults": "export results",
  "titer.openLink": "open a link in the browser",
  "titer.fetch": "access the network",
};

/** The commands a granted permission set allows. */
export function commandsAllowedBy(granted: readonly PluginPermission[]): TiterCommand[] {
  const allowed = new Set(granted);
  return KNOWN_COMMANDS.filter((c) => allowed.has(COMMAND_PERMISSIONS[c]));
}

export type CapabilityCheck = { allowed: true } | { allowed: false; reason: string };

/**
 * Fail-closed capability check. Unknown command: denied. Command whose
 * permission was not granted at the enable review step: denied. Nothing
 * here ever defaults to allowed — a missing entry, a typo, or a permission
 * the manifest never declared all land on the denied side.
 */
export function checkCapability(
  granted: readonly PluginPermission[],
  command: string,
): CapabilityCheck {
  if (!(KNOWN_COMMANDS as readonly string[]).includes(command)) {
    return {
      allowed: false,
      reason: `“${command}” is not a Titer plugin command, so it cannot be called.`,
    };
  }
  const needed = COMMAND_PERMISSIONS[command as TiterCommand];
  if (!granted.includes(needed)) {
    return {
      allowed: false,
      reason:
        `This plugin cannot ${COMMAND_DESCRIPTIONS[command as TiterCommand]} — ` +
        `that needs the “${needed}” permission, which was not granted when the plugin was enabled.`,
    };
  }
  return { allowed: true };
}

/** Thrown (or returned as an error outcome) when plugin code reaches for a
 *  command outside its granted capabilities. */
export class CapabilityDeniedError extends Error {
  constructor(
    readonly command: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "CapabilityDeniedError";
  }
}

/** The throwing form of `checkCapability`, for call sites that treat a
 *  denial as an error outcome. */
export function requireCapability(granted: readonly PluginPermission[], command: string): void {
  const check = checkCapability(granted, command);
  if (!check.allowed) throw new CapabilityDeniedError(command, check.reason);
}
