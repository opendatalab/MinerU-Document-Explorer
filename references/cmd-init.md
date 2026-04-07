# init — Initialize a PDF

```bash
doc-search init --doc_path "<path_or_url>" [--lazy_ocr] [--no_mineru] [--force_pageindex]
```

| Flag | Description |
|------|-------------|
| `--doc_path` | Local path or URL to the PDF (required) |
| `--lazy_ocr` | Defer OCR (recommended for >40 pages; not needed for smaller docs) |
| `--no_mineru` | Skip MinerU OCR, use native PDF text (not recommended — lower accuracy) |
| `--force_pageindex` | Force LLM outline tree construction |

## Notes

- **Init only once** — results are cached locally; re-init on the same file returns immediately
- **>40 pages must use `--lazy_ocr`**, otherwise init will time out
- **MinerU OCR is used by default** — far more accurate than native PDF text, especially for Chinese or scanned docs
- Returns `doc_id` required by all subsequent commands
- `capabilities` indicates which features are available

## Response structure

```typescript
interface InitResponse {
  status: "ok";
  doc_id: string;           // identifier for all subsequent commands
  doc_name: string;
  num_pages: number;
  init_status: "ready" | "initializing";
  capabilities: {
    is_scanned_doc: boolean;
    has_native_outline: boolean;  // native PDF bookmarks
    has_pageindex: boolean;       // LLM outline tree (requires PageIndex config)
    has_embedding: boolean;
    has_mineru: boolean;          // MinerU OCR ready
  };
  warnings: string[];
}
```

## Examples

```bash
# Small document
doc-search init --doc_path "paper.pdf"

# Large document / remote URL
doc-search init --doc_path "https://arxiv.org/pdf/2409.18839" --lazy_ocr
```
