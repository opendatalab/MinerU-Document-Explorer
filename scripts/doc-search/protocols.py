"""Service protocols for doc_search.

Implement these protocols to add custom backends (OCR, reranker, embedder, etc.).
Existing implementations live in ``doc_search.backends/``.
"""

from typing import Dict, List, Optional, Protocol, Tuple, runtime_checkable


@runtime_checkable
class OCRProvider(Protocol):
    """Interface for OCR text extraction from page images."""

    def ocr_page(self, image_path: str) -> Tuple[str, List[dict]]:
        """OCR a full page image.

        Returns:
            (text, elements) where each element is
            ``{"bbox": [x1, y1, x2, y2], "content": "..."}``.
            Bounding boxes use 0-1000 normalized coordinates.
        """
        ...


@runtime_checkable
class Reranker(Protocol):
    """Interface for visual/text page reranking."""

    def rerank(self, query: str, image_paths: List[str],
               timeout: float = None) -> List[float]:
        """Score page images by relevance to *query*.

        Args:
            timeout: Optional HTTP request timeout in seconds.

        Returns:
            List of float scores, same length as *image_paths*.
        """
        ...


@runtime_checkable
class Embedder(Protocol):
    """Interface for page/query embedding (used by FAISS recall stage)."""

    def embed_pages(self, image_paths: List[str]) -> List[List[float]]:
        """Embed page images into vectors."""
        ...

    def embed_query(self, query: str) -> List[float]:
        """Embed a text query into a vector."""
        ...


@runtime_checkable
class EvidenceExtractor(Protocol):
    """Interface for extracting evidence elements from page images."""

    def extract(self, image_path: str, query: str, work_dir: str = "",
                timeout: float = None) -> List[dict]:
        """Extract evidence elements matching *query* from a page image.

        Args:
            image_path: Path to the page image.
            query: The user's query string.
            work_dir: Optional working directory for intermediate files
                (e.g. cropped images).  Defaults to empty string.
            timeout: Optional timeout in seconds for the extraction operation.

        Returns:
            List of ``{"evidence": str, "bbox": [x1, y1, x2, y2]}`` dicts.
            Bounding boxes use 0-1000 normalized coordinates.
        """
        ...


@runtime_checkable
class TreeBuilder(Protocol):
    """Interface for building hierarchical document structure."""

    def build(self, pdf_path: str) -> Optional[dict]:
        """Build a tree index from a PDF file.

        Returns:
            ``{"doc_name": str, "structure": [...]}`` on success,
            or ``None`` on failure.
        """
        ...
