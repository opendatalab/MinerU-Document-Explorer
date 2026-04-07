# MinerU Document Explorer Demo: Agent-Driven RAG Research Survey

This demo showcases MinerU Document Explorer as **Agent infrastructure**:
data ingestion, wiki building, deep reading, and survey writing are all driven
by an LLM Agent via MCP tools — the script only handles the minimal "non-intelligent"
work (fetching arXiv papers + building the index).

<p>
  <a href="README-zh.md">中文文档</a>
</p>

> **Not sure if this project is for you?** Walk through this demo and you'll see:
> MinerU Document Explorer isn't just another RAG framework — it's the infrastructure
> that gives AI Agents the ability to "read docs → search info → write knowledge."
> You provide the documents; the Agent does the rest.

---

## What Problem Does This Solve?

Pain points with traditional knowledge base approaches:

| Pain Point | Traditional Approach | MinerU Document Explorer |
|:-----------|:---------------------|:-------------------------|
| Agent can't read PDF/DOCX | Manual conversion or dump entire file into prompt | `doc_toc` → `doc_read` on-demand reading, token-efficient |
| Poor search quality | Keyword-only or vector-only | BM25 + vector + LLM reranking three-way fusion |
| Fragmented knowledge | Retrieved snippets lose context | Wiki knowledge compilation, Agent builds knowledge graph as it reads |
| Complex integration | Requires lots of glue code | 15 MCP tools, works out of the box |
| No traceability | Can't tell where answers came from | `source` field tracks provenance, `wiki_lint` detects staleness |

## Typical Use Cases

### Use Case 1: Research Literature Survey

```
You: "Survey the latest advances across these 10 RAG papers"
Agent:
  1. query("RAG retrieval augmented generation") finds key papers
  2. doc_toc → doc_read deep-reads each paper's abstract and methods
  3. doc_write creates wiki summary pages with [[wikilinks]] cross-references
  4. query searches specific topics across papers, doc_write writes the survey
  → Output: structured wiki knowledge base + complete research survey
```

### Use Case 2: Project Documentation Knowledge Base

```
You: "Index our design docs and explain the auth module architecture"
Agent:
  1. status checks indexed collections
  2. query("authentication module architecture") searches relevant docs
  3. doc_toc views document structure → doc_read reads architecture section
  → Output: architecture explanation with precise document citations
```

### Use Case 3: Course Study

```
You: "Organize core ML concepts from these textbooks"
Agent:
  1. doc_toc for each textbook to get the table of contents
  2. doc_grep("gradient descent|backpropagation") locates key sections
  3. doc_read deep-reads → doc_write creates concept wiki pages
  4. wiki_index generates knowledge graph index
  → Output: interlinked concept wiki + auto-generated index page
```

---

## Architecture: Script vs Agent Division of Labor

```
┌────────────────────────────────────────────────────────────────┐
│  setup.sh (script, no LLM)                                     │
│  ① arXiv API → download PDFs                                  │
│  ② qmd collection add → build full-text index                 │
│  ③ qmd embed (optional) → vector embeddings                   │
└──────────────────────────┬─────────────────────────────────────┘
                           │ MCP connection
                           ▼
┌────────────────────────────────────────────────────────────────┐
│  LLM Agent (guided by AGENT-PROMPT.md)                         │
│                                                                │
│  Phase 1: Reconnaissance                                       │
│    status → query("RAG") → doc_toc(top papers)                 │
│                                                                │
│  Phase 2: Wiki Building (loop)                                 │
│    wiki_ingest → doc_read(key sections) → doc_write(wiki page) │
│    ↻ repeat for each paper, building [[wikilinks]] graph       │
│                                                                │
│  Phase 3: Survey Writing                                       │
│    query(research dimensions) → doc_read(deep) → doc_write     │
│                                                                │
│  Phase 4: Quality Check                                        │
│    wiki_lint → wiki_index → fix broken links / orphan pages    │
└────────────────────────────────────────────────────────────────┘
```

**Key distinction**: There is no `build_wiki.py` or `generate_survey.py`. Wiki
page content, structure, categorization, and cross-references are all decided
autonomously by the Agent after understanding the paper content.

---

## Quick Start

### Prerequisites

| Dependency | Version | Installation |
|:-----------|:--------|:-------------|
| Python | >= 3.10 (**required**) | System default or `brew install python` |
| Bun | latest | `curl -fsSL https://bun.sh/install \| bash` |
| feedparser | latest | `pip install feedparser` |
| pymupdf | latest | `pip install pymupdf` |

```bash
# Verify dependencies
python3 --version          # needs >= 3.10
python3 -c "import pymupdf; import feedparser; print('OK')"
bun --version

# Install project dependencies
bun install
```

### Step 1: Run Setup (the only scripted step)

```bash
# With MinerU cloud high-quality extraction (recommended)
MINERU_API_KEY=your_key bash demo/setup.sh

# Or configure MinerU in ~/.config/qmd/doc-reading.json
bash demo/setup.sh

# PyMuPDF local extraction (fast, no API key needed)
bash demo/setup.sh --skip-embed

# Metadata only, no PDF download (fastest, for testing the flow)
bash demo/setup.sh --skip-download --skip-embed
```

> **MinerU vs PyMuPDF**: MinerU uses VLM models for OCR and layout analysis,
> correctly extracting tables, formulas, and figures into structured Markdown.
> PyMuPDF is plain text extraction — fast but weaker on scanned docs and complex layouts.

### Step 2: Start the MCP Server

```bash
# HTTP mode (recommended — shared server, models stay loaded in memory)
bun src/cli/qmd.ts --index demo mcp --http

# Or stdio mode (for embedding directly in MCP client config)
bun src/cli/qmd.ts --index demo mcp
```

### Step 3: Let the Agent Work

Send the contents of `demo/AGENT-PROMPT.md` as a system prompt or first instruction
to your LLM Agent (configure MCP connection to the server from the previous step).

The Agent will autonomously:
- Use `wiki_ingest` to analyze each paper
- Use `doc_toc` + `doc_read` to deep-read key sections
- Use `doc_write` to create wiki pages with `[[wikilinks]]` knowledge graph
- Use `query` for cross-paper retrieval
- Use `doc_write` to write the final `survey.md`
- Use `wiki_lint` + `wiki_index` for quality checks

---

## MCP Tools Reference

MinerU Document Explorer provides 15 tools to Agents via MCP, organized in three groups.

### 🔍 Retrieval Tools

Search across all indexed documents.

| Tool | Purpose | Example |
|------|---------|---------|
| `query` | Hybrid search (BM25 + vector + reranking) | `query({ query: "dense retrieval methods" })` |
| `get` | Retrieve full document by path or docid | `get({ path: "sources/2601.12345.pdf" })` |
| `multi_get` | Batch retrieve multiple documents | `multi_get({ pattern: "sources/*.pdf", max_lines: 50 })` |
| `status` | Check index health and collection info | `status()` |

**`query` advanced usage** — structured sub-query syntax for precise control:

```
lex:keyword search         # BM25 keyword search only
vec:semantic meaning        # Vector semantic search only
hyde:hypothetical answer    # HyDE (Hypothetical Document Embedding)
expand:brief query          # LLM query expansion before search
```

### 📖 Deep Read Tools

Navigate, search, and extract content within a single document — without loading the entire file.

| Tool | Purpose | Example |
|------|---------|---------|
| `doc_toc` | Get document table of contents (headings/bookmarks/slides) | `doc_toc({ file: "sources/paper.pdf" })` |
| `doc_read` | Read specific sections by address | `doc_read({ file: "sources/paper.pdf", addresses: ["page:3-5"] })` |
| `doc_grep` | Regex search within a document | `doc_grep({ file: "sources/paper.pdf", pattern: "attention" })` |
| `doc_query` | Semantic search within a document | `doc_query({ file: "sources/paper.pdf", query: "model architecture" })` |
| `doc_elements` | Extract tables, figures, equations | `doc_elements({ file: "sources/paper.pdf", types: ["table"] })` |

**`doc_read` address formats**:

```
page:3          # Page 3 (PDF)
page:3-5        # Pages 3–5
line:45-120     # Lines 45–120 (Markdown)
heading:Methods # Section with heading "Methods"
slide:5         # Slide 5 (PPTX)
```

**Typical deep-read flow**:
```
doc_toc(paper.pdf)              # View table of contents
  → "3. Methods" is at page:5
doc_read(paper.pdf, "page:5-8") # Deep-read methods section
doc_grep(paper.pdf, "ablation") # Search for ablation study
  → Found at page:12
doc_read(paper.pdf, "page:12")  # Deep-read results
```

### 📝 Knowledge Ingestion Tools

Build and maintain an LLM Wiki knowledge base.

| Tool | Purpose | Example |
|------|---------|---------|
| `doc_write` | Write wiki page (auto-indexed + logged) | `doc_write({ collection: "wiki", path: "concepts/rag.md", content: "..." })` |
| `doc_links` | View forward/backward links for a document | `doc_links({ file: "wiki/concepts/rag.md" })` |
| `wiki_ingest` | Analyze source document for wiki ingestion | `wiki_ingest({ source: "sources/paper.pdf", wiki: "wiki" })` |
| `wiki_lint` | Health check (orphans, broken links, stale pages) | `wiki_lint()` |
| `wiki_log` | View wiki activity timeline | `wiki_log()` |
| `wiki_index` | Generate wiki index page | `wiki_index({ collection: "wiki", write: true })` |

**`doc_write` parameters**:

| Parameter | Required | Description |
|-----------|:--------:|-------------|
| `collection` | ✅ | Target collection name (e.g. `"wiki"`) |
| `path` | ✅ | Relative path within collection (e.g. `"papers/my-paper.md"`) |
| `content` | ✅ | Markdown content, may include `[[wikilinks]]` |
| `title` | - | Page title |
| `source` | - | Source document path (for provenance and staleness tracking) |

**Recommended wiki structure**:

```
wiki/
├── papers/                  # Paper summary pages
│   ├── attention-is-all-you-need.md
│   └── rag-survey-2026.md
├── concepts/                # Concept pages (cross-paper synthesis)
│   ├── dense-retrieval.md
│   ├── query-expansion.md
│   └── evaluation-benchmarks.md
├── survey.md                # Final survey document
└── index.md                 # Auto-generated index
```

---

## End-to-End Workflow Example

Below is the typical Agent workflow in this demo. You can adapt this pattern to your own use case.

### Phase 1: Reconnaissance (~2 minutes)

```
Agent: status()
  → "2 collections: sources (10 docs), wiki (0 docs)"

Agent: query({ query: "RAG retrieval augmented generation survey" })
  → Returns ranked paper list with titles, snippet excerpts, relevance scores

Agent: doc_toc({ file: "sources/2601.00123.pdf" })
  → Returns paper structure: Abstract, Introduction, Related Work, Methods, ...
```

### Phase 2: Wiki Building (~1 minute per paper)

```
Agent: wiki_ingest({ source: "sources/2601.00123.pdf", wiki: "wiki" })
  → Returns paper content + existing related wiki pages + suggested write paths

Agent: doc_read({ file: "sources/2601.00123.pdf", addresses: ["page:1-3"] })
  → Deep-reads abstract and introduction

Agent: doc_write({
  collection: "wiki",
  path: "papers/adaptive-rag.md",
  content: "# Adaptive RAG\n\n**Key contribution**: ...\n\n## Connections\n- Related to [[concepts/dense-retrieval]]\n- Extends [[concepts/query-expansion]]",
  source: "sources/2601.00123.pdf"
})
  → Wiki page written and auto-indexed; subsequent queries can find it
```

### Phase 3: Survey Writing (~5 minutes)

```
Agent: query({ query: "dense retrieval methods comparison 2026" })
  → Searches all documents (including already-written wiki pages)

Agent: doc_read(top_result, "page:5-8")
  → Deep-reads key methods section

Agent: doc_write({
  collection: "wiki",
  path: "survey.md",
  content: "# RAG Research Survey: 2026 Frontiers\n\n## 1. Introduction\n..."
})
```

### Phase 4: Quality Check (~1 minute)

```
Agent: wiki_lint()
  → "2 broken links: [[concepts/graph-rag]], [[concepts/multi-hop-qa]]"
  → Agent automatically creates missing concept pages

Agent: wiki_index({ collection: "wiki", write: true })
  → Generates index.md listing all wiki pages and link relationships
```

---

## Customizing the Demo

### Swapping Data Sources

This demo uses arXiv RAG papers, but you can replace them with any documents:

```bash
# Index a local PDF folder
qmd collection add ~/my-papers --name sources --mask '**/*.pdf'

# Index Markdown notes
qmd collection add ~/notes --name notes --mask '**/*.md'

# Index mixed formats
qmd collection add ~/docs --name docs --mask '**/*.{md,pdf,docx,pptx}'

# Create a wiki collection
mkdir -p ~/my-wiki
qmd collection add ~/my-wiki --name wiki --type wiki
```

### Adjusting the Agent Prompt

Edit `demo/AGENT-PROMPT.md` to fit your scenario:
- Change collection names and paths
- Adjust the wiki page directory structure
- Modify the survey document outline
- Add or remove Agent phases

### MCP Client Configuration

**Cursor** (HTTP mode):

```json
{
  "mcpServers": {
    "qmd": {
      "url": "http://localhost:8181/mcp"
    }
  }
}
```

**Claude Code** (stdio mode):

```bash
claude mcp add qmd -- bun src/cli/qmd.ts --index demo mcp
```

**Claude Desktop** (stdio mode):

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["--index", "demo", "mcp"]
    }
  }
}
```

---

## Why This Design?

The traditional approach would be to write a `build_wiki.py` that uses templates
and heuristics to "transform" papers into wiki pages. But that misses the core
value of a RAG system:

1. **Understanding > Transformation**: The Agent decides wiki structure after reading the paper, not by filling fixed templates
2. **Incremental knowledge**: Each wiki page written gets indexed; subsequent searches automatically benefit
3. **Cross-referencing**: The Agent discovers connections between papers and links them with `[[wikilinks]]`, forming a knowledge graph
4. **Traceability**: `doc_write(source=...)` records wiki page provenance; `wiki_lint` detects staleness
5. **Reproducibility**: Same prompt + same index = deterministic Agent behavior

This is the [LLM Wiki Pattern](https://karpathy.ai/) in practice: indexing and
search are infrastructure; knowledge synthesis is the Agent's job.

---

## FAQ

### Q: Does it only work with Markdown documents?

No. MinerU Document Explorer supports Markdown, PDF, DOCX, and PPTX. PDF parsing
supports PyMuPDF (fast local extraction) and MinerU Cloud (high-quality VLM extraction).
The latter is significantly better for scanned documents, complex tables, and formulas.

### Q: Is MCP required? Can I use it via CLI only?

You can use it purely via CLI. Every MCP tool has a corresponding CLI command
(e.g. `qmd query`, `qmd doc-toc`, `qmd doc-read`). However, in MCP server mode
models stay loaded in memory, making responses 5–15 seconds faster — recommended
for Agent workflows.

### Q: Are vector embeddings required?

No. `qmd search` uses pure BM25 keyword search with zero setup. Vector embeddings
(`qmd embed`) are optional — when enabled, `qmd query` uses BM25 + vector + LLM
reranking three-way fusion for better results, but requires downloading ~2GB of models.

### Q: Which AI Agents are supported?

Any Agent that supports the MCP protocol, including Claude Desktop, Claude Code,
Cursor, Windsurf, VS Code + Copilot, and more. You can also integrate directly
into custom Agents via the SDK.

---

## Cleanup

```bash
# Delete the index database
rm -f ~/.cache/qmd/demo.sqlite

# Delete downloaded paper PDFs
rm -rf demo/papers

# To fully reset the wiki (deletes pre-committed example wiki pages)
# rm -rf demo/wiki
```

> **Note**: `demo/wiki/` contains pre-built example wiki pages (concepts and paper
> summaries) that can serve as a reference starting point for the Agent's wiki
> building. Make sure you don't need them before deleting.
