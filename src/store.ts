/**
 * QMD Store - Core data access and retrieval functions
 *
 * This module provides all database operations, search functions, and document
 * retrieval for QMD. It returns raw data structures that can be formatted by
 * CLI or MCP consumers.
 *
 * Usage:
 *   const store = createStore("/path/to/db.sqlite");
 *   // or use default path:
 *   const store = createStore();
 */

import { openDatabase, loadSqliteVec } from "./db.js";
import type { Database } from "./db.js";
import { parseLinks } from "./links.js";
import { initializeSchema } from "./db-schema.js";
import picomatch from "picomatch";
import { createHash } from "crypto";
import { readFileSync, realpathSync, statSync, mkdirSync } from "node:fs";
// Note: node:path resolve is not imported — we export our own cross-platform resolve()
import fastGlob from "fast-glob";
import {
  LlamaCpp,
  getDefaultLlamaCpp,
  formatQueryForEmbedding,
  formatDocForEmbedding,
  withLLMSessionForLlm,
  type LLMSessionOptions,
  type RerankDocument,
  type ILLMSession,
} from "./llm.js";
import type {
  NamedCollection,
  Collection,
  CollectionConfig,
  ContextMap,
} from "./collections.js";

// =============================================================================
// Configuration
// =============================================================================

const HOME = process.env.HOME || "/tmp";
export const DEFAULT_EMBED_MODEL = "embeddinggemma";
export const DEFAULT_RERANK_MODEL = "ExpedientFalcon/qwen3-reranker:0.6b-q8_0";
export const DEFAULT_QUERY_MODEL = "Qwen/Qwen3-1.7B";
export const DEFAULT_GLOB = "**/*.md"; // Use **/*.{md,pdf,docx,pptx} to index all supported formats
export const DEFAULT_MULTI_GET_MAX_BYTES = 10 * 1024; // 10KB

// Chunking: re-exported from dedicated module
export {
  CHUNK_SIZE_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  CHUNK_SIZE_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNK_WINDOW_TOKENS,
  CHUNK_WINDOW_CHARS,
  type BreakPoint,
  type CodeFenceRegion,
  BREAK_PATTERNS,
  scanBreakPoints,
  findCodeFences,
  isInsideCodeFence,
  findBestCutoff,
  chunkDocument,
  chunkDocumentByTokens,
} from "./chunking.js";
import {
  CHUNK_SIZE_CHARS,
  CHUNK_WINDOW_CHARS,
  scanBreakPoints,
  findCodeFences,
  findBestCutoff,
  chunkDocumentByTokens,
} from "./chunking.js";

/**
 * Get the LlamaCpp instance for a store — prefers the store's own instance,
 * falls back to the global singleton.
 */
function getLlm(store: Store): LlamaCpp {
  return store.llm ?? getDefaultLlamaCpp();
}

// Hybrid query constants: re-exported from dedicated module
export { STRONG_SIGNAL_MIN_SCORE, STRONG_SIGNAL_MIN_GAP, RERANK_CANDIDATE_LIMIT } from "./hybrid-search.js";

/**
 * A typed query expansion result. Decoupled from llm.ts internal Queryable —
 * same shape, but store.ts owns its own public API type.
 *
 * - lex: keyword variant → routes to FTS only
 * - vec: semantic variant → routes to vector only
 * - hyde: hypothetical document → routes to vector only
 */
export type ExpandedQuery = {
  type: 'lex' | 'vec' | 'hyde';
  query: string;
  /** Optional line number for error reporting (CLI parser) */
  line?: number;
};

// =============================================================================
// Path utilities
// =============================================================================

export function homedir(): string {
  return HOME;
}

/**
 * Check if a path is absolute.
 * Supports:
 * - Unix paths: /path/to/file
 * - Windows native: C:\path or C:/path
 * - Git Bash: /c/path or /C/path (C-Z drives, excluding A/B floppy drives)
 * 
 * Note: /c without trailing slash is treated as Unix path (directory named "c"),
 * while /c/ or /c/path are treated as Git Bash paths (C: drive).
 */
export function isAbsolutePath(path: string): boolean {
  if (!path) return false;
  
  // Unix absolute path
  if (path.startsWith('/')) {
    // Check if it's a Git Bash style path like /c/ or /c/Users (C-Z only, not A or B)
    // Requires path[2] === '/' to distinguish from Unix paths like /c or /cache
    if (path.length >= 3 && path[2] === '/') {
      const driveLetter = path[1];
      if (driveLetter && /[c-zC-Z]/.test(driveLetter)) {
        return true;
      }
    }
    // Any other path starting with / is Unix absolute
    return true;
  }
  
  // Windows native path: C:\ or C:/ (any letter A-Z)
  if (path.length >= 2 && /[a-zA-Z]/.test(path[0]!) && path[1] === ':') {
    return true;
  }
  
  return false;
}

/**
 * Normalize path separators to forward slashes.
 * Converts Windows backslashes to forward slashes.
 */
export function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Get the relative path from a prefix.
 * Returns null if path is not under prefix.
 * Returns empty string if path equals prefix.
 */
export function getRelativePathFromPrefix(path: string, prefix: string): string | null {
  // Empty prefix is invalid
  if (!prefix) {
    return null;
  }
  
  const normalizedPath = normalizePathSeparators(path);
  const normalizedPrefix = normalizePathSeparators(prefix);
  
  // Ensure prefix ends with / for proper matching
  const prefixWithSlash = !normalizedPrefix.endsWith('/') 
    ? normalizedPrefix + '/' 
    : normalizedPrefix;
  
  // Exact match
  if (normalizedPath === normalizedPrefix) {
    return '';
  }
  
  // Check if path starts with prefix
  if (normalizedPath.startsWith(prefixWithSlash)) {
    return normalizedPath.slice(prefixWithSlash.length);
  }
  
  return null;
}

export function resolve(...paths: string[]): string {
  if (paths.length === 0) {
    throw new Error("resolve: at least one path segment is required");
  }
  
  // Normalize all paths to use forward slashes
  const normalizedPaths = paths.map(normalizePathSeparators);
  
  let result = '';
  let windowsDrive = '';
  
  // Check if first path is absolute
  const firstPath = normalizedPaths[0]!;
  if (isAbsolutePath(firstPath)) {
    result = firstPath;
    
    // Extract Windows drive letter if present
    if (firstPath.length >= 2 && /[a-zA-Z]/.test(firstPath[0]!) && firstPath[1] === ':') {
      windowsDrive = firstPath.slice(0, 2);
      result = firstPath.slice(2);
    } else if (firstPath.startsWith('/') && firstPath.length >= 3 && firstPath[2] === '/') {
      // Git Bash style: /c/ -> C: (C-Z drives only, not A or B)
      const driveLetter = firstPath[1];
      if (driveLetter && /[c-zC-Z]/.test(driveLetter)) {
        windowsDrive = driveLetter.toUpperCase() + ':';
        result = firstPath.slice(2);
      }
    }
  } else {
    // Start with PWD or cwd, then append the first relative path
    const pwd = normalizePathSeparators(process.env.PWD || process.cwd());
    
    // Extract Windows drive from PWD if present
    if (pwd.length >= 2 && /[a-zA-Z]/.test(pwd[0]!) && pwd[1] === ':') {
      windowsDrive = pwd.slice(0, 2);
      result = pwd.slice(2) + '/' + firstPath;
    } else {
      result = pwd + '/' + firstPath;
    }
  }
  
  // Process remaining paths
  for (let i = 1; i < normalizedPaths.length; i++) {
    const p = normalizedPaths[i]!;
    if (isAbsolutePath(p)) {
      // Absolute path replaces everything
      result = p;
      
      // Update Windows drive if present
      if (p.length >= 2 && /[a-zA-Z]/.test(p[0]!) && p[1] === ':') {
        windowsDrive = p.slice(0, 2);
        result = p.slice(2);
      } else if (p.startsWith('/') && p.length >= 3 && p[2] === '/') {
        // Git Bash style (C-Z drives only, not A or B)
        const driveLetter = p[1];
        if (driveLetter && /[c-zC-Z]/.test(driveLetter)) {
          windowsDrive = driveLetter.toUpperCase() + ':';
          result = p.slice(2);
        } else {
          windowsDrive = '';
        }
      } else {
        windowsDrive = '';
      }
    } else {
      // Relative path - append
      result = result + '/' + p;
    }
  }
  
  // Normalize . and .. components
  const parts = result.split('/').filter(Boolean);
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      normalized.pop();
    } else if (part !== '.') {
      normalized.push(part);
    }
  }
  
  // Build final path
  const finalPath = '/' + normalized.join('/');
  
  // Prepend Windows drive if present
  if (windowsDrive) {
    return windowsDrive + finalPath;
  }
  
  return finalPath;
}

// Flag to indicate production mode (set by qmd.ts at startup)
let _productionMode = false;

export function enableProductionMode(): void {
  _productionMode = true;
}

export function getDefaultDbPath(indexName: string = "index"): string {
  // Always allow override via INDEX_PATH (for testing)
  if (process.env.INDEX_PATH) {
    return process.env.INDEX_PATH;
  }

  // In non-production mode (tests), require explicit path
  if (!_productionMode) {
    throw new Error(
      "Database path not set. Tests must set INDEX_PATH env var or use createStore() with explicit path. " +
      "This prevents tests from accidentally writing to the global index."
    );
  }

  const cacheDir = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
  const qmdCacheDir = resolve(cacheDir, "qmd");
  try { mkdirSync(qmdCacheDir, { recursive: true }); } catch { }
  return resolve(qmdCacheDir, `${indexName}.sqlite`);
}

export function getPwd(): string {
  return process.env.PWD || process.cwd();
}

export function getRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// =============================================================================
// Virtual Path Utilities (qmd://)
// =============================================================================

export type VirtualPath = {
  collectionName: string;
  path: string;  // relative path within collection
};

/**
 * Normalize explicit virtual path formats to standard qmd:// format.
 * Only handles paths that are already explicitly virtual:
 * - qmd://collection/path.md (already normalized)
 * - qmd:////collection/path.md (extra slashes - normalize)
 * - //collection/path.md (missing qmd: prefix - add it)
 *
 * Does NOT handle:
 * - collection/path.md (bare paths - could be filesystem relative)
 * - :linenum suffix (should be parsed separately before calling this)
 */
export function normalizeVirtualPath(input: string): string {
  let path = input.trim();

  // Handle qmd:// with extra slashes: qmd:////collection/path -> qmd://collection/path
  if (path.startsWith('qmd:')) {
    // Remove qmd: prefix and normalize slashes
    path = path.slice(4);
    // Remove leading slashes and re-add exactly two
    path = path.replace(/^\/+/, '');
    return `qmd://${path}`;
  }

  // Handle //collection/path (missing qmd: prefix)
  if (path.startsWith('//')) {
    path = path.replace(/^\/+/, '');
    return `qmd://${path}`;
  }

  // Return as-is for other cases (filesystem paths, docids, bare collection/path, etc.)
  return path;
}

/**
 * Parse a virtual path like "qmd://collection-name/path/to/file.md"
 * into its components.
 * Also supports collection root: "qmd://collection-name/" or "qmd://collection-name"
 */
export function parseVirtualPath(virtualPath: string): VirtualPath | null {
  // Normalize the path first
  const normalized = normalizeVirtualPath(virtualPath);

  // Match: qmd://collection-name[/optional-path]
  // Allows: qmd://name, qmd://name/, qmd://name/path
  const match = normalized.match(/^qmd:\/\/([^\/]+)\/?(.*)$/);
  if (!match?.[1]) return null;
  return {
    collectionName: match[1],
    path: match[2] ?? '',  // Empty string for collection root
  };
}

/**
 * Build a virtual path from collection name and relative path.
 */
export function buildVirtualPath(collectionName: string, path: string): string {
  return `qmd://${collectionName}/${path}`;
}

/**
 * Check if a path is explicitly a virtual path.
 * Only recognizes explicit virtual path formats:
 * - qmd://collection/path.md
 * - //collection/path.md
 *
 * Does NOT consider bare collection/path.md as virtual - that should be
 * handled separately by checking if the first component is a collection name.
 */
export function isVirtualPath(path: string): boolean {
  const trimmed = path.trim();

  // Explicit qmd:// prefix (with any number of slashes)
  if (trimmed.startsWith('qmd:')) return true;

  // //collection/path format (missing qmd: prefix)
  if (trimmed.startsWith('//')) return true;

  return false;
}

/**
 * Resolve a virtual path to absolute filesystem path.
 */
export function resolveVirtualPath(db: Database, virtualPath: string): string | null {
  const parsed = parseVirtualPath(virtualPath);
  if (!parsed) return null;

  const coll = getCollectionByName(db, parsed.collectionName);
  if (!coll) return null;

  return resolve(coll.pwd, parsed.path);
}

/**
 * Convert an absolute filesystem path to a virtual path.
 * Returns null if the file is not in any indexed collection.
 */
export function toVirtualPath(db: Database, absolutePath: string): string | null {
  // Get all collections from DB
  const collections = getStoreCollections(db);

  // Find which collection this absolute path belongs to
  for (const coll of collections) {
    if (absolutePath.startsWith(coll.path + '/') || absolutePath === coll.path) {
      // Extract relative path
      const relativePath = absolutePath.startsWith(coll.path + '/')
        ? absolutePath.slice(coll.path.length + 1)
        : '';

      // Verify this document exists in the database
      const doc = db.prepare(`
        SELECT d.path
        FROM documents d
        WHERE d.collection = ? AND d.path = ? AND d.active = 1
        LIMIT 1
      `).get(coll.name, relativePath) as { path: string } | null;

      if (doc) {
        return buildVirtualPath(coll.name, relativePath);
      }
    }
  }

  return null;
}

// =============================================================================
// Database initialization
// =============================================================================


function createSqliteVecUnavailableError(reason: string): Error {
  return new Error(
    "sqlite-vec extension is unavailable. " +
    `${reason}. ` +
    "Install Homebrew SQLite so the sqlite-vec extension can be loaded, " +
    "and set BREW_PREFIX if Homebrew is installed in a non-standard location."
  );
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function verifySqliteVecLoaded(db: Database): void {
  try {
    const row = db.prepare(`SELECT vec_version() AS version`).get() as { version?: string } | null;
    if (!row?.version || typeof row.version !== "string") {
      throw new Error("vec_version() returned no version");
    }
  } catch (err) {
    const message = getErrorMessage(err);
    throw createSqliteVecUnavailableError(`sqlite-vec probe failed (${message})`);
  }
}

function initializeDatabase(db: Database): { vecAvailable: boolean } {
  let vecAvailable = false;
  try {
    loadSqliteVec(db);
    verifySqliteVecLoaded(db);
    vecAvailable = true;
  } catch {
    // sqlite-vec is optional — vector search won't work but FTS is fine
  }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  // Drop legacy tables that are now managed in YAML
  db.exec(`DROP TABLE IF EXISTS path_contexts`);
  db.exec(`DROP TABLE IF EXISTS collections`);

  // Content-addressable storage - the source of truth for document content
  db.exec(`
    CREATE TABLE IF NOT EXISTS content (
      hash TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Documents table - file system layer mapping virtual paths to content hashes
  // Collections are now managed in ~/.config/qmd/index.yml
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
      FOREIGN KEY (hash) REFERENCES content(hash) ON DELETE CASCADE,
      UNIQUE(collection, path)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection, active)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path, active)`);

  // Cache table for LLM API calls
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_cache (
      hash TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Content vectors
  const cvInfo = db.prepare(`PRAGMA table_info(content_vectors)`).all() as { name: string }[];
  const hasSeqColumn = cvInfo.some(col => col.name === 'seq');
  if (cvInfo.length > 0 && !hasSeqColumn) {
    db.exec(`DROP TABLE IF EXISTS content_vectors`);
    db.exec(`DROP TABLE IF EXISTS vectors_vec`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_vectors (
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      pos INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (hash, seq)
    )
  `);

  // Store collections — makes the DB self-contained (no external config needed)
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_collections (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      pattern TEXT NOT NULL DEFAULT '**/*.md',
      ignore_patterns TEXT,
      include_by_default INTEGER DEFAULT 1,
      update_command TEXT,
      context TEXT,
      type TEXT DEFAULT 'raw'
    )
  `);

  // Store config — key-value metadata (e.g. config_hash for sync optimization)
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Forward/backward link tracking (populated during indexing)
  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      source    TEXT NOT NULL,
      target    TEXT NOT NULL,
      link_type TEXT NOT NULL,
      anchor    TEXT,
      line      INTEGER,
      UNIQUE(source, target, line)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_links_source ON links(source)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_links_target ON links(target)`);

  // PDF per-page full-text cache (populated during indexing)
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages_cache (
      docid    TEXT NOT NULL,
      page_idx INTEGER NOT NULL,
      text     TEXT NOT NULL,
      tokens   INTEGER,
      source   TEXT NOT NULL,
      PRIMARY KEY (docid, page_idx)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pages_cache_docid ON pages_cache(docid)`);

  // PDF table-of-contents cache (cloud-inferred or native bookmarks)
  db.exec(`
    CREATE TABLE IF NOT EXISTS toc_cache (
      docid      TEXT PRIMARY KEY,
      sections   TEXT NOT NULL,
      source     TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  // Docx section map (heading-level navigation)
  db.exec(`
    CREATE TABLE IF NOT EXISTS section_map (
      docid       TEXT NOT NULL,
      section_idx INTEGER NOT NULL,
      heading     TEXT,
      level       INTEGER,
      line_start  INTEGER NOT NULL,
      line_end    INTEGER NOT NULL,
      PRIMARY KEY (docid, section_idx)
    )
  `);

  // PPTX slide cache (per-slide content)
  db.exec(`
    CREATE TABLE IF NOT EXISTS slide_cache (
      docid     TEXT NOT NULL,
      slide_idx INTEGER NOT NULL,
      title     TEXT,
      text      TEXT NOT NULL,
      tokens    INTEGER,
      PRIMARY KEY (docid, slide_idx)
    )
  `);

  // FTS - index filepath (collection/path), title, and content
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      filepath, title, body,
      tokenize='porter unicode61'
    )
  `);

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents
    WHEN new.active = 1
    BEGIN
      INSERT INTO documents_fts(rowid, filepath, title, body)
      SELECT
        new.id,
        new.collection || '/' || new.path,
        new.title,
        (SELECT doc FROM content WHERE hash = new.hash)
      WHERE new.active = 1;
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      DELETE FROM documents_fts WHERE rowid = old.id;
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents
    BEGIN
      -- Delete from FTS if no longer active
      DELETE FROM documents_fts WHERE rowid = old.id AND new.active = 0;

      -- Update FTS if still/newly active
      INSERT OR REPLACE INTO documents_fts(rowid, filepath, title, body)
      SELECT
        new.id,
        new.collection || '/' || new.path,
        new.title,
        (SELECT doc FROM content WHERE hash = new.hash)
      WHERE new.active = 1;
    END
  `);

  // Initialize schema versioning and run migrations
  initializeSchema(db);

  return { vecAvailable };
}

// =============================================================================
// Store Collections — DB accessor functions
// =============================================================================

type StoreCollectionRow = {
  name: string;
  path: string;
  pattern: string;
  ignore_patterns: string | null;
  include_by_default: number;
  update_command: string | null;
  context: string | null;
  type: string | null;
};

function safeJsonParse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try { return JSON.parse(json) as T; } catch { return fallback; }
}

function rowToNamedCollection(row: StoreCollectionRow): NamedCollection {
  return {
    name: row.name,
    path: row.path,
    pattern: row.pattern,
    ...(row.ignore_patterns ? { ignore: safeJsonParse<string[]>(row.ignore_patterns, []) } : {}),
    ...(row.include_by_default === 0 ? { includeByDefault: false } : {}),
    ...(row.update_command ? { update: row.update_command } : {}),
    ...(row.context ? { context: safeJsonParse<ContextMap>(row.context, {}) } : {}),
    ...(row.type === 'wiki' ? { type: 'wiki' as const } : {}),
  };
}

export function getStoreCollections(db: Database): NamedCollection[] {
  const rows = db.prepare(`SELECT * FROM store_collections`).all() as StoreCollectionRow[];
  return rows.map(rowToNamedCollection);
}

export function getStoreCollection(db: Database, name: string): NamedCollection | null {
  const row = db.prepare(`SELECT * FROM store_collections WHERE name = ?`).get(name) as StoreCollectionRow | null | undefined;
  if (row == null) return null;
  return rowToNamedCollection(row);
}

export function getStoreGlobalContext(db: Database): string | undefined {
  const row = db.prepare(`SELECT value FROM store_config WHERE key = 'global_context'`).get() as { value: string } | null | undefined;
  if (row == null) return undefined;
  return row.value || undefined;
}

export function getStoreContexts(db: Database): Array<{ collection: string; path: string; context: string }> {
  const results: Array<{ collection: string; path: string; context: string }> = [];

  // Global context
  const globalCtx = getStoreGlobalContext(db);
  if (globalCtx) {
    results.push({ collection: "*", path: "/", context: globalCtx });
  }

  // Collection contexts
  const rows = db.prepare(`SELECT name, context FROM store_collections WHERE context IS NOT NULL`).all() as { name: string; context: string }[];
  for (const row of rows) {
    const ctxMap = safeJsonParse<ContextMap>(row.context, {});
    for (const [path, context] of Object.entries(ctxMap)) {
      results.push({ collection: row.name, path, context });
    }
  }

  return results;
}

export function upsertStoreCollection(db: Database, name: string, collection: Omit<Collection, 'pattern'> & { pattern?: string }): void {
  db.prepare(`
    INSERT INTO store_collections (name, path, pattern, ignore_patterns, include_by_default, update_command, context, type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      path = excluded.path,
      pattern = excluded.pattern,
      ignore_patterns = excluded.ignore_patterns,
      include_by_default = excluded.include_by_default,
      update_command = excluded.update_command,
      context = excluded.context,
      type = excluded.type
  `).run(
    name,
    collection.path,
    collection.pattern || '**/*.md',
    collection.ignore ? JSON.stringify(collection.ignore) : null,
    collection.includeByDefault === false ? 0 : 1,
    collection.update || null,
    collection.context ? JSON.stringify(collection.context) : null,
    collection.type || 'raw',
  );
}

export function deleteStoreCollection(db: Database, name: string): boolean {
  const result = db.prepare(`DELETE FROM store_collections WHERE name = ?`).run(name);
  return result.changes > 0;
}

export function renameStoreCollection(db: Database, oldName: string, newName: string): boolean {
  const existing = db.prepare(`SELECT name FROM store_collections WHERE name = ?`).get(newName) as { name: string } | null | undefined;
  if (existing != null) {
    throw new Error(`Collection '${newName}' already exists`);
  }

  // Wrap in a transaction for atomicity — all tables update together or none do
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(`UPDATE store_collections SET name = ? WHERE name = ?`).run(newName, oldName);
    if (result.changes === 0) {
      db.exec("ROLLBACK");
      return false;
    }

    db.prepare(`UPDATE documents SET collection = ? WHERE collection = ?`).run(newName, oldName);

    const docs = db.prepare(
      `SELECT id, path FROM documents WHERE collection = ?`
    ).all(newName) as { id: number; path: string }[];
    for (const doc of docs) {
      db.prepare(
        `UPDATE documents_fts SET filepath = ? WHERE rowid = ?`
      ).run(newName + '/' + doc.path, doc.id);
    }

    db.prepare(
      `UPDATE links SET source = ? || substr(source, ?) WHERE source LIKE ?`
    ).run(newName, oldName.length + 1, oldName + '/%');

    try {
      db.prepare(
        `UPDATE wiki_sources SET wiki_collection = ?, wiki_file = ? || substr(wiki_file, ?) WHERE wiki_collection = ?`
      ).run(newName, newName, oldName.length + 1, oldName);
    } catch { /* table may not exist */ }
    try {
      db.prepare(
        `UPDATE wiki_ingest_tracker SET wiki_collection = ? WHERE wiki_collection = ?`
      ).run(newName, oldName);
    } catch { /* table may not exist */ }

    db.exec("COMMIT");
    return true;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* ignore rollback errors */ }
    throw e;
  }
}

export function updateStoreContext(db: Database, collectionName: string, path: string, text: string): boolean {
  const row = db.prepare(`SELECT context FROM store_collections WHERE name = ?`).get(collectionName) as { context: string | null } | null | undefined;
  if (row == null) return false;

  const ctxMap: ContextMap = safeJsonParse<ContextMap>(row.context, {});
  ctxMap[path] = text;
  db.prepare(`UPDATE store_collections SET context = ? WHERE name = ?`).run(JSON.stringify(ctxMap), collectionName);
  return true;
}

export function removeStoreContext(db: Database, collectionName: string, path: string): boolean {
  const row = db.prepare(`SELECT context FROM store_collections WHERE name = ?`).get(collectionName) as { context: string | null } | null | undefined;
  if (row == null) return false;
  if (!row.context) return false;

  const ctxMap: ContextMap = safeJsonParse<ContextMap>(row.context, {});
  if (!(path in ctxMap)) return false;

  delete ctxMap[path];
  const newCtx = Object.keys(ctxMap).length > 0 ? JSON.stringify(ctxMap) : null;
  db.prepare(`UPDATE store_collections SET context = ? WHERE name = ?`).run(newCtx, collectionName);
  return true;
}

export function getWikiCollections(db: Database): NamedCollection[] {
  const rows = db.prepare(`SELECT * FROM store_collections WHERE type = 'wiki'`).all() as StoreCollectionRow[];
  return rows.map(rowToNamedCollection);
}

export function isWikiCollection(db: Database, name: string): boolean {
  const row = db.prepare(`SELECT type FROM store_collections WHERE name = ?`).get(name) as { type: string | null } | null | undefined;
  return row?.type === 'wiki';
}

export function setStoreGlobalContext(db: Database, value: string | undefined): void {
  if (value === undefined) {
    db.prepare(`DELETE FROM store_config WHERE key = 'global_context'`).run();
  } else {
    db.prepare(`INSERT INTO store_config (key, value) VALUES ('global_context', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(value);
  }
}

/**
 * Sync external config (YAML/inline) into SQLite store_collections.
 * External config always wins. Skips sync if config hash hasn't changed.
 */
export function syncConfigToDb(db: Database, config: CollectionConfig): void {
  const configJson = JSON.stringify(config);
  const hash = createHash('sha256').update(configJson).digest('hex');

  const existingHash = db.prepare(`SELECT value FROM store_config WHERE key = 'config_hash'`).get() as { value: string } | null | undefined;
  if (existingHash != null && existingHash.value === hash) {
    return;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const configNames = new Set(Object.keys(config.collections));

    for (const [name, coll] of Object.entries(config.collections)) {
      upsertStoreCollection(db, name, coll);
    }

    const dbCollections = db.prepare(`SELECT name FROM store_collections`).all() as { name: string }[];
    for (const row of dbCollections) {
      if (!configNames.has(row.name)) {
        db.prepare(`DELETE FROM store_collections WHERE name = ?`).run(row.name);
      }
    }

    if (config.global_context !== undefined) {
      setStoreGlobalContext(db, config.global_context);
    } else {
      setStoreGlobalContext(db, undefined);
    }

    db.prepare(`INSERT INTO store_config (key, value) VALUES ('config_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(hash);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}


function ensureVecTableInternal(db: Database, dimensions: number, vecAvailable: boolean): void {
  if (!vecAvailable) {
    throw new Error("sqlite-vec is not available. Vector operations require a SQLite build with extension loading support.");
  }
  const tableInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get() as { sql: string } | null;
  if (tableInfo) {
    const match = tableInfo.sql.match(/float\[(\d+)\]/);
    const hasHashSeq = tableInfo.sql.includes('hash_seq');
    const hasCosine = tableInfo.sql.includes('distance_metric=cosine');
    const existingDims = match?.[1] ? parseInt(match[1], 10) : null;
    if (existingDims === dimensions && hasHashSeq && hasCosine) return;
    // Table exists but wrong schema - need to rebuild
    db.exec("DROP TABLE IF EXISTS vectors_vec");
  }
  db.exec(`CREATE VIRTUAL TABLE vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`);
}

// =============================================================================
// Store Factory
// =============================================================================

export type Store = {
  db: Database;
  dbPath: string;
  /** Whether the sqlite-vec extension loaded successfully (set once at DB open) */
  vecAvailable: boolean;
  /** Optional LlamaCpp instance for this store (overrides the global singleton) */
  llm?: LlamaCpp;
  close: () => void;
  ensureVecTable: (dimensions: number) => void;

  // Index health
  getHashesNeedingEmbedding: () => number;
  getIndexHealth: () => IndexHealthInfo;
  getStatus: () => IndexStatus;

  // Caching
  getCacheKey: typeof getCacheKey;
  getCachedResult: (cacheKey: string) => string | null;
  setCachedResult: (cacheKey: string, result: string) => void;
  clearCache: () => void;

  // Cleanup and maintenance
  deleteLLMCache: () => number;
  deleteInactiveDocuments: () => number;
  cleanupOrphanedContent: () => number;
  cleanupOrphanedVectors: () => number;
  vacuumDatabase: () => void;

  // Context
  getContextForFile: (filepath: string) => string | null;
  getContextForPath: (collectionName: string, path: string) => string | null;
  getCollectionByName: (name: string) => { name: string; pwd: string; glob_pattern: string } | null;
  getCollectionsWithoutContext: () => { name: string; pwd: string; doc_count: number }[];
  getTopLevelPathsWithoutContext: (collectionName: string) => string[];

  // Virtual paths
  parseVirtualPath: typeof parseVirtualPath;
  buildVirtualPath: typeof buildVirtualPath;
  isVirtualPath: typeof isVirtualPath;
  resolveVirtualPath: (virtualPath: string) => string | null;
  toVirtualPath: (absolutePath: string) => string | null;

  // Search
  searchFTS: (query: string, limit?: number, collectionName?: string) => SearchResult[];
  searchVec: (query: string, model: string, limit?: number, collectionName?: string, session?: ILLMSession, precomputedEmbedding?: number[]) => Promise<SearchResult[]>;

  // Query expansion & reranking
  expandQuery: (query: string, model?: string, intent?: string) => Promise<ExpandedQuery[]>;
  rerank: (query: string, documents: { file: string; text: string }[], model?: string, intent?: string) => Promise<{ file: string; score: number }[]>;

  // Document retrieval
  findDocument: (filename: string, options?: { includeBody?: boolean }) => DocumentResult | DocumentNotFound;
  getDocumentBody: (doc: DocumentResult | { filepath: string }, fromLine?: number, maxLines?: number) => string | null;
  findDocuments: (pattern: string, options?: { includeBody?: boolean; maxBytes?: number }) => { docs: MultiGetResult[]; errors: string[] };

  // Fuzzy matching and docid lookup
  findSimilarFiles: (query: string, maxDistance?: number, limit?: number) => string[];
  matchFilesByGlob: (pattern: string) => { filepath: string; displayPath: string; bodyLength: number }[];
  findDocumentByDocid: (docid: string) => { filepath: string; hash: string } | null;

  // Document indexing operations
  insertContent: (hash: string, content: string, createdAt: string) => void;
  insertDocument: (collectionName: string, path: string, title: string, hash: string, createdAt: string, modifiedAt: string) => void;
  findActiveDocument: (collectionName: string, path: string) => { id: number; hash: string; title: string } | null;
  updateDocumentTitle: (documentId: number, title: string, modifiedAt: string) => void;
  updateDocument: (documentId: number, title: string, hash: string, modifiedAt: string) => void;
  deactivateDocument: (collectionName: string, path: string) => void;
  getActiveDocumentPaths: (collectionName: string) => string[];

  // Vector/embedding operations
  getHashesForEmbedding: (collections?: string[]) => { hash: string; body: string; path: string }[];
  clearAllEmbeddings: () => void;
  insertEmbedding: (hash: string, seq: number, pos: number, embedding: Float32Array, model: string, embeddedAt: string) => void;

  // Backend cache for multi-format document reading
  _backends?: Map<string, any>;
};

// =============================================================================
// Reindex & Embed — pure-logic functions for SDK and CLI
// =============================================================================

export type ReindexProgress = {
  file: string;
  current: number;
  total: number;
};

export type ReindexResult = {
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  orphanedCleaned: number;
};

/**
 * Re-index a single collection by scanning the filesystem and updating the database.
 * Pure function — no console output, no db lifecycle management.
 */
export async function reindexCollection(
  store: Store,
  collectionPath: string,
  globPattern: string,
  collectionName: string,
  options?: {
    ignorePatterns?: string[];
    onProgress?: (info: ReindexProgress) => void;
  }
): Promise<ReindexResult> {
  const db = store.db;
  const now = new Date().toISOString();
  const excludeDirs = ["node_modules", ".git", ".cache", "vendor", "dist", "build"];

  const allIgnore = [
    ...excludeDirs.map(d => `**/${d}/**`),
    ...(options?.ignorePatterns || []),
  ];
  const allFiles: string[] = await fastGlob(globPattern, {
    cwd: collectionPath,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: false,
    ignore: allIgnore,
  });
  // Filter hidden files/folders
  const files = allFiles.filter(file => {
    const parts = file.split("/");
    return !parts.some(part => part.startsWith("."));
  });

  const total = files.length;
  let indexed = 0, updated = 0, unchanged = 0, processed = 0;
  const seenPaths = new Set<string>();

  for (const relativeFile of files) {
    const filepath = getRealPath(resolve(collectionPath, relativeFile));
    const path = handelize(relativeFile);
    seenPaths.add(path);

    const fileExt = relativeFile.split('.').pop()?.toLowerCase();

    if (fileExt === 'pdf') {
      const { callPythonScript } = await import("./backends/python-utils.js");
      const { getProviders, getMinerUCredentials, getLocalModelConfig } = await import("./doc-reading-config.js");
      const { extractPdf, indexBinaryDocument } = await import("./backends/indexing.js");

      const extraction = await extractPdf(filepath, relativeFile, {
        callPythonScript, getProviders, getMinerUCredentials, getLocalModelConfig, extractTitle,
      });
      if (!extraction) {
        processed++;
        options?.onProgress?.({ file: relativeFile, current: processed, total });
        continue;
      }
      const result = await indexBinaryDocument(db, extraction, collectionName, path, filepath, now, {
        hashContent, findActiveDocument, insertContent, insertDocument, updateDocument,
      });
      if (result === "indexed") indexed++;
      else if (result === "updated") updated++;
      else unchanged++;
      processed++;
      options?.onProgress?.({ file: relativeFile, current: processed, total });
      continue;
    }

    if (fileExt === 'docx' || fileExt === 'doc') {
      const { extractDocx, getPythonError } = await import("./backends/python-utils.js");
      const { extractDocxForIndex, indexBinaryDocument } = await import("./backends/indexing.js");

      const extraction = await extractDocxForIndex(filepath, relativeFile, {
        extractDocx, getPythonError, extractTitle,
      });
      if (!extraction) {
        processed++;
        options?.onProgress?.({ file: relativeFile, current: processed, total });
        continue;
      }
      const result = await indexBinaryDocument(db, extraction, collectionName, path, filepath, now, {
        hashContent, findActiveDocument, insertContent, insertDocument, updateDocument,
      });
      if (result === "indexed") indexed++;
      else if (result === "updated") updated++;
      else unchanged++;
      processed++;
      options?.onProgress?.({ file: relativeFile, current: processed, total });
      continue;
    }

    if (fileExt === 'pptx' || fileExt === 'ppt') {
      const { extractPptx, getPythonError } = await import("./backends/python-utils.js");
      const { extractPptxForIndex, indexBinaryDocument } = await import("./backends/indexing.js");

      const extraction = await extractPptxForIndex(filepath, relativeFile, {
        extractPptx, getPythonError,
      });
      if (!extraction) {
        processed++;
        options?.onProgress?.({ file: relativeFile, current: processed, total });
        continue;
      }
      const result = await indexBinaryDocument(db, extraction, collectionName, path, filepath, now, {
        hashContent, findActiveDocument, insertContent, insertDocument, updateDocument,
      });
      if (result === "indexed") indexed++;
      else if (result === "updated") updated++;
      else unchanged++;
      processed++;
      options?.onProgress?.({ file: relativeFile, current: processed, total });
      continue;
    }

    let content: string;
    try {
      content = readFileSync(filepath, "utf-8");
    } catch {
      processed++;
      options?.onProgress?.({ file: relativeFile, current: processed, total });
      continue;
    }

    if (!content.trim()) {
      processed++;
      continue;
    }

    const hash = await hashContent(content);
    const title = extractTitle(content, relativeFile);

    const existing = findActiveDocument(db, collectionName, path);

    if (existing) {
      if (existing.hash === hash) {
        if (existing.title !== title) {
          updateDocumentTitle(db, existing.id, title, now);
          updated++;
        } else {
          unchanged++;
        }
      } else {
        insertContent(db, hash, content, now);
        const stat = statSync(filepath);
        updateDocument(db, existing.id, title, hash,
          stat ? new Date(stat.mtime).toISOString() : now);
        updated++;
      }
    } else {
      indexed++;
      insertContent(db, hash, content, now);
      const stat = statSync(filepath);
      insertDocument(db, collectionName, path, title, hash,
        stat ? new Date(stat.birthtime).toISOString() : now,
        stat ? new Date(stat.mtime).toISOString() : now);
    }

    // Parse and store links for markdown files
    if (relativeFile.endsWith('.md') || relativeFile.endsWith('.markdown')) {
      const virtualSource = collectionName + '/' + path;
      db.prepare('DELETE FROM links WHERE source = ?').run(virtualSource);
      const parsedLinks = parseLinks(content);
      if (parsedLinks.length > 0) {
        const insertLink = db.prepare(
          'INSERT OR IGNORE INTO links (source, target, link_type, anchor, line) VALUES (?, ?, ?, ?, ?)'
        );
        for (const lnk of parsedLinks) {
          insertLink.run(virtualSource, lnk.target, lnk.link_type, lnk.anchor ?? null, lnk.line);
        }
      }
    }

    processed++;
    options?.onProgress?.({ file: relativeFile, current: processed, total });
  }

  // Deactivate documents that no longer exist
  const allActive = getActiveDocumentPaths(db, collectionName);
  let removed = 0;
  for (const path of allActive) {
    if (!seenPaths.has(path)) {
      deactivateDocument(db, collectionName, path);
      removed++;
    }
  }

  const orphanedCleaned = cleanupOrphanedContent(db);

  return { indexed, updated, unchanged, removed, orphanedCleaned };
}

export type EmbedProgress = {
  chunksEmbedded: number;
  totalChunks: number;
  bytesProcessed: number;
  totalBytes: number;
  errors: number;
};

export type EmbedResult = {
  docsProcessed: number;
  chunksEmbedded: number;
  errors: number;
  durationMs: number;
};

/**
 * Generate vector embeddings for documents that need them.
 * Pure function — no console output, no db lifecycle management.
 * Uses the store's LlamaCpp instance if set, otherwise the global singleton.
 */
export async function generateEmbeddings(
  store: Store,
  options?: {
    force?: boolean;
    model?: string;
    collections?: string[];
    onProgress?: (info: EmbedProgress) => void;
  }
): Promise<EmbedResult> {
  const db = store.db;
  const model = options?.model ?? DEFAULT_EMBED_MODEL;
  const now = new Date().toISOString();

  if (options?.force) {
    clearAllEmbeddings(db);
  }

  const hashesToEmbed = getHashesForEmbedding(db, options?.collections);

  if (hashesToEmbed.length === 0) {
    return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 };
  }

  // Chunk all documents
  type ChunkItem = { hash: string; title: string; text: string; seq: number; pos: number; tokens: number; bytes: number };
  const allChunks: ChunkItem[] = [];

  for (const item of hashesToEmbed) {
    const encoder = new TextEncoder();
    const bodyBytes = encoder.encode(item.body).length;
    if (bodyBytes === 0) continue;

    const title = extractTitle(item.body, item.path);
    const chunks = await chunkDocumentByTokens(item.body);

    for (let seq = 0; seq < chunks.length; seq++) {
      allChunks.push({
        hash: item.hash,
        title,
        text: chunks[seq]!.text,
        seq,
        pos: chunks[seq]!.pos,
        tokens: chunks[seq]!.tokens,
        bytes: encoder.encode(chunks[seq]!.text).length,
      });
    }
  }

  if (allChunks.length === 0) {
    return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 };
  }

  const totalBytes = allChunks.reduce((sum, chk) => sum + chk.bytes, 0);
  const totalChunks = allChunks.length;
  const totalDocs = hashesToEmbed.length;
  const startTime = Date.now();

  // Use store's LlamaCpp or global singleton, wrapped in a session
  const llm = getLlm(store);
  const sessionOptions: LLMSessionOptions = { maxDuration: 30 * 60 * 1000, name: 'generateEmbeddings' };

  // Create a session manager for this llm instance
  const result = await withLLMSessionForLlm(llm, async (session) => {
    // Get embedding dimensions from first chunk
    const firstChunk = allChunks[0]!;
    const firstText = formatDocForEmbedding(firstChunk.text, firstChunk.title);
    const firstResult = await session.embed(firstText);
    if (!firstResult) {
      throw new Error("Failed to get embedding dimensions from first chunk");
    }
    store.ensureVecTable(firstResult.embedding.length);

    let chunksEmbedded = 0, errors = 0, bytesProcessed = 0;
    const BATCH_SIZE = 32;

    for (let batchStart = 0; batchStart < allChunks.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, allChunks.length);
      const batch = allChunks.slice(batchStart, batchEnd);
      const texts = batch.map(chunk => formatDocForEmbedding(chunk.text, chunk.title));

      try {
        const embeddings = await session.embedBatch(texts);
        db.exec("BEGIN");
        try {
          for (let i = 0; i < batch.length; i++) {
            const chunk = batch[i]!;
            const embedding = embeddings[i];
            if (embedding) {
              insertEmbedding(db, chunk.hash, chunk.seq, chunk.pos, new Float32Array(embedding.embedding), model, now);
              chunksEmbedded++;
            } else {
              errors++;
            }
            bytesProcessed += chunk.bytes;
          }
          db.exec("COMMIT");
        } catch (txErr) {
          db.exec("ROLLBACK");
          throw txErr;
        }
      } catch {
        for (const chunk of batch) {
          try {
            const text = formatDocForEmbedding(chunk.text, chunk.title);
            const result = await session.embed(text);
            if (result) {
              insertEmbedding(db, chunk.hash, chunk.seq, chunk.pos, new Float32Array(result.embedding), model, now);
              chunksEmbedded++;
            } else {
              errors++;
            }
          } catch {
            errors++;
          }
          bytesProcessed += chunk.bytes;
        }
      }

      options?.onProgress?.({ chunksEmbedded, totalChunks, bytesProcessed, totalBytes, errors });
    }

    return { chunksEmbedded, errors };
  }, sessionOptions);

  return {
    docsProcessed: totalDocs,
    chunksEmbedded: result.chunksEmbedded,
    errors: result.errors,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Create a new store instance with the given database path.
 * If no path is provided, uses the default path (~/.cache/qmd/index.sqlite).
 *
 * @param dbPath - Path to the SQLite database file
 * @returns Store instance with all methods bound to the database
 */
export function createStore(dbPath?: string): Store {
  const resolvedPath = dbPath || getDefaultDbPath();
  const db = openDatabase(resolvedPath);
  const { vecAvailable } = initializeDatabase(db);

  const store: Store = {
    db,
    dbPath: resolvedPath,
    vecAvailable,
    close: () => db.close(),
    ensureVecTable: (dimensions: number) => ensureVecTableInternal(db, dimensions, vecAvailable),

    // Index health
    getHashesNeedingEmbedding: () => getHashesNeedingEmbedding(db),
    getIndexHealth: () => getIndexHealth(db),
    getStatus: () => getStatus(db),

    // Caching
    getCacheKey,
    getCachedResult: (cacheKey: string) => getCachedResult(db, cacheKey),
    setCachedResult: (cacheKey: string, result: string) => setCachedResult(db, cacheKey, result),
    clearCache: () => clearCache(db),

    // Cleanup and maintenance
    deleteLLMCache: () => deleteLLMCache(db),
    deleteInactiveDocuments: () => deleteInactiveDocuments(db),
    cleanupOrphanedContent: () => cleanupOrphanedContent(db),
    cleanupOrphanedVectors: () => cleanupOrphanedVectors(db),
    vacuumDatabase: () => vacuumDatabase(db),

    // Context
    getContextForFile: (filepath: string) => getContextForFile(db, filepath),
    getContextForPath: (collectionName: string, path: string) => getContextForPath(db, collectionName, path),
    getCollectionByName: (name: string) => getCollectionByName(db, name),
    getCollectionsWithoutContext: () => getCollectionsWithoutContext(db),
    getTopLevelPathsWithoutContext: (collectionName: string) => getTopLevelPathsWithoutContext(db, collectionName),

    // Virtual paths
    parseVirtualPath,
    buildVirtualPath,
    isVirtualPath,
    resolveVirtualPath: (virtualPath: string) => resolveVirtualPath(db, virtualPath),
    toVirtualPath: (absolutePath: string) => toVirtualPath(db, absolutePath),

    // Search
    searchFTS: (query: string, limit?: number, collectionName?: string) => searchFTS(db, query, limit, collectionName),
    searchVec: (query: string, model: string, limit?: number, collectionName?: string, session?: ILLMSession, precomputedEmbedding?: number[]) => searchVec(db, query, model, limit, collectionName, session, precomputedEmbedding, vecAvailable),

    // Query expansion & reranking
    expandQuery: (query: string, model?: string, intent?: string) => expandQuery(query, model, db, intent, store.llm),
    rerank: (query: string, documents: { file: string; text: string }[], model?: string, intent?: string) => rerank(query, documents, model, db, intent, store.llm),

    // Document retrieval
    findDocument: (filename: string, options?: { includeBody?: boolean }) => findDocument(db, filename, options),
    getDocumentBody: (doc: DocumentResult | { filepath: string }, fromLine?: number, maxLines?: number) => getDocumentBody(db, doc, fromLine, maxLines),
    findDocuments: (pattern: string, options?: { includeBody?: boolean; maxBytes?: number }) => findDocuments(db, pattern, options),

    // Fuzzy matching and docid lookup
    findSimilarFiles: (query: string, maxDistance?: number, limit?: number) => findSimilarFiles(db, query, maxDistance, limit),
    matchFilesByGlob: (pattern: string) => matchFilesByGlob(db, pattern),
    findDocumentByDocid: (docid: string) => findDocumentByDocid(db, docid),

    // Document indexing operations
    insertContent: (hash: string, content: string, createdAt: string) => insertContent(db, hash, content, createdAt),
    insertDocument: (collectionName: string, path: string, title: string, hash: string, createdAt: string, modifiedAt: string) => insertDocument(db, collectionName, path, title, hash, createdAt, modifiedAt),
    findActiveDocument: (collectionName: string, path: string) => findActiveDocument(db, collectionName, path),
    updateDocumentTitle: (documentId: number, title: string, modifiedAt: string) => updateDocumentTitle(db, documentId, title, modifiedAt),
    updateDocument: (documentId: number, title: string, hash: string, modifiedAt: string) => updateDocument(db, documentId, title, hash, modifiedAt),
    deactivateDocument: (collectionName: string, path: string) => deactivateDocument(db, collectionName, path),
    getActiveDocumentPaths: (collectionName: string) => getActiveDocumentPaths(db, collectionName),

    // Vector/embedding operations
    getHashesForEmbedding: (collections?: string[]) => getHashesForEmbedding(db, collections),
    clearAllEmbeddings: () => clearAllEmbeddings(db),
    insertEmbedding: (hash: string, seq: number, pos: number, embedding: Float32Array, model: string, embeddedAt: string) => insertEmbedding(db, hash, seq, pos, embedding, model, embeddedAt),
  };

  return store;
}

// =============================================================================
// Core Document Type
// =============================================================================

/**
 * Unified document result type with all metadata.
 * Body is optional - use getDocumentBody() to load it separately if needed.
 */
export type DocumentResult = {
  filepath: string;           // Full filesystem path
  displayPath: string;        // Short display path (e.g., "docs/readme.md")
  title: string;              // Document title (from first heading or filename)
  context: string | null;     // Folder context description if configured
  hash: string;               // Content hash for caching/change detection
  docid: string;              // Short docid (first 6 chars of hash) for quick reference
  collectionName: string;     // Parent collection name
  modifiedAt: string;         // Last modification timestamp
  bodyLength: number;         // Body length in bytes (useful before loading)
  body?: string;              // Document body (optional, load with getDocumentBody)
};

/**
 * Extract short docid from a full hash (first 6 characters).
 */
export function getDocid(hash: string): string {
  return hash.slice(0, 6);
}

/**
 * Handelize a filename to be more token-friendly.
 * - Convert triple underscore `___` to `/` (folder separator)
 * - Convert to lowercase
 * - Replace sequences of non-word chars (except /) with single dash
 * - Remove leading/trailing dashes from path segments
 * - Preserve folder structure (a/b/c/d.md stays structured)
 * - Preserve file extension
 */
/** Replace emoji/symbol codepoints with their hex representation (e.g. 🐘 → 1f418) */
function emojiToHex(str: string): string {
  return str.replace(/(?:\p{So}\p{Mn}?|\p{Sk})+/gu, (run) => {
    // Split the run into individual emoji and convert each to hex, dash-separated
    return [...run].filter(c => /\p{So}|\p{Sk}/u.test(c))
      .map(c => c.codePointAt(0)!.toString(16)).join('-');
  });
}

export function handelize(path: string): string {
  if (!path || path.trim() === '') {
    throw new Error('handelize: path cannot be empty');
  }

  // Allow route-style "$" filenames while still rejecting paths with no usable content.
  // Emoji (\p{So}) counts as valid content — they get converted to hex codepoints below.
  const segments = path.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] || '';
  const filenameWithoutExt = lastSegment.replace(/\.[^.]+$/, '');
  const hasValidContent = /[\p{L}\p{N}\p{So}\p{Sk}$]/u.test(filenameWithoutExt);
  if (!hasValidContent) {
    throw new Error(`handelize: path "${path}" has no valid filename content`);
  }

  const result = path
    .replace(/___/g, '/')       // Triple underscore becomes folder separator
    .toLowerCase()
    .split('/')
    .map((segment, idx, arr) => {
      const isLastSegment = idx === arr.length - 1;

      // Convert emoji to hex codepoints before cleaning
      segment = emojiToHex(segment);

      if (isLastSegment) {
        // For the filename (last segment), preserve the extension
        const extMatch = segment.match(/(\.[a-z0-9]+)$/i);
        const ext = extMatch ? extMatch[1] : '';
        const nameWithoutExt = ext ? segment.slice(0, -ext.length) : segment;

        const cleanedName = nameWithoutExt
          .replace(/[^\p{L}\p{N}$]+/gu, '-')  // Keep route marker "$", dash-separate other chars
          .replace(/^-+|-+$/g, ''); // Remove leading/trailing dashes

        return cleanedName + ext;
      } else {
        // For directories, just clean normally
        return segment
          .replace(/[^\p{L}\p{N}$]+/gu, '-')
          .replace(/^-+|-+$/g, '');
      }
    })
    .filter(Boolean)
    .join('/');

  if (!result) {
    throw new Error(`handelize: path "${path}" resulted in empty string after processing`);
  }

  return result;
}

/**
 * Search result extends DocumentResult with score and source info
 */
export type SearchResult = DocumentResult & {
  score: number;              // Relevance score (0-1)
  source: "fts" | "vec";      // Search source (full-text or vector)
  chunkPos?: number;          // Character position of matching chunk (for vector search)
};

// HybridQueryExplain — re-exported from hybrid-search.ts
export type { HybridQueryExplain } from "./hybrid-search.js";

/**
 * Error result when document is not found
 */
export type DocumentNotFound = {
  error: "not_found";
  query: string;
  similarFiles: string[];
};

/**
 * Result from multi-get operations
 */
export type MultiGetResult = {
  doc: DocumentResult;
  skipped: false;
} | {
  doc: Pick<DocumentResult, "filepath" | "displayPath">;
  skipped: true;
  skipReason: string;
};

export type CollectionInfo = {
  name: string;
  path: string | null;
  pattern: string | null;
  documents: number;
  lastUpdated: string;
};

export type IndexStatus = {
  totalDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
  collections: CollectionInfo[];
};

// =============================================================================
// Index health
// =============================================================================

export function getHashesNeedingEmbedding(db: Database, collections?: string[]): number {
  if (collections && collections.length > 0) {
    const placeholders = collections.map(() => "?").join(", ");
    const result = db.prepare(`
      SELECT COUNT(DISTINCT d.hash) as count
      FROM documents d
      LEFT JOIN content_vectors v ON d.hash = v.hash AND v.seq = 0
      WHERE d.active = 1 AND v.hash IS NULL AND d.collection IN (${placeholders})
    `).get(...collections) as { count: number };
    return result.count;
  }
  const result = db.prepare(`
    SELECT COUNT(DISTINCT d.hash) as count
    FROM documents d
    LEFT JOIN content_vectors v ON d.hash = v.hash AND v.seq = 0
    WHERE d.active = 1 AND v.hash IS NULL
  `).get() as { count: number };
  return result.count;
}

export type IndexHealthInfo = {
  needsEmbedding: number;
  totalDocs: number;
  daysStale: number | null;
};

export function getIndexHealth(db: Database): IndexHealthInfo {
  const needsEmbedding = getHashesNeedingEmbedding(db);
  const totalDocs = (db.prepare(`SELECT COUNT(*) as count FROM documents WHERE active = 1`).get() as { count: number }).count;

  const mostRecent = db.prepare(`SELECT MAX(modified_at) as latest FROM documents WHERE active = 1`).get() as { latest: string | null };
  let daysStale: number | null = null;
  if (mostRecent?.latest) {
    const lastUpdate = new Date(mostRecent.latest);
    daysStale = Math.floor((Date.now() - lastUpdate.getTime()) / (24 * 60 * 60 * 1000));
  }

  return { needsEmbedding, totalDocs, daysStale };
}

// =============================================================================
// Caching
// =============================================================================

export function getCacheKey(url: string, body: object): string {
  const hash = createHash("sha256");
  hash.update(url);
  hash.update(JSON.stringify(body));
  return hash.digest("hex");
}

export function getCachedResult(db: Database, cacheKey: string): string | null {
  const row = db.prepare(`SELECT result FROM llm_cache WHERE hash = ?`).get(cacheKey) as { result: string } | null;
  return row?.result || null;
}

export function setCachedResult(db: Database, cacheKey: string, result: string): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO llm_cache (hash, result, created_at) VALUES (?, ?, ?)`).run(cacheKey, result, now);
  if (Math.random() < 0.01) {
    db.exec(`DELETE FROM llm_cache WHERE hash NOT IN (SELECT hash FROM llm_cache ORDER BY created_at DESC LIMIT 1000)`);
  }
}

export function clearCache(db: Database): void {
  db.exec(`DELETE FROM llm_cache`);
}

// =============================================================================
// Cleanup and maintenance operations
// =============================================================================

/**
 * Remove all doc-reading caches for a given docid (called when a document is
 * re-indexed and its content hash changes, invalidating the old caches).
 */
export function cleanupOrphanedDocCaches(db: Database, docid: string): void {
  db.prepare("DELETE FROM pages_cache WHERE docid = ?").run(docid);
  db.prepare("DELETE FROM toc_cache WHERE docid = ?").run(docid);
  db.prepare("DELETE FROM section_map WHERE docid = ?").run(docid);
  db.prepare("DELETE FROM slide_cache WHERE docid = ?").run(docid);
}

/**
 * Delete cached LLM API responses.
 * Returns the number of cached responses deleted.
 */
export function deleteLLMCache(db: Database): number {
  const result = db.prepare(`DELETE FROM llm_cache`).run();
  return result.changes;
}

/**
 * Remove inactive document records (active = 0).
 * Returns the number of inactive documents deleted.
 */
export function deleteInactiveDocuments(db: Database): number {
  const result = db.prepare(`DELETE FROM documents WHERE active = 0`).run();
  return result.changes;
}

/**
 * Remove orphaned content hashes that are not referenced by any active document.
 * Returns the number of orphaned content hashes deleted.
 */
export function cleanupOrphanedContent(db: Database): number {
  const result = db.prepare(`
    DELETE FROM content
    WHERE hash NOT IN (SELECT DISTINCT hash FROM documents WHERE active = 1)
  `).run();
  // Clean up links for deactivated/removed documents
  db.prepare(`
    DELETE FROM links WHERE source NOT IN (
      SELECT collection || '/' || path FROM documents WHERE active = 1
    )
  `).run();
  return result.changes;
}

/**
 * Remove orphaned vector embeddings that are not referenced by any active document.
 * Returns the number of orphaned embedding chunks deleted.
 */
export function cleanupOrphanedVectors(db: Database): number {
  // Check if vectors_vec table exists
  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'
  `).get();

  if (!tableExists) {
    return 0;
  }

  // Count orphaned vectors first
  const countResult = db.prepare(`
    SELECT COUNT(*) as c FROM content_vectors cv
    WHERE NOT EXISTS (
      SELECT 1 FROM documents d WHERE d.hash = cv.hash AND d.active = 1
    )
  `).get() as { c: number };

  if (countResult.c === 0) {
    return 0;
  }

  // Delete from vectors_vec first
  db.exec(`
    DELETE FROM vectors_vec WHERE hash_seq IN (
      SELECT cv.hash || '_' || cv.seq FROM content_vectors cv
      WHERE NOT EXISTS (
        SELECT 1 FROM documents d WHERE d.hash = cv.hash AND d.active = 1
      )
    )
  `);

  // Delete from content_vectors
  db.exec(`
    DELETE FROM content_vectors WHERE hash NOT IN (
      SELECT hash FROM documents WHERE active = 1
    )
  `);

  return countResult.c;
}

/**
 * Run VACUUM to reclaim unused space in the database.
 * This operation rebuilds the database file to eliminate fragmentation.
 */
export function vacuumDatabase(db: Database): void {
  db.exec(`VACUUM`);
}

// =============================================================================
// Document helpers
// =============================================================================

export async function hashContent(content: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}

const titleExtractors: Record<string, (content: string) => string | null> = {
  '.md': (content) => {
    const match = content.match(/^##?\s+(.+)$/m);
    if (match) {
      const title = (match[1] ?? "").trim();
      if (title === "📝 Notes" || title === "Notes") {
        const nextMatch = content.match(/^##\s+(.+)$/m);
        if (nextMatch?.[1]) return nextMatch[1].trim();
      }
      return title;
    }
    return null;
  },
  '.org': (content) => {
    const titleProp = content.match(/^#\+TITLE:\s*(.+)$/im);
    if (titleProp?.[1]) return titleProp[1].trim();
    const heading = content.match(/^\*+\s+(.+)$/m);
    if (heading?.[1]) return heading[1].trim();
    return null;
  },
};

export function extractTitle(content: string, filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  const extractor = titleExtractors[ext];
  if (extractor) {
    const title = extractor(content);
    if (title) return title;
  }
  return filename.replace(/\.[^.]+$/, "").split("/").pop() || filename;
}

// =============================================================================
// Document indexing operations
// =============================================================================

/**
 * Insert content into the content table (content-addressable storage).
 * Uses INSERT OR IGNORE so duplicate hashes are skipped.
 */
export function insertContent(db: Database, hash: string, content: string, createdAt: string): void {
  db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`)
    .run(hash, content, createdAt);
}

/**
 * Insert a new document into the documents table.
 */
export function insertDocument(
  db: Database,
  collectionName: string,
  path: string,
  title: string,
  hash: string,
  createdAt: string,
  modifiedAt: string
): void {
  db.prepare(`
    INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(collection, path) DO UPDATE SET
      title = excluded.title,
      hash = excluded.hash,
      modified_at = excluded.modified_at,
      active = 1
  `).run(collectionName, path, title, hash, createdAt, modifiedAt);
}

/**
 * Find an active document by collection name and path.
 */
export function findActiveDocument(
  db: Database,
  collectionName: string,
  path: string
): { id: number; hash: string; title: string } | null {
  const row = db.prepare(`
    SELECT id, hash, title FROM documents
    WHERE collection = ? AND path = ? AND active = 1
  `).get(collectionName, path) as { id: number; hash: string; title: string } | undefined;
  return row ?? null;
}

/**
 * Update the title and modified_at timestamp for a document.
 */
export function updateDocumentTitle(
  db: Database,
  documentId: number,
  title: string,
  modifiedAt: string
): void {
  db.prepare(`UPDATE documents SET title = ?, modified_at = ? WHERE id = ?`)
    .run(title, modifiedAt, documentId);
}

/**
 * Update an existing document's hash, title, and modified_at timestamp.
 * Used when content changes but the file path stays the same.
 */
export function updateDocument(
  db: Database,
  documentId: number,
  title: string,
  hash: string,
  modifiedAt: string
): void {
  db.prepare(`UPDATE documents SET title = ?, hash = ?, modified_at = ? WHERE id = ?`)
    .run(title, hash, modifiedAt, documentId);
}

/**
 * Deactivate a document (mark as inactive but don't delete).
 */
export function deactivateDocument(db: Database, collectionName: string, path: string): void {
  db.prepare(`UPDATE documents SET active = 0 WHERE collection = ? AND path = ? AND active = 1`)
    .run(collectionName, path);
}

/**
 * Get all active document paths for a collection.
 */
export function getActiveDocumentPaths(db: Database, collectionName: string): string[] {
  const rows = db.prepare(`
    SELECT path FROM documents WHERE collection = ? AND active = 1
  `).all(collectionName) as { path: string }[];
  return rows.map(r => r.path);
}

export { formatQueryForEmbedding, formatDocForEmbedding };

// =============================================================================
// Fuzzy matching
// =============================================================================

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost
      );
    }
  }
  return dp[m]![n]!;
}

function pathBasename(p: string): string {
  const s = p.replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i === -1 ? s : s.slice(i + 1);
}

/** Strip the last extension from a path segment (e.g. `foo/bar.md` → `foo/bar`). */
function stripExtensionFromPath(path: string): string {
  const b = pathBasename(path);
  const prefix = path.length > b.length ? path.slice(0, path.length - b.length) : '';
  const dot = b.lastIndexOf('.');
  const stem = dot <= 0 ? b : b.slice(0, dot);
  return prefix + stem;
}

function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return filename;
  return filename.slice(0, dot);
}

/**
 * Lower is-better distance for fuzzy path matching (basename-aware, extension-stripped substring/prefix).
 */
function similarityDistance(queryLower: string, pathLower: string, displayLower: string): number {
  const queryBase = pathBasename(queryLower);
  const pathBase = pathBasename(pathLower);

  let bestDist = Math.min(
    levenshtein(pathLower, queryLower),
    levenshtein(displayLower, queryLower),
    levenshtein(pathBase, queryBase),
  );

  if (pathLower.includes(queryLower) || displayLower.includes(queryLower)) {
    bestDist = Math.min(bestDist, 1);
  }

  const qPathStem = stripExtensionFromPath(queryLower);
  const pathStem = stripExtensionFromPath(pathLower);
  const displayStem = stripExtensionFromPath(displayLower);
  if (qPathStem.length > 0) {
    if (pathStem.includes(qPathStem) || displayStem.includes(qPathStem)) {
      bestDist = Math.min(bestDist, 1);
    }
  }

  const qBaseStem = stripExtension(queryBase);
  const pathBaseStem = stripExtension(pathBase);
  if (qBaseStem.length > 0 && pathBaseStem.length > 0) {
    if (pathBaseStem.includes(qBaseStem) || qBaseStem.includes(pathBaseStem)) {
      bestDist = Math.min(bestDist, 1);
    }
    if (pathBaseStem.startsWith(qBaseStem)) {
      bestDist = Math.min(bestDist, 2);
    }
  }

  return bestDist;
}

/**
 * Normalize a docid input by stripping surrounding quotes and leading #.
 * Handles: "#abc123", 'abc123', "abc123", #abc123, abc123
 * Returns the bare hex string.
 */
export function normalizeDocid(docid: string): string {
  let normalized = docid.trim();

  // Strip surrounding quotes (single or double)
  if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1);
  }

  // Strip leading # if present
  if (normalized.startsWith('#')) {
    normalized = normalized.slice(1);
  }

  return normalized;
}

/**
 * Check if a string looks like a docid reference.
 * Accepts: #abc123, abc123, "#abc123", "abc123", '#abc123', 'abc123'
 * Returns true if the normalized form is a valid hex string of 6+ chars.
 */
export function isDocid(input: string): boolean {
  const normalized = normalizeDocid(input);
  // Must be at least 6 hex characters
  return normalized.length >= 6 && /^[a-f0-9]+$/i.test(normalized);
}

/**
 * Find a document by its short docid (first 6 characters of hash).
 * Returns the document's virtual path if found, null otherwise.
 * If multiple documents match the same short hash (collision), returns the first one.
 *
 * Accepts lenient input: #abc123, abc123, "#abc123", "abc123"
 */
export function findDocumentByDocid(db: Database, docid: string): { filepath: string; hash: string } | null {
  const shortHash = normalizeDocid(docid);

  if (shortHash.length < 1) return null;

  // Look up documents where hash starts with the short hash
  const doc = db.prepare(`
    SELECT 'qmd://' || d.collection || '/' || d.path as filepath, d.hash
    FROM documents d
    WHERE d.hash LIKE ? AND d.active = 1
    LIMIT 1
  `).get(`${shortHash}%`) as { filepath: string; hash: string } | null;

  return doc;
}

export function findSimilarFiles(db: Database, query: string, maxDistance: number = 3, limit: number = 5): string[] {
  const allFiles = db.prepare(`
    SELECT d.path, d.collection || '/' || d.path as display_path
    FROM documents d
    WHERE d.active = 1
  `).all() as { path: string; display_path: string }[];
  const queryLower = query.toLowerCase().replace(/^qmd:\/\//, '');
  const scored = allFiles.map(f => {
    const pathLower = f.path.toLowerCase();
    const displayLower = f.display_path.toLowerCase();
    const dist = similarityDistance(queryLower, pathLower, displayLower);
    return { display_path: f.display_path, dist };
  });

  const strict = scored
    .filter(f => f.dist <= maxDistance)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);

  if (strict.length > 0) {
    return strict.map(f => f.display_path);
  }

  const loose = scored
    .filter(f => {
      const effectiveMax = Math.max(maxDistance, Math.floor(f.display_path.length * 0.4));
      return f.dist <= effectiveMax;
    })
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);

  return loose.map(f => f.display_path);
}

const MAX_GLOB_MATCHES = 500;

export function matchFilesByGlob(db: Database, pattern: string): { filepath: string; displayPath: string; bodyLength: number }[] {
  const allFiles = db.prepare(`
    SELECT
      'qmd://' || d.collection || '/' || d.path as virtual_path,
      LENGTH(content.doc) as body_length,
      d.path,
      d.collection
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE d.active = 1
  `).all() as { virtual_path: string; body_length: number; path: string; collection: string }[];

  const isMatch = picomatch(pattern);
  const matched: { filepath: string; displayPath: string; bodyLength: number }[] = [];
  for (const f of allFiles) {
    if (isMatch(f.virtual_path) || isMatch(f.path) || isMatch(`${f.collection}/${f.path}`)) {
      matched.push({ filepath: f.virtual_path, displayPath: f.path, bodyLength: f.body_length });
      if (matched.length >= MAX_GLOB_MATCHES) break;
    }
  }
  return matched;
}

// =============================================================================
// Context
// =============================================================================

/**
 * Get context for a file path using hierarchical inheritance.
 * Contexts are collection-scoped and inherit from parent directories.
 * For example, context at "/talks" applies to "/talks/2024/keynote.md".
 *
 * @param db Database instance (unused - kept for compatibility)
 * @param collectionName Collection name
 * @param path Relative path within the collection
 * @returns Context string or null if no context is defined
 */
export function getContextForPath(db: Database, collectionName: string, path: string): string | null {
  const coll = getStoreCollection(db, collectionName);

  if (!coll) return null;

  // Collect ALL matching contexts (global + all path prefixes)
  const contexts: string[] = [];

  // Add global context if present
  const globalCtx = getStoreGlobalContext(db);
  if (globalCtx) {
    contexts.push(globalCtx);
  }

  // Add all matching path contexts (from most general to most specific)
  if (coll.context) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;

    // Collect all matching prefixes
    const matchingContexts: { prefix: string; context: string }[] = [];
    for (const [prefix, context] of Object.entries(coll.context)) {
      const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
      if (normalizedPath.startsWith(normalizedPrefix)) {
        matchingContexts.push({ prefix: normalizedPrefix, context });
      }
    }

    // Sort by prefix length (shortest/most general first)
    matchingContexts.sort((a, b) => a.prefix.length - b.prefix.length);

    // Add all matching contexts
    for (const match of matchingContexts) {
      contexts.push(match.context);
    }
  }

  // Join all contexts with double newline
  return contexts.length > 0 ? contexts.join('\n\n') : null;
}

/**
 * Get context for a file path (virtual or filesystem).
 * Resolves the collection and relative path from the DB store_collections table.
 */
export function getContextForFile(db: Database, filepath: string): string | null {
  // Handle undefined or null filepath
  if (!filepath) return null;

  // Get all collections from DB
  const collections = getStoreCollections(db);

  // Parse virtual path format: qmd://collection/path
  let collectionName: string | null = null;
  let relativePath: string | null = null;

  const parsedVirtual = filepath.startsWith('qmd://') ? parseVirtualPath(filepath) : null;
  if (parsedVirtual) {
    collectionName = parsedVirtual.collectionName;
    relativePath = parsedVirtual.path;
  } else {
    // Filesystem path: find which collection this absolute path belongs to
    for (const coll of collections) {
      // Skip collections with missing paths
      if (!coll || !coll.path) continue;

      if (filepath.startsWith(coll.path + '/') || filepath === coll.path) {
        collectionName = coll.name;
        // Extract relative path
        relativePath = filepath.startsWith(coll.path + '/')
          ? filepath.slice(coll.path.length + 1)
          : '';
        break;
      }
    }

    if (!collectionName || relativePath === null) return null;
  }

  // Get the collection from DB
  const coll = getStoreCollection(db, collectionName);
  if (!coll) return null;

  // Verify this document exists in the database
  const doc = db.prepare(`
    SELECT d.path
    FROM documents d
    WHERE d.collection = ? AND d.path = ? AND d.active = 1
    LIMIT 1
  `).get(collectionName, relativePath) as { path: string } | null;

  if (!doc) return null;

  // Collect ALL matching contexts (global + all path prefixes)
  const contexts: string[] = [];

  // Add global context if present
  const globalCtx = getStoreGlobalContext(db);
  if (globalCtx) {
    contexts.push(globalCtx);
  }

  // Add all matching path contexts (from most general to most specific)
  if (coll.context) {
    const normalizedPath = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;

    // Collect all matching prefixes
    const matchingContexts: { prefix: string; context: string }[] = [];
    for (const [prefix, context] of Object.entries(coll.context)) {
      const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
      if (normalizedPath.startsWith(normalizedPrefix)) {
        matchingContexts.push({ prefix: normalizedPrefix, context });
      }
    }

    // Sort by prefix length (shortest/most general first)
    matchingContexts.sort((a, b) => a.prefix.length - b.prefix.length);

    // Add all matching contexts
    for (const match of matchingContexts) {
      contexts.push(match.context);
    }
  }

  // Join all contexts with double newline
  return contexts.length > 0 ? contexts.join('\n\n') : null;
}

/**
 * Get collection by name from DB store_collections table.
 */
export function getCollectionByName(db: Database, name: string): { name: string; pwd: string; glob_pattern: string } | null {
  const collection = getStoreCollection(db, name);
  if (!collection) return null;

  return {
    name: collection.name,
    pwd: collection.path,
    glob_pattern: collection.pattern,
  };
}

/**
 * List all collections with document counts from database.
 * Merges store_collections config with database statistics.
 */
export function listCollections(db: Database): { name: string; pwd: string; glob_pattern: string; doc_count: number; active_count: number; last_modified: string | null; includeByDefault: boolean; type: "raw" | "wiki" }[] {
  const collections = getStoreCollections(db);

  // Get document counts from database for each collection
  const result = collections.map(coll => {
    const stats = db.prepare(`
      SELECT
        COUNT(d.id) as doc_count,
        SUM(CASE WHEN d.active = 1 THEN 1 ELSE 0 END) as active_count,
        MAX(d.modified_at) as last_modified
      FROM documents d
      WHERE d.collection = ?
    `).get(coll.name) as { doc_count: number; active_count: number; last_modified: string | null } | null;

    return {
      name: coll.name,
      pwd: coll.path,
      glob_pattern: coll.pattern,
      doc_count: stats?.doc_count || 0,
      active_count: stats?.active_count || 0,
      last_modified: stats?.last_modified || null,
      includeByDefault: coll.includeByDefault !== false,
      type: (coll.type === 'wiki' ? 'wiki' : 'raw') as "raw" | "wiki",
    };
  });

  return result;
}

/**
 * Remove a collection and clean up its documents.
 * Uses collections.ts to remove from YAML config and cleans up database.
 */
export function removeCollection(db: Database, collectionName: string): { deletedDocs: number; cleanedHashes: number } {
  // Wrap in a transaction for atomicity — all cleanup happens together
  db.exec("BEGIN IMMEDIATE");
  try {
    const docResult = db.prepare(`DELETE FROM documents WHERE collection = ?`).run(collectionName);

    db.prepare(`DELETE FROM links WHERE source LIKE ?`).run(collectionName + '/%');

    try { db.prepare(`DELETE FROM wiki_sources WHERE wiki_collection = ?`).run(collectionName); } catch { /* table may not exist */ }
    try { db.prepare(`DELETE FROM wiki_ingest_tracker WHERE wiki_collection = ?`).run(collectionName); } catch { /* table may not exist */ }

    const cleanupResult = db.prepare(`
      DELETE FROM content
      WHERE hash NOT IN (SELECT DISTINCT hash FROM documents WHERE active = 1)
    `).run();

    const orphanCacheSQL = `
      DELETE FROM %TABLE% WHERE docid NOT IN (SELECT SUBSTR(hash,1,6) FROM documents WHERE active=1)
    `;
    for (const table of ["pages_cache", "toc_cache", "section_map", "slide_cache"]) {
      try { db.prepare(orphanCacheSQL.replace("%TABLE%", table)).run(); } catch { /* table may not exist */ }
    }

    deleteStoreCollection(db, collectionName);

    db.exec("COMMIT");
    return {
      deletedDocs: docResult.changes,
      cleanedHashes: cleanupResult.changes,
    };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* ignore rollback errors */ }
    throw e;
  }
}

/**
 * Rename a collection.
 * Updates both YAML config and database documents table.
 */
export function renameCollection(db: Database, oldName: string, newName: string): void {
  renameStoreCollection(db, oldName, newName);
}

// =============================================================================
// Context Management Operations
// =============================================================================

/**
 * Delete a context for a specific collection and path prefix.
 * Returns the number of contexts deleted.
 */
export function deleteContext(db: Database, collectionName: string, pathPrefix: string): number {
  // Remove context from store_collections
  const success = removeStoreContext(db, collectionName, pathPrefix);
  return success ? 1 : 0;
}

/**
 * Delete all global contexts (contexts with empty path_prefix).
 * Returns the number of contexts deleted.
 */
export function deleteGlobalContexts(db: Database): number {
  let deletedCount = 0;

  // Remove global context
  setStoreGlobalContext(db, undefined);
  deletedCount++;

  // Remove root context (empty string) from all collections
  const collections = getStoreCollections(db);
  for (const coll of collections) {
    const success = removeStoreContext(db, coll.name, '');
    if (success) {
      deletedCount++;
    }
  }

  return deletedCount;
}

/**
 * List all contexts, grouped by collection.
 * Returns contexts ordered by collection name, then by path prefix length (longest first).
 */
export function listPathContexts(db: Database): { collection_name: string; path_prefix: string; context: string }[] {
  const allContexts = getStoreContexts(db);

  // Convert to expected format and sort
  return allContexts.map(ctx => ({
    collection_name: ctx.collection,
    path_prefix: ctx.path,
    context: ctx.context,
  })).sort((a, b) => {
    // Sort by collection name first
    if (a.collection_name !== b.collection_name) {
      return a.collection_name.localeCompare(b.collection_name);
    }
    // Then by path prefix length (longest first)
    if (a.path_prefix.length !== b.path_prefix.length) {
      return b.path_prefix.length - a.path_prefix.length;
    }
    // Then alphabetically
    return a.path_prefix.localeCompare(b.path_prefix);
  });
}

/**
 * Get all collections (name only - from YAML config).
 */
export function getAllCollections(db: Database): { name: string }[] {
  const collections = getStoreCollections(db);
  return collections.map(c => ({ name: c.name }));
}

/**
 * Check which collections don't have any context defined.
 * Returns collections that have no context entries at all (not even root context).
 */
export function getCollectionsWithoutContext(db: Database): { name: string; pwd: string; doc_count: number }[] {
  // Get all collections from DB
  const allCollections = getStoreCollections(db);

  // Filter to those without context
  const collectionsWithoutContext: { name: string; pwd: string; doc_count: number }[] = [];

  for (const coll of allCollections) {
    // Check if collection has any context
    if (!coll.context || Object.keys(coll.context).length === 0) {
      // Get doc count from database
      const stats = db.prepare(`
        SELECT COUNT(d.id) as doc_count
        FROM documents d
        WHERE d.collection = ? AND d.active = 1
      `).get(coll.name) as { doc_count: number } | null;

      collectionsWithoutContext.push({
        name: coll.name,
        pwd: coll.path,
        doc_count: stats?.doc_count || 0,
      });
    }
  }

  return collectionsWithoutContext.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get top-level directories in a collection that don't have context.
 * Useful for suggesting where context might be needed.
 */
export function getTopLevelPathsWithoutContext(db: Database, collectionName: string): string[] {
  // Get all paths in the collection from database
  const paths = db.prepare(`
    SELECT DISTINCT path FROM documents
    WHERE collection = ? AND active = 1
  `).all(collectionName) as { path: string }[];

  // Get existing contexts for this collection from DB
  const dbColl = getStoreCollection(db, collectionName);
  if (!dbColl) return [];

  const contextPrefixes = new Set<string>();
  if (dbColl.context) {
    for (const prefix of Object.keys(dbColl.context)) {
      contextPrefixes.add(prefix);
    }
  }

  // Extract top-level directories (first path component)
  const topLevelDirs = new Set<string>();
  for (const { path } of paths) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length > 1) {
      const dir = parts[0];
      if (dir) topLevelDirs.add(dir);
    }
  }

  // Filter out directories that already have context (exact or parent)
  const missing: string[] = [];
  for (const dir of topLevelDirs) {
    let hasContext = false;

    // Check if this dir or any parent has context
    for (const prefix of contextPrefixes) {
      if (prefix === '' || prefix === dir || dir.startsWith(prefix + '/')) {
        hasContext = true;
        break;
      }
    }

    if (!hasContext) {
      missing.push(dir);
    }
  }

  return missing.sort();
}

// =============================================================================
// Search functions — re-exported from dedicated module
// =============================================================================

export {
  buildFTS5Query,
  validateSemanticQuery,
  validateLexQuery,
  searchFTS,
  searchVec,
  expandQuery,
  rerank,
  reciprocalRankFusion,
  buildRrfTrace,
  extractSnippet,
  addLineNumbers,
  extractIntentTerms,
  INTENT_WEIGHT_SNIPPET,
  INTENT_WEIGHT_CHUNK,
  type RankedResult,
  type RRFContributionTrace,
  type RRFScoreTrace,
  type RankedListMeta,
  type SnippetResult,
} from "./search.js";
import {
  searchFTS,
  searchVec,
  expandQuery,
  rerank,
  extractSnippet,
  addLineNumbers,
  buildFTS5Query,
} from "./search.js";

// =============================================================================
// Embeddings
// =============================================================================

/**
 * Get all unique content hashes that need embeddings (from active documents).
 * Returns hash, document body, and a sample path for display purposes.
 * Optionally filter by collection names.
 */
export function getHashesForEmbedding(db: Database, collections?: string[]): { hash: string; body: string; path: string }[] {
  if (collections && collections.length > 0) {
    const placeholders = collections.map(() => "?").join(", ");
    return db.prepare(`
      SELECT d.hash, c.doc as body, MIN(d.path) as path
      FROM documents d
      JOIN content c ON d.hash = c.hash
      LEFT JOIN content_vectors v ON d.hash = v.hash AND v.seq = 0
      WHERE d.active = 1 AND v.hash IS NULL AND d.collection IN (${placeholders})
      GROUP BY d.hash
    `).all(...collections) as { hash: string; body: string; path: string }[];
  }
  return db.prepare(`
    SELECT d.hash, c.doc as body, MIN(d.path) as path
    FROM documents d
    JOIN content c ON d.hash = c.hash
    LEFT JOIN content_vectors v ON d.hash = v.hash AND v.seq = 0
    WHERE d.active = 1 AND v.hash IS NULL
    GROUP BY d.hash
  `).all() as { hash: string; body: string; path: string }[];
}

/**
 * Clear all embeddings from the database (force re-index).
 * Deletes all rows from content_vectors and drops the vectors_vec table.
 */
export function clearAllEmbeddings(db: Database): void {
  db.exec(`BEGIN; DELETE FROM content_vectors; DROP TABLE IF EXISTS vectors_vec; COMMIT;`);
}

/**
 * Insert a single embedding into both content_vectors and vectors_vec tables.
 * The hash_seq key is formatted as "hash_seq" for the vectors_vec table.
 */
export function insertEmbedding(
  db: Database,
  hash: string,
  seq: number,
  pos: number,
  embedding: Float32Array,
  model: string,
  embeddedAt: string
): void {
  const hashSeq = `${hash}_${seq}`;
  const insertVecStmt = db.prepare(`INSERT OR REPLACE INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`);
  const insertContentVectorStmt = db.prepare(`INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, ?, ?, ?, ?)`);

  insertVecStmt.run(hashSeq, embedding);
  insertContentVectorStmt.run(hash, seq, pos, model, embeddedAt);
}

// =============================================================================
// Document retrieval
// =============================================================================

type DbDocRow = {
  virtual_path: string;
  display_path: string;
  title: string;
  hash: string;
  collection: string;
  path: string;
  modified_at: string;
  body_length: number;
  body?: string;
};

/**
 * Find a document by filename/path, docid (#hash), or with fuzzy matching.
 * Returns document metadata without body by default.
 *
 * Supports:
 * - Virtual paths: qmd://collection/path/to/file.md
 * - Absolute paths: /path/to/file.md
 * - Relative paths: path/to/file.md
 * - Short docid: #abc123 (first 6 chars of hash)
 */
export function findDocument(db: Database, filename: string, options: { includeBody?: boolean } = {}): DocumentResult | DocumentNotFound {
  let filepath = filename;
  const colonMatch = filepath.match(/:(\d+)$/);
  if (colonMatch) {
    filepath = filepath.slice(0, -colonMatch[0].length);
  }

  // Check if this is a docid lookup (#abc123, abc123, "#abc123", "abc123", etc.)
  if (isDocid(filepath)) {
    const docidMatch = findDocumentByDocid(db, filepath);
    if (docidMatch) {
      filepath = docidMatch.filepath;
    } else {
      return { error: "not_found", query: filename, similarFiles: [] };
    }
  }

  if (filepath.startsWith('~/')) {
    filepath = homedir() + filepath.slice(1);
  }

  const bodyCol = options.includeBody ? `, content.doc as body` : ``;

  // Build computed columns
  // Note: absoluteFilepath is computed from YAML collections after query
  const selectCols = `
    'qmd://' || d.collection || '/' || d.path as virtual_path,
    d.collection || '/' || d.path as display_path,
    d.title,
    d.hash,
    d.collection,
    d.modified_at,
    LENGTH(content.doc) as body_length
    ${bodyCol}
  `;

  // Try to match by virtual path first
  let doc = db.prepare(`
    SELECT ${selectCols}
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE 'qmd://' || d.collection || '/' || d.path = ? AND d.active = 1
  `).get(filepath) as DbDocRow | null;

  // Try fuzzy match by virtual path
  if (!doc) {
    doc = db.prepare(`
      SELECT ${selectCols}
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE 'qmd://' || d.collection || '/' || d.path LIKE ? AND d.active = 1
      LIMIT 1
    `).get(`%${filepath}`) as DbDocRow | null;
  }

  // Try to match by absolute path (requires looking up collection paths from DB)
  if (!doc && !filepath.startsWith('qmd://')) {
    const collections = getStoreCollections(db);
    for (const coll of collections) {
      let relativePath: string | null = null;

      // If filepath is absolute and starts with collection path, extract relative part
      if (filepath.startsWith(coll.path + '/')) {
        relativePath = filepath.slice(coll.path.length + 1);
      }
      // Otherwise treat filepath as relative to collection
      else if (!filepath.startsWith('/')) {
        relativePath = filepath;
      }

      if (relativePath) {
        doc = db.prepare(`
          SELECT ${selectCols}
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.collection = ? AND d.path = ? AND d.active = 1
        `).get(coll.name, relativePath) as DbDocRow | null;
        if (doc) break;
      }
    }
  }

  if (!doc) {
    const similar = findSimilarFiles(db, filepath, 5, 5);
    return { error: "not_found", query: filename, similarFiles: similar };
  }

  // Get context using virtual path
  const virtualPath = doc.virtual_path || `qmd://${doc.collection}/${doc.display_path}`;
  const context = getContextForFile(db, virtualPath);

  return {
    filepath: virtualPath,
    displayPath: doc.display_path,
    title: doc.title,
    context,
    hash: doc.hash,
    docid: getDocid(doc.hash),
    collectionName: doc.collection,
    modifiedAt: doc.modified_at,
    bodyLength: doc.body_length,
    ...(options.includeBody && doc.body !== undefined && { body: doc.body }),
  };
}

/**
 * Get the body content for a document
 * Optionally slice by line range
 */
export function getDocumentBody(db: Database, doc: DocumentResult | { filepath: string }, fromLine?: number, maxLines?: number): string | null {
  const filepath = doc.filepath;

  // Try to resolve document by filepath (absolute or virtual)
  let row: { body: string } | null = null;

  // Try virtual path first
  if (filepath.startsWith('qmd://')) {
    row = db.prepare(`
      SELECT content.doc as body
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE 'qmd://' || d.collection || '/' || d.path = ? AND d.active = 1
    `).get(filepath) as { body: string } | null;
  }

  // Try absolute path by looking up in DB store_collections
  if (!row) {
    const collections = getStoreCollections(db);
    for (const coll of collections) {
      if (filepath.startsWith(coll.path + '/')) {
        const relativePath = filepath.slice(coll.path.length + 1);
        row = db.prepare(`
          SELECT content.doc as body
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.collection = ? AND d.path = ? AND d.active = 1
        `).get(coll.name, relativePath) as { body: string } | null;
        if (row) break;
      }
    }
  }

  if (!row) return null;

  let body = row.body;
  if (fromLine !== undefined || maxLines !== undefined) {
    const lines = body.split('\n');
    const start = (fromLine || 1) - 1;
    const end = maxLines !== undefined ? start + maxLines : lines.length;
    body = lines.slice(start, end).join('\n');
  }

  return body;
}

/**
 * Find multiple documents by glob pattern or comma-separated list
 * Returns documents without body by default (use getDocumentBody to load)
 */
export function findDocuments(
  db: Database,
  pattern: string,
  options: { includeBody?: boolean; maxBytes?: number } = {}
): { docs: MultiGetResult[]; errors: string[] } {
  const hasGlobChars = pattern.includes('*') || pattern.includes('?');
  const hasComma = pattern.includes(',');
  const isCommaSeparated = (hasComma && !hasGlobChars) || isDocid(pattern);
  const isCommaGlob = hasComma && hasGlobChars;
  const errors: string[] = [];
  const maxBytes = options.maxBytes ?? DEFAULT_MULTI_GET_MAX_BYTES;

  const bodyCol = options.includeBody ? `, content.doc as body` : ``;
  const selectCols = `
    'qmd://' || d.collection || '/' || d.path as virtual_path,
    d.collection || '/' || d.path as display_path,
    d.title,
    d.hash,
    d.collection,
    d.modified_at,
    LENGTH(content.doc) as body_length
    ${bodyCol}
  `;

  let fileRows: DbDocRow[];

  if (isCommaGlob) {
    // Comma-separated glob patterns: split and match each independently
    const parts = pattern.split(',').map(s => s.trim()).filter(Boolean);
    const seen = new Set<string>();
    fileRows = [];
    for (const part of parts) {
      const matched = matchFilesByGlob(db, part);
      if (matched.length === 0) {
        errors.push(`No files matched pattern: ${part}`);
        continue;
      }
      const newPaths = matched.map(m => m.filepath).filter(p => !seen.has(p));
      for (const p of newPaths) seen.add(p);
      if (newPaths.length === 0) continue;
      const placeholders = newPaths.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT ${selectCols}
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE 'qmd://' || d.collection || '/' || d.path IN (${placeholders}) AND d.active = 1
      `).all(...newPaths) as DbDocRow[];
      fileRows.push(...rows);
    }
  } else if (isCommaSeparated) {
    const names = pattern.split(',').map(s => s.trim()).filter(Boolean);
    fileRows = [];
    for (const name of names) {
      let resolvedName = name;
      if (isDocid(name)) {
        const docidMatch = findDocumentByDocid(db, name);
        if (docidMatch) {
          resolvedName = docidMatch.filepath;
        } else {
          errors.push(`Docid not found: ${name}`);
          continue;
        }
      }

      let doc = db.prepare(`
        SELECT ${selectCols}
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE 'qmd://' || d.collection || '/' || d.path = ? AND d.active = 1
      `).get(resolvedName) as DbDocRow | null;
      if (!doc) {
        doc = db.prepare(`
          SELECT ${selectCols}
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE 'qmd://' || d.collection || '/' || d.path LIKE ? AND d.active = 1
          LIMIT 1
        `).get(`%${resolvedName}`) as DbDocRow | null;
      }
      if (doc) {
        fileRows.push(doc);
      } else {
        const similar = findSimilarFiles(db, resolvedName, 5, 3);
        let msg = `File not found: ${resolvedName}`;
        if (similar.length > 0) {
          msg += ` (did you mean: ${similar.join(', ')}?)`;
        }
        errors.push(msg);
      }
    }
  } else {
    // Single glob pattern match
    const matched = matchFilesByGlob(db, pattern);
    if (matched.length === 0) {
      errors.push(`No files matched pattern: ${pattern}`);
      return { docs: [], errors };
    }
    const virtualPaths = matched.map(m => m.filepath);
    const placeholders = virtualPaths.map(() => '?').join(',');
    fileRows = db.prepare(`
      SELECT ${selectCols}
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE 'qmd://' || d.collection || '/' || d.path IN (${placeholders}) AND d.active = 1
    `).all(...virtualPaths) as DbDocRow[];
  }

  const results: MultiGetResult[] = [];

  for (const row of fileRows) {
    // Get context using virtual path
    const virtualPath = row.virtual_path || `qmd://${row.collection}/${row.display_path}`;
    const context = getContextForFile(db, virtualPath);

    if (row.body_length > maxBytes) {
      results.push({
        doc: { filepath: virtualPath, displayPath: row.display_path },
        skipped: true,
        skipReason: `File too large (${Math.round(row.body_length / 1024)}KB > ${Math.round(maxBytes / 1024)}KB)`,
      });
      continue;
    }

    results.push({
      doc: {
        filepath: virtualPath,
        displayPath: row.display_path,
        title: row.title || row.display_path.split('/').pop() || row.display_path,
        context,
        hash: row.hash,
        docid: getDocid(row.hash),
        collectionName: row.collection,
        modifiedAt: row.modified_at,
        bodyLength: row.body_length,
        ...(options.includeBody && row.body !== undefined && { body: row.body }),
      },
      skipped: false,
    });
  }

  return { docs: results, errors };
}

// =============================================================================
// Status
// =============================================================================

export function getStatus(db: Database): IndexStatus {
  // DB is source of truth for collections — config provides supplementary metadata
  const dbCollections = db.prepare(`
    SELECT
      collection as name,
      COUNT(*) as active_count,
      MAX(modified_at) as last_doc_update
    FROM documents
    WHERE active = 1
    GROUP BY collection
  `).all() as { name: string; active_count: number; last_doc_update: string | null }[];

  // Build a lookup from store_collections for path/pattern metadata
  const storeCollections = getStoreCollections(db);
  const configLookup = new Map(storeCollections.map(c => [c.name, { path: c.path, pattern: c.pattern }]));

  const collections: CollectionInfo[] = dbCollections.map(row => {
    const config = configLookup.get(row.name);
    return {
      name: row.name,
      path: config?.path ?? null,
      pattern: config?.pattern ?? null,
      documents: row.active_count,
      lastUpdated: row.last_doc_update || new Date().toISOString(),
    };
  });

  // Sort by last update time (most recent first)
  collections.sort((a, b) => {
    if (!a.lastUpdated) return 1;
    if (!b.lastUpdated) return -1;
    return new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime();
  });

  const totalDocs = (db.prepare(`SELECT COUNT(*) as c FROM documents WHERE active = 1`).get() as { c: number }).c;
  const needsEmbedding = getHashesNeedingEmbedding(db);
  const hasVectors = !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();

  return {
    totalDocuments: totalDocs,
    needsEmbedding,
    hasVectorIndex: hasVectors,
    collections,
  };
}

// =============================================================================
// Hybrid search — re-exported from dedicated module
// =============================================================================

export {
  hybridQuery,
  vectorSearchQuery,
  structuredSearch,
  type SearchHooks,
  type HybridQueryOptions,
  type HybridQueryResult,
  type VectorSearchOptions,
  type VectorSearchResult,
  type StructuredSearchOptions,
} from "./hybrid-search.js";
