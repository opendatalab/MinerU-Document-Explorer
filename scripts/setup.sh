#!/usr/bin/env bash
# MinerU Document Explorer — Setup script
# Installs the bundled doc-search package and verifies it works.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
STATE_FILE="$SKILL_DIR/config-state.json"
DOC_SEARCH_SRC="$SCRIPT_DIR/doc-search"

echo "=== MinerU Document Explorer Setup ==="

# -----------------------------------------------------------
# 1. Check bundled source exists
# -----------------------------------------------------------
if [ ! -f "$DOC_SEARCH_SRC/pyproject.toml" ]; then
    echo "❌ Bundled doc-search source not found at: $DOC_SEARCH_SRC"
    exit 1
fi

# -----------------------------------------------------------
# 2. Find Python >= 3.10
# -----------------------------------------------------------
PYTHON=""
for cmd in python3.12 python3.11 python3.10 python3; do
    if command -v "$cmd" &>/dev/null; then
        ver=$("$cmd" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null)
        major=$(echo "$ver" | cut -d. -f1)
        minor=$(echo "$ver" | cut -d. -f2)
        if [ "$major" -ge 3 ] && [ "$minor" -ge 10 ]; then
            PYTHON="$cmd"
            echo "✅ Found Python $ver: $(command -v "$cmd")"
            break
        fi
    fi
done

if [ -z "$PYTHON" ]; then
    echo "❌ Python >= 3.10 not found. Install with: brew install python@3.12"
    exit 1
fi

# -----------------------------------------------------------
# 3. Install doc-search from bundled source (editable)
# -----------------------------------------------------------
echo "📦 Installing doc-search from bundled source (with all dependencies)..."
"$PYTHON" -m pip install -e "$DOC_SEARCH_SRC[all]" --break-system-packages -q 2>&1 | tail -5

# -----------------------------------------------------------
# 4. Verify CLI is available
# -----------------------------------------------------------
if command -v doc-search &>/dev/null; then
    echo "✅ doc-search CLI available: $(which doc-search)"
else
    echo "⚠️  doc-search not on PATH after install."
    echo "   Try: $PYTHON -m pip install -e $DOC_SEARCH_SRC"
    exit 1
fi

# -----------------------------------------------------------
# 5. Setup config (copy template if not exists; never overwrite)
# -----------------------------------------------------------
CONFIG_FILE="$DOC_SEARCH_SRC/config.yaml"
if [ ! -f "$CONFIG_FILE" ]; then
    cp "$DOC_SEARCH_SRC/config-example.yaml" "$CONFIG_FILE"
    echo "📝 Created config.yaml — default server pre-configured, ready to use."
else
    echo "✅ Config exists: $CONFIG_FILE"
fi

# -----------------------------------------------------------
# 6. Write state file
# -----------------------------------------------------------
cat > "$STATE_FILE" <<EOF
{
  "setup_complete": true,
  "doc_search_src": "$DOC_SEARCH_SRC",
  "config_path": "$CONFIG_FILE",
  "python": "$(which "$PYTHON")",
  "installed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo ""
echo "=== Setup Complete ==="
echo "State:  $STATE_FILE"
echo "Config: $CONFIG_FILE"
echo ""
echo "Ready to use: doc-search init --doc_path your_file.pdf"
echo ""
echo "Optional: to enable PageIndex (smart TOC for documents without bookmarks),"
echo "  set pageindex_model, pageindex_api_key, pageindex_base_url in config.yaml."
