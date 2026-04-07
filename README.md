<div align="center">

<h1 align="center">
  <img src="assets/logo.png" alt="logo" height="28" style="vertical-align: middle; margin-right: 8px;">
  MinerU Document Explorer
</h1>

<h4>Agent-native knowledge engine — search, deep-read, and build knowledge bases<br>from Markdown, PDF, DOCX, and PPTX.</h4>

<p>
  <a href="https://www.npmjs.com/package/mineru-document-explorer"><img src="https://img.shields.io/npm/v/mineru-document-explorer?style=flat-square&color=cb3837" alt="npm"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="license"/></a>
  <a href="https://github.com/opendatalab/MinerU-Document-Explorer/actions"><img src="https://img.shields.io/github/actions/workflow/status/opendatalab/MinerU-Document-Explorer/ci.yml?style=flat-square&label=CI" alt="CI"/></a>
  <a href="https://github.com/opendatalab/MinerU-Document-Explorer"><img src="https://img.shields.io/github/stars/opendatalab/MinerU-Document-Explorer?style=flat-square" alt="stars"/></a>
</p>

<p>
  <a href="README-zh.md">中文文档</a> ·
  <a href="docs/mcp.md">MCP Setup</a> ·
  <a href="docs/cli.md">CLI Reference</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

</div>

---

## 🤔 Why MinerU Document Explorer?

MinerU Document Explorer equips your agent with three tool suites — **Retrieve, Deep Read, and Ingest** — closing the full knowledge loop:

![Overview of MinerU Document Explorer](assets/overview_en.png)

- **🔍 Retrieve** — Cross-collection search: BM25, vector, and hybrid with LLM reranking and query expansion
- **📖 Deep Read** — Navigate inside a single document without loading the whole file: table of contents, section reading, inline search, and element extraction
- **📝 Ingest** — Build and maintain a LLM wiki from raw documents, following the [Karpathy LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern

Developed by the [MinerU](https://github.com/opendatalab/MinerU) team, building on [QMD](https://github.com/tobi/qmd) and [Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

## 🚀 Quick Start

> Agent-Assisted Setup: If you're using an AI agent (Claude Code, Cursor, etc.), simply ask it to help you deploy MinerU Document Explorer and install skills — the agent can handle the entire setup process for you, including MCP configuration.

```
Follow the https://github.com/opendatalab/MinerU-Document-Explorer/blob/main/docs/quickstart.md to install MinerU Document Explorer and walk the user through configuration.
```

## 📖 Document Deep Reading

Navigate and search within a single document without reading the whole file:

```sh
# View document structure
qmd doc-toc papers/attention-is-all-you-need.pdf

# Read specific sections by address
qmd doc-read papers/attention-is-all-you-need.pdf "line:45-120"

# Search within one document
qmd doc-grep papers/attention-is-all-you-need.pdf "self-attention"
```

## 🔌 MCP Server — 15 Tools for AI Agents

Integrate with AI agents via [Model Context Protocol](https://modelcontextprotocol.io).

> **MCP Server vs CLI**: The MCP server runs as a **persistent process** — LLM models (embeddings, reranker, query expansion) are loaded once and stay in memory across requests. CLI commands like `qmd query` must reload all models on every invocation, adding ~5–15 s of startup overhead each time. **For agent workflows, always prefer the MCP server.**

Two transport modes:

| Mode | Command | Best for |
|:-----|:--------|:---------|
| **stdio** | `qmd mcp` | Claude Desktop, Claude Code — client spawns and manages the process |
| **HTTP daemon** | `qmd mcp --http --daemon` | Cursor, Windsurf, VS Code, multi-client setups — one shared persistent server |

```sh
# Start the HTTP daemon (recommended — models stay loaded across all requests)
qmd mcp --http --daemon             # default port 8181
qmd mcp --http --daemon --port 8080 # custom port

# Verify server is running
curl http://localhost:8181/health

# Stop the daemon
qmd mcp stop
```

### Client Configuration

<details>
<summary><b>Cursor</b> — add to <code>.cursor/mcp.json</code> (project) or <code>~/.cursor/mcp.json</code> (global)</summary>

**Option A — stdio** (Cursor manages the process lifecycle):

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

**Option B — HTTP** (run `qmd mcp --http --daemon` first; models stay loaded, faster responses):

```json
{
  "mcpServers": {
    "qmd": {
      "url": "http://localhost:8181/mcp"
    }
  }
}
```

</details>

<details>
<summary><b>Claude Desktop</b> — add to <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></summary>

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

</details>

<details>
<summary><b>Claude Code</b> — add to <code>~/.claude/settings.json</code> or run <code>claude mcp add qmd -- qmd mcp</code></summary>

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

</details>

<details>
<summary><b>Windsurf / VS Code / Other MCP Clients</b></summary>

For **stdio** transport, use `"command": "qmd"`, `"args": ["mcp"]` in your client's MCP configuration.

For **HTTP** transport, start `qmd mcp --http --daemon` and point your client to `http://localhost:8181/mcp`.

</details>

See [MCP setup guide](docs/mcp.md) for all 15 tools and HTTP transport details.

### Agent Skills

MinerU Document Explorer ships with a built-in [Agent Skill](skills/mineru-document-explorer/SKILL.md) that teaches AI agents how to use the full tool suite effectively — decision trees, usage patterns, and best practices for all 15 MCP tools.

```sh
# Install the skill (works with both npm and source installs)
qmd skill install              # local project (.agents/skills/)
qmd skill install --global     # global (~/.agents/skills/)

# Or from source repo
claude skill add ./skills/mineru-document-explorer/SKILL.md
```

## 📊 How It Compares

| | MinerU Doc Explorer | LlamaIndex | Obsidian | NotebookLM |
|:---|:---:|:---:|:---:|:---:|
| **Runs 100% locally** | ✅ | ⚠️ LLM APIs | ✅ | ❌ Cloud |
| **Agent integration (MCP)** | **15 tools** | Plugin | ❌ | ❌ |
| **Deep reading within docs** | ✅ | ❌ | ❌ | ✅ |
| **Wiki knowledge compilation** | ✅ | ❌ | Manual | ❌ |
| **Formats** | MD, PDF, DOCX, PPTX | Many | MD | PDF, URL |
| **Search pipeline** | BM25 + vec + rerank | Configurable | Basic | Proprietary |
| **Zero-config search** | ✅ `qmd search` | ❌ | Plugin | N/A |
| **Open source** | MIT | MIT | Partial | ❌ |

## ⚙️ Requirements

| Requirement | Notes |
|-------------|-------|
| **Node.js** >= 22 or **Bun** | Runtime |
| **Python** >=3.10 _(optional)_ | For PDF (`pymupdf`), DOCX (`python-docx`), PPTX (`python-pptx`) |
| **macOS** | `brew install sqlite` for extension support |

### 🤖 LLM Models (auto-downloaded on first use)

| Model | Purpose | Size |
|:------|:--------|:-----|
| embeddinggemma-300M | Vector embeddings | ~300 MB |
| qwen3-reranker-0.6b | Re-ranking | ~640 MB |
| qmd-query-expansion-1.7B | Query expansion | ~1.1 GB |

> Models are only needed for `qmd embed`, `qmd vsearch`, and `qmd query`. `qmd search` runs BM25 retrieval.

## 📚 Documentation

| | |
|:---|:---|
| 📖 [CLI Reference](docs/cli.md) | All commands, options, output formats |
| 🔌 [MCP Server](docs/mcp.md) | Setup, 15 tools, HTTP transport |
| 📦 [SDK / Library](docs/sdk.md) | TypeScript API, types, examples |
| 🏗️ [Architecture](docs/architecture.md) | Search pipeline, scoring, data schema, chunking |
| 🤝 [Contributing](CONTRIBUTING.md) | Development setup, code style, how to contribute |

## ❤️ Acknowledgments

MinerU Document Explorer builds upon these foundational projects:

- **[QMD](https://github.com/tobi/qmd)** by [Tobi Lutke](https://github.com/tobi) — An on-device search engine and CLI toolkit for markdown documents
- **[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** by [Andrej Karpathy](https://github.com/karpathy) — the conceptual pattern for LLM-maintained knowledge bases
- **[MinerU](https://github.com/opendatalab/MinerU)** by [OpenDataLab](https://github.com/opendatalab) — high-quality document parsing and extraction

---

## 📝 Changelog

### v2 — 2026-04-07 (Current)

Rebuilt from an OpenClaw agent skill into a full agent-native knowledge engine: npm package (`npm install -g mineru-document-explorer`), `qmd` CLI, MCP server with 15 tools across three groups (Retrieval / Deep Reading / Knowledge Ingestion), multi-format support (MD, PDF, DOCX, PPTX), hybrid search (BM25 + vector + LLM reranking), and LLM Wiki knowledge base pattern.

### v1 — 2026-03-30 (Previous)

OpenClaw-native agent skill (`doc-search` CLI). Four capabilities: Logic Retrieval, Semantic Retrieval, Keyword Retrieval, Evidence Extraction. See the [v1 repository](https://github.com/opendatalab/MinerU-Document-Explorer/tree/v1).