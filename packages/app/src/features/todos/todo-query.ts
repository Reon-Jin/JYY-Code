import type { DesktopClient } from "../../data/sdk"
import { keys } from "../../data/query-keys"

export type TodoQueryInput = {
  client: Pick<DesktopClient, "session">
  directory: string
  sessionID: string
  signal?: AbortSignal
}

export async function loadTodos(input: TodoQueryInput) {
  const result = await input.client.session.todo(
    { directory: input.directory, sessionID: input.sessionID },
    input.signal ? { throwOnError: true, signal: input.signal } : { throwOnError: true },
  )
  return result.data ?? []
}

export function todoQueryOptions(input: TodoQueryInput) {
  return {
    queryKey: keys.todos(input.directory, input.sessionID),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadTodos({ ...input, signal }),
  } as const
}
