import type { GlobalEvent, Part, SessionMessagesResponse } from "@jyycode-ai/sdk/v2/client"

export type ConversationMessage = SessionMessagesResponse[number]

export type PendingPartDelta = { field: string; delta: string }

export type ConversationSnapshot = {
  sessionID: string
  messages: SessionMessagesResponse
  processedEventIDs: readonly string[]
  needsRefetch: boolean
  /**
   * Deltas that arrived before their base part existed. The server emits
   * `message.part.updated` before `message.part.delta` for a part, but a
   * refetch can still race the first deltas of a turn; buffering them here
   * avoids permanently dropping the head of a streamed reply. Replayed once
   * the part exists, then removed.
   */
  pendingDeltas?: Readonly<Record<string, readonly PendingPartDelta[]>>
}

const PROCESSED_EVENT_LIMIT = 512

const EMPTY_PENDING_DELTAS: Readonly<Record<string, readonly PendingPartDelta[]>> = Object.freeze({})

const LEGACY_MESSAGE_EVENT_TYPES = {
  "session.next.message.updated": "message.updated",
  "session.next.message.removed": "message.removed",
  "session.next.message.part.updated": "message.part.updated",
  "session.next.message.part.removed": "message.part.removed",
} as const

/**
 * The server publishes session progress both through the legacy
 * `message.*` event names and through the event-v2 `session.next.*` names.
 * Normalize the v2 names to the legacy shapes the rest of the client uses so
 * live reasoning/tool/text updates are not silently dropped.
 */
export function normalizeConversationPayload(payload: GlobalEvent["payload"]): GlobalEvent["payload"] {
  const type = LEGACY_MESSAGE_EVENT_TYPES[payload.type as keyof typeof LEGACY_MESSAGE_EVENT_TYPES]
  if (!type) return payload
  return { ...payload, type } as GlobalEvent["payload"]
}

function pendingDeltasOf(snapshot: ConversationSnapshot) {
  return snapshot.pendingDeltas ?? EMPTY_PENDING_DELTAS
}

function pendingKey(messageID: string, partID: string) {
  return `${messageID}:${partID}`
}

export function emptyConversationSnapshot(sessionID: string): ConversationSnapshot {
  return { sessionID, messages: [], processedEventIDs: [], needsRefetch: false, pendingDeltas: {} }
}

export function snapshotFromMessages(sessionID: string, messages: SessionMessagesResponse): ConversationSnapshot {
  return {
    sessionID,
    messages: [...messages]
      .map((message) => ({ info: message.info, parts: sortByID(message.parts) }))
      .sort((left, right) => compareMessages(left.info, right.info)),
    processedEventIDs: [],
    needsRefetch: false,
    pendingDeltas: {},
  }
}

export function isConversationSnapshot(value: unknown): value is ConversationSnapshot {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<ConversationSnapshot>
  return (
    typeof candidate.sessionID === "string" &&
    Array.isArray(candidate.messages) &&
    Array.isArray(candidate.processedEventIDs) &&
    typeof candidate.needsRefetch === "boolean"
  )
}

function messageHasPartAhead(
  message: ConversationSnapshot["messages"][number],
  baselinePart: ConversationSnapshot["messages"][number]["parts"][number],
) {
  const candidate = message.parts.find((part) => part.id === baselinePart.id)
  if (!candidate) return false
  const baselineText = "text" in baselinePart ? baselinePart.text : undefined
  if (typeof baselineText === "string") {
    const candidateText = "text" in candidate ? candidate.text : undefined
    return typeof candidateText === "string" && candidateText.length >= baselineText.length
  }
  return true
}

/**
 * Returns true when `candidate` contains every message and part present in
 * `baseline`. A background refetch may start before the server has persisted
 * the latest streamed events; in that case the locally patched snapshot is
 * ahead of the fetched response and must not overwrite it.
 */
export function isConversationSnapshotAhead(candidate: ConversationSnapshot, baseline: ConversationSnapshot): boolean {
  const candidateMessages = new Map(candidate.messages.map((message) => [message.info.id, message]))
  for (const message of baseline.messages) {
    const candidateMessage = candidateMessages.get(message.info.id)
    if (!candidateMessage) return false
    for (const part of message.parts) {
      if (!messageHasPartAhead(candidateMessage, part)) return false
    }
  }
  return true
}

function sortByID<T extends { id: string }>(values: readonly T[]) {
  return [...values].sort((left, right) => left.id.localeCompare(right.id))
}

function compareMessages(
  left: Pick<ConversationMessage["info"], "id" | "time">,
  right: Pick<ConversationMessage["info"], "id" | "time">,
) {
  const leftTime = left.time?.created ?? 0
  const rightTime = right.time?.created ?? 0
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1
  if (left.id === right.id) return 0
  return left.id < right.id ? -1 : 1
}

function lowerBound<T>(values: readonly T[], value: T, compare: (left: T, right: T) => number) {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (compare(values[middle]!, value) < 0) low = middle + 1
    else high = middle
  }
  return low
}

function locate<T>(values: readonly T[], id: string, idOf: (value: T) => string) {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (idOf(values[middle]!) < id) low = middle + 1
    else high = middle
  }
  return { index: low, found: low < values.length && idOf(values[low]!) === id }
}

type MessageIndex = Map<string, number>

function createMessageIndex(messages: ConversationSnapshot["messages"]): MessageIndex {
  return new Map(messages.map((message, index) => [message.info.id, index]))
}

function locateMessage(messages: ConversationSnapshot["messages"], id: string, index?: MessageIndex) {
  if (index) {
    const position = index.get(id)
    return {
      index: position ?? -1,
      found: position !== undefined && messages[position]?.info.id === id,
    }
  }
  const position = messages.findIndex((message) => message.info.id === id)
  return { index: position, found: position >= 0 }
}

function eventSessionID(payload: GlobalEvent["payload"]) {
  switch (payload.type) {
    case "message.updated":
    case "message.removed":
    case "message.part.updated":
    case "message.part.delta":
    case "message.part.removed":
      return payload.properties.sessionID
    default:
      return undefined
  }
}

function remember(
  snapshot: ConversationSnapshot,
  eventID: string,
  change?: Partial<Pick<ConversationSnapshot, "messages" | "needsRefetch" | "pendingDeltas">>,
) {
  const processedEventIDs = [...snapshot.processedEventIDs, eventID].slice(-PROCESSED_EVENT_LIMIT)
  return { ...snapshot, ...change, processedEventIDs }
}

function missingTarget(snapshot: ConversationSnapshot, eventID: string) {
  return remember(snapshot, eventID, { needsRefetch: true })
}

function bufferPartDelta(
  snapshot: ConversationSnapshot,
  eventID: string,
  messageID: string,
  partID: string,
  field: string,
  delta: string,
) {
  const pending = pendingDeltasOf(snapshot)
  const key = pendingKey(messageID, partID)
  return remember(snapshot, eventID, {
    needsRefetch: true,
    pendingDeltas: { ...pending, [key]: [...(pending[key] ?? []), { field, delta }] },
  })
}

function dropPendingDeltas(snapshot: ConversationSnapshot, messageID: string, partID: string) {
  const pending = pendingDeltasOf(snapshot)
  const key = pendingKey(messageID, partID)
  if (!(key in pending)) return snapshot
  const next = { ...pending }
  delete next[key]
  return { ...snapshot, pendingDeltas: next }
}

/**
 * Applies buffered deltas to a part once its authoritative base exists.
 * The incoming part update is treated as authoritative: when it already
 * carries content (e.g. a completed part), the buffer is dropped instead of
 * duplicated. Only an empty base (the part just being created) replays the
 * buffered deltas, preserving the original token order.
 */
function replayPendingDeltasForPart(
  snapshot: ConversationSnapshot,
  messageID: string,
  partID: string,
): ConversationSnapshot {
  const pending = pendingDeltasOf(snapshot)
  const key = pendingKey(messageID, partID)
  const deltas = pending[key]
  if (!deltas || deltas.length === 0) return snapshot

  const messageLocation = locateMessage(snapshot.messages, messageID)
  if (!messageLocation.found) return snapshot
  const message = snapshot.messages[messageLocation.index]!
  const partLocation = locate(message.parts, partID, (part) => part.id)
  if (!partLocation.found) return snapshot

  const original = message.parts[partLocation.index]!
  const base = original as unknown as Record<string, unknown>
  // A non-empty authoritative base already includes the buffered deltas
  // (e.g. a completed part); replaying would duplicate them. Only an empty
  // base — the part just being created — replays the buffer.
  if (Object.values(deltas).some(({ field }) => typeof base[field] !== "string" || String(base[field]).length > 0)) {
    const nextPending = { ...pending }
    delete nextPending[key]
    return { ...snapshot, pendingDeltas: nextPending }
  }

  let current = original
  for (const { field, delta } of deltas) {
    const record = current as unknown as Record<string, unknown>
    const value = record[field]
    if (typeof value !== "string" || typeof delta !== "string") continue
    current = { ...current, [field]: value + delta } as Part
  }

  const parts = [...message.parts]
  parts[partLocation.index] = current
  const messages = [...snapshot.messages]
  messages[messageLocation.index] = { ...message, parts }

  const nextPending = { ...pending }
  delete nextPending[key]
  return { ...snapshot, messages, pendingDeltas: nextPending }
}

/**
 * Replays every buffered delta whose part is now present. Used after a
 * refetch merges persisted parts into the snapshot.
 */
export function replayPendingDeltas(snapshot: ConversationSnapshot): ConversationSnapshot {
  let current = snapshot
  for (const key of Object.keys(pendingDeltasOf(snapshot))) {
    const separator = key.indexOf(":")
    if (separator <= 0) continue
    const messageID = key.slice(0, separator)
    const partID = key.slice(separator + 1)
    current = replayPendingDeltasForPart(current, messageID, partID)
  }
  return current
}

function applyConversationEventWithIndex(
  snapshot: ConversationSnapshot,
  event: GlobalEvent,
  messageIndex?: MessageIndex,
): ConversationSnapshot {
  const payload = normalizeConversationPayload(event.payload)
  const sessionID = eventSessionID(payload)
  if (!sessionID || sessionID !== snapshot.sessionID) return snapshot
  const eventID = payload.id
  if (snapshot.processedEventIDs.includes(eventID)) return snapshot

  switch (payload.type) {
    case "message.updated": {
      const messages = [...snapshot.messages]
      const location = locateMessage(messages, payload.properties.info.id, messageIndex)
      if (location.found) {
        const current = messages[location.index]!
        messages[location.index] = { ...current, info: payload.properties.info }
      } else {
        const entry = { info: payload.properties.info, parts: [] }
        messages.splice(
          lowerBound(messages, entry, (left, right) => compareMessages(left.info, right.info)),
          0,
          entry,
        )
      }
      return remember(snapshot, eventID, { messages })
    }
    case "message.removed": {
      const location = locateMessage(snapshot.messages, payload.properties.messageID, messageIndex)
      if (!location.found) return missingTarget(snapshot, eventID)
      const messages = [...snapshot.messages]
      messages.splice(location.index, 1)
      return remember(snapshot, eventID, { messages })
    }
    case "message.part.updated": {
      const part = payload.properties.part
      const messageLocation = locateMessage(snapshot.messages, part.messageID, messageIndex)
      if (!messageLocation.found) return missingTarget(snapshot, eventID)
      const message = snapshot.messages[messageLocation.index]!
      const parts = [...message.parts]
      const partLocation = locate(parts, part.id, (value) => value.id)
      if (partLocation.found) parts[partLocation.index] = part
      else parts.splice(partLocation.index, 0, part)
      const messages = [...snapshot.messages]
      messages[messageLocation.index] = { ...message, parts }
      return replayPendingDeltasForPart(remember(snapshot, eventID, { messages }), part.messageID, part.id)
    }
    case "message.part.delta": {
      const { messageID, partID, field, delta } = payload.properties
      const messageLocation = locateMessage(snapshot.messages, messageID, messageIndex)
      if (!messageLocation.found) return bufferPartDelta(snapshot, eventID, messageID, partID, field, delta)
      const message = snapshot.messages[messageLocation.index]!
      const partLocation = locate(message.parts, partID, (part) => part.id)
      if (!partLocation.found) return bufferPartDelta(snapshot, eventID, messageID, partID, field, delta)
      const record = message.parts[partLocation.index] as unknown as Record<string, unknown>
      const value = record[field]
      if (typeof value !== "string" || typeof delta !== "string") return missingTarget(snapshot, eventID)
      const nextPart = { ...message.parts[partLocation.index], [field]: value + delta } as Part
      const parts = [...message.parts]
      parts[partLocation.index] = nextPart
      const messages = [...snapshot.messages]
      messages[messageLocation.index] = { ...message, parts }
      return remember(snapshot, eventID, { messages })
    }
    case "message.part.removed": {
      const { messageID, partID } = payload.properties
      const messageLocation = locateMessage(snapshot.messages, messageID, messageIndex)
      if (!messageLocation.found) return missingTarget(snapshot, eventID)
      const message = snapshot.messages[messageLocation.index]!
      const partLocation = locate(message.parts, partID, (part) => part.id)
      if (!partLocation.found) return missingTarget(snapshot, eventID)
      const parts = [...message.parts]
      parts.splice(partLocation.index, 1)
      const messages = [...snapshot.messages]
      messages[messageLocation.index] = { ...message, parts }
      return dropPendingDeltas(remember(snapshot, eventID, { messages }), messageID, partID)
    }
    default:
      return snapshot
  }
}

export function applyConversationEvent(snapshot: ConversationSnapshot, event: GlobalEvent): ConversationSnapshot {
  return applyConversationEventWithIndex(snapshot, event)
}

export function applyConversationEvents(snapshot: ConversationSnapshot, events: readonly GlobalEvent[]) {
  const ordered = [...events]
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const leftID = String(left.event.payload.id ?? "")
      const rightID = String(right.event.payload.id ?? "")
      if (leftID !== rightID) return leftID < rightID ? -1 : 1
      return left.index - right.index
    })

  let current = snapshot
  let messageIndex = createMessageIndex(snapshot.messages)
  for (const item of ordered) {
    const previousMessages = current.messages
    current = applyConversationEventWithIndex(current, item.event, messageIndex)
    if (current.messages === previousMessages) continue

    // Part deltas replace message/part arrays but never change message
    // positions. Message insertion/removal can shift every later position, so
    // rebuild the index only for those less frequent structural events.
    if (!item.event.payload.type.startsWith("message.part.")) {
      messageIndex = createMessageIndex(current.messages)
    }
  }
  return current
}
