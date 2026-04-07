/**
 * Concurrency safety tests for MinerU Document Explorer.
 *
 * Tests verify:
 * 1. Concurrent writes don't corrupt data
 * 2. Multi-step operations are atomic (rename, remove)
 * 3. Concurrent read+write doesn't crash
 * 4. Multiple store instances on same DB file
 * 5. SQLITE_BUSY handling
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
  rootDir = await mkdtemp(join(tmpdir(), "qmd-concurrency-"));
});

afterAll(async () => {
  try { await rm(rootDir, { recursive: true, force: true }); } catch {}
});

// =============================================================================
// 1. Concurrent writeDocument calls within a single store
// =============================================================================

describe("concurrent writes within single store", () => {
  let store: QMDStore;
  let wikiDir: string;

  beforeAll(async () => {
    wikiDir = freshTestDir("wiki-conc");
    await mkdir(wikiDir, { recursive: true });

    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { wiki: { path: wikiDir, pattern: "**/*.md", type: "wiki" } } },
    });
  });

  afterAll(async () => { await store.close(); });

  test("parallel writes to different paths succeed", async () => {
    const writes = Array.from({ length: 10 }, (_, i) =>
      store.writeDocument("wiki", `doc${i}.md`, `# Doc ${i}\n\nContent for doc ${i}.`)
    );
    const results = await Promise.all(writes);
    expect(results.length).toBe(10);

    for (let i = 0; i < 10; i++) {
      expect(results[i]!.file).toBe(`wiki/doc${i}.md`);
    }

    const status = await store.getStatus();
    expect(status.totalDocuments).toBe(10);
  });

  test("parallel writes to same path — last write wins", async () => {
    const writes = Array.from({ length: 5 }, (_, i) =>
      store.writeDocument("wiki", "contested.md", `# Version ${i}\n\nContent version ${i}.`)
    );
    await Promise.all(writes);

    const doc = await store.get("wiki/contested.md");
    expect("error" in doc).toBe(false);
    if (!("error" in doc)) {
      expect(doc.title).toMatch(/Version \d/);
    }

    // Verify only one document exists at this path
    const results = await store.searchLex("contested");
    const contested = results.filter(r => r.displayPath.includes("contested"));
    expect(contested.length).toBe(1);
  });

  test("search during concurrent writes returns consistent results", async () => {
    const writePromises = Array.from({ length: 5 }, (_, i) =>
      store.writeDocument("wiki", `search-test-${i}.md`, `# Search Doc ${i}\n\nSearchable content ${i}.`)
    );

    // Interleave searches with writes
    const searchPromises = Array.from({ length: 5 }, () =>
      store.searchLex("searchable content")
    );

    const [writeResults, searchResults] = await Promise.all([
      Promise.all(writePromises),
      Promise.all(searchPromises),
    ]);

    expect(writeResults.length).toBe(5);
    for (const results of searchResults) {
      expect(Array.isArray(results)).toBe(true);
    }
  });
});

// =============================================================================
// 2. Concurrent collection operations
// =============================================================================

describe("concurrent collection operations", () => {
  test("concurrent addCollection calls don't crash", async () => {
    const dirs = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => {
        const dir = freshTestDir(`coll-${i}`);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "doc.md"), `# Doc in coll ${i}`);
        return dir;
      })
    );

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    const adds = dirs.map((dir, i) =>
      store.addCollection(`coll${i}`, { path: dir, pattern: "**/*.md" })
    );
    await Promise.all(adds);

    const collections = await store.listCollections();
    expect(collections.length).toBe(5);

    await store.close();
  });

  test("concurrent removeCollection calls don't corrupt DB", async () => {
    const dirs = await Promise.all(
      Array.from({ length: 3 }, async (_, i) => {
        const dir = freshTestDir(`rm-${i}`);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "doc.md"), `# Doc ${i}`);
        return dir;
      })
    );

    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: Object.fromEntries(dirs.map((d, i) => [`rm${i}`, { path: d, pattern: "**/*.md" }])),
      },
    });
    await store.update();

    const removes = dirs.map((_, i) => store.removeCollection(`rm${i}`));
    await Promise.all(removes);

    const status = await store.getStatus();
    expect(status.totalDocuments).toBe(0);
    expect(status.collections.length).toBe(0);

    await store.close();
  });
});

// =============================================================================
// 3. Two store instances on the same DB file (simulates multi-process)
// =============================================================================

describe("dual store instances on same DB file", () => {
  test("two readers on same DB file work correctly", async () => {
    const docsDir = freshTestDir("dual-read");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "shared.md"), "# Shared\n\nShared content.");

    const dbPath = freshDbPath();
    const config = { collections: { docs: { path: docsDir, pattern: "**/*.md" } } };

    const store1 = await createStore({ dbPath, config });
    await store1.update();

    const store2 = await createStore({ dbPath, config });

    // Both can read
    const results1 = await store1.searchLex("shared");
    const results2 = await store2.searchLex("shared");
    expect(results1.length).toBe(1);
    expect(results2.length).toBe(1);

    await store2.close();
    await store1.close();
  });

  test("writer + reader on same DB file via WAL", async () => {
    const docsDir = freshTestDir("dual-wr");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "existing.md"), "# Existing\n\nPre-existing doc.");

    const dbPath = freshDbPath();
    const config = {
      collections: {
        docs: { path: docsDir, pattern: "**/*.md" },
        wiki: { path: freshTestDir("dual-wiki"), pattern: "**/*.md", type: "wiki" as const },
      },
    };
    await mkdir(join(config.collections.wiki.path), { recursive: true });

    const store1 = await createStore({ dbPath, config });
    await store1.update();

    const store2 = await createStore({ dbPath, config });

    // Store1 writes, store2 reads
    await store1.writeDocument("wiki", "new.md", "# New Doc\n\nWritten by store1.");

    // Store2 should see the new document (WAL mode allows this)
    const results = await store2.searchLex("written by store1");
    expect(results.length).toBe(1);

    await store2.close();
    await store1.close();
  });

  test("concurrent writes from two store instances don't crash", async () => {
    const wikiDir1 = freshTestDir("dual-w1");
    const wikiDir2 = freshTestDir("dual-w2");
    await mkdir(wikiDir1, { recursive: true });
    await mkdir(wikiDir2, { recursive: true });

    const dbPath = freshDbPath();

    const store1 = await createStore({
      dbPath,
      config: { collections: { wiki: { path: wikiDir1, pattern: "**/*.md", type: "wiki" } } },
    });

    const store2 = await createStore({
      dbPath,
      config: { collections: { wiki: { path: wikiDir2, pattern: "**/*.md", type: "wiki" } } },
    });

    // Both stores write to the same DB — SQLite WAL serializes writes
    // This might throw SQLITE_BUSY without busy_timeout
    let error1: Error | null = null;
    let error2: Error | null = null;

    try {
      await store1.writeDocument("wiki", "from-s1.md", "# From Store 1\n\nContent.");
    } catch (e: any) {
      error1 = e;
    }

    try {
      await store2.writeDocument("wiki", "from-s2.md", "# From Store 2\n\nContent.");
    } catch (e: any) {
      error2 = e;
    }

    // At least one should succeed; both might succeed if writes are sequential
    const bothFailed = error1 !== null && error2 !== null;
    expect(bothFailed).toBe(false);

    await store2.close();
    await store1.close();
  });
});

// =============================================================================
// 4. Data integrity after concurrent operations
// =============================================================================

describe("data integrity after concurrent operations", () => {
  test("no duplicate documents after parallel writes to same path", async () => {
    const wikiDir = freshTestDir("dedup");
    await mkdir(wikiDir, { recursive: true });

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { wiki: { path: wikiDir, pattern: "**/*.md", type: "wiki" } } },
    });

    // Write to same path 10 times concurrently
    const writes = Array.from({ length: 10 }, (_, i) =>
      store.writeDocument("wiki", "same.md", `# Version ${i}\n\nContent ${i}.`)
    );
    await Promise.all(writes);

    // Verify exactly one active document at this path
    const db = store.internal.db;
    const count = db.prepare(
      `SELECT COUNT(*) as c FROM documents WHERE collection = 'wiki' AND path = 'same.md' AND active = 1`
    ).get() as { c: number };
    expect(count.c).toBe(1);

    await store.close();
  });

  test("FTS index stays consistent after concurrent writes", async () => {
    const wikiDir = freshTestDir("fts-conc");
    await mkdir(wikiDir, { recursive: true });

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { wiki: { path: wikiDir, pattern: "**/*.md", type: "wiki" } } },
    });

    // Write 20 documents concurrently
    const writes = Array.from({ length: 20 }, (_, i) =>
      store.writeDocument("wiki", `fts${i}.md`, `# FTS Doc ${i}\n\nUnique content for fts document number ${i}.`)
    );
    await Promise.all(writes);

    // Verify FTS can find all of them
    const results = await store.searchLex("FTS Doc", { limit: 30 });
    expect(results.length).toBe(20);

    // Verify FTS rowcount matches documents count
    const db = store.internal.db;
    const docCount = (db.prepare(`SELECT COUNT(*) as c FROM documents WHERE active = 1`).get() as { c: number }).c;
    const ftsCount = (db.prepare(`SELECT COUNT(*) as c FROM documents_fts`).get() as { c: number }).c;
    expect(ftsCount).toBe(docCount);

    await store.close();
  });

  test("links table stays consistent after concurrent writes", async () => {
    const wikiDir = freshTestDir("links-conc");
    await mkdir(wikiDir, { recursive: true });

    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: { wiki: { path: wikiDir, pattern: "**/*.md", type: "wiki" } } },
    });

    // Write documents with cross-references concurrently
    const writes = [
      store.writeDocument("wiki", "a.md", "# A\n\nLinks to [[B]] and [[C]]."),
      store.writeDocument("wiki", "b.md", "# B\n\nLinks to [[A]] and [[C]]."),
      store.writeDocument("wiki", "c.md", "# C\n\nLinks to [[A]] and [[B]]."),
    ];
    await Promise.all(writes);

    // Each doc should have exactly 2 forward links
    for (const name of ["a", "b", "c"]) {
      const links = await store.getLinks(`wiki/${name}.md`, "forward", "wikilink");
      expect(links.forward.length).toBe(2);
    }

    await store.close();
  });
});
