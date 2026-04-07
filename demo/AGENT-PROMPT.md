# RAG Research Survey — Agent Prompt

You have access to a MinerU Document Explorer index (named `demo`) containing ~10 recent
arXiv papers on Retrieval-Augmented Generation (RAG). The MCP server must be
started with `--index demo` (e.g. `bun src/cli/qmd.ts --index demo mcp`).

The index has two collections:

- `sources` — raw PDF papers (immutable, read-only)
- `wiki` — wiki collection (may already contain pages from prior runs; extend and improve them)

Your task: build a structured wiki from these papers, then write a survey
document synthesizing the latest RAG research trends. If the wiki already
contains pages, review them first and update or extend as needed.

## Available MCP Tools

| Tool | Purpose |
|------|---------|
| `status` | Check index health, collections, document counts |
| `query` | Search across all documents (keyword + semantic + reranking) |
| `get` | Retrieve full content of a document by path or docid |
| `multi_get` | Retrieve multiple documents by glob or comma-separated list |
| `wiki_ingest` | Prepare a source paper for wiki processing (returns content + related pages + suggestions) |
| `doc_write` | Write a wiki page to the `wiki` collection |
| `doc_toc` | Get document table of contents (headings, bookmarks) |
| `doc_read` | Read specific sections of a document by address |
| `doc_grep` | Regex search within a single document |
| `doc_query` | Semantic search within a single document |
| `doc_elements` | Extract tables, figures, equations from a document |
| `doc_links` | Get forward/backward links for a wiki page |
| `wiki_lint` | Health-check: orphans, broken links, missing pages |
| `wiki_index` | Generate wiki index page |
| `wiki_log` | View wiki activity timeline |

## Phase 1: Reconnaissance

1. Call `status` to see the index state — how many papers are indexed, which
   collections exist.
2. Call `query` with a broad search like `"RAG retrieval augmented generation"`
   to see what's available and how results look.
3. Pick 5-10 papers that represent different RAG sub-areas. For each, call
   `doc_toc` to understand their structure.

## Phase 2: Build the Wiki (Ingest → Read → Write)

For each paper, follow this cycle:

```
wiki_ingest(source)  →  read suggestions  →  doc_read(key sections)  →  doc_write(wiki page)
```

### Step 2a: Ingest
Call `wiki_ingest` with the paper's path. This returns:
- The paper's content (possibly truncated for large PDFs)
- Existing related wiki pages
- Suggested wiki page paths and actions

### Step 2b: Deep Read
For large or information-dense papers, use targeted reading:
- `doc_toc` to see the structure
- `doc_read` to read specific sections (abstract, methods, results)
- `doc_grep` to find mentions of specific techniques
- `doc_query` to semantically search within the paper

### Step 2c: Write Wiki Pages
Use `doc_write` to create wiki pages. Required and recommended parameters:
- `collection`: "wiki" (required)
- `path`: relative path within the collection, e.g. `"papers/my-paper.md"` (required)
- `content`: structured Markdown with `[[wikilinks]]` to related concepts (required)
- `title`: human-readable title for the page (optional but recommended)
- `source`: the source paper's path (optional, records provenance for staleness tracking)

#### Recommended wiki structure

Paths passed to `doc_write` are relative to the collection root (`demo/wiki/`):

```
papers/
├── <paper-slug>.md             # Per-paper summary
└── ...
concepts/
├── rag-fundamentals.md
├── dense-retrieval.md
├── query-expansion.md
├── multi-hop-qa.md
├── reranking.md
├── retrieval-strategies.md
├── agentic-rag.md
├── graph-rag.md
├── evaluation-benchmarks.md
└── ...
survey.md                       # Final survey document
index.md                        # Auto-generated via wiki_index
```

#### Wiki page template (per paper):

```markdown
# <Paper Title>

**Authors:** ...
**arXiv:** ...
**Year:** 2026

## Key Contributions
- ...

## Method
...

## Results
...

## Connections
- Related to [[concepts/dense-retrieval]]
- Extends [[concepts/query-expansion]]
- Evaluated on [[concepts/evaluation-benchmarks]]
```

### Step 2d: Cross-reference
As you process more papers, use `query` to find connections:
- Search for shared techniques, datasets, or baselines
- Update existing wiki pages with new links
- Create concept pages that synthesize multiple papers

## Phase 3: Analysis & Survey

After building the wiki (paper pages + concept pages for all indexed papers):

1. Run `wiki_lint` to check for orphan pages and broken links. Fix any issues.
2. Run `wiki_index` with `collection: "wiki"` and `write: true` to generate the index page.

### Write the survey

Use `query` to research each survey section, reading deeply into the top results.

Create the survey at `survey.md` (path relative to wiki collection) via `doc_write`. Recommended structure:

```markdown
# RAG Research Survey: 2026 Frontiers

## 1. Introduction
Brief overview of the RAG landscape.

## 2. Retrieval Methods
### 2.1 Dense Retrieval
### 2.2 Sparse Retrieval
### 2.3 Hybrid Approaches

## 3. Generation & Augmentation
### 3.1 Context Integration
### 3.2 Faithfulness & Grounding

## 4. Advanced Architectures
### 4.1 Multi-hop RAG
### 4.2 Agentic RAG
### 4.3 Graph-based RAG

## 5. Evaluation & Benchmarks

## 6. Applications
### 6.1 Code Generation
### 6.2 Scientific QA
### 6.3 Enterprise Search

## 7. Open Challenges & Future Directions

## References
[[papers/paper-1]], [[papers/paper-2]], ...
```

For each section:
1. `query` for relevant papers (e.g., `query("dense retrieval RAG 2026")`)
2. `doc_read` the top results' methods and results sections
3. Synthesize findings into the survey section with proper `[[wikilinks]]`

## Phase 4: Quality Check

1. `wiki_lint` — fix any remaining issues
2. `wiki_log` — review the activity timeline
3. `wiki_index` with `write: true` — update the index
4. Read the final `survey.md` and verify all links resolve

## Tips

- **Start broad, go deep**: Don't read every paper fully. Use `query` to find
  the most relevant papers for each topic, then `doc_read` targeted sections.
- **Build incrementally**: Write wiki pages as you go. Each page makes
  subsequent searches more useful (wiki pages are searchable too).
- **Use wikilinks liberally**: `[[concepts/dense-retrieval]]` links are tracked
  by `wiki_lint` and `doc_links`. They create a navigable knowledge graph.
- **Record provenance**: Always pass `source` to `doc_write` so staleness
  tracking works.
- **Batch when possible**: Use `multi_get` to read several short papers at once.
