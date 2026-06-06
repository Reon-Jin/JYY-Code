# JYY-Code

[![License](https://img.shields.io/github/license/anomalyco/jyycode?style=flat-square)](https://github.com/anomalyco/jyycode/blob/main/LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)

> 基于 OpenCode 二次开发的 AI 智能编程 Agent，融合多 Agent 协作、持久记忆、技能学习与邮件收发能力。

JYY-Code 是一个 AI 驱动的开发助手，在 OpenCode 协议基础上进行了深度扩展，架构上参考了 Claude Code 的设计理念，实现了工作流优化、Worktree 管理、工具调用规范化和安全性约束等增强。

## 核心特性

### 多 Agent 集群（Multi-Agent Cluster）

采用编排器-规划器-审查器（Orchestrator-Planner-Reviewer）架构，将复杂任务自动拆解并分派给专业子 Agent 并行执行：

- **规划器（Planner）** — 分析任务，生成结构化执行计划
- **调度器（Dispatcher）** — 定义子 Agent 角色（研究员、分析师、编码者、测试者、审查者等），按依赖关系调度
- **审查器（Reviewer）** — 多轮审查子 Agent 输出，确保质量
- 支持最多 100 个子 Agent、可配置并发数、依赖解析和批量调度

### 邮件收发

内置 SMTP/IMAP 通信适配器，Agent 可直接在会话中收发邮件：

- SMTP（STARTTLS）和 SMTPS（SSL）双模式
- Microsoft OAuth2 设备码授权流程
- MIME 多部件附件，自动检测 15+ 种文件类型
- UTF-8 主题编码、线程头（In-Reply-To / References）
- IMAP 邮箱轮询监控与会话检测

### 类 Hermes 记忆系统

结构化的文件持久记忆系统，跨会话保留项目知识、工程规范、用户偏好和经验教训：

- **双域存储** — 项目记忆（`memory/`）+ 用户记忆，分离关注点
- **置信度评级** — 每条记忆标注 low / medium / high，支持来源追溯
- **结构化分段** — 项目事实、工程约定、重复工作流、环境坑点、历史教训、近期会话
- **完整操作集** — read / write / search / patch / supersede / suggest
- **自动提取** — 每轮对话后自动从上下文中提取关键信息存入记忆

### 技能学习（Skill Learning）

基于 Markdown 的技能系统，从本地或远程加载领域知识、工作流和工具集成：

- 从 `.jyycode/skills/**/SKILL.md` 自动发现本地技能
- 支持通过 HTTP 远程发现和安装技能（`index.json` + `SKILL.md`）
- Frontmatter 元数据用于相关性匹配和自动激活
- 内置技能：JYYCode 配置编辑

### 基于 Token 相关度评分的工具搜索

当 Agent 不确定该使用哪个工具时，通过分词-评分的相关度匹配快速定位：

- 查询分词，对工具 ID 和描述进行评分（精确匹配 +8、子串匹配 +5、内容包含 +1）
- 按相关度降序返回结果
- 返回每个工具的参数列表和描述，帮助 Agent 快速决策

### 架构优化（参考 Claude Code 设计）

- **工作流优化** — 会话管理（SQLite + Drizzle ORM）、智能压缩（Compaction）、会话摘要、Plan 模式执行、每轮对话后自动记忆提取
- **Worktree 管理** — Git Worktree 的创建、删除和重置，支持隔离的任务执行环境
- **工具调用规范化** — 统一的工具定义接口（`Def` / `Info` / `Context`），Schema 参数校验、输出截断、权限门控
- **安全性约束** — 可配置的权限系统（ask / allow / deny），支持按 Agent 粒度的规则集、会话级审批、Shell 安全指引

### 其他能力

- **20+ LLM 提供商** — Anthropic、OpenAI、Google Gemini、AWS Bedrock、Azure、GitHub Copilot、OpenRouter、xAI、Groq、Mistral、DeepInfra、Cloudflare 等
- **MCP（Model Context Protocol）** — 完整支持 MCP 工具服务器
- **插件系统** — 基于 npm 和内部插件的双轨架构，含 Hook 生命周期
- **TUI 终端界面** — 基于 SolidJS 和 OpenTUI 构建的交互式终端 UI
- **会话同步** — 跨机器的会话备份与恢复
- **LSP 集成** — Language Server Protocol 支持

## 快速开始

### 环境要求

- [Bun](https://bun.sh/) >= 1.3.14

### 安装运行

```bash
# 克隆仓库
git clone https://github.com/anomalyco/jyycode.git
cd jyycode

# 安装依赖
bun install

# 开发模式运行
bun run dev
```

## 项目结构

```
jyycode/
├── packages/
│   ├── jyycode/          # 主应用（CLI、Agent、会话、工具、记忆、技能等）
│   ├── core/             # 核心库（AI SDK 提供商、文件系统、插件类型、工具函数）
│   ├── llm/              # LLM 抽象层（各提供商实现、协议适配器）
│   ├── plugin/           # 插件 SDK（类型、Hooks、TUI 接口）
│   ├── sdk/              # JYYCode API 客户端 SDK
│   ├── http-recorder/    # HTTP 录制/回放（测试用）
│   ├── script/           # 共享脚本
│   └── identity/         # 身份提供商资源
├── .jyycode/             # 项目级配置（技能、Agent、命令、工具、主题、插件）
├── memory/               # 持久记忆存储
├── specs/                # 设计文档（存储、v2 协议）
├── script/               # 构建与 CI 脚本
└── patches/              # 依赖补丁
```

## 架构概览

```
CLI 输入 → 配置加载 → 会话恢复 → 系统提示词构建（技能 + 记忆 + 工具）
  → LLM 调用（提供商选择 → AI SDK streamText）
  → 工具执行（权限检查 → Schema 校验 → 执行 → 输出截断）
  → 对话后处理（记忆提取 → 会话持久化 → 事件发布）

多 Agent 模式：
  主 Agent → 制定计划 → 调度器 → 子 Agent（并行执行）→ 审查器 → 结果合成
```

### 主应用模块（`packages/jyycode/src/`）

| 模块 | 说明 |
|------|------|
| `agent/` | Agent 定义与提示词管理 |
| `agent-cluster/` | 多 Agent 集群（编排、规划、调度、审查） |
| `communication/` | 邮件收发（SMTP/IMAP/OAuth2） |
| `config/` | 配置加载、合并与 Schema 定义 |
| `memory/` | 类 Hermes 记忆系统 |
| `skill/` | 技能发现、加载与激活 |
| `tool/` | 工具注册、定义、校验、截断 |
| `session/` | 会话管理、提示词构建、LLM 调用 |
| `provider/` | LLM 提供商生命周期与模型发现 |
| `plugin/` | 插件加载与 Hook 系统 |
| `worktree/` | Git Worktree 管理 |
| `permission/` | 权限系统（ask/allow/deny） |
| `server/` | HTTP API 服务 |
| `storage/` | SQLite 数据库层（Drizzle ORM） |
| `mcp/` | Model Context Protocol 支持 |
| `bus/` | 事件总线 |
| `sync/` | 会话同步与备份 |

## 配置

项目级配置位于 `.jyycode/jyycode.jsonc`，全局用户配置位于 `~/.config/jyycode/jyycode.jsonc`。

主要配置项：
- **providers** — LLM 提供商凭证与模型偏好
- **permissions** — 工具访问规则（按工具和 Agent 粒度的 ask/allow/deny）
- **agent_cluster** — 多 Agent 集群参数（模型选择、并发数、审查轮次）
- **mcp** — MCP 服务器连接配置
- **skills** — 技能发现路径

## License

MIT © [JYYCode](https://github.com/anomalyco/jyycode)
