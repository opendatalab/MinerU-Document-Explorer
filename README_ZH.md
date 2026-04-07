<h1 align="center">
  <img src="assets/logo.png" alt="logo" height="28" style="vertical-align: middle; margin-right: 8px;">
  MinerU 文档探索器
</h1>

<p align="center">
  告别文档翻找噩梦——为 Agent 装上"火眼金睛"（预览版）
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="#">ClawHub</a>
</p>

---

面对堆积如山的 PDF，每次填报表单、汇总信息时，Agent 需要一页一页硬读文档，不仅效率极低，Token 消耗也居高不下。**MinerU 文档探索器**是专为 Agent 打造的文档阅读技能，提供四大核心能力的原子操作以便自由组合，让 Agent 能像人类一样灵活阅读和提取 PDF 内容。

## 🔍 四大核心能力

<p align="center">
  <img src="assets/overview.png" alt="MinerU文档探索器" width="100%">
</p>

| 能力 | 说明 |
|------|------|
| **逻辑检索**（懂目录，知结构） | 理清文档骨架，直接空降目标章节，无需从头翻找 |
| **语义检索**（懂意思，不拘泥字眼） | 自然语言查询，精准定位相关页面，跨语言也能检索 |
| **关键词检索**（精准定位，一击即中） | 支持正则表达式，全盘扫描所有匹配位置 |
| **证据提取**（图文并茂，抠图贴图） | 精准提取表格、图片、公式等细粒度元素，附带元素级引证信息 |

## 📈 性能提升

接入 MinerU 文档探索器后，在我们的测试任务上：

- **📉 Token 消耗降低 ~40%**（基于 Claude Opus 4.6 测试）：从平均 45k Tokens 降至 28k Tokens
- **🎯 任务成功率提升 20%+**（基于 Minimax 2.1 测试）：从 60%～70% 提升至 ~90%

---

## 🎬 Demo

https://github.com/user-attachments/assets/9a2840bf-c314-462e-9e41-73f5a6ded7c3

**功能演示：** 逻辑检索 | 语义检索 | 关键词检索 | 证据提取

**实战案例：**
- 🏦 化身"金融分析师"，自动生成研报 PPT
- 📚 化身"金牌助教"，批改六级并制作错题本

---

## 📦 安装

### 方式一：ClawHub

只需要一行代码，你就可以安装：

```
clawhub install mineru-document-explorer
```

执行成功后，请将以下内容发送给您的 OpenClaw Agent：

``` 
测试一下已下载的mineru-document-explorer这个技能
```

### 方式二：GitHub（让 Agent 自动安装）

把以下内容发给你的 OpenClaw Agent，它会自动完成安装和配置：

```
帮我用git clone安装这个 PDF 阅读 Skill：https://github.com/opendatalab/MinerU-Document-Explorer, 然后测试一下。
```

Agent 会自动：读取安装说明 → 复制技能目录 → 运行安装脚本 → 引导配置。

安装完成后，Agent 会询问是否配置 PageIndex（可选，提供 OpenAI 兼容 API key 后可为文档自动生成目录，不配置不影响使用）。

---

## 📖 Citation

如果本项目对你有帮助，请引用以下论文：

```bibtex
@article{wang2026agenticocr,
  title={AgenticOCR: Parsing Only What You Need for Efficient Retrieval-Augmented Generation},
  author={Wang, Zhengren and Ma, Dongsheng and Zhong, Huaping and Li, Jiayu and Zhang, Wentao and Wang, Bin and He, Conghui},
  journal={arXiv preprint arXiv:2602.24134},
  year={2026}
}

@article{niu2025mineru2,
  title={Mineru2.5: A decoupled vision-language model for efficient high-resolution document parsing},
  author={Niu, Junbo and Liu, Zheng and Gu, Zhuangcheng and Wang, Bin and Ouyang, Linke and Zhao, Zhiyuan and Chu, Tao and He, Tianyao and Wu, Fan and Zhang, Qintong and others},
  journal={arXiv preprint arXiv:2509.22186},
  year={2025}
}
```

---

## 🤝 Acknowledgement

感谢 [MinerU](https://github.com/opendatalab/MinerU) 提供文档解析能力，支持关键词搜索与模式匹配。

感谢 [PageIndex](https://github.com/VectifyAI/PageIndex) 支持逻辑检索能力。

感谢 [Qwen3-VL-Embedding](https://github.com/QwenLM/Qwen3-VL-Embedding) 支持语义检索能力。

---

## 📄 License

本项目基于 [MIT License](LICENSE) 开源。
