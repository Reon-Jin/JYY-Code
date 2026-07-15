import type { GlobalEvent, Part, SessionMessagesResponse } from "@jyycode-ai/sdk/v2/client"

export type ConversationMessage = SessionMessagesResponse[number]

export type ConversationSnapshot = {
  sessionID: string
  messages: SessionMessagesResponse
  processedEventIDs: readonly string[]
  needsRefetch: boolean
}

const PROCESSED_EVENT_LIMIT = 512

export function emptyConversationSnapshot(sessionID: string): ConversationSnapshot {
  return { sessionID, messages: [], processedEventIDs: [], needsRefetch: false }
}

export function snapshotFromMessages(sessionID: string, messages: SessionMessagesResponse): ConversationSnapshot {
  return {
    sessionID,
    messages: [...messages]
      .map((message) => ({ info: message.info, parts: sortByID(message.parts) }))
      .sort((left, right) => left.info.id.localeCompare(right.info.id)),
    processedEventIDs: [],
    needsRefetch: false,
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

function sortByID<T extends { id: string }>(values: readonly T[]) {
  return [...values].sort((left, right) => left.id.localeCompare(right.id))
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

function eventSessionID(event: GlobalEvent) {
  switch (event.payload.type) {
    case "message.updated":
    case "message.removed":
    case "message.part.updated":
    case "message.part.delta":
    case "message.part.removed":
      return event.payload.properties.sessionID
    default:
      return undefined
  }
}

function remember(
  snapshot: ConversationSnapshot,
  eventID: string,
  change?: Partial<Pick<ConversationSnapshot, "messages" | "needsRefetch">>,
) {
  const processedEventIDs = [...snapshot.processedEventIDs, eventID].slice(-PROCESSED_EVENT_LIMIT)
  return { ...snapshot, ...change, processedEventIDs }
}

function missingTarget(snapshot: ConversationSnapshot, eventID: string) {
  return remember(snapshot, eventID, { needsRefetch: true })
}

function updatePart(
  snapshot: ConversationSnapshot,
  eventID: string,
  messageID: string,
  partID: string,
  update: (part: Part) => Part | undefined,
) {
  const messageLocation = locate(snapshot.messages, messageID, (message) => message.info.id)
  if (!messageLocation.found) return missingTarget(snapshot, eventID)
  const message = snapshot.messages[messageLocation.index]!
  const partLocation = locate(message.parts, partID, (part) => part.id)
  if (!partLocation.found) return missingTarget(snapshot, eventID)
  const nextPart = update(message.parts[partLocation.index]!)
  if (!nextPart) return missingTarget(snapshot, eventID)

  const parts = [...message.parts]
  parts[partLocation.index] = nextPart
  const messages = [...snapshot.messages]
  messages[messageLocation.index] = { ...message, parts }
  return remember(snapshot, eventID, { messages })
}

export function applyConversationEvent(snapshot: ConversationSnapshot, event: GlobalEvent): ConversationSnapshot {
  const sessionID = eventSessionID(event)
  if (!sessionID || sessionID !== snapshot.sessionID) return snapshot
  const eventID = event.payload.id
  if (snapshot.processedEventIDs.includes(eventID)) return snapshot

  switch (event.payload.type) {
    case "message.updated": {
      const messages = [...snapshot.messages]
      const location = locate(messages, event.payload.properties.info.id, (message) => message.info.id)
      if (location.found) {
        const current = messages[location.index]!
        messages[location.index] = { ...current, info: event.payload.properties.info }
      } else {
        messages.splice(location.index, 0, { info: event.payload.properties.info, parts: [] })
      }
      return remember(snapshot, eventID, { messages })
    }
    case "message.removed": {
      const location = locate(snapshot.messages, event.payload.properties.messageID, (message) => message.info.id)
      if (!location.found) return missingTarget(snapshot, eventID)
      const messages = [...snapshot.messages]
      messages.splice(location.index, 1)
      return remember(snapshot, eventID, { messages })
    }
    case "message.part.updated": {
      const part = event.payload.properties.part
      const messageLocation = locate(snapshot.messages, part.messageID, (message) => message.info.id)
      if (!messageLocation.found) return missingTarget(snapshot, eventID)
      const message = snapshot.messages[messageLocation.index]!
      const parts = [...message.parts]
      const partLocation = locate(parts, part.id, (value) => value.id)
      if (partLocation.found) parts[partLocation.index] = part
      else parts.splice(partLocation.index, 0, part)
      const messages = [...snapshot.messages]
      messages[messageLocation.index] = { ...message, parts }
      return remember(snapshot, eventID, { messages })
    }
    case "message.part.delta": {
      const { messageID, partID, field, delta } = event.payload.properties
      return updatePart(snapshot, eventID, messageID, partID, (part) => {
        const record = part as unknown as Record<string, unknown>
        const value = record[field]
        if (typeof value !== "string" || typeof delta !== "string") return undefined
        return { ...part, [field]: value + delta } as Part
      })
    }
    case "message.part.removed": {
      const { messageID, partID } = event.payload.properties
      const messageLocation = locate(snapshot.messages, messageID, (message) => message.info.id)
      if (!messageLocation.found) return missingTarget(snapshot, eventID)
      const message = snapshot.messages[messageLocation.index]!
      const partLocation = locate(message.parts, partID, (part) => part.id)
      if (!partLocation.found) return missingTarget(snapshot, eventID)
      const parts = [...message.parts]
      parts.splice(partLocation.index, 1)
      const messages = [...snapshot.messages]
      messages[messageLocation.index] = { ...message, parts }
      return remember(snapshot, eventID, { messages })
    }
    default:
      return snapshot
  }
}

const eventPriority: Partial<Record<GlobalEvent["payload"]["type"], number>> = {
  "message.updated": 0,
  "message.part.updated": 1,
  "message.part.delta": 2,
  "message.part.removed": 3,
  "message.removed": 4,
}

export function applyConversationEvents(snapshot: ConversationSnapshot, events: readonly GlobalEvent[]) {
  return [...events]
    .map((event, index) => ({ event, index }))
    .sort(
      (left, right) =>
        (eventPriority[left.event.payload.type] ?? 99) - (eventPriority[right.event.payload.type] ?? 99) ||
        left.index - right.index,
    )
    .reduce((current, item) => applyConversationEvent(current, item.event), snapshot)
}
