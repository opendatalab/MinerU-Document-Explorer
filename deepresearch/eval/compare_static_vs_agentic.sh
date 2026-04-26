#!/usr/bin/env bash
#
# compare_static_vs_agentic.sh — Side-by-side evaluation: static pipeline vs. agentic build-wiki
#
# Usage:
#   bash deepresearch/eval/compare_static_vs_agentic.sh --topic PATH [OPTIONS]
#
# Options:
#   --topic PATH        Path to topic YAML file (required)
#   --skip-static       Skip running the static pipeline (use existing wiki/ if present)
#   --skip-agentic      Skip running the agentic build-wiki pipeline
#   --runs N            Number of times to run each pipeline (default: 1)
#   --output PATH       Output markdown path (default: deepresearch/output/evaluation/comparison.md)
#   --help, -h          Show this help and exit
#
# Exit codes:
#   0  Comparison completed (may have partial/placeholder data)
#   1  Neither pipeline could be scored
#   2  Agentic lost on BOTH key metrics in ALL runs

set -euo pipefail
cd "$(dirname "$0")/../.."

# ── Defaults ─────────────────────────────────────────────────────────────────
CMP_TOPIC=""
CMP_SKIP_STATIC=false
CMP_SKIP_AGENTIC=false
CMP_RUNS=1
CMP_OUTPUT="deepresearch/output/evaluation/comparison.md"

# CI-friendly budgets for agentic runs
CMP_MAX_SEARCH=20
CMP_MAX_WRITES=30
CMP_WALL_CLOCK=10

# ── Arg parsing ───────────────────────────────────────────────────────────────
_cmp_usage() {
  # Print the header comment block (lines 2+ up to first non-comment line)
  awk 'NR==1{next} /^[^#]/{exit} /^#/{sub(/^# ?/,""); print}' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --topic)       CMP_TOPIC="$2";        shift 2 ;;
    --skip-static) CMP_SKIP_STATIC=true;  shift   ;;
    --skip-agentic)CMP_SKIP_AGENTIC=true; shift   ;;
    --runs)        CMP_RUNS="$2";         shift 2 ;;
    --output)      CMP_OUTPUT="$2";       shift 2 ;;
    --help|-h)     _cmp_usage; exit 0    ;;
    *) echo "WARNING: unknown option: $1" >&2; shift ;;
  esac
done

# ── Validate ──────────────────────────────────────────────────────────────────
if [ -z "$CMP_TOPIC" ]; then
  echo "ERROR: --topic is required." >&2
  _cmp_usage
  exit 1
fi
if [ ! -f "$CMP_TOPIC" ]; then
  echo "ERROR: topic file not found: $CMP_TOPIC" >&2
  exit 1
fi
if ! [[ "$CMP_RUNS" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: --runs must be a positive integer (got: $CMP_RUNS)" >&2
  exit 1
fi

# ── JSON parser detection ─────────────────────────────────────────────────────
# Prefer jq; fall back to python3 json.load
_CMP_JSON_PARSER="unknown"
if command -v jq &>/dev/null; then
  _CMP_JSON_PARSER="jq"
else
  _CMP_JSON_PARSER="python3"
fi
echo "INFO: json parser: $_CMP_JSON_PARSER"

# ── Helper: extract a numeric field from a JSON file ─────────────────────────
# Usage: _cmp_json_field FILE KEY [DEFAULT]
_cmp_json_field() {
  local file="$1"
  local key="$2"
  local default="${3:-null}"

  if [ ! -f "$file" ]; then echo "$default"; return; fi

  if [ "$_CMP_JSON_PARSER" = "jq" ]; then
    jq -r --arg k "$key" 'if has($k) then .[$k] // "'"$default"'" else "'"$default"'" end' "$file" 2>/dev/null \
      || echo "$default"
  else
    python3 - "$file" "$key" "$default" <<'PYEOF'
import json, sys
try:
    with open(sys.argv[1]) as fh:
        d = json.load(fh)
    val = d.get(sys.argv[2])
    if val is None:
        print(sys.argv[3])
    else:
        print(val)
except Exception:
    print(sys.argv[3])
PYEOF
  fi
}

# Extract a nested field: file -> .wiki.KEY
_cmp_json_wiki_field() {
  local file="$1"
  local key="$2"
  local default="${3:-null}"

  if [ ! -f "$file" ]; then echo "$default"; return; fi

  if [ "$_CMP_JSON_PARSER" = "jq" ]; then
    jq -r --arg k "$key" '.wiki // {} | if has($k) then .[$k] // "'"$default"'" else "'"$default"'" end' "$file" 2>/dev/null \
      || echo "$default"
  else
    python3 - "$file" "$key" "$default" <<'PYEOF'
import json, sys
try:
    with open(sys.argv[1]) as fh:
        d = json.load(fh)
    val = (d.get("wiki") or {}).get(sys.argv[2])
    if val is None:
        print(sys.argv[3])
    else:
        print(val)
except Exception:
    print(sys.argv[3])
PYEOF
  fi
}

# ── Scoring helper: score existing wiki directory ─────────────────────────────
# Usage: _cmp_score_wiki WIKI_DIR TOPIC OUT_JSON
# Writes auto_check.py JSON output to OUT_JSON. Returns 0 on success, 1 on skip.
_cmp_score_wiki() {
  local wiki_dir="$1"
  local topic="$2"
  local out_json="$3"

  mkdir -p "$(dirname "$out_json")"

  if [ ! -d "$wiki_dir" ]; then
    echo "  (score skip) wiki_dir not found: $wiki_dir" >&2
    return 1
  fi
  local page_count
  page_count=$(find "$wiki_dir" -maxdepth 3 -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$page_count" -eq 0 ]; then
    echo "  (score skip) no .md files in $wiki_dir" >&2
    return 1
  fi

  local stub
  stub=$(mktemp /tmp/dr2_cmp_stub_XXXXXX.md)
  printf "# stub\n" > "$stub"

  python3 deepresearch/eval/auto_check.py \
    --report "$stub" \
    --wiki-dir "$wiki_dir" \
    --topic "$topic" \
    --json \
    > "$out_json" 2>/dev/null || true

  rm -f "$stub"

  if [ ! -s "$out_json" ]; then
    echo "  (score skip) auto_check.py produced empty output" >&2
    return 1
  fi
  return 0
}

# ── Static pipeline runner ────────────────────────────────────────────────────
# The "static baseline" is the existing deepresearch/output/wiki/ state.
# If --skip-static is set, we just score whatever is present (or produce zeros).
# If NOT skipped, we run setup --skip-embed to refresh the source corpus but do
# NOT wipe the wiki output; we score whatever wiki pages are present after that.
#
# Usage: _cmp_run_static RUN_INDEX OUT_JSON
# Sets CMP_STATIC_SCORED=true/false
_cmp_run_static() {
  local run_idx="$1"
  local out_json="$2"

  echo "==> [static run $run_idx] Starting static pipeline..."

  if [ "$CMP_SKIP_STATIC" = "true" ]; then
    echo "  --skip-static: skipping pipeline run, scoring existing wiki if present"
  else
    echo "  Running: bash deepresearch/run.sh setup --topic $CMP_TOPIC --skip-embed"
    if bash deepresearch/run.sh setup --topic "$CMP_TOPIC" --skip-embed 2>&1 | head -50; then
      echo "  setup.sh completed"
    else
      echo "  WARNING: setup.sh exited non-zero; scoring whatever wiki is present" >&2
    fi
  fi

  local wiki_dir="deepresearch/output/wiki"
  if _cmp_score_wiki "$wiki_dir" "$CMP_TOPIC" "$out_json"; then
    CMP_STATIC_SCORED=true
    echo "  Static scored -> $out_json"
  else
    CMP_STATIC_SCORED=false
    echo "  Static: no scoreable wiki found; will use placeholder zeros"
  fi
}

# ── Agentic pipeline runner ───────────────────────────────────────────────────
# Backs up existing wiki, runs build-wiki with CI-friendly budgets,
# scores the result, then restores the backup.
#
# Usage: _cmp_run_agentic RUN_INDEX OUT_JSON
# Sets CMP_AGENTIC_SCORED=true/false
_cmp_run_agentic() {
  local run_idx="$1"
  local out_json="$2"

  echo "==> [agentic run $run_idx] Starting agentic build-wiki..."

  local wiki_dir="deepresearch/output/wiki"
  local backup_dir=""

  if [ "$CMP_SKIP_AGENTIC" = "true" ]; then
    echo "  --skip-agentic: skipping pipeline run, scoring existing wiki if present"
    if _cmp_score_wiki "$wiki_dir" "$CMP_TOPIC" "$out_json"; then
      CMP_AGENTIC_SCORED=true
      echo "  Agentic scored (from existing wiki) -> $out_json"
    else
      CMP_AGENTIC_SCORED=false
      echo "  Agentic: no scoreable wiki found; will use placeholder zeros"
    fi
    return 0
  fi

  # Backup existing wiki to avoid clobbering static baseline results
  if [ -d "$wiki_dir" ]; then
    local ts
    ts=$(date "+%Y%m%d_%H%M%S")
    backup_dir="${wiki_dir}.bak_static_${ts}"
    echo "  Backing up existing wiki: $wiki_dir -> $backup_dir"
    cp -a "$wiki_dir" "$backup_dir"
  fi

  # Clear wiki for a clean agentic run
  rm -rf "${wiki_dir:?}"/*  2>/dev/null || true
  mkdir -p "$wiki_dir"

  echo "  Running: bash deepresearch/run.sh build-wiki --topic $CMP_TOPIC --max-search $CMP_MAX_SEARCH --max-writes $CMP_MAX_WRITES --wall-clock $CMP_WALL_CLOCK"
  local bw_exit=0
  bash deepresearch/run.sh build-wiki \
    --topic "$CMP_TOPIC" \
    --max-search "$CMP_MAX_SEARCH" \
    --max-writes "$CMP_MAX_WRITES" \
    --wall-clock "$CMP_WALL_CLOCK" \
    2>&1 | tail -40 \
    || bw_exit=$?

  if [ "$bw_exit" -ne 0 ]; then
    echo "  WARNING: build-wiki exited with code $bw_exit; scoring whatever wiki is present" >&2
  fi

  if _cmp_score_wiki "$wiki_dir" "$CMP_TOPIC" "$out_json"; then
    CMP_AGENTIC_SCORED=true
    echo "  Agentic scored -> $out_json"
  else
    CMP_AGENTIC_SCORED=false
    echo "  Agentic: no scoreable wiki found; will use placeholder zeros"
  fi

  # Restore the static baseline wiki (so the repo state is clean after comparison)
  if [ -n "$backup_dir" ] && [ -d "$backup_dir" ]; then
    echo "  Restoring static wiki from backup: $backup_dir -> $wiki_dir"
    rm -rf "${wiki_dir:?}"
    mv "$backup_dir" "$wiki_dir"
  fi
}

# ── Report writer ─────────────────────────────────────────────────────────────
# Usage: _cmp_write_report OUT_MD RUN_DATA_FILE
# RUN_DATA_FILE is a tab-separated file:
#   run_idx  static_json  agentic_json  static_scored  agentic_scored
_cmp_write_report() {
  local out_md="$1"
  local run_data_file="$2"
  local num_runs="$3"

  mkdir -p "$(dirname "$out_md")"

  # ── Collect per-run metrics ───────────────────────────────────────────────
  # Arrays: indexed 0..(num_runs-1)
  local -a s_coverage s_orphan s_citations s_pages
  local -a a_coverage a_orphan a_citations a_pages
  local -a s_scored a_scored

  local run_idx static_json agentic_json ss as_flag
  while IFS=$'\t' read -r run_idx static_json agentic_json ss as_flag; do
    # wiki metrics live under .wiki.* in the JSON
    local sc so sci sp ac ao aci ap
    sc=$(_cmp_json_wiki_field "$static_json"  "research_questions_coverage" "0")
    so=$(_cmp_json_wiki_field "$static_json"  "orphan_ratio"                "1")
    sci=$(_cmp_json_wiki_field "$static_json" "avg_citations_per_page"      "0")
    sp=$(_cmp_json_wiki_field "$static_json"  "total_pages"                 "0")

    ac=$(_cmp_json_wiki_field "$agentic_json" "research_questions_coverage" "0")
    ao=$(_cmp_json_wiki_field "$agentic_json" "orphan_ratio"                "1")
    aci=$(_cmp_json_wiki_field "$agentic_json" "avg_citations_per_page"      "0")
    ap=$(_cmp_json_wiki_field "$agentic_json" "total_pages"                 "0")

    # Replace "null" with 0 / 1
    [[ "$sc"  == "null" || -z "$sc"  ]] && sc="0"
    [[ "$so"  == "null" || -z "$so"  ]] && so="1"
    [[ "$sci" == "null" || -z "$sci" ]] && sci="0"
    [[ "$sp"  == "null" || -z "$sp"  ]] && sp="0"
    [[ "$ac"  == "null" || -z "$ac"  ]] && ac="0"
    [[ "$ao"  == "null" || -z "$ao"  ]] && ao="1"
    [[ "$aci" == "null" || -z "$aci" ]] && aci="0"
    [[ "$ap"  == "null" || -z "$ap"  ]] && ap="0"

    s_coverage+=("$sc");  s_orphan+=("$so");  s_citations+=("$sci");  s_pages+=("$sp")
    a_coverage+=("$ac");  a_orphan+=("$ao");  a_citations+=("$aci");  a_pages+=("$ap")
    s_scored+=("$ss");    a_scored+=("$as_flag")
  done < "$run_data_file"

  # ── Compute aggregates via python3 ────────────────────────────────────────
  local agg_json
  agg_json=$(python3 - \
    "${s_coverage[*]}" "${s_orphan[*]}" "${s_citations[*]}" "${s_pages[*]}" \
    "${a_coverage[*]}" "${a_orphan[*]}" "${a_citations[*]}" "${a_pages[*]}" \
    <<'PYEOF'
import sys, json, statistics

def parse_list(s):
    return [float(x) for x in s.split() if x not in ('', 'null')]

sc_  = parse_list(sys.argv[1])
so_  = parse_list(sys.argv[2])
sci_ = parse_list(sys.argv[3])
sp_  = parse_list(sys.argv[4])
ac_  = parse_list(sys.argv[5])
ao_  = parse_list(sys.argv[6])
aci_ = parse_list(sys.argv[7])
ap_  = parse_list(sys.argv[8])

def agg(lst):
    if not lst: return {"mean": 0.0, "min": 0.0, "max": 0.0, "variance": 0.0, "n": 0}
    return {
        "mean": round(statistics.mean(lst), 4),
        "min":  round(min(lst), 4),
        "max":  round(max(lst), 4),
        "variance": round(statistics.variance(lst), 6) if len(lst) > 1 else 0.0,
        "n": len(lst),
    }

result = {
    "static":  {"coverage": agg(sc_), "orphan": agg(so_), "citations": agg(sci_), "pages": agg(sp_)},
    "agentic": {"coverage": agg(ac_), "orphan": agg(ao_), "citations": agg(aci_), "pages": agg(ap_)},
}

# Per-run: count how many runs agentic wins on both key metrics
wins = 0
for i in range(min(len(sc_), len(ac_))):
    if ac_[i] >= sc_[i] and aci_[i] >= sci_[i]:
        wins += 1
result["agentic_wins_both_key_metrics_in_any_run"] = wins > 0
result["wins_count"] = wins
result["total_compared"] = min(len(sc_), len(ac_))
print(json.dumps(result))
PYEOF
  )

  # ── Extract values for the report ────────────────────────────────────────
  local s_cov_mean s_orp_mean s_cit_mean s_pgs_mean
  local a_cov_mean a_orp_mean a_cit_mean a_pgs_mean
  local agentic_wins agentic_wins_count total_compared

  if [ "$_CMP_JSON_PARSER" = "jq" ]; then
    s_cov_mean=$(echo "$agg_json" | jq -r '.static.coverage.mean')
    s_orp_mean=$(echo "$agg_json" | jq -r '.static.orphan.mean')
    s_cit_mean=$(echo "$agg_json" | jq -r '.static.citations.mean')
    s_pgs_mean=$(echo "$agg_json" | jq -r '.static.pages.mean')
    a_cov_mean=$(echo "$agg_json" | jq -r '.agentic.coverage.mean')
    a_orp_mean=$(echo "$agg_json" | jq -r '.agentic.orphan.mean')
    a_cit_mean=$(echo "$agg_json" | jq -r '.agentic.citations.mean')
    a_pgs_mean=$(echo "$agg_json" | jq -r '.agentic.pages.mean')
    agentic_wins=$(echo "$agg_json" | jq -r '.agentic_wins_both_key_metrics_in_any_run')
    agentic_wins_count=$(echo "$agg_json" | jq -r '.wins_count')
    total_compared=$(echo "$agg_json" | jq -r '.total_compared')
  else
    s_cov_mean=$(echo "$agg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['static']['coverage']['mean'])")
    s_orp_mean=$(echo "$agg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['static']['orphan']['mean'])")
    s_cit_mean=$(echo "$agg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['static']['citations']['mean'])")
    s_pgs_mean=$(echo "$agg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['static']['pages']['mean'])")
    a_cov_mean=$(echo "$agg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['agentic']['coverage']['mean'])")
    a_orp_mean=$(echo "$agg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['agentic']['orphan']['mean'])")
    a_cit_mean=$(echo "$agg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['agentic']['citations']['mean'])")
    a_pgs_mean=$(echo "$agg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['agentic']['pages']['mean'])")
    agentic_wins=$(echo "$agg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(str(d['agentic_wins_both_key_metrics_in_any_run']).lower())")
    agentic_wins_count=$(echo "$agg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['wins_count'])")
    total_compared=$(echo "$agg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['total_compared'])")
  fi

  # ── Compute delta and winner per metric ────────────────────────────────────
  local delta_cov delta_orp delta_cit delta_pgs
  local win_cov win_orp win_cit win_pgs
  delta_cov=$(python3 -c "print(round(${a_cov_mean} - ${s_cov_mean}, 4))")
  delta_orp=$(python3 -c "print(round(${a_orp_mean} - ${s_orp_mean}, 4))")
  delta_cit=$(python3 -c "print(round(${a_cit_mean} - ${s_cit_mean}, 4))")
  delta_pgs=$(python3 -c "print(round(${a_pgs_mean} - ${s_pgs_mean}, 4))")

  # Winner: higher coverage/citations = agentic; lower orphan = agentic
  win_cov=$(python3 -c "print('agentic' if ${a_cov_mean} >= ${s_cov_mean} else 'static')")
  win_orp=$(python3 -c "print('agentic' if ${a_orp_mean} <= ${s_orp_mean} else 'static')")
  win_cit=$(python3 -c "print('agentic' if ${a_cit_mean} >= ${s_cit_mean} else 'static')")
  win_pgs=$(python3 -c "print('agentic' if ${a_pgs_mean} >= ${s_pgs_mean} else 'static')")

  # ── Acceptance verdict ────────────────────────────────────────────────────
  local acceptance_line
  if [ "$agentic_wins" = "true" ]; then
    acceptance_line="**PASS** — agentic >= static on both key metrics in at least one run ($agentic_wins_count / $total_compared runs)"
  else
    acceptance_line="**FAIL** — agentic did NOT beat static on both key metrics in any run ($agentic_wins_count / $total_compared runs)"
  fi

  # ── Variance section (only if runs > 1) ──────────────────────────────────
  local variance_section=""
  if [ "$num_runs" -gt 1 ]; then
    local s_cov_min s_cov_max a_cov_min a_cov_max
    local s_cit_min s_cit_max a_cit_min a_cit_max
    if [ "$_CMP_JSON_PARSER" = "jq" ]; then
      s_cov_min=$(echo "$agg_json" | jq -r '.static.coverage.min')
      s_cov_max=$(echo "$agg_json" | jq -r '.static.coverage.max')
      a_cov_min=$(echo "$agg_json" | jq -r '.agentic.coverage.min')
      a_cov_max=$(echo "$agg_json" | jq -r '.agentic.coverage.max')
      s_cit_min=$(echo "$agg_json" | jq -r '.static.citations.min')
      s_cit_max=$(echo "$agg_json" | jq -r '.static.citations.max')
      a_cit_min=$(echo "$agg_json" | jq -r '.agentic.citations.min')
      a_cit_max=$(echo "$agg_json" | jq -r '.agentic.citations.max')
    else
      s_cov_min=$(echo "$agg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['static']['coverage']['min'])")
      s_cov_max=$(echo "$agg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['static']['coverage']['max'])")
      a_cov_min=$(echo "$agg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['agentic']['coverage']['min'])")
      a_cov_max=$(echo "$agg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['agentic']['coverage']['max'])")
      s_cit_min=$(echo "$agg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['static']['citations']['min'])")
      s_cit_max=$(echo "$agg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['static']['citations']['max'])")
      a_cit_min=$(echo "$agg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['agentic']['citations']['min'])")
      a_cit_max=$(echo "$agg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['agentic']['citations']['max'])")
    fi
    variance_section=$(cat <<VARSECTION

## Variance across $num_runs runs

| Metric                      | Pipeline | Min      | Max      | Mean     |
|-----------------------------|----------|----------|----------|----------|
| research_questions_coverage | static   | $s_cov_min | $s_cov_max | $s_cov_mean |
| research_questions_coverage | agentic  | $a_cov_min | $a_cov_max | $a_cov_mean |
| avg_citations_per_page      | static   | $s_cit_min | $s_cit_max | $s_cit_mean |
| avg_citations_per_page      | agentic  | $a_cit_min | $a_cit_max | $a_cit_mean |

VARSECTION
)
  fi

  local run_date
  run_date=$(date "+%Y-%m-%d %H:%M:%S")

  # ── Write markdown ────────────────────────────────────────────────────────
  cat > "$out_md" <<REPORT_EOF
# Static vs. Agentic Wiki — Comparison Report

Generated: $run_date
Topic: $CMP_TOPIC
Runs: $num_runs  |  JSON parser: $_CMP_JSON_PARSER

## Run Configuration

| Parameter       | Value       |
|-----------------|-------------|
| topic           | $CMP_TOPIC  |
| runs            | $num_runs   |
| skip_static     | $CMP_SKIP_STATIC |
| skip_agentic    | $CMP_SKIP_AGENTIC |
| max_search      | $CMP_MAX_SEARCH |
| max_writes      | $CMP_MAX_WRITES |
| wall_clock_min  | $CMP_WALL_CLOCK |

## Side-by-Side Metrics (mean across $num_runs run(s))

> Key metrics (used in acceptance decision): **research_questions_coverage** and **avg_citations_per_page**
> For orphan_ratio: lower is better. For all others: higher is better.

| Metric                        | Static         | Agentic        | Delta          | Winner  |
|-------------------------------|----------------|----------------|----------------|---------|
| research_questions_coverage   | $s_cov_mean    | $a_cov_mean    | $delta_cov     | $win_cov |
| orphan_ratio (lower=better)   | $s_orp_mean    | $a_orp_mean    | $delta_orp     | $win_orp |
| avg_citations_per_page        | $s_cit_mean    | $a_cit_mean    | $delta_cit     | $win_cit |
| total_pages                   | $s_pgs_mean    | $a_pgs_mean    | $delta_pgs     | $win_pgs |

## Acceptance Summary

POC criterion: agentic >= static on BOTH key metrics (coverage AND citations) in at least one run.

$acceptance_line
$variance_section
## Notes

- Static baseline: scored from existing \`deepresearch/output/wiki/\` state before agentic run.
  If no static wiki was present, all static metrics default to 0 / placeholder.
- Agentic pipeline: \`build-wiki\` with CI-friendly budgets (search=$CMP_MAX_SEARCH, writes=$CMP_MAX_WRITES, wall=${CMP_WALL_CLOCK}min).
  Full production run uses defaults: search=40, writes=60, wall=30min.
- acceptance bar per dr2-agentic-web-search-plan.md §T12: run 2x, POC passes if EITHER run shows agentic >= static on both key metrics. Variance is documented above.

REPORT_EOF

  echo ""
  echo "==> Comparison report written: $out_md"
}

# ── Main orchestration ────────────────────────────────────────────────────────
echo "==> compare_static_vs_agentic.sh"
echo "    topic:        $CMP_TOPIC"
echo "    runs:         $CMP_RUNS"
echo "    skip_static:  $CMP_SKIP_STATIC"
echo "    skip_agentic: $CMP_SKIP_AGENTIC"
echo "    output:       $CMP_OUTPUT"
echo "    json parser:  $_CMP_JSON_PARSER"
echo ""

mkdir -p "deepresearch/output/evaluation"

# Accumulate per-run data in a temp file
RUN_DATA_FILE=$(mktemp /tmp/dr2_cmp_runs_XXXXXX.tsv)
trap 'rm -f "$RUN_DATA_FILE"' EXIT

ANY_STATIC_SCORED=false
ANY_AGENTIC_SCORED=false

for (( run=1; run<=CMP_RUNS; run++ )); do
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Run $run / $CMP_RUNS"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  STATIC_JSON="deepresearch/output/evaluation/static_run${run}.json"
  AGENTIC_JSON="deepresearch/output/evaluation/agentic_run${run}.json"

  CMP_STATIC_SCORED=false
  CMP_AGENTIC_SCORED=false

  _cmp_run_static  "$run" "$STATIC_JSON"
  _cmp_run_agentic "$run" "$AGENTIC_JSON"

  [ "$CMP_STATIC_SCORED"  = "true" ] && ANY_STATIC_SCORED=true
  [ "$CMP_AGENTIC_SCORED" = "true" ] && ANY_AGENTIC_SCORED=true

  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$run" "$STATIC_JSON" "$AGENTIC_JSON" \
    "$CMP_STATIC_SCORED" "$CMP_AGENTIC_SCORED" \
    >> "$RUN_DATA_FILE"
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Writing comparison report..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

_cmp_write_report "$CMP_OUTPUT" "$RUN_DATA_FILE" "$CMP_RUNS"

# ── Exit code logic ───────────────────────────────────────────────────────────
if [ "$ANY_STATIC_SCORED" = "false" ] && [ "$ANY_AGENTIC_SCORED" = "false" ]; then
  echo ""
  echo "ERROR: Neither pipeline could be scored in any run." >&2
  echo "  Make sure at least one wiki directory has .md files after the pipeline runs." >&2
  exit 1
fi

# Check if agentic lost on both key metrics in all runs
AGENTIC_VERDICT=$(python3 - "$RUN_DATA_FILE" "$_CMP_JSON_PARSER" <<'VERDICTEOF'
import sys, json, os

run_data_file = sys.argv[1]
parser = sys.argv[2]

wins = 0
total = 0

with open(run_data_file) as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        parts = line.split('\t')
        if len(parts) < 5:
            continue
        _, static_json, agentic_json, ss, asf = parts

        def get_wiki_field(path, key, default=0.0):
            try:
                with open(path) as f:
                    d = json.load(f)
                val = (d.get("wiki") or {}).get(key)
                return float(val) if val is not None else default
            except Exception:
                return default

        sc = get_wiki_field(static_json,  "research_questions_coverage", 0.0)
        ac = get_wiki_field(agentic_json, "research_questions_coverage", 0.0)
        sci = get_wiki_field(static_json,  "avg_citations_per_page", 0.0)
        aci = get_wiki_field(agentic_json, "avg_citations_per_page", 0.0)

        total += 1
        if ac >= sc and aci >= sci:
            wins += 1

if total == 0:
    print("no_data")
elif wins == 0:
    print("lost_all")
else:
    print("passed")
VERDICTEOF
)

echo ""
echo "==> Final verdict: $AGENTIC_VERDICT ($CMP_RUNS run(s))"
echo "    Report: $CMP_OUTPUT"

if [ "$AGENTIC_VERDICT" = "lost_all" ]; then
  echo ""
  echo "NOTE: Agentic pipeline lost on both key metrics in all $CMP_RUNS run(s)." >&2
  echo "  This does not necessarily mean the POC failed — run with higher budgets" >&2
  echo "  (remove --skip-* flags and increase --max-search/--max-writes/--wall-clock)" >&2
  echo "  to get production-quality results." >&2
  exit 2
fi

exit 0
