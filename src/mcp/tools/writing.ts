/**
 * MCP Writing Tools — doc_write, doc_links.
 * Tools for writing documents and managing links.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QMDStore } from "../../index.js";
import { isWikiCollection } from "../../store.js";
import { appendLog } from "../../wiki/log.js";

/**
 * Register writing tools (doc_write, doc_links).
 */
export function registerWritingTools(server: McpServer, store: QMDStore): void {
  const db = store.internal.db;

  // ---------------------------------------------------------------------------
  // Tool: doc_write
  // ---------------------------------------------------------------------------

  server.registerTool(
    "doc_write",
    {
      title: "Write Document",
      description: `Write a markdown document to a QMD collection. Creates or overwrites the file on disk, then immediately re-indexes it (FTS + links). Does NOT generate embeddings — run 'qmd embed' separately.

For wiki collections (type: "wiki"), writes are logged automatically. For raw collections (type: "raw"), a warning is included — raw sources are meant to be immutable.`,
      annotations: { readOnlyHint: false },
      inputSchema: {
        collection: z.string().describe("Target collection name"),
        path: z.string().describe("Relative path within collection (e.g. 'wiki/article.md')"),
        content: z.string().describe("Full markdown content to write"),
        title: z.string().optional().describe("Document title (auto-extracted from content if omitted)"),
        source: z.string().optional().describe("Source document path or docid that this wiki page was derived from. Records provenance for staleness tracking."),
      },
    },
    async ({ collection, path: relPath, content, title, source }) => {
      try {
        const isWiki = isWikiCollection(db, collection);

        const result = await store.writeDocument(collection, relPath, content, title);

        let logWarning = "";
        if (isWiki) {
          try {
            appendLog(db, {
              operation: "update",
              wiki_files: [result.file],
              details: { action: "write", title: title || relPath, docid: result.docid, source },
            });

            if (source) {
              const sourceDoc = await store.get(source, { includeBody: false });
              if (!("error" in sourceDoc)) {
                db.prepare(`
                  INSERT OR REPLACE INTO wiki_sources (wiki_file, source_file, wiki_collection, created_at)
                  VALUES (?, ?, ?, datetime('now'))
                `).run(result.file, sourceDoc.displayPath, collection);
              }
            }
          } catch (logErr: any) {
            logWarning = `\n⚠ Document written successfully but wiki log failed: ${logErr.message}`;
          }
        }

        const warning = !isWiki
          ? "\n⚠ This is a raw collection — raw sources are meant to be immutable. Consider writing to a wiki collection instead."
          : logWarning;

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...result, indexed: true, collection_type: isWiki ? "wiki" : "raw" }, null, 2) + warning }],
        };
      } catch (e: unknown) {
        return {
          content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: doc_links
  // ---------------------------------------------------------------------------

  server.registerTool(
    "doc_links",
    {
      title: "Document Links",
      description: "Get forward links (outgoing) and backlinks (incoming) for a document. Supports [[wikilinks]] and [markdown](links).",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        file: z.string().describe("File path or docid from search results"),
        direction: z.enum(["forward", "backward", "both"]).optional().default("both").describe("Link direction: forward (outgoing), backward (incoming), or both"),
        link_type: z.enum(["wikilink", "markdown", "url", "all"]).optional().default("all").describe("Filter by link type"),
      },
    },
    async ({ file, direction, link_type }) => {
      try {
        const result = await store.getLinks(file, direction, link_type);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (e: unknown) {
        return {
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        };
      }
    }
  );
}
