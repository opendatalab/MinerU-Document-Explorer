# search-semantic — Semantic search

```bash
doc-search search-semantic --doc_id "<id>" --page_idxs "<p>" --query "<natural language>" [--top_k <N>] [--no_image] [--return_text]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--query` | — | Natural language query (required) |
| `--top_k` | 3 | Number of results to return |
| `--page_idxs` | "" | Search scope; empty = all pages. **Use outline to narrow range for large docs** |

## Response structure

```typescript
interface ScoredPage {
  page_idx: number;
  score: number;           // relevance score, descending order
  image_path?: string;     // present unless --no_image
  ocr_text?: string;       // requires --return_text
  num_tokens?: number;     // requires --return_text
}

interface SemanticResponse {
  status: "ok";
  pages: ScoredPage[];     // top_k results, sorted by score descending
  warnings: string[];
}
```

## Examples

```bash
# Scope with outline first, then search
doc-search search-semantic --doc_id "$DOC_ID" --page_idxs "5-20" --query "experimental results" --top_k 3 --no_image --return_text

# Search → read chain
PAGES=$(doc-search search-semantic --doc_id "$DOC_ID" --page_idxs "" --query "model architecture" --top_k 3 --no_image | \
  python3 -c "import json,sys; print(','.join(str(p['page_idx']) for p in json.load(sys.stdin)['pages']))")
doc-search pages --doc_id "$DOC_ID" --page_idxs "$PAGES" --no_image --return_text
```

## Notes

- Results sorted by `score` descending
- Requires network (server-side VL-Reranker); large page ranges take longer → scope with `outline`
- Best for conceptual queries, uncertain terminology, visual content, cross-language search
