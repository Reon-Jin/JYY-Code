import type { DesktopClient } from "../../data/sdk"
import { keys } from "../../data/query-keys"
import type { QueryClient } from "@tanstack/solid-query"
import { isConversationSnapshot, snapshotFromMessages } from "./conversation-state"

export type ConversationQueryInput = {
  client: Pick<DesktopClient, "session">
  directory: string
  sessionID: string
  queryClient?: QueryClient
  signal?: AbortSignal
}

export async function loadConversation(input: ConversationQueryInput) {
  const result = await input.client.session.messages(
    { directory: input.directory, sessionID: input.sessionID, limit: 100 },
    input.signal ? { throwOnError: true, signal: input.signal } : { throwOnError: true },
  )
  const snapshot = snapshotFromMessages(input.sessionID, result.data ?? [])
  const previous = input.queryClient?.getQueryData(keys.messages(input.directory, input.sessionID))
  return isConversationSnapshot(previous) ? { ...snapshot, processedEventIDs: previous.processedEventIDs } : snapshot
}

export function conversationQueryOptions(input: ConversationQueryInput) {
  return {
    queryKey: keys.messages(input.directory, input.sessionID),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadConversation({ ...input, signal }),
  } as const
}
