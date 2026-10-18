/**
 * Entrypoint: build the MCP server, wire OAuth plus the two outbound-sales
 * tools, and run it over Streamable HTTP.
 *
 * OAuth only applies to the HTTP transports -- there's no bearer-token
 * concept over plain stdio, where the client already trusts whatever
 * process it launched directly. Adding auth means this server speaks
 * Streamable HTTP; see README.md for how to point a client at it.
 */

import cookieParser from "cookie-parser";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

import { config } from "./config.js";
import { LeadsOAuthProvider, loginRouter } from "./auth/index.js";
import { mcpRouter } from "./mcpHttp.js";
import { registerTools } from "./outbound/tools.js";

const issuerUrl = new URL(config.publicUrl);
const mcpServerUrl = config.mcpResourceUrl;
const requiredScopes = config.oauthScope.split(" ");

const provider = new LeadsOAuthProvider();

const app = createMcpExpressApp({ host: config.host, allowedHosts: config.allowedHosts });
app.set("trust proxy", config.trustProxy);
app.use(cookieParser());

// Installs /authorize, /token, /register, /revoke (the clients store
// implements both getClient and registerClient -- see auth/provider.ts),
// plus the OAuth AS and protected-resource metadata documents.
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl,
    resourceServerUrl: mcpServerUrl,
    scopesSupported: requiredScopes,
    resourceName: "Outbound Leads MCP Server",
  }),
);

app.use(loginRouter());

const authMiddleware = requireBearerAuth({
  verifier: provider,
  requiredScopes,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl),
  expectedResource: mcpServerUrl,
});

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "outbound-leads", version: "1.0.0" });
  registerTools(server);
  return server;
}

app.use(mcpRouter(buildMcpServer, authMiddleware));

app.listen(config.port, config.host, () => {
  console.log(`Outbound Leads MCP server listening on ${config.publicUrl} (MCP endpoint: ${mcpServerUrl.href})`);
});
