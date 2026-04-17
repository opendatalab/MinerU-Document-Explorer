## Demo 练习题与验收清单（中文）

配合 `demo/WORKSHOP-zh.md` 使用。这份材料面向“上手体验”，每题都给出 **目标 → 操作 → 验收**。

---

### 0）验收清单（跑完 Demo 你应当满足）

- **索引已建好**
  - `demo/papers/` 下有若干 `*.pdf` 与 `metadata.json`
  - `bun src/cli/qmd.ts --index demo status` 能看到 `sources` 与 `wiki`

- **MCP 已连通**
  - `curl http://localhost:8181/health` 返回 OK（HTTP 模式）
  - Agent 能成功调用一次 `status()`

- **Wiki 有产物**
  - `demo/wiki/` 下有 `papers/` 与/或 `concepts/` 下的 `.md` 文件
  - `wiki_index(write=true)` 生成了 `demo/wiki/index.md`
  - `wiki_lint` 没有未修复的 broken links（或你能解释为什么保留）

---

### 1）热身：BM25 关键词检索（无模型）

- **目标**：体验“零配置也能用”的搜索，先建立信心。
- **操作**：

```bash
bun src/cli/qmd.ts --index demo search "multi-hop"
bun src/cli/qmd.ts --index demo search "benchmark"
```

- **验收**：
  - 能返回至少 1 条结果（包含 docid、文件路径、snippet）

---

### 2）对比：混合检索 `query`（质量更好）

- **目标**：体验“检索质量提升来自哪”。
- **操作**：

```bash
# 通过 -C 降低重排候选，课堂更快
bun src/cli/qmd.ts --index demo query -C 20 "multi-hop RAG evaluation"
```

- **验收**：
  - 相比 `search`，结果更倾向于“回答问题所需的段落”，而不是仅包含关键词

---

### 3）精读：先看目录，再按页读取

- **目标**：体验“不是把 PDF 全文倒出来”，而是像人一样先翻目录定位。
- **操作**（选一篇你在检索结果里看到的论文 PDF）：

```bash
bun src/cli/qmd.ts --index demo doc-toc "sources/<paper>.pdf"
bun src/cli/qmd.ts --index demo doc-read "sources/<paper>.pdf" "page:1-2"
```

- **验收**：
  - 你能在 2–3 分钟内说清楚这篇论文的章节结构（方法在哪、实验在哪）

---

### 4）让 Agent 写一篇“论文摘要页”

- **目标**：体验“Agent 读完会把知识写回去”，而不是一次性回答。
- **操作**：在 Agent 对话里发指令（或使用 `demo/AGENT-PROMPT-zh.md` 全流程）。
  - 指令示例：
    - “请选一篇最相关的论文，精读 Abstract/Method/Experiments，并写入 `wiki/papers/<paper>.md`，必须带 `source`，并在 Connections 里加 3 个 `[[wikilinks]]`。”

- **验收**：
  - `demo/wiki/papers/` 下新增了一个 `.md` 文件
  - 该页面包含：贡献/方法/实验/连接（wikilinks）

---

### 5）让 Agent 写一个“概念页”（跨论文综合）

- **目标**：体验“从碎片 → 结构化知识编译（LLM Wiki）”。
- **操作**（Agent 指令示例）：
  - “请写 `wiki/concepts/evaluation-benchmarks.md`：总结这些论文常用的 benchmark、指标、对比设置；每条结论尽量链接到具体论文页 `[[papers/...]]`。”

- **验收**：
  - 概念页不是“某一篇论文的摘要复述”，而是跨论文综合
  - 至少有 5 个 `[[wikilinks]]`

---

### 6）链接图：看看知识图谱长什么样

- **目标**：体验 `[[wikilinks]]` 的价值：可导航、可 lint、可视化。
- **操作**（在 Agent 中调用）：

```json
doc_links({ "file": "wiki/concepts/evaluation-benchmarks.md", "direction": "both", "link_type": "wikilink" })
```

- **验收**：
  - 你能看到该页的 outgoing links 与 backlinks（如果已存在）

---

### 7）质量检查：wiki_lint → 修复 → 再生成 index

- **目标**：体验“知识库不是一次性生成”，而是可维护系统。
- **操作**（Agent 中调用）：

```json
wiki_lint({ "collection": "wiki" })
wiki_index({ "collection": "wiki", "write": true })
```

- **验收**：
  - broken links 被修复（改名或创建缺失页）
  - `demo/wiki/index.md` 存在且能列出主要页面

---

### 8）挑战题（可选）

任选 1–2 题让 Agent 完成，并要求“给出证据位置（页码/段落）”：

- **挑战 A**：这几篇论文里，检索器的训练/更新策略有哪些差异？分别解决了什么问题？
- **挑战 B**：这些论文用了哪些评测数据集？指标是什么？谁的 baseline 最强？
- **挑战 C**：找出一篇论文中最关键的消融实验（ablation），解释结论是否可信。
- **挑战 D**：写 `wiki/survey.md` 的短版（<= 120 行），并在 References 里链接到论文页。

