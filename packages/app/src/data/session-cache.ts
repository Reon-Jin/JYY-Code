import type { Session } from "@jyycode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"

export function patchSessionList(queryClient: QueryClient, queryKey: readonly unknown[], session: Session) {
  const sessions = queryClient.getQueryData<Session[]>(queryKey)
  if (!sessions) return
  queryClient.setQueryData(
    queryKey,
    sessions.map((candidate) => (candidate.id === session.id ? session : candidate)),
  )
}
