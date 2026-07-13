# Desktop Workspace Inspector、Git 与 GitHub 实施报告

日期：2026-07-14

实现分支：`codex/desktop-workspace-inspector-git-github-implementation`

计划基线：`codex/desktop-workspace-inspector-git-github` (`d77fef8`)

上游基线：`origin/main` (`67be078`)

软件版本：根包与 `packages/jyycode` 均为 `1.15.10`

## 1. 交付结论

本次实现完成了计划中的 Desktop 工作区检查器、实时 Todo、完整工作区 Changes、分支与远程 Git 操作，以及 GitHub Pull Request 全生命周期管理。Desktop 只通过生成 SDK 和 SSE 调用共享后端，未在前端或 Tauri 层直接执行 `git`、`gh`，也没有新增通用 shell 权限。

相对计划基线，本分支涉及 58 个源码/测试文件，当前统计为约 6,400 行新增。功能按独立提交拆分，最后一个提交补充端到端验证、Windows patch 边界修复和本报告。

## 2. 后端与 API

### 2.1 VCS

- 复用 `packages/jyycode/src/project/vcs.ts` 作为唯一 Git 业务入口。
- 支持本地与远程分支列表、创建、切换、远程跟踪、`fetch --all --prune` 和 push。
- push 选择顺序为 upstream、`origin`、唯一 remote；多个非 `origin` remote 时返回候选项让前端选择。
- 分支名使用 Git 自身规则校验；切换冲突保留用户改动并返回类型化原因。
- mutation 成功后发布 `Vcs.Event.BranchUpdated`，由 Desktop 精确更新分支缓存。
- 将默认 patch 上下文从 Git 的 32 位整数极限约束为 10,000,000 行，与 10 MB 输出预算一致，避免 Windows Git 在混合回车内容上生成畸形重复 hunk。

### 2.2 GitHub CLI 服务

- 共享后端负责调用用户已安装并登录的 `gh`，所有命令均使用 argv，不拼接 shell 字符串。
- 区分 `missing-gh`、`not-authenticated`、`not-github-repo`、`command-failed` 和 `invalid-response`。
- 只解析 stdout 的受控 JSON，不向前端暴露 token、认证 header、环境变量或完整进程上下文。
- checkout 成功后复用 `BranchUpdated` 事件，让 GitHub 与分支 UI 同步。

### 2.3 HTTP API

新增完整 workspace-scoped GitHub 路由：

```text
GET    /github/status
GET    /github/pulls
GET    /github/pulls/:number
GET    /github/pulls/:number/diff
POST   /github/pulls
PATCH  /github/pulls/:number
POST   /github/pulls/:number/comments
POST   /github/pulls/:number/checkout
POST   /github/pulls/:number/close
POST   /github/pulls/:number/reopen
POST   /github/pulls/:number/merge
```

输入边界校验 PR number、非空标题/正文/评论和 `merge | squash | rebase` 合并方式。领域错误在 handler 边界转换为稳定的公开 API 错误；GitHub 服务 Layer 在路由构造阶段注入一次。

### 2.4 生成 SDK

- 重新生成 `packages/sdk/js/src/v2/gen/sdk.gen.ts` 与 `types.gen.ts`。
- VCS 与 GitHub 客户端保留每次请求的 `directory` query。
- Desktop 对生成签名做薄封装，没有复制后端业务规则。

## 3. Desktop 数据流

### 3.1 Query 与 SSE

- 为 Todo、VCS、GitHub 状态、PR 列表、PR 详情和 PR diff 定义稳定 query key。
- Todo SSE 直接写入精确 session Todo 缓存，可实时显示 `pending -> in_progress -> completed`，兼容 `cancelled`。
- 文件变更事件合并后失效 Changes 与相关 GitHub 缓存，避免事件风暴产生重复请求。
- 分支事件立即更新当前 branch，并失效 branch list、Changes 和 PR 相关缓存。
- SSE 重连后统一失效工作区检查器缓存，恢复期间不展示过期状态。

### 3.2 Todo 与 Changes

- Todo 区域覆盖无 Session、加载、空、错误/重试和任务列表状态。
- Changes 固定调用 `/vcs/diff?mode=git`，展示整个工作区，而非单次 Session diff。
- unified diff 由安全的纯文本解析器渲染 hunk、上下文、增加和删除行；不注入 HTML。
- 文件列表显示状态、增删统计、折叠状态和独立滚动。

## 4. 工作区检查器

- 右侧检查器包含固定 Todo 与 Changes 两个纵向区域。
- 分隔条支持鼠标拖动、触摸和键盘调整，比例限制为 20%-80%。
- `{ open, todoRatio }` 按规范化后的项目目录写入 localStorage，默认比例 42%。
- 宽屏使用第三列；960 像素及以下使用窗口内右侧覆盖层。
- 折叠检查器不会卸载会话或清空 Composer 草稿。
- 切换按钮和分隔条具有明确 accessible name、展开状态和键盘焦点样式。

## 5. Branch 与远程 Git

- Branch 控件放在 Composer 的 Model 选择器之后。
- 显示当前 branch 或 `No Git`，弹窗按本地/远程分组并支持搜索。
- 支持创建并切换、本地切换、从 remote 建 tracking branch、fetch 和 push。
- 多 remote 歧义时显示选择器；冲突时解释原因，不自动 stash，不提供 force 操作。
- 操作成功后立即同步 branch、Changes 和 GitHub 数据；失败反馈保留在当前操作上下文。

## 6. GitHub Pull Request

- 可恢复地展示 `gh` 缺失、未认证、非 GitHub 仓库和命令失败状态。
- 支持 open/closed/all 列表和 PR 详情、checks、commits、comments。
- PR 正文按纯文本展示；PR diff 使用独立 query 和安全文本渲染。
- 支持创建、编辑标题/正文、评论、checkout、关闭、重新打开。
- 支持 merge、squash、rebase；合并前要求确认，并可选择删除分支。
- 修正编辑器条件渲染：未进入创建/编辑模式时不再挂载空的真值 `<Show>`，提交表单后能稳定回到详情。
- mutation 失败时保留当前 PR 与输入状态，便于重试。

## 7. 测试与验证

| 范围 | 结果 | 说明 |
| --- | --- | --- |
| Desktop 完整 Vitest | 36 files / 145 tests 全部通过 | 包含组件、查询、SSE、可访问性和应用集成 |
| 工作区 Git/PR 旅程 | 2/2 通过 | 覆盖 Changes、比例、branch、fetch/push、PR 创建到合并 |
| Accessibility | 3/3 通过 | 覆盖主要页面和对话框 |
| VCS 完整测试 | 24/24 通过 | 包含真实临时 Git 仓库和 Windows CR patch 回归 |
| GitHub 服务测试 | 9/9 通过 | 使用可替换进程，不访问真实网络 |
| 后端目标集合 | 61/63 通过 | 新增 VCS/GitHub/API 均通过；2 个基线 prompt 测试失败，见下节 |
| `packages/app` typecheck | 通过 | `tsc --noEmit` |
| `packages/jyycode` typecheck | 通过 | `tsgo --noEmit` |
| `packages/sdk/js` typecheck | 通过 | `tsgo --noEmit` |
| `packages/desktop` typecheck/test | 通过 | 2 个 sidecar 暂存测试通过 |
| Vite production build | 通过 | 2179 modules；主 workspace chunk 484.57 kB，gzip 145.55 kB |
| Tauri NSIS build | 通过 | Rust release、sidecar、桌面 exe 和 NSIS 安装器全部生成 |
| 原生窗口视觉 QA | 通过 | 1366x768 三栏、960x640 覆盖层；150% DPI 下无空白、遮挡或裁切 |

端到端旅程还验证：

- Composer 草稿在打开/关闭检查器和 GitHub 不可用状态下保持不变。
- Todo 的 SSE 单项集成测试无需重新挂载即可完成状态迁移。
- fake SSE controller 在取消时移出活动集合，避免向已关闭流 enqueue。
- 路由 lazy remount 测试等待当前 DOM 达到一致状态，避免断言旧节点。

## 8. 已知非本次回归

以下两个 `packages/jyycode/test/server/httpapi-sdk.test.ts` 用例仍失败，并已在未应用本分支改动的基线工作树复现：

1. `matches generated SDK prompt streaming through fake LLM`：`prompt.data` 为 `undefined`，测试在 `JSON.stringify(...).includes` 处抛错。
2. `includes project skills in REST API prompt context`：prompt endpoint 返回 500，期望 200。

它们属于既有 prompt/fake LLM 测试路径，与本次 VCS、GitHub、Desktop 查询及 UI 变更无文件交集。其余目标测试为 61 个通过。

## 9. 打包边界

- Tauri capability 保持最小权限：`core:default`、dialog open 和 store load/get/set/save；没有通用 shell capability。
- `externalBin` 指向 `jyycode-sidecar`，后端仅监听 `127.0.0.1` 随机端口，并通过随机密码启动。
- 仓库默认 sidecar 构建脚本包含安全规则禁止的 `rm -rf`，因此未执行该路径。
- 本次从主检出目录复用已存在且 `--version` 验证为 `1.15.10` 的 Windows x64 binary，使用 `stage-sidecar.ts --skip-build` 做单文件暂存；二进制与 `target` 均被 Git 忽略，不进入提交。
- 同时构建 NSIS 与 MSI 时，NSIS 已成功生成后 CLI 在 MSI/WiX 阶段长时间无输出；显式 `--bundles nsis` 在 136.2 秒内成功退出。可用安装器位于构建工作树的 `packages/desktop/src-tauri/target/release/bundle/nsis/JYYCode_0.1.0_x64-setup.exe`。

## 10. 提交结构

```text
4ea3827 feat(api): expose github pull request management
6057efd chore(sdk): generate vcs and github clients
386e98b feat(desktop): add workspace inspector data flow
698c937 feat(desktop): show realtime todo progress
7414d80 feat(desktop): render workspace code changes
3f8f1bd feat(desktop): add resizable workspace inspector
8b7ceb1 feat(desktop): add branch and remote controls
7eb513f feat(desktop): browse github pull requests
269b61c feat(desktop): edit and checkout pull requests
5a9c519 feat(desktop): manage pull request lifecycle
```

本分支仅提交到本地，未 push 到 GitHub。
