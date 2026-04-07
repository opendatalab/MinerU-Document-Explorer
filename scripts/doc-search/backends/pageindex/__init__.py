import logging
from typing import Optional

from .page_index import *
from .page_index_md import md_to_tree

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Adapter + factory
# ---------------------------------------------------------------------------

class PageIndexTreeBuilderAdapter:
    """Adapts ``page_index()`` to the :class:`TreeBuilder` protocol."""

    def __init__(self, model: str, add_summary: str = "no",
                 api_key: str = "", base_url: str = ""):
        self._model = model
        self._add_summary = add_summary
        self._api_key = api_key
        self._base_url = base_url

    def build(self, pdf_path: str) -> Optional[dict]:
        try:
            from doc_search.backends.pageindex.page_index import page_index
            from doc_search.backends.pageindex.utils import configure

            configure(api_key=self._api_key, base_url=self._base_url)

            result = page_index(
                pdf_path,
                model=self._model,
                if_add_node_id="yes",
                if_add_node_summary=self._add_summary,
                if_add_doc_description="no",
                if_add_node_text="no",
            )
            return result
        except Exception:
            logger.exception(
                "PageIndex tree building failed; document is still usable without outline"
            )
            return None


def create_tree_builder(config) -> Optional["PageIndexTreeBuilderAdapter"]:
    """Factory: build a :class:`PageIndexTreeBuilderAdapter` from *config*, or ``None``."""
    model = config.pageindex_model
    if not model:
        return None
    return PageIndexTreeBuilderAdapter(
        model=model,
        add_summary=config.pageindex_add_summary,
        api_key=config.pageindex_api_key,
        base_url=config.pageindex_base_url,
    )
