# JYY-Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://github.com/Reon-Jin/JYY-Code/blob/main/LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)

[中文文档](README-zh.md) · [English](README.md)

> **一套会计划、派发、审核、打回并汇总交付的 Multi-Agent 工程工作流。**
>
> 一句话交代目标，剩下的交给一支可观察、可恢复的 AI 工程团队。

<p align="center">
  <img src="./logo/logo.gif" alt="JYY-Code 动态标志" width="500" />
</p>

JYY-Code 是一个面向真实代码与文档工作的终端 Multi-Agent 系统。它不让单个通用 Agent 同时承担全部上下文、执行和自我验收，而是把目标变成一条受控的工程流水线：主 Agent 制定计划、向专业 Agent 派发任务、逐项审核结果、不合格就打回修改，最后只汇总通过验收的产物。

```text
计划 → 派发 → 并行执行 → 审核 → 打回修改 → 汇总交付
```

**安装：** `npm install -g jyycode-ai` · **启动：** `jyy`

按 **F9** 启动 Multi-Agent 工作流；运行 **`/cluster`**，可分别为规划、复杂任务、简单任务和视觉任务选择模型。

## 为什么是 JYY-Code

| 常见编程 Agent | JYY-Code |
| --- | --- |
| 会话一换，上下文就丢 | 用结构化项目记忆和用户记忆持续积累上下文 |
| 所有过程挤在文本流里 | 在 TUI 中直接展示计划、任务、Agent 和状态 |
| 后台任务容易失联 | 用 SQLite 持久化会话、集群运行、任务和事件 |
| 一个 Agent 既生产又自我验收 | 专业 Agent 产出代码和文档，主 Agent 负责审核、打回和汇总 |
| 每轮塞入庞大的工具列表 | 用 BM25 工具搜索按需找到正确工具 |

## 核心亮点

### 有闭环的 Multi-Agent 工程工作流

按 **F9** 启动 Multi-Agent 模式，把复杂目标变成带依赖关系的执行计划。使用 **`/cluster`**，可为 planner、complex、simple、visual 等不同角色分别选择模型，让每个阶段使用更适合它的模型。

- **计划：** 主 Agent 把目标拆成明确任务，写清依赖关系、验收标准和预期产物。
- **派发：** researcher、coder、tester、analyst、visual、chart、PDF 等专业 Agent 获取聚焦后的上下文，并可并行执行。
- **审核：** 每项结果都必须对照验收标准检查；仍在运行或未审核的任务无法越过完成门控。
- **打回：** 不合格结果会带着具体问题退回同一个子 Agent 会话修改，保留已有上下文并支持多轮复审。
- **汇总：** 所有任务进入终态后，主 Agent 只把验收通过的结果整合为一致的代码或文档交付物。
- 支持并发控制和按角色配置模型，在质量、速度与成本之间灵活取舍。
- Git worktree 隔离并行编码任务，减少互相覆盖。

规划、生产与质量控制彼此分离，使 JYY-Code 在代码实现和复杂文档交付上，比让单 Agent 在一个上下文窗口里同时研究、执行、验证和自审更可靠。

### 在执行前后持续校准的结构化记忆

JYY-Code 使用透明、可检查、经过严格 Schema 校验的 JSON 记忆，而不是不透明的向量数据库：

- `MEMORY.json` 保存每个主会话不断演进的任务状态与最终结果；`USER.json` 保存稳定的用户事实和偏好。
- 用户发起新一步时，系统先进行语义更新，在执行前记录当前目标；助手完成交付后再次更新，用已经验证的完成状态替换进行中的任务记忆。
- 在 Multi-Agent 模式中，记忆系统会跳过中间的规划回复，以最后的汇总结果为准，避免把“准备做什么”误记成“已经完成什么”。
- 每条记忆都有重要度、规范化关键词和精炼内容；任务记忆还包含日期与会话来源。提示词优先注入最重要、最相关的条目，按需搜索则综合关键词、正文和重要度排序。
- 相同规范化关键词对应同一条结构化记忆，更新时直接替换，而不是不断追加近似内容，长期使用也不容易积累噪声。
- 接近容量阈值时会自动压缩：合并重叠条目，并结合重要度、时效性和关键词复用率保留更有价值的信息；硬性容量限制避免记忆无限挤占上下文。
- 严格 Schema 校验、敏感信息拒绝、仅主会话可写、文件锁、原子替换和追加式审计日志，共同保证一致性、安全性与可追溯性。

这套记忆不是“记得越多越好”，而是有选择地记录、可直接检查、能够追踪来源；所有子 Agent 都能受益于长期上下文，却不能污染持久记忆。

### 长任务也不会失联

长时间运行的工作，不应该因为终端刷新而消失。

- 会话、消息、Todo、集群运行、集群任务和事件全部写入 SQLite。
- 子会话始终绑定到对应的计划任务 ID。
- 通过 `task` 和 `task_status` 观察后台执行。
- `/sessions` 可直接恢复持久化根会话。
- 不同发布渠道使用隔离数据库，避免开发版 Schema 意外影响稳定数据。

### 为 Agent 工作流设计的 TUI

右侧栏清晰区分三类进度：

- **Multi-Agent Plan**：目标、运行状态、步骤和 Agent 数量。
- **Tasks**：queued、running、done、failed 等结构化任务状态。
- **Todo**：普通 `todowrite` 项，不与集群任务重复展示。

无需翻完整聊天记录，就能知道谁在做什么、哪里被阻塞、哪些任务已经完成。

### 在正确的时间找到正确的工具

按 **F10** 使用智能工具搜索。

- 字段加权 BM25 检索工具 ID、类别、参数、描述和示例。
- 精确匹配与意图加权，让具体工具排在泛化结果前面。
- 渐进式工具披露保留核心工具，其余工具按需加载。
- 内置工具、插件工具和 MCP 工具共享统一的检索、权限和遥测链路。

核心工具覆盖目录探索、代码搜索、原子多段编辑、Shell、后台进程、子 Agent 任务和输出截断。

## 快速开始

### 安装

普通用户只需要 Node.js 20+ 和 npm；从源码开发时才需要 Bun。

```bash
npm install -g jyycode-ai
cd /path/to/your/project
jyy
```

进入 JYY-Code 后运行 `/connect` 配置模型 Provider。

`jyy` 和 `jyycode` 是同一个 CLI。启动时所在的终端目录，就是 Agent 的工作区。

### 使用配置文件

全局配置：`~/.config/jyycode/jyycode.jsonc`

```jsonc
{
  "$schema": "https://jyycode.ai/config.json",
  "model": "openai/gpt-5",
  "provider": {
    "openai": {
      "options": {
        "apiKey": "sk-..."
      }
    }
  }
}
```

项目配置位于 `.jyycode/jyycode.jsonc`。主要配置项包括 `provider`、`permission`、`agent_cluster`、`mcp`、`skills` 和 `plugin`。

## 工作流程

```text
用户目标
  → 恢复会话与长期记忆
  → 构建提示词（指令 + 技能 + 记忆 + 工具）
  → 规划并委派任务
  → Agent 与工具在权限控制下执行
  → 持久化任务、事件、消息和结果
  → 审查输出并检查是否真正完成
  → 对话结束后评估长期记忆
```

集群模式：

```text
目标
  → 规划器
  → 持久化任务依赖图
  → 专业子 Agent 并行执行
  → 审查器
  → 最终汇总
```

## 更多内置能力

- **20+ 模型 Provider**：Anthropic、OpenAI、Gemini、Bedrock、Azure、GitHub Copilot、OpenRouter、xAI、Groq、Mistral 等。
- **MCP 与插件**：连接外部工具、Hook 和 TUI 扩展。
- **技能系统**：从本地或远程加载可复用的领域知识和工作流。
- **LSP 集成**：让 Agent 获得超越文本搜索的代码理解能力。
- **邮件能力**：SMTP、IMAP、OAuth2 和 MIME 附件。
- **上下文感知**：估算活跃上下文，不把 PDF 和图片 data URL 当作普通文本计算。
- **会话同步**：跨环境恢复和同步工作状态。
- **权限控制**：按工具、Agent 和会话配置 ask、allow、deny。

## 会话安全与恢复

JYY-Code 会隔离已发布版本和源码开发版本的数据库。运行：

```bash
jyycode db status
```

可以查看当前数据库、发布渠道、迁移状态和会话数量，不会修改其他数据库。更改渠道策略前，请先停止 JYY-Code，并同时备份数据库及其 `-wal`、`-shm` 文件。

如果会话看起来“丢失”，先用 `jyycode db status` 确认当前数据库，再从同一项目或 worktree 打开 `/sessions`。

## 从源码开发

```bash
git clone https://github.com/Reon-Jin/JYY-Code.git
cd JYY-Code
bun install
bun run dev
```

```text
packages/jyycode/   主 CLI、Agent、会话、记忆、工具和 TUI
packages/core/      文件系统、Provider 和共享工具
packages/llm/       LLM 协议与运行时适配
packages/plugin/    插件 SDK 与扩展接口
packages/sdk/       JYY-Code API 客户端
.jyycode/           项目 Agent、技能、命令、主题和配置
memory/             结构化持久记忆
```

## License

MIT © [JYYCode](https://github.com/Reon-Jin/JYY-Code)
