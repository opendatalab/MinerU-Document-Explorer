#!/usr/bin/env bash
#
# DeepResearch 2.0 — 顶层一键编排
#
# 此脚本封装：
#   setup   抓取资料 + qmd 索引（不调 LLM）
#   serve   启动 MCP HTTP 服务器（前台）
#   check   自动检查两份研报 + 评分
#   doctor  环境体检：依赖 / qmd / 索引
#   clean   清理 sources / output / index
#
# 智能阶段（Wiki / 研报 / 对比 / 评估）由 Agent 通过 MCP 完成，
# 把 deepresearch/prompts/ 下的 4 份 markdown 顺序投喂给它即可。
#
# Usage:
#   bash deepresearch/run.sh setup   [--topic <yml>] [--max N] [--skip-embed]
#   bash deepresearch/run.sh serve   [--port 8181]
#   bash deepresearch/run.sh check   [--topic <yml>]
#   bash deepresearch/run.sh doctor
#   bash deepresearch/run.sh clean   [--all]

set -euo pipefail
cd "$(dirname "$0")/.."

CMD="${1:-help}"
shift || true

TOPIC="deepresearch/topics/document-parsing.yml"
INDEX_NAME="deepresearch"
PORT="8181"

QMD_CMD=()
if command -v qmd &>/dev/null; then QMD_CMD=(qmd)
elif command -v bun &>/dev/null; then QMD_CMD=(bun src/cli/qmd.ts)
fi

usage() {
  grep '^#' "$0" | head -25
}

cmd_setup() {
  bash deepresearch/scripts/setup.sh --topic "$TOPIC" "$@"
}

cmd_serve() {
  if [ "${#QMD_CMD[@]}" -eq 0 ]; then
    echo "ERROR: 未找到 qmd 或 bun" >&2; exit 1
  fi
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port) PORT="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  echo "启动 MCP HTTP（端口 $PORT, 索引 $INDEX_NAME）..."
  "${QMD_CMD[@]}" --index "$INDEX_NAME" mcp --http --port "$PORT"
}

cmd_doctor() {
  echo "== DeepResearch 2.0 doctor =="
  python3 --version 2>/dev/null && echo "  python3 ✓" || { echo "  python3 ✗"; }
  python3 -c "import feedparser" 2>/dev/null && echo "  feedparser ✓" || echo "  feedparser ✗ (pip install feedparser)"
  python3 -c "import yaml" 2>/dev/null && echo "  pyyaml ✓" || echo "  pyyaml ✗ (pip install pyyaml)"
  python3 -c "import bs4, html2text" 2>/dev/null && echo "  bs4+html2text ✓ (可选)" || echo "  bs4+html2text ✗ 可选 (pip install beautifulsoup4 html2text)"
  python3 -c "import pymupdf" 2>/dev/null && echo "  pymupdf ✓" || echo "  pymupdf ✗ (pip install pymupdf)"
  if [ "${#QMD_CMD[@]}" -gt 0 ]; then
    echo "  qmd: ${QMD_CMD[*]}"
    "${QMD_CMD[@]}" --index "$INDEX_NAME" status 2>&1 | head -10 || true
  else
    echo "  qmd ✗ — 安装 qmd 或 bun"
  fi
  if [ -n "${MINERU_API_KEY:-}" ]; then echo "  MINERU_API_KEY ✓"; fi
  if [ -f "$TOPIC" ]; then echo "  topic ✓ $TOPIC"; else echo "  topic ✗ $TOPIC"; fi
  echo ""
  echo "目录："
  for d in sources/papers sources/blogs sources/repos output/wiki output/reports output/evaluation; do
    p="deepresearch/$d"
    if [ -d "$p" ]; then
      n=$(find "$p" -maxdepth 2 -type f 2>/dev/null | wc -l | tr -d ' ')
      echo "  $p: $n 个文件"
    else
      echo "  $p: 不存在"
    fi
  done
}

cmd_check() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --topic) TOPIC="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  WIKI_REPORT="deepresearch/output/reports/wiki-first.md"
  DIRECT_REPORT="deepresearch/output/reports/direct.md"
  WIKI_EVAL="deepresearch/output/evaluation/wiki-first.json"
  DIRECT_EVAL="deepresearch/output/evaluation/direct.json"

  for f in "$WIKI_REPORT" "$DIRECT_REPORT"; do
    if [ -f "$f" ]; then
      echo "── auto_check: $f ──"
      python3 deepresearch/eval/auto_check.py --report "$f" --topic "$TOPIC"
      echo ""
    else
      echo "(skip) $f 不存在"
    fi
  done

  if [ -f "$WIKI_EVAL" ] && [ -f "$DIRECT_EVAL" ]; then
    echo "── score ──"
    python3 deepresearch/eval/score.py \
      --wiki "$WIKI_EVAL" --direct "$DIRECT_EVAL" \
      --out deepresearch/output/evaluation/summary.json \
      --out-md deepresearch/output/evaluation/summary.md
    echo ""
    echo "── summary ──"
    cat deepresearch/output/evaluation/summary.md
  else
    echo "(skip score) Agent 还未写入 $WIKI_EVAL 或 $DIRECT_EVAL"
    echo "  Agent 需按 prompts/04-EVALUATE-zh.md 产出后再跑一次。"
  fi
}

cmd_clean() {
  ALL=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --all) ALL=true; shift ;;
      *) shift ;;
    esac
  done
  rm -rf deepresearch/output/wiki/* deepresearch/output/reports/* deepresearch/output/evaluation/*
  echo "已清空 deepresearch/output/"
  if [ "$ALL" = true ]; then
    rm -rf deepresearch/sources/papers/* deepresearch/sources/blogs/* deepresearch/sources/repos/*
    rm -f "$HOME/.cache/qmd/$INDEX_NAME.sqlite"
    echo "已清空 sources/ 与索引"
  fi
}

case "$CMD" in
  setup) cmd_setup "$@" ;;
  serve) cmd_serve "$@" ;;
  check) cmd_check "$@" ;;
  doctor) cmd_doctor ;;
  clean) cmd_clean "$@" ;;
  help|-h|--help|"") usage ;;
  *) echo "未知命令: $CMD"; usage; exit 1 ;;
esac
