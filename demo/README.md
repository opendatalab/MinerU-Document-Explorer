# MinerU Document Explorer Demo: Agent-Driven RAG 研究综述

本 Demo 展示 MinerU Document Explorer 作为 **Agent 基础设施** 的核心定位：
数据摄取、Wiki 构建、深度阅读、综述撰写全部由 LLM Agent 通过 MCP 工具驱
动——脚本只做最少的「非智能」工作（抓取 arXiv + 建索引）。

## 架构：脚本 vs Agent 的分工

```
┌────────────────────────────────────────────────────────────────┐
│  setup.sh (脚本, 无 LLM)                                       │
│  ① arXiv API → 下载 PDF                                       │
│  ② qmd collection add → 建立全文索引                            │
│  ③ qmd embed (可选) → 向量嵌入                                  │
└──────────────────────────┬─────────────────────────────────────┘
                           │ MCP 连接
                           ▼
┌────────────────────────────────────────────────────────────────┐
│  LLM Agent (由 AGENT-PROMPT.md 引导)                            │
│                                                                │
│  Phase 1: 侦察                                                 │
│    status → query("RAG") → doc_toc(top papers)                 │
│                                                                │
│  Phase 2: Wiki 构建 (循环)                                      │
│    wiki_ingest → doc_read(关键章节) → doc_write(Wiki 页面)       │
│    ↻ 对每篇论文重复，边读边建立 [[wikilinks]] 知识图谱             │
│                                                                │
│  Phase 3: 综述撰写                                              │
│    query(各研究维度) → doc_read(精读) → doc_write(survey.md)      │
│                                                                │
│  Phase 4: 质量检查                                              │
│    wiki_lint → wiki_index → 修复断链/孤页                        │
└────────────────────────────────────────────────────────────────┘
```

**关键区别**：没有 `build_wiki.py` 或 `generate_survey.py`。Wiki 页面的
内容、结构、分类、交叉引用，全部由 Agent 在理解论文内容后自主决定。

## 快速开始

### 前置条件

```bash
pip install feedparser pymupdf
pip install mineru-open-sdk  # 可选：MinerU 高质量解析
bun install
```

### Step 1: 运行 setup（唯一的脚本步骤）

```bash
# 使用 MinerU cloud 高质量解析（推荐）
MINERU_API_KEY=your_key bash demo/setup.sh

# 或在 ~/.config/qmd/doc-reading.json 中配置 MinerU
bash demo/setup.sh

# PyMuPDF 本地解析（快速，不需要 API Key）
bash demo/setup.sh --max 20 --skip-embed

# 仅元数据不下载 PDF（最快）
bash demo/setup.sh --max 20 --skip-download --skip-embed
```

> **MinerU vs PyMuPDF**: MinerU 使用 VLM 模型进行 OCR 和版面分析，能正确
> 提取表格、公式、图表等复杂元素为结构化 Markdown。PyMuPDF 是纯文本提取，
> 速度快但对扫描件和复杂版面支持较弱。

### Step 2: 启动 MCP 服务器

```bash
# HTTP 模式（推荐，共享服务器，模型常驻内存）
bun src/cli/qmd.ts --index demo mcp --http

# 或 stdio 模式（适合直接嵌入 MCP 客户端配置）
bun src/cli/qmd.ts --index demo mcp
```

### Step 3: 让 Agent 工作

将 `demo/AGENT-PROMPT.md` 的内容作为 system prompt 或首条指令发送给你的
LLM Agent（需要配置 MCP 连接到上一步的服务器）。

Agent 会自主完成：
- 用 `wiki_ingest` 分析每篇论文
- 用 `doc_toc` + `doc_read` 精读关键章节
- 用 `doc_write` 写 Wiki 页面并建立 `[[wikilinks]]` 知识图谱
- 用 `query` 做跨论文检索
- 用 `doc_write` 撰写最终的 `survey.md`
- 用 `wiki_lint` + `wiki_index` 做质量检查

## Agent 使用的 MCP 工具

### 检索

| 工具 | 用途 |
|------|------|
| `query` | 跨文档混合搜索（BM25 + 向量 + 重排序） |
| `get` / `multi_get` | 获取完整文档内容 |

### 深度阅读

| 工具 | 用途 |
|------|------|
| `doc_toc` | 获取文档目录结构 |
| `doc_read` | 按地址精读特定章节 |
| `doc_grep` | 文档内正则搜索 |
| `doc_query` | 文档内语义搜索 |
| `doc_elements` | 提取表格、图表、公式 |

### Wiki 写入

| 工具 | 用途 |
|------|------|
| `doc_write` | 写入 Wiki 页面（自动索引 + 日志） |
| `wiki_ingest` | 分析源文档，准备 Wiki 摄取 |
| `wiki_lint` | 健康检查（孤页、断链、过期页） |
| `wiki_index` | 生成 Wiki 索引页 |

## 为什么这样设计？

传统做法会写一个 `build_wiki.py`，用模板和启发式规则把论文"变换"成 Wiki
页面。但这忽略了 RAG 系统的核心价值：

1. **理解 > 变换**：Agent 读懂论文后决定 Wiki 结构，而不是按固定模板填充
2. **增量知识**：每写一个 Wiki 页面都会被索引，后续检索自动受益
3. **交叉引用**：Agent 发现论文间的联系后用 `[[wikilinks]]` 连接，形成知识图谱
4. **可追溯**：`doc_write(source=...)` 记录 Wiki 页面的来源，`wiki_lint` 检测过期
5. **可复现**：同样的 prompt + 同样的索引 = 确定性的 Agent 行为

这正是 [LLM Wiki Pattern](https://karpathy.ai/) 的实践：索引和搜索是基础设施，
知识合成是 Agent 的工作。

## 清理

```bash
# 删除索引数据库
rm -f ~/.cache/qmd/demo.sqlite

# 删除下载的论文 PDF
rm -rf demo/papers

# 如果需要完全重置 wiki（会删除已提交的示例 wiki 页面）
# rm -rf demo/wiki
```

> **注意**: `demo/wiki/` 包含预置的示例 Wiki 页面（概念和论文摘要），可作为
> Agent 构建 Wiki 的参考起点。删除前请确认你不需要这些内容。
