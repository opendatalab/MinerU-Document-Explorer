/**
 * MCP Document Tools — tools for reading and querying documents.
 * Extracted from server.ts for better organization.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QMDStore } from "../../index.js";
import { detectFormat } from "../../backends/registry.js";

/**
 * Register all document-related tools (doc_toc, doc_read, doc_grep, doc_query, doc_elements).
 */
export function registerDocumentTools(server: McpServer, store: QMDStore): void {
  // ---------------------------------------------------------------------------
  // Helper: Get document and backend with validation
  // ---------------------------------------------------------------------------

  async function getBackendWithValidation(file: string) {
    const result = await store.get(file, { includeBody: false });
    if ("error" in result) {
      throw new Error(`Document not found: ${file}`);
    }
    const format = detectFormat(result.filepath);
    if (!format) {
      throw new Error(`Unsupported format for file: ${result.filepath}`);
    }
    const backend = await store.getBackend(format);
    const realPath = store.internal.resolveVirtualPath(result.filepath) ?? result.filepath;
    return { backend, format, result, realPath };
  }

  // ---------------------------------------------------------------------------
  // Tool: doc_toc
  // ---------------------------------------------------------------------------

  server.registerTool(
    "doc_toc",
    {
      title: "Document Table of Contents",
      description: "Get document table of contents as a nested tree. Each node includes an `address` field (e.g. 'line:11-20') — pass these addresses to `doc_read` to retrieve content. Works for Markdown (headings), PDF (bookmarks), DOCX (heading styles), PPTX (slide titles). This is the recommended starting point for reading large or structured documents.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        file: z.string().describe("File path or docid from search results"),
      },
    },
    async ({ file }) => {
      try {
        const { backend, result, realPath } = await getBackendWithValidation(file);
        const sections = await backend.getToc(realPath, result.docid);
        return {
          content: [{ type: "text", text: JSON.stringify({ file: result.displayPath, sections }, null, 2) }],
        };
      } catch (e: unknown) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: doc_read
  // ---------------------------------------------------------------------------

  server.registerTool(
    "doc_read",
    {
      title: "Read Document Content",
      description: "Read document content at specific addresses. Addresses are strings like 'line:45-120' obtained from doc_toc, doc_grep, or doc_query. Always get addresses from one of those tools first, then pass them here.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        file: z.string().describe("File path or docid from search results"),
        addresses: z.array(z.string()).describe("Addresses to read (e.g. 'line:45-120')"),
        max_tokens: z.number().optional().default(2000).describe("Maximum tokens per section (default: 2000)"),
      },
    },
    async ({ file, addresses, max_tokens }) => {
      try {
        const { backend, result, realPath } = await getBackendWithValidation(file);
        const sections = await backend.readContent(realPath, result.docid, addresses, max_tokens);
        return {
          content: [{ type: "text", text: JSON.stringify({ file: result.displayPath, sections }, null, 2) }],
        };
      } catch (e: unknown) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: doc_grep
  // ---------------------------------------------------------------------------

  server.registerTool(
    "doc_grep",
    {
      title: "Search Within Document",
      description: "Regex/keyword search within a single document. Returns matches with `address` fields (e.g. 'line:31') — pass these to `doc_read` to get full context around each match.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        file: z.string().describe("File path or docid from search results"),
        pattern: z.string().describe("Regex or keyword pattern to search for"),
        flags: z.string().optional().default("gi").describe("Regex flags (default: 'gi')"),
      },
    },
    async ({ file, pattern, flags }) => {
      try {
        const MAX_GREP_MATCHES = 200;
        const { backend, result, realPath } = await getBackendWithValidation(file);
        const allMatches = await backend.grep(realPath, result.docid, pattern, flags);
        const truncated = allMatches.length > MAX_GREP_MATCHES;
        const matches = truncated ? allMatches.slice(0, MAX_GREP_MATCHES) : allMatches;
        return {
          content: [{ type: "text", text: JSON.stringify({
            file: result.displayPath, pattern,
            total_matches: allMatches.length,
            ...(truncated ? { showing: MAX_GREP_MATCHES, truncated: true } : {}),
            matches,
          }, null, 2) }],
        };
      } catch (e: unknown) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: doc_query
  // ---------------------------------------------------------------------------

  server.registerTool(
    "doc_query",
    {
      title: "Semantic Search Within Document",
      description: "Semantic search within a single document using vector embeddings + reranking. Returns ranked chunks with `address` fields — pass these to `doc_read` for full content. Unlike doc_grep (keyword matching), this finds conceptually related sections. Requires embeddings — run 'qmd embed' first.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        file: z.string().describe("File path or docid from search results"),
        query: z.string().describe("Natural language query"),
        top_k: z.number().optional().default(5).describe("Number of chunks to return (default: 5)"),
      },
    },
    async ({ file, query, top_k }) => {
      try {
        const { backend, result, realPath } = await getBackendWithValidation(file);
        const chunks = await backend.query(realPath, result.docid, query, top_k);
        return {
          content: [{ type: "text", text: JSON.stringify({ file: result.displayPath, query, chunks }, null, 2) }],
        };
      } catch (e: unknown) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: doc_elements
  // ---------------------------------------------------------------------------

  server.registerTool(
    "doc_elements",
    {
      title: "Extract Document Elements",
      description: "Extract structured elements (tables, figures, equations) from a document. Requires cloud configuration for PDF. Docx/PPTX tables work locally.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        file: z.string().describe("File path or docid from search results"),
        addresses: z.array(z.string()).optional().describe("Limit extraction to these addresses"),
        query: z.string().optional().describe("Filter elements by relevance to this query"),
        element_types: z.array(z.enum(["table", "figure", "equation"])).optional().describe("Element types to extract"),
      },
    },
    async ({ file, addresses, query, element_types }) => {
      try {
        const { backend, result, realPath } = await getBackendWithValidation(file);
        if (!backend.extractElements) {
          return {
            content: [{ type: "text", text: "doc_elements is not available for this format. For PDF, configure docReading.elements in qmd.config.json. For DOCX/PPTX table extraction, this will be available in a future release." }],
            isError: true,
          };
        }
        const elements = await backend.extractElements(realPath, result.docid, addresses, query, element_types);
        return {
          content: [{ type: "text", text: JSON.stringify({ file: result.displayPath, elements }, null, 2) }],
        };
      } catch (e: unknown) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    }
  );
}
