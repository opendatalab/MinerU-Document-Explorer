"""Client-side cache manager for doc_search client."""

import hashlib
import logging
import os
from typing import Optional

from doc_search.utils import atomic_write_json, read_json

logger = logging.getLogger(__name__)

__all__ = ["ClientDocStore"]


class ClientDocStore:
    """Manages client-side cache at {cache_root}/{doc_id}/."""

    def __init__(self, cache_root: str):
        self.cache_root = os.path.abspath(cache_root)
        os.makedirs(self.cache_root, exist_ok=True)

    def cache_dir(self, doc_id: str) -> str:
        return os.path.join(self.cache_root, doc_id)

    def pages_dir(self, doc_id: str) -> str:
        d = os.path.join(self.cache_dir(doc_id), "pages")
        os.makedirs(d, exist_ok=True)
        return d

    def elements_dir(self, doc_id: str) -> str:
        d = os.path.join(self.cache_dir(doc_id), "elements")
        os.makedirs(d, exist_ok=True)
        return d

    def search_cache_dir(self, doc_id: str) -> str:
        d = os.path.join(self.cache_dir(doc_id), "search_results")
        os.makedirs(d, exist_ok=True)
        return d

    # --- Doc info ---

    def doc_info_path(self, doc_id: str) -> str:
        return os.path.join(self.cache_dir(doc_id), "doc_info.json")

    def save_doc_info(self, doc_id: str, data: dict) -> None:
        atomic_write_json(self.doc_info_path(doc_id), data)

    def load_doc_info(self, doc_id: str) -> Optional[dict]:
        return read_json(self.doc_info_path(doc_id))

    # --- Page images ---

    def page_image_path(self, doc_id: str, page_idx: int) -> str:
        return os.path.join(self.pages_dir(doc_id), f"page_{page_idx}.png")

    def has_page_image(self, doc_id: str, page_idx: int) -> bool:
        return os.path.exists(self.page_image_path(doc_id, page_idx))

    # --- Page OCR ---

    def page_ocr_path(self, doc_id: str, page_idx: int) -> str:
        return os.path.join(self.pages_dir(doc_id), f"page_{page_idx}_ocr.json")

    def save_page_ocr(self, doc_id: str, page_idx: int, ocr_text: str,
                      num_tokens: Optional[int] = None,
                      ocr_elements: Optional[list] = None) -> None:
        data = {"ocr_text": ocr_text}
        if num_tokens is not None:
            data["num_tokens"] = num_tokens
        if ocr_elements is not None:
            data["ocr_elements"] = ocr_elements
        atomic_write_json(self.page_ocr_path(doc_id, page_idx), data)

    def load_page_ocr(self, doc_id: str, page_idx: int) -> Optional[dict]:
        """Returns {"ocr_text": str, "num_tokens": int} or None."""
        return read_json(self.page_ocr_path(doc_id, page_idx))

    # --- Search results ---

    @staticmethod
    def search_cache_key(query: str, page_idxs: str, **extra) -> str:
        """Deterministic cache key for search results."""
        raw = f"{query}:{page_idxs}"
        for k in sorted(extra):
            raw += f":{k}={extra[k]}"
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    def search_result_path(self, doc_id: str, cache_key: str) -> str:
        return os.path.join(self.search_cache_dir(doc_id), f"{cache_key}.json")

    def save_search_results(self, doc_id: str, cache_key: str, data: dict) -> None:
        atomic_write_json(self.search_result_path(doc_id, cache_key), data)

    def load_search_results(self, doc_id: str, cache_key: str) -> Optional[dict]:
        return read_json(self.search_result_path(doc_id, cache_key))

    # --- Elements ---

    def elements_result_path(self, doc_id: str, cache_key: str) -> str:
        return os.path.join(self.elements_dir(doc_id), f"{cache_key}.json")

    def save_elements(self, doc_id: str, cache_key: str, data: dict) -> None:
        atomic_write_json(self.elements_result_path(doc_id, cache_key), data)

    def load_elements(self, doc_id: str, cache_key: str) -> Optional[dict]:
        return read_json(self.elements_result_path(doc_id, cache_key))
