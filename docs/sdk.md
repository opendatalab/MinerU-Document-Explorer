# SDK / Library Usage

Use MinerU Document Explorer as a library in your own Node.js or Bun applications.

## Quick Start

```typescript
import { createStore } from 'mineru-document-explorer'

const store = await createStore({
  dbPath: './my-index.sqlite',
  config: {
    collections: {
      docs: { path: '/path/to/docs', pattern: '**/*.md' },
    },
  },
})

const results = await store.search({ query: "authentication flow" })
console.log(results.map(r => `${r.title} (${Math.round(r.score * 100)}%)`))

await store.close()
```

## Store Creation

`createStore()` accepts three modes:

```typescript
import { createStore } from 'mineru-document-explorer'

// 1. Inline config — no files needed besides the DB
const store = await createStore({
  dbPath: './index.sqlite',
  config: {
    collections: {
      docs: { path: '/path/to/docs', pattern: '**/*.md' },
      notes: { path: '/path/to/notes' },
    },
  },
})

// 2. YAML config file — collections defined in a file
const store2 = await createStore({
  dbPath: './index.sqlite',
  configPath: './qmd.yml',
})

// 3. DB-only — reopen a previously configured store
const store3 = await createStore({ dbPath: './index.sqlite' })
```

## Search

The unified `search()` method handles both simple queries and pre-expanded structured queries:

```typescript
// Simple query — auto-expanded via LLM, then BM25 + vector + reranking
const results = await store.search({ query: "authentication flow" })

// With options
const results2 = await store.search({
  query: "rate limiting",
  intent: "API throttling and abuse prevention",
  collection: "docs",
  limit: 5,
  minScore: 0.3,
  explain: true,
})

// Pre-expanded queries — skip auto-expansion, control each sub-query
const results3 = await store.search({
  queries: [
    { type: 'lex', query: '"connection pool" timeout -redis' },
    { type: 'vec', query: 'why do database connections time out under load' },
  ],
  collections: ["docs", "notes"],
})

// Skip reranking for faster results
const fast = await store.search({ query: "auth", rerank: false })
```

For direct backend access:

```typescript
// BM25 keyword search (fast, no LLM)
const lexResults = await store.searchLex("auth middleware", { limit: 10 })

// Vector similarity search (embedding model, no reranking)
const vecResults = await store.searchVector("how users log in", { limit: 10 })

// Manual query expansion for full control
const expanded = await store.expandQuery("auth flow", { intent: "user login" })
const results4 = await store.search({ queries: expanded })
```

## Retrieval

```typescript
// Get a document by path or docid
const doc = await store.get("docs/readme.md")
const byId = await store.get("#abc123")

if (!("error" in doc)) {
  console.log(doc.title, doc.displayPath, doc.context)
}

// Get document body with line range
const body = await store.getDocumentBody("docs/readme.md", {
  fromLine: 50,
  maxLines: 100,
})

// Batch retrieve by glob or comma-separated list
const { docs, errors } = await store.multiGet("docs/**/*.md", {
  maxBytes: 20480,
})
```

## Deep Reading (Document Backends)

Access format-specific backends for page-level / section-level precision:

```typescript
const pdf = await store.getBackend("pdf")

// Get table of contents
const toc = await pdf.getToc("/path/to/file.pdf", "#abc123")

// Read specific pages/sections by address
const content = await pdf.readContent("/path/to/file.pdf", "#abc123", ["page:3-5"], 2000)

// Search within a document
const matches = await pdf.grep("/path/to/file.pdf", "#abc123", "attention mechanism", "gi")

// Semantic search within a document (requires embeddings)
const chunks = await pdf.query("/path/to/file.pdf", "#abc123", "how does attention work", 5)
```

## Collections

```typescript
// Add a collection
await store.addCollection("myapp", {
  path: "/src/myapp",
  pattern: "**/*.ts",
  ignore: ["node_modules/**", "*.test.ts"],
})

// List collections with document stats
const collections = await store.listCollections()

// Get names of collections included in queries by default
const defaults = await store.getDefaultCollectionNames()

// Remove / rename
await store.removeCollection("myapp")
await store.renameCollection("old-name", "new-name")
```

## Context

Context adds descriptive metadata that improves search relevance and is returned alongside results:

```typescript
// Add context for a path within a collection
await store.addContext("docs", "/api", "REST API reference documentation")

// Set global context (applies to all collections)
await store.setGlobalContext("Internal engineering documentation")

// List all contexts
const contexts = await store.listContexts()

// Remove context
await store.removeContext("docs", "/api")
await store.setGlobalContext(undefined)  // clear global
```

## Indexing

```typescript
// Re-index collections by scanning the filesystem
const result = await store.update({
  collections: ["docs"],
  onProgress: ({ collection, file, current, total }) => {
    console.log(`[${collection}] ${current}/${total} ${file}`)
  },
})

// Generate vector embeddings
const embedResult = await store.embed({
  force: false,
  onProgress: ({ current, total, collection }) => {
    console.log(`Embedding ${current}/${total}`)
  },
})
```

## Types

Key types exported for SDK consumers:

```typescript
import type {
  QMDStore,            // The store interface
  SearchOptions,       // Options for search()
  HybridQueryResult,   // Search result with score, snippet, context, explain
  SearchResult,        // Result from searchLex/searchVector
  ExpandedQuery,       // Typed sub-query { type: 'lex'|'vec'|'hyde', query }
  DocumentResult,      // Document metadata + body
  DocumentNotFound,    // Error with similarFiles suggestions
  MultiGetResult,      // Batch retrieval result
  StoreOptions,        // createStore() options
  CollectionConfig,    // Inline config shape
  IndexStatus,         // From getStatus()
} from 'mineru-document-explorer'
```

Utility exports:

```typescript
import {
  createStore,
  extractSnippet,
  addLineNumbers,
  getDefaultDbPath,
  DEFAULT_MULTI_GET_MAX_BYTES,
  Maintenance,
} from 'mineru-document-explorer'
```

## Health & Lifecycle

```typescript
// Index status — document counts, collection info
const status = await store.getStatus()

// Index health — embedding staleness, counts
const health = await store.getIndexHealth()

// Close the store — disposes LLM models and DB connection
await store.close()
```

The SDK requires explicit `dbPath` — no defaults are assumed.
