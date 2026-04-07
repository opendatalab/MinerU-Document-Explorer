# Installation & Configuration

## Install

1. Copy the entire `mineru-document-explorer/` directory into your OpenClaw skills folder
2. Run the setup script:

```bash
bash SCRIPTS/setup.sh
```

Requires Python ≥ 3.10. The script installs the `doc-search` CLI and all dependencies, then writes `config-state.json`.

**The default server is pre-configured — ready to use immediately after install.**

## Config file

`SCRIPTS/doc-search/config.yaml` (auto-generated from `config-example.yaml` on first install, pre-filled with defaults).

### Core service (works out of the box — no changes needed)

Points to the public MinerU service by default, providing OCR, semantic search, and element extraction:

```yaml
deployment_mode: "client"
server_url: "https://staging.mineru.org.cn/rag/"
client_api_key: ""   # no key needed for the public server
```

To use your own deployment, update `server_url` and `client_api_key`.

### PageIndex smart outline (optional)

PageIndex uses an LLM to build a hierarchical outline for documents that lack native bookmarks (scanned docs, manuals, etc.). **If not configured, it is simply skipped — all other features work normally.**

To enable, provide an OpenAI-compatible API:

```yaml
pageindex_model: "gpt-4.1-mini"       # or gpt-4o-2024-11-20
pageindex_api_key: "sk-..."
pageindex_base_url: "https://api.openai.com/v1"   # must include /v1
```

## Verify

```bash
doc-search init --doc_path "test.pdf" --lazy_ocr
# Should return {"status": "ok", "doc_id": "...", ...}
```
