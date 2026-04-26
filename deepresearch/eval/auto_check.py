#!/usr/bin/env python3
"""
DeepResearch 2.0 — 研报自动检查

对一份 markdown 研报，输出客观下限指标（不替代 Agent 主观打分）：

  - section_count, headings_balance（章节数、字数标准差）
  - sentence_count, claim_sentences（结论级句子数：含数字 / 比较 / 推荐）
  - citation_count（行内 (source: ...) 与 [[wikilinks]] 数）
  - citation_ratio = citation_count / max(claim_sentences, 1)
  - wikilink_count, inline_source_count
  - coverage_hits（基于 topic.yml 的 research_questions 关键词探测）
  - structure_score（粗略 0–100，仅供参考）

Wiki scoring (opt-in via --wiki-dir):
  - research_questions_coverage: fraction of research_questions covered by wiki pages
  - orphan_ratio: fraction of wiki pages with no inbound links
  - avg_citations_per_page: average citation count per wiki page

Usage:
  python3 deepresearch/eval/auto_check.py --report deepresearch/output/reports/wiki-first.md
  python3 deepresearch/eval/auto_check.py --report ... --json
  python3 deepresearch/eval/auto_check.py --report ... --topic deepresearch/topics/document-parsing.yml --json
  python3 deepresearch/eval/auto_check.py --report ... --wiki-dir deepresearch/output/wiki --topic ... --json
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from pathlib import Path

try:
    import yaml  # type: ignore
    HAS_YAML = True
except ImportError:
    HAS_YAML = False


HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)
WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")
INLINE_SOURCE_RE = re.compile(r"\(source:\s*([^)]+)\)", re.IGNORECASE)
NUMBER_RE = re.compile(r"\d+(\.\d+)?\s*(%|x|×|\bGB\b|\bms\b|\b分\b)?")
COMPARISON_RE = re.compile(
    r"(优于|强于|超过|领先|提升|下降|不如|落后于|相比|对比|>|>=|≥|<|≤|<=|"
    r"better than|outperforms?|surpass|inferior|compared to|vs\.?\s)"
)
RECOMMEND_RE = re.compile(
    r"(建议|推荐|应当|应该|必须|不应|避免|首选|应优先|"
    r"recommend|should|must|prefer|avoid)"
)
SENT_SPLIT_RE = re.compile(r"(?<=[。！？!?\.])\s+|\n\n+")

CONCLUSION_KEYWORDS = ("综上", "总结", "结论", "因此", "可见", "我们认为")


def load_yaml_safely(path: Path) -> dict | None:
    if not path.exists():
        return None
    if HAS_YAML:
        try:
            return yaml.safe_load(path.read_text())
        except Exception:
            pass
    # 无 pyyaml 时的极简 fallback：只解析 research_questions 列表
    try:
        text = path.read_text()
        m = re.search(r"^research_questions:\s*\n((?:\s+-\s+.+\n?)+)", text, re.MULTILINE)
        if not m:
            return None
        block = m.group(1)
        items = re.findall(r"^\s+-\s+(.+?)\s*$", block, re.MULTILINE)
        return {"research_questions": items}
    except Exception:
        return None


def is_claim_sentence(s: str) -> bool:
    """判定是否结论级语句：含数字 / 比较 / 推荐 / 显式总结。"""
    s = s.strip()
    if len(s) < 8:
        return False
    if NUMBER_RE.search(s):
        return True
    if COMPARISON_RE.search(s):
        return True
    if RECOMMEND_RE.search(s):
        return True
    if any(k in s for k in CONCLUSION_KEYWORDS):
        return True
    return False


def has_citation(s: str) -> bool:
    return bool(WIKILINK_RE.search(s) or INLINE_SOURCE_RE.search(s))


def split_sections(md: str) -> list[tuple[str, str]]:
    """按 ## 一级章节切片，返回 [(title, body), ...]。"""
    parts: list[tuple[str, str]] = []
    lines = md.splitlines()
    cur_title = "PRELUDE"
    cur_body: list[str] = []
    for ln in lines:
        m = re.match(r"^##\s+(.+?)\s*$", ln)
        if m:
            if cur_body:
                parts.append((cur_title, "\n".join(cur_body)))
            cur_title = m.group(1)
            cur_body = []
        else:
            cur_body.append(ln)
    if cur_body:
        parts.append((cur_title, "\n".join(cur_body)))
    return parts


def detect_coverage(md: str, topic_cfg: dict | None) -> dict:
    """基于 research_questions 的粗糙关键词命中。"""
    if not topic_cfg:
        return {"hits": 0, "total": 0, "details": []}
    qs = topic_cfg.get("research_questions") or []
    md_lower = md.lower()
    details = []
    hits = 0
    for q in qs:
        # 取问题里中等长度的中文片段做关键词
        keys = []
        # 中文短语：>=2 个 CJK 字符
        for m in re.finditer(r"[一-鿿]{2,8}", q):
            keys.append(m.group(0))
        # 英文 token：长度 >=4
        for m in re.finditer(r"[A-Za-z][A-Za-z0-9\-]{3,}", q):
            keys.append(m.group(0).lower())
        keys = list(dict.fromkeys(keys))[:6]
        hit_count = sum(1 for k in keys if k.lower() in md_lower)
        ok = hit_count >= max(2, len(keys) // 2)
        details.append({"question": q, "keys": keys, "hit_count": hit_count, "ok": ok})
        if ok:
            hits += 1
    return {"hits": hits, "total": len(qs), "details": details}


def section_balance(sections: list[tuple[str, str]]) -> dict:
    word_counts = []
    for title, body in sections:
        if title == "PRELUDE":
            continue
        # 中文字数 + 英文 token 数
        cn = len(re.findall(r"[一-鿿]", body))
        en = len(re.findall(r"[A-Za-z][A-Za-z0-9]+", body))
        word_counts.append(cn + en)
    if len(word_counts) < 2:
        return {"sections": len(word_counts), "stddev_ratio": 0.0, "counts": word_counts}
    mean = statistics.mean(word_counts)
    sd = statistics.pstdev(word_counts)
    ratio = (sd / mean) if mean else 0.0
    return {
        "sections": len(word_counts),
        "mean": round(mean, 1),
        "stddev": round(sd, 1),
        "stddev_ratio": round(ratio, 3),
        "counts": word_counts,
    }


def compute_structure_score(headings: int, balance: dict, has_intro: bool, has_conclusion: bool) -> int:
    score = 100
    if headings < 4:
        score -= 25
    elif headings < 6:
        score -= 10
    sr = balance.get("stddev_ratio", 0.0)
    if sr > 0.7:
        score -= 20
    elif sr > 0.5:
        score -= 10
    if not has_intro:
        score -= 10
    if not has_conclusion:
        score -= 10
    return max(0, min(100, score))


def analyze(report_path: Path, topic_cfg: dict | None) -> dict:
    md = report_path.read_text()
    headings = HEADING_RE.findall(md)
    sections = split_sections(md)

    # 句子级
    sentences = [s for s in SENT_SPLIT_RE.split(md) if s.strip()]
    sentences = [s for s in sentences if not s.lstrip().startswith("#")]
    claim_sents = [s for s in sentences if is_claim_sentence(s)]
    cited_claims = [s for s in claim_sents if has_citation(s)]
    citation_ratio = round(len(cited_claims) / max(len(claim_sents), 1), 3)

    wikilinks = WIKILINK_RE.findall(md)
    inline_sources = INLINE_SOURCE_RE.findall(md)

    balance = section_balance(sections)
    coverage = detect_coverage(md, topic_cfg)

    titles_lower = [t.lower() for t, _ in sections]
    has_intro = any(re.search(r"(引言|introduction|摘要|abstract|tl;dr|tldr)", t) for t in titles_lower)
    has_conclusion = any(re.search(r"(结论|conclusion|总结|take[- ]?away)", t) for t in titles_lower)

    structure = compute_structure_score(
        headings=len(headings), balance=balance, has_intro=has_intro, has_conclusion=has_conclusion
    )

    return {
        "report": str(report_path),
        "headings_total": len(headings),
        "section_balance": balance,
        "sentence_count": len(sentences),
        "claim_sentences": len(claim_sents),
        "cited_claims": len(cited_claims),
        "citation_ratio": citation_ratio,
        "wikilink_count": len(wikilinks),
        "inline_source_count": len(inline_sources),
        "coverage": coverage,
        "structure_score": structure,
        "has_intro": has_intro,
        "has_conclusion": has_conclusion,
    }


# ---------------------------------------------------------------------------
# Wiki scoring helpers
# ---------------------------------------------------------------------------

# Matches [[wikilinks]] and relative markdown links like [text](path.md)
WIKI_LINK_RE = re.compile(r"\[\[([^\]]+)\]\]|\[(?:[^\]]*)\]\(([^)]+\.md[^)]*)\)")
# Matches any citation: http/https URL, [[wikilink]], (source: ...), numeric footnote,
# "Source:" / "来源：" patterns
CITATION_ANY_RE = re.compile(
    r"https?://\S+"                    # bare/inline URL
    r"|\[\[[^\]]+\]\]"                 # [[wikilink]]
    r"|\(source:\s*[^)]+\)"            # (source: ...)
    r"|\[?\^[A-Za-z0-9_]+\]?"         # numeric/named footnote [^1] or ^1
    r"|\bSource[s]?:\s*\S"            # "Source: ..."
    r"|来源[：:]\s*\S",               # "来源：..."
    re.IGNORECASE,
)


def _meaningful_tokens(text: str) -> list[str]:
    """Extract CJK phrases (>=2 chars) and Latin words (>=3 chars) from text."""
    tokens: list[str] = []
    for m in re.finditer(r"[一-鿿]{2,}", text):
        tokens.append(m.group(0))
    for m in re.finditer(r"[A-Za-z]{3,}", text):
        tokens.append(m.group(0).lower())
    return list(dict.fromkeys(tokens))


def _page_matches_question(page_body: str, question: str) -> bool:
    """
    Return True if the page body matches the question.
    Match conditions (OR):
      1. Question appears as a heading (##+ ... text ...) — fuzzy: >=60% token overlap
      2. >=40% of meaningful tokens from the question appear in the page body
    """
    body_lower = page_body.lower()
    q_tokens = _meaningful_tokens(question)
    if not q_tokens:
        return False

    # Condition 2: token overlap in full body
    hit_count = sum(1 for t in q_tokens if t in body_lower)
    if hit_count / len(q_tokens) >= 0.40:
        return True

    # Condition 1: question as heading (higher threshold but still fuzzy)
    for m in HEADING_RE.finditer(page_body):
        heading_text = m.group(2).lower()
        h_tokens = _meaningful_tokens(heading_text)
        if not h_tokens:
            continue
        overlap = sum(1 for t in q_tokens if t in heading_text)
        if overlap / len(q_tokens) >= 0.60:
            return True

    return False


def _collect_wiki_pages(wiki_dir: Path) -> list[tuple[str, str]]:
    """
    Return list of (relative_path, body) for all .md files under wiki_dir.
    Paths are relative to wiki_dir (forward slashes).
    """
    pages: list[tuple[str, str]] = []
    for p in sorted(wiki_dir.rglob("*.md")):
        try:
            body = p.read_text(encoding="utf-8", errors="replace")
            rel = p.relative_to(wiki_dir).as_posix()
            pages.append((rel, body))
        except OSError:
            pass
    return pages


def _extract_outbound_links(rel_path: str, body: str) -> set[str]:
    """
    Extract all outbound link targets from a wiki page body.
    Returns a set of normalised relative paths (forward slash, no fragment).
    """
    targets: set[str] = []
    page_dir = rel_path.rsplit("/", 1)[0] if "/" in rel_path else ""
    for m in WIKI_LINK_RE.finditer(body):
        wikilink = m.group(1)  # [[target]]
        md_link = m.group(2)   # [text](target.md)
        raw = wikilink or md_link
        if not raw:
            continue
        # strip fragment
        raw = raw.split("#")[0].strip()
        if not raw:
            continue
        # normalise: if wikilink without extension, add .md
        if m.group(1) and not raw.endswith(".md"):
            raw = raw + ".md"
        # resolve relative to page dir
        if page_dir and not raw.startswith("/"):
            resolved = page_dir + "/" + raw
        else:
            resolved = raw.lstrip("/")
        # simple normalisation: collapse a/b/../c → a/c
        parts = []
        for part in resolved.split("/"):
            if part == "..":
                if parts:
                    parts.pop()
            elif part and part != ".":
                parts.append(part)
        targets.append("/".join(parts))
    return set(targets)


def _count_citations(body: str) -> int:
    """Count citation occurrences in a page body."""
    return len(CITATION_ANY_RE.findall(body))


def score_wiki_questions_coverage(
    pages: list[tuple[str, str]],
    research_questions: list[str],
) -> dict:
    """Score research_questions coverage across wiki pages."""
    matched: list[dict] = []
    unmatched: list[str] = []
    for q in research_questions:
        hitting_pages = [
            rel for rel, body in pages if _page_matches_question(body, q)
        ]
        if hitting_pages:
            matched.append({"q": q, "pages": hitting_pages})
        else:
            unmatched.append(q)
    total = len(research_questions)
    coverage = round(len(matched) / total, 4) if total else 0.0
    return {
        "research_questions_coverage": coverage,
        "matched_questions": matched,
        "unmatched_questions": unmatched,
    }


def score_wiki_orphan_ratio(pages: list[tuple[str, str]]) -> dict:
    """Compute orphan ratio: pages that no other page links to."""
    if not pages:
        return {"orphan_ratio": 0.0, "orphan_pages": [], "total_pages": 0}

    page_paths = {rel for rel, _ in pages}

    # Build set of all pages that are referenced at least once
    referenced: set[str] = set()
    for rel, body in pages:
        for target in _extract_outbound_links(rel, body):
            referenced.add(target)

    orphan_pages = sorted(
        rel for rel in page_paths
        if rel not in referenced
    )
    ratio = round(len(orphan_pages) / len(pages), 4)
    return {
        "orphan_ratio": ratio,
        "orphan_pages": orphan_pages,
        "total_pages": len(pages),
    }


def score_wiki_citations(pages: list[tuple[str, str]]) -> dict:
    """Compute average citations per wiki page."""
    if not pages:
        return {"avg_citations_per_page": 0.0}
    counts = [_count_citations(body) for _, body in pages]
    avg = round(sum(counts) / len(counts), 4)
    return {"avg_citations_per_page": avg}


def score_wiki(
    wiki_dir: Path,
    topic_cfg: dict | None,
    *,
    threshold_coverage: float = 0.70,
    threshold_orphan: float = 0.15,
    threshold_citations: float = 2.0,
) -> dict:
    """
    Orchestrator: compute all wiki-level scoring dimensions.
    Returns a dict ready to embed under the 'wiki' key in the output JSON.
    """
    try:
        if not wiki_dir.exists():
            return {"error": f"wiki_dir not found: {wiki_dir}"}
        if not wiki_dir.is_dir():
            return {"error": f"wiki_dir is not a directory: {wiki_dir}"}

        pages = _collect_wiki_pages(wiki_dir)
        if not pages:
            return {
                "error": "no .md files found in wiki_dir",
                "total_pages": 0,
            }

        result: dict = {}

        # 1. research_questions_coverage
        research_questions: list[str] = []
        if topic_cfg:
            research_questions = topic_cfg.get("research_questions") or []
        if research_questions:
            result.update(score_wiki_questions_coverage(pages, research_questions))
        else:
            result["research_questions_coverage"] = None
            result["matched_questions"] = []
            result["unmatched_questions"] = []

        # 2. orphan_ratio
        orphan_data = score_wiki_orphan_ratio(pages)
        result.update(orphan_data)

        # 3. avg_citations_per_page
        citation_data = score_wiki_citations(pages)
        result.update(citation_data)

        # overall_pass
        coverage = result.get("research_questions_coverage")
        orphan = result.get("orphan_ratio", 1.0)
        avg_cite = result.get("avg_citations_per_page", 0.0)
        if coverage is None:
            overall_pass = None  # cannot determine without questions
        else:
            overall_pass = (
                coverage >= threshold_coverage
                and orphan <= threshold_orphan
                and avg_cite >= threshold_citations
            )
        result["overall_pass"] = overall_pass
        result["thresholds"] = {
            "coverage_min": threshold_coverage,
            "orphan_max": threshold_orphan,
            "citations_min": threshold_citations,
        }
        return result

    except Exception as exc:
        return {"error": str(exc)}


# ---------------------------------------------------------------------------

def render_human(data: dict) -> str:
    lines = []
    lines.append(f"# auto_check: {data['report']}")
    lines.append("")
    lines.append(f"- 标题数: {data['headings_total']}")
    lines.append(
        f"- 章节: {data['section_balance']['sections']}，"
        f"字数 stddev/mean = {data['section_balance']['stddev_ratio']}"
    )
    lines.append(f"- 句子: {data['sentence_count']}, claim 句: {data['claim_sentences']}")
    lines.append(
        f"- 引用: wikilink={data['wikilink_count']} inline_source={data['inline_source_count']}"
    )
    lines.append(f"- citation_ratio = {data['citation_ratio']}")
    cov = data["coverage"]
    lines.append(f"- 覆盖: {cov['hits']}/{cov['total']} research_questions")
    lines.append(f"- structure_score: {data['structure_score']} / 100")
    lines.append(f"- has_intro={data['has_intro']} has_conclusion={data['has_conclusion']}")
    if "wiki" in data:
        w = data["wiki"]
        lines.append("")
        lines.append("## Wiki scoring")
        if "error" in w:
            lines.append(f"- ERROR: {w['error']}")
        else:
            lines.append(f"- total_pages: {w.get('total_pages', '?')}")
            lines.append(f"- research_questions_coverage: {w.get('research_questions_coverage')}")
            lines.append(f"- orphan_ratio: {w.get('orphan_ratio')} (orphans: {w.get('orphan_pages', [])})")
            lines.append(f"- avg_citations_per_page: {w.get('avg_citations_per_page')}")
            lines.append(f"- overall_pass: {w.get('overall_pass')}")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(
        description="DeepResearch 2.0 — 研报自动检查（可选 Wiki 评分）"
    )
    ap.add_argument("--report", required=True, help="研报 markdown 路径")
    ap.add_argument(
        "--topic",
        default="deepresearch/topics/document-parsing.yml",
        help="主题 YAML 路径（用于 research_questions coverage 检测）",
    )
    ap.add_argument(
        "--wiki-dir",
        dest="wiki_dir",
        default=None,
        help="Wiki 集合目录路径（提供后启用 Wiki 评分）",
    )
    ap.add_argument("--json", action="store_true", help="以 JSON 格式输出")
    # Configurable thresholds (override Section 6 POC defaults)
    ap.add_argument(
        "--threshold-coverage",
        dest="threshold_coverage",
        type=float,
        default=0.70,
        help="research_questions_coverage 最低阈值 (default: 0.70)",
    )
    ap.add_argument(
        "--threshold-orphan",
        dest="threshold_orphan",
        type=float,
        default=0.15,
        help="orphan_ratio 最大阈值 (default: 0.15)",
    )
    ap.add_argument(
        "--threshold-citations",
        dest="threshold_citations",
        type=float,
        default=2.0,
        help="avg_citations_per_page 最低阈值 (default: 2.0)",
    )
    args = ap.parse_args()

    report_path = Path(args.report)
    if not report_path.exists():
        print(f"ERROR: 报告不存在：{report_path}", file=sys.stderr)
        sys.exit(1)

    topic_cfg = load_yaml_safely(Path(args.topic))
    if topic_cfg is None:
        print("提示: 未读取到 topic 配置（pyyaml 缺失或路径错），coverage 检查会返回 0/0", file=sys.stderr)

    data = analyze(report_path, topic_cfg)

    # Wiki scoring (opt-in)
    if args.wiki_dir is not None:
        if topic_cfg is None:
            print(
                "警告: --wiki-dir 已指定但 topic YAML 未加载，wiki 覆盖率检测将跳过 research_questions",
                file=sys.stderr,
            )
        data["wiki"] = score_wiki(
            Path(args.wiki_dir),
            topic_cfg,
            threshold_coverage=args.threshold_coverage,
            threshold_orphan=args.threshold_orphan,
            threshold_citations=args.threshold_citations,
        )

    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(render_human(data))


if __name__ == "__main__":
    main()
