import type {
  SessionBlackboardPostResponse,
  SessionBlackboardReadResponse,
  SessionBlackboardResponse,
} from "@jyycode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import type { DesktopClient } from "../../data/sdk"
import { keys } from "../../data/query-keys"

export type BlackboardQueryInput = {
  client: Pick<DesktopClient, "session">
  directory: string
  rootSessionID: string
  stepID?: string
  taskID?: string
  before?: string
  limit?: number
  signal?: AbortSignal
}

export type BlackboardSnapshot = SessionBlackboardResponse
export type BlackboardPost = SessionBlackboardPostResponse
export type BlackboardRead = SessionBlackboardReadResponse
export type BlackboardMessagePurpose = "general" | "candidate_declaration"

/** Older servers omit purpose; keep those messages on the ordinary rendering path. */
export function blackboardMessagePurpose(message: { purpose?: BlackboardMessagePurpose }): BlackboardMessagePurpose {
  return message.purpose ?? "general"
}

const requestOptions = (signal?: AbortSignal) =>
  signal ? ({ throwOnError: true, signal } as const) : ({ throwOnError: true } as const)

const emptyBlackboard = (rootSessionID: string): BlackboardSnapshot => ({
  rootSessionID,
  currentStepID: "",
  selectedStepID: "",
  readonly: true,
  tasks: [],
  messages: [],
  unreadCount: 0,
})

export async function loadBlackboard(input: BlackboardQueryInput) {
  const result = await input.client.session.blackboard(
    {
      directory: input.directory,
      sessionID: input.rootSessionID,
      ...(input.stepID ? { stepID: input.stepID } : {}),
      ...(input.taskID ? { taskID: input.taskID } : {}),
      ...(input.before ? { before: input.before } : {}),
      ...(input.limit === undefined ? {} : { limit: String(input.limit) }),
    },
    requestOptions(input.signal),
  )
  return result.data ?? emptyBlackboard(input.rootSessionID)
}

export function blackboardQueryOptions(input: BlackboardQueryInput) {
  return {
    queryKey: keys.blackboard(input.directory, input.rootSessionID),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadBlackboard({ ...input, signal }),
  } as const
}

export type BlackboardPostInput = {
  message: string
  kind?: "info" | "risk" | "blocker" | "decision" | "help"
  taskIDs?: string[]
  replyTo?: string
  attachments?: string[]
}

export type BlackboardReadInput = {
  stepID: string
  throughMessageID: string
}

export type BlackboardApiInput = BlackboardQueryInput & { queryClient: QueryClient }

export function createBlackboardApi(input: BlackboardApiInput) {
  const invalidate = () =>
    input.queryClient.invalidateQueries({
      queryKey: keys.blackboard(input.directory, input.rootSessionID),
      exact: true,
    })

  async function post(value: BlackboardPostInput, signal?: AbortSignal) {
    const result = await input.client.session.blackboard2.post(
      {
        directory: input.directory,
        sessionID: input.rootSessionID,
        message: value.message,
        ...(value.kind ? { kind: value.kind } : {}),
        ...(value.taskIDs ? { task_ids: value.taskIDs } : {}),
        ...(value.replyTo ? { reply_to: value.replyTo } : {}),
        ...(value.attachments ? { attachments: value.attachments } : {}),
      },
      requestOptions(signal),
    )
    await invalidate()
    if (!result.data) throw new Error("Blackboard post returned no data")
    return result.data
  }

  async function markRead(value: BlackboardReadInput, signal?: AbortSignal) {
    const result = await input.client.session.blackboard2.read(
      {
        directory: input.directory,
        sessionID: input.rootSessionID,
        stepID: value.stepID,
        throughMessageID: value.throughMessageID,
      },
      requestOptions(signal),
    )
    await invalidate()
    return result.data ?? false
  }

  return { post, markRead }
}
