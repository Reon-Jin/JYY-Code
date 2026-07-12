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
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions } from "ai"
import { Effect } from "effect"
import { MessageV2 } from "./message-v2"
import * as Session from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import * as Log from "@jyycode-ai/core/util/log"
import { EffectBridge } from "@/effect/bridge"
import { Bus } from "@/bus"
import { ToolTelemetry } from "@/tool/telemetry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Config } from "@/config/config"

const log = Log.create({ service: "session.tools" })

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: MessageV2.WithParts[]
  promptOps: TaskPromptOps
  agentClusterRunID?: string
}) {
  using _ = log.time("resolveTools")
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const bus = yield* Bus.Service
  const flags = yield* RuntimeFlags.Service
  const config = yield* Config.Service
  let schemaBytes = 0

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps, ...(input.agentClusterRunID ? { agentClusterRunID: input.agentClusterRunID } : {}) },
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
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    schemaBytes += ToolTelemetry.approximateSchemaBytes(schema)
    tools[item.id] = tool({
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
  })
  const mcpDefs = yield* mcp.toolDefs()
  for (const item of [...registryDefs, ...mcpDefs]) {
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
