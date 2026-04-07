"""CLI entry point: python -m doc_search <command> [args]"""

import argparse
import json
import logging
import sys
import threading


class WarningCollector(logging.Handler):
    """Logging handler that collects WARNING+ messages into a list.

    Thread-safe. Usable as a context manager.
    """

    def __init__(self):
        super().__init__(level=logging.WARNING)
        self._lock = threading.Lock()
        self.warnings: list = []

    def emit(self, record: logging.LogRecord):
        msg = self.format(record)
        with self._lock:
            self.warnings.append(msg)

    def __enter__(self):
        logging.getLogger().addHandler(self)
        return self

    def __exit__(self, *exc):
        logging.getLogger().removeHandler(self)


def _output(data: dict, compact: bool = False) -> None:
    """Print JSON to stdout."""
    if compact:
        print(json.dumps(data, ensure_ascii=False))
    else:
        print(json.dumps(data, ensure_ascii=False, indent=2))


def _error(msg: str, warnings: list = None) -> None:
    """Print error JSON and exit."""
    data = {"status": "error", "error": msg}
    if warnings:
        data["warnings"] = warnings
    _output(data)
    sys.exit(1)


def _serialize_pages(result: dict) -> dict:
    """Convert a result dict with Page/ScoredPage objects to JSON-safe dicts."""
    pages = result.get("pages", [])
    return {
        **result,
        "pages": [p.to_dict() for p in pages],
    }


def _get_adapter(args):
    """Return a DocSearchClient or the core module depending on config.

    Priority: CLI --server flag > deployment_mode > config.yaml server_url > local core.

    In hybrid mode, the client is used with locally configured backends
    (e.g. PageIndex) running on the client side.
    """
    server_url = getattr(args, "server", None)
    if not server_url:
        from doc_search.config import get_config
        cfg = get_config()
        mode = getattr(cfg, "deployment_mode", "")
        if mode in ("client", "hybrid"):
            server_url = getattr(cfg, "server_url", "") or None
        elif mode == "local":
            server_url = None
        else:
            # Auto-detect (backward compat): empty mode + server_url → client
            server_url = getattr(cfg, "server_url", "") or None
    if server_url:
        from doc_search.client import get_client
        return get_client(server_url=server_url)
    from doc_search import core
    return core


def _handle_timeout_error(e, warnings: list = None):
    """Format PreprocessingTimeoutError or OperationTimeoutError to stderr with reason and ETA."""
    from doc_search.models import PreprocessingTimeoutError, OperationTimeoutError
    if isinstance(e, (PreprocessingTimeoutError, OperationTimeoutError)):
        sys.stderr.write(f"\r{e}\n")
        sys.stderr.flush()
    all_warnings = list(warnings or [])
    all_warnings.append(str(e))
    _error(str(e), warnings=all_warnings)


def _cli_wait_for_preprocessing(adapter, doc_id, timeout):
    """Wait for preprocessing with verbose stderr progress.

    Delegates to core wait_for_preprocessing(verbose=True) for local mode,
    or to the client's _wait_if_initializing for remote mode.
    Returns the elapsed wait time in seconds so callers can compute the
    remaining timeout budget.
    """
    from doc_search.client import DocSearchClient
    from doc_search.core.init import wait_for_preprocessing

    if isinstance(adapter, DocSearchClient):
        # Client mode: use client's wait which polls the server
        import time
        start = time.monotonic()
        adapter._wait_if_initializing(doc_id, timeout, operation="cli",
                                      verbose=True)
        return time.monotonic() - start
    else:
        # Local mode: use core wait_for_preprocessing with verbose
        result = wait_for_preprocessing(
            doc_id, timeout=timeout, operation="cli", verbose=True,
        )
        return result.get("_elapsed", 0.0)


def cmd_init(args):
    with WarningCollector() as wc:
        try:
            api = _get_adapter(args)
            result = api.init_doc(
                doc_path=args.doc_path,
                enable_pageindex=not args.no_pageindex,
                enable_embedding=not args.no_embedding,
                enable_mineru=not args.no_mineru,
                lazy_ocr=args.lazy_ocr,
                force_pageindex=args.force_pageindex,
                timeout=args.timeout,
            )
            summary_keys = ("doc_id", "doc_name", "num_pages", "init_status",
                            "capabilities", "warnings")
            summary = {k: result[k] for k in summary_keys if k in result}
            merged = list(summary.get("warnings", [])) + wc.warnings
            summary["warnings"] = merged
            _output({"status": "ok", **summary}, compact=True)
        except Exception as e:
            _handle_timeout_error(e, warnings=wc.warnings)


def cmd_outline(args):
    with WarningCollector() as wc:
        try:
            api = _get_adapter(args)
            timeout = args.timeout
            elapsed = _cli_wait_for_preprocessing(api, args.doc_id, timeout)
            timeout = max(timeout - elapsed, 1.0)
            result = api.get_outline(args.doc_id, max_depth=args.max_depth,
                                     root_node=args.root_node, timeout=timeout)
            merged = list(result.get("warnings", [])) + wc.warnings
            result["warnings"] = merged
            _output({"status": "ok", **result})
        except Exception as e:
            _handle_timeout_error(e, warnings=wc.warnings)


def cmd_pages(args):
    with WarningCollector() as wc:
        try:
            api = _get_adapter(args)
            timeout = args.timeout
            if args.return_text:
                elapsed = _cli_wait_for_preprocessing(api, args.doc_id, timeout)
                timeout = max(timeout - elapsed, 1.0)
            result = api.get_pages(
                args.doc_id,
                args.page_idxs,
                return_image=not args.no_image,
                return_text=args.return_text,
                timeout=timeout,
            )
            serialized = _serialize_pages(result)
            merged = list(serialized.get("warnings", [])) + wc.warnings
            serialized["warnings"] = merged
            _output({"status": "ok", **serialized})
        except Exception as e:
            _handle_timeout_error(e, warnings=wc.warnings)


def cmd_elements(args):
    with WarningCollector() as wc:
        try:
            api = _get_adapter(args)
            timeout = args.timeout
            elapsed = _cli_wait_for_preprocessing(api, args.doc_id, timeout)
            timeout = max(timeout - elapsed, 1.0)
            result = api.extract_elements(args.doc_id, args.page_idxs, args.query,
                                          timeout=timeout)
            elements = result.get("elements", [])
            merged = list(result.get("warnings", [])) + wc.warnings
            _output({
                "status": "ok",
                "elements": [e.to_dict() for e in elements],
                "warnings": merged,
            })
        except Exception as e:
            _handle_timeout_error(e, warnings=wc.warnings)


def cmd_search(args):
    with WarningCollector() as wc:
        try:
            api = _get_adapter(args)
            timeout = args.timeout
            elapsed = _cli_wait_for_preprocessing(api, args.doc_id, timeout)
            timeout = max(timeout - elapsed, 1.0)
            result = api.search_semantic(
                args.doc_id,
                args.page_idxs,
                args.query,
                top_k=args.top_k,
                return_image=not args.no_image,
                return_text=args.return_text,
                timeout=timeout,
            )
            serialized = _serialize_pages(result)
            merged = list(serialized.get("warnings", [])) + wc.warnings
            serialized["warnings"] = merged
            _output({"status": "ok", **serialized})
        except Exception as e:
            _handle_timeout_error(e, warnings=wc.warnings)


def cmd_search_keywords(args):
    with WarningCollector() as wc:
        try:
            api = _get_adapter(args)
            timeout = args.timeout
            elapsed = _cli_wait_for_preprocessing(api, args.doc_id, timeout)
            timeout = max(timeout - elapsed, 1.0)
            result = api.search_keyword(
                args.doc_id,
                args.page_idxs,
                args.pattern,
                return_image=args.return_image and not args.no_image,
                return_text=args.return_text,
                timeout=timeout,
            )
            serialized = _serialize_pages(result)
            merged = list(serialized.get("warnings", [])) + wc.warnings
            serialized["warnings"] = merged
            _output({"status": "ok", **serialized})
        except Exception as e:
            _handle_timeout_error(e, warnings=wc.warnings)


def cmd_server(args):
    """Start the doc_search HTTP server."""
    from doc_search.server import run_server
    run_server(host=args.host, port=args.port)


def main():
    # Logging is configured after argument parsing (see below).

    parser = argparse.ArgumentParser(prog="doc_search", description="PDF smart reading tools")
    parser.add_argument("--server", default=None,
                        help="Server URL for remote mode (e.g. http://localhost:8080)")
    parser.add_argument("--timeout", type=float, default=120.0,
                        help="Seconds to wait for preprocessing to complete (default: 120)")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Enable verbose INFO logging to stderr")
    sub = parser.add_subparsers(dest="command", required=True)

    # server
    p_server = sub.add_parser("server", help="Start the doc_search HTTP server")
    p_server.add_argument("--host", default=None, help="Host to bind (default: from config)")
    p_server.add_argument("--port", type=int, default=None, help="Port to bind (default: from config)")
    p_server.set_defaults(func=cmd_server)

    # init
    p_init = sub.add_parser("init", help="Initialize a PDF document")
    p_init.add_argument("--doc_path", required=True,
                        help="Path to PDF file or HTTP(S) URL")
    p_init.add_argument("--no_pageindex", action="store_true",
                        help="Skip PageIndex tree building")
    p_init.add_argument("--no_embedding", action="store_true",
                        help="Skip embedding index building")
    p_init.add_argument("--no_mineru", action="store_true",
                        help="Skip MinerU OCR (use native text extraction)")
    p_init.add_argument("--lazy_ocr", action="store_true",
                        help="Defer OCR to on-demand execution instead of running during init")
    p_init.add_argument("--force_pageindex", action="store_true",
                        help="Force PageIndex tree building even when native PDF outline exists")
    p_init.set_defaults(func=cmd_init)

    # outline
    p_outline = sub.add_parser("outline", help="Get document outline")
    p_outline.add_argument("--doc_id", required=True, help="Document ID from init")
    p_outline.add_argument("--max_depth", type=int, default=2, help="Max tree depth")
    p_outline.add_argument("--root_node", default="", help="Root node_id for subtree (4-digit zero-padded, e.g. '0005')")
    p_outline.set_defaults(func=cmd_outline)

    # pages
    p_pages = sub.add_parser("pages", help="Get page images and/or OCR text")
    p_pages.add_argument("--doc_id", required=True, help="Document ID from init")
    p_pages.add_argument("--page_idxs", default="",
                         help="Page indices: comma-separated, ranges, negatives (e.g. '0,3-5,-1'). Empty = all pages.")
    p_pages.add_argument("--no_image", action="store_true",
                         help="Skip image paths (default: images returned)")
    p_pages.add_argument("--return_image", action="store_true",
                         help="Accepted for compatibility (images are already on by default)")
    p_pages.add_argument("--return_text", action="store_true",
                         help="Include OCR text in output (default: off)")
    p_pages.set_defaults(func=cmd_pages)

    # elements
    p_elements = sub.add_parser("elements", help="Extract evidence elements from pages")
    p_elements.add_argument("--doc_id", required=True, help="Document ID from init")
    p_elements.add_argument("--page_idxs", default="",
                            help="Page indices: comma-separated, ranges, negatives (e.g. '0,3-5,-1'). Empty = all pages.")
    p_elements.add_argument("--query", required=True, help="Query for element extraction")
    p_elements.set_defaults(func=cmd_elements)

    # search (reranker-based visual search)
    p_search = sub.add_parser("search-semantic", help="Search pages by visual relevance (reranker)")
    p_search.add_argument("--doc_id", required=True, help="Document ID from init")
    p_search.add_argument("--page_idxs", default="",
                          help="Page indices to search over (e.g. '0-9' or '0,1,5-10,-1'). Empty = all pages.")
    p_search.add_argument("--query", required=True, help="Natural language search query")
    p_search.add_argument("--top_k", type=int, default=3, help="Number of top results (default: 3)")
    p_search.add_argument("--no_image", action="store_true",
                          help="Skip image paths (default: images returned)")
    p_search.add_argument("--return_image", action="store_true",
                          help="Accepted for compatibility (images are already on by default)")
    p_search.add_argument("--return_text", action="store_true",
                          help="Include OCR text in output (default: off)")
    p_search.set_defaults(func=cmd_search)

    # search-keyword (regex-based OCR text search)
    p_kw = sub.add_parser("search-keyword", help="Search pages by regex pattern matching on OCR text")
    p_kw.add_argument("--doc_id", required=True, help="Document ID from init")
    p_kw.add_argument("--page_idxs", default="",
                      help="Page indices to search over (e.g. '0-9' or '0,1,5-10,-1'). Empty = all pages.")
    p_kw.add_argument("--pattern", required=True, action="append",
                      help="Regex pattern to match (case-insensitive). Can be specified multiple times. "
                           "E.g. --pattern 'Fig\\.' --pattern 'Table\\s+\\d+'")
    p_kw.add_argument("--return_image", action="store_true",
                      help="Include image paths (default: no images)")
    p_kw.add_argument("--no_image", action="store_true",
                      help="Accepted for compatibility (images are already off by default)")
    p_kw.add_argument("--return_text", action="store_true",
                      help="Include full OCR text in output (default: off)")
    p_kw.set_defaults(func=cmd_search_keywords)

    args = parser.parse_args()

    # Logs go to stderr so stdout stays clean JSON
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    args.func(args)


if __name__ == "__main__":
    main()
