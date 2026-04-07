# search-keyword — Regex keyword search

```bash
doc-search search-keyword --doc_id "<id>" --page_idxs "<p>" --pattern "<regex>" [--pattern "<regex2>"] [--return_image] [--return_text]
```

| Flag | Description |
|------|-------------|
| `--pattern` | Regex pattern (case-insensitive); can be specified multiple times (OR logic) |
| `--page_idxs` | Search scope; empty = all pages. **Use outline to narrow range for large docs** |
| `--return_image` | Include page images (off by default — opposite of `pages`) |
| `--return_text` | Include full OCR text |

## Response structure

```typescript
interface MatchedElement {
  page_idx: number;
  bbox: [number, number, number, number];  // [x1,y1,x2,y2] normalized 0-1000
  content: string;                          // matched text snippet
}

interface KeywordPage {
  page_idx: number;
  image_path?: string;          // requires --return_image
  ocr_text?: string;            // requires --return_text
  num_tokens?: number;          // requires --return_text
  matched_elements: MatchedElement[];
}

interface KeywordResponse {
  status: "ok";
  pages: KeywordPage[];         // only matched pages, in page order
  warnings: string[];
}
```

## Examples

```bash
# Use outline to scope the range first, then search
doc-search search-keyword --doc_id "$DOC_ID" --page_idxs "10-25" --pattern "Table\s+\d+"

# Full-document search (small docs or non-lazy_ocr only)
doc-search search-keyword --doc_id "$DOC_ID" --page_idxs "" --pattern "revenue" --pattern "profit"
```

## Notes

- **Does not return images by default** (opposite of `pages`) — add `--return_image` if needed
- Returns `pages[].matched_elements[]` with `content` and `bbox`
- Full-document search on lazy_ocr docs triggers OCR page-by-page — use `outline` to limit `page_idxs`
