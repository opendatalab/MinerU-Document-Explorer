import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/db.js";
import type { Database } from "../src/db.js";
import { lintWiki } from "../src/wiki/lint.js";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let db: Database;
let dbPath: string;

function initTestDb(): Database {
  dbPath = join(tmpdir(), `wiki-lint-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const d = openDatabase(dbPath);
  d.exec("PRAGMA journal_mode = WAL");

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
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      link_type TEXT NOT NULL,
      anchor TEXT,
      line INTEGER,
      UNIQUE(source, target, link_type)
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS wiki_sources (
      wiki_file TEXT NOT NULL,
      source_file TEXT NOT NULL,
      wiki_collection TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (wiki_file, source_file)
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS wiki_ingest_tracker (
      source_file TEXT NOT NULL,
      wiki_collection TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (source_file, wiki_collection)
    )
  `);

  return d;
}

function addCollection(name: string, type: "raw" | "wiki" = "raw") {
  db.prepare(`INSERT INTO store_collections (name, path, type) VALUES (?, ?, ?)`)
    .run(name, `/test/${name}`, type);
}

function addDoc(collection: string, path: string, title?: string, modifiedAt?: string) {
  const now = modifiedAt || new Date().toISOString();
  const hash = `h_${collection}_${path}`.replace(/[^a-z0-9_]/gi, "");
  db.prepare(`
    INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(collection, path, title || path, hash, now, now);
}

function addLink(source: string, target: string, type: "wikilink" | "markdown" | "url" = "wikilink") {
  db.prepare(`INSERT OR IGNORE INTO links (source, target, link_type) VALUES (?, ?, ?)`)
    .run(source, target, type);
}

beforeEach(() => {
  db = initTestDb();
});

afterEach(async () => {
  db.close();
  try { await unlink(dbPath); } catch {}
});

describe("wiki/lint - empty state", () => {
  it("returns clean result with no collections or docs", () => {
    const result = lintWiki(db);
    expect(result.orphan_pages).toEqual([]);
    expect(result.broken_links).toEqual([]);
    expect(result.missing_pages).toEqual([]);
    expect(result.hub_pages).toEqual([]);
    expect(result.stale_pages).toEqual([]);
    expect(result.stats.total_pages).toBe(0);
    expect(result.stats.total_links).toBe(0);
    expect(result.stats.wiki_pages).toBe(0);
    expect(result.suggestions).toContain("No wiki collections found. Create one with: qmd collection add <path> --name <name> --type wiki");
  });
});

describe("wiki/lint - orphan pages", () => {
  it("detects wiki pages with no inbound links as orphans", () => {
    addCollection("wiki", "wiki");
    addDoc("wiki", "overview.md");
    addDoc("wiki", "orphan.md");
    // overview has a link to it, orphan does not
    addLink("wiki/some-source.md", "wiki/overview.md", "markdown");

    const result = lintWiki(db);
    expect(result.orphan_pages).toContain("wiki/orphan.md");
    expect(result.orphan_pages).not.toContain("wiki/overview.md");
  });

  it("does not flag raw collection docs as orphans", () => {
    addCollection("papers", "raw");
    addDoc("papers", "unlinked-paper.md");

    const result = lintWiki(db);
    expect(result.orphan_pages).toEqual([]);
  });

  it("resolves wikilink-style inbound links to wiki pages", () => {
    addCollection("wiki", "wiki");
    addDoc("wiki", "concepts.md");
    // Wikilink uses short name (no extension, no collection prefix)
    addLink("wiki/overview.md", "concepts", "wikilink");

    const result = lintWiki(db);
    expect(result.orphan_pages).not.toContain("wiki/concepts.md");
  });
});

describe("wiki/lint - broken links", () => {
  it("detects links pointing to nonexistent documents", () => {
    addCollection("wiki", "wiki");
    addDoc("wiki", "overview.md");
    addLink("wiki/overview.md", "nonexistent-page", "wikilink");

    const result = lintWiki(db);
    expect(result.broken_links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "wiki/overview.md", target: "nonexistent-page" }),
      ])
    );
  });

  it("does not flag valid wikilinks as broken", () => {
    addCollection("wiki", "wiki");
    addDoc("wiki", "concepts.md");
    addDoc("wiki", "overview.md");
    addLink("wiki/overview.md", "concepts", "wikilink");

    const result = lintWiki(db);
    const brokenTargets = result.broken_links.map(l => l.target);
    expect(brokenTargets).not.toContain("concepts");
  });

  it("does not flag valid markdown relative links as broken", () => {
    addCollection("wiki", "wiki");
    addDoc("wiki", "docs/guide.md");
    addDoc("wiki", "docs/overview.md");
    addLink("wiki/docs/overview.md", "guide.md", "markdown");

    const result = lintWiki(db);
    const brokenTargets = result.broken_links.map(l => l.target);
    expect(brokenTargets).not.toContain("guide.md");
  });

  it("ignores URL links (external)", () => {
    addCollection("wiki", "wiki");
    addDoc("wiki", "overview.md");
    addLink("wiki/overview.md", "https://example.com", "url");

    const result = lintWiki(db);
    expect(result.broken_links).toEqual([]);
  });
});

describe("wiki/lint - missing pages", () => {
  it("identifies targets referenced by multiple sources but not created", () => {
    addCollection("wiki", "wiki");
    addDoc("wiki", "a.md");
    addDoc("wiki", "b.md");
    addDoc("wiki", "c.md");
    // "missing-concept" is referenced by a.md and b.md but doesn't exist
    addLink("wiki/a.md", "missing-concept", "wikilink");
    addLink("wiki/b.md", "missing-concept", "wikilink");

    const result = lintWiki(db);
    expect(result.missing_pages.length).toBe(1);
    expect(result.missing_pages[0]!.target).toBe("missing-concept");
    expect(result.missing_pages[0]!.ref_count).toBe(2);
    expect(result.missing_pages[0]!.referenced_by).toContain("wiki/a.md");
    expect(result.missing_pages[0]!.referenced_by).toContain("wiki/b.md");
  });

  it("does not flag singly-referenced broken links as missing pages", () => {
    addCollection("wiki", "wiki");
    addDoc("wiki", "a.md");
    addLink("wiki/a.md", "rare-topic", "wikilink");

    const result = lintWiki(db);
    expect(result.missing_pages).toEqual([]);
    // But it IS a broken link
    expect(result.broken_links.length).toBe(1);
  });
});

describe("wiki/lint - hub pages", () => {
  it("identifies pages with high inbound link counts", () => {
    addCollection("wiki", "wiki");
    addDoc("wiki", "hub.md");
    addDoc("wiki", "a.md");
    addDoc("wiki", "b.md");
    addDoc("wiki", "c.md");
    addDoc("wiki", "d.md");
    addDoc("wiki", "e.md");

    // 5 pages link to hub.md (meeting default threshold of 5)
    for (const src of ["a", "b", "c", "d", "e"]) {
      addLink(`wiki/${src}.md`, "wiki/hub.md", "markdown");
    }

    const result = lintWiki(db);
    expect(result.hub_pages.length).toBe(1);
    expect(result.hub_pages[0]!.file).toBe("wiki/hub.md");
    expect(result.hub_pages[0]!.inbound_count).toBe(5);
  });

  it("respects custom hub_threshold", () => {
    addCollection("wiki", "wiki");
    addDoc("wiki", "minor-hub.md");
    addDoc("wiki", "a.md");
    addDoc("wiki", "b.md");

    addLink("wiki/a.md", "wiki/minor-hub.md", "markdown");
    addLink("wiki/b.md", "wiki/minor-hub.md", "markdown");

    const result = lintWiki(db, { hub_threshold: 2 });
    expect(result.hub_pages.length).toBe(1);

    const resultDefault = lintWiki(db);
    expect(resultDefault.hub_pages.length).toBe(0);
  });
});

describe("wiki/lint - stale pages", () => {
  it("detects wiki pages not updated within stale_days threshold", () => {
    addCollection("wiki", "wiki");
    const staleDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago
    const freshDate = new Date().toISOString();

    addDoc("wiki", "stale.md", "Stale Page", staleDate);
    addDoc("wiki", "fresh.md", "Fresh Page", freshDate);

    const result = lintWiki(db, { stale_days: 30 });
    expect(result.stale_pages.length).toBe(1);
    expect(result.stale_pages[0]!.file).toBe("wiki/stale.md");
    expect(result.stale_pages[0]!.days_ago).toBeGreaterThanOrEqual(59);
  });

  it("does not flag raw collection docs as stale", () => {
    addCollection("papers", "raw");
    const staleDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    addDoc("papers", "old-paper.md", "Old Paper", staleDate);

    const result = lintWiki(db, { stale_days: 30 });
    expect(result.stale_pages).toEqual([]);
  });
});

describe("wiki/lint - collection filter", () => {
  it("restricts analysis to a specific collection", () => {
    addCollection("wiki-a", "wiki");
    addCollection("wiki-b", "wiki");
    addDoc("wiki-a", "page-a.md");
    addDoc("wiki-b", "page-b.md");

    const resultA = lintWiki(db, { collection: "wiki-a" });
    expect(resultA.stats.total_pages).toBe(1);
    // page-a is an orphan (no inbound links)
    expect(resultA.orphan_pages).toContain("wiki-a/page-a.md");
    // page-b shouldn't appear
    expect(resultA.orphan_pages).not.toContain("wiki-b/page-b.md");
  });
});

describe("wiki/lint - suggestions", () => {
  it("generates suggestion for orphan pages", () => {
    addCollection("wiki", "wiki");
    addDoc("wiki", "orphan.md");

    const result = lintWiki(db);
    expect(result.suggestions.some(s => s.includes("no inbound links"))).toBe(true);
  });

  it("generates suggestion for broken links", () => {
    addCollection("wiki", "wiki");
    addDoc("wiki", "a.md");
    addLink("wiki/a.md", "ghost", "wikilink");

    const result = lintWiki(db);
    expect(result.suggestions.some(s => s.includes("broken link"))).toBe(true);
  });

  it("generates stats correctly", () => {
    addCollection("papers", "raw");
    addCollection("wiki", "wiki");
    addDoc("papers", "paper-a.md");
    addDoc("wiki", "summary.md");
    addLink("wiki/summary.md", "papers/paper-a.md", "markdown");

    const result = lintWiki(db);
    expect(result.stats.total_pages).toBe(2);
    expect(result.stats.total_links).toBe(1);
    expect(result.stats.wiki_pages).toBe(1);
  });
});
