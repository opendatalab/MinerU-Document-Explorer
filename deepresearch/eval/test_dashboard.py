#!/usr/bin/env python3
"""
Tests for deepresearch/eval/dashboard.py — T14 (dashboard modes) + T15 (e2e integration).

Run with:
    python3 -m pytest deepresearch/eval/test_dashboard.py -v
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

# Allow direct import without package installation
sys.path.insert(0, os.path.dirname(__file__))

from dashboard import (  # noqa: E402
    _append_row,
    _compute_trends,
    _fmt,
    _load_history,
    _render_markdown,
    FOOTER_TEXT,
)

# Path to dashboard.py and auto_check.py for subprocess invocations
_EVAL_DIR = Path(__file__).parent
_DASHBOARD = str(_EVAL_DIR / "dashboard.py")
_AUTO_CHECK = str(_EVAL_DIR / "auto_check.py")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_dashboard(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    """Run dashboard.py with given args; include stderr in assertion message on failure."""
    cmd = ["python3", _DASHBOARD, *args]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise AssertionError(
            f"dashboard.py exited {result.returncode}\n"
            f"stdout: {result.stdout}\n"
            f"stderr: {result.stderr}"
        )
    return result


def _append_via_cli(history_path: Path, **kwargs) -> subprocess.CompletedProcess:
    """
    Call dashboard.py --append with standard metric flags.
    Keyword args become CLI flags; underscores converted to hyphens.
    Defaults supplied for all required fields.
    """
    defaults = {
        "topic": "test-topic",
        "run_id": "run-001",
        "coverage": "0.80",
        "orphan": "0.10",
        "citations": "2.5",
        "freshness": "2024-06-01",
        "freshness_count": "5",
        "judge_verified_ratio": "0.75",
        "judge_unique_claims": "4",
        "judge_call_count": "6",
        "stop_reason": "max_iter",
    }
    defaults.update(kwargs)
    flags: list[str] = ["--append", "--history-path", str(history_path)]
    for key, val in defaults.items():
        flags += [f"--{key.replace('_', '-')}", str(val)]
    return _run_dashboard(*flags)


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


# ===========================================================================
# T14 — Dashboard mode tests
# ===========================================================================

# ---------------------------------------------------------------------------
# T14-1: --append writes valid JSONL
# ---------------------------------------------------------------------------

def test_append_writes_valid_jsonl(tmp_path: Path):
    """--append creates a JSONL file with exactly 1 line containing expected fields."""
    history = tmp_path / "metrics-history.jsonl"
    _append_via_cli(history, run_id="run-abc", topic="my-topic", coverage="0.65")

    assert history.exists(), "history file not created"
    lines = history.read_text().splitlines()
    assert len(lines) == 1, f"Expected 1 line, got {len(lines)}"

    row = json.loads(lines[0])
    assert row["run_id"] == "run-abc"
    assert row["topic"] == "my-topic"
    assert abs(row["coverage_density"] - 0.65) < 1e-6
    # required structural fields must be present
    for field in ("timestamp", "orphan_ratio", "avg_citations_per_page",
                  "freshness", "judge_verified_ratio", "stop_reason"):
        assert field in row, f"Missing field '{field}' in appended row"


# ---------------------------------------------------------------------------
# T14-2: repeat append accumulates lines in order
# ---------------------------------------------------------------------------

def test_append_is_atomic_on_repeat(tmp_path: Path):
    """Appending 3 times produces exactly 3 lines in insertion order."""
    history = tmp_path / "metrics-history.jsonl"
    for i in range(1, 4):
        _append_via_cli(history, run_id=f"run-{i:03d}", coverage=str(i * 0.1))

    lines = history.read_text().splitlines()
    assert len(lines) == 3, f"Expected 3 lines, got {len(lines)}"
    run_ids = [json.loads(l)["run_id"] for l in lines]
    assert run_ids == ["run-001", "run-002", "run-003"], f"Wrong order: {run_ids}"


# ---------------------------------------------------------------------------
# T14-3: render with no history file
# ---------------------------------------------------------------------------

def test_render_no_history_file(tmp_path: Path):
    """Render with a non-existent history path exits 0 and shows 'No history yet'."""
    nonexistent = tmp_path / "does-not-exist.jsonl"
    result = _run_dashboard("--history-path", str(nonexistent))
    assert result.returncode == 0
    assert "No history yet" in result.stdout, (
        f"Expected 'No history yet' in output, got:\n{result.stdout}"
    )


# ---------------------------------------------------------------------------
# T14-4: render with 1 row shows insufficient trend message
# ---------------------------------------------------------------------------

def test_render_single_run_insufficient_trend(tmp_path: Path):
    """1 row in history -> Trends section contains the N<2 guard message."""
    history = tmp_path / "h.jsonl"
    _append_via_cli(history, run_id="run-001")

    result = _run_dashboard("--history-path", str(history))
    assert "Insufficient data for trend analysis" in result.stdout, (
        f"Expected 'Insufficient data for trend analysis' in output:\n{result.stdout}"
    )


# ---------------------------------------------------------------------------
# T14-5: two runs with improving coverage -> ↑ improving arrow
# ---------------------------------------------------------------------------

def test_render_two_runs_trends_direction_coverage(tmp_path: Path):
    """2 rows: coverage 0.70 -> 0.85 -> Trends shows ↑ improving for coverage_density."""
    history = tmp_path / "h.jsonl"
    _append_via_cli(history, run_id="run-001", coverage="0.70",
                    freshness="null", judge_verified_ratio="null")
    _append_via_cli(history, run_id="run-002", coverage="0.85",
                    freshness="null", judge_verified_ratio="null")

    result = _run_dashboard("--history-path", str(history))
    assert "↑ improving" in result.stdout, (
        f"Expected '↑ improving' in Trends output:\n{result.stdout}"
    )
    assert "coverage_density" in result.stdout


# ---------------------------------------------------------------------------
# T14-6: orphan_ratio improvement shows "lower is better" label
# ---------------------------------------------------------------------------

def test_render_two_runs_orphan_inverse(tmp_path: Path):
    """orphan 0.20 -> 0.10 (lower is better) -> '↑ improving (lower is better)'."""
    history = tmp_path / "h.jsonl"
    _append_via_cli(history, run_id="run-001", orphan="0.20",
                    freshness="null", judge_verified_ratio="null")
    _append_via_cli(history, run_id="run-002", orphan="0.10",
                    freshness="null", judge_verified_ratio="null")

    result = _run_dashboard("--history-path", str(history))
    assert "↑ improving (lower is better)" in result.stdout, (
        f"Expected '↑ improving (lower is better)' for orphan_ratio:\n{result.stdout}"
    )


# ---------------------------------------------------------------------------
# T14-7: malformed JSONL line is skipped with warning
# ---------------------------------------------------------------------------

def test_render_skips_malformed_line(tmp_path: Path):
    """Corrupt JSONL line is skipped; render succeeds; stderr has 'skipping malformed'."""
    history = tmp_path / "h.jsonl"
    # Write one valid line + one corrupt line
    _append_via_cli(history, run_id="run-001")
    with history.open("a") as fh:
        fh.write("{this is not valid json\n")

    result = _run_dashboard("--history-path", str(history))
    assert result.returncode == 0, f"Expected exit 0, got {result.returncode}"
    assert "skipping malformed" in result.stderr.lower(), (
        f"Expected 'skipping malformed' warning in stderr:\n{result.stderr}"
    )
    # Table should still show the valid row
    assert "run-001" in result.stdout


# ---------------------------------------------------------------------------
# T14-8: footer always present (0, 1, 2 rows)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("num_rows", [0, 1, 2])
def test_footer_always_present(tmp_path: Path, num_rows: int):
    """Footer self-assessment note is present regardless of row count."""
    history = tmp_path / f"h_{num_rows}.jsonl"
    for i in range(num_rows):
        _append_via_cli(history, run_id=f"run-{i:03d}")

    result = _run_dashboard("--history-path", str(history))
    assert result.returncode == 0
    # Footer references "lower bound" or "self-assessment"
    assert any(kw in result.stdout for kw in ("lower bound", "self-assessment")), (
        f"Footer not found in output for {num_rows} rows:\n{result.stdout}"
    )


# ---------------------------------------------------------------------------
# T14-9: --topic filter shows only matching topic
# ---------------------------------------------------------------------------

def test_topic_filter(tmp_path: Path):
    """3 rows for 2 topics; filter by one -> only that topic's rows shown."""
    history = tmp_path / "h.jsonl"
    _append_via_cli(history, run_id="alpha-1", topic="alpha")
    _append_via_cli(history, run_id="beta-1",  topic="beta")
    _append_via_cli(history, run_id="alpha-2", topic="alpha")

    result = _run_dashboard("--history-path", str(history), "--topic", "alpha")
    assert "alpha-1" in result.stdout
    assert "alpha-2" in result.stdout
    assert "beta-1" not in result.stdout, (
        f"beta-1 should be filtered out:\n{result.stdout}"
    )


# ---------------------------------------------------------------------------
# T14-10: --last N limits to N rows
# ---------------------------------------------------------------------------

def test_last_n(tmp_path: Path):
    """Append 5 rows; --last 2 -> only 2 rows in the table."""
    history = tmp_path / "h.jsonl"
    for i in range(1, 6):
        _append_via_cli(history, run_id=f"run-{i:03d}")

    result = _run_dashboard("--history-path", str(history), "--last", "2")
    # Rows 4 and 5 should appear; rows 1-3 should not
    assert "run-004" in result.stdout
    assert "run-005" in result.stdout
    assert "run-001" not in result.stdout, (
        f"run-001 should not appear with --last 2:\n{result.stdout}"
    )


# ---------------------------------------------------------------------------
# T14-11: null metrics render as em-dash
# ---------------------------------------------------------------------------

def test_null_metrics_render_as_dash(tmp_path: Path):
    """Row with freshness=null + judge_verified_ratio=null renders cells as '—'."""
    history = tmp_path / "h.jsonl"
    _append_via_cli(history, run_id="run-null", freshness="null",
                    judge_verified_ratio="null")

    result = _run_dashboard("--history-path", str(history))
    assert "—" in result.stdout, (
        f"Expected em-dash '—' for null fields:\n{result.stdout}"
    )
    # Confirm "null" string doesn't appear literally in table rows
    assert "| null |" not in result.stdout, (
        f"Literal 'null' should not appear in table:\n{result.stdout}"
    )


# ===========================================================================
# T14 — Unit-level function tests (direct import, no subprocess)
# ===========================================================================

def test_fmt_none_returns_emdash():
    """_fmt(None, ...) returns '—'."""
    assert _fmt(None, "any") == "—"


def test_fmt_float_two_decimals():
    """_fmt(float, ...) returns 2-decimal string."""
    assert _fmt(0.7654, "float") == "0.77"


def test_compute_trends_higher_is_better_improves():
    """coverage_density 0.5 -> 0.8 -> direction '↑ improving'."""
    rows = [
        {"coverage_density": 0.5, "orphan_ratio": 0.3},
        {"coverage_density": 0.8, "orphan_ratio": 0.1},
    ]
    trends = _compute_trends(rows)
    cov = next((t for t in trends if t["metric"] == "coverage_density"), None)
    assert cov is not None
    assert cov["direction"] == "↑ improving"


def test_load_history_skips_blank_lines(tmp_path: Path):
    """_load_history ignores blank lines without error."""
    history = tmp_path / "h.jsonl"
    history.write_text('{"run_id":"r1"}\n\n{"run_id":"r2"}\n')
    rows = _load_history(history)
    assert len(rows) == 2
    assert rows[0]["run_id"] == "r1"
    assert rows[1]["run_id"] == "r2"


# ===========================================================================
# T15 — End-to-end integration tests
# ===========================================================================

def _make_wiki_dir(base: Path) -> Path:
    """
    Create a minimal wiki directory with 2 pages:
    - page1.md has an arxiv link and an inline date annotation
    - page2.md links back to page1
    Returns the wiki dir path.
    """
    wiki = base / "wiki"
    wiki.mkdir()

    (wiki / "page1.md").write_text(
        "# Topic Overview\n\n"
        "See https://arxiv.org/abs/2308.12345 for background.\n"
        "(source: https://arxiv.org/abs/2308.12345, date: 2023-08-01)\n\n"
        "Related: [[page2]]\n",
        encoding="utf-8",
    )
    (wiki / "page2.md").write_text(
        "# Details\n\n"
        "This builds on [[page1]].\n"
        "(source: https://arxiv.org/abs/2401.99999, date: 2024-01-15)\n"
        "(source: https://example.com/paper, date: 2023-05-10)\n",
        encoding="utf-8",
    )
    return wiki


def _make_report(base: Path) -> Path:
    """Minimal markdown report for auto_check."""
    report = base / "report.md"
    report.write_text(
        "# Test Report\n\n"
        "## Introduction\n\nSome intro text.\n\n"
        "## Findings\n\nThings improved by 50%. (source: https://arxiv.org/abs/2308.12345)\n\n"
        "## Conclusion\n\nResults are promising.\n",
        encoding="utf-8",
    )
    return report


def _make_topic_yml(base: Path) -> Path:
    """Minimal topic YAML."""
    topic = base / "topic.yml"
    topic.write_text(
        "topic: test-topic\n"
        "research_questions:\n"
        "  - What are the main findings?\n"
        "  - How did performance improve?\n",
        encoding="utf-8",
    )
    return topic


def _make_sqlite_with_judge_rows(db_path: Path, rows: list[dict]) -> None:
    """Create sqlite DB with wiki_log table and given judge_claim rows."""
    _make_judge_db(db_path, rows)


# ---------------------------------------------------------------------------
# T15-1: full chain auto_check -> dashboard append -> render
# ---------------------------------------------------------------------------

def test_e2e_auto_check_to_dashboard(tmp_path: Path):
    """
    Full chain:
    1. auto_check.py --wiki-dir --json -> capture JSON
    2. Extract wiki metrics
    3. dashboard.py --append with those metrics -> JSONL row written
    4. dashboard.py (render) -> coverage_density, freshness, judge_verified_ratio all appear
    """
    wiki_dir = _make_wiki_dir(tmp_path)
    report = _make_report(tmp_path)
    topic = _make_topic_yml(tmp_path)
    history = tmp_path / "history.jsonl"

    # Set up sqlite with judge rows
    db_path = tmp_path / "index.sqlite"
    judge_rows = [
        {"timestamp": "2024-01-01T10:00:00", "operation": "judge_claim",
         "details": {"claim": "Claim A", "verdict": "verified"}},
        {"timestamp": "2024-01-01T11:00:00", "operation": "judge_claim",
         "details": {"claim": "Claim B", "verdict": "verified"}},
        {"timestamp": "2024-01-01T12:00:00", "operation": "judge_claim",
         "details": {"claim": "Claim C", "verdict": "under_supported"}},
        # Duplicate claim A at a later timestamp
        {"timestamp": "2024-01-01T13:00:00", "operation": "judge_claim",
         "details": {"claim": "Claim A", "verdict": "verified"}},
    ]
    _make_sqlite_with_judge_rows(db_path, judge_rows)

    # Step 1: run auto_check.py with --json
    ac_result = subprocess.run(
        [
            "python3", _AUTO_CHECK,
            "--report", str(report),
            "--topic", str(topic),
            "--wiki-dir", str(wiki_dir),
            "--index-path", str(db_path),
            "--json",
        ],
        capture_output=True, text=True,
    )
    assert ac_result.returncode == 0, (
        f"auto_check.py failed\nstdout: {ac_result.stdout}\nstderr: {ac_result.stderr}"
    )

    data = json.loads(ac_result.stdout)
    wiki = data.get("wiki", {})
    assert "error" not in wiki, f"auto_check wiki error: {wiki.get('error')}"

    coverage = wiki.get("research_questions_coverage", 0.0) or 0.0
    orphan = wiki.get("orphan_ratio", 1.0) or 0.0
    citations = wiki.get("avg_citations_per_page", 0.0) or 0.0
    freshness = wiki.get("freshness") or "null"
    freshness_count = wiki.get("freshness_source_count", 0) or 0
    jvr = wiki.get("judge_verified_ratio")
    jvr_str = str(jvr) if jvr is not None else "null"
    juc = wiki.get("judge_unique_claims", 0) or 0
    jcc = wiki.get("judge_call_count", 0) or 0

    # Step 2: dashboard --append
    append_result = _run_dashboard(
        "--append",
        "--history-path", str(history),
        "--topic", "test-topic",
        "--run-id", "e2e-run-001",
        "--coverage", str(coverage),
        "--orphan", str(orphan),
        "--citations", str(citations),
        "--freshness", str(freshness),
        "--freshness-count", str(freshness_count),
        "--judge-verified-ratio", jvr_str,
        "--judge-unique-claims", str(juc),
        "--judge-call-count", str(jcc),
        "--stop-reason", "e2e-test",
    )
    assert history.exists(), "history file not created after append"

    # Step 3: render
    render_result = _run_dashboard("--history-path", str(history))
    assert render_result.returncode == 0

    # coverage_density, freshness, and judge_verified_ratio columns exist in table header
    assert "Coverage" in render_result.stdout, "Coverage column missing"
    assert "Freshness" in render_result.stdout, "Freshness column missing"
    assert "Judge" in render_result.stdout, "Judge column missing"
    assert "e2e-run-001" in render_result.stdout, "run_id missing from output"


# ---------------------------------------------------------------------------
# T15-2: two runs appended manually -> Δ arrows show improvement
# ---------------------------------------------------------------------------

def test_e2e_two_runs_trend_improves(tmp_path: Path):
    """Append 2 rows manually with realistic metrics; render shows improvement arrows."""
    history = tmp_path / "h.jsonl"

    # First run: lower coverage, higher orphan, older freshness
    _append_row(history, {
        "run_id": "e2e-001",
        "timestamp": "2024-01-01T10:00:00Z",
        "topic": "ai",
        "coverage_density": 0.55,
        "orphan_ratio": 0.30,
        "avg_citations_per_page": 1.5,
        "freshness": "2022-06-01",
        "freshness_source_count": 4,
        "judge_verified_ratio": 0.60,
        "judge_unique_claims": 5,
        "judge_call_count": 7,
        "stop_reason": "max_iter",
    })
    # Second run: better on all dimensions
    _append_row(history, {
        "run_id": "e2e-002",
        "timestamp": "2024-02-01T10:00:00Z",
        "topic": "ai",
        "coverage_density": 0.80,
        "orphan_ratio": 0.10,
        "avg_citations_per_page": 3.0,
        "freshness": "2024-01-01",
        "freshness_source_count": 6,
        "judge_verified_ratio": 0.85,
        "judge_unique_claims": 7,
        "judge_call_count": 9,
        "stop_reason": "max_iter",
    })

    result = _run_dashboard("--history-path", str(history))
    assert result.returncode == 0
    # Both improving directions should appear
    assert "↑ improving" in result.stdout, (
        f"Expected improvement arrows in Trends:\n{result.stdout}"
    )
    # Freshness improved from 2022 -> 2024
    assert "↑ improving" in result.stdout


# ---------------------------------------------------------------------------
# T15-3: wiki with few dated sources -> freshness reported as null
# ---------------------------------------------------------------------------

def test_e2e_freshness_undated_skipped(tmp_path: Path):
    """Wiki with 5 sources but only 1 dated -> freshness=None (below threshold of 3)."""
    wiki = tmp_path / "wiki"
    wiki.mkdir()

    # 5 URLs but only 1 has a parseable date
    (wiki / "page.md").write_text(
        "# Page\n\n"
        "See https://example.com/a\n"
        "See https://example.com/b\n"
        "See https://example.com/c\n"
        "See https://example.com/d\n"
        "(source: https://arxiv.org/abs/2308.55555, date: 2023-08-01)\n",
        encoding="utf-8",
    )
    report = _make_report(tmp_path)

    ac_result = subprocess.run(
        [
            "python3", _AUTO_CHECK,
            "--report", str(report),
            "--wiki-dir", str(wiki),
            "--json",
        ],
        capture_output=True, text=True,
    )
    assert ac_result.returncode == 0, (
        f"auto_check.py failed\nstderr: {ac_result.stderr}"
    )

    data = json.loads(ac_result.stdout)
    wiki_data = data.get("wiki", {})
    assert "error" not in wiki_data, f"Unexpected error: {wiki_data.get('error')}"
    assert wiki_data.get("freshness") is None, (
        f"Expected freshness=None with only 1 dated source, "
        f"got {wiki_data.get('freshness')}"
    )
    assert wiki_data.get("freshness_source_count", 0) < 3, (
        "freshness_source_count should be < 3"
    )
    note = wiki_data.get("freshness_note", "")
    assert note and "insufficient" in note.lower(), (
        f"Expected 'insufficient' in freshness_note, got: {note!r}"
    )


# ---------------------------------------------------------------------------
# T15-4: judge dedup with latest-contradicted overrides earlier-verified
# ---------------------------------------------------------------------------

def test_e2e_judge_dedup_affects_ratio(tmp_path: Path):
    """
    Dedup fixture: claim A's latest verdict is contradicted -> A counts as not-verified.
    Setup: A verified@t1, A contradicted@t2 (latest), B verified@t3.
    Expected: 2 unique claims, 1 verified (B only) -> ratio = 0.5.
    """
    db_path = tmp_path / "dedup.sqlite"
    _make_sqlite_with_judge_rows(db_path, [
        {"timestamp": "2024-01-01T10:00:00", "operation": "judge_claim",
         "details": {"claim": "A", "verdict": "verified"}},
        {"timestamp": "2024-01-01T12:00:00", "operation": "judge_claim",
         "details": {"claim": "A", "verdict": "contradicted"}},  # latest for A
        {"timestamp": "2024-01-01T11:00:00", "operation": "judge_claim",
         "details": {"claim": "B", "verdict": "verified"}},
    ])

    wiki = _make_wiki_dir(tmp_path)
    report = _make_report(tmp_path)

    ac_result = subprocess.run(
        [
            "python3", _AUTO_CHECK,
            "--report", str(report),
            "--wiki-dir", str(wiki),
            "--index-path", str(db_path),
            "--json",
        ],
        capture_output=True, text=True,
    )
    assert ac_result.returncode == 0, (
        f"auto_check.py failed\nstderr: {ac_result.stderr}"
    )

    data = json.loads(ac_result.stdout)
    wiki_data = data.get("wiki", {})
    assert "error" not in wiki_data, f"Unexpected error: {wiki_data.get('error')}"

    ratio = wiki_data.get("judge_verified_ratio")
    unique = wiki_data.get("judge_unique_claims")
    assert unique == 2, f"Expected 2 unique claims, got {unique}"
    assert ratio is not None, "judge_verified_ratio should not be None"
    assert abs(ratio - 0.5) < 0.001, (
        f"Expected judge_verified_ratio=0.5 (1 of 2 claims verified), got {ratio}"
    )
