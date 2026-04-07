# ⏱️ First 5 Minutes

> **Agent-Assisted Setup**: If you're using an AI agent (Claude Code, Cursor, etc.), simply ask it to help you deploy MinerU Document Explorer and install skills — the agent can handle the entire setup process for you, including MCP configuration.

## Prerequisites

Python 3.10+ is **required** for document processing:

```sh
# Check Python version (needs >= 3.10)
python3 --version

# Install required Python packages
pip install pymupdf python-docx python-pptx

# Verify
python3 -c "import pymupdf; import docx; import pptx; print('OK')"
```

## Install

```sh
# Option A: npm (recommended)
npm install -g mineru-document-explorer

# Option B: from source
git clone https://github.com/opendatalab/MinerU-Document-Explorer.git
cd MinerU-Document-Explorer && bun install && bun link
```

### MinerU Cloud (optional — high-quality PDF)

For scanned documents or complex PDF layouts, MinerU Cloud provides
significantly better extraction quality:

```sh
pip install mineru-open-sdk
export MINERU_API_KEY="your-key-here"   # get from https://mineru.net
```

When `MINERU_API_KEY` is set, MinerU Cloud is automatically used as the
primary PDF provider with PyMuPDF as fallback.

For more advanced configuration (custom providers, OpenAI PageIndex, local
VLM models), create `~/.config/qmd/doc-reading.json`:

```json
{
  "docReading": {
    "providers": {
      "fullText": { "pdf": ["mineru_cloud", "pymupdf"] }
    },
    "credentials": {
      "mineru": { "api_key": "your-api-key" }
    }
  }
}
```

## Index & Search

```sh
# 1. Index a folder of documents
qmd collection add ~/notes --name notes
qmd collection add ~/papers --name papers --mask '**/*.{md,pdf,docx,pptx}'

# 2. Verify it works (instant, no model downloads)
qmd status                          # see what got indexed
qmd search "project timeline"       # BM25 keyword search

# 3. Add context to improve search relevance
qmd context add qmd://notes "Personal notes and ideas"
qmd context add qmd://papers "Academic papers and research"

# 4. (Optional) Enable semantic search — downloads ~2GB of models on first run
qmd embed                           # generate vector embeddings (~300MB model)
qmd query "quarterly planning"      # hybrid search with LLM reranking

# 5. Connect your AI agent via MCP server (see setup section below)
qmd mcp --http --daemon             # start persistent HTTP server on port 8181
```

> **Tip**: `qmd search` uses BM25 only — zero setup, instant results. Try it first before generating embeddings.
