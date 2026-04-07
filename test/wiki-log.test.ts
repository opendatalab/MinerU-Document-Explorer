import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/db.js";
import type { Database } from "../src/db.js";
import { initializeSchema } from "../src/db-schema.js";
import { appendLog, queryLog, getLogStats, formatLogAsMarkdown, type WikiLogEntry } from "../src/wiki/log.js";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let db: Database;
let dbPath: string;

function initTestDb(): Database {
  dbPath = join(tmpdir(), `wiki-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const d = openDatabase(dbPath);
  d.exec("PRAGMA journal_mode = WAL");
  d.exec(`
    CREATE TABLE IF NOT EXISTS wiki_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      operation TEXT NOT NULL,
      source_file TEXT,
      wiki_files TEXT,
      details TEXT,
      session_id TEXT
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_wiki_log_timestamp ON wiki_log(timestamp)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_wiki_log_operation ON wiki_log(operation)`);
  return d;
}

beforeEach(() => {
  db = initTestDb();
});

afterEach(async () => {
  db.close();
  try { await unlink(dbPath); } catch {}
});

describe("wiki/log - appendLog", () => {
  it("inserts a minimal log entry and returns the row id", () => {
    const id = appendLog(db, { operation: "ingest" });
    expect(id).toBeGreaterThan(0);
  });

  it("inserts a full log entry with all fields", () => {
    const id = appendLog(db, {
      operation: "ingest",
      source_file: "papers/neural-nets.pdf",
      wiki_files: ["wiki/neural-nets.md", "wiki/entities/hinton.md"],
      details: { word_count: 5000, format: "pdf" },
      session_id: "sess-001",
    });
    expect(id).toBeGreaterThan(0);
  });

  it("auto-increments ids on sequential inserts", () => {
    const id1 = appendLog(db, { operation: "ingest" });
    const id2 = appendLog(db, { operation: "update" });
    expect(id2).toBe(id1 + 1);
  });
});

describe("wiki/log - queryLog", () => {
  beforeEach(() => {
    appendLog(db, { operation: "ingest", source_file: "a.pdf", session_id: "s1" });
    appendLog(db, { operation: "update", wiki_files: ["wiki/a.md"], session_id: "s1" });
    appendLog(db, { operation: "lint", details: { orphans: 2 } });
    appendLog(db, { operation: "ingest", source_file: "b.pdf", session_id: "s2" });
  });

  it("returns all entries (up to limit) in descending timestamp order", () => {
    const entries = queryLog(db);
    expect(entries.length).toBe(4);
    // Most recent first
    expect(entries[0]!.operation).toBe("ingest");
    expect(entries[0]!.source_file).toBe("b.pdf");
  });

  it("filters by operation", () => {
    const entries = queryLog(db, { operation: "ingest" });
    expect(entries.length).toBe(2);
    entries.forEach(e => expect(e.operation).toBe("ingest"));
  });

  it("filters by session_id", () => {
    const entries = queryLog(db, { session_id: "s1" });
    expect(entries.length).toBe(2);
    entries.forEach(e => expect(e.session_id).toBe("s1"));
  });

  it("respects limit", () => {
    const entries = queryLog(db, { limit: 2 });
    expect(entries.length).toBe(2);
  });

  it("deserializes wiki_files from JSON", () => {
    const entries = queryLog(db, { operation: "update" });
    expect(entries[0]!.wiki_files).toEqual(["wiki/a.md"]);
  });

  it("deserializes details from JSON", () => {
    const entries = queryLog(db, { operation: "lint" });
    expect(entries[0]!.details).toEqual({ orphans: 2 });
  });

  it("returns empty array when no matches", () => {
    const entries = queryLog(db, { operation: "index" });
    expect(entries).toEqual([]);
  });
});

describe("wiki/log - getLogStats", () => {
  it("returns zero stats for empty log", () => {
    const stats = getLogStats(db);
    expect(stats.total).toBe(0);
    expect(stats.byOperation).toEqual({});
    expect(stats.lastEntry).toBeNull();
  });

  it("returns accurate counts by operation", () => {
    appendLog(db, { operation: "ingest" });
    appendLog(db, { operation: "ingest" });
    appendLog(db, { operation: "lint" });

    const stats = getLogStats(db);
    expect(stats.total).toBe(3);
    expect(stats.byOperation.ingest).toBe(2);
    expect(stats.byOperation.lint).toBe(1);
    expect(stats.lastEntry).toBeTruthy();
  });
});

describe("wiki/log - formatLogAsMarkdown", () => {
  it("returns placeholder for empty entries", () => {
    const md = formatLogAsMarkdown([]);
    expect(md).toBe("No activity recorded yet.");
  });

  it("formats entries with source and files", () => {
    const entries: WikiLogEntry[] = [
      {
        id: 1,
        timestamp: "2025-06-01 10:00:00",
        operation: "ingest",
        source_file: "papers/llm.pdf",
        wiki_files: ["wiki/llm-summary.md"],
        details: { word_count: 3000 },
      },
    ];
    const md = formatLogAsMarkdown(entries);
    expect(md).toContain("# Wiki Activity Log");
    expect(md).toContain("## [2025-06-01 10:00:00] ingest | papers/llm.pdf");
    expect(md).toContain("- wiki/llm-summary.md");
    expect(md).toContain("**word_count**: 3000");
  });

  it("handles entries without optional fields", () => {
    const entries: WikiLogEntry[] = [
      { id: 2, timestamp: "2025-06-01 11:00:00", operation: "lint" },
    ];
    const md = formatLogAsMarkdown(entries);
    expect(md).toContain("## [2025-06-01 11:00:00] lint");
    expect(md).not.toContain("Files touched");
  });
});
