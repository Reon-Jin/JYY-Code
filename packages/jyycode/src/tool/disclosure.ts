import { Effect, Schema } from "effect"
import type { Bus } from "@/bus"
import { Tool } from "./tool"
import { ToolTelemetry } from "./telemetry"

export type PartitionInput = {
  tools: Tool.Def[]
  enabled: boolean
  threshold: number
}

export type PartitionResult = {
  direct: Tool.Def[]
  hidden: Tool.Def[]
}

export type ToolExecInput = {
  hidden: Tool.Def[]
  directIDs: Set<string>
  bus: Bus.Interface
}

const ToolExecParameters = Schema.Struct({
  tool: Schema.String.annotate({ description: "Hidden tool id returned by tool_search" }),
  args: Schema.Record(Schema.String, Schema.Unknown).annotate({ description: "Arguments for the hidden tool" }),
})

const CORE_DIRECT_TOOL_IDS = new Set([
  "tool_search",
  "invalid",
  "read",
  "glob",
  "grep",
  "shell",
  "apply_patch",
  "edit",
  "write",
  "task",
  "task_status",
  "todo",
])

function shouldHide(tool: Tool.Def) {
  if (CORE_DIRECT_TOOL_IDS.has(tool.id)) return false
  if (tool.catalog?.category === "mcp") return true
  if (tool.catalog?.category === "communication") return true
  if (tool.catalog?.detail === "advanced") return true
  return false
}

export function partition(input: PartitionInput): PartitionResult {
  if (!input.enabled || input.tools.length <= input.threshold) {
    return { direct: input.tools, hidden: [] }
  }

  const direct: Tool.Def[] = []
  const hidden: Tool.Def[] = []

  for (const tool of input.tools) {
    if (shouldHide(tool)) hidden.push(tool)
    else direct.push(tool)
  }

  return { direct, hidden }
}

export function toolExecDef(input: ToolExecInput): Tool.Def<typeof ToolExecParameters> {
  const hiddenByID = new Map(input.hidden.map((tool) => [tool.id, tool]))

  return {
    id: "tool_exec",
    description:
      "Execute a hidden tool found with tool_search. Tools available directly in the catalog must be called directly.",
    parameters: ToolExecParameters,
    catalog: {
      category: "other",
      mutability: "execute",
      risk: "medium",
      tags: ["hidden", "deferred", "tool"],
    },
    execute: (params, ctx) => {
      if (input.directIDs.has(params.tool)) {
        return Effect.fail(new Error(`${params.tool} is directly available and is not available through tool_exec`))
      }

      const target = hiddenByID.get(params.tool)
      if (!target) {
        return Effect.fail(new Error(`Unknown hidden tool ${params.tool}`))
      }

      const decode = Schema.decodeUnknownEffect(target.parameters)
      const delegated = {
        delegatedTool: target.id,
        delegatedCategory: target.catalog?.category,
        delegatedRisk: target.catalog?.risk,
      }

      const execution = Effect.gen(function* () {
        const args = yield* decode(params.args).pipe(
          Effect.mapError(
            (error) =>
              new Tool.InvalidArgumentsError({
                tool: target.id,
                detail: String(error),
              }),
          ),
        )
        const result = yield* target.execute(args, ctx)
        return {
          ...result,
          metadata: {
            ...result.metadata,
            ...delegated,
          },
        }
      })

      return execution.pipe(
        Effect.tap(() =>
          ToolTelemetry.deferredExecuted(input.bus, {
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            callID: ctx.callID,
            tool: "tool_exec",
            delegatedTool: target.id,
            delegatedCategory: target.catalog?.category,
            delegatedRisk: target.catalog?.risk,
            success: true,
          }),
        ),
        Effect.tapError(() =>
          ToolTelemetry.deferredExecuted(input.bus, {
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            callID: ctx.callID,
            tool: "tool_exec",
            delegatedTool: target.id,
            delegatedCategory: target.catalog?.category,
            delegatedRisk: target.catalog?.risk,
            success: false,
          }),
        ),
      )
    },
  }
}

export * as ToolDisclosure from "./disclosure"
