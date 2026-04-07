# MinerU Document Explorer — MCP Server Setup

## Install

```bash
# Option A: npm (recommended)
npm install -g mineru-document-explorer

# Option B: from source
git clone https://github.com/opendatalab/MinerU-Document-Explorer.git
cd MinerU-Document-Explorer && bun install && bun link
```

```bash
# Index your documents
qmd collection add ~/path/to/docs --name myknowledge
qmd collection add ~/papers --name papers --mask '**/*.{md,pdf,docx,pptx}'

# Optional: enable semantic search
qmd embed
```

**Python dependencies** (only for PDF/DOCX/PPTX):
```bash
pip install pymupdf python-docx python-pptx
```

## Configure MCP Client

**Claude Code** (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "qmd": { "command": "qmd", "args": ["mcp"] }
  }
}
```

**Cursor** (`.cursor/mcp.json`) — stdio:
```json
{
  "mcpServers": {
    "qmd": { "command": "qmd", "args": ["mcp"] }
  }
}
```

**Cursor** (`.cursor/mcp.json`) — HTTP (recommended, models stay loaded):
```json
{
  "mcpServers": {
    "qmd": { "url": "http://localhost:8181/mcp" }
  }
}
```
Start the HTTP daemon first: `qmd mcp --http --daemon`

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "qmd": { "command": "qmd", "args": ["mcp"] }
  }
}
```

## HTTP Mode

```bash
qmd mcp --http              # Port 8181, foreground
qmd mcp --http --daemon     # Background daemon
qmd mcp --http --daemon --port 8080  # Custom port
qmd mcp stop                # Stop daemon
curl http://localhost:8181/health  # Verify
```

Models stay loaded in VRAM across all requests — much faster than CLI.

## Tools Overview

### Retrieval Tools

| Tool | Parameters | Description |
|------|------------|-------------|
| `query` | `query` or `searches[]`, `intent?`, `collections?`, `limit?`, `minScore?` | Hybrid search (BM25 + vector + reranking) |
| `get` | `file`, `fromLine?`, `maxLines?`, `lineNumbers?` | Retrieve a single document by path or docid |
| `multi_get` | `pattern`, `maxLines?`, `maxBytes?`, `lineNumbers?` | Batch retrieve by glob, comma-separated list, or comma-separated globs |
| `status` | _(none)_ | Index health, collections, document counts |

### Document Reading Tools

| Tool | Parameters | Description |
|------|------------|-------------|
| `doc_toc` | `file` | Table of contents (headings/bookmarks/slides) |
| `doc_read` | `file`, `addresses[]`, `max_tokens?` | Read content at specific addresses |
| `doc_grep` | `file`, `pattern`, `flags?` | Regex/keyword search within one document |
| `doc_query` | `file`, `query`, `top_k?` | Semantic search within one document |
| `doc_elements` | `file`, `addresses?`, `query?`, `element_types?` | Extract tables, figures, equations |
| `doc_links` | `file`, `direction?` (`both`), `link_type?` (`all`) | Forward/backward link graph |

### Knowledge Ingestion Tools

| Tool | Parameters | Description |
|------|------------|-------------|
| `wiki_ingest` | `source`, `wiki_collection?`, `force?` | Prepare source for wiki processing |
| `doc_write` | `collection`, `path`, `content`, `title?`, `source?` | Write a markdown document |
| `wiki_lint` | `collection?`, `stale_days?` | Health-check: orphans, broken links, stale pages |
| `wiki_log` | `since?`, `operation?`, `limit?` (20), `format?` (`markdown`) | Activity timeline |
| `wiki_index` | `collection`, `write?` | Generate/update wiki index page |

## Troubleshooting

- **Not starting**: `which qmd`, try `qmd mcp` manually, check for port conflicts
- **No results**: `qmd collection list` to verify indexed, `qmd status` for counts
- **Slow first search**: Normal, models loading (~3GB). Use MCP server to avoid reloading.
- **PDF not working**: Install `pip install pymupdf`
- **DOCX/PPTX not working**: Install `pip install python-docx python-pptx`
