// Plugin loading + lifecycle — v3 Phase 4 groundwork (roadmap §4b).
//
// A plugin is a folder/zip: `plugin.json` (manifest + analysis specs) +
// code + README. Loading here is deliberately shallow: parse the manifest
// and specs, run the install-time gates (manifest validation, unknown
// permissions, R denylist scan), and record the install. The plugin's JS
// is NEVER executed by this groundwork — there is no Isolation webview
// yet (Phase 4), and executing third-party JS without it would be the
// no-sandbox default the roadmap explicitly does NOT borrow from VS Code.
//
// Lifecycle (Obsidian model, roadmap §4b):
//   install → "disabled" (default; nothing runs)
//   requestEnable → "pending-review" (the UI shows the plain-language
//     permission lines and the user picks what to grant)
//   confirmEnable(granted) → "enabled" (analyses register; only granted
//     permissions count at the capability gate — capabilities.ts)
//   disable → "disabled" (analyses unregister at once)
//   app update → recheckPluginCompatibility: an incompatible plugin goes
//     "incompatible" with a clear message ("needs Titer 3.x") instead of
//     crashing, and is never auto-enabled again — the user re-enables it
//     after its author updates it.
//
// The actual file picking (Tauri dialog / drag-and-drop) and the review UI
// are Phase 4; this module takes bytes (zip) or a file map (folder) so both
// call sites share the same gates.

import JSZip from "jszip";
import {
  manifestReviewLines,
  pluginIncompatibility,
  validatePluginManifest,
  type PluginManifest,
  type PluginPermission,
} from "./manifest";
import { validatePluginAnalysisSpec, type PluginAnalysisSpecJson } from "./analysis-spec";
import { registerPluginAnalysesFromManifest, unregisterPlugin } from "./registry";

/** Install lifecycle state. */
export type PluginStatus = "disabled" | "pending-review" | "enabled" | "incompatible";

/** One installed plugin: its manifest + specs, its state, and what the
 *  user granted at the enable review step (a subset of the manifest's
 *  permissions — see capabilities.ts). */
export interface PluginRecord {
  manifest: PluginManifest;
  analyses: PluginAnalysisSpecJson[];
  status: PluginStatus;
  installedAt: string;
  /** Why the plugin is "incompatible", while it is. */
  incompatibility?: string;
  grantedPermissions: PluginPermission[];
  source: { kind: "zip" | "folder"; name: string };
}

/** A parsed plugin package, before install. */
export interface ParsedPluginPackage {
  manifest: PluginManifest;
  analyses: PluginAnalysisSpecJson[];
  /** Non-fatal notes (a missing README) — install proceeds. */
  warnings: string[];
}

/**
 * Parse a plugin folder's files (name → text content). `plugin.json` at the
 * root is required; it carries the manifest AND the analysis specs. The
 * entry file, when the manifest names one, must exist and be JS/TS — no
 * native code, no sidecars from third parties in v3.
 */
export function parsePluginPackage(
  files: ReadonlyMap<string, string>,
): { package: ParsedPluginPackage } | { errors: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rawJson = files.get("plugin.json");
  if (rawJson === undefined) {
    return { errors: ["This plugin has no plugin.json at its root — a plugin folder needs one."] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawJson) as unknown;
  } catch (err) {
    return { errors: [`plugin.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const manifestResult = validatePluginManifest(raw);
  if ("errors" in manifestResult) return { errors: manifestResult.errors };
  const { manifest } = manifestResult;

  const rawAnalyses = (raw as Record<string, unknown>).analyses;
  if (!Array.isArray(rawAnalyses) || rawAnalyses.length === 0) {
    return { errors: ["plugin.json must list at least one analysis under “analyses”."] };
  }
  const analyses: PluginAnalysisSpecJson[] = [];
  rawAnalyses.forEach((specValue, i) => {
    const result = validatePluginAnalysisSpec(specValue, { allowTypeScriptCompute: false });
    if ("errors" in result) {
      errors.push(...result.errors.map((e) => `Analysis ${i + 1}: ${e}`));
    } else {
      analyses.push(result.spec as PluginAnalysisSpecJson);
    }
  });
  if (errors.length) return { errors };

  if (manifest.entry !== undefined) {
    const entry = files.get(manifest.entry);
    if (entry === undefined) {
      errors.push(`Plugin entry “${manifest.entry}” is named in the manifest but is not in the plugin folder.`);
    } else if (!/\.(js|mjs|ts)$/.test(manifest.entry)) {
      errors.push(
        `Plugin entry “${manifest.entry}” is not JavaScript/TypeScript — plugins are JS/TS + R only in v3 (no native code, no sidecars).`,
      );
    }
  }
  if (errors.length) return { errors };

  if (![...files.keys()].some((n) => /^readme(\.md|\.txt)?$/i.test(n))) {
    warnings.push("This plugin has no README — a plugin folder should include one.");
  }
  return { package: { manifest, analyses, warnings } };
}

/** Load a plugin from a zip's bytes (in-app install, marketplace download). */
export async function loadPluginFromZip(
  bytes: Uint8Array | ArrayBuffer,
  name: string,
): Promise<{ package: ParsedPluginPackage } | { errors: string[] }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    return { errors: [`“${name}” is not a readable zip file: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const files = new Map<string, string>();
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    // Text files only: the manifest, code and docs. Binaries (screenshots)
    // travel in the zip but are not read by this groundwork.
    if (!/\.(json|js|mjs|ts|md|txt)$/i.test(path)) continue;
    files.set(path, await entry.async("string"));
  }
  return parsePluginPackage(files);
}

/** Load a plugin from a folder's files (folder picked by the user). */
export function loadPluginFromFiles(
  files: ReadonlyMap<string, string>,
  name: string,
): { package: ParsedPluginPackage } | { errors: string[] } {
  void name;
  return parsePluginPackage(files);
}

/**
 * Install a parsed package. Plugins install DISABLED by default — nothing
 * runs until the review step enables it. A duplicate id is rejected.
 */
export function installPlugin(
  parsed: ParsedPluginPackage,
  existingIds: readonly string[],
  source: PluginRecord["source"],
): { record: PluginRecord } | { errors: string[] } {
  if (existingIds.includes(parsed.manifest.id)) {
    return { errors: [`Plugin “${parsed.manifest.id}” is already installed.`] };
  }
  return {
    record: {
      manifest: parsed.manifest,
      analyses: parsed.analyses,
      status: "disabled",
      installedAt: new Date().toISOString(),
      grantedPermissions: [],
      source,
    },
  };
}

/** Start the enable review: "disabled" → "pending-review". Invalid
 *  transitions (already enabled, incompatible) are programmer errors and throw. */
export function requestEnable(record: PluginRecord): PluginRecord {
  if (record.status === "enabled") throw new Error(`Plugin “${record.manifest.id}” is already enabled.`);
  if (record.status === "incompatible")
    throw new Error(
      record.incompatibility ?? `Plugin “${record.manifest.id}” is incompatible with this Titer and cannot be enabled.`,
    );
  if (record.status === "pending-review") return record;
  return { ...record, status: "pending-review" };
}

/**
 * Finish the enable review: the user has seen the plain-language
 * permission lines and granted a subset. Grants outside the manifest's
 * declared permissions are rejected (a grant cannot smuggle in a
 * capability the manifest never declared). An incompatible plugin does
 * not enable — it goes "incompatible" with the clear message instead.
 * On success the plugin's analyses register (registry.ts).
 */
export function confirmEnable(
  record: PluginRecord,
  granted: readonly PluginPermission[],
  appVersion: string,
): PluginRecord {
  if (record.status !== "pending-review")
    throw new Error(`Plugin “${record.manifest.id}” is not awaiting review — call requestEnable first.`);
  const undeclared = granted.filter((p) => !record.manifest.permissions.includes(p));
  if (undeclared.length)
    throw new Error(
      `Cannot grant ${undeclared.join(", ")} — the plugin never declared ${undeclared.length > 1 ? "them" : "it"}.`,
    );
  const incompatibility = pluginIncompatibility(record.manifest, appVersion);
  if (incompatibility) {
    return { ...record, status: "incompatible", incompatibility };
  }
  const registered = registerPluginAnalysesFromManifest(record.manifest.id, record.analyses);
  if ("errors" in registered) throw new Error(`Could not enable plugin “${record.manifest.id}”: ${registered.errors.join(" ")}`);
  return { ...record, status: "enabled", grantedPermissions: [...granted], incompatibility: undefined };
}

/** Disable a plugin: its analyses unregister at once, so they vanish from
 *  the registry (and from `resolveAnalysis`) immediately. */
export function disablePlugin(record: PluginRecord): PluginRecord {
  unregisterPlugin(record.manifest.id);
  return { ...record, status: "disabled", incompatibility: undefined };
}

/**
 * Re-run the compatibility check after an app update. An incompatible
 * plugin disables with its message instead of crashing — and is never
 * auto-enabled again: a plugin that becomes compatible again returns to
 * "disabled" and waits for the user to re-enable it.
 */
export function recheckPluginCompatibility(record: PluginRecord, appVersion: string): PluginRecord {
  const incompatibility = pluginIncompatibility(record.manifest, appVersion);
  if (incompatibility) {
    if (record.status === "enabled" || record.status === "pending-review") unregisterPlugin(record.manifest.id);
    return { ...record, status: "incompatible", incompatibility };
  }
  if (record.status === "incompatible") {
    return { ...record, status: "disabled", incompatibility: undefined };
  }
  return record;
}

/** The review-step lines for a plugin: what it is, what it can do (plain
 *  language), and the disabled-by-default note. */
export function pluginReviewLines(record: PluginRecord): string[] {
  const lines = manifestReviewLines(record.manifest);
  lines.push(
    record.status === "disabled"
      ? "Installed disabled — nothing runs until you enable it."
      : `Status: ${record.status}.`,
  );
  if (record.grantedPermissions.length) {
    lines.push(`Previously granted: ${record.grantedPermissions.join(", ")}.`);
  }
  if (record.incompatibility) lines.push(record.incompatibility);
  return lines;
}
