import { Effect, Schema } from "effect"
import type { Bus } from "@/bus"
import { Tool } from "./tool"
import { ToolTelemetry } from "./telemetry"

export type PartitionInput = {
  tools: Tool.Def[]
  enabled: boolean
  threshold: number
  catalogSize?: number
  policy?: Readonly<Record<string, DisclosureMode>>
}

export type DisclosureMode = "direct" | "deferred"

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
  "ls",
  "glob",
  "grep",
  "bash",
  "shell",
  "apply_patch",
  "edit",
  "multi_edit",
  "write",
  "process_start",
  "process_output",
  "kill_process",
  "task",
  "task_status",
  "todowrite",
  "todo",
])

export function mode(tool: Tool.Def, input: Pick<PartitionInput, "policy"> & { automatic: boolean }): DisclosureMode {
  if (tool.id === "tool_search") return "direct"
  const configured = input.policy?.[tool.id]
  if (configured) return configured
  if (tool.catalog?.category === "memory") return "direct"
  if (tool.catalog?.category === "web") return "deferred"
  if (!input.automatic) return "direct"
  if (CORE_DIRECT_TOOL_IDS.has(tool.id)) return "direct"
  if (tool.catalog?.category === "mcp") return "deferred"
  if (tool.catalog?.category === "communication") return "deferred"
  if (tool.catalog?.detail === "advanced") return "deferred"
  return "direct"
}

function toolExecFailure(message: string) {
  return Effect.fail(new Error(message)) as unknown as Effect.Effect<Tool.ExecuteResult>
}

export function partition(input: PartitionInput): PartitionResult {
  if (!input.enabled) {
    return { direct: input.tools, hidden: [] }
  }

  const direct: Tool.Def[] = []
  const hidden: Tool.Def[] = []
  const automatic = (input.catalogSize ?? input.tools.length) > input.threshold

  for (const tool of input.tools) {
    if (mode(tool, { policy: input.policy, automatic }) === "deferred") hidden.push(tool)
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
        return toolExecFailure(`${params.tool} is directly available and is not available through tool_exec`)
      }

      const target = hiddenByID.get(params.tool)
      if (!target) {
        return toolExecFailure(`Unknown hidden tool ${params.tool}`)
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
          Effect.orDie,
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
