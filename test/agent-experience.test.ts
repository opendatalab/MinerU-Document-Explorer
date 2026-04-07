/**
 * agent-experience.test.ts — TDD tests from the perspective of a strong AI agent.
 *
 * These tests simulate real agent workflows and edge cases that matter
 * when using MinerU Document Explorer as a knowledge engine. Each describe block targets
 * a specific agent pain point discovered during experience testing.
 *
 * Bug-hunting strategy: write the test FIRST (TDD), expect it to fail,
 * then fix the underlying code.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
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

  await writeFile(join(dir, "architecture.md"), `# System Architecture

## Microservices

The system uses a microservice architecture with event-driven communication.
Each service is independently deployable and uses its own database.

## API Gateway

The API gateway handles authentication, rate limiting, and request routing.
It supports both REST and GraphQL protocols.

## Message Queue

RabbitMQ handles asynchronous inter-service communication.
Dead letter queues handle failed message processing.
`);

  await writeFile(join(dir, "security.md"), `# Security Best Practices

## Authentication

OAuth2 and JWT tokens are used for API authentication.
Multi-factor authentication is required for admin access.

## Authorization

Role-based access control (RBAC) with hierarchical permissions.
API endpoints are protected by scope-based authorization.

## Encryption

All data is encrypted at rest (AES-256) and in transit (TLS 1.3).
Database-level encryption uses transparent data encryption (TDE).
`);

  await writeFile(join(dir, "deployment.md"), `# Deployment Guide

## CI/CD Pipeline

GitHub Actions runs tests, builds Docker images, and deploys to Kubernetes.
Blue-green deployments minimize downtime during releases.

## Infrastructure

Terraform manages cloud infrastructure as code.
AWS EKS hosts the Kubernetes clusters across three availability zones.

## Monitoring

Prometheus and Grafana provide metrics and alerting.
Distributed tracing with OpenTelemetry tracks request flows.
`);
}

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "qmd-agent-exp-"));
});

afterAll(async () => {
  try { await rm(rootDir, { recursive: true, force: true }); } catch {}
});

// =============================================================================
// 1. Store lifecycle — open, close, reopen, verify persistence
// =============================================================================

describe("store lifecycle and persistence", () => {
  test("documents persist after close and reopen", async () => {
    const docsDir = freshTestDir("persist-docs");
    await seedDocs(docsDir);
    const dbPath = freshDbPath();

    // First session: create store, index documents
    const store1 = await createStore({
      dbPath,
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store1.update();
    const initialResults = await store1.searchLex("microservices");
    expect(initialResults.length).toBeGreaterThan(0);
    await store1.close();

    // Second session: reopen same DB, verify documents are still there
    const store2 = await createStore({ dbPath });
    const persistedResults = await store2.searchLex("microservices");
    expect(persistedResults.length).toBe(initialResults.length);
    expect(persistedResults[0]!.title).toBe(initialResults[0]!.title);
    await store2.close();
  });

  test("written documents persist across sessions", async () => {
    const wikiDir = freshTestDir("persist-wiki");
    await mkdir(wikiDir, { recursive: true });
    const dbPath = freshDbPath();

    const store1 = await createStore({
      dbPath,
      config: { collections: { wiki: { path: wikiDir, pattern: "**/*.md", type: "wiki" } } },
    });
    await store1.writeDocument("wiki", "note.md", "# Important Note\n\nDon't forget this.");
    const written = await store1.searchLex("important note");
    expect(written.length).toBeGreaterThan(0);
    await store1.close();

    const store2 = await createStore({ dbPath });
    const found = await store2.searchLex("important note");
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.title).toBe("Important Note");
    await store2.close();
  });

  test("status is accurate after reopen", async () => {
    const docsDir = freshTestDir("status-reopen");
    await seedDocs(docsDir);
    const dbPath = freshDbPath();

    const store1 = await createStore({
      dbPath,
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store1.update();
    const status1 = await store1.getStatus();
    await store1.close();

    const store2 = await createStore({ dbPath });
    const status2 = await store2.getStatus();
    expect(status2.totalDocuments).toBe(status1.totalDocuments);
    await store2.close();
  });
});

// =============================================================================
// 2. Collection removal — documents must become unsearchable
// =============================================================================

describe("collection removal cleanup", () => {
  test("removed collection documents are no longer searchable", async () => {
    const docsDir = freshTestDir("remove-search");
    await seedDocs(docsDir);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();

    const beforeRemove = await store.searchLex("microservices");
    expect(beforeRemove.length).toBeGreaterThan(0);

    await store.removeCollection("docs");

    const afterRemove = await store.searchLex("microservices");
    expect(afterRemove).toEqual([]);

    await store.close();
  });

  test("removed collection does not appear in status", async () => {
    const docsDir = freshTestDir("remove-status");
    await seedDocs(docsDir);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();

    const statusBefore = await store.getStatus();
    expect(statusBefore.totalDocuments).toBe(3);

    await store.removeCollection("docs");

    const statusAfter = await store.getStatus();
    expect(statusAfter.totalDocuments).toBe(0);
    const collNames = statusAfter.collections.map((c: { name: string }) => c.name);
    expect(collNames).not.toContain("docs");

    await store.close();
  });

  test("removed collection docs cannot be retrieved by get", async () => {
    const docsDir = freshTestDir("remove-get");
    await seedDocs(docsDir);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();

    const before = await store.get("docs/architecture.md");
    expect("error" in before).toBe(false);

    await store.removeCollection("docs");

    const after = await store.get("docs/architecture.md");
    expect("error" in after).toBe(true);

    await store.close();
  });

  test("removed collection links are cleaned up", async () => {
    const wikiDir = freshTestDir("remove-links");
    await mkdir(wikiDir, { recursive: true });

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { wiki: { path: wikiDir, pattern: "**/*.md", type: "wiki" } } },
    });

    await store.writeDocument("wiki", "page.md", "# Page\n\nLinks to [[Other]] and [[Target]].");
    const links = await store.getLinks("wiki/page.md", "forward");
    expect(links.forward.length).toBe(2);

    await store.removeCollection("wiki");

    // Links should be gone — no orphan link data
    const db = store.internal.db;
    const remainingLinks = db.prepare(`SELECT COUNT(*) as c FROM links WHERE source LIKE 'wiki/%'`).get() as { c: number };
    expect(remainingLinks.c).toBe(0);

    await store.close();
  });

  test("removing one collection does not affect another", async () => {
    const docsDir1 = freshTestDir("remove-multi-1");
    const docsDir2 = freshTestDir("remove-multi-2");
    await seedDocs(docsDir1);
    await seedDocs(docsDir2);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          alpha: { path: docsDir1, pattern: "**/*.md" },
          beta: { path: docsDir2, pattern: "**/*.md" },
        },
      },
    });
    await store.update();

    await store.removeCollection("alpha");

    const betaResults = await store.searchLex("microservices", { collection: "beta" });
    expect(betaResults.length).toBeGreaterThan(0);

    const alphaResults = await store.searchLex("microservices", { collection: "alpha" });
    expect(alphaResults).toEqual([]);

    await store.close();
  });
});

// =============================================================================
// 3. Document lifecycle — write, overwrite, search consistency
// =============================================================================

describe("document lifecycle consistency", () => {
  test("overwritten document shows new content in search, not old", async () => {
    const wikiDir = freshTestDir("lifecycle-wiki");
    await mkdir(wikiDir, { recursive: true });

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { wiki: { path: wikiDir, pattern: "**/*.md" } } },
    });

    await store.writeDocument("wiki", "topic.md", "# Elephants\n\nElephants are the largest land animals.");
    const v1 = await store.searchLex("elephants");
    expect(v1.length).toBeGreaterThan(0);

    await store.writeDocument("wiki", "topic.md", "# Dolphins\n\nDolphins are intelligent marine mammals.");
    const v2search = await store.searchLex("dolphins");
    expect(v2search.length).toBeGreaterThan(0);

    const staleSearch = await store.searchLex("elephants");
    expect(staleSearch).toEqual([]);

    await store.close();
  });

  test("writeDocument then update() does not create duplicates", async () => {
    const wikiDir = freshTestDir("no-dup");
    await mkdir(wikiDir, { recursive: true });

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { wiki: { path: wikiDir, pattern: "**/*.md" } } },
    });

    await store.writeDocument("wiki", "unique.md", "# Unique Content\n\nThis should appear once.");
    await store.update();

    const results = await store.searchLex("unique content");
    expect(results.length).toBe(1);

    await store.close();
  });

  test("multiple writes to different files are all searchable", async () => {
    const wikiDir = freshTestDir("multi-write");
    await mkdir(wikiDir, { recursive: true });

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { wiki: { path: wikiDir, pattern: "**/*.md" } } },
    });

    await store.writeDocument("wiki", "a.md", "# Alpha Article\n\nAlpha content about testing.");
    await store.writeDocument("wiki", "b.md", "# Beta Article\n\nBeta content about quality.");
    await store.writeDocument("wiki", "c.md", "# Gamma Article\n\nGamma content about reliability.");

    const all = await store.searchLex("article");
    expect(all.length).toBe(3);

    await store.close();
  });

  test("writeDocument returns consistent docid", async () => {
    const wikiDir = freshTestDir("docid-consistent");
    await mkdir(wikiDir, { recursive: true });

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { wiki: { path: wikiDir, pattern: "**/*.md" } } },
    });

    const content = "# Docid Test\n\nSame content produces same docid.";
    const r1 = await store.writeDocument("wiki", "docid-test.md", content);
    const doc = await store.get(r1.docid);
    expect("error" in doc).toBe(false);
    if (!("error" in doc)) {
      expect(doc.docid).toBe(r1.docid.replace("#", ""));
    }

    await store.close();
  });
});

// =============================================================================
// 4. getDocumentBody edge cases
// =============================================================================

describe("getDocumentBody edge cases", () => {
  let store: QMDStore;
  let docsDir: string;

  beforeAll(async () => {
    docsDir = freshTestDir("body-edge");
    await seedDocs(docsDir);
    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();
  });

  afterAll(async () => { await store.close(); });

  test("fromLine=1 returns from the first line", async () => {
    const body = await store.getDocumentBody("docs/architecture.md", { fromLine: 1, maxLines: 1 });
    expect(body).toBeTruthy();
    expect(body!.trim()).toBe("# System Architecture");
  });

  test("maxLines=0 returns empty string", async () => {
    const body = await store.getDocumentBody("docs/architecture.md", { fromLine: 1, maxLines: 0 });
    expect(body).toBe("");
  });

  test("fromLine beyond document length returns empty", async () => {
    const body = await store.getDocumentBody("docs/architecture.md", { fromLine: 9999 });
    expect(body).toBe("");
  });

  test("maxLines larger than document returns full body", async () => {
    const full = await store.getDocumentBody("docs/architecture.md");
    const sliced = await store.getDocumentBody("docs/architecture.md", { maxLines: 9999 });
    expect(sliced).toBe(full);
  });

  test("fromLine without maxLines returns rest of document", async () => {
    const full = await store.getDocumentBody("docs/architecture.md");
    const fromLine3 = await store.getDocumentBody("docs/architecture.md", { fromLine: 3 });
    const expectedLines = full!.split("\n").slice(2).join("\n");
    expect(fromLine3).toBe(expectedLines);
  });

  test("body retrieval by docid", async () => {
    const results = await store.searchLex("microservices");
    const docid = results[0]!.docid;
    const body = await store.getDocumentBody(docid);
    expect(body).toBeTruthy();
    expect(body).toContain("microservice");
  });
});

// =============================================================================
// 5. Rename collection — search, get, links all work with new name
// =============================================================================

describe("rename collection full consistency", () => {
  test("search results use new collection name after rename", async () => {
    const docsDir = freshTestDir("rename-search");
    await seedDocs(docsDir);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { old: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();

    await store.renameCollection("old", "new");

    const results = await store.searchLex("microservices");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.collectionName).toBe("new");
    expect(results[0]!.filepath).toContain("new/");
    expect(results[0]!.filepath).not.toContain("old/");

    await store.close();
  });

  test("get works with new collection name after rename", async () => {
    const docsDir = freshTestDir("rename-get");
    await seedDocs(docsDir);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { alpha: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();
    await store.renameCollection("alpha", "beta");

    const result = await store.get("beta/architecture.md");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.collectionName).toBe("beta");
    }

    // Old name should not work
    const oldResult = await store.get("alpha/architecture.md");
    expect("error" in oldResult).toBe(true);

    await store.close();
  });

  test("collection filter works with new name after rename", async () => {
    const docsDir = freshTestDir("rename-filter");
    await seedDocs(docsDir);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { before: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();
    await store.renameCollection("before", "after");

    const withNew = await store.searchLex("microservices", { collection: "after" });
    expect(withNew.length).toBeGreaterThan(0);

    const withOld = await store.searchLex("microservices", { collection: "before" });
    expect(withOld).toEqual([]);

    await store.close();
  });

  test("multiGet with new collection name works after rename", async () => {
    const docsDir = freshTestDir("rename-multiget");
    await seedDocs(docsDir);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { src: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();
    await store.renameCollection("src", "dst");

    const { docs, errors } = await store.multiGet("dst/*.md");
    expect(docs.length).toBe(3);
    expect(errors.length).toBe(0);

    await store.close();
  });

  test("links source updated after rename", async () => {
    const docsDir = freshTestDir("rename-links");
    const wikiDir = freshTestDir("rename-wiki");
    await mkdir(docsDir, { recursive: true });
    await mkdir(wikiDir, { recursive: true });

    await writeFile(join(wikiDir, "page.md"), "# Page\n\nLinks to [[Architecture]] and [[Security]].");

    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          mywiki: { path: wikiDir, pattern: "**/*.md", type: "wiki" },
        },
      },
    });
    await store.update();

    const linksBefore = await store.getLinks("mywiki/page.md", "forward");
    expect(linksBefore.forward.length).toBe(2);

    await store.renameCollection("mywiki", "newwiki");

    const linksAfter = await store.getLinks("newwiki/page.md", "forward");
    expect(linksAfter.forward.length).toBe(2);
    expect(linksAfter.file).toContain("newwiki");

    await store.close();
  });
});

// =============================================================================
// 6. Multi-collection search and dedup
// =============================================================================

describe("multi-collection search", () => {
  test("collection filter restricts results correctly", async () => {
    const dir1 = freshTestDir("multi-a");
    const dir2 = freshTestDir("multi-b");
    await seedDocs(dir1);
    await mkdir(dir2, { recursive: true });
    await writeFile(join(dir2, "other.md"), "# Other Topic\n\nCompletely different content about gardening.");

    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          tech: { path: dir1, pattern: "**/*.md" },
          hobby: { path: dir2, pattern: "**/*.md" },
        },
      },
    });
    await store.update();

    const techOnly = await store.searchLex("microservices", { collection: "tech" });
    for (const r of techOnly) {
      expect(r.collectionName).toBe("tech");
    }

    const hobbyOnly = await store.searchLex("gardening", { collection: "hobby" });
    expect(hobbyOnly.length).toBeGreaterThan(0);
    for (const r of hobbyOnly) {
      expect(r.collectionName).toBe("hobby");
    }

    await store.close();
  });

  test("search without collection filter returns results from all collections", async () => {
    const dir1 = freshTestDir("all-a");
    const dir2 = freshTestDir("all-b");
    await mkdir(dir1, { recursive: true });
    await mkdir(dir2, { recursive: true });
    await writeFile(join(dir1, "a.md"), "# Doc A\n\nShared keyword: optimization.");
    await writeFile(join(dir2, "b.md"), "# Doc B\n\nShared keyword: optimization strategy.");

    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          col1: { path: dir1, pattern: "**/*.md" },
          col2: { path: dir2, pattern: "**/*.md" },
        },
      },
    });
    await store.update();

    const results = await store.searchLex("optimization");
    expect(results.length).toBe(2);
    const collNames = results.map(r => r.collectionName);
    expect(collNames).toContain("col1");
    expect(collNames).toContain("col2");

    await store.close();
  });
});

// =============================================================================
// 7. Context inheritance and management
// =============================================================================

describe("context inheritance", () => {
  test("path-specific context overrides collection-level context", async () => {
    const docsDir = freshTestDir("ctx-inherit");
    await mkdir(join(docsDir, "guides"), { recursive: true });
    await writeFile(join(docsDir, "guides", "setup.md"), "# Setup Guide\n\nHow to set up the system.");
    await writeFile(join(docsDir, "readme.md"), "# Root Readme\n\nGeneral overview.");

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();

    await store.addContext("docs", "/", "Technical documentation");
    await store.addContext("docs", "/guides", "Step-by-step setup guides");

    const guideResults = await store.searchLex("setup");
    expect(guideResults.length).toBeGreaterThan(0);
    const guideCtx = guideResults[0]!.context;
    expect(guideCtx).toContain("Technical documentation");
    expect(guideCtx).toContain("Step-by-step setup guides");

    await store.close();
  });

  test("global context combines with collection context", async () => {
    const docsDir = freshTestDir("ctx-global");
    await seedDocs(docsDir);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();

    await store.setGlobalContext("This is a knowledge base for an engineering team");
    await store.addContext("docs", "/", "Architecture and security documentation");

    const results = await store.searchLex("microservices");
    expect(results.length).toBeGreaterThan(0);
    const ctx = results[0]!.context;
    expect(ctx).toContain("knowledge base");
    expect(ctx).toContain("Architecture and security");

    await store.close();
  });

  test("listContexts returns all contexts", async () => {
    const docsDir = freshTestDir("ctx-list");
    await seedDocs(docsDir);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });

    await store.setGlobalContext("Global context");
    await store.addContext("docs", "/", "Root context");
    await store.addContext("docs", "/guides", "Guides context");

    const contexts = await store.listContexts();
    expect(contexts.length).toBe(3);

    const paths = contexts.map(c => `${c.collection}:${c.path}`);
    expect(paths).toContain("*:/");
    expect(paths).toContain("docs:/");
    expect(paths).toContain("docs:/guides");

    await store.close();
  });

  test("removeContext actually removes it from search results", async () => {
    const docsDir = freshTestDir("ctx-remove");
    await seedDocs(docsDir);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();

    await store.addContext("docs", "/", "Important context to show");
    let results = await store.searchLex("microservices");
    expect(results[0]!.context).toBe("Important context to show");

    await store.removeContext("docs", "/");
    results = await store.searchLex("microservices");
    expect(results[0]!.context).toBeNull();

    await store.close();
  });
});

// =============================================================================
// 8. Update idempotency and consistency
// =============================================================================

describe("update idempotency", () => {
  test("multiple update() calls produce same result", async () => {
    const docsDir = freshTestDir("idempotent");
    await seedDocs(docsDir);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });

    const result1 = await store.update();
    expect(result1.indexed).toBe(3);

    const result2 = await store.update();
    expect(result2.unchanged).toBe(3);
    expect(result2.indexed).toBe(0);

    const status = await store.getStatus();
    expect(status.totalDocuments).toBe(3);

    await store.close();
  });

  test("update() after file modification detects change", async () => {
    const docsDir = freshTestDir("update-modify");
    await seedDocs(docsDir);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });

    await store.update();

    // Modify a file
    await writeFile(join(docsDir, "architecture.md"), "# Updated Architecture\n\nNew content about serverless.");

    const result = await store.update();
    expect(result.updated).toBe(1);

    const search = await store.searchLex("serverless");
    expect(search.length).toBeGreaterThan(0);

    await store.close();
  });

  test("update() after file deletion deactivates document", async () => {
    const docsDir = freshTestDir("update-delete");
    await seedDocs(docsDir);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });

    await store.update();
    expect((await store.getStatus()).totalDocuments).toBe(3);

    // Delete a file
    await rm(join(docsDir, "deployment.md"));

    const result = await store.update();
    expect(result.removed).toBe(1);

    const status = await store.getStatus();
    expect(status.totalDocuments).toBe(2);

    await store.close();
  });

  test("update() with progress callback fires for each file", async () => {
    const docsDir = freshTestDir("update-progress");
    await seedDocs(docsDir);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });

    const progressCalls: { collection: string; file: string; current: number; total: number }[] = [];
    await store.update({
      onProgress: (info) => progressCalls.push(info),
    });

    expect(progressCalls.length).toBe(3);
    for (const p of progressCalls) {
      expect(p.collection).toBe("docs");
      expect(p.total).toBe(3);
    }
    expect(progressCalls.map(p => p.current).sort()).toEqual([1, 2, 3]);

    await store.close();
  });
});

// =============================================================================
// 9. Error handling — clean, actionable messages for agents
// =============================================================================

describe("error handling for agents", () => {
  test("search with no query and no queries throws clear error", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    await expect(store.search({})).rejects.toThrow(/query/i);
    await store.close();
  });

  test("writeDocument to removed collection throws clear error", async () => {
    const wikiDir = freshTestDir("err-write");
    await mkdir(wikiDir, { recursive: true });

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { wiki: { path: wikiDir, pattern: "**/*.md" } } },
    });
    await store.removeCollection("wiki");

    await expect(
      store.writeDocument("wiki", "test.md", "# Test")
    ).rejects.toThrow(/not found/i);

    await store.close();
  });

  test("getLinks on non-existent file throws with helpful message", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    await expect(
      store.getLinks("nonexistent/file.md")
    ).rejects.toThrow(/not found/i);

    await store.close();
  });

  test("renameCollection to existing name throws clear error", async () => {
    const dir1 = freshTestDir("err-rename-1");
    const dir2 = freshTestDir("err-rename-2");
    await seedDocs(dir1);
    await seedDocs(dir2);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          first: { path: dir1, pattern: "**/*.md" },
          second: { path: dir2, pattern: "**/*.md" },
        },
      },
    });

    await expect(
      store.renameCollection("first", "second")
    ).rejects.toThrow(/already exists/i);

    await store.close();
  });

  test("get with empty string returns not_found", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    const result = await store.get("");
    expect("error" in result).toBe(true);

    await store.close();
  });
});

// =============================================================================
// 10. Search quality — BM25 scoring makes sense for agents
// =============================================================================

describe("search quality for agents", () => {
  let store: QMDStore;

  beforeAll(async () => {
    const docsDir = freshTestDir("quality");
    await seedDocs(docsDir);
    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();
  });

  afterAll(async () => { await store.close(); });

  test("exact keyword match produces highest score", async () => {
    const results = await store.searchLex("microservices");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.score).toBeGreaterThan(0);
    // The architecture doc has "microservice" in title/body — should be the top hit
    expect(results[0]!.title).toBe("System Architecture");
  });

  test("results are sorted by score descending", async () => {
    const results = await store.searchLex("security authentication encryption");
    if (results.length > 1) {
      for (let i = 1; i < results.length; i++) {
        expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
      }
    }
  });

  test("quoted phrase search is more specific", async () => {
    const broad = await store.searchLex("access control");
    const exact = await store.searchLex('"access control"');
    // Exact phrase should match fewer or equal documents
    expect(exact.length).toBeLessThanOrEqual(broad.length);
  });

  test("negation excludes relevant documents", async () => {
    const withAuth = await store.searchLex("authentication");
    const withoutOAuth = await store.searchLex("authentication -OAuth2");
    if (withAuth.length > 0 && withAuth.some(r => r.body?.includes("OAuth2"))) {
      expect(withoutOAuth.length).toBeLessThan(withAuth.length);
    }
  });

  test("snippet focuses on query-relevant section", () => {
    const body = `# Large Document

## Introduction
This is a general introduction about many topics.

## Database Design
The database uses PostgreSQL with read replicas.

## API Rate Limiting
Rate limiting prevents abuse by capping requests per second.
Token bucket algorithm implementation details.

## Conclusion
Summary of all topics discussed.`;

    const snippet = extractSnippet(body, "rate limiting");
    expect(snippet.snippet.toLowerCase()).toContain("rate limiting");
    expect(snippet.line).toBeGreaterThan(5);
  });
});

// =============================================================================
// 11. WriteDocument with wikilinks — cross-file linking agent workflow
// =============================================================================

describe("wikilink agent workflow", () => {
  test("wikilinks create forward links that getLinks can retrieve", async () => {
    const wikiDir = freshTestDir("wikilinks");
    await mkdir(wikiDir, { recursive: true });

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { wiki: { path: wikiDir, pattern: "**/*.md", type: "wiki" } } },
    });

    await store.writeDocument("wiki", "index.md", `# Index
See [[Architecture Overview]], [[Security Guide]], and [[Deployment]].`);

    await store.writeDocument("wiki", "architecture.md", `# Architecture Overview
The system uses [[Microservices]] pattern.
See also [[Security Guide]].`);

    await store.writeDocument("wiki", "security.md", `# Security Guide
Implements [[OAuth2]] and [[RBAC]].
Related to [[Architecture Overview]].`);

    // Forward links from index
    const indexLinks = await store.getLinks("wiki/index.md", "forward", "wikilink");
    expect(indexLinks.forward.length).toBe(3);

    // Backward links to security guide (referenced by index and architecture)
    const securityLinks = await store.getLinks("wiki/security.md", "backward", "wikilink");
    expect(securityLinks.backward.length).toBeGreaterThanOrEqual(1);

    await store.close();
  });

  test("overwriting a document updates its links", async () => {
    const wikiDir = freshTestDir("link-update");
    await mkdir(wikiDir, { recursive: true });

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { wiki: { path: wikiDir, pattern: "**/*.md", type: "wiki" } } },
    });

    await store.writeDocument("wiki", "page.md", "# Page\n\nLinks to [[Target A]] and [[Target B]].");
    const before = await store.getLinks("wiki/page.md", "forward", "wikilink");
    expect(before.forward.length).toBe(2);

    // Overwrite with different links
    await store.writeDocument("wiki", "page.md", "# Page\n\nNow links to [[Target C]].");
    const after = await store.getLinks("wiki/page.md", "forward", "wikilink");
    expect(after.forward.length).toBe(1);
    expect(after.forward[0]!.target).toBe("Target C");

    await store.close();
  });
});

// =============================================================================
// 12. multiGet patterns — agent needs flexible document retrieval
// =============================================================================

describe("multiGet pattern flexibility", () => {
  let store: QMDStore;
  let docsDir: string;

  beforeAll(async () => {
    docsDir = freshTestDir("multiget");
    await seedDocs(docsDir);
    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();
  });

  afterAll(async () => { await store.close(); });

  test("glob pattern with collection prefix", async () => {
    const { docs } = await store.multiGet("docs/*.md");
    expect(docs.length).toBe(3);
  });

  test("glob pattern without collection prefix", async () => {
    const { docs } = await store.multiGet("*.md");
    expect(docs.length).toBe(3);
  });

  test("comma-separated file list", async () => {
    const { docs, errors } = await store.multiGet("docs/architecture.md, docs/security.md");
    expect(docs.length).toBe(2);
    expect(errors.length).toBe(0);
  });

  test("comma-separated with non-existent file gives error", async () => {
    const { docs, errors } = await store.multiGet("docs/architecture.md, docs/nonexistent.md");
    expect(docs.length).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("not found");
  });

  test("single docid retrieval", async () => {
    const search = await store.searchLex("architecture");
    const docid = search[0]!.docid;

    const { docs } = await store.multiGet(`#${docid}`);
    expect(docs.length).toBe(1);
  });

  test("comma-separated docids", async () => {
    const search = await store.searchLex("architecture");
    const docid1 = search[0]!.docid;
    const search2 = await store.searchLex("security");
    const docid2 = search2[0]!.docid;

    const { docs } = await store.multiGet(`#${docid1}, #${docid2}`);
    expect(docs.length).toBe(2);
  });

  test("maxBytes skips large files", async () => {
    const { docs } = await store.multiGet("docs/*.md", { includeBody: true, maxBytes: 10 });
    const skipped = docs.filter(d => d.skipped);
    expect(skipped.length).toBeGreaterThan(0);
  });

  test("comma-separated glob patterns", async () => {
    const { docs, errors } = await store.multiGet("docs/arch*.md, docs/sec*.md");
    expect(docs.length).toBe(2);
    expect(errors.length).toBe(0);
    const titles = docs.map(d => !d.skipped && d.doc.title).filter(Boolean);
    expect(titles).toContain("System Architecture");
    expect(titles).toContain("Security Best Practices");
  });

  test("comma-separated globs deduplicates results", async () => {
    const { docs } = await store.multiGet("docs/*.md, docs/arch*.md");
    expect(docs.length).toBe(3);
  });

  test("comma-separated globs with no-match part reports error", async () => {
    const { docs, errors } = await store.multiGet("docs/arch*.md, docs/zzz*.md");
    expect(docs.length).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("No files matched");
  });
});

// =============================================================================
// 13. Status and index health
// =============================================================================

describe("status accuracy", () => {
  test("status reflects actual document count", async () => {
    const docsDir = freshTestDir("status-count");
    await seedDocs(docsDir);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });

    const emptyStatus = await store.getStatus();
    expect(emptyStatus.totalDocuments).toBe(0);

    await store.update();

    const indexedStatus = await store.getStatus();
    expect(indexedStatus.totalDocuments).toBe(3);
    expect(indexedStatus.collections.length).toBeGreaterThan(0);

    await store.close();
  });

  test("status needsEmbedding is accurate", async () => {
    const docsDir = freshTestDir("status-embed");
    await seedDocs(docsDir);

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();

    const status = await store.getStatus();
    expect(status.needsEmbedding).toBe(3);

    await store.close();
  });

  test("listCollections includes type field", async () => {
    const rawDir = freshTestDir("status-types-raw");
    const wikiDir = freshTestDir("status-types-wiki");
    await seedDocs(rawDir);
    await mkdir(wikiDir, { recursive: true });

    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          raw: { path: rawDir, pattern: "**/*.md" },
          wiki: { path: wikiDir, pattern: "**/*.md", type: "wiki" },
        },
      },
    });

    const collections = await store.listCollections();
    const raw = collections.find(c => c.name === "raw");
    const wiki = collections.find(c => c.name === "wiki");

    expect(raw?.type).toBe("raw");
    expect(wiki?.type).toBe("wiki");

    await store.close();
  });
});

// =============================================================================
// 14. extractSnippet deep quality tests
// =============================================================================

describe("extractSnippet edge cases", () => {
  test("empty body returns valid result", () => {
    const result = extractSnippet("", "query");
    expect(result.line).toBeGreaterThanOrEqual(1);
    expect(typeof result.snippet).toBe("string");
  });

  test("query with no matching terms still returns a snippet", () => {
    const body = "# Hello World\n\nThis is content.";
    const result = extractSnippet(body, "xyznonexistent");
    expect(result.snippet.length).toBeGreaterThan(0);
  });

  test("very long body with chunkPos near the end", () => {
    const body = "Line 1\n".repeat(1000) + "# Target Section\n\nRelevant content here.";
    const pos = body.indexOf("# Target Section");
    const result = extractSnippet(body, "relevant", 500, pos, 200);
    expect(result.snippet).toContain("Relevant");
  });

  test("snippet does not include any @@ diff artifacts", () => {
    const body = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
    const result = extractSnippet(body, "Line 3");
    expect(result.snippet).not.toContain("@@");
  });

  test("intent parameter shifts snippet toward intent-relevant area", () => {
    const body = `# Document

## Section A: Databases
PostgreSQL performance tuning and indexing strategies.

## Section B: Networks
Network performance optimization and latency reduction.

## Section C: UI
Frontend performance with React rendering optimizations.`;

    const noIntent = extractSnippet(body, "performance");
    const dbIntent = extractSnippet(body, "performance", 500, undefined, undefined, "database PostgreSQL indexing");

    // With DB intent, snippet should be biased toward database section
    if (noIntent.line !== dbIntent.line) {
      expect(dbIntent.snippet.toLowerCase()).toContain("postgresql");
    }
  });
});

// =============================================================================
// 15. Structured search via SDK (pre-expanded queries)
// =============================================================================

describe("structured search via SDK", () => {
  let store: QMDStore;

  beforeAll(async () => {
    const docsDir = freshTestDir("structured");
    await seedDocs(docsDir);
    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();
  });

  afterAll(async () => { await store.close(); });

  test("search with pre-expanded lex queries works", async () => {
    const results = await store.search({
      queries: [
        { type: "lex", query: "microservices" },
        { type: "lex", query: "API gateway" },
      ],
      rerank: false,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  test("search with empty queries array returns empty", async () => {
    const results = await store.search({
      queries: [],
      rerank: false,
    });
    expect(results).toEqual([]);
  });

  test("lex query with newline throws validation error", async () => {
    await expect(
      store.search({
        queries: [{ type: "lex", query: "line1\nline2" }],
        rerank: false,
      })
    ).rejects.toThrow(/newline/i);
  });

  test("lex query with unmatched quote throws validation error", async () => {
    await expect(
      store.search({
        queries: [{ type: "lex", query: '"unmatched' }],
        rerank: false,
      })
    ).rejects.toThrow(/quote/i);
  });

  test("search results include docid and displayPath", async () => {
    const results = await store.search({
      queries: [{ type: "lex", query: "security" }],
      rerank: false,
    });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.docid).toMatch(/^[a-f0-9]{6}$/);
      expect(r.displayPath).toBeTruthy();
      expect(r.file).toContain("qmd://");
    }
  });
});
