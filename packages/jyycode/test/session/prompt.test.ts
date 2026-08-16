import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { expect, test } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath, pathToFileURL } from "url"
import { NamedError } from "@jyycode-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { BackgroundProcess } from "@/process/job"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionMessageTable } from "../../src/session/session.sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { normalizeGeneratedTitle, SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "../../src/v2/session"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Memory } from "@/memory/memory"
import { EpisodicMemory } from "@/memory/episodic"
import { ExperienceMemory } from "@/memory/experience"
import { Shell } from "../../src/shell/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import * as Log from "@jyycode-ai/core/util/log"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import * as Database from "../../src/storage/db"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { Reference } from "../../src/reference/reference"
import { RepositoryCache } from "../../src/reference/repository-cache"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventRuntime } from "@/event-runtime"
import { clearChildBudget, defaultPlanProtocol, registerChildBudget, resolveChildBudget } from "../../src/plan/protocol"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

test("normalizes only concise one-line generated titles", () => {
  expect(normalizeGeneratedTitle("<think>ignore</think>\n淇澶氭櫤鑳戒綋鍙充晶鏍?)).toBe("淇澶氭櫤鑳戒綋鍙充晶鏍?)
  expect(
    normalizeGeneratedTitle(
      "I'll analyze your request and create a comprehensive plan before making the requested changes.",
    ),
  ).toBeUndefined()
  expect(normalizeGeneratedTitle("First line\nSecond line")).toBeUndefined()
})

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: MessageV2.Part[]) {
  return parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
}

type CompletedToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }

function completedTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    toolDefs: () => Effect.succeed([]),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const memoryLifecycleUpdates: Array<{ sessionID: SessionID; phase: "received" | "before_final" }> = []
let memoryStepBeginGate: Deferred.Deferred<void> | undefined
const memoryLifecycleLayer = Layer.succeed(
  Memory.Service,
  Memory.Service.of({
    dir: () => Effect.succeed(Memory.DIRECTORY),
    resolveProjectID: (sessionID) => Effect.succeed(String(sessionID)),
    ensure: () => Effect.void,
    read: () => Effect.succeed(""),
    upsertTaskMemory: () => Effect.die("unexpected direct task memory upsert"),
    upsertUserMemory: () => Effect.die("unexpected direct user memory upsert"),
    write: () => Effect.die("unexpected direct memory write"),
    replaceBySubstring: () => Effect.die("unexpected direct memory replace"),
    removeBySubstring: () => Effect.die("unexpected direct memory remove"),
    compact: () => Effect.die("unexpected direct memory compact"),
    usage: (_sessionID, scope) => Effect.succeed({ percentage: 0, used: 0, limit: 1, scope }),
    formatWithHeader: () => Effect.succeed(""),
    currentTaskKeywords: () => Effect.succeed([]),
    currentTaskContent: () => Effect.succeed(undefined),
    updateStepBegin: (sessionID) =>
      Effect.gen(function* () {
        memoryLifecycleUpdates.push({ sessionID, phase: "received" })
        if (memoryStepBeginGate) yield* Deferred.await(memoryStepBeginGate)
        return { status: "updated" as const, taskUpdated: true, userUpdated: 0, experienceCandidates: [] }
      }),
    updateAfterTurn: (sessionID) =>
      Effect.sync(() => {
        memoryLifecycleUpdates.push({ sessionID, phase: "before_final" })
        return { status: "updated" as const, taskUpdated: true, userUpdated: 0, experienceCandidates: [] }
      }),
  }),
)

const memoryFailureLayer = Layer.succeed(
  Memory.Service,
  Memory.Service.of({
    dir: () => Effect.succeed(Memory.DIRECTORY),
    resolveProjectID: (sessionID) => Effect.succeed(String(sessionID)),
    ensure: () => Effect.void,
    read: () => Effect.succeed(""),
    upsertTaskMemory: () => Effect.die("unexpected direct task memory upsert"),
    upsertUserMemory: () => Effect.die("unexpected direct user memory upsert"),
    write: () => Effect.die("unexpected memory write"),
    replaceBySubstring: () => Effect.die("unexpected memory replace"),
    removeBySubstring: () => Effect.die("unexpected memory remove"),
    compact: () => Effect.die("unexpected memory compact"),
    usage: (_sessionID, scope) => Effect.succeed({ percentage: 0, used: 0, limit: 1, scope }),
    formatWithHeader: () => Effect.succeed(""),
    currentTaskKeywords: () => Effect.succeed([]),
    currentTaskContent: () => Effect.succeed(undefined),
    updateStepBegin: () => Effect.fail(new Error("Task memory 褰撳墠浠诲姟 must not exceed 120 characters")),
    updateAfterTurn: () => Effect.fail(new Error("memory completion update failed")),
  }),
)

const snapshotMemoryLayer = Layer.succeed(
  Memory.Service,
  Memory.Service.of({
    dir: () => Effect.succeed(Memory.DIRECTORY),
    resolveProjectID: (sessionID) => Effect.succeed(String(sessionID)),
    ensure: () => Effect.void,
    read: () => Effect.succeed(""),
    upsertTaskMemory: () => Effect.die("unexpected direct task memory upsert"),
    upsertUserMemory: () => Effect.die("unexpected direct user memory upsert"),
    write: () => Effect.die("unexpected direct memory write"),
    replaceBySubstring: () => Effect.die("unexpected direct memory replace"),
    removeBySubstring: () => Effect.die("unexpected direct memory remove"),
    compact: () => Effect.die("unexpected direct memory compact"),
    usage: (_sessionID, scope) => Effect.succeed({ percentage: 0, used: 0, limit: 1, scope }),
    formatWithHeader: () => Effect.succeed("PERSISTENT MEMORY SNAPSHOT"),
    currentTaskKeywords: () => Effect.succeed([]),
    currentTaskContent: () => Effect.succeed(undefined),
    updateStepBegin: () =>
      Effect.succeed({ status: "updated" as const, taskUpdated: true, userUpdated: 0, experienceCandidates: [] }),
    updateAfterTurn: () =>
      Effect.succeed({ status: "updated" as const, taskUpdated: true, userUpdated: 0, experienceCandidates: [] }),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

function makePrompt(input?: {
  processor?: "blocking"
  memory?: Layer.Layer<Memory.Service>
  experience?: Layer.Layer<ExperienceMemory.Service>
  bashDefaultTimeoutMs?: number
}) {
  const runtimeFlags = RuntimeFlags.layer({
    ...(input?.bashDefaultTimeoutMs !== undefined ? { bashDefaultTimeoutMs: input.bashDefaultTimeoutMs } : {}),
  })
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    AppFileSystem.defaultLayer,
    BackgroundJob.defaultLayer,
    BackgroundProcess.defaultLayer,
    status,
    SyncEvent.defaultLayer,
    EventRuntime.defaultLayer,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(RepositoryCache.defaultLayer),
    Layer.provide(Git.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(runtimeFlags),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc =
    input?.processor === "blocking"
      ? blockingProcessor
      : SessionProcessor.layer.pipe(
          Layer.provide(summary),
          Layer.provide(Image.defaultLayer),
          Layer.provide(runtimeFlags),
          Layer.provideMerge(deps),
        )
  const compact = SessionCompaction.layer.pipe(
    Layer.provide(runtimeFlags),
    Layer.provideMerge(proc),
    Layer.provideMerge(deps),
  )
  const promptLayer = SessionPrompt.layer.pipe(
    Layer.provide(EpisodicMemory.defaultLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(summary),
    Layer.provideMerge(run),
    Layer.provideMerge(compact),
    Layer.provideMerge(proc),
    Layer.provideMerge(registry),
    Layer.provideMerge(trunc),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(SystemPrompt.defaultLayer),
    Layer.provide(runtimeFlags),
    Layer.provideMerge(deps),
    Layer.provide(summary),
  )
  let result = promptLayer
  if (input?.experience) result = result.pipe(Layer.provide(input.experience))
  if (input?.memory) result = result.pipe(Layer.provide(input.memory))
  return result
}

function makeHttp(input?: {
  processor?: "blocking"
  memory?: Layer.Layer<Memory.Service>
  experience?: Layer.Layer<ExperienceMemory.Service>
  bashDefaultTimeoutMs?: number
}) {
  return Layer.mergeAll(TestLLMServer.layer, makePrompt(input))
}

function makeHttpNoLLMServer(input?: {
  processor?: "blocking"
  memory?: Layer.Layer<Memory.Service>
  experience?: Layer.Layer<ExperienceMemory.Service>
  bashDefaultTimeoutMs?: number
}) {
  return makePrompt(input)
}

const it = testEffect(makeHttp())
const withMemory = testEffect(makeHttp({ memory: memoryLifecycleLayer }))
const withMemoryLifecycle = testEffect(makeHttp({ memory: memoryLifecycleLayer }))
const withMemoryFailure = testEffect(makeHttp({ memory: memoryFailureLayer }))
const noLLMServer = testEffect(makeHttpNoLLMServer())
const timeoutNoLLMServer = testEffect(makeHttpNoLLMServer({ bashDefaultTimeoutMs: 200 }))
const raceNoLLMServer = testEffect(makeHttpNoLLMServer({ processor: "blocking" }))
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

test("retries an empty DeepSeek JSON-mode response with a corrected prompt", async () => {
  const expected = { shouldUpdate: true, reason: "ok", task: {}, user: [] }
  const prompts: string[] = []
  const result = await SessionPrompt.retryMemoryJsonOutput(async (prompt) => {
    prompts.push(prompt)
    if (prompts.length === 1) throw new Error("empty content")
    return expected
  }, "Return JSON")

  expect(result).toEqual(expected)
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain("previous JSON-mode response was empty or invalid")
})

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.writeWithDirs(file, text)
})

const ensureDir = Effect.fn("test.ensureDir")(function* (dir: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.ensureDir(dir)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<Config.Info>) {
  yield* writeText(
    path.join(dir, "jyycode.json"),
    JSON.stringify({ $schema: "https://jyycode.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<Config.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// Wait for a session's runner to enter a busy state. SessionStatus is flipped to
// "busy" inside Runner.startShell's modifyEffect at the same moment the runner
// is registered, so this is a deterministic readiness signal 鈥?cancel can't
// no-op once we observe it.
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const hasBash = Effect.sync(() => Bun.which("bash") !== null)

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

noLLMServer.instance(
  "loop exits immediately when last assistant has stop finish",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    }),
  { config: cfg },
)

it.instance("loop calls LLM and returns assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    const parts = result.parts.filter((p) => p.type === "text")
    expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

it.instance("keeps the verbatim window contiguous with the episodic digest", () =>
  Effect.gen(function* () {
    const { llm, dir } = yield* useServerConfig(providerCfg)
    const fsys = yield* AppFileSystem.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Episodic",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    for (let turn = 1; turn <= 5; turn++) {
      yield* llm.text(`answer ${turn}`)
      if (turn === 5) yield* llm.text("episodic digest summary")
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        parts: [{ type: "text", text: `request ${turn}` }],
      })
    }

    const episodesFile = path.join(dir, ".jyycode", "memory", "episodes", `${chat.id}.jsonl`)
    const episodesText = (yield* fsys.readFileStringSafe(episodesFile).pipe(Effect.orDie)) ?? ""
    expect(episodesText.trim().split("\n")).toHaveLength(5)

    const digestFile = path.join(dir, ".jyycode", "memory", "digest", `${chat.id}`, "0001.md")
    const digestText = (yield* fsys.readFileStringSafe(digestFile).pipe(Effect.orDie)) ?? ""
    expect(digestText.length).toBeGreaterThan(0)
    expect(digestText.length).toBeLessThanOrEqual(3000)

    const beforeTurn6 = (yield* llm.inputs).at(-2)!
    const beforeTurn6Raw = JSON.stringify(beforeTurn6)
    yield* llm.text("answer 6")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      parts: [{ type: "text", text: "request 6" }],
    })

    const inputs = yield* llm.inputs
    const last = inputs.at(-1)!
    const raw = JSON.stringify(last)
    expect(raw.length).toBeLessThan(beforeTurn6Raw.length)
    expect(raw).toContain("episodic digest summary")
    expect(raw).toContain("request 2")
    expect(raw).toContain("request 3")
    expect(raw).toContain("request 4")
    expect(raw).toContain("request 5")
    expect(raw).toContain("request 6")
    expect(raw).not.toContain("request 1")

    yield* llm.text("answer 7")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      parts: [{ type: "text", text: "request 7" }],
    })
    const inputsBeforeTurn8 = (yield* llm.inputs).length
    yield* llm.text("answer 8")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      parts: [{ type: "text", text: "request 8" }],
    })
    const turn8Raw = JSON.stringify((yield* llm.inputs)[inputsBeforeTurn8]!)
    expect(turn8Raw).toContain("episodic digest summary")
    expect(turn8Raw).toContain("request 4")
    expect(turn8Raw).toContain("request 5")
    expect(turn8Raw).toContain("request 6")
    expect(turn8Raw).toContain("request 7")
    expect(turn8Raw).toContain("request 8")
    expect(turn8Raw).not.toContain("request 1")
    expect(turn8Raw).not.toContain("request 2")
    expect(turn8Raw).not.toContain("request 3")

    const child = yield* sessions.create({ parentID: chat.id, title: "Child" })
    yield* llm.text("child answer")
    yield* prompt.prompt({
      sessionID: child.id,
      agent: "build",
      parts: [{ type: "text", text: "child request" }],
    })
    const childEpisodesFile = path.join(dir, ".jyycode", "memory", "episodes", `${child.id}.jsonl`)
    const childEpisodes = (yield* fsys.readFileStringSafe(childEpisodesFile).pipe(Effect.orDie)) ?? ""
    expect(childEpisodes).toBe("")
    const childDigestFile = path.join(dir, ".jyycode", "memory", "digest", `${child.id}`, "0001.md")
    const childDigest = (yield* fsys.readFileStringSafe(childDigestFile).pipe(Effect.orDie)) ?? ""
    expect(childDigest).toBe("")
  }),
)

it.instance("continues once when the assistant output is truncated by length", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().text("partial answer").finish("length"))
    yield* llm.text("continued answer")

    const result = yield* prompt.loop({ sessionID: chat.id })
    const messages = yield* sessions.messages({ sessionID: chat.id })
    const reminders = messages
      .flatMap((message) => message.parts)
      .filter(
        (part): part is MessageV2.TextPart =>
          part.type === "text" && part.synthetic === true && part.metadata?.kind === "output_truncated_retry",
      )
    expect(reminders).toHaveLength(1)
    expect(reminders[0]?.text).toContain("output token limit")
    const continued = result.parts.filter(
      (part) => part.type === "text" && !("synthetic" in part && part.synthetic) && part.text === "continued answer",
    )
    expect(continued).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.finish).toBe("stop")
      expect(result.info.error).toBeUndefined()
    }
    expect(yield* llm.inputs).toHaveLength(2)
  }),
)

it.instance("stops with an error after two consecutive truncated outputs", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().text("first partial").finish("length"))
    yield* llm.push(reply().text("second partial").finish("length"))

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.finish).toBe("length")
      expect(result.info.error).toBeTruthy()
      expect(NamedError.Unknown.isInstance(result.info.error)).toBe(true)
      if (NamedError.Unknown.isInstance(result.info.error)) {
        expect(result.info.error.data.message).toContain("output token limit")
      }
    }
    const delivered = result.parts.filter(
      (part) => part.type === "text" && !("synthetic" in part && part.synthetic) && part.text === "second partial",
    )
    expect(delivered).toHaveLength(1)
    expect(yield* llm.inputs).toHaveLength(2)
  }),
)

it.instance("repairs a truncated tool call with a truncation-specific message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ title: "Parent" })
    // Child sessions bypass the root plan gate, so the full tool catalog
    // (including the `invalid` repair target) is available to the stream.
    const chat = yield* sessions.create({
      parentID: parent.id,
      title: "Child",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(
      reply()
        .pendingTool("bash", { command: "echo hello".repeat(200) })
        .finish("length"),
    )
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: chat.id })

    const messages = yield* sessions.messages({ sessionID: chat.id })
    const toolParts = messages
      .flatMap((message) => message.parts)
      .filter((part): part is MessageV2.ToolPart => part.type === "tool")
    const invalid = toolParts.find((part) => part.tool === "invalid")
    expect(invalid).toBeDefined()
    if (invalid && "output" in invalid.state) {
      expect(invalid.state.output).toContain("truncated before they were complete")
    }
    const reminders = messages
      .flatMap((message) => message.parts)
      .filter(
        (part): part is MessageV2.TextPart =>
          part.type === "text" && part.synthetic === true && part.metadata?.kind === "output_truncated_retry",
      )
    expect(reminders).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
  }),
)

it.instance("multi-agent roots tolerate preflight calls before creating a missing plan", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      multiAgent: true,
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "implement the requested multi-stage change" }],
    })
    // These calls reproduce the screenshot: the model may batch a Blackboard
    // read, roster lookup, and repeated reads before it emits Plan_create.
    yield* llm.tool("Plan_read", {})
    yield* llm.tool("Blackboard", {})
    yield* llm.tool("Dispatch_roles", {})
    yield* llm.tool("Plan_read", {})
    yield* llm.tool("Plan_create", {
      title: "Implementation plan",
      goal: "Complete and verify the requested change",
      steps: [
        {
          title: "Inspect",
          goal: "Understand the current behavior",
          done_criteria: "Relevant code paths are identified",
          tasks: [
            {
              title: "Inspect code",
              goal: "Locate the implementation gap",
              done_criteria: "The responsible code path is documented",
              output_path: "artifacts/inspection.md",
            },
          ],
        },
        {
          title: "Implement",
          goal: "Apply the fix",
          done_criteria: "The implementation and tests pass",
          tasks: [],
        },
      ],
    })
    yield* llm.text("Plan created through the protocol.")

    yield* prompt.loop({ sessionID: chat.id })

    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(6)
    expect(JSON.stringify(inputs[0]?.tools)).toContain("Plan_read")
    // Gated plan write tools stay visible as inert stubs: providers that
    // ignore the required tool choice then get a recoverable gated result
    // instead of a hard unknown-tool failure. The mandatory choice is exact,
    // so read-only context tools cannot become a retry loop.
    expect(JSON.stringify(inputs[0]?.tools)).toContain("Plan_create")
    expect(JSON.stringify(inputs[0]?.tools)).toContain("鏆傛椂绂佺敤")
    expect(inputs[0]?.tool_choice).toEqual({ type: "function", function: { name: "Plan_read" } })
    expect(JSON.stringify(inputs[1]?.tools)).toContain("Plan_create")
    expect(JSON.stringify(inputs[1]?.tools)).toContain("Plan_read")
    expect(JSON.stringify(inputs[1]?.tools)).toContain("Dispatch_roles")
    expect(inputs[1]?.tool_choice).toEqual({ type: "function", function: { name: "Plan_create" } })

    const messages = yield* sessions.messages({ sessionID: chat.id })
    const failedTools = messages
      .flatMap((message) => message.parts)
      .filter((part): part is MessageV2.ToolPart => part.type === "tool" && part.state.status === "error")
    expect(
      failedTools[0],
      JSON.stringify(failedTools.map((part) => ("error" in part.state ? part.state.error : "?"))),
    ).toBeUndefined()

    const plan = JSON.parse(
      yield* Effect.promise(() => Bun.file(path.join(chat.directory, ".jyycode", "plan", chat.id, "plan.json")).text()),
    )
    expect(plan.steps[0].tasks).toHaveLength(1)
    expect(plan.steps[1].tasks).toEqual([])
  }),
)

it.instance("cancelling a dispatched task forces the next turn to redispatch", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Cancel and redispatch",
      multiAgent: true,
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const context = { workspaceRoot: chat.directory, sessionId: chat.id, mode: "multi" as const }
    yield* Effect.promise(() =>
      defaultPlanProtocol.create(context, {
        title: "Cancellation recovery",
        goal: "redispatch a cancelled task",
        steps: [
          {
            title: "Work",
            goal: "run the task",
            done_criteria: "the child reports a result",
            tasks: [
              {
                title: "Task",
                goal: "produce the result",
                done_criteria: "result.md exists",
                output_path: "result.md",
              },
            ],
          },
          { title: "Review", goal: "review the result", done_criteria: "the result is accepted" },
        ],
      }),
    )
    yield* Effect.promise(() => defaultPlanProtocol.dispatch(context, { taskIds: ["s1_t1"], role: "general" }))
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "stop the current child and continue the task" }],
    })

    yield* llm.tool("Plan_read", {})
    yield* llm.tool("Dispatch_cancel", { taskIds: ["s1_t1"] })
    yield* llm.tool("Dispatch_dispatch", { taskIds: ["s1_t1"], role: "general" })

    yield* prompt.loop({ sessionID: chat.id })

    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(3)
    expect(inputs[2]?.tool_choice).toEqual({ type: "function", function: { name: "Dispatch_dispatch" } })
    const messages = yield* sessions.messages({ sessionID: chat.id })
    const failedTools = messages
      .flatMap((message) => message.parts)
      .filter((part): part is MessageV2.ToolPart => part.type === "tool" && part.state.status === "error")
    expect(failedTools).toHaveLength(0)
  }),
)

it.instance("skips duplicate Plan_create calls after the first attempt in one response", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Duplicate plan creation",
      multiAgent: true,
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "create the requested three-stage task" }],
    })

    const validCreate = {
      title: "Three-stage task",
      goal: "complete the requested task in order",
      steps: [
        {
          title: "Create source",
          goal: "create 1.txt",
          done_criteria: "1.txt exists",
          tasks: [
            {
              title: "Create 1.txt",
              goal: "write 123 to 1.txt",
              done_criteria: "1.txt contains 123",
              output_path: "1.txt",
            },
          ],
        },
        { title: "Copy and review", goal: "create 2.txt and 3.txt", done_criteria: "both files are reviewed" },
        { title: "Aggregate", goal: "create ans.txt", done_criteria: "ans.txt contains all source contents" },
      ],
    }
    const invalidCreate = {
      ...validCreate,
      steps: [
        validCreate.steps[0],
        {
          ...validCreate.steps[1],
          tasks: [
            {
              title: "Create 2.txt",
              goal: "copy 1.txt",
              done_criteria: "2.txt contains the copied content",
              output_path: "2.txt",
            },
          ],
        },
        validCreate.steps[2],
      ],
    }

    yield* llm.tool("Plan_read", {})
    yield* llm.push(reply().tool("Plan_create", invalidCreate).tool("Plan_create", validCreate))
    yield* llm.text("The plan creation attempt was recorded; continue from the next protocol turn.")
    yield* prompt.loop({ sessionID: chat.id })

    const messages = yield* sessions.messages({ sessionID: chat.id })
    const toolParts = messages
      .flatMap((message) => message.parts)
      .filter((part): part is MessageV2.ToolPart => part.type === "tool")
    const failedTools = toolParts.filter((part) => part.state.status === "error")
    expect(failedTools).toHaveLength(0)
    expect(
      toolParts.some(
        (part) =>
          part.tool === "Plan_create" && part.state.status === "completed" && part.state.metadata?.skipped === true,
      ),
    ).toBe(true)
    const planExists = yield* Effect.promise(() =>
      fs.access(path.join(chat.directory, ".jyycode", "plan", chat.id, "plan.json")).then(
        () => true,
        () => false,
      ),
    )
    expect(planExists).toBe(false)
  }),
)

it.instance("requires Plan_read before retrying a failed Plan_create", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Plan creation recovery",
      multiAgent: true,
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "create a multi-stage plan" }],
    })

    yield* llm.tool("Plan_read", {})
    yield* llm.tool("Plan_create", {
      title: "Invalid plan",
      goal: "this must be repaired",
      steps: [
        {
          title: "Work",
          goal: "do the work",
          done_criteria: "the work is complete",
          tasks: [
            {
              title: "Task",
              goal: "produce the result",
              done_criteria: "result.md exists",
              output_path: "result.md",
              timeout_ms: 30_000,
            },
          ],
        },
        { title: "Review", goal: "review the result", done_criteria: "the result is accepted" },
      ],
    })
    yield* llm.tool("Plan_read", {})
    yield* llm.tool("Plan_create", {
      title: "Recovered plan",
      goal: "complete the requested work",
      steps: [
        {
          title: "Work",
          goal: "do the work",
          done_criteria: "the work is complete",
          tasks: [
            {
              title: "Task",
              goal: "produce the result",
              done_criteria: "result.md exists",
              output_path: "result.md",
            },
          ],
        },
        { title: "Review", goal: "review the result", done_criteria: "the result is accepted" },
      ],
    })
    yield* llm.text("Recovered plan created.")

    yield* prompt.loop({ sessionID: chat.id })

    const inputs = yield* llm.inputs
    expect(inputs[2]?.tool_choice).toEqual({ type: "function", function: { name: "Plan_read" } })
    const messages = yield* sessions.messages({ sessionID: chat.id })
    const planCreates = messages
      .flatMap((message) => message.parts)
      .filter((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "Plan_create")
    expect(planCreates).toHaveLength(2)
    expect(
      planCreates.filter(
        (part) =>
          part.state.status === "error" ||
          (part.state.status === "completed" && JSON.parse(part.state.output).ok === false),
      ),
    ).toHaveLength(1)
    expect(
      JSON.parse(
        yield* Effect.promise(() =>
          Bun.file(path.join(chat.directory, ".jyycode", "plan", chat.id, "plan.json")).text(),
        ),
      ).title,
    ).toBe("Recovered plan")
  }),
)

it.instance("does not execute stale protocol mutations from one batched response", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Batched protocol mutations",
      multiAgent: true,
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const context = { workspaceRoot: chat.directory, sessionId: chat.id, mode: "multi" as const }
    yield* Effect.promise(() =>
      defaultPlanProtocol.create(context, {
        title: "Batched recovery",
        goal: "cancel and then redispatch exactly once",
        steps: [
          {
            title: "Work",
            goal: "run the task",
            done_criteria: "the child reports a result",
            tasks: [
              {
                title: "Task",
                goal: "produce the result",
                done_criteria: "result.md exists",
                output_path: "result.md",
              },
            ],
          },
          { title: "Review", goal: "review the result", done_criteria: "the result is accepted" },
        ],
      }),
    )
    yield* Effect.promise(() => defaultPlanProtocol.dispatch(context, { taskIds: ["s1_t1"], role: "general" }))
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "cancel the child and dispatch it again" }],
    })

    // The provider can return all three calls in one response even though the
    // protocol gate asks for Plan_read first. Dispatch_dispatch must not run
    // against the pre-cancel snapshot or produce a tool error.
    yield* llm.push(
      reply()
        .tool("Plan_read", {})
        .tool("Dispatch_cancel", { taskIds: ["s1_t1"] })
        .tool("Dispatch_dispatch", { taskIds: ["s1_t1"], role: "general" }),
    )
    yield* llm.tool("Dispatch_dispatch", { taskIds: ["s1_t1"], role: "general" })

    yield* prompt.loop({ sessionID: chat.id })

    const messages = yield* sessions.messages({ sessionID: chat.id })
    const failedTools = messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool" && part.state.status === "error")
    expect(failedTools).toHaveLength(0)
    const batched = messages
      .flatMap((message) => message.parts)
      .filter((part): part is MessageV2.ToolPart => part.type === "tool")
    expect(batched.some((part) => part.tool === "Dispatch_cancel" && part.state.status === "completed")).toBe(true)
    expect(batched.some((part) => part.tool === "Dispatch_dispatch" && part.state.status === "completed")).toBe(true)
  }),
)

it.instance("goal mode continues after a finished turn until the turn budget is exhausted", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Goal loop",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* sessions.setGoal({
      sessionID: chat.id,
      goal: {
        condition: "finish the work",
        status: "running",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        maxTurns: 1,
      },
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "work on the goal" }],
    })
    const started = yield* sessions.get(chat.id)
    expect(started.goal?.condition).toBe("work on the goal")
    yield* llm.text("first result")
    yield* llm.text("second result")

    yield* prompt.loop({ sessionID: chat.id })

    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(2)
    const current = yield* sessions.get(chat.id)
    expect(current.goal?.status).toBe("failed")
    expect(current.goal?.turns).toBe(1)
    expect(current.goal?.result).toContain("turn budget")
  }),
)

it.instance("Goal_done stops a goal-mode loop", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Goal done",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* sessions.setGoal({
      sessionID: chat.id,
      goal: {
        condition: "finish the work",
        status: "running",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        maxTurns: 5,
      },
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "work on the goal" }],
    })
    yield* llm.tool("Plan_read", {})
    yield* llm.tool("Goal_done", { summary: "goal reached" })
    yield* llm.text("all done")

    yield* prompt.loop({ sessionID: chat.id })

    const inputs = yield* llm.inputs
    expect(JSON.stringify(inputs)).toContain("Goal_done")
    const messages = yield* sessions.messages({ sessionID: chat.id })
    const failedTools = messages
      .flatMap((message) => message.parts)
      .filter((part): part is MessageV2.ToolPart => part.type === "tool" && part.state.status === "error")
    expect(
      failedTools[0],
      JSON.stringify(failedTools.map((part) => ("error" in part.state ? part.state.error : "?"))),
    ).toBeUndefined()
    const current = yield* sessions.get(chat.id)
    expect(current.goal?.status).toBe("done")
    expect(current.goal?.result).toBe("goal reached")
    const assistantTexts = messages
      .flatMap((message) => message.parts)
      .filter((part): part is MessageV2.TextPart => part.type === "text")
      .map((part) => part.text)
    expect(assistantTexts.join("\n")).toContain("all done")
  }),
)

it.instance("goal mode parks while multi-agent children are running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Goal + multi-agent",
      multiAgent: true,
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* sessions.setGoal({
      sessionID: chat.id,
      goal: {
        condition: "ship the feature",
        status: "running",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        maxTurns: 5,
      },
    })
    const context = { workspaceRoot: chat.directory, sessionId: chat.id, mode: "multi" as const }
    yield* Effect.promise(() =>
      defaultPlanProtocol.create(context, {
        title: "Goal plan",
        goal: "ship the feature",
        steps: [
          {
            title: "Work",
            goal: "run the task",
            done_criteria: "the child reports a result",
            tasks: [
              {
                title: "Task",
                goal: "produce the result",
                done_criteria: "result.md exists",
                output_path: "result.md",
              },
            ],
          },
          { title: "Review", goal: "review the result", done_criteria: "the result is accepted" },
        ],
      }),
    )
    yield* Effect.promise(() => defaultPlanProtocol.dispatch(context, { taskIds: ["s1_t1"], role: "general" }))
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "start the plan" }],
    })

    yield* prompt.wake({
      sessionID: chat.id,
      kind: "goal_continue",
      text: "Goal mode wants to continue, but children are still running.",
    })

    expect(yield* llm.calls).toBe(0)
    const messages = yield* sessions.messages({ sessionID: chat.id })
    expect(
      messages
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .some((part) => (part.type === "text" && !part.synthetic) || part.type === "tool"),
      JSON.stringify(messages.map((message) => message.info.role)),
    ).toBe(false)
  }),
)

it.instance("goal mode resumes the main agent after a child report arrives", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Goal + report",
      multiAgent: true,
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* sessions.setGoal({
      sessionID: chat.id,
      goal: {
        condition: "ship the feature",
        status: "running",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        maxTurns: 1,
      },
    })
    const context = { workspaceRoot: chat.directory, sessionId: chat.id, mode: "multi" as const }
    yield* Effect.promise(() =>
      defaultPlanProtocol.create(context, {
        title: "Goal plan",
        goal: "ship the feature",
        steps: [
          {
            title: "Work",
            goal: "run the task",
            done_criteria: "the child reports a result",
            tasks: [
              {
                title: "Task",
                goal: "produce the result",
                done_criteria: "result.md exists",
                output_path: "result.md",
              },
            ],
          },
          { title: "Review", goal: "review the result", done_criteria: "the result is accepted" },
        ],
      }),
    )
    const dispatched = yield* Effect.promise(() =>
      defaultPlanProtocol.dispatch(context, { taskIds: ["s1_t1"], role: "general" }),
    )
    if (!dispatched.ok) throw new Error(dispatched.error.message)
    yield* writeText(path.join(chat.directory, "result.md"), "done")
    const runId = dispatched.dispatched[0]!.run_id
    const report = yield* Effect.promise(() =>
      defaultPlanProtocol.report(
        { workspaceRoot: chat.directory, sessionId: chat.id, mode: "multi", runId },
        {
          run_id: runId,
          status: "done",
          summary: "result ready",
          artifacts: [path.join(chat.directory, "result.md")],
        },
      ),
    )
    expect(report.ok).toBe(true)
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "start the plan" }],
    })
    yield* llm.text("reviewing report")
    yield* llm.text("next step")

    yield* prompt.wake({
      sessionID: chat.id,
      kind: "goal_continue",
      text: "A child report arrived; continue the goal.",
    })

    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(2)
    const current = yield* sessions.get(chat.id)
    expect(current.goal?.status).toBe("failed")
  }),
)

withMemory.instance("does not inject persistent memory into child sessions", () =>
  Effect.gen(function* () {
    const { llm, dir } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ title: "Parent" })
    const child = yield* sessions.create({ parentID: parent.id, title: "Child" })

    yield* prompt.prompt({
      sessionID: child.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "閻劍鍩? }],
    })
    yield* llm.text("done")

    yield* prompt.loop({ sessionID: child.id })

    const inputs = yield* llm.inputs
    const request = inputs.at(-1)
    const payload = JSON.stringify(request?.messages)
    expect(payload).not.toContain("Relevant persistent memory")
    expect(payload).not.toContain("Persistent memory is stored")
    expect(payload).not.toContain("# Memory")
    expect(payload).toContain("## Child workspace boundary")
    expect(payload).not.toContain(`Working directory: ${dir}`)
    expect(payload).not.toContain(`Workspace root: ${dir}`)
    expect(JSON.stringify(request?.tools)).not.toContain('"name":"memory"')
  }),
)

const withSnapshotMemory = testEffect(makeHttp({ memory: snapshotMemoryLayer }))
withSnapshotMemory.instance("injects the persistent memory snapshot on the first and every later turn", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Snapshot" })

    yield* llm.text("first")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      parts: [{ type: "text", text: "one" }],
    })
    yield* llm.text("second")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      parts: [{ type: "text", text: "two" }],
    })

    const inputs = yield* llm.inputs
    expect(JSON.stringify(inputs[0])).toContain("PERSISTENT MEMORY SNAPSHOT")
    expect(JSON.stringify(inputs[1])).toContain("PERSISTENT MEMORY SNAPSHOT")
    expect(JSON.stringify(inputs[0])).toContain("## Runtime context")
    expect(JSON.stringify(inputs[1])).toContain("Only the root session may change persistent memory")
  }),
)

withMemoryLifecycle.instance("updates memory while busy and before returning the final answer", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const chat = yield* sessions.create({ title: "Memory lifecycle" })
    memoryLifecycleUpdates.splice(0)
    const gate = yield* Deferred.make<void>()
    memoryStepBeginGate = gate
    yield* llm.text("done")

    const fiber = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "build",
        parts: [{ type: "text", text: "fix the memory lifecycle" }],
      })
      .pipe(Effect.forkChild)
    yield* pollWithTimeout(
      Effect.sync(() =>
        memoryLifecycleUpdates.some((entry) => entry.sessionID === chat.id && entry.phase === "received")
          ? true
          : undefined,
      ),
      "memory input-phase update did not start",
    )
    expect((yield* status.get(chat.id)).type).toBe("busy")
    yield* Deferred.succeed(gate, void 0)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    const result = exit.value

    expect(result.info.role).toBe("assistant")
    expect(memoryLifecycleUpdates.filter((entry) => entry.sessionID === chat.id).map((entry) => entry.phase)).toEqual([
      "received",
      "before_final",
    ])
  }).pipe(Effect.ensuring(Effect.sync(() => void (memoryStepBeginGate = undefined)))),
)

withMemoryFailure.instance("memory curator failures do not abort the assistant run", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Memory failure isolation" })
    yield* llm.text("assistant still runs")

    const result = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      parts: [{ type: "text", text: "a request whose memory summary is too long" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "assistant still runs")).toBe(true)
  }),
)

noLLMServer.instance(
  "prompt emits v2 prompted and synthetic events",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(SessionV2.layer),
      )
      const row = Database.use((db) =>
        db.select().from(SessionMessageTable).where(Database.eq(SessionMessageTable.session_id, chat.id)).get(),
      )
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { config: cfg },
)

it.instance("static loop returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("static loop consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello one" }],
    })

    yield* llm.text("world one")

    const first = yield* prompt.loop({ sessionID: session.id })
    expect(first.info.role).toBe("assistant")
    expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello two" }],
    })

    yield* llm.text("world two")

    const second = yield* prompt.loop({ sessionID: session.id })
    expect(second.info.role).toBe("assistant")
    expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("loop continues when finish is tool-calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("glob tool keeps instance context during prompt runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Glob context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "find text files" }],
    })
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const tool = msgs
      .flatMap((msg) => msg.parts)
      .find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
      )
    if (!tool) return

    expect(tool.state.output).toContain(file)
    expect(tool.state.output).not.toContain("No context found for instance")
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
  }),
)

it.instance("loop continues when finish is stop but assistant has tool parts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().tool("first", { value: "first" }).stop())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("cuts off repeated child-agent tool turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ title: "Parent" })
    const child = yield* sessions.create({ parentID: parent.id, title: "Child" })

    yield* prompt.prompt({
      sessionID: child.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "repeat this tool call" }],
    })
    for (let index = 0; index < 4; index++) {
      yield* llm.push(reply().tool("first", { value: "same" }).stop())
    }

    const result = yield* prompt.loop({ sessionID: child.id })
    expect(yield* llm.calls).toBe(3)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
  }),
)

it.instance("stops a dispatched child after its no-progress budget and records a code", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ title: "Parent" })
    const child = yield* sessions.create({ parentID: parent.id, title: "Budgeted child" })

    yield* prompt.prompt({
      sessionID: child.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "repeat until the budget trips" }],
    })
    registerChildBudget(child.id, resolveChildBudget({ now: Date.now(), role: { no_progress_steps: 8 } }))
    for (let index = 0; index < 10; index++) {
      yield* llm.push(reply().tool("first", { value: "same" }).stop())
    }

    const result = yield* prompt.loop({ sessionID: child.id })
    expect(yield* llm.calls).toBe(8)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant")
      expect(JSON.stringify(result.info.error)).toContain("NO_PROGRESS_BUDGET_EXCEEDED")
    clearChildBudget(child.id)
  }),
)

it.instance("warns then cuts off repeated main-session tool turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Main",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "repeat this tool call" }],
    })
    for (let index = 0; index < 6; index++) {
      yield* llm.push(reply().tool("first", { value: "same" }).stop())
    }

    const result = yield* prompt.loop({ sessionID: session.id })
    // Root sessions first consume one forced Plan.read turn, then get one
    // stuck-loop warning reminder before the hard stop.
    expect(yield* llm.calls).toBe(5)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const warning = msgs.find((msg) =>
      msg.parts.some((part) => part.type === "text" && part.synthetic && part.metadata?.kind === "stuck_loop_warning"),
    )
    expect(warning).toBeDefined()
  }),
)

it.instance("re-prompts when the assistant finishes with an empty response", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Empty",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().stop())
    yield* llm.text("the answer")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "the answer")).toBe(true)
    }

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const reminder = msgs.find((msg) =>
      msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.metadata?.kind === "empty_response_retry",
      ),
    )
    expect(reminder).toBeDefined()
  }),
)

it.instance(
  "loop sets status to busy then idle",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service

      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect((yield* status.get(chat.id)).type).toBe("busy")
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  3_000,
)

// Cancel semantics

it.instance(
  "cancel interrupts loop and resolves with an assistant message",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id)

      yield* llm.hang

      yield* user(chat.id, "more")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
      }
    }),
  3_000,
)

it.instance(
  "cancel records MessageAbortedError on interrupted process",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const info = exit.value.info
        if (info.role === "assistant") {
          expect(info.error?.name).toBe("MessageAbortedError")
        }
      }
    }),
  3_000,
)

raceNoLLMServer.instance(
  "finalizes assistant when cancelled before processor creation completes",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Processor creation race" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })

      const firstCreate = defer<void>()
      processorCreateStarted.push(firstCreate.resolve)
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => firstCreate.promise)

      yield* prompt.cancel(chat.id)
      const firstExit = yield* Fiber.await(first)
      expect(Exit.isSuccess(firstExit)).toBe(true)

      let messages = yield* sessions.messages({ sessionID: chat.id })
      const firstInterrupted = messages.at(-1)
      expect(firstInterrupted?.info.role).toBe("assistant")
      expect(firstInterrupted?.parts).toHaveLength(0)
      if (firstInterrupted?.info.role === "assistant") {
        expect(firstInterrupted.info.finish).toBeUndefined()
        expect(firstInterrupted.info.time.completed).toBeNumber()
        expect(firstInterrupted.info.error?.name).toBe("MessageAbortedError")
      }

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })

      const secondCreate = defer<void>()
      processorCreateStarted.push(secondCreate.resolve)
      const second = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => secondCreate.promise)

      yield* prompt.cancel(chat.id)
      const secondExit = yield* Fiber.await(second)
      expect(Exit.isSuccess(secondExit)).toBe(true)

      messages = yield* sessions.messages({ sessionID: chat.id })
      const poisonMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          !message.info.finish &&
          !message.info.time.completed &&
          !message.info.error,
      )
      expect(poisonMessages).toHaveLength(0)

      const interruptedMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          message.info.time.completed &&
          message.info.error?.name === "MessageAbortedError",
      )
      expect(interruptedMessages).toHaveLength(2)

      const lastUser = messages.at(-2)
      const lastAssistant = messages.at(-1)
      expect(lastUser?.info.role).toBe("user")
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastUser?.info.role === "user" && lastAssistant?.info.role === "assistant") {
        expect(lastAssistant.info.parentID).toBe(lastUser?.info.id)
      }
    }),
  { config: cfg },
  3_000,
)

it.instance(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
        expect(exitA.value.info.id).toBe(exitB.value.info.id)
      }
    }),
  { git: true },
  10_000,
)

// Queue semantics

noLLMServer.instance("concurrent loop callers get same result", () =>
  Effect.gen(function* () {
    const { prompt, run, chat } = yield* boot()
    yield* seed(chat.id, { finish: "stop" })

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })

    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    yield* run.assertNotBusy(chat.id)
  }),
)

it.instance(
  "concurrent loop callers all receive same error result",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.fail("boom")
      yield* user(chat.id, "hello")

      const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
        concurrency: "unbounded",
      })
      expect(a.info.id).toBe(b.info.id)
      expect(a.info.role).toBe("assistant")
    }),
  10_000,
)

it.instance(
  "prompt submitted during an active run is included in the next LLM input",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.hold("first", deferredAsPromise(gate))
      yield* llm.text("second")

      const a = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "first" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)

      const id = MessageID.ascending()
      const b = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "second" }],
        })
        .pipe(Effect.forkChild)

      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((msgs) =>
              msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined,
            ),
          ),
        "timed out waiting for second prompt to save",
      )

      yield* Deferred.succeed(gate, void 0)

      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      expect(yield* llm.calls).toBe(2)

      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const assistants = msgs.filter((msg) => msg.info.role === "assistant")
      expect(assistants).toHaveLength(2)
      const last = assistants.at(-1)
      if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
      expect(last.info.parentID).toBe(id)
      expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(2)
      expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("second")
    }),
  10_000,
)

it.instance(
  "assertNotBusy fails with BusyError when loop running",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const run = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
      }

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  3_000,
)

noLLMServer.instance("assertNotBusy succeeds when idle", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({})
    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

// Shell semantics

it.instance(
  "shell rejects with BusyError when loop running",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
      }

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  3_000,
)

unixNoLLMServer(
  "shell captures stdout and stderr in completed tool output",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "printf out && printf err >&2",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("out")
      expect(tool.state.output).toContain("err")
      expect(tool.state.metadata.output).toContain("out")
      expect(tool.state.metadata.output).toContain("err")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell completes a fast command on the preferred shell",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("pwd")
      expect(tool.state.output).toContain(dir)
      expect(tool.state.metadata.output).toContain(dir)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return

        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "[[ 1 -eq 1 ]] && printf configured",
        })

        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output).toContain("configured")
      }),
    ),
  { config: { ...cfg, shell: "bash" } },
  30_000,
)

timeoutNoLLMServer.instance(
  "shell terminates commands that exceed the default timeout",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30",
      })

      const tool = completedTool(result.parts)
      if (!tool) return
      expect(tool.state.output).toContain("exceeding timeout 200 ms")
    }),
  { config: cfg },
  10_000,
)

unixNoLLMServer(
  "shell commands can change directory after startup",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const parent = path.dirname(dir)
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "cd .. && pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain(parent)
      expect(tool.state.metadata.output).toContain(parent)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell lists files from the project directory",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      yield* writeText(path.join(dir, "README.md"), "# e2e\n")

      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command ls",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("command ls")
      expect(tool.state.output).toContain("README.md")
      expect(tool.state.metadata.output).toContain("README.md")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell captures stderr from a failing command",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("not found")
      expect(tool.state.metadata.output).toContain("not found")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const fiber = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
          .pipe(Effect.forkChild)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
            const taskMsg = msgs.find((item) => item.info.role === "assistant")
            const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
            if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return true
          }),
          "timed out waiting for running shell metadata",
        )

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  { config: cfg },
  30_000,
)

it.instance(
  "loop waits while shell runs and starts after shell exits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("after-shell")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(loop)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

it.instance(
  "shell completion resumes queued loop callers",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("done")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
        expect(ea.value.info.id).toBe(eb.value.info.id)
        expect(ea.value.info.role).toBe("assistant")
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: "bash",
          command: {
            probe: {
              template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "probe",
          arguments: "",
        })

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
      }),
    ),
  30_000,
)

unixNoLLMServer(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        yield* prompt.cancel(chat.id)

        const status = yield* SessionStatus.Service
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(busy)).toBe(true)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* AppFileSystem.Service
        const ready = path.join(dir, ".trap-ready")

        const sh = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            // Touch marker AFTER trap installs so the test waits for the actual
            // ignore-TERM state before cancelling; otherwise SIGTERM can arrive
            // before `trap` runs and the escalation path is never exercised.
            command: `trap '' TERM; touch "${ready}"; sleep 30`,
          })
          .pipe(Effect.forkChild)

        yield* Effect.gen(function* () {
          while (!(yield* afs.existsSafe(ready))) {
            yield* Effect.sleep(Duration.millis(10))
          }
        }).pipe(Effect.timeout(Duration.seconds(5)))

        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Interrupted bash truncation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run bash" }],
      })

      yield* llm.tool("Plan_read", {})
      yield* llm.tool("bash", {
        command:
          'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; printf "READY_FOR_CANCEL\\n"; sleep 30',
        description: "Print many lines",
        timeout: 30_000,
        workdir: path.resolve(dir),
      })

      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* Effect.gen(function* () {
        while (true) {
          const messages = yield* sessions.messages({ sessionID: chat.id })
          const tool = messages
            .flatMap((message) => message.parts)
            .findLast((part): part is MessageV2.ToolPart => part.type === "tool")
          if (
            tool?.state.status === "running" &&
            typeof tool.state.metadata?.output === "string" &&
            tool.state.metadata.output.includes("READY_FOR_CANCEL")
          ) return
          yield* Effect.sleep(Duration.millis(10))
        }
      }).pipe(Effect.timeout(Duration.seconds(5)))
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isFailure(exit)) return

      const messages = yield* sessions.messages({ sessionID: chat.id })
      const tool = messages
        .flatMap((message) => message.parts)
        .findLast((part): part is MessageV2.ToolPart => part.type === "tool")
      expect(tool?.state.status).toBe("completed")
      if (!tool || tool.state.status !== "completed") return

      expect(tool.state.metadata.truncated).toBe(true)
      expect(typeof tool.state.metadata.outputPath).toBe("string")
      expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
      expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
      expect(tool.state.output).not.toContain("Tool execution aborted")
    }),
  { git: true },
  30_000,
)

unixNoLLMServer(
  "cancel interrupts loop queued behind shell",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 30" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(loop)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const tool = completedTool(exit.value.parts)
        expect(tool?.state.output).toContain("User aborted the command")
      }

      yield* Fiber.await(sh)
    }),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const a = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(a)
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

// Abort signal propagation tests for inline tool execution

function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const original = tool.execute
    tool.execute = (_args: any, ctx: any) => {
      ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
      if (ctx.abort.aborted) succeedVoid(aborted)
      succeedVoid(ready)
      return Effect.callback<never>(() => Effect.sync(() => succeedVoid(aborted)))
    }
    const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
    return { ready, aborted, restore }
  })
}

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const testFile = path.join(dir, "test.txt")
      yield* writeText(testFile, "hello world")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

// Missing file handling

noLLMServer.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "please review @does-not-exist.ts" },
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "does-not-exist.ts",
          },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      const hasFailure = msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
      )
      expect(hasFailure).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "keeps stored part order stable when file resolution is async",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "still-missing.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "still-missing.ts",
          },
          { type: "text", text: "after-file" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")

      const stored = yield* MessageV2.get({
        sessionID: session.id,
        messageID: msg.info.id,
      })
      const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

      expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
      expect(text[1]?.includes("Read tool failed to read")).toBe(true)
      expect(text[2]).toBe("after-file")

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "resolves configured reference mentions before workspace paths and agents",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const docs = path.join(dir, "external-docs")
      yield* ensureDir(path.join(docs, "guide"))
      yield* ensureDir(path.join(dir, "docs"))
      yield* writeText(path.join(docs, "README.md"), "reference readme")
      yield* writeText(path.join(docs, "guide", "intro.md"), "reference intro")
      yield* writeText(path.join(dir, "docs", "README.md"), "workspace readme")

      const prompt = yield* SessionPrompt.Service
      const parts = yield* prompt.resolvePromptParts(
        "Use @docs and @docs/README.md and @docs/guide and @docs/missing.md and @docs/README.md and @build",
      )
      const references = parts.filter(
        (part): part is MessageV2.TextPartInput =>
          part.type === "text" && part.synthetic === true && part.text.startsWith("Referenced configured reference "),
      )
      const files = parts.filter((part): part is MessageV2.FilePartInput => part.type === "file")
      const agents = parts.filter((part): part is MessageV2.AgentPartInput => part.type === "agent")
      const bare = references.find((part) => part.text.includes("@docs."))
      const missing = references.find((part) => part.text.includes("@docs/missing.md"))
      const guide = files.find((part) => part.filename === "docs/guide")

      expect(references.length).toBe(2)
      expect(bare?.metadata?.reference).toMatchObject({
        name: "docs",
        kind: "local",
        path: docs,
      })
      expect(missing?.text).toContain("Path does not exist inside configured reference @docs")
      expect(missing?.metadata?.reference).toMatchObject({
        target: "missing.md",
        targetPath: path.join(docs, "missing.md"),
      })

      expect(files.length).toBe(2)
      expect(files.map((file) => fileURLToPath(file.url)).sort()).toEqual(
        [path.join(docs, "README.md"), path.join(docs, "guide")].sort(),
      )
      expect(guide?.mime).toBe("application/x-directory")
      expect(agents.map((agent) => agent.name)).toEqual(["build"])
    }),
  {
    config: {
      ...cfg,
      reference: {
        docs: "./external-docs",
      },
    },
  },
)

noLLMServer.instance(
  "injects metadata for bare configured reference mentions",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const docs = path.join(dir, "external-docs")
      yield* ensureDir(docs)

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const message = yield* prompt.prompt({
        sessionID: session.id,
        noReply: true,
        parts: yield* prompt.resolvePromptParts("Use @docs for context"),
      })

      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const synthetic = stored.parts.filter(
        (part): part is MessageV2.TextPart => part.type === "text" && part.synthetic === true,
      )
      const reference = synthetic.find((part) => part.text.startsWith("Referenced configured reference @docs."))

      expect(reference?.metadata?.reference).toMatchObject({ name: "docs", kind: "local", path: docs })
      expect(synthetic.some((part) => part.text.includes(`Reference root: ${docs}`))).toBe(true)
      expect(synthetic.some((part) => part.text.includes("delegate to a subagent"))).toBe(true)

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      reference: {
        docs: "./external-docs",
      },
    },
  },
)

noLLMServer.instance(
  "injects metadata for configured reference file attachments",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const docs = path.join(dir, "external-docs")
      const readme = path.join(docs, "README.md")
      yield* ensureDir(docs)
      yield* writeText(readme, "reference readme")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const message = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "Read @docs/README.md" },
          {
            type: "file",
            mime: "text/plain",
            filename: "docs/README.md",
            url: pathToFileURL(readme).href,
            source: {
              type: "file",
              path: "docs/README.md",
              text: { value: "@docs/README.md", start: 5, end: 20 },
            },
          },
        ],
      })

      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const synthetic = stored.parts.filter(
        (part): part is MessageV2.TextPart => part.type === "text" && part.synthetic === true,
      )
      const reference = synthetic.find((part) =>
        part.text.startsWith("Referenced configured reference @docs/README.md."),
      )

      expect(reference?.metadata?.reference).toMatchObject({
        name: "docs",
        kind: "local",
        path: docs,
        target: "README.md",
        targetPath: readme,
        source: { value: "@docs/README.md", start: 5, end: 20 },
      })
      expect(synthetic.findIndex((part) => part === reference)).toBeLessThan(
        synthetic.findIndex((part) => part.text.startsWith("Called the Read tool with the following input:")),
      )

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      reference: {
        docs: "./external-docs",
      },
    },
  },
)

// Special characters in filenames

noLLMServer.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* prompt.prompt({
        sessionID: session.id,
        parts,
        noReply: true,
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const textParts = stored.parts.filter((part) => part.type === "text")
      const hasContent = textParts.some((part) => part.text.includes("special content"))
      expect(hasContent).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { git: true, config: cfg },
)

// Regression: empty assistant turn loop

it.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/jyycode/src/session/processor.ts")

    const result = yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      parts: [{ type: "text", text: "Where is SessionProcessor?" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const msgs = yield* sessions.messages({ sessionID: session.id })
    expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
  }),
)

it.instance(
  "records aborted errors when prompt is cancelled mid-stream",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Prompt cancel regression" })

      yield* llm.hang

      const fiber = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "Cancel me" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)
      yield* prompt.cancel(session.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        if (exit.value.info.role === "assistant") {
          expect(exit.value.info.error?.name).toBe("MessageAbortedError")
        }
      }

      const msgs = yield* sessions.messages({ sessionID: session.id })
      const last = msgs.findLast((msg) => msg.info.role === "assistant")
      expect(last?.info.role).toBe("assistant")
      if (last?.info.role === "assistant") {
        expect(last.info.error?.name).toBe("MessageAbortedError")
      }
    }),
  3_000,
)

// Agent variant

noLLMServer.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderID.make("jyycode"), modelID: ModelID.make("kimi-k2.5-free") },
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const match = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const override = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "hello third" }],
      })
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        test: {
          ...cfg.provider.test,
          models: {
            "test-model": {
              ...cfg.provider.test.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "test/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

// Agent / command resolution errors

noLLMServer.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("build")
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)

it.instance("profile subagent child session gets role skills in the skill tool and first-turn system prompt", () =>
  Effect.gen(function* () {
    const home = process.env.JYYCODE_TEST_HOME
    expect(home).toBeTruthy()
    const roleRoot = path.join(home!, ".jyycode", "role", "office_master")
    yield* Effect.promise(async () => {
      for (const name of ["docx", "pdf"]) {
        const dir = path.join(roleRoot, "skills", name)
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(
          path.join(dir, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${name} 鏂囨。澶勭悊鎶€鑳絓n---\n\n# ${name}\n`,
        )
      }
    })
    yield* Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        subagents: {
          profiles: [
            {
              id: "general",
              name: "General",
              description: "General-purpose agent for delegated execution.",
              prompt: "",
              avatar: "bot",
              enabled: false,
            },
            {
              id: "office_master",
              name: "office楂樻墜",
              description: "绮鹃€歸ord/ppt/excel/pdf绛塷ffice杞欢鐨勯珮鎵?,
              prompt:
                "浣犳槸涓€浣嶇簿閫氬悇绉峯ffice鐨勯珮鎵嬶紝鍙互浣跨敤浣犵殑docx,pdf,pptx鍜寈lsx鍥涗釜鎶€鑳借繘琛屽悇绉峯ffice鏂囨。鐨勭敓鎴愬拰澶勭悊銆?,
              avatar: "chart",
              enabled: true,
            },
          ],
        },
      }))

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({
        title: "root",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const child = yield* sessions.create({
        title: "child",
        parentID: root.id,
        agent: "subagent:office_master",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: child.id,
        agent: "subagent:office_master",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "璇风敓鎴愪竴涓簿缇庣殑涓枃PDF鎶ュ憡" }],
      })
      yield* llm.text("濂界殑锛屾垜鏉ュ鐞嗐€?)
      yield* prompt.loop({ sessionID: child.id })

      const inputs = yield* llm.inputs
      expect(inputs.length).toBeGreaterThan(0)
      const body = inputs.at(-1) as {
        tools?: Array<{ type?: string; function?: { name?: string; description?: string } }>
      }
      const skillTool = (body.tools ?? []).find((item) => item.function?.name === "skill")
      // The role catalog is scoped to this profile: global/built-in skills
      // must not leak into a child session, and role skills must be listed.
      expect(skillTool?.function?.description).toContain("docx")
      expect(skillTool?.function?.description).toContain("pdf")
      expect(skillTool?.function?.description).not.toContain("customize-jyycode")
      const toolNames = (body.tools ?? []).map((item) => item.function?.name)
      expect(toolNames).toContain("read")
      expect(toolNames).not.toContain("write")
      expect(toolNames).not.toContain("bash")
      // First-turn system context carries the role catalog so the child loads
      // its skills even when the dispatch brief prescribes a raw toolchain.
      const payload = JSON.stringify(body)
      expect(payload).toContain("浣犵殑涓撳睘鎶€鑳?)
      expect(payload).toContain("docx 鏂囨。澶勭悊鎶€鑳?)
      expect(payload).toContain("Runtime permissions, visible tools")
    }).pipe(Effect.ensuring(Effect.promise(() => fs.rm(roleRoot, { recursive: true, force: true }))))
  }),
)

const experienceCandidatesWritten: Array<{ sessionID: SessionID; candidates: Memory.ExperienceCandidate[] }> = []
const experienceSnapshotCalls: Array<[SessionID, string[], string | undefined]> = []
const experienceMemoryLayer = Layer.succeed(
  ExperienceMemory.Service,
  ExperienceMemory.Service.of({
    ensure: () => Effect.void,
    readStore: () => Effect.die("unexpected readStore"),
    upsert: () => Effect.die("unexpected upsert"),
    upsertMany: (sessionID, candidates) =>
      Effect.sync(() => {
        experienceCandidatesWritten.push({ sessionID, candidates: [...candidates] })
        return candidates.length
      }),
    search: () => Effect.die("unexpected search"),
    formatExperienceSnapshot: (sessionID, taskKeywords, taskGoal) =>
      Effect.sync(() => {
        experienceSnapshotCalls.push([sessionID, [...taskKeywords], taskGoal])
        return ""
      }),
    maintain: () => Effect.die("unexpected maintain"),
    managementRead: () => Effect.die("unexpected managementRead"),
    managementUpdate: () => Effect.die("unexpected managementUpdate"),
    managementRemove: () => Effect.die("unexpected managementRemove"),
    managementCompact: () => Effect.die("unexpected managementCompact"),
  }),
)

const experienceCandidate: Memory.ExperienceCandidate = {
  kind: "failure",
  importance: 8,
  keywords: ["閮ㄧ讲"],
  content: "閮ㄧ讲鑴氭湰鎶ラ敊鏃跺厛鐪嬫棩蹇楀啀閲嶈瘯",
  evidence: "[ses_x#1] deploy.sh",
  confidence: "high",
}

const experienceWiringMemoryLayer = Layer.succeed(
  Memory.Service,
  Memory.Service.of({
    dir: () => Effect.succeed(Memory.DIRECTORY),
    resolveProjectID: (sessionID) => Effect.succeed(String(sessionID)),
    ensure: () => Effect.void,
    read: () => Effect.succeed(""),
    upsertTaskMemory: () => Effect.die("unexpected"),
    upsertUserMemory: () => Effect.die("unexpected"),
    write: () => Effect.die("unexpected"),
    replaceBySubstring: () => Effect.die("unexpected"),
    removeBySubstring: () => Effect.die("unexpected"),
    compact: () => Effect.die("unexpected"),
    usage: (_sessionID, scope) => Effect.succeed({ percentage: 0, used: 0, limit: 1, scope }),
    formatWithHeader: () => Effect.succeed(""),
    currentTaskKeywords: () => Effect.succeed([]),
    currentTaskContent: () => Effect.succeed("褰撳墠浠诲姟锛氫慨澶嶈璇佺己闄凤紱杩涘睍锛氳繘琛屼腑"),
    updateStepBegin: () =>
      Effect.succeed({ status: "updated" as const, taskUpdated: true, userUpdated: 0, experienceCandidates: [] }),
    updateAfterTurn: () =>
      Effect.succeed({
        status: "updated" as const,
        taskUpdated: true,
        userUpdated: 0,
        experienceCandidates: [experienceCandidate],
      }),
  }),
)

const withExperienceWiring = testEffect(
  makeHttp({ memory: experienceWiringMemoryLayer, experience: experienceMemoryLayer }),
)

withExperienceWiring.instance("writes experience candidates after the assistant turn", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Experience wiring" })
    experienceCandidatesWritten.splice(0)
    yield* llm.text("done")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      parts: [{ type: "text", text: "fix deploy" }],
    })
    expect(experienceCandidatesWritten.map((entry) => entry.candidates)).toEqual([[], [experienceCandidate]])
  }),
)

withExperienceWiring.instance("passes the task goal text into the experience snapshot query", () =>
  Effect.gen(function* () {
    experienceSnapshotCalls.length = 0
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Experience goal wiring" })
    yield* llm.text("hello experience goal")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      parts: [{ type: "text", text: "hello experience goal" }],
    })
    const last = experienceSnapshotCalls.at(-1)
    expect(last?.[1]).toEqual([])
    expect(last?.[2]).toBe("淇璁よ瘉缂洪櫡")
  }),
)

test("formats the existing user profile hint for curator dedup", () => {
  const hint = SessionPrompt.formatExistingUserHint([
    { scope: "user", importance: 9, keywords: ["涓枃"], content: "鐢ㄦ埛鍋忓ソ涓枃鍥炵瓟" },
  ])
  expect(hint).toContain("Existing user profile")
  expect(hint).toContain("keywords=[涓枃]")
  expect(hint).toContain("reuse the exact keywords to update a fact")
})
