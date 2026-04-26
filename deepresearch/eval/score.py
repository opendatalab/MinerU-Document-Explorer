#!/usr/bin/env python3
"""
DeepResearch 2.0 — 综合评分

读取两份 evaluation JSON（由 Agent 按 04-EVALUATE-zh.md 写出），
校验权重一致性，重新计算总分，输出 summary.json + summary.md。

Usage:
  python3 deepresearch/eval/score.py \
      --wiki   deepresearch/output/evaluation/wiki-first.json \
      --direct deepresearch/output/evaluation/direct.json \
      --out    deepresearch/output/evaluation/summary.json \
      [--out-md deepresearch/output/evaluation/summary.md]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


EXPECTED_DIMENSIONS = {
    "source_quality": 20,
    "coverage": 20,
    "traceability": 20,
    "structure": 15,
    "insight": 15,
    "stability": 10,
}


def validate(name: str, data: dict) -> list[str]:
    errors: list[str] = []
    if "dimensions" not in data:
        errors.append(f"{name}: 缺少 dimensions 字段")
        return errors

    dims = {d.get("name"): d for d in data["dimensions"] if isinstance(d, dict)}
    for k, w in EXPECTED_DIMENSIONS.items():
        d = dims.get(k)
        if not d:
            errors.append(f"{name}: 缺少维度 {k}")
            continue
        if d.get("weight") != w:
            errors.append(f"{name}: 维度 {k} 权重应为 {w}，实际 {d.get('weight')}")
        score = d.get("score")
        if not isinstance(score, (int, float)) or not (0 <= score <= w):
            errors.append(f"{name}: 维度 {k} 分数 {score} 超出 [0, {w}]")
        if not d.get("rationale"):
            errors.append(f"{name}: 维度 {k} 未给 rationale")
        if not d.get("evidence"):
            errors.append(f"{name}: 维度 {k} 未给 evidence")
    return errors


def total(data: dict) -> int:
    s = 0
    for d in data.get("dimensions", []):
        v = d.get("score", 0)
        if isinstance(v, (int, float)):
            s += v
    return int(round(s))


def diff_table(wiki: dict, direct: dict) -> list[dict]:
    rows = []
    w_dims = {d["name"]: d for d in wiki.get("dimensions", []) if isinstance(d, dict)}
    d_dims = {d["name"]: d for d in direct.get("dimensions", []) if isinstance(d, dict)}
    for k, w in EXPECTED_DIMENSIONS.items():
        ws = w_dims.get(k, {}).get("score", 0)
        ds = d_dims.get(k, {}).get("score", 0)
        rows.append(
            {"dimension": k, "weight": w, "wiki": ws, "direct": ds, "delta": ws - ds}
        )
    return rows


def render_md(summary: dict) -> str:
    lines = ["# DeepResearch 2.0 评估汇总", ""]
    lines.append(f"- Wiki 先行版总分：**{summary['wiki_total']} / 100**")
    lines.append(f"- 直接生成版总分：**{summary['direct_total']} / 100**")
    lines.append(f"- 总差距：**Δ = {summary['delta']:+d}**")
    lines.append(f"- 评级：Wiki = {summary['wiki_grade']}，Direct = {summary['direct_grade']}")
    lines.append("")
    lines.append("## 维度对比")
    lines.append("")
    lines.append("| 维度 | 权重 | Wiki | Direct | Δ |")
    lines.append("|---|---:|---:|---:|---:|")
    for r in summary["rows"]:
        lines.append(
            f"| {r['dimension']} | {r['weight']} | {r['wiki']} | {r['direct']} | {r['delta']:+d} |"
        )
    lines.append("")
    lines.append("## 备注")
    lines.append("")
    lines.append(f"- Wiki notes: {summary.get('wiki_notes','')}")
    lines.append(f"- Direct notes: {summary.get('direct_notes','')}")
    if summary.get("warnings"):
        lines.append("")
        lines.append("## 警告")
        for w in summary["warnings"]:
            lines.append(f"- ⚠ {w}")
    return "\n".join(lines) + "\n"


def grade(total_score: int) -> str:
    if total_score >= 85:
        return "专家级"
    if total_score >= 70:
        return "工作级"
    if total_score >= 55:
        return "草稿"
    return "不可发"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wiki", required=True)
    ap.add_argument("--direct", required=True)
    ap.add_argument("--out", default="deepresearch/output/evaluation/summary.json")
    ap.add_argument("--out-md", default="deepresearch/output/evaluation/summary.md")
    args = ap.parse_args()

    wiki = json.loads(Path(args.wiki).read_text())
    direct = json.loads(Path(args.direct).read_text())

    warnings: list[str] = []
    warnings += validate("wiki-first", wiki)
    warnings += validate("direct", direct)

    wt = total(wiki)
    dt = total(direct)
    rows = diff_table(wiki, direct)
    summary = {
        "wiki_total": wt,
        "direct_total": dt,
        "delta": wt - dt,
        "wiki_grade": grade(wt),
        "direct_grade": grade(dt),
        "rows": rows,
        "wiki_notes": wiki.get("notes", ""),
        "direct_notes": direct.get("notes", ""),
        "warnings": warnings,
    }
    if dt > wt:
        summary["warnings"].append(
            "Direct 总分高于 Wiki —— 检查 Wiki 编译是否流于形式（最常见原因：evidence 字段缺失）"
        )

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    Path(args.out_md).write_text(render_md(summary))
    print(f"summary -> {args.out}")
    print(f"summary -> {args.out_md}")
    if warnings:
        print(f"⚠ {len(warnings)} 条警告：", file=sys.stderr)
        for w in warnings:
            print(f"   - {w}", file=sys.stderr)


if __name__ == "__main__":
    main()
