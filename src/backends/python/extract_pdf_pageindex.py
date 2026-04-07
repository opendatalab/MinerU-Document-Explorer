#!/usr/bin/env python3
"""Call PageIndex to generate LLM-inferred TOC for a PDF.

Usage: extract_pdf_pageindex.py <pdf_path> [base_url] [model]

Requires PAGEINDEX_API_KEY environment variable.

Outputs JSON to stdout:
  { "doc_name": "...", "structure": [ { "title": "...", "start_index": 1, "end_index": 5, "nodes": [...] } ] }

start_index / end_index are 1-indexed physical page numbers.
"""
import sys
import os
import json
import logging

logging.basicConfig(level=logging.WARNING)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: extract_pdf_pageindex.py <pdf_path> [base_url] [model]"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    api_key = os.environ.get("PAGEINDEX_API_KEY")
    if not api_key:
        print(json.dumps({"error": "PAGEINDEX_API_KEY environment variable is required"}))
        sys.exit(1)
    base_url = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
    model = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else "gpt-4o-2024-11-20"

    if not os.path.isfile(pdf_path):
        print(json.dumps({"error": f"PDF not found: {pdf_path}"}))
        sys.exit(1)

    # Import from the local pageindex package (co-located in src/backends/python/)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, script_dir)

    try:
        # Suppress JsonLogger to avoid writing garbage files to CWD/logs/
        from pageindex import utils as _pi_utils
        class _NullLogger:
            def __init__(self, *a, **k): pass
            def log(self, *a, **k): pass
            def info(self, *a, **k): pass
            def error(self, *a, **k): pass
            def debug(self, *a, **k): pass
            def exception(self, *a, **k): pass
        _pi_utils.JsonLogger = _NullLogger

        from pageindex import configure, page_index
    except ImportError as e:
        print(json.dumps({"error": f"Failed to import PageIndex: {e}. Install deps: pip install tiktoken openai pymupdf"}))
        sys.exit(1)

    configure(api_key=api_key, base_url=base_url)

    try:
        result = page_index(
            pdf_path,
            model=model,
            if_add_node_id="no",
            if_add_node_summary="no",
            if_add_doc_description="no",
            if_add_node_text="no",
        )
    except Exception as e:
        print(json.dumps({"error": f"PageIndex failed: {e}"}))
        sys.exit(1)

    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
