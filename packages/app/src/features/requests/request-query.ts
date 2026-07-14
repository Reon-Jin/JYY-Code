import type { PermissionRequest, QuestionRequest } from "@jyycode-ai/sdk/v2/client"
import type { DesktopClient } from "../../data/sdk"
import { keys } from "../../data/query-keys"

type RequestClient = Pick<DesktopClient, "permission" | "question">

export type RequestQueryInput = {
  client: RequestClient
  directory: string
  signal?: AbortSignal
}

export async function loadPermissionRequests(input: RequestQueryInput) {
  const result = await input.client.permission.list(
    { directory: input.directory },
    input.signal ? { throwOnError: true, signal: input.signal } : { throwOnError: true },
  )
  return result.data ?? []
}

export async function loadQuestionRequests(input: RequestQueryInput) {
  const result = await input.client.question.list(
    { directory: input.directory },
    input.signal ? { throwOnError: true, signal: input.signal } : { throwOnError: true },
  )
  return result.data ?? []
}

export function permissionQueryOptions(input: RequestQueryInput) {
  return {
    queryKey: keys.permissions(input.directory),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadPermissionRequests({ ...input, signal }),
  } as const
}

export function questionQueryOptions(input: RequestQueryInput) {
  return {
    queryKey: keys.questions(input.directory),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadQuestionRequests({ ...input, signal }),
  } as const
}

export function selectActiveRequest(
  permissions: readonly PermissionRequest[],
  questions: readonly QuestionRequest[],
  sessionScope: readonly string[],
) {
  for (const sessionID of sessionScope) {
    const permission = permissions.find((request) => request.sessionID === sessionID)
    if (permission) return { type: "permission" as const, request: permission, sourceSessionID: sessionID }
  }
  for (const sessionID of sessionScope) {
    const question = questions.find((request) => request.sessionID === sessionID)
    if (question) return { type: "question" as const, request: question, sourceSessionID: sessionID }
  }
  return undefined
}
