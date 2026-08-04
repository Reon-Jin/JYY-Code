---
name: efficiency
---

# 自定义子 Agent 与隔离技能实施计划

> **Execution note:** 按任务顺序执行；每个任务先补失败测试，再实现，再运行列出的验证，最后以建议的提交粒度提交。不得将用户已有的 Composer 改动直接覆盖，应仅移除其中与“子 Agent 配置”冲突的部分。

**目标：** 移除旧的预置角色体系，仅保留通用子 Agent（General）作为默认可派发角色；在右侧活动栏提供项目级子 Agent 配置。主 Agent 的 dispatch 工具必须显式选择启用角色。全局技能只属于主/单 Agent；每个子 Agent 只能发现和调用其私有目录中的技能。

**架构：** 角色配置保存在项目配置的 `subagents.profiles` 中；技能不再通过配置数组“认领”，而是由文件系统边界隔离。全局/内置技能目录仅对根会话可见，角色技能固定在 `%USERPROFILE%\\.jyycode\\role\\<role-id>\\skills\\<skill-name>\\SKILL.md`，并且只能被同一角色启动的子会话列举和读取。Dispatch 时持久化角色、模型和启动提示词快照，保证后续配置编辑不会改变已运行或已完成的任务。

**技术栈：** TypeScript、Effect 4、JYYCode 文件式 Plan 协议、生成式 OpenAPI TypeScript SDK、SolidJS、TanStack Solid Query、Lucide、Vitest/Bun。

---

## 已锁定的产品与安全边界

- 配置是**项目级**的：与当前 workspace 的配置一同保存；不同项目的角色、模型和启动提示互不影响。
- `general` 是唯一的内置子 Agent，默认启用，角色描述为通用委派执行，出厂时没有任何专属技能。它可以被编辑、禁用，并且之后可通过其目录添加用户自定义技能；不再保留 `explore` 或其他旧角色。
- 角色固定字段：稳定 `id`、可编辑 `name`、`description`、仅首轮发送的 `prompt`、十选一 `avatar`、可选 `model`/`variant`、`enabled`。**配置结构中没有 `skills` 字段。**
- 主/单 Agent 的全局技能（包括内置 `customize-jyycode` 和 `C:\\Users\\35027\\.jyycode\\skills`）只能供根会话的 primary/all Agent 使用。任何子会话都不能看到或猜测调用它们；此限制不能仅依赖模型提示或 UI 隐藏。
- 子 Agent 的技能只能来自自己的物理目录：`C:\\Users\\35027\\.jyycode\\role\\<role-id>\\skills\\<skill-name>\\SKILL.md`。用户手动放入符合 frontmatter 的目录即可被发现；右侧栏也能以“技能名称 + SKILL.md Markdown 正文”创建同样的文件。一个角色目录中的技能不会暴露给主 Agent、General（除非它就是 `general` 目录）、其他角色或其他子会话。
- 同名技能可以存在于不同角色目录；解析以当前角色作用域为准，不能再使用一个全局 `Record<name, Skill>` 作为唯一身份索引。内部需使用带 role ID 的稳定键，而工具对当前角色仍显示简洁本地技能名。
- Dispatch 的 `role` 为必填参数。根 Agent 的系统提示/工具描述仅以紧凑清单呈现当前启用角色的 ID、名称和描述，并指示无专长匹配时选择 `general`。
- 角色模型、思考深度、启动提示词在派发时冻结。`prompt` 绝不写入 `Agent.Info.prompt`（该字段会在每轮 LLM 请求重复）；它只作为第一条 child launch brief 的一段发送一次。
- 旧角色的运行时源、公共文档、当前测试和 UI 映射会删除；`docs/done/**` 保留为历史记录。原 `packages/jyycode/src/agent-cluster/role-skills/**` 是旧资产，不是新的用户目录，应移除。
- 不增加数据库表或迁移。角色技能是用户本机配置资产，不进入仓库；只由运行时扫描和 API 创建/读取。

## 配置与存储契约

```ts
type SubagentAvatar = "bot" | "search" | "code" | "bug" | "chart" | "file" | "image" | "folder" | "pen" | "sparkles"

type SubagentProfile = {
  id: string // 稳定 dispatch role，例如 general、role_01j...
  name: string // 可编辑显示名
  description: string // 给主 Agent 选择角色时使用的短描述
  prompt: string // 仅子会话启动首轮使用
  avatar: SubagentAvatar
  model?: string // 缺省表示继承根会话模型
  variant?: string // 思考深度 / 模型 variant
  enabled: boolean
}

type SubagentProfileView = SubagentProfile & {
  skills: RoleSkillInfo[] // 运行时扫描结果，响应字段而非配置字段
}
```

存储树：

```text
%USERPROFILE%\.jyycode\
  skills\<skill-name>\SKILL.md                 # 仅主/单 Agent（含内置 customize-jyycode）
  role\<role-id>\skills\<skill-name>\SKILL.md # 仅该角色的子会话
```

普通角色配置省略时规范化为一个启用且技能列表为空的 `general`。验证拒绝重复 ID、大小写折叠后重复名称、非法头像、空必填显示字段以及缺少 `general`；角色技能创建还拒绝不安全的 role ID/skill 名称、目录穿越、重复同角色技能和 frontmatter 名称不匹配。

## Task 1：建立角色配置模型并清理旧角色配置

**文件：**

- Create: `packages/jyycode/src/agent/subagent-profile.ts`
- Create: `packages/jyycode/test/agent/subagent-profile.test.ts`
- Modify: `packages/jyycode/src/config/config.ts`
- Modify: `packages/jyycode/test/agent/agent.test.ts`

1. 先写失败测试：默认值仅为 General；自定义角色可通过；重复 ID/名称、非法头像、缺少 General 被拒绝；遗留的 `agent.explore` 与旧角色键会被移除，而非相关用户 Agent 保留。
2. 运行 `bun test packages/jyycode/test/agent/subagent-profile.test.ts`，确认因为模块不存在而失败。
3. 实现 avatar/profile schema、`defaultGeneralProfile`、`resolveProfiles`、`enabledProfiles`、`profileByID`、`profileAgentName` 和旧角色键清理。向 `Config.Info` 加入 `subagents?: { profiles?: SubagentProfile[] }`；不添加 `skills` 配置字段。
4. 运行 `bun test packages/jyycode/test/agent/subagent-profile.test.ts packages/jyycode/test/agent/agent.test.ts`，预期通过。
5. 提交：`feat(agent): add configurable subagent profile schema`。

## Task 2：只 materialize General 与启用的自定义角色

**文件：**

- Modify: `packages/jyycode/src/agent/agent.ts`
- Modify: `packages/jyycode/test/agent/agent.test.ts`
- Modify: `packages/jyycode/test/agent/plan-mode-subagent-bypass.test.ts`
- Delete: `packages/jyycode/src/agent/prompt/explore.txt`

1. 先写失败测试：原生列表包含通用 `general`，不含 `explore`/旧角色；启用的 profile 生成 `mode: "subagent"` Agent 并记录 `options.subagentProfileID`；禁用 profile 不可派发；General 初始没有可用技能。
2. 运行对应 agent 测试，确认仍有 explore 与原先宽松技能可见性时失败。
3. 在 `Agent.layer` 移除 Explore/其他旧角色。对每个启用 profile（包括 general）生成/规范化子 Agent：携带显示描述与 role ID，但不将模型或启动提示词放入 `Agent.Info`。权限仅允许 `skill` 工具在需要角色技能时运行，**实际技能集合完全由 Task 3 的作用域服务裁决**；保留现有 parent-session deny ceiling。
4. 运行 `bun test packages/jyycode/test/agent/agent.test.ts packages/jyycode/test/agent/plan-mode-subagent-bypass.test.ts`。
5. 提交：`refactor(agent): materialize enabled subagent profiles`。

## Task 3：实现按根/子会话强制隔离的技能发现与加载

**文件：**

- Modify: `packages/jyycode/src/skill/index.ts`
- Create: `packages/jyycode/src/skill/role-management.ts`
- Modify: `packages/jyycode/src/skill/management.ts`（抽取可复用的安全名、frontmatter、原子写入和 containment helper）
- Modify: `packages/jyycode/src/tool/registry.ts`
- Modify: `packages/jyycode/src/tool/skill.ts`
- Modify: `packages/jyycode/src/session/system.ts`
- Modify: 传递工具上下文的 session 工厂（定位实际 `Tool.Context` 创建点）
- Create: `packages/jyycode/test/skill/role-scope.test.ts`
- Create: `packages/jyycode/test/skill/role-management.test.ts`

1. 写失败的安全测试，创建全局 skill、内置 `customize-jyycode`、`role/review/skills/pdf/SKILL.md` 和 `role/general/skills/check/SKILL.md`。断言：根 primary 仅可见全局/内置，review child 仅可见 pdf，general child 仅可见 check；其他 child 和所有 child 均看不到全局/`customize-jyycode`。尝试通过猜测名称调用 `skill` 也必须失败。
2. 运行 `bun test packages/jyycode/test/skill/role-scope.test.ts`，确认旧的全局 catalog 会泄露。
3. 将 skill 身份拆为 `id`（内部唯一，例如 `global:pdf`、`role:review:pdf`）和对调用者显示的本地 `name`。将扫描分层：根 catalog 扫描既有全局/项目/路径/URL 与内置技能；role catalog 只扫描 `%USERPROFILE%/.jyycode/role/<roleID>/skills/**/SKILL.md`。不得把 role 根混进全局扫描。
4. 把当前 session 是否 child、role ID 写入一个明确的 `SkillAccessScope`，并由 Tool Registry 描述、Session system prompt 和 `SkillTool.execute` 共用同一个 `available/requireAvailable(scope, name)` 入口。父会话身份优先于 Agent 名称：即使意外以 primary Agent 名称创建 child session，仍不得获得全局 skill。`customize-jyycode` 自然属于 root catalog，因此对子 Agent 不可见也不可执行。
5. 实现 `RoleSkillManagement`：创建时将内容规范化/验证后原子写入 `<roleRoot>/<roleID>/skills/<safe-name>/SKILL.md`，对 real path 做 containment 校验；列出时返回用户手动复制的有效目录。保留现有 `SkillManagement` 仅处理全局主 Agent skills。
6. 运行 `bun test packages/jyycode/test/skill/role-scope.test.ts packages/jyycode/test/skill/role-management.test.ts packages/jyycode/test/tool/registry.test.ts`。
7. 提交：`feat(skill): isolate global and role skill catalogs`。

## Task 4：为角色和角色技能增加实例 API，并生成 SDK

**文件：**

- Modify: `packages/jyycode/src/server/routes/instance/httpapi/groups/instance.ts`
- Modify: `packages/jyycode/src/server/routes/instance/httpapi/handlers/instance.ts`
- Modify: `packages/jyycode/src/server/routes/instance/httpapi/server.ts`（注入 role skill service）
- Modify: `packages/jyycode/test/server/httpapi-exercise/index.ts`
- Modify: `packages/jyycode/test/server/httpapi-instance.test.ts`
- Regenerate: `packages/sdk/openapi.json`
- Regenerate: `packages/sdk/js/src/v2/gen/**`

1. 先写失败的 HTTP 测试：`GET /subagents` 返回规范化 profile 和每个角色实际扫描到的 skills；`PUT /subagents` 原子替换 profile 配置；`POST /subagents/:roleID/skills` 接收安全的 `{ name, content }` 并产生 canonical `SKILL.md`。还要覆盖手动添加目录后 GET 可见、未知角色/穿越名/重复目录被拒绝。
2. 运行 `bun test packages/jyycode/test/server/httpapi-instance.test.ts && bun run --cwd packages/jyycode test:httpapi`，预期缺路由而失败。
3. 实现上述 endpoint 和明确的 OpenAPI operation IDs（`subagents.list`、`subagents.update`、`subagents.skillCreate`）。配置改动或写入角色技能后标记 instance disposal，确保下次请求重建 Agent/Skill cache；不可暴露全局 skill 管理 API 给该面板。
4. 运行 `bun run --cwd packages/sdk/js build`，只通过生成器更新 OpenAPI/SDK。
5. 重跑 HTTP/SDK 测试，预期通过。
6. 提交：`feat(api): manage subagent profiles and private skills`。

## Task 5：让 Dispatch 必选角色并保存角色快照

**文件：**

- Modify: `packages/jyycode/src/plan/schema.ts`
- Modify: `packages/jyycode/src/plan/protocol.ts`
- Modify: `packages/jyycode/src/plan/snapshot.ts`
- Modify: `packages/jyycode/src/plan/tools.ts`
- Modify: `packages/jyycode/src/plan/prompts.ts`
- Modify: `packages/jyycode/src/session/prompt.ts`
- Modify: `packages/jyycode/src/server/routes/instance/httpapi/groups/session.ts`
- Modify: `packages/jyycode/test/plan/protocol.test.ts`
- Modify: `packages/jyycode/test/plan/tools.test.ts`
- Modify: `packages/jyycode/test/plan/model-tool-name.test.ts`

1. 写失败测试：`Dispatch_dispatch({ taskIds, role })` 缺 role、未知 role、禁用 role 都失败；成功会存储 `{ id, name, avatar, description }` 快照；重试可选新角色；工具描述与根系统提示只列启用 profile，且含 General fallback。
2. 运行三个 Plan focused suite，确认当前硬编码 `build` 和仅 taskIds 的契约失败。
3. 注入 profile resolver，只允许启用角色；将 resolved profile 传入 child factory，并将其快照投影到 API/Plan snapshot。角色后续改名、禁用或换头像都不能改变历史 task 展示。
4. 运行 `bun test packages/jyycode/test/plan/protocol.test.ts packages/jyycode/test/plan/tools.test.ts packages/jyycode/test/plan/model-tool-name.test.ts`。
5. 提交：`feat(plan): dispatch tasks to named subagent roles`。

## Task 6：冻结子会话模型，并只在启动时发送角色 prompt

**文件：**

- Modify: `packages/jyycode/src/plan/protocol.ts`
- Modify: `packages/jyycode/src/plan/tools.ts`
- Modify: `packages/jyycode/src/session/prompt.ts`（仅在模型优先级测试要求时）
- Modify: `packages/jyycode/test/plan/tools.test.ts`
- Modify: `packages/jyycode/test/session/prompt.test.ts`

1. 写失败测试：child session 使用 `profileAgentName(role.id)` 与 profile model 或根模型 fallback；第一次 `ops.prompt()` 同时含 task brief 和 `## Role instructions (launch only)`，wake/审阅的后续轮次不再重复；后续编辑 profile model/prompt 不影响运行 child。
2. 实现派发时的 model/variant/role snapshot，并仅在这一次 child `ops.prompt()` 中追加非空角色 prompt；不要使用 `Agent.Info.prompt`。
3. 运行 `bun test packages/jyycode/test/plan/tools.test.ts packages/jyycode/test/session/prompt.test.ts`。
4. 提交：`feat(plan): launch children from immutable role snapshots`。

## Task 7：在右侧活动栏建立“子 Agent”配置 pane

**文件：**

- Create: `packages/app/src/features/subagents/subagent-avatar-catalog.tsx`
- Create: `packages/app/src/features/subagents/subagent-profiles-query.ts`
- Create: `packages/app/src/features/subagents/subagent-profiles-panel.tsx`
- Create: `packages/app/src/features/subagents/subagent-profiles-panel.css`
- Create: `packages/app/src/features/subagents/subagent-profiles-panel.test.tsx`
- Modify: `packages/app/src/features/workspace-inspector/inspector-preferences.ts`
- Modify: `packages/app/src/features/workspace-inspector/workspace-inspector.tsx`
- Modify: `packages/app/src/features/workspace-inspector/workspace-inspector.css`
- Modify: `packages/app/src/features/workspace-inspector/workspace-inspector.test.tsx`
- Modify: `packages/app/src/data/query-keys.ts`
- Modify: `packages/app/src/i18n/messages.ts`

1. 先写失败测试：新增 `subagents` pane 可通过键盘打开、关闭、持久化，遵循现有 drawer 的窄屏 Escape/scrim 行为；profile editor 能新建/编辑名称、描述、launch-only prompt、十种头像、模型、思考深度、启用状态；角色技能列表能显示手动目录并能从名称 + Markdown 创建。
2. 使用生成的 `subagents` SDK endpoints 建 query/mutations，而非从 `app.agents` 或 `app.skills` 猜 profile。创建成功后刷新角色视图以显示新文件。
3. 实现十项稳定图标 ID：`bot`、`search`、`code`、`bug`、`chart`、`file`、`image`、`folder`、`pen`、`sparkles`。只保存 ID，客户端映射 Lucide 与可访问标签。
4. 将 `Bot`/`Users` 活动图标放在 Plan 后。pane 内容包括启用/总数、New subagent、可选 role cards、编辑表单；技能区域显示仅本角色的 skills 与“新建专属技能”，其表单为安全名称输入和 `SKILL.md` Markdown 文本域。明确展示存放目录以及“手动放入后刷新即可发现”的提示。
5. 使用既有语义色彩、抽屉间距、焦点环和表单风格；在 `prefers-reduced-motion: no-preference` 下加入卡片进入/悬浮、启用状态点的轻量动画。
6. 运行 `bun run --cwd packages/app test -- src/features/workspace-inspector/workspace-inspector.test.tsx src/features/subagents/subagent-profiles-panel.test.tsx`。
7. 提交：`feat(desktop): configure subagents and private skills in rail`。

## Task 8：以右侧栏为唯一配置入口，清理 Composer 的子 Agent UI

**文件：**

- Modify: `packages/app/src/layout/workspace-layout.tsx`
- Modify: `packages/app/src/features/composer/model-catalog.ts`
- Modify: `packages/app/src/features/composer/model-catalog.test.ts`
- Modify: `packages/app/src/features/composer/model-control.tsx`
- Modify: `packages/app/src/features/composer/composer.tsx`
- Modify: `packages/app/src/features/composer/composer.css`
- Modify: `packages/app/src/features/composer/composer.test.tsx`
- Modify: `packages/app/src/app.integration.test.tsx`
- Modify: `packages/app/src/accessibility.test.tsx`
- Modify: `packages/app/src/i18n/messages.ts`

1. 添加回归测试：顶部 Composer 仅可选择当前主 Agent/模型，绝不显示 Sub-agent model、thinking depth 或写入 `config.agent.build` 的 mutation；右栏保存会刷新 profile、model/agent catalog 和打开的 Plan。
2. 运行 Composer/layout/integration/accessibility tests，先让当前未提交的双 profile Composer 实现暴露失败。
3. 保留与主模型选择相关且不冲突的改进，移除 `AgentModelProfile`、`subAgent`、`selectedSubAgentModel`、`changeSubAgentModel`、`onSubAgentModelChange`、相关翻译/样式/测试，以及直接写 `config.agent.build` 的路径。由 WorkspaceLayout 挂载新的 pane。
4. 运行 `bun run --cwd packages/app test -- src/features/composer/model-catalog.test.ts src/features/composer/composer.test.tsx src/layout/workspace-layout.test.tsx src/app.integration.test.tsx src/accessibility.test.tsx`。
5. 提交：`refactor(desktop): move subagent settings out of composer`。

## Task 9：Plan UI 从快照显示派发角色，删除旧 UI role map

**文件：**

- Create: `packages/app/src/features/plan/plan-role-presentation.ts`
- Modify: `packages/app/src/features/plan/plan-state.ts`
- Modify: `packages/app/src/features/plan/plan-state.test.ts`
- Modify: `packages/app/src/features/multi-agent/multi-agent-panel.tsx`
- Modify: `packages/app/src/features/multi-agent/multi-agent.css`
- Modify: `packages/app/src/features/plan/plan-panel.tsx`
- Delete: `packages/app/src/features/multi-agent/role-capabilities.ts`
- Modify: `packages/app/src/i18n/messages.ts`

1. 写失败测试：有 role snapshot 的 task 展示保存的名称/头像；未派发 task 为中性“未分配”，不伪造 general；后续 profile 编辑不改变历史显示。
2. 从 Plan snapshot 使用 Task 7 的共享 avatar catalog 渲染，移除旧 capability labels、默认 general 映射及相关样式。
3. 运行 `bun run --cwd packages/app test -- src/features/plan/plan-state.test.ts src/features/plan/plan-panel.test.tsx`。
4. 提交：`feat(plan-ui): show dispatched subagent profiles`。

## Task 10：更新内置配置技能、文档，并移除运行时旧资产

**文件：**

- Modify: `packages/jyycode/src/skill/prompt/customize-jyycode.md`
- Modify: `packages/jyycode/src/skill/index.ts`（必要时压缩内置 skill 的触发说明）
- Delete: `packages/jyycode/src/agent-cluster/role-skills/**`
- Delete: `docs/multi-agent-role-skills.md`
- Modify: `README.md`
- Modify: `README-zh.md`
- Modify: `packages/desktop/README.md`
- Modify: 当前受影响的测试/翻译

1. 先添加/更新测试，验证 `customize-jyycode` 出现在根 catalog、不出现在任何 child catalog，并且 active source/docs 中不再引用旧 role-skill 目录或旧预置角色。
2. 将 `customize-jyycode.md` 精炼为：右栏可管理项目级子 Agent 配置；角色字段和 launch-only prompt 语义；全局技能目录 `~/.jyycode/skills` 只给主/单 Agent；角色技能目录 `~/.jyycode/role/<role-id>/skills/<skill-name>/SKILL.md` 只给该角色；用户可手动放置或在右栏以名称+Markdown 创建；必要的 `SKILL.md` frontmatter。明确本内置 skill 本身也绝不暴露给子 Agent。
3. 删除旧 `agent-cluster/role-skills` 及可追踪缓存资产、旧映射和主动文档；保留 `docs/done/**` 历史。
4. 运行 `rg -n -i "researcher|analyst|writer|coder|picture[_-]?searcher|cluster-.*skill|role-capabilities|agent-cluster/role-skills" packages/jyycode/src packages/app/src README.md README-zh.md packages/desktop/README.md docs/multi-agent-role-skills.md`，预期没有 active matches（`rg` 退出 1）。
5. 提交：`refactor: remove legacy subagent role catalog`。

## Task 11：跨层回归、类型检查与人工验收

1. 运行后端 focused suites：

```bash
bun test packages/jyycode/test/agent/subagent-profile.test.ts packages/jyycode/test/agent/agent.test.ts packages/jyycode/test/agent/plan-mode-subagent-bypass.test.ts packages/jyycode/test/skill/role-scope.test.ts packages/jyycode/test/skill/role-management.test.ts packages/jyycode/test/plan/protocol.test.ts packages/jyycode/test/plan/tools.test.ts packages/jyycode/test/plan/model-tool-name.test.ts packages/jyycode/test/session/prompt.test.ts packages/jyycode/test/server/httpapi-instance.test.ts
bun run --cwd packages/jyycode test:httpapi
bun run --cwd packages/sdk/js build
```

2. 运行 Desktop tests/typecheck：

```bash
bun run --cwd packages/app test -- src/features/subagents src/features/workspace-inspector src/features/plan src/features/composer src/layout/workspace-layout.test.tsx src/app.integration.test.tsx src/accessibility.test.tsx
bun run --cwd packages/app typecheck
bun run --cwd packages/jyycode typecheck
```

3. 使用干净项目人工验收：
   - 右侧 Subagents icon/pane 在桌面和窄屏正确工作；General 初始无技能。
   - 创建角色、选择十种头像、设模型/深度、输入 launch prompt、开关 enabled 均可保存；disabled role 不在 dispatch roster 中。
   - 手动创建 `~/.jyycode/role/<role>/skills/<name>/SKILL.md` 后刷新出现；右栏创建的 role skill 正确落到相同目录。
   - 根 Agent 可看到 `~/.jyycode/skills` 和 `customize-jyycode`，任何子 Agent 均不可见；每个 child 仅看到自身 role skill，猜测名称也无法调用。
   - 多 Agent dispatch 必填 role，child 使用冻结模型、首轮仅一次角色 prompt，并在 Plan 中显示冻结后的头像/名称。
   - Composer 不含任何子 Agent 配置；减少动态效果偏好、焦点、Escape、对比度均无回归。
4. 运行 `git diff --check` 和 `git status --short`；只修复验证发现的真实问题。
5. 如有最终测试修正，提交：`test: cover configurable subagent profiles`。
