/**
 * MCP Web Tools — web_search, web_fetch, credibility_score.
 *
 * web_search: agent-passthrough bridge for CC WebSearch output.
 * web_fetch: fetch a URL and return markdown + meta + extracted_links.
 * credibility_score: heuristic credibility scoring for a URL.
 */

import { z } from "zod";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QMDStore } from "../../index.js";
import { appendLog } from "../../wiki/log.js";
import { callPythonScript } from "../../backends/python-utils.js";

// =============================================================================
// Types
// =============================================================================

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  rank: number;
};

// =============================================================================
// Parser: CC WebSearch markdown → WebSearchResult[]
// Exported for unit tests.
// =============================================================================

/**
 * Parse the markdown blob emitted by Claude Code's built-in WebSearch tool.
 * Each result block looks roughly like:
 *
 *   ## Title Text
 *   URL: https://example.com/...
 *   Snippet text follows on subsequent lines.
 *
 * Or alternatively:
 *
 *   **Title Text**
 *   https://example.com/...
 *   Snippet text...
 *
 * The parser is defensive: malformed blocks are skipped, not thrown.
 */
export function _parse_cc_websearch_output(text: string): WebSearchResult[] {
  if (!text || !text.trim()) return [];

  const results: WebSearchResult[] = [];

  // Strategy: split into candidate blocks by double-newline, then scan each
  // block for a URL. If found, extract title from the line before the URL,
  // and snippet from lines after the URL.
  const blocks = text.split(/\n{2,}/);
  let rank = 1;

  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) continue;

    // Find URL line
    let urlLine = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      // Match bare URL or "URL: https://..." or "[text](url)" markdown link
      if (/^https?:\/\//i.test(l) || /^URL:\s*https?:\/\//i.test(l)) {
        urlLine = i;
        break;
      }
      // Markdown link pattern: extract URL from [title](url)
      const mdLink = l.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
      if (mdLink) {
        urlLine = i;
        break;
      }
    }

    if (urlLine === -1) continue;

    // Extract URL
    let url: string;
    const rawUrlLine = lines[urlLine]!;
    const mdLinkMatch = rawUrlLine.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
    if (mdLinkMatch) {
      url = mdLinkMatch[2]!;
    } else {
      url = rawUrlLine.replace(/^URL:\s*/i, "").trim();
    }
    if (!url.startsWith("http")) continue;

    // Title: prefer the line before the URL, stripped of markdown markers
    let title = "";
    if (urlLine > 0) {
      title = lines[urlLine - 1]!
        .replace(/^#+\s*/, "")    // strip heading markers
        .replace(/^\*+\s*/, "")   // strip bold markers
        .replace(/\*+$/, "")
        .trim();
    }
    // Fallback: extract from markdown link text
    if (!title && mdLinkMatch) {
      title = mdLinkMatch[1]!.trim();
    }
    if (!title) title = url;

    // Snippet: join lines after the URL line
    const snippetLines = lines.slice(urlLine + 1);
    const snippet = snippetLines
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    results.push({ title, url, snippet, rank });
    rank++;
  }

  // Fallback: if block strategy found nothing, try line-by-line URL scan
  if (results.length === 0) {
    const allLines = text.split("\n").map(l => l.trim());
    for (let i = 0; i < allLines.length; i++) {
      const l = allLines[i]!;
      const urlMatch = l.match(/https?:\/\/\S+/);
      if (!urlMatch) continue;
      const url = urlMatch[0]!.replace(/[)\].,]+$/, "");
      const title = i > 0 ? (allLines[i - 1] || url).replace(/^[#*]+\s*/, "").trim() || url : url;
      const snippet = allLines.slice(i + 1, i + 4).join(" ").trim();
      results.push({ title, url, snippet, rank });
      rank++;
      i += 2; // skip ahead to avoid re-capturing same block
    }
  }

  return results;
}

// =============================================================================
// Register all web tools
// =============================================================================

// =============================================================================
// Input schemas — exported for unit tests
// =============================================================================

export const webSearchInputSchema = {
  query: z.string().min(1).max(500).describe("The query used with the WebSearch tool"),
  results: z.string().optional().describe("Markdown output from CC WebSearch tool. If omitted, returns instructions to call WebSearch first."),
  top_k: z.number().int().min(1).max(50).default(10).optional().describe("Maximum results to return (default: 10)"),
  provider: z.enum(["cc_passthrough", "brave", "serper", "tavily"]).default("cc_passthrough").optional().describe("Search provider. Only cc_passthrough is supported in this release."),
};

export const webFetchInputSchema = {
  url: z.string().url().describe("URL to fetch and convert to markdown"),
  timeout_sec: z.number().int().min(1).max(60).default(20).optional().describe("Request timeout in seconds (default: 20)"),
  max_bytes: z.number().int().min(1).max(20_000_000).default(5_000_000).optional().describe("Maximum response body size in bytes (default: 5MB)"),
};

export const credibilityScoreInputSchema = {
  url: z.string().url().describe("URL of the source to score"),
  snippet: z.string().optional().describe("Representative text snippet from the source (used for corroboration)"),
  source_type: z.enum(["paper", "blog", "repo", "web", "unknown"]).default("unknown").optional().describe("Type hint for domain scoring"),
  published_date: z.string().optional().describe("ISO 8601 published date if known"),
  known_snippets: z.array(z.string()).max(50).optional().describe("Snippets from other independent sources covering the same claim (for corroboration scoring)"),
  method: z.enum(["heuristic", "judge", "pr", "hybrid"]).default("heuristic").optional().describe("Scoring method. Only heuristic is implemented in this POC."),
};

export function registerWebTools(server: McpServer, store: QMDStore): void {
  const db = store.internal.db;

  // ---------------------------------------------------------------------------
  // Tool: web_search
  // ---------------------------------------------------------------------------

  server.registerTool(
    "web_search",
    {
      title: "Web Search",
      description: `Agent-passthrough bridge for web search. Use your built-in WebSearch tool first, then pass the results here for normalization and logging.

Workflow:
1. Call your built-in WebSearch tool with the query
2. Copy the full markdown output into the \`results\` parameter
3. This tool parses, normalizes, and logs the results

If \`results\` is omitted, returns an error with instructions to call WebSearch first.
Only \`cc_passthrough\` provider is functional in this release; other providers return an error.`,
      annotations: { readOnlyHint: false },
      inputSchema: webSearchInputSchema,
    },
    async ({ query, results, top_k, provider }) => {
      const effectiveProvider = provider ?? "cc_passthrough";
      const effectiveTopK = top_k ?? 10;

      // Non-passthrough providers not yet implemented
      if (effectiveProvider !== "cc_passthrough") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            error: "PROVIDER_NOT_SUPPORTED",
            provider: effectiveProvider,
            message: `Provider "${effectiveProvider}" is not yet supported in this POC release. Use cc_passthrough.`,
          }) }],
          isError: true,
        };
      }

      // No results provided — instruct agent to call WebSearch first
      if (!results) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            error: "NO_RESULTS_PROVIDED",
            hint: "Call your built-in WebSearch tool with this query, then re-call web_search with the markdown output in the `results` parameter.",
            query,
          }) }],
          isError: true,
        };
      }

      // Parse the CC WebSearch markdown output
      const parsed = _parse_cc_websearch_output(results);
      const limited = parsed.slice(0, effectiveTopK);

      try {
        appendLog(db, {
          operation: "web_search",
          details: { query, count: limited.length, provider: effectiveProvider },
        });
      } catch { /* log failure must not block results */ }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          query,
          count: limited.length,
          results: limited,
          method: "cc_passthrough",
        }, null, 2) }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: web_fetch
  // ---------------------------------------------------------------------------

  server.registerTool(
    "web_fetch",
    {
      title: "Web Fetch",
      description: "Fetch a URL and return its content as markdown, along with metadata and extracted outbound links. Thin wrapper over the web_fetch.py Python script.",
      annotations: { readOnlyHint: true },
      inputSchema: webFetchInputSchema,
    },
    async ({ url, timeout_sec, max_bytes }) => {
      const timeout = timeout_sec ?? 20;
      const maxBytes = max_bytes ?? 5_000_000;

      let raw: unknown;
      try {
        raw = await callPythonScript(
          "web_fetch.py",
          ["--url", url, "--timeout", String(timeout), "--max-bytes", String(maxBytes)],
          undefined,
          "deepresearch/scripts"
        );
      } catch (e: unknown) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            error: "FETCH_FAILED",
            url,
            message: e instanceof Error ? e.message : String(e),
          }) }],
          isError: true,
        };
      }

      // Normalize error from Python script
      const result = raw as Record<string, unknown>;
      if (result && typeof result === "object" && result["error"]) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            error: "FETCH_ERROR",
            url,
            message: String(result["error"]),
            status: result["status"] ?? null,
          }) }],
          isError: true,
        };
      }

      try {
        appendLog(db, {
          operation: "web_fetch",
          source_file: url,
          details: {
            url,
            word_count: result["meta"] && typeof result["meta"] === "object"
              ? (result["meta"] as Record<string, unknown>)["word_count"] ?? null
              : null,
            status: result["status"] ?? null,
          },
        });
      } catch { /* log failure must not block result */ }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: credibility_score
  // ---------------------------------------------------------------------------

  server.registerTool(
    "credibility_score",
    {
      title: "Credibility Score",
      description: `Heuristic credibility scoring for a URL. Returns a 0–1 score with component breakdown and human-readable reasons.

Components:
- **domain**: trust tier of the source domain (arxiv, github, medium, etc.)
- **recency**: how recently the content was published
- **corroboration**: whether the claim appears in other independent sources

Only the \`heuristic\` method is implemented in this POC release.`,
      annotations: { readOnlyHint: true },
      inputSchema: credibilityScoreInputSchema,
    },
    async ({ url, snippet, source_type, published_date, known_snippets, method }) => {
      const effectiveMethod = method ?? "heuristic";

      if (effectiveMethod !== "heuristic") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            error: "METHOD_NOT_IMPLEMENTED",
            method: effectiveMethod,
            message: `Method "${effectiveMethod}" is not yet implemented in this POC release. Use heuristic.`,
          }) }],
          isError: true,
        };
      }

      // Build args for credibility_heuristic.py
      const args: string[] = ["--url", url];
      if (snippet) args.push("--snippet", snippet);
      if (source_type && source_type !== "unknown") args.push("--source-type", source_type);
      if (published_date) args.push("--date", published_date);

      // Write known_snippets to a temp JSON file if provided
      let tmpFilePath: string | null = null;
      if (known_snippets && known_snippets.length > 0) {
        tmpFilePath = join(tmpdir(), `qmd-snippets-${randomUUID()}.json`);
        await writeFile(tmpFilePath, JSON.stringify(known_snippets), "utf-8");
        args.push("--known-snippets-json", tmpFilePath);
      }

      let raw: unknown;
      try {
        raw = await callPythonScript(
          "credibility_heuristic.py",
          args,
          undefined,
          "deepresearch/scripts"
        );
      } catch (e: unknown) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            error: "CREDIBILITY_FAILED",
            url,
            message: e instanceof Error ? e.message : String(e),
          }) }],
          isError: true,
        };
      } finally {
        if (tmpFilePath) {
          unlink(tmpFilePath).catch(() => { /* best-effort cleanup */ });
        }
      }

      const result = raw as Record<string, unknown>;
      if (result && typeof result === "object" && result["error"]) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            error: "CREDIBILITY_ERROR",
            url,
            message: String(result["error"]),
          }) }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
