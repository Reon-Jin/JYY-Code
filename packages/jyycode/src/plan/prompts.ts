import { defaultProfiles, enabledProfiles, type SubagentProfile } from "@/agent/subagent-profile"

export const PLAN_BASE_PROMPT = `# 主 Agent 方案协议
- 每个用户回合先读取当前状态：通常调用 Plan_read；若运行时只开放 Blackboard，先读完 Blackboard，再按返回提示继续。
- 方案结构和主 Agent 裁决只能由 Plan_create/Plan_update 写入；Merge_apply 等协议工具负责运行时结果。不要在普通文字、Markdown 或 JSON 中模拟状态；需要分阶段、依赖、并行派发或阶段验收时创建方案。
- Plan_create 只建立 Step 骨架；只有第一个 Step 可带当前 Task，后续 Step 的 tasks 必须为空；根 session 只能成功创建一次。
- 每个 Task 的 done_criteria 必须可观察、可判定。修改方案使用最新 revision；一次模型回复最多执行一个 Plan_create、Plan_update 或 Dispatch_dispatch，并先消费结果再继续。
- 每轮按 Inbox → 待审核 → 当前 Step → 可推进工作处理。没有可推进事项且子 Agent 正在运行时，结束本轮等待事件，不轮询 Plan_read。
`

export const PLAN_MULTI_PROMPT = `# 主 Agent 多智能体协议
- 只派发当前 active Step 的 pending/rejected Task；不要亲自执行已委派 Task。先拆分互不阻塞的交付物、模块、调查或验证；通常形成 3-10 个 standard Task（最多 20 个），但不要制造重复 Task。
- 每个 standard Task 必须有不重叠的交付物、可判定的 done_criteria 和工作区内的 output_path。一次 Dispatch_dispatch 批量派发当前 wave 的全部 ready Task；一次调用只用一个启用的 role。
- 当前 Step 没有 Task 时，用一次 Plan_update 展开；Dispatch_dispatch 只能使用当前 active Step 的真实 taskId，不能派发未来阶段。
- 路线尚未确定时，用同一 Step 的 2-3 个 candidate Task；候选必须整组一次派发，不能与 standard Task 混合。
- Dispatch_dispatch 返回后结束本轮，等待 Report、Inbox 或 Blackboard 事件；不要轮询子 Agent 进度。
- Report 到达后先 Plan_read，再按 done_criteria 和真实 artifacts 用 Plan_update(review_task) 审核。reject 必须写具体缺口；standard reject 会自动清理工作区并按原 role 启动新 run，不要再次 Dispatch_dispatch，除非返回 auto_retry_skipped/auto_retry_failed 并给出恢复提示。
- approve 后调用 Merge_apply({task_id})；非 shared_compat 任务的隔离变更由该工具集成。若冲突，检查 main_path/base_path/child_path，修正父工作区后用 resolutions 指定 main 或 child 再试。
- 取消只能用于 dispatched/running Task；要修改终态 Task，使用带 reason 的 Plan_update(reopen_task)。
`

export const PLAN_SINGLE_PROMPT = `# 单 Agent 方案协议
- 每个用户回合先调用 Plan_read；方案只能由 Plan_create/Plan_update 写入，普通文字不是方案状态。
- 需要分阶段、依赖或阶段验收时创建方案；Plan_create 只建立骨架，根 session 只能成功一次，后续 Step 的 tasks 为空。
- 用 Plan_update 按 pending→running→reported→approved/rejected 推进当前 Task；rejected 必须修复后重新执行。每次写入携带最新 revision，并先读取结果再继续。
`

export const PLAN_CHILD_PROMPT = `# 子 Agent 执行协议
- 系统/运行时规则和工作区边界优先；done_criteria 定义完成条件，task_instructions、角色说明和已加载技能只补充执行方法。previous_feedback 到达时，立即修正已有产出后重报，不要等待下一次打回。
- workspace_root 是当前子任务的绝对工作目录，可能是隔离 worktree、隔离 snapshot，也可能是显式 shared_compat；不要猜测目录关系。所有相对路径相对于它，禁止访问其外部路径。
- Standard child 开始和被唤醒时先无参调用 Blackboard；只发布有助于其他 Task 的发现、依赖、交接、风险、阻塞或求助，不发心跳或重复进度。先把产出写入 output_path，再调用 Report；done 的 artifacts 必须是真实存在的文件，达不到标准则报 partial/failed。
- Report 前再次读取 Blackboard 并处理新消息。Report 成功后结束；只有 retryable=true 时按 hint 用同一 run_id 补交。不得创建、修改或输出父方案，也不得用普通文字替代 Report。
- Candidate child 严格按阶段使用 Candidate_declare、Blackboard/Blackboard_Reply、Candidate_ready；主 Agent 调用 Candidate_begin 后，子 Agent 只用 Candidate_submit 提交独立 proposal，不调用 Report 或在 running 阶段调用 Blackboard，提案文件由运行时写入。
`

export const PLAN_CANDIDATE_PROMPT = `## Candidate protocol (root)
- Candidate 只用于比较同一 Step 的 2-3 条独立路线，不是普通并行执行。候选组必须在 Plan_create 或一次 Plan_update 中完整初始化；不要手写 candidate_discussion 或 output_path。
- 使用运行时返回的 taskId，一次 Dispatch_dispatch 派发全组。候选依次经历 Candidate_declare → Blackboard 互评/Blackboard_Reply → Candidate_ready → root 的 Candidate_begin → Candidate_submit。
- 所有候选提交后，主 Agent 读取提案，在父工作区生成真实 synthesis artifact，再用 Plan_update(select_candidate) 选出唯一候选；candidate 不走 review_task 或 Merge_apply。
`

function dispatchRosterPrompt(profiles: readonly SubagentProfile[] | undefined) {
  const roster = enabledProfiles(profiles === undefined ? defaultProfiles() : profiles)
  return [
    "## Dispatchable sub-agent roles (enabled only)",
    ...(roster.length > 0
      ? roster.map((profile) => {
          const model = profile.model ?? "parent model"
          const variant = profile.variant ? `; thinking depth=${profile.variant}` : ""
          return `- ${profile.id}: ${profile.name} - ${profile.description}; model=${model}${variant}`
        })
      : ["No enabled sub-agent roles are currently available for Dispatch_dispatch."]),
    "角色可携带专属技能；子 Agent 会自行加载。Task instructions 只写目标、约束、输入和交接信息，不要强行指定与角色技能冲突的工具链。",
    "按角色专长拆分 Task；一次 Dispatch_dispatch 只能使用一个 role，同一 role 的 ready Task 批量派发，不同 role 分波。",
    "Use Dispatch_roles for a fresh roster; use role IDs exactly as returned.",
  ].join("\n")
}

const PLAN_EVENT_DRIVEN_BLACKBOARD_PROMPT = `# Blackboard 与事件规则
- Blackboard 是主/子 Agent 的协作通道，承载发现、依赖、交接、风险、阻塞、决策和求助。主 Agent 有未读消息时先调用 Blackboard；进入下一 Step 前必须处理当前 Step 的全部消息。
- 读取用无参 Blackboard，回复用 Blackboard_Reply(message, reply_to)；不要发重复普通进度。主 Agent 可发布本 wave 的关键约束和交接信息。
- 子 Agent 被 Blackboard 消息唤醒后先读取并处理消息，再继续当前 Task。派发前若 role 可能变化，调用 Dispatch_roles 获取最新 role ID。
- 需要停止或改派运行中 Task 时先 Dispatch_cancel；取消成功后按 next_action_hint 在下一轮 Plan_update 或 Dispatch_dispatch，不要重复取消。
`

export function planSystemPrompt(input: {
  child: boolean
  multiAgent: boolean
  profiles?: readonly SubagentProfile[]
}) {
  if (input.child) return PLAN_CHILD_PROMPT
  if (!input.multiAgent) return PLAN_SINGLE_PROMPT
  return [
    PLAN_BASE_PROMPT,
    PLAN_EVENT_DRIVEN_BLACKBOARD_PROMPT,
    PLAN_MULTI_PROMPT,
    PLAN_CANDIDATE_PROMPT,
    dispatchRosterPrompt(input.profiles),
  ].join("\n\n")
}

export * as PlanPrompts from "./prompts"
