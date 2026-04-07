# elements — Evidence extraction

Use `elements` instead of `pages` when you need the original image/crop of a figure, table, formula, or heading.

```bash
doc-search --timeout 300 elements --doc_id "<id>" --page_idxs "<p>" --query "<question>"
```

| Flag | Description |
|------|-------------|
| `--page_idxs` | Target pages (required — locate with outline/search first) |
| `--query` | Extraction query (required) |

## Query writing guide

Focus on 1-2 target elements per call — the more specific the query, the higher the accuracy. Split multiple targets into parallel calls.

```bash
# ✅ Positional — describe location
--query "table to the left of step 3"
--query "bar chart at the top of the page"
--query "caption below Figure 2"

# ✅ Semantic — describe content
--query "table most relevant to model performance comparison"
--query "configuration table containing learning rate hyperparameters"

# ❌ Avoid extracting too many elements at once
--query "all questions on this page"     # too broad, unpredictable results
--query "extract questions 1 through 10" # split into individual calls
```

## Response structure

```typescript
interface Element {
  page_idx: number;
  bbox: [number, number, number, number];  // [x1,y1,x2,y2] normalized 0-1000
  content: string;                          // structured text (formula, table content, etc.)
  element_type: "evidence";
  crop_path?: string;                       // local path to cropped image — show directly to user
}

interface ElementsResponse {
  status: "ok";
  elements: Element[];
  warnings: string[];
}
```

## Examples

```bash
# Extract a table
doc-search --timeout 300 elements --doc_id "$DOC_ID" --page_idxs "9" --query "cooking temperature and time table"

# Search → extract chain
PAGES=$(doc-search search-semantic --doc_id "$DOC_ID" --page_idxs "" --query "performance comparison" --top_k 2 --no_image | \
  python3 -c "import json,sys; print(','.join(str(p['page_idx']) for p in json.load(sys.stdin)['pages']))")
doc-search --timeout 300 elements --doc_id "$DOC_ID" --page_idxs "$PAGES" --query "performance comparison table"
```

## Notes

- **`crop_path` is the most important output** — always read and verify it; the target is the actual chart image, not the caption text
- Never use PIL to manually compute bbox coordinates as a substitute for `crop_path` — accuracy gap is huge, results will be misaligned or skewed
- Extraction has some randomness — retry or rephrase the query if results are poor; also check `page_idxs`
- AgenticOCR multi-round extraction; far more accurate than `pages` ocr_text; requires network (server-side LLM)
