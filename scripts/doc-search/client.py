"""HTTP client for doc_search server with local-first caching.

After init_doc uploads a PDF, page images are rendered locally from the PDF
file, and the full outline tree is stored from the server response.
Subsequent calls to get_pages, get_outline, and search_keyword are served
entirely from local cache without contacting the server.  Only
search_semantic (needs reranker model) and extract_elements (needs AgenticOCR)
require server round-trips.
"""

import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, List, Optional, Union

import requests

from doc_search.client_store import ClientDocStore
from doc_search.config import get_config
from doc_search.models import Element, Page, PreprocessingTimeoutError, ScoredPage
from doc_search.pdf_utils import parse_page_idxs, pdf_hash, pdf_to_page_images, crop_element_image, extract_native_outline, resolve_doc_path
from doc_search.tree_utils import resolve_outline, convert_indices_to_0based
from doc_search.utils import match_pattern_to_elements, text_from_elements

logger = logging.getLogger(__name__)

__all__ = [
    "DocSearchClient",
    "get_client",
    "init_doc",
    "get_outline",
    "get_pages",
    "extract_elements",
    "search_semantic",
    "search_keyword",
    "get_init_status",
]


class DocSearchClient:
    """Client that mirrors the core.py API, communicating with a doc_search server.

    All methods return the same types as core.py functions.
    File paths (image_path, crop_path) point to locally cached files.

    After init_doc, page images are rendered locally from the PDF, and the
    full outline tree is cached so get_pages, get_outline, and search_keyword
    work entirely offline.
    """

    def __init__(self, server_url: str, cache_root: str = None, api_key: str = None,
                 tree_builder=None):
        self.server_url = server_url.rstrip("/")
        self.api_base = f"{self.server_url}/api/v1"
        cfg = get_config()
        cache_root = cache_root or getattr(cfg, "client_cache_root", "./mineru_explorer_client_cache")
        self.store = ClientDocStore(cache_root)
        self._session = requests.Session()
        api_key = api_key or getattr(cfg, "client_api_key", "")
        if api_key:
            self._session.headers["Authorization"] = f"Bearer {api_key}"
        self._pdf_dpi = int(getattr(cfg, "client_pdf_dpi", 200))
        self._tree_builder = tree_builder

    # ------------------------------------------------------------------
    # HTTP helpers
    # ------------------------------------------------------------------

    def _request(self, method: str, path: str, timeout: float = None, **kwargs) -> dict:
        """Make an HTTP request and return the JSON response."""
        url = f"{self.api_base}{path}"
        if timeout is not None:
            kwargs.setdefault("timeout", timeout)
        resp = self._session.request(method, url, **kwargs)
        if resp.status_code >= 400:
            detail = ""
            try:
                detail = resp.json().get("detail", resp.text)
            except Exception:
                detail = resp.text
            raise RuntimeError(f"Server error {resp.status_code}: {detail}")
        return resp.json()

    def _download_file(self, url_path: str, local_path: str) -> str:
        """Download a file from the server and save it locally.

        Args:
            url_path: Relative URL path (e.g. /api/v1/files/doc_id/pages/page_0.png)
            local_path: Local filesystem path to save to.

        Returns the local_path.
        """
        if os.path.exists(local_path):
            return local_path

        url = f"{self.server_url}{url_path}"
        resp = self._session.get(url, stream=True)
        resp.raise_for_status()

        # Atomic write: download to temp then rename
        p = Path(local_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        with open(tmp, "wb") as f:
            for chunk in resp.iter_content(chunk_size=65536):
                f.write(chunk)
        tmp.replace(p)
        return local_path

    # ------------------------------------------------------------------
    # Resolve helpers
    # ------------------------------------------------------------------

    def _check_doc_exists(self, doc_id: str) -> bool:
        """Check if the server already has this document (HEAD request)."""
        try:
            url = f"{self.api_base}/docs/{doc_id}"
            resp = self._session.head(url)
            return resp.status_code == 200
        except Exception:
            return False

    def _init_by_id(self, doc_id: str, async_init: bool = False, **kwargs) -> dict:
        """Re-initialize an existing server doc by ID (no upload)."""
        return self._request("POST", "/init-by-id", json={
            "doc_id": doc_id, "async_init": async_init, **kwargs,
        })

    def _local_image_if_exists(self, doc_id: str, page_idx: int) -> Optional[str]:
        """Return local page image path if it exists, else None."""
        path = self.store.page_image_path(doc_id, page_idx)
        return path if os.path.exists(path) else None

    def _save_ocr_from_response(self, doc_id: str, page_data: dict) -> bool:
        """Save OCR elements from a server page response. Returns True if saved."""
        ocr_elements = page_data.get("ocr_elements")
        if ocr_elements is None:
            return False
        ocr_text = text_from_elements(ocr_elements)
        num_tokens = len(ocr_text) // 4 if ocr_text else 0
        self.store.save_page_ocr(
            doc_id, page_data["page_idx"], ocr_text, num_tokens,
            ocr_elements=ocr_elements,
        )
        return True

    def _ensure_doc_info(self, doc_id: str) -> dict:
        """Ensure doc_info is cached locally, fetching from server if needed.

        When using CLI --server without prior init_doc, fetches basic metadata
        from the server outline endpoint and the init endpoint.
        """
        info = self.store.load_doc_info(doc_id)
        if info is not None:
            return info
        # Fetch from server via outline endpoint (returns num_pages)
        resp = self._request("GET", f"/docs/{doc_id}/outline", params={
            "max_depth": 1, "root_node": "",
        })
        info = {
            "doc_id": doc_id,
            "doc_name": resp.get("doc_name", ""),
            "num_pages": resp.get("num_pages", 0),
            # Outline data not available via this fallback path;
            # get_outline will need to call server if these are None
            "tree_index": None,
            "native_outline": None,
        }
        self.store.save_doc_info(doc_id, info)
        return info

    def _get_num_pages(self, doc_id: str) -> int:
        """Get num_pages, fetching doc_info from server if not cached."""
        return self._ensure_doc_info(doc_id).get("num_pages", 0)

    def _resolve_page_idxs(self, doc_id: str, page_idxs) -> List[int]:
        """Resolve page indices using locally cached doc info."""
        return parse_page_idxs(page_idxs, self._get_num_pages(doc_id))

    # ------------------------------------------------------------------
    # Local rendering and outline helpers
    # ------------------------------------------------------------------

    def _run_local_tree_builder(self, pdf_path: str) -> Optional[dict]:
        """Build a PageIndex tree locally using the configured tree_builder."""
        try:
            result = self._tree_builder.build(pdf_path)
            if result is None:
                return None
            structure = result.get("structure", [])
            convert_indices_to_0based(structure)
            return {"doc_name": result.get("doc_name", ""), "structure": structure}
        except Exception:
            logger.warning("Local tree builder failed", exc_info=True)
            return None

    def _render_local_images(self, doc_path: str, doc_id: str) -> None:
        """Render page images locally from the PDF file."""
        pages_dir = self.store.pages_dir(doc_id)
        try:
            pdf_to_page_images(doc_path, pages_dir, dpi=self._pdf_dpi)
            logger.info("Rendered local page images for %s", doc_id)
        except Exception:
            logger.warning("Local page image rendering failed", exc_info=True)

    def _ensure_images(self, doc_id: str, page_indices: List[int]) -> None:
        """Ensure page images exist locally, rendering from PDF or fetching from server."""
        missing = [idx for idx in page_indices if not self.store.has_page_image(doc_id, idx)]
        if not missing:
            return
        # Try local PDF render first
        info = self._ensure_doc_info(doc_id)
        pdf_path = info.get("pdf_path")
        if pdf_path and os.path.isfile(pdf_path):
            try:
                pdf_to_page_images(pdf_path, self.store.pages_dir(doc_id), dpi=self._pdf_dpi)
                missing = [idx for idx in missing if not self.store.has_page_image(doc_id, idx)]
            except Exception:
                logger.debug("Local rendering fallback failed", exc_info=True)
        if not missing:
            return
        # Download directly from known URL pattern (avoids POST round-trip)
        for idx in missing:
            try:
                url_path = f"/api/v1/files/{doc_id}/pages/page_{idx}.png"
                self._download_file(url_path, self.store.page_image_path(doc_id, idx))
            except Exception:
                logger.debug("Failed to fetch image for page %d from server", idx, exc_info=True)

    def _prefetch_ocr(self, doc_id: str, num_pages: int) -> None:
        """Fetch OCR elements for all pages; derive text client-side to save bandwidth."""
        try:
            resp = self._request("POST", f"/docs/{doc_id}/pages", json={
                "page_idxs": "", "return_image": False, "return_text": False,
                "return_ocr_elements": True,
            })
            cached = sum(
                1 for p in resp.get("pages", [])
                if self._save_ocr_from_response(doc_id, p)
            )
            logger.info("Prefetched OCR for %d/%d pages of %s", cached, num_pages, doc_id)
        except Exception:
            logger.debug("OCR prefetch failed (non-fatal)", exc_info=True)

    def _ensure_ocr(self, doc_id: str, page_indices: List[int]) -> None:
        """Ensure OCR text is cached for all given pages, fetching from server if needed.

        Sends a single request with both return_text and return_ocr_elements.
        Prefers elements when available, falls back to text.

        During server init (init_status != "ready"), only fetches pages with no
        cache at all — pages with native text but no ocr_elements are NOT
        re-fetched, since the server likely doesn't have elements yet either.
        Once init is ready, stale native-text-only pages are also re-fetched.
        """
        info = self._ensure_doc_info(doc_id)
        init_ready = info.get("init_status", "ready") == "ready"

        if init_ready:
            # Server OCR should be done — re-fetch pages missing ocr_elements
            missing = [
                idx for idx in page_indices
                if (cached := self.store.load_page_ocr(doc_id, idx)) is None
                or cached.get("ocr_elements") is None
            ]
        else:
            # Init in progress — only fetch pages with no cache at all
            missing = [idx for idx in page_indices if self.store.load_page_ocr(doc_id, idx) is None]
        if not missing:
            return
        page_idxs_str = ",".join(str(i) for i in missing)
        try:
            resp = self._request("POST", f"/docs/{doc_id}/pages", json={
                "page_idxs": page_idxs_str, "return_image": False,
                "return_text": True, "return_ocr_elements": True,
            })
            for p in resp.get("pages", []):
                if self._save_ocr_from_response(doc_id, p):
                    continue
                # No elements — fall back to ocr_text from same response
                ocr_text = p.get("ocr_text")
                if ocr_text is not None:
                    # When init is ready, save ocr_elements=[] to mark
                    # "confirmed empty from server" so we don't re-fetch.
                    # When init is in progress, save without elements (None)
                    # so the page can be upgraded later.
                    confirmed_empty = [] if init_ready else None
                    self.store.save_page_ocr(
                        doc_id, p["page_idx"], ocr_text, p.get("num_tokens"),
                        ocr_elements=confirmed_empty,
                    )
        except Exception:
            logger.warning("Failed to fetch OCR for %d pages", len(missing), exc_info=True)

    # ------------------------------------------------------------------
    # Timeout helper
    # ------------------------------------------------------------------

    def _wait_if_initializing(self, doc_id: str, timeout: float, operation: str,
                              verbose: bool = False) -> None:
        """Wait for server preprocessing if document is still initializing.

        Raises PreprocessingTimeoutError with phase-specific context on timeout.
        Raises RuntimeError if the document does not exist on the server.
        When verbose=True, writes progress to stderr during wait.
        """
        info = self._ensure_doc_info(doc_id)
        if info.get("init_status") == "ready":
            return
        from doc_search.core.init import _build_timeout_reason
        from doc_search.models import PreprocessingTimeoutError

        # Track initial progress for accurate ETA calculation
        try:
            initial_status = self.get_init_status(doc_id)
        except RuntimeError as e:
            # Server returned 404 or other HTTP error — re-raise immediately
            # instead of masking as a timeout.
            if "404" in str(e):
                raise
            initial_status = {}
        except Exception:
            initial_status = {}
        start_done = initial_status.get("ocr_pages_done", 0)
        start_time = time.monotonic()

        try:
            self.wait_for_init(doc_id, timeout=timeout, verbose=verbose)
            # Update local cache
            info["init_status"] = "ready"
            self.store.save_doc_info(doc_id, info)
        except TimeoutError:
            status = self.get_init_status(doc_id)
            done = status.get("ocr_pages_done", 0)
            total = status.get("ocr_pages_total", 0)
            current_phase = status.get("current_phase", "ocr")

            reason = _build_timeout_reason(current_phase, done, total)

            # Compute ETA from progress observed during the wait period
            elapsed = time.monotonic() - start_time
            delta_done = done - start_done
            eta = None
            if current_phase == "ocr" and delta_done > 0 and total > done:
                rate = delta_done / elapsed
                eta = (total - done) / rate

            raise PreprocessingTimeoutError(
                reason=reason,
                progress={
                    "ocr_pages_done": done,
                    "ocr_pages_total": total,
                    "init_status": "initializing",
                    "current_phase": current_phase,
                },
                eta_seconds=eta,
                timeout=timeout,
                operation=operation,
            )

    # ------------------------------------------------------------------
    # Public API — same signatures as core.py
    # ------------------------------------------------------------------

    def init_doc(
        self,
        doc_path: str,
        enable_pageindex: bool = True,
        enable_embedding: bool = True,
        enable_mineru: bool = True,
        lazy_ocr: bool = False,
        force_pageindex: bool = False,
        timeout: float = None,
    ) -> Dict:
        """Upload PDF to server, then render images locally and cache outline.

        When a local tree_builder is configured, PageIndex is built locally
        instead of on the server.

        By default, async_init=True is sent to the server so that Phase 1
        (analyze + render) returns quickly while Phase 2 (OCR, embedding,
        PageIndex) runs in the background. The response includes
        ``init_status`` ("initializing" or "ready").
        """
        original_doc_path = doc_path
        doc_path = resolve_doc_path(doc_path, self.store.cache_root)

        # If we have a local tree builder, tell the server to skip PageIndex
        server_enable_pageindex = enable_pageindex if self._tree_builder is None else False
        server_force_pageindex = force_pageindex if self._tree_builder is None else False

        # Try to skip upload if server already has this document
        doc_id = pdf_hash(doc_path)

        # Start local PageIndex in parallel with server request (uses PDF directly).
        # Quick local check for native outline avoids a wasted LLM call when the
        # PDF already has bookmarks and force_pageindex is not set.
        tree_future = None
        tree_pool = None
        if self._tree_builder is not None and (enable_pageindex or force_pageindex):
            local_has_outline = not force_pageindex and bool(extract_native_outline(doc_path))
            if force_pageindex or not local_has_outline:
                tree_pool = ThreadPoolExecutor(max_workers=1)
                tree_future = tree_pool.submit(self._run_local_tree_builder, doc_path)

        resp = None
        if self._check_doc_exists(doc_id):
            try:
                resp = self._init_by_id(
                    doc_id,
                    async_init=True,
                    enable_pageindex=server_enable_pageindex,
                    enable_embedding=enable_embedding,
                    enable_mineru=enable_mineru,
                    lazy_ocr=lazy_ocr,
                    force_pageindex=server_force_pageindex,
                )
                logger.info("Skipped PDF upload — server already has %s", doc_id)
            except Exception:
                logger.debug("init-by-id failed, falling back to full upload", exc_info=True)
                resp = None

        # Fall back to full upload
        if resp is None:
            # Use a readable filename for URLs instead of the hash-based cache name
            if original_doc_path.startswith(("http://", "https://")):
                from doc_search.pdf_utils import url_doc_name
                upload_name = url_doc_name(original_doc_path)
            else:
                upload_name = os.path.basename(doc_path)
            with open(doc_path, "rb") as f:
                resp = self._request(
                    "POST", "/init",
                    files={"file": (upload_name, f, "application/pdf")},
                    data={
                        "enable_pageindex": str(server_enable_pageindex).lower(),
                        "enable_embedding": str(enable_embedding).lower(),
                        "enable_mineru": str(enable_mineru).lower(),
                        "lazy_ocr": str(lazy_ocr).lower(),
                        "force_pageindex": str(server_force_pageindex).lower(),
                        "async_init": "true",
                    },
                )

        doc_id = resp["doc_id"]
        num_pages = resp.get("num_pages", 0)

        # Page images are NOT rendered here — lazy-rendered on first access
        # via _ensure_images (called by get_pages / extract_elements).
        # OCR elements are also lazy — fetched via _ensure_ocr on first
        # keyword search or page text request.

        # Collect local PageIndex result
        local_pageindex_ok = False
        if tree_future is not None:
            has_native_outline = bool(resp.get("native_outline"))
            should_build = force_pageindex or (enable_pageindex and not has_native_outline)
            if should_build:
                tree_index = tree_future.result()
                if tree_index is not None:
                    resp["tree_index"] = tree_index
                    local_pageindex_ok = True
            tree_pool.shutdown(wait=False)

        # Merge local PageIndex into capabilities & strip stale warnings
        capabilities = dict(resp.get("capabilities", {}))
        resp_warnings = list(resp.get("warnings", []))
        if local_pageindex_ok:
            capabilities["has_pageindex"] = True
            resp_warnings = [
                w for w in resp_warnings
                if "PageIndex" not in w and "Outline browsing is unavailable" not in w
            ]

        # Return same format as core.init_doc
        result = {
            "doc_id": doc_id,
            "doc_name": resp.get("doc_name", ""),
            "num_pages": num_pages,
            "cache_dir": self.store.cache_dir(doc_id),
            "init_status": resp.get("init_status", "ready"),
            "capabilities": capabilities,
            "warnings": resp_warnings,
            # Preserve fields needed by downstream code (get_outline, _ensure_images)
            "tree_index": resp.get("tree_index"),
            "native_outline": resp.get("native_outline"),
            "pdf_path": doc_path,
        }

        # Wait for Phase 2 if not ready yet.
        # timeout=None → wait indefinitely; timeout=N → wait up to N seconds then return.
        if result["init_status"] != "ready":
            wait_timeout = timeout if timeout is not None else 86400.0
            try:
                self._wait_if_initializing(doc_id, wait_timeout, "init_doc")
                result["init_status"] = "ready"
            except PreprocessingTimeoutError:
                if timeout is None:
                    raise  # timeout=None means unlimited — should not happen, but propagate
                # Phase 2 still running — return current status instead of raising
                status = self.get_init_status(doc_id)
                result["init_status"] = status.get("init_status", "initializing")
                result["capabilities"] = status.get("capabilities", result.get("capabilities", {}))

        # Save the merged result as doc_info (not the raw server response)
        self.store.save_doc_info(doc_id, result)

        # Return only summary fields (internal fields stay in cache)
        summary_keys = ("doc_id", "doc_name", "num_pages", "init_status",
                        "capabilities", "warnings")
        return {k: result[k] for k in summary_keys if k in result}

    def get_init_status(self, doc_id: str) -> Dict:
        """Poll the server for document initialization status.

        Returns dict with init_status, ocr_pages_done, ocr_pages_total, capabilities.
        """
        return self._request("GET", f"/docs/{doc_id}/status")

    def wait_for_init(self, doc_id: str, poll_interval: float = 2.0,
                      timeout: float = 600.0, verbose: bool = False) -> Dict:
        """Block until the server finishes Phase 2 initialization.

        Returns the final status dict. Raises TimeoutError if timeout exceeded.
        When verbose=True, writes phase-aware progress to stderr.
        """
        import sys
        from doc_search.core.init import _phase_label

        deadline = time.monotonic() + timeout
        last_bucket = -1
        last_phase = None
        while True:
            status = self.get_init_status(doc_id)
            if verbose:
                current_phase = status.get("current_phase", "ocr")
                done = status.get("ocr_pages_done", 0)
                total = status.get("ocr_pages_total", 0)
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
                if verbose:
                    sys.stderr.write(f"\rPreprocessing complete.{' ' * 40}\n")
                    sys.stderr.flush()
                return status
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"init_doc Phase 2 did not complete within {timeout}s for {doc_id}"
                )
            time.sleep(poll_interval)

    def get_outline(self, doc_id: str, max_depth: int = 2, root_node: str = "",
                     timeout: float = None) -> Dict:
        """Get document outline — entirely local using cached outline data.

        The full tree_index and native_outline are stored during init_doc,
        so any max_depth / root_node combination is served locally via pruning.
        Falls back to server if outline data wasn't cached (e.g. CLI --server).
        """
        if timeout is not None:
            start = time.monotonic()
            self._wait_if_initializing(doc_id, timeout, "get_outline")
            timeout = max(timeout - (time.monotonic() - start), 1.0)

        info = self._ensure_doc_info(doc_id)

        tree_index = info.get("tree_index")
        native_outline = info.get("native_outline")

        # Fallback: if no outline data cached locally, fetch from server
        if tree_index is None and not native_outline:
            try:
                resp = self._request("GET", f"/docs/{doc_id}/outline", timeout=timeout, params={
                    "max_depth": max_depth, "root_node": root_node,
                })
                return {k: v for k, v in resp.items() if k != "status"}
            except Exception:
                pass

        return resolve_outline(
            tree_index=tree_index,
            native_outline=native_outline,
            doc_id=doc_id,
            doc_name=info.get("doc_name", ""),
            num_pages=info.get("num_pages", 0),
            max_depth=max_depth,
            root_node=root_node,
        )

    def get_pages(
        self,
        doc_id: str,
        page_idxs: Union[List[int], str] = "",
        return_image: bool = True,
        return_text: bool = False,
        timeout: float = None,
    ) -> Dict:
        """Get page data from local cache, fetching missing data on demand.

        Images and OCR text that were prefetched during init_doc are served
        instantly from local cache.  Any missing data is fetched from the
        server and cached for future calls.

        Returns dict with 'pages' (List[Page]) and 'warnings'.
        """
        if timeout is not None and return_text:
            self._wait_if_initializing(doc_id, timeout, "get_pages")

        resolved = self._resolve_page_idxs(doc_id, page_idxs)

        # Ensure requested data is cached locally (fetch from server on miss)
        if return_image:
            self._ensure_images(doc_id, resolved)
        if return_text:
            self._ensure_ocr(doc_id, resolved)

        # Build result entirely from local cache
        pages: List[Page] = []
        for idx in resolved:
            image_path = self._local_image_if_exists(doc_id, idx) if return_image else None

            ocr_text = None
            num_tokens = None
            if return_text:
                cached_ocr = self.store.load_page_ocr(doc_id, idx)
                if cached_ocr is not None:
                    ocr_text = cached_ocr.get("ocr_text")
                    num_tokens = cached_ocr.get("num_tokens")
                    if num_tokens is None and ocr_text:
                        num_tokens = len(ocr_text) // 4

            pages.append(Page(
                page_idx=idx,
                image_path=image_path,
                ocr_text=ocr_text,
                num_tokens=num_tokens,
            ))

        return {"pages": pages, "warnings": []}

    def search_semantic(
        self,
        doc_id: str,
        page_idxs: Union[List[int], str] = "",
        query: str = "",
        top_k: int = 3,
        return_image: bool = True,
        return_text: bool = False,
        timeout: float = None,
    ) -> Dict:
        """Search pages by visual relevance — requires server (reranker model).

        Results are cached.  Page images in results use local paths.
        """
        if timeout is not None:
            start = time.monotonic()
            self._wait_if_initializing(doc_id, timeout, "search_semantic")
            timeout = max(timeout - (time.monotonic() - start), 1.0)

        if isinstance(page_idxs, list):
            page_idxs_str = ",".join(str(i) for i in page_idxs)
        else:
            page_idxs_str = str(page_idxs)

        cache_key = self.store.search_cache_key(
            query, page_idxs_str, type="semantic", top_k=str(top_k),
        )
        cached = self.store.load_search_results(doc_id, cache_key)
        if cached is not None:
            result_idxs = [p["page_idx"] for p in cached.get("pages", [])]
            if return_image:
                self._ensure_images(doc_id, result_idxs)
            if return_text:
                self._ensure_ocr(doc_id, result_idxs)
            return self._build_search_result(
                doc_id, cached.get("pages", []), return_image, return_text,
                method=cached.get("method", "reranker"),
                warnings=cached.get("warnings", []),
            )

        # Must go to server for reranking — never request text/image (use local cache)
        resp = self._request("POST", f"/docs/{doc_id}/search/semantic", timeout=timeout, json={
            "page_idxs": page_idxs_str,
            "query": query,
            "top_k": top_k,
            "return_image": False,
            "return_text": False,
        })

        # Cache raw server response
        self.store.save_search_results(doc_id, cache_key, resp)

        # Ensure data is cached for result pages (no-op if already prefetched)
        result_idxs = [p["page_idx"] for p in resp.get("pages", [])]
        if return_image:
            self._ensure_images(doc_id, result_idxs)
        if return_text:
            self._ensure_ocr(doc_id, result_idxs)

        return self._build_search_result(
            doc_id, resp.get("pages", []), return_image, return_text,
            method=resp.get("method", ""),
            warnings=resp.get("warnings", []),
        )

    def search_keyword(
        self,
        doc_id: str,
        page_idxs: Union[List[int], str] = "",
        pattern: Union[str, List[str]] = "",
        return_image: bool = False,
        return_text: bool = False,
        timeout: float = None,
    ) -> Dict:
        """Search pages by regex pattern matching — runs entirely on local cached OCR.

        If OCR text is not yet cached for some pages, it is fetched from the
        server first (one batch request), then the regex search is performed
        locally.

        Returns matched OCR elements with bboxes and page_idx.
        """
        import re as _re
        from doc_search.core.search import normalize_pattern

        if timeout is not None:
            self._wait_if_initializing(doc_id, timeout, "search_keyword")

        resolved = self._resolve_page_idxs(doc_id, page_idxs)
        pattern = normalize_pattern(pattern)
        if not resolved or not pattern:
            return {"pages": [], "warnings": []}

        try:
            compiled = _re.compile(pattern, _re.IGNORECASE)
        except _re.error as e:
            raise ValueError(f"Invalid regex pattern: {e}")

        # Ensure all pages have OCR cached locally
        self._ensure_ocr(doc_id, resolved)
        if return_image:
            self._ensure_images(doc_id, resolved)

        # Perform regex matching locally
        matching: List[Page] = []
        warnings: List[str] = []
        native_fallback_count = 0
        has_native_text_count = 0
        ocr_done_count = 0

        for idx in resolved:
            cached_ocr = self.store.load_page_ocr(doc_id, idx)
            ocr_text = cached_ocr.get("ocr_text", "") if cached_ocr else ""
            ocr_elements = cached_ocr.get("ocr_elements") if cached_ocr else None
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
                image_path=self._local_image_if_exists(doc_id, idx) if return_image else None,
                ocr_text=ocr_text if return_text else None,
                num_tokens=len(ocr_text) // 4 if return_text and ocr_text else None,
                matched_elements=matched_elems,
            ))

        # OCR coverage warning — computed from loop data (no extra store reads)
        pages_without_ocr = len(resolved) - ocr_done_count

        if pages_without_ocr > 0:
            # Only query server progress when init is likely still running
            server_progress = ""
            info = self._ensure_doc_info(doc_id)
            if info.get("init_status") != "ready":
                try:
                    status = self.get_init_status(doc_id)
                    srv_done = status.get("ocr_pages_done", 0)
                    srv_total = status.get("ocr_pages_total", 0)
                    if srv_total > 0:
                        server_progress = f"server: {srv_done}/{srv_total} pages done, "
                    # Update local init_status if server reports ready
                    if status.get("init_status") == "ready":
                        info["init_status"] = "ready"
                        self.store.save_doc_info(doc_id, info)
                except Exception:
                    pass  # graceful degradation — skip server progress

            parts = [
                f"OCR processing in progress ({server_progress}local: {ocr_done_count}/{len(resolved)} searched pages ready)."
            ]
            if native_fallback_count > 0:
                parts.append(
                    f"{native_fallback_count} page(s) matched using native PDF text "
                    f"(no bounding box positions available)."
                )
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

    def extract_elements(
        self,
        doc_id: str,
        page_idxs: Union[List[int], str] = "",
        query: str = "",
        timeout: float = None,
    ) -> Dict:
        """Extract evidence elements — requires server (AgenticOCR).

        Results and crop images are cached locally.
        """
        if timeout is not None:
            start = time.monotonic()
            self._wait_if_initializing(doc_id, timeout, "extract_elements")
            timeout = max(timeout - (time.monotonic() - start), 1.0)

        if isinstance(page_idxs, list):
            page_idxs_str = ",".join(str(i) for i in page_idxs)
        else:
            page_idxs_str = str(page_idxs)

        cache_key = ClientDocStore.search_cache_key(query, page_idxs_str)
        cached = self.store.load_elements(doc_id, cache_key)
        if cached is not None:
            page_idxs_needed = list({e["page_idx"] for e in cached.get("elements", [])})
            if page_idxs_needed:
                self._ensure_images(doc_id, page_idxs_needed)
            return self._build_elements_result(doc_id, cached)

        resp = self._request("POST", f"/docs/{doc_id}/elements", timeout=timeout, json={
            "page_idxs": page_idxs_str,
            "query": query,
        })

        self.store.save_elements(doc_id, cache_key, resp)

        page_idxs_needed = list({e["page_idx"] for e in resp.get("elements", [])})
        if page_idxs_needed:
            self._ensure_images(doc_id, page_idxs_needed)

        return self._build_elements_result(doc_id, resp)

    # ------------------------------------------------------------------
    # Result builders
    # ------------------------------------------------------------------

    def _build_search_result(
        self, doc_id: str, pages_data: list,
        return_image: bool, return_text: bool,
        method: str, warnings: list,
    ) -> Dict:
        """Build semantic search result dict with local paths from cached/server data."""
        pages = []
        for p_data in pages_data:
            idx = p_data["page_idx"]

            image_path = self._local_image_if_exists(doc_id, idx) if return_image else None

            ocr_text = p_data.get("ocr_text") if return_text else None
            num_tokens = p_data.get("num_tokens") if return_text else None
            # If caller wants text but server didn't provide, try local cache
            if return_text and ocr_text is None:
                cached_ocr = self.store.load_page_ocr(doc_id, idx)
                if cached_ocr:
                    ocr_text = cached_ocr.get("ocr_text")
                    num_tokens = cached_ocr.get("num_tokens")

            pages.append(ScoredPage(
                page_idx=idx,
                image_path=image_path,
                ocr_text=ocr_text,
                num_tokens=num_tokens,
                score=p_data.get("score", 0.0),
            ))

        return {"pages": pages, "method": method, "warnings": warnings}

    def _build_elements_result(self, doc_id: str, resp: dict) -> Dict:
        """Build elements result dict, cropping element images locally from cached page images."""
        elements: List[Element] = []
        elements_dir = self.store.elements_dir(doc_id)
        for e_data in resp.get("elements", []):
            page_idx = e_data["page_idx"]
            bbox = e_data.get("bbox", [0, 0, 0, 0])

            # Crop locally from client-cached page image
            crop_path = None
            local_img = self._local_image_if_exists(doc_id, page_idx)
            if local_img:
                crop_path = crop_element_image(local_img, bbox, elements_dir, page_idx)

            elements.append(Element(
                page_idx=page_idx,
                bbox=bbox,
                content=e_data["content"],
                crop_path=crop_path,
                element_type=e_data.get("element_type", "evidence"),
            ))
        return {"elements": elements, "warnings": resp.get("warnings", [])}


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_client: Optional[DocSearchClient] = None


def get_client(server_url: str = None, cache_root: str = None, api_key: str = None) -> DocSearchClient:
    """Get or create a singleton DocSearchClient from config.

    When pageindex_model is configured, a local TreeBuilder is created
    automatically so PageIndex runs locally (e.g. with your own GPT API key)
    instead of on the remote server.
    """
    global _client
    if _client is None:
        cfg = get_config()
        server_url = server_url or getattr(cfg, "server_url", "")
        if not server_url:
            raise ValueError(
                "server_url not configured. Set DOC_SEARCH_SERVER_URL env var "
                "or server_url in config.yaml."
            )
        cache_root = cache_root or getattr(cfg, "client_cache_root", "./mineru_explorer_client_cache")
        api_key = api_key or getattr(cfg, "client_api_key", "")

        tree_builder = None
        try:
            from doc_search.backends.pageindex import create_tree_builder
            tree_builder = create_tree_builder(cfg)
        except Exception:
            pass

        _client = DocSearchClient(server_url, cache_root, api_key=api_key,
                                  tree_builder=tree_builder)
    return _client


# ---------------------------------------------------------------------------
# Module-level convenience functions (match core.py signatures)
# ---------------------------------------------------------------------------

def init_doc(doc_path, enable_pageindex=True, enable_embedding=True,
             enable_mineru=True, lazy_ocr=False, force_pageindex=False,
             timeout=None):
    return get_client().init_doc(
        doc_path, enable_pageindex=enable_pageindex,
        enable_embedding=enable_embedding, enable_mineru=enable_mineru,
        lazy_ocr=lazy_ocr, force_pageindex=force_pageindex, timeout=timeout,
    )


def get_outline(doc_id, max_depth=2, root_node="", timeout=None):
    return get_client().get_outline(doc_id, max_depth=max_depth, root_node=root_node,
                                    timeout=timeout)


def get_pages(doc_id, page_idxs="", return_image=True, return_text=False, timeout=None):
    return get_client().get_pages(doc_id, page_idxs, return_image=return_image,
                                  return_text=return_text, timeout=timeout)


def extract_elements(doc_id, page_idxs="", query="", timeout=None):
    return get_client().extract_elements(doc_id, page_idxs, query, timeout=timeout)


def search_semantic(doc_id, page_idxs="", query="", top_k=3, return_image=True,
                    return_text=False, timeout=None):
    return get_client().search_semantic(
        doc_id, page_idxs, query, top_k=top_k,
        return_image=return_image, return_text=return_text, timeout=timeout,
    )


def search_keyword(doc_id, page_idxs="", pattern="", return_image=False,
                   return_text=False, timeout=None):
    """pattern accepts a single regex string or a list of regex strings."""
    return get_client().search_keyword(
        doc_id, page_idxs, pattern,
        return_image=return_image, return_text=return_text, timeout=timeout,
    )


def get_init_status(doc_id):
    return get_client().get_init_status(doc_id)