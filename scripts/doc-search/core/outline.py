"""get_outline — document tree outline retrieval."""

import logging
from typing import Dict, Optional

from doc_search.models import DocNotFoundError
from doc_search.tree_utils import resolve_outline

from ._store import _get_store

logger = logging.getLogger(__name__)


def get_outline(doc_id: str, max_depth: int = 2, root_node: str = "",
                timeout: Optional[float] = None) -> Dict:
    """Return the document tree outline, optionally pruned.

    Falls back to native PDF bookmarks if PageIndex is unavailable.
    Returns warnings instead of raising errors when no outline exists.

    Args:
        doc_id: Document identifier from init_doc.
        max_depth: Maximum depth levels to return.
        root_node: node_id of subtree root ("" = full tree).
        timeout: If set, wait up to this many seconds for preprocessing
            (PageIndex construction) to complete. Raises
            ``PreprocessingTimeoutError`` if preprocessing does not finish.
    """
    store = _get_store()
    info = store.load_doc_info(doc_id)
    if info is None:
        raise DocNotFoundError(doc_id)

    if timeout is not None and info.init_status == "initializing":
        from .init import wait_for_preprocessing
        wait_result = wait_for_preprocessing(doc_id, timeout=timeout, operation="get_outline")
        timeout = max(timeout - wait_result.get("_elapsed", 0.0), 1.0)
        info = store.load_doc_info(doc_id)  # reload after wait

    return resolve_outline(
        tree_index=info.tree_index,
        native_outline=info.native_outline,
        doc_id=info.doc_id,
        doc_name=info.doc_name,
        num_pages=info.num_pages,
        max_depth=max_depth,
        root_node=root_node,
    )
