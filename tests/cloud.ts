/// <reference types="node" />
// Checks for cloud storage (v2 item 75, Box first): the file-layer
// abstraction's pure helpers, the recents migration, and the error sorting
// the conflict dialog and offline notice depend on. `npm test` runs them.
// Nothing here touches the network or a real account — the Rust mock
// provider covers the trait behaviour (src-tauri/src/cloud.rs).
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import {
  base64ToBytes,
  boxAuthPath,
  bytesToBase64,
  cloudErrorMessage,
  copyName,
  handleDisplayPath,
  handleKey,
  handleLabel,
  isConflictError,
  isNotAuthenticatedError,
  isOfflineError,
  localHandle,
  remoteHandle,
  type CloudStatus,
} from "../src/lib/cloud";
import { parseRecents } from "../src/store/recents";

// ── Handles ──────────────────────────────────────────────────────────────
strictEqual(handleKey(localHandle("/a/Data.hlx")), "local:/a/Data.hlx");
strictEqual(handleKey(remoteHandle("box", "u1", "123", "/Research/Data.hlx", "3")), "box:123");
strictEqual(handleLabel(localHandle("/a/Data.hlx")), "Data.hlx");
strictEqual(handleLabel(remoteHandle("box", "u1", "123", "/Research/Data.hlx", "3")), "Data.hlx");
strictEqual(handleDisplayPath(remoteHandle("box", "u1", "123", "/Research/Data.hlx", "3")), "Box:/Research/Data.hlx");
strictEqual(handleDisplayPath(localHandle("/a/Data.hlx")), "/a/Data.hlx");

// ── Copy names (conflict dialog: "Save as a copy") ───────────────────────
strictEqual(copyName("Data.hlx"), "Data (copy).hlx");
strictEqual(copyName("Data.prism"), "Data (copy).prism");
strictEqual(copyName("Data"), "Data (copy)");
strictEqual(copyName(".hlx"), ".hlx (copy)");

// ── Base64 round-trip (bytes over the bridge) ────────────────────────────
const bytes = new Uint8Array([0, 1, 2, 250, 255, 72, 101, 108, 108, 111]);
deepStrictEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
deepStrictEqual(base64ToBytes(bytesToBase64(new Uint8Array(0))), new Uint8Array(0));

// ── Error sorting (conflict dialog vs offline notice vs signed-out) ──────
const conflict = {
  kind: "conflict",
  remote_version: "4",
  remote_modified_at: "2026-11-13T10:00:00Z",
  remote_sha1: "abc",
  message: "The file changed in the cloud since it was opened.",
} as const;
ok(isConflictError(conflict));
ok(!isOfflineError(conflict));
ok(!isNotAuthenticatedError(conflict));
ok(isOfflineError({ kind: "offline", message: "offline" }));
ok(isNotAuthenticatedError({ kind: "not_authenticated", message: "signed out" }));
ok(!isConflictError({ kind: "offline", message: "offline" }));
ok(!isConflictError("boom"));
ok(!isOfflineError(null));
strictEqual(cloudErrorMessage(conflict), "The file changed in the cloud since it was opened.");
strictEqual(cloudErrorMessage(new Error("plain")), "plain");
strictEqual(cloudErrorMessage("raw"), "raw");

// ── Box auth path (Settings status line: broker vs BYO vs none) ──────────
const statusBase: CloudStatus = {
  accounts: [],
  boxHasCredentials: false,
  boxHasBroker: true,
  boxBrokerReachable: true,
};
strictEqual(boxAuthPath(statusBase), "broker");
strictEqual(boxAuthPath({ ...statusBase, boxBrokerReachable: false, boxHasCredentials: true }), "byo");
strictEqual(boxAuthPath({ ...statusBase, boxBrokerReachable: false, boxHasBroker: false, boxHasCredentials: true }), "byo");
strictEqual(boxAuthPath({ ...statusBase, boxBrokerReachable: false }), "none");
strictEqual(boxAuthPath(null), "none");
// Broker first: reachable broker wins even when BYO credentials exist.
strictEqual(boxAuthPath({ ...statusBase, boxHasCredentials: true }), "broker");

// ── Recents: legacy strings migrate, new entries keep, junk drops ────────
deepStrictEqual(parseRecents(["/a/Data.hlx", "/b/Other.hlx"]), [
  { kind: "local", path: "/a/Data.hlx" },
  { kind: "local", path: "/b/Other.hlx" },
]);
deepStrictEqual(
  parseRecents([
    { kind: "local", path: "/a/Data.hlx" },
    { kind: "remote", provider: "box", accountId: "u1", fileId: "123", path: "/Research/Data.hlx" },
  ]),
  [
    { kind: "local", path: "/a/Data.hlx" },
    { kind: "remote", provider: "box", accountId: "u1", fileId: "123", path: "/Research/Data.hlx" },
  ],
);
deepStrictEqual(parseRecents([{ kind: "remote", provider: "box", fileId: "123" }, 42, null, "not-an-entry"]), [
  { kind: "local", path: "not-an-entry" },
]);
deepStrictEqual(parseRecents("nope"), []);
deepStrictEqual(parseRecents(null), []);

console.log("cloud checks: ok");
