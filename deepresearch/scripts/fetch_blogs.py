#!/usr/bin/env python3
"""
DeepResearch 2.0 — 博客 / 长文抓取

读取主题 yml 的 blogs 数组，将每个 URL 抓回 HTML 并尝试转换为 Markdown 写入
deepresearch/sources/blogs/。失败的 URL 会写入 metadata.json 的 errors 字段，
不会让脚本整体失败。

可选依赖（更好质量）：beautifulsoup4 + html2text；缺失时使用极简正则降级。

Usage:
  python3 deepresearch/scripts/fetch_blogs.py \
      --topic deepresearch/topics/document-parsing.yml \
      --output deepresearch/sources/blogs
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

try:
    import yaml  # type: ignore
except ImportError:
    yaml = None  # type: ignore  # 延迟报错；--help 不需要

try:  # 可选，失败降级
    from bs4 import BeautifulSoup  # type: ignore
    HAS_BS4 = True
except ImportError:
    HAS_BS4 = False

try:
    import html2text  # type: ignore
    HAS_H2T = True
except ImportError:
    HAS_H2T = False

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 deepresearch/2.0"
)
RATE_LIMIT_SECONDS = 2


def _http_get(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _slugify(s: str) -> str:
    s = re.sub(r"[^\w\-]+", "-", s.strip().lower(), flags=re.UNICODE)
    return s.strip("-")[:80] or "untitled"


def _short_hash(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:8]


def _strip_html_minimal(raw: str) -> str:
    """无 bs4 时的极简降级：剥脚本/样式/标签。"""
    raw = re.sub(r"<script[\s\S]*?</script>", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"<style[\s\S]*?</style>", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"<[^>]+>", " ", raw)
    raw = re.sub(r"\s+\n", "\n", raw)
    raw = re.sub(r"\n{3,}", "\n\n", raw)
    return raw.strip()


def html_to_markdown(html: str) -> tuple[str, str | None]:
    """返回 (markdown 正文, 抽出的标题或 None)。"""
    title: str | None = None
    if HAS_BS4:
        soup = BeautifulSoup(html, "html.parser")
        if soup.title and soup.title.string:
            title = soup.title.string.strip()
        # 去掉常见噪声
        for tag in soup(["script", "style", "nav", "footer", "aside"]):
            tag.decompose()
        # 偏好 <article> 或 <main>
        body = soup.find("article") or soup.find("main") or soup.body or soup
        html_main = str(body)
    else:
        m = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
        if m:
            title = re.sub(r"\s+", " ", m.group(1)).strip()
        html_main = html

    if HAS_H2T:
        h = html2text.HTML2Text()
        h.body_width = 0
        h.ignore_images = False
        h.ignore_links = False
        md = h.handle(html_main)
    else:
        md = _strip_html_minimal(html_main)
    return md.strip(), title


def fetch_one(url: str, hint_title: str | None, out_dir: Path) -> dict:
    print(f"  fetch {url}", file=sys.stderr)
    raw = _http_get(url)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("utf-8", errors="ignore")
    md, page_title = html_to_markdown(text)
    title = hint_title or page_title or url
    slug = _slugify(title) + "-" + _short_hash(url)
    out_path = out_dir / f"{slug}.md"
    front_matter = (
        f"---\n"
        f"title: {title}\n"
        f"source_url: {url}\n"
        f"source_kind: blog\n"
        f"---\n\n"
    )
    out_path.write_text(front_matter + md)
    return {
        "url": url,
        "title": title,
        "slug": slug,
        "path": str(out_path.relative_to(Path.cwd())) if out_path.is_absolute() else str(out_path),
        "size": out_path.stat().st_size,
        "source_kind": "blog",
        "trust_level": "normal",
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="抓取技术博客 / 长文为 Markdown")
    ap.add_argument("--topic", required=True)
    ap.add_argument("--output", default="deepresearch/sources/blogs")
    args = ap.parse_args()

    cfg = yaml.safe_load(Path(args.topic).read_text()) if yaml else None
    if cfg is None:
        print("ERROR: pyyaml 未安装。请执行: pip install pyyaml", file=sys.stderr)
        sys.exit(1)
    blogs = cfg.get("blogs") or []
    if not blogs:
        print("没有 blogs 条目，跳过。", file=sys.stderr)
        return

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    items: list[dict] = []
    errors: list[dict] = []

    for i, entry in enumerate(blogs, 1):
        url = entry.get("url") if isinstance(entry, dict) else str(entry)
        title = entry.get("title") if isinstance(entry, dict) else None
        if not url:
            continue
        print(f"[{i}/{len(blogs)}]", file=sys.stderr)
        try:
            items.append(fetch_one(url, title, out_dir))
        except Exception as e:  # pragma: no cover
            print(f"    FAILED: {e}", file=sys.stderr)
            errors.append({"url": url, "error": str(e)})
        time.sleep(RATE_LIMIT_SECONDS)

    meta = {"items": items, "errors": errors}
    (out_dir / "metadata.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    print(json.dumps({"blogs": len(items), "errors": len(errors), "output": str(out_dir)}))


if __name__ == "__main__":
    main()
