# jyycode（TUI）

JYYCode 终端 UI 与本地后端。与 Desktop（`packages/desktop` + `packages/app`）共享同一后端：同一 SQLite（session / message / plan）、同一 HTTP API、同一 SSE 事件流、同一生成 SDK（`@jyycode-ai/sdk/v2`）。

- 本地模式（`jyy` / `jyy tui`）：由 Bun `Worker`（`src/cli/cmd/tui/worker.ts`）内嵌同一 `Server`，UI 经 RPC fetch 代理走 SDK。
- 附加模式（`jyy attach <url>`）：真实 HTTP + SSE 连接任意运行中的后端。
- 因此 TUI 与 Desktop 在同一目录下**互见同一 session/message/plan**，改动由共享后端做权威合并。

## 与 Desktop 功能对照

| Desktop 能力（`packages/app`） | TUI 入口（命令 / 键位 / 路由） |
|---|---|
| 会话核心（composer / 工具 / 权限条 / 提问面板 / 会话列表 / timeline / fork / share / export / retry） | 会话视图（`/session`）、`session.list`、`session.rename`、`session.timeline` 等命令 |
| Home 项目管理（recent / open dir / create / remove） | Home 提示页 + `workspace` 命令（workspace/worktree 管理） |
| Global MCP 管理（add/edit/enable/disable/delete、OAuth、移除凭据） | `/mcp` 路由（`mcp` 命令；`c` 连接/断开、`a` 新增、Enter 操作菜单） |
| Skills 管理（list/detail/create/edit/delete/sources） | `/skills` 路由（`skills` 命令；Enter 详情、`e` 外部编辑器编辑、`a` 新建） |
| Memory 管理（User/Task/Experience：search/edit/delete/compact/export） | `/memory` 路由（`memory` 命令；Tab 切 scope、`/` 搜索、`c` 压缩、`x` 导出） |
| Settings（默认权限策略、默认 Shell、压缩阈值、配置路径、语言） | `/settings` 路由（`settings` 命令；Enter 编辑、`r` 重置压缩） |
| Plan 抽屉（goal/steps/tasks/status） | `/plan` 路由（`plan` 命令；会话内打开，SSE 实时刷新） |
| Blackboard 面板（read/post/未读） | `/blackboard` 路由（`blackboard` 命令；`p` 发布） |
| Subagent profiles 编辑 | `/subagents` 路由（`subagents` 命令；`e` 编辑 prompt、`a` 新建） |
| Changes 面板（per-file unified diff + apply/revert） | `/diff` 路由（`changes` / `diff` 命令；`git` 模式为工作区改动） |
| Git 分支控制（list/create/switch + dirty 守卫） | `/branches` 路由（`branches` 命令；Enter 切换、`b` 新建） |
| 文件树 / 预览 / 搜索 | `/files` 路由（`files` 命令；Enter 进入/预览、`/` 搜索、`y` 复制路径） |
| Workspace inspector / 项目管理 | `/workspaces` 路由（`workspaces` 命令；Enter 操作） |
| OS 通知 / 音效 | `attention.notify` + toast（终端语境等价物） |
| 自动更新 | 启动时检查 `installation.update-available` + `global.upgrade` |

所有新面板仅调用既有 HTTP API（`@jyycode-ai/sdk/v2`），零后端改动。

## 主题

- 默认主题为 `paper`，与 Desktop 的 paper 配色逐值一致（单一 token 源 `@jyycode-ai/design-tokens`，`src/cli/cmd/tui/context/theme/paper.json` 由 `script/generate-paper-theme.ts` 生成）。
- Desktop `tokens.css` 颜色块同样由该 token 源生成（`packages/design-tokens/script/generate.ts`），并受防漂移测试保护。
- 内置主题列表含 30+ 主题，`/themes` 可切换。

## 开发

```bash
bun run --cwd packages/jyycode test:file test/cli/tui/<file>.test.ts   # 单文件测试
bun run --cwd packages/jyycode typecheck                                # 类型检查
bun run --cwd packages/jyycode script/generate-paper-theme.ts           # 重新生成 paper 主题
```
