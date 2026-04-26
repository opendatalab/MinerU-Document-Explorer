#!/usr/bin/env python3
"""
Unit tests for auto_check.py v2 — freshness + judge_verified_ratio dimensions.

Run with:
    python3 -m pytest deepresearch/eval/test_auto_check_v2.py -v
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from datetime import date
from pathlib import Path

# Allow direct import without package installation
sys.path.insert(0, os.path.dirname(__file__))

from auto_check import (  # noqa: E402
    _arxiv_url_to_date,
    _extract_cited_dates,
    _median_date,
    _query_judge_stats,
    score_wiki_freshness,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_judge_db(path: Path, rows: list[dict]) -> None:
    """Create a minimal wiki_log sqlite3 DB at path with the given rows."""
    con = sqlite3.connect(str(path))
    con.execute(
        "CREATE TABLE wiki_log ("
        "  id INTEGER PRIMARY KEY,"
        "  timestamp TEXT,"
        "  operation TEXT,"
        "  details TEXT"
        ")"
    )
    for i, row in enumerate(rows):
        con.execute(
            "INSERT INTO wiki_log (id, timestamp, operation, details) VALUES (?,?,?,?)",
            (i + 1, row["timestamp"], row["operation"], json.dumps(row["details"])),
        )
    con.commit()
    con.close()


# ---------------------------------------------------------------------------
# Freshness: _arxiv_url_to_date
# ---------------------------------------------------------------------------

def test_arxiv_url_to_date_valid():
    """arxiv.org/abs/2308.13418 -> date(2023, 8, 1)."""
    result = _arxiv_url_to_date("https://arxiv.org/abs/2308.13418")
    assert result == date(2023, 8, 1), f"Expected date(2023,8,1), got {result}"


def test_arxiv_url_to_date_pdf_variant():
    """arxiv.org/pdf/... variant also parses correctly."""
    result = _arxiv_url_to_date("https://arxiv.org/pdf/2401.00512")
    assert result == date(2024, 1, 1)


def test_arxiv_url_to_date_invalid_url():
    """Non-arxiv URL returns None."""
    result = _arxiv_url_to_date("https://example.com/paper/2308.13418")
    assert result is None

def test_arxiv_url_to_date_empty_string():
    """Empty string returns None without crashing."""
    result = _arxiv_url_to_date("")
    assert result is None


# ---------------------------------------------------------------------------
# Freshness: _median_date
# ---------------------------------------------------------------------------

def test_median_date_odd():
    """Odd-length list returns the middle element."""
    dates = [date(2020, 1, 1), date(2022, 6, 15), date(2024, 3, 10)]
    result = _median_date(dates)
    assert result == date(2022, 6, 15), f"Expected date(2022,6,15), got {result}"


def test_median_date_even():
    """Even-length list returns the lower middle element (no fractional dates)."""
    dates = [date(2020, 1, 1), date(2024, 12, 31)]
    result = _median_date(dates)
    # lower median: sorted[0] = 2020-01-01
    assert result == date(2020, 1, 1), f"Expected date(2020,1,1), got {result}"


def test_median_date_even_four():
    """Four dates: lower-middle (index 1) is returned."""
    dates = [date(2020, 1, 1), date(2021, 6, 1), date(2022, 6, 1), date(2024, 12, 31)]
    result = _median_date(dates)
    assert result == date(2021, 6, 1)


def test_median_date_empty():
    """Empty list returns None."""
    result = _median_date([])
    assert result is None


def test_median_date_single():
    """Single-element list returns that element."""
    result = _median_date([date(2023, 5, 10)])
    assert result == date(2023, 5, 10)


# ---------------------------------------------------------------------------
# Freshness: _extract_cited_dates
# ---------------------------------------------------------------------------

def test_extract_cited_dates_from_markdown():
    """Markdown with arxiv link + inline date + frontmatter date -> extracts all 3."""
    body = """---
published_date: 2022-01-01
---

# My Wiki Page

See [paper](https://arxiv.org/abs/2307.05782) for details.

(source: https://example.com/report, date: 2023-05-01)

Some other text here.
"""
    pages = [("test.md", body)]
    result = _extract_cited_dates(pages)
    assert len(result) >= 3, f"Expected at least 3 dates, got {len(result)}: {result}"
    assert date(2022, 1, 1) in result, "frontmatter published_date not extracted"
    assert date(2023, 5, 1) in result, "inline source date not extracted"
    # arxiv 2307 -> July 2023
    assert date(2023, 7, 1) in result, "arxiv date not extracted"


def test_extract_cited_dates_no_dates():
    """Page with no datable sources returns empty list."""
    pages = [("test.md", "# Nothing\n\nJust plain text with no URLs or dates.")]
    result = _extract_cited_dates(pages)
    assert result == []


def test_extract_cited_dates_multiple_pages():
    """Dates are collected across multiple pages."""
    pages = [
        ("page1.md", "(source: https://x.com, date: 2021-03-01)"),
        ("page2.md", "(source: https://y.com, date: 2022-09-15)"),
    ]
    result = _extract_cited_dates(pages)
    assert date(2021, 3, 1) in result
    assert date(2022, 9, 15) in result


# ---------------------------------------------------------------------------
# Freshness: score_wiki_freshness
# ---------------------------------------------------------------------------

def test_score_wiki_freshness_insufficient():
    """Fewer than 3 dated sources -> freshness is None with explanatory note."""
    pages = [("p.md", "(source: https://x.com, date: 2023-01-01)")]
    result = score_wiki_freshness(pages)
    assert result["freshness"] is None
    assert result["freshness_note"] is not None
    assert "insufficient" in result["freshness_note"].lower()
    assert result["freshness_source_count"] < 3


def test_score_wiki_freshness_ok():
    """3+ dated sources -> returns median ISO date string + count."""
    body = """
(source: https://a.com, date: 2021-01-01)
(source: https://b.com, date: 2022-06-15)
(source: https://c.com, date: 2023-12-31)
"""
    pages = [("p.md", body)]
    result = score_wiki_freshness(pages)
    assert result["freshness"] is not None, "freshness should be set with 3 dated sources"
    assert result["freshness_source_count"] >= 3
    assert result["freshness_note"] is None
    # median of 3 sorted dates is the middle one: 2022-06-15
    assert result["freshness"] == "2022-06-15"


def test_score_wiki_freshness_empty_pages():
    """Empty pages list -> insufficient sources, no crash."""
    result = score_wiki_freshness([])
    assert result["freshness"] is None


# ---------------------------------------------------------------------------
# Judge stats: _query_judge_stats
# ---------------------------------------------------------------------------

def test_query_judge_stats_missing_index(tmp_path: Path):
    """Non-existent sqlite path -> null metrics, judge_note set, no crash."""
    fake_path = str(tmp_path / "nonexistent.sqlite")
    result = _query_judge_stats(fake_path)
    assert result["judge_verified_ratio"] is None
    assert result["judge_unique_claims"] is None
    assert result["judge_call_count"] is None
    assert result["judge_note"] is not None
    assert "not found" in result["judge_note"].lower()


def test_query_judge_stats_empty_log(tmp_path: Path):
    """Empty wiki_log table -> zero counts, ratio is None (not zero-division)."""
    db_path = tmp_path / "empty.sqlite"
    _make_judge_db(db_path, [])
    result = _query_judge_stats(str(db_path))
    assert result["judge_verified_ratio"] is None, "ratio should be None when 0 unique claims"
    assert result["judge_unique_claims"] == 0
    assert result["judge_call_count"] == 0
    assert result["judge_note"] is None


def test_query_judge_stats_dedup(tmp_path: Path):
    """
    Deduplication: latest verdict per claim is used for ratio.

    Rows:
      claim "A" verified  @ t=1
      claim "B" verified  @ t=2
      claim "C" contradicted @ t=3
      claim "A" contradicted @ t=4   <- latest for A overrides t=1
      claim "A" verified  @ t=3 (duplicate timestamp, lower than t=4 — ignored)

    Expected:
      judge_call_count = 5 (all raw rows)
      judge_unique_claims = 3 (A, B, C)
      Latest verdicts: A=contradicted, B=verified, C=contradicted
      verified count = 1 (only B)
      judge_verified_ratio = 1/3 ~ 0.3333
    """
    rows = [
        {"timestamp": "2024-01-01T10:00:00", "operation": "judge_claim",
         "details": {"claim": "A", "verdict": "verified"}},
        {"timestamp": "2024-01-01T11:00:00", "operation": "judge_claim",
         "details": {"claim": "B", "verdict": "verified"}},
        {"timestamp": "2024-01-01T12:00:00", "operation": "judge_claim",
         "details": {"claim": "C", "verdict": "contradicted"}},
        {"timestamp": "2024-01-01T13:00:00", "operation": "judge_claim",
         "details": {"claim": "A", "verdict": "contradicted"}},
        {"timestamp": "2024-01-01T10:30:00", "operation": "judge_claim",
         "details": {"claim": "A", "verdict": "verified"}},
    ]
    db_path = tmp_path / "dedup.sqlite"
    _make_judge_db(db_path, rows)
    result = _query_judge_stats(str(db_path))

    assert result["judge_call_count"] == 5, f"Expected 5 raw rows, got {result['judge_call_count']}"
    assert result["judge_unique_claims"] == 3, f"Expected 3 unique claims, got {result['judge_unique_claims']}"
    # B is the only one verified at latest timestamp
    assert result["judge_verified_ratio"] is not None
    ratio = result["judge_verified_ratio"]
    assert abs(ratio - 1/3) < 0.001, f"Expected ratio ~0.333, got {ratio}"


def test_query_judge_stats_all_verified(tmp_path: Path):
    """All unique claims verified -> ratio = 1.0."""
    rows = [
        {"timestamp": "2024-01-01T10:00:00", "operation": "judge_claim",
         "details": {"claim": "X", "verdict": "verified"}},
        {"timestamp": "2024-01-01T11:00:00", "operation": "judge_claim",
         "details": {"claim": "Y", "verdict": "verified"}},
    ]
    db_path = tmp_path / "all_verified.sqlite"
    _make_judge_db(db_path, rows)
    result = _query_judge_stats(str(db_path))
    assert result["judge_verified_ratio"] == 1.0
    assert result["judge_unique_claims"] == 2
    assert result["judge_call_count"] == 2


def test_query_judge_stats_ignores_other_operations(tmp_path: Path):
    """Rows with other operations are not counted as judge_claim."""
    rows = [
        {"timestamp": "2024-01-01T10:00:00", "operation": "doc_write",
         "details": {"claim": "A", "verdict": "verified"}},
        {"timestamp": "2024-01-01T11:00:00", "operation": "wiki_ingest",
         "details": {"claim": "B", "verdict": "verified"}},
        {"timestamp": "2024-01-01T12:00:00", "operation": "judge_claim",
         "details": {"claim": "C", "verdict": "verified"}},
    ]
    db_path = tmp_path / "mixed.sqlite"
    _make_judge_db(db_path, rows)
    result = _query_judge_stats(str(db_path))
    # Only the judge_claim row counts
    assert result["judge_call_count"] == 1
    assert result["judge_unique_claims"] == 1
    assert result["judge_verified_ratio"] == 1.0
