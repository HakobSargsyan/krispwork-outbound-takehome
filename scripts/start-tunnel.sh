#!/usr/bin/env bash
# Starts a cloudflared quick tunnel in front of this MCP server and launches
# the server with MCP_PUBLIC_URL (and MCP_COOKIE_SECURE) derived from
# whatever URL cloudflared actually got assigned this run -- quick tunnels
# (`cloudflared tunnel --url ...`) hand out a new random *.trycloudflare.com
# hostname every time, so hardcoding it in .env goes stale on every restart.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PORT="${MCP_PORT:-8000}"

CLOUDFLARED_BIN="$(command -v cloudflared || true)"
if [[ -z "$CLOUDFLARED_BIN" && -x /tmp/cloudflared ]]; then
  CLOUDFLARED_BIN=/tmp/cloudflared
fi
if [[ -z "$CLOUDFLARED_BIN" ]]; then
  echo "cloudflared not found on PATH or at /tmp/cloudflared. Install it first." >&2
  exit 1
fi

TUNNEL_LOG="$(mktemp)"
CLOUDFLARED_PID=""

cleanup() {
  if [[ -n "$CLOUDFLARED_PID" ]]; then
    kill "$CLOUDFLARED_PID" 2>/dev/null || true
    wait "$CLOUDFLARED_PID" 2>/dev/null || true
  fi
  rm -f "$TUNNEL_LOG"
}
trap cleanup EXIT INT TERM

echo "Starting cloudflared tunnel -> http://localhost:${PORT} ..."
"$CLOUDFLARED_BIN" tunnel --url "http://localhost:${PORT}" >"$TUNNEL_LOG" 2>&1 &
CLOUDFLARED_PID=$!

PUBLIC_URL=""
for _ in $(seq 1 30); do
  PUBLIC_URL="$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
  [[ -n "$PUBLIC_URL" ]] && break
  if ! kill -0 "$CLOUDFLARED_PID" 2>/dev/null; then
    echo "cloudflared exited before a URL appeared:" >&2
    cat "$TUNNEL_LOG" >&2
    exit 1
  fi
  sleep 1
done

if [[ -z "$PUBLIC_URL" ]]; then
  echo "Could not read the tunnel URL from cloudflared output after 30s:" >&2
  cat "$TUNNEL_LOG" >&2
  exit 1
fi

echo ""
echo "Tunnel is live:        ${PUBLIC_URL}"
echo "Connector URL to use:  ${PUBLIC_URL}/mcp"
echo ""

export MCP_PUBLIC_URL="$PUBLIC_URL"
export MCP_COOKIE_SECURE=true

npm run build
# Not `exec`: this script's own process must stay alive to run `cleanup`
# (which kills cloudflared) when the server exits or this script is signaled.
node --env-file=.env dist/server.js
