"""Data models for doc_search."""

from dataclasses import dataclass, field
from typing import Dict, List, Optional

__all__ = [
    "Page",
    "ScoredPage",
    "Element",
    "Capabilities",
    "DocInfo",
    "DocNotFoundError",
    "PreprocessingTimeoutError",
    "OperationTimeoutError",
]


class DocNotFoundError(ValueError):
    """Raised when a doc_id is not found in the store."""

    def __init__(self, doc_id: str):
        super().__init__(f"Unknown doc_id: {doc_id}. Run init_doc first.")
        self.doc_id = doc_id


class PreprocessingTimeoutError(TimeoutError):
    """Raised when waiting for preprocessing exceeds the timeout.

    Carries structured context so callers (CLI, client) can produce
    informative stderr messages.
    """

    def __init__(self, reason: str, progress: dict = None,
                 eta_seconds: float = None, timeout: float = None,
                 operation: str = None):
        self.reason = reason
        self.progress = progress or {}
        self.eta_seconds = eta_seconds
        self.timeout = timeout
        self.operation = operation

        parts = [reason]
        if operation:
            parts.append(f"(blocked operation: {operation})")
        done = self.progress.get("ocr_pages_done")
        total = self.progress.get("ocr_pages_total")
        current_phase = self.progress.get("current_phase")
        if current_phase and current_phase != "ocr":
            parts.append(f"(current phase: {current_phase})")
        elif done is not None and total is not None:
            parts.append(f"(progress: {done}/{total} pages)")
        if eta_seconds is not None and eta_seconds > 0:
            parts.append(f"(estimated ~{eta_seconds:.0f}s remaining)")
        if timeout is not None:
            parts.append(f"[timeout={timeout:.0f}s]")
        super().__init__(" ".join(parts))


class OperationTimeoutError(TimeoutError):
    """Raised when a specific operation (HTTP call, service request) times out.

    Unlike PreprocessingTimeoutError which is about background init progress,
    this covers synchronous operations like reranker calls or extractor calls.
    """

    def __init__(self, operation: str, reason: str, timeout: float = None):
        self.operation = operation
        self.reason = reason
        self.timeout = timeout

        parts = [f"{operation}: {reason}"]
        if timeout is not None:
            parts.append(f"[timeout={timeout:.0f}s]")
        super().__init__(" ".join(parts))


@dataclass
class Page:
    page_idx: int  # 0-indexed
    image_path: Optional[str] = None
    ocr_text: Optional[str] = None
    num_tokens: Optional[int] = None
    matched_elements: Optional[List[dict]] = None  # keyword-matched OCR elements with bbox

    def to_dict(self) -> dict:
        d = {"page_idx": self.page_idx}
        if self.image_path is not None:
            d["image_path"] = self.image_path
        if self.ocr_text is not None:
            d["ocr_text"] = self.ocr_text
        if self.num_tokens is not None:
            d["num_tokens"] = self.num_tokens
        if self.matched_elements is not None:
            d["matched_elements"] = self.matched_elements
        return d


@dataclass
class Element:
    page_idx: int
    bbox: List[int]  # [x1,y1,x2,y2] 0-1000 normalized
    content: str
    crop_path: Optional[str] = None
    element_type: str = "evidence"

    def to_dict(self) -> dict:
        d = {
            "page_idx": self.page_idx,
            "bbox": self.bbox,
            "content": self.content,
            "element_type": self.element_type,
        }
        if self.crop_path is not None:
            d["crop_path"] = self.crop_path
        return d


@dataclass
class ScoredPage(Page):
    """Page with a relevance score from reranker search."""
    score: float = 0.0

    def to_dict(self) -> dict:
        d = super().to_dict()
        d["score"] = self.score
        return d


@dataclass
class Capabilities:
    """Tracks what preprocessing has been completed for a document."""
    is_scanned_doc: bool = False
    has_native_outline: bool = False
    has_pageindex: bool = False
    has_embedding: bool = False
    has_mineru: bool = False

    def to_dict(self) -> dict:
        return {
            "is_scanned_doc": self.is_scanned_doc,
            "has_native_outline": self.has_native_outline,
            "has_pageindex": self.has_pageindex,
            "has_embedding": self.has_embedding,
            "has_mineru": self.has_mineru,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Capabilities":
        return cls(**{k: d.get(k, False) for k in cls.__dataclass_fields__})


@dataclass
class DocInfo:
    doc_id: str
    doc_name: str
    pdf_path: str
    num_pages: int
    cache_dir: str
    tree_index: Optional[Dict] = None
    native_outline: Optional[List] = None
    ocr_mode: str = "mineru"  # "mineru" or "native"
    init_status: str = "ready"  # "initializing" or "ready"
    capabilities: Optional[Capabilities] = None

    def to_dict(self) -> dict:
        return {
            "doc_id": self.doc_id,
            "doc_name": self.doc_name,
            "pdf_path": self.pdf_path,
            "num_pages": self.num_pages,
            "cache_dir": self.cache_dir,
            "tree_index": self.tree_index,
            "native_outline": self.native_outline,
            "ocr_mode": self.ocr_mode,
            "init_status": self.init_status,
            "capabilities": self.capabilities.to_dict() if self.capabilities else None,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "DocInfo":
        caps_data = d.get("capabilities")
        caps = Capabilities.from_dict(caps_data) if caps_data else None
        return cls(
            doc_id=d["doc_id"],
            doc_name=d["doc_name"],
            pdf_path=d["pdf_path"],
            num_pages=d["num_pages"],
            cache_dir=d["cache_dir"],
            tree_index=d.get("tree_index"),
            native_outline=d.get("native_outline"),
            ocr_mode=d.get("ocr_mode", "mineru"),
            init_status=d.get("init_status", "ready"),
            capabilities=caps,
        )
