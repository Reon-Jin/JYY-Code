import type {
  WorkflowGetSessionPlanResponse,
  WorkflowCreateBlackboardData,
  WorkflowListArtifactsResponse,
  WorkflowListAssignmentsResponse,
  WorkflowListBlackboardResponse,
  WorkflowListReviewsResponse,
  WorkflowListEventsResponse,
  WorkflowListVersionsResponse,
  WorkflowPatchData,
  WorkflowRestoreData,
} from "@jyycode-ai/sdk/v2/client"
import type { DesktopClient } from "../../data/sdk"
import { keys } from "../../data/query-keys"

export type SessionRunPlan = WorkflowGetSessionPlanResponse
export type SessionArtifact = WorkflowListArtifactsResponse[number]
export type SessionBlackboardCard = WorkflowListBlackboardResponse[number]
export type SessionReviewFinding = WorkflowListReviewsResponse[number]
export type SessionAssignment = WorkflowListAssignmentsResponse[number]
export type SessionWorkflowEvent = WorkflowListEventsResponse[number]
export type SessionRunPlanVersion = WorkflowListVersionsResponse[number]
export type SessionRunPlanPatch = NonNullable<WorkflowPatchData["body"]>["patch"]
export type SessionBlackboardDraft = NonNullable<WorkflowCreateBlackboardData["body"]>

function isNotFound(error: unknown) {
  if (!error || typeof error !== "object") return false
  const value = error as { status?: unknown; response?: { status?: unknown } }
  return value.status === 404 || value.response?.status === 404
}

export async function loadSessionRunPlan(input: { client: Pick<DesktopClient, "workflow">; directory: string; sessionID: string }) {
  try {
    const result = await input.client.workflow.getSessionPlan(
      { directory: input.directory, sessionID: input.sessionID },
      { throwOnError: true },
    )
    return result.data
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

export function sessionRunPlanQueryOptions(input: { client: Pick<DesktopClient, "workflow">; directory: string; sessionID: string }) {
  return {
    queryKey: keys.workflowRunPlan(input.directory, input.sessionID),
    queryFn: () => loadSessionRunPlan(input),
  } as const
}

export async function patchSessionRunPlan(input: {
  client: Pick<DesktopClient, "workflow">
  directory: string
  runPlanID: string
  patch: SessionRunPlanPatch
}) {
  const result = await input.client.workflow.patch(
    {
      runPlanID: input.runPlanID,
      directory: input.directory,
      patch: input.patch,
      author: "user",
    },
    { throwOnError: true },
  )
  return result.data
}

export async function selectSessionWorkflow(input: {
  client: Pick<DesktopClient, "workflow">
  directory: string
  sessionID: string
  workflowID: "general" | "workflow-creation"
  workflowVersion: string
}) {
  await input.client.workflow.pin(
    {
      directory: input.directory,
      sessionID: input.sessionID,
      workflowID: input.workflowID,
      workflowVersion: input.workflowVersion,
    },
    { throwOnError: true },
  )
}

export function sessionRunPlanVersionsQueryOptions(input: { client: Pick<DesktopClient, "workflow">; directory: string; runPlanID: string; sessionID: string }) {
  return {
    queryKey: keys.workflowPlanVersions(input.directory, input.sessionID),
    queryFn: async () => (await input.client.workflow.listVersions({ directory: input.directory, runPlanID: input.runPlanID }, { throwOnError: true })).data,
  } as const
}

export async function restoreSessionRunPlanVersion(input: {
  client: Pick<DesktopClient, "workflow">
  directory: string
  runPlanID: string
  version: number
  baseVersion: number
}) {
  const body: NonNullable<WorkflowRestoreData["body"]> = { version: input.version, baseVersion: input.baseVersion, author: "user" }
  const result = await input.client.workflow.restore({ runPlanID: input.runPlanID, directory: input.directory, ...body }, { throwOnError: true })
  return result.data
}

export function sessionArtifactsQueryOptions(input: { client: Pick<DesktopClient, "workflow">; directory: string; sessionID: string }) {
  return {
    queryKey: keys.workflowArtifacts(input.directory, input.sessionID),
    queryFn: async () => {
      const result = await input.client.workflow.listArtifacts(
        { directory: input.directory, sessionID: input.sessionID },
        { throwOnError: true },
      )
      return result.data
    },
  } as const
}

export function sessionBlackboardQueryOptions(input: { client: Pick<DesktopClient, "workflow">; directory: string; sessionID: string }) {
  return { queryKey: keys.workflowBlackboard(input.directory, input.sessionID), queryFn: async () => (await input.client.workflow.listBlackboard({ directory: input.directory, sessionID: input.sessionID }, { throwOnError: true })).data } as const
}

export async function publishSessionBlackboard(input: {
  client: Pick<DesktopClient, "workflow">
  directory: string
  sessionID: string
  card: SessionBlackboardDraft
}) {
  const created = await input.client.workflow.createBlackboard(
    { directory: input.directory, sessionID: input.sessionID, ...input.card },
    { throwOnError: true },
  )
  const card = created.data
  if (card.status !== "draft") return card
  const published = await input.client.workflow.transitionBlackboard(
    { directory: input.directory, cardID: card.id, from: "draft", to: "published" },
    { throwOnError: true },
  )
  return published.data
}

export function sessionReviewsQueryOptions(input: { client: Pick<DesktopClient, "workflow">; directory: string; sessionID: string }) {
  return { queryKey: keys.workflowReviews(input.directory, input.sessionID), queryFn: async () => (await input.client.workflow.listReviews({ directory: input.directory, sessionID: input.sessionID }, { throwOnError: true })).data } as const
}

export function sessionAssignmentsQueryOptions(input: { client: Pick<DesktopClient, "workflow">; directory: string; sessionID: string }) {
  return { queryKey: keys.workflowAssignments(input.directory, input.sessionID), queryFn: async () => (await input.client.workflow.listAssignments({ directory: input.directory, sessionID: input.sessionID }, { throwOnError: true })).data } as const
}

export function sessionEventsQueryOptions(input: { client: Pick<DesktopClient, "workflow">; directory: string; sessionID: string }) {
  return { queryKey: keys.workflowEvents(input.directory, input.sessionID), queryFn: async () => (await input.client.workflow.listEvents({ directory: input.directory, sessionID: input.sessionID }, { throwOnError: true })).data } as const
}
