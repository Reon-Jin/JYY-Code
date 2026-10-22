import type { DesktopClient } from "../../data/sdk"
import { keys } from "../../data/query-keys"

export function sessionUsageQueryOptions(input: {
  client: Pick<DesktopClient, "session">
  directory: string
  sessionID: string
}) {
  return {
    queryKey: keys.sessionUsage(input.directory, input.sessionID),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const response = await input.client.session.usage(
        { directory: input.directory, sessionID: input.sessionID },
        { throwOnError: true, signal },
      )
      if (!response.data || !Array.isArray(response.data.sessionIDs)) throw new TypeError("Invalid agent usage summary")
      return response.data
    },
    staleTime: 0,
  }
}
