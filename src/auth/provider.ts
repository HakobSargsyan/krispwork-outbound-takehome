/**
 * The one pre-registered OAuth client, the code/token state machine, and
 * the OAuthServerProvider that the SDK's /authorize, /token, /revoke
 * handlers call into. `completeLogin` / `peekPendingLogin` are the two
 * points login.ts hooks into this state from outside the OAuth protocol
 * itself.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { Response } from "express";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { config } from "../config.js";
import { TTLStore } from "./storage.js";

// The one pre-registered OAuth client (fixed client_id, for clients like
// Claude Code that are told the client_id up front via --client-id).
const client: OAuthClientInformationFull = {
  client_id: config.oauthClientId,
  redirect_uris: config.oauthClientRedirectUris,
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  scope: config.oauthScope,
  token_endpoint_auth_method: "none", // public client (CLI/desktop); relies on PKCE
};

// Dynamically registered clients (RFC 7591) -- needed for clients that
// self-register instead of being told a client_id in advance (claude.ai /
// Claude Desktop's connector flow always does this first). The SDK's
// /register handler already generates the client_id and validates the
// submitted metadata before calling registerClient; we just store what
// it hands us. This re-opens "anyone can register a client with any
// redirect_uri" -- the mitigation is that login.ts shows the actual
// redirect target on the consent page, so a real human still sees where
// they'd be sent before entering credentials.
const dynamicClients = new Map<string, OAuthClientInformationFull>();

const clientsStore: OAuthRegisteredClientsStore = {
  getClient: (id) => (id === client.client_id ? client : dynamicClients.get(id)),
  registerClient: (clientInfo) => {
    const registered: OAuthClientInformationFull = {
      ...clientInfo,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    dynamicClients.set(registered.client_id, registered);
    return registered;
  },
};

interface AuthCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: URL;
  subject: string;
}
interface TokenRecord {
  clientId: string;
  scopes: string[];
  resource?: URL;
  subject: string;
  expiresAt: number; // seconds since epoch
  // The other half of the pair issued alongside this token -- lets
  // revokeToken cascade instead of leaving the paired token live.
  pairedToken: string;
}
export type PendingLogin = { client: OAuthClientInformationFull; params: AuthorizationParams };

const codes = new TTLStore<AuthCode>();
const accessTokens = new TTLStore<TokenRecord>();
const refreshTokens = new TTLStore<TokenRecord>();
const pendingLogins = new TTLStore<PendingLogin>();

function issueTokens(clientId: string, scopes: string[], subject: string, resource: URL | undefined): OAuthTokens {
  const accessToken = randomBytes(32).toString("base64url");
  const refreshToken = randomBytes(32).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const accessExpiresAt = now + config.accessTokenTtlSeconds;
  const refreshExpiresAt = now + config.refreshTokenTtlSeconds;

  accessTokens.put(
    accessToken,
    { clientId, scopes, resource, subject, expiresAt: accessExpiresAt, pairedToken: refreshToken },
    config.accessTokenTtlSeconds,
  );
  refreshTokens.put(
    refreshToken,
    { clientId, scopes, resource, subject, expiresAt: refreshExpiresAt, pairedToken: accessToken },
    config.refreshTokenTtlSeconds,
  );

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "bearer",
    expires_in: config.accessTokenTtlSeconds,
    scope: scopes.join(" "),
  };
}

export class LeadsOAuthProvider implements OAuthServerProvider {
  get clientsStore(): OAuthRegisteredClientsStore {
    return clientsStore;
  }

  async authorize(c: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const loginId = randomBytes(18).toString("base64url");
    pendingLogins.put(loginId, { client: c, params }, config.loginSessionTtlSeconds);
    res.redirect(302, `${config.publicUrl}/login?login_id=${loginId}`);
  }

  async challengeForAuthorizationCode(c: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const code = codes.get(authorizationCode);
    if (!code || code.clientId !== c.client_id) throw new InvalidGrantError("authorization code is invalid or expired");
    return code.codeChallenge;
  }

  async exchangeAuthorizationCode(
    c: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const code = codes.pop(authorizationCode); // single-use
    if (!code || code.clientId !== c.client_id) throw new InvalidGrantError("authorization code is invalid or expired");
    if (redirectUri !== undefined && redirectUri !== code.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    return issueTokens(c.client_id, code.scopes, code.subject, code.resource);
  }

  async exchangeRefreshToken(c: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const token = refreshTokens.get(refreshToken);
    if (!token || token.clientId !== c.client_id) throw new InvalidGrantError("refresh token is invalid, expired, or revoked");
    // A refresh request may narrow scope but must not widen it beyond
    // what the original grant covered (RFC 6749 §6).
    let scopesToGrant = token.scopes;
    if (scopes?.length) {
      const granted = new Set(token.scopes);
      if (!scopes.every((scope) => granted.has(scope))) {
        throw new InvalidGrantError("requested scope exceeds the scope originally granted");
      }
      scopesToGrant = scopes;
    }
    refreshTokens.delete(refreshToken); // rotate: old one is consumed
    return issueTokens(c.client_id, scopesToGrant, token.subject, token.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = accessTokens.get(token);
    if (!record) throw new InvalidTokenError("access token is invalid, expired, or revoked"); // -> clean 401, not 500
    // subject rides in `extra` so callers downstream of bearerAuth (e.g.
    // mcpHttp.ts binding a session to its creator) can tell users apart,
    // not just clients.
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: record.resource,
      extra: { subject: record.subject },
    };
  }

  async revokeToken(c: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    // Revoking either half of a pair must kill both -- otherwise the
    // "revoked" refresh token's paired access token keeps working for up
    // to its own TTL.
    const accessRecord = accessTokens.get(request.token);
    if (accessRecord && accessRecord.clientId === c.client_id) {
      accessTokens.delete(request.token);
      refreshTokens.delete(accessRecord.pairedToken);
      return;
    }
    const refreshRecord = refreshTokens.get(request.token);
    if (refreshRecord && refreshRecord.clientId === c.client_id) {
      refreshTokens.delete(request.token);
      accessTokens.delete(refreshRecord.pairedToken);
    }
  }
}

/** Read-only lookup used by GET /login to render the form without consuming it. */
export function peekPendingLogin(loginId: string): PendingLogin | undefined {
  return pendingLogins.get(loginId);
}

/**
 * Called by the /login POST handler once credentials check out. Consumes
 * the pending login (so a login_id can't be replayed) and returns the URL
 * to send the browser to, with a fresh single-use authorization code
 * attached. Returns undefined if the login_id is unknown or already expired.
 */
export function completeLogin(loginId: string, subject: string): string | undefined {
  const pending = pendingLogins.pop(loginId); // single-use
  if (!pending) return undefined;
  const { client: c, params } = pending;

  const code = randomBytes(32).toString("base64url");
  codes.put(
    code,
    {
      clientId: c.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      scopes: params.scopes ?? [],
      // The `resource` param is optional for the client to send (RFC 8707);
      // when omitted, fall back to this server's own resource identifier
      // instead of leaving it undefined -- requireBearerAuth's
      // expectedResource check otherwise rejects every such token, since
      // "no resource reported" never matches an expected one.
      resource: params.resource ?? config.mcpResourceUrl,
      subject,
    },
    config.authCodeTtlSeconds,
  );

  const redirectUrl = new URL(params.redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (params.state !== undefined) redirectUrl.searchParams.set("state", params.state);
  return redirectUrl.href;
}
