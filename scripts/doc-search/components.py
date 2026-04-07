"""Dependency injection container for doc_search.

``Components`` holds all runtime dependencies (store, config, service
adapters).  Core functions obtain them via ``get_components()``.

To customise wiring (e.g. for tests or a new backend), call
``set_components()`` with a manually-built ``Components`` instance
*before* any core function is invoked.

The default ``create_components()`` reads the config and lazily
instantiates the built-in backend adapters via their co-located factories.
"""

import logging
from dataclasses import dataclass
from typing import Optional

from doc_search.config import DocSearchConfig, get_config
from doc_search.doc_store import DocStore
from doc_search.protocols import (
    Embedder,
    EvidenceExtractor,
    OCRProvider,
    Reranker,
    TreeBuilder,
)

logger = logging.getLogger(__name__)

__all__ = [
    "Components",
    "get_components",
    "set_components",
    "create_components",
]


# ---------------------------------------------------------------------------
# Components container
# ---------------------------------------------------------------------------

@dataclass
class Components:
    """Holds all runtime dependencies for the doc_search core layer."""

    store: DocStore
    config: DocSearchConfig
    ocr: Optional[OCRProvider] = None
    reranker: Optional[Reranker] = None
    embedder: Optional[Embedder] = None
    extractor: Optional[EvidenceExtractor] = None
    tree_builder: Optional[TreeBuilder] = None


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_components: Optional[Components] = None


def get_components() -> Components:
    """Return the current ``Components`` singleton, creating it from config on
    first access."""
    global _components
    if _components is None:
        _components = create_components()
    return _components


def set_components(comp: Components) -> None:
    """Replace the global ``Components`` singleton.

    Call this *before* any core function to inject test doubles or a custom
    service configuration.
    """
    global _components
    _components = comp


def create_components(config: DocSearchConfig = None) -> Components:
    """Build a ``Components`` instance from *config* (or the global config).

    Service adapters are created lazily — only when the corresponding config
    keys are populated.  Each backend module provides its own factory function.
    """
    if config is None:
        config = get_config()
    store = DocStore(config.server_cache_root)

    from doc_search.backends.mineru_tool import create_ocr
    from doc_search.backends.reranker_client import create_reranker
    from doc_search.backends.embedding_client import create_embedder
    from doc_search.backends.agentic_ocr import create_extractor
    from doc_search.backends.pageindex import create_tree_builder

    return Components(
        store=store,
        config=config,
        ocr=create_ocr(config),
        reranker=create_reranker(config),
        embedder=create_embedder(config),
        extractor=create_extractor(config),
        tree_builder=create_tree_builder(config),
    )
