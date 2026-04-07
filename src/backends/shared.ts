/**
 * Shared utilities for DocumentBackend implementations.
 * Common patterns extracted from pdf/docx/pptx backends.
 */

import type { Database } from "../db.js";
import type { Store } from "../store.js";

/**
 * Common database operations for backends.
 */
export class BackendDb {
  constructor(private db: Database) {}

  /**
   * Get document hash by docid (6-char prefix).
   * Returns undefined if not found.
   */
  getHashByDocid(docid: string): string | undefined {
    const row = this.db.prepare(
      "SELECT hash FROM documents WHERE SUBSTR(hash,1,6) = ? AND active=1 LIMIT 1"
    ).get(docid) as { hash: string } | undefined;
    return row?.hash;
  }

  /**
   * Get document body content by hash.
   * Returns undefined if not found.
   */
  getBody(hash: string): string | undefined {
    const row = this.db.prepare("SELECT doc FROM content WHERE hash = ?").get(hash) as { doc: string } | undefined;
    return row?.doc;
  }

  /**
   * Get both hash and body by docid.
   * Throws if document not found.
   */
  getHashAndBody(docid: string): { hash: string; body: string } {
    const hash = this.getHashByDocid(docid);
    if (!hash) throw err("DOC_NOT_FOUND", undefined, { docid });
    const body = this.getBody(hash);
    if (!body) throw err("CONTENT_NOT_FOUND", undefined, { docid, hash });
    return { hash, body };
  }
}

/**
 * Standardized error types for backends.
 */
export class BackendError extends Error {
  constructor(
    message: string,
    public readonly code: BackendErrorCode,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = "BackendError";
  }
}

export type BackendErrorCode =
  | "DOC_NOT_FOUND"
  | "CONTENT_NOT_FOUND"
  | "INVALID_ADDRESS"
  | "SECTION_NOT_FOUND"
  | "SLIDE_NOT_FOUND"
  | "PAGE_NOT_FOUND"
  | "EXTRACTION_FAILED"
  | "NOT_CONFIGURED"
  | "NO_EMBEDDINGS";

/**
 * Create a BackendError with consistent formatting.
 */
export function err(
  code: BackendErrorCode,
  message?: string,
  context?: Record<string, unknown>
): BackendError {
  const messages: Record<BackendErrorCode, string> = {
    DOC_NOT_FOUND: "Document not found",
    CONTENT_NOT_FOUND: "Document content not found",
    INVALID_ADDRESS: "Invalid address format",
    SECTION_NOT_FOUND: "Section not found",
    SLIDE_NOT_FOUND: "Slide not found",
    PAGE_NOT_FOUND: "Page not found",
    EXTRACTION_FAILED: "Element extraction failed",
    NOT_CONFIGURED: "Feature not configured",
    NO_EMBEDDINGS: "No embeddings available for this document",
  };
  return new BackendError(message ?? messages[code], code, context);
}

/**
 * Address parsing utilities for different backend formats.
 */
export namespace Address {
  /**
   * Parse a slide:N address.
   */
  export function parseSlide(address: string): number | null {
    const m = address.match(/^slide:(\d+)$/);
    return m ? parseInt(m[1]!, 10) : null;
  }

  /**
   * Parse a section:N address.
   */
  export function parseSection(address: string): number | null {
    const m = address.match(/^section:(\d+)$/);
    return m ? parseInt(m[1]!, 10) : null;
  }

  /**
   * Parse a pages:N or pages:N-M address.
   */
  export function parsePages(address: string): { from: number; to: number } | null {
    const m = address.match(/^pages:(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const from = parseInt(m[1]!, 10);
    const to = m[2] ? parseInt(m[2]!, 10) : from;
    return { from, to };
  }

  /**
   * Parse a line:N or line:N-M address (for markdown).
   */
  export function parseLine(address: string): { from: number; to?: number } | null {
    const m = address.match(/^line:(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const from = parseInt(m[1]!, 10);
    const to = m[2] ? parseInt(m[2]!, 10) : undefined;
    return { from, to };
  }

  /**
   * Check if address format is valid for a given format.
   */
  export function isValidFor(address: string, format: "md" | "pdf" | "docx" | "pptx"): boolean {
    switch (format) {
      case "md":
        return /^line:\d+(-\d+)?$/.test(address);
      case "pdf":
        return /^pages:\d+(-\d+)?$/.test(address);
      case "docx":
        return /^section:\d+$/.test(address);
      case "pptx":
        return /^slide:\d+$/.test(address);
    }
  }
}

/**
 * Content truncation utilities.
 */
export namespace Content {
  /**
   * Truncate text to max tokens (approx 4 chars per token).
   * Returns truncated text and metadata.
   */
  export function truncate(text: string, maxTokens: number): {
    text: string;
    truncated: boolean;
    totalTokens: number;
  } {
    const totalTokens = Math.ceil(text.length / 4);
    const maxChars = maxTokens * 4;
    if (text.length > maxChars) {
      return {
        text: text.slice(0, maxChars),
        truncated: true,
        totalTokens,
      };
    }
    return { text, truncated: false, totalTokens };
  }

  /**
   * Build a ContentSection with proper truncation handling.
   */
  export function section(
    address: string,
    text: string,
    maxTokens: number,
    options?: { title?: string; source?: string }
  ): import("./types.js").ContentSection {
    const result = truncate(text, maxTokens);
    const section: import("./types.js").ContentSection = {
      address,
      text: result.text,
      num_tokens: result.truncated ? maxTokens : result.totalTokens,
    };
    if (result.truncated) {
      section.truncated = true;
      section.total_tokens = result.totalTokens;
    }
    if (options?.title) section.title = options.title;
    if (options?.source) section.source = options.source;
    return section;
  }
}

/**
 * Regex search utilities with consistent error handling.
 */
export namespace Grep {
  /**
   * Execute regex search with consistent error handling.
   * @throws BackendError with INVALID_ADDRESS if pattern is invalid
   */
  export function createRegex(pattern: string, flags: string): RegExp {
    try {
      return new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
    } catch (e) {
      throw err("INVALID_ADDRESS", `Invalid regex pattern: ${pattern}`, { originalError: e });
    }
  }

  /**
   * Extract context around a match.
   */
  export function extractContext(
    text: string,
    matchIndex: number,
    matchLength: number,
    contextChars: number = 250
  ): string {
    const start = Math.max(0, matchIndex - contextChars);
    const end = Math.min(text.length, matchIndex + matchLength + contextChars);
    return text.slice(start, end);
  }
}
