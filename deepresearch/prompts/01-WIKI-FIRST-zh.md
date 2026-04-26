# DeepResearch 2.0 — Phase 1：Wiki 先行（Agentic 交错模式）

> **目标**：以"搜索 ↔ 摄取 ↔ Wiki 写入 ↔ lint"的交错循环，把本地索引与实时 Web 搜索结果共同编译成一份**专家级 Wiki**，再基于 Wiki 写出高质量的 **Wiki 研报**。
> Wiki 是 Agent 持续维护的活知识库，不是一次性写完的静态文档；Web 搜索和 Wiki 写入必须交错执行，不是前置批处理。

---

## 当前轮次状态（由外部脚本注入）

| 变量 | 含义 |
|---|---|
| `{round_number}` | 当前轮次编号（从 1 开始） |
| `{search_remaining}` | 剩余可用 `web_search` 次数 |
| `{writes_remaining}` | 剩余可用 `doc_write` 次数 |
| `{minutes_remaining}` | 剩余挂钟时间（分钟） |
| `{coverage_snapshot}` | 上一轮 auto_check 输出的覆盖率快照（JSON） |

**每次 CC 会话都是独立启动的**，不继承前一轮的对话记忆。所有状态通过以上模板变量传入。你在本轮开始时必须先读取这些变量，再决定本轮做什么。

---

## 预算意识（硬性要求）

- 当 `{search_remaining}`、`{writes_remaining}`、`{minutes_remaining}` 中**任何一项低于其初始限额的 20%** 时，立即切换到**收敛模式**：
  - 停止探索新来源，转为填补覆盖缺口
  - 优先完善现有页面（增加引用、修复断链、补充证据）
  - 跑 `wiki_lint`，消除孤立页和断链
  - 运行 `wiki_index` 生成索引页
- 收敛模式下不发起新的 `web_search`，除非某个 `research_question` 完全没有对应 Wiki 页。

---

## 工作环境

- MCP 索引名：`deepresearch`
- Collections：
  - `papers` — 论文 PDF（只读种子源）
  - `blogs`  — 博客 / 长文 markdown（只读种子源）
  - `repos`  — 开源仓库 README（只读种子源）
  - `web`    — Web 搜索抓取内容（`deepresearch/sources/web/`，Agent 写入）
  - `wiki`   — **你要写入的 Wiki collection**（路径根：`deepresearch/output/wiki/`）
- 主题：**文档解析领域调研**（详见 `deepresearch/topics/document-parsing.yml` 中的 `research_questions`）

---

## 可用 MCP 工具

### 新增 Web 工具（本阶段核心）

| 工具 | 签名 | 用途 |
|---|---|---|
| `web_search` | `web_search(query, results?, top_k?, provider?)` | 归一化并存储搜索结果。**使用方式**：先调用 CC 原生 `WebSearch` 获取结果，再把结构化 results 传入此工具。若不传 `results`，工具会返回 `isError: true` 并提示你先调用 `WebSearch`。 |
| `web_fetch` | `web_fetch(url, timeout_sec?, max_bytes?)` | 抓取单个 URL，返回 `{markdown, title, meta, extracted_links}`。`word_count < 100` 时跳过（页面被阻止或为空）。 |
| `credibility_score` | `credibility_score(url, snippet?, source_type?, published_date?, known_snippets?, method?, judge_verdict?, judge_confidence?)` | 对一个来源打可信度分（0–1）。`method="judge"` 时把本轮 `judge_claim` 得到的 `judge_verdict`/`judge_confidence` 传入，即可得到 heuristic+judge 的融合分。分数规则见下方"可信度门控"。 |
| `judge_claim` | `judge_claim(source_text, claim, verdict, reasoning, confidence, source_type?)` | 对单条**非平凡**事实声明做 verdict 落盘。`verdict` ∈ `{verified, under_supported, contradicted, gaming, unclear}`，`confidence` ∈ [0, 1]。结果写入 wiki_log，供 dashboard 统计与 auto_check 引用。 |

### 现有 Wiki / 文档工具

| 工具 | 用途 |
|---|---|
| `query` | 全局检索（BM25 + 向量 + reranking） |
| `get` / `multi_get` | 取回完整文档 |
| `doc_toc` / `doc_read` / `doc_grep` / `doc_query` | 单文档精读 |
| `doc_elements` | 抽取表格、图、公式 |
| `wiki_ingest` | 喂入已索引的源文档，获取内容分析 + 已有相关页 + 建议写入路径 |
| `doc_write` | 写入 Wiki 页（必带 `source` 字段追踪来源） |
| `doc_links` | 查看一个 Wiki 页的正 / 反向链接 |
| `wiki_lint` | 健康检查：孤立页、断链、过时页 |
| `wiki_log` | 查看 Wiki 活动时间线 |
| `wiki_index` | 生成 / 更新索引页 |

---

## 可信度门控规则

调用 `credibility_score` 后，按以下规则决定如何使用该来源：

| 分数区间 | 处理方式 |
|---|---|
| `score ≥ 0.8` | 高可信；可直接作为 Wiki 主要证据，最低程度需要二次核实 |
| `0.5 ≤ score < 0.8` | 可用；优先寻求多源印证，再写入 Wiki |
| `0.3 ≤ score < 0.5` | 仅在无更好来源时使用；在 Wiki 页中以 `> ⚠️ 低可信度来源，仅供参考` 标注 |
| `score < 0.3` | 跳过，不摄取，不引用 |

---

## 核心交错循环（每轮重复）

```
每轮开始：
  1. 读取 {coverage_snapshot}，结合 wiki_lint 输出，找出覆盖最弱的
     research_question 或 Wiki 章节。

  2. 判断本地索引是否足够覆盖该弱点：
     a. 调用 query 检索本地内容（papers / blogs / repos / web）
     b. 若命中数 ≥ 3 且证据充分 → 直接 wiki_ingest + doc_write，跳到步骤 6

  3. 若本地内容不足，发起 Web 搜索：
     a. 调用 CC 原生 WebSearch（聚焦查询，不要泛化）
     b. 把结构化结果传给 web_search 工具（归一化 + 去重 + 存储）

  4. 对每个候选 URL 打分：
     a. 调用 credibility_score(url, snippet, source_type, published_date)
     b. score < 0.3：跳过
     c. score ≥ 0.3：调用 web_fetch 抓取内容
     d. word_count < 100：跳过

  4.5 对 credibility ≥ 0.5 的候选源，先用 `web_fetch` 拿到其摘要/片段，针对其中每条**非平凡**事实声明
     （numerical claim / comparison claim / benchmark result / method attribution 等）：
     a. Agent 自己在本轮推理中判断 verdict ∈ {verified, under_supported, contradicted, gaming, unclear}，
        以及 reasoning + confidence
     b. 调用 `judge_claim(source_text, claim, verdict, reasoning, confidence)` 落盘
     c. 不要对"常识性"/"背景介绍"/"作者自述"做 judge（会刷掉比率）
     d. 如果某源 ≥2 条 claim 被 judge 为 contradicted 或 gaming，
        考虑将其 credibility 重评为 <0.3 并不纳入 wiki
     e. 重评时调用 `credibility_score(url, ..., method="judge", judge_verdict=<最严重verdict>,
        judge_confidence=<对应confidence>)`，即可得到 heuristic+judge 的融合分

  5. 摄取并写入 Wiki：
     a. web_fetch 返回后，用 web_search(store_to="sources/web/...") 或直接
        通过 doc_write 把内容落盘到 web collection
     b. wiki_ingest 分析已索引内容，获取相关 Wiki 页建议
     c. doc_write 写 Wiki 页（使用下方"强制结构"），引用来源；
        低可信度来源需在页面内标注

  6. 维护链接图：
     - 更新相关已有 Wiki 页，加入对新页的 wikilink
     - 若新内容与已有 Wiki 页结论矛盾，修订旧页并注明来源差异

  7. 每轮结束时运行 wiki_lint：
     - 修复所有 broken_links
     - 消除 orphan_pages（为孤立页找到引用它的页面，或归并到相关概念页）

  8. 检查停止条件（见下方），若满足则退出循环。
```

---

## 停止条件（自行宣告完成）

在以下任一条件满足时，主动退出循环并进入"写研报"阶段：

1. **覆盖达标**：`topics/*.yml` 中每个 `research_question` 都有 ≥1 个 Wiki 页，且每页有 ≥2 条引用（citation）。
2. **lint 清洁**：`wiki_lint` 返回 0 个 broken_links 且孤立页比例 < 15%。
3. **预算耗尽**：`{search_remaining}`、`{writes_remaining}`、`{minutes_remaining}` 任一降至 0。

---

## Wiki 页强制结构

每个 Wiki 页（无论是论文页、概念页还是仓库页）都必须使用以下模板：

```markdown
---
title: <显式标题>
source: <原始路径或 URL>
credibility: <score 值，若来自 web_fetch>
trust_level: high|normal|low
type: paper|blog|repo|concept|web
---

# <标题>

## 摘要 / 核心主张
- 一句话核心贡献
- 适用场景 / 不适用场景

## 关键证据（必须附原句或表格 / 图）
- evidence-1: <原文片段>（来自 [[papers/<file>#section]] 或 (source: URL)）
- evidence-2: ...

## 方法 / 实现要点
- ...

## 数据集 / 评测
- 在 [[concepts/datasets-doc-parsing]] 上达到 X
- 与 [[papers/<other>]] 对比 ...

## 局限 & 反例
- ...

## 关联
- 上位概念 [[concepts/<name>]]
- 同类工作 [[papers/<...>]] 或 (source: URL)
- 实现 [[repos/<...>]]
```

> **铁律**：所有"结论 / 数字 / 评测"必须有 `evidence-N` 引用。没有证据的句子不写。
> 每个事实性主张都应引用来源；优先使用 `credibility_score ≥ 0.5` 的来源。
> 若使用低可信度来源（`0.3–0.5`），在该 evidence 下方加一行 `> ⚠️ 低可信度来源，仅供参考`。
> 若新来源与已有 Wiki 页结论矛盾，修订已有页并注明：`> ℹ️ 与 [[<page>]] 存在分歧，见各自 evidence 部分`。

---

## 阶段路线图（本轮若为第 1 轮）

若 `{round_number} == 1` 且 Wiki 为空，先建路线图：

1. `status()` 验证 collections 是否就绪。
2. 对每个 `research_question` 跑一次 `query`，记录 top-5 命中。
3. 检查 `{coverage_snapshot}`（若为空则视为零覆盖）。
4. 在 `wiki` 中写 `roadmap.md`：列出**待建立的概念页清单**（推荐 8–15 个核心概念 + 每篇高信任论文一个论文页 + 每个高 stars 仓库一个仓库页）。
   ```
   doc_write({collection:"wiki", path:"roadmap.md", title:"DeepResearch 路线图", content:"...", source:""})
   ```
5. 进入核心交错循环。

若为后续轮次，跳过路线图，直接读取 `{coverage_snapshot}` 确定优先级后进入交错循环。

---

## 概念页目标（横向综合，贯穿多轮）

按 `topics/document-parsing.yml` 中 `research_questions` 反推，至少创建以下概念页（路径：`concepts/*.md`）：

- `ocr-pipeline.md`、`layout-analysis.md`、`table-recognition.md`、`reading-order.md`
- `multimodal-doc-llm.md`（DocOwl / Donut / Pix2Struct 综合）
- `datasets-doc-parsing.md`（DocLayNet / DocBank / FUNSD / PubLayNet ...）
- `end-to-end-vs-pipeline.md`
- `engineering-tradeoffs.md`（吞吐 / 成本 / 中文 / 扫描件）
- `rag-impact.md`（文档解析对 RAG 召回 / 生成的影响）

每个概念页必须：跨引用 ≥3 个来源（论文 / 博客 / 仓库 / web）；明确区分"支持证据"与"争议 / 反例"。

---

## 写 Wiki 研报（最终阶段）

停止条件满足后，写研报：`doc_write({collection:"wiki", path:"reports/wiki-first.md", ...})`

#### 研报必备结构

```markdown
# 文档解析领域调研（Wiki 先行版）

## 0. 摘要（200 字内）

## 1. 范围 & 方法
- 资料来源：N 篇论文 + M 篇博客 + K 个仓库 + W 个 Web 来源
- Wiki 体系：X 个概念页，Y 个论文页（链接图见 [[index]]）
- 调研问题清单（来自 topic.yml）

## 2. 任务地图（按子任务划分）
### 2.1 OCR
### 2.2 版面分析
### 2.3 表格 / 公式 / 阅读顺序
### 2.4 多模态文档大模型
（每节都用 [[papers/...]] / [[concepts/...]] 锚定）

## 3. 主流方案族对比
- 表格：方案 × {开源? 中文? 扫描件? 吞吐 / 成本 / 评测}
- 每行尾注引用对应 Wiki 页

## 4. 评测体系
- 主流数据集与指标（来自 [[concepts/datasets-doc-parsing]]）
- 当前 SOTA 与争议

## 5. 工程落地
- 吞吐 / 显存 / 部署形态（[[concepts/engineering-tradeoffs]]）
- 在 RAG 链路里的实证影响（[[concepts/rag-impact]]）

## 6. 结论 & 不确定项
- 我们能下的 5 个结论（每条必须有 ≥2 个独立来源支持）
- 我们不敢下的 3 个结论（写明缺什么证据）

## 附录 A 引用清单（自动从 wikilinks 反查）
```

#### 写完之后必做的 3 步

1. `wiki_lint()`：修掉所有 `broken_links` 与 `orphan_pages`。
2. `wiki_index({collection:"wiki", write:true})`：生成 `index.md`。
3. `wiki_log()`：肉眼扫一遍，确认每个页都至少有 1 次写入 + provenance。

---

## ⚠️ Freshness 不是目标，是 dashboard 信号

**Freshness is a dashboard signal, not an optimization target.**
在写 Wiki 时：
- **一定保留** seminal / highly-cited 的早期论文（e.g., LayoutLMv1, DocBank, DocLayNet, DeepDoc）
- **不要**为了拉高 median_date 而弃掉里程碑工作
- Freshness 指标告诉我们"有没有追踪到最新进展"，不告诉我们"用新的就是好的"
- 如果某经典工作（> 3 年）仍是当前领域的事实标杆，它必须在 Wiki 中，与新工作并列评述

相当于：Wiki 要像一本教科书——**既有经典奠基，也有最新前沿**。只追新会让 Wiki 变成新闻简报。

---

## 质量自检清单（提交前）

- [ ] 至少 10 个 `concepts/*.md`，每个都有 ≥3 条 evidence（含来源 URL 或 wikilink）。
- [ ] 至少 8 个 `papers/*.md`（来自高信任种子或 credibility_score ≥ 0.5 的 web 来源）。
- [ ] 至少 5 个 `repos/*.md`。
- [ ] 每个事实性主张都引用来源；`credibility_score ≥ 0.5` 的来源优先。
- [ ] 低可信度来源（0.3–0.5）在页面内已标注 ⚠️。
- [ ] `wiki_lint` 输出 0 broken_links，孤立页比例 < 15%。
- [ ] 研报 `reports/wiki-first.md` 中每段尾巴都有 `[[...]]` 引用。
- [ ] 研报有"我们不敢下的结论"小节（防 hallucination）。
- [ ] 每轮至少运行一次 `wiki_lint`，不把断链遗留到下一轮。
- [ ] 对 `judge_claim` 返回 `under_supported` / `contradicted` / `unclear` 的 claim，在 Wiki 页里**显式标注**限制，格式：
  > [judge: under_supported, confidence: 0.4] 虽然 X 声称 Y，但 Y 缺乏独立来源支持，此处记录为待验证。
  这样读者（和未来评测）能区分"已验证"和"待定"论断。

完成上述清单后，进入 `02-DIRECT-zh.md`。
