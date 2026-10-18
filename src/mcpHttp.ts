/**
 * Wires the MCP Streamable HTTP transport onto an Express app at /mcp,
 * with one transport (and one connected McpServer) per session. This is
 * transport/session plumbing only -- the tools themselves live in
 * outbound/tools.ts, and auth is applied by the caller via `authMiddleware`.
 */

import { randomUUID } from "node:crypto";
import type { Request, RequestHandler, Response, Router } from "express";
import express from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  lastActiveAt: number;
  identity: string;
}

// clientId + subject, not just the bearer token -- so a token refresh
// mid-session doesn't strand the client, but a *different* authenticated
// caller presenting a leaked session id still can't attach to it.
function identityOf(auth: AuthInfo | undefined): string {
  const subject = typeof auth?.extra?.subject === "string" ? auth.extra.subject : "";
  return `${auth?.clientId ?? ""}:${subject}`;
}

const IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 1000;

export function mcpRouter(createServer: () => McpServer, authMiddleware?: RequestHandler): Router {
  const router = express.Router();
  const sessions = new Map<string, Session>();

  const touch = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (session) session.lastActiveAt = Date.now();
  };

  // Drop sessions that have been idle for IDLE_MS so an abandoned client
  // doesn't leak memory forever.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const [id, session] of sessions) {
      if (session.lastActiveAt < cutoff) {
        session.transport.close().catch(() => {});
        sessions.delete(id);
      }
    }
  }, 60_000);
  sweep.unref();

  const postHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    try {
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session || session.identity !== identityOf(req.auth)) {
          res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
          return;
        }
        touch(sessionId);
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
        return;
      }
      if (sessions.size >= MAX_SESSIONS) {
        res.status(503).json({ jsonrpc: "2.0", error: { code: -32000, message: "Too many open sessions" }, id: null });
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, { transport, lastActiveAt: Date.now(), identity: identityOf(req.auth) });
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) sessions.delete(sid);
      };

      const server = createServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  };

  const streamHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      res.status(400).send("Missing session ID");
      return;
    }
    const session = sessions.get(sessionId);
    if (!session || session.identity !== identityOf(req.auth)) {
      res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      return;
    }
    touch(sessionId);
    await session.transport.handleRequest(req, res);
  };

  const middlewares = authMiddleware ? [authMiddleware] : [];
  router.post("/mcp", ...middlewares, postHandler);
  router.get("/mcp", ...middlewares, streamHandler);
  router.delete("/mcp", ...middlewares, streamHandler);

  return router;
}
