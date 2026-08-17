export type EventClass = "coalescible" | "lossless-bounded" | "durable"

export type EventPolicy = {
  readonly kind: EventClass
  readonly capacity: number
  readonly key?: (event: unknown) => string
}

export const DEFAULT_EVENT_POLICIES: Readonly<Record<EventClass, EventPolicy>> = {
  coalescible: { kind: "coalescible", capacity: 256, key: (event) => JSON.stringify(event) },
  "lossless-bounded": { kind: "lossless-bounded", capacity: 1024 },
  durable: { kind: "durable", capacity: 1024 },
}

export function eventPolicy(kind: EventClass, options: { capacity?: number; key?: (event: unknown) => string } = {}) {
  const defaultPolicy = DEFAULT_EVENT_POLICIES[kind]
  return {
    ...defaultPolicy,
    capacity: Math.max(
      1,
      Math.min(kind === "coalescible" ? 256 : 1024, Math.floor(options.capacity ?? defaultPolicy.capacity)),
    ),
    ...(options.key ? { key: options.key } : {}),
  }
}

export function classifyEvent(type: string): EventClass {
  if (/delta|progress|diagnostic|status/i.test(type)) return "coalescible"
  if (/permission|question|terminal|cleanup|kill|disposed/i.test(type)) return "durable"
  return "lossless-bounded"
}
