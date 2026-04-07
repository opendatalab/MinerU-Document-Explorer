/**
 * TDD Deep Tests — Phase 9
 *
 * Comprehensive agent-perspective testing. Tests are written FIRST to expose
 * real bugs, then code is fixed to make them pass.
 *
 * Bug categories:
 * 1. Wiki table cleanup on collection operations (remove/rename)
 * 2. Link integrity after collection mutations
 * 3. getDocumentBody edge cases
 * 4. Search quality and ranking
 * 5. Multi-collection operations
 * 6. Unicode/special character handling
 * 7. Document lifecycle (write → search → update → remove)
 * 8. Context inheritance correctness
 * 9. Path resolution robustness
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type QMDStore } from "../src/index.js";

let rootDir: string;

function freshDbPath(): string {
  return join(rootDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function freshTestDir(name: string): string {
  return join(rootDir, name + "-" + Math.random().toString(36).slice(2));
}

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "qmd-tdd-deep-"));
});

afterAll(async () => {
  try { await rm(rootDir, { recursive: true, force: true }); } catch {}
});

// =============================================================================
// 1. Wiki table cleanup on removeCollection
// =============================================================================

describe("wiki table cleanup on removeCollection", () => {
  let store: QMDStore;
  let wikiDir: string;
  let srcDir: string;

  beforeAll(async () => {
    wikiDir = freshTestDir("wiki-rm");
    srcDir = freshTestDir("src-rm");
    await mkdir(wikiDir, { recursive: true });
    await mkdir(srcDir, { recursive: true });

    await writeFile(join(srcDir, "paper.md"), "# Paper\n\nA research paper.");

    store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          sources: { path: srcDir, pattern: "**/*.md" },
          mywiki: { path: wikiDir, pattern: "**/*.md", type: "wiki" },
        },
      },
    });
    await store.update();
  });

  afterAll(async () => { await store.close(); });

  test("wiki_sources is cleaned up when wiki collection is removed", async () => {
    const result = await store.writeDocument("mywiki", "concepts/paper.md", "# Paper Summary\n\nSummary of the paper.");
    const db = store.internal.db;

    // Manually insert wiki_sources entry (simulating doc_write with source)
    db.prepare(`
      INSERT OR REPLACE INTO wiki_sources (wiki_file, source_file, wiki_collection, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(result.file, "sources/paper.md", "mywiki");

    const before = db.prepare(`SELECT COUNT(*) as c FROM wiki_sources WHERE wiki_collection = 'mywiki'`).get() as { c: number };
    expect(before.c).toBeGreaterThan(0);

    await store.removeCollection("mywiki");

    const after = db.prepare(`SELECT COUNT(*) as c FROM wiki_sources WHERE wiki_collection = 'mywiki'`).get() as { c: number };
    expect(after.c).toBe(0);
  });

  test("wiki_ingest_tracker is cleaned up when wiki collection is removed", async () => {
    // Re-create the collection for this test
    await store.addCollection("mywiki2", { path: wikiDir, pattern: "**/*.md", type: "wiki" });
    const db = store.internal.db;

    db.prepare(`
      INSERT OR REPLACE INTO wiki_ingest_tracker (source_file, wiki_collection, source_hash, ingested_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run("sources/paper.md", "mywiki2", "abc123hash");

    const before = db.prepare(`SELECT COUNT(*) as c FROM wiki_ingest_tracker WHERE wiki_collection = 'mywiki2'`).get() as { c: number };
    expect(before.c).toBeGreaterThan(0);

    await store.removeCollection("mywiki2");

    const after = db.prepare(`SELECT COUNT(*) as c FROM wiki_ingest_tracker WHERE wiki_collection = 'mywiki2'`).get() as { c: number };
    expect(after.c).toBe(0);
  });
});

// =============================================================================
// 2. Wiki table consistency on renameCollection
// =============================================================================

describe("wiki table consistency on renameCollection", () => {
  let store: QMDStore;
  let wikiDir: string;

  beforeAll(async () => {
    wikiDir = freshTestDir("wiki-rename");
    await mkdir(wikiDir, { recursive: true });

    store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          oldwiki: { path: wikiDir, pattern: "**/*.md", type: "wiki" },
        },
      },
    });

    await store.writeDocument("oldwiki", "page.md", "# Page\n\nContent.");
  });

  afterAll(async () => { await store.close(); });

  test("wiki_sources.wiki_collection is updated on rename", async () => {
    const db = store.internal.db;
    db.prepare(`
      INSERT OR REPLACE INTO wiki_sources (wiki_file, source_file, wiki_collection, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run("oldwiki/page.md", "sources/doc.md", "oldwiki");

    await store.renameCollection("oldwiki", "newwiki");

    const row = db.prepare(`SELECT wiki_collection FROM wiki_sources WHERE wiki_file = 'newwiki/page.md'`).get() as { wiki_collection: string } | null;
    expect(row).not.toBeNull();
    expect(row!.wiki_collection).toBe("newwiki");
  });

  test("wiki_ingest_tracker.wiki_collection is updated on rename", async () => {
    const db = store.internal.db;
    db.prepare(`
      INSERT OR REPLACE INTO wiki_ingest_tracker (source_file, wiki_collection, source_hash, ingested_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run("sources/doc.md", "newwiki", "hash123");

    await store.renameCollection("newwiki", "renamedwiki");

    const row = db.prepare(`SELECT wiki_collection FROM wiki_ingest_tracker WHERE source_file = 'sources/doc.md'`).get() as { wiki_collection: string } | null;
    expect(row).not.toBeNull();
    expect(row!.wiki_collection).toBe("renamedwiki");
  });

  test("wiki_sources.wiki_file paths are updated on rename", async () => {
    const db = store.internal.db;
    db.prepare(`
      INSERT OR REPLACE INTO wiki_sources (wiki_file, source_file, wiki_collection, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run("renamedwiki/page.md", "sources/doc.md", "renamedwiki");

    await store.renameCollection("renamedwiki", "finalwiki");

    const row = db.prepare(`SELECT wiki_file FROM wiki_sources WHERE wiki_collection = 'finalwiki'`).get() as { wiki_file: string } | null;
    expect(row).not.toBeNull();
    expect(row!.wiki_file).toBe("finalwiki/page.md");
  });
});

// =============================================================================
// 3. getDocumentBody edge cases
// =============================================================================

describe("getDocumentBody edge cases", () => {
  let store: QMDStore;
  let docsDir: string;

  beforeAll(async () => {
    docsDir = freshTestDir("body-edge");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "doc.md"), "line1\nline2\nline3\nline4\nline5");

    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();
  });

  afterAll(async () => { await store.close(); });

  test("fromLine=0 should be treated the same as fromLine=1", async () => {
    const bodyFrom0 = await store.getDocumentBody("docs/doc.md", { fromLine: 0 });
    const bodyFrom1 = await store.getDocumentBody("docs/doc.md", { fromLine: 1 });
    expect(bodyFrom0).toBe(bodyFrom1);
  });

  test("fromLine beyond total lines returns empty string", async () => {
    const body = await store.getDocumentBody("docs/doc.md", { fromLine: 100 });
    expect(body).toBe("");
  });

  test("maxLines=0 returns empty string", async () => {
    const body = await store.getDocumentBody("docs/doc.md", { maxLines: 0 });
    expect(body).toBe("");
  });

  test("fromLine + maxLines returns correct slice", async () => {
    const body = await store.getDocumentBody("docs/doc.md", { fromLine: 2, maxLines: 2 });
    expect(body).toBe("line2\nline3");
  });

  test("maxLines larger than remaining returns rest of document", async () => {
    const body = await store.getDocumentBody("docs/doc.md", { fromLine: 4, maxLines: 100 });
    expect(body).toBe("line4\nline5");
  });
});

// =============================================================================
// 4. Search quality and ranking (BM25)
// =============================================================================

describe("search quality and ranking", () => {
  let store: QMDStore;

  beforeAll(async () => {
    const docsDir = freshTestDir("search-quality");
    await mkdir(docsDir, { recursive: true });

    await writeFile(join(docsDir, "exact.md"), "# Attention Mechanism\n\nThe attention mechanism is the core innovation.");
    await writeFile(join(docsDir, "partial.md"), "# Neural Networks\n\nAttention is one of many techniques used.");
    await writeFile(join(docsDir, "unrelated.md"), "# Cooking Guide\n\nHow to make pasta.");

    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();
  });

  afterAll(async () => { await store.close(); });

  test("title match scores higher than body-only match", async () => {
    const results = await store.searchLex("attention mechanism");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.displayPath).toContain("exact");
  });

  test("unrelated documents are not returned for specific queries", async () => {
    const results = await store.searchLex("attention mechanism");
    const files = results.map(r => r.displayPath);
    expect(files.some(f => f.includes("cooking") || f.includes("unrelated"))).toBe(false);
  });

  test("negation in FTS excludes matching documents", async () => {
    const results = await store.searchLex('attention -mechanism');
    const files = results.map(r => r.displayPath);
    expect(files.some(f => f.includes("exact"))).toBe(false);
  });

  test("quoted phrase search matches exact phrases", async () => {
    const results = await store.searchLex('"attention mechanism"');
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      const body = await store.getDocumentBody(r.filepath);
      const lower = (body || "").toLowerCase() + " " + r.title.toLowerCase();
      expect(lower).toContain("attention mechanism");
    }
  });

  test("empty query returns no results without error", async () => {
    const results = await store.searchLex("");
    expect(results).toEqual([]);
  });

  test("single character query returns results if matched", async () => {
    const results = await store.searchLex("a");
    // "a" is very common, might match or might not depending on tokenization
    expect(Array.isArray(results)).toBe(true);
  });
});

// =============================================================================
// 5. Multi-collection operations
// =============================================================================

describe("multi-collection operations", () => {
  let store: QMDStore;
  let docsDir: string;
  let notesDir: string;

  beforeAll(async () => {
    docsDir = freshTestDir("multi-docs");
    notesDir = freshTestDir("multi-notes");
    await mkdir(docsDir, { recursive: true });
    await mkdir(notesDir, { recursive: true });

    await writeFile(join(docsDir, "api.md"), "# API Design\n\nRESTful API patterns.");
    await writeFile(join(notesDir, "api.md"), "# API Notes\n\nMy notes about APIs.");

    store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
          notes: { path: notesDir, pattern: "**/*.md" },
        },
      },
    });
    await store.update();
  });

  afterAll(async () => { await store.close(); });

  test("search across collections returns results from both", async () => {
    const results = await store.searchLex("api");
    const collections = new Set(results.map(r => r.collectionName));
    expect(collections.size).toBe(2);
    expect(collections.has("docs")).toBe(true);
    expect(collections.has("notes")).toBe(true);
  });

  test("collection-filtered search only returns from specified collection", async () => {
    const results = await store.searchLex("api", { collection: "docs" });
    for (const r of results) {
      expect(r.collectionName).toBe("docs");
    }
    expect(results.length).toBeGreaterThan(0);
  });

  test("removing one collection doesn't affect the other", async () => {
    await store.removeCollection("notes");
    const results = await store.searchLex("api");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.collectionName).toBe("docs");
    }
  });

  test("removed collection's documents are not searchable", async () => {
    const results = await store.searchLex("notes about APIs");
    const noteResults = results.filter(r => r.collectionName === "notes");
    expect(noteResults.length).toBe(0);
  });
});

// =============================================================================
// 6. Unicode and special character handling
// =============================================================================

describe("unicode and special character handling", () => {
  let store: QMDStore;
  let docsDir: string;

  beforeAll(async () => {
    docsDir = freshTestDir("unicode");
    await mkdir(docsDir, { recursive: true });

    await writeFile(join(docsDir, "chinese.md"), "# 机器学习\n\n深度学习是机器学习的一个子领域。");
    await writeFile(join(docsDir, "japanese.md"), "# 機械学習\n\n深層学習について。");
    await writeFile(join(docsDir, "mixed.md"), "# API 设计原则\n\nREST API 的设计要遵循一些原则。");

    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();
  });

  afterAll(async () => { await store.close(); });

  test("Chinese content is indexed and searchable", async () => {
    const results = await store.searchLex("机器学习");
    expect(results.length).toBeGreaterThan(0);
  });

  test("mixed CJK and ASCII content is searchable by either script", async () => {
    const apiResults = await store.searchLex("API");
    expect(apiResults.length).toBeGreaterThan(0);

    const cnResults = await store.searchLex("设计原则");
    expect(cnResults.length).toBeGreaterThan(0);
  });

  test("get works with unicode document paths", async () => {
    const result = await store.get("docs/chinese.md");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.title).toContain("机器学习");
    }
  });
});

// =============================================================================
// 7. Document lifecycle (write → search → overwrite → remove)
// =============================================================================

describe("document lifecycle", () => {
  let store: QMDStore;
  let wikiDir: string;

  beforeAll(async () => {
    wikiDir = freshTestDir("lifecycle");
    await mkdir(wikiDir, { recursive: true });

    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { wiki: { path: wikiDir, pattern: "**/*.md", type: "wiki" } } },
    });
  });

  afterAll(async () => { await store.close(); });

  test("writeDocument → searchable immediately", async () => {
    await store.writeDocument("wiki", "concepts/ml.md", "# Machine Learning\n\nML is a subfield of AI.");
    const results = await store.searchLex("machine learning");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.displayPath).toContain("ml.md");
  });

  test("overwrite document → search reflects new content", async () => {
    await store.writeDocument("wiki", "concepts/ml.md", "# Deep Learning\n\nDL uses neural networks.");
    const results = await store.searchLex("deep learning");
    expect(results.length).toBeGreaterThan(0);

    const oldResults = await store.searchLex("machine learning subfield");
    const mlInOld = oldResults.filter(r => r.displayPath.includes("ml.md"));
    expect(mlInOld.length).toBe(0);
  });

  test("writeDocument returns usable path for get()", async () => {
    const { file, docid } = await store.writeDocument("wiki", "test-path.md", "# Test\n\nBody.");
    expect(file).toBe("wiki/test-path.md");

    const doc = await store.get(file);
    expect("error" in doc).toBe(false);
    if (!("error" in doc)) {
      expect(doc.title).toBe("Test");
      expect(doc.docid).toBe(docid.replace("#", ""));
    }
  });

  test("writeDocument with path needing handelize → returned path works with get", async () => {
    const { file } = await store.writeDocument("wiki", "My Great Document.md", "# Great\n\nContent.");
    // handelize converts "My Great Document.md" → "my-great-document.md"
    expect(file).toBe("wiki/my-great-document.md");

    const doc = await store.get(file);
    expect("error" in doc).toBe(false);
  });

  test("write to non-existent collection throws clear error", async () => {
    await expect(
      store.writeDocument("nonexistent", "test.md", "# Test\n\nBody.")
    ).rejects.toThrow(/not found/i);
  });

  test("get by docid works after write", async () => {
    const { docid } = await store.writeDocument("wiki", "byid.md", "# By ID\n\nLookup by docid.");
    const doc = await store.get(docid);
    expect("error" in doc).toBe(false);
    if (!("error" in doc)) {
      expect(doc.displayPath).toContain("byid.md");
    }
  });
});

// =============================================================================
// 8. Context inheritance
// =============================================================================

describe("context inheritance", () => {
  let store: QMDStore;
  let docsDir: string;

  beforeAll(async () => {
    docsDir = freshTestDir("context");
    await mkdir(join(docsDir, "api", "v2"), { recursive: true });
    await mkdir(join(docsDir, "guides"), { recursive: true });
    await writeFile(join(docsDir, "api", "v2", "endpoints.md"), "# Endpoints\n\nList of endpoints.");
    await writeFile(join(docsDir, "guides", "quickstart.md"), "# Quickstart\n\nGetting started.");

    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();
  });

  afterAll(async () => { await store.close(); });

  test("global context applies to all documents", async () => {
    await store.setGlobalContext("This is a software project");
    const doc = await store.get("docs/api/v2/endpoints.md");
    expect("error" in doc).toBe(false);
    if (!("error" in doc)) {
      expect(doc.context).toContain("software project");
    }
  });

  test("collection context inherits to nested paths", async () => {
    await store.addContext("docs", "/api", "API documentation section");
    const doc = await store.get("docs/api/v2/endpoints.md");
    expect("error" in doc).toBe(false);
    if (!("error" in doc)) {
      expect(doc.context).toContain("API documentation");
    }
  });

  test("more specific context is included alongside parent context", async () => {
    await store.addContext("docs", "/api/v2", "Version 2 API");
    const doc = await store.get("docs/api/v2/endpoints.md");
    expect("error" in doc).toBe(false);
    if (!("error" in doc)) {
      expect(doc.context).toContain("API documentation");
      expect(doc.context).toContain("Version 2 API");
    }
  });

  test("non-matching path context does not apply", async () => {
    const doc = await store.get("docs/guides/quickstart.md");
    expect("error" in doc).toBe(false);
    if (!("error" in doc)) {
      // Should have global context but NOT api context
      expect(doc.context).toContain("software project");
      expect(doc.context).not.toContain("API documentation");
    }
  });
});

// =============================================================================
// 9. Path resolution robustness
// =============================================================================

describe("path resolution robustness", () => {
  let store: QMDStore;
  let docsDir: string;

  beforeAll(async () => {
    docsDir = freshTestDir("paths");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "readme.md"), "# README\n\nProject readme.");

    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();
  });

  afterAll(async () => { await store.close(); });

  test("get with qmd://collection/path", async () => {
    const doc = await store.get("qmd://docs/readme.md");
    expect("error" in doc).toBe(false);
  });

  test("get with collection/path (no scheme)", async () => {
    const doc = await store.get("docs/readme.md");
    expect("error" in doc).toBe(false);
  });

  test("get with bare filename finds document", async () => {
    const doc = await store.get("readme.md");
    expect("error" in doc).toBe(false);
  });

  test("get with nonexistent path returns not_found with suggestions", async () => {
    const doc = await store.get("docs/readmee.md");
    expect("error" in doc).toBe(true);
    if ("error" in doc) {
      expect(doc.error).toBe("not_found");
      expect(doc.similarFiles.length).toBeGreaterThan(0);
    }
  });

  test("multiGet with glob pattern", async () => {
    const { docs, errors } = await store.multiGet("docs/**/*.md", { includeBody: true });
    expect(docs.length).toBeGreaterThan(0);
    expect(errors.length).toBe(0);
  });

  test("multiGet with single docid", async () => {
    const doc = await store.get("docs/readme.md");
    expect("error" in doc).toBe(false);
    if (!("error" in doc)) {
      const { docs, errors } = await store.multiGet(`#${doc.docid}`, { includeBody: true });
      expect(docs.length).toBe(1);
      expect(errors.length).toBe(0);
    }
  });
});

// =============================================================================
// 10. Link integrity after mutations
// =============================================================================

describe("link integrity after mutations", () => {
  let store: QMDStore;
  let wikiDir: string;

  beforeAll(async () => {
    wikiDir = freshTestDir("links");
    await mkdir(wikiDir, { recursive: true });

    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { wiki: { path: wikiDir, pattern: "**/*.md", type: "wiki" } } },
    });
  });

  afterAll(async () => { await store.close(); });

  test("writeDocument creates forward links from wikilinks", async () => {
    await store.writeDocument("wiki", "concepts/a.md", "# Page A\n\nSee also [[Page B]] and [[Page C]].");
    const links = await store.getLinks("wiki/concepts/a.md", "forward", "wikilink");
    expect(links.forward.length).toBe(2);
    expect(links.forward.map(l => l.target)).toContain("Page B");
    expect(links.forward.map(l => l.target)).toContain("Page C");
  });

  test("writeDocument creates forward links from markdown links", async () => {
    await store.writeDocument("wiki", "concepts/b.md", "# Page B\n\nLink to [Page A](concepts/a.md).");
    const links = await store.getLinks("wiki/concepts/b.md", "forward", "markdown");
    expect(links.forward.length).toBe(1);
    expect(links.forward[0]!.target).toBe("concepts/a.md");
  });

  test("overwriting document updates links", async () => {
    await store.writeDocument("wiki", "concepts/a.md", "# Page A\n\nNow only links to [[Page D]].");
    const links = await store.getLinks("wiki/concepts/a.md", "forward", "wikilink");
    expect(links.forward.length).toBe(1);
    expect(links.forward[0]!.target).toBe("Page D");
  });

  test("backward links resolve via title match", async () => {
    await store.writeDocument("wiki", "concepts/c.md", "# Page C\n\nContent here.");
    await store.writeDocument("wiki", "concepts/referrer.md", "# Referrer\n\nLinks to [[Page C]].");

    const links = await store.getLinks("wiki/concepts/c.md", "backward", "wikilink");
    expect(links.backward.length).toBeGreaterThan(0);
    expect(links.backward.some(l => l.source.includes("referrer"))).toBe(true);
  });

  test("links inside code fences are not indexed", async () => {
    await store.writeDocument("wiki", "concepts/code.md",
      "# Code Example\n\n```\n[[fake link]]\n[not real](fake.md)\n```\n\n[[real link]]");
    const links = await store.getLinks("wiki/concepts/code.md", "forward");
    const targets = links.forward.map(l => l.target);
    expect(targets).not.toContain("fake link");
    expect(targets).not.toContain("fake.md");
    expect(targets).toContain("real link");
  });
});

// =============================================================================
// 11. Snippet extraction quality
// =============================================================================

describe("snippet extraction quality", () => {
  test("extractSnippet finds the most relevant lines", async () => {
    const { extractSnippet } = await import("../src/index.js");
    const body = "# Introduction\n\nThis is a general intro.\n\n## Machine Learning\n\nML is about training models.\n\n## Cooking\n\nHow to cook pasta.";
    const { snippet, line } = extractSnippet(body, "machine learning");
    expect(snippet).toContain("Machine Learning");
    expect(line).toBe(5); // line 5 is "## Machine Learning"
  });

  test("extractSnippet with intent steers to relevant section", async () => {
    const { extractSnippet } = await import("../src/index.js");
    const body = "# Overview\n\nGeneral info.\n\n## Performance\n\nPage load times are critical.\n\n## Performance\n\nAthletic performance metrics.";
    const result1 = extractSnippet(body, "performance", 500, undefined, undefined, "web page load times");
    expect(result1.snippet).toContain("load times");
  });

  test("extractSnippet with very short document", async () => {
    const { extractSnippet } = await import("../src/index.js");
    const body = "Short doc.";
    const { snippet } = extractSnippet(body, "short");
    expect(snippet).toBe("Short doc.");
  });

  test("extractSnippet with empty body returns empty snippet", async () => {
    const { extractSnippet } = await import("../src/index.js");
    const { snippet } = extractSnippet("", "query");
    expect(snippet).toBe("");
  });
});

// =============================================================================
// 12. Collection rename integrity
// =============================================================================

describe("collection rename integrity", () => {
  let store: QMDStore;
  let docsDir: string;

  beforeAll(async () => {
    docsDir = freshTestDir("rename-integrity");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "doc.md"), "# Test Doc\n\nSome content here.");

    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { alpha: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();
  });

  afterAll(async () => { await store.close(); });

  test("renamed collection documents are searchable under new name", async () => {
    await store.renameCollection("alpha", "beta");
    const results = await store.searchLex("test doc");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.collectionName).toBe("beta");
  });

  test("get works with new collection name", async () => {
    const doc = await store.get("beta/doc.md");
    expect("error" in doc).toBe(false);
  });

  test("get with old collection name returns not found", async () => {
    const doc = await store.get("qmd://alpha/doc.md");
    expect("error" in doc).toBe(true);
  });

  test("rename to existing name throws", async () => {
    await store.addCollection("gamma", { path: docsDir, pattern: "**/*.md" });
    await expect(store.renameCollection("beta", "gamma")).rejects.toThrow(/already exists/i);
  });

  test("rename nonexistent collection returns false", async () => {
    const result = await store.renameCollection("nonexistent", "newname");
    expect(result).toBe(false);
  });
});

// =============================================================================
// 13. Store lifecycle and re-open
// =============================================================================

describe("store lifecycle and re-open", () => {
  test("store can be closed and re-opened with same DB", async () => {
    const docsDir = freshTestDir("reopen");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "a.md"), "# Persistent\n\nThis should survive re-open.");

    const dbPath = freshDbPath();

    const store1 = await createStore({
      dbPath,
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store1.update();
    const results1 = await store1.searchLex("persistent");
    expect(results1.length).toBe(1);
    await store1.close();

    // Re-open without config (DB-only mode)
    const store2 = await createStore({ dbPath });
    const results2 = await store2.searchLex("persistent");
    expect(results2.length).toBe(1);
    await store2.close();
  });

  test("status reflects correct state after mutations", async () => {
    const docsDir = freshTestDir("status");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "a.md"), "# A");
    await writeFile(join(docsDir, "b.md"), "# B");

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();

    const status = await store.getStatus();
    expect(status.totalDocuments).toBe(2);
    expect(status.collections.length).toBe(1);
    expect(status.collections[0]!.documents).toBe(2);

    await store.close();
  });
});

// =============================================================================
// 14. Update idempotency
// =============================================================================

describe("update idempotency", () => {
  test("calling update twice with unchanged files is idempotent", async () => {
    const docsDir = freshTestDir("idempotent");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "a.md"), "# A\n\nContent A.");
    await writeFile(join(docsDir, "b.md"), "# B\n\nContent B.");

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });

    const result1 = await store.update();
    expect(result1.indexed).toBe(2);
    expect(result1.unchanged).toBe(0);

    const result2 = await store.update();
    expect(result2.indexed).toBe(0);
    expect(result2.unchanged).toBe(2);
    expect(result2.updated).toBe(0);

    await store.close();
  });

  test("update detects file changes", async () => {
    const docsDir = freshTestDir("detect-change");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "a.md"), "# Original\n\nOriginal content.");

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();

    // Modify file
    await writeFile(join(docsDir, "a.md"), "# Updated\n\nNew content.");
    const result = await store.update();
    expect(result.updated).toBe(1);

    // Verify new content is searchable
    const results = await store.searchLex("new content");
    expect(results.length).toBeGreaterThan(0);

    await store.close();
  });
});

// =============================================================================
// 15. FTS query edge cases
// =============================================================================

describe("FTS query edge cases", () => {
  let store: QMDStore;

  beforeAll(async () => {
    const docsDir = freshTestDir("fts-edge");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "special.md"), "# C++ Programming\n\nC++ uses templates and RAII.");
    await writeFile(join(docsDir, "numbers.md"), "# HTTP 404\n\nError 404 means page not found.");
    await writeFile(join(docsDir, "hyphens.md"), "# State-of-the-Art\n\nCutting-edge machine-learning.");

    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();
  });

  afterAll(async () => { await store.close(); });

  test("search with numbers works", async () => {
    const results = await store.searchLex("404");
    expect(results.length).toBeGreaterThan(0);
  });

  test("search with hyphenated terms works", async () => {
    const results = await store.searchLex("state-of-the-art");
    expect(results.length).toBeGreaterThan(0);
  });

  test("search with special characters doesn't crash", async () => {
    const results = await store.searchLex("C++");
    expect(Array.isArray(results)).toBe(true);
  });

  test("search with only special characters returns empty", async () => {
    const results = await store.searchLex("!@#$%");
    expect(results).toEqual([]);
  });
});
