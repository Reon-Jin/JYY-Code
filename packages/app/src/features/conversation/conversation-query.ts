import type { DesktopClient } from "../../data/sdk"
import { keys } from "../../data/query-keys"
import { tr } from "../../i18n/i18n-context"
import type { QueryClient } from "@tanstack/solid-query"
import {
  isConversationSnapshot,
  replayPendingDeltas,
  snapshotFromMessages,
} from "./conversation-state"
import { limitComputerScreenshots } from "./computer-screenshot-budget"

export type ConversationQueryInput = {
  client: Pick<DesktopClient, "session">
  directory: string
  sessionID: string
  queryClient?: QueryClient
  signal?: AbortSignal
}

export async function loadConversation(input: ConversationQueryInput) {
  const queryKey = keys.messages(input.directory, input.sessionID)
  const atStart = input.queryClient?.getQueryData(queryKey)
  // Fetch the full history (no limit) so context compaction never makes
  // earlier messages disappear from the UI. Compaction only affects the
  // model's context on the backend; every message stays in storage, and
  // the messages endpoint returns all of them when no limit is given.
  const result = await input.client.session.messages(
    { directory: input.directory, sessionID: input.sessionID },
    input.signal ? { throwOnError: true, signal: input.signal } : { throwOnError: true },
  )
  if (!Array.isArray(result.data)) throw new TypeError(tr("layout.unable-to-load-session-message"))
  const snapshot = snapshotFromMessages(input.sessionID, result.data)
  const previous = input.queryClient?.getQueryData(queryKey)
  if (!isConversationSnapshot(previous)) return snapshot
  // An existing tool part is not evidence that the whole cached snapshot is newer.
  // Merge per part so a refetch can retire attachments while preserving concurrent SSE progress.
  const before = new Map(isConversationSnapshot(atStart) ? atStart.messages.map((m) => [m.info.id, m]) : [])
  const fetched = new Map(snapshot.messages.map((m) => [m.info.id, m]))
  const messages = previous.messages.map((current) => {
    const server = fetched.get(current.info.id)
    fetched.delete(current.info.id)
    if (!server) return current
    const old = before.get(current.info.id)
    const oldParts = new Map(old?.parts.map((p) => [p.id, p]))
    const localParts = new Map(current.parts.map((p) => [p.id, p]))
    const parts = server.parts.map((part) => {
      const local = localParts.get(part.id)
      localParts.delete(part.id)
      if (!local) return part
      if (local !== oldParts.get(part.id)) return local
      if ((part.type === "text" || part.type === "reasoning") && local.type === part.type && local.text.length > part.text.length) return local
      if (part.type === "tool" && local.type === "tool" &&
        (local.state.status === "completed" || local.state.status === "error") &&
        (part.state.status === "pending" || part.state.status === "running")) return local
      return part
    })
    return { info: old?.info !== current.info ? current.info : server.info,
      parts: [...parts, ...localParts.values()].sort((a, b) => a.id.localeCompare(b.id)) }
  })
  messages.push(...fetched.values())
  messages.sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id))
  return replayPendingDeltas({
    ...snapshot,
    messages: limitComputerScreenshots(messages),
    processedEventIDs: previous.processedEventIDs,
    pendingDeltas: previous.pendingDeltas ?? snapshot.pendingDeltas,
  })
}

export function conversationQueryOptions(input: ConversationQueryInput) {
  return {
    queryKey: keys.messages(input.directory, input.sessionID),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadConversation({ ...input, signal }),
    gcTime: 60_000,
  } as const
}
