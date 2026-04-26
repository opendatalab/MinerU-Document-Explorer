# DeepResearch 2.0

> **核心叙事**：MinerU 文档探索器不是"研报生成器"——它是 **DeepResearch 基础设施**：
> 先把领域知识组织成可复用的专家 Wiki，再基于 Wiki 输出高质量研报，并用一份直接生成的对照报告证明价值差距。
>
> Wiki 由 Agent **持续维护**：通过交错的 Web 搜索循环动态发现和摄取新来源，不是静态一次性写完。

详细设计见 [`docs/deepresearch-2.0.md`](../docs/deepresearch-2.0.md)。本目录是其 **POC 的代码与提示词实现**。

---

## 一句话流程

```
主题 → fetch (papers + blogs + repos) → qmd 索引 → Agent 走 Wiki 先行 → Agent 走直接生成 → 对比 → 评分
```

非智能（脚本）部分：抓数据 + 建索引 + 自动检查。
智能（Agent）部分：Wiki 编译（含 Agentic Web 搜索）+ 研报撰写 + 对比 + 主观评分。

---

## 完整流程

本项目支持两种运行模式，可按需选择：

### 模式 A：静态资料 + 手动 Prompt 投喂（原始方式）

```bash
# 0. 依赖
python3 --version            # >= 3.10
pip install feedparser pyyaml pymupdf
# 可选：pip install beautifulsoup4 html2text  (改善博客抓取)

# 1. 抓资料 + 建索引（默认主题=文档解析；首次会下载 embedding 模型）
bash deepresearch/run.sh setup --max 20 --skip-embed     # 课堂版：快
bash deepresearch/run.sh setup --max 30                   # 完整版：含 embedding

# 2. 启 MCP 服务器
bash deepresearch/run.sh serve --port 8181
# 另开终端把 Agent 接到 http://localhost:8181/mcp

# 3. 把 4 份 prompt 顺序投喂给 Agent
#    deepresearch/prompts/01-WIKI-FIRST-zh.md   ← 先建 Wiki（含 Agentic Web 搜索）+ Wiki 研报
#    deepresearch/prompts/02-DIRECT-zh.md       ← 对照：直接生成研报
#    deepresearch/prompts/03-COMPARE-zh.md      ← 对比报告 + comparison.json
#    deepresearch/prompts/04-EVALUATE-zh.md     ← 评分（写 wiki-first.json / direct.json）

# 4. 运行自动检查 + 综合评分（含 Wiki 评分）
bash deepresearch/run.sh check
```

### 模式 B：`build-wiki` 全自动 Agentic 模式

```bash
# 0. 依赖同模式 A，另需安装 html2text（web_fetch 抓取网页用）
pip install html2text

# 1. 验证执行计划（不实际运行）
bash deepresearch/run.sh build-wiki \
  --topic deepresearch/topics/document-parsing.yml --dry-run

# 2. 正式运行（modest budget 示例）
bash deepresearch/run.sh build-wiki \
  --topic deepresearch/topics/document-parsing.yml \
  --max-search 20 --max-writes 30 --wall-clock 10

# 3. 查看 Wiki 评分 + 研报评分
bash deepresearch/run.sh check

# 4. 与纯静态模式对比（可选）
bash deepresearch/eval/compare_static_vs_agentic.sh \
  --topic deepresearch/topics/document-parsing.yml
```

---

## Agentic Wiki 构建

### 三个新 MCP 工具

`build-wiki` 依赖以下三个 MCP 工具，在 `src/mcp/tools/web.ts` 中注册：

| 工具 | 用途 |
|---|---|
| `web_search` | 归一化并存储来自 Agent 内置 WebSearch 的搜索结果（去重 + 可信度评分 + 持久化到 `sources/web/`） |
| `web_fetch` | 抓取单个 URL，返回 `{markdown, title, meta, extracted_links}`；`word_count < 100` 视为空页跳过 |
| `credibility_score` | 对一个来源打可信度分（0.0–1.0），输出 `score`、`reasons`、`components`（domain / recency / corroboration） |

工具使用方式：Agent 先调用内置 `WebSearch` 获取结果，再将结构化结果传入 `web_search` 存储；随后对每个候选 URL 调用 `credibility_score`，通过后再调用 `web_fetch` 获取正文。

### `build-wiki` 状态机

`run.sh build-wiki` 按轮次（round）编排多个新鲜 Claude Code 会话：

1. **SEED_BOOTSTRAP**：运行 `setup.sh` 抓取种子语料（papers / blogs / repos）并建索引
2. **AGENT_LOOP**：每轮启动一次新的 CC 会话，Agent 通过 `web_search → credibility_score → web_fetch → wiki_ingest → doc_write` 链路交错搜索与写入
3. **FINALIZE**：生成 `wiki_index`，保存最终 wiki_log
4. **EVALUATE**：调用 `auto_check.py` 输出 Wiki 评分（`research_questions_coverage` / `orphan_ratio` / `avg_citations_per_page`）

每轮之间通过 `deepresearch/output/.build-wiki-state.json` 检查点传递轮次编号和预算配置；预算计数器始终从 `wiki_log` 重新推导，不依赖检查点缓存值。

### 三个停止条件

`build-wiki` 在每轮结束后检查，满足任一即停止：

1. **coverage_met**：`research_questions_coverage >= 0.70` 且 `orphan_ratio <= 0.15`
2. **lint_clean**：`wiki_lint` 返回 0 broken_links 且孤立页比例低于阈值
3. **budget_exhausted**：`web_search` 调用数、`doc_write` 调用数或挂钟时间任一超出上限

停止原因写入检查点 `stop_reason` 字段，并在 `run.sh check` 输出中显示。

### 预算 flags

| flag | 默认值 | 含义 |
|---|---|---|
| `--max-search N` | 40 | 最多调用 `web_search` N 次 |
| `--max-writes N` | 60 | 最多调用 `doc_write` N 次 |
| `--wall-clock MIN` | 30 | 挂钟时间上限（分钟） |
| `--dry-run` | — | 打印计划，不实际执行 |
| `--resume` | — | 从检查点继续上次未完成的构建 |

### 可信度评分分层策略

- **POC**：纯 Python stdlib 启发式（domain 域名分级 + recency 时效衰减 + corroboration 关键词重叠），零额外依赖
- **MVP**：`method: "judge"` — 小 LLM 裁判（OpenAI/Anthropic API，可选依赖）
- **Prod**：`method: "pr"` — 引用图 PageRank，从抽取的参考文献中构建

---

## v2 Dashboard & LLM-Judge

### v2 新增能力概览

v2 在 Agentic Wiki 构建基础上新增两项能力：

1. **`judge_claim` MCP 工具**：Agent 在写页面时对每条关键结论自行调用裁判，
   把裁判结果（`SUPPORTED / PARTIAL / REFUTED / INSUFFICIENT`）写回知识库，
   可信度得分随之更新为 `credibility_score(method="judge")` 融合模式。
2. **进步 Dashboard**：每次 `build-wiki` 结束后自动追加一条 JSONL 记录到
   `output/evaluation/dashboard.jsonl`，记录三条新指标趋势，供跨轮次对比。

### `judge_claim` 使用模式

Agent 在交错循环中对每条待写结论执行：

```
wiki_ingest → 草稿 → judge_claim(claim, evidence_ids) → 收到 VERDICT
→ 若 SUPPORTED/PARTIAL：写入页面，标注 [judge: ✓]
→ 若 REFUTED：丢弃或标注 [judge: ✗]，寻找替代证据
→ 若 INSUFFICIENT：降低引用权重，标注数据不足
```

`credibility_score(method="judge")` 融合公式：

```
final_score = 0.5 × heuristic_score + 0.5 × verdict_score
```

其中 `verdict_score` 由以下映射表给出：

| VERDICT | verdict_score |
|---|---:|
| SUPPORTED | 1.0 |
| PARTIAL | 0.6 |
| INSUFFICIENT | 0.4 |
| REFUTED | 0.0 |

### Dashboard 使用命令

```bash
# 每次 build-wiki 结束后自动 append，无需手动触发
# 查看全部历史趋势：
bash deepresearch/run.sh dashboard

# 仅查看指定主题最近 N 次：
bash deepresearch/run.sh dashboard --topic document-parsing --last 5
```

### Dashboard Metric 定义

| 指标 | 含义 | 目标 |
|---|---|---:|
| `coverage_density` | 已覆盖 research_question 数 / 总问题数 | ≥ 0.70 |
| `freshness` | 来源中位数发布日期距今的新鲜度（0–1，指数衰减） | ≥ 0.60 |
| `judge_verified_ratio` | Agent 调用 `judge_claim` 核验且 SUPPORTED/PARTIAL 的结论占全部结论的比例 | ≥ 0.50 |
| `judge_verified_count` | SUPPORTED + PARTIAL 裁决的原始计数 | — |
| `judge_total_count` | `judge_claim` 调用总次数 | — |

### Self-assessment caveat（自评下界说明）

`judge_verified_ratio`（JVR）是 **self-assessment lower bound**（**自评下界**）：
裁判与被评对象同为 LLM，存在系统性乐观偏差。
JVR 低（< 0.3）说明结论质量确实有问题；JVR 高（> 0.7）只能说明**自评**通过，
不能替代人工审核。将 JVR 与 `avg_citations_per_page` 联合解读比单独看更可靠。

`freshness` 是信号，不是目标。不应为了拉高 median_date 而放弃奠基性工作（seminal
papers）——新鲜度指标反映来源时效，不是评价来源价值的唯一维度。

---

## 目录结构

```
deepresearch/
├── README.md                     ← 你正在看
├── run.sh                        ← 顶层编排（setup / serve / check / doctor / clean / build-wiki）
├── topics/
│   └── document-parsing.yml      ← 主题种子（论文 / 博客 / 仓库 / 研究问题 / web_search.queries）
├── scripts/
│   ├── setup.sh                  ← 抓取 + 索引 一条龙（含 sources/web/ collection）
│   ├── fetch_papers.py           ← arXiv 关键词 + 种子论文
│   ├── fetch_blogs.py            ← 博客 / 长文 → markdown
│   ├── fetch_repos.py            ← GitHub README 抓取
│   ├── credibility_heuristic.py  ← 可信度启发式评分（Python stdlib，零额外依赖）
│   └── web_fetch.py              ← URL 抓取 → markdown（html2text / urllib fallback）
├── prompts/
│   ├── 01-WIKI-FIRST-zh.md       ← Phase 1：Wiki 编译（Agentic 交错模式）+ Wiki 研报
│   ├── 02-DIRECT-zh.md           ← Phase 2：直接生成对照
│   ├── 03-COMPARE-zh.md          ← Phase 3：对比报告
│   └── 04-EVALUATE-zh.md         ← Phase 4：评分
├── eval/
│   ├── rubric.md                 ← 6 维 100 分制评分细则
│   ├── auto_check.py             ← 引用率 / 章节均衡 / 覆盖度 + Wiki 三项指标
│   ├── score.py                  ← 综合两份 evaluation JSON → summary
│   ├── test_credibility.py       ← credibility_heuristic 单元测试
│   └── compare_static_vs_agentic.sh  ← 静态 vs Agentic 对比脚本
├── sources/                      ← 抓取产物（gitignore）
│   ├── papers/
│   ├── blogs/
│   ├── repos/
│   └── web/                      ← Agent 通过 web_fetch 存入的网页 markdown
└── output/                       ← Agent 写入产物
    ├── wiki/                     ← Wiki collection（LLM 编译）
    ├── reports/
    │   ├── wiki-first.md
    │   ├── direct.md
    │   └── comparison.md
    ├── evaluation/
    │   ├── wiki-first.json
    │   ├── direct.json
    │   ├── comparison.json
    │   ├── wiki-standalone.json  ← build-wiki 的 Wiki 评分
    │   ├── build-wiki-run.json   ← build-wiki 完整评估
    │   ├── summary.json
    │   └── summary.md
    └── .build-wiki-state.json    ← build-wiki 检查点（轮次 + 预算配置）
```

---

## 4 份 Agent Prompt 的使用顺序

### Phase 1 — `prompts/01-WIKI-FIRST-zh.md`
让 Agent：
1. 先做侦察 + 写 `roadmap.md`
2. **交错循环**：通过 `web_search → credibility_score → web_fetch → wiki_ingest → doc_write` 发现并摄取新来源；本地内容充足时直接 `wiki_ingest + doc_write`，跳过 Web 搜索
3. 概念页跨引用 ≥3 个来源（论文 / 博客 / 仓库 / web）
4. 当预算（`search_remaining` / `writes_remaining` / `minutes_remaining`）任一低于 20% 时切换到收敛模式
5. 最终写 `wiki/reports/wiki-first.md`，跑 `wiki_lint` + `wiki_index`

**铁律**：所有"结论 / 数字 / 评测"必须有 evidence。`credibility_score < 0.3` 的来源不引用。

### Phase 2 — `prompts/02-DIRECT-zh.md`（对照）
**严格不准**调用任何 `wiki_*` 工具或读 Phase 1 产物，模拟"传统直接 RAG"流程，
把检索片段拼装成 `output/reports/direct.md`。这是基线，不是产品。

### Phase 3 — `prompts/03-COMPARE-zh.md`
按 6 维做并排对比 + 5 个最具说服力的差距实例 + 局限承认，输出
`output/reports/comparison.md` 和机器可读的 `output/evaluation/comparison.json`。

### Phase 4 — `prompts/04-EVALUATE-zh.md`
- 先跑 `python3 deepresearch/eval/auto_check.py` 拿客观下限
- 再做主观打分（必须 evidence 支撑），输出
  `output/evaluation/wiki-first.json` 和 `output/evaluation/direct.json`
- 最后由 `eval/score.py` 校验权重 + 生成 `summary.json` / `summary.md`

---

## 评分细则（rubric）

100 分制，6 维（详见 [`eval/rubric.md`](eval/rubric.md)）：

| 维度 | 权重 | 关键检查 |
|---|---:|---|
| 来源质量 | 20 | 一手 / 高 stars / 时效 / 多样性 |
| 覆盖完整度 | 20 | 7 个 research_questions 命中数 |
| 引用可追溯性 | 20 | 结论级语句的 citation_ratio |
| 结构与连贯性 | 15 | 章节均衡 / 术语一致 |
| 洞察与判断 | 15 | trade-off / 反例 / "不敢下的结论" |
| 结论稳定性 | 10 | 跨章节一致 / 防 hallucination |

预期分布（见 rubric.md 末尾）：
- Wiki 先行版：80–95
- 直接生成版：50–70
- 总差距：约 25–35 分（核心来自"可追溯性"和"洞察"）

---

## 切换主题（创建新研究方向）

复制 `topics/document-parsing.yml` 并改 4 处：

```yaml
topic: <你的主题名>
slug: <英文短名>
arxiv:
  queries: [...]      # 关键词
  date_from / date_to / max_*
seed_papers:          # 必须强制纳入的论文
blogs / repos:        # URL 列表
research_questions:   # 7–10 个核心问题
```

然后：

```bash
bash deepresearch/run.sh setup --topic deepresearch/topics/<your>.yml
```

prompts 不需要改——它们是主题无关的方法论，由 Agent 在 runtime 读 `topics/*.yml` 知道要回答什么问题。

---

## 与现有 `demo/` 的区别

| 维度 | `demo/`（v1） | `deepresearch/`（v2） |
|---|---|---|
| 主题 | 写死 RAG | yml 驱动，文档解析为首发 |
| 来源 | arXiv only | papers + blogs + repos |
| 输出 | 1 份综述 | Wiki 研报 + 直接研报 + 对比 + 评分 |
| 评估 | 无 | 6 维 100 分制 + 自动检查 |
| 演示价值 | "Agent 能写 wiki" | "Wiki 路径 vs 直接生成的差距是可量化的" |

---

## FAQ

**Q：Agent 失败 / 中途断了怎么办？**
A：每个 Phase 都是幂等的。重投同一份 prompt 即可。`wiki_log` / `wiki_lint` 让 Agent 看到当前进度。

**Q：可以只跑 Phase 1 吗？**
A：可以。`bash run.sh check` 会跳过未存在的产物。

**Q：必须用 MinerU Cloud 吗？**
A：不必。PyMuPDF 默认即可；MinerU Cloud 解析复杂版面 / 扫描件更好（见仓库根 `CLAUDE.md`）。

**Q：评分能彻底自动化吗？**
A：不能也不必。`auto_check.py` 给客观下限，主观维度（洞察 / 稳定性）必须 Agent / 人来判。
强制"evidence + rationale"是为了让评分**可审计**——这本身就是对照实验的要点。

---

## 路线图

- [x] POC：单主题、4 份 prompt、6 维评分（本目录）
- [x] Agentic Web 搜索：`web_search` / `web_fetch` / `credibility_score` MCP 工具 + `build-wiki` CLI
- [ ] MVP：把 prompts 包成 SDK，支持多主题并行
- [ ] Demo：1 屏 summary 页 + 网页交互对比
