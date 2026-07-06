# JYY-Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://github.com/Reon-Jin/JYY-Code/blob/main/LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)

[中文文档](README-zh.md) · [English](README.md)

> **会记忆、会协作、能把复杂任务真正做完的编程 Agent。**
>
> 一句话交代目标，剩下的交给一支可观察、可恢复的 AI 工程团队。

<p align="center">
  <img src="./logo/logo.gif" alt="JYY-Code 动态标志" width="500" />
</p>

JYY-Code 是一个面向真实软件工程的终端 Agent 系统。它能拆解复杂任务、调度专业子 Agent、追踪后台执行、记住长期上下文，并从持久化状态继续工作，而不是每次都从头开始。

```text
规划 → 委派 → 并行执行 → 审查 → 恢复 → 交付
```

**安装：** `npm install -g jyycode-ai` · **启动：** `jyy`

如果你希望编程 Agent 像一支工程团队，而不是一个不断滚动的聊天窗口，JYY-Code 就是为此而生。觉得方向不错，欢迎点一个 ⭐。

## 为什么是 JYY-Code

| 常见编程 Agent | JYY-Code |
| --- | --- |
| 会话一换，上下文就丢 | 用结构化项目记忆和用户记忆持续积累上下文 |
| 所有过程挤在文本流里 | 在 TUI 中直接展示计划、任务、Agent 和状态 |
| 后台任务容易失联 | 用 SQLite 持久化会话、集群运行、任务和事件 |
| 一个 Agent 包打天下 | 按依赖关系委派专业 Agent，并经过审查再完成 |
| 每轮塞入庞大的工具列表 | 用 BM25 工具搜索按需找到正确工具 |

## 核心亮点

### 真正的多 Agent 工程协作

按 **F9**，把一个复杂目标变成带依赖关系的执行计划。

- 规划器、编排器、专业 Agent 和审查器各司其职。
- 内置 researcher、coder、tester、analyst、visual、chart、PDF 等角色。
- 支持后台并行执行、并发控制和模型路由。
- 每项任务都有明确 ID、依赖关系、验收标准和预期产物。
- 审查轮次与完成门控，避免子任务没结束就提前宣布“完成”。
- Git worktree 隔离并行编码任务，减少互相覆盖。

### 不会随聊天消失的记忆

JYY-Code 使用两份严格校验的 JSON 记忆库，不依赖不透明的向量数据库：

- `MEMORY.json`：每个 session 维护一条持续更新的任务记忆。
- `USER.json`：保存稳定的用户事实和偏好，以规范化关键词作为唯一键。
- 每轮首次模型调用注入两库各 Top 10，合计最多 20 条。
- 对话中自动搜索并注入相关记忆。
- 每轮结束后由模型判断是否值得长期保存；首次有效对话带安全兜底。
- Schema 校验、敏感信息检查、去重、容量限制、文件锁和原子替换共同保护数据。
- 只有主 session 可以写入；子 Agent 可读取，但不能污染记忆库。

你不必反复解释项目背景、工程约定和个人偏好。Agent 会逐步理解你的项目，并在后续任务中保持一致。

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

## 给项目一个 Star

JYY-Code 面向那些真正需要 Agent 具备记忆、协作、可见性和执行力的开发者。

如果这也是你期待的编程 Agent 形态，欢迎在 [GitHub 上 Star JYY-Code](https://github.com/Reon-Jin/JYY-Code) ⭐

## License

MIT © [JYYCode](https://github.com/Reon-Jin/JYY-Code)
