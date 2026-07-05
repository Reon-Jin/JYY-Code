export * as AgentClusterTelemetry from "./telemetry"

import type { RunID, TaskID } from "./schema"
import * as Log from "@jyycode-ai/core/util/log"

const log = Log.create({ service: "agent-cluster" })

export interface RunMetrics {
  runID: RunID
  planValidationFailures: number
  tasksTotal: number
  tasksAccepted: number
  tasksFailed: number
  tasksCancelled: number
  totalQueueTimeMs: number
  totalWallTimeMs: number
  peakConcurrency: number
  reviewerLatencyMs: number[]
  reviewerDecisions: Record<string, number>
  revisionCounts: number[]
  interventionsEnqueued: number
  interventionsDelivered: number
  timeToFirstArtifactMs?: number
  synthesisCompletionLatencyMs?: number
  totalCostUsd?: number
  totalTokens?: number
}

export function createRunMetrics(runID: RunID): RunMetrics {
  return {
    runID,
    planValidationFailures: 0,
    tasksTotal: 0,
    tasksAccepted: 0,
    tasksFailed: 0,
    tasksCancelled: 0,
    totalQueueTimeMs: 0,
    totalWallTimeMs: 0,
    peakConcurrency: 0,
    reviewerLatencyMs: [],
    reviewerDecisions: {},
    revisionCounts: [],
    interventionsEnqueued: 0,
    interventionsDelivered: 0,
  }
}

export function recordPlanValidationFailure(metrics: RunMetrics): RunMetrics {
  return { ...metrics, planValidationFailures: metrics.planValidationFailures + 1 }
}

export function recordTaskCompleted(
  metrics: RunMetrics,
  task: { status: string; queueTimeMs?: number; wallTimeMs?: number },
): RunMetrics {
  const next = { ...metrics }
  if (task.status === "accepted") next.tasksAccepted++
  if (task.status === "failed") next.tasksFailed++
  if (task.status === "cancelled") next.tasksCancelled++
  if (task.queueTimeMs) next.totalQueueTimeMs += task.queueTimeMs
  if (task.wallTimeMs) next.totalWallTimeMs += task.wallTimeMs
  return next
}

export function recordReviewDecision(
  metrics: RunMetrics,
  decision: string,
  latencyMs: number,
): RunMetrics {
  return {
    ...metrics,
    reviewerLatencyMs: [...metrics.reviewerLatencyMs, latencyMs],
    reviewerDecisions: {
      ...metrics.reviewerDecisions,
      [decision]: (metrics.reviewerDecisions[decision] ?? 0) + 1,
    },
  }
}

export function recordRevision(metrics: RunMetrics, round: number): RunMetrics {
  return {
    ...metrics,
    revisionCounts: [...metrics.revisionCounts, round],
  }
}

export function recordIntervention(metrics: RunMetrics, delivered: boolean): RunMetrics {
  return {
    ...metrics,
    interventionsEnqueued: metrics.interventionsEnqueued + 1,
    interventionsDelivered: metrics.interventionsDelivered + (delivered ? 1 : 0),
  }
}

export function summarizeRun(metrics: RunMetrics): void {
  const avgReviewLatency =
    metrics.reviewerLatencyMs.length > 0
      ? Math.round(metrics.reviewerLatencyMs.reduce((a, b) => a + b, 0) / metrics.reviewerLatencyMs.length)
      : 0

  log.info("Run metrics", {
    runID: metrics.runID,
    tasks: {
      total: metrics.tasksTotal,
      accepted: metrics.tasksAccepted,
      failed: metrics.tasksFailed,
      cancelled: metrics.tasksCancelled,
    },
    timing: {
      avgQueueMs: metrics.tasksTotal > 0 ? Math.round(metrics.totalQueueTimeMs / metrics.tasksTotal) : 0,
      avgWallMs: metrics.tasksTotal > 0 ? Math.round(metrics.totalWallTimeMs / metrics.tasksTotal) : 0,
      avgReviewLatencyMs: avgReviewLatency,
      timeToFirstArtifactMs: metrics.timeToFirstArtifactMs,
      synthesisLatencyMs: metrics.synthesisCompletionLatencyMs,
    },
    reviewer: {
      decisions: metrics.reviewerDecisions,
      avgLatencyMs: avgReviewLatency,
    },
    revisions: {
      counts: metrics.revisionCounts,
      total: metrics.revisionCounts.length,
    },
    interventions: {
      enqueued: metrics.interventionsEnqueued,
      delivered: metrics.interventionsDelivered,
    },
    cost: {
      totalUsd: metrics.totalCostUsd,
      totalTokens: metrics.totalTokens,
    },
    peakConcurrency: metrics.peakConcurrency,
    planValidationFailures: metrics.planValidationFailures,
  })
}
