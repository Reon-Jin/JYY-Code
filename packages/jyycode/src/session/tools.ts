import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { ModelID } from "@/provider/schema"
import { Plugin } from "@/plugin"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions } from "ai"
import { Effect } from "effect"
import { MessageV2 } from "./message-v2"
import * as Session from "./session"
import { SessionProcessor } from "./processor"
import { PartID, type SessionID } from "./schema"
import type { SessionPrompt } from "./prompt"
import * as Log from "@jyycode-ai/core/util/log"
import { EffectBridge } from "@/effect/bridge"
import { Bus } from "@/bus"
import { ToolTelemetry } from "@/tool/telemetry"
import { PLAN_TOOL_IDS } from "@/plan/tools"

const log = Log.create({ service: "session.tools" })

/**
 * OpenAI-compatible providers reject dots in function names. Keep the
 * protocol/tool IDs stable internally, but expose provider-safe names on the
 * wire and let the closure below continue dispatching by the original ID.
 */
export function toolNameForModel(id: string) {
  return PLAN_TOOL_IDS.has(id) ? id.replaceAll(".", "_") : id
}

/** Keep a required protocol entry point as the only model-visible tool. */
export function retainOnlyTool(tools: Record<string, AITool>, requiredTool: string) {
  const selected = tools[requiredTool]
  if (!selected) throw new Error(`Required tool is unavailable: ${requiredTool}`)
  for (const name of Object.keys(tools)) {
    if (name !== requiredTool) delete tools[name]
  }
}

type PlanToolGateState = {
  current_step: string | null
  steps: Array<{
    id: string
    tasks: Array<{ id: string; status: string; done_criteria: string; output_path: string | null }>
  }>
}

function pendingDispatchTasks(plan: PlanToolGateState | undefined) {
  if (!plan?.current_step) return []
  const currentStep = plan.steps.find((step) => step.id === plan.current_step)
  return currentStep?.tasks.filter((task) => task.status === "pending" || task.status === "rejected") ?? []
}

/** A root turn must yield after dispatching work; child reports wake it when action is needed. */
export function hasInFlightPlanTasks(plan: PlanToolGateState | undefined) {
  return plan?.steps.some((step) => step.tasks.some((task) => task.status === "dispatched" || task.status === "running")) ?? false
}

/** Select protocol gates that models are not allowed to bypass with plain text. */
export function requiredPlanTool(input: {
  root: boolean
  multiAgent: boolean
  step: number
  planExists?: boolean
  plan?: PlanToolGateState
}) {
  if (!input.root) return undefined
  if (input.step === 1) return "Plan_read"
  if (input.multiAgent && input.planExists === false) return "Plan_create"
  if (input.multiAgent) {
    const pending = pendingDispatchTasks(input.plan)
    if (pending.length > 0)
      return pending.every((task) => task.done_criteria.trim() && task.output_path?.trim())
        ? "Dispatch_dispatch"
        : "Plan_update"
  }
  return undefined
}

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
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
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: MessageV2.WithParts[]
  promptOps: TaskPromptOps
}) {
  using _ = log.time("resolveTools")
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const bus = yield* Bus.Service
  let schemaBytes = 0

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: {
      model: input.model,
      bypassAgentCheck: input.bypassAgentCheck,
      promptOps: input.promptOps,
      ...(input.promptOps.agentRunID ? { agentRunID: input.promptOps.agentRunID } : {}),
    },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: { start: Date.now() },
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

  const addToolDef = (item: Tool.Def) => {
    const modelToolName = toolNameForModel(item.id)
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    schemaBytes += ToolTelemetry.approximateSchemaBytes(schema)
    tools[modelToolName] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options)
            const started = Date.now()
            return yield* Effect.gen(function* () {
              yield* plugin.trigger(
                "tool.execute.before",
                { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
                { args },
              )
              const result = yield* item.execute(args, ctx)
              const output = {
                ...result,
                attachments: result.attachments?.map((attachment) => ({
                  ...attachment,
                  id: PartID.ascending(),
                  sessionID: ctx.sessionID,
                  messageID: input.processor.message.id,
                })),
              }
              yield* plugin.trigger(
                "tool.execute.after",
                { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
                output,
              )
              if (options.abortSignal?.aborted) {
                yield* input.processor.completeToolCall(options.toolCallId, output)
              }
              return output
            }).pipe(
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
                  return ToolTelemetry.executionCompleted(bus, {
                    sessionID: ctx.sessionID,
                    messageID: ctx.messageID,
                    callID: ctx.callID,
                    tool: item.id,
                    success: false,
                    status: failure.status,
                    durationMs: Date.now() - started,
                    error: failure.error,
                  }).pipe(Effect.andThen(Effect.failCause(cause)))
                },
              }),
            )
          }),
        )
      },
    })
  }

  const registryDefs = yield* registry.tools({
    modelID: ModelID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
    includeMemory: input.session.parentID === undefined,
  })
  const mcpDefs = yield* mcp.toolDefs()
  const visibleRegistryDefs = registryDefs.filter((item) => {
    if (!PLAN_TOOL_IDS.has(item.id)) return true
    if (input.session.parentID !== undefined) return item.id === "Report"
    if (input.session.multiAgent === true) return true
    return !item.id.startsWith("Dispatch.") && item.id !== "Report"
  })
  for (const item of [...visibleRegistryDefs, ...mcpDefs]) {
    addToolDef(item)
  }

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
