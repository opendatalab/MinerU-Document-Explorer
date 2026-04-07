/**
 * MCP Core Tools — query, get, multi_get, status.
 * Core search and retrieval tools.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QMDStore, ExpandedQuery } from "../../index.js";
import { extractSnippet, addLineNumbers, DEFAULT_MULTI_GET_MAX_BYTES } from "../../index.js";

type SearchResultItem = {
  docid: string;
  file: string;
  title: string;
  score: number;
  context: string | null;
  snippet: string;
  line: number;
};

type StatusResult = {
  totalDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
  collections: {
    name: string;
    path: string | null;
    pattern: string | null;
    documents: number;
    lastUpdated: string;
  }[];
};

/**
 * Format search results as human-readable text summary.
 * Includes snippets so agents using text-only mode get actionable context.
 */
function formatSearchSummary(results: SearchResultItem[], query: string, collectionsHint?: string[]): string {
  if (results.length === 0) {
    const lines = [`No results found for "${query}".`];
    lines.push("");
    lines.push("Suggestions:");
    lines.push("  - Try fewer or simpler keywords");
    lines.push("  - Check available collections with the `status` tool");
    if (collectionsHint && collectionsHint.length > 0) {
      lines.push(`  - Searched in: ${collectionsHint.join(", ")}`);
    }
    lines.push("  - Ensure documents are indexed (`qmd update`)");
    return lines.join('\n');
  }
  const lines = [`Found ${results.length} result${results.length === 1 ? '' : 's'} for "${query}":\n`];
  for (const r of results) {
    lines.push(`${r.docid} ${Math.round(r.score * 100)}% ${r.file}:${r.line} — ${r.title}`);
    if (r.snippet) {
      const trimmed = r.snippet.replace(/\n{2,}/g, '\n').trim();
      const preview = trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
      lines.push(`  ${preview}`);
    }
  }
  return lines.join('\n');
}

/**
 * Register core tools (query, get, multi_get, status).
 */
export function registerCoreTools(server: McpServer, store: QMDStore, defaultCollectionNames: string[]): void {
  const subSearchSchema = z.object({
    type: z.enum(['lex', 'vec', 'hyde']).describe(
      "lex = BM25 keywords (supports \"phrase\" and -negation); " +
      "vec = semantic question; hyde = hypothetical answer passage"
    ),
    query: z.string().describe(
      "The query text. For lex: use keywords, \"quoted phrases\", and -negation. " +
      "For vec: natural language question. For hyde: 50-100 word answer passage."
    ),
  });

  // ---------------------------------------------------------------------------
  // Tool: query (Primary search tool)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "query",
    {
      title: "Query",
      description: `Search the knowledge base. Two modes:

## Simple mode (recommended for most searches)

Pass a \`query\` string. The system auto-expands it into keyword + semantic + hypothetical searches, reranks with an LLM, and returns the best results. This is the easiest and most effective way to search.

## Advanced mode

Pass \`searches\` — an array of typed sub-queries for precise control:

- **lex** — BM25 keywords. Supports \`"exact phrase"\` and \`-negation\`.
- **vec** — Semantic search. Natural language question.
- **hyde** — Hypothetical document. Write 50-100 words resembling the answer.

First sub-query gets 2× weight. Combine types for best recall.

## Examples

Simple (just pass a query string):
\`\`\`json
{ "query": "CAP theorem" }
\`\`\`

Advanced (explicit typed sub-queries):
\`\`\`json
{ "searches": [
  { "type": "lex", "query": "\\"connection pool\\" timeout -redis" },
  { "type": "vec", "query": "why do database connections time out under load" }
]}
\`\`\``,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        query: z.string().optional().describe(
          "Simple query string — auto-expanded via LLM into keyword + semantic searches. " +
          "Use this for most searches. Mutually exclusive with 'searches'."
        ),
        searches: z.array(subSearchSchema).max(10).optional().describe(
          "Advanced: typed sub-queries (lex/vec/hyde). First gets 2x weight. " +
          "Mutually exclusive with 'query'."
        ),
        limit: z.number().optional().default(10).describe("Max results (default: 10)"),
        minScore: z.number().optional().default(0).describe("Min relevance 0-1 (default: 0)"),
        collections: z.array(z.string()).optional().describe("Filter to collections (OR match)"),
        intent: z.string().optional().describe(
          "Background context to disambiguate the query. Example: query='performance', intent='web page load times and Core Web Vitals'. Does not search on its own."
        ),
      },
    },
    async ({ query, searches, limit, minScore, collections, intent }) => {
      if (!query && (!searches || searches.length === 0)) {
        return {
          content: [{ type: "text", text: "Either 'query' or 'searches' must be provided." }],
          isError: true,
        };
      }
      if (query && searches && searches.length > 0) {
        return {
          content: [{ type: "text", text: "'query' and 'searches' are mutually exclusive. Use one or the other." }],
          isError: true,
        };
      }

      try {
        const effectiveCollections = collections ?? defaultCollectionNames;
        const searchOpts: { query?: string; queries?: ExpandedQuery[]; collections?: string[]; limit?: number; minScore?: number; intent?: string } = {
          collections: effectiveCollections.length > 0 ? effectiveCollections : undefined,
          limit,
          minScore,
          intent,
        };

        if (query) {
          searchOpts.query = query;
        } else if (searches) {
          searchOpts.queries = searches.map(s => ({ type: s.type, query: s.query }));
        }

        const results = await store.search(searchOpts);

        const primaryQuery = query
          || searches?.find(s => s.type === 'lex')?.query
          || searches?.find(s => s.type === 'vec')?.query
          || searches?.[0]?.query || "";

        const filtered: SearchResultItem[] = results.map(r => {
          const { line, snippet } = extractSnippet(r.bestChunk, primaryQuery, 300, undefined, undefined, intent);
          const snippetText = snippet;
          return {
            docid: `#${r.docid}`,
            file: r.displayPath,
            title: r.title,
            score: Math.round(r.score * 100) / 100,
            context: r.context,
            snippet: snippetText,
            line,
          };
        });

        return {
          content: [{ type: "text", text: formatSearchSummary(filtered, primaryQuery, effectiveCollections) }],
          structuredContent: { results: filtered },
        };
      } catch (e: unknown) {
        return { content: [{ type: "text", text: `Search failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: get (Retrieve document)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "get",
    {
      title: "Get Document",
      description: "Retrieve the full content of a document by its file path or docid. Use paths or docids (#abc123) from search results. Suggests similar files if not found.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        file: z.string().describe("File path or docid from search results (e.g., 'pages/meeting.md', '#abc123', or 'pages/meeting.md:100' to start at line 100)"),
        fromLine: z.number().optional().describe("Start from this line number (1-indexed)"),
        maxLines: z.number().optional().describe("Maximum number of lines to return"),
        lineNumbers: z.boolean().optional().default(false).describe("Add line numbers to output (format: 'N: content')"),
      },
    },
    async ({ file, fromLine, maxLines, lineNumbers }) => {
      try {
        let lookup = file;
        let parsedFromLine = fromLine;
        const colonMatch = lookup.match(/:(\d+)$/);
        if (colonMatch && colonMatch[1] && parsedFromLine === undefined) {
          parsedFromLine = parseInt(colonMatch[1], 10);
          lookup = lookup.slice(0, -colonMatch[0].length);
        }

        const result = await store.get(lookup, { includeBody: false });
        if ("error" in result) {
          let msg = `Document not found: ${file}`;
          if (result.similarFiles.length > 0) {
            msg += `\n\nDid you mean one of these?\n${result.similarFiles.map(s => `  - ${s}`).join('\n')}`;
          }
          return {
            content: [{ type: "text", text: msg }],
            isError: true,
          };
        }

        const fullBody = await store.getDocumentBody(result.filepath) ?? "";
        const totalLines = fullBody ? fullBody.split("\n").length : 0;

        const body = (parsedFromLine || maxLines)
          ? await store.getDocumentBody(result.filepath, { fromLine: parsedFromLine, maxLines }) ?? ""
          : fullBody;
        let text = body;
        if (lineNumbers) {
          const startLine = parsedFromLine || 1;
          text = addLineNumbers(text, startLine);
        }

        const meta: string[] = [];
        if (result.context) meta.push(`Context: ${result.context}`);
        meta.push(`Total lines: ${totalLines}`);
        if (parsedFromLine || maxLines) {
          const from = parsedFromLine || 1;
          const shown = body.split("\n").length;
          meta.push(`Showing lines ${from}-${from + shown - 1}`);
        }
        text = `<!-- ${meta.join(" | ")} -->\n\n` + text;

        return {
          content: [{
            type: "resource",
            resource: {
              uri: `qmd://${encodeURIComponent(result.displayPath)}`,
              name: result.displayPath,
              title: result.title,
              mimeType: "text/markdown",
              text,
            },
          }],
        };
      } catch (e: unknown) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: multi_get (Retrieve multiple documents)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "multi_get",
    {
      title: "Multi-Get Documents",
      description: "Retrieve multiple documents by glob pattern (e.g., 'journals/2025-05*.md'), comma-separated list, or comma-separated globs (e.g., 'docs/api*.md, docs/config*.md'). Skips files larger than maxBytes.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        pattern: z.string().describe("Glob pattern or comma-separated list of file paths"),
        maxLines: z.number().optional().describe("Maximum lines per file"),
        maxBytes: z.number().optional().default(10240).describe("Skip files larger than this (default 10240 = 10KB)"),
        lineNumbers: z.boolean().optional().default(false).describe("Add line numbers to output (format: 'N: content')"),
      },
    },
    async ({ pattern, maxLines, maxBytes, lineNumbers }) => {
      try {
        const { docs, errors } = await store.multiGet(pattern, { includeBody: true, maxBytes: maxBytes ?? DEFAULT_MULTI_GET_MAX_BYTES });

        if (docs.length === 0 && errors.length === 0) {
          return {
            content: [{ type: "text", text: `No files matched pattern: ${pattern}` }],
            isError: true,
          };
        }

        const content: ({ type: "text"; text: string } | { type: "resource"; resource: { uri: string; name: string; title?: string; mimeType: string; text: string } })[] = [];

        if (errors.length > 0) {
          content.push({ type: "text", text: `Errors:\n${errors.join('\n')}` });
        }

        for (const result of docs) {
          if (result.skipped) {
            content.push({
              type: "text",
              text: `[SKIPPED: ${result.doc.displayPath} - ${result.skipReason}. Use the 'get' tool with file="${result.doc.displayPath}" to retrieve.]`,
            });
            continue;
          }

          let text = result.doc.body || "";
          if (maxLines !== undefined) {
            const lines = text.split("\n");
            text = lines.slice(0, maxLines).join("\n");
            if (lines.length > maxLines) {
              text += `\n\n[... truncated ${lines.length - maxLines} more lines]`;
            }
          }
          if (lineNumbers) {
            text = addLineNumbers(text);
          }
          if (result.doc.context) {
            text = `<!-- Context: ${result.doc.context} -->\n\n` + text;
          }

          content.push({
            type: "resource",
            resource: {
              uri: `qmd://${encodeURIComponent(result.doc.displayPath)}`,
              name: result.doc.displayPath,
              title: result.doc.title,
              mimeType: "text/markdown",
              text,
            },
          });
        }

        return { content };
      } catch (e: unknown) {
        return { content: [{ type: "text", text: `multi_get failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: status (Index status)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "status",
    {
      title: "Index Status",
      description: "Show index status: collections, document counts, and health information.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      try {
        const status: StatusResult = await store.getStatus();
        const collectionDetails = await store.listCollections();

        const summary = [
          `MinerU Document Explorer — Index Status:`,
          `  Total documents: ${status.totalDocuments}`,
          `  Needs embedding: ${status.needsEmbedding}`,
          `  Vector index: ${status.hasVectorIndex ? 'yes' : 'no'}`,
          `  Collections: ${status.collections.length}`,
        ];

        for (const col of status.collections) {
          const label = col.name || col.path || "unknown";
          const detail = collectionDetails.find(c => c.name === col.name);
          const typeTag = detail?.type === "wiki" ? " [wiki]" : "";
          summary.push(`    - ${label}${typeTag} (${col.documents} docs, path: ${col.path || 'n/a'})`);
        }

        return {
          content: [{ type: "text", text: summary.join('\n') }],
          structuredContent: status,
        };
      } catch (e: unknown) {
        return { content: [{ type: "text", text: `Status failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );
}
