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
import { ToolDisclosure } from "@/tool/disclosure"
import { CatalogSearch } from "@/tool/catalog-search"

const log = Log.create({ service: "session.tools" })

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
  const flags = yield* RuntimeFlags.Service
  let schemaBytes = 0

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
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
  const promptDefs = composeDeferredMcpTools({
    registryDefs,
    mcpDefs,
    enabled: flags.experimentalDeferredTools,
    threshold: flags.deferredToolThreshold ?? 40,
    bus,
  })

  for (const item of promptDefs) {
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

function composeDeferredMcpTools(input: {
  registryDefs: Tool.Def[]
  mcpDefs: Tool.Def[]
  enabled: boolean
  threshold: number
  bus: Bus.Interface
}) {
  if (!input.enabled || input.mcpDefs.length === 0 || input.registryDefs.length + input.mcpDefs.length <= input.threshold) {
    return [...input.registryDefs, ...input.mcpDefs]
  }

  const existingSearch = input.registryDefs.find((item) => item.id === "tool_search")
  const existingExec = input.registryDefs.find((item) => item.id === "tool_exec")
  const directRegistry = input.registryDefs.filter((item) => item.id !== "tool_search" && item.id !== "tool_exec")
  const directIDs = new Set(input.registryDefs.filter((item) => item.id !== "tool_exec").map((item) => item.id))
  const mcpExec = ToolDisclosure.toolExecDef({
    hidden: input.mcpDefs,
    directIDs,
    bus: input.bus,
  })
  const toolExec = existingExec ? composeToolExec(existingExec, mcpExec) : mcpExec
  const toolSearch = existingSearch ? composeToolSearch(existingSearch, input.mcpDefs, input.bus) : undefined

  return [...(toolSearch ? [toolSearch] : []), ...directRegistry, toolExec]
}

function composeToolExec(primary: Tool.Def, fallback: Tool.Def): Tool.Def {
  return {
    ...primary,
    execute: (params, ctx) =>
      fallback.execute(params, ctx).pipe(
        Effect.catch((error) =>
          String(error).includes("Unknown hidden tool") ? primary.execute(params, ctx) : Effect.fail(error),
        ),
      ),
  }
}

function composeToolSearch(existing: Tool.Def, hidden: Tool.Def[], bus: Bus.Interface): Tool.Def {
  return {
    ...existing,
    execute: (params: any, ctx) =>
      existing.execute(params, ctx).pipe(
        Effect.flatMap((base) => {
          const detail = params.detail ?? "summary"
          const scored = CatalogSearch.search({
            tools: hidden,
            query: params.query,
            limit: params.limit,
            detail,
            category: params.category,
          })
          if (scored.length === 0) return Effect.succeed(base)

          const resultIDs = scored.map((item) => item.tool.id)
          const output = CatalogSearch.formatResults(scored, { detail })
          return ToolTelemetry.searchExecuted(bus, {
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            callID: ctx.callID,
            query: params.query,
            detail,
            category: params.category,
            resultIDs,
          }).pipe(
            Effect.as({
              ...base,
              output: [base.output, "Hidden MCP tools:", output].filter(Boolean).join("\n\n"),
              metadata: {
                ...base.metadata,
                hiddenMcpResultIDs: resultIDs,
              },
            }),
          )
        }),
      ),
  }
}

export * as SessionTools from "./tools"
