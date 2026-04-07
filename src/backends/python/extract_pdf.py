#!/usr/bin/env python3
"""
PDF text extraction using PyMuPDF (fallback when MinerU cloud is unavailable).

Usage:
    python extract_pdf.py <pdf_path>

Output (stdout): JSON array of page objects:
    [
      { "page_idx": 0, "text": "...", "tokens": 123 },
      ...
    ]

Exits with code 0 on success, non-zero on error (error message on stderr).
"""

import json
import math
import sys


def _estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token."""
    return math.ceil(len(text) / 4)


def extract_pdf(pdf_path: str) -> list:
    try:
        import fitz  # PyMuPDF
    except ImportError:
        print("PyMuPDF (fitz) is not installed. Run: pip install pymupdf", file=sys.stderr)
        sys.exit(1)

    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        print(f"Failed to open PDF: {e}", file=sys.stderr)
        sys.exit(1)

    pages = []
    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text("text")
        pages.append({
            "page_idx": page_num,
            "text": text,
            "tokens": _estimate_tokens(text),
        })

    doc.close()
    return pages


def main():
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <pdf_path>", file=sys.stderr)
        sys.exit(1)

    pdf_path = sys.argv[1]
    pages = extract_pdf(pdf_path)
    print(json.dumps(pages, ensure_ascii=False))


if __name__ == "__main__":
    main()
