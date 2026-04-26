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

Usage:
  python3 deepresearch/eval/auto_check.py --report deepresearch/output/reports/wiki-first.md
  python3 deepresearch/eval/auto_check.py --report ... --json
  python3 deepresearch/eval/auto_check.py --report ... --topic deepresearch/topics/document-parsing.yml --json
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
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True)
    ap.add_argument("--topic", default="deepresearch/topics/document-parsing.yml")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    report_path = Path(args.report)
    if not report_path.exists():
        print(f"ERROR: 报告不存在：{report_path}", file=sys.stderr)
        sys.exit(1)

    topic_cfg = load_yaml_safely(Path(args.topic))
    if topic_cfg is None:
        print("提示: 未读取到 topic 配置（pyyaml 缺失或路径错），coverage 检查会返回 0/0", file=sys.stderr)

    data = analyze(report_path, topic_cfg)
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(render_human(data))


if __name__ == "__main__":
    main()
