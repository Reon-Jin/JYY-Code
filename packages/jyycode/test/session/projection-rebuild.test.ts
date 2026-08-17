import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { Effect, Layer, Schema } from "effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Bus } from "@/bus"
import { Database, eq } from "@/storage/db"
import { EventTable } from "@/sync/event.sql"
import { SyncEvent } from "@/sync"
import { SessionProjectionTable } from "@/session/projection.sql"
import { SESSION_PROJECTOR, SESSION_PROJECTOR_VERSION, decide, needsRebuild, readWatermark } from "@/session/projection"
import { initProjectors } from "@/server/projectors"

const it = testEffect(
  Layer.mergeAll(
    SyncEvent.layer.pipe(
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: true })),
      Layer.provideMerge(Bus.layer),
    ),
    CrossSpawnSpawner.defaultLayer,
  ),
)

beforeEach(() => Database.close())

describe("session projection watermarks", () => {
  function setup() {
    SyncEvent.reset()
    let applied = 0
    const TestEvent = SyncEvent.define({
      type: "session.test.projection",
      version: 1,
      aggregate: "sessionID",
      schema: Schema.Struct({ sessionID: Schema.String, value: Schema.String }),
    })
    SyncEvent.init({
      projectors: [
        SyncEvent.project(TestEvent, () => {
          applied += 1
        }),
      ],
    })
    return { TestEvent, applied: () => applied }
  }

  afterAll(() => {
    SyncEvent.reset()
    initProjectors()
  })

  it.live(
    "records a versioned watermark, tails from it, and rebuilds from seq zero",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { TestEvent, applied } = setup()
        const sessionID = "ses_projection_rebuild"

        yield* SyncEvent.use.run(TestEvent, { sessionID, value: "first" }, { publish: false })
        yield* SyncEvent.use.run(TestEvent, { sessionID, value: "second" }, { publish: false })

        let watermark = Database.use((db) => readWatermark(db, { aggregateID: sessionID }))
        expect(watermark).toMatchObject({
          aggregateID: sessionID,
          projector: SESSION_PROJECTOR,
          projectorVersion: SESSION_PROJECTOR_VERSION,
          seq: 1,
        })
        expect(applied()).toBe(2)

        Database.use((db) =>
          db.delete(SessionProjectionTable).where(eq(SessionProjectionTable.aggregate_id, sessionID)).run(),
        )
        const events = Database.use((db) => db.select().from(EventTable).orderBy(EventTable.seq).all())
        yield* SyncEvent.use.replay(
          {
            id: events[0].id,
            type: events[0].type,
            seq: events[0].seq,
            aggregateID: sessionID,
            data: events[0].data,
          },
          { publish: false },
        )
        watermark = Database.use((db) => readWatermark(db, { aggregateID: sessionID }))
        expect(watermark?.seq).toBe(0)

        yield* SyncEvent.use.replay(
          {
            id: events[1].id,
            type: events[1].type,
            seq: events[1].seq,
            aggregateID: sessionID,
            data: events[1].data,
          },
          { publish: false },
        )
        expect(Database.use((db) => readWatermark(db, { aggregateID: sessionID })?.seq)).toBe(1)

        yield* SyncEvent.use.rebuild({ aggregateID: sessionID })
        expect(Database.use((db) => readWatermark(db, { aggregateID: sessionID })?.seq)).toBe(1)
        expect(applied()).toBe(6)
        expect(Database.use((db) => db.select().from(EventTable).all())).toHaveLength(2)

        // A duplicate replay is a no-op once the projection watermark has
        // consumed the event, even though the source event remains durable.
        yield* SyncEvent.use.replay(
          {
            id: events[1].id,
            type: events[1].type,
            seq: events[1].seq,
            aggregateID: sessionID,
            data: events[1].data,
          },
          { publish: false },
        )
        expect(applied()).toBe(6)
      }),
    ),
  )

  it.live(
    "rejects required unknown events and advances over ignorable future events",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { TestEvent } = setup()
        const sessionID = "ses_projection_unknown"
        const unknown = {
          id: "evt_unknown_required",
          type: "session.next.future.required.1",
          seq: 0,
          aggregateID: sessionID,
          data: {},
        }
        const required = yield* Effect.exit(SyncEvent.use.replay(unknown, { publish: false }))
        expect(required._tag).toBe("Failure")

        yield* SyncEvent.use.replay(
          {
            ...unknown,
            id: "evt_unknown_ignorable",
            type: "session.next.future.ignorable.1",
            ignorable: true,
          },
          { publish: false },
        )
        expect(Database.use((db) => readWatermark(db, { aggregateID: sessionID })?.seq)).toBe(0)
        expect(Database.use((db) => db.select().from(EventTable).all())).toHaveLength(1)
        expect(TestEvent.type).toContain("session.test")
      }),
    ),
  )

  test("makes projector version upgrades force a rebuild", () => {
    expect(needsRebuild(undefined, 2)).toBe(false)
    expect(
      needsRebuild(
        {
          aggregateID: "ses_1",
          projector: SESSION_PROJECTOR,
          projectorVersion: 1,
          seq: 4,
          updatedAt: 1,
        },
        2,
      ),
    ).toBe(true)
    expect(
      decide({
        watermark: undefined,
        event: { aggregateID: "ses_1", seq: 0, type: "future", version: 1, ignorable: true },
        accepted: new Set(),
      }),
    ).toEqual({ _tag: "skip", seq: 0, reason: "ignorable" })
  })
})
