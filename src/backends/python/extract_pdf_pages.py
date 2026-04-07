#!/usr/bin/env python3
"""Extract per-page text + native bookmarks from a PDF using PyMuPDF."""
import sys, json

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: extract_pdf_pages.py <filepath>"}))
        sys.exit(1)
    filepath = sys.argv[1]
    try:
        import fitz  # PyMuPDF
    except ImportError:
        print(json.dumps({"error": "PyMuPDF not installed. Run: pip install pymupdf"}))
        sys.exit(1)
    try:
        doc = fitz.open(filepath)
    except Exception as e:
        print(json.dumps({"error": f"Failed to open PDF: {e}"}))
        sys.exit(1)
    pages = []
    for i, page in enumerate(doc):
        text = ""
        try:
            text = page.get_text("markdown")
        except (AssertionError, Exception):
            pass
        if not text:
            text = page.get_text("text")
        pages.append({"page_idx": i, "text": text or "", "tokens": len(text) // 4})
    toc = doc.get_toc()
    bookmarks = []
    for level, title, page_num in toc:
        bookmarks.append({"level": level, "title": title, "page": max(0, page_num - 1)})
    print(json.dumps({"pages": pages, "bookmarks": bookmarks}))

if __name__ == "__main__":
    main()
