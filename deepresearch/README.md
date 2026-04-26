# DeepResearch 2.0

> **核心叙事**：MinerU 文档探索器不是"研报生成器"——它是 **DeepResearch 基础设施**：
> 先把领域知识组织成可复用的专家 Wiki，再基于 Wiki 输出高质量研报，并用一份直接生成的对照报告证明价值差距。

详细设计见 [`docs/deepresearch-2.0.md`](../docs/deepresearch-2.0.md)。本目录是其 **POC 的代码与提示词实现**。

---

## 一句话流程

```
主题 → fetch (papers + blogs + repos) → qmd 索引 → Agent 走 Wiki 先行 → Agent 走直接生成 → 对比 → 评分
```

非智能（脚本）部分：抓数据 + 建索引 + 自动检查。
智能（Agent）部分：Wiki 编译 + 研报撰写 + 对比 + 主观评分。

---

## 快速跑通（POC，约 30 分钟）

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
#    deepresearch/prompts/01-WIKI-FIRST-zh.md   ← 先建 Wiki + Wiki 研报
#    deepresearch/prompts/02-DIRECT-zh.md       ← 对照：直接生成研报
#    deepresearch/prompts/03-COMPARE-zh.md      ← 对比报告 + comparison.json
#    deepresearch/prompts/04-EVALUATE-zh.md     ← 评分（写 wiki-first.json / direct.json）

# 4. 运行自动检查 + 综合评分
bash deepresearch/run.sh check
```

---

## 目录结构

```
deepresearch/
├── README.md                     ← 你正在看
├── run.sh                        ← 顶层编排（setup / serve / check / doctor / clean）
├── topics/
│   └── document-parsing.yml      ← 主题种子（论文 / 博客 / 仓库 / 研究问题）
├── scripts/
│   ├── setup.sh                  ← 抓取 + 索引 一条龙
│   ├── fetch_papers.py           ← arXiv 关键词 + 种子论文
│   ├── fetch_blogs.py            ← 博客 / 长文 → markdown
│   └── fetch_repos.py            ← GitHub README 抓取
├── prompts/
│   ├── 01-WIKI-FIRST-zh.md       ← Phase 1：Wiki 编译 + Wiki 研报
│   ├── 02-DIRECT-zh.md           ← Phase 2：直接生成对照
│   ├── 03-COMPARE-zh.md          ← Phase 3：对比报告
│   └── 04-EVALUATE-zh.md         ← Phase 4：评分
├── eval/
│   ├── rubric.md                 ← 6 维 100 分制评分细则
│   ├── auto_check.py             ← 引用率 / 章节均衡 / 覆盖度 客观下限
│   └── score.py                  ← 综合两份 evaluation JSON → summary
├── sources/                      ← 抓取产物（gitignore）
│   ├── papers/
│   ├── blogs/
│   └── repos/
└── output/                       ← Agent 写入产物
    ├── wiki/                     ← Wiki collection（LLM 编译）
    ├── reports/
    │   ├── wiki-first.md
    │   ├── direct.md
    │   └── comparison.md
    └── evaluation/
        ├── wiki-first.json
        ├── direct.json
        ├── comparison.json
        ├── summary.json
        └── summary.md
```

---

## 4 份 Agent Prompt 的使用顺序

### Phase 1 — `prompts/01-WIKI-FIRST-zh.md`
让 Agent：
1. 先做侦察 + 写 `roadmap.md`
2. 对每个高信任源走 `wiki_ingest → doc_read → doc_write` 流程，写到 `wiki/papers/*`、`wiki/concepts/*`、`wiki/repos/*`
3. 概念页跨引用 ≥3 个论文/仓库
4. 最终写 `wiki/reports/wiki-first.md`，跑 `wiki_lint` + `wiki_index`

**铁律**：所有"结论 / 数字 / 评测"必须有 evidence。

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
- [ ] MVP：把 prompts 包成 SDK，支持多主题并行
- [ ] Demo：1 屏 summary 页 + 网页交互对比
