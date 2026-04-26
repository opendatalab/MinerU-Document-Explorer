#!/usr/bin/env bash
#
# DeepResearch 2.0 — 一键搭建
#
# 该脚本只做"非智能"工作：
#   1. 抓取主题种子资料（论文 / 博客 / 仓库）
#   2. 用 qmd 索引为可检索数据库
#   3. 创建空的 wiki collection 待 Agent 填充
#
# 智能部分（Wiki 编译、研报撰写、对比、评估）通过 MCP 由 Agent 完成。
#
# Usage:
#   bash deepresearch/scripts/setup.sh \
#        [--topic deepresearch/topics/document-parsing.yml] \
#        [--max 30] [--skip-papers] [--skip-blogs] [--skip-repos] \
#        [--skip-embed] [--skip-index]
#
#   MINERU_API_KEY=xxx bash deepresearch/scripts/setup.sh   # 启用 MinerU 高质量解析

set -euo pipefail
cd "$(dirname "$0")/../.."

# ── 默认参数 ────────────────────────────────────────────────────
TOPIC="deepresearch/topics/document-parsing.yml"
MAX_PAPERS=""
SKIP_PAPERS=false
SKIP_BLOGS=false
SKIP_REPOS=false
SKIP_EMBED=false
SKIP_INDEX=false
INDEX_NAME="deepresearch"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --topic) TOPIC="$2"; shift 2 ;;
    --max) MAX_PAPERS="$2"; shift 2 ;;
    --skip-papers) SKIP_PAPERS=true; shift ;;
    --skip-blogs) SKIP_BLOGS=true; shift ;;
    --skip-repos) SKIP_REPOS=true; shift ;;
    --skip-embed) SKIP_EMBED=true; shift ;;
    --skip-index) SKIP_INDEX=true; shift ;;
    --index-name) INDEX_NAME="$2"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | head -25; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

if [ ! -f "$TOPIC" ]; then
  echo "ERROR: 主题文件不存在: $TOPIC" >&2
  exit 1
fi

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   DeepResearch 2.0 — Setup (data acquisition + indexing)     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "  topic: $TOPIC"
echo "  index: $INDEX_NAME"
echo ""

# ── 依赖检查 ───────────────────────────────────────────────────
if ! command -v python3 &>/dev/null; then
  echo "ERROR: 请安装 Python >= 3.10" >&2; exit 1
fi
PY_OK=$(python3 -c 'import sys; print(int(sys.version_info[:2] >= (3,10)))')
if [ "$PY_OK" != "1" ]; then
  echo "ERROR: Python 版本过低（需要 >= 3.10）" >&2; exit 1
fi

if ! python3 -c "import yaml" 2>/dev/null; then
  echo "ERROR: 缺少 pyyaml。请执行: pip install pyyaml" >&2; exit 1
fi
if ! python3 -c "import feedparser" 2>/dev/null; then
  echo "ERROR: 缺少 feedparser。请执行: pip install feedparser" >&2; exit 1
fi
# 可选依赖（缺失只警告）
python3 -c "import bs4, html2text" 2>/dev/null || \
  echo "  提示: pip install beautifulsoup4 html2text 可改善博客抓取质量"

# ── 选择 qmd 命令 ──────────────────────────────────────────────
QMD_CMD=()
if command -v qmd &>/dev/null; then
  QMD_CMD=(qmd)
elif command -v bun &>/dev/null; then
  QMD_CMD=(bun src/cli/qmd.ts)
else
  echo "ERROR: 未找到 qmd 或 bun" >&2; exit 1
fi

# ── 1. 抓取论文 ────────────────────────────────────────────────
if [ "$SKIP_PAPERS" = false ]; then
  echo "[1/4] 抓取论文..."
  args=(--topic "$TOPIC" --output deepresearch/sources/papers)
  if [ -n "$MAX_PAPERS" ]; then args+=(--max "$MAX_PAPERS"); fi
  python3 deepresearch/scripts/fetch_papers.py "${args[@]}"
else
  echo "[1/4] 跳过论文抓取（--skip-papers）"
fi
echo ""

# ── 2. 抓取博客 ────────────────────────────────────────────────
if [ "$SKIP_BLOGS" = false ]; then
  echo "[2/4] 抓取博客 / 长文..."
  python3 deepresearch/scripts/fetch_blogs.py \
    --topic "$TOPIC" --output deepresearch/sources/blogs || \
    echo "  博客抓取部分失败，已记录到 metadata.json"
else
  echo "[2/4] 跳过博客抓取（--skip-blogs）"
fi
echo ""

# ── 3. 抓取仓库 ────────────────────────────────────────────────
if [ "$SKIP_REPOS" = false ]; then
  echo "[3/4] 抓取仓库 README..."
  python3 deepresearch/scripts/fetch_repos.py \
    --topic "$TOPIC" --output deepresearch/sources/repos || \
    echo "  仓库抓取部分失败，已记录到 metadata.json"
else
  echo "[3/4] 跳过仓库抓取（--skip-repos）"
fi
echo ""

# ── 4. qmd 索引 ────────────────────────────────────────────────
if [ "$SKIP_INDEX" = true ]; then
  echo "[4/4] 跳过索引（--skip-index）"
  exit 0
fi

echo "[4/4] 用 qmd 建立索引..."
if [ -n "${MINERU_API_KEY:-}" ]; then
  echo "  使用 MinerU 云解析（高质量 VLM）"
fi

# 删除旧 collections（幂等）
for c in sources wiki; do
  "${QMD_CMD[@]}" --index "$INDEX_NAME" collection remove "$c" 2>/dev/null || true
done

# 索引论文 PDF
if [ -d deepresearch/sources/papers ] && \
   [ "$(find deepresearch/sources/papers -maxdepth 1 -name '*.pdf' -print -quit)" ]; then
  "${QMD_CMD[@]}" --index "$INDEX_NAME" collection add deepresearch/sources/papers \
    --name papers --mask '**/*.pdf'
  "${QMD_CMD[@]}" --index "$INDEX_NAME" context add qmd://papers \
    "DeepResearch 2.0 主题论文 PDF（trust_level 见 metadata.json）"
fi

# 索引博客
if [ -d deepresearch/sources/blogs ] && \
   [ "$(find deepresearch/sources/blogs -maxdepth 1 -name '*.md' -print -quit)" ]; then
  "${QMD_CMD[@]}" --index "$INDEX_NAME" collection add deepresearch/sources/blogs \
    --name blogs --mask '**/*.md'
  "${QMD_CMD[@]}" --index "$INDEX_NAME" context add qmd://blogs \
    "技术博客与长文（爬取自公开 URL）"
fi

# 索引仓库 README
if [ -d deepresearch/sources/repos ] && \
   [ "$(find deepresearch/sources/repos -maxdepth 1 -name '*.md' -print -quit)" ]; then
  "${QMD_CMD[@]}" --index "$INDEX_NAME" collection add deepresearch/sources/repos \
    --name repos --mask '**/*.md'
  "${QMD_CMD[@]}" --index "$INDEX_NAME" context add qmd://repos \
    "代表性开源仓库 README（含 stars / license / 备注）"
fi

# 索引 Web 搜索结果（由 Agent 通过 web_fetch 工具写入）
mkdir -p deepresearch/sources/web
"${QMD_CMD[@]}" --index "$INDEX_NAME" collection add deepresearch/sources/web \
  --name web --mask '**/*.md'
"${QMD_CMD[@]}" --index "$INDEX_NAME" context add qmd://web \
  "Web search results (fetched and stored by agent via web_fetch)"

# 创建空的 wiki collection
mkdir -p deepresearch/output/wiki
"${QMD_CMD[@]}" --index "$INDEX_NAME" collection add deepresearch/output/wiki \
  --name wiki --type wiki
"${QMD_CMD[@]}" --index "$INDEX_NAME" context add qmd://wiki \
  "DeepResearch 2.0 Wiki（LLM 编译；保存证据、概念页、对比报告）"

# Embedding（可选）
if [ "$SKIP_EMBED" = true ]; then
  echo "  跳过 embedding（--skip-embed）"
else
  echo "  生成向量 embedding（首次会下载模型，可能数分钟）..."
  "${QMD_CMD[@]}" --index "$INDEX_NAME" embed || \
    echo "  embedding 失败，BM25 仍可用"
fi

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                    Setup 完成                                ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "下一步："
echo ""
echo "  # 1. 启动 MCP 服务器（HTTP 模式推荐）"
echo "  ${QMD_CMD[*]} --index $INDEX_NAME mcp --http"
echo ""
echo "  # 2. 把 Agent 接到 MCP 后，按顺序投喂 4 份 prompt:"
echo "     deepresearch/prompts/01-WIKI-FIRST-zh.md   → 构建 Wiki + Wiki 研报"
echo "     deepresearch/prompts/02-DIRECT-zh.md       → 对照：直接生成研报"
echo "     deepresearch/prompts/03-COMPARE-zh.md      → 对比报告"
echo "     deepresearch/prompts/04-EVALUATE-zh.md     → 评分（写 evaluation.json）"
echo ""
echo "  # 3. 运行自动检查"
echo "     python3 deepresearch/eval/auto_check.py --report deepresearch/output/reports/wiki-first.md"
echo "     python3 deepresearch/eval/score.py"
echo ""
