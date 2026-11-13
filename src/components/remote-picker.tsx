// The remote file picker (cloud storage, v2 item 75): in-app folder
// browsing of a connected account. The native OS dialog can't browse cloud
// locations, so this lists folders here instead — same dialog styling as
// the rest of the app. Only `.hlx` / `.prism` files open; folders navigate.
import * as React from "react";
import { Button } from "../ui/controls";
import { Dialog } from "../ui/dialog";
import { useProjectStore } from "../store/use-project-store";
import * as native from "../native";
import { cloudErrorMessage, remoteHandle, type FileHandle, type RemoteEntry } from "../lib/cloud";

const OPENABLE = (name: string) => name.toLowerCase().endsWith(".hlx") || name.toLowerCase().endsWith(".prism");

interface Crumb {
  id: string;
  name: string;
}

export function RemotePickerDialog({
  onPick,
  onClose,
}: {
  onPick: (handle: Extract<FileHandle, { kind: "remote" }>) => void;
  onClose: () => void;
}) {
  const { selector, openSelector } = useProjectStore();
  const open = selector?.kind === "remote-picker";
  const [accounts, setAccounts] = React.useState<
    { provider: "box" | "mock"; id: string; login: string; name: string }[]
  >([]);
  const [accountId, setAccountId] = React.useState<string | null>(null);
  const [crumbs, setCrumbs] = React.useState<Crumb[]>([{ id: "0", name: "Box" }]);
  const [entries, setEntries] = React.useState<RemoteEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const provider = "box" as const;
  const folderId = crumbs[crumbs.length - 1]?.id ?? "0";

  const loadStatus = React.useCallback(async () => {
    if (!native.isNative) return;
    try {
      const status = await native.cloudStatus();
      const box = status.accounts.filter((a) => a.provider === "box");
      setAccounts(box.map((a) => ({ provider: "box" as const, id: a.id, login: a.login, name: a.name })));
      setAccountId((current) => current ?? box[0]?.id ?? null);
    } catch (err) {
      setError(cloudErrorMessage(err));
    }
  }, []);

  const loadFolder = React.useCallback(
    async (account: string, folder: string) => {
      setLoading(true);
      setError(null);
      try {
        setEntries(await native.cloudList(provider, account, folder));
      } catch (err) {
        setError(cloudErrorMessage(err));
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [provider],
  );

  React.useEffect(() => {
    if (open) {
      setCrumbs([{ id: "0", name: "Box" }]);
      setError(null);
      void loadStatus();
    }
  }, [open, loadStatus]);

  React.useEffect(() => {
    if (open && accountId) void loadFolder(accountId, folderId);
  }, [open, accountId, folderId, loadFolder]);

  if (!open) return null;

  if (!native.isNative) {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title="Open from Cloud"
        description="Cloud files open in the Titer app, not in the browser."
      >
        <></>
      </Dialog>
    );
  }

  const visible = entries.filter((e) => e.kind === "folder" || OPENABLE(e.name));
  const pick = (entry: RemoteEntry) => {
    if (!accountId) return;
    onPick(
      remoteHandle(
        provider,
        accountId,
        entry.id,
        entry.path,
        entry.version ?? null,
        entry.sha1 ?? null,
        entry.modifiedAt ?? null,
      ),
    );
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Open from Cloud"
      description={
        accounts.length === 0
          ? "No cloud account is connected yet."
          : `Browsing ${accounts.find((a) => a.id === accountId)?.name ?? "Box"} — only .hlx and .prism files open.`
      }
      footer={
        accounts.length === 0 ? (
          <Button
            variant="accent"
            onClick={() => {
              onClose();
              openSelector({ kind: "cloud-settings" });
            }}
          >
            Connected Storage…
          </Button>
        ) : undefined
      }
    >
      {accounts.length > 0 && (
        <div className="flex flex-col gap-3">
          {accounts.length > 1 && (
            <select
              className="rounded-md bg-surface px-2 py-1 text-regular ring-1 ring-separator"
              value={accountId ?? ""}
              onChange={(e) => {
                setAccountId(e.target.value);
                setCrumbs([{ id: "0", name: "Box" }]);
              }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.login})
                </option>
              ))}
            </select>
          )}
          <div className="flex flex-wrap gap-1 text-regular text-secondary">
            {crumbs.map((crumb, i) => (
              <span key={crumb.id}>
                {i > 0 && <span className="mx-1">/</span>}
                <button
                  type="button"
                  className="underline-offset-2 hover:underline"
                  onClick={() => setCrumbs(crumbs.slice(0, i + 1))}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </div>
          {loading ? (
            <p className="text-regular text-secondary">Loading…</p>
          ) : error ? (
            <p className="text-regular text-secondary">{error}</p>
          ) : visible.length === 0 ? (
            <p className="text-regular text-secondary">This folder is empty.</p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {visible.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="w-full rounded-md px-2 py-1 text-left text-regular hover:bg-surface-hover"
                    onClick={() => {
                      if (entry.kind === "folder") setCrumbs([...crumbs, { id: entry.id, name: entry.name }]);
                      else pick(entry);
                    }}
                  >
                    {entry.kind === "folder" ? `📁 ${entry.name}` : entry.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}
