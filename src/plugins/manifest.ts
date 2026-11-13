// Plugin manifest — v3 Phase 4 groundwork (roadmap §4b).
//
// A plugin is a folder/zip: `plugin.json` (this manifest + its analysis
// specs) + code + README. No Rust, no native code, no sidecars from third
// parties in v3 — JS/TS + R only, so the containment story holds.
//
// The manifest declares id, name, version, apiVersion, author, license and
// permissions. Validation here is the install-time gate: anything malformed,
// or any permission name outside the allowlist, is rejected at install time
// — a capability cannot be smuggled in.
//
// BLOCKED (roadmap §6 Q7/Q8 — this groundwork assumes nothing about them):
// paid plugins under GPL-3.0 needs Smit + a lawyer, so there is NO license
// allowlist here: the license string is recorded verbatim and never judged.
// Who reviews listings / what hosts the marketplace is likewise undecided,
// so there is no review queue or listing flow in this lane.

/** The plugin API major version this build of Titer speaks. Titer
 *  guarantees the plugin API within a major version (roadmap §4b). */
export const PLUGIN_API_MAJOR = 3;
/** The plugin API version this build implements ("3.0"). */
export const PLUGIN_API_VERSION = "3.0";
/** The app name, for the incompatibility message. */
export const APP_NAME = "Titer";

/** What a plugin may ask to do. This is the whole allowlist: a permission
 *  name outside it is rejected at install time (see `validatePluginManifest`).
 *  `network` is denied by default — a plugin must declare it AND the user
 *  must approve it at the enable review step (see loader.ts); the default
 *  answer is no. */
export type PluginPermission = "read-table" | "run-analysis" | "write-analysis" | "save-file" | "open-link" | "network";

export const KNOWN_PERMISSIONS: readonly PluginPermission[] = [
  "read-table",
  "run-analysis",
  "write-analysis",
  "save-file",
  "open-link",
  "network",
];

/** Plain-language lines for the install/review step — shown to the user, never
 *  a raw permission string (roadmap §4b). */
export const PERMISSION_DESCRIPTIONS: Record<PluginPermission, string> = {
  "read-table": "Read the open table (only the tables and columns you pass it)",
  "run-analysis": "Run its own analyses on your data",
  "write-analysis": "Add new analyses and results to your project",
  "save-file": "Save files and export results through Titer",
  "open-link": "Open links in your browser",
  network: "Access the network (off unless you approve it)",
};

/** The plain-language lines for these permissions, in allowlist order. */
export function describePermissions(permissions: readonly PluginPermission[]): string[] {
  return KNOWN_PERMISSIONS.filter((p) => permissions.includes(p)).map((p) => PERMISSION_DESCRIPTIONS[p]);
}

/** A parsed semantic version: `1.2.3`, `1.2`, or `v1.2.3`. No prerelease or
 *  build metadata — a plugin version is a plain release number. */
export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(value: unknown): Semver | null {
  if (typeof value !== "string") return null;
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) };
}

/** Whether version `a` is at least `b` (same major/minor/patch compare). */
export function semverAtLeast(a: Semver, b: Semver): boolean {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

/** A plugin id: lowercase letters, digits, `.`, `_`, `-` — reverse-domain
 *  style (`example.hello-analysis`). The `titer.` prefix is reserved for
 *  first-party plugins. */
const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]*$/;

export function isValidPluginId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 128 && PLUGIN_ID.test(id) && !id.startsWith("titer.");
}

/** The manifest itself: id, name, version, apiVersion, author, license,
 *  permissions — exactly the roadmap §4b table's Definition row. `entry` is
 *  the plugin's JS entry file inside its folder/zip (loaded by the Phase 4
 *  Isolation webview; groundwork only checks it exists). `minAppVersion`
 *  is the earliest Titer the plugin supports; absent, any Titer speaking
 *  this API major. `description`/`homepage` are shown on the review step. */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  author: string;
  license: string;
  permissions: PluginPermission[];
  description?: string;
  homepage?: string;
  entry?: string;
  minAppVersion?: string;
}

const isNonEmptyString = (v: unknown, max = 128): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;

/**
 * Validate a parsed `plugin.json` manifest. Returns the typed manifest, or
 * the plain-language problems that reject the install. Unknown top-level
 * keys are ignored (forward compatibility — a newer manifest may carry
 * fields this build does not know); unknown PERMISSION names are errors.
 * The `analyses` array lives in the same file and is validated separately
 * by `validatePluginAnalysisSpec` (analysis-spec.ts) — this function does
 * not look at it.
 */
export function validatePluginManifest(value: unknown): { manifest: PluginManifest } | { errors: string[] } {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { errors: ["The plugin manifest (plugin.json) must be a JSON object."] };
  }
  const v = value as Record<string, unknown>;

  if (!isValidPluginId(v.id)) {
    errors.push(
      typeof v.id === "string" && v.id.startsWith("titer.")
        ? `Plugin id “${v.id}” starts with “titer.”, which is reserved for first-party plugins.`
        : "Plugin id must be lowercase letters, digits, “.”, “_” or “-” (for example “example.hello-analysis”).",
    );
  }
  if (!isNonEmptyString(v.name)) errors.push("Plugin name must be a non-empty string.");
  if (parseSemver(v.version) === null)
    errors.push(`Plugin version “${String(v.version)}” is not a version like “1.0.0”.`);
  if (parseSemver(v.apiVersion) === null)
    errors.push(`Plugin apiVersion “${String(v.apiVersion)}” is not a version like “3.0”.`);
  if (!isNonEmptyString(v.author)) errors.push("Plugin author must be a non-empty string.");
  if (!isNonEmptyString(v.license, 256))
    errors.push("Plugin license must be a non-empty string (for example “MIT” or “GPL-3.0-or-later”).");
  if (!Array.isArray(v.permissions)) {
    errors.push("Plugin permissions must be a list (possibly empty).");
  } else {
    const seen = new Set<string>();
    for (const p of v.permissions) {
      if (typeof p !== "string" || !(KNOWN_PERMISSIONS as readonly string[]).includes(p)) {
        errors.push(`Unknown permission “${String(p)}” — a plugin may only ask for: ${KNOWN_PERMISSIONS.join(", ")}.`);
      } else if (seen.has(p)) {
        errors.push(`Permission “${p}” is listed twice.`);
      } else {
        seen.add(p);
      }
    }
  }
  if (v.description !== undefined && typeof v.description !== "string")
    errors.push("Plugin description must be a string.");
  if (v.homepage !== undefined && typeof v.homepage !== "string") errors.push("Plugin homepage must be a string.");
  if (v.entry !== undefined && (typeof v.entry !== "string" || v.entry.trim().length === 0))
    errors.push("Plugin entry must be a non-empty file name (for example “index.js”).");
  if (v.entry !== undefined && typeof v.entry === "string" && !/^[A-Za-z0-9._/-]+$/.test(v.entry))
    errors.push(`Plugin entry “${v.entry}” must be a plain file name inside the plugin folder.`);
  if (v.minAppVersion !== undefined && parseSemver(v.minAppVersion) === null)
    errors.push(`Plugin minAppVersion “${String(v.minAppVersion)}” is not a version like “3.0.0”.`);

  if (errors.length) return { errors };
  return {
    manifest: {
      id: v.id as string,
      name: (v.name as string).trim(),
      version: v.version as string,
      apiVersion: v.apiVersion as string,
      author: (v.author as string).trim(),
      license: (v.license as string).trim(),
      permissions: [...(v.permissions as PluginPermission[])],
      ...(typeof v.description === "string" ? { description: v.description } : {}),
      ...(typeof v.homepage === "string" ? { homepage: v.homepage } : {}),
      ...(typeof v.entry === "string" ? { entry: v.entry } : {}),
      ...(typeof v.minAppVersion === "string" ? { minAppVersion: v.minAppVersion } : {}),
    },
  };
}

/** Why a plugin cannot run on this build: `null` when it can. */
export function pluginIncompatibility(manifest: PluginManifest, appVersion: string): string | null {
  const api = parseSemver(manifest.apiVersion);
  if (api && api.major !== PLUGIN_API_MAJOR) {
    // The roadmap's message, verbatim in shape: "needs Titer 3.x".
    return (
      `“${manifest.name}” needs ${APP_NAME} ${api.major}.x — it was built for plugin API ` +
      `${api.major}.x, and this ${APP_NAME} speaks plugin API ${PLUGIN_API_MAJOR}.x. ` +
      `It is disabled until its author updates it.`
    );
  }
  const min = manifest.minAppVersion ? parseSemver(manifest.minAppVersion) : null;
  const app = parseSemver(appVersion);
  if (min && app && !semverAtLeast(app, min)) {
    return (
      `“${manifest.name}” needs ${APP_NAME} ${manifest.minAppVersion} or newer — ` +
      `this ${APP_NAME} is ${appVersion}. It is disabled until you update ${APP_NAME}.`
    );
  }
  return null;
}

/** The install/review lines for a manifest: name, version, author, license,
 *  then one plain-language line per permission (or "asks for no permissions"). */
export function manifestReviewLines(manifest: PluginManifest): string[] {
  const lines = [`${manifest.name} ${manifest.version} by ${manifest.author}`, `License: ${manifest.license}`];
  if (manifest.description) lines.push(manifest.description);
  const perms = describePermissions(manifest.permissions);
  lines.push(perms.length ? `This plugin can: ${perms.join("; ")}.` : "This plugin asks for no permissions.");
  return lines;
}
