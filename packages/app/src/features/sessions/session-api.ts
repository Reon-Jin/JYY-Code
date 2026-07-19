import type { Session, SessionStatus } from "@jyycode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import type { DesktopClient } from "../../data/sdk"
import { keys } from "../../data/query-keys"
import { tr } from "../../i18n/i18n-context"

export type CreateSessionInput = {
  title?: string
  agent?: string
  model?: NonNullable<Session["model"]>
  multiAgent?: boolean
}

export type SessionApiInput = {
  client: Pick<DesktopClient, "session">
  directory: string
  queryClient?: QueryClient
  now?: () => number
}

export type SessionQueryInput = Pick<SessionApiInput, "client" | "directory"> & {
  sessionID: string
  signal?: AbortSignal
}

export async function loadSession(input: SessionQueryInput) {
  const result = await input.client.session.get(
    { directory: input.directory, sessionID: input.sessionID },
    input.signal ? { throwOnError: true, signal: input.signal } : { throwOnError: true },
  )
  if (!result.data) throw new Error(tr("sessions.unable-to-load-session"))
  return result.data
}

export function sessionQueryOptions(input: SessionQueryInput) {
  return {
    queryKey: keys.session(input.directory, input.sessionID),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadSession({ ...input, signal }),
  } as const
}

function sessionsFrom(result: { data?: Session[] }, archived: boolean) {
  return [...(result.data ?? [])]
    .filter(
      (session) =>
        session.parentID === undefined &&
        (archived ? session.time.archived !== undefined : session.time.archived === undefined),
    )
    .sort((left, right) => right.time.updated - left.time.updated || right.id.localeCompare(left.id))
}

export function createSessionApi(input: SessionApiInput) {
  const now = input.now ?? Date.now

  async function invalidateLists() {
    if (!input.queryClient) return
    await Promise.all([
      input.queryClient.invalidateQueries({ queryKey: keys.sessions(input.directory), exact: true }),
      input.queryClient.invalidateQueries({ queryKey: keys.sessions(input.directory, true), exact: true }),
    ])
  }

  async function list(archived: boolean) {
    const result = await input.client.session.list(
      {
        directory: input.directory,
        roots: true,
        ...(archived ? { archived: true as const } : {}),
      },
      { throwOnError: true },
    )
    return sessionsFrom(result, archived)
  }

  async function listAll() {
    const result = await input.client.session.list(
      { directory: input.directory, roots: false },
      { throwOnError: true },
    )
    return result.data ?? []
  }

  async function status() {
    const result = await input.client.session.status(
      { directory: input.directory },
      { throwOnError: true },
    )
    return (result.data ?? {}) as Record<string, SessionStatus>
  }

  async function load(sessionID: string) {
    return loadSession({ client: input.client, directory: input.directory, sessionID })
  }

  async function create(value: CreateSessionInput) {
    const result = await input.client.session.create(
      { directory: input.directory, ...value },
      { throwOnError: true },
    )
    await invalidateLists()
    if (!result.data) throw new Error(tr("sessions.create-failed"))
    return result.data
  }

  async function rename(sessionID: string, title: string) {
    const result = await input.client.session.update(
      { directory: input.directory, sessionID, title },
      { throwOnError: true },
    )
    await invalidateLists()
    return result.data
  }

  async function archive(sessionID: string) {
    const result = await input.client.session.update(
      { directory: input.directory, sessionID, time: { archived: now() } },
      { throwOnError: true },
    )
    await invalidateLists()
    return result.data
  }

  async function remove(sessionID: string) {
    const result = await input.client.session.delete(
      { directory: input.directory, sessionID },
      { throwOnError: true },
    )
    await invalidateLists()
    return result.data ?? false
  }

  return { list, listAll, load, status, create, rename, archive, remove }
}

export type SessionApi = ReturnType<typeof createSessionApi>
