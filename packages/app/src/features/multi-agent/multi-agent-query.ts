import type { SessionAgentClusterResponse } from "@jyycode-ai/sdk/v2/client"
import type { DesktopClient } from "../../data/sdk"
import { keys } from "../../data/query-keys"

export type AgentClusterState = SessionAgentClusterResponse

export type AgentClusterQueryInput = {
  client: Pick<DesktopClient, "session">
  directory: string
  sessionID: string
  signal?: AbortSignal
}

export async function loadAgentCluster(input: AgentClusterQueryInput) {
  const result = await input.client.session.agentCluster(
    { directory: input.directory, sessionID: input.sessionID },
    input.signal ? { throwOnError: true, signal: input.signal } : { throwOnError: true },
  )
  return result.data ?? { tasks: [] }
}

export function agentClusterQueryOptions(input: AgentClusterQueryInput) {
  return {
    queryKey: keys.agentCluster(input.directory, input.sessionID),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadAgentCluster({ ...input, signal }),
  } as const
}
