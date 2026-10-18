# Outbound Leads MCP Server

An MCP server (Node/TypeScript, `@modelcontextprotocol/sdk`) over a local
`leads.csv` file with two tools:

- **`find_leads`** — filters leads against a simple ICP.
- **`draft_email`** — drafts a short first-touch email for one lead. Draft
  only; it never sends anything.

Both tools require an OAuth 2.1 access token (authorization code + PKCE).
The server runs over Streamable HTTP, not stdio — OAuth has no meaning over
a locally-spawned stdio process.

**This was built working with Claude throughout** — [PROMPT_LOG.md](PROMPT_LOG.md)
is the running log of what was asked and why, kept to the gist of each
prompt rather than full transcripts. It's not just a feature changelog: it
also covers the debugging episodes (e.g. root-causing a browser-side
`form-action` CSP bug by bisecting the policy down to a single directive
across two browsers and three hosting setups, or diagnosing a 403 by
isolating `cloudflared` from the app server to find a Host-header
mismatch) that show the actual troubleshooting process, not just the
fixes.

## Structure

```
src/
  server.ts              entrypoint: Express app, OAuth wiring, starts listening
  config.ts                environment-driven settings (ports, client, token TTLs)
  mcpHttp.ts                Streamable HTTP transport + session map for /mcp
  auth/
    index.ts                 re-exports LeadsOAuthProvider + loginRouter
    provider.ts                the OAuth client + code/token state machine
    login.ts                     the /login page: HTML + GET/POST routes
    passwords.ts                   PBKDF2 hashing + the one demo user
    security.ts                      CSRF + login rate limiting
    storage.ts                         in-memory TTL store they all share
  outbound/
    leads.ts                  CSV loading + the ICP filter
    outreach.ts                 email-drafting logic
    tools.ts                     registers find_leads / draft_email as MCP tools
leads.csv                the take-home dataset
```

## ICP rule used

Default filter in `find_leads` (overridable per-call):

- **Seniority**: title contains one of `ceo`, `coo`, `founder`, `chief`,
  `vp`, `vice president`, `head of`, `director` — i.e. someone who can
  plausibly say yes.
- **Company size**: 11–500 employees (the `headcount` column) — big enough
  to have budget, small enough to move without a procurement process.
- Optional extra filters: `industries` (allowlist) and `countryContains`
  (substring match).
- Rows with a blank/unparseable `headcount` or an invalid email are
  excluded rather than assumed to match — the source CSV has several
  blank-field rows and at least one malformed email.
- `limit` caps the result count at the first N matches in the CSV's own
  row order — it is explicitly *not* a ranking by seniority, size, or
  anything else; picking a "top N" by some criterion is left to the
  caller.

## Setup

```bash
npm install
cp .env.example .env   # then set DEMO_PASSWORD (see below), or leave it blank
npm run build
```

Set `DEMO_PASSWORD` in `.env` to whatever you want the demo login password to
be (plaintext -- it's hashed once at server startup, nothing to generate or
run). Leave it unset and the server generates a random one-time password at
startup and prints it once to stderr instead.

If you'd rather not have a plaintext password sitting in `.env` at all (even
briefly), set `DEMO_PASSWORD_HASH` instead -- hash it yourself first:

```bash
node -e "const c=require('node:crypto');const s=c.randomBytes(16);const d=c.pbkdf2Sync(process.argv[1],s,600000,32,'sha256');console.log(\`600000\$\${s.toString('hex')}\$\${d.toString('hex')}\`)" 'your password'
```

## Run

```bash
npm start   # or: npm run dev  (tsx, auto-restart)
```

Listens on `http://127.0.0.1:8000` by default (`MCP_HOST`/`MCP_PORT`), with
the MCP endpoint at `/mcp`. Point an MCP client's OAuth-capable Streamable
HTTP config at that URL; on first call it will open `/authorize`, which
redirects to this server's own `/login` page.

`OAUTH_CLIENT_REDIRECT_URIS` defaults to the MCP Inspector's callback
(`http://localhost:6274/oauth/callback`) plus a fixed one for Claude Code
(`http://localhost:8090/callback`, see below). Set it to match whatever
client you're actually using — dynamic client registration is
unimplemented, so a redirect_uri that isn't in this list is rejected.

## Connecting a client

**MCP Inspector** (easiest way to see the whole flow, including the login
page, in a browser):

```bash
npx @modelcontextprotocol/inspector
```

Connect it to `http://127.0.0.1:8000/mcp` (Streamable HTTP); it'll walk
through `/authorize` → our `/login` page → token exchange on its own,
using its default callback (`http://localhost:6274/oauth/callback`,
already in `OAUTH_CLIENT_REDIRECT_URIS` above).

**Claude Code:**

```bash
claude mcp add --transport http --client-id leads-cli --callback-port 8090 outbound-leads http://127.0.0.1:8000/mcp
claude mcp login outbound-leads
```

`--callback-port 8090` fixes the local port Claude Code listens on for the
OAuth redirect, because this server doesn't support dynamic client
registration — Claude Code's redirect URI ends up being exactly
`http://localhost:8090/callback`, which is why that's in
`OAUTH_CLIENT_REDIRECT_URIS` by default. `claude mcp login` opens a
browser to this server's `/authorize` → `/login`; sign in with
`DEMO_USERNAME` and whatever you set `DEMO_PASSWORD` to (or the password
the server printed at startup, if you left it unset). `claude mcp list`
should then show `outbound-leads` as connected.

**Claude Desktop:** Desktop's "Custom Connectors" (Settings → Connectors)
reach the server from Anthropic's own infrastructure, not from your
machine, so `127.0.0.1` is unreachable on its own — you need a public
HTTPS URL in front of it. Desktop's *local* server support (in
`claude_desktop_config.json`) is stdio-only and doesn't go through OAuth
at all, so it can't point at this HTTP server either.

For a throwaway public URL during development, run:

```bash
npm run tunnel
```

This starts a `cloudflared` quick tunnel in front of the server and
launches the server with `MCP_PUBLIC_URL` (and `MCP_COOKIE_SECURE=true`)
set to whatever `*.trycloudflare.com` hostname cloudflared was just
assigned — quick tunnels get a **new random hostname every restart**, so
don't hand-set `MCP_PUBLIC_URL` in `.env` for this flow, it'll go stale
the moment the tunnel restarts. The script prints the connector URL
(`<tunnel>/mcp`) to paste into Desktop → Settings → Connectors → Add
custom connector. For anything longer-lived than a dev session, use a
named Cloudflare Tunnel (a fixed hostname) instead of the quick tunnel, or
deploy this somewhere with a stable HTTPS URL.

Starting `cloudflared` and the server *separately* (instead of via
`npm run tunnel`) breaks this: the server's own DNS-rebinding protection
(`allowedHosts`, `src/config.ts`) only trusts hostnames matching
`MCP_PUBLIC_URL`, so a server started without ever learning the tunnel's
hostname rejects every request through it with `403 Invalid Host`, even
though the tunnel itself is working fine. That's exactly what
`npm run tunnel` exists to avoid.

## OAuth flow

Authorization code grant with mandatory PKCE (S256-only), via the MCP
SDK's own `/authorize`, `/token`, and `/revoke` handlers:

1. Client hits `/authorize` with `client_id`, `redirect_uri`,
   `code_challenge`, and (recommended) `resource` set to this server's
   `/mcp` URL.
2. The SDK validates the client/redirect_uri/scope, then calls into
   `src/auth/provider.ts`, which stashes the request server-side and sends
   the browser to this server's own `/login?login_id=...` page.
3. `/login` renders a username/password form and, on success, issues a
   single-use authorization code and 302s to the client's `redirect_uri`.
4. Client exchanges the code at `/token` (PKCE-verified by the SDK) for an
   opaque access + refresh token pair.
5. Tool calls on `/mcp` require `Authorization: Bearer <access_token>`.

There is exactly one pre-registered client and one demo user — this is a
take-home, not a multi-tenant IdP.

## Security considerations

Threats considered for the login page and OAuth flow, and what's done
about each (all in `src/auth/` unless noted):

- **Open redirect** — for the one pre-registered client, `redirect_uri` is
  validated against its exact allow-listed URI before the browser ever
  sees a redirect (the SDK's `/authorize` handler). Dynamic client
  registration (RFC 7591) is also supported, for clients like Claude
  Desktop/claude.ai that always self-register instead of being told a
  `client_id` in advance -- that re-opens "anyone can register a client
  with any `redirect_uri`", so the mitigation there is that the `/login`
  page always shows the actual registered `client_id` and the exact host
  it will redirect to after sign-in, so a real human sees where their
  credentials are about to send them before entering anything.
- **Reflected XSS on the login page** — every value interpolated into the
  HTML (`client_id`, `scope`, the error message) goes through `escapeHtml`.
- **CSRF on the login form** — double-submit cookie: an `HttpOnly` cookie
  set when the form renders must match a hidden field on submit. A
  cross-site POST can't read the cookie to forge the match.
- **Brute force / credential stuffing** — a per-IP sliding-window rate
  limiter on `/login` POSTs, plus a generic "invalid username or password"
  message so failures don't reveal which field was wrong.
- **Username enumeration via timing** — `authenticate()` always runs a full
  PBKDF2 pass, against a fixed dummy hash for unknown usernames, so
  "unknown user" and "wrong password" take comparable time.
- **Password storage** — PBKDF2-HMAC-SHA256, 600,000 iterations, random
  per-user salt, constant-time comparison via `crypto.timingSafeEqual`. No
  plaintext password is ever written to disk or logged. The one exception
  is `.env` itself if you use `DEMO_PASSWORD` (plaintext, for
  convenience) -- that file is gitignored and this is a single-demo-user
  take-home, not a real credential, but if that trade-off doesn't sit
  right, set `DEMO_PASSWORD_HASH` instead and nothing plaintext ever
  touches disk.
- **Authorization code replay/leakage** — codes are random (32 random
  bytes, base64url, well past the 128-bit RFC 6749 §10.10 floor),
  single-use (popped from the store on exchange), short-lived (60s), and
  bound to the exact client + PKCE challenge + redirect_uri (re-checked at
  `/token` time).
- **Stolen refresh token** — refresh tokens rotate on every use; the old
  one stops working immediately.
- **Token audience confusion** — tokens are issued bound to the `resource`
  from the `/authorize` request (RFC 8707), and `requireBearerAuth` (in
  `server.ts`) is configured with `expectedResource` set to this server's
  own `/mcp` URL, so a token obtained for a different resource is rejected.
- **An invalid/expired token returning the wrong status** —
  `verifyAccessToken` throws the SDK's `InvalidTokenError` (not a generic
  `Error`) so `requireBearerAuth` answers with a proper `401` instead of a
  `500`.
- **DNS rebinding** against the local server — `createMcpExpressApp` (in
  `server.ts`, from the SDK) applies Host-header validation automatically
  for localhost/127.0.0.1 binding.
- **Clickjacking / framing the login page** — `X-Frame-Options: DENY` and a
  `Content-Security-Policy` with no `frame-ancestors` on every `/login`
  response.
- **Injected `<script>` / inline scripts** — CSP's `default-src 'none'`
  blocks all script execution except `script-src-attr 'unsafe-inline'`,
  which only permits the page's own inline `onsubmit="..."` attribute
  (disables the submit button and shows a loading spinner while the
  request is in flight). It does not permit `<script>` tags, `javascript:`
  URIs, or externally loaded scripts.
- **The login form's own `action` being hijacked by injected markup** — in
  principle this is `form-action 'self'`'s job, but it's deliberately
  *not* set: testing (an automated Chromium tool and a real user's own
  Chrome, across two tunnel providers and plain `127.0.0.1` with no
  tunnel) found `form-action 'self'` — confirmed down to that exact
  single-directive header value, nothing else — reproducibly blocks this
  page's own same-origin POST with `net::ERR_ABORTED`. That rules out the
  tunnel domain, iframing, an injected `<meta>` CSP, and an ad blocker;
  it's some browser-side bug in `form-action` enforcement itself. The
  actual mitigation for this threat is `escapeHtml()` on every
  interpolated value (`client_id`, `scope`, the error message) — the
  form's `action="/login"` is a hardcoded literal never influenced by
  request data, so `form-action` here was defense-in-depth on top of that,
  not the primary control. If a future browser fixes this, restore
  `form-action 'self'` in `src/auth/login.ts` and re-test with a real
  browser, not just `curl`, before trusting it.
- **Caching sensitive responses** — `Cache-Control: no-store` on every auth
  response.
- **Revoking a token you don't own** — `revokeToken` only deletes a token
  that belongs to the requesting client, but always responds as if it
  succeeded either way (RFC 7009: revocation must not reveal whether a
  token exists or who owns it).

### Known limitations (acceptable for a take-home, not for production)

- **In-memory state**: all codes/tokens/pending logins/sessions are lost on
  restart and aren't shared across processes. A real deployment needs
  Redis or a database here.
- **One hardcoded demo user, no real IdP.** Fine for demonstrating the
  flow; swap it for a real user store before this is anything but a demo.
- **No TLS termination here.** `MCP_COOKIE_SECURE` and the OAuth flow
  itself assume HTTPS in front of this server in any real deployment —
  run it behind a reverse proxy that terminates TLS, and set
  `MCP_COOKIE_SECURE=true` once you do.
