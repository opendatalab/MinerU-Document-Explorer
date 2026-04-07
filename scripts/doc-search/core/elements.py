"""extract_elements — evidence extraction via the configured EvidenceExtractor."""

import hashlib
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, List, Optional, Union

from doc_search.doc_store import DocStore
from doc_search.models import DocNotFoundError, Element
from doc_search.pdf_utils import crop_element_image, parse_page_idxs

from ._store import _get_components, _get_store

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def extract_elements(
    doc_id: str,
    page_idxs: Union[List[int], str],
    query: str,
    generate_crop: bool = True,
    timeout: Optional[float] = None,
) -> Dict:
    """Extract evidence elements from pages using the configured extractor.

    Args:
        timeout: If set, wait up to this many seconds for preprocessing to
            complete before extracting. Also used as timeout for individual
            extractor calls. Raises ``PreprocessingTimeoutError`` or
            ``OperationTimeoutError`` on timeout.

    Returns dict with 'elements' list and 'warnings'.
    """
    store = _get_store()
    info = store.load_doc_info(doc_id)
    if info is None:
        raise DocNotFoundError(doc_id)

    if timeout is not None and info.init_status == "initializing":
        from doc_search.core.init import wait_for_preprocessing
        wait_result = wait_for_preprocessing(doc_id, timeout=timeout, operation="extract_elements")
        elapsed = wait_result.get("_elapsed", 0.0)
        timeout = max(timeout - elapsed, 1.0)  # remaining budget (at least 1s)
        info = store.load_doc_info(doc_id)  # reload after wait

    resolved = parse_page_idxs(page_idxs, info.num_pages)
    warnings: List[str] = []

    query_hash = hashlib.sha256(query.encode()).hexdigest()[:16]

    # Phase 1: separate cached from uncached pages
    cached_elements: Dict[int, List[Element]] = {}
    uncached_idxs: List[int] = []

    for idx in resolved:
        cached = store.load_elements(doc_id, idx, query_hash)
        if cached is not None:
            elements = [Element(**e) for e in cached]
            if generate_crop:
                image_path = store.page_image_path(doc_id, idx)
                elements_dir = store.elements_dir(doc_id)
                for elem in elements:
                    if elem.crop_path is None and elem.bbox != [0, 0, 0, 0]:
                        elem.crop_path = crop_element_image(
                            image_path, elem.bbox, elements_dir, idx,
                        )
            cached_elements[idx] = elements
        else:
            uncached_idxs.append(idx)

    # Phase 2: extract uncached pages in parallel
    extracted_elements: Dict[int, List[Element]] = {}

    if uncached_idxs:
        max_workers = min(len(uncached_idxs), _get_max_parallel_pages())

        def _process_page(idx: int) -> tuple:
            image_path = store.page_image_path(doc_id, idx)
            elems = _extract_elements_for_page(
                image_path, query, idx, store, doc_id, generate_crop,
                timeout=timeout,
            )
            store.save_elements(
                doc_id, idx, query_hash, [e.to_dict() for e in elems],
            )
            return idx, elems

        if max_workers <= 1:
            # Single page — no thread overhead
            idx, elems = _process_page(uncached_idxs[0])
            extracted_elements[idx] = elems
        else:
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                futures = {
                    executor.submit(_process_page, idx): idx
                    for idx in uncached_idxs
                }
                for future in as_completed(futures):
                    idx = futures[future]
                    try:
                        _, elems = future.result()
                        extracted_elements[idx] = elems
                    except Exception:
                        logger.exception(
                            "Parallel extraction failed for page %d", idx,
                        )
                        extracted_elements[idx] = []

    # Phase 3: reassemble in original page order
    all_elements: List[Element] = []
    for idx in resolved:
        if idx in cached_elements:
            all_elements.extend(cached_elements[idx])
        elif idx in extracted_elements:
            all_elements.extend(extracted_elements[idx])

    return {"elements": all_elements, "warnings": warnings}


def _extract_elements_for_page(
    image_path: str,
    query: str,
    page_idx: int,
    store: DocStore,
    doc_id: str,
    generate_crop: bool = True,
    timeout: float = None,
) -> List[Element]:
    """Run evidence extraction on a single page via the configured extractor."""
    try:
        comp = _get_components()
        extractor = comp.extractor
        if extractor is None:
            logger.warning("No evidence extractor configured")
            return []

        extracted_data = extractor.extract(
            image_path, query, work_dir=store.elements_dir(doc_id),
            timeout=timeout,
        )

        elements_dir = store.elements_dir(doc_id)
        elements: List[Element] = []
        for item in extracted_data:
            if not isinstance(item, dict):
                continue

            bbox = item.get("bbox", [0, 0, 0, 0])
            evidence = item.get("evidence", "")
            if not isinstance(bbox, list) or len(bbox) != 4:
                bbox = [0, 0, 0, 0]

            crop_path = None
            if generate_crop:
                crop_path = crop_element_image(
                    image_path, bbox, elements_dir, page_idx,
                )

            elements.append(Element(
                page_idx=page_idx,
                bbox=bbox,
                content=evidence,
                crop_path=crop_path,
                element_type="evidence",
            ))

        return elements

    except Exception:
        logger.exception("Element extraction failed for page %d", page_idx)
        return []


def _get_max_parallel_pages() -> int:
    """Return configured max parallel pages for extraction."""
    try:
        cfg = _get_components().config
        return getattr(cfg, "extractor_max_parallel_pages", 4)
    except Exception:
        return 4
