#!/usr/bin/env python3
"""
Extract per-page text from a PDF using the MinerU VLM local model (mineru-vl-utils).

Workflow:
  1. Convert each PDF page to a PIL image using PyMuPDF (pymupdf)
  2. Run MinerUClient(backend="transformers").two_step_extract(image) per page
  3. Collect ContentBlock text into per-page output

Usage:
    extract_pdf_local.py <filepath> <model_path> [dpi]

Output (stdout, JSON):
    { "pages": [{"page_idx": N, "text": "...", "tokens": N}], "bookmarks": [] }

On error:
    { "error": "message" }

Requirements:
    pip install pymupdf
    pip install "mineru-vl-utils[transformers]"
    # Download model, e.g.:
    # huggingface-cli download OpenDataLab/MinerU2.5-2509-1.2B --local-dir ~/.cache/mineru/MinerU2.5-2509-1.2B
"""
import sys
import json
import os


def content_block_to_text(block) -> str:
    """Extract text from a MinerU ContentBlock object."""
    content = getattr(block, "content", None)
    if not content:
        return ""
    # content is text for text/title/equation, HTML for table, None for image
    return str(content).strip()


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: extract_pdf_local.py <filepath> <model_path> [dpi]"}))
        sys.exit(1)

    filepath = sys.argv[1]
    model_path = sys.argv[2]
    dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 150

    # ── Check dependencies ──────────────────────────────────────────────────
    try:
        import fitz  # PyMuPDF
    except ImportError:
        print(json.dumps({"error": "pymupdf not installed. Run: pip install pymupdf"}))
        sys.exit(1)

    try:
        from mineru_vl_utils import MinerUClient
    except ImportError:
        print(json.dumps({"error": "mineru-vl-utils not installed. Run: pip install 'mineru-vl-utils[transformers]'"}))
        sys.exit(1)

    try:
        from transformers import AutoModel, AutoProcessor
    except ImportError:
        print(json.dumps({"error": "transformers not installed. Run: pip install transformers"}))
        sys.exit(1)

    # ── Load model ───────────────────────────────────────────────────────────
    model_path = os.path.expanduser(model_path)
    if not os.path.isdir(model_path):
        print(json.dumps({"error": f"Model path not found: {model_path}. Download with: huggingface-cli download OpenDataLab/MinerU2.5-2509-1.2B --local-dir {model_path}"}))
        sys.exit(1)

    try:
        model = AutoModel.from_pretrained(model_path, trust_remote_code=True)
        processor = AutoProcessor.from_pretrained(model_path, trust_remote_code=True)
        client = MinerUClient(backend="transformers", model=model, processor=processor)
    except Exception as e:
        print(json.dumps({"error": f"Failed to load local model: {e}"}))
        sys.exit(1)

    # ── Open PDF ─────────────────────────────────────────────────────────────
    try:
        doc = fitz.open(filepath)
    except Exception as e:
        print(json.dumps({"error": f"Failed to open PDF: {e}"}))
        sys.exit(1)

    # ── Process pages ────────────────────────────────────────────────────────
    from PIL import Image
    import io

    pages = []
    mat = fitz.Matrix(dpi / 72, dpi / 72)

    for page_idx in range(len(doc)):
        try:
            page = doc[page_idx]
            pix = page.get_pixmap(matrix=mat)
            img = Image.open(io.BytesIO(pix.tobytes("png")))

            blocks = client.two_step_extract(img)
            texts = [content_block_to_text(b) for b in blocks]
            page_text = "\n".join(t for t in texts if t)

            pages.append({
                "page_idx": page_idx,
                "text": page_text,
                "tokens": len(page_text) // 4,
            })
        except Exception as e:
            # On per-page failure, emit empty page with error note
            pages.append({
                "page_idx": page_idx,
                "text": f"[Page {page_idx} extraction failed: {e}]",
                "tokens": 0,
            })

    doc.close()
    print(json.dumps({"pages": pages, "bookmarks": []}))


if __name__ == "__main__":
    main()
