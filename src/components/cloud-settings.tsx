// Settings → Connected Storage (cloud storage, v2 item 75, Box first).
// Connect / disconnect per provider, and the Box app credentials. Tokens
// never appear here — the page only ever sees account identity — and the
// client secret the user pastes goes straight to the OS keychain.
//
// Why Box asks for a client secret: Box's token endpoint mandates one
// (its authorization-server metadata lists only `client_secret_basic` and
// `client_secret_post` — no secret-less method), so the standard
// public-client + PKCE flow can't complete for Box. Until Smit decides who
// owns the shared Box app (or the Titer broker is built), connecting uses
// the user's own Box app credentials (bring-your-own), stored in the
// keychain. No secret ships in the app.
import * as React from "react";
import { Button } from "../ui/controls";
import { Dialog } from "../ui/dialog";
import { useProjectStore } from "../store/use-project-store";
import * as native from "../native";
import { cloudErrorMessage, type CloudStatus } from "../lib/cloud";

export function CloudSettingsDialog({ onClose }: { onClose: () => void }) {
  const { selector } = useProjectStore();
  const open = selector?.kind === "cloud-settings";
  const [status, setStatus] = React.useState<CloudStatus | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [connecting, setConnecting] = React.useState(false);
  const [clientId, setClientId] = React.useState("");
  const [clientSecret, setClientSecret] = React.useState("");
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!native.isNative) return;
    setLoading(true);
    try {
      setStatus(await native.cloudStatus());
    } catch (err) {
      setError(cloudErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (open) {
      setNotice(null);
      setError(null);
      void refresh();
    }
  }, [open, refresh]);

  if (!open) return null;

  const boxAccounts = status?.accounts.filter((a) => a.provider === "box") ?? [];
  const configured = status?.boxHasCredentials ?? false;

  const connect = async () => {
    setConnecting(true);
    setError(null);
    setNotice(null);
    try {
      // Opens Box sign-in in the system browser; waits for it (up to 5 min).
      await native.cloudConnectBox();
      setNotice("Box connected.");
      await refresh();
    } catch (err) {
      setError(cloudErrorMessage(err));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async (accountId: string) => {
    setError(null);
    try {
      await native.cloudDisconnect("box", accountId);
      setNotice("Box disconnected — the sign-in was revoked and removed.");
      await refresh();
    } catch (err) {
      setError(cloudErrorMessage(err));
      await refresh();
    }
  };

  const saveCredentials = async () => {
    setError(null);
    setNotice(null);
    try {
      await native.cloudSaveBoxCredentials(clientId, clientSecret);
      setClientSecret("");
      setNotice("Box app credentials saved in the OS keychain. Connect Box to sign in.");
      await refresh();
    } catch (err) {
      setError(cloudErrorMessage(err));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connected Storage"
      description="Open, edit and save .hlx and .prism files in Box, from inside Titer. Nothing is uploaded anywhere you didn't connect."
    >
      <div className="flex flex-col gap-4">
        <section className="flex flex-col gap-2">
          <h3 className="text-regular font-semibold">Box</h3>
          {loading ? (
            <p className="text-regular text-secondary">Loading…</p>
          ) : boxAccounts.length === 0 ? (
            <p className="text-regular text-secondary">Not connected.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {boxAccounts.map((account) => (
                <li key={account.id} className="flex items-center justify-between gap-2 text-regular">
                  <span>
                    {account.name} ({account.login})
                  </span>
                  <Button onClick={() => void disconnect(account.id)}>Disconnect</Button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button variant="accent" disabled={connecting || !native.isNative} onClick={() => void connect()}>
              {connecting ? "Waiting for Box sign-in…" : "Connect Box"}
            </Button>
          </div>
          {!configured && !status?.boxHasBroker && (
            <p className="text-regular text-secondary">
              Box sign-in needs a Box app first: paste your own app&apos;s client ID and secret below (they stay in the
              OS keychain — no secret ever ships in Titer), or wait for the shared Titer Box app. If your Box is a UCSF
              account, UCSF IT may need to enable the app for the tenant — one email settles it.
            </p>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-regular font-semibold">Your Box app credentials</h3>
          <p className="text-regular text-secondary">
            From a Custom App → User Authentication (OAuth 2.0) in the Box Developer Console, with the `root_readwrite`
            scope. {configured ? "Credentials are saved." : "None saved yet."}
          </p>
          <label className="flex flex-col gap-1 text-regular">
            Client ID
            <input
              type="text"
              className="rounded-md bg-surface px-2 py-1 ring-1 ring-separator"
              value={clientId}
              autoComplete="off"
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Your Box app's client ID"
            />
          </label>
          <label className="flex flex-col gap-1 text-regular">
            Client secret
            <input
              type="password"
              className="rounded-md bg-surface px-2 py-1 ring-1 ring-separator"
              value={clientSecret}
              autoComplete="off"
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="Your Box app's client secret"
            />
          </label>
          <div>
            <Button disabled={!clientId.trim() || !clientSecret.trim()} onClick={() => void saveCredentials()}>
              Save Credentials
            </Button>
          </div>
        </section>

        {notice && <p className="text-regular">{notice}</p>}
        {error && <p className="text-regular">{error}</p>}
      </div>
    </Dialog>
  );
}
