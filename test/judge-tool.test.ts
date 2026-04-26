/**
 * judge-tool.test.ts — Integration-level tests for the judge_claim MCP tool handler.
 *
 * Strategy: build a fake McpServer that captures registerTool handler callbacks,
 * then invoke them directly. Mock appendLog via vi.mock to avoid needing a real DB.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { registerJudgeTools } from "../src/mcp/tools/judge.js";

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports that use them
// ---------------------------------------------------------------------------

vi.mock("../src/wiki/log.js", () => ({
  appendLog: vi.fn(),
}));

import { appendLog } from "../src/wiki/log.js";

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

let judgeClaim: ToolHandler;

beforeAll(() => {
  const { server, getHandler } = buildFakeServer();
  registerJudgeTools(server as never, fakeStore);
  judgeClaim = getHandler("judge_claim");
});

// =============================================================================
// judge_claim handler
// =============================================================================

describe("judge_claim handler", () => {
  it("missing verdict returns isError with JUDGE_INPUT_REQUIRED", async () => {
    const response = await judgeClaim({ source_text: "Some source text.", claim: "A claim." });
    expect(response.isError).toBe(true);
    const body = parseText(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("JUDGE_INPUT_REQUIRED");
  });

  it("JUDGE_INPUT_REQUIRED response includes the claim for context", async () => {
    const response = await judgeClaim({ source_text: "Some source text.", claim: "specific claim text" });
    expect(response.isError).toBe(true);
    const body = parseText(response.content[0]!.text) as { claim: string; hint: string };
    expect(body.claim).toBe("specific claim text");
    expect(body.hint).toBeTruthy();
  });

  it("verdict present but reasoning missing returns isError with JUDGE_INPUT_INCOMPLETE", async () => {
    const response = await judgeClaim({
      source_text: "Some text.",
      claim: "A claim.",
      verdict: "verified",
      confidence: 0.9,
    });
    expect(response.isError).toBe(true);
    const body = parseText(response.content[0]!.text) as { error: string; missing: string[] };
    expect(body.error).toBe("JUDGE_INPUT_INCOMPLETE");
    expect(body.missing).toContain("reasoning");
  });

  it("verdict present but confidence missing returns isError with JUDGE_INPUT_INCOMPLETE", async () => {
    const response = await judgeClaim({
      source_text: "Some text.",
      claim: "A claim.",
      verdict: "verified",
      reasoning: "The source directly supports this.",
    });
    expect(response.isError).toBe(true);
    const body = parseText(response.content[0]!.text) as { error: string; missing: string[] };
    expect(body.error).toBe("JUDGE_INPUT_INCOMPLETE");
    expect(body.missing).toContain("confidence");
  });

  it("full valid input returns success JSON with logged:true, verdict, confidence, timestamp", async () => {
    const response = await judgeClaim({
      source_text: "The study shows X reduces latency by 30%.",
      claim: "X reduces latency.",
      verdict: "verified",
      reasoning: "Source directly states the 30% reduction.",
      confidence: 0.95,
      source_type: "paper",
    });
    expect(response.isError).toBeFalsy();
    const body = parseText(response.content[0]!.text) as {
      logged: boolean;
      verdict: string;
      confidence: number;
      timestamp: string;
    };
    expect(body.logged).toBe(true);
    expect(body.verdict).toBe("verified");
    expect(body.confidence).toBe(0.95);
    expect(typeof body.timestamp).toBe("string");
  });

  it("timestamp in success response is valid ISO 8601", async () => {
    const response = await judgeClaim({
      source_text: "Some text.",
      claim: "A claim.",
      verdict: "unclear",
      reasoning: "Insufficient evidence either way.",
      confidence: 0.5,
    });
    expect(response.isError).toBeFalsy();
    const body = parseText(response.content[0]!.text) as { timestamp: string };
    const parsed = new Date(body.timestamp);
    expect(parsed.toISOString()).toBe(body.timestamp);
  });

  it("appendLog is called with correct payload shape on success", async () => {
    vi.mocked(appendLog).mockClear();
    await judgeClaim({
      source_text: "Blog post claims Y.",
      claim: "Y is true.",
      verdict: "under_supported",
      reasoning: "Weak evidence only.",
      confidence: 0.4,
      source_type: "blog",
    });
    expect(vi.mocked(appendLog)).toHaveBeenCalledOnce();
    const call = vi.mocked(appendLog).mock.calls[0]!;
    // call[0] = db, call[1] = log entry
    const entry = call[1] as { operation: string; details: Record<string, unknown> };
    expect(entry.operation).toBe("judge_claim");
    expect(entry.details.claim).toBe("Y is true.");
    expect(entry.details.verdict).toBe("under_supported");
    expect(entry.details.reasoning).toBe("Weak evidence only.");
    expect(entry.details.confidence).toBe(0.4);
    expect(entry.details.source_type).toBe("blog");
  });

  it("verdict: 'verified' accepted and echoed in response", async () => {
    const response = await judgeClaim({
      source_text: "x", claim: "y", verdict: "verified", reasoning: "r", confidence: 0.8,
    });
    expect(response.isError).toBeFalsy();
    const body = parseText(response.content[0]!.text) as { verdict: string };
    expect(body.verdict).toBe("verified");
  });

  it("verdict: 'under_supported' accepted and echoed in response", async () => {
    const response = await judgeClaim({
      source_text: "x", claim: "y", verdict: "under_supported", reasoning: "r", confidence: 0.3,
    });
    expect(response.isError).toBeFalsy();
    const body = parseText(response.content[0]!.text) as { verdict: string };
    expect(body.verdict).toBe("under_supported");
  });

  it("verdict: 'contradicted' accepted and echoed in response", async () => {
    const response = await judgeClaim({
      source_text: "x", claim: "y", verdict: "contradicted", reasoning: "r", confidence: 0.9,
    });
    expect(response.isError).toBeFalsy();
    const body = parseText(response.content[0]!.text) as { verdict: string };
    expect(body.verdict).toBe("contradicted");
  });

  it("verdict: 'gaming' accepted and echoed in response", async () => {
    const response = await judgeClaim({
      source_text: "x", claim: "y", verdict: "gaming", reasoning: "r", confidence: 0.85,
    });
    expect(response.isError).toBeFalsy();
    const body = parseText(response.content[0]!.text) as { verdict: string };
    expect(body.verdict).toBe("gaming");
  });

  it("verdict: 'unclear' accepted and echoed in response", async () => {
    const response = await judgeClaim({
      source_text: "x", claim: "y", verdict: "unclear", reasoning: "r", confidence: 0.5,
    });
    expect(response.isError).toBeFalsy();
    const body = parseText(response.content[0]!.text) as { verdict: string };
    expect(body.verdict).toBe("unclear");
  });

  it("when appendLog throws returns isError with LOG_APPEND_FAILED", async () => {
    vi.mocked(appendLog).mockImplementationOnce(() => {
      throw new Error("db offline");
    });
    const response = await judgeClaim({
      source_text: "Some text.",
      claim: "A claim.",
      verdict: "verified",
      reasoning: "Supported.",
      confidence: 0.9,
    });
    expect(response.isError).toBe(true);
    const body = parseText(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("LOG_APPEND_FAILED");
    expect(body.message).toContain("db offline");
  });

  it("source_type defaults to 'unknown' in appendLog payload when omitted", async () => {
    vi.mocked(appendLog).mockClear();
    await judgeClaim({
      source_text: "Some text.",
      claim: "A claim.",
      verdict: "verified",
      reasoning: "Supported.",
      confidence: 0.7,
      // source_type intentionally omitted
    });
    const call = vi.mocked(appendLog).mock.calls[0]!;
    const entry = call[1] as { details: Record<string, unknown> };
    expect(entry.details.source_type).toBe("unknown");
  });
});
