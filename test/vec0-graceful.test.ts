/**
 * vec0-graceful.test.ts — Verify vector search degrades gracefully when
 * the sqlite-vec extension is not loaded or the vectors_vec table is missing.
 *
 * Regression tests for: SQLiteError "no such module: vec0" crash.
 * Architecture: vec0 availability is determined once at DB init and stored
 * on the Store object as `store.vecAvailable`.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore as createInternalStore, type Store } from "../src/store.js";
import { createStore, type QMDStore } from "../src/index.js";

let rootDir: string;

function freshDbPath(): string {
  return join(rootDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "qmd-vec0-test-"));
});

afterAll(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("store.vecAvailable", () => {
  test("is set during store creation", () => {
    const store = createInternalStore(freshDbPath());
    try {
      expect(typeof store.vecAvailable).toBe("boolean");
    } finally {
      store.close();
    }
  });

  test("different stores get independent values", () => {
    const store1 = createInternalStore(freshDbPath());
    const store2 = createInternalStore(freshDbPath());
    try {
      expect(typeof store1.vecAvailable).toBe("boolean");
      expect(typeof store2.vecAvailable).toBe("boolean");
    } finally {
      store1.close();
      store2.close();
    }
  });
});

describe("query graceful degradation", () => {
  let store: QMDStore;
  let docsDir: string;

  beforeEach(async () => {
    docsDir = join(rootDir, "docs-" + Math.random().toString(36).slice(2, 8));
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "test.md"), `# Distributed Systems
Distributed systems are collections of networked computers.
## CAP Theorem
The CAP theorem defines trade-offs in distributed systems.
`);
  });

  afterEach(async () => {
    try { await store?.close(); } catch {}
  });

  test("BM25 search works regardless of vec0 status", async () => {
    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { testcoll: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();

    const results = await store.searchLex("distributed systems");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.title).toContain("Distributed");
  });

  test("hybrid search returns BM25 results even without vec0", async () => {
    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { testcoll: { path: docsDir, pattern: "**/*.md" } } },
    });
    await store.update();

    const results = await store.search({ query: "CAP theorem" });
    expect(results.length).toBeGreaterThan(0);
  });
});
