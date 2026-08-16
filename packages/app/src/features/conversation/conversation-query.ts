import type { DesktopClient } from "../../data/sdk"
import { keys } from "../../data/query-keys"
import type { QueryClient } from "@tanstack/solid-query"
import { isConversationSnapshot, isConversationSnapshotAhead, snapshotFromMessages } from "./conversation-state"

export type ConversationQueryInput = {
  client: Pick<DesktopClient, "session">
  directory: string
  sessionID: string
  queryClient?: QueryClient
  signal?: AbortSignal
}

export async function loadConversation(input: ConversationQueryInput) {
  // Fetch the full history (no limit) so context compaction never makes
  // earlier messages disappear from the UI. Compaction only affects the
  // model's context on the backend; every message stays in storage, and
  // the messages endpoint returns all of them when no limit is given.
  const result = await input.client.session.messages(
    { directory: input.directory, sessionID: input.sessionID },
    input.signal ? { throwOnError: true, signal: input.signal } : { throwOnError: true },
  )
  const snapshot = snapshotFromMessages(input.sessionID, result.data ?? [])
  const previous = input.queryClient?.getQueryData(keys.messages(input.directory, input.sessionID))
  if (!isConversationSnapshot(previous)) return snapshot
  const messages = isConversationSnapshotAhead(previous, snapshot) ? previous.messages : snapshot.messages
  return { ...snapshot, messages, processedEventIDs: previous.processedEventIDs }
}

export function conversationQueryOptions(input: ConversationQueryInput) {
  return {
    queryKey: keys.messages(input.directory, input.sessionID),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadConversation({ ...input, signal }),
  } as const
}
