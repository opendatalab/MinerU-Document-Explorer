"""Shared accessors for Components and DocStore used by all core submodules."""

from doc_search.components import get_components as _get_components
from doc_search.doc_store import DocStore


def _get_store() -> DocStore:
    """Convenience shortcut: return the DocStore from global Components."""
    return _get_components().store
