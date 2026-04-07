"""Configuration loader for doc_search.

Loads defaults from config.yaml, with environment variable overrides.
Env vars: DOC_SEARCH_<UPPER_KEY>, e.g. DOC_SEARCH_CACHE_ROOT.
"""

import os
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any, Dict

import yaml

__all__ = ["DocSearchConfig", "load_config", "get_config"]


_CONFIG_DIR = Path(__file__).parent
_DEFAULT_CONFIG_PATH = _CONFIG_DIR / "config.yaml"


@dataclass
class DocSearchConfig:
    """Typed configuration for doc_search.

    Every field can be set via YAML config or env var ``DOC_SEARCH_<UPPER_KEY>``.
    """

    # Core
    deployment_mode: str = ""  # "local", "hybrid", "client", or "" (auto-detect)
    server_cache_root: str = ""
    client_pdf_dpi: int = 200        # client-side rendering DPI (for display)
    server_pdf_dpi: int = 150        # server-side rendering DPI (for models only)

    # PageIndex tree builder
    pageindex_model: str = "gpt-4.1-mini"
    pageindex_add_summary: str = "no"
    pageindex_api_key: str = ""
    pageindex_base_url: str = ""

    # MinerU OCR (cloud SDK)
    mineru_api_token: str = ""
    mineru_model: str = "vlm"       # "vlm" | "pipeline"
    mineru_language: str = "ch"     # "ch" | "en"
    mineru_timeout: int = 600       # extraction timeout (seconds)

    # Extractor LLM (AgenticOCR)
    extractor_model_name: str = ""
    extractor_base_url: str = ""
    extractor_api_key: str = ""
    extractor_max_image_size: int = 2048
    extractor_max_model_len: int = 16384
    extractor_tool_image_max_side: int = 1024
    extractor_max_parallel_pages: int = 4

    # Reranker
    reranker_api_base: str = ""

    # Embedding (FAISS recall)
    embedding_api_base: str = ""
    embedding_batch_size: int = 8
    embedding_recall_k: int = 20

    # Server
    server_host: str = "0.0.0.0"
    server_port: int = 8080
    server_api_key: str = "sk-123456"

    # Client
    server_url: str = ""
    client_api_key: str = ""
    client_cache_root: str = "./mineru_explorer_client_cache"

    # Extra keys from YAML that aren't declared above (forward compat).
    _extra: Dict[str, Any] = field(default_factory=dict, repr=False)

    def __getattr__(self, name: str) -> Any:
        """Fall back to _extra for undeclared config keys."""
        extra = object.__getattribute__(self, "_extra")
        if name in extra:
            return extra[name]
        raise AttributeError(f"DocSearchConfig has no attribute {name!r}")


def load_config(config_path: str = None) -> DocSearchConfig:
    """Load config from YAML file with env var overrides."""
    path = Path(config_path) if config_path else _DEFAULT_CONFIG_PATH
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            raw = yaml.safe_load(f) or {}
    else:
        raw = {}

    # Apply env var overrides: DOC_SEARCH_SERVER_CACHE_ROOT → server_cache_root
    for key in list(raw.keys()):
        env_key = f"DOC_SEARCH_{key.upper()}"
        env_val = os.environ.get(env_key)
        if env_val is not None:
            try:
                raw[key] = int(env_val)
            except ValueError:
                raw[key] = env_val

    # Also check env vars for declared fields not present in YAML
    declared = {f.name for f in fields(DocSearchConfig) if f.name != "_extra"}
    for fname in declared:
        if fname not in raw:
            env_key = f"DOC_SEARCH_{fname.upper()}"
            env_val = os.environ.get(env_key)
            if env_val is not None:
                try:
                    raw[fname] = int(env_val)
                except ValueError:
                    raw[fname] = env_val

    # Split known vs unknown keys
    known_fields = declared
    known = {k: v for k, v in raw.items() if k in known_fields}
    extra = {k: v for k, v in raw.items() if k not in known_fields}

    cfg = DocSearchConfig(**known, _extra=extra)

    # MINERU_TOKEN env var fallback (matching SDK convention)
    if not cfg.mineru_api_token:
        token = os.environ.get("MINERU_TOKEN", "")
        if token:
            cfg.mineru_api_token = token

    # Resolve cache paths relative to the package directory (not CWD)
    config_dir = path.parent.resolve()
    for attr, default_name in [("server_cache_root", "mineru_explorer_cache"),
                               ("client_cache_root", "mineru_explorer_client_cache")]:
        val = getattr(cfg, attr)
        if not val:
            setattr(cfg, attr, str(config_dir / default_name))
        elif not Path(val).is_absolute():
            setattr(cfg, attr, str(config_dir / val))

    return cfg


# Singleton config loaded on first access
_config: DocSearchConfig = None


def get_config() -> DocSearchConfig:
    global _config
    if _config is None:
        _config = load_config()
    return _config
