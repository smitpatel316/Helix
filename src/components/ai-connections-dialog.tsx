// Settings → AI connections (v3 Phase 1): the switch that starts the
// in-process MCP server, the local token, the one Claude Code command, and
// the Activity log. The server is off by default and only ever starts
// from here — an agent cannot change any of this (roadmap §3).
import * as React from "react";
import { Dialog } from "../ui/dialog";
import { Button, Input, Switch } from "../ui/controls";
import {
  isNative,
  mcpActivity,
  mcpClaudeCodeCommand,
  mcpRegenerateToken,
  mcpSetEnabled,
  mcpStatus,
  mcpToken,
  type McpStatus,
} from "../native";
import { useProjectStore } from "../store/use-project-store";

/** One Activity-log line, read for a person: "14:02 titer_read_tables ✓". */
function activityLine(line: string): string {
  try {
    const entry = JSON.parse(line) as { ts?: number; tool?: string; event?: string; ok?: boolean };
    const time = entry.ts ? new Date(entry.ts * 1000).toLocaleTimeString() : "";
    const what = entry.tool ?? entry.event ?? "?";
    const mark = entry.ok === undefined ? "" : entry.ok ? " ✓" : " ✗";
    return `${time} ${what}${mark}`;
  } catch {
    return line.slice(0, 200);
  }
}

/** A labelled block of the dialog, full-width (unlike Field, whose children
 *  sit in a 160 px box for small controls). */
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-regular text-primary">{label}</p>
      {children}
    </div>
  );
}

export function AiConnectionsDialog() {
  const { selector, closeSelector } = useProjectStore();
  const open = selector?.kind === "ai-connections";
  const [status, setStatus] = React.useState<McpStatus | null>(null);
  const [token, setToken] = React.useState<string | null>(null);
  const [showToken, setShowToken] = React.useState(false);
  const [command, setCommand] = React.useState<string | null>(null);
  const [activity, setActivity] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [copied, setCopied] = React.useState<"token" | "command" | null>(null);
  const [confirmRegen, setConfirmRegen] = React.useState(false);

  const refresh = React.useCallback(async () => {
    if (!isNative) return;
    try {
      const next = await mcpStatus();
      setStatus(next);
      setError("");
      if (next.has_token) setToken(await mcpToken());
      setCommand(next.running ? await mcpClaudeCodeCommand() : null);
      setActivity(await mcpActivity(10));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  React.useEffect(() => {
    if (!open) return;
    setShowToken(false);
    setConfirmRegen(false);
    setCopied(null);
    void refresh();
  }, [open, refresh]);

  const copy = async (what: "token" | "command", text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied((c) => (c === what ? null : c)), 2000);
  };

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      await mcpSetEnabled(enabled);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    if (!confirmRegen) {
      setConfirmRegen(true);
      setTimeout(() => setConfirmRegen(false), 4000);
      return;
    }
    setConfirmRegen(false);
    setBusy(true);
    try {
      setToken(await mcpRegenerateToken());
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={closeSelector}
      dismissLabel="Done"
      title="AI Connections"
      description="Let an AI app you already use (Claude Code, Claude Desktop, …) read what's open in Titer — through a local server only, read-only for now."
    >
      {!isNative ? (
        <p className="text-regular text-secondary">
          AI connections need the Titer app — this is the web preview, which has no local server.
        </p>
      ) : (
        <>
          <Section label="Allow AI apps to connect">
            <div className="flex items-center gap-3">
              <Switch
                checked={status?.enabled ?? false}
                disabled={busy || status === null}
                onChange={(v) => void toggle(v)}
              />
              <span className="text-regular text-secondary">
                {status === null
                  ? "Checking…"
                  : status.running
                    ? `On — listening on ${status.endpoint}`
                    : "Off — no AI app can reach Titer."}
              </span>
            </div>
          </Section>

          {status?.enabled && token && (
            <Section label="Local token (keep it private — it lets an app on this Mac read your open projects)">
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={showToken ? token : "•".repeat(12)}
                  onFocus={(e) => e.target.select()}
                  className="min-w-0 flex-1 font-mono"
                />
                <Button onClick={() => setShowToken((s) => !s)}>{showToken ? "Hide" : "Show"}</Button>
                <Button onClick={() => void copy("token", token)}>{copied === "token" ? "Copied" : "Copy"}</Button>
              </div>
              <div className="mt-2">
                <Button disabled={busy || status.running} onClick={() => void regenerate()}>
                  {confirmRegen ? "Click again to confirm" : "Regenerate token"}
                </Button>
                {status.running && (
                  <p className="mt-1 text-small text-secondary">
                    Stop the server first, then regenerate — clients must re-pair after a rotation.
                  </p>
                )}
              </div>
            </Section>
          )}

          {status?.running && command && (
            <Section label="Claude Code — run once in a terminal">
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={command}
                  onFocus={(e) => e.target.select()}
                  className="min-w-0 flex-1 font-mono"
                />
                <Button onClick={() => void copy("command", command)}>
                  {copied === "command" ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="mt-1 text-small text-secondary">
                New Claude Code sessions will see the Titer tools — check with /mcp. Claude Desktop connects through the
                stdio bridge (coming in v3 Phase 1).
              </p>
            </Section>
          )}

          <Section label="Recent agent activity">
            {activity.length === 0 ? (
              <p className="text-regular text-secondary">No agent activity yet.</p>
            ) : (
              <div className="flex flex-col gap-1 font-mono text-small">
                {activity.map((line, i) => (
                  <p key={i}>{activityLine(line)}</p>
                ))}
              </div>
            )}
          </Section>

          <p className="text-small text-secondary">
            Local only: the server binds 127.0.0.1, needs the token above, and never sends data anywhere. Phase 1 is
            read-only — an agent can list and read tables, results and graphs, but cannot run an analysis, build a
            graph, export, save or delete anything. It cannot change these settings.
          </p>

          {error && <p className="text-regular text-red-600">{error}</p>}
        </>
      )}
    </Dialog>
  );
}
