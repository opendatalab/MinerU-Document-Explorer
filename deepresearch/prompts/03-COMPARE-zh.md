# DeepResearch 2.0 — Phase 3：对比报告

> **目标**：把 `wiki-first.md` 与 `direct.md` 放在同一台秤上，输出一份**人能看懂、内部能复用**的对比报告。

---

## 输入

- `deepresearch/output/reports/wiki-first.md`（Phase 1 产出）
- `deepresearch/output/reports/direct.md`（Phase 2 产出）
- Wiki 内的 `index.md` / `wiki_log()`（可用于侧写 Wiki 体系健康度）
- `deepresearch/eval/rubric.md`（评分维度）

---

## 工作流

### Step 1 — 把两份研报都读完
- `multi_get("deepresearch/output/reports/wiki-first.md, deepresearch/output/reports/direct.md")`
- 列一个并排对比 sheet（章节级对齐）。

### Step 2 — 按 6 个维度对比（与 rubric 对齐）

对每一个维度，给出：**Wiki 版得分**、**Direct 版得分**、**差距来源**、**最有说服力的一处实例**（贴片段 + 行号 / addr）。

| 维度 | 权重 | 你要回答的问题 |
|---|---:|---|
| 来源质量 | 20 | 引用是否一手 / 高 stars / 时效新？ |
| 覆盖完整度 | 20 | 7 个 research_questions 是否都被回答？ |
| 引用可追溯性 | 20 | 任意结论是否能落到具体 source + addr？ |
| 结构与连贯性 | 15 | 章节是否贯通？有没有结构断裂？ |
| 洞察与判断 | 15 | 有没有"为什么"层面的判断，而不是堆叠？ |
| 结论稳定性 | 10 | 不同章节的结论是否互相一致？ |

### Step 3 — 写对比报告

路径：`deepresearch/output/reports/comparison.md`

#### 推荐结构

```markdown
# 文档解析领域调研：Wiki 先行 vs 直接生成 对比报告

## 0. TL;DR
- Wiki 版总分：X / 100
- Direct 版总分：Y / 100
- 关键差距来源：……

## 1. 评分一览（表格）
| 维度 | 权重 | Wiki | Direct | Δ |
|---|---:|---:|---:|---:|
| 来源质量 | 20 | 18 | 12 | +6 |
| ...

## 2. 章节级对比（章节对齐表）
| 章节 | Wiki 写法 | Direct 写法 | 差异要点 |
|---|---|---|---|
| OCR | 综合多源、含取舍 | 拼贴片段、未对比 | Wiki 给出了 trade-off 表 |
| ...

## 3. 五个最具说服力的差距实例
对每个实例：贴 Wiki 片段 + 贴 Direct 片段 + 解释为什么 Wiki 路径更可靠。

## 4. 局限：Wiki 路径的代价
- 时间成本：建 Wiki 多花了 N 步工具调用
- 失败模式：Wiki 出现过 X 次断链 / 孤立页
- 在哪些场景下 Wiki 路径**不划算**

## 5. 给社区用户的 3 条结论
- 一句话叙事：……
- 何时该用 Wiki 路径：……
- 何时直接生成够用：……
```

### Step 4 — 写一份机器可读的小 JSON

路径：`deepresearch/output/evaluation/comparison.json`

```json
{
  "wiki_first": {
    "dimensions": {
      "source_quality": 18,
      "coverage": 17,
      "traceability": 19,
      "structure": 14,
      "insight": 13,
      "stability": 9
    },
    "total": 90
  },
  "direct": {
    "dimensions": {
      "source_quality": 12,
      "coverage": 13,
      "traceability": 10,
      "structure": 9,
      "insight": 8,
      "stability": 6
    },
    "total": 58
  },
  "delta": 32,
  "headline": "Wiki 路径在引用可追溯性上领先 9 分，是总差距的最大来源"
}
```

---

## 质量自检

- [ ] 评分必须给**理由**（不是凭感觉）。
- [ ] 对比章节里 **Wiki 与 Direct 引用的同一份原始文档**至少出现 1 次（证明差异不是来源不同造成的）。
- [ ] 至少有 1 处 Direct 版**优于** Wiki 版的实例（避免单边夸大）。
- [ ] JSON 与 Markdown 数字一致。
