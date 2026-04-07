# Architecture

## Source Modules

```
src/
├── index.ts              SDK public API (QMDStore interface, createStore)
├── store.ts              Core data access, indexing, document retrieval, collection management
├── search.ts             FTS (BM25), vector search, query expansion, reranking, RRF, snippets
├── hybrid-search.ts      hybridQuery, vectorSearchQuery, structuredSearch orchestration
├── chunking.ts           Smart chunking with markdown-aware break points (900 tok, 15% overlap)
├── llm.ts                node-llama-cpp integration (embed, rerank, generate, model management)
├── db.ts                 Cross-runtime SQLite layer (bun:sqlite / better-sqlite3)
├── db-schema.ts          Schema migrations (v1-v3), database stats
├── collections.ts        YAML config (~/.config/qmd/), collection/context management
├── config-schema.ts      Zod validation for collection config
├── links.ts              Forward/backward link parsing (wikilink, markdown, URL)
├── query-parser.ts       Structured query parser (lex:/vec:/hyde:/expand: syntax)
├── maintenance.ts        Database cleanup (vacuum, orphan removal, cache clearing)
├── doc-reading-config.ts Multi-format reading provider configuration
├── wiki/
│   ├── log.ts            Wiki activity log (append, query, stats, format)
│   ├── lint.ts           Link graph health analysis (orphans, broken links, stale pages)
│   └── index-gen.ts      Wiki index page generator
├── backends/
│   ├── types.ts          DocumentBackend interface (getToc, readContent, grep, query, extractElements)
│   ├── registry.ts       Backend factory and format detection
│   ├── shared.ts         Shared utilities (Address, Content, Grep namespaces)
│   ├── indexing.ts       Generic binary document indexing pipeline
│   ├── python-utils.ts   Async Python subprocess integration
│   ├── python-types.ts   Zod schemas for Python extraction results
│   ├── query-utils.ts    Embedding-based intra-document query
│   ├── pdf.ts            PDF backend (pages, TOC, bookmarks)
│   ├── docx.ts           DOCX backend (sections, tables)
│   ├── pptx.ts           PPTX backend (slides, tables)
│   ├── markdown.ts       Markdown backend
│   └── python/           Python extraction scripts
├── mcp/
│   ├── server.ts         MCP server (stdio + Streamable HTTP transport)
│   ├── server/utils.ts   Dynamic MCP instructions builder
│   └── tools/
│       ├── core.ts       Core tools (query, get, multi_get, status)
│       ├── writing.ts    Writing tools (doc_write, doc_links)
│       ├── document.ts   Document tools (doc_toc, doc_read, doc_grep, doc_query, doc_elements)
│       └── wiki.ts       Wiki tools (wiki_ingest, wiki_lint, wiki_log, wiki_index)
└── cli/
    ├── qmd.ts            CLI entry point
    └── formatter.ts      Output formatting utilities
```

## Hybrid Search Pipeline

```
                              ┌─────────────────┐
                              │   User Query     │
                              └────────┬────────┘
                                       │
                              ┌────────┴────────┐
                              │ Initial FTS Scan │
                              └────────┬────────┘
                                       │
                        ┌──────────────┴──────────────┐
                   score ≥ 0.85 &                 otherwise
                   gap ≥ 0.15?                        │
                        │                             │
                   Strong Signal              ┌───────┴───────┐
                   (skip expansion)           │Query Expansion │
                        │                     │ (fine-tuned)   │
                        │                     └───────┬───────┘
                        │                             │
                        │                  lex/vec/hyde expansions
                        │                     (deduplicated)
                        │                             │
                        └──────────────┬──────────────┘
                                       │
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
     ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
     │ Original (×2 wt)│     │  Expansion 1    │     │  Expansion N    │
     └────────┬────────┘     └────────┬────────┘     └────────┬────────┘
              │                       │                       │
      ┌───────┴───────┐       ┌───────┴───────┐       ┌───────┴───────┐
      ▼               ▼       ▼               ▼       ▼               ▼
  ┌───────┐       ┌───────┐ ┌───────┐     ┌───────┐ ┌───────┐     ┌───────┐
  │ BM25  │       │Vector │ │ BM25  │     │Vector │ │ BM25  │     │Vector │
  │(FTS5) │       │(vec)  │ │(FTS5) │     │(vec)  │ │(FTS5) │     │(vec)  │
  └───┬───┘       └───┬───┘ └───┬───┘     └───┬───┘ └───┬───┘     └───┬───┘
      │               │         │             │         │             │
      └───────┬───────┘         └──────┬──────┘         └──────┬──────┘
              │                        │                       │
              └────────────────────────┼───────────────────────┘
                                       │
                                       ▼
                          ┌───────────────────────┐
                          │   RRF Fusion (k=60)   │
                          │  Original lists: ×2 wt│
                          │  Top-rank bonus: +0.05│
                          │     Top 40 kept       │
                          └───────────┬───────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │    LLM Re-ranking     │
                          │  (qwen3-reranker)     │
                          │  Cross-encoder logprob│
                          └───────────┬───────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │  Position-Aware Blend │
                          │  Top 1-3:  75% RRF    │
                          │  Top 4-10: 60% RRF    │
                          │  Top 11+:  40% RRF    │
                          └───────────────────────┘
```

## Score Normalization & Fusion

### Search Backends

| Backend | Raw Score | Conversion | Range |
|---------|-----------|------------|-------|
| **FTS (BM25)** | SQLite FTS5 BM25 | `abs(score) / (1 + abs(score))` | 0.0 to 1.0 |
| **Vector** | Cosine distance | `1 - distance` (= cosine similarity) | 0.0 to 1.0 |
| **Reranker** | LLM logprob confidence | `score` (0.0 - 1.0) | 0.0 to 1.0 |

### Fusion Strategy

1. **Query Expansion**: Original query (×2 weight) + LLM-generated variations (lex/vec/hyde, deduplicated)
2. **Parallel Retrieval**: Each query searches both FTS and vector indexes; original query results get ×2 weight
3. **Strong Signal Detection**: If a top FTS result scores ≥0.85 with ≥0.15 gap to #2, expansion is skipped
4. **RRF Fusion**: Combine all result lists using `score = Σ(weight/(k+rank+1))` where k=60
5. **Top-Rank Bonus**: Documents ranking #1 in any list get +0.05, #2-3 get +0.02
6. **Top-K Selection**: Take top 40 candidates for reranking
7. **Re-ranking**: LLM cross-encoder scores each document (logprob confidence)
8. **Position-Aware Blending**: `blendedScore = rrfWeight × (1/rrfRank) + (1 - rrfWeight) × rerankScore`
   - RRF rank 1-3: rrfWeight = 0.75 (preserves exact matches)
   - RRF rank 4-10: rrfWeight = 0.60
   - RRF rank 11+: rrfWeight = 0.40 (trust reranker more)

### Score Interpretation

| Score | Meaning |
|-------|---------|
| 0.8 - 1.0 | Highly relevant |
| 0.5 - 0.8 | Moderately relevant |
| 0.2 - 0.5 | Somewhat relevant |
| 0.0 - 0.2 | Low relevance |

## Indexing Flow

```
Collection ──► Glob Pattern ──► Files
                                  │
                          ┌───────┴────────┐
                          ▼                ▼
                     Markdown         PDF/DOCX/PPTX
                     (native)       (Python extraction)
                          │                │
                          ▼                ▼
                    Parse Title      Extract content
                          │          + format cache
                          ▼                │
                     Hash Content ◄────────┘
                          │
                          ▼
                    Generate docid (6-char hash)
                          │
                          ▼
                    Store in SQLite + FTS5 Index
```

## Smart Chunking

Documents are chunked into ~900-token pieces with 15% overlap using smart boundary detection that keeps semantic units (sections, paragraphs, code blocks) together.

**Break Point Scores:**

| Pattern | Score | Description |
|---------|-------|-------------|
| `# Heading` | 100 | H1 - major section |
| `## Heading` | 90 | H2 - subsection |
| `### Heading` | 80 | H3 |
| ` ``` ` | 80 | Code block boundary |
| `---` / `***` | 60 | Horizontal rule |
| Blank line | 20 | Paragraph boundary |
| `- item` | 5 | List item |

**Algorithm:**
1. Scan document for all break points with scores
2. When approaching the 900-token target, search a 200-token window before the cutoff
3. Score each break point: `finalScore = baseScore × (1 - (distance/window)² × 0.7)`
4. Cut at the highest-scoring break point

Code blocks are protected: break points inside code fences are ignored.

## Data Storage

Index stored in: `~/.cache/qmd/index.sqlite`

### Schema

```sql
content              -- Content-addressable storage (hash → document text)
documents            -- Virtual paths → content hashes (collection, path, title, hash, active)
documents_fts        -- FTS5 full-text index (porter + unicode61)
store_collections    -- Collection config (name, path, pattern, type, context)
content_vectors      -- Embedding chunks (hash, seq, pos, model)
vectors_vec          -- sqlite-vec virtual table for cosine similarity search
llm_cache            -- Cached LLM responses (query expansion, rerank scores)
links                -- Forward/backward link tracking
wiki_log             -- Wiki activity log
wiki_sources         -- Wiki page provenance
pages_cache          -- PDF per-page text cache
toc_cache            -- Document table-of-contents cache
section_map          -- DOCX section map
slide_cache          -- PPTX per-slide content cache
```

## GGUF Models

QMD uses three local GGUF models (auto-downloaded on first use):

| Model | Purpose | Size |
|-------|---------|------|
| `embeddinggemma-300M-Q8_0` | Vector embeddings | ~300MB |
| `qwen3-reranker-0.6b-q8_0` | Re-ranking | ~640MB |
| `qmd-query-expansion-1.7B-q4_k_m` | Query expansion (fine-tuned) | ~1.1GB |

Models are downloaded from HuggingFace and cached in `~/.cache/qmd/models/`.

### Custom Embedding Model

Override the default embedding model via `QMD_EMBED_MODEL`:

```sh
# Use Qwen3-Embedding-0.6B for better multilingual (CJK) support
export QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"

# After changing the model, re-embed all collections:
qmd embed -f
```

When switching embedding models, you must re-index with `qmd embed -f` since vectors are not cross-compatible.
