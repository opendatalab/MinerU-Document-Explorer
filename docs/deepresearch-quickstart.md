# DeepResearch 2.0 快速上手

简短 5 分钟教程，对应 `deepresearch/README.md` 的精简实操版。

## 适用对象

- 想验证"Wiki 先行 vs 直接生成"价值差距的研究者
- 想用 MinerU Document Explorer 跑一遍完整 DeepResearch 流程的工程师
- 想为自己的领域复制这套工作流的产品负责人

## 5 步跑通 POC

### 1. 装依赖

```bash
python3 --version              # >= 3.10
pip install feedparser pyyaml pymupdf
# 可选改善博客抓取：
pip install beautifulsoup4 html2text
```

仓库自身依赖（如未装）：

```bash
bun install                    # 或 npm install -g mineru-document-explorer
```

### 2. 体检

```bash
bash deepresearch/run.sh doctor
```

输出会列出：python、各 pip 包、qmd、index、目录状态。
全是 ✓ 再继续。

### 3. 抓资料 + 建索引

课堂快版（不下 embedding）：
```bash
bash deepresearch/run.sh setup --max 20 --skip-embed
```

完整版（首次会下载 embedding 模型，约 2GB）：
```bash
bash deepresearch/run.sh setup --max 30
```

如有 MinerU 云解析：
```bash
MINERU_API_KEY=xxx bash deepresearch/run.sh setup --max 30
```

期望产出：
- `deepresearch/sources/papers/` 若干 PDF + `metadata.json`
- `deepresearch/sources/blogs/` 若干 markdown
- `deepresearch/sources/repos/` 若干 README markdown
- 索引 `~/.cache/qmd/deepresearch.sqlite`，含 `papers / blogs / repos / wiki` 四个 collection

### 4. 启 MCP 服务器

```bash
bash deepresearch/run.sh serve --port 8181
```

把你的 Agent 客户端（Claude Code / Cursor / Claude Desktop）指向
`http://localhost:8181/mcp`。

### 5. 顺序投喂 4 份 prompt

按下表把每份 markdown 完整粘贴给 Agent，等 Agent 跑完一份再投下一份：

| 顺序 | Prompt | 期望产物 |
|---:|---|---|
| 1 | `prompts/01-WIKI-FIRST-zh.md` | `output/wiki/*` + `output/reports/wiki-first.md` |
| 2 | `prompts/02-DIRECT-zh.md` | `output/reports/direct.md` |
| 3 | `prompts/03-COMPARE-zh.md` | `output/reports/comparison.md`, `output/evaluation/comparison.json` |
| 4 | `prompts/04-EVALUATE-zh.md` | `output/evaluation/wiki-first.json`, `direct.json` |

### 6. 自动检查 + 综合评分

```bash
bash deepresearch/run.sh check
```

会调用 `auto_check.py` 给两份研报打客观分（citation_ratio / 覆盖 / 结构），
再用 `score.py` 把 Agent 写出的两份 JSON 汇总到 `output/evaluation/summary.md`。

## 失败排查

| 症状 | 原因 | 处理 |
|---|---|---|
| `pyyaml ✗` | 没装 | `pip install pyyaml` |
| arxiv 抓取超时 | 网络 | 用 VPN 或 `--skip-papers` |
| GitHub 403 | rate limit | `export GITHUB_TOKEN=...` |
| `MinerU API 失败` | key 错 | `unset MINERU_API_KEY`，回落 PyMuPDF |
| 端口冲突 | 8181 被占 | `bash run.sh serve --port 8282` |
| Agent 写不到 wiki collection | 路径错 | 在 `01-WIKI-FIRST-zh.md` 中已说明：写到 `wiki` collection 即可，不要写绝对路径 |

## 切换到自己的主题

```bash
cp deepresearch/topics/document-parsing.yml deepresearch/topics/my-topic.yml
# 编辑 my-topic.yml 里的 arxiv.queries / seed_papers / blogs / repos / research_questions
bash deepresearch/run.sh setup --topic deepresearch/topics/my-topic.yml --max 20
```

prompts 是主题无关的——Agent 会在 runtime 读 `topics/*.yml` 决定回答哪 7 个问题。

## 进阶

- 多主题并行：每个主题用不同 `--index-name`（在 `setup.sh` 中可改）
- 自定义评分维度：编辑 `eval/rubric.md` + 同步修改 `eval/score.py` 的 `EXPECTED_DIMENSIONS`
- CI 化：`run.sh check` 退出码反映评分（待实现）
