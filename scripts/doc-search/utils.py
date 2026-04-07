"""Shared utility functions for doc_search."""

import json
import re
from pathlib import Path
from typing import List, Optional

__all__ = ["atomic_write_json", "read_json", "match_pattern_to_elements", "text_from_elements"]


def atomic_write_json(path: str, data: dict) -> None:
    """Write JSON file atomically via temp file + rename."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)


def read_json(path: str) -> Optional[dict]:
    """Read JSON file, return None on error."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def text_from_elements(ocr_elements: list) -> str:
    """Reconstruct OCR text by joining element contents with newlines."""
    if not ocr_elements:
        return ""
    return "\n".join(e.get("content", "") for e in ocr_elements if e.get("content"))


def match_pattern_to_elements(
    elements: List[dict],
    compiled_pattern: "re.Pattern",
    page_idx: int,
) -> List[dict]:
    """Return OCR elements whose content matches the given regex pattern.

    Each returned element includes ``page_idx``.
    """
    if not elements:
        return []

    matched = []
    for elem in elements:
        content = elem.get("content", "")
        if compiled_pattern.search(content):
            matched.append({
                "page_idx": page_idx,
                "bbox": elem.get("bbox", [0, 0, 1000, 1000]),
                "content": content,
            })
    return matched
