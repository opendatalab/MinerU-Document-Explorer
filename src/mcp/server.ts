/**
 * QMD MCP Server - Model Context Protocol server for QMD
 *
 * Exposes QMD search and document retrieval as MCP tools and resources.
 * Documents are accessible via qmd:// URIs.
 *
 * Follows MCP spec 2025-06-18 for proper response types.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport }
  from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { QMDStore, ExpandedQuery } from "../index.js";
import { getDefaultDbPath } from "../index.js";
import { getConfigPath, configExists } from "../collections.js";

// =============================================================================
// Modular imports
// =============================================================================

import { buildInstructions } from "./server/utils.js";
import { registerDocumentResource, handleDocumentResource } from "./resources/index.js";
import {
  registerCoreTools,
  registerDocumentTools,
  registerWritingTools,
  registerWikiTools,
  registerWebTools,
} from "./tools/index.js";

// =============================================================================
// Helper functions
// =============================================================================

/**
 * Create an MCP server with all QMD tools, resources, and prompts registered.
 * Shared by both stdio and HTTP transports.
 */
async function createMcpServer(store: QMDStore): Promise<McpServer> {
  const server = new McpServer(
    { name: "mineru-document-explorer", version: "1.0.0" },
    { instructions: await buildInstructions(store) },
  );

  // Pre-fetch default collection names for search tools
  const defaultCollectionNames = await store.getDefaultCollectionNames();

  // ---------------------------------------------------------------------------
  // Register resource: qmd://{path}
  // ---------------------------------------------------------------------------
  registerDocumentResource(server, store);

  // ---------------------------------------------------------------------------
  // Register core tools (query, get, multi_get, status)
  // ---------------------------------------------------------------------------
  registerCoreTools(server, store, defaultCollectionNames);

  // ---------------------------------------------------------------------------
  // Register document tools (doc_toc, doc_read, doc_grep, doc_query, doc_elements)
  // ---------------------------------------------------------------------------
  registerDocumentTools(server, store);

  // ---------------------------------------------------------------------------
  // Register writing tools (doc_write, doc_links)
  // ---------------------------------------------------------------------------
  registerWritingTools(server, store);

  // ---------------------------------------------------------------------------
  // Register wiki tools (wiki_ingest, wiki_lint, wiki_log, wiki_index)
  // ---------------------------------------------------------------------------
  registerWikiTools(server, store);

  // ---------------------------------------------------------------------------
  // Register web tools (web_search, web_fetch, credibility_score)
  // ---------------------------------------------------------------------------
  registerWebTools(server, store);

  return server;
}

// =============================================================================
// Transport: stdio (default)
// =============================================================================

export async function startMcpServer(dbPath?: string): Promise<void> {
  const { createStore } = await import("../index.js");
  const configPath = configExists() ? getConfigPath() : undefined;
  const store = await createStore({
    dbPath: dbPath ?? getDefaultDbPath(),
    ...(configPath ? { configPath } : {}),
  });
  const server = await createMcpServer(store);
  const transport = new StdioServerTransport();

  const cleanup = async () => { try { await store.close(); } catch {} };
  process.on("SIGINT", () => { cleanup().then(() => process.exit(130)); });
  process.on("SIGTERM", () => { cleanup().then(() => process.exit(143)); });
  process.on("beforeExit", () => { cleanup(); });

  await server.connect(transport);
}

// =============================================================================
// Transport: Streamable HTTP
// =============================================================================

export type HttpServerHandle = {
  httpServer: import("http").Server;
  port: number;
  stop: () => Promise<void>;
};

function log(msg: string): void {
  console.error(msg);
}

function ts(): string {
  return new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
}

function describeRequest(body: any): string {
  const method = body?.method ?? "unknown";
  if (method === "tools/call") {
    const tool = body.params?.name ?? "?";
    return `tools/call ${tool}`;
  }
  return method;
}

/**
 * Collect request body from stream.
 */
async function collectBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

/**
 * Start MCP server over Streamable HTTP (JSON responses, no SSE).
 */
export async function startMcpHttpServer(port: number, options?: { quiet?: boolean; dbPath?: string }): Promise<HttpServerHandle> {
  const { createStore } = await import("../index.js");
  const configPath = configExists() ? getConfigPath() : undefined;
  const store = await createStore({
    dbPath: options?.dbPath ?? getDefaultDbPath(),
    ...(configPath ? { configPath } : {}),
  });

  // Pre-fetch default collection names
  const defaultCollectionNames = await store.getDefaultCollectionNames();

  // Session map for HTTP transport
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  async function createSession(): Promise<WebStandardStreamableHTTPServerTransport> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => Math.random().toString(36).slice(2),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId: string) => {
        sessions.set(sessionId, transport);
        log(`${ts()} New session ${sessionId} (${sessions.size} active)`);
      },
    });
    const server = await createMcpServer(store);
    await server.connect(transport);

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    return transport;
  }

  const startTime = Date.now();
  const quiet = options?.quiet ?? false;

  // Create HTTP server
  const { createServer } = await import("node:http");
  const httpServer = createServer(async (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
    const reqStart = Date.now();
    const pathname = nodeReq.url || "/";

    try {
      if (pathname === "/health" && nodeReq.method === "GET") {
        const body = JSON.stringify({ status: "ok", uptime: Math.floor((Date.now() - startTime) / 1000) });
        nodeRes.writeHead(200, { "Content-Type": "application/json" });
        nodeRes.end(body);
        log(`${ts()} GET /health (${Date.now() - reqStart}ms)`);
        return;
      }

      // REST endpoint: POST /query
      if ((pathname === "/query" || pathname === "/search") && nodeReq.method === "POST") {
        const rawBody = await collectBody(nodeReq);
        const params = JSON.parse(rawBody);

        if (!params.searches || !Array.isArray(params.searches)) {
          nodeRes.writeHead(400, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({ error: "Missing required field: searches (array)" }));
          return;
        }

        const queries: ExpandedQuery[] = params.searches.map((s: any) => ({
          type: s.type as 'lex' | 'vec' | 'hyde',
          query: String(s.query || ""),
        }));

        const effectiveCollections = params.collections ?? defaultCollectionNames;
        const results = await store.search({
          queries,
          collections: effectiveCollections.length > 0 ? effectiveCollections : undefined,
          limit: params.limit ?? 10,
          minScore: params.minScore ?? 0,
          intent: params.intent,
        });

        const primaryQuery = params.searches.find((s: any) => s.type === 'lex')?.query
          || params.searches.find((s: any) => s.type === 'vec')?.query
          || params.searches[0]?.query || "";

        const { extractSnippet, addLineNumbers } = await import("../index.js");
        const formatted = results.map((r: any) => {
          const { line, snippet } = extractSnippet(r.bestChunk, primaryQuery, 300);
          return {
            docid: `#${r.docid}`,
            file: r.displayPath,
            title: r.title,
            score: Math.round(r.score * 100) / 100,
            context: r.context,
            snippet: addLineNumbers(snippet, line),
          };
        });

        nodeRes.writeHead(200, { "Content-Type": "application/json" });
        nodeRes.end(JSON.stringify({ results: formatted }));
        log(`${ts()} POST /query (${Date.now() - reqStart}ms)`);
        return;
      }

      // MCP endpoint: POST /mcp
      if (pathname === "/mcp" && nodeReq.method === "POST") {
        const rawBody = await collectBody(nodeReq);
        const body = JSON.parse(rawBody);
        const label = describeRequest(body);
        const url = `http://localhost:${port}${pathname}`;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(nodeReq.headers)) {
          if (typeof v === "string") headers[k] = v;
        }

        const sessionId = headers["mcp-session-id"];
        let transport: WebStandardStreamableHTTPServerTransport;

        if (sessionId) {
          const existing = sessions.get(sessionId);
          if (!existing) {
            nodeRes.writeHead(404, { "Content-Type": "application/json" });
            nodeRes.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Session not found" },
              id: body?.id ?? null,
            }));
            return;
          }
          transport = existing;
        } else if (isInitializeRequest(body)) {
          transport = await createSession();
        } else {
          nodeRes.writeHead(400, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: Missing session ID" },
            id: body?.id ?? null,
          }));
          return;
        }

        const request = new Request(url, { method: "POST", headers, body: rawBody });
        const response = await transport.handleRequest(request, { parsedBody: body });

        nodeRes.writeHead(response.status, Object.fromEntries(response.headers));
        nodeRes.end(Buffer.from(await response.arrayBuffer()));
        log(`${ts()} POST /mcp ${label} (${Date.now() - reqStart}ms)`);
        return;
      }

      // MCP methods: GET/DELETE on /mcp
      if (pathname === "/mcp") {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(nodeReq.headers)) {
          if (typeof v === "string") headers[k] = v;
        }

        const sessionId = headers["mcp-session-id"];
        if (!sessionId) {
          nodeRes.writeHead(400, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: Missing session ID" },
            id: null,
          }));
          return;
        }

        const transport = sessions.get(sessionId);
        if (!transport) {
          nodeRes.writeHead(404, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          }));
          return;
        }

        const url = `http://localhost:${port}${pathname}`;
        const rawBody = nodeReq.method !== "GET" && nodeReq.method !== "HEAD" ? await collectBody(nodeReq) : undefined;
        const request = new Request(url, { method: nodeReq.method || "GET", headers, ...(rawBody ? { body: rawBody } : {}) });
        const response = await transport.handleRequest(request);
        nodeRes.writeHead(response.status, Object.fromEntries(response.headers));
        nodeRes.end(Buffer.from(await response.arrayBuffer()));
        return;
      }

      nodeRes.writeHead(404);
      nodeRes.end("Not Found");
    } catch (err) {
      console.error("HTTP handler error:", err);
      nodeRes.writeHead(500);
      nodeRes.end("Internal Server Error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(port, "localhost", () => resolve());
  });

  const actualPort = (httpServer.address() as import("net").AddressInfo).port;

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const transport of sessions.values()) {
      await transport.close();
    }
    sessions.clear();
    httpServer.close();
    await store.close();
  };

  process.on("SIGTERM", async () => {
    console.error("Shutting down (SIGTERM)...");
    await stop();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    console.error("Shutting down (SIGINT)...");
    await stop();
    process.exit(0);
  });

  if (!quiet) log(`MinerU Document Explorer MCP server listening on http://localhost:${actualPort}/mcp`);
  return { httpServer, port: actualPort, stop };
}

// =============================================================================
// Run if this is the main module
// =============================================================================

if (fileURLToPath(import.meta.url) === process.argv[1] || process.argv[1]?.endsWith("/server.ts") || process.argv[1]?.endsWith("/server.js")) {
  startMcpServer().catch(console.error);
}
