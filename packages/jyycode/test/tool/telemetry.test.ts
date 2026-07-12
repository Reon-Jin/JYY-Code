import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Bus } from "@/bus"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { SessionTools } from "@/session/tools"
import { MessageID, SessionID } from "@/session/schema"
import { ToolTelemetry } from "@/tool/telemetry"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { ProviderTest } from "../fake/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestConfig } from "../fixture/config"

const Parameters = Schema.Struct({ query: Schema.String })
const provider = ProviderTest.fake()

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

const session = {
  id: SessionID.make("ses_tool_telemetry"),
  permission: [],
} as any

const message = {
  id: MessageID.ascending(),
} as any

function def(id: string, execute: Tool.Def<typeof Parameters>["execute"]): Tool.Def<typeof Parameters> {
  return {
    id,
    description: `${id} test tool`,
    parameters: Parameters,
    catalog: { category: "other", mutability: "read", risk: "low" },
    execute,
  }
}

function registryLayer(tools: Tool.Def[]) {
  const read = tools[0] as any
  return Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed(tools.map((item) => item.id)),
      all: () => Effect.succeed(tools),
      named: () => Effect.succeed({ task: read, read }),
      tools: () => Effect.succeed(tools),
    }),
  )
}

const mcpLayer = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    toolDefs: () => Effect.succeed([]),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: {} }),
    connect: () => Effect.void as any,
    disconnect: () => Effect.void as any,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("not implemented"),
    authenticate: () => Effect.die("not implemented"),
    finishAuth: () => Effect.die("not implemented"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed({ type: "none" } as any),
  }),
)

const pluginLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    list: () => Effect.succeed([]),
    trigger: (_name, _input, output) => Effect.succeed(output),
  }),
)

const permissionLayer = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    ask: () => Effect.void,
    reply: () => Effect.void,
    list: () => Effect.succeed([]),
  }),
)

const baseLayer = Layer.mergeAll(
  Bus.layer,
  pluginLayer,
  permissionLayer,
  mcpLayer,
  Truncate.defaultLayer,
  RuntimeFlags.layer(),
  TestConfig.layer(),
)
const it = testEffect(baseLayer)

function processor() {
  return {
    message,
    updateToolCall: () => Effect.succeed(undefined),
    completeToolCall: () => Effect.void,
  }
}

describe("ToolTelemetry", () => {
  it.instance("publishes catalog resolution events from session tool resolution", () =>
    Effect.gen(function* () {
      const events: Array<{ type: string; properties: any }> = []
      const bus = yield* Bus.Service
      const off = yield* bus.subscribeAllCallback((event) => events.push(event))
      const layer = registryLayer([
        def("lookup", () => Effect.succeed({ title: "Lookup", output: "ok", metadata: {} })),
      ])

      yield* SessionTools.resolve({
        agent,
        model: provider.model,
        session,
        processor: processor(),
        bypassAgentCheck: false,
        messages: [],
        promptOps: {} as any,
      }).pipe(Effect.provide(layer))
      const catalog = yield* pollWithTimeout(
        Effect.sync(() => events.find((event) => event.type === ToolTelemetry.Event.CatalogResolved.type)),
        "catalog telemetry event not published",
      )
      off()

      expect(catalog.properties.toolIDs).toEqual(["lookup"])
      expect(catalog.properties.toolCount).toBe(1)
      expect(catalog.properties.schemaBytes).toBeGreaterThan(0)
    }),
  )

  it.instance("publishes execution completion events", () =>
    Effect.gen(function* () {
      const events: Array<{ type: string; properties: any }> = []
      const bus = yield* Bus.Service
      const off = yield* bus.subscribeAllCallback((event) => events.push(event))

      yield* ToolTelemetry.executionCompleted(bus, {
        sessionID: session.id,
        messageID: message.id,
        callID: "call_explode",
        tool: "explode",
        success: false,
        status: "error",
        durationMs: 12,
        error: "boom",
      })
      const completed = yield* pollWithTimeout(
        Effect.sync(() =>
          events.find(
            (event) =>
              event.type === ToolTelemetry.Event.ExecutionCompleted.type && event.properties.tool === "explode",
          ),
        ),
        "failed execution telemetry event not published",
      )
      off()

      expect(completed.properties).toMatchObject({
        tool: "explode",
        callID: "call_explode",
        success: false,
        status: "error",
        error: "boom",
      })
    }),
  )

  it.instance("publishes tool search query and result telemetry", () =>
    Effect.gen(function* () {
      const events: Array<{ type: string; properties: any }> = []
      const bus = yield* Bus.Service
      const off = yield* bus.subscribeAllCallback((event) => events.push(event))

      yield* ToolTelemetry.searchExecuted(bus, {
        sessionID: session.id,
        messageID: message.id,
        callID: "call_search",
        query: "edit file",
        detail: "schema",
        category: "filesystem",
        resultIDs: ["edit", "apply_patch"],
      })
      const search = yield* pollWithTimeout(
        Effect.sync(() => events.find((event) => event.type === ToolTelemetry.Event.SearchExecuted.type)),
        "search telemetry event not published",
      )
      off()

      expect(search.properties).toMatchObject({
        query: "edit file",
        detail: "schema",
        category: "filesystem",
        matches: 2,
        resultIDs: ["edit", "apply_patch"],
      })
    }),
  )
})
