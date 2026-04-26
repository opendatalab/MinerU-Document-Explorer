# DeepResearch 2.0 — Phase 2：直接生成对照（Direct Baseline）

> **目标**：模拟"没有 Wiki 工序"的传统 RAG 直接出报告流程，作为对照组。
> **关键约束**：本阶段**不准**写入 / 修改 `wiki` collection。只能用 `query`、`get`、`multi_get`、`doc_read`、`doc_grep`，然后**一次性产出研报**。

---

## 为什么要这条对照路径？

DeepResearch 2.0 的核心论点是 "**先 Wiki 再研报 > 直接生成**"。
要让用户/评审能看见这个差距，就必须有一份**严格按照普通 RAG 流程**生成的研报，作为参照。
你在本阶段的任务**不是把它写得很好**——是把它**真实地按照"直接检索→拼装"的方式产出**。

---

## 严格规则（违反则失去对照价值）

1. ❌ 不允许调用 `wiki_*` 任何工具。
2. ❌ 不允许 `doc_write` 到 `wiki` collection。
3. ❌ 不允许阅读 Phase 1 产出的 `reports/wiki-first.md` 或任何 `wiki/concepts/*`、`wiki/papers/*`。
4. ✅ 允许：`status` / `query` / `get` / `multi_get` / `doc_toc` / `doc_read` / `doc_grep` / `doc_query` / `doc_elements`。
5. ✅ 必须在每个 query 之后**直接拼装**到研报草稿，不做横向综合的中间页。
6. ✅ 必须保留所有 query 命中片段的原始引用（用 `(source: <path>, page:N)` 行内标注）。

---

## 工作流（约 30–40 分钟）

### Step 1 — 把研究问题转成 8–10 条 query
直接照抄 `topics/document-parsing.yml > research_questions`，每个问题转 1–2 个查询，例如：
- `query("文档解析 子任务 OCR 版面 表格")`
- `query("end-to-end document parsing vs pipeline tradeoff")`
- `query("LayoutLM DocFormer Donut Pix2Struct comparison")`
- `query("DocLayNet DocBank PubLayNet benchmark")`
- `query("MinerU Marker Unstructured open source PDF")`
- `query("RAG 文档解析 召回 影响")`
- `query("中文 OCR 扫描件 复杂版面")`
- `query("文档大模型 多模态")`

> 不要再扩展子查询、不要 HyDE、不要交叉对比——这是基线，不是产品。

### Step 2 — 每个 query 取 top-3，把命中内容拼到对应章节
- 用 `doc_read` 拿到具体页 / 行的原文（不超过每段 200 词）。
- 直接把片段复制到对应章节，每段尾巴用 `(source: <relative-path>, addr:<page:N|line:N>)` 标注。
- **不要做语义综合**，不要写"这表明……"这类总结句——这是对照的本质。

### Step 3 — 直接产出 `direct.md`
路径：把文件**直接写到** `deepresearch/output/reports/direct.md`。

> 因为本阶段不能用 `doc_write` 进 wiki，所以由你（agent）通过本机文件系统直接写到 `deepresearch/output/reports/direct.md`。如果你只能通过 MCP 写入索引内文件，可以临时建一个 `direct` collection 路径根 `deepresearch/output/reports/`，写到 `direct.md`。

#### 推荐结构（**故意**不如 Wiki 版结构化）

```markdown
# 文档解析领域调研（直接生成版）

> 本报告由检索 → 片段拼装直接生成，未经 Wiki 知识体系编译。

## 1. OCR
<拼接片段>
(source: papers/2308.13418.pdf, page:3)
<拼接片段>
(source: blogs/<slug>.md, line:40-90)

## 2. 版面分析
...

## 3. 表格 / 公式 / 阅读顺序
...

## 4. 多模态文档大模型
...

## 5. 数据集与评测
...

## 6. 工程与开源现状
...

## 7. 在 RAG 链路里的影响
...

## 引用
- (source: papers/...) × N
- (source: blogs/...) × M
- (source: repos/...) × K
```

### Step 4 — 自检（同样**不要**做横向综合）
- [ ] 每个章节的字数大致均衡（避免某章节出奇地长——那意味着你在做综合）。
- [ ] 每段都有 `(source: ...)` 行内标注。
- [ ] 文中**没有** `[[wikilinks]]`（如果有，说明你越界用 wiki 了）。
- [ ] 没有"综上所述/我们认为/可以预见"这类综合句。

---

## 输出位置

- 文件：`deepresearch/output/reports/direct.md`
- 元信息：在文件 frontmatter 里写 `mode: direct`、`generated_at: <now>`。

完成后转 `03-COMPARE-zh.md` 做对比。
