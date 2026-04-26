/**
 * MCP Wiki Tools — wiki_ingest, wiki_lint, wiki_log, wiki_index.
 *
 * Implements the LLM Wiki pattern (Karpathy): QMD provides the infrastructure
 * (search, storage, link analysis, logging), the LLM agent does the synthesis.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QMDStore } from "../../index.js";
import { appendLog, queryLog, getLogStats, formatLogAsMarkdown } from "../../wiki/log.js";
import { lintWiki } from "../../wiki/lint.js";
import { generateWikiIndex } from "../../wiki/index-gen.js";
import { detectFormat } from "../../backends/registry.js";

/**
 * Register all wiki tools.
 */
export function registerWikiTools(server: McpServer, store: QMDStore): void {
  const db = store.internal.db;

  // ---------------------------------------------------------------------------
  // Tool: wiki_ingest
  // ---------------------------------------------------------------------------

  server.registerTool(
    "wiki_ingest",
    {
      title: "Wiki Ingest",
      description: `Prepare a source document for wiki processing. Supports Markdown, PDF, DOCX, and PPTX sources. Returns the source content, TOC (for binary formats), related wiki pages, and suggestions.

Features:
- **Incremental**: Tracks previously ingested sources. If unchanged, returns cached status with derived wiki pages. Use force=true to re-ingest.
- **Multi-format**: PDF/DOCX/PPTX sources include a structured TOC and format-specific metadata (page/slide/section counts).
- **Large docs**: Bodies >50k chars are truncated with a suggestion to use doc_read for specific sections.

This tool does NOT generate wiki pages — it gives you context to do so. After calling this, use doc_write with the source parameter to create wiki pages and record provenance.

Workflow:
1. Call wiki_ingest with a source document
2. Read the returned context, TOC, and suggestions
3. Create summary page using doc_write with source=<source_path>
4. Create/update concept pages with [[wikilinks]]
5. Periodically run wiki_lint to detect source-stale pages`,
      annotations: { readOnlyHint: true },
      inputSchema: {
        source: z.string().describe("Source file path or docid to ingest"),
        wiki_collection: z.string().optional().describe("Target wiki collection name (auto-detected if only one wiki collection exists)"),
        force: z.boolean().optional().default(false).describe("Force re-ingest even if source hasn't changed since last ingest"),
      },
    },
    async ({ source, wiki_collection, force }) => {
      try {
        // 1. Resolve source document
        const sourceDoc = await store.get(source, { includeBody: true });
        if ("error" in sourceDoc) {
          return { content: [{ type: "text" as const, text: `Source document not found: ${source}` }], isError: true };
        }

        // 2. Find wiki collection
        const collections = await store.listCollections();
        const wikiCollections = collections.filter(c => c.type === "wiki");
        let targetWiki = wiki_collection;

        if (!targetWiki) {
          if (wikiCollections.length === 1) {
            targetWiki = wikiCollections[0]!.name;
          } else if (wikiCollections.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No wiki collection found. Create one first:\n  qmd collection add <path> --name <name> --type wiki" }],
              isError: true,
            };
          } else {
            return {
              content: [{ type: "text" as const, text: `Multiple wiki collections found: ${wikiCollections.map(c => c.name).join(", ")}. Specify wiki_collection parameter.` }],
              isError: true,
            };
          }
        }

        const wikiColl = collections.find(c => c.name === targetWiki);
        if (!wikiColl || wikiColl.type !== "wiki") {
          return { content: [{ type: "text" as const, text: `Collection "${targetWiki}" is not a wiki collection (type must be "wiki").` }], isError: true };
        }

        // 3. Incremental ingest check
        type IngestRecord = { source_hash: string; ingested_at: string } | null | undefined;
        const sourceHash = sourceDoc.hash;
        let previousIngest: IngestRecord = null;
        try {
          previousIngest = db.prepare(
            `SELECT source_hash, ingested_at FROM wiki_ingest_tracker WHERE source_file = ? AND wiki_collection = ?`
          ).get(sourceDoc.displayPath, targetWiki) as IngestRecord;
        } catch { /* table may not exist */ }

        if (previousIngest && previousIngest.source_hash === sourceHash && !force) {
          // Source unchanged — return cached status
          let derivedPages: string[] = [];
          try {
            const rows = db.prepare(
              `SELECT wiki_file FROM wiki_sources WHERE source_file = ? AND wiki_collection = ?`
            ).all(sourceDoc.displayPath, targetWiki) as { wiki_file: string }[];
            derivedPages = rows.map(r => r.wiki_file);
          } catch { /* table may not exist */ }

          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              already_ingested: true,
              source: sourceDoc.displayPath,
              last_ingested_at: previousIngest.ingested_at,
              derived_wiki_pages: derivedPages,
              message: "Source unchanged since last ingest. Use force=true to re-ingest.",
            }, null, 2) }],
          };
        }

        const isReIngest = previousIngest != null;

        // 4. Search for related wiki pages using source title
        const title = sourceDoc.title || source;
        let relatedPages: { file: string; title: string; score: number; snippet: string }[] = [];
        try {
          const searchResults = await store.searchLex(title, { limit: 10, collection: targetWiki });
          relatedPages = searchResults.map(r => ({
            file: r.displayPath,
            title: r.title,
            score: r.score,
            snippet: r.body?.slice(0, 200) || "",
          }));
        } catch {
          // Search may fail if collection is empty
        }

        // 5. Get wiki structure
        const wikiDocsResult = await store.multiGet(`${targetWiki}/**`, { includeBody: false });
        const wikiDocs = wikiDocsResult.docs;

        const categoryMap = new Map<string, string[]>();
        for (const mgResult of wikiDocs) {
          const displayPath = mgResult.doc.displayPath;
          const parts = displayPath.split("/");
          const pathParts = parts.slice(1);
          const category = pathParts.length > 1 ? pathParts[0]! : "root";
          const existing = categoryMap.get(category) ?? [];
          existing.push(displayPath);
          categoryMap.set(category, existing);
        }

        const wikiStructure = {
          total_pages: wikiDocs.length,
          categories: Array.from(categoryMap.entries()).map(([name, pages]) => ({ name, pages })),
        };

        // 6. Build source metadata + binary format enrichment
        const format = detectFormat(sourceDoc.filepath) || "md";
        const wordCount = sourceDoc.body ? sourceDoc.body.split(/\s+/).length : 0;

        const sourceMetadata: Record<string, unknown> = {
          title: sourceDoc.title,
          format,
          collection: sourceDoc.collectionName,
          docid: sourceDoc.docid,
          word_count: wordCount,
          display_path: sourceDoc.displayPath,
        };

        // For binary formats, get TOC and format-specific counts
        let sourceToc: unknown[] | undefined;
        if (format !== "md") {
          try {
            const backend = await store.getBackend(format);
            const toc = await backend.getToc(sourceDoc.filepath, sourceDoc.docid);
            sourceToc = toc;

            if (format === "pdf") {
              const rows = db.prepare(
                `SELECT COUNT(*) as cnt FROM pages_cache WHERE docid = ?`
              ).get(sourceDoc.docid) as { cnt: number } | undefined;
              if (rows) sourceMetadata.page_count = rows.cnt;
            } else if (format === "docx") {
              const rows = db.prepare(
                `SELECT COUNT(*) as cnt FROM section_map WHERE docid = ?`
              ).get(sourceDoc.docid) as { cnt: number } | undefined;
              if (rows) sourceMetadata.section_count = rows.cnt;
            } else if (format === "pptx") {
              const rows = db.prepare(
                `SELECT COUNT(*) as cnt FROM slide_cache WHERE docid = ?`
              ).get(sourceDoc.docid) as { cnt: number } | undefined;
              if (rows) sourceMetadata.slide_count = rows.cnt;
            }
          } catch {
            // Backend may not be available
          }
        }

        if (isReIngest) {
          sourceMetadata.previously_ingested = true;
          sourceMetadata.last_ingested_at = previousIngest!.ingested_at;
        }

        // 7. Handle large documents — truncate body
        let sourceContent = sourceDoc.body || "";
        const MAX_CONTENT_CHARS = 50000;
        let truncated = false;
        if (sourceContent.length > MAX_CONTENT_CHARS) {
          truncated = true;
          sourceMetadata.total_chars = sourceContent.length;
          sourceMetadata.truncated = true;
          sourceContent = sourceContent.slice(0, 20000);
        }

        // 8. Generate suggestions
        const suggestions: string[] = [];
        const safeName = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

        suggestions.push(`Create summary page: ${targetWiki}/sources/${safeName}.md (use doc_write with source="${sourceDoc.displayPath}")`);

        if (truncated) {
          suggestions.push(`Source is large (${sourceMetadata.total_chars} chars, truncated). Use doc_toc + doc_read to access specific sections.`);
        }

        if (relatedPages.length > 0) {
          for (const rp of relatedPages.slice(0, 3)) {
            suggestions.push(`Review and update related page: ${rp.file} (${Math.round(rp.score * 100)}% match)`);
          }
        }

        if (wikiDocs.length === 0) {
          suggestions.push(`This is the first source — consider also creating: ${targetWiki}/index.md, ${targetWiki}/overview.md`);
        }

        // 9. Log the ingest and update tracker
        appendLog(db, {
          operation: "ingest",
          source_file: sourceDoc.displayPath,
          details: {
            title: sourceDoc.title,
            format,
            word_count: wordCount,
            wiki_collection: targetWiki,
            related_pages_found: relatedPages.length,
            re_ingest: isReIngest,
          },
        });

        db.prepare(`
          INSERT OR REPLACE INTO wiki_ingest_tracker (source_file, wiki_collection, source_hash, ingested_at)
          VALUES (?, ?, ?, datetime('now'))
        `).run(sourceDoc.displayPath, targetWiki, sourceHash);

        // 10. Assemble response
        const result: Record<string, unknown> = {
          source_content: sourceContent,
          source_metadata: sourceMetadata,
          existing_wiki_pages: relatedPages,
          wiki_structure: wikiStructure,
          suggestions,
        };
        if (sourceToc) {
          result.source_toc = sourceToc;
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: wiki_lint
  // ---------------------------------------------------------------------------

  server.registerTool(
    "wiki_lint",
    {
      title: "Wiki Lint",
      description: `Health-check the wiki. Analyzes the link graph to find:
- Orphan pages (no inbound links)
- Broken links (targets that don't exist)
- Missing pages (referenced by multiple sources but not created)
- Hub pages (highly connected — important pages)
- Stale pages (not updated recently)
- Source-stale pages (source document updated after wiki page was written)

Returns actionable suggestions. Run periodically to keep the wiki healthy.`,
      annotations: { readOnlyHint: true },
      inputSchema: {
        collection: z.string().optional().describe("Limit analysis to a specific collection"),
        stale_days: z.number().optional().default(30).describe("Days threshold for stale page detection (default: 30)"),
      },
    },
    async ({ collection, stale_days }) => {
      try {
        const result = lintWiki(db, { collection, stale_days });

        try {
          appendLog(db, {
            operation: "lint",
            details: {
              orphan_pages: result.orphan_pages.length,
              broken_links: result.broken_links.length,
              missing_pages: result.missing_pages.length,
              stale_pages: result.stale_pages.length,
              source_stale_pages: result.source_stale_pages.length,
            },
          });
        } catch { /* log failure should not block lint results */ }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: wiki_log
  // ---------------------------------------------------------------------------

  server.registerTool(
    "wiki_log",
    {
      title: "Wiki Log",
      description: "View the wiki activity log — a chronological record of ingest, update, lint, query, web_search, web_fetch, and judge_claim operations. Useful for understanding what has been processed recently.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        since: z.string().optional().describe("ISO date string — only show entries after this date (e.g. '2025-01-01')"),
        operation: z.enum(["ingest", "update", "lint", "query", "index", "web_search", "web_fetch", "judge_claim"]).optional().describe("Filter to a specific operation type"),
        limit: z.number().optional().default(20).describe("Max entries to return (default: 20)"),
        format: z.enum(["json", "markdown"]).optional().default("markdown").describe("Output format"),
      },
    },
    async ({ since, operation, limit, format }) => {
      try {
        const entries = queryLog(db, { since, operation, limit });

        let output: string;
        if (format === "markdown") {
          output = formatLogAsMarkdown(entries);
        } else {
          output = JSON.stringify({ entries, stats: getLogStats(db) }, null, 2);
        }

        return {
          content: [{ type: "text" as const, text: output }],
        };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: wiki_index
  // ---------------------------------------------------------------------------

  server.registerTool(
    "wiki_index",
    {
      title: "Wiki Index",
      description: "Generate or update the wiki index page (index.md). Scans all documents in the wiki collection, organizes by category, and produces a navigable index with [[wikilinks]]. Optionally writes the index to disk.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        collection: z.string().describe("Wiki collection to index"),
        write: z.boolean().optional().default(false).describe("If true, write the index to the collection as index.md"),
      },
    },
    async ({ collection, write }) => {
      try {
        const result = generateWikiIndex(db, { collection });

        if (write) {
          await store.writeDocument(collection, "index.md", result.markdown, `${collection} Wiki Index`);
          appendLog(db, {
            operation: "index",
            wiki_files: [`${collection}/index.md`],
            details: { page_count: result.page_count, category_count: result.category_count },
          });
        }

        return {
          content: [{
            type: "text" as const,
            text: write
              ? `Index written to ${collection}/index.md (${result.page_count} pages, ${result.category_count} categories)\n\n${result.markdown}`
              : result.markdown,
          }],
        };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    }
  );
}
