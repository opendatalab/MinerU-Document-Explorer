#!/usr/bin/env bash
#
# MinerU Document Explorer Demo — Setup Only
#
# This script handles the TWO things that require external tools:
# 1. Fetch papers from arXiv (external API, not an MCP capability)
# 2. Index PDFs into QMD (creates the searchable index)
#
# PDF extraction uses MinerU cloud API when MINERU_API_KEY is set or
# configured in ~/.config/qmd/doc-reading.json. Falls back to PyMuPDF.
#
# After setup, an LLM agent takes over via MCP to:
#   - wiki_ingest each paper
#   - doc_write wiki pages
#   - doc_toc + doc_read for deep reading
#   - Generate the survey via doc_write
#
# Usage:
#   bash demo/setup.sh [--max 10] [--skip-download] [--skip-embed]
#   MINERU_API_KEY=... bash demo/setup.sh   # use MinerU cloud

set -euo pipefail
cd "$(dirname "$0")/.."

MAX_PAPERS=10
SKIP_DOWNLOAD=false
SKIP_EMBED=false
INDEX_NAME="demo"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max) MAX_PAPERS="$2"; shift 2 ;;
    --skip-download) SKIP_DOWNLOAD=true; shift ;;
    --skip-embed) SKIP_EMBED=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   MinerU Document Explorer Demo: Setup (data acquisition)    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── Pre-flight checks ────────────────────────────────────────────
if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 not found. Install Python 3 first." >&2
  exit 1
fi

PY_MINOR="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
python3 - <<'PY' || {
import sys
major, minor = sys.version_info[:2]
if (major, minor) < (3, 10):
    raise SystemExit(1)
PY
  echo "ERROR: Python >= 3.10 is required (found ${PY_MINOR})." >&2
  exit 1
}

QMD_CMD=()
if command -v qmd &>/dev/null; then
  QMD_CMD=(qmd)
elif command -v bun &>/dev/null; then
  QMD_CMD=(bun src/cli/qmd.ts)
else
  echo "ERROR: neither qmd nor bun found." >&2
  echo "  Install qmd (recommended): npm install -g mineru-document-explorer" >&2
  echo "  Or install Bun: https://bun.sh" >&2
  exit 1
fi

if ! python3 -c "import feedparser" 2>/dev/null; then
  echo "ERROR: feedparser not installed. Run: pip install feedparser" >&2
  exit 1
fi

# ── Step 1: Fetch papers ──────────────────────────────────────────
echo "[1/3] Fetching RAG papers from arXiv (2026+)..."

if [ "$SKIP_DOWNLOAD" = true ]; then
  python3 demo/fetch_arxiv.py --max "$MAX_PAPERS" --output demo/papers --metadata-only
  echo "  Note: --skip-download fetches metadata only. PDFs must exist from a prior run."
else
  python3 demo/fetch_arxiv.py --max "$MAX_PAPERS" --output demo/papers
fi

# ── Step 2: Index into QMD ────────────────────────────────────────
echo ""

# Detect PDF extraction provider
if [ -n "${MINERU_API_KEY:-}" ]; then
  echo "[2/3] Indexing papers with MinerU cloud (high-quality VLM extraction)..."
elif python3 -c "from mineru import MinerU" 2>/dev/null && grep -q "mineru" ~/.config/qmd/doc-reading.json 2>/dev/null; then
  echo "[2/3] Indexing papers with MinerU cloud (configured in doc-reading.json)..."
else
  echo "[2/3] Indexing papers with PyMuPDF (fast local extraction)..."
  echo "  Tip: Set MINERU_API_KEY for higher quality extraction"
fi

"${QMD_CMD[@]}" --index "$INDEX_NAME" collection remove sources 2>/dev/null || true
"${QMD_CMD[@]}" --index "$INDEX_NAME" collection remove wiki 2>/dev/null || true

# Index source PDFs (PyMuPDF extracts text automatically)
"${QMD_CMD[@]}" --index "$INDEX_NAME" collection add demo/papers \
  --name sources --mask '**/*.pdf'

# Create empty wiki collection for agent to populate
mkdir -p demo/wiki
"${QMD_CMD[@]}" --index "$INDEX_NAME" collection add demo/wiki \
  --name wiki --type wiki

# Add context
"${QMD_CMD[@]}" --index "$INDEX_NAME" context add qmd://sources \
  "arXiv RAG research papers (PDF, 2026+)"
"${QMD_CMD[@]}" --index "$INDEX_NAME" context add qmd://wiki \
  "Wiki knowledge base: LLM-compiled summaries and analysis of RAG research"

# ── Step 3: Embeddings (optional) ─────────────────────────────────
echo ""
if [ "$SKIP_EMBED" = true ]; then
  echo "[3/3] Skipping embeddings (--skip-embed). BM25 search available."
else
  echo "[3/3] Generating vector embeddings (may take several minutes)..."
  "${QMD_CMD[@]}" --index "$INDEX_NAME" embed || {
    echo "  Embedding failed. BM25 search still available."
  }
fi

# ── Done ──────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                    Setup Complete!                           ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "The index is ready. Now let an LLM agent do the rest:"
echo ""
echo "  # Verify collections in the demo index"
echo "  ${QMD_CMD[*]} --index $INDEX_NAME status"
echo ""
echo "  # Start MCP server for agent access"
echo "  ${QMD_CMD[*]} --index $INDEX_NAME mcp"
echo ""
echo "  # Or HTTP mode (shared server, models stay loaded)"
echo "  ${QMD_CMD[*]} --index $INDEX_NAME mcp --http"
echo ""
echo "Then point your agent at the MCP server and give it the prompt"
echo "from demo/AGENT-PROMPT.md to build the wiki and survey."
echo ""
echo "Cleanup:"
echo "  rm -f ~/.cache/qmd/$INDEX_NAME.sqlite"
echo "  rm -rf demo/papers demo/wiki"
