"""get_pages and OCR helpers."""

import logging
import os
from typing import Dict, List, Optional, Tuple, Union

from doc_search.doc_store import DocStore
from doc_search.models import DocNotFoundError, Page
from doc_search.pdf_utils import parse_page_idxs

from ._store import _get_components, _get_store

logger = logging.getLogger(__name__)


def get_pages(
    doc_id: str,
    page_idxs: Union[List[int], str],
    return_image: bool = True,
    return_text: bool = False,
    timeout: Optional[float] = None,
) -> Dict:
    """Return page data (image path and/or OCR text) for the given page indices.

    page_idxs supports flexible formats: list of ints, negative indices, ranges.
    See parse_page_idxs() for details.

    Args:
        timeout: If set and ``return_text=True``, wait up to this many seconds
            for OCR preprocessing to complete before proceeding. Raises
            ``PreprocessingTimeoutError`` if preprocessing does not finish.

    Returns dict with 'pages' list and 'warnings'.
    """
    store = _get_store()
    info = store.load_doc_info(doc_id)
    if info is None:
        raise DocNotFoundError(doc_id)

    if timeout is not None and return_text and info.init_status == "initializing":
        from .init import wait_for_preprocessing
        wait_result = wait_for_preprocessing(doc_id, timeout=timeout, operation="get_pages")
        timeout = max(timeout - wait_result.get("_elapsed", 0.0), 1.0)
        info = store.load_doc_info(doc_id)  # reload after wait

    resolved = parse_page_idxs(page_idxs, info.num_pages)
    warnings: List[str] = []
    pages: List[Page] = []

    for idx in resolved:
        image_path = store.page_image_path(doc_id, idx) if return_image else None
        ocr_text = None
        num_tokens = None

        if return_text:
            ocr_text = get_or_run_ocr(doc_id, idx, store)["ocr_text"]
            num_tokens = len(ocr_text) // 4 if ocr_text else 0

        pages.append(Page(
            page_idx=idx,
            image_path=image_path,
            ocr_text=ocr_text,
            num_tokens=num_tokens,
        ))

    return {"pages": pages, "warnings": warnings}


def _ocr_full_page_elements(image_path: str) -> Tuple[str, List[dict]]:
    """Run OCR on a full page image via the configured OCR provider.

    Returns (text, elements) where each element is ``{"bbox": [...], "content": "..."}``.
    """
    try:
        comp = _get_components()
        if comp.ocr is None:
            logger.warning("No OCR provider configured; returning empty OCR")
            return "", []
        return comp.ocr.ocr_page(image_path)
    except Exception:
        logger.exception("OCR failed for %s", image_path)
        return "", []


def _extract_native_page_text(pdf_path: str, page_idx: int) -> str:
    """Extract native text from a single PDF page using PyMuPDF.

    Returns the page text, or empty string on failure.
    """
    try:
        import pymupdf
        doc = pymupdf.open(pdf_path)
        if page_idx < 0 or page_idx >= len(doc):
            doc.close()
            return ""
        text = doc[page_idx].get_text()
        doc.close()
        return text or ""
    except ImportError:
        logger.debug("pymupdf not installed; native text extraction skipped")
        return ""
    except Exception:
        logger.debug("Native text extraction failed for page %d of %s", page_idx, pdf_path, exc_info=True)
        return ""


def batch_get_cached_ocr_or_native(
    doc_id: str, page_indices: List[int], store: DocStore,
    pdf_path: str = "",
) -> Dict[int, dict]:
    """Batch read-only OCR lookup for multiple pages.

    Checks cache first, then opens the PDF at most once for all native-text
    fallback pages.  Never triggers on-demand OCR — safe to call while
    background init is running.

    Args:
        pdf_path: If provided, used directly for native text extraction
            instead of loading doc_info again.

    Returns ``{page_idx: {"ocr_text": str, "ocr_elements": list|None}}``.
    """
    results: Dict[int, dict] = {}
    need_native: List[int] = []

    for idx in page_indices:
        cached = store.load_page_ocr(doc_id, idx)
        if cached is not None:
            results[idx] = {
                "ocr_text": cached.get("ocr_text", ""),
                "ocr_elements": cached.get("ocr_elements"),
            }
        else:
            need_native.append(idx)

    if need_native:
        native_texts = _extract_native_pages_batch(need_native, pdf_path, doc_id, store)
        for idx in need_native:
            text = native_texts.get(idx, "")
            results[idx] = {"ocr_text": text, "ocr_elements": None}

    return results


def _extract_native_pages_batch(
    page_indices: List[int], pdf_path: str,
    doc_id: str = "", store: Optional[DocStore] = None,
) -> Dict[int, str]:
    """Extract native text from multiple PDF pages, opening the file once.

    Args:
        pdf_path: Direct path to PDF. If empty, falls back to loading
            doc_info from store to get the path.
    """
    if not pdf_path and store is not None and doc_id:
        info = store.load_doc_info(doc_id)
        pdf_path = info.pdf_path if info else ""
    if not pdf_path:
        return {}
    try:
        import pymupdf
        doc = pymupdf.open(pdf_path)
        result = {}
        for idx in page_indices:
            if 0 <= idx < len(doc):
                result[idx] = doc[idx].get_text() or ""
            else:
                result[idx] = ""
        doc.close()
        return result
    except ImportError:
        logger.debug("pymupdf not installed; batch native text extraction skipped")
        return {}
    except Exception:
        logger.debug("Batch native text extraction failed", exc_info=True)
        return {}


def get_or_run_ocr(doc_id: str, page_idx: int, store: DocStore) -> dict:
    """Get full OCR data (text + elements) from cache, or run OCR and cache.

    Returns ``{"ocr_text": str, "ocr_elements": list|None}``.

    When the page image does not yet exist (e.g. OCR is still processing in the
    background), falls back to native PDF text extraction via PyMuPDF.  The
    fallback result is **not cached** so that a subsequent OCR pass can write
    the full structured data.
    """
    cached = store.load_page_ocr(doc_id, page_idx)
    if cached is not None:
        return {
            "ocr_text": cached.get("ocr_text", ""),
            "ocr_elements": cached.get("ocr_elements"),
        }

    # On-demand OCR (needs page image)
    img_path = store.page_image_path(doc_id, page_idx)
    if os.path.exists(img_path):
        text, elements = _ocr_full_page_elements(img_path)
        store.save_page_ocr(doc_id, page_idx, text, ocr_elements=elements or None)
        return {"ocr_text": text, "ocr_elements": elements or None}

    # Fallback: native text from PDF (no bbox, not cached)
    info = store.load_doc_info(doc_id)
    if info is not None and info.pdf_path:
        text = _extract_native_page_text(info.pdf_path, page_idx)
        if text:
            return {"ocr_text": text, "ocr_elements": None}

    return {"ocr_text": "", "ocr_elements": None}
