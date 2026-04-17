## Demo 讲师备忘（中文）

这份材料用于把 `demo/` 讲成一堂“可跟做”的实操课，核心目标是：**让学员在 30–45 分钟内跑通闭环并产生可见产物（Wiki 页面）**。

---

### 课程定位（你要强调的三句话）

- MinerU Document Explorer 不是“另一个 RAG 框架”，而是 **让 Agent 具备读文档/搜信息/写知识** 的基础设施。
- 脚本只做最少的非智能工作（抓取 + 建索引）；**结构化知识与链接关系由 Agent 通过 MCP 工具生成**。
- 产物不是一次性答案，而是 **可维护的 Wiki**：可追溯（source）、可 lint（断链/孤页/过期）、可持续演进。

---

### 课前准备（强烈建议）

#### A. 网络与下载风险控制

课堂最常见卡点来自：
- arXiv PDF 下载慢/不稳定
- 首次下载本地模型（embedding / rerank / query expansion）耗时

建议：
- 课堂现场用 **轻量模式**：`--max 3 --skip-embed`（只跑闭环体验）
- 课后再布置完整模式（10 篇 + embedding）

#### B. 预跑一遍，准备“离线兜底”

你可以在课前预跑一次：

```bash
bun install
pip install feedparser pymupdf
bash demo/setup.sh --max 3 --skip-embed
```

兜底策略：
- 若课堂 arXiv 不通，可把你预先准备好的 `demo/papers/`（含 PDF 与 `metadata.json`）发给学员
- 然后让学员用：

```bash
bash demo/setup.sh --skip-download --skip-embed
```

> 注意：`--skip-download` 只跳过下载；本地必须已有 PDF 文件。

#### C. 预检查清单（开课前 5 分钟）

```bash
python3 --version
bun --version
python3 -c "import feedparser; import pymupdf; print('OK')"
```

如是 macOS，若后续要跑向量/sqlite 扩展相关能力，必要时提示：

```bash
brew install sqlite
```

---

### 课堂节奏（推荐 45 分钟）

#### 0–5 分钟：概念与产物预览

- 展示三张图（`assets/demo1.png`~`demo3.png`）
- 强调“脚本 vs Agent”的分工与闭环：索引 → 检索 → 精读 → 写回 Wiki

#### 5–20 分钟：学员动手跑 setup

统一口径（减少等待）：

```bash
bash demo/setup.sh --max 3 --skip-embed
```

你需要提醒：
- 这是“体验课”，先跑通闭环；embedding 后面再开

#### 20–25 分钟：启动 MCP + Cursor 配置

```bash
bun src/cli/qmd.ts --index demo mcp --http
curl http://localhost:8181/health
```

引导学员填写 `.cursor/mcp.json` 指向 `http://localhost:8181/mcp`。

#### 25–40 分钟：让 Agent 产出 Wiki（体验感最高）

统一使用中文 prompt（减少沟通成本）：
- `demo/AGENT-PROMPT-zh.md`

课堂 MVP（你可以要求至少做到）：
- 论文页 1–3 个
- 概念页 2 个
- `wiki_lint` 修一次断链
- `wiki_index(write=true)` 生成索引页

#### 40–45 分钟：练习题（或布置课后）

用 `demo/EXERCISES-zh.md` 选 1–2 题即可。

---

### 常见故障与快速处理

- **setup 报错：feedparser / pymupdf 缺失**
  - 统一让学员执行：

```bash
pip install feedparser pymupdf
python3 -c "import feedparser; import pymupdf; print('OK')"
```

- **端口 8181 占用**
  - 换端口启动，并同步改 Cursor 配置：

```bash
bun src/cli/qmd.ts --index demo mcp --http --port 8080
```

- **Agent 调用工具失败 / 看不到工具**
  - 先让学员在对话里执行一次 `status()`；若失败，回查：
    - MCP server 是否在跑
    - `.cursor/mcp.json` url 是否正确
    - 是否被系统代理/防火墙拦截 localhost

- **课堂时间不够**
  - 直接把目标降级到：“写 1 个论文页 + 1 个概念页 + 生成 index”，先完成体验闭环。

---

### 课后延展（你可以布置）

- 完整模式重跑：`bash demo/setup.sh --max 10`（含 embedding）
- 让 Agent 写 `wiki/survey.md` 的长版
- 把 demo 流程迁移到自己的文档：新增 collection + context，复用相同 prompt 框架

