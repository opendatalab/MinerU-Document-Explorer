import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/db.js";
import type { Database } from "../src/db.js";
import { generateWikiIndex } from "../src/wiki/index-gen.js";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let db: Database;
let dbPath: string;

function initTestDb(): Database {
  dbPath = join(tmpdir(), `wiki-index-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const d = openDatabase(dbPath);
  d.exec("PRAGMA journal_mode = WAL");

  d.exec(`
    CREATE TABLE IF NOT EXISTS store_collections (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      pattern TEXT NOT NULL DEFAULT '**/*.md',
      ignore_patterns TEXT,
      include_by_default INTEGER NOT NULL DEFAULT 1,
      update_command TEXT,
      context TEXT,
      type TEXT DEFAULT 'raw'
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(collection, path)
    )
  `);

  return d;
}

function addCollection(name: string, type: "raw" | "wiki" = "wiki") {
  db.prepare(`INSERT INTO store_collections (name, path, type) VALUES (?, ?, ?)`)
    .run(name, `/test/${name}`, type);
}

function addDoc(collection: string, path: string, title: string, hash?: string) {
  const now = new Date().toISOString();
  const h = hash || `h${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(collection, path, title, h, now, now);
}

beforeEach(() => {
  db = initTestDb();
});

afterEach(async () => {
  db.close();
  try { await unlink(dbPath); } catch {}
});

describe("wiki/index-gen - generateWikiIndex", () => {
  it("throws for nonexistent collection", () => {
    expect(() => generateWikiIndex(db, { collection: "ghost" }))
      .toThrow("Collection not found: ghost");
  });

  it("generates an empty index for a collection with no docs", () => {
    addCollection("wiki");
    const result = generateWikiIndex(db, { collection: "wiki" });

    expect(result.page_count).toBe(0);
    expect(result.category_count).toBe(0);
    expect(result.markdown).toContain("# wiki Wiki Index");
    expect(result.markdown).toContain("Auto-generated index of 0 pages");
  });

  it("lists root-level docs under General section", () => {
    addCollection("wiki");
    addDoc("wiki", "overview.md", "Overview", "abc123");
    addDoc("wiki", "glossary.md", "Glossary", "def456");

    const result = generateWikiIndex(db, { collection: "wiki" });

    expect(result.page_count).toBe(2);
    expect(result.category_count).toBe(1); // "General"
    expect(result.markdown).toContain("## General");
    expect(result.markdown).toContain("[[overview]] — Overview (abc123)");
    expect(result.markdown).toContain("[[glossary]] — Glossary (def456)");
  });

  it("groups docs by top-level directory with capitalized headers", () => {
    addCollection("wiki");
    addDoc("wiki", "concepts/attention.md", "Attention Mechanism", "aaa111");
    addDoc("wiki", "concepts/transformer.md", "Transformer", "bbb222");
    addDoc("wiki", "entities/hinton.md", "Geoffrey Hinton", "ccc333");

    const result = generateWikiIndex(db, { collection: "wiki" });

    expect(result.category_count).toBe(2); // concepts, entities
    expect(result.markdown).toContain("## Concepts");
    expect(result.markdown).toContain("[[concepts/attention]] — Attention Mechanism");
    expect(result.markdown).toContain("## Entities");
    expect(result.markdown).toContain("[[entities/hinton]] — Geoffrey Hinton");
  });

  it("skips the index.md page itself", () => {
    addCollection("wiki");
    addDoc("wiki", "index.md", "Wiki Index", "idx000");
    addDoc("wiki", "overview.md", "Overview", "abc123");

    const result = generateWikiIndex(db, { collection: "wiki" });

    // page_count includes index.md in the raw query but it's excluded from display
    // Let me check: the function filters out index.md from rootDocs, so page_count is the total
    // from the query (which includes index.md), but the visible content won't list it.
    expect(result.markdown).not.toContain("[[index]]");
    expect(result.markdown).toContain("[[overview]]");
  });

  it("sorts categories alphabetically", () => {
    addCollection("wiki");
    addDoc("wiki", "zebra/z.md", "Z Page", "zzz000");
    addDoc("wiki", "alpha/a.md", "A Page", "aaa000");
    addDoc("wiki", "mid/m.md", "M Page", "mmm000");

    const result = generateWikiIndex(db, { collection: "wiki" });

    const alphaPos = result.markdown.indexOf("## Alpha");
    const midPos = result.markdown.indexOf("## Mid");
    const zebraPos = result.markdown.indexOf("## Zebra");

    expect(alphaPos).toBeLessThan(midPos);
    expect(midPos).toBeLessThan(zebraPos);
  });

  it("mixes root and categorized docs correctly", () => {
    addCollection("wiki");
    addDoc("wiki", "overview.md", "Overview", "root01");
    addDoc("wiki", "concepts/nn.md", "Neural Networks", "cat001");

    const result = generateWikiIndex(db, { collection: "wiki" });

    expect(result.category_count).toBe(2); // General + concepts
    expect(result.markdown).toContain("## General");
    expect(result.markdown).toContain("## Concepts");
  });

  it("only includes active documents", () => {
    addCollection("wiki");
    addDoc("wiki", "active.md", "Active Page", "act001");
    // Insert an inactive doc manually
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run("wiki", "inactive.md", "Inactive Page", "inact0", now, now);

    const result = generateWikiIndex(db, { collection: "wiki" });
    expect(result.markdown).toContain("[[active]]");
    expect(result.markdown).not.toContain("[[inactive]]");
  });

  it("strips .md extension in wikilinks", () => {
    addCollection("wiki");
    addDoc("wiki", "concepts/deep-learning.md", "Deep Learning", "dl0001");

    const result = generateWikiIndex(db, { collection: "wiki" });
    expect(result.markdown).toContain("[[concepts/deep-learning]]");
    expect(result.markdown).not.toContain(".md");
  });
});
