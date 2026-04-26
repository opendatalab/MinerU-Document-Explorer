#!/usr/bin/env bash
#
# DeepResearch 2.0 — 顶层一键编排
#
# 此脚本封装：
#   setup       抓取资料 + qmd 索引（不调 LLM）
#   serve       启动 MCP HTTP 服务器（前台）
#   check       自动检查两份研报 + 评分（含 Wiki 评分）
#   doctor      环境体检：依赖 / qmd / 索引
#   clean       清理 sources / output / index
#   build-wiki  启动 Agentic Wiki 构建（多轮 CC 会话循环）
#
# 智能阶段（Wiki / 研报 / 对比 / 评估）由 Agent 通过 MCP 完成，
# 把 deepresearch/prompts/ 下的 4 份 markdown 顺序投喂给它即可。
#
# Usage:
#   bash deepresearch/run.sh setup       [--topic <yml>] [--max N] [--skip-embed]
#   bash deepresearch/run.sh serve       [--port 8181]
#   bash deepresearch/run.sh check       [--topic <yml>]
#   bash deepresearch/run.sh doctor
#   bash deepresearch/run.sh clean       [--all]
#   bash deepresearch/run.sh build-wiki  --topic <yml> [--max-search N] [--max-writes N]
#                                        [--wall-clock MIN] [--index-name NAME]
#                                        [--dry-run] [--resume]

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
  WIKI_DIR="deepresearch/output/wiki"

  for f in "$WIKI_REPORT" "$DIRECT_REPORT"; do
    if [ -f "$f" ]; then
      echo "── auto_check: $f ──"
      python3 deepresearch/eval/auto_check.py --report "$f" --topic "$TOPIC"
      echo ""
    else
      echo "(skip) $f 不存在"
    fi
  done

  # T11: Wiki-level scoring (runs after report checks)
  _check_wiki_scoring() {
    local wiki_dir="$1"
    local topic="$2"

    if [ ! -d "$wiki_dir" ]; then
      echo "(skip wiki eval) $wiki_dir 不存在"
      return 0
    fi
    local wiki_file_count
    wiki_file_count=$(find "$wiki_dir" -maxdepth 3 -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$wiki_file_count" -eq 0 ]; then
      echo "(skip wiki eval) $wiki_dir 为空（无 .md 文件）"
      return 0
    fi

    echo "── wiki eval: $wiki_dir ($wiki_file_count 个页面) ──"
    # auto_check.py requires --report; use wiki report if present, else direct, else a temp stub
    local report_arg=""
    if [ -f "$WIKI_REPORT" ]; then
      report_arg="$WIKI_REPORT"
    elif [ -f "$DIRECT_REPORT" ]; then
      report_arg="$DIRECT_REPORT"
    else
      # Create a minimal stub so auto_check.py can run wiki-only scoring
      local _tmp_report
      _tmp_report=$(mktemp /tmp/dr2_stub_XXXXXX.md)
      printf "# stub\n" > "$_tmp_report"
      report_arg="$_tmp_report"
    fi

    local wiki_eval_out="deepresearch/output/evaluation/wiki-standalone.json"
    mkdir -p "deepresearch/output/evaluation"
    python3 deepresearch/eval/auto_check.py \
      --report "$report_arg" \
      --wiki-dir "$wiki_dir" \
      --topic "$topic" \
      --json > "$wiki_eval_out" 2>/dev/null || true

    # Print human-readable wiki section
    python3 deepresearch/eval/auto_check.py \
      --report "$report_arg" \
      --wiki-dir "$wiki_dir" \
      --topic "$topic" 2>/dev/null || true

    echo ""
    echo "  (Wiki 评分 JSON: $wiki_eval_out)"
    echo ""

    # Clean up temp stub if we created one
    if [ -n "${_tmp_report:-}" ] && [ -f "${_tmp_report:-}" ]; then
      rm -f "$_tmp_report"
    fi
  }
  _check_wiki_scoring "$WIKI_DIR" "$TOPIC"

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

# =============================================================================
# build-wiki: Agentic Wiki Build State Machine (T9)
# =============================================================================

# ---------------------------------------------------------------------------
# _bw_derive_counters: Query wiki_log via sqlite3 to get authoritative budget counts.
# Sets BW_SEARCH_USED and BW_WRITES_USED in the caller's scope.
# Args: $1=index_path $2=started_at (ISO8601)
# ---------------------------------------------------------------------------
_bw_derive_counters() {
  local index_path="$1"
  local started_at="$2"

  if [ ! -f "$index_path" ]; then
    BW_SEARCH_USED=0
    BW_WRITES_USED=0
    return 0
  fi

  BW_SEARCH_USED=$(sqlite3 "$index_path" \
    "SELECT COUNT(*) FROM wiki_log WHERE operation='web_search' AND timestamp >= '${started_at}';" \
    2>/dev/null || echo 0)
  BW_WRITES_USED=$(sqlite3 "$index_path" \
    "SELECT COUNT(*) FROM wiki_log WHERE operation='update' AND json_extract(details,'$.action')='write' AND timestamp >= '${started_at}';" \
    2>/dev/null || echo 0)

  BW_SEARCH_USED="${BW_SEARCH_USED:-0}"
  BW_WRITES_USED="${BW_WRITES_USED:-0}"
}

# ---------------------------------------------------------------------------
# _bw_elapsed_minutes: Compute minutes elapsed since ISO8601 started_at.
# Sets BW_ELAPSED_MINUTES in caller's scope.
# ---------------------------------------------------------------------------
_bw_elapsed_minutes() {
  local started_at="$1"
  local started_epoch
  started_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$started_at" "+%s" 2>/dev/null \
    || date -d "$started_at" "+%s" 2>/dev/null \
    || echo 0)
  local now_epoch
  now_epoch=$(date "+%s")
  BW_ELAPSED_MINUTES=$(( (now_epoch - started_epoch) / 60 ))
}

# ---------------------------------------------------------------------------
# _bw_write_checkpoint: Atomically write checkpoint JSON.
# ---------------------------------------------------------------------------
_bw_write_checkpoint() {
  local checkpoint_path="$1"
  local topic="$2"
  local started_at="$3"
  local round="$4"
  local max_search="$5"
  local max_writes="$6"
  local wall_clock="$7"
  local stop_reason="${8:-null}"

  local stop_json
  if [ "$stop_reason" = "null" ] || [ -z "$stop_reason" ]; then
    stop_json="null"
  else
    stop_json="\"${stop_reason}\""
  fi

  local tmp_path="${checkpoint_path}.tmp"
  cat > "$tmp_path" <<CHECKPOINT_EOF
{
  "version": 1,
  "topic": "${topic}",
  "started_at": "${started_at}",
  "round": ${round},
  "stop_reason": ${stop_json},
  "budget": {
    "max_search": ${max_search},
    "max_writes": ${max_writes},
    "wall_clock_minutes": ${wall_clock}
  }
}
CHECKPOINT_EOF
  mv "$tmp_path" "$checkpoint_path"
}

# ---------------------------------------------------------------------------
# _bw_get_coverage_snapshot: Run auto_check.py wiki scoring and capture JSON.
# Sets BW_COVERAGE_SNAPSHOT in caller's scope.
# ---------------------------------------------------------------------------
_bw_get_coverage_snapshot() {
  local wiki_dir="$1"
  local topic="$2"

  BW_COVERAGE_SNAPSHOT="{}"
  if [ ! -d "$wiki_dir" ]; then
    return 0
  fi
  local wiki_count
  wiki_count=$(find "$wiki_dir" -maxdepth 3 -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$wiki_count" -eq 0 ]; then
    return 0
  fi

  # Need a report stub for auto_check.py
  local stub
  stub=$(mktemp /tmp/dr2_stub_XXXXXX.md)
  printf "# stub\n" > "$stub"

  local snapshot_json
  snapshot_json=$(python3 deepresearch/eval/auto_check.py \
    --report "$stub" \
    --wiki-dir "$wiki_dir" \
    --topic "$topic" \
    --json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('wiki',{})))" 2>/dev/null \
    || echo "{}")

  rm -f "$stub"
  BW_COVERAGE_SNAPSHOT="${snapshot_json:-{}}"
}

# ---------------------------------------------------------------------------
# _bw_check_coverage_met: Check if wiki coverage meets stop condition.
# Returns 0 (true) if coverage_met, 1 otherwise.
# ---------------------------------------------------------------------------
_bw_check_coverage_met() {
  local wiki_dir="$1"
  local topic="$2"

  if [ ! -d "$wiki_dir" ]; then return 1; fi
  local wiki_count
  wiki_count=$(find "$wiki_dir" -maxdepth 3 -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$wiki_count" -eq 0 ]; then return 1; fi

  local stub
  stub=$(mktemp /tmp/dr2_stub_XXXXXX.md)
  printf "# stub\n" > "$stub"

  local result
  result=$(python3 deepresearch/eval/auto_check.py \
    --report "$stub" \
    --wiki-dir "$wiki_dir" \
    --topic "$topic" \
    --json 2>/dev/null \
    | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    w=d.get('wiki',{})
    cov=w.get('research_questions_coverage',0) or 0
    orphan=w.get('orphan_ratio',1) or 1
    print('pass' if cov>=0.70 and orphan<=0.15 else 'fail')
except Exception:
    print('fail')
" 2>/dev/null || echo "fail")

  rm -f "$stub"
  [ "$result" = "pass" ]
}

# ---------------------------------------------------------------------------
# _bw_ensure_mcp_running: Check qmd MCP HTTP server is reachable on port.
# Starts daemon if not running. Exits 1 with message if unable.
# ---------------------------------------------------------------------------
_bw_ensure_mcp_running() {
  local port="$1"
  local index_name="$2"

  if curl -sf "http://localhost:${port}/health" >/dev/null 2>&1 \
     || curl -sf "http://localhost:${port}/" >/dev/null 2>&1; then
    echo "  MCP HTTP server already running on port $port"
    return 0
  fi

  echo "  MCP HTTP server not detected on port $port — starting daemon..."
  if [ "${#QMD_CMD[@]}" -eq 0 ]; then
    echo "ERROR: qmd not found; cannot start MCP server." >&2
    echo "  Install qmd or set up bun, then run: qmd --index $index_name mcp --http --port $port --daemon" >&2
    exit 1
  fi

  "${QMD_CMD[@]}" --index "$index_name" mcp --http --port "$port" --daemon
  sleep 2

  if ! curl -sf "http://localhost:${port}/health" >/dev/null 2>&1 \
     && ! curl -sf "http://localhost:${port}/" >/dev/null 2>&1; then
    echo "ERROR: MCP server failed to start on port $port." >&2
    echo "  Start it manually: qmd --index $index_name mcp --http --port $port --daemon" >&2
    exit 1
  fi
  echo "  MCP server started on port $port"
}

# ---------------------------------------------------------------------------
# _bw_render_prompt: Substitute template variables into prompt file.
# Writes rendered prompt to stdout.
# ---------------------------------------------------------------------------
_bw_render_prompt() {
  local prompt_file="$1"
  local round_number="$2"
  local search_remaining="$3"
  local writes_remaining="$4"
  local minutes_remaining="$5"
  local coverage_snapshot="$6"

  sed \
    -e "s|{round_number}|${round_number}|g" \
    -e "s|{search_remaining}|${search_remaining}|g" \
    -e "s|{writes_remaining}|${writes_remaining}|g" \
    -e "s|{minutes_remaining}|${minutes_remaining}|g" \
    "$prompt_file" \
  | python3 -c "
import sys, json
text = sys.stdin.read()
snap = sys.argv[1]
print(text.replace('{coverage_snapshot}', snap))
" "$coverage_snapshot"
}

# ---------------------------------------------------------------------------
# _bw_launch_cc_session: Launch a fresh Claude Code session with rendered prompt.
# Args: $1=rendered_prompt_file $2=mcp_port $3=index_name
# Returns CC exit code; non-zero is logged but not fatal to the loop.
# ---------------------------------------------------------------------------
_bw_launch_cc_session() {
  local prompt_file="$1"
  local mcp_port="$2"
  local index_name="$3"

  local cc_cmd="${CLAUDE_CMD:-claude}"
  if ! command -v "$cc_cmd" &>/dev/null; then
    echo "  WARNING: '$cc_cmd' not found in PATH; skipping CC session." >&2
    echo "  Set CLAUDE_CMD env var or install claude CLI." >&2
    return 2
  fi

  local mcp_config
  mcp_config=$(printf '{"mcpServers":{"qmd":{"url":"http://localhost:%s/mcp"}}}' "$mcp_port")

  local exit_code=0
  "$cc_cmd" \
    --print \
    --dangerously-skip-permissions \
    --mcp-config "$mcp_config" \
    "$(cat "$prompt_file")" \
    || exit_code=$?

  return $exit_code
}

# ---------------------------------------------------------------------------
# _bw_seed_bootstrap: Run setup.sh to fetch seed corpus and index.
# ---------------------------------------------------------------------------
_bw_seed_bootstrap() {
  local topic="$1"
  shift
  echo "==> [seed_bootstrap] Fetching seed corpus via setup.sh..."
  bash deepresearch/scripts/setup.sh --topic "$topic" "$@" || {
    echo "  WARNING: setup.sh exited non-zero (some fetchers may have failed). Continuing." >&2
  }
  echo "==> [seed_bootstrap] Done."
}

# ---------------------------------------------------------------------------
# _bw_finalize: Run wiki_index and save final wiki log.
# ---------------------------------------------------------------------------
_bw_finalize() {
  local index_name="$1"
  local wiki_collection="${2:-wiki}"

  echo "==> [finalize] Generating wiki index..."
  if [ "${#QMD_CMD[@]}" -gt 0 ]; then
    "${QMD_CMD[@]}" --index "$index_name" wiki index "$wiki_collection" 2>/dev/null || true
  fi

  echo "==> [finalize] Saving wiki log..."
  mkdir -p "deepresearch/output"
  if [ "${#QMD_CMD[@]}" -gt 0 ]; then
    "${QMD_CMD[@]}" --index "$index_name" wiki log \
      > "deepresearch/output/.build-wiki-final-log.txt" 2>/dev/null || true
  fi
  echo "==> [finalize] Done. Log: deepresearch/output/.build-wiki-final-log.txt"
}

# ---------------------------------------------------------------------------
# _bw_evaluate: Run auto_check.py full evaluation.
# ---------------------------------------------------------------------------
_bw_evaluate() {
  local topic="$1"
  local wiki_dir="$2"

  echo "==> [evaluate] Running auto_check.py wiki evaluation..."
  mkdir -p "deepresearch/output/evaluation"

  local report_arg=""
  local wiki_report="deepresearch/output/reports/wiki-first.md"
  if [ -f "$wiki_report" ]; then
    report_arg="$wiki_report"
  else
    local stub
    stub=$(mktemp /tmp/dr2_stub_XXXXXX.md)
    printf "# stub\n" > "$stub"
    report_arg="$stub"
  fi

  python3 deepresearch/eval/auto_check.py \
    --report "$report_arg" \
    --wiki-dir "$wiki_dir" \
    --topic "$topic" \
    --json \
    > "deepresearch/output/evaluation/build-wiki-run.json" 2>/dev/null || true

  python3 deepresearch/eval/auto_check.py \
    --report "$report_arg" \
    --wiki-dir "$wiki_dir" \
    --topic "$topic" 2>/dev/null || true

  if [ -n "${stub:-}" ] && [ -f "${stub:-}" ]; then
    rm -f "$stub"
  fi

  echo ""
  echo "  (评估 JSON: deepresearch/output/evaluation/build-wiki-run.json)"
}

# ---------------------------------------------------------------------------
# cmd_build_wiki: Main entry point for build-wiki subcommand.
# ---------------------------------------------------------------------------
cmd_build_wiki() {
  # ── Defaults ──────────────────────────────────────────────────────────────
  local bw_topic="$TOPIC"
  local bw_max_search=40
  local bw_max_writes=60
  local bw_wall_clock=30
  local bw_index_name="$INDEX_NAME"
  local bw_dry_run=false
  local bw_resume=false
  local bw_prompt_file="deepresearch/prompts/01-WIKI-FIRST-zh.md"
  local bw_mcp_port="$PORT"

  # ── Arg parsing ───────────────────────────────────────────────────────────
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --topic)      bw_topic="$2";       shift 2 ;;
      --max-search) bw_max_search="$2";  shift 2 ;;
      --max-writes) bw_max_writes="$2";  shift 2 ;;
      --wall-clock) bw_wall_clock="$2";  shift 2 ;;
      --index-name) bw_index_name="$2";  shift 2 ;;
      --dry-run)    bw_dry_run=true;     shift ;;
      --resume)     bw_resume=true;      shift ;;
      --prompt)     bw_prompt_file="$2"; shift 2 ;;
      --port)       bw_mcp_port="$2";    shift 2 ;;
      --help|-h)
        echo "Usage: bash deepresearch/run.sh build-wiki [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --topic PATH        Path to topics YAML (default: $TOPIC)"
        echo "  --max-search N      Max web_search calls (default: 40)"
        echo "  --max-writes N      Max wiki doc_write calls (default: 60)"
        echo "  --wall-clock MIN    Wall-clock limit in minutes (default: 30)"
        echo "  --index-name NAME   qmd index name (default: $INDEX_NAME)"
        echo "  --dry-run           Print plan and exit 0 without running anything"
        echo "  --resume            Resume from existing checkpoint"
        echo "  --prompt PATH       Override prompt file (default: prompts/01-WIKI-FIRST-zh.md)"
        echo "  --port N            MCP HTTP port (default: $PORT)"
        exit 0
        ;;
      *) echo "WARNING: unknown build-wiki option: $1" >&2; shift ;;
    esac
  done

  # ── Validate inputs ───────────────────────────────────────────────────────
  if [ -z "$bw_topic" ] || [ ! -f "$bw_topic" ]; then
    echo "ERROR: --topic file not found: '${bw_topic}'" >&2
    echo "  Usage: bash deepresearch/run.sh build-wiki --topic deepresearch/topics/document-parsing.yml" >&2
    exit 1
  fi
  if [ ! -f "$bw_prompt_file" ]; then
    echo "ERROR: prompt file not found: '$bw_prompt_file'" >&2
    exit 1
  fi
  if [ "${#QMD_CMD[@]}" -eq 0 ]; then
    echo "ERROR: qmd not found. Install qmd or bun." >&2
    exit 1
  fi

  local bw_index_path="$HOME/.cache/qmd/${bw_index_name}.sqlite"
  local bw_checkpoint_path="deepresearch/output/.build-wiki-state.json"
  local bw_wiki_dir="deepresearch/output/wiki"
  local bw_max_rounds=20

  # ── INIT ──────────────────────────────────────────────────────────────────
  echo "==> [init] DeepResearch build-wiki"
  echo "    topic:       $bw_topic"
  echo "    max-search:  $bw_max_search"
  echo "    max-writes:  $bw_max_writes"
  echo "    wall-clock:  $bw_wall_clock min"
  echo "    index-name:  $bw_index_name"
  echo "    index-path:  $bw_index_path"
  echo "    wiki-dir:    $bw_wiki_dir"
  echo "    checkpoint:  $bw_checkpoint_path"
  echo "    prompt-file: $bw_prompt_file"
  echo "    mcp-port:    $bw_mcp_port"
  echo "    dry-run:     $bw_dry_run"
  echo "    resume:      $bw_resume"
  echo ""

  mkdir -p "deepresearch/output"
  mkdir -p "$bw_wiki_dir"
  mkdir -p "deepresearch/output/reports"
  mkdir -p "deepresearch/output/evaluation"

  local bw_started_at
  local bw_start_round=1

  if [ "$bw_resume" = true ] && [ -f "$bw_checkpoint_path" ]; then
    echo "==> [init] Resuming from checkpoint: $bw_checkpoint_path"
    bw_started_at=$(python3 -c "
import json, sys
try:
    d=json.load(open('${bw_checkpoint_path}'))
    print(d.get('started_at',''))
except Exception as e:
    print('', end='')
" 2>/dev/null || echo "")
    bw_start_round=$(python3 -c "
import json, sys
try:
    d=json.load(open('${bw_checkpoint_path}'))
    print(d.get('round',1)+1)
except Exception:
    print(1)
" 2>/dev/null || echo 1)
    if [ -z "$bw_started_at" ]; then
      echo "  WARNING: Could not parse checkpoint; starting fresh." >&2
      bw_resume=false
    else
      echo "    started_at:  $bw_started_at"
      echo "    resuming at round: $bw_start_round"
    fi
  fi

  if [ "$bw_resume" = false ] || [ -z "${bw_started_at:-}" ]; then
    bw_started_at=$(date -u "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
      || date "+%Y-%m-%dT%H:%M:%SZ")
    bw_start_round=1
  fi

  # ── DRY RUN ───────────────────────────────────────────────────────────────
  if [ "$bw_dry_run" = true ]; then
    local prompt_size
    prompt_size=$(wc -c < "$bw_prompt_file" | tr -d ' ')
    local seed_docs=0
    if [ -d "deepresearch/sources" ]; then
      seed_docs=$(find "deepresearch/sources" -maxdepth 3 -type f 2>/dev/null | wc -l | tr -d ' ')
    fi
    local checkpoint_exists="no"
    [ -f "$bw_checkpoint_path" ] && checkpoint_exists="yes (round=$(python3 -c "import json; d=json.load(open('$bw_checkpoint_path')); print(d.get('round','?'))" 2>/dev/null || echo '?'))"

    echo "==> [dry-run] Planned execution:"
    echo "    1. seed_bootstrap: setup.sh --topic $bw_topic --skip-embed"
    echo "       existing seed docs: $seed_docs"
    echo "    2. agent_loop: up to $bw_max_rounds rounds"
    echo "       per round: render prompt ($prompt_size bytes) + launch claude --print session"
    echo "       budget: search=$bw_max_search  writes=$bw_max_writes  wall=${bw_wall_clock}min"
    echo "    3. stop when: coverage_met | budget_exhausted | max_rounds_reached"
    echo "    4. finalize: qmd wiki index + wiki log dump"
    echo "    5. evaluate: auto_check.py --wiki-dir $bw_wiki_dir"
    echo ""
    echo "    checkpoint_exists: $checkpoint_exists"
    echo "    checkpoint_path:   $bw_checkpoint_path"
    echo "    started_at:        $bw_started_at"
    echo ""
    echo "    would-invoke-CC-with prompt size: ${prompt_size} bytes"
    echo "    would-launch-up-to: $bw_max_rounds CC rounds"
    echo ""
    echo "(dry-run) Nothing executed. Exit 0."
    exit 0
  fi

  # ── SEED BOOTSTRAP (skip on resume) ───────────────────────────────────────
  if [ "$bw_resume" = false ] || [ "$bw_start_round" -le 1 ]; then
    _bw_seed_bootstrap "$bw_topic" --skip-embed
  else
    echo "==> [seed_bootstrap] Skipped (resuming from round $bw_start_round)"
  fi

  # Write initial checkpoint
  _bw_write_checkpoint \
    "$bw_checkpoint_path" "$bw_topic" "$bw_started_at" \
    "$((bw_start_round - 1))" "$bw_max_search" "$bw_max_writes" "$bw_wall_clock"

  # ── ENSURE MCP SERVER RUNNING ─────────────────────────────────────────────
  _bw_ensure_mcp_running "$bw_mcp_port" "$bw_index_name"

  # ── AGENT LOOP ────────────────────────────────────────────────────────────
  local bw_stop_reason=""
  local bw_round
  local bw_rendered_prompt

  for (( bw_round=bw_start_round; bw_round<=bw_max_rounds; bw_round++ )); do
    echo ""
    echo "==> [agent_loop] Round $bw_round / $bw_max_rounds"

    # Re-derive counters from wiki_log (authoritative)
    _bw_derive_counters "$bw_index_path" "$bw_started_at"
    _bw_elapsed_minutes "$bw_started_at"

    local bw_search_remaining=$(( bw_max_search - BW_SEARCH_USED ))
    local bw_writes_remaining=$(( bw_max_writes - BW_WRITES_USED ))
    local bw_minutes_remaining=$(( bw_wall_clock - BW_ELAPSED_MINUTES ))

    echo "    search:  used=$BW_SEARCH_USED / $bw_max_search  (remaining=$bw_search_remaining)"
    echo "    writes:  used=$BW_WRITES_USED / $bw_max_writes  (remaining=$bw_writes_remaining)"
    echo "    elapsed: ${BW_ELAPSED_MINUTES}min / ${bw_wall_clock}min  (remaining=${bw_minutes_remaining}min)"

    # Check budget
    if [ "$bw_search_remaining" -le 0 ] || \
       [ "$bw_writes_remaining" -le 0 ] || \
       [ "$bw_minutes_remaining" -le 0 ]; then
      echo "==> [agent_loop] Budget exhausted at round $bw_round."
      bw_stop_reason="budget_exhausted"
      break
    fi

    # Get coverage snapshot from previous round
    _bw_get_coverage_snapshot "$bw_wiki_dir" "$bw_topic"

    # Check coverage stop condition
    if _bw_check_coverage_met "$bw_wiki_dir" "$bw_topic"; then
      echo "==> [agent_loop] Coverage met at round $bw_round — stopping."
      bw_stop_reason="coverage_met"
      break
    fi

    # Render prompt with current state
    bw_rendered_prompt=$(mktemp /tmp/dr2_prompt_XXXXXX.md)
    _bw_render_prompt \
      "$bw_prompt_file" \
      "$bw_round" \
      "$bw_search_remaining" \
      "$bw_writes_remaining" \
      "$bw_minutes_remaining" \
      "$BW_COVERAGE_SNAPSHOT" \
      > "$bw_rendered_prompt"

    echo "    prompt size: $(wc -c < "$bw_rendered_prompt" | tr -d ' ') bytes"
    echo "    coverage_snapshot: $BW_COVERAGE_SNAPSHOT"

    # Update checkpoint before launching session
    _bw_write_checkpoint \
      "$bw_checkpoint_path" "$bw_topic" "$bw_started_at" \
      "$bw_round" "$bw_max_search" "$bw_max_writes" "$bw_wall_clock"

    # Launch fresh CC session
    echo "    Launching CC session (round $bw_round)..."
    local cc_exit=0
    _bw_launch_cc_session "$bw_rendered_prompt" "$bw_mcp_port" "$bw_index_name" \
      || cc_exit=$?
    rm -f "$bw_rendered_prompt"

    if [ "$cc_exit" -ne 0 ]; then
      echo "  WARNING: CC session exited with code $cc_exit at round $bw_round — continuing." >&2
    fi

    # Re-derive counters after session
    _bw_derive_counters "$bw_index_path" "$bw_started_at"
    echo "    post-round: search_used=$BW_SEARCH_USED  writes_used=$BW_WRITES_USED"

    # Update checkpoint with completed round
    _bw_write_checkpoint \
      "$bw_checkpoint_path" "$bw_topic" "$bw_started_at" \
      "$bw_round" "$bw_max_search" "$bw_max_writes" "$bw_wall_clock"
  done

  if [ -z "$bw_stop_reason" ]; then
    bw_stop_reason="max_rounds_reached"
  fi

  # Write final checkpoint with stop_reason
  _bw_write_checkpoint \
    "$bw_checkpoint_path" "$bw_topic" "$bw_started_at" \
    "$bw_round" "$bw_max_search" "$bw_max_writes" "$bw_wall_clock" \
    "$bw_stop_reason"

  # ── FINALIZE ──────────────────────────────────────────────────────────────
  _bw_finalize "$bw_index_name"

  # ── SUMMARY ───────────────────────────────────────────────────────────────
  _bw_derive_counters "$bw_index_path" "$bw_started_at"
  _bw_elapsed_minutes "$bw_started_at"

  echo ""
  echo "==================================================="
  echo "  build-wiki COMPLETE"
  echo "  stop_reason:  $bw_stop_reason"
  echo "  rounds run:   $((bw_round - bw_start_round + 1))"
  echo "  search used:  $BW_SEARCH_USED / $bw_max_search"
  echo "  writes used:  $BW_WRITES_USED / $bw_max_writes"
  echo "  elapsed:      ${BW_ELAPSED_MINUTES}min / ${bw_wall_clock}min"
  echo "  checkpoint:   $bw_checkpoint_path"
  echo "==================================================="
  echo ""

  # ── EVALUATE ──────────────────────────────────────────────────────────────
  _bw_evaluate "$bw_topic" "$bw_wiki_dir"
}

case "$CMD" in
  setup) cmd_setup "$@" ;;
  serve) cmd_serve "$@" ;;
  check) cmd_check "$@" ;;
  doctor) cmd_doctor ;;
  clean) cmd_clean "$@" ;;
  build-wiki) cmd_build_wiki "$@" ;;
  help|-h|--help|"") usage ;;
  *) echo "未知命令: $CMD"; usage; exit 1 ;;
esac
