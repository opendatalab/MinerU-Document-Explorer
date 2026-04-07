# MCP Server

MinerU Document Explorer exposes an MCP (Model Context Protocol) server with **15 tools in three groups** for AI agent integration.

## Setup

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
```

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
```

### Cursor / Other MCP Clients

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
```

## Tools

### Retrieval — find and fetch documents

| Tool | Description |
|------|-------------|
| `query` | Hybrid search: plain query (auto-expanded) or typed sub-queries (`lex`/`vec`/`hyde`) |
| `get` | Retrieve a document by path or docid |
| `multi_get` | Batch retrieve by glob pattern, comma-separated list, or comma-separated globs |
| `status` | Index health and collection info |

### Deep Reading — navigate and search within a single document

| Tool | Description |
|------|-------------|
| `doc_toc` | Table of contents — headings (MD), bookmarks (PDF), styles (DOCX), slides (PPTX) |
| `doc_read` | Read content at specific addresses from `doc_toc` / `doc_grep` / `doc_query` |
| `doc_grep` | Regex/keyword search within one document |
| `doc_query` | Semantic search within one document |
| `doc_elements` | Extract tables, figures, equations |
| `doc_links` | Forward/backward link graph |

### Knowledge Ingestion — build and maintain a wiki

| Tool | Description |
|------|-------------|
| `wiki_ingest` | Prepare source document for wiki processing |
| `doc_write` | Write markdown documents (auto-logged for wiki collections) |
| `wiki_lint` | Health-check: orphans, broken links, stale pages |
| `wiki_log` | Activity timeline |
| `wiki_index` | Generate/update wiki index page |

## HTTP Transport

By default the MCP server uses stdio (launched as a subprocess by each client). For a shared, long-lived server that avoids repeated model loading:

```sh
# Foreground (Ctrl-C to stop)
qmd mcp --http                    # localhost:8181
qmd mcp --http --port 8080        # custom port

# Background daemon
qmd mcp --http --daemon           # start, writes PID to ~/.cache/qmd/mcp.pid
qmd mcp stop                      # stop via PID file
qmd status                        # shows "MCP: running (PID ...)" when active
```

Endpoints:
- `POST /mcp` — MCP Streamable HTTP (JSON responses, session-based)
- `POST /query` or `POST /search` — REST search API (non-MCP, JSON in/out)
- `GET /health` — liveness check with uptime

LLM models stay loaded in VRAM across requests. Embedding/reranking contexts are disposed after 5 min idle and transparently recreated on the next request.

Point any MCP client at `http://localhost:8181/mcp` to connect.
