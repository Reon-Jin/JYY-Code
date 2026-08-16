# JYY-Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://github.com/Reon-Jin/JYY-Code/blob/main/LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)

[中文文档](README-zh.md) · [English](README.md)

> **面向长任务、并行执行与故障恢复的 Runtime-first Multi-Agent Coding System。**
>
> 一句话目标，进入一条持久化工程工作流：**规划 → 并行执行 → 审核 → 打回/重试 → 显式合并**。

<p align="center">
  <img src="./logo/screenshot.png" alt="JYY-Code 桌面端多智能体模式：右侧为方案面板与协作黑板" width="900" />
</p>

<p align="center">
  <sub>桌面端多智能体模式实拍：主 Agent 逐项审核子 Agent 汇报，右侧方案面板展示阶段进度，协作黑板沉淀各子 Agent 的发现与交接。</sub>
</p>

**desktop安装：** https://github.com/Reon-Jin/JYY-Code/releases

## JYY-Code 真正不同在哪里

JYY-Code 不假设 LLM 能稳定地记住方案、协调多个 Agent、保证验收质量、隔离并发修改，或者在进程崩溃后自己恢复正确状态。它把这些责任从 Prompt 中拿出来，交给**运行时**。

| 问题 | JYY-Code 把它交给什么机制 |
| --- | --- |
| 规划 | 带 revision 的结构化 Plan、分阶段 Step、依赖关系与可判定 `done_criteria` |
| 执行 | 严格 Task 状态机与协议化派发 |
| 并行 | 批量 wave 调度，单波最多 20 个隔离子 Agent |
| 质量控制 | Report → review → reject/redispatch 的强制闭环 |
| 代码集成 | Worktree / Snapshot 隔离 + 显式 `Merge.apply` |
| Agent 协作 | 带语义类型、已读游标与事件唤醒的共享黑板 |
| 路线选择 | 盲提案、交叉评审、最终综合裁决的 Candidate 竞争 |
| 长任务上下文 | 分层上下文、情景摘要与结构化持久记忆 |
| 崩溃恢复 | 持久事件、可重建投影、Activation Lease 与启动时 reconcile |

所以 JYY-Code 不是“一个 Agent 再多接几个工具”，而是一个**给 Agent 提供边界、共享状态、恢复语义和可审核执行协议的工程运行时**。

## 1. 由协议强制执行的工程闭环

JYY-Code 的核心流程由工具与状态迁移强制执行，而不是在 Prompt 里要求 Agent“请认真协作”。

```text
Plan_create → Plan_update(add_task) → Dispatch_dispatch → Report → review_task(approve) → Merge.apply → merged → cleanup
     ↑                                                              ↓
     └──────────── reject + 具体 feedback → 重新派发 ────────────────┘
```

- **方案会随认知演进。** 工作被组织为多个 Step，每个 Step 都有可观察、可判定的 `done_criteria`；当前阶段没有验收通过，后续阶段不会盲目展开。
- **Task 状态不是聊天文本。** Task 沿 `pending → dispatched → running → reported → approved / rejected / dismissed` 等受控状态迁移，非法跳转由运行时直接拒绝。
- **审核是真正的门禁。** 主 Agent 必须对照 `done_criteria` 检查汇报与相关产物；打回必须说明具体缺口，下一次派发会自动注入上一轮 feedback。
- **子 Agent 不能改写编排状态。** 标准子会话负责执行和 Report，不能直接修改父 Plan。
- **异常不会消失在模型文本里。** 汇报预检失败、子任务取消和运行时错误都会进入持久化 Inbox，成为必须处理的显式状态。

这使“多 Agent 协作”从一种 Prompt 约定，变成了真正的状态化协议。

## 2. 高并行，但不让工作区失控

JYY-Code 的并行目标不是简单“多开几个 Agent”，而是在不互相覆盖代码的前提下并行真实工程任务。

- **协议级并行。** 同一 wave 中已就绪的 Task 批量派发，而不是一个个慢慢串行启动；**单波最多 20 个子 Agent 并行运行**。
- **强制检查可拆分性。** 中大型任务会检查独立交付物、独立模块、独立调查问题、独立验证面与角色专长，避免 Planner 轻易退化成串行方案。
- **隔离执行。** Git 项目的标准 Task 使用独立 Worktree；非 Git 项目使用可写 Snapshot 工作区。共享主工作区只是显式兼容模式，不是默认路径。
- **审核通过不等于自动写回。** 子 Agent 的结果即使被 approve，也不会静默修改父工作区；主 Agent 仍需显式调用 `Merge.apply` 集成。
- **冲突必须被看见。** 非重叠修改可自动合并，真实冲突会暴露给主 Agent 决策，而不是后台偷偷执行“优先子版本”。
- **子 Agent 运行期间零轮询。** 派发后主 Agent 挂起，由 Report、Inbox 或黑板事件精确唤醒，不用消耗 token 反复查询状态。

并行、隔离、审核和合并不是四个松散功能，而是一条完整的工程协议。

## 3. 持久运行时，而不是依赖某个进程活着

长任务 Agent 最脆弱的地方之一，是把进程内存当成真实状态。JYY-Code 明确区分**持久状态**和**当前活跃进程**。

- **EventV2 是会话状态的持久事实源。** 状态变化写入版本化事件日志；Projection 只是可重建、可版本化的派生视图，可以通过 replay 恢复。
- **子会话身份是持久的。** 正在运行的进程只是这个子会话当前的一次 activation。通过 `owner_id + generation + lease` 做所有权隔离，旧进程在被接管后无法继续结算或修改同一子任务。
- **重启恢复是明确协议。** 冷启动时，运行时不会把“数据库里有一条 running 记录”误认为“子 Agent 真的还活着”，而是重新检查、接管、恢复或安全拒绝，并写入 Inbox。
- **内存事件流不等于持久化。** 进程内 PubSub、通知和缓存可以随时消失；真正的恢复边界是已经提交的持久事件。
- **恢复过程可回放、可审计。** Projection watermark、有限的 recovery metadata，以及 copy-first / resumable 的存储迁移流程，让部分失败可以定位，而不是悄悄污染状态。

这些机制真正影响的是最难的场景：长会话、大量子 Agent、崩溃、重启和部分失败。

## 4. 共享黑板：Agent 之间真正共享信息

并行 Agent 不是多个互不相干的聊天窗口。每个 Step 都有一块由用户、主 Agent 和子 Agent 共用的共享黑板。

- `info / risk / blocker / decision / help` 五种语义消息
- @提及、附件、线程回复、Task 关联
- 每个参与者独立的已读游标与实时未读状态
- 其他 Agent 发来关键信息时事件驱动唤醒
- 协议禁止心跳和重复进度灌水，黑板只保留发现、依赖、交接和求助

主 Agent 可以直接看到子 Agent 之间的沟通并介入，协作信息不再被锁死在各自私有 Prompt 历史中。

## 5. Candidate 模式：在下注之前先竞争

当技术路线、架构方案或实现路径本身存在真实不确定性时，JYY-Code 不要求主 Agent 过早拍板，而是启动受控方案竞争。

1. **盲声明**：2–3 个候选独立提交 approach、assumptions、risks 和 differentiator。
2. **交叉评审**：候选先通过黑板逐一审视彼此方案，再进入执行阶段。
3. **独立提案**：每个候选在隔离环境中发展自己的路线。
4. **综合裁决**：主 Agent 生成 synthesis artifact，只选一个最终胜出方案，同时记录裁决理由和其他候选的有效贡献。

Candidate 模式把“架构不确定性”变成一个可审计的搜索过程，而不是藏在单个 Agent 内部的一次猜测。

## 6. 为长任务设计的上下文与记忆

JYY-Code 不把“完整聊天记录”直接等同于记忆，而是把短期工作上下文和长期知识分开治理。

- **工作上下文保持有界。** Full compaction、已完成工具输出的 micro-compaction、reactive emergency compaction，以及 media-aware token/context 估算共同限制长任务膨胀。
- **旧回合进入情景记忆。** 已完成回合会被记录，并周期性压缩成累积 digest；需要时可以重新注入或检索。
- **持久记忆按用途分离。** 当前任务状态、稳定用户事实和可复用经验分别保存，不塞进一个无限增长的自由文本摘要。
- **执行前后双阶段校准。** 用户输入阶段先更新“现在理解到了什么”；助手完成阶段再用实际执行结果修正状态，并抽取成功、失败与经验规则。
- **持久写入有明确所有权。** 主会话负责 Task/User Memory 的持久写入；子 Agent 可以读取相关上下文和经验，但不会并发改写共享长期记忆。
- **容量本身有治理机制。** 记忆条目具备 schema、importance、keywords、去重和确定性 compact，而不是无上限“全部记住”。

目标不是保存最多历史，而是**让长会话和新会话都能获得稳定的推理状态，同时避免旧噪音持续占据 Prompt**。

## 7. 用能力边界代替盲目信任

JYY-Code 会主动限制不同参与者能修改什么。

- 子 Agent 不能重写父 Plan。
- Task 输出路径被限制在指定工作区，并检查 traversal / escape 等越界情况。
- 标准子任务在显式 Merge 之前保持工作区隔离。
- 子 Agent 的工具权限与主 Agent 独立治理。
- 持久会话状态由特权运行时拥有；外部扩展可以通过公开端口消费事件，但不能直接向持久事件日志追加记录，也不能直接修改 Projection 表。

这些边界能显著缩小错误子 Agent 或错误工具调用的影响范围，也让编排状态更难被意外破坏。

## 快速开始

### 安装

普通用户只需要 Node.js 20+ 和 npm；从源码开发时才需要 Bun。

```bash
npm install -g jyycode-ai
cd /path/to/your/project
jyy
```

进入 JYY-Code 后运行 `/connect` 配置模型 Provider。

`jyy` 和 `jyycode` 是同一个 CLI。启动时所在的终端目录，就是 Agent 工作区。

### 配置

全局配置：`~/.config/jyycode/jyycode.jsonc`

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

项目级配置位于 `.jyycode/jyycode.jsonc`。核心扩展入口包括 `provider`、`permission`、`subagents`、`mcp`、`skills` 和 `plugin`。

## 架构速览

```text
packages/jyycode/    Agent Runtime、Plan、Session、Memory、Tool 与 TUI
packages/core/       文件系统、Provider 与共享运行时能力
packages/llm/        LLM 协议与 Runtime Adapter
packages/plugin/     Plugin SDK 与扩展接口
packages/sdk/        HTTP / OpenAPI Client SDK
packages/app/        Desktop Web UI
packages/desktop/    Tauri Desktop Shell 与 Sidecar 打包
packages/relay/      端到端加密 Mobile Relay
packages/mobile-web/ Mobile Web / PWA Client
.jyycode/            项目级 Agent、Skill、Command、Theme 与配置
```

基础技术栈：Bun + TypeScript、Effect Service Architecture、Drizzle ORM + SQLite（WAL）、Turbo Monorepo、oxlint。

深入架构文档：

- [Session EventV2 source of truth](docs/architecture/session-event-source.md)
- [Process runtime](docs/architecture/process-runtime.md)
- [Session storage operations](docs/operations/session-storage.md)
- [Plan workspace operations](docs/operations/plan-workspaces.md)
- [Testing and replay](docs/architecture/testing-and-replay.md)

## 从源码开发

```bash
git clone https://github.com/Reon-Jin/JYY-Code.git
cd JYY-Code
bun install
bun run dev
```

源码校验：

```bash
bun run check:ci && bun run verify:generated
```

## 下载

Windows 安装包、校验和与更新清单发布在 [GitHub Releases](https://github.com/Reon-Jin/JYY-Code/releases)。

## 隐私

JYY-Code 默认将应用数据保存在本地，只连接你明确配置或调用的服务。详见 [隐私政策](PRIVACY.md)。

## License

MIT © [JYYCode](https://github.com/Reon-Jin/JYY-Code)
