import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry, type ToolIdentity } from "@/tool/registry"
import { ModelID } from "@/provider/schema"
import { Plugin } from "@/plugin"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions } from "ai"
import { Cause, Effect, Exit, Fiber, Option, Scope } from "effect"
import type { JSONSchema7 } from "@ai-sdk/provider"
import path from "node:path"
import { MessageV2 } from "./message-v2"
import * as Session from "./session"
import { SessionProcessor } from "./processor"
import { PartID, type SessionID } from "./schema"
import type { Info as SessionStatusInfo } from "./status"
import type { SessionPrompt } from "./prompt"
import * as Log from "@jyycode-ai/core/util/log"
import { EffectBridge } from "@/effect/bridge"
import { Bus } from "@/bus"
import { ToolTelemetry } from "@/tool/telemetry"
import { CatalogSearch } from "@/tool/catalog-search"
import { modelFacingPlanToolName, PLAN_TOOL_IDS } from "@/plan/tools"
import { Skill } from "@/skill"
import { budgetFor, DEFAULT_BUDGETS, type BudgetConfig } from "@/execution/budget"
import type { ExecutionBudget } from "@/execution/budget"
import { combineAbortSignals } from "@/execution/deadline"
import { planFilePath, readPlanFileSync, type CandidateDiscussionPhase } from "@/plan/schema"
import { planRootForRunId, runIdForChildSession } from "@/plan/protocol"
import {
  isSubagentCandidateToolID,
  isSubagentForbiddenToolID,
  isSubagentFixedToolID,
  isReviewerReadOnlyShellCommand,
  defaultSubagentToolIDs,
  normalizeSubagentSelectableToolIDs,
  SUBAGENT_READ_ONLY_MCP_TOOL_ID,
  SUBAGENT_CANDIDATE_TOOL_IDS,
  SUBAGENT_FIXED_TOOL_IDS,
} from "@/agent/subagent-tool-policy"

const log = Log.create({ service: "session.tools" })

/**
 * These tools mutate the persisted protocol state that determines the next
 * model-visible tool catalog. The AI SDK executes a batch of tool calls with
 * Promise.all, so protocol mutations must be serialized and stale mutations
 * after the first call invalidates the current snapshot must be skipped
 * rather than executed against an old snapshot.
 */
const PROTOCOL_MUTATION_TOOL_IDS = new Set([
  "Blackboard",
  "Blackboard.reply",
  "Plan.create",
  "Plan.update",
  "Dispatch.dispatch",
  "Dispatch.cancel",
  "Candidate.declare",
  "Candidate.ready",
  "Candidate.begin",
  "Candidate.submit",
  "Report",
])

function lazyToolDescription(item: Tool.Def) {
  const firstLine = item.description.split("\n")[0]?.trim() ?? ""
  const summary = firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine
  return `${summary}\n\n完整定义和用法说明已隐藏。调用 tool_search 搜索 "${item.id}" 获取完整 schema 后再调用本工具。`
}

function shouldLazyLoadTool(item: Tool.Def) {
  if (item.id === "tool_search" || item.id === "skill" || item.id === "Goal_done") return false
  if (PLAN_TOOL_IDS.has(item.id)) return false
  return item.catalog?.detail === "advanced" || item.catalog?.category === "mcp"
}

function skippedAfterProtocolMutation(toolID: string) {
  return {
    title: "Skipped stale protocol call",
    metadata: {
      skipped: true,
      protocolStateChanged: true,
      tool: toolID,
    },
    output: `${toolID} was skipped because another protocol tool changed the task state. The next model turn will use a refreshed tool catalog.`,
  }
}

/**
 * OpenAI-compatible providers reject dots in function names. Keep the
 * protocol/tool IDs stable internally, but expose provider-safe names on the
 * wire and let the closure below continue dispatching by the original ID.
 */
export function toolNameForModel(id: string) {
  return PLAN_TOOL_IDS.has(id) ? modelFacingPlanToolName(id) : id
}

/** Keep a required protocol entry point as the only model-visible tool. */
export function retainOnlyTool(tools: Record<string, AITool>, requiredTool: string) {
  const selected = tools[requiredTool]
  if (!selected) throw new Error(`Required tool is unavailable: ${requiredTool}`)
  for (const name of Object.keys(tools)) {
    if (name !== requiredTool) delete tools[name]
  }
}

/**
 * Plan write tools the model is actively prompted to call. When a protocol
 * gate hides one of them, swap in a no-op stub instead of deleting it: a hard
 * AI-SDK unknown-tool failure reads as "unavailable tool 'invalid'" and makes
 * the model retry blindly, while the stub returns a clear, recoverable result.
 */
const GATED_PLAN_WRITE_TOOL_NAMES = new Set(["Plan_create", "Plan_update", "Dispatch_dispatch"])

function gatedPlanWriteStub(name: string, requiredTool: string): AITool {
  return tool({
    description: `${name} 当前被协议门控暂时禁用`,
    inputSchema: jsonSchema({ type: "object", additionalProperties: true }),
    execute: async () => {
      const guidance =
        name === "Plan_create"
          ? "请先完成 Plan_read 并确认最新状态：若方案尚不存在，下一步回复会重新开放 Plan_create；若方案已存在，请改用 Plan_update 修改，不要重复创建。"
          : `请先完成 ${requiredTool} 并读取其结果（含最新 revision），下一步回复会重新开放 ${name}，届时携带最新 revision 重试。`
      return {
        title: `${name} gated by protocol`,
        output: `当前步骤必须先调用 ${requiredTool}；${name} 未执行，方案未变更。${guidance}`,
        metadata: { gated: true, tool: name, requiredTool },
      }
    },
  })
}

function pruneOrStubTools(
  tools: Record<string, AITool>,
  allowed: ReadonlySet<string>,
  requiredTool: string,
  stubGated = true,
) {
  for (const name of Object.keys(tools)) {
    if (allowed.has(name)) continue
    if (stubGated && GATED_PLAN_WRITE_TOOL_NAMES.has(name)) {
      tools[name] = gatedPlanWriteStub(name, requiredTool)
      continue
    }
    delete tools[name]
  }
}

/**
 * Keep a mandatory plan action plus the small recovery surface needed by
 * providers that ignore a named tool choice or replay a batched call. The
 * prompt layer still sends an exact tool choice, so these helpers cannot turn
 * a cancel/recovery action into an endless alternative-tool loop.
 */
export function retainRequiredPlanTools(tools: Record<string, AITool>, requiredTool: string, multiAgent = true) {
  const multiAgentOnly = (items: readonly string[]) => (multiAgent ? [...items] : [])
  if (requiredTool === "Plan_read") {
    const required = tools.Plan_read
    if (!required) throw new Error("Required tool is unavailable: Plan_read")
    // Keep explicit cancellation available in the preflight snapshot. A
    // provider may batch the user's stop request behind the mandatory read;
    // hiding it turns that valid request into an unknown-tool failure.
    const allowed = new Set([
      "Plan_read",
      "Goal_done",
      ...multiAgentOnly(["Dispatch_cancel", "Dispatch_dispatch", "Blackboard", "Blackboard_Reply", "Dispatch_roles"]),
    ])
    pruneOrStubTools(tools, allowed, requiredTool, multiAgent)
    return
  }
  if (requiredTool === "Plan_create") {
    const required = tools.Plan_create
    if (!required) throw new Error("Required tool is unavailable: Plan_create")
    // A model can emit these harmless preflight calls after Plan_read before
    // it commits the first plan write. Keep them visible so a stale or
    // batched call becomes a real successful protocol call instead of an
    // AI-SDK unknown-tool failure.
    const allowed = new Set([
      "Plan_create",
      "Plan_read",
      "Plan_update",
      "Goal_done",
      ...multiAgentOnly(["Dispatch_roles", "Dispatch_cancel", "Dispatch_dispatch", "Blackboard", "Blackboard_Reply"]),
    ])
    pruneOrStubTools(tools, allowed, requiredTool, multiAgent)
    return
  }
  if (requiredTool === "Plan_update" || requiredTool === "Dispatch_dispatch") {
    const read = tools.Plan_read
    const required = tools[requiredTool]
    if (!required) throw new Error(`Required tool is unavailable: ${requiredTool}`)
    if (!read) throw new Error("Plan_read is unavailable for plan recovery")
    const allowed = new Set([
      requiredTool,
      "Plan_read",
      "Goal_done",
      ...multiAgentOnly(["Blackboard", "Blackboard_Reply", "Dispatch_roles", "Dispatch_cancel"]),
    ])
    pruneOrStubTools(tools, allowed, requiredTool, multiAgent)
    return
  }
  if (requiredTool === "Blackboard") {
    const read = tools.Blackboard
    const reply = tools.Blackboard_Reply
    const planRead = tools.Plan_read
    if (!read || !reply || !planRead) throw new Error("Blackboard recovery tools are unavailable")
    // Blackboard reads update persistent cursors during this response. Keep
    // the complete snapshot so a model can read a message, inspect an
    // artifact, and review it without its follow-up tool becoming unknown.
    return
  }
  retainOnlyTool(tools, requiredTool)
}

type PlanToolGateState = {
  current_step: string | null
  steps: Array<{
    id: string
    candidate_discussion?: { phase?: string }
    tasks: Array<{
      id: string
      status: string
      done_criteria: string
      output_path: string | null
      dispatch?: { child_session_id?: string | null } | null
      report?: { review_feedback?: string | null } | null
    }>
  }>
}

function pendingDispatchTasks(plan: PlanToolGateState | undefined) {
  if (!plan?.current_step) return []
  const currentStep = plan.steps.find((step) => step.id === plan.current_step)
  return currentStep?.tasks.filter((task) => task.status === "pending" || task.status === "rejected") ?? []
}

function hasReviewContinuation(task: PlanToolGateState["steps"][number]["tasks"][number]) {
  return Boolean(task.dispatch?.child_session_id && task.report?.review_feedback?.trim())
}

/**
 * A pending task is only dispatch-ready when its output_path is a non-empty
 * path that actually resolves inside the workspace. Models sometimes write a
 * plausible-looking but invalid path (e.g. `c:/D:\repo\out`); treating it as
 * ready deadlocks the plan because Dispatch_dispatch rejects it while the
 * protocol gate hides Plan_update.
 */
function isOutputPathDispatchReady(outputPath: string | null | undefined, workspaceRoot?: string) {
  if (!outputPath?.trim()) return false
  if (!workspaceRoot) return true
  try {
    const root = path.resolve(workspaceRoot)
    const absolute = path.isAbsolute(outputPath) ? path.resolve(outputPath) : path.resolve(root, outputPath)
    const relative = path.relative(root, absolute)
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  } catch {
    return false
  }
}

/** A root turn must yield after dispatching work; child reports wake it when action is needed. */
export function hasInFlightPlanTasks(plan: PlanToolGateState | undefined) {
  return (
    plan?.steps.some((step) => step.tasks.some((task) => task.status === "dispatched" || task.status === "running")) ??
    false
  )
}

/**
 * A root only needs another model turn while children are running when a
 * Report, Inbox item, or Blackboard event made new work actionable. Keeping
 * this pure lets SessionPrompt use the same condition before and after a turn.
 */
export function shouldWaitForPlanReport(input: {
  plan: PlanToolGateState | undefined
  blackboardUnread?: number
  inboxPending?: number
}) {
  if ((input.blackboardUnread ?? 0) > 0 || (input.inboxPending ?? 0) > 0) return false
  if (pendingDispatchTasks(input.plan).length > 0) return false
  const currentStep = input.plan?.current_step
    ? input.plan.steps.find((step) => step.id === input.plan?.current_step)
    : undefined
  if (currentStep?.candidate_discussion?.phase === "awaiting_main") return false
  const hasReported = input.plan?.steps.some((step) => step.tasks.some((task) => task.status === "reported")) ?? false
  return hasInFlightPlanTasks(input.plan) && !hasReported
}

export function isPlanToolVisible(itemID: string, session: Pick<Session.Info, "parentID" | "multiAgent">) {
  if (session.parentID !== undefined)
    return itemID === "Report" || itemID === "Blackboard" || itemID === "Blackboard.reply"
  if (session.multiAgent === true) return true
  return (
    !itemID.startsWith("Dispatch.") &&
    !itemID.startsWith("Candidate.") &&
    itemID !== "Report" &&
    itemID !== "Blackboard" &&
    itemID !== "Blackboard.reply"
  )
}

/** Return the explicit allowlist carried by a profile-backed subagent. */
export function subagentToolIDs(agent: Pick<Agent.Info, "mode" | "options">): ReadonlySet<string> | undefined {
  if (agent.mode !== "subagent") return undefined
  const value = agent.options.subagentToolIDs
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) return undefined
  return new Set(value)
}

/**
 * Build the safe role surface before applying a phase-specific protocol gate.
 * Omitted profile settings retain all currently registered non-system tools,
 * but never restore forbidden tools. Protocol tools are added by the runtime.
 */
export function subagentRoleToolIDs(
  agent: Pick<Agent.Info, "mode" | "options">,
  session: Pick<Session.Info, "parentID">,
  candidateGate?: Pick<CandidateToolGateState, "allowedToolIDs">,
) {
  if (agent.mode !== "subagent") return undefined
  const configured = subagentToolIDs(agent)
  const profileID = typeof agent.options.subagentProfileID === "string" ? agent.options.subagentProfileID : undefined
  const allowed = configured
    ? normalizeSubagentSelectableToolIDs([...configured])
    : profileID
      ? new Set(defaultSubagentToolIDs(profileID))
      : undefined
  if (!allowed) return undefined
  if (session.parentID !== undefined) {
    for (const id of SUBAGENT_FIXED_TOOL_IDS) allowed.add(id)
  }
  if (candidateGate) {
    for (const id of SUBAGENT_CANDIDATE_TOOL_IDS) {
      if (candidateGate.allowedToolIDs.has(id)) allowed.add(id)
    }
  }
  return allowed
}

export function isSubagentToolVisible(
  id: string,
  allowedToolIDs: ReadonlySet<string> | undefined,
  candidateGate: Pick<CandidateToolGateState, "allowedToolIDs" | "phase"> | undefined,
) {
  if (allowedToolIDs) {
    if (!candidateGate) return allowedToolIDs.has(id)
    return (
      allowedToolIDs.has(id) &&
      (candidateGate.allowedToolIDs.has(id) ||
        (candidateGate.phase === "running" && !isSubagentFixedToolID(id) && !isSubagentForbiddenToolID(id)))
    )
  }
  if (candidateGate) {
    return (
      candidateGate.allowedToolIDs.has(id) ||
      (candidateGate.phase === "running" &&
        !isSubagentFixedToolID(id) &&
        !isSubagentForbiddenToolID(id) &&
        !isSubagentCandidateToolID(id))
    )
  }
  return !isSubagentForbiddenToolID(id) && !isSubagentCandidateToolID(id)
}

function candidatePhaseToolIDs(
  candidateGate: CandidateToolGateState | undefined,
  roleToolIDs: ReadonlySet<string> | undefined,
) {
  if (!candidateGate || candidateGate.phase !== "running") return candidateGate?.allowedToolIDs
  if (!roleToolIDs) return undefined
  const allowed = new Set(candidateGate.allowedToolIDs)
  for (const id of roleToolIDs) {
    if (!isSubagentFixedToolID(id) && !isSubagentForbiddenToolID(id)) allowed.add(id)
  }
  return allowed
}

/** Intersect an optional role allowlist with a phase-specific protocol allowlist. */
export function intersectToolIDs(
  roleToolIDs: ReadonlySet<string> | undefined,
  phaseToolIDs: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  if (!roleToolIDs) return phaseToolIDs
  if (!phaseToolIDs) return roleToolIDs
  return new Set([...roleToolIDs].filter((id) => phaseToolIDs.has(id)))
}

/** Filter model-visible definitions without allowing synthetic catalog tools to bypass a role allowlist. */
export function filterToolIDs<T extends { id: string }>(
  items: readonly T[],
  allowedToolIDs: ReadonlySet<string> | undefined,
) {
  return allowedToolIDs ? items.filter((item) => allowedToolIDs.has(item.id)) : [...items]
}

const CANDIDATE_RUNNING_TOOL_IDS = new Set([
  "read",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "skill",
  "Candidate.submit",
])

export type CandidateToolGateState = {
  stepID: string
  taskID: string
  phase: CandidateDiscussionPhase
  allowedToolIDs: ReadonlySet<string>
}

/**
 * Candidate permissions are derived from the persisted dispatch record and the
 * current plan phase. Prompt wording is intentionally not part of this gate.
 */
export function candidateToolGateState(
  session: Pick<Session.Info, "id" | "parentID" | "directory">,
  options: { planRoot?: string } = {},
): CandidateToolGateState | undefined {
  if (session.parentID === undefined) return undefined
  const plan = readPlanFileSync(planFilePath(options.planRoot ?? session.directory, session.parentID))
  if (!plan) return undefined
  for (const step of plan.steps) {
    const discussion = step.candidate_discussion
    if (!discussion) continue
    const task = step.tasks.find((item) => item.mode === "candidate" && item.dispatch?.child_session_id === session.id)
    if (!task) continue
    const allowedToolIDs =
      discussion.phase === "declaring"
        ? new Set(["Candidate.declare"])
        : discussion.phase === "cross_review"
          ? new Set(["Blackboard", "Blackboard.reply", "Candidate.ready"])
          : discussion.phase === "running"
            ? new Set(CANDIDATE_RUNNING_TOOL_IDS)
            : new Set<string>()
    return { stepID: step.id, taskID: task.id, phase: discussion.phase, allowedToolIDs }
  }
  return undefined
}

/** Select protocol gates that models are not allowed to bypass with plain text. */
export function requiredPlanTool(input: {
  root: boolean
  multiAgent: boolean
  step: number
  blackboardUnread?: number
  planExists?: boolean
  /** A previous Plan_create call failed; force a fresh state read before retrying. */
  planCreateFailed?: boolean
  /** Plan_create retries are exhausted for this user turn; release the plan gate. */
  planCreateExhausted?: boolean
  plan?: PlanToolGateState
  workspaceRoot?: string
}) {
  if (!input.root) return undefined
  if ((input.blackboardUnread ?? 0) > 0) return "Blackboard"
  // Once the model has exhausted its Plan_create retry budget, forcing plan
  // protocol tools again only re-enters the create/read loop. Let it answer
  // the user or use ordinary tools instead.
  if (input.planCreateExhausted) return undefined
  // On a fresh turn the runtime may already know there is no plan. Forcing a
  // Plan_read first costs an extra round trip that adds no information: the
  // create gate already carries a fresh empty state, and Plan_create rejects
  // a duplicate plan if one appears concurrently.
  if (input.step === 1) return input.multiAgent && input.planExists === false ? "Plan_create" : "Plan_read"
  if (input.multiAgent && input.planExists === false) return input.planCreateFailed ? "Plan_read" : "Plan_create"
  if (input.multiAgent) {
    const currentStep = input.plan?.current_step
      ? input.plan.steps.find((step) => step.id === input.plan?.current_step)
      : undefined
    if (currentStep && currentStep.tasks.length === 0) return "Plan_update"
    const rejected = currentStep?.tasks.filter((task) => task.status === "rejected") ?? []
    // Review rejections already contain an actionable correction and retain
    // the original child session. They must go straight to Dispatch_dispatch;
    // forcing Plan_update here contradicts the returned protocol hint and can
    // make the root alternate forever between Plan_update and a gated dispatch.
    if (rejected.length > 0 && rejected.every(hasReviewContinuation)) return "Dispatch_dispatch"
    // Runtime failures or malformed rejected tasks still need an explicit
    // recovery edit/reopen before dispatching them again.
    if (rejected.length > 0) return "Plan_update"
    const pending = pendingDispatchTasks(input.plan)
    if (pending.length > 0)
      return pending.every(
        (task) => task.done_criteria.trim() && isOutputPathDispatchReady(task.output_path, input.workspaceRoot),
      )
        ? "Dispatch_dispatch"
        : "Plan_update"
  }
  return undefined
}

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  status(sessionID: SessionID): Effect.Effect<SessionStatusInfo>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
  loop(input: SessionPrompt.LoopInput): Effect.Effect<MessageV2.WithParts>
  wake(input: { sessionID: SessionID; text: string; kind: string }): Effect.Effect<MessageV2.WithParts>
  /** Runtime-injected run id for the file-backed Report protocol. */
  agentRunID?: string
}

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<
    SessionProcessor.Handle,
    | "message"
    | "updateToolCall"
    | "completeToolCall"
    | "failToolCall"
    | "requestToolCatalogRefresh"
    | "toolCatalogRefreshRequested"
  >
  bypassAgentCheck: boolean
  messages: MessageV2.WithParts[]
  promptOps: TaskPromptOps
  /** Parent child-agent budget; every tool budget is derived from it. */
  executionBudget?: ExecutionBudget
}) {
  using _ = log.time("resolveTools")
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const bus = yield* Bus.Service
  const configService = yield* Effect.serviceOption(Config.Service)
  const config = Option.isSome(configService) ? yield* Effect.promise(() => run.promise(configService.value.get())) : undefined
  const executionBudgetConfig = Object.fromEntries(
    Object.entries(config?.execution_budget ?? {})
      .filter(([operationClass]) => Object.prototype.hasOwnProperty.call(DEFAULT_BUDGETS, operationClass))
      .map(([operationClass, value]) => [
        operationClass,
        {
          ...(value.default_ms !== undefined ? { defaultMs: value.default_ms } : {}),
          ...(value.hard_cap_ms !== undefined ? { hardCapMs: value.hard_cap_ms } : {}),
          ...(value.grace_ms !== undefined ? { graceMs: value.grace_ms } : {}),
        },
      ]),
  ) as BudgetConfig
  let schemaBytes = 0

  const context = (
    args: Record<string, unknown>,
    options: ToolExecutionOptions,
    budget: ReturnType<typeof budgetFor>,
  ): Tool.Context => ({
    sessionID: input.session.id,
    abort: combineAbortSignals(options.abortSignal, budget.deadline.signal(options.abortSignal)),
    budget,
    deadline: budget.deadline,
    remaining: () => budget.remaining(),
    operationClass: budget.operationClass,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    skillScope: Skill.scopeForSession(input.session, input.agent),
    extra: {
      model: input.model,
      bypassAgentCheck: input.bypassAgentCheck,
      promptOps: input.promptOps,
      ...(input.promptOps.agentRunID ? { agentRunID: input.promptOps.agentRunID } : {}),
      ...(parentPlanRoot ? { planRoot: parentPlanRoot } : {}),
      requestToolCatalogRefresh: () => input.processor.requestToolCatalogRefresh?.(),
      toolCatalogRefreshRequested: () => input.processor.toolCatalogRefreshRequested?.() === true,
    },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        const started = match.state.status === "running" ? match.state.time.start : Date.now()
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: { start: started },
          },
        }
      }),
    ask: (req) =>
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie),
  })

  const bounded = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    budget: ExecutionBudget,
    timeout: () => Tool.ExecutionTimeoutError,
  ) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const fiber = yield* Effect.forkIn(effect, scope)
      const observed = yield* Effect.raceFirst(
        Fiber.await(fiber),
        Effect.sleep(budget.effectiveMs).pipe(Effect.as(undefined)),
      )
      if (observed === undefined || (Exit.isFailure(observed) && Cause.hasInterruptsOnly(observed.cause))) {
        // Give cooperative tools a bounded cleanup window before terminating
        // their private scope. External process handles are intentionally not
        // reported as killed here; Task 19 owns verified process-tree kills.
        if (budget.graceMs > 0) yield* Effect.sleep(budget.graceMs)
        if (fiber.pollUnsafe() === undefined) yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
        return yield* Effect.fail(timeout())
      }
      yield* Scope.close(scope, observed).pipe(Effect.ignore)
      return yield* observed
    })

  // AI SDK executes all tool calls from one assistant response in parallel.
  // Serializing protocol mutations gives the first successful mutation a
  // chance to invalidate the stale calls queued behind it.
  let protocolMutationTail: Promise<unknown> = Promise.resolve()
  let modelNameResolution: ToolRegistry.ResolvedToolNames | undefined

  const identityForModel = (item: Tool.Def): ToolIdentity =>
    ToolRegistry.toolIdentityFor(item) ?? {
      source: item.catalog?.category === "mcp" ? "mcp" : "builtin",
      sourceID: `fallback:${item.id}`,
      modelName: toolNameForModel(item.id),
    }

  const addToolDef = (item: Tool.Def, options: { lazy?: boolean } = {}) => {
    const identity = identityForModel(item)
    const modelToolName = modelNameResolution?.names.get(identity.sourceID) ?? identity.modelName
    const schema = options.lazy
      ? ({ type: "object", additionalProperties: true } as const)
      : ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    schemaBytes += ToolTelemetry.approximateSchemaBytes(schema)
    const reviewerShell =
      input.agent.mode === "subagent" &&
      String(input.agent.options.subagentProfileID ?? "").toLowerCase() === "reviewer" &&
      item.id === "bash"
    const executeDef = reviewerShell
      ? (args: unknown, ctx: Tool.Context) => {
          const command =
            args && typeof args === "object" && typeof (args as Record<string, unknown>).command === "string"
              ? String((args as Record<string, unknown>).command)
              : ""
          if (!isReviewerReadOnlyShellCommand(command))
            return Effect.fail(new Error("reviewer shell is restricted to a single read-only command"))
          return item.execute(args as never, ctx)
        }
      : item.execute
    tools[modelToolName] = tool({
      description: options.lazy ? lazyToolDescription(item) : item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        const executeTool = () =>
          run.promise(
            Effect.gen(function* () {
              const budget = budgetFor("generic_tool", undefined, input.executionBudget, executionBudgetConfig)
              const ctx = context(args, options, budget)
              const started = Date.now()
              let phase: Tool.ToolExecutionPhase = "plugin_before"
              const refreshRequested = ctx.extra?.toolCatalogRefreshRequested
              if (typeof refreshRequested === "function" && refreshRequested()) {
                return skippedAfterProtocolMutation(item.id)
              }
              const execution = Effect.gen(function* () {
                const pluginStage = () =>
                  budget.child("plugin_hook", Math.max(1, Math.floor(budget.effectiveMs / 2)), executionBudgetConfig)

                const beforeBudget = pluginStage()
                yield* plugin.trigger(
                  "tool.execute.before",
                  { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
                  { args },
                  { signal: beforeBudget.deadline.signal(ctx.abort) },
                ).pipe(
                  Effect.timeoutOrElse({
                    duration: beforeBudget.effectiveMs,
                    orElse: () =>
                      Effect.fail(
                        new Tool.ExecutionTimeoutError(item.id, beforeBudget.effectiveMs, {
                          requestedMs: beforeBudget.requestedMs,
                          phase: "plugin_before",
                        }),
                      ),
                  }),
                )
                phase = "execute"
                const result = yield* executeDef(args, ctx)
                const output = {
                  ...result,
                  attachments: result.attachments?.map((attachment) => ({
                    ...attachment,
                    id: PartID.ascending(),
                    sessionID: ctx.sessionID,
                    messageID: input.processor.message.id,
                  })),
                }
                // Persist the tool result before running the post-hook. A
                // broken hook must not turn a successful external operation
                // back into a pending or error tool part.
                yield* input.processor.completeToolCall(options.toolCallId, output)
                phase = "plugin_after"
                const afterBudget = pluginStage()
                yield* plugin.trigger(
                  "tool.execute.after",
                  { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
                  output,
                  { signal: afterBudget.deadline.signal(ctx.abort) },
                ).pipe(
                  Effect.timeoutOrElse({
                    duration: afterBudget.effectiveMs,
                    orElse: () =>
                      Effect.fail(
                        new Tool.ExecutionTimeoutError(item.id, afterBudget.effectiveMs, {
                          requestedMs: afterBudget.requestedMs,
                          phase: "plugin_after",
                        }),
                      ),
                  }),
                )
                return output
              })
              return yield* bounded(
                execution,
                budget,
                () =>
                  new Tool.ExecutionTimeoutError(item.id, budget.effectiveMs, {
                    requestedMs: budget.requestedMs,
                    elapsedMs: Date.now() - started,
                    phase: options.abortSignal?.aborted ? "abort" : phase,
                    terminationResult: options.abortSignal?.aborted ? "aborted" : "not_applicable",
                  }),
              ).pipe(
                Effect.matchCauseEffect({
                  onSuccess: (output) =>
                    ToolTelemetry.executionCompleted(bus, {
                      sessionID: ctx.sessionID,
                      messageID: ctx.messageID,
                      callID: ctx.callID,
                      tool: item.id,
                      success: true,
                      status: "success",
                      durationMs: Date.now() - started,
                      delegatedTool:
                        typeof output.metadata.delegatedTool === "string" ? output.metadata.delegatedTool : undefined,
                    }).pipe(Effect.as(output)),
                  onFailure: (cause) => {
                    const failure = ToolTelemetry.executionFailure(cause)
                    const error = Cause.squash(cause)
                    const metadata = {
                      ...(typeof (error as any)?.code === "string" ? { code: (error as any).code } : {}),
                      requested_ms: budget.requestedMs ?? budget.effectiveMs,
                      effective_ms: budget.effectiveMs,
                      elapsed_ms: Date.now() - started,
                      phase: error instanceof Tool.ExecutionTimeoutError
                        ? error.phase
                        : options.abortSignal?.aborted
                          ? "abort"
                          : phase,
                      termination_result: error instanceof Tool.ExecutionTimeoutError
                        ? error.terminationResult
                        : options.abortSignal?.aborted
                          ? "aborted"
                          : "not_applicable",
                    }
                    const finalize = input.processor.failToolCall
                      ? input.processor.failToolCall(options.toolCallId, error, metadata).pipe(Effect.ignore)
                      : Effect.void
                    return finalize.pipe(
                      Effect.andThen(
                        ToolTelemetry.executionCompleted(bus, {
                          sessionID: ctx.sessionID,
                          messageID: ctx.messageID,
                          callID: ctx.callID,
                          tool: item.id,
                          success: false,
                          status: failure.status,
                          durationMs: Date.now() - started,
                          error: failure.error,
                        }),
                      ),
                      // Do not re-emit the race's interruption branch: callers
                      // need the typed tool failure even when the timeout
                      // combinator also records an internal interrupt.
                      Effect.andThen(Effect.fail(error)),
                    )
                  },
                }),
              )
            }),
          )

        if (!PROTOCOL_MUTATION_TOOL_IDS.has(item.id)) return executeTool()

        const current = protocolMutationTail.then(() => {
          if (input.processor.toolCatalogRefreshRequested?.()) return skippedAfterProtocolMutation(item.id)
          return executeTool()
        })
        protocolMutationTail = current.then(
          () => undefined,
          () => undefined,
        )
        return current
      },
    })
  }

  const addToolSearchDef = (searchable: Tool.Def[]) => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms for finding relevant available tools" },
        limit: { type: "number", description: "Maximum number of tool matches to return (default: 8)" },
        detail: {
          type: "string",
          enum: ["summary", "schema", "full"],
          description: "How much information to return for each match (default: summary)",
        },
        category: {
          type: "string",
          enum: [
            "filesystem",
            "code-search",
            "execution",
            "web",
            "mcp",
            "subagent",
            "communication",
            "memory",
            "other",
          ],
          description: "Optional catalog category filter.",
        },
      },
      required: ["query"],
    }
    schemaBytes += ToolTelemetry.approximateSchemaBytes(schema)
    tools["tool_search"] = tool({
      description:
        "Search the currently available tool catalog by ranked metadata and keyword matches. Use this when you are unsure which tool is best for a task or need the full definition of a tool whose usage instructions are hidden.",
      inputSchema: jsonSchema(schema),
      execute: async (
        searchParams: {
          query?: string
          limit?: number
          detail?: "summary" | "schema" | "full"
          category?: string
        },
        options,
      ) => {
        return run.promise(
          Effect.gen(function* () {
            const detail: "summary" | "schema" | "full" = searchParams.detail ?? "summary"
            const scored = CatalogSearch.search({
              tools: searchable,
              query: searchParams.query ?? "",
              limit: searchParams.limit,
              detail,
              category: searchParams.category,
            })
            const output = CatalogSearch.formatResults(scored, { detail })
            const resultIDs = scored.map((item) => item.tool.id)
            yield* ToolTelemetry.searchExecuted(bus, {
              sessionID: input.session.id,
              messageID: input.processor.message.id,
              callID: options.toolCallId,
              query: searchParams.query ?? "",
              detail,
              category: searchParams.category,
              resultIDs,
            })
            return {
              title: `Tool search: ${searchParams.query ?? ""}`,
              metadata: {
                matches: scored.length,
                resultIDs,
                detail,
                truncated: false,
              },
              output,
            }
          }),
        )
      },
    })
  }

  const childRunID = input.session.parentID ? runIdForChildSession(input.session.id) : undefined
  const parentPlanRoot = childRunID ? planRootForRunId(childRunID) : undefined
  const candidateGate = candidateToolGateState(input.session, parentPlanRoot ? { planRoot: parentPlanRoot } : undefined)
  const roleToolIDs = subagentRoleToolIDs(input.agent, input.session, candidateGate)
  const allowedToolIDs = intersectToolIDs(roleToolIDs, candidatePhaseToolIDs(candidateGate, roleToolIDs))
  const registryDefs = yield* registry.tools({
    modelID: ModelID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
    skillScope: Skill.scopeForSession(input.session, input.agent),
    includeMemory: input.session.parentID === undefined,
    // Experiences (context_read) are read-only and open to subagents; the
    // memory tool itself stays root-only via includeMemory and the subagent
    // forbidden-tool policy.
    includeContextRead: true,
    ...(allowedToolIDs ? { toolIDs: allowedToolIDs } : {}),
  })
  // A profile-backed child that has no MCP allowance should not even resolve
  // MCP definitions: resolving them is the point at which configured servers
  // are started. Root sessions and explicitly MCP-enabled roles still opt in.
  const shouldResolveMcp = input.agent.mode !== "subagent" || allowedToolIDs?.has(SUBAGENT_READ_ONLY_MCP_TOOL_ID) === true
  const mcpDefs =
    candidateGate && candidateGate.phase !== "running"
      ? []
      : shouldResolveMcp
        ? yield* mcp.toolDefs()
        : []
  const visibleRegistryDefs = filterToolIDs(registryDefs, allowedToolIDs).filter((item) => {
    if (item.id === "Goal_done" && (input.session.parentID !== undefined || input.session.goal?.status !== "running"))
      return false
    if (input.agent.mode === "subagent" && !isSubagentToolVisible(item.id, allowedToolIDs, candidateGate)) return false
    if (candidateGate) return item.id !== "tool_search" || candidateGate.phase === "running"
    if (!PLAN_TOOL_IDS.has(item.id)) return true
    return isPlanToolVisible(item.id, input.session)
  })
  const visibleMcpDefs = (allowedToolIDs
    ? mcpDefs.filter(
        (item) => allowedToolIDs.has(item.id) || allowedToolIDs.has(SUBAGENT_READ_ONLY_MCP_TOOL_ID),
      )
    : mcpDefs
  ).filter((item) => {
    if (input.agent.mode !== "subagent") return true
    const readOnlyMcp =
      allowedToolIDs?.has(SUBAGENT_READ_ONLY_MCP_TOOL_ID) &&
      item.catalog?.category === "mcp" &&
      item.catalog.mutability === "read"
    return readOnlyMcp || isSubagentToolVisible(item.id, allowedToolIDs, candidateGate)
  })
  const hasToolSearch = visibleRegistryDefs.some((item) => item.id === "tool_search")
  const searchableDefs = [...visibleRegistryDefs.filter((item) => item.id !== "tool_search"), ...visibleMcpDefs]
  modelNameResolution = ToolRegistry.resolveToolModelNames(searchableDefs.map(identityForModel))
  for (const collision of modelNameResolution.collisions) {
    log.warn("tool catalog model-name collision resolved", collision)
  }
  for (const item of visibleRegistryDefs) {
    if (item.id === "tool_search") continue
    // Subagents cannot call tool_search to expand a lazy tool, so expose the
    // full context_read schema/description to them directly.
    const lazy = shouldLazyLoadTool(item) && !(item.id === "context_read" && input.session.parentID !== undefined)
    addToolDef(item, { lazy })
  }
  for (const item of visibleMcpDefs) {
    addToolDef(item, { lazy: true })
  }
  if (hasToolSearch) addToolSearchDef(searchableDefs)

  yield* ToolTelemetry.catalogResolved(bus, {
    sessionID: input.session.id,
    messageID: input.processor.message.id,
    providerID: input.model.providerID,
    modelID: input.model.api.id,
    agent: input.agent.name,
    toolIDs: Object.keys(tools),
    schemaBytes,
  })

  return tools
})

export * as SessionTools from "./tools"
