# Workflows & Lessons Learned

> One entry per lesson, 1-2 lines max. Append after completing complex PDF tasks.

## Common workflows

### Read a chapter
`outline` → get start_page/end_page → `pages --no_image --return_text`

### Find specific content
`search-semantic` → get page_idx → `pages` to read or `elements` to extract

### Extract raw figures/tables
Locate page with search → `elements --query "focused description"` → use content + crop_path

### Count figures
`search-keyword --pattern "Fig\."` → deduplicate figure numbers with Python

### Search → read chain
```bash
PAGES=$(doc-search search-semantic --doc_id "$DOC_ID" --page_idxs "" --query "..." --top_k 3 --no_image | \
  python3 -c "import json,sys; print(','.join(str(p['page_idx']) for p in json.load(sys.stdin)['pages']))")
doc-search pages --doc_id "$DOC_ID" --page_idxs "$PAGES" --no_image --return_text
```

## Complex workflows

### Grade assignments + error log
1. Init both the answer sheet and the solution (no outline needed)
2. Answer sheet: use `pages` to view images and extract handwritten answers (**no --return_text; never use elements** — handwriting causes hallucinations)
3. Solution: use `elements` to extract answers and verify via crop_path; supplement with keyword/pages for sparse content
4. Compare to identify errors → use `elements` to crop question images from answer sheet (check bbox carefully, retry if off), explain with solution
5. Render markdown → HTML → PDF (reportlab); don't preview, summarize for user

### Financial report / analysis deck
1. Init multiple documents, get outlines
2. Use `outline` + `search-keyword` + `search-semantic` to locate content
3. Use `elements` to extract table/chart crops (verify crop quality, retry if needed); respect slide boundaries when embedding
4. Write Python script first, then run to produce pptx; don't preview, ask user for feedback

## Pitfalls & error handling

- `page_idx` is 0-indexed — check printed page numbers in the footer to confirm
- >40 pages: init must use `--lazy_ocr`, otherwise it times out
- `pages` without `--return_text` returns no text
- `search-keyword` does not return images by default — add `--return_image` if needed
- `--no_image` alone is meaningless — always pair with `--return_text`
- Native Chinese PDF text may be garbled or missing — MinerU OCR is more reliable
- Full-document keyword search on lazy_ocr docs is slow — scope with `outline` + `page_idxs`
- Scanned docs with no native bookmarks is normal — use `--force_pageindex` to build one
- `pageindex_base_url` must include `/v1` — omitting it causes `'str' object has no attribute 'choices'`
- Handwritten content: only readable via page images — elements/ocr_text are unreliable for handwriting
- `elements` extraction has randomness — retry or rephrase query; check page_idxs if failing
- Never use PIL to manually crop from bbox coordinates instead of crop_path — accuracy gap is huge, results will be misaligned or skewed
- `"status": "error"` → read `"error"` field; also check `"warnings"` if present
- Unknown doc_id → run `init` first
- Read timed out → increase `--timeout` (300s recommended for elements)
- Invalid regex → fix pattern and retry
