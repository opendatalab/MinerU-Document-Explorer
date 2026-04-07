<div align="center">

<h1 align="center">
  <img src="assets/logo.png" alt="logo" height="28" style="vertical-align: middle; margin-right: 8px;">
  MinerU Document Explorer
</h1>

<h4>Agent 原生知识引擎 — 在 Markdown、PDF、DOCX、PPTX 上进行搜索、精读和知识构建。</h4>

<p>
  <a href="https://www.npmjs.com/package/mineru-document-explorer"><img src="https://img.shields.io/npm/v/mineru-document-explorer?style=flat-square&color=cb3837" alt="npm"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="license"/></a>
  <a href="https://github.com/opendatalab/MinerU-Document-Explorer/actions"><img src="https://img.shields.io/github/actions/workflow/status/opendatalab/MinerU-Document-Explorer/ci.yml?style=flat-square&label=CI" alt="CI"/></a>
  <a href="https://github.com/opendatalab/MinerU-Document-Explorer"><img src="https://img.shields.io/github/stars/opendatalab/MinerU-Document-Explorer?style=flat-square" alt="stars"/></a>
</p>

<p>
  <a href="README.md">English</a> ·
  <a href="docs/mcp.md">MCP 配置</a> ·
  <a href="docs/cli.md">CLI 参考</a> ·
  <a href="demo/">Demo 演示</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a>
</p>

</div>

---

## 🤔 为什么选择 MinerU Document Explorer？

MinerU Document Explorer 为你的 Agent 提供三组工具套件 — **检索、精读、摄取** — 构成从索引到输出的完整知识闭环：

![MinerU Document Explorer 概览](assets/overview_ch.png)

- **🔍 检索（Retrieve）** — 跨集合搜索：BM25 关键词、向量、混合搜索，支持 LLM 重排序与查询扩展
- **📖 精读（Deep Read）** — 无需加载整个文件，即可在单个文档内导航：目录结构、章节精读、内联搜索、元素提取
- **📝 摄取（Ingest）** — 从原始文档构建并持续演进的 LLM Wiki 知识库，遵循 [Karpathy LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 模式

由 [MinerU](https://github.com/opendatalab/MinerU) 团队开发，基于 [QMD](https://github.com/tobi/qmd) 和 [Karpathy LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)。

### 💡 能用来做什么？

- **科研助手** — 指向一个论文文件夹，让 AI Agent 自动综述文献、对比方法、或在论文间查找特定实验结果
- **项目知识库** — 索引代码库、文档和设计规格；让 Agent 回答架构问题、查找相关代码、追溯需求
- **学习伴侣** — 导入教材或课堂笔记，用 `doc_toc` + `doc_read` 导航，用 `doc_grep` 搜索，构建关键概念的 Wiki
- **企业文档搜索** — 索引合同、报告或手册，用自然语言查询并通过 LLM 重排序增强搜索效果

> **实际效果演示**：[demo/](demo/) 文件夹包含完整的端到端示例 — AI Agent 自动阅读约 10 篇 arXiv RAG 论文，构建互相链接的 Wiki 知识库，并撰写研究综述。查看 [Demo 使用指南](demo/README-zh.md) 了解详细步骤。

## 🚀 快速开始

> Agent 辅助安装：如果你正在使用 AI Agent（Claude Code、Cursor 等），只需让 Agent 帮你完成 MinerU Document Explorer 的部署和 Skill 安装 — Agent 可以全程自动完成配置，包括 MCP 服务器设置。

```
遵循 https://github.com/opendatalab/MinerU-Document-Explorer/blob/main/docs/quickstart.md 安装 MinerU Document Explorer 并引导用户完成配置。
```

## 📖 文档精读

无需加载整个文件，即可在单个文档内导航和搜索：

```sh
# 查看文档结构
qmd doc-toc papers/attention-is-all-you-need.pdf

# 按地址精读指定部分
qmd doc-read papers/attention-is-all-you-need.pdf "line:45-120"

# 文档内搜索
qmd doc-grep papers/attention-is-all-you-need.pdf "self-attention"
```

## 🔌 MCP 服务器 — 15 个 AI Agent 工具

通过 [Model Context Protocol](https://modelcontextprotocol.io) 集成 AI Agent。

> **MCP 服务器 vs CLI 命令**：MCP 服务器作为**常驻进程**运行 — LLM 模型（嵌入、重排序、查询扩展）只需加载一次，始终驻留内存。而 CLI 命令如 `qmd query` 每次调用都需要重新加载全部模型，带来约 5–15 秒的启动开销。**在 Agent 工作流中，请始终优先使用 MCP 服务器。**

两种传输模式：

| 模式 | 命令 | 适用场景 |
|:-----|:-----|:---------|
| **stdio** | `qmd mcp` | Claude Desktop、Claude Code — 客户端自动启动和管理进程 |
| **HTTP 守护进程** | `qmd mcp --http --daemon` | Cursor、Windsurf、VS Code、多客户端共享 — 一个常驻服务 |

```sh
# 启动 HTTP 守护进程（推荐 — 模型在所有请求间保持加载）
qmd mcp --http --daemon             # 默认端口 8181
qmd mcp --http --daemon --port 8080 # 自定义端口

# 验证服务是否运行
curl http://localhost:8181/health

# 停止守护进程
qmd mcp stop
```

### 客户端配置

<details>
<summary><b>Cursor</b> — 添加到 <code>.cursor/mcp.json</code>（项目级）或 <code>~/.cursor/mcp.json</code>（全局）</summary>

**方式 A — stdio**（Cursor 自动管理进程生命周期）：

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
```

**方式 B — HTTP**（先运行 `qmd mcp --http --daemon`；模型常驻内存，响应更快）：

```json
{
  "mcpServers": {
    "qmd": {
      "url": "http://localhost:8181/mcp"
    }
  }
}
```

</details>

<details>
<summary><b>Claude Desktop</b> — 添加到 <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></summary>

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
```

</details>

<details>
<summary><b>Claude Code</b> — 添加到 <code>~/.claude/settings.json</code> 或运行 <code>claude mcp add qmd -- qmd mcp</code></summary>

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
```

</details>

<details>
<summary><b>Windsurf / VS Code / 其他 MCP 客户端</b></summary>

**stdio** 传输：在客户端 MCP 配置中使用 `"command": "qmd"`、`"args": ["mcp"]`。

**HTTP** 传输：先启动 `qmd mcp --http --daemon`，然后将客户端指向 `http://localhost:8181/mcp`。

</details>

详见 [MCP 配置指南](docs/mcp.md)，了解全部 15 个工具和 HTTP 传输详情。

### Agent Skills

MinerU Document Explorer 内置了 [Agent Skill](skills/mineru-document-explorer/SKILL.md)，可以教会 AI Agent 如何高效使用全部工具 — 决策树、使用模式和最佳实践，涵盖全部 15 个 MCP 工具。

```sh
# 安装 Skill（npm 和源码安装均可使用）
qmd skill install              # 安装到当前项目 (.agents/skills/)
qmd skill install --global     # 安装到全局 (~/.agents/skills/)

# 或从源码仓库直接安装
claude skill add ./skills/mineru-document-explorer/SKILL.md
```

## 📊 横向对比

| | MinerU Doc Explorer | LlamaIndex | Obsidian | NotebookLM |
|:---|:---:|:---:|:---:|:---:|
| **100% 本地运行** | ✅ | ⚠️ 需 LLM API | ✅ | ❌ 云端 |
| **Agent 集成 (MCP)** | **15 个工具** | 插件 | ❌ | ❌ |
| **文档内精读** | ✅ | ❌ | ❌ | ✅ |
| **Wiki 知识编译** | ✅ | ❌ | 手动 | ❌ |
| **支持格式** | MD, PDF, DOCX, PPTX | 多种 | MD | PDF, URL |
| **搜索管线** | BM25 + 向量 + 重排序 | 可配置 | 基础 | 私有 |
| **零配置搜索** | ✅ `qmd search` | ❌ | 插件 | N/A |
| **开源** | MIT | MIT | 部分 | ❌ |

## ⚙️ 系统要求

| 要求 | 说明 |
|------|------|
| **Node.js** >= 22 或 **Bun** | 运行时 |
| **Python** >= 3.10 | 文档处理（`pymupdf`、`python-docx`、`python-pptx`） |
| **macOS** | 需安装 `brew install sqlite` 以支持扩展 |

### 📄 文档处理配置

Python 3.10+ 是必须的依赖，用于文档处理（PDF、DOCX、PPTX）：

```sh
# 检查 Python 版本
python3 --version  # 需要 >= 3.10

# 安装必须的 Python 包
pip install pymupdf python-docx python-pptx

# 验证安装
python3 -c "import pymupdf; import docx; import pptx; print('OK')"
```

<details>
<summary><b>MinerU Cloud</b> — 面向扫描件和复杂版面的高质量 PDF 解析（可选）</summary>

```sh
pip install mineru-open-sdk
export MINERU_API_KEY="your-key"  # 从 https://mineru.net 获取
```

设置 `MINERU_API_KEY` 后，MinerU Cloud 将自动作为 PDF 首选解析引擎，PyMuPDF 作为兜底方案。

如需更高级的配置（自定义 Provider、本地 VLM 模型、GPT PageIndex），可创建 `~/.config/qmd/doc-reading.json`：

```json
{
  "docReading": {
    "providers": {
      "fullText": { "pdf": ["mineru_cloud", "pymupdf"] }
    },
    "credentials": {
      "mineru": { "api_key": "your-api-key" }
    }
  }
}
```

</details>

### 🤖 LLM 模型（首次使用时自动下载）

| 模型 | 用途 | 大小 |
|:-----|:-----|:-----|
| embeddinggemma-300M | 向量嵌入 | ~300 MB |
| qwen3-reranker-0.6b | 重排序 | ~640 MB |
| qmd-query-expansion-1.7B | 查询扩展 | ~1.1 GB |

> 模型仅在 `qmd embed`、`qmd vsearch` 和 `qmd query` 时需要。`qmd search` 使用纯 BM25 检索，无需模型。

## 📚 文档

| | |
|:---|:---|
| 🎯 [Demo 使用指南](demo/README-zh.md) | 端到端示例：Agent 驱动的 RAG 研究综述 |
| 📖 [CLI 参考](docs/cli.md) | 全部命令、选项、输出格式 |
| 🔌 [MCP 服务器](docs/mcp.md) | 配置、15 个工具、HTTP 传输 |
| 📦 [SDK / 开发库](docs/sdk.md) | TypeScript API、类型、示例 |
| 🏗️ [架构设计](docs/architecture.md) | 搜索管线、评分、数据模型、分块策略 |
| 🤝 [参与贡献](CONTRIBUTING.md) | 开发环境、代码规范、贡献指南 |

## ❤️ 致谢

MinerU Document Explorer 构建在以下项目之上：

- **[QMD](https://github.com/tobi/qmd)** — [Tobi Lutke](https://github.com/tobi) 开发的本地搜索引擎和 Markdown 文档 CLI 工具
- **[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** — [Andrej Karpathy](https://github.com/karpathy) 提出的 LLM 维护知识库的概念模式
- **[MinerU](https://github.com/opendatalab/MinerU)** — [OpenDataLab](https://github.com/opendatalab) 开发的高精度文档解析和提取工具

---

## 📝 更新日志

### v1 — 2026-04-07（当前版本）

从 OpenClaw Agent Skill 重构为完整的 Agent 原生知识引擎：npm 包（`npm install -g mineru-document-explorer`）、`qmd` CLI、包含 15 个工具的 MCP 服务器（三组：检索 / 精读 / 摄取）、多格式支持（MD、PDF、DOCX、PPTX）、混合搜索（BM25 + 向量 + LLM 重排序），以及 LLM Wiki 知识库模式。

### v0 — 2026-03-30（上一版本）

OpenClaw 原生 Agent Skill（`doc-search` CLI）。四大能力：逻辑检索、语义检索、关键词检索、证据提取。见[v0版仓库](https://github.com/opendatalab/MinerU-Document-Explorer/tree/v0).
