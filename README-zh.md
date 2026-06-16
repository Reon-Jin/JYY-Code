# JYY-Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://github.com/Reon-Jin/JYY-Code/blob/main/LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)

> 基于 OpenCode 深度扩展的 AI 编程 Agent，融合多 Agent 协作、持久记忆、技能学习、通信能力和更可靠的任务状态管理。

JYY-Code 是一个 AI 驱动的开发助手。它在 OpenCode 协议基础上扩展了多 Agent 编排、SQLite 持久化状态、权限控制、工具规范化、终端 UI 和跨会话记忆，目标是让 Agent 能更稳定地完成复杂、长耗时、多步骤的软件工程任务。

## 核心特性

### 多 Agent 集群

JYY-Code 内置编排器、规划器、审查器架构，可以把复杂任务拆成结构化计划，并分派给专业子 Agent 并行执行。

能力包括：

- 支持 researcher、analyst、coder、tester、reviewer、chart、pdf、visual 等专业角色。
- 支持最大子 Agent 数、并发数、审查轮数和模型路由配置。
- 计划中包含任务 ID、依赖关系、验收标准和预期产物。
- Cluster 模式下 `task` 工具默认以后台子 Agent 执行，`task_status` 用于轮询或等待结果。
- 子 Agent 返回结果要求带结构化状态和摘要，便于主 Agent 审查与汇总。
- 增加完成门控，避免主 Agent 在后台子任务仍在执行时提前把集群任务视为完成。

### 持久化 Agent 集群状态

新的多 Agent 状态不再只依赖解析模型输出文本，而是写入 SQLite，作为 UI 和 API 的权威状态源。

- `agent_cluster_run` 记录运行级状态、目标、规划模型、审查模型和完成时间。
- `agent_cluster_task` 记录计划任务、子会话绑定、任务状态、审查轮次、验收标准和产物路径。
- `agent_cluster.event` 用于向 TUI 推送运行和任务状态变化。
- `GET /session/:sessionID/agent-cluster` 暴露某个会话下的集群运行和任务状态。
- 子任务会话会绑定回计划任务 ID，后台执行、会话刷新和 UI 同步时状态更可靠。

### 更清晰的 TUI 右侧栏

终端 UI 现在把计划摘要、结构化任务和普通 Todo 分开显示：

- **Multi-Agent Plan**：展示集群运行摘要，包括状态、步骤进度、Agent 数量和目标预览。
- **Tasks**：展示结构化多 Agent 任务，区分 queued、running、done、failed。
- **Todo**：只展示普通 `todowrite` 项；当存在结构化集群任务时自动隐藏，避免重复或冲突的进度提示。

这个设计让长时间运行的 multi-agent 会话更容易扫读，也修复了右侧 Todo 状态和真实执行状态不一致的问题。

### 邮件与通信能力

内置 SMTP/IMAP 通信适配器，Agent 可以直接在会话中收发邮件。

- 支持 SMTP STARTTLS 和 SMTPS。
- 支持 OAuth2，包括 Microsoft device-code 授权流程。
- 支持 MIME 附件和自动 content-type 检测。
- 支持 IMAP 邮箱轮询和邮件会话识别。

### 类 Hermes 持久记忆系统

JYY-Code 使用结构化文件记忆保存项目事实、工程约定、用户偏好和经验教训。

- 项目记忆和用户记忆双作用域。
- 每条记忆带置信度和来源信息。
- 每轮对话后自动提取关键记忆。
- 支持搜索、补丁更新、废弃和建议操作。

### 技能学习

基于 Markdown 的技能系统可以加载领域知识、工作流和工具集成。

- 从 `.jyycode/skills/` 自动发现本地技能。
- 支持通过 HTTP index 发现远程技能。
- 使用 frontmatter 元数据做相关性匹配。
- 运行中可通过 skill 工具加载特定技能说明。

### 智能工具搜索

当 Agent 不确定该调用哪个工具时，可以通过 token 相关度评分快速定位工具。

- 对工具 ID 和描述进行匹配评分。
- 支持精确匹配、子串匹配和内容匹配。
- 返回工具参数摘要，帮助 Agent 更快完成工具选择。

### 架构优化

- **工作流状态**：会话、消息、Todo、集群运行、集群任务和事件投影均由 SQLite/Drizzle 管理。
- **Worktree 管理**：支持 Git worktree 创建、删除、重置和隔离子任务执行。
- **工具调用规范化**：统一 schema 校验、参数解析、输出截断、权限门控和 metadata 传递。
- **安全约束**：支持按工具、Agent、会话维度配置 ask/allow/deny 权限规则。

### 其他能力

- 支持 20+ LLM 提供商：Anthropic、OpenAI、Google Gemini、AWS Bedrock、Azure、GitHub Copilot、OpenRouter、xAI、Groq、Mistral 等。
- 完整支持 MCP 工具服务器。
- 支持 npm 插件和内部插件，包含 hook 与 TUI 扩展点。
- 基于 SolidJS 和 OpenTUI 的终端界面。
- 支持跨机器会话同步与恢复。
- 支持 LSP 集成。

## 快速开始

### 环境要求

- 普通用户需要 Node.js 20+ 和 npm。
- 只有从源码开发时才需要 [Bun](https://bun.sh/) >= 1.3.14。

### 安装运行

```bash
# 安装已发布的 CLI 包装器
npm install -g jyycode-ai

# 在当前终端目录启动 JYY-Code
jyy
```

`jyy` 和 `jyycode` 指向同一个 CLI。进程会继承终端当前工作目录，所以在 `/path/to/project` 里运行 `jyy`，JYY-Code 的工作目录就是 `/path/to/project`。

### 配置大模型 Provider

推荐使用内置凭证命令：

```bash
jyycode auth login --provider openai
jyycode models openai
jyy
```

也可以使用所选 Provider 支持的环境变量，例如：

```bash
export OPENAI_API_KEY="sk-..."
jyycode models openai
```

或者写入全局配置文件 `~/.config/jyycode/jyycode.jsonc`：

```jsonc
{
  "$schema": "https://jyycode.ai/config.json",
  "model": "openai/gpt-5",
  "provider": {
    "openai": {
      "options": {
        "apiKey": "sk-...",
      },
    },
  },
}
```

规范配置键是 `provider`、`permission`、`plugin`。加载器也兼容常见的复数别名 `providers`、`permissions`、`plugins`，避免按旧文档填写后配置不生效。

### 从源码开发

```bash
git clone https://github.com/Reon-Jin/JYY-Code.git
cd jyycode
bun install
bun run dev
```

## 项目结构

```text
jyycode/
|-- packages/
|   |-- jyycode/          # 主应用：CLI、Agent、会话、工具、记忆、技能、TUI
|   |-- core/             # 核心库：文件系统、Provider 辅助、通用工具
|   |-- llm/              # LLM 抽象层与协议适配器
|   |-- plugin/           # 插件 SDK 与 TUI/插件接口
|   |-- sdk/              # JYYCode API 客户端 SDK
|   |-- http-recorder/    # 测试用 HTTP 录制/回放
|   |-- script/           # 共享脚本
|   `-- identity/         # 身份提供商资源
|-- .jyycode/             # 项目级配置、技能、Agent、命令、主题
|-- memory/               # 持久记忆存储
|-- specs/                # 设计规格文档
|-- script/               # 构建和 CI 脚本
`-- patches/              # 依赖补丁
```

## 架构概览

```text
CLI 输入
  -> 配置加载
  -> 会话恢复
  -> 系统提示词构建（技能 + 记忆 + 工具）
  -> LLM 调用（Provider 选择 + 流式输出）
  -> 工具执行（权限检查 + Schema 校验 + 执行 + 输出截断）
  -> 对话后处理（记忆提取 + 状态持久化 + 事件发布）

Multi-Agent 模式：
  用户请求
  -> 集群规划器
  -> 持久化计划任务
  -> 后台子 Agent 执行
  -> task_status / 审查
  -> 最终汇总
  -> TUI 从持久化集群状态渲染
```

## 主要模块

| 模块 | 说明 |
| --- | --- |
| `agent/` | Agent 定义与提示词管理 |
| `agent-cluster/` | 多 Agent 集群：规划、状态持久化、调度、审查 |
| `communication/` | 邮件收发：SMTP、IMAP、OAuth2 |
| `config/` | 配置加载、合并与 schema 定义 |
| `memory/` | 类 Hermes 记忆系统 |
| `skill/` | 技能发现、加载与激活 |
| `tool/` | 工具注册、定义、校验、截断 |
| `session/` | 会话管理、提示词构建、LLM 调用 |
| `provider/` | LLM 提供商生命周期与模型发现 |
| `plugin/` | 插件加载与 hook 系统 |
| `worktree/` | Git worktree 管理 |
| `permission/` | ask/allow/deny 权限系统 |
| `server/` | HTTP API 服务 |
| `storage/` | SQLite 数据库层 |
| `mcp/` | Model Context Protocol 支持 |
| `bus/` | 事件总线 |
| `sync/` | 会话同步与状态投影 |

## 配置

项目级配置位于 `.jyycode/jyycode.jsonc`，全局用户配置位于 `~/.config/jyycode/jyycode.jsonc`。

主要配置项：

- **provider**：LLM 提供商凭证与模型偏好。
- **permission**：工具访问规则，支持按工具和 Agent 配置 ask/allow/deny。
- **agent_cluster**：多 Agent 集群参数，包括模型选择、并发数和审查轮次。
- **mcp**：MCP 服务连接配置。
- **skills**：技能发现路径。
- **plugin**：TUI 和运行时插件来源。

## 重要 API

```http
GET /session/:sessionID/agent-cluster
```

返回指定会话的持久化 Agent 集群运行和任务状态。TUI 在会话同步时读取该接口，并通过 `agent_cluster.event` 持续更新状态。

## License

MIT (c) [JYYCode](https://github.com/Reon-Jin/JYY-Code)
