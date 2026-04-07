"""PDF utility functions: hashing, page image conversion, scanned detection, native outline."""

import base64
import hashlib
import logging
import mimetypes
import os
import re
import tempfile
import urllib.request
from typing import List, Optional, Union

logger = logging.getLogger(__name__)

from doc_search.tree_utils import _toc_to_tree  # noqa: F401 — used by extract_native_outline

__all__ = [
    "parse_page_idxs",
    "pdf_hash",
    "pdf_to_page_images",
    "detect_scanned_pdf",
    "extract_native_outline",
    "analyze_pdf",
    "crop_element_image",
    "local_image_to_data_url",
    "resolve_doc_path",
    "url_doc_name",
]


def local_image_to_data_url(
    path: str, max_long_edge: int = 0, jpeg_quality: int = 85
) -> str:
    """Convert a local image file to a Base64 Data URL.

    Args:
        path: Path to the image file.
        max_long_edge: When > 0, resize so the long edge does not exceed this
            value and re-encode as JPEG.  When 0 (default), the original file
            bytes are used as-is (backward compatible).
        jpeg_quality: JPEG quality (1-100) used when *max_long_edge* > 0.
    """
    if not os.path.exists(path):
        raise FileNotFoundError(path)

    if max_long_edge > 0:
        import io
        from PIL import Image

        with Image.open(path) as img:
            w, h = img.size
            long_edge = max(w, h)
            if long_edge > max_long_edge:
                scale = max_long_edge / long_edge
                img = img.resize(
                    (int(w * scale), int(h * scale)), Image.LANCZOS
                )
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=jpeg_quality)
            b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
        return f"data:image/jpeg;base64,{b64}"

    mime, _ = mimetypes.guess_type(path)
    if mime is None:
        mime = "image/png"

    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("utf-8")

    return f"data:{mime};base64,{b64}"


def crop_element_image(
    image_path: str,
    bbox: List[int],
    output_dir: str,
    page_idx: int,
) -> Optional[str]:
    """Crop an element region from a page image using 0-1000 normalized bbox.

    Args:
        image_path: Path to the full page image.
        bbox: [x1, y1, x2, y2] in 0-1000 normalized coordinates.
        output_dir: Directory to save the cropped image.
        page_idx: Page index (used in output filename).

    Returns:
        Path to the cropped image file, or None on failure.
    """
    if not isinstance(bbox, list) or len(bbox) != 4:
        return None
    if bbox == [0, 0, 0, 0]:
        return None

    try:
        import uuid
        from PIL import Image

        with Image.open(image_path) as img:
            img_w, img_h = img.size
            x1 = max(0, int(bbox[0] / 1000 * img_w))
            y1 = max(0, int(bbox[1] / 1000 * img_h))
            x2 = min(img_w, int(bbox[2] / 1000 * img_w))
            y2 = min(img_h, int(bbox[3] / 1000 * img_h))

            if x2 <= x1 or y2 <= y1:
                return None

            cropped = img.crop((x1, y1, x2, y2))
            os.makedirs(output_dir, exist_ok=True)
            fname = f"page_{page_idx}_{uuid.uuid4().hex[:8]}.jpg"
            crop_path = os.path.join(output_dir, fname)
            cropped.save(crop_path)
            return crop_path
    except Exception:
        logger.warning("Failed to crop element from page %d", page_idx)
        return None


def parse_page_idxs(page_idxs: Union[List[int], str], num_pages: int) -> List[int]:
    """Parse flexible page index specifications into a deduplicated list of 0-indexed ints.

    Supports:
        - List of ints: [0, 1, -1] (negative = from end, -1 = last page)
        - String: "0,3-5,-1" (comma-separated, ranges with "-")

    Raises ValueError on invalid tokens or out-of-bounds indices.
    """
    if isinstance(page_idxs, list):
        tokens_raw = page_idxs
    elif isinstance(page_idxs, str):
        tokens_raw = [t.strip() for t in page_idxs.split(",") if t.strip()]
    else:
        raise TypeError(f"page_idxs must be list or str, got {type(page_idxs).__name__}")

    if not tokens_raw:
        return list(range(num_pages))

    result: List[int] = []
    seen: set = set()
    range_re = re.compile(r"^(-?\d+)(?:-(-?\d+))?$")

    for token in tokens_raw:
        token_str = str(token).strip()
        m = range_re.match(token_str)
        if not m:
            raise ValueError(f"Invalid page index token: {token_str!r}")

        start = int(m.group(1))
        end_str = m.group(2)

        # Resolve negative indices
        if start < 0:
            start = num_pages + start
        if end_str is not None:
            end = int(end_str)
            if end < 0:
                end = num_pages + end
            indices = range(start, end + 1)
        else:
            indices = [start]

        for idx in indices:
            if idx < 0 or idx >= num_pages:
                raise ValueError(f"Page index {idx} out of range [0, {num_pages})")
            if idx not in seen:
                seen.add(idx)
                result.append(idx)

    return result


def resolve_doc_path(doc_path: str, cache_root: str = "") -> str:
    """Resolve *doc_path* to a local file path, downloading if it's a URL.

    For local paths, validates existence and returns the absolute path.
    For ``http://`` / ``https://`` URLs, downloads the PDF into
    ``{cache_root}/_downloads/`` (or a temp dir if *cache_root* is empty)
    keyed by a hash of the URL so the same URL is not re-downloaded.

    Returns ``(local_path, original_name)`` as a tuple-like string — but
    actually just the local path.  Use :func:`url_basename` separately
    if you need the display name.

    Returns the absolute local file path.
    """
    if not doc_path.startswith(("http://", "https://")):
        p = os.path.abspath(doc_path)
        if not os.path.isfile(p):
            raise FileNotFoundError(f"PDF not found: {p}")
        return p

    url_hash = hashlib.sha256(doc_path.encode()).hexdigest()[:16]
    if cache_root:
        download_dir = os.path.join(os.path.abspath(cache_root), "_downloads")
    else:
        download_dir = os.path.join(tempfile.gettempdir(), "doc_search_downloads")
    os.makedirs(download_dir, exist_ok=True)
    local_path = os.path.join(download_dir, f"{url_hash}.pdf")

    if os.path.isfile(local_path):
        logger.info("URL already downloaded: %s -> %s", doc_path, local_path)
        return local_path

    logger.info("Downloading PDF from %s ...", doc_path)
    # Use PID in temp name to avoid races between concurrent processes
    tmp = f"{local_path}.{os.getpid()}.tmp"
    try:
        req = urllib.request.Request(doc_path, headers={"User-Agent": "doc-search/1.0"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            with open(tmp, "wb") as f:
                while True:
                    chunk = resp.read(1 << 20)  # 1 MB
                    if not chunk:
                        break
                    f.write(chunk)
        # Validate the downloaded file looks like a PDF
        with open(tmp, "rb") as f:
            header = f.read(8)
        if not header.startswith(b"%PDF"):
            raise RuntimeError(
                f"Downloaded file from {doc_path} is not a valid PDF "
                f"(starts with {header[:20]!r})"
            )
        os.replace(tmp, local_path)
    except Exception as e:
        if os.path.exists(tmp):
            os.unlink(tmp)
        if isinstance(e, RuntimeError):
            raise
        raise RuntimeError(f"Failed to download PDF from {doc_path}: {e}") from e

    return local_path


def url_doc_name(url: str) -> str:
    """Extract a human-readable document name from a URL.

    Falls back to the last path segment, stripped of query strings.
    """
    from urllib.parse import urlparse, unquote
    path = urlparse(url).path.rstrip("/")
    name = unquote(path.rsplit("/", 1)[-1]) if path else ""
    if not name or name == "/":
        return url.split("//", 1)[-1][:60]
    # Ensure it ends with .pdf for clarity
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    return name


def pdf_hash(pdf_path: str) -> str:
    """Compute SHA-256 hash of a PDF file, return first 16 hex chars."""
    h = hashlib.sha256()
    with open(pdf_path, "rb") as f:
        while True:
            chunk = f.read(1 << 20)  # 1 MB
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()[:16]


_MAX_IMAGE_DIMENSION = 2000  # cap rendered page images to this many pixels per side


def _render_page_chunk(pdf_path: str, output_dir: str, dpi: int, start: int, end: int) -> int:
    """Render pages [start, end) from a PDF to PNG images. Top-level for pickling.

    Each worker opens its own PyMuPDF document to avoid thread-safety issues.
    Returns the number of pages rendered.
    """
    import pymupdf

    doc = pymupdf.open(pdf_path)
    actual_end = min(end, len(doc))
    for i in range(start, actual_end):
        page = doc[i]
        scale = dpi / 72.0
        w = page.rect.width * scale
        h = page.rect.height * scale
        if w > _MAX_IMAGE_DIMENSION or h > _MAX_IMAGE_DIMENSION:
            scale *= min(_MAX_IMAGE_DIMENSION / w, _MAX_IMAGE_DIMENSION / h)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale))
        save_path = os.path.join(output_dir, f"page_{i}.png")
        pix.save(save_path)
    doc.close()
    return actual_end - start


# Threshold: use parallel rendering only for PDFs with more than this many pages
_PARALLEL_PAGE_THRESHOLD = 8
_RENDER_COMPLETE_MARKER = ".render_complete"


def pdf_to_page_images(pdf_path: str, output_dir: str, dpi: int = 200, num_pages: int = 0) -> int:
    """Convert PDF to per-page PNG images (0-indexed).

    Saves as {output_dir}/page_0.png, page_1.png, ...
    Returns the number of pages. Skips conversion if images already exist.

    Args:
        pdf_path: Path to the PDF file.
        output_dir: Directory to save page images.
        dpi: Resolution for rendering. Default 200.
        num_pages: If known, pass the page count to avoid opening the PDF
            just to determine it. When 0, the PDF is opened to count pages.
    """
    os.makedirs(output_dir, exist_ok=True)
    marker_path = os.path.join(output_dir, _RENDER_COMPLETE_MARKER)

    # Fast path: marker proves a previous render completed fully
    if os.path.exists(marker_path):
        try:
            with open(marker_path) as f:
                return int(f.read().strip())
        except (ValueError, OSError):
            pass  # corrupt marker, fall through to re-render

    # Legacy / backward-compat: PNGs exist from before the marker was introduced.
    # Validate that all pages 0..max are present (contiguous) before trusting them.
    existing = [f for f in os.listdir(output_dir) if f.endswith(".png")]
    if existing:
        idxs = []
        for f in existing:
            m = re.match(r"page_(\d+)\.png", f)
            if m:
                idxs.append(int(m.group(1)))
        if idxs:
            expected = max(idxs) + 1
            if len(idxs) == expected:
                # All pages contiguous — write marker for future fast path
                with open(marker_path, "w") as f:
                    f.write(str(expected))
                return expected
            # Partial render from a previous failed attempt — re-render below
            logger.warning(
                "Partial render detected (%d/%d pages), re-rendering",
                len(idxs), expected,
            )

    logger.info("Converting PDF to images: %s", pdf_path)

    if num_pages <= 0:
        import pymupdf
        doc = pymupdf.open(pdf_path)
        num_pages = len(doc)
        doc.close()

    if num_pages > _PARALLEL_PAGE_THRESHOLD:
        num_pages = _render_pages_parallel(pdf_path, output_dir, dpi, num_pages)
    else:
        _render_page_chunk(pdf_path, output_dir, dpi, 0, num_pages)

    # Mark rendering as complete so partial failures are never mistaken for success
    with open(marker_path, "w") as f:
        f.write(str(num_pages))

    logger.info("Converted %d pages.", num_pages)
    return num_pages


def _render_pages_parallel(pdf_path: str, output_dir: str, dpi: int, num_pages: int) -> int:
    """Render pages in parallel using ProcessPoolExecutor."""
    from concurrent.futures import ProcessPoolExecutor

    cpu_count = os.cpu_count() or 1
    max_workers = min(4, cpu_count, num_pages // 2)
    max_workers = max(1, max_workers)

    chunk_size = (num_pages + max_workers - 1) // max_workers
    chunks = []
    for start in range(0, num_pages, chunk_size):
        end = min(start + chunk_size, num_pages)
        chunks.append((pdf_path, output_dir, dpi, start, end))

    logger.info("Rendering %d pages with %d workers", num_pages, max_workers)
    with ProcessPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(_render_page_chunk, *args) for args in chunks]
        for future in futures:
            future.result()  # raise on error

    return num_pages


# ---------------------------------------------------------------------------
# Scanned document detection
# ---------------------------------------------------------------------------

def detect_scanned_pdf(pdf_path: str, sample_pages: int = 5, min_chars_per_page: int = 50) -> bool:
    """Heuristic: if sampled pages have very little extractable native text, likely scanned.

    Samples up to `sample_pages` evenly distributed pages.
    Returns True if the average character count per page is below `min_chars_per_page`.
    """
    try:
        import pymupdf
        doc = pymupdf.open(pdf_path)
        num_pages = len(doc)
        if num_pages == 0:
            doc.close()
            return False
        step = max(1, num_pages // sample_pages)
        indices = list(range(0, num_pages, step))[:sample_pages]
        total_chars = 0
        for i in indices:
            text = doc[i].get_text()
            total_chars += len(text.strip())
        doc.close()
        avg_chars = total_chars / len(indices)
        return avg_chars < min_chars_per_page
    except ImportError:
        logger.warning("pymupdf not installed; scanned detection skipped, assuming not scanned")
        return False
    except Exception:
        logger.warning("Scanned detection failed; assuming not scanned")
        return False


# ---------------------------------------------------------------------------
# Native PDF outline (bookmarks/TOC) extraction
# ---------------------------------------------------------------------------

def extract_native_outline(pdf_path: str, num_pages: int = None) -> Optional[List[dict]]:
    """Extract PDF bookmark/TOC outline using PyMuPDF.

    Returns a nested tree structure (same format as PageIndex output) with 0-indexed pages,
    or None if the PDF has no outline.
    """
    try:
        import pymupdf
        doc = pymupdf.open(pdf_path)
        toc = doc.get_toc()  # [[level, title, page_number(1-indexed)], ...]
        if num_pages is None:
            num_pages = len(doc)
        doc.close()
        if not toc:
            return None
        tree = _toc_to_tree(toc, num_pages)
        return tree if tree else None
    except ImportError:
        logger.warning("pymupdf not installed; native outline extraction skipped")
        return None
    except Exception:
        logger.warning("Native outline extraction failed")
        return None


# ---------------------------------------------------------------------------
# Combined PDF analysis (single open)
# ---------------------------------------------------------------------------

def analyze_pdf(
    pdf_path: str,
    sample_pages: int = 5,
    min_chars_per_page: int = 50,
) -> tuple:
    """Open the PDF once and return (num_pages, is_scanned, native_outline).

    Combines the logic of detect_scanned_pdf() and extract_native_outline()
    into a single PyMuPDF open/close cycle to avoid redundant I/O.

    Returns:
        (num_pages, is_scanned, native_outline) where native_outline is a
        nested tree structure or None.
    """
    try:
        import pymupdf
    except ImportError:
        logger.warning("pymupdf not installed; analyze_pdf returning defaults")
        return (0, False, None)

    try:
        doc = pymupdf.open(pdf_path)
        num_pages = len(doc)

        # --- scanned detection (same logic as detect_scanned_pdf) ---
        is_scanned = False
        if num_pages > 0:
            step = max(1, num_pages // sample_pages)
            indices = list(range(0, num_pages, step))[:sample_pages]
            total_chars = 0
            for i in indices:
                text = doc[i].get_text()
                total_chars += len(text.strip())
            avg_chars = total_chars / len(indices)
            is_scanned = avg_chars < min_chars_per_page

        # --- native outline (same logic as extract_native_outline) ---
        native_outline = None
        toc = doc.get_toc()
        doc.close()

        if toc:
            tree = _toc_to_tree(toc, num_pages)
            native_outline = tree if tree else None

        return (num_pages, is_scanned, native_outline)
    except Exception:
        logger.warning("analyze_pdf failed; returning defaults")
        return (0, False, None)


