"""FastAPI server wrapping doc_search core API."""

import asyncio
import logging
import os
import re
import shutil
import tempfile
from functools import partial
from pathlib import Path
from typing import Dict, List, Optional, Union

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from starlette.middleware.gzip import GZipMiddleware

from doc_search.components import get_components
from doc_search.config import get_config
from doc_search.core import (
    init_doc,
    run_init_phase2,
    get_outline,
    get_pages,
    extract_elements,
    search_semantic,
    search_keyword,
)
from doc_search.core.pages import get_or_run_ocr

logger = logging.getLogger(__name__)

app = FastAPI(title="doc_search", version="0.1.0")
app.add_middleware(GZipMiddleware, minimum_size=500)


@app.middleware("http")
async def normalize_path(request: Request, call_next):
    """Collapse duplicate slashes in the URL path (e.g. //api/v1/... → /api/v1/...)."""
    raw = request.scope["path"]
    cleaned = re.sub(r"/+", "/", raw)
    if cleaned != raw:
        request.scope["path"] = cleaned
    return await call_next(request)


@app.middleware("http")
async def verify_api_key(request: Request, call_next):
    """Verify Bearer token on all endpoints except /health."""
    if request.url.path == "/api/v1/health":
        return await call_next(request)
    api_key = get_config().server_api_key
    if api_key:
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {api_key}":
            return JSONResponse(status_code=401, content={"detail": "Invalid or missing API key"})
    return await call_next(request)


# ---------------------------------------------------------------------------
# Background init task tracking
# ---------------------------------------------------------------------------

_init_tasks: Dict[str, asyncio.Task] = {}
_init_progress: Dict[str, dict] = {}


# ---------------------------------------------------------------------------
# Pydantic request/response models
# ---------------------------------------------------------------------------

class InitByIdRequest(BaseModel):
    doc_id: str
    enable_pageindex: bool = True
    enable_embedding: bool = True
    enable_mineru: bool = True
    lazy_ocr: bool = False
    force_pageindex: bool = False
    async_init: bool = False


class PagesRequest(BaseModel):
    page_idxs: str = ""
    return_image: bool = True
    return_text: bool = False
    return_ocr_elements: bool = False


class SemanticSearchRequest(BaseModel):
    page_idxs: str = ""
    query: str
    top_k: int = 3
    return_image: bool = True
    return_text: bool = False


class KeywordSearchRequest(BaseModel):
    page_idxs: str = ""
    pattern: Union[str, List[str]]
    return_image: bool = False
    return_text: bool = False


class ElementsRequest(BaseModel):
    page_idxs: str = ""
    query: str


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def _cache_root() -> str:
    return os.path.abspath(get_config().server_cache_root)


def _uploads_dir() -> str:
    d = os.path.join(_cache_root(), "_uploads")
    os.makedirs(d, exist_ok=True)
    return d


def _path_to_url(file_path: Optional[str], doc_id: str) -> Optional[str]:
    """Convert an absolute cache file path to a relative URL for the /files endpoint."""
    if file_path is None:
        return None
    root = _cache_root()
    try:
        rel = os.path.relpath(file_path, root)
    except ValueError:
        return None
    # Ensure the path is under {cache_root}/{doc_id}/
    if rel.startswith(".."):
        return None
    return f"/api/v1/files/{rel}"


def _transform_page_dict(page_dict: dict, doc_id: str) -> dict:
    """Replace image_path with image_url in a serialized page dict."""
    d = dict(page_dict)
    if "image_path" in d:
        d["image_url"] = _path_to_url(d.pop("image_path"), doc_id)
    return d


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/api/v1/health")
async def health():
    return {"status": "ok"}


@app.head("/api/v1/docs/{doc_id}")
@app.get("/api/v1/docs/{doc_id}")
def api_doc_exists(doc_id: str):
    """Check whether a document exists on the server. Returns 200 or 404."""
    store = get_components().store
    if not store.has_doc(doc_id):
        raise HTTPException(status_code=404, detail="Document not found")
    return {"status": "ok", "doc_id": doc_id}


@app.post("/api/v1/init-by-id")
async def api_init_by_id(req: InitByIdRequest):
    """Re-initialize an already-uploaded document (capability upgrade, no file upload)."""
    store = get_components().store
    info = store.load_doc_info(req.doc_id)
    if info is None:
        raise HTTPException(status_code=404, detail="Document not found; upload required")

    try:
        result = await asyncio.to_thread(
            partial(
                init_doc,
                doc_path=info.pdf_path,
                enable_pageindex=req.enable_pageindex,
                enable_embedding=req.enable_embedding,
                enable_mineru=req.enable_mineru,
                lazy_ocr=req.lazy_ocr,
                force_pageindex=req.force_pageindex,
                _async=req.async_init,
            )
        )

        if req.async_init and result.get("init_status") == "initializing":
            _launch_phase2(req.doc_id, req.enable_pageindex, req.enable_embedding,
                           req.enable_mineru, req.lazy_ocr, req.force_pageindex)

        # Refresh info after potential upgrade
        info = store.load_doc_info(req.doc_id)
        if info:
            result["tree_index"] = info.tree_index
            result["native_outline"] = info.native_outline

        return {"status": "ok", **result}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("init-by-id failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/init")
async def api_init(
    file: UploadFile = File(...),
    enable_pageindex: bool = Form(True),
    enable_embedding: bool = Form(True),
    enable_mineru: bool = Form(True),
    lazy_ocr: bool = Form(False),
    force_pageindex: bool = Form(False),
    async_init: bool = Form(False),
):
    """Upload a PDF and initialize it."""
    # Save uploaded file to a temp location, then move to uploads dir
    try:
        suffix = Path(file.filename or "upload.pdf").suffix or ".pdf"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            shutil.copyfileobj(file.file, tmp)
            tmp_path = tmp.name
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to save upload: {e}")
    finally:
        await file.close()

    try:
        # Run init in a thread — init_doc (and its backends) call asyncio.run()
        # internally, which cannot nest inside uvicorn's running event loop.
        result = await asyncio.to_thread(
            partial(
                init_doc,
                doc_path=tmp_path,
                doc_name=file.filename or "upload.pdf",
                enable_pageindex=enable_pageindex,
                enable_embedding=enable_embedding,
                enable_mineru=enable_mineru,
                lazy_ocr=lazy_ocr,
                force_pageindex=force_pageindex,
                _async=async_init,
            )
        )
        doc_id = result["doc_id"]

        # Move uploaded PDF to permanent location for re-init / capability upgrades
        upload_path = os.path.join(_uploads_dir(), f"{doc_id}.pdf")
        if not os.path.exists(upload_path):
            shutil.move(tmp_path, upload_path)
        else:
            os.unlink(tmp_path)

        # Update pdf_path in doc_info to point to the permanent upload
        store = get_components().store
        info = store.load_doc_info(doc_id)
        if info and info.pdf_path != upload_path:
            info.pdf_path = upload_path
            store.save_doc_info(info)

        # Launch Phase 2 in background if async
        if async_init and result.get("init_status") == "initializing":
            _launch_phase2(doc_id, enable_pageindex, enable_embedding,
                           enable_mineru, lazy_ocr, force_pageindex)

        # Include full outline data so client can prune locally
        if info:
            result["tree_index"] = info.tree_index
            result["native_outline"] = info.native_outline

        return {"status": "ok", **result}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # Clean up temp file on failure
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        logger.exception("init failed")
        raise HTTPException(status_code=500, detail=str(e))


def _launch_phase2(doc_id: str, enable_pageindex: bool, enable_embedding: bool,
                    enable_mineru: bool, lazy_ocr: bool, force_pageindex: bool):
    """Launch Phase 2 as an asyncio background task."""
    if doc_id in _init_tasks and not _init_tasks[doc_id].done():
        return  # already running

    _init_progress[doc_id] = {"stage": "starting", "ocr_pages_done": 0, "ocr_pages_total": 0}

    def progress_cb(stage, done, total):
        if doc_id in _init_progress:
            if stage == "ocr":
                _init_progress[doc_id]["ocr_pages_done"] = done
                _init_progress[doc_id]["ocr_pages_total"] = total
            _init_progress[doc_id]["stage"] = stage

    async def _run():
        try:
            await asyncio.to_thread(
                partial(
                    run_init_phase2,
                    doc_id=doc_id,
                    enable_pageindex=enable_pageindex,
                    enable_embedding=enable_embedding,
                    enable_mineru=enable_mineru,
                    lazy_ocr=lazy_ocr,
                    force_pageindex=force_pageindex,
                    progress_callback=progress_cb,
                )
            )
            logger.info("Background Phase 2 complete for %s", doc_id)
        except Exception:
            logger.exception("Background Phase 2 failed for %s", doc_id)
        finally:
            _init_tasks.pop(doc_id, None)
            _init_progress.pop(doc_id, None)

    _init_tasks[doc_id] = asyncio.create_task(_run())


@app.get("/api/v1/docs/{doc_id}/status")
def api_doc_status(doc_id: str):
    """Return initialization status, OCR progress, and phase-level breakdown."""
    from doc_search.core.init import get_init_status as core_get_init_status
    try:
        status = core_get_init_status(doc_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Document not found")

    # Merge in-memory server progress if Phase 2 is still running
    progress = _init_progress.get(doc_id)
    if progress and progress.get("ocr_pages_done", 0) > status.get("ocr_pages_done", 0):
        status["ocr_pages_done"] = progress["ocr_pages_done"]

    return {"status": "ok", "doc_id": doc_id, **status}


@app.get("/api/v1/docs/{doc_id}/outline")
def api_outline(doc_id: str, max_depth: int = 2, root_node: str = ""):
    try:
        result = get_outline(doc_id, max_depth=max_depth, root_node=root_node)
        return {"status": "ok", **result}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/v1/docs/{doc_id}/pages")
def api_pages(doc_id: str, req: PagesRequest):
    try:
        result = get_pages(
            doc_id,
            req.page_idxs,
            return_image=req.return_image,
            return_text=req.return_text,
        )
        pages = []
        for p in result["pages"]:
            d = _transform_page_dict(p.to_dict(), doc_id) if req.return_image else p.to_dict()
            if not req.return_image:
                d.pop("image_path", None)
            if req.return_ocr_elements:
                store = get_components().store
                ocr_full = get_or_run_ocr(doc_id, p.page_idx, store)
                d["ocr_elements"] = ocr_full.get("ocr_elements")
            # Suppress redundant ocr_text when elements are present
            if d.get("ocr_elements"):
                d.pop("ocr_text", None)
                d.pop("num_tokens", None)
            # Skip pages that carry no useful payload (only page_idx)
            if set(d.keys()) - {"page_idx"}:
                pages.append(d)
        return {
            "status": "ok",
            "pages": pages,
            "warnings": result.get("warnings", []),
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/v1/docs/{doc_id}/search/semantic")
def api_search_semantic(doc_id: str, req: SemanticSearchRequest):
    try:
        result = search_semantic(
            doc_id,
            req.page_idxs,
            req.query,
            top_k=req.top_k,
            return_image=req.return_image,
            return_text=req.return_text,
        )
        pages = []
        for p in result["pages"]:
            if req.return_image:
                d = _transform_page_dict(p.to_dict(), doc_id)
            else:
                d = p.to_dict()
                d.pop("image_path", None)
            pages.append(d)
        return {
            "status": "ok",
            "pages": pages,
            "method": result.get("method", ""),
            "warnings": result.get("warnings", []),
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/v1/docs/{doc_id}/search/keyword")
def api_search_keyword(doc_id: str, req: KeywordSearchRequest):
    try:
        result = search_keyword(
            doc_id,
            req.page_idxs,
            req.pattern,
            return_image=req.return_image,
            return_text=req.return_text,
        )
        pages = []
        for p in result["pages"]:
            if req.return_image:
                d = _transform_page_dict(p.to_dict(), doc_id)
            else:
                d = p.to_dict()
                d.pop("image_path", None)
            pages.append(d)
        return {
            "status": "ok",
            "pages": pages,
            "warnings": result.get("warnings", []),
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/v1/docs/{doc_id}/elements")
def api_elements(doc_id: str, req: ElementsRequest):
    try:
        result = extract_elements(doc_id, req.page_idxs, req.query, generate_crop=False)
        elements = [e.to_dict() for e in result["elements"]]
        return {
            "status": "ok",
            "elements": elements,
            "warnings": result.get("warnings", []),
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/v1/files/{file_path:path}")
async def api_files(file_path: str):
    """Serve cached files (page images, crop images, etc.).

    Path traversal protection: resolved path must stay within cache_root.
    """
    root = _cache_root()
    full_path = os.path.realpath(os.path.join(root, file_path))

    # Security: ensure resolved path is under cache_root
    if not full_path.startswith(os.path.realpath(root) + os.sep) and full_path != os.path.realpath(root):
        raise HTTPException(status_code=403, detail="Access denied")

    if not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(full_path)


# ---------------------------------------------------------------------------
# Server runner
# ---------------------------------------------------------------------------

def run_server(host: str = None, port: int = None):
    """Start the uvicorn server."""
    import uvicorn

    cfg = get_config()
    host = host or getattr(cfg, "server_host", "0.0.0.0")
    port = port or getattr(cfg, "server_port", 8080)
    uvicorn.run(app, host=host, port=int(port))
