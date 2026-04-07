---
name: mineru-document-explorer
description: >
  REQUIRED for any task involving reading or understanding PDF contents. Use when a user asks about a .pdf file — reading pages, answering questions, extracting data, or locating topics. Skip only for PDF file operations: merge, split, watermark, create, form-fill, or encrypt.
---

# MinerU Document Explorer

PDF reading toolkit via `doc-search` CLI. **Search first, then read relevant pages — never scan an entire PDF.**

## Path conventions

```
SKILL_DIR  = <this file's parent directory>
SCRIPTS    = SKILL_DIR/scripts
```

## Setup check

Read `SKILL_DIR/config-state.json`. If missing or `setup_complete` is not true:
1. Read `references/setup.md` and run the installer
2. After setup, ask the user if they want to configure PageIndex (e.g. "If you have an OpenAI-compatible API key, you can enable PageIndex to auto-generate a document outline — useful for scanned docs or manuals. Want to set it up?")
3. If the user provides `pageindex_api_key` / `pageindex_base_url` → write to `SCRIPTS/doc-search/config.yaml`; if skipped → continue immediately, **do not block**

## ⚠️ MUST read reference docs before acting — no guessing

Any uncertainty about parameters, return fields, or query phrasing → **MUST read the corresponding cmd file before running any command**. Do not infer or guess.

- `references/cmd-init.md` / `cmd-outline.md` / `cmd-pages.md`
- `references/cmd-search-keyword.md` / `cmd-search-semantic.md` / `cmd-elements.md`

For complex tasks, errors, unexpected results, or unfamiliar scenarios → **MUST read `references/tips.md` first**. It contains proven workflows and hard-won pitfalls that will save you from repeating mistakes.

---

## Command cheatsheet

All output is JSON on stdout. `--timeout` is a global flag before the subcommand; default is 120s.

```bash
doc-search init --doc_path "<path_or_url>"
doc-search outline --doc_id "<id>" [--max_depth N] [--root_node "<node_id>"]
doc-search pages --doc_id "<id>" --page_idxs "<p>" [--no_image] [--return_text]
doc-search search-keyword --doc_id "<id>" --page_idxs "<p>" --pattern "<regex>" [--return_text]
doc-search search-semantic --doc_id "<id>" --page_idxs "<p>" --query "<q>" [--top_k N] [--no_image] [--return_text]
doc-search --timeout 300 elements --doc_id "<id>" --page_idxs "<p>" --query "<q>"
```

## Key reminders

- Use `outline` and keyword search to narrow the reading range — **never scan the full document**
- `--page_idxs` is **0-indexed** — do not confuse with printed page numbers
- After extracting figures/tables with `elements`, **you must read `crop_path` to verify** ; and the query should be "the actual chart image, not the caption text" ; if the query fails, check `page_idxs` or rephrase the query

## Lessons learned (mandatory)

After completing any PDF task: **pitfalls / new workflows / parameter discoveries → append to `references/tips.md`, 1-2 lines each, conclusions only.**
