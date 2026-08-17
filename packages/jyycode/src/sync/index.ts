// Legacy sync event system. It should stay unaware of core EventV2 execution;
// the only temporary V2 coupling here is exposing versioned core event schemas
// in effectPayloads() so existing HTTP/SDK schema generation remains stable.
// Remove that registry read when event schemas are generated from core directly.
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import { GlobalBus } from "@/bus/global"
import { Bus as ProjectBus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { EventSequenceTable, EventTable } from "./event.sql"
import { EventID } from "./schema"
import { Context, Effect, Layer, Schema as EffectSchema } from "effect"
import type { DeepMutable } from "@jyycode-ai/core/schema"
import { EventV2 } from "@jyycode-ai/core/event"
import { serviceUse } from "@/effect/service-use"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EffectBridge } from "@/effect/bridge"
import {
  SESSION_PROJECTOR,
  SESSION_PROJECTOR_VERSION,
  readWatermarkEffect,
  writeWatermarkEffect,
  ensureProjectionSchema,
} from "@/session/projection"
import { SessionMessageTable } from "@/session/session.sql"
import { SessionProjectionTable } from "@/session/projection.sql"
import { SessionID } from "@/session/schema"

// Keep `Event["data"]` mutable because projectors mutate the persisted shape
// when writing to the database. Bus payloads (`Properties`) stay readonly —
// subscribers only read.

export type Definition<
  Type extends string = string,
  Schema extends EffectSchema.Top = EffectSchema.Top,
  BusSchema extends EffectSchema.Top = Schema,
> = {
  type: Type
  version: number
  aggregate: string
  ignorable?: boolean
  schema: Schema
  // Bus event payload schema. Defaults to `schema` unless `busSchema` was
  // passed at definition time (see `session.updated`, whose projector
  // expands the persisted data to a `{ sessionID, info }` bus payload).
  properties: BusSchema
}

export type Event<Def extends Definition = Definition> = {
  id: string
  seq: number
  aggregateID: string
  type?: string
  ignorable?: boolean
  data: DeepMutable<EffectSchema.Schema.Type<Def["schema"]>>
}

export type Properties<Def extends Definition = Definition> = EffectSchema.Schema.Type<Def["properties"]>

export type SerializedEvent<Def extends Definition = Definition> = Event<Def> & { type: string }

type ProjectorFunc = (db: Database.TxOrDb, data: unknown, event: Event) => void
type ConvertEvent = (type: string, data: Event["data"]) => unknown | Promise<unknown>

export interface Interface {
  readonly run: <Def extends Definition>(
    def: Def,
    data: Event<Def>["data"],
    options?: { publish?: boolean },
  ) => Effect.Effect<void>
  readonly replay: (event: SerializedEvent, options?: { publish: boolean; ownerID?: string }) => Effect.Effect<void>
  readonly replayAll: (
    events: SerializedEvent[],
    options?: { publish: boolean; ownerID?: string },
  ) => Effect.Effect<string | undefined>
  readonly rebuild: (input: {
    aggregateID: string
    events?: SerializedEvent[]
    ownerID?: string
  }) => Effect.Effect<void>
  readonly remove: (aggregateID: string) => Effect.Effect<void>
  readonly claim: (aggregateID: string, ownerID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/SyncEvent") {}

export const layer = Layer.effect(Service)(
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const bus = yield* ProjectBus.Service

    const replay: Interface["replay"] = Effect.fn("SyncEvent.replay")(function* (event, options) {
      ensureProjectionSchema()
      const def = registry.get(event.type)
      if (!def && event.ignorable !== true) {
        throw new Error(`Unknown event type: ${event.type}`)
      }

      const row = yield* Database.query((db) =>
        db
          .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, event.aggregateID))
          .get(),
      )

      const projection = yield* Database.query((db) =>
        readWatermarkEffect(db, { aggregateID: event.aggregateID, projector: SESSION_PROJECTOR }),
      )
      const isSessionEvent = def?.aggregate === "sessionID" || event.type.startsWith("session.")
      const latest = isSessionEvent ? (projection?.seq ?? -1) : (row?.seq ?? -1)
      if (event.seq <= latest) return

      if (row?.ownerID && row.ownerID !== options?.ownerID) {
        return
      }

      const expected = latest + 1
      if (event.seq !== expected) {
        throw new Error(
          `Sequence mismatch for aggregate "${event.aggregateID}": expected ${expected}, got ${event.seq}`,
        )
      }

      if (!def) {
        yield* Database.withTransaction((tx) =>
          Effect.gen(function* () {
            if (flags.experimentalWorkspaces) {
              yield* tx
                .insert(EventSequenceTable)
                .values({ aggregate_id: event.aggregateID, seq: event.seq, owner_id: options?.ownerID })
                .onConflictDoUpdate({
                  target: EventSequenceTable.aggregate_id,
                  set: { seq: event.seq },
                })
                .run()
              yield* tx
                .insert(EventTable)
                .values({
                  id: event.id,
                  seq: event.seq,
                  aggregate_id: event.aggregateID,
                  type: event.type,
                  ignorable: true,
                  data: event.data as Record<string, unknown>,
                })
                .onConflictDoNothing({ target: EventTable.id })
                .run()
            }
            if (event.type.startsWith("session.")) {
              yield* writeWatermarkEffect(tx, { aggregateID: event.aggregateID, seq: event.seq })
            }
          }),
        )
        return
      }

      const publish = !!options?.publish
      const existing = yield* Database.query((db) =>
        db.select({ id: EventTable.id }).from(EventTable).where(eq(EventTable.id, event.id)).get(),
      )
      // Bridge captures handler-fiber refs (InstanceRef/WorkspaceRef) and the
      // full Effect context, so the forked publish + GlobalBus emit run with
      // the right state without a per-call attachWith.
      const bridge = yield* EffectBridge.make()
      yield* process(def, event, {
        bus,
        bridge,
        publish,
        ownerID: options?.ownerID,
        experimentalWorkspaces: flags.experimentalWorkspaces,
        persistEvent: !existing,
      })
    })

    const replayAll: Interface["replayAll"] = Effect.fn("SyncEvent.replayAll")(function* (events, options) {
      const source = events[0]?.aggregateID
      if (!source) return undefined
      if (events.some((item) => item.aggregateID !== source)) {
        throw new Error("Replay events must belong to the same session")
      }
      const start = events[0].seq
      for (const [i, item] of events.entries()) {
        const seq = start + i
        if (item.seq !== seq) {
          throw new Error(`Replay sequence mismatch at index ${i}: expected ${seq}, got ${item.seq}`)
        }
      }
      for (const item of events) {
        yield* replay(item, options)
      }
      return source
    })

    const run: Interface["run"] = Effect.fn("SyncEvent.run")(function* (def, data, options) {
      ensureProjectionSchema()
      const agg = (data as Record<string, string>)[def.aggregate]
      // This should never happen: we've enforced it via typescript in
      // the definition
      if (agg == null) {
        throw new Error(`SyncEvent.run: "${def.aggregate}" required but not found: ${JSON.stringify(data)}`)
      }

      if (def.version !== versions.get(def.type)) {
        throw new Error(`SyncEvent.run: running old versions of events is not allowed: ${def.type}`)
      }

      const { publish = true } = options || {}
      const bridge = yield* EffectBridge.make()

      // Note that this is an "immediate" transaction which is critical.
      // We need to make sure we can safely read and write with nothing
      // else changing the data from under us
      yield* Database.withTransaction(
        (tx) =>
          Effect.gen(function* () {
            const id = EventID.ascending()
            const row = yield* tx
              .select({ seq: EventSequenceTable.seq })
              .from(EventSequenceTable)
              .where(eq(EventSequenceTable.aggregate_id, agg))
              .get()
            const seq = row?.seq != null ? row.seq + 1 : 0

            const event = { id, seq, aggregateID: agg, data, ignorable: def.ignorable }
            yield* process(def, event, {
              bus,
              bridge,
              publish,
              experimentalWorkspaces: flags.experimentalWorkspaces,
              persistEvent: true,
            })
          }),
        {
          behavior: "immediate",
        },
      )
    })

    const remove: Interface["remove"] = Effect.fn("SyncEvent.remove")(function* (aggregateID) {
      yield* Database.withTransaction((tx) =>
        Effect.gen(function* () {
          yield* tx.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).run()
          yield* tx.delete(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).run()
        }),
      )
    })

    const rebuild: Interface["rebuild"] = Effect.fn("SyncEvent.rebuild")(function* (input) {
      ensureProjectionSchema()
      const source =
        input.events ??
        (yield* Database.query((db) =>
          db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, input.aggregateID))
            .orderBy(EventTable.seq)
            .all(),
        )).map((row) => ({
          id: row.id,
          seq: row.seq,
          aggregateID: row.aggregate_id,
          type: row.type,
          ignorable: row.ignorable,
          data: row.data,
        }))

      const bridge = yield* EffectBridge.make()
      yield* Database.withTransaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .delete(SessionMessageTable)
            .where(eq(SessionMessageTable.session_id, SessionID.make(input.aggregateID)))
            .run()
          yield* tx
            .delete(SessionProjectionTable)
            .where(eq(SessionProjectionTable.aggregate_id, input.aggregateID))
            .run()

          for (const event of source) {
            const def = registry.get(event.type)
            if (!def && event.ignorable !== true) throw new Error(`Unknown event type: ${event.type}`)
            if (!def) {
              yield* writeWatermarkEffect(tx, {
                aggregateID: input.aggregateID,
                seq: event.seq,
                projectorVersion: SESSION_PROJECTOR_VERSION,
              })
              continue
            }
            yield* process(def, event, {
              bus,
              bridge,
              publish: false,
              ownerID: input.ownerID,
              experimentalWorkspaces: false,
              persistEvent: false,
              force: true,
            })
          }
        }),
      )
    })

    const claim: Interface["claim"] = Effect.fn("SyncEvent.claim")((aggregateID, ownerID) =>
      Database.query((db) =>
        db
          .update(EventSequenceTable)
          .set({ owner_id: ownerID })
          .where(eq(EventSequenceTable.aggregate_id, aggregateID))
          .run(),
      ),
    )

    return Service.of({
      run,
      replay,
      replayAll,
      rebuild,
      remove,
      claim,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide([ProjectBus.defaultLayer, RuntimeFlags.defaultLayer]))

export const use = serviceUse(Service)

export const registry = new Map<string, Definition>()
let projectors: Map<string, ProjectorFunc> | undefined
const versions = new Map<string, number>()
let frozen = false
let convertEvent: ConvertEvent

export function reset() {
  frozen = false
  projectors = undefined
  convertEvent = (_, data) => data
}

export function init(input: { projectors: Array<[Definition, ProjectorFunc]>; convertEvent?: ConvertEvent }) {
  projectors = new Map(input.projectors.map(([def, func]) => [versionedType(def.type, def.version), func]))
  for (let entry of EventV2.registry.values()) {
    if (!entry.version || !entry.aggregate) continue
    register({
      type: entry.type,
      version: entry.version,
      aggregate: entry.aggregate,
      ignorable: entry.ignorable,
      properties: entry.data,
      schema: entry.data,
    })
  }

  // Install all the latest event defs to the bus. We only ever emit
  // latest versions from code, and keep around old versions for
  // replaying. Replaying does not go through the bus, and it
  // simplifies the bus to only use unversioned latest events
  for (let [type, version] of versions.entries()) {
    let def = registry.get(versionedType(type, version))!
    BusEvent.define(def.type, def.properties)
  }

  // Freeze the system so it clearly errors if events are defined
  // after `init` which would cause bugs
  frozen = true
  convertEvent = input.convertEvent ?? ((_, data) => data)
}

export function versionedType<A extends string>(type: A): A
export function versionedType<A extends string, B extends number>(type: A, version: B): `${A}/${B}`
export function versionedType(type: string, version?: number) {
  return version ? `${type}.${version}` : type
}

export function define<
  Type extends string,
  Agg extends string,
  Schema extends EffectSchema.Top,
  BusSchema extends EffectSchema.Top = Schema,
>(input: {
  type: Type
  version: number
  aggregate: Agg
  ignorable?: boolean
  schema: Schema
  busSchema?: BusSchema
}): Definition<Type, Schema, BusSchema> {
  if (frozen) {
    throw new Error("Error defining sync event: sync system has been frozen")
  }

  const def = {
    type: input.type,
    version: input.version,
    aggregate: input.aggregate,
    ignorable: input.ignorable,
    schema: input.schema,
    properties: (input.busSchema ?? input.schema) as BusSchema,
  }

  register(def)

  return def
}

export function project<Def extends Definition>(
  def: Def,
  func: (db: Database.TxOrDb, data: Event<Def>["data"], event: Event<Def>) => void,
): [Definition, ProjectorFunc] {
  return [def, func as ProjectorFunc]
}

function register(def: Definition) {
  versions.set(def.type, Math.max(def.version, versions.get(def.type) || 0))
  registry.set(versionedType(def.type, def.version), def)
}

const process = Effect.fnUntraced(function* <Def extends Definition>(
  def: Def,
  event: Event<Def>,
  options: {
    bus: ProjectBus.Interface
    bridge: EffectBridge.Shape
    publish: boolean
    ownerID?: string
    experimentalWorkspaces: boolean
    persistEvent: boolean
    force?: boolean
  },
) {
  if (projectors == null) {
    throw new Error("No projectors available. Call `SyncEvent.init` to install projectors")
  }

  const projector = projectors.get(versionedType(def.type, def.version))
  if (!projector) {
    if (def.ignorable === true) {
      yield* Database.withTransaction((tx) =>
        writeWatermarkEffect(tx, {
          aggregateID: event.aggregateID,
          seq: event.seq,
          projectorVersion: SESSION_PROJECTOR_VERSION,
        }),
      )
      return
    }
    if (def.type.startsWith("session.")) throw new Error(`Projector not found for event: ${def.type}`)
    return
  }

  yield* Database.withTransaction((tx) =>
    Effect.gen(function* () {
      const eventType = event.type ?? def.type
      if (!options.force && eventType.startsWith("session.")) {
        const watermark = yield* readWatermarkEffect(tx, {
          aggregateID: event.aggregateID,
          projector: SESSION_PROJECTOR,
        })
        if (watermark && event.seq <= watermark.seq) return
      }

      // Projectors remain synchronous while their generated shapes are shared
      // with legacy replay code. Both adapters use the same scoped connection,
      // so these writes participate in the Effect-owned native transaction.
      yield* Effect.sync(() => Database.legacyQuery((db) => projector(db, event.data, event)))

      // EventV2 session events are durable regardless of the legacy workspace
      // feature flag. The sequence row is the allocator for the next event,
      // so skipping it would make every EventV2 publish reuse seq 0.
      const persistEvent = options.persistEvent && (options.experimentalWorkspaces || def.type.startsWith("session."))
      if (persistEvent) {
        yield* tx
          .insert(EventSequenceTable)
          .values({
            aggregate_id: event.aggregateID,
            seq: event.seq,
            owner_id: options?.ownerID,
          })
          .onConflictDoUpdate({
            target: EventSequenceTable.aggregate_id,
            set: { seq: event.seq },
          })
          .run()
        yield* tx
          .insert(EventTable)
          .values({
            id: event.id,
            seq: event.seq,
            aggregate_id: event.aggregateID,
            type: versionedType(def.type, def.version),
            ignorable: def.ignorable ?? false,
            data: event.data as Record<string, unknown>,
          })
          .run()
      }

      if (eventType.startsWith("session.")) {
        yield* writeWatermarkEffect(tx, {
          aggregateID: event.aggregateID,
          seq: event.seq,
          projectorVersion: SESSION_PROJECTOR_VERSION,
        })
      }

      yield* Database.afterCommit(
        Effect.sync(() => {
          if (!options.publish) return
          const result = convertEvent(def.type, event.data)
          // The bridge was built inside the caller's fiber so it already carries
          // InstanceRef/WorkspaceRef and the full Effect context. Both the bus
          // publish and the GlobalBus emit run inside the forked Effect so they
          // share the same instance/workspace lookup.
          const publish = (data: unknown) =>
            options.bridge.fork(
              Effect.gen(function* () {
                yield* options.bus.publish(def, data as Properties<Def>, { id: event.id })
                const instance = yield* InstanceState.context
                const workspace = yield* InstanceState.workspaceID
                GlobalBus.emit("event", {
                  directory: instance.directory,
                  project: instance.project.id,
                  workspace,
                  payload: {
                    type: "sync",
                    syncEvent: {
                      type: versionedType(def.type, def.version),
                      ...event,
                    },
                  },
                })
              }),
            )
          if (result instanceof Promise) {
            void result.then(publish)
          } else {
            publish(result)
          }
        }),
      )
    }),
  )
})

export function effectPayloads() {
  return [
    ...registry
      .entries()
      .map(([type, def]) =>
        EffectSchema.Struct({
          type: EffectSchema.Literal("sync"),
          name: EffectSchema.Literal(type),
          id: EffectSchema.String,
          seq: EffectSchema.Finite,
          aggregateID: EffectSchema.Literal(def.aggregate),
          data: def.schema,
        }).annotate({ identifier: `SyncEvent.${type}` }),
      )
      .toArray(),
    ...EventV2.registry
      .values()
      .filter(
        (definition) =>
          definition.version !== undefined && !registry.has(versionedType(definition.type, definition.version)),
      )
      .map((definition) =>
        EffectSchema.Struct({
          type: EffectSchema.Literal("sync"),
          name: EffectSchema.Literal(versionedType(definition.type, definition.version!)),
          id: EffectSchema.String,
          seq: EffectSchema.Finite,
          aggregateID: EffectSchema.Literal(definition.aggregate!),
          data: definition.data,
        }).annotate({ identifier: `SyncEvent.${definition.type}` }),
      )
      .toArray(),
  ]
}

export * as SyncEvent from "."
