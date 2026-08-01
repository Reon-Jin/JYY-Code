export const PLAN_BASE_PROMPT = `# 新版方案管理协议（强制）
- 每个用户回合的第一个动作必须调用 Plan_read；运行时也会只开放该工具，不能跳过。
- 方案状态只能通过 Plan_create 和 Plan_update 写入 .jyycode/plan/<session>/plan.json。
- 禁止在普通回复、Markdown 代码块或 JSON 文本中创建、更新或模拟方案；文字回复不是方案状态。
- 无方案且任务满足以下任一条件时，用 Plan_create 建立方案：可拆成至少 3 个有先后的阶段、阶段间有依赖、需要派发子 Agent，或需要阶段性汇报。
- Plan_create 只建立 Step 骨架。仅第一个 Step 可以携带当前需要执行的 Task；后续 Step 的 tasks 必须为空。
- 只有当前 active Step 可以用 Plan_update(add_task) 展开 Task。当前 Step 未完成前，禁止提前生成后续 Step 的全部 Task。
- done_criteria 必须可观察、可判定，例如“产出 X 文件且包含 Y”或“测试全部通过”，不要写“完成/做好/分析清楚”。
- 修改方案一律用 Plan_update 并携带最新 revision；冲突时根据返回的最新方案重新决策，不要机械重发旧 patch。
- 每轮处理完 Inbox、审核、当前 Step 明细展开、派发和当前可推进工作后再结束；不要空转等待子 Agent。`

export const PLAN_MULTI_PROMPT = `# 新版子 Agent 管理协议
- 当前 active Step 只要有 pending/rejected Task，主 Agent 不得亲自执行这些 Task；运行时会只开放 Plan_update（补全任务）或 Dispatch_dispatch（派发）。
- 每个可派发 Task 必须有明确且互不冲突的 output_path；若运行时只开放 Plan_update，先用 edit_task 补齐 output_path，下一步立即 Dispatch_dispatch。
- 独立、耗时且产出明确的当前 Step 任务，用 Dispatch_dispatch 派给子 Agent；需要连续上下文的判断由主 Agent 自己执行。
- Dispatch_dispatch 只能接收方案中当前 active Step 的 pending/rejected taskId，禁止自行构造任务或一次派发未来阶段。
- Plan_read 显示 pending_review > 0 时，用 Plan_update(review_task) 逐项对照 done_criteria，并抽查 artifacts 后裁决。
- reject 必须写具体 feedback：哪条标准未满足、差在哪里；重新派发时工具会自动带入 previous_feedback。
- 需要修改任务定义时先 Plan_update(edit_task) 再重派；仅执行不力则原样重派；路线错误则修改方案。`

export const PLAN_SINGLE_PROMPT = `# 单智能体执行协议
- 你没有 Dispatch_dispatch；当前 active Step 的所有 Task 都由自己执行。
- 执行状态必须通过 Plan_update 推进：pending→running→reported，按 done_criteria 自检后再 reported→approved/rejected。
- 不要跳过状态；rejected 任务必须修复并重新执行。`

export const PLAN_CHILD_PROMPT = `# 子 Agent 执行协议
- 你只认启动简报中的 run_id、goal、done_criteria、output_path；previous_feedback 是上次被打回的具体原因。
- 先把产出写入 output_path，再调用 Report。status=done 时 artifacts 必须列出真实存在的文件；无法达标则报 partial 或 failed。
- Report 返回 ok=true 后结束；仅在 retryable=true 时按 hint 使用同一 run_id 补交。
- 你不能创建或修改父方案，也不能输出 JSON 方案替代 Report。`

export function planSystemPrompt(input: { child: boolean; multiAgent: boolean }) {
  if (input.child) return PLAN_CHILD_PROMPT
  return [PLAN_BASE_PROMPT, input.multiAgent ? PLAN_MULTI_PROMPT : PLAN_SINGLE_PROMPT].join("\n\n")
}

export * as PlanPrompts from "./prompts"
