# jyycode

jyycode 是一个基于 opencode 改造的 AI 编程助手项目，在原有终端编码体验上增加了邮件收发和 Agent 集群能力。

核心扩展：

- 邮件收发：通过 SMTP 发送邮件、通过 IMAP 轮询收件箱，并可让 jyycode 根据邮件内容自动创建会话、生成回复、发送文件。
- Agent 集群：针对复杂任务启用 Multi-Agent 模式，由主 Agent 拆解任务、并发调度子 Agent、汇总和复核结果。

## 快速开始

环境要求：

- Bun 1.3.x
- Git
- Node.js 运行环境，仅用于部分包装脚本和生态工具

安装依赖：

```bash
bun install
```

本地运行 CLI：

```bash
bun run dev
```

也可以直接在核心包目录运行：

```bash
cd packages/jyycode
bun run dev
```

构建 CLI：

```bash
cd packages/jyycode
bun run build
```

类型检查必须在包目录执行：

```bash
cd packages/jyycode
bun typecheck
```

测试也不要在仓库根目录执行，按包运行：

```bash
cd packages/jyycode
bun test
```

## 邮件收发

邮件配置应放在全局配置文件中，不要放进仓库提交。这样无论从哪个文件夹启动 `jyycode`，都会加载同一份邮件配置。

当前全局配置路径：

```text
C:\Users\35027\.config\jyycode\jyycode.jsonc
```

通用配置示例：

```jsonc
{
  "$schema": "https://jyycode.ai/config.json",
  "communication": {
    "email": {
      "smtpHost": "smtp.qq.com",
      "smtpPort": 587,
      "imapHost": "imap.qq.com",
      "imapPort": 993,
      "mailbox": "INBOX",
      "username": "your-email@example.com",
      "password": "your-smtp-or-app-password",
      "from": "your-email@example.com"
    },
    "finish": {
      "enabled": true,
      "to": "owner@example.com",
      "subject": "JYYCode work finished"
    },
    "inbox": {
      "enabled": true,
      "owner": "owner@example.com",
      "pollSeconds": 5
    }
  }
}
```

使用方式：

- 启动 `jyycode` 后，`inbox.enabled` 为 `true` 时会自动轮询邮箱。
- 从 `owner` 邮箱发送邮件到监控邮箱，jyycode 会把邮件内容作为会话输入处理，并把结果回复到 `owner`。
- 在会话里让模型发送文本时，可使用内置 `send_message` 工具。
- 在会话里让模型发送文件时，可使用内置 `send_file` 工具。
- 运行 `jyycode finish` 可发送当前工作目录的收尾摘要邮件。

示例：

```bash
jyycode finish "完成 README 和配置清理"
jyycode run "把当前目录下的 README.md 发到我的邮箱"
```

安全注意：

- 不要把真实邮箱密码、SMTP 授权码、OAuth refresh token 提交到 GitHub。
- 项目内 `.jyycode/jyycode.jsonc` 只保留非敏感项目配置。
- 如果需要给团队提供模板，请提交带占位符的示例配置，而不是个人配置。

## Agent 集群

Agent 集群配置字段是 `agent_cluster`。默认功能开启，但普通会话默认不自动启用。

示例：

```jsonc
{
  "agent_cluster": {
    "enabled": true,
    "default_on": false,
    "planner_model": "provider/model",
    "reviewer_model": "provider/model",
    "complex_model": "provider/model",
    "simple_model": "provider/model",
    "max_subagents": 10,
    "max_concurrency": 8,
    "max_review_rounds": 2,
    "artifact_dir": ".jyycode/agent-cluster"
  }
}
```

使用方式：

- 在 TUI 会话里按 `F9` 切换 Multi-Agent 模式。
- 配置 `"default_on": true` 后，新普通会话默认启用 Agent 集群。
- 邮件会话默认禁用 Agent 集群，避免后台邮件处理生成过多子任务。
- 运行产物默认写入 `.jyycode/agent-cluster`，该目录已加入 `.gitignore`。

适合使用 Agent 集群的场景：

- 多文件改造
- 大范围代码审查
- 竞品或资料整理
- 需要并行调研、实现、复核的复杂任务

## 部署与发布

本项目默认分支是 `dev`。准备上传 GitHub 时建议流程：

```bash
git init
git checkout -b dev
git add .
git status
git commit -m "chore: initial jyycode release"
git remote add origin <your-github-repo-url>
git push -u origin dev
```

发布前检查：

```bash
cd packages/jyycode
bun typecheck
bun run build
```

如果修改了 SDK，需要按项目约定重新生成：

```bash
./packages/sdk/js/script/build.ts
```

## 仓库结构

- `packages/jyycode`：CLI、TUI、会话、邮件、Agent 集群等核心逻辑。
- `packages/app`：Web 应用。
- `packages/desktop`：桌面应用。
- `packages/sdk`：SDK 和 OpenAPI 产物。
- `.jyycode`：项目级命令、技能、主题和非敏感配置。

## GitHub 上传前清理

已加入忽略规则的常见本地文件：

- `node_modules`
- `.turbo`
- `dist`
- `.sst`
- `.env`
- `.jyycode/node_modules`
- `.jyycode/package*.json`
- `.jyycode/agent-cluster`
- `.jyycode/*.local.jsonc`

上传前请额外确认：

```bash
git status --ignored
```

如果看到真实密钥或一次性调研输出，不要提交。
