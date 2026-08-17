export * as EventV2 from "./event"

import { Context, Effect, Layer, Option, PubSub, Schema, Stream } from "effect"
import { Location } from "./location"
import { withStatics } from "./schema"
import { Identifier } from "./util/identifier"

export const ID = Schema.String.pipe(
  Schema.brand("Event.ID"),
  withStatics((schema) => ({ create: () => schema.make("evt_" + Identifier.ascending()) })),
)
export type ID = typeof ID.Type

export type Definition<Type extends string = string, DataSchema extends Schema.Top = Schema.Top> = {
  readonly type: Type
  readonly version?: number
  readonly aggregate?: string
  /**
   * Future event definitions may be safely skipped by a projection that does
   * not understand them. Durable events remain strict by default.
   */
  readonly ignorable?: boolean
  readonly data: DataSchema
}

export type Data<D extends Definition> = Schema.Schema.Type<D["data"]>

export type Payload<D extends Definition = Definition> = {
  readonly id: ID
  readonly type: D["type"]
  readonly data: Data<D>
  readonly version?: number
  readonly ignorable?: boolean
  readonly location?: Location.Ref
  readonly metadata?: Record<string, unknown>
  readonly sequence?: number
  readonly aggregateSequence?: number
  readonly gap?: boolean
}

export type Sync = (event: Payload) => Effect.Effect<void>

export const registry = new Map<string, Definition>()

export function define<const Type extends string, Fields extends Schema.Struct.Fields>(input: {
  readonly type: Type
  readonly version?: number
  readonly aggregate?: string
  readonly ignorable?: boolean
  readonly schema: Fields
}): Schema.Schema<Payload<Definition<Type, Schema.Struct<Fields>>>> & Definition<Type, Schema.Struct<Fields>> {
  const Data = Schema.Struct(input.schema)
  const Payload = Schema.Struct({
    id: ID,
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    type: Schema.Literal(input.type),
    version: Schema.optional(Schema.Number),
    location: Schema.optional(Location.Ref),
    sequence: Schema.optional(Schema.Number),
    aggregateSequence: Schema.optional(Schema.Number),
    gap: Schema.optional(Schema.Boolean),
    data: Data,
  }).annotate({ identifier: input.type })

  const definition = Object.assign(Payload, {
    type: input.type,
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.aggregate === undefined ? {} : { aggregate: input.aggregate }),
    ...(input.ignorable === undefined ? {} : { ignorable: input.ignorable }),
    data: Data,
  })
  registry.set(input.type, definition)
  return definition as Schema.Schema<Payload<Definition<Type, Schema.Struct<Fields>>>> &
    Definition<Type, Schema.Struct<Fields>>
}

export function definitions() {
  return registry.values().toArray()
}

export interface PublishOptions {
  readonly id?: ID
  readonly metadata?: Record<string, unknown>
}

export type Unsubscribe = Effect.Effect<void>

export interface Interface {
  readonly publish: <D extends Definition>(
    definition: D,
    data: Data<D>,
    options?: PublishOptions,
  ) => Effect.Effect<Payload<D>>
  readonly publishEvent: <D extends Definition>(event: Payload<D>) => Effect.Effect<Payload<D>>
  readonly subscribe: <D extends Definition>(definition: D) => Stream.Stream<Payload<D>>
  readonly all: () => Stream.Stream<Payload>
  readonly sync: (handler: Sync) => Effect.Effect<Unsubscribe>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/Event") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Streams are a notification channel, not the durable event store. Keep
    // every subscriber bounded and let sequence numbers expose an overflow
    // gap; durable state is replayed from its owning store.
    const all = yield* PubSub.sliding<Payload>({ capacity: 1024, replay: 64 })
    const typed = new Map<string, PubSub.PubSub<Payload>>()
    const syncHandlers = new Array<Sync>()
    let sequence = 0
    const aggregateSequences = new Map<string, number>()

    const getOrCreate = (definition: Definition) =>
      Effect.gen(function* () {
        const existing = typed.get(definition.type)
        if (existing) return existing
        const durable = /permission|question|terminal|cleanup|kill|disposed/i.test(definition.type)
        const pubsub = yield* PubSub.sliding<Payload>({ capacity: durable ? 1024 : 256, replay: 64 })
        typed.set(definition.type, pubsub)
        return pubsub
      })

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* PubSub.shutdown(all)
        yield* Effect.forEach(typed.values(), PubSub.shutdown, { discard: true })
      }),
    )

    function publishEvent<D extends Definition>(event: Payload<D>) {
      return Effect.gen(function* () {
        const aggregateKey = definitionAggregate(event)
        const next = {
          ...event,
          sequence: event.sequence ?? ++sequence,
          ...(aggregateKey
            ? {
                aggregateSequence:
                  event.aggregateSequence ??
                  (aggregateSequences.set(aggregateKey, (aggregateSequences.get(aggregateKey) ?? 0) + 1),
                  aggregateSequences.get(aggregateKey)),
              }
            : {}),
        } as Payload<D>
        for (const sync of syncHandlers) {
          yield* sync(next as Payload)
        }
        const pubsub = typed.get(next.type)
        if (pubsub) yield* PubSub.publish(pubsub, next as Payload)
        yield* PubSub.publish(all, next as Payload)
        return next
      })
    }

    function definitionAggregate(event: Payload) {
      const definition = registry.get(event.type)
      return definition?.aggregate ? String((event.data as Record<string, unknown>)[definition.aggregate]) : undefined
    }

    function publish<D extends Definition>(definition: D, data: Data<D>, options?: PublishOptions) {
      return Effect.gen(function* () {
        const location = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
        const event = {
          id: options?.id ?? ID.create(),
          ...(options?.metadata ? { metadata: options.metadata } : {}),
          type: definition.type,
          ...(definition.version === undefined ? {} : { version: definition.version }),
          ...(location ? { location } : {}),
          data,
        } as Payload<D>
        return yield* publishEvent(event)
      })
    }

    const subscribe = <D extends Definition>(definition: D): Stream.Stream<Payload<D>> =>
      Stream.unwrap(getOrCreate(definition).pipe(Effect.map((pubsub) => Stream.fromPubSub(pubsub)))).pipe(
        Stream.map((event) => event as Payload<D>),
      )

    const streamAll = (): Stream.Stream<Payload> => Stream.fromPubSub(all)
    const sync = (handler: Sync): Effect.Effect<Unsubscribe> =>
      Effect.sync(() => {
        syncHandlers.push(handler)
        return Effect.sync(() => {
          const index = syncHandlers.indexOf(handler)
          if (index >= 0) syncHandlers.splice(index, 1)
        })
      })

    return Service.of({ publish, publishEvent, subscribe, all: streamAll, sync })
  }),
)

export const defaultLayer = layer
