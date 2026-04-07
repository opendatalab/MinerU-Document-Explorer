#!/usr/bin/env python3
"""
Fetch RAG papers from arXiv (2026+) and download PDFs.

Usage:
    python3 demo/fetch_arxiv.py [--max 10] [--output demo/papers]

Requires: pip install feedparser
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse
from pathlib import Path

try:
    import feedparser
except ImportError:
    print("ERROR: feedparser not installed. Run: pip install feedparser", file=sys.stderr)
    sys.exit(1)


ARXIV_API = "http://export.arxiv.org/api/query"
BATCH_SIZE = 50
RATE_LIMIT_SECONDS = 3


def fetch_papers(max_results: int) -> list[dict]:
    """Fetch papers with 'RAG' in title from arXiv, sorted by date descending."""
    papers = []
    start = 0

    while len(papers) < max_results:
        batch = min(BATCH_SIZE, max_results - len(papers))
        params = urllib.parse.urlencode({
            "search_query": 'ti:RAG AND submittedDate:[202601010000 TO 202612312359]',
            "start": start,
            "max_results": batch,
            "sortBy": "submittedDate",
            "sortOrder": "descending",
        })

        url = f"{ARXIV_API}?{params}"
        print(f"  Fetching batch {start}–{start + batch}...", file=sys.stderr)

        response = urllib.request.urlopen(url, timeout=30).read()
        feed = feedparser.parse(response)

        if feed.bozo and not feed.entries:
            print(f"  Warning: feed parse issue: {feed.bozo_exception}", file=sys.stderr)
            break

        if not feed.entries:
            print(f"  No more results after {len(papers)} papers.", file=sys.stderr)
            break

        for entry in feed.entries:
            arxiv_id = entry.id.split("/abs/")[-1]
            arxiv_id = re.sub(r"v\d+$", "", arxiv_id)

            paper = {
                "arxiv_id": arxiv_id,
                "title": entry.title.replace("\n", " ").strip(),
                "authors": [a.get("name", "") for a in entry.get("authors", [])],
                "summary": entry.summary.replace("\n", " ").strip(),
                "published": entry.published,
                "updated": entry.updated,
                "pdf_url": f"https://arxiv.org/pdf/{arxiv_id}.pdf",
                "categories": [t.get("term", "") for t in entry.get("tags", [])],
            }
            papers.append(paper)

        start += batch
        if len(papers) < max_results and feed.entries:
            time.sleep(RATE_LIMIT_SECONDS)

    return papers[:max_results]


def download_pdfs(papers: list[dict], output_dir: Path) -> int:
    """Download PDFs for all papers. Returns count of successfully downloaded."""
    output_dir.mkdir(parents=True, exist_ok=True)
    downloaded = 0

    for i, paper in enumerate(papers):
        safe_id = paper["arxiv_id"].replace("/", "_")
        pdf_path = output_dir / f"{safe_id}.pdf"

        if pdf_path.exists():
            print(f"  [{i+1}/{len(papers)}] Already exists: {pdf_path.name}", file=sys.stderr)
            downloaded += 1
            continue

        print(f"  [{i+1}/{len(papers)}] Downloading {paper['arxiv_id']}: {paper['title'][:60]}...", file=sys.stderr)
        try:
            urllib.request.urlretrieve(paper["pdf_url"], str(pdf_path))
            downloaded += 1
        except Exception as e:
            print(f"    FAILED: {e}", file=sys.stderr)

        if i < len(papers) - 1:
            time.sleep(RATE_LIMIT_SECONDS)

    return downloaded


def main():
    parser = argparse.ArgumentParser(description="Fetch RAG papers from arXiv (2026+)")
    parser.add_argument("--max", type=int, default=10, help="Maximum papers to fetch (default: 10)")
    parser.add_argument("--output", type=str, default="demo/papers", help="Output directory for PDFs")
    parser.add_argument("--metadata-only", action="store_true", help="Only fetch metadata, skip PDF download")
    args = parser.parse_args()

    output_dir = Path(args.output)

    print(f"Step 1: Fetching up to {args.max} RAG papers from arXiv (2026+)...", file=sys.stderr)
    papers = fetch_papers(args.max)
    print(f"  Found {len(papers)} papers.", file=sys.stderr)

    if not papers:
        print("No papers found. The arXiv query may need adjustment.", file=sys.stderr)
        sys.exit(1)

    metadata_path = output_dir / "metadata.json"
    output_dir.mkdir(parents=True, exist_ok=True)
    with open(metadata_path, "w") as f:
        json.dump(papers, f, indent=2, ensure_ascii=False)
    print(f"  Metadata saved to {metadata_path}", file=sys.stderr)

    if args.metadata_only:
        print("Skipping PDF download (--metadata-only).", file=sys.stderr)
    else:
        print(f"\nStep 2: Downloading {len(papers)} PDFs to {output_dir}/...", file=sys.stderr)
        downloaded = download_pdfs(papers, output_dir)
        print(f"  Downloaded {downloaded}/{len(papers)} PDFs.", file=sys.stderr)

    # Output summary to stdout (machine-readable)
    print(json.dumps({
        "total_papers": len(papers),
        "output_dir": str(output_dir),
        "metadata_file": str(metadata_path),
    }))


if __name__ == "__main__":
    main()
