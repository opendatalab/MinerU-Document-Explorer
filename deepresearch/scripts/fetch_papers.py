#!/usr/bin/env python3
"""
DeepResearch 2.0 — arXiv 论文抓取

按主题 yml 中的 arxiv.queries 与 seed_papers 抓取 PDF 到 deepresearch/sources/papers/，
同时输出 metadata.json（含 trust_level：seed=high，query=normal）。

Usage:
  python3 deepresearch/scripts/fetch_papers.py \
      --topic deepresearch/topics/document-parsing.yml \
      --output deepresearch/sources/papers \
      [--max 30] [--metadata-only]

依赖：feedparser, pyyaml
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

# 延迟导入，--help 不需要这些重型依赖
feedparser = None  # type: ignore
yaml = None  # type: ignore


def _require_runtime_deps() -> tuple:
    try:
        import feedparser  # type: ignore
    except ImportError:
        print("ERROR: feedparser 未安装。请执行: pip install feedparser", file=sys.stderr)
        sys.exit(1)
    try:
        import yaml  # type: ignore
    except ImportError:
        print("ERROR: pyyaml 未安装。请执行: pip install pyyaml", file=sys.stderr)
        sys.exit(1)
    return feedparser, yaml


ARXIV_API = "http://export.arxiv.org/api/query"
RATE_LIMIT_SECONDS = 3
USER_AGENT = "deepresearch/2.0 (https://github.com/opendatalab/MinerU-Document-Explorer)"


def _http_get(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _parse_entry(entry, trust_level: str) -> dict:
    arxiv_id = entry.id.split("/abs/")[-1]
    arxiv_id = re.sub(r"v\d+$", "", arxiv_id)
    return {
        "arxiv_id": arxiv_id,
        "title": entry.title.replace("\n", " ").strip(),
        "authors": [a.get("name", "") for a in entry.get("authors", [])],
        "summary": entry.summary.replace("\n", " ").strip(),
        "published": entry.get("published", ""),
        "updated": entry.get("updated", ""),
        "pdf_url": f"https://arxiv.org/pdf/{arxiv_id}.pdf",
        "categories": [t.get("term", "") for t in entry.get("tags", [])],
        "trust_level": trust_level,
        "source_kind": "arxiv",
    }


def fetch_by_query(query: str, max_results: int, date_from: str, date_to: str) -> list[dict]:
    df = date_from.replace("-", "") + "0000"
    dt = date_to.replace("-", "") + "2359"
    full_query = f"({query}) AND submittedDate:[{df} TO {dt}]"
    params = urllib.parse.urlencode(
        {
            "search_query": full_query,
            "start": 0,
            "max_results": max_results,
            "sortBy": "submittedDate",
            "sortOrder": "descending",
        }
    )
    url = f"{ARXIV_API}?{params}"
    print(f"  query: {query[:60]} (max {max_results})", file=sys.stderr)
    body = _http_get(url)
    feed = feedparser.parse(body)
    return [_parse_entry(e, "normal") for e in feed.entries]


def fetch_seed(arxiv_id: str) -> dict | None:
    params = urllib.parse.urlencode({"id_list": arxiv_id, "max_results": 1})
    url = f"{ARXIV_API}?{params}"
    body = _http_get(url)
    feed = feedparser.parse(body)
    if not feed.entries:
        print(f"  [seed miss] {arxiv_id}", file=sys.stderr)
        return None
    return _parse_entry(feed.entries[0], "high")


def dedup(papers: list[dict]) -> list[dict]:
    seen: dict[str, dict] = {}
    for p in papers:
        prev = seen.get(p["arxiv_id"])
        if prev is None:
            seen[p["arxiv_id"]] = p
        else:
            # 高信任级覆盖普通
            if p.get("trust_level") == "high":
                seen[p["arxiv_id"]] = p
    return list(seen.values())


def download_pdfs(papers: list[dict], out_dir: Path) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    ok = 0
    for i, p in enumerate(papers):
        safe_id = p["arxiv_id"].replace("/", "_")
        pdf_path = out_dir / f"{safe_id}.pdf"
        if pdf_path.exists() and pdf_path.stat().st_size > 0:
            ok += 1
            continue
        print(f"  [{i+1}/{len(papers)}] {p['arxiv_id']}: {p['title'][:60]}", file=sys.stderr)
        try:
            req = urllib.request.Request(p["pdf_url"], headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=60) as resp, open(pdf_path, "wb") as f:
                f.write(resp.read())
            ok += 1
        except Exception as e:  # pragma: no cover
            print(f"    FAILED: {e}", file=sys.stderr)
        time.sleep(RATE_LIMIT_SECONDS)
    return ok


def main() -> None:
    ap = argparse.ArgumentParser(description="抓取 arXiv 论文（DeepResearch 2.0）")
    ap.add_argument("--topic", required=True, help="主题 yml 路径")
    ap.add_argument("--output", default="deepresearch/sources/papers")
    ap.add_argument("--max", type=int, default=None, help="覆盖 yml 中的 max_total")
    ap.add_argument("--metadata-only", action="store_true")
    args = ap.parse_args()

    global feedparser, yaml  # 让顶层函数能引用
    feedparser, yaml = _require_runtime_deps()
    cfg = yaml.safe_load(Path(args.topic).read_text())
    arxiv_cfg = cfg.get("arxiv") or {}
    seeds = cfg.get("seed_papers") or []

    queries: list[str] = arxiv_cfg.get("queries", [])
    max_per_query = int(arxiv_cfg.get("max_per_query", 8))
    max_total = int(args.max if args.max else arxiv_cfg.get("max_total", 30))
    date_from = str(arxiv_cfg.get("date_from", "2022-01-01"))
    date_to = str(arxiv_cfg.get("date_to", "2026-12-31"))

    out_dir = Path(args.output)

    all_papers: list[dict] = []

    # 1. 种子论文
    print(f"[1/3] 抓取种子论文 ({len(seeds)} 个)...", file=sys.stderr)
    for s in seeds:
        aid = s.get("arxiv_id") if isinstance(s, dict) else str(s)
        if not aid:
            continue
        try:
            entry = fetch_seed(aid)
            if entry is not None:
                all_papers.append(entry)
        except Exception as e:
            print(f"  [seed err] {aid}: {e}", file=sys.stderr)
        time.sleep(RATE_LIMIT_SECONDS)

    # 2. 关键词查询
    print(f"[2/3] 关键词查询 ({len(queries)} 条)...", file=sys.stderr)
    for q in queries:
        try:
            entries = fetch_by_query(q, max_per_query, date_from, date_to)
            all_papers.extend(entries)
        except Exception as e:
            print(f"  [query err] {q}: {e}", file=sys.stderr)
        time.sleep(RATE_LIMIT_SECONDS)

    deduped = dedup(all_papers)
    # 让种子论文排前面
    deduped.sort(key=lambda p: (p.get("trust_level") != "high", p.get("arxiv_id", "")))
    deduped = deduped[:max_total]

    out_dir.mkdir(parents=True, exist_ok=True)
    meta_path = out_dir / "metadata.json"
    meta_path.write_text(json.dumps(deduped, indent=2, ensure_ascii=False))
    print(f"  Metadata: {meta_path} ({len(deduped)} papers)", file=sys.stderr)

    if args.metadata_only:
        print(json.dumps({"papers": len(deduped), "downloaded": 0}))
        return

    # 3. 下载
    print(f"[3/3] 下载 PDF ({len(deduped)})...", file=sys.stderr)
    n = download_pdfs(deduped, out_dir)
    print(json.dumps({"papers": len(deduped), "downloaded": n, "output": str(out_dir)}))


if __name__ == "__main__":
    main()
