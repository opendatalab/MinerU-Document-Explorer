# pages — Read pages

```bash
doc-search pages --doc_id "<id>" --page_idxs "<p>" [--no_image] [--return_text]
```

| Flag | Description |
|------|-------------|
| `--page_idxs` | `"0,1,2"`, `"0-5"`, `"-1"` (last page), `""` (all pages) |
| `--no_image` | Omit image paths from output |
| `--return_text` | Include OCR text (**required to get any text**) |

## Response structure

```typescript
interface Page {
  page_idx: number;         // 0-indexed
  image_path?: string;      // local image path (present unless --no_image)
  ocr_text?: string;        // OCR text (requires --return_text)
  num_tokens?: number;      // token count (requires --return_text)
}

interface PagesResponse {
  status: "ok";
  pages: Page[];
  warnings: string[];
}
```

## Flag combinations

| Flags | Returns |
|-------|---------|
| *(none)* | page_idx + image_path |
| `--return_text` | page_idx + image_path + ocr_text + num_tokens |
| `--no_image --return_text` | page_idx + ocr_text (text-only, fastest) |

> `--no_image` is meaningless on its own — always pair with `--return_text`

## Examples

```bash
# Text-only, first 3 pages
doc-search pages --doc_id "$DOC_ID" --page_idxs "0,1,2" --no_image --return_text

# View page image
doc-search pages --doc_id "$DOC_ID" --page_idxs "5"
```
