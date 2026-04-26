#!/usr/bin/env python3
"""Unit tests for deepresearch/scripts/credibility_heuristic.py.

Run with:
    python3 -m pytest deepresearch/eval/test_credibility.py -v
"""

from __future__ import annotations

import os
import sys

# Allow direct import without package installation
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from credibility_heuristic import credibility_score  # noqa: E402

# ---------------------------------------------------------------------------
# Constants mirrored from the module (used in assertions)
# ---------------------------------------------------------------------------
_RECENCY_MISSING = 0.4   # fallback when no date is given
_CORROBORATION_MISSING = 0.3  # fallback when no known_snippets


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

def test_monotonic_ordering():
    """arxiv (high-trust) > medium.com (low-trust) > unknown domain."""
    snippet = "This paper presents a novel approach to machine learning."
    arxiv = credibility_score("https://arxiv.org/abs/2301.00001", snippet=snippet)
    medium = credibility_score("https://medium.com/@random/some-blog-post", snippet=snippet)
    unknown = credibility_score("https://unknown-site-xyz.example/article", snippet=snippet)

    assert arxiv["score"] > medium["score"], (
        f"arxiv ({arxiv['score']}) should score higher than medium.com ({medium['score']})"
    )
    assert medium["score"] > unknown["score"], (
        f"medium.com ({medium['score']}) should score higher than unknown domain ({unknown['score']})"
    )


def test_no_date_handling():
    """URL without date returns score in [0, 1]; recency falls back to _RECENCY_MISSING."""
    result = credibility_score("https://arxiv.org/abs/2301.00001", snippet="some text")

    assert 0.0 <= result["score"] <= 1.0, (
        f"score {result['score']} out of [0, 1] when no date provided"
    )
    assert result["components"]["recency"] == _RECENCY_MISSING, (
        f"recency should be {_RECENCY_MISSING} when no date given, got {result['components']['recency']}"
    )


def test_unknown_domain_handling():
    """Unknown domain returns a plausible score (not 0, not 1); no exception raised."""
    result = credibility_score("https://totally-unknown-xyz-domain.example/page")

    assert result["score"] > 0.0, (
        f"score should be > 0 for unknown domain, got {result['score']}"
    )
    assert result["score"] < 1.0, (
        f"score should be < 1 for unknown domain, got {result['score']}"
    )


def test_recency_decay():
    """Recent arxiv paper scores higher on recency than a very old one."""
    recent = credibility_score("https://arxiv.org/abs/2401.00001", date="2024-01-01")
    old = credibility_score("https://arxiv.org/abs/1001.00001", date="2010-01-01")

    assert recent["components"]["recency"] > old["components"]["recency"], (
        f"recent recency ({recent['components']['recency']}) should exceed "
        f"old recency ({old['components']['recency']})"
    )


def test_contradictory_snippets_not_high_corroboration():
    """Contradictory snippets must NOT yield corroboration > 0.65 (anti-false-positive)."""
    snippet = "Transformers are always faster than RNNs on all tasks."
    contradictory_known = [
        "Transformers are never faster than RNNs — RNNs dominate all benchmarks.",
    ]
    result = credibility_score(
        "https://arxiv.org/abs/2301.00001",
        snippet=snippet,
        known_snippets=contradictory_known,
    )

    assert result["components"]["corroboration"] <= 0.65, (
        f"Contradictory snippets should not yield corroboration > 0.65, "
        f"got {result['components']['corroboration']}"
    )


def test_agreeing_snippets_get_credit():
    """Two snippets saying the same thing (different wording) get corroboration >= 0.50."""
    snippet = "The model achieves state-of-the-art results on the ImageNet benchmark."
    agreeing_known = [
        "This model achieves state-of-the-art performance on the ImageNet benchmark dataset.",
    ]
    result = credibility_score(
        "https://arxiv.org/abs/2301.00001",
        snippet=snippet,
        known_snippets=agreeing_known,
    )

    assert result["components"]["corroboration"] >= 0.50, (
        f"Agreeing snippets should yield corroboration >= 0.50, "
        f"got {result['components']['corroboration']}"
    )


def test_edge_empty_known_snippets():
    """known_snippets=[] does not crash; corroboration gets the fallback value."""
    result = credibility_score(
        "https://arxiv.org/abs/2301.00001",
        snippet="some text",
        known_snippets=[],
    )

    # Empty list is falsy, so _corroboration_score returns _CORROBORATION_MISSING
    assert result["components"]["corroboration"] == _CORROBORATION_MISSING, (
        f"Empty known_snippets should give corroboration fallback {_CORROBORATION_MISSING}, "
        f"got {result['components']['corroboration']}"
    )


def test_malformed_url():
    """Clearly malformed URLs do not crash; return a safe score in [0, 1]."""
    for url in ["not-a-url", "ftp://weird.example/", "://broken", ""]:
        result = credibility_score(url, snippet="some snippet")
        assert 0.0 <= result["score"] <= 1.0, (
            f"Malformed URL '{url}' produced out-of-range score {result['score']}"
        )
        assert isinstance(result["score"], float), (
            f"Malformed URL '{url}' produced non-float score {result['score']!r}"
        )


def test_method_field_is_heuristic():
    """Output always has method == 'heuristic' for POC."""
    urls = [
        "https://arxiv.org/abs/2301.00001",
        "https://medium.com/@user/post",
        "https://unknown-site.example/",
    ]
    for url in urls:
        result = credibility_score(url)
        assert result["method"] == "heuristic", (
            f"Expected method='heuristic' for {url}, got {result['method']!r}"
        )


def test_score_in_range():
    """score is always in [0.0, 1.0] across varied URL/snippet combos."""
    cases = [
        ("https://arxiv.org/abs/2301.00001", "recent machine learning paper", "2023-06-01"),
        ("https://medium.com/@blogger/post", "A blog post about Python", None),
        ("https://github.com/user/repo", "Open source project README", "2022-03-15"),
        ("https://totally-obscure-domain-xyz.example/", None, None),
        ("https://nature.com/articles/12345", "Scientific study results", "2021-01-10"),
        ("not-a-url", "snippet text", None),
        ("https://reddit.com/r/python/comments/abc", "forum discussion", "2020-05-01"),
    ]
    for url, snippet, date in cases:
        result = credibility_score(url, snippet=snippet, date=date)
        assert 0.0 <= result["score"] <= 1.0, (
            f"score {result['score']} out of [0.0, 1.0] for url={url!r}"
        )


def test_output_keys_present():
    """Return dict always has the required top-level and component keys."""
    result = credibility_score("https://arxiv.org/abs/2301.00001")

    for key in ("score", "method", "reasons", "components"):
        assert key in result, f"Missing top-level key '{key}' in result"

    for comp_key in ("domain", "recency", "corroboration"):
        assert comp_key in result["components"], (
            f"Missing component key '{comp_key}' in result['components']"
        )

    assert isinstance(result["reasons"], list), "reasons should be a list"
    assert len(result["reasons"]) == 3, (
        f"reasons should have 3 entries (domain, recency, corroboration), got {len(result['reasons'])}"
    )
