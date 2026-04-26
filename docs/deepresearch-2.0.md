# DeepResearch 2.0 项目文档

## 1. 项目背景

MinerU 文档探索器已经具备高精度文档解析、检索、深读、MCP 工具和 LLM Wiki 生命周期能力。下一步要做的，不是再做一个普通的研报生成器，而是把 MinerU 升级为 **DeepResearch 2.0 基础设施**：

> 先构建专家知识体系（LLM Wiki），再基于该知识体系生成高质量研报。

本项目希望让社区用户直观感受到 MinerU 的独特价值：
- 不是“直接搜一搜就写报告”
- 而是“先把领域知识组织成可复用的专家体系，再输出研报”
- 同时提供与直接生成式报告的对比，让价值一目了然

---

## 2. 项目目标

### 2.1 核心目标
围绕一个垂直科研主题，构建一条完整的 DeepResearch 工作流：

1. 输入研究主题
2. 自动收集高质量资料
3. 自动整理为 LLM Wiki
4. 基于 Wiki 生成研报
5. 与直接生成式研报对比
6. 输出可展示、可复用、可审计的结果

### 2.2 项目价值
- **对社区用户**：更容易理解 MinerU 的独特价值
- **对研究人员**：将调研过程沉淀为可复用资产
- **对实验室**：形成可持续增长的领域知识库
- **对产品演示**：用强对比证明“先建 Wiki 再写研报”的必要性

---

## 3. 目标场景与范围

### 3.1 首发场景
第一版只做一个单一主题：

> **文档解析领域调研**

该场景适合作为样板，因为它与 MinerU 的核心能力高度一致，同时能体现“文档 → 知识体系 → 研报”的完整链路。

### 3.2 资料来源
第一版允许纳入：
- 论文
- 技术博客
- 开源仓库
- **Agent 运行时通过 `web_search` + `web_fetch` 动态发现的 Web 来源**：构建阶段由
  `build-wiki` 状态机驱动，Agent 调用 `credibility_score` 对每个候选 URL 打分，
  高于门槛（默认 0.3）方才抓取并摄取，结果存入 `sources/web/` collection。

### 3.3 技术边界
- 可使用外部大模型 API
- 聚焦单主题、单场景
- 以 Wiki 先行流程为主

### 3.4 不在本期范围内
- 多人协作编辑
- 自动训练 / 蒸馏闭环
- 实时抓取与持续监控
- 多领域泛化平台
- 复杂审批流

---

## 4. 用户与使用场景

### 4.1 社区用户
- 想快速了解某个技术方向
- 想复用现成的研究工作流
- 想验证 MinerU 的独特价值

### 4.2 研究人员
- 想把调研从一次性产出变成知识资产
- 想提升调研质量和可追溯性
- 想在后续主题中复用已有 Wiki

### 4.3 内部维护者
- 想评估不同主题下的研究质量
- 想查看 Wiki 结构健康度
- 想持续优化知识编译流程

---

## 5. 需求分析

## 5.1 功能需求

### 5.1.1 主题输入
- 用户输入研究主题
- 支持配置语料规模和来源类型
- 支持选择输出模式：Wiki / 研报 / 对比

### 5.1.2 资料摄取
- 自动搜集资料
- 自动去重
- 自动记录来源信息
- 对来源进行基础分级
- **Agent 运行时通过 `web_search → credibility_score → web_fetch → wiki_ingest`
  链路发现并摄取新源**：种子语料建立索引后，Agent 在每轮交错循环中搜索 Web
  来源、评分并按门槛过滤，再将通过审核的内容写入 `sources/web/` collection
  后经 `wiki_ingest` 纳入知识体系。
  - **可信度评分分层策略**：
    - POC：Python stdlib 启发式（domain 域名分级 + recency 时效衰减 +
      corroboration 关键词重叠），权重 0.40 / 0.25 / 0.35，零额外依赖；
      工具名：`credibility_score`（`method: "heuristic"`）
    - MVP：LLM 裁判（`method: "judge"`）— 小型语言模型对候选来源作主观评估，
      使用 OpenAI/Anthropic API，可选依赖
    - Prod：引用图 PageRank（`method: "pr"`）— 从文档参考文献中抽取引用关系，
      构建图并计算权威度

### 5.1.3 Wiki 构建
- 自动生成概念页
- 自动生成页面链接
- 自动维护来源引用
- 支持 Wiki lint（如 broken link、孤立页）

### 5.1.4 研报生成
- 基于 Wiki 生成结构化研报
- 支持章节化输出
- 支持引用标注
- 支持结论总结

### 5.1.5 对比输出
- 同时输出直接生成式研报
- 同时输出 Wiki 先行研报
- 自动生成对比页
- 自动给出质量差异说明

### 5.1.6 Wiki 质量评分（v2 扩展）

v2 在 v1 三项指标基础上新增 `freshness` 和 `judge_verified_ratio`，
共五条 metric，由 `auto_check.py` + dashboard 联合输出：

| 指标 | 来源 | 目标值 | 备注 |
|---|---|---:|---|
| `research_questions_coverage` | v1 | ≥ 0.70 | topics.yml 中各问题有 Wiki 覆盖的比例 |
| `orphan_ratio` | v1 | ≤ 0.15 | 零入链 Wiki 页占总页数比例 |
| `avg_citations_per_page` | v1 | ≥ 2.0 | 每页平均引用来源数 |
| `freshness` | v2 | ≥ 0.60 | 来源中位数发布日期的新鲜度（指数衰减，0–1） |
| `judge_verified_ratio` | v2 | ≥ 0.50 | judge_claim 裁决 SUPPORTED/PARTIAL 占全部裁决比例（self-assessment） |

原始计数字段：`judge_verified_count`（通过裁决数）、`judge_total_count`（总裁决数）。

---

## 5.2 非功能需求
- **可追溯**：每个结论要能回到来源
- **可复用**：Wiki 可持续演进，不是一次性报告附件
- **可解释**：质量评估结果要可理解
- **可扩展**：后续可迁移到其他领域
- **可展示**：适合社区传播和演示

---

## 6. 研报质量评估标准

研报质量不应只看“像不像一篇报告”，而应从三层评估：

### 6.1 Wiki 质量
衡量知识底座是否足够强：
- 来源质量
- 覆盖完整度
- 结构健康度
- 可追溯性
- 去噪能力

### 6.2 研报内容质量
衡量最终输出是否像专家写的：
- 准确性
- 一致性
- 深度
- 结构性
- 洞察力
- 引用质量

### 6.3 相对优势
衡量 Wiki 先行是否真的优于直接生成：
- 结论是否更稳
- 引用是否更可靠
- 覆盖是否更完整
- 返工是否更少
- 复用是否更高

### 6.4 进步 Dashboard（v2）

每次 `build-wiki` 结束后，系统自动向
`deepresearch/output/evaluation/metrics-history.jsonl` 追加一行 JSON 记录，
包含本轮所有五项 metric 及时间戳，供跨轮次趋势分析。

**查看命令：**

```bash
bash deepresearch/run.sh dashboard                            # 所有 topic 所有 run
bash deepresearch/run.sh dashboard --topic document-parsing --last 5
```

输出为 Markdown 表格，含 Runs 明细 + Trends 趋势（相邻两轮 Δ + 方向箭头）。

**重要提醒**：`freshness` 和 `judge_verified_ratio` 只作为 dashboard 趋势信号，
**不计入 `overall_pass`**。`overall_pass` 仅由 `coverage_density ≥ 0.70` 与
`orphan_ratio ≤ 0.15` 决定。`judge_verified_ratio` 是 **自评下界**（self-assessment
lower bound），反映 Agent 自判时刻的可信度，不是独立验证结果。`freshness` 是
来源时效信号，不应为拉高 median_date 而放弃奠基性工作。

### 6.5 建议评分维度
建议采用 100 分制：

| 维度 | 权重 | 说明 |
|---|---:|---|
| 来源质量 | 20 | 一手来源、权威度、时效性 |
| 覆盖完整度 | 20 | 核心概念和关键方法是否齐全 |
| 引用可追溯性 | 20 | 结论能否回到具体证据 |
| 结构与连贯性 | 15 | 章节是否清晰、脉络是否完整 |
| 洞察与判断 | 15 | 是否有分析，不只是拼贴 |
| 结论稳定性 | 10 | 前后是否一致，是否容易被推翻 |

---

## 7. 系统设计

## 7.1 总体架构
系统建议分为六层：

1. **输入层**：主题输入、参数配置、运行模式选择
2. **采集层**：论文 / 博客 / 仓库的采集、去重、分级
3. **解析层**：文档解析、结构切分、元信息抽取、证据抽取
4. **Wiki 编译层**：概念页生成、页面链接生成、来源绑定、Wiki lint
5. **研报生成层**：基于 Wiki 生成研报、生成对照报告
6. **评估层**：自动评分、对比分析、输出总结

### 7.2 数据流
```text
主题输入
  → 资料采集
  → 文档解析
  → 证据抽取
  → 概念聚类
  → LLM Wiki 编译
  → Wiki lint / index
  → 基于 Wiki 生成研报
  → 直接生成对照研报
  → 质量评估与对比
```

### 7.3 核心模块

#### A. Research Orchestrator
负责整个研究流程编排：
- 拆解任务
- 调用各阶段能力
- 管理状态流转

#### B. Evidence Store
负责存储研究证据：
- 来源
- 片段
- 可信度
- 关联概念
- provenance

#### C. Wiki Compiler
负责把证据编译成 Wiki：
- 生成概念页
- 建立链接关系
- 合并重复概念
- 维护来源引用

#### D. Report Composer
负责从 Wiki 生成研报：
- 章节化输出
- 引用标注
- 结论提炼
- 对齐研究主题

#### E. Evaluator
负责质量评估与对照：
- 计算评分
- 比较两种路径
- 输出差异解释

---

## 8. 数据模型建议

### Source
- id
- type
- title
- url
- author
- date
- trust_level

### Evidence
- id
- source_id
- snippet
- concept_tags
- confidence
- provenance

### WikiPage
- id
- title
- body
- links
- source_refs
- rank

### Claim
- id
- statement
- supporting_evidence
- confidence
- contradictions

### Report
- id
- topic
- content
- citations
- version
- score

### EvaluationRecord
- id
- report_id
- dimensions
- total_score
- comparison_result

---

## 9. 关键工作流

### 9.1 Wiki 先行工作流

Wiki 先行工作流已从静态的线性步骤升级为 **Agentic 交错循环**，由
`run.sh build-wiki` 驱动多轮 Claude Code 会话完成：

1. **初始化**：解析 `--topic` YAML，验证 qmd 环境，确定预算参数
   （`--max-search`、`--max-writes`、`--wall-clock`）
2. **种子引导（SEED_BOOTSTRAP）**：调用 `setup.sh` 抓取 papers / blogs / repos
   种子语料并建立 qmd 索引；初始化 `sources/web/` collection
3. **Agent 交错循环（每轮独立 CC 会话）**：
   1. 从 `wiki_log` 重新推导已用预算计数（`web_search` 调用次数 /
      `doc_write` 调用次数 / 挂钟时间），不依赖检查点缓存值
   2. 读取上一轮 `auto_check.py` 输出的覆盖率快照（`coverage_snapshot`），
      找出覆盖最弱的 `research_question` 或 Wiki 章节
   3. 若本地索引内容充足（命中 ≥ 3 且证据充分），直接
      `wiki_ingest + doc_write`，跳过 Web 搜索
   4. 若本地内容不足，发起 Web 搜索：调用内置 `WebSearch`，将结构化结果传给
      `web_search` MCP 工具归一化存储
   5. 对每个候选 URL 调用 `credibility_score`；分数 < 0.3 的来源跳过，
      ≥ 0.3 的调用 `web_fetch` 抓取正文
   6. 将通过审核的内容通过 `wiki_ingest → doc_write` 写入 Wiki；
      低可信度来源（0.3–0.5）在页面内标注警告
   6.5. **（v2 judge 步骤）** 对本轮写入的每条关键结论调用 `judge_claim`：
      传入 `source_text`、`claim`、`verdict`（`verified / under_supported /
      contradicted / gaming / unclear`）、`reasoning`、`confidence`，
      结果落盘到 `wiki_log`；`credibility_score(method="judge")` 融合启发式分
      与 `judge_verdict` 输出带 `components.judge` 子对象的最终得分
   7. 维护链接图：更新已有 Wiki 页的 wikilink，修订与新来源存在矛盾的旧页
   8. 每轮结束运行 `wiki_lint`，消除 broken_links 和孤立页
   9. 检查停止条件（见下）；写入原子检查点（仅含轮次编号和预算配置）
4. **停止条件**（满足任一即停止，并将原因写入 `stop_reason`）：
   - **coverage_met**：`research_questions_coverage ≥ 0.70` 且 `orphan_ratio ≤ 0.15`
   - **lint_clean**：`wiki_lint` 返回 0 broken_links 且孤立页比例低于阈值
   - **budget_exhausted**：`web_search` 调用数、`doc_write` 调用数或挂钟时间
     任一达到上限；达到前 20% 阈值时切换到收敛模式（停止探索新源，优先填补覆盖缺口）
5. **收尾（FINALIZE）**：运行 `wiki_index` 生成索引页；保存最终 `wiki_log`
6. **评估（EVALUATE）**：调用 `auto_check.py` 输出三项 Wiki 健康指标：
   - `research_questions_coverage`：`topics/*.yml` 中各 `research_question`
     有 Wiki 覆盖的比例（目标 ≥ 0.70）
   - `orphan_ratio`：零入链 Wiki 页占总页数的比例（目标 ≤ 0.15）
   - `avg_citations_per_page`：每个 Wiki 页平均引用的来源数（目标 ≥ 2.0）
7. **研报生成**：停止条件满足后，Agent 写 `wiki/reports/wiki-first.md`；
   后续可继续投喂 `02-DIRECT-zh.md`→`03-COMPARE-zh.md`→`04-EVALUATE-zh.md`
   完成对比评估流程

CLI 入口：

```bash
bash deepresearch/run.sh build-wiki \
  --topic deepresearch/topics/document-parsing.yml \
  --max-search 20 --max-writes 30 --wall-clock 10
```

详细状态机设计见 [`deepresearch/README.md`](../deepresearch/README.md) 的
"Agentic Wiki 构建"章节。

### 9.2 对照工作流
1. 使用同一主题直接做检索式生成
2. 生成直接研报
3. 与 Wiki 先行研报比较
4. 输出对比结论

---

## 10. MVP / POC / Demo 切分

### 10.1 POC
目标：证明这条路线可行。

交付物：
- 1 个主题
- 1 份 Wiki
- 1 份 Wiki 研报
- 1 份直接研报
- 1 份对比分析

### 10.2 MVP
目标：证明这条路线可复用。

交付物：
- 可重复运行的研究工作流
- 支持多来源输入
- 支持自动生成 Wiki
- 支持自动输出对比结果

### 10.3 Demo
目标：证明这条路线有冲击力。

交付物：
- 单主题、单场景演示
- 最直观的质量对比
- 社区可理解的产品叙事

---

## 11. 验收标准

第一版不追求通用平台能力，只需满足以下验收：

- 能围绕“文档解析领域”建立 Wiki
- Wiki 页之间存在清晰链接关系
- 能基于 Wiki 生成结构化研报
- 能生成对照的直接研报
- 能输出可解释的质量对比
- 用户能明显感受到“Wiki 先行”优于“直接生成”

---

## 12. 风险与对策

### 风险 1：主题过大
**对策**：限定在“文档解析领域”。

### 风险 2：来源质量不齐
**对策**：优先一手论文、核心博客、代表性仓库。

### 风险 3：Wiki 过碎
**对策**：先做最小高信号概念集，不追求百科全书。

### 风险 4：报告像拼贴
**对策**：强制结构化章节和证据绑定。

### 风险 5：演示缺少冲击力
**对策**：用“直接报告 vs Wiki 先行报告”做强对比。

---

## 13. 推荐落地顺序

### 第一步：POC
- 文档解析领域
- 20–30 篇高信号来源
- Wiki 先行研报
- 直接研报对照

### 第二步：MVP
- 封装为可复用研究工作流
- 支持更多来源
- 支持稳定输出和质量评估

### 第三步：Demo
- 轻量 CLI 或 Web 展示
- 强对比展示
- 面向社区传播

---

## 14. 一句话总结

DeepResearch 2.0 的核心不是“更会写报告”，而是：

> **先把知识组织成专家体系，再让模型在这个体系上生成高质量研报。**

这正是 MinerU 文档探索器最适合承担的基础设施角色。

---

## 附录 A：v2 新增能力总览

### A.1 `judge_claim` MCP tool

**签名（write-back 语义）：**

```
judge_claim(source_text, claim, verdict, reasoning, confidence)
```

- `verdict` 取值：`verified` / `under_supported` / `contradicted` / `gaming` / `unclear`
- 调用结果落盘到 `wiki_log`，可通过 `wiki_log` 查询历史裁决
- 去重策略：同一 `claim` 按 `MAX(timestamp)` 取最新 verdict（旧裁决保留但不计入汇总）

### A.2 `credibility_score(method="judge")` 融合公式

```
final_score = 0.5 × heuristic_score + 0.5 × verdict_score
```

`verdict_score` 映射表（VERDICT_TO_SCORE）：

| verdict | verdict_score |
|---|---:|
| `verified` | 0.95 |
| `under_supported` | 0.40 |
| `contradicted` | 0.10 |
| `gaming` | 0.05 |
| `unclear` | 0.50 |

输出结构包含 `components.judge`（`verdict`、`confidence`、`verdict_score`）子对象，
与 `components.domain`、`components.recency`、`components.corroboration` 并列。

### A.3 Dashboard CLI（双模式）

| 模式 | 命令 | 说明 |
|---|---|---|
| append | 自动（`build-wiki` 结束时触发） | 追加一行 JSONL 到 `metrics-history.jsonl` |
| render | `bash deepresearch/run.sh dashboard [--topic T] [--last N]` | 读取 JSONL，输出 Markdown 趋势表 |

### A.4 两条注意事项

1. **Self-assessment limitation（自评下界）**：`judge_verified_ratio` 反映的是
   Agent 在裁决时刻的**自评**，裁判与被评对象同为 LLM，存在系统性乐观偏差。
   应视作可信度的**下界**，不能替代独立验证或人工审核。

2. **Freshness-gaming safeguard（新鲜度 gaming 防护）**：`freshness` 基于来源
   中位数发布日期的指数衰减，是时效信号而非质量目标。不应为了拉高 `freshness`
   分值而舍弃奠基性工作（seminal papers）。该指标只进 dashboard，不影响
   `overall_pass` 判定。
