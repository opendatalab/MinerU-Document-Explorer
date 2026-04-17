## RAG 研究综述 Demo — Agent Prompt（中文）

你可以访问一个 MinerU Document Explorer 索引（index 名为 `demo`），其中包含大约 3–10 篇 2026+ 的 arXiv RAG 论文 PDF（collection: `sources`），以及一个可写入的 Wiki 知识库（collection: `wiki`）。

你的任务是：**阅读这些论文 → 构建结构化 Wiki → 写一篇综述文档**。如果 `wiki` 里已经有页面，请先快速检查并在其基础上增量完善（补链接、补概念页、修断链）。

---

### 重要约束（必须遵守）

- **只使用 collection 相对路径**（例如 `sources/2601.00123.pdf`、`wiki/concepts/rag-fundamentals.md`），不要使用本地绝对路径（如 `/Users/...` 或 `demo/papers/...`）。
- **读大文档先导航再精读**：PDF/DOCX/PPTX 或长 Markdown，一律 `doc_toc → doc_read`，不要用 `get` 把全文倒出来。
- **`doc_read` 只接受“地址”**：地址来自 `doc_toc` / `doc_grep` / `doc_query` 的返回结果。
- **写 Wiki 页务必带 `source`**：用 `doc_write(..., source: "sources/xxx.pdf")` 记录来源，便于追溯与 `wiki_lint` 的过期检测。

---

### 可用 MCP 工具（15 个）

#### 🔍 检索（跨文档）
- `status`：查看索引健康与 collection
- `query`：混合检索（推荐）
- `get`：取单个文档（仅用于短文档）
- `multi_get`：批量取多个文档（谨慎使用，避免大文件）

#### 📖 精读（单文档内导航）
- `doc_toc`：目录/结构
- `doc_read`：按地址读取
- `doc_grep`：关键词/正则定位
- `doc_query`：文档内语义定位（需要 embedding）
- `doc_elements`：结构化元素抽取（能力与格式/配置有关）
- `doc_links`：链接图（用于 wiki 页面）

#### 📝 摄取（写回知识库）
- `wiki_ingest`：为“写 Wiki”做准备（返回 TOC/相关页/建议）
- `doc_write`：写入/覆盖 wiki 页面（写完立即可检索）
- `wiki_lint`：健康检查（断链、孤页、过期）
- `wiki_index`：生成索引页
- `wiki_log`：活动时间线

---

### 课堂模式（建议的最小交付）

如果本次 demo 只索引了 3 篇论文，请先完成以下 MVP（体验闭环优先）：

- 为每篇论文写 1 个摘要页：`wiki/papers/<paper-slug>.md`
- 写至少 2 个概念页：`wiki/concepts/<topic>.md`
- 运行一次 `wiki_lint` 修断链
- 运行 `wiki_index(write=true)` 生成 `wiki/index.md`

完成后再扩展写 `wiki/survey.md`（综述）。

---

### Phase 1：侦察（Recon）

1) 先看索引状态：

```json
status()
```

2) 用 `query` 找到有哪些方向/论文：

推荐用 **高级模式**（你自己提供 `lex` 子查询），可跳过内部 query expansion（更稳、更快）：

```json
query({
  "searches": [
    { "type": "lex", "query": "RAG retrieval augmented generation" }
  ],
  "limit": 10
})
```

3) 任选 1–3 篇代表性论文，先 `doc_toc` 看结构（Abstract/Method/Experiments 等在什么页）：

```json
doc_toc({ "file": "sources/<paper>.pdf" })
```

---

### Phase 2：Wiki 构建（Ingest → Read → Write）

对每篇论文循环执行：

1) `wiki_ingest` 获取建议与相关页：

```json
wiki_ingest({ "source": "sources/<paper>.pdf", "wiki_collection": "wiki" })
```

2) 精读关键部分（建议只读：Abstract、Method、Experiments、Limitations）：

```json
doc_read({ "file": "sources/<paper>.pdf", "addresses": ["page:1-3"] })
```

必要时用 `doc_grep` 定位细节（如 “ablation / benchmark / dataset / hallucination”）：

```json
doc_grep({ "file": "sources/<paper>.pdf", "pattern": "ablation|benchmark|dataset|hallucination" })
```

3) 写论文摘要页（必须带 `source`）：

```json
doc_write({
  "collection": "wiki",
  "path": "papers/<paper-slug>.md",
  "title": "<Paper Title>",
  "source": "sources/<paper>.pdf",
  "content": "# <Paper Title>\n\n## 核心贡献\n- ...\n\n## 方法\n...\n\n## 实验与结论\n...\n\n## 关联\n- 相关概念：[[concepts/rag-fundamentals]]、[[concepts/evaluation-benchmarks]]\n"
})
```

4) 同步补概念页（跨论文综合，不要只复制某一篇论文）：

```json
doc_write({
  "collection": "wiki",
  "path": "concepts/rag-fundamentals.md",
  "title": "RAG Fundamentals",
  "source": "sources/<paper>.pdf",
  "content": "# RAG Fundamentals\n\n## 一句话定义\n...\n\n## 常见设计维度\n- 检索器（sparse/dense/hybrid）\n- 读入方式（chunking / query expansion / rerank）\n- 生成约束（grounding / citation / verifier）\n\n## 代表论文\n- [[papers/<paper-slug>]]\n"
})
```

> 写概念页时尽量多用 `[[wikilinks]]`，让知识库形成可导航的图。

---

### Phase 3：写综述（Survey）

在 `wiki/survey.md` 写一篇面向 2026+ 的 RAG 研究综述（可以先写短版，再迭代变长）。

建议结构：

```markdown
## RAG Research Survey: 2026 Frontiers

### 1. 背景与问题定义
### 2. Retrieval：稀疏/稠密/混合/重排
### 3. 读入与增强：chunking、query expansion、multi-hop
### 4. 可靠性：grounding、citation、hallucination 控制
### 5. 评测：基准、指标、复现性
### 6. 开放问题与趋势
### References（用 wikilinks）
```

写作时用 `query` 做跨论文检索，必要时回到原论文 `doc_read` 精读关键段落，再综合写回。

---

### Phase 4：质量检查（必须做）

1) 跑健康检查，修断链/孤页/过期页提示：

```json
wiki_lint({ "collection": "wiki" })
```

2) 生成索引页（写入 `wiki/index.md`）：

```json
wiki_index({ "collection": "wiki", "write": true })
```

3) 如果 `wiki_lint` 报 broken links：要么修链接名，要么创建缺失页面（用 `doc_write`）。

