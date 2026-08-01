import type { SessionPlanResponse } from "@jyycode-ai/sdk/v2/client"
import type { DesktopClient } from "../../data/sdk"
import { keys } from "../../data/query-keys"

export type PlanSnapshotState = SessionPlanResponse

export type PlanQueryInput = {
  client: Pick<DesktopClient, "session">
  directory: string
  sessionID: string
  signal?: AbortSignal
}

export async function loadPlan(input: PlanQueryInput) {
  const result = await input.client.session.plan(
    { directory: input.directory, sessionID: input.sessionID },
    input.signal ? { throwOnError: true, signal: input.signal } : { throwOnError: true },
  )
  return result.data ?? { plan: null }
}

export function planQueryOptions(input: PlanQueryInput) {
  return {
    queryKey: keys.plan(input.directory, input.sessionID),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadPlan({ ...input, signal }),
  } as const
}
