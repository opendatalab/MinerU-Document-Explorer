"""init_doc — document initialization and capability management."""

import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional

from doc_search.components import Components
from doc_search.doc_store import DocStore
from doc_search.models import Capabilities, DocInfo, DocNotFoundError, PreprocessingTimeoutError
from doc_search.pdf_utils import (
    analyze_pdf,
    detect_scanned_pdf,
    extract_native_outline,
    pdf_hash,
    pdf_to_page_images,
    resolve_doc_path,
    url_doc_name,
)
from doc_search.tree_utils import convert_indices_to_0based

from ._store import _get_components, _get_store
from .pages import _ocr_full_page_elements
from .search import _build_embedding_index

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Phase-level progress tracking (thread-safe, per doc_id)
# ---------------------------------------------------------------------------

_phase_progress_lock = threading.Lock()
_phase_progress: Dict[str, dict] = {}
# Structure per doc_id:
# {
#     "current_phase": "ocr" | "embedding" | "pageindex" | "ready",
#     "phases": {
#         "ocr": {"status": "pending"|"running"|"done"|"skipped", "done": int, "total": int},
#         "embedding": {"status": "pending"|"running"|"done"|"skipped"},
#         "pageindex": {"status": "pending"|"running"|"done"|"skipped"},
#     }
# }


def _init_phase_progress(doc_id: str, has_ocr: bool, has_embedding: bool,
                          has_pageindex: bool) -> None:
    """Initialize phase progress tracking for a document."""
    with _phase_progress_lock:
        _phase_progress[doc_id] = {
            "current_phase": "ocr" if has_ocr else ("embedding" if has_embedding else ("pageindex" if has_pageindex else "ready")),
            "phases": {
                "ocr": {"status": "pending" if has_ocr else "skipped", "done": 0, "total": 0},
                "embedding": {"status": "pending" if has_embedding else "skipped"},
                "pageindex": {"status": "pending" if has_pageindex else "skipped"},
            },
        }


def _update_phase_progress(doc_id: str, phase: str, status: str,
                            done: int = None, total: int = None) -> None:
    """Update progress for a specific phase."""
    with _phase_progress_lock:
        prog = _phase_progress.get(doc_id)
        if prog is None:
            return
        phase_info = prog["phases"].get(phase)
        if phase_info is None:
            return
        phase_info["status"] = status
        if done is not None:
            phase_info["done"] = done
        if total is not None:
            phase_info["total"] = total
        # Update current_phase to the first non-done/non-skipped phase
        for p in ("ocr", "embedding", "pageindex"):
            ps = prog["phases"][p]["status"]
            if ps in ("pending", "running"):
                prog["current_phase"] = p
                break
        else:
            prog["current_phase"] = "ready"


def _get_phase_progress(doc_id: str) -> Optional[dict]:
    """Get a snapshot of phase progress for a document."""
    with _phase_progress_lock:
        prog = _phase_progress.get(doc_id)
        if prog is None:
            return None
        # Shallow copy of nested dicts — callers only read, never mutate
        return {
            "current_phase": prog["current_phase"],
            "phases": {k: dict(v) for k, v in prog["phases"].items()},
        }


def _clear_phase_progress(doc_id: str) -> None:
    """Remove phase progress tracking for a document."""
    with _phase_progress_lock:
        _phase_progress.pop(doc_id, None)


def _should_build_pageindex(enable: bool, force: bool, has_native_outline: bool) -> bool:
    """Decide whether to build PageIndex tree."""
    return force or (enable and not has_native_outline)


def init_doc(
    doc_path: str,
    doc_name: Optional[str] = None,
    enable_pageindex: bool = True,
    enable_embedding: bool = True,
    enable_mineru: bool = True,
    lazy_ocr: bool = False,
    force_pageindex: bool = False,
    _async: bool = False,
    timeout: Optional[float] = None,
) -> Dict:
    """Initialize a document: convert pages, detect capabilities, build indexes.

    Args:
        doc_path: Path to the PDF file.
        doc_name: Display name for the document. Defaults to basename of doc_path.
        enable_pageindex: Build PageIndex tree structure. Default True.
            When the PDF has a native outline (bookmarks), PageIndex is skipped
            unless *force_pageindex* is set.
        enable_embedding: Build FAISS embedding index for fast semantic recall. Default True.
            Requires embedding_api_base to be configured. Falls back gracefully if unavailable.
        enable_mineru: Use MinerU OCR for text extraction. Default True.
            If False, extract native PDF text via PyPDF2.
        lazy_ocr: If False (default), run OCR for all pages during init.
            If True, defer OCR to on-demand execution when other operations request it.
        force_pageindex: Force PageIndex tree building even when native outline exists.
            Default False.  When False, documents with native PDF bookmarks skip
            PageIndex to save time and cost.
        _async: If True, only run Phase 1 (analyze + render) and return immediately
            with init_status="initializing". Phase 2 (OCR, embedding, PageIndex)
            must be run separately via run_init_phase2(). Default False (full init).
        timeout: Maximum seconds to wait for Phase 2 when ``_async=False``.
            If None (default), waits indefinitely. If set and Phase 2 exceeds
            this duration, raises ``PreprocessingTimeoutError``.

    Returns dict with doc_id, capabilities, warnings, and metadata.

    Raises:
        PreprocessingTimeoutError: When *timeout* is set and Phase 2 does not
            complete in time.
    """
    comp = _get_components()
    cfg = comp.config
    store = comp.store
    effective_path = resolve_doc_path(doc_path, cfg.server_cache_root)
    if doc_name is None and doc_path.startswith(("http://", "https://")):
        doc_name = url_doc_name(doc_path)

    doc_id = pdf_hash(effective_path)
    warnings: List[str] = []

    # Check if already initialized -- handle capability upgrade
    existing = store.load_doc_info(doc_id)
    if existing is not None:
        _handle_capability_upgrade(existing, enable_pageindex, enable_embedding,
                                   enable_mineru, lazy_ocr, store, comp, warnings,
                                   force_pageindex=force_pageindex)
        return _format_init_response(existing, warnings)

    # ---- Phase 1: Analyze PDF + render page images (fast) ----
    num_pages, is_scanned, native_outline = analyze_pdf(effective_path)

    pages_dir = store.pages_dir(doc_id)

    if is_scanned:
        warnings.append(
            "Document appears to be scanned (very little native text). "
            "Keyword search may not work; consider using semantic search or outline browsing."
        )

    has_native_outline = native_outline is not None and len(native_outline) > 0

    # Render page images
    server_dpi = cfg.server_pdf_dpi or cfg.client_pdf_dpi
    num_pages = pdf_to_page_images(effective_path, pages_dir, server_dpi, num_pages)

    ocr_mode = "mineru" if enable_mineru else "native"

    if _async:
        # Save partial DocInfo with init_status="initializing" and return
        # immediately.  Phase 2 must be run separately via run_init_phase2().
        # Note: timeout is ignored when _async=True — the caller explicitly
        # asked for non-blocking init.
        capabilities = Capabilities(
            is_scanned_doc=is_scanned,
            has_native_outline=has_native_outline,
            has_pageindex=False,
            has_embedding=False,
            has_mineru=enable_mineru,
        )
        info = DocInfo(
            doc_id=doc_id,
            doc_name=doc_name or os.path.basename(effective_path),
            pdf_path=effective_path,
            num_pages=num_pages,
            cache_dir=store.cache_dir(doc_id),
            tree_index=None,
            native_outline=native_outline,
            ocr_mode=ocr_mode,
            init_status="initializing",
            capabilities=capabilities,
        )
        store.save_doc_info(info)
        logger.info("Phase 1 complete for %s (%d pages); Phase 2 deferred (_async=True)", doc_id, num_pages)
        return _format_init_response(info, warnings)

    if timeout is not None:
        # Synchronous init with timeout: run Phase 2 in a background thread
        # and poll for completion, raising PreprocessingTimeoutError if it
        # takes too long.
        capabilities = Capabilities(
            is_scanned_doc=is_scanned,
            has_native_outline=has_native_outline,
            has_pageindex=False,
            has_embedding=False,
            has_mineru=enable_mineru,
        )
        info = DocInfo(
            doc_id=doc_id,
            doc_name=doc_name or os.path.basename(effective_path),
            pdf_path=effective_path,
            num_pages=num_pages,
            cache_dir=store.cache_dir(doc_id),
            tree_index=None,
            native_outline=native_outline,
            ocr_mode=ocr_mode,
            init_status="initializing",
            capabilities=capabilities,
        )
        store.save_doc_info(info)

        phase2_thread = threading.Thread(
            target=run_init_phase2,
            kwargs=dict(
                doc_id=doc_id,
                enable_pageindex=enable_pageindex,
                enable_embedding=enable_embedding,
                enable_mineru=enable_mineru,
                lazy_ocr=lazy_ocr,
                force_pageindex=force_pageindex,
            ),
            daemon=True,
        )
        phase2_thread.start()
        wait_for_preprocessing(doc_id, timeout=timeout, operation="init_doc")
        # Reload final info after Phase 2 completed
        info = store.load_doc_info(doc_id)
        return _format_init_response(info, warnings)

    # ---- Phase 2: OCR + Embedding + PageIndex (slow, synchronous) ----
    pi_future = None
    emb_future = None
    ocr_future = None
    render_event = threading.Event()
    render_event.set()  # images already rendered above

    with ThreadPoolExecutor(max_workers=4) as executor:
        if _should_build_pageindex(enable_pageindex, force_pageindex, has_native_outline):
            pi_future = executor.submit(_build_tree_index, effective_path, comp)

        if not enable_mineru:
            ocr_future = executor.submit(_extract_native_text, effective_path, num_pages, doc_id, store)
        elif not lazy_ocr:
            ocr_future = executor.submit(_extract_mineru_text, num_pages, doc_id, store,
                                         pdf_path=effective_path, render_event=render_event)

        if enable_embedding and comp.embedder is not None:
            emb_future = executor.submit(_build_embedding_index, doc_id, num_pages, store, comp.embedder)

    # Collect PageIndex result
    tree_index = None
    has_pageindex = False
    if pi_future is not None:
        tree_index = pi_future.result()
        has_pageindex = tree_index is not None
        if not has_pageindex:
            if has_native_outline:
                warnings.append(
                    "PageIndex tree construction failed; falling back to native PDF bookmarks. "
                    "Native bookmarks may be coarse-grained or incomplete."
                )
            else:
                warnings.append(
                    "PageIndex tree construction failed and no native PDF bookmarks found. "
                    "Outline browsing is unavailable; use semantic search or keyword search instead."
                )
    else:
        if has_native_outline and enable_pageindex and not force_pageindex:
            # Silently skip — native outline is good enough
            pass
        elif not has_native_outline:
            warnings.append(
                "PageIndex preprocessing was skipped and no native PDF bookmarks exist. "
                "Outline browsing is unavailable."
            )

    # Collect Embedding result
    has_embedding = False
    if emb_future is not None:
        has_embedding = bool(emb_future.result())
        if not has_embedding:
            warnings.append(
                "Embedding index construction failed; semantic search will use VL-Reranker only."
            )
    elif enable_embedding and comp.embedder is None:
        warnings.append(
            "Embedding service not configured (embedding_api_base is empty); "
            "semantic search will use VL-Reranker only."
        )

    # Collect OCR result (propagate exceptions)
    has_mineru = enable_mineru

    if ocr_future is not None:
        ocr_future.result()

    if not enable_mineru and is_scanned:
        warnings.append(
            "Document is scanned but MinerU OCR is disabled; native text extraction quality is very poor. "
            "Consider re-initializing with enable_mineru=True."
        )

    capabilities = Capabilities(
        is_scanned_doc=is_scanned,
        has_native_outline=has_native_outline,
        has_pageindex=has_pageindex,
        has_embedding=has_embedding,
        has_mineru=has_mineru,
    )

    info = DocInfo(
        doc_id=doc_id,
        doc_name=doc_name or os.path.basename(effective_path),
        pdf_path=effective_path,
        num_pages=num_pages,
        cache_dir=store.cache_dir(doc_id),
        tree_index=tree_index,
        native_outline=native_outline,
        ocr_mode=ocr_mode,
        capabilities=capabilities,
    )
    store.save_doc_info(info)

    logger.info(
        "Initialized document %s (%d pages, ocr_mode=%s, pageindex=%s, embedding=%s)",
        doc_id, num_pages, ocr_mode, has_pageindex, has_embedding,
    )
    return _format_init_response(info, warnings)


def run_init_phase2(
    doc_id: str,
    enable_pageindex: bool = True,
    enable_embedding: bool = True,
    enable_mineru: bool = True,
    lazy_ocr: bool = False,
    force_pageindex: bool = False,
    progress_callback: Optional[callable] = None,
) -> Dict:
    """Execute Phase 2 (slow operations) for a document already through Phase 1.

    This runs OCR, embedding index, and PageIndex construction, then updates
    the DocInfo to init_status="ready".

    Args:
        progress_callback: Optional callable(stage, done, total) for progress tracking.
            stage is one of "ocr", "embedding", "pageindex".

    Returns dict with updated capabilities and warnings.
    """
    comp = _get_components()
    store = comp.store
    info = store.load_doc_info(doc_id)
    if info is None:
        raise ValueError(f"Unknown doc_id: {doc_id}. Run init_doc Phase 1 first.")

    warnings: List[str] = []
    num_pages = info.num_pages
    effective_path = info.pdf_path
    has_native_outline = info.native_outline is not None and len(info.native_outline or []) > 0
    caps = info.capabilities or Capabilities()

    render_event = threading.Event()
    render_event.set()  # images already rendered in Phase 1

    pi_future = None
    emb_future = None
    ocr_future = None

    will_ocr = (not enable_mineru) or (not lazy_ocr)
    will_embed = enable_embedding and comp.embedder is not None and not caps.has_embedding
    will_pageindex = _should_build_pageindex(enable_pageindex, force_pageindex, has_native_outline) and not caps.has_pageindex

    # Don't use `with` block — it waits for ALL futures before exiting,
    # delaying progress reports for fast tasks (pageindex/embedding) until
    # slow tasks (OCR) finish.  Collect results individually instead.
    executor = ThreadPoolExecutor(max_workers=4)
    # Initialize phase-level progress tracking inside try so cleanup is
    # guaranteed even if an exception occurs before futures are submitted.
    _init_phase_progress(doc_id, has_ocr=will_ocr, has_embedding=will_embed,
                          has_pageindex=will_pageindex)
    try:
        if will_pageindex:
            _update_phase_progress(doc_id, "pageindex", "running")
            pi_future = executor.submit(_build_tree_index, effective_path, comp)

        def _ocr_progress_wrapper(stage, done, total):
            """Update both phase progress and user callback."""
            if stage == "ocr":
                _update_phase_progress(doc_id, "ocr", "running", done=done, total=total)
            if progress_callback:
                progress_callback(stage, done, total)

        if not enable_mineru:
            _update_phase_progress(doc_id, "ocr", "running")
            ocr_future = executor.submit(_extract_native_text, effective_path, num_pages, doc_id, store)
        elif not lazy_ocr:
            _update_phase_progress(doc_id, "ocr", "running", done=0, total=num_pages)
            ocr_future = executor.submit(_extract_mineru_text, num_pages, doc_id, store,
                                         pdf_path=effective_path, render_event=render_event,
                                         progress_callback=_ocr_progress_wrapper)

        if will_embed:
            _update_phase_progress(doc_id, "embedding", "running")
            emb_future = executor.submit(_build_embedding_index, doc_id, num_pages, store, comp.embedder)

        # Collect PageIndex — reports progress as soon as PageIndex itself finishes
        if pi_future is not None:
            tree_index = pi_future.result()
            if tree_index is not None:
                info.tree_index = tree_index
                caps.has_pageindex = True
            else:
                if has_native_outline:
                    warnings.append(
                        "PageIndex tree construction failed; falling back to native PDF bookmarks."
                    )
                else:
                    warnings.append(
                        "PageIndex tree construction failed and no native PDF bookmarks found."
                    )
            _update_phase_progress(doc_id, "pageindex", "done")
            if progress_callback:
                progress_callback("pageindex", 1, 1)

        # Collect Embedding — reports as soon as embedding itself finishes
        if emb_future is not None:
            has_embedding = bool(emb_future.result())
            if has_embedding:
                caps.has_embedding = True
            else:
                warnings.append("Embedding index construction failed.")
            _update_phase_progress(doc_id, "embedding", "done")
            if progress_callback:
                progress_callback("embedding", 1, 1)
        elif enable_embedding and comp.embedder is None:
            warnings.append("Embedding service not configured.")

        # Collect OCR — may still be running after pageindex/embedding
        if ocr_future is not None:
            ocr_future.result()
            _update_phase_progress(doc_id, "ocr", "done")
    finally:
        executor.shutdown(wait=False)
        _clear_phase_progress(doc_id)

    # Mark as ready
    info.init_status = "ready"
    info.capabilities = caps
    store.save_doc_info(info)

    logger.info("Phase 2 complete for %s (pageindex=%s, embedding=%s)",
                doc_id, caps.has_pageindex, caps.has_embedding)
    return _format_init_response(info, warnings)


def _format_init_response(info: DocInfo, warnings: list) -> dict:
    """Build the standard init_doc return dict."""
    return {
        "doc_id": info.doc_id,
        "doc_name": info.doc_name,
        "num_pages": info.num_pages,
        "init_status": info.init_status,
        "capabilities": info.capabilities.to_dict() if info.capabilities else {},
        "warnings": warnings,
    }


def _handle_capability_upgrade(
    info: DocInfo,
    enable_pageindex: bool,
    enable_embedding: bool,
    enable_mineru: bool,
    lazy_ocr: bool,
    store: DocStore,
    comp: Components,
    warnings: list,
    force_pageindex: bool = False,
) -> None:
    """Upgrade capabilities of an already-initialized document if requested."""
    caps = info.capabilities or Capabilities()
    changed = False

    # Upgrade: MinerU OCR if document was initialized with native text only
    if enable_mineru and not lazy_ocr and info.ocr_mode == "native" and comp.ocr is not None:
        _extract_mineru_text(info.num_pages, info.doc_id, store, pdf_path=info.pdf_path)
        info.ocr_mode = "mineru"
        caps.has_mineru = True
        changed = True

    # Upgrade: extract native outline if not yet done
    if info.native_outline is None:
        native_outline = extract_native_outline(info.pdf_path, info.num_pages)
        if native_outline:
            info.native_outline = native_outline
            caps.has_native_outline = True
            changed = True

    # Upgrade: build PageIndex if now requested but wasn't done before
    # Same logic as fresh init: skip when native outline exists unless forced
    has_native = caps.has_native_outline
    if _should_build_pageindex(enable_pageindex, force_pageindex, has_native) and not caps.has_pageindex and info.tree_index is None:
        tree_index = _build_tree_index(info.pdf_path, comp)
        if tree_index is not None:
            info.tree_index = tree_index
            caps.has_pageindex = True
            changed = True
        else:
            warnings.append("PageIndex tree construction failed.")

    # Upgrade: build embedding index if now requested but wasn't done before
    if enable_embedding and not caps.has_embedding and not store.has_embedding_index(info.doc_id):
        if comp.embedder is not None:
            success = _build_embedding_index(info.doc_id, info.num_pages, store, comp.embedder)
            if success:
                caps.has_embedding = True
                changed = True
            else:
                warnings.append("Embedding index construction failed.")
        else:
            warnings.append(
                "Embedding service not configured (embedding_api_base is empty); "
                "skipping embedding index construction."
            )

    if changed:
        info.capabilities = caps
        store.save_doc_info(info)

    logger.info("Document already initialized: %s (upgrade_applied=%s)", info.doc_id, changed)


def _extract_native_text(pdf_path: str, num_pages: int, doc_id: str, store: DocStore) -> None:
    """Extract native text from PDF via PyMuPDF and pre-populate OCR cache."""
    try:
        import pymupdf

        doc = pymupdf.open(pdf_path)
        for idx in range(min(num_pages, len(doc))):
            text = doc[idx].get_text() or ""
            store.save_page_ocr(doc_id, idx, text)
        doc.close()
        logger.info("Extracted native text for %d pages", num_pages)
    except ImportError:
        logger.warning("pymupdf not installed; native text extraction skipped")
    except Exception:
        logger.exception("Native text extraction failed")


def _extract_mineru_text(num_pages: int, doc_id: str, store: DocStore,
                         pdf_path: str = "", render_event: Optional[threading.Event] = None,
                         progress_callback: Optional[callable] = None) -> None:
    """Run OCR on all pages during init and pre-populate OCR cache.

    Saves both concatenated text and structured elements (with bboxes) so that
    keyword search can return per-element matches.

    When the OCR provider supports ``ocr_pdf``, the whole PDF is processed in a
    single SDK call. Otherwise, falls back to per-page ``ocr_page`` via
    ``_ocr_full_page_elements``.

    Args:
        render_event: If provided, the per-page fallback waits for this event
            before accessing page images (they may still be rendering).
        progress_callback: Optional callable(stage, done, total) for per-page
            OCR progress tracking. Called after each page completes.
    """
    comp = _get_components()
    ocr = comp.ocr

    # Try whole-PDF extraction if provider supports it
    if pdf_path and ocr is not None and hasattr(ocr, "ocr_pdf"):
        # Check which pages still need OCR
        pages_needed = []
        for idx in range(num_pages):
            existing = store.load_page_ocr(doc_id, idx)
            if existing is not None and existing.get("ocr_elements") is not None:
                continue
            pages_needed.append(idx)

        already_cached = num_pages - len(pages_needed)
        if not pages_needed:
            logger.info("OCR completed: %d/%d pages (all cached)", num_pages, num_pages)
            if progress_callback:
                progress_callback("ocr", num_pages, num_pages)
            return

        # Report already-cached pages as initial progress
        if progress_callback and already_cached > 0:
            progress_callback("ocr", already_cached, num_pages)

        try:
            page_results = ocr.ocr_pdf(pdf_path)
            success = already_cached
            for idx in pages_needed:
                if idx in page_results:
                    text, elements = page_results[idx]
                else:
                    text, elements = "", []
                store.save_page_ocr(doc_id, idx, text, ocr_elements=elements or None)
                if text:
                    success += 1
            if progress_callback:
                progress_callback("ocr", num_pages, num_pages)
            logger.info("OCR completed (whole-PDF): %d/%d pages", success, num_pages)
            return
        except Exception:
            logger.exception("Whole-PDF OCR failed; falling back to per-page OCR")

    # No OCR provider available — nothing to do
    if ocr is None:
        logger.info("MinerU OCR requested but no provider configured (mineru_api_token empty); skipping OCR")
        return

    # Fallback: per-page OCR (parallel)
    if render_event is not None:
        render_event.wait()  # images must be ready before per-page OCR

    # Thread-safe counter for per-page progress
    _done_lock = threading.Lock()
    _done_count = [0]

    # Count already-cached pages for accurate initial progress
    already_cached = sum(
        1 for idx in range(num_pages)
        if (e := store.load_page_ocr(doc_id, idx)) is not None
        and e.get("ocr_elements") is not None
    )
    _done_count[0] = already_cached
    if progress_callback and already_cached > 0:
        progress_callback("ocr", already_cached, num_pages)

    def _ocr_single_page(idx: int) -> bool:
        existing = store.load_page_ocr(doc_id, idx)
        if existing is not None and existing.get("ocr_elements") is not None:
            return True
        img_path = store.page_image_path(doc_id, idx)
        text, elements = _ocr_full_page_elements(img_path)
        store.save_page_ocr(doc_id, idx, text, ocr_elements=elements or None)
        if progress_callback:
            with _done_lock:
                _done_count[0] += 1
                progress_callback("ocr", _done_count[0], num_pages)
        return bool(text)

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(_ocr_single_page, range(num_pages)))
    success = sum(results)
    logger.info("OCR completed: %d/%d pages", success, num_pages)


def get_init_status(doc_id: str) -> Dict:
    """Return initialization status, OCR progress, and phase-level breakdown."""
    store = _get_store()
    info = store.load_doc_info(doc_id)
    if info is None:
        raise DocNotFoundError(doc_id)

    ocr_pages_done = store.count_ocr_pages(doc_id, info.num_pages)

    result = {
        "init_status": info.init_status,
        "ocr_pages_done": ocr_pages_done,
        "ocr_pages_total": info.num_pages,
        "capabilities": info.capabilities.to_dict() if info.capabilities else {},
    }

    # Include phase-level progress if available (Phase 2 running)
    phase_prog = _get_phase_progress(doc_id)
    if phase_prog is not None:
        # Use in-memory OCR progress if more up-to-date than disk count
        mem_ocr_done = phase_prog["phases"]["ocr"].get("done", 0)
        if mem_ocr_done > ocr_pages_done:
            result["ocr_pages_done"] = mem_ocr_done
        result["current_phase"] = phase_prog["current_phase"]
        result["phases"] = phase_prog["phases"]
    elif info.init_status == "initializing":
        # Phase 2 running but no in-memory progress (e.g. server mode) —
        # infer current phase from capabilities
        caps = info.capabilities or Capabilities()
        if ocr_pages_done < info.num_pages:
            result["current_phase"] = "ocr"
        elif not caps.has_embedding:
            result["current_phase"] = "embedding"
        elif not caps.has_pageindex:
            result["current_phase"] = "pageindex"
        else:
            result["current_phase"] = "ready"
    else:
        result["current_phase"] = "ready"

    return result


def wait_for_preprocessing(doc_id: str, timeout: float = 180.0,
                           poll_interval: float = 2.0,
                           operation: str = None,
                           verbose: bool = False) -> Dict:
    """Wait for document preprocessing (Phase 2) to complete.

    Polls ``get_init_status`` until ``init_status == "ready"`` or *timeout*
    is exceeded.  Tracks OCR progress rate to estimate remaining time.

    Args:
        doc_id: Document identifier.
        timeout: Maximum seconds to wait.  If <= 0 the current status is
            checked once and ``PreprocessingTimeoutError`` is raised
            immediately when preprocessing is still running.
        poll_interval: Seconds between status polls.
        operation: Name of the calling operation (e.g. "search_keyword")
            to include in the timeout error message.
        verbose: If True, write phase-aware progress to stderr during wait.

    Returns:
        Status dict with an additional ``_elapsed`` key indicating how many
        seconds the wait consumed. Callers can subtract this from their
        overall timeout budget before passing the remainder to backends.

    Raises:
        PreprocessingTimeoutError: With *reason*, *progress*, and
            *eta_seconds* fields describing why the timeout fired.
    """
    import sys

    start_time = time.monotonic()

    try:
        status = get_init_status(doc_id)
    except DocNotFoundError:
        raise
    except Exception:
        return {"_elapsed": 0.0}

    if status.get("init_status") == "ready":
        status["_elapsed"] = 0.0
        return status

    total = status.get("ocr_pages_total", 0)
    if total == 0 and status.get("current_phase", "ocr") == "ocr":
        # No OCR pages to track — nothing meaningful to wait for
        status["_elapsed"] = 0.0
        return status

    # Bootstrap ETA tracking
    start_done = status.get("ocr_pages_done", 0)
    deadline = start_time + max(timeout, 0)
    last_bucket = -1
    last_phase = None

    while True:
        done = status.get("ocr_pages_done", 0)
        current_phase = status.get("current_phase", "ocr")

        if verbose:
            if current_phase == "ocr" and total > 0:
                pct = done * 100 // total
                bucket = pct // 10
                if bucket != last_bucket:
                    sys.stderr.write(f"\rWaiting: OCR {done}/{total} pages ({pct}%)...")
                    sys.stderr.flush()
                    last_bucket = bucket
            elif current_phase != last_phase:
                label = _phase_label(current_phase)
                sys.stderr.write(f"\rWaiting: {label}...{' ' * 20}")
                sys.stderr.flush()
                last_phase = current_phase

        if status.get("init_status") == "ready":
            elapsed = time.monotonic() - start_time
            if verbose:
                sys.stderr.write(f"\rPreprocessing complete.{' ' * 40}\n")
                sys.stderr.flush()
            status["_elapsed"] = elapsed
            return status

        now = time.monotonic()
        if now >= deadline:
            # Build phase-specific reason
            reason = _build_timeout_reason(current_phase, done, total)

            # Compute ETA from observed rate
            elapsed = now - start_time
            delta_done = done - start_done
            eta = None
            if current_phase == "ocr" and delta_done > 0 and total > done:
                rate = delta_done / elapsed
                eta = (total - done) / rate

            progress = {
                "ocr_pages_done": done,
                "ocr_pages_total": total,
                "init_status": status.get("init_status", "initializing"),
                "current_phase": current_phase,
            }
            phases = status.get("phases")
            if phases:
                progress["phases"] = phases

            raise PreprocessingTimeoutError(
                reason=reason,
                progress=progress,
                eta_seconds=eta,
                timeout=timeout,
                operation=operation,
            )

        time.sleep(poll_interval)
        try:
            status = get_init_status(doc_id)
        except DocNotFoundError:
            raise
        except Exception:
            return {"_elapsed": time.monotonic() - start_time}


def _phase_label(phase: str) -> str:
    """Human-readable Chinese label for a preprocessing phase."""
    labels = {
        "ocr": "OCR preprocessing",
        "embedding": "embedding index construction (OCR done)",
        "pageindex": "PageIndex tree construction",
    }
    return labels.get(phase, phase)


def _build_timeout_reason(current_phase: str, ocr_done: int, ocr_total: int) -> str:
    """Build a human-readable timeout reason based on current phase."""
    if current_phase == "ocr":
        if ocr_total > 0:
            return f"OCR preprocessing not complete ({ocr_done}/{ocr_total} pages)"
        return "OCR preprocessing not complete"
    elif current_phase == "embedding":
        return f"Embedding index construction in progress (OCR done: {ocr_done}/{ocr_total} pages)"
    elif current_phase == "pageindex":
        return f"PageIndex tree construction in progress (OCR done: {ocr_done}/{ocr_total} pages)"
    else:
        return "Preprocessing not complete"


def _build_tree_index(pdf_path: str, comp: Components) -> Optional[Dict]:
    """Build PageIndex tree, converting 1-indexed to 0-indexed. Returns None on failure."""
    if comp.tree_builder is None:
        logger.info("No tree builder configured; skipping PageIndex")
        return None
    try:
        result = comp.tree_builder.build(pdf_path)
        if result is None:
            return None

        structure = result.get("structure", [])
        convert_indices_to_0based(structure)

        return {
            "doc_name": result.get("doc_name", ""),
            "structure": structure,
        }
    except Exception:
        logger.exception("PageIndex failed; document is still usable without outline")
        return None
