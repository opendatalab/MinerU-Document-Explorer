#!/usr/bin/env python3
"""DeepResearch 2.0 — POC credibility heuristic for web search results."""

from __future__ import annotations

import argparse
import difflib
import json
import math
import re
import sys
from datetime import datetime, timezone
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_DOMAIN_TIERS: dict[str, list[str]] = {
    # Tier 1: High-trust academic/official (score 0.9)
    "high": [
        "arxiv.org", "doi.org", "aclweb.org", "openreview.net",
        "proceedings.neurips.cc", "ieee.org", "acm.org",
        "nature.com", "science.org", "springer.com",
    ],
    # Tier 2: Reputable tech/docs (score 0.75)
    "medium": [
        "github.com", "huggingface.co", "pytorch.org", "tensorflow.org",
        "docs.python.org", "developer.mozilla.org",
        "blog.google", "openai.com", "anthropic.com",
        "microsoft.com", "research.google",
    ],
    # Tier 3: Known low-quality (score 0.2)
    "low": [
        "medium.com",
        "quora.com",
        "reddit.com",
        "zhihu.com",
    ],
}

_DOMAIN_UNKNOWN_SCORE = 0.15  # below low-tier so arxiv > medium.com > unknown invariant holds
_DOMAIN_MISSING_SCORE = 0.2

# Weights — sum to 1.0
_W_DOMAIN = 0.40
_W_RECENCY = 0.25
_W_CORROBORATION = 0.35

# Recency: exponential decay; time constant in days (half-life ~365 days → λ = ln2/365 ≈ 1/527; we use 730 per plan)
_RECENCY_DECAY_DAYS = 730
_RECENCY_MIN = 0.1
_RECENCY_FUTURE = 0.8
_RECENCY_MISSING = 0.4

# Corroboration
_CORROBORATION_THRESHOLD = 0.3
_CORROBORATION_MISSING = 0.3

# Guard rails
_SCORE_FLOOR = 0.1
_SCORE_CEIL = 0.95


# ---------------------------------------------------------------------------
# Component scorers
# ---------------------------------------------------------------------------

def _domain_score(url: str) -> tuple[float, str]:
    try:
        host = urlparse(url).hostname or ""
    except Exception:
        return _DOMAIN_MISSING_SCORE, "unparseable URL"

    if not host:
        return _DOMAIN_MISSING_SCORE, "no host in URL"

    if host.startswith("www."):
        host = host[4:]

    for domain in _DOMAIN_TIERS["high"]:
        if host == domain or host.endswith("." + domain):
            return 0.9, f"high-trust domain: {domain}"

    for domain in _DOMAIN_TIERS["medium"]:
        if host == domain or host.endswith("." + domain):
            return 0.75, f"reputable domain: {domain}"

    for domain in _DOMAIN_TIERS["low"]:
        if host == domain or host.endswith("." + domain):
            return 0.2, f"low-trust domain: {domain}"

    return _DOMAIN_UNKNOWN_SCORE, f"unknown domain: {host}"


def _recency_score(published_date: str | None) -> tuple[float, str]:
    if not published_date:
        return _RECENCY_MISSING, "no publication date available"

    try:
        pub = datetime.fromisoformat(published_date.replace("Z", "+00:00"))
        if pub.tzinfo is None:
            pub = pub.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        days_old = (now - pub).days
        if days_old < 0:
            return _RECENCY_FUTURE, "future date (preprint?)"
        score = max(_RECENCY_MIN, math.exp(-days_old / _RECENCY_DECAY_DAYS))
        return round(score, 3), f"{days_old} days old"
    except (ValueError, TypeError, OverflowError):
        return _RECENCY_MISSING, "unparseable date"


def _corroboration_score(
    snippet: str | None,
    known_snippets: list[str] | None,
) -> tuple[float, str]:
    if not snippet or not known_snippets:
        return _CORROBORATION_MISSING, "no corroboration data (single source)"

    snippet_words = snippet.lower().strip().split()
    if not snippet_words:
        return _CORROBORATION_MISSING, "empty snippet"

    max_sim = 0.0
    corroborating = 0

    for ks in known_snippets:
        ks_words = ks.lower().strip().split()
        if not ks_words:
            continue
        sim = difflib.SequenceMatcher(None, snippet_words, ks_words).ratio()
        max_sim = max(max_sim, sim)
        # Use threshold to count corroboration but cap at < 0.95 to avoid
        # counting near-duplicates (same source reprinted) as independent.
        if _CORROBORATION_THRESHOLD <= sim < 0.95:
            corroborating += 1

    if corroborating >= 2:
        return 0.9, f"{corroborating} independent sources corroborate (max_sim={max_sim:.2f})"
    elif corroborating == 1:
        return 0.65, f"1 corroborating source (max_sim={max_sim:.2f})"
    else:
        return _CORROBORATION_MISSING, f"no corroboration found (max_sim={max_sim:.2f})"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def credibility_score(
    url: str,
    snippet: str | None = None,
    source_type: str | None = None,
    date: str | None = None,
    known_snippets: list[str] | None = None,
) -> dict:
    """Compute a heuristic credibility score for a web source.

    Returns a dict with keys: score, method, reasons, components.
    """
    d_score, d_reason = _domain_score(url)
    r_score, r_reason = _recency_score(date)
    c_score, c_reason = _corroboration_score(snippet, known_snippets)

    raw = _W_DOMAIN * d_score + _W_RECENCY * r_score + _W_CORROBORATION * c_score
    final = max(_SCORE_FLOOR, min(_SCORE_CEIL, raw))

    return {
        "score": round(final, 3),
        "method": "heuristic",
        "reasons": [d_reason, r_reason, c_reason],
        "components": {
            "domain": round(d_score, 3),
            "recency": round(r_score, 3),
            "corroboration": round(c_score, 3),
        },
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Compute credibility heuristic score for a URL.",
    )
    p.add_argument("--url", required=True, help="Source URL to score")
    p.add_argument("--snippet", default=None, help="Text snippet from the source")
    p.add_argument("--source-type", default=None, help="Source type hint (unused in v1)")
    p.add_argument("--date", default=None, metavar="YYYY-MM-DD", help="Publication date")
    p.add_argument(
        "--known-snippets-json",
        default=None,
        metavar="PATH",
        help="Path to a JSON file containing a list of known corroborating snippets",
    )
    return p


def _load_known_snippets(path: str) -> list[str]:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, list):
            return []
        return [str(s) for s in data if s]
    except Exception as exc:
        print(json.dumps({"error": f"could not load known-snippets-json: {exc}"}), file=sys.stderr)
        return []


if __name__ == "__main__":
    parser = _build_parser()
    args = parser.parse_args()

    known: list[str] | None = None
    if args.known_snippets_json:
        known = _load_known_snippets(args.known_snippets_json)

    result = credibility_score(
        url=args.url,
        snippet=args.snippet,
        source_type=args.source_type,
        date=args.date,
        known_snippets=known,
    )
    print(json.dumps(result, ensure_ascii=False))
