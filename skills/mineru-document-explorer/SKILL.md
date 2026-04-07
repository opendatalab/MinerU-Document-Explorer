---
name: mineru-document-explorer
description: >
  MinerU Document Explorer — Agent-native knowledge engine.
  Use when users ask to search their documents, look up information in PDFs/DOCX/PPTX/Markdown,
  navigate inside large documents, extract tables/figures, or build wiki knowledge bases.
  Provides three tool groups: information retrieval (query, get, multi_get, status),
  document deep reading (doc_toc, doc_read, doc_grep, doc_query, doc_elements, doc_links),
  and knowledge ingestion (wiki_ingest, doc_write, wiki_lint, wiki_log, wiki_index).
license: MIT
compatibility: >
  Requires qmd CLI or MCP server. Install via npm (npm install -g mineru-document-explorer)
  or from source (https://github.com/opendatalab/MinerU-Document-Explorer).
  PDF/DOCX/PPTX support requires Python 3.10+ with pymupdf, python-docx, python-pptx.
metadata:
  author: MinerU
  version: "3.3.0"
allowed-tools: Bash(qmd:*), mcp__qmd__*, mcp__mineru-document-explorer__*
---

# MinerU Document Explorer

Agent-native knowledge engine — hybrid search and deep reading over Markdown,
PDF, DOCX, PPTX. Designed for AI agents to organize knowledge and retrieve
information autonomously.

## Quick Reference

| I want to... | Tool | Example |
|--------------|------|---------|
| Search across all docs | `query` | `{ "query": "authentication flow" }` |
| Get a specific file | `get` | `{ "file": "#abc123" }` or `{ "file": "docs/readme.md" }` |
| Get multiple files | `multi_get` | `{ "pattern": "docs/*.md" }` |
| See document structure | `doc_toc` | `{ "file": "paper.pdf" }` |
| Read specific sections | `doc_read` | `{ "file": "paper.pdf", "addresses": ["page:3"] }` |
| Find keyword in a doc | `doc_grep` | `{ "file": "report.md", "pattern": "revenue" }` |
| Semantic search in doc | `doc_query` | `{ "file": "paper.pdf", "query": "methodology" }` |
| Extract tables/figures | `doc_elements` | `{ "file": "report.pdf", "element_types": ["table"] }` |
| Write a wiki page | `doc_write` | `{ "collection": "wiki", "path": "topic.md", "content": "..." }` |
| Check wiki health | `wiki_lint` | `{}` |

## Agent Principles

Follow these rules to use the tools effectively:

1. **Collection-relative paths only.** All file paths are prefixed by collection
   name: `mydocs/readme.md`, `papers/survey.pdf`. Never use absolute filesystem
   paths like `/Users/.../file.md`. You can also use `qmd://mydocs/readme.md`.

2. **Navigate before reading large documents.** For PDFs, DOCX, PPTX, or
   Markdown files >100 lines, always use `doc_toc` → `doc_read` instead of
   `get`. The `get` tool dumps the entire document — wasteful for large files.

3. **Addresses bridge navigation and reading.** `doc_toc`, `doc_grep`, and
   `doc_query` return address strings like `line:45-120`. Pass these directly
   to `doc_read`. Never call `doc_read` without addresses from one of these.

4. **Use simple `query` first.** Start with `{ "query": "your terms" }`. Only
   switch to advanced `searches` mode when simple mode misses. The system
   auto-expands into BM25 + semantic + reranking.

5. **Always pass `source` when writing wiki pages.** This enables provenance
   tracking and staleness detection via `wiki_lint`.

6. **Prefer MCP over CLI.** The MCP server keeps models loaded in memory
   (~3GB). CLI reloads on every invocation (~5-15s overhead). If MCP is not
   available, `qmd search` (BM25 only) is instant and needs no model loading.

## Key Concepts

### Collections and File Paths

Documents live in **collections** — named groups with a filesystem path and
glob mask. Collections have two types:
- **raw** (default) — immutable source documents, read-only for agents
- **wiki** — LLM-maintained pages, agents create/update via `doc_write`

File paths in all results are **collection-relative**: `mydocs/readme.md`,
`papers/survey.pdf`. Use these exact paths when calling tools.

### Document IDs (docid)

Every document has a short hash ID like `#abc123` shown in search results.
Use docids anywhere a file path is accepted: `get("#abc123")`,
`doc_toc("#abc123")`. The `#` prefix is optional.

### Addresses

Addresses identify locations within a document. They are the bridge between
navigation tools (`doc_toc`, `doc_grep`, `doc_query`) and the reading tool
(`doc_read`).

| Format | Meaning | Used by |
|--------|---------|---------|
| `line:N` or `line:N-M` | Line or line range | Markdown |
| `page:N` | PDF page | PDF |
| `slide:N` | PPTX slide | PPTX |
| `section:N` | DOCX section | DOCX |

### Three Tool Groups (15 tools)

| Group | Purpose | Tools |
|-------|---------|-------|
| **Retrieval** | Find and fetch documents | `query`, `get`, `multi_get`, `status` |
| **Deep Reading** | Navigate within a document | `doc_toc`, `doc_read`, `doc_grep`, `doc_query`, `doc_elements`, `doc_links` |
| **Knowledge Ingestion** | Build wiki knowledge base | `wiki_ingest`, `doc_write`, `wiki_lint`, `wiki_log`, `wiki_index` |

---

## Playbook 0: First-Run Setup & Configuration

Use when a user first connects MinerU Document Explorer, gives you the project
link, or when PDF/DOCX/PPTX operations fail. Walk the user through setup
**interactively** — check each prerequisite and guide them step by step.

### Step 1 — Check qmd is installed

```bash
which qmd && qmd status
```

If not installed:

```bash
# Option A: npm (recommended)
npm install -g mineru-document-explorer

# Option B: from source
git clone https://github.com/opendatalab/MinerU-Document-Explorer.git
cd MinerU-Document-Explorer && bun install && bun link
```

### Step 2 — Check Python for binary document support

PDF, DOCX, and PPTX processing requires Python 3.10+:

```bash
python3 --version
```

If Python is missing, guide the user to install it for their platform:
- **macOS**: `brew install python@3.12`
- **Ubuntu/Debian**: `sudo apt install python3 python3-pip`
- **Windows**: Download from https://python.org

### Step 3 — Check and install Python packages

Three packages are required for binary document processing:

```bash
python3 -c "import pymupdf; import docx; import pptx; print('All dependencies OK')"
```

If any import fails, install the missing packages:

```bash
pip install pymupdf python-docx python-pptx
```

| Package | Format | What it does |
|---------|--------|-------------|
| `pymupdf` | PDF | Text extraction, bookmarks, page-level reading |
| `python-docx` | DOCX | Section extraction, table extraction |
| `python-pptx` | PPTX | Slide text, table extraction |

### Step 4 — Ask about advanced PDF processing (optional)

Ask the user: **"Do you need high-quality PDF extraction for scanned documents
or complex layouts? MinerU Cloud provides significantly better results than
basic PyMuPDF."**

If yes, guide them to set up **MinerU Cloud**:

1. Get an API key from https://mineru.net
2. Configure it (pick one method):

```bash
# Method A: Environment variable
export MINERU_API_KEY="your-key-here"

# Method B: Config file (~/.config/qmd/doc-reading.json)
mkdir -p ~/.config/qmd
cat > ~/.config/qmd/doc-reading.json << 'EOF'
{
  "docReading": {
    "providers": {
      "fullText": { "pdf": ["mineru_cloud", "pymupdf"] }
    },
    "credentials": {
      "mineru": { "api_key": "YOUR_API_KEY_HERE" }
    }
  }
}
EOF
```

When `MINERU_API_KEY` is set, MinerU Cloud is automatically used as the primary
PDF provider with PyMuPDF as fallback — no config file needed.

Additional Python package for MinerU Cloud:

```bash
pip install mineru-open-sdk
```

### Step 5 — Index documents and verify

```bash
# Index a folder (adjust path to user's documents)
qmd collection add ~/Documents --name mydocs --mask '**/*.{md,pdf,docx,pptx}'

# Verify indexing worked
qmd status

# Test search (instant, no model downloads)
qmd search "test"
```

### Step 6 — Configure MCP server (for AI agent integration)

Ask the user which AI client they use and provide the matching config:

**Claude Code** (`~/.claude/settings.json`):
```json
{ "mcpServers": { "qmd": { "command": "qmd", "args": ["mcp"] } } }
```

**Cursor** (`.cursor/mcp.json`) — HTTP mode recommended:
```bash
qmd mcp --http --daemon   # start the server first
```
```json
{ "mcpServers": { "qmd": { "url": "http://localhost:8181/mcp" } } }
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{ "mcpServers": { "qmd": { "command": "qmd", "args": ["mcp"] } } }
```

### Configuration Reference

**Config file locations** (later overrides earlier):
1. `~/.config/qmd/doc-reading.json` — global settings
2. `./qmd.config.json` — project-level overrides
3. Environment variables — highest priority

**Full config example** (`~/.config/qmd/doc-reading.json`):

```json
{
  "docReading": {
    "providers": {
      "fullText": { "pdf": ["mineru_cloud", "pymupdf"] },
      "toc":      { "pdf": ["native_bookmarks"] },
      "elements": { "docx": ["python_docx_local"], "pptx": ["python_pptx_local"] }
    },
    "credentials": {
      "mineru": {
        "api_key": "your-mineru-api-key",
        "api_url": "https://mineru.net/api/v4"
      },
      "openai": {
        "api_key": "your-openai-api-key",
        "base_url": "https://api.openai.com/v1"
      }
    }
  }
}
```

**Environment variables:**

| Variable | Purpose |
|----------|---------|
| `MINERU_API_KEY` | MinerU Cloud PDF (auto-enables `mineru_cloud` provider) |
| `OPENAI_API_KEY` | GPT PageIndex (LLM-inferred TOC for PDFs) |
| `OPENAI_BASE_URL` | Custom OpenAI-compatible endpoint |

**Provider options:**

| Capability | Provider | Requires |
|-----------|----------|----------|
| PDF full text | `pymupdf` (default) | `pip install pymupdf` |
| PDF full text | `mineru_cloud` | `pip install mineru-open-sdk` + API key |
| PDF full text | `mineru_local` | `pip install mineru-vl-utils[transformers]` + model |
| PDF TOC | `native_bookmarks` (default) | `pip install pymupdf` |
| PDF TOC | `gpt_pageindex` | `pip install tiktoken openai pyyaml` + API key |
| DOCX tables | `python_docx_local` (default) | `pip install python-docx` |
| PPTX tables | `python_pptx_local` (default) | `pip install python-pptx` |

---

## Playbook 1: Search & Answer a Question

Use when the user asks a question and you need to find information.

**Step 1 — Search:**

```json
query({ "query": "how does authentication work" })
```

Results include `docid`, `file`, `score`, `snippet`. Use these to decide
what to read.

**Step 2 — Read the top result:**

If the document is short (snippet suggests it's a small file):

```json
get({ "file": "#abc123" })
```

If the document is large or structured (PDF, long Markdown):

```json
doc_toc({ "file": "#abc123" })
doc_read({ "file": "#abc123", "addresses": ["line:11-20", "line:31-49"] })
```

**Step 3 — Synthesize and answer** using the content you read.

**Tips:**
- Add `intent` to disambiguate: `{ "query": "performance", "intent": "web page load times" }`
- Use `collections` to narrow scope: `{ "query": "...", "collections": ["papers"] }`
- The `get` response header includes `Total lines:` — if >100, switch to `doc_toc` + `doc_read`

---

## Playbook 2: Deep-Read a Large Document

Use when the user points to a specific large document (PDF, DOCX, PPTX, or
long Markdown) and wants to understand it.

**Step 1 — Get the table of contents:**

```json
doc_toc({ "file": "papers/survey.pdf" })
```

Returns a nested tree of sections with addresses. This is your map.

**Step 2 — Read relevant sections:**

Pick addresses from the TOC and read them:

```json
doc_read({ "file": "papers/survey.pdf", "addresses": ["line:11-20", "line:45-60"] })
```

**Step 3 — Search within the document** (if you need to find something specific):

For keywords:

```json
doc_grep({ "file": "papers/survey.pdf", "pattern": "attention mechanism" })
```

For concepts (semantic, requires embeddings):

```json
doc_query({ "file": "papers/survey.pdf", "query": "what evaluation metrics were used" })
```

Both return addresses — pass them to `doc_read`.

**Step 4 — Extract structured elements** (tables, figures):

```json
doc_elements({ "file": "report.pdf", "element_types": ["table"], "query": "revenue" })
```

**Example flow:**

```
doc_toc("papers/survey.pdf")
  → sees section "3. Methodology" at line:45-80
doc_read("papers/survey.pdf", ["line:45-80"])
  → reads methodology section
doc_grep("papers/survey.pdf", "dataset")
  → finds mentions at line:62, line:78
doc_read("papers/survey.pdf", ["line:60-65", "line:76-80"])
  → reads specific paragraphs around dataset mentions
```

---

## Playbook 3: Build Wiki from Sources

Use when the user wants to build a persistent knowledge base from their
documents. Requires a wiki-type collection.

**Step 1 — Ingest a source document:**

```json
wiki_ingest({ "source": "mydocs/distributed-systems.md", "wiki_collection": "mywiki" })
```

Returns: source content, TOC, related existing wiki pages, and suggestions
for what pages to create. Incremental — skips unchanged sources unless
`force: true`.

**Step 2 — Deep-read key sections** (for large sources):

```json
doc_toc({ "file": "mydocs/distributed-systems.md" })
doc_read({ "file": "mydocs/distributed-systems.md", "addresses": ["line:11-30"] })
```

**Step 3 — Write wiki pages:**

```json
doc_write({
  "collection": "mywiki",
  "path": "concepts/cap-theorem.md",
  "content": "# CAP Theorem\n\n**Source:** [[sources/distributed-systems]]\n\n## Overview\n\nThe CAP theorem states that...\n\n## Connections\n- Related to [[concepts/consistency-models]]\n- See also [[concepts/consensus-algorithms]]",
  "title": "CAP Theorem",
  "source": "mydocs/distributed-systems.md"
})
```

Use `[[wikilinks]]` to create cross-references. Always pass `source` for
provenance tracking.

**Step 4 — Health-check:**

```json
wiki_lint({ "collection": "mywiki", "stale_days": 30 })
```

Detects orphan pages, broken links, missing pages, stale content.

**Wiki page template:**

```markdown
# Page Title

**Source:** [[sources/paper-name]]

## Key Points
- ...

## Connections
- Related to [[concepts/topic-a]]
- Extends [[concepts/topic-b]]
```

---

## Playbook 4: Maintain Wiki Health

Use periodically to keep the wiki knowledge base healthy.

```json
wiki_lint({ "collection": "mywiki" })
```

Act on the results:
- **Orphan pages** → add `[[wikilinks]]` from related pages
- **Broken links** → fix the link target or create the missing page
- **Missing pages** → create them with `doc_write`
- **Stale pages** → re-read the source with `doc_read`, update with `doc_write`

View activity history:

```json
wiki_log({ "since": "2025-01-01", "limit": 20 })
```

Generate or update the wiki index:

```json
wiki_index({ "collection": "mywiki", "write": true })
```

---

## Tool Reference

### Retrieval Tools

**`query`** — Search the knowledge base (primary search tool)

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | — | Simple search (mutually exclusive with `searches`) |
| `searches` | array | — | Advanced: `[{type: "lex"|"vec"|"hyde", query: "..."}]` |
| `intent` | string | — | Disambiguation context (steers ranking, not searched) |
| `collections` | string[] | all | Filter to specific collections |
| `limit` | number | 10 | Max results |
| `minScore` | number | 0 | Min relevance 0-1 |

Simple mode auto-expands into BM25 + semantic + reranking. For advanced mode,
first sub-query gets 2x weight.

| Sub-query type | Method | Best for |
|--------|--------|----------|
| `lex` | BM25 keywords | Exact terms, names, `"quoted phrases"`, `-negation` |
| `vec` | Vector semantic | Natural language questions |
| `hyde` | Hypothetical answer | Write 50-100 words resembling the answer |

**`get`** — Retrieve a single document

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `file` | string | — | Path, docid (#abc123), or path:line |
| `fromLine` | number | — | Start line (1-indexed) |
| `maxLines` | number | — | Max lines to return |
| `lineNumbers` | boolean | false | Add line numbers |

Response header includes `Total lines:` — if >100, prefer `doc_toc` + `doc_read`.
On "not found" errors, check "Did you mean?" suggestions.

**`multi_get`** — Batch retrieve

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `pattern` | string | — | Glob, comma-separated paths, or comma-separated globs |
| `maxLines` | number | — | Max lines per file |
| `maxBytes` | number | 10240 | Skip files larger than this |
| `lineNumbers` | boolean | false | Add line numbers |

Pattern examples: `journals/2025-05*.md`, `readme.md, config.md`,
`docs/api*.md, docs/config*.md`, `#abc123, #def456`.

**`status`** — Index health (no parameters)

Returns document counts, embedding status, collection list.
When connected via MCP, this info is already in the system prompt.

### Deep Reading Tools

**`doc_toc`** — Table of contents

| Param | Type | Description |
|-------|------|-------------|
| `file` | string | File path or docid |

Returns a nested tree of sections with `address` fields. Start here for
any large document.

**`doc_read`** — Read at addresses

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `file` | string | — | File path or docid |
| `addresses` | string[] | — | Addresses from doc_toc / doc_grep / doc_query |
| `max_tokens` | number | 2000 | Max tokens per section |

**`doc_grep`** — Keyword search within a document

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `file` | string | — | File path or docid |
| `pattern` | string | — | Regex or keyword (e.g. `"revenue\|profit"`) |
| `flags` | string | `"gi"` | Regex flags |

Returns matches with `address` fields for `doc_read`.

**`doc_query`** — Semantic search within a document

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `file` | string | — | File path or docid |
| `query` | string | — | Natural language query |
| `top_k` | number | 5 | Max ranked chunks to return |

Returns ranked chunks with `address` fields. Requires embeddings.

**`doc_elements`** — Extract tables, figures, equations

| Param | Type | Description |
|-------|------|-------------|
| `file` | string | File path or docid |
| `addresses` | string[] | Optional: restrict extraction scope |
| `query` | string | Optional: filter by relevance |
| `element_types` | string[] | Filter: `"table"`, `"figure"`, `"equation"` |

**`doc_links`** — Forward/backward link graph

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `file` | string | — | File path or docid |
| `direction` | string | `"both"` | `"forward"`, `"backward"`, or `"both"` |
| `link_type` | string | `"all"` | `"wikilink"`, `"markdown"`, `"url"`, or `"all"` |

### Knowledge Ingestion Tools

**`wiki_ingest`** — Prepare source for wiki processing

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `source` | string | — | Source file path or docid |
| `wiki_collection` | string | auto | Target wiki collection |
| `force` | boolean | false | Force re-ingest even if unchanged |

Returns source content, TOC, related pages, suggestions. Large docs (>50k
chars) are truncated — use `doc_read` for details.

**`doc_write`** — Write a document

| Param | Type | Description |
|-------|------|-------------|
| `collection` | string | Target collection name |
| `path` | string | Relative path (e.g. `"concepts/topic.md"`) |
| `content` | string | Full markdown content |
| `title` | string | Optional: document title |
| `source` | string | Optional: source path for provenance |

Writes to disk and immediately re-indexes. Wiki collections auto-log.

**`wiki_lint`** — Health check

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `collection` | string | — | Optional: limit to collection |
| `stale_days` | number | 30 | Days threshold for staleness |

**`wiki_log`** — Activity timeline

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `since` | string | — | ISO date filter (e.g. `"2025-01-01"`) |
| `operation` | string | — | Filter: `"ingest"`, `"update"`, `"lint"`, `"query"`, `"index"` |
| `limit` | number | 20 | Max entries |
| `format` | string | `"markdown"` | `"markdown"` or `"json"` |

**`wiki_index`** — Generate index page

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `collection` | string | — | Wiki collection to index |
| `write` | boolean | false | Write index.md to disk |

---

## Decision Tree

```
START
  │
  ├─ "What's indexed?" → status
  │
  ├─ "Find documents about X" → query
  │     Next: get (small docs) or doc_toc → doc_read (large docs)
  │
  ├─ "Get this specific file" → get (path or #docid)
  │     ⚠ For large docs: use doc_toc + doc_read instead
  │
  ├─ "Get several files" → multi_get (glob or comma-list)
  │
  ├─ "Read section of a large doc" → doc_toc → doc_read
  │
  ├─ "Find keyword in one doc" → doc_grep → doc_read
  │
  ├─ "Conceptual search in one doc" → doc_query → doc_read
  │
  ├─ "Extract tables/figures" → doc_elements
  │
  ├─ "What links to this page?" → doc_links
  │
  ├─ "Build wiki from source" → wiki_ingest → doc_read → doc_write
  │
  └─ "Check wiki health" → wiki_lint
```

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| "Document not found" | Wrong path or missing collection prefix | Check "Did you mean?" suggestions in error; use `status` to see collections |
| "No results found" | Query too specific or wrong collection | Try simpler keywords; omit `collections` to search all; check `status` |
| "No vector embeddings" warning | Embeddings not generated | Tell the user to run `qmd embed` (one-time, downloads ~2GB models) |
| `get` returns too much text | Document is large | Use `doc_toc` → `doc_read` for targeted sections |
| `doc_read` returns empty | No addresses provided or wrong format | Get addresses from `doc_toc`, `doc_grep`, or `doc_query` first |
| Slow first query (~5-15s) | LLM models loading | Normal for MCP startup; subsequent queries are fast. CLI always reloads. |
| PDF/DOCX/PPTX not working | Missing Python dependencies | Follow Playbook 0 to check and install: `python3 -c "import pymupdf; import docx; import pptx"`, then `pip install pymupdf python-docx python-pptx` |
| Wiki page has broken links | Target page doesn't exist | Create the missing page with `doc_write`, or fix the `[[wikilink]]` |
| Stale wiki pages | Source document updated after wiki page written | Run `wiki_lint` to detect; re-read source with `doc_read` and update |
| `multi_get` returns no files | Pattern doesn't match any indexed files | Check exact collection names via `status`; try broader glob |

---

## CLI Reference (when MCP is not available)

```bash
qmd status                                # Index health
qmd query "question"                      # Hybrid search (recommended)
qmd search "keywords"                     # BM25 only (fast, no LLM)
qmd get "#abc123"                         # Get by docid
qmd get "docs/readme.md:100" -l 50        # Line slice
qmd multi-get "journals/2026-*.md" -l 40  # Glob batch
qmd multi-get "a.md, b.md, c.md"          # Comma-separated
qmd doc-toc "paper.pdf"                   # Document TOC
qmd doc-read "paper.pdf" "line:45-120"    # Read section
qmd doc-grep "report.md" "revenue"        # Search in document
qmd mcp                                   # MCP server (stdio)
qmd mcp --http --daemon                   # MCP server (HTTP, background)
```

## Setup

> **For first-time users, use Playbook 0 above** — it walks through the full
> setup interactively, including dependency checks and configuration.

```bash
# Install
npm install -g mineru-document-explorer

# Python dependencies for PDF/DOCX/PPTX (required for binary formats)
pip install pymupdf python-docx python-pptx

# Optional: MinerU Cloud for high-quality PDF (scanned docs, complex layouts)
pip install mineru-open-sdk
export MINERU_API_KEY="your-key"  # get from https://mineru.net

# Index documents
qmd collection add ~/notes --name notes
qmd collection add ~/papers --name papers --mask '**/*.{md,pdf,docx,pptx}'

# Verify
qmd status
qmd search "test query"  # instant, no model download

# Optional: enable semantic search (downloads ~2GB models on first run)
qmd embed
```

## MCP Configuration

**Claude Code** (`~/.claude/settings.json`):
```json
{ "mcpServers": { "qmd": { "command": "qmd", "args": ["mcp"] } } }
```

**Cursor** (`.cursor/mcp.json`) — stdio:
```json
{ "mcpServers": { "qmd": { "command": "qmd", "args": ["mcp"] } } }
```

**Cursor** (`.cursor/mcp.json`) — HTTP (recommended):
```json
{ "mcpServers": { "qmd": { "url": "http://localhost:8181/mcp" } } }
```
Start daemon first: `qmd mcp --http --daemon`

## Skill Installation

```bash
qmd skill install              # install to current project
qmd skill install --global     # install globally
```
