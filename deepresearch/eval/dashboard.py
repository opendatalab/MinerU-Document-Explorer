#!/usr/bin/env python3
"""
DeepResearch 2.0 — Dashboard

Two modes:

  --append   Append one metrics row to metrics-history.jsonl (called by build-wiki evaluate stage).
  (default)  Render a Markdown trend table from metrics-history.jsonl.

Usage (append):
  python3 deepresearch/eval/dashboard.py --append \\
    --topic TOPIC_SLUG --run-id RUN_ID \\
    --coverage FLOAT --orphan FLOAT --citations FLOAT \\
    --freshness ISO_DATE_OR_NULL --freshness-count INT \\
    --judge-verified-ratio FLOAT_OR_NULL \\
    --judge-unique-claims INT --judge-call-count INT \\
    --stop-reason STR [--history-path PATH]

Usage (render):
  python3 deepresearch/eval/dashboard.py \\
    [--topic TOPIC] [--last N] [--history-path PATH] [--output PATH]
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_HISTORY_PATH = Path("deepresearch/output/evaluation/metrics-history.jsonl")

FOOTER_TEXT = (
    "> Note: `judge_verified_ratio` reflects agent self-assessment at judge-call time, "
    "not independent verification. Treat as a lower bound on verification quality."
)

# Metrics included in the Trends section, in display order.
# (field_name, display_label, higher_is_better)
TREND_METRICS: list[tuple[str, str, bool]] = [
    ("coverage_density",        "coverage_density",        True),
    ("orphan_ratio",            "orphan_ratio",            False),
    ("avg_citations_per_page",  "avg_citations_per_page",  True),
    ("freshness",               "freshness",               True),   # special handling
    ("judge_verified_ratio",    "judge_verified_ratio",    True),
]


# ---------------------------------------------------------------------------
# JSONL helpers
# ---------------------------------------------------------------------------

def _load_history(path: Path) -> list[dict[str, Any]]:
    """Read JSONL; skip malformed lines with a stderr warning."""
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, start=1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                rows.append(json.loads(raw))
            except json.JSONDecodeError:
                print(f"[warn] skipping malformed line {lineno}", file=sys.stderr)
    return rows


def _append_row(path: Path, row: dict[str, Any]) -> None:
    """Atomically append one JSONL line."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        fh.flush()


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------

def _fmt(value: Any, field: str) -> str:
    """Format a cell value for the Runs table."""
    if value is None:
        return "—"
    if field == "freshness":
        # Truncate to YYYY-MM
        s = str(value)
        return s[:7] if len(s) >= 7 else s
    if field == "timestamp":
        # Truncate to date
        s = str(value)
        return s[:10] if len(s) >= 10 else s
    if isinstance(value, float):
        return f"{value:.2f}"
    return str(value)



def _parse_date_robust(s: str | None) -> date | None:
    """Robust date parser for freshness strings (YYYY-MM-DD or YYYY-MM)."""
    if not s:
        return None
    s = str(s).strip()
    # Try full date first, then year-month only
    for fmt, length in (("%Y-%m-%d", 10), ("%Y-%m", 7)):
        try:
            return datetime.strptime(s[:length], fmt).date()
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------------------
# Trend computation
# ---------------------------------------------------------------------------

def _compute_trends(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Compute trend rows for TREND_METRICS using first and last displayed run.
    Returns list of dicts with: metric, first, latest, delta, direction.
    """
    first = rows[0]
    last = rows[-1]
    trends = []

    for field, label, higher_is_better in TREND_METRICS:
        fv = first.get(field)
        lv = last.get(field)

        if fv is None or lv is None:
            continue  # skip if either endpoint is missing

        if field == "freshness":
            fd = _parse_date_robust(fv)
            ld = _parse_date_robust(lv)
            if fd is None or ld is None:
                continue
            delta_days = (ld - fd).days
            delta_str = f"+{delta_days}d" if delta_days >= 0 else f"{delta_days}d"
            if delta_days > 0:
                direction = "↑ improving"
            elif delta_days < 0:
                direction = "↓ declining"
            else:
                direction = "→ flat"
            trends.append({
                "metric": label,
                "first": _fmt(fv, "freshness"),
                "latest": _fmt(lv, "freshness"),
                "delta": delta_str,
                "direction": direction,
            })
        else:
            try:
                fnum = float(fv)
                lnum = float(lv)
            except (TypeError, ValueError):
                continue
            delta = lnum - fnum
            delta_str = f"+{delta:.2f}" if delta >= 0 else f"{delta:.2f}"

            if higher_is_better:
                if delta > 0:
                    direction = "↑ improving"
                elif delta < 0:
                    direction = "↓ declining"
                else:
                    direction = "→ flat"
            else:
                # lower is better (orphan_ratio)
                if delta < 0:
                    direction = "↑ improving (lower is better)"
                elif delta > 0:
                    direction = "↓ declining"
                else:
                    direction = "→ flat"

            trends.append({
                "metric": label,
                "first": f"{fnum:.2f}",
                "latest": f"{lnum:.2f}",
                "delta": delta_str,
                "direction": direction,
            })

    return trends


# ---------------------------------------------------------------------------
# Markdown renderer
# ---------------------------------------------------------------------------

def _render_markdown(
    rows: list[dict[str, Any]],
    topic_filter: str | None,
    total_count: int,
) -> str:
    lines: list[str] = []

    # Header
    lines.append("# DeepResearch 2.0 — Dashboard")
    lines.append("")

    # Summary line
    if topic_filter:
        lines.append(f"Topic: {topic_filter} | Last {len(rows)} runs (of {total_count} total).")
    else:
        lines.append(f"Last {len(rows)} runs (of {total_count} total).")
    lines.append("")

    # --- Runs section ---
    lines.append("## Runs")
    lines.append("")

    if not rows:
        lines.append("No history yet.")
        lines.append("")
    else:
        # Table header
        lines.append("| Run ID | Timestamp | Coverage | Orphan | Citations | Freshness | Judge✓ | Stop |")
        lines.append("|---|---|---:|---:|---:|---:|---:|---|")
        for row in rows:
            cells = [
                _fmt(row.get("run_id"),                "run_id"),
                _fmt(row.get("timestamp"),             "timestamp"),
                _fmt(row.get("coverage_density"),      "float"),
                _fmt(row.get("orphan_ratio"),          "float"),
                _fmt(row.get("avg_citations_per_page"),"float"),
                _fmt(row.get("freshness"),             "freshness"),
                _fmt(row.get("judge_verified_ratio"),  "float"),
                _fmt(row.get("stop_reason"),           "str"),
            ]
            lines.append("| " + " | ".join(cells) + " |")
        lines.append("")

    # --- Trends section ---
    lines.append("## Trends (last {} runs)".format(len(rows)))
    lines.append("")

    if len(rows) < 2:
        lines.append("Insufficient data for trend analysis (need ≥ 2 runs).")
    else:
        trends = _compute_trends(rows)
        if trends:
            lines.append("| Metric | First | Latest | Δ | Direction |")
            lines.append("|---|---:|---:|---:|---|")
            for t in trends:
                lines.append(
                    f"| {t['metric']} | {t['first']} | {t['latest']} | {t['delta']} | {t['direction']} |"
                )
        else:
            lines.append("Insufficient data for trend analysis (need ≥ 2 runs).")
    lines.append("")

    # --- Footer ---
    lines.append("## Footer")
    lines.append("")
    lines.append(FOOTER_TEXT)
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Mode: append
# ---------------------------------------------------------------------------

def cmd_append(args: argparse.Namespace) -> None:
    history_path = Path(args.history_path)

    # Parse freshness (may be "null" string or None)
    freshness: str | None = args.freshness
    if freshness and freshness.lower() == "null":
        freshness = None

    # Parse judge_verified_ratio (may be "null" string or None)
    judge_verified_ratio: float | None = None
    if args.judge_verified_ratio is not None and str(args.judge_verified_ratio).lower() != "null":
        try:
            judge_verified_ratio = float(args.judge_verified_ratio)
        except (TypeError, ValueError):
            judge_verified_ratio = None

    now_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    row: dict[str, Any] = {
        "run_id":                  args.run_id,
        "timestamp":               now_ts,
        "topic":                   args.topic,
        "coverage_density":        float(args.coverage),
        "orphan_ratio":            float(args.orphan),
        "avg_citations_per_page":  float(args.citations),
        "freshness":               freshness,
        "freshness_source_count":  int(args.freshness_count),
        "judge_verified_ratio":    judge_verified_ratio,
        "judge_unique_claims":     int(args.judge_unique_claims),
        "judge_call_count":        int(args.judge_call_count),
        "stop_reason":             args.stop_reason,
    }

    _append_row(history_path, row)
    print(f"[dashboard] appended row for run_id={args.run_id} → {history_path}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Mode: render
# ---------------------------------------------------------------------------

def cmd_render(args: argparse.Namespace) -> None:
    history_path = Path(args.history_path)
    rows = _load_history(history_path)

    # Filter by topic
    if args.topic:
        rows = [r for r in rows if r.get("topic") == args.topic]

    total_count = len(rows)

    # Take last N
    if args.last is not None and args.last > 0:
        rows = rows[-args.last:]

    md = _render_markdown(rows, topic_filter=args.topic, total_count=total_count)

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(md, encoding="utf-8")
        print(f"[dashboard] wrote report → {out_path}", file=sys.stderr)
    else:
        print(md, end="")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dashboard.py",
        description="DeepResearch 2.0 metrics dashboard. Default mode renders Markdown; --append mode records a run.",
    )
    parser.add_argument(
        "--history-path",
        default=str(DEFAULT_HISTORY_PATH),
        metavar="PATH",
        help=f"Path to metrics-history.jsonl (default: {DEFAULT_HISTORY_PATH})",
    )

    # --- Append mode ---
    ap = parser.add_argument_group("append mode (--append)")
    ap.add_argument("--append", action="store_true", help="Append a new metrics row instead of rendering.")
    ap.add_argument("--topic",              metavar="SLUG",  help="Topic slug (e.g. document-parsing).")
    ap.add_argument("--run-id",             metavar="ID",    help="Run identifier (e.g. bw-20260426T100000Z).")
    ap.add_argument("--coverage",           metavar="FLOAT", help="coverage_density (0–1).")
    ap.add_argument("--orphan",             metavar="FLOAT", help="orphan_ratio (0–1).")
    ap.add_argument("--citations",          metavar="FLOAT", help="avg_citations_per_page.")
    ap.add_argument("--freshness",          metavar="DATE",  help="Median freshness date (ISO) or 'null'.")
    ap.add_argument("--freshness-count",    metavar="INT",   default="0", help="Number of dated sources.")
    ap.add_argument("--judge-verified-ratio", metavar="FLOAT", default=None, help="judge_verified_ratio or 'null'.")
    ap.add_argument("--judge-unique-claims", metavar="INT",  default="0", help="Unique claim count.")
    ap.add_argument("--judge-call-count",   metavar="INT",   default="0", help="Total judge call count.")
    ap.add_argument("--stop-reason",        metavar="STR",   default=None, help="Stop reason string.")

    # --- Render mode ---
    rp = parser.add_argument_group("render mode (default)")
    rp.add_argument("--last",   type=int, default=None, metavar="N",    help="Show only last N runs.")
    rp.add_argument("--output", default=None,           metavar="PATH", help="Write output to file (default: stdout).")
    # Note: --topic is shared between both modes (already added above).

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.append:
        # Validate required append args
        missing = [f for f in ("topic", "run_id", "coverage", "orphan", "citations")
                   if not getattr(args, f.replace("-", "_"), None)]
        if missing:
            parser.error(f"--append requires: {', '.join('--' + f.replace('_', '-') for f in missing)}")
        cmd_append(args)
    else:
        cmd_render(args)


if __name__ == "__main__":
    main()
