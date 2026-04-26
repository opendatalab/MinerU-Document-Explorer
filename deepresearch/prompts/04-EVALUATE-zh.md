# DeepResearch 2.0 — Phase 4：质量评估

> **目标**：给两份研报各打一份**可解释、可审计**的评分卡，输出 JSON 供脚本聚合。
> 评分维度严格对齐 `deepresearch/eval/rubric.md`。

---

## 评估对象

1. `deepresearch/output/reports/wiki-first.md`
2. `deepresearch/output/reports/direct.md`

---

## 6 维评分细则（详细见 rubric.md）

| 维度 | 权重 | 检查点 |
|---|---:|---|
| 来源质量 | 20 | 一手 vs 二手；高 stars / 高引；时效（>=2022） |
| 覆盖完整度 | 20 | 7 个 research_questions 命中数 |
| 引用可追溯性 | 20 | 结论级语句的 `(source/addr)` 或 `[[wikilink]]` 命中率 |
| 结构与连贯性 | 15 | 章节断裂、术语不一致、重复段 |
| 洞察与判断 | 15 | 是否有"为什么 / 何时不适用 / trade-off" |
| 结论稳定性 | 10 | 跨章节结论是否互相矛盾；是否声明"不敢下的结论" |

---

## 工作流

### Step 1 — 自动检查先跑
先让脚本给一个客观下限：

```bash
python3 deepresearch/eval/auto_check.py \
  --report deepresearch/output/reports/wiki-first.md \
  --json > /tmp/wiki-auto.json
python3 deepresearch/eval/auto_check.py \
  --report deepresearch/output/reports/direct.md \
  --json > /tmp/direct-auto.json
```

`auto_check.py` 给出：
- `citation_ratio`（结论级语句中带引用的比例）
- `coverage_hits`（命中的 research_questions 数）
- `wikilink_count` / `inline_source_count`
- `section_balance`（章节字数标准差）
- `structure_score`（粗略 0–100）

把这些数值作为**起点**，由你（Agent）在主观维度上做加减。

### Step 2 — 主观打分（必须给理由）

对每一份研报输出：

```json
{
  "report": "wiki-first.md|direct.md",
  "auto_check": { ... auto_check 输出原样 ... },
  "dimensions": [
    {
      "name": "source_quality",
      "weight": 20,
      "score": 18,
      "rationale": "高信任种子 8/10 命中；最古老引用 2022。-2 分因有 1 处博客 URL 已失效。",
      "evidence": [
        "papers/2308.13418.pdf cited 4x",
        "repos/opendatalab__MinerU.md cited 2x"
      ]
    },
    {
      "name": "coverage",
      "weight": 20,
      "score": 17,
      "rationale": "7 个 research_questions 命中 6 个，工程吞吐部分缺",
      "evidence": ["§5.1 涉及 RAG 影响", "§3 表格对比"]
    }
    // ... 其余 4 维
  ],
  "total": 86,
  "notes": "<= 200 字，整体定性评价"
}
```

### Step 3 — 写文件

- `deepresearch/output/evaluation/wiki-first.json`
- `deepresearch/output/evaluation/direct.json`

### Step 4 — 触发综合脚本

```bash
python3 deepresearch/eval/score.py \
  --wiki deepresearch/output/evaluation/wiki-first.json \
  --direct deepresearch/output/evaluation/direct.json \
  --out deepresearch/output/evaluation/summary.json
```

`score.py` 会：
1. 校验权重和维度名一致性
2. 重新计算加权总分（防手算错）
3. 输出 `summary.json` 与 `summary.md`（人类可读）

---

## 评分准则（避免水分）

- **没有 evidence 的维度上限 = 权重 × 0.6**（即不许给"凭感觉" 90 分）。
- **直接生成版**在结构 / 洞察维度上**很可能**只能拿 50–65%——这是预期，不要为了"对称"硬拉。
- 如果 Wiki 版分数 < 80，说明 Wiki 体系本身有问题，回 Phase 1 修。
- 如果 Direct 版 ≥ Wiki 版，必须在 `notes` 里写清楚原因（很可能是 Wiki 路径偷懒）。

---

## 输出汇总

完成后目录应有：

```
deepresearch/output/evaluation/
├── wiki-first.json
├── direct.json
├── comparison.json    (来自 Phase 3)
└── summary.json       (脚本生成)
└── summary.md         (脚本生成)
```

`summary.md` 是给社区演示的最终物料，应当 ≤ 1 屏。
