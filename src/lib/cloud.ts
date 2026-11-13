// Cloud storage — the file layer (v2 backlog item 75, Box first).
// One `FileHandle` for local and remote files: `use-document.ts` and the
// converter call `readFile` / `writeFile` on the abstraction instead of
// `native.*` directly. Local handles keep today's exact behaviour (atomic
// write included); remote handles go through the Rust provider client.
//
// Rules: a remote save is conditional on the version seen at open/last-save
// — a mismatch is a conflict, never a silent overwrite, and autosave never
// takes the overwrite path. Offline never discards the in-memory document:
// a failed save keeps the document and its cache copy, and offers a retry
// or "Save a local copy". The frontend only ever sees auth *state*, never
// raw tokens.
import * as native from "../native";

/** The providers the file layer knows. Only `box` is real in this slice;
 *  `mock` is the in-memory fake (dev/QA only). Dropbox / OneDrive / Drive
 *  come later, one per slice, behind the same trait. */
export type ProviderId = "box" | "mock";

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  box: "Box",
  mock: "Mock (dev only)",
};

/** A file, wherever it lives. `version` is the provider's change token
 *  (Box `version_number`); a save is conditional on it. */
export type FileHandle =
  | { kind: "local"; path: string }
  | {
      kind: "remote";
      provider: ProviderId;
      /** The connected account (Box user id) this file belongs to. */
      accountId: string;
      fileId: string;
      /** Display path, provider-rooted ("/Research/Data.hlx"). */
      path: string;
      version: string | null;
      sha1: string | null;
      modifiedAt: string | null;
    };

export const localHandle = (path: string): FileHandle => ({ kind: "local", path });

export const remoteHandle = (
  provider: ProviderId,
  accountId: string,
  fileId: string,
  path: string,
  version: string | null,
  sha1: string | null = null,
  modifiedAt: string | null = null,
): Extract<FileHandle, { kind: "remote" }> => ({
  kind: "remote",
  provider,
  accountId,
  fileId,
  path,
  version,
  sha1,
  modifiedAt,
});

/** The handle's stable identity (recents, the conflict dialog, the cache). */
export const handleKey = (handle: FileHandle): string =>
  handle.kind === "local" ? `local:${handle.path}` : `${handle.provider}:${handle.fileId}`;

/** What the window title and Open Recent show. */
export const handleLabel = (handle: FileHandle): string =>
  handle.kind === "local"
    ? (handle.path.split(/[\\/]/).pop() ?? handle.path)
    : (handle.path.split("/").pop() ?? handle.path);

export const handleDisplayPath = (handle: FileHandle): string =>
  handle.kind === "local" ? handle.path : `${PROVIDER_NAMES[handle.provider]}:${handle.path}`;

export const isRemote = (handle: FileHandle | null | undefined): handle is Extract<FileHandle, { kind: "remote" }> =>
  !!handle && handle.kind === "remote";

/** One file or folder in a provider account, as the remote picker sees it. */
export interface RemoteEntry {
  id: string;
  kind: "file" | "folder";
  name: string;
  path: string;
  size?: number | null;
  modifiedAt?: string | null;
  version?: string | null;
  sha1?: string | null;
  /** The parent folder's id ("0" is the Box root) — from metadata, for
   *  "Save as a copy" next to the original. */
  parentId?: string | null;
}

/** A downloaded remote file: bytes (base64 over the bridge) + the version
 *  the next save is conditional on. */
export interface RemoteDownload {
  base64: string;
  name: string;
  version?: string | null;
  sha1?: string | null;
  modifiedAt?: string | null;
}

export interface RemoteVersion {
  version: string;
  sha1?: string | null;
  modifiedAt?: string | null;
}

/** A connected account, as the page sees it: identity only, never tokens. */
export interface CloudAccount {
  provider: string;
  id: string;
  login: string;
  name: string;
}

export interface CloudStatus {
  accounts: CloudAccount[];
  boxHasCredentials: boolean;
  boxHasBroker: boolean;
}

/** A cloud failure, as the shell serializes it (`{ kind, ... }`). */
export type CloudError =
  | { kind: "not_configured"; message: string }
  | { kind: "not_authenticated"; message: string }
  | {
      kind: "conflict";
      remote_version: string;
      remote_modified_at?: string | null;
      remote_sha1?: string | null;
      message: string;
    }
  | { kind: "offline"; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "too_large"; message: string }
  | { kind: "provider"; message: string }
  | { kind: "keychain"; message: string }
  | { kind: "cancelled"; message: string };

export const isCloudError = (err: unknown): err is CloudError =>
  typeof err === "object" && err !== null && "kind" in err && typeof (err as CloudError).kind === "string";

export const isConflictError = (err: unknown): err is Extract<CloudError, { kind: "conflict" }> =>
  isCloudError(err) && err.kind === "conflict";

export const isOfflineError = (err: unknown): err is Extract<CloudError, { kind: "offline" }> =>
  isCloudError(err) && err.kind === "offline";

export const isNotAuthenticatedError = (err: unknown): boolean => isCloudError(err) && err.kind === "not_authenticated";

export const cloudErrorMessage = (err: unknown): string =>
  isCloudError(err) ? err.message : err instanceof Error ? err.message : String(err);

/** "Data.hlx" → "Data (copy).hlx": the conflict dialog's "Save as a copy". */
export const copyName = (name: string): string => {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name} (copy)`;
  return `${name.slice(0, dot)} (copy)${name.slice(dot)}`;
};

/** Bytes over the bridge are base64 (like `readPrismBytes`). */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

export const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

// ── The abstraction ──────────────────────────────────────────────────────
// Local handles go through the same `native.*` calls as today (unchanged
// behaviour, atomic write included). Remote handles go through the Rust
// provider client, which downloads to / uploads from the local cache copy.

/** Reads a `.hlx` file's text, local or remote. */
export async function readFileText(handle: FileHandle): Promise<string> {
  if (handle.kind === "local") return native.readText(handle.path);
  const downloaded = await native.cloudDownload(handle.provider, handle.accountId, handle.fileId);
  return new TextDecoder().decode(base64ToBytes(downloaded.base64));
}

/** Reads a file's bytes (`.prism` is a ZIP), local or remote. */
export async function readFileBytes(handle: FileHandle): Promise<Uint8Array> {
  if (handle.kind === "local") return native.readPrismBytes(handle.path);
  const downloaded = await native.cloudDownload(handle.provider, handle.accountId, handle.fileId);
  return base64ToBytes(downloaded.base64);
}

/** Writes bytes, local or remote. Remote writes are conditional on
 *  `expectedVersion` (the version seen at open/last-save) when given;
 *  `null` means "overwrite anyway" — the conflict dialog's explicit third
 *  choice only, never the default path and never autosave. Returns the new
 *  remote version for remote handles. */
export async function writeFile(
  handle: FileHandle,
  bytes: Uint8Array,
  expectedVersion?: string | null,
): Promise<RemoteVersion | null> {
  if (handle.kind === "local") {
    await native.writeFile(handle.path, bytes);
    return null;
  }
  return native.cloudUpload(
    handle.provider,
    handle.accountId,
    handle.fileId,
    handle.path.split("/").pop() ?? handle.path,
    bytesToBase64(bytes),
    expectedVersion ?? handle.version,
  );
}

/** The cache copy of a remote file, for opening while offline. */
export async function readCachedFile(handle: Extract<FileHandle, { kind: "remote" }>): Promise<Uint8Array> {
  const cached = await native.cloudReadCache(
    handle.provider,
    handle.fileId,
    handle.path.split("/").pop() ?? handle.path,
  );
  return base64ToBytes(cached.base64);
}
