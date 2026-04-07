"""DocStore: manages per-document cache directories."""

import logging
import os
from typing import Optional

from doc_search.models import DocInfo
from doc_search.utils import atomic_write_json, read_json

logger = logging.getLogger(__name__)

__all__ = ["DocStore"]


class DocStore:
    """Manages {cache_root}/{doc_id}/ directories."""

    def __init__(self, cache_root: str):
        self.cache_root = os.path.abspath(cache_root)
        os.makedirs(self.cache_root, exist_ok=True)

    def cache_dir(self, doc_id: str) -> str:
        return os.path.join(self.cache_root, doc_id)

    def pages_dir(self, doc_id: str) -> str:
        return os.path.join(self.cache_dir(doc_id), "pages")

    def elements_dir(self, doc_id: str) -> str:
        return os.path.join(self.cache_dir(doc_id), "elements")

    def doc_info_path(self, doc_id: str) -> str:
        return os.path.join(self.cache_dir(doc_id), "doc_info.json")

    def has_doc(self, doc_id: str) -> bool:
        return os.path.exists(self.doc_info_path(doc_id))

    def save_doc_info(self, info: DocInfo) -> None:
        atomic_write_json(self.doc_info_path(info.doc_id), info.to_dict())

    def load_doc_info(self, doc_id: str) -> Optional[DocInfo]:
        data = read_json(self.doc_info_path(doc_id))
        if data is None:
            return None
        return DocInfo.from_dict(data)

    def page_image_path(self, doc_id: str, page_idx: int) -> str:
        return os.path.join(self.pages_dir(doc_id), f"page_{page_idx}.png")

    def has_page_image(self, doc_id: str, page_idx: int) -> bool:
        return os.path.exists(self.page_image_path(doc_id, page_idx))

    def page_ocr_path(self, doc_id: str, page_idx: int) -> str:
        return os.path.join(self.pages_dir(doc_id), f"page_{page_idx}_ocr.json")

    def element_cache_path(self, doc_id: str, page_idx: int, query_hash: str) -> str:
        return os.path.join(self.elements_dir(doc_id), f"page_{page_idx}_{query_hash}.json")

    def save_page_ocr(self, doc_id: str, page_idx: int, ocr_text: str,
                      ocr_elements: Optional[list] = None) -> None:
        data = {"page_idx": page_idx, "ocr_text": ocr_text}
        if ocr_elements is not None:
            data["ocr_elements"] = ocr_elements
        path = self.page_ocr_path(doc_id, page_idx)
        atomic_write_json(path, data)

    def load_page_ocr(self, doc_id: str, page_idx: int) -> Optional[dict]:
        """Return the full OCR cache dict including ocr_elements if present.

        Returns ``{"ocr_text": str, "ocr_elements": list|None, ...}`` or None.
        """
        return read_json(self.page_ocr_path(doc_id, page_idx))

    def save_elements(self, doc_id: str, page_idx: int, query_hash: str, elements: list) -> None:
        path = self.element_cache_path(doc_id, page_idx, query_hash)
        atomic_write_json(path, {"page_idx": page_idx, "elements": elements})

    def load_elements(self, doc_id: str, page_idx: int, query_hash: str) -> Optional[list]:
        data = read_json(self.element_cache_path(doc_id, page_idx, query_hash))
        if data is None:
            return None
        return data.get("elements")

    # --- Search results cache ---

    def search_cache_dir(self, doc_id: str) -> str:
        return os.path.join(self.cache_dir(doc_id), "search_results")

    def search_cache_path(self, doc_id: str, search_hash: str) -> str:
        return os.path.join(self.search_cache_dir(doc_id), f"{search_hash}.json")

    def save_search_results(self, doc_id: str, search_hash: str, results: list) -> None:
        path = self.search_cache_path(doc_id, search_hash)
        atomic_write_json(path, {"results": results})

    def load_search_results(self, doc_id: str, search_hash: str) -> Optional[list]:
        data = read_json(self.search_cache_path(doc_id, search_hash))
        if data is None:
            return None
        return data.get("results")

    # --- Embedding index cache (interface reserved for future use) ---

    def embedding_dir(self, doc_id: str) -> str:
        return os.path.join(self.cache_dir(doc_id), "embedding")

    def embedding_index_path(self, doc_id: str) -> str:
        return os.path.join(self.embedding_dir(doc_id), "index.faiss")

    def embedding_docmap_path(self, doc_id: str) -> str:
        return os.path.join(self.embedding_dir(doc_id), "docmap.json")

    def count_ocr_pages(self, doc_id: str, num_pages: int) -> int:
        """Count how many pages have full OCR elements cached on disk."""
        count = 0
        for idx in range(num_pages):
            data = self.load_page_ocr(doc_id, idx)
            if data is not None and data.get("ocr_elements") is not None:
                count += 1
        return count

    def has_embedding_index(self, doc_id: str) -> bool:
        return os.path.exists(self.embedding_index_path(doc_id))
