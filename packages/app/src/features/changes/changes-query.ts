import type { DesktopClient } from "../../data/sdk"
import { keys } from "../../data/query-keys"

export type ChangesQueryInput = {
  client: Pick<DesktopClient, "vcs" | "session">
  directory: string
  workspaceID?: string
  relativePath?: string
  mode: "git" | "session"
  sessionID?: string
  signal?: AbortSignal
}

export async function loadChanges(input: ChangesQueryInput) {
  if (input.mode === "session") {
    if (!input.sessionID) throw new Error("sessionID is required for session diffs")
    const result = await input.client.session.diff(
      {
        directory: input.directory,
        sessionID: input.sessionID,
        ...(input.workspaceID ? { workspace: input.workspaceID } : {}),
      },
      input.signal ? { throwOnError: true, signal: input.signal } : { throwOnError: true },
    )
    return result.data ?? []
  }

  const result = await input.client.vcs.diff(
    {
      directory: input.directory,
      mode: "git",
      ...(input.workspaceID ? { workspace: input.workspaceID } : {}),
    },
    input.signal ? { throwOnError: true, signal: input.signal } : { throwOnError: true },
  )
  return result.data ?? []
}

export function changesQueryOptions(input: ChangesQueryInput) {
  return {
    queryKey:
      input.mode === "session"
        ? keys.sessionDiff(input.directory, input.workspaceID, input.sessionID, input.relativePath)
        : keys.vcsDiff(input.directory, input.workspaceID, input.sessionID, input.relativePath),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadChanges({ ...input, signal }),
  } as const
}
