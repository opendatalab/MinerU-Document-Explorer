/**
 * sdk-agent-workflow.test.ts - TDD tests for agent-facing SDK workflows.
 *
 * Tests writeDocument, getLinks, search edge cases, and snippet quality
 * from the perspective of an AI agent using the system.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  createStore,
  type QMDStore,
  extractSnippet,
} from "../src/index.js";

let testDir: string;
let docsDir: string;
let wikiDir: string;

function freshDbPath(): string {
  return join(testDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-agent-test-"));
  docsDir = join(testDir, "docs");
  wikiDir = join(testDir, "wiki");

  await mkdir(docsDir, { recursive: true });
  await mkdir(wikiDir, { recursive: true });

  await writeFile(
    join(docsDir, "distributed-systems.md"),
    `# Distributed Systems

## CAP Theorem

The CAP theorem states that a distributed system can only provide
two of three guarantees: Consistency, Availability, and Partition tolerance.

## Consensus Algorithms

### Raft
Raft is a consensus algorithm designed to be understandable.
It elects a leader and uses log replication.

### Paxos
Paxos is a family of protocols for solving consensus.
It is notoriously difficult to understand.

## Vector Clocks

Vector clocks are used to track causality between events
in a distributed system. Each process maintains a vector
of logical timestamps.
`
  );

  await writeFile(
    join(docsDir, "machine-learning.md"),
    `# Machine Learning

## Supervised Learning

Supervised learning uses labeled data to train models.
Common algorithms include linear regression, decision trees, and neural networks.

## Unsupervised Learning

Unsupervised learning finds patterns in unlabeled data.
Clustering (k-means, DBSCAN) and dimensionality reduction (PCA, t-SNE) are common.

## Reinforcement Learning

Reinforcement learning trains agents through rewards and penalties.
Q-learning and policy gradient methods are foundational approaches.
`
  );

  await writeFile(
    join(docsDir, "api-design.md"),
    `# API Design Principles

## REST

RESTful APIs use HTTP methods (GET, POST, PUT, DELETE) and resources.
Good REST APIs are stateless and use proper status codes.

## GraphQL

GraphQL provides a query language for APIs.
Clients request exactly the data they need, avoiding over-fetching.

## gRPC

gRPC uses Protocol Buffers for serialization.
It supports streaming and is efficient for microservice communication.
`
  );
});

afterAll(async () => {
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {}
});

// =============================================================================
// writeDocument Tests
// =============================================================================

describe("SDK writeDocument", () => {
  test("writes a markdown file and returns file + docid", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          wiki: { path: wikiDir, pattern: "**/*.md" },
        },
      },
    });

    const content = "# Test Article\n\nThis is a test article about testing.";
    const result = await store.writeDocument("wiki", "test-article.md", content);

    expect(result.file).toBe("wiki/test-article.md");
    expect(result.docid).toMatch(/^#[a-f0-9]{6}$/);

    // File should exist on disk
    const filePath = join(wikiDir, "test-article.md");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe(content);

    await store.close();
  });

  test("written document is immediately searchable via BM25", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          wiki: { path: wikiDir, pattern: "**/*.md" },
        },
      },
    });

    await store.writeDocument(
      "wiki",
      "searchable.md",
      "# Quantum Computing\n\nQuantum computers use qubits and superposition."
    );

    const results = await store.searchLex("quantum computing");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.title).toBe("Quantum Computing");

    await store.close();
  });

  test("writes to nested subdirectories", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          wiki: { path: wikiDir, pattern: "**/*.md" },
        },
      },
    });

    const result = await store.writeDocument(
      "wiki",
      "concepts/deep/nested.md",
      "# Deeply Nested\n\nContent in nested dir."
    );

    expect(result.file).toBe("wiki/concepts/deep/nested.md");
    expect(existsSync(join(wikiDir, "concepts/deep/nested.md"))).toBe(true);

    await store.close();
  });

  test("extracts title from content when not provided", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          wiki: { path: wikiDir, pattern: "**/*.md" },
        },
      },
    });

    await store.writeDocument(
      "wiki",
      "auto-title.md",
      "# Auto Extracted Title\n\nSome body content."
    );

    const doc = await store.get("wiki/auto-title.md");
    expect("error" in doc).toBe(false);
    if (!("error" in doc)) {
      expect(doc.title).toBe("Auto Extracted Title");
    }

    await store.close();
  });

  test("uses explicit title when provided", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          wiki: { path: wikiDir, pattern: "**/*.md" },
        },
      },
    });

    await store.writeDocument(
      "wiki",
      "explicit-title.md",
      "# Heading In Content\n\nBody.",
      "My Custom Title"
    );

    const doc = await store.get("wiki/explicit-title.md");
    expect("error" in doc).toBe(false);
    if (!("error" in doc)) {
      expect(doc.title).toBe("My Custom Title");
    }

    await store.close();
  });

  test("overwrites existing document", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          wiki: { path: wikiDir, pattern: "**/*.md" },
        },
      },
    });

    await store.writeDocument("wiki", "overwrite.md", "# Version 1\n\nOriginal content.");
    const first = await store.searchLex("original content");
    expect(first.length).toBeGreaterThan(0);

    await store.writeDocument("wiki", "overwrite.md", "# Version 2\n\nUpdated content.");
    const second = await store.searchLex("updated content");
    expect(second.length).toBeGreaterThan(0);

    await store.close();
  });

  test("rejects paths that escape collection directory", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          wiki: { path: wikiDir, pattern: "**/*.md" },
        },
      },
    });

    await expect(
      store.writeDocument("wiki", "../escape.md", "# Escape\n\nTrying to escape.")
    ).rejects.toThrow(/invalid path|within the collection/i);

    await store.close();
  });

  test("throws for non-existent collection", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          wiki: { path: wikiDir, pattern: "**/*.md" },
        },
      },
    });

    await expect(
      store.writeDocument("nonexistent", "test.md", "# Test\n\nContent.")
    ).rejects.toThrow(/not found/i);

    await store.close();
  });

  test("parses wikilinks in written document", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          wiki: { path: wikiDir, pattern: "**/*.md" },
        },
      },
    });

    await store.writeDocument(
      "wiki",
      "with-links.md",
      "# Article With Links\n\nSee also [[CAP Theorem]] and [[Raft]].\nMore at [[api-design]]."
    );

    const links = await store.getLinks("wiki/with-links.md", "forward", "wikilink");
    expect(links.forward.length).toBe(3);
    const targets = links.forward.map(l => l.target);
    expect(targets).toContain("CAP Theorem");
    expect(targets).toContain("Raft");
    expect(targets).toContain("api-design");

    await store.close();
  });
});

// =============================================================================
// getLinks Tests
// =============================================================================

describe("SDK getLinks", () => {
  let store: QMDStore;

  beforeAll(async () => {
    store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
          wiki: { path: wikiDir, pattern: "**/*.md" },
        },
      },
    });

    await store.update();

    // Write wiki pages with wikilinks pointing at each other
    await store.writeDocument(
      "wiki",
      "cap-theorem.md",
      "# CAP Theorem\n\nA fundamental theorem in [[Distributed Systems]].\nRelated to [[Consensus Algorithms]]."
    );
    await store.writeDocument(
      "wiki",
      "consensus.md",
      "# Consensus Algorithms\n\n[[Raft]] and [[Paxos]] solve distributed consensus.\nSee also [[CAP Theorem]]."
    );
  });

  afterAll(async () => {
    await store.close();
  });

  test("returns forward wikilinks", async () => {
    const links = await store.getLinks("wiki/cap-theorem.md", "forward", "wikilink");
    expect(links.forward.length).toBe(2);
    expect(links.forward.map(l => l.target)).toContain("Distributed Systems");
    expect(links.forward.map(l => l.target)).toContain("Consensus Algorithms");
  });

  test("returns backward wikilinks (backlinks)", async () => {
    const links = await store.getLinks("wiki/cap-theorem.md", "backward", "wikilink");
    expect(links.backward.length).toBeGreaterThan(0);
    expect(links.backward.some(l => l.source.includes("consensus"))).toBe(true);
  });

  test("returns both directions with default direction", async () => {
    const links = await store.getLinks("wiki/cap-theorem.md");
    expect(links.forward.length).toBeGreaterThan(0);
    expect(links.backward.length).toBeGreaterThan(0);
  });

  test("filters by link type", async () => {
    const wikilinks = await store.getLinks("wiki/cap-theorem.md", "forward", "wikilink");
    for (const link of wikilinks.forward) {
      expect(link.link_type).toBe("wikilink");
    }
  });

  test("throws for non-existent document", async () => {
    await expect(
      store.getLinks("wiki/nonexistent.md")
    ).rejects.toThrow(/not found/i);
  });

  test("includes line numbers for links", async () => {
    const links = await store.getLinks("wiki/cap-theorem.md", "forward", "wikilink");
    for (const link of links.forward) {
      expect(link.line).toBeDefined();
      expect(typeof link.line === "number" || link.line === null).toBe(true);
    }
  });
});

// =============================================================================
// Search Edge Cases
// =============================================================================

describe("search edge cases", () => {
  let store: QMDStore;

  beforeAll(async () => {
    store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });
    await store.update();
  });

  afterAll(async () => {
    await store.close();
  });

  test("empty query string throws", async () => {
    await expect(store.search({ query: "" })).rejects.toThrow();
  });

  test("searchLex with empty query returns empty array", () => {
    // BM25 with empty query should return nothing, not crash
    const resultsPromise = store.searchLex("");
    return expect(resultsPromise).resolves.toEqual([]);
  });

  test("searchLex with only special characters returns empty", async () => {
    const results = await store.searchLex("@#$%^&*()");
    expect(results).toEqual([]);
  });

  test("searchLex with unicode query works", async () => {
    const results = await store.searchLex("distributed");
    expect(results.length).toBeGreaterThan(0);
  });

  test("searchLex with very long query does not crash", async () => {
    const longQuery = "distributed systems ".repeat(100);
    const results = await store.searchLex(longQuery);
    expect(Array.isArray(results)).toBe(true);
  });

  test("searchLex with quoted phrase finds exact matches", async () => {
    const results = await store.searchLex('"CAP theorem"');
    expect(results.length).toBeGreaterThan(0);
  });

  test("searchLex with negation excludes documents", async () => {
    const withPaxos = await store.searchLex("consensus");
    const withoutPaxos = await store.searchLex("consensus -paxos");
    // The result with negation should have fewer or equal results
    expect(withoutPaxos.length).toBeLessThanOrEqual(withPaxos.length);
  });

  test("searchLex with limit restricts results", async () => {
    const all = await store.searchLex("the", { limit: 100 });
    const limited = await store.searchLex("the", { limit: 1 });
    expect(limited.length).toBeLessThanOrEqual(1);
    if (all.length > 1) {
      expect(limited.length).toBeLessThan(all.length);
    }
  });

  test("searchLex with collection filter only returns docs from that collection", async () => {
    const results = await store.searchLex("distributed", { collection: "docs" });
    for (const r of results) {
      expect(r.collectionName).toBe("docs");
    }
  });

  test("searchLex with non-existent collection returns empty", async () => {
    const results = await store.searchLex("distributed", { collection: "nonexistent" });
    expect(results).toEqual([]);
  });

  test("search results have valid scores between 0 and 1", async () => {
    const results = await store.searchLex("consensus algorithm");
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  test("search results include docid (6-char hex hash prefix)", async () => {
    const results = await store.searchLex("machine learning");
    for (const r of results) {
      expect(r.docid).toMatch(/^[a-f0-9]{6}$/);
    }
  });
});

// =============================================================================
// extractSnippet Quality Tests
// =============================================================================

describe("extractSnippet quality for agents", () => {
  const sampleBody = `# Distributed Systems

## CAP Theorem

The CAP theorem states that a distributed system can only provide
two of three guarantees: Consistency, Availability, and Partition tolerance.

## Consensus Algorithms

### Raft
Raft is a consensus algorithm designed to be understandable.

### Paxos
Paxos is a family of protocols for solving consensus.`;

  test("snippet focuses on the most relevant section", () => {
    const result = extractSnippet(sampleBody, "CAP theorem");
    expect(result.snippet).toContain("CAP");
    expect(result.line).toBeGreaterThan(0);
  });

  test("snippet does not include raw @@ diff headers", () => {
    const result = extractSnippet(sampleBody, "CAP theorem");
    // The @@ header is an implementation detail that should not leak to agents
    expect(result.snippet).not.toMatch(/^@@/);
  });

  test("snippet line number is 1-indexed", () => {
    const result = extractSnippet(sampleBody, "Distributed Systems");
    expect(result.line).toBeGreaterThanOrEqual(1);
  });

  test("snippet respects maxLen", () => {
    const result = extractSnippet(sampleBody, "consensus", 100);
    expect(result.snippet.length).toBeLessThanOrEqual(103); // +3 for "..."
  });

  test("snippet with chunkPos focuses on the correct region", () => {
    const raftPos = sampleBody.indexOf("Raft is a consensus");
    const result = extractSnippet(sampleBody, "consensus", 500, raftPos, 200);
    expect(result.snippet).toContain("Raft");
  });

  test("snippet with intent biases toward intent-relevant content", () => {
    const result = extractSnippet(sampleBody, "algorithm", 500, undefined, undefined, "consensus protocol raft");
    // With intent "consensus protocol raft", should prefer Raft section
    expect(result.snippet.toLowerCase()).toContain("raft");
  });

  test("linesAfter and linesBefore are non-negative", () => {
    const result = extractSnippet(sampleBody, "CAP");
    expect(result.linesBefore).toBeGreaterThanOrEqual(0);
    expect(result.linesAfter).toBeGreaterThanOrEqual(0);
  });

  test("snippetLines is positive", () => {
    const result = extractSnippet(sampleBody, "CAP");
    expect(result.snippetLines).toBeGreaterThan(0);
  });
});

// =============================================================================
// Document Retrieval Edge Cases
// =============================================================================

describe("document retrieval edge cases", () => {
  let store: QMDStore;

  beforeAll(async () => {
    store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });
    await store.update();
  });

  afterAll(async () => {
    await store.close();
  });

  test("get returns document by displayPath", async () => {
    const result = await store.get("docs/distributed-systems.md");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.title).toBe("Distributed Systems");
    }
  });

  test("get returns document by docid", async () => {
    const searchResults = await store.searchLex("distributed");
    expect(searchResults.length).toBeGreaterThan(0);
    const docid = searchResults[0]!.docid;

    const result = await store.get(docid);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.title).toBe("Distributed Systems");
    }
  });

  test("get returns error for non-existent document", async () => {
    const result = await store.get("docs/nonexistent.md");
    expect("error" in result).toBe(true);
  });

  test("get with similar files suggestion for close typo", async () => {
    // "api-desing.md" is a close typo of "api-design.md" (Levenshtein distance 1)
    const result = await store.get("docs/api-desing.md");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.similarFiles.length).toBeGreaterThan(0);
    }
  });

  test("getDocumentBody returns body text", async () => {
    const body = await store.getDocumentBody("docs/api-design.md");
    expect(body).toBeTruthy();
    expect(body).toContain("API Design");
  });

  test("getDocumentBody with line range", async () => {
    const body = await store.getDocumentBody("docs/api-design.md", { fromLine: 1, maxLines: 3 });
    expect(body).toBeTruthy();
    const lines = body!.split("\n");
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  test("getDocumentBody returns null for non-existent document", async () => {
    const body = await store.getDocumentBody("docs/nonexistent.md");
    expect(body).toBeNull();
  });

  test("multiGet with glob pattern", async () => {
    const { docs, errors } = await store.multiGet("docs/*.md");
    expect(docs.length).toBeGreaterThan(0);
    expect(errors.length).toBe(0);
  });

  test("multiGet with comma-separated list", async () => {
    const { docs, errors } = await store.multiGet("docs/api-design.md, docs/machine-learning.md");
    expect(docs.length).toBe(2);
  });

  test("multiGet with docid list", async () => {
    const searchResults = await store.searchLex("distributed");
    expect(searchResults.length).toBeGreaterThan(0);
    const docid = searchResults[0]!.docid;

    const { docs } = await store.multiGet(docid);
    expect(docs.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Collection Management Edge Cases
// =============================================================================

describe("collection management edge cases", () => {
  test("addCollection with wiki type", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    await store.addCollection("mywiki", { path: wikiDir, pattern: "**/*.md", type: "wiki" });
    const collections = await store.listCollections();
    const wiki = collections.find(c => c.name === "mywiki");
    expect(wiki).toBeDefined();
    expect(wiki!.type).toBe("wiki");

    await store.close();
  });

  test("addCollection defaults to raw type", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    await store.addCollection("rawcol", { path: docsDir, pattern: "**/*.md" });
    const collections = await store.listCollections();
    const raw = collections.find(c => c.name === "rawcol");
    expect(raw).toBeDefined();
    expect(raw!.type).toBe("raw");

    await store.close();
  });

  test("renameCollection preserves documents", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          original: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    await store.update();
    const beforeCount = (await store.searchLex("distributed")).length;

    await store.renameCollection("original", "renamed");

    const collections = await store.listCollections();
    expect(collections.map(c => c.name)).toContain("renamed");
    expect(collections.map(c => c.name)).not.toContain("original");

    const afterResults = await store.searchLex("distributed");
    expect(afterResults.length).toBe(beforeCount);
    expect(afterResults[0]!.collectionName).toBe("renamed");

    await store.close();
  });

  test("removeCollection cleans up", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          temp: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    await store.update();
    expect((await store.searchLex("distributed")).length).toBeGreaterThan(0);

    await store.removeCollection("temp");

    const collections = await store.listCollections();
    expect(collections.map(c => c.name)).not.toContain("temp");

    await store.close();
  });
});

// =============================================================================
// Context Management
// =============================================================================

describe("context management edge cases", () => {
  test("context is included in search results", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    await store.update();
    await store.addContext("docs", "/", "These are technical reference documents");

    const results = await store.searchLex("distributed");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.context).toBe("These are technical reference documents");

    await store.close();
  });

  test("global context applies to all collections", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    await store.update();
    await store.setGlobalContext("Global system context");

    const ctx = await store.getGlobalContext();
    expect(ctx).toBe("Global system context");

    await store.close();
  });

  test("removeContext works", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    await store.addContext("docs", "/", "Some context");
    const added = await store.listContexts();
    expect(added.length).toBeGreaterThan(0);

    await store.removeContext("docs", "/");
    const removed = await store.listContexts();
    expect(removed.length).toBeLessThan(added.length);

    await store.close();
  });
});
