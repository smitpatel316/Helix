#!/usr/bin/env python3
"""Smoke-test titer-stdio-bridge against a fake Streamable HTTP server that
implements docs/mcp-server-contract.md faithfully enough to prove the pipe:

- bearer auth (401 otherwise), MCP-Protocol-Version header required (400
  otherwise), Accept must name application/json or text/event-stream
- stateful sessions: initialize issues Mcp-Session-Id; later requests must
  echo it; DELETE closes the session
- initialize -> tools/list (JSON) -> tools/call (SSE) with the five Phase 1
  tools, plus a not_computed analysis result
- records every request (headers + body) to a JSONL log so the test can
  assert what the bridge actually sent (version header, session echo,
  DELETE on EOF, 401 retry)

Usage:
    python3 scripts/smoke-test-bridge.py [path/to/titer-stdio-bridge]
    # default binary: src-tauri/mcp-bridge/target/release/titer-stdio-bridge

Exit 0 = all checks pass. Nothing here touches the real Titer app or its
app-data dir: the discovery file lives in a temp dir and is passed to the
bridge with --discovery. The live-server pass (contract §9 against the real
app) is a separate, manual step — see docs/claude-desktop.md.
"""

import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time

TOKEN = "test-token-abc123"
TOOLS = [
    {"name": "titer_list_projects", "description": "List open projects",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "titer_list_tables", "description": "List tables in a project",
     "inputSchema": {"type": "object", "properties": {"project_id": {"type": "string"}}}},
    {"name": "titer_read_table_summary", "description": "Summarise a table",
     "inputSchema": {"type": "object", "properties": {"table_id": {"type": "string"}}}},
    {"name": "titer_read_results", "description": "Read an analysis result",
     "inputSchema": {"type": "object", "properties": {"analysis_id": {"type": "string"}}}},
    {"name": "titer_read_graph", "description": "Describe a graph",
     "inputSchema": {"type": "object", "properties": {"graph_id": {"type": "string"}}}},
]


class FakeMcp(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # class-level knobs the test flips
    token = TOKEN
    delay_first_401 = 0.0  # seconds to stall before the first 401
    log = []               # (method, path, headers dict, body str)
    sessions = set()
    _401_sent = False

    def log_message(self, *a):
        pass

    def _record(self, body=b""):
        FakeMcp.log.append((
            self.command, self.path,
            {k.lower(): v for k, v in self.headers.items()},
            body.decode("utf-8", "replace"),
        ))

    def _auth_ok(self):
        auth = self.headers.get("Authorization", "")
        if auth != f"Bearer {FakeMcp.token}":
            return False
        if "mcp-protocol-version" not in {k.lower() for k in self.headers}:
            self.send_response(400)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "60")
            self.end_headers()
            self.wfile.write(b"This is an MCP endpoint (Streamable HTTP).")
            return None  # already answered
        accept = self.headers.get("Accept", "")
        if "application/json" not in accept and "text/event-stream" not in accept:
            self.send_response(400)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "60")
            self.end_headers()
            self.wfile.write(b"This is an MCP endpoint (Streamable HTTP).")
            return None
        return True

    def _unauthorized(self):
        if FakeMcp.delay_first_401 and not FakeMcp._401_sent:
            FakeMcp._401_sent = True
            time.sleep(FakeMcp.delay_first_401)
        body = b"A valid local bearer token is required."
        self.send_response(401)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, payload, session=None, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        if session:
            self.send_header("Mcp-Session-Id", session)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_sse(self, payload, session=None):
        body = ("event: message\ndata: " + json.dumps(payload) + "\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        if session:
            self.send_header("Mcp-Session-Id", session)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        self._record(raw)
        auth = self._auth_ok()
        if auth is None:
            return
        if not auth:
            self._unauthorized()
            return
        try:
            msg = json.loads(raw or b"null")
        except json.JSONDecodeError:
            self._send_json({"jsonrpc": "2.0", "id": None,
                             "error": {"code": -32700, "message": "Parse error"}}, status=400)
            return
        method = msg.get("method", "")
        mid = msg.get("id")
        sid = self.headers.get("Mcp-Session-Id")
        if method == "initialize":
            session = f"sess-{len(FakeMcp.sessions) + 1}"
            FakeMcp.sessions.add(session)
            offered = (msg.get("params") or {}).get("protocolVersion", "")
            negotiated = offered if offered in ("2025-11-25", "2025-06-18") else "2025-11-25"
            self._send_json({"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": negotiated,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "titer", "version": "1.2.0"},
                "instructions": "Read-only Phase 1."}}, session=session)
            return
        if sid not in FakeMcp.sessions:
            self._send_json({"jsonrpc": "2.0", "id": mid, "error": {
                "code": -32000, "message": "Unknown session"}}, status=400)
            return
        if method == "notifications/initialized":
            body = b""
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if method == "tools/list":
            self._send_json({"jsonrpc": "2.0", "id": mid,
                             "result": {"tools": TOOLS}}, session=sid)
            return
        if method == "tools/call":
            name = (msg.get("params") or {}).get("name", "")
            args = (msg.get("params") or {}).get("arguments", {})
            if name == "titer_list_projects":
                result = {"projects": [{"project_id": "project-1",
                                        "file_path": "/tmp/smoke.pzfx", "revision": 3,
                                        "tables": [{"id": "t1", "name": "Table 1",
                                                    "kind": "table_type"}],
                                        "analyses": [], "graphs": []}]}
            elif name == "titer_read_table_summary":
                result = {"project_id": "project-1", "table_id": args.get("table_id", "t1"),
                          "rows": 4, "data_columns": 2, "columns": []}
            elif name == "titer_read_results":
                result = {"status": "not_computed", "project_id": "project-1",
                          "analysis_id": args.get("analysis_id", "a1"),
                          "message": "Open the analysis in Titer and run it."}
            else:
                result = {"content": [{"type": "text", "text": "unknown tool"}],
                          "isError": True}
                self._send_sse({"jsonrpc": "2.0", "id": mid, "result": result}, session=sid)
                return
            # tools/call answers as SSE, like the real rmcp server may.
            self._send_sse({"jsonrpc": "2.0", "id": mid, "result": {
                "content": [{"type": "text", "text": json.dumps(result)}]}}, session=sid)
            return
        self._send_json({"jsonrpc": "2.0", "id": mid, "result": {}}, session=sid)

    def do_DELETE(self):
        self._record()
        auth = self._auth_ok()
        if auth is None:
            return
        if not auth:
            self._unauthorized()
            return
        sid = self.headers.get("Mcp-Session-Id")
        FakeMcp.sessions.discard(sid)
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def start_server(port):
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), FakeMcp)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def run_bridge(binary, discovery, stdin_lines, timeout=30):
    proc = subprocess.run(
        [binary, "--discovery", discovery],
        input="\n".join(stdin_lines) + "\n",
        capture_output=True, text=True, timeout=timeout)
    return proc


def main():
    binary = sys.argv[1] if len(sys.argv) > 1 else (
        "src-tauri/mcp-bridge/target/release/titer-stdio-bridge")
    if not os.path.exists(binary):
        print(f"FAIL: bridge binary not found: {binary}")
        print("  run: cargo build --release --manifest-path src-tauri/mcp-bridge/Cargo.toml")
        return 1
    failures = []

    def check(name, cond, detail=""):
        print(("PASS" if cond else "FAIL") + f": {name}" + (f" — {detail}" if detail and not cond else ""))
        if not cond:
            failures.append(name)

    with tempfile.TemporaryDirectory() as td:
        port = free_port()
        discovery = os.path.join(td, "discovery.json")
        with open(discovery, "w") as f:
            json.dump({"endpoint": f"http://127.0.0.1:{port}/mcp", "token": TOKEN,
                       "protocol_versions": ["2025-11-25", "2025-06-18"],
                       "server": "titer", "version": "1.2.0"}, f)
        httpd = start_server(port)

        # --- 1. --check: initialize handshake + session close -------------
        FakeMcp.log.clear()
        FakeMcp.sessions.clear()
        proc = subprocess.run([binary, "--discovery", discovery, "--check"],
                              capture_output=True, text=True, timeout=30)
        check("--check exit 0", proc.returncode == 0, proc.stderr.strip())
        check("--check prints ok + url", proc.stdout.startswith("ok: Titer MCP server reachable at"))
        methods = [(m, p) for m, p, _, _ in FakeMcp.log]
        check("--check sent initialize POST", ("POST", "/mcp") in methods)
        check("--check sent DELETE on close", ("DELETE", "/mcp") in methods)
        init = next(b for _, _, _, b in FakeMcp.log if "initialize" in b)
        check("--check initialize names 2025-11-25",
              json.loads(init)["params"]["protocolVersion"] == "2025-11-25")

        # --- 2. Full session: initialize -> initialized -> list -> calls --
        FakeMcp.log.clear()
        FakeMcp.sessions.clear()
        lines = [
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                        "params": {"protocolVersion": "2025-11-25", "capabilities": {},
                                   "clientInfo": {"name": "smoke", "version": "0"}}}),
            json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}),
            json.dumps({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                        "params": {"name": "titer_list_projects", "arguments": {}}}),
            json.dumps({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                        "params": {"name": "titer_read_results",
                                   "arguments": {"analysis_id": "a1"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                        "params": {"name": "titer_nope", "arguments": {}}}),
        ]
        proc = run_bridge(binary, discovery, lines)
        out = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
        by_id = {m.get("id"): m for m in out}
        check("session exit 0", proc.returncode == 0, proc.stderr.strip()[:200])
        check("initialize result protocolVersion",
              by_id.get(1, {}).get("result", {}).get("protocolVersion") == "2025-11-25")
        tools = by_id.get(2, {}).get("result", {}).get("tools", [])
        check("tools/list returns the five Phase 1 tools",
              [t["name"] for t in tools] == [t["name"] for t in TOOLS],
              f"got {[t.get('name') for t in tools]}")
        proj = json.loads(by_id.get(3, {}).get("result", {}).get("content", [{}])[0].get("text", "{}"))
        check("tools/call list_projects (via SSE) returns project-1",
              proj.get("projects", [{}])[0].get("project_id") == "project-1")
        res = json.loads(by_id.get(4, {}).get("result", {}).get("content", [{}])[0].get("text", "{}"))
        check("tools/call read_results reports not_computed",
              res.get("status") == "not_computed")
        check("unknown tool returns isError",
              by_id.get(5, {}).get("result", {}).get("isError") is True)
        # What the bridge sent: version header on every POST, session echoed.
        posts = [(h, b) for m, p, h, b in FakeMcp.log if m == "POST"]
        check("every POST carries MCP-Protocol-Version: 2025-11-25",
              all(h.get("mcp-protocol-version") == "2025-11-25" for h, _ in posts),
              str([h.get("mcp-protocol-version") for h, _ in posts]))
        check("every POST carries the bearer token",
              all(h.get("authorization") == f"Bearer {TOKEN}" for h, _ in posts))
        after_init = posts[1:]
        check("session id echoed after initialize",
              all("mcp-session-id" in h for h, _ in after_init) and
              len({h["mcp-session-id"] for h, _ in after_init}) == 1)
        check("notification got no stdout reply",
              all(m.get("method") != "notifications/initialized" for m in out))
        check("DELETE sent on stdin EOF",
              any(m == "DELETE" for m, _, _, _ in FakeMcp.log))
        check("server sessions empty after close", len(FakeMcp.sessions) == 0)

        # --- 3. Server down mid-session: -32000, stays alive, exit 0 -----
        # shutdown() alone only stops the accept loop — the listening
        # socket stays open, so a new TCP connect succeeds and then hangs
        # in the backlog until the bridge's 5-minute timeout. A real
        # "server down" (process gone) refuses the connect, so close the
        # socket too.
        httpd.shutdown()
        httpd.server_close()
        time.sleep(0.2)
        proc = run_bridge(binary, discovery, [
            json.dumps({"jsonrpc": "2.0", "id": 9, "method": "tools/list", "params": {}}),
        ])
        out = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
        check("server down: exit 0 (stays alive, no crash)", proc.returncode == 0)
        check("server down: -32000 names AI connections",
              out and out[0].get("error", {}).get("code") == -32000 and
              "AI connections" in out[0]["error"]["message"],
              str(out[:1]))

        # --- 4. Missing discovery file: exit 2 ---------------------------
        proc = subprocess.run([binary, "--discovery", os.path.join(td, "nope.json")],
                              input="", capture_output=True, text=True, timeout=30)
        check("missing discovery: exit 2", proc.returncode == 2, proc.stderr.strip()[:160])
        check("missing discovery: stderr names the fix",
              "AI connections" in proc.stderr)

        # --- 5. Wrong token: 401 -> token-changed message -----------------
        FakeMcp.token = "different-token"
        httpd = start_server(port)
        proc = run_bridge(binary, discovery, [
            json.dumps({"jsonrpc": "2.0", "id": 7, "method": "tools/list", "params": {}}),
        ])
        out = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
        check("wrong token: -32000 token-changed message",
              out and out[0].get("error", {}).get("code") == -32000 and
              "token changed" in out[0]["error"]["message"].lower(),
              str(out[:1]))
        httpd.shutdown()
        httpd.server_close()

        # --- 6. Token rotated between discovery read and retry ------------
        # Server holds token B; discovery holds token A at bridge startup.
        # The server stalls its first 401 by 0.5s; the test rewrites the
        # discovery file to token B at 0.2s, so the bridge's retry re-read
        # picks up the fresh token and the call succeeds.
        FakeMcp.token = "token-B"
        FakeMcp.delay_first_401 = 0.5
        FakeMcp._401_sent = False
        with open(discovery, "w") as f:
            json.dump({"endpoint": f"http://127.0.0.1:{port}/mcp", "token": "token-A",
                       "protocol_versions": ["2025-11-25", "2025-06-18"]}, f)
        httpd = start_server(port)

        def rewrite():
            time.sleep(0.2)
            with open(discovery, "w") as f:
                json.dump({"endpoint": f"http://127.0.0.1:{port}/mcp", "token": "token-B",
                           "protocol_versions": ["2025-11-25", "2025-06-18"]}, f)

        threading.Thread(target=rewrite, daemon=True).start()
        proc = run_bridge(binary, discovery, [
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                        "params": {"protocolVersion": "2025-11-25", "capabilities": {},
                                   "clientInfo": {"name": "smoke", "version": "0"}}}),
        ])
        out = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
        check("rotated token: retry after re-read succeeds",
              out and out[0].get("result", {}).get("protocolVersion") == "2025-11-25",
              str(out[:1]))
        httpd.shutdown()
        httpd.server_close()

    print()
    if failures:
        print(f"{len(failures)} FAILURES: {failures}")
        return 1
    print("ALL SMOKE CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
