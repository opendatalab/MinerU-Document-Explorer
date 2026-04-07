# outline — Browse document structure

```bash
doc-search outline --doc_id "<id>" [--max_depth N] [--root_node "<node_id>"]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--max_depth` | 2 | Tree display depth |
| `--root_node` | "" | Subtree root node ID (e.g. `"0005"`); empty = full tree |

## Response structure

```typescript
interface OutlineNode {
  title: string;
  node_id: string;       // use as --root_node value
  start_page: number;    // 0-indexed, pass directly to --page_idxs
  end_page: number;      // -1 means extends to end of document
  children?: OutlineNode[];
}

interface OutlineResponse {
  status: "ok";
  doc_id: string;
  doc_name: string;
  num_pages: number;
  outline: OutlineNode[];
  outline_source: "pageindex" | "native_pdf_bookmarks" | "none";
  warnings: string[];
}
```

## Examples

```bash
# Top-level structure only
doc-search outline --doc_id "$DOC_ID" --max_depth 1

# Expand a specific subtree
doc-search outline --doc_id "$DOC_ID" --root_node "0003"
```

## Notes

- Each node has `start_page`/`end_page` — use directly to scope `--page_idxs` for pages/search/elements
- If there are no native bookmarks, run init with `--force_pageindex` to build an LLM outline (requires PageIndex config)
- Available offline (cached at init time)
