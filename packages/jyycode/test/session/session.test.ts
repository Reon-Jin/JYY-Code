import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import * as Log from "@jyycode-ai/core/util/log"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Bus } from "@/bus"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { SessionEvent } from "@jyycode-ai/core/session-event"
import { Database } from "@/storage/db"
import { SessionTable } from "@/session/session.sql"
import { backfillSessionUsageFromStepFinishParts } from "@/data-migration"
import { eq } from "drizzle-orm"

void Log.init({ print: false })

const it = testEffect(
  Layer.mergeAll(
    SessionNs.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(SyncEvent.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
    CrossSpawnSpawner.defaultLayer,
    SyncEvent.defaultLayer,
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const remove = (id: SessionID) => SessionNs.use.remove(id)

const subscribeGlobal = (type: string, callback: (event: NonNullable<GlobalEvent["payload"]>) => void) => {
  const listener = (event: GlobalEvent) => {
    if (event.payload?.type === type) callback(event.payload)
  }
  GlobalBus.on("event", listener)
  return () => GlobalBus.off("event", listener)
}

describe("session.created event", () => {
  it.instance("should emit session.created event when session is created", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsub = subscribeGlobal(SessionNs.Event.Created.type, (event) => {
        Deferred.doneUnsafe(received, Effect.succeed(event.properties.info as SessionNs.Info))
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsub))

      const info = yield* session.create({})
      const receivedInfo = yield* awaitDeferred(received, "timed out waiting for session.created")

      expect(receivedInfo.id).toBe(info.id)
      expect(receivedInfo.projectID).toBe(info.projectID)
      expect(receivedInfo.directory).toBe(info.directory)
      expect(receivedInfo.path).toBe(info.path)
      expect(receivedInfo.title).toBe(info.title)

      yield* session.remove(info.id)
    }),
  )

  it.instance("session.created event should be emitted before session.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events: string[] = []
      const received = yield* Deferred.make<string[]>()
      const push = (event: string) => {
        events.push(event)
        if (events.includes("created") && events.includes("updated")) {
          Deferred.doneUnsafe(received, Effect.succeed(events))
        }
      }

      const unsubCreated = subscribeGlobal(SessionNs.Event.Created.type, () => {
        push("created")
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsubCreated))

      const unsubUpdated = subscribeGlobal(SessionNs.Event.Updated.type, () => {
        push("updated")
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsubUpdated))

      const info = yield* session.create({})
      const receivedEvents = yield* awaitDeferred(received, "timed out waiting for session created/updated events")

      expect(receivedEvents).toContain("created")
      expect(receivedEvents).toContain("updated")
      expect(receivedEvents.indexOf("created")).toBeLessThan(receivedEvents.indexOf("updated"))

      yield* session.remove(info.id)
    }),
  )
})

describe("step-finish token propagation via Bus event", () => {
  it.instance(
    "non-zero tokens propagate through PartUpdated event",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const info = yield* session.create({})

        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as MessageV2.Info)

        // Bus subscribers receive readonly Schema.Type payloads; `MessageV2.Part`
        // is the mutable domain type. Cast bridges the two — safe because the
        // test only reads the value afterwards.
        const received = yield* Deferred.make<MessageV2.Part>()
        const unsub = subscribeGlobal(SessionEvent.Legacy.PartUpdated.type, (event) => {
          Deferred.doneUnsafe(received, Effect.succeed(event.properties.part as MessageV2.Part))
        })
        yield* Effect.addFinalizer(() => Effect.sync(unsub))

        const tokens = {
          total: 1500,
          input: 500,
          output: 800,
          reasoning: 200,
          cache: { read: 100, write: 50 },
        }

        const partInput = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "step-finish" as const,
          reason: "stop",
          cost: 0.005,
          tokens,
        }

        yield* session.updatePart(partInput)
        const receivedPart = yield* awaitDeferred(received, "timed out waiting for message.part.updated")

        expect(receivedPart.type).toBe("step-finish")
        const finish = receivedPart as MessageV2.StepFinishPart
        expect(finish.tokens.input).toBe(500)
        expect(finish.tokens.output).toBe(800)
        expect(finish.tokens.reasoning).toBe(200)
        expect(finish.tokens.total).toBe(1500)
        expect(finish.tokens.cache.read).toBe(100)
        expect(finish.tokens.cache.write).toBe(50)
        expect(finish.cost).toBe(0.005)
        expect(receivedPart).not.toBe(partInput)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("session usage projection", () => {
  it.instance("keeps the older message.part.updated event path compatible", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})
      const messageID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as MessageV2.Info)
      const part = {
        id: PartID.ascending(), messageID, sessionID: session.id,
        type: "step-finish" as const, reason: "stop", cost: 0.2,
        tokens: { total: 42, input: 15, output: 12, reasoning: 5, cache: { read: 8, write: 2 } },
      }
      yield* SyncEvent.use.run(MessageV2.Event.PartUpdated, {
        sessionID: session.id, part, time: Date.now(),
      })
      let current = yield* sessions.get(session.id)
      expect(current.cost).toBeCloseTo(0.2)
      expect(current.tokens).toEqual({
        input: 15, output: 12, reasoning: 5, cache: { read: 8, write: 2 },
      })

      yield* SyncEvent.use.run(MessageV2.Event.PartRemoved, {
        sessionID: session.id, messageID, partID: part.id,
      })
      current = yield* sessions.get(session.id)
      expect(current.cost).toBeCloseTo(0)
      expect(current.tokens).toEqual({
        input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 },
      })
    }),
  )

  it.instance("keeps totals in sync when step parts are inserted, updated, and removed", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})
      const messageID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as MessageV2.Info)

      const part = {
        id: PartID.ascending(),
        messageID,
        sessionID: session.id,
        type: "step-finish" as const,
        reason: "stop",
        cost: 0.125,
        tokens: { total: 80, input: 30, output: 20, reasoning: 10, cache: { read: 15, write: 5 } },
      }
      yield* sessions.updatePart(part)
      let current = yield* sessions.get(session.id)
      expect(current.cost).toBeCloseTo(0.125)
      expect(current.tokens).toEqual({
        input: 30, output: 20, reasoning: 10, cache: { read: 15, write: 5 },
      })

      const revised = {
        ...part,
        cost: 0.25,
        tokens: { total: 120, input: 40, output: 30, reasoning: 20, cache: { read: 20, write: 10 } },
      }
      yield* sessions.updatePart(revised)
      current = yield* sessions.get(session.id)
      expect(current.cost).toBeCloseTo(0.25)
      expect(current.tokens).toEqual({
        input: 40, output: 30, reasoning: 20, cache: { read: 20, write: 10 },
      })

      const second = { ...part, id: PartID.ascending(), cost: 0.5 }
      yield* sessions.updatePart(second)
      current = yield* sessions.get(session.id)
      expect(current.cost).toBeCloseTo(0.75)
      expect(current.tokens).toEqual({
        input: 70, output: 50, reasoning: 30, cache: { read: 35, write: 15 },
      })

      yield* sessions.removePart({ sessionID: session.id, messageID, partID: part.id })
      current = yield* sessions.get(session.id)
      expect(current.cost).toBeCloseTo(0.5)
      expect(current.tokens).toEqual({
        input: 30, output: 20, reasoning: 10, cache: { read: 15, write: 5 },
      })

      yield* sessions.removeMessage({ sessionID: session.id, messageID })
      current = yield* sessions.get(session.id)
      expect(current.cost).toBeCloseTo(0)
      expect(current.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    }),
  )

  it.instance("backfills zeroed historical totals from step parts without double counting", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})
      const other = yield* sessions.create({})
      const messageID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as MessageV2.Info)
      const tokens = { total: 77, input: 31, output: 20, reasoning: 6, cache: { read: 15, write: 5 } }
      yield* sessions.updatePart({
        id: PartID.ascending(), messageID, sessionID: session.id,
        type: "step-finish", reason: "stop", cost: 0.375, tokens,
      })

      yield* Database.query((db) =>
        db.update(SessionTable)
          .set({ cost: 0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0,
            tokens_cache_read: 0, tokens_cache_write: 0 })
          .where(eq(SessionTable.id, session.id))
          .run(),
      )
      yield* Database.query((db) =>
        db.update(SessionTable).set({ cost: 1, tokens_input: 9 }).where(eq(SessionTable.id, other.id)).run(),
      )

      expect((yield* sessions.get(session.id)).tokens?.input).toBe(0)
      yield* backfillSessionUsageFromStepFinishParts()
      let current = yield* sessions.get(session.id)
      expect(current.cost).toBeCloseTo(0.375)
      expect(current.tokens).toEqual({
        input: 31, output: 20, reasoning: 6, cache: { read: 15, write: 5 },
      })
      expect((yield* sessions.get(other.id)).cost).toBe(1)

      yield* backfillSessionUsageFromStepFinishParts()
      current = yield* sessions.get(session.id)
      expect(current.cost).toBeCloseTo(0.375)
      expect(current.tokens).toEqual({
        input: 31, output: 20, reasoning: 6, cache: { read: 15, write: 5 },
      })
    }),
  )
})

describe("Session", () => {
  it.instance("preserves completed goal runs when a new goal starts", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({
        goal: { condition: "first goal", status: "running", startedAt: 10, updatedAt: 10 },
      })

      yield* session.setGoal({
        sessionID: created.id,
        goal: {
          ...created.goal!,
          status: "done",
          updatedAt: 20,
          completedAt: 20,
          result: "first complete",
        },
      })
      yield* session.setGoal({
        sessionID: created.id,
        goal: { condition: "second goal", status: "running", startedAt: 30, updatedAt: 30 },
      })

      const reloaded = yield* session.get(created.id)
      expect(reloaded.goal).toMatchObject({
        condition: "second goal",
        status: "running",
        history: [
          expect.objectContaining({
            condition: "first goal",
            status: "done",
            startedAt: 10,
            completedAt: 20,
            result: "first complete",
          }),
        ],
      })

      yield* session.remove(created.id)
    }),
  )

  it.live("remove works without an instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(dir)(session.create({ title: "remove-without-instance" }))

      const removeExit = yield* remove(info.id).pipe(Effect.exit)
      expect(Exit.isSuccess(removeExit)).toBe(true)

      const getExit = yield* session.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(getExit)).toBe(true)
    }),
  )
})
