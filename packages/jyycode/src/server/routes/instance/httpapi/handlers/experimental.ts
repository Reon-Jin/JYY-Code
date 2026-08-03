import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { MCP } from "@/mcp"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Worktree } from "@/worktree"
import { Effect } from "effect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ConsoleSwitchPayload, SessionListQuery, ToolListQuery, WorktreeApiError } from "../groups/experimental"

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const mcp = yield* MCP.Service
    const project = yield* Project.Service
    const registry = yield* ToolRegistry.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const worktreeSvc = yield* Worktree.Service

    const console = Effect.fn("ExperimentalHttpApi.console")(function* () {
      return {
        consoleManagedProviders: [],
        switchableOrgCount: 0,
      }
    })

    const consoleOrgs = Effect.fn("ExperimentalHttpApi.consoleOrgs")(function* () {
      return { orgs: [] }
    })

    const consoleSwitch = Effect.fn("ExperimentalHttpApi.consoleSwitch")(function* (_ctx: {
      payload: typeof ConsoleSwitchPayload.Type
    }) {
      return true
    })

    const tool = Effect.fn("ExperimentalHttpApi.tool")(function* (ctx: { query: typeof ToolListQuery.Type }) {
      const list = yield* registry.tools({
        providerID: ctx.query.provider,
        modelID: ctx.query.model,
        agent: yield* agents.defaultInfo(),
      })
      return list.map((item) => ({
        id: item.id,
        description: item.description,
        parameters: ToolJsonSchema.fromTool(item),
      }))
    })

    const toolIDs = Effect.fn("ExperimentalHttpApi.toolIDs")(function* () {
      const mcpDefs = yield* mcp.toolDefs()
      return [...new Set(["tool_search", ...(yield* registry.ids()), ...mcpDefs.map((tool) => tool.id)])].toSorted()
    })

    const worktree = Effect.fn("ExperimentalHttpApi.worktree")(function* () {
      const ctx = yield* InstanceState.context
      return yield* project.sandboxes(ctx.project.id)
    })

    const worktreeCreate = Effect.fn("ExperimentalHttpApi.worktreeCreate")(function* (ctx: {
      payload: Worktree.CreateInput | undefined
    }) {
      return yield* mapWorktreeError(worktreeSvc.create(ctx.payload))
    })

    const worktreeRemove = Effect.fn("ExperimentalHttpApi.worktreeRemove")(function* (input: {
      payload: Worktree.RemoveInput
    }) {
      const ctx = yield* InstanceState.context
      yield* mapWorktreeError(worktreeSvc.remove(input.payload))
      yield* project.removeSandbox(ctx.project.id, input.payload.directory)
      return true
    })

    const worktreeReset = Effect.fn("ExperimentalHttpApi.worktreeReset")(function* (ctx: {
      payload: Worktree.ResetInput
    }) {
      yield* mapWorktreeError(worktreeSvc.reset(ctx.payload))
      return true
    })

    const session = Effect.fn("ExperimentalHttpApi.session")(function* (ctx: { query: typeof SessionListQuery.Type }) {
      const limit = ctx.query.limit ?? 100
      const sessions = Array.from(
        Session.listGlobal({
          directory: ctx.query.directory,
          roots: ctx.query.roots,
          start: ctx.query.start,
          cursor: ctx.query.cursor,
          search: ctx.query.search,
          limit: limit + 1,
          archived: ctx.query.archived,
        }),
      )
      const list = sessions.length > limit ? sessions.slice(0, limit) : sessions
      return HttpServerResponse.jsonUnsafe(list, {
        headers:
          sessions.length > limit && list.length > 0
            ? { "x-next-cursor": String(list[list.length - 1].time.updated) }
            : undefined,
      })
    })

    const resource = Effect.fn("ExperimentalHttpApi.resource")(function* () {
      return yield* mcp.resources()
    })

    return handlers
      .handle("console", console)
      .handle("consoleOrgs", consoleOrgs)
      .handle("consoleSwitch", consoleSwitch)
      .handle("tool", tool)
      .handle("toolIDs", toolIDs)
      .handle("worktree", worktree)
      .handle("worktreeCreate", worktreeCreate)
      .handle("worktreeRemove", worktreeRemove)
      .handle("worktreeReset", worktreeReset)
      .handle("session", session)
      .handle("resource", resource)
  }),
)
