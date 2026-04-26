import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  webSearchInputSchema,
  webFetchInputSchema,
  credibilityScoreInputSchema,
} from "../src/mcp/tools/web.js";

const webSearch = z.object(webSearchInputSchema);
const webFetch = z.object(webFetchInputSchema);
const credScore = z.object(credibilityScoreInputSchema);

describe("web_search input schema", () => {
  it("accepts full valid input", () => {
    const r = webSearch.safeParse({ query: "abc", results: "# some markdown", top_k: 5, provider: "cc_passthrough" });
    expect(r.success).toBe(true);
  });

  it("accepts minimal input (results optional)", () => {
    const r = webSearch.safeParse({ query: "abc" });
    expect(r.success).toBe(true);
  });

  it("rejects empty query (min length 1)", () => {
    const r = webSearch.safeParse({ query: "" });
    expect(r.success).toBe(false);
  });

  it("rejects query over 500 chars (max length)", () => {
    const r = webSearch.safeParse({ query: "a".repeat(501) });
    expect(r.success).toBe(false);
  });

  it("rejects unknown provider enum value", () => {
    const r = webSearch.safeParse({ query: "abc", provider: "bing" });
    expect(r.success).toBe(false);
  });

  it("rejects top_k below min (0)", () => {
    const r = webSearch.safeParse({ query: "abc", top_k: 0 });
    expect(r.success).toBe(false);
  });

  it("rejects top_k above max (51)", () => {
    const r = webSearch.safeParse({ query: "abc", top_k: 51 });
    expect(r.success).toBe(false);
  });
});

describe("web_fetch input schema", () => {
  it("accepts valid URL", () => {
    const r = webFetch.safeParse({ url: "https://example.com" });
    expect(r.success).toBe(true);
  });

  it("accepts full form with timeout_sec and max_bytes", () => {
    const r = webFetch.safeParse({ url: "https://example.com", timeout_sec: 30, max_bytes: 1_000_000 });
    expect(r.success).toBe(true);
  });

  it("rejects non-URL string", () => {
    const r = webFetch.safeParse({ url: "not-a-url" });
    expect(r.success).toBe(false);
  });

  it("rejects negative timeout_sec", () => {
    const r = webFetch.safeParse({ url: "https://example.com", timeout_sec: -1 });
    expect(r.success).toBe(false);
  });

  it("rejects max_bytes above cap (20_000_001)", () => {
    const r = webFetch.safeParse({ url: "https://example.com", max_bytes: 20_000_001 });
    expect(r.success).toBe(false);
  });
});

describe("credibility_score input schema", () => {
  it("accepts minimal valid input", () => {
    const r = credScore.safeParse({ url: "https://arxiv.org/abs/1234" });
    expect(r.success).toBe(true);
  });

  it("accepts full valid input", () => {
    const r = credScore.safeParse({
      url: "https://arxiv.org/abs/1234",
      snippet: "Some text",
      source_type: "paper",
      published_date: "2024-01-01",
      known_snippets: ["other source text"],
      method: "heuristic",
    });
    expect(r.success).toBe(true);
  });

  it("rejects non-URL string", () => {
    const r = credScore.safeParse({ url: "not-a-url-at-all" });
    expect(r.success).toBe(false);
  });

  it("rejects unknown source_type enum value", () => {
    const r = credScore.safeParse({ url: "https://x.com", source_type: "nope" });
    expect(r.success).toBe(false);
  });

  it("rejects known_snippets array longer than 50", () => {
    const r = credScore.safeParse({ url: "https://x.com", known_snippets: Array(51).fill("x") });
    expect(r.success).toBe(false);
  });
});
