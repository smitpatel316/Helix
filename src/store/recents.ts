// Open Recent: the projects last opened or saved, newest first. One list for every
// window (local storage), also handed to macOS for the Dock icon's menu
// (local files only — the Dock menu can't open a remote file).
import { setRecentDocuments } from "../native";
import type { ProviderId } from "../lib/cloud";

const KEY = "titer.recent";
export const MAX_RECENTS = 10;

/** A recent project, local or remote. Remote entries carry the provider +
 *  account + file id + display path — never a local path, which a remote
 *  file doesn't have. */
export type RecentEntry =
  | { kind: "local"; path: string }
  | { kind: "remote"; provider: ProviderId; accountId: string; fileId: string; path: string };

export const recentKey = (entry: RecentEntry): string =>
  entry.kind === "local" ? `local:${entry.path}` : `${entry.provider}:${entry.accountId}:${entry.fileId}`;

export const recentLabel = (entry: RecentEntry): string =>
  entry.kind === "local"
    ? (entry.path.split(/[\\/]/).pop() ?? entry.path)
    : `${entry.path.split("/").pop() ?? entry.path} (${entry.provider === "box" ? "Box" : entry.provider})`;

/** Parses a stored list: new entries as-is, legacy plain-path strings as
 *  local entries, anything else left out. Pure, so checks.ts pins it. */
export function parseRecents(raw: unknown): RecentEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: RecentEntry[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      entries.push({ kind: "local", path: item });
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Partial<RecentEntry>;
    if (entry.kind === "local" && typeof entry.path === "string") {
      entries.push({ kind: "local", path: entry.path });
    } else if (
      entry.kind === "remote" &&
      (entry.provider === "box" || entry.provider === "mock") &&
      typeof entry.accountId === "string" &&
      typeof entry.fileId === "string" &&
      typeof entry.path === "string"
    ) {
      entries.push({
        kind: "remote",
        provider: entry.provider,
        accountId: entry.accountId,
        fileId: entry.fileId,
        path: entry.path,
      });
    }
  }
  return entries.slice(0, MAX_RECENTS);
}

/** The list kept. */
export function loadRecents(): RecentEntry[] {
  try {
    return parseRecents(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export function saveRecents(entries: RecentEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // Not kept: this window's list still shows it.
  }
  // The Dock menu only takes local files.
  setRecentDocuments(
    entries.filter((e): e is Extract<RecentEntry, { kind: "local" }> => e.kind === "local").map((e) => e.path),
  );
}
