#!/usr/bin/env python3
"""Print Titer's MCP Authorization header as JSON, for Codex `http_headers_helper`.

Reads the discovery file Titer writes when AI connections are enabled
(`<app-data>/mcp/discovery.json`, mode 0600) and prints one JSON object:

    {"Authorization": "Bearer <token>"}

Codex calls this helper per connection and refreshes after a 401/403, so
unlike `bearer_token_env_var` it survives Titer's token rotation (a fresh
token is generated every time AI connections are re-enabled). Stdlib only.

Usage (see docs/codex.md):

    http_headers_helper = "python3 /path/to/titer/scripts/mcp-auth-header.py"

Override the discovery file with TITER_MCP_DISCOVERY. The token is printed
only to stdout as part of the header object, never logged.
"""

import json
import os
import sys
from pathlib import Path

APP_IDENTIFIER = "net.smitpatel.helix"


def default_discovery_path() -> Path | None:
    override = os.environ.get("TITER_MCP_DISCOVERY")
    if override:
        return Path(override)
    home = os.environ.get("HOME")
    if sys.platform == "darwin":
        if not home:
            return None
        base = Path(home) / "Library/Application Support" / APP_IDENTIFIER
    elif sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        if not appdata:
            return None
        base = Path(appdata) / APP_IDENTIFIER
    else:
        if not home:
            return None
        xdg = os.environ.get("XDG_DATA_HOME")
        base = (Path(xdg) if xdg else Path(home) / ".local/share") / APP_IDENTIFIER
    return base / "mcp" / "discovery.json"


def main() -> int:
    path = default_discovery_path()
    if path is None:
        print("mcp-auth-header: could not locate Titer's app-data directory",
              file=sys.stderr)
        return 2
    try:
        discovery = json.loads(path.read_text())
    except FileNotFoundError:
        print(f"mcp-auth-header: no discovery file at {path} — "
              "turn on AI connections in Titer Settings first.",
              file=sys.stderr)
        return 2
    except (OSError, ValueError) as exc:
        print(f"mcp-auth-header: could not read {path}: {exc}", file=sys.stderr)
        return 2
    token = discovery.get("token")
    if not token:
        print(f"mcp-auth-header: no token in {path} — turn AI connections "
              "off and on again in Titer Settings.", file=sys.stderr)
        return 2
    print(json.dumps({"Authorization": f"Bearer {token}"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
