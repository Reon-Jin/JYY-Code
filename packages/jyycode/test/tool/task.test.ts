import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { AgentClusterTaskTable } from "@/agent-cluster/cluster.sql"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { TaskTool, type TaskGitOps, type TaskPromptOps, type TaskWorktreeOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Database from "@/storage/db"
import { ProviderTest } from "../fake/provider"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import path from "path"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    RuntimeFlags.layer(flags),
    ProviderTest.fake({
      model: ProviderTest.model({
        id: ref.modelID,
        providerID: ref.providerID,
      }),
    }).layer,
  )

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
    loop: (input) => Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, opts?.text ?? "done")),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function gitResult(text = "", exitCode = 0) {
  return {
    exitCode,
    text: () => text,
    stdout: Buffer.from(text),
    stderr: Buffer.alloc(0),
    truncated: false,
  }
}

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const schema = (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)
          ?.jsonSchema as { properties?: { subagent_type?: { enum?: string[] } } } | undefined
        expect(schema?.properties?.subagent_type?.enum).toEqual([
          "alpha",
          "analyst",
          "chart",
          "coder",
          "explore",
          "general",
          "office",
          "researcher",
          "tester",
          "writer",
          "zebra",
        ])

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
        expect(description).not.toContain("- shadow: Shadow agent")

        const task = (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)
        const schema = task?.jsonSchema as { properties?: { subagent_type?: { enum?: string[] } } } | undefined
        expect(schema?.properties?.subagent_type?.enum).toContain("alpha")
        expect(schema?.properties?.subagent_type?.enum).not.toContain("zebra")
        expect(schema?.properties?.subagent_type?.enum).not.toContain("shadow")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
          shadow: {
            description: "Shadow agent",
            mode: "subagent",
            hidden: true,
          },
        },
      },
    },
  )

  it.instance("tool_search searches the current tool catalog", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({ ...ref, agent: build })
      const search = tools.find((tool) => tool.id === "tool_search")
      expect(search).toBeTruthy()

      const result = yield* search!.execute(
        { query: "subagent task", limit: 3 },
        {
          sessionID: SessionID.make("ses_tool_search"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          extra: {},
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("- task")
      expect(result.output).toContain("subagent_type")
      expect(result.metadata).toMatchObject({ matches: expect.any(Number), detail: "summary" })
    }),
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`task_id: ${child.id}`)
      expect(seen?.sessionID).toBe(child.id)
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
        loop: (input) => Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "done")),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`task_id: ${result.metadata.sessionId}`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance("execute with fork injects recent parent context into the child prompt", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const parentUser = yield* sessions.findMessage(chat.id, (item) => item.info.role === "user").pipe(Effect.orDie)
      if (parentUser._tag === "Some") {
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: parentUser.value.info.id,
          sessionID: chat.id,
          type: "text",
          text: "Parent found the cache key bug in src/cache.ts",
        })
      }
      const parentMessages = yield* sessions.messages({ sessionID: chat.id })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "forked", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "continue fix",
          prompt: "Patch only the cache key bug.",
          subagent_type: "general",
          fork: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: parentMessages,
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.fork).toBe(true)
      const text = seen?.parts.find((part) => part.type === "text")?.text ?? ""
      expect(text).toContain("<forked-context>")
      expect(text).toContain("Parent found the cache key bug in src/cache.ts")
      expect(text).toContain("<directive>")
      expect(text).toContain("Patch only the cache key bug.")
    }),
  )

  it.instance("execute passes structured context parts to the child prompt", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined

      yield* def.execute(
        {
          description: "inspect context",
          prompt: "Use the supplied context.",
          subagent_type: "general",
          context: [
            { type: "text", value: "Regression started after changing cache keys.", note: "summary" },
            { type: "file", value: "src/cache.ts", note: "suspect" },
            { type: "directory", value: "test/cache", note: "focused tests" },
          ],
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const text = seen?.parts.find((part) => part.type === "text")?.text ?? ""
      expect(text).toContain("<task-context>")
      expect(text).toContain("Regression started after changing cache keys.")
      expect(seen?.parts.filter((part) => part.type === "file")).toEqual([
        expect.objectContaining({ mime: "text/plain", filename: path.resolve(chat.directory, "src/cache.ts") }),
        expect.objectContaining({
          mime: "application/x-directory",
          filename: path.resolve(chat.directory, "test/cache"),
        }),
      ])
    }),
  )

  it.instance("rejects recursive fork tasks", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed("continue fix (@general fork)")
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "recursive fork",
            prompt: "Fork again",
            subagent_type: "general",
            fork: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("execute with worktree isolation creates child session in the isolated directory", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      let requestedName: string | undefined
      const worktreeInfo = {
        name: "inspect-cache",
        branch: "jyycode/inspect-cache",
        directory: "/tmp/jyycode-worktree/inspect-cache",
      }
      const worktreeOps: TaskWorktreeOps = {
        create: (input) =>
          Effect.sync(() => {
            requestedName = input?.name
            return worktreeInfo
          }),
      }

      const result = yield* def.execute(
        {
          description: "inspect cache",
          prompt: "Patch the cache bug and run focused tests.",
          subagent_type: "general",
          isolation: "worktree",
          worktree_name: "inspect-cache",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }), worktreeOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const child = yield* sessions.get(result.metadata.sessionId)
      expect(requestedName).toBe("inspect-cache")
      expect(child.directory).toBe(worktreeInfo.directory)
      expect(child.permission).toContainEqual(
        expect.objectContaining({
          permission: "external_directory",
          action: "allow",
        }),
      )
      expect(result.metadata.isolation).toBe("worktree")
      expect(result.metadata.worktree).toEqual(worktreeInfo)
      const text = seen?.parts.find((part) => part.type === "text")?.text ?? ""
      expect(text).toContain("<worktree-isolation>")
      expect(text).toContain(worktreeInfo.directory)
      expect(text).toContain("Patch the cache bug and run focused tests.")
    }),
  )

  it.instance("execute with worktree auto-merge commits child changes and merges into parent branch", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const worktreeInfo = {
        name: "merge-cache",
        branch: "jyycode/merge-cache",
        directory: "/tmp/jyycode-worktree/merge-cache",
      }
      const calls: string[] = []
      const worktreeOps: TaskWorktreeOps = {
        create: () => Effect.succeed(worktreeInfo),
      }
      const gitOps: TaskGitOps = {
        branch: () => Effect.succeed("jyycode/merge-cache"),
        patchAll: () => Effect.succeed({ text: "diff --git a/src/cache.ts b/src/cache.ts", truncated: false }),
        status: (cwd) =>
          Effect.succeed(
            cwd === worktreeInfo.directory ? [{ file: "src/cache.ts", code: " M", status: "modified" as const }] : [],
          ),
        run: (args, opts) =>
          Effect.sync(() => {
            calls.push(`${opts.cwd}: ${args.join(" ")}`)
            if (args[0] === "diff") return gitResult("M\tsrc/cache.ts\n")
            if (args[0] === "rev-parse") return gitResult("abc123\n")
            return gitResult("")
          }),
      }

      const result = yield* def.execute(
        {
          description: "merge cache",
          prompt: "Patch the cache bug.",
          subagent_type: "general",
          isolation: "worktree",
          merge: "auto",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "child done" }), worktreeOps, gitOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.merge).toBe("auto")
      expect(result.output).toContain("<worktree_review>")
      expect(result.output).toContain("state: merged")
      expect(result.output).toContain("Parent HEAD is abc123")
      expect(calls).toContain(`${worktreeInfo.directory}: add -A`)
      expect(calls).toContain(`${worktreeInfo.directory}: commit -m Task: merge cache`)
      expect(calls).toContain(`${chat.directory}: merge --no-ff --no-edit jyycode/merge-cache`)
    }),
  )

  it.instance("execute with worktree auto-merge blocks when parent worktree is dirty", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const worktreeInfo = {
        name: "blocked-cache",
        branch: "jyycode/blocked-cache",
        directory: "/tmp/jyycode-worktree/blocked-cache",
      }
      const calls: string[] = []
      const worktreeOps: TaskWorktreeOps = {
        create: () => Effect.succeed(worktreeInfo),
      }
      const gitOps: TaskGitOps = {
        branch: () => Effect.succeed("jyycode/blocked-cache"),
        patchAll: () => Effect.succeed({ text: "", truncated: false }),
        status: (cwd) =>
          Effect.succeed(
            cwd === chat.directory ? [{ file: "README.md", code: " M", status: "modified" as const }] : [],
          ),
        run: (args, opts) =>
          Effect.sync(() => {
            calls.push(`${opts.cwd}: ${args.join(" ")}`)
            return gitResult("")
          }),
      }

      const result = yield* def.execute(
        {
          description: "blocked merge",
          prompt: "Patch the cache bug.",
          subagent_type: "general",
          isolation: "worktree",
          merge: "auto",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "child done" }), worktreeOps, gitOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("state: blocked")
      expect(result.output).toContain("parent worktree has local changes")
      expect(calls.some((call) => call.includes(": merge "))).toBe(false)
    }),
  )

  it.instance("rejects automatic merge without worktree isolation", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "bad merge",
            prompt: "Patch the cache bug.",
            subagent_type: "general",
            merge: "auto",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("rejects worktree isolation when resuming an existing task", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "resume isolated",
            prompt: "continue",
            subagent_type: "general",
            task_id: child.id,
            isolation: "worktree",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "qa_helper",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "allow",
          },
          {
            permission: "read",
            pattern: "*",
            action: "allow",
          },
        ])
        expect(seen?.tools).toEqual({
          todowrite: false,
          bash: false,
          read: false,
        })
      }),
    {
      config: {
        agent: {
          qa_helper: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("state: running")
      expect(job?.status).toBe("running")
    }),
  )

  it.instance("cluster agent launches tasks in the background without the experiment flag", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "cluster",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("state: running")
      expect(job?.status).toBe("running")
    }),
  )

  it.instance(
    "cluster task updates agent_cluster_task child session",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const planTaskID = "task-binding-research"
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: assistant.parentID!,
          sessionID: chat.id,
          type: "text",
          synthetic: true,
          metadata: { kind: "agent_cluster", sessionID: chat.id },
          text: "Agent cluster instructions",
        })
        const messages = yield* sessions.messages({ sessionID: chat.id })
        Database.use((db) => {
          const now = Date.now()
          db.insert(AgentClusterTaskTable)
            .values({
              id: planTaskID as any,
              session_id: chat.id,
              origin_message_id: assistant.parentID!,
              role: "researcher",
              title: "Research",
              prompt: "Find the bug",
              complexity: "simple",
              model: "-",
              status: "planned",
              acceptance_criteria: ["done"],
              artifact_paths: [],
              time_created: now,
              time_updated: now,
            })
            .run()
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            task_id: planTaskID,
            model: "test/does-not-exist",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "cluster",
            abort: new AbortController().signal,
            extra: {
              agentClusterSessionID: chat.id,
              promptOps: {
                ...stubOps(),
                prompt: () => Effect.never,
              } satisfies TaskPromptOps,
            },
            messages,
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const row = Database.use((db) =>
          db
            .select()
            .from(AgentClusterTaskTable)
            .where(
              Database.and(
                Database.eq(AgentClusterTaskTable.session_id, chat.id),
                Database.eq(AgentClusterTaskTable.id, planTaskID as any),
              ),
            )
            .get(),
        )
        expect(row?.child_session_id).toBe(result.metadata.sessionId)
        expect(row?.status).toBe("running")
        expect(row?.model).toBe("test/test-model")
        expect(result.metadata.model).toEqual(ref)
      }),
    {
      config: {
        agent_cluster: {
          simple_model: "test/test-model",
          complex_model: "test/test-model",
          visual_model: "test/test-model",
        },
      },
    },
  )

  it.instance("cluster task reuses a completed subagent from an earlier turn", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Reusable researcher" })
      const currentTaskID = "task-follow-up"

      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.parentID!,
        sessionID: chat.id,
        type: "text",
        synthetic: true,
        metadata: { kind: "agent_cluster", sessionID: chat.id },
        text: "Agent cluster instructions",
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: chat.id,
        type: "text",
        text: [
          "```json",
          JSON.stringify({
            goal: "Continue the investigation",
            tasks: [
              {
                id: currentTaskID,
                step: 1,
                title: "Follow up",
                role: "researcher",
                complexity: "simple",
                model: "test/test-model",
                dependencies: [],
                prompt: "Continue from prior findings",
                acceptanceCriteria: ["follow-up complete"],
                expectedArtifacts: [],
              },
            ],
          }),
          "```",
        ].join("\n"),
      })

      Database.use((db) => {
        const now = Date.now()
        db.insert(AgentClusterTaskTable)
          .values([
            {
              id: "task-initial" as any,
              session_id: chat.id,
              origin_message_id: assistant.parentID!,
              child_session_id: child.id,
              role: "researcher",
              title: "Initial research",
              prompt: "Investigate",
              complexity: "simple",
              model: "test/test-model",
              status: "accepted",
              acceptance_criteria: ["done"],
              artifact_paths: [],
              time_created: now,
              time_updated: now,
            },
            {
              id: currentTaskID as any,
              session_id: chat.id,
              origin_message_id: assistant.parentID!,
              role: "researcher",
              title: "Follow up",
              prompt: "Continue from prior findings",
              complexity: "simple",
              model: "test/test-model",
              status: "planned",
              acceptance_criteria: ["follow-up complete"],
              artifact_paths: [],
              time_created: now,
              time_updated: now,
            },
          ])
          .run()
      })

      const messages = yield* sessions.messages({ sessionID: chat.id })
      const def = yield* (yield* TaskTool).init()
      const result = yield* def.execute(
        {
          description: "continue research",
          prompt: "Use the earlier context and investigate the follow-up",
          subagent_type: "general",
          task_id: currentTaskID,
          resume_session_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "cluster",
          abort: new AbortController().signal,
          extra: {
            agentClusterSessionID: chat.id,
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages,
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const row = Database.use((db) =>
        db
          .select()
          .from(AgentClusterTaskTable)
          .where(
            Database.and(
              Database.eq(AgentClusterTaskTable.session_id, chat.id),
              Database.eq(AgentClusterTaskTable.id, currentTaskID as any),
            ),
          )
          .get(),
      )
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.metadata.reusedSession).toBe(true)
      expect(row?.child_session_id).toBe(child.id)
      expect(row?.status).toBe("running")
    }),
  )

  it.instance("cluster task persists the streamed plan before its first dispatch", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const planTaskID = "task-research"
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.parentID!,
        sessionID: chat.id,
        type: "text",
        synthetic: true,
        metadata: { kind: "agent_cluster", sessionID: chat.id },
        text: "Agent cluster instructions",
      })
      yield* sessions
        .updatePart({
          id: PartID.ascending(),
          messageID: assistant.id,
          sessionID: chat.id,
          type: "text",
          text: [
            "```json",
            JSON.stringify({
              goal: "Investigate bug",
              tasks: [
                {
                  id: planTaskID,
                  step: 1,
                  title: "Research",
                  role: "researcher",
                  complexity: "simple",
                  model: "test/test-model",
                  dependencies: [],
                  prompt: "Find the bug",
                  acceptanceCriteria: ["root cause documented"],
                  expectedArtifacts: [],
                },
              ],
            }),
            "```",
          ].join("\n"),
        })
        .pipe(Effect.delay("2 seconds"), Effect.forkScoped)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "researcher",
          task_id: planTaskID,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "cluster",
          abort: new AbortController().signal,
          extra: {
            agentClusterSessionID: chat.id,
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages,
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const row = Database.use((db) =>
        db
          .select()
          .from(AgentClusterTaskTable)
          .where(
            Database.and(
              Database.eq(AgentClusterTaskTable.session_id, chat.id),
              Database.eq(AgentClusterTaskTable.id, planTaskID as any),
            ),
          )
          .get(),
      )
      expect(row?.child_session_id).toBe(result.metadata.sessionId)
      expect(row?.status).toBe("running")
    }),
  )

  it.instance("cluster task prefers the live assistant plan before TUI message projection catches up", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const planTaskID = "create-1"
      const livePlanText = [
        "```json",
        JSON.stringify({
          goal: "Create and combine text files",
          tasks: [
            {
              id: planTaskID,
              step: 1,
              title: "Create 1.txt",
              role: "coder",
              complexity: "simple",
              model: "test/test-model",
              dependencies: [],
              prompt: "Create 1.txt containing 123",
              acceptanceCriteria: ["1.txt contains 123"],
              expectedArtifacts: ["1.txt"],
            },
            {
              id: "create-2",
              step: 2,
              title: "Create 2.txt",
              role: "coder",
              complexity: "simple",
              model: "test/test-model",
              dependencies: [planTaskID],
              prompt: "Copy 1.txt into 2.txt",
              acceptanceCriteria: ["2.txt matches 1.txt"],
              expectedArtifacts: ["2.txt"],
            },
            {
              id: "create-3",
              step: 2,
              title: "Create 3.txt",
              role: "coder",
              complexity: "simple",
              model: "test/test-model",
              dependencies: [planTaskID],
              prompt: "Copy 1.txt into 3.txt",
              acceptanceCriteria: ["3.txt matches 1.txt"],
              expectedArtifacts: ["3.txt"],
            },
            {
              id: "create-ans",
              step: 3,
              title: "Create ans.txt",
              role: "coder",
              complexity: "simple",
              model: "test/test-model",
              dependencies: ["create-2", "create-3"],
              prompt: "Combine 1.txt, 2.txt, and 3.txt into ans.txt",
              acceptanceCriteria: ["ans.txt contains all three inputs"],
              expectedArtifacts: ["ans.txt"],
            },
          ],
        }),
        "```",
      ].join("\n")

      // Simulate the TUI projector lagging behind the current stream: DB-backed
      // message reads still expose an older plan while the processor accumulator
      // already contains the authoritative plan immediately before the tool call.
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: chat.id,
        type: "text",
        text: [
          "```json",
          JSON.stringify({
            goal: "Stale projected plan",
            tasks: [
              {
                id: "stale-task",
                step: 1,
                title: "Stale task",
                role: "researcher",
                complexity: "simple",
                model: "test/test-model",
                dependencies: [],
                prompt: "This task should not be dispatched",
                acceptanceCriteria: ["not used"],
                expectedArtifacts: [],
              },
            ],
          }),
          "```",
        ].join("\n"),
      })
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "create first file",
          prompt: "Create 1.txt containing 123",
          subagent_type: "general",
          task_id: planTaskID,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "cluster",
          abort: new AbortController().signal,
          extra: {
            agentClusterSessionID: chat.id,
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
              currentAssistantText: () => livePlanText,
            } as TaskPromptOps,
          },
          messages,
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const rows = Database.use((db) =>
        db.select().from(AgentClusterTaskTable).where(Database.eq(AgentClusterTaskTable.session_id, chat.id)).all(),
      )
      expect(rows.map((row) => String(row.id)).sort()).toEqual(["create-1", "create-2", "create-3", "create-ans"])
      expect(rows.find((row) => row.id === planTaskID)?.child_session_id).toBe(result.metadata.sessionId)
      expect(rows.find((row) => row.id === planTaskID)?.status).toBe("running")
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent resume loop", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.noReply
                  ? Effect.gen(function* () {
                      const user = yield* sessions.updateMessage({
                        id: input.messageID ?? MessageID.ascending(),
                        role: "user",
                        sessionID: input.sessionID,
                        agent: input.agent ?? "build",
                        model: input.model ?? ref,
                        time: { created: Date.now() },
                      })
                      const parts = input.parts.map((part) => ({
                        ...part,
                        id: part.id ?? PartID.ascending(),
                        messageID: user.id,
                        sessionID: input.sessionID,
                      }))
                      yield* Effect.forEach(parts, (part) => sessions.updatePart(part), { discard: true })
                      return { info: user, parts }
                    })
                  : Effect.succeed(reply(input, "background done")),
              loop: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )

  function seedClusterTask(input: { taskID: string; sessionID: SessionID; parentMessageID: MessageID }) {
    const now = Date.now()
    Database.use((db) => {
      db.insert(AgentClusterTaskTable)
        .values({
          id: input.taskID as any,
          session_id: input.sessionID,
          origin_message_id: input.parentMessageID,
          role: "chart",
          title: "Make charts",
          prompt: "Create the charts",
          complexity: "simple",
          model: "test/test-model",
          status: "planned",
          acceptance_criteria: ["charts created"],
          artifact_paths: [],
          time_created: now,
          time_updated: now,
        })
        .run()
    })
  }

  function clusterTaskRow(sessionID: SessionID, taskID: string) {
    return Database.use((db) =>
      db
        .select()
        .from(AgentClusterTaskTable)
        .where(
          Database.and(
            Database.eq(AgentClusterTaskTable.session_id, sessionID),
            Database.eq(AgentClusterTaskTable.id, taskID as any),
          ),
        )
        .get(),
    )
  }

  background.instance("cluster subagent ending with an error marks the task failed instead of submitted", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const taskID = "task-chart"
      seedClusterTask({ taskID, sessionID: chat.id, parentMessageID: assistant.parentID! })
      const messages = yield* (yield* Session.Service).messages({ sessionID: chat.id })
      const def = yield* (yield* TaskTool).init()

      const result = yield* def.execute(
        {
          description: "make charts",
          prompt: "Create the charts",
          subagent_type: "chart",
          task_id: taskID,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "cluster",
          abort: new AbortController().signal,
          extra: {
            agentClusterSessionID: chat.id,
            promptOps: {
              ...stubOps(),
              prompt: (input) =>
                Effect.sync(() => {
                  const base = reply(input, "partial output before the stream died")
                  return {
                    ...base,
                    info: {
                      ...base.info,
                      error: { name: "APIError", data: { message: "provider exploded" } } as any,
                    },
                  }
                }),
            } satisfies TaskPromptOps,
          },
          messages,
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("error")
      expect(waited.info?.error).toContain("provider exploded")
      const row = clusterTaskRow(chat.id, taskID)
      expect(row?.status).toBe("failed")
      expect((row?.review_issues as string[] | null)?.[0]).toContain("provider exploded")
    }),
  )

  background.instance("cluster subagent without a final report gets one recovery turn to deliver", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const taskID = "task-chart"
      seedClusterTask({ taskID, sessionID: chat.id, parentMessageID: assistant.parentID! })
      const messages = yield* (yield* Session.Service).messages({ sessionID: chat.id })
      const def = yield* (yield* TaskTool).init()
      const prompts: SessionPrompt.PromptInput[] = []

      const result = yield* def.execute(
        {
          description: "make charts",
          prompt: "Create the charts",
          subagent_type: "chart",
          task_id: taskID,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "cluster",
          abort: new AbortController().signal,
          extra: {
            agentClusterSessionID: chat.id,
            promptOps: {
              ...stubOps(),
              prompt: (input) =>
                Effect.sync(() => {
                  prompts.push(input)
                  const recovery =
                    input.sessionID !== chat.id && input.parts.some((part) => part.type === "text" && part.synthetic)
                  return reply(
                    input,
                    recovery
                      ? "**Status**: success\n**Summary**: charts created\n\nDeliverable."
                      : "still working on chart 3 of 4",
                  )
                }),
            } satisfies TaskPromptOps,
          },
          messages,
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toContain("**Status**: success")
      const recovery = prompts.find(
        (input) => input.sessionID !== chat.id && input.parts.some((part) => part.type === "text" && part.synthetic),
      )
      expect(recovery).toBeDefined()
      const reminder = recovery?.parts.find((part) => part.type === "text")
      expect(reminder && "text" in reminder ? reminder.text : "").toContain("final report")
      const row = clusterTaskRow(chat.id, taskID)
      expect(row?.status).toBe("submitted")
      expect(row?.result_summary).toBe("charts created")
    }),
  )

  background.instance("cluster subagent still missing its final report after recovery fails the task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const taskID = "task-chart"
      seedClusterTask({ taskID, sessionID: chat.id, parentMessageID: assistant.parentID! })
      const messages = yield* (yield* Session.Service).messages({ sessionID: chat.id })
      const def = yield* (yield* TaskTool).init()

      const result = yield* def.execute(
        {
          description: "make charts",
          prompt: "Create the charts",
          subagent_type: "chart",
          task_id: taskID,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "cluster",
          abort: new AbortController().signal,
          extra: {
            agentClusterSessionID: chat.id,
            promptOps: stubOps({ text: "still working on chart 3 of 4" }),
          },
          messages,
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("error")
      expect(waited.info?.error).toContain("final report")
      const row = clusterTaskRow(chat.id, taskID)
      expect(row?.status).toBe("failed")
      expect((row?.review_issues as string[] | null)?.[0]).toContain("final report")
    }),
  )
})
