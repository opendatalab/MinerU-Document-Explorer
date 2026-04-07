# MinerU Document Explorer 开发进展记录

> MinerU Document Explorer 是 [MinerU](https://github.com/opendatalab/MinerU) 团队在 [QMD](https://github.com/tobi/qmd) 基础上开发的 Agent 原生知识引擎，融合了 [Karpathy 的 LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 知识编译思想和 MinerU 的高精度文档理解能力，构成了**索引 → 检索 → 精读**的完整闭环。

## 设计思路

QMD 提供底层索引/搜索引擎和 Wiki 基础设施（存储、搜索、链接分析、日志），
MinerU Document Explorer 提供高精度文档解析（PDF 页面级精读、DOCX 节级导航、PPTX 幻灯片缓存），
LLM agent 通过 MCP 工具完成高层合成工作（摘要、实体页面、交叉引用），
三者构成从粗到细的完整 RAG 链路。

- Collection 分为 `raw`（不可变源文档）和 `wiki`（LLM 维护的知识页面）
- MCP 工具暴露完整 Wiki 生命周期：ingest → write → lint → index
- 所有 wiki 写入自动记录到 `wiki_log` 表
- 文档后端支持 PDF/DOCX/PPTX 的结构化缓存，支持页面级/节级/幻灯片级精读

## 已完成

### Phase 1: 核心数据层

| 项目 | 文件 | 状态 |
|------|------|------|
| Collection type 字段 | `collections.ts`, `config-schema.ts`, `store.ts`, `index.ts` | ✅ |
| DB migration v2 | `db-schema.ts` — `store_collections.type` + `wiki_log` 表 | ✅ |
| wiki_log 日志模块 | `src/wiki/log.ts` — append, query, stats, format | ✅ |
| isWikiCollection / getWikiCollections | `store.ts` | ✅ |
| upsertStoreCollection with type | `store.ts` | ✅ |
| listCollections with type | `store.ts`, `index.ts` | ✅ |

### Phase 2: MCP 工具

| 项目 | 文件 | 状态 |
|------|------|------|
| wiki_ingest | `src/mcp/tools/wiki.ts` — 读源文档 + 搜索相关页面 + 返回建议 | ✅ |
| wiki_lint | `src/mcp/tools/wiki.ts` + `src/wiki/lint.ts` — 链接图健康分析 | ✅ |
| wiki_log | `src/mcp/tools/wiki.ts` — 查询/格式化活动日志 | ✅ |
| wiki_index | `src/mcp/tools/wiki.ts` + `src/wiki/index-gen.ts` — 自动生成索引页 | ✅ |
| doc_write wiki 日志 | `src/mcp/tools/writing.ts` — wiki 集合写入自动记日志 | ✅ |
| MCP instructions 增强 | `src/mcp/server/utils.ts` — 引导 LLM agent 使用 wiki 工具 | ✅ |

### Phase 3: CLI + 文档

| 项目 | 文件 | 状态 |
|------|------|------|
| `qmd wiki init\|lint\|log\|index` | `src/cli/qmd.ts` | ✅ |
| `qmd collection add --type` | `src/cli/qmd.ts` | ✅ |
| CLAUDE.md 更新 | `CLAUDE.md` | ✅ |
| README.md 更新 | `README.md` | ✅ |
| CHANGELOG.md 更新 | `CHANGELOG.md` | ✅ |

### Phase 4: TDD 测试

| 测试文件 | 测试数 | 覆盖范围 | 状态 |
|----------|--------|----------|------|
| `test/wiki-log.test.ts` | 15 | appendLog, queryLog, getLogStats, formatLogAsMarkdown | ✅ |
| `test/wiki-lint.test.ts` | 18 | orphans, broken links, missing pages, hub pages, stale pages, suggestions | ✅ |
| `test/wiki-index.test.ts` | 9 | generateWikiIndex (empty, root, categories, sort, skip index.md, inactive) | ✅ |
| `test/wiki-collection-type.test.ts` | 11 | upsertStoreCollection, isWikiCollection, getWikiCollections, listCollections, DB migration v2 | ✅ |
| **合计** | **53** | | ✅ |

回归测试：原有 246 个测试全部通过，零回归。

## 文件清单

### 新增文件（Phase 1-4）

```
src/wiki/log.ts            Wiki 活动日志 (append, query, stats, format)
src/wiki/lint.ts           链接图健康分析 (orphans, broken links, missing/hub/stale pages)
src/wiki/index-gen.ts      Wiki 索引页生成器
src/mcp/tools/wiki.ts      MCP wiki 工具 (wiki_ingest, wiki_lint, wiki_log, wiki_index)
src/mcp/tools/document.ts  MCP 精读工具 (doc_toc, doc_read, doc_grep, doc_query, doc_elements)
src/mcp/tools/core.ts      MCP 核心工具 (query, get, multi_get, status)
src/mcp/tools/writing.ts   MCP 写入工具 (doc_write, doc_links)
src/mcp/server/utils.ts    动态 MCP 指令构建器
src/query-parser.ts        结构化查询解析器 (lex:/vec:/hyde:/expand: 语法)
src/maintenance.ts         数据库清理 (vacuum, orphan removal, cache clearing)
test/wiki-log.test.ts      Wiki log 测试 (15 tests)
test/wiki-lint.test.ts     Wiki lint 测试 (18 tests)
test/wiki-index.test.ts    Wiki index-gen 测试 (9 tests)
test/wiki-collection-type.test.ts  Collection type 集成测试 (11 tests)
```

### 修改文件（Phase 1-4）

```
src/collections.ts         type?: "raw" | "wiki" 字段
src/config-schema.ts       Zod schema 添加 type 验证
src/db-schema.ts           v1-v3 migration (indexes, wiki tables, source tracking)
src/store.ts               isWikiCollection, getWikiCollections, upsertStoreCollection, transactions
src/index.ts               addCollection/listCollections type 支持, getBackend, writeDocument
src/search.ts              BM25 权重修正, sanitizeFTS5Term, extractSnippet 改进
src/hybrid-search.ts       强信号检测, 去重, 共享 pipeline 重构
src/llm.ts                 并发保护, QMD_EMBED_MODEL 环境变量, Qwen3 prompt 格式
src/mcp/server.ts          注册所有工具, Streamable HTTP, REST 端点
src/cli/qmd.ts             wiki 子命令, collection add --type, cleanup, pull, --index
CLAUDE.md                  Wiki 命令, 精读工具, 架构文档
README.md                  三层架构, MCP 工具列表, SDK API, 源模块更新
CHANGELOG.md               所有阶段记录
```

## 端到端 Demo

以下步骤可以在本机完整跑通，使用独立的测试索引（不影响主索引）：

```bash
# === 1. 准备测试数据 ===
mkdir -p /tmp/qmd-wiki-demo/sources /tmp/qmd-wiki-demo/wiki

# 创建一个 Markdown 源文档
cat > /tmp/qmd-wiki-demo/sources/attention.md << 'EOF'
# Attention Is All You Need

The Transformer architecture is based solely on attention mechanisms.
Scaled dot-product attention computes: Attention(Q,K,V) = softmax(QK^T/√dk)V.
Multi-head attention runs multiple attention heads in parallel.
EOF

# 创建一个 PDF 源文档 (需要 pymupdf)
python3 -c "
import pymupdf
doc = pymupdf.open()
page = doc.new_page()
page.insert_text((72, 72), 'Gradient Descent\n\nAn optimization algorithm that minimizes loss\nby iteratively updating parameters.', fontsize=11)
doc.save('/tmp/qmd-wiki-demo/sources/gradient.pdf')
doc.close()
"

# === 2. 创建集合 ===
bun src/cli/qmd.ts --index demo collection add /tmp/qmd-wiki-demo/sources --name sources --mask '**/*.{md,pdf}'
bun src/cli/qmd.ts --index demo collection add /tmp/qmd-wiki-demo/wiki --name wiki --type wiki
bun src/cli/qmd.ts --index demo collection list

# === 3. 分析源文档 ===
bun src/cli/qmd.ts --index demo wiki ingest sources/attention.md
bun src/cli/qmd.ts --index demo wiki ingest sources/gradient.pdf

# === 4. 写 Wiki 页面 ===
echo '# Attention Mechanism

The [[attention]] mechanism is the core of the [[transformer]] architecture.

## Key Concepts
- Scaled Dot-Product Attention
- Multi-Head Attention
- Self-Attention

Source: [[sources/attention]]' | bun src/cli/qmd.ts --index demo wiki write wiki concepts/attention.md

# === 5. 搜索（跨 raw + wiki） ===
bun src/cli/qmd.ts --index demo search "attention mechanism"
bun src/cli/qmd.ts --index demo search "gradient"

# === 6. Wiki 健康检查 ===
bun src/cli/qmd.ts --index demo wiki lint
bun src/cli/qmd.ts --index demo wiki log
bun src/cli/qmd.ts --index demo wiki index wiki

# === 7. 清理 ===
rm -f ~/.cache/qmd/demo.sqlite
rm -rf /tmp/qmd-wiki-demo
```

## Bug 修复记录

| Bug | 修复 | 文件 |
|-----|------|------|
| pymupdf 1.27.2 不支持 `get_text("markdown")` | 添加 try/except fallback 到 `get_text("text")` | `src/backends/python/extract_pdf_pages.py` |
| `qmd wiki ingest` 只有 MCP 工具，CLI 不可用 | 新增 `wiki ingest` CLI 子命令 | `src/cli/qmd.ts` |
| `qmd wiki write` 不存在 | 新增 `wiki write` CLI 子命令（stdin → 文件 + 索引 + 日志） | `src/cli/qmd.ts` |

## Phase 5: MinerU-RAG 重命名 + Agent 可用性测试 (2026-04-05)

项目正式加入 **MinerU-RAG** 别名（QMD 仍为简称）。以 AI Agent 身份对 LLM Wiki 系统进行端到端可用性和鲁棒性测试，发现并修复多个关键问题。

### 重命名

| 项目 | 文件 | 状态 |
|------|------|------|
| README / package.json / CLAUDE.md 品牌更新 | 各文件 | ✅ |
| CLI banner → `MinerU-RAG (qmd)` | `src/cli/qmd.ts` | ✅ |
| MCP server name → `mineru-rag`, version → `2.0.1` | `src/mcp/server.ts` | ✅ |
| `bin/mineru-rag` CLI 别名 | `bin/mineru-rag`, `package.json` | ✅ |
| MCP instructions 增加系统描述和 agent 工作流 | `src/mcp/server/utils.ts` | ✅ |
| Skill 文件更新 | `skills/qmd/SKILL.md` | ✅ |

### Agent 可用性测试发现的 Bug 和修复

| Bug | 严重度 | 修复 | 文件 |
|-----|--------|------|------|
| `[[CAP Theorem]]` 被报为 broken link，虽然存在标题为 "CAP Theorem" 的页面（文件名 `cap-theorem.md` 是 kebab-case） | **高** | wiki_lint 增加基于 document title 的 wikilink 解析 | `src/wiki/lint.ts` |
| `doc_links` backward links 为 0，因为同样只匹配文件名不匹配标题 | **高** | SQL 查询增加 `target = document.title` 条件 | `src/index.ts` |
| 搜索结果跨集合重复（同一内容在 mydocs 和 eval 中各出现一次） | **中** | `hybridQuery`, `structuredSearch`, CLI `search` 增加 docid 去重 | `src/hybrid-search.ts`, `src/cli/qmd.ts` |
| `multi-get "mydocs/*.md"` 返回空结果（只有 `qmd://mydocs/*.md` 可用） | **中** | `matchFilesByGlob` 增加 `collection/path` 模式匹配 | `src/store.ts` |
| `wiki index nonexistent` 显示原始 stack trace | **低** | 包裹 try/catch，输出干净错误信息 | `src/cli/qmd.ts` |
| `wiki ingest --wiki nonexistent` 静默接受不存在的集合 | **低** | 验证集合存在且类型为 wiki | `src/cli/qmd.ts` |
| `wiki ingest --wiki mydocs` 不报错（raw 集合不是 wiki） | **低** | 提示使用 `wiki init` 转换 | `src/cli/qmd.ts` |

### Agent 测试用例执行结果

| 测试用例 | 结果 |
|----------|------|
| 创建 wiki collection (`--type wiki`) | ✅ |
| `wiki ingest` 分析源文档 | ✅ |
| `wiki write` 写入 wiki 页面（含 wikilinks） | ✅ |
| `wiki lint` 健康检查（orphans, broken links, missing pages） | ✅ 修复后 |
| `wiki log` 活动日志时间线 | ✅ |
| `wiki index` 索引页生成 | ✅ |
| 跨集合搜索（raw + wiki 混合结果） | ✅ |
| 集合过滤搜索 (`-c testwiki`) | ✅ |
| MCP query 工具 (lex/vec 子查询) | ✅ |
| MCP doc_links 正向/反向链接 | ✅ 修复后 |
| MCP doc_write 创建 wiki 页面 | ✅ |
| MCP wiki_lint 工具 | ✅ |
| 错误处理：不存在的文件/集合 | ✅ 修复后 |
| 错误处理：空 stdin / raw 集合写入 | ✅ |

回归测试：709 通过，56 跳过，0 新增回归。

## Phase 6: Agent 搜索体验优化 (2026-04-05)

以强 AI Agent（Claude）身份对系统进行端到端可用性测试，发现并修复 4 个影响 agent 搜索体验的关键问题。

### 发现的问题

| 问题 | 严重度 | 根因 |
|------|--------|------|
| MCP `query` 工具要求构造 `searches` 数组（lex/vec/hyde 类型），agent 无法简单搜索 | **高** | 旧 `search` 工具被移除后，`query` 只支持结构化子查询 |
| 查询扩展生成 31 个子查询，大量重复 HyDE 文本，浪费 ~80% embedding 计算 | **高** | LLM 输出无去重，直接传入 embedding pipeline |
| 搜索 "design" 返回 score=0，虽然 "API Design Principles" 完全匹配 | **高** | `bm25(documents_fts, 10.0, 1.0)` 只给 filepath 和 title 设了权重，body 列权重为 0 |
| MCP 搜索结果 snippet 包含 `@@ -1,3 @@ (0 before, 71 after)` diff 格式头 | **中** | `extractSnippet` 在 snippet 文本中嵌入 diff header |

### 修复

| 修复 | 文件 |
|------|------|
| MCP `query` 工具新增 `query` 参数（简单搜索模式），与 `searches` 互斥 | `src/mcp/tools/core.ts` |
| `expandQuery` 增加基于 `type:text` 的去重 filter，包含缓存结果去重 | `src/search.ts` |
| `hybridQuery` 在 embedding 前去重 vec/hyde 文本 | `src/hybrid-search.ts` |
| `vectorSearchQuery` 去重扩展查询文本 | `src/hybrid-search.ts` |
| BM25 权重修正：`bm25(documents_fts, 2.0, 5.0, 1.0)` — filepath:2, title:5, body:1 | `src/search.ts` |
| BM25 最低分数 0.01 — 已匹配文档不再显示 0% | `src/search.ts` |
| MCP structuredContent snippet 去掉 `@@ header`，添加 `line` 字段 | `src/mcp/tools/core.ts` |
| MCP instructions 更新：推荐 `query` 简单模式为默认 | `src/mcp/server/utils.ts` |

### 后续修复（二次测试）

| 修复 | 文件 |
|------|------|
| Wiki lint 标题匹配改为大小写不敏感 — `[[CAP theorem]]` 现可匹配 "CAP Theorem" | `src/wiki/lint.ts` |
| Backlink 查询同步大小写不敏感 — `LOWER(target) = LOWER(?)` | `src/index.ts` |
| MCP 测试 DB schema 对齐 v2 迁移 — 补 `type` 列和 `wiki_log` 表 | `test/mcp.test.ts` |
| MCP 测试 server name 对齐 "mineru-rag" | `test/mcp.test.ts` |
| `multi_get` 支持 docid 解析 — `#abc123, #def456` 正确查找文档 | `src/store.ts` |

### 测试结果

所有测试通过（MCP 56/56, Wiki Lint 18/18, SDK 76/76, CLI 85/85, LLM 40/40），0 回归。

端到端 MCP 验证通过:
- 简单查询: `{query: "distributed systems consensus"}` → 3 结果, 最高 93%
- 结构化搜索: `{searches: [{type: "lex", query: "machine learning"}]}` → 正常
- 错误处理: 空参数、query/searches 互斥 → 清晰错误信息
- Wiki 工作流: 建集合 → 写页面 → lint → log → index → 全流程正常
- 大小写不敏感: `[[CAP theorem]]` → 正确解析 "CAP Theorem"

### Phase 4: Wiki Ingest 增强

| 项目 | 文件 | 状态 |
|------|------|------|
| DB migration v3 — `wiki_sources` + `wiki_ingest_tracker` 表 | `src/db-schema.ts` | ✅ |
| Source-aware staleness — `wiki_lint` 检测源文档更新后的陈旧 wiki 页面 | `src/wiki/lint.ts` | ✅ |
| `doc_write` 新增 `source` 参数 — 记录 wiki 页面来源 | `src/mcp/tools/writing.ts` | ✅ |
| 增量 ingest — 追踪源文档 hash，未变化时跳过（支持 `force`） | `src/mcp/tools/wiki.ts` | ✅ |
| 多格式 ingest — PDF/DOCX/PPTX 提供 TOC、页面/节/幻灯片计数 | `src/mcp/tools/wiki.ts` | ✅ |
| 大文档截断 — >50k 字符自动截断，建议用 `doc_read` 访问特定部分 | `src/mcp/tools/wiki.ts` | ✅ |
| CLI `wiki write --source` — 记录来源 | `src/cli/qmd.ts` | ✅ |
| CLI `wiki ingest --force` — 强制重新 ingest | `src/cli/qmd.ts` | ✅ |
| CLI `wiki lint` 输出 source-stale 页面 | `src/cli/qmd.ts` | ✅ |
| MCP instructions 更新 — 记录新功能 | `src/mcp/server/utils.ts` | ✅ |
| 测试 DB schema 对齐 v3 迁移 | `test/mcp.test.ts`, `test/wiki-lint.test.ts`, `test/wiki-collection-type.test.ts` | ✅ |

### 测试结果（Phase 4）

所有测试通过（765/765），0 回归。

## Phase 7: TDD 大规模测试与优化 (2026-04-06)

以强 AI Agent 身份对 MinerU-RAG 系统进行 TDD（测试驱动开发）大规模测试和优化。先编写测试用例暴露问题，再修复并重构。

### TDD 发现的 Bug

| Bug | 严重度 | 根因 | 修复 |
|-----|--------|------|------|
| `writeDocument` 覆盖已有文档时 `SQLITE_CONSTRAINT_PRIMARYKEY` 报错 | **高** | FTS5 trigger `documents_au` 无法正确处理 ON CONFLICT upsert | 改为 delete-then-insert | 
| `multiGet("#abc123")` 单个 docid 返回空结果 | **高** | `isCommaSeparated` 要求 pattern 包含逗号，单 docid 被当作 glob | 增加 `isDocid(pattern)` 检查 |
| `renameCollection` 后搜索结果仍显示旧 collection 名 | **高** | 只更新了 `store_collections` 表，未更新 `documents`、FTS 和 `links` 表 | 同步更新所有相关表 |
| `findSimilarFiles("docs/api-desing.md")` 无法建议 `api-design.md` | **中** | Levenshtein 比较 `docs/api-desing.md` 与 `api-design.md` 时 collection 前缀导致距离过大 | 同时比较 path 和 collection/path |
| `extractSnippet` 在 snippet 文本中嵌入 `@@ -1,3 @@ (0 before, 71 after)` diff header | **中** | 历史遗留设计，结构化字段已包含相同信息 | 从 snippet 文本中移除 header |

### 重构

| 重构 | 文件 | 减少行数 |
|------|------|----------|
| `hybridQuery` / `structuredSearch` 提取共享 pipeline（scoring, blending, chunking, dedup） | `src/hybrid-search.ts` | ~200 行 |
| `parseStructuredQuery` 从 CLI 提取到共享模块 | `src/query-parser.ts` (新建), `src/cli/qmd.ts`, `test/intent.test.ts`, `test/structured-search.test.ts` | ~130 行 |
| MCP snippet 去掉已无效的 `@@` header 正则替换 | `src/mcp/tools/core.ts` | 1 行 |
| CLI snippet body 去掉 `.slice(1)` header 跳过 | `src/cli/qmd.ts` | 1 行 |

### 新增测试

| 测试文件 | 测试数 | 覆盖范围 |
|----------|--------|----------|
| `test/sdk-agent-workflow.test.ts` | 52 | writeDocument (9), getLinks (6), search 边界 (12), extractSnippet 质量 (8), 文档检索 (10), 集合管理 (4), 上下文管理 (3) |

### 测试结果

所有测试通过（885/885），0 回归。较 Phase 6 新增 52 测试。

### 修改文件清单

```
src/index.ts                writeDocument 覆盖修复 (delete-then-insert)
src/store.ts                multiGet 单 docid 支持, renameStoreCollection 全表更新, findSimilarFiles 改进
src/search.ts               extractSnippet 移除 @@ header
src/hybrid-search.ts        提取共享 pipeline (buildResult, dedupAndFilter, chunkAndSelectBest 等)
src/query-parser.ts          新建: 从 CLI 提取 parseStructuredQuery
src/cli/qmd.ts              导入共享 parseStructuredQuery, snippet body 修复
src/mcp/tools/core.ts       移除已无效的 @@ header regex
test/sdk-agent-workflow.test.ts  新建: 52 个 agent 工作流测试
test/store.test.ts           更新 snippet 和 findSimilarFiles 测试
test/intent.test.ts          改用共享 parseStructuredQuery
test/structured-search.test.ts   改用共享 parseStructuredQuery
CHANGELOG.md                记录所有变更
```

## Phase 8: Agent 体验深度 TDD 测试 (2026-04-06)

以强 AI Agent 视角对 MinerU-RAG 的 SDK 接口进行深度 TDD 测试。从 agent 使用系统的完整工作流出发（索引 → 搜索 → 检索 → 写入 → 管理），先编写 65 个覆盖全生命周期的测试用例，通过测试失败暴露 bug，再修复。

### TDD 发现的 Bug

| Bug | 严重度 | 根因 | 修复 |
|-----|--------|------|------|
| SDK `removeCollection` 未清理文档 — 删除集合后文档仍可搜索/检索 | **严重** | SDK 使用 `deleteStoreCollection`（仅删配置行），而非 `removeCollection`（完整清理） | SDK 改用 `store.removeCollection()` 完整清理管线 |
| `renameStoreCollection` 链接源 off-by-one — rename 后 `getLinks()` 返回 0 个前向链接 | **高** | SQL `substr(source, ? + 1)` 参数已含 `+1`，JS 又传 `oldName.length + 1`，实际偏移多跳一位 | SQL 改为 `substr(source, ?)`，JS 参数直接用作 1-indexed 起始位 |
| `removeCollection` 不清理 links 表 — 删除集合后遗留孤儿链接数据 | **中** | `removeCollection()` 清理了 documents、content、cache，但未清理 links | 增加 `DELETE FROM links WHERE source LIKE collectionName/%` |

### 新增测试

| 测试文件 | 测试数 | 覆盖范围 |
|----------|--------|----------|
| `test/agent-experience.test.ts` | 65 | Store 生命周期 (3), 集合删除清理 (5), 文档生命周期 (4), getDocumentBody 边界 (6), 重命名一致性 (5), 多集合搜索 (2), 上下文继承 (4), update 幂等性 (4), 错误处理 (5), 搜索质量 (5), wikilink 工作流 (2), multiGet 模式 (7), 状态准确性 (3), snippet 边界 (5), 结构化搜索 (5) |

### 测试结果

所有测试通过（950/950），0 回归。较 Phase 7 新增 65 测试。

### 修改文件清单

```
src/index.ts                SDK removeCollection 改用完整清理管线，新增 storeRemoveCollection 导入
src/store.ts                renameStoreCollection links 更新 off-by-one 修复, removeCollection 增加 links 清理
test/agent-experience.test.ts   新建: 65 个 agent 体验测试 (15 describe, 65 test cases)
CHANGELOG.md                记录 3 个 bug 修复 + 65 个新测试
WIKI-PROGRESS.md            Phase 8 记录
```

## Phase 9: TDD 深度测试与 Wiki 一致性修复 (2026-04-06)

以强 AI Agent 身份对 MinerU-RAG 系统进行第三轮 TDD 测试。聚焦于 wiki 元数据一致性、FTS 分词质量、集合生命周期完整性、上下文继承、链接图完整性等 15 个维度，共 63 个测试用例。

### TDD 发现的 Bug

| Bug | 严重度 | 根因 | 修复 |
|-----|--------|------|------|
| `removeCollection` 不清理 `wiki_sources` 和 `wiki_ingest_tracker` 表 | **高** | `removeCollection()` 只清理 documents/links/content，遗漏 wiki 元数据表 | 增加 `DELETE FROM wiki_sources/wiki_ingest_tracker WHERE wiki_collection = ?` |
| `renameStoreCollection` 不更新 wiki 表 | **高** | `renameStoreCollection()` 更新了 store_collections/documents/FTS/links，但遗漏 wiki_sources 和 wiki_ingest_tracker | 增加 wiki_sources.wiki_collection/wiki_file 和 wiki_ingest_tracker.wiki_collection 更新 |
| FTS 搜索无法匹配连字符术语（如 `state-of-the-art`） | **中** | `sanitizeFTS5Term()` 使用 `replace(/[^\p{L}\p{N}']/gu, '')` 直接删除非字母数字字符，将 `state-of-the-art` 合并为 `stateoftheart`，无法匹配 FTS5 分词后的独立 token | 改为 `replace(/.../gu, ' ')` 保留词边界，生成短语前缀查询 `"state of the art"*` |

### 新增测试

| 测试文件 | 测试数 | 覆盖范围 |
|----------|--------|----------|
| `test/tdd-deep.test.ts` | 61 | Wiki 清理 (2), Wiki 重命名一致性 (3), getDocumentBody 边界 (5), 搜索质量 (6), 多集合操作 (4), Unicode 处理 (3), 文档生命周期 (6), 上下文继承 (4), 路径解析 (6), 链接完整性 (5), Snippet 质量 (4), 集合重命名完整性 (5), Store 生命周期 (2), Update 幂等性 (2), FTS 边界 (4) |
| `test/structured-search.test.ts` | +2 | buildFTS5Query 连字符/下划线术语测试 |
| **合计** | **63** | |

### 修改文件清单

```
src/store.ts                removeCollection 增加 wiki 表清理, renameStoreCollection 增加 wiki 表更新
src/search.ts               sanitizeFTS5Term 非字母数字改为空格替换（保留词边界）
test/tdd-deep.test.ts       新建: 61 个深度 TDD 测试 (15 describe, 61 test cases)
test/structured-search.test.ts  更新 sanitizeFTS5Term 镜像副本, 新增 2 个 FTS 测试
CHANGELOG.md                记录 3 个 bug 修复
```

### 测试结果

所有测试通过（1013/1013），0 新增回归。较 Phase 8 新增 63 测试。

4 个 LLM 集成测试在全量并行运行时偶发超时（GPU 资源争用），单独运行全部通过，属于已知 flaky 问题。

## 未来可扩展方向

1. **wiki_ingest LLM 合成** — 当前 ingest 只提供上下文和建议，由外部 agent 完成合成。可以考虑集成本地 LLM 自动生成摘要页面。
2. **wiki schema/template** — 支持用户定义 wiki 页面模板（类似 Karpathy 的 Schema 概念）。
3. **多 wiki 集合联动** — 跨 wiki 集合的链接分析和索引。
4. **MCP HTTP sqlite-vec 加载** — HTTP 传输模式下 `vec0` 模块加载失败，导致 vec/hyde 查询不可用（lex 查询正常）。
