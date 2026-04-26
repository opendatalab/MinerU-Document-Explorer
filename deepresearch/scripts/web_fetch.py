#!/usr/bin/env python3
"""
DeepResearch 2.0 — 单页 HTML 抓取器

将指定 URL 的 HTML 内容转换为 Markdown，提取标题、meta 信息和链接。

可选依赖（更好质量）：html2text；缺失时使用极简正则降级（无结构化 Markdown）。

Usage:
  python3 deepresearch/scripts/web_fetch.py --url "https://example.com" \
      [--timeout 20] [--max-bytes 5000000]
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import sys
import urllib.parse
import urllib.request
from typing import Any

try:
    import html2text  # type: ignore
    HAS_H2T = True
except ImportError:
    HAS_H2T = False

USER_AGENT = "MinerU-DeepResearch/2.0 (+https://mineru.net)"
DEFAULT_TIMEOUT = 20
DEFAULT_MAX_BYTES = 5_000_000

TEXT_CONTENT_TYPES = ("text/html", "text/plain")


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _http_get(url: str, timeout: int, max_bytes: int) -> tuple[bytes, str, str]:
    """Fetch URL, return (body_bytes, final_url, content_type).

    Raises on network errors; caller wraps in try/except.
    Enforces max_bytes via Content-Length header and mid-stream buffer check.
    """
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        final_url: str = resp.url
        ct_header: str = resp.headers.get("Content-Type", "") or ""
        content_type = ct_header.split(";")[0].strip().lower()

        # Refuse if Content-Length exceeds limit
        cl = resp.headers.get("Content-Length")
        if cl and int(cl) > max_bytes:
            raise ValueError(f"Content-Length {cl} exceeds max_bytes {max_bytes}")

        # Stream with mid-stream size check
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise ValueError(f"Response body exceeds max_bytes {max_bytes}")
            chunks.append(chunk)

    return b"".join(chunks), final_url, content_type


# ---------------------------------------------------------------------------
# HTML parsing helpers
# ---------------------------------------------------------------------------

def _extract_title(html: str, url: str) -> str:
    """Extract title: <title> → first <h1> → URL path."""
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    if m:
        return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", m.group(1))).strip()
    h1 = re.search(r"<h1[^>]*>(.*?)</h1>", html, re.IGNORECASE | re.DOTALL)
    if h1:
        return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", h1.group(1))).strip()
    return urllib.parse.urlparse(url).path or url


def _extract_meta(html: str) -> dict[str, str]:
    """Extract common <meta> fields into a lowercase-keyed dict."""
    meta: dict[str, str] = {}
    # <meta name="..." content="..."> and <meta property="..." content="...">
    for m in re.finditer(
        r'<meta\s+(?:[^>]*?\s+)?(?:name|property)\s*=\s*["\']([^"\']+)["\'][^>]*'
        r'content\s*=\s*["\']([^"\']*)["\']',
        html,
        re.IGNORECASE,
    ):
        key, val = m.group(1).lower(), m.group(2).strip()
        if key in ("description", "author", "og:title", "article:published_time"):
            meta[key] = val

    # Also handle reversed attribute order: content before name/property
    for m in re.finditer(
        r'<meta\s+(?:[^>]*?\s+)?content\s*=\s*["\']([^"\']*)["\'][^>]*'
        r'(?:name|property)\s*=\s*["\']([^"\']+)["\']',
        html,
        re.IGNORECASE,
    ):
        val, key = m.group(1).strip(), m.group(2).lower()
        if key in ("description", "author", "og:title", "article:published_time"):
            meta.setdefault(key, val)

    return meta


def _extract_links(html: str, base_url: str) -> list[str]:
    """Extract absolute href values from <a> tags. Dedup, cap at 100, strip fragments."""
    seen: set[str] = set()
    links: list[str] = []
    for m in re.finditer(r'<a\s[^>]*href\s*=\s*["\']([^"\'#][^"\']*)["\']', html, re.IGNORECASE):
        raw = m.group(1).strip()
        absolute = urllib.parse.urljoin(base_url, raw)
        # Strip fragment
        parsed = urllib.parse.urlparse(absolute)
        clean = urllib.parse.urlunparse(parsed._replace(fragment=""))
        if clean and clean not in seen:
            seen.add(clean)
            links.append(clean)
            if len(links) >= 100:
                break
    return links


def _strip_html_minimal(raw: str) -> str:
    """Regex-only HTML stripper used when html2text is unavailable.

    Quality note: no structure (headings, lists, links) is preserved — plain
    text only. Install html2text for proper Markdown conversion.
    """
    raw = re.sub(r"<script[\s\S]*?</script>", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"<style[\s\S]*?</style>", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"<[^>]+>", " ", raw)
    raw = re.sub(r"[ \t]+", " ", raw)
    raw = re.sub(r"\s*\n\s*", "\n", raw)
    raw = re.sub(r"\n{3,}", "\n\n", raw)
    return raw.strip()


def _html_to_markdown(html: str) -> str:
    """Convert HTML to Markdown using html2text if available, else regex fallback."""
    if HAS_H2T:
        h = html2text.HTML2Text()
        h.body_width = 0
        h.ignore_images = False
        h.ignore_links = False
        h.ignore_tables = False
        return h.handle(html).strip()
    return _strip_html_minimal(html)


# ---------------------------------------------------------------------------
# Public library entry point
# ---------------------------------------------------------------------------

def fetch_url(url: str, timeout: int = DEFAULT_TIMEOUT, max_bytes: int = DEFAULT_MAX_BYTES) -> dict[str, Any]:
    """Fetch a URL and return structured JSON-serialisable dict."""
    fetched_at = datetime.datetime.utcnow().isoformat() + "Z"

    try:
        body_bytes, final_url, content_type = _http_get(url, timeout, max_bytes)
    except Exception as exc:
        return {
            "url": url,
            "status": "error",
            "error": str(exc)[:200],
            "fetched_at": fetched_at,
        }

    # Skip non-text content
    if content_type and not any(content_type.startswith(t) for t in TEXT_CONTENT_TYPES):
        return {
            "url": url,
            "final_url": final_url,
            "status": "skipped_non_text",
            "content_type": content_type,
            "markdown": "",
            "word_count": 0,
            "fetched_at": fetched_at,
        }

    try:
        html = body_bytes.decode("utf-8")
    except UnicodeDecodeError:
        html = body_bytes.decode("utf-8", errors="ignore")

    title = _extract_title(html, final_url)
    meta = _extract_meta(html)
    extracted_links = _extract_links(html, final_url)
    markdown = _html_to_markdown(html)
    word_count = len(markdown.split())

    return {
        "url": url,
        "final_url": final_url,
        "status": "ok",
        "markdown": markdown,
        "title": title,
        "meta": meta,
        "extracted_links": extracted_links,
        "content_type": content_type,
        "fetched_at": fetched_at,
        "word_count": word_count,
    }


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description="单页 HTML → Markdown 抓取器")
    ap.add_argument("--url", required=True, help="目标 URL")
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="HTTP 超时（秒）")
    ap.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES, dest="max_bytes",
                    help="最大下载字节数")
    args = ap.parse_args()

    result = fetch_url(args.url, timeout=args.timeout, max_bytes=args.max_bytes)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
