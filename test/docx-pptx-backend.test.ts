/**
 * TDD tests for DOCX and PPTX backends.
 *
 * Tests cover:
 * - Indexing pipeline (extractDocxForIndex, extractPptxForIndex, indexBinaryDocument)
 * - DOCX backend (getToc, readContent, grep, charOffsetToSection)
 * - PPTX backend (getToc, readContent, grep, charOffsetToSlide)
 * - Address parsing (section:N, slide:N, isValidFor)
 * - Content truncation
 * - Error handling (missing docs, invalid addresses)
 * - Edge cases (empty documents, single-section docs, deeply nested TOC)
 * - wiki_ingest integration with DOCX/PPTX metadata
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, type Database } from "../src/db.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

// ============================================================================
// Test DB helper
// ============================================================================

function tmpPath(): string {
  return join(tmpdir(), `qmd-backend-test-${randomBytes(6).toString("hex")}.sqlite`);
}

function setupTestDb(): { db: Database; dbPath: string } {
  const dbPath = tmpPath();
  const db = openDatabase(dbPath);
  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS content (
      hash TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS section_map (
      docid TEXT NOT NULL,
      section_idx INTEGER NOT NULL,
      heading TEXT,
      level INTEGER DEFAULT 1,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      PRIMARY KEY (docid, section_idx)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS slide_cache (
      docid TEXT NOT NULL,
      slide_idx INTEGER NOT NULL,
      title TEXT,
      text TEXT NOT NULL,
      tokens INTEGER DEFAULT 0,
      PRIMARY KEY (docid, slide_idx)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS content_vectors (
      hash_seq TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL,
      pos INTEGER NOT NULL DEFAULT 0,
      embedding BLOB,
      model TEXT,
      embedded_at TEXT
    )
  `);

  return { db, dbPath };
}

// ============================================================================
// Seed helpers
// ============================================================================

const DOCX_BODY = [
  "# Introduction",
  "This is the introduction to our document.",
  "It covers important topics.",
  "",
  "## Background",
  "Some background information here.",
  "Including historical context.",
  "",
  "## Methodology",
  "We used the following methodology:",
  "- Step 1: Data collection",
  "- Step 2: Analysis",
  "- Step 3: Evaluation",
  "",
  "### Data Collection",
  "Details about data collection process.",
  "",
  "# Results",
  "Our results show significant improvements.",
  "The key findings include:",
  "- Finding 1: Performance increased by 50%",
  "- Finding 2: Error rate decreased",
  "",
  "# Conclusion",
  "In conclusion, our approach works well.",
].join("\n");

const DOCX_HASH = "abc123def456";
const DOCX_DOCID = "abc123";

const DOCX_SECTIONS = [
  { section_idx: 0, heading: "Introduction", level: 1, line_start: 1, line_end: 3 },
  { section_idx: 1, heading: "Background", level: 2, line_start: 5, line_end: 7 },
  { section_idx: 2, heading: "Methodology", level: 2, line_start: 9, line_end: 13 },
  { section_idx: 3, heading: "Data Collection", level: 3, line_start: 15, line_end: 16 },
  { section_idx: 4, heading: "Results", level: 1, line_start: 18, line_end: 22 },
  { section_idx: 5, heading: "Conclusion", level: 1, line_start: 24, line_end: 25 },
];

function seedDocx(db: Database) {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO documents (collection, path, title, hash, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("testdocs", "report.docx", "Test Report", DOCX_HASH, now, now);
  db.prepare("INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)")
    .run(DOCX_HASH, DOCX_BODY, now);
  const ins = db.prepare("INSERT INTO section_map (docid, section_idx, heading, level, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?)");
  for (const s of DOCX_SECTIONS) {
    ins.run(DOCX_DOCID, s.section_idx, s.heading, s.level, s.line_start, s.line_end);
  }
}

const PPTX_SLIDES = [
  { slide_idx: 0, title: "Title Slide", text: "Welcome to the Presentation\nQ1 2026 Report", tokens: 12 },
  { slide_idx: 1, title: "Agenda", text: "1. Introduction\n2. Market Analysis\n3. Financial Results\n4. Next Steps", tokens: 18 },
  { slide_idx: 2, title: "Market Analysis", text: "The market grew by 15% in Q1.\nOur share increased from 20% to 25%.\nKey competitors lost ground.", tokens: 30 },
  { slide_idx: 3, title: "Financial Results", text: "Revenue: $10M (+25%)\nProfit: $2M (+40%)\nExpenses: $8M (+15%)", tokens: 20 },
  { slide_idx: 4, title: "Next Steps", text: "1. Expand to new markets\n2. Hire 50 engineers\n3. Launch product v2", tokens: 18 },
];

const PPTX_HASH = "pptx99887766";
const PPTX_DOCID = "pptx99";
const PPTX_BODY = PPTX_SLIDES.map(s => s.text).join("\n\n");

function seedPptx(db: Database) {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO documents (collection, path, title, hash, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("testdocs", "presentation.pptx", "Q1 2026 Report", PPTX_HASH, now, now);
  db.prepare("INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)")
    .run(PPTX_HASH, PPTX_BODY, now);
  const ins = db.prepare("INSERT INTO slide_cache (docid, slide_idx, title, text, tokens) VALUES (?, ?, ?, ?, ?)");
  for (const s of PPTX_SLIDES) {
    ins.run(PPTX_DOCID, s.slide_idx, s.title, s.text, s.tokens);
  }
}

// ============================================================================
// Address parsing tests
// ============================================================================

describe("Address parsing", () => {
  it("parseSection parses section:N", async () => {
    const { Address } = await import("../src/backends/shared.js");
    expect(Address.parseSection("section:0")).toBe(0);
    expect(Address.parseSection("section:5")).toBe(5);
    expect(Address.parseSection("section:42")).toBe(42);
  });

  it("parseSection rejects invalid formats", async () => {
    const { Address } = await import("../src/backends/shared.js");
    expect(Address.parseSection("slide:0")).toBeNull();
    expect(Address.parseSection("section:-1")).toBeNull();
    expect(Address.parseSection("section:abc")).toBeNull();
    expect(Address.parseSection("section:")).toBeNull();
    expect(Address.parseSection("")).toBeNull();
  });

  it("parseSlide parses slide:N", async () => {
    const { Address } = await import("../src/backends/shared.js");
    expect(Address.parseSlide("slide:0")).toBe(0);
    expect(Address.parseSlide("slide:3")).toBe(3);
  });

  it("parseSlide rejects invalid formats", async () => {
    const { Address } = await import("../src/backends/shared.js");
    expect(Address.parseSlide("section:0")).toBeNull();
    expect(Address.parseSlide("slide:abc")).toBeNull();
  });

  it("isValidFor matches correct address types", async () => {
    const { Address } = await import("../src/backends/shared.js");
    expect(Address.isValidFor("section:0", "docx")).toBe(true);
    expect(Address.isValidFor("slide:0", "pptx")).toBe(true);
    expect(Address.isValidFor("section:0", "pptx")).toBe(false);
    expect(Address.isValidFor("slide:0", "docx")).toBe(false);
    expect(Address.isValidFor("line:1-10", "md")).toBe(true);
    expect(Address.isValidFor("pages:1-5", "pdf")).toBe(true);
  });
});

// ============================================================================
// Content truncation tests
// ============================================================================

describe("Content truncation", () => {
  it("does not truncate short content", async () => {
    const { Content } = await import("../src/backends/shared.js");
    const result = Content.truncate("Hello world", 100);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("Hello world");
  });

  it("truncates content exceeding max tokens", async () => {
    const { Content } = await import("../src/backends/shared.js");
    const longText = "x".repeat(1000);
    const result = Content.truncate(longText, 10);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(40); // 10 tokens * 4 chars
    expect(result.totalTokens).toBe(250); // 1000/4
  });

  it("builds ContentSection with truncation metadata", async () => {
    const { Content } = await import("../src/backends/shared.js");
    const section = Content.section("section:0", "x".repeat(1000), 10, { title: "Test" });
    expect(section.address).toBe("section:0");
    expect(section.truncated).toBe(true);
    expect(section.total_tokens).toBe(250);
    expect(section.num_tokens).toBe(10);
    expect(section.title).toBe("Test");
  });
});

// ============================================================================
// DOCX Backend tests
// ============================================================================

describe("DOCX Backend", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = setupTestDb());
    seedDocx(db);
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch {}
  });

  async function getBackend() {
    const { createDocxBackend } = await import("../src/backends/docx.js");
    const store = { db, dbPath } as any;
    return createDocxBackend(store);
  }

  describe("getToc", () => {
    it("returns hierarchical TOC from section_map", async () => {
      const backend = await getBackend();
      const toc = await backend.getToc("/fake/report.docx", DOCX_DOCID);
      expect(toc).toHaveLength(3); // 3 top-level: Introduction, Results, Conclusion

      const intro = toc[0]!;
      expect(intro.title).toBe("Introduction");
      expect(intro.level).toBe(1);
      expect(intro.address).toBe("section:0");
      expect(intro.children).toHaveLength(2); // Background, Methodology

      const methodology = intro.children[1]!;
      expect(methodology.title).toBe("Methodology");
      expect(methodology.level).toBe(2);
      expect(methodology.children).toHaveLength(1); // Data Collection

      const dataCollection = methodology.children[0]!;
      expect(dataCollection.title).toBe("Data Collection");
      expect(dataCollection.level).toBe(3);
      expect(dataCollection.address).toBe("section:3");
    });

    it("returns empty array for unknown docid", async () => {
      const backend = await getBackend();
      const toc = await backend.getToc("/fake/missing.docx", "xxxxxx");
      expect(toc).toEqual([]);
    });
  });

  describe("readContent", () => {
    it("reads a single section by address", async () => {
      const backend = await getBackend();
      const result = await backend.readContent("/fake/report.docx", DOCX_DOCID, ["section:0"]);
      expect(result).toHaveLength(1);
      expect(result[0]!.address).toBe("section:0");
      expect(result[0]!.text).toContain("Introduction");
      expect(result[0]!.text).toContain("important topics");
    });

    it("reads multiple sections", async () => {
      const backend = await getBackend();
      const result = await backend.readContent("/fake/report.docx", DOCX_DOCID, ["section:0", "section:4"]);
      expect(result).toHaveLength(2);
      expect(result[0]!.text).toContain("Introduction");
      expect(result[1]!.text).toContain("Results");
    });

    it("returns error for invalid address format", async () => {
      const backend = await getBackend();
      const result = await backend.readContent("/fake/report.docx", DOCX_DOCID, ["slide:0"]);
      expect(result).toHaveLength(1);
      expect(result[0]!.text).toContain("Invalid address");
    });

    it("returns error for non-existent section", async () => {
      const backend = await getBackend();
      const result = await backend.readContent("/fake/report.docx", DOCX_DOCID, ["section:99"]);
      expect(result).toHaveLength(1);
      expect(result[0]!.text).toContain("not found");
    });

    it("truncates content when exceeding maxTokens", async () => {
      const backend = await getBackend();
      const result = await backend.readContent("/fake/report.docx", DOCX_DOCID, ["section:2"], 5);
      expect(result[0]!.truncated).toBe(true);
      expect(result[0]!.text.length).toBeLessThanOrEqual(20); // 5 tokens * 4 chars
    });
  });

  describe("grep", () => {
    it("finds pattern matches with section addresses", async () => {
      const backend = await getBackend();
      const matches = await backend.grep("/fake/report.docx", DOCX_DOCID, "results");
      expect(matches.length).toBeGreaterThan(0);
      const resultMatch = matches.find(m => m.location?.section_idx === 4);
      expect(resultMatch).toBeDefined();
      expect(resultMatch!.address).toBe("section:4");
    });

    it("finds case-insensitive matches by default", async () => {
      const backend = await getBackend();
      const matches = await backend.grep("/fake/report.docx", DOCX_DOCID, "Introduction");
      expect(matches.length).toBeGreaterThan(0);
    });

    it("returns empty array for no matches", async () => {
      const backend = await getBackend();
      const matches = await backend.grep("/fake/report.docx", DOCX_DOCID, "zzzzxyzzy");
      expect(matches).toEqual([]);
    });

    it("maps each match to the correct section", async () => {
      const backend = await getBackend();
      const matches = await backend.grep("/fake/report.docx", DOCX_DOCID, "Step");
      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) {
        expect(m.location?.section_idx).toBe(2); // Methodology section
      }
    });
  });

  describe("error handling", () => {
    it("throws for unknown docid in readContent", async () => {
      const backend = await getBackend();
      await expect(
        backend.readContent("/fake/report.docx", "xxxxxx", ["section:0"])
      ).rejects.toThrow("not found");
    });

    it("throws for unknown docid in grep", async () => {
      const backend = await getBackend();
      await expect(
        backend.grep("/fake/report.docx", "xxxxxx", "test")
      ).rejects.toThrow("not found");
    });
  });
});

// ============================================================================
// PPTX Backend tests
// ============================================================================

describe("PPTX Backend", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = setupTestDb());
    seedPptx(db);
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch {}
  });

  async function getBackend() {
    const { createPptxBackend } = await import("../src/backends/pptx.js");
    const store = { db, dbPath } as any;
    return createPptxBackend(store);
  }

  describe("getToc", () => {
    it("returns flat list of slides", async () => {
      const backend = await getBackend();
      const toc = await backend.getToc("/fake/pres.pptx", PPTX_DOCID);
      expect(toc).toHaveLength(5);
      expect(toc[0]!.title).toBe("Title Slide");
      expect(toc[0]!.level).toBe(1);
      expect(toc[0]!.address).toBe("slide:0");
      expect(toc[0]!.children).toEqual([]);
      expect(toc[4]!.title).toBe("Next Steps");
      expect(toc[4]!.address).toBe("slide:4");
    });

    it("generates fallback title for slides with no title", async () => {
      db.prepare("UPDATE slide_cache SET title = NULL WHERE slide_idx = 2 AND docid = ?").run(PPTX_DOCID);
      const backend = await getBackend();
      const toc = await backend.getToc("/fake/pres.pptx", PPTX_DOCID);
      expect(toc[2]!.title).toBe("Slide 3");
    });

    it("returns empty for unknown docid", async () => {
      const backend = await getBackend();
      const toc = await backend.getToc("/fake/pres.pptx", "xxxxxx");
      expect(toc).toEqual([]);
    });
  });

  describe("readContent", () => {
    it("reads a single slide by address", async () => {
      const backend = await getBackend();
      const result = await backend.readContent("/fake/pres.pptx", PPTX_DOCID, ["slide:2"]);
      expect(result).toHaveLength(1);
      expect(result[0]!.address).toBe("slide:2");
      expect(result[0]!.text).toContain("market grew by 15%");
      expect(result[0]!.title).toBe("Market Analysis");
    });

    it("reads multiple slides", async () => {
      const backend = await getBackend();
      const result = await backend.readContent("/fake/pres.pptx", PPTX_DOCID, ["slide:0", "slide:3"]);
      expect(result).toHaveLength(2);
      expect(result[0]!.text).toContain("Welcome");
      expect(result[1]!.text).toContain("Revenue");
    });

    it("returns error for invalid address format", async () => {
      const backend = await getBackend();
      const result = await backend.readContent("/fake/pres.pptx", PPTX_DOCID, ["section:0"]);
      expect(result).toHaveLength(1);
      expect(result[0]!.text).toContain("Invalid address");
    });

    it("returns error for non-existent slide index", async () => {
      const backend = await getBackend();
      const result = await backend.readContent("/fake/pres.pptx", PPTX_DOCID, ["slide:99"]);
      expect(result).toHaveLength(1);
      expect(result[0]!.text).toContain("not found");
    });

    it("returns empty results for unknown docid (no slides in cache)", async () => {
      const backend = await getBackend();
      const result = await backend.readContent("/fake/pres.pptx", "xxxxxx", ["slide:0"]);
      // PPTX backend doesn't throw for unknown docid - returns slide-not-found errors
      expect(result).toHaveLength(1);
      expect(result[0]!.text).toContain("not found");
    });
  });

  describe("grep", () => {
    it("finds pattern matches with slide addresses", async () => {
      const backend = await getBackend();
      const matches = await backend.grep("/fake/pres.pptx", PPTX_DOCID, "market");
      expect(matches.length).toBeGreaterThan(0);
      // "Market" appears in both Agenda (slide 1) and Market Analysis (slide 2)
      const slideIndices = matches.map(m => m.location?.slide_idx);
      expect(slideIndices).toContain(2);
    });

    it("searches both title and text", async () => {
      const backend = await getBackend();
      const matches = await backend.grep("/fake/pres.pptx", PPTX_DOCID, "Agenda");
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0]!.location?.slide_idx).toBe(1);
    });

    it("returns empty array for no matches", async () => {
      const backend = await getBackend();
      const matches = await backend.grep("/fake/pres.pptx", PPTX_DOCID, "zzzznonexistent");
      expect(matches).toEqual([]);
    });

    it("finds matches across multiple slides", async () => {
      const backend = await getBackend();
      const matches = await backend.grep("/fake/pres.pptx", PPTX_DOCID, "\\d+%");
      const slideIndices = new Set(matches.map(m => m.location?.slide_idx));
      expect(slideIndices.size).toBeGreaterThanOrEqual(2); // Market Analysis and Financial Results
    });
  });

  describe("error handling", () => {
    it("returns empty matches for unknown docid in grep", async () => {
      const backend = await getBackend();
      // PPTX grep with unknown docid returns empty since getSlides returns []
      const matches = await backend.grep("/fake/pres.pptx", "xxxxxx", "test");
      expect(matches).toEqual([]);
    });
  });
});

// ============================================================================
// PPTX charOffsetToSlide consistency tests
// ============================================================================

describe("PPTX charOffsetToSlide consistency", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = setupTestDb());
    seedPptx(db);
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch {}
  });

  it("body construction matches charOffset model when all slides have text", () => {
    const slides = PPTX_SLIDES;
    const body = slides.map(s => s.text).join("\n\n");

    // Verify each slide's text can be found at the expected offset
    let offset = 0;
    for (const slide of slides) {
      const foundAt = body.indexOf(slide.text, offset);
      expect(foundAt).toBe(offset);
      offset += slide.text.length + 2; // +2 for "\n\n"
    }
  });

  it("body construction with empty slides: charOffsetToSlide must skip empty slides", async () => {
    // extractPptxForIndex builds body with .filter(Boolean) which drops empty slides
    const slidesWithEmpty = [
      { slide_idx: 0, text: "Slide 1 content", title: "S1", tokens: 5 },
      { slide_idx: 1, text: "", title: "Empty", tokens: 0 },
      { slide_idx: 2, text: "Slide 3 content", title: "S3", tokens: 5 },
    ];
    const indexedBody = slidesWithEmpty.map(s => s.text || '').filter(Boolean).join("\n\n");
    expect(indexedBody).toBe("Slide 1 content\n\nSlide 3 content");

    // Seed DB with these slides including the empty one
    const now = new Date().toISOString();
    const hash = "emptysl99999999";
    db.prepare("INSERT INTO documents (collection, path, title, hash, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("test", "emptyslides.pptx", "Test", hash, now, now);
    db.prepare("INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)")
      .run(hash, indexedBody, now);
    const ins = db.prepare("INSERT INTO slide_cache (docid, slide_idx, title, text, tokens) VALUES (?, ?, ?, ?, ?)");
    for (const s of slidesWithEmpty) {
      ins.run("emptys", s.slide_idx, s.title, s.text, s.tokens);
    }

    // charOffsetToSlide should correctly map offset in "Slide 3 content" to slide_idx=2
    const { createPptxBackend } = await import("../src/backends/pptx.js");
    const backend = createPptxBackend({ db, dbPath } as any);

    // grep for "Slide 3" should return slide:2 (not slide:1 which is empty)
    const matches = await backend.grep("/fake/emptyslides.pptx", "emptys", "Slide 3");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.location?.slide_idx).toBe(2);
  });
});

// ============================================================================
// Indexing pipeline tests
// ============================================================================

describe("Indexing pipeline", () => {
  let db: Database;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    ({ db, dbPath } = setupTestDb());
    tmpDir = join(tmpdir(), `qmd-idx-test-${randomBytes(4).toString("hex")}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch {}
  });

  describe("extractDocxForIndex", () => {
    it("produces valid FormatExtraction from mock Python output", async () => {
      const { extractDocxForIndex } = await import("../src/backends/indexing.js");
      const result = await extractDocxForIndex("/fake/report.docx", "report.docx", {
        extractDocx: async () => ({
          markdown: "# Title\nParagraph 1\n\n## Section\nParagraph 2\n",
          sections: [
            { section_idx: 0, heading: "Title", level: 1, line_start: 1, line_end: 2 },
            { section_idx: 1, heading: "Section", level: 2, line_start: 4, line_end: 5 },
          ],
        }),
        getPythonError: () => null,
        extractTitle: (content: string) => "Title",
      });

      expect(result).not.toBeNull();
      expect(result!.content).toContain("# Title");
      expect(result!.content).toContain("Paragraph 2");
      expect(result!.title).toBe("Title");
    });

    it("returns null when Python returns error", async () => {
      const { extractDocxForIndex } = await import("../src/backends/indexing.js");
      const result = await extractDocxForIndex("/fake/report.docx", "report.docx", {
        extractDocx: async () => ({ error: "python-docx not found" }),
        getPythonError: (r: any) => r.error,
        extractTitle: () => "x",
      });
      expect(result).toBeNull();
    });

    it("returns null when markdown is empty", async () => {
      const { extractDocxForIndex } = await import("../src/backends/indexing.js");
      const result = await extractDocxForIndex("/fake/empty.docx", "empty.docx", {
        extractDocx: async () => ({ markdown: "   " }),
        getPythonError: () => null,
        extractTitle: () => "x",
      });
      expect(result).toBeNull();
    });

    it("writeCache inserts section_map rows", async () => {
      const { extractDocxForIndex } = await import("../src/backends/indexing.js");
      const result = await extractDocxForIndex("/fake/report.docx", "report.docx", {
        extractDocx: async () => ({
          markdown: "# Title\nContent\n## Sub\nMore\n",
          sections: [
            { section_idx: 0, heading: "Title", level: 1, line_start: 1, line_end: 2 },
            { section_idx: 1, heading: "Sub", level: 2, line_start: 3, line_end: 4 },
          ],
        }),
        getPythonError: () => null,
        extractTitle: () => "Title",
      });

      result!.writeCache(db, "test01");
      const rows = db.prepare("SELECT * FROM section_map WHERE docid = ? ORDER BY section_idx").all("test01") as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0]!.heading).toBe("Title");
      expect(rows[0]!.line_start).toBe(1);
      expect(rows[1]!.heading).toBe("Sub");
    });

    it("cleanupCache removes section_map rows", async () => {
      const { extractDocxForIndex } = await import("../src/backends/indexing.js");
      const result = await extractDocxForIndex("/fake/report.docx", "report.docx", {
        extractDocx: async () => ({
          markdown: "# Title\nBody\n",
          sections: [{ section_idx: 0, heading: "Title", level: 1, line_start: 1, line_end: 2 }],
        }),
        getPythonError: () => null,
        extractTitle: () => "Title",
      });

      result!.writeCache(db, "clean1");
      expect((db.prepare("SELECT COUNT(*) as c FROM section_map WHERE docid = ?").get("clean1") as any).c).toBe(1);

      result!.cleanupCache(db, "clean1");
      expect((db.prepare("SELECT COUNT(*) as c FROM section_map WHERE docid = ?").get("clean1") as any).c).toBe(0);
    });
  });

  describe("extractPptxForIndex", () => {
    it("produces valid FormatExtraction from mock Python output", async () => {
      const { extractPptxForIndex } = await import("../src/backends/indexing.js");
      const result = await extractPptxForIndex("/fake/pres.pptx", "pres.pptx", {
        extractPptx: async () => ({
          slides: [
            { slide_idx: 0, title: "Intro", text: "Welcome all", tokens: 5 },
            { slide_idx: 1, title: "Topic", text: "Main content here", tokens: 7 },
          ],
        }),
        getPythonError: () => null,
      });

      expect(result).not.toBeNull();
      expect(result!.content).toBe("Welcome all\n\nMain content here");
      expect(result!.title).toBe("Intro");
    });

    it("returns null when Python returns error", async () => {
      const { extractPptxForIndex } = await import("../src/backends/indexing.js");
      const result = await extractPptxForIndex("/fake/pres.pptx", "pres.pptx", {
        extractPptx: async () => ({ error: "python-pptx not found" }),
        getPythonError: (r: any) => r.error,
      });
      expect(result).toBeNull();
    });

    it("returns null when all slides are empty", async () => {
      const { extractPptxForIndex } = await import("../src/backends/indexing.js");
      const result = await extractPptxForIndex("/fake/empty.pptx", "empty.pptx", {
        extractPptx: async () => ({ slides: [{ slide_idx: 0, title: "Empty", text: "", tokens: 0 }] }),
        getPythonError: () => null,
      });
      expect(result).toBeNull();
    });

    it("writeCache inserts slide_cache rows", async () => {
      const { extractPptxForIndex } = await import("../src/backends/indexing.js");
      const result = await extractPptxForIndex("/fake/pres.pptx", "pres.pptx", {
        extractPptx: async () => ({
          slides: [
            { slide_idx: 0, title: "Slide 1", text: "Hello", tokens: 3 },
            { slide_idx: 1, title: "Slide 2", text: "World", tokens: 3 },
          ],
        }),
        getPythonError: () => null,
      });

      result!.writeCache(db, "ppt001");
      const rows = db.prepare("SELECT * FROM slide_cache WHERE docid = ? ORDER BY slide_idx").all("ppt001") as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0]!.title).toBe("Slide 1");
      expect(rows[0]!.text).toBe("Hello");
      expect(rows[1]!.title).toBe("Slide 2");
    });

    it("cleanupCache removes slide_cache rows", async () => {
      const { extractPptxForIndex } = await import("../src/backends/indexing.js");
      const result = await extractPptxForIndex("/fake/pres.pptx", "pres.pptx", {
        extractPptx: async () => ({
          slides: [{ slide_idx: 0, title: "S", text: "T", tokens: 1 }],
        }),
        getPythonError: () => null,
      });

      result!.writeCache(db, "ppt002");
      expect((db.prepare("SELECT COUNT(*) as c FROM slide_cache WHERE docid = ?").get("ppt002") as any).c).toBe(1);

      result!.cleanupCache(db, "ppt002");
      expect((db.prepare("SELECT COUNT(*) as c FROM slide_cache WHERE docid = ?").get("ppt002") as any).c).toBe(0);
    });

    it("uses first slide title as document title", async () => {
      const { extractPptxForIndex } = await import("../src/backends/indexing.js");
      const result = await extractPptxForIndex("/fake/pres.pptx", "pres.pptx", {
        extractPptx: async () => ({
          slides: [
            { slide_idx: 0, title: "My Presentation Title", text: "Content", tokens: 3 },
            { slide_idx: 1, title: "Second Slide", text: "More", tokens: 2 },
          ],
        }),
        getPythonError: () => null,
      });
      expect(result!.title).toBe("My Presentation Title");
    });

    it("falls back to filename when no slide title", async () => {
      const { extractPptxForIndex } = await import("../src/backends/indexing.js");
      const result = await extractPptxForIndex("/fake/quarterly-review.pptx", "quarterly-review.pptx", {
        extractPptx: async () => ({
          slides: [
            { slide_idx: 0, text: "Content only", tokens: 3 },
          ],
        }),
        getPythonError: () => null,
      });
      expect(result!.title).toBe("quarterly-review");
    });
  });

  describe("indexBinaryDocument", () => {
    it("indexes a new document", async () => {
      const { indexBinaryDocument } = await import("../src/backends/indexing.js");
      const tmpFile = join(tmpDir, "test.docx");
      writeFileSync(tmpFile, "fake content");

      const extraction = {
        content: "# Test\nContent here",
        title: "Test Doc",
        writeCache: (db: Database, docid: string) => {
          db.prepare("INSERT INTO section_map (docid, section_idx, heading, level, line_start, line_end) VALUES (?, 0, 'Test', 1, 1, 2)")
            .run(docid);
        },
        cleanupCache: () => {},
      };

      const result = await indexBinaryDocument(db, extraction, "testcoll", "test.docx", tmpFile, new Date().toISOString(), {
        hashContent: async (c) => "hash_" + c.length,
        findActiveDocument: () => null,
        insertContent: (db, hash, content, at) => {
          db.prepare("INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)").run(hash, content, at);
        },
        insertDocument: (db, coll, path, title, hash, created, modified) => {
          db.prepare("INSERT INTO documents (collection, path, title, hash, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)")
            .run(coll, path, title, hash, created, modified);
        },
        updateDocument: () => {},
      });

      expect(result).toBe("indexed");
      const doc = db.prepare("SELECT * FROM documents WHERE collection = 'testcoll' AND path = 'test.docx'").get() as any;
      expect(doc).toBeDefined();
      expect(doc.title).toBe("Test Doc");
    });

    it("returns 'unchanged' when hash matches", async () => {
      const { indexBinaryDocument } = await import("../src/backends/indexing.js");
      const tmpFile = join(tmpDir, "same.docx");
      writeFileSync(tmpFile, "same content");

      const extraction = {
        content: "Same content",
        title: "Same",
        writeCache: () => {},
        cleanupCache: () => {},
      };

      const result = await indexBinaryDocument(db, extraction, "testcoll", "same.docx", tmpFile, new Date().toISOString(), {
        hashContent: async () => "samehash",
        findActiveDocument: () => ({ id: 1, hash: "samehash", title: "Same" }),
        insertContent: () => {},
        insertDocument: () => {},
        updateDocument: () => {},
      });

      expect(result).toBe("unchanged");
    });
  });
});

// ============================================================================
// Edge cases
// ============================================================================

describe("Edge cases", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = setupTestDb());
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch {}
  });

  describe("DOCX single-section document", () => {
    it("handles document with only one section", async () => {
      const now = new Date().toISOString();
      const hash = "single00";
      const body = "# Only Section\nAll content in one section.";
      db.prepare("INSERT INTO documents (collection, path, title, hash, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("test", "single.docx", "Single", hash + "xxxxxx", now, now);
      db.prepare("INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)")
        .run(hash + "xxxxxx", body, now);
      db.prepare("INSERT INTO section_map (docid, section_idx, heading, level, line_start, line_end) VALUES (?, 0, 'Only Section', 1, 1, 2)")
        .run(hash);

      const { createDocxBackend } = await import("../src/backends/docx.js");
      const backend = createDocxBackend({ db, dbPath } as any);
      const toc = await backend.getToc("/fake/single.docx", hash);
      expect(toc).toHaveLength(1);
      expect(toc[0]!.children).toEqual([]);
    });
  });

  describe("PPTX single-slide presentation", () => {
    it("handles presentation with only one slide", async () => {
      const now = new Date().toISOString();
      const hash = "single99xxxxxxxx";
      const text = "Only slide content";
      db.prepare("INSERT INTO documents (collection, path, title, hash, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("test", "one.pptx", "One Slide", hash, now, now);
      db.prepare("INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)")
        .run(hash, text, now);
      db.prepare("INSERT INTO slide_cache (docid, slide_idx, title, text, tokens) VALUES (?, 0, 'Solo', ?, 5)")
        .run("single", text);

      const { createPptxBackend } = await import("../src/backends/pptx.js");
      const backend = createPptxBackend({ db, dbPath } as any);
      const toc = await backend.getToc("/fake/one.pptx", "single");
      expect(toc).toHaveLength(1);
      expect(toc[0]!.title).toBe("Solo");
    });
  });

  describe("DOCX with untitled sections", () => {
    it("shows (untitled) for sections without headings", async () => {
      const now = new Date().toISOString();
      const hash = "nohead99xxxxxxxx";
      const body = "Some content without heading\nMore text";
      db.prepare("INSERT INTO documents (collection, path, title, hash, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("test", "nohead.docx", "No Headings", hash, now, now);
      db.prepare("INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)")
        .run(hash, body, now);
      db.prepare("INSERT INTO section_map (docid, section_idx, heading, level, line_start, line_end) VALUES (?, 0, NULL, 1, 1, 2)")
        .run("nohead");

      const { createDocxBackend } = await import("../src/backends/docx.js");
      const backend = createDocxBackend({ db, dbPath } as any);
      const toc = await backend.getToc("/fake/nohead.docx", "nohead");
      expect(toc[0]!.title).toBe("(untitled)");
    });
  });
});

// ============================================================================
// Python Zod schema validation tests
// ============================================================================

describe("Python extraction schema validation", () => {
  it("DocxExtractionResultSchema validates real Python output (no text field in sections)", async () => {
    const { DocxExtractionResultSchema } = await import("../src/backends/python-types.js");

    // This is what extract_docx.py actually emits — sections do NOT have a `text` field
    const pythonOutput = {
      markdown: "# Title\nContent\n## Section\nMore content\n",
      sections: [
        { section_idx: 0, heading: "Title", level: 1, line_start: 1, line_end: 2 },
        { section_idx: 1, heading: "Section", level: 2, line_start: 3, line_end: 4 },
      ],
      tables: [],
    };

    const result = DocxExtractionResultSchema.safeParse(pythonOutput);
    expect(result.success).toBe(true);
  });

  it("DocxExtractionResultSchema validates output with tables", async () => {
    const { DocxExtractionResultSchema } = await import("../src/backends/python-types.js");

    const pythonOutput = {
      markdown: "# Title\nContent\n",
      sections: [
        { section_idx: 0, heading: "Title", level: 1, line_start: 1, line_end: 2 },
      ],
      tables: [
        { section_idx: 0, html: "<table><tr><td>A</td></tr></table>" },
      ],
    };

    const result = DocxExtractionResultSchema.safeParse(pythonOutput);
    expect(result.success).toBe(true);
  });

  it("DocxExtractionResultSchema validates error response", async () => {
    const { DocxExtractionResultSchema } = await import("../src/backends/python-types.js");

    const result = DocxExtractionResultSchema.safeParse({ error: "python-docx not installed" });
    expect(result.success).toBe(true);
  });

  it("PptxExtractionResultSchema validates real Python output", async () => {
    const { PptxExtractionResultSchema } = await import("../src/backends/python-types.js");

    const pythonOutput = {
      slides: [
        { slide_idx: 0, title: "Intro", text: "Welcome", tokens: 3 },
        { slide_idx: 1, title: null, text: "Content", tokens: 5 },
      ],
      tables: [
        { slide_idx: 0, tables: [{ html: "<table><tr><td>X</td></tr></table>" }] },
      ],
    };

    const result = PptxExtractionResultSchema.safeParse(pythonOutput);
    expect(result.success).toBe(true);
  });

  it("getPythonError extracts error from result", async () => {
    const { getPythonError } = await import("../src/backends/python-types.js");

    expect(getPythonError({ error: "something broke" })).toBe("something broke");
    expect(getPythonError({ markdown: "content" })).toBeNull();
    expect(getPythonError(null)).toBeNull();
    expect(getPythonError(42)).toBeNull();
  });

  it("parsePythonResult throws on invalid data", async () => {
    const { parsePythonResult, DocxExtractionResultSchema } = await import("../src/backends/python-types.js");

    expect(() => parsePythonResult({ markdown: 42 }, DocxExtractionResultSchema, "test.py")).toThrow("Invalid output");
  });

  it("PptxExtractionResultSchema normalizes per-slide tables to top-level", async () => {
    const { PptxExtractionResultSchema } = await import("../src/backends/python-types.js");

    // Python script puts tables inside each slide object, not at top-level
    const pythonOutput = {
      slides: [
        { slide_idx: 0, title: "Slide 1", text: "Content", tokens: 3, tables: [{ html: "<table><tr><td>A</td></tr></table>" }] },
        { slide_idx: 1, title: "Slide 2", text: "More", tokens: 2 },
      ],
    };

    const result = PptxExtractionResultSchema.safeParse(pythonOutput);
    expect(result.success).toBe(true);
    if (result.success) {
      // Transform should normalize per-slide tables to top-level
      expect(result.data.tables).toBeDefined();
      expect(result.data.tables).toHaveLength(1);
      expect(result.data.tables![0]!.slide_idx).toBe(0);
      expect(result.data.tables![0]!.tables[0]!.html).toContain("<table>");
    }
  });

  it("PptxExtractionResultSchema preserves existing top-level tables", async () => {
    const { PptxExtractionResultSchema } = await import("../src/backends/python-types.js");

    const pythonOutput = {
      slides: [
        { slide_idx: 0, title: "Slide 1", text: "Content", tokens: 3 },
      ],
      tables: [
        { slide_idx: 0, tables: [{ html: "<table><tr><td>Existing</td></tr></table>" }] },
      ],
    };

    const result = PptxExtractionResultSchema.safeParse(pythonOutput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tables).toHaveLength(1);
      expect(result.data.tables![0]!.tables[0]!.html).toContain("Existing");
    }
  });
});

// ============================================================================
// Format detection tests
// ============================================================================

describe("Format detection", () => {
  it("detects docx format", async () => {
    const { detectFormat } = await import("../src/backends/registry.js");
    expect(detectFormat("report.docx")).toBe("docx");
    expect(detectFormat("old.doc")).toBe("docx");
    expect(detectFormat("/path/to/file.DOCX")).toBe("docx");
  });

  it("detects pptx format", async () => {
    const { detectFormat } = await import("../src/backends/registry.js");
    expect(detectFormat("slides.pptx")).toBe("pptx");
    expect(detectFormat("old.ppt")).toBe("pptx");
    expect(detectFormat("/path/to/file.PPTX")).toBe("pptx");
  });

  it("returns null for unknown formats", async () => {
    const { detectFormat } = await import("../src/backends/registry.js");
    expect(detectFormat("photo.jpg")).toBeNull();
    expect(detectFormat("noextension")).toBeNull();
  });
});

// ============================================================================
// DOCX charOffsetToSection correctness
// ============================================================================

describe("DOCX charOffsetToSection correctness", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = setupTestDb());
    seedDocx(db);
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch {}
  });

  it("maps grep match positions to correct sections", async () => {
    const { createDocxBackend } = await import("../src/backends/docx.js");
    const backend = createDocxBackend({ db, dbPath } as any);

    // "Introduction" appears in section 0
    const introMatches = await backend.grep("/fake/report.docx", DOCX_DOCID, "introduction");
    expect(introMatches.some((m: any) => m.location?.section_idx === 0)).toBe(true);

    // "Conclusion" appears in section 5
    const concMatches = await backend.grep("/fake/report.docx", DOCX_DOCID, "conclusion");
    expect(concMatches.some((m: any) => m.location?.section_idx === 5)).toBe(true);

    // "Data collection" appears in section 3
    const dataMatches = await backend.grep("/fake/report.docx", DOCX_DOCID, "data collection");
    expect(dataMatches.some((m: any) => m.location?.section_idx === 3 || m.location?.section_idx === 2)).toBe(true);
  });
});

// ============================================================================
// Large document performance
// ============================================================================

describe("Large document handling", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = setupTestDb());
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch {}
  });

  it("handles DOCX with many sections efficiently", async () => {
    const now = new Date().toISOString();
    const lines: string[] = [];
    const sections: typeof DOCX_SECTIONS = [];
    let currentLine = 1;

    for (let i = 0; i < 100; i++) {
      const heading = `Section ${i}`;
      const lineStart = currentLine;
      lines.push(`# ${heading}`);
      currentLine++;
      for (let j = 0; j < 5; j++) {
        lines.push(`Content paragraph ${j} in section ${i}. Keywords: alpha beta gamma.`);
        currentLine++;
      }
      const lineEnd = currentLine - 1;
      sections.push({ section_idx: i, heading, level: 1, line_start: lineStart, line_end: lineEnd });
      lines.push("");
      currentLine++;
    }

    const body = lines.join("\n");
    const hash = "large100sect0001";
    db.prepare("INSERT INTO documents (collection, path, title, hash, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("test", "large.docx", "Large Doc", hash, now, now);
    db.prepare("INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)")
      .run(hash, body, now);
    const ins = db.prepare("INSERT INTO section_map (docid, section_idx, heading, level, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?)");
    const docid = hash.slice(0, 6);
    for (const s of sections) {
      ins.run(docid, s.section_idx, s.heading, s.level, s.line_start, s.line_end);
    }

    const { createDocxBackend } = await import("../src/backends/docx.js");
    const backend = createDocxBackend({ db, dbPath } as any);

    // getToc should return 100 sections
    const toc = await backend.getToc("/fake/large.docx", docid);
    expect(toc).toHaveLength(100);

    // grep should find matches across many sections
    const matches = await backend.grep("/fake/large.docx", docid, "alpha");
    expect(matches.length).toBeGreaterThanOrEqual(100); // at least one per section

    // readContent for the last section should work
    const result = await backend.readContent("/fake/large.docx", docid, ["section:99"]);
    expect(result[0]!.text).toContain("Section 99");
  });

  it("handles PPTX with many slides efficiently", async () => {
    const now = new Date().toISOString();
    const slides: typeof PPTX_SLIDES = [];
    for (let i = 0; i < 50; i++) {
      slides.push({
        slide_idx: i,
        title: `Slide ${i + 1}`,
        text: `Content for slide ${i + 1}. Revenue growth metrics and KPIs.`,
        tokens: 15,
      });
    }

    const body = slides.map(s => s.text).join("\n\n");
    const hash = "largepptx500001";
    db.prepare("INSERT INTO documents (collection, path, title, hash, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("test", "large.pptx", "Large Pres", hash, now, now);
    db.prepare("INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)")
      .run(hash, body, now);
    const ins = db.prepare("INSERT INTO slide_cache (docid, slide_idx, title, text, tokens) VALUES (?, ?, ?, ?, ?)");
    const docid = hash.slice(0, 6);
    for (const s of slides) {
      ins.run(docid, s.slide_idx, s.title, s.text, s.tokens);
    }

    const { createPptxBackend } = await import("../src/backends/pptx.js");
    const backend = createPptxBackend({ db, dbPath } as any);

    const toc = await backend.getToc("/fake/large.pptx", docid);
    expect(toc).toHaveLength(50);

    const matches = await backend.grep("/fake/large.pptx", docid, "Revenue");
    expect(matches).toHaveLength(50);

    const result = await backend.readContent("/fake/large.pptx", docid, ["slide:49"]);
    expect(result[0]!.text).toContain("slide 50");
  });
});

// ============================================================================
// Deeply nested DOCX TOC
// ============================================================================

describe("Deeply nested DOCX TOC", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = setupTestDb());
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch {}
  });

  it("builds correct hierarchy with h1 > h2 > h3 > h4 nesting", async () => {
    const now = new Date().toISOString();
    const body = "# Chapter\n## Section\n### Subsection\n#### Detail\nContent\n## Another Section\nMore content";
    const hash = "nested44xxxxxxxx";
    const docid = "nested";
    db.prepare("INSERT INTO documents (collection, path, title, hash, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("test", "nested.docx", "Nested", hash, now, now);
    db.prepare("INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)")
      .run(hash, body, now);

    const sections = [
      { section_idx: 0, heading: "Chapter", level: 1, line_start: 1, line_end: 1 },
      { section_idx: 1, heading: "Section", level: 2, line_start: 2, line_end: 2 },
      { section_idx: 2, heading: "Subsection", level: 3, line_start: 3, line_end: 3 },
      { section_idx: 3, heading: "Detail", level: 4, line_start: 4, line_end: 5 },
      { section_idx: 4, heading: "Another Section", level: 2, line_start: 6, line_end: 7 },
    ];
    const ins = db.prepare("INSERT INTO section_map (docid, section_idx, heading, level, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?)");
    for (const s of sections) {
      ins.run(docid, s.section_idx, s.heading, s.level, s.line_start, s.line_end);
    }

    const { createDocxBackend } = await import("../src/backends/docx.js");
    const backend = createDocxBackend({ db, dbPath } as any);
    const toc = await backend.getToc("/fake/nested.docx", docid);

    // Top level: just "Chapter"
    expect(toc).toHaveLength(1);
    const chapter = toc[0]!;
    expect(chapter.title).toBe("Chapter");
    expect(chapter.children).toHaveLength(2); // "Section" and "Another Section"

    const section = chapter.children[0]!;
    expect(section.title).toBe("Section");
    expect(section.children).toHaveLength(1); // "Subsection"

    const subsection = section.children[0]!;
    expect(subsection.title).toBe("Subsection");
    expect(subsection.children).toHaveLength(1); // "Detail"

    const detail = subsection.children[0]!;
    expect(detail.title).toBe("Detail");
    expect(detail.children).toEqual([]);

    const anotherSection = chapter.children[1]!;
    expect(anotherSection.title).toBe("Another Section");
    expect(anotherSection.children).toEqual([]);
  });
});
