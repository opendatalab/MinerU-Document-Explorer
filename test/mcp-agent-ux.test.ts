/**
 * mcp-agent-ux.test.ts — Tests for agent-facing UX in MCP tools.
 *
 * Validates that MCP tool outputs are clear, actionable, and useful
 * for AI agents. Covers search formatting, error guidance, status
 * display, document metadata, and wiki workflow edge cases.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStore,
  type QMDStore,
  extractSnippet,
} from "../src/index.js";

let rootDir: string;

function freshTestDir(name: string) {
  return join(rootDir, name + "-" + Math.random().toString(36).slice(2, 8));
}

function freshDbPath(): string {
  return join(rootDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

async function seedDocs(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, "rag-survey.md"), `# RAG Survey 2026

## Introduction

Retrieval-Augmented Generation (RAG) has emerged as a dominant paradigm
for grounding large language models in external knowledge.

## Dense Retrieval

Dense retrieval uses learned embeddings to match queries with passages.
Models like ColBERT and DPR have shown strong performance on benchmarks.

## Sparse Retrieval

BM25 remains a strong baseline. Hybrid approaches combining dense and
sparse retrieval often outperform either alone.

## Agentic RAG

Agentic RAG systems use tool-calling agents to iteratively refine
retrieval and generation, enabling multi-hop reasoning.

## Evaluation

Standard benchmarks include Natural Questions, TriviaQA, and HotpotQA.
`);

  await writeFile(join(dir, "chunking-strategies.md"), `# Chunking Strategies

## Fixed-Size Chunking

Split text into fixed-size chunks (e.g., 512 tokens). Simple but
may break semantic boundaries.

## Semantic Chunking

Use sentence embeddings to find natural break points between topics.
Produces more coherent chunks at higher computational cost.

## Recursive Character Splitting

LangChain's approach: split by paragraphs, then sentences, then characters.
Respects document hierarchy.
`);

  await writeFile(join(dir, "reranking.md"), `# Reranking in RAG

## Cross-Encoder Reranking

Cross-encoders score query-passage pairs jointly, achieving higher
accuracy than bi-encoders at the cost of speed.

## Listwise Reranking

Listwise methods rerank entire result lists using LLMs.
Models like RankGPT and MonoT5 show promising results.

## Late Interaction

ColBERT uses late interaction between query and document token
embeddings for efficient yet accurate reranking.
`);
}

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "qmd-mcp-ux-"));
});

afterAll(async () => {
  try { await rm(rootDir, { recursive: true, force: true }); } catch {}
});

// =============================================================================
// 1. Search result quality for agents
// =============================================================================

describe("search result quality for agents", () => {
  let store: QMDStore;

  beforeAll(async () => {
    const docsDir = freshTestDir("search-quality");
    await seedDocs(docsDir);
    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { papers: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();
  });

  afterAll(async () => { await store.close(); });

  test("search results include snippet for agent context", async () => {
    const results = await store.searchLex("dense retrieval embeddings");
    expect(results.length).toBeGreaterThan(0);
    const top = results[0]!;
    const { snippet } = extractSnippet(top.body ?? "", "dense retrieval embeddings");
    expect(snippet.length).toBeGreaterThan(0);
    expect(snippet.toLowerCase()).toContain("retrieval");
  });

  test("search for ambiguous term returns scored results", async () => {
    const results = await store.searchLex("retrieval");
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
    }
  });

  test("search for non-existent term returns empty array", async () => {
    const results = await store.searchLex("xyznonexistentterm");
    expect(results).toEqual([]);
  });

  test("collection filter works correctly", async () => {
    const results = await store.searchLex("RAG", { collection: "papers" });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.collectionName).toBe("papers");
    }
  });

  test("collection filter with non-existent collection returns empty", async () => {
    const results = await store.searchLex("RAG", { collection: "nonexistent" });
    expect(results).toEqual([]);
  });
});

// =============================================================================
// 2. Document retrieval metadata
// =============================================================================

describe("document retrieval metadata for agents", () => {
  let store: QMDStore;

  beforeAll(async () => {
    const docsDir = freshTestDir("doc-meta");
    await seedDocs(docsDir);
    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();
  });

  afterAll(async () => { await store.close(); });

  test("get returns document with displayPath", async () => {
    const result = await store.get("docs/rag-survey.md");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.displayPath).toBe("docs/rag-survey.md");
      expect(result.title).toBe("RAG Survey 2026");
    }
  });

  test("getDocumentBody returns full content by default", async () => {
    const body = await store.getDocumentBody("docs/rag-survey.md");
    expect(body).toBeTruthy();
    expect(body).toContain("Retrieval-Augmented Generation");
    const lines = body!.split("\n");
    expect(lines.length).toBeGreaterThan(5);
  });

  test("getDocumentBody supports line slicing", async () => {
    const full = await store.getDocumentBody("docs/rag-survey.md");
    const totalLines = full!.split("\n").length;

    const slice = await store.getDocumentBody("docs/rag-survey.md", { fromLine: 1, maxLines: 5 });
    expect(slice).toBeTruthy();
    expect(slice!.split("\n").length).toBeLessThanOrEqual(5);

    const restOfDoc = await store.getDocumentBody("docs/rag-survey.md", { fromLine: 6 });
    expect(restOfDoc).toBeTruthy();
    expect(restOfDoc!.split("\n").length).toBe(totalLines - 5);
  });

  test("get returns not_found with similar file suggestions", async () => {
    const result = await store.get("docs/rag-survay.md");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.similarFiles.length).toBeGreaterThan(0);
    }
  });

  test("get by docid works", async () => {
    const searchResults = await store.searchLex("chunking");
    expect(searchResults.length).toBeGreaterThan(0);
    const docid = searchResults[0]!.docid;

    const result = await store.get(docid);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.title).toBe("Chunking Strategies");
    }
  });
});

// =============================================================================
// 3. Wiki workflow end-to-end
// =============================================================================

describe("wiki workflow for agents", () => {
  let store: QMDStore;
  let docsDir: string;
  let wikiDir: string;

  beforeAll(async () => {
    docsDir = freshTestDir("wiki-src");
    wikiDir = freshTestDir("wiki-pages");
    await seedDocs(docsDir);
    await mkdir(wikiDir, { recursive: true });
    store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          sources: { path: docsDir, pattern: "**/*.md" },
          wiki: { path: wikiDir, pattern: "**/*.md", type: "wiki" },
        },
      },
    });
    await store.update();
  });

  afterAll(async () => { await store.close(); });

  test("write wiki page with wikilinks creates searchable page", async () => {
    const result = await store.writeDocument(
      "wiki",
      "concepts/dense-retrieval.md",
      `# Dense Retrieval

Dense retrieval maps queries and documents to a shared embedding space.
Key models include [[ColBERT]], [[DPR]], and [[Contriever]].

## Advantages
- Semantic matching beyond keyword overlap
- Handles synonyms and paraphrases

## Related
- [[Sparse Retrieval]]
- [[Hybrid Search]]
- [[Reranking]]
`,
      "Dense Retrieval"
    );

    expect(result.file).toBe("wiki/concepts/dense-retrieval.md");
    expect(result.docid).toMatch(/^#[a-f0-9]{6}$/);

    const searchResults = await store.searchLex("dense retrieval embedding");
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults.some(r => r.collectionName === "wiki")).toBe(true);
  });

  test("wikilinks are tracked as forward links", async () => {
    const links = await store.getLinks("wiki/concepts/dense-retrieval.md", "forward", "wikilink");
    expect(links.forward.length).toBeGreaterThanOrEqual(4);
    const targets = links.forward.map(l => l.target);
    expect(targets).toContain("ColBERT");
    expect(targets).toContain("Sparse Retrieval");
    expect(targets).toContain("Reranking");
  });

  test("overwriting wiki page updates search index atomically", async () => {
    await store.writeDocument(
      "wiki",
      "concepts/dense-retrieval.md",
      `# Dense Retrieval (Updated)

Dense retrieval uses neural encoders to produce vector representations.
Models like [[E5]], [[BGE]], and [[GTE]] dominate recent leaderboards.
`,
      "Dense Retrieval"
    );

    const oldResults = await store.searchLex("ColBERT DPR Contriever");
    const hasOldContent = oldResults.some(r =>
      r.collectionName === "wiki" && r.filepath.includes("dense-retrieval")
    );
    expect(hasOldContent).toBe(false);

    const newResults = await store.searchLex("E5 BGE GTE");
    expect(newResults.some(r => r.collectionName === "wiki")).toBe(true);
  });

  test("write to nested wiki path creates directory structure", async () => {
    const result = await store.writeDocument(
      "wiki",
      "papers/rag-survey-2026.md",
      `# RAG Survey 2026 Summary

A comprehensive survey of RAG techniques published in 2026.
Covers [[Dense Retrieval]], [[Agentic RAG]], and [[Graph RAG]].
`,
      "RAG Survey 2026 Summary"
    );

    expect(result.file).toBe("wiki/papers/rag-survey-2026.md");
    const doc = await store.get("wiki/papers/rag-survey-2026.md");
    expect("error" in doc).toBe(false);
  });

  test("search across both source and wiki collections", async () => {
    const results = await store.searchLex("retrieval");
    const collections = new Set(results.map(r => r.collectionName));
    expect(collections.has("sources")).toBe(true);
    expect(collections.has("wiki")).toBe(true);
  });

  test("collection type is correctly reported", async () => {
    const collections = await store.listCollections();
    const sources = collections.find(c => c.name === "sources");
    const wiki = collections.find(c => c.name === "wiki");
    expect(sources?.type).toBe("raw");
    expect(wiki?.type).toBe("wiki");
  });
});

// =============================================================================
// 4. Error messages are actionable for agents
// =============================================================================

describe("error messages are actionable", () => {
  test("get non-existent document returns suggestions", async () => {
    const docsDir = freshTestDir("err-get");
    await seedDocs(docsDir);
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();

    const result = await store.get("docs/rag-survee.md");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe("not_found");
      expect(result.similarFiles.length).toBeGreaterThan(0);
    }
    await store.close();
  });

  test("write to non-existent collection throws clear error", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    await expect(
      store.writeDocument("missing", "test.md", "# Test")
    ).rejects.toThrow(/not found/i);

    await store.close();
  });

  test("search with no collections returns empty, not error", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    const results = await store.searchLex("anything");
    expect(results).toEqual([]);

    await store.close();
  });

  test("getLinks on non-existent document throws descriptive error", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    await expect(store.getLinks("ghost/file.md")).rejects.toThrow(/not found/i);

    await store.close();
  });
});

// =============================================================================
// 5. Multi-collection agent workflow
// =============================================================================

describe("multi-collection workflow", () => {
  let store: QMDStore;

  beforeAll(async () => {
    const dir1 = freshTestDir("mc-notes");
    const dir2 = freshTestDir("mc-papers");
    await mkdir(dir1, { recursive: true });
    await mkdir(dir2, { recursive: true });

    await writeFile(join(dir1, "meeting.md"), `# Weekly Meeting Notes

Discussed RAG pipeline improvements. Key decisions:
- Switch from BM25-only to hybrid search
- Add reranking stage with cross-encoder
- Evaluate ColBERT for late interaction
`);

    await writeFile(join(dir2, "colbert.md"), `# ColBERT: Efficient and Effective Passage Search

ColBERT introduces late interaction between query and document
token embeddings, achieving BERT-level quality with fast retrieval.

## Architecture
- Query encoder produces per-token embeddings
- Document encoder produces per-token embeddings
- MaxSim operator computes relevance
`);

    store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          notes: { path: dir1, pattern: "**/*.md" },
          papers: { path: dir2, pattern: "**/*.md" },
        },
      },
    });
    await store.update();
  });

  afterAll(async () => { await store.close(); });

  test("search across collections finds relevant docs from both", async () => {
    const results = await store.searchLex("ColBERT");
    expect(results.length).toBeGreaterThanOrEqual(2);
    const collNames = results.map(r => r.collectionName);
    expect(collNames).toContain("notes");
    expect(collNames).toContain("papers");
  });

  test("collection filter restricts to single collection", async () => {
    const notesOnly = await store.searchLex("ColBERT", { collection: "notes" });
    for (const r of notesOnly) {
      expect(r.collectionName).toBe("notes");
    }

    const papersOnly = await store.searchLex("ColBERT", { collection: "papers" });
    for (const r of papersOnly) {
      expect(r.collectionName).toBe("papers");
    }
  });

  test("multiGet with collection prefix returns correct docs", async () => {
    const { docs: notesDocs } = await store.multiGet("notes/*.md");
    expect(notesDocs.length).toBe(1);
    expect(notesDocs[0]!.doc.collectionName).toBe("notes");

    const { docs: papersDocs } = await store.multiGet("papers/*.md");
    expect(papersDocs.length).toBe(1);
    expect(papersDocs[0]!.doc.collectionName).toBe("papers");
  });

  test("status shows all collections", async () => {
    const status = await store.getStatus();
    expect(status.totalDocuments).toBe(2);
    expect(status.collections.length).toBe(2);
  });
});

// =============================================================================
// 6. Context enrichment in search results
// =============================================================================

describe("context enrichment for agents", () => {
  test("context appears in search results and aids agent understanding", async () => {
    const docsDir = freshTestDir("ctx-enrich");
    await seedDocs(docsDir);
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { papers: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();

    await store.addContext("papers", "/", "Academic papers on Retrieval-Augmented Generation (RAG) techniques");
    const results = await store.searchLex("dense retrieval");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.context).toContain("Retrieval-Augmented Generation");

    await store.close();
  });

  test("global context combines with collection context", async () => {
    const docsDir = freshTestDir("ctx-global");
    await seedDocs(docsDir);
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { papers: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();

    await store.setGlobalContext("Knowledge base for ML research team");
    await store.addContext("papers", "/", "RAG survey papers");

    const results = await store.searchLex("chunking");
    expect(results.length).toBeGreaterThan(0);
    const ctx = results[0]!.context;
    expect(ctx).toContain("ML research team");
    expect(ctx).toContain("RAG survey");

    await store.close();
  });
});

// =============================================================================
// 7. extractSnippet for agent-facing search results
// =============================================================================

describe("extractSnippet agent UX", () => {
  const ragDoc = `# RAG Survey 2026

## Introduction

Retrieval-Augmented Generation (RAG) has emerged as a dominant paradigm
for grounding large language models in external knowledge.

## Dense Retrieval

Dense retrieval uses learned embeddings to match queries with passages.
Models like ColBERT and DPR have shown strong performance.

## Sparse Retrieval

BM25 remains a strong baseline for keyword matching.

## Agentic RAG

Agentic RAG systems use tool-calling agents to iteratively refine
retrieval and generation, enabling multi-hop reasoning over documents.
The agent decides when to retrieve, what to retrieve, and how to
synthesize the retrieved information.

## Evaluation

Standard benchmarks include Natural Questions and HotpotQA.
`;

  test("snippet targets the most relevant section", () => {
    const result = extractSnippet(ragDoc, "agentic RAG multi-hop");
    expect(result.snippet.toLowerCase()).toContain("agentic");
    expect(result.line).toBeGreaterThan(10);
  });

  test("snippet with intent steers toward specific section", () => {
    const noIntent = extractSnippet(ragDoc, "retrieval");
    const agenticIntent = extractSnippet(ragDoc, "retrieval", 500, undefined, undefined, "agentic tool-calling agents");

    if (noIntent.line !== agenticIntent.line) {
      expect(agenticIntent.snippet.toLowerCase()).toContain("agent");
    }
  });

  test("snippet does not leak @@ artifacts", () => {
    const result = extractSnippet(ragDoc, "dense retrieval");
    expect(result.snippet).not.toContain("@@");
  });

  test("short document returns full content as snippet", () => {
    const shortDoc = "# Short Note\n\nJust a few lines of content.";
    const result = extractSnippet(shortDoc, "short");
    expect(result.snippet).toContain("Short Note");
    expect(result.line).toBe(1);
  });
});

// =============================================================================
// 8. Structured search via SDK
// =============================================================================

describe("structured search via SDK for agents", () => {
  let store: QMDStore;

  beforeAll(async () => {
    const docsDir = freshTestDir("structured-search");
    await seedDocs(docsDir);
    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();
  });

  afterAll(async () => { await store.close(); });

  test("lex-only structured search works", async () => {
    const results = await store.search({
      queries: [{ type: "lex", query: "reranking cross-encoder" }],
      rerank: false,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.title).toBe("Reranking in RAG");
  });

  test("multiple lex queries combine results", async () => {
    const results = await store.search({
      queries: [
        { type: "lex", query: "dense retrieval" },
        { type: "lex", query: "chunking strategies" },
      ],
      rerank: false,
    });
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test("empty queries returns empty results", async () => {
    const results = await store.search({
      queries: [],
      rerank: false,
    });
    expect(results).toEqual([]);
  });

  test("results include docid and displayPath", async () => {
    const results = await store.search({
      queries: [{ type: "lex", query: "RAG" }],
      rerank: false,
    });
    for (const r of results) {
      expect(r.docid).toMatch(/^[a-f0-9]{6}$/);
      expect(r.displayPath).toBeTruthy();
    }
  });
});

// =============================================================================
// 9. Write-then-search atomicity
// =============================================================================

describe("write-then-search atomicity", () => {
  test("written document is immediately searchable", async () => {
    const wikiDir = freshTestDir("write-search");
    await mkdir(wikiDir, { recursive: true });

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { wiki: { path: wikiDir, pattern: "**/*.md", type: "wiki" } } },
    });

    const uniqueTerm = `xyzunique${Date.now()}`;
    await store.writeDocument("wiki", "test.md", `# Test Page\n\nContent with ${uniqueTerm} term.`);

    const results = await store.searchLex(uniqueTerm);
    expect(results.length).toBe(1);
    expect(results[0]!.collectionName).toBe("wiki");

    await store.close();
  });

  test("overwritten document replaces old content in search", async () => {
    const wikiDir = freshTestDir("overwrite-search");
    await mkdir(wikiDir, { recursive: true });

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { wiki: { path: wikiDir, pattern: "**/*.md", type: "wiki" } } },
    });

    const term1 = `alpha${Date.now()}`;
    const term2 = `beta${Date.now()}`;

    await store.writeDocument("wiki", "page.md", `# Page\n\nContent with ${term1}.`);
    expect((await store.searchLex(term1)).length).toBe(1);

    await store.writeDocument("wiki", "page.md", `# Page\n\nContent with ${term2}.`);
    expect((await store.searchLex(term1)).length).toBe(0);
    expect((await store.searchLex(term2)).length).toBe(1);

    await store.close();
  });
});

// =============================================================================
// 10. Update idempotency and file change detection
// =============================================================================

describe("update idempotency and change detection", () => {
  test("double update does not create duplicates", async () => {
    const docsDir = freshTestDir("idem-update");
    await seedDocs(docsDir);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });

    const r1 = await store.update();
    expect(r1.indexed).toBe(3);

    const r2 = await store.update();
    expect(r2.unchanged).toBe(3);
    expect(r2.indexed).toBe(0);

    const status = await store.getStatus();
    expect(status.totalDocuments).toBe(3);

    await store.close();
  });

  test("modified file is detected on re-update", async () => {
    const docsDir = freshTestDir("detect-change");
    await seedDocs(docsDir);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });

    await store.update();
    await writeFile(join(docsDir, "rag-survey.md"), "# Updated Survey\n\nNew content about knowledge graphs.");

    const r = await store.update();
    expect(r.updated).toBe(1);

    const results = await store.searchLex("knowledge graphs");
    expect(results.length).toBeGreaterThan(0);

    await store.close();
  });
});
