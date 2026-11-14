# Titer Box broker

First-party OAuth token broker for Box (Titer v2, backlog item 75 follow-up).
The desktop app can never hold the Box client secret (Box requires one at
the token endpoint, and anything in the binary can be extracted), so this
tiny server holds it instead and performs the two token exchanges.

## What it does — and does not do

- `GET /health` → `{"status":"ok"}` (no auth).
- `GET /config` → `{"client_id":"..."}` (public; a client id is not secret).
- `POST /exchange` — JSON `{"code","code_verifier","redirect_uri"}` →
  Box token JSON `{"access_token","refresh_token","expires_in","token_type"}`.
  The broker adds `client_id` + `client_secret` server-side and POSTs
  `grant_type=authorization_code` to `https://api.box.com/oauth2/token`.
- `POST /refresh` — JSON `{"refresh_token"}` → new token JSON
  (`grant_type=refresh_token`).

Rules (research doc §C):

- **Exchange-only, stateless.** No database, no token storage, no pending
  map. Tokens exist only inside a single request.
- **Never logs** bodies, codes, verifiers, tokens, or the secret. Logs carry
  only `method path status duration_ms`, plus rate-limit events.
- **Rate limit:** per-IP token bucket, burst 20, refill 10/min, on
  `/exchange` and `/refresh` only. Over the limit → `429` + `Retry-After`.
  Behind the Cloudflare tunnel the socket peer is localhost, so the
  `CF-Connecting-IP` header is trusted — but only from a loopback peer.
- **Validation:** `redirect_uri` must be `http` on `127.0.0.1` / `localhost`
  / `::1` (defence-in-depth; Box enforces the exact registered URI too).
- **Errors:** Box `invalid_grant` → `400` (same code passed through, never
  the description); other Box 4xx → `400`; Box 5xx or unreachable → `502`.
- Upstream timeout: 30 s.

## Run

```sh
BOX_CLIENT_ID=<id> BOX_CLIENT_SECRET=<secret> cargo run --release
# or: BOX_CLIENT_SECRET_FILE=/path/to/secret (file MUST be mode 0600)
# BOX_BROKER_BIND=127.0.0.1 BOX_BROKER_PORT=18099
```

Refuses to start without a client id and a secret. The secret is the only
credential the broker holds. `BOX_TOKEN_URL` overrides the upstream Box
token endpoint — **test hook only** (mock Box endpoint in `cargo test`).

## Tests

```sh
cargo test
```

Covers: exchange + refresh happy paths against a mock Box token endpoint,
`invalid_grant` → 400, Box 5xx / unreachable → 502, `redirect_uri`
validation (including that a rejected URI never reaches Box), rate-limit
429 + `Retry-After` (and per-IP isolation), a never-logs-tokens test
(captured logs asserted free of every code/verifier/token/secret sentinel),
and secret `Debug` redaction.

## Deploy (Pi + Cloudflare tunnel)

See the deployment notes in `~/workspace/.helix-cloudbroker-server/` — the
live state (port, service, tunnel ingress, DNS) is recorded there, not in
this repo, because it contains hostnames, not secrets. The service runs as
a systemd user service on the Pi (`Restart=always`), the secret lives in a
mode-600 env file on the Pi only, and the public URL is
`https://box-broker.smitpatel.net`.

## Go-live (needs Smit)

The service currently runs with a PLACEHOLDER secret: it proves the path
reaches Box (Box answers `invalid_client`), but no real exchange can
succeed until Smit creates the shared Box OAuth app and puts its real
client id + secret in the Pi env file. Who owns that Box app (Smit's
account vs a project account) is still his call.
