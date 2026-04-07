"""doc_search — PDF smart reading tools for Claude Code.

Auto-detects mode based on config:
- deployment_mode == "client" or "hybrid" or (empty + server_url set) → client (remote mode)
- deployment_mode == "local" or (empty + no server_url) → core (local mode)

In hybrid mode, the client delegates most work to the remote server but
runs locally configured backends (e.g. PageIndex with your own GPT API key)
on the client side.

Components API (``get_components``, ``set_components``, ``create_components``)
is always available for custom wiring and testing.
"""

from doc_search.config import get_config as _get_config


def _is_client_mode() -> bool:
    """Check if the package should operate in full-client (remote) mode.

    Client mode is used when:
    - deployment_mode is explicitly "client" or "hybrid", OR
    - deployment_mode is empty/unset AND server_url is configured (backward compat)

    In hybrid mode, the client runs locally configured backends (e.g. PageIndex)
    while delegating everything else to the remote server.
    """
    try:
        cfg = _get_config()
        mode = getattr(cfg, "deployment_mode", "")
        if mode in ("client", "hybrid"):
            return True
        if mode:  # "local" or any other explicit value → not client
            return False
        # Auto-detect: empty mode + server_url set → client (backward compat)
        return bool(getattr(cfg, "server_url", ""))
    except Exception:
        return False


if _is_client_mode():
    from doc_search.client import (
        init_doc,
        get_outline,
        get_pages,
        extract_elements,
        search_semantic,
        search_keyword,
    )
else:
    from doc_search.core import (
        init_doc,
        get_outline,
        get_pages,
        extract_elements,
        search_semantic,
        search_keyword,
    )

# Import components API after conditional imports to avoid circular import
# during package initialization.
from doc_search.components import create_components, get_components, set_components

__all__ = [
    "init_doc",
    "get_outline",
    "get_pages",
    "extract_elements",
    "search_semantic",
    "search_keyword",
    "get_components",
    "set_components",
    "create_components",
]
