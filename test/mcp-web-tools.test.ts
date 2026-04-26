/**
 * mcp-web-tools.test.ts — Integration-level tests for the three MCP web tools.
 *
 * Strategy: build a fake McpServer that captures registerTool handler callbacks,
 * then invoke them directly. Mock callPythonScript via vi.mock to avoid any
 * real Python or network calls. Mock appendLog to avoid needing a real DB.
 */

import { describe, test, expect, vi, beforeAll } from "vitest";
import { _parse_cc_websearch_output, registerWebTools } from "../src/mcp/tools/web.js";
import type { WebSearchResult } from "../src/mcp/tools/web.js";

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports that use them
// ---------------------------------------------------------------------------

vi.mock("../src/backends/python-utils.js", () => ({
  callPythonScript: vi.fn(),
}));

vi.mock("../src/wiki/log.js", () => ({
  appendLog: vi.fn(),
}));

import { callPythonScript } from "../src/backends/python-utils.js";

// ---------------------------------------------------------------------------
// Fake McpServer that captures tool handlers
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function buildFakeServer(): {
  server: { registerTool: (name: string, schema: unknown, handler: ToolHandler) => void };
  getHandler: (name: string) => ToolHandler;
} {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool(_name: string, _schema: unknown, handler: ToolHandler) {
      handlers.set(_name, handler);
    },
  };
  return {
    server,
    getHandler: (name: string) => {
      const h = handlers.get(name);
      if (!h) throw new Error(`No handler registered for "${name}"`);
      return h;
    },
  };
}

// Minimal fake QMDStore — only `internal.db` is accessed (for appendLog, which is mocked)
const fakeStore = {
  internal: { db: {} as never },
} as never;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseText(text: string): unknown {
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Setup: register tools once
// ---------------------------------------------------------------------------

let webSearch: ToolHandler;
let webFetch: ToolHandler;
let credibilityScore: ToolHandler;

beforeAll(() => {
  const { server, getHandler } = buildFakeServer();
  registerWebTools(server as never, fakeStore);
  webSearch = getHandler("web_search");
  webFetch = getHandler("web_fetch");
  credibilityScore = getHandler("credibility_score");
});

// =============================================================================
// 1. _parse_cc_websearch_output parser
// =============================================================================

describe("_parse_cc_websearch_output parser", () => {
  test("well-formed CC markdown returns ≥2 results with non-empty fields and sequential rank", () => {
    const input = `
## First Result
https://example.com/first
This is the snippet for the first result.

## Second Result
https://example.com/second
Snippet for the second result.

## Third Result
https://example.com/third
Third snippet here.
`.trim();

    const results = _parse_cc_websearch_output(input);
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < results.length; i++) {
      const r = results[i] as WebSearchResult;
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.snippet.length).toBeGreaterThan(0);
      expect(r.rank).toBe(i + 1);
    }
  });

  test("malformed half-blank blocks only returns valid entries, does not throw", () => {
    const input = `
## Real Article
https://example.com/real
Good snippet here.

No URL in this block at all.

## Another Real One
https://example.com/another
Another good snippet.
`.trim();

    const results = _parse_cc_websearch_output(input);
    expect(results.length).toBe(2);
    expect(results.every(r => r.url.startsWith("http"))).toBe(true);
  });

  test("empty string returns []", () => {
    expect(_parse_cc_websearch_output("")).toEqual([]);
    expect(_parse_cc_websearch_output("   ")).toEqual([]);
  });

  test("markdown link format [Title](url) is parsed correctly", () => {
    const input = `
[OpenAI Blog](https://openai.com/blog/gpt4)
A blog post about GPT-4 capabilities.

[Anthropic Research](https://anthropic.com/research)
Research page for Claude models.
`.trim();

    const results = _parse_cc_websearch_output(input);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const urls = results.map(r => r.url);
    expect(urls.some(u => u.includes("openai.com") || u.includes("anthropic.com"))).toBe(true);
  });

  test("bare URL without preceding title uses URL as title fallback", () => {
    const input = "https://example.com/bare\nSnippet text for bare URL.";
    const results = _parse_cc_websearch_output(input);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.url).toBe("https://example.com/bare");
  });
});

// =============================================================================
// 2. web_search handler
// =============================================================================

describe("web_search handler", () => {
  test("with results provided returns structured JSON with results array, no isError", async () => {
    const mockResults = `
## First Page
https://example.com/page1
This is the first result snippet.

## Second Page
https://example.com/page2
This is the second result snippet.
`.trim();

    const response = await webSearch({
      query: "test query",
      results: mockResults,
      provider: "cc_passthrough",
    });

    expect(response.isError).toBeFalsy();
    const body = parseText(response.content[0]!.text) as {
      query: string;
      count: number;
      results: WebSearchResult[];
      method: string;
    };
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.query).toBe("test query");
    expect(body.method).toBe("cc_passthrough");
    expect(typeof body.count).toBe("number");
  });

  test("with results omitted returns isError and NO_RESULTS_PROVIDED", async () => {
    const response = await webSearch({ query: "test query" });

    expect(response.isError).toBe(true);
    const body = parseText(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("NO_RESULTS_PROVIDED");
  });

  test("with provider: brave returns isError and not yet supported message", async () => {
    const response = await webSearch({
      query: "test",
      provider: "brave",
      results: "some results",
    });

    expect(response.isError).toBe(true);
    const body = parseText(response.content[0]!.text) as {
      error: string;
      message: string;
    };
    expect(body.error).toBe("PROVIDER_NOT_SUPPORTED");
    expect(body.message.toLowerCase()).toContain("not yet supported");
  });
});

// =============================================================================
// 3. web_fetch handler
// =============================================================================

describe("web_fetch handler", () => {
  test("with mocked callPythonScript success returns content with payload, no isError", async () => {
    const mockPayload = {
      url: "https://example.com",
      status: 200,
      markdown: "# Example\n\nHello world.",
      meta: { word_count: 3, title: "Example" },
      extracted_links: ["https://example.com/link1"],
    };
    vi.mocked(callPythonScript).mockResolvedValueOnce(mockPayload);

    const response = await webFetch({ url: "https://example.com" });

    expect(response.isError).toBeFalsy();
    const body = parseText(response.content[0]!.text) as typeof mockPayload;
    expect(body.url).toBe("https://example.com");
    expect(body.status).toBe(200);
    expect(body.markdown).toContain("Hello world");
  });

  test("when callPythonScript rejects returns isError with message", async () => {
    vi.mocked(callPythonScript).mockRejectedValueOnce(new Error("connection refused"));

    const response = await webFetch({ url: "https://unreachable.example.com" });

    expect(response.isError).toBe(true);
    const body = parseText(response.content[0]!.text) as {
      error: string;
      message: string;
    };
    expect(body.error).toBe("FETCH_FAILED");
    expect(body.message).toContain("connection refused");
  });

  test("when Python returns error field returns isError with FETCH_ERROR", async () => {
    vi.mocked(callPythonScript).mockResolvedValueOnce({
      error: "HTTP 404 Not Found",
      status: 404,
    });

    const response = await webFetch({ url: "https://example.com/notfound" });

    expect(response.isError).toBe(true);
    const body = parseText(response.content[0]!.text) as {
      error: string;
      status: number;
    };
    expect(body.error).toBe("FETCH_ERROR");
    expect(body.status).toBe(404);
  });
});

// =============================================================================
// 4. credibility_score handler
// =============================================================================

describe("credibility_score handler", () => {
  test("with mocked Python result returns normalized JSON shape", async () => {
    const mockCredResult = {
      score: 0.82,
      reasons: ["High-trust domain", "Recent publication"],
      method: "heuristic",
      components: { domain: 0.9, recency: 0.75, corroboration: 0.8 },
    };
    vi.mocked(callPythonScript).mockResolvedValueOnce(mockCredResult);

    const response = await credibilityScore({ url: "https://arxiv.org/abs/2401.00001" });

    expect(response.isError).toBeFalsy();
    const body = parseText(response.content[0]!.text) as typeof mockCredResult;
    expect(typeof body.score).toBe("number");
    expect(Array.isArray(body.reasons)).toBe(true);
    expect(body.method).toBe("heuristic");
    expect(body.components).toBeTruthy();
  });

  test("with method: judge and no judge_verdict returns isError JUDGE_INPUT_REQUIRED", async () => {
    const response = await credibilityScore({
      url: "https://example.com",
      method: "judge",
    });

    expect(response.isError).toBe(true);
    const body = parseText(response.content[0]!.text) as {
      error: string;
      hint: string;
    };
    expect(body.error).toBe("JUDGE_INPUT_REQUIRED");
    expect(body.hint).toContain("judge_verdict");
  });

  test("with known_snippets provided passes --known-snippets-json arg to Python", async () => {
    vi.mocked(callPythonScript).mockResolvedValueOnce({
      score: 0.7,
      reasons: ["Corroborated"],
      method: "heuristic",
      components: { domain: 0.8, recency: 0.6, corroboration: 0.7 },
    });

    const response = await credibilityScore({
      url: "https://example.com/article",
      snippet: "Some claim text",
      known_snippets: ["Corroborating snippet 1", "Corroborating snippet 2"],
    });

    expect(response.isError).toBeFalsy();

    // Verify the Python script was called with --known-snippets-json arg
    const mockFn = vi.mocked(callPythonScript);
    const lastCall = mockFn.mock.calls[mockFn.mock.calls.length - 1]!;
    const args = lastCall[1] as string[];
    expect(args).toContain("--known-snippets-json");
  });
});
