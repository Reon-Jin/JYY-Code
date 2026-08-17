import type { Event } from "@jyycode-ai/sdk/v2"
import { useProject } from "./project"
import { useSDK } from "./sdk"

type EventMetadata = {
  workspace: string | undefined
}

// 与 desktop packages/app/src/data/event-bridge.ts 对齐：
// 后端把 event-v2 消息事件以 `session.next.*` 类型打包在 `sync` 信封里广播，
// 这里解包并映射回旧版 `message.*` 类型，否则实时消息更新会被丢弃。
const LEGACY_MESSAGE_EVENT_TYPES: Record<string, string> = {
  "message.updated": "message.updated",
  "message.removed": "message.removed",
  "message.part.updated": "message.part.updated",
  "message.part.removed": "message.part.removed",
  "session.next.message.updated": "message.updated",
  "session.next.message.removed": "message.removed",
  "session.next.message.part.updated": "message.part.updated",
  "session.next.message.part.removed": "message.part.removed",
}

type SyncEnvelope = {
  type: "sync"
  id?: string
  name?: string
  data?: unknown
  syncEvent?: { type?: string; name?: string; id?: string; data?: unknown }
}

type PayloadLike = {
  type: string
  id?: string
  properties?: unknown
  [key: string]: unknown
}

function syncEventType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  return typeof record.type === "string" ? record.type : typeof record.name === "string" ? record.name : undefined
}

export function normalizeEventPayload(payload: PayloadLike): PayloadLike {
  if (payload.type === "sync") {
    const envelope = payload as unknown as SyncEnvelope
    const syncEvent = envelope.syncEvent
    const rawType = syncEventType(syncEvent) ?? syncEventType(envelope)
    if (rawType) {
      const type = LEGACY_MESSAGE_EVENT_TYPES[rawType.replace(/\.\d+$/, "")]
      if (type) {
        const data = syncEvent ? syncEvent.data : envelope.data
        return { id: syncEvent?.id ?? envelope.id ?? payload.id, type, properties: data ?? {} }
      }
    }
    return payload
  }

  const type = LEGACY_MESSAGE_EVENT_TYPES[payload.type]
  if (!type) return payload
  return { ...payload, type }
}

export function useEvent() {
  const project = useProject()
  const sdk = useSDK()

  function subscribe(handler: (event: Event, metadata: EventMetadata) => void) {
    return sdk.event.on("event", (event) => {
      const payload = normalizeEventPayload(event.payload as unknown as PayloadLike)
      // 非消息类的 sync 信封（会话/计划等走其它通道）继续忽略
      if (payload.type === "sync") {
        return
      }

      if (event.directory === "global" || event.project === project.project()) {
        handler(payload as Event, { workspace: event.workspace })
      }
    })
  }

  function on<T extends Event["type"]>(
    type: T,
    handler: (event: Extract<Event, { type: T }>, metadata: EventMetadata) => void,
  ) {
    return subscribe((event: Event, metadata: EventMetadata) => {
      if (event.type !== type) return
      handler(event as Extract<Event, { type: T }>, metadata)
    })
  }

  return {
    subscribe,
    on,
  }
}
