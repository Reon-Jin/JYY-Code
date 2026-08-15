import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "bun:test"
import { Context, Effect, Exit, Fiber, Layer } from "effect"
import { eq } from "drizzle-orm"
import path from "node:path"

import { Agent as AgentSvc } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { BackgroundProcess } from "@/process/job"
import { Bus } from "@/bus"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "@/env"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { Session } from "@/session/session"
import { LLM } from "@/session/llm"
import { SessionCompaction } from "@/session/compaction"
import { SessionSummary } from "@/session/summary"
import { Instruction } from "@/session/instruction"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SystemPrompt } from "@/session/system"
import { Skill } from "@/skill"
import { Snapshot } from "@/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { NodeFileSystem } from "@effect/platform-node"
import { Reference } from "@/reference/reference"
import { RepositoryCache } from "@/reference/repository-cache"
import { Ripgrep } from "@/file/ripgrep"
import { Format } from "@/format"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventRuntime } from "@/event-runtime"
import { EpisodicMemory } from "@/memory/episodic"
import * as BlobStore from "@/storage/blob"
import { blobURL } from "@/storage/blob-path"
import { replaySecretFindings } from "../lib/replay/normalize"
import { sha256 } from "@/session/request-envelope"
import { Database } from "@/storage/db"
import { EventTable } from "@/sync/event.sql"
import { SessionMessageTable } from "@/session/session.sql"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { assertFixture } from "../lib/replay/runner"
import type { ReplayFixture } from "../lib/replay/schema"
import { ModelID, ProviderID } from "@/provider/schema"

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
    startAuth: () => Effect.die("unexpected MCP auth in replay tests"),
    authenticate: () => Effect.die("unexpected MCP auth in replay tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in replay tests"),
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

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

const makePrompt = () => {
  const runtimeFlags = RuntimeFlags.layer()
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
  const proc = SessionProcessor.layer.pipe(
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
  return SessionPrompt.layer.pipe(
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
  )
}

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, BlobStore.defaultLayer, makePrompt()))

const config = (url: string) => ({
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
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

type ReplayInput = { scenario: string; prompt: string }
type ModelReply = Record<string, unknown>

const replayRoot = path.resolve(import.meta.dir, "../fixture/replay")

function replayPath(name: string) {
  return path.join(replayRoot, `${name}.json`)
}

function eventType(type: string) {
  return type.replace(/\.\d+$/, "")
}

const assistantSummary = (messages: Array<{ info: { role: string } }>) => ({
  assistantCount: messages.filter((message) => message.info.role === "assistant").length,
  finalRole: messages.at(-1)?.info.role,
})

function queueReplies(fixture: ReplayFixture, llm: TestLLMServer["Service"], dir: string) {
  return Effect.gen(function* () {
    for (const raw of fixture.modelReplies as ModelReply[]) {
      switch (raw.type) {
        case "text":
          yield* llm.text(String(raw.text))
          break
        case "tool":
          yield* llm.tool(String(raw.name), raw.input ?? {})
          break
        case "error":
          yield* llm.error(Number(raw.status), raw.body ?? { error: { message: "temporary" } })
          break
        case "hang":
          yield* llm.hang
          break
        default:
          throw new Error(`Unknown replay reply: ${String(raw.type)}`)
      }
    }
    void dir
  })
}

function executeReplay(fixture: ReplayFixture) {
  return provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const input = fixture.sessionInput as ReplayInput
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const status = yield* SessionStatus.Service
        const compaction = yield* SessionCompaction.Service
        const sync = yield* SyncEvent.Service
        const blobStore = yield* BlobStore.Service

        yield* queueReplies(fixture, llm, dir)

        const parent =
          input.scenario === "plan-child"
            ? yield* sessions.create({
                title: "Plan parent",
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
            : undefined
        const session = yield* sessions.create({
          title: "Pinned",
          ...(parent ? { parentID: parent.id } : {}),
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          model: { providerID: ProviderID.make("test"), id: ModelID.make("test-model") },
        })

        if (input.scenario === "compaction") {
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "seed conversation before compaction" }],
          })
          const info = yield* sessions.get(session.id).pipe(Effect.orDie)
          if (!info.model) throw new Error("replay compaction requires a session model")
          const created = yield* compaction.create({
            sessionID: session.id,
            agent: "build",
            model: { providerID: info.model.providerID, modelID: info.model.id },
            auto: false,
          })
          expect(created).toBe(true)
          yield* prompt.loop({ sessionID: session.id })
        } else if (input.scenario === "cancel") {
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: input.prompt }],
          })
          const running = yield* prompt.loop({ sessionID: session.id }).pipe(Effect.forkChild)
          yield* llm.wait(1)
          yield* prompt.cancel(session.id)
          const exit = yield* Fiber.await(running)
          if (Exit.isFailure(exit)) throw new Error("cancelled replay loop failed")
        } else {
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: input.prompt }],
          })
        }

        const inputs = yield* llm.inputs
        const events = yield* Database.query((db) =>
          db.select().from(EventTable).where(eq(EventTable.aggregate_id, session.id)).orderBy(EventTable.seq).all(),
        )
        const projected = yield* Database.query((db) =>
          db
            .select()
            .from(SessionMessageTable)
            .where(eq(SessionMessageTable.session_id, session.id))
            .orderBy(SessionMessageTable.time_created, SessionMessageTable.id)
            .all(),
        )
        yield* sync.replayAll(
          events.map((event) => ({
            id: event.id,
            seq: event.seq,
            aggregateID: event.aggregate_id,
            type: event.type,
            data: event.data,
          })),
          { publish: false },
        )
        const replayedProjection = yield* Database.query((db) =>
          db
            .select()
            .from(SessionMessageTable)
            .where(eq(SessionMessageTable.session_id, session.id))
            .orderBy(SessionMessageTable.time_created, SessionMessageTable.id)
            .all(),
        )
        const messages = yield* sessions.messages({ sessionID: session.id })
        const finalStatus = yield* status.get(session.id)
        const eventTypes = events.map((event) => eventType(event.type))
        const expectedEvents = (fixture.expected.events as string[]).map(String)
        const requestEvents = events.filter((event) => eventType(event.type) === "session.next.request.prepared")

        expect(inputs.length).toBe((fixture.expected.requestEnvelopes as Array<{ requestCount: number }>)[0]!.requestCount)
        expect(requestEvents).toHaveLength(inputs.length)
        for (const event of requestEvents) {
          const data = event.data as { payload: { blobID: string; sha256: string; bytes: number } }
          const bytes = yield* blobStore.readURL(blobURL(data.payload.blobID))
          expect(bytes.byteLength).toBe(data.payload.bytes)
          expect(sha256(bytes)).toBe(data.payload.sha256)
          expect(replaySecretFindings(JSON.parse(new TextDecoder().decode(bytes)))).toEqual([])
        }
        expect(inputs.some((body) => JSON.stringify(body).includes(input.prompt) || input.scenario === "compaction")).toBe(
          true,
        )
        expect(projected.length).toBeGreaterThan(0)
        expect(replayedProjection).toEqual(projected)
        expect(messages.some((message) => message.info.role === "assistant")).toBe(true)
        if (input.scenario === "tool-loop") {
          expect(
            messages.some((message) => message.parts.some((part) => part.type === "tool")),
          ).toBe(true)
        }
        const expectedTerminal = fixture.terminalStatus as { type: "busy" | "idle" | "retry" }
        expect(finalStatus.type).toBe(expectedTerminal.type)
        expect(eventTypes.filter((type) => expectedEvents.includes(type))).toEqual(expectedEvents)

        return {
          expected: {
            requestEnvelopes: [{ scenario: input.scenario, requestCount: inputs.length }],
            messages: [assistantSummary(messages)],
            events: expectedEvents,
            files: [],
          },
          terminalStatus: { type: finalStatus.type },
        }
      }),
    { config },
  )
}

function replayTest(name: string): Effect.Effect<unknown, never, never> {
  return Effect.contextWith((context) =>
    Effect.promise(async () =>
      assertFixture(replayPath(name), {
        execute: (fixture) =>
          Effect.runPromiseWith(context as Context.Context<any>)(executeReplay(fixture)),
      }),
    ),
  ) as Effect.Effect<unknown, never, never>
}

it.live("golden replay: text turn", () => replayTest("text-turn"))
it.live("golden replay: tool loop", () => replayTest("tool-loop"))
it.live("golden replay: retry", () => replayTest("retry"))
it.live("golden replay: cancel", () => replayTest("cancel"))
it.live("golden replay: manual compaction", () => replayTest("compaction"))
it.live("golden replay: plan child", () => replayTest("plan-child"))
