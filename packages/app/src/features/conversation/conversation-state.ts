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
      .sort((left, right) => compareMessages(left.info, right.info)),
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
export function isConversationSnapshotAhead(
  candidate: ConversationSnapshot,
  baseline: ConversationSnapshot,
): boolean {
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
  messageIndex?: MessageIndex,
) {
  const messageLocation = locateMessage(snapshot.messages, messageID, messageIndex)
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

function applyConversationEventWithIndex(
  snapshot: ConversationSnapshot,
  event: GlobalEvent,
  messageIndex?: MessageIndex,
): ConversationSnapshot {
  const sessionID = eventSessionID(event)
  if (!sessionID || sessionID !== snapshot.sessionID) return snapshot
  const eventID = event.payload.id
  if (snapshot.processedEventIDs.includes(eventID)) return snapshot

  switch (event.payload.type) {
    case "message.updated": {
      const messages = [...snapshot.messages]
      const location = locateMessage(messages, event.payload.properties.info.id, messageIndex)
      if (location.found) {
        const current = messages[location.index]!
        messages[location.index] = { ...current, info: event.payload.properties.info }
      } else {
        const entry = { info: event.payload.properties.info, parts: [] }
        messages.splice(
          lowerBound(messages, entry, (left, right) => compareMessages(left.info, right.info)),
          0,
          entry,
        )
      }
      return remember(snapshot, eventID, { messages })
    }
    case "message.removed": {
      const location = locateMessage(snapshot.messages, event.payload.properties.messageID, messageIndex)
      if (!location.found) return missingTarget(snapshot, eventID)
      const messages = [...snapshot.messages]
      messages.splice(location.index, 1)
      return remember(snapshot, eventID, { messages })
    }
    case "message.part.updated": {
      const part = event.payload.properties.part
      const messageLocation = locateMessage(snapshot.messages, part.messageID, messageIndex)
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
      return updatePart(
        snapshot,
        eventID,
        messageID,
        partID,
        (part) => {
          const record = part as unknown as Record<string, unknown>
          const value = record[field]
          if (typeof value !== "string" || typeof delta !== "string") return undefined
          return { ...part, [field]: value + delta } as Part
        },
        messageIndex,
      )
    }
    case "message.part.removed": {
      const { messageID, partID } = event.payload.properties
      const messageLocation = locateMessage(snapshot.messages, messageID, messageIndex)
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
