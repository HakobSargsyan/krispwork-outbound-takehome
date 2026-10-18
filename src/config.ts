/** Environment-driven configuration, kept in one place. */

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  return raw ? raw.split(",").map((v) => v.trim()).filter(Boolean) : fallback;
}

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  host: process.env.MCP_HOST ?? "127.0.0.1",
  port: envInt("MCP_PORT", 8000),
  get publicUrl(): string {
    return process.env.MCP_PUBLIC_URL ?? `http://${config.host}:${config.port}`;
  },

  // This server's RFC 8707 resource identifier. The `resource` param is
  // optional for the client to send -- a token issued without one still
  // needs a value to bind to, since this server only ever serves one
  // resource, so that value is this.
  get mcpResourceUrl(): URL {
    return new URL("/mcp", config.publicUrl);
  },

  // Host headers this server accepts (DNS-rebinding protection -- see
  // server.ts's createMcpExpressApp call). Defaults to localhost/127.0.0.1
  // plus whatever hostname publicUrl has. Override with a comma-separated
  // MCP_ALLOWED_HOSTS if you need something else.
  get allowedHosts(): string[] {
    const override = process.env.MCP_ALLOWED_HOSTS;
    if (override) return envList("MCP_ALLOWED_HOSTS", []);
    const hosts = new Set(["localhost", "127.0.0.1", config.host]);
    try {
      hosts.add(new URL(config.publicUrl).hostname);
    } catch {
      // publicUrl isn't a valid absolute URL -- ignore, the defaults above still apply
    }
    return [...hosts];
  },

  // Express's `trust proxy` hop count. Needed whenever this sits behind a
  // reverse proxy -- without it, `req.ip` (used by our own login rate
  // limiter and by express-rate-limit on /authorize, /token, /revoke)
  // can't correctly read the real client IP out of X-Forwarded-For. `1`
  // trusts exactly the immediate proxy hop.
  trustProxy: envInt("MCP_TRUST_PROXY", 1),

  // The one pre-registered OAuth client (dynamic registration is
  // unimplemented -- see auth/provider.ts).
  oauthClientId: process.env.OAUTH_CLIENT_ID ?? "leads-cli",
  oauthClientRedirectUris: envList("OAUTH_CLIENT_REDIRECT_URIS", ["http://localhost:6274/oauth/callback"]),
  oauthScope: process.env.OAUTH_SCOPE ?? "leads:read leads:draft",

  authCodeTtlSeconds: 60,
  accessTokenTtlSeconds: envInt("OAUTH_ACCESS_TOKEN_TTL", 60 * 60),
  refreshTokenTtlSeconds: envInt("OAUTH_REFRESH_TOKEN_TTL", 60 * 60 * 24 * 14),
  loginSessionTtlSeconds: 5 * 60,

  // Off by default: a `Secure` cookie is silently dropped over plain
  // http, which would break local testing. Set true once served over TLS.
  cookieSecure: (process.env.MCP_COOKIE_SECURE ?? "false").toLowerCase() === "true",
};
