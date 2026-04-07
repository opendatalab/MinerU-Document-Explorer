/**
 * Format-specific indexing pipeline for binary document formats (PDF, Docx, PPTX).
 *
 * Extracts the duplicated extract→hash→cache→insert pattern from reindexCollection()
 * into a generic pipeline with format-specific extractors.
 */

import type { Database } from "../db.js";
import { statSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of format-specific extraction. */
export interface FormatExtraction {
  /** Joined text content for FTS/embedding indexing */
  content: string;
  /** Document title */
  title: string;
  /** Write format-specific cache (pages_cache, section_map, slide_cache) */
  writeCache: (db: Database, docid: string) => void;
  /** Cleanup old format-specific cache entries */
  cleanupCache: (db: Database, docid: string) => void;
}

/** Result of indexing a single binary document. */
export type IndexResult = "indexed" | "updated" | "unchanged";

/** Store helpers needed by the indexing pipeline (avoids circular import). */
export interface IndexHelpers {
  hashContent: (content: string) => Promise<string>;
  findActiveDocument: (db: Database, collectionName: string, path: string) => { id: number; hash: string; title: string } | null;
  insertContent: (db: Database, hash: string, content: string, createdAt: string) => void;
  insertDocument: (db: Database, collectionName: string, path: string, title: string, hash: string, createdAt: string, modifiedAt: string) => void;
  updateDocument: (db: Database, documentId: number, title: string, hash: string, modifiedAt: string) => void;
}

// ---------------------------------------------------------------------------
// Generic indexing pipeline
// ---------------------------------------------------------------------------

/**
 * Index a binary document (PDF/Docx/PPTX) using the generic pipeline.
 *
 * Handles: hash comparison, cache cleanup/write, content insert, document insert/update.
 */
export async function indexBinaryDocument(
  db: Database,
  extraction: FormatExtraction,
  collectionName: string,
  path: string,
  filepath: string,
  now: string,
  helpers: IndexHelpers,
): Promise<IndexResult> {
  const hash = await helpers.hashContent(extraction.content);
  const docid = hash.slice(0, 6);
  const existing = helpers.findActiveDocument(db, collectionName, path);

  if (existing) {
    if (existing.hash === hash) {
      return "unchanged";
    }
    // Content changed — cleanup old caches, write new ones
    const oldDocid = existing.hash.slice(0, 6);
    extraction.cleanupCache(db, oldDocid);
    extraction.writeCache(db, docid);
    helpers.insertContent(db, hash, extraction.content, now);
    const stat = statSync(filepath);
    helpers.updateDocument(db, existing.id, extraction.title, hash,
      stat ? new Date(stat.mtime).toISOString() : now);
    return "updated";
  }

  // New document
  extraction.writeCache(db, docid);
  helpers.insertContent(db, hash, extraction.content, now);
  const stat = statSync(filepath);
  helpers.insertDocument(db, collectionName, path, extraction.title, hash,
    stat ? new Date(stat.birthtime).toISOString() : now,
    stat ? new Date(stat.mtime).toISOString() : now);
  return "indexed";
}

// ---------------------------------------------------------------------------
// PDF extractor
// ---------------------------------------------------------------------------

/** Dependencies for PDF extraction (passed in to avoid circular imports). */
export interface PdfExtractorDeps {
  callPythonScript: (scriptName: string, args: string[]) => Promise<unknown>;
  getProviders: (capability: "fullText" | "toc" | "elements", format: "pdf" | "docx" | "pptx") => string[];
  getMinerUCredentials: () => { api_key: string; api_url: string } | null;
  getLocalModelConfig: () => { model_path: string; dpi: number } | null;
  extractTitle: (content: string, filename: string) => string;
}

/**
 * Extract a PDF file using configured providers (mineru_cloud → mineru_local → pymupdf).
 */
export async function extractPdf(
  filepath: string,
  relativeFile: string,
  deps: PdfExtractorDeps,
): Promise<FormatExtraction | null> {
  const fullTextProviders = deps.getProviders("fullText", "pdf");

  let pdfData: any = null;
  let pdfSource = "pymupdf";

  for (const provider of fullTextProviders) {
    try {
      if (provider === "mineru_cloud") {
        const creds = deps.getMinerUCredentials();
        if (!creds) continue;
        pdfData = await deps.callPythonScript("extract_pdf_mineru.py", [filepath, creds.api_key]);
        if (pdfData && !pdfData.error) { pdfSource = "mineru"; break; }
      } else if (provider === "mineru_local") {
        const localCfg = deps.getLocalModelConfig();
        if (!localCfg) continue;
        pdfData = await deps.callPythonScript("extract_pdf_local.py", [filepath, localCfg.model_path, String(localCfg.dpi ?? 150)]);
        if (pdfData && !pdfData.error) { pdfSource = "mineru"; break; }
      } else if (provider === "pymupdf") {
        pdfData = await deps.callPythonScript("extract_pdf_pages.py", [filepath]);
        if (pdfData && !pdfData.error) { pdfSource = "pymupdf"; break; }
      }
    } catch {
      // provider failed, try next
    }
  }

  if (!pdfData || pdfData.error || !(pdfData.pages as any[])?.length) return null;

  const pages = pdfData.pages as { page_idx: number; text: string; tokens: number }[];
  const content = pages.map(p => p.text).join("\n\n");
  if (!content.trim()) return null;

  const title = deps.extractTitle(content, relativeFile)
    || relativeFile.split('/').pop()?.replace(/\.pdf$/i, '') || relativeFile;

  return {
    content,
    title,
    writeCache: (db, docid) => {
      db.prepare("DELETE FROM pages_cache WHERE docid = ?").run(docid);
      const insert = db.prepare("INSERT INTO pages_cache (docid, page_idx, text, tokens, source) VALUES (?, ?, ?, ?, ?)");
      for (const page of pages) {
        insert.run(docid, page.page_idx, page.text, page.tokens, pdfSource);
      }
    },
    cleanupCache: (db, docid) => {
      db.prepare("DELETE FROM pages_cache WHERE docid = ?").run(docid);
      db.prepare("DELETE FROM toc_cache WHERE docid = ?").run(docid);
    },
  };
}

// ---------------------------------------------------------------------------
// Docx extractor
// ---------------------------------------------------------------------------

/** Dependencies for Docx extraction. */
export interface DocxExtractorDeps {
  extractDocx: (filepath: string) => Promise<any>;
  getPythonError: (result: any) => string | null;
  extractTitle: (content: string, filename: string) => string;
}

/**
 * Extract a Docx file using python-docx.
 */
export async function extractDocxForIndex(
  filepath: string,
  relativeFile: string,
  deps: DocxExtractorDeps,
): Promise<FormatExtraction | null> {
  let docxData: any;
  try {
    docxData = await deps.extractDocx(filepath);
    const error = deps.getPythonError(docxData);
    if (error) return null;
  } catch {
    return null;
  }

  if (!docxData.markdown) return null;
  const content = docxData.markdown as string;
  if (!content.trim()) return null;

  const sections = (docxData.sections ?? []) as {
    section_idx: number; heading?: string; level?: number;
    line_start: number; line_end: number;
  }[];
  const title = deps.extractTitle(content, relativeFile)
    || relativeFile.split('/').pop()?.replace(/\.docx?$/i, '') || relativeFile;

  return {
    content,
    title,
    writeCache: (db, docid) => {
      db.prepare("DELETE FROM section_map WHERE docid = ?").run(docid);
      const insert = db.prepare("INSERT INTO section_map (docid, section_idx, heading, level, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?)");
      for (const s of sections) {
        insert.run(docid, s.section_idx, s.heading ?? null, s.level ?? 1, s.line_start, s.line_end);
      }
    },
    cleanupCache: (db, docid) => {
      db.prepare("DELETE FROM section_map WHERE docid = ?").run(docid);
    },
  };
}

// ---------------------------------------------------------------------------
// PPTX extractor
// ---------------------------------------------------------------------------

/** Dependencies for PPTX extraction. */
export interface PptxExtractorDeps {
  extractPptx: (filepath: string) => Promise<any>;
  getPythonError: (result: any) => string | null;
}

/**
 * Extract a PPTX file using python-pptx.
 */
export async function extractPptxForIndex(
  filepath: string,
  relativeFile: string,
  deps: PptxExtractorDeps,
): Promise<FormatExtraction | null> {
  let pptxData: any;
  try {
    pptxData = await deps.extractPptx(filepath);
    const error = deps.getPythonError(pptxData);
    if (error) return null;
  } catch {
    return null;
  }

  const slides = (pptxData.slides ?? []) as {
    slide_idx: number; title?: string; text: string; tokens?: number;
  }[];
  const content = slides.map(s => s.text || '').filter(Boolean).join("\n\n");
  if (!content.trim()) return null;

  const title = slides[0]?.title
    || relativeFile.split('/').pop()?.replace(/\.pptx?$/i, '') || relativeFile;

  return {
    content,
    title,
    writeCache: (db, docid) => {
      db.prepare("DELETE FROM slide_cache WHERE docid = ?").run(docid);
      const insert = db.prepare("INSERT INTO slide_cache (docid, slide_idx, title, text, tokens) VALUES (?, ?, ?, ?, ?)");
      for (const s of slides) {
        insert.run(docid, s.slide_idx, s.title ?? null, s.text ?? '', s.tokens ?? 0);
      }
    },
    cleanupCache: (db, docid) => {
      db.prepare("DELETE FROM slide_cache WHERE docid = ?").run(docid);
    },
  };
}