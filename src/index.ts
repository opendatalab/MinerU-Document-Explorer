/**
 * QMD SDK - Library mode for programmatic access to QMD search and indexing.
 *
 * Usage:
 *   import { createStore } from 'mineru-document-explorer'
 *
 *   const store = await createStore({
 *     dbPath: './my-index.sqlite',
 *     config: {
 *       collections: {
 *         docs: { path: '/path/to/docs', pattern: '**\/*.md' }
 *       }
 *     }
 *   })
 *
 *   const results = await store.search({ query: "how does auth work?" })
 *   await store.close()
 */

import {
  createStore as createStoreInternal,
  hybridQuery,
  structuredSearch,
  extractSnippet,
  addLineNumbers,
  DEFAULT_EMBED_MODEL,
  DEFAULT_MULTI_GET_MAX_BYTES,
  reindexCollection,
  generateEmbeddings,
  listCollections as storeListCollections,
  syncConfigToDb,
  getStoreCollections,
  getStoreCollection,
  getStoreGlobalContext,
  getStoreContexts,
  upsertStoreCollection,
  deleteStoreCollection,
  removeCollection as storeRemoveCollection,
  renameStoreCollection,
  updateStoreContext,
  removeStoreContext,
  setStoreGlobalContext,
  vacuumDatabase,
  cleanupOrphanedContent,
  cleanupOrphanedVectors,
  deleteLLMCache,
  deleteInactiveDocuments,
  clearAllEmbeddings,
  type Store as InternalStore,
  type DocumentResult,
  type DocumentNotFound,
  type SearchResult,
  type HybridQueryResult,
  type HybridQueryOptions,
  type HybridQueryExplain,
  type ExpandedQuery,
  type StructuredSearchOptions,
  type MultiGetResult,
  type IndexStatus,
  type IndexHealthInfo,
  type SearchHooks,
  type ReindexProgress,
  type ReindexResult,
  type EmbedProgress,
  type EmbedResult,
} from "./store.js";
import {
  LlamaCpp,
} from "./llm.js";
import {
  setConfigSource,
  loadConfig,
  addCollection as collectionsAddCollection,
  removeCollection as collectionsRemoveCollection,
  renameCollection as collectionsRenameCollection,
  addContext as collectionsAddContext,
  removeContext as collectionsRemoveContext,
  setGlobalContext as collectionsSetGlobalContext,
  type Collection,
  type CollectionConfig,
  type NamedCollection,
  type ContextMap,
} from "./collections.js";
import type { DocumentBackend } from "./backends/types.js";
import { getBackend as getBackendImpl } from "./backends/registry.js";

// Re-export types for SDK consumers
export type {
  DocumentResult,
  DocumentNotFound,
  SearchResult,
  HybridQueryResult,
  HybridQueryOptions,
  HybridQueryExplain,
  ExpandedQuery,
  StructuredSearchOptions,
  MultiGetResult,
  IndexStatus,
  IndexHealthInfo,
  SearchHooks,
  ReindexProgress,
  ReindexResult,
  EmbedProgress,
  EmbedResult,
  Collection,
  CollectionConfig,
  NamedCollection,
  ContextMap,
};

// Re-export the internal Store type for advanced consumers
export type { InternalStore };

// Re-export utility functions used by frontends
export { extractSnippet, addLineNumbers, DEFAULT_MULTI_GET_MAX_BYTES };

// Re-export getDefaultDbPath for CLI/MCP that need the default database location
export { getDefaultDbPath } from "./store.js";

// Re-export Maintenance class for CLI housekeeping operations
export { Maintenance } from "./maintenance.js";

/**
 * Progress info emitted during update() for each file processed.
 */
export type UpdateProgress = {
  collection: string;
  file: string;
  current: number;
  total: number;
};

/**
 * Aggregated result from update() across all collections.
 */
export type UpdateResult = {
  collections: number;
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  needsEmbedding: number;
};

/**
 * Options for the unified search() method.
 */
export interface SearchOptions {
  /** Simple query string — will be auto-expanded via LLM */
  query?: string;
  /** Pre-expanded queries (from expandQuery) — skips auto-expansion */
  queries?: ExpandedQuery[];
  /** Domain intent hint — steers expansion and reranking */
  intent?: string;
  /** Rerank results using LLM (default: true) */
  rerank?: boolean;
  /** Filter to a specific collection */
  collection?: string;
  /** Filter to specific collections */
  collections?: string[];
  /** Max results (default: 10) */
  limit?: number;
  /** Minimum score threshold */
  minScore?: number;
  /** Include explain traces */
  explain?: boolean;
}

/**
 * Options for searchLex() — BM25 keyword search.
 */
export interface LexSearchOptions {
  limit?: number;
  collection?: string;
}

/**
 * Options for searchVector() — vector similarity search.
 */
export interface VectorSearchOptions {
  limit?: number;
  collection?: string;
}

/**
 * Options for expandQuery() — manual query expansion.
 */
export interface ExpandQueryOptions {
  intent?: string;
}

/**
 * Options for creating a QMD store.
 *
 * Provide `dbPath` and optionally `configPath` (YAML file) or `config` (inline).
 * If neither configPath nor config is provided, the store reads from existing
 * DB state (useful for reopening a previously-configured store).
 */
export interface StoreOptions {
  /** Path to the SQLite database file */
  dbPath: string;
  /** Path to a YAML config file (mutually exclusive with `config`) */
  configPath?: string;
  /** Inline collection config (mutually exclusive with `configPath`) */
  config?: CollectionConfig;
}

/**
 * The QMD SDK store — provides search, retrieval, collection management,
 * context management, and indexing operations.
 *
 * All methods are async. The store manages its own LlamaCpp instance
 * (lazy-loaded, auto-unloaded after inactivity) — no global singletons.
 */
export interface QMDStore {
  /** The underlying internal store (for advanced use) */
  readonly internal: InternalStore;
  /** Path to the SQLite database */
  readonly dbPath: string;

  // ── Search ──────────────────────────────────────────────────────────

  /** Full search: query expansion + multi-signal retrieval + LLM reranking */
  search(options: SearchOptions): Promise<HybridQueryResult[]>;

  /** BM25 keyword search (fast, no LLM) */
  searchLex(query: string, options?: LexSearchOptions): Promise<SearchResult[]>;

  /** Vector similarity search (embedding model, no reranking) */
  searchVector(query: string, options?: VectorSearchOptions): Promise<SearchResult[]>;

  /** Expand a query into typed sub-searches (lex/vec/hyde) for manual control */
  expandQuery(query: string, options?: ExpandQueryOptions): Promise<ExpandedQuery[]>;

  // ── Document Retrieval ──────────────────────────────────────────────

  /** Get a single document by path or docid */
  get(pathOrDocid: string, options?: { includeBody?: boolean }): Promise<DocumentResult | DocumentNotFound>;

  /** Get the body content of a document, optionally sliced by line range */
  getDocumentBody(pathOrDocid: string, opts?: { fromLine?: number; maxLines?: number }): Promise<string | null>;

  /** Get multiple documents by glob pattern or comma-separated list */
  multiGet(pattern: string, options?: { includeBody?: boolean; maxBytes?: number }): Promise<{ docs: MultiGetResult[]; errors: string[] }>;

  // ── Document Backend Access ──────────────────────────────────────────

  /** Get the document backend for a specific format (md, pdf, docx, pptx) */
  getBackend(format: "md" | "pdf" | "docx" | "pptx"): Promise<DocumentBackend>;

  // ── Document Writing ──────────────────────────────────────────────────

  /** Write a markdown document to a collection and re-index it */
  writeDocument(collection: string, path: string, content: string, title?: string): Promise<{ file: string; docid: string }>;

  /** Get forward and backward links for a document */
  getLinks(file: string, direction?: "forward" | "backward" | "both", linkType?: "wikilink" | "markdown" | "url" | "all"): Promise<{ file: string; forward: Array<{ target: string; anchor: string | null; line: number | null; link_type: string }>; backward: Array<{ source: string; anchor: string | null; line: number | null; link_type: string }> }>;

  // ── Collection Management ───────────────────────────────────────────

  /** Add or update a collection */
  addCollection(name: string, opts: { path: string; pattern?: string; ignore?: string[]; type?: "raw" | "wiki" }): Promise<void>;

  /** Remove a collection */
  removeCollection(name: string): Promise<boolean>;

  /** Rename a collection */
  renameCollection(oldName: string, newName: string): Promise<boolean>;

  /** List all collections with document stats */
  listCollections(): Promise<{ name: string; pwd: string; glob_pattern: string; doc_count: number; active_count: number; last_modified: string | null; includeByDefault: boolean; type: "raw" | "wiki" }[]>;

  /** Get names of collections included by default in queries */
  getDefaultCollectionNames(): Promise<string[]>;

  // ── Context Management ──────────────────────────────────────────────

  /** Add context for a path within a collection */
  addContext(collectionName: string, pathPrefix: string, contextText: string): Promise<boolean>;

  /** Remove context from a collection path */
  removeContext(collectionName: string, pathPrefix: string): Promise<boolean>;

  /** Set global context (applies to all collections) */
  setGlobalContext(context: string | undefined): Promise<void>;

  /** Get global context */
  getGlobalContext(): Promise<string | undefined>;

  /** List all contexts across all collections */
  listContexts(): Promise<Array<{ collection: string; path: string; context: string }>>;

  // ── Indexing ────────────────────────────────────────────────────────

  /** Re-index collections by scanning the filesystem */
  update(options?: {
    collections?: string[];
    onProgress?: (info: UpdateProgress) => void;
  }): Promise<UpdateResult>;

  /** Generate vector embeddings for documents that need them */
  embed(options?: {
    force?: boolean;
    model?: string;
    onProgress?: (info: EmbedProgress) => void;
  }): Promise<EmbedResult>;

  // ── Index Health ────────────────────────────────────────────────────

  /** Get index status (document counts, collections, embedding state) */
  getStatus(): Promise<IndexStatus>;

  /** Get index health info (stale embeddings, etc.) */
  getIndexHealth(): Promise<IndexHealthInfo>;

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Close the store and release all resources (LLM models, DB connection) */
  close(): Promise<void>;
}

/**
 * Create a QMD store for programmatic access to search and indexing.
 *
 * @example
 * ```typescript
 * // With a YAML config file
 * const store = await createStore({
 *   dbPath: './index.sqlite',
 *   configPath: './qmd.yml',
 * })
 *
 * // With inline config (no files needed besides the DB)
 * const store = await createStore({
 *   dbPath: './index.sqlite',
 *   config: {
 *     collections: {
 *       docs: { path: '/path/to/docs', pattern: '**\/*.md' }
 *     }
 *   }
 * })
 *
 * const results = await store.search({ query: "authentication flow" })
 * await store.close()
 * ```
 */
export async function createStore(options: StoreOptions): Promise<QMDStore> {
  if (!options.dbPath) {
    throw new Error("dbPath is required");
  }
  if (options.configPath && options.config) {
    throw new Error("Provide either configPath or config, not both");
  }

  // Create the internal store (opens DB, creates tables)
  const internal = createStoreInternal(options.dbPath);
  const db = internal.db;

  // Track whether we have a YAML config path for write-through
  const hasYamlConfig = !!options.configPath;

  // Sync config into SQLite store_collections
  if (options.configPath) {
    // YAML mode: inject config source for write-through, sync to DB
    setConfigSource({ configPath: options.configPath });
    const config = loadConfig();
    syncConfigToDb(db, config);
  } else if (options.config) {
    // Inline config mode: inject config source for mutations, sync to DB
    setConfigSource({ config: options.config });
    syncConfigToDb(db, options.config);
  }
  // else: DB-only mode — no external config, use existing store_collections

  // Create a per-store LlamaCpp instance — lazy-loads models on first use,
  // auto-unloads after 5 min inactivity to free VRAM.
  const llm = new LlamaCpp({
    inactivityTimeoutMs: 5 * 60 * 1000,
    disposeModelsOnInactivity: true,
  });
  internal.llm = llm;

  const store: QMDStore = {
    internal,
    dbPath: internal.dbPath,

    // Search
    search: async (opts) => {
      if (!opts.query && !opts.queries) {
        throw new Error("search() requires either 'query' or 'queries'");
      }
      // Normalize collection/collections
      const collections = [
        ...(opts.collection ? [opts.collection] : []),
        ...(opts.collections ?? []),
      ];
      const skipRerank = opts.rerank === false;

      if (opts.queries) {
        // Pre-expanded queries — use structuredSearch
        return structuredSearch(internal, opts.queries, {
          collections: collections.length > 0 ? collections : undefined,
          limit: opts.limit,
          minScore: opts.minScore,
          explain: opts.explain,
          intent: opts.intent,
          skipRerank,
        });
      }

      // Simple query string — use hybridQuery (expand + search + rerank)
      return hybridQuery(internal, opts.query!, {
        collection: collections[0],
        limit: opts.limit,
        minScore: opts.minScore,
        explain: opts.explain,
        intent: opts.intent,
        skipRerank,
      });
    },
    searchLex: async (q, opts) => internal.searchFTS(q, opts?.limit, opts?.collection),
    searchVector: async (q, opts) => internal.searchVec(q, DEFAULT_EMBED_MODEL, opts?.limit, opts?.collection),
    expandQuery: async (q, opts) => internal.expandQuery(q, undefined, opts?.intent),
    get: async (pathOrDocid, opts) => internal.findDocument(pathOrDocid, opts),
    getDocumentBody: async (pathOrDocid, opts) => {
      const result = internal.findDocument(pathOrDocid, { includeBody: false });
      if ("error" in result) return null;
      return internal.getDocumentBody(result, opts?.fromLine, opts?.maxLines);
    },
    multiGet: async (pattern, opts) => internal.findDocuments(pattern, opts),

    // Document Backend Access
    getBackend: async (format) => getBackendImpl(format, internal),

    // Document Writing — write to filesystem and re-index
    writeDocument: async (collection, path, content, title) => {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { dirname, join, resolve, relative } = await import("node:path");
      const { parseLinks } = await import("./links.js");
      const {
        extractTitle, hashContent, insertContent, insertDocument,
        findActiveDocument, updateDocument, handelize,
      } = await import("./store.js");

      const collRow = db.prepare("SELECT path FROM store_collections WHERE name = ?").get(collection) as { path: string } | undefined;
      if (!collRow) {
        throw new Error(`Collection not found: ${collection}`);
      }

      const collectionPath = collRow.path;
      const absPath = resolve(join(collectionPath, path));
      const rel = relative(collectionPath, absPath);
      if (rel.startsWith("..") || rel.startsWith("/")) {
        throw new Error("Invalid path: must be within the collection directory");
      }

      // Validate/normalize path before any FS writes
      const normalizedPath = handelize(rel);
      const hash = await hashContent(content);
      const now = new Date().toISOString();
      const docTitle = title ?? extractTitle(content, normalizedPath);

      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, content, "utf-8");

      // All DB mutations in a single transaction for atomicity
      db.exec("BEGIN IMMEDIATE");
      try {
        const existingDoc = findActiveDocument(db, collection, normalizedPath);

        if (existingDoc) {
          if (existingDoc.hash !== hash || existingDoc.title !== docTitle) {
            insertContent(db, hash, content, now);
            updateDocument(db, existingDoc.id, docTitle, hash, now);
          }
        } else {
          db.prepare(`DELETE FROM documents WHERE collection = ? AND path = ?`)
            .run(collection, normalizedPath);
          insertContent(db, hash, content, now);
          insertDocument(db, collection, normalizedPath, docTitle, hash, now, now);
        }

        const isMarkdown = /\.(md|markdown)$/i.test(normalizedPath);
        if (isMarkdown) {
          const virtualSource = collection + "/" + normalizedPath;
          db.prepare("DELETE FROM links WHERE source = ?").run(virtualSource);
          const parsedLinks = parseLinks(content);
          if (parsedLinks.length > 0) {
            const insertLink = db.prepare(
              "INSERT OR IGNORE INTO links (source, target, link_type, anchor, line) VALUES (?, ?, ?, ?, ?)"
            );
            for (const lnk of parsedLinks) {
              insertLink.run(virtualSource, lnk.target, lnk.link_type, lnk.anchor ?? null, lnk.line);
            }
          }
        }

        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }

      internal.clearCache();

      const docid = hash.slice(0, 6);
      return { file: collection + "/" + normalizedPath, docid: "#" + docid };
    },

    // Get forward and backward links
    getLinks: async (file, direction = "both", linkType = "all") => {
      const result = await store.get(file, { includeBody: false });
      if ("error" in result) {
        throw new Error(`Document not found: ${file}`);
      }

      const virtualSource = result.displayPath;
      const typeParam = linkType !== "all" ? linkType : null;

      let forward: { target: string; anchor: string | null; line: number | null; link_type: string }[] = [];
      let backward: { source: string; anchor: string | null; line: number | null; link_type: string }[] = [];

      if (direction === "forward" || direction === "both") {
        if (typeParam) {
          forward = db.prepare(
            `SELECT target, anchor, line, link_type FROM links WHERE source = ? AND link_type = ?`
          ).all(virtualSource, typeParam) as typeof forward;
        } else {
          forward = db.prepare(
            `SELECT target, anchor, line, link_type FROM links WHERE source = ?`
          ).all(virtualSource) as typeof forward;
        }
      }

      if (direction === "backward" || direction === "both") {
        // Look up document title for wikilink title-based backlink resolution
        const docTitle = db.prepare(
          `SELECT title FROM documents WHERE collection || '/' || path = ? AND active = 1 LIMIT 1`
        ).get(virtualSource) as { title: string } | null;
        const title = docTitle?.title ?? "";

        if (typeParam) {
          backward = db.prepare(
            `SELECT source, anchor, line, link_type FROM links WHERE (target = ? OR (link_type = 'wikilink' AND (? LIKE '%/' || target || '.md' OR LOWER(target) = LOWER(?)))) AND link_type = ?`
          ).all(virtualSource, virtualSource, title, typeParam) as typeof backward;
        } else {
          backward = db.prepare(
            `SELECT source, anchor, line, link_type FROM links WHERE (target = ? OR (link_type = 'wikilink' AND (? LIKE '%/' || target || '.md' OR LOWER(target) = LOWER(?))))`
          ).all(virtualSource, virtualSource, title) as typeof backward;
        }
      }

      return { file: result.displayPath, forward, backward };
    },

    // Collection Management — write to SQLite + write-through to YAML/inline if configured
    addCollection: async (name, opts) => {
      upsertStoreCollection(db, name, { path: opts.path, pattern: opts.pattern, ignore: opts.ignore, type: opts.type });
      if (hasYamlConfig || options.config) {
        collectionsAddCollection(name, opts.path, opts.pattern, opts.type);
      }
    },
    removeCollection: async (name) => {
      const existing = db.prepare(`SELECT name FROM store_collections WHERE name = ?`).get(name);
      storeRemoveCollection(db, name);
      if (hasYamlConfig || options.config) {
        collectionsRemoveCollection(name);
      }
      internal.clearCache();
      return !!existing;
    },
    renameCollection: async (oldName, newName) => {
      const result = renameStoreCollection(db, oldName, newName);
      if (hasYamlConfig || options.config) {
        collectionsRenameCollection(oldName, newName);
      }
      return result;
    },
    listCollections: async () => storeListCollections(db),
    getDefaultCollectionNames: async () => {
      const collections = storeListCollections(db);
      return collections.filter(c => c.includeByDefault).map(c => c.name);
    },

    // Context Management — write to SQLite + write-through to YAML/inline if configured
    addContext: async (collectionName, pathPrefix, contextText) => {
      const result = updateStoreContext(db, collectionName, pathPrefix, contextText);
      if (hasYamlConfig || options.config) {
        collectionsAddContext(collectionName, pathPrefix, contextText);
      }
      return result;
    },
    removeContext: async (collectionName, pathPrefix) => {
      const result = removeStoreContext(db, collectionName, pathPrefix);
      if (hasYamlConfig || options.config) {
        collectionsRemoveContext(collectionName, pathPrefix);
      }
      return result;
    },
    setGlobalContext: async (context) => {
      setStoreGlobalContext(db, context);
      if (hasYamlConfig || options.config) {
        collectionsSetGlobalContext(context);
      }
    },
    getGlobalContext: async () => getStoreGlobalContext(db),
    listContexts: async () => getStoreContexts(db),

    // Indexing — reads collections from SQLite
    update: async (updateOpts) => {
      const collections = getStoreCollections(db);
      const filtered = updateOpts?.collections
        ? collections.filter(c => updateOpts.collections!.includes(c.name))
        : collections;

      internal.clearCache();

      let totalIndexed = 0, totalUpdated = 0, totalUnchanged = 0, totalRemoved = 0;

      for (const col of filtered) {
        const result = await reindexCollection(internal, col.path, col.pattern || "**/*.md", col.name, {
          ignorePatterns: col.ignore,
          onProgress: updateOpts?.onProgress
            ? (info) => updateOpts.onProgress!({ collection: col.name, ...info })
            : undefined,
        });
        totalIndexed += result.indexed;
        totalUpdated += result.updated;
        totalUnchanged += result.unchanged;
        totalRemoved += result.removed;
      }

      return {
        collections: filtered.length,
        indexed: totalIndexed,
        updated: totalUpdated,
        unchanged: totalUnchanged,
        removed: totalRemoved,
        needsEmbedding: internal.getHashesNeedingEmbedding(),
      };
    },

    embed: async (embedOpts) => {
      return generateEmbeddings(internal, {
        force: embedOpts?.force,
        model: embedOpts?.model,
        onProgress: embedOpts?.onProgress,
      });
    },

    // Index Health
    getStatus: async () => internal.getStatus(),
    getIndexHealth: async () => internal.getIndexHealth(),

    // Lifecycle
    close: async () => {
      await llm.dispose();
      internal.close();
      if (hasYamlConfig || options.config) {
        setConfigSource(undefined); // Reset config source
      }
    },
  };

  return store;
}
