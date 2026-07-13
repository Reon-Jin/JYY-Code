import type { DesktopClient } from "../../data/sdk"
import { keys } from "../../data/query-keys"

export type ChangesQueryInput = {
  client: Pick<DesktopClient, "vcs">
  directory: string
  signal?: AbortSignal
}

export async function loadChanges(input: ChangesQueryInput) {
  const result = await input.client.vcs.diff(
    { directory: input.directory, mode: "git" },
    input.signal ? { throwOnError: true, signal: input.signal } : { throwOnError: true },
  )
  return result.data ?? []
}

export function changesQueryOptions(input: ChangesQueryInput) {
  return {
    queryKey: keys.vcsDiff(input.directory),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadChanges({ ...input, signal }),
  } as const
}
