# Changelog

## [Unreleased]

## [1.0.8] - 2026-04-12

### Fixes

- **Actionable error for unindexed files in doc-\* commands** — when `doc-toc`,
  `doc-read`, or `doc-grep` is called with a valid filesystem path that isn't
  indexed, the error now explains the file exists but needs to be added to a
  collection first, with example commands. Previously showed a confusing
  "Document not found" message. #3

## [1.0.7] - 2026-04-09

### Fixes

- **Embed: `-c`/`--collection` filter now works** — the flag was parsed by the
  CLI but never propagated to the embedding pipeline; `qmd embed -c mycoll` now
  only embeds documents from the specified collection(s). #2
- **Embed: collection filtering in `getHashesForEmbedding`** — the SQL query
  previously fetched all active documents missing embeddings regardless of
  collection; it now accepts an optional collection filter. #2
- **Embed: skip HF model resolution when local GGUF exists** — on Windows,
  `resolveModelFile(hf:...)` could hang at "Gathering information" even when the
  GGUF was already cached locally; the resolver now checks the local cache
  directory first and only falls back to HF URI resolution when the file is not
  found. #2
- **Embed: `--force` + `--collection` no longer clears all vectors** — previously
  `qmd embed -c mycoll -f` wiped embeddings for every collection; now only the
  specified collection's vectors are cleared and re-generated. #2
- **Embed: GGUF cache match tightened** — local cache lookup used `includes()`
  which could false-match `.etag` sidecar files or unrelated models with similar
  names; now uses exact-name or `endsWith()` matching. #2
- **SDK: `embed({ collections })` parameter added** — the programmatic
  `QMDStore.embed()` API now accepts an optional `collections` filter, matching
  the CLI behavior. #2

### Docs

- **Python 3.10+ is now a required dependency** — updated README, README-zh,
  quickstart, and CLAUDE.md to reflect this (previously marked as optional).
- **Added "What can you do with it?" section to README** — concrete use cases
  (research assistant, project knowledge base, study companion, enterprise search)
  to help new users understand the project's value.
- **Expanded demo guide** — `demo/README.md` now includes problem statement,
  usage scenarios, all 15 MCP tools with example calls and parameter reference,
  a complete end-to-end workflow walkthrough, customization instructions, and FAQ.
- **Added demo links** to README navigation bar and documentation table.
- **English demo README** — `demo/README.md` is now English; Chinese version
  moved to `demo/README-zh.md`.
- **Demo default reduced to 10 papers** — lowered from 100 to make the demo
  quicker to run end-to-end.

## [1.0.5] - 2026-04-07

### Fixes

- **PDF doc-read address parsing** — accept both `page:N` and `pages:N` formats;
  previously only `pages:` (plural) was recognized, causing `doc-read` with
  `page:1` to return "Invalid address format".

### Chores

- Remove legacy `bin/mineru-rag` alias (no longer referenced in package.json).

## [1.0.4] - 2026-04-07

### Fixes

- **Build: stale Python scripts in dist/** — `npm run build` used `cp -r`
  which nested scripts into `dist/backends/python/python/` when rebuilding,
  leaving old buggy files in place. Added `rm -rf dist/backends/python`
  before copy so the PPTX fix from v1.0.3 is correctly included.

## [1.0.3] - 2026-04-07

### Fixes

- **PPTX indexing crash on python-pptx >= 1.0** — `shape.placeholder_format`
  now raises `ValueError` for non-placeholder shapes instead of returning
  `None`. Use `shape.is_placeholder` guard with `try/except` fallback so PPTX
  files index correctly on all python-pptx versions.
- **Build: stale Python scripts in dist/** — `npm run build` used `cp -r`
  which nested scripts into `dist/backends/python/python/` instead of
  replacing the old files. Added `rm -rf dist/backends/python` before copy
  so rebuilds always pick up source changes.

### Docs

- **Document Processing Setup** — added setup guidance to README.md,
  README-zh.md, CLAUDE.md, SKILL.md, and quickstart.md so agents can
  interactively walk users through Python dependency installation, MinerU
  Cloud configuration, and `doc-reading.json` setup. New "Playbook 0:
  First-Run Setup & Configuration" in the agent skill covers the full
  interactive setup flow.

## [1.0.2] - 2026-04-07

### Fixes

- **Windows stdio MCP fix** — rewrote `bin/qmd` and `bin/mineru-rag` from
  `#!/bin/sh` shell scripts to `#!/usr/bin/env node` Node.js scripts so npm can
  create proper `.cmd`/`.ps1` wrappers on Windows. Previously the shell-based
  launcher failed with "The system cannot find the path specified" because
  Windows has no `sh`. Closes #1.

### Features

- **CLI doc reading commands** — `qmd doc-toc`, `qmd doc-read`, `qmd doc-grep`
  expose the deep reading tools in the CLI. Previously these were only available
  via MCP server; now users can explore document structure and content directly
  from the terminal.

### Changes

- **Rebranded to opendatalab/MinerU-Document-Explorer** — updated package name,
  repository URLs, author, and all references. Version reset to 1.0.0.
- **Enabled npm publish** — `"private": false` in package.json; install via
  `npm install -g mineru-document-explorer`.
- **Unified MCP server name** — changed from `mineru-doc-explorer` to
  `mineru-document-explorer` for consistency with the npm package name.
- **README restructured** — slimmed from 1118 lines to ~160 lines with a Mermaid
  architecture diagram and comparison table. Detailed CLI, SDK, MCP, and
  architecture docs moved to `docs/` directory. Improved quick-start with
  "First 5 Minutes" section and npm install option.
- **First-run model download notice** — `qmd query`, `qmd vsearch`, and
  `qmd embed` now show a helpful notice before downloading models for the first
  time, with model names, sizes, and a tip to use `qmd search` for instant
  keyword search with no downloads.
- **GitHub Actions CI** updated to run on both `main` and `mineru` branches.
  Publish workflow now creates GitHub releases only (no npm publish).
- **Added community files** — `CONTRIBUTING.md`, issue templates (bug report,
  feature request), and PR template.
- **CLI modularization started** — extracted `src/cli/shared.ts` with store
  lifecycle, terminal formatting, and progress utilities. Establishes the
  pattern for future command-module extraction from the 3500-line `qmd.ts`.

### Bug Fixes

- **multi_get failed with comma-separated glob patterns** — passing patterns like
  `"api*.md, config*.md"` (commas + wildcards) was misclassified as a single glob
  pattern instead of multiple separate globs, returning no matches. Fix: detect
  comma-separated globs and split into independent glob matches, deduplicating
  results. Affects both the CLI `multi-get` command and the MCP `multi_get` tool.

### Improvements

- **Improved Skill documentation** — rewrote `skills/qmd/SKILL.md` (v3.0.0) with
  agent session lifecycle, key concepts (addresses, docids), concrete workflow
  examples, and common pitfalls. The skill is now more actionable for agents
  encountering the tools for the first time.
- **Enhanced MCP tool descriptions** — `doc_toc`, `doc_read`, `doc_grep`, and
  `doc_query` descriptions now explicitly explain the address system and tool
  chaining pattern. Dynamic MCP instructions include address format hints.

### Bug Fixes

- **Vector search crashed when sqlite-vec module unavailable** — `searchVec`,
  `hybridQuery`, `vectorSearchQuery`, and `structuredSearch` used ad-hoc
  `sqlite_master` queries to check vec0 availability, but these didn't verify
  the vec0 module was actually loaded. When the table existed from a prior
  session but vec0 wasn't loaded, querying the virtual table threw
  `SQLiteError: no such module: vec0` and crashed the process. Fix: refactored
  vec0 availability into a single `store.vecAvailable` boolean set once at DB
  init time, eliminating all scattered runtime probes.
- **MCP daemon didn't forward `--index` flag** — spawning the MCP server as a
  background daemon via `qmd mcp --http --daemon` discarded the `--index` flag,
  causing the daemon to always use the default index regardless of what was
  specified. Fix: forward `--index` to the spawned process args.

### Hardening

- **Added `PRAGMA busy_timeout = 5000`** — prevents `SQLITE_BUSY` errors when
  multiple processes (e.g. CLI + MCP server) access the same database
  concurrently. Without this, the second writer would fail immediately instead
  of waiting for the lock to be released.
- **Wrapped `removeCollection` in a transaction** — all cleanup steps (documents,
  links, wiki tables, content, caches, store_collections) now execute as a
  single atomic transaction. A crash mid-removal no longer leaves orphaned rows.
- **Wrapped `renameStoreCollection` in a transaction** — all rename steps
  (store_collections, documents, FTS, links, wiki tables) now execute
  atomically. A crash mid-rename no longer leaves tables with mismatched
  collection names.

### Bug Fixes

- **removeCollection left orphan wiki tables** — `removeCollection()` deleted
  documents, links, and content but left `wiki_sources` and `wiki_ingest_tracker`
  entries for the removed collection. This caused wiki lint to reference
  non-existent collections and ingest tracker to accumulate stale data. Fix:
  added cleanup for both wiki provenance tables during collection removal.
- **renameCollection didn't update wiki tables** — `renameStoreCollection()`
  updated `store_collections`, `documents`, `documents_fts`, and `links` but
  left `wiki_sources.wiki_collection`, `wiki_sources.wiki_file`, and
  `wiki_ingest_tracker.wiki_collection` with the old collection name. After
  renaming a wiki collection, source provenance tracking and incremental ingest
  became invalid. Fix: added wiki table updates to `renameStoreCollection()`.
- **FTS search couldn't find hyphenated terms** — searching for
  `"state-of-the-art"` returned no results because `sanitizeFTS5Term()` stripped
  hyphens by removing all non-alphanumeric characters, fusing words into a single
  unmatched token (`"stateoftheart"`). Fix: non-alphanumeric characters are now
  replaced with spaces, producing proper phrase-prefix queries
  (`"state of the art"*`) that match the FTS5 tokenizer's word boundaries. Also
  fixes `node.js` → `"node js"*`, underscored terms, and other punctuated words.
- **SDK removeCollection left orphan documents** — `store.removeCollection()`
  only deleted the collection metadata from `store_collections` but left all
  indexed documents, FTS entries, and links in the database. After removing a
  collection, its documents were still searchable, retrievable via `get()`, and
  counted in `getStatus()`. Fix: SDK now uses the full `removeCollection()`
  pipeline (document deletion + orphaned content cleanup + link cleanup) instead
  of the config-only `deleteStoreCollection()`.
- **renameCollection corrupted link sources** — `renameStoreCollection()` had
  an off-by-one error in the SQL `substr()` call that updated link sources.
  `substr(source, ? + 1)` with parameter `oldName.length + 1` skipped one
  character too many, producing `"newwikipage.md"` instead of
  `"newwiki/page.md"`. After renaming a collection, `getLinks()` returned no
  forward links. Fix: changed SQL to `substr(source, ?)` so the parameter is
  used directly as the 1-indexed start position.
- **removeCollection left orphan links** — `removeCollection()` in `store.ts`
  deleted documents and orphaned content but did not clean up the `links` table.
  Links from removed collections persisted as orphan data. Fix: added
  `DELETE FROM links WHERE source LIKE ?` during collection removal.
- **writeDocument overwrite** — overwriting an existing document via
  `store.writeDocument()` no longer fails with `SQLITE_CONSTRAINT_PRIMARYKEY`.
  Root cause: FTS5 trigger `documents_au` couldn't handle upsert properly.
  Fix: delete-then-insert instead of relying on ON CONFLICT upsert.
- **multiGet with single docid** — `store.multiGet("#abc123")` now works
  correctly. Previously, single docid patterns were treated as glob patterns
  instead of comma-separated lists, returning empty results.
- **renameCollection preserves FTS** — `store.renameCollection()` now updates
  the `documents` table `collection` column, FTS entries, and link sources.
  Previously, search results still showed the old collection name after rename.
- **findSimilarFiles improved matching** — similar file suggestions now compare
  against both `path` and `collection/path` formats, and return `collection/path`
  display paths. Previously, a query like `docs/api-desing.md` would never match
  `api-design.md` because the collection prefix inflated the edit distance.

### Improvements

- **Clean snippets** — `extractSnippet()` no longer embeds `@@ -line,count @@`
  diff headers in the snippet text. The metadata (`line`, `linesBefore`,
  `linesAfter`, `snippetLines`) is available as structured return fields. MCP,
  CLI, and SDK consumers all get clean, human-readable snippet text.
- **Search pipeline refactor** — extracted ~200 lines of duplicated scoring,
  blending, chunking, and dedup logic from `hybridQuery` and `structuredSearch`
  into shared helpers (`buildResult`, `buildSkipRerankResults`,
  `buildRerankResults`, `dedupAndFilter`, `chunkAndSelectBest`).
- **Shared query parser** — `parseStructuredQuery` extracted from CLI to
  `src/query-parser.ts` so both production code and tests share one
  implementation. Eliminates drift risk from duplicated copies in 2 test files.

### Tests

- **65 new agent-experience tests** in `test/agent-experience.test.ts` covering:
  - Store lifecycle: persistence across close/reopen, status accuracy (3 tests)
  - Collection removal: document cleanup, status cleanup, get cleanup, link
    cleanup, cross-collection isolation (5 tests)
  - Document lifecycle: overwrite consistency, update idempotency, multi-write,
    docid consistency (4 tests)
  - getDocumentBody: fromLine, maxLines, edge cases, docid lookup (6 tests)
  - Rename collection: search, get, filter, multiGet, links (5 tests)
  - Multi-collection search: filter, cross-collection (2 tests)
  - Context inheritance: hierarchical, global+collection, list, remove (4 tests)
  - Update idempotency: repeated calls, file modification, deletion, progress (4 tests)
  - Error handling: clear messages for all error paths (5 tests)
  - Search quality: scoring, sorting, phrases, negation, snippets (5 tests)
  - Wikilink workflow: forward/backward links, overwrite link update (2 tests)
  - multiGet patterns: glob, comma, docid, mixed, maxBytes (7 tests)
  - Status accuracy: document count, needsEmbedding, collection types (3 tests)
  - extractSnippet: edge cases, intent bias (5 tests)
  - Structured search: pre-expanded queries, validation, output format (5 tests)
- Total tests: 1024 (up from 833), zero regressions.
- **52 new agent-workflow tests** in `test/sdk-agent-workflow.test.ts` covering:
  - SDK `writeDocument`: create, overwrite, nested dirs, title extraction,
    path escape rejection, wikilink parsing (9 tests)
  - SDK `getLinks`: forward/backward links, direction filter, link type filter,
    line numbers, error handling (6 tests)
  - Search edge cases: empty query, special characters, unicode, long queries,
    quoted phrases, negation, limits, collection filter, score ranges (12 tests)
  - `extractSnippet` quality: no `@@` headers, maxLen, chunkPos, intent bias,
    metadata accuracy (8 tests)
  - Document retrieval: displayPath, docid, similar files, body slicing,
    multiGet patterns/docids (10 tests)
  - Collection management: wiki type, rename, remove (4 tests)
  - Context management: search context, global context, remove (3 tests)

### Features

- **Renamed to MinerU Document Explorer** — the project is now positioned as an
  "agent-native knowledge engine" with tools organized in three groups: Retrieval
  (`query`, `get`, `multi_get`, `status`), Deep Reading (`doc_toc`, `doc_read`,
  `doc_grep`, `doc_query`, `doc_elements`, `doc_links`), and Knowledge Ingestion
  (`wiki_ingest`, `doc_write`, `wiki_lint`, `wiki_log`, `wiki_index`). MCP server
  name changed from `mineru-rag` to `mineru-doc-explorer`. CLI short name `qmd`
  and `bin/mineru-rag` alias are preserved for backward compatibility.
- **Graceful degradation when LLM models unavailable** — `hybridQuery` now wraps
  `expandQuery` and `rerank` in try-catch. When generation or reranking models
  are not downloaded, `qmd query` falls back to BM25-only search instead of
  throwing. This lets new users get results immediately without downloading 3GB
  of models first.
- **Build automation for embedded skills** — `scripts/sync-embedded-skills.js`
  auto-regenerates `src/embedded-skills.ts` from `skills/qmd/` source files
  during `npm run build`, preventing drift between skill source and embedded copy.
- **Cross-collection docid dedup** — search results no longer return duplicate
  entries when identical content exists in multiple collections. Dedup by
  content hash (docid) in `hybridQuery`, `structuredSearch`, and CLI `search`.
- **Flexible glob patterns in multi-get** — `matchFilesByGlob` now accepts
  `collection/path` patterns (e.g. `mydocs/*.md`) in addition to the existing
  `qmd://collection/path` and bare `path` formats.
- **Improved MCP server identity** — server name is `mineru-doc-explorer`,
  version synced with package.json. MCP instructions now list all 15 tools
  in three groups, include collection status, and provide a typical agent
  workflow cheat sheet.
- **Wiki title-based wikilink resolution** — `[[CAP Theorem]]` now resolves
  to a document titled "CAP Theorem" even when the file is `cap-theorem.md`.
  Fixes orphan detection, broken link analysis, and backward link resolution
  in `wiki_lint` and `doc_links`.
- **Wiki CLI error handling** — `wiki index` and `wiki ingest` now show clean
  error messages instead of stack traces for invalid collections.
- **LLM Wiki pattern** — collections now have a `type` field (`raw` or `wiki`).
  Wiki collections are LLM-maintained knowledge bases; raw collections are
  immutable sources. Implements the [Karpathy LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern.
- New MCP tools: `wiki_ingest`, `wiki_lint`, `wiki_log`, `wiki_index` for the
  full wiki lifecycle (ingest sources → write pages → lint health → generate index)
- `doc_write` auto-logs operations for wiki collections; warns on raw collection writes
- `qmd wiki init|lint|log|index` CLI subcommands
- `qmd collection add --type wiki` flag to create wiki collections
- DB schema v2 migration: `store_collections.type` column + `wiki_log` table
- MCP server instructions now guide LLM agents through wiki workflows
- **Simple query mode for MCP** — the `query` tool now accepts a plain `query`
  string (e.g. `{query: "machine learning"}`) as an alternative to the
  structured `searches` array. The system auto-expands simple queries into
  BM25 + semantic + HyDE searches with LLM reranking. This makes the tool
  dramatically easier for AI agents while preserving the advanced `searches`
  mode for precise control.
- **Query expansion dedup** — duplicate sub-queries from LLM expansion are
  filtered before execution. Previously the expansion model could generate
  30+ queries with many identical HyDE texts, wasting ~80% of embedding
  compute. Dedup applies to both fresh expansions and cached results.
- **Clean snippet format in MCP** — search result snippets in
  `structuredContent` no longer include the `@@ diff header`. Snippets are
  now clean text with a separate `line` field for navigation.
- **Source-aware staleness detection** — `wiki_lint` now detects wiki pages
  whose source documents have been updated after the wiki page was last
  written. Uses the new `wiki_sources` provenance table to compare
  modification timestamps. Reported as `source_stale_pages` alongside
  existing time-based staleness.
- **Incremental wiki ingest** — `wiki_ingest` now tracks previously ingested
  sources via `wiki_ingest_tracker`. If a source's content hash hasn't
  changed, returns cached status with derived wiki pages instead of
  re-processing. Use `force=true` (MCP) or `--force` (CLI) to re-ingest.
- **Multi-format ingest enrichment** — `wiki_ingest` now provides structural
  metadata for PDF, DOCX, and PPTX sources: TOC structure, page/section/slide
  counts, and automatic truncation for large documents (>50k chars) with
  guidance to use `doc_read` for specific sections.
- **DOCX/PPTX backend bug fixes (TDD)** — comprehensive TDD test suite (68
  tests) uncovered and fixed several bugs:
  - Error messages in `readContent` were silently truncated to empty strings
    (affected all backends: docx, pptx, pdf, markdown)
  - PPTX `charOffsetToSlide` offset mismatch when slides have empty text
    (indexer drops empty slides but backend included them in offset calc)
  - `DocxSectionSchema` required `text` field but Python extractor doesn't
    emit it — fixed to `optional()`
  - PPTX table extraction was broken: Python embeds tables per-slide but
    TypeScript schema expected top-level — added Zod transform to normalize
- **Source provenance tracking** — `doc_write` accepts an optional `source`
  parameter to record which source document a wiki page was derived from.
  CLI `wiki write` supports `--source <file>`. Provenance data feeds
  `wiki_lint` source staleness detection.
- DB schema v3 migration: `wiki_sources` (provenance) + `wiki_ingest_tracker`
  (incremental ingest) tables.

### Fixes

- **BM25 body column had weight 0** — the `bm25()` call only specified weights
  for 2 of 3 FTS5 columns (filepath, title), leaving body at weight 0. Matches
  in document body contributed nothing to the BM25 score. Fixed to
  `bm25(documents_fts, 2.0, 5.0, 1.0)` — title-weighted, body-included.
- **BM25 scores displayed as 0%** — very common terms (appearing in >50% of
  documents) produced BM25 scores of ~1e-6 which rounded to 0. Added a minimum
  score floor of 0.01 (1%) for documents that actually match the query.
- **Wiki lint case-insensitive title matching** — `[[CAP theorem]]` now
  resolves to a page titled "CAP Theorem" (case-insensitive). Previously
  title-based wikilink resolution was case-sensitive, causing valid links to
  show as broken.
- **MCP test schema alignment** — test DB setup now includes `type` column
  in `store_collections` and `wiki_log` table, matching v2 migration schema.
- **multi_get docid resolution** — `multi_get` with comma-separated docids
  (e.g. `#df12ed, #762e73`) now correctly resolves document IDs. Previously
  only `get` supported docid lookup; `multi_get` tried to match them as paths.

### Internal

- 53 new tests across 4 test files (`wiki-log`, `wiki-lint`, `wiki-index`,
  `wiki-collection-type`) covering log CRUD, link graph analysis, index
  generation, collection type accessors, and DB migration v2

## [2.0.1] - 2026-03-10

### Changes

- `qmd skill install` copies the packaged QMD skill into
  `~/.claude/commands/` for one-command setup. #355 (thanks @nibzard)

### Fixes

- Fix Qwen3-Embedding GGUF filename case — HuggingFace filenames are
  case-sensitive, the lowercase variant returned 404. #349 (thanks @byheaven)
- Resolve symlinked global launcher path so `qmd` works correctly when
  installed via `npm i -g`. #352 (thanks @nibzard)

## [2.0.0] - 2026-03-10

QMD 2.0 declares a stable library API. The SDK is now the primary interface —
the MCP server is a clean consumer of it, and the source is organized into
`src/cli/` and `src/mcp/`. Also: Node 25 support and a runtime-aware bin wrapper
for bun installs.

### Changes

- Stable SDK API with `QMDStore` interface — search, retrieval, collection/context
  management, indexing, lifecycle
- Unified `search()`: pass `query` for auto-expansion or `queries` for
  pre-expanded lex/vec/hyde — replaces the old query/search/structuredSearch split
- New `getDocumentBody()`, `getDefaultCollectionNames()`, `Maintenance` class
- MCP server rewritten as a clean SDK consumer — zero internal store access
- CLI and MCP organized into `src/cli/` and `src/mcp/` subdirectories
- Runtime-aware `bin/qmd` wrapper detects bun vs node to avoid ABI mismatches.
  Closes #319
- `better-sqlite3` bumped to ^12.4.5 for Node 25 support. Closes #257
- Utility exports: `extractSnippet`, `addLineNumbers`, `DEFAULT_MULTI_GET_MAX_BYTES`

### Fixes

- Remove unused `import { resolve }` in store.ts that shadowed local export

## [1.1.6] - 2026-03-09

QMD can now be used as a library. `import { createStore } from 'mineru-document-explorer'`
gives you the full search and indexing API — hybrid query, BM25, structured
search, collection/context management — without shelling out to the CLI.

### Changes

- **SDK / library mode**: `createStore({ dbPath, config })` returns a
  `QMDStore` with `query()`, `search()`, `structuredSearch()`, `get()`,
  `multiGet()`, and collection/context management methods. Supports inline
  config (no files needed) or a YAML config path.
- **Package exports**: `package.json` now declares `main`, `types`, and
  `exports` so bundlers and TypeScript resolve `mineru-document-explorer` correctly.

## [1.1.5] - 2026-03-07

Ambiguous queries like "performance" now produce dramatically better results
when the caller knows what they mean. The new `intent` parameter steers all
five pipeline stages — expansion, strong-signal bypass, chunk selection,
reranking, and snippet extraction — without searching on its own. Design and
original implementation by Ilya Grigorik (@vyalamar) in #180.

### Changes

- **Intent parameter**: optional `intent` string disambiguates queries across
  the entire search pipeline. Available via CLI (`--intent` flag or `intent:`
  line in query documents), MCP (`intent` field on the query tool), and
  programmatic API. Adapted from PR #180 (thanks @vyalamar).
- **Query expansion**: when intent is provided, the expansion LLM prompt
  includes `Query intent: {intent}`, matching the finetune training data
  format for better-aligned expansions.
- **Reranking**: intent is prepended to the rerank query so Qwen3-Reranker
  scores with domain context.
- **Chunk selection**: intent terms scored at 0.5× weight alongside query
  terms (1.0×) when selecting the best chunk per document for reranking.
- **Snippet extraction**: intent terms scored at 0.3× weight to nudge
  snippets toward intent-relevant lines without overriding query anchoring.
- **Strong-signal bypass disabled with intent**: when intent is provided, the
  BM25 strong-signal shortcut is skipped — the obvious keyword match may not
  be what the caller wants.
- **MCP instructions**: callers are now guided to provide `intent` on every
  search call for disambiguation.
- **Query document syntax**: `intent:` recognized as a line type. At most one
  per document, cannot appear alone. Grammar updated in `docs/SYNTAX.md`.

## [1.1.2] - 2026-03-07

13 community PRs merged. GPU initialization replaced with node-llama-cpp's
built-in `autoAttempt` — deleting ~220 lines of manual fallback code and
fixing GPU issues reported across 10+ PRs in one shot. Reranking is faster
through chunk deduplication and a parallelism cap that prevents VRAM
exhaustion.

### Changes

- **GPU init**: use node-llama-cpp's `build: "autoAttempt"` instead of manual
  GPU backend detection. Automatically tries Metal/CUDA/Vulkan and falls back
  gracefully. #310 (thanks @giladgd — the node-llama-cpp author)
- **Query `--explain`**: `qmd query --explain` exposes retrieval score traces
  — backend scores, per-list RRF contributions, top-rank bonus, reranker
  score, and final blended score. Works in JSON and CLI output. #242
  (thanks @vyalamar)
- **Collection ignore patterns**: `ignore: ["Sessions/**", "*.tmp"]` in
  collection config to exclude files from indexing. #304 (thanks @sebkouba)
- **Multilingual embeddings**: `QMD_EMBED_MODEL` env var lets you swap in
  models like Qwen3-Embedding for non-English collections. #273 (thanks
  @daocoding)
- **Configurable expansion context**: `QMD_EXPAND_CONTEXT_SIZE` env var
  (default 2048) — previously used the model's full 40960-token window,
  wasting VRAM. #313 (thanks @0xble)
- **`candidateLimit` exposed**: `-C` / `--candidate-limit` flag and MCP
  parameter to tune how many candidates reach the reranker. #255 (thanks
  @pandysp)
- **MCP multi-session**: HTTP transport now supports multiple concurrent
  client sessions, each with its own server instance. #286 (thanks @joelev)

### Fixes

- **Reranking performance**: cap parallel rerank contexts at 4 to prevent
  VRAM exhaustion on high-core machines. Deduplicate identical chunk texts
  before reranking — same content from different files now shares a single
  reranker call. Cache scores by content hash instead of file path.
- Deactivate stale docs when all files are removed from a collection and
  `qmd update` is run. #312 (thanks @0xble)
- Handle emoji-only filenames (`🐘.md` → `1f418.md`) instead of crashing.
  #308 (thanks @debugerman)
- Skip unreadable files during indexing (e.g. iCloud-evicted files returning
  EAGAIN) instead of crashing. #253 (thanks @jimmynail)
- Suppress progress bar escape sequences when stderr is not a TTY. #230
  (thanks @dgilperez)
- Emit format-appropriate empty output (`[]` for JSON, CSV header for CSV,
  etc.) instead of plain text "No results." #228 (thanks @amsminn)
- Correct Windows sqlite-vec package name (`sqlite-vec-windows-x64`) and add
  `sqlite-vec-linux-arm64`. #225 (thanks @ilepn)
- Fix claude plugin setup CLI commands in README. #311 (thanks @gi11es)

## [1.1.1] - 2026-03-06

### Fixes

- Reranker: truncate documents exceeding the 2048-token context window
  instead of silently producing garbage scores. Long chunks (e.g. from
  PDF ingestion) now get a fair ranking.
- Nix: add python3 and cctools to build dependencies. #214 (thanks
  @pcasaretto)

## [1.1.0] - 2026-02-20

QMD now speaks in **query documents** — structured multi-line queries where every line is typed (`lex:`, `vec:`, `hyde:`), combining keyword precision with semantic recall. A single plain query still works exactly as before (it's treated as an implicit `expand:` and auto-expanded by the LLM). Lex now supports quoted phrases and negation (`"C++ performance" -sports -athlete`), making intent-aware disambiguation practical. The formal query grammar is documented in `docs/SYNTAX.md`.

The npm package now uses the standard `#!/usr/bin/env node` bin convention, replacing the custom bash wrapper. This fixes native module ABI mismatches when installed via bun and works on any platform with node >= 22 on PATH.

### Changes

- **Query document format**: multi-line queries with typed sub-queries (`lex:`, `vec:`, `hyde:`). Plain queries remain the default (`expand:` implicit, but not written inside the document). First sub-query gets 2× fusion weight — put your strongest signal first. Formal grammar in `docs/SYNTAX.md`.
- **Lex syntax**: full BM25 operator support. `"exact phrase"` for verbatim matching; `-term` and `-"phrase"` for exclusions. Essential for disambiguation when a term is overloaded across domains (e.g. `performance -sports -athlete`).
- **`expand:` shortcut**: send a single plain query (or start the document with `expand:` on its only line) to auto-expand via the local LLM. Query documents themselves are limited to `lex`, `vec`, and `hyde` lines.
- **MCP `query` tool** (renamed from `structured_search`): rewrote the tool description to fully teach AI agents the query document format, lex syntax, and combination strategy. Includes worked examples with intent-aware lex.
- **HTTP `/query` endpoint** (renamed from `/search`; `/search` kept as silent alias).
- **`collections` array filter**: filter by multiple collections in a single query (`collections: ["notes", "brain"]`). Removed the single `collection` string param — array only.
- **Collection `include`/`exclude`**: `includeByDefault: false` hides a collection from all queries unless explicitly named via `collections`. CLI: `qmd collection exclude <name>` / `qmd collection include <name>`.
- **Collection `update-cmd`**: attach a shell command that runs before every `qmd update` (e.g. `git stash && git pull --rebase --ff-only && git stash pop`). CLI: `qmd collection update-cmd <name> '<cmd>'`.
- **`qmd status` tips**: shows actionable tips when collections lack context descriptions or update commands.
- **`qmd collection` subcommands**: `show`, `update-cmd`, `include`, `exclude`. Bare `qmd collection` now prints help.
- **Packaging**: replaced custom bash wrapper with standard `#!/usr/bin/env node` shebang on `dist/qmd.js`. Fixes native module ABI mismatches when installed via bun, and works on any platform where node >= 22 is on PATH.
- **Removed MCP tools** `search`, `vector_search`, `deep_search` — all superseded by `query`.
- **Removed** `qmd context check` command.
- **CLI timing**: each LLM step (expand, embed, rerank) prints elapsed time inline (`Expanding query... (4.2s)`).

### Fixes

- `qmd collection list` shows `[excluded]` tag for collections with `includeByDefault: false`.
- Default searches now respect `includeByDefault` — excluded collections are skipped unless explicitly named.
- Fix main module detection when installed globally via npm/bun (symlink resolution).

## [1.0.7] - 2026-02-18

### Changes

- LLM: add LiquidAI LFM2-1.2B as an alternative base model for query
  expansion fine-tuning. LFM2's hybrid architecture (convolutions + attention)
  is 2x faster at decode/prefill vs standard transformers — good fit for
  on-device inference.
- CLI: support multiple `-c` flags to search across several collections at
  once (e.g. `qmd search -c notes -c journals "query"`). #191 (thanks
  @openclaw)

### Fixes

- Return empty JSON array `[]` instead of no output when `--json` search
  finds no results.
- Resolve relative paths passed to `--index` so they don't produce malformed
  config entries.
- Respect `XDG_CONFIG_HOME` for collection config path instead of always
  using `~/.config`. #190 (thanks @openclaw)
- CLI: empty-collection hint now shows the correct `collection add` command.
  #200 (thanks @vincentkoc)

## [1.0.6] - 2026-02-16

### Changes

- CLI: `qmd status` now shows models with full HuggingFace links instead of
  static names in `--help`. Model info is derived from the actual configured
  URIs so it stays accurate if models change.
- Release tooling: pre-push hook handles non-interactive shells (CI, editors)
  gracefully — warnings auto-proceed instead of hanging on a tty prompt.
  Annotated tags now resolve correctly for CI checks.

## [1.0.5] - 2026-02-16

The npm package now ships compiled JavaScript instead of raw TypeScript,
removing the `tsx` runtime dependency. A new `/release` skill automates the
full release workflow with changelog validation and git hook enforcement.

### Changes

- Build: compile TypeScript to `dist/` via `tsc` so the npm package no longer
  requires `tsx` at runtime. The `qmd` shell wrapper now runs `dist/qmd.js`
  directly.
- Release tooling: new `/release` skill that manages the full release
  lifecycle — validates changelog, installs git hooks, previews release notes,
  and cuts the release. Auto-populates `[Unreleased]` from git history when
  empty.
- Release tooling: `scripts/extract-changelog.sh` extracts cumulative notes
  for the full minor series (e.g. 1.0.0 through 1.0.5) for GitHub releases.
  Includes `[Unreleased]` content in previews.
- Release tooling: `scripts/release.sh` renames `[Unreleased]` to a versioned
  heading and inserts a fresh empty `[Unreleased]` section automatically.
- Release tooling: pre-push git hook blocks `v*` tag pushes unless
  `package.json` version matches the tag, a changelog entry exists, and CI
  passed on GitHub.
- Publish workflow: GitHub Actions now builds TypeScript, creates a GitHub
  release with cumulative notes extracted from the changelog, and publishes
  to npm with provenance.

## [1.0.0] - 2026-02-15

QMD now runs on both Node.js and Bun, with up to 2.7x faster reranking
through parallel GPU contexts. GPU auto-detection replaces the unreliable
`gpu: "auto"` with explicit CUDA/Metal/Vulkan probing.

### Changes

- Runtime: support Node.js (>=22) alongside Bun via a cross-runtime SQLite
  abstraction layer (`src/db.ts`). `bun:sqlite` on Bun, `better-sqlite3` on
  Node. The `qmd` wrapper auto-detects a suitable Node.js install via PATH,
  then falls back to mise, asdf, nvm, and Homebrew locations.
- Performance: parallel embedding & reranking via multiple LlamaContext
  instances — up to 2.7x faster on multi-core machines.
- Performance: flash attention for ~20% less VRAM per reranking context,
  enabling more parallel contexts on GPU.
- Performance: right-sized reranker context (40960 → 2048 tokens, 17x less
  memory) since chunks are capped at ~900 tokens.
- Performance: adaptive parallelism — context count computed from available
  VRAM (GPU) or CPU math cores rather than hardcoded.
- GPU: probe for CUDA, Metal, Vulkan explicitly at startup instead of
  relying on node-llama-cpp's `gpu: "auto"`. `qmd status` shows device info.
- Tests: reorganized into flat `test/` directory with vitest for Node.js and
  bun test for Bun. New `eval-bm25` and `store.helpers.unit` suites.

### Fixes

- Prevent VRAM waste from duplicate context creation during concurrent
  `embedBatch` calls — initialization lock now covers the full path.
- Collection-aware FTS filtering so scoped keyword search actually restricts
  results to the requested collection.

## [0.9.0] - 2026-02-15

First published release. MCP HTTP transport with
daemon mode cuts warm query latency from ~16s to ~10s by keeping models
loaded between requests.

### Changes

- MCP: HTTP transport with daemon lifecycle — `qmd mcp --http --daemon`
  starts a background server, `qmd mcp stop` shuts it down. Models stay warm
  in VRAM between queries. #149 (thanks @igrigorik)
- Search: type-routed query expansion preserves lex/vec/hyde type info and
  routes to the appropriate backend. Eliminates ~4 wasted backend calls per
  query (10.0 → 6.0 calls, 1278ms → 549ms). #149 (thanks @igrigorik)
- Search: unified pipeline — extracted `hybridQuery()` and
  `vectorSearchQuery()` to `store.ts` so CLI and MCP share identical logic.
  Fixes a class of bugs where results differed between the two. #149 (thanks
  @igrigorik)
- MCP: dynamic instructions generated at startup from actual index state —
  LLMs see collection names, doc counts, and content descriptions. #149
  (thanks @igrigorik)
- MCP: tool renames (vsearch → vector_search, query → deep_search) with
  rewritten descriptions for better tool selection. #149 (thanks @igrigorik)
- Integration: Claude Code plugin with inline status checks and MCP
  integration. #99 (thanks @galligan)

### Fixes

- BM25 score normalization — formula was inverted (`1/(1+|x|)` instead of
  `|x|/(1+|x|)`), so strong matches scored *lowest*. Broke `--min-score`
  filtering and made the "strong signal" short-circuit dead code. #76 (thanks
  @dgilperez)
- Normalize Unicode paths to NFC for macOS compatibility. #82 (thanks
  @c-stoeckl)
- Handle dense content (code) that tokenizes beyond expected chunk size.
- Proper cleanup of Metal GPU resources on process exit.
- SQLite-vec readiness verification after extension load.
- Reactivate deactivated documents on re-index instead of creating duplicates.
- Bun UTF-8 path corruption workaround for non-ASCII filenames.
- Disable following symlinks in glob.scan to avoid infinite loops.

## [0.8.0] - 2026-01-28

Fine-tuned query expansion model trained with GRPO replaces the stock Qwen3
0.6B. The training pipeline scores expansions on named entity preservation,
format compliance, and diversity — producing noticeably better lexical
variations and HyDE documents.

### Changes

- LLM: deploy GRPO-trained (Group Relative Policy Optimization) query
  expansion model, hosted on HuggingFace and auto-downloaded on first use.
  Better preservation of proper nouns and technical terms in expansions.
- LLM: `/only:lex` mode for single-type expansions — useful when you know
  which search backend will help.
- LLM: HyDE output moved to first position so vector search can start
  embedding while other expansions generate.
- LLM: session lifecycle management via `withLLMSession()` pattern — ensures
  cleanup even on failure, similar to database transactions.
- Integration: org-mode title extraction support. #50 (thanks @sh54)
- Integration: SQLite extension loading in Nix devshell. #48 (thanks @sh54)
- Integration: AI agent discovery via skills.sh. #64 (thanks @Algiras)

### Fixes

- Use sequential embedding on CPU-only systems — parallel contexts caused a
  race condition where contexts competed for CPU cores, making things slower.
  #54 (thanks @freeman-jiang)
- Fix `collectionName` column in vector search SQL (was still using old
  `collectionId` from before YAML migration). #61 (thanks @jdvmi00)
- Fix Qwen3 sampling params to prevent repetition loops — stock
  temperature/top-p caused occasional infinite repeat patterns.
- Add `--index` option to CLI argument parser (was documented but not wired
  up). #84 (thanks @Tritlo)
- Fix DisposedError during slow batch embedding. #41 (thanks @wuhup)

## [0.7.0] - 2026-01-09

First community contributions. The project gained external contributors,
surfacing bugs that only appear in diverse environments — Homebrew sqlite-vec
paths, case-sensitive model filenames, and sqlite-vec JOIN incompatibilities.

### Changes

- Indexing: native `realpathSync()` replaces `readlink -f` subprocess spawn
  per file. On a 5000-file collection this eliminates 5000 shell spawns,
  ~15% faster. #8 (thanks @burke)
- Indexing: single-pass tokenization — chunking algorithm tokenized each
  document twice (count then split); now tokenizes once and reuses. #9
  (thanks @burke)

### Fixes

- Fix `vsearch` and `query` hanging — sqlite-vec's virtual table doesn't
  support the JOIN pattern used; rewrote to subquery. #23 (thanks @mbrendan)
- Fix MCP server exiting immediately after startup — process had no active
  handles keeping the event loop alive. #29 (thanks @mostlydev)
- Fix collection filter SQL to properly restrict vector search results.
- Support non-ASCII filenames in collection filter.
- Skip empty files during indexing instead of crashing on zero-length content.
- Fix case sensitivity in Qwen3 model filename resolution. #15 (thanks
  @gavrix)
- Fix sqlite-vec loading on macOS with Homebrew (`BREW_PREFIX` detection).
  #42 (thanks @komsit37)
- Fix Nix flake to use correct `src/qmd.ts` path. #7 (thanks @burke)
- Fix docid lookup with quotes support in get command. #36 (thanks
  @JoshuaLelon)
- Fix query expansion model size in documentation. #38 (thanks @odysseus0)

## [0.6.0] - 2025-12-28

Replaced Ollama HTTP API with node-llama-cpp for all LLM operations. Ollama
adds convenience but also a running server dependency. node-llama-cpp loads
GGUF models directly in-process — zero external dependencies. Models
auto-download from HuggingFace on first use.

### Changes

- LLM: structured query expansion via JSON schema grammar constraints.
  Model produces typed expansions — **lexical** (BM25 keywords), **vector**
  (semantic rephrasings), **HyDE** (hypothetical document excerpts) — so each
  routes to the right backend instead of sending everything everywhere.
- LLM: lazy model loading with 2-minute inactivity auto-unload. Keeps memory
  low when idle while avoiding ~3s model load on every query.
- Search: conditional query expansion — when BM25 returns strong results, the
  expensive LLM expansion is skipped entirely.
- Search: multi-chunk reranking — documents with multiple relevant chunks
  scored by aggregating across all chunks rather than best single chunk.
- Search: cosine distance for vector search (was L2).
- Search: embeddinggemma nomic-style prompt formatting.
- Testing: evaluation harness with synthetic test documents and Hit@K metrics
  for BM25, vector, and hybrid RRF.

## [0.5.0] - 2025-12-13

Collections and contexts moved from SQLite tables to YAML at
`~/.config/qmd/index.yml`. SQLite was overkill for config — you can't share
it, and it's opaque. YAML is human-readable and version-controllable. The
migration was extensive (35+ commits) because every part of the system that
touched collections or contexts had to be updated.

### Changes

- Config: YAML-based collections and contexts replace SQLite tables.
  `collections` and `path_contexts` tables dropped from schema. Collections
  support an optional `update:` command (e.g., `git pull`) before re-index.
- CLI: `qmd collection add/list/remove/rename` commands with `--name` and
  `--mask` glob pattern support.
- CLI: `qmd ls` virtual file tree — list collections, files in a collection,
  or files under a path prefix.
- CLI: `qmd context add/list/check/rm` with hierarchical context inheritance.
  A query to `qmd://notes/2024/jan/` inherits context from `notes/`,
  `notes/2024/`, and `notes/2024/jan/`.
- CLI: `qmd context add / "text"` for global context across all collections.
- CLI: `qmd context check` audit command to find paths without context.
- Paths: `qmd://` virtual URI scheme for portable document references.
  `qmd://notes/ideas.md` works regardless of where the collection lives on
  disk. Works in `get`, `multi-get`, `ls`, and context commands.
- CLI: document IDs (docid) — first 6 chars of content hash for stable
  references. Shown as `#abc123` in search results, usable with `get` and
  `multi-get`.
- CLI: `--line-numbers` flag for get command output.

## [0.4.0] - 2025-12-10

MCP server for AI agent integration. Without it, agents had to shell out to
`qmd search` and parse CLI output. The monolithic `qmd.ts` (1840 lines) was
split into focused modules with the project's first test suite (215 tests).

### Changes

- MCP: stdio server with tools for search, vector search, hybrid query,
  document retrieval, and status. Runs over stdio transport for Claude
  Desktop and MCP clients.
- MCP: spec-compliant with June 2025 MCP specification — removed non-spec
  `mimeType`, added `isError: true` to errors, `structuredContent` for
  machine-readable results, proper URI encoding.
- MCP: simplified tool naming (`qmd_search` → `search`) since MCP already
  namespaces by server.
- Architecture: extract `store.ts` (1221 LOC), `llm.ts` (539 LOC),
  `formatter.ts` (359 LOC), `mcp.ts` (503 LOC) from monolithic `qmd.ts`.
- Testing: 215 tests (store: 96, llm: 60, mcp: 59) with mocked Ollama for
  fast, deterministic runs. Before this: zero tests.

## [0.3.0] - 2025-12-08

Document chunking for vector search. A 5000-word document about many topics
gets a single embedding that averages everything together, matching poorly for
specific queries. Chunking produces one embedding per ~900-token section with
focused semantic signal.

### Changes

- Search: markdown-aware chunking — prefers heading boundaries, then paragraph
  breaks, then sentence boundaries. 15% overlap between chunks ensures
  cross-boundary queries still match.
- Search: multi-chunk scoring bonus (+0.02 per additional chunk, capped at
  +0.1 for 5+ chunks). Documents relevant in multiple sections rank higher.
- CLI: display paths show collection-relative paths and extracted titles
  (from H1 headings or YAML frontmatter) instead of raw filesystem paths.
- CLI: `--all` flag returns all matches (use with `--min-score` to filter).
- CLI: byte-based progress bar with ETA for `embed` command.
- CLI: human-readable time formatting ("15m 4s" instead of "904.2s").
- CLI: documents >64KB truncated with warning during embedding.

## [0.2.0] - 2025-12-08

### Changes

- CLI: `--json`, `--csv`, `--files`, `--md`, `--xml` output format flags.
  `--json` for programmatic access, `--files` for piping, `--md`/`--xml` for
  LLM consumption, `--csv` for spreadsheets.
- CLI: `qmd status` shows index health — document count, size, embedding
  coverage, time since last update.
- Search: weighted RRF — original query gets 2x weight relative to expanded
  queries since the user's actual words are a more reliable signal.

## [0.1.0] - 2025-12-07

Initial implementation. Built in a single day for searching personal markdown
notes, journals, and meeting transcripts.

### Changes

- Search: SQLite FTS5 with BM25 ranking. Chose SQLite over Elasticsearch
  because QMD is a personal tool — single binary, no server dependencies.
- Search: sqlite-vec for vector similarity. Same rationale: in-process, no
  external vector database.
- Search: Reciprocal Rank Fusion to combine BM25 and vector results. RRF is
  parameter-free and handles missing signals gracefully.
- LLM: Ollama for embeddings, reranking, and query expansion. Later replaced
  with node-llama-cpp in 0.6.0.
- CLI: `qmd add`, `qmd embed`, `qmd search`, `qmd vsearch`, `qmd query`,
  `qmd get`. ~1800 lines of TypeScript in a single `qmd.ts` file.

[Unreleased]: https://github.com/opendatalab/MinerU-Document-Explorer/compare/v1.0.7...HEAD
[1.0.7]: https://github.com/opendatalab/MinerU-Document-Explorer/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/opendatalab/MinerU-Document-Explorer/compare/v1.0.5...v1.0.6
[1.0.0]: https://github.com/opendatalab/MinerU-Document-Explorer/releases/tag/v1.0.0
[0.9.0]: https://github.com/opendatalab/MinerU-Document-Explorer/compare/v0.8.0...v0.9.0
