# JYY-Code

[![Release](https://img.shields.io/github/v/release/Reon-Jin/JYY-Code?style=flat-square)](https://github.com/Reon-Jin/JYY-Code/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

[中文](README-zh.md) · [English](README.md)

<p align="center">
  <img src="./logo/logo.gif" alt="JYY-Code" width="500" />
</p>

> **让 AI 围绕真实项目持续推进，直到形成可验证的交付。**

JYY-Code 是一个面向真实代码与文档工作的 AI 工程环境。它将项目上下文、工程工具、会话状态、长期记忆和 Agent 协作组织在同一套工作流中，让复杂任务可以持续推进，并最终形成可验证的交付结果。

[开始使用](#快速开始) · [查看 Releases](https://github.com/Reon-Jin/JYY-Code/releases)

## 完成真正交付

JYY-Code 将完成标准落实到计划、任务、实际产物和验收记录。面对复杂目标，它会形成可执行的计划，把任务交给适合的 Agent，并持续记录每一步的依赖、状态和结果。

```text
目标 → 计划 → 执行 → 验收 → 修改 → 交付
```

子 Agent 提交结果后，主 Agent 会根据验收标准检查实际产物。未通过的工作会带着具体问题返回原来的 Agent 继续修改；只有经过验收的结果，才能进入最终汇总。

项目、Session、任务进度和审核记录会持续保存。工作中断后，可以恢复已有 Session，并基于已保存的对话和任务状态继续工作。

JYY-Code 让工作持续推进到真正可以交付的状态。

## 快速开始

### 安装并启动

需要 Node.js 20+ 和 npm。

```bash
npm install -g jyycode-ai@latest
cd /path/to/your/project
jyy
```

首次启动时，JYY-Code 会自动下载适合当前操作系统和处理器架构的可执行文件。

`jyy` 和 `jyycode` 是同一个命令。启动命令时所在的目录，就是 Agent 的工作区。

### 连接模型

进入 JYY-Code 后运行：

```text
/connect
```

选择并连接你使用的模型 Provider。连接完成后，就可以直接在当前项目中发起任务。

例如：

```text
分析这个项目的认证流程，找出一个可以复现的问题，修复它，并运行相关测试验证。
```

### 处理复杂任务

普通任务默认由单个 Agent 完成。面对需要研究、实现、测试和审核的复杂目标，可以按 **F9** 启用 Multi-Agent 工作流。

运行 `/cluster` 可以分别配置规划、复杂任务、简单任务和视觉任务使用的模型。启用后，JYY-Code 会生成执行计划、派发任务，并在所有结果通过验收后完成最终交付。

## 在真实项目中工作

JYY-Code 直接在项目目录中工作。它结合项目结构、开发约定、代码搜索、LSP 和 Git 信息理解当前环境，再通过文件编辑、Shell 和工程工具完成修改与验证。

- **理解项目上下文**：读取项目结构、开发指令、依赖关系和已有实现。
- **执行并验证修改**：编辑文件、运行命令、执行测试，并根据结果继续调整。
- **保持工作连续**：保存项目、Session、消息、任务状态和长期记忆。
- **控制关键操作**：敏感操作需要确认；信息不足时，Agent 会提出具体问题。
- **接入现有工具链**：支持模型 Provider、MCP、Skills 和插件。

## Multi-Agent 协作

JYY-Code 将复杂目标拆成带有依赖关系、验收标准和预期产物的任务。主 Agent 负责规划、审核和最终汇总，专业 Agent 分别承担研究、编码、测试、分析和视觉工作。

- **聚焦的任务简报**：每个 Agent 获得当前任务范围、前序结果、下游需求、验收标准和待解决的审核问题。
- **分步执行**：同一步骤中的任务可以并行处理；当前步骤全部通过后，下一步骤开始执行。
- **明确验收**：主 Agent 对照验收标准检查结果和实际产物，并记录每项审核结论。
- **连续修改**：未通过的任务返回原 Agent 会话，保留已有上下文，并附带具体修改要求。
- **按角色选择模型**：规划、复杂任务、简单任务和视觉任务可以使用不同模型。
- **隔离并行修改**：编码任务可以使用独立 Git worktree，减少并行工作之间的文件冲突。

所有计划任务通过验收后，主 Agent 会将结果整理成一致的最终交付。

## 持续保存的工作状态

JYY-Code 将项目、Session、消息、Todo、集群运行、任务和事件写入 SQLite。重新启动后，可以通过 `/sessions` 恢复已有 Session，查看之前的对话和任务状态，并继续工作。

结构化记忆保存当前目标、已验证的结果以及稳定的用户偏好。每轮任务开始时记录当前目标，完成后更新实际交付状态。主 Agent 负责写入长期记忆，子 Agent 使用与任务相关的共享上下文。

运行以下命令可以查看当前数据库、发布渠道、迁移状态和 Session 数量：

```bash
jyycode db status
```

该命令只读取状态。发布版本和源码开发环境使用独立数据库。

## 权限与本地数据

JYY-Code 按工具、Agent 和 Session 执行权限规则。每项操作可以配置为 `ask`、`allow` 或 `deny`。需要确认的操作会在执行前向用户发出权限请求。

项目目录是 Agent 的默认工作区。文件操作、Shell 命令、外部目录访问和其他工具调用都遵循对应的权限策略。

通过 `/connect` 添加的认证信息保存在 JYY-Code 数据目录的 `auth.json` 中，并使用受限文件权限写入。模型请求由所连接的 Provider 处理；项目文件、Session 和运行状态由本地后端管理。

## 配置与扩展

全局配置文件位于：

```text
~/.config/jyycode/jyycode.jsonc
```

项目配置文件位于：

```text
.jyycode/jyycode.jsonc
```

最小配置示例：

```jsonc
{
  "model": "openai/gpt-5",
  "permission": {
    "*": "ask",
  },
  "agent_cluster": {
    "default_on": false,
    "max_concurrency": 4,
  },
}
```

配置文件可以管理：

- 模型 Provider 和默认模型；
- 工具与目录权限；
- Multi-Agent 模型路由、并发和审核轮次；
- MCP Server；
- Skills；
- 插件与 Hook。

认证信息可以通过 `/connect` 单独管理。

## 使用入口

JYY-Code 的不同界面共享同一套项目和运行数据。

| 入口            | 当前状态 | 适用场景                                             |
| --------------- | -------- | ---------------------------------------------------- |
| CLI / TUI       | 完整支持 | 单 Agent、Multi-Agent、模型配置和完整工程工作流      |
| Windows Desktop | Preview  | 项目、Session、对话、工具调用、权限请求和 Agent 问题 |

CLI / TUI 支持 macOS、Linux 和 Windows，并提供 x64 与 arm64 构建。

Windows Desktop 当前提供单 Agent 界面，并复用 JYY-Code 本地后端。开发要求、构建命令和运行说明见 [`packages/desktop/README.md`](packages/desktop/README.md)。

## 从源码开发

源码开发使用 Bun 1.3.14。

```bash
git clone https://github.com/Reon-Jin/JYY-Code.git
cd JYY-Code
bun install
bun run dev
```

仓库采用 Bun workspace：

```text
packages/jyycode/   Agent Runtime、Session、Memory、Tools 和 TUI
packages/app/       图形界面
packages/desktop/   Desktop 外壳与本地 sidecar
packages/core/      文件系统、Provider 和共享基础能力
packages/llm/       LLM 协议与运行时适配
packages/plugin/    插件 SDK 与扩展接口
packages/sdk/       JYY-Code API Client
```

Desktop 开发流程见 [`packages/desktop/README.md`](packages/desktop/README.md)。

## 致谢

JYY-Code 最初基于 [OpenCode](https://github.com/anomalyco/opencode) 的开源代码与架构开始开发，并在此基础上持续扩展了工作状态持久化、Multi-Agent 任务编排、验收门控和交付流程。

JYY-Code 是独立开发的开源项目，与 OpenCode 团队不存在隶属或官方合作关系。

## 反馈

通过 [GitHub Issues](https://github.com/Reon-Jin/JYY-Code/issues) 报告问题或提出功能建议。

## 许可证

JYY-Code 基于 [MIT License](LICENSE) 发布。
