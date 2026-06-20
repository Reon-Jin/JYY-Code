import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Bus } from "@/bus"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageID, SessionID } from "@/session/schema"
import { SessionTools } from "@/session/tools"
import { ToolDisclosure } from "@/tool/disclosure"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const Params = Schema.Struct({ value: Schema.String })
const it = testEffect(Bus.layer)
const provider = ProviderTest.fake()

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

const session = {
  id: SessionID.make("ses_deferred_session"),
  permission: [],
} as any

const message = {
  id: MessageID.make("msg_deferred_session"),
} as any

function hiddenTool(): Tool.Def<typeof Params> {
  return {
    id: "send_message",
    description: "Send a message",
    parameters: Params,
    catalog: { category: "communication", mutability: "external", risk: "medium" },
    execute: (args) => Effect.succeed({ title: "Sent", output: args.value, metadata: {} }),
  }
}

function hiddenToolRequiringAsk(id: string): Tool.Def<typeof Params> {
  return {
    id,
    description: "Send a message",
    parameters: Params,
    catalog: { category: "communication", mutability: "external", risk: "medium" },
    execute: (args, ctx) =>
      Effect.gen(function* () {
        yield* ctx.ask({ permission: id, patterns: ["*"], always: ["*"], metadata: {} })
        return { title: "Sent", output: args.value, metadata: {} }
      }),
  }
}

function fakeContext(callID: string, overrides: Partial<Tool.Context> = {}): Tool.Context {
  return {
    sessionID: SessionID.make("ses_deferred_tool"),
    messageID: MessageID.make("msg_deferred_tool"),
    callID,
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
    ...overrides,
  }
}

function sessionLayer() {
  const SearchParams = Schema.Struct({
    query: Schema.String,
    limit: Schema.optional(Schema.Number),
    detail: Schema.optional(Schema.Literals(["summary", "schema", "full"])),
    category: Schema.optional(Schema.String),
  })
  const EmptyParams = Schema.Struct({})
  const JiraParams = Schema.Struct({ query: Schema.String })
  const read: Tool.Def<typeof EmptyParams> = {
    id: "read",
    description: "Read files",
    parameters: EmptyParams,
    catalog: { category: "filesystem", mutability: "read", risk: "low", detail: "core" },
    execute: () => Effect.succeed({ title: "Read", output: "read", metadata: {} }),
  }
  const toolSearch: Tool.Def<typeof SearchParams> = {
    id: "tool_search",
    description: "Search tools",
    parameters: SearchParams,
    catalog: { category: "other", mutability: "read", risk: "low", detail: "core" },
    execute: () => Effect.succeed({ title: "Tool search", output: "", metadata: { resultIDs: [] } }),
  }
  const jira: Tool.Def<typeof JiraParams> = {
    id: "jira_search",
    description: "Search Jira issues",
    parameters: JiraParams,
    catalog: { category: "mcp", mutability: "external", risk: "medium", tags: ["jira", "issue", "search"] },
    execute: (args) => Effect.succeed({ title: "Jira", output: `issue ${args.query}`, metadata: {} }),
  }

  return Layer.mergeAll(
    Bus.layer,
    RuntimeFlags.layer({ experimentalDeferredTools: true, deferredToolThreshold: 1 }),
    Layer.succeed(
      ToolRegistry.Service,
      ToolRegistry.Service.of({
        ids: () => Effect.succeed(["read"]),
        all: () => Effect.succeed([read]),
        named: () => Effect.succeed({ task: read as any, read: read as any }),
        tools: () => Effect.succeed([toolSearch, read]),
      }),
    ),
    Layer.succeed(
      MCP.Service,
      MCP.Service.of({
        status: () => Effect.succeed({}),
        clients: () => Effect.succeed({}),
        tools: () => Effect.succeed({}),
        toolDefs: () => Effect.succeed([jira]),
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
        getAuthStatus: () => Effect.succeed("not_authenticated"),
      }),
    ),
    Layer.succeed(
      Plugin.Service,
      Plugin.Service.of({
        init: () => Effect.void,
        list: () => Effect.succeed([]),
        trigger: (_name, _input, output) => Effect.succeed(output),
      }),
    ),
    Layer.succeed(
      Permission.Service,
      Permission.Service.of({
        ask: () => Effect.void,
        reply: () => Effect.void,
        list: () => Effect.succeed([]),
      }),
    ),
  )
}

function processor() {
  return {
    message,
    updateToolCall: () => Effect.succeed(undefined),
    completeToolCall: () => Effect.void,
  }
}

function fakeAiSdkOptions(toolCallId: string) {
  return { toolCallId, abortSignal: new AbortController().signal } as any
}

describe("tool_exec", () => {
  it.instance("executes hidden tools by id", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const exec = ToolDisclosure.toolExecDef({
        hidden: [hiddenTool()],
        directIDs: new Set(["read"]),
        bus,
      })

      const result = yield* exec.execute(
        { tool: "send_message", args: { value: "hello" } },
        fakeContext("call_exec"),
      )

      expect(result.output).toBe("hello")
      expect(result.metadata).toMatchObject({ delegatedTool: "send_message" })
    }),
  )

  it.instance("resolves MCP tools behind search and tool_exec in deferred mode", () =>
    Effect.gen(function* () {
      const tools = yield* SessionTools.resolve({
        agent,
        model: provider.model,
        session,
        processor: processor(),
        bypassAgentCheck: false,
        messages: [],
        promptOps: {} as any,
      })

      expect(Object.keys(tools)).toContain("tool_search")
      expect(Object.keys(tools)).toContain("tool_exec")
      expect(Object.keys(tools)).toContain("read")
      expect(Object.keys(tools)).not.toContain("jira_search")

      const search = yield* Effect.promise(() =>
        tools.tool_search.execute?.(
          { query: "jira issue search", limit: 3, detail: "schema" },
          fakeAiSdkOptions("call_search"),
        ) as Promise<any>,
      )
      expect(String(search.output)).toContain("jira_search")

      const exec = yield* Effect.promise(() =>
        tools.tool_exec.execute?.(
          { tool: "jira_search", args: { query: "ABC-123" } },
          fakeAiSdkOptions("call_exec"),
        ) as Promise<any>,
      )
      expect(String(exec.output)).toContain("ABC-123")
    }).pipe(Effect.provide(sessionLayer())),
  )

  it.instance("does not execute direct tools", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const exec = ToolDisclosure.toolExecDef({
        hidden: [hiddenTool()],
        directIDs: new Set(["read"]),
        bus,
      })

      const effect = exec.execute({ tool: "read", args: {} }, fakeContext("call_direct"))

      yield* Effect.flip(effect).pipe(
        Effect.map((error) => expect(String(error)).toContain("not available through tool_exec")),
      )
    }),
  )

  it.instance("asks permission for delegated hidden tool identity", () =>
    Effect.gen(function* () {
      const asked: string[] = []
      const exec = ToolDisclosure.toolExecDef({
        hidden: [hiddenToolRequiringAsk("send_message")],
        directIDs: new Set(["read"]),
        bus: yield* Bus.Service,
      })

      yield* exec.execute(
        { tool: "send_message", args: { value: "hello" } },
        fakeContext("call_exec", {
          ask: (req) =>
            Effect.sync(() => {
              asked.push(req.permission)
            }),
        }),
      )

      expect(asked).toEqual(["send_message"])
    }),
  )
})
