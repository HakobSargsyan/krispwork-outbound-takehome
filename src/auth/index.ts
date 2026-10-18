/**
 * OAuth 2.1 (authorization code + PKCE) for this MCP server. Split across:
 *   provider.ts   the OAuth client + code/token state machine
 *   login.ts      the hand-rolled /login page (HTML + routes)
 *   passwords.ts  PBKDF2 hashing + the one demo user
 *   security.ts   CSRF + login rate limiting
 *   storage.ts    the in-memory TTL store they all share
 * See README.md for the request flow and the security checklist.
 */

export { LeadsOAuthProvider } from "./provider.js";
export { loginRouter } from "./login.js";
