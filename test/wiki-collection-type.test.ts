import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/db.js";
import type { Database } from "../src/db.js";
import {
  upsertStoreCollection,
  getStoreCollection,
  getStoreCollections,
  getWikiCollections,
  isWikiCollection,
  listCollections,
} from "../src/store.js";
import { initializeSchema } from "../src/db-schema.js";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let db: Database;
let dbPath: string;

function initTestDb(): Database {
  dbPath = join(tmpdir(), `wiki-colltype-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
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

  d.exec(`
    CREATE TABLE IF NOT EXISTS store_config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  return d;
}

beforeEach(() => {
  db = initTestDb();
});

afterEach(async () => {
  db.close();
  try { await unlink(dbPath); } catch {}
});

describe("collection type - upsertStoreCollection", () => {
  it("creates a raw collection by default", () => {
    upsertStoreCollection(db, "papers", { path: "/data/papers" });
    const coll = getStoreCollection(db, "papers");
    expect(coll).not.toBeNull();
    expect(coll!.type).toBeUndefined(); // raw type is omitted by rowToNamedCollection
  });

  it("creates a wiki collection when type is specified", () => {
    upsertStoreCollection(db, "wiki", { path: "/data/wiki", type: "wiki" });
    const coll = getStoreCollection(db, "wiki");
    expect(coll).not.toBeNull();
    expect(coll!.type).toBe("wiki");
  });

  it("updates type on re-upsert", () => {
    upsertStoreCollection(db, "notes", { path: "/data/notes" });
    expect(getStoreCollection(db, "notes")!.type).toBeUndefined();

    upsertStoreCollection(db, "notes", { path: "/data/notes", type: "wiki" });
    expect(getStoreCollection(db, "notes")!.type).toBe("wiki");
  });
});

describe("collection type - isWikiCollection", () => {
  it("returns false for a raw collection", () => {
    upsertStoreCollection(db, "papers", { path: "/data/papers" });
    expect(isWikiCollection(db, "papers")).toBe(false);
  });

  it("returns true for a wiki collection", () => {
    upsertStoreCollection(db, "wiki", { path: "/data/wiki", type: "wiki" });
    expect(isWikiCollection(db, "wiki")).toBe(true);
  });

  it("returns false for nonexistent collection", () => {
    expect(isWikiCollection(db, "ghost")).toBe(false);
  });
});

describe("collection type - getWikiCollections", () => {
  it("returns only wiki-type collections", () => {
    upsertStoreCollection(db, "papers", { path: "/data/papers" });
    upsertStoreCollection(db, "wiki-a", { path: "/data/wiki-a", type: "wiki" });
    upsertStoreCollection(db, "wiki-b", { path: "/data/wiki-b", type: "wiki" });

    const wikiColls = getWikiCollections(db);
    expect(wikiColls.length).toBe(2);
    expect(wikiColls.map(c => c.name).sort()).toEqual(["wiki-a", "wiki-b"]);
    wikiColls.forEach(c => expect(c.type).toBe("wiki"));
  });

  it("returns empty when no wiki collections exist", () => {
    upsertStoreCollection(db, "papers", { path: "/data/papers" });
    expect(getWikiCollections(db)).toEqual([]);
  });
});

describe("collection type - getStoreCollections", () => {
  it("returns all collections regardless of type", () => {
    upsertStoreCollection(db, "raw-coll", { path: "/data/raw" });
    upsertStoreCollection(db, "wiki-coll", { path: "/data/wiki", type: "wiki" });

    const all = getStoreCollections(db);
    expect(all.length).toBe(2);
  });
});

describe("collection type - listCollections", () => {
  it("includes type field in listed collections", () => {
    upsertStoreCollection(db, "papers", { path: "/data/papers" });
    upsertStoreCollection(db, "wiki", { path: "/data/wiki", type: "wiki" });

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run("papers", "test.md", "Test", "h1", now, now);
    db.prepare(`
      INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run("wiki", "overview.md", "Overview", "h2", now, now);

    const list = listCollections(db);
    const papersEntry = list.find(c => c.name === "papers");
    const wikiEntry = list.find(c => c.name === "wiki");

    expect(papersEntry).toBeDefined();
    expect(papersEntry!.type).toBe("raw");
    expect(papersEntry!.doc_count).toBe(1);

    expect(wikiEntry).toBeDefined();
    expect(wikiEntry!.type).toBe("wiki");
    expect(wikiEntry!.doc_count).toBe(1);
  });
});

describe("collection type - DB migration v2", () => {
  it("v2 migration adds type column and wiki_log table", () => {
    const migDbPath = join(tmpdir(), `wiki-migrate-test-${Date.now()}.sqlite`);
    const migDb = openDatabase(migDbPath);
    migDb.exec("PRAGMA journal_mode = WAL");

    // Simulate a v0 database (tables exist but no schema_version, no type column)
    migDb.exec(`
      CREATE TABLE IF NOT EXISTS store_collections (
        name TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        pattern TEXT NOT NULL DEFAULT '**/*.md',
        ignore_patterns TEXT,
        include_by_default INTEGER NOT NULL DEFAULT 1,
        update_command TEXT,
        context TEXT
      )
    `);
    migDb.exec(`
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
    migDb.exec(`CREATE TABLE IF NOT EXISTS content (hash TEXT PRIMARY KEY, doc TEXT NOT NULL, created_at TEXT NOT NULL)`);
    migDb.exec(`CREATE TABLE IF NOT EXISTS content_vectors (hash TEXT, seq INTEGER, pos INTEGER, PRIMARY KEY(hash, seq))`);
    migDb.exec(`CREATE TABLE IF NOT EXISTS llm_cache (key TEXT PRIMARY KEY, value TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    migDb.exec(`CREATE TABLE IF NOT EXISTS links (id INTEGER PRIMARY KEY, source TEXT, target TEXT, link_type TEXT, anchor TEXT, line INTEGER, UNIQUE(source, target, link_type))`);

    // Insert a pre-existing collection
    migDb.prepare(`INSERT INTO store_collections (name, path) VALUES (?, ?)`)
      .run("old-coll", "/data/old");

    // Run migration
    initializeSchema(migDb);

    // Verify type column was added with default 'raw'
    const row = migDb.prepare(`SELECT type FROM store_collections WHERE name = ?`).get("old-coll") as { type: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.type).toBe("raw");

    // Verify wiki_log table was created
    const tables = migDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_log'`).all() as { name: string }[];
    expect(tables.length).toBe(1);

    // Verify wiki_log indexes
    const indexes = migDb.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='wiki_log'`).all() as { name: string }[];
    const indexNames = indexes.map(i => i.name);
    expect(indexNames).toContain("idx_wiki_log_timestamp");
    expect(indexNames).toContain("idx_wiki_log_operation");

    // Verify schema version is now current (3 after adding wiki_sources + wiki_ingest_tracker)
    const version = migDb.prepare(`SELECT MAX(version) as v FROM schema_version`).get() as { v: number };
    expect(version.v).toBe(3);

    // Verify v3 tables (wiki_sources, wiki_ingest_tracker)
    const v3Tables = migDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('wiki_sources', 'wiki_ingest_tracker')`).all() as { name: string }[];
    expect(v3Tables.map(t => t.name).sort()).toEqual(["wiki_ingest_tracker", "wiki_sources"]);

    migDb.close();
    try { unlink(migDbPath); } catch {}
  });
});
