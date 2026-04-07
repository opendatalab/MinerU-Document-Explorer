"""search_semantic, search_keyword, and embedding index helpers."""

import hashlib
import logging
import os
import re
from typing import Dict, List, Optional, Union

from doc_search.doc_store import DocStore
from doc_search.utils import atomic_write_json, match_pattern_to_elements, read_json
from doc_search.models import DocNotFoundError, Page, ScoredPage
from doc_search.pdf_utils import parse_page_idxs

from ._store import _get_components, _get_store
from .pages import batch_get_cached_ocr_or_native, get_or_run_ocr

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Embedding index build + recall
# ---------------------------------------------------------------------------

def _build_embedding_index(doc_id: str, num_pages: int, store: DocStore, embedder: "Embedder") -> bool:
    """Embed all page images and build a FAISS IndexFlatIP.

    Saves index.faiss and docmap.json to store.embedding_dir(doc_id).
    Returns True on success, False on failure.
    """
    try:
        import faiss
        import numpy as np
    except ImportError:
        logger.warning("faiss-cpu or numpy not installed; embedding index skipped")
        return False

    if embedder is None:
        return False

    comp = _get_components()
    batch_size = comp.config.embedding_batch_size
    all_embeddings = []
    docmap = []  # FAISS row idx → page_idx

    for batch_start in range(0, num_pages, batch_size):
        batch_end = min(batch_start + batch_size, num_pages)
        batch_paths = []
        batch_page_idxs = []
        for idx in range(batch_start, batch_end):
            img_path = store.page_image_path(doc_id, idx)
            if not os.path.exists(img_path):
                continue
            batch_paths.append(img_path)
            batch_page_idxs.append(idx)

        if not batch_paths:
            continue

        try:
            embeddings = embedder.embed_pages(batch_paths)
        except Exception:
            logger.exception("Embedding batch failed (pages %d-%d)", batch_start, batch_end - 1)
            return False

        for emb, page_idx in zip(embeddings, batch_page_idxs):
            all_embeddings.append(emb)
            docmap.append(page_idx)

    if not all_embeddings:
        logger.warning("No embeddings produced for doc %s", doc_id)
        return False

    emb_array = np.array(all_embeddings, dtype=np.float32)
    # L2-normalize for inner product similarity
    norms = np.linalg.norm(emb_array, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    emb_array = emb_array / norms

    dim = emb_array.shape[1]
    index = faiss.IndexFlatIP(dim)
    index.add(emb_array)

    emb_dir = store.embedding_dir(doc_id)
    os.makedirs(emb_dir, exist_ok=True)
    faiss.write_index(index, store.embedding_index_path(doc_id))
    atomic_write_json(store.embedding_docmap_path(doc_id), {"docmap": docmap})

    logger.info("Built embedding index for %s: %d vectors, dim=%d", doc_id, len(docmap), dim)
    return True


def _embedding_recall(
    doc_id: str,
    query: str,
    candidate_pages: List[int],
    recall_k: int,
    store: DocStore,
    embedder: "Embedder",
) -> Optional[List[int]]:
    """Use FAISS index to recall top candidate pages for a query.

    Returns a list of page indices (subset of candidate_pages, up to recall_k),
    or None if recall is unavailable (missing index, embedder, or error).
    """
    if not store.has_embedding_index(doc_id):
        return None

    if embedder is None:
        return None

    try:
        import faiss
        import numpy as np
    except ImportError:
        return None

    try:
        index = faiss.read_index(store.embedding_index_path(doc_id))
        docmap_data = read_json(store.embedding_docmap_path(doc_id))
        if docmap_data is None:
            return None
        docmap = docmap_data.get("docmap", [])

        # Embed the query text
        query_emb = embedder.embed_query(query)
        query_vec = np.array([query_emb], dtype=np.float32)
        # L2-normalize
        norm = np.linalg.norm(query_vec)
        if norm > 0:
            query_vec = query_vec / norm

        # Search with over-fetch to account for filtering
        search_k = max(recall_k * 3, 100)
        search_k = min(search_k, index.ntotal)
        scores, indices = index.search(query_vec, search_k)

        # Filter to candidate_pages
        candidate_set = set(candidate_pages)
        recalled = []
        for i in range(indices.shape[1]):
            faiss_idx = int(indices[0][i])
            if faiss_idx < 0 or faiss_idx >= len(docmap):
                continue
            page_idx = docmap[faiss_idx]
            if page_idx in candidate_set:
                recalled.append(page_idx)
                if len(recalled) >= recall_k:
                    break

        return recalled if recalled else None

    except Exception:
        logger.exception("Embedding recall failed for doc %s", doc_id)
        return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def _build_scored_pages(
    scored_items: list,
    top_k: int,
    return_image: bool,
    return_text: bool,
    store: DocStore,
    doc_id: str,
) -> List[ScoredPage]:
    """Build a list of ScoredPage objects from (page_idx, score) pairs."""
    pages = []
    for idx, score in scored_items[:top_k]:
        sp = ScoredPage(
            page_idx=idx,
            image_path=store.page_image_path(doc_id, idx) if return_image else None,
            score=score,
        )
        if return_text:
            sp.ocr_text = get_or_run_ocr(doc_id, idx, store)["ocr_text"]
            sp.num_tokens = len(sp.ocr_text) // 4 if sp.ocr_text else 0
        pages.append(sp)
    return pages

def search_semantic(
    doc_id: str,
    page_idxs: Union[List[int], str],
    query: str,
    top_k: int = 3,
    return_image: bool = True,
    return_text: bool = False,
    timeout: Optional[float] = None,
) -> Dict:
    """Search pages by visual relevance using the configured reranker.

    Two-stage pipeline when embedding index is available:
      Stage 1 (Recall): Embed query → FAISS search → top recall_k candidates
      Stage 2 (Rerank): VL-Reranker scores recall_k candidates → return top_k
    Fallback: If no FAISS index, rerank ALL pages directly.

    Args:
        timeout: If set, wait up to this many seconds for preprocessing to
            complete before searching. Raises ``PreprocessingTimeoutError``
            if preprocessing does not finish.

    Returns dict with 'pages' (List[ScoredPage]), 'method', and 'warnings'.
    """
    comp = _get_components()
    store = comp.store
    info = store.load_doc_info(doc_id)
    if info is None:
        raise DocNotFoundError(doc_id)

    if timeout is not None and info.init_status == "initializing":
        from .init import wait_for_preprocessing
        wait_result = wait_for_preprocessing(doc_id, timeout=timeout, operation="search_semantic")
        elapsed = wait_result.get("_elapsed", 0.0)
        timeout = max(timeout - elapsed, 1.0)  # remaining budget (at least 1s)
        info = store.load_doc_info(doc_id)  # reload after wait

    resolved = parse_page_idxs(page_idxs, info.num_pages)
    if not resolved:
        return {"pages": [], "method": "none", "warnings": []}

    warnings: List[str] = []
    method_used = "reranker"

    # Stage 1: Embedding recall to narrow candidates
    recall_k = comp.config.embedding_recall_k
    has_embedding = store.has_embedding_index(doc_id)

    recalled = None
    if has_embedding:
        recalled = _embedding_recall(doc_id, query, resolved, recall_k, store, comp.embedder)

    if recalled is not None:
        pages_to_rerank = recalled
        method_used = "embedding+reranker"
    else:
        pages_to_rerank = resolved
        # Transparency: warn if page range is large and no embedding recall
        if not has_embedding and len(resolved) > 50:
            warnings.append(
                f"No embedding index available; VL-Reranker will score all {len(resolved)} pages. "
                f"This may be slow for large page ranges. "
                f"Consider narrowing scope via get_outline or search_keyword first."
            )

    # Check cache (include method in key so embedding+reranker and reranker-only don't collide)
    cache_key = hashlib.sha256(
        (query + ":" + method_used + ":" + ",".join(str(i) for i in sorted(pages_to_rerank))).encode()
    ).hexdigest()[:16]
    cached = store.load_search_results(doc_id, cache_key)
    if cached is not None:
        scored_items = [(item["page_idx"], item["score"]) for item in cached]
        pages = _build_scored_pages(scored_items, top_k, return_image, return_text, store, doc_id)
        return {"pages": pages, "method": method_used, "warnings": warnings}

    # Rerank
    reranker = comp.reranker
    if reranker is None:
        raise RuntimeError("No reranker configured. Set reranker_api_base in config.")

    image_paths = [store.page_image_path(doc_id, idx) for idx in pages_to_rerank]
    scores = reranker.rerank(query, image_paths, timeout=timeout)

    # Pair scores with page indices and sort
    scored_pairs = list(zip(pages_to_rerank, scores))
    scored_pairs.sort(key=lambda x: x[1], reverse=True)

    # Cache all results (before top_k slicing)
    store.save_search_results(
        doc_id, cache_key,
        [{"page_idx": idx, "score": s} for idx, s in scored_pairs],
    )

    # Build output with top_k
    pages = _build_scored_pages(scored_pairs, top_k, return_image, return_text, store, doc_id)

    return {"pages": pages, "method": method_used, "warnings": warnings}


def normalize_pattern(pattern: Union[str, List[str]]) -> str:
    """Combine one or more regex patterns into a single pattern string.

    Accepts a single string or a list of strings.  When given a list,
    empty strings are filtered out, each remaining element is validated
    as a regex, wrapped in a non-capturing group, and joined with ``|``.

    Raises ``ValueError`` if any individual pattern is not a valid regex.
    """
    if isinstance(pattern, list):
        patterns = [p for p in pattern if p]
        if not patterns:
            return ""
        for p in patterns:
            try:
                re.compile(p)
            except re.error as e:
                raise ValueError(f"Invalid regex pattern {p!r}: {e}")
        return "|".join(f"(?:{p})" for p in patterns)
    return pattern


def search_keyword(
    doc_id: str,
    page_idxs: Union[List[int], str],
    pattern: Union[str, List[str]],
    return_image: bool = False,
    return_text: bool = False,
    timeout: Optional[float] = None,
) -> Dict:
    """Search pages by regex pattern matching on OCR text.

    Returns dict with 'pages' (pages in page order where pattern matches)
    and 'warnings'.

    Each matched page includes ``matched_elements`` — a list of OCR element
    dicts ``{"page_idx": N, "bbox": [x1,y1,x2,y2], "content": "..."}``
    whose content matches the regex pattern.

    Args:
        pattern: Regular expression string or list of strings (case-insensitive).
            A single string: "Fig\\." matches literal "Fig.",
            "revenue|profit" matches either word.
            A list of strings: each is treated as a separate pattern and
            combined with OR logic.
        return_image: If True, include image paths. Default False.
        timeout: If set, wait up to this many seconds for OCR preprocessing
            to complete before searching. Raises ``PreprocessingTimeoutError``
            if preprocessing does not finish.
    """
    store = _get_store()
    info = store.load_doc_info(doc_id)
    if info is None:
        raise DocNotFoundError(doc_id)

    if timeout is not None and info.init_status == "initializing":
        from .init import wait_for_preprocessing
        wait_result = wait_for_preprocessing(doc_id, timeout=timeout, operation="search_keyword")
        timeout = max(timeout - wait_result.get("_elapsed", 0.0), 1.0)
        info = store.load_doc_info(doc_id)  # reload after wait

    resolved = parse_page_idxs(page_idxs, info.num_pages)
    if not resolved:
        return {"pages": [], "warnings": []}

    warnings: List[str] = []

    # Transparency: warn if scanned doc without MinerU OCR
    caps = info.capabilities
    if caps and caps.is_scanned_doc and info.ocr_mode == "native":
        warnings.append(
            "Document is scanned but MinerU OCR text was not extracted. "
            "Keyword search is ineffective; try semantic search (search_semantic) or outline browsing (get_outline)."
        )

    pattern = normalize_pattern(pattern)
    if not pattern:
        return {"pages": [], "warnings": []}
    try:
        compiled = re.compile(pattern, re.IGNORECASE)
    except re.error as e:
        raise ValueError(f"Invalid regex pattern: {e}")

    # During background init, avoid on-demand OCR to prevent competing with Phase 2
    is_initializing = info.init_status == "initializing"

    # Batch-fetch OCR data: single PDF open for native text fallback
    if is_initializing:
        ocr_map = batch_get_cached_ocr_or_native(
            doc_id, resolved, store, pdf_path=info.pdf_path or "",
        )
    else:
        ocr_map = None  # use per-page get_or_run_ocr below

    matching: List[Page] = []
    native_fallback_count = 0
    has_native_text_count = 0
    ocr_done_count = 0

    for idx in resolved:
        if ocr_map is not None:
            ocr_full = ocr_map[idx]
        else:
            ocr_full = get_or_run_ocr(doc_id, idx, store)
        ocr_text = ocr_full.get("ocr_text", "")
        ocr_elements = ocr_full.get("ocr_elements")
        if ocr_elements is not None:
            ocr_done_count += 1
        elif ocr_text:
            has_native_text_count += 1

        matched_elems = match_pattern_to_elements(
            ocr_elements or [], compiled, page_idx=idx,
        )

        # Fallback: no elements but native text matches the pattern
        if not matched_elems and ocr_text and compiled.search(ocr_text):
            native_fallback_count += 1
            matched_elems = [{"page_idx": idx, "bbox": [0, 0, 1000, 1000], "content": ocr_text}]

        if not matched_elems:
            continue

        matching.append(Page(
            page_idx=idx,
            image_path=store.page_image_path(doc_id, idx) if return_image else None,
            ocr_text=ocr_text if return_text else None,
            num_tokens=len(ocr_text) // 4 if return_text and ocr_text else None,
            matched_elements=matched_elems,
        ))

    # OCR coverage warning — computed from loop data (no extra store reads)
    pages_without_ocr = len(resolved) - ocr_done_count

    if pages_without_ocr > 0:
        if is_initializing:
            parts = [
                f"Document initialization in progress ({ocr_done_count}/{len(resolved)} searched pages have OCR)."
            ]
        else:
            parts = [
                f"OCR processing in progress ({ocr_done_count}/{len(resolved)} pages ready)."
            ]
        if native_fallback_count > 0:
            parts.append(
                f"{native_fallback_count} page(s) matched using native PDF text "
                f"(no bounding box positions available)."
            )
        # Pages truly unsearchable: no OCR elements AND no native text at all
        unsearchable = pages_without_ocr - has_native_text_count
        if unsearchable > 0:
            parts.append(
                f"{unsearchable} page(s) could not be searched at all (no OCR, no native text)."
            )
        parts.append(
            "Wait for OCR to complete or use semantic search (search_semantic) for immediate results."
        )
        warnings.append(" ".join(parts))

    return {"pages": matching, "warnings": warnings}
